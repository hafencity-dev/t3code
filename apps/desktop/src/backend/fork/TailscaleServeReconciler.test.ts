import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  HttpClient,
  HttpClientError,
  HttpClientResponse,
  type HttpClientRequest,
} from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as TailscaleServeReconciler from "./TailscaleServeReconciler.ts";

const encoder = new TextEncoder();

const MAGICDNS = "desktop.tail.ts.net";
const STATUS_JSON = `{"Self":{"DNSName":"${MAGICDNS}."}}`;
const LOCAL_DESCRIPTOR_URL = "http://127.0.0.1:3773/.well-known/t3/environment";
const REMOTE_DESCRIPTOR_URL = `https://${MAGICDNS}/.well-known/t3/environment`;
const OCCUPANT_TARGET = "http://127.0.0.1:8081";
const OCCUPANT_DESCRIPTOR_URL = `${OCCUPANT_TARGET}/.well-known/t3/environment`;
const SECRET = "tskey-auth-secret-token-value";

const OUR_ENVIRONMENT_ID = "env-ours";
const FOREIGN_ENVIRONMENT_ID = "env-theirs";

const descriptorJson = (environmentId: string) =>
  JSON.stringify({
    environmentId,
    label: "Desktop",
    platform: { os: "darwin", arch: "arm64" },
    serverVersion: "0.0.39",
    capabilities: {},
  });

const serveStatusJson = (proxyTarget: string) =>
  JSON.stringify({
    TCP: { "443": { HTTPS: true } },
    Web: { [`${MAGICDNS}:443`]: { Handlers: { "/": { Proxy: proxyTarget } } } },
  });

const OURS_SERVE_STATUS = serveStatusJson("http://127.0.0.1:3773");
const FOREIGN_SERVE_STATUS = serveStatusJson(OCCUPANT_TARGET);
const FOREIGN_OCCUPANT: TailscaleServeReconciler.TailscaleServeOccupant = {
  _tag: "proxy",
  target: OCCUPANT_TARGET,
};

type HttpReply =
  | { readonly _tag: "json"; readonly body: string; readonly status?: number }
  | { readonly _tag: "html" }
  | { readonly _tag: "status"; readonly status: number }
  | { readonly _tag: "unreachable" }
  | { readonly _tag: "hang" };

const json = (body: string): HttpReply => ({ _tag: "json", body });
const html: HttpReply = { _tag: "html" };
const unreachable: HttpReply = { _tag: "unreachable" };
const hang: HttpReply = { _tag: "hang" };

interface SpawnCall {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

interface SpawnReply {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
}

const isMutatingServeCall = (call: SpawnCall) =>
  call.args[0] === "serve" && (call.args.includes("--bg") || call.args.includes("off"));

function mockHandle(reply: SpawnReply) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(reply.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(reply.stdout ?? "")),
    stderr: Stream.make(encoder.encode(reply.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

interface Scenario {
  /** Reply for `tailscale status --json`; defaults to a node with a MagicDNS name. */
  readonly status?: SpawnReply;
  /** Reply for `tailscale serve status --json`; undefined means exit 0 with no config. */
  readonly serveConfig?: string | SpawnReply;
  /** Our own server on loopback; defaults to our descriptor. */
  readonly local?: HttpReply;
  /** Whatever answers on the MagicDNS hostname; defaults to unreachable. */
  readonly remote?: HttpReply;
  /** The foreign mapping's own target; defaults to unreachable (gone). */
  readonly occupant?: HttpReply;
}

/**
 * One harness per test: the spawner answers `status --json` with a fixed
 * MagicDNS name, `serve status --json` with the scenario's config, and every
 * mutating `serve` call with success. HTTP probes answer per URL. Both record
 * what they were asked so tests can assert the reconciler stayed hands-off.
 * `update` swaps scenario fields mid-test to simulate the world changing.
 */
function makeHarness(initial: Scenario) {
  let scenario = initial;
  const spawnCalls: SpawnCall[] = [];
  const httpUrls: string[] = [];

  const spawnerLayer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      if (command._tag !== "StandardCommand") {
        return Effect.die("unexpected piped command");
      }
      const call = { command: command.command, args: command.args };
      spawnCalls.push(call);
      if (call.args[0] === "status") {
        return Effect.succeed(mockHandle(scenario.status ?? { stdout: STATUS_JSON }));
      }
      if (call.args[1] === "status") {
        const config = scenario.serveConfig;
        return Effect.succeed(
          mockHandle(
            config === undefined
              ? { stdout: "{}" }
              : typeof config === "string"
                ? { stdout: config }
                : config,
          ),
        );
      }
      return Effect.succeed(mockHandle({}));
    }),
  );

  const httpLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
      httpUrls.push(request.url);
      const reply =
        request.url === LOCAL_DESCRIPTOR_URL
          ? (scenario.local ?? json(descriptorJson(OUR_ENVIRONMENT_ID)))
          : request.url === REMOTE_DESCRIPTOR_URL
            ? (scenario.remote ?? unreachable)
            : request.url === OCCUPANT_DESCRIPTOR_URL
              ? (scenario.occupant ?? unreachable)
              : unreachable;
      switch (reply._tag) {
        case "json":
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(reply.body, {
                status: reply.status ?? 200,
                headers: { "content-type": "application/json" },
              }),
            ),
          );
        case "html":
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response("<html>Brooktor</html>", {
                status: 200,
                headers: { "content-type": "text/html" },
              }),
            ),
          );
        case "status":
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(null, { status: reply.status })),
          );
        case "hang":
          return Effect.never;
        case "unreachable":
          return Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                cause: new Error("connection refused"),
              }),
            }),
          );
      }
    }),
  );

  return {
    spawnCalls,
    httpUrls,
    update: (patch: Scenario) => {
      scenario = { ...scenario, ...patch };
    },
    layer: Layer.mergeAll(spawnerLayer, httpLayer, Layer.succeed(HostProcessPlatform, "linux")),
  };
}

const serveStatusCalls = (calls: readonly SpawnCall[]) =>
  calls.filter((call) => call.args[0] === "serve" && call.args[1] === "status").length;

const networkAccessible: TailscaleServeReconciler.TailscaleServeExposure = {
  port: 3773,
  mode: "network-accessible",
  serveEnabled: true,
  servePort: 443,
};
const localOnly: TailscaleServeReconciler.TailscaleServeExposure = {
  ...networkAccessible,
  mode: "local-only",
};

/**
 * Builds the reconciler with the exposure parked on port 0 so the immediate
 * pass is a no-op, then switches to the requested exposure. Tests drive
 * passes explicitly through reconcileNow or the TestClock.
 */
const makeReconciler = (exposure: TailscaleServeReconciler.TailscaleServeExposure) =>
  Effect.gen(function* () {
    const exposureRef = yield* Ref.make<TailscaleServeReconciler.TailscaleServeExposure>({
      ...exposure,
      port: 0,
    });
    const readCount = yield* Ref.make(0);
    const reconciler = yield* TailscaleServeReconciler.make({
      readExposure: Ref.update(readCount, (count) => count + 1).pipe(
        Effect.andThen(Ref.get(exposureRef)),
      ),
    });
    yield* Ref.set(exposureRef, exposure);
    return { reconciler, exposureRef, readCount };
  });

describe("TailscaleServeReconciler", () => {
  it.effect("stays idle without a port, without serve, or in local-only", () => {
    const harness = makeHarness({});
    return Effect.gen(function* () {
      const { reconciler, exposureRef } = yield* makeReconciler(networkAccessible);

      yield* Ref.set(exposureRef, { ...networkAccessible, port: 0 });
      assert.deepEqual(yield* reconciler.reconcileNow(), { phase: "idle", reason: "port-unknown" });

      yield* Ref.set(exposureRef, { ...networkAccessible, serveEnabled: false });
      assert.deepEqual(yield* reconciler.reconcileNow(), {
        phase: "idle",
        reason: "serve-disabled",
      });

      yield* Ref.set(exposureRef, localOnly);
      assert.deepEqual(yield* reconciler.reconcileNow(), { phase: "idle", reason: "local-only" });

      assert.deepEqual(harness.spawnCalls, []);
      assert.deepEqual(harness.httpUrls, []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("treats a matching environment id as owned without touching serve", () => {
    const harness = makeHarness({
      serveConfig: FOREIGN_SERVE_STATUS,
      remote: json(descriptorJson(OUR_ENVIRONMENT_ID)),
    });
    return Effect.gen(function* () {
      const { reconciler } = yield* makeReconciler(networkAccessible);
      const observation = yield* reconciler.reconcileNow();
      assert.deepEqual(observation, { phase: "owned", baseUrl: `https://${MAGICDNS}/` });
      // Identity settled it: only `tailscale status --json` for the DNS name.
      assert.deepEqual(
        harness.spawnCalls.map((call) => call.args),
        [["status", "--json"]],
      );
      assert.deepEqual(yield* reconciler.getObservation, observation);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("applies serve when nothing is mapped on the port", () => {
    const harness = makeHarness({ remote: unreachable });
    return Effect.gen(function* () {
      const { reconciler } = yield* makeReconciler(networkAccessible);
      const observation = yield* reconciler.reconcileNow();
      assert.equal(observation.phase, "owned");
      assert.deepEqual(
        harness.spawnCalls.map((call) => call.args),
        [
          ["status", "--json"],
          ["serve", "status", "--json"],
          ["serve", "--bg", "--https=443", "http://127.0.0.1:3773"],
        ],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("adopts a mapping that already targets our port without spawning serve", () => {
    // Remote silent (certificates still provisioning) but the config is ours.
    const harness = makeHarness({ serveConfig: OURS_SERVE_STATUS, remote: unreachable });
    return Effect.gen(function* () {
      const { reconciler } = yield* makeReconciler(networkAccessible);
      const observation = yield* reconciler.reconcileNow();
      assert.equal(observation.phase, "owned");
      assert.isFalse(harness.spawnCalls.some(isMutatingServeCall));
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("reclaims a stale foreign mapping whose backend is gone", () => {
    const harness = makeHarness({
      serveConfig: FOREIGN_SERVE_STATUS,
      remote: { _tag: "status", status: 502 },
    });
    return Effect.gen(function* () {
      const { reconciler } = yield* makeReconciler(networkAccessible);
      const observation = yield* reconciler.reconcileNow();
      assert.equal(observation.phase, "owned");
      assert.deepEqual(
        harness.spawnCalls.filter(isMutatingServeCall).map((call) => call.args),
        [["serve", "--bg", "--https=443", "http://127.0.0.1:3773"]],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("never overwrites a live foreign T3 server unless asked to reclaim", () => {
    const harness = makeHarness({
      serveConfig: FOREIGN_SERVE_STATUS,
      remote: json(descriptorJson(FOREIGN_ENVIRONMENT_ID)),
    });
    return Effect.gen(function* () {
      const { reconciler } = yield* makeReconciler(networkAccessible);
      const conflict = yield* reconciler.reconcileNow();
      assert.deepEqual(conflict, {
        phase: "conflict",
        baseUrl: `https://${MAGICDNS}/`,
        occupant: FOREIGN_OCCUPANT,
      });
      assert.isFalse(harness.spawnCalls.some(isMutatingServeCall));

      const reclaimed = yield* reconciler.reconcileNow({ reclaim: true });
      assert.equal(reclaimed.phase, "owned");
      assert.deepEqual(
        harness.spawnCalls.filter(isMutatingServeCall).map((call) => call.args),
        [["serve", "--bg", "--https=443", "http://127.0.0.1:3773"]],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("reports a non-T3 occupant as a conflict", () => {
    const harness = makeHarness({ serveConfig: FOREIGN_SERVE_STATUS, remote: html });
    return Effect.gen(function* () {
      const { reconciler } = yield* makeReconciler(networkAccessible);
      const observation = yield* reconciler.reconcileNow();
      assert.equal(observation.phase, "conflict");
      assert.isFalse(harness.spawnCalls.some(isMutatingServeCall));
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "keeps a foreign mapping whose target still answers even when the hostname is silent",
    () => {
      // Serve itself may be down (certificates, tailscaled restart): the remote
      // probe failing says nothing about the occupant. Its own target does.
      const harness = makeHarness({
        serveConfig: FOREIGN_SERVE_STATUS,
        remote: unreachable,
        occupant: html,
      });
      return Effect.gen(function* () {
        const { reconciler } = yield* makeReconciler(networkAccessible);
        const observation = yield* reconciler.reconcileNow();
        assert.deepEqual(observation, {
          phase: "conflict",
          baseUrl: `https://${MAGICDNS}/`,
          occupant: FOREIGN_OCCUPANT,
        });
        assert.isFalse(harness.spawnCalls.some(isMutatingServeCall));
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("keeps a foreign mapping whose target is slow to answer", () => {
    // A dev server mid-compile accepts the socket and stalls; that is not an
    // absent listener, so the probe timeout must not count as stale.
    const harness = makeHarness({
      serveConfig: FOREIGN_SERVE_STATUS,
      remote: unreachable,
      occupant: hang,
    });
    return Effect.gen(function* () {
      const { reconciler } = yield* makeReconciler(networkAccessible);
      const pass = yield* Effect.forkScoped(reconciler.reconcileNow());
      // The probe's timeout is armed a few scheduler rounds in; step the
      // clock until the pass settles rather than guessing the round count.
      for (let step = 0; step < 6 && pass.pollUnsafe() === undefined; step += 1) {
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(500));
      }
      const observation = yield* Fiber.join(pass);
      assert.deepEqual(observation, {
        phase: "conflict",
        baseUrl: `https://${MAGICDNS}/`,
        occupant: FOREIGN_OCCUPANT,
      });
      assert.isFalse(harness.spawnCalls.some(isMutatingServeCall));
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("reclaims a foreign mapping whose target refuses connections", () => {
    const harness = makeHarness({ serveConfig: FOREIGN_SERVE_STATUS, remote: unreachable });
    return Effect.gen(function* () {
      const { reconciler } = yield* makeReconciler(networkAccessible);
      const observation = yield* reconciler.reconcileNow();
      assert.equal(observation.phase, "owned");
      assert.include(harness.httpUrls, OCCUPANT_DESCRIPTOR_URL);
      assert.deepEqual(
        harness.spawnCalls.filter(isMutatingServeCall).map((call) => call.args),
        [["serve", "--bg", "--https=443", "http://127.0.0.1:3773"]],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "never writes while something else answers on the hostname, even with no mapping listed",
    () => {
      // A foreground `tailscale serve` session serves the hostname without
      // showing up where a background mapping would.
      const harness = makeHarness({ remote: html });
      return Effect.gen(function* () {
        const { reconciler } = yield* makeReconciler(networkAccessible);
        const observation = yield* reconciler.reconcileNow();
        assert.deepEqual(observation, {
          phase: "conflict",
          baseUrl: `https://${MAGICDNS}/`,
          occupant: { _tag: "unknown" },
        });
        assert.isFalse(harness.spawnCalls.some(isMutatingServeCall));
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("repairs a conflict once the occupant goes away", () => {
    const harness = makeHarness({
      serveConfig: FOREIGN_SERVE_STATUS,
      remote: html,
      occupant: html,
    });
    return Effect.gen(function* () {
      const { reconciler } = yield* makeReconciler(networkAccessible);
      assert.equal((yield* reconciler.reconcileNow()).phase, "conflict");
      harness.update({ remote: { _tag: "status", status: 502 }, occupant: unreachable });
      assert.equal((yield* reconciler.reconcileNow()).phase, "owned");
      assert.deepEqual(
        harness.spawnCalls.filter(isMutatingServeCall).map((call) => call.args),
        [["serve", "--bg", "--https=443", "http://127.0.0.1:3773"]],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("reports a non-proxy handler as a conflict keyed by host", () => {
    const harness = makeHarness({
      serveConfig: JSON.stringify({
        Web: { [`${MAGICDNS}:443`]: { Handlers: { "/": { Path: "/srv/site" } } } },
      }),
      remote: html,
    });
    return Effect.gen(function* () {
      const { reconciler } = yield* makeReconciler(networkAccessible);
      const observation = yield* reconciler.reconcileNow();
      assert.deepEqual(observation, {
        phase: "conflict",
        baseUrl: `https://${MAGICDNS}/`,
        occupant: { _tag: "handler" },
      });
      assert.isFalse(harness.spawnCalls.some(isMutatingServeCall));
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("waits for the local server instead of touching serve", () => {
    const harness = makeHarness({ serveConfig: FOREIGN_SERVE_STATUS, local: unreachable });
    return Effect.gen(function* () {
      const { reconciler } = yield* makeReconciler(networkAccessible);
      const observation = yield* reconciler.reconcileNow();
      assert.deepEqual(observation, { phase: "idle", reason: "server-unreachable" });
      assert.isFalse(harness.spawnCalls.some((call) => call.args[0] === "serve"));
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("surfaces CLI failures with a diagnostic and consent URL, never stderr", () => {
    const harness = makeHarness({
      serveConfig: {
        code: 1,
        stderr: `Serve is not enabled on your tailnet ${SECRET}\nhttps://login.tailscale.com/f/serve?node=abc123`,
      },
      remote: unreachable,
    });
    return Effect.gen(function* () {
      const { reconciler } = yield* makeReconciler(networkAccessible);
      const observation = yield* reconciler.reconcileNow();
      assert.equal(observation.phase, "error");
      if (observation.phase !== "error") return;
      assert.equal(observation.diagnostic, "serve-not-enabled");
      assert.equal(observation.consentUrl, "https://login.tailscale.com/f/serve?node=abc123");
      assert.notInclude(observation.message, SECRET);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("clears only a mapping that is ours", () => {
    const foreign = makeHarness({ serveConfig: FOREIGN_SERVE_STATUS });
    const ours = makeHarness({ serveConfig: OURS_SERVE_STATUS });
    const empty = makeHarness({});
    return Effect.gen(function* () {
      const foreignReconciler = yield* makeReconciler(networkAccessible).pipe(
        Effect.provide(foreign.layer),
      );
      assert.equal(
        yield* foreignReconciler.reconciler.clearOwnMapping.pipe(Effect.provide(foreign.layer)),
        "not-ours",
      );
      assert.isFalse(foreign.spawnCalls.some(isMutatingServeCall));

      const oursReconciler = yield* makeReconciler(networkAccessible).pipe(
        Effect.provide(ours.layer),
      );
      assert.equal(
        yield* oursReconciler.reconciler.clearOwnMapping.pipe(Effect.provide(ours.layer)),
        "cleared",
      );
      assert.deepEqual(
        ours.spawnCalls.filter(isMutatingServeCall).map((call) => call.args),
        [["serve", "--https=443", "off"]],
      );
      assert.deepEqual(yield* oursReconciler.reconciler.getObservation, {
        phase: "idle",
        reason: "serve-disabled",
      });

      const emptyReconciler = yield* makeReconciler(networkAccessible).pipe(
        Effect.provide(empty.layer),
      );
      assert.equal(
        yield* emptyReconciler.reconciler.clearOwnMapping.pipe(Effect.provide(empty.layer)),
        "none",
      );
    });
  });

  it.effect("retries quickly until the port is known, then settles into the minute cadence", () => {
    const harness = makeHarness({ remote: json(descriptorJson(OUR_ENVIRONMENT_ID)) });
    return Effect.gen(function* () {
      const { reconciler, readCount } = yield* makeReconciler(networkAccessible);
      // The construction-time pass saw port 0.
      assert.deepEqual(yield* reconciler.getObservation, { phase: "idle", reason: "port-unknown" });
      yield* TestClock.adjust(TailscaleServeReconciler.TAILSCALE_SERVE_RETRY_INTERVAL);
      assert.deepEqual(yield* reconciler.getObservation, {
        phase: "owned",
        baseUrl: `https://${MAGICDNS}/`,
      });

      const reads = yield* Ref.get(readCount);
      yield* TestClock.adjust(Duration.seconds(59));
      assert.equal(yield* Ref.get(readCount), reads);
      yield* TestClock.adjust(Duration.seconds(1));
      assert.equal(yield* Ref.get(readCount), reads + 1);
      // The name is pinned while the mapping is verified ours.
      yield* TestClock.adjust(Duration.minutes(10));
      assert.equal(harness.spawnCalls.filter((call) => call.args[0] === "status").length, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("re-reads the serve config only when the probes change or after ten minutes", () => {
    const harness = makeHarness({ serveConfig: FOREIGN_SERVE_STATUS, remote: html });
    return Effect.gen(function* () {
      const { reconciler } = yield* makeReconciler(networkAccessible);
      yield* TestClock.adjust(TailscaleServeReconciler.TAILSCALE_SERVE_RETRY_INTERVAL);
      assert.equal((yield* reconciler.getObservation).phase, "conflict");
      assert.equal(serveStatusCalls(harness.spawnCalls), 1);

      yield* TestClock.adjust(Duration.minutes(9));
      assert.equal((yield* reconciler.getObservation).phase, "conflict");
      assert.equal(serveStatusCalls(harness.spawnCalls), 1);
      // The MagicDNS name is not pinned outside `owned`, but still bounded.
      assert.equal(harness.spawnCalls.filter((call) => call.args[0] === "status").length, 2);

      yield* TestClock.adjust(Duration.minutes(2));
      assert.equal(serveStatusCalls(harness.spawnCalls), 2);
      assert.isFalse(harness.spawnCalls.some(isMutatingServeCall));
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("caches a failed status read instead of spawning every tick", () => {
    const harness = makeHarness({ status: { code: 1, stderr: "Logged out." } });
    return Effect.gen(function* () {
      const { reconciler } = yield* makeReconciler(networkAccessible);
      yield* TestClock.adjust(TailscaleServeReconciler.TAILSCALE_SERVE_RETRY_INTERVAL);
      const observation = yield* reconciler.getObservation;
      assert.equal(observation.phase, "error");
      if (observation.phase !== "error") return;
      assert.equal(observation.diagnostic, "not-logged-in");

      yield* TestClock.adjust(Duration.minutes(4));
      assert.equal(harness.spawnCalls.length, 1);
      yield* TestClock.adjust(Duration.minutes(2));
      assert.equal(harness.spawnCalls.length, 2);
    }).pipe(Effect.provide(harness.layer));
  });
});
