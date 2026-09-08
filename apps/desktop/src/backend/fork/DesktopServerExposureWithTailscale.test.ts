import { createAdvertisedEndpoint } from "@t3tools/shared/advertisedEndpoint";
import type { AdvertisedEndpoint, DesktopServerExposureState } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import * as DesktopServerExposure from "../DesktopServerExposure.ts";
import {
  decorateAdvertisedEndpoints,
  DesktopTailscaleServeSetupError,
  NETWORK_ACCESS_REQUIRED_MESSAGE,
  wrap,
} from "./DesktopServerExposureWithTailscale.ts";
import type * as TailscaleServeReconciler from "./TailscaleServeReconciler.ts";

const desktopProvider = {
  id: "desktop-core",
  label: "Desktop",
  kind: "core",
  isAddon: false,
} as const;
const tailscaleProvider = {
  id: "tailscale",
  label: "Tailscale",
  kind: "private-network",
  isAddon: true,
} as const;

const loopback = createAdvertisedEndpoint({
  id: "desktop-loopback:3773",
  label: "This machine",
  provider: desktopProvider,
  httpBaseUrl: "http://127.0.0.1:3773",
  reachability: "loopback",
  source: "desktop-core",
});
const lan = createAdvertisedEndpoint({
  id: "desktop-lan:http://192.168.1.20:3773",
  label: "Local network",
  provider: desktopProvider,
  httpBaseUrl: "http://192.168.1.20:3773",
  reachability: "lan",
  source: "desktop-core",
  isDefault: true,
});
const manual = createAdvertisedEndpoint({
  id: "manual:https://public.example.test",
  label: "Custom HTTPS",
  provider: { id: "manual", label: "Manual", kind: "manual", isAddon: false },
  httpBaseUrl: "https://public.example.test",
  reachability: "public",
  source: "user",
  status: "unknown",
});
const tailscaleIp = createAdvertisedEndpoint({
  id: "tailscale-ip:http://100.90.1.2:3773",
  label: "Tailscale IP",
  provider: tailscaleProvider,
  httpBaseUrl: "http://100.90.1.2:3773",
  reachability: "private-network",
  source: "desktop-addon",
});
const magicDns = createAdvertisedEndpoint({
  id: "tailscale-magicdns:https://desktop.tail.ts.net/",
  label: "Tailscale HTTPS",
  provider: tailscaleProvider,
  httpBaseUrl: "https://desktop.tail.ts.net/",
  reachability: "private-network",
  source: "desktop-addon",
  hostedHttpsCompatibility: "compatible",
  status: "available",
  description: "HTTPS endpoint served by Tailscale Serve.",
});

// Upstream's order: core endpoints, manual, then the Tailscale add-on.
const upstreamOrder: readonly AdvertisedEndpoint[] = [loopback, lan, manual, tailscaleIp, magicDns];

const owned: TailscaleServeReconciler.TailscaleServeObservation = {
  phase: "owned",
  baseUrl: "https://desktop.tail.ts.net/",
};
const conflict: TailscaleServeReconciler.TailscaleServeObservation = {
  phase: "conflict",
  baseUrl: "https://desktop.tail.ts.net/",
  occupant: { _tag: "proxy", target: "http://127.0.0.1:8081" },
};

const networkState: DesktopServerExposureState = {
  mode: "network-accessible",
  endpointUrl: "http://192.168.1.20:3773",
  advertisedHost: "192.168.1.20",
  tailscaleServeEnabled: false,
  tailscaleServePort: 443,
};
const localOnlyState: DesktopServerExposureState = {
  mode: "local-only",
  endpointUrl: null,
  advertisedHost: null,
  tailscaleServeEnabled: false,
  tailscaleServePort: 443,
};

interface StubCalls {
  clearOwnMapping: number;
}

/**
 * A base exposure whose state lives in a Ref, plus a reconciler that answers
 * with a fixed observation, both recording what the wrapper asked of them.
 */
const makeStubs = (input: {
  readonly state: DesktopServerExposureState;
  readonly observation: TailscaleServeReconciler.TailscaleServeObservation;
  readonly endpoints?: readonly AdvertisedEndpoint[];
}) =>
  Effect.gen(function* () {
    const stateRef = yield* Ref.make(input.state);
    const calls: StubCalls = { clearOwnMapping: 0 };

    const base: DesktopServerExposure.DesktopServerExposure["Service"] = {
      getState: Ref.get(stateRef),
      backendConfig: Effect.die("unexpected backendConfig"),
      configureFromSettings: () => Effect.die("unexpected configureFromSettings"),
      setMode: (mode) =>
        Ref.updateAndGet(stateRef, (state) => ({ ...state, mode })).pipe(
          Effect.map((state) => ({ state, requiresRelaunch: true })),
        ),
      setTailscaleServeEnabled: (setInput) =>
        Effect.gen(function* () {
          const state = yield* Ref.updateAndGet(stateRef, (state) => ({
            ...state,
            tailscaleServeEnabled: setInput.enabled,
            tailscaleServePort: setInput.port ?? state.tailscaleServePort,
          }));
          return { state, requiresRelaunch: true };
        }),
      getAdvertisedEndpoints: Effect.succeed(input.endpoints ?? upstreamOrder),
    };

    const reconciler: TailscaleServeReconciler.TailscaleServeReconciler["Service"] = {
      getObservation: Effect.succeed(input.observation),
      reconcileNow: () => Effect.succeed(input.observation),
      requestReconcile: Effect.void,
      clearOwnMapping: Effect.sync(() => {
        calls.clearOwnMapping += 1;
        return "cleared" as const;
      }),
    };

    return { exposure: wrap(base, reconciler), calls };
  });

describe("DesktopServerExposureWithTailscale", () => {
  it.effect("moves tailnet IPs ahead of the LAN endpoint and makes the first one the default", () =>
    Effect.sync(() => {
      const endpoints = decorateAdvertisedEndpoints({
        endpoints: upstreamOrder,
        networkAccessible: true,
        observation: owned,
      });
      assert.deepEqual(
        endpoints.map((endpoint) => endpoint.id),
        [loopback.id, tailscaleIp.id, lan.id, manual.id, magicDns.id],
      );
      // The pairing picker honors isDefault before list order, so upstream's
      // flag on the LAN entry has to move.
      assert.deepEqual(
        endpoints.map((endpoint) => endpoint.isDefault),
        [false, true, false, false, false],
      );
    }),
  );

  it.effect("leaves upstream's default alone when there is no tailnet IP", () =>
    Effect.sync(() => {
      const endpoints = decorateAdvertisedEndpoints({
        endpoints: [loopback, lan, manual],
        networkAccessible: true,
        observation: { phase: "idle", reason: "serve-disabled" },
      });
      assert.deepEqual(
        endpoints.map((endpoint) => endpoint.isDefault),
        [loopback.isDefault, true, manual.isDefault],
      );
    }),
  );

  it.effect("drops tailnet IPs while the server only listens on loopback", () =>
    Effect.sync(() => {
      const endpoints = decorateAdvertisedEndpoints({
        endpoints: [loopback, tailscaleIp, magicDns],
        networkAccessible: false,
        observation: { phase: "idle", reason: "local-only" },
      });
      assert.deepEqual(
        endpoints.map((endpoint) => endpoint.id),
        [loopback.id, magicDns.id],
      );
    }),
  );

  it.effect("reports the MagicDNS endpoint from the reconciler's verdict", () =>
    Effect.sync(() => {
      const [asOwned] = decorateAdvertisedEndpoints({
        endpoints: [magicDns],
        networkAccessible: true,
        observation: owned,
      });
      assert.equal(asOwned?.status, "available");
      assert.equal(asOwned?.compatibility.hostedHttpsApp, "compatible");

      // Upstream's 2xx probe would have called this available: the occupant
      // answers, just not for us.
      const [asConflict] = decorateAdvertisedEndpoints({
        endpoints: [magicDns],
        networkAccessible: true,
        observation: conflict,
      });
      assert.equal(asConflict?.status, "unavailable");
      assert.equal(asConflict?.compatibility.hostedHttpsApp, "requires-configuration");
      assert.include(asConflict?.description, "http://127.0.0.1:8081");

      const [asHandlerConflict] = decorateAdvertisedEndpoints({
        endpoints: [magicDns],
        networkAccessible: true,
        observation: { ...conflict, occupant: { _tag: "handler" } },
      });
      assert.equal(
        asHandlerConflict?.description,
        "Another Tailscale Serve handler already uses this port.",
      );
    }),
  );

  it.effect("refuses to enable Tailscale HTTPS while local-only", () =>
    Effect.gen(function* () {
      const { exposure } = yield* makeStubs({ state: localOnlyState, observation: owned });
      const error = yield* exposure.setTailscaleServeEnabled({ enabled: true }).pipe(Effect.flip);
      assert.instanceOf(error, DesktopServerExposure.DesktopTailscaleServePersistenceError);
      assert.instanceOf(error, DesktopTailscaleServeSetupError);
      assert.equal(error.message, NETWORK_ACCESS_REQUIRED_MESSAGE);
      assert.equal((yield* exposure.getState).tailscaleServeEnabled, false);
    }),
  );

  it.effect("persists, reclaims the mapping, and skips the relaunch on enable", () =>
    Effect.gen(function* () {
      const { exposure } = yield* makeStubs({ state: networkState, observation: owned });
      const change = yield* exposure.setTailscaleServeEnabled({ enabled: true, port: 443 });
      assert.equal(change.requiresRelaunch, false);
      assert.equal(change.state.tailscaleServeEnabled, true);
    }),
  );

  it.effect("fails enable with the reconciler's reason when the mapping is not ours", () =>
    Effect.gen(function* () {
      const { exposure } = yield* makeStubs({
        state: networkState,
        observation: {
          phase: "error",
          baseUrl: "https://desktop.tail.ts.net/",
          message: "HTTPS is not enabled for this tailnet.",
          diagnostic: "serve-not-enabled",
        },
      });
      const error = yield* exposure.setTailscaleServeEnabled({ enabled: true }).pipe(Effect.flip);
      assert.equal(error.message, "HTTPS is not enabled for this tailnet.");
      assert.equal(error.enabled, true);
    }),
  );

  it.effect("clears only our own mapping on disable without relaunching", () =>
    Effect.gen(function* () {
      const { exposure, calls } = yield* makeStubs({
        state: { ...networkState, tailscaleServeEnabled: true },
        observation: owned,
      });
      const change = yield* exposure.setTailscaleServeEnabled({ enabled: false });
      assert.equal(change.requiresRelaunch, false);
      assert.equal(change.state.tailscaleServeEnabled, false);
      assert.equal(calls.clearOwnMapping, 1);
    }),
  );

  it.effect("clears our mapping when switching to local-only with serve on", () =>
    Effect.gen(function* () {
      const { exposure, calls } = yield* makeStubs({
        state: { ...networkState, tailscaleServeEnabled: true },
        observation: owned,
      });
      yield* exposure.setMode("network-accessible");
      assert.equal(calls.clearOwnMapping, 0);
      const change = yield* exposure.setMode("local-only");
      assert.equal(change.state.mode, "local-only");
      assert.equal(calls.clearOwnMapping, 1);
    }),
  );
});
