// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { CLAUDE_CODEX_BRIDGE_VERSION } from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { ClaudeCodexBridge } from "./ClaudeCodexBridge.ts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

describe("Claude Codex bridge lifecycle", () => {
  it("discards a previous runtime's model cache even when it is fresh", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bridge-cache-"));
    const directory = NodePath.join(root, "providers", "claude-codex-bridge");
    const bridge = new ClaudeCodexBridge(root, {
      platform: HostProcessPlatform.defaultValue(),
      architecture: HostProcessArchitecture.defaultValue(),
    });
    try {
      NodeFS.mkdirSync(directory, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(directory, "models-cache.json"),
        JSON.stringify({
          runtimeVersion: "7.2.120",
          fetchedAt: Number.MAX_SAFE_INTEGER,
          data: [{ id: "gpt-5.6-sol" }],
        }),
      );
      const result = await bridge.models();
      expect(result.source).toBe("fallback");
      expect(result.models.some((model) => model.id === "gpt-6-astra")).toBe(true);
    } finally {
      bridge.dispose();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(HostProcessPlatform.defaultValue() === "win32")(
    "shares startup and waits for registered models after HTTP becomes healthy",
    async () => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bridge-startup-"));
      const directory = NodePath.join(root, "providers", "claude-codex-bridge");
      const runtime = NodePath.join(directory, "runtime", CLAUDE_CODEX_BRIDGE_VERSION);
      const fixture = NodePath.join(root, "runtime.cjs");
      const bridge = new ClaudeCodexBridge(root, {
        platform: HostProcessPlatform.defaultValue(),
        architecture: HostProcessArchitecture.defaultValue(),
      });
      try {
        NodeFS.mkdirSync(runtime, { recursive: true });
        NodeFS.mkdirSync(NodePath.join(directory, "auth"));
        NodeFS.writeFileSync(
          NodePath.join(directory, "auth", "test.json"),
          JSON.stringify({ type: "codex", access_token: "fake" }),
        );
        NodeFS.writeFileSync(
          fixture,
          `
const fs = require("node:fs");
const http = require("node:http");
const config = fs.readFileSync(process.argv.at(-1), "utf8");
const port = Number(config.match(/^port: (\\d+)/m)[1]);
fs.appendFileSync(${JSON.stringify(NodePath.join(root, "starts"))}, "started\\n");
let probes = 0;
http.createServer((_request, response) => {
  probes += 1;
  fs.writeFileSync(${JSON.stringify(NodePath.join(root, "probes"))}, String(probes));
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ data: probes === 1 ? [] : [{ id: "gpt-6-astra", owned_by: "openai" }] }));
}).listen(port, "127.0.0.1");
`,
        );
        NodeFS.writeFileSync(
          NodePath.join(runtime, "cli-proxy-api"),
          `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`,
          { mode: 0o700 },
        );
        const routes = await Promise.all([
          bridge.hybridEnvironment(),
          bridge.hybridEnvironment(),
          bridge.hybridEnvironment(),
        ]);
        expect(new Set(routes.map((route) => route.environment.ANTHROPIC_BASE_URL)).size).toBe(1);
        expect(NodeFS.readFileSync(NodePath.join(root, "starts"), "utf8")).toBe("started\n");
        expect(NodeFS.readFileSync(NodePath.join(root, "probes"), "utf8")).toBe("2");
        const catalog = await bridge.models();
        expect(catalog.source).toBe("cache");
        expect(catalog.models).toEqual([{ id: "gpt-6-astra", ownedBy: "openai" }]);
        await expect(bridge.hybridEnvironment("gpt-unknown")).rejects.toThrow(
          "does not offer gpt-unknown",
        );
      } finally {
        bridge.dispose();
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
