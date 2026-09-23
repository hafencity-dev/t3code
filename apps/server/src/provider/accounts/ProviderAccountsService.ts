// fork: provider accounts
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import {
  defaultInstanceIdForDriver,
  ProviderAccountError,
  ProviderAccountId,
  ProviderDriverKind,
  type ProviderAccount,
  type ProviderAccountDriver,
  type ProviderAccountLoginEvent,
  type ProviderAccountAutoSwitchEvent,
  type ProviderAccountsSetAutoSwitchInput,
  type ProviderAccountsRefreshUsageInput,
  type ProviderAccountsStartLoginInput,
  type ProviderAccountsSwitchInput,
  type ProviderAccountsSnapshot,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { Clock, Context, DateTime, Effect, Layer, PubSub, Queue, Semaphore, Stream } from "effect";
import { makeProviderAccountAutoSwitch } from "./ProviderAccountAutoSwitch.ts";
import { activeBelowThreshold } from "./autoSwitchPolicy.ts";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { resolveClaudeHomePath } from "../Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../Drivers/CodexHomeLayout.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { materializeCodexAccountHome } from "./CodexAccountHome.ts";
import {
  ProviderAccountLogin,
  type PreparedProviderAccountLogin,
  type ProviderAccountLoginOptions,
} from "./ProviderAccountLogin.ts";
import {
  createProviderAccountRegistry,
  ProviderAccountRegistryGuardError,
  type ProviderAccountEntry,
} from "./ProviderAccountRegistry.ts";
import {
  makeProviderAccountSwitch,
  resolveProviderAccountConfig,
} from "./ProviderAccountSwitch.ts";
import {
  AccountUsageProbeStaleError,
  makeAccountUsageCache,
  probeAccountUsage,
  type AccountUsage,
} from "./ProviderAccountUsage.ts";

import {
  switchClaudeCredentials,
  recoverClaudeCredentialSwitch,
  claudeCredentialSwitchJournalPath,
  ClaudeCredentialSwitchError,
  type ClaudeCredentialSwitchResult,
} from "./ClaudeCredentialSwitch.ts";

const claudeStoreHomeWarning =
  "Claude home points at a saved account store. Reset the Claude config directory in Settings to use hot switching.";
const claudeHomeChangedWarning =
  "Claude config directory changed in Settings. Restore it to switch accounts.";
const claudeBarrierWarning = (reason: string) =>
  `A previous Claude account switch didn't finish: ${reason} Accounts are locked until it's resolved.`;

/** Inactive-store probes must authenticate from that store only, like login does. */
export function inactiveClaudeProbeEnvironment(environment: NodeJS.ProcessEnv) {
  const {
    CLAUDE_SECURESTORAGE_CONFIG_DIR: _secure,
    CLAUDE_CODE_OAUTH_TOKEN: _token,
    ...rest
  } = environment;
  return rest;
}
function claudeCredentialLocation(state: {
  currentHome: string;
  settings: { homePath: string };
  environment: NodeJS.ProcessEnv;
}) {
  const configDir = state.settings.homePath.trim()
    ? state.currentHome
    : state.environment.CLAUDE_CONFIG_DIR || undefined;
  const secureDir = state.environment.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const activeHome =
    secureDir === undefined
      ? state.currentHome
      : NodePath.resolve(secureDir || NodePath.join(NodeOS.homedir(), ".claude"));
  const activeConfigDir = secureDir === undefined ? configDir : secureDir || undefined;
  return {
    activeHome,
    activeConfigPath: configDir
      ? NodePath.join(state.currentHome, ".claude.json")
      : NodePath.join(NodeOS.homedir(), ".claude.json"),
    ...(activeConfigDir === undefined ? {} : { activeConfigDir }),
  };
}

const io = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: (cause) => cause }).pipe(
    Effect.catch((cause) => {
      if (
        cause instanceof ProviderAccountRegistryGuardError ||
        cause instanceof ClaudeCredentialSwitchError
      ) {
        return Effect.fail(new ProviderAccountError({ message: cause.message }));
      }
      return Effect.logWarning("Provider account storage operation failed", {
        // Never log raw CLI output, parsed file contents, or credential-bearing causes.
        causeType: cause instanceof Error ? cause.name : typeof cause,
      }).pipe(
        Effect.andThen(
          Effect.fail(
            new ProviderAccountError({ message: "Could not update provider account storage." }),
          ),
        ),
      );
    }),
  );

function effectiveEnvironment(settings: ServerSettings, driver: ProviderAccountDriver) {
  return mergeProviderInstanceEnvironment(
    settings.providerInstances[defaultInstanceIdForDriver(ProviderDriverKind.make(driver))]
      ?.environment,
  );
}

function accountFromEntry(
  entry: ProviderAccountEntry,
  active: boolean,
  provider?: ServerProvider,
): ProviderAccount {
  const metadata = entry.lastUsage;
  const snapshot = entry.status === "error" && entry.message ? undefined : provider;
  const status =
    entry.status === "pending" || (entry.status === "error" && entry.message)
      ? entry.status
      : snapshot?.auth.status === "unauthenticated"
        ? "signedOut"
        : snapshot?.auth.status === "authenticated"
          ? "ready"
          : entry.status;
  const email = snapshot?.auth.email ?? metadata?.email;
  const plan = snapshot?.auth.label ?? metadata?.plan;
  const usage = snapshot?.usageLimits ?? metadata?.usage;
  return {
    id: ProviderAccountId.make(entry.id),
    driver: entry.driver,
    label: entry.label,
    kind: entry.kind,
    active,
    status,
    ...(email ? { email } : {}),
    ...(plan ? { plan } : {}),
    ...(usage ? { usage } : {}),
    ...(entry.message ? { message: entry.message } : {}),
    ...(metadata?.nextAllowedAt !== undefined
      ? {
          usageRefresh: {
            nextAllowedAt: new Date(metadata.nextAllowedAt).toISOString(),
            rateLimited: metadata.lastFailureKind === "rateLimited",
          },
        }
      : {}),
  };
}

type LoginClient = Pick<
  ProviderAccountLogin,
  "start" | "isBusy" | "logout" | "submitCode" | "cancel"
>;
type CreateLogin = (options: ProviderAccountLoginOptions) => LoginClient;
const make = (
  createLogin: CreateLogin = (options) => new ProviderAccountLogin(options),
  probe: typeof probeAccountUsage = probeAccountUsage,
) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const settings = yield* ServerSettingsService;
    const providers = yield* ProviderRegistry;
    const instances = yield* ProviderInstanceRegistry;
    const engine = yield* OrchestrationEngineService;
    const snapshots = yield* ProjectionSnapshotQuery;
    const scope = yield* Effect.scope;
    const context = yield* Effect.context<
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
    >();
    const runPromise = Effect.runPromiseWith(context);
    const registryLoad = yield* Semaphore.make(1);
    let loadedRegistry: Awaited<ReturnType<typeof createProviderAccountRegistry>> | undefined;
    const claudeManagedRoot = NodePath.join(config.stateDir, "fork", "provider-accounts", "claude");
    const claudeInstanceId = defaultInstanceIdForDriver(ProviderDriverKind.make("claudeAgent"));
    // A hot switch returns as soon as credentials moved; the snapshot follows in the
    // background while list() masks the previous account's identity and limits.
    const refreshClaudeSnapshot = Effect.gen(function* () {
      const observed = observedAccounts.get("claudeAgent");
      if (observed?.checkedAt) staleSnapshots.set("claudeAgent", observed.checkedAt);
      yield* providers.refreshInstance(claudeInstanceId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Claude provider refresh after account switch failed", cause),
        ),
        Effect.forkIn(scope),
      );
    });
    const commitClaudeSwitch = async (
      registry: Awaited<ReturnType<typeof createProviderAccountRegistry>>,
      result: ClaudeCredentialSwitchResult,
    ) => {
      if (result.externalIdentity) {
        await registry.update(result.originalSourceAccountId, {
          status: "signedOut",
          message: "Sign in again",
        });
        const reused = await registry.get(result.sourceAccountId);
        await registry.update(result.sourceAccountId, {
          status: "ready",
          message: null,
          lastUsage: {
            ...reused.lastUsage,
            ...result.externalIdentity,
            checkedAt: new Date().toISOString(),
          },
        });
      }
      await registry.setClaudeActiveAccount(result.activeAccountId);
    };
    // An unfinished switch journal locks every Claude credential operation until it is
    // resolved. Recovery is retried on each mutation; list() only reports the reason.
    let claudeBarrier: string | undefined;
    const recoverClaude = Effect.fn("providerAccounts.recoverClaude")(function* (
      registry: Awaited<ReturnType<typeof createProviderAccountRegistry>>,
    ) {
      const journalPath = claudeCredentialSwitchJournalPath(config.stateDir);
      const pending = yield* Effect.promise(() =>
        NodeFSP.stat(journalPath).then(
          () => true,
          () => false,
        ),
      );
      if (!pending) {
        claudeBarrier = undefined;
        return;
      }
      const claude = yield* configuration("claudeAgent");
      const outcome = yield* Effect.result(
        Effect.tryPromise({
          try: () =>
            recoverClaudeCredentialSwitch({
              stateDir: config.stateDir,
              managedRoot: claudeManagedRoot,
              ...claudeCredentialLocation(claude),
              commit: (result) => commitClaudeSwitch(registry, result),
            }),
          catch: (cause) => cause,
        }),
      );
      if (outcome._tag === "Failure") {
        const cause = outcome.failure;
        claudeBarrier =
          cause instanceof ClaudeCredentialSwitchError
            ? cause.message
            : "Recovery failed; see the server log.";
        yield* Effect.logWarning("Claude credential switch recovery failed", {
          journalPath,
          causeType: cause instanceof Error ? cause.name : typeof cause,
        });
        return;
      }
      claudeBarrier = undefined;
      if (outcome.success) yield* refreshClaudeSnapshot;
    });
    const registryEffect = registryLoad.withPermit(
      Effect.gen(function* () {
        if (loadedRegistry) return loadedRegistry;
        const registry = yield* io(() =>
          createProviderAccountRegistry({ stateDir: config.stateDir }),
        );
        yield* recoverClaude(registry);
        loadedRegistry = registry;
        return registry;
      }),
    );
    const requireClaudeReady = Effect.fn("providerAccounts.requireClaudeReady")(function* () {
      const registry = yield* registryEffect;
      yield* recoverClaude(registry);
      if (claudeBarrier !== undefined)
        return yield* new ProviderAccountError({ message: claudeBarrierWarning(claudeBarrier) });
    });
    const mutation = yield* Semaphore.make(1);
    // Bumped per group on every switch so an in-flight probe can tell it started earlier.
    const checkoutGeneration = { claudeAgent: 0, codex: 0 };
    const switcher = makeProviderAccountSwitch({ settings, engine, snapshots, instances });
    const observedAccounts = new Map<ProviderAccountDriver, { id: string; checkedAt?: string }>();
    const staleSnapshots = new Map<ProviderAccountDriver, string>();
    const autoEvents = yield* PubSub.unbounded<ProviderAccountAutoSwitchEvent>();
    yield* Effect.addFinalizer(() => PubSub.shutdown(autoEvents));
    let autoSwitch: Effect.Success<ReturnType<typeof makeProviderAccountAutoSwitch>> | undefined;
    const changed = (driver: ProviderAccountDriver) =>
      PubSub.publish(autoEvents, { _tag: "changed", driver }).pipe(Effect.asVoid);

    const configuration = Effect.fn("providerAccounts.configuration")(function* (
      driver: ProviderAccountDriver,
    ) {
      const current = yield* settings.getSettings.pipe(
        Effect.mapError(
          () => new ProviderAccountError({ message: "Could not read provider settings." }),
        ),
      );
      const environment = effectiveEnvironment(current, driver);
      if (driver === "claudeAgent") {
        const providerSettings = yield* resolveProviderAccountConfig(current, driver);
        const home = yield* resolveClaudeHomePath(providerSettings, environment).pipe(
          Effect.provide(context),
        );
        return {
          driver,
          settings: providerSettings,
          environment,
          currentHome: home,
          sharedHome: home,
        } as const;
      }
      const providerSettings = yield* resolveProviderAccountConfig(current, driver);
      const layout = yield* resolveCodexHomeLayout(providerSettings).pipe(Effect.provide(context));
      return {
        driver,
        settings: providerSettings,
        environment,
        currentHome: layout.mode === "direct" ? "" : layout.effectiveHomePath!,
        sharedHome: layout.sharedHomePath,
      } as const;
    });

    const groupState = Effect.fn("providerAccounts.groupState")(function* (
      driver: ProviderAccountDriver,
    ) {
      const registry = yield* registryEffect;
      const resolved = yield* configuration(driver);
      const group = yield* io(() =>
        registry.list(
          driver,
          resolved.currentHome,
          resolved.sharedHome,
          resolved.settings.homePath,
        ),
      );
      const original = group.accounts.find((entry) => entry.kind === "default");
      const sourceConfigPath =
        driver === "claudeAgent" &&
        original?.originalHomePath === "" &&
        !resolved.environment.CLAUDE_CONFIG_DIR?.trim()
          ? NodePath.join(NodeOS.homedir(), ".claude.json")
          : NodePath.join(group.sharedHomePath, ".claude.json");
      const relativeHome = NodePath.relative(claudeManagedRoot, resolved.currentHome);
      const managedClaudeHome =
        driver === "claudeAgent" &&
        (relativeHome === "" ||
          (!relativeHome.startsWith(`..${NodePath.sep}`) &&
            relativeHome !== ".." &&
            !NodePath.isAbsolute(relativeHome)));
      const active = group.accounts.find((entry) => entry.id === group.activeAccountId);
      // Any Claude warning also blocks hot switching; the registry owns Codex's warning.
      const claudeWarning =
        driver !== "claudeAgent"
          ? undefined
          : claudeBarrier !== undefined
            ? claudeBarrierWarning(claudeBarrier)
            : managedClaudeHome
              ? claudeStoreHomeWarning
              : active?.kind === "external"
                ? claudeHomeChangedWarning
                : undefined;
      return {
        ...resolved,
        ...group,
        sourceConfigPath,
        ...(claudeWarning ? { warning: claudeWarning } : {}),
      };
    });

    const list = Effect.fn("providerAccounts.list")(function* (): Effect.fn.Return<
      ProviderAccountsSnapshot,
      ProviderAccountError
    > {
      const providerSnapshots = yield* providers.getProviders;
      const groups = yield* Effect.forEach(["claudeAgent", "codex"] as const, (driver) =>
        Effect.gen(function* () {
          const state = yield* groupState(driver);
          const registry = yield* registryEffect;
          const automatic = yield* io(() => registry.getAutoSwitch(driver));
          const automaticState = autoSwitch?.getState(driver);
          const instanceId = defaultInstanceIdForDriver(ProviderDriverKind.make(driver));
          const candidate = providerSnapshots.find(
            (provider) => provider.instanceId === instanceId,
          );
          const observed = observedAccounts.get(driver);
          if (observed && observed.id !== state.activeAccountId && observed.checkedAt) {
            staleSnapshots.set(driver, observed.checkedAt);
          }
          // Settings commit before the instance registry rebuilds. Never label the new
          // account with the old instance's identity or limits during that handoff.
          const stale = staleSnapshots.get(driver);
          const snapshot = candidate && candidate.checkedAt !== stale ? candidate : undefined;
          if (snapshot) staleSnapshots.delete(driver);
          const captured = state.accounts.find((entry) => entry.id === state.activeAccountId);
          // Capture Default's first known identity so a later terminal login cannot silently
          // become the saved Default account when its credentials are checked back in.
          if (
            driver === "claudeAgent" &&
            captured?.kind === "default" &&
            !captured.lastUsage?.email &&
            snapshot?.auth.email
          ) {
            yield* io(() =>
              registry.update(captured.id, {
                lastUsage: {
                  ...captured.lastUsage,
                  checkedAt: snapshot.checkedAt,
                  email: snapshot.auth.email!,
                },
              }),
            );
          }
          observedAccounts.set(driver, {
            id: state.activeAccountId,
            ...(candidate ? { checkedAt: candidate.checkedAt } : {}),
          });
          const overrides = [
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "OPENAI_API_KEY",
            "CLAUDE_SECURESTORAGE_CONFIG_DIR",
          ].filter((key) => Boolean(state.environment[key]));
          const warning = [
            state.warning,
            ...(overrides.length
              ? [`${overrides.join(", ")} may override this account's login.`]
              : []),
          ]
            .filter(Boolean)
            .join(" ");
          return {
            driver,
            instanceId,
            switchMode: driver === "claudeAgent" ? ("hot" as const) : ("restart" as const),
            activeAccountId: ProviderAccountId.make(state.activeAccountId),
            autoSwitch: {
              enabled: automatic.enabled,
              thresholdPercent: automatic.thresholdPercent,
              ...(automatic.enabled ? automaticState : {}),
              state: !automatic.enabled
                ? ("off" as const)
                : automaticState?.state && automaticState.state !== "off"
                  ? automaticState.state
                  : ("watching" as const),
              ...(automatic.lastSwitch
                ? {
                    lastSwitch: {
                      ...automatic.lastSwitch,
                      fromAccountId: ProviderAccountId.make(automatic.lastSwitch.fromAccountId),
                      toAccountId: ProviderAccountId.make(automatic.lastSwitch.toAccountId),
                    },
                  }
                : {}),
            },
            accounts: state.accounts.map((entry) =>
              accountFromEntry(
                entry,
                entry.id === state.activeAccountId,
                entry.id === state.activeAccountId ? snapshot : undefined,
              ),
            ),
            ...(warning ? { warning } : {}),
          };
        }),
      );
      return { groups };
    });

    const cache = makeAccountUsageCache({
      probe: (id: ProviderAccountId) =>
        Effect.gen(function* () {
          const registry = yield* registryEffect;
          const entry = yield* io(() => registry.get(id));
          const state = yield* groupState(entry.driver);
          const generation = checkoutGeneration[entry.driver];
          const homePath = entry.storePath ?? (entry.homePath || state.sharedHome);
          const input = { homePath, cwd: config.cwd };
          const result = yield* (
            state.driver === "claudeAgent"
              ? probe({
                  ...input,
                  driver: state.driver,
                  settings: state.settings,
                  environment: inactiveClaudeProbeEnvironment(state.environment),
                })
              : probe({
                  ...input,
                  driver: state.driver,
                  settings: state.settings,
                  environment: state.environment,
                })
          ).pipe(Effect.provide(context));
          // The store was probed before a checkout moved its credentials; drop the result.
          if (
            generation !== checkoutGeneration[entry.driver] ||
            (yield* groupState(entry.driver)).activeAccountId === entry.id
          ) {
            return yield* Effect.fail(
              new AccountUsageProbeStaleError("Account was switched during its usage probe."),
            );
          }
          return result;
        }),
    });

    const refreshUsage = Effect.fn("providerAccounts.refreshUsage")(function* (
      input: ProviderAccountsRefreshUsageInput,
    ) {
      const registry = yield* registryEffect;
      const snapshot = yield* list();
      const claudeGroup = snapshot.groups.find((group) => group.driver === "claudeAgent");
      if (claudeGroup?.accounts.some((account) => !account.active))
        yield* mutation.withPermit(recoverClaude(registry));
      yield* Effect.forEach(
        snapshot.groups.flatMap((group) => group.accounts),
        (account) =>
          Effect.gen(function* () {
            if (
              account.active ||
              account.status === "pending" ||
              (account.status === "error" && Boolean(account.message)) ||
              (input.accountIds && !input.accountIds.includes(account.id)) ||
              (account.driver === "claudeAgent" && claudeBarrier !== undefined)
            )
              return;
            const entry = yield* io(() => registry.get(account.id));
            const previous: AccountUsage | undefined = entry.lastUsage
              ? {
                  ...entry.lastUsage,
                  status: entry.status === "pending" ? "error" : entry.status,
                }
              : undefined;
            const result = yield* cache.refresh({
              id: account.id,
              active: false,
              ...(previous ? { previous } : {}),
              ...(input.force === undefined ? {} : { force: input.force }),
            });
            if (result)
              yield* io(() =>
                registry.update(account.id, { status: result.status, lastUsage: result }),
              );
          }),
        { concurrency: 2 },
      );
      return yield* list();
    });

    const deleteManagedHome = (entry: {
      accountId: string;
      driver: ProviderAccountDriver;
      homePath: string;
    }) =>
      io(async () => {
        const expected = NodePath.join(
          config.stateDir,
          "fork",
          "provider-accounts",
          entry.driver === "claudeAgent" ? "claude" : "codex",
          entry.accountId,
        );
        if (NodePath.resolve(entry.homePath) !== NodePath.resolve(expected))
          throw new Error("Refusing to delete an unmanaged account home.");
        // Node's recursive rm unlinks symlinks instead of descending into their targets.
        await NodeFSP.rm(entry.homePath, { recursive: true, force: true });
      });

    const login = createLogin({
      prepare: (input) =>
        runPromise(
          mutation.withPermit(
            Effect.gen(function* () {
              const registry = yield* registryEffect;
              if (input.driver === "claudeAgent") yield* requireClaudeReady();
              const state = yield* groupState(input.driver);
              let entry: ProviderAccountEntry;
              if (input.accountId) {
                entry = yield* io(() => registry.get(input.accountId!));
                if (
                  entry.driver !== input.driver ||
                  (entry.status === "pending" && entry.kind !== "managed")
                )
                  return yield* new ProviderAccountError({
                    message: "This account cannot be signed in again right now.",
                  });
              } else {
                entry = yield* io(() =>
                  registry.createManaged({
                    driver: input.driver,
                    label: input.label ?? "New account",
                    sharedHomePath: state.sharedHomePath,
                    sourceConfigPath: state.sourceConfigPath,
                  }),
                );
              }
              const claudeActive =
                entry.driver === "claudeAgent" && entry.id === state.activeAccountId;
              const homePath = claudeActive
                ? state.currentHome
                : (entry.storePath ?? (entry.homePath || state.sharedHome));
              const environment =
                claudeActive && state.settings.homePath.trim()
                  ? { ...state.environment, CLAUDE_CONFIG_DIR: state.currentHome }
                  : state.environment;
              return {
                accountId: entry.id,
                driver: entry.driver,
                homePath,
                existing: Boolean(input.accountId) && entry.status !== "pending",
                binaryPath: state.settings.binaryPath,
                environment,
                ...(claudeActive ? { claudeActive: true } : {}),
                cwd: config.cwd,
              } satisfies PreparedProviderAccountLogin;
            }),
          ),
        ),
      complete: (account, identity) =>
        runPromise(
          mutation.withPermit(
            Effect.gen(function* () {
              const registry = yield* registryEffect;
              const snapshot = yield* list();
              const duplicate = snapshot.groups
                .flatMap((group) => group.accounts)
                .find(
                  (entry) =>
                    entry.driver === account.driver &&
                    entry.id !== account.accountId &&
                    entry.email?.toLowerCase() === identity.email.toLowerCase(),
                );
              if (duplicate && !account.existing)
                return yield* new ProviderAccountError({
                  message: "This account is already saved.",
                });
              const checkedAt = DateTime.formatIso(yield* DateTime.now);
              const message = duplicate
                ? `Signed in as ${identity.email}, which is already saved as ${duplicate.label}. Sign in again with the right account.`
                : null;
              yield* io(() =>
                registry.update(account.accountId, {
                  status: duplicate ? "error" : "ready",
                  message,
                  lastUsage: { ...identity, checkedAt },
                }),
              );
              cache.forget(ProviderAccountId.make(account.accountId));
              const observed = observedAccounts.get(account.driver);
              if (observed?.id === account.accountId && observed.checkedAt)
                staleSnapshots.set(account.driver, observed.checkedAt);
              yield* changed(account.driver);
              // A fresh sign-in has no usage yet: probe it once in the background. `force`
              // skips the per-account TTL but the shared budget still gates the attempt.
              if (!message)
                yield* refreshUsage({
                  accountIds: [ProviderAccountId.make(account.accountId)],
                  force: true,
                }).pipe(
                  Effect.andThen(changed(account.driver)),
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Usage probe after account sign-in failed", cause),
                  ),
                  Effect.forkIn(scope),
                );
              return message ? { message } : undefined;
            }),
          ),
        ),
      cleanup: (account) =>
        runPromise(
          mutation.withPermit(
            Effect.gen(function* () {
              const registry = yield* registryEffect;
              yield* deleteManagedHome(account);
              yield* io(() => registry.discardPending(account.accountId));
              yield* changed(account.driver);
            }),
          ),
        ),
    });

    const startLogin = (owner: string, input: ProviderAccountsStartLoginInput) =>
      Stream.callback<ProviderAccountLoginEvent, ProviderAccountError>((queue) =>
        Effect.gen(function* () {
          const abort = new AbortController();
          const callbackContext = yield* Effect.context<never>();
          const runFork = Effect.runForkWith(callbackContext);
          const promise = login.start(
            owner,
            input,
            (event) => {
              const typed: ProviderAccountLoginEvent =
                event._tag === "started" || event._tag === "completed"
                  ? { ...event, accountId: ProviderAccountId.make(event.accountId) }
                  : event;
              runFork(Queue.offer(queue, typed));
            },
            abort.signal,
          );
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              abort.abort();
              await promise.catch(() => {});
            }),
          );
          yield* io(() => promise).pipe(
            Effect.catch(() =>
              Queue.offer(queue, {
                _tag: "failed",
                message: "Could not finalize account sign-in.",
              }),
            ),
          );
          if (autoSwitch) yield* autoSwitch.notify(input.driver);
          yield* Queue.end(queue);
        }).pipe(Effect.forkScoped),
      );

    const switchAccountUnlocked = Effect.fn("providerAccounts.switchUnlocked")(function* (
      input: ProviderAccountsSwitchInput,
    ) {
      const registry = yield* registryEffect;
      const entry = yield* io(() => registry.get(input.accountId));
      if (entry.status === "error" && entry.message)
        return yield* new ProviderAccountError({ message: entry.message });
      if (entry.status === "pending" || login.isBusy(entry.id))
        return yield* new ProviderAccountError({
          message: "Finish signing in before switching accounts.",
        });
      if (entry.driver === "claudeAgent") yield* requireClaudeReady();
      const state = yield* groupState(entry.driver);
      if (entry.driver === "claudeAgent" && state.warning)
        return yield* new ProviderAccountError({ message: state.warning });
      if (state.activeAccountId === entry.id) return yield* list();
      if (entry.driver === "claudeAgent") {
        if (login.isBusy(state.activeAccountId))
          return yield* new ProviderAccountError({
            message: "Finish signing in before switching accounts.",
          });
        const source = yield* io(() => registry.ensureClaudeStore(state.activeAccountId));
        const target = yield* io(() => registry.ensureClaudeStore(entry.id));
        const current = (yield* list()).groups
          .find((group) => group.driver === "claudeAgent")
          ?.accounts.find((account) => account.active);
        if (current && current.status !== "pending") {
          yield* io(() =>
            registry.update(source.id, {
              status: current.status,
              lastUsage: {
                ...source.lastUsage,
                checkedAt:
                  current.usage?.checkedAt ??
                  source.lastUsage?.checkedAt ??
                  new Date().toISOString(),
                ...(source.lastUsage?.email ? {} : current.email ? { email: current.email } : {}),
                ...(current.plan ? { plan: current.plan } : {}),
                ...(current.usage ? { usage: current.usage } : {}),
              },
            }),
          );
        }
        yield* io(() =>
          switchClaudeCredentials({
            stateDir: config.stateDir,
            managedRoot: claudeManagedRoot,
            ...claudeCredentialLocation(state),
            sourceStore: source.storePath!,
            sourceAccountId: source.id,
            targetStore: target.storePath!,
            targetAccountId: target.id,
            ...((source.lastUsage?.email ?? current?.email)
              ? { expectedEmail: source.lastUsage?.email ?? current!.email! }
              : {}),
            ...(source.lastUsage?.accountUuid
              ? { expectedAccountUuid: source.lastUsage.accountUuid }
              : {}),
            resolveSource: async (identity) => {
              // A terminal login as an account we already know reuses that account's
              // store: the live token supersedes whatever stale copy it holds.
              const known = state.accounts.find(
                (candidate) =>
                  candidate.id !== source.id &&
                  candidate.kind !== "external" &&
                  (identity.accountUuid
                    ? candidate.lastUsage?.accountUuid === identity.accountUuid
                    : Boolean(
                        identity.email &&
                        candidate.lastUsage?.email?.toLowerCase() === identity.email.toLowerCase(),
                      )),
              );
              if (known) {
                const reused = await registry.ensureClaudeStore(known.id);
                return { accountId: reused.id, store: reused.storePath! };
              }
              const external = await registry.createManaged({
                driver: "claudeAgent",
                label: identity.email ?? "Terminal account",
                sharedHomePath: state.sharedHomePath,
                sourceConfigPath: state.sourceConfigPath,
              });
              return {
                accountId: external.id,
                store: external.homePath,
                discard: async () => {
                  await NodeFSP.rm(external.homePath, { recursive: true, force: true });
                  await registry.discardPending(external.id);
                },
              };
            },
            commit: (result) => commitClaudeSwitch(registry, result),
          }),
        );
        checkoutGeneration.claudeAgent++;
        cache.forget(ProviderAccountId.make(source.id));
        cache.forget(ProviderAccountId.make(target.id));
        yield* refreshClaudeSnapshot;
        return yield* list();
      }
      yield* io(() =>
        registry.prepareSwitch(
          entry.driver,
          state.currentHome,
          state.sharedHome,
          entry.id,
          state.settings.homePath,
        ),
      );
      if (entry.kind === "managed") {
        yield* io(() =>
          materializeCodexAccountHome({
            homePath: entry.homePath,
            sharedHomePath: state.sharedHomePath,
          }),
        );
      }
      const current = (yield* list()).groups
        .find((group) => group.driver === entry.driver)
        ?.accounts.find((account) => account.active);
      if (current && current.status !== "pending") {
        const checkedAt = current.usage?.checkedAt ?? DateTime.formatIso(yield* DateTime.now);
        const previous = yield* io(() => registry.get(current.id));
        yield* io(() =>
          registry.update(current.id, {
            status: current.status,
            lastUsage: {
              ...previous.lastUsage,
              checkedAt,
              ...(current.email ? { email: current.email } : {}),
              ...(current.plan ? { plan: current.plan } : {}),
              ...(current.usage ? { usage: current.usage } : {}),
            },
          }),
        );
        cache.forget(current.id);
      }
      yield* switcher.switchAccount({
        driver: entry.driver,
        homePath: entry.homePath,
        directMode: entry.homePath === "",
        ...(input.interruptRunning === undefined
          ? {}
          : { interruptRunning: input.interruptRunning }),
      });
      checkoutGeneration.codex++;
      return yield* list();
    });

    const switchAccount = Effect.fn("providerAccounts.switch")(function* (
      input: ProviderAccountsSwitchInput,
    ) {
      const snapshot = yield* switchAccountUnlocked(input);
      const group = snapshot.groups.find((entry) => entry.activeAccountId === input.accountId)!;
      const active = group.accounts.find((entry) => entry.id === input.accountId)!;
      const registry = yield* registryEffect;
      const now = yield* Clock.currentTimeMillis;
      yield* io(() =>
        registry.updateAutoSwitch(group.driver, {
          manual: {
            at: now,
            holdUntil: now + 2 * 60 * 60_000,
            activeWasBelowThreshold: activeBelowThreshold(
              { ...active, loginInProgress: login.isBusy(active.id) },
              now,
              group.autoSwitch.thresholdPercent,
            ),
          },
        }),
      );
      if (autoSwitch) {
        yield* autoSwitch.clear(group.driver);
        yield* autoSwitch.notify(group.driver);
      }
      yield* changed(group.driver);
      return yield* list();
    }, mutation.withPermit);

    const rename = Effect.fn("providerAccounts.rename")(function* (input: {
      accountId: ProviderAccountId;
      label: string;
    }) {
      const registry = yield* registryEffect;
      const entry = yield* io(() => registry.rename(input.accountId, input.label));
      yield* changed(entry.driver);
      return yield* list();
    }, mutation.withPermit);

    const remove = Effect.fn("providerAccounts.remove")(function* (input: {
      accountId: ProviderAccountId;
    }) {
      const registry = yield* registryEffect;
      const entry = yield* io(() => registry.get(input.accountId));
      if (entry.driver === "claudeAgent") yield* requireClaudeReady();
      const state = yield* groupState(entry.driver);
      if (entry.kind === "default" || entry.id === state.activeAccountId || login.isBusy(entry.id))
        return yield* new ProviderAccountError({
          message: "Default, active, or signing-in accounts cannot be removed.",
        });
      if (entry.kind === "managed") {
        const account = {
          accountId: entry.id,
          driver: entry.driver,
          homePath: entry.homePath,
          existing: true,
          binaryPath: state.settings.binaryPath,
          environment: state.environment,
          cwd: config.cwd,
        };
        yield* io(() => login.logout(account));
        yield* deleteManagedHome(account);
      }
      yield* io(() => registry.remove(input.accountId, state.currentHome));
      cache.forget(input.accountId);
      if (autoSwitch) yield* autoSwitch.notify(entry.driver);
      yield* changed(entry.driver);
      return yield* list();
    }, mutation.withPermit);

    const setAutoSwitch = Effect.fn("providerAccounts.setAutoSwitch")(function* (
      input: ProviderAccountsSetAutoSwitchInput,
    ) {
      const registry = yield* registryEffect;
      yield* io(() =>
        registry.updateAutoSwitch(input.driver, {
          enabled: input.enabled,
          ...(input.thresholdPercent === undefined
            ? {}
            : { thresholdPercent: input.thresholdPercent }),
        }),
      );
      if (autoSwitch) {
        yield* autoSwitch.clear(input.driver);
        yield* autoSwitch.notify(input.driver);
      }
      yield* changed(input.driver);
      return yield* list();
    }, mutation.withPermit);

    // OrchestrationEngine commits projectEventDeferred's SQL projections before
    // publishing domain events. Only attachment cleanup is deferred, so idle
    // evaluations can read the updated shell immediately (no timer/poll needed).
    const idleChanges = Stream.unwrap(engine.subscribeDomainEvents).pipe(
      Stream.filter((event) => event.type === "thread.session-set"),
      Stream.flatMap((event) => {
        const instanceId =
          event.payload.session.providerInstanceId ?? event.payload.session.providerName;
        return Stream.fromIterable(
          (["claudeAgent", "codex"] as const).filter(
            (driver) =>
              autoSwitch?.needsIdle(driver) &&
              defaultInstanceIdForDriver(ProviderDriverKind.make(driver)) === instanceId,
          ),
        );
      }),
    );
    autoSwitch = yield* makeProviderAccountAutoSwitch({
      read: (driver) =>
        Effect.gen(function* () {
          const registry = yield* registryEffect;
          const automatic = yield* io(() => registry.getAutoSwitch(driver));
          const group = (yield* list()).groups.find((entry) => entry.driver === driver)!;
          const now = yield* Clock.currentTimeMillis;
          const probeBlocked = new Set<ProviderAccountId>();
          const probeWakeAt = new Map<ProviderAccountId, number>();
          for (const account of group.accounts) {
            if (account.active) continue;
            const entry = yield* io(() => registry.get(account.id));
            const previous: AccountUsage | undefined = entry.lastUsage
              ? { ...entry.lastUsage, status: entry.status === "pending" ? "error" : entry.status }
              : undefined;
            // A successful cached measurement remains selectable during the normal probe TTL.
            const usage = account.usage;
            const fresh =
              !previous?.lastFailureKind &&
              usage &&
              !usage.unavailable &&
              usage.windows.length > 0 &&
              now - Date.parse(usage.checkedAt) <= 5 * 60_000 &&
              !usage.windows.some(
                (window) => window.resetsAt && Date.parse(window.resetsAt) <= now,
              );
            if (!fresh && !cache.canProbe(account.id, now, previous)) {
              probeBlocked.add(account.id);
              probeWakeAt.set(account.id, cache.nextAllowedAt(account.id, now, previous));
            }
          }
          return {
            config: automatic,
            group,
            probeBlocked,
            probeWakeAt,
            loginInProgress: group.accounts
              .filter((account) => login.isBusy(account.id))
              .map((account) => account.id),
          };
        }),
      refresh: (accountIds) => refreshUsage({ accountIds }),
      switchAccount: (accountId) => switchAccountUnlocked({ accountId, interruptRunning: false }),
      persistLastSwitch: (driver, lastSwitch) =>
        Effect.gen(function* () {
          const registry = yield* registryEffect;
          yield* io(() => registry.updateAutoSwitch(driver, { lastSwitch, manual: null }));
        }),
      withMutation: mutation.withPermit,
      providerChanges: providers.streamChanges,
      idleChanges,
      publish: (event) =>
        PubSub.publish(autoEvents, event).pipe(
          Effect.andThen(event._tag === "switched" ? changed(event.driver) : Effect.void),
          Effect.asVoid,
        ),
    });

    return {
      list,
      refreshUsage,
      setAutoSwitch,
      autoSwitchEvents: Stream.fromPubSub(autoEvents),
      startLogin,
      switchAccount,
      rename,
      remove,
      submitLoginCode: (owner: string, input: { loginId: string; code: string }) =>
        io(() => login.submitCode(owner, input.loginId, input.code)),
      cancelLogin: (owner: string, input: { loginId: string }) =>
        io(() => login.cancel(owner, input.loginId)),
    };
  });

export class ProviderAccountsService extends Context.Service<
  ProviderAccountsService,
  Effect.Success<ReturnType<typeof make>>
>()("t3/provider/accounts/ProviderAccountsService") {
  static readonly layer = Layer.effect(ProviderAccountsService, make());
  static readonly layerWithLogin = (createLogin: CreateLogin, probe?: typeof probeAccountUsage) =>
    Layer.effect(ProviderAccountsService, make(createLogin, probe));
}
