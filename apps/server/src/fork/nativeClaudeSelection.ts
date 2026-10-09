import {
  DEFAULT_MODEL_BY_PROVIDER,
  ProviderDriverKind,
  type ClaudeSettings,
  type ModelSelection,
} from "@t3tools/contracts";
import { effectiveClaudeCodexModel } from "@t3tools/shared/claudeCodexRouting";

/** Retired bridge threads retain GPT selections; ordinary custom endpoints remain untouched. */
export function nativeClaudeSelection(selection: ModelSelection, settings: ClaudeSettings) {
  const routing = settings.codexRouting;
  if (
    !routing?.enabled ||
    !/^gpt-/i.test(selection.model) ||
    (selection.model !== routing.model &&
      selection.model !== effectiveClaudeCodexModel(routing.model))
  ) {
    return { selection, notice: undefined };
  }
  const model = DEFAULT_MODEL_BY_PROVIDER[ProviderDriverKind.make("claudeAgent")]!;
  return {
    selection: { instanceId: selection.instanceId, model },
    notice: `The Claude→Codex bridge was removed. This turn uses ${model} instead of ${selection.model}. Select the Codex provider to use GPT directly.`,
  };
}
