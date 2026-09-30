// Regression tests for the local defect remediation pass (data validation, unsafe integers, prerelease policy, identity immutability,
// sidecar lint, evaluation-suite binding). Positive and negative cases; populated-baseline immutability uses real Git sandboxes.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import {
  validateAll, checkImmutability, buildIndex, artifactDigest, suiteDigest, directorySeal, canonicalize, parseYaml, cloneCanonicalData,
  findInvalidData, unsafeIntegerLiteral, lintSidecar, versionSatisfies, resolveRef, DataRejectedError, PKG_ROOT,
} from "../scripts/lib/core.mjs";

const ystr = (v) => YAML.stringify(v, { aliasDuplicateObjects: false });
const codes = (r) => [...new Set(r.errors.map((e) => e.code))];
const SYN = "synthetic/qbs/synthetic.";
const CANON = `${SYN}research-synthesis/1.0.0`;
const CAND = `${SYN}research-synthesis/1.1.0`;
const DRAFT = `${SYN}incident-triage/0.1.0`;
const bp = (d) => `${d}/blueprint.yaml`;

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qbrem-"));
  fs.cpSync(path.join(PKG_ROOT, "synthetic"), path.join(root, "synthetic"), { recursive: true });
  fs.mkdirSync(path.join(root, "qbs"));
  return root;
}
const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");
const write = (root, rel, text) => fs.writeFileSync(path.join(root, rel), text);
function mutate(root, rel, fn) { const d = YAML.parse(read(root, rel)); fn(d); write(root, rel, ystr(d)); }
function gitRepo(pre) {
  const root = sandbox();
  if (pre) pre(root);
  const g = (...a) => execFileSync("git", a, { cwd: root, stdio: "pipe" });
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@example.com"); g("config", "user.name", "t");
  g("add", "-A"); g("commit", "-q", "-m", "populated baseline");
  return { root, g };
}
const imm = (root) => checkImmutability({ root, baseRef: "HEAD" });
const immCodes = (root) => [...new Set(imm(root).map((e) => e.code))];
const overlay = (id, version, entries) => ystr({ apiVersion: "registry.zeptly.dev/v1alpha1", kind: "LifecycleOverlay", metadata: { registry: "qb-agents", id, version }, entries });
const who = { type: "human", id: "example-human-reviewer" };

/* ------------------------------------------------------------------ 1. invalid values rejected before clone/hash */
test("1. blueprint with .inf in free-form data: controlled E_DATA_TYPE diagnostic, never coerced to null, no uncaught exception", () => {
  for (const [literal, label] of [[".inf", "Infinity"], ["-.inf", "-Infinity"], [".nan", "NaN"]]) {
    const root = sandbox();
    const f = bp(DRAFT);
    write(root, f, read(root, f).replace(/^spec:\n/m, `spec:\n  extensions:\n    bad: ${literal}\n`));
    let r;
    assert.doesNotThrow(() => { r = validateAll({ root }); }, label);
    const e = r.errors.find((x) => x.code === "E_DATA_TYPE");
    assert.ok(e, `${label}: expected E_DATA_TYPE, got ${JSON.stringify(codes(r))}`);
    assert.ok(e.file.endsWith("synthetic.incident-triage/0.1.0/blueprint.yaml"), e.file);
    assert.equal(e.where, "/spec/extensions/bad");
    assert.match(e.message, /non-finite/);
    // the rejected artifact is not hashed or indexed
    assert.ok(!buildIndex(r.versions, "synthetic").entries.some((x) => x.id === "synthetic.incident-triage"));
    assert.equal(r.versions.find((v) => v.dirId === "synthetic.incident-triage").digest, undefined);
  }
});
test("1. canonical suite with .inf: controlled diagnostic on the suite file instead of an uncaught TypeError", () => {
  const root = sandbox();
  const f = `${CANON}/evals/suite.yaml`;
  write(root, f, read(root, f).replace("environment:", "environment:\n      inf: .inf"));
  assert.ok(read(root, f).includes(".inf"));
  let r;
  assert.doesNotThrow(() => { r = validateAll({ root }); });
  const e = r.errors.find((x) => x.code === "E_DATA_TYPE");
  assert.ok(e && e.file.endsWith("research-synthesis/1.0.0/evals/suite.yaml"), JSON.stringify(r.errors.slice(0, 3)));
  assert.match(e.where, /^\/scenarios\/\d+\/environment\/.*inf$/);
  assert.ok(!codes(r).includes("E_INTERNAL"));
  assert.ok(!r.errors.some((x) => x.code === "E_SEAL"), "no spurious seal error for a rejected suite");
});
test("1. !!binary and other non-plain YAML values are rejected with a path", () => {
  const root = sandbox();
  const f = bp(DRAFT);
  write(root, f, read(root, f).replace(/^spec:\n/m, "spec:\n  extensions:\n    bin: !!binary aGVsbG8=\n"));
  const e = validateAll({ root }).errors.find((x) => x.code === "E_YAML_TAG");
  assert.ok(e); assert.equal(e.where, "/spec/extensions/bin"); assert.match(e.message, /binary/);
});
test("1. artifactDigest/suiteDigest/canonicalize throw DataRejectedError (a TypeError) with a path and never coerce to null", () => {
  const good = parseYaml(read(PKG_ROOT, bp(CANON)));
  const withInf = JSON.parse(JSON.stringify(good)); withInf.spec.extensions = { x: null };
  const digestWithNull = artifactDigest(withInf);
  withInf.spec.extensions.x = Infinity;
  let err; try { artifactDigest(withInf); } catch (e) { err = e; }
  assert.ok(err instanceof DataRejectedError && err instanceof TypeError);
  assert.deepEqual(err.diagnostics.map((d) => d.path), ["/spec/extensions/x"]);
  assert.notEqual(digestWithNull, undefined);
  assert.throws(() => suiteDigest({ a: [1, NaN] }), (e) => e instanceof DataRejectedError && e.diagnostics[0].path === "/a/1");
  assert.throws(() => canonicalize({ k: { y: -Infinity } }), (e) => e.diagnostics[0].path === "/k/y");
  // valid data: unchanged behaviour (golden values are asserted in registry.test.mjs)
  assert.equal(artifactDigest(good), JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "test/golden/digest-seal.json"), "utf8")).artifactDigest);
});
test("1. every unsupported value type is rejected before cloning (no silent conversion)", () => {
  class Foo { constructor() { this.a = 1; } }
  const cases = { date: new Date(0), map: new Map(), set: new Set(), buffer: Buffer.from("x"), instance: new Foo(), undef: undefined, fn: () => 1, sym: Symbol("s"), big: 10n };
  for (const [name, value] of Object.entries(cases)) {
    const doc = { ok: 1, nested: { v: value } };
    const bad = findInvalidData(doc);
    assert.equal(bad.length, 1, name);
    assert.equal(bad[0].path, "/nested/v", name);
    assert.throws(() => cloneCanonicalData(doc), DataRejectedError, name);
    assert.throws(() => canonicalize(doc), DataRejectedError, name);
  }
  const holes = [1, , 3]; // eslint-disable-line no-sparse-arrays
  assert.equal(findInvalidData({ h: holes })[0].path, "/h/1");
  const cyc = { a: {} }; cyc.a.self = cyc;
  assert.ok(findInvalidData(cyc).some((d) => /nesting|cycle/.test(d.message)));
  assert.throws(() => canonicalize(cyc), DataRejectedError);
  // valid plain data incl. null-prototype objects and -0 still clones and hashes
  const np = Object.create(null); np.z = 1;
  assert.deepEqual(cloneCanonicalData({ a: [null, true, "s", 1.5, -0], np }), { a: [null, true, "s", 1.5, -0], np: { z: 1 } });
  assert.equal(canonicalize({ n: -0 }), '{"n":0}');
});
test("1. rejected sidecars (release/lifecycle/refs) also yield controlled diagnostics", () => {
  for (const [rel, ins] of [[`${CANON}/release.yaml`, "promotionRef: 9007199254740993\n"], [`${CAND}/evidence/refs.yaml`, "extra: .inf\n"]]) {
    const root = sandbox();
    write(root, rel, read(root, rel) + ins);
    let r; assert.doesNotThrow(() => { r = validateAll({ root }); });
    assert.ok(r.errors.some((e) => e.file.endsWith(rel.split("/").slice(-2).join("/")) && /E_UNSAFE_INTEGER|E_DATA_TYPE/.test(e.code)), JSON.stringify(codes(r)));
  }
});

/* ------------------------------------------------------------------ 2. unsafe integers rejected from source text */
const UNSAFE = ["9007199254740992", "9007199254740993", "-9007199254740993", "+9007199254740993", "-9007199254740992", "12345678901234567890",
  "0x20000000000000", "0o1000000000000000000", "1e16", "1E+16", "9007199254740993e0", "90071992547409.93e2", "900719925474099.3e1",
  "9.007199254740993e15", "9007199254740993.0", "1.5e300", "0.00000000000000000000001e40"];
const SAFE = ["0", "-0", "1", "9007199254740991", "-9007199254740991", "0x1FFFFFFFFFFFFF", "1e3", "1e15", "1.0", "2.5e15", "9.007199254740991e15",
  "0.5", "1e-7", "123456789012345678.5", "1.5", "-1.25e2", ".5e1", "0e99999", "100.50", "5e-324"];
test("2. unsafeIntegerLiteral classifies integer and exponent source forms exactly", () => {
  for (const l of UNSAFE) assert.equal(unsafeIntegerLiteral(l), true, `should be unsafe: ${l}`);
  for (const l of SAFE) assert.equal(unsafeIntegerLiteral(l), false, `should be safe: ${l}`);
  const MAX = BigInt(Number.MAX_SAFE_INTEGER);
  assert.equal(unsafeIntegerLiteral(`0x${MAX.toString(16)}`), false);
  assert.equal(unsafeIntegerLiteral(`0x${(MAX + 1n).toString(16)}`), true);
  assert.equal(unsafeIntegerLiteral(`0o${MAX.toString(8)}`), false);
  assert.equal(unsafeIntegerLiteral(`0o${(MAX + 1n).toString(8)}`), true);
  assert.equal(unsafeIntegerLiteral("1e99999999999"), true); // astronomically large exponent
  assert.equal(unsafeIntegerLiteral("1e-99999999999"), false);
});
test("2. parseYaml rejects unsafe integer literals before rounding (values, keys, nested, flow) and keeps valid numbers", () => {
  for (const l of UNSAFE) {
    let err; try { parseYaml(`a:\n  b: [ 1, ${l} ]\n`); } catch (e) { err = e; }
    if (l === "0.00000000000000000000001e40") { /* = 1e17, integer-valued */ }
    assert.ok(err instanceof DataRejectedError, `should reject ${l}`);
    assert.ok(err.diagnostics.some((d) => ["E_UNSAFE_INTEGER", "E_DATA_TYPE"].includes(d.code)), l);
  }
  const e1 = (() => { try { parseYaml("a: 9007199254740993\n"); } catch (e) { return e; } })();
  assert.equal(e1.diagnostics[0].code, "E_UNSAFE_INTEGER");
  assert.equal(e1.diagnostics[0].path, "/a");
  assert.match(e1.diagnostics[0].message, /9007199254740993/);
  const e2 = (() => { try { parseYaml("9007199254740993: k\n"); } catch (e) { return e; } })();
  assert.match(e2.diagnostics[0].message, /mapping key/); assert.equal(e2.diagnostics[0].path, "/9007199254740993");
  const e3 = (() => { try { parseYaml("l:\n  - 1\n  - 0x20000000000000\n"); } catch (e) { return e; } })();
  assert.equal(e3.diagnostics[0].path, "/l/1");
  const e4 = (() => { try { parseYaml("a: [9007199254740993, 1e16]\n"); } catch (e) { return e; } })();
  assert.equal(e4.diagnostics.length, 2);
  // valid input: same values as before, fractional behaviour preserved, quoted digits stay strings
  assert.deepEqual(parseYaml("a: 9007199254740991\nb: 1e3\nc: 0.5\nd: 1.0\ne: \"9007199254740993\"\nf: 123456789012345678.5\ng: -1.25e2\nh: 0x1FFFFFFFFFFFFF\n"),
    { a: 9007199254740991, b: 1000, c: 0.5, d: 1, e: "9007199254740993", f: 123456789012345680, g: -125, h: 9007199254740991 });
});
test("2. unsafe integers in a blueprint and a suite yield controlled E_UNSAFE_INTEGER diagnostics with paths", () => {
  let root = sandbox();
  write(root, bp(DRAFT), read(root, bp(DRAFT)).replace(/^spec:\n/m, "spec:\n  extensions:\n    big: 9007199254740993\n"));
  let r = validateAll({ root });
  let e = r.errors.find((x) => x.code === "E_UNSAFE_INTEGER");
  assert.ok(e && e.where === "/spec/extensions/big" && e.file.endsWith("incident-triage/0.1.0/blueprint.yaml"));
  root = sandbox();
  const f = `${CAND}/evals/suite.yaml`;
  write(root, f, read(root, f).replace("environment:", "environment:\n      n: 1e16"));
  r = validateAll({ root }); e = r.errors.find((x) => x.code === "E_UNSAFE_INTEGER");
  assert.ok(e && e.file.endsWith("1.1.0/evals/suite.yaml") && /environment\/n$/.test(e.where));
});

/* ------------------------------------------------------------------ 3. prerelease eligibility agrees */
test("3. peer-index validator and resolver share one prerelease policy (eligible and ineligible cases agree)", () => {
  const cases = [
    ["1.1.0-rc.1", "^1.0.0", false], ["1.1.0-rc.1", "^1.1.0-rc.0", true], ["1.1.0-rc.1", "1.1.0-rc.1", true],
    ["1.1.0-rc.1", ">=1.1.0-rc.1 <2.0.0", true], ["1.1.0-rc.1", "*", false], ["1.1.0-rc.1", "~1.1.0", false],
    ["1.2.0-rc.1", "^1.1.0-rc.0", false], ["2.0.0-beta.1", "^1.0.0", false], ["1.1.0", "^1.0.0", true],
  ];
  const target = { registry: "execution-agents", id: "synthetic.log-analyst" }; // references[0] of the draft QB
  for (const [version, range, eligible] of cases) {
    assert.equal(versionSatisfies(version, range), eligible, `versionSatisfies ${version} ${range}`);
    const root = sandbox();
    mutate(root, bp(DRAFT), (d) => { d.references[0].version = range; });
    const peerFile = path.join(root, "peer.json");
    const entries = [{ ...target, version, maturity: "canonical", lifecycle: "active", digest: "sha256:" + "a".repeat(64), digestAlgorithm: "zeptly-jcs-v1", domain: "synthetic" }];
    fs.writeFileSync(peerFile, JSON.stringify({ entries }));
    const r = validateAll({ root, peerIndexFiles: [peerFile] });
    const validatorEligible = !r.errors.some((e) => e.code === "E_UNRESOLVED" && e.where.includes(target.id));
    const resolverEligible = resolveRef({ ...target, version: range }, entries, { domain: "synthetic" }).status === "resolved";
    assert.equal(validatorEligible, eligible, `validator ${version} vs ${range}`);
    assert.equal(resolverEligible, eligible, `resolver ${version} vs ${range}`);
    assert.equal(validatorEligible, resolverEligible, `paths disagree for ${version} vs ${range}`);
  }
});

/* ------------------------------------------------------------------ 4. identity immutability against a populated baseline */
test("4. populated baseline: unchanged content passes; permitted lifecycle update passes", () => {
  const { root } = gitRepo();
  assert.deepEqual(imm(root), []);
  // permitted: append a legal overlay entry and mirror the effective state (lifecycle is not identity and is outside the digest)
  write(root, `${CANON}/lifecycle.yaml`, overlay("synthetic.research-synthesis", "1.0.0", [
    { state: "active", at: "2026-09-29T09:00:00Z", actor: who, reason: "released" },
    { state: "deprecated", at: "2026-10-01T09:00:00Z", actor: who, reason: "superseded by 1.1.0" }]));
  mutate(root, bp(CANON), (d) => { d.metadata.lifecycle = "deprecated"; });
  assert.deepEqual(imm(root), []);
  assert.deepEqual(validateAll({ root }).errors, []);
});
test("4. canonical version-only mutation with the directory name unchanged is detected", () => {
  const { root } = gitRepo();
  const before = parseYaml(read(root, bp(CANON)));
  mutate(root, bp(CANON), (d) => { d.metadata.version = "1.0.1"; });
  const after = parseYaml(read(root, bp(CANON)));
  assert.equal(artifactDigest(before), artifactDigest(after), "precondition: artifact digest excludes the version");
  const errs = imm(root);
  assert.ok(errs.some((e) => e.code === "E_IMMUTABLE" && /metadata\.version changed \(1\.0\.0 -> 1\.0\.1\)/.test(e.message) && e.file === bp(CANON)), JSON.stringify(errs));
  assert.ok(codes(validateAll({ root })).includes("E_PATH"), "validateAll still flags the directory/version mismatch");
});
test("4. canonical id/registry change, version move with rename, and deletion are detected", () => {
  let { root } = gitRepo();
  mutate(root, bp(CANON), (d) => { d.metadata.id = "synthetic.renamed"; });
  assert.ok(imm(root).some((e) => e.code === "E_IMMUTABLE" && /metadata\.id changed/.test(e.message)));
  ({ root } = gitRepo());
  mutate(root, bp(CANON), (d) => { d.metadata.registry = "skills"; });
  assert.ok(imm(root).some((e) => e.code === "E_IMMUTABLE" && /metadata\.registry changed/.test(e.message)));
  ({ root } = gitRepo());
  mutate(root, bp(CANON), (d) => { d.metadata.version = "1.0.1"; });
  fs.renameSync(path.join(root, CANON), path.join(root, CANON.replace("1.0.0", "1.0.1")));
  assert.ok(imm(root).some((e) => e.code === "E_IMMUTABLE" && /cannot be deleted/.test(e.message)));
  ({ root } = gitRepo());
  fs.rmSync(path.join(root, CANON), { recursive: true });
  assert.ok(imm(root).some((e) => e.code === "E_IMMUTABLE" && /cannot be deleted/.test(e.message)));
});
test("4. sidecar identity of a canonical version is immutable; candidates stay free to change", () => {
  let { root } = gitRepo((r) => {
    fs.mkdirSync(path.join(r, CANON, "evidence"));
    write(r, `${CANON}/evidence/refs.yaml`, ystr({ apiVersion: "registry.zeptly.dev/v1alpha1", kind: "QBEvidenceRefs", metadata: { registry: "qb-agents", id: "synthetic.research-synthesis", version: "1.0.0" }, refs: [{ id: "r1", type: "benchmark", uri: "evidence://synthetic-example/b/1", capturedAt: "2026-09-29T00:00:00Z", synthetic: true, summary: "SYNTHETIC EXAMPLE, not real execution evidence. Probe." }] }));
    write(r, `${CANON}/lifecycle.yaml`, overlay("synthetic.research-synthesis", "1.0.0", [{ state: "active", at: "2026-09-29T09:00:00Z", actor: who, reason: "released" }]));
  });
  assert.deepEqual(imm(root), []);
  mutate(root, `${CANON}/evidence/refs.yaml`, (d) => { d.metadata.version = "9.9.9"; });
  assert.ok(imm(root).some((e) => e.code === "E_IMMUTABLE" && /evidence refs identity/.test(e.message)));
  ({ root } = gitRepo((r) => write(r, `${CANON}/lifecycle.yaml`, overlay("synthetic.research-synthesis", "1.0.0", [{ state: "active", at: "2026-09-29T09:00:00Z", actor: who, reason: "released" }]))));
  mutate(root, `${CANON}/lifecycle.yaml`, (d) => { d.metadata.version = "9.9.9"; });
  assert.ok(imm(root).some((e) => e.code === "E_IMMUTABLE" && /lifecycle overlay identity/.test(e.message)));
  ({ root } = gitRepo());
  mutate(root, bp(CAND), (d) => { d.metadata.version = "1.1.1"; }); // candidate: mutable, including the version field
  assert.deepEqual(immCodes(root), []);
});
test("4. invalid data in a changed file yields controlled diagnostics from check-immutability", () => {
  const { root } = gitRepo();
  write(root, bp(CANON), read(root, bp(CANON)).replace(/^spec:\n/m, "spec:\n  extensions:\n    bad: .inf\n"));
  let errs; assert.doesNotThrow(() => { errs = imm(root); });
  assert.ok(errs.some((e) => e.code === "E_DATA_TYPE" && e.file === bp(CANON) && e.where === "/spec/extensions/bad"));
});

/* ------------------------------------------------------------------ 5. sidecar secret / endpoint lint */
const SECRET = "sk-" + "a1B2c3D4e5F6g7H8i9J0k1L2";
test("5. prohibited content is rejected in every accepted sidecar (evaluation suite, evidence refs, lifecycle, release)", () => {
  const targets = [
    ["evals/suite.yaml", CAND, (d, v) => { d.scenarios[0].description += ` ${v}`; }],
    ["evidence/refs.yaml", CAND, (d, v) => { d.refs[0].summary += ` ${v}`; }],
    ["release.yaml", CANON, (d, v) => { d.approvals[0].actor.id = v; }],
  ];
  for (const [name, dir, fn] of targets) for (const [bad, code] of [[SECRET, "E_SECRET"], ["https://jev.up.railway.app/v1", "E_ENDPOINT"]]) {
    const root = sandbox();
    mutate(root, `${dir}/${name}`, (d) => fn(d, bad));
    const e = validateAll({ root }).errors.find((x) => x.code === code && x.file.endsWith(name));
    assert.ok(e, `${name}: expected ${code}`);
    assert.ok(typeof e.where === "string" && e.where.startsWith("/"), `${name}: where=${e?.where}`);
  }
  // lifecycle overlay (created for the purpose)
  for (const [bad, code] of [[SECRET, "E_SECRET"], ["http://internal.railway.internal:8080", "E_ENDPOINT"]]) {
    const root = sandbox();
    write(root, `${CANON}/lifecycle.yaml`, overlay("synthetic.research-synthesis", "1.0.0", [{ state: "active", at: "2026-09-29T09:00:00Z", actor: who, reason: `released ${bad}` }]));
    const e = validateAll({ root }).errors.find((x) => x.code === code && x.file.endsWith("lifecycle.yaml"));
    assert.ok(e && e.where === "/entries/0/reason", JSON.stringify(e));
  }
  // secrets in mapping keys are found too
  const root = sandbox();
  mutate(root, `${CAND}/evals/suite.yaml`, (d) => { d.scenarios[0].environment = { [SECRET]: 1 }; });
  assert.ok(validateAll({ root }).errors.some((e) => e.code === "E_SECRET" && e.file.endsWith("evals/suite.yaml")));
  // generic http(s) URLs are also rejected in free text of sidecars (only designated pointer fields are exempt)
  const r2 = sandbox();
  mutate(r2, `${CAND}/evidence/refs.yaml`, (d) => { d.refs[0].summary += " see https://example.com/report"; });
  assert.ok(validateAll({ root: r2 }).errors.some((e) => e.code === "E_ENDPOINT" && e.file.endsWith("evidence/refs.yaml")));
});
test("5. legitimate pointers and identifiers remain accepted (scoped exemptions, no blanket URL ban)", () => {
  // shipped fixtures carry evidence:// pointers in refs and attestations
  assert.deepEqual(validateAll().errors, []);
  // release.promotionRef is a designated pointer field: a PR reference or URL is accepted there
  for (const ref of ["Zeptly/registry-qb-agents#12", "https://github.com/Zeptly/registry-qb-agents/pull/12"]) {
    const root = sandbox();
    mutate(root, `${CANON}/release.yaml`, (d) => { d.promotionRef = ref; });
    const r = validateAll({ root });
    assert.ok(!r.errors.some((e) => ["E_ENDPOINT", "E_SECRET"].includes(e.code)), ref);
    assert.deepEqual(r.errors, [], ref);
  }
  // ... but the exemption is endpoint-only: a credential there is still rejected
  const root = sandbox();
  mutate(root, `${CANON}/release.yaml`, (d) => { d.promotionRef = `https://github.com/x/y/pull/1?token=${SECRET}`; });
  assert.ok(validateAll({ root }).errors.some((e) => e.code === "E_SECRET" && e.where === "/promotionRef"));
  // evidence pointer field and schema identifiers through the lint function directly
  const out = [];
  lintSidecar({ refs: [{ uri: "evidence://synthetic-example/x/1", summary: "ok" }], "$schema": "https://json-schema.org/draft/2020-12/schema", input: { "$id": "https://json-schema.org/x", t: "plain" } }, (c, w) => out.push([c, w]), (p) => p[0] === "refs" && p[2] === "uri");
  assert.deepEqual(out, []);
  const out2 = []; lintSidecar({ refs: [{ uri: "https://x.example/y" }] }, (c, w) => out2.push([c, w]), (p) => p[0] === "refs" && p[2] === "uri");
  assert.deepEqual(out2, [], "designated pointer field is exempt from the endpoint check");
  const out3 = []; lintSidecar({ refs: [{ note: "https://x.example/y" }] }, (c, w) => out3.push([c, w]), (p) => p[0] === "refs" && p[2] === "uri");
  assert.deepEqual(out3, [["E_ENDPOINT", "/refs/0/note"]]);
  // blueprint-level exemptions are unchanged (metadata.links accepted)
  const r3 = sandbox();
  mutate(r3, bp(DRAFT), (d) => { d.metadata.links = [{ title: "Docs", url: "https://docs.example.com/qb" }]; });
  assert.deepEqual(validateAll({ root: r3 }).errors, []);
});
test("5. sidecar lint findings do not mask other sidecar validation", () => {
  const root = sandbox();
  mutate(root, `${CAND}/evals/suite.yaml`, (d) => { d.scenarios[0].description += ` ${SECRET}`; d.metadata.version = "9.9.9"; });
  const c = codes(validateAll({ root }));
  assert.ok(c.includes("E_SECRET") && c.includes("E_SUITE"), JSON.stringify(c));
});

/* ------------------------------------------------------------------ 6. evaluation attestations bind to their suite */
test("6. evaluation attestations require a suite identity and digest (schema)", () => {
  const root = sandbox();
  mutate(root, bp(CAND), (d) => { delete d.attestations[0].suite; });
  assert.ok(codes(validateAll({ root })).includes("E_SCHEMA"));
  // non-evaluation attestation types are not required to name a suite
  const r2 = sandbox();
  mutate(r2, bp(CAND), (d) => { d.attestations.push({ type: "scan", ref: "evidence://synthetic-example/scans/1", subjectDigest: artifactDigest(d), capturedAt: "2026-09-29T11:00:00Z", synthetic: true, summary: "SYNTHETIC EXAMPLE, not real execution evidence. Probe." }); });
  assert.deepEqual(validateAll({ root: r2 }).errors, []);
});
test("6. a suite change stales the evaluation even though the artifact digest is unchanged", () => {
  for (const dir of [CAND, CANON]) {
    const root = sandbox();
    const before = artifactDigest(parseYaml(read(root, bp(dir))));
    mutate(root, `${dir}/evals/suite.yaml`, (d) => { d.scenarios[0].description += " (edited)"; });
    assert.equal(artifactDigest(parseYaml(read(root, bp(dir)))), before, "blueprint untouched");
    const r = validateAll({ root });
    const e = r.errors.find((x) => x.code === "E_SUITE_STALE");
    assert.ok(e && e.file.endsWith("blueprint.yaml") && /^\/attestations\/0\/suite\/digest$/.test(e.where), `${dir}: ${JSON.stringify(codes(r))}`);
    assert.ok(!r.errors.some((x) => x.code === "E_ATTESTATION_STALE"), "the artifact-digest binding is still intact; only the suite binding is stale");
  }
});
test("6. resealing alone does not make an old evaluation valid; the evaluation must be re-bound", () => {
  const root = sandbox();
  mutate(root, `${CANON}/evals/suite.yaml`, (d) => { d.gates.canonical[0].value = 0.8; });
  // reseal: recompute the release record for the changed suite (payload, digest, seal)
  const bpDoc = parseYaml(read(root, bp(CANON))), suite = parseYaml(read(root, `${CANON}/evals/suite.yaml`));
  const { payload, seal } = directorySeal(bpDoc, suite);
  mutate(root, `${CANON}/release.yaml`, (d) => { d.payload = payload; d.directorySeal = seal; d.digest = artifactDigest(bpDoc); });
  const r = validateAll({ root });
  assert.ok(!r.errors.some((e) => ["E_SEAL", "E_DIGEST"].includes(e.code)), "release is consistent after resealing: " + JSON.stringify(codes(r)));
  assert.ok(r.errors.some((e) => e.code === "E_SUITE_STALE"), "old evaluation is still stale");
  assert.ok(r.errors.some((e) => e.code === "E_PROMOTION" && /evaluation suite/.test(e.message)), "canonical promotion requires a suite-bound evaluation");
  // re-binding the evaluation to the new suite (a new assessment) resolves it
  mutate(root, bp(CANON), (d) => { d.attestations[0].suite.digest = suiteDigest(suite); });
  assert.deepEqual(validateAll({ root }).errors, []);
});
test("6. suite identity must match; existing passing-result and threshold checks still apply", () => {
  let root = sandbox();
  mutate(root, bp(CAND), (d) => { d.attestations[0].suite.version = "9.9.9"; });
  assert.ok(codes(validateAll({ root })).includes("E_SUITE_MISMATCH"));
  root = sandbox();
  mutate(root, bp(CAND), (d) => { d.attestations[0].suite.id = "synthetic.other"; });
  assert.ok(codes(validateAll({ root })).includes("E_SUITE_MISMATCH"));
  root = sandbox();
  mutate(root, bp(CAND), (d) => { d.attestations[0].suite.digest = "sha256:" + "0".repeat(64); });
  assert.ok(codes(validateAll({ root })).includes("E_SUITE_STALE"));
  root = sandbox();
  mutate(root, bp(CANON), (d) => { d.attestations[0].metrics["task-success-rate"] = 0.5; });
  assert.ok(codes(validateAll({ root })).includes("E_GATE"));
  root = sandbox();
  mutate(root, bp(CANON), (d) => { d.attestations[0].result = "fail"; });
  assert.ok(codes(validateAll({ root })).includes("E_PROMOTION"));
  root = sandbox();
  fs.rmSync(path.join(root, CAND, "evals"), { recursive: true });
  assert.ok(codes(validateAll({ root })).includes("E_SUITE"), "attestation without a suite file is still rejected");
});
test("6. fixture claims are transparent and hashes are unchanged for valid inputs", () => {
  const g = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "test/golden/digest-seal.json"), "utf8"));
  const dir = path.join(PKG_ROOT, CANON);
  const b = parseYaml(fs.readFileSync(path.join(dir, "blueprint.yaml"), "utf8")), s = parseYaml(fs.readFileSync(path.join(dir, "evals/suite.yaml"), "utf8"));
  assert.equal(b.attestations[0].suite.digest, suiteDigest(s));
  assert.equal(b.attestations[0].suite.digest, g.suiteDigest);
  assert.equal(artifactDigest(b), g.artifactDigest);
  assert.equal(directorySeal(b, s).seal, g.directorySeal);
  assert.match(fs.readFileSync(path.join(dir, "blueprint.yaml"), "utf8"), /SYNTHETIC: suite binding added by the local defect-remediation pass/);
});
