// fork: provider accounts
import { describe, expect, it } from "vite-plus/test";
import { identityKeeper, sameAccountIdentity } from "./accountIdentity.ts";

describe("sameAccountIdentity", () => {
  // S9: a personal plan and a team seat under one email are different accounts.
  it("tells workspaces under one email apart and otherwise matches by uuid or email", () => {
    const personal = { email: "me@example.test", workspaceId: "personal" };
    expect(sameAccountIdentity(personal, { email: "ME@example.test", workspaceId: "team" })).toBe(
      false,
    );
    expect(
      sameAccountIdentity(personal, { email: "ME@example.test", workspaceId: "personal" }),
    ).toBe(true);
    // Only one side knows its workspace: the email decides.
    expect(sameAccountIdentity(personal, { email: "me@example.test" })).toBe(true);
    // A known uuid wins over the email, but never over a different organization.
    expect(
      sameAccountIdentity({ accountUuid: "u1", email: "a@x.test" }, { accountUuid: "u1" }),
    ).toBe(true);
    expect(
      sameAccountIdentity(
        { accountUuid: "u1", email: "a@x.test" },
        { accountUuid: "u2", email: "a@x.test" },
      ),
    ).toBe(false);
    expect(
      sameAccountIdentity(
        { accountUuid: "u1", workspaceId: "org-a" },
        { accountUuid: "u1", workspaceId: "org-b" },
      ),
    ).toBe(false);
    expect(sameAccountIdentity({}, {})).toBe(false);
  });
});

describe("identityKeeper", () => {
  const entry = (
    id: string,
    email: string,
    overrides: Partial<{
      kind: "default" | "managed" | "external";
      status: "ready" | "pending" | "signedOut" | "error";
      message: string;
      createdAt: string;
      workspaceId: string;
    }> = {},
  ) => ({
    id,
    kind: overrides.kind ?? ("managed" as const),
    status: overrides.status ?? ("ready" as const),
    ...(overrides.message ? { message: overrides.message } : {}),
    createdAt: overrides.createdAt ?? `2026-09-0${id.length}T00:00:00.000Z`,
    identity: { email, ...(overrides.workspaceId ? { workspaceId: overrides.workspaceId } : {}) },
  });
  const keeper = (entries: ReturnType<typeof entry>[], email: string, excludeId?: string) =>
    identityKeeper(entries, { email }, (item) => item.identity, excludeId)?.id;

  // S12: the switch-time lookup keeps the same rule as reconcile, not the first match.
  it("picks Default, then the oldest ready account, never a conflicting or pending one", () => {
    const conflict = entry("x", "c@x.test", {
      status: "error",
      message: "Signed in as someone else.",
    });
    const pending = entry("pp", "c@x.test", { status: "pending" });
    const newer = entry("newer", "c@x.test", { createdAt: "2026-09-09T00:00:00.000Z" });
    const older = entry("older", "c@x.test", { createdAt: "2026-09-01T00:00:00.000Z" });
    const external = entry("ext", "c@x.test", { kind: "external" });
    expect(keeper([conflict, pending, external, newer, older], "c@x.test")).toBe("older");
    expect(keeper([older, entry("d", "c@x.test", { kind: "default" })], "c@x.test")).toBe("d");
    expect(keeper([older, newer], "c@x.test", "older")).toBe("newer");
    expect(keeper([conflict, pending], "c@x.test")).toBeUndefined();
    expect(keeper([entry("team", "c@x.test", { workspaceId: "team" })], "c@x.test")).toBe("team");
    expect(
      identityKeeper(
        [entry("team", "c@x.test", { workspaceId: "team" })],
        { email: "c@x.test", workspaceId: "personal" },
        (item) => item.identity,
      ),
    ).toBeUndefined();
  });
});
