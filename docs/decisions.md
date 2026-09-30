# Decisions and open questions

> Baseline: Zeptly Registry Protocol v0.1 is approved. Items the protocol settles are recorded as accepted; items it defers
> are deferred, not decided here. QB-registry choices where the protocol is silent are listed in [provisional.md](provisional.md).

## Accepted

| # | Decision | Basis |
|---|---|---|
| D1 | Common envelope: `apiVersion`, `kind`, `metadata`, `spec`, `references`, `provenance`, `security`, `attestations` | protocol |
| D2 | `maturity`, `origin`, `lifecycle` independent; lifecycle is an append-only overlay | protocol |
| D3 | Structured references `{registry, id, version, digest?}`; resolution = range → exact version + digest → lock → evidence | protocol |
| D4 | Canonical versions immutable, digest-addressed; attestations must bind the exact digest | protocol |
| D5 | Raw tapes/trajectories never in Git; synthetic examples isolated | protocol |
| D6 | QB `spec` semantics (decomposition, delegation, replanning, budgets, concurrency, escalation, HITL, Jev, evaluation) preserved | protocol |
| D7 | Models are tiers, Jev is a gateway contract token, definitions are data (no code/endpoints/secrets) | QB design |
| D8 | `selfModification` is a constant `forbidden`; ≥1 human author; Wisdom-of-Compute requirements schema-enforced | QB design |

## The 12 unresolved decisions (all still open)

| # | Question | Status |
|---|---|---|
| 1 | Ownership of the evidence envelope/tape schema (QB registry vs shared platform package) | deferred by protocol (Evidence Protocol) |
| 2 | Peer-index publication and retrieval mechanism | deferred by protocol |
| 3 | Signed/attested evaluation results | deferred by protocol (signing) |
| 4 | Ownership of `capability:` and `gateway:` namespaces (and model namespaces) | deferred by protocol |
| 5 | Large prompts/fixtures as files under the version directory (digest over the tree) | open |
| 6 | Traffic-channel semantics | deferred by protocol; not implemented |
| 7 | Nested QBs (cycle detection, budget inheritance) | deferred by protocol; disabled |
| 8 | Multi-tenancy / workspace-scoped or private QBs | deferred by protocol (workspace overrides) |
| 9 | Evidence retention and erasure propagation to pointers | open |
| 10 | Enforcement of `governance.changeControl.minApprovals` (currently declarative; digest-bound approvals are validated) | open |
| 11 | Depth of automated semver/contract-compatibility enforcement | open |
| 12 | Wisdom-of-Compute proposer identity and permitted PR scope | open |
