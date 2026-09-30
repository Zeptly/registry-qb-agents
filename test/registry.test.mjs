import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import YAML from "yaml";
import { validateAll, checkImmutability, schemaErrors, buildIndex, artifactDigest, suiteDigest, directorySeal, canonicalize, sha256, compareCodePoints, buildRuntimeLock, resolveRef, parseYaml, MAX_FILE_BYTES, PKG_ROOT } from "../scripts/lib/core.mjs";

const ystr = (v) => YAML.stringify(v, { aliasDuplicateObjects: false });
const codes = (r) => r.errors.map((e) => e.code);
const SYN = "synthetic/qbs/synthetic.";
const CANON = `${SYN}research-synthesis/1.0.0`;
const CAND = `${SYN}research-synthesis/1.1.0`;
const DRAFT = `${SYN}incident-triage/0.1.0`;

/** Copy the registry (synthetic examples + production README) into a temp root so tests can mutate it. */
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qbreg-"));
  fs.cpSync(path.join(PKG_ROOT, "synthetic"), path.join(root, "synthetic"), { recursive: true });
  fs.mkdirSync(path.join(root, "qbs"));
  return root;
}
function mutate(root, rel, fn) {
  const f = path.join(root, rel);
  const doc = YAML.parse(fs.readFileSync(f, "utf8"));
  fn(doc);
  fs.writeFileSync(f, ystr(doc));
}
const bpOf = (dir) => `${dir}/blueprint.yaml`;

test("shipped registry is valid with no errors or warnings", () => {
  const r = validateAll();
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.versions.length, 3);
});

test("indexes are deterministic, schema-valid, and keep synthetic entries out of production", () => {
  const r = validateAll();
  const prod = buildIndex(r.versions, "production");
  const syn = buildIndex(r.versions, "synthetic");
  assert.deepEqual(schemaErrors("index", prod), []);
  assert.deepEqual(schemaErrors("index", syn), []);
  assert.equal(prod.entries.length, 0);
  assert.equal(syn.entries.length, 3);
  assert.ok(syn.entries.every((e) => e.synthetic === true && e.id.startsWith("synthetic.")));
  assert.equal(JSON.stringify(prod), JSON.stringify(buildIndex(validateAll().versions, "production")));
  assert.equal(JSON.stringify(syn), JSON.stringify(buildIndex(validateAll().versions, "synthetic")));
  assert.ok(!JSON.stringify(syn).match(/commit|generatedAt/));
  for (const e of syn.entries) for (const k of ["registry", "id", "version", "digest", "maturity", "lifecycle", "origin", "location"]) assert.ok(e[k] !== undefined, k);
  // schema rejects a synthetic entry in a production index
  assert.ok(schemaErrors("index", { ...prod, entries: [syn.entries[0]] }).length > 0);
});

test("index and release records agree on identity and digest", () => {
  const r = validateAll();
  const rel = r.versions.find((v) => v.release);
  const e = buildIndex(r.versions, "synthetic").entries.find((x) => x.id === rel.blueprint.metadata.id && x.version === rel.blueprint.metadata.version);
  assert.equal(e.digest, rel.release.digest);
  assert.equal(rel.release.metadata.id, e.id);
});

const cases = [
  ["self-modification allowed", DRAFT, (d) => { d.spec.governance.selfModification = "allowed"; }, "E_SCHEMA"],
  ["nested QB enabled", DRAFT, (d) => { d.spec.orchestration.nestedQb = "allowed"; }, "E_SCHEMA"],
  ["endpoint literal", DRAFT, (d) => { d.spec.identity.instructions += "\nCall https://jev.up.railway.app/v1 directly."; }, "E_ENDPOINT"],
  ["secret literal", DRAFT, (d) => { d.spec.identity.instructions += "\napi_key: abcdef0123456789abcdef"; }, "E_SECRET"],
  ["pinned model id", DRAFT, (d) => { d.spec.decomposition.guidance = "use claude-opus-4 for this"; }, "E_MODEL_PIN"],
  ["repo coupling", DRAFT, (d) => { d.spec.decomposition.guidance = "see ../registry-skills/foo"; }, "E_REPO_COUPLING"],
  ["undeclared reference", DRAFT, (d) => { d.spec.delegation.executionAgents.allow.push("synthetic.ghost"); }, "E_REF_UNDECLARED"],
  ["qb-agents reference (nested QB)", DRAFT, (d) => { d.references.push({ registry: "qb-agents", id: "synthetic.other", version: "^1.0.0" }); }, "E_NESTED_QB"],
  ["bad semver range", DRAFT, (d) => { d.references[0].version = "not-a-range"; }, "E_RANGE"],
  ["unknown registry value", DRAFT, (d) => { d.references[0].registry = "capabilities"; }, "E_SCHEMA"],
  ["unstructured (string) reference", DRAFT, (d) => { d.references[0] = "execution-agent:x@1"; }, "E_SCHEMA"],
  ["gateway missing from compatibility", DRAFT, (d) => { d.spec.compatibility.gatewayContracts = d.spec.compatibility.gatewayContracts.slice(1); }, "E_GATEWAY_COMPAT"],
  ["external-send without HITL", DRAFT, (d) => { d.spec.capabilities.allow[2].requiresHitl = false; d.spec.hitl.approvals = d.spec.hitl.approvals.filter((a) => a.when !== "external-send"); }, "E_HITL"],
  ["no human author", DRAFT, (d) => { d.provenance.authors = [{ type: "automation", id: "bot" }]; }, "E_PROVENANCE"],
  ["swarm rule without swarm", DRAFT, (d) => { d.spec.delegation.rules.push({ id: "s", match: {}, action: "swarm" }); }, "E_SWARM"],
  ["version/dir mismatch", DRAFT, (d) => { d.metadata.version = "0.2.0"; }, "E_PATH"],
  ["system-one critique without jev op", DRAFT, (d) => { d.spec.jev.operations = d.spec.jev.operations.filter((o) => o.op !== "critique"); }, "E_JEV"],
  ["security.capabilities out of sync with spec", DRAFT, (d) => { d.security.capabilities = d.security.capabilities.slice(1); }, "E_SECURITY"],
  ["declared classification lowered below capability ceiling", DRAFT, (d) => { d.security.classification = "internal"; }, "E_SECURITY"],
  ["synthetic flag removed", DRAFT, (d) => { d.metadata.synthetic = false; }, "E_SYNTHETIC"],
  ["synthetic id namespace violated", DRAFT, (d) => { d.metadata.id = "incident-triage"; }, "E_SYNTHETIC"],
  ["missing [EXAMPLE] marker", DRAFT, (d) => { d.metadata.name = "Incident Triage QB"; }, "E_SYNTHETIC"],
  ["non-synthetic evidence in synthetic artifact", CAND, (d) => { d.provenance.transformations[0].evidenceRefs = ["evidence://cortex/real-looking/x"]; }, "E_SYNTHETIC"],
  ["synthetic attestation flag removed", CAND, (d) => { d.attestations[0].synthetic = false; }, "E_SYNTHETIC"],
  ["wisdom-of-compute without evidence", CAND, (d) => { d.provenance.transformations[0].evidenceRefs = []; }, "E_SCHEMA"],
  ["wisdom-of-compute without human review flag", CAND, (d) => { delete d.provenance.transformations[0].humanReviewRequired; }, "E_SCHEMA"],
  ["wisdom-of-compute on non-evolved origin", CAND, (d) => { d.metadata.origin = { type: "native" }; }, "E_ORIGIN"],
  ["evolved without source", CAND, (d) => { d.metadata.origin.evolution.sourceRefs = []; }, "E_SCHEMA"],
  ["parent missing", CAND, (d) => { d.metadata.origin.evolution.sourceRefs[0].version = "0.9.0"; d.provenance.sourceRefs[0].version = "0.9.0"; }, "E_PARENT"],
  ["parent digest mismatch", CAND, (d) => { d.metadata.origin.evolution.sourceRefs[0].digest = "sha256:" + "1".repeat(64); }, "E_DIGEST"],
  ["candidate does not exceed canonical", CAND, (d) => { d.metadata.version = "1.0.0"; }, "E_CANDIDATE_VERSION"],
  ["stale attestation (content edited after assessment)", CAND, (d) => { d.spec.evaluation.intermediate.acceptThreshold = 0.8; }, "E_ATTESTATION_STALE"],
  ["stale approval", CANON, (d) => { d.security.approvals[0].subjectDigest = "sha256:" + "2".repeat(64); }, "E_APPROVAL_STALE"],
  ["sealed content edited", CANON, (d) => { d.spec.budgets.perRun.maxCostUsd = 500; }, "E_DIGEST"],
  ["canonical without evaluation attestation", CANON, (d) => { d.attestations = []; }, "E_PROMOTION"],
  ["canonical without security review", CANON, (d) => { d.security.approvals = d.security.approvals.filter((a) => a.type !== "security-review"); }, "E_PROMOTION"],
  ["canonical without release approval", CANON, (d) => { d.security.approvals = d.security.approvals.filter((a) => a.type !== "release-approval"); }, "E_PROMOTION"],
  ["attestation claims a gate it does not meet", CANON, (d) => { d.attestations[0].metrics["task-success-rate"] = 0.5; }, "E_GATE"],
  ["lifecycle out of sync with overlay", CANON, (d) => { d.metadata.lifecycle = "deprecated"; }, "E_LIFECYCLE"],
];
for (const [name, dir, fn, code] of cases) {
  test(`rejects: ${name}`, () => {
    const root = sandbox();
    const rel = bpOf(dir);
    mutate(root, rel, fn);
    if (name === "version/dir mismatch" || name === "synthetic id namespace violated") { /* dir stays; validator must flag */ }
    const r = validateAll({ root });
    assert.ok(codes(r).includes(code), `expected ${code}, got ${JSON.stringify(r.errors.map((e) => [e.code, e.message]))}`);
  });
}

test("candidate with an attestation for its current digest passes; contract change on patch bump is rejected", () => {
  const root = sandbox();
  mutate(root, bpOf(CAND), (d) => { d.metadata.version = "1.0.1"; d.spec.contracts.input.schema.properties.extra = { type: "string" }; });
  fs.renameSync(path.join(root, CAND), path.join(root, `${SYN}research-synthesis/1.0.1`));
  const r = validateAll({ root });
  assert.ok(codes(r).includes("E_SEMVER"));
});
test("permission widening: patch bump rejected, minor bump warns", () => {
  let root = sandbox();
  mutate(root, bpOf(CAND), (d) => { d.metadata.version = "1.0.1"; d.spec.budgets.perRun.maxCostUsd = 30; });
  fs.renameSync(path.join(root, CAND), path.join(root, `${SYN}research-synthesis/1.0.1`));
  assert.ok(codes(validateAll({ root })).includes("E_SEMVER"));
  root = sandbox();
  mutate(root, bpOf(CAND), (d) => { d.spec.budgets.perRun.maxCostUsd = 20; });
  const r = validateAll({ root });
  assert.ok(r.warnings.some((w) => w.code === "W_PERMISSION_WIDENING"));
  assert.ok(!codes(r).includes("E_SEMVER"));
});

test("canonical requires a release record; candidates must not have one", () => {
  let root = sandbox();
  fs.rmSync(path.join(root, CANON, "release.yaml"));
  assert.ok(codes(validateAll({ root })).includes("E_RELEASE"));
  root = sandbox();
  fs.copyFileSync(path.join(root, CANON, "release.yaml"), path.join(root, CAND, "release.yaml"));
  assert.ok(codes(validateAll({ root })).includes("E_RELEASE"));
});

test("maturity, lifecycle and origin vary independently", () => {
  const root = sandbox();
  // deprecate the canonical (native) version through the append-only overlay
  fs.writeFileSync(path.join(root, CANON, "lifecycle.yaml"), ystr({
    apiVersion: "registry.zeptly.dev/v1alpha1", kind: "LifecycleOverlay", metadata: { registry: "qb-agents", id: "synthetic.research-synthesis", version: "1.0.0" },
    entries: [
      { state: "active", at: "2026-09-29T09:00:00Z", actor: { type: "human", id: "example-human-reviewer" }, reason: "released" },
      { state: "deprecated", at: "2026-10-30T09:00:00Z", actor: { type: "human", id: "example-human-reviewer" }, reason: "superseded by 1.1.0", replacedBy: { registry: "qb-agents", id: "synthetic.research-synthesis", version: "1.1.0" } },
    ],
  }));
  mutate(root, bpOf(CANON), (d) => { d.metadata.lifecycle = "deprecated"; });
  const r = validateAll({ root });
  assert.deepEqual(r.errors, []); // digest unaffected by lifecycle; maturity stays canonical; origin stays native
  const e = buildIndex(r.versions, "synthetic").entries.find((x) => x.version === "1.0.0");
  assert.deepEqual([e.maturity, e.lifecycle, e.origin], ["canonical", "deprecated", "native"]);
  assert.deepEqual(e.replacedBy, { registry: "qb-agents", id: "synthetic.research-synthesis", version: "1.1.0" });
});
test("lifecycle overlay rejects illegal transitions and non-active start", () => {
  const root = sandbox();
  const entry = (state, at) => ({ state, at, actor: { type: "human", id: "example-human-reviewer" }, reason: "test reason" });
  fs.writeFileSync(path.join(root, CANON, "lifecycle.yaml"), ystr({ apiVersion: "registry.zeptly.dev/v1alpha1", kind: "LifecycleOverlay", metadata: { registry: "qb-agents", id: "synthetic.research-synthesis", version: "1.0.0" },
    entries: [entry("active", "2026-01-01T00:00:00Z"), entry("revoked", "2026-01-02T00:00:00Z"), entry("active", "2026-01-03T00:00:00Z")] }));
  assert.ok(codes(validateAll({ root })).includes("E_LIFECYCLE"));
});

test("synthetic artifacts cannot live in the production namespace or index", () => {
  const root = sandbox();
  fs.cpSync(path.join(root, DRAFT.replace("/0.1.0", "")), path.join(root, "qbs/synthetic.incident-triage"), { recursive: true });
  const r = validateAll({ root });
  assert.ok(codes(r).includes("E_SYNTHETIC"));
  assert.equal(buildIndex(r.versions, "production").entries.length, 0);
});

test("runtime tapes and unexpected files are rejected", () => {
  let root = sandbox();
  fs.writeFileSync(path.join(root, DRAFT, "session.jsonl"), '{"sessionId":"x"}\n');
  const r = validateAll({ root });
  assert.ok(codes(r).includes("E_UNEXPECTED_FILE") && codes(r).includes("E_RUNTIME_ARTIFACT"));
  root = sandbox();
  fs.mkdirSync(path.join(root, "qbs/tapes"), { recursive: true });
  assert.ok(codes(validateAll({ root })).includes("E_RUNTIME_ARTIFACT"));
});

test("peer index validation is structural and offline: unresolved / canonical-requires-canonical", () => {
  const root = sandbox();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "peer-"));
  const peer = path.join(tmp, "idx.json");
  fs.writeFileSync(peer, JSON.stringify({ entries: [{ registry: "execution-agents", id: "synthetic.web-researcher", version: "1.2.0", maturity: "candidate", lifecycle: "active", domain: "synthetic", digestAlgorithm: "zeptly-jcs-v1" }] }));
  const errs = validateAll({ root, peerIndexFiles: [peer] }).errors;
  assert.ok(errs.some((e) => e.code === "E_UNRESOLVED" && /canonical/.test(e.message)));
  assert.ok(errs.some((e) => e.code === "E_UNRESOLVED" && /document-analyst/.test(e.message)));
});

test("RuntimeLock: range -> exact version + digest; skips candidates, revoked and (ranges only) deprecated; failures are explicit codes, never omitted", () => {
  const d = (n) => "sha256:" + String(n).repeat(64);
  const E = (version, maturity, lifecycle, n, extra = {}) => ({ registry: "skills", id: "synthetic.source-evaluation", version, maturity, lifecycle, digest: d(n), digestAlgorithm: "zeptly-jcs-v1", domain: "synthetic", ...extra });
  const entries = [E("1.0.0", "canonical", "active", 1), E("1.2.0", "canonical", "deprecated", 2), E("1.3.0", "canonical", "revoked", 3), E("1.4.0", "candidate", "active", 4), E("2.0.0", "canonical", "active", 5)];
  const decl = { registry: "skills", id: "synthetic.source-evaluation", version: "^1.0.0", digest: null };
  const opts = { domain: "synthetic" };
  const good = (v, n) => ({ status: "resolved", resolved: { registry: "skills", id: "synthetic.source-evaluation", version: v, digest: d(n), digestAlgorithm: "zeptly-jcs-v1" } });
  const code = (r) => r.unresolved?.code;
  assert.deepEqual(resolveRef(decl, entries, opts), good("1.0.0", 1), "a range skips the deprecated 1.2.0, the revoked 1.3.0 and the candidate 1.4.0");
  assert.deepEqual(resolveRef({ ...decl, version: "1.2.0" }, entries, opts), good("1.2.0", 2), "deprecated resolves by exact pin");
  assert.equal(code(resolveRef({ ...decl, version: "1.3.0" }, entries, opts)), "revoked");
  assert.equal(code(resolveRef({ ...decl, version: "1.4.0" }, entries, opts)), "candidate-requires-opt-in");
  assert.deepEqual(resolveRef({ ...decl, version: "1.4.0" }, entries, { ...opts, allowCandidates: true }), good("1.4.0", 4));
  assert.equal(code(resolveRef({ ...decl, version: "^1.1.0 <1.3.0" }, entries, opts)), "deprecated-requires-exact-pin");
  assert.equal(code(resolveRef({ ...decl, version: "^3.0.0" }, entries, opts)), "no-satisfying-version");
  assert.equal(code(resolveRef({ ...decl, digest: d(9) }, entries, opts)), "digest-mismatch");
  assert.deepEqual(resolveRef({ ...decl, digest: d(1) }, entries, opts), good("1.0.0", 1));
  assert.equal(code(resolveRef({ ...decl, version: "nope" }, entries, opts)), "invalid-range");
  assert.equal(code(resolveRef(decl, [E("1.0.0", "canonical", "active", 1, { digestAlgorithm: "other-v9" })], opts)), "digest-algorithm-mismatch");
  assert.equal(code(resolveRef(decl, entries, { domain: "production" })), "domain-mismatch", "synthetic entries never resolve a production reference");
  const subject = { registry: "qb-agents", id: "synthetic.research-synthesis", version: "1.0.0", digest: d(7) };
  const lock = buildRuntimeLock(subject, [decl, { ...decl, id: "synthetic.missing" }, { registry: "tiny-agents", id: "synthetic.fact-checker", version: "^1.0.0" }], entries, opts);
  assert.deepEqual(schemaErrors("lock", lock), []);
  assert.equal(lock.kind, "RuntimeLock");
  assert.equal(lock.digestAlgorithm, "zeptly-jcs-v1");
  assert.equal(lock.domain, "synthetic");
  assert.equal(lock.complete, false);
  assert.equal(lock.entries.length, 3, "every declared reference appears");
  assert.deepEqual(lock.entries.map((l) => l.status), ["resolved", "unresolved", "unresolved"]);
  assert.deepEqual(lock.entries.map((l) => l.unresolved?.code), [undefined, "no-satisfying-version", "no-peer-index"]);
  assert.ok(lock.entries.every((l) => l.status === "resolved" || l.unresolved.message.length > 0));
  assert.equal(buildRuntimeLock(subject, [decl], entries, opts).complete, true);
  // schema: resolved needs `resolved`, unresolved needs `unresolved`
  assert.ok(schemaErrors("lock", { ...lock, entries: [{ requested: decl, status: "unresolved" }] }).length > 0);
  assert.ok(schemaErrors("lock", { ...lock, entries: [{ requested: decl, status: "resolved" }] }).length > 0);
  assert.ok(schemaErrors("lock", { ...lock, domain: "staging" }).length > 0);
  assert.ok(schemaErrors("lock", { ...lock, digestAlgorithm: "other" }).length > 0);
});

test("RuntimeLock with no peer index lists ALL foreign references as unresolved (no-peer-index)", () => {
  const r = validateAll();
  const v = r.versions.find((x) => x.blueprint.metadata.id === "synthetic.research-synthesis" && x.blueprint.metadata.version === "1.0.0");
  const lock = buildRuntimeLock({ registry: "qb-agents", id: v.blueprint.metadata.id, version: "1.0.0", digest: v.digest }, v.blueprint.references, [], { domain: "synthetic" });
  assert.deepEqual(schemaErrors("lock", lock), []);
  assert.equal(lock.entries.length, v.blueprint.references.length);
  assert.ok(lock.entries.every((l) => l.status === "unresolved" && l.unresolved.code === "no-peer-index"));
  assert.equal(lock.complete, false);
});

test("evidence envelope (provisional) accepts a well-formed event incl. resolution.locked", () => {
  const ev = {
    schemaVersion: "1", eventId: "qbe_01ARZ3NDEKTSV4RRFFQ69G5FAV", sessionId: "qbs_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    runId: "qbr_01ARZ3NDEKTSV4RRFFQ69G5FAV", branchId: "qbb_01ARZ3NDEKTSV4RRFFQ69G5FAV", seq: 0, ts: "2026-09-29T00:00:00Z",
    qb: { registry: "qb-agents", id: "synthetic.research-synthesis", version: "1.0.0", digest: "sha256:" + "0".repeat(64) },
    type: "resolution.locked", payload: {},
  };
  assert.deepEqual(schemaErrors("envelope", ev), []);
  assert.ok(schemaErrors("envelope", { ...ev, sessionId: "bad" }).length > 0);
});

test("digest scope: excludes version, maturity, lifecycle, approvals, attestations; includes identity, spec, references, provenance, security", () => {
  const bp = YAML.parse(fs.readFileSync(path.join(PKG_ROOT, bpOf(CANON)), "utf8"));
  const d = artifactDigest(bp);
  const c = JSON.parse(JSON.stringify(bp));
  c.metadata.version = "9.9.9"; c.metadata.maturity = "candidate"; c.metadata.lifecycle = "revoked"; c.security.approvals = []; c.attestations = [];
  assert.equal(artifactDigest(c), d);
  const changes = [
    (x) => { x.kind = "Other"; }, (x) => { x.metadata.id = "synthetic.other"; }, (x) => { x.metadata.registry = "skills"; },
    (x) => { x.metadata.origin = { type: "upstream-seed" }; }, (x) => { x.spec.budgets.perRun.maxCostUsd = 1; }, (x) => { x.references.pop(); },
    (x) => { x.security.classification = "public"; }, (x) => { x.security.capabilities.pop(); }, (x) => { x.provenance.authors.push({ type: "human", id: "z" }); },
  ];
  for (const f of changes) { const y = JSON.parse(JSON.stringify(bp)); f(y); assert.notEqual(artifactDigest(y), d); }
});

test("directory seal binds registry, id and version over the canonical payload files (blueprint + suite) only", () => {
  const dir = path.join(PKG_ROOT, CANON);
  const bp = parseYaml(fs.readFileSync(path.join(dir, "blueprint.yaml"), "utf8")), su = parseYaml(fs.readFileSync(path.join(dir, "evals/suite.yaml"), "utf8"));
  const { payload, seal } = directorySeal(bp, su);
  assert.deepEqual(payload.map((p) => p.path), ["blueprint.yaml", "evals/suite.yaml"]);
  const other = JSON.parse(JSON.stringify(bp)); other.metadata.version = "1.0.1";
  assert.equal(artifactDigest(other), artifactDigest(bp), "same content, same artifact digest");
  assert.notEqual(directorySeal(other, su).seal, seal, "but a different version seals differently");
  const su2 = JSON.parse(JSON.stringify(su)); su2.gates.canonical[0].value = 0.1;
  assert.notEqual(directorySeal(bp, su2).seal, seal);
  const att = JSON.parse(JSON.stringify(bp)); att.attestations.push({ ...att.attestations[0], ref: "evidence://synthetic-example/x" }); att.security.approvals = [];
  assert.equal(directorySeal(att, su).seal, seal, "attestations/approvals are not payload");
});

// ---- golden vectors (independent Python implementation of docs/canonicalization.md) ----
test("golden vectors: artifact digest, suite digest and directory seal of the canonical fixture", () => {
  const g = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "test/golden/digest-seal.json"), "utf8"));
  const dir = path.join(PKG_ROOT, g.fixture);
  const bp = parseYaml(fs.readFileSync(path.join(dir, "blueprint.yaml"), "utf8")), su = parseYaml(fs.readFileSync(path.join(dir, "evals/suite.yaml"), "utf8"));
  assert.equal(artifactDigest(bp), g.artifactDigest);
  assert.equal(suiteDigest(su), g.suiteDigest);
  const s = directorySeal(bp, su);
  assert.equal(s.seal, g.directorySeal);
  assert.deepEqual(s.payload, g.payload);
  const rel = parseYaml(fs.readFileSync(path.join(dir, "release.yaml"), "utf8"));
  assert.equal(rel.digest, g.artifactDigest); assert.equal(rel.directorySeal, g.directorySeal);
});
test("canonicalization (JCS): key order is independent of insertion order; line endings inside values are NOT rewritten; non-JSON data throws", () => {
  assert.equal(canonicalize({ b: 1, a: { d: 1, c: 2 } }), canonicalize({ a: { c: 2, d: 1 }, b: 1 }));
  assert.notEqual(canonicalize({ t: "a\r\nb\rc" }), canonicalize({ t: "a\nb\nc" }));
  assert.equal(canonicalize({ t: "a\r\nb" }), '{"t":"a\\r\\nb"}');
  assert.equal(canonicalize(-0), "0");
  for (const bad of [NaN, Infinity, undefined, () => 1, 10n, Symbol("x")]) assert.throws(() => canonicalize({ x: bad }), TypeError);
});
test("comparator: explicit code-point order (astral > U+FFFF), deterministic, locale-independent", () => {
  assert.equal(compareCodePoints("\uffff", "\u{10000}"), -1);
  assert.ok("\u{10000}" < "\uffff", "sanity: default UTF-16 ordering is the opposite");
  assert.equal(compareCodePoints("a", "a"), 0);
  assert.equal(compareCodePoints("B", "a"), -1);
  assert.equal(compareCodePoints("ab", "a"), 1);
  assert.deepEqual(["b", "B", "a", "\u00e9", "\u{1F600}", "\uffff"].sort(compareCodePoints), ["B", "a", "b", "\u00e9", "\uffff", "\u{1F600}"]);
});
test("index order uses the code-point comparator then semver", () => {
  const syn = buildIndex(validateAll().versions, "synthetic").entries.map((e) => `${e.id}@${e.version}`);
  assert.deepEqual(syn, ["synthetic.incident-triage@0.1.0", "synthetic.research-synthesis@1.0.0", "synthetic.research-synthesis@1.1.0"]);
  assert.equal(buildIndex(validateAll().versions, "synthetic").entries.find((e) => e.version === "1.0.0").directorySeal, JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "test/golden/digest-seal.json"), "utf8")).directorySeal);
});

// ---- immutability (real git) ----
function gitRepo() {
  const root = sandbox();
  const g = (...a) => execFileSync("git", a, { cwd: root, stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com"); g("config", "user.name", "t");
  g("add", "-A"); g("commit", "-q", "-m", "base");
  return { root, g };
}
test("immutability: allowed appends pass; canonical content, attestation and evidence rewrites fail", () => {
  const { root } = gitRepo();
  assert.deepEqual(checkImmutability({ root, baseRef: "HEAD" }), []);
  // legal: append an attestation and an approval on the canonical version
  mutate(root, bpOf(CANON), (d) => { d.attestations.push({ ...d.attestations[0], ref: "evidence://synthetic-example/eval-runs/extra" }); d.security.approvals.push({ ...d.security.approvals[0], at: "2026-10-01T00:00:00Z" }); });
  assert.deepEqual(checkImmutability({ root, baseRef: "HEAD" }), []);
  // illegal: rewrite an existing attestation
  mutate(root, bpOf(CANON), (d) => { d.attestations[0].result = "fail"; });
  assert.ok(checkImmutability({ root, baseRef: "HEAD" }).some((e) => e.code === "E_IMMUTABLE"));
});
test("immutability: content change, demotion, deletion; candidates stay mutable", () => {
  let { root } = gitRepo();
  mutate(root, bpOf(CANON), (d) => { d.spec.identity.role = "Changed role text that should not be allowed after release."; });
  assert.ok(checkImmutability({ root, baseRef: "HEAD" }).some((e) => e.code === "E_IMMUTABLE"));

  ({ root } = gitRepo());
  mutate(root, bpOf(CANON), (d) => { d.metadata.maturity = "candidate"; });
  assert.ok(checkImmutability({ root, baseRef: "HEAD" }).some((e) => e.code === "E_TRANSITION"));

  ({ root } = gitRepo());
  fs.rmSync(path.join(root, CANON), { recursive: true });
  assert.ok(checkImmutability({ root, baseRef: "HEAD" }).some((e) => e.code === "E_IMMUTABLE"));

  ({ root } = gitRepo());
  mutate(root, bpOf(DRAFT), (d) => { d.spec.identity.role = "A candidate may change freely before it is promoted at all."; });
  assert.deepEqual(checkImmutability({ root, baseRef: "HEAD" }), []);
});
test("immutability: lifecycle overlay is append-only", () => {
  const { root, g } = gitRepo();
  const ov = path.join(root, CANON, "lifecycle.yaml");
  const entry = (state, at) => ({ state, at, actor: { type: "human", id: "example-human-reviewer" }, reason: "test reason" });
  const doc = (entries) => ystr({ apiVersion: "registry.zeptly.dev/v1alpha1", kind: "LifecycleOverlay", metadata: { registry: "qb-agents", id: "synthetic.research-synthesis", version: "1.0.0" }, entries });
  fs.writeFileSync(ov, doc([entry("active", "2026-01-01T00:00:00Z")]));
  g("add", "-A"); g("commit", "-q", "-m", "overlay");
  fs.writeFileSync(ov, doc([entry("active", "2026-01-01T00:00:00Z"), entry("deprecated", "2026-02-01T00:00:00Z")]));
  assert.deepEqual(checkImmutability({ root, baseRef: "HEAD" }), []);
  fs.writeFileSync(ov, doc([entry("deprecated", "2026-01-01T00:00:00Z")]));
  assert.ok(checkImmutability({ root, baseRef: "HEAD" }).some((e) => e.code === "E_IMMUTABLE"));
});

test("no invented personal identities remain", () => {
  const r = spawnSync("grep", ["-rIl", "chris-marchant", ".", "--exclude-dir=node_modules", "--exclude-dir=.git", "--exclude-dir=test"], { cwd: PKG_ROOT, encoding: "utf8" });
  assert.equal(r.stdout.trim(), "");
});

test("origin.type follows the v0.2 common taxonomy: native | upstream-seed | discovered | refined | evolved", () => {
  for (const old of ["authored", "imported"]) {
    const root = sandbox();
    mutate(root, bpOf(DRAFT), (d) => { d.metadata.origin = { type: old }; });
    assert.ok(codes(validateAll({ root })).includes("E_SCHEMA"), `${old} must be rejected`);
  }
  const root = sandbox();
  mutate(root, bpOf(DRAFT), (d) => { d.metadata.origin = { type: "upstream-seed" }; });
  assert.deepEqual(validateAll({ root }).errors, []);
  // finer distinctions live in evolution.kind, not origin.type
  const r2 = sandbox();
  mutate(r2, bpOf(CAND), (d) => { d.metadata.origin.evolution.kind = "discovered"; });
  assert.ok(!codes(validateAll({ root: r2 })).includes("E_SCHEMA"));
  const r3 = sandbox();
  mutate(r3, bpOf(CAND), (d) => { d.metadata.origin.evolution.kind = "invented"; });
  assert.ok(codes(validateAll({ root: r3 })).includes("E_SCHEMA"), "unknown evolution kind");
  // v0.2 common origin values: native | upstream-seed | discovered | refined | evolved; evolution kinds: discovered | refined | generalised
  for (const type of ["native", "upstream-seed", "discovered", "refined"]) { const r = sandbox(); mutate(r, bpOf(DRAFT), (d) => { d.metadata.origin = { type }; }); assert.deepEqual(validateAll({ root: r }).errors, [], type); }
  const r4 = sandbox();
  mutate(r4, bpOf(CAND), (d) => { d.metadata.origin.evolution.kind = "generalised"; });
  assert.ok(!codes(validateAll({ root: r4 })).includes("E_SCHEMA"));
  const idx = buildIndex(validateAll().versions, "synthetic");
  assert.ok(idx.entries.every((e) => ["native", "evolved", "upstream-seed", "discovered", "refined"].includes(e.origin)));
  assert.deepEqual(idx.entries.map((e) => e.origin).sort(), ["evolved", "native", "native"]);
});

// ---- final normalization: evolution kind, ID grammar, seal, safe loading ----
test("evolution kind lives only at metadata.origin.evolution.kind", () => {
  const root = sandbox();
  mutate(root, bpOf(CAND), (d) => { d.provenance.evolution = { kind: "refined" }; });
  assert.ok(codes(validateAll({ root })).includes("E_SCHEMA"));
  const r2 = sandbox();
  mutate(r2, bpOf(CAND), (d) => { d.metadata.origin.evolution.kind = "rewritten"; });
  assert.ok(codes(validateAll({ root: r2 })).includes("E_SCHEMA"));
  const bpSchema = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "schemas/qb-blueprint.schema.json"), "utf8"));
  assert.ok(!("evolution" in bpSchema.properties.provenance.properties));
});

test("ID grammar: lowercase dotted/hyphenated slugs; no registry/kind reserved-prefix rule beyond the shared grammar (v0.2)", () => {
  const ok = ["research.web-fact-check", "source-evaluation", "synthetic.a1.b-2", "a", "qb.thing", "skills.thing", "tiny-agents.thing"];
  const bad = ["Upper", "qb:x", "skill:x", "a..b", ".a", "a.", "a_b", "1abc", "-a", "a-", "x".repeat(97)];
  const pattern = new RegExp(JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "schemas/common.schema.json"), "utf8")).$defs.artifactId.pattern);
  for (const id of ok) assert.ok(pattern.test(id), id);
  for (const id of bad.slice(0, -1)) assert.ok(!pattern.test(id), id);
  assert.ok(!pattern.test(bad.at(-1)) || bad.at(-1).length > 96);
  // the former E_ID_PREFIX rule is gone: a prefixed id is an ordinary, grammar-valid id
  const root = sandbox();
  mutate(root, bpOf(DRAFT), (d) => { d.references[0].id = "synthetic.qb.thing"; d.spec.delegation.executionAgents.allow[0] = "synthetic.qb.thing"; d.spec.delegation.rules.forEach((r) => { if (r.target === "synthetic.log-analyst") r.target = "synthetic.qb.thing"; }); });
  assert.ok(!codes(validateAll({ root })).includes("E_ID_PREFIX"));
});

test("release seal: payload edits and tampered seal are rejected; release record shape is enforced", () => {
  let root = sandbox();
  mutate(root, `${CANON}/evals/suite.yaml`, (d) => { d.gates.canonical[0].value = 0.1; });
  assert.ok(codes(validateAll({ root })).includes("E_SEAL"));
  root = sandbox();
  mutate(root, `${CANON}/release.yaml`, (d) => { d.directorySeal = "sha256:" + "3".repeat(64); });
  assert.ok(codes(validateAll({ root })).includes("E_SEAL"));
  root = sandbox();
  mutate(root, `${CANON}/release.yaml`, (d) => { d.payload = d.payload.slice(1); });
  assert.ok(codes(validateAll({ root })).includes("E_SEAL"));
  root = sandbox();
  mutate(root, `${CANON}/release.yaml`, (d) => { delete d.directorySeal; });
  assert.ok(codes(validateAll({ root })).includes("E_SCHEMA"));
});

test("filename allow-list, scope-root and id-level strays", () => {
  let root = sandbox();
  fs.writeFileSync(path.join(root, DRAFT, "notes.md"), "x\n");
  assert.ok(codes(validateAll({ root })).includes("E_UNEXPECTED_FILE"));
  root = sandbox();
  fs.writeFileSync(path.join(root, "qbs/stray.yaml"), "a: 1\n");
  assert.ok(codes(validateAll({ root })).includes("E_UNEXPECTED_FILE"));
  root = sandbox();
  fs.writeFileSync(path.join(root, "synthetic/qbs/synthetic.incident-triage/stray.yaml"), "a: 1\n");
  assert.ok(codes(validateAll({ root })).includes("E_UNEXPECTED_FILE"));
  root = sandbox();
  fs.writeFileSync(path.join(root, "qbs/README.md"), "ok\n"); // the one allowed scope-root file
  assert.deepEqual(validateAll({ root }).errors, []);
});

test("size limits: per-file and per-version", () => {
  let root = sandbox();
  fs.appendFileSync(path.join(root, bpOf(DRAFT)), "# " + "x".repeat(MAX_FILE_BYTES) + "\n");
  assert.ok(codes(validateAll({ root })).includes("E_SIZE"));
  root = sandbox();
  for (const f of ["evals/suite.yaml", "evidence/refs.yaml", "lifecycle.yaml", "release.yaml"]) { fs.mkdirSync(path.dirname(path.join(root, DRAFT, f)), { recursive: true }); fs.writeFileSync(path.join(root, DRAFT, f), "# " + "y".repeat(MAX_FILE_BYTES - 100) + "\n"); }
  const r = validateAll({ root });
  assert.ok(r.errors.some((e) => e.code === "E_SIZE" && /version directory/.test(e.message)));
});

test("symlinks are never followed and are rejected (files, directories, scope entries, repo-wide)", () => {
  let root = sandbox();
  fs.symlinkSync("/etc/hostname", path.join(root, DRAFT, "release.yaml"));
  let r = validateAll({ root });
  assert.ok(r.errors.some((e) => e.code === "E_SYMLINK" && /release\.yaml/.test(e.file)));
  root = sandbox();
  fs.rmSync(path.join(root, DRAFT, "blueprint.yaml"));
  fs.symlinkSync(path.join(PKG_ROOT, bpOf(CAND)), path.join(root, DRAFT, "blueprint.yaml"));
  r = validateAll({ root });
  assert.ok(codes(r).includes("E_SYMLINK") && codes(r).includes("E_MISSING") === false);
  root = sandbox();
  fs.symlinkSync(path.join(root, CAND), path.join(root, DRAFT, "evals"));
  assert.ok(validateAll({ root }).errors.some((e) => e.code === "E_SYMLINK" && /evals/.test(e.file)));
  root = sandbox();
  fs.symlinkSync(path.join(root, "synthetic/qbs/synthetic.incident-triage"), path.join(root, "qbs/synthetic.alias"));
  assert.ok(codes(validateAll({ root })).includes("E_SYMLINK"));
  root = sandbox();
  fs.symlinkSync(path.join(root, "synthetic"), path.join(root, "elsewhere"));
  assert.ok(codes(validateAll({ root })).includes("E_SYMLINK"));
});

test("encoding and line-ending policy: CR, NUL, BOM, invalid UTF-8", () => {
  const cases = [
    ["E_LINE_ENDING", (b) => Buffer.from(b.toString("utf8").replace(/\n/g, "\r\n"))],
    ["E_BINARY", (b) => Buffer.concat([b, Buffer.from([0])])],
    ["E_ENCODING", (b) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), b])],
    ["E_ENCODING", (b) => Buffer.concat([b, Buffer.from([0xff, 0xfe, 0x0a])])],
  ];
  for (const [code, fn] of cases) {
    const root = sandbox(), f = path.join(root, bpOf(DRAFT));
    fs.writeFileSync(f, fn(fs.readFileSync(f)));
    assert.ok(codes(validateAll({ root })).includes(code), code);
  }
});

test("tape / trace / transcript detection by name, directory and content", () => {
  const names = ["run.jsonl", "events.ndjson", "x.tape", "capture.har", "a.trace", "chat.transcript", "session-1.json", "my_trace.yaml", "transcript.md"];
  for (const n of names) {
    const root = sandbox();
    fs.writeFileSync(path.join(root, DRAFT, n), "{}\n");
    assert.ok(codes(validateAll({ root })).some((c) => c === "E_RUNTIME_ARTIFACT" || c === "E_UNEXPECTED_FILE"), n);
    assert.ok(codes(validateAll({ root })).includes("E_UNEXPECTED_FILE"), n);
  }
  for (const d of ["tapes", "trajectories", "sessions", "traces", "transcripts"]) {
    const root = sandbox();
    fs.mkdirSync(path.join(root, "qbs", d), { recursive: true });
    assert.ok(codes(validateAll({ root })).includes("E_RUNTIME_ARTIFACT"), d);
  }
  // extension check is repo-wide, even outside registry scopes
  const root = sandbox();
  fs.mkdirSync(path.join(root, "docs")); fs.writeFileSync(path.join(root, "docs/x.transcript"), "hi\n");
  assert.ok(codes(validateAll({ root })).includes("E_RUNTIME_ARTIFACT"));
  // content inside an allowed filename
  let r2 = sandbox();
  mutate(r2, `${CAND}/evidence/refs.yaml`, (d) => { d.refs[0].extra = 1; });
  const payloads = [
    { sessionId: "qbs_x", runId: "qbr_x" },
    { events: [{ seq: 0, ts: "t" }, { seq: 1, ts: "t" }] },
    { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] },
  ];
  for (const p of payloads) {
    r2 = sandbox();
    mutate(r2, bpOf(DRAFT), (d) => { d.spec.extensions = p; });
    assert.ok(codes(validateAll({ root: r2 })).includes("E_RUNTIME_ARTIFACT"), JSON.stringify(p).slice(0, 30));
  }
});
