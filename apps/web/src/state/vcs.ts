import {
  createVcsActionManager,
  createVcsEnvironmentAtoms,
} from "@t3tools/client-runtime/state/vcs";

import { connectionAtomRuntime } from "../connection/runtime";
import { serverEnvironment } from "./server";

// fork: repository invalidation — let the shared runtime see server capabilities.
export const vcsEnvironment = createVcsEnvironmentAtoms(connectionAtomRuntime, {
  capabilities: (registry, environmentId) =>
    registry.get(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities,
});
export const vcsActionManager = createVcsActionManager(connectionAtomRuntime);
