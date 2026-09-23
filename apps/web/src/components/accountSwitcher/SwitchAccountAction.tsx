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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  accountSwitchInput,
  accountSwitchSuccess,
  accountSwitchBusyTurnCount,
} from "./accounts.logic";
import { providerAccountsEnvironment } from "./state";
import { StopTurnsDialog } from "./StopTurnsDialog";

/**
 * A switch button. Codex answers a switch with running turns with a busy error; that opens
 * `StopTurnsDialog` and only its confirmation resends with `interruptRunning`.
 */
export function SwitchAccountAction({
  environmentId,
  accountId,
  switchMode,
  label,
  children = "Switch",
  variant = "default",
  size = "xs",
  fill = false,
  busy = false,
  disabledReason,
  onStart,
  onEnd,
  onSwitched,
}: {
  environmentId: EnvironmentId;
  accountId: ProviderAccountId;
  switchMode: ProviderAccountGroup["switchMode"];
  label: string;
  children?: string;
  variant?: "default" | "outline";
  size?: "xs" | "default";
  /** Fill the parent's fixed slot, truncating a long label. */
  fill?: boolean;
  /** A switch to this account started elsewhere (the wizard, auto-switch) is in flight. */
  busy?: boolean;
  disabledReason?: string | undefined;
  onStart?: (accountId: ProviderAccountId) => void;
  onEnd?: () => void;
  onSwitched?: () => void;
}) {
  const switchAccount = useAtomCommand(providerAccountsEnvironment.switchAccount, {
    reportFailure: false,
  });
  const [switching, setSwitching] = useState(false);
  const pending = useRef(false);
  const [running, setRunning] = useState<number | null>(null);
  const run = async (interruptRunning: boolean) => {
    if (pending.current) return;
    pending.current = true;
    setSwitching(true);
    onStart?.(accountId);
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
          setRunning(null);
          toastManager.add({
            type: "error",
            title: `Couldn't switch to ${label}`,
            description:
              error instanceof Error && error.message
                ? error.message
                : "The account could not be switched.",
          });
        }
      }
    } finally {
      pending.current = false;
      setSwitching(false);
      onEnd?.();
    }
  };
  const showSwitching = (switching && running === null) || busy;
  const disabled = switching || busy || Boolean(disabledReason);
  const button = (
    <Button
      size={size}
      variant={variant}
      disabled={disabled}
      {...(children === "Switch" ? { "aria-label": `Switch to ${label}` } : {})}
      {...(fill ? { className: "w-full" } : {})}
      onClick={() => void run(false)}
    >
      {showSwitching ? <Spinner /> : null}
      <span className="truncate">{showSwitching ? "Switching…" : children}</span>
    </Button>
  );
  return (
    <>
      {disabledReason && !switching && !busy ? (
        <Tooltip>
          {/* A disabled button can't take focus; the wrapper keeps its reason reachable. */}
          <TooltipTrigger
            render={<span tabIndex={0} {...(fill ? { className: "flex w-full" } : {})} />}
          >
            {button}
          </TooltipTrigger>
          <TooltipPopup>{disabledReason}</TooltipPopup>
        </Tooltip>
      ) : (
        button
      )}
      {running !== null && switchMode === "restart" ? (
        <StopTurnsDialog
          label={label}
          runningTurnCount={running}
          switching={switching}
          onConfirm={() => void run(true)}
          onCancel={() => setRunning(null)}
        />
      ) : null}
    </>
  );
}
