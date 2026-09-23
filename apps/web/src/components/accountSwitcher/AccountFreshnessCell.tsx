import { TriangleAlertIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { AccountFreshness } from "./accounts.logic";

/** The `Checked` column: the per-row refresh button, always present, and one line of state. */
export function AccountFreshnessCell({
  freshness,
  label,
  onRefresh,
}: {
  freshness: AccountFreshness;
  label: string;
  onRefresh: () => void;
}) {
  const button = (
    <Button
      variant="ghost-muted"
      size="icon-xs"
      aria-label={`${freshness.refreshTooltip} for ${label}`}
      disabled={!freshness.canRefresh}
      onClick={onRefresh}
    >
      <RefreshIcon refreshing={freshness.refreshing} />
    </Button>
  );
  const text = (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1 text-xs",
        freshness.tone === "warning" ? "text-warning-foreground" : "text-muted-foreground",
      )}
    >
      {freshness.icon === "alert" ? (
        <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
      ) : null}
      <span className="truncate @max-[44rem]/accounts:hidden">{freshness.text}</span>
      <span className="hidden truncate @max-[44rem]/accounts:inline">{freshness.narrowText}</span>
    </span>
  );
  return (
    <div className="flex min-w-0 items-center gap-1">
      <Tooltip>
        {/* A disabled button can't take focus; the wrapper keeps its reason reachable. */}
        <TooltipTrigger
          render={
            <span className="inline-flex" {...(freshness.canRefresh ? {} : { tabIndex: 0 })} />
          }
        >
          {button}
        </TooltipTrigger>
        <TooltipPopup>{freshness.refreshTooltip}</TooltipPopup>
      </Tooltip>
      {freshness.tooltip ? (
        <Tooltip>
          <TooltipTrigger render={text} />
          <TooltipPopup>{freshness.tooltip}</TooltipPopup>
        </Tooltip>
      ) : (
        text
      )}
    </div>
  );
}
