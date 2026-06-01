# opencode-copilot-tokens

A TUI sidebar plugin for [opencode](https://opencode.ai) that tracks per-session
GitHub Copilot token usage and estimated cost, broken down by model.

```
Copilot 25.0% (75/300)
Last turn ──────────────
in                     6
out                    8
cache(i)          17,969
cache(w)          43,907
cost             $0.2836
Session by model ───────
claude-sonnet-4.6
in                     3
out                    7
cache(i)          47,898
cache(w)              22
cost             $0.0146
claude-opus-4.7
in                     6
out                    8
cache(i)          17,969
cache(w)          43,907
cost             $0.2836
────────────────────────
TOTAL            $0.2982
```

## Features

- Sidebar header showing **plan quota** (always visible, highlighted)
- Sidebar panel showing **last turn** + **cumulative session by model** + **total**
- `/copilot-tokens` slash command toggles the token/cost panel (the quota header
  stays visible); preference persists across restarts
- `/copilot-refresh` re-fetches the plan quota on demand (also auto-refreshes on every idle)
- `/copilot-usage` — toggle a panel showing token usage and estimated cost per model for today, this/last week, and this/last month (data stored locally in `~/.local/state/opencode/copilot-tokens/usage.db`)
- Per-session totals persist to disk, so they survive restarts
- Pricing data bundled and **refreshed daily** from the official GitHub Copilot
  [`models-and-pricing.yml`](https://github.com/github/docs/blob/main/data/tables/copilot/models-and-pricing.yml)
- Zero runtime dependencies (only SolidJS, provided by opencode)

## Install

1. Clone the repo somewhere convenient. Two common choices:

   - **Globally** for every workspace:
     ```sh
     git clone https://github.com/geesun/opencode-copilot-tokens.git \
       ~/.config/opencode/plugins/opencode-copilot-tokens
     ```
   - **Per-workspace**:
     ```sh
     git clone https://github.com/geesun/opencode-copilot-tokens.git \
       <workspace>/.opencode/plugins/opencode-copilot-tokens
     ```

2. Install the plugin's runtime peer deps once:

   ```sh
   cd <clone-dir> && bun install
   ```

3. Register the directory in one of:

   - **Global** — `~/.config/opencode/tui.json`
   - **Per-workspace** — `<workspace>/.opencode/tui.jsonc`

   ```jsonc
   {
     "$schema": "https://opencode.ai/tui.json",
     "plugin": ["./plugins/opencode-copilot-tokens"]
     // or absolute: "/Users/you/.config/opencode/plugins/opencode-copilot-tokens"
   }
   ```

4. Restart `opencode`.

### Updating

```sh
cd <clone-dir> && git pull && bun install
```

Restart `opencode` to pick up the new build.

### Avoid double-loading

If you register the plugin in both global and workspace configs, opencode
deduplicates by package name — so identical specs are safe. But registering it
under two **different** specs (e.g. once as `./plugins/...`, once as the
absolute path) may load it twice and render the sidebar panel twice. Pick one
and stick to it.

> **Why `tui.json` and not `opencode.json`?** opencode's TUI process loads its
> own config file independent of the server's `opencode.json`. A plugin with
> only a `tui` entrypoint (like this one) must be registered in `tui.json` /
> `tui.jsonc`, not `opencode.json`.

## Usage

- Open any session that talks to a Copilot model. The panel populates as the
  model produces its first step.
- The **quota header** (`Copilot X% (used/total)`) appears as soon as the
  GitHub Copilot OAuth token is detected at
  `~/.local/share/opencode/auth.json` — it works even before the first
  Copilot turn, and it stays visible even when the token panel is collapsed.
- Run `/copilot-tokens` to hide or show the token/cost panel below the quota
  header.
- Run `/copilot-refresh` to force a quota re-fetch (the plugin also refreshes
  automatically whenever a session goes idle).
- Run any number of turns, switch models mid-session — the panel keeps a
  running total per model.
- Run `/copilot-usage` to toggle a usage breakdown across today, this/last
  week, and this/last month.

## How it works

### Token data

The plugin subscribes to opencode's `message.part.updated` event. When a
`step-finish` part arrives, it carries a `tokens` object that opencode parsed
out of the provider's response:

| opencode field        | label       | meaning                                                      |
| --------------------- | ----------- | ------------------------------------------------------------ |
| `input`               | `in`        | Fresh input tokens for this step                             |
| `output` + `reasoning`| `out`       | Output tokens (reasoning tokens are billed at output rate)   |
| `cache.read`          | `cache(i)`  | Cached input tokens — i.e. prompt tokens that hit cache      |
| `cache.write`         | `cache(w)`  | Tokens written into the prompt cache (Anthropic only)        |

These numbers come straight from the provider's billing-grade usage report;
nothing is estimated client-side.

### Cost calculation

Cost per step is:

```
input   × input_price          / 1,000,000
+ cache(i) × cached_input_price / 1,000,000
+ out      × output_price        / 1,000,000
+ cache(w) × cache_write_price   / 1,000,000
```

Prices come from `pricing.json`, which mirrors the GitHub Copilot
[`models-and-pricing.yml`](https://github.com/github/docs/blob/main/data/tables/copilot/models-and-pricing.yml).
On startup the plugin asynchronously fetches the latest YAML and caches the
parsed table to `~/.cache/opencode/copilot-pricing.json` (TTL 24h). Network
failures are silent — the bundled prices are always available as a fallback.

### Plan quota

The **Plan quota** section calls
`GET https://api.github.com/copilot_internal/user` with the GitHub Copilot
OAuth refresh token from `~/.local/share/opencode/auth.json`. The response
includes `quota_snapshots` keyed by quota type; the plugin reads the first
one that exists, in priority order:

1. `premium_models` — the new key introduced for the June 2026 AI-credit
   pricing transition
2. `premium_interactions` — the legacy "premium requests" key (still emitted
   for accounts on paid annual plans through their renewal)
3. `chat` — used for Free Copilot accounts

This fallback chain mirrors what VS Code's Copilot Chat extension does in
[`chatQuotaServiceImpl.ts`](https://github.com/microsoft/vscode-copilot-chat/blob/main/src/platform/chat/common/chatQuotaServiceImpl.ts),
so the plugin keeps working across the transition without code changes.

### Caveat: not your actual GitHub bill

Copilot bills customers in **premium requests** (a flat per-call quota), not
per token. The dollar figures here are an *equivalent token cost* using the
public per-token rates Copilot publishes, useful for comparing model
efficiency across a session. They are **not** what GitHub charges you.

## Storage

- `~/.local/state/opencode/copilot-tokens/usage.db` — SQLite event log of
  per-step integer token counts (the single source of truth for both
  cumulative session totals and the `/copilot-usage` ranges). Rows older than
  120 days are pruned automatically. Survives restarts.
- `~/.cache/opencode/copilot-pricing.json` — refreshed pricing snapshot.
- KV key `copilot-tokens.visible` — sidebar visibility preference.

Delete any of these freely; they will be recreated.

## Development

```bash
bun install
bun test           # tests across compute / pricing / ranges / db / usage / session / quota / parse
bunx tsc --noEmit  # type check
```

The plugin is a single SolidJS component (`src/tui.tsx`) on top of pure
modules (`compute`, `pricing`, `ranges`, `db`, `usage`, `session`, `quota`,
`auth`) each covered by its own test file where applicable.
