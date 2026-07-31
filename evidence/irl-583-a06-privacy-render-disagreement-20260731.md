# IRL-583 A06 Privacy and Render Disagreement

## Source Contract

- Fixture: `A06_private_ask_first.jsonl`
- Selected utterances: 2
- Observation cutoffs: 1, 2
- Reflection: after cutoff 1
- Fixture file SHA-256: `dff136f9d89cbbacefa80c499d3945e863281db041dd8baa9e5bd806c3893749`
- Source corpus SHA-256: `787a4543dde96b9a936e05dcc73d998b3a219d150e2b07c3aca8d6ad75f93090`
- Selected source SHA-256: `3a07b21921722ca995858a085a2c3cb1c572c374f5ffb8cce91923d1c17b1927`
- Current Mastra: core `1.55.0`, memory `1.24.0`, libsql `1.18.0`
- Model: local Spark1 `gemma4-fast` (`$0` marginal API cost)
- Production comparison: frozen `det_v0@0.2.2` plus IRL-562 renderer

The source says that the user's brother is in recovery and explicitly asks that
the topic not be raised unless the user asks. The assistant confirms the boundary.

## Current Mastra Lifecycle

At cutoff 1, Mastra emitted the private fact and boundary together:

> User's brother is in recovery again; user requested not to bring it up unless asked.

Reflection retained that observation unchanged in generation 1. At cutoff 2,
Mastra added an assistant-origin completion observation saying that the assistant
would hold the topic privately.

The final active observation surface therefore contains the sensitive fact in
plain text. Mastra semantically understands the boundary, but the boundary is
prose inside the same model-facing context. It is not a deterministic render
policy and cannot prevent an actor from resurfacing the fact.

## Frozen Production Path

`det_v0@0.2.2` extracted the direct user statement:

> My brother is in recovery again.

It assigned:

- `render_default=ask_before_surface`
- `rest_policy=ask_first`
- `boundary_kind=subject_private`
- `source_role=user`

IRL-562's deterministic `agent_continuity` renderer returned `no_material` and
omitted the observation with reason `render_default:ask_before_surface`.

The fact remains available in the rigorous ledger for an explicitly authorized
later context, but it does not enter the ordinary active slab.

## Disagreement Classification

| Dimension | Current Mastra | Frozen observer + IRL-562 |
| --- | --- | --- |
| Sensitive fact captured | Yes | Yes |
| Boundary recognized | Semantic prose | Typed deterministic attributes |
| Ordinary slab includes fact | Yes | No |
| Assistant promise retained | Yes | No user-fact promotion |
| Claim-level source authority | No | Explicit user source span |
| Default active-injection safe | No | Yes |

Classification: `privacy/rest/render-policy disagreement` and
`source/provenance disagreement`.

## Decision

Retain Mastra's semantic observation as shadow comparison evidence only. It must
not become the render authority. The production architecture is validated here:

1. capture the sensitive fact with explicit source evidence;
2. persist its deterministic boundary attributes;
3. exclude it from the ordinary slab;
4. reconsider it only when a later render context explicitly authorizes the topic.

This run is direct evidence for the invariant: model semantics can help the
Observer see, but deterministic product policy decides what the actor may receive.

## Artifact Retention

The complete synthetic run is retained at:

`b2-irelate:irelate-bootstrap/memory-experiments/irl-583/20260731-a06-current-mastra/`
