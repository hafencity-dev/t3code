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
  type ProviderAccountsActivityInput,
  type ProviderAccountsSetAutoSwitchExcludedInput,
  type ProviderAccountsSetAutoSwitchInput,
  type ProviderAccountsSetWindowPrimerInput,
  type ProviderAccountsRefreshUsageInput,
  type ProviderAccountsStartLoginInput,
  type ProviderAccountsSwitchInput,
  type ProviderAccountsSnapshot,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { Clock, Context, DateTime, Effect, Layer, PubSub, Queue, Semaphore, Stream } from "effect";
import { makeProviderAccountAutoSwitch } from "./ProviderAccountAutoSwitch.ts";
import {
  createProviderAccountActivityLog,
  type ProviderAccountActivityRecord,
} from "./ProviderAccountActivityLog.ts";
import { nextAutoSwitchTarget, usageConfirmed } from "./autoSwitchPolicy.ts";
import { makeProviderAccountWindowPrimer } from "./ProviderAccountWindowPrimer.ts";
import {
  claudeWindowPrimeLaunch,
  runClaudeWindowPrime,
  type ClaudeWindowPrimeFailure,
} from "./ClaudeWindowPrime.ts";
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
import { inactiveClaudeProbeEnvironment } from "./ClaudeAccountHome.ts";
import {
  ProviderAccountLogin,
  ProviderAccountLoginError,
  type PreparedProviderAccountLogin,
  type ProviderAccountLoginOptions,
} from "./ProviderAccountLogin.ts";
import { hasIdentity, identityKeeper, keeperRank, sameAccountIdentity } from "./accountIdentity.ts";
import { makeProviderAccountHolds } from "./ProviderAccountHolds.ts";
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
  type ClaudeCredentialSwitchAbandoned,
  readClaudeConfigIdentity,
  type ClaudeCredentialIdentity,
  type ClaudeCredentialSwitchResult,
} from "./ClaudeCredentialSwitch.ts";

const claudeStoreHomeWarning =
  "Claude home points at a saved account store. Reset the Claude config directory in Settings to use hot switching.";
const claudeHomeChangedWarning =
  "Claude config directory changed in Settings. Restore it to switch accounts.";
/** A terminal `claude auth login` overwrote this account's token in the active home. */
export const claudeTerminalSignedOutMessage =
  "Signed out by a sign-in in the terminal. Sign in again to use this account.";
/** A terminal `claude auth logout` left the active home without any account. */
export const claudeTerminalLogoutMessage = "Signed out in the terminal.";
const claudeBarrierWarning = (reason: string) =>
  `A previous Claude account switch didn't finish: ${reason} Accounts are locked until it's resolved.`;

export { inactiveClaudeProbeEnvironment };
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

/** Like `io`, but interruption abandons the promise; only for waits a finalizer aborts. */
const interruptibleIo = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: (cause) => cause }).pipe(
    Effect.catch((cause) => {
      if (
        cause instanceof ProviderAccountRegistryGuardError ||
        cause instanceof ClaudeCredentialSwitchError ||
        cause instanceof ProviderAccountLoginError
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
/**
 * A storage step, once started, finishes before its fiber can be interrupted. Interrupting it
 * mid-write would release the account mutation (or close the service scope) while the write
 * still runs underneath.
 */
const io = <A>(operation: () => Promise<A>) => Effect.uninterruptible(interruptibleIo(operation));

function effectiveEnvironment(settings: ServerSettings, driver: ProviderAccountDriver) {
  return mergeProviderInstanceEnvironment(
    settings.providerInstances[defaultInstanceIdForDriver(ProviderDriverKind.make(driver))]
      ?.environment,
  );
}

/** The live snapshot, when it describes this entry; otherwise the entry's stored numbers apply. */
function ownSnapshot(entry: ProviderAccountEntry, provider: ServerProvider | undefined) {
  const metadata = entry.lastUsage;
  // The live Claude snapshot describes whoever is signed in to the active home. It belongs to
  // this entry only while it reports the entry's own identity; a terminal login elsewhere must
  // never lend its email, plan or limits to the saved account.
  const foreign =
    entry.driver === "claudeAgent" &&
    Boolean(metadata?.email && provider?.auth.email) &&
    provider!.auth.email!.toLowerCase() !== metadata!.email!.toLowerCase();
  return (entry.status === "error" && entry.message) || foreign ? undefined : provider;
}

function accountFromEntry(
  entry: ProviderAccountEntry,
  active: boolean,
  provider?: ServerProvider,
  usageRefresh?: ProviderAccount["usageRefresh"],
): ProviderAccount {
  const metadata = entry.lastUsage;
  const snapshot = ownSnapshot(entry, provider);
  // A recorded sign-out (such as a terminal logout) outranks a snapshot taken before it.
  const status =
    entry.status === "pending" ||
    ((entry.status === "error" || entry.status === "signedOut") && entry.message)
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
    ...(entry.autoSwitchExcluded ? { autoSwitchExcluded: true } : {}),
    // The active account's usage is live and never probed, so it has no probe backoff.
    ...(!active && usageRefresh ? { usageRefresh } : {}),
  };
}

/** The identity an entry recorded from its own sign-in; never the live home's. */
const storedIdentity = (entry: ProviderAccountEntry): ClaudeCredentialIdentity => ({
  ...(entry.lastUsage?.email ? { email: entry.lastUsage.email } : {}),
  ...(entry.lastUsage?.accountUuid ? { accountUuid: entry.lastUsage.accountUuid } : {}),
  ...(entry.lastUsage?.workspaceId ? { workspaceId: entry.lastUsage.workspaceId } : {}),
});
/** The saved account that owns a live identity, by the keeper rule. */
const keeperOf = (
  entries: ReadonlyArray<ProviderAccountEntry>,
  identity: ClaudeCredentialIdentity,
  excludeId?: string,
) => identityKeeper(entries, identity, storedIdentity, excludeId);
/** The usage the cache compares against; pending entries count as errored. */
const previousUsage = (entry: ProviderAccountEntry): AccountUsage | undefined =>
  entry.lastUsage
    ? { ...entry.lastUsage, status: entry.status === "pending" ? "error" : entry.status }
    : undefined;
/** An inactive Claude account's own store. Never the active home or the shared home. */
const claudeStoreOf = (entry: ProviderAccountEntry) =>
  entry.storePath ?? (entry.kind === "managed" ? entry.homePath : undefined);

/**
 * Best known identity per account. The active Claude account prefers the active home's live
 * config, unless the registry knows a different identity (a terminal login the next switch
 * files away). The kept account of each identity is Default, then the oldest ready account.
 */
function accountIdentities(
  entries: ReadonlyArray<ProviderAccountEntry>,
  accounts: ReadonlyArray<ProviderAccount>,
  live: ClaudeCredentialIdentity | undefined,
) {
  const identities = new Map<string, ClaudeCredentialIdentity>();
  for (const entry of entries) {
    const account = accounts.find((candidate) => candidate.id === entry.id)!;
    const stored = storedIdentity(entry);
    const saved: ClaudeCredentialIdentity = hasIdentity(stored)
      ? stored
      : account.email
        ? { email: account.email }
        : {};
    const useLive =
      account.active &&
      live !== undefined &&
      hasIdentity(live) &&
      (!hasIdentity(saved) || sameAccountIdentity(saved, live));
    identities.set(entry.id, useLive ? live : saved);
  }
  const rank = (account: ProviderAccount) => keeperRank(account);
  const kept = entries
    .filter((entry) => entry.kind !== "external" && entry.status !== "pending")
    .map((entry) => ({ entry, account: accounts.find((account) => account.id === entry.id)! }))
    .toSorted(
      (left, right) =>
        rank(left.account) - rank(right.account) ||
        left.entry.createdAt.localeCompare(right.entry.createdAt),
    );
  const duplicateOf = (entry: ProviderAccountEntry) => {
    const identity = identities.get(entry.id)!;
    if (entry.kind !== "managed" || entry.status === "pending" || !hasIdentity(identity)) return;
    const original = kept.find((candidate) =>
      sameAccountIdentity(identities.get(candidate.entry.id)!, identity),
    );
    return original && original.entry.id !== entry.id ? original.account.id : undefined;
  };
  return { identities, duplicateOf };
}

/** `15m`, `2h`, `1h 30m`: how long a rate-limited account waits before the next check. */
function formatActivityWait(ms: number) {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours === 0 ? `${minutes}m` : rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

const claudeGroupOf = (snapshot: ProviderAccountsSnapshot) =>
  snapshot.groups.find((group) => group.driver === "claudeAgent");

type LoginClient = Pick<
  ProviderAccountLogin,
  "start" | "isBusy" | "logout" | "submitCode" | "cancel"
>;
type CreateLogin = (options: ProviderAccountLoginOptions) => LoginClient;
const make = (
  createLogin: CreateLogin = (options) => new ProviderAccountLogin(options),
  probe: typeof probeAccountUsage = probeAccountUsage,
  runPrime: typeof runClaudeWindowPrime = runClaudeWindowPrime,
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
    const autoEvents = yield* PubSub.unbounded<ProviderAccountAutoSwitchEvent>();
    yield* Effect.addFinalizer(() => PubSub.shutdown(autoEvents));
    const activity = createProviderAccountActivityLog({ stateDir: config.stateDir });
    // Registered before any fiber is forked, so it runs after they are all interrupted.
    yield* Effect.addFinalizer(() => Effect.promise(() => activity.settled()));
    const runActivityFork = Effect.runForkWith(yield* Effect.context<never>());
    /**
     * Records at an action's commit point. The write is queued in call order but never awaited,
     * so it can't fail or slow the action (it runs under the account mutation); a write error
     * is only a warning.
     */
    const recordActivity = (record: ProviderAccountActivityRecord) =>
      Effect.flatMap(Clock.currentTimeMillis, (at) =>
        Effect.sync(() => {
          void activity.append(record, at).then(
            () =>
              runActivityFork(
                PubSub.publish(autoEvents, {
                  _tag: "changed",
                  driver: record.driver,
                  activity: true,
                }),
              ),
            (cause: unknown) =>
              runActivityFork(
                Effect.logWarning("Could not write the account activity log", {
                  causeType: cause instanceof Error ? cause.name : typeof cause,
                }),
              ),
          );
        }),
      );
    // A hot switch keeps the instance's config home, and the instance caches its capabilities
    // probe (identity and limits) per home. A plain refresh would re-publish the previous
    // account's email and limits under a fresh timestamp, which then hides the active account's
    // own usage until the cache expires. Every refresh that follows a credential change drops it.
    const refreshInstanceLive = (instanceId: ProviderInstanceId) =>
      Effect.gen(function* () {
        const instance = yield* instances.getInstance(instanceId);
        if (instance?.invalidateCaches) yield* instance.invalidateCaches;
        return yield* providers.refreshInstance(instanceId);
      });
    // A hot switch returns as soon as credentials moved; the snapshot follows in the
    // background while list() masks the previous account's identity and limits.
    const refreshClaudeSnapshot = Effect.gen(function* () {
      const observed = observedAccounts.get("claudeAgent");
      if (observed?.checkedAt) staleSnapshots.set("claudeAgent", observed.checkedAt);
      yield* refreshInstanceLive(claudeInstanceId).pipe(
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
      const found: ProviderAccountActivityRecord[] = [];
      // A terminal logout moved the source away with no token; it is signed out, not replaced.
      if (result.sourceSignedOut) {
        const source = await registry.update(result.sourceAccountId, {
          status: "signedOut",
          message: claudeTerminalLogoutMessage,
        });
        found.push({
          driver: "claudeAgent",
          kind: "terminal.logout",
          accountId: ProviderAccountId.make(source.id),
          labels: { account: source.label },
          reason: "Found while switching accounts",
          outcome: "ok",
        });
      }
      if (result.externalIdentity && hasIdentity(result.externalIdentity)) {
        await registry.update(result.originalSourceAccountId, {
          status: "signedOut",
          message: claudeTerminalSignedOutMessage,
        });
        const reused = await registry.get(result.sourceAccountId);
        found.push({
          driver: "claudeAgent",
          kind: "terminal.login",
          toAccountId: ProviderAccountId.make(reused.id),
          labels: { to: reused.label },
          // A terminal login to an unknown account was just saved as a new, pending one.
          ...(reused.status === "pending" ? { created: true } : {}),
          reason: "Found while switching accounts",
          outcome: "ok",
        });
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
      for (const record of found) await runPromise(recordActivity(record));
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
        }).pipe(Effect.uninterruptible),
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
      if (outcome.success && "abandoned" in outcome.success) {
        const abandoned: ClaudeCredentialSwitchAbandoned = outcome.success;
        // Every store was left as it was; reconcile files whatever the active home now holds.
        yield* Effect.logWarning("Abandoned an unrecoverable Claude credential switch", {
          phase: abandoned.phase,
          reason: abandoned.reason,
          journalPath: abandoned.journalPath,
        });
        yield* recordActivity({
          driver: "claudeAgent",
          kind: "recovery.abandonedJournal",
          labels: {},
          reason: abandoned.reason,
          outcome: "skipped",
        });
        return;
      }
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
    let autoSwitch: Effect.Success<ReturnType<typeof makeProviderAccountAutoSwitch>> | undefined;
    let windowPrimer:
      | Effect.Success<ReturnType<typeof makeProviderAccountWindowPrimer>>
      | undefined;
    const changed = (driver: ProviderAccountDriver) =>
      PubSub.publish(autoEvents, { _tag: "changed", driver }).pipe(
        // Account list changes can make a Claude window startable (or not).
        Effect.andThen(
          driver === "claudeAgent" && windowPrimer ? windowPrimer.notify : Effect.void,
        ),
        Effect.asVoid,
      );

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

    // ~/.claude.json can be large; re-read it only when it changed on disk.
    let liveClaude:
      | { path: string; mtimeMs: number; size: number; identity: ClaudeCredentialIdentity }
      | undefined;
    const liveClaudeIdentity = (state: Parameters<typeof claudeCredentialLocation>[0]) =>
      Effect.promise(async () => {
        const path = claudeCredentialLocation(state).activeConfigPath;
        const stat = await NodeFSP.stat(path).catch(() => undefined);
        if (!stat) return {};
        if (
          liveClaude?.path === path &&
          liveClaude.mtimeMs === stat.mtimeMs &&
          liveClaude.size === stat.size
        )
          return liveClaude.identity;
        const identity = await readClaudeConfigIdentity(path);
        liveClaude = { path, mtimeMs: stat.mtimeMs, size: stat.size, identity };
        return identity;
      });

    const claudeJournalPending = Effect.promise(() =>
      NodeFSP.stat(claudeCredentialSwitchJournalPath(config.stateDir)).then(
        () => true,
        () => false,
      ),
    );

    const listDetailed = Effect.fn("providerAccounts.listDetailed")(function* () {
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
          const live = driver === "claudeAgent" ? yield* liveClaudeIdentity(state) : undefined;
          // Capture Default's first known identity so a later terminal login cannot silently
          // become the saved Default account when its credentials are checked back in. Never
          // while a switch journal owns the active home, nor another saved account's identity.
          const capturedEmail = live?.email ?? snapshot?.auth.email;
          const capturedIdentity: ClaudeCredentialIdentity = live?.email
            ? live
            : capturedEmail
              ? { email: capturedEmail }
              : {};
          if (
            driver === "claudeAgent" &&
            captured?.kind === "default" &&
            !captured.lastUsage?.email &&
            capturedEmail &&
            claudeBarrier === undefined &&
            !(yield* claudeJournalPending) &&
            !keeperOf(state.accounts, capturedIdentity, captured.id)
          ) {
            yield* io(() =>
              registry.update(captured.id, {
                lastUsage: {
                  ...captured.lastUsage,
                  checkedAt: snapshot?.checkedAt ?? new Date().toISOString(),
                  email: capturedEmail,
                  ...(live?.email && live.accountUuid ? { accountUuid: live.accountUuid } : {}),
                  ...(live?.email && live.workspaceId ? { workspaceId: live.workspaceId } : {}),
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
          const now = yield* Clock.currentTimeMillis;
          const accounts = state.accounts.map((entry) => {
            const active = entry.id === state.activeAccountId;
            // When a manual check may run next, including the shared probe budget.
            const nextAllowedAt = active
              ? 0
              : cache.nextAllowedAt(
                  ProviderAccountId.make(entry.id),
                  now,
                  previousUsage(entry),
                  true,
                );
            const rateLimited = entry.lastUsage?.lastFailureKind === "rateLimited";
            return accountFromEntry(
              entry,
              active,
              active ? snapshot : undefined,
              nextAllowedAt > now || entry.lastUsage?.lastFailureKind
                ? {
                    ...(nextAllowedAt > 0
                      ? { nextAllowedAt: DateTime.formatIso(DateTime.makeUnsafe(nextAllowedAt)) }
                      : {}),
                    rateLimited,
                  }
                : undefined,
            );
          });
          const activeEntry = state.accounts.find((entry) => entry.id === state.activeAccountId);
          const activeUsageLive =
            activeEntry !== undefined && ownSnapshot(activeEntry, snapshot) !== undefined;
          const { identities, duplicateOf } = accountIdentities(state.accounts, accounts, live);
          const groupAccounts = state.accounts.map((entry, index) => {
            const original = duplicateOf(entry);
            return { ...accounts[index]!, ...(original ? { duplicateOf: original } : {}) };
          });
          const next = nextAutoSwitchTarget({
            now,
            config: automatic,
            activeAccountId: ProviderAccountId.make(state.activeAccountId),
            accounts: groupAccounts.map((account) => ({
              ...account,
              loginInProgress: login.isBusy(account.id),
            })),
          });
          const primer =
            driver === "claudeAgent" ? yield* io(() => registry.getWindowPrimer()) : undefined;
          const lastPrimed = Object.entries(primer?.primedAt ?? {})
            .filter(([id]) => state.accounts.some((entry) => entry.id === id))
            .toSorted((left, right) => right[1] - left[1])[0];
          const group = {
            driver,
            instanceId,
            switchMode: driver === "claudeAgent" ? ("hot" as const) : ("restart" as const),
            activeAccountId: ProviderAccountId.make(state.activeAccountId),
            autoSwitch: {
              enabled: automatic.enabled,
              thresholdPercent: automatic.thresholdPercent,
              weeklyThresholdPercent: automatic.weeklyThresholdPercent,
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
            ...(primer
              ? {
                  windowPrimer: {
                    enabled: primer.enabled,
                    ...(primer.enabled ? windowPrimer?.getState() : {}),
                    ...(lastPrimed
                      ? {
                          lastPrimedAt: new Date(lastPrimed[1]).toISOString(),
                          lastPrimedAccountId: ProviderAccountId.make(lastPrimed[0]),
                        }
                      : {}),
                  },
                }
              : {}),
            ...(next ? { nextAccountId: next.accountId } : {}),
            ...(next?.due ? { nextAccountDue: true as const } : {}),
            accounts: groupAccounts,
            ...(warning ? { warning } : {}),
          };
          return { group, identities, activeUsageLive };
        }),
      );
      return {
        snapshot: { groups: groups.map((entry) => entry.group) },
        identities: new Map(groups.flatMap((entry) => [...entry.identities])),
        activeUsageLive: new Map(
          groups.map((entry) => [entry.group.driver, entry.activeUsageLive]),
        ),
      };
    });

    /**
     * Files a terminal `claude auth login` under the right saved account. The caller holds the
     * account mutation. No credential moves: the active home already holds the live login, so
     * only the active selection changes. The previous account's store stays checked out, and
     * its token was overwritten by the terminal login, so it is marked signed out.
     */
    const reconcileClaudeUnlocked = Effect.fn("providerAccounts.reconcileClaude")(function* () {
      const registry = yield* registryEffect;
      // An unfinished switch owns the active home until recovery resolves it.
      if ((yield* claudeJournalPending) || claudeBarrier !== undefined) return false;
      const state = yield* groupState("claudeAgent");
      if (state.warning) return false;
      const active = state.accounts.find((entry) => entry.id === state.activeAccountId);
      // A sign-in into the active home finishes through its own completion.
      if (!active || active.kind === "external" || login.isBusy(active.id)) return false;
      const live = yield* liveClaudeIdentity(state);
      const known = storedIdentity(active);
      // A terminal logout: the active account is signed out; nothing else changes.
      if (!hasIdentity(live)) {
        if (
          !hasIdentity(known) ||
          (active.status === "signedOut" && active.message) ||
          (active.status === "error" && active.message)
        )
          return false;
        yield* io(() =>
          registry.update(active.id, { status: "signedOut", message: claudeTerminalLogoutMessage }),
        );
        yield* Effect.logInfo("The active Claude account was signed out in the terminal");
        yield* recordActivity({
          driver: "claudeAgent",
          kind: "terminal.logout",
          accountId: ProviderAccountId.make(active.id),
          labels: { account: active.label },
          outcome: "ok",
        });
        yield* changed("claudeAgent");
        return true;
      }
      const keeper = keeperOf(state.accounts, live);
      // Default's first identity is captured from the live home, unless it is another
      // saved account's: then the selection moves to that account like any terminal login.
      if (!hasIdentity(known) && active.kind === "default" && !keeper) return false;
      const activeMatches = hasIdentity(known) && sameAccountIdentity(known, live);
      // The active account is the live identity's keeper, or the only account that knows it.
      if (activeMatches && (!keeper || keeper.id === active.id)) {
        // Signed back in after a terminal logout.
        if (active.status !== "signedOut" || active.message !== claudeTerminalLogoutMessage)
          return false;
        yield* io(() => registry.update(active.id, { status: "ready", message: null }));
        yield* recordActivity({
          driver: "claudeAgent",
          kind: "terminal.login",
          toAccountId: ProviderAccountId.make(active.id),
          labels: { to: active.label },
          outcome: "ok",
        });
        yield* changed("claudeAgent");
        return true;
      }
      // Unknown active identity and no saved match: the live login may well be its own.
      if (!activeMatches && !keeper && !hasIdentity(known)) return false;
      const target =
        keeper ??
        (yield* io(async () => {
          const created = await registry.createManaged({
            driver: "claudeAgent",
            label: live.email ?? "Terminal account",
            sharedHomePath: state.sharedHomePath,
            sourceConfigPath: state.sourceConfigPath,
          });
          // The terminal login is this new account's own sign-in.
          await registry.update(created.id, {
            status: "ready",
            message: null,
            lastUsage: { ...live, checkedAt: new Date().toISOString() },
          });
          return created;
        }));
      yield* io(async () => {
        // An empty store is the checked-out state; the next switch-away files the live token.
        await registry.ensureClaudeStore(target.id);
        // The previous account leaves checked out too: an inactive account always has its own
        // store, so it never signs in or probes through the active home.
        await registry.ensureClaudeStore(active.id);
        if (keeper) await registry.update(target.id, { status: "ready", message: null });
        await registry.setClaudeActiveAccount(target.id);
        // A conflicting sign-in keeps its own, more specific message.
        if (!(active.status === "error" && active.message))
          await registry.update(active.id, {
            status: "signedOut",
            message: claudeTerminalSignedOutMessage,
          });
      });
      // Same live credentials: the provider snapshot now describes the new selection.
      const observed = observedAccounts.get("claudeAgent");
      if (observed) observedAccounts.set("claudeAgent", { ...observed, id: target.id });
      checkoutGeneration.claudeAgent++;
      cache.forget(ProviderAccountId.make(active.id));
      cache.forget(ProviderAccountId.make(target.id));
      yield* Effect.logInfo("Filed a terminal Claude sign-in under its saved account", {
        created: !keeper,
      });
      yield* recordActivity({
        driver: "claudeAgent",
        kind: "terminal.login",
        fromAccountId: ProviderAccountId.make(active.id),
        toAccountId: ProviderAccountId.make(target.id),
        labels: { from: active.label, to: target.label },
        ...(keeper ? {} : { created: true }),
        outcome: "ok",
      });
      yield* changed("claudeAgent");
      return true;
    });
    /** Reconciles when no account mutation is running; mutations reconcile on their own. */
    const reconcileClaudeIfIdle = mutation
      .withPermitsIfAvailable(1)(reconcileClaudeUnlocked())
      .pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.logWarning("Reconciling the active Claude account failed", cause),
        ),
      );

    const list = Effect.fn("providerAccounts.list")(function* (): Effect.fn.Return<
      ProviderAccountsSnapshot,
      ProviderAccountError
    > {
      yield* reconcileClaudeIfIdle;
      return (yield* listDetailed()).snapshot;
    });

    // Probes and window starts hold their account; a switch waits for them and blocks new ones.
    const holds = makeProviderAccountHolds();
    const cache = makeAccountUsageCache({
      probe: (id: ProviderAccountId) =>
        Effect.gen(function* () {
          const registry = yield* registryEffect;
          const entry = yield* io(() => registry.get(id));
          const state = yield* groupState(entry.driver);
          const generation = checkoutGeneration[entry.driver];
          const homePath =
            entry.driver === "claudeAgent"
              ? claudeStoreOf(entry)
              : entry.homePath || state.sharedHome;
          // refreshUsage never asks for a Claude account without a store; fail closed anyway.
          if (homePath === undefined)
            return yield* Effect.fail(
              new AccountUsageProbeStaleError("Account has no saved store to probe."),
            );
          const input = { homePath, cwd: config.cwd };
          const result = yield* holds.shared(entry.id)(
            (state.driver === "claudeAgent"
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
            ).pipe(Effect.provide(context)),
          );
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

    /** Also reports which accounts got a new measurement, for the auto-switch policy. */
    const refreshUsageMeasured = Effect.fn("providerAccounts.refreshUsageMeasured")(function* (
      input: ProviderAccountsRefreshUsageInput,
      notifyAutoSwitch: boolean,
    ) {
      const registry = yield* registryEffect;
      const measured = new Set<ProviderAccountId>();
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
            // An inactive Claude account is probed in its own store or not at all.
            if (entry.driver === "claudeAgent" && claudeStoreOf(entry) === undefined) return;
            const previous = previousUsage(entry);
            const { usage: result, measured: fresh } = yield* cache.refreshMeasured({
              id: account.id,
              active: false,
              ...(previous ? { previous } : {}),
              ...(input.force === undefined ? {} : { force: input.force }),
            });
            if (fresh) measured.add(account.id);
            // A probe measures usage; the identity stays the one the account signed in with.
            // Probes report no account uuid and may omit the email.
            if (result)
              yield* io(() =>
                registry.update(account.id, {
                  status: result.status,
                  lastUsage: { ...result, ...storedIdentity(entry) },
                }),
              );
            // Once per backoff period: a rate limit that continues is not logged again.
            if (
              result?.lastFailureKind === "rateLimited" &&
              entry.lastUsage?.lastFailureKind !== "rateLimited"
            ) {
              const now = yield* Clock.currentTimeMillis;
              const wait = (result.nextAllowedAt ?? now) - now;
              yield* recordActivity({
                driver: entry.driver,
                kind: "usage.rateLimited",
                accountId: account.id,
                labels: { account: entry.label },
                ...(wait > 0 ? { reason: `Retrying in ${formatActivityWait(wait)}` } : {}),
                outcome: "failed",
              });
            }
          }),
        { concurrency: 2 },
      );
      if (windowPrimer) yield* windowPrimer.notify;
      // New candidate numbers can change the auto-switch decision; its own probes re-read.
      if (notifyAutoSwitch && autoSwitch)
        for (const driver of ["claudeAgent", "codex"] as const)
          if (
            snapshot.groups
              .find((group) => group.driver === driver)
              ?.accounts.some((account) => measured.has(account.id))
          )
            yield* autoSwitch.notify(driver);
      return { snapshot: yield* list(), measured };
    });
    const refreshUsage = (input: ProviderAccountsRefreshUsageInput) =>
      refreshUsageMeasured(input, true).pipe(Effect.map(({ snapshot }) => snapshot));

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
              if (input.driver === "claudeAgent") {
                yield* requireClaudeReady();
                yield* reconcileClaudeUnlocked();
              }
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
              // An inactive Claude account signs in to its own store, created (empty) if needed.
              const homePath = claudeActive
                ? state.currentHome
                : entry.driver === "claudeAgent"
                  ? (claudeStoreOf(entry) ??
                    (yield* io(() => registry.ensureClaudeStore(entry.id))).storePath!)
                  : entry.homePath || state.sharedHome;
              const environment =
                claudeActive && state.settings.homePath.trim()
                  ? { ...state.environment, CLAUDE_CONFIG_DIR: state.currentHome }
                  : state.environment;
              return {
                accountId: entry.id,
                driver: entry.driver,
                homePath,
                existing: Boolean(input.accountId) && entry.status !== "pending",
                ...(!input.accountId && !input.label ? { unnamed: true } : {}),
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
              const { snapshot, identities } = yield* listDetailed();
              // Claude writes the signed-in account uuid next to its email; keep it when both agree.
              const writtenPath =
                account.driver !== "claudeAgent"
                  ? undefined
                  : account.claudeActive
                    ? claudeCredentialLocation(yield* configuration("claudeAgent")).activeConfigPath
                    : NodePath.join(account.homePath, ".claude.json");
              const written: ClaudeCredentialIdentity = writtenPath
                ? yield* Effect.promise(() => readClaudeConfigIdentity(writtenPath))
                : {};
              const writtenMatches = written.email?.toLowerCase() === identity.email.toLowerCase();
              const workspaceId =
                account.driver === "codex"
                  ? identity.workspaceId
                  : writtenMatches
                    ? written.workspaceId
                    : undefined;
              const signedIn: ClaudeCredentialIdentity = {
                email: identity.email,
                ...(written.accountUuid && writtenMatches
                  ? { accountUuid: written.accountUuid }
                  : {}),
                ...(workspaceId ? { workspaceId } : {}),
              };
              const accounts =
                snapshot.groups.find((group) => group.driver === account.driver)?.accounts ?? [];
              const self = accounts.find((entry) => entry.id === account.accountId);
              const selfIdentity = identities.get(account.accountId) ?? {};
              // Re-login stays repairable: Default can't be removed, and an account signing in
              // as its own identity is never a new duplicate. The other copy gets `duplicateOf`.
              // A conflict flagged by an earlier sign-in (error with message) is not "own".
              const repairing =
                account.existing &&
                (self?.kind === "default" ||
                  (!(self?.status === "error" && self.message) &&
                    hasIdentity(selfIdentity) &&
                    sameAccountIdentity(selfIdentity, signedIn)));
              // Every account of the driver counts, Default and the active one included.
              const duplicate = repairing
                ? undefined
                : accounts.find(
                    (entry) =>
                      entry.id !== account.accountId &&
                      sameAccountIdentity(identities.get(entry.id) ?? {}, signedIn),
                  );
              // A new sign-in is discarded by the caller; nothing is persisted for it.
              if (duplicate && !account.existing) {
                yield* recordActivity({
                  driver: account.driver,
                  kind: "login.failed",
                  labels: { account: identity.email, to: duplicate.label },
                  outcome: "failed",
                });
                return {
                  message: `You're already signed in with ${identity.email} as ${duplicate.label}.`,
                };
              }
              const checkedAt = DateTime.formatIso(yield* DateTime.now);
              const message = duplicate
                ? `Signed in as ${identity.email}, which is already saved as ${duplicate.label}. Sign in again with the right account.`
                : null;
              yield* io(() =>
                registry.update(account.accountId, {
                  status: duplicate ? "error" : "ready",
                  message,
                  lastUsage: { ...identity, ...signedIn, checkedAt },
                }),
              );
              if (account.unnamed)
                yield* io(() => registry.rename(account.accountId, identity.email));
              const label = account.unnamed ? identity.email : (self?.label ?? identity.email);
              yield* recordActivity(
                duplicate
                  ? {
                      driver: account.driver,
                      kind: "login.failed",
                      accountId: ProviderAccountId.make(account.accountId),
                      labels: { account: label, to: duplicate.label },
                      reason: `${identity.email} is already saved as ${duplicate.label}`,
                      outcome: "failed",
                    }
                  : {
                      driver: account.driver,
                      kind: account.existing ? "login.reauthenticated" : "login.added",
                      accountId: ProviderAccountId.make(account.accountId),
                      labels: { account: label },
                      ...(label === identity.email ? {} : { reason: identity.email }),
                      outcome: "ok",
                    },
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
          yield* interruptibleIo(() => promise).pipe(
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
      if (entry.driver === "claudeAgent") {
        yield* requireClaudeReady();
        yield* reconcileClaudeUnlocked();
      }
      const state = yield* groupState(entry.driver);
      if (entry.driver === "claudeAgent" && state.warning)
        return yield* new ProviderAccountError({ message: state.warning });
      if (state.activeAccountId === entry.id) return yield* list();
      // In-flight probes and window starts of either account finish first; new ones wait.
      return yield* holds.exclusive([state.activeAccountId, entry.id])(
        switchHeld(input, entry, state),
      );
    });
    const switchHeld = Effect.fn("providerAccounts.switchHeld")(function* (
      input: ProviderAccountsSwitchInput,
      entry: ProviderAccountEntry,
      state: Effect.Success<ReturnType<typeof groupState>>,
    ) {
      const registry = yield* registryEffect;
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
        // Live plan and limits are the source's only while the active home holds its identity.
        const live = yield* liveClaudeIdentity(state);
        const sourceIdentity = storedIdentity(source);
        if (
          current &&
          current.status !== "pending" &&
          (!hasIdentity(sourceIdentity) ||
            !hasIdentity(live) ||
            sameAccountIdentity(sourceIdentity, live))
        ) {
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
              // No identity is a terminal logout, never a new account.
              if (!hasIdentity(identity))
                throw new ClaudeCredentialSwitchError(
                  "Claude active account changed outside the application.",
                );
              // A terminal login as an account we already know reuses its keeper's store:
              // the live token supersedes whatever stale copy it holds.
              const known = keeperOf(state.accounts, identity, source.id);
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
      const before = yield* registryEffect.pipe(
        Effect.flatMap((registry) => io(() => registry.get(input.accountId))),
      );
      const previousState = yield* groupState(before.driver);
      const wasActive = previousState.activeAccountId === before.id;
      const previous = previousState.accounts.find(
        (entry) => entry.id === previousState.activeAccountId,
      );
      const switchRecord = {
        driver: before.driver,
        toAccountId: ProviderAccountId.make(before.id),
        ...(previous ? { fromAccountId: ProviderAccountId.make(previous.id) } : {}),
        labels: { to: before.label, ...(previous ? { from: previous.label } : {}) },
      };
      const snapshot = yield* switchAccountUnlocked(input).pipe(
        Effect.tapError((error) =>
          error._tag === "ProviderAccountError"
            ? recordActivity({
                ...switchRecord,
                kind: "switch.failed",
                reason: error.message,
                outcome: "failed",
              })
            : Effect.void,
        ),
      );
      const group = snapshot.groups.find((entry) => entry.activeAccountId === input.accountId)!;
      // A manual switch is just a switch: the next evaluation uses the new account's numbers.
      // Its time only delays proactive rebalancing, so auto-switch can't revert it right away.
      if (!wasActive) {
        const registry = yield* registryEffect;
        const at = DateTime.formatIso(yield* DateTime.now);
        yield* io(() => registry.updateAutoSwitch(group.driver, { lastManualSwitchAt: at }));
        yield* recordActivity({ ...switchRecord, kind: "switch.manual", outcome: "ok" });
      }
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
      const previous = yield* io(() => registry.get(input.accountId));
      const entry = yield* io(() => registry.rename(input.accountId, input.label));
      if (entry.label !== previous.label)
        yield* recordActivity({
          driver: entry.driver,
          kind: "account.renamed",
          accountId: input.accountId,
          labels: { from: previous.label, to: entry.label },
          outcome: "ok",
        });
      yield* changed(entry.driver);
      return yield* list();
    }, mutation.withPermit);

    const remove = Effect.fn("providerAccounts.remove")(function* (input: {
      accountId: ProviderAccountId;
    }) {
      const registry = yield* registryEffect;
      const entry = yield* io(() => registry.get(input.accountId));
      if (entry.driver === "claudeAgent") {
        yield* requireClaudeReady();
        yield* reconcileClaudeUnlocked();
      }
      const state = yield* groupState(entry.driver);
      const active = entry.id === state.activeAccountId;
      // An active Claude duplicate hands the selection to the account it duplicates. The active
      // home already holds that identity's token and the duplicate's store is checked out, so
      // no credential moves; the kept account's stale store copy is superseded on its next switch.
      const handOff =
        active && entry.driver === "claudeAgent" && !state.warning
          ? claudeGroupOf(yield* list())?.accounts.find((account) => account.id === entry.id)
              ?.duplicateOf
          : undefined;
      if (
        entry.kind === "default" ||
        (active && !handOff) ||
        login.isBusy(entry.id) ||
        (handOff && login.isBusy(handOff))
      )
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
        if (handOff) {
          yield* io(() => registry.setClaudeActiveAccount(handOff));
          // Same live credentials: keep the provider snapshot instead of masking it as stale.
          const observed = observedAccounts.get("claudeAgent");
          if (observed) observedAccounts.set("claudeAgent", { ...observed, id: handOff });
          checkoutGeneration.claudeAgent++;
          cache.forget(handOff);
        }
        yield* deleteManagedHome(account);
      }
      yield* io(() => registry.remove(input.accountId, state.currentHome));
      yield* recordActivity({
        driver: entry.driver,
        kind: "account.removed",
        accountId: input.accountId,
        labels: { account: entry.label },
        outcome: "ok",
      });
      cache.forget(input.accountId);
      if (autoSwitch) yield* autoSwitch.notify(entry.driver);
      yield* changed(entry.driver);
      return yield* list();
    }, mutation.withPermit);

    const setAutoSwitch = Effect.fn("providerAccounts.setAutoSwitch")(function* (
      input: ProviderAccountsSetAutoSwitchInput,
    ) {
      const registry = yield* registryEffect;
      const before = yield* io(() => registry.getAutoSwitch(input.driver));
      const after = yield* io(() =>
        registry.updateAutoSwitch(input.driver, {
          enabled: input.enabled,
          ...(input.thresholdPercent === undefined
            ? {}
            : { thresholdPercent: input.thresholdPercent }),
          ...(input.weeklyThresholdPercent === undefined
            ? {}
            : { weeklyThresholdPercent: input.weeklyThresholdPercent }),
        }),
      );
      if (
        before.enabled !== after.enabled ||
        before.thresholdPercent !== after.thresholdPercent ||
        before.weeklyThresholdPercent !== after.weeklyThresholdPercent
      )
        yield* recordActivity({
          driver: input.driver,
          kind: "autoSwitch.settingsChanged",
          labels: {},
          settings: {
            enabled: after.enabled,
            ...(before.enabled === after.enabled ? {} : { enabledChanged: true }),
            thresholdPercent: after.thresholdPercent,
            weeklyThresholdPercent: after.weeklyThresholdPercent,
          },
          outcome: "ok",
        });
      if (autoSwitch) {
        yield* autoSwitch.clear(input.driver);
        yield* autoSwitch.notify(input.driver);
      }
      yield* changed(input.driver);
      return yield* list();
    }, mutation.withPermit);

    const setWindowPrimer = Effect.fn("providerAccounts.setWindowPrimer")(function* (
      input: ProviderAccountsSetWindowPrimerInput,
    ) {
      const registry = yield* registryEffect;
      const before = yield* io(() => registry.getWindowPrimer());
      yield* io(() => registry.updateWindowPrimer({ enabled: input.enabled }));
      if (before.enabled !== input.enabled)
        yield* recordActivity({
          driver: input.driver,
          kind: "windowPrimer.settingsChanged",
          labels: {},
          settings: { enabled: input.enabled, enabledChanged: true },
          outcome: "ok",
        });
      if (windowPrimer) yield* windowPrimer.clear;
      // Also re-evaluates the primer, which arms or stops its timer.
      yield* changed(input.driver);
      return yield* list();
    }, mutation.withPermit);

    const setAutoSwitchExcluded = Effect.fn("providerAccounts.setAutoSwitchExcluded")(function* (
      input: ProviderAccountsSetAutoSwitchExcludedInput,
    ) {
      const registry = yield* registryEffect;
      const previous = yield* io(() => registry.get(input.accountId));
      if ((previous.autoSwitchExcluded === true) !== input.excluded) {
        const entry = yield* io(() =>
          registry.setAutoSwitchExcluded(input.accountId, input.excluded),
        );
        yield* recordActivity({
          driver: entry.driver,
          kind: input.excluded ? "account.excluded" : "account.included",
          accountId: input.accountId,
          labels: { account: entry.label },
          outcome: "ok",
        });
      }
      // The next target (and the "Best option") may have changed.
      if (autoSwitch) yield* autoSwitch.notify(previous.driver);
      yield* changed(previous.driver);
      return yield* list();
    }, mutation.withPermit);

    const readActivity = (input: ProviderAccountsActivityInput) =>
      Effect.tryPromise({ try: () => activity.read(input), catch: (cause) => cause }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not read the account activity log", {
            causeType: cause instanceof Error ? cause.name : typeof cause,
          }).pipe(
            Effect.andThen(
              Effect.fail(new ProviderAccountError({ message: "Couldn't read the activity log." })),
            ),
          ),
        ),
      );

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
          // Runs under the account mutation; never decide on an unreconciled terminal login.
          if (driver === "claudeAgent") yield* reconcileClaudeUnlocked();
          // list() without its idle reconcile, which the held mutation would skip anyway.
          const detailed = yield* listDetailed();
          const group = detailed.snapshot.groups.find((entry) => entry.driver === driver)!;
          const now = yield* Clock.currentTimeMillis;
          const probeBlocked = new Set<ProviderAccountId>();
          const probeWakeAt = new Map<ProviderAccountId, number>();
          for (const account of group.accounts) {
            if (account.active) continue;
            const entry = yield* io(() => registry.get(account.id));
            const previous = previousUsage(entry);
            // A recent successful measurement needs no probe; any other one is blocked when
            // the gate (floor, backoff, budget) would skip the policy's confirmation probe.
            const usage = account.usage;
            const confirmed =
              !previous?.lastFailureKind &&
              usage &&
              !usage.unavailable &&
              usage.windows.length > 0 &&
              usageConfirmed(usage, now);
            if (!confirmed && !cache.canProbe(account.id, now, previous, true)) {
              probeBlocked.add(account.id);
              probeWakeAt.set(account.id, cache.nextAllowedAt(account.id, now, previous, true));
            }
          }
          return {
            config: automatic,
            group,
            probeBlocked,
            probeWakeAt,
            activeUsageLive: detailed.activeUsageLive.get(driver) ?? false,
            loginInProgress: group.accounts
              .filter((account) => login.isBusy(account.id))
              .map((account) => account.id),
          };
        }),
      // The policy asks only for the accounts it needs confirmed, so the staleness TTL is
      // skipped; the floor, backoff, and shared budget still gate every probe.
      refresh: (accountIds) =>
        refreshUsageMeasured({ accountIds, force: true }, false).pipe(
          Effect.map(({ measured }) => accountIds.filter((id) => measured.has(id))),
        ),
      refreshActive: (driver) =>
        refreshInstanceLive(defaultInstanceIdForDriver(ProviderDriverKind.make(driver))),
      switchAccount: (accountId) => switchAccountUnlocked({ accountId, interruptRunning: false }),
      persistLastSwitch: (driver, lastSwitch) =>
        Effect.gen(function* () {
          const registry = yield* registryEffect;
          yield* io(() => registry.updateAutoSwitch(driver, { lastSwitch }));
        }),
      withMutation: mutation.withPermit,
      providerChanges: providers.streamChanges,
      idleChanges,
      publish: (event) =>
        PubSub.publish(autoEvents, event).pipe(
          Effect.andThen(event._tag === "switched" ? changed(event.driver) : Effect.void),
          Effect.asVoid,
        ),
      recordSwitch: (event) =>
        recordActivity({
          driver: event.driver,
          kind: event.outcome === "ok" ? "switch.auto" : "switch.failed",
          fromAccountId: event.from.id,
          toAccountId: event.to.id,
          labels: { from: event.from.label, to: event.to.label },
          trigger: event.trigger,
          ...(event.outcome === "ok"
            ? { reason: event.summary, message: event.reason }
            : { reason: event.error ?? "The switch failed.", message: event.summary }),
          outcome: event.outcome,
        }),
    });

    const primeFailureMessages: Record<ClaudeWindowPrimeFailure, string> = {
      signedOut: "Claude reported the account as signed out.",
      rateLimited: "Claude is rate limiting this account.",
      timeout: "Claude didn't answer within a minute.",
      failed: "Claude returned an error.",
    };
    const primeActivityReasons: Record<ClaudeWindowPrimeFailure, string> = {
      signedOut: "Signed out",
      rateLimited: "Rate-limited by Claude",
      timeout: "No answer within a minute",
      failed: "Claude returned an error",
    };
    // Credentials that would bill the request elsewhere instead of starting a subscription window.
    const apiBillingKeys = [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
    ];
    /**
     * Validates under the account mutation and takes the account's hold in the caller's scope,
     * so no credential move or checkout can interleave with the returned request.
     */
    const primeClaudeWindow = Effect.fn("providerAccounts.primeClaudeWindow")(function* (
      account: ProviderAccount,
    ) {
      yield* requireClaudeReady();
      yield* reconcileClaudeUnlocked();
      const state = yield* groupState("claudeAgent");
      if (state.warning) return yield* new ProviderAccountError({ message: state.warning });
      if (login.isBusy(account.id))
        return yield* new ProviderAccountError({ message: "A sign-in is running." });
      const registry = yield* registryEffect;
      const entry = yield* io(() => registry.get(account.id));
      const active = state.activeAccountId === entry.id;
      // Never a checked-out store: the active account is primed through the active home.
      const home = active
        ? state.currentHome
        : (entry.storePath ?? (entry.kind === "managed" ? entry.homePath : undefined));
      if (!home || (!active && NodePath.resolve(home) === NodePath.resolve(state.currentHome)))
        return yield* new ProviderAccountError({ message: "Its saved login wasn't found." });
      const launch = claudeWindowPrimeLaunch({
        active,
        homePath: home,
        configuredHomePath: state.settings.homePath,
        binaryPath: state.settings.binaryPath,
        environment: state.environment,
        stateDir: config.stateDir,
      });
      yield* io(() => NodeFSP.mkdir(launch.cwd, { recursive: true, mode: 0o700 }));
      yield* holds.sharedScoped(entry.id);
      return Effect.gen(function* () {
        const result = yield* Effect.promise((signal) => runPrime(launch, { signal }));
        if (!result.ok) {
          // Only the classified reason; prompts and CLI output are never logged.
          yield* Effect.logWarning("Claude window start failed", { reason: result.reason, active });
          yield* recordActivity({
            driver: "claudeAgent",
            kind: "window.failed",
            accountId: account.id,
            labels: { account: entry.label },
            reason: primeActivityReasons[result.reason],
            outcome: "failed",
          });
          return yield* new ProviderAccountError({ message: primeFailureMessages[result.reason] });
        }
        yield* Effect.logInfo("Started a Claude 5-hour window", { active });
        yield* recordActivity({
          driver: "claudeAgent",
          kind: "window.started",
          accountId: account.id,
          labels: { account: entry.label },
          outcome: "ok",
        });
      });
    });
    windowPrimer = yield* makeProviderAccountWindowPrimer({
      read: () =>
        Effect.gen(function* () {
          const registry = yield* registryEffect;
          const primer = yield* io(() => registry.getWindowPrimer());
          const group = claudeGroupOf(yield* list());
          const state = yield* groupState("claudeAgent");
          const now = yield* Clock.currentTimeMillis;
          const previous = new Map<ProviderAccountId, AccountUsage | undefined>();
          for (const account of group?.accounts ?? []) {
            if (account.active) continue;
            const entry = yield* io(() => registry.get(account.id));
            previous.set(account.id, previousUsage(entry));
          }
          const billing = apiBillingKeys.filter((key) => Boolean(state.environment[key]));
          const blocked =
            state.warning ??
            (billing.length > 0
              ? `Paused: ${billing.join(", ")} in Claude's environment would bill that instead of starting a subscription window.`
              : undefined);
          return {
            enabled: primer.enabled,
            group,
            primedAt: new Map(
              Object.entries(primer.primedAt ?? {}).map(([id, at]) => [
                ProviderAccountId.make(id),
                at,
              ]),
            ),
            loginInProgress: (group?.accounts ?? [])
              .filter((account) => login.isBusy(account.id))
              .map((account) => account.id),
            probeAllowedAt: (accountId: ProviderAccountId, force: boolean) =>
              previous.has(accountId)
                ? cache.nextAllowedAt(accountId, now, previous.get(accountId), force)
                : 0,
            ...(blocked ? { blocked } : {}),
          };
        }),
      refresh: (account, force) =>
        account.active
          ? refreshInstanceLive(claudeInstanceId)
          : refreshUsage({ accountIds: [account.id], force }),
      // A start that can't even be sent (signed in elsewhere, no saved login) is a failure too.
      prime: (account) =>
        primeClaudeWindow(account).pipe(
          Effect.tapError((error) =>
            recordActivity({
              driver: "claudeAgent",
              kind: "window.failed",
              accountId: account.id,
              labels: { account: account.label },
              reason: error.message,
              outcome: "failed",
            }),
          ),
        ),
      persistPrimed: (accountId, at) =>
        Effect.gen(function* () {
          const registry = yield* registryEffect;
          yield* io(() => registry.updateWindowPrimer({ primed: { accountId, at } }));
        }),
      withMutation: mutation.withPermit,
      providerChanges: providers.streamChanges,
      publish: PubSub.publish(autoEvents, { _tag: "changed", driver: "claudeAgent" }).pipe(
        Effect.asVoid,
      ),
    });

    // A terminal login shows up in the next Claude snapshot; file it without waiting for a list.
    let lastClaudeSnapshotKey: string | undefined;
    yield* providers.streamChanges.pipe(
      Stream.runForEach((all) => {
        const claude = all.find((item) => item.instanceId === claudeInstanceId);
        const key =
          claude && `${claude.checkedAt}:${claude.auth.status}:${claude.auth.email ?? ""}`;
        if (!key || key === lastClaudeSnapshotKey) return Effect.void;
        lastClaudeSnapshotKey = key;
        return mutation
          .withPermit(reconcileClaudeUnlocked())
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Reconciling the active Claude account failed", cause),
            ),
          );
      }),
      Effect.forkIn(scope),
    );

    return {
      list,
      refreshUsage,
      setAutoSwitch,
      setWindowPrimer,
      setAutoSwitchExcluded,
      activity: readActivity,
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
  static readonly layerWithLogin = (
    createLogin: CreateLogin,
    probe?: typeof probeAccountUsage,
    runPrime?: typeof runClaudeWindowPrime,
  ) => Layer.effect(ProviderAccountsService, make(createLogin, probe, runPrime));
}
