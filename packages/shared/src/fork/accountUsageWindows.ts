// fork: which usage windows decide an account's headroom, shared by the account switcher
// (web) and the auto-switch policy and window primer (server).
import type { ServerProviderUsageWindow } from "@t3tools/contracts";

type UsageWindowShape = Pick<ServerProviderUsageWindow, "id" | "kind">;

/** Claude's all-model weekly limit. */
export const PRIMARY_WEEKLY_WINDOW_ID = "seven_day";
const MODEL_SCOPED_WEEKLY_PREFIX = `${PRIMARY_WEEKLY_WINDOW_ID}_`;

/**
 * A Claude weekly limit for one model (`seven_day_fable`, `seven_day_overage_included`).
 * Other providers never use these ids, so their weeklies always count as primary.
 */
export function isModelScopedWeeklyWindow(window: UsageWindowShape) {
  return window.kind === "weekly" && window.id.startsWith(MODEL_SCOPED_WEEKLY_PREFIX);
}

/**
 * The windows that gate the whole account. Claude hard-blocks a model only for that
 * model's requests, so its model-scoped weeklies are dropped whenever the all-model weekly
 * is reported. Without it they stay, so the account never reads as unmeasured.
 */
export function accountGatingWindows<W extends UsageWindowShape>(windows: readonly W[]): W[] {
  const hasPrimaryWeekly = windows.some(
    (window) => window.kind === "weekly" && window.id === PRIMARY_WEEKLY_WINDOW_ID,
  );
  return hasPrimaryWeekly
    ? windows.filter((window) => !isModelScopedWeeklyWindow(window))
    : [...windows];
}
