// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { CLAUDE_CODEX_BRIDGE_VERSION } from "@t3tools/contracts";

import {
  ClaudeCodexBridge,
  commitStagedClaudeCodexAuth,
  directoryHasCodexBridgeCredential,
  parseClaudeCodexModelsPayload,
} from "./ClaudeCodexBridge.ts";

const fs = NodeFS;
const path = NodePath;

describe("ClaudeCodexBridge", () => {
  it("routes new and previously saved Sol subagents to Astra", () => {
    const bridge = new ClaudeCodexBridge("/unused-routing-test", {
      platform: "darwin",
      architecture: "arm64",
    });
    expect(bridge.subagentModel()).toBe("gpt-6-astra");
    expect(bridge.subagentModel(" gpt-5.6-sol ")).toBe("gpt-6-astra");
    expect(bridge.subagentModel("gpt-5.5")).toBe("gpt-5.5");
  });

  it("ignores the old runtime and model cache after a version upgrade", async () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), ".tmp-claude-codex-upgrade-"));
    const bridgeRoot = path.join(root, "providers", "claude-codex-bridge");
    try {
      const oldRuntime = path.join(bridgeRoot, "runtime", "7.2.154");
      fs.mkdirSync(oldRuntime, { recursive: true });
      fs.writeFileSync(path.join(oldRuntime, "cli-proxy-api"), "old runtime");
      fs.writeFileSync(
        path.join(bridgeRoot, "models-cache.json"),
        JSON.stringify({
          runtimeVersion: "7.2.154",
          fetchedAt: Number.MAX_SAFE_INTEGER,
          data: [{ id: "gpt-5.4" }],
        }),
      );
      const bridge = new ClaudeCodexBridge(root, { platform: "linux", architecture: "x64" });
      expect(CLAUDE_CODEX_BRIDGE_VERSION).toBe("7.3.15");
      expect(bridge.status()).toMatchObject({ version: "7.3.15", installed: false });
      expect(await bridge.models()).toMatchObject({
        source: "fallback",
        models: [
          "gpt-6-astra",
          "gpt-6-sol",
          "gpt-6-luna",
          "gpt-5.6-terra",
          "gpt-5.6-luna",
          "gpt-5.5",
        ].map((id) => ({ id })),
      });
      const newRuntime = path.join(bridgeRoot, "runtime", CLAUDE_CODEX_BRIDGE_VERSION);
      fs.mkdirSync(newRuntime, { recursive: true });
      fs.writeFileSync(path.join(newRuntime, "cli-proxy-api"), "new runtime");
      expect(bridge.status().installed).toBe(true);
      fs.writeFileSync(
        path.join(bridgeRoot, "models-cache.json"),
        JSON.stringify({
          runtimeVersion: CLAUDE_CODEX_BRIDGE_VERSION,
          fetchedAt: Number.MAX_SAFE_INTEGER,
          data: [{ id: "gpt-6-sol" }],
        }),
      );
      expect(await bridge.models()).toMatchObject({
        source: "cache",
        models: [{ id: "gpt-6-sol" }],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts only well-formed, unique model catalog entries", () => {
    expect(
      parseClaudeCodexModelsPayload({
        data: [
          { id: "gpt-5.6-sol", owned_by: "openai" },
          { id: "gpt-5.6-sol" },
          { id: "bad id" },
          null,
        ],
      }),
    ).toEqual([{ id: "gpt-5.6-sol", ownedBy: "openai" }]);
  });

  it("recognizes bridge-owned Codex credential files", () => {
    const directory = fs.mkdtempSync(path.join(process.cwd(), ".tmp-claude-codex-auth-"));
    try {
      fs.writeFileSync(
        path.join(directory, "codex-user-pro.json"),
        JSON.stringify({ type: "codex", access_token: "redacted", refresh_token: "redacted" }),
      );
      expect(directoryHasCodexBridgeCredential(directory)).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("replaces a connected account only after staged credentials validate", () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), ".tmp-claude-codex-switch-"));
    const live = path.join(root, "auth");
    const staging = path.join(root, "auth-staging");
    try {
      fs.mkdirSync(live);
      fs.mkdirSync(staging);
      fs.writeFileSync(path.join(live, "codex-old.json"), JSON.stringify({ type: "codex" }));
      fs.writeFileSync(path.join(staging, "invalid.json"), "{}");
      expect(() => commitStagedClaudeCodexAuth(live, staging, "linux")).toThrow();
      expect(fs.existsSync(path.join(live, "codex-old.json"))).toBe(true);

      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(staging);
      fs.writeFileSync(path.join(staging, "codex-new.json"), JSON.stringify({ type: "codex" }));
      commitStagedClaudeCodexAuth(live, staging, "linux");
      expect(fs.existsSync(path.join(live, "codex-old.json"))).toBe(false);
      expect(fs.existsSync(path.join(live, "codex-new.json"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
