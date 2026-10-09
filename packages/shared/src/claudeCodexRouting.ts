/**
 * Native V2 task and model preference prompt (fork feature f5).
 *
 * This is shared by the server and settings preview. Keeping one renderer is
 * what makes the UI preview byte-identical to the text attached to a session.
 */
import {
  DEFAULT_CLAUDE_CODEX_MODEL_PREFERENCES,
  type ClaudeCodexModelPreferences,
  type ClaudeCodexRoutingSettings,
  type ClaudeCodexSecondOpinionMode,
  type ClaudeCodexTaskRoute,
} from "@t3tools/contracts";

/** Joins non-empty trimmed prompt segments with blank lines. */
function composeSystemPromptText(segments: ReadonlyArray<string | undefined>): string | undefined {
  const parts: Array<string> = [];
  for (const segment of segments) {
    const trimmed = segment?.trim() ?? "";
    if (trimmed.length > 0) {
      parts.push(trimmed);
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export const DEFAULT_CLAUDE_CODEX_MODEL = "gpt-6-astra";

export function effectiveClaudeCodexModel(model: string | undefined): string {
  const selected = model?.trim();
  // fork: upgrade the former managed Sol route, including saved configurations.
  return !selected || selected === "gpt-5.6-sol" ? DEFAULT_CLAUDE_CODEX_MODEL : selected;
}

function nativeDelegationInstructions(model: string): string {
  return `# Native task delegation (configured in 2code)

The main session stays on its selected Claude model. Before delegating, call \`orchestrator_capabilities\` to discover enabled provider instances and their advertised models and constraints.
- For Codex work, choose an available provider with \`driverKind: "codex"\` and \`canRunChildTask: true\`. Prefer model \`${effectiveClaudeCodexModel(model)}\` only when that instance advertises its exact ID. Pass the returned \`providerInstanceId\` and model ID in \`delegate_task.target\`; never invent an instance ID or model.
- For Claude work, prefer the provider's native subagent tool only when it supports the selected Claude model. Otherwise use \`delegate_task\` with an advertised Claude instance and model.
- Codex is a native provider, not a remapped Claude model alias. Claude's Haiku alias always means Claude Haiku; never use it to request Codex. Older bridge or alias-remapping instructions do not apply.
- If the configured provider or model is unavailable, report that limitation and use an available suitable model only when the task allows a fallback. Never claim the configured model ran when it did not.
- Give each child a self-contained prompt. Prefer \`mode: "async"\` for long work; completion notifies the parent automatically. Do not create polling watchers. Use \`task_status\` only when a result is needed during the current turn. Retain task IDs and stable retry IDs as documented by the tools.`;
}

type TaskPreferenceKey = Exclude<
  keyof ClaudeCodexModelPreferences,
  "claudeSubagentModel" | "claudeSubagentModels" | "secondOpinion"
>;

const TASK_PREFERENCES: ReadonlyArray<{
  readonly key: TaskPreferenceKey;
  readonly label: string;
  readonly scope: string;
}> = [
  {
    key: "exploration",
    label: "Exploration and research",
    scope: "codebase mapping, evidence gathering, and independent investigation",
  },
  {
    key: "implementation",
    label: "Implementation and refactors",
    scope: "clear-spec code changes, refactors, migrations, and mechanical edits",
  },
  {
    key: "verification",
    label: "Tests and verification",
    scope: "running checks, reproducing defects, and verifying concrete claims",
  },
  {
    key: "planning",
    label: "Planning and architecture",
    scope: "plans, architecture decisions, tradeoffs, and ambiguous technical direction",
  },
  {
    key: "design",
    label: "UI, UX, and product design",
    scope: "interaction design, visual decisions, user-facing copy, and product judgment",
  },
  {
    key: "review",
    label: "Review and final analysis",
    scope: "code review, risk assessment, synthesis, and final conclusions",
  },
];

function claudeModelForTask(
  preferences: ClaudeCodexModelPreferences,
  task: TaskPreferenceKey,
): ClaudeCodexModelPreferences["claudeSubagentModel"] {
  return preferences.claudeSubagentModels[task] ?? preferences.claudeSubagentModel;
}

function taskPreferenceInstruction(
  label: string,
  scope: string,
  route: ClaudeCodexTaskRoute,
  codexModel: string,
  claudeModel: ClaudeCodexModelPreferences["claudeSubagentModel"],
): string {
  if (route === "claude") {
    return `- ${label} → Claude subagent: Delegate ${scope} through \`Agent(model: "${claudeModel}")\` or a Workflow agent using \`model: "${claudeModel}"\` rather than doing the substantial work inline. The main session supplies context, evaluates the result, and owns the synthesis.`;
  }
  if (route === "codex") {
    return `- ${label} → Codex subagent: Delegate ${scope} through \`delegate_task\` to an available native Codex instance, preferring advertised model \`${codexModel}\`. The main session supplies context, evaluates the result, and owns the synthesis.`;
  }
  return `- ${label} → best-fit subagent: Use native Codex delegation through \`delegate_task\` for self-contained, parallelizable, or mechanical parts of ${scope}; use \`Agent(model: "${claudeModel}")\` for interactive, unknown-shape, or judgment-heavy parts. Do not default substantial work to the main loop.`;
}

function secondOpinionInstruction(
  mode: ClaudeCodexSecondOpinionMode,
  codexModel: string,
  preferences: ClaudeCodexModelPreferences,
): string {
  if (mode === "off") {
    return "Second opinions are off. Use the primary subagent route above for one substantive delegated pass, but do not create a competing plan or review solely for another opinion.";
  }
  const planningModel = claudeModelForTask(preferences, "planning");
  const reviewModel = claudeModelForTask(preferences, "review");
  const commonEnding = `Pair the Claude opinion with one native Codex subagent through \`delegate_task\`, preferring advertised model \`${codexModel}\`, and run both blind opinions in parallel. Do not show either agent the other's draft. The main session compares both views, adjudicates disagreements, and owns the final artifact. Routine or low-risk work does not need this extra pass.`;
  if (mode === "plans") {
    return `For consequential plans and architecture decisions, run the Claude opinion through \`Agent(model: "${planningModel}")\`. ${commonEnding}`;
  }
  if (mode === "reviews") {
    return `For consequential reviews of real changes, run the Claude opinion through \`Agent(model: "${reviewModel}")\`. ${commonEnding}`;
  }
  if (planningModel === reviewModel) {
    return `For consequential plans, architecture decisions, and reviews of real changes, run the Claude opinion through \`Agent(model: "${planningModel}")\`. ${commonEnding}`;
  }
  return `For consequential plans and architecture decisions, run the Claude opinion through \`Agent(model: "${planningModel}")\`; for consequential reviews of real changes, use \`Agent(model: "${reviewModel}")\`. ${commonEnding}`;
}

export function buildClaudeCodexModelPreferencesPrompt(
  model: string,
  preferences: ClaudeCodexModelPreferences = DEFAULT_CLAUDE_CODEX_MODEL_PREFERENCES,
): string {
  const selectedModel = effectiveClaudeCodexModel(model);
  const ownership = TASK_PREFERENCES.map(({ key, label, scope }) =>
    taskPreferenceInstruction(
      label,
      scope,
      preferences[key],
      selectedModel,
      claudeModelForTask(preferences, key),
    ),
  ).join("\n");
  return `# Model preferences (configured in T3 Code)

The main session stays on its selected Claude model but acts as a thin orchestrator: decompose the request, delegate substantial work, coordinate results, and synthesize the final answer. Do not keep planning, design, implementation, review, or final-analysis work inline merely because it needs judgment; route it to the configured subagent type below. Inline work is for trivial steps, integration between agent results, and the final call.

Subagent routing:
${ownership}

Delegation rules:
- Give every subagent a self-contained prompt with the relevant files, constraints, expected result, and verification steps.
- When independent workstreams exist, run subagents in parallel. Use workflows when several delegated results feed one decision.
- The main session must inspect evidence, resolve conflicts, and synthesize; it must not rubber-stamp a subagent result.
- Avoid delegation theater for genuinely tiny tasks, but prefer delegation whenever a task has a substantive artifact or can be usefully separated.

Second-opinion policy:
${secondOpinionInstruction(preferences.secondOpinion, selectedModel, preferences)}

These preferences guide routing; they do not lower the quality bar. If a delegated result is weak, incomplete, or conflicts with direct evidence, Claude must correct or redo it before presenting a conclusion.`;
}

export function buildManagedClaudeCodexRoutingPrompt(
  model: string,
  preferences: ClaudeCodexModelPreferences = DEFAULT_CLAUDE_CODEX_MODEL_PREFERENCES,
): string {
  return composeSystemPromptText([
    nativeDelegationInstructions(model),
    buildClaudeCodexModelPreferencesPrompt(model, preferences),
  ])!;
}

/** Native task preferences appended to the ordinary T3 system-prompt rules. */
export function resolveClaudeCodexRoutingPrompt(
  routing: ClaudeCodexRoutingSettings | undefined,
  effectiveModel?: string,
): string | undefined {
  if (routing?.enabled !== true) return undefined;
  const model = effectiveClaudeCodexModel(effectiveModel ?? routing.model);
  const preferenceInstructions =
    routing.promptMode === "none"
      ? undefined
      : routing.promptMode === "custom"
        ? routing.customPrompt
        : buildClaudeCodexModelPreferencesPrompt(model, routing.modelPreferences);
  return composeSystemPromptText([
    nativeDelegationInstructions(model),
    preferenceInstructions,
    routing.additionalInstructions,
  ]);
}
