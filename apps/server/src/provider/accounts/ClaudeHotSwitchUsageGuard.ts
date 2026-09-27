// fork: provider accounts
import type { ServerProvider, ServerProviderUsageLimits } from "@t3tools/contracts";

/**
 * After a Claude hot switch, the instance keeps publishing usage that may not be the new
 * account's. The instance was not restarted, so two paths can publish the previous account's
 * numbers:
 *
 * - A post-switch probe whose usage request fails keeps the previously published windows
 *   (`resolveUsageLimitsAfterProbe`) while its identity already names the new account.
 * - Streams, subagents and parallel sessions keep the previous token until their next request;
 *   their `rate_limit_event`s carry no identity and patch the instance's limits.
 *
 * The new account's live usage therefore counts only once an identity-verified probe landed
 * (its email is the new account's and its windows came from that probe, not retained), and
 * never while it carries a window whose reset instant is the previous account's. Reset instants
 * are effectively account fingerprints: different accounts' windows reset at different times.
 * Until then the account keeps its stored (or last accepted) numbers.
 */
export interface UsageWindowFingerprint {
  readonly id: string;
  readonly resetsAt: number;
}

/** Probe times round differently than rate-limit events (13:59:59.904 vs 14:00:00). */
const SAME_RESET_TOLERANCE_MS = 60_000;

export function usageFingerprint(
  usage: ServerProviderUsageLimits | undefined,
): ReadonlyArray<UsageWindowFingerprint> {
  return (usage?.windows ?? []).flatMap((window) => {
    const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
    return Number.isFinite(resetsAt) ? [{ id: window.id, resetsAt }] : [];
  });
}

const matches = (list: ReadonlyArray<UsageWindowFingerprint>, window: UsageWindowFingerprint) =>
  list.some(
    (known) =>
      known.id === window.id &&
      Math.abs(known.resetsAt - window.resetsAt) < SAME_RESET_TOLERANCE_MS,
  );

/** A window resets when the previous account's does, and not when this account's does. */
export function carriesPreviousAccountWindows(
  usage: ServerProviderUsageLimits | undefined,
  previous: ReadonlyArray<UsageWindowFingerprint>,
  own: ReadonlyArray<UsageWindowFingerprint>,
) {
  return usageFingerprint(usage).some(
    (window) => matches(previous, window) && !matches(own, window),
  );
}

/**
 * A snapshot whose windows this very probe measured, for this identity. A probe that failed its
 * usage request keeps the older windows (and their older `checkedAt`); a runtime event stamps
 * its own time. Identity and usage come from the same CLI process, so they belong together.
 */
export function isVerifiedProbe(snapshot: ServerProvider, email: string | undefined) {
  const usage = snapshot.usageLimits;
  return (
    snapshot.auth.status === "authenticated" &&
    (email === undefined || snapshot.auth.email?.toLowerCase() === email.toLowerCase()) &&
    usage !== undefined &&
    usage.unavailable === undefined &&
    usage.windows.length > 0 &&
    usage.checkedAt === snapshot.checkedAt
  );
}

interface HotSwitchRecord {
  readonly toAccountId: string;
  readonly toEmail: string | undefined;
  /** Windows the accounts switched away from were last known to have. */
  readonly previous: ReadonlyArray<UsageWindowFingerprint>;
  /** The new account's own windows: stored, then from each verified probe. */
  own: ReadonlyArray<UsageWindowFingerprint>;
  verified: boolean;
  /** The last live usage accepted for the new account. */
  accepted: ServerProviderUsageLimits | undefined;
}

export type HotSwitchUsageVerdict =
  | { readonly live: true }
  | {
      readonly live: false;
      /** Verified usage to show instead of the live snapshot; else the stored numbers. */
      readonly usage: ServerProviderUsageLimits | undefined;
      readonly reason: "unverified" | "previousAccount";
    };

export function makeClaudeHotSwitchUsageGuard() {
  let record: HotSwitchRecord | undefined;
  /** Every published snapshot: a verified probe verifies the account and renews its windows. */
  const observe = (snapshot: ServerProvider | undefined) => {
    if (!record || !snapshot || !isVerifiedProbe(snapshot, record.toEmail)) return;
    record.verified = true;
    record.own = usageFingerprint(snapshot.usageLimits);
  };
  return {
    /**
     * Credentials moved to `toAccountId`. `previous` holds the outgoing account's verified live
     * and stored usage; windows of earlier switches stay while they have not reset, since their
     * streams may still be running.
     */
    switched(input: {
      readonly toAccountId: string;
      readonly toEmail: string | undefined;
      readonly toStored: ServerProviderUsageLimits | undefined;
      readonly previous: ReadonlyArray<ServerProviderUsageLimits | undefined>;
      readonly now: number;
    }) {
      const carried = (record?.previous ?? []).filter((window) => window.resetsAt > input.now);
      record = {
        toAccountId: input.toAccountId,
        toEmail: input.toEmail,
        previous: [...carried, ...input.previous.flatMap(usageFingerprint)],
        own: usageFingerprint(input.toStored),
        verified: false,
        accepted: undefined,
      };
    },
    observe,
    /** Whether the active account may use the live snapshot's usage. */
    resolve(activeAccountId: string, snapshot: ServerProvider | undefined): HotSwitchUsageVerdict {
      if (!record || record.toAccountId !== activeAccountId) return { live: true };
      observe(snapshot);
      // Another identity's snapshot is never this account's; ownership checks drop it anyway.
      const foreign =
        record.toEmail !== undefined &&
        snapshot?.auth.email !== undefined &&
        snapshot.auth.email.toLowerCase() !== record.toEmail.toLowerCase();
      if (!record.verified || !snapshot?.usageLimits || foreign)
        return { live: false, usage: record.accepted, reason: "unverified" };
      if (carriesPreviousAccountWindows(snapshot.usageLimits, record.previous, record.own))
        return { live: false, usage: record.accepted, reason: "previousAccount" };
      record.accepted = snapshot.usageLimits;
      return { live: true };
    },
  };
}
