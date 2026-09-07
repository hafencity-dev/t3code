// fork: repository invalidation — the observer seam sits inside the service's
// guarded mutation lane, so reads and rejected cwds never notify.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import { WS_METHODS } from "@t3tools/contracts";
import type { VcsInvalidationDomain } from "@t3tools/contracts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderRegistry from "../../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import * as VcsDriverRegistry from "../VcsDriverRegistry.ts";
import type * as VcsProcess from "../VcsProcess.ts";
import * as WorkingCopy from "./WorkingCopyService.ts";
import { WorkingCopyService } from "./WorkingCopyService.ts";
import {
  makeWorkingCopyRpcHandlers,
  workingCopyMutationDomains,
} from "./workingCopyRpcHandlers.ts";

const TEST_EPOCH = "2024-01-01T00:00:00.000Z";
const REPO = "/work/proj";

const output = (exitCode: number, stderr = ""): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(exitCode),
  stdout: "",
  stderr,
  stdoutTruncated: false,
  stderrTruncated: false,
});

const makeLayer = (options: {
  readonly execute: (args: ReadonlyArray<string>) => VcsProcess.VcsProcessOutput;
}) =>
  WorkingCopy.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        resolve: (input) =>
          Effect.succeed({
            kind: "git" as const,
            repository: {
              kind: "git" as const,
              rootPath: input.cwd,
              metadataPath: null,
              freshness: { source: "live-local", observedAt: TEST_EPOCH, expiresAt: undefined },
            },
            driver: {
              execute: (input: { readonly args: ReadonlyArray<string> }) =>
                Effect.succeed(options.execute(input.args)),
            },
          } as never),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery)({
        getShellSnapshot: () =>
          Effect.succeed({
            snapshotSequence: 0,
            updatedAt: TEST_EPOCH,
            projects: [
              {
                id: "project-0",
                title: "project-0",
                workspaceRoot: REPO,
                defaultModelSelection: null,
                scripts: [],
                createdAt: TEST_EPOCH,
                updatedAt: TEST_EPOCH,
              },
            ],
            threads: [],
          } as never),
      }),
    ),
    Layer.provide(Layer.mock(TextGeneration.TextGeneration)({})),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

it("maps each mutation to the repository domains it can change", () => {
  assert.deepStrictEqual(workingCopyMutationDomains(WS_METHODS.workingCopyStagePaths), [
    "worktree",
  ]);
  assert.deepStrictEqual(workingCopyMutationDomains(WS_METHODS.workingCopyStashDrop), ["stashes"]);
  assert.deepStrictEqual(workingCopyMutationDomains(WS_METHODS.workingCopyStashPush), [
    "worktree",
    "stashes",
  ]);
  assert.deepStrictEqual(workingCopyMutationDomains(WS_METHODS.workingCopyCommitStaged), [
    "worktree",
    "refs",
    "stashes",
  ]);
});

it.effect(
  "notifies after settled mutations, including failures, but never for reads or denied cwds",
  () => {
    const notifications: Array<readonly [string, ReadonlyArray<VcsInvalidationDomain>]> = [];
    let gitCalls = 0;
    return Effect.gen(function* () {
      const workingCopy = yield* WorkingCopyService;
      const handlers = makeWorkingCopyRpcHandlers({
        workingCopy,
        observeRpcEffect: (_method, effect) => effect,
        refreshGitStatus: (cwd, domains = []) =>
          Effect.sync(() => {
            notifications.push([cwd, domains]);
          }),
      });

      yield* handlers[WS_METHODS.workingCopyStatus]({ cwd: REPO });
      assert.deepStrictEqual(notifications, []);

      const denied = yield* handlers[WS_METHODS.workingCopyStagePaths]({
        cwd: "/tmp/elsewhere",
        paths: ["a.ts"],
      }).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(denied));
      assert.equal(gitCalls, 0);
      assert.deepStrictEqual(notifications, []);

      // A batch that failed part-way is reported as a partial result; the
      // repository may have changed, so the client must still learn about it.
      const partial = yield* handlers[WS_METHODS.workingCopyStagePaths]({
        cwd: REPO,
        paths: ["a.ts"],
      });
      assert.isDefined(partial.failed);
      assert.isAbove(gitCalls, 0);
      assert.deepStrictEqual(notifications, [[REPO, ["worktree"]]]);

      // A hard failure propagates verbatim and still notifies.
      const failed = yield* handlers[WS_METHODS.workingCopyApplyPatch]({
        cwd: REPO,
        patch: "diff --git a/a.ts b/a.ts\n",
        cached: true,
        reverse: false,
      }).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(failed));
      assert.deepStrictEqual(notifications, [
        [REPO, ["worktree"]],
        [REPO, ["worktree"]],
      ]);

      const succeeded = yield* handlers[WS_METHODS.workingCopyStashDrop]({
        cwd: REPO,
        ref: "stash@{0}",
        expectedCommit: "0123456789012345678901234567890123456789",
        expectedIdentity: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      }).pipe(Effect.exit);
      assert.deepStrictEqual(notifications.length, 3);
      assert.deepStrictEqual(notifications[2], [REPO, ["stashes"]]);
      assert.isTrue(Exit.isFailure(succeeded) || Exit.isSuccess(succeeded));
    }).pipe(
      Effect.provide(
        makeLayer({
          execute: (args) => {
            if (args.includes("add")) {
              gitCalls += 1;
              return output(128, "fatal: pathspec 'a.ts' did not match any files");
            }
            if (args.includes("apply")) return output(1, "error: patch failed");
            return output(0);
          },
        }),
      ),
    );
  },
);
