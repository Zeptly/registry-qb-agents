# Structured references, indexes and resolution

> Follows the approved protocol. Peer-index **distribution** (how registries publish/retrieve indexes) is deferred and not
> implemented; the tooling here only reads LOCAL files and never touches the network.

## Reference object

```yaml
references:
  - registry: skills            # skills | tiny-agents | execution-agents | qb-agents
    id: source-evaluation       # shared lowercase dotted/hyphenated slugs; shared grammar only; no registry/kind reserved-prefix rule
    version: "^1.0.0"           # range in declarations; exact in provenance/lineage/locks
    digest: null                # optional integrity pin; when set, `digestAlgorithm: zeptly-jcs-v1` is required
```

* `spec` sections name ids only (`delegation.executionAgents.allow`, `tinyAgents.allowedTemplates`, `allowedSkills`,
  rule targets); the registry is implied by the field and every id MUST be declared in `references` (`E_REF_UNDECLARED`).
* **Prerelease policy** (one policy, local to this registry — not a cross-registry rule): `versionSatisfies` = semver `satisfies`
  *without* `includePrerelease`. `^1.0.0` does not admit `1.1.0-rc.1`; `^1.1.0-rc.0` does. The peer-index validator and the resolver share it.
* `qb-agents` references are rejected: nested QB execution is disabled (`E_NESTED_QB`).
* Capabilities and gateway contracts are **not** registries. They are opaque platform tokens (`capability:…`, `gateway:…`)
  whose namespace ownership is unresolved. They are validated by shape only.
* Structural validation needs no network: registry allow-list (`registries.yaml`), semver ranges, uniqueness, declaration.

## Index

`dist/index.json` (production) and `dist/synthetic-index.json` are **deterministic derived data** (no timestamps or commit
ids; sorted). Entry: `{registry, id, version, digest, maturity, lifecycle, origin, location, synthetic, sealed, references,
compatibility, replacedBy?}`. The production index schema forbids `synthetic: true`; the synthetic index only allows it.
CI builds both twice and compares.

## Resolution

```
declared range → resolver → exact version → content digest → runtime lock → evidence
```

`resolveRef` (offline, over peer-index entries supplied by the caller; Protocol v0.2 section 6). It never throws for unresolvable references.

* a malformed range is `invalid-range`; no entries for the registry at all is `no-peer-index`;
* **revoked** versions never resolve; **deprecated** versions resolve only by an exact version pin; **candidates** require explicit
  opt-in (`--allow-candidates`; the validator opts in for candidate QBs only);
* prereleases resolve only when the requested range names a prerelease (the shared policy above);
* a pinned `digest` (with `digestAlgorithm`) must match the selected entry (`digest-mismatch`, `digest-algorithm-mismatch`);
* **domains never mix**: a production subject resolves only `production` entries and a synthetic subject only `synthetic` ones
  (`domain-mismatch`). Structurally, production artifacts may not reference `synthetic.*` ids and synthetic ones may only reference
  `synthetic.*` ids (`E_SYNTHETIC`);
* the highest eligible version wins. Not transitive; cycle handling is a runtime responsibility (deferred).

`buildRuntimeLock` produces a `RuntimeLock` (`schemas/qb-runtime-lock.schema.json`):

```yaml
apiVersion: registry.zeptly.dev/v1alpha1
kind: RuntimeLock
digestAlgorithm: zeptly-jcs-v1
domain: synthetic                     # production | synthetic
subject: { registry, id, version, digest }
complete: false                       # true only when every entry resolved
entries:                              # EVERY declared reference, in declaration order
  - requested: { registry: skills, id: source-evaluation, version: "^1.0.0" }
    status: resolved                  # -> resolved: { registry, id, version, digest, digestAlgorithm }
  - requested: { registry: execution-agents, id: report-writer, version: "^2.0.0" }
    status: unresolved                # -> unresolved: { code, message }
```

Unresolved `code` values (names are QB-local; the amendment only requires an explicit code): `no-peer-index`, `invalid-range`,
`no-satisfying-version`, `digest-mismatch`, `digest-algorithm-mismatch`, `revoked`, `deprecated-requires-exact-pin`,
`candidate-requires-opt-in`, `domain-mismatch`. Foreign references are never silently omitted. An incomplete lock is not runnable.

```bash
npm run resolve -- synthetic.research-synthesis@1.0.0 --scope synthetic --index peer-index.json
# exit 0 complete lock; 1 valid request that cannot be satisfied; 2 malformed input / invalid registry / unreadable peer index
```

Peer-index files are local JSON (`{entries: [...]}` or an array); each entry needs `registry`, `id`, `version`, `maturity`,
`lifecycle` and should carry `domain` and `digestAlgorithm: zeptly-jcs-v1`. Fixtures: `test/fixtures/peer-index.resolves.synthetic.json`
(complete lock, exit 0) and `test/fixtures/peer-index.unresolved.synthetic.json` (explicit `no-satisfying-version`, exit 1).
With `--peer-index` files, `validate` additionally checks that non-optional references resolve by the same `resolveRef` policy (so a
canonical QB needs canonical, non-revoked peers). Without them only structure is checked.
