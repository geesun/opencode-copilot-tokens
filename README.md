# opencode-copilot-tokens

A TUI sidebar plugin for [opencode](https://opencode.ai) that tracks per-session
GitHub Copilot token usage and estimated cost, broken down by model.

```
Copilot Tokens
pricing       2026-05-29
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

- Sidebar panel showing **last turn** + **cumulative session by model** + **total**
- `/copilot-tokens` slash command toggles the panel; preference persists across restarts
- Per-session totals persist to disk, so they survive restarts
- Pricing data bundled and **refreshed daily** from the official GitHub Copilot
  [`models-and-pricing.yml`](https://github.com/github/docs/blob/main/data/tables/copilot/models-and-pricing.yml)
- Zero runtime dependencies (only SolidJS, provided by opencode)

## Install

The easiest way is to let opencode fetch the plugin straight from GitHub. You
can also install it from a local clone for development.

### From GitHub (recommended)

opencode's plugin loader accepts any spec [`npm-package-arg`](https://github.com/npm/npm-package-arg)
understands, including git URLs. opencode will git-clone the repo into its own
cache and run `bun install` for you on first start.

Edit (or create) one of:

- **Global** — `~/.config/opencode/tui.json` (plugin available in every workspace)
- **Per-workspace** — `<workspace>/.opencode/tui.jsonc` (plugin scoped to one project)

…and add the plugin spec:

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "git+https://github.com/geesun/opencode-copilot-tokens.git#v0.1.0"
  ]
}
```

Other equivalent spec forms:

| spec | meaning |
| ---- | ------- |
| `"github:geesun/opencode-copilot-tokens"` | latest commit on default branch |
| `"github:geesun/opencode-copilot-tokens#v0.1.0"` | shorthand, pinned to a tag |
| `"git+https://github.com/geesun/opencode-copilot-tokens.git#main"` | HTTPS, branch ref |
| `"git+ssh://git@github.com/geesun/opencode-copilot-tokens.git#v0.1.0"` | SSH, requires git creds |

Pinning to a tag (`#v0.1.0`) is recommended so upstream changes do not break
your TUI silently.

Restart `opencode`. The first start will be a few seconds slower while the
plugin is cloned and its peer dependencies are resolved against opencode's
bundled SolidJS / OpenTUI.

### From a local clone (development)

1. Clone the repo somewhere convenient, e.g. `<workspace>/.opencode/plugins/opencode-copilot-tokens/`.
2. Inside the clone, run `bun install`.
3. Point `tui.jsonc` at the directory:

   ```jsonc
   {
     "$schema": "https://opencode.ai/tui.json",
     "plugin": ["./plugins/opencode-copilot-tokens"]
   }
   ```

4. Restart `opencode`.

### Avoid double-loading

If the same plugin is registered in both global and workspace configs, opencode
deduplicates by package name — so identical specs are safe. But registering it
under two **different** specs (e.g. once as a local path, once as a GitHub URL)
may load it twice and render the sidebar panel twice. Pick one source and stick
to it.

> **Why `tui.json` and not `opencode.json`?** opencode's TUI process loads its
> own config file independent of the server's `opencode.json`. A plugin with
> only a `tui` entrypoint (like this one) must be registered in `tui.json` /
> `tui.jsonc`, not `opencode.json`.

## Usage

- Open any session that talks to a Copilot model. The panel populates as the
  model produces its first step.
- Run `/copilot-tokens` to hide or show the panel.
- Run any number of turns, switch models mid-session — the panel keeps a
  running total per model.

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
On startup the plugin asynchronously fetches the latest YAML; on success it
caches the parsed table to `~/.cache/opencode/copilot-pricing.json` and shows a
brief `⟳` indicator next to the date. The cache TTL is 24h. Network failures
are silent — the bundled prices are always available as a fallback.

### Caveat: not your actual GitHub bill

Copilot bills customers in **premium requests** (a flat per-call quota), not
per token. The dollar figures here are an *equivalent token cost* using the
public per-token rates Copilot publishes, useful for comparing model
efficiency across a session. They are **not** what GitHub charges you.

## Storage

- `~/.local/state/opencode/copilot-tokens/<sessionID>.json` — per-session
  cumulative totals. Survives restarts.
- `~/.cache/opencode/copilot-pricing.json` — refreshed pricing snapshot.
- KV key `copilot-tokens.visible` — sidebar visibility preference.

Delete any of these freely; they will be recreated.

## Development

```bash
bun install
bun test           # 29 tests across compute / pricing / storage / session / parse
bunx tsc --noEmit  # type check
```

The plugin is a single SolidJS component (`src/tui.tsx`) on top of four pure
modules (`compute`, `pricing`, `storage`, `session`) each covered by its own
test file.
