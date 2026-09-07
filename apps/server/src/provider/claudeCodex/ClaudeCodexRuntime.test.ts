// @effect-diagnostics nodeBuiltinImport:off globalFetch:off
/** Set T3_TEST_CODEX_BRIDGE_BINARY to the checksum-verified pinned executable.
 * This opt-in test checks real OAuth registration, then uses an API-key fixture
 * to inspect translated requests at a local endpoint. No real credentials or
 * ChatGPT requests are used; only the test runtime's generated config is amended.
 */
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { CLAUDE_CODEX_BRIDGE_VERSION, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { ClaudeCodexBridge } from "./ClaudeCodexBridge.ts";
import { claudeCodexTransportModel } from "./ClaudeCodexEffort.ts";

const binary = process.env.T3_TEST_CODEX_BRIDGE_BINARY;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

describe("pinned Claude Codex runtime", () => {
  it.skipIf(!binary || HostProcessPlatform.defaultValue() === "win32")(
    "registers Astra for OAuth and preserves effort and live fast mode on the real Codex wire",
    async () => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-codex-runtime-"));
      const received: Array<{
        model: string;
        reasoning: { effort: string };
        service_tier?: string;
      }> = [];
      const endpoint = NodeHttp.createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        request.on("end", () => {
          received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          response.setHeader("content-type", "text/event-stream");
          const message = {
            id: "msg_test",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "OK", annotations: [] }],
          };
          const result = {
            id: "resp_test",
            object: "response",
            model: "gpt-6-astra",
            status: "completed",
            output: [message],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          };
          const events = [
            {
              type: "response.created",
              response: { ...result, status: "in_progress", output: [] },
            },
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { ...message, status: "in_progress", content: [] },
            },
            {
              type: "response.content_part.added",
              item_id: "msg_test",
              output_index: 0,
              content_index: 0,
              part: { type: "output_text", text: "", annotations: [] },
            },
            {
              type: "response.output_text.delta",
              item_id: "msg_test",
              output_index: 0,
              content_index: 0,
              delta: "OK",
            },
            {
              type: "response.output_text.done",
              item_id: "msg_test",
              output_index: 0,
              content_index: 0,
              text: "OK",
            },
            { type: "response.output_item.done", output_index: 0, item: message },
            { type: "response.completed", response: result },
          ];
          response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
        });
      });
      const bridge = new ClaudeCodexBridge(root, {
        platform: HostProcessPlatform.defaultValue(),
        architecture: HostProcessArchitecture.defaultValue(),
      });
      try {
        await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
        const address = endpoint.address();
        if (!address || typeof address === "string") throw new Error("Missing fixture port");
        const bridgeRoot = NodePath.join(root, "providers", "claude-codex-bridge");
        const authDir = NodePath.join(bridgeRoot, "auth");
        const runtimeDir = NodePath.join(bridgeRoot, "runtime", CLAUDE_CODEX_BRIDGE_VERSION);
        const launcher = NodePath.join(runtimeDir, "cli-proxy-api");
        NodeFS.mkdirSync(authDir, { recursive: true });
        NodeFS.mkdirSync(runtimeDir, { recursive: true });
        // OAuth catalog registration needs no network access; block outgoing use of this fake token.
        NodeFS.writeFileSync(
          NodePath.join(authDir, "codex-test.json"),
          JSON.stringify({
            type: "codex",
            access_token: "fake-test-token",
            proxy_url: "http://127.0.0.1:1",
          }),
        );
        NodeFS.writeFileSync(
          launcher,
          `#!/bin/sh\nexec ${quote(NodePath.resolve(binary!))} "$@"\n`,
          { mode: 0o700 },
        );
        await bridge.hybridEnvironment("gpt-6-astra");
        const catalog = await bridge.models(true);
        expect(catalog.source).toBe("live");
        expect(catalog.models.some((model) => model.id === "gpt-6-astra")).toBe(true);
        await expect(bridge.hybridEnvironment("gpt-nonexistent-test")).rejects.toThrow(
          "does not offer",
        );
        bridge.stop(true);
        // API-key credentials allow an explicit loopback base URL. Disable OAuth
        // routes for this phase so every translated request goes to our fixture.
        const extraConfig = NodePath.join(root, "fixture.yaml");
        NodeFS.writeFileSync(
          extraConfig,
          `\noauth-excluded-models:\n  codex: ["*"]\ncodex-api-key:\n  - api-key: "fake-fixture-key"\n    base-url: "http://127.0.0.1:${address.port}"\n    models:\n      - name: "gpt-6-astra"\n        alias: "gpt-6-astra"\n`,
        );
        NodeFS.writeFileSync(
          launcher,
          `#!/bin/sh\ncat ${quote(extraConfig)} >> "$3"\nexec ${quote(NodePath.resolve(binary!))} "$@"\n`,
          { mode: 0o700 },
        );
        const routing = await bridge.hybridEnvironment("gpt-6-astra");
        // Reuse the same routing URL to verify changes without restarting the runtime.
        for (const fastMode of [true, false]) {
          bridge.setFastModeEnabled(fastMode);
          for (const stream of [false, true]) {
            for (const effort of ["low", "medium", "high", "xhigh", "max", "default"]) {
              const selection = createModelSelection(
                ProviderInstanceId.make("claudeAgent"),
                "gpt-6-astra",
                [{ id: "reasoningEffort", value: effort }],
              );
              const response = await fetch(
                `${routing.environment.ANTHROPIC_BASE_URL}/v1/messages`,
                {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    model: claudeCodexTransportModel(selection.model, selection),
                    max_tokens: 16,
                    service_tier: "auto",
                    // Enabled must work without a client fast hint; disabled must remove it.
                    ...(fastMode ? {} : { speed: "fast" }),
                    stream,
                    messages: [{ role: "user", content: "Reply OK" }],
                  }),
                },
              );
              const body = await response.text();
              expect(response.status, body).toBe(200);
              if (stream) {
                expect(body).toContain('"text":"OK"');
                expect(body).toContain('"type":"message_stop"');
              } else {
                expect(JSON.parse(body)).toMatchObject({ content: [{ type: "text", text: "OK" }] });
              }
              expect(received.at(-1)?.model).toBe("gpt-6-astra");
              if (fastMode) {
                expect(received.at(-1)?.service_tier).toBe("priority");
              } else {
                expect(received.at(-1)).not.toHaveProperty("service_tier");
              }
              expect(received.at(-1)?.reasoning.effort).toBe(
                effort === "default" ? "medium" : effort,
              );
            }
          }
        }
        expect(received).toHaveLength(24);
      } finally {
        bridge.dispose();
        endpoint.closeAllConnections();
        await new Promise<void>((resolve) => endpoint.close(() => resolve()));
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    },
    30000,
  );
});
