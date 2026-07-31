# ACE-274 Same-Source Current Mastra vs ACE

## Source Contract

Both lanes received the same 60 non-empty, replayable OpenCode message IDs from
Aurora session `ses_3d5807c97ffet2RL3R2OqbT8tS`, ordered by message creation
time and stable ID. A direct ID-list comparison returned no differences.

The first comparison attempt exposed and fixed a replay-adapter defect: current
Mastra had counted assistant rows containing only empty text/reasoning parts as
replayable. The final v3 run excludes those empty shells, matching ACE source
selection exactly.

Source composition:

- 25 human-user messages;
- 22 assistant-response messages;
- 13 tool-event messages;
- 0 classified pacemaker/system-noise messages;
- source window: `2026-02-04T21:12:05.742Z` through
  `2026-02-04T21:34:04.156Z`.

## Lane Results

| Measure | Current Mastra 1.24 | ACE deterministic |
| --- | ---: | ---: |
| Source message IDs | 60 | 60 |
| Claim/event-level source IDs | No | 60 |
| Final active characters | 2,954 | 15,961 |
| Final estimated tokens | 807 | 3,991 |
| Reflection generation | 1 | N/A |
| Historical generations retained | 2 | Per-cycle artifacts |
| Model calls | 4 | 0 |

Current Mastra's final active surface is approximately 79.8% smaller by token
estimate and 81.5% smaller by character count. ACE retains a one-to-one
source-observation record and therefore preserves substantially more raw event
detail and explicit provenance.

Mastra lifecycle:

| Step | Generation | Active tokens | Total observed tokens | Active observed IDs |
| --- | ---: | ---: | ---: | ---: |
| Observe 20 | 0 | 563 | 563 | 20 |
| Observe 40 | 0 | 795 | 1,358 | 40 |
| Reflect | 1 | 355 | 1,358 | 0 |
| Observe 60 | 1 | 807 | 2,165 | 20 |

Reflection reduced the active surface at cutoff 40 by 55.3%. The third cycle
continued from generation 1 and processed only the final 20-message delta.

## Behavioral Findings

### Correction

The source includes the correction from “bedrock payer” to “bedrock layer.” ACE
preserves both source statements independently. Current Mastra renders the
corrected current claim (“bedrock layer”) and drops the obsolete typo. That is
better current-state density, but it loses the explicit correction provenance.

### Tool And Assistant Material

ACE labels tool and assistant events explicitly and retains their source role
at claim granularity. Current Mastra uses red/yellow semantics in prose and
successfully distills tool actions such as loading/pinning memories and
Mattermost setup, but does not attach source IDs or typed source-role metadata
to individual claims. Its semantic output therefore cannot support deterministic
claim-level audit or render policy without an additional ledger.

### Chronology

ACE renders message-row timestamps (February 4). Current Mastra's Observer
renders part-level timestamps (March 10) because those part rows carry later
dates. The source mismatch is explicit evidence that a production continuity
pipeline needs a deterministic chronology authority and must preserve both
timestamps rather than allowing the model-facing formatter to choose silently.

### Density vs Auditability

Current Mastra is the stronger semantic compressor in this slice. ACE is the
stronger evidence ledger. Neither output alone is the desired product:

- Mastra alone is compact but lacks claim-level provenance and deterministic
  source-role/privacy control.
- ACE deterministic alone is fully auditable but too close to a rendered event
  transcript and nearly five times larger.

The evidence supports a layered design: ACE-style source ledger and policy
authority underneath a model-backed observer/reflector that produces a compact
active slab, with every accepted atomic claim linked back to source IDs.

## Remaining Gate

The deployed direct-LibSQL `opencode-om` lane still needs to run against these
same 60 IDs. A separate long-gap/noise slice is also required; this first slice
contains correction, assistant-origin, and tool-event cases but no meaningful
long temporal gap or pacemaker noise.

## Private Artifacts

`b2-irelate:irelate-bootstrap/memory-experiments/ace-274/ace274-real-aurora-first60-v3-20260730/`
