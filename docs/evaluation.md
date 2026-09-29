# Evaluation structure

> Signed/attested evaluation results are **deferred**: attestations are digest-bound but unsigned, and their metrics are
> claims about evidence held elsewhere. All example runs are synthetic.

Each version that carries an evaluation attestation, and every canonical version, ships `evals/suite.yaml`
(`schemas/qb-eval-suite.schema.json`, `kind: QBEvalSuite`, `metadata{registry,id,version}` of the version it belongs to).

* **datasets**: large fixtures live outside Git (`dataset:<id>` tokens; namespace ownership unresolved).
* **scenarios**: input (validated against `spec.contracts.input.schema`), optional simulated `environment` (fixtures, fault
  injection), expectations, graders. Include failure paths (contradictory sources, outages, budget pressure, Jev unavailable).
* **graders**: `deterministic`, `rubric`, `system-one-judge`, `human`.
* **metrics**, **runs**, **baseline** (`exactRef` of the source version + tolerance).
* **gates**: `candidate` (optional) and `canonical` (required) thresholds.

## Enforcement

An `evaluation` attestation with `result: pass` must meet every comparison in `gates.<its gate>` (`E_GATE`). Promotion to
`canonical` requires a passing `canonical`-gate attestation whose `subjectDigest` equals the current digest. Editing the
suite after release changes `suiteDigest` and fails validation. Execution of evaluations belongs to the runtime/eval harness.
