## What this PR does
<!-- new QB / new version / status promotion / schema or tooling change -->

## QB(s) and version(s) touched
- `qb:<slug>@<version>`

## Change type
- [ ] New QB or new version (never edit a sealed version)
- [ ] Status promotion (`draft → candidate → canary → stable`, `stable → deprecated → retired`)
- [ ] Schema / validator / CI change
- [ ] Docs only

## Origin
- [ ] Human-authored
- [ ] Wisdom of Compute proposal (evidence refs + eval runs attached, human reviewer named in `provenance.authors`)

## Permission / budget widening
- [ ] None
- [ ] Yes: listed below and security review requested

## Promotion checklist (for status changes)
- [ ] `npm run validate` and `npm test` pass locally
- [ ] Eval suite updated; gate metrics met by a passing `eval-run` bound to the blueprint digest
- [ ] `npm run seal` run when moving to `canary` (release.yaml committed)
- [ ] `compatibility.breaking` filled in when the major version changes
- [ ] No endpoints, credentials, concrete model IDs or repo paths in the blueprint
