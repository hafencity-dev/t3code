import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  selectThreadDiffPanelSelection,
  useDiffPanelSessionStore,
  useDiffPanelStore,
} from "./diffPanelStore";

const THREAD_REF = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));

describe("diffPanelStore", () => {
  beforeEach(() => {
    useDiffPanelStore.setState({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
    });
    useDiffPanelSessionStore.setState({ collapsedFileKeysByScopeKey: {} });
  });

  it("retains fold choices when a panel consumer returns with fresh defaults", () => {
    const scopeKey = "environment-1:thread-1:branch";
    const defaults = new Set(["src/app.ts", "src/index.ts"]);
    useDiffPanelSessionStore.getState().updateCollapsedFileKeys(scopeKey, defaults, (current) => {
      const next = new Set(current);
      next.delete("src/app.ts");
      return next;
    });

    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(["src/index.ts"]),
    );

    useDiffPanelSessionStore.getState().updateCollapsedFileKeys(scopeKey, new Set(), (current) => {
      const next = new Set(current);
      next.delete("src/index.ts");
      return next;
    });
    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(),
    );

    useDiffPanelSessionStore
      .getState()
      .updateCollapsedFileKeys(scopeKey, defaults, (current) => current);
    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(),
    );
    expect(defaults).toEqual(new Set(["src/app.ts", "src/index.ts"]));
  });
  // fork: f4 hunk staging
  it("keeps the staged and unstaged sides of one file as distinct selections", () => {
    useDiffPanelStore
      .getState()
      .selectWorkingCopyFile(THREAD_REF, { side: "unstaged", filePath: "src/app.ts" });

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({
      kind: "working-copy",
      side: "unstaged",
      filePath: "src/app.ts",
      oldPath: null,
      revealRequestId: 1,
    });

    useDiffPanelStore
      .getState()
      .selectWorkingCopyFile(THREAD_REF, { side: "staged", filePath: "src/app.ts" });

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({
      kind: "working-copy",
      side: "staged",
      filePath: "src/app.ts",
      oldPath: null,
      // Same file, other side: the reveal token still advances so the viewer
      // scrolls back to it.
      revealRequestId: 2,
    });
  });

  // fork: f4 hunk staging
  it("normalizes a rename source and leaves the git scopes reachable", () => {
    useDiffPanelStore.getState().selectWorkingCopyFile(THREAD_REF, {
      side: "unstaged",
      filePath: "new/name.ts",
      oldPath: "  old/name.ts  ",
    });

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toMatchObject({ oldPath: "old/name.ts" });

    useDiffPanelStore.getState().selectGitScope(THREAD_REF, "unstaged");
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "unstaged" });
  });
});
