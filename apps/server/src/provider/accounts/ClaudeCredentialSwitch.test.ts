import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  claudeCredentialKeychainAccount,
  claudeCredentialKeychainService,
  claudeFileCredentialAdapter,
  ClaudeCredentialSwitchError,
  createClaudeKeychainCredentialAdapter,
  createSystemClaudeKeychain,
  recoverClaudeCredentialSwitch,
  switchClaudeCredentials,
  type ClaudeCredentialAdapter,
  type ClaudeCredentialSwitchInput,
  type ClaudeCredentialSwitchPhase,
} from "./ClaudeCredentialSwitch.ts";

const oauth = (name: string) => ({
  accessToken: `access-${name}`,
  refreshToken: `refresh-${name}`,
});
const account = (name: string) => ({
  emailAddress: `${name}@example.test`,
  accountUuid: name,
  organizationUuid: `org-${name}`,
});
const read = async (path: string) => JSON.parse(await NodeFSP.readFile(path, "utf8"));
const write = async (path: string, value: unknown) =>
  NodeFSP.writeFile(path, JSON.stringify(value), { mode: 0o600 });

const journalPath = () => NodePath.join(input.stateDir, "claude-credential-switch.json");
let input: ClaudeCredentialSwitchInput;
const FSJournal = () => read(journalPath());

describe("ClaudeCredentialSwitch", () => {
  let root: string;
  beforeEach(async () => {
    root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "claude-switch-"));
    const activeHome = NodePath.join(root, "active");
    const managedRoot = NodePath.join(root, "managed");
    const sourceStore = NodePath.join(managedRoot, "a");
    const targetStore = NodePath.join(managedRoot, "b");
    for (const dir of [activeHome, sourceStore, targetStore])
      await NodeFSP.mkdir(dir, { recursive: true });
    input = {
      stateDir: NodePath.join(root, "state"),
      managedRoot,
      activeHome,
      activeConfigPath: NodePath.join(root, ".claude.json"),
      sourceStore,
      targetStore,
      sourceAccountId: "a",
      targetAccountId: "b",
      expectedEmail: "a@example.test",
      expectedAccountUuid: "a",
      commit: vi.fn(async () => undefined),
    };
    await write(NodePath.join(activeHome, ".credentials.json"), {
      claudeAiOauth: oauth("a"),
      mcpOAuth: { keep: "active" },
    });
    await write(input.activeConfigPath, {
      oauthAccount: account("a"),
      theme: "dark",
      projects: { preserved: true },
    });
    await write(NodePath.join(sourceStore, ".credentials.json"), { mcpOAuth: { keep: "source" } });
    await write(NodePath.join(sourceStore, ".claude.json"), { theme: "source" });
    await write(NodePath.join(targetStore, ".credentials.json"), {
      claudeAiOauth: oauth("b"),
      mcpOAuth: { keep: "target" },
    });
    await write(NodePath.join(targetStore, ".claude.json"), {
      oauthAccount: account("b"),
      theme: "target",
    });
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await NodeFSP.rm(root, { recursive: true, force: true });
  });

  async function assertMoved() {
    expect(await read(NodePath.join(input.activeHome, ".credentials.json"))).toEqual({
      claudeAiOauth: oauth("b"),
      mcpOAuth: { keep: "active" },
    });
    expect(await read(NodePath.join(input.sourceStore, ".credentials.json"))).toEqual({
      claudeAiOauth: oauth("a"),
      mcpOAuth: { keep: "source" },
    });
    expect(await read(NodePath.join(input.targetStore, ".credentials.json"))).toEqual({
      mcpOAuth: { keep: "target" },
    });
    expect(await read(input.activeConfigPath)).toEqual({
      oauthAccount: account("b"),
      theme: "dark",
      projects: { preserved: true },
    });
    expect(await read(NodePath.join(input.sourceStore, ".claude.json"))).toEqual({
      oauthAccount: account("a"),
      theme: "source",
    });
    expect(await NodeFSP.readdir(input.stateDir)).not.toContain("claude-credential-switch.json");
  }

  it("moves the lineage and identity, preserving unrelated keys and config mode while changing credential mtime", async () => {
    await NodeFSP.chmod(input.activeConfigPath, 0o640);
    const credentialsPath = NodePath.join(input.activeHome, ".credentials.json");
    await NodeFSP.chmod(credentialsPath, 0o644);
    const before = await NodeFSP.stat(credentialsPath);
    const result = await switchClaudeCredentials(input);
    expect(result).toEqual({
      activeAccountId: "b",
      sourceAccountId: "a",
      originalSourceAccountId: "a",
    });
    await assertMoved();
    expect((await NodeFSP.stat(credentialsPath)).mtimeMs).not.toBe(before.mtimeMs);
    expect((await NodeFSP.stat(credentialsPath)).mode & 0o777).toBe(0o600);
    expect((await NodeFSP.stat(input.activeConfigPath)).mode & 0o777).toBe(0o640);
    expect(input.commit).toHaveBeenCalledWith(result);
    expect(await recoverClaudeCredentialSwitch(input)).toBeUndefined();
  });

  it.each<ClaudeCredentialSwitchPhase>([
    "prepared",
    "source-saved",
    "activating",
    "activated",
    "checked-out",
    "committed",
  ])("recovers a crash after durable %s without journaling tokens", async (phase) => {
    await expect(
      switchClaudeCredentials(input, {
        afterPhase: async (current) => {
          if (current === phase) throw new Error("simulated crash");
        },
      }),
    ).rejects.toThrow("simulated crash");
    const journal = await NodeFSP.readFile(
      NodePath.join(input.stateDir, "claude-credential-switch.json"),
      "utf8",
    );
    expect(journal).not.toContain("access-");
    expect(journal).not.toContain("refresh-");
    expect(journal).not.toContain("claudeAiOauth");
    expect(await recoverClaudeCredentialSwitch(input)).toEqual({
      activeAccountId: "b",
      sourceAccountId: "a",
      originalSourceAccountId: "a",
    });
    await assertMoved();
  });

  it.each(["source", "active", "target"])(
    "recovers when a %s credential write succeeds but its caller crashes",
    async (where) => {
      let failed = false;
      const crashing: ClaudeCredentialAdapter = {
        read: claudeFileCredentialAdapter.read,
        async write(location, value) {
          await claudeFileCredentialAdapter.write(location, value);
          const home =
            where === "source"
              ? input.sourceStore
              : where === "active"
                ? input.activeHome
                : input.targetStore;
          if (!failed && location.home === home) {
            failed = true;
            throw new Error("post-write crash");
          }
        },
      };
      await expect(switchClaudeCredentials(input, { credentials: crashing })).rejects.toThrow(
        "post-write crash",
      );
      await recoverClaudeCredentialSwitch(input);
      await assertMoved();
    },
  );

  it("keeps refreshed active target authoritative after activation precedes the phase write", async () => {
    const crashing: ClaudeCredentialAdapter = {
      read: claudeFileCredentialAdapter.read,
      async write(location, value) {
        await claudeFileCredentialAdapter.write(location, value);
        if (location.home === input.activeHome) throw new Error("crash");
      },
    };
    await expect(switchClaudeCredentials(input, { credentials: crashing })).rejects.toThrow(
      "crash",
    );
    await write(NodePath.join(input.activeHome, ".credentials.json"), {
      claudeAiOauth: oauth("b-refreshed"),
      unrelated: true,
    });
    await write(input.activeConfigPath, { oauthAccount: account("b") });
    await recoverClaudeCredentialSwitch(input);
    expect(
      (await read(NodePath.join(input.activeHome, ".credentials.json"))).claudeAiOauth,
    ).toEqual(oauth("b-refreshed"));
    expect(
      (await read(NodePath.join(input.targetStore, ".credentials.json"))).claudeAiOauth,
    ).toBeUndefined();
    expect((await read(input.activeConfigPath)).oauthAccount).toEqual(account("b"));
  });

  it("retains journal until the durable registry commit succeeds", async () => {
    input.commit = vi.fn(async () => {
      throw new Error("registry unavailable");
    });
    await expect(switchClaudeCredentials(input)).rejects.toThrow("registry unavailable");
    expect((await read(NodePath.join(input.stateDir, "claude-credential-switch.json"))).phase).toBe(
      "checked-out",
    );
    input.commit = vi.fn(async () => undefined);
    await recoverClaudeCredentialSwitch(input);
    await assertMoved();
  });

  it("saves terminal login C in a freshly resolved and locked store, not A", async () => {
    await write(input.activeConfigPath, { oauthAccount: account("c"), keep: true });
    await write(NodePath.join(input.activeHome, ".credentials.json"), {
      claudeAiOauth: oauth("c"),
    });
    const external = NodePath.join(input.managedRoot, "c");
    await NodeFSP.mkdir(external);
    input.resolveSource = vi.fn(async (observed) => {
      expect(observed).toEqual({ email: "c@example.test", accountUuid: "c" });
      return { store: external, accountId: "c" };
    });
    const lockSets: string[][] = [];
    const result = await switchClaudeCredentials(input, {
      locks: async (homes, operation) => {
        lockSets.push([...homes]);
        return operation(() => undefined);
      },
    });
    expect(lockSets[1]).toContain(external);
    expect(result).toEqual({
      activeAccountId: "b",
      sourceAccountId: "c",
      originalSourceAccountId: "a",
      externalIdentity: { email: "c@example.test", accountUuid: "c" },
    });
    expect((await read(NodePath.join(external, ".credentials.json"))).claudeAiOauth).toEqual(
      oauth("c"),
    );
    expect(
      (await read(NodePath.join(input.sourceStore, ".credentials.json"))).claudeAiOauth,
    ).toBeUndefined();
  });

  it("revalidates identity after reacquiring the expanded lock set", async () => {
    await write(input.activeConfigPath, { oauthAccount: account("c") });
    const external = NodePath.join(input.managedRoot, "c");
    await NodeFSP.mkdir(external);
    input.resolveSource = async () => ({ store: external, accountId: "c" });
    let acquisitions = 0;
    await expect(
      switchClaudeCredentials(input, {
        locks: async (_homes, operation) => {
          if (++acquisitions === 2)
            await write(input.activeConfigPath, { oauthAccount: account("d") });
          return operation(() => undefined);
        },
      }),
    ).rejects.toThrow("identity changed");
    expect(
      (await read(NodePath.join(input.activeHome, ".credentials.json"))).claudeAiOauth,
    ).toEqual(oauth("a"));
  });

  it("supports a signed-out default without inventing credentials", async () => {
    await write(NodePath.join(input.activeHome, ".credentials.json"), {
      mcpOAuth: { keep: "active" },
    });
    await switchClaudeCredentials(input);
    expect(
      (await read(NodePath.join(input.activeHome, ".credentials.json"))).claudeAiOauth,
    ).toEqual(oauth("b"));
    expect(
      (await read(NodePath.join(input.sourceStore, ".credentials.json"))).claudeAiOauth,
    ).toBeUndefined();
  });

  it.each(["home", "root", "symlink"])(
    "refuses recovery after the configured %s changed",
    async (changed) => {
      await expect(
        switchClaudeCredentials(input, {
          afterPhase: async () => {
            throw new Error("crash");
          },
        }),
      ).rejects.toThrow("crash");
      if (changed === "home") input.activeHome = input.sourceStore;
      if (changed === "root") {
        input.managedRoot = NodePath.join(root, "elsewhere");
        await NodeFSP.mkdir(input.managedRoot);
      }
      if (changed === "symlink") {
        const outside = NodePath.join(root, "outside");
        await NodeFSP.mkdir(outside);
        await NodeFSP.rm(input.targetStore, { recursive: true });
        await NodeFSP.symlink(outside, input.targetStore);
      }
      await expect(recoverClaudeCredentialSwitch(input)).rejects.toBeInstanceOf(
        ClaudeCredentialSwitchError,
      );
      expect(
        (await read(NodePath.join(input.stateDir, "claude-credential-switch.json"))).phase,
      ).toBe("prepared");
      expect(input.commit).not.toHaveBeenCalled();
    },
  );

  it("does not overwrite a source store already holding a different lineage", async () => {
    await write(NodePath.join(input.sourceStore, ".credentials.json"), {
      claudeAiOauth: oauth("other"),
    });
    await expect(switchClaudeCredentials(input)).rejects.toThrow("another credential lineage");
    expect(
      (await read(NodePath.join(input.sourceStore, ".credentials.json"))).claudeAiOauth,
    ).toEqual(oauth("other"));
    expect(
      (await read(NodePath.join(input.activeHome, ".credentials.json"))).claudeAiOauth,
    ).toEqual(oauth("a"));
  });

  it("moves and recovers keychain credentials using an injectable fake without credential files", async () => {
    const entries = new Map<string, string>();
    const credentials = createClaudeKeychainCredentialAdapter(
      {
        read: async (service, user) => entries.get(`${service}:${user}`),
        write: async (service, user, value) => {
          entries.set(`${service}:${user}`, value);
        },
      },
      "test-user",
    );
    const active = { home: input.activeHome };
    const source = { home: input.sourceStore, configDir: input.sourceStore };
    const target = { home: input.targetStore, configDir: input.targetStore };
    await credentials.write(active, { claudeAiOauth: oauth("a"), mcpOAuth: "keep" });
    await credentials.write(target, { claudeAiOauth: oauth("b"), other: true });
    await expect(
      switchClaudeCredentials(input, {
        credentials,
        afterPhase: async (phase) => {
          if (phase === "activated") throw new Error("crash");
        },
      }),
    ).rejects.toThrow("crash");
    await recoverClaudeCredentialSwitch(input, { credentials });
    expect(await credentials.read(active)).toEqual({ claudeAiOauth: oauth("b"), mcpOAuth: "keep" });
    expect(await credentials.read(source)).toEqual({ claudeAiOauth: oauth("a") });
    expect(await credentials.read(target)).toEqual({ other: true });
  });

  it("sanitizes keychain adapter failures and never falls back to file credentials", async () => {
    const credentials = createClaudeKeychainCredentialAdapter(
      {
        read: async () => {
          throw new Error("SECRET-access-token");
        },
        write: async () => {
          throw new Error("SECRET-refresh-token");
        },
      },
      "test-user",
    );
    await expect(credentials.read({ home: root })).rejects.toThrow(
      "Unable to read Claude credentials from macOS Keychain.",
    );
    await expect(credentials.write({ home: root }, {})).rejects.toThrow(
      "Unable to write Claude credentials to macOS Keychain.",
    );
    await expect(switchClaudeCredentials(input, { credentials })).rejects.not.toThrow("SECRET");
    expect(
      (await read(NodePath.join(input.activeHome, ".credentials.json"))).claudeAiOauth,
    ).toEqual(oauth("a"));
  });

  it.each<ClaudeCredentialSwitchPhase>(["source-saved", "activating", "activated", "checked-out"])(
    "fails closed if terminal login changes active identity after %s",
    async (phase) => {
      await expect(
        switchClaudeCredentials(input, {
          afterPhase: async (current) => {
            if (current === phase) throw new Error("crash");
          },
        }),
      ).rejects.toThrow("crash");
      await write(NodePath.join(input.activeHome, ".credentials.json"), {
        claudeAiOauth: oauth("c"),
      });
      await write(input.activeConfigPath, { oauthAccount: account("c") });
      await expect(recoverClaudeCredentialSwitch(input)).rejects.toThrow("recovery left untouched");
      expect(
        (await read(NodePath.join(input.activeHome, ".credentials.json"))).claudeAiOauth,
      ).toEqual(oauth("c"));
      if (phase !== "checked-out") {
        expect(
          (await read(NodePath.join(input.targetStore, ".credentials.json"))).claudeAiOauth,
        ).toEqual(oauth("b"));
      }
      expect(
        (await read(NodePath.join(input.stateDir, "claude-credential-switch.json"))).phase,
      ).toBe(phase);
      expect(input.commit).not.toHaveBeenCalled();
    },
  );

  it("does not save terminal login C into A's store after a prepared crash", async () => {
    await expect(
      switchClaudeCredentials(input, {
        afterPhase: async (phase) => {
          if (phase === "prepared") throw new Error("crash");
        },
      }),
    ).rejects.toThrow("crash");
    await write(NodePath.join(input.activeHome, ".credentials.json"), {
      claudeAiOauth: oauth("c"),
    });
    await write(input.activeConfigPath, { oauthAccount: account("c") });
    const journal = await FSJournal();
    expect(journal.sourceIdentity).toEqual({ email: "a@example.test", accountUuid: "a" });
    await expect(recoverClaudeCredentialSwitch(input)).rejects.toThrow("recovery left untouched");
    expect(
      (await read(NodePath.join(input.sourceStore, ".credentials.json"))).claudeAiOauth,
    ).toBeUndefined();
    expect(
      (await read(NodePath.join(input.sourceStore, ".claude.json"))).oauthAccount,
    ).toBeUndefined();
    expect(
      (await read(NodePath.join(input.targetStore, ".credentials.json"))).claudeAiOauth,
    ).toEqual(oauth("b"));
    expect(
      (await read(NodePath.join(input.activeHome, ".credentials.json"))).claudeAiOauth,
    ).toEqual(oauth("c"));
    expect((await FSJournal()).phase).toBe("prepared");
    expect(input.commit).not.toHaveBeenCalled();
  });

  it("recovers a signed-out source only while the active home is still signed out", async () => {
    await write(NodePath.join(input.activeHome, ".credentials.json"), {});
    await write(input.activeConfigPath, { theme: "dark" });
    delete input.expectedEmail;
    delete input.expectedAccountUuid;
    await expect(
      switchClaudeCredentials(input, {
        afterPhase: async (phase) => {
          if (phase === "prepared") throw new Error("crash");
        },
      }),
    ).rejects.toThrow("crash");
    expect((await FSJournal()).sourceIdentity).toEqual({});
    await recoverClaudeCredentialSwitch(input);
    expect(
      (await read(NodePath.join(input.activeHome, ".credentials.json"))).claudeAiOauth,
    ).toEqual(oauth("b"));
  });

  // H2: while the active identity is still the source, its token is the source lineage.
  it.each<ClaudeCredentialSwitchPhase>(["prepared", "source-saved"])(
    "adopts the refreshed source lineage after a %s crash instead of a stale store copy",
    async (phase) => {
      await expect(
        switchClaudeCredentials(input, {
          afterPhase: async (current) => {
            if (current === phase) throw new Error("crash");
          },
        }),
      ).rejects.toThrow("crash");
      await write(NodePath.join(input.activeHome, ".credentials.json"), {
        claudeAiOauth: oauth("a-refreshed"),
        mcpOAuth: { keep: "active" },
      });
      const journal = await FSJournal();
      expect(journal.targetFingerprint).toMatch(/^[0-9a-f]{16}$/);
      expect(JSON.stringify(journal)).not.toContain("refresh-");
      await recoverClaudeCredentialSwitch(input);
      expect(
        (await read(NodePath.join(input.sourceStore, ".credentials.json"))).claudeAiOauth,
      ).toEqual(oauth("a-refreshed"));
      expect(
        (await read(NodePath.join(input.activeHome, ".credentials.json"))).claudeAiOauth,
      ).toEqual(oauth("b"));
      expect(
        (await read(NodePath.join(input.targetStore, ".credentials.json"))).claudeAiOauth,
      ).toBeUndefined();
      expect(await recoverClaudeCredentialSwitch(input)).toBeUndefined();
    },
  );

  it("fails closed after an activating crash when the active token matches neither lineage", async () => {
    await expect(
      switchClaudeCredentials(input, {
        afterPhase: async (current) => {
          if (current === "activating") throw new Error("crash");
        },
      }),
    ).rejects.toThrow("crash");
    // Identity still says A, but the token could be refreshed-A or refreshed-B.
    await write(NodePath.join(input.activeHome, ".credentials.json"), {
      claudeAiOauth: oauth("unknown"),
    });
    await expect(recoverClaudeCredentialSwitch(input)).rejects.toThrow("recovery left untouched");
    expect(
      (await read(NodePath.join(input.sourceStore, ".credentials.json"))).claudeAiOauth,
    ).toEqual(oauth("a"));
    expect(
      (await read(NodePath.join(input.targetStore, ".credentials.json"))).claudeAiOauth,
    ).toEqual(oauth("b"));
    expect(
      (await read(NodePath.join(input.activeHome, ".credentials.json"))).claudeAiOauth,
    ).toEqual(oauth("unknown"));
  });

  it("never deletes a target store token whose fingerprint differs from the moved duplicate", async () => {
    await expect(
      switchClaudeCredentials(input, {
        afterPhase: async (current) => {
          if (current === "activated") throw new Error("crash");
        },
      }),
    ).rejects.toThrow("crash");
    await write(NodePath.join(input.targetStore, ".credentials.json"), {
      claudeAiOauth: oauth("b-relogin"),
      mcpOAuth: { keep: "target" },
    });
    await expect(recoverClaudeCredentialSwitch(input)).rejects.toThrow("recovery left untouched");
    expect(
      (await read(NodePath.join(input.targetStore, ".credentials.json"))).claudeAiOauth,
    ).toEqual(oauth("b-relogin"));
    expect((await FSJournal()).phase).toBe("activated");
    // An already checked-out store is simply confirmed.
    await write(NodePath.join(input.targetStore, ".credentials.json"), {
      mcpOAuth: { keep: "target" },
    });
    await recoverClaudeCredentialSwitch(input);
    await assertMoved();
  });

  it("writes every .claude.json under Claude's config lock, acquired inside the credential locks", async () => {
    let credentialLocksHeld = 0;
    const configLocked: string[] = [];
    await switchClaudeCredentials(input, {
      locks: async (_homes, operation) => {
        credentialLocksHeld++;
        try {
          return await operation(() => undefined);
        } finally {
          credentialLocksHeld--;
        }
      },
      configLock: async (path, operation) => {
        expect(credentialLocksHeld).toBeGreaterThan(0);
        configLocked.push(path);
        // A concurrent Claude write landing right before our turn must survive the re-read.
        const current = await read(path).catch(() => ({}));
        await write(path, { ...current, concurrent: path });
        return operation(() => undefined);
      },
    });
    expect(configLocked).toEqual([
      NodePath.join(input.sourceStore, ".claude.json"),
      input.activeConfigPath,
    ]);
    expect(await read(input.activeConfigPath)).toMatchObject({
      oauthAccount: account("b"),
      theme: "dark",
      concurrent: input.activeConfigPath,
    });
    expect(await read(NodePath.join(input.sourceStore, ".claude.json"))).toMatchObject({
      oauthAccount: account("a"),
      concurrent: NodePath.join(input.sourceStore, ".claude.json"),
    });
  });

  it("validates every payload against the storage limit before writing the journal", async () => {
    const validate = vi.fn((value: Record<string, unknown>) => {
      if ("claudeAiOauth" in value && JSON.stringify(value).includes("access-b"))
        throw new ClaudeCredentialSwitchError("too large");
    });
    await expect(
      switchClaudeCredentials(input, { credentials: { ...claudeFileCredentialAdapter, validate } }),
    ).rejects.toThrow("too large");
    expect(validate).toHaveBeenCalledTimes(2);
    await expect(NodeFSP.stat(journalPath())).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await read(NodePath.join(input.activeHome, ".credentials.json"))).claudeAiOauth,
    ).toEqual(oauth("a"));
    expect(
      (await read(NodePath.join(input.sourceStore, ".credentials.json"))).claudeAiOauth,
    ).toBeUndefined();
  });

  it("rejects oversized keychain payloads and bounds hung security calls", async () => {
    const adapter = createClaudeKeychainCredentialAdapter(
      { read: async () => undefined, write: async () => undefined },
      "test-user",
    );
    expect(() => adapter.validate!({ claudeAiOauth: oauth("a") })).not.toThrow();
    expect(() => adapter.validate!({ claudeAiOauth: { accessToken: "x".repeat(3_000) } })).toThrow(
      "too large for safe Keychain storage",
    );
    const script = NodePath.join(root, "security");
    await NodeFSP.writeFile(script, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
    const keychain = createSystemClaudeKeychain({ executable: script, timeoutMs: 200 });
    const started = Date.now();
    await expect(keychain.read("svc", "acct")).rejects.toThrow(
      "Unable to read Claude credentials from macOS Keychain.",
    );
    await expect(keychain.write("svc", "acct", "{}")).rejects.toThrow(
      "Unable to write Claude credentials to macOS Keychain.",
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("discards a freshly created source entry when validation fails before the journal", async () => {
    await write(input.activeConfigPath, { oauthAccount: account("c") });
    await write(NodePath.join(input.activeHome, ".credentials.json"), {
      claudeAiOauth: oauth("c"),
    });
    await write(NodePath.join(input.targetStore, ".credentials.json"), {});
    const external = NodePath.join(input.managedRoot, "c");
    await NodeFSP.mkdir(external);
    const discard = vi.fn(async () => undefined);
    input.resolveSource = async () => ({ store: external, accountId: "c", discard });
    await expect(switchClaudeCredentials(input)).rejects.toThrow("signed out");
    expect(discard).toHaveBeenCalledTimes(1);
    await expect(NodeFSP.stat(journalPath())).rejects.toMatchObject({ code: "ENOENT" });
    await write(NodePath.join(input.targetStore, ".credentials.json"), {
      claudeAiOauth: oauth("b"),
    });
    discard.mockClear();
    await switchClaudeCredentials(input);
    expect(discard).not.toHaveBeenCalled();
  });

  it("does not replace active credentials after losing a held lock during preparation", async () => {
    let held = true;
    const credentials: ClaudeCredentialAdapter = {
      read: claudeFileCredentialAdapter.read,
      async write(location, value, assertHeld) {
        if (location.home === input.activeHome) held = false;
        await claudeFileCredentialAdapter.write(location, value, assertHeld);
      },
    };
    await expect(
      switchClaudeCredentials(input, {
        credentials,
        locks: async (_homes, operation) =>
          operation(() => {
            if (!held) throw new Error("lost lock");
          }),
      }),
    ).rejects.toThrow("lost lock");
    expect(
      (await read(NodePath.join(input.activeHome, ".credentials.json"))).claudeAiOauth,
    ).toEqual(oauth("a"));
  });

  it("rejects a silently ignored keychain write before considering it durable", async () => {
    const credentials = createClaudeKeychainCredentialAdapter(
      {
        read: async () => undefined,
        write: async () => undefined,
      },
      "test-user",
    );
    await expect(credentials.write({ home: root }, { claudeAiOauth: oauth("a") })).rejects.toThrow(
      "Unable to write Claude credentials to macOS Keychain.",
    );
  });

  it("preserves an existing source lineage and identity when the active home is signed out", async () => {
    await write(NodePath.join(input.activeHome, ".credentials.json"), {});
    await write(NodePath.join(input.sourceStore, ".credentials.json"), {
      claudeAiOauth: oauth("saved-a"),
    });
    await write(NodePath.join(input.sourceStore, ".claude.json"), {
      oauthAccount: account("saved-a"),
      unrelated: true,
    });
    await switchClaudeCredentials(input);
    expect(
      (await read(NodePath.join(input.sourceStore, ".credentials.json"))).claudeAiOauth,
    ).toEqual(oauth("saved-a"));
    expect(await read(NodePath.join(input.sourceStore, ".claude.json"))).toEqual({
      oauthAccount: account("saved-a"),
      unrelated: true,
    });
  });

  it("uses the exact default/configured naming distinction and NFC path hash", () => {
    expect(claudeCredentialKeychainService()).toBe("Claude Code-credentials");
    expect(claudeCredentialKeychainService("")).toBe("Claude Code-credentials");
    expect(claudeCredentialKeychainService("/tmp/claude")).toBe("Claude Code-credentials-21493821");
    expect(claudeCredentialKeychainService("/tmp/café")).toBe(
      claudeCredentialKeychainService("/tmp/café"),
    );
    vi.stubEnv("USER", "unsafe user");
    expect(claudeCredentialKeychainAccount()).toBe("claude-code-user");
    vi.stubEnv("USER", "valid-user.name_1");
    expect(claudeCredentialKeychainAccount()).toBe("valid-user.name_1");
  });
});
