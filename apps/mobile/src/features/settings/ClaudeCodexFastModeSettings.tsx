import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

export function ClaudeCodexFastModeSettingsRows() {
  const { environments } = useEnvironments();
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "server settings update",
    reportFailure: true,
  });
  const targets = environments.filter(
    (environment) =>
      environment.serverConfig?.environment.capabilities.claudeCodexFastMode === true,
  );

  if (targets.length === 0) {
    return null;
  }

  return (
    <>
      {targets.map((environment) => (
        <SettingsSwitchRow
          key={environment.environmentId}
          icon={{ ios: "bolt.fill", android: "bolt" }}
          label="GPT Fast"
          subtitle={
            (targets.length > 1 ? `${environment.label} · ` : "") +
            "All GPT bridge requests on this server, including subagents."
          }
          value={environment.serverConfig?.settings?.claudeCodexFastModeEnabled === true}
          onValueChange={(value) => {
            void updateSettings({
              environmentId: environment.environmentId,
              input: { patch: { claudeCodexFastModeEnabled: value } },
            });
          }}
        />
      ))}
    </>
  );
}
