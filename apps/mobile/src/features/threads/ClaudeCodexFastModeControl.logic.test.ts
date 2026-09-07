import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_CLAUDE_CODEX_ROUTING_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerSettings,
} from "@t3tools/contracts";

import { isClaudeCodexFastModeAvailable } from "./ClaudeCodexFastModeControl.logic";

const instanceId = ProviderInstanceId.make("claude_work");
const legacySettings: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  providers: {
    ...DEFAULT_SERVER_SETTINGS.providers,
    claudeAgent: {
      ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
      codexRouting: { ...DEFAULT_CLAUDE_CODEX_ROUTING_SETTINGS, enabled: true },
    },
  },
};

function configFor(
  settings: ServerSettings = legacySettings,
  capability: boolean | null = true,
  driver = "claudeAgent",
): ServerConfig {
  return {
    environment: { capabilities: capability === null ? {} : { claudeCodexFastMode: capability } },
    providers: [{ instanceId, driver }],
    settings,
  } as unknown as ServerConfig;
}

function explicitSettings(config: unknown): ServerSettings {
  return {
    ...legacySettings,
    providerInstances: {
      [instanceId]: { driver: ProviderDriverKind.make("claudeAgent"), config },
    },
  };
}

describe("mobile GPT Fast availability", () => {
  it("requires a connected server and advertised capability", () => {
    expect(isClaudeCodexFastModeAvailable(null, instanceId)).toBe(false);
    expect(isClaudeCodexFastModeAvailable(configFor(legacySettings, false), instanceId)).toBe(
      false,
    );
    expect(isClaudeCodexFastModeAvailable(configFor(legacySettings, null), instanceId)).toBe(false);
  });

  it.each(["codex", "cursor", "grok", "opencode", "antigravity"])(
    "does not expose bridge Fast for the %s driver",
    (driver) => {
      expect(
        isClaudeCodexFastModeAvailable(configFor(legacySettings, true, driver), instanceId),
      ).toBe(false);
    },
  );

  it("requires the selected provider instance to exist", () => {
    expect(isClaudeCodexFastModeAvailable(configFor(), ProviderInstanceId.make("missing"))).toBe(
      false,
    );
  });

  it("uses legacy routing only without an explicit Claude config", () => {
    expect(isClaudeCodexFastModeAvailable(configFor(), instanceId)).toBe(true);
    expect(isClaudeCodexFastModeAvailable(configFor(DEFAULT_SERVER_SETTINGS), instanceId)).toBe(
      false,
    );
  });

  it("reads explicit instance routing instead of the legacy setting", () => {
    expect(
      isClaudeCodexFastModeAvailable(
        configFor(explicitSettings({ codexRouting: { enabled: true } })),
        instanceId,
      ),
    ).toBe(true);
    expect(
      isClaudeCodexFastModeAvailable(
        configFor(explicitSettings({ codexRouting: { enabled: false } })),
        instanceId,
      ),
    ).toBe(false);
  });

  it.each(
    [undefined, null, [], {}, { codexRouting: { enabled: "true" } }].map((config) => ({ config })),
  )("keeps missing or invalid explicit routing disabled (%j)", ({ config }) => {
    expect(isClaudeCodexFastModeAvailable(configFor(explicitSettings(config)), instanceId)).toBe(
      false,
    );
  });
});
