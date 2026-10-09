import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, type OrchestrationV2ServerCommand } from "@t3tools/contracts";
import {
  encodeLegacy2CodeImportManifestJson,
  type Legacy2CodeImportManifest,
} from "@t3tools/shared/fork/legacy2codeImport";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Legacy2CodeImport from "./Legacy2codeImport.ts";

const SOURCE_SHA = "a".repeat(64);

const manifestFixture = {
  version: 1,
  source: {
    workspacePath: "/legacy/2code/workspace.json",
    sha256: SOURCE_SHA,
  },
  projects: [
    { legacyPath: "/work/new-project", title: "New Project" },
    { legacyPath: "/work/existing-project", title: "Existing Project" },
  ],
  threads: [
    {
      legacyId: "claude-session-1",
      projectPath: "/work/new-project",
      title: "Claude migration",
      subtitle: "Waiting for a follow-up",
      createdAt: "2026-08-06T12:34:56.789Z",
      model: "claude-opus-5",
      provider: "claude",
      resumeCursor: { resume: "claude-session-1" },
    },
    {
      legacyId: "codex-session-1",
      projectPath: "/work/existing-project",
      title: "Codex migration",
      provider: "codex",
      resumeCursor: { threadId: "codex-session-1" },
    },
  ],
  claudeCodexRouting: {
    enabled: true,
    model: "gpt-5.6-sol",
  },
  skippedSessions: 2,
  createdAt: "2026-08-08T08:00:00.000Z",
} as const satisfies Legacy2CodeImportManifest;

const testConfigLayer = () =>
  ServerConfig.layerTest("/work/test", { prefix: "t3-legacy-2code-import-test-" }).pipe(
    Layer.provide(NodeServices.layer),
  );
const testRuntimeLayer = () =>
  Layer.mergeAll(NodeServices.layer, testConfigLayer(), ServerSettings.layerTest());

const harness = Effect.gen(function* () {
  const commands: OrchestrationV2ServerCommand[] = [];
  const createdProjects: ProjectService.ProjectCreateInput[] = [];
  const existingThreads = new Set<string>();
  const existingProjectId = ProjectId.make("existing-project");
  const layer = Layer.merge(
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadShell: (id) => Effect.succeed(existingThreads.has(id) ? ({ id } as never) : null),
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
          if (command.type === "thread.create") existingThreads.add(command.threadId);
          return {} as never;
        }),
    }),
    Layer.mock(ProjectService.ProjectService)({
      getByWorkspaceRoot: (root) =>
        Effect.succeed(
          root === "/work/existing-project"
            ? Option.some({ id: existingProjectId } as never)
            : Option.none(),
        ),
      create: (input) =>
        Effect.sync(() => {
          createdProjects.push(input);
          return { id: input.projectId } as never;
        }),
    }),
  );
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const paths = Legacy2CodeImport.resolveLegacy2CodeImportPaths(config.stateDir, path);
  const write = Effect.gen(function* () {
    yield* fs.makeDirectory(path.dirname(paths.manifestPath), { recursive: true });
    yield* fs.writeFileString(
      paths.manifestPath,
      yield* encodeLegacy2CodeImportManifestJson(manifestFixture),
    );
  });
  return {
    commands,
    createdProjects,
    existingProjectId,
    paths,
    write,
    run: Legacy2CodeImport.importLegacy2CodeManifest.pipe(Effect.provide(layer)),
  };
});

describe("Legacy2codeImport V2", () => {
  it.effect("leaves a fresh install untouched when no legacy manifest exists", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      assert.equal((yield* h.run).status, "not-found");
      assert.isEmpty(h.commands);
      assert.isEmpty(h.createdProjects);
    }).pipe(Effect.provide(testRuntimeLayer())),
  );
  it.effect(
    "imports native sessions without starting turns and records an idempotent receipt",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.write;
        assert.equal((yield* h.run).status, "imported");
        assert.lengthOf(h.createdProjects, 1);
        assert.deepEqual(
          h.commands.map((c) => c.type),
          ["thread.create", "thread.create"],
        );
        const [claude, codex] = h.commands;
        assert.equal(claude?.type, "thread.create");
        assert.equal(codex?.type, "thread.create");
        if (claude?.type !== "thread.create" || codex?.type !== "thread.create") return;
        assert.equal(claude.projectId, h.createdProjects[0]?.projectId);
        assert.equal(codex.projectId, h.existingProjectId);
        assert.deepEqual(claude.importedNativeThread?.ref, {
          driver: "claudeAgent",
          nativeId: "claude-session-1",
          strength: "strong",
        });
        assert.deepEqual(codex.importedNativeThread?.ref, {
          driver: "codex",
          nativeId: "codex-session-1",
          strength: "strong",
        });
        assert.equal(claude.runtimeMode, "approval-required");
        const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
        assert.deepEqual(settings.providerInstances, {});
        assert.equal((yield* h.run).status, "already-imported");
        assert.lengthOf(h.commands, 2);
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(h.paths.receiptPathForSource(SOURCE_SHA));
        // A crash before receipt persistence reuses existing thread identifiers.
        yield* h.run;
        assert.lengthOf(h.commands, 2);
      }).pipe(Effect.provide(testRuntimeLayer())),
  );
  it.effect("does not import a malformed manifest", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.write;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(h.paths.manifestPath, "{}");
      assert.isTrue((yield* h.run.pipe(Effect.result))._tag === "Failure");
      assert.isEmpty(h.commands);
    }).pipe(Effect.provide(testRuntimeLayer())),
  );
});
