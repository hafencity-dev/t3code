// @effect-diagnostics nodeBuiltinImport:off globalFetch:off
import * as NodeHttp from "node:http";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { claudeCodexCapabilities, claudeCodexTransportModel } from "./ClaudeCodexEffort.ts";
import { ClaudeCodexHybridRouter } from "./HybridRouter.ts";

describe("Astra effort bridge", () => {
  it("advertises all supported levels and ignores invalid or unrelated selections", () => {
    expect(claudeCodexCapabilities("gpt-6-astra").optionDescriptors).toMatchObject([
      {
        id: "reasoningEffort",
        options: ["default", "low", "medium", "high", "xhigh", "max"].map((id) => ({ id })),
      },
    ]);
    for (const [model, effort] of [
      ["gpt-6-astra", "invalid"],
      ["claude-opus-5", "ultra"],
    ]) {
      const selection = createModelSelection(ProviderInstanceId.make("claudeAgent"), model!, [
        { id: "reasoningEffort", value: effort! },
      ]);
      expect(claudeCodexTransportModel(model!, selection)).toBe(model);
    }
  });

  it("forwards independent effort levels and preserves ordinary requests", async () => {
    const upstream = NodeHttp.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        response.end(Buffer.concat(chunks));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Missing port");
    const router = new ClaudeCodexHybridRouter({
      codexUpstream: () => ({ port: address.port, token: "test" }),
      isCodexModel: (model) => model.startsWith("gpt-"),
      anthropicUpstream: new URL(`http://127.0.0.1:${address.port}`),
    });
    try {
      const url = await router.start();
      const send = async (body: object) => {
        const response = await fetch(`${url}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(200);
        return response.json();
      };
      await Promise.all(
        ["low", "medium", "high", "xhigh", "max"].map(async (effort) => {
          expect(
            await send({
              model: `gpt-6-astra(${effort})`,
              messages: [],
              thinking: { type: "disabled" },
              output_config: { format: "json" },
            }),
          ).toEqual({
            model: "gpt-6-astra",
            messages: [],
            thinking: { type: "adaptive" },
            output_config: { format: "json", effort },
          });
        }),
      );
      for (const model of ["gpt-6-astra", "claude-opus-5"]) {
        const body = { model, messages: [], thinking: { type: "disabled" } };
        expect(await send(body)).toEqual(body);
      }
    } finally {
      router.stop();
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
