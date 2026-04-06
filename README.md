# opencode-mastra-om

OpenCode plugin that adds observational memory to agent sessions. Watches the message history, extracts facts, compresses them periodically, and injects a summary into the system prompt.

Built on Mastra's `ObservationalMemory`. Config lives in `.opencode/mastra.json`.

Credit to [Tyler Barnes](https://github.com/tylerbarnes) and the [Mastra](https://github.com/mastra-ai/mastra) team for creating Observational Memory and the original OpenCode integration this is based on.

Works with cloud models (Gemini 2.5, Claude) or local models via any OpenAI-compatible endpoint. Early testing suggests Gemma 4 26B MoE is a viable local alternative — instruction following is good enough for both observation and reflection passes. Still being validated across different sessions and quantizations.

## Installation

```sh
cd opencode-mastra-om
bun install && bun run build
ln -sf $(pwd)/dist/index.js ~/.config/opencode/plugin/mastra-om.js
```

Add to `opencode.json`:

```json
{
  "plugin": {
    "mastra-om": {
      "path": "~/.config/opencode/plugin/mastra-om.js"
    }
  }
}
```

## Config

`.opencode/mastra.json` in your project directory:

```json
{
  "model": "google/gemini-2.5-flash",
  "apiKey": "AIza...",
  "storagePath": ".opencode/memory/observations.db",
  "chunkBytes": 400000,
  "observation": { "messageTokens": 10000 },
  "reflection": { "observationTokens": 60000 }
}
```

### Options

| Field | Default | Description |
|-------|---------|-------------|
| `model` | — | Model for observation and reflection |
| `observationModel` | — | Override model for observation only |
| `reflectionModel` | — | Override model for reflection only |
| `apiKey` | — | API key, bypasses env var lookup |
| `storagePath` | `.opencode/memory/observations.db` | SQLite path, relative to project root |
| `storageUrl` | — | Full connection URL: `postgresql://...`, `libsql://...`, or `file:///...` |
| `chunkBytes` | — | Split observation runs into chunks of this many UTF-8 bytes. Splits at message boundaries. |
| `chunkDelay` | 200 | Milliseconds between chunks |
| `logPath` | — | Write debug logs to this path instead of using `OM_DEBUG` env var |
| `observation.messageTokens` | — | Max tokens per message fed to the observation model |
| `reflection.observationTokens` | 60000 | Max observation tokens fed into reflection |

### Local models

Point `model` at any OpenAI-compatible endpoint using the `openai/` prefix:

```json
{
  "model": "openai/gemma4-26b-a4b-it",
  "apiKey": "EMPTY",
  "storageUrl": "..."
}
```

### PostgreSQL

```json
{
  "model": "google/gemini-2.5-flash",
  "apiKey": "AIza...",
  "storageUrl": "postgresql://user:pass@host:5432/dbname"
}
```

## Tools

| Tool | Description |
|------|-------------|
| `om_status` | Observation progress and next cycle threshold |
| `om_observations` | Current stored observations |
| `om_observe` | Trigger an observation cycle. Optional `since` ISO date to observe only recent messages |
| `om_reflect` | Trigger a reflection (compression) cycle |
| `om_prune` | Prune already-observed messages from storage |
| `om_reset` | Clear observations and start fresh. Backs up first |
| `om_restore` | Restore from backup slot 1 (most recent) or slot 2 |
| `om_config` | Show active configuration |

## Chunked observation

> **Experimental.** Chunked observation and the reset/restore workflow are not fully reliable yet. Use with caution on sessions you care about.

`chunkBytes` splits the message history into pieces before observing. Each chunk is processed in sequence.

```json
{
  "chunkBytes": 400000,
  "chunkDelay": 500
}
```

Rough sizing: 400000 for Claude, 2000000 for Gemini 2.5 Flash.

`om_reset` and `om_restore` are similarly experimental — backup/restore logic is functional but not well-tested across edge cases.

## Known issues

- Reflection can loop if observations won't compress below the threshold. Raise `reflection.observationTokens` as a workaround. Upstream: [mastra-ai/mastra#14110](https://github.com/mastra-ai/mastra/issues/14110).
- Chunked observation may produce inconsistent results if a session is partially observed and re-run.
