import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { currentPlatform, syncDirectory } from "./durableFs.ts";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof NodeFSP>()) }));

describe("syncDirectory", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fsyncs the directory everywhere except Windows, reading the platform per call", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "durable-fs-"));
    try {
      const open = vi.spyOn(NodeFSP, "open");
      await syncDirectory(dir, "linux");
      expect(open).toHaveBeenCalledWith(dir, "r");
      open.mockClear();
      await syncDirectory(dir, "win32");
      expect(open).not.toHaveBeenCalled();
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      try {
        expect(currentPlatform()).toBe("win32");
        await syncDirectory(dir);
        expect(open).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(process, "platform", descriptor);
      }
      await syncDirectory(dir);
      expect(open).toHaveBeenCalledTimes(currentPlatform() === "win32" ? 0 : 1);
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });
});
