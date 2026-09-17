import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_CLAUDE_CODEX_ROUTING_SETTINGS } from "@t3tools/contracts";

import {
  claudeCodexRoutedModel,
  formatClaudeCodexModelName,
  withClaudeCodexRoutedModel,
} from "./ClaudeCodexModelCatalog.ts";

const model = (slug: string, isLegacy = false) => ({
  slug,
  name: slug,
  isCustom: false,
  ...(isLegacy ? { isLegacy: true } : {}),
  capabilities: null,
});

describe("Claude Codex routed model catalog", () => {
  it("is inert until routing is enabled", () => {
    const models = [model("claude-opus-5")];
    expect(withClaudeCodexRoutedModel(models, {})).toBe(models);
  });

  it("publishes the configured Codex model as a Claude route", () => {
    expect(
      claudeCodexRoutedModel({
        codexRouting: {
          ...DEFAULT_CLAUDE_CODEX_ROUTING_SETTINGS,
          enabled: true,
          model: "gpt-6-astra",
        },
      }),
    ).toMatchObject({
      slug: "gpt-6-astra",
      name: "GPT-6 Astra",
      shortName: "GPT-6 Astra",
      subProvider: "via Codex",
      isCustom: false,
    });
  });

  it("places the route before legacy models and replaces slug collisions", () => {
    const models = [
      model("claude-opus-5"),
      { ...model("gpt-5.4-mini"), subProvider: "via Codex" },
      model("gpt-6-astra"),
      model("claude-opus-4-6", true),
    ];
    const routed = withClaudeCodexRoutedModel(models, {
      codexRouting: {
        ...DEFAULT_CLAUDE_CODEX_ROUTING_SETTINGS,
        enabled: true,
        model: "gpt-6-astra",
      },
    });
    expect(routed.map((entry) => entry.slug)).toEqual([
      "claude-opus-5",
      "gpt-6-astra",
      "claude-opus-4-6",
    ]);
    expect(routed[1]?.subProvider).toBe("via Codex");
  });

  it("formats model ids without hiding their identity", () => {
    expect(formatClaudeCodexModelName("gpt-6-astra")).toBe("GPT-6 Astra");
    expect(formatClaudeCodexModelName("codex-mini-latest")).toBe("Codex Mini Latest");
  });
});
