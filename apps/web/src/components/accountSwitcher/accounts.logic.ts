import { defaultInstanceIdForDriver, ProviderDriverKind } from "@t3tools/contracts";
import type {
  ProviderAccount,
  ProviderAccountGroup,
  ProviderAccountId,
  ServerProvider,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";

export const ACCOUNT_DRIVERS = ["claudeAgent", "codex"] as const;
export const ACCOUNT_DRIVER_LABELS = { claudeAgent: "Claude Code", codex: "Codex" } as const;

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

export function sortedAccounts(accounts: readonly ProviderAccount[]) {
  return [...accounts].sort(
    (a, b) =>
      Number(b.active) - Number(a.active) ||
      (remainingPercent(b) ?? -1) - (remainingPercent(a) ?? -1) ||
      a.label.localeCompare(b.label),
  );
}

export function bestAccountId(accounts: readonly ProviderAccount[]) {
  const active = accounts.find((account) => account.active);
  const remaining = active ? remainingPercent(active) : null;
  if (remaining === null || remaining > 25) return null;
  return (
    sortedAccounts(accounts).find(
      (account) =>
        !account.active &&
        account.status === "ready" &&
        remainingPercent(account) !== null &&
        remainingPercent(account)! > remaining,
    )?.id ?? null
  );
}

/** Show the tightest session and weekly window, including model-scoped weekly limits. */
export function accountUsageWindows(windows: readonly ServerProviderUsageWindow[]) {
  return (["session", "weekly"] as const).flatMap((kind) => {
    const matching = windows.filter((window) => window.kind === kind);
    const tightest = matching.reduce<ServerProviderUsageWindow | undefined>(
      (previous, window) =>
        !previous || window.usedPercent > previous.usedPercent ? window : previous,
      undefined,
    );
    return tightest ? [tightest] : [];
  });
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

/** Failed probes retain their last good bars; backoff never implies fresh quota. */
export function accountUsageDisplay(account: ProviderAccount, now: number) {
  const usage = account.usage;
  const windows =
    usage?.unavailable?.reason === "unsupported" ? [] : accountUsageWindows(usage?.windows ?? []);
  const minutes = usage ? Math.max(0, Math.floor((now - Date.parse(usage.checkedAt)) / 60_000)) : 0;
  const checkedLabel =
    windows.length > 0 ? (minutes === 0 ? "Checked just now" : `Checked ${minutes} min ago`) : null;
  const nextAllowedAt = account.usageRefresh?.nextAllowedAt;
  const retryMinutes = nextAllowedAt ? Math.ceil((Date.parse(nextAllowedAt) - now) / 60_000) : 0;
  // After a successful probe the server floor is a refresh cooldown, not a retry.
  const failed =
    account.usageRefresh?.rateLimited || !usage || usage.unavailable?.reason === "probeFailed";
  const retryLabel =
    retryMinutes > 0
      ? account.usageRefresh?.rateLimited
        ? `Usage rate-limited · retrying in ${retryMinutes}m`
        : failed
          ? `Retrying in ${retryMinutes}m`
          : `Refreshable in ${retryMinutes}m`
      : null;
  return { windows, checkedLabel, retryLabel };
}

export const HOT_SWITCH_DESCRIPTION =
  "Running sessions continue on the new account from their next request.";
export const ACCOUNT_SWITCH_NOTES = {
  hot: "Switching takes effect on the next request; running sessions keep going.",
  restart: "Switching restarts Codex; running turns are stopped after confirmation.",
} as const;

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
    ? { title: `Switched Claude to ${label}`, description: HOT_SWITCH_DESCRIPTION }
    : { title: `Switched to ${label}` };
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

export function pendingAutoSwitchAccount(
  group: Pick<ProviderAccountGroup, "switchMode" | "autoSwitch" | "accounts">,
) {
  return group.switchMode === "restart" && group.autoSwitch.state === "pending"
    ? group.accounts.find((account) => account.id === group.autoSwitch.pendingTargetAccountId)
    : undefined;
}
