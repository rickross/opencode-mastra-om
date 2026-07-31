import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { loadIrlFixtureTranscript } from './replay-irl-fixture.js';

const root = await mkdtemp(resolve(tmpdir(), 'irl-583-fixture-selftest-'));
const fixturePath = resolve(root, 'A04.jsonl');
const fixture = `# fixture_id: A04
# provenance_class: synthetic
{"record_type":"utterance","message_id":"msg-1","turn_id":"turn-1","session_id":"session-1","seq":1,"role":"user","content":"Earl grey is current.","created_at":"2026-07-11T09:00:00Z","model":null}
{"record_type":"utterance","message_id":"msg-2","turn_id":"turn-1","session_id":"session-1","seq":2,"role":"assistant","content":"I will remember that.","created_at":"2026-07-11T09:00:00Z","model":"test-model"}
{"record_type":"utterance","message_id":"msg-3","turn_id":null,"session_id":"session-1","seq":3,"role":"assistant","content":"{\\"format\\":2,\\"parts\\":[{\\"type\\":\\"data-om-progress\\",\\"data\\":{\\"pendingTokens\\":10}},{\\"type\\":\\"reasoning\\",\\"reasoning\\":\\"\\"},{\\"type\\":\\"tool-invocation\\",\\"toolInvocation\\":{\\"toolName\\":\\"search\\"}}]}","created_at":"2026-07-11T09:00:01Z","model":"test-model"}
{"record_type":"expect","after_turn_id":"turn-1","must_include":[{"statement_contains":"earl grey"}],"must_not_include":[],"failure_codes_if_violated":["S-MISS"]}
{"record_type":"continuity_probe","probe_id":"D02a","user_message":"Which tea?","pass_if_reply_includes":["earl grey"],"fail_if_reply_includes":[],"slab_required":true}
`;
await writeFile(fixturePath, fixture);

const first = await loadIrlFixtureTranscript(fixturePath, 'replay-thread-a');
const second = await loadIrlFixtureTranscript(fixturePath, 'replay-thread-b');
assert(Object.isFrozen(first));
assert.equal(first.metadata.fixture_id, 'A04');
assert.equal(first.transcript.session.id, 'session-1');
assert.deepEqual(first.provenance.orderedMessageIds, ['msg-1', 'msg-2']);
assert.match(first.provenance.fixtureFileSha256, /^[a-f0-9]{64}$/);
assert.match(first.provenance.selectedSourceSha256, /^[a-f0-9]{64}$/);
assert.equal(first.provenance.selectedSourceSha256, '09bac81e23f475aff52845b6fb84acdaf0008902cf4a3d899dbfd0016d983c80');
assert.equal(first.provenance.selectedSourceSha256, second.provenance.selectedSourceSha256);
assert.match(first.provenance.sourceCorpusSha256, /^[a-f0-9]{64}$/);
assert.deepEqual(first.provenance.quarantinedUtterances, [
  { messageId: 'msg-3', reason: 'serialized_message_envelope_without_conversational_text' },
]);
assert.equal(first.transcript.messages[0]!.threadId, 'replay-thread-a');
assert.equal(second.transcript.messages[0]!.threadId, 'replay-thread-b');
assert.equal(first.transcript.sourceMessages[1]!.replayTimestampAdjustmentMs, 1);
assert.equal(first.expectations.length, 1);
assert.equal(first.continuityProbes.length, 1);
assert.equal(first.transcript.sourceMessages[0]!.data.content, 'Earl grey is current.');
assert(!JSON.stringify(first.transcript.messages).includes('Which tea?'));
assert(!JSON.stringify(first.transcript.messages).includes('pendingTokens'));

const changedPath = resolve(root, 'changed.jsonl');
await writeFile(changedPath, fixture.replace('Earl grey is current.', 'Genmaicha is current.'));
const changed = await loadIrlFixtureTranscript(changedPath, 'replay-thread-a');
assert.notEqual(first.provenance.selectedSourceSha256, changed.provenance.selectedSourceSha256);

const duplicatePath = resolve(root, 'duplicate.jsonl');
await writeFile(duplicatePath, fixture.replace('"message_id":"msg-2"', '"message_id":"msg-1"'));
await assert.rejects(loadIrlFixtureTranscript(duplicatePath, 'replay-thread'), /duplicate message_id/);

const mixedSessionPath = resolve(root, 'mixed-session.jsonl');
await writeFile(mixedSessionPath, fixture.replace('"session_id":"session-1","seq":2', '"session_id":"session-2","seq":2'));
await assert.rejects(loadIrlFixtureTranscript(mixedSessionPath, 'replay-thread'), /exactly one session_id/);

const invalidSeqPath = resolve(root, 'invalid-seq.jsonl');
await writeFile(invalidSeqPath, fixture.replace('"seq":2', '"seq":1'));
await assert.rejects(loadIrlFixtureTranscript(invalidSeqPath, 'replay-thread'), /strictly increasing/);

const systemRolePath = resolve(root, 'system-role.jsonl');
await writeFile(systemRolePath, fixture.replace('"role":"user"', '"role":"system"'));
await assert.rejects(loadIrlFixtureTranscript(systemRolePath, 'replay-thread'), /unsupported role/);

const malformedExpectPath = resolve(root, 'malformed-expect.jsonl');
await writeFile(malformedExpectPath, fixture.replace(
  '{"record_type":"expect","after_turn_id":"turn-1","must_include":[{"statement_contains":"earl grey"}],"must_not_include":[],"failure_codes_if_violated":["S-MISS"]}',
  '{"record_type":"expect"}',
));
await assert.rejects(loadIrlFixtureTranscript(malformedExpectPath, 'replay-thread'), /invalid after_turn_id/);

const badTimestampPath = resolve(root, 'bad-timestamp.jsonl');
await writeFile(badTimestampPath, fixture.replace('2026-07-11T09:00:00Z', '2026-07-11T09:00:00'));
await assert.rejects(loadIrlFixtureTranscript(badTimestampPath, 'replay-thread'), /invalid created_at/);

const impossibleDatePath = resolve(root, 'impossible-date.jsonl');
await writeFile(impossibleDatePath, fixture.replace('2026-07-11T09:00:00Z', '2026-04-31T09:00:00Z'));
await assert.rejects(loadIrlFixtureTranscript(impossibleDatePath, 'replay-thread'), /invalid created_at/);

const unknownTurnPath = resolve(root, 'unknown-turn.jsonl');
await writeFile(unknownTurnPath, fixture.replace('"after_turn_id":"turn-1"', '"after_turn_id":"unknown-turn"'));
await assert.rejects(loadIrlFixtureTranscript(unknownTurnPath, 'replay-thread'), /unknown turn/);

const unsafeNumberPath = resolve(root, 'unsafe-number.jsonl');
await writeFile(unsafeNumberPath, fixture.replace('"seq":1', '"seq":1e400'));
await assert.rejects(loadIrlFixtureTranscript(unsafeNumberPath, 'replay-thread'), /non-finite or unsafe integer/);

const malformedEnvelopePath = resolve(root, 'malformed-envelope.jsonl');
await writeFile(malformedEnvelopePath, `# fixture_id: malformed-envelope
{"record_type":"utterance","message_id":"msg-envelope","turn_id":null,"session_id":"session-1","seq":1,"role":"assistant","content":"{\\"format\\":2,\\"parts\\":\\"tool trace\\"}","created_at":"2026-07-11T09:00:00Z","model":"test-model"}
`);
await assert.rejects(
  loadIrlFixtureTranscript(malformedEnvelopePath, 'replay-thread'),
  /no replayable conversational utterances/,
);

const quarantinedCitationPath = resolve(root, 'quarantined-citation.jsonl');
await writeFile(quarantinedCitationPath, fixture.replace(
  '"after_turn_id":"turn-1","must_include":[{"statement_contains":"earl grey"}]',
  '"after_turn_id":"turn-1","must_include":[{"statement_contains":"tool","cite_message_ids":["msg-3"]}]',
));
await assert.rejects(loadIrlFixtureTranscript(quarantinedCitationPath, 'replay-thread'), /unknown message msg-3/);

const invalidUtf8Path = resolve(root, 'invalid-utf8.jsonl');
await writeFile(invalidUtf8Path, new Uint8Array([0xff, 0xfe, 0xfd]));
await assert.rejects(loadIrlFixtureTranscript(invalidUtf8Path, 'replay-thread'), /not valid UTF-8/);

console.log(`IRL-583 fixture adapter selftest passed (${root})`);
