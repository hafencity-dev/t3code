import {
  ClaudeSettings,
  CodexSettings,
  defaultInstanceIdForDriver,
  ProviderAccountBusyError,
  ProviderAccountError,
  ProviderDriverKind,
  type ProviderAccountDriver,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { Effect, Equal, PubSub, Schema } from "effect";

import type { ProviderSessionManagerV2Shape } from "../../orchestration-v2/ProviderSessionManager.ts";
import type { ProjectionStoreV2Shape } from "../../orchestration-v2/ProjectionStore.ts";
import type { ServerSettingsService } from "../../serverSettings.ts";
import type { ProviderInstanceRegistry } from "../ProviderInstanceRegistry.ts";

const decodeConfigRecord = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);

function effectiveConfig(settings: ServerSettings, driver: ProviderAccountDriver) {
  const explicit =
    settings.providerInstances[defaultInstanceIdForDriver(ProviderDriverKind.make(driver))];
  if (explicit !== undefined) {
    if (explicit.driver !== driver) {
      throw new ProviderAccountError({
        message: `The default ${driver} instance uses another driver.`,
      });
    }
    return explicit.config ?? {};
  }
  return {};
}

export function resolveProviderAccountConfig(
  settings: ServerSettings,
  driver: "codex",
): Effect.Effect<CodexSettings, ProviderAccountError>;
export function resolveProviderAccountConfig(
  settings: ServerSettings,
  driver: "claudeAgent",
): Effect.Effect<ClaudeSettings, ProviderAccountError>;
export function resolveProviderAccountConfig(
  settings: ServerSettings,
  driver: ProviderAccountDriver,
): Effect.Effect<CodexSettings | ClaudeSettings, ProviderAccountError>;
export function resolveProviderAccountConfig(
  settings: ServerSettings,
  driver: ProviderAccountDriver,
) {
  return Effect.try({
    try: () => {
      const config = effectiveConfig(settings, driver);
      return driver === "codex" ? decodeCodexSettings(config) : decodeClaudeSettings(config);
    },
    catch: (error) => new ProviderAccountError({ message: String(error) }),
  });
}

export interface ProviderAccountSwitchTarget {
  readonly driver: ProviderAccountDriver;
  /** Original setting value for Default, account directory for managed accounts. */
  readonly homePath: string;
  readonly directMode?: boolean;
}

/** Keep the shared Codex home (and therefore continuation identity) unchanged. */
export function makeProviderAccountSwitchPatch(
  settings: ServerSettings,
  target: ProviderAccountSwitchTarget,
): ServerSettingsPatch {
  const instanceId = defaultInstanceIdForDriver(ProviderDriverKind.make(target.driver));
  const explicit = settings.providerInstances[instanceId];
  const change =
    target.driver === "codex"
      ? { shadowHomePath: target.directMode ? "" : target.homePath }
      : { homePath: target.homePath };
  const config = decodeConfigRecord(effectiveConfig(settings, target.driver));
  return {
    providerInstances: {
      ...settings.providerInstances,
      [instanceId]: {
        ...(explicit ?? { driver: ProviderDriverKind.make(target.driver) }),
        config: { ...config, ...change },
      },
    },
  };
}

export function makeProviderAccountSwitch(dependencies: {
  readonly settings: Pick<ServerSettingsService["Service"], "getSettings" | "updateSettings">;
  readonly sessions: Pick<ProviderSessionManagerV2Shape, "closeInstance">;
  readonly snapshots: Pick<ProjectionStoreV2Shape, "getShellSnapshot">;
  readonly instances: Pick<ProviderInstanceRegistry["Service"], "getInstance" | "subscribeChanges">;
}) {
  const switchAccount = Effect.fn("ProviderAccountSwitch.switchAccount")(function* (
    target: ProviderAccountSwitchTarget & { readonly interruptRunning?: boolean },
  ) {
    if (target.driver === "claudeAgent") {
      return yield* new ProviderAccountError({
        message: "Claude accounts must use hot switching.",
      });
    }
    const instanceId = defaultInstanceIdForDriver(ProviderDriverKind.make(target.driver));
    const readRunning = dependencies.snapshots.getShellSnapshot().pipe(
      Effect.mapError((error) => new ProviderAccountError({ message: error.message })),
      Effect.map((snapshot) =>
        snapshot.threads.filter(
          (thread) =>
            thread.providerInstanceId === instanceId &&
            (thread.activeRunId !== null ||
              thread.status === "preparing" ||
              thread.status === "running" ||
              thread.status === "waiting" ||
              (thread.pendingBackgroundTasks?.length ?? 0) > 0),
        ),
      ),
    );
    const running = yield* readRunning;
    if (running.length > 0 && !target.interruptRunning) {
      return yield* new ProviderAccountBusyError({ runningTurnCount: running.length });
    }

    if (target.interruptRunning) {
      // Use V2's explicit logout/shutdown path and wait for its release records.
      // A session-detached event alone is only a request, not a shutdown receipt.
      yield* dependencies.sessions.closeInstance(instanceId).pipe(
        Effect.timeout(20_000),
        Effect.catchTag("TimeoutError", () =>
          Effect.fail(
            new ProviderAccountError({ message: "Timed out stopping provider sessions." }),
          ),
        ),
        Effect.mapError((error) => new ProviderAccountError({ message: error.message })),
      );
    }

    // The record is replaced, not merged, so read it again after all stop completions.
    const settings = yield* dependencies.settings.getSettings.pipe(
      Effect.mapError((error) => new ProviderAccountError({ message: error.message })),
    );
    const patch = yield* Effect.try({
      try: () => makeProviderAccountSwitchPatch(settings, target),
      catch: (error) => new ProviderAccountError({ message: String(error) }),
    });
    if (!target.interruptRunning) {
      // Account mutations are serialized, but turn starts are not. Recheck at the
      // patch boundary; a turn starting between this read and the write remains
      // an accepted v1 race. Automatic switches never interrupt that turn.
      const stillRunning = yield* readRunning;
      if (stillRunning.length > 0)
        return yield* new ProviderAccountBusyError({ runningTurnCount: stillRunning.length });
    }
    yield* Effect.scoped(
      Effect.gen(function* () {
        // Subscribe before patching: hydration can rebuild before updateSettings returns.
        const changes = yield* dependencies.instances.subscribeChanges;
        const before = yield* dependencies.instances.getInstance(instanceId);
        const updated = yield* dependencies.settings
          .updateSettings(patch)
          .pipe(Effect.mapError((error) => new ProviderAccountError({ message: error.message })));
        if (
          Equal.equals(
            effectiveConfig(settings, target.driver),
            effectiveConfig(updated, target.driver),
          )
        ) {
          return;
        }
        // The registry retains instance identity until rebuild. It exposes no config
        // receipt; an unrelated already-in-flight settings rebuild can satisfy this.
        yield* Effect.gen(function* () {
          while (true) {
            const current = yield* dependencies.instances.getInstance(instanceId);
            if (current !== undefined && current !== before) return;
            yield* PubSub.take(changes);
          }
        }).pipe(
          Effect.timeout(20_000),
          Effect.catchTag("TimeoutError", () =>
            Effect.fail(
              new ProviderAccountError({
                message: `Timed out rebuilding the ${target.driver} provider instance after switching accounts.`,
              }),
            ),
          ),
        );
      }),
    );
  });
  return { switchAccount };
}
