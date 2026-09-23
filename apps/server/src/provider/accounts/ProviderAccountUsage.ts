// fork: provider accounts
import type {
  ClaudeSettings,
  CodexSettings,
  ProviderAccountId,
  ServerProviderUsageLimits,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { query as claudeQuery, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { makeClaudeEnvironment } from "../Drivers/ClaudeHome.ts";
import { resolveClaudeSdkExecutablePath } from "../Drivers/ClaudeExecutable.ts";
import * as Semaphore from "effect/Semaphore";
import {
  claudeAuthMetadata,
  buildClaudeCapabilitiesProbeQueryOptions,
} from "../Layers/ClaudeProvider.ts";
import { codexPlanLabel, withCodexAppServerClient } from "../Layers/CodexProvider.ts";
import { claudeUsageResponseToLimits } from "../Layers/claudeUsageLimits.ts";
import { codexRateLimitsToLimits } from "../Layers/codexUsageLimits.ts";
import { makeUnavailableUsageLimits } from "../providerUsageLimits.ts";

export interface AccountUsage {
  readonly lastAttemptAt?: number | undefined;
  readonly consecutiveFailures?: number | undefined;
  readonly nextAllowedAt?: number | undefined;
  readonly lastFailureKind?: "rateLimited" | "failed" | undefined;
  readonly checkedAt: string;
  readonly email?: string | undefined;
  readonly plan?: string | undefined;
  readonly usage?: ServerProviderUsageLimits | undefined;
  readonly status: "ready" | "signedOut" | "error";
}

export type AccountUsageProbeInput = {
  readonly homePath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
} & (
  | { readonly driver: "claudeAgent"; readonly settings: ClaudeSettings }
  | { readonly driver: "codex"; readonly settings: CodexSettings }
);

/** Uses the same CLI protocols and limit mappers as the provider snapshots. */
export const probeAccountUsage = Effect.fn("providerAccounts.probeUsage")(function* (
  input: AccountUsageProbeInput,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (input.driver === "claudeAgent") {
    // The snapshot probe intentionally swallows optional usage failures. This gate must
    // observe the SDK rejection itself so a 429 cannot look like a successful refresh.
    const environment = yield* makeClaudeEnvironment(
      { ...input.settings, homePath: input.homePath },
      input.environment,
    );
    const executablePath = yield* resolveClaudeSdkExecutablePath(
      input.settings.binaryPath,
      environment,
    );
    const abort = new AbortController();
    const result = yield* Effect.tryPromise(async () => {
      const q = claudeQuery({
        // oxlint-disable-next-line require-yield
        prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
          await new Promise<void>((resolve) => {
            if (abort.signal.aborted) resolve();
            else abort.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        })(),
        options: buildClaudeCapabilitiesProbeQueryOptions({
          executablePath,
          abortController: abort,
          environment,
          cwd: input.cwd,
        }),
      });
      const init = await q.initializationResult();
      const account = init.account;
      if (!account?.email && !account?.tokenSource && !account?.subscriptionType) return undefined;
      const usage = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
      return { ...account, usage };
    }).pipe(Effect.ensuring(Effect.sync(() => abort.abort())));
    if (!result) return { checkedAt, status: "signedOut" } satisfies AccountUsage;
    const plan = claudeAuthMetadata({
      subscriptionType: result.subscriptionType,
      authMethod: result.tokenSource,
    })?.label;
    return {
      checkedAt,
      status: "ready",
      ...(result.email ? { email: result.email } : {}),
      ...(plan ? { plan } : {}),
      usage: result.usage
        ? claudeUsageResponseToLimits({ response: result.usage, checkedAt }).limits
        : makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed" }),
    } satisfies AccountUsage;
  }
  const { client } = yield* withCodexAppServerClient({
    binaryPath: input.settings.binaryPath,
    launchArgs: input.settings.launchArgs,
    homePath: input.homePath,
    cwd: input.cwd,
    environment: input.environment,
  });
  const { account } = yield* client.request("account/read", {});
  if (!account) return { checkedAt, status: "signedOut" } satisfies AccountUsage;
  if (account.type !== "chatgpt") {
    return {
      checkedAt,
      status: "ready",
      usage: makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" }),
    } satisfies AccountUsage;
  }
  const response = yield* client.request("account/rateLimits/read", undefined);
  const plan = codexPlanLabel(account.planType);
  return {
    checkedAt,
    status: "ready",
    ...(account.email ? { email: account.email } : {}),
    ...(plan ? { plan } : {}),
    usage: codexRateLimitsToLimits({
      snapshot: response.rateLimits,
      rateLimitsByLimitId: response.rateLimitsByLimitId,
      resetCredits: response.rateLimitResetCredits,
      checkedAt,
    }),
  } satisfies AccountUsage;
}, Effect.scoped);

/** Thrown by a probe whose account was checked out while it ran; its result is dropped. */
export class AccountUsageProbeStaleError extends Error {
  override readonly name = "AccountUsageProbeStaleError";
}

export const ACCOUNT_USAGE_TTL_MS = 5 * 60_000;
const MANUAL_FLOOR_MS = 60_000;
const MAX_ATTEMPTS = 6;

/** Inspect wrapped SDK / JSON-RPC errors, never expose their private text to clients. */
function failureDetails(error: unknown, now: number) {
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

/** Newer measurements and newer attempts are independent: a live snapshot must not erase backoff. */
function newest(cached: AccountUsage | undefined, previous: AccountUsage | undefined) {
  if (!cached) return previous;
  if (!previous) return cached;
  const measurement =
    Date.parse(previous.checkedAt) > Date.parse(cached.checkedAt) ? previous : cached;
  const attempt = (previous.lastAttemptAt ?? -1) > (cached.lastAttemptAt ?? -1) ? previous : cached;
  if (attempt.lastAttemptAt === undefined) return measurement;
  const { lastFailureKind: _discard, ...base } = measurement;
  return {
    ...base,
    lastAttemptAt: attempt.lastAttemptAt,
    consecutiveFailures: attempt.consecutiveFailures ?? 0,
    nextAllowedAt: attempt.nextAllowedAt ?? 0,
    ...(attempt.lastFailureKind ? { lastFailureKind: attempt.lastFailureKind } : {}),
  };
}

/** The only admission gate for inactive probes; skipped requests never enter a queue. */
export const makeAccountUsageCache = <E, R>(dependencies: {
  readonly probe: (id: ProviderAccountId) => Effect.Effect<AccountUsage, E, R>;
}) => {
  const permits = Semaphore.makeUnsafe(2);
  const lock = Semaphore.makeUnsafe(1);
  const cache = new Map<ProviderAccountId, AccountUsage>();
  const pending = new Map<ProviderAccountId, Effect.Effect<AccountUsage | undefined, never, R>>();
  const attempts: Array<{ at: number }> = [];
  const pendingUntil = new Map<ProviderAccountId, number>();
  const budgetAt = (now: number) => {
    const recent = attempts.filter(({ at }) => at > now - ACCOUNT_USAGE_TTL_MS);
    return recent.length >= MAX_ATTEMPTS
      ? recent[recent.length - MAX_ATTEMPTS]!.at + ACCOUNT_USAGE_TTL_MS
      : 0;
  };
  // Manual refreshes wait only for the 60s floor and failure backoff; the TTL gates the rest.
  // A success's stored nextAllowedAt is ignored so older 5-minute values never block them.
  const accountAt = (prior: AccountUsage | undefined, force = false) =>
    Math.max(
      prior?.lastFailureKind ? (prior.nextAllowedAt ?? 0) : 0,
      prior?.lastAttemptAt === undefined ? 0 : prior.lastAttemptAt + MANUAL_FLOOR_MS,
      !force && prior && (prior.usage || prior.status === "signedOut") && !prior.lastFailureKind
        ? Date.parse(prior.checkedAt) + ACCOUNT_USAGE_TTL_MS
        : 0,
    );
  const nextAllowedAt = (id: ProviderAccountId, now: number, previous?: AccountUsage) =>
    Math.max(accountAt(newest(cache.get(id), previous)), budgetAt(now), pendingUntil.get(id) ?? 0);
  const canProbe = (id: ProviderAccountId, now: number, previous?: AccountUsage) =>
    !pending.has(id) && now >= nextAllowedAt(id, now, previous);

  const refresh = Effect.fn("providerAccounts.refreshCachedUsage")(function* (input: {
    readonly id: ProviderAccountId;
    readonly active: boolean;
    readonly previous?: AccountUsage;
    readonly force?: boolean;
  }) {
    if (input.active) return input.previous;
    const effect = yield* lock.withPermit(
      Effect.gen(function* () {
        const prior = newest(cache.get(input.id), input.previous);
        if (prior) cache.set(input.id, prior);
        const inFlight = pending.get(input.id);
        if (inFlight) return inFlight;
        const now = yield* Clock.currentTimeMillis;
        if (now < Math.max(accountAt(prior, input.force), budgetAt(now)))
          return Effect.succeed(prior);
        // Reserve the attempt before releasing the admission lock, not after the probe finishes.
        while (attempts.length && attempts[0]!.at <= now - ACCOUNT_USAGE_TTL_MS) attempts.shift();
        const attempt = { at: now };
        attempts.push(attempt);
        const memo = yield* Effect.gen(function* () {
          attempt.at = yield* Clock.currentTimeMillis;
          pendingUntil.set(input.id, attempt.at + ACCOUNT_USAGE_TTL_MS);
          return yield* dependencies.probe(input.id).pipe(Effect.timeout(20_000));
        }).pipe(
          permits.withPermit,
          Effect.flatMap((value) =>
            value.usage?.unavailable?.reason === "probeFailed"
              ? Effect.fail(new Error(value.usage.unavailable.message ?? "Usage probe failed"))
              : Effect.succeed(value),
          ),
          Effect.map((value): AccountUsage => {
            const { lastFailureKind: _discard, ...measurement } = value;
            return {
              ...measurement,
              lastAttemptAt: attempt.at,
              consecutiveFailures: 0,
              nextAllowedAt: attempt.at + MANUAL_FLOOR_MS,
            };
          }),
          Effect.catch((error) =>
            Effect.gen(function* () {
              // A stale result is neither a measurement nor a failure; the attempt still counted.
              if (error instanceof AccountUsageProbeStaleError) return undefined;
              const failedAt = yield* Clock.currentTimeMillis;
              const { rateLimited, retryAt } = failureDetails(error, failedAt);
              const consecutiveFailures = (prior?.consecutiveFailures ?? 0) + 1;
              const cap = (rateLimited ? 120 : 60) * 60_000;
              const delay = Math.min(
                cap,
                (rateLimited ? 15 : 5) * 60_000 * 2 ** Math.min(consecutiveFailures - 1, 10),
              );
              const checkedAt = prior?.checkedAt ?? DateTime.formatIso(yield* DateTime.now);
              return {
                ...prior,
                checkedAt,
                status: prior?.status ?? "error",
                lastAttemptAt: attempt.at,
                consecutiveFailures,
                nextAllowedAt:
                  failedAt + Math.min(cap, Math.max(delay, rateLimited ? retryAt - failedAt : 0)),
                lastFailureKind: rateLimited ? "rateLimited" : "failed",
                usage: {
                  ...(prior?.usage ?? { checkedAt, windows: [] }),
                  unavailable: {
                    reason: "probeFailed",
                    message: "Could not refresh account usage.",
                  },
                },
              } satisfies AccountUsage;
            }),
          ),
          Effect.tap((value) =>
            Effect.sync(() => {
              if (value) cache.set(input.id, value);
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              pending.delete(input.id);
              pendingUntil.delete(input.id);
            }),
          ),
          Effect.cached,
        );
        pending.set(input.id, memo);
        pendingUntil.set(input.id, now + ACCOUNT_USAGE_TTL_MS);
        return memo;
      }),
    );
    return yield* effect;
  });

  return { refresh, canProbe, nextAllowedAt, forget: (id: ProviderAccountId) => cache.delete(id) };
};
