// fork: pure, environment-owned account rotation policy.
import type {
  ProviderAccount,
  ProviderAccountId,
  ServerProviderUsageLimits,
} from "@t3tools/contracts";

const minute = 60_000;
const hour = 60 * minute;
const targetMarginPercent = 10;
const usageFreshMs = 5 * minute;
const expiringHorizonMs = 24 * hour;
const proactiveDwellMs = 30 * minute;
const maxProbe = 2;

export interface AutoSwitchAccountView {
  readonly id: ProviderAccountId;
  readonly label: string;
  readonly status: ProviderAccount["status"];
  readonly loginInProgress: boolean;
  readonly usage?: ServerProviderUsageLimits | undefined;
}

export interface AutoSwitchInput {
  readonly now: number;
  readonly config: { readonly enabled: boolean; readonly thresholdPercent: number };
  readonly active: AutoSwitchAccountView;
  readonly candidates: ReadonlyArray<AutoSwitchAccountView>;
  readonly probed: ReadonlySet<ProviderAccountId>;
  readonly probeBlocked?: ReadonlySet<ProviderAccountId>;
  readonly probeWakeAt?: ReadonlyMap<ProviderAccountId, number>;
  readonly recentAutoSwitchAts: ReadonlyArray<number>;
  readonly lastSwitchAt?: number;
  readonly manual?: {
    readonly at: number;
    readonly holdUntil: number;
    readonly activeWasBelowThreshold: boolean;
  };
}

export type AutoSwitchDecision =
  | {
      readonly kind: "switch";
      readonly targetAccountId: ProviderAccountId;
      readonly trigger: "session" | "weekly" | "signedOut" | "expiring";
      readonly reason: string;
    }
  | {
      readonly kind: "probe";
      readonly accountIds: ReadonlyArray<ProviderAccountId>;
      readonly reason: string;
    }
  | {
      readonly kind: "stay";
      readonly code:
        | "healthy"
        | "waitingForReset"
        | "allExhausted"
        | "noCandidates"
        | "manualHold"
        | "dwell"
        | "circuitBreaker";
      readonly reason: string;
      readonly wakeAt?: number;
    };

function summarize(
  account: AutoSwitchAccountView,
  now: number,
  threshold: number,
  probed: ReadonlySet<ProviderAccountId>,
) {
  let rolledOver = false;
  const windows = (account.usage?.windows ?? [])
    .filter((window) => window.kind !== "other")
    .map((window) => {
      const reset = window.resetsAt === undefined ? undefined : Date.parse(window.resetsAt);
      const expired = reset !== undefined && reset <= now;
      rolledOver ||= expired;
      return {
        kind: window.kind,
        left: expired ? 100 : 100 - window.usedPercent,
        reset: expired ? undefined : reset,
      };
    });
  const sessions = windows.filter((window) => window.kind === "session");
  const longs = windows.filter((window) => window.kind === "weekly" || window.kind === "monthly");
  const sessionLeft = Math.min(100, ...sessions.map((window) => window.left));
  const longLeft = Math.min(100, ...longs.map((window) => window.left));
  const sessionResetAt = Math.min(
    ...sessions
      .filter((window) => window.left === sessionLeft)
      .map((window) => window.reset ?? Infinity),
  );
  const blockers = windows.filter((window) => window.left <= threshold);
  return {
    account,
    known:
      (account.usage?.windows.length ?? 0) > 0 &&
      account.usage?.unavailable?.reason !== "unsupported",
    fresh:
      account.usage?.unavailable?.reason !== "probeFailed" &&
      (probed.has(account.id) ||
        (!rolledOver &&
          account.usage !== undefined &&
          now - Date.parse(account.usage.checkedAt) <= usageFreshMs)),
    hasSession: sessions.length > 0,
    sessionLeft,
    longLeft,
    sessionResetAt,
    deadline: Math.min(
      ...longs
        .filter((window) => window.left > threshold)
        .map((window) => window.reset ?? Infinity),
    ),
    usableAgainAt:
      blockers.length === 0
        ? Infinity
        : Math.max(...blockers.map((window) => window.reset ?? Infinity)),
  };
}

export function activeBelowThreshold(
  account: AutoSwitchAccountView,
  now: number,
  threshold: number,
): boolean {
  const summary = summarize(account, now, threshold, new Set());
  return summary.known && (summary.sessionLeft <= threshold || summary.longLeft <= threshold);
}

/** All time comes from the caller; a successful probe may confirm a rolled-over window. */
export function chooseNextAccount(input: AutoSwitchInput): AutoSwitchDecision {
  const { now, active, config, probed } = input;
  const threshold = config.thresholdPercent;
  type Summary = ReturnType<typeof summarize>;
  const current = summarize(active, now, threshold, probed);
  const candidates = input.candidates
    .filter(
      (account) =>
        account.id !== active.id && account.status === "ready" && !account.loginInProgress,
    )
    .map((account) => summarize(account, now, threshold, probed));
  const stay = (
    code: Extract<AutoSwitchDecision, { kind: "stay" }>["code"],
    reason: string,
    wakeAt?: number,
  ): AutoSwitchDecision => ({
    kind: "stay",
    code,
    reason,
    ...(wakeAt !== undefined && Number.isFinite(wakeAt) ? { wakeAt } : {}),
  });
  const duration = (at: number) =>
    !Number.isFinite(at)
      ? "an unknown time"
      : at - now >= 24 * hour
        ? `${Math.ceil((at - now) / (24 * hour))}d`
        : at - now >= hour
          ? `${Math.ceil((at - now) / hour)}h`
          : `${Math.max(0, Math.ceil((at - now) / minute))}m`;
  const probe = (accounts: ReadonlyArray<Summary>): AutoSwitchDecision => ({
    kind: "probe",
    accountIds: accounts.map(({ account }) => account.id),
    reason: `Checking ${accounts.map(({ account }) => account.label).join(" and ")} before switching from ${active.label}; usage must be confirmed within 5 minutes.`,
  });
  const compare = (a: Summary, b: Summary) => {
    const bucketA = Math.floor(a.deadline / hour);
    const bucketB = Math.floor(b.deadline / hour);
    return (
      (bucketA === bucketB ? 0 : bucketA < bucketB ? -1 : 1) ||
      b.longLeft - a.longLeft ||
      b.sessionLeft - a.sessionLeft ||
      (a.account.id < b.account.id ? -1 : a.account.id > b.account.id ? 1 : 0)
    );
  };
  const hasHeadroom = (candidate: Summary, strict: boolean) =>
    candidate.sessionLeft >= threshold + (strict ? targetMarginPercent : 1) &&
    candidate.longLeft >= threshold + (strict ? targetMarginPercent : 1) &&
    (strict ||
      hard ||
      !current.hasSession ||
      candidate.sessionLeft >= current.sessionLeft + targetMarginPercent);
  const rank = (strict: boolean) =>
    candidates
      .filter(
        (candidate) =>
          !input.probeBlocked?.has(candidate.account.id) &&
          candidate.known &&
          hasHeadroom(candidate, strict),
      )
      .sort(compare);
  const pickOrProbe = (
    ranking: ReadonlyArray<Summary>,
  ): Summary | AutoSwitchDecision | undefined => {
    const freshIndex = ranking.findIndex((candidate) => candidate.fresh);
    const prefix = freshIndex === -1 ? ranking : ranking.slice(0, freshIndex);
    const stale = prefix
      .filter((candidate) => !probed.has(candidate.account.id))
      .slice(0, maxProbe);
    if (stale.length > 0) return probe(stale);
    return freshIndex === -1 ? undefined : ranking[freshIndex];
  };
  if (!config.enabled) return stay("healthy", `Auto-switch is off for ${active.label}.`);
  const signedOut = active.status === "signedOut" || active.status === "error";
  if (!signedOut && !current.known)
    return stay(
      "healthy",
      `Waiting for usage from ${active.label} before switching at ${threshold}% left.`,
    );
  const hard = signedOut || current.sessionLeft <= 0 || current.longLeft <= 0;
  let need: "signedOut" | "session" | "weekly" | undefined = signedOut
    ? "signedOut"
    : current.sessionLeft <= threshold
      ? "session"
      : current.longLeft <= threshold
        ? "weekly"
        : undefined;
  if (input.manual?.activeWasBelowThreshold && now < input.manual.holdUntil && !hard)
    need = undefined;
  const recent = input.recentAutoSwitchAts.filter((at) => at > now - hour && at <= now);
  if (recent.length >= 4 && !hard)
    return stay(
      "circuitBreaker",
      `Keeping ${active.label}: ${recent.length} automatic switches in the last hour; pausing rotation.`,
      Math.min(...recent) + hour,
    );
  const switchTo = (
    target: Summary,
    trigger: "session" | "weekly" | "signedOut" | "expiring",
  ): AutoSwitchDecision => ({
    kind: "switch",
    targetAccountId: target.account.id,
    trigger,
    reason:
      trigger === "expiring"
        ? `${target.account.label}'s long-term limit resets in ${duration(target.deadline)} with ${target.longLeft}% unused; using it first. ${active.label}'s resets in ${duration(current.deadline)}.`
        : `${active.label} ${trigger === "signedOut" ? "is signed out or unavailable" : `has ${trigger === "session" ? current.sessionLeft : current.longLeft}% of its ${trigger} limit left`}; switching to ${target.account.label} (${target.sessionLeft}% session left, ${target.longLeft}% long-term left; resets in ${duration(target.deadline)}).`,
  });
  if (need !== undefined) {
    if (
      need === "session" &&
      !hard &&
      current.sessionLeft > 0 &&
      current.sessionResetAt - now <= 15 * minute &&
      current.longLeft > threshold
    )
      return stay(
        "waitingForReset",
        `${active.label} has ${current.sessionLeft}% session left and resets in ${duration(current.sessionResetAt)}; waiting instead of switching.`,
        current.sessionResetAt,
      );
    for (const strict of [true, false]) {
      const selection = pickOrProbe(rank(strict));
      if (selection !== undefined)
        return "kind" in selection ? selection : switchTo(selection, need);
    }
    const unknown = candidates
      .filter(
        (candidate) =>
          !candidate.known &&
          !probed.has(candidate.account.id) &&
          !input.probeBlocked?.has(candidate.account.id),
      )
      .sort((a, b) => (a.account.id < b.account.id ? -1 : a.account.id > b.account.id ? 1 : 0))
      .slice(0, maxProbe);
    if (unknown.length > 0) return probe(unknown);
    if (candidates.length === 0)
      return stay(
        "noCandidates",
        `No other ready accounts are available for ${active.label}; ${input.candidates.length} saved candidates checked.`,
      );
    const first = [current, ...candidates]
      .filter((candidate) => Number.isFinite(candidate.usableAgainAt))
      .sort((a, b) => a.usableAgainAt - b.usableAgainAt || compare(a, b))[0];
    const probeWakeAt = Math.min(
      ...candidates
        .filter(
          (candidate) =>
            input.probeBlocked?.has(candidate.account.id) &&
            (!candidate.known || hasHeadroom(candidate, true) || hasHeadroom(candidate, false)),
        )
        .map((candidate) => input.probeWakeAt?.get(candidate.account.id) ?? Infinity)
        .filter((at) => at > now),
    );
    return stay(
      "allExhausted",
      `No account has enough confirmed quota above ${threshold}% to replace ${active.label}.${first === undefined ? " Waiting for usable account usage." : ` ${first.account.label} frees up first (blocking limits reset in ${duration(first.usableAgainAt)}).`}`,
      Math.min(first?.usableAgainAt ?? Infinity, probeWakeAt),
    );
  }
  if (input.manual !== undefined && now < input.manual.holdUntil)
    return stay(
      "manualHold",
      `Keeping manually selected ${active.label} for ${duration(input.manual.holdUntil)}.`,
      input.manual.holdUntil,
    );
  if (input.lastSwitchAt !== undefined && now - input.lastSwitchAt < proactiveDwellMs)
    return stay(
      "dwell",
      `Keeping ${active.label} for at least 30 minutes after the last switch.`,
      input.lastSwitchAt + proactiveDwellMs,
    );
  const expiring = rank(true).filter(
    (candidate) => candidate.deadline + hour < current.deadline && candidate.longLeft >= 20,
  );
  const selection = pickOrProbe(
    expiring.filter((candidate) => candidate.deadline <= now + expiringHorizonMs),
  );
  if (selection !== undefined)
    return "kind" in selection ? selection : switchTo(selection, "expiring");
  return stay(
    "healthy",
    `${active.label} has ${current.sessionLeft}% session and ${current.longLeft}% long-term quota left; no switch needed.`,
    Math.min(
      ...expiring
        .map((candidate) => candidate.deadline - expiringHorizonMs)
        .filter((at) => at > now),
    ),
  );
}
