import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_CLAUDE_CODEX_ROUTING_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";

import {
  isClaudeCodexFastModeAvailable,
  type ClaudeCodexFastModeProvider,
} from "./ClaudeCodexFastModeControl.logic";

const claude: ClaudeCodexFastModeProvider = {
  driverKind: ProviderDriverKind.make("claudeAgent"),
  instanceId: ProviderInstanceId.make("claudeAgent"),
};
const routedSettings: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  providers: {
    ...DEFAULT_SERVER_SETTINGS.providers,
    claudeAgent: {
      ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
      codexRouting: {
        ...DEFAULT_CLAUDE_CODEX_ROUTING_SETTINGS,
        enabled: true,
      },
    },
  },
};

describe("GPT Fast availability", () => {
  it("offers the control for routed Claude without requiring a GPT main model", () => {
    expect(isClaudeCodexFastModeAvailable(true, routedSettings, claude)).toBe(true);
  });

  it.each([false, undefined])("hides it without the server capability (%s)", (capability) => {
    expect(isClaudeCodexFastModeAvailable(capability, routedSettings, claude)).toBe(false);
  });

  it("hides it when Claude routing is disabled", () => {
    expect(isClaudeCodexFastModeAvailable(true, DEFAULT_SERVER_SETTINGS, claude)).toBe(false);
  });

  it.each(["codex", "cursor", "grok", "opencode", "antigravity"])(
    "does not expose the bridge setting for %s threads",
    (driver) => {
      expect(
        isClaudeCodexFastModeAvailable(true, routedSettings, {
          driverKind: ProviderDriverKind.make(driver),
          instanceId: ProviderInstanceId.make(driver),
        }),
      ).toBe(false);
    },
  );

  it.each([null, undefined])("hides it without a selected instance (%s)", (provider) => {
    expect(isClaudeCodexFastModeAvailable(true, routedSettings, provider)).toBe(false);
  });

  it("uses the selected custom Claude instance instead of the default instance's routing", () => {
    const custom = { ...claude, instanceId: ProviderInstanceId.make("claude_work") };
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [custom.instanceId]: {
          driver: claude.driverKind,
          displayName: "Claude Work",
          config: { codexRouting: { enabled: true } },
        },
      },
    };
    expect(isClaudeCodexFastModeAvailable(true, settings, custom)).toBe(true);
    expect(isClaudeCodexFastModeAvailable(true, settings, claude)).toBe(false);
  });

  it("honors an explicit disabled or invalid routing config even if the default routes GPT", () => {
    const custom = { ...claude, instanceId: ProviderInstanceId.make("claude_work") };
    for (const codexRouting of [{ enabled: false }, { enabled: "invalid" }]) {
      const settings: ServerSettings = {
        ...routedSettings,
        providerInstances: {
          [custom.instanceId]: {
            driver: claude.driverKind,
            displayName: "Claude Work",
            config: { codexRouting },
          },
        },
      };
      expect(isClaudeCodexFastModeAvailable(true, settings, custom)).toBe(false);
      expect(isClaudeCodexFastModeAvailable(true, settings, claude)).toBe(true);
    }
  });
});
