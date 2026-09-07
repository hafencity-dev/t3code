/**
 * CodexAccountService — transport-facing account operations (fork f1).
 *
 * Sits between `ws.ts` and a driver's optional `ProviderAuthOps`:
 *
 *   1. resolves `instanceId` through `ProviderInstanceRegistry` and refuses
 *      unknown / auth-less instances with a typed error;
 *   2. **refreshes the instance snapshot after a successful sign-in or a
 *      sign-out.** This is not cosmetic: `probeCodexAppServerProvider` returns
 *      early — with an *empty model catalog* — when the account is missing and
 *      `requiresOpenaiAuth` is set. Without the refresh, a user signs in
 *      successfully and still sees no models.
 *
 * The refresh lives here rather than inside the driver because
 * `ProviderRegistry` is built *from* the drivers; a driver depending on it
 * would be circular.
 *
 * @module provider/Services/CodexAccountService
 */
import {
  ProviderAuthUnsupportedError,
  type ProviderAuthError,
  type ProviderSignInEvent,
  type ProviderStartSignInInput,
  type ProviderSignOutInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import type { ProviderAuthOps } from "../ProviderAuthOps.ts";
import { ProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "./ProviderRegistry.ts";

export interface CodexAccountServiceShape {
  readonly startSignIn: (
    input: ProviderStartSignInInput,
  ) => Stream.Stream<ProviderSignInEvent, ProviderAuthError>;
  readonly signOut: (input: ProviderSignOutInput) => Effect.Effect<void, ProviderAuthError>;
}

export class CodexAccountService extends Context.Service<
  CodexAccountService,
  CodexAccountServiceShape
>()("t3/provider/Services/CodexAccountService") {
  static readonly layer = Layer.effect(
    CodexAccountService,
    Effect.gen(function* () {
      const instances = yield* ProviderInstanceRegistry;
      const registry = yield* ProviderRegistry;

      const resolveAuthOps = Effect.fn("CodexAccountService.resolveAuthOps")(function* (
        instanceId: ProviderStartSignInInput["instanceId"],
      ): Effect.fn.Return<ProviderAuthOps, ProviderAuthUnsupportedError> {
        const instance = yield* instances.getInstance(instanceId);
        if (instance === undefined) {
          return yield* new ProviderAuthUnsupportedError({
            instanceId,
            reason: "no such provider instance is configured",
          });
        }
        if (instance.accountAuth === undefined) {
          return yield* new ProviderAuthUnsupportedError({
            instanceId,
            reason: `the ${instance.driverKind} driver has no in-app account support`,
          });
        }
        return instance.accountAuth;
      });

      /**
       * Re-probe the instance so the freshly authenticated (or freshly signed
       * out) account reaches every connected client. Never fails the caller —
       * a refresh problem must not turn a successful login into an error.
       */
      const refreshInstance = (instanceId: ProviderStartSignInInput["instanceId"]) =>
        registry.refreshInstance(instanceId).pipe(Effect.ignore, Effect.asVoid);

      const startSignIn: CodexAccountServiceShape["startSignIn"] = (input) =>
        Stream.unwrap(
          resolveAuthOps(input.instanceId).pipe(
            Effect.map((auth) =>
              auth
                .startSignIn({ mode: input.mode })
                .pipe(
                  Stream.tap((event) =>
                    event._tag === "completed" ? refreshInstance(input.instanceId) : Effect.void,
                  ),
                ),
            ),
          ),
        );

      const signOut: CodexAccountServiceShape["signOut"] = (input) =>
        resolveAuthOps(input.instanceId).pipe(
          Effect.flatMap((auth) => auth.signOut),
          Effect.tap(() => refreshInstance(input.instanceId)),
        );

      return CodexAccountService.of({ startSignIn, signOut });
    }),
  );
}
