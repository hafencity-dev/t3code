#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Linux artifact verification inspects the AppImage directly in CI.

import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { verifyAppUpdateConfiguration } from "./app-update-config.ts";
import {
  digestFile,
  expectedLinuxArtifactNames,
  LINUX_PLATFORM_LABEL,
  readManifest,
  readReleaseConfig,
  type TwoCodeReleaseConfig,
} from "./release-core.ts";

const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46] as const;
const ELF_CLASS_64 = 2;
const ELF_DATA_LITTLE_ENDIAN = 1;
const ELF_MACHINE_AARCH64 = 183;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function run(command: string, args: readonly string[], cwd: string): void {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(
      `${command} failed: ${(result.stderr || result.stdout || String(result.error ?? "")).trim()}`,
    );
  }
}

async function readFileHeader(filePath: string, length: number): Promise<Uint8Array> {
  const handle = await NodeFSP.open(filePath, "r");
  try {
    const buffer = new Uint8Array(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Every native piece of the AppImage must be a 64-bit little-endian aarch64 ELF. */
export function verifyElfArchitecture(header: Uint8Array, artifactLabel: string): void {
  if (header.length < 20 || ELF_MAGIC.some((byte, index) => header[index] !== byte)) {
    throw new Error(`${artifactLabel} is not an ELF executable.`);
  }
  if (header[4] !== ELF_CLASS_64 || header[5] !== ELF_DATA_LITTLE_ENDIAN) {
    throw new Error(`${artifactLabel} is not a 64-bit little-endian ELF executable.`);
  }
  const machine = (header[18] ?? 0) | ((header[19] ?? 0) << 8);
  if (machine !== ELF_MACHINE_AARCH64) {
    throw new Error(`${artifactLabel} is not an aarch64 executable (e_machine ${machine}).`);
  }
}

export function verifyPngSignature(header: Uint8Array, artifactLabel: string): void {
  if (header.length < 8 || PNG_SIGNATURE.some((byte, index) => header[index] !== byte)) {
    throw new Error(`${artifactLabel} is not a PNG image.`);
  }
}

/** The AppImage's desktop entry is what desktops use to route `twentyfirst-agents://` links. */
export function verifyDesktopEntry(config: TwoCodeReleaseConfig, raw: string): void {
  const entries = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9-]+)=(.*)$/.exec(line);
    if (match?.[1] && match[2] !== undefined) entries.set(match[1], match[2]);
  }
  if (entries.get("Name") !== config.productName) {
    throw new Error(`Desktop entry Name must be ${config.productName}.`);
  }
  if (!/(^|\s)%U(\s|$)/.test(entries.get("Exec") ?? "")) {
    throw new Error("Desktop entry Exec must accept URLs (%U) so protocol launches reach the app.");
  }
  const mimeTypes = (entries.get("MimeType") ?? "").split(";").filter((entry) => entry !== "");
  for (const scheme of config.protocolSchemes) {
    if (!mimeTypes.includes(`x-scheme-handler/${scheme}`)) {
      throw new Error(`Desktop entry must register x-scheme-handler/${scheme}.`);
    }
  }
  if (entries.get("X-AppImage-Version") !== config.version) {
    throw new Error(`Desktop entry X-AppImage-Version must be ${config.version}.`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const artifactIndex = args.indexOf("--artifact-dir");
  const configIndex = args.indexOf("--config");
  const artifactDirectory = artifactIndex >= 0 ? args[artifactIndex + 1] : undefined;
  const configPath = configIndex >= 0 ? args[configIndex + 1] : "distributions/2code/release.json";
  if (!artifactDirectory) throw new Error("--artifact-dir is required.");

  const config = await readReleaseConfig(configPath);
  const [appImageName] = expectedLinuxArtifactNames(config);
  const appImagePath = NodePath.resolve(artifactDirectory, appImageName);
  const manifestPath = NodePath.resolve(artifactDirectory, config.linuxManifestName);
  const manifest = readManifest(
    await NodeFSP.readFile(manifestPath, "utf8"),
    manifestPath,
    LINUX_PLATFORM_LABEL,
  );
  if (manifest.version !== config.version) {
    throw new Error(
      `${config.linuxManifestName} is version ${manifest.version}, not ${config.version}.`,
    );
  }
  const [file, ...extraFiles] = manifest.files;
  if (!file || extraFiles.length > 0 || file.url !== appImageName) {
    throw new Error(`${config.linuxManifestName} must reference exactly ${appImageName}.`);
  }
  const digest = await digestFile(appImagePath);
  if (file.sha512 !== digest.sha512 || file.size !== digest.size) {
    throw new Error(`${appImageName} does not match its ${config.linuxManifestName} hash/size.`);
  }
  // AppImages carry their blockmap inside the file; without its size the updater
  // silently falls back to downloading the whole artifact on every update.
  if (file.blockMapSize === undefined || file.blockMapSize <= 0) {
    throw new Error(`${config.linuxManifestName} must advertise the embedded blockmap size.`);
  }
  verifyElfArchitecture(await readFileHeader(appImagePath, 20), appImageName);

  const temporaryDirectory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "2code-linux-verify-"),
  );
  try {
    await NodeFSP.chmod(appImagePath, 0o755);
    // The runtime extracts without FUSE, which CI runners do not provide.
    run(appImagePath, ["--appimage-extract"], temporaryDirectory);
    const root = NodePath.join(temporaryDirectory, "squashfs-root");

    verifyDesktopEntry(
      config,
      await NodeFSP.readFile(NodePath.join(root, `${config.executableName}.desktop`), "utf8"),
    );
    for (const relativePath of [
      config.executableName,
      "resources/resource-monitor/t3-resource-monitor",
      "resources/browser-secret/t3-browser-secret",
    ]) {
      verifyElfArchitecture(
        await readFileHeader(NodePath.join(root, relativePath), 20),
        relativePath,
      );
    }
    verifyAppUpdateConfiguration(
      config,
      await NodeFSP.readFile(NodePath.join(root, "resources", "app-update.yml"), "utf8"),
    );
    await NodeFSP.access(NodePath.join(root, "resources", "app.asar"));
    verifyPngSignature(
      await readFileHeader(NodePath.join(root, `${config.productName}.png`), 8),
      `${config.productName}.png`,
    );
    console.log(
      `Verified ${config.productName} ${config.version} Linux arm64 AppImage (${config.appId}, ${appImageName}).`,
    );
  } finally {
    await NodeFSP.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
