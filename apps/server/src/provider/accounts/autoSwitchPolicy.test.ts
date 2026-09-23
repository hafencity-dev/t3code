// fork: account rotation scenarios use fixed time and no provider I/O.
import { ProviderAccountId, type ServerProviderUsageWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  activeBelowThreshold,
  chooseNextAccount,
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
  config: { enabled: true, thresholdPercent: 10 },
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
const manual = { at: now - minute, holdUntil: now + 119 * minute, activeWasBelowThreshold: false };

const scenarios: ReadonlyArray<{ name: string; input: AutoSwitchInput; expected: object }> = [
  {
    name: "01 healthy account stays",
    input: input({ active: personal }),
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
    name: "07 soft session waits for imminent reset",
    input: input({ active: nearReset(8) }),
    expected: stay("waitingForReset", now + 10 * minute),
  },
  {
    name: "08 hard exhaustion never waits for imminent reset",
    input: input({ active: nearReset(0) }),
    expected: switchTo("Work"),
  },
  {
    name: "09 weekly exhaustion triggers replacement",
    input: input({ active: account("Personal", 80, 8) }),
    expected: switchTo("Work", "weekly"),
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
            { ...window("weekly", 5, 30 * hour), id: "model-weekly" },
          ],
        },
      },
    }),
    expected: switchTo("Work", "weekly"),
  },
  {
    name: "11 exhausted candidate wakes at latest blocking reset",
    input: input({
      active: account("Personal", 8, 8, 96 * hour),
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
    name: "20 proactively consumes quota expiring within 24 hours",
    input: input({ active: personal, candidates: [account("Work", 60, 60, 9 * hour)] }),
    expected: switchTo("Work", "expiring"),
  },
  {
    name: "21 proactive target must have at least twenty percent long quota",
    input: input({
      config: { enabled: true, thresholdPercent: 5 },
      active: personal,
      candidates: [account("Work", 60, 19, 9 * hour)],
    }),
    expected: stay("healthy"),
  },
  {
    name: "22 healthy evaluation wakes when candidate enters horizon",
    input: input({ active: personal, candidates: [account("Work", 60, 60, 30 * hour)] }),
    expected: stay("healthy", now + 6 * hour),
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
    name: "24 manual hold suppresses proactive switch",
    input: input({ active: personal, candidates: [account("Work", 60, 60, 9 * hour)], manual }),
    expected: stay("manualHold", manual.holdUntil),
  },
  {
    name: "25 proactive dwell lasts thirty minutes",
    input: input({
      active: personal,
      candidates: [account("Work", 60, 60, 9 * hour)],
      lastSwitchAt: now - 10 * minute,
    }),
    expected: stay("dwell", now + 20 * minute),
  },
  {
    name: "26 four switches trip breaker until oldest expires",
    input: input({ recentAutoSwitchAts: recent }),
    expected: stay("circuitBreaker", now + 20 * minute),
  },
  {
    name: "27 hard exhaustion bypasses breaker and manual hold",
    input: input({ active: account("Personal", 0), recentAutoSwitchAts: recent, manual }),
    expected: switchTo("Work"),
  },
  {
    name: "28 manually selected low account suppresses soft trigger",
    input: input({ manual: { ...manual, activeWasBelowThreshold: true } }),
    expected: stay("manualHold", manual.holdUntil),
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
  });

  it("expires suppression for a manually selected low account at the hold boundary", () => {
    expect(
      chooseNextAccount(
        input({
          manual: {
            ...manual,
            activeWasBelowThreshold: true,
            holdUntil: now,
          },
        }),
      ),
    ).toMatchObject(switchTo("Work"));
  });

  it.each([
    { active: account("Personal", 80, 0), trigger: "weekly" },
    {
      active: { ...personal, status: "signedOut" as const, usage: undefined },
      trigger: "signedOut",
    },
    {
      active: { ...personal, usage: { checkedAt: iso(0), windows: [window("weekly", 8)] } },
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
    expect(chooseNextAccount(input({ ...gate, active: personal }))).toMatchObject(stay("healthy"));
    expect(chooseNextAccount(input({ ...gate, active: personal }))).not.toHaveProperty("wakeAt");
    expect(
      chooseNextAccount(input({ ...gate, probeWakeAt: new Map([[work.id, now]]) })),
    ).toMatchObject(stay("allExhausted", now + 2 * hour));
    expect(chooseNextAccount(input({ ...gate, probeBlocked: new Set() }))).toMatchObject(
      probe("Work"),
    );
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
          lastSwitchAt: now - 30 * minute,
          manual: { ...manual, holdUntil: now },
        }),
      ),
    ).toMatchObject(switchTo("Work", "expiring"));
    expect(
      chooseNextAccount(input({ recentAutoSwitchAts: [now - hour, ...recent.slice(1)] })),
    ).toMatchObject(switchTo("Work"));
  });

  it("hard long exhaustion bypasses waiting even when session is only soft-low", () => {
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
          config: { enabled: false, thresholdPercent: 10 },
          active: account("Personal", 0),
          candidates: [stale(work)],
        }),
      ),
    ).toMatchObject(stay("healthy"));
  });

  it("manual selection helper shares model, unsupported and rollover normalization", () => {
    expect(activeBelowThreshold(low, now, 10)).toBe(true);
    expect(activeBelowThreshold(rolled, now, 10)).toBe(false);
    expect(
      activeBelowThreshold(
        { ...low, usage: { ...low.usage!, unavailable: { reason: "unsupported" } } },
        now,
        10,
      ),
    ).toBe(false);
  });

  it("exports a discriminated decision union", () => {
    const decision: AutoSwitchDecision = chooseNextAccount(input());
    if (decision.kind === "switch") expect(decision.targetAccountId).toBe(work.id);
    else throw new Error("Expected replacement account");
  });
});
