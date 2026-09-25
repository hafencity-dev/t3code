// fork: account rotation scenarios use fixed time and no provider I/O.
import { ProviderAccountId, type ServerProviderUsageWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  chooseNextAccount,
  nextAutoSwitchAccountId,
  type AutoSwitchAccountView,
  type AutoSwitchDecision,
  type AutoSwitchInput,
} from "./autoSwitchPolicy.ts";

const minute = 60_000;
const hour = 60 * minute;
const now = Date.parse("2026-09-23T12:00:00Z");
const iso = (offset: number) => new Date(now + offset).toISOString();
const id = (name: string) => ProviderAccountId.make(name);
const window = (
  kind: ServerProviderUsageWindow["kind"],
  left: number,
  reset?: number,
): ServerProviderUsageWindow => ({
  id: kind,
  label: kind,
  kind,
  usedPercent: 100 - left,
  ...(reset === undefined ? {} : { resetsAt: iso(reset) }),
});
const account = (
  label: string,
  session = 80,
  weekly = 80,
  deadline = 72 * hour,
  extra: Partial<AutoSwitchAccountView> = {},
): AutoSwitchAccountView => ({
  id: id(label),
  label,
  status: "ready",
  loginInProgress: false,
  usage: {
    checkedAt: iso(0),
    windows: [window("session", session, 2 * hour), window("weekly", weekly, deadline)],
  },
  ...extra,
});
const personal = account("Personal");
const low = account("Personal", 8);
const work = account("Work", 60, 60, 48 * hour);
const stale = (value: AutoSwitchAccountView): AutoSwitchAccountView => ({
  ...value,
  usage: { ...value.usage!, checkedAt: iso(-6 * minute) },
});
const input = (overrides: Partial<AutoSwitchInput> = {}): AutoSwitchInput => ({
  now,
  config: { enabled: true, thresholdPercent: 10, weeklyThresholdPercent: 2 },
  active: low,
  candidates: [work],
  probed: new Set(),
  recentAutoSwitchAts: [],
  ...overrides,
});
const switchTo = (name: string, trigger = "session") => ({
  kind: "switch",
  targetAccountId: id(name),
  trigger,
});
const stay = (code: string, wakeAt?: number) => ({
  kind: "stay",
  code,
  ...(wakeAt === undefined ? {} : { wakeAt }),
});
const probe = (...names: string[]) => ({ kind: "probe", accountIds: names.map(id) });
const nearReset = (left: number) =>
  account("Personal", left, 80, 72 * hour, {
    usage: {
      checkedAt: iso(0),
      windows: [window("session", left, 10 * minute), window("weekly", 80, 72 * hour)],
    },
  });
const rolled = account("Work", 0, 60, 48 * hour, {
  usage: { checkedAt: iso(0), windows: [window("session", 0, 0), window("weekly", 60, 48 * hour)] },
});
const recent = [now - 40 * minute, now - 30 * minute, now - 20 * minute, now - 10 * minute];

const scenarios: ReadonlyArray<{ name: string; input: AutoSwitchInput; expected: object }> = [
  {
    name: "01 healthy account stays when no candidate resets more than an hour sooner",
    input: input({ active: personal, candidates: [account("Work", 60, 60, 71 * hour + minute)] }),
    expected: stay("healthy"),
  },
  {
    name: "02 earliest deadline beats more headroom",
    input: input({ candidates: [account("Later", 95, 95, 72 * hour), work] }),
    expected: switchTo("Work"),
  },
  {
    name: "03 stale preferred account is probed before fresh fallback",
    input: input({ candidates: [stale(work), account("Later", 90, 90)] }),
    expected: probe("Work"),
  },
  {
    name: "04 strict tier wins over earlier relaxed deadline",
    input: input({ candidates: [account("Relaxed", 18, 15, hour), work] }),
    expected: switchTo("Work"),
  },
  {
    name: "05 probes at most two candidates per evaluation",
    input: input({ candidates: [stale(account("A")), stale(account("B")), stale(account("C"))] }),
    expected: probe("A", "B"),
  },
  {
    name: "06 failed probe is skipped despite retained numbers and probed flag",
    input: input({
      candidates: [
        { ...work, usage: { ...work.usage!, unavailable: { reason: "probeFailed" } } },
        account("Later"),
      ],
      probed: new Set([work.id]),
    }),
    expected: switchTo("Later"),
  },
  {
    name: "07 soft session switches even when its reset is imminent",
    input: input({ active: nearReset(8) }),
    expected: switchTo("Work"),
  },
  {
    name: "08 hard exhaustion never waits for imminent reset",
    input: input({ active: nearReset(0) }),
    expected: switchTo("Work"),
  },
  {
    name: "09 weekly at the default 2% triggers replacement",
    input: input({ active: account("Personal", 80, 2) }),
    expected: switchTo("Work", "weekly"),
  },
  {
    name: "09b weekly at 3% with a healthy session stays",
    input: input({
      active: account("Personal", 80, 3),
      candidates: [account("Work", 60, 60, 72 * hour)],
    }),
    expected: stay("healthy"),
  },
  {
    name: "10 lowest model-scoped weekly controls eligibility",
    input: input({
      active: {
        ...personal,
        usage: {
          checkedAt: iso(0),
          windows: [
            ...personal.usage!.windows,
            { ...window("weekly", 2, 30 * hour), id: "model-weekly" },
          ],
        },
      },
    }),
    expected: switchTo("Work", "weekly"),
  },
  {
    name: "10b Claude model-scoped weekly never gates the account",
    input: input({
      active: {
        ...personal,
        usage: {
          checkedAt: iso(0),
          windows: [
            window("session", 80, 2 * hour),
            { ...window("weekly", 60, 72 * hour), id: "seven_day" },
            { ...window("weekly", 2, 30 * hour), id: "seven_day_fable" },
          ],
        },
      },
      candidates: [],
    }),
    expected: {
      kind: "stay",
      code: "healthy",
      reason: "Personal has 80% 5-hour and 60% weekly quota left; no switch needed.",
      // The Fable reset (30h) is not a deadline either; only the all-model weekly's is.
      wakeAt: now + 72 * hour + minute,
    },
  },
  {
    name: "10c a model-scoped weekly counts when no all-model weekly is reported",
    input: input({
      active: {
        ...personal,
        usage: {
          checkedAt: iso(0),
          windows: [
            window("session", 80, 2 * hour),
            { ...window("weekly", 2, 30 * hour), id: "seven_day_fable" },
          ],
        },
      },
    }),
    expected: switchTo("Work", "weekly"),
  },
  {
    name: "11 exhausted candidate wakes at latest blocking reset",
    input: input({
      active: account("Personal", 8, 2, 96 * hour),
      candidates: [account("Work", 0, 0, 4 * hour)],
    }),
    expected: stay("allExhausted", now + 4 * hour),
  },
  {
    name: "12 relaxed tier needs a ten-point session improvement",
    input: input({ candidates: [account("Work", 17, 15)] }),
    expected: stay("allExhausted", now + 2 * hour),
  },
  {
    name: "13 relaxed tier accepts exact ten-point improvement",
    input: input({ candidates: [account("Work", 18, 11)] }),
    expected: switchTo("Work"),
  },
  {
    name: "14 signed-out active switches without usage",
    input: input({ active: { ...personal, status: "signedOut", usage: undefined } }),
    expected: switchTo("Work", "signedOut"),
  },
  {
    name: "15 pending signed-out login and active candidates are excluded",
    input: input({
      candidates: [
        low,
        { ...work, status: "pending" },
        account("SignedOut", 80, 80, hour, { status: "signedOut" }),
        account("Login", 80, 80, hour, { loginInProgress: true }),
      ],
    }),
    expected: stay("noCandidates"),
  },
  {
    name: "16 rollover must be probed even with fresh checkedAt",
    input: input({ candidates: [rolled] }),
    expected: probe("Work"),
  },
  {
    name: "17 confirmed rollover is eligible",
    input: input({ candidates: [rolled], probed: new Set([work.id]) }),
    expected: switchTo("Work"),
  },
  {
    name: "18 missing long deadline sorts last",
    input: input({
      candidates: [
        account("UnknownReset", 95, 95, 0, {
          usage: { checkedAt: iso(0), windows: [window("session", 95), window("weekly", 95)] },
        }),
        work,
      ],
    }),
    expected: switchTo("Work"),
  },
  {
    name: "19 same hour deadline bucket prefers more weekly quota",
    input: input({
      candidates: [
        account("Earlier", 80, 40, 2 * hour + minute),
        account("Later", 80, 70, 2 * hour + 50 * minute),
      ],
    }),
    expected: switchTo("Later"),
  },
  {
    name: "20 proactively uses up quota that resets days sooner",
    input: input({
      active: account("Personal", 80, 80, 5 * 24 * hour),
      candidates: [account("Work", 60, 60, 3 * 24 * hour)],
    }),
    expected: switchTo("Work", "expiring"),
  },
  {
    name: "21 proactive target must have at least twenty percent long quota",
    input: input({
      config: { enabled: true, thresholdPercent: 5, weeklyThresholdPercent: 2 },
      active: personal,
      candidates: [account("Work", 60, 19, 9 * hour)],
    }),
    expected: stay("healthy"),
  },
  {
    name: "22 sooner-resetting candidate with a low session is picked after its session resets",
    input: input({
      active: account("Personal", 80, 80, 5 * 24 * hour),
      candidates: [account("Work", 15, 60, 3 * 24 * hour)],
    }),
    expected: stay("healthy", now + 2 * hour),
  },
  {
    name: "23 active expiring sooner is retained",
    input: input({
      active: account("Personal", 80, 80, 4 * hour),
      candidates: [account("Work", 60, 60, 9 * hour)],
    }),
    expected: stay("healthy"),
  },
  {
    name: "24 without a recent automatic switch, proactive rebalancing runs",
    input: input({ active: personal, candidates: [account("Work", 60, 60, 9 * hour)] }),
    expected: switchTo("Work", "expiring"),
  },
  {
    name: "25 proactive dwell lasts five minutes",
    input: input({
      active: personal,
      candidates: [account("Work", 60, 60, 9 * hour)],
      lastSwitchAt: now - 2 * minute,
    }),
    expected: stay("dwell", now + 3 * minute),
  },
  {
    name: "26 four switches trip the breaker for proactive switches until the oldest expires",
    input: input({
      active: personal,
      candidates: [account("Work", 60, 60, 9 * hour)],
      recentAutoSwitchAts: recent,
    }),
    expected: stay("circuitBreaker", now + 20 * minute),
  },
  {
    name: "27 hard exhaustion bypasses the breaker",
    input: input({ active: account("Personal", 0), recentAutoSwitchAts: recent }),
    expected: switchTo("Work"),
  },
  {
    name: "28 soft threshold switch bypasses the breaker",
    input: input({ recentAutoSwitchAts: recent }),
    expected: switchTo("Work"),
  },
  {
    name: "29 unknown active usage cannot cause proactive switching",
    input: input({
      active: { ...personal, usage: undefined },
      candidates: [account("Work", 60, 60, hour)],
    }),
    expected: stay("healthy"),
  },
  {
    name: "30 never-checked candidate is probed when replacement needed",
    input: input({ candidates: [{ ...work, usage: undefined }] }),
    expected: probe("Work"),
  },
  {
    name: "31 other windows do not exhaust account and reset credits do not redeem",
    input: input({
      active: {
        ...personal,
        usage: {
          ...personal.usage!,
          windows: [...personal.usage!.windows, window("other", 0, minute)],
          resetCredits: { availableCount: 3 },
        },
      },
      candidates: [account("Work", 60, 60, 96 * hour)],
    }),
    expected: stay("healthy"),
  },
  {
    name: "32 final tie uses account id deterministically",
    input: input({ candidates: [account("Z"), account("A")] }),
    expected: switchTo("A"),
  },
];

describe("chooseNextAccount 32-scenario policy table", () => {
  it.each(scenarios)("$name", ({ input: value, expected }) => {
    const before = structuredClone(value);
    const decision = chooseNextAccount(value);
    expect(decision).toMatchObject(expected);
    expect(decision.reason.trim().length).toBeGreaterThan(15);
    expect(decision.reason).toContain(value.active.label);
    expect(chooseNextAccount(value)).toEqual(decision);
    expect(chooseNextAccount({ ...value, candidates: value.candidates.toReversed() })).toEqual(
      decision,
    );
    expect(value).toEqual(before);
    expect(["manualHold", "waitingForReset"]).not.toContain(
      decision.kind === "stay" ? decision.code : undefined,
    );
  });

  it("explains a proactive switch by the sooner weekly reset", () => {
    const decision = chooseNextAccount(
      input({
        active: account("Personal", 80, 80, 5 * 24 * hour),
        candidates: [account("Work", 60, 60, 2 * 24 * hour)],
      }),
    );
    expect(decision).toMatchObject(switchTo("Work", "expiring"));
    expect(decision.reason).toBe(
      "Work's weekly limit resets in 2d, sooner than Personal's (5d). Using Work first so its quota doesn't expire unused.",
    );
  });

  it("keeps the proactive dwell and treats deadlines within an hour as equal", () => {
    const active = account("Personal", 80, 80, 5 * 24 * hour);
    const sooner = [account("Work", 60, 60, 3 * 24 * hour)];
    expect(
      chooseNextAccount(input({ active, candidates: sooner, lastSwitchAt: now - 2 * minute })),
    ).toMatchObject(stay("dwell", now + 3 * minute));
    const close = chooseNextAccount(
      input({ active, candidates: [account("Work", 60, 60, 5 * 24 * hour - 30 * minute)] }),
    );
    // It still wakes when the candidate's weekly reset moves its deadline.
    expect(close).toMatchObject(stay("healthy", now + 5 * 24 * hour - 29 * minute));
  });

  it("probes a stale sooner-resetting candidate before switching proactively", () => {
    expect(
      chooseNextAccount(
        input({
          active: account("Personal", 80, 80, 5 * 24 * hour),
          candidates: [stale(account("Work", 60, 60, 3 * 24 * hour))],
        }),
      ),
    ).toMatchObject(probe("Work"));
  });

  it("switches a just-selected low account at the threshold without holding it", () => {
    // A manual switch records only the new active account; nothing else reaches the policy.
    const selected = account("Personal", 5, 80);
    expect(
      chooseNextAccount(input({ active: selected, lastSwitchAt: now - minute })),
    ).toMatchObject(switchTo("Work"));
  });

  it("dwell after a recent switch blocks only proactive rebalancing", () => {
    const expiring = [account("Work", 60, 60, 9 * hour)];
    const lastSwitchAt = now - 2 * minute;
    const dwell = chooseNextAccount(
      input({ active: personal, candidates: expiring, lastSwitchAt }),
    );
    expect(dwell).toMatchObject(stay("dwell", now + 3 * minute));
    expect(dwell.reason).toBe("Keeping Personal for at least 5 minutes after the last switch.");
    expect(
      chooseNextAccount(input({ active: low, candidates: expiring, lastSwitchAt })),
    ).toMatchObject(switchTo("Work"));
  });

  it.each([
    { active: account("Personal", 80, 0), trigger: "weekly" },
    {
      active: { ...personal, status: "signedOut" as const, usage: undefined },
      trigger: "signedOut",
    },
    {
      active: { ...personal, usage: { checkedAt: iso(0), windows: [window("weekly", 2)] } },
      trigger: "weekly",
    },
  ])(
    "relaxed quota replaces hard, signed-out, or sessionless accounts: $trigger",
    ({ active, trigger }) => {
      expect(
        chooseNextAccount(input({ active, candidates: [account("Work", 15, 15)] })),
      ).toMatchObject(switchTo("Work", trigger));
    },
  );

  it("skips a gated preferred candidate even with fresh retained usage", () => {
    const preferred = account("Preferred", 80, 80, hour);
    expect(
      chooseNextAccount(
        input({
          candidates: [preferred, work],
          probeBlocked: new Set([preferred.id]),
        }),
      ),
    ).toMatchObject(switchTo("Work"));
    expect(
      chooseNextAccount(
        input({
          candidates: [preferred, stale(work)],
          probeBlocked: new Set([preferred.id]),
        }),
      ),
    ).toMatchObject(probe("Work"));
  });

  it("gated unknown usage cannot loop and wakes only for a needed candidate", () => {
    const gated = { ...work, usage: undefined };
    const gate = {
      candidates: [gated],
      probeBlocked: new Set([work.id]),
      probeWakeAt: new Map([[work.id, now + 15 * minute]]),
    };
    expect(chooseNextAccount(input(gate))).toMatchObject(stay("allExhausted", now + 15 * minute));
    // Healthy, the gated candidate's probe time is not a wake; only the active's weekly reset is.
    expect(chooseNextAccount(input({ ...gate, active: personal }))).toMatchObject(
      stay("healthy", now + 72 * hour + minute),
    );
    expect(
      chooseNextAccount(input({ ...gate, probeWakeAt: new Map([[work.id, now]]) })),
    ).toMatchObject(stay("allExhausted", now + 2 * hour));
    expect(chooseNextAccount(input({ ...gate, probeBlocked: new Set() }))).toMatchObject(
      probe("Work"),
    );
  });

  // S4: a weekly trigger doesn't require the replacement to beat the active's healthy session.
  it("replaces a weekly-exhausted account whose session is still high", () => {
    expect(
      chooseNextAccount(
        input({ active: account("Personal", 95, 2), candidates: [account("B", 15, 90)] }),
      ),
    ).toMatchObject(switchTo("B", "weekly"));
    // The session trigger keeps its ten-point improvement rule.
    expect(
      chooseNextAccount(
        input({ active: account("Personal", 8, 90), candidates: [account("B", 15, 90)] }),
      ),
    ).toMatchObject(stay("allExhausted"));
  });

  // S5: a healthy stay wakes when a weekly reset can change the proactive decision.
  it("wakes a healthy stay at the next weekly reset of the active or a candidate", () => {
    expect(
      chooseNextAccount(
        input({
          active: account("Personal", 80, 50, hour),
          candidates: [account("B", 80, 90, 90 * minute)],
        }),
      ),
    ).toMatchObject(stay("healthy", now + hour + minute));
    expect(
      chooseNextAccount(
        input({
          active: account("Personal", 80, 50, 3 * hour),
          candidates: [account("B", 80, 15, 2 * hour + 30 * minute)],
        }),
      ),
    ).toMatchObject(stay("healthy", now + 2 * hour + 31 * minute));
    expect(
      chooseNextAccount(
        input({
          active: account("Personal", 80, 50, 5 * hour),
          candidates: [account("B", 80, 15, 4 * hour)],
          probeBlocked: new Set([id("B")]),
        }),
      ),
    ).toMatchObject(stay("healthy", now + 5 * hour + minute));
  });

  // S6: a manual switch starts the proactive dwell, but never holds back a threshold switch.
  it("dwells after a manual switch for proactive rebalancing only", () => {
    const sooner = { active: personal, candidates: [account("Work", 60, 60, 9 * hour)] };
    expect(
      chooseNextAccount(input({ ...sooner, lastManualSwitchAt: now - 2 * minute })),
    ).toMatchObject(stay("dwell", now + 3 * minute));
    expect(
      chooseNextAccount(
        input({ ...sooner, lastSwitchAt: now - 10 * minute, lastManualSwitchAt: now - 2 * minute }),
      ),
    ).toMatchObject(stay("dwell", now + 3 * minute));
    expect(chooseNextAccount(input({ lastManualSwitchAt: now - minute }))).toMatchObject(
      switchTo("Work"),
    );
    expect(
      chooseNextAccount(input({ ...sooner, lastManualSwitchAt: now - 6 * minute })),
    ).toMatchObject(switchTo("Work", "expiring"));
  });

  it("never selects failed or unsupported probes and cannot loop on them", () => {
    for (const reason of ["probeFailed", "unsupported"] as const) {
      const candidate = { ...work, usage: { ...work.usage!, unavailable: { reason } } };
      expect(
        chooseNextAccount(input({ candidates: [candidate], probed: new Set([work.id]) })),
      ).toMatchObject(stay("allExhausted"));
    }
  });

  it("does not probe stale accounts ranked after an already fresh winner", () => {
    expect(chooseNextAccount(input({ candidates: [work, stale(account("Later"))] }))).toMatchObject(
      switchTo("Work"),
    );
  });

  it("respects exact freshness, horizon, dwell, and circuit-breaker boundaries", () => {
    const freshBoundary = { ...work, usage: { ...work.usage!, checkedAt: iso(-5 * minute) } };
    expect(chooseNextAccount(input({ candidates: [freshBoundary] }))).toMatchObject(
      switchTo("Work"),
    );
    expect(
      chooseNextAccount(
        input({
          active: personal,
          candidates: [account("Work", 60, 60, 24 * hour)],
          lastSwitchAt: now - 5 * minute,
        }),
      ),
    ).toMatchObject(switchTo("Work", "expiring"));
    expect(
      chooseNextAccount(
        input({
          active: personal,
          candidates: [account("Work", 60, 60, 9 * hour)],
          recentAutoSwitchAts: [now - hour, ...recent.slice(1)],
        }),
      ),
    ).toMatchObject(switchTo("Work", "expiring"));
  });

  it("hard long exhaustion switches even when session is only soft-low", () => {
    expect(
      chooseNextAccount(
        input({
          active: {
            ...nearReset(8),
            usage: {
              checkedAt: iso(0),
              windows: [window("session", 8, minute), window("monthly", 0, hour)],
            },
          },
        }),
      ),
    ).toMatchObject(switchTo("Work"));
  });

  it("does not invent a wake time when a blocking reset is unknown", () => {
    const unknownReset = account("Personal", 0, 0, 0, {
      usage: { checkedAt: iso(0), windows: [window("weekly", 0)] },
    });
    const decision = chooseNextAccount(
      input({
        active: unknownReset,
        candidates: [{ ...unknownReset, id: work.id, label: "Work" }],
      }),
    );
    expect(decision).toMatchObject(stay("allExhausted"));
    expect(decision).not.toHaveProperty("wakeAt");
  });

  it("disabled mode never probes or switches", () => {
    expect(
      chooseNextAccount(
        input({
          config: { enabled: false, thresholdPercent: 10, weeklyThresholdPercent: 2 },
          active: account("Personal", 0),
          candidates: [stale(work)],
        }),
      ),
    ).toMatchObject(stay("healthy"));
  });

  it("exports a discriminated decision union", () => {
    const decision: AutoSwitchDecision = chooseNextAccount(input());
    if (decision.kind === "switch") expect(decision.targetAccountId).toBe(work.id);
    else throw new Error("Expected replacement account");
  });
});

describe("separate 5-hour and weekly thresholds", () => {
  const thresholds = (thresholdPercent: number, weeklyThresholdPercent: number) => ({
    enabled: true,
    thresholdPercent,
    weeklyThresholdPercent,
  });

  it("switches at the weekly threshold and explains it by the target's weekly reset", () => {
    const decision = chooseNextAccount(
      input({
        active: account("Work", 90, 2, 5 * 24 * hour),
        candidates: [account("Personal", 80, 64, 72 * hour)],
      }),
    );
    expect(decision).toMatchObject(switchTo("Personal", "weekly"));
    expect(decision.reason).toBe(
      "Work has 2% of its weekly limit left; switching to Personal (weekly resets in 3d, 64% left).",
    );
    const session = chooseNextAccount(input());
    expect(session.reason).toBe(
      "Personal has 8% of its 5-hour limit left; switching to Work (5-hour 60% left; weekly resets in 2d, 60% left).",
    );
  });

  it("uses each threshold only for its own window", () => {
    // Work resets later than the active account, so no proactive switch muddies the result.
    const candidates = [account("Work", 80, 80, 120 * hour)];
    const decide = (session: number, weekly: number, config: AutoSwitchInput["config"]) =>
      chooseNextAccount(
        input({ config, active: account("Personal", session, weekly, 96 * hour), candidates }),
      );
    expect(decide(80, 5, thresholds(10, 5))).toMatchObject(switchTo("Work", "weekly"));
    expect(decide(80, 6, thresholds(10, 5))).toMatchObject(stay("healthy"));
    // The weekly threshold never applies to the 5-hour window, nor the reverse.
    expect(decide(8, 50, thresholds(10, 5))).toMatchObject(switchTo("Work", "session"));
    expect(decide(15, 50, thresholds(20, 2))).toMatchObject(switchTo("Work", "session"));
    expect(decide(80, 15, thresholds(20, 2))).toMatchObject(stay("healthy"));
  });

  it("still switches on a hard 0% below a lower threshold", () => {
    const candidates = [account("Work", 80, 80, 72 * hour)];
    expect(
      chooseNextAccount(
        input({ config: thresholds(5, 1), active: account("Personal", 80, 0), candidates }),
      ),
    ).toMatchObject(switchTo("Work", "weekly"));
    expect(
      chooseNextAccount(
        input({ config: thresholds(5, 1), active: account("Personal", 0, 80), candidates }),
      ),
    ).toMatchObject(switchTo("Work", "session"));
  });

  it("keeps a nearly spent weekly out of the strict tier", () => {
    const active = account("Personal", 90, 2, 5 * 24 * hour);
    const nearlySpent = account("Spent", 90, 3, 24 * hour);
    const healthy = account("Work", 90, 40, 72 * hour);
    // 3% is below 2% + the 10-point margin, so the later-resetting healthy account wins.
    expect(chooseNextAccount(input({ active, candidates: [nearlySpent, healthy] }))).toMatchObject(
      switchTo("Work", "weekly"),
    );
    // Alone, it is still better than running out: the relaxed tier only needs more than 2%.
    expect(chooseNextAccount(input({ active, candidates: [nearlySpent] }))).toMatchObject(
      switchTo("Spent", "weekly"),
    );
    expect(
      chooseNextAccount(input({ active, candidates: [account("Out", 90, 2, 24 * hour)] })),
    ).toMatchObject(stay("allExhausted"));
  });

  it("never switches to a duplicate of another saved login", () => {
    expect(
      chooseNextAccount(
        input({
          candidates: [{ ...account("Copy", 90, 90, hour), duplicateOf: id("Personal") }, work],
        }),
      ),
    ).toMatchObject(switchTo("Work"));
  });
});

describe("nextAutoSwitchAccountId", () => {
  const config = { thresholdPercent: 10, weeklyThresholdPercent: 2 };
  const next = (accounts: AutoSwitchAccountView[], activeAccountId = accounts[0]!.id) =>
    nextAutoSwitchAccountId({ now, config, activeAccountId, accounts });

  it("picks the earliest weekly reset with enough left, not the most headroom", () => {
    const day = 24 * hour;
    expect(
      next([
        account("hauke", 93, 11, 2 * day + 21 * hour),
        account("marius.gill", 88, 53, 6 * day),
        account("claude2", 100, 19, 4 * day + 13 * hour),
        account("marius", 100, 0, hour + 48 * minute),
      ]),
    ).toBe(id("claude2"));
  });

  it("never picks an exhausted, signed-out, signing-in, duplicate, or unmeasured account", () => {
    const active = account("Active", 50, 50);
    expect(next([active, account("Out", 100, 0, hour)])).toBeUndefined();
    expect(next([active, account("Low", 100, 11, hour)])).toBeUndefined();
    expect(
      next([
        active,
        { ...account("SignedOut", 90, 90, hour), status: "signedOut" },
        { ...account("SigningIn", 90, 90, hour), loginInProgress: true },
        { ...account("Copy", 90, 90, hour), duplicateOf: active.id },
        { ...account("Unknown"), usage: undefined },
      ]),
    ).toBeUndefined();
    expect(next([active])).toBeUndefined();
    expect(
      nextAutoSwitchAccountId({ now, config, activeAccountId: undefined, accounts: [work] }),
    ).toBeUndefined();
  });

  it("breaks a deadline tie by weekly, then 5-hour quota left, then id", () => {
    const active = account("Active", 50, 50);
    expect(
      next([active, account("A", 90, 40, 48 * hour), account("B", 30, 60, 48 * hour + minute)]),
    ).toBe(id("B"));
    expect(next([active, account("A", 40, 60, 48 * hour), account("B", 90, 60, 48 * hour)])).toBe(
      id("B"),
    );
    expect(next([active, account("B", 60, 60, 48 * hour), account("A", 60, 60, 48 * hour)])).toBe(
      id("A"),
    );
  });

  it("matches the account a threshold switch moves to", () => {
    const active = account("Personal", 8, 50, 96 * hour);
    const candidates = [account("Later", 95, 95, 72 * hour), work, account("Spent", 90, 5, hour)];
    const decision = chooseNextAccount(input({ active, candidates }));
    expect(decision).toMatchObject(switchTo("Work"));
    expect(next([active, ...candidates])).toBe(id("Work"));
  });
});

describe("accounts excluded from auto-switch", () => {
  const config = { thresholdPercent: 10, weeklyThresholdPercent: 2 };
  const excluded = (value: AutoSwitchAccountView): AutoSwitchAccountView => ({
    ...value,
    autoSwitchExcluded: true,
  });

  it("skips an excluded healthy account even when it resets first", () => {
    const soonest = excluded(account("Soonest", 95, 90, 24 * hour));
    const decision = chooseNextAccount(input({ candidates: [soonest, work] }));
    expect(decision).toMatchObject(switchTo("Work"));
    expect(
      nextAutoSwitchAccountId({
        now,
        config,
        activeAccountId: low.id,
        accounts: [low, soonest, work],
      }),
    ).toBe(id("Work"));
  });

  it("stays when every other account is excluded, and says why", () => {
    const decision = chooseNextAccount(
      input({ candidates: [excluded(work), excluded(account("Later"))] }),
    );
    expect(decision).toEqual({
      kind: "stay",
      code: "noCandidates",
      reason: "No other account is available for auto-switch.",
    });
  });

  it("still moves away from an excluded active account", () => {
    const decision = chooseNextAccount(input({ active: excluded(low), candidates: [work] }));
    expect(decision).toMatchObject(switchTo("Work"));
    // Proactively too, when another account's weekly quota resets sooner.
    const healthy = excluded(account("Personal", 80, 80, 96 * hour));
    expect(chooseNextAccount(input({ active: healthy, candidates: [work] }))).toMatchObject(
      switchTo("Work", "expiring"),
    );
  });

  it("never names an excluded account as the next one", () => {
    const active = account("Active", 50, 50);
    expect(
      nextAutoSwitchAccountId({
        now,
        config,
        activeAccountId: active.id,
        accounts: [active, excluded(work)],
      }),
    ).toBeUndefined();
  });

  it("summarizes a switch in one short line", () => {
    const weeklyLow = account("Personal", 80, 2, 96 * hour);
    const decision = chooseNextAccount(
      input({
        active: weeklyLow,
        candidates: [account("Work", 60, 60, 4 * 24 * hour + 13 * hour)],
      }),
    );
    expect(decision).toMatchObject({
      kind: "switch",
      trigger: "weekly",
      summary: "Weekly limit at 2% · Work resets in 4d 13h",
    });
  });
});
