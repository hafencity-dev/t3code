import {
  createVcsActionManager,
  createVcsEnvironmentAtoms,
  createVcsStatusRevalidationAtomFamily,
} from "@t3tools/client-runtime/state/vcs";

import { connectionAtomRuntime } from "../connection/runtime";
import { serverEnvironment } from "./server";
import { subscribeDocumentReturn } from "../lib/documentActivity";

// fork: repository invalidation — let the shared runtime see server capabilities.
export const vcsEnvironment = createVcsEnvironmentAtoms(connectionAtomRuntime, {
  capabilities: (registry, environmentId) =>
    registry.get(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities,
});
export const vcsActionManager = createVcsActionManager(connectionAtomRuntime);

/**
 * Refreshes a checkout's status when the user comes back to the window, where
 * edits made in another app or terminal may be waiting.
 */
export const vcsStatusRevalidation = createVcsStatusRevalidationAtomFamily({
  refreshStatus: vcsEnvironment.refreshStatus,
  subscribeWake: subscribeDocumentReturn,
  wakeDebounceMs: 250,
});
