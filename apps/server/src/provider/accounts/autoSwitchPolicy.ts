// fork: pure, environment-owned account rotation policy.
import type {
  ProviderAccount,
  ProviderAccountId,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { accountGatingWindows } from "@t3tools/shared/fork/accountUsageWindows";

const minute = 60_000;
const hour = 60 * minute;
const targetMarginPercent = 10;
/**
 * A target needs this many points of weekly quota above the weekly threshold, so a switch never
 * lands on an account that is due to switch away again right away.
 */
const weeklyTargetMarginPercent = 3;
const usageFreshMs = 5 * minute;
const proactiveDwellMs = 5 * minute;
const maxProbe = 2;
/** A reset settles this long before the new window shows up in usage. */
const resetGraceMs = minute;

export interface AutoSwitchAccountView {
  readonly id: ProviderAccountId;
  readonly label: string;
  readonly status: ProviderAccount["status"];
  readonly loginInProgress: boolean;
  /** A second saved copy of another account's login shares its quota, so it is never a target. */
  readonly duplicateOf?: ProviderAccountId | undefined;
  /** Excluded by the user: never a target, though auto-switch still moves away from it. */
  readonly autoSwitchExcluded?: boolean | undefined;
  readonly usage?: ServerProviderUsageLimits | undefined;
}

export interface AutoSwitchThresholds {
  /** Percent left on a 5-hour window at which the account counts as low. */
  readonly thresholdPercent: number;
  /** Percent left on a weekly (or monthly) window; low so weekly quota gets used up. */
  readonly weeklyThresholdPercent: number;
}

const thresholdFor = (kind: ServerProviderUsageWindow["kind"], thresholds: AutoSwitchThresholds) =>
  kind === "session" ? thresholds.thresholdPercent : thresholds.weeklyThresholdPercent;

/** Whether any gating window of the active account is at its switch threshold. */
export function atAutoSwitchThreshold(
  windows: ReadonlyArray<Pick<ServerProviderUsageWindow, "id" | "kind" | "usedPercent">>,
  thresholds: AutoSwitchThresholds,
) {
  return accountGatingWindows(windows).some(
    (window) =>
      window.kind !== "other" && 100 - window.usedPercent <= thresholdFor(window.kind, thresholds),
  );
}

export interface AutoSwitchInput {
  readonly now: number;
  readonly config: AutoSwitchThresholds & { readonly enabled: boolean };
  readonly active: AutoSwitchAccountView;
  readonly candidates: ReadonlyArray<AutoSwitchAccountView>;
  readonly probed: ReadonlySet<ProviderAccountId>;
  readonly probeBlocked?: ReadonlySet<ProviderAccountId>;
  readonly probeWakeAt?: ReadonlyMap<ProviderAccountId, number>;
  readonly recentAutoSwitchAts: ReadonlyArray<number>;
  readonly lastSwitchAt?: number;
  /** A manual switch delays only proactive rebalancing, like an automatic one. */
  readonly lastManualSwitchAt?: number;
}

export type AutoSwitchDecision =
  | {
      readonly kind: "switch";
      readonly targetAccountId: ProviderAccountId;
      readonly trigger: "session" | "weekly" | "signedOut" | "expiring";
      readonly reason: string;
      /** One short line for the activity log, e.g. `Weekly limit at 2% · b resets in 4d 13h`. */
      readonly summary: string;
    }
  | {
      readonly kind: "probe";
      readonly accountIds: ReadonlyArray<ProviderAccountId>;
      readonly reason: string;
    }
  | {
      readonly kind: "stay";
      readonly code: "healthy" | "allExhausted" | "noCandidates" | "dwell" | "circuitBreaker";
      readonly reason: string;
      readonly wakeAt?: number;
    };

function summarize(
  account: AutoSwitchAccountView,
  now: number,
  thresholds: AutoSwitchThresholds,
  probed: ReadonlySet<ProviderAccountId>,
) {
  let rolledOver = false;
  // Claude hard-blocks a model only for that model's requests, so its model-scoped weeklies
  // (Fable) never gate the account while the all-model weekly is reported.
  const windows = accountGatingWindows(account.usage?.windows ?? [])
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
  const blockers = windows.filter((window) => window.left <= thresholdFor(window.kind, thresholds));
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
    longResetAt: Math.min(...longs.map((window) => window.reset ?? Infinity)),
    deadline: Math.min(
      ...longs
        .filter((window) => window.left > thresholds.weeklyThresholdPercent)
        .map((window) => window.reset ?? Infinity),
    ),
    usableAgainAt:
      blockers.length === 0
        ? Infinity
        : Math.max(...blockers.map((window) => window.reset ?? Infinity)),
  };
}

type Summary = ReturnType<typeof summarize>;

/** Could take over from the active account, ignoring the user's exclusion. */
const isEligible = (account: AutoSwitchAccountView, activeId: ProviderAccountId) =>
  account.id !== activeId &&
  account.status === "ready" &&
  !account.loginInProgress &&
  account.duplicateOf === undefined;

/** The one candidate filter behind both auto-switch and `nextAccountId` ("Best option"). */
const isSwitchCandidate = (account: AutoSwitchAccountView, activeId: ProviderAccountId) =>
  isEligible(account, activeId) && account.autoSwitchExcluded !== true;

/** `4d 13h`, `5h 20m`, `12m`: how the activity log names a time left. */
function remainingText(ms: number) {
  if (!Number.isFinite(ms)) return "an unknown time";
  const minutes = Math.max(1, Math.ceil(ms / minute));
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  const rest = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
  return `${rest}m`;
}

/** The one weekly rule for every target, reactive and proactive. */
const hasWeeklyHeadroom = (candidate: Summary, thresholds: AutoSwitchThresholds) =>
  candidate.longLeft >= thresholds.weeklyThresholdPercent + weeklyTargetMarginPercent;

/** Both limits clear their thresholds by the target margin, so a switch cannot flap back. */
const hasStrictHeadroom = (candidate: Summary, thresholds: AutoSwitchThresholds) =>
  candidate.sessionLeft >= thresholds.thresholdPercent + targetMarginPercent &&
  hasWeeklyHeadroom(candidate, thresholds);

/** Its weekly quota resets more than an hour before the active account's, so use it first. */
const resetsSoonerThan = (candidate: Summary, current: Summary) =>
  candidate.deadline + hour < current.deadline;

/** Whether the active account is at a threshold (or unusable), so a reactive switch is due. */
const needFor = (
  current: Summary,
  thresholds: AutoSwitchThresholds,
): "signedOut" | "session" | "weekly" | undefined =>
  current.account.status === "signedOut" || current.account.status === "error"
    ? "signedOut"
    : current.sessionLeft <= thresholds.thresholdPercent
      ? "session"
      : current.longLeft <= thresholds.weeklyThresholdPercent
        ? "weekly"
        : undefined;

/** Earliest weekly deadline (hour buckets) first, then more weekly, then more 5-hour left. */
const compareCandidates = (a: Summary, b: Summary) => {
  const bucketA = Math.floor(a.deadline / hour);
  const bucketB = Math.floor(b.deadline / hour);
  return (
    (bucketA === bucketB ? 0 : bucketA < bucketB ? -1 : 1) ||
    b.longLeft - a.longLeft ||
    b.sessionLeft - a.sessionLeft ||
    (a.account.id < b.account.id ? -1 : a.account.id > b.account.id ? 1 : 0)
  );
};

export interface NextAutoSwitchInput {
  readonly now: number;
  readonly config: AutoSwitchThresholds;
  readonly activeAccountId: ProviderAccountId | undefined;
  readonly accounts: ReadonlyArray<AutoSwitchAccountView>;
}

/**
 * The account auto-switch would move to next, by the same eligibility and ranking a threshold
 * or proactive switch uses. Ignores freshness, dwell, and the breaker: it answers "who is next",
 * so the account switcher's "Best option" can never disagree with auto-switch. `due` says a
 * switch to it is due now (the active account is low, or it resets sooner) rather than once the
 * active account runs low.
 */
export function nextAutoSwitchTarget(
  input: NextAutoSwitchInput,
): { readonly accountId: ProviderAccountId; readonly due: boolean } | undefined {
  const { activeAccountId, config, now } = input;
  if (activeAccountId === undefined) return undefined;
  const ranking = input.accounts
    .filter((account) => isSwitchCandidate(account, activeAccountId))
    .map((account) => summarize(account, now, config, new Set()))
    .filter((candidate) => candidate.known && hasStrictHeadroom(candidate, config))
    .sort(compareCandidates);
  const active = input.accounts.find((account) => account.id === activeAccountId);
  const current = active === undefined ? undefined : summarize(active, now, config, new Set());
  if (current !== undefined && (needFor(current, config) !== undefined || !current.known)) {
    const first = ranking[0];
    return first && { accountId: first.account.id, due: needFor(current, config) !== undefined };
  }
  const sooner =
    current === undefined
      ? undefined
      : ranking.find((candidate) => resetsSoonerThan(candidate, current));
  const next = sooner ?? ranking[0];
  return next && { accountId: next.account.id, due: sooner !== undefined };
}

export function nextAutoSwitchAccountId(input: NextAutoSwitchInput) {
  return nextAutoSwitchTarget(input)?.accountId;
}

/** All time comes from the caller; a successful probe may confirm a rolled-over window. */
export function chooseNextAccount(input: AutoSwitchInput): AutoSwitchDecision {
  const { now, active, config, probed } = input;
  const threshold = config.thresholdPercent;
  const weeklyThreshold = config.weeklyThresholdPercent;
  const current = summarize(active, now, config, probed);
  const candidates = input.candidates
    .filter((account) => isSwitchCandidate(account, active.id))
    .map((account) => summarize(account, now, config, probed));
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
  const compare = compareCandidates;
  const hasHeadroom = (candidate: Summary, strict: boolean) =>
    strict
      ? hasStrictHeadroom(candidate, config)
      : candidate.sessionLeft >= threshold + 1 &&
        hasWeeklyHeadroom(candidate, config) &&
        // Relaxed session headroom only matters when the session is what ran low.
        (hard ||
          need !== "session" ||
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
      `Waiting for usage from ${active.label} before switching at ${threshold}% 5-hour or ${weeklyThreshold}% weekly left.`,
    );
  const hard = signedOut || current.sessionLeft <= 0 || current.longLeft <= 0;
  const need = needFor(current, config);
  const targetResets = (target: Summary) =>
    Number.isFinite(target.deadline)
      ? `${target.account.label} resets in ${remainingText(target.deadline - now)}`
      : `${target.account.label} has ${target.longLeft}% weekly left`;
  const summaries = {
    session: (target: Summary) =>
      `5-hour limit at ${current.sessionLeft}% · ${target.account.label} has ${target.sessionLeft}% left`,
    weekly: (target: Summary) => `Weekly limit at ${current.longLeft}% · ${targetResets(target)}`,
    signedOut: (target: Summary) =>
      `${active.label} is signed out or unavailable · ${targetResets(target)}`,
    expiring: (target: Summary) =>
      `${targetResets(target)}, sooner than ${active.label}, so its quota gets used first`,
  };
  const switchTo = (
    target: Summary,
    trigger: "session" | "weekly" | "signedOut" | "expiring",
  ): AutoSwitchDecision => ({
    kind: "switch",
    targetAccountId: target.account.id,
    trigger,
    summary: summaries[trigger](target),
    reason:
      trigger === "expiring"
        ? `${target.account.label}'s weekly limit resets in ${duration(target.deadline)}, sooner than ${active.label}'s (${Number.isFinite(current.deadline) ? duration(current.deadline) : "no known reset"}). Using ${target.account.label} first so its quota doesn't expire unused.`
        : `${active.label} ${trigger === "signedOut" ? "is signed out or unavailable" : trigger === "session" ? `has ${current.sessionLeft}% of its 5-hour limit left` : `has ${current.longLeft}% of its weekly limit left`}; switching to ${target.account.label} (${trigger === "weekly" ? "" : `5-hour ${target.sessionLeft}% left; `}weekly resets in ${duration(target.deadline)}, ${target.longLeft}% left).`,
  });
  // At or below the threshold, any healthy candidate wins; the target margin prevents flapping.
  if (need !== undefined) {
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
    if (
      candidates.length === 0 &&
      input.candidates.some(
        (account) => account.autoSwitchExcluded === true && isEligible(account, active.id),
      )
    )
      return stay("noCandidates", "No other account is available for auto-switch.");
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
      `No account has enough confirmed quota above the ${threshold}% 5-hour and ${weeklyThreshold}% weekly thresholds to replace ${active.label}.${first === undefined ? " Waiting for usable account usage." : ` ${first.account.label} frees up first (blocking limits reset in ${duration(first.usableAgainAt)}).`}`,
      Math.min(first?.usableAgainAt ?? Infinity, probeWakeAt),
    );
  }
  // Proactive rebalancing alone is rate-limited, so early switches cannot ping-pong.
  const recent = input.recentAutoSwitchAts.filter((at) => at > now - hour && at <= now);
  if (recent.length >= 4)
    return stay(
      "circuitBreaker",
      `Keeping ${active.label}: ${recent.length} automatic switches in the last hour; pausing early rotation.`,
      Math.min(...recent) + hour,
    );
  // Use up quota that resets sooner first, down to the weekly threshold. A fresh reset moves an
  // account's deadline a week out, so it stops being preferred on its own; deadlines only ever
  // move earlier along a chain of proactive switches, so they cannot ping-pong.
  const resetsSooner = (candidate: Summary) => resetsSoonerThan(candidate, current);
  const proactive = rank(true).filter(resetsSooner);
  const lastSwitchAt = Math.max(
    input.lastSwitchAt ?? -Infinity,
    input.lastManualSwitchAt ?? -Infinity,
  );
  if (now - lastSwitchAt < proactiveDwellMs) {
    const dwellEnd = lastSwitchAt + proactiveDwellMs;
    const pending = proactive[0];
    return stay(
      "dwell",
      pending === undefined
        ? `Keeping ${active.label} for at least ${proactiveDwellMs / minute} minutes after the last switch.`
        : `Switching from ${active.label} to ${pending.account.label} in ${remainingText(dwellEnd - now)}: its weekly limit resets sooner (${remainingText(pending.deadline - now)}).`,
      dwellEnd,
    );
  }
  const selection = pickOrProbe(proactive);
  if (selection !== undefined)
    return "kind" in selection ? selection : switchTo(selection, "expiring");
  const sooner = candidates.filter(
    (candidate) =>
      candidate.known && !input.probeBlocked?.has(candidate.account.id) && resetsSooner(candidate),
  );
  // A sooner-resetting account whose session is low becomes a target once its session resets.
  const sessionLow = sooner
    .filter(
      (candidate) =>
        hasWeeklyHeadroom(candidate, config) &&
        candidate.sessionLeft < threshold + targetMarginPercent,
    )
    .sort((a, b) => a.sessionResetAt - b.sessionResetAt || compare(a, b));
  const sessionWakeAt = Math.min(
    ...sessionLow.map((candidate) => candidate.sessionResetAt).filter((at) => at > now),
  );
  const weeklyLow = sooner
    .filter((candidate) => !hasWeeklyHeadroom(candidate, config))
    .sort((a, b) => a.deadline - b.deadline || compare(a, b));
  // A weekly reset moves a deadline, which can make proactive rebalancing worthwhile.
  const weeklyWakeAt = Math.min(
    ...[
      current,
      ...candidates.filter(
        (candidate) => candidate.known && !input.probeBlocked?.has(candidate.account.id),
      ),
    ]
      .map((summary) => summary.longResetAt + resetGraceMs)
      .filter((at) => at > now),
  );
  const waiting = sessionLow[0];
  const skipped = weeklyLow[0];
  return stay(
    "healthy",
    waiting !== undefined
      ? `Keeping ${active.label}. ${waiting.account.label} resets sooner but its 5-hour limit is low${waiting.sessionResetAt > now && Number.isFinite(waiting.sessionResetAt) ? `; switching when it resets in ${remainingText(waiting.sessionResetAt - now)}` : ""}.`
      : skipped !== undefined
        ? `Keeping ${active.label}. ${skipped.account.label} resets sooner but only has ${skipped.longLeft}% weekly left.`
        : `${active.label} has ${current.sessionLeft}% 5-hour and ${current.longLeft}% weekly quota left; no switch needed.`,
    Math.min(sessionWakeAt, weeklyWakeAt),
  );
}
