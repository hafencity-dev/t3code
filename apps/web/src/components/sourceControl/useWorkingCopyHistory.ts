// Paging retains contiguous history for the graph; search replies are scoped to their request filter.
import {
  HISTORY_SEARCH_DEBOUNCE_MS,
  HISTORY_SEARCH_SERVER_LIMIT,
  historyFilterKey,
  isHashIshQuery,
  isHistoryFilterActive,
  matchesHistoryFilter,
  mergeHistorySearchResults,
  type HistoryFilter,
} from "@t3tools/client-runtime/state/working-copy-logic";
import { workingCopyRevisionAtom } from "@t3tools/client-runtime/state/working-copy";
import { useAtomValue } from "@effect/atom-react";
import type { WorkingCopyLogEntry } from "@t3tools/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  EMPTY_LOG_PAGE_STATE,
  applyLogPage,
  nextLogCursor,
  type LogPageState,
} from "~/lib/sourceControl/logPaging";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { workingCopyEnvironment } from "~/state/workingCopy";

import type { SourceControlScope } from "./useWorkingCopy";

const HISTORY_PAGE_SIZE = 100;

export interface WorkingCopyHistoryView {
  /** The contiguous newest-first page state the lane graph folds over. */
  readonly page: LogPageState;
  /** What the list renders: the page, or the merged search result. */
  readonly entries: ReadonlyArray<WorkingCopyLogEntry>;
  readonly filterActive: boolean;
  /** Anything is in flight — the dimming the toolbar uses. */
  readonly isLoading: boolean;
  /**
   * fork: f4 F-16 — the NEXT page specifically. The load-more row used to read
   * the shared flag, which every mutation flips through the head reload, so the
   * button was enabled at the instant of a press it would then drop.
   */
  readonly isLoadingMore: boolean;
  readonly isSearching: boolean;
  readonly error: string | null;
  readonly canLoadMore: boolean;
  readonly loadMore: () => void;
  readonly reload: () => void;
}

export function useWorkingCopyHistory(
  scope: SourceControlScope | null,
  filter: HistoryFilter,
  options: { readonly enabled: boolean },
): WorkingCopyHistoryView {
  const runLog = useAtomQueryRunner(workingCopyEnvironment.log);
  const [page, setPage] = useState<LogPageState>(EMPTY_LOG_PAGE_STATE);
  const [searchResults, setSearchResults] = useState<ReadonlyArray<WorkingCopyLogEntry>>([]);
  // fork: f4 F-16 — one flag per intent. They used to be one shared flag.
  const [headLoading, setHeadLoading] = useState(false);
  const [pageLoading, setPageLoading] = useState(false);
  const [completedSearchKey, setCompletedSearchKey] = useState<string | null>(null);
  const [completedHeadKey, setCompletedHeadKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const revision = useAtomValue(
    scope === null
      ? EMPTY_REVISION_ATOM
      : workingCopyRevisionAtom({ environmentId: scope.environmentId, cwd: scope.cwd }),
  );

  const filterKey = historyFilterKey(filter);
  const filterActive = isHistoryFilterActive(filter);
  const environmentId = scope?.environmentId ?? null;
  const cwd = scope?.cwd ?? null;
  const scopeKey = JSON.stringify([environmentId, cwd]);
  const headKey = JSON.stringify([scopeKey, revision, options.enabled]);
  const searchKey = JSON.stringify([scopeKey, filterKey, options.enabled]);
  const [previousScopeKey, setPreviousScopeKey] = useState(scopeKey);
  const [previousSearchKey, setPreviousSearchKey] = useState(searchKey);
  if (scopeKey !== previousScopeKey) {
    setPreviousScopeKey(scopeKey);
    setPage(EMPTY_LOG_PAGE_STATE);
    setError(null);
    setHeadLoading(false);
    setPageLoading(false);
    setCompletedHeadKey(null);
  }
  if (searchKey !== previousSearchKey) {
    setPreviousSearchKey(searchKey);
    setSearchResults([]);
    setCompletedSearchKey(null);
  }
  const liveSearchKeyRef = useRef(searchKey);
  const liveScopeKeyRef = useRef(scopeKey);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- invalidate in-flight Git replies when the committed repository or filter changes
  useLayoutEffect(() => {
    liveSearchKeyRef.current = searchKey;
    liveScopeKeyRef.current = scopeKey;
  }, [searchKey, scopeKey]);
  const isSearching =
    options.enabled && scope !== null && filterActive && completedSearchKey !== searchKey;

  /**
   * fork: f4 — generation guard. Two rapid mutations issue two head reloads;
   * without this the older answer could resolve last and write the page that
   * does NOT contain the commit you just made.
   */
  const headGenerationRef = useRef(0);

  const loadHead = async () => {
    if (environmentId === null || cwd === null) return;
    headGenerationRef.current += 1;
    const generation = headGenerationRef.current;
    return await (async () => {
      const result = await runLog({
        environmentId,
        input: { cwd, limit: HISTORY_PAGE_SIZE },
      });
      if (headGenerationRef.current !== generation || liveScopeKeyRef.current !== scopeKey) return;
      if (result._tag === "Failure") {
        setError("The commit history could not be read.");
        return;
      }
      setError(null);
      setPage((current) => applyLogPage(current, result.value, "head"));
    })().finally(() => {
      if (headGenerationRef.current === generation && liveScopeKeyRef.current === scopeKey) {
        setHeadLoading(false);
        setCompletedHeadKey(headKey);
      }
    });
  };

  // Head reload on mount, on repo change, and on every mutation (the revision
  // atom is bumped by the commands' `onSettled`).
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- own and cancel the paginated Git history request across repository revisions
  useEffect(() => {
    if (!options.enabled) return;
    void loadHead();
    return () => {
      headGenerationRef.current += 1;
    };
  }, [loadHead, options.enabled]);

  const loadMore = () => {
    if (environmentId === null || cwd === null || pageLoading) return;
    const cursor = nextLogCursor(page);
    if (cursor === null || !page.hasMore) return;
    setPageLoading(true);
    const generation = headGenerationRef.current;
    void (async () => {
      return await (async () => {
        const result = await runLog({
          environmentId,
          input: { cwd, limit: HISTORY_PAGE_SIZE, before: cursor },
        });
        if (headGenerationRef.current !== generation || liveScopeKeyRef.current !== scopeKey)
          return;
        if (result._tag === "Failure") {
          setError("The next page of history could not be read.");
          return;
        }
        setError(null);
        setPage((current) => applyLogPage(current, result.value, "append"));
      })().finally(() => {
        if (liveScopeKeyRef.current === scopeKey) setPageLoading(false);
      });
    })();
  };

  // Debounced server search. The response is discarded unless the filter it was
  // issued for is still the live one.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- own the debounced Git search timer and cancel stale requests on filter changes
  useEffect(() => {
    if (!options.enabled || environmentId === null || cwd === null) return;
    if (!filterActive) return;
    const issuedFor = searchKey;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        const query = filter.query.trim();
        const author = filter.author.trim();
        const input = {
          cwd,
          limit: HISTORY_SEARCH_SERVER_LIMIT,
          ...(query.length > 0 && !isHashIshQuery(query) ? { grep: query } : {}),
          ...(author.length > 0 ? { author } : {}),
        };
        const requests = [runLog({ environmentId, input })];
        if (isHashIshQuery(query)) {
          requests.push(runLog({ environmentId, input: { cwd, limit: 1, rev: query } }));
        }
        return await (async () => {
          const results = await Promise.all(requests);
          if (cancelled || liveSearchKeyRef.current !== issuedFor) return;
          const entries: WorkingCopyLogEntry[] = [];
          let anyFailed = false;
          for (const result of results) {
            if (result._tag === "Success") entries.push(...result.value.entries);
            else anyFailed = true;
          }
          // fork: f4 F-27 — a failed search used to render as "no matching
          // commits", which is a different and much worse answer.
          setError(anyFailed ? "The commit search could not be run." : null);
          setSearchResults(entries);
        })().finally(() => {
          // An obsolete response must not settle the current filter's request.
          if (!cancelled && liveSearchKeyRef.current === issuedFor)
            setCompletedSearchKey(issuedFor);
        });
      })();
    }, HISTORY_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    cwd,
    environmentId,
    filter.author,
    filter.query,
    filterActive,
    searchKey,
    options.enabled,
    runLog,
  ]);

  const entries = (() => {
    if (!filterActive) return page.entries;
    return mergeHistorySearchResults(page.entries, searchResults, filter);
  })();

  const reload = () => {
    if (scope === null) return;
    setHeadLoading(true);
    void loadHead();
  };

  return {
    page,
    entries,
    filterActive,
    isLoading:
      headLoading ||
      pageLoading ||
      (options.enabled && scope !== null && completedHeadKey !== headKey),
    isLoadingMore: pageLoading,
    isSearching,
    error,
    // Paging is only offered on the unfiltered list: "load more" under a filter
    // pages the underlying log, not the filtered view, and reads as broken.
    canLoadMore: !filterActive && page.hasMore && nextLogCursor(page) !== null,
    loadMore,
    reload,
  };
}

const EMPTY_REVISION_ATOM = workingCopyRevisionAtom({
  environmentId: "__none__" as never,
  cwd: "",
});

/** Re-exported so the toolbar can show "N of M" without importing the logic module. */
export function countMatching(
  entries: ReadonlyArray<WorkingCopyLogEntry>,
  filter: HistoryFilter,
): number {
  let count = 0;
  for (const entry of entries) {
    if (matchesHistoryFilter(entry, filter)) count += 1;
  }
  return count;
}
