import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  CLAUDE_SHARED_ACCOUNT_ENTRIES,
  materializeClaudeAccountHome,
} from "./ClaudeAccountHome.ts";

describe("ClaudeAccountHome", () => {
  let root: string;
  let homePath: string;
  let sharedHomePath: string;
  beforeEach(async () => {
    root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "claude-account-"));
    homePath = NodePath.join(root, "account");
    sharedHomePath = NodePath.join(root, "shared");
    await NodeFSP.mkdir(sharedHomePath);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await NodeFSP.rm(root, { recursive: true, force: true });
  });

  it("links allowlisted directories and existing files and seeds only MCP configuration", async () => {
    await NodeFSP.mkdir(NodePath.join(sharedHomePath, "projects"));
    await NodeFSP.mkdir(NodePath.join(sharedHomePath, "sessions"));
    await NodeFSP.writeFile(NodePath.join(sharedHomePath, "settings.json"), "{}");
    await NodeFSP.writeFile(NodePath.join(sharedHomePath, ".credentials.json"), "private");
    await NodeFSP.writeFile(
      NodePath.join(sharedHomePath, ".claude.json"),
      JSON.stringify({
        mcpServers: { local: { command: "example" } },
        oauthAccount: { emailAddress: "private@example.com" },
      }),
    );
    await materializeClaudeAccountHome({ homePath, sharedHomePath });
    await materializeClaudeAccountHome({ homePath, sharedHomePath });
    expect(await NodeFSP.readlink(NodePath.join(homePath, "projects"))).toBe(
      NodePath.join(sharedHomePath, "projects"),
    );
    expect(await NodeFSP.readlink(NodePath.join(homePath, "settings.json"))).toBe(
      NodePath.join(sharedHomePath, "settings.json"),
    );
    expect(await NodeFSP.readdir(homePath)).toEqual(
      [
        ".claude.json",
        ...CLAUDE_SHARED_ACCOUNT_ENTRIES.filter(
          (name) => !["settings.local.json", "CLAUDE.md", "history.jsonl"].includes(name),
        ),
      ].sort(),
    );
    expect(
      JSON.parse(await NodeFSP.readFile(NodePath.join(homePath, ".claude.json"), "utf8")),
    ).toEqual({
      mcpServers: { local: { command: "example" } },
    });
    const before = await NodeFSP.readdir(sharedHomePath);
    expect((await NodeFSP.stat(homePath)).mode & 0o777).toBe(0o700);
    expect((await NodeFSP.stat(NodePath.join(homePath, ".claude.json"))).mode & 0o777).toBe(0o600);
    await NodeFSP.rm(homePath, { recursive: true });
    expect(await NodeFSP.readdir(sharedHomePath)).toEqual(before);
  });

  it("preserves real private files and rejects private symlinks", async () => {
    await NodeFSP.mkdir(homePath);
    await NodeFSP.writeFile(NodePath.join(homePath, ".credentials.json"), "private");
    await NodeFSP.mkdir(NodePath.join(homePath, "backups"));
    await materializeClaudeAccountHome({ homePath, sharedHomePath });
    expect(await NodeFSP.readFile(NodePath.join(homePath, ".credentials.json"), "utf8")).toBe(
      "private",
    );
    await NodeFSP.symlink(
      NodePath.join(sharedHomePath, "missing"),
      NodePath.join(homePath, "cache"),
    );
    await expect(materializeClaudeAccountHome({ homePath, sharedHomePath })).rejects.toThrow(
      "must not be a symlink",
    );
  });

  it("creates missing shared directories before the CLI can create private ones", async () => {
    await materializeClaudeAccountHome({ homePath, sharedHomePath });
    const projects = NodePath.join(homePath, "projects");
    expect((await NodeFSP.lstat(projects)).isSymbolicLink()).toBe(true);
    expect((await NodeFSP.stat(projects)).mode & 0o777).toBe(0o700);
    await NodeFSP.mkdir(projects, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(projects, "conversation"), "continuation");
    await materializeClaudeAccountHome({ homePath, sharedHomePath });
    await materializeClaudeAccountHome({ homePath, sharedHomePath });
    expect(
      await NodeFSP.readFile(NodePath.join(sharedHomePath, "projects", "conversation"), "utf8"),
    ).toBe("continuation");
    await expect(NodeFSP.lstat(NodePath.join(homePath, "history.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("warns and preserves conflicting real entries and wrong links on repeated switches", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await NodeFSP.mkdir(homePath);
    const projects = NodePath.join(homePath, "projects");
    await NodeFSP.mkdir(projects);
    await NodeFSP.writeFile(NodePath.join(projects, "private"), "keep");
    await NodeFSP.writeFile(NodePath.join(homePath, "settings.json"), "private-settings");
    await NodeFSP.symlink(root, NodePath.join(homePath, "skills"));
    await materializeClaudeAccountHome({ homePath, sharedHomePath });
    await materializeClaudeAccountHome({ homePath, sharedHomePath });
    expect(await NodeFSP.readFile(NodePath.join(projects, "private"), "utf8")).toBe("keep");
    expect(await NodeFSP.readFile(NodePath.join(homePath, "settings.json"), "utf8")).toBe(
      "private-settings",
    );
    expect(await NodeFSP.readlink(NodePath.join(homePath, "skills"))).toBe(root);
    expect(warn).toHaveBeenCalledWith(
      "Account entry 'projects' conflicts with the shared home; leaving it private.",
    );
    expect(warn).toHaveBeenCalledTimes(6);
  });

  it("seeds default user-home config through an explicit path, excluding identity", async () => {
    const sourceConfigPath = NodePath.join(root, ".claude.json");
    await NodeFSP.writeFile(
      sourceConfigPath,
      JSON.stringify({
        mcpServers: { personal: { command: "example" } },
        oauthAccount: { emailAddress: "private@example.com" },
      }),
    );
    await NodeFSP.writeFile(NodePath.join(sharedHomePath, ".claude.json"), '{"mcpServers":{}}');
    await materializeClaudeAccountHome({ homePath, sharedHomePath, sourceConfigPath });
    expect(
      JSON.parse(await NodeFSP.readFile(NodePath.join(homePath, ".claude.json"), "utf8")),
    ).toEqual({ mcpServers: { personal: { command: "example" } } });
  });

  it("creates a missing shared home and never overwrites account config", async () => {
    await NodeFSP.rmdir(sharedHomePath);
    await materializeClaudeAccountHome({ homePath, sharedHomePath });
    expect((await NodeFSP.stat(sharedHomePath)).isDirectory()).toBe(true);
    await NodeFSP.writeFile(NodePath.join(homePath, ".claude.json"), '{"oauthAccount":{}}');
    await materializeClaudeAccountHome({ homePath, sharedHomePath });
    expect(await NodeFSP.readFile(NodePath.join(homePath, ".claude.json"), "utf8")).toBe(
      '{"oauthAccount":{}}',
    );
    await expect(
      materializeClaudeAccountHome({ homePath, sharedHomePath: homePath }),
    ).rejects.toThrow("must differ");
  });
});
