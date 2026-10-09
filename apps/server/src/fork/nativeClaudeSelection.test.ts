import { ClaudeSettings, ProviderInstanceId } from "@t3tools/contracts";
import { Schema } from "effect";
import { expect, it } from "vite-plus/test";
import { nativeClaudeSelection } from "./nativeClaudeSelection.ts";

const decodeSettings = Schema.decodeUnknownSync(ClaudeSettings);
const selection = { instanceId: ProviderInstanceId.make("custom-claude"), model: "gpt-6-sol" };
it("preserves custom endpoint GPT selections without the matching retired route", () => {
  for (const settings of [
    decodeSettings({}),
    decodeSettings({ codexRouting: { enabled: false, model: "gpt-6-sol" } }),
    decodeSettings({ codexRouting: { enabled: true, model: "gpt-6-astra" } }),
  ]) {
    expect(nativeClaudeSelection(selection, settings)).toEqual({ selection, notice: undefined });
  }
});
