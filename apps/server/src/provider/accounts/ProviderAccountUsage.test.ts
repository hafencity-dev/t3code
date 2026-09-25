// fork: provider accounts
import { ClaudeSettings, ProviderAccountId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { vi } from "vite-plus/test";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { CodexAppServerRequestError } from "effect-codex-app-server/errors";
import {
  makeAccountUsageCache,
  probeAccountUsage,
  type AccountUsage,
} from "./ProviderAccountUsage.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);
const id = ProviderAccountId.make("usage-account");
const minute = 60_000;
const good: AccountUsage = {
  checkedAt: "1970-01-01T00:00:00.000Z",
  status: "ready",
  email: "account@example.test",
  usage: { checkedAt: "1970-01-01T00:00:00.000Z", windows: [] },
};
const refresh = { id, active: false, force: true } as const;

const measuredNow = Effect.gen(function* () {
  const checkedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
  return { ...good, checkedAt, usage: { checkedAt, windows: [] } } satisfies AccountUsage;
});

describe("provider account usage admission", () => {
  it.effect("never probes active accounts, even forced", () =>
    Effect.gen(function* () {
      let calls = 0;
      const cache = makeAccountUsageCache({
        probe: () =>
          Effect.sync(() => {
            calls++;
            return good;
          }),
      });
      expect(yield* cache.refresh({ ...refresh, active: true, previous: good })).toEqual(good);
      expect(calls).toBe(0);
    }),
  );

  // S3: only a call that produced a new successful measurement reports it as measured.
  it.effect("reports whether a refresh measured anything", () =>
    Effect.gen(function* () {
      let fail = false;
      const cache = makeAccountUsageCache({
        probe: () => (fail ? Effect.fail(new Error("probe failed")) : measuredNow),
      });
      expect((yield* cache.refreshMeasured(refresh)).measured).toBe(true);
      // Inside the 60s floor the gate returns the retained numbers without probing.
      const gated = yield* cache.refreshMeasured(refresh);
      expect(gated.measured).toBe(false);
      expect(gated.usage).toMatchObject({ status: "ready" });
      yield* TestClock.adjust(minute);
      fail = true;
      expect((yield* cache.refreshMeasured(refresh)).measured).toBe(false);
    }),
  );

  it.effect("enforces a 60-second forced floor, then permits manual refresh", () =>
    Effect.gen(function* () {
      let calls = 0;
      const cache = makeAccountUsageCache({
        probe: () => measuredNow.pipe(Effect.tap(() => Effect.sync(() => calls++))),
      });
      const first = yield* cache.refresh(refresh);
      expect(first).toMatchObject({
        lastAttemptAt: 0,
        nextAllowedAt: minute,
        consecutiveFailures: 0,
      });
      yield* TestClock.adjust(59_999);
      expect(yield* cache.refresh(refresh)).toEqual(first);
      expect(calls).toBe(1);
      yield* TestClock.adjust(1);
      yield* cache.refresh(refresh);
      expect(calls).toBe(2);
    }),
  );

  it.effect(
    "keeps the five-minute TTL for automatic checks but lets a manual refresh through after 60s",
    () =>
      Effect.gen(function* () {
        let calls = 0;
        const cache = makeAccountUsageCache({
          probe: () => measuredNow.pipe(Effect.tap(() => Effect.sync(() => calls++))),
        });
        yield* cache.refresh({ id, active: false, previous: good });
        expect(calls).toBe(0);
        yield* TestClock.adjust(5 * minute);
        const value = yield* cache.refresh({ id, active: false });
        expect(value?.nextAllowedAt).toBe(6 * minute);
        yield* TestClock.adjust(minute - 1);
        yield* cache.refresh(refresh);
        expect(calls).toBe(1);
        yield* TestClock.adjust(1);
        yield* cache.refresh({ id, active: false });
        expect(calls).toBe(1);
        yield* cache.refresh(refresh);
        expect(calls).toBe(2);
      }),
  );

  it.effect("ignores a legacy five-minute floor persisted after a successful check", () =>
    Effect.gen(function* () {
      let calls = 0;
      const cache = makeAccountUsageCache({
        probe: () => measuredNow.pipe(Effect.tap(() => Effect.sync(() => calls++))),
      });
      const legacy: AccountUsage = {
        ...good,
        lastAttemptAt: 0,
        consecutiveFailures: 0,
        nextAllowedAt: 5 * minute,
      };
      yield* TestClock.adjust(minute);
      yield* cache.refresh({ id, active: false, previous: legacy });
      expect(calls).toBe(0);
      yield* cache.refresh({ ...refresh, previous: legacy });
      expect(calls).toBe(1);
    }),
  );

  it.effect("treats a window that reset after the measurement as stale within the TTL", () =>
    Effect.gen(function* () {
      let calls = 0;
      const cache = makeAccountUsageCache({
        probe: () => measuredNow.pipe(Effect.tap(() => Effect.sync(() => calls++))),
      });
      const withReset = (resetsAt: string): AccountUsage => ({
        ...good,
        usage: {
          checkedAt: good.checkedAt,
          windows: [{ id: "session", label: "5h", kind: "session", usedPercent: 100, resetsAt }],
        },
      });
      yield* TestClock.adjust(2 * minute);
      // Reset one minute after the measurement: numbers are stale although only 2 minutes old.
      yield* cache.refresh({ id, active: false, previous: withReset("1970-01-01T00:01:00.000Z") });
      expect(calls).toBe(1);
      // A reset already past when measured is what the provider reported; the TTL still applies.
      const other = ProviderAccountId.make("reported-reset");
      yield* cache.refresh({
        id: other,
        active: false,
        previous: { ...withReset("1969-12-31T23:00:00.000Z") },
      });
      expect(calls).toBe(1);
    }),
  );

  for (const [label, error] of [
    [
      "SDK wrapped 429",
      { _tag: "UnknownError", cause: new Error("Failed to fetch usage: 429 Too Many Requests") },
    ],
    ["SDK rate limit text", new Error("Usage request failed: rate limit exceeded")],
    [
      "Codex JSON-RPC",
      CodexAppServerRequestError.fromProtocolError(
        { code: -32000, message: "too many requests" },
        "account/rateLimits/read",
        "1",
      ),
    ],
  ] as const) {
    it.effect(`${label}: 15m then 30m backoff, retained good data, reset on success`, () =>
      Effect.gen(function* () {
        let calls = 0;
        const cache = makeAccountUsageCache({
          probe: () => Effect.suspend(() => (++calls < 3 ? Effect.fail(error) : measuredNow)),
        });
        const first = yield* cache.refresh({ ...refresh, previous: good });
        expect(first).toMatchObject({
          checkedAt: good.checkedAt,
          lastAttemptAt: 0,
          consecutiveFailures: 1,
          nextAllowedAt: 15 * minute,
          lastFailureKind: "rateLimited",
        });
        expect(first?.usage?.checkedAt).toBe(good.checkedAt);
        expect(JSON.stringify(first)).not.toContain("Too Many Requests");
        expect(cache.canProbe(id, 14 * minute, first)).toBe(false);
        expect(cache.nextAllowedAt(id, 14 * minute, first)).toBe(15 * minute);
        yield* TestClock.adjust(15 * minute - 1);
        yield* cache.refresh(refresh);
        expect(calls).toBe(1);
        yield* TestClock.adjust(1);
        const second = yield* cache.refresh(refresh);
        expect(second).toMatchObject({ consecutiveFailures: 2, nextAllowedAt: 45 * minute });
        yield* TestClock.adjust(30 * minute);
        const success = yield* cache.refresh(refresh);
        expect(success).toMatchObject({ consecutiveFailures: 0, nextAllowedAt: 46 * minute });
        expect(success?.lastFailureKind).toBeUndefined();
        expect(success?.usage?.unavailable).toBeUndefined();
        expect(calls).toBe(3);
      }),
    );
  }

  for (const rateLimited of [false, true]) {
    it.effect(`caps ${rateLimited ? "rate limit" : "ordinary failure"} exponential backoff`, () =>
      Effect.gen(function* () {
        const cache = makeAccountUsageCache({
          probe: () => Effect.fail(new Error(rateLimited ? "429" : "failed")),
        });
        let at = 0;
        for (let n = 1; n <= 6; n++) {
          const value = yield* cache.refresh(refresh);
          const delay =
            Math.min(rateLimited ? 120 : 60, (rateLimited ? 15 : 5) * 2 ** (n - 1)) * minute;
          expect(value).toMatchObject({
            lastAttemptAt: at,
            consecutiveFailures: n,
            nextAllowedAt: at + delay,
            lastFailureKind: rateLimited ? "rateLimited" : "failed",
          });
          yield* TestClock.adjust(delay);
          at += delay;
        }
      }),
    );
  }

  for (const [label, error, delay] of [
    [
      "header seconds",
      { status: 429, headers: new Headers({ "retry-after": "1800" }) },
      30 * minute,
    ],
    [
      "header date",
      { status: 429, headers: { "retry-after": "Thu, 01 Jan 1970 00:40:00 GMT" } },
      40 * minute,
    ],
    [
      "Codex reset seconds",
      CodexAppServerRequestError.fromProtocolError(
        { code: 429, message: "rate limited", data: { reset_seconds: 2700 } },
        "account/rateLimits/read",
        "2",
      ),
      45 * minute,
    ],
    ["SDK message", new Error("429 Usage fetch failed. Retry-After: 1800 seconds"), 30 * minute],
    ["retry cap", { status: 429, retryAfterSeconds: 10_000 }, 120 * minute],
  ] as const) {
    it.effect(`honors ${label}`, () =>
      Effect.gen(function* () {
        const cache = makeAccountUsageCache({ probe: () => Effect.fail(error) });
        expect((yield* cache.refresh(refresh))?.nextAllowedAt).toBe(delay);
      }),
    );
  }

  it.effect(
    "skips excess requests without queueing and releases the rolling budget at exact expiry",
    () =>
      Effect.gen(function* () {
        let calls = 0;
        const cache = makeAccountUsageCache({
          probe: () => measuredNow.pipe(Effect.tap(() => Effect.sync(() => calls++))),
        });
        for (let n = 0; n < 6; n++) {
          yield* cache.refresh({ ...refresh, id: ProviderAccountId.make(`budget-${n}`) });
          yield* TestClock.adjust(minute / 2);
        }
        expect(calls).toBe(6);
        expect(cache.canProbe(id, 3 * minute)).toBe(false);
        expect(cache.nextAllowedAt(id, 3 * minute)).toBe(5 * minute);
        expect(yield* cache.refresh({ ...refresh, previous: good })).toEqual(good);
        expect(
          yield* cache.refresh({ ...refresh, id: ProviderAccountId.make("empty") }),
        ).toBeUndefined();
        yield* TestClock.adjust(2 * minute - 1);
        yield* cache.refresh(refresh);
        expect(calls).toBe(6);
        yield* TestClock.adjust(1);
        expect(calls).toBe(6); // Skipped work is not queued for later.
        expect(cache.canProbe(id, 5 * minute)).toBe(true);
        yield* cache.refresh(refresh);
        expect(calls).toBe(7);
        expect(cache.nextAllowedAt(ProviderAccountId.make("other"), 5 * minute)).toBe(5.5 * minute);
      }),
  );

  it.effect("reserves the budget before permits and runs at most two probes concurrently", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      let calls = 0;
      let running = 0;
      let maximum = 0;
      const cache = makeAccountUsageCache({
        probe: () =>
          Effect.gen(function* () {
            calls++;
            maximum = Math.max(maximum, ++running);
            if (calls === 2) yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(finish);
            running--;
            return good;
          }),
      });
      const fibers = [];
      for (let n = 0; n < 6; n++)
        fibers.push(
          yield* cache
            .refresh({ ...refresh, id: ProviderAccountId.make(`pending-${n}`) })
            .pipe(Effect.forkChild),
        );
      yield* Deferred.await(started);
      yield* Effect.yieldNow;
      expect(yield* cache.refresh(refresh)).toBeUndefined();
      expect(calls).toBe(2);
      yield* Deferred.succeed(finish, undefined);
      for (const fiber of fibers) yield* Fiber.join(fiber);
      expect(calls).toBe(6);
      expect(maximum).toBe(2);
    }),
  );

  it.effect("allows a metadata-only login snapshot to fetch its first usage", () =>
    Effect.gen(function* () {
      let calls = 0;
      const cache = makeAccountUsageCache({
        probe: () => measuredNow.pipe(Effect.tap(() => Effect.sync(() => calls++))),
      });
      const previous: AccountUsage = {
        checkedAt: good.checkedAt,
        status: "ready",
        email: good.email,
      };
      expect(cache.canProbe(id, 0, previous)).toBe(true);
      yield* cache.refresh({ id, active: false, previous });
      expect(calls).toBe(1);
    }),
  );

  it.effect(
    "restores persisted failure metadata on a fresh cache, including the failure count",
    () =>
      Effect.gen(function* () {
        const firstCache = makeAccountUsageCache({ probe: () => Effect.fail(new Error("429")) });
        const persisted = yield* firstCache.refresh({ ...refresh, previous: good });
        let calls = 0;
        const restarted = makeAccountUsageCache({
          probe: () =>
            Effect.suspend(() => {
              calls++;
              return Effect.fail(new Error("429"));
            }),
        });
        expect(restarted.canProbe(id, 0, persisted)).toBe(false);
        expect(restarted.nextAllowedAt(id, 0, persisted)).toBe(15 * minute);
        yield* restarted.refresh({ ...refresh, previous: persisted! });
        expect(calls).toBe(0);
        yield* TestClock.adjust(15 * minute);
        expect(yield* restarted.refresh({ ...refresh, previous: persisted! })).toMatchObject({
          consecutiveFailures: 2,
          nextAllowedAt: 45 * minute,
        });
        expect(calls).toBe(1);
      }),
  );

  for (const newerSource of ["cache", "registry"] as const) {
    it.effect(
      `keeps newer ${newerSource} measurements without dropping the last failed attempt`,
      () =>
        Effect.gen(function* () {
          const newer = {
            ...good,
            checkedAt: new Date(minute).toISOString(),
            email: "newer@example.test",
            usage: { checkedAt: new Date(minute).toISOString(), windows: [] },
          };
          let calls = 0;
          const cache = makeAccountUsageCache({
            probe: () =>
              Effect.suspend(() =>
                ++calls === 1
                  ? Effect.succeed(newerSource === "cache" ? newer : good)
                  : Effect.fail(new Error("failed")),
              ),
          });
          yield* TestClock.adjust(minute);
          yield* cache.refresh(refresh);
          const previous = newerSource === "registry" ? newer : good;
          expect(yield* cache.refresh({ id, active: false, previous })).toMatchObject({
            checkedAt: newer.checkedAt,
            email: newer.email,
          });
          yield* TestClock.adjust(5 * minute);
          const failed = yield* cache.refresh({ id, active: false, previous });
          expect(failed).toMatchObject({
            checkedAt: newer.checkedAt,
            email: newer.email,
            lastAttemptAt: 6 * minute,
            nextAllowedAt: 11 * minute,
          });
          expect(yield* cache.refresh({ ...refresh, previous: newer })).toEqual(failed);
          expect(cache.canProbe(id, 6 * minute, newer)).toBe(false);
          expect(calls).toBe(2);
        }),
    );
  }

  it.effect(
    "shares concurrent probes, preserves good values, and does not leak private errors",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        let calls = 0;
        const cache = makeAccountUsageCache({
          probe: () =>
            Effect.gen(function* () {
              calls++;
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(finish);
              return yield* Effect.fail(new Error("private process output"));
            }),
        });
        const first = yield* cache.refresh({ ...refresh, previous: good }).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        expect(cache.canProbe(id, 0)).toBe(false);
        expect(cache.nextAllowedAt(id, 0)).toBe(5 * minute);
        const second = yield* cache.refresh({ ...refresh, previous: good }).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(finish, undefined);
        const a = yield* Fiber.join(first);
        expect(yield* Fiber.join(second)).toEqual(a);
        expect(calls).toBe(1);
        expect(a?.usage?.checkedAt).toBe(good.checkedAt);
        expect(a?.email).toBe(good.email);
        expect(JSON.stringify(a)).not.toContain("private process output");
      }),
  );

  it.effect("treats a probeFailed measurement as failure rather than resetting backoff", () =>
    Effect.gen(function* () {
      const cache = makeAccountUsageCache({
        probe: () =>
          Effect.succeed({
            ...good,
            usage: {
              ...good.usage!,
              unavailable: { reason: "probeFailed", message: "rate limit exceeded" },
            },
          }),
      });
      expect(yield* cache.refresh(refresh)).toMatchObject({
        consecutiveFailures: 1,
        lastFailureKind: "rateLimited",
        nextAllowedAt: 15 * minute,
      });
    }),
  );

  it.effect("keeps backoff when a newer live registry measurement replaces stale cached bars", () =>
    Effect.gen(function* () {
      let calls = 0;
      const cache = makeAccountUsageCache({
        probe: () =>
          Effect.suspend(() => {
            calls++;
            return Effect.fail(new Error("429"));
          }),
      });
      yield* cache.refresh({ ...refresh, previous: good });
      yield* TestClock.adjust(minute);
      const newer = yield* measuredNow;
      expect(yield* cache.refresh({ ...refresh, previous: newer })).toMatchObject({
        checkedAt: newer.checkedAt,
        usage: newer.usage,
        lastAttemptAt: 0,
        consecutiveFailures: 1,
        nextAllowedAt: 15 * minute,
        lastFailureKind: "rateLimited",
      });
      expect(cache.nextAllowedAt(id, minute, newer)).toBe(15 * minute);
      expect(calls).toBe(1);
    }),
  );

  it.effect(
    "times out once, starts failure backoff at completion, and releases the pending probe",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        let calls = 0;
        const cache = makeAccountUsageCache({
          probe: () =>
            Effect.gen(function* () {
              calls++;
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            }),
        });
        const fiber = yield* cache.refresh(refresh).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* TestClock.adjust(20_000);
        const failed = yield* Fiber.join(fiber);
        expect(failed).toMatchObject({
          lastAttemptAt: 0,
          lastFailureKind: "failed",
          consecutiveFailures: 1,
          nextAllowedAt: 20_000 + 5 * minute,
        });
        yield* cache.refresh(refresh);
        expect(calls).toBe(1);
        expect(cache.canProbe(id, 20_000 + 5 * minute)).toBe(true);
      }),
  );

  it.effect("observes the real SDK usage rejection after successful initialization", () =>
    Effect.gen(function* () {
      const abort = vi.fn();
      const query = vi.mocked(ClaudeSdk.query);
      query.mockImplementationOnce((input) => {
        input.options?.abortController?.signal.addEventListener("abort", abort);
        return {
          initializationResult: async () => ({
            account: { email: good.email, tokenSource: "oauth", subscriptionType: "pro" },
          }),
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
            throw new Error("Failed to fetch usage: 429 Too Many Requests; Retry-After: 1800");
          },
        } as unknown as ReturnType<typeof ClaudeSdk.query>;
      });
      const cache = makeAccountUsageCache({
        probe: () =>
          probeAccountUsage({
            driver: "claudeAgent",
            settings: decodeClaudeSettings({}),
            homePath: "",
            environment: {},
            cwd: "/tmp",
          }),
      });
      const result = yield* cache.refresh({ ...refresh, previous: good });
      expect(result).toMatchObject({
        consecutiveFailures: 1,
        lastFailureKind: "rateLimited",
        nextAllowedAt: 30 * minute,
        checkedAt: good.checkedAt,
      });
      expect(abort).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
