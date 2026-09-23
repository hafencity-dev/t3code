import { describe, expect, it } from "vite-plus/test";
import {
  ProviderAccountId,
  ProviderInstanceId,
  ProviderDriverKind,
  type ProviderAccount,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import {
  accountTone,
  accountUsageWindows,
  accountUsageDisplay,
  autoRefreshAccountId,
  isUsageRefreshCoolingDown,
  bestAccountId,
  remainingPercent,
  sortedAccounts,
  providerAccountsUsageKey,
  shouldShowAccountBadge,
  accountSwitchInput,
  accountSwitchSuccess,
  accountSwitchBusyTurnCount,
  pendingAutoSwitchAccount,
} from "./accounts.logic";

const window = (usedPercent: number): ServerProviderUsageWindow => ({
  id: "session",
  kind: "session",
  label: "5h",
  usedPercent,
});
function account(
  id: string,
  used?: number,
  overrides: Partial<ProviderAccount> = {},
): ProviderAccount {
  return {
    id: ProviderAccountId.make(id),
    driver: "codex",
    label: id,
    kind: "managed",
    active: false,
    status: "ready",
    ...(used === undefined
      ? {}
      : { usage: { checkedAt: "2026-09-23T12:00:00Z", windows: [window(used)] } }),
    ...overrides,
  };
}

describe("account choices", () => {
  it("keeps active first, ranks known quotas ahead of unknown, and breaks ties by label", () => {
    const accounts = [
      account("unknown"),
      account("z", 20),
      account("active", 99, { active: true }),
      account("a", 20),
      account("empty", undefined, { usage: { checkedAt: "2026-09-23T12:00:00Z", windows: [] } }),
    ];
    expect(sortedAccounts(accounts).map((account) => account.label)).toEqual([
      "active",
      "a",
      "z",
      "empty",
      "unknown",
    ]);
    expect(accounts[0]?.label).toBe("unknown");
  });
  it("ranks fractional usage before the label tie-breaker", () => {
    expect(
      sortedAccounts([account("a", 20.4), account("z", 20.1)]).map((account) => account.label),
    ).toEqual(["z", "a"]);
  });
  it("displays the tightest weekly window and session in that order", () => {
    const weekly = { ...window(80), id: "weekly-opus", kind: "weekly" as const };
    const session = window(30);
    expect(
      accountUsageWindows([
        { ...weekly, id: "weekly", usedPercent: 20 },
        weekly,
        { ...window(10), id: "monthly", kind: "monthly" },
        session,
      ]),
    ).toEqual([session, weekly]);
    expect(accountUsageWindows([])).toEqual([]);
  });
  it("uses the tightest window, not an average", () => {
    const tight = account("tight", 0, {
      usage: {
        checkedAt: "2026-09-23T12:00:00Z",
        windows: [window(20), { ...window(94), id: "weekly", kind: "weekly" }],
      },
    });
    expect(remainingPercent(tight)).toBe(6);
    expect(accountTone(tight)).toBe("error");
  });
  it("recommends only a ready, known, strictly better inactive account when active is low", () => {
    const active = account("active", 75, { active: true });
    const better = account("better", 30);
    expect(
      bestAccountId([
        active,
        account("signed-out", 0, { status: "signedOut" }),
        account("unknown"),
        better,
      ]),
    ).toBe(better.id);
    expect(bestAccountId([account("active", 74, { active: true }), better])).toBeNull();
    expect(bestAccountId([active, account("equal", 75)])).toBeNull();
    expect(bestAccountId([account("active", undefined, { active: true }), better])).toBeNull();
  });
  it("does not recommend unavailable data or treat it as zero usage", () => {
    const unavailable = account("unavailable", 0, {
      usage: {
        checkedAt: "2026-09-23T12:00:00Z",
        windows: [window(0)],
        unavailable: { reason: "probeFailed" },
      },
    });
    expect(remainingPercent(unavailable)).toBeNull();
    expect(bestAccountId([account("active", 90, { active: true }), unavailable])).toBeNull();
  });
  it("uses warning and error thresholds and marks non-ready accounts as errors", () => {
    expect(accountTone(account("a", 90))).toBe("error");
    expect(accountTone(account("a", 75))).toBe("warning");
    expect(accountTone(account("a", 74))).toBe("secondary");
    expect(accountTone(account("a", undefined, { status: "pending" }))).toBe("error");
  });
});

function provider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email: "work@example.com" },
    checkedAt: "2026-09-23T12:00:00Z",
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: { checkedAt: "2026-09-23T12:00:00Z", windows: [window(40)] },
    ...overrides,
  };
}

describe("account snapshot invalidation", () => {
  it("tracks default-instance usage timestamps and signed-in identity", () => {
    const live = provider();
    const key = providerAccountsUsageKey([live]);
    expect(
      providerAccountsUsageKey([
        { ...live, usageLimits: { ...live.usageLimits!, checkedAt: "2026-09-23T12:01:00Z" } },
      ]),
    ).not.toBe(key);
    expect(
      providerAccountsUsageKey([
        { ...live, auth: { status: "authenticated", email: "new@example.com" } },
      ]),
    ).not.toBe(key);
    expect(providerAccountsUsageKey([{ ...live, auth: { status: "unauthenticated" } }])).not.toBe(
      key,
    );
    expect(providerAccountsUsageKey([provider({ usageLimits: undefined })])).not.toBe(key);
    expect(providerAccountsUsageKey([])).not.toBe(key);
  });
  it("ignores unrelated snapshot updates and custom instances", () => {
    const live = provider();
    const key = providerAccountsUsageKey([live]);
    const custom = provider({ instanceId: ProviderInstanceId.make("codex-work") });
    expect(
      providerAccountsUsageKey([
        { ...live, checkedAt: "2026-09-23T12:01:00Z", message: "Updated models" },
      ]),
    ).toBe(key);
    expect(providerAccountsUsageKey([custom, live])).toBe(key);
    expect(
      providerAccountsUsageKey([
        live,
        { ...custom, auth: { status: "authenticated", email: "other@example.com" } },
      ]),
    ).toBe(key);
  });
  it("tracks both defaults without depending on provider order", () => {
    const codex = provider();
    const claude = provider({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      driver: ProviderDriverKind.make("claudeAgent"),
    });
    expect(providerAccountsUsageKey([codex, claude])).toBe(
      providerAccountsUsageKey([claude, codex]),
    );
    expect(providerAccountsUsageKey([codex, claude])).not.toBe(providerAccountsUsageKey([codex]));
  });
});

describe("sidebar account badges", () => {
  const group = (accounts: readonly ProviderAccount[]) => ({ driver: "codex" as const, accounts });
  it("hides a single healthy default and empty groups", () => {
    expect(
      shouldShowAccountBadge(group([account("default", 20, { active: true })]), [provider()]),
    ).toBe(false);
    expect(
      shouldShowAccountBadge(group([account("default", undefined, { active: true })]), [
        provider(),
      ]),
    ).toBe(false);
    expect(shouldShowAccountBadge(group([]), [provider()])).toBe(false);
  });
  it("shows multiple saved accounts or an active account needing attention", () => {
    expect(
      shouldShowAccountBadge(
        group([account("default", 20, { active: true }), account("work", 10)]),
        [provider()],
      ),
    ).toBe(true);
    for (const active of [
      account("low", 75, { active: true }),
      account("critical", 90, { active: true }),
      account("expired", undefined, { active: true, status: "error" }),
      account("signed-out", undefined, { active: true, status: "signedOut" }),
      account("pending", undefined, { active: true, status: "pending" }),
    ]) {
      expect(shouldShowAccountBadge(group([active]), [provider()])).toBe(true);
    }
  });
  it("never shows badges for missing or disabled default instances", () => {
    const accounts = group([account("default", 99, { active: true }), account("work", 20)]);
    expect(shouldShowAccountBadge(accounts, [])).toBe(false);
    expect(shouldShowAccountBadge(accounts, [provider({ enabled: false })])).toBe(false);
    expect(
      shouldShowAccountBadge(accounts, [
        provider({ instanceId: ProviderInstanceId.make("codex-work") }),
      ]),
    ).toBe(false);
  });
  it("does not tint a single healthy active account for an inactive account's status", () => {
    expect(
      shouldShowAccountBadge(group([account("inactive", 99, { status: "error" })]), [provider()]),
    ).toBe(false);
  });
});

describe("usage backoff display", () => {
  const now = Date.parse("2026-09-23T12:35:00Z");
  it("retains last good bars and their age while a rate-limited probe backs off", () => {
    const saved = account("work", 40, {
      usage: {
        checkedAt: "2026-09-23T12:00:00Z",
        windows: [window(40)],
        unavailable: { reason: "probeFailed" },
      },
      usageRefresh: { nextAllowedAt: "2026-09-23T12:47:00Z", rateLimited: true },
    });
    expect(accountUsageDisplay(saved, now)).toEqual({
      windows: [window(40)],
      checkedLabel: "Checked 35 min ago",
      retryLabel: "Usage rate-limited · retrying in 12m",
    });
    expect(remainingPercent(saved)).toBeNull();
  });
  it("shows ordinary failure backoff even without any previous measurement", () => {
    expect(
      accountUsageDisplay(
        account("new", undefined, { usageRefresh: { nextAllowedAt: "2026-09-23T12:39:00Z" } }),
        now,
      ),
    ).toEqual({
      windows: [],
      checkedLabel: null,
      retryLabel: "Retrying in 4m",
    });
  });
  it("rounds remaining retry time up and removes it when the deadline arrives", () => {
    const saved = account("work", 40, {
      usageRefresh: { nextAllowedAt: "2026-09-23T12:35:01Z", rateLimited: true },
    });
    expect(accountUsageDisplay(saved, now).retryLabel).toBe("Usage rate-limited · retrying in 1m");
    expect(accountUsageDisplay(saved, now + 1_000).retryLabel).toBeNull();
    expect(accountUsageDisplay(saved, now + 60_000).retryLabel).toBeNull();
    expect(accountUsageDisplay(account("work", 40), now).retryLabel).toBeNull();
  });
  it("does not display bars or a measurement age for unsupported usage", () => {
    const saved = account("unsupported", undefined, {
      usage: {
        checkedAt: "2026-09-23T12:00:00Z",
        windows: [window(40)],
        unavailable: { reason: "unsupported" },
      },
    });
    expect(accountUsageDisplay(saved, now)).toEqual({
      windows: [],
      checkedLabel: null,
      retryLabel: null,
    });
  });
  it("updates measurement age from the supplied dialog clock", () => {
    const saved = account("work", 40);
    expect(accountUsageDisplay(saved, now - 35 * 60_000).checkedLabel).toBe("Checked just now");
    expect(accountUsageDisplay(saved, now - 36 * 60_000).checkedLabel).toBe("Checked just now");
    expect(accountUsageDisplay(saved, now + 60_000).checkedLabel).toBe("Checked 36 min ago");
  });
  it("blocks refresh for 60 seconds after completion, then permits it", () => {
    expect(isUsageRefreshCoolingDown(null, now)).toBe(false);
    expect(isUsageRefreshCoolingDown(now, now)).toBe(true);
    expect(isUsageRefreshCoolingDown(now, now + 59_999)).toBe(true);
    expect(isUsageRefreshCoolingDown(now, now + 60_000)).toBe(false);
    expect(isUsageRefreshCoolingDown(now, now + 120_000)).toBe(false);
    // Only a manual refresh records a timestamp; accounts never refreshed by hand are free.
    expect(isUsageRefreshCoolingDown(undefined, now)).toBe(false);
  });
  it("labels the post-success server floor as a cooldown, not a retry", () => {
    const saved = account("work", 40, {
      usageRefresh: { nextAllowedAt: "2026-09-23T12:39:00Z", rateLimited: false },
    });
    expect(accountUsageDisplay(saved, now).retryLabel).toBe("Refreshable in 4m");
  });
});

describe("account switch modes", () => {
  const accountId = ProviderAccountId.make("work");
  it("never sends an interruption option for hot switching", () => {
    expect(accountSwitchInput(accountId, "hot", false)).toEqual({ accountId });
    expect(accountSwitchInput(accountId, "hot", true)).toEqual({ accountId });
  });
  it("preserves explicit interruption confirmation for restart switching", () => {
    expect(accountSwitchInput(accountId, "restart", false)).toEqual({
      accountId,
      interruptRunning: false,
    });
    expect(accountSwitchInput(accountId, "restart", true)).toEqual({
      accountId,
      interruptRunning: true,
    });
  });
  it("never offers a busy confirmation for hot groups, even for an unexpected busy error", () => {
    const busy = { _tag: "ProviderAccountBusyError", runningTurnCount: 2 };
    expect(accountSwitchBusyTurnCount("hot", busy)).toBeNull();
    expect(accountSwitchBusyTurnCount("restart", busy)).toBe(2);
    expect(accountSwitchBusyTurnCount("restart", new Error("Switch failed"))).toBeNull();
    expect(accountSwitchBusyTurnCount("restart", null)).toBeNull();
  });
  it("explains that Claude's running sessions continue after a hot switch", () => {
    expect(accountSwitchSuccess("hot", "Work")).toEqual({
      title: "Switched Claude to Work",
      description: "Running sessions continue on the new account from their next request.",
    });
    expect(accountSwitchSuccess("restart", "Work")).toEqual({ title: "Switched to Work" });
  });
  it("only exposes pending auto-switch targets for restart groups", () => {
    const target = account("work", 20);
    const group = {
      switchMode: "restart" as const,
      accounts: [target],
      autoSwitch: {
        enabled: true,
        thresholdPercent: 10,
        state: "pending" as const,
        pendingTargetAccountId: target.id,
      },
    };
    expect(pendingAutoSwitchAccount(group)).toBe(target);
    expect(pendingAutoSwitchAccount({ ...group, switchMode: "hot" })).toBeUndefined();
    expect(
      pendingAutoSwitchAccount({
        ...group,
        autoSwitch: { ...group.autoSwitch, state: "watching" },
      }),
    ).toBeUndefined();
    expect(pendingAutoSwitchAccount({ ...group, accounts: [] })).toBeUndefined();
  });
});

describe("automatic usage refresh", () => {
  const now = Date.parse("2026-09-23T12:35:00Z");
  const measured = (id: string, checkedAt: string, overrides: Partial<ProviderAccount> = {}) =>
    account(id, undefined, { usage: { checkedAt, windows: [window(40)] }, ...overrides });

  it("prefers a ready account that was never measured, such as one just added", () => {
    expect(
      autoRefreshAccountId(
        [measured("old", "2026-09-23T11:00:00Z"), account("new"), account("other-new")],
        now,
      ),
    ).toBe("new");
  });
  it("otherwise picks only the stalest measurement older than five minutes", () => {
    expect(
      autoRefreshAccountId(
        [
          measured("stale", "2026-09-23T12:20:00Z"),
          measured("stalest", "2026-09-23T12:00:00Z"),
          measured("fresh", "2026-09-23T12:31:00Z"),
        ],
        now,
      ),
    ).toBe("stalest");
    expect(autoRefreshAccountId([measured("fresh", "2026-09-23T12:30:00Z")], now)).toBeNull();
  });
  it("skips active, not-ready, unsupported and server-gated accounts", () => {
    expect(
      autoRefreshAccountId(
        [
          account("active", undefined, { active: true }),
          account("signed-out", undefined, { status: "signedOut" }),
          account("pending", undefined, { status: "pending" }),
          account("gated", undefined, {
            usageRefresh: { nextAllowedAt: "2026-09-23T12:36:00Z" },
          }),
          account("unsupported", undefined, {
            usage: {
              checkedAt: "2026-09-23T11:00:00Z",
              windows: [],
              unavailable: { reason: "unsupported" },
            },
          }),
        ],
        now,
      ),
    ).toBeNull();
    expect(
      autoRefreshAccountId(
        [
          measured("backing-off", "2026-09-23T11:00:00Z", {
            usageRefresh: { nextAllowedAt: "2026-09-23T12:50:00Z", rateLimited: true },
          }),
          measured("allowed", "2026-09-23T12:00:00Z", {
            usageRefresh: { nextAllowedAt: "2026-09-23T12:05:00Z" },
          }),
        ],
        now,
      ),
    ).toBe("allowed");
  });
});
