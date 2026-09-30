# Manifest input, canonical JSON (RFC 8785), digests and directory seal

Zeptly Registry Protocol v0.2 rendering. Hash-contract identifier: **`digestAlgorithm: zeptly-jcs-v1`**. Implemented in
`scripts/lib/core.mjs` (`parseYaml`, `parseManifestBytes`, `canonicalize`, `artifactDigest`, `suiteDigest`, `sealPayload`,
`directorySeal`, `checkSuiteBinding`). Language-neutral vectors live in `test/golden/v0.2/` (`parser.json`, `jcs.json`,
`digest-seal.json`, `suite-binding.json`, `lock.json`). `jcs.json`, `digest-seal.json` and `suite-binding.json` are produced by
`test/golden/v0.2/generate.py`, an independent Python implementation that shares no code with the validator; the tests assert them.
A contract change requires a new `digestAlgorithm` identifier and new vectors.

## Manifest input: the v0.2 JSON-compatible YAML subset

Every YAML file the registry accepts (blueprint, evaluation suite, evidence refs, lifecycle overlay, release record, `registries.yaml`)
is read with the same rules (`parseManifestBytes` → `parseYaml`):

* bytes: valid UTF-8, **no BOM, no NUL, no CR** (CRLF and lone CR are rejected, never normalised);
* YAML 1.2 core schema, **one document**, **string keys only**, **unique keys**;
* **no anchors, aliases or merge keys** (`<<`), **no tags** outside the core schema (`!!binary`, `!!timestamp`, `!!set`, local tags);
* timestamps stay strings; `yes`/`no`/`on`/`off` are strings;
* integers are decimal/`0x`/`0o`/exponent literals within ±(2^53−1). The literal text of every scalar *and mapping key* is tested
  exactly (BigInt) **before** the parser rounds it, so `9007199254740993` and `1e16` are rejected; fractional literals and in-range
  integers such as `1e3` are accepted;
* no non-finite numbers (`.inf`, `-.inf`, `.nan`), no lone surrogates (raw or via `\ud800` escapes).

Every rejection is a controlled `{code, file, where (JSON pointer), message}` diagnostic, never an uncaught exception, and the CLIs
exit **2**. Codes: `E_YAML`, `E_DUPLICATE_KEY`, `E_YAML_MULTIDOC`, `E_YAML_ALIAS`, `E_YAML_MERGE`, `E_YAML_KEY`, `E_YAML_TAG`,
`E_UNSAFE_INTEGER`, `E_DATA_TYPE` (non-finite numbers, lone surrogates, unsupported values), `E_ENCODING`, `E_BINARY`, `E_LINE_ENDING`.
Data is validated **before** any clone or hash (there is no `JSON.parse(JSON.stringify(x))`), so a non-finite number can never
silently become `null`; `artifactDigest`/`suiteDigest`/`canonicalize` throw `DataRejectedError` carrying the same diagnostics.

## Canonical JSON: RFC 8785 JCS

1. UTF-8 output, no insignificant whitespace; arrays keep their order.
2. Object keys sort by **UTF-16 code units** (`compareUtf16`; `U+10000` sorts before `U+FFFF`). This is the only place UTF-16 order is used.
3. Strings use RFC 8785 escaping; numbers use the ECMAScript Number-to-String algorithm (`-0` → `0`); only finite numbers are accepted.
4. **No Unicode normalisation** (NFC and NFD stay distinct) and **no line-ending rewriting** inside parsed manifest values: a `\r\n`
   produced by an escape in a manifest string is preserved and significant.
5. Unsupported values (NaN, Infinity, undefined, bigint, symbols, functions, non-plain objects, holes, lone surrogates, cycles, nesting
   deeper than 128) throw.

Payload text files are UTF-8, BOM-free and LF-only; the registry rejects rather than normalises, and validates the bytes exactly
as they are hashed. **Ordering elsewhere is code-point order**: index entries (id, then SemVer, then digest) and payload paths
(`compareCodePoints`); this is separate from JSON key ordering.

## Artifact digest

`digest = sha256:<hex> of JCS(artifact projection)`. The projection is the blueprint with exactly these fields removed:
`metadata.version`, `metadata.maturity`, `metadata.lifecycle`, `security.approvals`, `attestations`.
Included: `apiVersion`, `kind`, identity (`metadata.id`, `metadata.registry`, `metadata.origin`, `metadata.synthetic`, name, summary,
owners, labels, links), `spec` (including runtime approval requirements such as `spec.hitl`), `references`, `provenance`, and
`security.classification` / `security.capabilities`. Governance approvals and attestations bind to the digest through `subjectDigest`.
Because the projection is JCS of the same data, ASCII-keyed artifacts hash as before v0.2; `digestAlgorithm` itself is carried next to
digests (index entries, release record, locks, digest-pinned references) and is not part of the projection.

## Directory seal

Payload files are `blueprint.yaml` (represented by its artifact digest) and `evals/suite.yaml` (digest of the JCS of the parsed suite,
`suiteDigest`). `release.yaml`, `lifecycle.yaml` and `evidence/refs.yaml` are not payload (derived or append-only).

```
payload = [{path, digest}, ...]                               ordered by POSIX path, code-point order
directorySeal = sha256(JCS({registry, id, version, payload}))
```

The release record stores `digest`, `digestAlgorithm`, `payload` and `directorySeal`; validation recomputes them (`E_DIGEST`,
`E_DIGEST_ALGORITHM`, `E_SEAL`). The seal binds registry, id and version. Before hashing, the loader rejects symlinks, FIFOs/sockets/devices
(`E_SPECIAL_FILE`), case-colliding paths (`E_CASE_COLLISION`) and files outside the allow-list (`E_UNEXPECTED_FILE`).
QB-local interpretation: the amendment says the seal lists "every permitted payload file and its SHA-256"; this registry's only payload
files are manifests, so each is represented by its JCS digest (blueprint = artifact digest) rather than by raw-byte hashes.

## Suite binding

Evaluation attestations carry `suite: {id, version, digest}` (`registry` optional, must match when present).
`checkSuiteBinding` returns `E_SUITE_MISMATCH` (different suite identity) or `E_SUITE_STALE` (same id/version, different `suiteDigest`):
a suite change stales the evaluation even when the artifact digest is unchanged, and resealing alone never makes an old evaluation valid.

## Vectors

| File | Covers |
|---|---|
| `test/golden/v0.2/parser.json` | accepted/rejected YAML text and raw bytes (duplicate keys, aliases, merge keys, multi-doc, keys, tags, unsafe integers, non-finite, surrogates, BOM/NUL/UTF-8/CR) |
| `test/golden/v0.2/jcs.json` | RFC 8785 key order, numbers, escaping, no normalisation, no line-ending rewriting; rejection kinds |
| `test/golden/v0.2/digest-seal.json` | artifact digest, excluded/included fields, payload mutation, seal ordering/version/registry binding |
| `test/golden/v0.2/suite-binding.json` | suite digest, matching, stale and mismatched bindings |
| `test/golden/v0.2/lock.json` | RuntimeLock resolution cases, domains, codes (hand-derived from the amendment) |
| `test/golden/digest-seal.json` | digest, suite digest and seal of `synthetic/qbs/synthetic.research-synthesis/1.0.0` (unchanged by v0.2) |
