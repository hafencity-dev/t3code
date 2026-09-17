import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createJSONStorage } from "zustand/middleware";

import {
  commitSourceControlDraft,
  generateSourceControlDraft,
  recoverSourceControlDraft,
} from "./components/sourceControl/commitDraftOperations";
import { createMemoryStorage } from "./lib/storage";

import {
  DEFAULT_SOURCE_CONTROL_PREFS,
  MAX_PERSISTED_COMMIT_DRAFTS,
  MAX_PERSISTED_PREF_SCOPES,
  migrateSourceControlState,
  sanitizeSourceControlPrefs,
  selectSourceControlPrefs,
  sourceControlDraftKey,
  SOURCE_CONTROL_STORE_VERSION,
  useSourceControlStore,
} from "./sourceControlStore";

beforeEach(() => {
  useSourceControlStore.setState({
    isOpen: false,
    prefsByScope: {},
    commitDraftByScope: {},
    legacyCommitDraftByCwd: {},
  });
});

describe("global source control visibility", () => {
  it("toggles independently of any thread scope", () => {
    useSourceControlStore.getState().toggleOpen();
    expect(useSourceControlStore.getState().isOpen).toBe(true);

    useSourceControlStore.getState().setOpen(false);
    expect(useSourceControlStore.getState().isOpen).toBe(false);
  });
});

// F-31 — the store was persisted with no version, no migration and no
// validation, so a hand-edited or downgrade-written value rendered a control
// whose DOM state disagreed with the state that produced it (a `<select>` with
// no matching option shows its first option while the store says otherwise).

describe("sanitizeSourceControlPrefs (F-31)", () => {
  it("falls back per field instead of rejecting the whole scope", () => {
    const prefs = sanitizeSourceControlPrefs({
      activeSection: "history",
      viewMode: "tree",
      filter: "bogus",
      historySort: 42,
      stashesOpen: "yes",
      collapsedGroups: ["staged", 7, null],
    });
    // The valid fields survive…
    expect(prefs.activeSection).toBe("history");
    expect(prefs.viewMode).toBe("tree");
    // …and only the invalid ones fall back.
    expect(prefs.filter).toBe(DEFAULT_SOURCE_CONTROL_PREFS.filter);
    expect(prefs.historySort).toBe(DEFAULT_SOURCE_CONTROL_PREFS.historySort);
    expect(prefs.stashesOpen).toBe(DEFAULT_SOURCE_CONTROL_PREFS.stashesOpen);
    expect(prefs.collapsedGroups).toEqual(["staged"]);
  });

  it("never yields an activeSection the panel cannot render", () => {
    expect(sanitizeSourceControlPrefs({ activeSection: "garbage" }).activeSection).toBe("changes");
    expect(sanitizeSourceControlPrefs(null)).toEqual(DEFAULT_SOURCE_CONTROL_PREFS);
    expect(sanitizeSourceControlPrefs("nope")).toEqual(DEFAULT_SOURCE_CONTROL_PREFS);
  });
});

describe("migrateSourceControlState (F-31)", () => {
  it("moves the old flat default to the new tree default once", () => {
    const persisted = { prefsByScope: { repo: { viewMode: "flat" } } };

    expect(
      migrateSourceControlState(persisted, { legacyFlatAsTree: true }).prefsByScope.repo?.viewMode,
    ).toBe("tree");
    expect(migrateSourceControlState(persisted).prefsByScope.repo?.viewMode).toBe("flat");
  });

  it("survives a payload of any shape", () => {
    expect(migrateSourceControlState(undefined)).toEqual({
      isOpen: false,
      prefsByScope: {},
      commitDraftByScope: {},
      legacyCommitDraftByCwd: {},
    });
    expect(migrateSourceControlState("garbage")).toEqual({
      isOpen: false,
      prefsByScope: {},
      commitDraftByScope: {},
      legacyCommitDraftByCwd: {},
    });
    expect(migrateSourceControlState({ prefsByScope: 7, commitDraftByCwd: [] })).toEqual({
      isOpen: false,
      prefsByScope: {},
      commitDraftByScope: {},
      legacyCommitDraftByCwd: {},
    });
  });

  it("preserves global panel visibility only when it is a boolean", () => {
    expect(migrateSourceControlState({ isOpen: true }).isOpen).toBe(true);
    expect(migrateSourceControlState({ isOpen: "yes" }).isOpen).toBe(false);
  });

  it("drops non-string and empty drafts rather than persisting them", () => {
    const migrated = migrateSourceControlState({
      commitDraftByCwd: { "/a": "keep me", "/b": "", "/c": 12, "/d": null },
    });
    expect(migrated.legacyCommitDraftByCwd).toEqual({ "/a": "keep me" });
  });

  it("caps both maps, keeping the newest entries", () => {
    const prefsByScope: Record<string, unknown> = {};
    for (let index = 0; index < MAX_PERSISTED_PREF_SCOPES + 25; index += 1) {
      prefsByScope[`scope-${index}`] = { activeSection: "changes" };
    }
    const commitDraftByCwd: Record<string, string> = {};
    for (let index = 0; index < MAX_PERSISTED_COMMIT_DRAFTS + 25; index += 1) {
      commitDraftByCwd[`/repo-${index}`] = "draft";
    }

    const migrated = migrateSourceControlState({ prefsByScope, commitDraftByCwd });
    expect(Object.keys(migrated.prefsByScope)).toHaveLength(MAX_PERSISTED_PREF_SCOPES);
    expect(Object.keys(migrated.legacyCommitDraftByCwd)).toHaveLength(MAX_PERSISTED_COMMIT_DRAFTS);
    // The tail is the newest: zustand rewrites the whole map on every set.
    expect(migrated.prefsByScope[`scope-${MAX_PERSISTED_PREF_SCOPES + 24}`]).toBeDefined();
    expect(migrated.prefsByScope["scope-0"]).toBeUndefined();
  });

  it("validates every surviving scope", () => {
    const migrated = migrateSourceControlState({
      prefsByScope: { a: { filter: "not-a-filter", viewMode: "tree" } },
    });
    expect(migrated.prefsByScope.a?.filter).toBe("all");
    expect(migrated.prefsByScope.a?.viewMode).toBe("tree");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const cwd = "/shared/repo";
const scopeA = sourceControlDraftKey("server-a", cwd);
const scopeB = sourceControlDraftKey("server-b", cwd);
const getDraft = (scope: string) =>
  useSourceControlStore.getState().commitDraftByScope[scope] ?? "";
const setDraft = (scope: string, message: string) =>
  useSourceControlStore.getState().setCommitDraft(scope, message);
const confirmed = async () => "confirmed" as const;

describe("environment/worktree commit drafts", () => {
  it("isolates equal paths on different environments for reads, writes and clears", () => {
    setDraft(scopeA, "A message");
    setDraft(scopeB, "B message");
    expect(getDraft(scopeA)).toBe("A message");
    expect(getDraft(scopeB)).toBe("B message");
    useSourceControlStore.getState().clearCommitDraft(scopeA);
    expect(getDraft(scopeA)).toBe("");
    expect(getDraft(scopeB)).toBe("B message");
  });

  it("shares the draft between two threads in the same repository, not other worktrees", () => {
    const threads = [
      { id: "thread-1", environmentId: "server-a", cwd },
      { id: "thread-2", environmentId: "server-a", cwd },
      { id: "thread-3", environmentId: "server-a", cwd: "/shared/worktree" },
    ] as const;
    const keyFor = (thread: (typeof threads)[number]) =>
      sourceControlDraftKey(thread.environmentId, thread.cwd);
    setDraft(keyFor(threads[0]), "shared draft");
    expect(getDraft(keyFor(threads[1]))).toBe("shared draft");
    expect(getDraft(keyFor(threads[2]))).toBe("");
    setDraft(keyFor(threads[1]), "edited from thread 2");
    expect(getDraft(keyFor(threads[0]))).toBe("edited from thread 2");
    setDraft(keyFor(threads[2]), "worktree draft");
    expect(getDraft(keyFor(threads[0]))).toBe("edited from thread 2");
  });

  it("cannot collide on separators or accept legacy keys into the active store", () => {
    expect(sourceControlDraftKey("a:b", "c")).not.toBe(sourceControlDraftKey("a", "b:c"));
    setDraft(cwd, "ambiguous");
    setDraft(sourceControlDraftKey("server-a", ""), "missing path");
    expect(useSourceControlStore.getState().commitDraftByScope).toEqual({});
    setDraft(scopeA, "draft");
    setDraft(scopeA, "");
    expect(useSourceControlStore.getState().commitDraftByScope).toEqual({});
  });

  it("keeps delayed generation in its captured environment after the selected scope changes", async () => {
    let selected = scopeA;
    const response = deferred<string | null>();
    const confirm = vi.fn(confirmed);
    const pending = generateSourceControlDraft(selected, () => response.promise, confirm);
    selected = scopeB;
    setDraft(selected, "remote draft");
    response.resolve("generated for A");
    await pending;
    expect(getDraft(scopeA)).toBe("generated for A");
    expect(getDraft(selected)).toBe("remote draft");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("drops generation if the captured draft was edited while generating", async () => {
    setDraft(scopeA, "original");
    const response = deferred<string | null>();
    const confirm = vi.fn(confirmed);
    const pending = generateSourceControlDraft(scopeA, () => response.promise, confirm);
    setDraft(scopeA, "newer edit");
    response.resolve("stale generated text");
    await pending;
    expect(getDraft(scopeA)).toBe("newer edit");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("rechecks edits made while generation replacement confirmation is open", async () => {
    setDraft(scopeA, "original");
    const dialog = deferred<"confirmed">();
    const opened = deferred<void>();
    const pending = generateSourceControlDraft(
      scopeA,
      async () => "generated",
      () => {
        opened.resolve();
        return dialog.promise;
      },
    );
    await opened.promise;
    setDraft(scopeA, "new edit during dialog");
    dialog.resolve("confirmed");
    await pending;
    expect(getDraft(scopeA)).toBe("new edit during dialog");
  });

  it("requires confirmation to replace an untouched draft and preserves rejected/failed generation", async () => {
    setDraft(scopeA, "original");
    await generateSourceControlDraft(
      scopeA,
      async () => "generated",
      async () => "cancelled",
    );
    expect(getDraft(scopeA)).toBe("original");
    await generateSourceControlDraft(scopeA, async () => null, confirmed);
    expect(getDraft(scopeA)).toBe("original");
    await generateSourceControlDraft(scopeA, async () => "generated", confirmed);
    expect(getDraft(scopeA)).toBe("generated");
  });

  it("clears only the captured draft when a delayed commit finishes after a scope switch", async () => {
    let selected = scopeA;
    setDraft(selected, "commit A");
    const response = deferred<boolean>();
    const commit = vi.fn(() => response.promise);
    const pending = commitSourceControlDraft(selected, commit);
    selected = scopeB;
    setDraft(selected, "commit B");
    response.resolve(true);
    await expect(pending).resolves.toBe(true);
    expect(commit).toHaveBeenCalledWith("commit A");
    expect(getDraft(scopeA)).toBe("");
    expect(getDraft(selected)).toBe("commit B");
  });

  it("keeps newer edits made during commit/amend and keeps a failed commit's draft", async () => {
    setDraft(scopeA, "submitted");
    const response = deferred<boolean>();
    const pending = commitSourceControlDraft(scopeA, () => response.promise);
    setDraft(scopeA, "next commit");
    response.resolve(true);
    await pending;
    expect(getDraft(scopeA)).toBe("next commit");
    await expect(commitSourceControlDraft(scopeA, async () => false)).resolves.toBe(false);
    expect(getDraft(scopeA)).toBe("next commit");
  });
});

describe("explicit legacy draft recovery", () => {
  beforeEach(() => {
    useSourceControlStore.setState(
      migrateSourceControlState({
        commitDraftByCwd: { [cwd]: "legacy subject\n\nlegacy body" },
      }),
    );
  });

  it("never adopts on lookup and requires confirmation to move the legacy text", async () => {
    expect(getDraft(scopeA)).toBe("");
    expect(getDraft(scopeB)).toBe("");
    await expect(
      recoverSourceControlDraft({ environmentId: "server-a", cwd }, async () => "cancelled"),
    ).resolves.toBe(false);
    expect(getDraft(scopeA)).toBe("");
    expect(useSourceControlStore.getState().legacyCommitDraftByCwd[cwd]).toBe(
      "legacy subject\n\nlegacy body",
    );
    await expect(
      recoverSourceControlDraft({ environmentId: "server-a", cwd }, confirmed),
    ).resolves.toBe(true);
    expect(getDraft(scopeA)).toBe("legacy subject\n\nlegacy body");
    expect(useSourceControlStore.getState().legacyCommitDraftByCwd[cwd]).toBeUndefined();
    await expect(
      recoverSourceControlDraft({ environmentId: "server-b", cwd }, confirmed),
    ).resolves.toBe(false);
    expect(getDraft(scopeB)).toBe("");
  });

  it("does not overwrite an existing scoped draft or one edited while confirming", async () => {
    setDraft(scopeA, "existing");
    const confirm = vi.fn(confirmed);
    await expect(
      recoverSourceControlDraft({ environmentId: "server-a", cwd }, confirm),
    ).resolves.toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    setDraft(scopeA, "");
    const dialog = deferred<"confirmed">();
    const pending = recoverSourceControlDraft(
      { environmentId: "server-a", cwd },
      () => dialog.promise,
    );
    setDraft(scopeA, "edit while confirming");
    dialog.resolve("confirmed");
    await expect(pending).resolves.toBe(false);
    expect(getDraft(scopeA)).toBe("edit while confirming");
    expect(useSourceControlStore.getState().legacyCommitDraftByCwd[cwd]).toBeDefined();
  });

  it("discards the legacy draft only on explicit request, without touching scoped drafts", async () => {
    setDraft(scopeB, "other environment");
    await expect(
      recoverSourceControlDraft({ environmentId: "server-a", cwd }, async () => "alternative"),
    ).resolves.toBe(false);
    expect(useSourceControlStore.getState().legacyCommitDraftByCwd).toEqual({});
    expect(getDraft(scopeA)).toBe("");
    expect(getDraft(scopeB)).toBe("other environment");
    // Nothing left to recover: no dialog, no change.
    const confirm = vi.fn(confirmed);
    await expect(
      recoverSourceControlDraft({ environmentId: "server-a", cwd }, confirm),
    ).resolves.toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    expect(useSourceControlStore.getState().discardLegacyCommitDraft(cwd, "stale")).toBe(false);
  });

  it("captures the recovery destination and consumes the legacy draft only once", async () => {
    const dialog = deferred<"confirmed">();
    const pending = recoverSourceControlDraft(
      { environmentId: "server-a", cwd },
      () => dialog.promise,
    );
    setDraft(scopeB, "other environment");
    dialog.resolve("confirmed");
    await expect(pending).resolves.toBe(true);
    expect(getDraft(scopeB)).toBe("other environment");
    expect(
      useSourceControlStore
        .getState()
        .adoptLegacyCommitDraft(scopeB, cwd, "legacy subject\n\nlegacy body"),
    ).toBe(false);
  });

  it("migrates persisted v3 state, preserves preferences and does not resurrect adopted drafts after reload", async () => {
    const options = useSourceControlStore.persist.getOptions();
    const storageName = options.name;
    if (storageName === undefined) throw new Error("Missing source-control persistence key");
    const storage = createMemoryStorage();
    storage.setItem(
      storageName,
      JSON.stringify({
        version: 3,
        state: {
          isOpen: true,
          prefsByScope: { repo: { viewMode: "flat", filter: "modified" } },
          commitDraftByCwd: { [cwd]: "preserved text" },
        },
      }),
    );
    useSourceControlStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
    try {
      await useSourceControlStore.persist.rehydrate();
      expect(SOURCE_CONTROL_STORE_VERSION).toBe(4);
      expect(useSourceControlStore.getState().isOpen).toBe(true);
      expect(useSourceControlStore.getState().prefsByScope.repo).toMatchObject({
        viewMode: "flat",
        filter: "modified",
      });
      expect(getDraft(scopeA)).toBe("");
      expect(useSourceControlStore.getState().legacyCommitDraftByCwd).toEqual({
        [cwd]: "preserved text",
      });
      await recoverSourceControlDraft({ environmentId: "server-a", cwd }, confirmed);
      await useSourceControlStore.persist.rehydrate();
      expect(getDraft(scopeA)).toBe("preserved text");
      expect(getDraft(scopeB)).toBe("");
      expect(useSourceControlStore.getState().legacyCommitDraftByCwd).toEqual({});
      expect(await storage.getItem(storageName)).not.toContain('"commitDraftByCwd"');
    } finally {
      useSourceControlStore.persist.setOptions(options);
    }
  });
});

describe("scoped draft sanitation", () => {
  it("rejects malformed maps, noncanonical scope keys, empty and non-string values", () => {
    const migrated = migrateSourceControlState({
      commitDraftByScope: {
        [scopeA]: "keep",
        [scopeB]: "",
        [sourceControlDraftKey("c", cwd)]: 42,
        [sourceControlDraftKey("d", cwd)]: null,
        [cwd]: "legacy cannot become active",
        '["a"]': "missing path",
        '["a", "b"]': "not canonical",
        '["", "b"]': "empty environment",
        "{}": "not a scope",
      },
      legacyCommitDraftByCwd: { [cwd]: "recover", empty: "", malformed: false },
    });
    expect(migrated.commitDraftByScope).toEqual({ [scopeA]: "keep" });
    expect(migrated.legacyCommitDraftByCwd).toEqual({ [cwd]: "recover" });
    expect(
      migrateSourceControlState({ commitDraftByScope: ["bad"], legacyCommitDraftByCwd: ["bad"] })
        .commitDraftByScope,
    ).toEqual({});
    expect(
      migrateSourceControlState({ legacyCommitDraftByCwd: ["bad"] }).legacyCommitDraftByCwd,
    ).toEqual({});
  });

  it("bounds active drafts and recovery separately, preserving newest valid entries", () => {
    const active: Record<string, string> = {};
    const legacy: Record<string, string> = {};
    for (let index = 0; index < MAX_PERSISTED_COMMIT_DRAFTS + 5; index++) {
      active[sourceControlDraftKey("server-a", `/repo-${index}`)] = "active";
      legacy[`/repo-${index}`] = "legacy";
    }
    const migrated = migrateSourceControlState({
      commitDraftByScope: active,
      legacyCommitDraftByCwd: legacy,
    });
    expect(Object.keys(migrated.commitDraftByScope)).toHaveLength(MAX_PERSISTED_COMMIT_DRAFTS);
    expect(Object.keys(migrated.legacyCommitDraftByCwd)).toHaveLength(MAX_PERSISTED_COMMIT_DRAFTS);
    expect(
      migrated.commitDraftByScope[sourceControlDraftKey("server-a", "/repo-0")],
    ).toBeUndefined();
    expect(migrated.legacyCommitDraftByCwd["/repo-0"]).toBeUndefined();
  });
});

describe("selectSourceControlPrefs", () => {
  it("uses the folder tree for new repositories", () => {
    expect(DEFAULT_SOURCE_CONTROL_PREFS.viewMode).toBe("tree");
  });

  it("returns the module-level default object (stable identity, no render loop)", () => {
    expect(selectSourceControlPrefs({}, null)).toBe(DEFAULT_SOURCE_CONTROL_PREFS);
    expect(selectSourceControlPrefs({}, "missing")).toBe(DEFAULT_SOURCE_CONTROL_PREFS);
  });
});
