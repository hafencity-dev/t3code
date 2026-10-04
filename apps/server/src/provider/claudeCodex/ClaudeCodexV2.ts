// fork: keep the Claude-to-Codex model transport at the V2 adapter boundary.
import type { ClaudeSettings, ModelSelection } from "@t3tools/contracts";
import { effectiveClaudeCodexModel } from "@t3tools/shared/claudeCodexRouting";
import { compileClaudeModelSelection } from "../../claudeModelOptions.ts";
import { claudeCodexTransportModel } from "./ClaudeCodexEffort.ts";

export function compileClaudeCodexSelection(selection: ModelSelection, settings?: ClaudeSettings) {
  const effectiveSelection = settings?.codexRouting?.enabled
    ? { ...selection, model: effectiveClaudeCodexModel(selection.model) }
    : selection;
  const compiled = compileClaudeModelSelection(effectiveSelection);
  if (!settings?.codexRouting?.enabled) return compiled;
  const apiModelId = claudeCodexTransportModel(compiled.apiModelId, effectiveSelection);
  return {
    ...compiled,
    apiModelId,
    queryIdentity: JSON.stringify({ selection: compiled.queryIdentity, apiModelId }),
  };
}
