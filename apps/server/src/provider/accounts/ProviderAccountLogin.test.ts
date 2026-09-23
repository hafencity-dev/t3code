// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import { describe, expect, it, vi } from "@effect/vitest";
import {
  ProviderAccountLogin,
  ProviderAccountLoginParser,
  type PreparedProviderAccountLogin,
  type ProviderAccountLoginEvent,
  type ProviderAccountLoginOptions,
} from "./ProviderAccountLogin.ts";

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeChild() {
  const child = Object.assign(new NodeChildProcess.ChildProcess(), {
    stdin: new NodeStream.PassThrough(),
    stdout: new NodeStream.PassThrough(),
    stderr: new NodeStream.PassThrough(),
  }) as NodeChildProcess.ChildProcessWithoutNullStreams & {
    stdin: NodeStream.PassThrough;
    stdout: NodeStream.PassThrough;
    stderr: NodeStream.PassThrough;
  };
  const kill = vi.spyOn(child, "kill").mockImplementation(() => {
    queueMicrotask(() => child.emit("close", null, "SIGTERM"));
    return true;
  });
  return { child, kill };
}

function fixture(overrides: Partial<ProviderAccountLoginOptions> = {}, existing = false) {
  const account: PreparedProviderAccountLogin = {
    accountId: "account-1",
    driver: "claudeAgent",
    homePath: "/isolated/account-1",
    existing,
  };
  const spawned = deferred<ReturnType<typeof fakeChild>["child"]>();
  const verifying = deferred<ReturnType<typeof fakeChild>["child"]>();
  const events: ProviderAccountLoginEvent[] = [];
  const children: ReturnType<typeof fakeChild>[] = [];
  const prepare = vi.fn(async () => account);
  const complete = vi.fn(async () => {});
  const cleanup = vi.fn(async () => {});
  const spawn = vi.fn<NonNullable<ProviderAccountLoginOptions["spawn"]>>((_binary, args) => {
    const item = fakeChild();
    children.push(item);
    queueMicrotask(() => {
      if (args.includes("logout")) item.child.emit("close", 0, null);
      else if (args.includes("status")) verifying.resolve(item.child);
      else spawned.resolve(item.child);
    });
    return item.child;
  });
  const login = new ProviderAccountLogin({
    prepare,
    complete,
    cleanup,
    spawn,
    baseEnvironment: {},
    ...overrides,
  });
  const start = (signal?: AbortSignal) =>
    login.start("owner", { driver: account.driver }, (event) => events.push(event), signal);
  const loginId = () => {
    const event = events.find((event) => event._tag === "started");
    if (event?._tag !== "started") throw new Error("Missing start event");
    return event.loginId;
  };
  return {
    account,
    spawned,
    verifying,
    events,
    children,
    prepare,
    complete,
    cleanup,
    spawn,
    login,
    start,
    loginId,
  };
}

const claudePrompt =
  "If the browser didn't open, visit: https://claude.ai/oauth/authorize?state=example\nPaste code here if prompted > ";
const codexPrompt =
  "\nWelcome to Codex [v\x1b[90m0.155.1\x1b[0m]\n\x1b[90mOpenAI's command-line coding agent\x1b[0m\n\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mABCD-EFGHI\x1b[0m\n\n\x1b[90mContinue only if you started this login in Codex. If a website or another person gave you this code, cancel.\x1b[0m\n";

function codexAuth() {
  const payload = Buffer.from(
    JSON.stringify({
      email: "person@example.test",
      "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
    }),
  ).toString("base64url");
  return JSON.stringify({
    tokens: { id_token: `header.${payload}.signature`, access_token: "never-emit-token" },
  });
}

describe("ProviderAccountLoginParser", () => {
  it("parses every split of Claude's URL and terminal escapes only once", () => {
    const raw = `\x1b]0;window title\x07\x1b[32m${claudePrompt}\x1b[0m`;
    for (let split = 0; split < raw.length; split++) {
      const parser = new ProviderAccountLoginParser("claudeAgent");
      const events = [parser.write(raw.slice(0, split)), parser.write(raw.slice(split))].filter(
        Boolean,
      );
      expect(events).toEqual([
        {
          _tag: "browser",
          url: "https://claude.ai/oauth/authorize?state=example",
          needsCode: true,
        },
      ]);
      expect(parser.write(raw)).toBeUndefined();
    }
  });

  it("strips OSC hyperlinks terminated by ST, including split escapes", () => {
    const raw = `\x1b]8;;https://hidden.example/\x1b\\label\x1b]8;;\x1b\\\n${claudePrompt}`;
    for (let split = 0; split < raw.length; split++) {
      const parser = new ProviderAccountLoginParser("claudeAgent");
      const events = [parser.write(raw.slice(0, split)), parser.write(raw.slice(split))].filter(
        Boolean,
      );
      expect(events).toEqual([
        {
          _tag: "browser",
          url: "https://claude.ai/oauth/authorize?state=example",
          needsCode: true,
        },
      ]);
    }
  });

  it("parses the native Codex numbered prompt across every chunk boundary", () => {
    for (let split = 0; split < codexPrompt.length; split++) {
      const parser = new ProviderAccountLoginParser("codex");
      const events = [
        parser.write(codexPrompt.slice(0, split)),
        parser.write(codexPrompt.slice(split)),
      ].filter(Boolean);
      expect(events).toEqual([
        { _tag: "deviceCode", url: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGHI" },
      ]);
    }
  });

  it("does not accept an unrelated hyphenated word or a partial URL", () => {
    const parser = new ProviderAccountLoginParser("codex");
    expect(parser.write("https://auth.openai.com/codex/device\nABCD-EFGHI\n")).toBeUndefined();
    const claude = new ProviderAccountLoginParser("claudeAgent");
    expect(
      claude.write("If the browser didn't open, visit: https://claude.ai/oauth/auth"),
    ).toBeUndefined();
    expect(claude.write("orize?state=example\n")).toMatchObject({
      url: "https://claude.ai/oauth/authorize?state=example",
    });
  });
});

describe("ProviderAccountLogin", () => {
  it.each(["claudeAgent", "codex"] as const)(
    "expands the configured %s binary home path for login, verification, and logout",
    async (driver) => {
      const f = fixture({ readAuthFile: async () => codexAuth() });
      const account = { ...f.account, driver, binaryPath: "~/.local/bin/provider" };
      f.prepare.mockResolvedValue(account);
      const running = f.login.start("owner", { driver }, (event) => f.events.push(event));
      (await f.spawned.promise).emit("close", 0, null);
      if (driver === "claudeAgent") {
        const status = await f.verifying.promise;
        status.stdout.write('{"loggedIn":true,"email":"person@example.test"}');
        status.emit("close", 0, null);
      }
      await running;
      expect(f.events.at(-1)).toMatchObject({ _tag: "completed" });
      await f.login.logout(account);
      expect(f.spawn.mock.calls.map(([binary, args]) => ({ binary, args }))).toEqual(
        (driver === "claudeAgent"
          ? [
              ["auth", "login", "--claudeai"],
              ["auth", "status", "--json"],
              ["auth", "logout"],
            ]
          : [["login", "--device-auth"], ["logout"]]
        ).map((args) => ({ binary: NodePath.join(NodeOS.homedir(), ".local/bin/provider"), args })),
      );
    },
  );

  it.each(["cancel", "failure"] as const)(
    "discards a pending managed re-login on %s even when input includes its account ID",
    async (outcome) => {
      const f = fixture();
      const running = f.login.start(
        "owner",
        { driver: f.account.driver, accountId: f.account.accountId },
        (event) => f.events.push(event),
      );
      const child = await f.spawned.promise;
      if (outcome === "cancel") await f.login.cancel("owner", f.loginId());
      else child.emit("close", 1, null);
      await running;
      expect(f.events.at(-1)).toMatchObject({ _tag: "failed" });
      expect(f.spawn.mock.calls[1]?.[1]).toEqual(["auth", "logout"]);
      expect(f.cleanup).toHaveBeenCalledExactlyOnceWith(f.account);
      expect(f.complete).not.toHaveBeenCalled();
      expect(f.login.isBusy(f.account.accountId)).toBe(false);
    },
  );

  it.each([
    { name: "default unset directories", environment: {} },
    { name: "explicit config directory", environment: { CLAUDE_CONFIG_DIR: "/active/claude" } },
    {
      name: "secure storage override",
      environment: {
        CLAUDE_CONFIG_DIR: "/active/claude",
        CLAUDE_SECURESTORAGE_CONFIG_DIR: "/active/secure",
      },
    },
    {
      name: "secure storage override without config directory",
      environment: { CLAUDE_SECURESTORAGE_CONFIG_DIR: "/active/secure" },
    },
  ])("preserves active Claude $name for login and verification", async ({ environment }) => {
    const f = fixture(
      { baseEnvironment: { KEEP: "yes", CLAUDE_CODE_OAUTH_TOKEN: "secret" } },
      true,
    );
    const account = { ...f.account, claudeActive: true, environment };
    f.prepare.mockResolvedValue(account);
    const running = f.start();
    (await f.spawned.promise).emit("close", 0, null);
    const status = await f.verifying.promise;
    status.stdout.write('{"loggedIn":true,"email":"person@example.test"}');
    status.emit("close", 0, null);
    await running;

    expect(f.events.at(-1)).toMatchObject({ _tag: "completed" });
    expect(f.spawn).toHaveBeenCalledTimes(2);
    for (const [, , options] of f.spawn.mock.calls) {
      expect(options.env).toEqual({ KEEP: "yes", ...environment, BROWSER: "true" });
    }
    expect(f.cleanup).not.toHaveBeenCalled();
  });

  it("binds codes to their session, writes stdin, then verifies before saving", async () => {
    const f = fixture({
      baseEnvironment: {
        KEEP: "yes",
        CLAUDE_CODE_OAUTH_TOKEN: "secret",
        CLAUDE_SECURESTORAGE_CONFIG_DIR: "/wrong",
      },
    });
    const running = f.start();
    const child = await f.spawned.promise;
    child.stdout.write(claudePrompt);
    await expect(f.login.submitCode("intruder", f.loginId(), "secret-code#state")).rejects.toThrow(
      "not found",
    );
    await expect(f.login.cancel("intruder", f.loginId())).rejects.toThrow("not found");
    await expect(f.login.submitCode("owner", f.loginId(), "code\nlogout")).rejects.toThrow(
      "Invalid",
    );
    await f.login.submitCode("owner", f.loginId(), "secret-code#state");
    expect(child.stdin.read()?.toString()).toBe("secret-code#state\n");
    expect(f.spawn.mock.calls[0]?.[2].env).toEqual({
      KEEP: "yes",
      BROWSER: "true",
      CLAUDE_CONFIG_DIR: f.account.homePath,
    });
    child.emit("close", 0, null);
    const status = await f.verifying.promise;
    expect(f.events.at(-1)).toEqual({ _tag: "verifying" });
    expect(f.complete).not.toHaveBeenCalled();
    status.stdout.write(JSON.stringify({ loggedIn: true, email: "person@example.test" }));
    status.emit("close", 0, null);
    await running;
    expect(f.complete).toHaveBeenCalledWith(f.account, { email: "person@example.test" });
    expect(f.cleanup).not.toHaveBeenCalled();
    expect(f.events.at(-1)).toMatchObject({ _tag: "completed", email: "person@example.test" });
    expect(JSON.stringify(f.events)).not.toContain("secret-code");
    expect(f.spawn.mock.calls[1]?.[1]).toEqual(["auth", "status", "--json"]);
  });

  it("rejects another owner's concurrent sign-in and abort cleans up only after logout", async () => {
    const f = fixture();
    const controller = new AbortController();
    const running = f.start(controller.signal);
    await f.spawned.promise;
    await f.login.start("other-owner", { driver: f.account.driver }, (event) =>
      f.events.push(event),
    );
    expect(f.events.at(-1)).toMatchObject({
      _tag: "failed",
      message: expect.stringContaining("already running"),
    });
    controller.abort();
    await running;
    expect(f.children[0]?.kill).toHaveBeenCalledWith("SIGTERM");
    expect(f.spawn.mock.calls[1]?.[1]).toEqual(["auth", "logout"]);
    expect(f.cleanup).toHaveBeenCalledExactlyOnceWith(f.account);
    expect(f.complete).not.toHaveBeenCalled();
  });

  it("replaces the same owner's login only after the interrupted session finishes cleanup", async () => {
    const cleaning = deferred<void>();
    const releaseCleanup = deferred<void>();
    const replacementStarted = deferred<string>();
    const f = fixture({
      cleanup: async () => {
        cleaning.resolve();
        await releaseCleanup.promise;
      },
    });
    const originalAbort = new AbortController();
    const original = f.start(originalAbort.signal);
    await f.spawned.promise;
    const replacementAbort = new AbortController();
    const events: ProviderAccountLoginEvent[] = [];
    const replacement = f.login.start(
      "owner",
      { driver: f.account.driver },
      (event) => {
        events.push(event);
        if (event._tag === "started") replacementStarted.resolve(event.loginId);
      },
      replacementAbort.signal,
    );
    // Replacement must abort the old child even before its RPC cancellation arrives.
    expect(f.children[0]?.kill).toHaveBeenCalledWith("SIGTERM");
    await cleaning.promise;
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
    const outsider: ProviderAccountLoginEvent[] = [];
    await f.login.start("other-owner", { driver: f.account.driver }, (event) =>
      outsider.push(event),
    );
    expect(outsider).toEqual([
      { _tag: "failed", message: "A sign-in for this account is already running." },
    ]);
    releaseCleanup.resolve();
    await original;
    const id = await replacementStarted.promise;
    expect(id).not.toBe(f.loginId());
    expect(f.prepare).toHaveBeenCalledTimes(2);
    originalAbort.abort();
    expect(events.some((event) => event._tag === "failed")).toBe(false);
    replacementAbort.abort();
    await replacement;
  });

  it("reports a persisted re-login identity conflict without completing or removing the account", async () => {
    const message =
      "Signed in as person@example.test, which is already saved as Work. Sign in again with the right account.";
    const complete = vi.fn(async () => ({ message }));
    const f = fixture({ complete }, true);
    const running = f.login.start(
      "owner",
      { driver: f.account.driver, accountId: f.account.accountId },
      (event) => f.events.push(event),
    );
    (await f.spawned.promise).emit("close", 0, null);
    const status = await f.verifying.promise;
    status.stdout.write('{"loggedIn":true,"email":"person@example.test"}');
    status.emit("close", 0, null);
    await running;
    expect(complete).toHaveBeenCalledExactlyOnceWith(f.account, { email: "person@example.test" });
    expect(f.events.at(-1)).toEqual({ _tag: "failed", message });
    expect(f.events.some((event) => event._tag === "completed")).toBe(false);
    expect(f.cleanup).not.toHaveBeenCalled();
    expect(f.spawn).toHaveBeenCalledTimes(2);
    expect(f.login.isBusy(f.account.accountId)).toBe(false);
  });

  it("cancel waits for teardown, but never logs out or removes an existing home", async () => {
    const f = fixture({}, true);
    const running = f.start();
    await f.spawned.promise;
    await f.login.cancel("owner", f.loginId());
    await running;
    expect(f.children[0]?.kill).toHaveBeenCalledWith("SIGTERM");
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.cleanup).not.toHaveBeenCalled();
    await expect(f.login.cancel("owner", f.loginId())).rejects.toThrow("not found");
  });

  it("cancellation during home preparation cleans the prepared home without launching login", async () => {
    const ready = deferred<PreparedProviderAccountLogin>();
    const f = fixture({ prepare: () => ready.promise });
    const controller = new AbortController();
    const running = f.start(controller.signal);
    controller.abort();
    ready.resolve(f.account);
    await running;
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.spawn.mock.calls[0]?.[1]).toEqual(["auth", "logout"]);
    expect(f.cleanup).toHaveBeenCalledExactlyOnceWith(f.account);
  });

  it("verifies Codex file credentials and rejects duplicate identity without leaking tokens", async () => {
    const f = fixture({
      readAuthFile: async () => codexAuth(),
      complete: async () => {
        throw new Error("duplicate never-emit-token");
      },
    });
    const account = { ...f.account, driver: "codex" as const };
    f.prepare.mockResolvedValue(account);
    const running = f.start();
    const child = await f.spawned.promise;
    child.stdout.write(codexPrompt);
    child.emit("close", 0, null);
    await running;
    expect(f.spawn.mock.calls[0]?.[1]).toEqual(["login", "--device-auth"]);
    expect(f.spawn.mock.calls[0]?.[2].env?.CODEX_HOME).toBe(account.homePath);
    expect(f.events).toContainEqual({
      _tag: "deviceCode",
      url: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGHI",
    });
    expect(f.events.at(-1)).toEqual({
      _tag: "failed",
      message: "Unable to save this account. It may already be saved.",
    });
    expect(f.cleanup).toHaveBeenCalledWith(account);
    expect(JSON.stringify(f.events)).not.toContain("never-emit-token");
  });

  it("reads only display identity from Codex ID-token claims", async () => {
    const readAuthFile = vi.fn(async () => codexAuth());
    const f = fixture({ readAuthFile });
    const account = { ...f.account, driver: "codex" as const };
    f.prepare.mockResolvedValue(account);
    const running = f.start();
    (await f.spawned.promise).emit("close", 0, null);
    await running;
    expect(readAuthFile).toHaveBeenCalledWith("/isolated/account-1/auth.json");
    expect(f.complete).toHaveBeenCalledWith(account, {
      email: "person@example.test",
      plan: "plus",
    });
    expect(f.cleanup).not.toHaveBeenCalled();
  });

  it("reports unsupported keyring storage when Codex writes no auth file", async () => {
    const f = fixture({
      readAuthFile: async () => {
        throw new Error("ENOENT");
      },
    });
    f.prepare.mockResolvedValue({ ...f.account, driver: "codex" });
    const running = f.start();
    (await f.spawned.promise).emit("close", 0, null);
    await running;
    expect(f.events.at(-1)).toMatchObject({
      _tag: "failed",
      message: expect.stringContaining("Keyring credential storage is unsupported"),
    });
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.cleanup).toHaveBeenCalledTimes(1);
  });

  it("does not trust successful process exit when Claude reports signed out", async () => {
    const f = fixture();
    const running = f.start();
    (await f.spawned.promise).emit("close", 0, null);
    const status = await f.verifying.promise;
    status.stdout.write('{"loggedIn":false,"email":"person@example.test"}');
    status.emit("close", 0, null);
    await running;
    expect(f.events.at(-1)).toMatchObject({ _tag: "failed" });
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.cleanup).toHaveBeenCalledTimes(1);
  });

  it("cleans up on spawn errors without forwarding sensitive error messages", async () => {
    const f = fixture();
    const running = f.start();
    (await f.spawned.promise).emit("error", new Error("never-emit-token"));
    await running;
    expect(f.events.at(-1)).toEqual({ _tag: "failed", message: "Unable to launch provider CLI." });
    expect(f.cleanup).toHaveBeenCalledTimes(1);
  });

  it("aborts the verification child and releases the account lock", async () => {
    const f = fixture();
    const controller = new AbortController();
    const running = f.start(controller.signal);
    (await f.spawned.promise).emit("close", 0, null);
    await f.verifying.promise;
    expect(f.login.isBusy(f.account.accountId)).toBe(true);
    controller.abort();
    await running;
    expect(f.children[1]?.kill).toHaveBeenCalledWith("SIGTERM");
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.cleanup).toHaveBeenCalledTimes(1);
    expect(f.login.isBusy(f.account.accountId)).toBe(false);
  });

  it("rejects failed explicit logout instead of reporting account removal as safe", async () => {
    const item = fakeChild();
    const f = fixture({ spawn: () => item.child });
    const logout = f.login.logout(f.account);
    item.child.stderr.write("secret-token-in-cli-error");
    item.child.emit("close", 1, null);
    await expect(logout).rejects.toThrow("Provider logout failed. The account was not removed.");
    expect(f.cleanup).not.toHaveBeenCalled();
  });

  it("skips home creation entirely when the stream was already cancelled", async () => {
    const f = fixture();
    await f.start(AbortSignal.abort());
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.events.at(-1)).toMatchObject({ _tag: "failed" });
  });

  it("timeouts terminate the captured child and clean up pending credentials", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture({ timeoutMs: 60_000 });
      const running = f.start();
      await f.spawned.promise;
      await vi.advanceTimersByTimeAsync(60_000);
      await running;
      expect(f.children[0]?.kill).toHaveBeenCalledWith("SIGTERM");
      expect(f.cleanup).toHaveBeenCalledTimes(1);
      expect(f.events.at(-1)).toMatchObject({
        _tag: "failed",
        message: expect.stringContaining("timed out"),
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
