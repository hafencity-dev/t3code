import { useAtomValue } from "@effect/atom-react";
import {
  collectLimitAccounts,
  collectLimitPools,
  formatResetsIn,
  type LimitPool,
  type LimitPoolWindow,
} from "@t3tools/shared/usageLimits";
import { ChevronRightIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { memo, useEffect, useState } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import { environmentPresentations } from "../../state/presentation";
import { getDriverOption } from "../settings/providerDriverMeta";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { barColor } from "../usage/UsageLimits";

/**
 * fork: sidebar usage stats — a compact, always-visible read of the pooled
 * subscription limits upstream already collects for the Usage page. Nothing
 * here fetches on its own: it renders whatever the provider snapshots and usage
 * limit sources have reported, so the sidebar never adds probe traffic.
 */

const EXPANDED_STORAGE_KEY = "t3code:sidebar-provider-usage-expanded";
const CLOCK_INTERVAL_MS = 60_000;

function toneClassName(remainingPercent: number): string {
  if (remainingPercent <= 10) return "bg-destructive";
  if (remainingPercent <= 25) return "bg-warning";
  return "bg-sidebar-foreground/55";
}

function firstResetLabel(window: LimitPoolWindow, now: number): string | null {
  for (const column of window.columns) {
    if (column.window) {
      const label = formatResetsIn(column.window, now);
      if (label) return label;
    }
  }
  return null;
}

function PoolWindowRow({
  window,
  now,
}: {
  readonly window: LimitPoolWindow;
  readonly now: number;
}) {
  const resets = firstResetLabel(window, now);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center justify-between gap-2 text-[11px] leading-4">
              <span className="truncate text-sidebar-foreground/70">{window.label}</span>
              <span className="shrink-0 font-medium tabular-nums">{window.remainingPercent}%</span>
            </div>
            <div
              role="progressbar"
              aria-label={`${window.label}: ${window.remainingPercent}% left`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={window.remainingPercent}
              className="h-1 w-full overflow-hidden rounded-full bg-sidebar-foreground/10"
            >
              <div
                className={cn("h-full rounded-full", toneClassName(window.remainingPercent))}
                style={{ width: `${Math.max(2, window.remainingPercent)}%` }}
              />
            </div>
          </div>
        }
      />
      <TooltipPopup side="right">
        {window.label}: {window.remainingPercent}% left{resets ? `, ${resets}` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}

function PoolBlock({ pool, now }: { readonly pool: LimitPool; readonly now: number }) {
  const label = getDriverOption(pool.driver)?.label ?? String(pool.driver);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5 text-[11px] leading-4 font-medium text-sidebar-foreground/80">
        <span className={cn("size-1.5 shrink-0 rounded-full", barColor(pool.driver))} />
        <span className="truncate">{label}</span>
        {pool.accounts.length > 1 ? (
          <span className="shrink-0 text-sidebar-foreground/50">×{pool.accounts.length}</span>
        ) : null}
      </div>
      {pool.windows.map((window) => (
        <PoolWindowRow key={`${window.kind}:${window.id}`} window={window} now={now} />
      ))}
    </div>
  );
}

export const SidebarProviderUsage = memo(function SidebarProviderUsage() {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const [expanded, setExpanded] = useLocalStorage(EXPANDED_STORAGE_KEY, true, Schema.Boolean);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  const pools = collectLimitPools(collectLimitAccounts(presentations), now);
  if (pools.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5 px-2 py-1.5" data-sidebar-provider-usage>
      <button
        type="button"
        aria-expanded={expanded}
        className="flex items-center gap-1 rounded-sm text-[11px] leading-4 font-medium text-sidebar-foreground/60 outline-hidden hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setExpanded(!expanded)}
      >
        <ChevronRightIcon
          className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-90")}
        />
        Usage
      </button>
      {expanded ? (
        <div className="flex flex-col gap-2">
          {pools.map((pool) => (
            <PoolBlock key={pool.driver} pool={pool} now={now} />
          ))}
        </div>
      ) : null}
    </div>
  );
});
