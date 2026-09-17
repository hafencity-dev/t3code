/**
 * fork: f4 — stash list/push/apply/pop/drop.
 *
 * The same list backs the Stashes section and the "Recent backups" group: a
 * discard backup *is* a stash, tagged by its message prefix.
 */
import * as Effect from "effect/Effect";

import type { WorkingCopyStashEntry } from "@t3tools/contracts";
import * as commands from "./commands.ts";
import type { WorkingCopyGit } from "./WorkingCopyGit.ts";
import { readIdentityStashLog, withStashIdentity } from "./WorkingCopyStashIdentity.ts";
import type { StashIdentityInput } from "./StashIdentityFiles.ts";

/** Prefix that marks a stash as one of the panel's own discard backups. */
export const DISCARD_BACKUP_PREFIX = "t3-backup:";
/** How many prefixed backups to keep. Pruning touches nothing else. */
export const DISCARD_BACKUP_KEEP = 10;

const STASH_SUBJECT_PREFIX = /^(?:WIP on|On) ([^:]+): /;
const STASH_INDEX = /^stash@\{(\d+)\}$/;

interface ParsedStashLabel {
  readonly label: string;
  readonly branch: string | null;
}

/** `WIP on main: 1a2b3c msg` / `On main: msg` → the message and the branch. */
export function parseStashSubject(subject: string): ParsedStashLabel {
  const match = STASH_SUBJECT_PREFIX.exec(subject);
  if (match === null) {
    return { label: subject, branch: null };
  }
  return { label: subject.slice(match[0].length), branch: match[1] ?? null };
}

export function isDiscardBackupLabel(label: string): boolean {
  return label.startsWith(DISCARD_BACKUP_PREFIX);
}

export function parseStashList(stdout: string): ReadonlyArray<WorkingCopyStashEntry> {
  const entries: Array<WorkingCopyStashEntry> = [];
  for (const record of stdout.split(commands.LOG_RECORD_SEPARATOR)) {
    const trimmed = record.replace(/^\n+/, "");
    if (trimmed.length === 0) {
      continue;
    }
    const fields = trimmed.split(commands.LOG_FIELD_SEPARATOR);
    const ref = fields[0];
    // fork: f4 — `%H`, the stash commit. The immutable handle; `ref` is not.
    const commit = fields[1];
    const subject = fields[2];
    const createdAt = fields[3];
    if (ref === undefined || subject === undefined || createdAt === undefined) {
      continue;
    }
    const index = STASH_INDEX.exec(ref);
    if (index === null) {
      continue;
    }
    const { label, branch } = parseStashSubject(subject);
    entries.push({
      index: Number.parseInt(index[1] ?? "0", 10),
      ref,
      ...(commit !== undefined && commit.length > 0 ? { commit } : {}),
      label,
      branch,
      createdAt,
      isDiscardBackup: isDiscardBackupLabel(label),
    });
  }
  return entries;
}

/**
 * One reflog snapshot carries position, commit and identity together, so a
 * push between two Git reads cannot pair an index with the wrong entry. A
 * repository the transaction cannot serve (reftable, unreadable log) still
 * lists through `git stash list`; its entries carry no identity, so every
 * mutation on them is refused instead of guessed.
 */
export const readStashList = Effect.fn("workingCopy.readStashList")(function* (
  git: WorkingCopyGit,
) {
  const identified = yield* readIdentityStashLog(git).pipe(
    Effect.catchTag("WorkingCopyStashIdentityError", () => Effect.succeed(null)),
  );
  if (identified === null) {
    const output = yield* git.run({
      operation: "workingCopy.stashList",
      args: commands.stashListArgs(),
    });
    // An unborn repository has no stash ref at all; that is an empty list.
    return output.exitCode === 0 ? parseStashList(output.stdout) : [];
  }
  const { recoveryJournalPath } = identified;
  return identified.entries.toReversed().map((entry, index): WorkingCopyStashEntry => {
    const { label, branch } = parseStashSubject(entry.subject);
    return {
      index,
      ref: `stash@{${index}}`,
      commit: entry.commit,
      identity: entry.identity,
      label,
      branch,
      createdAt: entry.createdAt,
      isDiscardBackup: isDiscardBackupLabel(label),
      ...(recoveryJournalPath !== undefined ? { recoveryJournalPath } : {}),
    };
  });
});

export const stashPush = Effect.fn("workingCopy.stashPush")(function* (
  git: WorkingCopyGit,
  input: {
    readonly message?: string | undefined;
    readonly includeUntracked: boolean;
  },
) {
  yield* git.ok({
    operation: "workingCopy.stashPush",
    args: commands.stashPushArgs(input),
    mutating: true,
  });
});

export const stashApply = (git: WorkingCopyGit, input: StashIdentityInput) =>
  withStashIdentity(git, input, "workingCopy.stashApply", true, false);

export const stashPop = (git: WorkingCopyGit, input: StashIdentityInput) =>
  withStashIdentity(git, input, "workingCopy.stashPop", true, true);

export const stashDrop = (git: WorkingCopyGit, input: StashIdentityInput) =>
  withStashIdentity(git, input, "workingCopy.stashDrop", false, true);
