import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import YAML from "yaml";
import { validateAll, checkImmutability, schemaErrors, buildIndex, artifactDigest, buildResolutionLock, resolveRef, PKG_ROOT } from "../scripts/lib/core.mjs";

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
  fs.writeFileSync(f, YAML.stringify(doc));
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
  fs.writeFileSync(path.join(root, CANON, "lifecycle.yaml"), YAML.stringify({
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
  fs.writeFileSync(path.join(root, CANON, "lifecycle.yaml"), YAML.stringify({ apiVersion: "registry.zeptly.dev/v1alpha1", kind: "LifecycleOverlay", metadata: { registry: "qb-agents", id: "synthetic.research-synthesis", version: "1.0.0" },
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
  fs.writeFileSync(peer, JSON.stringify({ entries: [{ registry: "execution-agents", id: "synthetic.web-researcher", version: "1.2.0", maturity: "candidate", lifecycle: "active" }] }));
  const errs = validateAll({ root, peerIndexFiles: [peer] }).errors;
  assert.ok(errs.some((e) => e.code === "E_UNRESOLVED" && /canonical/.test(e.message)));
  assert.ok(errs.some((e) => e.code === "E_UNRESOLVED" && /document-analyst/.test(e.message)));
});

test("resolution lock: range -> exact version + digest; skips candidates and revoked; pin mismatch fails", () => {
  const d = (n) => "sha256:" + String(n).repeat(64);
  const entries = [
    { registry: "skills", id: "synthetic.source-evaluation", version: "1.0.0", maturity: "canonical", lifecycle: "active", digest: d(1) },
    { registry: "skills", id: "synthetic.source-evaluation", version: "1.2.0", maturity: "canonical", lifecycle: "deprecated", digest: d(2) },
    { registry: "skills", id: "synthetic.source-evaluation", version: "1.3.0", maturity: "canonical", lifecycle: "revoked", digest: d(3) },
    { registry: "skills", id: "synthetic.source-evaluation", version: "1.4.0", maturity: "candidate", lifecycle: "active", digest: d(4) },
    { registry: "skills", id: "synthetic.source-evaluation", version: "2.0.0", maturity: "canonical", lifecycle: "active", digest: d(5) },
  ];
  const decl = { registry: "skills", id: "synthetic.source-evaluation", version: "^1.0.0", digest: null };
  assert.deepEqual(resolveRef(decl, entries), { registry: "skills", id: "synthetic.source-evaluation", version: "1.2.0", digest: d(2) });
  assert.equal(resolveRef({ ...decl, version: "^3.0.0" }, entries), null);
  assert.throws(() => resolveRef({ ...decl, digest: d(9) }, entries), /pinned digest/);
  const lock = buildResolutionLock({ registry: "qb-agents", id: "synthetic.research-synthesis", version: "1.0.0", digest: d(7) }, [decl], entries);
  assert.deepEqual(schemaErrors("lock", lock), []);
  assert.throws(() => buildResolutionLock(lock.root, [{ ...decl, id: "synthetic.missing" }], entries), /cannot resolve/);
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

test("digest scope: ignores maturity, lifecycle, approvals and attestations only", () => {
  const bp = YAML.parse(fs.readFileSync(path.join(PKG_ROOT, bpOf(CANON)), "utf8"));
  const d = artifactDigest(bp);
  const c = JSON.parse(JSON.stringify(bp));
  c.metadata.maturity = "candidate"; c.metadata.lifecycle = "revoked"; c.security.approvals = []; c.attestations = [];
  assert.equal(artifactDigest(c), d);
  for (const f of [(x) => { x.metadata.version = "9.9.9"; }, (x) => { x.spec.budgets.perRun.maxCostUsd = 1; }, (x) => { x.references.pop(); }, (x) => { x.security.classification = "public"; }, (x) => { x.provenance.authors.push({ type: "human", id: "z" }); }]) {
    const y = JSON.parse(JSON.stringify(bp)); f(y);
    assert.notEqual(artifactDigest(y), d);
  }
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
  const doc = (entries) => YAML.stringify({ apiVersion: "registry.zeptly.dev/v1alpha1", kind: "LifecycleOverlay", metadata: { registry: "qb-agents", id: "synthetic.research-synthesis", version: "1.0.0" }, entries });
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

test("origin.type follows the common taxonomy: native | evolved | upstream-seed", () => {
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
  mutate(r3, bpOf(CAND), (d) => { d.metadata.origin = { type: "discovered" }; });
  assert.ok(codes(validateAll({ root: r3 })).includes("E_SCHEMA"));
  const idx = buildIndex(validateAll().versions, "synthetic");
  assert.ok(idx.entries.every((e) => ["native", "evolved", "upstream-seed"].includes(e.origin)));
  assert.deepEqual(idx.entries.map((e) => e.origin).sort(), ["evolved", "native", "native"]);
});
