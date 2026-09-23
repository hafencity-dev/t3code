import type { ProviderAccount, ServerProviderUsageWindow } from "@t3tools/contracts";
import { formatResetsIn } from "@t3tools/shared/usageLimits";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { accountUsageDisplay } from "./accounts.logic";

function UsageBar({ window, now }: { window: ServerProviderUsageWindow; now: number }) {
  const remaining = Math.round(100 - window.usedPercent);
  const resets = formatResetsIn(window, now);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div className="grid gap-1">
            <div className="flex justify-between gap-2 text-xs">
              <span>{window.label}</span>
              <span className="tabular-nums">{remaining}%</span>
            </div>
            <div
              role="progressbar"
              aria-label={`${window.label}: ${remaining}% left`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={remaining}
              className="h-1 overflow-hidden rounded-full bg-foreground/10"
            >
              <div
                className={`h-full rounded-full ${remaining <= 10 ? "bg-destructive" : remaining <= 25 ? "bg-warning" : "bg-foreground/55"}`}
                style={{ width: `${remaining}%` }}
              />
            </div>
          </div>
        }
      />
      <TooltipPopup>
        {window.label}: {remaining}% left{resets ? `, ${resets}` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}

export function AccountUsage({ account, now }: { account: ProviderAccount; now: number }) {
  const { windows, checkedLabel, retryLabel } = accountUsageDisplay(account, now);
  return (
    <div className="grid gap-1.5">
      {windows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {account.usage ? "Usage unavailable" : "Not checked yet"}
        </p>
      ) : null}
      {windows.map((window) => (
        <UsageBar key={window.id} window={window} now={now} />
      ))}
      {windows.length > 0 ? (
        <p className="text-[10px] text-muted-foreground">
          {windows
            .flatMap((window) => {
              const resets = formatResetsIn(window, now);
              return resets ? [`${window.label} ${resets}`] : [];
            })
            .join(" · ")}
        </p>
      ) : null}
      {checkedLabel ? <p className="text-[10px] text-muted-foreground">{checkedLabel}</p> : null}
      {retryLabel ? <p className="text-[10px] text-muted-foreground">{retryLabel}</p> : null}
    </div>
  );
}
