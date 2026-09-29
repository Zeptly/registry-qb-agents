# registry-qb-agents

The canonical, Git-native registry of **QB (Quarterback) Agents** for Zeptly.

A QB is a higher-order *orchestration* agent: it decomposes complex tasks, builds an execution
strategy, delegates to Execution Agents, requests Tiny Agents (and swarms), evaluates and replans,
checkpoints and resumes, synthesises results and escalates. This repository defines **what a QB is
and how it must behave** as declarative, versioned, reviewable data. A separate runtime
(`Zeptly/runtime-trigger`, executing on Trigger.dev) *interprets* these definitions; no runtime code lives here.

> **Status: candidate architecture, PROVISIONAL.** Subject to cross-registry reconciliation with `registry-execution-agents`,
> `registry-tiny-agents` and `registry-skills`. **NOT YET CANONICAL:** cross-registry identifier syntax, lifecycle terminology,
> evidence-envelope ownership/schema, index publication mechanism, shared namespace ownership, traffic-channel semantics,
> common release/digest protocol. See [docs/provisional.md](docs/provisional.md).
>
> **Synthetic-data warning:** every QB, identity, evidence ref, dataset, metric and dependency ID under `qbs/` is fictional
> example data, not real execution evidence.

Scope: QB Agents only. Tiny Agents, Execution Agents, Timesavers, Skills and **Zep** (architecturally
separate, cross-workspace intelligence) are different things and are referenced, never merged.

## Principles

1. **Git is the source of truth.** A QB version is a directory of data files. Changes arrive by PR.
2. **Definitions are data.** No code, endpoints, credentials or concrete model IDs in a blueprint.
3. **Immutable releases.** A version is sealed at `canary` (content-addressed); improvements are new versions.
4. **Stable IDs, not paths.** Cross-registry references are `<kind>:<slug>` + semver range.
5. **Evidence by pointer.** Raw sessions/tapes stay in Cortex; Git holds digests and URIs.
6. **No silent self-modification.** Production → evidence → candidate → evaluation → PR → validation → new version.
7. **Jev is a contract.** System-1 is reached through an abstract authenticated AI Gateway contract.

## Layout

```
schemas/                 JSON Schemas (2020-12): blueprint, eval suite, evidence refs, release seal,
                         evidence envelope (runtime contract), registry index
qbs/<slug>/<version>/    one immutable QB version
  blueprint.yaml           the canonical definition
  evals/suite.yaml         pre-release evaluation suite + promotion gates
  evidence/refs.yaml       append-only POINTERS to machine evidence (never raw data)
  release.yaml             digest seal, written by `npm run seal` at canary
registries.yaml          ID-kind → registry map (allow-list for reference kinds)
scripts/                 validator, sealer, index builder, immutability check
test/                    validator + immutability tests
docs/                    architecture and specs
.github/                 CI, CODEOWNERS, PR template
```

## Commands

```bash
npm ci
npm run validate            # schema + semantic + lifecycle + lineage checks
npm test
npm run build:index         # writes dist/index.json (the resolution contract for peers/runtimes)
npm run seal -- qb:<slug>@<version> --pr Zeptly/registry-qb-agents#N --approver <login>
npm run check:immutability -- --base origin/main
```

## Documentation

| | |
|---|---|
| [Architecture](docs/architecture.md) | Boundaries, layout, design rationale, AgentGit-inspired lineage |
| [Blueprint spec](docs/blueprint-spec.md) | Every section of a QB blueprint |
| [Lifecycle & versioning](docs/lifecycle-versioning.md) | Status model, semver rules, sealing |
| [Evidence model](docs/evidence-model.md) | Wisdom of Compute, lineage IDs, evidence refs |
| [Cross-registry references](docs/cross-registry-references.md) | ID + version protocol, index contract |
| [Evaluation](docs/evaluation.md) | Suites, gates, promotion evidence |
| [Security](docs/security.md) | Threat model and controls |
| [Contributing](CONTRIBUTING.md) | Authoring and promotion workflow |
| [Provisional status](docs/provisional.md) | NOT YET CANONICAL items and synthetic-data warning |
| [Decisions & open questions](docs/decisions.md) | ADRs and unresolved items |

The QBs under `qbs/` are **synthetic examples** (see warning above).
