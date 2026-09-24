import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { formatResetsIn } from "@t3tools/shared/usageLimits";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { accountUsageCellView, type UsageCellKind } from "./accounts.logic";

const CELL_LABELS = { session: "5-hour", weekly: "Weekly" } as const;

const VALUE_TONE = {
  error: "text-destructive-foreground",
  warning: "text-warning-foreground",
  default: "text-foreground",
} as const;
const BAR_TONE = {
  error: "bg-destructive",
  warning: "bg-warning",
  default: "bg-foreground/55",
} as const;

/** One usage column: the tightest window of its kind, with every window of that kind on hover. */
export function AccountUsageCell({
  kind,
  windows,
  now,
}: {
  kind: UsageCellKind;
  windows: readonly ServerProviderUsageWindow[];
  now: number;
}) {
  const { all, remaining, reset, resetPending, tone } = accountUsageCellView(windows, kind, now);
  const label = CELL_LABELS[kind];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div className="grid min-w-0 gap-1.5">
            <div className="flex min-w-0 items-baseline gap-2 text-xs tabular-nums">
              {/* Visible only in the narrow layout, where there is no column header. */}
              <span className="sr-only text-muted-foreground @max-[44rem]/accounts:not-sr-only">
                {label}
              </span>
              {remaining === null ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                <span className={cn("font-medium", VALUE_TONE[tone])}>{remaining}% left</span>
              )}
              {reset ? (
                <span className="ml-auto truncate text-muted-foreground">{reset}</span>
              ) : null}
            </div>
            <div
              role="progressbar"
              aria-label={
                resetPending
                  ? `${label} limit: reset, checking again`
                  : remaining === null
                    ? `${label} limit: not reported`
                    : `${label} limit: ${remaining}% left${reset ? `, resets ${reset}` : ""}`
              }
              aria-valuemin={0}
              aria-valuemax={100}
              {...(remaining === null ? {} : { "aria-valuenow": remaining })}
              className="h-1 overflow-hidden rounded-full bg-foreground/10"
            >
              {remaining === null ? null : (
                <div
                  className={cn("h-full rounded-full", BAR_TONE[tone])}
                  style={{ width: `${remaining}%` }}
                />
              )}
            </div>
          </div>
        }
      />
      <TooltipPopup>
        {all.length === 0 ? (
          `No ${kind === "session" ? "5-hour" : "weekly"} limit reported`
        ) : (
          <div className="grid gap-0.5">
            {all.map((window) => {
              const resets = formatResetsIn(window, now);
              return (
                <span key={window.id}>
                  {window.label}: {Math.round(100 - window.usedPercent)}% left
                  {resets ? `, ${resets}` : ""}
                </span>
              );
            })}
          </div>
        )}
      </TooltipPopup>
    </Tooltip>
  );
}
