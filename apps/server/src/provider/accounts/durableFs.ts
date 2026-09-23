// fork: provider accounts
import * as NodeFSP from "node:fs/promises";

// oxlint-disable-next-line t3code/no-global-process-runtime -- Platform seam for directory fsync; tests stub it.
export const currentPlatform = () => process.platform;

/**
 * Make a completed rename durable. Windows has no directory fsync (EPERM/EISDIR on
 * open+fsync of a directory), so only the file fsync plus rename applies there.
 */
export async function syncDirectory(path: string, platform = currentPlatform()) {
  if (platform === "win32") return;
  const dir = await NodeFSP.open(path, "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
