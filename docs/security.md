# Security model

## Assets and threats

| Threat | Control |
|---|---|
| A QB (or automation) rewrites/deploys its own definition | `governance.selfModification: forbidden` (schema const); runtime has **no** write credentials to this repo; every version needs a human author; branch protection + CODEOWNERS + required checks; WoC changes only arrive as PRs |
| Silent edit of a released definition | digest seal (`E_DIGEST`), base-diff immutability (`E_IMMUTABLE`), forbidden status transitions (`E_TRANSITION`), append-only evidence |
| Privilege creep across versions | default-deny capabilities; widening detection (`W_PERMISSION_WIDENING`) forces ≥ minor bump and security review via CODEOWNERS/PR checklist |
| Credential or endpoint leakage into Git | validator rejects URLs/hosts/credential-shaped strings (`E_ENDPOINT`, `E_SECRET`); CI secret-scan job; gateways referenced by contract only |
| Coupling to Jev's location / vendor lock-in | `jev.gateway` is a contract ID + version range; models are tiers |
| Prompt injection via retrieved content | instructions require treating retrieved data as untrusted; handoff minimisation; `external-send` always HITL; `hitl.onTimeout` defaults to deny |
| Runaway cost / swarms | hard per-run budgets, swarm size ≤ Tiny Agent caps ≤ budget, HITL above threshold, callers may only *lower* budgets |
| Sensitive data in evidence | redaction class per evidence ref, redaction policy in the blueprint, raw evidence kept out of Git |
| Supply-chain (workflows/deps) | minimal `permissions: contents: read`, `npm ci --ignore-scripts`, Dependabot for npm + Actions |
| Bad references / typosquatted IDs | kind allow-list, single dependency table, optional digest pins, peer resolution |

## Repository controls (configure in GitHub)

* Protect `main`: PRs only, required check `validate`, ≥1 approval (≥ blueprint's `governance.changeControl.minApprovals`
  should be enforced by reviewer rota), CODEOWNERS review, no force-push, signed commits recommended.
* The Trigger runtime and any WoC proposer get **read-only** access, or a bot that can open PRs on non-protected
  branches, never merge.
* Sealing (`release.yaml`) and promotion PRs are made by humans; automation may prepare them.

## What blueprints must never contain

Secrets, tokens, URLs to internal services, hostnames, concrete provider model IDs, repo paths, executable code,
customer data. Use gateway contracts, tiers, stable IDs, and evidence URIs.

## Reporting

See [SECURITY.md](../SECURITY.md).
