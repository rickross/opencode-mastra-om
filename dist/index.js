// src/index.ts
import { appendFileSync, mkdirSync } from "node:fs";
import { readFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { LibSQLStore } from "@mastra/libsql";
import {
  ObservationalMemory,
  TokenCounter,
  optimizeObservationsForContext,
  OBSERVATION_CONTINUATION_HINT,
  OBSERVATION_CONTEXT_PROMPT,
  OBSERVATION_CONTEXT_INSTRUCTIONS
} from "@mastra/memory/processors";
import { tool } from "@opencode-ai/plugin";
var CONFIG_FILE = ".opencode/mastra.json";
var DEFAULT_STORAGE_PATH = ".opencode/memory/observations.db";
var PROVIDER_ENV_VARS = {
  google: ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  xai: ["XAI_API_KEY"],
  groq: ["GROQ_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  fireworks: ["FIREWORKS_API_KEY"]
};
async function loadConfig(directory) {
  try {
    const configPath = join(directory, CONFIG_FILE);
    const raw = await readFile(configPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
function convertMessages(messages, sessionId) {
  return messages.map(({ info, parts }) => {
    const convertedParts = parts.map((part) => {
      const p = part;
      const type = p.type;
      if (type === "text" && p.text)
        return { type: "text", text: p.text };
      if (type === "tool-invocation")
        return { type: "tool-invocation", toolInvocation: { toolCallId: p.toolCallId, toolName: p.toolName, args: p.args, result: p.result, state: p.state } };
      if (type === "file")
        return { type: "file", url: p.url, mediaType: p.mediaType };
      if (type === "image")
        return { type: "image", image: p.image };
      if (type === "reasoning" && p.reasoning)
        return { type: "reasoning", reasoning: p.reasoning };
      if (type?.startsWith("data-om-"))
        return null;
      return null;
    }).filter((p) => p !== null);
    if (convertedParts.length === 0)
      return null;
    if (info.role !== "user" && info.role !== "assistant")
      return null;
    return {
      id: info.id,
      role: info.role,
      createdAt: new Date(info.time.created),
      threadId: sessionId,
      resourceId: sessionId,
      content: { format: 2, parts: convertedParts }
    };
  }).filter((m) => m !== null);
}
function progressBar(current, total, width = 20) {
  const pct = total > 0 ? Math.min(current / total, 1) : 0;
  const filled = Math.round(pct * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${(pct * 100).toFixed(1)}%`;
}
function formatTokens(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
function resolveThreshold(t) {
  return typeof t === "number" ? t : t.max;
}
var MastraPlugin = async (ctx) => {
  const config = await loadConfig(ctx.directory);
  let logFile = null;
  if (config.logPath) {
    logFile = join(ctx.directory, config.logPath);
    mkdirSync(dirname(logFile), { recursive: true });
  } else if (process.env.OM_DEBUG) {
    logFile = join(ctx.directory, ".opencode/memory/om.log");
    mkdirSync(dirname(logFile), { recursive: true });
  }
  const omLog = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}
`;
    if (logFile) {
      try {
        appendFileSync(logFile, line);
      } catch {}
    }
  };
  omLog(`[init] mastra-om plugin starting, pid=${process.pid}`);
  let lastError = null;
  let credentialsReady = false;
  const resolveCredentials = async () => {
    if (credentialsReady)
      return;
    if (config.apiKey) {
      const modelProvider = config.model?.split("/")[0];
      if (modelProvider) {
        const envVars = PROVIDER_ENV_VARS[modelProvider] ?? [`${modelProvider.toUpperCase()}_API_KEY`];
        for (const envVar of envVars) {
          process.env[envVar] = config.apiKey;
        }
        omLog(`[credentials] set ${envVars.join(", ")} from config.apiKey`);
      }
    }
    try {
      const providersResponse = await ctx.client.config.providers();
      if (providersResponse.data) {
        for (const provider of providersResponse.data.providers) {
          const key = provider.key ?? provider.apiKey ?? provider.token;
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
    omLog(`[credentials] resolved. GOOGLE_GENERATIVE_AI_API_KEY=${process.env.GOOGLE_GENERATIVE_AI_API_KEY ? "set" : "missing"}`);
  };
  let store;
  if (config.storageUrl && (config.storageUrl.startsWith("postgresql://") || config.storageUrl.startsWith("postgres://"))) {
    omLog(`[init] using PostgreSQL storage: ${config.storageUrl.replace(/:\/\/[^@]+@/, "://<redacted>@")}`);
    const pgMod = await new Function('return import("@mastra/pg")')();
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
    store = new LibSQLStore({ id: "mastra-om", url });
    await store.init();
  }
  const storage = await store.getStore("memory");
  if (!storage)
    throw new Error(`mastra-om: failed to initialize storage`);
  const omOptions = {
    storage,
    scope: config.scope,
    shareTokenBudget: config.shareTokenBudget,
    observation: {
      ...config.observation,
      ...config.observationModel ? { model: config.observationModel } : {}
    },
    reflection: {
      ...config.reflection,
      ...config.reflectionModel ? { model: config.reflectionModel } : {}
    }
  };
  if (config.model && !config.observationModel && !config.reflectionModel) {
    omOptions.model = config.model;
  }
  const om = new ObservationalMemory(omOptions);
  omLog(`[init] ObservationalMemory created, model=${config.model ?? "default"}`);
  setTimeout(() => {
    ctx.client.tui.showToast({
      body: { title: "Mastra OM", message: "Observational Memory active", variant: "success", duration: 3000 }
    });
  }, 500);
  const runObserve = async (sessionId, messages) => {
    await om.observe({
      threadId: sessionId,
      messages,
      hooks: {
        onObservationStart: () => {
          omLog(`[observe] starting observation`);
          ctx.client.tui.showToast({ body: { title: "Mastra OM", message: "Observing...", variant: "info", duration: 1e4 } });
        },
        onObservationEnd: () => {
          omLog(`[observe] observation complete`);
          ctx.client.tui.showToast({ body: { title: "Mastra OM", message: "Observation complete", variant: "success", duration: 3000 } });
        },
        onReflectionStart: () => {
          omLog(`[reflect] starting reflection`);
          ctx.client.tui.showToast({ body: { title: "Mastra OM", message: "Reflecting...", variant: "info", duration: 1e4 } });
        },
        onReflectionEnd: () => {
          omLog(`[reflect] reflection complete`);
          ctx.client.tui.showToast({ body: { title: "Mastra OM", message: "Reflection complete", variant: "success", duration: 3000 } });
        }
      }
    });
  };
  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
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
    "experimental.chat.messages.transform": async (_input, output) => {
      const sessionId = output.messages[0]?.info.sessionID;
      if (!sessionId)
        return;
      await resolveCredentials();
      try {
        const mastraMessages = convertMessages(output.messages, sessionId);
        if (mastraMessages.length > 0) {
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
        ctx.client.tui.showToast({
          body: { title: "Mastra OM", message: `Error: ${lastError}`, variant: "error", duration: 5000 }
        });
      }
    },
    "experimental.chat.system.transform": async (input, output) => {
      const sessionId = input.sessionID;
      if (!sessionId)
        return;
      try {
        const observations = await om.getObservations(sessionId);
        if (!observations)
          return;
        const optimized = optimizeObservationsForContext(observations);
        output.system.push(`${OBSERVATION_CONTEXT_PROMPT}

<observations>
${optimized}
</observations>

${OBSERVATION_CONTEXT_INSTRUCTIONS}

${OBSERVATION_CONTINUATION_HINT}`);
      } catch {}
    },
    tool: {
      om_status: tool({
        description: "Show Observational Memory progress — how close the session is to the next observation and reflection cycle.",
        args: {},
        async execute(_args, context) {
          const threadId = context.sessionID;
          const record = await om.getRecord(threadId);
          if (!record)
            return "No Observational Memory record found for this session.";
          const omConfig = om.config;
          const obsThreshold = resolveThreshold(omConfig.observation.messageTokens);
          const refThreshold = resolveThreshold(omConfig.reflection.observationTokens);
          const obsTokens = record.observationTokenCount ?? 0;
          const tokenCounter = new TokenCounter;
          let unobservedTokens = 0;
          try {
            const resp = await ctx.client.session.messages({ path: { id: threadId } });
            if (resp.data) {
              const allMastra = convertMessages(resp.data, threadId);
              const unobserved = record.lastObservedAt ? allMastra.filter((m) => m.createdAt > new Date(record.lastObservedAt)) : allMastra;
              unobservedTokens = tokenCounter.countMessages(unobserved);
            }
          } catch {
            unobservedTokens = record.pendingMessageTokens ?? 0;
          }
          const modelStr = config.observationModel ? `obs=${config.observationModel} ref=${config.reflectionModel ?? config.model ?? "default"}` : config.model ?? "default";
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
            `Last observed: ${record.lastObservedAt ?? "never"}`,
            `Observing: ${record.isObserving ? "yes" : "no"}  |  Reflecting: ${record.isReflecting ? "yes" : "no"}`,
            `Credentials: ${credentialsReady ? "ready" : "pending"}`,
            ...lastError ? [`Last error: ${lastError}`] : []
          ];
          return lines.join(`
`);
        }
      }),
      om_observations: tool({
        description: "Show the current active observations stored in Observational Memory.",
        args: {},
        async execute(_args, context) {
          const threadId = context.sessionID;
          const observations = await om.getObservations(threadId);
          return observations ?? "No observations stored yet.";
        }
      }),
      om_observe: tool({
        description: "Manually trigger an observation cycle right now, without waiting for the token threshold.",
        args: {},
        async execute(_args, context) {
          const threadId = context.sessionID;
          await resolveCredentials();
          try {
            const resp = await ctx.client.session.messages({ path: { id: threadId } });
            if (!resp.data || resp.data.length === 0)
              return "No messages to observe.";
            const mastraMessages = convertMessages(resp.data, threadId);
            await runObserve(threadId, mastraMessages);
            return "Observation cycle triggered. Check memory_status for results.";
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            lastError = msg;
            return `Observation failed: ${msg}`;
          }
        }
      }),
      om_reflect: tool({
        description: "Manually trigger a reflection cycle to condense accumulated observations.",
        args: {},
        async execute(_args, context) {
          const threadId = context.sessionID;
          await resolveCredentials();
          try {
            await om.reflect(threadId);
            return "Reflection cycle triggered. Check memory_observations for results.";
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            lastError = msg;
            return `Reflection failed: ${msg}`;
          }
        }
      }),
      om_prune: tool({
        description: "Prune already-observed messages from storage to free space.",
        args: {},
        async execute(_args, context) {
          const threadId = context.sessionID;
          try {
            const resp = await ctx.client.session.messages({ path: { id: threadId } });
            if (!resp.data)
              return "Could not load messages.";
            const mastraMessages = convertMessages(resp.data, threadId);
            const remaining = await om.pruneObserved({ threadId, messages: mastraMessages });
            return `Pruned ${mastraMessages.length - remaining.length} observed messages, ${remaining.length} remaining.`;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return `Prune failed: ${msg}`;
          }
        }
      }),
      om_config: tool({
        description: "Show the current Mastra Observational Memory configuration.",
        args: {},
        async execute() {
          const omConfig = om.config;
          const redactedConfig = {
            ...config,
            apiKey: config.apiKey ? `${config.apiKey.slice(0, 8)}...` : undefined,
            storageUrl: config.storageUrl ? config.storageUrl.replace(/:\/\/[^@]+@/, "://<redacted>@") : undefined
          };
          const lines = [
            `── Config (mastra.json) ─────────────────────`,
            JSON.stringify(redactedConfig, null, 2),
            ``,
            `── Resolved OM Settings ─────────────────────`,
            `Observation threshold: ${JSON.stringify(omConfig.observation.messageTokens)} tokens`,
            `Reflection threshold:  ${JSON.stringify(omConfig.reflection.observationTokens)} tokens`,
            `Scope: ${omConfig.scope ?? "thread"}`,
            `Storage: ${config.storageUrl ? config.storageUrl.replace(/:\/\/[^@]+@/, "://<redacted>@") : `file:${join(ctx.directory, config.storagePath ?? DEFAULT_STORAGE_PATH)}`}`,
            `Credentials: ${credentialsReady ? "ready" : "pending"}`,
            ...lastError ? [`Last error: ${lastError}`] : []
          ];
          return lines.join(`
`);
        }
      })
    }
  };
};
export {
  MastraPlugin
};
