import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createProviderAccountRegistry,
  ProviderAccountRegistryGuardError,
} from "./ProviderAccountRegistry.ts";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof NodeFSP>()) }));

describe("ProviderAccountRegistry", () => {
  let stateDir: string;
  let shared: string;
  beforeEach(async () => {
    stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "provider-accounts-"));
    shared = NodePath.join(stateDir, "shared");
    await NodeFSP.mkdir(shared);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await NodeFSP.rm(stateDir, { recursive: true, force: true });
  });
  const registryPath = () => NodePath.join(stateDir, "fork", "provider-accounts", "accounts.json");

  it("fsyncs the temporary file before renaming and the directory after, before resolving", async () => {
    const registry = await createProviderAccountRegistry({ stateDir });
    const events: string[] = [];
    const open = NodeFSP.open;
    vi.spyOn(NodeFSP, "open").mockImplementation(async (path, ...rest) => {
      const handle = await open(path, ...rest);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        events.push(
          String(path).endsWith(".tmp")
            ? "file-sync"
            : `dir-sync:${NodePath.basename(String(path))}`,
        );
        await sync();
      };
      return handle;
    });
    const rename = NodeFSP.rename;
    vi.spyOn(NodeFSP, "rename").mockImplementation(async (from, to) => {
      events.push("rename");
      await rename(from, to);
    });
    await registry.list("claudeAgent", shared);
    events.push("resolved");
    expect(events).toEqual(["file-sync", "rename", "dir-sync:provider-accounts", "resolved"]);
    expect(await NodeFSP.readdir(NodePath.dirname(registryPath()))).toEqual(["accounts.json"]);
  });

  it("persists the window primer and keeps start times only for saved accounts", async () => {
    const registry = await createProviderAccountRegistry({ stateDir });
    expect(await registry.getWindowPrimer()).toEqual({ enabled: false });
    await registry.list("claudeAgent", shared);
    await registry.updateWindowPrimer({ enabled: true });
    await registry.updateWindowPrimer({ primed: { accountId: "claudeAgent-default", at: 5 } });
    await registry.updateWindowPrimer({ primed: { accountId: "removed", at: 6 } });
    const reopened = await createProviderAccountRegistry({ stateDir });
    expect(await reopened.getWindowPrimer()).toEqual({
      enabled: true,
      primedAt: { "claudeAgent-default": 5 },
    });
  });

  it("defaults auto-switch off without rewriting phase-one registries", async () => {
    const fresh = await createProviderAccountRegistry({ stateDir });
    expect(await fresh.getAutoSwitch("claudeAgent")).toEqual({
      enabled: false,
      thresholdPercent: 10,
      weeklyThresholdPercent: 2,
    });
    expect(await fresh.getAutoSwitch("codex")).toEqual({
      enabled: false,
      thresholdPercent: 10,
      weeklyThresholdPercent: 2,
    });
    await expect(NodeFSP.stat(registryPath())).rejects.toMatchObject({ code: "ENOENT" });
    await fresh.list("claudeAgent", shared);
    const before = await NodeFSP.readFile(registryPath(), "utf8");
    expect(JSON.parse(before)).not.toHaveProperty("autoSwitch");
    const reopened = await createProviderAccountRegistry({ stateDir });
    expect(await reopened.getAutoSwitch("claudeAgent")).toEqual({
      enabled: false,
      thresholdPercent: 10,
      weeklyThresholdPercent: 2,
    });
    expect(await NodeFSP.readFile(registryPath(), "utf8")).toBe(before);
  });

  it("persists per-driver config and switch history across account mutations", async () => {
    const registry = await createProviderAccountRegistry({ stateDir });
    const lastSwitch = {
      at: "2026-09-23T10:00:00.000Z",
      fromAccountId: "claudeAgent-default",
      toAccountId: "work",
      trigger: "weekly" as const,
      reason: "Default has 8% left; switching to Work with 60% left.",
      accessToken: "never-persist",
    };
    await Promise.all([
      registry.updateAutoSwitch("claudeAgent", { enabled: true, lastSwitch }),
      registry.updateAutoSwitch("claudeAgent", { thresholdPercent: 5 }),
      registry.updateAutoSwitch("codex", { thresholdPercent: 50 }),
      registry.list("claudeAgent", shared),
    ]);
    await registry.rename("claudeAgent-default", "Personal");
    const reopened = await createProviderAccountRegistry({ stateDir });
    const { accessToken: _, ...expectedLastSwitch } = lastSwitch;
    expect(await reopened.getAutoSwitch("claudeAgent")).toEqual({
      enabled: true,
      thresholdPercent: 5,
      weeklyThresholdPercent: 2,
      lastSwitch: expectedLastSwitch,
    });
    expect(await reopened.getAutoSwitch("codex")).toEqual({
      enabled: false,
      thresholdPercent: 50,
      weeklyThresholdPercent: 2,
    });
    expect(await reopened.get("claudeAgent-default")).toMatchObject({ label: "Personal" });
    const raw = await NodeFSP.readFile(registryPath(), "utf8");
    expect(raw).not.toContain("never-persist");
    expect((await NodeFSP.stat(registryPath())).mode & 0o777).toBe(0o600);
    expect(await NodeFSP.readdir(NodePath.dirname(registryPath()))).toEqual(["accounts.json"]);
  });

  it("ignores a legacy manual hold and drops it on the next write without losing history", async () => {
    const lastSwitch = {
      at: "2026-09-23T10:00:00.000Z",
      fromAccountId: "default",
      toAccountId: "work",
      trigger: "session" as const,
      reason: "Default has exhausted its session limit.",
    };
    await NodeFSP.mkdir(NodePath.dirname(registryPath()), { recursive: true });
    await NodeFSP.writeFile(
      registryPath(),
      JSON.stringify({
        version: 1,
        accounts: [],
        sharedHomes: {},
        autoSwitch: {
          codex: {
            enabled: true,
            thresholdPercent: 10,
            lastSwitch,
            manual: { at: 1000, holdUntil: 7201000, activeWasBelowThreshold: true },
          },
        },
      }),
    );
    const registry = await createProviderAccountRegistry({ stateDir });
    expect(await registry.getAutoSwitch("codex")).toEqual({
      enabled: true,
      thresholdPercent: 10,
      weeklyThresholdPercent: 2,
      lastSwitch,
    });
    const snapshot = await registry.getAutoSwitch("codex");
    Object.assign(snapshot.lastSwitch!, { reason: "Mutated" });
    expect(await registry.getAutoSwitch("codex")).toMatchObject({ lastSwitch });
    await registry.updateAutoSwitch("codex", {});
    expect(await NodeFSP.readFile(registryPath(), "utf8")).not.toContain("holdUntil");
    const reopened = await createProviderAccountRegistry({ stateDir });
    expect(await reopened.getAutoSwitch("codex")).toEqual({
      enabled: true,
      thresholdPercent: 10,
      weeklyThresholdPercent: 2,
      lastSwitch,
    });
  });

  it.each([4, 51, 10.5, NaN, Infinity, -Infinity])(
    "rejects invalid threshold %s without changing persisted state or blocking later writes",
    async (thresholdPercent) => {
      const registry = await createProviderAccountRegistry({ stateDir });
      await registry.updateAutoSwitch("codex", { enabled: true, thresholdPercent: 20 });
      const before = await NodeFSP.readFile(registryPath(), "utf8");
      await expect(registry.updateAutoSwitch("codex", { thresholdPercent })).rejects.toBeInstanceOf(
        ProviderAccountRegistryGuardError,
      );
      expect(await NodeFSP.readFile(registryPath(), "utf8")).toBe(before);
      expect(await registry.getAutoSwitch("codex")).toEqual({
        enabled: true,
        thresholdPercent: 20,
        weeklyThresholdPercent: 2,
      });
      expect(await registry.updateAutoSwitch("codex", { enabled: false })).toEqual({
        enabled: false,
        thresholdPercent: 20,
        weeklyThresholdPercent: 2,
      });
    },
  );

  it("defaults the weekly threshold to 2% for files written before it existed", async () => {
    await NodeFSP.mkdir(NodePath.dirname(registryPath()), { recursive: true });
    await NodeFSP.writeFile(
      registryPath(),
      JSON.stringify({
        version: 1,
        accounts: [],
        sharedHomes: {},
        autoSwitch: { codex: { enabled: true, thresholdPercent: 15 } },
      }),
    );
    const registry = await createProviderAccountRegistry({ stateDir });
    expect(await registry.getAutoSwitch("codex")).toEqual({
      enabled: true,
      thresholdPercent: 15,
      weeklyThresholdPercent: 2,
    });
    // Each threshold changes alone.
    expect(await registry.updateAutoSwitch("codex", { weeklyThresholdPercent: 5 })).toEqual({
      enabled: true,
      thresholdPercent: 15,
      weeklyThresholdPercent: 5,
    });
    const reopened = await createProviderAccountRegistry({ stateDir });
    expect(await reopened.getAutoSwitch("codex")).toMatchObject({
      thresholdPercent: 15,
      weeklyThresholdPercent: 5,
    });
  });

  it.each([0, 26, 2.5, NaN])(
    "rejects invalid weekly threshold %s",
    async (weeklyThresholdPercent) => {
      const registry = await createProviderAccountRegistry({ stateDir });
      await registry.updateAutoSwitch("codex", { enabled: true, weeklyThresholdPercent: 3 });
      await expect(
        registry.updateAutoSwitch("codex", { weeklyThresholdPercent }),
      ).rejects.toBeInstanceOf(ProviderAccountRegistryGuardError);
      expect(await registry.getAutoSwitch("codex")).toMatchObject({ weeklyThresholdPercent: 3 });
    },
  );

  it("captures defaults once, normalizes paths, and persists restrictive metadata atomically", async () => {
    const registry = await createProviderAccountRegistry({ stateDir });
    const initial = await registry.list("claudeAgent", NodePath.join(shared, "sub", ".."));
    expect(initial.accounts[0]).toMatchObject({
      kind: "default",
      homePath: shared,
      label: "Default",
    });
    const reopened = await createProviderAccountRegistry({ stateDir });
    const configured = NodePath.join(stateDir, "configured");
    const changed = await reopened.list("claudeAgent", configured);
    expect(changed.accounts).toHaveLength(2);
    expect(changed.sharedHomePath).toBe(shared);
    expect(changed.accounts[1]).toMatchObject({
      kind: "external",
      label: "Configured in Settings",
    });
    expect(JSON.parse(await NodeFSP.readFile(registryPath(), "utf8")).accounts).toHaveLength(1);
    await reopened.prepareSwitch("claudeAgent", configured, undefined, "claudeAgent-default");
    expect(JSON.parse(await NodeFSP.readFile(registryPath(), "utf8")).accounts).toHaveLength(2);
    expect((await NodeFSP.stat(registryPath())).mode & 0o777).toBe(0o600);
    expect((await NodeFSP.stat(NodePath.dirname(registryPath()))).mode & 0o777).toBe(0o700);
    expect(await NodeFSP.readdir(NodePath.dirname(registryPath()))).toEqual(["accounts.json"]);
    const again = await createProviderAccountRegistry({ stateDir });
    expect((await again.list("claudeAgent", shared)).accounts).toHaveLength(2);
  });

  it.each(["", "~/custom-claude", " ./literal-home "])(
    "preserves raw Default setting %j across managed switches and reloads",
    async (originalHomePath) => {
      const registry = await createProviderAccountRegistry({ stateDir });
      const initial = await registry.list("claudeAgent", shared, shared, originalHomePath);
      const sourceConfigPath = NodePath.join(stateDir, ".claude.json");
      await NodeFSP.writeFile(
        sourceConfigPath,
        '{"mcpServers":{"personal":{"command":"example"}}}',
      );
      const managed = await registry.createManaged({
        driver: "claudeAgent",
        label: "Work",
        sharedHomePath: shared,
        sourceConfigPath,
      });
      expect(
        JSON.parse(await NodeFSP.readFile(NodePath.join(managed.homePath, ".claude.json"), "utf8")),
      ).toEqual({ mcpServers: { personal: { command: "example" } } });
      await registry.prepareSwitch("claudeAgent", shared, shared, managed.id, originalHomePath);
      const reopened = await createProviderAccountRegistry({ stateDir });
      await reopened.prepareSwitch(
        "claudeAgent",
        managed.homePath,
        shared,
        initial.activeAccountId,
        managed.homePath,
      );
      const target = await reopened.get(initial.activeAccountId);
      expect(target.originalHomePath ?? target.homePath).toBe(originalHomePath);
      expect(target.homePath).toBe(shared);
      expect(
        (await reopened.list("claudeAgent", shared, shared, originalHomePath)).activeAccountId,
      ).toBe(initial.activeAccountId);
    },
  );

  it("lazily allocates Default's store without changing its configured home or identity", async () => {
    const registry = await createProviderAccountRegistry({ stateDir });
    const initial = await registry.list("claudeAgent", shared, shared, "");
    expect(initial.accounts[0]).not.toHaveProperty("storePath");
    await NodeFSP.writeFile(NodePath.join(shared, ".credentials.json"), "not-registry-data");
    const [entry, concurrent] = await Promise.all([
      registry.ensureClaudeStore(initial.activeAccountId),
      registry.ensureClaudeStore(initial.activeAccountId),
    ]);
    expect(concurrent).toEqual(entry);
    expect(entry).toMatchObject({ kind: "default", homePath: shared, originalHomePath: "" });
    expect(entry.storePath).not.toBe(shared);
    expect((await NodeFSP.stat(entry.storePath!)).isDirectory()).toBe(true);
    expect(await NodeFSP.readlink(NodePath.join(entry.storePath!, "projects"))).toBe(
      NodePath.join(shared, "projects"),
    );
    await expect(
      NodeFSP.stat(NodePath.join(entry.storePath!, ".credentials.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await NodeFSP.readFile(NodePath.join(shared, ".credentials.json"), "utf8")).toBe(
      "not-registry-data",
    );
    const reopened = await createProviderAccountRegistry({ stateDir });
    expect(await reopened.ensureClaudeStore(entry.id)).toEqual(entry);
    expect((await reopened.list("claudeAgent", shared)).activeAccountId).toBe(entry.id);
  });

  it("reuses managed stores and persists hot selection only for the captured Default home", async () => {
    const registry = await createProviderAccountRegistry({ stateDir });
    const initial = await registry.list("claudeAgent", shared);
    const managed = await registry.createManaged({
      driver: "claudeAgent",
      label: "Work",
      sharedHomePath: shared,
    });
    const other = await registry.createManaged({
      driver: "claudeAgent",
      label: "Other",
      sharedHomePath: shared,
    });
    const config = NodePath.join(managed.homePath, ".claude.json");
    await NodeFSP.writeFile(config, "leave managed store alone");
    expect(await registry.ensureClaudeStore(managed.id)).toMatchObject({
      storePath: managed.homePath,
      homePath: managed.homePath,
    });
    expect(await NodeFSP.readFile(config, "utf8")).toBe("leave managed store alone");
    await registry.setClaudeActiveAccount(managed.id);
    const reopened = await createProviderAccountRegistry({ stateDir });
    expect((await reopened.list("claudeAgent", shared)).activeAccountId).toBe(managed.id);
    expect((await reopened.list("claudeAgent", other.homePath)).activeAccountId).toBe(other.id);
    const external = await reopened.list("claudeAgent", NodePath.join(stateDir, "custom"));
    expect(external.accounts.find((entry) => entry.id === external.activeAccountId)?.kind).toBe(
      "external",
    );
    await expect(reopened.remove(managed.id, shared)).rejects.toThrow("Active");
    await reopened.setClaudeActiveAccount(initial.activeAccountId);
    await reopened.remove(managed.id, shared);
    expect((await reopened.list("claudeAgent", shared)).activeAccountId).toBe(
      initial.activeAccountId,
    );
  });

  it("rejects missing and non-Claude selections without changing metadata", async () => {
    const registry = await createProviderAccountRegistry({ stateDir });
    await registry.list("codex", "", shared);
    const before = await NodeFSP.readFile(registryPath(), "utf8");
    for (const id of ["missing", "codex-default"]) {
      await expect(registry.ensureClaudeStore(id)).rejects.toBeInstanceOf(
        ProviderAccountRegistryGuardError,
      );
      await expect(registry.setClaudeActiveAccount(id)).rejects.toBeInstanceOf(
        ProviderAccountRegistryGuardError,
      );
    }
    expect(await NodeFSP.readFile(registryPath(), "utf8")).toBe(before);
    expect((await registry.list("codex", "", shared)).activeAccountId).toBe("codex-default");
  });

  it("persists signed-out identity metadata for a checked-out account", async () => {
    const registry = await createProviderAccountRegistry({ stateDir });
    const { activeAccountId } = await registry.list("claudeAgent", shared);
    await registry.update(activeAccountId, {
      status: "signedOut",
      message: "Sign in again",
      lastUsage: { checkedAt: "2026-09-23T10:00:00.000Z", accountUuid: "account-a" },
    });
    const reopened = await createProviderAccountRegistry({ stateDir });
    expect(await reopened.get(activeAccountId)).toMatchObject({
      status: "signedOut",
      message: "Sign in again",
      lastUsage: { accountUuid: "account-a" },
    });
  });

  it("persists and clears account error messages without losing metadata", async () => {
    const registry = await createProviderAccountRegistry({ stateDir });
    const initial = await registry.list("claudeAgent", shared);
    await registry.update(initial.activeAccountId, { status: "error", message: "Wrong account." });
    const reopened = await createProviderAccountRegistry({ stateDir });
    expect(await reopened.update(initial.activeAccountId, {})).toMatchObject({
      message: "Wrong account.",
    });
    expect(
      await reopened.update(initial.activeAccountId, { status: "ready", message: null }),
    ).not.toHaveProperty("message");
    const again = await createProviderAccountRegistry({ stateDir });
    expect(await again.get(initial.activeAccountId)).toMatchObject({
      status: "ready",
      homePath: shared,
    });
    expect(await again.get(initial.activeAccountId)).not.toHaveProperty("message");
  });

  it("captures direct Codex mode without confusing it with the shared home", async () => {
    const registry = await createProviderAccountRegistry({ stateDir });
    await expect(registry.list("codex", "")).rejects.toThrow("required");
    const initial = await registry.list("codex", undefined, shared);
    expect(initial.accounts[0]?.homePath).toBe("");
    const shadow = NodePath.join(stateDir, "shadow");
    await registry.prepareSwitch("codex", shadow, shared, initial.activeAccountId);
    expect((await registry.list("codex", "", shared)).activeAccountId).toBe(
      initial.activeAccountId,
    );
    const reopened = await createProviderAccountRegistry({ stateDir });
    expect((await reopened.list("codex", shadow, shared)).accounts).toHaveLength(2);
  });

  it("keeps direct Default active under a changed Codex home but refuses overlay switches", async () => {
    const registry = await createProviderAccountRegistry({ stateDir });
    const initial = await registry.list("codex", "", shared);
    expect(initial.warning).toBeUndefined();
    const account = await registry.createManaged({
      driver: "codex",
      label: "Work",
      sharedHomePath: shared,
    });
    const moved = NodePath.join(stateDir, "moved");
    const changed = await registry.list("codex", "", moved);
    expect(changed.activeAccountId).toBe(initial.activeAccountId);
    expect(changed.sharedHomePath).toBe(shared);
    expect(changed.warning).toContain(shared);
    await expect(registry.prepareSwitch("codex", "", moved, account.id)).rejects.toThrow(
      "Codex home changed in Settings",
    );
    await expect(
      registry.prepareSwitch("codex", account.homePath, moved, initial.activeAccountId),
    ).resolves.toMatchObject({ warning: changed.warning });
    await expect(
      registry.prepareSwitch("codex", "", shared, account.id),
    ).resolves.not.toHaveProperty("warning");
  });

  it("preserves an existing Codex shadow as the captured default", async () => {
    const registry = await createProviderAccountRegistry({ stateDir });
    const shadow = NodePath.join(stateDir, "shadow");
    const initial = await registry.list("codex", shadow, shared);
    expect(initial.accounts[0]).toMatchObject({ kind: "default", homePath: shadow });
    expect(initial.sharedHomePath).toBe(shared);
  });

  it("guards removal, renames only metadata, and forgets external homes without deleting files", async () => {
    const registry = await createProviderAccountRegistry({ stateDir });
    const initial = await registry.list("claudeAgent", shared);
    await expect(
      registry.remove(initial.activeAccountId, NodePath.join(stateDir, "other")),
    ).rejects.toThrow("Default");
    const account = await registry.createManaged({
      driver: "claudeAgent",
      label: "Work",
      sharedHomePath: shared,
    });
    expect(account.status).toBe("pending");
    await expect(registry.remove(account.id, account.homePath)).rejects.toThrow("Active");
    await registry.rename(account.id, " Team ");
    expect(await registry.get(account.id)).toMatchObject({
      label: "Team",
      homePath: account.homePath,
    });
    await registry.remove(account.id, shared);
    expect((await NodeFSP.stat(account.homePath)).isDirectory()).toBe(true);
    const configured = NodePath.join(stateDir, "configured");
    await NodeFSP.mkdir(configured);
    await NodeFSP.writeFile(NodePath.join(configured, "keep"), "keep");
    const snapshot = await registry.prepareSwitch(
      "claudeAgent",
      configured,
      undefined,
      initial.activeAccountId,
    );
    await registry.remove(snapshot.activeAccountId, shared);
    expect(await NodeFSP.readFile(NodePath.join(configured, "keep"), "utf8")).toBe("keep");
    expect((await registry.list("claudeAgent", shared)).accounts).toHaveLength(1);
  });

  it("serializes concurrent mutations and excludes unknown secret fields", async () => {
    const registry = await createProviderAccountRegistry({ stateDir });
    const initial = await registry.list("claudeAgent", shared);
    const account = await registry.createManaged({
      driver: "claudeAgent",
      label: "Work",
      sharedHomePath: shared,
    });
    const lastUsage = {
      checkedAt: new Date().toISOString(),
      email: "work@example.com",
      accessToken: "never-persist",
    };
    await Promise.all([
      registry.rename(initial.activeAccountId, "Original"),
      registry.update(account.id, { status: "ready", lastUsage }),
    ]);
    const raw = await NodeFSP.readFile(registryPath(), "utf8");
    expect(raw).not.toContain("never-persist");
    expect(raw).not.toContain("accessToken");
    const reopened = await createProviderAccountRegistry({ stateDir });
    expect(await reopened.get(initial.activeAccountId)).toMatchObject({ label: "Original" });
    expect(await reopened.get(account.id)).toMatchObject({
      status: "ready",
      lastUsage: { email: "work@example.com" },
    });
  });

  it("only discards pending managed metadata for login cleanup", async () => {
    const registry = await createProviderAccountRegistry({ stateDir });
    const initial = await registry.list("claudeAgent", shared);
    await expect(registry.discardPending(initial.activeAccountId)).rejects.toThrow("Only pending");
    const account = await registry.createManaged({
      driver: "claudeAgent",
      label: "New",
      sharedHomePath: shared,
    });
    await registry.discardPending(account.id);
    await expect(registry.get(account.id)).rejects.toThrow("not found");
    expect((await NodeFSP.stat(account.homePath)).isDirectory()).toBe(true);
    const ready = await registry.createManaged({
      driver: "claudeAgent",
      label: "Ready",
      sharedHomePath: shared,
    });
    await registry.update(ready.id, { status: "ready" });
    await expect(registry.discardPending(ready.id)).rejects.toThrow("Only pending");
  });

  it("persists new probe backoff attempts across restarts without replacing the last good usage", async () => {
    const registry = await createProviderAccountRegistry({ stateDir });
    const { activeAccountId } = await registry.list("claudeAgent", shared);
    const checkedAt = "2026-09-20T10:00:00.000Z";
    const lastAttemptAt = Date.parse(checkedAt);
    const good = {
      checkedAt,
      email: "work@example.com",
      plan: "pro",
      usage: {
        checkedAt,
        windows: [{ id: "session", label: "Session", kind: "session" as const, usedPercent: 30 }],
      },
      lastAttemptAt,
      consecutiveFailures: 0,
      nextAllowedAt: lastAttemptAt + 60_000,
    };
    await registry.update(activeAccountId, { lastUsage: good });
    for (const consecutiveFailures of [1, 2]) {
      const reopened = await createProviderAccountRegistry({ stateDir });
      const attempt = lastAttemptAt + consecutiveFailures * 1_800_000;
      const backoff = {
        lastAttemptAt: attempt,
        consecutiveFailures,
        nextAllowedAt: attempt + consecutiveFailures * 900_000,
        lastFailureKind: "rateLimited" as const,
      };
      await reopened.update(activeAccountId, {
        lastUsage: {
          checkedAt: new Date(attempt).toISOString(),
          usage: {
            checkedAt: new Date(attempt).toISOString(),
            windows: [],
            unavailable: { reason: "probeFailed", message: "Rate limited" },
          },
          ...backoff,
        },
      });
      const again = await createProviderAccountRegistry({ stateDir });
      expect((await again.get(activeAccountId)).lastUsage).toEqual({
        ...good,
        ...backoff,
        usage: { ...good.usage, unavailable: { reason: "probeFailed", message: "Rate limited" } },
      });
    }
    const reopened = await createProviderAccountRegistry({ stateDir });
    await reopened.update(activeAccountId, { lastUsage: good });
    const recovered = await createProviderAccountRegistry({ stateDir });
    expect((await recovered.get(activeAccountId)).lastUsage).toEqual(good);
  });

  it("persists backoff before any successful measurement exists", async () => {
    const registry = await createProviderAccountRegistry({ stateDir });
    const { activeAccountId } = await registry.list("claudeAgent", shared);
    const lastUsage = {
      checkedAt: "2026-09-20T10:00:00.000Z",
      lastAttemptAt: 1000,
      consecutiveFailures: 1,
      nextAllowedAt: 301000,
      lastFailureKind: "failed" as const,
    };
    await registry.update(activeAccountId, { lastUsage });
    const reopened = await createProviderAccountRegistry({ stateDir });
    expect((await reopened.get(activeAccountId)).lastUsage).toEqual(lastUsage);
  });

  it("preserves the last successful usage and timestamps when probing fails", async () => {
    const registry = await createProviderAccountRegistry({ stateDir });
    const initial = await registry.list("claudeAgent", shared);
    const checkedAt = "2026-09-20T10:00:00.000Z";
    await registry.update(initial.activeAccountId, {
      lastUsage: {
        checkedAt,
        email: "work@example.com",
        usage: {
          checkedAt,
          windows: [{ id: "session", label: "Session", kind: "session", usedPercent: 30 }],
        },
      },
    });
    const failedAt = "2026-09-20T11:00:00.000Z";
    const updated = await registry.update(initial.activeAccountId, {
      status: "error",
      lastUsage: {
        checkedAt: failedAt,
        usage: {
          checkedAt: failedAt,
          windows: [],
          unavailable: { reason: "probeFailed", message: "Offline" },
        },
      },
    });
    expect(updated.lastUsage).toMatchObject({
      checkedAt,
      email: "work@example.com",
      usage: {
        checkedAt,
        windows: [{ usedPercent: 30 }],
        unavailable: { reason: "probeFailed" },
      },
    });
  });
});
