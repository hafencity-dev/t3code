import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import {
  ClaudeCredentialLockTimeoutError,
  withClaudeConfigLock,
  withClaudeCredentialLocks,
} from "./ClaudeCredentialLock.ts";
import { syncDirectory } from "./durableFs.ts";

type JsonObject = Record<string, unknown>;
export type ClaudeCredentialIdentity = { email?: string; accountUuid?: string };
export type ClaudeCredentialSwitchResult = {
  activeAccountId: string;
  sourceAccountId: string;
  originalSourceAccountId: string;
  externalIdentity?: ClaudeCredentialIdentity;
};
export class ClaudeCredentialSwitchError extends Error {
  override readonly name = "ClaudeCredentialSwitchError";
}

type Location = { home: string; configDir?: string };
export interface ClaudeCredentialAdapter {
  read(location: Location): Promise<JsonObject>;
  write(location: Location, credentials: JsonObject, assertHeld?: () => void): Promise<void>;
  /** Reject payloads this storage cannot hold, before any durable step starts. */
  validate?(credentials: JsonObject): void;
}
export type ClaudeCredentialSwitchPhase =
  | "prepared"
  | "source-saved"
  | "activating"
  | "activated"
  | "checked-out"
  | "committed";
type Commit = (result: ClaudeCredentialSwitchResult) => Promise<void>;
type Context = {
  stateDir: string;
  managedRoot: string;
  /** Credential storage/lock home, including any secure-storage override. */
  activeHome: string;
  activeConfigPath: string;
  /** Omit for the default keychain name; explicitly configured directories are hashed. */
  activeConfigDir?: string;
  commit: Commit;
};
export type ClaudeCredentialSwitchInput = Context & {
  sourceStore: string;
  sourceAccountId: string;
  targetStore: string;
  targetAccountId: string;
  expectedEmail?: string;
  expectedAccountUuid?: string;
  /** `discard` removes a freshly created entry if the switch fails before its journal exists. */
  resolveSource?: (
    identity: ClaudeCredentialIdentity,
  ) => Promise<{ store: string; accountId: string; discard?: () => Promise<void> }>;
};
type Dependencies = {
  credentials?: ClaudeCredentialAdapter;
  locks?: typeof withClaudeCredentialLocks;
  configLock?: typeof withClaudeConfigLock;
  /** Fault injection after durable boundaries; never receives credential material. */
  afterPhase?: (phase: ClaudeCredentialSwitchPhase) => Promise<void>;
};
type Journal = {
  version: 1;
  phase: ClaudeCredentialSwitchPhase;
  activeHome: string;
  activeConfigPath: string;
  activeConfigDir?: string;
  sourceStore: string;
  sourceAccountId: string;
  targetStore: string;
  targetAccountId: string;
  originalSourceAccountId: string;
  /** Identity observed in the active config at preparation; never token material. */
  sourceIdentity: ClaudeCredentialIdentity;
  externalIdentity?: ClaudeCredentialIdentity;
  /** Non-secret lineage fingerprints; recovery only deletes a store copy that matches. */
  sourceFingerprint?: string;
  targetFingerprint?: string;
};
const journalName = "claude-credential-switch.json";
export const claudeCredentialSwitchJournalPath = (stateDir: string) =>
  NodePath.join(stateDir, journalName);

function missing(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseObject(text: string): JsonObject {
  try {
    const value: unknown = JSON.parse(text);
    if (object(value)) return value;
  } catch {
    /* Do not expose credential contents in parse errors. */
  }
  throw new ClaudeCredentialSwitchError("Claude credential/config data is not a JSON object.");
}
async function readJson(path: string) {
  const text = await NodeFSP.readFile(path, "utf8").catch((error: unknown) => {
    if (missing(error)) return undefined;
    throw error;
  });
  return text === undefined ? {} : parseObject(text);
}
/** Durable replacement; monotonic mtime also invalidates Claude's file credential cache. */
async function writeJson(
  path: string,
  value: JsonObject,
  preserveMode = false,
  assertHeld = () => {},
) {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true, mode: 0o700 });
  const previous = await NodeFSP.stat(path).catch((error: unknown) => {
    if (missing(error)) return undefined;
    throw error;
  });
  const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`;
  const file = await NodeFSP.open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    if (preserveMode && previous) await file.chmod(previous.mode & 0o777);
    const timestamp = new Date(Math.max(Date.now(), Math.floor(previous?.mtimeMs ?? 0) + 1000));
    await file.utimes(timestamp, timestamp);
    await file.sync();
    await file.close();
    assertHeld();
    await NodeFSP.rename(temporary, path);
    await syncDirectory(NodePath.dirname(path));
  } finally {
    await file.close().catch(() => undefined);
    await NodeFSP.rm(temporary, { force: true });
  }
}
export const claudeFileCredentialAdapter: ClaudeCredentialAdapter = {
  read: ({ home }) => readJson(NodePath.join(home, ".credentials.json")),
  write: ({ home }, value, assertHeld) =>
    writeJson(NodePath.join(home, ".credentials.json"), value, false, assertHeld),
};

/**
 * OAuth storage name: `Claude Code${OAUTH_FILE_SUFFIX=""}-credentials${hash}`. Configured and
 * default locations differ even when they resolve to the same directory.
 */
export function claudeCredentialKeychainService(configDir?: string) {
  return `Claude Code-credentials${configDir ? `-${NodeCrypto.createHash("sha256").update(configDir.normalize("NFC")).digest("hex").slice(0, 8)}` : ""}`;
}
export function claudeCredentialKeychainAccount() {
  let account: string;
  try {
    account = process.env.USER || NodeOS.userInfo().username;
  } catch {
    account = "claude-code-user";
  }
  return /^[a-zA-Z0-9._-]+$/u.test(account) ? account : "claude-code-user";
}
export interface ClaudeKeychain {
  read(service: string, account: string): Promise<string | undefined>;
  write(service: string, account: string, value: string): Promise<void>;
}
const SECURITY_STDIN_LIMIT = 4032;
const SECURITY_TIMEOUT_MS = 5_000;
const keychainTooLarge = () =>
  new ClaudeCredentialSwitchError("Claude credentials are too large for safe Keychain storage.");
function securityWord(value: string) {
  // security's interactive tokenizer accepts double-quoted words and backslash escapes.
  if (/[\r\n\0]/u.test(value))
    throw new ClaudeCredentialSwitchError("Invalid keychain command value.");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
function securityWriteCommand(service: string, account: string, value: string) {
  return `add-generic-password -U -a ${securityWord(account)} -s ${securityWord(service)} -X ${securityWord(Buffer.from(value, "utf8").toString("hex"))}\n`;
}
/** Every `security` call is bounded; a hung child is killed and reaped before locks release. */
export function createSystemClaudeKeychain(
  options: {
    executable?: string;
    timeoutMs?: number;
  } = {},
): ClaudeKeychain {
  const executable = options.executable ?? "/usr/bin/security";
  const timeoutMs = options.timeoutMs ?? SECURITY_TIMEOUT_MS;
  return {
    read: (service, account) =>
      new Promise((resolve, reject) => {
        NodeChildProcess.execFile(
          executable,
          ["find-generic-password", "-s", service, "-a", account, "-w"],
          {
            encoding: "utf8",
            maxBuffer: 4 * 1024 * 1024,
            timeout: timeoutMs,
            killSignal: "SIGKILL",
          },
          // execFile reports after the child exited, including after a timeout kill.
          (error, stdout) => {
            if (!error) resolve(stdout.trim());
            else if (error.code === 44 && !error.killed) resolve(undefined);
            else
              reject(
                new ClaudeCredentialSwitchError(
                  "Unable to read Claude credentials from macOS Keychain.",
                ),
              );
          },
        );
      }),
    write: (service, account, value) =>
      new Promise((resolve, reject) => {
        const command = securityWriteCommand(service, account, value);
        // Claude uses the same stdin limit, then falls back to argv. Never expose secrets in argv.
        if (command.length > SECURITY_STDIN_LIMIT) {
          reject(keychainTooLarge());
          return;
        }
        const child = NodeChildProcess.spawn(executable, ["-i"], {
          stdio: ["pipe", "ignore", "pipe"],
        });
        // Interactive security may exit zero after a failed command. Any diagnostic fails closed.
        let diagnostics = "";
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);
        child.stderr.on("data", (chunk: Buffer) => {
          diagnostics = (diagnostics + chunk.toString()).slice(0, 16_384);
        });
        const fail = () => {
          clearTimeout(timer);
          reject(
            new ClaudeCredentialSwitchError(
              "Unable to write Claude credentials to macOS Keychain.",
            ),
          );
        };
        child.on("error", fail);
        child.stdin.on("error", fail);
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0 && !timedOut && !diagnostics.replaceAll("security>", "").trim()) resolve();
          else fail();
        });
        child.stdin.end(command);
      }),
  };
}
export const systemClaudeKeychain: ClaudeKeychain = createSystemClaudeKeychain();
export function createClaudeKeychainCredentialAdapter(
  keychain: ClaudeKeychain = systemClaudeKeychain,
  account = claudeCredentialKeychainAccount(),
): ClaudeCredentialAdapter {
  return {
    validate(value) {
      // The longest service name is the hashed one; size does not depend on which store.
      const service = claudeCredentialKeychainService("configured-directory-placeholder");
      if (
        securityWriteCommand(service, account, JSON.stringify(value)).length > SECURITY_STDIN_LIMIT
      )
        throw keychainTooLarge();
    },
    async read({ configDir }) {
      try {
        const value = await keychain.read(claudeCredentialKeychainService(configDir), account);
        return value === undefined ? {} : parseObject(value);
      } catch {
        throw new ClaudeCredentialSwitchError(
          "Unable to read Claude credentials from macOS Keychain.",
        );
      }
    },
    async write({ configDir }, value, assertHeld) {
      try {
        assertHeld?.();
        const service = claudeCredentialKeychainService(configDir);
        const serialized = JSON.stringify(value);
        await keychain.write(service, account, serialized);
        // Interactive security can exit zero even when its command failed.
        if ((await keychain.read(service, account)) !== serialized) {
          throw new ClaudeCredentialSwitchError("Keychain credential write could not be verified.");
        }
      } catch {
        throw new ClaudeCredentialSwitchError(
          "Unable to write Claude credentials to macOS Keychain.",
        );
      }
    },
  };
}
function adapter(deps: Dependencies) {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Plain filesystem transaction; adapters are injected in tests.
  const platform = process.platform;
  return (
    deps.credentials ??
    (platform === "darwin" ? createClaudeKeychainCredentialAdapter() : claudeFileCredentialAdapter)
  );
}
function activeLocation(input: Pick<Context, "activeHome" | "activeConfigDir">): Location {
  return {
    home: input.activeHome,
    ...(input.activeConfigDir === undefined ? {} : { configDir: input.activeConfigDir }),
  };
}
function storeLocation(home: string): Location {
  return { home, configDir: home };
}
function identity(config: JsonObject): ClaudeCredentialIdentity {
  const account = config.oauthAccount;
  if (!object(account)) return {};
  return {
    ...(typeof account.emailAddress === "string" ? { email: account.emailAddress } : {}),
    ...(typeof account.accountUuid === "string" ? { accountUuid: account.accountUuid } : {}),
  };
}
/** Missing fields must stay missing; a signed-out source only matches a signed-out active home. */
function identityEquals(left: ClaudeCredentialIdentity, right: ClaudeCredentialIdentity) {
  return (
    left.accountUuid === right.accountUuid &&
    left.email?.toLowerCase() === right.email?.toLowerCase()
  );
}
function sameIdentity(left: JsonObject, right: JsonObject) {
  const a = identity(left);
  const b = identity(right);
  return b.accountUuid
    ? a.accountUuid === b.accountUuid
    : Boolean(b.email && a.email?.toLowerCase() === b.email.toLowerCase());
}
function token(credentials: JsonObject) {
  const value = credentials.claudeAiOauth;
  return object(value) && typeof value.accessToken === "string" && value.accessToken.length > 0
    ? value
    : undefined;
}
/** Non-secret lineage id: refresh tokens rotate per refresh, so a match means the same copy. */
function fingerprint(oauth: JsonObject | undefined) {
  if (!oauth) return undefined;
  const material =
    typeof oauth.refreshToken === "string" && oauth.refreshToken
      ? oauth.refreshToken
      : String(oauth.accessToken);
  return NodeCrypto.createHash("sha256").update(material).digest("hex").slice(0, 16);
}
function safeConfigLock(deps: Dependencies) {
  const lock = deps.configLock ?? withClaudeConfigLock;
  return async <T>(path: string, operation: (assertHeld: () => void) => Promise<T>) => {
    try {
      return await lock(path, operation);
    } catch (error) {
      throw sanitizeLockError(error);
    }
  };
}
/** Read-modify-write under Claude's own config lock, acquired last and released immediately. */
async function setIdentity(
  path: string,
  value: unknown,
  assertHeld: () => void,
  deps: Dependencies,
) {
  await safeConfigLock(deps)(path, async (assertConfigHeld) => {
    const config = await readJson(path);
    if (value === undefined) delete config.oauthAccount;
    else config.oauthAccount = value;
    await writeJson(path, config, true, () => {
      assertHeld();
      assertConfigHeld();
    });
  });
}
function result(journal: Journal): ClaudeCredentialSwitchResult {
  return {
    activeAccountId: journal.targetAccountId,
    sourceAccountId: journal.sourceAccountId,
    originalSourceAccountId: journal.originalSourceAccountId,
    ...(journal.externalIdentity ? { externalIdentity: journal.externalIdentity } : {}),
  };
}
async function validateLocations(input: Context, source: string, target: string) {
  const root = await NodeFSP.realpath(input.managedRoot);
  const active = await NodeFSP.realpath(input.activeHome);
  const homes = await Promise.all(
    [source, target].map(async (store) => {
      const resolved = await NodeFSP.realpath(store);
      const relative = NodePath.relative(root, resolved);
      if (
        !relative ||
        relative === ".." ||
        relative.startsWith(`..${NodePath.sep}`) ||
        NodePath.isAbsolute(relative) ||
        resolved === active
      ) {
        throw new ClaudeCredentialSwitchError(
          "Claude account store is outside the managed account root or aliases the active home.",
        );
      }
      return resolved;
    }),
  );
  if (homes[0] === homes[1])
    throw new ClaudeCredentialSwitchError("Claude source and target stores must differ.");
}
async function persistPhase(
  context: Context,
  journal: Journal,
  phase: ClaudeCredentialSwitchPhase,
  deps: Dependencies,
  assertHeld: () => void,
) {
  journal.phase = phase;
  await writeJson(NodePath.join(context.stateDir, journalName), journal, false, assertHeld);
  await deps.afterPhase?.(phase);
}
async function finish(
  context: Context,
  journal: Journal,
  deps: Dependencies,
  assertHeld: () => void,
) {
  const credentials = adapter(deps);
  const active = activeLocation(journal);
  const source = storeLocation(journal.sourceStore);
  const target = storeLocation(journal.targetStore);
  // While the active home still carries the source identity, whatever token it holds is
  // the source lineage (possibly refreshed since preparation) and overrides the store copy.
  const saveSource = async (current: JsonObject, activeConfig: JsonObject) => {
    const sourceCredentials = await credentials.read(source);
    const currentToken = token(current);
    if (currentToken) sourceCredentials.claudeAiOauth = currentToken;
    assertHeld();
    await credentials.write(source, sourceCredentials, assertHeld);
    if (currentToken)
      await setIdentity(
        NodePath.join(source.home, ".claude.json"),
        activeConfig.oauthAccount,
        assertHeld,
        deps,
      );
    await syncDirectory(NodePath.dirname(source.home));
    const saved = fingerprint(currentToken);
    if (saved === undefined) delete journal.sourceFingerprint;
    else journal.sourceFingerprint = saved;
  };
  if (journal.phase === "prepared") {
    const activeConfig = await readJson(journal.activeConfigPath);
    if (!identityEquals(identity(activeConfig), journal.sourceIdentity)) {
      throw new ClaudeCredentialSwitchError(
        "Claude active identity changed during interrupted switching; recovery left untouched.",
      );
    }
    await saveSource(await credentials.read(active), activeConfig);
    assertHeld();
    await persistPhase(context, journal, "source-saved", deps, assertHeld);
  }
  if (journal.phase === "source-saved") {
    // Nothing has touched the active home yet, so its token can only be the source lineage.
    const current = await credentials.read(active);
    const currentFingerprint = fingerprint(token(current));
    if (currentFingerprint !== undefined && currentFingerprint !== journal.sourceFingerprint) {
      const activeConfig = await readJson(journal.activeConfigPath);
      if (!identityEquals(identity(activeConfig), journal.sourceIdentity)) {
        throw new ClaudeCredentialSwitchError(
          "Claude active credentials changed during interrupted switching; recovery left untouched.",
        );
      }
      // Refreshed since it was saved: the live copy wins over the stale store copy.
      await saveSource(current, activeConfig);
    }
    assertHeld();
    await persistPhase(context, journal, "activating", deps, assertHeld);
  }
  if (journal.phase === "activating") {
    const targetToken = token(await credentials.read(target));
    if (!targetToken)
      throw new ClaudeCredentialSwitchError(
        "Claude target account has no saved credentials; recovery is required.",
      );
    const current = await credentials.read(active);
    const currentFingerprint = fingerprint(token(current));
    const config = await readJson(NodePath.join(target.home, ".claude.json"));
    if (currentFingerprint === undefined || currentFingerprint === journal.sourceFingerprint) {
      current.claudeAiOauth = targetToken;
      assertHeld();
      await credentials.write(active, current, assertHeld);
    } else if (
      currentFingerprint !== journal.targetFingerprint &&
      !sameIdentity(await readJson(journal.activeConfigPath), config)
    ) {
      // The credentials write may or may not have landed before a refresh rotated the
      // token; only a target identity in the config (written after credentials) proves
      // it did. Without that, authority cannot be established: delete nothing.
      throw new ClaudeCredentialSwitchError(
        "Claude active credentials changed during interrupted switching; recovery left untouched.",
      );
    }
    // Otherwise activation already happened (and may have refreshed); keep the active copy.
    assertHeld();
    await setIdentity(journal.activeConfigPath, config.oauthAccount, assertHeld, deps);
    assertHeld();
    await persistPhase(context, journal, "activated", deps, assertHeld);
  }
  if (["activated", "checked-out", "committed"].includes(journal.phase)) {
    const activeConfig = await readJson(journal.activeConfigPath);
    const targetConfig = await readJson(NodePath.join(target.home, ".claude.json"));
    if (!sameIdentity(activeConfig, targetConfig) || !token(await credentials.read(active))) {
      throw new ClaudeCredentialSwitchError(
        "Claude active identity changed during interrupted switching; recovery left untouched.",
      );
    }
  }
  if (journal.phase === "activated") {
    if (!token(await credentials.read(active)))
      throw new ClaudeCredentialSwitchError(
        "Claude active credentials are missing; recovery is required.",
      );
    const checkedOut = await credentials.read(target);
    const storeFingerprint = fingerprint(token(checkedOut));
    // Only the duplicate we moved may be removed; anything else was written by someone else.
    if (storeFingerprint !== undefined && storeFingerprint !== journal.targetFingerprint) {
      throw new ClaudeCredentialSwitchError(
        "Claude target store credentials changed during interrupted switching; recovery left untouched.",
      );
    }
    if (storeFingerprint !== undefined) {
      delete checkedOut.claudeAiOauth;
      assertHeld();
      await credentials.write(target, checkedOut, assertHeld);
    }
    assertHeld();
    await persistPhase(context, journal, "checked-out", deps, assertHeld);
  }
  assertHeld();
  await context.commit(result(journal));
  assertHeld();
  await persistPhase(context, journal, "committed", deps, assertHeld);
  assertHeld();
  await NodeFSP.unlink(NodePath.join(context.stateDir, journalName));
  await syncDirectory(context.stateDir);
  return result(journal);
}

/** Move only the OAuth lineage and identity. The registry commit must be durable and idempotent. */
export async function switchClaudeCredentials(
  input: ClaudeCredentialSwitchInput,
  deps: Dependencies = {},
) {
  await NodeFSP.mkdir(input.activeHome, { recursive: true, mode: 0o700 });
  await validateLocations(input, input.sourceStore, input.targetStore);
  const locks = deps.locks ?? safeLocks;
  const homes = [input.activeHome, input.sourceStore, input.targetStore];
  const discovered = await locks(homes, async (assertHeld) => {
    if (
      await NodeFSP.stat(NodePath.join(input.stateDir, journalName)).catch((error: unknown) => {
        if (missing(error)) return undefined;
        throw error;
      })
    )
      throw new ClaudeCredentialSwitchError("Recover the pending Claude credential switch first.");
    const config = await readJson(input.activeConfigPath);
    const observed = identity(config);
    const mismatch =
      (input.expectedEmail !== undefined &&
        observed.email?.toLowerCase() !== input.expectedEmail.toLowerCase()) ||
      (input.expectedAccountUuid !== undefined &&
        observed.accountUuid !== input.expectedAccountUuid);
    if (!mismatch)
      return {
        store: input.sourceStore,
        accountId: input.sourceAccountId,
        observed,
        fingerprint: JSON.stringify(config.oauthAccount),
        external: false,
      };
    if (!input.resolveSource)
      throw new ClaudeCredentialSwitchError(
        "Claude active account changed outside the application.",
      );
    const resolved = await input.resolveSource(observed);
    assertHeld();
    return {
      ...resolved,
      observed,
      fingerprint: JSON.stringify(config.oauthAccount),
      external: true,
    };
  });
  const sourceStore = discovered.store;
  let journaled = false;
  try {
    await validateLocations(input, sourceStore, input.targetStore);
    return await locks([...homes, sourceStore], async (assertHeld) => {
      const config = await readJson(input.activeConfigPath);
      if (JSON.stringify(config.oauthAccount) !== discovered.fingerprint) {
        throw new ClaudeCredentialSwitchError(
          "Claude active identity changed during switching; retry.",
        );
      }
      const pending = await readJson(NodePath.join(input.stateDir, journalName));
      if (Object.keys(pending).length)
        throw new ClaudeCredentialSwitchError(
          "Recover the pending Claude credential switch first.",
        );
      const credentials = adapter(deps);
      const activeCredentials = await credentials.read(activeLocation(input));
      const sourceCredentials = await credentials.read(storeLocation(sourceStore));
      const targetCredentials = await credentials.read(storeLocation(input.targetStore));
      const activeToken = token(activeCredentials);
      const sourceToken = token(sourceCredentials);
      const targetToken = token(targetCredentials);
      if (!targetToken)
        throw new ClaudeCredentialSwitchError("Claude target account is signed out.");
      const targetConfig = await readJson(NodePath.join(input.targetStore, ".claude.json"));
      if (!identity(targetConfig).accountUuid && !identity(targetConfig).email) {
        throw new ClaudeCredentialSwitchError(
          "Claude target account identity is missing; sign in again.",
        );
      }
      // A stale copy of the same identity is superseded by the live token; anything else in
      // the store is a lineage we do not own and must not be overwritten.
      if (
        activeToken &&
        sourceToken &&
        fingerprint(sourceToken) !== fingerprint(activeToken) &&
        !sameIdentity(await readJson(NodePath.join(sourceStore, ".claude.json")), config)
      ) {
        throw new ClaudeCredentialSwitchError(
          "Claude source store already holds another credential lineage; recovery left untouched.",
        );
      }
      // Storage limits are checked for every payload the transaction will write, before
      // the journal makes any of them mandatory.
      const { claudeAiOauth: _checkedOut, ...targetRest } = targetCredentials;
      const sourceFingerprint = fingerprint(activeToken);
      for (const payload of [
        activeToken ? { ...sourceCredentials, claudeAiOauth: activeToken } : sourceCredentials,
        { ...activeCredentials, claudeAiOauth: targetToken },
        targetRest,
      ]) {
        credentials.validate?.(payload);
      }
      const journal: Journal = {
        version: 1,
        phase: "prepared",
        activeHome: input.activeHome,
        activeConfigPath: input.activeConfigPath,
        ...(input.activeConfigDir === undefined ? {} : { activeConfigDir: input.activeConfigDir }),
        sourceStore,
        sourceAccountId: discovered.accountId,
        targetStore: input.targetStore,
        targetAccountId: input.targetAccountId,
        originalSourceAccountId: input.sourceAccountId,
        sourceIdentity: discovered.observed,
        ...(discovered.external ? { externalIdentity: discovered.observed } : {}),
        ...(sourceFingerprint === undefined ? {} : { sourceFingerprint }),
        targetFingerprint: fingerprint(targetToken)!,
      };
      assertHeld();
      await persistPhase(input, journal, "prepared", deps, assertHeld);
      journaled = true;
      return finish(input, journal, deps, assertHeld);
    });
  } catch (error) {
    if (!journaled && discovered.external && discovered.discard)
      await discovered.discard().catch(() => undefined);
    throw error;
  }
}

/** Recovery never trusts persisted paths without comparing the current configured home/root. */
export async function recoverClaudeCredentialSwitch(input: Context, deps: Dependencies = {}) {
  const value = await readJson(NodePath.join(input.stateDir, journalName));
  if (!Object.keys(value).length) return undefined;
  if (
    value.version !== 1 ||
    !["prepared", "source-saved", "activating", "activated", "checked-out", "committed"].includes(
      String(value.phase),
    ) ||
    typeof value.activeHome !== "string" ||
    typeof value.activeConfigPath !== "string" ||
    typeof value.sourceStore !== "string" ||
    typeof value.targetStore !== "string" ||
    typeof value.sourceAccountId !== "string" ||
    typeof value.targetAccountId !== "string" ||
    typeof value.originalSourceAccountId !== "string" ||
    !object(value.sourceIdentity) ||
    (value.sourceIdentity.email !== undefined && typeof value.sourceIdentity.email !== "string") ||
    (value.sourceIdentity.accountUuid !== undefined &&
      typeof value.sourceIdentity.accountUuid !== "string") ||
    (value.activeConfigDir !== undefined && typeof value.activeConfigDir !== "string") ||
    (value.sourceFingerprint !== undefined && typeof value.sourceFingerprint !== "string") ||
    (value.targetFingerprint !== undefined && typeof value.targetFingerprint !== "string") ||
    value.activeHome !== input.activeHome ||
    value.activeConfigPath !== input.activeConfigPath ||
    value.activeConfigDir !== input.activeConfigDir
  ) {
    throw new ClaudeCredentialSwitchError(
      "Claude switch journal does not match the configured active home; recovery left untouched.",
    );
  }
  const journal = value as Journal;
  await validateLocations(input, journal.sourceStore, journal.targetStore);
  return (deps.locks ?? safeLocks)(
    [journal.activeHome, journal.sourceStore, journal.targetStore],
    async (assertHeld) => {
      const current = await readJson(NodePath.join(input.stateDir, journalName));
      if (!Object.keys(current).length) return undefined;
      if (JSON.stringify(current) !== JSON.stringify(journal)) {
        throw new ClaudeCredentialSwitchError(
          "Claude switch journal changed while waiting for locks; retry recovery.",
        );
      }
      await validateLocations(input, journal.sourceStore, journal.targetStore);
      return finish(input, journal, deps, assertHeld);
    },
  );
}

/** Both lock failures carry messages that are safe to show; keep them, pass everything else through. */
function sanitizeLockError(error: unknown) {
  if (
    error instanceof ClaudeCredentialLockTimeoutError ||
    (error instanceof Error &&
      error.message === "Could not safely lock Claude credentials. Try again shortly.")
  ) {
    return new ClaudeCredentialSwitchError(error.message);
  }
  return error;
}
async function safeLocks<T>(
  homes: readonly string[],
  operation: (assertHeld: () => void) => Promise<T>,
): Promise<T> {
  try {
    return await withClaudeCredentialLocks(homes, operation);
  } catch (error) {
    throw sanitizeLockError(error);
  }
}
