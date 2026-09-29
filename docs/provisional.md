# Provisional, deferred and QB-choice items

The Zeptly Registry Protocol v0.1 is the approved baseline. This page separates (a) what the protocol defers,
(b) provisional QB-side contracts, and (c) choices the QB registry made where the protocol is silent.

## (a) Deferred by the protocol: NOT implemented here

| Item | State in this repo |
|---|---|
| Evidence Protocol ownership and full schema | `schemas/qb-evidence-envelope.schema.json` is a **provisional QB-side contract**; ownership unresolved |
| Capability / gateway / model namespace ownership, gateway contracts | tokens are **opaque**; only shape-validated; no owner assigned |
| Signing / signed evaluations | none; attestations are digest-bound but unsigned |
| Peer-index distribution | none; only local `--peer-index` / `--index` files, no network |
| Workspace overrides / private QBs | none |
| Traffic channels | none; the registry publishes versions/maturity/lifecycle only, and no traffic splitting exists |
| Nested QB execution | disabled: `spec.orchestration.nestedQb` accepts only `forbidden`; `qb-agents` references are rejected |
| runtime-trigger contract versioning | `spec.compatibility.runtime` is a declared range only |

## (b) Provisional QB-side contracts (may move to shared platform ownership)
Evidence envelope and lineage ids; `ResolutionLock` shape; index entry shape.

## (c) QB-registry choices where the protocol is silent (flag for reconciliation)

| Choice | Value |
|---|---|
| Artifact id grammar | dot-separated lowercase slugs |
| `maturity` values | `candidate`, `canonical` only |
| Candidate mutability | candidates may change until promoted; attestations go stale on any change |
| Digest | sha256 of key-sorted JSON minus `metadata.maturity`, `metadata.lifecycle`, `security.approvals`, `attestations` |
| Seal point | promotion to `canonical` writes an immutable release record |
| `origin.type` values / `evolution.kind` | `authored\|evolved\|imported` / `refined` only |
| Approval types | `security-review`, `release-approval` (human, digest-bound) |
| Directory layout, sidecar files | `<scope>/<id>/<version>/{blueprint,release,lifecycle}.yaml`, `evals/`, `evidence/` |
| Resolver policy | highest canonical, non-revoked satisfying version (candidates never selected) |

## Synthetic data warning
Everything under `synthetic/` is fictional: QBs, identities (`example-*`), referenced ids (`synthetic.*`), capability
tokens, datasets, evaluation runs, metrics, evidence URIs, approvals and release records. None of it is real execution
evidence; referenced ids resolve nowhere. The validator enforces isolation: synthetic artifacts must sit under
`synthetic/`, use the `synthetic.` id namespace, `metadata.synthetic: true`, `[EXAMPLE]` names, the
`evidence://synthetic-example/` store, `dataset:synthetic-example/*` datasets and `SYNTHETIC EXAMPLE` summaries; production
artifacts cannot reference synthetic evidence; the production index schema rejects synthetic entries.
