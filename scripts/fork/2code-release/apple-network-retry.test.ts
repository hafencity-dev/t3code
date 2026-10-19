import { assert, describe, expect, it } from "@effect/vitest";

import { withAppleNetworkRetry } from "./apple-network-retry.ts";

const networkFailure = new Error(
  'Failed to staple: Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."\nThe staple and validate action failed! Error 68.',
);

function retryOptions() {
  const delays: number[] = [];
  const messages: string[] = [];
  return {
    delays,
    messages,
    options: {
      wait: async (milliseconds: number) => {
        delays.push(milliseconds);
      },
      onRetry: (message: string) => {
        messages.push(message);
      },
    },
  };
}

describe("Apple release network retries", () => {
  it("recovers from a synchronous stapler connection loss", async () => {
    const { delays, options } = retryOptions();
    let calls = 0;
    const result = await withAppleNetworkRetry(
      "Validate app",
      () => {
        if (++calls === 1) throw networkFailure;
        return { stdout: "The validate action worked!" };
      },
      options,
    );
    assert.deepStrictEqual(result, { stdout: "The validate action worked!" });
    assert.equal(calls, 2);
    assert.deepStrictEqual(delays, [15_000]);
  });

  it("bounds asynchronous notarization retries and preserves the final error", async () => {
    const { delays, messages, options } = retryOptions();
    let calls = 0;
    await expect(
      withAppleNetworkRetry(
        "Notarize disk image",
        async () => {
          calls += 1;
          throw networkFailure;
        },
        options,
      ),
    ).rejects.toBe(networkFailure);
    assert.equal(calls, 4);
    assert.deepStrictEqual(delays, [15_000, 30_000, 45_000]);
    assert.equal(messages.length, 3);
  });

  it.each([
    "The staple and validate action failed! Error 68.",
    "The signature is invalid.",
    'Notarization failed: {"status":"Invalid"}',
    "Could not validate ticket: no ticket found.",
    'Error Domain=NSURLErrorDomain Code=-1202 "Certificate is not trusted"',
    "HTTP 401: invalid credentials",
  ])("does not retry permanent or unclassified failures: %s", async (message) => {
    const { delays, options } = retryOptions();
    let calls = 0;
    await expect(
      withAppleNetworkRetry(
        "Validate app",
        () => {
          calls += 1;
          throw new Error(message);
        },
        options,
      ),
    ).rejects.toThrow(message);
    assert.equal(calls, 1);
    assert.deepStrictEqual(delays, []);
  });

  it("stops immediately if a retry reveals a permanent failure", async () => {
    const { delays, options } = retryOptions();
    const invalidSignature = new Error("The signature is invalid.");
    let calls = 0;
    await expect(
      withAppleNetworkRetry(
        "Validate app",
        () => {
          if (++calls === 1) throw networkFailure;
          throw invalidSignature;
        },
        options,
      ),
    ).rejects.toBe(invalidSignature);
    assert.equal(calls, 2);
    assert.deepStrictEqual(delays, [15_000]);
  });

  it("accepts Apple's standard URL timeout domain", async () => {
    const { delays, options } = retryOptions();
    let calls = 0;
    await withAppleNetworkRetry(
      "Validate disk image",
      async () => {
        if (++calls === 1) throw new Error('Error Domain=NSURLErrorDomain Code=-1001 "Timed out"');
      },
      options,
    );
    assert.equal(calls, 2);
    assert.deepStrictEqual(delays, [15_000]);
  });
});
