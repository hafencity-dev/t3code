import type { AdvertisedEndpoint } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as DesktopServerExposure from "../DesktopServerExposure.ts";
import * as TailscaleServeReconciler from "./TailscaleServeReconciler.ts";

/**
 * Wraps upstream's DesktopServerExposure so the desktop owns Tailscale Serve
 * (see TailscaleServeReconciler.ts). Everything not listed here is upstream's
 * implementation untouched; main.ts swaps this layer in for the upstream one.
 */

const TAILSCALE_IP_ENDPOINT_PREFIX = "tailscale-ip:";
const TAILSCALE_MAGICDNS_ENDPOINT_PREFIX = "tailscale-magicdns:";
const DESKTOP_LAN_ENDPOINT_PREFIX = "desktop-lan:";

export const NETWORK_ACCESS_REQUIRED_MESSAGE =
  "Turn on network access first. Tailscale HTTPS needs the server reachable off-loopback.";

/**
 * Why Setup or Disable could not finish, in a sentence the user can act on.
 *
 * The service interface pins setTailscaleServeEnabled's failure to upstream's
 * DesktopTailscaleServePersistenceError, which requires a settings write error
 * as its cause. Setup failures here have nothing to do with settings, so the
 * required cause is an obviously synthetic write error whose own cause is a
 * plain Error carrying the detail, and that detail is the message the
 * renderer toasts.
 */
export class DesktopTailscaleServeSetupError
  extends DesktopServerExposure.DesktopTailscaleServePersistenceError
{
  static create(input: {
    readonly enabled: boolean;
    readonly port: number | null;
    readonly detail: string;
    readonly cause?: unknown;
  }): DesktopTailscaleServeSetupError {
    return new DesktopTailscaleServeSetupError({
      enabled: input.enabled,
      port: input.port,
      cause: new DesktopAppSettings.DesktopSettingsWriteError({
        operation: "replace-settings-file",
        path: "fork:tailscale-serve",
        cause: new Error(input.detail, input.cause === undefined ? {} : { cause: input.cause }),
      }),
    });
  }

  override get message(): string {
    const detail = this.cause.cause;
    return detail instanceof Error ? detail.message : super.message;
  }
}

const describeOccupant = (occupant: TailscaleServeReconciler.TailscaleServeOccupant): string => {
  switch (occupant._tag) {
    case "proxy":
      return `Tailscale Serve on this port already points at ${occupant.target}.`;
    case "handler":
      return "Another Tailscale Serve handler already uses this port.";
    case "unknown":
      return "Something else answers on this Tailscale hostname. Check for a foreground `tailscale serve` session.";
  }
};

const describeObservation = (
  observation: TailscaleServeReconciler.TailscaleServeObservation,
): string => {
  switch (observation.phase) {
    case "owned":
      return "Tailscale HTTPS is serving this app.";
    case "conflict":
      return describeOccupant(observation.occupant);
    case "error":
      return observation.message;
    case "idle":
      switch (observation.reason) {
        case "port-unknown":
        case "server-unreachable":
          return "The desktop server is not answering yet. Wait a moment and try again.";
        case "serve-disabled":
          return "Tailscale HTTPS is turned off.";
        case "local-only":
          return NETWORK_ACCESS_REQUIRED_MESSAGE;
      }
  }
};

/**
 * Reorders and re-labels upstream's endpoint list: tailnet IPs are dropped
 * when the server only listens on loopback, moved ahead of the LAN entry and
 * made the default so the QR lands on the address that works away from home
 * (the pairing picker honors `isDefault` before list order; an explicitly
 * saved user choice still wins), and the MagicDNS row reports what the
 * reconciler actually verified rather than a 2xx from whoever answers there.
 */
export const decorateAdvertisedEndpoints = (input: {
  readonly endpoints: readonly AdvertisedEndpoint[];
  readonly networkAccessible: boolean;
  readonly observation: TailscaleServeReconciler.TailscaleServeObservation;
}): readonly AdvertisedEndpoint[] => {
  const tailscaleIpEndpoints = input.networkAccessible
    ? input.endpoints.filter((endpoint) => endpoint.id.startsWith(TAILSCALE_IP_ENDPOINT_PREFIX))
    : [];
  const rest = input.endpoints.filter(
    (endpoint) => !endpoint.id.startsWith(TAILSCALE_IP_ENDPOINT_PREFIX),
  );
  const lanIndex = rest.findIndex((endpoint) =>
    endpoint.id.startsWith(DESKTOP_LAN_ENDPOINT_PREFIX),
  );
  const ordered =
    lanIndex === -1
      ? [...rest, ...tailscaleIpEndpoints]
      : [...rest.slice(0, lanIndex), ...tailscaleIpEndpoints, ...rest.slice(lanIndex)];
  const defaultId = tailscaleIpEndpoints[0]?.id;

  const owned = input.observation.phase === "owned";
  return ordered.map((endpoint) => {
    const withDefault =
      defaultId === undefined ? endpoint : { ...endpoint, isDefault: endpoint.id === defaultId };
    return withDefault.id.startsWith(TAILSCALE_MAGICDNS_ENDPOINT_PREFIX)
      ? {
          ...withDefault,
          status: owned ? "available" : "unavailable",
          compatibility: {
            ...withDefault.compatibility,
            hostedHttpsApp: owned ? "compatible" : "requires-configuration",
          },
          description: owned
            ? "HTTPS endpoint served by Tailscale Serve."
            : describeObservation(input.observation),
        }
      : withDefault;
  });
};

export const wrap = (
  base: DesktopServerExposure.DesktopServerExposure["Service"],
  reconciler: TailscaleServeReconciler.TailscaleServeReconciler["Service"],
): DesktopServerExposure.DesktopServerExposure["Service"] => {
  const getAdvertisedEndpoints = Effect.gen(function* () {
    const endpoints = yield* base.getAdvertisedEndpoints;
    const state = yield* base.getState;
    const observation = yield* reconciler.getObservation;
    return decorateAdvertisedEndpoints({
      endpoints,
      networkAccessible: state.mode === "network-accessible",
      observation,
    });
  });

  // The port becomes known here, after the reconciler's first pass already
  // ran against port 0; do not wait for the retry tick.
  const configureFromSettings = (input: { readonly port: number }) =>
    base.configureFromSettings(input).pipe(Effect.tap(() => reconciler.requestReconcile));

  const setTailscaleServeEnabled = Effect.fn(
    "desktop.serverExposure.fork.setTailscaleServeEnabled",
  )(function* (input: { readonly enabled: boolean; readonly port?: number }) {
    const port = input.port ?? null;
    if (input.enabled) {
      const state = yield* base.getState;
      if (state.mode !== "network-accessible") {
        return yield* DesktopTailscaleServeSetupError.create({
          enabled: true,
          port,
          detail: NETWORK_ACCESS_REQUIRED_MESSAGE,
        });
      }
      const change = yield* base.setTailscaleServeEnabled(input);
      // The user clicked Setup: that is the consent to take over whatever
      // Serve currently maps on this port.
      const observation = yield* reconciler.reconcileNow({ reclaim: true });
      if (observation.phase !== "owned") {
        return yield* DesktopTailscaleServeSetupError.create({
          enabled: true,
          port,
          detail: describeObservation(observation),
        });
      }
      return { state: change.state, requiresRelaunch: false };
    }

    const change = yield* base.setTailscaleServeEnabled(input);
    yield* reconciler.clearOwnMapping.pipe(
      Effect.mapError((cause) =>
        DesktopTailscaleServeSetupError.create({
          enabled: false,
          port,
          detail: `Tailscale HTTPS is turned off, but removing the Serve mapping failed: ${cause.message}`,
          cause,
        }),
      ),
    );
    return { state: change.state, requiresRelaunch: false };
  });

  const setMode = Effect.fn("desktop.serverExposure.fork.setMode")(function* (
    mode: Parameters<typeof base.setMode>[0],
  ) {
    const change = yield* base.setMode(mode);
    if (!change.state.tailscaleServeEnabled) {
      return change;
    }
    if (mode === "local-only") {
      // Loopback-only servers cannot be paired through MagicDNS, so a mapping
      // of ours would only front a dead end. A failure here is not worth
      // blocking the mode change; the reconciler stays idle in local-only.
      // Only the classified reason is logged: the CLI message may quote a
      // consent URL that identifies this node.
      yield* reconciler.clearOwnMapping.pipe(
        Effect.catch((error) =>
          Effect.logWarning("tailscale serve mapping not cleared on local-only switch").pipe(
            Effect.annotateLogs({ reason: error.reason, diagnostic: error.diagnostic ?? null }),
          ),
        ),
      );
    } else {
      yield* reconciler.requestReconcile;
    }
    return change;
  });

  return DesktopServerExposure.DesktopServerExposure.of({
    ...base,
    configureFromSettings,
    setMode,
    setTailscaleServeEnabled,
    getAdvertisedEndpoints,
  });
};

export const make = Effect.gen(function* () {
  const base = yield* DesktopServerExposure.make;
  const reconciler = yield* TailscaleServeReconciler.make({
    readExposure: Effect.all([base.getState, base.backendConfig]).pipe(
      Effect.map(([state, config]) => ({
        port: config.port,
        mode: state.mode,
        serveEnabled: state.tailscaleServeEnabled,
        servePort: state.tailscaleServePort,
      })),
    ),
  });
  return wrap(base, reconciler);
});

export const layer = Layer.effect(DesktopServerExposure.DesktopServerExposure, make);
