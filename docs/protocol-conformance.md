# Zeptly Registry Protocol v0.1 + v0.2 amendment: conformance map (QB registry)

The v0.1 protocol is the approved baseline; the v0.2 amendment (draft for review) is implemented on top of it (hash contract `digestAlgorithm: zeptly-jcs-v1`). Where it is silent the QB registry made the choice noted in the last column;
these choices are exposed for reconciliation, not asserted as protocol.

| Protocol rule | Implementation | Enforced by |
|---|---|---|
| Every artifact has `kind`, `metadata.id`, `metadata.version`, `metadata.registry` | `schemas/qb-blueprint.schema.json`; sidecars carry `kind` + `metadata{registry,id,version}`. IDs use the shared lowercase dotted/hyphenated grammar (no registry/kind reserved-prefix rule beyond the grammar); origin types `native|upstream-seed|discovered|refined|evolved`; the evolution kind (`discovered|refined|generalised`) lives only at `metadata.origin.evolution.kind` | schema |
| Published versions immutable, addressed by exact digest | `canonical` versions are frozen; artifact digest = sha256 of RFC 8785 JCS minus `metadata.version`, `metadata.maturity`, `metadata.lifecycle`, `security.approvals`, `attestations`; a separate directory seal over the canonical payload files (`blueprint.yaml`, `evals/suite.yaml`) binds registry/id/version. RFC 8785 JCS (UTF-16 key order, no normalisation, no line-ending rewriting), v0.2 JSON-compatible YAML subset, LF-only payload files: [canonicalization.md](canonicalization.md) | `E_DIGEST`, `E_SEAL`, `check:immutability` (`E_IMMUTABLE`), `E_DIGEST_ALGORITHM`, golden-vector tests (`test/golden/v0.2`) |
| Canonical versions use SemVer; a candidate must exceed every canonical version | `metadata.version` semver | `E_CANDIDATE_VERSION`, `E_SEMVER` |
| Candidates are registry objects; branches/PRs are transport | candidates are directories with `maturity: candidate`; `release.promotionRef` is transport only | schema/docs |
| `maturity`, `origin`, `lifecycle` independent | three separate `metadata` fields | schema, tests |
| Lifecycle is an append-only overlay (`active`, `deprecated`, `revoked`) | `lifecycle.yaml` overlay; `metadata.lifecycle` must equal the last entry | `E_LIFECYCLE`, `E_IMMUTABLE` |
| Structured cross-registry references `{registry, id, version, digest?}` | top-level `references[]`; `spec` points at ids that must be declared there | schema, `E_REF_UNDECLARED` |
| Runtime resolution: range → exact version + digest → lock → evidence | `RuntimeLock` (`digestAlgorithm`, `domain`, `subject`, `complete`, `entries[]` with `resolved` or `unresolved{code,message}`). Every declared reference is listed. Revoked never resolves, deprecated only by exact pin, candidates need opt-in, prereleases only when the range names one, digest pins must match, production/synthetic never mix. Offline `resolveRef`/`buildRuntimeLock`, `npm run resolve` (exit 0 complete, 1 unsatisfiable, 2 malformed), envelope event `resolution.locked` | schema, tests |
| Attestations bind to the exact subject digest (and, for evaluations, the exact suite: `suite.{registry,id,version,digest}`) | `attestations[].subjectDigest` must equal the current digest; `suite.digest` must equal the current suite digest | `E_ATTESTATION_STALE`, `E_APPROVAL_STALE`, `E_SUITE_STALE`, `E_SUITE_MISMATCH` |
| Raw tapes/trajectories/sensitive runtime artifacts stay out of Git | explicit filename allow-list, size limits (256 KiB per file, 1 MiB per version), symlinks never followed and rejected, FIFOs/sockets/devices and case-colliding paths rejected, NUL/BOM/CR/invalid UTF-8 rejected, tape/trace/transcript detection by extension, directory, name and content shape, closed schemas, credential/URL lint | `E_UNEXPECTED_FILE`, `E_SIZE`, `E_SYMLINK`, `E_SPECIAL_FILE`, `E_CASE_COLLISION`, `E_BINARY`, `E_ENCODING`, `E_LINE_ENDING`, `E_RUNTIME_ARTIFACT`, `E_SECRET`, `E_ENDPOINT` |
| Runtime/compiler must not elevate or alter declared security classification | `security.classification` and `security.capabilities` are declared, and must agree with `spec` | `E_SECURITY` |
| Generated indexes are deterministic derived data with identity, version, digest, maturity, lifecycle, origin, location | `dist/index.json`, `dist/synthetic-index.json`; no timestamps/commit ids; sorted by an explicit code-point comparator on id, then SemVer, then digest (no `localeCompare`; JSON key order stays UTF-16 JCS); every entry carries `digestAlgorithm` and `domain`; canonical entries carry `directorySeal`; built twice and compared in CI | `build:index:verify` |
| Promotion requires schema validation, semantic checks, evaluations, provenance, security review, digest-bound attestations, governed approval | canonical needs: release record, passing `canonical`-gate evaluation attestation meeting suite thresholds, human `security-review` and `release-approval` bound to the digest, ≥1 human author | `E_PROMOTION`, `E_GATE`, `E_RELEASE` |
| Synthetic examples isolated, explicitly marked, never production | `synthetic/` tree, `synthetic.` id namespace, `metadata.synthetic: true`, `[EXAMPLE]` names, synthetic evidence store; production index schema forbids synthetic entries | `E_SYNTHETIC` |
| Runtime code, capability namespace ownership, gateway contracts, full Evidence Protocol are separate platform contracts | capabilities/gateways are opaque tokens; evidence envelope is marked provisional; no runtime code | docs, schema comments |

## Not implemented (deferred by the protocol / this pass)
Nested QB execution (schema-forbidden, `qb-agents` references rejected), traffic channels, peer-index distribution
(only local `--peer-index`/`--index` files), signed evaluations, capability/gateway/model namespace ownership,
workspace overrides, runtime-trigger contract versioning.

## v0.2 adoption (error codes added)
`E_DUPLICATE_KEY`, `E_YAML_MULTIDOC`, `E_YAML_ALIAS`, `E_YAML_MERGE`, `E_YAML_KEY`, `E_YAML_TAG`, `E_DIGEST_ALGORITHM`, `E_SPECIAL_FILE`, `E_CASE_COLLISION`, `E_PEER_INDEX`. Exit codes: 0 success, 1 valid request that cannot be satisfied (`resolve`), 2 malformed input or validation errors.

## Local defect remediation (error codes added)
`E_DATA_TYPE` (non-finite/unsupported data), `E_UNSAFE_INTEGER` (integer literal outside ±(2^53−1)), `E_SUITE_STALE`,
`E_SUITE_MISMATCH`, `E_INTERNAL` (unexpected validator failure reported per version). Open for the shared specification:
a cross-registry prerelease policy, the RuntimeLock unresolved-code names, whether suite/payload hashes are raw-byte SHA-256 or JCS digests of parsed manifests, whether `digestAlgorithm` belongs inside digest-pinned references (it changes their artifact digest),
attestation type registry, and the fact that CI's immutability check is vacuous against the empty `main` (covered by populated-baseline tests).
