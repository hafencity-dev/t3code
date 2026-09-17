import { assert, describe, it } from "@effect/vitest";

import { parseReleaseConfig } from "./release-core.ts";
import { verifyDesktopEntry, verifyElfArchitecture, verifyPngSignature } from "./verify-linux.ts";

const config = parseReleaseConfig({
  schemaVersion: 1,
  version: "1.0.108",
  distribution: "2code-production",
  releaseBranch: "main-2code",
  githubRepository: "hafencity-dev/t3code",
  githubTagPrefix: "2code-v",
  appId: "dev.hafencity.dev.agents",
  productName: "2code",
  executableName: "2code",
  architecture: "arm64",
  teamId: "D78YC33UVC",
  feedUrl: "https://updates.example.com/releases/desktop",
  r2Bucket: "2code",
  r2Prefix: "releases/desktop",
  manifestName: "latest-mac.yml",
  betaManifestName: "beta-mac.yml",
  linuxManifestName: "latest-linux-arm64.yml",
  linuxBetaManifestName: "beta-linux-arm64.yml",
  updaterCacheDirName: "2code-updater",
  protocolSchemes: ["twentyfirst-agents"],
  stagingPercentage: 100,
  minimumLegacyVersion: "1.0.107",
});

function elfHeader(machine: number, elfClass = 2, data = 1): Uint8Array {
  const header = new Uint8Array(20);
  header.set([0x7f, 0x45, 0x4c, 0x46, elfClass, data, 1]);
  header[18] = machine & 0xff;
  header[19] = machine >> 8;
  return header;
}

const desktopEntry = `[Desktop Entry]
Name=2code
Exec=AppRun --no-sandbox %U
Terminal=false
Type=Application
Icon=2code
X-AppImage-Version=1.0.108
MimeType=x-scheme-handler/twentyfirst-agents;
Categories=Development;
`;

describe("2code Linux verification", () => {
  it("accepts only 64-bit little-endian aarch64 ELF executables", () => {
    verifyElfArchitecture(elfHeader(183), "AppImage");
    assert.throws(() => verifyElfArchitecture(elfHeader(62), "AppImage"), /not an aarch64/);
    assert.throws(() => verifyElfArchitecture(elfHeader(183, 1), "AppImage"), /64-bit/);
    assert.throws(() => verifyElfArchitecture(elfHeader(183, 2, 2), "AppImage"), /little-endian/);
    assert.throws(() => verifyElfArchitecture(new Uint8Array([1, 2, 3]), "AppImage"), /not an ELF/);
  });

  it("requires the desktop entry to route legacy protocol links to the released version", () => {
    verifyDesktopEntry(config, desktopEntry);
    assert.throws(() => verifyDesktopEntry(config, desktopEntry.replace("%U", "")), /accept URLs/);
    assert.throws(
      () => verifyDesktopEntry(config, desktopEntry.replace("twentyfirst-agents", "t3code")),
      /x-scheme-handler\/twentyfirst-agents/,
    );
    assert.throws(
      () => verifyDesktopEntry(config, desktopEntry.replace("1.0.108", "1.0.107")),
      /X-AppImage-Version/,
    );
    assert.throws(
      () => verifyDesktopEntry(config, desktopEntry.replace("Name=2code", "Name=T3 Code")),
      /Name/,
    );
  });

  it("recognizes PNG artwork by signature", () => {
    verifyPngSignature(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), "icon");
    assert.throws(
      () => verifyPngSignature(new Uint8Array([0x47, 0x49, 0x46]), "icon"),
      /not a PNG/,
    );
  });
});
