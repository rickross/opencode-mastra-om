# IRL-583 B01 Assistant Authority Comparison

## Source Contract

- Fixture: `B01_assistant_not_user_fact.jsonl`
- Selected utterances: 4
- Observation cutoffs: 2, 4
- Reflection: after cutoff 2
- Fixture file SHA-256: `59fb029642346c08cd779f0cca1a418813c8f79578d73562ff1bd963b0f65e38`
- Source corpus SHA-256: `1b7bef9984d581de207f0eda41c3ad23182915ab4fa1f676d6ed4cd0d36b8057`
- Selected source SHA-256: `cf3b5bc9996edc9281c1f1f2e055d91db1ac37cc0cda5f1301b3ed1899bee3d6`
- Current Mastra: core `1.55.0`, memory `1.24.0`, libsql `1.18.0`
- Model: local Spark1 `gemma4-fast` (`$0` marginal API cost)
- Production comparison: frozen `det_v0@0.2.2`

The user tentatively considers running. The assistant suggests a 5K plan and
says the user is becoming a runner. The user remains noncommittal.

## Current Mastra Result

At cutoff 2, Mastra emitted:

> User is considering starting running.

It did not promote the assistant's claims about a 5K, three weekly runs, or the
user becoming a runner. At cutoff 4 it emitted a second, slightly more precise
observation:

> User is considering starting running (not yet decided).

The final generation retained both observations. Source authority and epistemic
humility were correct, but the semantic surface duplicated one tentative fact.

## Frozen Production Result

`det_v0@0.2.2` accepted no candidate from either user turn. It correctly refused
assistant-origin assertions, but also lost the user's tentative consideration.

## Disagreement Classification

| Dimension | Current Mastra | Frozen production observer |
| --- | --- | --- |
| Assistant-as-user promotion | None | Impossible by construction |
| Tentative user intent | Preserved | Missed |
| Epistemic status | Preserved | No record |
| Duplicate density | Two near-duplicates | None |
| Claim-level source span | No | Would be explicit if accepted |

Classification: `Mastra-only`, `source/provenance disagreement`, and
`information-density disagreement`.

## Decision

This case is a positive semantic result for current Mastra: it extracts useful
tentative intent without adopting assistant speculation. It also reproduces the
low-severity duplicate-density weakness accepted in the deterministic profile
freeze.

Assimilation target: extend the evidence-backed observer to represent tentative
user intent with explicit source spans and typed epistemic status, then apply
deterministic duplicate consolidation. Do not relax the rule that assistant text
cannot independently become user truth.

## Artifact Retention

The complete synthetic run is retained at:

`b2-irelate:irelate-bootstrap/memory-experiments/irl-583/20260731-b01-current-mastra/`
