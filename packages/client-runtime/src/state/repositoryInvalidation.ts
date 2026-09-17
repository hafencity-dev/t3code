// fork: the single invalidation generation shared by status, mutable queries,
// paged views and both clients. Registry state is deliberately not global state.
import type {
  EnvironmentId,
  ExecutionEnvironmentCapabilities,
  VcsInvalidationDomain,
  VcsStatusStreamEvent,
  WorkingCopyRevision,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";
import { invalidateCachedVcsRefs } from "./vcsRefInvalidation.ts";

export interface WorkingCopyTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}
export const ALL_REPOSITORY_DOMAINS = ["worktree", "refs", "stashes"] as const;
const keyOf = (target: WorkingCopyTarget) => JSON.stringify([target.environmentId, target.cwd]);
const revisions = Atom.family((key: string) =>
  Atom.make(0).pipe(
    Atom.keepAlive,
    Atom.withLabel(`environment-data:working-copy:revision:${key}`),
  ),
);
export interface RepositoryObservation {
  readonly session: object;
  readonly token: WorkingCopyRevision | undefined;
  readonly local: string;
}
const observations = Atom.family((key: string) =>
  Atom.make<RepositoryObservation | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel(`environment-data:working-copy:observation:${key}`),
  ),
);
/** The last server frame folded in for a target; identity changes per frame. */
export const repositoryObservationAtom = (target: WorkingCopyTarget) => observations(keyOf(target));
/**
 * Reads the server capabilities a client knows for an environment. Servers
 * advertising `workingCopyRevision` push after every mutation, so clients skip
 * their own post-mutation invalidation; older servers keep the fallback.
 */
export type RepositoryCapabilityLookup = (
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
) => Pick<ExecutionEnvironmentCapabilities, "workingCopyRevision"> | null | undefined;
export function serverPushesRevisions(
  lookup: RepositoryCapabilityLookup | undefined,
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
): boolean {
  return lookup?.(registry, environmentId)?.workingCopyRevision === true;
}
/**
 * The refs cache is per environment, so one shared change announced by K
 * subscribed worktrees (or K snapshots after one reconnect) clears it once.
 */
const refsClearedFor = Atom.family((environmentId: EnvironmentId) =>
  Atom.make<unknown>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel(`environment-data:working-copy:refs-cleared-for:${environmentId}`),
  ),
);
export interface RepositoryChange {
  readonly domains: ReadonlyArray<VcsInvalidationDomain>;
  /** Frames caused by one server-side change share this key. */
  readonly refsKey: unknown;
}
export const workingCopyRevisionAtom = (target: WorkingCopyTarget) => revisions(keyOf(target));
export const workingCopyRefreshTrigger = (target: {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly cwd: string };
}) => workingCopyRevisionAtom({ environmentId: target.environmentId, cwd: target.input.cwd });

export function bumpWorkingCopyRevision(
  registry: AtomRegistry.AtomRegistry,
  target: WorkingCopyTarget,
): void {
  registry.update(workingCopyRevisionAtom(target), (revision) => revision + 1);
}

/**
 * Decides what a stream frame invalidates (the caller applies it through
 * `invalidateRepository`), or null when it changes nothing: PR-only
 * frames, replays over duplicate subscriptions and the first frame ever seen
 * for a target (its queries are fetched fresh anyway). A new session
 * invalidates everything even when the token did not move while the client
 * was disconnected; a server without tokens falls back to payload equality,
 * which cannot see a stage/unstage with an unchanged summary.
 */
export function observeRepositoryChange(
  registry: AtomRegistry.AtomRegistry,
  target: WorkingCopyTarget,
  session: object,
  event: VcsStatusStreamEvent,
): RepositoryChange | null {
  if (event._tag === "remoteUpdated") return null;
  const atom = observations(keyOf(target));
  const previous = registry.get(atom);
  const token = event.workingCopyRevision;
  const local = token === undefined ? JSON.stringify(event.local) : "";
  const next = { session, token, local };
  if (previous === null) {
    registry.set(atom, next);
    return null;
  }
  if (previous.session === session) {
    if (
      token !== undefined &&
      previous.token?.epoch === token.epoch &&
      previous.token.counter >= token.counter
    ) {
      return null;
    }
    if (token === undefined && previous.token === undefined && previous.local === local) {
      return null;
    }
    registry.set(atom, next);
    const origin = event.invalidationOrigin ?? { cwd: target.cwd, counter: token?.counter };
    return {
      domains: event.invalidatedDomains ?? ALL_REPOSITORY_DOMAINS,
      refsKey:
        token === undefined ? next : `${token.epoch}\u0000${origin.cwd}\u0000${origin.counter}`,
    };
  }
  registry.set(atom, next);
  return { domains: ALL_REPOSITORY_DOMAINS, refsKey: session };
}

/**
 * Applies an invalidation: cached refs are cleared before the revision moves,
 * so every dependent re-read observes a consistent generation. Immutable
 * commit queries are deliberately left alone.
 */
export const invalidateRepository = Effect.fn("RepositoryInvalidation.invalidate")(function* (
  registry: AtomRegistry.AtomRegistry,
  target: WorkingCopyTarget,
  domains: ReadonlyArray<VcsInvalidationDomain> = ALL_REPOSITORY_DOMAINS,
  refsKey: unknown = null,
) {
  if (domains.includes("refs")) {
    const cleared = refsClearedFor(target.environmentId);
    if (refsKey === null || registry.get(cleared) !== refsKey) {
      registry.set(cleared, refsKey);
      yield* invalidateCachedVcsRefs(registry, target);
    }
  }
  bumpWorkingCopyRevision(registry, target);
});
