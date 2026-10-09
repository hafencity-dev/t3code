# Claude and Codex model preferences

In **Settings → Model Routing**, choose which Claude instance to configure, enable delegation
preferences, and select the Codex model for delegated work. Sign in to the normal Codex provider in
**Settings → Providers** on the environment that runs the thread.

The main conversation stays on Claude. Codex work runs in native Orchestrator V2 delegated threads,
using that environment's configured Codex provider and permissions. Claude's Haiku model keeps its
normal meaning. To run the main conversation on GPT, select the Codex provider directly.

## Choose who handles each task

Assign exploration, implementation, verification, planning, design, and review to **Claude**,
**Codex**, or **Best fit**. Claude categories can use their own Claude model. These preferences guide
the agent; the main conversation still checks the results and owns the final answer.

**Independent second opinion** requests separate Claude and Codex views for consequential plans,
reviews, or both. Routine work does not require the extra pass.

The settings preview shows the instructions given to Claude. A custom policy replaces the generated
task guidance, and additional instructions extend it. Custom instructions carried over from the old
bridge should be updated to use native delegation instead of the former Haiku remapping.

## Upgrading from the bridge

The local Claude-to-Codex proxy, separate bridge sign-in, request timeout, and bridge-specific GPT
Fast controls have been removed. Existing task preferences remain available. Bridge credentials are
not copied into the native Codex provider; connect that provider if it is not already signed in.
Use the native Codex model options for fast processing when supported.

Changes apply to newly started provider sessions. Existing bridge-backed GPT selections under a
Claude provider no longer run GPT through Claude; select Codex explicitly to continue using GPT.
