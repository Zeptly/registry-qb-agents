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

## Suite binding

Every `evaluation` attestation carries `suite: {id, version, digest}` (`registry` optional, must match when present; Protocol v0.2).
The identity must equal the suite's `metadata` (`E_SUITE_MISMATCH`) and `digest` must equal the current `suiteDigest`
(`E_SUITE_STALE`). Because attestations are outside the artifact digest, this is what makes a suite edit stale the evaluation
even when the blueprint digest is unchanged; resealing the directory alone does not revalidate an old evaluation — a new
attestation bound to the new suite digest is required. Passing-result and threshold checks (`E_GATE`) are unchanged.
The synthetic fixtures' `suite` blocks were added by the remediation pass and are labelled in place; no evaluation was run and
no real evidence exists. Artifact digests, suite digests, release records and directory seals are unchanged.

## Enforcement

An `evaluation` attestation with `result: pass` must meet every comparison in `gates.<its gate>` (`E_GATE`). Promotion to
`canonical` requires a passing `canonical`-gate attestation whose `subjectDigest` equals the current digest **and** whose `suite` binding matches the current suite. Editing the
suite after release changes the payload digest and the directory seal and fails validation (`E_SEAL`). Execution of evaluations belongs to the runtime/eval harness.
