import {
  ClaudeCodexRoutingSettings,
  type ProviderInstanceId,
  type ServerConfig,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeRouting = Schema.decodeUnknownSync(ClaudeCodexRoutingSettings);

export function isClaudeCodexFastModeAvailable(
  serverConfig: ServerConfig | null,
  providerInstanceId: ProviderInstanceId,
): boolean {
  if (serverConfig?.environment.capabilities.claudeCodexFastMode !== true) {
    return false;
  }
  const provider = serverConfig.providers.find(
    (candidate) => candidate.instanceId === providerInstanceId,
  );
  if (provider?.driver !== "claudeAgent") {
    return false;
  }

  const settings = serverConfig.settings;
  const explicit = settings.providerInstances[providerInstanceId];
  // Match bridge routing settings: an explicit Claude instance owns its config;
  // only legacy instances fall back to the driver-wide routing settings.
  if (explicit?.driver === "claudeAgent") {
    const config = explicit.config;
    const routing =
      typeof config === "object" &&
      config !== null &&
      !Array.isArray(config) &&
      "codexRouting" in config
        ? config.codexRouting
        : undefined;
    try {
      return decodeRouting(routing ?? {}).enabled;
    } catch {
      return false;
    }
  }
  return settings.providers.claudeAgent.codexRouting?.enabled === true;
}
