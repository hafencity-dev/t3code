import type {
  ProviderAccountActivityEntry,
  ProviderAccountDriver,
  ProviderAccountsActivityInput,
} from "@t3tools/contracts";
import { formatAgo } from "./accounts.logic";

/** Entries per "Load more" step; the log itself keeps 500. */
export const ACTIVITY_PAGE_SIZE = 100;
export const ACTIVITY_MAX_ENTRIES = 500;

export type ActivityFilter = "all" | ProviderAccountDriver;

export function activityInput(
  filter: ActivityFilter,
  pages: number,
): ProviderAccountsActivityInput {
  return {
    ...(filter === "all" ? {} : { driver: filter }),
    limit: Math.min(ACTIVITY_MAX_ENTRIES, Math.max(1, pages) * ACTIVITY_PAGE_SIZE),
  };
}

export type ActivityIcon =
  | "switch"
  | "auto"
  | "window"
  | "added"
  | "login"
  | "removed"
  | "renamed"
  | "excluded"
  | "included"
  | "terminal"
  | "settings"
  | "failed"
  | "rateLimit"
  | "recovery";

/** One sentence: plain text with account names set in medium weight. */
export type ActivityPart = { readonly text: string; readonly strong?: true };

export interface ActivityView {
  readonly parts: readonly ActivityPart[];
  /** Muted detail after the sentence (wraps under it on narrow widths). */
  readonly detail?: string;
  /** Longer explanation for the detail's tooltip. */
  readonly tooltip?: string;
  readonly icon: ActivityIcon;
  readonly tone: "default" | "error" | "warning";
  /** Auto-switch did it. */
  readonly auto: boolean;
}

const name = (label: string | undefined): ActivityPart => ({
  text: label ?? "an account",
  strong: true,
});
const text = (value: string): ActivityPart => ({ text: value });

function thresholds(entry: ProviderAccountActivityEntry) {
  const session = entry.settings?.thresholdPercent;
  const weekly = entry.settings?.weeklyThresholdPercent;
  return session === undefined || weekly === undefined
    ? undefined
    : `5-hour at ${session}%, weekly at ${weekly}%`;
}

/** The whole row as the user reads it. Unknown future kinds never reach here (decode). */
export function activityView(entry: ProviderAccountActivityEntry): ActivityView {
  const { labels } = entry;
  const detail = entry.reason;
  const base = {
    ...(detail ? { detail } : {}),
    ...(entry.message ? { tooltip: entry.message } : {}),
    tone: "default" as const,
    auto: false,
  };
  const switched = [
    text("Switched to "),
    name(labels.to),
    ...(labels.from ? [text(" from "), name(labels.from)] : []),
  ];
  switch (entry.kind) {
    case "switch.manual":
      return { ...base, parts: switched, icon: "switch" };
    case "switch.auto":
      return { ...base, parts: switched, icon: "auto", auto: true };
    case "switch.failed":
      return {
        ...base,
        parts: [text("Couldn't switch to "), name(labels.to)],
        icon: "failed",
        tone: "error",
        auto: entry.trigger !== undefined,
      };
    case "window.started":
      return {
        ...base,
        parts: [text("Started "), name(labels.account), text("'s 5-hour window")],
        icon: "window",
      };
    case "window.failed":
      return {
        ...base,
        parts: [text("Couldn't start "), name(labels.account), text("'s 5-hour window")],
        icon: "failed",
        tone: "error",
      };
    case "login.added":
      return { ...base, parts: [text("Added "), name(labels.account)], icon: "added" };
    case "login.reauthenticated":
      return { ...base, parts: [text("Signed in again to "), name(labels.account)], icon: "login" };
    case "login.failed":
      return {
        ...base,
        parts:
          entry.accountId === undefined
            ? [
                text("Rejected "),
                name(labels.account),
                text(": already saved as "),
                name(labels.to),
              ]
            : [text("Couldn't sign in again to "), name(labels.account)],
        icon: "failed",
        tone: "error",
      };
    case "account.removed":
      return { ...base, parts: [text("Removed "), name(labels.account)], icon: "removed" };
    case "account.renamed":
      return {
        ...base,
        parts: [text("Renamed "), name(labels.from), text(" to "), name(labels.to)],
        icon: "renamed",
      };
    case "account.excluded":
      return {
        ...base,
        parts: [text("Excluded "), name(labels.account), text(" from auto-switch")],
        icon: "excluded",
      };
    case "account.included":
      return {
        ...base,
        parts: [text("Included "), name(labels.account), text(" in auto-switch")],
        icon: "included",
      };
    case "terminal.login":
      return {
        ...base,
        parts: [
          text("Terminal sign-in as "),
          name(labels.to),
          ...(entry.created
            ? [text("; saved as a new account")]
            : labels.from && entry.fromAccountId !== entry.toAccountId
              ? [text("; switched to it")]
              : []),
        ],
        icon: "terminal",
      };
    case "terminal.logout":
      return {
        ...base,
        parts: [text("Terminal sign-out of "), name(labels.account)],
        icon: "terminal",
      };
    case "autoSwitch.settingsChanged": {
      const values = thresholds(entry);
      const enabled = entry.settings?.enabled === true;
      return {
        ...base,
        ...(enabled && values ? { detail: values } : {}),
        parts: [
          text(
            entry.settings?.enabledChanged
              ? `Auto-switch turned ${enabled ? "on" : "off"}`
              : "Auto-switch thresholds changed",
          ),
        ],
        icon: "settings",
      };
    }
    case "windowPrimer.settingsChanged":
      return {
        ...base,
        parts: [
          text(`Automatic 5-hour window starts turned ${entry.settings?.enabled ? "on" : "off"}`),
        ],
        icon: "settings",
      };
    case "usage.rateLimited":
      return {
        ...base,
        parts: [text("Usage checks for "), name(labels.account), text(" rate-limited")],
        icon: "rateLimit",
        tone: "warning",
      };
    case "recovery.abandonedJournal":
      return { ...base, parts: [text("Recovered from an unfinished switch")], icon: "recovery" };
  }
}

/** Plain text of a row, for its accessible name. */
export function activityText(view: ActivityView) {
  const sentence = view.parts.map((part) => part.text).join("");
  return [view.auto ? "Auto" : null, sentence, view.detail].filter(Boolean).join(". ");
}

const startOfDay = (at: number) => {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

/** `Today`, `Yesterday`, then `Mon, 22 Sep` in the viewer's locale (with the year if not this year). */
export function activityDayLabel(at: number, now: number) {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const date = new Date(at);
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
  });
}

export interface ActivityDay {
  readonly key: string;
  readonly label: string;
  readonly entries: readonly ProviderAccountActivityEntry[];
}

/** Newest-first entries, grouped by local day in their existing order. */
export function groupActivityByDay(
  entries: readonly ProviderAccountActivityEntry[],
  now: number,
): ActivityDay[] {
  const days: { key: string; label: string; entries: ProviderAccountActivityEntry[] }[] = [];
  for (const entry of entries) {
    const at = Date.parse(entry.at);
    const key = String(startOfDay(at));
    const last = days.at(-1);
    if (last?.key === key) last.entries.push(entry);
    else days.push({ key, label: activityDayLabel(at, now), entries: [entry] });
  }
  return days;
}

/** `14:32`: the row's time, in the viewer's clock format. */
export function activityClock(at: string) {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Tooltip on the time: full timestamp and how long ago. */
export function activityTimestamp(at: string, now: number) {
  const date = new Date(at);
  return `${date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" })} · ${formatAgo(now - date.getTime(), true)}`;
}

/** The end-of-list line once nothing older is left to load. */
export const ACTIVITY_END_TEXT = `That's everything from the last ${ACTIVITY_MAX_ENTRIES} events.`;
