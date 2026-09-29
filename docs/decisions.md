# Decisions and open questions

## Accepted (baseline)

| # | Decision | Why |
|---|---|---|
| D1 | Directory-per-version, YAML + JSON Schema, Node validator | addressable snapshots; easy diffs; Node matches Trigger.dev stack |
| D2 | Seal at `canary`, digest = blueprint minus lifecycle | evidence must bind to exact content; status must still move |
| D3 | Single `dependencies` table; IDs + semver ranges | cross-registry protocol independent of repos/paths |
| D4 | Evidence by pointer (URI + digest) | Git stays small/safe; store holds raw data |
| D5 | Model *tiers*, Jev *contract* | gateway-swappable; definitions don't rot |
| D6 | Structured delegation rules, no expression language | no code in definitions; analysable by validator |
| D7 | Instructions inline in the blueprint | digest covers everything; revisit for large prompts |
| D8 | `selfModification` is a schema constant; ≥1 human author enforced | "no silent self-rewrite" is structural |

## Open questions

1. **Tape/envelope ownership.** The evidence envelope schema lives here as a *contract*; should it move to a shared
   `runtime-trigger`/Cortex schema package that both consume?
2. **Peer index publication.** How do peer registries publish `index.json` (Releases, a branch, an OCI/artifact store)
   and how does CI fetch them? Until decided, peer resolution is opt-in via `--peer-index`.
3. **Signed evaluation results.** Gate metrics in `refs.yaml` are asserted by the committer. Should the eval harness
   sign results (or CI verify against Cortex with a read-only token) so metrics are attested?
4. **Canonical `capability:` and `gateway:` namespaces.** No owning repo yet (`registries.yaml` has `repo: null`).
   Who owns gateway contract definitions (AI Gateway/Jev, Cortex state/evidence)?
5. **Large prompts and fixtures.** Support `instructionsFile`/prompt fragments under the version dir (digest over the tree)?
6. **Traffic channels.** Are `canary`/`stable` traffic splits purely runtime config, or should the registry publish
   channel pointers (`latest-stable`) in the index?
7. **Nested QBs.** `nestedQb: forbidden|allowed` is a stub; cycle detection and budget inheritance need design before use.
8. **Multi-tenancy.** Are some QBs workspace-scoped/private? If so, a separate private registry or a visibility field.
9. **Retention/legal.** Evidence retention limits, deletion/erasure propagation to `evidence/refs.yaml` pointers.
10. **Approval enforcement.** `governance.changeControl.minApprovals` is declarative; enforcement is a GitHub ruleset. Automate a check?
11. **Semver enforcement depth.** Contract compatibility is detected only as "changed"; a real JSON-Schema compatibility
    checker could decide minor vs major automatically.
12. **WoC proposer identity.** Which bot identity opens proposals, and where is its allowed-PR-scope defined?
