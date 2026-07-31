# ACE-274 Current Mastra Real-Session Replay

## Run

- Run ID: `ace274-real-aurora-first60-v3-20260730`
- Source session: `ses_3d5807c97ffet2RL3R2OqbT8tS`
- Frozen prefix: first 60 replayable messages
- Observation cutoffs: 20, 40, 60 messages
- Manual reflection: after cycle 2
- Model: Spark1 `gemma4-fast`
- Mastra packages: core 1.55.0, memory 1.24.0, libsql 1.18.0
- Source DB SHA-256: `1372d3c59e1b0cf59f76b80a3f34d46be279f81c9f63b992cc5df2f6db00c534`
- Frozen transcript SHA-256: `490735680e8afb4715605be977627852f23b0d3214d769d0aa6534e971f160d7`

The source was captured with SQLite online backup, changed to DELETE journal
mode so it could be opened read-only as a standalone frozen artifact, and never
written by the replay runner.

## Lifecycle Proof

| Step | Generation | Active tokens | Total observed tokens | Active observed IDs |
| --- | ---: | ---: | ---: | ---: |
| Observe 20 | 0 | 563 | 563 | 20 |
| Observe 40 | 0 | 795 | 1,358 | 40 |
| Reflect | 1 | 355 | 1,358 | 0 |
| Observe 60 | 1 | 807 | 2,165 | 20 |

The third observation received only the 20-message delta after reflection. It
did not reprocess the first 40 messages. Public `getHistory()` returned the
current generation followed by generation 0, and the disposable database
retained both generations.

Reflection reduced the active observation surface from 795 to 355 estimated
tokens (55.3%) while retaining the central continuity claims. The third cycle
continued from the reflected state and appended new observations.

## Findings

1. Current published Mastra can perform stateful, sequential longitudinal
   observation and reflection over real OpenCode history. This is distinct from
   one-shot `summarizeConversation()` and from ACE-264's independent cycle
   windows.
2. Stable OpenCode message IDs are sufficient for Mastra's duplicate filtering
   across cumulative prefixes and across a reflection boundary.
3. Current OpenCode raw `tool` parts can be mapped into Mastra
   `tool-invocation` parts with input and result preserved. The replay adapter
   also accepts the legacy `tool-invocation` shape.
4. The Spark OpenAI-compatible endpoint did not provide useful token usage to
   Mastra's hooks: observation usage reported `totalTokens: 0`, and reflection
   usage was null. Cost/throughput accounting needs a provider-boundary metric,
   not sole reliance on these hooks.
5. The source contains a chronology inconsistency. The first message is dated
   `2026-02-04T21:12:05.742Z`, while its first part is dated
   `2026-03-10T20:59:49.231Z`, a delta of 2,936,863,489 ms. Mastra prefers the
   part timestamp when constructing observation time, so the resulting slab is
   dated March 10. This is source evidence behavior, not an unsupported model
   date. Same-source comparisons must declare whether message or part time is
   authoritative and score chronology accordingly.
6. Bounding source loading to the largest declared cutoff reduced the artifact
   package from a full 61,289-message transcript to exactly 60 messages.
7. Blank text/reasoning-only assistant rows must not count as replayable. The
   first run included two such empty shells; v3 rejects them and matches ACE's
   60 substantive source IDs exactly.

## Artifact Retention

Raw artifacts include the frozen 60-message transcript, per-cycle debug/model
events, observation generations, reflection output, manifest, and the
disposable Mastra database. They are private because the source contains
personal continuity material; do not publish them.

The private package is retained at:

`b2-irelate:irelate-bootstrap/memory-experiments/ace-274/ace274-real-aurora-first60-v3-20260730/`

The disposable database was checkpointed before upload so `mastra-memory.db`
is self-contained and does not depend on a missing WAL file. The complete
2.5 GB OpenCode source backup was deliberately not uploaded.
