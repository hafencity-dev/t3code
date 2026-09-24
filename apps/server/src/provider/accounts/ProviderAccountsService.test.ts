// fork: provider accounts
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { NodeServices } from "@effect/platform-node";
import {
  OrchestrationShellSnapshot,
  ProviderAccountId,
  ProviderInstanceId,
  ProviderDriverKind,
  ServerProvider,
  WS_METHODS,
  type ProviderAccountsSnapshot,
} from "@t3tools/contracts";
import {
  Clock,
  Deferred,
  Effect,
  Fiber,
  Layer,
  PubSub,
  Queue,
  Schema,
  Scope,
  Stream,
} from "effect";
import { afterEach, beforeEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import * as ServerConfig from "../../config.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { makeProviderRegistryLayer } from "../testUtils/providerRegistryMock.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry, type ProviderRegistryShape } from "../Services/ProviderRegistry.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { ProviderAccountLogin, type ProviderAccountLoginOptions } from "./ProviderAccountLogin.ts";
import { createProviderAccountRegistry } from "./ProviderAccountRegistry.ts";
import { switchClaudeCredentials } from "./ClaudeCredentialSwitch.ts";
import {
  claudeTerminalSignedOutMessage,
  inactiveClaudeProbeEnvironment,
  ProviderAccountsService,
} from "./ProviderAccountsService.ts";
import { makeProviderAccountsRpcHandlers } from "./providerAccountsRpcHandlers.ts";
import type { AccountUsage, probeAccountUsage } from "./ProviderAccountUsage.ts";
import type { ClaudeWindowPrimeLaunch, runClaudeWindowPrime } from "./ClaudeWindowPrime.ts";

type Probe = typeof probeAccountUsage;
const idleProbe = () => Effect.never;

const codexId = ProviderInstanceId.make("codex");
const claudeId = ProviderInstanceId.make("claudeAgent");
const checkedAt = "2026-09-23T12:00:00.000Z";
const decodeProvider = Schema.decodeUnknownSync(ServerProvider);
const provider = decodeProvider({
  instanceId: "codex",
  driver: "codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated", email: "default@example.test", label: "Default plan" },
  checkedAt,
  models: [],
  usageLimits: { checkedAt, windows: [] },
});
const decodeShell = Schema.decodeUnknownSync(OrchestrationShellSnapshot);
const shell = decodeShell({
  snapshotSequence: 0,
  updatedAt: checkedAt,
  projects: [],
  threads: [],
});

describe("ProviderAccountsService", () => {
  let root: string;
  let seeded: { id: ProviderAccountId; homePath: string } | undefined;
  beforeEach(async () => {
    seeded = undefined;
    root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "provider-account-service-"));
  });
  afterEach(async () => {
    await NodeFSP.rm(root, { recursive: true, force: true });
  });

  function run<A, E>(
    program: Effect.Effect<
      A,
      E,
      | ProviderAccountsService
      | ServerConfig.ServerConfig
      | ServerSettings.ServerSettingsService
      | Scope.Scope
    >,
    seed: boolean | "low" = false,
    options: {
      login?: Parameters<typeof ProviderAccountsService.layerWithLogin>[0];
      before?: () => Promise<void>;
      claudeHomePath?: string;
      pending?: boolean;
      backoff?: boolean;
      runningClaude?: boolean;
      environment?: ReadonlyArray<{ name: string; value: string; sensitive: boolean }>;
      probe?: Probe;
      runPrime?: typeof runClaudeWindowPrime;
      refreshInstance?: ProviderRegistryShape["refreshInstance"];
      providers?: ReadonlyArray<ServerProvider>;
    } = {},
  ) {
    const snapshots = [provider, ...(options.providers ?? [])];
    const providerLayer = options.refreshInstance
      ? Layer.effect(
          ProviderRegistry,
          Effect.gen(function* () {
            const base = yield* ProviderRegistry;
            return ProviderRegistry.of({ ...base, refreshInstance: options.refreshInstance! });
          }),
        ).pipe(Layer.provide(makeProviderRegistryLayer(snapshots)))
      : makeProviderRegistryLayer(snapshots);
    const dependencies = Layer.mergeAll(
      ServerConfig.layerTest(root, NodePath.join(root, "state")),
      ServerSettings.layerTest({
        providers: {
          claudeAgent: { homePath: options.claudeHomePath ?? NodePath.join(root, "claude") },
          codex: { homePath: NodePath.join(root, "codex"), binaryPath: "never-spawn-this-cli" },
        },
        providerInstances: {
          ...(options.claudeHomePath === undefined
            ? {}
            : {
                [claudeId]: {
                  driver: ProviderDriverKind.make("claudeAgent"),
                  config: { homePath: options.claudeHomePath },
                  environment: [
                    {
                      name: "CLAUDE_CONFIG_DIR",
                      value: NodePath.join(root, "claude"),
                      sensitive: false,
                    },
                  ],
                },
              }),
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Keep this instance name",
            config: { homePath: NodePath.join(root, "codex"), binaryPath: "never-spawn-this-cli" },
            environment: options.environment ?? [
              { name: "OPENAI_API_KEY", value: "private-value", sensitive: true },
            ],
          },
        },
      }),
      providerLayer,
      Layer.mock(OrchestrationEngineService)({
        subscribeDomainEvents: Effect.succeed(Stream.empty),
      }),
      Layer.mock(ProjectionSnapshotQuery)({
        getShellSnapshot: () =>
          Effect.succeed(
            !options.runningClaude
              ? shell
              : decodeShell({
                  ...shell,
                  threads: [
                    {
                      id: "claude-running",
                      projectId: "project-1",
                      title: "Running Claude",
                      modelSelection: { instanceId: claudeId, model: "test-model" },
                      runtimeMode: "full-access",
                      branch: null,
                      worktreePath: null,
                      createdAt: checkedAt,
                      updatedAt: checkedAt,
                      latestTurn: null,
                      latestUserMessageAt: null,
                      hasPendingApprovals: false,
                      hasPendingUserInput: false,
                      hasActionableProposedPlan: false,
                      session: {
                        threadId: "claude-running",
                        providerName: "claudeAgent",
                        providerInstanceId: claudeId,
                        status: "running",
                        activeTurnId: "turn-1",
                        runtimeMode: "full-access",
                        lastError: null,
                        updatedAt: checkedAt,
                      },
                    },
                  ],
                }),
          ),
      }),
    );
    const instanceLayer = Layer.effect(
      ProviderInstanceRegistry,
      Effect.gen(function* () {
        const settings = yield* ServerSettings.ServerSettingsService;
        const bus = yield* PubSub.unbounded<void>();
        const instances = new Map<string, ProviderInstance>();
        return ProviderInstanceRegistry.of({
          getInstance: (instanceId) =>
            settings.getSettings.pipe(
              Effect.orDie,
              Effect.map((current) => {
                const key = `${instanceId}:${JSON.stringify(current)}`;
                let instance = instances.get(key);
                if (!instance) {
                  instance = {
                    instanceId,
                    driverKind: ProviderDriverKind.make(
                      instanceId === codexId ? "codex" : "claudeAgent",
                    ),
                    displayName: undefined,
                    enabled: true,
                    continuationIdentity: {
                      driverKind: ProviderDriverKind.make("codex"),
                      continuationKey: "test",
                    },
                    get snapshot(): never {
                      throw new Error("Unused snapshot");
                    },
                    get adapter(): never {
                      throw new Error("Unused adapter");
                    },
                    get textGeneration(): never {
                      throw new Error("Unused text generation");
                    },
                  };
                  instances.set(key, instance);
                }
                return instance;
              }),
            ),
          subscribeChanges: PubSub.subscribe(bus),
          streamChanges: Stream.fromPubSub(bus),
          listInstances: Effect.succeed([]),
          listUnavailable: Effect.succeed([]),
        });
      }),
    );
    return Effect.gen(function* () {
      if (options.before) yield* Effect.promise(options.before);
      if (seed) seeded = yield* seedManaged(seed === "low", options.pending, options.backoff);
      return yield* program.pipe(
        Effect.provide(
          options.login || options.probe
            ? ProviderAccountsService.layerWithLogin(
                options.login ?? ((loginOptions) => new ProviderAccountLogin(loginOptions)),
                // Completed logins probe in the background; never spawn a real CLI for it.
                options.probe ?? (idleProbe as unknown as Probe),
                options.runPrime,
              )
            : ProviderAccountsService.layer,
        ),
      );
    }).pipe(
      Effect.provide(instanceLayer),
      Effect.provide(dependencies),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  }

  const seedManaged = (low = false, pending = false, backoff = false) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const registry = yield* Effect.promise(() =>
        createProviderAccountRegistry({ stateDir: config.stateDir }),
      );
      yield* Effect.promise(() => registry.list("codex", "", NodePath.join(root, "codex")));
      const entry = yield* Effect.promise(() =>
        registry.createManaged({
          driver: "codex",
          label: "Other",
          sharedHomePath: NodePath.join(root, "codex"),
        }),
      );
      if (!pending)
        yield* Effect.promise(() =>
          registry.update(entry.id, {
            status: "ready",
            lastUsage: {
              ...(backoff
                ? {
                    lastAttemptAt: 0,
                    nextAllowedAt: 15 * 60_000,
                    consecutiveFailures: 1,
                    lastFailureKind: "rateLimited" as const,
                  }
                : {}),
              email: "other@example.test",
              checkedAt,
              ...(low
                ? {
                    usage: {
                      checkedAt,
                      windows: [
                        { id: "session", label: "5h", kind: "session" as const, usedPercent: 95 },
                      ],
                    },
                  }
                : {}),
            },
          }),
        );
      return { ...entry, id: ProviderAccountId.make(entry.id) };
    });

  /** Default plus saved Claude stores with distinct lineages, matching the service's paths. */
  async function seedClaudeStores(names: readonly string[]) {
    const stateDir = NodePath.join(root, "state/userdata");
    const activeHome = NodePath.join(root, "claude");
    const registry = await createProviderAccountRegistry({ stateDir });
    const group = await registry.list("claudeAgent", activeHome, activeHome, activeHome);
    const identity = (name: string) => ({
      emailAddress: `${name}@example.test`,
      accountUuid: `uuid-${name}`,
    });
    const credentials = (name: string) => ({
      claudeAiOauth: { accessToken: `access-${name}`, refreshToken: `refresh-${name}` },
    });
    await NodeFSP.mkdir(activeHome, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(activeHome, ".credentials.json"),
      JSON.stringify(credentials("default")),
    );
    await NodeFSP.writeFile(
      NodePath.join(activeHome, ".claude.json"),
      JSON.stringify({ oauthAccount: identity("default") }),
    );
    await registry.update(group.activeAccountId, {
      lastUsage: { email: "default@example.test", accountUuid: "uuid-default", checkedAt },
    });
    const ids: Record<string, string> = { default: group.activeAccountId };
    const homes: Record<string, string> = { default: activeHome };
    for (const name of names) {
      const entry = await registry.createManaged({
        driver: "claudeAgent",
        label: name,
        sharedHomePath: activeHome,
      });
      await registry.update(entry.id, {
        status: "ready",
        lastUsage: { email: `${name}@example.test`, accountUuid: `uuid-${name}`, checkedAt },
      });
      await NodeFSP.writeFile(
        NodePath.join(entry.homePath, ".credentials.json"),
        JSON.stringify(credentials(name)),
      );
      await NodeFSP.writeFile(
        NodePath.join(entry.homePath, ".claude.json"),
        JSON.stringify({ oauthAccount: identity(name) }),
      );
      ids[name] = entry.id;
      homes[name] = entry.homePath;
    }
    return { stateDir, activeHome, ids, homes, credentials, identity };
  }
  const readJson = (path: string) =>
    Effect.promise(async () => JSON.parse(await NodeFSP.readFile(path, "utf8")));
  const claudeGroup = (snapshot: ProviderAccountsSnapshot) =>
    snapshot.groups.find((group) => group.driver === "claudeAgent")!;

  it.effect(
    "captures defaults, uses active snapshots without probing, and renames labels only",
    () =>
      run(
        Effect.gen(function* () {
          const service = yield* ProviderAccountsService;
          const snapshot = yield* service.list();
          const codex = snapshot.groups.find((group) => group.driver === "codex")!;
          expect(codex.accounts).toHaveLength(1);
          expect(codex.accounts[0]).toMatchObject({
            active: true,
            email: "default@example.test",
            plan: "Default plan",
            usage: provider.usageLimits,
          });
          expect(codex.warning).toContain("OPENAI_API_KEY");
          expect(JSON.stringify(snapshot)).not.toContain("private-value");
          const refreshed = yield* service.refreshUsage({ force: true });
          expect(refreshed).toEqual(snapshot);
          yield* service.rename({ accountId: codex.activeAccountId!, label: "Personal" });
          const settings = yield* ServerSettings.ServerSettingsService;
          expect((yield* settings.getSettings).providerInstances[codexId]?.displayName).toBe(
            "Keep this instance name",
          );
          expect(
            (yield* service.list()).groups.find((group) => group.driver === "codex")?.accounts[0]
              ?.label,
          ).toBe("Personal");
        }),
      ),
  );

  it.effect(
    "switches only the shadow home and never assigns the old snapshot to the new account",
    () =>
      run(
        Effect.gen(function* () {
          const managed = seeded!;
          const service = yield* ProviderAccountsService;
          yield* service.list();
          const switched = yield* service.switchAccount({ accountId: managed.id });
          const active = switched.groups
            .find((group) => group.driver === "codex")
            ?.accounts.find((account) => account.active);
          expect(active).toMatchObject({ id: managed.id, email: "other@example.test" });
          expect(active?.usage).toBeUndefined();
          const settings = yield* ServerSettings.ServerSettingsService;
          expect((yield* settings.getSettings).providerInstances[codexId]?.config).toMatchObject({
            homePath: NodePath.join(root, "codex"),
            shadowHomePath: managed.homePath,
          });
          expect(yield* service.remove({ accountId: managed.id }).pipe(Effect.flip)).toMatchObject({
            _tag: "ProviderAccountError",
          });
        }),
        true,
      ),
  );

  it.effect("returns the changed-home warning as a typed RPC error without changing settings", () =>
    run(
      Effect.gen(function* () {
        const managed = seeded!;
        const service = yield* ProviderAccountsService;
        yield* service.list();
        const settings = yield* ServerSettings.ServerSettingsService;
        const current = yield* settings.getSettings;
        yield* settings.updateSettings({
          providerInstances: {
            ...current.providerInstances,
            [codexId]: {
              ...current.providerInstances[codexId]!,
              config: { homePath: NodePath.join(root, "changed-codex") },
            },
          },
        });
        const warning = (yield* service.list()).groups.find(
          (group) => group.driver === "codex",
        )?.warning;
        expect(warning).toContain("Codex home changed in Settings.");
        const handlers = makeProviderAccountsRpcHandlers({
          providerAccounts: service,
          currentSessionId: "test-session",
          observeRpcEffect: (_method, effect) => effect,
          observeRpcStream: (_method, stream) => stream,
        });
        const error = yield* handlers[WS_METHODS.providerAccountsSwitch]({
          accountId: managed.id,
        }).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "ProviderAccountError",
          message: expect.stringContaining("restore it in Settings to switch."),
        });
        expect((yield* settings.getSettings).providerInstances[codexId]?.config).toEqual({
          homePath: NodePath.join(root, "changed-codex"),
        });
      }),
      true,
    ),
  );

  it.effect("forgets external accounts without logging out or deleting their homes", () =>
    run(
      Effect.gen(function* () {
        const externalHome = NodePath.join(root, "external");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(externalHome);
          await NodeFSP.writeFile(NodePath.join(externalHome, "auth.json"), "leave-me-alone");
        });
        const service = yield* ProviderAccountsService;
        const initial = yield* service.list();
        const defaultId = initial.groups.find(
          (group) => group.driver === "codex",
        )!.activeAccountId!;
        expect(yield* service.remove({ accountId: defaultId }).pipe(Effect.flip)).toMatchObject({
          _tag: "ProviderAccountError",
        });
        const settings = yield* ServerSettings.ServerSettingsService;
        const current = yield* settings.getSettings;
        yield* settings.updateSettings({
          providerInstances: {
            ...current.providerInstances,
            [codexId]: {
              ...current.providerInstances[codexId]!,
              config: { homePath: NodePath.join(root, "codex"), shadowHomePath: externalHome },
            },
          },
        });
        const externalId = (yield* service.list()).groups.find(
          (group) => group.driver === "codex",
        )!.activeAccountId!;
        yield* service.switchAccount({ accountId: defaultId });
        const removed = yield* service.remove({ accountId: externalId });
        expect(
          removed.groups
            .flatMap((group) => group.accounts)
            .some((entry) => entry.id === externalId),
        ).toBe(false);
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(externalHome, "auth.json"), "utf8"),
          ),
        ).toBe("leave-me-alone");
      }),
    ),
  );
  it.effect("defaults auto-switch off and persists validated environment settings", () =>
    run(
      Effect.gen(function* () {
        const service = yield* ProviderAccountsService;
        const initial = yield* service.list();
        expect(
          initial.groups.every(
            (group) =>
              !group.autoSwitch.enabled &&
              group.autoSwitch.state === "off" &&
              group.autoSwitch.thresholdPercent === 10,
          ),
        ).toBe(true);
        const enabled = yield* service.setAutoSwitch({
          driver: "codex",
          enabled: true,
          thresholdPercent: 25,
        });
        expect(enabled.groups.find((group) => group.driver === "codex")?.autoSwitch).toMatchObject({
          enabled: true,
          thresholdPercent: 25,
        });
        for (const thresholdPercent of [4, 51, 10.5]) {
          expect(
            yield* service
              .setAutoSwitch({ driver: "codex", enabled: true, thresholdPercent })
              .pipe(Effect.flip),
          ).toMatchObject({ _tag: "ProviderAccountError" });
        }
        yield* service.setAutoSwitch({ driver: "codex", enabled: false });
        const config = yield* ServerConfig.ServerConfig;
        const persisted = yield* Effect.promise(async () => {
          const registry = await createProviderAccountRegistry({ stateDir: config.stateDir });
          return registry.getAutoSwitch("codex");
        });
        expect(persisted).toEqual({ enabled: false, thresholdPercent: 25 });
        expect(
          (yield* service.list()).groups.find((group) => group.driver === "codex")?.autoSwitch
            .state,
        ).toBe("off");
      }),
    ),
  );

  it.effect("records the manual hold after switching, including a same-account selection", () =>
    run(
      Effect.gen(function* () {
        const service = yield* ProviderAccountsService;
        const now = yield* Clock.currentTimeMillis;
        yield* service.switchAccount({ accountId: seeded!.id });
        yield* service.switchAccount({ accountId: seeded!.id });
        const config = yield* ServerConfig.ServerConfig;
        const persisted = yield* Effect.promise(async () => {
          const registry = await createProviderAccountRegistry({ stateDir: config.stateDir });
          return registry.getAutoSwitch("codex");
        });
        expect(persisted.manual).toEqual({
          at: now,
          holdUntil: now + 2 * 60 * 60_000,
          activeWasBelowThreshold: false,
        });
        expect(persisted.lastSwitch).toBeUndefined();
      }),
      true,
    ),
  );
  it.effect("remembers when the manually selected account was already below threshold", () =>
    run(
      Effect.gen(function* () {
        const service = yield* ProviderAccountsService;
        yield* service.switchAccount({ accountId: seeded!.id });
        const config = yield* ServerConfig.ServerConfig;
        const persisted = yield* Effect.promise(async () => {
          const registry = await createProviderAccountRegistry({ stateDir: config.stateDir });
          return registry.getAutoSwitch("codex");
        });
        expect(persisted.manual?.activeWasBelowThreshold).toBe(true);
      }),
      "low",
    ),
  );
  it.effect(
    "hot-switches Claude during a running turn without changing settings and routes active re-login home",
    () => {
      let callbacks: ProviderAccountLoginOptions;
      return run(
        Effect.gen(function* () {
          const service = yield* ProviderAccountsService;
          const initial = (yield* service.list()).groups.find(
            (group) => group.driver === "claudeAgent",
          )!;
          const prepared = yield* Effect.promise(() =>
            callbacks.prepare({ driver: "claudeAgent", label: "Claude work" }),
          );
          yield* Effect.promise(async () => {
            const activeHome = NodePath.join(root, "claude");
            await NodeFSP.mkdir(activeHome, { recursive: true });
            await NodeFSP.writeFile(
              NodePath.join(activeHome, ".credentials.json"),
              JSON.stringify({
                claudeAiOauth: {
                  accessToken: "test-default",
                  refreshToken: "test-default-refresh",
                },
                mcpOAuth: { keep: true },
              }),
            );
            await NodeFSP.writeFile(
              NodePath.join(activeHome, ".claude.json"),
              JSON.stringify({
                oauthAccount: { emailAddress: "default-claude@example.test" },
                theme: "dark",
              }),
            );
            await NodeFSP.writeFile(
              NodePath.join(prepared.homePath, ".credentials.json"),
              JSON.stringify({
                claudeAiOauth: {
                  accessToken: "test-managed",
                  refreshToken: "test-managed-refresh",
                },
              }),
            );
            await NodeFSP.writeFile(
              NodePath.join(prepared.homePath, ".claude.json"),
              JSON.stringify({
                oauthAccount: { emailAddress: "claude@example.test" },
              }),
            );
            await callbacks.complete(prepared, { email: "claude@example.test" });
          });
          const settings = yield* ServerSettings.ServerSettingsService;
          const before = yield* settings.getSettings;
          const switched = yield* service.switchAccount({
            accountId: ProviderAccountId.make(prepared.accountId),
            interruptRunning: true,
          });
          expect(switched.groups.find((group) => group.driver === "claudeAgent")).toMatchObject({
            switchMode: "hot",
            activeAccountId: prepared.accountId,
          });
          expect(yield* settings.getSettings).toEqual(before);
          const relogin = yield* Effect.promise(() =>
            callbacks.prepare({
              driver: "claudeAgent",
              accountId: ProviderAccountId.make(prepared.accountId),
            }),
          );
          expect(relogin.homePath).toBe(NodePath.join(root, "claude"));
          expect(relogin.claudeActive).toBe(true);
          // A terminal login replaced the checked-out identity while its sessions kept running.
          yield* Effect.promise(async () => {
            await NodeFSP.writeFile(
              NodePath.join(relogin.homePath, ".credentials.json"),
              JSON.stringify({
                claudeAiOauth: {
                  accessToken: "test-terminal",
                  refreshToken: "test-terminal-refresh",
                },
                mcpOAuth: { keep: true },
              }),
            );
            await NodeFSP.writeFile(
              NodePath.join(relogin.homePath, ".claude.json"),
              JSON.stringify({
                oauthAccount: { emailAddress: "terminal@example.test" },
                theme: "dark",
              }),
            );
          });
          const restored = yield* service.switchAccount({ accountId: initial.activeAccountId! });
          const accounts = restored.groups.find(
            (group) => group.driver === "claudeAgent",
          )!.accounts;
          expect(accounts.find((account) => account.id === prepared.accountId)).toMatchObject({
            status: "signedOut",
            message: claudeTerminalSignedOutMessage,
          });
          expect(
            accounts.find((account) => account.email === "terminal@example.test"),
          ).toMatchObject({
            kind: "managed",
            active: false,
            status: "ready",
          });
          expect((yield* settings.getSettings).providerInstances[claudeId]?.config).toMatchObject({
            homePath: "",
          });
        }),
        false,
        {
          claudeHomePath: "",
          runningClaude: true,
          login: (options) => {
            callbacks = options;
            return new ProviderAccountLogin(options);
          },
        },
      );
    },
  );

  for (const identity of ["other@example.test", "new@example.test", "default@example.test"]) {
    it.effect(`re-login persists authoritative identity ${identity}`, () => {
      let callbacks: ProviderAccountLoginOptions;
      return run(
        Effect.gen(function* () {
          const service = yield* ProviderAccountsService;
          const prepared = yield* Effect.promise(() =>
            callbacks.prepare({ driver: "codex", accountId: seeded!.id }),
          );
          const outcome = yield* Effect.promise(() =>
            callbacks.complete(prepared, { email: identity, plan: "Updated plan" }),
          );
          const account = (yield* service.list()).groups
            .flatMap((group) => group.accounts)
            .find((entry) => entry.id === seeded!.id)!;
          expect(account).toMatchObject({
            email: identity,
            plan: "Updated plan",
            status: identity === "default@example.test" ? "error" : "ready",
          });
          if (identity === "default@example.test") {
            expect(account.message).toBe(
              "Signed in as default@example.test, which is already saved as Default. Sign in again with the right account.",
            );
            expect(outcome).toEqual({ message: account.message });
            expect(
              yield* service.switchAccount({ accountId: account.id }).pipe(Effect.flip),
            ).toMatchObject({ _tag: "ProviderAccountError", message: account.message });
            yield* service.refreshUsage({ accountIds: [account.id], force: true });
            expect(
              (yield* service.list()).groups
                .flatMap((group) => group.accounts)
                .find((entry) => entry.id === account.id)?.status,
            ).toBe("error");
            yield* Effect.promise(() =>
              callbacks.complete(prepared, { email: "corrected@example.test" }),
            );
            const corrected = (yield* service.list()).groups
              .flatMap((group) => group.accounts)
              .find((entry) => entry.id === account.id)!;
            expect(corrected).toMatchObject({ status: "ready", email: "corrected@example.test" });
            expect(corrected.message).toBeUndefined();
          } else expect(outcome).toBeUndefined();
        }),
        true,
        {
          login: (options) => {
            callbacks = options;
            return new ProviderAccountLogin(options);
          },
        },
      );
    });
  }

  it.effect(
    "re-login of Default or of an account's own identity is never rejected as a duplicate",
    () => {
      let callbacks: ProviderAccountLoginOptions;
      const codexAccounts = (snapshot: ProviderAccountsSnapshot) =>
        snapshot.groups.find((group) => group.driver === "codex")!.accounts;
      return run(
        Effect.gen(function* () {
          const service = yield* ProviderAccountsService;
          const initial = codexAccounts(yield* service.list());
          const defaultId = initial.find((account) => account.kind === "default")!.id;
          yield* service.switchAccount({ accountId: seeded!.id });
          // Default signs in as the identity already saved for Other: Default must stay repairable.
          const relogin = yield* Effect.promise(() =>
            callbacks.prepare({ driver: "codex", accountId: defaultId }),
          );
          const outcome = yield* Effect.promise(() =>
            callbacks.complete(relogin, { email: "Other@Example.test" }),
          );
          expect(outcome).toBeUndefined();
          const afterDefault = codexAccounts(yield* service.list());
          const repaired = afterDefault.find((account) => account.id === defaultId)!;
          expect(repaired).toMatchObject({ status: "ready", email: "Other@Example.test" });
          expect(repaired.message).toBeUndefined();
          // The other copy is the one flagged, so it can be removed.
          expect(afterDefault.find((account) => account.id === seeded!.id)).toMatchObject({
            duplicateOf: defaultId,
          });
          // The flagged copy signing in again as its own identity is not rejected either.
          const own = yield* Effect.promise(() =>
            callbacks.prepare({ driver: "codex", accountId: seeded!.id }),
          );
          expect(
            yield* Effect.promise(() => callbacks.complete(own, { email: "other@example.test" })),
          ).toBeUndefined();
          const copy = codexAccounts(yield* service.list()).find(
            (account) => account.id === seeded!.id,
          )!;
          expect(copy).toMatchObject({ status: "ready", duplicateOf: defaultId });
          expect(copy.message).toBeUndefined();
        }),
        true,
        {
          login: (options) => {
            callbacks = options;
            return new ProviderAccountLogin(options);
          },
        },
      );
    },
  );

  it.effect("labels a new login without a name with its email and keeps list order", () => {
    let callbacks: ProviderAccountLoginOptions;
    const codexAccounts = (snapshot: ProviderAccountsSnapshot) =>
      snapshot.groups.find((group) => group.driver === "codex")!.accounts;
    return run(
      Effect.gen(function* () {
        const service = yield* ProviderAccountsService;
        const unnamed = yield* Effect.promise(() => callbacks.prepare({ driver: "codex" }));
        expect(unnamed.unnamed).toBe(true);
        yield* Effect.promise(() => callbacks.complete(unnamed, { email: "new@example.test" }));
        const named = yield* Effect.promise(() =>
          callbacks.prepare({ driver: "codex", label: "Work" }),
        );
        expect(named.unnamed).toBeUndefined();
        yield* Effect.promise(() => callbacks.complete(named, { email: "work@example.test" }));
        const accounts = codexAccounts(yield* service.list());
        expect(accounts.map((account) => account.label)).toEqual([
          "Default",
          "Other",
          "new@example.test",
          "Work",
        ]);
        // Renaming never moves an account to the end of the list.
        yield* service.rename({ accountId: seeded!.id, label: "Renamed" });
        expect(codexAccounts(yield* service.list()).map((account) => account.label)).toEqual([
          "Default",
          "Renamed",
          "new@example.test",
          "Work",
        ]);
      }),
      true,
      {
        login: (options) => {
          callbacks = options;
          return new ProviderAccountLogin(options);
        },
      },
    );
  });

  it.effect("pending managed re-login can finish with a previously unknown identity", () => {
    let callbacks: ProviderAccountLoginOptions;
    return run(
      Effect.gen(function* () {
        const service = yield* ProviderAccountsService;
        const prepared = yield* Effect.promise(() =>
          callbacks.prepare({ driver: "codex", accountId: seeded!.id }),
        );
        expect(prepared.existing).toBe(false);
        yield* Effect.promise(() => callbacks.complete(prepared, { email: "first@example.test" }));
        const account = (yield* service.list()).groups
          .flatMap((group) => group.accounts)
          .find((entry) => entry.id === seeded!.id)!;
        expect(account).toMatchObject({ status: "ready", email: "first@example.test" });
      }),
      true,
      {
        pending: true,
        login: (options) => {
          callbacks = options;
          return new ProviderAccountLogin(options);
        },
      },
    );
  });

  it.effect("cancelling a pending managed re-login removes its home and registry entry", () => {
    let callbacks: ProviderAccountLoginOptions;
    return run(
      Effect.gen(function* () {
        const service = yield* ProviderAccountsService;
        const prepared = yield* Effect.promise(() =>
          callbacks.prepare({ driver: "codex", accountId: seeded!.id }),
        );
        expect(prepared.existing).toBe(false);
        yield* Effect.promise(() => callbacks.cleanup(prepared));
        expect(
          (yield* service.list()).groups
            .flatMap((group) => group.accounts)
            .some((entry) => entry.id === seeded!.id),
        ).toBe(false);
        expect(
          yield* Effect.promise(() =>
            NodeFSP.stat(seeded!.homePath).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false);
      }),
      true,
      {
        pending: true,
        login: (options) => {
          callbacks = options;
          return new ProviderAccountLogin(options);
        },
      },
    );
  });

  it.effect("publishes mutation invalidations to multiple subscribers without replay", () => {
    let callbacks: ProviderAccountLoginOptions;
    return run(
      Effect.gen(function* () {
        const service = yield* ProviderAccountsService;
        const first = yield* Stream.toQueue(service.autoSwitchEvents, { capacity: "unbounded" });
        const second = yield* Stream.toQueue(service.autoSwitchEvents, { capacity: "unbounded" });
        const expectChanged = Effect.gen(function* () {
          expect(yield* Queue.take(first)).toEqual({ _tag: "changed", driver: "codex" });
          expect(yield* Queue.take(second)).toEqual({ _tag: "changed", driver: "codex" });
        });
        yield* service.rename({ accountId: seeded!.id, label: "Renamed" });
        yield* expectChanged;
        yield* service.setAutoSwitch({ driver: "codex", enabled: false, thresholdPercent: 15 });
        yield* expectChanged;
        const prepared = yield* Effect.promise(() =>
          callbacks.prepare({ driver: "codex", accountId: seeded!.id }),
        );
        yield* Effect.promise(() => callbacks.complete(prepared, { email: "other@example.test" }));
        yield* expectChanged;
        yield* service.switchAccount({ accountId: seeded!.id });
        yield* expectChanged;
        const third = yield* Stream.toQueue(service.autoSwitchEvents, { capacity: "unbounded" });
        yield* service.rename({ accountId: seeded!.id, label: "Latest" });
        yield* expectChanged;
        expect(yield* Queue.take(third)).toEqual({ _tag: "changed", driver: "codex" });
        expect(yield* Queue.size(third)).toBe(0);
      }),
      true,
      {
        login: (options) => {
          callbacks = options;
          return new ProviderAccountLogin(options);
        },
      },
    );
  });

  it.effect("probes a signed-in account once after login, within the shared budget", () => {
    let callbacks: ProviderAccountLoginOptions;
    let calls = 0;
    const probe: Probe = (() =>
      Effect.sync(() => {
        calls++;
        return {
          checkedAt,
          status: "ready",
          usage: {
            checkedAt,
            windows: [{ id: "s", label: "5h", kind: "session", usedPercent: 42 }],
          },
        } satisfies AccountUsage;
      })) as unknown as Probe;
    return run(
      Effect.gen(function* () {
        const service = yield* ProviderAccountsService;
        const events = yield* Stream.toQueue(service.autoSwitchEvents, { capacity: "unbounded" });
        const prepared = yield* Effect.promise(() =>
          callbacks.prepare({ driver: "codex", accountId: seeded!.id }),
        );
        // Login publishes once on completion and once more after its background probe.
        const signIn = Effect.gen(function* () {
          yield* Effect.promise(() =>
            callbacks.complete(prepared, { email: "other@example.test" }),
          );
          expect(yield* Queue.take(events)).toEqual({ _tag: "changed", driver: "codex" });
          expect(yield* Queue.take(events)).toEqual({ _tag: "changed", driver: "codex" });
        });
        yield* signIn;
        expect(calls).toBe(1);
        const account = (yield* service.list()).groups
          .flatMap((group) => group.accounts)
          .find((entry) => entry.id === seeded!.id)!;
        expect(account.usage?.windows[0]?.usedPercent).toBe(42);
        // Each sign-in bypasses the per-account floor, but the 6-per-5-minute budget holds.
        for (let attempt = 0; attempt < 6; attempt++) yield* signIn;
        expect(calls).toBe(6);
      }),
      true,
      {
        probe,
        login: (options) => {
          callbacks = options;
          return new ProviderAccountLogin(options);
        },
      },
    );
  });

  it.effect("expands provider environment home variables consistently for login", () => {
    let callbacks: ProviderAccountLoginOptions;
    return run(
      Effect.gen(function* () {
        const prepared = yield* Effect.promise(() =>
          callbacks.prepare({ driver: "codex", accountId: seeded!.id }),
        );
        expect(prepared.environment?.CODEX_HOME).toBe(
          NodePath.join(NodeOS.homedir(), "probe-home"),
        );
        expect(prepared.environment?.LITERAL).toBe("~/literal");
      }),
      true,
      {
        environment: [
          { name: "CODEX_HOME", value: "~/probe-home", sensitive: false },
          { name: "LITERAL", value: "~/literal", sensitive: false },
        ],
        login: (options) => {
          callbacks = options;
          return new ProviderAccountLogin(options);
        },
      },
    );
  });

  it.effect("retries registry loading after a transient invalid file is repaired", () =>
    run(
      Effect.gen(function* () {
        const service = yield* ProviderAccountsService;
        expect(yield* service.list().pipe(Effect.flip)).toMatchObject({
          _tag: "ProviderAccountError",
        });
        yield* Effect.promise(() =>
          NodeFSP.rm(NodePath.join(root, "state/userdata/fork/provider-accounts/accounts.json")),
        );
        expect((yield* service.list()).groups).toHaveLength(2);
      }),
      false,
      {
        before: async () => {
          const directory = NodePath.join(root, "state/userdata/fork/provider-accounts");
          await NodeFSP.mkdir(directory, { recursive: true });
          await NodeFSP.writeFile(NodePath.join(directory, "accounts.json"), "temporarily invalid");
        },
      },
    ),
  );
  it.effect("returns persisted usage backoff without spawning even for forced refresh", () =>
    run(
      Effect.gen(function* () {
        const service = yield* ProviderAccountsService;
        const result = yield* service.refreshUsage({ accountIds: [seeded!.id], force: true });
        const account = result.groups
          .flatMap((group) => group.accounts)
          .find((entry) => entry.id === seeded!.id)!;
        expect(account.status).toBe("ready");
        expect(account.usageRefresh).toEqual({
          nextAllowedAt: new Date(15 * 60_000).toISOString(),
          rateLimited: true,
        });
      }),
      true,
      { backoff: true },
    ),
  );
  it.effect("warns and refuses hot switching when Claude home points inside saved stores", () =>
    run(
      Effect.gen(function* () {
        const service = yield* ProviderAccountsService;
        const group = (yield* service.list()).groups.find(
          (entry) => entry.driver === "claudeAgent",
        )!;
        const message =
          "Claude home points at a saved account store. Reset the Claude config directory in Settings to use hot switching.";
        expect(group.warning).toBe(message);
        expect(
          yield* service
            .switchAccount({ accountId: group.activeAccountId!, interruptRunning: true })
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "ProviderAccountError", message });
      }),
      false,
      {
        claudeHomePath: NodePath.join(
          root,
          "state/userdata/fork/provider-accounts/claude/old-store",
        ),
      },
    ),
  );
  // H3: an unfinished journal locks Claude credential operations, list() only warns, and
  // recovery is retried on the next mutation once the cause is repaired.
  it.effect("locks Claude operations behind an unrecoverable journal until it is repaired", () => {
    let seeded: Awaited<ReturnType<typeof seedClaudeStores>>;
    let callbacks: ProviderAccountLoginOptions;
    const probe = vi.fn();
    return run(
      Effect.gen(function* () {
        const service = yield* ProviderAccountsService;
        const settings = yield* ServerSettings.ServerSettingsService;
        const group = claudeGroup(yield* service.list());
        expect(group.warning).toContain("A previous Claude account switch didn't finish:");
        expect(group.warning).toContain("Accounts are locked until it's resolved.");
        const target = ProviderAccountId.make(seeded.ids.b!);
        for (const attempt of [
          service.switchAccount({ accountId: target }),
          service.remove({ accountId: target }),
        ]) {
          expect(yield* attempt.pipe(Effect.flip)).toMatchObject({
            _tag: "ProviderAccountError",
            message: expect.stringContaining("A previous Claude account switch didn't finish:"),
          });
        }
        yield* Effect.promise(() =>
          expect(callbacks.prepare({ driver: "claudeAgent", label: "New" })).rejects.toMatchObject({
            message: expect.stringContaining("A previous Claude account switch didn't finish:"),
          }),
        );
        const refreshed = claudeGroup(
          yield* service.refreshUsage({ accountIds: [target], force: true }),
        );
        expect(probe).not.toHaveBeenCalled();
        expect(refreshed.accounts.find((account) => account.id === target)?.usageRefresh).toBe(
          undefined,
        );
        expect(
          (yield* readJson(NodePath.join(seeded.activeHome, ".credentials.json"))).claudeAiOauth,
        ).toEqual(seeded.credentials("terminal").claudeAiOauth);
        // Codex stays usable throughout.
        yield* service.rename({
          accountId: claudeGroup(yield* service.list()).activeAccountId!,
          label: "Still renames",
        });
        // Repair: the terminal user signs back in as the checked-out account.
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(seeded.activeHome, ".claude.json"),
            JSON.stringify({ oauthAccount: seeded.identity("default") }),
          ),
        );
        const switched = claudeGroup(yield* service.switchAccount({ accountId: target }));
        expect(switched.warning).toBeUndefined();
        expect(switched.activeAccountId).toBe(target);
        expect(yield* settings.getSettings).toEqual(yield* settings.getSettings);
      }),
      false,
      {
        claudeHomePath: NodePath.join(root, "claude"),
        probe: probe as unknown as Probe,
        login: (options) => {
          callbacks = options;
          return new ProviderAccountLogin(options);
        },
        before: async () => {
          seeded = await seedClaudeStores(["b"]);
          const registry = await createProviderAccountRegistry({ stateDir: seeded.stateDir });
          const source = await registry.ensureClaudeStore(seeded.ids.default!);
          await expect(
            switchClaudeCredentials(
              {
                stateDir: seeded.stateDir,
                managedRoot: NodePath.join(seeded.stateDir, "fork/provider-accounts/claude"),
                activeHome: seeded.activeHome,
                activeConfigPath: NodePath.join(seeded.activeHome, ".claude.json"),
                activeConfigDir: seeded.activeHome,
                sourceStore: source.storePath!,
                sourceAccountId: source.id,
                targetStore: seeded.homes.b!,
                targetAccountId: seeded.ids.b!,
                commit: async () => undefined,
              },
              {
                afterPhase: async (phase) => {
                  if (phase === "prepared") throw new Error("simulated crash");
                },
              },
            ),
          ).rejects.toThrow("simulated crash");
          // A terminal login replaced the identity before recovery could run.
          await NodeFSP.writeFile(
            NodePath.join(seeded.activeHome, ".credentials.json"),
            JSON.stringify(seeded.credentials("terminal")),
          );
          await NodeFSP.writeFile(
            NodePath.join(seeded.activeHome, ".claude.json"),
            JSON.stringify({ oauthAccount: seeded.identity("terminal") }),
          );
        },
      },
    );
  });

  // H5: a Claude home edited in Settings is surfaced and blocks hot switching, like Codex.
  it.effect(
    "refuses hot switching while the Claude config directory differs from the captured one",
    () =>
      run(
        Effect.gen(function* () {
          const service = yield* ProviderAccountsService;
          const initial = claudeGroup(yield* service.list());
          const defaultId = initial.activeAccountId!;
          const settings = yield* ServerSettings.ServerSettingsService;
          const current = yield* settings.getSettings;
          yield* settings.updateSettings({
            providerInstances: {
              ...current.providerInstances,
              [claudeId]: {
                ...current.providerInstances[claudeId]!,
                config: { homePath: NodePath.join(root, "claude-moved") },
              },
            },
          });
          const moved = claudeGroup(yield* service.list());
          const message =
            "Claude config directory changed in Settings. Restore it to switch accounts.";
          expect(moved.warning).toBe(message);
          expect(moved.accounts.find((account) => account.active)?.kind).toBe("external");
          expect(
            yield* service.switchAccount({ accountId: defaultId }).pipe(Effect.flip),
          ).toMatchObject({ _tag: "ProviderAccountError", message });
          expect(
            yield* Effect.promise(() =>
              NodeFSP.stat(NodePath.join(root, "claude-moved")).then(
                () => true,
                () => false,
              ),
            ),
          ).toBe(false);
        }),
        false,
        { claudeHomePath: NodePath.join(root, "claude") },
      ),
  );

  // H6 + H10: inactive-store probes run without login overrides and are dropped if the
  // account was checked out while they ran.
  it("strips login overrides from inactive Claude probe environments", () => {
    expect(
      inactiveClaudeProbeEnvironment({
        CLAUDE_SECURESTORAGE_CONFIG_DIR: "/elsewhere",
        CLAUDE_CODE_OAUTH_TOKEN: "token",
        CLAUDE_CONFIG_DIR: "/store",
        PATH: "/bin",
      }),
    ).toEqual({ CLAUDE_CONFIG_DIR: "/store", PATH: "/bin" });
  });

  it.effect("probes inactive Claude stores without token overrides", () => {
    let seeded: Awaited<ReturnType<typeof seedClaudeStores>>;
    const environments: NodeJS.ProcessEnv[] = [];
    const probe: Probe = ((input: Parameters<Probe>[0]) => {
      environments.push(input.environment);
      return Effect.succeed({
        checkedAt,
        status: "ready",
        usage: { checkedAt, windows: [] },
      } satisfies AccountUsage);
    }) as unknown as Probe;
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "override-token");
    return run(
      Effect.gen(function* () {
        const service = yield* ProviderAccountsService;
        yield* service.refreshUsage({ accountIds: [ProviderAccountId.make(seeded.ids.b!)] });
        expect(environments).toHaveLength(1);
        expect(environments[0]).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
        expect(environments[0]).not.toHaveProperty("CLAUDE_SECURESTORAGE_CONFIG_DIR");
      }).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs()))),
      false,
      {
        claudeHomePath: NodePath.join(root, "claude"),
        probe,
        before: async () => {
          seeded = await seedClaudeStores(["b"]);
        },
      },
    );
  });

  it.effect("starts an inactive Claude account's window in its own store once enabled", () => {
    let seeded: Awaited<ReturnType<typeof seedClaudeStores>>;
    const launches: ClaudeWindowPrimeLaunch[] = [];
    let started!: () => void;
    const primed = new Promise<void>((resolve) => {
      started = resolve;
    });
    // Fresh usage without a 5-hour window: nothing is running, so it can start.
    const probe: Probe = (() => {
      const now = new Date().toISOString();
      return Effect.succeed({
        checkedAt: now,
        status: "ready",
        usage: {
          checkedAt: now,
          windows: [{ id: "seven_day", label: "Weekly", kind: "weekly", usedPercent: 10 }],
        },
      } satisfies AccountUsage);
    }) as unknown as Probe;
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "override-token");
    return run(
      Effect.gen(function* () {
        const service = yield* ProviderAccountsService;
        expect(claudeGroup(yield* service.list()).windowPrimer).toEqual({ enabled: false });
        yield* service.setWindowPrimer({ driver: "claudeAgent", enabled: true });
        yield* Effect.promise(() => primed);
        const launch = launches[0]!;
        expect(launch.env.CLAUDE_CONFIG_DIR).toBe(seeded.homes.b);
        expect(launch.env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
        expect(launch.args).toContain("claude-haiku-4-5-20251001");
        expect(launch.cwd).toBe(
          NodePath.join(root, "state/userdata/fork/provider-accounts/window-primer"),
        );
        const group = claudeGroup(
          yield* service.setWindowPrimer({
            driver: "claudeAgent",
            enabled: false,
          }),
        );
        expect(group.windowPrimer?.enabled).toBe(false);
        expect(group.windowPrimer?.lastPrimedAccountId).toBe(seeded.ids.b);
        expect(launches.every((item) => item.env.CLAUDE_CONFIG_DIR !== seeded.activeHome)).toBe(
          true,
        );
      }).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs()))),
      false,
      {
        claudeHomePath: NodePath.join(root, "claude"),
        probe,
        runPrime: (launch) => {
          launches.push(launch);
          started();
          return Promise.resolve({ ok: true });
        },
        before: async () => {
          seeded = await seedClaudeStores(["b"]);
        },
      },
    );
  });

  it.effect("drops an in-flight probe result for an account that became active meanwhile", () => {
    let gate: Deferred.Deferred<void>;
    let started: Deferred.Deferred<void>;
    const probe: Probe = (() =>
      Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined);
        yield* Deferred.await(gate);
        return {
          checkedAt,
          status: "ready",
          usage: {
            checkedAt,
            windows: [{ id: "s", label: "5h", kind: "session", usedPercent: 42 }],
          },
        } satisfies AccountUsage;
      })) as unknown as Probe;
    return run(
      Effect.gen(function* () {
        gate = yield* Deferred.make<void>();
        started = yield* Deferred.make<void>();
        const service = yield* ProviderAccountsService;
        const refreshing = yield* service
          .refreshUsage({ accountIds: [seeded!.id], force: true })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        yield* service.switchAccount({ accountId: seeded!.id });
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(refreshing);
        const active = (yield* service.list()).groups
          .flatMap((group) => group.accounts)
          .find((account) => account.id === seeded!.id)!;
        expect(active.active).toBe(true);
        expect(active.usage).toBeUndefined();
        const config = yield* ServerConfig.ServerConfig;
        const persisted = yield* Effect.promise(async () => {
          const registry = await createProviderAccountRegistry({ stateDir: config.stateDir });
          return registry.get(seeded!.id);
        });
        expect(persisted.lastUsage?.usage).toBeUndefined();
        expect(persisted.lastUsage?.lastFailureKind).toBeUndefined();
      }),
      true,
      { probe },
    );
  });

  // H9: a terminal login as an already-saved account reuses its store instead of creating one.
  it.effect("files a terminal login into the matching saved account's store", () => {
    let seeded: Awaited<ReturnType<typeof seedClaudeStores>>;
    return run(
      Effect.gen(function* () {
        const service = yield* ProviderAccountsService;
        const before = claudeGroup(yield* service.list());
        expect(before.accounts).toHaveLength(3);
        const switched = claudeGroup(
          yield* service.switchAccount({ accountId: ProviderAccountId.make(seeded.ids.b!) }),
        );
        expect(switched.accounts).toHaveLength(3);
        expect(switched.activeAccountId).toBe(seeded.ids.b);
        expect(switched.accounts.find((account) => account.id === seeded.ids.c)).toMatchObject({
          status: "ready",
          active: false,
          email: "c@example.test",
        });
        expect(
          switched.accounts.find((account) => account.id === seeded.ids.default),
        ).toMatchObject({ status: "signedOut", message: claudeTerminalSignedOutMessage });
        expect(
          (yield* readJson(NodePath.join(seeded.homes.c!, ".credentials.json"))).claudeAiOauth,
        ).toEqual(seeded.credentials("c-live").claudeAiOauth);
        expect(
          (yield* readJson(NodePath.join(seeded.activeHome, ".credentials.json"))).claudeAiOauth,
        ).toEqual(seeded.credentials("b").claudeAiOauth);
      }),
      false,
      {
        claudeHomePath: NodePath.join(root, "claude"),
        before: async () => {
          seeded = await seedClaudeStores(["b", "c"]);
          // The user ran `claude auth login` as C in a terminal: a fresh lineage for C.
          await NodeFSP.writeFile(
            NodePath.join(seeded.activeHome, ".credentials.json"),
            JSON.stringify(seeded.credentials("c-live")),
          );
          await NodeFSP.writeFile(
            NodePath.join(seeded.activeHome, ".claude.json"),
            JSON.stringify({ oauthAccount: seeded.identity("c") }),
          );
        },
      },
    );
  });

  // H11: the switch returns once credentials moved; the provider snapshot refresh is forked.
  it.effect("returns from a hot switch before the provider snapshot refresh completes", () => {
    let seeded: Awaited<ReturnType<typeof seedClaudeStores>>;
    let gate: Deferred.Deferred<void>;
    return run(
      Effect.gen(function* () {
        gate = yield* Deferred.make<void>();
        const service = yield* ProviderAccountsService;
        const switched = claudeGroup(
          yield* service.switchAccount({ accountId: ProviderAccountId.make(seeded.ids.b!) }),
        );
        expect(switched.activeAccountId).toBe(seeded.ids.b);
        expect(yield* Deferred.isDone(gate)).toBe(false);
        yield* Deferred.succeed(gate, undefined);
      }),
      false,
      {
        claudeHomePath: NodePath.join(root, "claude"),
        refreshInstance: () => Deferred.await(gate).pipe(Effect.as([provider])),
        before: async () => {
          seeded = await seedClaudeStores(["b"]);
        },
      },
    );
  });

  it.effect(
    "recovers a journal before exposing the checked-out account after service restart",
    () => {
      let targetId: string;
      return run(
        Effect.gen(function* () {
          const service = yield* ProviderAccountsService;
          const group = (yield* service.list()).groups.find(
            (entry) => entry.driver === "claudeAgent",
          )!;
          expect(group.activeAccountId).toBe(targetId);
          const config = yield* ServerConfig.ServerConfig;
          const persisted = yield* Effect.promise(() =>
            createProviderAccountRegistry({ stateDir: config.stateDir }),
          );
          const target = yield* Effect.promise(() => persisted.get(targetId));
          const credentials = yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(target.homePath, ".credentials.json"), "utf8"),
          );
          expect(JSON.parse(credentials).claudeAiOauth).toBeUndefined();
        }),
        false,
        {
          claudeHomePath: NodePath.join(root, "claude"),
          before: async () => {
            const stateDir = NodePath.join(root, "state/userdata");
            const activeHome = NodePath.join(root, "claude");
            const registry = await createProviderAccountRegistry({ stateDir });
            const group = await registry.list("claudeAgent", activeHome, activeHome, activeHome);
            const source = await registry.ensureClaudeStore(group.activeAccountId);
            const target = await registry.createManaged({
              driver: "claudeAgent",
              label: "Recover target",
              sharedHomePath: activeHome,
            });
            targetId = target.id;
            await registry.update(target.id, { status: "ready" });
            for (const [home, email] of [
              [activeHome, "source@example.test"],
              [target.homePath, "target@example.test"],
            ]) {
              await NodeFSP.writeFile(
                NodePath.join(home!, ".credentials.json"),
                JSON.stringify({ claudeAiOauth: { accessToken: `fake-${email}` } }),
              );
              await NodeFSP.writeFile(
                NodePath.join(home!, ".claude.json"),
                JSON.stringify({ oauthAccount: { emailAddress: email } }),
              );
            }
            await expect(
              switchClaudeCredentials(
                {
                  stateDir,
                  managedRoot: NodePath.join(stateDir, "fork/provider-accounts/claude"),
                  activeHome,
                  activeConfigPath: NodePath.join(activeHome, ".claude.json"),
                  activeConfigDir: activeHome,
                  sourceStore: source.storePath!,
                  sourceAccountId: source.id,
                  targetStore: target.homePath,
                  targetAccountId: target.id,
                  commit: async () => {
                    throw new Error("commit must not run before fault");
                  },
                },
                {
                  afterPhase: async (phase) => {
                    if (phase === "source-saved") throw new Error("simulated crash");
                  },
                },
              ),
            ).rejects.toThrow("simulated crash");
          },
        },
      );
    },
  );

  it.effect("does not report probe backoff for the active account, whose usage is live", () =>
    run(
      Effect.gen(function* () {
        const service = yield* ProviderAccountsService;
        const codex = (snapshot: ProviderAccountsSnapshot) =>
          snapshot.groups.find((group) => group.driver === "codex")!;
        const inactive = codex(yield* service.list()).accounts.find(
          (account) => account.id === seeded!.id,
        );
        expect(inactive?.usageRefresh?.rateLimited).toBe(true);
        const switched = codex(yield* service.switchAccount({ accountId: seeded!.id }));
        const active = switched.accounts.find((account) => account.id === seeded!.id)!;
        expect(active.active).toBe(true);
        expect(active.usageRefresh).toBeUndefined();
      }),
      true,
      { backoff: true },
    ),
  );

  it.effect(
    "rejects a new Claude sign-in as the Default identity known only from its live home",
    () => {
      let callbacks: ProviderAccountLoginOptions;
      const activeHome = NodePath.join(root, "claude");
      return run(
        Effect.gen(function* () {
          const service = yield* ProviderAccountsService;
          const before = claudeGroup(yield* service.list());
          // No provider snapshot and nothing captured yet: only the live config knows Default.
          const prepared = yield* Effect.promise(() =>
            callbacks.prepare({ driver: "claudeAgent", label: "Work" }),
          );
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(prepared.homePath, ".claude.json"),
              JSON.stringify({
                oauthAccount: { emailAddress: "Default@Example.test", accountUuid: "uuid-default" },
              }),
            ),
          );
          const outcome = yield* Effect.promise(() =>
            callbacks.complete(prepared, { email: "Default@Example.test" }),
          );
          expect(outcome).toEqual({
            message: "You're already signed in with Default@Example.test as Default.",
          });
          // Nothing was persisted, so the login's discard path can still remove the pending entry.
          yield* Effect.promise(() => callbacks.cleanup(prepared));
          const after = claudeGroup(yield* service.list());
          expect(after.accounts.map((account) => account.id)).toEqual(
            before.accounts.map((account) => account.id),
          );
          expect(after.activeAccountId).toBe(before.activeAccountId);
        }),
        false,
        {
          claudeHomePath: activeHome,
          before: async () => {
            await NodeFSP.mkdir(activeHome, { recursive: true });
            await NodeFSP.writeFile(
              NodePath.join(activeHome, ".claude.json"),
              JSON.stringify({
                oauthAccount: { emailAddress: "default@example.test", accountUuid: "uuid-default" },
              }),
            );
          },
          login: (options) => {
            callbacks = options;
            return new ProviderAccountLogin(options);
          },
        },
      );
    },
  );

  it.effect(
    "flags an existing duplicate and removes it while active without moving credentials",
    () => {
      let seeded: Awaited<ReturnType<typeof seedClaudeStores>>;
      const loggedOut: string[] = [];
      return run(
        Effect.gen(function* () {
          const service = yield* ProviderAccountsService;
          const dup = ProviderAccountId.make(seeded.ids.dup!);
          const listed = claudeGroup(yield* service.list());
          expect(listed.accounts.find((account) => account.id === dup)?.duplicateOf).toBe(
            seeded.ids.default,
          );
          expect(
            listed.accounts.find((account) => account.id === seeded.ids.default)?.duplicateOf,
          ).toBeUndefined();
          expect(
            listed.accounts.find((account) => account.id === seeded.ids.other)?.duplicateOf,
          ).toBeUndefined();
          const switched = claudeGroup(yield* service.switchAccount({ accountId: dup }));
          expect(switched.activeAccountId).toBe(dup);
          expect(switched.accounts.find((account) => account.id === dup)?.duplicateOf).toBe(
            seeded.ids.default,
          );
          const removed = claudeGroup(yield* service.remove({ accountId: dup }));
          expect(removed.activeAccountId).toBe(seeded.ids.default);
          expect(removed.accounts.some((account) => account.id === dup)).toBe(false);
          expect(removed.accounts.some((account) => account.duplicateOf)).toBe(false);
          expect(loggedOut).toEqual([seeded.homes.dup]);
          // The checked-out token stays in the active home; only the duplicate's store is gone.
          expect(
            (yield* readJson(NodePath.join(seeded.activeHome, ".credentials.json"))).claudeAiOauth,
          ).toEqual(seeded.credentials("dup").claudeAiOauth);
          expect(
            yield* Effect.promise(() =>
              NodeFSP.stat(seeded.homes.dup!).then(
                () => true,
                () => false,
              ),
            ),
          ).toBe(false);
          // The kept account keeps working: switching away files the live token into its store.
          const away = claudeGroup(
            yield* service.switchAccount({ accountId: ProviderAccountId.make(seeded.ids.other!) }),
          );
          expect(away.activeAccountId).toBe(seeded.ids.other);
          const defaultStore = (yield* service.list()).groups
            .flatMap((group) => group.accounts)
            .find((account) => account.id === seeded.ids.default);
          expect(defaultStore).toMatchObject({ status: "ready", email: "default@example.test" });
        }),
        false,
        {
          claudeHomePath: NodePath.join(root, "claude"),
          before: async () => {
            seeded = await seedClaudeStores(["dup", "other"]);
            // `dup` was signed in as the Default identity before duplicates were rejected.
            const registry = await createProviderAccountRegistry({ stateDir: seeded.stateDir });
            await registry.update(seeded.ids.dup!, {
              lastUsage: { email: "default@example.test", accountUuid: "uuid-default", checkedAt },
            });
            await NodeFSP.writeFile(
              NodePath.join(seeded.homes.dup!, ".claude.json"),
              JSON.stringify({ oauthAccount: seeded.identity("default") }),
            );
          },
          login: (options) => {
            const login = new ProviderAccountLogin(options);
            login.logout = async (account) => {
              loggedOut.push(account.homePath);
            };
            return login;
          },
        },
      );
    },
  );

  describe("terminal Claude logins", () => {
    const readCredentials = (home: string) =>
      Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(home, ".credentials.json"), "utf8").then(
          (text) => JSON.parse(text),
          () => ({}),
        ),
      );
    const storedEntry = (stateDir: string, id: string) =>
      Effect.promise(async () => (await createProviderAccountRegistry({ stateDir })).get(id));
    /** `claude auth login` in a terminal: a new lineage and identity in the active home. */
    const terminalLogin = async (
      seeded: Awaited<ReturnType<typeof seedClaudeStores>>,
      name: string,
    ) => {
      await NodeFSP.writeFile(
        NodePath.join(seeded.activeHome, ".credentials.json"),
        JSON.stringify(seeded.credentials(`${name}-live`)),
      );
      await NodeFSP.writeFile(
        NodePath.join(seeded.activeHome, ".claude.json"),
        JSON.stringify({ oauthAccount: seeded.identity(name) }),
      );
    };

    it.effect("moves the selection to the saved account a terminal login signed in to", () => {
      let seeded: Awaited<ReturnType<typeof seedClaudeStores>>;
      return run(
        Effect.gen(function* () {
          const service = yield* ProviderAccountsService;
          const group = claudeGroup(yield* service.list());
          expect(group.activeAccountId).toBe(seeded.ids.c);
          expect(group.accounts.find((account) => account.id === seeded.ids.default)).toMatchObject(
            {
              active: false,
              status: "signedOut",
              message: claudeTerminalSignedOutMessage,
              email: "default@example.test",
            },
          );
          expect(group.accounts.find((account) => account.id === seeded.ids.c)).toMatchObject({
            active: true,
            email: "c@example.test",
          });
          expect(group.accounts.some((account) => account.duplicateOf)).toBe(false);
          // Neither entry took the other's identity.
          expect(
            (yield* storedEntry(seeded.stateDir, seeded.ids.default!)).lastUsage,
          ).toMatchObject({ email: "default@example.test", accountUuid: "uuid-default" });
          expect((yield* storedEntry(seeded.stateDir, seeded.ids.c!)).lastUsage).toMatchObject({
            email: "c@example.test",
            accountUuid: "uuid-c",
          });
          // No credential moved: the live login stays active, C's stale copy stays in its store.
          expect((yield* readCredentials(seeded.activeHome)).claudeAiOauth).toEqual(
            seeded.credentials("c-live").claudeAiOauth,
          );
          expect((yield* readCredentials(seeded.homes.c!)).claudeAiOauth).toEqual(
            seeded.credentials("c").claudeAiOauth,
          );
        }),
        false,
        {
          claudeHomePath: NodePath.join(root, "claude"),
          before: async () => {
            seeded = await seedClaudeStores(["b", "c"]);
            await terminalLogin(seeded, "c");
          },
        },
      );
    });

    it.effect("saves a terminal login to an unknown account as a new active account", () => {
      let seeded: Awaited<ReturnType<typeof seedClaudeStores>>;
      return run(
        Effect.gen(function* () {
          const service = yield* ProviderAccountsService;
          const group = claudeGroup(yield* service.list());
          expect(group.accounts).toHaveLength(3);
          const created = group.accounts.find((account) => account.label === "new@example.test")!;
          expect(created).toMatchObject({
            kind: "managed",
            active: true,
            status: "ready",
            email: "new@example.test",
          });
          expect(group.activeAccountId).toBe(created.id);
          expect(group.accounts.find((account) => account.id === seeded.ids.default)).toMatchObject(
            { status: "signedOut", message: claudeTerminalSignedOutMessage },
          );
          const entry = yield* storedEntry(seeded.stateDir, created.id);
          expect(entry.lastUsage).toMatchObject({
            email: "new@example.test",
            accountUuid: "uuid-new",
          });
          // Its store is allocated and checked out: the live token is still only in the active home.
          expect(entry.storePath).toBe(entry.homePath);
          expect((yield* readCredentials(entry.homePath)).claudeAiOauth).toBeUndefined();
          expect((yield* readCredentials(seeded.activeHome)).claudeAiOauth).toEqual(
            seeded.credentials("new-live").claudeAiOauth,
          );
          // Switching away files the live token into the new account's own store.
          const switched = claudeGroup(
            yield* service.switchAccount({ accountId: ProviderAccountId.make(seeded.ids.b!) }),
          );
          expect(switched.activeAccountId).toBe(seeded.ids.b);
          expect(switched.accounts.find((account) => account.id === created.id)).toMatchObject({
            status: "ready",
            email: "new@example.test",
          });
          expect((yield* readCredentials(entry.homePath)).claudeAiOauth).toEqual(
            seeded.credentials("new-live").claudeAiOauth,
          );
        }),
        false,
        {
          claudeHomePath: NodePath.join(root, "claude"),
          before: async () => {
            seeded = await seedClaudeStores(["b"]);
            await terminalLogin(seeded, "new");
          },
        },
      );
    });

    it.effect("never lends a snapshot of another identity to the active account", () => {
      let seeded: Awaited<ReturnType<typeof seedClaudeStores>>;
      const foreign = decodeProvider({
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        enabled: true,
        installed: true,
        version: "1.0.0",
        status: "ready",
        auth: { status: "authenticated", email: "someone@example.test", label: "Claude Max" },
        checkedAt,
        models: [],
        usageLimits: {
          checkedAt,
          windows: [{ id: "session", label: "5h", kind: "session", usedPercent: 99 }],
        },
      });
      return run(
        Effect.gen(function* () {
          const service = yield* ProviderAccountsService;
          const active = claudeGroup(yield* service.list()).accounts.find(
            (account) => account.active,
          )!;
          expect(active).toMatchObject({ id: seeded.ids.default, email: "default@example.test" });
          expect(active.plan).toBeUndefined();
          expect(active.usage).toBeUndefined();
          yield* service.switchAccount({ accountId: ProviderAccountId.make(seeded.ids.b!) });
          const saved = yield* storedEntry(seeded.stateDir, seeded.ids.default!);
          expect(saved.lastUsage).toMatchObject({
            email: "default@example.test",
            accountUuid: "uuid-default",
          });
          expect(saved.lastUsage?.plan).toBeUndefined();
          expect(saved.lastUsage?.usage).toBeUndefined();
        }),
        false,
        {
          claudeHomePath: NodePath.join(root, "claude"),
          providers: [foreign],
          before: async () => {
            seeded = await seedClaudeStores(["b"]);
          },
        },
      );
    });

    it.effect(
      "repairs an active entry that took another account's identity: flags, removes, re-adds",
      () => {
        let seeded: Awaited<ReturnType<typeof seedClaudeStores>>;
        let callbacks: ProviderAccountLoginOptions;
        const loggedOut: string[] = [];
        return run(
          Effect.gen(function* () {
            const service = yield* ProviderAccountsService;
            const marius = ProviderAccountId.make(seeded.ids.marius!);
            const group = claudeGroup(yield* service.list());
            // The Default owns the live identity; the corrupted copy is inactive and flagged.
            expect(group.activeAccountId).toBe(seeded.ids.default);
            expect(group.accounts.find((account) => account.id === marius)).toMatchObject({
              active: false,
              status: "signedOut",
              duplicateOf: seeded.ids.default,
            });
            expect((yield* readCredentials(seeded.activeHome)).claudeAiOauth).toEqual(
              seeded.credentials("default-live").claudeAiOauth,
            );
            const removed = claudeGroup(yield* service.remove({ accountId: marius }));
            expect(removed.accounts.some((account) => account.id === marius)).toBe(false);
            expect(removed.activeAccountId).toBe(seeded.ids.default);
            expect(loggedOut).toEqual([seeded.homes.marius]);
            // Signing in to the real account again is a new account, not a duplicate.
            const prepared = yield* Effect.promise(() =>
              callbacks.prepare({ driver: "claudeAgent" }),
            );
            yield* Effect.promise(() =>
              NodeFSP.writeFile(
                NodePath.join(prepared.homePath, ".claude.json"),
                JSON.stringify({ oauthAccount: seeded.identity("marius") }),
              ),
            );
            const outcome = yield* Effect.promise(() =>
              callbacks.complete(prepared, { email: "marius@example.test" }),
            );
            expect(outcome).toBeUndefined();
            const readded = claudeGroup(yield* service.list()).accounts.find(
              (account) => account.id === prepared.accountId,
            );
            expect(readded).toMatchObject({
              label: "marius@example.test",
              status: "ready",
              email: "marius@example.test",
            });
            expect(readded?.duplicateOf).toBeUndefined();
          }),
          false,
          {
            claudeHomePath: NodePath.join(root, "claude"),
            before: async () => {
              seeded = await seedClaudeStores(["marius"]);
              const registry = await createProviderAccountRegistry({ stateDir: seeded.stateDir });
              // Default was switched away earlier: its store holds an older copy of its token.
              const store = await registry.ensureClaudeStore(seeded.ids.default!);
              await NodeFSP.writeFile(
                NodePath.join(store.storePath!, ".credentials.json"),
                JSON.stringify(seeded.credentials("default")),
              );
              await NodeFSP.writeFile(
                NodePath.join(store.storePath!, ".claude.json"),
                JSON.stringify({ oauthAccount: seeded.identity("default") }),
              );
              // marius was active (store checked out) when a terminal login as Default replaced
              // its token, and an old build wrote the live email into its entry.
              await NodeFSP.writeFile(
                NodePath.join(seeded.homes.marius!, ".credentials.json"),
                "{}",
              );
              await registry.setClaudeActiveAccount(seeded.ids.marius!);
              await registry.update(seeded.ids.marius!, {
                lastUsage: { email: "default@example.test", checkedAt },
              });
              await terminalLogin(seeded, "default");
            },
            login: (options) => {
              callbacks = options;
              const login = new ProviderAccountLogin(options);
              login.logout = async (account) => {
                loggedOut.push(account.homePath);
              };
              return login;
            },
          },
        );
      },
    );

    it.effect("keeps a known identity when a usage probe reports none", () =>
      run(
        Effect.gen(function* () {
          const service = yield* ProviderAccountsService;
          const config = yield* ServerConfig.ServerConfig;
          yield* service.refreshUsage({ accountIds: [seeded!.id], force: true });
          const listed = (yield* service.list()).groups
            .flatMap((group) => group.accounts)
            .find((account) => account.id === seeded!.id);
          expect(listed).toMatchObject({ email: "other@example.test", status: "ready" });
          expect(listed?.usage?.windows).toHaveLength(1);
          expect((yield* storedEntry(config.stateDir, seeded!.id)).lastUsage?.email).toBe(
            "other@example.test",
          );
        }),
        true,
        {
          probe: (() =>
            Effect.succeed({
              checkedAt,
              status: "ready",
              usage: {
                checkedAt,
                windows: [{ id: "session", label: "5h", kind: "session", usedPercent: 10 }],
              },
            } satisfies AccountUsage)) as unknown as Probe,
        },
      ),
    );
  });
});
