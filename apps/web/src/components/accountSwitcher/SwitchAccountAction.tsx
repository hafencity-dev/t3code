import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProviderAccountId, ProviderAccountGroup } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import {
  accountSwitchInput,
  accountSwitchSuccess,
  accountSwitchBusyTurnCount,
} from "./accounts.logic";
import { providerAccountsEnvironment } from "./state";

export function SwitchAccountAction({
  environmentId,
  accountId,
  switchMode,
  label,
  children = "Switch",
  onSwitched,
  stopRunning = false,
}: {
  environmentId: EnvironmentId;
  accountId: ProviderAccountId;
  switchMode: ProviderAccountGroup["switchMode"];
  label: string;
  children?: string;
  onSwitched?: () => void;
  stopRunning?: boolean;
}) {
  const switchAccount = useAtomCommand(providerAccountsEnvironment.switchAccount, {
    reportFailure: false,
  });
  const [switching, setSwitching] = useState(false);
  const pending = useRef(false);
  const [running, setRunning] = useState<number | null>(null);
  const run = async (interruptRunning = false) => {
    if (pending.current) return;
    pending.current = true;
    setSwitching(true);
    try {
      const result = await switchAccount({
        environmentId,
        input: accountSwitchInput(accountId, switchMode, interruptRunning),
      });
      if (result._tag === "Success") {
        setRunning(null);
        toastManager.add({ type: "success", ...accountSwitchSuccess(switchMode, label) });
        onSwitched?.();
      } else if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        const runningTurnCount = accountSwitchBusyTurnCount(switchMode, error);
        if (runningTurnCount !== null) {
          setRunning(runningTurnCount);
        } else {
          toastManager.add({
            type: "error",
            title: `Couldn't switch to ${label}`,
            description:
              error instanceof Error ? error.message : "The account could not be switched.",
          });
        }
      }
    } finally {
      pending.current = false;
      setSwitching(false);
    }
  };
  return running === null || switchMode === "hot" ? (
    <Button
      size="sm"
      variant={stopRunning && switchMode === "restart" ? "destructive" : "default"}
      disabled={switching}
      onClick={() => void run(stopRunning)}
    >
      {switching ? <Spinner /> : null}
      {switching ? "Switching…" : children}
    </Button>
  ) : (
    <div className="grid gap-2" role="alert">
      <p className="text-xs">
        {running} running turn{running === 1 ? "" : "s"} will be stopped.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="destructive" disabled={switching} onClick={() => void run(true)}>
          {switching ? <Spinner /> : null}
          {switching ? "Switching…" : "Stop and switch"}
        </Button>
        <Button size="sm" variant="ghost" disabled={switching} onClick={() => setRunning(null)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
