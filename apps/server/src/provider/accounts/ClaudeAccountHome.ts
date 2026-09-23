import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export const CLAUDE_SHARED_ACCOUNT_ENTRIES = [
  "projects",
  "file-history",
  "todos",
  "tasks",
  "plans",
  "shell-snapshots",
  "settings.json",
  "settings.local.json",
  "CLAUDE.md",
  "agents",
  "commands",
  "skills",
  "plugins",
  "hooks",
  "output-styles",
  "history.jsonl",
] as const;

const sharedEntries = new Set<string>(CLAUDE_SHARED_ACCOUNT_ENTRIES);
const sharedFiles = new Set<string>([
  "settings.json",
  "settings.local.json",
  "CLAUDE.md",
  "history.jsonl",
]);

async function statOrMissing(filePath: string) {
  return NodeFSP.lstat(filePath).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
}

function isMissing(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** Share only CLI configuration and continuation data; credentials and runtime state stay local. */
export async function materializeClaudeAccountHome(input: {
  homePath: string;
  sharedHomePath: string;
  /** Default CLI config lives at ~/.claude.json unless its config directory is overridden. */
  sourceConfigPath?: string;
}) {
  const homePath = NodePath.resolve(input.homePath);
  const sharedHomePath = NodePath.resolve(input.sharedHomePath);
  if (homePath === sharedHomePath)
    throw new Error("Account home must differ from the shared home.");
  const existing = await statOrMissing(homePath);
  if (existing?.isSymbolicLink()) throw new Error("Account home must not be a symlink.");
  await NodeFSP.mkdir(homePath, { recursive: true, mode: 0o700 });
  await NodeFSP.chmod(homePath, 0o700);
  for (const name of await NodeFSP.readdir(homePath)) {
    const entry = await NodeFSP.lstat(NodePath.join(homePath, name));
    if (!sharedEntries.has(name) && entry.isSymbolicLink()) {
      throw new Error(`Private account entry '${name}' must not be a symlink.`);
    }
  }
  for (const name of CLAUDE_SHARED_ACCOUNT_ENTRIES) {
    const target = NodePath.join(sharedHomePath, name);
    const link = NodePath.join(homePath, name);
    const current = await statOrMissing(link);
    if (current) {
      if (
        !current.isSymbolicLink() ||
        NodePath.resolve(homePath, await NodeFSP.readlink(link)) !== target
      ) {
        console.warn(`Account entry '${name}' conflicts with the shared home; leaving it private.`);
        continue;
      }
    }
    if (!sharedFiles.has(name)) {
      await NodeFSP.mkdir(target, { recursive: true, mode: 0o700 });
    }
    if (!current && (await statOrMissing(target))) {
      await NodeFSP.symlink(target, link);
    }
  }
  // Only initial creation seeds MCP config; never copy OAuth identity or overwrite local state.
  const configPath = NodePath.join(homePath, ".claude.json");
  if (!(await statOrMissing(configPath))) {
    const source = await NodeFSP.readFile(
      input.sourceConfigPath ?? NodePath.join(sharedHomePath, ".claude.json"),
      "utf8",
    ).catch((error: unknown) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    const config: unknown = source === undefined ? {} : JSON.parse(source);
    const mcpServers =
      typeof config === "object" && config !== null && "mcpServers" in config
        ? config.mcpServers
        : undefined;
    await NodeFSP.writeFile(
      configPath,
      JSON.stringify(mcpServers === undefined ? {} : { mcpServers }),
      {
        flag: "wx",
        mode: 0o600,
      },
    );
  }
  return homePath;
}
