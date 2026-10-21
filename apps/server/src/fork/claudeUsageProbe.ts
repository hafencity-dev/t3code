import * as Predicate from "effect/Predicate";

/** Inspect SDK errors without returning credential-bearing error text. */
export function usageProbeFailureDetails(error: unknown, now: number) {
  const texts: string[] = [];
  let retryAt = 0;
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 6 || value == null || seen.has(value)) return;
    if (typeof value === "string" || typeof value === "number") {
      texts.push(String(value));
      return;
    }
    if (!Predicate.isObject(value)) return;
    seen.add(value);
    if (value instanceof Error) texts.push(value.message);
    if (value instanceof Headers) {
      visit(Object.fromEntries(value.entries()), depth + 1);
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      if (/^(retry[-_]?after|retryAfterSeconds|reset[-_]?seconds|resetsInSeconds)$/i.test(key)) {
        const seconds = Number(item);
        const at = Number.isFinite(seconds) ? now + seconds * 1_000 : Date.parse(String(item));
        if (Number.isFinite(at)) retryAt = Math.max(retryAt, at);
      }
      visit(item, depth + 1);
    }
    if (value instanceof Error) visit(value.cause, depth + 1);
  };
  visit(error, 0);
  const text = texts.join(" ");
  const retry =
    /(?:retry[- ]after|reset(?:s)?(?: in)?)[:= ]+(\d+(?:\.\d+)?)\s*(?:s(?:ec(?:onds?)?)?)?/i.exec(
      text,
    );
  if (retry) retryAt = Math.max(retryAt, now + Number(retry[1]) * 1_000);
  return { rateLimited: /\b429\b|rate[ _-]?limit|too many requests/i.test(text), retryAt };
}
