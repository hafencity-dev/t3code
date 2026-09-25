// fork: provider accounts
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ProviderAccountId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  ACTIVITY_KEEP,
  ACTIVITY_REWRITE_AT,
  createProviderAccountActivityLog,
  type ProviderAccountActivityRecord,
} from "./ProviderAccountActivityLog.ts";

const removed = (label: string): ProviderAccountActivityRecord => ({
  driver: "claudeAgent",
  kind: "account.removed",
  accountId: ProviderAccountId.make(`id-${label}`),
  labels: { account: label },
  outcome: "ok",
});

describe("ProviderAccountActivityLog", () => {
  let stateDir: string;
  beforeEach(async () => {
    stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "provider-account-activity-"));
  });
  afterEach(async () => {
    await NodeFSP.rm(stateDir, { recursive: true, force: true });
  });

  it("appends to a private file and reads newest first, filtered by provider", async () => {
    const log = createProviderAccountActivityLog({ stateDir });
    await log.append(removed("first"), 1_000);
    await log.append({ ...removed("codex"), driver: "codex" }, 2_000);
    await log.append(removed("second"), 3_000);
    expect((await NodeFSP.stat(log.filePath)).mode & 0o777).toBe(0o600);
    const all = await log.read({});
    expect(all.entries.map((entry) => entry.labels.account)).toEqual(["second", "codex", "first"]);
    expect(all.entries[0]).toMatchObject({ at: new Date(3_000).toISOString(), outcome: "ok" });
    expect(all.nextCursor).toBeUndefined();
    const claude = await log.read({ driver: "claudeAgent" });
    expect(claude.entries.map((entry) => entry.labels.account)).toEqual(["second", "first"]);
  });

  it("pages with a cursor, even after the cursor's own entry was trimmed", async () => {
    const log = createProviderAccountActivityLog({ stateDir });
    for (let index = 0; index < 5; index++) await log.append(removed(`a${index}`), index);
    const first = await log.read({ limit: 2 });
    expect(first.entries.map((entry) => entry.labels.account)).toEqual(["a4", "a3"]);
    const second = await log.read({ limit: 2, before: first.nextCursor! });
    expect(second.entries.map((entry) => entry.labels.account)).toEqual(["a2", "a1"]);
    const last = await log.read({ limit: 2, before: second.nextCursor! });
    expect(last.entries.map((entry) => entry.labels.account)).toEqual(["a0"]);
    expect(last.nextCursor).toBeUndefined();
    // An id that is no longer in the file still continues with everything older than it.
    const gone = `${first.entries[1]!.id.slice(0, -4)}0000`;
    expect((await log.read({ before: gone })).entries[0]?.labels.account).toBe("a2");
  });

  it("keeps the last 500 entries once the file grows past 600 lines", async () => {
    const log = createProviderAccountActivityLog({ stateDir });
    for (let index = 0; index <= ACTIVITY_REWRITE_AT; index++)
      await log.append(removed(`n${index}`), index);
    const lines = (await NodeFSP.readFile(log.filePath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(ACTIVITY_KEEP);
    const page = await log.read({ limit: 500 });
    expect(page.entries).toHaveLength(ACTIVITY_KEEP);
    expect(page.entries[0]?.labels.account).toBe(`n${ACTIVITY_REWRITE_AT}`);
    expect(page.entries.at(-1)?.labels.account).toBe(`n${ACTIVITY_REWRITE_AT - ACTIVITY_KEEP + 1}`);
    expect(page.nextCursor).toBeUndefined();
    // A fresh process counts the file it finds instead of trimming again right away.
    const reopened = createProviderAccountActivityLog({ stateDir });
    await reopened.append(removed("after"), 10_000);
    expect((await NodeFSP.readFile(log.filePath, "utf8")).trim().split("\n")).toHaveLength(
      ACTIVITY_KEEP + 1,
    );
  });

  it("skips a corrupt or unknown line instead of failing", async () => {
    const log = createProviderAccountActivityLog({ stateDir });
    await log.append(removed("before"), 1_000);
    await NodeFSP.appendFile(log.filePath, '{"broken":\n{"kind":"from.the.future"}\n');
    await log.append(removed("after"), 2_000);
    expect((await log.read({})).entries.map((entry) => entry.labels.account)).toEqual([
      "after",
      "before",
    ]);
  });

  it("drops empty free text so every entry still decodes", async () => {
    const log = createProviderAccountActivityLog({ stateDir });
    await log.append({ ...removed("  spaced  "), reason: "   ", message: "" }, 1_000);
    const [entry] = (await log.read({})).entries;
    expect(entry?.labels.account).toBe("spaced");
    expect(entry).not.toHaveProperty("reason");
    expect(entry).not.toHaveProperty("message");
  });
});
