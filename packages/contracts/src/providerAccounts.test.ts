import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import { ProviderAccountsSetAutoSwitchInput } from "./providerAccounts.ts";

describe("ProviderAccountsSetAutoSwitchInput", () => {
  const decode = Schema.decodeUnknownExit(ProviderAccountsSetAutoSwitchInput);
  const input = (fields: Record<string, unknown>) =>
    decode({ driver: "codex", enabled: true, ...fields });

  it("keeps the weekly threshold between 1% and 25%", () => {
    expect(input({})._tag).toBe("Success");
    for (const weeklyThresholdPercent of [1, 2, 25]) {
      expect(input({ weeklyThresholdPercent })._tag).toBe("Success");
    }
    for (const weeklyThresholdPercent of [0, 26, 2.5]) {
      expect(input({ weeklyThresholdPercent })._tag).toBe("Failure");
    }
  });

  it("keeps the 5-hour threshold between 5% and 50%", () => {
    for (const thresholdPercent of [5, 50]) {
      expect(input({ thresholdPercent })._tag).toBe("Success");
    }
    for (const thresholdPercent of [4, 51]) {
      expect(input({ thresholdPercent })._tag).toBe("Failure");
    }
  });
});
