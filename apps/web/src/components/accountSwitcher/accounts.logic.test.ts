import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderAccountId,
  ProviderInstanceId,
  ProviderDriverKind,
  type ProviderAccount,
  type ProviderAccountGroup,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import {
  accountFreshness,
  accountPrimaryAction,
  autoSwitchInput,
  autoSwitchNowBlockedReason,
  endRename,
  endSwitch,
  loginWizardView,
  nextLoginPrompt,
  renameRestoresFocus,
  resolveAccountsDevice,
  shouldToastAutoSwitch,
  usageResetCheckWillRun,
  usageResetKey,
  usageWindowTooltipLine,
  accountStatusMessage,
  accountSubtitle,
  accountTone,
  accountUsageCell,
  accountUsageCellView,
  autoRefreshAccountId,
  autoSwitchStatus,
  isUsageRefreshCoolingDown,
  bestAccountId,
  formatAgo,
  orderedAccounts,
  plural,
  readyAccountCount,
  remainingPercent,
  removeBlockedReason,
  shortPlanLabel,
  providerAccountsUsageKey,
  shouldShowAccountBadge,
  stopTurnsCopy,
  switchBlockedReason,
  accountSwitchInput,
  accountSwitchSuccess,
  accountSwitchBusyTurnCount,
  pendingAutoSwitchAccount,
  usageResetLabel,
  windowPrimerStatus,
} from "./accounts.logic";

const window = (usedPercent: number): ServerProviderUsageWindow => ({
  id: "session",
  kind: "session",
  label: "5h",
  usedPercent,
});
/** Fixture windows carry no reset time, so any clock works for them. */
const NOW = Date.parse("2026-09-23T12:30:00Z");
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
  it("keeps Default first and otherwise the server order, whatever the usage", () => {
    const accounts = [
      account("z", 90),
      account("default", 10, { kind: "default", active: true }),
      account("a", 20),
    ];
    expect(orderedAccounts(accounts).map((entry) => entry.label)).toEqual(["default", "z", "a"]);
  });
  it("picks the tightest window per column and lists every window of that kind", () => {
    const weekly = { ...window(80), id: "weekly-opus", kind: "weekly" as const };
    const session = window(30);
    const monthly = { ...window(10), id: "monthly", kind: "monthly" as const };
    const windows = [{ ...weekly, id: "weekly", usedPercent: 20 }, weekly, monthly, session];
    expect(accountUsageCell(windows, "session")).toEqual({ tightest: session, all: [session] });
    expect(accountUsageCell(windows, "weekly").tightest).toBe(weekly);
    expect(accountUsageCell(windows, "weekly").all).toHaveLength(2);
    // Monthly stands in for weekly only when no weekly window exists.
    expect(accountUsageCell([monthly], "weekly").tightest).toBe(monthly);
    expect(accountUsageCell([monthly], "session")).toEqual({ tightest: undefined, all: [] });
  });
  it("shows Claude's all-model weekly and lists model-scoped weeklies only on hover", () => {
    const now = Date.parse("2026-09-23T12:00:00Z");
    const weekly = {
      id: "seven_day",
      kind: "weekly" as const,
      label: "Weekly",
      usedPercent: 40,
      resetsAt: "2026-09-26T12:00:00Z",
    };
    const fable = {
      id: "seven_day_fable",
      kind: "weekly" as const,
      label: "Weekly · Fable",
      usedPercent: 88,
      resetsAt: "2026-09-25T12:00:00Z",
    };
    const session = { ...window(10), id: "five_hour" };
    const view = accountUsageCellView([session, fable, weekly], "weekly", now, true);
    expect(view).toMatchObject({ remaining: 60, reset: "in 3d 0h", tone: "default" });
    expect(view.all).toEqual([weekly, fable]);
    expect(usageWindowTooltipLine(fable, now, true)).toBe(
      "Weekly · Fable: 12% left, resets in 2d 0h",
    );
    const claude = account("claude", undefined, {
      driver: "claudeAgent",
      usage: { checkedAt: "2026-09-23T12:00:00Z", windows: [session, fable, weekly] },
    });
    expect(remainingPercent(claude, now)).toBe(60);
    expect(accountTone(claude, now)).toBe("secondary");
    // A low Fable weekly alone never recommends another account.
    expect(bestAccountId([{ ...claude, active: true }, account("fresh", 0)], now)).toBeNull();
    // Without the all-model weekly, the model-scoped one fills the column.
    expect(accountUsageCellView([fable], "weekly", now, true).remaining).toBe(12);
    expect(
      remainingPercent({ ...claude, usage: { ...claude.usage!, windows: [session, fable] } }, now),
    ).toBe(12);
  });
  it("labels resets, and marks a passed reset as waiting for a check", () => {
    const now = Date.parse("2026-09-23T12:00:00Z");
    expect(usageResetLabel(window(10), now, true)).toBeNull();
    expect(usageResetLabel({ ...window(10), resetsAt: "2026-09-23T15:30:00Z" }, now, true)).toBe(
      "in 3h 30m",
    );
    expect(usageResetLabel({ ...window(10), resetsAt: "2026-09-23T11:00:00Z" }, now, true)).toBe(
      "Resets now · checking…",
    );
    // No check will run: never promise one.
    expect(usageResetLabel({ ...window(10), resetsAt: "2026-09-23T11:00:00Z" }, now, false)).toBe(
      "Reset · not checked yet",
    );
  });
  it("never shows a stale percent next to a reset that already passed", () => {
    const now = Date.parse("2026-09-23T12:00:00Z");
    const weekly = { ...window(100), id: "weekly", kind: "weekly" as const };
    expect(
      accountUsageCellView([{ ...weekly, resetsAt: "2026-09-23T11:00:00Z" }], "weekly", now, true),
    ).toMatchObject({
      remaining: null,
      reset: "Resets now · checking…",
      resetPending: true,
      tone: "default",
    });
    expect(
      accountUsageCellView([{ ...weekly, resetsAt: "2026-09-24T12:00:00Z" }], "weekly", now, true),
    ).toMatchObject({ remaining: 0, reset: "in 1d 0h", resetPending: false, tone: "error" });
  });
  it("uses the tightest window, not an average", () => {
    const tight = account("tight", 0, {
      usage: {
        checkedAt: "2026-09-23T12:00:00Z",
        windows: [window(20), { ...window(94), id: "weekly", kind: "weekly" }],
      },
    });
    expect(remainingPercent(tight, NOW)).toBe(6);
    expect(accountTone(tight, NOW)).toBe("error");
  });
  it("recommends only a ready, known, strictly better inactive account when active is low", () => {
    const active = account("active", 75, { active: true });
    const better = account("better", 30);
    expect(
      bestAccountId(
        [active, account("signed-out", 0, { status: "signedOut" }), account("unknown"), better],
        NOW,
      ),
    ).toBe(better.id);
    expect(bestAccountId([account("active", 74, { active: true }), better], NOW)).toBeNull();
    expect(bestAccountId([active, account("equal", 75)], NOW)).toBeNull();
    expect(bestAccountId([account("active", undefined, { active: true }), better], NOW)).toBeNull();
  });
  it("does not recommend unavailable data or treat it as zero usage", () => {
    const unavailable = account("unavailable", 0, {
      usage: {
        checkedAt: "2026-09-23T12:00:00Z",
        windows: [window(0)],
        unavailable: { reason: "probeFailed" },
      },
    });
    expect(remainingPercent(unavailable, NOW)).toBeNull();
    expect(bestAccountId([account("active", 90, { active: true }), unavailable], NOW)).toBeNull();
  });
  it("uses warning and error thresholds and marks non-ready accounts as errors", () => {
    expect(accountTone(account("a", 90), NOW)).toBe("error");
    expect(accountTone(account("a", 75), NOW)).toBe("warning");
    expect(accountTone(account("a", 74), NOW)).toBe("secondary");
    expect(accountTone(account("a", undefined, { status: "pending" }), NOW)).toBe("error");
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
      shouldShowAccountBadge(group([account("default", 20, { active: true })]), [provider()], NOW),
    ).toBe(false);
    expect(
      shouldShowAccountBadge(
        group([account("default", undefined, { active: true })]),
        [provider()],
        NOW,
      ),
    ).toBe(false);
    expect(shouldShowAccountBadge(group([]), [provider()], NOW)).toBe(false);
  });
  it("shows multiple saved accounts or an active account needing attention", () => {
    expect(
      shouldShowAccountBadge(
        group([account("default", 20, { active: true }), account("work", 10)]),
        [provider()],
        NOW,
      ),
    ).toBe(true);
    for (const active of [
      account("low", 75, { active: true }),
      account("critical", 90, { active: true }),
      account("expired", undefined, { active: true, status: "error" }),
      account("signed-out", undefined, { active: true, status: "signedOut" }),
      account("pending", undefined, { active: true, status: "pending" }),
    ]) {
      expect(shouldShowAccountBadge(group([active]), [provider()], NOW)).toBe(true);
    }
  });
  it("never shows badges for missing or disabled default instances", () => {
    const accounts = group([account("default", 99, { active: true }), account("work", 20)]);
    expect(shouldShowAccountBadge(accounts, [], NOW)).toBe(false);
    expect(shouldShowAccountBadge(accounts, [provider({ enabled: false })], NOW)).toBe(false);
    expect(
      shouldShowAccountBadge(
        accounts,
        [provider({ instanceId: ProviderInstanceId.make("codex-work") })],
        NOW,
      ),
    ).toBe(false);
  });
  it("does not tint a single healthy active account for an inactive account's status", () => {
    expect(
      shouldShowAccountBadge(
        group([account("inactive", 99, { status: "error" })]),
        [provider()],
        NOW,
      ),
    ).toBe(false);
  });
});

describe("freshness", () => {
  const now = Date.parse("2026-09-23T12:35:00Z");
  const idle = { refreshing: false };
  it("merges into the status message for rows that aren't ready or are duplicates", () => {
    expect(accountFreshness(account("a", 10, { status: "signedOut" }), now, idle)).toBeNull();
    expect(
      accountFreshness(account("a", 10, { duplicateOf: ProviderAccountId.make("b") }), now, idle),
    ).toBeNull();
  });
  it("shows unsupported usage as a dash with the refresh button disabled", () => {
    const unsupported = account("api", undefined, {
      active: true,
      usage: {
        checkedAt: "2026-09-23T12:00:00Z",
        windows: [],
        unavailable: { reason: "unsupported" },
      },
    });
    expect(accountFreshness(unsupported, now, { refreshing: true })).toMatchObject({
      text: "—",
      canRefresh: false,
      refreshTooltip: "Usage isn't reported for this login",
    });
  });
  it("shows checking while any request for the row is in flight", () => {
    expect(accountFreshness(account("a", 10), now, { refreshing: true })).toMatchObject({
      text: "Checking…",
      refreshing: true,
      canRefresh: false,
    });
  });
  it("never lets a leftover backoff contradict the active account's live numbers", () => {
    const active = account("active", 40, {
      active: true,
      usage: { checkedAt: "2026-09-23T12:34:30Z", windows: [window(40)] },
      usageRefresh: { nextAllowedAt: "2026-09-23T12:47:00Z", rateLimited: true },
    });
    expect(accountFreshness(active, now, idle)).toMatchObject({
      text: "Just now",
      narrowText: "Checked just now",
      tone: "muted",
      tooltip: "Updated with every turn on the active account.",
      canRefresh: true,
    });
    expect(
      accountFreshness(active, now, { refreshing: false, cooldownUntil: now + 90_000 }),
    ).toMatchObject({ canRefresh: false, refreshTooltip: "You can refresh again in 2m" });
    expect(accountFreshness(account("active", undefined, { active: true }), now, idle)?.text).toBe(
      "Not checked",
    );
  });
  it("reports a rate limit with the age of the retained numbers", () => {
    const limited = account("work", 40, {
      usage: {
        checkedAt: "2026-09-23T12:00:00Z",
        windows: [window(40)],
        unavailable: { reason: "probeFailed" },
      },
      usageRefresh: { nextAllowedAt: "2026-09-23T12:39:30Z", rateLimited: true },
    });
    expect(accountFreshness(limited, now, idle)).toEqual({
      text: "Retry in 5m",
      narrowText: "Retry in 5m",
      tone: "warning",
      icon: "alert",
      refreshing: false,
      tooltip: "Codex is rate-limiting usage checks. Showing numbers from 35m ago.",
      canRefresh: false,
      refreshTooltip: "Checks resume in 5m",
    });
    expect(
      accountFreshness(
        account("new", undefined, {
          usageRefresh: { nextAllowedAt: "2026-09-23T12:39:00Z", rateLimited: true },
        }),
        now,
        idle,
      )?.tooltip,
    ).toBe("Codex is rate-limiting usage checks. No numbers yet.");
  });
  it("tells a failed check that is backing off from one that can retry now", () => {
    const failed = (nextAllowedAt?: string) =>
      account("work", 40, {
        usage: {
          checkedAt: "2026-09-23T12:00:00Z",
          windows: [window(40)],
          unavailable: { reason: "probeFailed" },
        },
        ...(nextAllowedAt ? { usageRefresh: { nextAllowedAt } } : {}),
      });
    expect(accountFreshness(failed("2026-09-23T12:36:00Z"), now, idle)).toMatchObject({
      text: "Retry in 1m",
      tooltip: "The last check failed. Showing numbers from 35m ago.",
      canRefresh: false,
    });
    expect(accountFreshness(failed(), now, idle)).toMatchObject({
      text: "Check failed",
      tone: "warning",
      canRefresh: true,
      refreshTooltip: "Try again",
    });
    // The deadline passing turns the wait into a retry.
    expect(accountFreshness(failed("2026-09-23T12:36:00Z"), now + 60_000, idle)?.text).toBe(
      "Check failed",
    );
  });
  it("offers a first check for accounts never measured", () => {
    expect(accountFreshness(account("new"), now, idle)).toMatchObject({
      text: "Not checked",
      tooltip: "Usage hasn't been checked yet.",
      canRefresh: true,
      refreshTooltip: "Check usage",
    });
  });
  it("only disables the button after a successful probe; never shows retry text", () => {
    const fresh = account("work", 40, {
      usage: { checkedAt: "2026-09-23T12:32:00Z", windows: [window(40)] },
      usageRefresh: { nextAllowedAt: "2026-09-23T12:37:00Z", rateLimited: false },
    });
    const state = accountFreshness(fresh, now, idle);
    expect(state).toMatchObject({
      text: "3m ago",
      narrowText: "Checked 3m ago",
      tone: "muted",
      canRefresh: false,
      refreshTooltip: "Checks resume in 2m",
    });
    expect(state?.text).not.toContain("Retry");
    expect(accountFreshness(fresh, now + 3 * 60_000, idle)).toMatchObject({
      text: "6m ago",
      canRefresh: true,
      refreshTooltip: "Refresh usage",
    });
    // The client cooldown after a manual refresh disables it the same way.
    expect(
      accountFreshness(account("work", 40), now, { refreshing: false, cooldownUntil: now + 1 })
        ?.canRefresh,
    ).toBe(false);
  });
  it("formats ages in the fixed steps", () => {
    expect(formatAgo(59_999)).toBe("Just now");
    expect(formatAgo(59_999, true)).toBe("just now");
    expect(formatAgo(3 * 60_000)).toBe("3m ago");
    expect(formatAgo(2 * 3_600_000 + 1)).toBe("2h ago");
    expect(formatAgo(3 * 86_400_000)).toBe("3d ago");
    expect(formatAgo(-5_000)).toBe("Just now");
  });
  it("blocks refresh for 60 seconds after completion, then permits it", () => {
    expect(isUsageRefreshCoolingDown(null, now)).toBe(false);
    expect(isUsageRefreshCoolingDown(now, now)).toBe(true);
    expect(isUsageRefreshCoolingDown(now, now + 59_999)).toBe(true);
    expect(isUsageRefreshCoolingDown(now, now + 60_000)).toBe(false);
    expect(isUsageRefreshCoolingDown(undefined, now)).toBe(false);
  });
});

describe("copy helpers", () => {
  it("pluralises through one helper", () => {
    expect(plural(1, "running turn")).toBe("1 running turn");
    expect(plural(2, "running turn")).toBe("2 running turns");
    expect(plural(0, "child", "children")).toBe("0 children");
  });
  it("shortens plan names and falls back to the raw string", () => {
    expect(shortPlanLabel("Claude Max Subscription")).toBe("Max");
    expect(shortPlanLabel("ChatGPT Pro 20x Subscription")).toBe("Pro 20x");
    expect(shortPlanLabel("chatgpt plus plan")).toBe("plus");
    expect(shortPlanLabel("Team")).toBe("Team");
    expect(shortPlanLabel("Claude Subscription")).toBe("Subscription");
  });
  it("describes stopping one or several running turns", () => {
    expect(stopTurnsCopy("Work", 1)).toEqual({
      title: "Stop 1 running turn?",
      description:
        "Switching Codex to Work restarts it. The running turn stops now. Its thread keeps its history and can continue on Work.",
    });
    expect(stopTurnsCopy("Work", 2).title).toBe("Stop 2 running turns?");
    expect(stopTurnsCopy("Work", 2).description).toContain("The 2 running turns stop now.");
  });
  it("falls back to a description of the login when there is no distinct email", () => {
    expect(accountSubtitle(account("a", undefined, { email: "a@x.dev" }))).toBe("a@x.dev");
    expect(accountSubtitle(account("Default", undefined, { kind: "default" }))).toBe(
      "Original login",
    );
    expect(accountSubtitle(account("ext", undefined, { kind: "external" }))).toBe(
      "Set in Settings",
    );
    // An email already used as the name is known, just not repeated.
    expect(accountSubtitle(account("a@x.dev", undefined, { email: "A@x.dev" }))).toBe(
      "Saved login",
    );
    expect(accountSubtitle(account("Work"))).toBe("No email reported");
  });
});

describe("row state", () => {
  const keeper = account("keeper", 20, { kind: "default" });
  const duplicate = (overrides: Partial<ProviderAccount> = {}) =>
    account("copy", 20, { duplicateOf: keeper.id, email: "same@x.dev", ...overrides });
  it("uses the first matching status message", () => {
    expect(accountStatusMessage(duplicate({ status: "signedOut" }), "Default")).toEqual({
      icon: "copy",
      tone: "warning",
      text: "Same account as Default.",
    });
    expect(accountStatusMessage(account("a", 0, { status: "signedOut" }), "")?.text).toBe(
      "Signed out. Sign in to use this account.",
    );
    expect(
      accountStatusMessage(
        account("a", 0, {
          status: "signedOut",
          message: "Signed out by a sign-in in the terminal.",
        }),
        "",
      )?.text,
    ).toBe("Signed out by a sign-in in the terminal.");
    expect(accountStatusMessage(account("a", 0, { status: "error" }), "")?.text).toBe(
      "Login expired. Sign in again to use this account.",
    );
    expect(
      accountStatusMessage(account("a", 0, { status: "error", message: "Wrong account" }), ""),
    ).toMatchObject({ tone: "error", text: "Wrong account" });
    expect(accountStatusMessage(account("a", 0, { status: "pending" }), "")?.text).toBe(
      "Sign-in wasn't finished.",
    );
    expect(accountStatusMessage(account("a", 0), "")).toBeNull();
  });
  it("picks the primary action in precedence order", () => {
    const group = { accounts: [keeper, duplicate()] };
    expect(accountPrimaryAction(duplicate(), group, "self").kind).toBe("switching");
    expect(accountPrimaryAction(duplicate(), group, "idle").kind).toBe("remove");
    expect(accountPrimaryAction(account("a", 0, { status: "error" }), group, "idle").kind).toBe(
      "signIn",
    );
    expect(
      accountPrimaryAction(account("a", 0, { status: "signedOut", active: true }), group, "idle")
        .kind,
    ).toBe("signIn");
    expect(accountPrimaryAction(account("a", 0, { active: true }), group, "idle").kind).toBe(
      "active",
    );
    expect(accountPrimaryAction(account("a", 0), group, "other").kind).toBe("switch");
  });
  it("removes an active Claude duplicate, but an active Codex duplicate switches first", () => {
    const claude = duplicate({ active: true, driver: "claudeAgent" });
    const codex = duplicate({ active: true });
    expect(accountPrimaryAction(claude, { accounts: [keeper, claude] }, "idle").kind).toBe(
      "remove",
    );
    expect(removeBlockedReason(claude, false)).toBeUndefined();
    expect(accountPrimaryAction(codex, { accounts: [keeper, codex] }, "idle")).toEqual({
      kind: "switchToKeeper",
      keeper,
    });
    expect(removeBlockedReason(codex, false)).toBe("Switch to another account first.");
  });
  it("explains why remove and switch are blocked", () => {
    expect(removeBlockedReason(account("d", 0, { kind: "default", active: true }), true)).toBe(
      "The original login can't be removed.",
    );
    expect(removeBlockedReason(account("a", 0, { active: true }), true)).toBe(
      "Switch to another account first.",
    );
    expect(removeBlockedReason(account("a", 0), true)).toBe("Wait for the sign-in to finish.");
    expect(removeBlockedReason(account("a", 0), false)).toBeUndefined();
    expect(switchBlockedReason({ warning: "Config changed" }, "other")).toBe(
      "Switching is paused. See the warning above.",
    );
    expect(switchBlockedReason({}, "other")).toBe("Another switch is in progress.");
    expect(switchBlockedReason({}, "idle")).toBeUndefined();
  });
  it("never recommends or probes a duplicate and counts it once", () => {
    const active = account("active", 90, { active: true });
    const copy = account("copy", 10, { duplicateOf: active.id });
    expect(bestAccountId([active, copy], NOW)).toBeNull();
    expect(
      autoRefreshAccountId([account("copy", undefined, { duplicateOf: active.id })], 0),
    ).toBeNull();
    expect(readyAccountCount([active, copy, account("out", 0, { status: "signedOut" })])).toBe(1);
  });
});

describe("auto-switch status", () => {
  const target = account("work", 20);
  const active = account("home", 80, { active: true });
  const group = (
    autoSwitch: Partial<ProviderAccountGroup["autoSwitch"]>,
    switchMode: ProviderAccountGroup["switchMode"] = "restart",
  ) => ({
    switchMode,
    accounts: [active, target],
    autoSwitch: { enabled: true, thresholdPercent: 10, state: "watching" as const, ...autoSwitch },
  });
  it("explains the feature while off, per switch mode", () => {
    expect(autoSwitchStatus(group({ enabled: false, state: "off" }), undefined)).toEqual({
      text: "Switches before the active account runs out. Waits for running turns to finish.",
    });
    expect(autoSwitchStatus(group({ enabled: false, state: "off" }, "hot")).text).toBe(
      "Switches before the active account runs out. Running sessions keep going.",
    );
  });
  it("names the pending target and its running turns", () => {
    const pending = group({ state: "pending", pendingTargetAccountId: target.id });
    expect(autoSwitchStatus(pending)).toMatchObject({
      badge: { label: "Waiting for turns", variant: "warning" },
      target,
      text: "Switches to work when running turns finish.",
    });
    const event = {
      _tag: "pending" as const,
      driver: "codex" as const,
      toAccountId: target.id,
      toLabel: "work",
      runningTurnCount: 1,
      reason: "Low",
    };
    expect(autoSwitchStatus(pending, event).text).toBe(
      "Switches to work when 1 running turn finishes.",
    );
    expect(autoSwitchStatus(pending, { ...event, runningTurnCount: 2 }).text).toBe(
      "Switches to work when 2 running turns finish.",
    );
  });
  it("prefers the server message, otherwise names the watched account", () => {
    expect(
      autoSwitchStatus(group({ state: "paused", message: "Pausing early rotation." })),
    ).toMatchObject({
      badge: { label: "Paused" },
      text: "Pausing early rotation.",
    });
    expect(autoSwitchStatus(group({}))).toMatchObject({
      badge: { label: "On", variant: "success" },
      text: "Watching home.",
    });
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
      title: "Switched Claude Code to Work",
      description:
        "Running sessions use it from their next request. On macOS this can take up to 30 seconds.",
    });
    expect(accountSwitchSuccess("restart", "Work")).toEqual({
      title: "Switched Codex to Work",
      description: "Codex restarted on the new account.",
    });
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
  it("next picks an account whose window reset after it was measured, however recent", () => {
    const reset = (id: string, checkedAt: string, resetsAt: string) =>
      account(id, undefined, {
        usage: { checkedAt, windows: [{ ...window(100), resetsAt }] },
      });
    expect(
      autoRefreshAccountId(
        [
          measured("stalest", "2026-09-23T11:00:00Z"),
          reset("rolled-over", "2026-09-23T12:33:00Z", "2026-09-23T12:34:00Z"),
        ],
        now,
      ),
    ).toBe("rolled-over");
    // A reset already past when measured is what the provider reported; probing won't change it.
    expect(
      autoRefreshAccountId(
        [reset("reported", "2026-09-23T12:33:00Z", "2026-09-23T12:00:00Z")],
        now,
      ),
    ).toBeNull();
    expect(
      autoRefreshAccountId(
        [account("new"), reset("rolled-over", "2026-09-23T12:33:00Z", "2026-09-23T12:34:00Z")],
        now,
      ),
    ).toBe("new");
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

describe("windowPrimerStatus", () => {
  const now = Date.parse("2026-09-24T12:00:00.000Z");
  const work = ProviderAccountId.make("work");
  const personal = ProviderAccountId.make("personal");
  const accounts = [
    { id: work, label: "Work" },
    { id: personal, label: "Personal" },
  ];
  const at = (offset: number) => new Date(now + offset).toISOString();

  it("describes the feature while off and shows errors first", () => {
    expect(windowPrimerStatus({ enabled: false }, accounts, now)).toBe(
      "Starts each account's 5-hour window as soon as it can.",
    );
    expect(
      windowPrimerStatus(
        {
          enabled: true,
          message: "Couldn't start Work's 5-hour window. Claude returned an error.",
          nextPrimeAt: at(60_000),
          nextPrimeAccountId: work,
        },
        accounts,
        now,
      ),
    ).toBe("Couldn't start Work's 5-hour window. Claude returned an error.");
  });

  it("prefers a recent start, then the next start, then an older start", () => {
    const next = { nextPrimeAt: at(42 * 60_000), nextPrimeAccountId: work };
    expect(
      windowPrimerStatus(
        { enabled: true, lastPrimedAt: at(-3 * 60_000), lastPrimedAccountId: personal, ...next },
        accounts,
        now,
      ),
    ).toBe("Started Personal's window 3m ago.");
    expect(
      windowPrimerStatus(
        { enabled: true, lastPrimedAt: at(-12 * 60_000), lastPrimedAccountId: personal, ...next },
        accounts,
        now,
      ),
    ).toBe("Next start: Work in 42m.");
    expect(
      windowPrimerStatus(
        { enabled: true, nextPrimeAt: at(-1_000), nextPrimeAccountId: work },
        accounts,
        now,
      ),
    ).toBe("Starting Work's window now.");
    expect(
      windowPrimerStatus(
        { enabled: true, lastPrimedAt: at(-12 * 60_000), lastPrimedAccountId: personal },
        accounts,
        now,
      ),
    ).toBe("Started Personal's window 12m ago.");
    expect(windowPrimerStatus({ enabled: true }, accounts, now)).toBe(
      "No signed-in account can start a window right now.",
    );
  });
});

describe("audit regressions", () => {
  const id = (value: string) => ProviderAccountId.make(value);
  const now = Date.parse("2026-09-23T12:30:00Z");
  const measuredAt = "2026-09-23T12:00:00Z";
  const resetWindow = (usedPercent: number, resetsAt: string): ServerProviderUsageWindow => ({
    ...window(usedPercent),
    resetsAt,
  });

  it("keeps the sign-in prompt on screen while the account is verified", () => {
    const browser = { _tag: "browser", url: "https://claude.ai/x", needsCode: true } as const;
    let prompt = nextLoginPrompt(null, { _tag: "started", loginId: "l", accountId: id("a") });
    expect(loginWizardView({ started: true, prompt, event: undefined, error: null })).toEqual({
      kind: "gettingLink",
    });
    prompt = nextLoginPrompt(prompt, browser);
    prompt = nextLoginPrompt(prompt, { _tag: "verifying" });
    expect(prompt).toBe(browser);
    expect(
      loginWizardView({ started: true, prompt, event: { _tag: "verifying" }, error: null }),
    ).toEqual({ kind: "prompt", prompt: browser, verifying: true });
    // Verifying before any prompt reads as checking, never as fetching a link.
    expect(
      loginWizardView({ started: true, prompt: null, event: { _tag: "verifying" }, error: null }),
    ).toEqual({ kind: "verifying" });
    expect(loginWizardView({ started: false, prompt, event: undefined, error: null }).kind).toBe(
      "name",
    );
    expect(
      loginWizardView({ started: true, prompt, event: { _tag: "verifying" }, error: "Lost" }),
    ).toEqual({ kind: "failed", message: "Lost" });
    expect(
      loginWizardView({
        started: true,
        prompt,
        event: { _tag: "completed", accountId: id("a") },
        error: null,
      }).kind,
    ).toBe("completed");
  });

  it("pins the dialog's device: a drop reads as offline and never jumps to another", () => {
    const laptop = EnvironmentId.make("laptop");
    const server = EnvironmentId.make("server");
    expect(resolveAccountsDevice(laptop, [server], true)).toEqual({
      environmentId: null,
      offlineId: laptop,
    });
    expect(resolveAccountsDevice(laptop, [server, laptop], true)).toEqual({
      environmentId: laptop,
      offlineId: null,
    });
    // Closed, the sidebar follows the first connected device.
    expect(resolveAccountsDevice(laptop, [server], false)).toEqual({
      environmentId: server,
      offlineId: null,
    });
    expect(resolveAccountsDevice(null, [], true)).toEqual({ environmentId: null, offlineId: null });
  });

  it("sends a threshold only when it changes", () => {
    expect(autoSwitchInput("codex", false, 10)).toEqual({ driver: "codex", enabled: false });
    expect(autoSwitchInput("codex", true, 10, 10)).toEqual({ driver: "codex", enabled: true });
    expect(autoSwitchInput("codex", true, 10, 15)).toEqual({
      driver: "codex",
      enabled: true,
      thresholdPercent: 15,
    });
  });

  it("blocks Switch now while any switch runs, and a switch ending clears only itself", () => {
    const target = id("b");
    expect(autoSwitchNowBlockedReason({}, null, target)).toBeUndefined();
    expect(autoSwitchNowBlockedReason({}, id("c"), target)).toBe("Another switch is in progress.");
    expect(autoSwitchNowBlockedReason({}, target, target)).toBeUndefined();
    expect(autoSwitchNowBlockedReason({ warning: "Paused" }, null, target)).toBe(
      "Switching is paused. See the warning above.",
    );
    expect(endSwitch(id("c"), target)).toBe(id("c"));
    expect(endSwitch(target, target)).toBeNull();
  });

  it("never counts a window whose reset passed as current quota", () => {
    const passed = account("a", undefined, {
      usage: {
        checkedAt: measuredAt,
        windows: [resetWindow(95, "2026-09-23T12:10:00Z"), { ...window(40), id: "weekly" }],
      },
    });
    expect(remainingPercent(passed, now)).toBe(60);
    expect(accountTone(passed, now)).toBe("secondary");
    const onlyPassed = account("b", undefined, {
      usage: { checkedAt: measuredAt, windows: [resetWindow(0, "2026-09-23T12:10:00Z")] },
    });
    expect(remainingPercent(onlyPassed, now)).toBeNull();
    // Unknown after a reset is never recommended.
    expect(bestAccountId([account("active", 90, { active: true }), onlyPassed], now)).toBeNull();
    expect(usageWindowTooltipLine(resetWindow(95, "2026-09-23T12:10:00Z"), now, false)).toBe(
      "5h: reset, not checked yet",
    );
    expect(usageWindowTooltipLine(window(40), now, false)).toBe("5h: 60% left");
  });

  it("says checking after a reset only when a check will run", () => {
    const stale = (overrides: Partial<ProviderAccount> = {}) =>
      account("a", undefined, {
        usage: { checkedAt: measuredAt, windows: [resetWindow(80, "2026-09-23T12:10:00Z")] },
        ...overrides,
      });
    const key = usageResetKey(stale({ active: true }), now);
    expect(key).not.toBeNull();
    // The active account gets exactly one live refresh per measurement.
    expect(usageResetCheckWillRun(stale({ active: true }), now, new Set())).toBe(true);
    expect(usageResetCheckWillRun(stale({ active: true }), now, new Set([key!]))).toBe(false);
    expect(usageResetCheckWillRun(stale(), now, new Set())).toBe(true);
    expect(
      usageResetCheckWillRun(
        stale({ usageRefresh: { nextAllowedAt: "2026-09-23T12:40:00Z" } }),
        now,
        new Set(),
      ),
    ).toBe(false);
    expect(usageResetCheckWillRun(stale({ status: "signedOut" }), now, new Set())).toBe(false);
    // Measured after the reset: nothing is stale, nothing will run.
    const measuredLater = account("a", undefined, {
      usage: {
        checkedAt: "2026-09-23T12:20:00Z",
        windows: [resetWindow(80, "2026-09-23T12:10:00Z")],
      },
    });
    expect(usageResetKey(measuredLater, now)).toBeNull();
  });

  it("offers Switch to keeper only for a ready keeper, otherwise a blocked Remove", () => {
    const codex = account("copy", 0, { active: true, duplicateOf: id("keeper") });
    const signedOutKeeper = account("keeper", 0, { status: "signedOut" });
    expect(accountPrimaryAction(codex, { accounts: [signedOutKeeper, codex] }, "idle")).toEqual({
      kind: "remove",
    });
    expect(removeBlockedReason(codex, false)).toBe("Switch to another account first.");
    const readyKeeper = account("keeper", 0);
    expect(accountPrimaryAction(codex, { accounts: [readyKeeper, codex] }, "idle")).toEqual({
      kind: "switchToKeeper",
      keeper: readyKeeper,
    });
  });

  it("ends only the row's own rename and restores focus only for Enter and Escape", () => {
    expect(endRename(id("a"), id("a"))).toBeNull();
    expect(endRename(id("b"), id("a"))).toBe(id("b"));
    expect(endRename(null, id("a"))).toBeNull();
    expect(renameRestoresFocus("enter")).toBe(true);
    expect(renameRestoresFocus("escape")).toBe(true);
    expect(renameRestoresFocus("blur")).toBe(false);
  });

  it("toasts each auto-switch once per device, across remounts", () => {
    const seen = new Map<string, string>();
    const laptop = EnvironmentId.make("laptop");
    const switched = {
      _tag: "switched",
      driver: "codex",
      fromAccountId: id("a"),
      toAccountId: id("b"),
      toLabel: "B",
      trigger: "session",
      reason: "A ran low.",
      at: "2026-09-23T12:00:00Z",
    } as const;
    expect(shouldToastAutoSwitch(seen, laptop, switched)).toBe(true);
    expect(shouldToastAutoSwitch(seen, laptop, switched)).toBe(false);
    expect(shouldToastAutoSwitch(seen, EnvironmentId.make("server"), switched)).toBe(true);
    expect(shouldToastAutoSwitch(seen, laptop, { ...switched, at: "2026-09-23T13:00:00Z" })).toBe(
      true,
    );
    expect(
      shouldToastAutoSwitch(seen, laptop, { _tag: "blocked", driver: "codex", reason: "x" }),
    ).toBe(false);
  });

  it("breaks a headroom tie by the soonest weekly reset", () => {
    const withWeekly = (name: string, resetsAt: string) =>
      account(name, undefined, {
        usage: {
          checkedAt: measuredAt,
          windows: [window(20), { ...window(10), id: "weekly", kind: "weekly", resetsAt }],
        },
      });
    const later = withWeekly("a-later", "2026-09-28T12:00:00Z");
    const sooner = withWeekly("z-sooner", "2026-09-25T12:00:00Z");
    expect(bestAccountId([account("active", 90, { active: true }), later, sooner], now)).toBe(
      sooner.id,
    );
  });

  it("names the server's gate, budget included, as when checks resume", () => {
    const gated = account("work", 40, {
      usage: { checkedAt: "2026-09-23T12:28:00Z", windows: [window(40)] },
      usageRefresh: { nextAllowedAt: "2026-09-23T12:40:00Z" },
    });
    expect(accountFreshness(gated, now, { refreshing: false })).toMatchObject({
      canRefresh: false,
      refreshTooltip: "Checks resume in 10m",
    });
    // A longer client cooldown is the binding wait.
    expect(
      accountFreshness(gated, now, { refreshing: false, cooldownUntil: now + 15 * 60_000 }),
    ).toMatchObject({ refreshTooltip: "You can refresh again in 15m" });
  });
});
