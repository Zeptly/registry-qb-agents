# Canonical JSON, digests, directory seal and line-ending policy

One policy for every digest in this registry. Implemented in `scripts/lib/core.mjs` (`canonicalize`, `compareCodePoints`,
`artifactDigest`, `suiteDigest`, `directorySeal`). Golden vectors in `test/golden/` were computed with an independent
(Python) implementation of this document and are asserted by the tests.

## Canonical JSON

1. Input is parsed data (YAML `core` schema, unique keys). Only JSON data types are allowed; `undefined`, functions, `NaN`,
   `±Infinity`, bigint and symbols throw.
2. Output is UTF-8, with no insignificant whitespace.
3. Object keys are sorted by **Unicode code point** (`compareCodePoints`; equivalent to UTF-8 byte order). Neither locale
   collation nor UTF-16 code-unit order is used. Keys equal after line-ending normalisation are rejected.
4. Array order is preserved.
5. Numbers use the ECMAScript Number-to-String form (`-0` → `0`); strings use JSON escaping (only `"`, `\`, control characters
   below U+0020 are escaped; everything else, including U+2028 and non-BMP characters, is emitted literally).
6. **Line endings:** `\r\n` and lone `\r` inside string values and keys are normalised to `\n` before serialisation, so a digest never
   depends on checkout settings.

## Line-ending policy for files

Registry files are UTF-8 without BOM and use LF only. The loader rejects CR (`E_LINE_ENDING`), NUL (`E_BINARY`), a BOM or invalid
UTF-8 (`E_ENCODING`). `.gitattributes` forces `eol=lf` for YAML, JSON, Markdown and scripts.

## Artifact digest

`digest = sha256(canonical JSON of the artifact)`, formatted `sha256:<hex>`, after removing exactly:
`metadata.version`, `metadata.maturity`, `metadata.lifecycle`, `security.approvals` and `attestations`.

Included: `apiVersion`, `kind`, identity (`metadata.id`, `metadata.registry`, `metadata.origin`, `metadata.synthetic`, name, summary,
owners, labels, links), `spec`, `references`, `provenance`, and `security.classification` / `security.capabilities`.

Attestations and approvals bind to this digest, so they cannot be inside it. The version is excluded so identical content has one
digest; the version is bound by the directory seal and the index entry.

## Directory seal (canonical payload files)

Canonical payload files are `blueprint.yaml` (represented by its artifact digest) and `evals/suite.yaml` (canonical digest of the
parsed suite). `release.yaml`, `lifecycle.yaml` and `evidence/refs.yaml` are *not* payload: they are derived or append-only.

```
payload = [{path, digest}, ...]                                   sorted by code-point path
directorySeal = sha256(canonical JSON of {registry, id, version, payload})
```

The release record stores `digest`, `payload` and `directorySeal`; validation recomputes all three (`E_DIGEST`, `E_SEAL`). The seal
binds the version, so the same content sealed under two versions differs.

## Golden vectors

* `test/golden/canonical-json.json`: canonical strings and hashes for key-order (BMP vs astral), nesting, CRLF, escaping, empties.
* `test/golden/digest-seal.json`: artifact digest, suite digest, payload and directory seal of
  `synthetic/qbs/synthetic.research-synthesis/1.0.0`.

Editing that fixture (or changing this policy) changes the vectors and must be deliberate.
