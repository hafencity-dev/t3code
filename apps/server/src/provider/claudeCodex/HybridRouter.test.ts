// @effect-diagnostics nodeBuiltinImport:off globalFetch:off
import * as NodeHttp from "node:http";
import { describe, expect, it } from "@effect/vitest";

import { claudeCodexFastModePayload } from "./ClaudeCodexFastMode.ts";
import {
  ClaudeCodexHybridRouter,
  claudeCodexUpstreamPath,
  classifyClaudeCodexUpstream,
} from "./HybridRouter.ts";

const isCodex = (model: string) => model.startsWith("gpt-") || model === "o3";

describe("ClaudeCodexHybridRouter", () => {
  it("routes verified Codex ids to the local bridge", () => {
    expect(classifyClaudeCodexUpstream("gpt-5.6-sol", isCodex)).toBe("codex");
    expect(classifyClaudeCodexUpstream("o3", isCodex)).toBe("codex");
  });

  it("keeps Claude aliases and full ids on Anthropic", () => {
    expect(classifyClaudeCodexUpstream("opus", isCodex)).toBe("anthropic");
    expect(classifyClaudeCodexUpstream("claude-opus-5[1m]", isCodex)).toBe("anthropic");
  });

  it("rejects missing and unknown models instead of leaking credentials", () => {
    expect(classifyClaudeCodexUpstream(undefined, isCodex)).toBe("reject");
    expect(classifyClaudeCodexUpstream("mystery-model", isCodex)).toBe("reject");
  });

  it("preserves a configured Claude-compatible upstream path", () => {
    expect(claudeCodexUpstreamPath("/api", "/v1/messages?beta=true")).toBe(
      "/api/v1/messages?beta=true",
    );
    expect(claudeCodexUpstreamPath("/", "/v1/models")).toBe("/v1/models");
  });
});

describe("claudeCodexFastModePayload", () => {
  it("adds or replaces the service tier without mutating the input", () => {
    const payload = { model: "gpt-6-astra", service_tier: "auto", speed: "normal" };
    expect(claudeCodexFastModePayload(payload, true)).toEqual({
      ...payload,
      service_tier: "priority",
    });
    expect(payload.service_tier).toBe("auto");
    expect(claudeCodexFastModePayload({ model: "gpt-6-astra" }, true)).toEqual({
      model: "gpt-6-astra",
      service_tier: "priority",
    });
  });

  it("strips every service tier and only the fast speed when disabled", () => {
    for (const service_tier of ["priority", "auto", "default", null]) {
      const payload = { model: "gpt-6-astra", service_tier, speed: "fast" };
      expect(claudeCodexFastModePayload(payload, false)).toEqual({ model: "gpt-6-astra" });
      expect(payload).toEqual({ model: "gpt-6-astra", service_tier, speed: "fast" });
    }
    expect(claudeCodexFastModePayload({ speed: "fast" }, false)).toEqual({});
    expect(
      claudeCodexFastModePayload({ service_tier: "priority", speed: "normal" }, false),
    ).toEqual({ speed: "normal" });
  });

  it("preserves object identity when nothing changes", () => {
    for (const payload of [
      null,
      undefined,
      "text",
      1,
      [],
      { model: "gpt-6-astra" },
      { speed: "normal" },
    ]) {
      expect(claudeCodexFastModePayload(payload, false)).toBe(payload);
    }
    const priority = { service_tier: "priority" };
    expect(claudeCodexFastModePayload(priority, true)).toBe(priority);
  });
});

it("applies live fast mode only to Codex messages and preserves other request bytes", async () => {
  const received: Array<{ body: string; headers: NodeHttp.IncomingHttpHeaders }> = [];
  const endpoint = NodeHttp.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      received.push({ body: Buffer.concat(chunks).toString("utf8"), headers: request.headers });
      response.end("OK");
    });
  });
  let router: ClaudeCodexHybridRouter | undefined;
  try {
    await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
    const address = endpoint.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    let fastModeEnabled = true;
    router = new ClaudeCodexHybridRouter({
      codexUpstream: () => ({ port: address.port, token: "codex-fixture" }),
      isCodexModel: isCodex,
      fastModeEnabled: () => fastModeEnabled,
      anthropicUpstream: new URL(`http://127.0.0.1:${address.port}`),
    });
    const baseUrl = await router.start();
    const post = async (body: string, path = "/v1/messages") => {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer claude-fixture" },
        body,
      });
      await response.text();
      return response.status;
    };

    for (const enabled of [true, false, true]) {
      fastModeEnabled = enabled;
      const payload = {
        model: "gpt-6-astra(high)",
        messages: [{ role: "user", content: "Hello 世界" }],
        ...(enabled ? {} : { service_tier: "priority", speed: "fast" }),
      };
      expect(await post(JSON.stringify(payload))).toBe(200);
      const wire = received.at(-1)!;
      expect(JSON.parse(wire.body)).toEqual({
        model: "gpt-6-astra",
        messages: payload.messages,
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
        ...(enabled ? { service_tier: "priority" } : {}),
      });
      expect(wire.headers.authorization).toBe("Bearer codex-fixture");
      expect(Number(wire.headers["content-length"])).toBe(Buffer.byteLength(wire.body));

      const anthropicBody = '{ "model": "opus", "service_tier": "auto", "speed": "fast" }\n';
      expect(await post(anthropicBody)).toBe(200);
      expect(received.at(-1)?.body).toBe(anthropicBody);
      expect(received.at(-1)?.headers.authorization).toBe("Bearer claude-fixture");

      const count = received.length;
      expect(await post('{ "model": "mystery-model" }')).toBe(400);
      expect(received).toHaveLength(count);
    }

    const nonMessage = '{ "model": "gpt-6-astra", "speed": "fast" }\n';
    expect(await post(nonMessage, "/v1/messages/count_tokens")).toBe(200);
    expect(received.at(-1)?.body).toBe(nonMessage);
    expect(received.at(-1)?.headers.authorization).toBe("Bearer claude-fixture");

    for (const enabled of [false, true]) {
      fastModeEnabled = enabled;
      const unchanged = enabled
        ? '{ "model": "gpt-6-astra", "service_tier": "priority" }\n'
        : '{ "model": "gpt-6-astra", "speed": "normal" }\n';
      expect(await post(unchanged)).toBe(200);
      expect(received.at(-1)?.body).toBe(unchanged);
    }
  } finally {
    router?.stop();
    endpoint.closeAllConnections();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
  }
});
