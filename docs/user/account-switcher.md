# Account Switcher

Save several Claude Code and Codex accounts and switch between them when one runs low. Open
**Accounts** in the sidebar, below the usage stats.

## Add an account

1. Open **Accounts** and select **Add account** next to Claude Code or Codex.
2. Optionally enter a name, then select **Start sign-in**. Without a name, the account is listed
   by its email address.
3. Codex: open the link (or scan the QR code) and enter the device code. Claude Code: open the
   link, sign in, and paste the code shown in the browser back into the dialog.

A login that is already saved is rejected. If your browser is still signed in to claude.ai or
chatgpt.com with another saved account, sign out there first or use a private window. A copy saved
before this check shows **Same account as …** with **Remove**.

Your existing login appears as **Default**. Each saved account keeps its own login on the T3
environment that runs the provider. Logins never leave that machine, so this also works from the
web, desktop, and remote clients.

Codex device login must be allowed for your ChatGPT account or workspace. Codex must store its
credentials in `auth.json`; the keyring credential store is not supported.

## Manage accounts

Rename an account, sign in to it again, or remove it from its **⋯** menu. Signing in again is how
you repair an expired or signed-out login. The original login (**Default**) can't be removed. To
remove the account in use, switch to another one first.

## Switch

Select **Switch** on an account. Each account shows its 5-hour and weekly usage and when they reset.
For Claude Code, **Weekly** is the all-model weekly limit; model-specific weekly limits (such as
Fable) appear when you hover it and don't affect recommendations or automatic switching.
**Best option** marks the account automatic switching would move to next: the one whose weekly
limit resets soonest and still has enough 5-hour and weekly quota left.

- **Claude Code** switches in place, like running `claude auth login` in a terminal. Running
  sessions keep going and use the new account from their next request. On macOS this can take up
  to about 30 seconds.
- **Codex** restarts its provider. If turns are running, the dialog asks before stopping them.

Threads keep their history after a switch. The first turn after switching rebuilds the prompt cache
on the new account.

If you sign in with a different Claude account in a terminal, the switcher saves that login as a
new account the next time you switch.

## Automatic switching

Turn on **Auto-switch** per provider. It has two thresholds: **5-hour at** (10% left by default)
and **Weekly at** (2% left by default). The weekly threshold is low so each account's weekly quota
gets used almost fully, while still switching before it runs out, so no chat stops mid-turn. When
the active account reaches either threshold, T3 Code switches to the account whose weekly limit
resets soonest and still has headroom, so no weekly quota expires unused. It also switches early,
while the active account is still healthy, when another account's weekly limit resets sooner and
it still has at least 20% of it left, so that quota is used up first. If that account's 5-hour
limit is low, it switches once that limit resets. An early switch waits at least 5 minutes after
the last switch.

Automatic switching never interrupts a running Codex turn; it waits until the turn finishes. A
manual switch does not pause it: once the account you picked reaches a threshold, it switches as
usual. A toast explains every automatic switch.

## Start 5-hour windows automatically

A Claude Code 5-hour window only starts with an account's first message. Turn on **Start 5-hour
windows automatically** below Auto-switch in the Claude Code section, and T3 Code sends a short
message with Claude Haiku to each signed-in account as soon as its window can start, so the clock
begins right away and the next reset comes sooner. It covers the active account and your other
saved accounts, skips accounts that are signed out or have no weekly quota left, and uses a tiny
amount of usage. The line below the toggle shows the next start or the last one.

It runs on the T3 environment, so the server must be running for windows to start. It is paused
while an API key or a Bedrock or Vertex setup is configured for Claude Code, because those would be
billed instead of starting a subscription window.

## Usage checks

The active account's usage updates with every turn. Other accounts are checked when you open the
dialog and their numbers are older than five minutes, or when you select the refresh button next
to an account. Checks are rate limited; after a failure or a provider rate limit the dialog shows
when it will retry and keeps the last known numbers.

## Limits

- Only the default Claude Code and Codex providers can switch accounts.
- The Claude → Codex routing login is separate and does not switch.
- New Claude accounts copy your MCP server list once. MCP servers that use OAuth need to be signed
  in again per account.
