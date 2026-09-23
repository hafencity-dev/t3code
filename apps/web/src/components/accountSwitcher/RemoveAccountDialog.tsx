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
import { providerAccountsEnvironment } from "./state";

export function RemoveAccountDialog({
  account,
  environmentId,
  onClose,
}: {
  account: ProviderAccount;
  environmentId: EnvironmentId;
  onClose: () => void;
}) {
  const remove = useAtomCommand(providerAccountsEnvironment.remove, { reportFailure: false });
  const [removing, setRemoving] = useState(false);
  const external = account.kind === "external";
  const confirm = async () => {
    if (removing || account.active || account.kind === "default") return;
    setRemoving(true);
    const result = await remove({ environmentId, input: { accountId: account.id } });
    setRemoving(false);
    if (result._tag === "Success") {
      toastManager.add({ type: "success", title: "Account removed" });
      onClose();
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
        if (!open && !removing) onClose();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {external ? "Forget" : "Remove"} {account.label}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {external
              ? "This account is removed from the list. Its external login files are not deleted."
              : "Its saved login is deleted from this device. You'll need to sign in again to use this account."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" disabled={removing} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={removing || account.active}
            onClick={() => void confirm()}
          >
            {removing ? <Spinner /> : null}
            {external ? "Forget account" : "Remove account"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
