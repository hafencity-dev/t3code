/** Settings → Model Routing (fork feature f5). */
import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_CLAUDE_CODEX_MODEL_PREFERENCES,
  DEFAULT_CLAUDE_CODEX_ROUTING_SETTINGS,
  type ClaudeCodexClaudeSubagentModel,
  type ClaudeCodexModelPreferences,
  type ClaudeCodexRoutingPromptMode,
  type ClaudeCodexRoutingSettings,
  type ClaudeCodexSecondOpinionMode,
  type ClaudeCodexTaskRoute,
  type ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  effectiveClaudeCodexModel,
  resolveClaudeCodexRoutingPrompt,
} from "@t3tools/shared/claudeCodexRouting";
import { CheckIcon, CopyIcon, RouteIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { primaryServerProvidersAtom } from "../../state/server";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import {
  buildClaudeCodexRoutingPatch,
  claudeRoutingProviders,
  readClaudeCodexRouting,
} from "./ModelRoutingSettings.logic";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const PROMPT_MODES: ReadonlyArray<{
  readonly value: ClaudeCodexRoutingPromptMode;
  readonly label: string;
}> = [
  { value: "managed", label: "T3 preferences" },
  { value: "custom", label: "Custom policy" },
  { value: "none", label: "No task policy" },
];

const TASK_ROUTE_OPTIONS: ReadonlyArray<{
  readonly value: ClaudeCodexTaskRoute;
  readonly label: string;
}> = [
  { value: "claude", label: "Claude subagent" },
  { value: "codex", label: "Codex subagent" },
  { value: "adaptive", label: "Best fit" },
];

const CLAUDE_SUBAGENT_MODEL_FAMILIES: ReadonlyArray<{
  readonly value: ClaudeCodexClaudeSubagentModel;
  readonly slugPrefix: string;
  readonly fallbackLabel: string;
}> = [
  { value: "opus", slugPrefix: "claude-opus-", fallbackLabel: "Claude Opus" },
  { value: "fable", slugPrefix: "claude-fable-", fallbackLabel: "Claude Fable" },
  { value: "sonnet", slugPrefix: "claude-sonnet-", fallbackLabel: "Claude Sonnet" },
];

function claudeSubagentModelOptions(models: ReadonlyArray<ServerProviderModel>) {
  return CLAUDE_SUBAGENT_MODEL_FAMILIES.map((family) => {
    const model =
      models.find(
        (candidate) => candidate.slug.startsWith(family.slugPrefix) && candidate.isLegacy !== true,
      ) ?? models.find((candidate) => candidate.slug.startsWith(family.slugPrefix));
    return {
      value: family.value,
      label: model?.name ?? family.fallbackLabel,
      available: model !== undefined,
    };
  });
}

type TaskPreferenceKey = Exclude<
  keyof ClaudeCodexModelPreferences,
  "claudeSubagentModel" | "claudeSubagentModels" | "secondOpinion"
>;

const TASK_PREFERENCE_ROWS: ReadonlyArray<{
  readonly key: TaskPreferenceKey;
  readonly label: string;
  readonly description: string;
}> = [
  {
    key: "exploration",
    label: "Exploration & research",
    description: "Codebase mapping, evidence gathering, and independent investigation.",
  },
  {
    key: "implementation",
    label: "Implementation & refactors",
    description: "Clear-spec changes, migrations, refactors, and mechanical edits.",
  },
  {
    key: "verification",
    label: "Tests & verification",
    description: "Reproducing defects, running checks, and verifying concrete claims.",
  },
  {
    key: "planning",
    label: "Planning & architecture",
    description: "Plans, tradeoffs, system design, and ambiguous technical direction.",
  },
  {
    key: "design",
    label: "UI, UX & product design",
    description: "Interaction design, visual decisions, product judgment, and copy.",
  },
  {
    key: "review",
    label: "Review & final analysis",
    description: "Code review, risk assessment, synthesis, and final conclusions.",
  },
];

const SECOND_OPINION_OPTIONS: ReadonlyArray<{
  readonly value: ClaudeCodexSecondOpinionMode;
  readonly label: string;
}> = [
  { value: "off", label: "Off" },
  { value: "plans", label: "Plans only" },
  { value: "reviews", label: "Reviews only" },
  { value: "plans-and-reviews", label: "Plans & reviews" },
];

function CopyAction({ value, label }: { readonly value: string; readonly label: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label={label}
      onClick={() => copyToClipboard(value)}
    >
      {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
    </Button>
  );
}

function PromptEditor({
  label,
  description,
  value,
  placeholder,
  disabled,
  onSave,
}: {
  readonly label: string;
  readonly description: string;
  readonly value: string;
  readonly placeholder: string;
  readonly disabled?: boolean;
  readonly onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const dirty = draft !== value;
  return (
    <SettingsRow title={label} description={description}>
      <div className="mt-3 max-w-3xl space-y-2 pb-3.5 font-mono">
        <Textarea
          rows={6}
          value={draft}
          disabled={disabled}
          placeholder={placeholder}
          aria-label={label}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">{draft.trim().length} characters</span>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" disabled={!dirty} onClick={() => setDraft(value)}>
              Discard
            </Button>
            <Button size="sm" variant="outline" disabled={!dirty} onClick={() => onSave(draft)}>
              Save
            </Button>
          </div>
        </div>
      </div>
    </SettingsRow>
  );
}

export function ModelRoutingSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const claudeProviders = useMemo(() => claudeRoutingProviders(providers), [providers]);
  const [selectedId, setSelectedId] = useState<ProviderInstanceId | null>(null);
  const selected =
    claudeProviders.find((provider) => provider.instanceId === selectedId) ?? claudeProviders[0];
  const routing = selected
    ? readClaudeCodexRouting(settings, selected.instanceId)
    : DEFAULT_CLAUDE_CODEX_ROUTING_SETTINGS;
  const saveRouting = useCallback(
    (next: ClaudeCodexRoutingSettings) => {
      if (!selected) return;
      updateSettings(buildClaudeCodexRoutingPatch(settings, selected.instanceId, next));
    },
    [selected, settings, updateSettings],
  );

  const effectiveModel = effectiveClaudeCodexModel(routing.model);
  const modelOptions = [
    ...new Map(
      providers
        .filter((provider) => provider.driver === "codex" && provider.enabled)
        .flatMap((provider) => provider.models)
        .map((model) => [model.slug, model]),
    ).values(),
  ];
  const exactPrompt = resolveClaudeCodexRoutingPrompt(routing, effectiveModel);
  const managedPreferencesActive = routing.promptMode === "managed";
  const claudeSubagentModels = selected ? claudeSubagentModelOptions(selected.models) : [];
  const modelPreferencesCustomized =
    routing.modelPreferences.claudeSubagentModel !==
      DEFAULT_CLAUDE_CODEX_MODEL_PREFERENCES.claudeSubagentModel ||
    TASK_PREFERENCE_ROWS.some(
      ({ key }) =>
        routing.modelPreferences.claudeSubagentModels[key] !==
        DEFAULT_CLAUDE_CODEX_MODEL_PREFERENCES.claudeSubagentModels[key],
    ) ||
    TASK_PREFERENCE_ROWS.some(
      ({ key }) => routing.modelPreferences[key] !== DEFAULT_CLAUDE_CODEX_MODEL_PREFERENCES[key],
    ) ||
    routing.modelPreferences.secondOpinion !== DEFAULT_CLAUDE_CODEX_MODEL_PREFERENCES.secondOpinion;

  return (
    <SettingsPageContainer>
      <SettingsSection
        {...searchableSetting("model-routing")}
        title="Task routing preferences"
        icon={<RouteIcon className="size-4 text-muted-foreground" />}
      >
        {selected ? (
          <>
            <SettingsRow
              title="Claude Code instance"
              description="Routing is configured independently for each Claude Code account."
              control={
                <Select
                  value={selected.instanceId}
                  onValueChange={(value) => setSelectedId(String(value) as ProviderInstanceId)}
                >
                  <SelectTrigger className="w-full sm:w-56" aria-label="Claude Code instance">
                    <SelectValue>{selected.displayName ?? selected.instanceId}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {claudeProviders.map((provider) => (
                      <SelectItem key={provider.instanceId} value={provider.instanceId}>
                        {provider.displayName ?? provider.instanceId}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
            <SettingsRow
              title="Use task routing preferences"
              description="Guide Claude when delegating tasks through the connected Claude and Codex providers."
              status="Takes effect when a new Claude Code session starts."
              control={
                <Switch
                  checked={routing.enabled}
                  aria-label="Use task routing preferences"
                  onCheckedChange={(checked) =>
                    saveRouting({ ...routing, enabled: Boolean(checked) })
                  }
                />
              }
            />
            <SettingsRow
              title="Codex model"
              description="Preferred model for tasks delegated to the native Codex provider."
              status={
                modelOptions.length === 0
                  ? "Enable Codex in Providers to see available models."
                  : undefined
              }
              control={
                <div className="flex items-center gap-2">
                  <Select
                    value={effectiveModel}
                    onValueChange={(value) => saveRouting({ ...routing, model: String(value) })}
                  >
                    <SelectTrigger className="w-full sm:w-56" aria-label="Codex routing model">
                      <SelectValue>{effectiveModel}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      {modelOptions.map((model) => (
                        <SelectItem key={model.slug} value={model.slug}>
                          {model.name ?? model.slug}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              }
            />
          </>
        ) : (
          <SettingsRow
            title="No Claude Code instance"
            description="Enable Claude Code in Providers before configuring task routing."
          />
        )}
      </SettingsSection>

      <SettingsSection
        {...searchableSetting("model-routing-preferences")}
        title="Model preferences"
      >
        {selected ? (
          <>
            <SettingsRow
              title="Subagent ownership"
              description="Choose the owner and, whenever Claude participates, its model for each category. Best fit uses Codex for mechanical work and the selected Claude model for judgment-heavy work."
              status={
                managedPreferencesActive
                  ? "The main session stays thin: it delegates, coordinates, and owns the final synthesis."
                  : "Inactive while a custom policy or no task policy is selected below."
              }
              resetAction={
                modelPreferencesCustomized ? (
                  <SettingResetButton
                    label="model preferences"
                    onClick={() =>
                      saveRouting({
                        ...routing,
                        modelPreferences: DEFAULT_CLAUDE_CODEX_MODEL_PREFERENCES,
                      })
                    }
                  />
                ) : undefined
              }
            >
              <div className="mt-3 max-w-3xl divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70 bg-muted/15">
                {TASK_PREFERENCE_ROWS.map((preference) => {
                  const route = routing.modelPreferences[preference.key];
                  const claudeModel =
                    routing.modelPreferences.claudeSubagentModels[preference.key] ??
                    routing.modelPreferences.claudeSubagentModel;
                  return (
                    <div
                      key={preference.key}
                      className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-foreground">
                          {preference.label}
                        </div>
                        <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                          {preference.description}
                        </div>
                      </div>
                      <div className="flex w-full shrink-0 flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
                        <Select
                          value={route}
                          disabled={!managedPreferencesActive}
                          onValueChange={(value) =>
                            saveRouting({
                              ...routing,
                              modelPreferences: {
                                ...routing.modelPreferences,
                                [preference.key]: String(value) as ClaudeCodexTaskRoute,
                              },
                            })
                          }
                        >
                          <SelectTrigger
                            size="sm"
                            className="w-full shrink-0 sm:w-40"
                            aria-label={`${preference.label} owner`}
                          >
                            <SelectValue>
                              {TASK_ROUTE_OPTIONS.find((option) => option.value === route)?.label}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectPopup align="end" alignItemWithTrigger={false}>
                            {TASK_ROUTE_OPTIONS.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectPopup>
                        </Select>
                        {route !== "codex" ? (
                          <Select
                            value={claudeModel}
                            disabled={!managedPreferencesActive}
                            onValueChange={(value) =>
                              saveRouting({
                                ...routing,
                                modelPreferences: {
                                  ...routing.modelPreferences,
                                  claudeSubagentModels: {
                                    ...routing.modelPreferences.claudeSubagentModels,
                                    [preference.key]: String(
                                      value,
                                    ) as ClaudeCodexClaudeSubagentModel,
                                  },
                                },
                              })
                            }
                          >
                            <SelectTrigger
                              size="sm"
                              className="w-full shrink-0 sm:w-36"
                              aria-label={`${preference.label} Claude model`}
                            >
                              <SelectValue>
                                {
                                  claudeSubagentModels.find((model) => model.value === claudeModel)
                                    ?.label
                                }
                              </SelectValue>
                            </SelectTrigger>
                            <SelectPopup align="end" alignItemWithTrigger={false}>
                              {claudeSubagentModels.map((model) => (
                                <SelectItem
                                  key={model.value}
                                  value={model.value}
                                  disabled={!model.available}
                                >
                                  {model.label}
                                  {!model.available ? " · unavailable" : ""}
                                </SelectItem>
                              ))}
                            </SelectPopup>
                          </Select>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </SettingsRow>
            <SettingsRow
              title="Independent second opinion"
              description="For consequential work, a Claude and Codex subagent form blind independent views in parallel; the main session adjudicates disagreements. Routine tasks skip the extra pass."
              control={
                <Select
                  value={routing.modelPreferences.secondOpinion}
                  disabled={!managedPreferencesActive}
                  onValueChange={(value) =>
                    saveRouting({
                      ...routing,
                      modelPreferences: {
                        ...routing.modelPreferences,
                        secondOpinion: String(value) as ClaudeCodexSecondOpinionMode,
                      },
                    })
                  }
                >
                  <SelectTrigger className="w-full sm:w-48" aria-label="Independent second opinion">
                    <SelectValue>
                      {
                        SECOND_OPINION_OPTIONS.find(
                          (option) => option.value === routing.modelPreferences.secondOpinion,
                        )?.label
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {SECOND_OPINION_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
          </>
        ) : (
          <SettingsRow
            title="No Claude Code instance"
            description="Enable Claude Code in Providers before configuring model preferences."
          />
        )}
      </SettingsSection>

      <SettingsSection {...searchableSetting("model-routing-prompt")} title="Prompt instructions">
        <SettingsRow
          title="Preference instructions"
          description="Use structured task preferences, supply a custom policy, or add only your additional instructions."
          control={
            <Select
              value={routing.promptMode}
              disabled={!selected}
              onValueChange={(value) =>
                saveRouting({
                  ...routing,
                  promptMode: String(value) as ClaudeCodexRoutingPromptMode,
                })
              }
            >
              <SelectTrigger className="w-full sm:w-48" aria-label="Routing prompt mode">
                <SelectValue>
                  {PROMPT_MODES.find((mode) => mode.value === routing.promptMode)?.label}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {PROMPT_MODES.map((mode) => (
                  <SelectItem key={mode.value} value={mode.value}>
                    {mode.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        {routing.promptMode === "custom" ? (
          <PromptEditor
            label="Custom preference policy"
            description="Replaces the structured model preferences for this Claude instance. Tasks use the connected native providers."
            value={routing.customPrompt}
            placeholder="Explain how and when Claude should delegate work to Claude and Codex…"
            onSave={(customPrompt) => saveRouting({ ...routing, customPrompt })}
          />
        ) : null}
        <PromptEditor
          label="Additional instructions"
          description="Appended after the managed or custom preference policy. Use this for project- or team-specific routing rules."
          value={routing.additionalInstructions}
          placeholder="Prefer Codex for independent implementation and review tasks…"
          disabled={!selected}
          onSave={(additionalInstructions) => saveRouting({ ...routing, additionalInstructions })}
        />
        <SettingsRow
          title="Exact prompt preview"
          description="The preference policy and additions included with the normal instructions for a new Claude session."
          control={
            exactPrompt ? <CopyAction value={exactPrompt} label="Copy routing prompt" /> : undefined
          }
        >
          <div className="mt-3 max-w-3xl pb-3.5">
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/40 px-3 py-3 font-mono text-xs leading-relaxed text-foreground/90">
              {exactPrompt ?? "No routing prompt is injected."}
            </pre>
          </div>
        </SettingsRow>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
