import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodePath from "@effect/platform-node/NodePath";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  buildDesktopBundles,
  createBuildConfig,
  resolveDesktopBuildIconAssets,
  shouldResolveMacPasskeySigningConfiguration,
} from "../build-desktop-artifact.ts";
import { releasePackageFiles } from "../update-release-package-versions.ts";
import { TWO_CODE_PRODUCTION_PROFILE } from "./2code-desktop-distribution.ts";

it("uses the legacy 2code icon assets only for the production distribution", () => {
  assert.deepStrictEqual(resolveDesktopBuildIconAssets("1.0.109", TWO_CODE_PRODUCTION_PROFILE), {
    macIconPng: "distributions/2code/assets/icon.png",
    linuxIconPng: "distributions/2code/assets/icon.png",
    windowsIconIco: "distributions/2code/assets/icon.ico",
  });
  assert.deepStrictEqual(resolveDesktopBuildIconAssets("1.0.109"), {
    macIconPng: "assets/prod/black-macos-1024.png",
    linuxIconPng: "assets/prod/black-universal-1024.png",
    windowsIconIco: "assets/prod/t3-black-windows.ico",
  });
});

it.effect("builds a legacy-compatible 2code updater configuration", () =>
  Effect.gen(function* () {
    const config = yield* createBuildConfig(
      "mac",
      "dmg",
      "1.0.108",
      true,
      false,
      undefined,
      {
        entitlementsPath: "/tmp/entitlements.2code.mac.plist",
        entitlementsInheritPath: "/tmp/entitlements.2code.mac.plist",
      },
      false,
      TWO_CODE_PRODUCTION_PROFILE,
    );

    assert.equal(config.appId, "dev.hafencity.dev.agents");
    assert.equal(config.productName, "2code");
    assert.equal(config.artifactName, "2code-${version}-${arch}.${ext}");
    assert.deepStrictEqual(config.publish, [
      {
        provider: "generic",
        url: "https://pub-cb9e18e7e55d46cf9c297e4b612881f7.r2.dev/releases/desktop",
        updaterCacheDirName: "2code-updater",
      },
    ]);

    const mac = config.mac as Record<string, unknown>;
    assert.equal(mac.executableName, "2code");
    assert.equal(mac.artifactName, "2code-${version}-${arch}-mac.${ext}");
    assert.equal(mac.hardenedRuntime, true);
    assert.equal(mac.gatekeeperAssess, false);
    // Leave notarization enabled so electron-builder staples the app before it
    // derives the ZIP, DMG, blockmaps, and update-manifest hashes.
    assert.equal(mac.notarize, undefined);
    assert.equal(mac.forceCodeSigning, true);
    assert.deepStrictEqual(mac.target, ["dmg", "zip"]);
    assert.deepStrictEqual(config.dmg, {
      artifactName: "2code-${version}-${arch}.${ext}",
      sign: true,
      title: "2code 1.0.108 Installer",
      background: "dmg/dmg-background-latest.png",
      window: { width: 640, height: 432 },
      contents: [
        { x: 166, y: 214, type: "file" },
        { x: 474, y: 214, type: "link", path: "/Applications" },
      ],
      iconSize: 120,
      iconTextSize: 12,
    });
    assert.deepStrictEqual(mac.protocols, [
      {
        name: "2code",
        schemes: ["twentyfirst-agents"],
      },
      { name: "Web site URL", schemes: ["http", "https"], role: "Viewer" },
    ]);
    assert.equal(mac.entitlements, "/tmp/entitlements.2code.mac.plist");
    assert.equal(mac.entitlementsInherit, "/tmp/entitlements.2code.mac.plist");
    assert.notProperty(mac, "provisioningProfile");
  }).pipe(
    Effect.provide(
      Layer.merge(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })), NodePath.layer),
    ),
  ),
);

it("does not require the T3 passkey profile for a signed 2code production build", () => {
  assert.isFalse(
    shouldResolveMacPasskeySigningConfiguration("mac", true, TWO_CODE_PRODUCTION_PROFILE),
  );
  assert.isTrue(shouldResolveMacPasskeySigningConfiguration("mac", true, undefined));
  assert.isFalse(shouldResolveMacPasskeySigningConfiguration("mac", false, undefined));
});

it.effect("keeps GitHub update defaults when no fork distribution is selected", () =>
  Effect.gen(function* () {
    const config = yield* createBuildConfig(
      "mac",
      "dmg",
      "0.0.32",
      false,
      false,
      undefined,
      undefined,
    );

    assert.equal(config.appId, "com.t3tools.t3code");
    assert.equal(config.artifactName, "T3-Code-${version}-${arch}.${ext}");
    assert.deepStrictEqual(config.publish, [
      {
        provider: "github",
        owner: "pingdotgg",
        repo: "t3code",
        releaseType: "release",
      },
    ]);
    assert.notProperty(config.mac as Record<string, unknown>, "executableName");
  }).pipe(
    Effect.provide(
      Layer.merge(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { T3CODE_DESKTOP_UPDATE_REPOSITORY: "pingdotgg/t3code" },
          }),
        ),
        NodePath.layer,
      ),
    ),
  ),
);

// fork: the app release must not change the version used for remote server compatibility.
it.layer(NodeServices.layer)("2code bundle versions", (it) => {
  it.effect("builds with the upstream runtime and 2code release links", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "2code-bundle-version-" });
      yield* fs.writeFileString(
        path.join(root, "package.json"),
        JSON.stringify({
          name: "2code-build-fixture",
          scripts: { "build:desktop": "node build.cjs" },
        }),
      );
      for (const relativePath of releasePackageFiles) {
        const filePath = path.join(root, relativePath);
        yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
        yield* fs.writeFileString(filePath, JSON.stringify({ version: "0.1.0" }));
      }
      yield* fs.writeFileString(
        path.join(root, "build.cjs"),
        `
        require("node:fs").writeFileSync("built.json", JSON.stringify({
          runtime: process.env.APP_VERSION,
          server: require("./apps/server/package.json").version,
          web: require("./apps/web/package.json").version,
          desktop: require("./apps/desktop/package.json").version,
          repository: process.env.T3CODE_DESKTOP_UPDATE_REPOSITORY,
          tagPrefix: process.env.T3CODE_DESKTOP_UPDATE_TAG_PREFIX,
        }));
      `,
      );
      yield* buildDesktopBundles(root, "1.0.167", false, TWO_CODE_PRODUCTION_PROFILE);
      assert.deepStrictEqual(JSON.parse(yield* fs.readFileString(path.join(root, "built.json"))), {
        runtime: "0.1.0",
        server: "0.1.0",
        web: "0.1.0",
        desktop: "0.1.0",
        repository: "hafencity-dev/t3code",
        tagPrefix: "2code-v",
      });
      for (const relativePath of releasePackageFiles) {
        assert.equal(
          yield* fs.readFileString(path.join(root, relativePath)),
          JSON.stringify({ version: "0.1.0" }),
        );
      }
    }).pipe(Effect.scoped),
  );
});
