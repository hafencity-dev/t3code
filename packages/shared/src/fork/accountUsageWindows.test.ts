// fork: gating-window selection for account headroom.
import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  accountGatingWindows,
  inactiveUsageStaleness,
  isModelScopedWeeklyWindow,
} from "./accountUsageWindows.ts";

const window = (
  id: string,
  kind: ServerProviderUsageWindow["kind"],
  usedPercent: number,
): ServerProviderUsageWindow => ({ id, kind, label: id, usedPercent });

describe("accountGatingWindows", () => {
  const session = window("five_hour", "session", 30);
  const weekly = window("seven_day", "weekly", 40);
  const fable = window("seven_day_fable", "weekly", 98);

  it("drops Claude model-scoped weeklies when the all-model weekly is reported", () => {
    expect(isModelScopedWeeklyWindow(fable)).toBe(true);
    expect(isModelScopedWeeklyWindow(weekly)).toBe(false);
    expect(accountGatingWindows([session, weekly, fable])).toEqual([session, weekly]);
  });

  it("keeps model-scoped weeklies when no all-model weekly exists", () => {
    expect(accountGatingWindows([session, fable])).toEqual([session, fable]);
  });

  it("keeps every Codex window", () => {
    const codex = [window("primary", "session", 10), window("secondary", "weekly", 90)];
    expect(accountGatingWindows(codex)).toEqual(codex);
  });
});

describe("inactiveUsageStaleness", () => {
  const minute = 60_000;
  const checkedAt = "2026-09-26T12:00:00.000Z";
  const at = (minutes: number) => Date.parse(checkedAt) + minutes * minute;
  const iso = (minutes: number) => new Date(at(minutes)).toISOString();
  const measured = (windows: ServerProviderUsageWindow[] = []) => ({ checkedAt, windows });

  it("keeps a measurement fresh for 30 minutes", () => {
    expect(inactiveUsageStaleness(measured(), at(29))).toEqual({ stale: false, staleAt: at(30) });
    expect(inactiveUsageStaleness(measured(), at(31))).toEqual({ stale: true, reason: "expired" });
  });

  it("is stale as soon as a gating window resets after the measurement", () => {
    const session = { ...window("five_hour", "session", 100), resetsAt: iso(10) };
    expect(inactiveUsageStaleness(measured([session]), at(9))).toEqual({
      stale: false,
      staleAt: at(10),
    });
    expect(inactiveUsageStaleness(measured([session]), at(10))).toEqual({
      stale: true,
      reason: "windowReset",
    });
    const weekly = { ...window("seven_day", "weekly", 100), resetsAt: iso(2) };
    expect(inactiveUsageStaleness(measured([weekly]), at(3))).toMatchObject({
      reason: "windowReset",
    });
  });

  it("ignores resets that were already past when measured and model-scoped weeklies", () => {
    const reported = { ...window("five_hour", "session", 0), resetsAt: iso(-60) };
    const fable = { ...window("seven_day_fable", "weekly", 100), resetsAt: iso(5) };
    const weekly = window("seven_day", "weekly", 40);
    expect(inactiveUsageStaleness(measured([reported, weekly, fable]), at(10))).toEqual({
      stale: false,
      staleAt: at(30),
    });
  });

  it("is stale when never measured", () => {
    expect(inactiveUsageStaleness(undefined, at(0))).toEqual({
      stale: true,
      reason: "neverMeasured",
    });
  });
});
