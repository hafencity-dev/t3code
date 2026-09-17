/**
 * Stashes + the panel's own discard backups.
 *
 * fork: f4 redesign (audit §8) — this used to be a permanently mounted 32px
 * strip pinned under the changes list, taxing every session with chrome for a
 * recovery surface used a few times a month, and competing for the bottom edge
 * the composer now owns. It is content only: the panel mounts it inside a
 * `Dialog` opened from the header's overflow menu.
 *
 * The list itself is still load-on-expand for backups and never polled: a stash
 * list costs a subprocess and nothing about it changes while the dialog is shut.
 *
 * The "Recent backups" group is what makes discard undoable after the toast has
 * gone — it is the same `stash@{n}` list filtered to the fork's own prefixed
 * entries (`isDiscardBackup`).
 *
 * fork: f4 source-control panel
 */
import type { WorkingCopyStashEntry } from "@t3tools/contracts";
import { Archive } from "lucide-react";

import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { Skeleton } from "~/components/ui/skeleton";
import { cn } from "~/lib/utils";

import { stashBusyId, workingCopyBusyKey } from "./sourceControlPanel.logic";

export interface StashesPanelProps {
  readonly stashes: ReadonlyArray<WorkingCopyStashEntry>;
  readonly backups: ReadonlyArray<WorkingCopyStashEntry>;
  readonly isLoading: boolean;
  /** The stash list has resolved at least once — Pop is inert before that. */
  readonly listReady: boolean;
  /**
   * fork: remote Git — the server validates the entry's commit and reflog
   * identity before mutating. Without it, every mutation stays disabled: a
   * positional `stash@{n}` sent to an old server can hit the wrong entry.
   */
  readonly identitySupported: boolean;
  /** fork: f4 F-06 — per-entry in-flight state, so a re-press cannot vanish. */
  readonly isBusy: (key: string) => boolean;
  readonly dirty: boolean;
  readonly onStash: () => void;
  /** Pops the entry as listed — the latest plain stash at render time. */
  readonly onPop: (entry: WorkingCopyStashEntry) => void;
  readonly onApply: (entry: WorkingCopyStashEntry) => void;
  readonly onDrop: (entry: WorkingCopyStashEntry) => void;
  readonly onRestoreBackup: (entry: WorkingCopyStashEntry) => void;
}

/** Old servers list entries without `identity`; those cannot be mutated safely. */
function isMutable(props: StashesPanelProps, entry: WorkingCopyStashEntry): boolean {
  return props.identitySupported && entry.commit !== undefined && entry.identity !== undefined;
}

export function StashesPanel(props: StashesPanelProps) {
  const plainStashes = props.stashes.filter((entry) => !entry.isDiscardBackup);
  const latest = plainStashes[0];
  const popBusy =
    latest !== undefined && props.isBusy(workingCopyBusyKey.stashPop(stashBusyId(latest)));
  const empty = !props.isLoading && plainStashes.length === 0 && props.backups.length === 0;
  const hasEntries = plainStashes.length > 0 || props.backups.length > 0;
  const unsupported =
    hasEntries && [...plainStashes, ...props.backups].some((entry) => !isMutable(props, entry));
  const recoveryJournalPath = [...plainStashes, ...props.backups].find(
    (entry) => entry.recoveryJournalPath !== undefined,
  )?.recoveryJournalPath;

  return (
    <section className="flex min-h-0 flex-col" aria-label="Stashes">
      <div className="flex flex-none items-center gap-2 pb-2">
        <p className="min-w-0 flex-1 text-muted-foreground text-xs">
          A stash parks your uncommitted work; a backup is what the panel saved before a discard.
        </p>
        <span className="flex shrink-0 items-center gap-1.5">
          <Button
            size="xs"
            variant="outline"
            disabled={!props.dirty || props.isBusy(workingCopyBusyKey.stashPush())}
            onClick={props.onStash}
          >
            Stash…
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={
              !props.listReady || latest === undefined || popBusy || !isMutable(props, latest)
            }
            onClick={() => {
              if (latest !== undefined) props.onPop(latest);
            }}
          >
            {popBusy ? "Popping…" : "Pop"}
          </Button>
        </span>
      </div>
      {recoveryJournalPath !== undefined ? (
        <p className="flex-none pb-2 text-destructive text-xs" role="alert">
          A stash removal was interrupted. Stash changes are refused until you resolve it: the
          journal at <code className="break-all">{recoveryJournalPath}</code> holds the original
          reflog, ref, packed stash and the removed commit. Repair with git, then delete or move the
          journal.
        </p>
      ) : null}
      {unsupported ? (
        <p className="flex-none pb-2 text-warning-foreground text-xs" role="note">
          {props.identitySupported
            ? "Some entries cannot be changed from here: this repository's stash storage cannot be verified safely. Use git directly."
            : "Not supported by this server: it cannot verify which stash it changes. Update the server to apply, pop, drop or restore from here."}
        </p>
      ) : null}

      <div className="-mx-3 min-h-0 flex-1 overflow-auto">
        {props.isLoading ? (
          <div className="space-y-1 px-3 py-1" role="status" aria-live="polite">
            <Skeleton className="h-7 w-full rounded-md" />
            <Skeleton className="h-7 w-11/12 rounded-md" />
            <span className="sr-only">Loading stashes…</span>
          </div>
        ) : null}
        {plainStashes.map((stash) => (
          <StashRow
            key={stashBusyId(stash)}
            label={stash.label}
            createdAt={stash.createdAt}
            actions={
              <>
                <RowButton
                  busy={props.isBusy(workingCopyBusyKey.stashApply(stashBusyId(stash)))}
                  disabled={!isMutable(props, stash)}
                  onClick={() => props.onApply(stash)}
                >
                  Apply
                </RowButton>
                <RowButton
                  busy={props.isBusy(workingCopyBusyKey.stashDrop(stashBusyId(stash)))}
                  disabled={!isMutable(props, stash)}
                  onClick={() => props.onDrop(stash)}
                  danger
                >
                  Drop
                </RowButton>
              </>
            }
          />
        ))}
        {props.backups.length > 0 ? (
          <>
            <p className="px-3 pt-3 pb-1 font-medium text-[11px] text-muted-foreground/70 uppercase tracking-[0.08em]">
              Recent backups
            </p>
            {props.backups.map((backup) => (
              <StashRow
                key={stashBusyId(backup)}
                label={backup.label}
                createdAt={backup.createdAt}
                actions={
                  <RowButton
                    busy={props.isBusy(workingCopyBusyKey.restoreBackup(stashBusyId(backup)))}
                    disabled={!isMutable(props, backup)}
                    onClick={() => props.onRestoreBackup(backup)}
                  >
                    Restore
                  </RowButton>
                }
              />
            ))}
          </>
        ) : null}
        {empty ? (
          <Empty className="gap-3 p-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Archive />
              </EmptyMedia>
              <EmptyTitle className="text-base">No stashes</EmptyTitle>
              <EmptyDescription className="text-xs">
                Stash your changes to park them without committing. Discards are backed up here too.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
      </div>
    </section>
  );
}

function StashRow(props: { label: string; createdAt: string; actions: React.ReactNode }) {
  return (
    // fork: f4 redesign (C6) — the timestamp no longer swaps out for the
    // buttons on hover; both have their own space and only the opacity changes.
    <div className="group flex h-8 items-center gap-2 px-3 text-sm hover:bg-accent/50">
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      <time className="shrink-0 text-muted-foreground text-xs tabular-nums">
        {relativeDate(props.createdAt)}
      </time>
      <span
        className={cn(
          "flex shrink-0 items-center gap-1 opacity-0 transition-opacity",
          "group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100",
        )}
      >
        {props.actions}
      </span>
    </div>
  );
}

function RowButton(props: {
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      size="xs"
      variant={props.danger === true ? "destructive-outline" : "outline"}
      disabled={props.busy === true || props.disabled === true}
      aria-busy={props.busy === true}
      onClick={props.onClick}
    >
      {props.children}
    </Button>
  );
}

function relativeDate(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
