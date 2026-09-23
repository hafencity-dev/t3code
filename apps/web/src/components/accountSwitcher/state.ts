import { createProviderAccountsEnvironmentAtoms } from "@t3tools/client-runtime/state/provider-accounts";
import { connectionAtomRuntime } from "../../connection/runtime";

export const providerAccountsEnvironment =
  createProviderAccountsEnvironmentAtoms(connectionAtomRuntime);
