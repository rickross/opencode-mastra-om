import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  loadFrozenTranscript,
  parseArgs,
  reserveMemoryDatabase,
  runReplay,
  validateReplayPaths,
  type ReplayOptions,
} from './replay-opencode-session.js';

const root = await mkdtemp(resolve(tmpdir(), 'ace-274-selftest-'));
const sourceDb = resolve(root, 'frozen-opencode.db');
const memoryDb = resolve(root, 'memory.db');
const outDir = resolve(root, 'artifacts');
const sessionId = 'ses_ace_274';

function makeSourceDb(): void {
  const db = new Database(sourceDb, { create: true, strict: true });
  db.exec(`
    create table session (id text primary key, time_created integer not null, title text not null);
    create table message (id text primary key, session_id text not null, time_created integer not null, data text not null);
    create table part (id text primary key, message_id text not null, session_id text not null, time_created integer not null, data text not null);
  `);
  const start = Date.UTC(2026, 6, 1, 12, 0, 0);
  db.query('insert into session values (?, ?, ?)').run(sessionId, start, 'Frozen replay selftest');
  const insertMessage = db.query('insert into message values (?, ?, ?, ?)');
  const insertPart = db.query('insert into part values (?, ?, ?, ?, ?)');
  const messageTimes = [start, start + 1_000, start + 1_000, start + 3_000, start + 4_000, start + 5_000];
  for (const [index, role] of ['user', 'assistant', 'user', 'assistant', 'user', 'assistant'].entries()) {
    const id = `msg-${index + 1}`;
    const time = messageTimes[index]!;
    insertMessage.run(id, sessionId, time, JSON.stringify({ id, sessionID: sessionId, role, time: { created: time } }));
  }
  insertMessage.run('msg-unsupported', sessionId, start + 2_000, JSON.stringify({
    id: 'msg-unsupported',
    sessionID: sessionId,
    role: 'assistant',
    time: { created: start + 2_000 },
  }));
  insertMessage.run('msg-empty', sessionId, start + 2_500, JSON.stringify({
    id: 'msg-empty',
    sessionID: sessionId,
    role: 'assistant',
    time: { created: start + 2_500 },
  }));
  insertPart.run('part-1', 'msg-1', sessionId, start, JSON.stringify({ type: 'text', text: 'Remember alpha exactly.' }));
  insertPart.run('part-2', 'msg-2', sessionId, start + 1_000, JSON.stringify({
    type: 'tool',
    callID: 'current-tool-call',
    tool: 'read',
    state: { status: 'completed', input: { path: '/alpha' }, output: 'alpha output', title: 'Read alpha', metadata: {}, time: { start: start, end: start + 1 } },
  }));
  insertPart.run('part-3', 'msg-2', sessionId, start + 1_001, JSON.stringify({ type: 'text', text: 'Alpha is complete.' }));
  insertPart.run('part-4', 'msg-3', sessionId, start + 1_000, JSON.stringify({ type: 'text', text: 'Remember beta exactly.' }));
  insertPart.run('part-5', 'msg-4', sessionId, start + 3_000, JSON.stringify({
    type: 'tool-invocation',
    toolCallId: 'legacy-tool-call',
    toolName: 'write',
    args: { path: '/beta' },
    result: 'beta output',
    state: 'result',
  }));
  insertPart.run('part-6', 'msg-5', sessionId, start + 4_000, JSON.stringify({ type: 'text', text: 'Remember gamma exactly after reflection.' }));
  insertPart.run('part-7', 'msg-6', sessionId, start + 5_000, JSON.stringify({ type: 'text', text: 'Gamma is complete.' }));
  insertPart.run('part-unsupported', 'msg-unsupported', sessionId, start + 2_000, JSON.stringify({ type: 'snapshot', snapshot: 'not replayable' }));
  insertPart.run('part-empty-text', 'msg-empty', sessionId, start + 2_500, JSON.stringify({ type: 'text', text: '' }));
  insertPart.run('part-empty-reasoning', 'msg-empty', sessionId, start + 2_500, JSON.stringify({ type: 'reasoning', text: '   ' }));
  db.close();
}

const outputs = [
  '<observations>\n🔴 (12:00) User requested alpha be remembered; read tool returned alpha output.\n</observations>',
  '<observations>\n🔴 (12:00) User requested beta be remembered; write tool returned beta output.\n</observations>',
  '<observations>\n🔴 Alpha and beta are remembered, with both tool outcomes preserved.\n</observations>',
  '<observations>\n🔴 (12:00) User requested gamma be remembered after reflection.\n</observations>',
];
const requests: Array<{ url: string; body: string; authorization: string | null }> = [];
let requestIndex = 0;
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = await request.text();
    requests.push({ url: request.url, body, authorization: request.headers.get('authorization') });
    const output = outputs[requestIndex++];
    if (!output) return new Response('intentional selftest model failure', { status: 401 });
    const chunk = {
      id: `mock-${requestIndex}`,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'mock-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: output }, finish_reason: null }],
    };
    const done = {
      id: `mock-${requestIndex}`,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'mock-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    });
  },
});

try {
  makeSourceDb();

  const frozen = loadFrozenTranscript(sourceDb, sessionId, 'synthetic-thread');
  assert.equal(frozen.messages.length, 6);
  const bounded = loadFrozenTranscript(sourceDb, sessionId, 'bounded-thread', 4);
  assert.equal(bounded.messages.length, 4);
  assert.deepEqual(bounded.messages.map((message) => message.id), ['msg-1', 'msg-2', 'msg-3', 'msg-4']);
  assert(Object.isFrozen(frozen));
  assert.equal(frozen.session.data.title, 'Frozen replay selftest');
  const currentTool = frozen.messages[1]!.content.parts[0] as { type: string; toolInvocation: Record<string, unknown> };
  assert.equal(currentTool.type, 'tool-invocation');
  assert.deepEqual(currentTool.toolInvocation, {
    toolCallId: 'current-tool-call',
    toolName: 'read',
    args: { path: '/alpha' },
    state: 'result',
    result: 'alpha output',
  });
  assert.equal(frozen.sourceMessages[2]!.timestamp, frozen.sourceMessages[1]!.timestamp);
  assert.equal(frozen.sourceMessages[2]!.replayTimestampAdjustmentMs, 1);
  assert.notEqual(frozen.sourceMessages[2]!.replayTimestamp, frozen.sourceMessages[1]!.replayTimestamp);

  const cliArgs = [
    '--db', sourceDb,
    '--session', sessionId,
    '--out', resolve(root, 'cli-out'),
    '--memory-db', resolve(root, 'cli-memory.db'),
    '--observe-cutoffs', '1,2',
    '--reflect-after', '1',
    '--model', 'mock-model',
    '--model-url', `${server.url}v1`,
    '--api-key-env', 'ACE_274_TEST_KEY',
  ];
  assert.equal(parseArgs(cliArgs).apiKeyEnv, 'ACE_274_TEST_KEY');
  assert.throws(() => parseArgs([...cliArgs, '--api-key', 'exposed']), /mutually exclusive/);

  const base: ReplayOptions = {
    dbPath: sourceDb,
    sessionId,
    outDir,
    memoryDbPath: memoryDb,
    observeCutoffs: [2, 4, 6],
    reflectAfter: 2,
    model: 'mock-model',
    modelUrl: `${server.url}v1`,
    apiKey: 'selftest-secret',
    runId: 'selftest',
  };
  await assert.rejects(validateReplayPaths({ ...base, memoryDbPath: sourceDb }), /must not exist|differ from source/);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    await assert.rejects(
      validateReplayPaths({ ...base, memoryDbPath: `${sourceDb}${suffix}` }),
      /source database and its SQLite sidecars/,
    );
  }
  await mkdir(resolve(root, 'project', '.opencode', 'memory'), { recursive: true });
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    await assert.rejects(
      validateReplayPaths({
        ...base,
        memoryDbPath: resolve(root, 'project', '.opencode', 'memory', `observations.db${suffix}`),
      }),
      /live \.opencode\/memory\/observations\.db target or sidecar/,
    );
  }
  const reservationDb = resolve(root, 'reservation.db');
  await reserveMemoryDatabase(reservationDb);
  await assert.rejects(reserveMemoryDatabase(reservationDb), /already exists/);

  const result = await runReplay(base);
  assert.equal(requests.length, 4, 'three observations and one reflection must run sequentially');
  assert(requests.every((request) => request.authorization === 'Bearer selftest-secret'));
  assert(requests[0]!.body.includes('Remember alpha exactly'));
  assert(!requests[1]!.body.includes('Remember alpha exactly'), 'second cumulative cycle must not reprocess first cutoff');
  assert(requests[1]!.body.includes('Remember beta exactly'));
  assert(!requests[3]!.body.includes('Remember alpha exactly'), 'post-reflection cycle must not reprocess the first cutoff');
  assert(!requests[3]!.body.includes('Remember beta exactly'), 'post-reflection cycle must not reprocess the second cutoff');
  assert(requests[3]!.body.includes('Remember gamma exactly'));

  const observation1 = JSON.parse(await readFile(resolve(outDir, 'observation-001.json'), 'utf8'));
  const observation2 = JSON.parse(await readFile(resolve(outDir, 'observation-002.json'), 'utf8'));
  const reflection = JSON.parse(await readFile(resolve(outDir, 'reflection-after-002.json'), 'utf8'));
  const observation3 = JSON.parse(await readFile(resolve(outDir, 'observation-003.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
  const transcript = JSON.parse(await readFile(resolve(outDir, 'frozen-transcript.json'), 'utf8'));
  assert.equal(observation1.record.generationCount, 0);
  assert.equal(observation2.record.generationCount, 0);
  assert(observation2.record.activeObservations.includes('alpha'));
  assert(observation2.record.activeObservations.includes('beta'));
  assert.equal(reflection.record.generationCount, 1);
  assert(reflection.record.activeObservations.includes('Alpha and beta'));
  assert.equal(reflection.history.length, 2);
  assert.deepEqual(reflection.history.map((record: { generationCount: number }) => record.generationCount), [1, 0]);
  assert.equal(observation3.record.generationCount, 1);
  assert(observation3.record.activeObservations.includes('Alpha and beta'));
  assert(observation3.record.activeObservations.includes('gamma'));
  assert.equal(observation3.history.length, 2);
  assert.deepEqual(observation2.cutoffMessageIds, ['msg-1', 'msg-2', 'msg-3', 'msg-4']);
  assert.equal(transcript.sourceMessages[1].parts[0].data.type, 'tool');
  assert.equal(transcript.sourceMessages.length, 6);
  assert(!transcript.sourceMessages.some((message: { id: string }) => message.id === 'msg-unsupported'));
  assert(!transcript.sourceMessages.some((message: { id: string }) => message.id === 'msg-empty'));
  assert.equal(manifest.status, 'complete');
  assert.equal(manifest.packages['@mastra/memory'], '1.24.0');
  assert.equal(manifest.model.apiKeyProvided, true);
  assert(!JSON.stringify(manifest).includes('selftest-secret'));
  assert(manifest.artifacts.includes('reflection-after-002.json'));
  assert.match(manifest.source.selectedTranscriptSha256, /^[a-f0-9]{64}$/);
  assert.match(manifest.source.mainDatabaseFileSha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.integrity.files['frozen-transcript.json'].size, (await stat(resolve(outDir, 'frozen-transcript.json'))).size);
  assert.match(manifest.integrity.files['observation-001.json'].sha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.integrity.memoryDatabase.path, memoryDb);
  assert.match(manifest.integrity.memoryDatabase.sha256, /^[a-f0-9]{64}$/);
  assert((await stat(memoryDb)).size > 4_096, 'completed replay database must be checkpointed into its main file');

  const memory = new Database(memoryDb, { readonly: true });
  const generations = memory.query('select generationCount, activeObservations from mastra_observational_memory order by generationCount').all() as Array<{ generationCount: number; activeObservations: string }>;
  memory.close();
  assert(generations.some((row) => row.generationCount === 0 && row.activeObservations.includes('alpha')));
  assert(generations.some((row) => row.generationCount === 1 && row.activeObservations.includes('Alpha and beta')));

  const failedOutDir = resolve(root, 'failed-artifacts');
  const failedMemoryDb = resolve(root, 'failed-memory.db');
  await assert.rejects(runReplay({
    ...base,
    outDir: failedOutDir,
    memoryDbPath: failedMemoryDb,
    observeCutoffs: [1, 2],
    reflectAfter: 2,
    runId: 'intentional-failure',
  }));
  const failedManifest = JSON.parse(await readFile(resolve(failedOutDir, 'manifest.json'), 'utf8'));
  const failure = JSON.parse(await readFile(resolve(failedOutDir, 'failure.json'), 'utf8'));
  assert.equal(failedManifest.status, 'failed');
  assert(failedManifest.artifacts.includes('failure.json'));
  assert.match(failedManifest.integrity.files['failure.json'].sha256, /^[a-f0-9]{64}$/);
  assert.equal(failure.kind, 'failure');
  assert.match(failure.error, /401|intentional selftest model failure|authentication|unauthorized/i);
  assert(failure.debugEvents.some((event: { type: string }) => event.type === 'observation_triggered'));

  console.log(`ACE-274 replay selftest passed (${root})`);
} finally {
  server.stop(true);
}
