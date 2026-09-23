import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProviderAccount } from "@t3tools/contracts";
import { useState } from "react";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { canRemoveActiveDuplicate } from "./accounts.logic";
import { providerAccountsEnvironment } from "./state";

function removeCopy(account: ProviderAccount, deviceLabel: string, keeperLabel?: string) {
  if (account.kind === "external")
    return {
      title: `Forget ${account.label}?`,
      description:
        "It's removed from this list. The login files at its configured location are kept.",
      confirm: "Forget account",
      toast: { title: `Forgot ${account.label}` },
    };
  const keeps = account.email
    ? `${keeperLabel} stays signed in as ${account.email}`
    : `${keeperLabel} stays signed in`;
  if (keeperLabel && canRemoveActiveDuplicate(account))
    return {
      title: `Remove ${account.label}?`,
      description: `Its saved login is deleted from ${deviceLabel}. ${keeps} and takes over. Running sessions keep going.`,
      confirm: "Remove account",
      toast: {
        title: `Removed ${account.label}`,
        description: `Claude Code now uses ${keeperLabel}.`,
      },
    };
  return {
    title: `Remove ${account.label}?`,
    description: `Its saved login${account.email ? ` (${account.email})` : ""} is deleted from ${deviceLabel}. Threads aren't affected. To use it again, add it and sign in.${keeperLabel ? ` ${keeps}.` : ""}`,
    confirm: "Remove account",
    toast: { title: `Removed ${account.label}` },
  };
}

/** Confirms removing a saved login, or forgetting an external one. Stays open on failure. */
export function RemoveAccountDialog({
  account,
  environmentId,
  deviceLabel,
  keeperLabel,
  onClose,
}: {
  account: ProviderAccount;
  environmentId: EnvironmentId;
  deviceLabel: string;
  /** Set for a duplicate row: the account that stays. */
  keeperLabel?: string | undefined;
  onClose: (removed: boolean) => void;
}) {
  const remove = useAtomCommand(providerAccountsEnvironment.remove, { reportFailure: false });
  const [removing, setRemoving] = useState(false);
  const copy = removeCopy(account, deviceLabel, keeperLabel);
  const confirm = async () => {
    if (removing) return;
    setRemoving(true);
    const result = await remove({ environmentId, input: { accountId: account.id } });
    setRemoving(false);
    if (result._tag === "Success") {
      toastManager.add({ type: "success", ...copy.toast });
      onClose(true);
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Couldn't remove account",
        description: error instanceof Error ? error.message : "Please try again.",
      });
    }
  };
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !removing) onClose(false);
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          <AlertDialogDescription>{copy.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" disabled={removing} onClick={() => onClose(false)}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={removing} onClick={() => void confirm()}>
            {removing ? <Spinner /> : null}
            {copy.confirm}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
