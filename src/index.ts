/**
 * mastra-om.ts — Enhanced Mastra Observational Memory plugin for OpenCode
 *
 * Improvements over @mastra/opencode@0.0.20:
 *  - `apiKey` in mastra.json bypasses env var resolution entirely
 *  - `storageUrl` supports PostgreSQL (postgresql://...) in addition to SQLite
 *  - `observationModel` / `reflectionModel` for separate model selection
 *  - `logPath` for debug logging without OM_DEBUG env var
 *  - Smarter credential resolution — handles multi-env-var providers (Google)
 *  - `memory_observe`  — manually trigger an observation cycle
 *  - `memory_reflect`  — manually trigger a reflection cycle
 *  - `memory_prune`    — prune observed messages from storage
 *  - Improved `memory_status` — shows model, last error, credential state
 *
 * Config: .opencode/mastra.json
 * @example SQLite
 * {
 *   "model": "google/gemini-2.5-flash",
 *   "apiKey": "AIza...",
 *   "storagePath": ".opencode/memory/observations.db"
 * }
 *
 * @example PostgreSQL
 * {
 *   "model": "google/gemini-2.5-flash",
 *   "apiKey": "AIza...",
 *   "storageUrl": "postgresql://user:pass@host:5432/dbname"
 * }
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { readFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { ObservationalMemoryOptions } from '@mastra/core/memory';
import { LibSQLStore } from '@mastra/libsql';
// @mastra/pg is loaded dynamically to avoid hard dependency when using SQLite
import {
  ObservationalMemory,
  TokenCounter,
  optimizeObservationsForContext,
  OBSERVATION_CONTINUATION_HINT,
  OBSERVATION_CONTEXT_PROMPT,
  OBSERVATION_CONTEXT_INSTRUCTIONS,
} from '@mastra/memory/processors';
import type { Plugin } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin';
import type { Message, Part } from '@opencode-ai/sdk';

export type { ObservationalMemoryOptions };

export interface MastraOMPluginConfig extends ObservationalMemoryOptions {
  /**
   * Path to SQLite db, relative to project root.
   * Default: .opencode/memory/observations.db
   * Ignored if storageUrl is set.
   */
  storagePath?: string;

  /**
   * Full connection URL for storage backend.
   * - PostgreSQL: "postgresql://user:pass@host:5432/dbname"
   * - LibSQL remote: "libsql://..."
   * - SQLite file: "file:///path/to/db.sqlite" (overrides storagePath)
   * If not set, defaults to SQLite at storagePath.
   */
  storageUrl?: string;

  /**
   * API key for the observation/reflection model provider.
   * Bypasses env var resolution. Useful when the provider has multiple env var names
   * (e.g. Google: GOOGLE_GENERATIVE_AI_API_KEY and GEMINI_API_KEY).
   */
  apiKey?: string;

  /**
   * Model for observation (extracting facts). Overrides `model` for observation only.
   * E.g., "google/gemini-2.5-flash"
   */
  observationModel?: string;

  /**
   * Model for reflection (condensing observations). Overrides `model` for reflection only.
   * E.g., "anthropic/claude-3-5-haiku-20241022"
   */
  reflectionModel?: string;

  /**
   * Path for debug log output, relative to project root.
   * Alternative to OM_DEBUG env var. If set, logs are always written here.
   */
  logPath?: string;
}

const CONFIG_FILE = '.opencode/mastra.json';
const DEFAULT_STORAGE_PATH = '.opencode/memory/observations.db';

// Provider env var mappings for credential resolution
const PROVIDER_ENV_VARS: Record<string, string[]> = {
  google: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  xai: ['XAI_API_KEY'],
  groq: ['GROQ_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  fireworks: ['FIREWORKS_API_KEY'],
};

async function loadConfig(directory: string): Promise<MastraOMPluginConfig> {
  try {
    const configPath = join(directory, CONFIG_FILE);
    const raw = await readFile(configPath, 'utf-8');
    return JSON.parse(raw) as MastraOMPluginConfig;
  } catch {
    return {};
  }
}

function convertMessages(messages: { info: Message; parts: Part[] }[], sessionId: string) {
  return messages
    .map(({ info, parts }) => {
      const convertedParts = parts
        .map((part): any => {
          const p = part as any;
          const type = p.type as string;
          if (type === 'text' && p.text) return { type: 'text', text: p.text };
          if (type === 'tool-invocation') return { type: 'tool-invocation', toolInvocation: { toolCallId: p.toolCallId, toolName: p.toolName, args: p.args, result: p.result, state: p.state } };
          if (type === 'file') return { type: 'file', url: p.url, mediaType: p.mediaType };
          if (type === 'image') return { type: 'image', image: p.image };
          if (type === 'reasoning' && p.reasoning) return { type: 'reasoning', reasoning: p.reasoning };
          if (type?.startsWith('data-om-')) return null;
          return null;
        })
        .filter((p): p is NonNullable<typeof p> => p !== null);

      if (convertedParts.length === 0) return null;
      if (info.role !== 'user' && info.role !== 'assistant') return null;

      return {
        id: info.id,
        role: info.role,
        createdAt: new Date(info.time.created),
        threadId: sessionId,
        resourceId: sessionId,
        content: { format: 2 as const, parts: convertedParts },
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);
}

function progressBar(current: number, total: number, width = 20): string {
  const pct = total > 0 ? Math.min(current / total, 1) : 0;
  const filled = Math.round(pct * width);
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}] ${(pct * 100).toFixed(1)}%`;
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function resolveThreshold(t: number | { min: number; max: number }): number {
  return typeof t === 'number' ? t : t.max;
}

export const MastraPlugin: Plugin = async ctx => {
  const config = await loadConfig(ctx.directory);

  // Debug logger
  let logFile: string | null = null;
  if (config.logPath) {
    logFile = join(ctx.directory, config.logPath);
    mkdirSync(dirname(logFile), { recursive: true });
  } else if (process.env.OM_DEBUG) {
    logFile = join(ctx.directory, '.opencode/memory/om.log');
    mkdirSync(dirname(logFile), { recursive: true });
  }

  const omLog = (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    if (logFile) { try { appendFileSync(logFile, line); } catch {} }
  };

  omLog(`[init] mastra-om plugin starting, pid=${process.pid}`);

  // Track last error for memory_status
  let lastError: string | null = null;

  // Credential resolution — smarter than upstream:
  // 1. If config.apiKey is set, apply it to all env vars for the model's provider
  // 2. Otherwise, pull keys from OpenCode's provider store (handles all providers)
  // 3. Works correctly for multi-env-var providers like Google
  let credentialsReady = false;
  const resolveCredentials = async () => {
    if (credentialsReady) return;

    // If apiKey is hardcoded in config, apply to model's provider env vars
    if (config.apiKey) {
      const modelProvider = (config.model as string)?.split('/')[0];
      if (modelProvider) {
        const envVars = PROVIDER_ENV_VARS[modelProvider] ?? [`${modelProvider.toUpperCase()}_API_KEY`];
        for (const envVar of envVars) {
          process.env[envVar] = config.apiKey;
        }
        omLog(`[credentials] set ${envVars.join(', ')} from config.apiKey`);
      }
    }

    // Also pull from OpenCode's provider store — fills in any remaining gaps
    try {
      const providersResponse = await ctx.client.config.providers();
      if (providersResponse.data) {
        for (const provider of providersResponse.data.providers) {
          // Fix upstream bug: provider.key may be undefined when env.length > 1
          // Use any available key from the provider
          const key = provider.key ?? (provider as any).apiKey ?? (provider as any).token;
          if (key && provider.env) {
            for (const envVar of provider.env) {
              if (!process.env[envVar]) {
                process.env[envVar] = key;
                omLog(`[credentials] set ${envVar} from provider store`);
              }
            }
          }
        }
      }
    } catch (e) {
      omLog(`[credentials] provider store unavailable: ${e}`);
    }

    credentialsReady = true;
    omLog(`[credentials] resolved. GOOGLE_GENERATIVE_AI_API_KEY=${process.env.GOOGLE_GENERATIVE_AI_API_KEY ? 'set' : 'missing'}`);
  };

  // Storage — supports PostgreSQL or SQLite
  let store: any;
  if (config.storageUrl && (config.storageUrl.startsWith('postgresql://') || config.storageUrl.startsWith('postgres://'))) {
    omLog(`[init] using PostgreSQL storage: ${config.storageUrl.replace(/:\/\/[^@]+@/, '://<redacted>@')}`);
    // Dynamically import @mastra/pg — not available until installed
    // Using Function constructor to bypass TypeScript static analysis
    const pgMod: any = await new Function('return import("@mastra/pg")')();
    const PostgresStore = pgMod.PostgresStore;
    store = new PostgresStore({ connectionString: config.storageUrl });
    await store.init();
  } else {
    const url = config.storageUrl ?? `file:${join(ctx.directory, config.storagePath ?? DEFAULT_STORAGE_PATH)}`;
    if (!config.storageUrl) {
      const dbAbsolutePath = join(ctx.directory, config.storagePath ?? DEFAULT_STORAGE_PATH);
      await mkdir(dirname(dbAbsolutePath), { recursive: true });
    }
    omLog(`[init] using SQLite/LibSQL storage: ${url}`);
    store = new LibSQLStore({ id: 'mastra-om', url });
    await store.init();
  }
  const storage = await store.getStore('memory');
  if (!storage) throw new Error(`mastra-om: failed to initialize storage`);

  // Build OM config — support separate observation/reflection models
  const omOptions: ObservationalMemoryOptions = {
    storage,
    scope: config.scope,
    shareTokenBudget: config.shareTokenBudget,
    observation: {
      ...config.observation,
      ...(config.observationModel ? { model: config.observationModel } : {}),
    },
    reflection: {
      ...config.reflection,
      ...(config.reflectionModel ? { model: config.reflectionModel } : {}),
    },
  };

  // Set top-level model only if not overriding both separately
  if (config.model && !config.observationModel && !config.reflectionModel) {
    omOptions.model = config.model;
  }

  const om = new ObservationalMemory(omOptions);

  omLog(`[init] ObservationalMemory created, model=${config.model ?? 'default'}`);

  // Helper: backup current observations before observe/reflect
  const backupObservations = async (threadId: string, label: string) => {
    try {
      const record = await om.getRecord(threadId);
      const observations = record?.activeObservations;
      if (!observations) return;
      const generationCount = record?.generationCount ?? 0;
      const lookupKey = threadId;
      const savedAt = new Date().toISOString();
      const db = (store as any).turso;
      if (!db) return;

      // Rotate: slot 1 → slot 2, then write current → slot 1
      await db.execute({
        sql: `INSERT INTO mastra_om_backups (id, lookupKey, slot, generationCount, observations, savedAt)
              SELECT hex(randomblob(16)), lookupKey, 2, generationCount, observations, savedAt
              FROM mastra_om_backups WHERE lookupKey = ? AND slot = 1
              ON CONFLICT(lookupKey, slot) DO UPDATE SET
                generationCount = excluded.generationCount,
                observations = excluded.observations,
                savedAt = excluded.savedAt`,
        args: [lookupKey],
      });
      await db.execute({
        sql: `INSERT INTO mastra_om_backups (id, lookupKey, slot, generationCount, observations, savedAt)
              VALUES (hex(randomblob(16)), ?, 1, ?, ?, ?)
              ON CONFLICT(lookupKey, slot) DO UPDATE SET
                generationCount = excluded.generationCount,
                observations = excluded.observations,
                savedAt = excluded.savedAt`,
        args: [lookupKey, generationCount, observations, savedAt],
      });
      omLog(`[backup] ${label} — saved gen ${generationCount} to slot 1, rotated old slot 1 → slot 2`);
    } catch (err) {
      omLog(`[backup] failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  setTimeout(() => {
    void ctx.client.tui.showToast({
      body: { title: 'Mastra OM', message: 'Observational Memory active', variant: 'success', duration: 3000 },
    });
  }, 500);

  // Helper: run observation with toasts
  const runObserve = async (sessionId: string, messages: ReturnType<typeof convertMessages>) => {
    await om.observe({
      threadId: sessionId,
      messages,
      hooks: {
        onObservationStart: () => {
          omLog(`[observe] starting observation`);
          void ctx.client.tui.showToast({ body: { title: 'Mastra OM', message: 'Observing...', variant: 'info', duration: 10000 } });
        },
        onObservationEnd: () => {
          omLog(`[observe] observation complete`);
          void ctx.client.tui.showToast({ body: { title: 'Mastra OM', message: 'Observation complete', variant: 'success', duration: 3000 } });
        },
        onReflectionStart: () => {
          omLog(`[reflect] starting reflection`);
          void ctx.client.tui.showToast({ body: { title: 'Mastra OM', message: 'Reflecting...', variant: 'info', duration: 10000 } });
        },
        onReflectionEnd: () => {
          omLog(`[reflect] reflection complete`);
          void ctx.client.tui.showToast({ body: { title: 'Mastra OM', message: 'Reflection complete', variant: 'success', duration: 3000 } });
        },
      },
    });
  };

  return {
    event: async ({ event }) => {
      if (event.type === 'session.created') {
        const sessionId = event.properties.info.id;
        try {
          await om.getOrCreateRecord(sessionId);
          omLog(`[session] initialized record for ${sessionId}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          omLog(`[session] failed to init record: ${msg}`);
        }
      }
    },

    'experimental.chat.messages.transform': async (_input, output) => {
      const sessionId = output.messages[0]?.info.sessionID;
      if (!sessionId) return;

      await resolveCredentials();

      try {
        const mastraMessages = convertMessages(output.messages, sessionId);
        if (mastraMessages.length > 0) {
          await backupObservations(sessionId, 'pre-auto-observe');
          await runObserve(sessionId, mastraMessages);
        }

        const record = await om.getRecord(sessionId);
        if (record?.lastObservedAt) {
          const lastObservedAt = new Date(record.lastObservedAt);
          output.messages = output.messages.filter(({ info }) => {
            return new Date(info.time.created) > lastObservedAt;
          });
        }
        lastError = null;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        omLog(`[error] transform failed: ${lastError}`);
        void ctx.client.tui.showToast({
          body: { title: 'Mastra OM', message: `Error: ${lastError}`, variant: 'error', duration: 5000 },
        });
      }
    },

    'experimental.chat.system.transform': async (input, output) => {
      const sessionId = input.sessionID;
      if (!sessionId) return;
      try {
        const observations = await om.getObservations(sessionId);
        if (!observations) return;
        const optimized = optimizeObservationsForContext(observations);
        output.system.push(
          `${OBSERVATION_CONTEXT_PROMPT}\n\n<observations>\n${optimized}\n</observations>\n\n${OBSERVATION_CONTEXT_INSTRUCTIONS}\n\n${OBSERVATION_CONTINUATION_HINT}`,
        );
      } catch {}
    },

    tool: {
      om_status: tool({
        description: 'Show Observational Memory progress — how close the session is to the next observation and reflection cycle.',
        args: {},
        async execute(_args, context) {
          const threadId = context.sessionID;
          const record = await om.getRecord(threadId);
          if (!record) return 'No Observational Memory record found for this session.';

          const omConfig = om.config;
          const obsThreshold = resolveThreshold(omConfig.observation.messageTokens);
          const refThreshold = resolveThreshold(omConfig.reflection.observationTokens);
          const obsTokens = record.observationTokenCount ?? 0;

          const tokenCounter = new TokenCounter();
          let unobservedTokens = 0;
          try {
            const resp = await ctx.client.session.messages({ path: { id: threadId } });
            if (resp.data) {
              const allMastra = convertMessages(resp.data, threadId);
              const unobserved = record.lastObservedAt
                ? allMastra.filter(m => m.createdAt > new Date(record.lastObservedAt!))
                : allMastra;
              unobservedTokens = tokenCounter.countMessages(unobserved);
            }
          } catch {
            unobservedTokens = record.pendingMessageTokens ?? 0;
          }

          const modelStr = config.observationModel
            ? `obs=${config.observationModel} ref=${config.reflectionModel ?? config.model ?? 'default'}`
            : config.model ?? 'default';

          const lines = [
            `Observational Memory`,
            `Scope: ${record.scope}  |  Generations: ${record.generationCount ?? 0}  |  Model: ${modelStr}`,
            ``,
            `── Observation ──────────────────────────────`,
            `Unobserved: ${formatTokens(unobservedTokens)} / ${formatTokens(obsThreshold)} tokens`,
            progressBar(unobservedTokens, obsThreshold),
            ``,
            `── Reflection ──────────────────────────────`,
            `Observations: ${formatTokens(obsTokens)} / ${formatTokens(refThreshold)} tokens`,
            progressBar(obsTokens, refThreshold),
            ``,
            `── Status ──────────────────────────────────`,
            `Last observed: ${record.lastObservedAt ?? 'never'}`,
            `Observing: ${record.isObserving ? 'yes' : 'no'}  |  Reflecting: ${record.isReflecting ? 'yes' : 'no'}`,
            `Credentials: ${credentialsReady ? 'ready' : 'pending'}`,
            ...(lastError ? [`Last error: ${lastError}`] : []),
          ];

          return lines.join('\n');
        },
      }),

      om_observations: tool({
        description: 'Show the current active observations stored in Observational Memory.',
        args: {},
        async execute(_args, context) {
          const threadId = context.sessionID;
          const observations = await om.getObservations(threadId);
          return observations ?? 'No observations stored yet.';
        },
      }),

      om_observe: tool({
        description: 'Manually trigger an observation cycle right now, without waiting for the token threshold.',
        args: {},
        async execute(_args, context) {
          const threadId = context.sessionID;
          await resolveCredentials();
          try {
            const resp = await ctx.client.session.messages({ path: { id: threadId } });
            if (!resp.data || resp.data.length === 0) return 'No messages to observe.';
            const mastraMessages = convertMessages(resp.data, threadId);
            await backupObservations(threadId, 'pre-observe');
            await runObserve(threadId, mastraMessages);
            return 'Observation cycle triggered. Check memory_status for results.';
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            lastError = msg;
            return `Observation failed: ${msg}`;
          }
        },
      }),

      om_reflect: tool({
        description: 'Manually trigger a reflection cycle to condense accumulated observations.',
        args: {},
        async execute(_args, context) {
          const threadId = context.sessionID;
          await resolveCredentials();
          try {
            await backupObservations(threadId, 'pre-reflect');
            await om.reflect(threadId);
            return 'Reflection cycle triggered. Check memory_observations for results.';
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            lastError = msg;
            return `Reflection failed: ${msg}`;
          }
        },
      }),

      om_prune: tool({
        description: 'Prune already-observed messages from storage to free space.',
        args: {},
        async execute(_args, context) {
          const threadId = context.sessionID;
          try {
            const resp = await ctx.client.session.messages({ path: { id: threadId } });
            if (!resp.data) return 'Could not load messages.';
            const mastraMessages = convertMessages(resp.data, threadId);
            const remaining = await om.pruneObserved({ threadId, messages: mastraMessages });
            return `Pruned ${mastraMessages.length - remaining.length} observed messages, ${remaining.length} remaining.`;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return `Prune failed: ${msg}`;
          }
        },
      }),

      om_restore: tool({
        description: 'Restore observational memory from backup slot 1 (most recent) or slot 2 (one generation older).',
        args: { slot: { type: 'number', description: '1 = most recent backup, 2 = one generation older' } },
        async execute(_args, _context) {
          omLog('[restore] stubbed execute called');
          return 'stubbed';
        },
      }),

      om_config: tool({
        description: 'Show the current Mastra Observational Memory configuration.',
        args: {},
        async execute() {
          const omConfig = om.config;
          const redactedConfig = {
            ...config,
            apiKey: config.apiKey ? `${config.apiKey.slice(0, 8)}...` : undefined,
            storageUrl: config.storageUrl
              ? config.storageUrl.replace(/:\/\/[^@]+@/, '://<redacted>@')
              : undefined,
          };
          const lines = [
            `── Config (mastra.json) ─────────────────────`,
            JSON.stringify(redactedConfig, null, 2),
            ``,
            `── Resolved OM Settings ─────────────────────`,
            `Observation threshold: ${JSON.stringify(omConfig.observation.messageTokens)} tokens`,
            `Reflection threshold:  ${JSON.stringify(omConfig.reflection.observationTokens)} tokens`,
            `Scope: ${omConfig.scope ?? 'thread'}`,
            `Storage: ${config.storageUrl ? config.storageUrl.replace(/:\/\/[^@]+@/, '://<redacted>@') : `file:${join(ctx.directory, config.storagePath ?? DEFAULT_STORAGE_PATH)}`}`,
            `Credentials: ${credentialsReady ? 'ready' : 'pending'}`,
            ...(lastError ? [`Last error: ${lastError}`] : []),
          ];
          return lines.join('\n');
        },
      }),
    },
  };
};


