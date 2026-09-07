import type { EnvironmentId, ProviderInstanceId, ServerConfig } from "@t3tools/contracts";

import { ComposerInlineControl } from "../../components/ComposerToolbar";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { isClaudeCodexFastModeAvailable } from "./ClaudeCodexFastModeControl.logic";

export function ClaudeCodexFastModeControl(props: {
  readonly environmentId: EnvironmentId;
  readonly serverConfig: ServerConfig | null;
  readonly providerInstanceId: ProviderInstanceId;
}) {
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "server settings update",
    reportFailure: true,
  });
  if (!isClaudeCodexFastModeAvailable(props.serverConfig, props.providerInstanceId)) {
    return null;
  }
  const enabled = props.serverConfig?.settings.claudeCodexFastModeEnabled === true;

  return (
    <ComposerInlineControl
      accessibilityLabel="GPT Fast for the Codex bridge"
      accessibilityHint="Applies to all GPT bridge requests on this server, including subagents."
      emphasized={enabled}
      selected={enabled}
      icon={{ ios: "bolt.fill", android: "bolt" }}
      label="GPT Fast"
      maxWidth={104}
      showChevron={false}
      onPress={() => {
        void updateSettings({
          environmentId: props.environmentId,
          input: { patch: { claudeCodexFastModeEnabled: !enabled } },
        });
      }}
    />
  );
}
