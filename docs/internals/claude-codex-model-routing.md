# Native delegation preferences

The fork's former Claude-to-Codex bridge has been removed. Per-instance `codexRouting` settings
retain their historical storage key so saved task preferences survive upgrades, but they now guide
native V2 delegation. They must never rewrite Anthropic endpoints or remap Claude's Haiku alias.

Historical 2code import manifests can still contain `claudeCodexRouting`. Decode that field for
compatibility without activating a bridge or importing its credentials. Native Codex authentication
belongs to the destination environment's provider configuration.

The shared preference renderer is used by both the Settings preview and Claude sessions. Keep those
instructions aligned with the native delegation capability catalog; a selected model is a preference,
not proof that a matching provider instance is available or authorized.
