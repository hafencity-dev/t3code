import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { stopTurnsCopy } from "./accounts.logic";

/** Codex restarts to switch; running turns stop only after this confirmation. */
export function StopTurnsDialog({
  label,
  runningTurnCount,
  switching,
  onConfirm,
  onCancel,
}: {
  label: string;
  runningTurnCount: number;
  switching: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const copy = stopTurnsCopy(label, runningTurnCount);
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !switching) onCancel();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          <AlertDialogDescription>{copy.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" disabled={switching} onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={switching} onClick={onConfirm}>
            {switching ? <Spinner /> : null}
            {switching ? "Switching…" : "Stop and switch"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
