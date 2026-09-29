## What this PR does
<!-- new QB / new candidate version / promotion to canonical / lifecycle overlay entry / schema or tooling change -->

## Artifact(s)
- `qb-agents/<id>@<version>` (maturity: candidate | canonical, lifecycle: active | deprecated | revoked)

## Change type
- [ ] New candidate or new version (never edit a canonical version)
- [ ] Promotion candidate → canonical (attestations, security review, release approval, release record)
- [ ] Lifecycle overlay entry (append-only)
- [ ] Schema / validator / CI change
- [ ] Docs only

## Origin
- [ ] Native
- [ ] Evolved (source refs listed)
- [ ] Evolved via Wisdom of Compute (hypothesis, evidence refs, eval runs, human reviewer named)

## Permission / budget widening
- [ ] None
- [ ] Yes: listed below and security review requested

## Checklist
- [ ] `npm run ci` passes locally
- [ ] Attestations and approvals bind the CURRENT digest (stale ones fail validation)
- [ ] `npm run seal` run when promoting to canonical
- [ ] No endpoints, credentials, concrete model IDs, repo paths, runtime tapes or sensitive payloads
- [ ] Synthetic examples stay under `synthetic/` and use the `synthetic.` id namespace
