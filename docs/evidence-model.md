# Evidence, attestations and Wisdom of Compute

> The full **Evidence Protocol** is a separate platform contract whose ownership is deferred by the protocol. The runtime
> event envelope here (`schemas/qb-evidence-envelope.schema.json`) is a **provisional QB-side contract**. Example data is synthetic.

## Principle

Execution produces machine evidence (session IDs, tapes, trajectories, delegation decisions, model/capability
selections, retries, replans, failures, latency, cost, evaluations). Evidence *informs* improvement; it never *applies* it:

```
production QB → evidence → candidate improvement → evaluation → Git branch/PR → validation → canonical new version
```

`spec.governance.selfModification` is the constant `forbidden`; every version needs a human author; the runtime has no
write path into this repository.

## What lives where

| Data | Location | In Git? |
|---|---|---|
| Blueprint, suite, release record, lifecycle overlay | `<scope>/<id>/<version>/` | yes |
| **Attestations** (digest-bound assessments: URI, subjectDigest, gate, result, summary metrics) | `attestations[]` in the blueprint | yes, append-only once canonical |
| **Evidence pointers** (supporting evidence: samples, trajectory sets, incidents, benchmarks) | `evidence/refs.yaml` | yes, append-only once canonical |
| Sessions, tapes, trajectories, raw eval outputs, sensitive payloads | evidence store (Cortex) | **never** |

Enforced: version directories accept only a fixed file allow-list (`E_UNEXPECTED_FILE`); `*.jsonl/.ndjson/.tape/.har` and
`tapes/`, `trajectories/`, `sessions/`, `traces/` directories are rejected repo-wide (`E_RUNTIME_ARTIFACT`); schemas are
`additionalProperties: false`; summaries are length-limited; URLs, credentials and model IDs are linted.

## Attestations

`{type, ref (evidence://…), subjectDigest, capturedAt, synthetic, summary}`; `type: evaluation` adds `gate`
(`candidate|canonical`), `result`, summary `metrics` and `suite` (`{registry,id,version,digest}` of the exact suite assessed; `E_SUITE_STALE`/`E_SUITE_MISMATCH`). Rules: `subjectDigest` MUST equal the artifact's current digest;
a `pass` must actually satisfy the suite thresholds for its gate (`E_GATE`). Signing is deferred.

Evaluation suites, evidence refs, lifecycle overlays and release records are linted for credentials (`E_SECRET`) and
http(s)/infrastructure endpoints (`E_ENDPOINT`) over every string value and key (`$schema`/`$id` are schema identifiers and skipped).
Permitted pointers only: `evidence/refs.yaml` `refs[*].uri` and `release.yaml` `promotionRef` may hold a URL/PR reference
(endpoint check only — secrets are still rejected there). There is no blanket URL ban elsewhere beyond the existing rules.

## Lineage identifiers (provisional runtime contract)

`qbs_` session, `qbr_` run, `qbb_` branch (forks/rollbacks create new branches, history never rewritten), `qbc_` checkpoint,
`qbe_` event. Every event carries `qb: {registry, id, version, digest}`. The `resolution.locked` event records the
[resolution lock](cross-registry-references.md) so evidence shows exactly which versions and digests ran.

## Wisdom of Compute mutation requirements

A WoC-derived version must:

1. set `metadata.origin.type: evolved` with `evolution.sourceRefs[0]` = the version it evolved from (same id);
2. carry a `provenance.transformations[]` entry `kind: wisdom-of-compute` with `hypothesis`, ≥1 `evidenceRefs`, ≥1
   `evalRuns` and `humanReviewRequired: true`;
3. list a human among `provenance.authors`; automation may propose but not merge;
4. pass the normal promotion gates (attestations, security review, release approval).

The proposal is a **candidate** registry object; Git branches/PRs are only the governance transport.
Example: `synthetic/qbs/synthetic.research-synthesis/1.1.0`.
