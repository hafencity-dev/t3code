/** Per-request global GPT fast mode for routed Codex messages (fork feature f5). */
import { Predicate } from "effect";

export function claudeCodexFastModePayload(payload: unknown, enabled: boolean): unknown {
  if (!Predicate.isObject(payload) || Array.isArray(payload)) return payload;
  if (enabled) {
    return payload.service_tier === "priority" ? payload : { ...payload, service_tier: "priority" };
  }
  if (!("service_tier" in payload) && payload.speed !== "fast") return payload;
  const translated = { ...payload };
  delete translated.service_tier;
  if (translated.speed === "fast") delete translated.speed;
  return translated;
}
