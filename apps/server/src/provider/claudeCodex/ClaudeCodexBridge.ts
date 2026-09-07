// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
/**
 * Managed Codex compatibility bridge for Claude Code (fork feature f5).
 *
 * The pinned CLIProxyAPI runtime translates Anthropic Messages requests to a
 * user's Codex subscription. It is downloaded with an allowlisted URL and
 * verified SHA-256, binds only to loopback, and receives a random API key.
 * Claude traffic reaches it through `ClaudeCodexHybridRouter`, so ordinary
 * Claude model requests continue to Anthropic unchanged.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import type {
  ClaudeCodexBridgeModel,
  ClaudeCodexBridgeModelsResult,
  ClaudeCodexBridgeSignInEvent,
  ClaudeCodexBridgeStatus,
} from "@t3tools/contracts";
import { CLAUDE_CODEX_BRIDGE_VERSION } from "@t3tools/contracts";

import { effectiveClaudeCodexModel } from "@t3tools/shared/claudeCodexRouting";
import { ClaudeCodexHybridRouter } from "./HybridRouter.ts";

const fs = NodeFS;
const http = NodeHttp;
const https = NodeHttps;
const net = NodeNet;
const path = NodePath;
const { createHash, randomBytes } = NodeCrypto;
const spawn = NodeChildProcess.spawn;
type ChildProcess = NodeChildProcess.ChildProcess;
const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);

const RELEASE_BASE = `https://github.com/router-for-me/CLIProxyAPI/releases/download/v${CLAUDE_CODEX_BRIDGE_VERSION}`;
const DOWNLOAD_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);
const MAX_REDIRECTS = 5;
const MAX_RUNTIME_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MODEL_CACHE_TTL_MS = 5 * 60_000;
const MAX_MODEL_RESPONSE_BYTES = 1024 * 1024;
const FALLBACK_MODELS = [
  "gpt-6-astra",
  "gpt-5.6-sol",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini",
] as const;

const ARTIFACTS: Readonly<Record<string, { readonly file: string; readonly sha256: string }>> = {
  "darwin-arm64": {
    file: "CLIProxyAPI_7.2.154_darwin_aarch64.tar.gz",
    sha256: "90645a2d71bf7247e06b517757b498d0d0306afa9c48173aae7e2a230df2d546",
  },
  "darwin-x64": {
    file: "CLIProxyAPI_7.2.154_darwin_amd64.tar.gz",
    sha256: "62171996db7a9a2aa4ff00c68ba8255d7721790e34c6260f915631a9d44576e2",
  },
  "linux-arm64": {
    file: "CLIProxyAPI_7.2.154_linux_aarch64.tar.gz",
    sha256: "3a0cd18d64e3b9990ca72136dbb1da97eedddade00ee6768e8b49fab1de6925e",
  },
  "linux-x64": {
    file: "CLIProxyAPI_7.2.154_linux_amd64.tar.gz",
    sha256: "2a2256ceff048d5fa813aa54e8daa43e870b40e698d5cd21efad46e25aa5a1f9",
  },
  "win32-arm64": {
    file: "CLIProxyAPI_7.2.154_windows_aarch64.zip",
    sha256: "4d5166b256f13e814d087c98a8526ff42a5f83f63411025a679b31495a54cd19",
  },
  "win32-x64": {
    file: "CLIProxyAPI_7.2.154_windows_amd64.zip",
    sha256: "e50bd9362edb89d0816329f17372f00f1a68b8f72991cca41d39b4528c234563",
  },
};

interface CachedModelCatalog {
  readonly models: ReadonlyArray<ClaudeCodexBridgeModel>;
  readonly fetchedAt: number;
}

function artifactForHost(platform: NodeJS.Platform, architecture: NodeJS.Architecture) {
  return ARTIFACTS[`${platform}-${architecture}`];
}

function allowedDownloadUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && DOWNLOAD_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function download(url: string, destination: string, redirects = MAX_REDIRECTS): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!allowedDownloadUrl(url)) {
      reject(new Error(`Refusing untrusted download URL: ${url}`));
      return;
    }
    const request = https.get(url, (response) => {
      if ([301, 302, 307, 308].includes(response.statusCode ?? 0)) {
        const location = response.headers.location;
        response.resume();
        if (!location || redirects <= 0) {
          reject(new Error("Invalid or excessive runtime download redirect."));
          return;
        }
        download(new URL(location, url).toString(), destination, redirects - 1).then(
          resolve,
          reject,
        );
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Runtime download failed with HTTP ${response.statusCode ?? "unknown"}.`));
        return;
      }
      const declaredLength = Number(response.headers["content-length"] ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RUNTIME_ARCHIVE_BYTES) {
        response.resume();
        reject(new Error("Runtime download exceeded the size limit."));
        return;
      }
      const file = fs.createWriteStream(destination, { mode: 0o600 });
      let receivedBytes = 0;
      const fail = (error: Error) => {
        file.destroy();
        try {
          fs.rmSync(destination, { force: true });
        } catch {
          // Best-effort partial-download cleanup.
        }
        reject(error);
      };
      response.once("error", fail);
      response.on("data", (chunk: Buffer) => {
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_RUNTIME_ARCHIVE_BYTES) {
          response.destroy(new Error("Runtime download exceeded the size limit."));
        }
      });
      file.once("error", fail);
      file.once("finish", () => file.close(() => resolve()));
      response.pipe(file);
    });
    request.setTimeout(120_000, () => request.destroy(new Error("Runtime download timed out.")));
    request.once("error", reject);
  });
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function isCodexCredential(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object") return false;
  const raw = value as Readonly<Record<string, unknown>>;
  const type = String(raw.type ?? raw.provider ?? "").toLowerCase();
  return (
    type === "codex" ||
    (typeof raw.refresh_token === "string" && typeof raw.access_token === "string")
  );
}

export function directoryHasCodexBridgeCredential(directory: string): boolean {
  if (!fs.existsSync(directory)) return false;
  for (const name of fs.readdirSync(directory)) {
    if (!name.endsWith(".json")) continue;
    try {
      if (isCodexCredential(JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")))) {
        return true;
      }
    } catch {
      // Ignore malformed/transient files.
    }
  }
  return false;
}

function readCodexAccount(directory: string): ClaudeCodexBridgeStatus["account"] | undefined {
  let names: Array<string>;
  try {
    names = fs.readdirSync(directory).sort();
  } catch {
    return undefined;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")) as Record<
        string,
        unknown
      >;
      if (!isCodexCredential(raw)) continue;
      const email = typeof raw.email === "string" ? raw.email.trim().slice(0, 320) : undefined;
      const plan = name.match(/^codex-.*-([A-Za-z0-9_]{1,32})\.json$/u)?.[1];
      return {
        ...(email ? { email } : {}),
        ...(plan ? { plan } : {}),
      };
    } catch {
      // Continue to the next candidate.
    }
  }
  return undefined;
}

export function commitStagedClaudeCodexAuth(
  liveDirectory: string,
  stagingDirectory: string,
  platform: NodeJS.Platform,
): void {
  if (!directoryHasCodexBridgeCredential(stagingDirectory)) {
    throw new Error("Codex sign-in did not produce a valid credential.");
  }
  const backupDirectory = `${liveDirectory}-backup`;
  fs.rmSync(backupDirectory, { recursive: true, force: true });
  const hadLiveDirectory = fs.existsSync(liveDirectory);
  if (hadLiveDirectory) fs.renameSync(liveDirectory, backupDirectory);
  try {
    fs.renameSync(stagingDirectory, liveDirectory);
    if (platform !== "win32") {
      fs.chmodSync(liveDirectory, 0o700);
      for (const name of fs.readdirSync(liveDirectory)) {
        const destination = path.join(liveDirectory, name);
        if (fs.statSync(destination).isFile()) fs.chmodSync(destination, 0o600);
      }
    }
    fs.rmSync(backupDirectory, { recursive: true, force: true });
  } catch (cause) {
    fs.rmSync(liveDirectory, { recursive: true, force: true });
    if (hadLiveDirectory && fs.existsSync(backupDirectory)) {
      fs.renameSync(backupDirectory, liveDirectory);
    }
    throw cause;
  }
}

export function parseClaudeCodexModelsPayload(value: unknown): Array<ClaudeCodexBridgeModel> {
  if (!value || typeof value !== "object") return [];
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const models: Array<ClaudeCodexBridgeModel> = [];
  for (const item of data.slice(0, 512)) {
    if (!item || typeof item !== "object") continue;
    const rawId = (item as { id?: unknown }).id;
    if (typeof rawId !== "string") continue;
    const id = rawId.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(id) || seen.has(id)) continue;
    seen.add(id);
    const rawOwner = (item as { owned_by?: unknown }).owned_by;
    const ownedBy =
      typeof rawOwner === "string" && rawOwner.trim().length <= 128 ? rawOwner.trim() : undefined;
    models.push({ id, ...(ownedBy ? { ownedBy } : {}) });
  }
  return models;
}

function stopChild(child: ChildProcess | null, force = false): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  } catch {
    return;
  }
  if (!force) {
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Process already exited.
        }
      }
    }, 1_500).unref();
  }
}

export class ClaudeCodexBridge {
  readonly #rootDir: string;
  readonly #runtimeDir: string;
  readonly #authDir: string;
  readonly #stagingAuthDir: string;
  readonly #configPath: string;
  readonly #loginConfigPath: string;
  readonly #modelCachePath: string;
  readonly #platform: NodeJS.Platform;
  readonly #architecture: NodeJS.Architecture;
  #fastModeEnabled = false; // fork: f5 GPT fast
  #proxy: ChildProcess | null = null;
  #routers = new Map<string, ClaudeCodexHybridRouter>();
  #routerStarts = new Map<string, Promise<string>>();
  #loginProcess: ChildProcess | null = null;
  #loginStarting = false;
  #loginCancellationGeneration = 0;
  #installPromise: Promise<ClaudeCodexBridgeStatus> | null = null;
  #startPromise: Promise<void> | null = null;
  #startupAbort: AbortController | null = null;
  #ready = false;
  #port = 0;
  #apiKey = "";
  #lastError: string | undefined;
  #modelCatalog: CachedModelCatalog | null = null;
  #verifiedModels = new Set<string>();

  constructor(
    stateDirectory: string,
    host: { readonly platform: NodeJS.Platform; readonly architecture: NodeJS.Architecture },
  ) {
    this.#platform = host.platform;
    this.#architecture = host.architecture;
    this.#rootDir = path.join(stateDirectory, "providers", "claude-codex-bridge");
    this.#runtimeDir = path.join(this.#rootDir, "runtime", CLAUDE_CODEX_BRIDGE_VERSION);
    this.#authDir = path.join(this.#rootDir, "auth");
    this.#stagingAuthDir = path.join(this.#rootDir, "auth-staging");
    this.#configPath = path.join(this.#rootDir, "config.yaml");
    this.#loginConfigPath = path.join(this.#rootDir, "login-config.yaml");
    this.#modelCachePath = path.join(this.#rootDir, "models-cache.json");
  }

  // fork: f5 routers read this setting per request without restarting the bridge.
  setFastModeEnabled(enabled: boolean): void {
    this.#fastModeEnabled = enabled;
  }

  #binaryPath(): string {
    return path.join(
      this.#runtimeDir,
      this.#platform === "win32" ? "cli-proxy-api.exe" : "cli-proxy-api",
    );
  }

  #ensurePrivateDirectories(): void {
    for (const directory of [
      this.#rootDir,
      this.#runtimeDir,
      this.#authDir,
      this.#stagingAuthDir,
    ]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (this.#platform !== "win32") fs.chmodSync(directory, 0o700);
    }
  }

  status(): ClaudeCodexBridgeStatus {
    const account = readCodexAccount(this.#authDir);
    return {
      supported: artifactForHost(this.#platform, this.#architecture) !== undefined,
      installed: fs.existsSync(this.#binaryPath()),
      authenticated: directoryHasCodexBridgeCredential(this.#authDir),
      running: this.#ready,
      version: CLAUDE_CODEX_BRIDGE_VERSION,
      ...(this.#lastError ? { error: this.#lastError } : {}),
      ...(account ? { account } : {}),
    };
  }

  install(): Promise<ClaudeCodexBridgeStatus> {
    if (this.#installPromise) return this.#installPromise;
    const operation = this.#installOnce().finally(() => {
      if (this.#installPromise === operation) this.#installPromise = null;
    });
    this.#installPromise = operation;
    return operation;
  }

  async #installOnce(): Promise<ClaudeCodexBridgeStatus> {
    const artifact = artifactForHost(this.#platform, this.#architecture);
    if (!artifact) {
      this.#lastError = `Unsupported platform: ${this.#platform}/${this.#architecture}`;
      return this.status();
    }
    if (fs.existsSync(this.#binaryPath())) return this.status();
    this.#ensurePrivateDirectories();
    const archive = path.join(this.#rootDir, `${randomBytes(8).toString("hex")}-${artifact.file}`);
    const extractDirectory = path.join(this.#rootDir, `extract-${randomBytes(8).toString("hex")}`);
    try {
      await download(`${RELEASE_BASE}/${artifact.file}`, archive);
      const actual = await sha256(archive);
      if (actual !== artifact.sha256) {
        throw new Error(`Runtime checksum mismatch (expected ${artifact.sha256}, got ${actual}).`);
      }
      fs.mkdirSync(extractDirectory, { recursive: true, mode: 0o700 });
      if (artifact.file.endsWith(".zip")) {
        if (this.#platform === "win32") {
          const escapedArchive = archive.replaceAll("'", "''");
          const escapedDestination = extractDirectory.replaceAll("'", "''");
          await execFileAsync(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath '${escapedDestination}' -Force`,
            ],
            { timeout: 120_000 },
          );
        } else {
          await execFileAsync("unzip", ["-q", archive, "-d", extractDirectory], {
            timeout: 120_000,
          });
        }
      } else {
        await execFileAsync("tar", ["-xzf", archive, "-C", extractDirectory], {
          timeout: 120_000,
        });
      }
      const extractedBinary = path.join(
        extractDirectory,
        this.#platform === "win32" ? "cli-proxy-api.exe" : "cli-proxy-api",
      );
      if (!fs.existsSync(extractedBinary)) {
        throw new Error("Downloaded runtime did not contain cli-proxy-api.");
      }
      if (this.#platform !== "win32") fs.chmodSync(extractedBinary, 0o700);
      const license = path.join(extractDirectory, "LICENSE");
      if (fs.existsSync(license)) {
        fs.copyFileSync(license, path.join(this.#runtimeDir, "LICENSE"));
      }
      // Publish only a complete executable; interrupted installs remain retryable.
      fs.renameSync(extractedBinary, this.#binaryPath());
      this.#lastError = undefined;
    } catch (cause) {
      this.#lastError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      try {
        fs.rmSync(archive, { force: true });
        fs.rmSync(extractDirectory, { recursive: true, force: true });
      } catch {
        // Best-effort install cleanup.
      }
    }
    return this.status();
  }

  #writeConfig(target: string, port: number, apiKey: string, authDirectory: string): void {
    this.#ensurePrivateDirectories();
    const config = [
      'host: "127.0.0.1"',
      `port: ${port}`,
      "tls:",
      "  enable: false",
      "remote-management:",
      "  allow-remote: false",
      '  secret-key: ""',
      "  disable-control-panel: true",
      `auth-dir: ${JSON.stringify(authDirectory)}`,
      "api-keys:",
      `  - ${JSON.stringify(apiKey)}`,
      "debug: false",
      "pprof:",
      "  enable: false",
      "plugins:",
      "  enabled: false",
      "commercial-mode: true",
      "logging-to-file: false",
      "logs-max-total-size-mb: 0",
      "error-logs-max-files: 0",
      "usage-statistics-enabled: false",
      'proxy-url: ""',
      "request-retry: 3",
      "max-retry-credentials: 1",
      "max-retry-interval: 30",
      "streaming:",
      "  keepalive-seconds: 15",
      "  bootstrap-retries: 2",
      "disable-cooling: false",
      "save-cooldown-status: false",
      "disable-claude-cloak-mode: true",
      "routing:",
      '  strategy: "fill-first"',
      "  session-affinity: true",
      "codex:",
      "  identity-confuse: false",
      "ws-auth: true",
      "",
    ].join("\n");
    fs.writeFileSync(target, config, { mode: 0o600 });
    if (this.#platform !== "win32") fs.chmodSync(target, 0o600);
  }

  async signIn(
    emit: (event: ClaudeCodexBridgeSignInEvent) => void,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    if (this.#loginStarting || (this.#loginProcess && this.#loginProcess.exitCode === null)) {
      emit({ _tag: "failed", message: "A Codex bridge sign-in is already running." });
      return;
    }
    this.#loginStarting = true;
    const cancellationGeneration = this.#loginCancellationGeneration;
    try {
      await this.#runSignIn(emit, cancellationGeneration, abortSignal);
    } finally {
      this.#loginStarting = false;
    }
  }

  async #runSignIn(
    emit: (event: ClaudeCodexBridgeSignInEvent) => void,
    cancellationGeneration: number,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const cancelled = () =>
      abortSignal?.aborted === true || cancellationGeneration !== this.#loginCancellationGeneration;
    emit({ _tag: "started" });
    const installed = await this.install();
    if (!installed.installed) {
      emit({ _tag: "failed", message: installed.error ?? "Bridge runtime installation failed." });
      return;
    }
    if (cancelled()) return;
    fs.rmSync(this.#stagingAuthDir, { recursive: true, force: true });
    fs.mkdirSync(this.#stagingAuthDir, { recursive: true, mode: 0o700 });
    const loginPort = await freeLoopbackPort();
    if (cancelled()) {
      fs.rmSync(this.#stagingAuthDir, { recursive: true, force: true });
      return;
    }
    this.#writeConfig(
      this.#loginConfigPath,
      loginPort,
      randomBytes(32).toString("hex"),
      this.#stagingAuthDir,
    );

    await new Promise<void>((resolve) => {
      const processHandle = spawn(
        this.#binaryPath(),
        ["-codex-device-login", "-config", this.#loginConfigPath],
        {
          cwd: this.#rootDir,
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            USERPROFILE: process.env.USERPROFILE,
            TMPDIR: process.env.TMPDIR,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      this.#loginProcess = processHandle;
      const abort = () => {
        if (this.#loginProcess === processHandle) stopChild(processHandle);
      };
      abortSignal?.addEventListener("abort", abort, { once: true });
      let output = "";
      let emittedCode = false;
      const consume = (chunk: Buffer | string) => {
        output = `${output}${chunk.toString()}`.slice(-32_768);
        const url = output.match(/https:\/\/auth\.openai\.com\/codex\/device/iu)?.[0];
        const code = output.match(/(?:device code|code):\s*([A-Z0-9]{4}-[A-Z0-9]{5})/iu)?.[1];
        if (!emittedCode && url && code) {
          emittedCode = true;
          emit({ _tag: "deviceCode", verificationUrl: url, userCode: code });
        }
      };
      processHandle.stdout?.on("data", consume);
      processHandle.stderr?.on("data", consume);
      processHandle.once("error", (error) => {
        abortSignal?.removeEventListener("abort", abort);
        if (this.#loginProcess === processHandle) this.#loginProcess = null;
        this.#lastError = error.message;
        emit({ _tag: "failed", message: error.message });
        resolve();
      });
      processHandle.once("exit", (code, terminationSignal) => {
        abortSignal?.removeEventListener("abort", abort);
        if (this.#loginProcess === processHandle) this.#loginProcess = null;
        try {
          if (terminationSignal || cancelled()) {
            emit({ _tag: "failed", message: "Codex bridge sign-in was cancelled." });
            return;
          }
          if (code === 0 && directoryHasCodexBridgeCredential(this.#stagingAuthDir)) {
            // Keep existing hybrid routers alive so an account switch does not
            // interrupt ordinary Claude traffic in already-running sessions.
            this.#stopProxy();
            commitStagedClaudeCodexAuth(this.#authDir, this.#stagingAuthDir, this.#platform);
            this.#lastError = undefined;
            this.#modelCatalog = null;
            fs.rmSync(this.#modelCachePath, { force: true });
            emit({ _tag: "completed" });
            return;
          }
          const message =
            output.trim().split(/\r?\n/u).slice(-4).join("\n") ||
            `Codex sign-in exited with code ${code ?? "unknown"}.`;
          this.#lastError = message;
          emit({ _tag: "failed", message });
        } catch (cause) {
          this.#lastError = cause instanceof Error ? cause.message : String(cause);
          emit({ _tag: "failed", message: this.#lastError });
        } finally {
          fs.rmSync(this.#stagingAuthDir, { recursive: true, force: true });
          fs.rmSync(this.#loginConfigPath, { force: true });
          resolve();
        }
      });
    });
  }

  cancelSignIn(): void {
    this.#loginCancellationGeneration += 1;
    stopChild(this.#loginProcess);
  }

  signOut(): ClaudeCodexBridgeStatus {
    this.cancelSignIn();
    // Existing routed sessions can keep forwarding normal Claude requests;
    // only future Codex requests become unavailable until reconnection.
    this.#stopProxy();
    if (fs.existsSync(this.#authDir)) {
      for (const name of fs.readdirSync(this.#authDir)) {
        try {
          fs.rmSync(path.join(this.#authDir, name), { force: true });
        } catch {
          // Best-effort credential removal.
        }
      }
    }
    this.#modelCatalog = null;
    fs.rmSync(this.#modelCachePath, { force: true });
    this.#lastError = undefined;
    return this.status();
  }

  #waitForHealth(
    child: ChildProcess,
    port: number,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<Array<ClaudeCodexBridgeModel>> {
    return new Promise((resolve, reject) => {
      let request: NodeHttp.ClientRequest | undefined;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = (error?: Error, models?: Array<ClaudeCodexBridgeModel>) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        clearTimeout(retryTimer);
        signal.removeEventListener("abort", aborted);
        child.removeListener("error", failed);
        child.removeListener("exit", exited);
        request?.destroy();
        if (error) reject(error);
        else resolve(models!);
      };
      const failed = (error: Error) => finish(error);
      const exited = () =>
        finish(new Error(this.#lastError || "Codex bridge exited during startup."));
      const aborted = () => finish(new Error("Codex bridge startup was cancelled."));
      const deadline = setTimeout(
        () => finish(new Error("Codex bridge health check timed out.")),
        15_000,
      );
      child.once("error", failed);
      child.once("exit", exited);
      signal.addEventListener("abort", aborted, { once: true });
      const probe = () => {
        if (settled) return;
        if (signal.aborted) return aborted();
        if (child.exitCode !== null || child.signalCode !== null) return exited();
        let retried = false;
        const retry = () => {
          if (settled || retried) return;
          retried = true;
          request?.destroy();
          retryTimer = setTimeout(probe, 125);
        };
        request = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/v1/models",
            method: "GET",
            headers: { Authorization: `Bearer ${apiKey}` },
            timeout: 500,
          },
          (response) => {
            if (response.statusCode !== 200) {
              response.resume();
              retry();
              return;
            }
            const chunks: Array<Buffer> = [];
            let size = 0;
            response.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > MAX_MODEL_RESPONSE_BYTES) {
                response.destroy(new Error("Codex model catalog response was too large."));
                return;
              }
              chunks.push(chunk);
            });
            response.once("error", retry);
            response.once("end", () => {
              if (settled || retried) return;
              try {
                const models = parseClaudeCodexModelsPayload(
                  JSON.parse(Buffer.concat(chunks).toString("utf8")),
                );
                // The listener starts before OAuth model registration finishes.
                if (models.length > 0) finish(undefined, models);
                else retry();
              } catch {
                retry();
              }
            });
          },
        );
        request.once("timeout", retry);
        request.once("error", retry);
        request.end();
      };
      probe();
    });
  }

  async ensureReady(): Promise<void> {
    if (this.#startPromise) return this.#startPromise;
    if (this.#ready) return;
    const startupAbort = new AbortController();
    this.#startupAbort = startupAbort;
    const checkCancelled = () => startupAbort.signal.throwIfAborted();
    this.#startPromise = (async () => {
      const installed = await this.install();
      checkCancelled();
      if (!installed.installed) {
        throw new Error(installed.error ?? "Codex bridge runtime is not installed.");
      }
      if (!directoryHasCodexBridgeCredential(this.#authDir)) {
        throw new Error("Codex is not connected for Claude model routing.");
      }
      const port = await freeLoopbackPort();
      checkCancelled();
      this.#port = port;
      this.#apiKey = randomBytes(32).toString("hex");
      this.#writeConfig(this.#configPath, this.#port, this.#apiKey, this.#authDir);
      const child = spawn(this.#binaryPath(), ["-local-model", "-config", this.#configPath], {
        cwd: this.#rootDir,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          USERPROFILE: process.env.USERPROFILE,
          TMPDIR: process.env.TMPDIR,
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      this.#proxy = child;
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-16_384);
      });
      // Spawn errors must never escape as an unhandled EventEmitter error.
      child.on("error", (error) => {
        if (this.#proxy === child) this.#lastError = error.message;
      });
      child.once("exit", (code, signal) => {
        if (this.#proxy !== child) return;
        this.#ready = false;
        this.#proxy = null;
        this.#port = 0;
        this.#apiKey = "";
        if (signal || code !== 0) {
          this.#lastError = stderr.trim() || `Codex bridge exited (${signal ?? code}).`;
        }
      });
      try {
        const models = await this.#waitForHealth(
          child,
          this.#port,
          this.#apiKey,
          startupAbort.signal,
        );
        checkCancelled();
        this.#modelCatalog = { models, fetchedAt: Date.now() };
        this.#persistModels(this.#modelCatalog);
        this.#ready = true;
        this.#lastError = undefined;
      } catch (cause) {
        stopChild(child);
        this.#ready = false;
        this.#proxy = null;
        this.#port = 0;
        this.#apiKey = "";
        throw cause;
      }
    })()
      .catch((cause) => {
        this.#lastError = cause instanceof Error ? cause.message : String(cause);
        throw cause;
      })
      .finally(() => {
        this.#startPromise = null;
        if (this.#startupAbort === startupAbort) this.#startupAbort = null;
      });
    return this.#startPromise;
  }

  #requestLiveModels(): Promise<Array<ClaudeCodexBridgeModel>> {
    if (!this.#proxy || this.#proxy.exitCode !== null || !this.#port || !this.#apiKey) {
      return Promise.reject(new Error("Codex bridge is not ready."));
    }
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          hostname: "127.0.0.1",
          port: this.#port,
          path: "/v1/models",
          method: "GET",
          headers: { Authorization: `Bearer ${this.#apiKey}` },
          timeout: 5_000,
        },
        (response) => {
          if (response.statusCode !== 200) {
            response.resume();
            reject(
              new Error(`Codex model catalog returned HTTP ${response.statusCode ?? "unknown"}.`),
            );
            return;
          }
          const chunks: Array<Buffer> = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_MODEL_RESPONSE_BYTES) {
              response.destroy(new Error("Codex model catalog response was too large."));
              return;
            }
            chunks.push(chunk);
          });
          response.once("error", reject);
          response.once("end", () => {
            try {
              const models = parseClaudeCodexModelsPayload(
                JSON.parse(Buffer.concat(chunks).toString("utf8")),
              );
              if (models.length === 0) throw new Error("Codex model catalog was empty.");
              resolve(models);
            } catch (cause) {
              reject(cause instanceof Error ? cause : new Error(String(cause)));
            }
          });
        },
      );
      request.once("timeout", () => request.destroy(new Error("Codex model catalog timed out.")));
      request.once("error", reject);
      request.end();
    });
  }

  #readCachedModels(): CachedModelCatalog | null {
    if (this.#modelCatalog) return this.#modelCatalog;
    try {
      const raw = JSON.parse(fs.readFileSync(this.#modelCachePath, "utf8")) as {
        data?: unknown;
        fetchedAt?: unknown;
        runtimeVersion?: unknown;
      };
      if (raw.runtimeVersion !== CLAUDE_CODEX_BRIDGE_VERSION) return null;
      const models = parseClaudeCodexModelsPayload({ data: raw.data });
      const fetchedAt =
        typeof raw.fetchedAt === "number" && Number.isFinite(raw.fetchedAt) ? raw.fetchedAt : 0;
      if (models.length === 0 || fetchedAt <= 0) return null;
      this.#modelCatalog = { models, fetchedAt };
      return this.#modelCatalog;
    } catch {
      return null;
    }
  }

  #persistModels(catalog: CachedModelCatalog): void {
    for (const model of catalog.models) this.#verifiedModels.add(model.id);
    this.#ensurePrivateDirectories();
    fs.writeFileSync(
      this.#modelCachePath,
      JSON.stringify({
        runtimeVersion: CLAUDE_CODEX_BRIDGE_VERSION,
        fetchedAt: catalog.fetchedAt,
        data: catalog.models.map((model) => ({
          id: model.id,
          ...(model.ownedBy ? { owned_by: model.ownedBy } : {}),
        })),
      }),
      { mode: 0o600 },
    );
    if (this.#platform !== "win32") fs.chmodSync(this.#modelCachePath, 0o600);
  }

  async models(forceRefresh = false): Promise<ClaudeCodexBridgeModelsResult> {
    const cached = this.#readCachedModels();
    if (!forceRefresh && cached && Date.now() - cached.fetchedAt < MODEL_CACHE_TTL_MS) {
      return { models: [...cached.models], fetchedAt: cached.fetchedAt, source: "cache" };
    }
    if (directoryHasCodexBridgeCredential(this.#authDir)) {
      try {
        await this.ensureReady();
        const models = await this.#requestLiveModels();
        const catalog = { models, fetchedAt: Date.now() };
        this.#modelCatalog = catalog;
        this.#persistModels(catalog);
        return { ...catalog, source: "live" };
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause);
        if (cached) {
          return {
            models: [...cached.models],
            fetchedAt: cached.fetchedAt,
            source: "cache",
            stale: true,
            error,
          };
        }
        return {
          models: FALLBACK_MODELS.map((id) => ({ id })),
          source: "fallback",
          stale: true,
          error,
        };
      }
    }
    return {
      models: cached ? [...cached.models] : FALLBACK_MODELS.map((id) => ({ id })),
      ...(cached ? { fetchedAt: cached.fetchedAt } : {}),
      source: cached ? "cache" : "fallback",
      stale: true,
      error: "Connect Codex to load the models available to this account.",
    };
  }

  subagentModel(requested?: string): string {
    return effectiveClaudeCodexModel(requested);
  }

  #isCodexModel(model: string): boolean {
    const normalized = model.trim();
    return (
      this.#readCachedModels()?.models.some((candidate) => candidate.id === normalized) ?? false
    );
  }

  async hybridEnvironment(
    requestedModel?: string,
    anthropicBaseUrl?: string,
    requestTimeoutSeconds = 1800,
  ): Promise<{
    readonly environment: NodeJS.ProcessEnv;
    readonly model: string;
  }> {
    await this.ensureReady();
    const model = this.subagentModel(requestedModel);
    if (!this.#isCodexModel(model)) {
      throw new Error(
        `Codex bridge ${CLAUDE_CODEX_BRIDGE_VERSION} does not offer ${model} for the connected account. Choose an available routing model in Settings → Model routing.`,
      );
    }
    const anthropicUpstream = (() => {
      if (!anthropicBaseUrl?.trim()) return new URL("https://api.anthropic.com");
      const candidate = new URL(anthropicBaseUrl);
      if (candidate.protocol !== "http:" && candidate.protocol !== "https:") {
        throw new Error("Claude's ANTHROPIC_BASE_URL must use HTTP or HTTPS.");
      }
      if (candidate.username || candidate.password || candidate.search || candidate.hash) {
        throw new Error(
          "Claude's ANTHROPIC_BASE_URL cannot contain credentials, a query, or a fragment.",
        );
      }
      return candidate;
    })();
    const routerKey = `${anthropicUpstream.href}|${requestTimeoutSeconds}`;
    let router = this.#routers.get(routerKey);
    if (!router) {
      router = new ClaudeCodexHybridRouter({
        codexUpstream: async () => {
          await this.ensureReady();
          return this.#ready ? { port: this.#port, token: this.#apiKey } : null;
        },
        requestTimeoutMs: requestTimeoutSeconds * 1000,
        // Remember verified routes across account switches. The current account
        // is still checked by the runtime; an old router must be able to restart it.
        isCodexModel: (model) => this.#verifiedModels.has(model) || this.#isCodexModel(model),
        fastModeEnabled: () => this.#fastModeEnabled, // fork: f5 GPT fast
        anthropicUpstream,
      });
      this.#routers.set(routerKey, router);
    }
    let baseUrl = router.baseUrl();
    if (!baseUrl) {
      let start = this.#routerStarts.get(routerKey);
      if (!start) {
        start = router.start().finally(() => {
          this.#routerStarts.delete(routerKey);
        });
        this.#routerStarts.set(routerKey, start);
      }
      baseUrl = await start;
    }
    return {
      model,
      environment: {
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      },
    };
  }

  #stopProxy(force = false): void {
    this.#startupAbort?.abort();
    this.#ready = false;
    const proxy = this.#proxy;
    this.#proxy = null;
    this.#port = 0;
    this.#apiKey = "";
    stopChild(proxy, force);
  }

  stop(force = false): void {
    this.#stopProxy(force);
    for (const router of this.#routers.values()) router.stop();
    this.#routers.clear();
    this.#routerStarts.clear();
  }

  dispose(): void {
    this.cancelSignIn();
    this.stop(true);
  }
}

const bridgeByStateDirectory = new Map<string, ClaudeCodexBridge>();
let exitHandlerInstalled = false;

export function getClaudeCodexBridge(
  stateDirectory: string,
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): ClaudeCodexBridge {
  const key = path.resolve(stateDirectory);
  const existing = bridgeByStateDirectory.get(key);
  if (existing) return existing;
  const bridge = new ClaudeCodexBridge(key, { platform, architecture });
  bridgeByStateDirectory.set(key, bridge);
  if (!exitHandlerInstalled) {
    exitHandlerInstalled = true;
    process.once("exit", () => {
      for (const instance of bridgeByStateDirectory.values()) instance.dispose();
    });
  }
  return bridge;
}
