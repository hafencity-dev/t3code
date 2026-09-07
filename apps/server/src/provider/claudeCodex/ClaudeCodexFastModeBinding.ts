/** Keep reused bridge routers in sync with global settings (fork feature f5). */
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { Effect, Layer, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { type ClaudeCodexBridge, getClaudeCodexBridge } from "./ClaudeCodexBridge.ts";

export const bindClaudeCodexFastMode = Effect.fn("bindClaudeCodexFastMode")(function* (
  bridge: Pick<ClaudeCodexBridge, "setFastModeEnabled">,
  serverSettings: Pick<ServerSettingsService["Service"], "subscribeChanges" | "getSettings">,
) {
  // Subscribe first so updates during the snapshot read are buffered, not lost.
  const changes = yield* serverSettings.subscribeChanges;
  const settings = yield* serverSettings.getSettings;
  bridge.setFastModeEnabled(settings.claudeCodexFastModeEnabled);
  yield* changes.pipe(
    // Notifications can contain snapshots older than the initial read. Always
    // reload current settings so buffered events cannot temporarily revert it.
    Stream.runForEach(() =>
      serverSettings.getSettings.pipe(
        Effect.tap((current) =>
          Effect.sync(() => bridge.setFastModeEnabled(current.claudeCodexFastModeEnabled)),
        ),
        Effect.catch((cause) => Effect.logWarning("failed to refresh GPT fast mode", { cause })),
      ),
    ),
    Effect.forkScoped,
  );
});

/** A server-lifetime prerequisite of ServerRuntimeStartup, never a client or adapter layer. */
export const ClaudeCodexFastModeLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const serverSettings = yield* ServerSettingsService;
    const platform = yield* HostProcessPlatform;
    const architecture = yield* HostProcessArchitecture;
    // start is idempotent; attach the watcher before reading persisted settings.
    yield* serverSettings.start;
    yield* bindClaudeCodexFastMode(
      getClaudeCodexBridge(config.stateDir, platform, architecture),
      serverSettings,
    );
  }),
);
