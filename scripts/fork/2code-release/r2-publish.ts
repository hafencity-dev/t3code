#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - Production publishing is an explicitly guarded host-side CI tool.

import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

import { serializeUpdateManifest, type UpdateManifest } from "../../lib/update-manifest.ts";

import {
  compareStableVersions,
  contentTypeFor,
  digestFile,
  LINUX_PLATFORM_LABEL,
  MAC_PLATFORM_LABEL,
  manifestStagingPercentage,
  readManifest,
  readReleaseConfig,
  serializeManifestWithRollout,
  sha512Base64,
  sha512Hex,
  verifyPreparedArtifacts,
  type TwoCodeReleaseConfig,
  type TwoCodeReleasePlan,
} from "./release-core.ts";

interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface CliArguments {
  readonly command: "publish" | "resume" | "promote" | "recover";
  readonly configPath: string;
  readonly artifactDirectory: string | undefined;
  readonly stagingPercentage: number | undefined;
  readonly recoveryVersion: string | undefined;
}

export function releaseObjectKey(config: TwoCodeReleaseConfig, relativePath: string): string {
  if (
    relativePath.startsWith("/") ||
    relativePath.endsWith("/") ||
    relativePath.includes("//") ||
    relativePath.split("/").some((segment) => segment === "." || segment === ".." || segment === "")
  ) {
    throw new Error(`Unsafe R2 release path '${relativePath}'.`);
  }
  return `${config.r2Prefix}/${relativePath}`;
}

export function publicObjectUrl(config: TwoCodeReleaseConfig, relativePath: string): string {
  const encodedPath = relativePath.split("/").map(encodeURIComponent).join("/");
  return `${config.feedUrl}/${encodedPath}`;
}

export function rollbackObjectPath(input: {
  readonly releaseVersion: string;
  readonly previousVersion: string;
  readonly previousManifest: string;
}): string {
  return `rollbacks/${input.releaseVersion}/from-${input.previousVersion}-${sha512Hex(input.previousManifest)}.yml`;
}

export function immutableManifestPath(version: string, manifest: string): string {
  return `manifests/${version}/${sha512Hex(manifest)}.yml`;
}

export type ReleaseChannel = "latest" | "beta";

export interface ReleaseTarget {
  readonly key: "mac" | "linux";
  readonly platformLabel: string;
  readonly manifestName: string;
  readonly betaManifestName: string;
  /** The payload every channel manifest must keep; other entries are optional installers. */
  readonly updaterExtension: ".zip" | ".AppImage";
  /** Whether updater payloads ship a sidecar `.blockmap`; AppImages embed theirs. */
  readonly blockmapSidecar: boolean;
}

/** Ordered so every mutation ends with the macOS stable pointer, as before Linux existed. */
export function releaseTargets(
  config: TwoCodeReleaseConfig,
): readonly [ReleaseTarget, ReleaseTarget] {
  return [
    {
      key: "linux",
      platformLabel: LINUX_PLATFORM_LABEL,
      manifestName: config.linuxManifestName,
      betaManifestName: config.linuxBetaManifestName,
      updaterExtension: ".AppImage",
      blockmapSidecar: false,
    },
    {
      key: "mac",
      platformLabel: MAC_PLATFORM_LABEL,
      manifestName: config.manifestName,
      betaManifestName: config.betaManifestName,
      updaterExtension: ".zip",
      blockmapSidecar: true,
    },
  ];
}

/** macOS keeps its historical `rollbacks/<version>/<channel>/` namespace; Linux gets its own. */
export function rollbackChannelSegment(target: ReleaseTarget, channel: ReleaseChannel): string {
  return target.key === "mac" ? channel : `${target.key}-${channel}`;
}

function parseArguments(argv: readonly string[]): CliArguments {
  const [rawCommand, ...rest] = argv;
  if (
    rawCommand !== "publish" &&
    rawCommand !== "resume" &&
    rawCommand !== "promote" &&
    rawCommand !== "recover"
  ) {
    throw new Error("Expected command publish, resume, promote, or recover.");
  }
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid argument sequence near '${key ?? "<end>"}'.`);
    }
    values.set(key.slice(2), value);
  }
  const stagingRaw = values.get("staging-percentage");
  let stagingPercentage: number | undefined;
  if (stagingRaw !== undefined) {
    if (!/^\d+$/.test(stagingRaw)) throw new Error("staging-percentage must be an integer.");
    stagingPercentage = Number(stagingRaw);
    if (stagingPercentage < 1 || stagingPercentage > 100) {
      throw new Error("staging-percentage must be between 1 and 100.");
    }
  }
  return {
    command: rawCommand,
    configPath: values.get("config") ?? "distributions/2code/release.json",
    artifactDirectory: values.get("artifact-dir"),
    stagingPercentage,
    recoveryVersion: values.get("recovery-version"),
  };
}

function runCommand(command: string, args: readonly string[], allowFailure = false): CommandResult {
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const status = result.status ?? 1;
  const output = {
    status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? String(result.error) : ""),
  };
  if (!allowFailure && status !== 0) {
    throw new Error(
      `${command} failed with exit code ${status}: ${(output.stderr || output.stdout).trim()}`,
    );
  }
  return output;
}

function requirePublishGuard(config: TwoCodeReleaseConfig): void {
  const required = [
    ["GITHUB_ACTIONS", "true"],
    ["GITHUB_REPOSITORY", config.githubRepository],
    ["GITHUB_REF_NAME", config.releaseBranch],
    ["T3CODE_2CODE_ALLOW_R2_PUBLISH", "I_UNDERSTAND_THIS_UPDATES_2CODE"],
  ] as const;
  for (const [name, expected] of required) {
    if (process.env[name] !== expected) {
      throw new Error(`Refusing R2 mutation: ${name} must equal '${expected}'.`);
    }
  }
  if (!process.env.AWS_ENDPOINT_URL?.startsWith("https://")) {
    throw new Error("Refusing R2 mutation: AWS_ENDPOINT_URL must be configured with HTTPS.");
  }
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    throw new Error("Refusing R2 mutation: R2 credentials are missing.");
  }
}

function awsArgs(config: TwoCodeReleaseConfig, args: readonly string[]): string[] {
  const endpoint = process.env.AWS_ENDPOINT_URL;
  if (!endpoint) throw new Error("AWS_ENDPOINT_URL is required.");
  return [...args, "--endpoint-url", endpoint];
}

function isMissingObject(result: CommandResult): boolean {
  return /(?:404|Not Found|NoSuchKey)/i.test(`${result.stderr}\n${result.stdout}`);
}

async function immutableObjectExists(
  config: TwoCodeReleaseConfig,
  relativePath: string,
): Promise<boolean> {
  const result = runCommand(
    "aws",
    awsArgs(config, [
      "s3api",
      "head-object",
      "--bucket",
      config.r2Bucket,
      "--key",
      releaseObjectKey(config, relativePath),
    ]),
    true,
  );
  if (result.status === 0) return true;
  if (isMissingObject(result)) return false;
  throw new Error(`Could not determine whether R2 object exists: ${result.stderr.trim()}`);
}

async function uploadImmutable(input: {
  readonly config: TwoCodeReleaseConfig;
  readonly relativePath: string;
  readonly localPath: string;
  readonly contentType: string;
  readonly temporaryDirectory: string;
}): Promise<void> {
  const localDigest = await digestFile(input.localPath);
  const objectUri = `s3://${input.config.r2Bucket}/${releaseObjectKey(input.config, input.relativePath)}`;
  if (await immutableObjectExists(input.config, input.relativePath)) {
    const remotePath = NodePath.join(
      input.temporaryDirectory,
      `existing-${NodeCrypto.randomUUID()}-${NodePath.basename(input.relativePath)}`,
    );
    runCommand("aws", awsArgs(input.config, ["s3", "cp", objectUri, remotePath, "--no-progress"]));
    const remoteDigest = await digestFile(remotePath);
    if (remoteDigest.sha512 !== localDigest.sha512 || remoteDigest.size !== localDigest.size) {
      throw new Error(
        `Immutable R2 object collision at ${input.relativePath}; refusing overwrite.`,
      );
    }
    console.log(`Immutable object already matches: ${input.relativePath}`);
    return;
  }

  runCommand(
    "aws",
    awsArgs(input.config, [
      "s3",
      "cp",
      input.localPath,
      objectUri,
      "--content-type",
      input.contentType,
      "--cache-control",
      "public,max-age=31536000,immutable",
      "--metadata",
      `sha512=${localDigest.sha512Hex}`,
      "--no-progress",
    ]),
  );
}

async function downloadPublicObject(input: {
  readonly config: TwoCodeReleaseConfig;
  readonly relativePath: string;
  readonly destination: string;
}): Promise<void> {
  const url = new URL(publicObjectUrl(input.config, input.relativePath));
  url.searchParams.set(
    "verify",
    `${process.env.GITHUB_RUN_ID ?? Date.now()}-${NodeCrypto.randomUUID()}`,
  );
  const result = runCommand(
    "curl",
    [
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--retry",
      "4",
      "--retry-all-errors",
      "--output",
      input.destination,
      url.href,
    ],
    true,
  );
  if (result.status === 0) return;
  throw new Error(
    `Could not download public R2 object ${input.relativePath}: ${result.stderr.trim()}`,
  );
}

async function downloadPublicObjectIfPresent(input: {
  readonly config: TwoCodeReleaseConfig;
  readonly relativePath: string;
  readonly destination: string;
}): Promise<boolean> {
  const url = new URL(publicObjectUrl(input.config, input.relativePath));
  url.searchParams.set(
    "verify",
    `${process.env.GITHUB_RUN_ID ?? Date.now()}-${NodeCrypto.randomUUID()}`,
  );
  const result = runCommand(
    "curl",
    [
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--retry",
      "4",
      "--retry-all-errors",
      "--output",
      input.destination,
      url.href,
    ],
    true,
  );
  if (result.status === 0) return true;
  if (/\b404\b/.test(`${result.stderr}\n${result.stdout}`)) return false;
  throw new Error(
    `Could not inspect public R2 object ${input.relativePath}: ${result.stderr.trim()}`,
  );
}

async function verifyPublicObject(input: {
  readonly config: TwoCodeReleaseConfig;
  readonly relativePath: string;
  readonly expectedSha512: string;
  readonly expectedSize?: number;
  readonly temporaryDirectory: string;
}): Promise<void> {
  const destination = NodePath.join(
    input.temporaryDirectory,
    `public-${NodeCrypto.randomUUID()}-${NodePath.basename(input.relativePath)}`,
  );
  await downloadPublicObject({
    config: input.config,
    relativePath: input.relativePath,
    destination,
  });
  const digest = await digestFile(destination);
  if (
    digest.sha512 !== input.expectedSha512 ||
    (input.expectedSize !== undefined && digest.size !== input.expectedSize)
  ) {
    throw new Error(`Public R2 verification failed for ${input.relativePath}.`);
  }
}

async function uploadMutableManifest(input: {
  readonly config: TwoCodeReleaseConfig;
  readonly relativePath: string;
  readonly localPath: string;
}): Promise<void> {
  runCommand(
    "aws",
    awsArgs(input.config, [
      "s3",
      "cp",
      input.localPath,
      `s3://${input.config.r2Bucket}/${releaseObjectKey(input.config, input.relativePath)}`,
      "--content-type",
      "application/yaml",
      "--cache-control",
      "no-cache,no-store,must-revalidate",
      "--no-progress",
    ]),
  );
}

async function writeTemporaryManifest(
  directory: string,
  name: string,
  contents: string,
): Promise<string> {
  const target = NodePath.join(directory, name);
  await NodeFSP.writeFile(target, contents, "utf8");
  return target;
}

async function fetchChannelManifest(
  config: TwoCodeReleaseConfig,
  manifestName: string,
  temporaryDirectory: string,
): Promise<{
  raw: string;
  path: string;
}> {
  const path = NodePath.join(temporaryDirectory, `live-${manifestName}`);
  await downloadPublicObject({ config, relativePath: manifestName, destination: path });
  return { raw: await NodeFSP.readFile(path, "utf8"), path };
}

async function fetchChannelManifestIfPresent(
  config: TwoCodeReleaseConfig,
  manifestName: string,
  temporaryDirectory: string,
): Promise<{ raw: string; path: string } | undefined> {
  const path = NodePath.join(temporaryDirectory, `live-${manifestName}`);
  const present = await downloadPublicObjectIfPresent({
    config,
    relativePath: manifestName,
    destination: path,
  });
  if (!present) return undefined;
  return { raw: await NodeFSP.readFile(path, "utf8"), path };
}

interface LiveChannel {
  readonly name: ReleaseChannel;
  readonly raw: string;
  readonly path: string;
  readonly manifest: UpdateManifest;
}

async function fetchLiveChannels(input: {
  readonly config: TwoCodeReleaseConfig;
  readonly target: ReleaseTarget;
  readonly temporaryDirectory: string;
  readonly allowMissing: boolean;
}): Promise<readonly LiveChannel[]> {
  const channels: LiveChannel[] = [];
  const names = [
    ["latest", input.target.manifestName],
    ["beta", input.target.betaManifestName],
  ] as const;
  for (const [name, manifestName] of names) {
    const live = input.allowMissing
      ? await fetchChannelManifestIfPresent(input.config, manifestName, input.temporaryDirectory)
      : await fetchChannelManifest(input.config, manifestName, input.temporaryDirectory);
    if (!live) {
      console.log(
        `Live ${input.target.key} ${name} manifest ${manifestName} is not published yet.`,
      );
      continue;
    }
    channels.push({
      name,
      ...live,
      manifest: readManifest(live.raw, live.path, input.target.platformLabel),
    });
  }
  return channels;
}

function planManifest(
  plan: TwoCodeReleasePlan,
  target: ReleaseTarget,
): { readonly name: string; readonly sha512: string } {
  return target.key === "mac"
    ? { name: plan.manifestName, sha512: plan.manifestSha512 }
    : { name: plan.linuxManifestName, sha512: plan.linuxManifestSha512 };
}

async function activateManifests(input: {
  readonly config: TwoCodeReleaseConfig;
  readonly target: ReleaseTarget;
  readonly latestPath: string;
  readonly latestRaw: string;
  readonly betaPath: string;
  readonly betaRaw: string;
  readonly temporaryDirectory: string;
}): Promise<void> {
  // Keep beta compatibility first. The stable pointer is deliberately the final mutation.
  await uploadMutableManifest({
    config: input.config,
    relativePath: input.target.betaManifestName,
    localPath: input.betaPath,
  });
  await verifyPublicObject({
    config: input.config,
    relativePath: input.target.betaManifestName,
    expectedSha512: sha512Base64(input.betaRaw),
    expectedSize: Buffer.byteLength(input.betaRaw),
    temporaryDirectory: input.temporaryDirectory,
  });
  await uploadMutableManifest({
    config: input.config,
    relativePath: input.target.manifestName,
    localPath: input.latestPath,
  });
  await verifyPublicObject({
    config: input.config,
    relativePath: input.target.manifestName,
    expectedSha512: sha512Base64(input.latestRaw),
    expectedSize: Buffer.byteLength(input.latestRaw),
    temporaryDirectory: input.temporaryDirectory,
  });
}

async function prepareSelfContainedRollback(input: {
  readonly config: TwoCodeReleaseConfig;
  readonly target: ReleaseTarget;
  readonly releaseVersion: string;
  readonly channel: ReleaseChannel;
  readonly liveRaw: string;
  readonly livePath: string;
  readonly temporaryDirectory: string;
}): Promise<{ readonly raw: string; readonly path: string }> {
  const label = `${input.target.key} ${input.channel}`;
  const liveManifest = readManifest(input.liveRaw, input.livePath, input.target.platformLabel);
  const files = [];
  let hasUpdaterPayload = false;
  for (const file of liveManifest.files) {
    releaseObjectKey(input.config, file.url);
    const localName = NodePath.basename(file.url);
    const localPath = NodePath.join(
      input.temporaryDirectory,
      `rollback-payload-${input.target.key}-${input.channel}-${NodeCrypto.randomUUID()}-${localName}`,
    );
    const present = await downloadPublicObjectIfPresent({
      config: input.config,
      relativePath: file.url,
      destination: localPath,
    });
    if (!present) {
      if (localName.endsWith(".dmg")) {
        console.log(
          `Legacy ${label} manifest references missing optional DMG ${file.url}; excluding it from recovery.`,
        );
        continue;
      }
      throw new Error(
        `Cannot archive ${label}: updater payload ${file.url} is not publicly available.`,
      );
    }
    const digest = await digestFile(localPath);
    if (digest.sha512 !== file.sha512 || digest.size !== file.size) {
      throw new Error(`Cannot archive ${label}: ${file.url} fails its manifest hash/size.`);
    }
    const remotePath = `objects/${digest.sha512Hex}/${localName}`;
    await uploadImmutable({
      config: input.config,
      relativePath: remotePath,
      localPath,
      contentType: contentTypeFor(localName),
      temporaryDirectory: input.temporaryDirectory,
    });
    await verifyPublicObject({
      config: input.config,
      relativePath: remotePath,
      expectedSha512: digest.sha512,
      expectedSize: digest.size,
      temporaryDirectory: input.temporaryDirectory,
    });

    const sourceBlockmap = `${file.url}.blockmap`;
    const blockmapPath = `${localPath}.blockmap`;
    const blockmapPresent = await downloadPublicObjectIfPresent({
      config: input.config,
      relativePath: sourceBlockmap,
      destination: blockmapPath,
    });
    if (
      !blockmapPresent &&
      input.target.blockmapSidecar &&
      localName.endsWith(input.target.updaterExtension)
    ) {
      throw new Error(
        `Cannot archive ${label}: updater blockmap ${sourceBlockmap} is unavailable.`,
      );
    }
    if (blockmapPresent) {
      const blockmapDigest = await digestFile(blockmapPath);
      await uploadImmutable({
        config: input.config,
        relativePath: `${remotePath}.blockmap`,
        localPath: blockmapPath,
        contentType: "application/octet-stream",
        temporaryDirectory: input.temporaryDirectory,
      });
      await verifyPublicObject({
        config: input.config,
        relativePath: `${remotePath}.blockmap`,
        expectedSha512: blockmapDigest.sha512,
        expectedSize: blockmapDigest.size,
        temporaryDirectory: input.temporaryDirectory,
      });
    }
    hasUpdaterPayload ||= localName.endsWith(input.target.updaterExtension);
    files.push({
      url: remotePath,
      sha512: file.sha512,
      size: file.size,
      ...(file.blockMapSize === undefined ? {} : { blockMapSize: file.blockMapSize }),
    });
  }
  if (!hasUpdaterPayload) {
    throw new Error(
      `Cannot archive ${label}: no verified ${input.target.updaterExtension} updater payload remains.`,
    );
  }

  const raw = serializeUpdateManifest(
    { ...liveManifest, files },
    { platformLabel: `${input.target.platformLabel} ${input.channel} rollback` },
  );
  const path = await writeTemporaryManifest(
    input.temporaryDirectory,
    `rollback-${input.releaseVersion}-${input.target.key}-${input.channel}.yml`,
    raw,
  );
  const immutablePath = immutableManifestPath(liveManifest.version, raw);
  await uploadImmutable({
    config: input.config,
    relativePath: immutablePath,
    localPath: path,
    contentType: "application/yaml",
    temporaryDirectory: input.temporaryDirectory,
  });
  await verifyPublicObject({
    config: input.config,
    relativePath: immutablePath,
    expectedSha512: sha512Base64(raw),
    expectedSize: Buffer.byteLength(raw),
    temporaryDirectory: input.temporaryDirectory,
  });
  return { raw, path };
}

async function publishRelease(
  config: TwoCodeReleaseConfig,
  artifactDirectory: string,
  temporaryDirectory: string,
): Promise<void> {
  const plan = await verifyPreparedArtifacts({ config, artifactDirectory });
  const targets = releaseTargets(config);

  const liveByTarget = new Map<ReleaseTarget["key"], readonly LiveChannel[]>();
  for (const target of targets) {
    // The macOS channels are the release state machine and must exist. The Linux
    // channels follow them and may still be absent before the first Linux release.
    const channels = await fetchLiveChannels({
      config,
      target,
      temporaryDirectory,
      allowMissing: target.key === "linux",
    });
    const candidate = planManifest(plan, target);
    for (const channel of channels) {
      const comparison = compareStableVersions(plan.version, channel.manifest.version);
      if (comparison < 0) {
        throw new Error(
          `Refusing to publish ${plan.version} over newer live ${target.key} ${channel.name} version ${channel.manifest.version}.`,
        );
      }
      if (comparison === 0 && sha512Base64(channel.raw) !== candidate.sha512) {
        if (target.key === "mac") {
          throw new Error(
            `Live ${channel.name} 2code ${plan.version} has a different manifest; refusing same-version replacement.`,
          );
        }
        // Linux pointers move before the macOS pointers, so a Linux channel that already
        // carries this version while macOS does not is the residue of an interrupted run.
        // The fresh candidate is an equally verified build of the same version.
        console.log(
          `Linux ${channel.name} already carries 2code ${plan.version} from an interrupted run; replacing it with the verified candidate.`,
        );
      }
    }
    liveByTarget.set(target.key, channels);
  }

  const macChannels = liveByTarget.get("mac") ?? [];
  if (macChannels.every((channel) => channel.manifest.version === plan.version)) {
    if (macChannels.every((channel) => sha512Base64(channel.raw) === plan.manifestSha512)) {
      console.log(`2code ${plan.version} is already live with the identical manifest.`);
      return;
    }
    throw new Error(
      `2code ${plan.version} is only partially active across latest/beta; recovery is required.`,
    );
  }

  for (const payload of plan.payloads) {
    const localPath = NodePath.join(artifactDirectory, payload.localName);
    await uploadImmutable({
      config,
      relativePath: payload.remotePath,
      localPath,
      contentType: payload.contentType,
      temporaryDirectory,
    });
    await verifyPublicObject({
      config,
      relativePath: payload.remotePath,
      expectedSha512: payload.sha512,
      expectedSize: payload.size,
      temporaryDirectory,
    });
  }

  const candidates = new Map<
    ReleaseTarget["key"],
    { readonly path: string; readonly raw: string }
  >();
  for (const target of targets) {
    const candidate = planManifest(plan, target);
    const manifestPath = NodePath.join(artifactDirectory, candidate.name);
    const manifestRaw = await NodeFSP.readFile(manifestPath, "utf8");
    const immutableCandidatePath = immutableManifestPath(plan.version, manifestRaw);
    await uploadImmutable({
      config,
      relativePath: immutableCandidatePath,
      localPath: manifestPath,
      contentType: "application/yaml",
      temporaryDirectory,
    });
    await verifyPublicObject({
      config,
      relativePath: immutableCandidatePath,
      expectedSha512: candidate.sha512,
      expectedSize: Buffer.byteLength(manifestRaw),
      temporaryDirectory,
    });
    candidates.set(target.key, { path: manifestPath, raw: manifestRaw });
  }

  for (const target of targets) {
    for (const channel of liveByTarget.get(target.key) ?? []) {
      if (channel.manifest.version === plan.version) continue;
      const rollback = await prepareSelfContainedRollback({
        config,
        target,
        releaseVersion: plan.version,
        channel: channel.name,
        liveRaw: channel.raw,
        livePath: channel.path,
        temporaryDirectory,
      });
      await uploadImmutable({
        config,
        relativePath: `rollbacks/${plan.version}/${rollbackChannelSegment(target, channel.name)}/${NodePath.basename(
          rollbackObjectPath({
            releaseVersion: plan.version,
            previousVersion: channel.manifest.version,
            previousManifest: rollback.raw,
          }),
        )}`,
        localPath: rollback.path,
        contentType: "application/yaml",
        temporaryDirectory,
      });
    }
  }

  // Targets are ordered so the macOS stable pointer remains the final mutation.
  for (const target of targets) {
    const candidate = candidates.get(target.key);
    if (!candidate) throw new Error(`Missing prepared ${target.key} candidate manifest.`);
    await activateManifests({
      config,
      target,
      latestPath: candidate.path,
      latestRaw: candidate.raw,
      betaPath: candidate.path,
      betaRaw: candidate.raw,
      temporaryDirectory,
    });
  }
  console.log(`Published 2code ${plan.version} at ${plan.stagingPercentage}%.`);
}

async function verifyContentAddressedManifest(input: {
  readonly config: TwoCodeReleaseConfig;
  readonly target: ReleaseTarget;
  readonly raw: string;
  readonly sourcePath: string;
  readonly expectedVersion: string;
  readonly temporaryDirectory: string;
}): Promise<void> {
  const manifest = readManifest(input.raw, input.sourcePath, input.target.platformLabel);
  if (manifest.version !== input.expectedVersion) {
    throw new Error(
      `Manifest is ${manifest.version}, not expected version ${input.expectedVersion}.`,
    );
  }
  for (const file of manifest.files) {
    releaseObjectKey(input.config, file.url);
    const match = /^objects\/([a-f0-9]{128})\/([^/]+)$/.exec(file.url);
    const digestHex = Buffer.from(file.sha512, "base64").toString("hex");
    if (!match?.[1] || match[1] !== digestHex) {
      throw new Error(`Live candidate payload '${file.url}' is not content-addressed by SHA-512.`);
    }
    await verifyPublicObject({
      config: input.config,
      relativePath: file.url,
      expectedSha512: file.sha512,
      expectedSize: file.size,
      temporaryDirectory: input.temporaryDirectory,
    });
    if (!input.target.blockmapSidecar) continue;
    const blockmapPath = NodePath.join(
      input.temporaryDirectory,
      `verify-blockmap-${NodeCrypto.randomUUID()}`,
    );
    await downloadPublicObject({
      config: input.config,
      relativePath: `${file.url}.blockmap`,
      destination: blockmapPath,
    });
    if ((await digestFile(blockmapPath)).size === 0) {
      throw new Error(`Public updater blockmap ${file.url}.blockmap is empty.`);
    }
  }
  const immutablePath = immutableManifestPath(input.expectedVersion, input.raw);
  await verifyPublicObject({
    config: input.config,
    relativePath: immutablePath,
    expectedSha512: sha512Base64(input.raw),
    expectedSize: Buffer.byteLength(input.raw),
    temporaryDirectory: input.temporaryDirectory,
  });
}

/**
 * Rollback snapshots a channel must carry for a version. macOS always archives the
 * previous manifest; Linux has none for the release that first introduced its channels.
 */
function expectedRollbackCounts(target: ReleaseTarget): readonly number[] {
  return target.key === "mac" ? [1] : [0, 1];
}

async function resumeRelease(
  config: TwoCodeReleaseConfig,
  temporaryDirectory: string,
): Promise<void> {
  const resumed: Array<{ readonly target: ReleaseTarget; readonly candidate: LiveChannel }> = [];
  for (const target of releaseTargets(config)) {
    const channels = await fetchLiveChannels({
      config,
      target,
      temporaryDirectory,
      allowMissing: false,
    });
    const candidates = channels.filter((channel) => channel.manifest.version === config.version);
    if (candidates.length === 0) {
      throw new Error(
        `No live ${target.key} channel contains interrupted 2code candidate ${config.version}.`,
      );
    }
    const candidate = candidates[0];
    if (!candidate) throw new Error(`Interrupted 2code ${target.key} candidate is missing.`);
    if (candidates.some((channel) => channel.raw !== candidate.raw)) {
      throw new Error(
        `Live 2code ${config.version} ${target.key} channels contain different candidate bytes.`,
      );
    }
    for (const channel of channels) {
      if (
        channel.manifest.version !== config.version &&
        compareStableVersions(channel.manifest.version, config.version) >= 0
      ) {
        throw new Error(
          `Cannot resume ${config.version} over ${target.key} ${channel.name} ${channel.manifest.version}.`,
        );
      }
      const segment = rollbackChannelSegment(target, channel.name);
      const rollbackKeys = await listRollbackKeys(config, config.version, segment);
      if (!expectedRollbackCounts(target).includes(rollbackKeys.length)) {
        throw new Error(
          `Cannot resume ${config.version}: expected one ${segment} rollback manifest, found ${rollbackKeys.length}.`,
        );
      }
    }
    await verifyContentAddressedManifest({
      config,
      target,
      raw: candidate.raw,
      sourcePath: candidate.path,
      expectedVersion: config.version,
      temporaryDirectory,
    });
    resumed.push({ target, candidate });
  }
  for (const { target, candidate } of resumed) {
    await activateManifests({
      config,
      target,
      latestPath: candidate.path,
      latestRaw: candidate.raw,
      betaPath: candidate.path,
      betaRaw: candidate.raw,
      temporaryDirectory,
    });
  }
  console.log(`Resumed interrupted 2code ${config.version} channel activation.`);
}

async function promoteRelease(
  config: TwoCodeReleaseConfig,
  targetPercentage: number,
  temporaryDirectory: string,
): Promise<void> {
  const summaries: string[] = [];
  for (const target of releaseTargets(config)) {
    const liveChannels = await fetchLiveChannels({
      config,
      target,
      temporaryDirectory,
      allowMissing: false,
    });
    const promoted: Array<{ name: ReleaseChannel; path: string; raw: string; current: number }> =
      [];
    for (const channel of liveChannels) {
      if (channel.manifest.version !== config.version) {
        throw new Error(
          `Configured version ${config.version} is not live on ${target.key} ${channel.name} (${channel.manifest.version}).`,
        );
      }
      const current = manifestStagingPercentage(channel.manifest);
      if (targetPercentage < current) {
        throw new Error(
          `Promotion target ${targetPercentage}% cannot be below live ${target.key} ${channel.name} rollout ${current}%.`,
        );
      }
      if (targetPercentage === current) {
        promoted.push({ name: channel.name, path: channel.path, raw: channel.raw, current });
        continue;
      }
      const raw = serializeManifestWithRollout(
        channel.raw,
        channel.path,
        targetPercentage,
        target.platformLabel,
      );
      const path = await writeTemporaryManifest(
        temporaryDirectory,
        `promoted-${target.key}-${channel.name}.yml`,
        raw,
      );
      await uploadImmutable({
        config,
        relativePath: `rollouts/${config.version}/${rollbackChannelSegment(target, channel.name)}/from-${current}-to-${targetPercentage}-${sha512Hex(channel.raw)}.yml`,
        localPath: channel.path,
        contentType: "application/yaml",
        temporaryDirectory,
      });
      const candidatePath = immutableManifestPath(config.version, raw);
      await uploadImmutable({
        config,
        relativePath: candidatePath,
        localPath: path,
        contentType: "application/yaml",
        temporaryDirectory,
      });
      await verifyPublicObject({
        config,
        relativePath: candidatePath,
        expectedSha512: sha512Base64(raw),
        expectedSize: Buffer.byteLength(raw),
        temporaryDirectory,
      });
      promoted.push({ name: channel.name, path, raw, current });
    }
    const latest = promoted.find((channel) => channel.name === "latest");
    const beta = promoted.find((channel) => channel.name === "beta");
    if (!latest || !beta) {
      throw new Error(`Both ${target.key} latest and beta promotion manifests are required.`);
    }
    await activateManifests({
      config,
      target,
      latestPath: latest.path,
      latestRaw: latest.raw,
      betaPath: beta.path,
      betaRaw: beta.raw,
      temporaryDirectory,
    });
    summaries.push(`${target.key} latest ${latest.current}% and beta ${beta.current}%`);
  }
  console.log(`Promoted 2code ${config.version} ${summaries.join(", ")} to ${targetPercentage}%.`);
}

async function listRollbackKeys(
  config: TwoCodeReleaseConfig,
  version: string,
  channelSegment: string,
): Promise<string[]> {
  const prefix = releaseObjectKey(config, `rollbacks/${version}/${channelSegment}/`);
  const result = runCommand(
    "aws",
    awsArgs(config, [
      "s3api",
      "list-objects-v2",
      "--bucket",
      config.r2Bucket,
      "--prefix",
      prefix,
      "--output",
      "json",
    ]),
  );
  const parsed = JSON.parse(result.stdout) as { Contents?: Array<{ Key?: string }> };
  return (parsed.Contents ?? [])
    .flatMap((entry) => (typeof entry.Key === "string" ? [entry.Key] : []))
    .filter((key) => key.endsWith(".yml"));
}

async function recoverRelease(
  config: TwoCodeReleaseConfig,
  recoveryVersion: string,
  temporaryDirectory: string,
): Promise<void> {
  const summaries: string[] = [];
  for (const target of releaseTargets(config)) {
    const recovered: Array<{
      channel: ReleaseChannel;
      path: string;
      raw: string;
      version: string;
    }> = [];
    let missingSnapshots = 0;
    for (const channel of ["latest", "beta"] as const) {
      const manifestName = channel === "latest" ? target.manifestName : target.betaManifestName;
      const live = await fetchChannelManifest(config, manifestName, temporaryDirectory);
      const liveManifest = readManifest(live.raw, live.path, target.platformLabel);
      const segment = rollbackChannelSegment(target, channel);
      const keys = await listRollbackKeys(config, recoveryVersion, segment);
      if (!expectedRollbackCounts(target).includes(keys.length)) {
        throw new Error(
          `Expected exactly one ${segment} rollback manifest for ${recoveryVersion}, found ${keys.length}.`,
        );
      }
      const rollbackKey = keys[0];
      if (!rollbackKey) {
        missingSnapshots += 1;
        continue;
      }
      const prefix = `${config.r2Prefix}/`;
      if (!rollbackKey.startsWith(prefix))
        throw new Error("Rollback object is outside the release prefix.");
      const relativeRollbackPath = rollbackKey.slice(prefix.length);
      const rollbackPath = NodePath.join(temporaryDirectory, `rollback-${segment}.yml`);
      runCommand(
        "aws",
        awsArgs(config, [
          "s3",
          "cp",
          `s3://${config.r2Bucket}/${rollbackKey}`,
          rollbackPath,
          "--no-progress",
        ]),
      );
      const rollbackRaw = await NodeFSP.readFile(rollbackPath, "utf8");
      const rollbackManifest = readManifest(
        rollbackRaw,
        relativeRollbackPath,
        target.platformLabel,
      );
      if (compareStableVersions(rollbackManifest.version, recoveryVersion) >= 0) {
        throw new Error(`${segment} rollback manifest must predate ${recoveryVersion}.`);
      }
      await verifyContentAddressedManifest({
        config,
        target,
        raw: rollbackRaw,
        sourcePath: relativeRollbackPath,
        expectedVersion: rollbackManifest.version,
        temporaryDirectory,
      });
      if (live.raw === rollbackRaw) {
        recovered.push({
          channel,
          path: rollbackPath,
          raw: rollbackRaw,
          version: rollbackManifest.version,
        });
        continue;
      }
      if (liveManifest.version !== recoveryVersion) {
        throw new Error(
          `Recovery ${recoveryVersion} found unexpected live ${segment} version ${liveManifest.version}.`,
        );
      }
      const runId = process.env.GITHUB_RUN_ID ?? "unknown-run";
      await uploadImmutable({
        config,
        relativePath: `recoveries/${recoveryVersion}/${segment}/${runId}-${sha512Hex(live.raw)}.yml`,
        localPath: live.path,
        contentType: "application/yaml",
        temporaryDirectory,
      });
      recovered.push({
        channel,
        path: rollbackPath,
        raw: rollbackRaw,
        version: rollbackManifest.version,
      });
    }
    if (missingSnapshots === 2) {
      // The release that introduced the Linux channels has nothing older to restore.
      console.log(
        `No ${target.key} rollback manifests exist for ${recoveryVersion}; leaving its channels untouched.`,
      );
      continue;
    }
    const latest = recovered.find((entry) => entry.channel === "latest");
    const beta = recovered.find((entry) => entry.channel === "beta");
    if (!latest || !beta) {
      throw new Error(`Both ${target.key} latest and beta recovery manifests are required.`);
    }
    await activateManifests({
      config,
      target,
      latestPath: latest.path,
      latestRaw: latest.raw,
      betaPath: beta.path,
      betaRaw: beta.raw,
      temporaryDirectory,
    });
    summaries.push(`${target.key} latest ${latest.version} and beta ${beta.version}`);
  }
  console.log(
    `Restored ${summaries.join("; ")}. Already-updated clients will not downgrade automatically.`,
  );
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const config = await readReleaseConfig(args.configPath);
  requirePublishGuard(config);
  const temporaryDirectory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "2code-r2-publish-"),
  );
  try {
    if (args.command === "publish") {
      if (!args.artifactDirectory) throw new Error("publish requires --artifact-dir.");
      await publishRelease(config, NodePath.resolve(args.artifactDirectory), temporaryDirectory);
    } else if (args.command === "resume") {
      await resumeRelease(config, temporaryDirectory);
    } else if (args.command === "promote") {
      if (args.stagingPercentage === undefined) {
        throw new Error("promote requires --staging-percentage.");
      }
      await promoteRelease(config, args.stagingPercentage, temporaryDirectory);
    } else {
      if (!args.recoveryVersion) throw new Error("recover requires --recovery-version.");
      await recoverRelease(config, args.recoveryVersion, temporaryDirectory);
    }
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
