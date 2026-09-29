# Evaluation structure

Each version from `candidate` onward ships `evals/suite.yaml` (schema: `qb-eval-suite.schema.json`).

* **datasets** – large fixtures live outside Git (`dataset:<id>` + range, `dev/test/holdout` split).
* **scenarios** – input (validated against `contracts.input.schema`), optional simulated `environment`
  (fixtures, fault injection such as tool outages), expectations, graders. Include failure-path scenarios
  (contradictory sources, capability outage, budget pressure, Jev unavailable), not only happy paths.
* **graders** – `deterministic` (tape/output assertions), `rubric`, `system-one-judge`, `human`.
  Prefer deterministic checks; judge models must not be the model family being judged where avoidable.
* **metrics** – success rate, quality, cost (p95), latency (p95), replans, escalations, etc.
* **baseline** – parent version + tolerance; candidates should not regress against it.
* **gates** – thresholds per target status (`candidate`, `canary`, `stable`).

## How gates are enforced

A version at `canary` needs an `eval-run` ref with `result: pass`, `gate: canary`, `blueprintDigest` equal to the
version's digest, and `metrics` satisfying every comparison in `gates.canary`. `stable` additionally needs the `stable`
gate. Editing the suite after sealing changes `suiteDigest` and fails CI. Metric values are *claims about* evidence
held in the store; the store is authoritative, and a human reviewer spot-checks the URI (see decisions on signed results).

## Running evaluations

Execution belongs to the runtime/eval harness, not this repo. The harness reads the suite by `id@version`, writes
raw results to the evidence store, and returns a summary that a human/automation commits into `evidence/refs.yaml`.
