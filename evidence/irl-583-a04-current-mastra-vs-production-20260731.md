# IRL-583 A04 Current Mastra vs Production Observer

## Source Contract

- Fixture: `A04_correction_retract.jsonl`
- Selected utterances: 4
- Observation cutoffs: 2, 4
- Reflection: after cutoff 2
- Fixture file SHA-256: `16d370dd202af6341a5e87261047a7fa9fa2c815fba63d66a3187f91a9f4aa7d`
- Source corpus SHA-256: `13162e8a4f6726dc7bd340636edc0203478b83ed155c49522da3323ac1c2f46c`
- Selected source SHA-256: `2cca211b79d57b7d66a8eab1ad48b2742a71b88ea4880ac110abee9e505c68cc`
- Current Mastra: core `1.55.0`, memory `1.24.0`, libsql `1.18.0`
- Model: local Spark1 `gemma4-fast` (`$0` marginal API cost)
- Production comparison: merged deterministic observer `0.1.1`

Both lanes received the same two user utterances and assistant responses. The
Mastra lane retained all four source IDs. The production observer examined the
same user text under its explicit-source policy; assistant text could not become
user fact.

## Current Mastra Lifecycle

At cutoff 2, Mastra emitted:

> User's favorite tea is Earl Grey, which they drink every morning.

Manual reflection created generation 1 and retained that observation unchanged.

At cutoff 4, Mastra observed only the two-message delta and emitted:

> User is switching from Earl Grey to genmaicha (replacing the old preference)

The final active generation contained both statements. Mastra correctly
recognized correction intent, but it did not retire the old current-state claim.
The parenthetical replacement marker is semantic prose, not a typed lifecycle
event.

## Production Observer

The merged deterministic observer emitted:

- Turn 1: `My favorite tea is earl grey.`
- Turn 2: no accepted or quarantined candidate

The observer therefore preserved direct source evidence for the initial fact but
missed the natural-language correction form entirely. A fixture-specific harness
supersession rule is not production evidence and is excluded from this result.

## Disagreement Classification

| Dimension | Current Mastra | Production observer / IRL-562 contract |
| --- | --- | --- |
| Initial source coverage | Captured | Captured |
| Correction detection | Detected semantically | Missed by observer 0.1.1 |
| Stale current claim | Retained | Cannot retire without a lifecycle event |
| Claim-level source IDs | Generation-level only | Explicit source spans on accepted candidates |
| Typed supersession | No | Projection supports it, but no producer emitted it |
| Active-injection safe | No | No, because the correction is absent |

Classification: `semantic conflict`, `correction/supersession disagreement`, and
`source/provenance disagreement`.

## Decision

Neither lane is sufficient alone:

- Current Mastra is the stronger correction-intent recognizer, but its active
  observation surface retains stale truth and lacks typed claim provenance.
- The production observer is auditable and source-bounded, but its current
  extractor misses this correction.
- IRL-562 projection already has the correct deterministic retirement semantics;
  the missing component is a production observer that emits evidence-backed
  correction/supersession lifecycle events.

Do not inject either A04 result into active Amica context. Retain the model-backed
semantic signal as shadow evidence and require deterministic lifecycle publication
before the old claim can leave the current projection.

## Artifact Retention

The complete synthetic run, including frozen transcript, per-cycle raw/debug
output, reflection, manifest, checksummed disposable database, and source adapter
database, is retained at:

`b2-irelate:irelate-bootstrap/memory-experiments/irl-583/20260731-a04-current-mastra/`

The manifest's selected transcript SHA-256 is
`e35d7bacdc9942b90f231117e839c708089609b0c0766756a6d5c69488708683`.
