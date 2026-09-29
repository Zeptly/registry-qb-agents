# Zeptly Registry Protocol v0.1: conformance map (QB registry)

The protocol is the approved baseline. Where it is silent the QB registry made the choice noted in the last column;
these choices are exposed for reconciliation, not asserted as protocol.

| Protocol rule | Implementation | Enforced by |
|---|---|---|
| Every artifact has `kind`, `metadata.id`, `metadata.version`, `metadata.registry` | `schemas/qb-blueprint.schema.json`; sidecars carry `kind` + `metadata{registry,id,version}` | schema |
| Published versions immutable, addressed by exact digest | `canonical` versions are frozen; digest = sha256 of canonical JSON minus `metadata.maturity`, `metadata.lifecycle`, `security.approvals`, `attestations` *(QB choice)* | `E_DIGEST`, `check:immutability` (`E_IMMUTABLE`) |
| Canonical versions use SemVer; a candidate must exceed every canonical version | `metadata.version` semver | `E_CANDIDATE_VERSION`, `E_SEMVER` |
| Candidates are registry objects; branches/PRs are transport | candidates are directories with `maturity: candidate`; `release.promotionRef` is transport only | schema/docs |
| `maturity`, `origin`, `lifecycle` independent | three separate `metadata` fields | schema, tests |
| Lifecycle is an append-only overlay (`active`, `deprecated`, `revoked`) | `lifecycle.yaml` overlay; `metadata.lifecycle` must equal the last entry | `E_LIFECYCLE`, `E_IMMUTABLE` |
| Structured cross-registry references `{registry, id, version, digest?}` | top-level `references[]`; `spec` points at ids that must be declared there | schema, `E_REF_UNDECLARED` |
| Runtime resolution: range → exact version + digest → lock → evidence | `ResolutionLock` schema, offline `resolveRef`/`buildResolutionLock`, `npm run resolve`, envelope event `resolution.locked` | schema, tests |
| Attestations bind to the exact subject digest | `attestations[].subjectDigest` must equal the current digest | `E_ATTESTATION_STALE`, `E_APPROVAL_STALE` |
| Raw tapes/trajectories/sensitive runtime artifacts stay out of Git | per-version file allow-list, runtime-artifact scan, schemas with `additionalProperties: false`, credential/URL lint | `E_UNEXPECTED_FILE`, `E_RUNTIME_ARTIFACT`, `E_SECRET`, `E_ENDPOINT` |
| Runtime/compiler must not elevate or alter declared security classification | `security.classification` and `security.capabilities` are declared, and must agree with `spec` | `E_SECURITY` |
| Generated indexes are deterministic derived data with identity, version, digest, maturity, lifecycle, origin, location | `dist/index.json`, `dist/synthetic-index.json`; no timestamps/commit ids; built twice and compared in CI | `build:index:verify` |
| Promotion requires schema validation, semantic checks, evaluations, provenance, security review, digest-bound attestations, governed approval | canonical needs: release record, passing `canonical`-gate evaluation attestation meeting suite thresholds, human `security-review` and `release-approval` bound to the digest, ≥1 human author | `E_PROMOTION`, `E_GATE`, `E_RELEASE` |
| Synthetic examples isolated, explicitly marked, never production | `synthetic/` tree, `synthetic.` id namespace, `metadata.synthetic: true`, `[EXAMPLE]` names, synthetic evidence store; production index schema forbids synthetic entries | `E_SYNTHETIC` |
| Runtime code, capability namespace ownership, gateway contracts, full Evidence Protocol are separate platform contracts | capabilities/gateways are opaque tokens; evidence envelope is marked provisional; no runtime code | docs, schema comments |

## Not implemented (deferred by the protocol / this pass)
Nested QB execution (schema-forbidden, `qb-agents` references rejected), traffic channels, peer-index distribution
(only local `--peer-index`/`--index` files), signed evaluations, capability/gateway/model namespace ownership,
workspace overrides, runtime-trigger contract versioning.
