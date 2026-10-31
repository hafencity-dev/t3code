// fork: provider accounts
import { ServerProvider, type ServerProviderUsageLimits } from "@t3tools/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  carriesPreviousAccountWindows,
  makeClaudeHotSwitchUsageGuard,
  usageFingerprint,
} from "./ClaudeHotSwitchUsageGuard.ts";

const decodeProvider = Schema.decodeUnknownSync(ServerProvider);
const limits = (
  checkedAt: string,
  session: { used: number; resetsAt: string },
  weekly: { used: number; resetsAt: string },
): ServerProviderUsageLimits => ({
  checkedAt,
  windows: [
    {
      id: "five_hour",
      label: "Session",
      kind: "session",
      usedPercent: session.used,
      resetsAt: session.resetsAt,
    },
    {
      id: "seven_day",
      label: "Weekly",
      kind: "weekly",
      usedPercent: weekly.used,
      resetsAt: weekly.resetsAt,
    },
  ],
});
// Real values from the incident: probes round the reset slightly before the hour.
const previous = limits(
  "2026-09-27T11:20:58.180Z",
  { used: 100, resetsAt: "2026-09-27T13:59:59.904Z" },
  { used: 60, resetsAt: "2026-10-02T11:59:59.904Z" },
);
const stored = limits(
  "2026-09-27T11:21:02.000Z",
  { used: 86, resetsAt: "2026-09-27T14:30:00.207Z" },
  { used: 94, resetsAt: "2026-10-01T15:00:00.207Z" },
);
const snapshot = (input: {
  checkedAt: string;
  email: string;
  usage?: ServerProviderUsageLimits;
}): ServerProvider =>
  decodeProvider({
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated", email: input.email },
    checkedAt: input.checkedAt,
    models: [],
    ...(input.usage ? { usageLimits: input.usage } : {}),
  });
const switched = () => {
  const guard = makeClaudeHotSwitchUsageGuard();
  guard.switched({
    toAccountId: "b",
    toEmail: "b@example.test",
    toStored: stored,
    previous: [previous],
    now: Date.parse("2026-09-27T11:21:07.000Z"),
  });
  return guard;
};

describe("carriesPreviousAccountWindows", () => {
  it("matches a runtime event's rounded reset against the previous account's probe", () => {
    const event = limits(
      "2026-09-27T11:21:10.000Z",
      { used: 100, resetsAt: "2026-09-27T14:00:00.000Z" },
      { used: 60, resetsAt: "2026-10-02T12:00:00.000Z" },
    );
    expect(
      carriesPreviousAccountWindows(event, usageFingerprint(previous), usageFingerprint(stored)),
    ).toBe(true);
  });

  it("accepts windows that reset when both accounts' do", () => {
    const same = usageFingerprint(previous);
    expect(carriesPreviousAccountWindows(previous, same, same)).toBe(false);
  });
});

describe("makeClaudeHotSwitchUsageGuard", () => {
  it("finishes verification when a fresh probe confirms the account has no quota windows", () => {
    const checkedAt = "2026-09-27T11:21:09.000Z";
    expect(
      switched().resolve(
        "b",
        snapshot({
          checkedAt: "2026-09-27T11:21:07.100Z",
          email: "b@example.test",
          usage: {
            checkedAt,
            probeCheckedAt: checkedAt,
            windows: [],
            unavailable: { reason: "unsupported" },
          },
        }),
      ),
    ).toEqual({ live: true });
  });

  it.each([false, true])(
    "verifies a measured probe across clocks (session exempt: %s)",
    (sessionExempt) => {
      const guard = switched();
      const measuredAt = "2026-09-27T11:21:09.000Z";
      const usage: ServerProviderUsageLimits = {
        ...stored,
        checkedAt: measuredAt,
        probeCheckedAt: measuredAt,
        ...(sessionExempt
          ? {
              sessionLimit: "none",
              windows: stored.windows.filter((window) => window.kind !== "session"),
            }
          : {}),
      };
      expect(
        guard.resolve(
          "b",
          snapshot({
            checkedAt: "2026-09-27T11:21:07.100Z",
            email: "b@example.test",
            usage,
          }),
        ),
      ).toEqual({ live: true });
      expect(
        guard.resolve(
          "b",
          snapshot({
            checkedAt: "2026-09-27T11:25:00.000Z",
            email: "b@example.test",
            usage,
          }),
        ),
      ).toEqual({ live: true });
    },
  );

  it("does not verify retained usage from a failed probe or a later runtime update", () => {
    const measuredAt = "2026-09-27T11:21:09.000Z";
    for (const usage of [
      { ...stored, probeCheckedAt: measuredAt, unavailable: { reason: "probeFailed" as const } },
      {
        ...stored,
        sessionLimit: "none" as const,
        windows: stored.windows.filter((window) => window.kind !== "session"),
        probeCheckedAt: measuredAt,
        unavailable: { reason: "probeFailed" as const },
      },
      { ...stored, checkedAt: "2026-09-27T11:22:00.000Z", probeCheckedAt: measuredAt },
    ]) {
      expect(
        switched().resolve(
          "b",
          snapshot({
            checkedAt: "2026-09-27T11:21:07.100Z",
            email: "b@example.test",
            usage,
          }),
        ),
      ).toMatchObject({ live: false, reason: "unverified" });
    }
  });

  it("applies to nothing but the account switched to", () => {
    const guard = switched();
    expect(guard.resolve("a", undefined)).toEqual({ live: true });
    expect(makeClaudeHotSwitchUsageGuard().resolve("b", undefined)).toEqual({ live: true });
  });

  it("keeps the new account unverified while the probe retained the previous windows", () => {
    const guard = switched();
    // The post-switch probe lost its usage request: b's identity, the old checkedAt and windows.
    const retained = snapshot({
      checkedAt: "2026-09-27T11:21:07.414Z",
      email: "b@example.test",
      usage: previous,
    });
    expect(guard.resolve("b", retained)).toEqual({
      live: false,
      usage: undefined,
      reason: "unverified",
    });
    // A turn on the previous token patches the limits with a fresh stamp.
    const patched = snapshot({
      checkedAt: "2026-09-27T11:21:07.414Z",
      email: "b@example.test",
      usage: { ...previous, checkedAt: "2026-09-27T11:21:09.000Z" },
    });
    expect(guard.resolve("b", patched)).toMatchObject({ live: false, reason: "unverified" });
  });

  it("verifies on a probe that measured the new account, then accepts its own events", () => {
    const guard = switched();
    const own = limits(
      "2026-09-27T11:22:00.000Z",
      { used: 87, resetsAt: "2026-09-27T14:30:00.207Z" },
      { used: 94, resetsAt: "2026-10-01T15:00:00.207Z" },
    );
    expect(
      guard.resolve(
        "b",
        snapshot({ checkedAt: "2026-09-27T11:22:00.000Z", email: "b@example.test", usage: own }),
      ),
    ).toEqual({ live: true });
    const event = limits(
      "2026-09-27T11:23:00.000Z",
      { used: 90, resetsAt: "2026-09-27T14:30:00.000Z" },
      { used: 95, resetsAt: "2026-10-01T15:00:00.000Z" },
    );
    const patched = snapshot({
      checkedAt: "2026-09-27T11:22:00.000Z",
      email: "b@example.test",
      usage: event,
    });
    expect(guard.resolve("b", patched)).toEqual({ live: true });
    // A late event from the previous token is refused; the accepted numbers stay.
    const late = snapshot({
      checkedAt: "2026-09-27T11:22:00.000Z",
      email: "b@example.test",
      usage: { ...previous, checkedAt: "2026-09-27T11:24:00.000Z" },
    });
    expect(guard.resolve("b", late)).toEqual({
      live: false,
      usage: event,
      reason: "previousAccount",
    });
    // b's window rolls over to a reset nobody knew: accepted.
    const rolled = limits(
      "2026-09-27T14:31:00.000Z",
      { used: 1, resetsAt: "2026-09-27T19:30:00.000Z" },
      { used: 95, resetsAt: "2026-10-01T15:00:00.000Z" },
    );
    expect(
      guard.resolve(
        "b",
        snapshot({ checkedAt: "2026-09-27T11:22:00.000Z", email: "b@example.test", usage: rolled }),
      ),
    ).toEqual({ live: true });
  });

  it("does not verify or accept another workspace under the same email", () => {
    const guard = makeClaudeHotSwitchUsageGuard();
    guard.switched({
      toAccountId: "b",
      toEmail: "b@example.test",
      toWorkspaceId: "workspace-b",
      toStored: stored,
      previous: [previous],
      now: Date.parse(stored.checkedAt),
    });
    const at = "2026-09-27T11:22:00.000Z";
    const probe = snapshot({
      checkedAt: at,
      email: "b@example.test",
      usage: { ...stored, checkedAt: at, probeCheckedAt: at },
    });
    const foreign = { ...probe, auth: { ...probe.auth, workspaceId: "workspace-a" } };
    guard.observe(foreign);
    expect(guard.resolve("b", foreign)).toMatchObject({ live: false, reason: "unverified" });
    expect(
      guard.resolve("b", { ...probe, auth: { ...probe.auth, workspaceId: "workspace-b" } }),
    ).toEqual({ live: true });
    expect(guard.resolve("b", foreign)).toMatchObject({ live: false, reason: "unverified" });
  });

  it("never verifies on another identity's probe", () => {
    const guard = switched();
    const probe = snapshot({
      checkedAt: "2026-09-27T11:22:00.000Z",
      email: "a@example.test",
      usage: { ...stored, checkedAt: "2026-09-27T11:22:00.000Z" },
    });
    expect(guard.resolve("b", probe)).toMatchObject({ live: false, reason: "unverified" });
  });

  it("keeps earlier switches' windows until they reset", () => {
    const guard = switched();
    const c = limits(
      "2026-09-27T11:21:10.000Z",
      { used: 50, resetsAt: "2026-09-27T16:10:00.000Z" },
      { used: 30, resetsAt: "2026-09-30T07:00:00.000Z" },
    );
    guard.switched({
      toAccountId: "c",
      toEmail: "c@example.test",
      toStored: c,
      previous: [stored],
      now: Date.parse("2026-09-27T11:21:12.000Z"),
    });
    guard.resolve(
      "c",
      snapshot({
        checkedAt: "2026-09-27T11:22:00.000Z",
        email: "c@example.test",
        usage: { ...c, checkedAt: "2026-09-27T11:22:00.000Z" },
      }),
    );
    // A turn still on the first account's token, two switches later.
    const late = snapshot({
      checkedAt: "2026-09-27T11:22:00.000Z",
      email: "c@example.test",
      usage: { ...previous, checkedAt: "2026-09-27T11:25:00.000Z" },
    });
    expect(guard.resolve("c", late)).toMatchObject({ live: false, reason: "previousAccount" });
  });
});
