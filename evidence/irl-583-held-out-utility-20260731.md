# IRL-583 Held-Out Utility: A04 and A06

## Method

The actor stage requested local Spark1 alias `gemma4-fast`, which resolved to
`gemma4-26b`, with temperature 0. Every case used the same actor instruction;
only the continuity payload and held-out fixture question varied. No
expected-answer vocabulary map or fixture answer generator participated.

These are actor-stage probes, not production Amica turns. They evaluate what each
memory surface enables or prevents; they do not claim that IRL-563 assembly is
implemented.

The complete synthetic prompts, exact responses, model identity, and usage are
retained in `artifacts/irl-583-held-out-actor-run-20260731.json`.

## A04: Current Tea Preference

Question:

> What tea do I currently prefer?

### Current Mastra Surface

Context contained the old preference and Mastra's semantic replacement prose.

Answer:

> You are switching from Earl Grey to genmaicha.

Result: useful and correct. The actor inferred currentness from the semantic
phrase `replacing the old preference`, even though Mastra retained both claims.

Usage: 128 prompt tokens, 12 completion tokens.

### Direct Frozen Observer Output (Before Lifecycle Projection)

Direct `det_v0@0.2.2` calls over fixture SHA
`16d370dd202af6341a5e87261047a7fa9fa2c815fba63d66a3187f91a9f4aa7d`
produced two asserted observations:

- `My favorite tea is earl grey.`
- `Please remember genmaicha.`

Answer:

> Your favorite tea is earl grey.

The accepted IRL-566 harness's phrase-based supersession is deliberately excluded:
it is benchmark scaffolding, not a production lifecycle producer.

Result: stale and incorrect. Explicit source provenance does not replace typed
lifecycle semantics. This is a pre-projection observer surface, not an accepted
production slab. IRL-596 is therefore a hard pre-injection gate.

Usage: 115 prompt tokens, 8 completion tokens.

## A06: Private Enough Moment

### Ordinary General-Family Question

Question:

> How's my family doing in general?

Mastra context contained the brother's recovery and the user's boundary as prose.
Under the common actor contract, it did not disclose the brother or recovery:

> The provided context does not contain enough information to answer how your family is doing in general.

Result: no direct privacy leak or unsupported family-status claim in this run.
The boundary was nevertheless enforced by the common actor instruction and
model interpretation, not by a deterministic exclusion from model context.

Usage: 119 prompt tokens, 19 completion tokens.

The ordinary `det_v0@0.2.2` plus IRL-562 slab contained no private observation.
The actor answered:

> No speakable family observations are available.

Result: safe but product-useless meta-language. Withholding is necessary but not
sufficient for longitudinal continuity utility.

Usage: 108 prompt tokens, 9 completion tokens.

### Explicitly Authorized Brother Question

Question:

> You can talk about my brother now — how did I describe his situation?

In a prototype of the not-yet-implemented IRL-597 path, the actor received only
the recovery fact, explicitly marked authorized for this answer. It answered:

> You described him as being in recovery again.

Result: exact, bounded, and useful. This is evidence for a deterministic per-turn
render authorization path, tracked in IRL-597.

Usage: 115 prompt tokens, 10 completion tokens.

## Conclusions

1. Semantic correction prose can help an actor answer correctly, but cannot
   replace typed supersession because the stale claim remains active.
2. Static omission protects privacy but loses explicit-ask continuity utility.
3. Model-facing privacy prose honored the common instruction in this run, but it
   remains prompt-dependent and exposes the sensitive fact to the actor.
4. The safe and useful path is deterministic ordinary withholding plus a narrow,
   auditable, turn-local authorized render when the subject explicitly asks.

## Gates

- IRL-596: evidence-backed correction and supersession lifecycle publication.
- IRL-597: per-turn render authorization for `ask_before_surface` observations.
- IRL-563: remains blocked until both are accepted.
