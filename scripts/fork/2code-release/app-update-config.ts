import type { TwoCodeReleaseConfig } from "./release-core.ts";

export function readYamlScalar(raw: string, key: string): string | undefined {
  const match = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*(.+)$`, "m").exec(
    raw,
  );
  if (!match?.[1]) return undefined;
  const trimmed = match[1].trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** The packaged `app-update.yml` must keep every client on the production 2code feed. */
export function verifyAppUpdateConfiguration(
  config: TwoCodeReleaseConfig,
  appUpdateRaw: string,
): void {
  if (readYamlScalar(appUpdateRaw, "provider") !== "generic") {
    throw new Error("Packaged app-update.yml must use the generic provider.");
  }
  if (readYamlScalar(appUpdateRaw, "url") !== config.feedUrl) {
    throw new Error("Packaged app-update.yml does not point to the production 2code feed.");
  }
  if (readYamlScalar(appUpdateRaw, "updaterCacheDirName") !== config.updaterCacheDirName) {
    throw new Error("Packaged app-update.yml does not retain the 2code updater cache name.");
  }
}
