/** Hosted-web GPT Fast targets (fork: f5 GPT fast). */
import type { EnvironmentId } from "@t3tools/contracts";

type FastModeEnvironment = {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly serverConfig: {
    readonly environment: {
      readonly capabilities: { readonly claudeCodexFastMode?: boolean };
    };
  } | null;
};

export function claudeCodexFastModeSettingsEnvironments<T extends FastModeEnvironment>(
  environments: ReadonlyArray<T>,
  primaryEnvironmentId: EnvironmentId | null,
): ReadonlyArray<T> {
  // Primary-anchored clients keep the existing primary setting, not a second set of controls.
  if (primaryEnvironmentId !== null) return [];
  return environments.filter(
    (environment) =>
      environment.serverConfig?.environment.capabilities.claudeCodexFastMode === true,
  );
}
