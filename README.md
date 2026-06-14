# opencode-copilot-tokens

A TUI sidebar plugin for [opencode](https://opencode.ai) that tracks per-session
GitHub Copilot token usage and estimated cost, broken down by model.

```
Copilot Tokens
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
- `/copilot-tokens` slash command toggles the token/cost panel (the quota header
  stays visible); preference persists across restarts
- Per-session totals persist to disk, so they survive restarts
- Pricing data bundled and **refreshed daily** from the official GitHub Copilot
  [`models-and-pricing.yml`](https://github.com/github/docs/blob/main/data/tables/copilot/models-and-pricing.yml)

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

