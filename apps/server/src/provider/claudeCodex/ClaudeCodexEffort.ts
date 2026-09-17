/** Per-request Astra effort transport for the Claude SDK bridge (fork feature). */
import type { ModelSelection } from "@t3tools/contracts";
import { createModelCapabilities, getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { Predicate } from "effect";

const ASTRA = "gpt-6-astra";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export function claudeCodexCapabilities(model: string) {
  return createModelCapabilities({
    optionDescriptors:
      model === ASTRA
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
  return model === ASTRA && EFFORTS.some((value) => value === effort)
    ? `${model}(${effort})`
    : model;
}

/** Decode our SDK transport suffix into the proxy's Claude adaptive-effort input.
 * Keep this request-local so simultaneous sessions never share effort state.
 */
export function claudeCodexEffortPayload(payload: unknown): unknown {
  if (!Predicate.isObject(payload) || typeof payload.model !== "string") return payload;
  const effort = EFFORTS.find((value) => payload.model === `${ASTRA}(${value})`);
  if (!effort) return payload;
  return {
    ...payload,
    model: ASTRA,
    thinking: { type: "adaptive" },
    output_config: {
      ...(Predicate.isObject(payload.output_config) ? payload.output_config : {}),
      effort,
    },
  };
}
