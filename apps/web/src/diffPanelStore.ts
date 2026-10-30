import type { ThreadStructureVisibleTurnItem } from "@t3tools/client-runtime/state/shell";
import { turnItemDetailRevision } from "@t3tools/client-runtime/work-log/item-detail";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { RunId, ScopedThreadRef, ThreadId, TurnItemId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export interface ToolCallDiffTarget {
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
  readonly revision: string;
}

export type DiffPanelSelection =
  | ({ kind: "tool-call" } & ToolCallDiffTarget)
  | { kind: "branch"; baseRef: string | null }
  | { kind: "unstaged" }
  // fork: f4 hunk staging — one file, one side of the index. Staged and
  // unstaged are distinct selections on purpose: that is what makes staging a
  // hunk flip the file to the other side instead of mutating the view in place.
  | {
      kind: "working-copy";
      side: "staged" | "unstaged";
      filePath: string;
      oldPath: string | null;
      revealRequestId: number;
    }
  // fork: f4 source-control panel - one file inside one commit, read-only.
  // The third file-scoped kind the hunk-staging step anticipated: it reuses the
  // same diff surface as `working-copy` but reads `workingCopy.commitFileDiff`
  // and offers no hunk actions (a landed commit has no index side to stage to).
  | {
      kind: "commit-file";
      hash: string;
      shortHash: string;
      filePath: string;
      oldPath: string | null;
      revealRequestId: number;
    }
  | { kind: "commit"; sha: string; baseRef: string | null }
  | { kind: "turn"; turnId: RunId; filePath: string | null; revealRequestId: number };

const DEFAULT_SELECTION: DiffPanelSelection = { kind: "branch", baseRef: null };

interface DiffPanelStoreState {
  byThreadKey: Record<string, DiffPanelSelection>;
  branchBaseRefByThreadKey: Record<string, string | null>;
  /** A link that selected a commit before opening the closed pane; opening keeps that selection. */
  keepSelectionOnOpenThreadKey: string | null;
  selectGitScope: (ref: ScopedThreadRef, scope: "branch" | "unstaged") => void;
  selectBranchBaseRef: (ref: ScopedThreadRef, baseRef: string | null) => void;
  selectToolCall: (ref: ScopedThreadRef, target: ToolCallDiffTarget) => void;
  selectTurn: (ref: ScopedThreadRef, turnId: RunId, filePath?: string) => void;
  // fork: f4 hunk staging
  selectWorkingCopyFile: (
    ref: ScopedThreadRef,
    file: { side: "staged" | "unstaged"; filePath: string; oldPath?: string | undefined },
  ) => void;
  // fork: f4 source-control panel
  selectCommitFile: (
    ref: ScopedThreadRef,
    file: {
      hash: string;
      shortHash: string;
      filePath: string;
      oldPath?: string | undefined;
    },
  ) => void;
  selectCommit: (ref: ScopedThreadRef, sha: string, keepOnOpen?: boolean) => void;
  consumeKeepSelectionOnOpen: (ref: ScopedThreadRef) => boolean;
  reconcileTurnSelection: (ref: ScopedThreadRef, availableTurnIds: ReadonlyArray<RunId>) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

// fork: the upstream whole-commit scope replaced the old single-file discriminator.
export function migrateDiffPanelState(persisted: unknown) {
  type LegacyCommitFile = Omit<Extract<DiffPanelSelection, { kind: "commit-file" }>, "kind"> & {
    kind: "commit";
  };
  const state = persisted as {
    byThreadKey?: Record<string, DiffPanelSelection | LegacyCommitFile>;
    branchBaseRefByThreadKey?: Record<string, string | null>;
  } | null;
  return {
    byThreadKey: Object.fromEntries(
      Object.entries(state?.byThreadKey ?? {}).map(([key, selection]) => [
        key,
        selection.kind === "commit" && "hash" in selection
          ? { ...selection, kind: "commit-file" as const }
          : selection,
      ]),
    ),
    branchBaseRefByThreadKey: state?.branchBaseRefByThreadKey ?? {},
  };
}

function normalizeBaseRef(baseRef: string | null): string | null {
  const normalized = baseRef?.trim();
  return normalized ? normalized : null;
}

function branchBaseRef(
  state: Pick<DiffPanelStoreState, "byThreadKey" | "branchBaseRefByThreadKey">,
  threadKey: string,
): string | null {
  const previous = state.byThreadKey[threadKey];
  return previous?.kind === "branch" || previous?.kind === "commit"
    ? previous.baseRef
    : (state.branchBaseRefByThreadKey[threadKey] ?? null);
}

export const useDiffPanelStore = create<DiffPanelStoreState>()(
  persist(
    (set, get) => ({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      keepSelectionOnOpenThreadKey: null,
      selectGitScope: (ref, scope) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          const previousBaseRef = branchBaseRef(state, threadKey);
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]:
                scope === "branch"
                  ? { kind: "branch", baseRef: previousBaseRef }
                  : { kind: "unstaged" },
            },
            branchBaseRefByThreadKey:
              previous?.kind === "branch" || previous?.kind === "commit"
                ? { ...state.branchBaseRefByThreadKey, [threadKey]: previous.baseRef }
                : state.branchBaseRefByThreadKey,
          };
        }),
      selectBranchBaseRef: (ref, baseRef) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const normalizedBaseRef = normalizeBaseRef(baseRef);
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: { kind: "branch", baseRef: normalizedBaseRef },
            },
            branchBaseRefByThreadKey: {
              ...state.branchBaseRefByThreadKey,
              [threadKey]: normalizedBaseRef,
            },
          };
        }),
      selectToolCall: (ref, target) =>
        set((state) => ({
          byThreadKey: {
            ...state.byThreadKey,
            [scopedThreadKey(ref)]: { kind: "tool-call", ...target },
          },
        })),
      selectTurn: (ref, turnId, filePath) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: {
                kind: "turn",
                turnId,
                filePath: filePath?.trim() || null,
                revealRequestId: previous?.kind === "turn" ? previous.revealRequestId + 1 : 1,
              },
            },
          };
        }),
      // fork: f4 hunk staging
      selectWorkingCopyFile: (ref, file) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: {
                kind: "working-copy",
                side: file.side,
                filePath: file.filePath,
                oldPath: file.oldPath?.trim() || null,
                // Re-picking the same row must still scroll the viewer back to
                // it, so the reveal token advances on every selection.
                revealRequestId:
                  previous?.kind === "working-copy" ? previous.revealRequestId + 1 : 1,
              },
            },
          };
        }),
      // fork: f4 source-control panel
      selectCommitFile: (ref, file) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: {
                kind: "commit-file",
                hash: file.hash,
                shortHash: file.shortHash,
                filePath: file.filePath,
                oldPath: file.oldPath?.trim() || null,
                // Same reveal-token rule as `working-copy`: re-picking the same
                // row must still scroll the viewer back to it.
                revealRequestId:
                  previous?.kind === "commit-file" ? previous.revealRequestId + 1 : 1,
              },
            },
          };
        }),
      selectCommit: (ref, sha, keepOnOpen = false) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const baseRef = branchBaseRef(state, threadKey);
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: { kind: "commit", sha, baseRef },
            },
            branchBaseRefByThreadKey: { ...state.branchBaseRefByThreadKey, [threadKey]: baseRef },
            keepSelectionOnOpenThreadKey: keepOnOpen
              ? threadKey
              : state.keepSelectionOnOpenThreadKey,
          };
        }),
      consumeKeepSelectionOnOpen: (ref) => {
        if (get().keepSelectionOnOpenThreadKey !== scopedThreadKey(ref)) return false;
        set({ keepSelectionOnOpenThreadKey: null });
        return true;
      },
      reconcileTurnSelection: (ref, availableTurnIds) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          const latestTurnId = availableTurnIds[0];
          if (
            previous?.kind !== "turn" ||
            latestTurnId === undefined ||
            availableTurnIds.includes(previous.turnId)
          ) {
            return state;
          }
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: { ...previous, turnId: latestTurnId },
            },
          };
        }),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (!(threadKey in state.byThreadKey) && !(threadKey in state.branchBaseRefByThreadKey)) {
            return state;
          }
          const { [threadKey]: _removed, ...byThreadKey } = state.byThreadKey;
          const { [threadKey]: _removedBaseRef, ...branchBaseRefByThreadKey } =
            state.branchBaseRefByThreadKey;
          return { byThreadKey, branchBaseRefByThreadKey };
        }),
    }),
    {
      name: "t3code:diff-panel-state:v1",
      version: 3,
      migrate: migrateDiffPanelState,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        byThreadKey: state.byThreadKey,
        branchBaseRefByThreadKey: state.branchBaseRefByThreadKey,
      }),
    },
  ),
);

interface DiffPanelSessionStoreState {
  collapsedFileKeysByScopeKey: Record<string, ReadonlySet<string>>;
  updateCollapsedFileKeys: (
    scopeKey: string,
    defaults: ReadonlySet<string>,
    update: (current: ReadonlySet<string>) => ReadonlySet<string>,
  ) => void;
}

// Session-only so folds survive right-panel switches without changing reload defaults.
export const useDiffPanelSessionStore = create<DiffPanelSessionStoreState>()((set) => ({
  collapsedFileKeysByScopeKey: {},
  updateCollapsedFileKeys: (scopeKey, defaults, update) =>
    set((state) => {
      const current = state.collapsedFileKeysByScopeKey[scopeKey] ?? defaults;
      const next = update(current);
      if (next === current) return state;
      return {
        collapsedFileKeysByScopeKey: { ...state.collapsedFileKeysByScopeKey, [scopeKey]: next },
      };
    }),
}));

export function selectThreadDiffPanelSelection(
  byThreadKey: Record<string, DiffPanelSelection>,
  ref: ScopedThreadRef | null | undefined,
): DiffPanelSelection {
  if (!ref) return DEFAULT_SELECTION;
  return byThreadKey[scopedThreadKey(ref)] ?? DEFAULT_SELECTION;
}

export function selectThreadBranchBaseRef(
  state: Pick<DiffPanelStoreState, "byThreadKey" | "branchBaseRefByThreadKey">,
  ref: ScopedThreadRef | null | undefined,
): string | null {
  return ref ? branchBaseRef(state, scopedThreadKey(ref)) : null;
}

export function resolveToolCallDiffTarget(
  target: ToolCallDiffTarget,
  items: ReadonlyArray<ThreadStructureVisibleTurnItem>,
): ToolCallDiffTarget {
  const row = items.find(
    (row) => row.sourceThreadId === target.threadId && row.sourceItemId === target.itemId,
  );
  if (row?.item.type !== "file_change") return target;
  const revision = turnItemDetailRevision(row.item);
  return revision === target.revision ? target : { ...target, revision };
}
