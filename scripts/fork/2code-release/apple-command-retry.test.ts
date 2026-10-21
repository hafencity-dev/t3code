import { assert, describe, it } from "@effect/vitest";
import { Clock, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { retryAppleNetworkCommand } from "./apple-command-retry.ts";

class CommandFailure extends Error {
  readonly _tag = "CommandFailure";
}

const networkFailure = new CommandFailure(
  'Command exited with non-zero exit code (1)\nstdout:\nError Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."',
);

describe("Apple packaging command retry", () => {
  it.effect("retries transient output failures at 15, 30 and 45 seconds and returns success", () =>
    Effect.gen(function* () {
      const attempts: number[] = [];
      const operation = Effect.gen(function* () {
        attempts.push(yield* Clock.currentTimeMillis);
        return attempts.length < 4 ? yield* Effect.fail(networkFailure) : "packaged";
      }).pipe(retryAppleNetworkCommand("Package app"));
      const fiber = yield* Effect.forkChild(operation);
      yield* TestClock.adjust("90 seconds");
      assert.equal(yield* Fiber.join(fiber), "packaged");
      assert.deepEqual(attempts, [0, 15_000, 45_000, 90_000]);
    }),
  );

  it.effect("preserves the final error after the retry budget is exhausted", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const failures: CommandFailure[] = [];
      const operation = Effect.suspend(() => {
        attempts++;
        const error = new CommandFailure(`${networkFailure.message} (attempt ${attempts})`);
        failures.push(error);
        return Effect.fail(error);
      }).pipe(retryAppleNetworkCommand("Package app"), Effect.flip);
      const fiber = yield* Effect.forkChild(operation);
      yield* TestClock.adjust("90 seconds");
      assert.strictEqual(yield* Fiber.join(fiber), failures[3]);
      assert.equal(attempts, 4);
    }),
  );

  it.effect(
    "never retries a rejected notarization, invalid signature or unclassified stapler error",
    () =>
      Effect.gen(function* () {
        for (const message of [
          "Notarization status: Invalid",
          "The signature is invalid.",
          "The staple and validate action failed! Error 68.",
          "NSURLErrorDomain Code=-1202: Certificate is not trusted",
        ]) {
          const error = new CommandFailure(message);
          let attempts = 0;
          const result = yield* Effect.suspend(() => {
            attempts++;
            return Effect.fail(error);
          }).pipe(retryAppleNetworkCommand("Package app"), Effect.flip);
          assert.strictEqual(result, error);
          assert.equal(attempts, 1);
        }
      }),
  );

  it.effect("stops if the next attempt reveals a permanent failure", () =>
    Effect.gen(function* () {
      const permanent = new CommandFailure("No notarization ticket found.");
      let attempts = 0;
      const operation = Effect.suspend(() =>
        Effect.fail(++attempts === 1 ? networkFailure : permanent),
      ).pipe(retryAppleNetworkCommand("Package app"), Effect.flip);
      const fiber = yield* Effect.forkChild(operation);
      yield* TestClock.adjust("15 seconds");
      assert.strictEqual(yield* Fiber.join(fiber), permanent);
      assert.equal(attempts, 2);
    }),
  );
});
