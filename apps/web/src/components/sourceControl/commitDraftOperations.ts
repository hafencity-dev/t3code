// fork: capture the draft's repository before any await, including confirmation.
import { commitMessageGenerationApply } from "@t3tools/client-runtime/state/working-copy-logic";

import { confirmReplaceCommitDraft } from "~/lib/sourceControl/safetyLadder";
import { sourceControlDraftKey, useSourceControlStore } from "~/sourceControlStore";
import type { SourceControlConfirmController } from "./useSourceControlConfirm";

type Confirm = SourceControlConfirmController["confirm"];

export async function commitSourceControlDraft(
  key: string,
  commit: (message: string) => Promise<boolean>,
): Promise<boolean> {
  const message = useSourceControlStore.getState().commitDraftByScope[key] ?? "";
  const committed = await commit(message);
  if (committed) useSourceControlStore.getState().clearCommitDraft(key, message);
  return committed;
}

export async function generateSourceControlDraft(
  key: string,
  generate: () => Promise<string | null>,
  confirm: Confirm,
): Promise<void> {
  const draftAtPress = useSourceControlStore.getState().commitDraftByScope[key] ?? "";
  const generated = await generate();
  if (generated === null) return;
  const draftNow = useSourceControlStore.getState().commitDraftByScope[key] ?? "";
  const decision = commitMessageGenerationApply({ draftAtPress, draftNow });
  if (decision === "discard") return;
  if (decision === "confirm") {
    const outcome = await confirm(confirmReplaceCommitDraft({ generated }));
    if (outcome !== "confirmed") return;
  }
  // Recheck after the dialog too: another thread may have edited the same draft.
  useSourceControlStore.getState().setCommitDraft(key, generated, draftAtPress);
}

export async function recoverSourceControlDraft(
  target: { readonly environmentId: string; readonly cwd: string },
  confirm: Confirm,
): Promise<boolean> {
  const key = sourceControlDraftKey(target.environmentId, target.cwd);
  const state = useSourceControlStore.getState();
  const legacy = state.legacyCommitDraftByCwd[target.cwd];
  if (!legacy || (state.commitDraftByScope[key] ?? "").length > 0) return false;
  const outcome = await confirm({
    title: "Recover old commit draft?",
    consequence:
      "This draft predates environment isolation. Use it only if it belongs to this repository. Recovery moves it here and stops offering it elsewhere; discarding removes it everywhere.",
    body: `Environment: ${target.environmentId}\nRepository: ${target.cwd}\n\n${legacy}`,
    confirmLabel: "Use draft here",
    tone: "neutral",
    alternative: { label: "Discard old draft" },
  });
  const store = useSourceControlStore.getState();
  if (outcome === "alternative") store.discardLegacyCommitDraft(target.cwd, legacy);
  return outcome === "confirmed" ? store.adoptLegacyCommitDraft(key, target.cwd, legacy) : false;
}
