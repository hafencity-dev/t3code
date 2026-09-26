import { defaultInstanceIdForDriver, ProviderDriverKind } from "@t3tools/contracts";
import type {
  EnvironmentId,
  ProviderAccount,
  ProviderAccountAutoSwitchEvent,
  ProviderAccountDriver,
  ProviderAccountGroup,
  ProviderAccountId,
  ProviderAccountLoginEvent,
  ProviderAccountWindowPrimer,
  ServerProvider,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { formatDuration, formatResetsIn } from "@t3tools/shared/usageLimits";
import {
  accountGatingWindows,
  inactiveUsageStaleness,
} from "@t3tools/shared/fork/accountUsageWindows";

export const ACCOUNT_DRIVERS = ["claudeAgent", "codex"] as const;
export const ACCOUNT_DRIVER_LABELS = { claudeAgent: "Claude Code", codex: "Codex" } as const;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** `1 running turn`, `2 running turns`. Never interpolate a raw `s`. */
export function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/** `Just now`, `3m ago`, `2h ago`, `3d ago`; `lower` starts with a lower-case letter. */
export function formatAgo(ms: number, lower = false) {
  const age = Math.max(0, ms);
  if (age < MINUTE) return lower ? "just now" : "Just now";
  if (age < HOUR) return `${Math.floor(age / MINUTE)}m ago`;
  if (age < DAY) return `${Math.floor(age / HOUR)}h ago`;
  return `${Math.floor(age / DAY)}d ago`;
}

/** Remaining wait rounded up to the minute, so a pending wait never reads `0m`. */
export function formatWait(ms: number) {
  return formatDuration(Math.max(1, Math.ceil(ms / MINUTE)) * MINUTE);
}

/** `Claude Max Subscription` → `Max`, `ChatGPT Pro 20x Subscription` → `Pro 20x`. */
export function shortPlanLabel(plan: string) {
  const short = plan
    .trim()
    .replace(/^(claude|chatgpt)\s+/iu, "")
    .replace(/\s+(subscription|plan)$/iu, "")
    .trim();
  return short || plan;
}

/**
 * Unknown usage must never look like unused quota or become the recommended account. A
 * window whose reset has passed no longer counts: its number describes a window that ended.
 * Claude's model-scoped weeklies never gate the account while its all-model weekly is known.
 */
export function remainingPercent(account: ProviderAccount, now: number): number | null {
  if (!account.usage || account.usage.unavailable) return null;
  const current = accountGatingWindows(account.usage.windows).filter(
    (window) => !windowResetPassed(window, now),
  );
  if (current.length === 0) return null;
  return 100 - Math.max(...current.map((window) => window.usedPercent));
}

export function accountTone(account: ProviderAccount, now: number) {
  const remaining = remainingPercent(account, now);
  if (account.status !== "ready" || (remaining !== null && remaining <= 10)) return "error";
  return remaining !== null && remaining <= 25 ? "warning" : "secondary";
}

/**
 * Why the "Best option" account is next, and when. The server picks it (`group.nextAccountId`)
 * with the auto-switch ranking, so the badge and auto-switch never disagree; `nextAccountDue`
 * says a switch to it is due now rather than once the active account runs low.
 */
export function nextAccountReason(
  account: ProviderAccount,
  group: Pick<ProviderAccountGroup, "accounts" | "nextAccountDue">,
  now: number,
) {
  const { tightest } = accountUsageCell(account.usage?.windows ?? [], "weekly");
  const at = tightest?.resetsAt ? Date.parse(tightest.resetsAt) : Number.NaN;
  const reset = Number.isFinite(at) && at > now ? ` (${formatDuration(at - now)})` : "";
  const active = group.accounts.find((candidate) => candidate.active)?.label;
  const when = group.nextAccountDue
    ? "Next up now"
    : `Next up when ${active ?? "the active account"} runs low`;
  return `${when}: its weekly limit resets soonest${reset} with enough left.`;
}

/** Stable display order: Default first, then the server's creation order. Never re-sorts. */
export function orderedAccounts(accounts: readonly ProviderAccount[]) {
  return [
    ...accounts.filter((account) => account.kind === "default"),
    ...accounts.filter((account) => account.kind !== "default"),
  ];
}

export type UsageCellKind = "session" | "weekly";

/**
 * The window a usage column shows plus every window it stands for (the hover lists `all`).
 * Weekly shows Claude's all-model weekly; model-scoped weeklies only join the hover unless no
 * all-model weekly is reported. Weekly falls back to monthly windows when none is weekly.
 */
export function accountUsageCell(
  windows: readonly ServerProviderUsageWindow[],
  kind: UsageCellKind,
) {
  const weekly = windows.filter((window) => window.kind === "weekly");
  const candidates =
    kind === "session"
      ? windows.filter((window) => window.kind === "session")
      : weekly.length > 0
        ? accountGatingWindows(weekly)
        : windows.filter((window) => window.kind === "monthly");
  const all =
    kind === "weekly" && weekly.length > 0
      ? [...candidates, ...weekly.filter((window) => !candidates.includes(window))]
      : candidates;
  const tightest = candidates.reduce<ServerProviderUsageWindow | undefined>(
    (previous, window) =>
      !previous || window.usedPercent > previous.usedPercent ? window : previous,
    undefined,
  );
  return { tightest, all };
}

export type UsageTone = "error" | "warning" | "default";

export function usageTone(remaining: number): UsageTone {
  return remaining <= 10 ? "error" : remaining <= 25 ? "warning" : "default";
}

/** Shown once a window's reset has passed and a check for its new numbers will run. */
export const USAGE_RESET_PENDING_LABEL = "Resets now · checking…";
/** Shown once a window's reset has passed but no check is going to run on its own. */
export const USAGE_RESET_UNCHECKED_LABEL = "Reset · not checked yet";

function windowResetPassed(window: ServerProviderUsageWindow, now: number) {
  const at = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  return Number.isFinite(at) && at <= now;
}

/**
 * `in 6d 3h`, a reset label once the reset has passed, or null without a reset time.
 * `checking` says whether a check will actually run; the label never promises one otherwise.
 */
export function usageResetLabel(window: ServerProviderUsageWindow, now: number, checking: boolean) {
  if (!window.resetsAt) return null;
  const at = Date.parse(window.resetsAt);
  if (!Number.isFinite(at)) return null;
  if (at > now) return `in ${formatDuration(at - now)}`;
  return checking ? USAGE_RESET_PENDING_LABEL : USAGE_RESET_UNCHECKED_LABEL;
}

/**
 * What one usage column shows. A window whose reset has passed no longer reports its
 * percent: the old number would read as current quota next to a reset that already happened.
 */
export function accountUsageCellView(
  windows: readonly ServerProviderUsageWindow[],
  kind: UsageCellKind,
  now: number,
  checking: boolean,
) {
  const { tightest, all } = accountUsageCell(windows, kind);
  const resetPending = tightest !== undefined && windowResetPassed(tightest, now);
  const remaining = tightest && !resetPending ? Math.round(100 - tightest.usedPercent) : null;
  return {
    all,
    remaining,
    reset: tightest ? usageResetLabel(tightest, now, checking) : null,
    resetPending,
    checking: resetPending && checking,
    tone: remaining === null ? "default" : usageTone(remaining),
  };
}

/** One line of the usage tooltip; a window whose reset passed never shows its old percent. */
export function usageWindowTooltipLine(
  window: ServerProviderUsageWindow,
  now: number,
  checking: boolean,
) {
  if (windowResetPassed(window, now))
    return `${window.label}: reset, ${checking ? "checking…" : "not checked yet"}`;
  const resets = formatResetsIn(window, now);
  return `${window.label}: ${Math.round(100 - window.usedPercent)}% left${resets ? `, ${resets}` : ""}`;
}

/**
 * Identifies one measurement with a window that reset after it was taken, or null. Only
 * such a reset makes the numbers stale; one refresh per key is enough.
 */
export function usageResetKey(account: ProviderAccount, now: number): string | null {
  if (account.status !== "ready" || account.duplicateOf) return null;
  const usage = account.usage;
  if (!usage || usage.unavailable?.reason === "unsupported") return null;
  const checkedAt = Date.parse(usage.checkedAt);
  const stale = usage.windows.some(
    (window) => windowResetPassed(window, now) && Date.parse(window.resetsAt!) > checkedAt,
  );
  return stale ? `${account.id}:${usage.checkedAt}` : null;
}

/**
 * Whether a check for a passed reset will actually run. The active account gets one live
 * provider refresh per measurement (`attempted` holds the keys already refreshed); an
 * inactive account is picked by the background refresh unless the server is gating it.
 */
export function usageResetCheckWillRun(
  account: ProviderAccount,
  now: number,
  attempted: ReadonlySet<string>,
) {
  const key = usageResetKey(account, now);
  if (key === null) return false;
  if (account.active) return !attempted.has(key);
  // Only a gating window's reset makes the automatic refresh pick an inactive account.
  return (
    inactiveUsageStaleness(account.usage, now).stale &&
    !(Date.parse(account.usageRefresh?.nextAllowedAt ?? "") > now)
  );
}

function defaultAccountProvider(
  driver: ProviderAccount["driver"],
  providers: readonly ServerProvider[],
) {
  const instanceId = defaultInstanceIdForDriver(ProviderDriverKind.make(driver));
  return providers.find((provider) => provider.instanceId === instanceId);
}

/** Only these live fields invalidate the server-owned account snapshot; never merge its usage. */
export function providerAccountsUsageKey(providers: readonly ServerProvider[]) {
  return JSON.stringify(
    ACCOUNT_DRIVERS.map((driver) => {
      const provider = defaultAccountProvider(driver, providers);
      return provider
        ? [provider.usageLimits?.checkedAt ?? null, provider.auth.email ?? null]
        : null;
    }),
  );
}

export function shouldShowAccountBadge(
  group: Pick<ProviderAccountGroup, "driver" | "accounts">,
  providers: readonly ServerProvider[],
  now: number,
) {
  if (!defaultAccountProvider(group.driver, providers)?.enabled) return false;
  const active = group.accounts.find((account) => account.active);
  return (
    group.accounts.length > 1 || (active !== undefined && accountTone(active, now) !== "secondary")
  );
}

/** Client cooldown after a manual per-account refresh; automatic refreshes never start one. */
export const USAGE_REFRESH_COOLDOWN_MS = 60_000;
export function isUsageRefreshCoolingDown(lastRefreshedAt: number | null | undefined, now: number) {
  return lastRefreshedAt != null && now - lastRefreshedAt < USAGE_REFRESH_COOLDOWN_MS;
}

/**
 * Picks at most one inactive account for the dialog's automatic refresh, so it never
 * bulk-probes. Uses the server's staleness rule: a ready account that was never measured
 * first, then one with a window that reset after it was measured, otherwise the stalest
 * measurement past the freshness limit (30 minutes). Accounts the server is backing off are
 * skipped.
 */
export function autoRefreshAccountId(
  accounts: readonly ProviderAccount[],
  now: number,
): ProviderAccountId | null {
  const candidates = accounts.filter(
    (account) =>
      !account.active &&
      account.status === "ready" &&
      // A duplicate's numbers are its keeper's; the row hides them, so never probe it.
      !account.duplicateOf &&
      account.usage?.unavailable?.reason !== "unsupported" &&
      !(Date.parse(account.usageRefresh?.nextAllowedAt ?? "") > now),
  );
  const stale = candidates.flatMap((account) => {
    const staleness = inactiveUsageStaleness(account.usage, now);
    return staleness.stale ? [{ account, reason: staleness.reason }] : [];
  });
  const first = (reason: "neverMeasured" | "windowReset") =>
    stale.find((entry) => entry.reason === reason)?.account;
  const pick =
    first("neverMeasured") ??
    first("windowReset") ??
    stale
      .map(({ account }) => account)
      .sort((a, b) => Date.parse(a.usage!.checkedAt) - Date.parse(b.usage!.checkedAt))[0];
  return pick?.id ?? null;
}

export interface AccountFreshness {
  /** Wide layout text. */
  readonly text: string;
  /** Narrow layout text, e.g. `Checked 3m ago`. */
  readonly narrowText: string;
  readonly tone: "muted" | "warning";
  readonly icon?: "alert";
  readonly refreshing: boolean;
  readonly tooltip?: string;
  readonly canRefresh: boolean;
  readonly refreshTooltip: string;
}

function checkedTime(checkedAt: string) {
  return new Date(checkedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * The `Checked` cell as one computed state, first match wins. `null` means the row is not
 * ready and its usage columns merge into a status message. The active account's usage is
 * live, so a leftover `usageRefresh` backoff never shows next to it.
 */
export function accountFreshness(
  account: ProviderAccount,
  now: number,
  options: { refreshing: boolean; cooldownUntil?: number | undefined },
): AccountFreshness | null {
  if (account.status !== "ready" || account.duplicateOf) return null;
  const usage = account.usage;
  const provider = ACCOUNT_DRIVER_LABELS[account.driver];
  const age = usage ? formatAgo(now - Date.parse(usage.checkedAt)) : null;
  const plain = (text: string, narrowText = text) => ({ text, narrowText });
  const aged = (ageText: string) => ({
    text: ageText,
    narrowText: `Checked ${ageText === "Just now" ? "just now" : ageText}`,
  });
  const cooldown =
    options.cooldownUntil !== undefined && options.cooldownUntil > now
      ? options.cooldownUntil
      : null;
  if (usage?.unavailable?.reason === "unsupported")
    return {
      ...plain("—"),
      tone: "muted",
      refreshing: false,
      tooltip: "This login doesn't report usage limits.",
      canRefresh: false,
      refreshTooltip: "Usage isn't reported for this login",
    };
  if (options.refreshing)
    return {
      ...plain("Checking…"),
      tone: "muted",
      refreshing: true,
      canRefresh: false,
      refreshTooltip: "Checking usage",
    };
  const cooldownTooltip = (until: number) => `You can refresh again in ${formatWait(until - now)}`;
  if (account.active)
    return {
      ...(age ? aged(age) : plain("Not checked")),
      tone: "muted",
      refreshing: false,
      tooltip: "Updated with every turn on the active account.",
      canRefresh: cooldown === null,
      refreshTooltip: cooldown === null ? "Refresh usage" : cooldownTooltip(cooldown),
    };
  const nextAllowedAt = Date.parse(account.usageRefresh?.nextAllowedAt ?? "");
  const gatedUntil = Number.isFinite(nextAllowedAt) && nextAllowedAt > now ? nextAllowedAt : null;
  const numbers =
    usage && usage.windows.length > 0 && age
      ? `Showing numbers from ${age === "Just now" ? "just now" : age}.`
      : "No numbers yet.";
  if (account.usageRefresh?.rateLimited && gatedUntil !== null)
    return {
      ...plain(`Retry in ${formatWait(gatedUntil - now)}`),
      tone: "warning",
      icon: "alert",
      refreshing: false,
      tooltip: `${provider} is rate-limiting usage checks. ${numbers}`,
      canRefresh: false,
      refreshTooltip: `Checks resume in ${formatWait(gatedUntil - now)}`,
    };
  if (usage?.unavailable?.reason === "probeFailed") {
    const tooltip = `The last check failed. ${numbers}`;
    if (gatedUntil !== null)
      return {
        ...plain(`Retry in ${formatWait(gatedUntil - now)}`),
        tone: "warning",
        icon: "alert",
        refreshing: false,
        tooltip,
        canRefresh: false,
        refreshTooltip: `Checks resume in ${formatWait(gatedUntil - now)}`,
      };
    return {
      ...plain("Check failed"),
      tone: "warning",
      icon: "alert",
      refreshing: false,
      tooltip,
      canRefresh: cooldown === null,
      refreshTooltip: cooldown === null ? "Try again" : cooldownTooltip(cooldown),
    };
  }
  // After a successful probe the server floor only disables the button; it is never a retry.
  // The server's time already includes its global probe budget.
  const blockedUntil = Math.max(gatedUntil ?? 0, cooldown ?? 0);
  const blockedTooltip = () =>
    gatedUntil !== null && gatedUntil >= (cooldown ?? 0)
      ? `Checks resume in ${formatWait(gatedUntil - now)}`
      : cooldownTooltip(blockedUntil);
  if (!usage)
    return {
      ...plain("Not checked"),
      tone: "muted",
      refreshing: false,
      tooltip: "Usage hasn't been checked yet.",
      canRefresh: blockedUntil === 0,
      refreshTooltip: blockedUntil === 0 ? "Check usage" : blockedTooltip(),
    };
  return {
    ...aged(age!),
    tone: "muted",
    refreshing: false,
    tooltip: `Checked ${checkedTime(usage.checkedAt)}`,
    canRefresh: blockedUntil === 0,
    refreshTooltip: blockedUntil === 0 ? "Refresh usage" : blockedTooltip(),
  };
}

/** The kept account a duplicate row points at, looked up in the same group. */
export function duplicateKeeper(
  account: ProviderAccount,
  group: Pick<ProviderAccountGroup, "accounts">,
) {
  if (!account.duplicateOf) return undefined;
  return group.accounts.find((candidate) => candidate.id === account.duplicateOf);
}

export function duplicateKeeperLabel(
  account: ProviderAccount,
  group: Pick<ProviderAccountGroup, "accounts">,
) {
  return duplicateKeeper(account, group)?.label ?? "another saved account";
}

export interface AccountStatusMessage {
  readonly icon: "copy" | "signedOut" | "alert" | "clock";
  readonly tone: "warning" | "error" | "muted";
  readonly text: string;
}

/** Merged status cell for rows that can't show usage; null for ready, unique rows. */
export function accountStatusMessage(
  account: ProviderAccount,
  keeperLabel: string,
): AccountStatusMessage | null {
  if (account.duplicateOf)
    return { icon: "copy", tone: "warning", text: `Same account as ${keeperLabel}.` };
  switch (account.status) {
    case "signedOut":
      return {
        icon: "signedOut",
        tone: "warning",
        text: account.message ?? "Signed out. Sign in to use this account.",
      };
    case "error":
      return {
        icon: "alert",
        tone: "error",
        text: account.message ?? "Login expired. Sign in again to use this account.",
      };
    case "pending":
      return { icon: "clock", tone: "muted", text: "Sign-in wasn't finished." };
    default:
      return null;
  }
}

/** Only an active Claude duplicate can be removed while active: the server hands off to the keeper. */
export function canRemoveActiveDuplicate(account: ProviderAccount) {
  return account.active && Boolean(account.duplicateOf) && account.driver === "claudeAgent";
}

export function removeBlockedReason(account: ProviderAccount, signingIn: boolean) {
  if (account.kind === "default") return "The original login can't be removed.";
  if (account.active && !canRemoveActiveDuplicate(account))
    return "Switch to another account first.";
  if (signingIn) return "Wait for the sign-in to finish.";
  return undefined;
}

export type SwitchState = "idle" | "self" | "other";

/** The row's switch state while `switchingId` is switching; null means none is. */
export function accountSwitchState(
  switchingId: ProviderAccountId | null,
  accountId: ProviderAccountId,
): SwitchState {
  return switchingId === null ? "idle" : switchingId === accountId ? "self" : "other";
}

/** A switch ending clears only its own id, never one another control started since. */
export function endSwitch(current: ProviderAccountId | null, accountId: ProviderAccountId) {
  return current === accountId ? null : current;
}

/** The auto-switch bar's "Switch now" follows the same rules as a row's Switch button. */
export function autoSwitchNowBlockedReason(
  group: Pick<ProviderAccountGroup, "warning">,
  switchingId: ProviderAccountId | null,
  targetId: ProviderAccountId,
) {
  return switchBlockedReason(group, accountSwitchState(switchingId, targetId));
}

/** Closing a rename clears only that row's editor. */
export function endRename(current: ProviderAccountId | null, accountId: ProviderAccountId) {
  return current === accountId ? null : current;
}

/** Only Enter and Escape hand focus back to the row menu; a blur leaves focus where it went. */
export function renameRestoresFocus(how: "enter" | "escape" | "blur") {
  return how !== "blur";
}

export function switchBlockedReason(
  group: Pick<ProviderAccountGroup, "warning">,
  switchState: SwitchState,
) {
  if (group.warning) return "Switching is paused. See the warning above.";
  if (switchState === "other") return "Another switch is in progress.";
  return undefined;
}

export type AccountPrimaryAction =
  | { readonly kind: "switching" }
  | { readonly kind: "remove" }
  | { readonly kind: "switchToKeeper"; readonly keeper: ProviderAccount }
  | { readonly kind: "signIn" }
  | { readonly kind: "active" }
  | { readonly kind: "switch" };

/** The primary slot, first match wins. An active Codex duplicate must switch away first. */
export function accountPrimaryAction(
  account: ProviderAccount,
  group: Pick<ProviderAccountGroup, "accounts">,
  switchState: SwitchState,
): AccountPrimaryAction {
  if (switchState === "self") return { kind: "switching" };
  if (account.duplicateOf) {
    const keeper = duplicateKeeper(account, group);
    // A keeper that isn't signed in can't take over; Remove then shows why it is blocked.
    if (account.active && !canRemoveActiveDuplicate(account) && keeper?.status === "ready")
      return { kind: "switchToKeeper", keeper };
    return { kind: "remove" };
  }
  if (account.status !== "ready") return { kind: "signIn" };
  if (account.active) return { kind: "active" };
  return { kind: "switch" };
}

/** Line 2 of the identity cell. An email already shown as the name is not repeated. */
export function accountSubtitle(account: ProviderAccount) {
  const sameAsLabel = account.email?.toLowerCase() === account.label.trim().toLowerCase();
  if (account.email && !sameAsLabel) return account.email;
  if (account.kind === "default") return "Original login";
  if (account.kind === "external") return "Set in Settings";
  return account.email ? "Saved login" : "No email reported";
}

/** Signed-in accounts auto-switch can move between; duplicates count once. */
export function readyAccountCount(accounts: readonly ProviderAccount[]) {
  return accounts.filter((account) => account.status === "ready" && !account.duplicateOf).length;
}

export function accountSwitchInput(
  accountId: ProviderAccountId,
  switchMode: ProviderAccountGroup["switchMode"],
  interruptRunning: boolean,
) {
  return switchMode === "hot" ? { accountId } : { accountId, interruptRunning };
}

export function accountSwitchSuccess(
  switchMode: ProviderAccountGroup["switchMode"],
  label: string,
) {
  return switchMode === "hot"
    ? {
        title: `Switched Claude Code to ${label}`,
        description:
          "Running sessions use it from their next request. On macOS this can take up to 30 seconds.",
      }
    : { title: `Switched Codex to ${label}`, description: "Codex restarted on the new account." };
}

export function accountSwitchBusyTurnCount(
  switchMode: ProviderAccountGroup["switchMode"],
  error: unknown,
): number | null {
  if (
    switchMode === "restart" &&
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "ProviderAccountBusyError" &&
    "runningTurnCount" in error &&
    typeof error.runningTurnCount === "number"
  )
    return error.runningTurnCount;
  return null;
}

export function stopTurnsCopy(label: string, runningTurnCount: number) {
  const one = runningTurnCount === 1;
  return {
    title: `Stop ${plural(runningTurnCount, "running turn")}?`,
    description: one
      ? `Switching Codex to ${label} restarts it. The running turn stops now. Its thread keeps its history and can continue on ${label}.`
      : `Switching Codex to ${label} restarts it. The ${plural(runningTurnCount, "running turn")} stop now. Their threads keep their history and can continue on ${label}.`,
  };
}

export function autoSwitchToastTitle(
  driver: ProviderAccountDriver,
  toLabel: string,
  deviceLabel?: string,
) {
  return `Auto-switched ${ACCOUNT_DRIVER_LABELS[driver]} to ${toLabel}${deviceLabel ? ` on ${deviceLabel}` : ""}`;
}

export function pendingAutoSwitchAccount(
  group: Pick<ProviderAccountGroup, "switchMode" | "autoSwitch" | "accounts">,
) {
  return group.switchMode === "restart" && group.autoSwitch.state === "pending"
    ? group.accounts.find((account) => account.id === group.autoSwitch.pendingTargetAccountId)
    : undefined;
}

const AUTO_SWITCH_OFF_TEXT = {
  hot: "Switches before the active account runs out. Running sessions keep going.",
  restart: "Switches before the active account runs out. Waits for running turns to finish.",
} as const;

export type AutoSwitchBadge = {
  readonly label: string;
  readonly variant: "success" | "warning" | "secondary" | "outline";
};

const AUTO_SWITCH_BADGES: Partial<
  Record<ProviderAccountGroup["autoSwitch"]["state"], AutoSwitchBadge>
> = {
  watching: { label: "On", variant: "success" },
  pending: { label: "Waiting for turns", variant: "warning" },
  waiting: { label: "Waiting", variant: "secondary" },
  paused: { label: "Paused", variant: "secondary" },
};

const AUTO_SWITCH_ENDGAME_BADGE: AutoSwitchBadge = { label: "Endgame", variant: "outline" };

/** Shown next to the state badge while every account runs down to 1% of its weekly limit. */
export function autoSwitchEndgameBadge(
  autoSwitch: Pick<ProviderAccountGroup["autoSwitch"], "enabled" | "endgame">,
) {
  return autoSwitch.enabled && autoSwitch.endgame ? AUTO_SWITCH_ENDGAME_BADGE : undefined;
}

/** Line 2 of the auto-switch bar plus its state badge, first match wins. */
export function autoSwitchStatus(
  group: Pick<ProviderAccountGroup, "switchMode" | "autoSwitch" | "accounts">,
  event?: ProviderAccountAutoSwitchEvent,
) {
  const { autoSwitch } = group;
  const badge = autoSwitch.enabled ? AUTO_SWITCH_BADGES[autoSwitch.state] : undefined;
  if (!autoSwitch.enabled) return { text: AUTO_SWITCH_OFF_TEXT[group.switchMode] };
  const target = pendingAutoSwitchAccount(group);
  if (target) {
    const running =
      event?._tag === "pending" && event.toAccountId === target.id ? event.runningTurnCount : null;
    return {
      badge,
      target,
      text:
        running === null || running === 0
          ? `Switches to ${target.label} when running turns finish.`
          : `Switches to ${target.label} when ${plural(running, "running turn")} ${running === 1 ? "finishes" : "finish"}.`,
    };
  }
  const message = autoSwitch.state === "pending" ? undefined : autoSwitch.message;
  const excluded = group.accounts.filter((account) => account.autoSwitchExcluded).length;
  // `Watching hauke · 1 excluded`: excluded accounts are never a target.
  const withExcluded = (text: string) =>
    excluded === 0 ? text : `${text.replace(/\.$/u, "")} · ${excluded} excluded`;
  if (message) return { badge, text: withExcluded(message), showLastSwitch: true };
  const active = group.accounts.find((account) => account.active);
  return {
    badge,
    text: withExcluded(
      autoSwitch.state === "watching" || autoSwitch.state === "pending"
        ? `Watching ${active?.label ?? "the active account"}.`
        : AUTO_SWITCH_OFF_TEXT[group.switchMode],
    ),
    showLastSwitch: true,
  };
}

/** Badge tooltip on an excluded row. */
export const AUTO_SWITCH_EXCLUDED_HELP =
  "Auto-switch won't switch to this account. You can still switch manually.";

/** Tooltip on the ⋯ menu's exclude/include item. */
export function autoSwitchExclusionHelp(excluded: boolean) {
  return excluded
    ? "Auto-switch can switch to this account again."
    : "Auto-switch won't switch to this account, but still switches away from it when it runs low. Switching manually and automatic 5-hour window starts keep working.";
}

/** A start this recent is reported before the next one. */
const RECENT_WINDOW_START_MS = 10 * MINUTE;

/** The muted status line under the "Start 5-hour windows automatically" toggle. */
export function windowPrimerStatus(
  primer: ProviderAccountWindowPrimer,
  accounts: readonly Pick<ProviderAccount, "id" | "label">[],
  now: number,
) {
  if (!primer.enabled) return "Starts each account's 5-hour window as soon as it can.";
  if (primer.message) return primer.message;
  const labelOf = (id: ProviderAccountId | undefined) =>
    accounts.find((account) => account.id === id)?.label ?? "an account";
  const last =
    primer.lastPrimedAt === undefined
      ? undefined
      : `Started ${labelOf(primer.lastPrimedAccountId)}'s window ${formatAgo(now - Date.parse(primer.lastPrimedAt), true)}.`;
  const lastAge =
    primer.lastPrimedAt === undefined ? Infinity : now - Date.parse(primer.lastPrimedAt);
  if (last && lastAge < RECENT_WINDOW_START_MS) return last;
  if (primer.nextPrimeAt !== undefined) {
    const label = labelOf(primer.nextPrimeAccountId);
    const wait = Date.parse(primer.nextPrimeAt) - now;
    return wait <= 0
      ? `Starting ${label}'s window now.`
      : `Next start: ${label} in ${formatWait(wait)}.`;
  }
  return last ?? "No signed-in account can start a window right now.";
}

type AutoSwitchThresholds = Pick<
  ProviderAccountGroup["autoSwitch"],
  "thresholdPercent" | "weeklyThresholdPercent"
>;

/**
 * Sends only the thresholds that changed, so a toggle or one select never overwrites a
 * threshold changed elsewhere.
 */
export function autoSwitchInput(
  driver: ProviderAccountDriver,
  enabled: boolean,
  current: AutoSwitchThresholds,
  next: Partial<AutoSwitchThresholds> = {},
) {
  return {
    driver,
    enabled,
    ...(next.thresholdPercent === undefined || next.thresholdPercent === current.thresholdPercent
      ? {}
      : { thresholdPercent: next.thresholdPercent }),
    ...(next.weeklyThresholdPercent === undefined ||
    next.weeklyThresholdPercent === current.weeklyThresholdPercent
      ? {}
      : { weeklyThresholdPercent: next.weeklyThresholdPercent }),
  };
}

/**
 * Records a `switched` event and says whether it is new. `seen` lives at module level so a
 * remounted subscription (reconnect, route change) never toasts the same switch twice.
 */
export function shouldToastAutoSwitch(
  seen: Map<string, string>,
  environmentId: EnvironmentId,
  event: ProviderAccountAutoSwitchEvent,
) {
  if (event._tag !== "switched") return false;
  const scope = `${environmentId}:${event.driver}`;
  const key = `${event.at}:${event.toAccountId}`;
  if (seen.get(scope) === key) return false;
  seen.set(scope, key);
  return true;
}

/**
 * Which device the accounts UI shows. While the dialog is open the selection is pinned: a
 * device that drops stays selected and reads as offline instead of jumping to another one.
 * Closed, a missing selection falls back to the first connected device.
 */
export function resolveAccountsDevice(
  selected: EnvironmentId | null,
  connected: readonly EnvironmentId[],
  open: boolean,
): { readonly environmentId: EnvironmentId | null; readonly offlineId: EnvironmentId | null } {
  if (selected !== null && connected.includes(selected))
    return { environmentId: selected, offlineId: null };
  if (open && selected !== null) return { environmentId: null, offlineId: selected };
  return { environmentId: connected[0] ?? null, offlineId: null };
}

export type LoginPrompt = Extract<ProviderAccountLoginEvent, { _tag: "browser" | "deviceCode" }>;

/** The sign-in prompt stays on screen after later events (verifying) replace it. */
export function nextLoginPrompt(
  previous: LoginPrompt | null,
  event: ProviderAccountLoginEvent,
): LoginPrompt | null {
  return event._tag === "browser" || event._tag === "deviceCode" ? event : previous;
}

export type LoginWizardView =
  | { readonly kind: "name" }
  | { readonly kind: "failed"; readonly message: string }
  | {
      readonly kind: "completed";
      readonly completed: Extract<ProviderAccountLoginEvent, { _tag: "completed" }>;
    }
  | { readonly kind: "gettingLink" }
  | { readonly kind: "verifying" }
  | { readonly kind: "prompt"; readonly prompt: LoginPrompt; readonly verifying: boolean };

/** The wizard body, first match wins. `started` is false only on the name step. */
export function loginWizardView(state: {
  readonly started: boolean;
  readonly prompt: LoginPrompt | null;
  readonly event: ProviderAccountLoginEvent | null | undefined;
  readonly error: string | null;
}): LoginWizardView {
  const { started, prompt, event, error } = state;
  if (!started) return { kind: "name" };
  const failed = error ?? (event?._tag === "failed" ? event.message : null);
  if (failed !== null) return { kind: "failed", message: failed };
  if (event?._tag === "completed") return { kind: "completed", completed: event };
  const verifying = event?._tag === "verifying";
  if (prompt) return { kind: "prompt", prompt, verifying };
  return verifying ? { kind: "verifying" } : { kind: "gettingLink" };
}
