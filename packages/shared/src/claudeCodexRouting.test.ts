import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_CLAUDE_CODEX_MODEL_PREFERENCES,
  DEFAULT_CLAUDE_CODEX_ROUTING_SETTINGS,
} from "@t3tools/contracts";

import {
  buildClaudeCodexModelPreferencesPrompt,
  buildManagedClaudeCodexRoutingPrompt,
  effectiveClaudeCodexModel,
  resolveClaudeCodexRoutingPrompt,
} from "./claudeCodexRouting.ts";

describe("native task preference prompt", () => {
  it("discovers available native targets before requesting the configured model", () => {
    const prompt = buildManagedClaudeCodexRoutingPrompt("gpt-6-astra");
    expect(prompt).toContain("orchestrator_capabilities");
    expect(prompt).toContain('driverKind: "codex"');
    expect(prompt).toContain("canRunChildTask: true");
    expect(prompt).toContain("delegate_task.target");
    expect(prompt).toContain("only when that instance advertises its exact ID");
    expect(prompt).toContain("never invent an instance ID or model");
    expect(prompt).toContain("report that limitation");
    expect(prompt).toContain('mode: "async"');
    expect(prompt).toContain("completion notifies the parent automatically");
    expect(prompt).toContain("Haiku alias always means Claude Haiku");
    expect(prompt).not.toContain('Agent(model: "haiku")');
    expect(prompt).toContain("Exploration and research → Codex subagent");
    expect(prompt).toContain("Planning and architecture → Claude subagent");
  });

  it("preserves existing default-model upgrades and explicit custom model choices", () => {
    expect(effectiveClaudeCodexModel("  ")).toBe("gpt-6-astra");
    expect(effectiveClaudeCodexModel(" gpt-5.6-sol ")).toBe("gpt-6-astra");
    expect(effectiveClaudeCodexModel(" gpt-custom ")).toBe("gpt-custom");
  });

  it("honors each task route, its Claude model and the second-opinion scope", () => {
    const prompt = buildClaudeCodexModelPreferencesPrompt("gpt-6-astra", {
      ...DEFAULT_CLAUDE_CODEX_MODEL_PREFERENCES,
      claudeSubagentModel: "fable",
      claudeSubagentModels: { exploration: "sonnet", implementation: "opus", review: "sonnet" },
      exploration: "claude",
      implementation: "adaptive",
      secondOpinion: "reviews",
    });
    expect(prompt).toContain("Exploration and research → Claude subagent");
    expect(prompt).toContain('Agent(model: "sonnet")');
    expect(prompt).toContain("Implementation and refactors → best-fit subagent");
    expect(prompt).toContain('use `Agent(model: "opus")` for interactive');
    expect(prompt).toContain("consequential reviews of real changes");
    expect(prompt).not.toContain("consequential plans and architecture decisions");
    expect(prompt).toContain("native Codex subagent through `delegate_task`");
    expect(prompt).toContain("run both blind opinions in parallel");
  });

  it("uses the matching category model for plan and review second opinions", () => {
    const prompt = buildClaudeCodexModelPreferencesPrompt("gpt-6-astra", {
      ...DEFAULT_CLAUDE_CODEX_MODEL_PREFERENCES,
      claudeSubagentModels: { planning: "opus", review: "sonnet" },
    });
    expect(prompt).toContain(
      'plans and architecture decisions, run the Claude opinion through `Agent(model: "opus")`',
    );
    expect(prompt).toContain('reviews of real changes, use `Agent(model: "sonnet")`');
  });

  it("retains custom instructions after accurate native delegation guidance", () => {
    const prompt = resolveClaudeCodexRoutingPrompt({
      ...DEFAULT_CLAUDE_CODEX_ROUTING_SETTINGS,
      enabled: true,
      promptMode: "custom",
      customPrompt: "Custom routing.",
      additionalInstructions: "Team conventions.",
    });
    expect(prompt).toContain("Custom routing.\n\nTeam conventions.");
    expect(prompt?.indexOf("orchestrator_capabilities")).toBeLessThan(
      prompt?.indexOf("Custom routing.") ?? -1,
    );
    expect(prompt).not.toContain("Model preferences");
  });

  it("omits managed task preferences when disabled independently of extra instructions", () => {
    const prompt = resolveClaudeCodexRoutingPrompt({
      ...DEFAULT_CLAUDE_CODEX_ROUTING_SETTINGS,
      enabled: true,
      promptMode: "none",
      additionalInstructions: "Team conventions.",
    });
    expect(prompt).toContain("Native task delegation");
    expect(prompt).toContain("Team conventions.");
    expect(prompt).not.toContain("Model preferences");
  });

  it("sends no preference prompt when the feature is disabled or absent", () => {
    expect(resolveClaudeCodexRoutingPrompt(DEFAULT_CLAUDE_CODEX_ROUTING_SETTINGS)).toBeUndefined();
    expect(resolveClaudeCodexRoutingPrompt(undefined)).toBeUndefined();
  });
});
