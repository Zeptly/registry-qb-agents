# registry-qb-agents

The canonical, Git-native registry of **QB (Quarterback) Agents** for Zeptly, implemented against the approved
**Zeptly Registry Protocol v0.2** (v0.1 envelope + v0.2 amendment) (common envelope, identity, versioning, references, provenance, lifecycle,
evidence pointers, security metadata, indexing and resolution).

A QB is an orchestration agent: it decomposes complex tasks, builds an execution strategy, delegates to Execution
Agents, requests Tiny Agents (and swarms), evaluates and replans, checkpoints and resumes, synthesises results and
escalates. This repository defines **what a QB is and how it must behave** as declarative, versioned, reviewable
data. A separate runtime (executing on Trigger.dev) interprets it; no runtime code lives here.

Scope: QB Agents only. Skills, Tiny Agents, Execution Agents, Timesavers and **Zep** are different things.
QB `spec` semantics (decomposition, delegation, replanning, budgets, concurrency, escalation, HITL, Jev policy,
evaluation, checkpointing, swarm) are preserved inside the protocol envelope.

> **Synthetic-data warning:** everything under [`synthetic/`](synthetic) is fictional example data used to exercise the
> tooling: never real execution evidence and never part of a production index. The production namespace
> [`qbs/`](qbs) is currently empty.

> **Deferred by the protocol (not implemented here):** Evidence Protocol ownership/schema (the envelope in
> `schemas/qb-evidence-envelope.schema.json` is a provisional QB-side contract), capability/gateway/model namespace
> ownership, signing/signed evaluations, peer-index distribution, workspace overrides, traffic channels, nested QB
> execution, runtime-trigger contract versioning. See [docs/provisional.md](docs/provisional.md).

## Envelope at a glance

```yaml
apiVersion: registry.zeptly.dev/v1alpha1
kind: QBBlueprint
metadata:   { id, version, registry: qb-agents, origin: {type, evolution?}, maturity, lifecycle, synthetic?, name, summary, owners }
spec:       # QB-specific semantics (orchestration, planning, decomposition, delegation, evaluation, replanning, jev, models, ...)
references: # [{registry, id, version(range), digest?}]  (structured cross-registry references)
provenance: { createdAt, authors, sourceRefs, transformations, changelog? }
security:   { classification, capabilities, approvals }
attestations: # digest-bound assessments (stale subjectDigest fails validation)
```

`maturity` (`candidate | canonical`), `lifecycle` (`active | deprecated | revoked`) and `origin`
(`native | evolved | upstream-seed`) are independent fields.

## Layout

```
schemas/                       JSON Schemas: blueprint (envelope), eval suite, evidence refs, release record,
                               lifecycle overlay, registry index, resolution lock, evidence envelope (provisional)
qbs/<id>/<version>/            production artifacts (none yet)
synthetic/qbs/synthetic.<n>/<version>/   isolated synthetic examples
   blueprint.yaml                the artifact (envelope)
   evals/suite.yaml              evaluation suite + gates (candidate, canonical)
   evidence/refs.yaml            append-only POINTERS to supporting evidence (never raw data)
   lifecycle.yaml                append-only lifecycle overlay (optional until state changes)
   release.yaml                  release record (digest + directory seal) written at promotion to canonical
registries.yaml                allow-list of registry names for structured references
scripts/                       validate, seal, build-index, resolve, check-immutability
test/                          tests; docs/ specs; .github/ CI, CODEOWNERS, PR template
```

## Commands

```bash
npm ci
npm run validate               # schema + semantic + provenance + security + synthetic-isolation + runtime-artifact scan
npm test
npm run build:index:verify     # dist/index.json (production) + dist/synthetic-index.json; built twice and compared
npm run resolve -- <id>@<version> --scope synthetic --index <peer-index.json>   # offline RuntimeLock (unresolved refs listed with codes; exit 1 if incomplete, 2 on malformed input)
npm run seal -- <id>@<version> [--scope synthetic] [--pr <ref>]                 # release record for canonical
npm run check:immutability -- --base origin/main
```

## Documentation

| | |
|---|---|
| [Protocol conformance](docs/protocol-conformance.md) | Protocol rule → implementation map |
| [Canonicalization](docs/canonicalization.md) | Manifest input subset, RFC 8785 JCS, digest scope, directory seal |
| [Architecture](docs/architecture.md) | Boundaries, layout, lineage |
| [Blueprint spec](docs/blueprint-spec.md) | Envelope and `spec` sections |
| [Lifecycle, maturity & versioning](docs/lifecycle-versioning.md) | Maturity, lifecycle overlay, sealing, semver |
| [Evidence model](docs/evidence-model.md) | Pointers, attestations, Wisdom of Compute |
| [References & resolution](docs/cross-registry-references.md) | Structured refs, index, resolution lock |
| [Evaluation](docs/evaluation.md) | Suites and gates |
| [Security](docs/security.md) | Threat model and controls |
| [Provisional / deferred](docs/provisional.md) | What is not settled |
| [Decisions](docs/decisions.md) | Accepted choices and the 12 open questions |
| [Contributing](CONTRIBUTING.md) | Authoring and promotion workflow |
