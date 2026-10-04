// fork: account lifecycle fixtures use the same V2 shell contract as connected clients.
import { OrchestrationV2ThreadShell, ProviderInstanceId } from "@t3tools/contracts";
import { DateTime, Schema } from "effect";
const decode = Schema.decodeUnknownSync(OrchestrationV2ThreadShell);
export const accountThreadShell = (instanceId: ProviderInstanceId) =>
  decode({
    id: "thread-1",
    projectId: "project-1",
    title: "Running thread",
    createdBy: "user",
    creationSource: "web",
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "test-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    lineage: { rootThreadId: "thread-1", parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    activeProviderThreadId: null,
    latestRunId: "run-1",
    activeRunId: "run-1",
    status: "running",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: DateTime.makeUnsafe("2026-09-23T12:00:00.000Z"),
    updatedAt: DateTime.makeUnsafe("2026-09-23T12:00:00.000Z"),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
  });
