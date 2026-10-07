import { describe, expect, it } from "vite-plus/test";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { AuthSourceControlWriteScope, AuthProvidersManageScope } from "./auth.ts";
import { WS_METHODS } from "./rpc.ts";

describe("2code client RPC permissions", () => {
  it.each([
    [WS_METHODS.workingCopyStagePaths, AuthSourceControlWriteScope],
    [WS_METHODS.workingCopyDiscardPaths, AuthSourceControlWriteScope],
    [WS_METHODS.providerAccountsSwitch, AuthProvidersManageScope],
  ] as const)("guards %s before dispatch", (method, scope) => {
    expect(clientRpcRequiredScopes(method, undefined)).toEqual([scope]);
  });
});
