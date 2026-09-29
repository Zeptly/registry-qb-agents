# Contributing / promotion workflow

## Create a new QB

1. `mkdir -p qbs/<slug>/0.1.0` and copy a nearby example's `blueprint.yaml` (status `draft`).
2. Fill every section; declare all referenced IDs in `dependencies`.
3. `npm run validate` until clean. Open a PR.

## Change an existing QB

*Never edit a sealed version* (`canary` and later). Copy the directory to a new version, set
`provenance.parent`, bump per [versioning rules](docs/lifecycle-versioning.md), describe the change in
`provenance.changelog`, list `compatibility.breaking` when applicable.

## Promote

| Step | Where | Evidence |
|---|---|---|
| draft → candidate | PR | add `evals/suite.yaml`; scenarios validate against the input contract |
| candidate → canary | PR | passing `eval-run` (`gate: canary`) in `evidence/refs.yaml`; run `npm run seal`; set status `canary` |
| canary → stable | PR | canary-period evidence + passing `stable` eval-run; set status `stable` |
| stable → deprecated → retired | PR | `lifecycle.deprecation` with `replacedBy` |

Order inside a promotion PR: add evidence → set status → `npm run seal` (canary only) → `npm run validate && npm test`.
The digest changes whenever blueprint content changes, so evidence must be recorded against the final content.

## Improvement proposals from evidence (Wisdom of Compute)

Same as any change, plus `provenance.origin: wisdom-of-compute`, `parent`, `derivedFrom` (hypothesis, evidence URIs,
eval-run URIs) and a named human reviewer. Automation may open the PR; it may not merge it.

## Review expectations

Owners review intent; security reviews any `W_PERMISSION_WIDENING`. Reviewers should spot-check evidence URIs and gate metrics.
