/** Per-request GPT-6 family effort capabilities and transport for the Claude SDK bridge (fork feature). */
import type { ModelSelection } from "@t3tools/contracts";
import { createModelCapabilities, getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { Predicate } from "effect";

const EFFORT_MODELS = ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export function claudeCodexCapabilities(model: string) {
  return createModelCapabilities({
    optionDescriptors: EFFORT_MODELS.includes(model)
      ? [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "default", label: "Provider default", isDefault: true },
              ...EFFORTS.map((id) => ({
                id,
                label: id === "xhigh" ? "Extra high" : id.charAt(0).toUpperCase() + id.slice(1),
              })),
            ],
          },
        ]
      : [],
  });
}

export function claudeCodexTransportModel(model: string, selection: ModelSelection): string {
  const effort = getModelSelectionStringOptionValue(selection, "reasoningEffort");
  return EFFORT_MODELS.includes(model) && EFFORTS.some((value) => value === effort)
    ? `${model}(${effort})`
    : model;
}

/** Decode our SDK transport suffix into the proxy's Claude adaptive-effort input.
 * Keep this request-local so simultaneous sessions never share effort state.
 */
export function claudeCodexEffortPayload(payload: unknown): unknown {
  if (!Predicate.isObject(payload) || typeof payload.model !== "string") return payload;
  const model = EFFORT_MODELS.find((model) =>
    EFFORTS.some((effort) => payload.model === `${model}(${effort})`),
  );
  if (!model) return payload;
  const effort = EFFORTS.find((effort) => payload.model === `${model}(${effort})`);
  return {
    ...payload,
    model,
    thinking: { type: "adaptive" },
    output_config: {
      ...(Predicate.isObject(payload.output_config) ? payload.output_config : {}),
      effort,
    },
  };
}
