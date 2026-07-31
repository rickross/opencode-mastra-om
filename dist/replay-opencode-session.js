// @bun
// src/replay-opencode-session.ts
import { createHash } from "crypto";
import { createReadStream, existsSync } from "fs";
import { mkdir, open, realpath, stat, writeFile } from "fs/promises";
import { basename, dirname, resolve } from "path";
import corePackage from "@mastra/core/package.json" with { type: "json" };
import { LibSQLStore } from "@mastra/libsql";
import libsqlPackage from "@mastra/libsql/package.json" with { type: "json" };
import {
  ObservationalMemory
} from "@mastra/memory/processors";
import memoryPackage from "@mastra/memory/package.json" with { type: "json" };
import { Database } from "bun:sqlite";
function usage() {
  throw new Error([
    "Usage: bun run replay:opencode -- --db <source.db> --session <id> --out <dir> --memory-db <db> --observe-cutoffs <counts> --reflect-after <cycle> --model <name> --model-url <url> [options]",
    "",
    "Required:",
    "  --db <path>                 Frozen OpenCode SQLite database",
    "  --session <id>              OpenCode session ID",
    "  --out <dir>                 New artifact directory",
    "  --memory-db <path>          New disposable LibSQL database",
    "  --observe-cutoffs <n,n,...> Increasing cumulative message counts (at least two)",
    "  --reflect-after <n>         Reflect after this 1-based observation cycle",
    "  --model <name>               Model name sent to the compatible endpoint",
    "  --model-url <url>            OpenAI-compatible base URL",
    "",
    "Optional:",
    "  --api-key-env <name>         Read the API key from this environment variable",
    "  --api-key <key>              Discouraged; exposed in process listings",
    "  --run-id <id>                Default: replay-<timestamp>"
  ].join(`
`));
}
function getArg(args, name) {
  const index = args.indexOf(name);
  if (index < 0)
    return;
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    usage();
  return value;
}
function parseArgs(args) {
  const required = (name) => getArg(args, name) ?? usage();
  const cutoffs = required("--observe-cutoffs").split(",").map((raw) => Number(raw));
  if (cutoffs.length < 2 || cutoffs.some((value) => !Number.isInteger(value) || value <= 0)) {
    throw new Error("--observe-cutoffs must contain at least two comma-separated positive integers");
  }
  if (cutoffs.some((value, index) => index > 0 && value <= cutoffs[index - 1])) {
    throw new Error("--observe-cutoffs must be strictly increasing cumulative message counts");
  }
  const reflectAfter = Number(required("--reflect-after"));
  if (!Number.isInteger(reflectAfter) || reflectAfter < 1 || reflectAfter > cutoffs.length) {
    throw new Error("--reflect-after must identify a 1-based observation cycle");
  }
  const apiKey = getArg(args, "--api-key");
  const apiKeyEnv = getArg(args, "--api-key-env");
  if (apiKey && apiKeyEnv)
    throw new Error("--api-key and --api-key-env are mutually exclusive");
  if (apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
    throw new Error("--api-key-env must be a valid environment variable name");
  }
  return {
    dbPath: resolve(required("--db")),
    sessionId: required("--session"),
    outDir: resolve(required("--out")),
    memoryDbPath: resolve(required("--memory-db")),
    observeCutoffs: cutoffs,
    reflectAfter,
    model: required("--model"),
    modelUrl: required("--model-url").replace(/\/$/, ""),
    apiKey,
    apiKeyEnv,
    runId: getArg(args, "--run-id")
  };
}
function parseObject(label, raw) {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("expected an object");
    return value;
  } catch (error) {
    throw new Error(`Invalid JSON in ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function timestamp(value, fallback) {
  const millis = typeof value === "number" ? value : fallback;
  if (!millis || !Number.isFinite(millis))
    throw new Error(`Invalid or missing message timestamp: ${String(millis)}`);
  return new Date(millis);
}
function invocationState(value) {
  if (value === "completed" || value === "result")
    return "result";
  if (value === "error" || value === "output-error")
    return "output-error";
  if (value === "pending" || value === "partial-call")
    return "partial-call";
  return "call";
}
function toolPart(part, createdAt) {
  const legacy = part.toolInvocation && typeof part.toolInvocation === "object" ? part.toolInvocation : part;
  const stateObject = part.state && typeof part.state === "object" ? part.state : undefined;
  const stateValue = stateObject?.status ?? legacy.state;
  const state = invocationState(stateValue);
  const toolCallId = String(part.callID ?? legacy.toolCallId ?? "");
  const toolName = String(part.tool ?? legacy.toolName ?? "");
  if (!toolCallId || !toolName)
    return null;
  const args = stateObject?.input ?? legacy.args ?? {};
  const base = { toolCallId, toolName, args, state };
  const toolInvocation = state === "result" ? { ...base, state, result: stateObject?.output ?? legacy.result } : state === "output-error" ? { ...base, state, errorText: String(stateObject?.error ?? legacy.errorText ?? "Tool failed") } : base;
  return { type: "tool-invocation", toolInvocation, createdAt };
}
function convertPart(part, createdAt) {
  const type = part.type;
  if (type === "text" && typeof part.text === "string") {
    return part.text.trim().length > 0 ? { type: "text", text: part.text, createdAt } : null;
  }
  if (type === "reasoning") {
    const reasoning = typeof part.reasoning === "string" ? part.reasoning : part.text;
    return typeof reasoning === "string" && reasoning.trim().length > 0 ? { type: "reasoning", reasoning, createdAt } : null;
  }
  if (type === "tool" || type === "tool-invocation")
    return toolPart(part, createdAt);
  if (type === "file" && typeof part.url === "string") {
    return {
      type: "file",
      data: part.url,
      mimeType: String(part.mime ?? part.mediaType ?? "application/octet-stream"),
      createdAt
    };
  }
  if (type === "image") {
    const image = part.image ?? part.url;
    return image !== undefined ? { type: "image", image, createdAt } : null;
  }
  return null;
}
function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value))
      freezeDeep(child);
  }
  return value;
}
function loadFrozenTranscript(dbPath, sessionId, replayThreadId, maxMessages) {
  const db = new Database(dbPath, { readonly: true, strict: true });
  try {
    const sessionRow = db.query("select * from session where id = ?").get(sessionId);
    if (!sessionRow)
      throw new Error(`Session not found in source database: ${sessionId}`);
    const sourceMessages = [];
    const messages = [];
    let cursor;
    let previousReplayMillis = Number.NEGATIVE_INFINITY;
    const chunkSize = 200;
    while (maxMessages === undefined || messages.length < maxMessages) {
      const rows = cursor ? db.query(`
            select id, session_id, time_created, data
            from message
            where session_id = ? and (time_created > ? or (time_created = ? and id > ?))
            order by time_created asc, id asc
            limit ?
          `).all(sessionId, cursor.time, cursor.time, cursor.id, chunkSize) : db.query(`
            select id, session_id, time_created, data
            from message where session_id = ?
            order by time_created asc, id asc
            limit ?
          `).all(sessionId, chunkSize);
      if (rows.length === 0)
        break;
      const lastRow = rows.at(-1);
      cursor = { time: lastRow.time_created, id: lastRow.id };
      const placeholders = rows.map(() => "?").join(",");
      const partRows = db.query(`
        select id, message_id, session_id, time_created, data
        from part
        where session_id = ? and message_id in (${placeholders})
        order by time_created asc, id asc
      `).all(sessionId, ...rows.map((row) => row.id));
      const partsByMessage = new Map;
      for (const row of partRows)
        partsByMessage.set(row.message_id, [...partsByMessage.get(row.message_id) ?? [], row]);
      for (const row of rows) {
        const data = parseObject(`message ${row.id}`, row.data);
        const role = String(data.role ?? "");
        const originalCreatedAt = timestamp(data.time?.created, row.time_created);
        const rawParts = (partsByMessage.get(row.id) ?? []).map((partRow) => ({
          id: partRow.id,
          timestamp: typeof partRow.time_created === "number" ? new Date(partRow.time_created).toISOString() : null,
          data: parseObject(`part ${partRow.id}`, partRow.data)
        }));
        const parts = rawParts.map((part) => convertPart(part.data, part.timestamp ? Date.parse(part.timestamp) : undefined)).filter((part) => part !== null);
        if (parts.length === 0)
          continue;
        if (!["user", "assistant", "system", "signal"].includes(role)) {
          throw new Error(`Unsupported role ${JSON.stringify(role)} on message ${row.id}`);
        }
        const originalMillis = originalCreatedAt.getTime();
        const replayMillis = Math.max(originalMillis, previousReplayMillis + 1);
        previousReplayMillis = replayMillis;
        const createdAt = new Date(replayMillis);
        sourceMessages.push({
          id: row.id,
          role,
          timestamp: originalCreatedAt.toISOString(),
          replayTimestamp: createdAt.toISOString(),
          replayTimestampAdjustmentMs: replayMillis - originalMillis,
          data,
          parts: rawParts
        });
        messages.push({
          id: row.id,
          role,
          createdAt,
          threadId: replayThreadId,
          resourceId: replayThreadId,
          content: { format: 2, parts }
        });
        if (maxMessages !== undefined && messages.length >= maxMessages)
          break;
      }
    }
    const sessionData = typeof sessionRow.data === "string" ? parseObject(`session ${sessionId}`, sessionRow.data) : Object.fromEntries(Object.entries(sessionRow).filter(([key]) => key !== "id"));
    return freezeDeep({ session: { id: sessionId, data: sessionData }, messages, sourceMessages });
  } finally {
    db.close();
  }
}
function sqliteFamily(path) {
  return [path, `${path}-wal`, `${path}-shm`, `${path}-journal`];
}
function liveMemoryFamily(path) {
  return /(?:^|\/)\.opencode\/memory\/observations\.db(?:-(?:wal|shm|journal))?$/.test(path.replaceAll("\\", "/"));
}
async function canonicalizeMissingPath(path) {
  let current = resolve(path);
  const missing = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current)
      break;
    missing.unshift(basename(current));
    current = parent;
  }
  const existing = existsSync(current) ? await realpath(current) : current;
  return resolve(existing, ...missing);
}
async function validateReplayPaths(options) {
  if (!existsSync(options.dbPath))
    throw new Error(`Source database does not exist: ${options.dbPath}`);
  if (existsSync(options.memoryDbPath))
    throw new Error(`Memory database must not exist: ${options.memoryDbPath}`);
  if (existsSync(options.outDir))
    throw new Error(`Output directory must not exist: ${options.outDir}`);
  if (resolve(options.memoryDbPath) === resolve(options.outDir)) {
    throw new Error("Memory database path must differ from output directory");
  }
  const sourceRealPath = await realpath(options.dbPath);
  const memoryRealPath = await canonicalizeMissingPath(options.memoryDbPath);
  if (sqliteFamily(sourceRealPath).includes(memoryRealPath)) {
    throw new Error("Memory database must differ from the source database and its SQLite sidecars");
  }
  if (liveMemoryFamily(resolve(options.memoryDbPath)) || liveMemoryFamily(memoryRealPath)) {
    throw new Error("Refusing to use a live .opencode/memory/observations.db target or sidecar");
  }
}
async function reserveMemoryDatabase(path) {
  let handle;
  try {
    handle = await open(path, "wx");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "EEXIST")
      throw new Error(`Memory database already exists: ${path}`);
    throw error;
  }
  await handle.close();
}
async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path))
    hash.update(chunk);
  return hash.digest("hex");
}
function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => item instanceof Date ? item.toISOString() : item));
}
async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(jsonSafe(value), null, 2)}
`);
}
async function fileIntegrity(path) {
  const info = await stat(path);
  return { sha256: await sha256File(path), size: info.size };
}
async function artifactIntegrity(outDir, artifacts, memoryDbPath) {
  return {
    files: Object.fromEntries(await Promise.all(artifacts.map(async (artifact) => [artifact, await fileIntegrity(resolve(outDir, artifact))]))),
    memoryDatabase: memoryDbPath ? { path: memoryDbPath, ...await fileIntegrity(memoryDbPath) } : null
  };
}
function sanitizedModelUrl(raw) {
  const url = new URL(raw);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}
function checkpointMemoryDatabase(path) {
  const db = new Database(path, { strict: true });
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}
function recordArtifact(record) {
  if (!record)
    throw new Error("Mastra returned no observational memory record");
  return {
    activeObservations: record.activeObservations,
    observationTokenCount: record.observationTokenCount,
    generationCount: record.generationCount,
    lastObservedAt: record.lastObservedAt?.toISOString() ?? null,
    observedMessageIds: record.observedMessageIds ?? [],
    totalTokensObserved: record.totalTokensObserved
  };
}
async function historyArtifact(om, threadId) {
  const history = await om.getHistory(threadId);
  return history.map(recordArtifact);
}
async function runReplay(input) {
  if (input.apiKey !== undefined && input.apiKeyEnv) {
    throw new Error("apiKey and apiKeyEnv are mutually exclusive");
  }
  const environmentApiKey = input.apiKeyEnv ? process.env[input.apiKeyEnv] : undefined;
  if (input.apiKeyEnv && environmentApiKey === undefined) {
    throw new Error(`API key environment variable is not set: ${input.apiKeyEnv}`);
  }
  const options = {
    ...input,
    dbPath: resolve(input.dbPath),
    outDir: resolve(input.outDir),
    memoryDbPath: resolve(input.memoryDbPath),
    apiKey: input.apiKey ?? environmentApiKey ?? "EMPTY",
    runId: input.runId ?? `replay-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`
  };
  await validateReplayPaths(options);
  const replayThreadId = `ace-274-replay:${options.runId}`;
  const maxCutoff = options.observeCutoffs.at(-1);
  const transcript = loadFrozenTranscript(options.dbPath, options.sessionId, replayThreadId, maxCutoff);
  if (maxCutoff > transcript.messages.length) {
    throw new Error(`Largest cutoff ${maxCutoff} exceeds ${transcript.messages.length} replayable messages`);
  }
  const transcriptJson = `${JSON.stringify(jsonSafe(transcript), null, 2)}
`;
  const sourceMainFileSha256 = await sha256File(options.dbPath);
  const transcriptSha256 = createHash("sha256").update(transcriptJson).digest("hex");
  await mkdir(options.outDir);
  await mkdir(dirname(options.memoryDbPath), { recursive: true });
  await writeFile(resolve(options.outDir, "frozen-transcript.json"), transcriptJson);
  const artifacts = ["frozen-transcript.json"];
  const manifest = {
    status: "running",
    runId: options.runId,
    replayThreadId,
    packages: {
      "@mastra/core": corePackage.version,
      "@mastra/libsql": libsqlPackage.version,
      "@mastra/memory": memoryPackage.version
    },
    source: {
      databasePath: options.dbPath,
      mainDatabaseFileSha256: sourceMainFileSha256,
      mainDatabaseFileHashScope: "SQLite main file only; WAL, SHM, and journal sidecars are excluded.",
      sessionId: options.sessionId,
      selectedTranscriptSha256: transcriptSha256,
      selectedTranscriptIdentity: "Authoritative identity of the replayed source prefix.",
      messages: transcript.sourceMessages.map(({ id, role, timestamp: timestamp2, replayTimestamp, replayTimestampAdjustmentMs }) => ({
        id,
        role,
        timestamp: timestamp2,
        replayTimestamp,
        replayTimestampAdjustmentMs
      }))
    },
    model: { name: options.model, url: sanitizedModelUrl(options.modelUrl), apiKeyProvided: options.apiKey !== "EMPTY" },
    memoryDatabasePath: options.memoryDbPath,
    observeCutoffs: options.observeCutoffs,
    reflectAfter: options.reflectAfter,
    rawModelExchange: {
      observation: "Public onDebugEvent messages/rawObserverOutput/usage are stored per cycle.",
      reflection: "Public API exposes reflection output and usage, but not the full reflector prompt; prompt omitted."
    },
    artifacts
  };
  const manifestPath = resolve(options.outDir, "manifest.json");
  await writeJson(manifestPath, manifest);
  let store;
  let reservedMemory = false;
  let debugEvents = [];
  try {
    await reserveMemoryDatabase(options.memoryDbPath);
    reservedMemory = true;
    store = new LibSQLStore({ id: `ace-274-${options.runId}`, url: `file:${options.memoryDbPath}` });
    await store.init();
    const storage = await store.getStore("memory");
    if (!storage)
      throw new Error("Failed to initialize disposable Mastra memory storage");
    const om = new ObservationalMemory({
      storage,
      scope: "thread",
      model: {
        providerId: "ace-274-replay",
        modelId: options.model,
        url: options.modelUrl,
        apiKey: options.apiKey
      },
      observation: { messageTokens: 1, bufferTokens: false },
      reflection: { observationTokens: 1e9 },
      onDebugEvent: (event) => debugEvents.push(event)
    });
    for (let index = 0;index < options.observeCutoffs.length; index++) {
      const cycle = index + 1;
      const cutoff = options.observeCutoffs[index];
      debugEvents = [];
      let hookUsage;
      const result = await om.observe({
        threadId: replayThreadId,
        messages: structuredClone(transcript.messages.slice(0, cutoff)),
        hooks: { onObservationEnd: (hook) => {
          hookUsage = hook.usage;
        } }
      });
      if (!result.observed)
        throw new Error(`Observation cycle ${cycle} did not observe`);
      if (result.reflected)
        throw new Error(`Observation cycle ${cycle} unexpectedly auto-reflected`);
      const first = transcript.messages[0];
      const last = transcript.messages[cutoff - 1];
      const artifact = `observation-${String(cycle).padStart(3, "0")}.json`;
      await writeJson(resolve(options.outDir, artifact), {
        kind: "observation",
        cycle,
        cutoff,
        cutoffMessageIds: transcript.messages.slice(0, cutoff).map((message) => message.id),
        cutoffStartTimestamp: first.createdAt.toISOString(),
        cutoffEndTimestamp: last.createdAt.toISOString(),
        usage: hookUsage ?? null,
        record: recordArtifact(result.record),
        history: await historyArtifact(om, replayThreadId),
        debugEvents
      });
      artifacts.push(artifact);
      if (cycle === options.reflectAfter) {
        debugEvents = [];
        const reflection = await om.reflect(replayThreadId);
        if (!reflection.reflected)
          throw new Error(`Reflection after cycle ${cycle} did not reflect`);
        const reflectionArtifact = `reflection-after-${String(cycle).padStart(3, "0")}.json`;
        await writeJson(resolve(options.outDir, reflectionArtifact), {
          kind: "reflection",
          afterCycle: cycle,
          cutoff,
          cutoffMessageIds: transcript.messages.slice(0, cutoff).map((message) => message.id),
          cutoffStartTimestamp: first.createdAt.toISOString(),
          cutoffEndTimestamp: last.createdAt.toISOString(),
          usage: reflection.usage ?? null,
          output: reflection.record.activeObservations,
          record: recordArtifact(reflection.record),
          history: await historyArtifact(om, replayThreadId),
          debugEvents
        });
        artifacts.push(reflectionArtifact);
      }
    }
    await store.close();
    checkpointMemoryDatabase(options.memoryDbPath);
    manifest.status = "complete";
    manifest.completedAt = new Date().toISOString();
    manifest.artifacts = artifacts;
    manifest.integrity = await artifactIntegrity(options.outDir, artifacts, options.memoryDbPath);
    await writeJson(manifestPath, manifest);
    return { manifestPath, replayThreadId };
  } catch (error) {
    await store?.close().catch(() => {
      return;
    });
    if (reservedMemory) {
      try {
        checkpointMemoryDatabase(options.memoryDbPath);
      } catch {}
    }
    const failureArtifact = "failure.json";
    await writeJson(resolve(options.outDir, failureArtifact), {
      kind: "failure",
      error: error instanceof Error ? error.message : String(error),
      debugEvents
    });
    artifacts.push(failureArtifact);
    manifest.status = "failed";
    manifest.error = error instanceof Error ? error.message : String(error);
    manifest.artifacts = artifacts;
    manifest.integrity = await artifactIntegrity(options.outDir, artifacts, reservedMemory && existsSync(options.memoryDbPath) ? options.memoryDbPath : undefined);
    await writeJson(manifestPath, manifest);
    throw error;
  }
}
if (import.meta.main) {
  await runReplay(parseArgs(process.argv.slice(2)));
}
export {
  validateReplayPaths,
  runReplay,
  reserveMemoryDatabase,
  parseArgs,
  loadFrozenTranscript
};
