// fork: provider accounts — the one identity rule every saved-account comparison uses.

/**
 * Who a saved account signed in as. `workspaceId` is Claude's organizationUuid or Codex's
 * chatgpt_account_id, so a personal plan and a team seat under one email stay distinct.
 */
export type AccountIdentity = {
  readonly email?: string;
  readonly accountUuid?: string;
  readonly workspaceId?: string;
};

export const hasIdentity = (identity: AccountIdentity) =>
  Boolean(identity.email || identity.accountUuid);

/**
 * Account uuid wins when both sides know it, otherwise emails compare case-insensitively.
 * Known but different uuids or workspaces are always different accounts.
 */
export function sameAccountIdentity(left: AccountIdentity, right: AccountIdentity) {
  if (left.accountUuid && right.accountUuid && left.accountUuid !== right.accountUuid) return false;
  if (left.workspaceId && right.workspaceId && left.workspaceId !== right.workspaceId) return false;
  if (left.accountUuid && right.accountUuid) return true;
  return Boolean(left.email && right.email?.toLowerCase() === left.email.toLowerCase());
}

interface KeeperCandidate {
  readonly id: string;
  readonly kind: "default" | "managed" | "external";
  readonly status: "ready" | "pending" | "signedOut" | "error";
  readonly message?: string | undefined;
  readonly createdAt: string;
}

/** Which saved account keeps an identity: Default, then ready accounts, then the oldest. */
export const keeperRank = (entry: Pick<KeeperCandidate, "kind" | "status" | "message">) =>
  entry.status === "error" && entry.message
    ? 2
    : entry.kind === "default"
      ? 0
      : entry.status === "ready"
        ? 1
        : 2;

/**
 * The saved account that owns `identity`, by the keeper rule. External, pending and
 * conflicting (errored with a message) entries never keep an identity.
 */
export function identityKeeper<Entry extends KeeperCandidate>(
  entries: ReadonlyArray<Entry>,
  identity: AccountIdentity,
  identityOf: (entry: Entry) => AccountIdentity,
  excludeId?: string,
): Entry | undefined {
  if (!hasIdentity(identity)) return undefined;
  return entries
    .filter(
      (entry) =>
        entry.id !== excludeId &&
        entry.kind !== "external" &&
        entry.status !== "pending" &&
        !(entry.status === "error" && entry.message) &&
        hasIdentity(identityOf(entry)) &&
        sameAccountIdentity(identityOf(entry), identity),
    )
    .toSorted(
      (left, right) =>
        keeperRank(left) - keeperRank(right) || left.createdAt.localeCompare(right.createdAt),
    )[0];
}
