# Evidence model and Wisdom of Compute

## Principle

Agent execution produces machine evidence: session IDs, execution tapes, trajectories, delegation decisions, model and
capability selections, retries, replans, failures, successful paths, latency, cost, evaluations, outcome quality.
This evidence *informs* improvement. It never *applies* it.

```
production QB run ─▶ evidence (Cortex) ─▶ candidate improvement (proposal)
      ─▶ evaluation ─▶ Git branch/PR ─▶ validation + human review ─▶ new canonical version
```

A QB can never silently rewrite or deploy its own definition: `governance.selfModification` is the constant
`forbidden`, every version needs a human author of record, and only merged PRs create versions.
The runtime has no write path into this repository (see [security](security.md)).

## What lives where

| Data | Location | In Git? |
|---|---|---|
| Blueprint, eval suite, release seal | `qbs/<slug>/<ver>/` | yes |
| Evidence **pointers** (URI, digest, summary metrics, gate result) | `evidence/refs.yaml` | yes, append-only |
| Sessions, tapes, trajectories, raw eval outputs | evidence store (Supabase/Cortex, via `gateway:cortex/evidence`) | **never** |

## Lineage identifiers (runtime contract)

Defined in [`qb-evidence-envelope.schema.json`](../schemas/qb-evidence-envelope.schema.json); prefixes + ULID.

| ID | Meaning |
|---|---|
| `qbs_…` sessionId | root of a lineage tree (one user intent) |
| `qbr_…` runId | one durable execution attempt (incl. resumes) |
| `qbb_…` branchId | a line of execution; forks/rollbacks create new branches (`parentBranchId`, `forkedFromCheckpointId`) |
| `qbc_…` checkpointId | restorable state at a policy-defined trigger |
| `qbe_…` eventId | one tape event; ordered by `seq` within a branch |

Every event carries `qb.{id, version, blueprintDigest}` so evidence always joins to the exact sealed definition.
Event types cover plans, decomposition, delegation decisions, model/capability selection, Jev calls, tool history,
evaluations, retries, replans, checkpoints, branch forks, resumes, rollbacks, HITL, escalations, budgets and failures.
Reproducibility comes from: sealed digest + recorded model/capability selections + tool tape + checkpoints.

## Evidence refs (`evidence/refs.yaml`)

Types: `eval-run`, `session-sample`, `trajectory-set`, `incident`, `benchmark`, `human-review`.
Each ref records `uri` (`evidence://<store>/<path>`, opaque), `contentDigest`, `capturedAt`, the `blueprintDigest`
it was gathered against, `redaction` class, a short summary and, for eval-runs, `gate`, `result`, `metrics`.
CI uses eval-run refs as **promotion evidence** (gate thresholds are checked against `metrics`).
Prefer `aggregate-only`/`pseudonymised` redaction: repository contents are broadly readable.

## Wisdom-of-Compute proposals

A WoC-derived version sets `provenance.origin: wisdom-of-compute` and the schema then *requires*:
`parent`, `derivedFrom.hypothesis`, ≥1 `derivedFrom.evidenceRefs`, ≥1 `derivedFrom.evalRuns`,
`humanReviewRequired: true`. The proposer may be an automation actor, but must open a PR like anyone else, a human
must be listed and approve, and the normal gates apply. See `qbs/research-synthesis/1.1.0/` for a worked example.

## Runtime obligations (checked by the runtime team, declared here)

`blueprint.evidence` states what must be captured, tape level (`metadata-only|redacted-full|full`), redaction,
retention and sink contract. Retention/redaction must be enforced at write time by the sink, not by consumers.
