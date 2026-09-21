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
import { memo, useEffect, useRef, useState } from "react";

import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { RefreshIcon } from "../ui/refresh-icon";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import { environmentPresentations } from "../../state/presentation";
import { getDriverOption } from "../settings/providerDriverMeta";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { barColor } from "../usage/UsageLimits";

/**
 * fork: compact sidebar limits reuse upstream snapshots and refresh deduplication.
 * Only an explicit refresh probes providers; the clock updates reset labels locally.
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
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex items-center justify-between gap-1 text-[11px] leading-4">
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
                style={{ width: `${window.remainingPercent}%` }}
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
      <div className="grid grid-cols-1 gap-y-1">
        {pool.windows.map((window) => (
          <PoolWindowRow key={`${window.kind}:${window.id}`} window={window} now={now} />
        ))}
      </div>
    </div>
  );
}

export const SidebarProviderUsage = memo(function SidebarProviderUsage() {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const [expanded, setExpanded] = useLocalStorage(EXPANDED_STORAGE_KEY, true, Schema.Boolean);
  const [selectedDevice, setSelectedDevice] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const refreshPending = useRef(false);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  const devices = [...presentations];
  const device = devices.some(([id]) => id === selectedDevice) ? selectedDevice : "";
  const selected = new Map(devices.filter(([id]) => !device || id === device));
  const connected = [...selected].filter(
    ([, presentation]) =>
      presentation.connection.phase === "connected" && presentation.serverConfig !== null,
  );
  const pools = collectLimitPools(collectLimitAccounts(selected), now);
  const refresh = async () => {
    if (refreshPending.current) return;
    refreshPending.current = true;
    setRefreshing(true);
    try {
      await Promise.allSettled(
        connected.map(([environmentId]) =>
          refreshUsageLimits(environmentId, () => refreshProviders({ environmentId, input: {} })),
        ),
      );
    } finally {
      setNow(Date.now());
      refreshPending.current = false;
      setRefreshing(false);
    }
  };
  if (devices.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5 px-2 py-1.5" data-sidebar-provider-usage>
      <div className="flex min-w-0 items-center gap-1">
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
        <span className="shrink-0 text-[10px] text-sidebar-foreground/50">left</span>
        <div className="min-w-0 flex-1" />
        {devices.length > 1 ? (
          <select
            aria-label="Usage device"
            value={device}
            onChange={(event) => setSelectedDevice(event.target.value)}
            className="h-6 min-w-0 max-w-[45%] truncate rounded-sm bg-sidebar text-[11px] text-sidebar-foreground/70 outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">All devices ({devices.length})</option>
            {devices.map(([id, presentation]) => (
              <option key={id} value={id}>
                {presentation.entry.target.label}
                {presentation.connection.phase === "connected" ? "" : " (offline)"}
              </option>
            ))}
          </select>
        ) : null}
        <button
          type="button"
          aria-label="Refresh usage"
          disabled={refreshing || connected.length === 0}
          onClick={() => void refresh()}
          className="flex size-6 shrink-0 items-center justify-center rounded-sm text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
        >
          <RefreshIcon className="size-3" refreshing={refreshing} />
        </button>
      </div>
      {expanded ? (
        <div className="flex flex-col gap-2">
          {connected.length < selected.size ? (
            <span className="text-[10px] text-sidebar-foreground/50">
              Offline devices show last known limits.
            </span>
          ) : null}
          {pools.length === 0 ? (
            <span className="text-[11px] text-sidebar-foreground/50">
              No usage limits available.
            </span>
          ) : null}
          {pools.map((pool) => (
            <PoolBlock key={pool.driver} pool={pool} now={now} />
          ))}
        </div>
      ) : null}
    </div>
  );
});
