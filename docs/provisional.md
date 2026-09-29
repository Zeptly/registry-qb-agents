# Provisional status and NOT YET CANONICAL items

The current implementation is accepted only as a **candidate QB Registry architecture**, subject to later
cross-registry reconciliation with `registry-execution-agents`, `registry-tiny-agents` and `registry-skills`.
Nothing below should be copied into, or relied on by, another registry yet.

| Item | Status | Where it appears | Note |
|---|---|---|---|
| Cross-registry identifier syntax (`<kind>:<slug>`, `id@semver`, ranges) | **PROVISIONAL, NOT YET CANONICAL** | `schemas/common.schema.json`, `docs/cross-registry-references.md` | Deliberately *not* aligned to the Skills registry yet |
| Lifecycle terminology (`draft/candidate/canary/stable/deprecated/retired`) | **NOT YET CANONICAL** | `docs/lifecycle-versioning.md`, `lifecycleStatus` | |
| Evidence-envelope ownership and schema | **PROVISIONAL OWNERSHIP** | `schemas/qb-evidence-envelope.schema.json` | May become a shared platform-level Zeptly contract |
| Index publication and retrieval mechanism | **UNRESOLVED** | `schemas/qb-registry-index.schema.json`, `--peer-index` | `dist/index.json` is a local build artifact; `--peer-index` is a local validation aid only |
| Shared namespace ownership (`capability:`, `gateway:`, `dataset:`) | **UNRESOLVED** | `registries.yaml` | No owning registry (`repo: null`) |
| Traffic-channel semantics (canary/stable routing) | **UNRESOLVED** | not implemented | The registry publishes versions and statuses only; no traffic splitting, channels or "latest" pointers |
| Common release/digest protocol (seal, digest algorithm, canonicalisation) | **NOT YET CANONICAL** | `scripts/lib/core.mjs`, `release.yaml` | Digest = sha256 of key-sorted JSON minus `lifecycle` |
| Signed evaluation results | **UNRESOLVED** | `docs/evaluation.md` | Gate metrics are unattested claims |
| Nested QB execution | **DISABLED / UNRESOLVED** | `orchestration.nestedQb` (only `forbidden` is valid) | |

## Synthetic data warning

Everything under `qbs/` is **synthetic example data** used to exercise the tooling: the QBs, their people/team
identities (`example-*`), dependency IDs, datasets, evaluation runs, metrics, evidence URIs and release seals.
None of it is real execution evidence, none of the dependency IDs resolve in a real registry, and no real
promotion occurred. The validator enforces this: example blueprints (label `example: "true"`) must be named
`[EXAMPLE] ...`, carry `synthetic: "true"`, use only the `evidence://synthetic-example/` store and
`dataset:synthetic-example/*` datasets, and every evidence ref states `synthetic: true` with a
`SYNTHETIC EXAMPLE` summary. Real blueprints cannot reference the synthetic store. Index entries carry
`synthetic: true` so production consumers can exclude them.
