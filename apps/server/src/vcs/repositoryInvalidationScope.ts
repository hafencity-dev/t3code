// fork: resolve subscribed aliases to worktree roots, and linked worktrees to
// their shared refs/stash directory. Read-only metadata; no additional watcher.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export interface RepositoryInvalidationScope {
  readonly root: string;
  readonly commonDir: string | null;
}

export const resolveRepositoryInvalidationScope = Effect.fn("resolveRepositoryInvalidationScope")(
  function* (cwd: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const realPath = (value: string) => fs.realPath(value).pipe(Effect.orElseSucceed(() => value));
    const original = yield* realPath(cwd);
    let root = original;
    for (;;) {
      const marker = path.join(root, ".git");
      const stat = yield* fs.stat(marker).pipe(Effect.option);
      if (stat._tag === "Some") {
        let gitDir = marker;
        if (stat.value.type === "File") {
          const text = yield* fs.readFileString(marker).pipe(Effect.orElseSucceed(() => ""));
          if (!text.startsWith("gitdir: ")) return { root: original, commonDir: null };
          gitDir = path.resolve(root, text.slice(8).trim());
        }
        const common = yield* fs
          .readFileString(path.join(gitDir, "commondir"))
          .pipe(Effect.orElseSucceed(() => ""));
        return {
          root,
          commonDir: yield* realPath(common.trim() ? path.resolve(gitDir, common.trim()) : gitDir),
        };
      }
      const parent = path.dirname(root);
      if (parent === root) return { root: original, commonDir: null };
      root = parent;
    }
  },
);
