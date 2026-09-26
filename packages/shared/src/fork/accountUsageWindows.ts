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

/**
 * How long an inactive account's usage stays trustworthy. Its numbers only move when a window
 * resets, when it was just active (the live usage is kept on switch-away), when its window
 * primer sent a message, or when it is used on another device; a reset marks it stale at once.
 */
export const INACTIVE_USAGE_FRESH_MS = 30 * 60_000;

export type InactiveUsageStaleness =
  /** `staleAt` is when the age limit or the next gating reset makes it stale. */
  | { readonly stale: false; readonly staleAt: number }
  | { readonly stale: true; readonly reason: "neverMeasured" | "windowReset" | "expired" };

/**
 * The one staleness rule for inactive accounts, used by the server's probe gate, auto-switch,
 * and the account switcher's automatic refresh. Only a gating window (5-hour, all-model weekly)
 * that reset after the measurement counts; a reset already past when measured is what the
 * provider reported.
 */
export function inactiveUsageStaleness(
  usage:
    | {
        readonly checkedAt: string;
        readonly windows: ReadonlyArray<
          UsageWindowShape & { readonly resetsAt?: string | undefined }
        >;
      }
    | undefined,
  now: number,
): InactiveUsageStaleness {
  if (!usage) return { stale: true, reason: "neverMeasured" };
  const checkedAt = Date.parse(usage.checkedAt);
  if (!Number.isFinite(checkedAt)) return { stale: true, reason: "neverMeasured" };
  const resets = accountGatingWindows(usage.windows)
    .filter((window) => window.kind !== "other" && window.resetsAt !== undefined)
    .map((window) => Date.parse(window.resetsAt!))
    .filter((at) => at > checkedAt);
  if (resets.some((at) => at <= now)) return { stale: true, reason: "windowReset" };
  const staleAt = Math.min(checkedAt + INACTIVE_USAGE_FRESH_MS, ...resets);
  return now < staleAt ? { stale: false, staleAt } : { stale: true, reason: "expired" };
}
