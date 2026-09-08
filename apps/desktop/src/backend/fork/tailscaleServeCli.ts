import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  parseTailscaleStatus,
  TAILSCALE_STATUS_TIMEOUT,
  type TailscaleStatus,
} from "@t3tools/tailscale";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

/**
 * Desktop-owned `tailscale` CLI access for Serve. Mirrors the spawn and
 * stderr-handling rules of `@t3tools/tailscale` (never surface raw CLI text,
 * only classified labels) and adds what the fork needs: reading the current
 * Serve config, an app-bundle fallback when the CLI is not on PATH, and the
 * "HTTPS not enabled on this tailnet" consent URL.
 */

export const TAILSCALE_SERVE_STATUS_TIMEOUT = Duration.millis(2_500);
const TAILSCALE_SERVE_TIMEOUT = Duration.seconds(10);

export const TAILSCALE_LOOPBACK_HOST = "127.0.0.1";

/**
 * Spawn order for the CLI. The bare name comes first so a user-managed PATH
 * wins; a candidate whose spawn fails with ENOENT yields to the next one. On
 * macOS the App Store / standalone app bundles the CLI inside Tailscale.app,
 * and older standalone installs symlink it into /usr/local/bin.
 */
export const resolveTailscaleExecutable = (platform: NodeJS.Platform): readonly string[] => {
  switch (platform) {
    case "win32":
      return ["tailscale.exe"];
    case "darwin":
      return [
        "tailscale",
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "/usr/local/bin/tailscale",
      ];
    default:
      return ["tailscale"];
  }
};

export const TailscaleServeCliDiagnostic = Schema.Literals([
  "serve-not-enabled",
  "no-existing-handler",
  "not-logged-in",
  "permission-denied",
  "unknown",
]);
export type TailscaleServeCliDiagnostic = typeof TailscaleServeCliDiagnostic.Type;

// Matched against stderr, most specific first. The consent URL is the one
// piece of stderr we do copy out, and only when it matches Tailscale's login
// host exactly; everything else is reduced to a label.
const STDERR_DIAGNOSTIC_PATTERNS: ReadonlyArray<
  readonly [RegExp, Exclude<TailscaleServeCliDiagnostic, "unknown">]
> = [
  [/serve is not enabled|https is not enabled|enable https/i, "serve-not-enabled"],
  [/handler does not exist/i, "no-existing-handler"],
  [/not logged in|logged out|needs? login/i, "not-logged-in"],
  [/permission denied|access denied|must be root|operation not permitted/i, "permission-denied"],
];

const CONSENT_URL_PATTERN = /https:\/\/login\.tailscale\.com\/\S+/;

export interface TailscaleStderrClassification {
  readonly diagnostic: TailscaleServeCliDiagnostic;
  readonly consentUrl?: string;
}

/** Reduces stderr to a label plus, for the HTTPS-consent case, the login URL. */
export const classifyTailscaleStderr = (
  stderr: string,
): TailscaleStderrClassification | undefined => {
  if (stderr.trim().length === 0) {
    return undefined;
  }
  const diagnostic =
    STDERR_DIAGNOSTIC_PATTERNS.find(([pattern]) => pattern.test(stderr))?.[1] ?? "unknown";
  // Prose around the URL tends to end with a period or a closing bracket.
  const consentUrl = CONSENT_URL_PATTERN.exec(stderr)?.[0]?.replace(/[.,)]+$/, "");
  return consentUrl === undefined ? { diagnostic } : { diagnostic, consentUrl };
};

const TailscaleSubcommand = Schema.Literals(["status", "serve"]);

export class TailscaleServeCliError extends Schema.TaggedErrorClass<TailscaleServeCliError>()(
  "TailscaleServeCliError",
  {
    subcommand: TailscaleSubcommand,
    reason: Schema.Literals(["not-installed", "spawn", "output", "exit", "timeout", "parse"]),
    exitCode: Schema.optional(Schema.Number),
    diagnostic: Schema.optional(TailscaleServeCliDiagnostic),
    consentUrl: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-installed":
        return "The Tailscale CLI was not found. Install Tailscale or add `tailscale` to PATH.";
      case "spawn":
        return `Failed to start tailscale ${this.subcommand}.`;
      case "output":
        return `Failed to read output from tailscale ${this.subcommand}.`;
      case "timeout":
        return `tailscale ${this.subcommand} did not finish in time.`;
      case "parse":
        return `tailscale ${this.subcommand} returned output this app could not read.`;
      case "exit":
        return describeExit(this);
    }
  }
}

const describeExit = (error: TailscaleServeCliError): string => {
  switch (error.diagnostic) {
    case "serve-not-enabled":
      return error.consentUrl === undefined
        ? "HTTPS is not enabled for this tailnet. Enable it in the Tailscale admin console, then try again."
        : `HTTPS is not enabled for this tailnet. Enable it at ${error.consentUrl}, then try again.`;
    case "not-logged-in":
      return "Tailscale is not logged in on this machine.";
    case "permission-denied":
      return "Tailscale refused the request. Run tailscale as an operator or administrator.";
    case "no-existing-handler":
      return `tailscale ${error.subcommand} found no mapping to change.`;
    default:
      return `tailscale ${error.subcommand} exited with code ${error.exitCode ?? "unknown"}.`;
  }
};

// `tailscale serve status --json` for one HTTPS port. Handlers other than a
// reverse proxy (static paths, text) exist, so `Proxy` stays optional and the
// whole document may be `null` when nothing is configured. A foreground
// `tailscale serve` session (no `--bg`) is stored under `Foreground`, keyed
// by session id, with the same shape; it occupies the port all the same.
const ServeHandlerJson = Schema.Struct({
  Proxy: Schema.optional(Schema.String),
});
const ServeWebEntryJson = Schema.Struct({
  Handlers: Schema.optional(Schema.Record(Schema.String, ServeHandlerJson)),
});
const ServeWebJson = Schema.optional(Schema.Record(Schema.String, ServeWebEntryJson));
const ServeConfigJson = Schema.NullOr(
  Schema.Struct({
    Web: ServeWebJson,
    Foreground: Schema.optional(
      Schema.Record(Schema.String, Schema.NullOr(Schema.Struct({ Web: ServeWebJson }))),
    ),
  }),
);
const decodeServeConfigJson = Schema.decodeUnknownEffect(Schema.fromJsonString(ServeConfigJson));

/**
 * What Serve currently maps for a given HTTPS port. `proxy` carries the
 * reverse-proxy target verbatim so callers can decide whether it is theirs;
 * `other` is a non-proxy handler (a static site, say) that still occupies the
 * port.
 */
export type TailscaleServeMapping =
  | { readonly _tag: "none" }
  | { readonly _tag: "proxy"; readonly hostKey: string; readonly target: string }
  | { readonly _tag: "other"; readonly hostKey: string };

export const parseTailscaleServeConfig = (
  rawJson: string,
  servePort: number,
): Effect.Effect<TailscaleServeMapping, TailscaleServeCliError> =>
  Effect.gen(function* () {
    const trimmed = rawJson.trim();
    if (trimmed.length === 0) {
      return { _tag: "none" } as const;
    }
    const config = yield* decodeServeConfigJson(trimmed).pipe(
      Effect.mapError(
        (cause) => new TailscaleServeCliError({ subcommand: "serve", reason: "parse", cause }),
      ),
    );
    const suffix = `:${servePort}`;
    const webEntries = [
      config?.Web ?? {},
      ...Object.values(config?.Foreground ?? {}).map((session) => session?.Web ?? {}),
    ];
    for (const web of webEntries) {
      for (const [hostKey, entry] of Object.entries(web)) {
        if (!hostKey.endsWith(suffix)) continue;
        const rootHandler = entry.Handlers?.["/"];
        if (rootHandler?.Proxy !== undefined) {
          return { _tag: "proxy", hostKey, target: rootHandler.Proxy } as const;
        }
        return { _tag: "other", hostKey } as const;
      }
    }
    return { _tag: "none" } as const;
  });

/**
 * True when a Serve proxy target points at this machine's loopback on the
 * given port, whichever spelling of loopback the CLI echoed back.
 */
export const isOwnServeTarget = (target: string, localPort: number): boolean => {
  try {
    const url = new URL(target);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const isLoopback = host === TAILSCALE_LOOPBACK_HOST || host === "localhost" || host === "::1";
    const port = url.port === "" ? (url.protocol === "https:" ? "443" : "80") : url.port;
    return isLoopback && port === String(localPort);
  } catch {
    return false;
  }
};

export const serveApplyArgs = (input: {
  readonly localPort: number;
  readonly servePort: number;
}): readonly string[] => [
  "serve",
  "--bg",
  `--https=${input.servePort}`,
  `http://${TAILSCALE_LOOPBACK_HOST}:${input.localPort}`,
];

export const serveClearArgs = (input: { readonly servePort: number }): readonly string[] => [
  "serve",
  `--https=${input.servePort}`,
  "off",
];

export interface TailscaleServeCli {
  readonly readStatus: Effect.Effect<TailscaleStatus, TailscaleServeCliError>;
  readonly readServeConfig: (
    servePort: number,
  ) => Effect.Effect<TailscaleServeMapping, TailscaleServeCliError>;
  readonly applyServe: (input: {
    readonly localPort: number;
    readonly servePort: number;
  }) => Effect.Effect<void, TailscaleServeCliError>;
  readonly clearServe: (input: {
    readonly servePort: number;
  }) => Effect.Effect<void, TailscaleServeCliError>;
}

const collectText = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const isNotFoundSpawnError = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "reason" in cause &&
  typeof cause.reason === "object" &&
  cause.reason !== null &&
  "_tag" in cause.reason &&
  cause.reason._tag === "NotFound";

interface CommandOutput {
  readonly stdout: string;
  readonly exitCode: number;
  readonly stderrClassification: TailscaleStderrClassification | undefined;
}

export const makeTailscaleServeCli: Effect.Effect<
  TailscaleServeCli,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcessPlatform;
  const candidates = resolveTailscaleExecutable(platform);
  // Remembered once a candidate spawns, so later commands skip the ENOENT walk.
  const resolvedExecutable = yield* Ref.make<string | null>(null);

  const spawnResolved = (
    subcommand: "status" | "serve",
    args: readonly string[],
  ): Effect.Effect<ChildProcessSpawner.ChildProcessHandle, TailscaleServeCliError, Scope.Scope> =>
    Effect.gen(function* () {
      const known = yield* Ref.get(resolvedExecutable);
      const order = known === null ? candidates : [known];
      for (const executable of order) {
        const attempt = yield* spawner.spawn(ChildProcess.make(executable, [...args])).pipe(
          Effect.map((handle) => ({ _tag: "spawned", handle }) as const),
          Effect.catch((cause) => Effect.succeed({ _tag: "failed", cause } as const)),
          // A non-directory on PATH makes node throw ENOTDIR synchronously,
          // which arrives as a defect rather than a typed error.
          Effect.catchDefect((cause) => Effect.succeed({ _tag: "failed", cause } as const)),
        );
        if (attempt._tag === "spawned") {
          yield* Ref.set(resolvedExecutable, executable);
          return attempt.handle;
        }
        if (!isNotFoundSpawnError(attempt.cause)) {
          return yield* new TailscaleServeCliError({
            subcommand,
            reason: "spawn",
            cause: attempt.cause,
          });
        }
      }
      return yield* new TailscaleServeCliError({ subcommand, reason: "not-installed" });
    });

  const run = (
    subcommand: "status" | "serve",
    args: readonly string[],
    timeout: Duration.Duration,
  ): Effect.Effect<CommandOutput, TailscaleServeCliError> =>
    Effect.gen(function* () {
      const child = yield* spawnResolved(subcommand, args);
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectText(child.stdout),
          collectText(child.stderr),
          child.exitCode.pipe(Effect.map(Number)),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(
          (cause) => new TailscaleServeCliError({ subcommand, reason: "output", cause }),
        ),
      );
      return { stdout, exitCode, stderrClassification: classifyTailscaleStderr(stderr) };
    }).pipe(
      Effect.scoped,
      Effect.timeout(timeout),
      Effect.catchTag("TimeoutError", (cause) =>
        Effect.fail(new TailscaleServeCliError({ subcommand, reason: "timeout", cause })),
      ),
    );

  const failOnExit = (
    subcommand: "status" | "serve",
    output: CommandOutput,
  ): Effect.Effect<CommandOutput, TailscaleServeCliError> =>
    output.exitCode === 0
      ? Effect.succeed(output)
      : Effect.fail(
          new TailscaleServeCliError({
            subcommand,
            reason: "exit",
            exitCode: output.exitCode,
            ...(output.stderrClassification === undefined
              ? {}
              : {
                  diagnostic: output.stderrClassification.diagnostic,
                  ...(output.stderrClassification.consentUrl === undefined
                    ? {}
                    : { consentUrl: output.stderrClassification.consentUrl }),
                }),
          }),
        );

  const readStatus = run("status", ["status", "--json"], TAILSCALE_STATUS_TIMEOUT).pipe(
    Effect.flatMap((output) => failOnExit("status", output)),
    Effect.flatMap((output) =>
      parseTailscaleStatus(output.stdout).pipe(
        Effect.mapError(
          (cause) => new TailscaleServeCliError({ subcommand: "status", reason: "parse", cause }),
        ),
      ),
    ),
    Effect.withSpan("desktop.tailscaleServe.cli.readStatus"),
  );

  const readServeConfig = Effect.fn("desktop.tailscaleServe.cli.readServeConfig")(function* (
    servePort: number,
  ) {
    yield* Effect.annotateCurrentSpan({ servePort });
    const output = yield* run(
      "serve",
      ["serve", "status", "--json"],
      TAILSCALE_SERVE_STATUS_TIMEOUT,
    ).pipe(Effect.flatMap((result) => failOnExit("serve", result)));
    return yield* parseTailscaleServeConfig(output.stdout, servePort);
  });

  const applyServe = Effect.fn("desktop.tailscaleServe.cli.applyServe")(function* (input: {
    readonly localPort: number;
    readonly servePort: number;
  }) {
    yield* Effect.annotateCurrentSpan(input);
    yield* run("serve", serveApplyArgs(input), TAILSCALE_SERVE_TIMEOUT).pipe(
      Effect.flatMap((result) => failOnExit("serve", result)),
    );
  });

  const clearServe = Effect.fn("desktop.tailscaleServe.cli.clearServe")(function* (input: {
    readonly servePort: number;
  }) {
    yield* Effect.annotateCurrentSpan(input);
    yield* run("serve", serveClearArgs(input), TAILSCALE_SERVE_TIMEOUT).pipe(
      Effect.flatMap((result) => failOnExit("serve", result)),
    );
  });

  return { readStatus, readServeConfig, applyServe, clearServe } satisfies TailscaleServeCli;
});
