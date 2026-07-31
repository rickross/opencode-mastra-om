import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { MastraDBMessage, MastraMessagePart } from '@mastra/core/agent';
import type { FrozenTranscript } from './replay-opencode-session.js';

type JsonObject = Record<string, unknown>;

type FixtureUtterance = JsonObject & {
  record_type: 'utterance';
  message_id: string;
  turn_id: string | null;
  session_id: string;
  seq: number;
  role: string;
  content: string;
  created_at: string;
};

export type LoadedIrlFixture = {
  transcript: FrozenTranscript;
  metadata: Record<string, string>;
  expectations: JsonObject[];
  continuityProbes: JsonObject[];
  provenance: {
    fixtureFileSha256: string;
    sourceCorpusSha256: string;
    selectedSourceSha256: string;
    selectedSourceIdentity: string;
    orderedMessageIds: string[];
    quarantinedUtterances: Array<{ messageId: string; reason: string }>;
  };
};

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseRfc3339(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return null;
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw, , , offsetHourRaw, offsetMinuteRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  const offsetHour = Number(offsetHourRaw ?? 0);
  const offsetMinute = Number(offsetMinuteRaw ?? 0);
  if (
    month < 1
    || month > 12
    || day < 1
    || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
  ) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

function validateJsonNumbers(value: unknown, label: string): void {
  if (typeof value === 'number' && (!Number.isFinite(value) || !Number.isSafeInteger(value) && Number.isInteger(value))) {
    throw new Error(`${label} contains a non-finite or unsafe integer`);
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => validateJsonNumbers(child, `${label}[${index}]`));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) validateJsonNumbers(child, `${label}.${key}`);
  }
}

function parseRecord(line: string, lineNumber: number): JsonObject {
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('expected an object');
    }
    validateJsonNumbers(value, `fixture line ${lineNumber}`);
    return value as JsonObject;
  } catch (error) {
    throw new Error(
      `Invalid fixture JSON on line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function validateUtterance(record: JsonObject, lineNumber: number): FixtureUtterance {
  const requiredStrings = ['message_id', 'session_id', 'role', 'content', 'created_at'] as const;
  for (const key of requiredStrings) {
    if (typeof record[key] !== 'string' || record[key].length === 0) {
      throw new Error(`Fixture utterance line ${lineNumber} has invalid ${key}`);
    }
  }
  if (!Number.isInteger(record.seq) || Number(record.seq) < 1) {
    throw new Error(`Fixture utterance line ${lineNumber} has invalid seq`);
  }
  if (record.turn_id !== null && (typeof record.turn_id !== 'string' || record.turn_id.length === 0)) {
    throw new Error(`Fixture utterance line ${lineNumber} has invalid turn_id`);
  }
  if (!['user', 'assistant'].includes(String(record.role))) {
    throw new Error(`Fixture utterance line ${lineNumber} has unsupported role ${JSON.stringify(record.role)}`);
  }
  if (parseRfc3339(String(record.created_at)) === null) {
    throw new Error(`Fixture utterance line ${lineNumber} has invalid created_at`);
  }
  return record as FixtureUtterance;
}

function validateStringArray(record: JsonObject, key: string, lineNumber: number): void {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`Fixture ${record.record_type} line ${lineNumber} has invalid ${key}`);
  }
}

function validateScoringRecord(record: JsonObject, lineNumber: number): void {
  if (record.record_type === 'expect') {
    if (typeof record.after_turn_id !== 'string' || record.after_turn_id.length === 0) {
      throw new Error(`Fixture expect line ${lineNumber} has invalid after_turn_id`);
    }
    if (!Array.isArray(record.must_include) || !Array.isArray(record.must_not_include)) {
      throw new Error(`Fixture expect line ${lineNumber} must declare include and exclude arrays`);
    }
    for (const [key, atoms] of [['must_include', record.must_include], ['must_not_include', record.must_not_include]] as const) {
      for (const atom of atoms) {
        if (!atom || typeof atom !== 'object' || Array.isArray(atom)) {
          throw new Error(`Fixture expect line ${lineNumber} has invalid ${key} atom`);
        }
        const item = atom as JsonObject;
        if (
          (typeof item.statement_contains !== 'string' || item.statement_contains.length === 0)
          && (typeof item.kind !== 'string' || item.kind.length === 0)
        ) {
          throw new Error(`Fixture expect line ${lineNumber} has unscorable ${key} atom`);
        }
        if (
          item.cite_message_ids !== undefined
          && (!Array.isArray(item.cite_message_ids) || item.cite_message_ids.some((id) => typeof id !== 'string'))
        ) {
          throw new Error(`Fixture expect line ${lineNumber} has invalid cite_message_ids`);
        }
      }
    }
    validateStringArray(record, 'failure_codes_if_violated', lineNumber);
    return;
  }
  if (
    typeof record.probe_id !== 'string'
    || record.probe_id.length === 0
    || typeof record.user_message !== 'string'
    || record.user_message.length === 0
    || typeof record.slab_required !== 'boolean'
  ) {
    throw new Error(`Fixture continuity_probe line ${lineNumber} has invalid identity or prompt fields`);
  }
  validateStringArray(record, 'pass_if_reply_includes', lineNumber);
  validateStringArray(record, 'fail_if_reply_includes', lineNumber);
}

function normalizedConversationalContent(content: string): { content: string | null; reason?: string } {
  if (!content.trimStart().startsWith('{')) return { content };
  try {
    const envelope: unknown = JSON.parse(content);
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return { content };
    const object = envelope as JsonObject;
    if (object.format !== 2) return { content };
    if (!Array.isArray(object.parts)) {
      return { content: null, reason: 'malformed_serialized_message_envelope' };
    }
    const textParts = object.parts
      .filter((part): part is JsonObject => Boolean(part) && typeof part === 'object' && !Array.isArray(part))
      .filter((part) => part.type === 'text' && typeof part.text === 'string' && part.text.trim().length > 0)
      .map((part) => String(part.text));
    if (textParts.length === 0) {
      return { content: null, reason: 'serialized_message_envelope_without_conversational_text' };
    }
    return { content: textParts.join('\n\n') };
  } catch {
    if (/"format"\s*:\s*2(?:\D|$)/.test(content)) {
      return { content: null, reason: 'malformed_serialized_message_envelope' };
    }
    return { content };
  }
}

export async function loadIrlFixtureTranscript(
  fixturePath: string,
  replayThreadId: string,
): Promise<LoadedIrlFixture> {
  const bytes = await readFile(fixturePath);
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Fixture is not valid UTF-8');
  }
  const metadata: Record<string, string> = {};
  const utterances: FixtureUtterance[] = [];
  const expectations: JsonObject[] = [];
  const continuityProbes: JsonObject[] = [];
  const probeIds = new Set<string>();

  for (const [index, rawLine] of raw.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const match = /^#\s*([^:]+):\s*(.*)$/.exec(line);
      if (match) metadata[match[1]!.trim()] = match[2]!.trim();
      continue;
    }
    const record = parseRecord(line, index + 1);
    if (record.record_type === 'utterance') {
      utterances.push(validateUtterance(record, index + 1));
    } else if (record.record_type === 'expect') {
      validateScoringRecord(record, index + 1);
      expectations.push(record);
    } else if (record.record_type === 'continuity_probe') {
      validateScoringRecord(record, index + 1);
      if (probeIds.has(String(record.probe_id))) {
        throw new Error(`Fixture contains duplicate probe_id ${String(record.probe_id)}`);
      }
      probeIds.add(String(record.probe_id));
      continuityProbes.push(record);
    } else {
      throw new Error(`Fixture line ${index + 1} has unsupported record_type ${JSON.stringify(record.record_type)}`);
    }
  }

  if (!metadata.fixture_id) throw new Error('Fixture metadata is missing fixture_id');
  if (utterances.length === 0) throw new Error('Fixture contains no utterances');
  const messageIds = new Set<string>();
  const sessionIds = new Set<string>();
  let previousSeq = 0;
  let previousReplayMillis = Number.NEGATIVE_INFINITY;
  const messages: MastraDBMessage[] = [];
  const sourceMessages: FrozenTranscript['sourceMessages'] = [];
  const selectedSource: JsonObject[] = [];
  const selectedMessageIds = new Set<string>();
  const selectedTurnIds = new Set<string>();
  const quarantinedUtterances: Array<{ messageId: string; reason: string }> = [];

  for (const utterance of utterances) {
    if (messageIds.has(utterance.message_id)) {
      throw new Error(`Fixture contains duplicate message_id ${utterance.message_id}`);
    }
    if (utterance.seq <= previousSeq) {
      throw new Error(`Fixture seq must be strictly increasing at ${utterance.message_id}`);
    }
    messageIds.add(utterance.message_id);
    sessionIds.add(utterance.session_id);
    previousSeq = utterance.seq;
    const normalized = normalizedConversationalContent(utterance.content);
    if (normalized.content === null) {
      quarantinedUtterances.push({ messageId: utterance.message_id, reason: normalized.reason! });
      continue;
    }
    const originalMillis = parseRfc3339(utterance.created_at)!;
    const replayMillis = Math.max(originalMillis, previousReplayMillis + 1);
    previousReplayMillis = replayMillis;
    const createdAt = new Date(replayMillis);
    const partId = `${utterance.message_id}:fixture-text`;
    const part = {
      type: 'text',
      text: normalized.content,
      createdAt: replayMillis,
    } as MastraMessagePart;
    messages.push({
      id: utterance.message_id,
      role: utterance.role as MastraDBMessage['role'],
      createdAt,
      threadId: replayThreadId,
      resourceId: replayThreadId,
      content: { format: 2, parts: [part] },
    });
    selectedMessageIds.add(utterance.message_id);
    if (utterance.turn_id) selectedTurnIds.add(utterance.turn_id);
    sourceMessages.push({
      id: utterance.message_id,
      role: utterance.role,
      timestamp: new Date(originalMillis).toISOString(),
      replayTimestamp: createdAt.toISOString(),
      replayTimestampAdjustmentMs: replayMillis - originalMillis,
      data: { ...utterance, normalized_content: normalized.content },
      parts: [
        {
          id: partId,
          timestamp: new Date(originalMillis).toISOString(),
          data: { type: 'text', text: normalized.content },
        },
      ],
    });
    selectedSource.push({ ...utterance, normalized_content: normalized.content });
  }

  if (sessionIds.size !== 1) {
    throw new Error(`Fixture must contain exactly one session_id, found ${sessionIds.size}`);
  }
  if (messages.length === 0) throw new Error('Fixture contains no replayable conversational utterances');
  for (const expectation of expectations) {
    if (!selectedTurnIds.has(String(expectation.after_turn_id))) {
      throw new Error(`Fixture expectation references unknown turn ${String(expectation.after_turn_id)}`);
    }
    for (const key of ['must_include', 'must_not_include']) {
      for (const atom of expectation[key] as JsonObject[]) {
        for (const citedId of (atom.cite_message_ids ?? []) as string[]) {
          if (!selectedMessageIds.has(citedId)) {
            throw new Error(`Fixture expectation cites unknown message ${citedId}`);
          }
        }
      }
    }
  }
  for (const probe of continuityProbes) {
    if (probe.after_fixture !== undefined && probe.after_fixture !== metadata.fixture_id) {
      throw new Error(`Fixture probe ${String(probe.probe_id)} references a different fixture`);
    }
  }
  const sessionId = utterances[0]!.session_id;
  const selectedSourceSha256 = sha256(canonicalJson(selectedSource));
  return freezeDeep({
    transcript: {
      session: { id: sessionId, data: { fixtureId: metadata.fixture_id, ...metadata } },
      messages,
      sourceMessages,
    },
    metadata,
    expectations,
    continuityProbes,
    provenance: {
      fixtureFileSha256: sha256(bytes),
      sourceCorpusSha256: sha256(canonicalJson(utterances.map((utterance) => ({ ...utterance })))),
      selectedSourceSha256,
      selectedSourceIdentity:
        'SHA-256 of canonical parsed utterance records; excludes replay thread/resource IDs and scoring records.',
      orderedMessageIds: messages.map((message) => message.id),
      quarantinedUtterances,
    },
  });
}
