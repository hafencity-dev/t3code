// fork: gating-window selection for account headroom.
import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { accountGatingWindows, isModelScopedWeeklyWindow } from "./accountUsageWindows.ts";

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
