import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { materializeCodexShadowHome } from "../Drivers/CodexHomeLayout.ts";

/** Use the upstream overlay so switching authentication preserves continuation identity. */
export async function materializeCodexAccountHome(input: {
  homePath: string;
  sharedHomePath: string;
}) {
  const homePath = NodePath.resolve(input.homePath);
  const sharedHomePath = NodePath.resolve(input.sharedHomePath);
  if (homePath === sharedHomePath)
    throw new Error("Account home must differ from the shared home.");
  const existing = await NodeFSP.lstat(homePath).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  });
  if (existing?.isSymbolicLink()) throw new Error("Account home must not be a symlink.");
  await NodeFSP.mkdir(homePath, { recursive: true, mode: 0o700 });
  await NodeFSP.chmod(homePath, 0o700);
  await Effect.runPromise(
    materializeCodexShadowHome({
      mode: "authOverlay",
      sharedHomePath,
      effectiveHomePath: homePath,
      continuationKey: `codex:home:${sharedHomePath}`,
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  return homePath;
}
