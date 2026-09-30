# Zeptly Registry Protocol v0.1: conformance map (QB registry)

The protocol is the approved baseline. Where it is silent the QB registry made the choice noted in the last column;
these choices are exposed for reconciliation, not asserted as protocol.

| Protocol rule | Implementation | Enforced by |
|---|---|---|
| Every artifact has `kind`, `metadata.id`, `metadata.version`, `metadata.registry` | `schemas/qb-blueprint.schema.json`; sidecars carry `kind` + `metadata{registry,id,version}`. IDs use the shared lowercase dotted/hyphenated grammar with no registry/kind prefixes; the evolution kind lives only at `metadata.origin.evolution.kind` | schema, `E_ID_PREFIX` |
| Published versions immutable, addressed by exact digest | `canonical` versions are frozen; artifact digest = sha256 of canonical JSON minus `metadata.version`, `metadata.maturity`, `metadata.lifecycle`, `security.approvals`, `attestations`; a separate directory seal over the canonical payload files (`blueprint.yaml`, `evals/suite.yaml`) binds registry/id/version. One canonical JSON + LF policy: [canonicalization.md](canonicalization.md) | `E_DIGEST`, `E_SEAL`, `check:immutability` (`E_IMMUTABLE`), golden-vector tests |
| Canonical versions use SemVer; a candidate must exceed every canonical version | `metadata.version` semver | `E_CANDIDATE_VERSION`, `E_SEMVER` |
| Candidates are registry objects; branches/PRs are transport | candidates are directories with `maturity: candidate`; `release.promotionRef` is transport only | schema/docs |
| `maturity`, `origin`, `lifecycle` independent | three separate `metadata` fields | schema, tests |
| Lifecycle is an append-only overlay (`active`, `deprecated`, `revoked`) | `lifecycle.yaml` overlay; `metadata.lifecycle` must equal the last entry | `E_LIFECYCLE`, `E_IMMUTABLE` |
| Structured cross-registry references `{registry, id, version, digest?}` | top-level `references[]`; `spec` points at ids that must be declared there | schema, `E_REF_UNDECLARED` |
| Runtime resolution: range → exact version + digest → lock → evidence | `ResolutionLock` (`complete`; per-reference `status` `resolved`/`unresolved` with `reason`). Every declared reference is listed and unresolved ones are explicit (e.g. `peer-index-unavailable`). Offline `resolveRef`/`buildResolutionLock`, `npm run resolve` (exit 3 when incomplete), envelope event `resolution.locked` | schema, tests |
| Attestations bind to the exact subject digest (and, for evaluations, the exact suite: `suite.{registry,id,version,digest}`) | `attestations[].subjectDigest` must equal the current digest; `suite.digest` must equal the current suite digest | `E_ATTESTATION_STALE`, `E_APPROVAL_STALE`, `E_SUITE_STALE`, `E_SUITE_MISMATCH` |
| Raw tapes/trajectories/sensitive runtime artifacts stay out of Git | explicit filename allow-list, size limits (256 KiB per file, 1 MiB per version), symlinks never followed and rejected, NUL/BOM/CR rejected, tape/trace/transcript detection by extension, directory, name and content shape, closed schemas, credential/URL lint | `E_UNEXPECTED_FILE`, `E_SIZE`, `E_SYMLINK`, `E_BINARY`, `E_ENCODING`, `E_LINE_ENDING`, `E_RUNTIME_ARTIFACT`, `E_SECRET`, `E_ENDPOINT` |
| Runtime/compiler must not elevate or alter declared security classification | `security.classification` and `security.capabilities` are declared, and must agree with `spec` | `E_SECURITY` |
| Generated indexes are deterministic derived data with identity, version, digest, maturity, lifecycle, origin, location | `dist/index.json`, `dist/synthetic-index.json`; no timestamps/commit ids; sorted by an explicit code-point comparator then semver (no `localeCompare`); canonical entries carry `directorySeal`; built twice and compared in CI | `build:index:verify` |
| Promotion requires schema validation, semantic checks, evaluations, provenance, security review, digest-bound attestations, governed approval | canonical needs: release record, passing `canonical`-gate evaluation attestation meeting suite thresholds, human `security-review` and `release-approval` bound to the digest, ≥1 human author | `E_PROMOTION`, `E_GATE`, `E_RELEASE` |
| Synthetic examples isolated, explicitly marked, never production | `synthetic/` tree, `synthetic.` id namespace, `metadata.synthetic: true`, `[EXAMPLE]` names, synthetic evidence store; production index schema forbids synthetic entries | `E_SYNTHETIC` |
| Runtime code, capability namespace ownership, gateway contracts, full Evidence Protocol are separate platform contracts | capabilities/gateways are opaque tokens; evidence envelope is marked provisional; no runtime code | docs, schema comments |

## Not implemented (deferred by the protocol / this pass)
Nested QB execution (schema-forbidden, `qb-agents` references rejected), traffic channels, peer-index distribution
(only local `--peer-index`/`--index` files), signed evaluations, capability/gateway/model namespace ownership,
workspace overrides, runtime-trigger contract versioning.

## Local defect remediation (error codes added)
`E_DATA_TYPE` (non-finite/unsupported data), `E_UNSAFE_INTEGER` (integer literal outside ±(2^53−1)), `E_SUITE_STALE`,
`E_SUITE_MISMATCH`, `E_INTERNAL` (unexpected validator failure reported per version). Open for the shared specification:
RFC 8785 key order, YAML 1.1 vs 1.2 parser dependence, escaped-CR collapse, no NFC normalisation, a cross-registry prerelease policy,
attestation type registry, and the fact that CI's immutability check is vacuous against the empty `main` (covered by populated-baseline tests).
