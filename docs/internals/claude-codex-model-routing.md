# Claude Code → Codex Model Routing

This fork feature remaps Claude Code's Haiku alias without replacing the Claude provider adapter.
It is opt-in per Claude provider instance through the hidden `ClaudeSettings.codexRouting` config.

## Request Path

When an enabled Claude session starts, the adapter asks the environment-owned bridge supervisor for
a hybrid environment. The supervisor starts a pinned CLIProxyAPI process and a capability-path HTTP
router on loopback, then supplies:

```text
ANTHROPIC_BASE_URL=http://127.0.0.1:<router-port>/x/<random-capability>
ANTHROPIC_DEFAULT_HAIKU_MODEL=<configured-codex-model>
```

The router inspects JSON message requests. Verified Codex model IDs are sent to CLIProxyAPI with a
random local bearer token. Claude aliases and full Claude model IDs are sent to the provider
instance's original Anthropic-compatible upstream. Unknown model IDs are rejected so the router
cannot accidentally forward Anthropic credentials to an unintended destination.

Routers are shared only when the original upstream and request deadline agree. This preserves custom
`ANTHROPIC_BASE_URL` configurations and per-instance deadlines for concurrent Claude instances.
Message and token-count requests use the same model routing. Remember previously verified model
routes across account switches: clearing the account catalog must not prevent an existing router
from reaching the supervisor to restart the runtime. The runtime still validates the current account.

The Codex subscription translator does not forward Anthropic `max_tokens` as an output cap. Do not
add an output-token control without verifying that it reaches and is supported by that upstream.
The router bounds total request duration even when SSE keep-alives continue, and cancels upstream
work on downstream disconnect. Retrying a response after output has started belongs to the SDK; the
router must not replay a partially delivered tool call.

When routing is enabled, the Claude provider snapshot includes the configured Codex model as a
non-legacy model with `subProvider: "via Codex"`. This makes the route available in every client that
renders the server model catalog, rather than adding a web-only picker exception. Selecting that
entry keeps the Claude provider instance id but sends the raw Codex model id; the hybrid router then
routes the main `/v1/messages` request to the local bridge. The session prompt switches to a slim
all-Codex variant so it does not describe a nonexistent Claude main loop.

## Account Lifecycle

Bridge state lives below the server state directory in `providers/claude-codex-bridge`. It is
separate from every normal Codex provider home. Device login writes into a staging auth directory;
credentials replace the active directory only after a successful login.

The login RPC is a one-shot stream command. Unmounting the client atom closes the stream and cancels
the login child. It is deliberately not a durable subscription because reconnecting must not start
a new OAuth flow.

## Prompt Composition

The shared prompt renderer is used by both the server and the Settings preview. At session start the
Claude adapter composes, in order:

1. fixed bridge mechanics for the active model and Haiku remap
2. generated structured model preferences, a custom preference policy, or no policy
3. routing-specific additional instructions
4. the existing T3 system-prompt injection rules

The result is appended through the Claude Agent SDK's `claude_code` preset. The provider's built-in
system prompt is never replaced.

Model preferences are stored per Claude provider instance inside `codexRouting`. Six task
categories use `claude`, `codex`, or `adaptive` ownership, and the independent second-opinion mode
is configured separately for plans, reviews, both, or neither. The server does not classify tasks;
the shared renderer turns these values into deterministic system-prompt guidance used byte-for-byte
by the Settings preview and the provider session. The stored `claude` value means a Claude
subagent, not inline work by the main loop; all three routes preserve the main session as a thin
orchestrator that evaluates and synthesizes delegated results. `claudeSubagentModels` stores optional
per-category Claude Code Agent aliases (`opus`, `fable`, or `sonnet`); the older
`claudeSubagentModel` field remains as a decoding fallback for settings written by the initial global
selector. The UI resolves display labels from the selected provider instance's model catalog. A
second-opinion plan uses the planning category's Claude model, while a review uses the review
category's model.
