# QB Blueprint specification (`registry.zeptly.dev/v1alpha1`, `kind: QBBlueprint`)

Schema: [`schemas/qb-blueprint.schema.json`](../schemas/qb-blueprint.schema.json). Semantic rules: `validateVersion()` in
`scripts/lib/core.mjs`. Examples: [`synthetic/`](../synthetic) (fictional).

## Envelope (protocol-common)

| Field | Content |
|---|---|
| `metadata` | `id`, `version`, `registry: qb-agents`, `origin`, `maturity`, `lifecycle`, `synthetic?`, `name`, `summary`, `owners`, `labels?`, `links?` |
| `spec` | QB-specific semantics (below) |
| `references` | structured `{registry, id, version, digest?}` |
| `provenance` | `createdAt`, `authors` (≥1 human), `sourceRefs`, `transformations`, `externalSources?`, `changelog?` |
| `security` | `classification`, `capabilities` (must equal `spec.capabilities.allow`), `approvals` (digest-bound) |
| `attestations` | digest-bound assessments |

## `spec` (class-specific semantics, preserved)

| Section | Purpose | Notable rules |
|---|---|---|
| `identity` | `agentClass: qb`, role, instructions, boundaries | inline text treated as data |
| `purpose` | goal, non-goals, task classes with risk | high risk forces human approval |
| `contracts` | input/output JSON Schemas, error codes | scenario inputs must validate; change ⇒ ≥ minor bump |
| `orchestration` | strategies, depth, steps, timeout, `nestedQb` | `nestedQb` may only be `forbidden` |
| `planning`, `decomposition` | approach, plan artifact, review; strategy, subtasks, DAG | System-1 critique needs Jev `critique` |
| `delegation` | Execution Agent allow-list, Tiny Agent compile policy, structured rules, fallback | ids must be declared in `references` |
| `evaluation` | intermediate/final evaluators, thresholds, suite pointer | `system-one` evaluator needs Jev `evaluate` |
| `replanning` | triggers, max replans, retry, exhaustion | `budget-pressure` needs `softLimitRatio` |
| `jev` | gateway **contract** token + version, per-operation mode, unavailability behaviour, data handling | no endpoints |
| `models` | abstract tiers per role, gateway-routed | concrete model IDs rejected |
| `context`, `checkpointing` | working tokens, compaction, handoff; granularity, triggers, resume, rollback | rollback = new branch |
| `concurrency`, `swarm`, `budgets` | parallelism caps; swarm limits; per-run budgets | swarm ≤ Tiny Agent caps ≤ budget; callers only lower |
| `capabilities` | default-deny allow-list with scopes | `external-send` needs HITL; must match `security.capabilities` |
| `escalation`, `hitl` | rules → actions; approval points, timeout | timeout defaults to deny |
| `state`, `evidence` | durable state contract; runtime emission contract | gateway tokens must be in `compatibility` |
| `governance` | `selfModification: forbidden` | constant |
| `compatibility` | schema, runtime contract range, gateway ranges, breaking notes | |

Security classification is declared and validated against `spec` (`classification` ≥ Jev data ceiling and every capability
ceiling); a compiler or runtime must not elevate or silently alter it.
