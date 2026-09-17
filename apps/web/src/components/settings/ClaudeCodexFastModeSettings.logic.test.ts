import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";

import { claudeCodexFastModeSettingsEnvironments } from "./ClaudeCodexFastModeSettings.logic";

function environment(id: string, capability: boolean | undefined) {
  return {
    environmentId: EnvironmentId.make(id),
    label: `Server ${id}`,
    serverConfig: {
      environment: {
        capabilities: capability === undefined ? {} : { claudeCodexFastMode: capability },
      },
    },
  };
}

describe("hosted GPT Fast setting targets", () => {
  it("keeps each capable remote's identity and label when there is no primary", () => {
    const first = environment("first", true);
    const second = environment("second", true);
    // No routing capability or selected Claude instance is required to configure a server.
    expect(claudeCodexFastModeSettingsEnvironments([first, second], null)).toEqual([first, second]);
  });

  it("excludes older, unsupported and not-yet-loaded environments", () => {
    const capable = environment("capable", true);
    expect(
      claudeCodexFastModeSettingsEnvironments(
        [
          environment("old", undefined),
          environment("unsupported", false),
          { ...environment("loading", true), serverConfig: null },
          capable,
        ],
        null,
      ),
    ).toEqual([capable]);
  });

  it("leaves primary-anchored clients on their existing setting, even with capable remotes", () => {
    const primary = environment("primary", false);
    const remote = environment("remote", true);
    expect(
      claudeCodexFastModeSettingsEnvironments([primary, remote], primary.environmentId),
    ).toEqual([]);
  });

  it("does not invent a target when no environments are available", () => {
    expect(claudeCodexFastModeSettingsEnvironments([], null)).toEqual([]);
  });
});
