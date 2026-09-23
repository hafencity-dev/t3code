// fork: provider accounts — CLI-owned credentials, never copied between homes.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { Schema } from "effect";
import { expandHomePath } from "../../pathExpansion.ts";

export interface ProviderAccountLoginInput {
  readonly driver: "claudeAgent" | "codex";
  readonly accountId?: string | undefined;
  readonly label?: string | undefined;
  readonly email?: string | undefined;
}

export interface PreparedProviderAccountLogin {
  readonly accountId: string;
  readonly driver: ProviderAccountLoginInput["driver"];
  readonly homePath: string;
  readonly existing: boolean;
  readonly claudeActive?: boolean;
  readonly binaryPath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

export interface ProviderAccountLoginIdentity {
  readonly email: string;
  readonly plan?: string;
}

export type ProviderAccountLoginEvent =
  | { readonly _tag: "started"; readonly loginId: string; readonly accountId: string }
  | { readonly _tag: "browser"; readonly url: string; readonly needsCode: true }
  | { readonly _tag: "deviceCode"; readonly url: string; readonly userCode: string }
  | { readonly _tag: "verifying" }
  | { readonly _tag: "completed"; readonly accountId: string; readonly email: string }
  | { readonly _tag: "failed"; readonly message: string };

type LoginPrompt = Extract<ProviderAccountLoginEvent, { _tag: "browser" | "deviceCode" }>;

/** Retain bounded raw output so split terminal escapes and URLs are parsed together. */
export class ProviderAccountLoginParser {
  #raw = "";
  #emitted = false;
  readonly driver: ProviderAccountLoginInput["driver"];
  constructor(driver: ProviderAccountLoginInput["driver"]) {
    this.driver = driver;
  }

  write(chunk: string, final = false): LoginPrompt | undefined {
    if (this.#emitted) return;
    this.#raw = (this.#raw + chunk).slice(-65_536);
    // Hide incomplete OSC / CSI sequences until their next chunk arrives.
    const text = NodeUtil.stripVTControlCharacters(
      // eslint-disable-next-line no-control-regex -- Match terminal escape sequences.
      this.#raw.replace(/\x1b(?:\][^\x07\x1b]*(?:\x1b)?|\[[0-?]*[ -/]*)$/u, ""),
    );
    const urlMatch = text.match(
      this.driver === "claudeAgent"
        ? /If the browser didn't open, visit:\s*(https:\/\/[^\s<>"']+)/u
        : /(https:\/\/auth\.openai\.com\/codex\/device[^\s<>"']*)/u,
    );
    if (!urlMatch || (!final && urlMatch.index! + urlMatch[0].length === text.length)) return;
    const url = urlMatch[1]!;
    if (this.driver === "claudeAgent") {
      this.#emitted = true;
      return { _tag: "browser", url, needsCode: true };
    }
    // Native Codex prints the code on the next line, the bridge prints `code:`.
    const userCode = text.match(
      /(?:enter this (?:one-time )?code[^\r\n]*[\r\n]+\s*|(?:device code|code):\s*)([A-Z0-9]{4}-[A-Z0-9]{5})(?=\s|$)/iu,
    )?.[1];
    if (!userCode || !/^https:\/\/auth\.openai\.com\/codex\/device(?:[/?#]|$)/u.test(url)) return;
    this.#emitted = true;
    return { _tag: "deviceCode", url, userCode };
  }
}

export interface ProviderAccountLoginOptions {
  /** Creates the final isolated home and pending registry entry. Must undo partial failures. */
  readonly prepare: (input: ProviderAccountLoginInput) => Promise<PreparedProviderAccountLogin>;
  /** Persists identity; returns a safe conflict message when an existing account cannot be ready. */
  readonly complete: (
    account: PreparedProviderAccountLogin,
    identity: ProviderAccountLoginIdentity,
  ) => Promise<void | { readonly message: string }>;
  /** Removes only a newly created pending registry entry and its isolated home. */
  readonly cleanup: (account: PreparedProviderAccountLogin) => Promise<void>;
  readonly spawn?: (
    binary: string,
    args: string[],
    options: NodeChildProcess.SpawnOptionsWithoutStdio,
  ) => NodeChildProcess.ChildProcessWithoutNullStreams;
  readonly readAuthFile?: (path: string) => Promise<string>;
  readonly baseEnvironment?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

interface LoginSession {
  readonly owner: string;
  readonly controller: AbortController;
  readonly done: Promise<void>;
  readonly finish: () => void;
  child?: NodeChildProcess.ChildProcessWithoutNullStreams;
  acceptsCode: boolean;
  accountId?: string;
}

const ClaudeStatus = Schema.Struct({
  loggedIn: Schema.Boolean,
  email: Schema.optional(Schema.String),
});
const CodexAuth = Schema.Struct({ tokens: Schema.Struct({ id_token: Schema.String }) });
const CodexClaims = Schema.Struct({
  email: Schema.String,
  "https://api.openai.com/auth": Schema.optional(
    Schema.Struct({ chatgpt_plan_type: Schema.optional(Schema.String) }),
  ),
});

const decodeClaudeStatus = Schema.decodeUnknownSync(Schema.fromJsonString(ClaudeStatus));
const decodeCodexAuth = Schema.decodeUnknownSync(Schema.fromJsonString(CodexAuth));
const decodeCodexClaims = Schema.decodeUnknownSync(Schema.fromJsonString(CodexClaims));

class LoginFailure extends Error {}

/** Promise lifecycle adapter; the RPC stream owns its AbortSignal and awaits teardown. */
export class ProviderAccountLogin {
  readonly #options: ProviderAccountLoginOptions;
  readonly #sessions = new Map<string, LoginSession>();
  readonly #busy = new Set<string>();

  constructor(options: ProviderAccountLoginOptions) {
    this.#options = options;
  }

  async start(
    owner: string,
    input: ProviderAccountLoginInput,
    emit: (event: ProviderAccountLoginEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const key = `${input.driver}:${input.accountId ?? "new"}`;
    if (this.#busy.has(key)) {
      emit({ _tag: "failed", message: "A sign-in for this account is already running." });
      return;
    }
    this.#busy.add(key);
    const loginId = NodeCrypto.randomUUID();
    const controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const session: LoginSession = {
      owner,
      controller,
      done,
      finish,
      acceptsCode: false,
      ...(input.accountId ? { accountId: input.accountId } : {}),
    };
    this.#sessions.set(loginId, session);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timeout = setTimeout(abort, this.#options.timeoutMs ?? 10 * 60_000);
    timeout.unref();
    let account: PreparedProviderAccountLogin | undefined;
    let committed = false;
    try {
      this.#checkCancelled(controller.signal);
      account = await this.#options.prepare(input);
      session.accountId = account.accountId;
      this.#checkCancelled(controller.signal);
      emit({ _tag: "started", loginId, accountId: account.accountId });
      const environment = this.#environment(account);
      const args =
        account.driver === "claudeAgent"
          ? ["auth", "login", "--claudeai", ...(input.email ? ["--email", input.email] : [])]
          : ["login", "--device-auth"];
      const parsers = {
        stdout: new ProviderAccountLoginParser(account.driver),
        stderr: new ProviderAccountLoginParser(account.driver),
      };
      let promptEmitted = false;
      const code = await this.#run(
        account,
        args,
        environment,
        controller.signal,
        session,
        (chunk, source, final) => {
          const prompt = parsers[source].write(chunk, final);
          if (prompt && !promptEmitted) {
            promptEmitted = true;
            session.acceptsCode = prompt._tag === "browser";
            emit(prompt);
          }
        },
      );
      session.acceptsCode = false;
      if (code !== 0) throw new LoginFailure("Provider sign-in failed. Please try again.");
      this.#checkCancelled(controller.signal);
      emit({ _tag: "verifying" });
      const identity = await this.#verify(account, environment, controller.signal, session);
      this.#checkCancelled(controller.signal);
      // The registry callback owns serialization of duplicate checks and persistence.
      const result = await this.#options.complete(account, identity).catch(() => {
        throw new LoginFailure("Unable to save this account. It may already be saved.");
      });
      if (result) throw new LoginFailure(result.message);
      committed = true;
      emit({ _tag: "completed", accountId: account.accountId, email: identity.email });
    } catch (error) {
      // Never forward CLI output or arbitrary errors: either can contain credentials.
      emit({
        _tag: "failed",
        message: controller.signal.aborted
          ? "Sign-in was cancelled or timed out."
          : error instanceof LoginFailure
            ? error.message
            : "Unable to sign in. Please try again.",
      });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      session.acceptsCode = false;
      try {
        if (account && !committed && !account.existing) {
          await this.#discard(account);
        }
      } finally {
        this.#sessions.delete(loginId);
        this.#busy.delete(key);
        session.finish();
      }
    }
  }

  async submitCode(owner: string, loginId: string, code: string): Promise<void> {
    const session = this.#owned(owner, loginId);
    if (!session.acceptsCode || !session.child || session.controller.signal.aborted)
      throw new Error("This sign-in is not waiting for a code.");
    // eslint-disable-next-line no-control-regex -- Reject line injection into CLI stdin.
    if (!code.trim() || code.length > 8192 || /[\r\n\x00]/u.test(code))
      throw new Error("Invalid sign-in code.");
    const child = session.child;
    session.acceptsCode = false;
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(`${code.trim()}\n`, (error) =>
        error ? reject(new Error("Unable to submit sign-in code.")) : resolve(),
      );
    });
  }

  async cancel(owner: string, loginId: string): Promise<void> {
    const session = this.#owned(owner, loginId);
    session.controller.abort();
    await session.done;
  }

  #owned(owner: string, loginId: string): LoginSession {
    const session = this.#sessions.get(loginId);
    if (!session || session.owner !== owner) throw new Error("Sign-in session not found.");
    return session;
  }

  #checkCancelled(signal: AbortSignal) {
    if (signal.aborted) throw new LoginFailure("Sign-in was cancelled or timed out.");
  }

  #environment(account: PreparedProviderAccountLogin): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...(this.#options.baseEnvironment ?? process.env),
      ...account.environment,
      BROWSER: "true",
    };
    if (account.driver === "claudeAgent") {
      if (!account.claudeActive) {
        env.CLAUDE_CONFIG_DIR = account.homePath;
        delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
      }
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
    } else env.CODEX_HOME = account.homePath;
    return env;
  }

  #run(
    account: PreparedProviderAccountLogin,
    args: string[],
    env: NodeJS.ProcessEnv,
    signal: AbortSignal,
    session?: LoginSession,
    consume?: (chunk: string, source: "stdout" | "stderr", final: boolean) => void,
  ): Promise<number | null> {
    this.#checkCancelled(signal);
    const child = (this.#options.spawn ?? NodeChildProcess.spawn)(
      expandHomePath(account.binaryPath ?? (account.driver === "claudeAgent" ? "claude" : "codex")),
      args,
      {
        env,
        ...(account.cwd ? { cwd: account.cwd } : {}),
        stdio: "pipe",
        windowsHide: true,
      },
    );
    if (session) session.child = child;
    return new Promise((resolve, reject) => {
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => {
        child.kill("SIGTERM");
        killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000);
        killTimer.unref();
      };
      const cleanup = () => {
        signal.removeEventListener("abort", abort);
        if (killTimer) clearTimeout(killTimer);
        if (session?.child === child) delete session.child;
      };
      // Decode multibyte chunks without corrupting URL bytes.
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => consume?.(chunk, "stdout", false));
      child.stderr.on("data", (chunk: string) => consume?.(chunk, "stderr", false));
      child.stdin.on("error", () => {
        /* The close event handles a provider closing stdin. */
      });
      child.once("error", () => {
        cleanup();
        reject(new LoginFailure("Unable to launch provider CLI."));
      });
      child.once("close", (code) => {
        cleanup();
        consume?.("", "stdout", true);
        consume?.("", "stderr", true);
        if (signal.aborted) reject(new LoginFailure("Sign-in was cancelled or timed out."));
        else resolve(code);
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  async #verify(
    account: PreparedProviderAccountLogin,
    env: NodeJS.ProcessEnv,
    signal: AbortSignal,
    session: LoginSession,
  ): Promise<ProviderAccountLoginIdentity> {
    if (account.driver === "claudeAgent") {
      let output = "";
      const code = await this.#run(
        account,
        ["auth", "status", "--json"],
        env,
        signal,
        session,
        (chunk, source) => {
          if (source === "stdout") output = (output + chunk).slice(-65_536);
        },
      );
      if (code !== 0) throw new LoginFailure("Could not verify Claude sign-in.");
      const status = decodeClaudeStatus(output);
      if (!status.loggedIn || !status.email?.trim())
        throw new LoginFailure("Claude did not report a signed-in account.");
      return { email: status.email.trim() };
    }
    let raw: string;
    try {
      raw = await (this.#options.readAuthFile ?? ((path) => NodeFSP.readFile(path, "utf8")))(
        NodePath.join(account.homePath, "auth.json"),
      );
    } catch {
      throw new LoginFailure(
        "Codex did not create auth.json. Keyring credential storage is unsupported; configure file storage and try again.",
      );
    }
    const auth = decodeCodexAuth(raw);
    const payload = auth.tokens.id_token.split(".")[1];
    if (!payload) throw new LoginFailure("Could not read the signed-in Codex identity.");
    // Claims are display-only; the CLI, not this unverified JWT, owns authentication.
    const claims = decodeCodexClaims(Buffer.from(payload, "base64url").toString("utf8"));
    if (!claims.email.trim()) throw new LoginFailure("Codex did not report an account email.");
    const plan = claims["https://api.openai.com/auth"]?.chatgpt_plan_type;
    return { email: claims.email.trim(), ...(plan ? { plan } : {}) };
  }

  isBusy(accountId: string): boolean {
    return Array.from(this.#sessions.values()).some((session) => session.accountId === accountId);
  }

  async #discard(account: PreparedProviderAccountLogin): Promise<void> {
    try {
      await this.logout(account);
    } catch {
      /* Still remove pending files if the CLI cannot log out. */
    }
    try {
      await this.#options.cleanup(account);
    } catch {
      throw new LoginFailure("Unable to remove the pending account's credentials.");
    }
  }

  /** Explicit account removal must not silently ignore keychain logout failures. */
  async logout(account: PreparedProviderAccountLogin): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    timer.unref();
    try {
      const code = await this.#run(
        account,
        account.driver === "claudeAgent" ? ["auth", "logout"] : ["logout"],
        this.#environment(account),
        controller.signal,
      );
      if (code !== 0)
        throw new LoginFailure("Provider logout failed. The account was not removed.");
    } finally {
      clearTimeout(timer);
    }
  }
}
