import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  classifyTailscaleStderr,
  isOwnServeTarget,
  makeTailscaleServeCli,
  parseTailscaleServeConfig,
  resolveTailscaleExecutable,
  TAILSCALE_SERVE_STATUS_TIMEOUT,
  TailscaleServeCliError,
} from "./tailscaleServeCli.ts";

const encoder = new TextEncoder();

// `tailscale serve status --json` captured while another dev server had taken
// over the default HTTPS port.
const HIJACKED_SERVE_STATUS_JSON =
  '{"TCP":{"443":{"HTTPS":true}},"Web":{"bastians-mac-book-pro.tail0d2eda.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8081"}}}}}';

const SECRET = "tskey-auth-secret-token-value";

/** Same walk as packages/tailscale: nothing reachable from the error may quote stderr. */
function assertCarriesNoSecret(error: object, secret: string): void {
  const seen = new WeakSet<object>();
  const walk = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      assert.notInclude(value, secret, `${path} leaked stderr`);
      return;
    }
    if (typeof value !== "object" || value === null || seen.has(value)) {
      return;
    }
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${path}[${String(index)}]`));
      return;
    }
    walk((value as { message?: unknown }).message, `${path}.message`);
    walk((value as { cause?: unknown }).cause, `${path}.cause`);
    for (const [key, nested] of Object.entries(value)) {
      walk(nested, `${path}.${key}`);
    }
  };
  walk(error, "error");
}

interface SpawnResult {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
}

function mockHandle(result: SpawnResult) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout ?? "")),
    stderr: Stream.make(encoder.encode(result.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function neverFinishingMockHandle() {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.never,
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

interface SpawnCall {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

const notFound = (command: string) =>
  PlatformError.systemError({
    _tag: "NotFound",
    module: "ChildProcess",
    method: "spawn",
    pathOrDescriptor: command,
  });

type SpawnOutcome =
  | { readonly _tag: "result"; readonly result: SpawnResult }
  | { readonly _tag: "fail"; readonly error: PlatformError.PlatformError }
  | { readonly _tag: "hang" };

function makeSpawner(platform: NodeJS.Platform, respond: (call: SpawnCall) => SpawnOutcome) {
  const calls: SpawnCall[] = [];
  const layer = Layer.merge(
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        if (command._tag !== "StandardCommand") {
          return Effect.die("unexpected piped command");
        }
        const call = { command: command.command, args: command.args };
        calls.push(call);
        const outcome = respond(call);
        switch (outcome._tag) {
          case "result":
            return Effect.succeed(mockHandle(outcome.result));
          case "fail":
            return Effect.fail(outcome.error);
          case "hang":
            return Effect.succeed(neverFinishingMockHandle());
        }
      }),
    ),
    Layer.succeed(HostProcessPlatform, platform),
  );
  return { calls, layer };
}

const ok = (result: SpawnResult = {}): SpawnOutcome => ({ _tag: "result", result });

describe("tailscaleServeCli", () => {
  it.effect("orders executable candidates per platform", () =>
    Effect.sync(() => {
      assert.deepEqual(resolveTailscaleExecutable("darwin"), [
        "tailscale",
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "/usr/local/bin/tailscale",
      ]);
      assert.deepEqual(resolveTailscaleExecutable("win32"), ["tailscale.exe"]);
      assert.deepEqual(resolveTailscaleExecutable("linux"), ["tailscale"]);
    }),
  );

  it.effect("decodes a hijacked serve config into the occupant's proxy target", () =>
    Effect.gen(function* () {
      const mapping = yield* parseTailscaleServeConfig(HIJACKED_SERVE_STATUS_JSON, 443);
      assert.deepEqual(mapping, {
        _tag: "proxy",
        hostKey: "bastians-mac-book-pro.tail0d2eda.ts.net:443",
        target: "http://127.0.0.1:8081",
      });
    }),
  );

  it.effect("treats empty, null, and other-port configs as no mapping", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* parseTailscaleServeConfig("", 443), { _tag: "none" });
      assert.deepEqual(yield* parseTailscaleServeConfig("null\n", 443), { _tag: "none" });
      assert.deepEqual(yield* parseTailscaleServeConfig("{}", 443), { _tag: "none" });
      assert.deepEqual(yield* parseTailscaleServeConfig(HIJACKED_SERVE_STATUS_JSON, 8443), {
        _tag: "none",
      });
    }),
  );

  it.effect("sees a foreground serve session as the port's occupant", () =>
    Effect.gen(function* () {
      const mapping = yield* parseTailscaleServeConfig(
        '{"TCP":{"443":{"HTTPS":true}},"Foreground":{"1234567890":{"TCP":{"443":{"HTTPS":true}},"Web":{"desktop.tail.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8081"}}}}}}}',
        443,
      );
      assert.deepEqual(mapping, {
        _tag: "proxy",
        hostKey: "desktop.tail.ts.net:443",
        target: "http://127.0.0.1:8081",
      });
    }),
  );

  it.effect("reports non-proxy handlers as other occupants", () =>
    Effect.gen(function* () {
      const mapping = yield* parseTailscaleServeConfig(
        '{"Web":{"desktop.tail.ts.net:443":{"Handlers":{"/":{"Path":"/srv/site"}}}}}',
        443,
      );
      assert.deepEqual(mapping, { _tag: "other", hostKey: "desktop.tail.ts.net:443" });
    }),
  );

  it.effect("fails typed on malformed serve status output", () =>
    Effect.gen(function* () {
      const error = yield* parseTailscaleServeConfig("not json", 443).pipe(Effect.flip);
      assert.instanceOf(error, TailscaleServeCliError);
      assert.equal(error.reason, "parse");
      assert.equal(error.subcommand, "serve");
    }),
  );

  it.effect("recognizes loopback targets on our port as ours", () =>
    Effect.sync(() => {
      assert.isTrue(isOwnServeTarget("http://127.0.0.1:3773", 3773));
      assert.isTrue(isOwnServeTarget("http://localhost:3773", 3773));
      assert.isTrue(isOwnServeTarget("http://[::1]:3773", 3773));
      assert.isFalse(isOwnServeTarget("http://127.0.0.1:8081", 3773));
      assert.isFalse(isOwnServeTarget("http://192.168.1.20:3773", 3773));
      assert.isFalse(isOwnServeTarget("garbage", 3773));
    }),
  );

  it.effect("classifies stderr into labels and keeps only the login URL", () =>
    Effect.sync(() => {
      const withConsent = classifyTailscaleStderr(
        `Serve is not enabled on your tailnet. ${SECRET}\nTo enable, visit:\n\n\thttps://login.tailscale.com/f/serve?node=abc123\n`,
      );
      assert.deepEqual(withConsent, {
        diagnostic: "serve-not-enabled",
        consentUrl: "https://login.tailscale.com/f/serve?node=abc123",
      });
      assert.deepEqual(classifyTailscaleStderr("serve permission denied"), {
        diagnostic: "permission-denied",
      });
      assert.deepEqual(classifyTailscaleStderr(`something novel ${SECRET}`), {
        diagnostic: "unknown",
      });
      // Trailing prose punctuation is not part of the URL.
      assert.equal(
        classifyTailscaleStderr(
          "HTTPS is not enabled (see https://login.tailscale.com/f/serve?node=abc123).",
        )?.consentUrl,
        "https://login.tailscale.com/f/serve?node=abc123",
      );
      assert.isUndefined(classifyTailscaleStderr("   "));
      // Only Tailscale's login host counts as a consent URL.
      assert.deepEqual(classifyTailscaleStderr("see https://example.com/enable-https"), {
        diagnostic: "unknown",
      });
    }),
  );

  it.effect("applies and clears serve with upstream's argv", () => {
    const spawner = makeSpawner("linux", () => ok());
    return Effect.gen(function* () {
      const cli = yield* makeTailscaleServeCli;
      yield* cli.applyServe({ localPort: 3773, servePort: 443 });
      yield* cli.clearServe({ servePort: 8443 });
      assert.deepEqual(spawner.calls, [
        { command: "tailscale", args: ["serve", "--bg", "--https=443", "http://127.0.0.1:3773"] },
        { command: "tailscale", args: ["serve", "--https=8443", "off"] },
      ]);
    }).pipe(Effect.provide(spawner.layer));
  });

  it.effect("reads the serve config through the spawner", () => {
    const spawner = makeSpawner("linux", () => ok({ stdout: HIJACKED_SERVE_STATUS_JSON }));
    return Effect.gen(function* () {
      const cli = yield* makeTailscaleServeCli;
      const mapping = yield* cli.readServeConfig(443);
      assert.equal(mapping._tag, "proxy");
      assert.deepEqual(spawner.calls, [
        { command: "tailscale", args: ["serve", "status", "--json"] },
      ]);
    }).pipe(Effect.provide(spawner.layer));
  });

  it.effect("falls back to the app bundle CLI on macOS when PATH has none", () => {
    const spawner = makeSpawner("darwin", (call) =>
      call.command === "tailscale"
        ? { _tag: "fail", error: notFound(call.command) }
        : ok({ stdout: '{"Self":{"DNSName":"desktop.tail.ts.net."}}' }),
    );
    return Effect.gen(function* () {
      const cli = yield* makeTailscaleServeCli;
      const status = yield* cli.readStatus;
      assert.equal(status.magicDnsName, "desktop.tail.ts.net");
      // The resolved candidate is remembered: no second ENOENT walk.
      yield* cli.readStatus;
      assert.deepEqual(
        spawner.calls.map((call) => call.command),
        [
          "tailscale",
          "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
          "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        ],
      );
    }).pipe(Effect.provide(spawner.layer));
  });

  it.effect("reports not-installed once every candidate is missing", () => {
    const spawner = makeSpawner("darwin", (call) => ({
      _tag: "fail",
      error: notFound(call.command),
    }));
    return Effect.gen(function* () {
      const cli = yield* makeTailscaleServeCli;
      const error = yield* cli.readStatus.pipe(Effect.flip);
      assert.equal(error.reason, "not-installed");
      assert.equal(spawner.calls.length, 3);
    }).pipe(Effect.provide(spawner.layer));
  });

  it.effect("does not walk candidates for spawn failures other than ENOENT", () => {
    const spawner = makeSpawner("darwin", () => ({
      _tag: "fail",
      error: PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "ChildProcess",
        method: "spawn",
      }),
    }));
    return Effect.gen(function* () {
      const cli = yield* makeTailscaleServeCli;
      const error = yield* cli.readStatus.pipe(Effect.flip);
      assert.equal(error.reason, "spawn");
      assert.equal(spawner.calls.length, 1);
    }).pipe(Effect.provide(spawner.layer));
  });

  it.effect("surfaces the HTTPS consent URL without quoting stderr", () => {
    const spawner = makeSpawner("linux", () =>
      ok({
        code: 1,
        stderr: `Serve is not enabled on your tailnet for node ${SECRET}.\nTo enable, visit:\n\thttps://login.tailscale.com/f/serve?node=abc123\n`,
      }),
    );
    return Effect.gen(function* () {
      const cli = yield* makeTailscaleServeCli;
      const error = yield* cli.applyServe({ localPort: 3773, servePort: 443 }).pipe(Effect.flip);
      assert.instanceOf(error, TailscaleServeCliError);
      assert.equal(error.reason, "exit");
      assert.equal(error.exitCode, 1);
      assert.equal(error.diagnostic, "serve-not-enabled");
      assert.equal(error.consentUrl, "https://login.tailscale.com/f/serve?node=abc123");
      assert.include(error.message, "https://login.tailscale.com/f/serve?node=abc123");
      assert.notProperty(error, "stderr");
      assertCarriesNoSecret(error, SECRET);
    }).pipe(Effect.provide(spawner.layer));
  });

  it.effect("times out a hung serve status through the TestClock", () => {
    const spawner = makeSpawner("linux", () => ({ _tag: "hang" }));
    return Effect.gen(function* () {
      const cli = yield* makeTailscaleServeCli;
      const fiber = yield* cli.readServeConfig(443).pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(TAILSCALE_SERVE_STATUS_TIMEOUT);
      const error = yield* Fiber.join(fiber);
      assert.equal(error.reason, "timeout");
      assert.equal(error.subcommand, "serve");
    }).pipe(Effect.provide(spawner.layer));
  });
});
