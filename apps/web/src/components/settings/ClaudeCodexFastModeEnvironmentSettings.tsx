/** Explicit environment-scoped GPT Fast rows for hosted web (fork: f5 GPT fast). */
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import {
  useEnvironments,
  usePrimaryEnvironmentId,
  type EnvironmentPresentation,
} from "../../state/environments";
import { CLAUDE_CODEX_FAST_MODE_DESCRIPTION } from "../chat/ClaudeCodexFastModeControl.logic";
import { Switch } from "../ui/switch";
import { claudeCodexFastModeSettingsEnvironments } from "./ClaudeCodexFastModeSettings.logic";
import { SettingsRow, SettingsSearchTarget } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function EnvironmentFastModeRow({ environment }: { environment: EnvironmentPresentation }) {
  const enabled = useEnvironmentSettings(
    environment.environmentId,
    (settings) => settings.claudeCodexFastModeEnabled,
  );
  const updateSettings = useUpdateEnvironmentSettings(environment.environmentId);
  const connected = environment.connection.phase === "connected";
  const label = `GPT Fast · ${environment.label}`;
  return (
    <SettingsRow
      title={label}
      description={CLAUDE_CODEX_FAST_MODE_DESCRIPTION}
      status={!connected ? `Reconnect to ${environment.label} to change GPT Fast.` : undefined}
      control={
        <Switch
          checked={enabled === true}
          disabled={!connected}
          aria-label={label}
          onCheckedChange={(next) => updateSettings({ claudeCodexFastModeEnabled: next })}
        />
      }
    />
  );
}

export function ClaudeCodexFastModeEnvironmentSettings() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const targets = claudeCodexFastModeSettingsEnvironments(environments, primaryEnvironmentId);
  if (targets.length === 0) return null;
  return (
    <SettingsSearchTarget {...searchableSetting("model-routing-gpt-fast")}>
      {targets.map((environment) => (
        <EnvironmentFastModeRow key={environment.environmentId} environment={environment} />
      ))}
    </SettingsSearchTarget>
  );
}
