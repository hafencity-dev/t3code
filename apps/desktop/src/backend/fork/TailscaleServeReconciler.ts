import { ExecutionEnvironmentDescriptor, type DesktopServerExposureMode } from "@t3tools/contracts";
import { buildTailscaleHttpsBaseUrl } from "@t3tools/tailscale";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  isOwnServeTarget,
  makeTailscaleServeCli,
  TAILSCALE_LOOPBACK_HOST,
  type TailscaleServeCliDiagnostic,
  type TailscaleServeCliError,
} from "./tailscaleServeCli.ts";

/**
 * The desktop app, not the server child, owns the Tailscale Serve mapping.
 *
 * Serve config is global per node and last-write-wins: any other tool that
 * runs `tailscale serve` (another dev server, `t3 pair --tailscale` for a
 * different checkout) silently replaces our mapping, and the server child
 * only ever applied it once at startup, so nobody noticed until a phone
 * failed to connect. Electron main already has the CLI, HTTP client and
 * settings, so it re-checks the mapping every minute and repairs it when it
 * is missing or provably stale.
 *
 * A mapping whose occupant still answers is never overwritten automatically.
 * The occupant may be someone else's live service, and clobbering it is
 * exactly the defect this module exists to stop; only an explicit user action
 * passes `reclaim: true`. For the same reason the layer never runs `serve off`
 * when its scope closes: a stale mapping of our own is reclaimed on next
 * launch, while a foreign one is not ours to remove.
 *
 * CLI spawns are kept rare because each one can re-trigger macOS's "Other
 * apps" prompt for the App Store Tailscale build: the identity check is pure
 * HTTP, the MagicDNS name is cached, and the Serve config is only re-read when
 * the probes change their answer.
 */

export const TAILSCALE_SERVE_RECONCILE_INTERVAL = Duration.seconds(60);
/** Used while nothing can be decided yet (port unknown, server not answering); no CLI runs in those states. */
export const TAILSCALE_SERVE_RETRY_INTERVAL = Duration.seconds(5);
/** Upper bound between `serve status` reads while the probes keep giving the same answer. */
export const TAILSCALE_SERVE_RECLASSIFY_INTERVAL = Duration.minutes(10);
/** How long a `tailscale status` result (name, missing name, or failure) is reused while not serving. */
export const TAILSCALE_STATUS_CACHE_TTL = Duration.minutes(5);
const DESCRIPTOR_PROBE_TIMEOUT = Duration.millis(2_500);
const RECONCILE_TIMEOUT = Duration.seconds(30);
const WELL_KNOWN_ENVIRONMENT_PATH = "/.well-known/t3/environment";

export interface TailscaleServeExposure {
  readonly port: number;
  readonly mode: DesktopServerExposureMode;
  readonly serveEnabled: boolean;
  readonly servePort: number;
}

export type TailscaleServeIdleReason =
  | "port-unknown"
  | "serve-disabled"
  | "local-only"
  | "server-unreachable";

/**
 * Who holds the Serve port instead of us. `proxy` is a reverse proxy to another
 * local service, `handler` a non-proxy Serve handler (static path, text), and
 * `unknown` something that answers on the hostname while `serve status` lists
 * nothing, which is what a foreground `tailscale serve` session looks like.
 */
export type TailscaleServeOccupant =
  | { readonly _tag: "proxy"; readonly target: string }
  | { readonly _tag: "handler" }
  | { readonly _tag: "unknown" };

export type TailscaleServeObservation =
  | { readonly phase: "idle"; readonly reason: TailscaleServeIdleReason }
  | { readonly phase: "owned"; readonly baseUrl: string }
  | {
      readonly phase: "conflict";
      readonly baseUrl: string;
      readonly occupant: TailscaleServeOccupant;
    }
  | {
      readonly phase: "error";
      readonly baseUrl: string | null;
      readonly message: string;
      readonly diagnostic?: TailscaleServeCliDiagnostic;
      readonly consentUrl?: string;
    };

export type TailscaleServeClearResult = "cleared" | "not-ours" | "none";

export class TailscaleServeReconciler extends Context.Service<
  TailscaleServeReconciler,
  {
    readonly getObservation: Effect.Effect<TailscaleServeObservation>;
    readonly reconcileNow: (options?: {
      readonly reclaim?: boolean;
    }) => Effect.Effect<TailscaleServeObservation>;
    /** Runs a pass in the background, for callers that changed the inputs and must not block on it. */
    readonly requestReconcile: Effect.Effect<void>;
    /** Removes the Serve mapping only when it proxies to this app's server. */
    readonly clearOwnMapping: Effect.Effect<TailscaleServeClearResult, TailscaleServeCliError>;
  }
>()("@t3tools/desktop/backend/fork/TailscaleServeReconciler") {}

// `unreachable` is a transport failure before any byte arrived (refused,
// reset, no listener); `timeout` is a socket that opened or stalled, which a
// dev server mid-compile does. Only the former proves nothing is listening.
type DescriptorProbe =
  | { readonly _tag: "descriptor"; readonly descriptor: ExecutionEnvironmentDescriptor }
  | { readonly _tag: "unreachable" }
  | { readonly _tag: "timeout" }
  | { readonly _tag: "answered"; readonly status: number };

const UNREACHABLE: DescriptorProbe = { _tag: "unreachable" };
const TIMEOUT: DescriptorProbe = { _tag: "timeout" };

// Same outcomes as `t3 pair --tailscale`: a descriptor, nothing live, or some
// other service answering. The bad-gateway family is reported as answered
// with its status so callers can tell "Serve fronts a backend that is gone"
// apart from "a local service answered 502 itself".
const probeDescriptor = (
  baseUrl: string,
): Effect.Effect<DescriptorProbe, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    // A target the CLI echoed that is not a URL cannot be shown absent, so it
    // counts as answering rather than as a defect.
    const url = yield* Effect.try({
      try: () => new URL(WELL_KNOWN_ENVIRONMENT_PATH, baseUrl).toString(),
      catch: (): DescriptorProbe => ({ _tag: "answered", status: 0 }),
    });
    const response = yield* client
      .execute(HttpClientRequest.get(url))
      .pipe(Effect.mapError(() => UNREACHABLE));
    const answered: DescriptorProbe = { _tag: "answered", status: response.status };
    const descriptor = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
      Effect.mapError(() => answered),
    );
    return { _tag: "descriptor", descriptor } as const;
  }).pipe(
    // Covers the body read as well as the connect: a socket that opens and
    // then stalls must not hold the reconcile mutex.
    Effect.timeout(DESCRIPTOR_PROBE_TIMEOUT),
    Effect.catchTag("TimeoutError", () => Effect.succeed(TIMEOUT)),
    Effect.catch((outcome) => Effect.succeed(outcome)),
  );

const isGatewayFailure = (probe: DescriptorProbe): boolean =>
  probe._tag === "answered" &&
  (probe.status === 502 || probe.status === 503 || probe.status === 504);

/** True when something other than a dead upstream answered the hostname. */
const isLiveAnswer = (probe: DescriptorProbe): boolean =>
  probe._tag === "descriptor" || (probe._tag === "answered" && !isGatewayFailure(probe));

const probeKey = (probe: DescriptorProbe): string => {
  switch (probe._tag) {
    case "descriptor":
      return `descriptor:${probe.descriptor.environmentId}`;
    case "answered":
      return `answered:${probe.status}`;
    case "unreachable":
      return "unreachable";
    case "timeout":
      return "timeout";
  }
};

const errorObservation = (
  baseUrl: string | null,
  error: TailscaleServeCliError,
): TailscaleServeObservation => ({
  phase: "error",
  baseUrl,
  message: error.message,
  ...(error.diagnostic === undefined ? {} : { diagnostic: error.diagnostic }),
  ...(error.consentUrl === undefined ? {} : { consentUrl: error.consentUrl }),
});

const isPending = (observation: TailscaleServeObservation): boolean =>
  observation.phase === "idle" &&
  (observation.reason === "port-unknown" || observation.reason === "server-unreachable");

type MagicDnsLookup =
  | { readonly _tag: "ok"; readonly name: string | null }
  | { readonly _tag: "failed"; readonly error: TailscaleServeCliError };

interface Classification {
  /** Probe answers the verdict was based on; the same answers next tick mean nothing changed. */
  readonly key: string;
  readonly at: number;
}

export const make = Effect.fn("desktop.tailscaleServe.reconciler.make")(function* (input: {
  readonly readExposure: Effect.Effect<TailscaleServeExposure>;
}) {
  const cli = yield* makeTailscaleServeCli;
  const httpClient = yield* HttpClient.HttpClient;
  const scope = yield* Effect.scope;
  const observationRef = yield* Ref.make<TailscaleServeObservation>({
    phase: "idle",
    reason: "port-unknown",
  });
  const magicDnsRef = yield* Ref.make<{
    readonly lookup: MagicDnsLookup;
    readonly at: number;
  } | null>(null);
  const classificationRef = yield* Ref.make<Classification | null>(null);
  const mutex = yield* Semaphore.make(1);

  // While the mapping is verified ours the name is pinned: it only changes on
  // a rename, which the probe notices as a lost identity, and that drops us
  // out of `owned` so the TTL takes over and the name gets re-read.
  const readMagicDnsName = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const cached = yield* Ref.get(magicDnsRef);
    if (cached !== null) {
      const previous = yield* Ref.get(observationRef);
      const pinned =
        previous.phase === "owned" && cached.lookup._tag === "ok" && cached.lookup.name !== null;
      if (pinned || now - cached.at < Duration.toMillis(TAILSCALE_STATUS_CACHE_TTL)) {
        return cached.lookup;
      }
    }
    const lookup: MagicDnsLookup = yield* cli.readStatus.pipe(
      Effect.map((status) => ({ _tag: "ok", name: status.magicDnsName }) as const),
      Effect.catch((error) => Effect.succeed({ _tag: "failed", error } as const)),
    );
    yield* Ref.set(magicDnsRef, { lookup, at: now });
    return lookup;
  });

  const probe = (baseUrl: string) =>
    probeDescriptor(baseUrl).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));

  const apply = (baseUrl: string, exposure: TailscaleServeExposure) =>
    cli.applyServe({ localPort: exposure.port, servePort: exposure.servePort }).pipe(
      Effect.map((): TailscaleServeObservation => ({ phase: "owned", baseUrl })),
      Effect.catch((error) => Effect.succeed(errorObservation(baseUrl, error))),
    );

  // Reads the Serve config (one CLI spawn) and decides. Writing is allowed
  // only when nothing live answers on the hostname AND nothing answers at the
  // occupant's own target, or when the user explicitly asked to reclaim.
  // Returns the occupant probe it took, if any, so the caller can key the
  // verdict without asking the same target twice.
  const classify = Effect.fn("desktop.tailscaleServe.reconciler.classify")(function* (input: {
    readonly baseUrl: string;
    readonly exposure: TailscaleServeExposure;
    readonly remote: DescriptorProbe;
    readonly reclaim: boolean;
  }): Effect.fn.Return<{
    readonly observation: TailscaleServeObservation;
    readonly occupantProbe: DescriptorProbe | null;
  }> {
    const { baseUrl, exposure, remote, reclaim } = input;
    const verdict = (
      observation: TailscaleServeObservation,
      occupantProbe: DescriptorProbe | null = null,
    ) => ({ observation, occupantProbe }) as const;
    const conflict = (occupant: TailscaleServeOccupant, occupantProbe?: DescriptorProbe) =>
      verdict({ phase: "conflict", baseUrl, occupant }, occupantProbe);
    const mapping = yield* cli.readServeConfig(exposure.servePort).pipe(
      Effect.map((value) => ({ _tag: "ok", value }) as const),
      Effect.catch((error) => Effect.succeed({ _tag: "failed", error } as const)),
    );
    if (mapping._tag === "failed") {
      return verdict(errorObservation(baseUrl, mapping.error));
    }
    if (mapping.value._tag === "proxy" && isOwnServeTarget(mapping.value.target, exposure.port)) {
      return verdict({ phase: "owned", baseUrl });
    }
    if (reclaim) {
      return verdict(yield* apply(baseUrl, exposure));
    }
    if (isLiveAnswer(remote)) {
      // Whatever `serve status` says, something else is being served under
      // our hostname (a foreground session does not show up under `Web`).
      switch (mapping.value._tag) {
        case "proxy":
          return conflict({ _tag: "proxy", target: mapping.value.target });
        case "other":
          return conflict({ _tag: "handler" });
        case "none":
          return conflict({ _tag: "unknown" });
      }
    }
    switch (mapping.value._tag) {
      case "none":
        return verdict(yield* apply(baseUrl, exposure));
      case "other":
        return conflict({ _tag: "handler" });
      case "proxy": {
        // The hostname is silent or reports a dead upstream. That alone is not
        // proof: Serve may simply be down. Ask the occupant directly, and only
        // a refused connection makes the mapping stale; a slow answer is still
        // an answer.
        const occupant = yield* probe(mapping.value.target);
        return occupant._tag === "unreachable"
          ? verdict(yield* apply(baseUrl, exposure), occupant)
          : conflict({ _tag: "proxy", target: mapping.value.target }, occupant);
      }
    }
  });

  const reconcile = Effect.fn("desktop.tailscaleServe.reconcile")(function* (options: {
    readonly reclaim: boolean;
  }): Effect.fn.Return<TailscaleServeObservation> {
    const settle = (observation: TailscaleServeObservation) =>
      Ref.set(classificationRef, null).pipe(Effect.as(observation));
    const exposure = yield* input.readExposure;
    yield* Effect.annotateCurrentSpan({
      reclaim: options.reclaim,
      port: exposure.port,
      mode: exposure.mode,
      serveEnabled: exposure.serveEnabled,
    });
    if (exposure.port === 0) return yield* settle({ phase: "idle", reason: "port-unknown" });
    if (!exposure.serveEnabled) return yield* settle({ phase: "idle", reason: "serve-disabled" });
    if (exposure.mode !== "network-accessible") {
      return yield* settle({ phase: "idle", reason: "local-only" });
    }

    const magicDns = yield* readMagicDnsName;
    if (magicDns._tag === "failed") {
      return yield* settle(errorObservation(null, magicDns.error));
    }
    if (magicDns.name === null) {
      return yield* settle({
        phase: "error",
        baseUrl: null,
        message:
          "Tailscale reported no MagicDNS name for this machine. Check that MagicDNS is enabled for your tailnet.",
      });
    }
    const baseUrl = buildTailscaleHttpsBaseUrl({
      magicDnsName: magicDns.name,
      servePort: exposure.servePort,
    });

    // Identity check first: it needs no CLI spawn and settles the common
    // case. Only a mismatch or a silent endpoint reads the Serve config.
    const previous = yield* Ref.get(observationRef);
    const occupantTarget =
      previous.phase === "conflict" && previous.occupant._tag === "proxy"
        ? previous.occupant.target
        : null;
    const [local, remote, occupant] = yield* Effect.all(
      [
        probe(`http://${TAILSCALE_LOOPBACK_HOST}:${exposure.port}`),
        probe(baseUrl),
        occupantTarget === null ? Effect.succeed(UNREACHABLE) : probe(occupantTarget),
      ],
      { concurrency: "unbounded" },
    );
    if (local._tag !== "descriptor") {
      // Without our own descriptor there is no identity to compare against,
      // and no basis to touch a mapping; the next tick retries.
      return yield* settle({ phase: "idle", reason: "server-unreachable" });
    }
    if (
      remote._tag === "descriptor" &&
      remote.descriptor.environmentId === local.descriptor.environmentId
    ) {
      return yield* settle({ phase: "owned", baseUrl });
    }

    // Same probe answers as the last verdict mean nothing changed; the
    // verdict stands without spawning `serve status` again, for a bounded
    // time so a fix made purely on the Serve side is still picked up.
    const now = yield* Clock.currentTimeMillis;
    const keyFor = (target: string | null, targetProbe: DescriptorProbe) =>
      [probeKey(local), probeKey(remote), target ?? "", probeKey(targetProbe)].join("|");
    const last = yield* Ref.get(classificationRef);
    if (
      !options.reclaim &&
      last !== null &&
      last.key === keyFor(occupantTarget, occupant) &&
      now - last.at < Duration.toMillis(TAILSCALE_SERVE_RECLASSIFY_INTERVAL)
    ) {
      return previous;
    }
    const classified = yield* classify({ baseUrl, exposure, remote, reclaim: options.reclaim });
    const { observation } = classified;
    // Record the key the next tick will compute, which includes the occupant
    // the verdict just named.
    const namedTarget =
      observation.phase === "conflict" && observation.occupant._tag === "proxy"
        ? observation.occupant.target
        : null;
    const namedProbe =
      namedTarget === null
        ? UNREACHABLE
        : (classified.occupantProbe ??
          (namedTarget === occupantTarget ? occupant : yield* probe(namedTarget)));
    yield* Ref.set(classificationRef, { key: keyFor(namedTarget, namedProbe), at: now });
    return observation;
  });

  const reconcileAndRecord = (options: { readonly reclaim: boolean }) =>
    mutex.withPermits(1)(
      reconcile(options).pipe(
        Effect.timeout(RECONCILE_TIMEOUT),
        Effect.catchTag("TimeoutError", (): Effect.Effect<TailscaleServeObservation> =>
          Effect.succeed({
            phase: "error",
            baseUrl: null,
            message: "Checking Tailscale Serve did not finish in time.",
          }),
        ),
        Effect.tap((observation) =>
          Effect.gen(function* () {
            const previous = yield* Ref.getAndSet(observationRef, observation);
            if (previous.phase !== observation.phase) {
              yield* Effect.logInfo("tailscale serve reconciled").pipe(
                Effect.annotateLogs({ phase: observation.phase, previousPhase: previous.phase }),
              );
            }
          }),
        ),
      ),
    );

  const clearOwnMapping = Effect.gen(function* () {
    const exposure = yield* input.readExposure;
    const mapping = yield* cli.readServeConfig(exposure.servePort);
    if (mapping._tag === "none") return "none" as const;
    if (mapping._tag === "other" || !isOwnServeTarget(mapping.target, exposure.port)) {
      return "not-ours" as const;
    }
    yield* cli.clearServe({ servePort: exposure.servePort });
    yield* Ref.set(observationRef, { phase: "idle", reason: "serve-disabled" });
    yield* Ref.set(classificationRef, null);
    return "cleared" as const;
  }).pipe(Effect.withSpan("desktop.tailscaleServe.clearOwnMapping"));

  const requestReconcile = Effect.forkIn(reconcileAndRecord({ reclaim: false }), scope).pipe(
    Effect.asVoid,
  );

  // The first pass runs before the layer finishes building, so callers that
  // read the observation right after construction see a real verdict. A
  // defect in one pass is logged and the loop carries on.
  const loop = Effect.gen(function* () {
    while (true) {
      const observation = yield* reconcileAndRecord({ reclaim: false }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("tailscale serve reconcile failed", cause).pipe(
            Effect.andThen(Ref.get(observationRef)),
          ),
        ),
      );
      yield* Effect.sleep(
        isPending(observation)
          ? TAILSCALE_SERVE_RETRY_INTERVAL
          : TAILSCALE_SERVE_RECONCILE_INTERVAL,
      );
    }
  });
  yield* Effect.forkScoped(loop, { startImmediately: true });

  return TailscaleServeReconciler.of({
    getObservation: Ref.get(observationRef),
    reconcileNow: (options) => reconcileAndRecord({ reclaim: options?.reclaim === true }),
    requestReconcile,
    clearOwnMapping: mutex.withPermits(1)(clearOwnMapping),
  });
});
