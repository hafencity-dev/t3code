// fork: append-only record of what the account switcher did, per environment.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  PROVIDER_ACCOUNT_ACTIVITY_MAX_LIMIT,
  ProviderAccountActivityEntry,
  type ProviderAccountsActivityInput,
  type ProviderAccountsActivityResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { syncDirectory } from "./durableFs.ts";

/** Entries kept after a trim; the file is rewritten once it grows past `ACTIVITY_REWRITE_AT`. */
export const ACTIVITY_KEEP = PROVIDER_ACCOUNT_ACTIVITY_MAX_LIMIT;
export const ACTIVITY_REWRITE_AT = 600;
const DEFAULT_LIMIT = 100;

export type ProviderAccountActivityRecord = Omit<ProviderAccountActivityEntry, "id" | "at">;

const decodeEntry = Schema.decodeUnknownOption(ProviderAccountActivityEntry);
const encodeEntry = Schema.encodeSync(ProviderAccountActivityEntry);

const text = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/** Trims free text and drops empty values, so a record always encodes. */
function clean(record: ProviderAccountActivityRecord): ProviderAccountActivityRecord {
  const { labels, reason, message, ...rest } = record;
  const account = text(labels.account);
  const from = text(labels.from);
  const to = text(labels.to);
  const shortReason = text(reason);
  const longMessage = text(message);
  return {
    ...rest,
    labels: {
      ...(account ? { account } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    },
    ...(shortReason ? { reason: shortReason } : {}),
    ...(longMessage && longMessage !== shortReason ? { message: longMessage } : {}),
  };
}

function isMissing(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** Only labels, account ids, and safe messages are written; never tokens, codes, or CLI output. */
export function createProviderAccountActivityLog(input: { stateDir: string }) {
  const root = NodePath.join(input.stateDir, "fork", "provider-accounts");
  const filePath = NodePath.join(root, "activity.jsonl");
  let lines: number | undefined;
  let sequence = 0;
  let queue = Promise.resolve();
  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation);
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  /** Oldest first; a corrupt or unknown line is skipped, never fatal. */
  async function readAll() {
    const raw = await NodeFSP.readFile(filePath, "utf8").catch((error: unknown) => {
      if (isMissing(error)) return "";
      throw error;
    });
    const rows = raw.split("\n").filter((line) => line.trim().length > 0);
    lines = rows.length;
    return rows.flatMap((line) => {
      try {
        const entry = decodeEntry(JSON.parse(line));
        return entry._tag === "Some" ? [entry.value] : [];
      } catch {
        return [];
      }
    });
  }
  async function rewrite(entries: ReadonlyArray<ProviderAccountActivityEntry>) {
    const temporary = `${filePath}.${NodeCrypto.randomUUID()}.tmp`;
    try {
      const file = await NodeFSP.open(temporary, "wx", 0o600);
      try {
        await file.writeFile(
          entries.map((entry) => `${JSON.stringify(encodeEntry(entry))}\n`).join(""),
        );
        await file.sync();
      } finally {
        await file.close();
      }
      await NodeFSP.rename(temporary, filePath);
      await syncDirectory(root);
      lines = entries.length;
    } finally {
      await NodeFSP.rm(temporary, { force: true });
    }
  }
  return {
    filePath,
    /** Resolves once every queued write has finished; appends are never awaited by callers. */
    settled: () => queue,
    /** Rejects on I/O failure; callers log and swallow it so no action fails on the log. */
    append: (record: ProviderAccountActivityRecord, atMs: number) =>
      serialized(async () => {
        // Sortable within a process: time, then a sequence, then noise against restarts.
        const id = `${String(Math.max(0, Math.floor(atMs))).padStart(13, "0")}-${String(sequence++).padStart(6, "0")}-${NodeCrypto.randomBytes(2).toString("hex")}`;
        const entry: ProviderAccountActivityEntry = {
          ...clean(record),
          id,
          at: new Date(atMs).toISOString(),
        };
        await NodeFSP.mkdir(root, { recursive: true, mode: 0o700 });
        if (lines === undefined) await readAll();
        const file = await NodeFSP.open(filePath, "a", 0o600);
        try {
          await file.chmod(0o600);
          await file.appendFile(`${JSON.stringify(encodeEntry(entry))}\n`);
        } finally {
          await file.close();
        }
        lines = (lines ?? 0) + 1;
        if (lines > ACTIVITY_REWRITE_AT) await rewrite((await readAll()).slice(-ACTIVITY_KEEP));
        return entry;
      }),
    read: (query: ProviderAccountsActivityInput): Promise<ProviderAccountsActivityResult> =>
      serialized(async () => {
        const limit = Math.min(
          PROVIDER_ACCOUNT_ACTIVITY_MAX_LIMIT,
          Math.max(1, query.limit ?? DEFAULT_LIMIT),
        );
        const matching = (await readAll())
          .filter((entry) => query.driver === undefined || entry.driver === query.driver)
          .toReversed();
        // Ids sort by time, so a cursor still works after its own entry was trimmed.
        const start =
          query.before === undefined
            ? 0
            : (() => {
                const index = matching.findIndex((entry) => entry.id === query.before);
                if (index !== -1) return index + 1;
                const older = matching.findIndex((entry) => entry.id < query.before!);
                return older === -1 ? matching.length : older;
              })();
        const entries = matching.slice(start, start + limit);
        const more = start + limit < matching.length;
        return {
          entries,
          ...(more && entries.length > 0 ? { nextCursor: entries.at(-1)!.id } : {}),
        };
      }),
  };
}
export type ProviderAccountActivityLog = ReturnType<typeof createProviderAccountActivityLog>;
