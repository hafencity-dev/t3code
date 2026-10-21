import { Effect, Schedule } from "effect";
import { isTransientAppleNetworkError } from "./apple-network-retry.ts";

// Command errors include captured stdout/stderr in their message. Error 68 alone
// is not sufficient: retrying signing failures or rejected submissions cannot help.
export const retryAppleNetworkCommand =
  (label: string) =>
  <A, E, R>(operation: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    operation.pipe(
      Effect.retry({
        while: isTransientAppleNetworkError,
        schedule: Schedule.recurs(3).pipe(
          Schedule.addDelay(({ output }) => {
            const retry = output + 1;
            const delay = retry * 15_000;
            return Effect.logWarning(
              `${label}: Apple network failure; retry ${retry}/3 in ${delay / 1_000}s.`,
            ).pipe(Effect.as(delay));
          }),
        ),
      }),
    );
