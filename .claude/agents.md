# Fork rules (hafencity-dev/t3code)

This repo is a fork of `pingdotgg/t3code` (`upstream` remote). We regularly sync with upstream, so every fork-specific change must be written to keep merges cheap.

## Upstream-sync rule

- **Prefer additive code.** New features live in new files/modules/folders that upstream does not own. Plug into existing extension seams (provider registries, contract modules, panel/routing registries) instead of rewriting upstream code.
- **Minimize diffs to upstream-owned files.** When an upstream file must be touched, keep it to the smallest possible hook: one import, one registry entry, one render slot. Never reformat, reorder, or refactor upstream code in the same change.
- **Mark fork-only hooks.** Where a fork feature is wired into an upstream file, keep the edit on its own line(s) so a merge conflict resolves by re-adding that line.
- **Don't fork behavior silently.** If a fork feature needs upstream behavior changed (not just extended), isolate the change behind a fork-owned flag or wrapper so the upstream implementation stays intact underneath.
- **Syncing:** `git fetch upstream && git merge upstream/main`. After a sync, verify fork hooks (grep for `fork:` markers) survived the merge.

Fork-specific features (rebuilt on upstream in September 2026; everything else from the earlier fork was dropped on purpose):

- **Source control panel** — `apps/server/src/vcs/workingCopy/`, `apps/web/src/components/sourceControl/`, `apps/web/src/lib/sourceControl/`, `packages/contracts/src/workingCopy.ts`, `packages/client-runtime/src/state/workingCopy*.ts`.
- **Sidebar usage stats** — `apps/web/src/components/sidebar/SidebarProviderUsage.tsx`, rendered from upstream's own usage-limit data (no fork data pipeline).
- **Claude Code → Codex model routing (incl. GPT Fast)** — `apps/server/src/provider/claudeCodex/`, `packages/contracts/src/claudeCodexRouting.ts`, `packages/shared/src/claudeCodexRouting.ts`, `apps/web/src/components/settings/ModelRoutingSettings*`, `apps/web/src/components/chat/ClaudeCodexFastMode*`.
- **2code branding** — `apps/web/src/branding.ts`, `Brand2codeMark`, `distributions/2code/`, `assets/2code/`, desktop product identity in `apps/desktop/src/app/DesktopDistribution.ts`.
- **2code update system** — `scripts/fork/2code-release/`, `scripts/fork/2code-desktop-*.ts`, `.github/workflows/hafencity-2code-release.yml`, legacy hand-off in `apps/desktop/src/migrations/` and `apps/server/src/fork/`, plus the migration-ledger repair in `apps/server/src/persistence/fork/`.

Not kept (do not re-add without a decision): session grid, thread subtitles, system prompt injection, the fork's own Codex/ChatGPT sign-in dialog (upstream ships provider sign-in now), desktop-owned Tailscale Serve, mobile fork UI, CLI text rebranding.
