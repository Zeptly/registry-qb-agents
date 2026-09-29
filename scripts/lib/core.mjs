// Core registry logic for the QB registry (Zeptly Registry Protocol v0.1 rendering).
// Pure data processing: no network access, no runtime behaviour.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import semver from "semver";
import YAML from "yaml";

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const REGISTRY = "qb-agents";
export const SCOPES = { production: "qbs", synthetic: "synthetic/qbs" };
export const SYNTHETIC_ID_PREFIX = "synthetic.";
export const SYN_STORE = "evidence://synthetic-example/";
export const LIFECYCLE_TRANSITIONS = { active: ["deprecated", "revoked"], deprecated: ["revoked"], revoked: [] };
export const ALLOWED_FILES = new Set(["blueprint.yaml", "release.yaml", "lifecycle.yaml", "evals/suite.yaml", "evidence/refs.yaml"]);
const CLASSIFICATION_ORDER = ["public", "internal", "confidential", "restricted"];

// ---------- helpers ----------
export function canonicalize(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
export const sha256 = (s) => "sha256:" + crypto.createHash("sha256").update(s).digest("hex");

/**
 * Artifact digest: sha256 of canonical JSON of the artifact EXCLUDING the overlay/assessment fields that legitimately
 * change after content is fixed: metadata.maturity, metadata.lifecycle, security.approvals and attestations.
 * Attestations and approvals bind to this digest, so they cannot be inside it.
 */
export function artifactDigest(bp) {
  const c = JSON.parse(JSON.stringify(bp));
  if (c.metadata) { delete c.metadata.maturity; delete c.metadata.lifecycle; }
  if (c.security) delete c.security.approvals;
  delete c.attestations;
  return sha256(canonicalize(c));
}
export const suiteDigest = (suite) => sha256(canonicalize(suite));

export const parseYaml = (text) => YAML.parse(text, { schema: "core", uniqueKeys: true });
const readYaml = (file) => parseYaml(fs.readFileSync(file, "utf8"));

function walkStrings(node, cb, p = []) {
  if (typeof node === "string") cb(node, p);
  else if (Array.isArray(node)) node.forEach((v, i) => walkStrings(v, cb, [...p, i]));
  else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) { if (k === "$schema" || k === "$id") continue; walkStrings(v, cb, [...p, k]); }
}
const classRank = (c) => CLASSIFICATION_ORDER.indexOf(c);

// ---------- schemas ----------
let _ajv;
export function getAjv() {
  if (_ajv) return _ajv;
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
  addFormats(ajv);
  const dir = path.join(PKG_ROOT, "schemas");
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".schema.json"))) ajv.addSchema(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
  return (_ajv = ajv);
}
const SCHEMA_IDS = {
  blueprint: "urn:zeptly:qb:schema:blueprint:v1", suite: "urn:zeptly:qb:schema:eval-suite:v1", refs: "urn:zeptly:qb:schema:evidence-refs:v1",
  release: "urn:zeptly:qb:schema:release:v1", lifecycle: "urn:zeptly:qb:schema:lifecycle:v1", index: "urn:zeptly:qb:schema:registry-index:v1",
  envelope: "urn:zeptly:qb:schema:evidence-envelope:v1", lock: "urn:zeptly:qb:schema:resolution-lock:v1",
};
export function schemaErrors(kind, data) {
  const validate = getAjv().getSchema(SCHEMA_IDS[kind]);
  if (validate(data)) return [];
  return validate.errors.map((e) => `${e.instancePath || "/"} ${e.message}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ""}`);
}

// ---------- loading ----------
export function loadRegistry(root) {
  const versions = [];
  for (const [scope, sub] of Object.entries(SCOPES)) {
    const base = path.join(root, sub);
    if (!fs.existsSync(base)) continue;
    for (const idDir of fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      for (const ver of fs.readdirSync(path.join(base, idDir.name), { withFileTypes: true }).filter((d) => d.isDirectory())) {
        const dir = path.join(base, idDir.name, ver.name);
        const rel = path.relative(root, dir).split(path.sep).join("/");
        const entry = { scope, dirId: idDir.name, dirVersion: ver.name, dir, rel, errors: [], warnings: [] };
        const load = (name) => {
          const f = path.join(dir, name);
          if (!fs.existsSync(f)) return undefined;
          try { return readYaml(f); } catch (e) { entry.errors.push({ code: "E_YAML", file: `${rel}/${name}`, message: e.message }); return null; }
        };
        entry.blueprint = load("blueprint.yaml");
        entry.suite = load("evals/suite.yaml");
        entry.refs = load("evidence/refs.yaml");
        entry.release = load("release.yaml");
        entry.overlay = load("lifecycle.yaml");
        entry.files = listFiles(dir);
        versions.push(entry);
      }
    }
  }
  return versions;
}
function listFiles(dir, prefix = "") {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? listFiles(path.join(dir, d.name), `${prefix}${d.name}/`) : [`${prefix}${d.name}`]));
}

// ---------- literal lint ----------
const URL_RE = /\bhttps?:\/\//i;
const INFRA_HOST_RE = /\b[a-z0-9.-]+\.(up\.railway\.app|railway\.internal|railway\.app|trigger\.dev|supabase\.(co|in))\b/i;
const SECRET_RES = [/\bsk-[A-Za-z0-9_-]{20,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bgh[pousr]_[A-Za-z0-9]{30,}/, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b(api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*["']?[A-Za-z0-9/+_-]{12,}/i];
const MODEL_RE = /\b(claude-[a-z0-9.-]+|gpt-[a-z0-9.-]+|gemini-[a-z0-9.-]+|llama-?\d[a-z0-9.-]*|mistral-[a-z0-9.-]+)\b/i;
const REPO_RE = /\bZeptly\/registry-|\bregistry-(execution-agents|tiny-agents|skills|qb-agents)\b|\.\.\/|\bgithub\.com\//i;
const URL_ALLOWED = [["metadata", "links"], ["provenance", "externalSources"]];
function lintLiterals(bp, err) {
  walkStrings(bp, (s, p) => {
    const where = "/" + p.join("/");
    if (URL_ALLOWED.some((a) => a.every((seg, i) => p[i] === seg))) return;
    if (URL_RE.test(s) || INFRA_HOST_RE.test(s)) err("E_ENDPOINT", where, "URLs/hosts are forbidden; reach services through abstract gateway contracts");
    if (SECRET_RES.some((r) => r.test(s))) err("E_SECRET", where, "value looks like a credential");
    if (REPO_RE.test(s)) err("E_REPO_COUPLING", where, "references must use structured {registry,id,version}, not repository names or relative paths");
    if (!(p[0] === "spec" && (p[1] === "contracts" || p[1] === "identity")) && MODEL_RE.test(s)) err("E_MODEL_PIN", where, "concrete model identifiers are not allowed; use model tiers");
  });
}

// ---------- per-version validation ----------
export function validateVersion(v, ctx) {
  const { errors, warnings } = v;
  const bp = v.blueprint;
  const file = (n) => `${v.rel}/${n}`;
  const err = (code, where, message, f = "blueprint.yaml") => errors.push({ code, file: file(f), where, message });
  const warn = (code, where, message, f = "blueprint.yaml") => warnings.push({ code, file: file(f), where, message });

  // repository hygiene: no runtime tapes / unexpected artifacts
  for (const f of v.files) if (!ALLOWED_FILES.has(f)) err("E_UNEXPECTED_FILE", "", `${f} is not a registry artifact file. Raw tapes, trajectories and runtime payloads must stay in the evidence store, never in Git`, f);

  if (bp === undefined) return err("E_MISSING", "", "blueprint.yaml is missing");
  if (bp === null) return;
  for (const m of schemaErrors("blueprint", bp)) err("E_SCHEMA", "", m);
  if (errors.some((e) => e.code === "E_SCHEMA")) return;

  const md = bp.metadata, spec = bp.spec;
  const id = md.id;
  const digest = (v.digest = artifactDigest(bp));

  // directory / scope identity
  if (id !== v.dirId) err("E_PATH", "/metadata/id", `directory ${v.dirId} does not match metadata.id ${id}`);
  if (md.version !== v.dirVersion) err("E_PATH", "/metadata/version", `directory ${v.dirVersion} does not match metadata.version ${md.version}`);
  const isSynthetic = md.synthetic === true;
  if (isSynthetic !== (v.scope === "synthetic")) err("E_SYNTHETIC", "/metadata/synthetic", v.scope === "synthetic" ? "artifacts under synthetic/ must set metadata.synthetic: true" : "synthetic artifacts may only live under synthetic/qbs/, never in the production namespace");
  if (isSynthetic !== id.startsWith(SYNTHETIC_ID_PREFIX)) err("E_SYNTHETIC", "/metadata/id", `synthetic artifacts must use the "${SYNTHETIC_ID_PREFIX}" id namespace and production artifacts must not`);

  lintLiterals(bp, (code, where, message) => err(code, where, message));

  // ---- references (structured, structural validation only) ----
  const refKey = (r) => `${r.registry}/${r.id}`;
  const refs = new Map();
  bp.references.forEach((r, i) => {
    if (refs.has(refKey(r))) err("E_REF_DUP", `/references/${i}`, `duplicate reference ${refKey(r)}`);
    refs.set(refKey(r), r);
    if (!semver.validRange(r.version)) err("E_RANGE", `/references/${i}/version`, `invalid semver range "${r.version}"`);
    if (!ctx.registries.has(r.registry)) err("E_REGISTRY", `/references/${i}/registry`, `registry "${r.registry}" is not declared in registries.yaml`);
    if (r.registry === REGISTRY && r.id === id) err("E_REF_SELF", `/references/${i}`, "an artifact cannot reference itself");
    if (r.registry === REGISTRY) err("E_NESTED_QB", `/references/${i}`, "nested QB execution is disabled; qb-agents references are not allowed as execution dependencies");
  });
  const need = (registry, rid, where) => { if (!refs.has(`${registry}/${rid}`)) err("E_REF_UNDECLARED", where, `${registry}/${rid} is used but not declared in references`); };
  spec.delegation.executionAgents.allow.forEach((x, i) => need("execution-agents", x, `/spec/delegation/executionAgents/allow/${i}`));
  (spec.delegation.tinyAgents.allowedTemplates ?? []).forEach((x, i) => need("tiny-agents", x, `/spec/delegation/tinyAgents/allowedTemplates/${i}`));
  (spec.delegation.tinyAgents.allowedSkills ?? []).forEach((x, i) => need("skills", x, `/spec/delegation/tinyAgents/allowedSkills/${i}`));
  spec.delegation.rules.forEach((r, i) => {
    if (r.action === "delegate-execution-agent") {
      if (!r.target) err("E_RULE_TARGET", `/spec/delegation/rules/${i}`, "delegate-execution-agent rules need a target");
      else if (!spec.delegation.executionAgents.allow.includes(r.target)) err("E_RULE_TARGET", `/spec/delegation/rules/${i}/target`, `${r.target} is not in executionAgents.allow`);
    }
    if (r.action === "compile-tiny-agent" && r.target) need("tiny-agents", r.target, `/spec/delegation/rules/${i}/target`);
  });

  // ---- platform tokens (opaque; ownership unresolved) ----
  const allowedCaps = new Set(spec.capabilities.allow.map((c) => c.id));
  for (const x of spec.capabilities.deny ?? []) if (allowedCaps.has(x)) err("E_CAP_CONFLICT", "/spec/capabilities", `${x} is both allowed and denied`);
  Object.keys(spec.concurrency.perCapability ?? {}).forEach((k) => { if (!allowedCaps.has(k)) err("E_CAP_UNDECLARED", `/spec/concurrency/perCapability/${k}`, `${k} is not in capabilities.allow`); });
  const declaredGw = new Map(spec.compatibility.gatewayContracts.map((g) => [g.id, g]));
  for (const [gid, where] of [[spec.jev.gateway.contract, "/spec/jev/gateway/contract"], [spec.state.store, "/spec/state/store"], [spec.evidence.sink, "/spec/evidence/sink"]]) {
    if (!declaredGw.has(gid)) err("E_GATEWAY_COMPAT", where, `${gid} must be listed in spec.compatibility.gatewayContracts`);
  }
  for (const g of spec.compatibility.gatewayContracts) if (!semver.validRange(g.version)) err("E_RANGE", "/spec/compatibility/gatewayContracts", `invalid semver range "${g.version}"`);
  if (!semver.validRange(spec.jev.gateway.version)) err("E_RANGE", "/spec/jev/gateway/version", `invalid semver range "${spec.jev.gateway.version}"`);
  if (!semver.validRange(spec.compatibility.runtime.version)) err("E_RANGE", "/spec/compatibility/runtime/version", "invalid semver range");
  if (!spec.jev.gateway.contract.includes("jev")) warn("W_JEV_CONTRACT", "/spec/jev/gateway/contract", "System-1 contract token does not mention jev");

  // ---- security metadata: declared, never silently altered ----
  const secCaps = new Set(bp.security.capabilities);
  for (const c of allowedCaps) if (!secCaps.has(c)) err("E_SECURITY", "/security/capabilities", `spec.capabilities.allow grants ${c} but security.capabilities does not declare it`);
  for (const c of secCaps) if (!allowedCaps.has(c)) err("E_SECURITY", "/security/capabilities", `security.capabilities declares ${c} which spec does not grant`);
  const cls = classRank(bp.security.classification);
  if (classRank(spec.jev.dataHandling?.maxClassification ?? "public") > cls) err("E_SECURITY", "/security/classification", "declared classification is lower than spec.jev.dataHandling.maxClassification");
  spec.capabilities.allow.forEach((c, i) => { if (classRank(c.constraints?.dataClassificationMax ?? "public") > cls) err("E_SECURITY", `/security/classification`, `declared classification is lower than capability ${c.id} dataClassificationMax (allow/${i})`); });

  // ---- QB-specific internal consistency (semantics unchanged) ----
  const o = spec.orchestration;
  if (!o.allowedStrategies.includes(o.defaultStrategy)) err("E_STRATEGY", "/spec/orchestration/defaultStrategy", "default strategy must be in allowedStrategies");
  if (o.allowedStrategies.includes("swarm") && !spec.swarm.enabled) err("E_SWARM", "/spec/orchestration/allowedStrategies", "swarm strategy allowed but swarm.enabled is false");
  if (spec.delegation.rules.some((r) => r.action === "swarm") && !spec.swarm.enabled) err("E_SWARM", "/spec/delegation/rules", "a rule requests swarm but swarm.enabled is false");
  const ta = spec.delegation.tinyAgents;
  if (!ta.allowCompile && spec.delegation.rules.some((r) => r.action === "compile-tiny-agent")) err("E_TINY", "/spec/delegation/rules", "a rule compiles Tiny Agents but tinyAgents.allowCompile is false");
  if (!ta.allowCompile && spec.delegation.fallback === "compile-tiny-agent") err("E_TINY", "/spec/delegation/fallback", "fallback compiles Tiny Agents but allowCompile is false");
  const perRun = spec.budgets.perRun;
  if (perRun.maxTinyAgents !== undefined && ta.maxPerRun > perRun.maxTinyAgents) err("E_BUDGET", "/spec/delegation/tinyAgents/maxPerRun", "exceeds budgets.perRun.maxTinyAgents");
  if (perRun.maxTinyAgents !== undefined && spec.concurrency.maxParallelTinyAgents > perRun.maxTinyAgents) warn("W_BUDGET", "/spec/concurrency/maxParallelTinyAgents", "exceeds budgets.perRun.maxTinyAgents (never reachable)");
  if (spec.swarm.enabled && spec.swarm.maxSize > ta.maxPerRun && ta.allowCompile) err("E_BUDGET", "/spec/swarm/maxSize", "swarm size exceeds tinyAgents.maxPerRun");
  if (spec.swarm.enabled && perRun.maxTinyAgents !== undefined && spec.swarm.maxSize > perRun.maxTinyAgents) err("E_BUDGET", "/spec/swarm/maxSize", "swarm size exceeds budgets.perRun.maxTinyAgents");
  const hitlHas = (w) => spec.hitl.approvals.some((a) => a.when === w);
  if (spec.swarm.enabled && spec.swarm.requiresHitlAbove !== undefined && !hitlHas("swarm-above-threshold")) err("E_HITL", "/spec/swarm/requiresHitlAbove", "needs a hitl approval with when: swarm-above-threshold");
  if (spec.replanning.triggers.includes("budget-pressure") && spec.budgets.softLimitRatio === undefined) err("E_BUDGET", "/spec/budgets/softLimitRatio", "budget-pressure trigger requires softLimitRatio");
  if (!spec.checkpointing.triggers.includes("before-hitl") && spec.hitl.approvals.length) warn("W_CHECKPOINT", "/spec/checkpointing/triggers", "HITL approvals exist but checkpointing lacks before-hitl");
  if (spec.context.handoff.maxContextTokens > spec.context.maxWorkingTokens) warn("W_CONTEXT", "/spec/context/handoff/maxContextTokens", "handoff limit exceeds working context");
  const jevOp = (op) => spec.jev.operations.find((x) => x.op === op)?.mode ?? "disabled";
  if (spec.planning.review.systemOneCritique && jevOp("critique") === "disabled") err("E_JEV", "/spec/planning/review/systemOneCritique", "requires jev operation `critique` to be enabled");
  const evals = [...(spec.evaluation.intermediate.evaluators ?? []), ...spec.evaluation.final.evaluators];
  if (evals.some((e) => e.kind === "system-one") && jevOp("evaluate") === "disabled") err("E_JEV", "/spec/evaluation", "system-one evaluators require jev operation `evaluate`");
  if (spec.delegation.executionAgents.selection === "system-one-routed" && jevOp("route") === "disabled") err("E_JEV", "/spec/delegation/executionAgents/selection", "system-one-routed requires jev operation `route`");
  if (spec.jev.onUnavailable === "degrade-to-local-heuristics" && spec.jev.operations.some((x) => x.mode === "required")) warn("W_JEV", "/spec/jev/onUnavailable", "required operations degrade to local heuristics when Jev is unavailable; confirm this is intended");
  if (new Set(spec.jev.operations.map((x) => x.op)).size !== spec.jev.operations.length) err("E_JEV", "/spec/jev/operations", "duplicate operation entries");
  spec.capabilities.allow.forEach((c, i) => { if (c.scopes.includes("external-send") && !c.requiresHitl && !hitlHas("external-send")) err("E_HITL", `/spec/capabilities/allow/${i}`, "external-send scope requires requiresHitl or a hitl approval with when: external-send"); });
  if (spec.purpose.taskClasses.some((t) => ["high", "critical"].includes(t.risk)) && spec.planning.review.humanApproval === "never" && !hitlHas("risk-at-least-high")) err("E_HITL", "/spec/planning/review/humanApproval", "high-risk task classes need human approval");
  if (spec.checkpointing.rollback?.allowed && spec.checkpointing.rollback.sideEffects === "ignore") warn("W_ROLLBACK", "/spec/checkpointing/rollback/sideEffects", "rollback ignoring side effects is unsafe for write capabilities");

  let inputValidator;
  try {
    inputValidator = new Ajv2020({ strict: false, allErrors: true }).compile(spec.contracts.input.schema);
    new Ajv2020({ strict: false }).compile(spec.contracts.output.schema);
  } catch (e) { err("E_IO_SCHEMA", "/spec/contracts", `invalid JSON Schema: ${e.message}`); }

  // ---- origin / provenance (WoC requirements preserved) ----
  const origin = md.origin;
  if (origin.type !== "evolved" && origin.evolution) err("E_ORIGIN", "/metadata/origin", "evolution is only valid for origin.type: evolved");
  if (!bp.provenance.authors.some((a) => a.type === "human")) err("E_PROVENANCE", "/provenance/authors", "at least one human author/approver is required (a QB never authors its own canonical definition)");
  for (const s of origin.evolution?.sourceRefs ?? []) {
    if (!bp.provenance.sourceRefs.some((p) => p.registry === s.registry && p.id === s.id && p.version === s.version)) err("E_PROVENANCE", "/provenance/sourceRefs", `origin.evolution.sourceRefs ${s.id}@${s.version} must also appear in provenance.sourceRefs`);
    if (s.registry !== REGISTRY || s.id !== id) err("E_PARENT", "/metadata/origin/evolution/sourceRefs", "a QB evolves only from versions of the same QB identity");
  }
  const woc = bp.provenance.transformations.filter((t) => t.kind === "wisdom-of-compute");
  if (woc.length && origin.type !== "evolved") err("E_ORIGIN", "/provenance/transformations", "a wisdom-of-compute transformation requires origin.type: evolved");

  // ---- synthetic / example data protection ----
  const synUri = (u) => u.startsWith(SYN_STORE);
  const allUris = [
    ...bp.provenance.transformations.flatMap((t) => [...(t.evidenceRefs ?? []), ...(t.evalRuns ?? [])]),
    ...bp.attestations.map((a) => a.ref), ...bp.security.approvals.flatMap((a) => (a.ref ? [a.ref] : [])),
  ];
  if (isSynthetic) {
    if (!md.name.startsWith("[EXAMPLE]")) err("E_SYNTHETIC", "/metadata/name", 'synthetic artifact names must start with "[EXAMPLE]"');
    allUris.forEach((u) => { if (!synUri(u)) err("E_SYNTHETIC", "/", `synthetic artifact references non-synthetic evidence ${u}`); });
    bp.attestations.forEach((a, i) => { if (a.synthetic !== true) err("E_SYNTHETIC", `/attestations/${i}`, "synthetic artifacts may only carry synthetic attestations"); });
  } else {
    allUris.forEach((u) => { if (synUri(u)) err("E_SYNTHETIC", "/", "production artifact references synthetic evidence"); });
    bp.attestations.forEach((a, i) => { if (a.synthetic !== false || synUri(a.ref)) err("E_SYNTHETIC", `/attestations/${i}`, "production attestations must be non-synthetic"); });
  }
  bp.attestations.forEach((a, i) => { if (a.synthetic === true && !a.summary.startsWith("SYNTHETIC EXAMPLE")) err("E_SYNTHETIC", `/attestations/${i}/summary`, 'synthetic summaries must start with "SYNTHETIC EXAMPLE"'); });

  // ---- digest-bound attestations and approvals ----
  bp.attestations.forEach((a, i) => { if (a.subjectDigest !== digest) err("E_ATTESTATION_STALE", `/attestations/${i}/subjectDigest`, `attestation binds ${a.subjectDigest} but the artifact digest is ${digest}; re-assess the current content`); });
  bp.security.approvals.forEach((a, i) => { if (a.subjectDigest !== digest) err("E_APPROVAL_STALE", `/security/approvals/${i}/subjectDigest`, `approval binds ${a.subjectDigest} but the artifact digest is ${digest}`); });

  // ---- evaluation suite ----
  if (v.suite) {
    for (const m of schemaErrors("suite", v.suite)) err("E_SCHEMA", "", m, "evals/suite.yaml");
    if (!errors.some((e) => e.file === file("evals/suite.yaml"))) {
      const s = v.suite;
      if (s.metadata.id !== id || s.metadata.version !== md.version) err("E_SUITE", "/metadata", `suite targets ${s.metadata.id}@${s.metadata.version}, expected ${id}@${md.version}`, "evals/suite.yaml");
      if (s.synthetic !== isSynthetic) err("E_SYNTHETIC", "/synthetic", isSynthetic ? "synthetic artifacts must ship a synthetic suite" : "synthetic suites are only allowed for synthetic artifacts", "evals/suite.yaml");
      if (isSynthetic) (s.datasets ?? []).forEach((ds) => { if (!ds.id.startsWith("dataset:synthetic-example/")) err("E_SYNTHETIC", "/datasets", `synthetic suites may only use dataset:synthetic-example/* (got ${ds.id})`, "evals/suite.yaml"); });
      const graders = new Set(s.graders.map((g) => g.id));
      if (graders.size !== s.graders.length) err("E_SUITE", "/graders", "duplicate grader ids", "evals/suite.yaml");
      const sc = new Set();
      s.scenarios.forEach((x, i) => {
        if (sc.has(x.id)) err("E_SUITE", `/scenarios/${i}`, `duplicate scenario id ${x.id}`, "evals/suite.yaml");
        sc.add(x.id);
        x.graders.forEach((g) => { if (!graders.has(g)) err("E_SUITE", `/scenarios/${i}/graders`, `unknown grader ${g}`, "evals/suite.yaml"); });
        if (inputValidator && !inputValidator(x.input)) err("E_SUITE", `/scenarios/${i}/input`, `input violates spec.contracts.input.schema: ${inputValidator.errors.map((e) => `${e.instancePath} ${e.message}`).join("; ")}`, "evals/suite.yaml");
      });
      const metrics = new Set(s.metrics.map((m) => m.id));
      for (const [gate, list] of Object.entries(s.gates)) for (const c of list) if (!metrics.has(c.metric)) err("E_SUITE", `/gates/${gate}`, `gate references unknown metric ${c.metric}`, "evals/suite.yaml");
      const parent = origin.evolution?.sourceRefs?.[0];
      if (s.baseline && parent && (s.baseline.ref.id !== parent.id || s.baseline.ref.version !== parent.version)) warn("W_SUITE", "/baseline", "baseline differs from origin.evolution.sourceRefs[0]", "evals/suite.yaml");
      if (parent && !s.baseline) warn("W_SUITE", "/baseline", "an evolved version should declare a baseline", "evals/suite.yaml");
    }
  } else if (bp.attestations.some((a) => a.type === "evaluation")) err("E_SUITE", "", "evaluation attestations require evals/suite.yaml", "evals/suite.yaml");

  // every passing evaluation attestation must actually meet the gate it claims
  bp.attestations.forEach((a, i) => {
    if (a.type !== "evaluation" || a.result !== "pass" || !v.suite?.gates?.[a.gate]) return;
    for (const c of v.suite.gates[a.gate]) {
      const val = a.metrics?.[c.metric];
      const ok = val !== undefined && ({ ">=": val >= c.value, ">": val > c.value, "<=": val <= c.value, "<": val < c.value, "==": val === c.value })[c.op];
      if (!ok) err("E_GATE", `/attestations/${i}`, `evaluation claims pass for gate ${a.gate} but ${c.metric} ${c.op} ${c.value} is not met (got ${val})`);
    }
  });

  // ---- evidence pointers ----
  if (v.refs) {
    for (const m of schemaErrors("refs", v.refs)) err("E_SCHEMA", "", m, "evidence/refs.yaml");
    if (!errors.some((e) => e.file === file("evidence/refs.yaml"))) {
      if (v.refs.metadata.id !== id || v.refs.metadata.version !== md.version) err("E_EVIDENCE", "/metadata", "evidence refs target a different artifact version", "evidence/refs.yaml");
      const seen = new Set();
      v.refs.refs.forEach((r) => {
        if (seen.has(r.id)) err("E_EVIDENCE", "/refs", `duplicate evidence id ${r.id}`, "evidence/refs.yaml");
        seen.add(r.id);
        if (r.synthetic !== synUri(r.uri)) err("E_SYNTHETIC", `/refs/${r.id}`, "synthetic flag and evidence://synthetic-example/ store must agree", "evidence/refs.yaml");
        if (r.synthetic !== isSynthetic) err("E_SYNTHETIC", `/refs/${r.id}`, isSynthetic ? "synthetic artifacts may only carry synthetic evidence refs" : "production artifacts cannot carry synthetic evidence", "evidence/refs.yaml");
        if (r.synthetic && !r.summary.startsWith("SYNTHETIC EXAMPLE")) err("E_SYNTHETIC", `/refs/${r.id}/summary`, 'synthetic summaries must start with "SYNTHETIC EXAMPLE"', "evidence/refs.yaml");
      });
    }
  }

  // ---- lifecycle overlay (append-only; independent of maturity and origin) ----
  let effective = "active";
  if (v.overlay) {
    for (const m of schemaErrors("lifecycle", v.overlay)) err("E_SCHEMA", "", m, "lifecycle.yaml");
    if (!errors.some((e) => e.file === file("lifecycle.yaml"))) {
      if (v.overlay.metadata.id !== id || v.overlay.metadata.version !== md.version) err("E_LIFECYCLE", "/metadata", "overlay targets a different artifact version", "lifecycle.yaml");
      let prev = null;
      for (const [i, e] of v.overlay.entries.entries()) {
        if (i === 0 && e.state !== "active") err("E_LIFECYCLE", "/entries/0", "the first overlay entry must be `active`", "lifecycle.yaml");
        if (prev && !LIFECYCLE_TRANSITIONS[prev].includes(e.state)) err("E_LIFECYCLE", `/entries/${i}`, `illegal lifecycle transition ${prev} -> ${e.state}`, "lifecycle.yaml");
        if (prev && new Date(e.at) < new Date(v.overlay.entries[i - 1].at)) err("E_LIFECYCLE", `/entries/${i}`, "overlay entries must be in chronological order", "lifecycle.yaml");
        prev = e.state;
      }
      effective = prev ?? "active";
    }
  }
  if (md.lifecycle !== effective) err("E_LIFECYCLE", "/metadata/lifecycle", `metadata.lifecycle is ${md.lifecycle} but the lifecycle overlay's effective state is ${effective}`);

  // ---- maturity ----
  if (md.maturity === "candidate") {
    if (v.release) err("E_RELEASE", "", "release record present on a candidate", "release.yaml");
  } else {
    if (!v.release) err("E_RELEASE", "", "canonical versions require a release record (npm run seal)", "release.yaml");
    else {
      for (const m of schemaErrors("release", v.release)) err("E_SCHEMA", "", m, "release.yaml");
      if (v.release.metadata?.id !== id || v.release.metadata?.version !== md.version) err("E_RELEASE", "/metadata", "release record identity mismatch", "release.yaml");
      if (v.release.digest !== digest) err("E_DIGEST", "/digest", `artifact changed after release (release ${v.release.digest}, computed ${digest})`, "release.yaml");
      if (v.suite && v.release.suiteDigest !== suiteDigest(v.suite)) err("E_DIGEST", "/suiteDigest", "evaluation suite changed after release", "release.yaml");
    }
    if (!v.suite) err("E_SUITE", "", "canonical versions require evals/suite.yaml", "evals/suite.yaml");
    if (!bp.attestations.some((a) => a.type === "evaluation" && a.gate === "canonical" && a.result === "pass" && a.subjectDigest === digest)) err("E_PROMOTION", "/attestations", "canonical requires a passing evaluation attestation for gate `canonical` bound to the current digest");
    if (!bp.security.approvals.some((a) => a.type === "security-review" && a.actor.type === "human" && a.subjectDigest === digest)) err("E_PROMOTION", "/security/approvals", "canonical requires a human security-review approval bound to the current digest");
    if (!bp.security.approvals.some((a) => a.type === "release-approval" && a.actor.type === "human" && a.subjectDigest === digest)) err("E_PROMOTION", "/security/approvals", "canonical requires a human release-approval bound to the current digest");
  }

  // ---- peer resolution (optional, offline-safe, local index files only) ----
  if (ctx.peers.length) {
    for (const r of bp.references) {
      const range = semver.validRange(r.version);
      const cand = ctx.peers.filter((p) => p.registry === r.registry && p.id === r.id && range && semver.satisfies(p.version, range, { includePrerelease: true }) && p.lifecycle !== "revoked");
      if (!cand.length) { (r.optional ? warn : err)("E_UNRESOLVED", `/references/${r.registry}/${r.id}`, `no non-revoked ${r.registry}/${r.id} satisfies ${r.version} in the supplied indexes`); continue; }
      if (md.maturity === "canonical" && !r.optional && !cand.some((p) => p.maturity === "canonical")) err("E_UNRESOLVED", `/references/${r.registry}/${r.id}`, "a canonical QB requires canonical dependencies");
      if (r.digest && !cand.some((p) => p.digest === r.digest)) err("E_DIGEST", `/references/${r.registry}/${r.id}`, "pinned digest matches no resolvable version");
    }
  }
}

/** Cross-version rules: candidate ordering, lineage, semver bumps, permission widening. */
export function validateLineage(all) {
  const ok = all.filter((v) => v.blueprint && !v.errors.some((e) => e.code === "E_SCHEMA"));
  const byKey = new Map(ok.map((v) => [`${v.blueprint.metadata.id}@${v.blueprint.metadata.version}`, v]));
  for (const v of ok) {
    const bp = v.blueprint, id = bp.metadata.id, ver = bp.metadata.version;
    const err = (code, where, message) => v.errors.push({ code, file: `${v.rel}/blueprint.yaml`, where, message });
    const warn = (code, where, message) => v.warnings.push({ code, file: `${v.rel}/blueprint.yaml`, where, message });
    if (bp.metadata.maturity === "candidate") {
      for (const o of ok) if (o !== v && o.blueprint.metadata.id === id && o.blueprint.metadata.maturity === "canonical" && semver.lte(ver, o.blueprint.metadata.version)) err("E_CANDIDATE_VERSION", "/metadata/version", `a candidate must exceed every canonical version of ${id}; ${o.blueprint.metadata.version} is canonical`);
    }
    const src = bp.metadata.origin.evolution?.sourceRefs?.[0];
    if (!src) continue;
    const parent = byKey.get(`${src.id}@${src.version}`);
    if (!parent) { err("E_PARENT", "/metadata/origin/evolution/sourceRefs", `source ${src.id}@${src.version} not found in this registry`); continue; }
    if (src.digest && src.digest !== parent.digest) err("E_DIGEST", "/metadata/origin/evolution/sourceRefs", "source digest does not match the source version's digest");
    const pv = parent.blueprint.metadata.version;
    if (!semver.gt(ver, pv)) { err("E_SEMVER", "/metadata/version", `version must be greater than source ${pv}`); continue; }
    const diff = semver.diff(pv, ver);
    const major = diff === "major" || diff === "premajor";
    const patchOnly = ["patch", "prepatch", "prerelease"].includes(diff);
    if (bp.spec.compatibility.breaking?.length && !major) err("E_SEMVER", "/spec/compatibility/breaking", "breaking changes declared but major version not bumped");
    if (canonicalize(bp.spec.contracts) !== canonicalize(parent.blueprint.spec.contracts)) {
      if (patchOnly) err("E_SEMVER", "/spec/contracts", "input/output contract changed: at least a minor bump is required");
      else if (!major) warn("W_SEMVER", "/spec/contracts", "contract changed in a minor bump: ensure it is backward compatible, otherwise bump major and list compatibility.breaking");
    }
    const widening = detectWidening(parent.blueprint, bp);
    if (widening.length) {
      widening.forEach((w) => warn("W_PERMISSION_WIDENING", "", `${w} (security review required)`));
      if (patchOnly) err("E_SEMVER", "/metadata/version", "permission/budget widening requires at least a minor bump");
    }
  }
}

export function detectWidening(a, b) {
  const out = [], A = a.spec, B = b.spec;
  const capMap = (s) => new Map(s.capabilities.allow.map((c) => [c.id, new Set(c.scopes)]));
  const ca = capMap(A);
  for (const [cid, scopes] of capMap(B)) {
    if (!ca.has(cid)) out.push(`new capability ${cid}`);
    else for (const s of scopes) if (!ca.get(cid).has(s)) out.push(`capability ${cid} gains scope ${s}`);
  }
  for (const k of ["maxCostUsd", "maxTokens", "maxToolCalls", "maxDelegations", "maxTinyAgents"]) {
    const x = A.budgets.perRun[k], y = B.budgets.perRun[k];
    if (y !== undefined && (x === undefined || y > x)) out.push(`budget ${k} raised`);
  }
  if (A.hitl.approvals.some((h) => !B.hitl.approvals.some((n) => n.when === h.when))) out.push("HITL approval removed");
  if (!A.swarm.enabled && B.swarm.enabled) out.push("swarm enabled");
  if (A.swarm.enabled && B.swarm.enabled && B.swarm.maxSize > A.swarm.maxSize) out.push("swarm maxSize raised");
  if (!A.delegation.tinyAgents.allowCompile && B.delegation.tinyAgents.allowCompile) out.push("Tiny Agent compilation enabled");
  for (const x of B.delegation.executionAgents.allow) if (!A.delegation.executionAgents.allow.includes(x)) out.push(`new execution agent ${x}`);
  if (classRank(B.jev.dataHandling?.maxClassification ?? "public") > classRank(A.jev.dataHandling?.maxClassification ?? "public")) out.push("Jev data classification ceiling raised");
  if (classRank(b.security.classification) > classRank(a.security.classification)) out.push("declared security classification raised");
  return out;
}

// ---------- top-level ----------
export function loadRegistries() {
  const cfg = readYaml(path.join(PKG_ROOT, "registries.yaml"));
  return new Set(Object.keys(cfg.registries));
}
export function loadPeerIndexes(files = []) {
  return files.flatMap((f) => { const idx = JSON.parse(fs.readFileSync(f, "utf8")); return idx.entries ?? idx; });
}

const RUNTIME_ARTIFACT_RE = /\.(jsonl|ndjson|tape|har)$/i;
const RUNTIME_DIR_RE = /^(tapes?|trajector(y|ies)|sessions|traces)$/i;
/** Repo-wide scan: raw runtime artifacts must never be committed. */
export function scanRuntimeArtifacts(root) {
  const out = [];
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if ([".git", "node_modules", "dist"].includes(d.name)) continue;
      const p = path.join(dir, d.name), rel = path.relative(root, p).split(path.sep).join("/");
      if (d.isDirectory()) { if (RUNTIME_DIR_RE.test(d.name)) out.push({ code: "E_RUNTIME_ARTIFACT", file: rel, message: "runtime tape/trajectory directories must not be committed" }); walk(p); }
      else if (RUNTIME_ARTIFACT_RE.test(d.name)) out.push({ code: "E_RUNTIME_ARTIFACT", file: rel, message: "runtime tape/trace files must not be committed; keep them in the evidence store" });
    }
  };
  walk(root);
  return out;
}

export function validateAll({ root = PKG_ROOT, peerIndexFiles = [] } = {}) {
  const ctx = { registries: loadRegistries(), peers: loadPeerIndexes(peerIndexFiles) };
  const all = loadRegistry(root);
  for (const v of all) validateVersion(v, ctx);
  validateLineage(all);
  const seen = new Map();
  for (const v of all) {
    if (!v.blueprint?.metadata) continue;
    const key = `${v.blueprint.metadata.id}@${v.blueprint.metadata.version}`;
    if (seen.has(key)) v.errors.push({ code: "E_DUP", file: `${v.rel}/blueprint.yaml`, where: "", message: `duplicate ${key} also at ${seen.get(key)}` });
    seen.set(key, v.rel);
  }
  const repoErrors = scanRuntimeArtifacts(root);
  return { versions: all, errors: [...all.flatMap((v) => v.errors), ...repoErrors], warnings: all.flatMap((v) => v.warnings) };
}

/** Deterministic derived index: a pure function of registry content (no timestamps, no commit ids). */
export function buildIndex(all, scope) {
  const entries = all.filter((v) => v.scope === scope && v.blueprint && v.digest && !v.errors.length).map((v) => {
    const bp = v.blueprint, md = bp.metadata;
    return {
      registry: REGISTRY, id: md.id, version: md.version, digest: v.digest, maturity: md.maturity, lifecycle: md.lifecycle,
      origin: md.origin.type, location: v.rel, synthetic: md.synthetic === true, sealed: md.maturity === "canonical",
      references: bp.references, compatibility: bp.spec.compatibility,
      ...(v.overlay?.entries?.at(-1)?.replacedBy ? { replacedBy: v.overlay.entries.at(-1).replacedBy } : {}),
    };
  }).sort((a, b) => a.id.localeCompare(b.id) || semver.compare(a.version, b.version));
  return { apiVersion: "registry.zeptly.dev/v1alpha1", kind: "RegistryIndex", registry: REGISTRY, scope, entries };
}

// ---------- resolution (declared range -> exact version -> digest -> lock) ----------
/** Resolve one declared reference against index entries. Never picks candidates or revoked versions. */
export function resolveRef(ref, entries) {
  const range = semver.validRange(ref.version);
  if (!range) throw new Error(`invalid range ${ref.version}`);
  const c = entries.filter((e) => e.registry === ref.registry && e.id === ref.id && e.maturity === "canonical" && e.lifecycle !== "revoked" && semver.satisfies(e.version, range));
  if (!c.length) return null;
  c.sort((a, b) => semver.rcompare(a.version, b.version));
  const hit = c[0];
  if (ref.digest && ref.digest !== hit.digest) throw new Error(`pinned digest for ${ref.registry}/${ref.id} does not match ${hit.version}`);
  return { registry: hit.registry, id: hit.id, version: hit.version, digest: hit.digest };
}
export function buildResolutionLock(root, references, entries) {
  const locks = references.map((declared) => {
    const resolved = resolveRef(declared, entries);
    if (!resolved) throw new Error(`cannot resolve ${declared.registry}/${declared.id}@${declared.version}`);
    return { declared: { registry: declared.registry, id: declared.id, version: declared.version, ...(declared.digest ? { digest: declared.digest } : {}) }, resolved };
  });
  return { apiVersion: "registry.zeptly.dev/v1alpha1", kind: "ResolutionLock", root, locks };
}

// ---------- immutability (git-diff based) ----------
const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
const gitShow = (root, ref, rel) => { try { return git(root, ["show", `${ref}:${rel}`]); } catch { return undefined; } };
const appendOnly = (before = [], after = []) => before.every((x, i) => after[i] !== undefined && canonicalize(after[i]) === canonicalize(x));

/**
 * Compare the working tree against `baseRef`. Canonical versions may only: append attestations, approvals, evidence refs and
 * lifecycle overlay entries. Content (digest scope), release record and suite are frozen; canonical versions cannot be deleted
 * or demoted. Overlays are append-only for every version.
 */
export function checkImmutability({ root = PKG_ROOT, baseRef }) {
  const errors = [];
  const roots = Object.values(SCOPES);
  const tree = roots.flatMap((r) => git(root, ["ls-tree", "-r", "--name-only", baseRef, "--", r]).split("\n").filter(Boolean));
  for (const rel of tree.filter((f) => /\/blueprint\.yaml$/.test(f))) {
    const dir = path.posix.dirname(rel);
    const err = (code, file, message) => errors.push({ code, file, message });
    const before = parseYaml(gitShow(root, baseRef, rel));
    const m0 = before?.metadata?.maturity;
    const headFile = path.join(root, rel);
    if (!fs.existsSync(headFile)) { if (m0 === "canonical") err("E_IMMUTABLE", rel, "canonical version cannot be deleted; revoke it via the lifecycle overlay"); continue; }
    const after = readYaml(headFile);
    if (m0 === "canonical" && after.metadata?.maturity !== "canonical") err("E_TRANSITION", rel, "a canonical version cannot return to candidate");
    if (m0 === "canonical") {
      if (artifactDigest(before) !== artifactDigest(after)) err("E_IMMUTABLE", rel, "canonical artifact content changed; publish a new version instead");
      if (!appendOnly(before.attestations, after.attestations)) err("E_IMMUTABLE", rel, "attestations are append-only on canonical versions");
      if (!appendOnly(before.security?.approvals, after.security?.approvals)) err("E_IMMUTABLE", rel, "security approvals are append-only on canonical versions");
      for (const f of tree.filter((t) => t.startsWith(dir + "/") && t !== rel)) {
        const name = f.slice(dir.length + 1);
        const head = path.join(root, f);
        if (!fs.existsSync(head)) { err("E_IMMUTABLE", f, "file of a canonical version was deleted"); continue; }
        const b = parseYaml(gitShow(root, baseRef, f)), h = readYaml(head);
        if (name === "evidence/refs.yaml") { if (!appendOnly(b?.refs, h?.refs)) err("E_IMMUTABLE", f, "evidence refs are append-only"); }
        else if (name === "lifecycle.yaml") { /* checked below for every version */ }
        else if (canonicalize(b) !== canonicalize(h)) err("E_IMMUTABLE", f, "file of a canonical version changed");
      }
    }
    // lifecycle overlay: append-only for every version, with legal transitions
    const ovRel = `${dir}/lifecycle.yaml`;
    if (tree.includes(ovRel)) {
      const b = parseYaml(gitShow(root, baseRef, ovRel))?.entries ?? [];
      const hf = path.join(root, ovRel);
      if (!fs.existsSync(hf)) err("E_IMMUTABLE", ovRel, "lifecycle overlay cannot be deleted");
      else if (!appendOnly(b, readYaml(hf)?.entries ?? [])) err("E_IMMUTABLE", ovRel, "lifecycle overlay is append-only; existing entries were changed or removed");
    }
  }
  return errors;
}
