/** Composer controls for server-wide GPT priority processing (fork: f5 GPT fast). */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { ZapIcon } from "lucide-react";
import { useCallback } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { MenuCheckboxItem } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  CLAUDE_CODEX_FAST_MODE_DESCRIPTION,
  isClaudeCodexFastModeAvailable,
  type ClaudeCodexFastModeProvider,
} from "./ClaudeCodexFastModeControl.logic";
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from "./ComposerControl";
import { composerFloatingLayerProps } from "./composerEventScope";

export function useClaudeCodexFastMode(
  environmentId: EnvironmentId,
  provider?: ClaudeCodexFastModeProvider | null,
) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const capability = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
    (config) => config?.environment.capabilities.claudeCodexFastMode === true,
  );
  const available = isClaudeCodexFastModeAvailable(capability, settings, provider);
  const setEnabled = useCallback(
    (next: boolean) => {
      if (available) updateSettings({ claudeCodexFastModeEnabled: next });
    },
    [available, updateSettings],
  );
  return { available, enabled: settings.claudeCodexFastModeEnabled === true, setEnabled };
}

type ClaudeCodexFastModeState = ReturnType<typeof useClaudeCodexFastMode>;

export function ClaudeCodexFastModeControl({
  available,
  enabled,
  setEnabled,
  size = "sm",
  hidden = false,
}: ClaudeCodexFastModeState & { size?: ComposerControlSize; hidden?: boolean }) {
  if (!available) return null;
  return (
    <Tooltip disabled={hidden}>
      <TooltipTrigger
        render={
          <ComposerControl
            type="button"
            size={size}
            aria-pressed={enabled}
            className="shrink-0 aria-pressed:bg-accent aria-pressed:text-foreground"
            onClick={() => setEnabled(!enabled)}
          />
        }
      >
        <ComposerControlIcon icon={ZapIcon} size={size} />
        GPT Fast
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-80" {...composerFloatingLayerProps}>
        {CLAUDE_CODEX_FAST_MODE_DESCRIPTION}
      </TooltipPopup>
    </Tooltip>
  );
}

export function ClaudeCodexFastModeMenuItem({
  available,
  enabled,
  setEnabled,
}: ClaudeCodexFastModeState) {
  if (!available) return null;
  return (
    <MenuCheckboxItem
      checked={enabled}
      onCheckedChange={setEnabled}
      aria-description={CLAUDE_CODEX_FAST_MODE_DESCRIPTION}
    >
      <span className="flex items-center gap-2">
        <ZapIcon aria-hidden="true" className="size-4" />
        GPT Fast
        <span className="text-xs text-muted-foreground">Server-wide</span>
      </span>
    </MenuCheckboxItem>
  );
}
