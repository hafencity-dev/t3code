// @effect-diagnostics nodeBuiltinImport:off globalFetch:off
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it, vi } from "@effect/vitest";
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

async function withBridgeFixture(
  handle: NodeHttp.RequestListener,
  run: (fixture: {
    bridge: ClaudeCodexBridge;
    launcher: string;
    authFile: string;
    origin: string;
    starts: string;
    restoreLauncher: () => void;
  }) => Promise<void>,
) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bridge-lifecycle-"));
  const directory = NodePath.join(root, "providers", "claude-codex-bridge");
  const runtime = NodePath.join(directory, "runtime", CLAUDE_CODEX_BRIDGE_VERSION);
  const authFile = NodePath.join(directory, "auth", "fixture.json");
  const launcher = NodePath.join(runtime, "cli-proxy-api");
  const starts = NodePath.join(root, "starts");
  const childScript = NodePath.join(root, "runtime.cjs");
  const endpoint = NodeHttp.createServer(handle);
  const bridge = new ClaudeCodexBridge(root, {
    platform: HostProcessPlatform.defaultValue(),
    architecture: HostProcessArchitecture.defaultValue(),
  });
  const restoreLauncher = () =>
    NodeFS.writeFileSync(
      launcher,
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(childScript)} "$@"\n`,
      { mode: 0o700 },
    );
  try {
    await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
    const address = endpoint.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    const origin = `http://127.0.0.1:${address.port}`;
    NodeFS.mkdirSync(runtime, { recursive: true });
    NodeFS.mkdirSync(NodePath.dirname(authFile));
    NodeFS.writeFileSync(authFile, JSON.stringify({ type: "codex", access_token: "fixture" }));
    NodeFS.writeFileSync(
      childScript,
      `
const fs = require("node:fs");
const http = require("node:http");
const config = fs.readFileSync(process.argv.at(-1), "utf8");
const port = Number(config.match(/^port: (\\d+)/m)[1]);
fs.appendFileSync(${JSON.stringify(starts)}, "started\\n");
http.createServer((req, res) => {
  const upstream = http.request(${JSON.stringify(origin)} + req.url, {method: req.method}, (incoming) => {
    res.writeHead(incoming.statusCode, incoming.headers);
    incoming.pipe(res);
  });
  upstream.on("error", () => res.destroy());
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
}).listen(port, "127.0.0.1");
`,
    );
    restoreLauncher();
    await run({ bridge, launcher, authFile, origin, starts, restoreLauncher });
  } finally {
    bridge.dispose();
    endpoint.closeAllConnections();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}

const healthyEndpoint: NodeHttp.RequestListener = (request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify(request.url === "/v1/models" ? { data: [{ id: "gpt-6-astra" }] } : { ok: true }),
  );
};

describe.skipIf(HostProcessPlatform.defaultValue() === "win32")("bridge recovery", () => {
  it("reports spawn errors without crashing the server and allows another start", async () => {
    await withBridgeFixture(healthyEndpoint, async ({ bridge, launcher, restoreLauncher }) => {
      NodeFS.writeFileSync(launcher, "#!/missing-t3-fixture-interpreter\n");
      await expect(bridge.ensureReady()).rejects.toThrow("ENOENT");
      expect(bridge.status().running).toBe(false);
      restoreLauncher();
      await bridge.ensureReady();
      expect(bridge.status().running).toBe(true);
    });
  });

  it("does not resurrect a stopped bridge after an in-flight install completes", async () => {
    await withBridgeFixture(healthyEndpoint, async ({ bridge, starts }) => {
      const installed = Promise.withResolvers<ReturnType<ClaudeCodexBridge["status"]>>();
      const install = vi.spyOn(bridge, "install").mockReturnValueOnce(installed.promise);
      const start = bridge.ensureReady();
      const rejected = expect(start).rejects.toThrow();
      bridge.stop();
      installed.resolve(bridge.status());
      await rejected;
      expect(NodeFS.existsSync(starts)).toBe(false);
      expect(bridge.status().running).toBe(false);
      install.mockRestore();
      await bridge.ensureReady();
      expect(bridge.status().running).toBe(true);
    });
  });

  it("cancels a health check when signing out and never marks its child ready", async () => {
    const probe = Promise.withResolvers<void>();
    await withBridgeFixture(
      (_req, _res) => probe.resolve(),
      async ({ bridge }) => {
        const start = bridge.ensureReady();
        const rejected = expect(start).rejects.toThrow("cancelled");
        await probe.promise;
        expect(bridge.status().running).toBe(false);
        bridge.signOut();
        await rejected;
        expect(bridge.status()).toMatchObject({ running: false, authenticated: false });
      },
    );
  });

  it("reuses existing chat routes after reconnecting and shares concurrent recovery", async () => {
    await withBridgeFixture(healthyEndpoint, async ({ bridge, authFile, origin, starts }) => {
      const route = await bridge.hybridEnvironment("gpt-6-astra", origin);
      const url = `${route.environment.ANTHROPIC_BASE_URL}/v1/messages`;
      const post = (model: string) =>
        fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, messages: [] }),
        });
      bridge.signOut();
      expect(await (await post("opus")).json()).toEqual({ ok: true });
      const unavailable = await post("gpt-6-astra");
      expect(unavailable.status).toBe(502);
      await unavailable.text();
      // Simulate completed account reconnection; no new hybridEnvironment call.
      NodeFS.writeFileSync(
        authFile,
        JSON.stringify({ type: "codex", access_token: "new-fixture" }),
      );
      const responses = await Promise.all([
        post("gpt-6-astra"),
        post("gpt-6-astra"),
        post("gpt-6-astra"),
      ]);
      for (const response of responses) {
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
      }
      expect(NodeFS.readFileSync(starts, "utf8")).toBe("started\nstarted\n");
    });
  });
});
