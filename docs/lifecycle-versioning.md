# Lifecycle, versioning and compatibility

> **Lifecycle terminology and the seal/digest protocol are NOT YET CANONICAL** (see [provisional.md](provisional.md)). Traffic-channel routing is unresolved and is not part of the registry.

## Status model

```
draft ──▶ candidate ──▶ canary ──▶ stable ──▶ deprecated ──▶ retired
  ▲           │           │ └─────────────────────────────────▶ retired (abort)
  └───────────┘           └── sealed from here on ──────────────────────────
```

| Status | Meaning | Mutable? | Requires |
|---|---|---|---|
| `draft` | being authored | yes | valid blueprint |
| `candidate` | ready for evaluation; open PR | yes | `evals/suite.yaml` |
| `canary` | limited production exposure | **sealed** | `release.yaml`, passing `canary` eval-run bound to digest, gates met |
| `stable` | default for consumers | sealed | additionally a passing `stable` eval-run meeting stable gates |
| `deprecated` | superseded; still runnable | sealed | `lifecycle.deprecation` (reason, `replacedBy`) |
| `retired` | must not be run | sealed | deprecation block |

Only the `lifecycle` block of a sealed version may change, and only along the arrows above (`check:immutability`).
Sealed versions cannot be deleted; retire them. Deleting a draft/candidate is a normal PR.

## Sealing

`npm run seal -- qb:<slug>@<ver>` writes `release.yaml` with `blueprintDigest` and `suiteDigest`. The digest covers the
whole blueprint except `lifecycle`. CI recomputes it on every run (`E_DIGEST`) and, on PRs, diffs against the base
branch (`E_IMMUTABLE`) so a contributor cannot edit content *and* the seal together. Evidence refs of a sealed
version are append-only.

## Semantic versioning of QBs

| Bump | When |
|---|---|
| **MAJOR** | Breaking input/output contract; runtime or gateway contract major change; behaviour that callers must adapt to. List it under `compatibility.breaking` (enforced: breaking notes ⇒ major bump). |
| **MINOR** | Additive/backward-compatible contract change; new optional behaviour; **any permission or budget widening** (new capability/scope, higher ceiling, removed HITL step, swarm enabled, larger Jev data classification). |
| **PATCH** | Tuning that does not change contracts or widen permissions: thresholds, retry counts, instructions wording, docs. |

Enforced by the validator against `provenance.parent`: version must increase; contract change on a patch bump is an
error; widening on a patch bump is an error. Every widening also emits `W_PERMISSION_WIDENING`, surfaced in CI for
security review. Pre-release tags (`1.2.0-rc.1`) are permitted for candidates.

## Compatibility

`compatibility` declares: registry schema version, `qb-runtime` contract range, and gateway contract ranges. A runtime
refuses a blueprint whose ranges it cannot satisfy. `dependencies` declare ranges; how peers are resolved is provisional.
When a local peer index is supplied to the validator, a `stable` QB requires non-optional dependencies to resolve to a `stable` peer.

## Traffic channels (unresolved, not implemented)

The registry records versions and statuses only. It does **not** define channels, "latest-stable" pointers, traffic
splits or routing between versions; that is unresolved and out of scope for this registry.
