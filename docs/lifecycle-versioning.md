# Maturity, lifecycle, sealing and versioning

> Terms follow the approved Zeptly Registry Protocol v0.1. Traffic-channel routing is deferred and not part of the registry.

Three **independent** fields:

| Field | Values | Meaning |
|---|---|---|
| `metadata.maturity` | `candidate`, `canonical` | evaluation/promotion state of the version |
| `metadata.lifecycle` | `active`, `deprecated`, `revoked` | operational state, an append-only overlay |
| `metadata.origin.type` | `authored`, `evolved`, `imported` | how the version came to exist (`evolved` requires `evolution.sourceRefs`) |

## Maturity

* **candidate**: a registry object (not just a branch). May change until promoted. Attestations, if present, must bind
  the *current* digest, so any edit after assessment fails validation (`E_ATTESTATION_STALE`).
* **canonical**: sealed and immutable. Requires a release record (`npm run seal`), a passing `canonical`-gate evaluation
  attestation meeting `evals/suite.yaml` thresholds, a human `security-review` and a human `release-approval` bound to the
  digest, and provenance with ≥1 human author.
* A candidate for an existing identity must have a version **greater than every canonical version** of that id.
* There is no demotion: a canonical version can never return to candidate.

Only these may be appended to a canonical version: attestations, security approvals, evidence refs, lifecycle overlay
entries. Everything else is frozen (`check:immutability`).

## Lifecycle overlay (`lifecycle.yaml`)

Append-only history; first entry `active`; allowed transitions `active → deprecated → revoked` and `active → revoked`;
`revoked` is terminal. `metadata.lifecycle` must equal the last entry (or `active` when there is no overlay). Lifecycle
never changes the digest. Resolution (see [references](cross-registry-references.md)) never selects `revoked` versions.

## Digest

`digest = sha256(canonical JSON of the artifact minus metadata.maturity, metadata.lifecycle, security.approvals, attestations)`.
Those four are excluded because they change after content is fixed and (for the last two) bind *to* the digest. The
release record stores `digest` and `suiteDigest`; the index stores `digest`. Digest canonicalisation is a QB-registry choice
pending reconciliation.

## Semantic versioning

| Bump | When |
|---|---|
| MAJOR | breaking input/output contract; runtime/gateway major change (`spec.compatibility.breaking` requires it) |
| MINOR | additive change; **any permission/budget widening** (new capability/scope, higher ceiling, removed HITL step, swarm enabled, larger Jev data ceiling, raised classification) |
| PATCH | tuning without contract change or widening |

Enforced against `origin.evolution.sourceRefs[0]` (must exist, its digest must match when pinned, version must increase).
Widening emits `W_PERMISSION_WIDENING` for security review.
