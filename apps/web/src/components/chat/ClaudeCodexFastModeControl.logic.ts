/** Server-wide Claude Code → Codex priority control (fork: f5 GPT fast). */
import type { ServerSettings } from "@t3tools/contracts";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { readClaudeCodexRouting } from "../settings/ModelRoutingSettings.logic";

export const CLAUDE_CODEX_FAST_MODE_DESCRIPTION =
  "Priority processing for all GPT requests through this server's Claude Code bridge, including main agents and subagents. Subject to provider availability. Does not affect Claude fast mode or native Codex threads.";

export type ClaudeCodexFastModeProvider = Pick<ProviderInstanceEntry, "driverKind" | "instanceId">;

export function isClaudeCodexFastModeAvailable(
  capability: boolean | undefined,
  settings: Pick<ServerSettings, "providers" | "providerInstances">,
  provider: ClaudeCodexFastModeProvider | null | undefined,
): boolean {
  // A Claude main model can route GPT subagents; its model slug is irrelevant.
  return (
    capability === true &&
    provider?.driverKind === "claudeAgent" &&
    readClaudeCodexRouting(settings, provider.instanceId).enabled
  );
}
