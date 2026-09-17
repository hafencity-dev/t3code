// fork: f4 source-control panel — web binding for the working-copy atoms.
import { createWorkingCopyEnvironmentAtoms } from "@t3tools/client-runtime/state/working-copy";

import { connectionAtomRuntime } from "../connection/runtime";
import { serverEnvironment } from "./server";

export const workingCopyEnvironment = createWorkingCopyEnvironmentAtoms(connectionAtomRuntime, {
  capabilities: (registry, environmentId) =>
    registry.get(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities,
});
