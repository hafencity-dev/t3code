import { defaultInstanceIdForDriver, ProviderDriverKind } from "@t3tools/contracts";
import type {
  ProviderAccount,
  ProviderAccountAutoSwitchEvent,
  ProviderAccountDriver,
  ProviderAccountGroup,
  ProviderAccountId,
  ServerProvider,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/usageLimits";

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

/** Unknown usage must never look like unused quota or become the recommended account. */
export function remainingPercent(account: ProviderAccount): number | null {
  if (!account.usage || account.usage.unavailable || account.usage.windows.length === 0)
    return null;
  return 100 - Math.max(...account.usage.windows.map((window) => window.usedPercent));
}

export function accountTone(account: ProviderAccount) {
  const remaining = remainingPercent(account);
  if (account.status !== "ready" || (remaining !== null && remaining <= 10)) return "error";
  return remaining !== null && remaining <= 25 ? "warning" : "secondary";
}

function rankedAccounts(accounts: readonly ProviderAccount[]) {
  return [...accounts].sort(
    (a, b) =>
      Number(b.active) - Number(a.active) ||
      (remainingPercent(b) ?? -1) - (remainingPercent(a) ?? -1) ||
      a.label.localeCompare(b.label),
  );
}

/** Shown only while the active account is low; never a duplicate or an unknown quota. */
export function bestAccountId(accounts: readonly ProviderAccount[]) {
  const active = accounts.find((account) => account.active);
  const remaining = active ? remainingPercent(active) : null;
  if (remaining === null || remaining > 25) return null;
  return (
    rankedAccounts(accounts).find(
      (account) =>
        !account.active &&
        !account.duplicateOf &&
        account.status === "ready" &&
        remainingPercent(account) !== null &&
        remainingPercent(account)! > remaining,
    )?.id ?? null
  );
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
 * The tightest window of a usage column plus every window it stands for. Weekly includes
 * model-scoped weeklies and falls back to monthly windows when none is weekly.
 */
export function accountUsageCell(
  windows: readonly ServerProviderUsageWindow[],
  kind: UsageCellKind,
) {
  const weekly = windows.filter((window) => window.kind === "weekly");
  const all =
    kind === "session"
      ? windows.filter((window) => window.kind === "session")
      : weekly.length > 0
        ? weekly
        : windows.filter((window) => window.kind === "monthly");
  const tightest = all.reduce<ServerProviderUsageWindow | undefined>(
    (previous, window) =>
      !previous || window.usedPercent > previous.usedPercent ? window : previous,
    undefined,
  );
  return { tightest, all };
}

export function usageTone(remaining: number) {
  return remaining <= 10 ? "error" : remaining <= 25 ? "warning" : "default";
}

/** `in 6d 3h`, `Just reset` once the reset has passed, or null without a reset time. */
export function usageResetLabel(window: ServerProviderUsageWindow, now: number) {
  if (!window.resetsAt) return null;
  const at = Date.parse(window.resetsAt);
  if (!Number.isFinite(at)) return null;
  return at <= now ? "Just reset" : `in ${formatDuration(at - now)}`;
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
) {
  if (!defaultAccountProvider(group.driver, providers)?.enabled) return false;
  const active = group.accounts.find((account) => account.active);
  return group.accounts.length > 1 || (active !== undefined && accountTone(active) !== "secondary");
}

/** Client cooldown after a manual per-account refresh; automatic refreshes never start one. */
export const USAGE_REFRESH_COOLDOWN_MS = 60_000;
/** Matches the server's probe TTL: younger measurements are not worth an automatic probe. */
export const USAGE_STALE_MS = 5 * 60_000;

export function isUsageRefreshCoolingDown(lastRefreshedAt: number | null | undefined, now: number) {
  return lastRefreshedAt != null && now - lastRefreshedAt < USAGE_REFRESH_COOLDOWN_MS;
}

/**
 * Picks at most one inactive account for the dialog's automatic refresh, so it never
 * bulk-probes: a ready account that was never measured first, otherwise the stalest
 * measurement older than the TTL. Accounts the server is backing off are skipped.
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
  const unmeasured = candidates.find((account) => !account.usage);
  if (unmeasured) return unmeasured.id;
  let stalest: ProviderAccount | undefined;
  for (const account of candidates) {
    const checkedAt = Date.parse(account.usage!.checkedAt);
    if (now - checkedAt <= USAGE_STALE_MS) continue;
    if (!stalest || checkedAt < Date.parse(stalest.usage!.checkedAt)) stalest = account;
  }
  return stalest?.id ?? null;
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
  const blockedUntil = Math.max(gatedUntil ?? 0, cooldown ?? 0);
  if (!usage)
    return {
      ...plain("Not checked"),
      tone: "muted",
      refreshing: false,
      tooltip: "Usage hasn't been checked yet.",
      canRefresh: blockedUntil === 0,
      refreshTooltip:
        blockedUntil === 0 ? "Check usage" : `Checks resume in ${formatWait(blockedUntil - now)}`,
    };
  return {
    ...aged(age!),
    tone: "muted",
    refreshing: false,
    tooltip: `Checked ${checkedTime(usage.checkedAt)}`,
    canRefresh: blockedUntil === 0,
    refreshTooltip: blockedUntil === 0 ? "Refresh usage" : cooldownTooltip(blockedUntil),
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
        text: "Signed out. Sign in to use this account.",
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
    if (account.active && !canRemoveActiveDuplicate(account) && keeper)
      return { kind: "switchToKeeper", keeper };
    return { kind: "remove" };
  }
  if (account.status !== "ready") return { kind: "signIn" };
  if (account.active) return { kind: "active" };
  return { kind: "switch" };
}

/** Line 2 of the identity cell. */
export function accountSubtitle(account: ProviderAccount) {
  if (account.email && account.email !== account.label) return account.email;
  if (account.kind === "default") return "Original login";
  if (account.kind === "external") return "Set in Settings";
  return "No email reported";
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
  readonly variant: "success" | "warning" | "secondary";
};

const AUTO_SWITCH_BADGES: Partial<
  Record<ProviderAccountGroup["autoSwitch"]["state"], AutoSwitchBadge>
> = {
  watching: { label: "On", variant: "success" },
  pending: { label: "Waiting for turns", variant: "warning" },
  waiting: { label: "Waiting", variant: "secondary" },
  paused: { label: "Paused", variant: "secondary" },
};

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
  if (message) return { badge, text: message, showLastSwitch: true };
  const active = group.accounts.find((account) => account.active);
  return {
    badge,
    text:
      autoSwitch.state === "watching" || autoSwitch.state === "pending"
        ? `Watching ${active?.label ?? "the active account"}.`
        : AUTO_SWITCH_OFF_TEXT[group.switchMode],
    showLastSwitch: true,
  };
}
