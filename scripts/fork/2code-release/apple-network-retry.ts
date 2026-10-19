// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - release tooling retries transient Apple transport failures.
import * as NodeTimersPromises from "node:timers/promises";

const RETRY_DELAYS_MS = [15_000, 30_000, 45_000] as const;
const TRANSIENT_URL_ERROR = /\bNSURLErrorDomain\s+Code\s*=\s*-(?:1001|1003|1004|1005|1006|1009)\b/;

export async function withAppleNetworkRetry<T>(
  label: string,
  operation: () => T | Promise<T>,
  options: {
    readonly wait?: (milliseconds: number) => Promise<void>;
    readonly onRetry?: (message: string) => void;
  } = {},
): Promise<T> {
  const wait = options.wait ?? NodeTimersPromises.setTimeout;
  const onRetry = options.onRetry ?? console.warn;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      // Stapler's Error 68 also covers permanent failures; only a concrete
      // NSURL transport error permits another attempt, never a missing ticket.
      if (
        delay === undefined ||
        !(error instanceof Error) ||
        !TRANSIENT_URL_ERROR.test(error.message)
      ) {
        throw error;
      }
      onRetry(`${label}: Apple network failure; retry ${attempt + 1}/3 in ${delay / 1_000}s.`);
      await wait(delay);
    }
  }
}
