import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import YAML from "yaml";
import { validateAll, checkImmutability, schemaErrors, buildIndex, blueprintDigest, PKG_ROOT } from "../scripts/lib/core.mjs";

const codes = (r) => r.errors.map((e) => e.code);

/** Copy the real registry into a temp root so tests can mutate it. */
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qbreg-"));
  fs.cpSync(path.join(PKG_ROOT, "qbs"), path.join(root, "qbs"), { recursive: true });
  return root;
}
function mutate(root, rel, fn) {
  const f = path.join(root, rel);
  const doc = YAML.parse(fs.readFileSync(f, "utf8"));
  fn(doc);
  fs.writeFileSync(f, YAML.stringify(doc));
}
const STABLE = "qbs/research-synthesis/1.0.0/blueprint.yaml";
const CAND = "qbs/research-synthesis/1.1.0/blueprint.yaml";
const DRAFT = "qbs/incident-triage/0.1.0/blueprint.yaml";

test("shipped registry is valid with no errors or warnings", () => {
  const r = validateAll();
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.versions.length, 3);
});

test("index is deterministic and schema-valid", () => {
  const r = validateAll();
  const idx = buildIndex(r.versions, "abc");
  assert.deepEqual(schemaErrors("index", idx), []);
  assert.equal(idx.entries.length, 3);
  assert.equal(JSON.stringify(idx), JSON.stringify(buildIndex(r.versions, "abc")));
});

const cases = [
  ["self-modification allowed", DRAFT, (d) => { d.governance.selfModification = "allowed"; }, "E_SCHEMA"],
  ["endpoint literal", DRAFT, (d) => { d.identity.instructions += "\nCall https://jev.up.railway.app/v1 directly."; }, "E_ENDPOINT"],
  ["secret literal", DRAFT, (d) => { d.identity.instructions += "\napi_key: abcdef0123456789abcdef"; }, "E_SECRET"],
  ["pinned model id", DRAFT, (d) => { d.decomposition.guidance = "use claude-opus-4 for this"; }, "E_MODEL_PIN"],
  ["repo coupling", DRAFT, (d) => { d.decomposition.guidance = "see ../registry-skills/foo"; }, "E_REPO_COUPLING"],
  ["undeclared dependency", DRAFT, (d) => { d.capabilities.allow.push({ id: "capability:ghost", scopes: ["read"] }); }, "E_DEP_UNDECLARED"],
  ["bad semver range", DRAFT, (d) => { d.dependencies[0].version = "not-a-range"; }, "E_RANGE"],
  ["gateway missing from compatibility", DRAFT, (d) => { d.dependencies.push({ id: "gateway:x", version: "^1.0.0" }); d.dependencies[d.dependencies.length - 1].id = "gateway:x"; d.jev.gateway.contract = "gateway:x"; }, "E_GATEWAY_COMPAT"],
  ["external-send without HITL", DRAFT, (d) => { d.capabilities.allow[2].requiresHitl = false; d.hitl.approvals = d.hitl.approvals.filter((a) => a.when !== "external-send"); }, "E_HITL"],
  ["no human author", DRAFT, (d) => { d.provenance.authors = [{ type: "automation", id: "bot" }]; }, "E_PROVENANCE"],
  ["swarm rule without swarm", DRAFT, (d) => { d.delegation.rules.push({ id: "s", match: {}, action: "swarm" }); }, "E_SWARM"],
  ["path/version mismatch", DRAFT, (d) => { d.version = "0.2.0"; }, "E_PATH"],
  ["system-one critique without jev op", DRAFT, (d) => { d.jev.operations = d.jev.operations.filter((o) => o.op !== "critique"); }, "E_JEV"],
  ["sealed blueprint edited", STABLE, (d) => { d.budgets.perRun.maxCostUsd = 500; }, "E_DIGEST"],
  ["wisdom-of-compute without evidence", CAND, (d) => { d.provenance.derivedFrom.evidenceRefs = []; }, "E_SCHEMA"],
  ["parent missing", CAND, (d) => { d.provenance.parent = "qb:research-synthesis@0.9.0"; }, "E_PARENT"],
  ["contract change on patch bump", CAND, (d) => { d.version = "1.0.1"; d.contracts.input.schema.properties.extra = { type: "string" }; }, "E_SEMVER"],
  ["permission widening on patch bump", CAND, (d) => { d.version = "1.0.1"; d.budgets.perRun.maxCostUsd = 30; }, "E_SEMVER"],
];
for (const [name, rel, fn, code] of cases) {
  test(`rejects: ${name}`, () => {
    const root = sandbox();
    mutate(root, rel, fn);
    // keep directory naming consistent for the patch-bump cases
    if (name.includes("patch bump")) fs.renameSync(path.join(root, "qbs/research-synthesis/1.1.0"), path.join(root, "qbs/research-synthesis/1.0.1"));
    const r = validateAll({ root });
    assert.ok(codes(r).includes(code), `expected ${code}, got ${JSON.stringify(r.errors.map((e) => [e.code, e.message]))}`);
  });
}

test("widening in a minor bump is a warning, not an error", () => {
  const root = sandbox();
  mutate(root, CAND, (d) => { d.budgets.perRun.maxCostUsd = 20; });
  const r = validateAll({ root });
  assert.ok(r.warnings.some((w) => w.code === "W_PERMISSION_WIDENING"));
  assert.ok(!codes(r).includes("E_SEMVER"));
});

test("promotion requires passing evidence bound to the exact digest and gate thresholds", () => {
  let root = sandbox();
  fs.rmSync(path.join(root, "qbs/research-synthesis/1.0.0/evidence/refs.yaml"));
  assert.ok(codes(validateAll({ root })).includes("E_PROMOTION"));

  root = sandbox();
  mutate(root, "qbs/research-synthesis/1.0.0/evidence/refs.yaml", (d) => { d.refs[1].metrics["task-success-rate"] = 0.5; });
  assert.ok(codes(validateAll({ root })).includes("E_GATE"));
});

test("release seal must not exist on unsealed versions", () => {
  const root = sandbox();
  fs.copyFileSync(path.join(root, "qbs/research-synthesis/1.0.0/release.yaml"), path.join(root, "qbs/research-synthesis/1.1.0/release.yaml"));
  assert.ok(codes(validateAll({ root })).includes("E_RELEASE"));
});

test("peer index resolution: unresolved and stable-requires-stable", () => {
  const root = sandbox();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "peer-"));
  const peer = path.join(tmp, "idx.json");
  fs.writeFileSync(peer, JSON.stringify({ entries: [{ id: "execution-agent:web-researcher", version: "1.2.0", status: "candidate" }] }));
  const errs = validateAll({ root, peerIndexFiles: [peer] }).errors;
  assert.ok(errs.some((e) => e.code === "E_UNRESOLVED" && /stable/.test(e.message)));
  assert.ok(errs.some((e) => e.code === "E_UNRESOLVED" && /document-analyst/.test(e.message)));
});

test("evidence envelope schema accepts a well-formed event and rejects a malformed one", () => {
  const ev = {
    schemaVersion: "1", eventId: "qbe_01ARZ3NDEKTSV4RRFFQ69G5FAV", sessionId: "qbs_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    runId: "qbr_01ARZ3NDEKTSV4RRFFQ69G5FAV", branchId: "qbb_01ARZ3NDEKTSV4RRFFQ69G5FAV", seq: 0, ts: "2026-09-29T00:00:00Z",
    qb: { id: "qb:research-synthesis", version: "1.0.0", blueprintDigest: "sha256:" + "0".repeat(64) },
    type: "plan.created", payload: {},
  };
  assert.deepEqual(schemaErrors("envelope", ev), []);
  assert.ok(schemaErrors("envelope", { ...ev, sessionId: "bad" }).length > 0);
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
test("immutability: sealed content edits, deletions and evidence rewrites are rejected; lifecycle and appended evidence pass", () => {
  const { root } = gitRepo();
  assert.deepEqual(checkImmutability({ root, baseRef: "HEAD" }), []);

  // legal: deprecate the stable version
  mutate(root, STABLE, (d) => { d.lifecycle.status = "deprecated"; d.lifecycle.deprecation = { reason: "superseded", replacedBy: "qb:research-synthesis@1.1.0" }; });
  assert.deepEqual(checkImmutability({ root, baseRef: "HEAD" }), []);

  // legal: append evidence
  mutate(root, "qbs/research-synthesis/1.0.0/evidence/refs.yaml", (d) => { d.refs.push({ ...d.refs[0], id: "extra" }); });
  assert.deepEqual(checkImmutability({ root, baseRef: "HEAD" }), []);

  // illegal: rewrite evidence
  mutate(root, "qbs/research-synthesis/1.0.0/evidence/refs.yaml", (d) => { d.refs[0].result = "fail"; });
  assert.ok(checkImmutability({ root, baseRef: "HEAD" }).some((e) => e.code === "E_IMMUTABLE"));
});
test("immutability: content change, illegal transition, and deletion of sealed versions", () => {
  let { root } = gitRepo();
  mutate(root, STABLE, (d) => { d.identity.role = "Changed role text that should not be allowed after sealing."; });
  assert.ok(checkImmutability({ root, baseRef: "HEAD" }).some((e) => e.code === "E_IMMUTABLE"));

  ({ root } = gitRepo());
  mutate(root, STABLE, (d) => { d.lifecycle.status = "draft"; });
  assert.ok(checkImmutability({ root, baseRef: "HEAD" }).some((e) => e.code === "E_TRANSITION"));

  ({ root } = gitRepo());
  fs.rmSync(path.join(root, "qbs/research-synthesis/1.0.0"), { recursive: true });
  assert.ok(checkImmutability({ root, baseRef: "HEAD" }).some((e) => e.code === "E_IMMUTABLE"));

  ({ root } = gitRepo());
  mutate(root, DRAFT, (d) => { d.identity.role = "A draft may change freely before it is sealed at all."; });
  assert.deepEqual(checkImmutability({ root, baseRef: "HEAD" }), []);
});
test("digest ignores lifecycle only", () => {
  const bp = YAML.parse(fs.readFileSync(path.join(PKG_ROOT, STABLE), "utf8"));
  const d = blueprintDigest(bp);
  assert.equal(blueprintDigest({ ...bp, lifecycle: { status: "deprecated" } }), d);
  assert.notEqual(blueprintDigest({ ...bp, version: "9.9.9" }), d);
});

// ---- hygiene: synthetic data + disabled features ----
test("nested QB execution cannot be enabled", () => {
  const root = sandbox();
  mutate(root, DRAFT, (d) => { d.orchestration.nestedQb = "allowed"; });
  assert.ok(codes(validateAll({ root })).includes("E_SCHEMA"));
});
test("synthetic evidence rules", () => {
  let root = sandbox();
  mutate(root, "qbs/research-synthesis/1.0.0/evidence/refs.yaml", (d) => { d.refs[0].synthetic = false; });
  assert.ok(codes(validateAll({ root })).includes("E_SYNTHETIC"));

  root = sandbox();
  mutate(root, "qbs/research-synthesis/1.0.0/evidence/refs.yaml", (d) => { delete d.refs[0].synthetic; });
  assert.ok(codes(validateAll({ root })).includes("E_SCHEMA"));

  root = sandbox();
  mutate(root, CAND, (d) => { d.provenance.derivedFrom.evidenceRefs = ["evidence://cortex/real-looking/x"]; });
  assert.ok(codes(validateAll({ root })).includes("E_SYNTHETIC"));

  root = sandbox();
  mutate(root, DRAFT, (d) => { d.metadata.name = "Incident Triage QB"; });
  assert.ok(codes(validateAll({ root })).includes("E_SYNTHETIC"));

  root = sandbox(); // a non-example blueprint may not use the synthetic store
  mutate(root, CAND, (d) => { delete d.metadata.labels.example; });
  assert.ok(codes(validateAll({ root })).includes("E_SYNTHETIC"));
});
test("index marks example entries synthetic", () => {
  const idx = buildIndex(validateAll().versions, "abc");
  assert.ok(idx.entries.every((e) => e.synthetic === true));
});
test("no invented personal identities remain", () => {
  const r = spawnSync("grep", ["-rIl", "chris-marchant", ".", "--exclude-dir=node_modules", "--exclude-dir=.git", "--exclude-dir=test"], { cwd: PKG_ROOT, encoding: "utf8" });
  assert.equal(r.stdout.trim(), "");
});
