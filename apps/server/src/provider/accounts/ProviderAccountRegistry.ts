import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { materializeClaudeAccountHome } from "./ClaudeAccountHome.ts";
import { materializeCodexAccountHome } from "./CodexAccountHome.ts";
import { syncDirectory } from "./durableFs.ts";

/** Safe, user-facing registry validation failure; never includes credential contents. */
export class ProviderAccountRegistryGuardError extends Error {}

const Driver = Schema.Literals(["claudeAgent", "codex"]);
export type ProviderAccountDriver = typeof Driver.Type;
const LastUsage = Schema.Struct({
  email: Schema.optional(Schema.String),
  accountUuid: Schema.optional(Schema.String),
  /** Claude organizationUuid or Codex chatgpt_account_id; part of the account's identity. */
  workspaceId: Schema.optional(Schema.String),
  plan: Schema.optional(Schema.String),
  usage: Schema.optional(ServerProviderUsageLimits),
  checkedAt: Schema.String,
  lastAttemptAt: Schema.optional(Schema.Number),
  consecutiveFailures: Schema.optional(Schema.Number),
  nextAllowedAt: Schema.optional(Schema.Number),
  lastFailureKind: Schema.optional(Schema.Literals(["rateLimited", "failed"])),
});
export type ProviderAccountLastUsage = typeof LastUsage.Type;
const Entry = Schema.Struct({
  id: Schema.String,
  driver: Driver,
  label: Schema.String,
  kind: Schema.Literals(["default", "managed", "external"]),
  homePath: Schema.String,
  // Claude's saved overlay is separate from its stable active/configured home.
  storePath: Schema.optional(Schema.String),
  // Resolved homePath remains the match key; Default restores this exact Settings value.
  originalHomePath: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  createdAt: Schema.String,
  lastUsage: Schema.optional(LastUsage),
  status: Schema.Literals(["ready", "pending", "signedOut", "error"]),
});
export type ProviderAccountEntry = typeof Entry.Type;
const AutoSwitch = Schema.Struct({
  enabled: Schema.Boolean,
  thresholdPercent: Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 50 })),
  /** Files from before the separate weekly threshold omit it; reads default it to 2. */
  weeklyThresholdPercent: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 25 })),
  ),
  lastSwitch: Schema.optional(
    Schema.Struct({
      at: Schema.String,
      fromAccountId: Schema.String,
      toAccountId: Schema.String,
      trigger: Schema.Literals(["session", "weekly", "signedOut", "expiring"]),
      reason: Schema.String,
    }),
  ),
  /** Last manual switch; only delays proactive rebalancing, never a threshold switch. */
  lastManualSwitchAt: Schema.optional(Schema.String),
  // A legacy `manual` hold field from older builds is stripped by decode and dropped on write.
});
type StoredAutoSwitch = typeof AutoSwitch.Type;
export type ProviderAccountAutoSwitch = StoredAutoSwitch & { weeklyThresholdPercent: number };
export type ProviderAccountAutoSwitchPatch = Partial<ProviderAccountAutoSwitch>;
const defaultWeeklyThresholdPercent = 2;
const WindowPrimer = Schema.Struct({
  enabled: Schema.Boolean,
  /** Epoch ms of each account's last successful window start, keyed by account id. */
  primedAt: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
});
export type ProviderAccountWindowPrimer = typeof WindowPrimer.Type;
const StoredRegistry = Schema.Struct({
  version: Schema.Literal(1),
  accounts: Schema.Array(Entry),
  claudeActiveAccountId: Schema.optional(Schema.String),
  sharedHomes: Schema.Record(Schema.String, Schema.String),
  autoSwitch: Schema.optional(
    Schema.Struct({
      claudeAgent: Schema.optional(AutoSwitch),
      codex: Schema.optional(AutoSwitch),
    }),
  ),
  windowPrimer: Schema.optional(Schema.Struct({ claudeAgent: Schema.optional(WindowPrimer) })),
});

const decodeStoredRegistry = Schema.decodeUnknownSync(StoredRegistry);
const decodeEntry = Schema.decodeUnknownSync(Entry);

export const codexSharedHomeChangedMessage = (capturedSharedHomePath: string) =>
  `Codex home changed in Settings. Saved accounts were set up for ${capturedSharedHomePath}; restore it in Settings to switch.`;

function isMissing(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function normalizeHome(driver: ProviderAccountDriver, homePath: string | undefined) {
  if (driver === "codex" && !homePath?.trim()) return "";
  if (!homePath?.trim())
    throw new ProviderAccountRegistryGuardError(
      "Claude account home must be resolved before capture.",
    );
  return NodePath.resolve(homePath);
}

/** Metadata only. CLI-owned credentials never enter the registry. Callers wrap failures in ProviderAccountError. */
export async function createProviderAccountRegistry(input: { stateDir: string }) {
  const root = NodePath.join(input.stateDir, "fork", "provider-accounts");
  const filePath = NodePath.join(root, "accounts.json");
  await NodeFSP.mkdir(root, { recursive: true, mode: 0o700 });
  await NodeFSP.chmod(root, 0o700);
  const raw = await NodeFSP.readFile(filePath, "utf8").catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  let stored =
    raw === undefined
      ? StoredRegistry.make({ version: 1, accounts: [], sharedHomes: {} })
      : decodeStoredRegistry(JSON.parse(raw));
  const external = new Map<string, ProviderAccountEntry>();
  let queue = Promise.resolve();
  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation);
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  async function persist(next: typeof StoredRegistry.Type) {
    // Decode strips extra fields even when an untyped caller supplies them.
    const clean = decodeStoredRegistry(next);
    const temporary = `${filePath}.${NodeCrypto.randomUUID()}.tmp`;
    try {
      // Credential moves commit against this file: it must be durable before they finish.
      const file = await NodeFSP.open(temporary, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(clean, null, 2)}\n`);
        await file.sync();
      } finally {
        await file.close();
      }
      await NodeFSP.rename(temporary, filePath);
      await syncDirectory(root);
      stored = clean;
    } finally {
      await NodeFSP.rm(temporary, { force: true });
    }
  }
  function find(id: string) {
    const entry = stored.accounts.find((entry) => entry.id === id) ?? external.get(id);
    if (!entry) throw new ProviderAccountRegistryGuardError("Account not found.");
    return entry;
  }
  function activeAccount(driver: ProviderAccountDriver, homePath: string) {
    const accounts = stored.accounts.filter((entry) => entry.driver === driver);
    const defaultAccount = accounts.find((entry) => entry.kind === "default");
    if (driver === "claudeAgent" && homePath === defaultAccount?.homePath) {
      const selected = accounts.find((entry) => entry.id === stored.claudeActiveAccountId);
      if (selected) return selected;
    }
    // Preserve phase-one managed-home matching when Settings still points at an overlay.
    return accounts.find((entry) => entry.homePath === homePath);
  }
  async function list(
    driver: ProviderAccountDriver,
    currentHomePath: string | undefined,
    sharedHomePath?: string,
    originalHomePath?: string,
  ) {
    const homePath = normalizeHome(driver, currentHomePath);
    if (!stored.accounts.some((entry) => entry.driver === driver && entry.kind === "default")) {
      if (!sharedHomePath && homePath === "")
        throw new ProviderAccountRegistryGuardError(
          "Shared Codex home is required for default capture.",
        );
      const entry: ProviderAccountEntry = {
        id: `${driver}-default`,
        driver,
        label: "Default",
        kind: "default",
        homePath,
        ...(originalHomePath !== undefined ? { originalHomePath } : {}),
        createdAt: new Date().toISOString(),
        status: "ready",
      };
      await persist({
        ...stored,
        accounts: [...stored.accounts, entry],
        sharedHomes: {
          ...stored.sharedHomes,
          [driver]: NodePath.resolve(sharedHomePath || homePath),
        },
      });
    }
    const accounts = stored.accounts.filter((entry) => entry.driver === driver);
    let active = activeAccount(driver, homePath);
    if (!active) {
      const id = `${driver}-external-${NodeCrypto.createHash("sha256").update(homePath).digest("hex").slice(0, 24)}`;
      active = external.get(id) ?? {
        id,
        driver,
        label: "Configured in Settings",
        kind: "external",
        homePath,
        createdAt: new Date().toISOString(),
        status: "ready",
      };
      external.set(id, active);
      accounts.push(active);
    }
    const capturedSharedHomePath = stored.sharedHomes[driver]!;
    // Codex overlays are bound to the shared home they were set up for; a home edited in
    // Settings is surfaced, never repaired. Direct Default follows whatever home is configured.
    const warning =
      driver === "codex" &&
      sharedHomePath &&
      NodePath.resolve(sharedHomePath) !== capturedSharedHomePath
        ? codexSharedHomeChangedMessage(capturedSharedHomePath)
        : undefined;
    return structuredClone({
      accounts,
      activeAccountId: active.id,
      sharedHomePath: capturedSharedHomePath,
      ...(warning ? { warning } : {}),
    });
  }
  function getAutoSwitch(driver: ProviderAccountDriver): ProviderAccountAutoSwitch {
    const config = stored.autoSwitch?.[driver] ?? { enabled: false, thresholdPercent: 10 };
    return structuredClone({
      ...config,
      weeklyThresholdPercent: config.weeklyThresholdPercent ?? defaultWeeklyThresholdPercent,
    });
  }
  function getWindowPrimer(): ProviderAccountWindowPrimer {
    return structuredClone(stored.windowPrimer?.claudeAgent ?? { enabled: false });
  }
  return {
    getWindowPrimer: () => serialized(async () => getWindowPrimer()),
    updateWindowPrimer: (patch: {
      enabled?: boolean;
      primed?: { accountId: string; at: number };
    }) =>
      serialized(async () => {
        const previous = getWindowPrimer();
        // Only saved accounts keep a timestamp, so removed accounts never linger here.
        const primedAt = Object.fromEntries(
          Object.entries({
            ...previous.primedAt,
            ...(patch.primed ? { [patch.primed.accountId]: patch.primed.at } : {}),
          }).filter(([id]) => stored.accounts.some((entry) => entry.id === id)),
        );
        const next: ProviderAccountWindowPrimer = {
          enabled: patch.enabled ?? previous.enabled,
          ...(Object.keys(primedAt).length > 0 ? { primedAt } : {}),
        };
        await persist({ ...stored, windowPrimer: { ...stored.windowPrimer, claudeAgent: next } });
        return getWindowPrimer();
      }),
    getAutoSwitch: (driver: ProviderAccountDriver) => serialized(async () => getAutoSwitch(driver)),
    updateAutoSwitch: (driver: ProviderAccountDriver, patch: ProviderAccountAutoSwitchPatch) =>
      serialized(async () => {
        const previous = getAutoSwitch(driver);
        const thresholdPercent =
          patch.thresholdPercent === undefined ? previous.thresholdPercent : patch.thresholdPercent;
        if (!Number.isInteger(thresholdPercent) || thresholdPercent < 5 || thresholdPercent > 50) {
          throw new ProviderAccountRegistryGuardError(
            "Auto-switch threshold must be an integer between 5 and 50.",
          );
        }
        const weeklyThresholdPercent =
          patch.weeklyThresholdPercent ?? previous.weeklyThresholdPercent;
        if (
          !Number.isInteger(weeklyThresholdPercent) ||
          weeklyThresholdPercent < 1 ||
          weeklyThresholdPercent > 25
        ) {
          throw new ProviderAccountRegistryGuardError(
            "Weekly auto-switch threshold must be an integer between 1 and 25.",
          );
        }
        const next: ProviderAccountAutoSwitch = {
          ...previous,
          enabled: patch.enabled ?? previous.enabled,
          thresholdPercent,
          weeklyThresholdPercent,
          ...(patch.lastSwitch !== undefined ? { lastSwitch: patch.lastSwitch } : {}),
          ...(patch.lastManualSwitchAt !== undefined
            ? { lastManualSwitchAt: patch.lastManualSwitchAt }
            : {}),
        };
        await persist({ ...stored, autoSwitch: { ...stored.autoSwitch, [driver]: next } });
        return getAutoSwitch(driver);
      }),
    list: (
      driver: ProviderAccountDriver,
      currentHomePath: string | undefined,
      sharedHomePath?: string,
      originalHomePath?: string,
    ) => serialized(() => list(driver, currentHomePath, sharedHomePath, originalHomePath)),
    prepareSwitch: (
      driver: ProviderAccountDriver,
      currentHomePath: string | undefined,
      sharedHomePath: string | undefined,
      targetAccountId: string,
      originalHomePath?: string,
    ) =>
      serialized(async () => {
        const snapshot = await list(driver, currentHomePath, sharedHomePath, originalHomePath);
        const target = find(targetAccountId);
        if (target.driver !== driver)
          throw new ProviderAccountRegistryGuardError("Account belongs to another provider.");
        // Only direct Default (cleared shadowHomePath) stays valid under a changed shared home.
        if (snapshot.warning && target.homePath !== "")
          throw new ProviderAccountRegistryGuardError(snapshot.warning);
        const active = find(snapshot.activeAccountId);
        if (!stored.accounts.some((entry) => entry.id === active.id)) {
          await persist({ ...stored, accounts: [...stored.accounts, active] });
        }
        return snapshot;
      }),
    get: (id: string) => serialized(async () => structuredClone(find(id))),
    ensureClaudeStore: (accountId: string) =>
      serialized(async () => {
        const previous = find(accountId);
        if (previous.driver !== "claudeAgent")
          throw new ProviderAccountRegistryGuardError("Account belongs to another provider.");
        if (previous.storePath) return structuredClone(previous);
        const storePath =
          previous.kind === "managed"
            ? previous.homePath
            : NodePath.join(root, "claude", NodeCrypto.randomUUID());
        try {
          if (previous.kind !== "managed") {
            await materializeClaudeAccountHome({
              homePath: storePath,
              sharedHomePath: stored.sharedHomes.claudeAgent ?? previous.homePath,
            });
          }
          const entry = { ...previous, storePath };
          await persist({
            ...stored,
            accounts: stored.accounts.some((item) => item.id === accountId)
              ? stored.accounts.map((item) => (item.id === accountId ? entry : item))
              : [...stored.accounts, entry],
          });
          return structuredClone(entry);
        } catch (error) {
          if (previous.kind !== "managed")
            await NodeFSP.rm(storePath, { recursive: true, force: true });
          throw error;
        }
      }),
    setClaudeActiveAccount: (accountId: string) =>
      serialized(async () => {
        const entry = find(accountId);
        if (entry.driver !== "claudeAgent")
          throw new ProviderAccountRegistryGuardError("Account belongs to another provider.");
        if (!stored.accounts.some((item) => item.id === accountId))
          throw new ProviderAccountRegistryGuardError("Account must be saved before activation.");
        await persist({ ...stored, claudeActiveAccountId: accountId });
        return structuredClone(entry);
      }),
    createManaged: (options: {
      driver: ProviderAccountDriver;
      label: string;
      sharedHomePath: string;
      sourceConfigPath?: string;
    }) =>
      serialized(async () => {
        const label = options.label.trim();
        if (!label) throw new ProviderAccountRegistryGuardError("Account label must not be empty.");
        const id = NodeCrypto.randomUUID();
        const homePath = NodePath.join(
          root,
          options.driver === "claudeAgent" ? "claude" : "codex",
          id,
        );
        const materialize =
          options.driver === "claudeAgent"
            ? materializeClaudeAccountHome
            : materializeCodexAccountHome;
        try {
          await materialize({
            homePath,
            sharedHomePath: options.sharedHomePath,
            ...(options.sourceConfigPath !== undefined
              ? { sourceConfigPath: options.sourceConfigPath }
              : {}),
          });
          const entry: ProviderAccountEntry = {
            id,
            driver: options.driver,
            label,
            kind: "managed",
            homePath,
            createdAt: new Date().toISOString(),
            status: "pending",
          };
          await persist({ ...stored, accounts: [...stored.accounts, entry] });
          return structuredClone(entry);
        } catch (error) {
          // NodeFSP.rm unlinks overlay symlinks; it never traverses their targets.
          await NodeFSP.rm(homePath, { recursive: true, force: true });
          throw error;
        }
      }),
    rename: (id: string, label: string) =>
      serialized(async () => {
        if (!label.trim())
          throw new ProviderAccountRegistryGuardError("Account label must not be empty.");
        const entry = { ...find(id), label: label.trim() };
        // Keep the account's position: the dialog lists accounts in creation order.
        await persist({
          ...stored,
          accounts: stored.accounts.some((item) => item.id === id)
            ? stored.accounts.map((item) => (item.id === id ? entry : item))
            : [...stored.accounts, entry],
        });
        return structuredClone(entry);
      }),
    update: (
      id: string,
      patch: {
        status?: ProviderAccountEntry["status"];
        lastUsage?: ProviderAccountLastUsage;
        message?: string | null;
      },
    ) =>
      serialized(async () => {
        const previous = find(id);
        let lastUsage = patch.lastUsage ?? previous.lastUsage;
        if (lastUsage?.usage?.unavailable?.reason === "probeFailed" && previous.lastUsage?.usage) {
          const {
            checkedAt: _,
            email: _email,
            accountUuid: _accountUuid,
            workspaceId: _workspaceId,
            plan: _plan,
            usage,
            ...attempt
          } = lastUsage;
          lastUsage = {
            ...previous.lastUsage,
            ...attempt,
            usage: { ...previous.lastUsage.usage, unavailable: usage.unavailable },
          };
        }
        const { message: previousMessage, ...metadata } = previous;
        const message = patch.message === undefined ? previousMessage : patch.message;
        const entry: ProviderAccountEntry = {
          ...metadata,
          ...(message !== undefined && message !== null ? { message } : {}),
          status: patch.status ?? previous.status,
          ...(lastUsage ? { lastUsage } : {}),
        };
        if (stored.accounts.some((item) => item.id === id)) {
          await persist({
            ...stored,
            accounts: stored.accounts.map((item) => (item.id === id ? entry : item)),
          });
        } else {
          external.set(id, decodeEntry(entry));
        }
        return structuredClone(entry);
      }),
    discardPending: (id: string) =>
      serialized(async () => {
        const entry = find(id);
        if (entry.kind !== "managed" || entry.status !== "pending") {
          throw new ProviderAccountRegistryGuardError(
            "Only pending managed accounts can be discarded.",
          );
        }
        await persist({ ...stored, accounts: stored.accounts.filter((item) => item.id !== id) });
        return structuredClone(entry);
      }),
    remove: (id: string, currentHomePath: string | undefined) =>
      serialized(async () => {
        const entry = find(id);
        if (entry.kind === "default")
          throw new ProviderAccountRegistryGuardError("Default accounts cannot be removed.");
        const homePath = normalizeHome(entry.driver, currentHomePath);
        if (entry.id === activeAccount(entry.driver, homePath)?.id || entry.homePath === homePath)
          throw new ProviderAccountRegistryGuardError("Active accounts cannot be removed.");
        await persist({ ...stored, accounts: stored.accounts.filter((item) => item.id !== id) });
        external.delete(id);
        // Managed homes are removed by the service only after provider logout.
        return structuredClone(entry);
      }),
  };
}
export type ProviderAccountRegistry = Awaited<ReturnType<typeof createProviderAccountRegistry>>;
