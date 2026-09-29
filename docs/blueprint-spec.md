# QB Blueprint specification (`qb.zeptly.dev/v1`)

Authoritative schema: [`schemas/qb-blueprint.schema.json`](../schemas/qb-blueprint.schema.json).
Semantic rules: `validateVersion()` in `scripts/lib/core.mjs`. Worked examples: [`qbs/`](../qbs).

| Section | Purpose | Notable rules |
|---|---|---|
| `id`, `version` | Stable identity `qb:<slug>` + semver | must match directory `qbs/<slug>/<version>/` |
| `metadata` | name, summary, owners, labels, human links | URLs allowed only in `metadata.links` |
| `lifecycle` | status + deprecation | excluded from digest; see [lifecycle](lifecycle-versioning.md) |
| `identity` | `agentClass: qb`, role, persona, instructions, boundaries | instructions are inline text, treated as data |
| `purpose` | goal, non-goals, task classes (with risk) | high/critical risk forces human approval |
| `contracts` | input/output JSON Schemas, error codes | change ⇒ ≥ minor bump; scenario inputs must validate |
| `orchestration` | allowed strategies, depth, steps, timeout, nested QB | default must be allowed; `swarm` needs `swarm.enabled` |
| `planning` | approach, plan artifact, review (self / System-1 / human) | System-1 critique needs Jev `critique` op |
| `decomposition` | strategy, max subtasks, DAG/sequence, acceptance criteria | |
| `delegation` | allowed Execution Agents, Tiny Agent compile policy, structured rules, fallback | targets must be in `dependencies` |
| `evaluation` | intermediate + final evaluators/thresholds, suite pointer | `system-one` evaluator needs Jev `evaluate` |
| `replanning` | triggers, max replans, retry, exhaustion behaviour | `budget-pressure` needs `budgets.softLimitRatio` |
| `jev` | gateway **contract** + version, per-operation mode, unavailability behaviour, data handling | no endpoints; contract must be in `compatibility.gatewayContracts` |
| `models` | abstract tiers per role (`frontier/strong/balanced/fast`), gateway-routed | concrete model IDs rejected |
| `context` | working-token budget, compaction, memory scopes, handoff minimisation/redaction | |
| `checkpointing` | granularity, triggers, retention, resume strategy, rollback semantics | rollback = new branch, never rewrite |
| `concurrency` | parallel delegations / Tiny Agents / per-capability caps | |
| `swarm` | enabled, max size, patterns, aggregation, HITL threshold, abort ratio | size ≤ Tiny Agent and budget caps |
| `budgets` | per-run cost/tokens/wall-clock/tool calls/delegations/Tiny Agents, soft ratio, on-exceed | callers may only lower |
| `capabilities` | default-deny allow-list with scopes (`read/write/execute/external-send`) | `external-send` needs HITL |
| `escalation` | rules → actions, default | |
| `hitl` | approval points, timeout, timeout behaviour (`deny` default-safe) | |
| `state` | durable, resumable, abstract state-store contract | |
| `dependencies` | **single list** of `{id, version range, optional?, digest?}` | every ID used elsewhere must be declared here |
| `evidence` | what the runtime must capture, tape level, redaction, retention, sink contract | |
| `governance` | `selfModification: forbidden`, change control | constants; not overridable |
| `provenance` | origin (`human/wisdom-of-compute/import`), authors, parent, derivedFrom, changelog | ≥1 human author always |
| `compatibility` | registry schema, runtime contract range, gateway contract ranges, breaking notes | |
| `extensions` | namespaced non-authoritative hints | linted like everything else |

## Design notes

* **Least privilege by default**: `capabilities.default` is the constant `deny`.
* **One dependency table** keeps version pinning in one place and makes peer resolution a single loop.
* **Tiers, not models**: model choice is a runtime/gateway concern that changes monthly; policy (capability needs, diversity) is canonical.
* **Jev operations are per-op**: `required | preferred | optional | disabled`, with an explicit `onUnavailable` (halt / escalate / degrade).
