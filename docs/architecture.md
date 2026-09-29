# Architecture

> **Candidate architecture, subject to cross-registry reconciliation.** Items listed in [provisional.md](provisional.md) are not yet canonical.

## Where this repository sits

```
                    ┌──────────────────────── Git (this repo) ────────────────────────┐
 human / WoC  ──PR──▶  qbs/<slug>/<ver>/{blueprint, evals, evidence refs, release}   │
                    └──────────────┬───────────────────────────────────────────────────┘
                                   │ dist/index.json (id, version, status, digest)
                                   ▼
   registry-execution-agents   runtime-trigger (Trigger.dev) ──▶ AI Gateway (Railway) ──▶ Jev / System-1
   registry-tiny-agents   ◀──  loads blueprint by id@range,     Cortex/Supabase (state, evidence)
   registry-skills             enforces policy, emits evidence   capability/provider gateways
```

* **This repo** = canonical behaviour & policy (what/why/limits). Reviewed, versioned, immutable once released.
* **Runtime** = execution. It reads a sealed blueprint by digest and must honour it. It never writes here.
* **Evidence store** = machine evidence produced by runs. Referenced from Git by URI + digest.
* **AI Gateway** = the only route to Jev/System-1 and models. The blueprint names a *contract*
  (`gateway:ai-gateway/jev@^1`), so Jev can move (Railway → elsewhere) without changing any QB.

## QB vs neighbours

| Class | Nature | Relationship to this repo |
|---|---|---|
| Tiny Agent | ephemeral, task-compiled | QB may *request compilation* (bounded by policy) |
| Execution Agent | durable task worker | QB delegates by ID |
| Timesaver | persistent workspace specialist (Railway) | out of scope |
| **QB** | **orchestrator** | **this repo** |
| Zep | singular cross-workspace intelligence | out of scope. `identity.agentClass` is fixed to `qb`; a QB cannot be Zep and Zep is never a dependency kind |

## Repository design

*Directory per immutable version* (`qbs/<slug>/<version>/`). Chosen over "one file + git tags" because
resolution by `id@version` is a plain lookup, released versions can sit side by side (canary vs stable),
diffs between versions are ordinary file diffs, and immutability is checkable from a PR diff.
Git history stays the audit trail; directories are the addressable snapshots.

*Data-only definitions.* Blueprints are YAML validated by JSON Schema (2020-12) plus semantic rules
(`scripts/lib/core.mjs`). The validator forbids URLs/hosts, credential-shaped strings, concrete model IDs
and repository paths inside definitions. Routing rules are structured data, deliberately not an expression language.

*Content addressing.* `blueprintDigest = sha256(canonical JSON of the blueprint minus lifecycle)`.
Evidence, releases and runtime events all bind to that digest, so "what exactly ran" is unambiguous.

## AgentGit-inspired lineage (adapted, not adopted)

[Agent-Git](https://github.com/MAS-Infra-Layer/Agent-Git) contributes concepts we reuse conceptually:

| AgentGit concept | Zeptly QB adaptation |
|---|---|
| External session (user conversation container) | `sessionId` (`qbs_…`): one user intent, root of a lineage tree |
| Internal session (branchable agent instance) | `runId` (`qbr_…`) + `branchId` (`qbb_…`) |
| Checkpoint / commit state | `checkpointId` (`qbc_…`), created at policy-defined triggers |
| Non-destructive rollback → new branch | `rollback` = `branch.forked` with `forkedFromCheckpointId`; history never rewritten |
| Tool track + reverse functions | `tool.called/returned` on the tape; `checkpointing.rollback.sideEffects: compensate\|block\|ignore` |
| SQLite repositories | *Not adopted.* Evidence lives in Cortex/Supabase behind a gateway contract |
| Rollback-by-agent-runtime | *Not adopted for definitions.* Rollback applies to **runs**; canonical **definitions** roll back via Git revert/new version |

We do not fork or inherit its implementation. The tape format is our own (`schemas/qb-evidence-envelope.schema.json`).
AgentGit's lineage vocabulary informs it. The registry itself never stores runs.

## Two lineages, kept distinct

1. **Definition lineage** (Git): `qb:x@1.0.0 → 1.1.0 → …`, via `provenance.parent`, PR-reviewed.
2. **Execution lineage** (evidence store): session → run → branch → checkpoint → event, each event stamped with
   `qb.id`, `qb.version`, `blueprintDigest`. This is the join key between the two.

## Extensibility

Add fields under the root `extensions` object (linted, non-authoritative) first; promote to a schema section by
bumping `apiVersion` (`qb.zeptly.dev/v1` → `v2`) with a migration note. New ID kinds are added in `registries.yaml`.
New lifecycle gates are added to suites, not to the schema.
