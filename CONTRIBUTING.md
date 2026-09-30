# Contributing / promotion workflow

Follows the Zeptly Registry Protocol v0.2 (see [docs/protocol-conformance.md](docs/protocol-conformance.md)). Git branches and
pull requests are governance transport; **candidates are registry objects** (directories with `maturity: candidate`).

## Create a candidate

1. `mkdir -p qbs/<id>/<version>` (examples go under `synthetic/qbs/synthetic.<name>/` and must stay synthetic).
2. Write `blueprint.yaml` in the envelope (`maturity: candidate`, `lifecycle: active`). Declare every referenced
   Execution Agent / Tiny Agent / Skill in `references`.
3. `npm run ci` until clean. Open a PR.

## Change an existing QB

Never edit a canonical version. Create a new candidate directory, set `metadata.origin` (`evolved` + `evolution.sourceRefs`
= the source version), fill `provenance.sourceRefs`, bump per [versioning rules](docs/lifecycle-versioning.md); a candidate
must exceed every canonical version of the id.

## Promote candidate → canonical

1. Add `evals/suite.yaml` (thresholds under `gates.canonical`).
2. Finish content. **Any edit after this invalidates assessments.**
3. Add a passing `evaluation` attestation (`gate: canonical`) bound to the current digest, plus human `security-review`
   and `release-approval` entries in `security.approvals` bound to the same digest.
4. Set `metadata.maturity: canonical`; run `npm run seal -- <id>@<version> --pr <ref>`.
5. `npm run ci`. The PR needs security review if `W_PERMISSION_WIDENING` is reported.

## Lifecycle changes

Append an entry to `lifecycle.yaml` (`active → deprecated → revoked`, never rewrite) and mirror the effective state in
`metadata.lifecycle`.

## Wisdom-of-Compute proposals

See [docs/evidence-model.md](docs/evidence-model.md): `evolved` origin, a `wisdom-of-compute` transformation with
hypothesis/evidence/eval runs, a named human reviewer. Automation may open the PR; it may not merge it.

## Never commit

Raw tapes, trajectories, sessions, sensitive payloads, credentials, endpoints, concrete model IDs, repository paths.
