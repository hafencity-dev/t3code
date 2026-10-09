import * as Schema from "effect/Schema";
import { GitPreparePullRequestThreadInput } from "./git.ts";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  AuthProvidersManageScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { WS_METHODS } from "./rpc.ts";

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  // fork: apply the same permission checks to account and working-copy RPCs on every client.
  [WS_METHODS.providerAccountsSetAutoSwitch]: AuthProvidersManageScope, // fork: provider accounts
  [WS_METHODS.providerAccountsSetWindowPrimer]: AuthProvidersManageScope, // fork: provider accounts
  [WS_METHODS.providerAccountsRefreshUsage]: AuthProvidersManageScope, // fork: provider accounts
  [WS_METHODS.providerAccountsSubmitLoginCode]: AuthProvidersManageScope, // fork: provider accounts
  [WS_METHODS.providerAccountsCancelLogin]: AuthProvidersManageScope, // fork: provider accounts
  [WS_METHODS.providerAccountsSwitch]: AuthProvidersManageScope, // fork: provider accounts
  [WS_METHODS.providerAccountsRename]: AuthProvidersManageScope, // fork: provider accounts
  [WS_METHODS.providerAccountsRemove]: AuthProvidersManageScope, // fork: provider accounts
  [WS_METHODS.providerAccountsSetAutoSwitchExcluded]: AuthProvidersManageScope, // fork: provider accounts
  [WS_METHODS.workingCopyStagePaths]: AuthSourceControlWriteScope,
  [WS_METHODS.workingCopyUnstagePaths]: AuthSourceControlWriteScope,
  [WS_METHODS.workingCopyApplyPatch]: AuthSourceControlWriteScope,
  [WS_METHODS.workingCopyDiscardPaths]: AuthSourceControlWriteScope,
  [WS_METHODS.workingCopyRestoreDiscardBackup]: AuthSourceControlWriteScope,
  [WS_METHODS.workingCopyCommitStaged]: AuthSourceControlWriteScope,
  [WS_METHODS.workingCopyAmendCommit]: AuthSourceControlWriteScope,
  [WS_METHODS.workingCopyUndoLastCommit]: AuthSourceControlWriteScope,
  [WS_METHODS.workingCopyStashPush]: AuthSourceControlWriteScope,
  [WS_METHODS.workingCopyStashApply]: AuthSourceControlWriteScope,
  [WS_METHODS.workingCopyStashPop]: AuthSourceControlWriteScope,
  [WS_METHODS.workingCopyStashDrop]: AuthSourceControlWriteScope,
  [WS_METHODS.workingCopyResolveConflict]: AuthSourceControlWriteScope,
  [WS_METHODS.workingCopyAbortOperation]: AuthSourceControlWriteScope,
  [WS_METHODS.workingCopyCherryPick]: AuthSourceControlWriteScope,
  [WS_METHODS.workingCopyRevertCommit]: AuthSourceControlWriteScope,
  [WS_METHODS.workingCopyCheckoutCommit]: AuthSourceControlWriteScope,
  [WS_METHODS.workingCopyResetToCommit]: AuthSourceControlWriteScope,
  [WS_METHODS.workingCopyTagCommit]: AuthSourceControlWriteScope,

  [WS_METHODS.pullRequestsRunAction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdateComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSubmitReview]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsReplyToThread]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetThreadResolution]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetReaction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetFilesViewed]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsRequestReviewers]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetLabels]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,

  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: AuthOrchestrationOperateScope,
} as const;
export type ClientGuardedRpcTag = keyof typeof CLIENT_GUARDED_RPC_SCOPES;

const decodePrepareThread = Schema.decodeUnknownSync(GitPreparePullRequestThreadInput);

export function clientRpcRequiredScopes(
  method: string,
  input: unknown,
): readonly AuthEnvironmentScope[] {
  if (method === WS_METHODS.gitPreparePullRequestThread && input !== undefined) {
    const payload = decodePrepareThread(input);
    if (payload.mode === "worktree" && payload.threadId !== undefined)
      return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  }
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as ClientGuardedRpcTag]]
    : [];
}
