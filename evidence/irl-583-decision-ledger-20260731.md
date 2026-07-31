# IRL-583 Current Mastra vs ACE Candidate Decision Ledger

## Scope

This ledger records candidate decisions from the bounded shadow comparison. It
does not close IRL-583 before the required stakeholder review and any accepted
remaining chronology/noise run. It covers:

- current Mastra core `1.55.0`, memory `1.24.0`, libsql `1.18.0`;
- stateful `observe()` / `reflect()` lifecycle on a private authorized 60-message
  Aurora chronology;
- frozen IRL-564 fixtures A04, A06, and B01 on identical selected source records;
- frozen production observer `det_v0@0.2.2` and IRL-562 projection/render contracts;
- held-out A04/A06 actor questions on local Spark1 `gemma4-fast`;
- no canonical iRelate memory writes and no active Amica injection.

## Longitudinal Lifecycle Evidence

Current Mastra processed the private 60-message chronology at cutoffs 20, 40,
and 60, with reflection after cutoff 40:

| Step | Generation | Active tokens | Total observed tokens | Delta IDs |
| --- | ---: | ---: | ---: | ---: |
| Observe 20 | 0 | 563 | 563 | 20 |
| Observe 40 | 0 | 795 | 1,358 | 40 |
| Reflect | 1 | 355 | 1,358 | 0 |
| Observe 60 | 1 | 807 | 2,165 | 20 |

Reflection reduced the active surface by 55.3 percent and the next observation
processed only the 20-message delta. Both generations remained in the disposable
LibSQL store.

The final same-source ACE run received the same 60 ordered message IDs; direct ID
comparison returned no differences. ACE retained 60 claim/event source IDs and
rendered an estimated 3,991 tokens. Current Mastra's final active surface was 807
tokens, approximately 79.8 percent smaller, but lacked claim-level source IDs.
This is a valid density/provenance comparison, not a reply-utility winner metric.

## Representative Comparisons

| Case | Current Mastra | Frozen production path | Decision |
| --- | --- | --- | --- |
| A04 correction | Detects replacement intent; retains stale and new claims; held-out answer correct | Direct `det_v0@0.2.2` emits two asserted records before lifecycle projection; held-out answer stale | Assimilate semantic correction proposal; require IRL-596 deterministic lifecycle publication |
| A06 privacy | Understands boundary as prose; sensitive fact remains model-facing; ordinary probe invents generic family status | Typed `ask_before_surface`; ordinary slab omits fact; explicit ask currently has no product rerender path | Retain deterministic policy; require IRL-597 authorized per-turn render |
| B01 assistant authority | Preserves tentative user intent; does not adopt assistant 5K/runner speculation; duplicates intent | Cannot promote assistant text; misses tentative intent | Assimilate typed tentative-intent extraction; retain user-source authority; consolidate duplicates |
| Real 60-message lifecycle | Stateful deltas and reflection work; compact semantic surface | Source-event replay is fully attributable but too literal for a direct active slab | Retain Mastra as semantic reference; retain ACE as source/provenance authority |

## Retain

### From Current Mastra

- Stateful cumulative observation with stable message-ID duplicate filtering.
- Reflection as an explicit generation transition with retained history.
- Semantic recognition of tentative intent and correction intent.
- Rich evidence presentation to the observer, including role-aware message parts.
- Current Mastra as a disposable shadow/reference engine for future profile tests.

### From ACE / Amica

- Append-only source evidence and exact user source spans.
- Deterministic source-role authority: assistant text cannot independently become
  user truth.
- Typed render attributes and fail-closed ordinary withholding.
- Typed lifecycle projection and terminal evidence.
- Atomic contiguous slab compilation, generation fences, watermark/cutoff
  identity, erasure fences, and failure isolation.
- Exact assembly metadata as a precondition for any active injection.

## Replace

Do not adopt these current Mastra properties as production memory authority:

- Monolithic free-text active observations without claim IDs and source spans.
- Privacy/rest boundaries expressed only as prose beside the sensitive fact.
- Correction intent expressed only as prose while stale claims remain active.
- Assistant commitments retained in the same active continuity surface as user
  facts without a typed authority distinction.
- Provider-hook token usage as the sole cost/throughput metric; Spark returned
  zero/null usage through Mastra hooks.
- A second canonical memory store or production dual-write path.

Improve or replace these frozen ACE properties before injection:

- Narrow deterministic extraction that misses tentative intent.
- No production correction/supersession event producer (IRL-596).
- Static ordinary slab with no explicit-ask authorization path (IRL-597).
- Low-severity duplicate density without deterministic consolidation.

## Assimilate

The chosen architecture is not “Mastra or ACE.” It is:

1. model-backed semantic candidate generation for coverage, tentative intent,
   correction intent, and other meanings that deterministic regex misses;
2. explicit source spans and typed epistemic/source-role attributes;
3. deterministic candidate validation, canonicalization, duplicate handling,
   lifecycle targeting, privacy/rest policy, and final acceptance;
4. IRL-562 projection and slab compilation;
5. deterministic per-turn render authorization and exact assembly audit;
6. one accepted product ledger and no parallel Mastra production state.

Current Mastra remains a reference implementation and experimental lane. Its
useful semantic behavior should be assimilated into the product observer contract,
not introduced as a second storage or render authority.

## Decisions and Gates

- Freeze `det_v0@0.2.2` only on its measured extraction/privacy/source-role axes.
- Keep IRL-562 as the production projection/compiler foundation.
- Create IRL-596 for evidence-backed correction lifecycle publication.
- Create IRL-597 for deterministic `ask_before_surface` per-turn authorization.
- Keep IRL-563 active injection blocked on IRL-596 and IRL-597.
- Do not migrate Mastra state, dual-write to Mastra, or inject Mastra's active
  observation text into Amica.

## Evidence Index

- `ace-274-real-replay-20260730.md`
- `irl-583-a04-current-mastra-vs-production-20260731.md`
- `irl-583-a06-privacy-render-disagreement-20260731.md`
- `irl-583-b01-assistant-authority-comparison-20260731.md`
- `irl-583-held-out-utility-20260731.md`
- Private raw artifacts under
  `b2-irelate:irelate-bootstrap/memory-experiments/irl-583/`

## Candidate Verdict

The evidence does not support selecting Current Mastra as the production memory
engine. It supports the candidate conclusion that Mastra contributes semantic
capabilities worth assimilating and that ACE's deterministic envelope is
necessary for source truth, current-state lifecycle, privacy, and render safety.

IRL-583 remains open pending Rick/Aurora/Solène review and resolution of whether
the separate long-gap/noise slice and deployed direct-LibSQL lane from ACE-274 are
required for this product decision. Active injection is not approved.
