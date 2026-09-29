# Cross-registry reference protocol

> **The identifier syntax, resolution algorithm and index publication described here are PROVISIONAL and NOT YET CANONICAL.** They are intentionally not aligned to the Skills Registry (or any peer) yet. See [provisional.md](provisional.md).

Registries: `registry-qb-agents` (this), `registry-execution-agents`, `registry-tiny-agents`, `registry-skills`,
plus capability/gateway/dataset namespaces. **No repository name, path or URL appears in a definition.**

## Grammar

```
id          := kind ":" slug ( "/" slug )*            slug := [a-z][a-z0-9-]* (≤64)
kind        := qb | execution-agent | tiny-agent | skill | capability | gateway | dataset | evalsuite
pinnedRef   := id "@" semver                           e.g. qb:research-synthesis@1.0.0
dependency  := { id, version: semver-range, optional?, digest? }
evidence    := "evidence://" store "/" path            opaque; resolved only by the evidence gateway
```

Examples: `execution-agent:web-researcher ^1.0.0`, `skill:source-citation ^1.0.0`,
`capability:web-search ^1.0.0`, `gateway:ai-gateway/jev ^1.0.0`.

Rules:

1. Every ID used anywhere in a blueprint (delegation targets, capabilities, Jev/state/evidence gateways, per-capability
   limits) **must be declared once in `dependencies`** with a semver range (`E_DEP_UNDECLARED`).
2. Kinds must exist in [`registries.yaml`](../registries.yaml). That file maps kinds to owning registries for humans/tooling;
   it is not used to locate files.
3. `digest` is an optional integrity pin, checked when the peer publishes digests.
4. `gateway:*` IDs name abstract **contracts** (AI Gateway/Jev, state store, evidence sink). Which physical service satisfies
   a contract is runtime configuration.

## Resolution contract: `dist/index.json`

Illustrative shape of an index (publication and retrieval are **unresolved**; `dist/index.json` is currently only a local build artifact uploaded by CI): each entry is (see `schemas/qb-registry-index.schema.json`):
`{ id, version, status, digest, dependencies, compatibility }` per version. A resolver would map `id + range → satisfying non-retired version → digest`; the resolution algorithm and distribution channel are not defined.

### Validation against peers

```bash
npm run validate -- --peer-index ../peer-indexes/execution-agents.json --peer-index …
```

With peer indexes: every non-optional dependency must have a satisfying, non-retired peer (`E_UNRESOLVED`); a `stable`
QB requires `stable` peers; digest pins must match. Without them, only syntax/kinds/declaration are checked (offline-safe).
`--peer-index` is a local aid only; how peer indexes are published and retrieved is unresolved.

## Reverse direction

Peers referencing a QB (e.g. a skill "used by qb:x") use `qb:<slug>@range` and resolve through this index the same way.
QBs never embed peer definitions; they never copy files across registries.
