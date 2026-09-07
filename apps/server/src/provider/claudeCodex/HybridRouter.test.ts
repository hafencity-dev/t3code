// @effect-diagnostics nodeBuiltinImport:off globalFetch:off
import * as NodeHttp from "node:http";
import { describe, expect, it, vi } from "@effect/vitest";

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

    for (const model of ["gpt-6-astra", "gpt-6-astra(high)", "opus"]) {
      expect(await post(JSON.stringify({ model }), "/v1/messages/count_tokens?beta=true")).toBe(
        200,
      );
      expect(JSON.parse(received.at(-1)!.body).model).toBe(
        model === "opus" ? model : "gpt-6-astra",
      );
      expect(received.at(-1)?.headers.authorization).toBe(
        model === "opus" ? "Bearer claude-fixture" : "Bearer codex-fixture",
      );
    }
    expect(await post('{ "model": "unknown" }', "/v1/messages/count_tokens")).toBe(400);
    const nonMessage = '{ "model": "gpt-6-astra", "speed": "fast" }\n';
    expect(await post(nonMessage, "/v1/other")).toBe(200);
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

// Real sockets and explicit request receipts keep failure tests deterministic.
async function withEndpoint(
  handle: NodeHttp.RequestListener,
  run: (port: number) => Promise<void>,
) {
  const endpoint = NodeHttp.createServer(handle);
  try {
    await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
    const address = endpoint.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    await run(address.port);
  } finally {
    endpoint.closeAllConnections();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
  }
}

const messageRequest = () => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "gpt-6-astra", messages: [] }),
});

it("waits for recovery before forwarding and survives rejected startup", async () => {
  await withEndpoint(
    (_req, res) => res.end("recovered"),
    async (port) => {
      const ready = Promise.withResolvers<void>();
      const requested = Promise.withResolvers<void>();
      let fail = true;
      const router = new ClaudeCodexHybridRouter({
        isCodexModel: isCodex,
        codexUpstream: async () => {
          if (fail) throw new Error("fixture startup failure");
          requested.resolve();
          await ready.promise;
          return { port, token: "fixture" };
        },
      });
      try {
        const url = `${await router.start()}/v1/messages`;
        const failed = await fetch(url, messageRequest());
        expect(failed.status).toBe(502);
        expect(await failed.json()).toMatchObject({ type: "error", error: { type: "api_error" } });
        fail = false;
        const response = fetch(url, messageRequest());
        await requested.promise;
        ready.resolve();
        expect(await (await response).text()).toBe("recovered");
      } finally {
        ready.resolve();
        router.stop();
      }
    },
  );
});

it.each([undefined, 0])(
  "keeps an active stream open for hours when no duration limit is set (%s)",
  async (requestTimeoutMs) => {
    const upstream = Promise.withResolvers<NodeHttp.ServerResponse>();
    await withEndpoint(
      (_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": started\n\n");
        upstream.resolve(res);
      },
      async (port) => {
        const router = new ClaudeCodexHybridRouter({
          isCodexModel: isCodex,
          codexUpstream: () => ({ port, token: "fixture" }),
          requestTimeoutMs,
        });
        try {
          const url = `${await router.start()}/v1/messages`;
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
          const response = await fetch(url, messageRequest());
          const reader = response.body!.getReader();
          expect(new TextDecoder().decode((await reader.read()).value)).toContain("started");
          const stream = await upstream.promise;
          for (let hour = 0; hour < 3; hour += 1) {
            await vi.advanceTimersByTimeAsync(60 * 60_000);
            stream.write(": still working\n\n");
            expect(new TextDecoder().decode((await reader.read()).value)).toContain(
              "still working",
            );
          }
          stream.end();
          expect((await reader.read()).done).toBe(true);
        } finally {
          vi.useRealTimers();
          router.stop();
        }
      },
    );
  },
);

it.each([false, true])(
  "bounds stalled requests (headers sent: %s) and allows the next turn",
  async (stream) => {
    const received = Promise.withResolvers<void>();
    const disconnected = Promise.withResolvers<void>();
    let stall = true;
    await withEndpoint(
      (_req, res) => {
        if (!stall) return res.end("next turn");
        res.once("close", () => disconnected.resolve());
        if (stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(": keepalive\n\n");
        }
        received.resolve();
      },
      async (port) => {
        const router = new ClaudeCodexHybridRouter({
          isCodexModel: isCodex,
          codexUpstream: () => ({ port, token: "fixture" }),
          requestTimeoutMs: 1800_000,
        });
        try {
          const url = `${await router.start()}/v1/messages`;
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
          const response = fetch(url, messageRequest());
          await received.promise;
          // Read streaming headers before advancing the request deadline.
          const streamingResponse = stream ? await response : undefined;
          await vi.advanceTimersByTimeAsync(1800_000);
          if (streamingResponse) {
            await expect(streamingResponse.text()).rejects.toThrow();
          } else {
            expect((await response).status).toBe(504);
            expect(await (await response).json()).toMatchObject({ type: "error" });
          }
          await disconnected.promise;
          vi.useRealTimers();
          stall = false;
          expect(await (await fetch(url, messageRequest())).text()).toBe("next turn");
        } finally {
          vi.useRealTimers();
          router.stop();
        }
      },
    );
  },
);

it.each(["/v1/messages", "/v1/models"])(
  "cancels upstream work when the client disconnects from %s",
  async (path) => {
    const received = Promise.withResolvers<void>();
    const disconnected = Promise.withResolvers<void>();
    await withEndpoint(
      (_req, res) => {
        res.once("close", () => disconnected.resolve());
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": ping\n\n");
        received.resolve();
      },
      async (port) => {
        const router = new ClaudeCodexHybridRouter({
          isCodexModel: isCodex,
          codexUpstream: () => ({ port, token: "fixture" }),
          anthropicUpstream: new URL(`http://127.0.0.1:${port}`),
        });
        try {
          const controller = new AbortController();
          const response = fetch(`${await router.start()}${path}`, {
            ...(path === "/v1/messages" ? messageRequest() : {}),
            signal: controller.signal,
          });
          await received.promise;
          const body = await response;
          controller.abort();
          await expect(body.text()).rejects.toThrow();
          await disconnected.promise;
        } finally {
          router.stop();
        }
      },
    );
  },
);
