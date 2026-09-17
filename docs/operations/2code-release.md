# 2code desktop release takeover

The `2code Release` workflow publishes the legacy macOS Electron update channel from the
`main-2code` branch without changing the upstream T3 Code release workflow. Existing 2code clients
continue to poll the same Cloudflare R2 feed. Every release also ships a Linux arm64 AppImage on
the same feed, so both platforms always move together.

The native Swift/Sparkle application is a separate product and is not part of this workflow.

## Production identity

Do not change these values without intentionally ending compatibility with installed 2code clients:

- Bundle identifier: `dev.hafencity.dev.agents`
- Product and executable name: `2code`
- Apple team: `D78YC33UVC`
- Architecture: `arm64`
- Update feed: `https://pub-cb9e18e7e55d46cf9c297e4b612881f7.r2.dev/releases/desktop`
- Updater manifests: `latest-mac.yml`/`beta-mac.yml` and `latest-linux-arm64.yml`/`beta-linux-arm64.yml`
- Updater cache: `2code-updater`
- Legacy URL scheme: `twentyfirst-agents`
- GitHub tag namespace: `2code-v*`

The macOS verifier checks the bundle identity, exact Developer ID authority for both app and DMG,
designated requirement, hardened-runtime entitlements, protocol schemes, embedded
distribution/runtime metadata, updater configuration, architecture, both stapled notarization
tickets, Gatekeeper assessment, final-artifact blockmaps, and all manifest hashes before
publication.

The Linux verifier extracts the AppImage and checks that the app, resource monitor, and
browser-secret helper are aarch64 executables, that the desktop entry registers the legacy URL
scheme for the released version, that the packaged updater configuration points at the production
feed, and that `latest-linux-arm64.yml` hashes the final AppImage and advertises its embedded
blockmap size (the updater needs it for differential downloads).

## Linux arm64

The Linux build runs on GitHub's hosted `ubuntu-24.04-arm` runner and needs no signing secrets.
It must finish before the macOS build, which downloads the verified AppImage and prepares one
release plan covering both platforms. A failed Linux build therefore blocks the release; the two
platforms are never published separately.

Automatic updates on Linux only work while the app runs as an AppImage. Install it to a
user-writable location under a file name without a version number, for example
`~/Applications/2code.AppImage`, so the updater can replace the file in place. Until the first
Linux-enabled release has been published, an installed AppImage logs a `404` for
`latest-linux-arm64.yml` on every update check; that is expected.

## GitHub setup

Protect `main-2code` before enabling publishing:

1. Make `main-2code` the fork repository's default branch so GitHub exposes the manual dry-run,
   promote, and recovery controls. Keep `main` as the clean upstream-sync mirror.
2. Require pull requests and the `Validate 2code release` check.
3. Disallow force pushes and branch deletion.
4. Require owner review for the release workflow, `distributions/2code`, the desktop distribution
   profile, and `scripts/fork/2code-release`. Keep at least two eligible code owners so the author
   of a version bump can receive an independent approval.
5. Create a protected environment named `2code-production` restricted to `main-2code`.
6. Require a production reviewer at least for the first takeover releases.

Configure these signing secrets in the protected `2code-production` environment:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

Configure the R2 secrets in that same protected environment:

- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `CLOUDFLARE_ACCOUNT_ID`

The R2 credential should be scoped to the `2code` bucket. Pull requests receive none of these
secrets. The workflow uses GitHub's short-lived `GITHUB_TOKEN` for the supplementary GitHub release.

## Safe bootstrap

The checked-in release version intentionally matches the current live version, `1.0.107`. Therefore
the first push only reads and compares `latest-mac.yml` and `beta-mac.yml`, then exits without a build,
tag, release, or R2 mutation.

Never start the takeover by changing the bundle identifier or by resetting the version to the T3
runtime version. The desktop updater version and embedded T3 runtime version are deliberately
separate.

## Signed dry run

Run the workflow manually with action `dry-run` to build, sign, notarize, and verify the configured
version without creating a tag or writing to R2. The verified candidate is retained as a GitHub
Actions artifact for 30 days.

The app bundle and the signed DMG container are submitted to Apple independently and stapled before
the updater manifests and content hashes are generated. Stapling changes the DMG bytes, so the
workflow regenerates its Electron blockmap afterwards and verifies both ZIP and DMG blockmaps
byte-for-byte against the final artifacts.

The signing build and every mutation job use the protected production environment. Inspect the
signed dry-run artifact before approving the first real version bump.

The workspace pins `@electron/notarize` to at least `3.1.1`. Earlier releases pass the bare
digit-leading name `2code.app` to `codesign`, which macOS parses as a process selector instead of a
path. Keep the override during upstream syncs until Electron Builder itself depends on a version
containing [electron/notarize#245](https://github.com/electron/notarize/pull/245).

## Publish a release

1. Increase only `version` in `distributions/2code/release.json`. It must never be below the live
   version and must not be reused for different app bytes.
2. Optionally set `stagingPercentage` from `1` to `99` for a staged rollout. `100` removes the staging
   field and releases to everyone.
3. Merge the change into `main-2code`.
4. Inspect the signed build and approve the `2code-production` environment.

Publication is serialized and cannot be canceled by a newer run. It proceeds in this order:

1. Verify the transferred candidate again.
2. Create a draft `2code-v<version>` GitHub release and upload assets without overwriting different
   bytes.
3. Upload content-addressed ZIP, DMG, blockmap, and AppImage objects to R2.
4. Download every object through the public CDN and verify its size and SHA-512.
5. Archive the previous latest and beta manifests of both platforms independently. Linux rollbacks
   live under `rollbacks/<version>/linux-<channel>/`; macOS keeps its original namespace.
6. Upload and verify `beta-linux-arm64.yml`, then `latest-linux-arm64.yml`.
7. Upload and verify `beta-mac.yml`.
8. Upload `latest-mac.yml` as the final updater mutation and verify it publicly.
9. Publish the prepared GitHub draft.

The macOS channels remain the release state machine that preflight reads. Because the Linux
pointers always move first, a Linux channel that already carries the configured version while
macOS does not is the residue of an interrupted run and is replaced by the fresh candidate.

Retries are safe. Existing immutable objects must contain identical bytes. If a beta-first pointer
activation was interrupted, preflight resumes the exact already-live, content-addressed candidate
without rebuilding different bytes under the same version. A rerun after full R2 activation verifies
the release plan, every GitHub asset, the tag commit, and both live manifests before publishing the
draft GitHub release.

## Promote a staged rollout

Run the workflow manually on `main-2code` with:

- action: `promote`
- staging percentage: an integer greater than the current percentage and no greater than `100`

All four channels must already contain the configured version. Their previous rollout manifests are
archived independently before beta and then latest are advanced, Linux first and macOS last.

## Recovery

Run the workflow manually on `main-2code` with:

- action: `recovery`
- recovery version: the currently live version whose rollout should be stopped

The job restores the independently archived latest and beta manifests of both platforms, with the
macOS latest manifest again written last. It also archives the manifests that were live when
recovery started. The release that first introduced the Linux channels has no earlier Linux
manifest to restore; recovering it leaves the Linux pointers untouched and says so in the log.

Recovery stops additional clients from receiving the bad version. It does **not** downgrade clients
that already installed it because the legacy updater has downgrades disabled. Ship the actual fix as
a new, higher patch version.

## Cut over from the old repository

The old and new workflows must never retain concurrent write authority over the production feed.
Immediately before approving the first production job from this repository:

1. Disable `Build And Publish Main Release` in `hafencity-dev/2code`.
2. Confirm no old release job is running.
3. Approve the new protected production job.
4. Verify both public manifests and perform an isolated `1.0.107` to new-version update.
5. Retire the old Electron publisher's R2 authority after the successful cutover. The old native
   macOS/Sparkle workflow also uses R2, so do not delete its repository secrets or revoke a shared
   Cloudflare key until that workflow has a separate credential. Never revoke the credential copied
   into the new `2code-production` environment.

Do not delete the old repository or its immutable release assets. Do not modify the separate native
macOS/Sparkle workflow as part of the Electron updater takeover.
