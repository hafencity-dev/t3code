import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { materializeCodexAccountHome } from "./CodexAccountHome.ts";

describe("CodexAccountHome", () => {
  let root: string;
  let homePath: string;
  let sharedHomePath: string;
  beforeEach(async () => {
    root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codex-account-"));
    homePath = NodePath.join(root, "account");
    sharedHomePath = NodePath.join(root, "shared");
    await NodeFSP.mkdir(sharedHomePath);
  });
  afterEach(async () => {
    await NodeFSP.rm(root, { recursive: true, force: true });
  });

  it("uses the upstream shared-session overlay without copying auth", async () => {
    await NodeFSP.writeFile(NodePath.join(sharedHomePath, "auth.json"), "private");
    await materializeCodexAccountHome({ homePath, sharedHomePath });
    await materializeCodexAccountHome({ homePath, sharedHomePath });
    expect(await NodeFSP.readlink(NodePath.join(homePath, "sessions"))).toBe(
      NodePath.join(sharedHomePath, "sessions"),
    );
    await expect(NodeFSP.stat(NodePath.join(homePath, "auth.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await NodeFSP.stat(homePath)).mode & 0o777).toBe(0o700);
    await NodeFSP.writeFile(NodePath.join(homePath, "auth.json"), "account-private");
    await materializeCodexAccountHome({ homePath, sharedHomePath });
    expect(await NodeFSP.readFile(NodePath.join(homePath, "auth.json"), "utf8")).toBe(
      "account-private",
    );
    await NodeFSP.rm(homePath, { recursive: true });
    expect(await NodeFSP.readFile(NodePath.join(sharedHomePath, "auth.json"), "utf8")).toBe(
      "private",
    );
    expect((await NodeFSP.stat(NodePath.join(sharedHomePath, "sessions"))).isDirectory()).toBe(
      true,
    );
  });

  it("refuses an alias of the shared home and symlinked home directories", async () => {
    await expect(
      materializeCodexAccountHome({ homePath: sharedHomePath, sharedHomePath }),
    ).rejects.toThrow("must differ");
    await NodeFSP.symlink(sharedHomePath, homePath);
    await expect(materializeCodexAccountHome({ homePath, sharedHomePath })).rejects.toThrow(
      "must not be a symlink",
    );
  });
});
