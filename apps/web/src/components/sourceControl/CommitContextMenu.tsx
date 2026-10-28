// Hard reset requires typed confirmation; recoverable reset modes do not.
import type { WorkingCopyLogEntry } from "@t3tools/contracts";
import {
  Menu,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { MoreHorizontal } from "lucide-react";

import { Button } from "~/components/ui/button";

import { workingCopyBusyKey } from "./sourceControlPanel.logic";

export interface CommitContextMenuProps {
  readonly entry: WorkingCopyLogEntry;
  readonly detached: boolean;
  readonly dirty: boolean;
  /** fork: f4 F-06 — per-commit in-flight state, so a re-press cannot vanish. */
  readonly isBusy: (key: string) => boolean;
  readonly onCopy: (text: string, label?: string) => void;
  readonly onFilterAuthor: (author: string) => void;
  readonly onTag: (entry: WorkingCopyLogEntry) => void;
  readonly onCherryPick: (entry: WorkingCopyLogEntry) => void;
  readonly onCheckout: (entry: WorkingCopyLogEntry) => void;
  readonly onReset: (entry: WorkingCopyLogEntry, mode: "soft" | "mixed" | "hard") => void;
  readonly onRevert: (entry: WorkingCopyLogEntry) => void;
}

export function CommitContextMenu(props: CommitContextMenuProps) {
  const { entry } = props;
  const resetDisabledReason = props.detached
    ? "Not on a branch"
    : props.dirty
      ? "Commit or stash your changes first"
      : null;
  const isRootCommit = entry.parents.length === 0;
  const busy = {
    tag: props.isBusy(workingCopyBusyKey.tag(entry.hash)),
    cherryPick: props.isBusy(workingCopyBusyKey.cherryPick(entry.hash)),
    checkout: props.isBusy(workingCopyBusyKey.checkout(entry.hash)),
    reset: props.isBusy(workingCopyBusyKey.reset(entry.hash)),
    revert: props.isBusy(workingCopyBusyKey.revert(entry.hash)),
  };

  return (
    <Menu>
      {/* fork: f4 redesign (M25) — the house trigger form, which brings the
          focus ring, the `pointer-coarse` 44px target and `disabled:opacity-64`
          that a hand-styled trigger loses. */}
      <MenuTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Actions for ${entry.shortHash}`}
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
          />
        }
      >
        <MoreHorizontal />
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" sideOffset={4} className="min-w-56">
        <MenuItem onClick={() => props.onCopy(entry.hash, "the commit hash")}>Copy hash</MenuItem>
        <MenuItem onClick={() => props.onCopy(entry.shortHash, "the short hash")}>
          Copy short hash
        </MenuItem>
        <MenuItem onClick={() => props.onCopy(entry.subject, "the commit subject")}>
          Copy subject
        </MenuItem>
        <MenuSeparator />
        <MenuItem onClick={() => props.onFilterAuthor(entry.authorName)}>
          Filter by this author
        </MenuItem>
        <MenuItem disabled={busy.tag} onClick={() => props.onTag(entry)}>
          {busy.tag ? "Creating tag…" : "Create tag here…"}
        </MenuItem>
        <MenuItem disabled={busy.cherryPick} onClick={() => props.onCherryPick(entry)}>
          {busy.cherryPick ? "Cherry-picking…" : "Cherry-pick onto current"}
        </MenuItem>
        <MenuItem disabled={busy.checkout} onClick={() => props.onCheckout(entry)}>
          {busy.checkout ? "Checking out…" : "Checkout (detached)"}
        </MenuItem>
        <MenuSeparator />
        {/* Keep reset modes visible when disabled so their purpose remains discoverable. */}
        <MenuSub>
          <MenuSubTrigger disabled={resetDisabledReason !== null || busy.reset}>
            Reset branch here
          </MenuSubTrigger>
          <MenuSubPopup className="min-w-56">
            {resetDisabledReason === null ? null : (
              <MenuGroupLabel>{resetDisabledReason}</MenuGroupLabel>
            )}
            <MenuItem
              disabled={resetDisabledReason !== null || busy.reset}
              onClick={() => props.onReset(entry, "soft")}
            >
              Soft: keep staged + working
            </MenuItem>
            <MenuItem
              disabled={resetDisabledReason !== null || busy.reset}
              onClick={() => props.onReset(entry, "mixed")}
            >
              Mixed: keep working, unstage
            </MenuItem>
            <MenuItem
              variant="destructive"
              disabled={resetDisabledReason !== null || busy.reset}
              onClick={() => props.onReset(entry, "hard")}
            >
              Hard: discard all changes
            </MenuItem>
          </MenuSubPopup>
        </MenuSub>
        {isRootCommit ? null : (
          <>
            <MenuSeparator />
            <MenuItem
              variant="destructive"
              disabled={busy.revert}
              onClick={() => props.onRevert(entry)}
            >
              {busy.revert ? "Reverting…" : "Revert commit"}
            </MenuItem>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
}
