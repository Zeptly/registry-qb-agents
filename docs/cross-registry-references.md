# Structured references, indexes and resolution

> Follows the approved protocol. Peer-index **distribution** (how registries publish/retrieve indexes) is deferred and not
> implemented; the tooling here only reads LOCAL files and never touches the network.

## Reference object

```yaml
references:
  - registry: skills            # skills | tiny-agents | execution-agents | qb-agents
    id: source-evaluation       # shared lowercase dotted/hyphenated slugs; no registry/kind prefix (E_ID_PREFIX)
    version: "^1.0.0"           # range in declarations; exact in provenance/lineage/locks
    digest: null                # optional integrity pin
```

* `spec` sections name ids only (`delegation.executionAgents.allow`, `tinyAgents.allowedTemplates`, `allowedSkills`,
  rule targets); the registry is implied by the field and every id MUST be declared in `references` (`E_REF_UNDECLARED`).
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

`resolveRef` (offline, over index entries supplied by the caller): highest satisfying **canonical**, **non-revoked** version;
candidates and revoked versions are never selected; a pinned `digest` must match. It never throws for unresolvable references.

`buildResolutionLock` produces a `ResolutionLock` (`schemas/qb-resolution-lock.schema.json`):

```yaml
root:     { registry, id, version, digest }
complete: false                       # true only when every reference is resolved
locks:                                # EVERY declared reference, in declaration order
  - declared: { registry: skills, id: source-evaluation, version: "^1.0.0" }
    status: resolved                  # -> resolved: { registry, id, version, digest }
  - declared: { registry: execution-agents, id: report-writer, version: "^2.0.0" }
    status: unresolved                # -> reason: peer-index-unavailable | no-satisfying-version | digest-mismatch | invalid-range
```

Foreign references are never silently omitted: with no peer index for a registry they appear as `unresolved` /
`peer-index-unavailable`. An incomplete lock is not runnable. The runtime records the lock in evidence (`resolution.locked`).

```bash
npm run resolve -- synthetic.research-synthesis@1.0.0 --scope synthetic --index peer-index.json   # exit 0 complete, 3 incomplete
```

With `--peer-index` files, `validate` additionally checks that non-optional references resolve and that a canonical QB
depends on canonical peers. Without them only structure is checked.
