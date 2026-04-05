# opencode-mastra-om

Enhanced Mastra Observational Memory plugin for OpenCode.

## Improvements over `@mastra/opencode@0.0.20`

- `apiKey` in `mastra.json` bypasses env var resolution entirely
- `storageUrl` supports PostgreSQL in addition to SQLite
- `observationModel` / `reflectionModel` for separate model selection
- `logPath` for debug logging without `OM_DEBUG` env var
- Smarter credential resolution — handles multi-env-var providers (Google)
- Manual trigger tools: `om_observe`, `om_reflect`, `om_prune`
- `om_status`, `om_observations`, `om_config` diagnostic tools

## Installation

The plugin file lives at `src/mastra-om.ts` and is symlinked to `~/.config/opencode/plugin/mastra-om.ts`.

OpenCode loads it via `opencode.json`:
```json
{
  "plugin": {
    "mastra-om": {
      "path": "~/.config/opencode/plugin/mastra-om.ts"
    }
  }
}
```

## Config (`<agent-dir>/.opencode/mastra.json`)

```json
{
  "model": "google/gemini-2.5-flash",
  "apiKey": "AIza...",
  "observation": { "messageTokens": 10000 },
  "reflection": { "observationTokens": 60000 },
  "storagePath": ".opencode/memory/observations.db"
}
```

## Known Issues

- Reflection infinite retry loop when observations can't compress below threshold — tracked at [mastra-ai/mastra#14110](https://github.com/mastra-ai/mastra/issues/14110). Workaround: raise `reflection.observationTokens` threshold.
