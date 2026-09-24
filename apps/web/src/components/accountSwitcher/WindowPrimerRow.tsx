import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProviderAccount,
  ProviderAccountWindowPrimer,
} from "@t3tools/contracts";
import { useId, useRef, useState } from "react";
import { useAtomCommand } from "../../state/use-atom-command";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { windowPrimerStatus } from "./accounts.logic";
import { providerAccountsEnvironment } from "./state";

/** Claude only: the window-start toggle and one muted status line, below auto-switch. */
export function WindowPrimerRow({
  primer,
  accounts,
  environmentId,
  now,
}: {
  primer: ProviderAccountWindowPrimer;
  accounts: readonly ProviderAccount[];
  environmentId: EnvironmentId;
  now: number;
}) {
  const labelId = useId();
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const setWindowPrimer = useAtomCommand(providerAccountsEnvironment.setWindowPrimer, {
    reportFailure: false,
  });
  const update = async (enabled: boolean) => {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    try {
      const result = await setWindowPrimer({
        environmentId,
        input: { driver: "claudeAgent", enabled },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Couldn't update 5-hour window starts",
          description: error instanceof Error ? error.message : "Please try again.",
        });
      }
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  const status = windowPrimerStatus(primer, accounts, now);
  return (
    <>
      <div className="flex min-h-6 min-w-0 items-center gap-2 text-xs">
        <Switch
          size="sm"
          checked={primer.enabled}
          disabled={saving}
          aria-labelledby={labelId}
          onCheckedChange={(enabled) => void update(enabled)}
        />
        <Tooltip>
          <TooltipTrigger render={<span id={labelId} className="truncate font-medium" />}>
            Start 5-hour windows automatically
          </TooltipTrigger>
          <TooltipPopup>
            Sends a short message with Claude Haiku when an account's 5-hour window can start, so
            its clock begins right away. Uses a tiny amount of usage.
          </TooltipPopup>
        </Tooltip>
      </div>
      <div className="flex min-h-6 min-w-0 items-center text-xs text-muted-foreground">
        <Tooltip>
          <TooltipTrigger render={<span className="min-w-0 flex-1 truncate" />}>
            {status}
          </TooltipTrigger>
          <TooltipPopup>{status}</TooltipPopup>
        </Tooltip>
      </div>
    </>
  );
}
