// Core registry logic: loading, digests, schema + semantic validation, immutability checks.
// Pure data processing. No network access, no runtime behaviour.
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
export const SEALED = new Set(["canary", "stable", "deprecated", "retired"]);
export const STATUS_ORDER = ["draft", "candidate", "canary", "stable", "deprecated", "retired"];
export const TRANSITIONS = {
  draft: ["candidate"],
  candidate: ["draft", "canary"],
  canary: ["stable", "retired"],
  stable: ["deprecated"],
  deprecated: ["retired"],
  retired: [],
};

// ---------- helpers ----------
export function canonicalize(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}
export const sha256 = (s) => "sha256:" + crypto.createHash("sha256").update(s).digest("hex");

/** Digest of the sealed definition: everything except mutable `lifecycle`. */
export function blueprintDigest(bp) {
  const { lifecycle, ...rest } = bp; // eslint-disable-line no-unused-vars
  return sha256(canonicalize(rest));
}
export const suiteDigest = (suite) => sha256(canonicalize(suite));

export function parseYaml(text) {
  return YAML.parse(text, { schema: "core", uniqueKeys: true });
}
function readYaml(file) {
  return parseYaml(fs.readFileSync(file, "utf8"));
}

function walkStrings(node, cb, pathParts = []) {
  if (typeof node === "string") cb(node, pathParts);
  else if (Array.isArray(node)) node.forEach((v, i) => walkStrings(v, cb, [...pathParts, i]));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "$schema" || k === "$id") continue;
      walkStrings(v, cb, [...pathParts, k]);
    }
  }
}

// ---------- schemas ----------
let _ajv;
export function getAjv() {
  if (_ajv) return _ajv;
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
  addFormats(ajv);
  const dir = path.join(PKG_ROOT, "schemas");
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".schema.json"))) {
    ajv.addSchema(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
  }
  _ajv = ajv;
  return ajv;
}
const SCHEMA_IDS = {
  blueprint: "urn:zeptly:qb:schema:blueprint:v1",
  suite: "urn:zeptly:qb:schema:eval-suite:v1",
  refs: "urn:zeptly:qb:schema:evidence-refs:v1",
  release: "urn:zeptly:qb:schema:release:v1",
  index: "urn:zeptly:qb:schema:registry-index:v1",
  envelope: "urn:zeptly:qb:schema:evidence-envelope:v1",
};
export function schemaErrors(kind, data) {
  const validate = getAjv().getSchema(SCHEMA_IDS[kind]);
  if (validate(data)) return [];
  return validate.errors.map((e) => `${e.instancePath || "/"} ${e.message}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ""}`);
}

// ---------- loading ----------
/** Discover qbs/<slug>/<version>/blueprint.yaml under root. */
export function loadRegistry(root) {
  const base = path.join(root, "qbs");
  const versions = [];
  if (!fs.existsSync(base)) return versions;
  for (const slug of fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const ver of fs.readdirSync(path.join(base, slug.name), { withFileTypes: true }).filter((d) => d.isDirectory())) {
      const dir = path.join(base, slug.name, ver.name);
      const rel = path.relative(root, dir);
      const entry = { slug: slug.name, dirVersion: ver.name, dir, rel, errors: [], warnings: [] };
      const load = (name) => {
        const f = path.join(dir, name);
        if (!fs.existsSync(f)) return undefined;
        try { return readYaml(f); } catch (e) { entry.errors.push({ code: "E_YAML", file: `${rel}/${name}`, message: e.message }); return null; }
      };
      entry.blueprint = load("blueprint.yaml");
      entry.suite = load("evals/suite.yaml");
      entry.refs = load("evidence/refs.yaml");
      entry.release = load("release.yaml");
      versions.push(entry);
    }
  }
  return versions;
}

// ---------- semantic rules ----------
const URL_RE = /\bhttps?:\/\//i;
const INFRA_HOST_RE = /\b[a-z0-9.-]+\.(up\.railway\.app|railway\.internal|railway\.app|trigger\.dev|supabase\.(co|in))\b/i;
const SECRET_RES = [
  /\bsk-[A-Za-z0-9_-]{20,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*["']?[A-Za-z0-9/+_-]{12,}/i,
];
const MODEL_RE = /\b(claude-[a-z0-9.-]+|gpt-[a-z0-9.-]+|gemini-[a-z0-9.-]+|llama-?\d[a-z0-9.-]*|mistral-[a-z0-9.-]+)\b/i;
const REPO_RE = /\bZeptly\/registry-|\bregistry-(execution-agents|tiny-agents|skills|qb-agents)\b|\.\.\/|\bgithub\.com\//i;
const URL_ALLOWED = [["metadata", "links"], ["provenance", "sources"]];

function lintLiterals(bp, err) {
  walkStrings(bp, (s, p) => {
    const where = "/" + p.join("/");
    const inAllowed = URL_ALLOWED.some((a) => a.every((seg, i) => p[i] === seg));
    if (inAllowed) return;
    if (URL_RE.test(s) || INFRA_HOST_RE.test(s)) err("E_ENDPOINT", where, "URLs/hosts are forbidden in blueprints; reach services through abstract gateway contracts");
    if (SECRET_RES.some((r) => r.test(s))) err("E_SECRET", where, "value looks like a credential");
    if (REPO_RE.test(s)) err("E_REPO_COUPLING", where, "references must use stable IDs, not repository names or relative paths");
    if (p[0] !== "contracts" && p[0] !== "identity" && MODEL_RE.test(s)) err("E_MODEL_PIN", where, "concrete model identifiers are not allowed; use model tiers");
  });
}

const kindOf = (id) => id.split(":")[0];

export function validateVersion(v, ctx) {
  const { errors, warnings } = v;
  const bp = v.blueprint;
  const file = (n) => `${v.rel}/${n}`;
  const err = (code, where, message, f = "blueprint.yaml") => errors.push({ code, file: file(f), where, message });
  const warn = (code, where, message, f = "blueprint.yaml") => warnings.push({ code, file: file(f), where, message });

  if (bp === undefined) return err("E_MISSING", "", "blueprint.yaml is missing");
  if (bp === null) return;
  for (const m of schemaErrors("blueprint", bp)) err("E_SCHEMA", "", m);
  if (errors.some((e) => e.code === "E_SCHEMA")) return; // semantic checks assume shape

  // identity of the directory
  const slug = bp.id.slice(3);
  if (slug !== v.slug) err("E_PATH", "/id", `directory qbs/${v.slug} does not match id ${bp.id}`);
  if (bp.version !== v.dirVersion) err("E_PATH", "/version", `directory ${v.dirVersion} does not match version ${bp.version}`);

  lintLiterals(bp, (code, where, message) => err(code, where, message));

  // ---- dependencies ----
  const deps = new Map();
  for (const [i, d] of bp.dependencies.entries()) {
    if (deps.has(d.id)) err("E_DEP_DUP", `/dependencies/${i}`, `duplicate dependency ${d.id}`);
    deps.set(d.id, d);
    if (!semver.validRange(d.version)) err("E_RANGE", `/dependencies/${i}/version`, `invalid semver range "${d.version}"`);
    if (!ctx.kinds.has(kindOf(d.id))) err("E_KIND", `/dependencies/${i}/id`, `kind "${kindOf(d.id)}" is not declared in registries.yaml`);
    if (d.id === bp.id) err("E_DEP_SELF", `/dependencies/${i}`, "a QB cannot depend on itself");
  }
  const need = (id, where) => { if (!deps.has(id)) err("E_DEP_UNDECLARED", where, `${id} is used but not declared in dependencies`); };
  bp.delegation.executionAgents.allow.forEach((id, i) => {
    need(id, `/delegation/executionAgents/allow/${i}`);
    if (kindOf(id) !== "execution-agent") err("E_KIND", `/delegation/executionAgents/allow/${i}`, "expected an execution-agent ID");
  });
  (bp.delegation.tinyAgents.allowedTemplates ?? []).forEach((id, i) => { need(id, `/delegation/tinyAgents/allowedTemplates/${i}`); if (kindOf(id) !== "tiny-agent") err("E_KIND", `/delegation/tinyAgents/allowedTemplates/${i}`, "expected a tiny-agent ID"); });
  (bp.delegation.tinyAgents.allowedSkills ?? []).forEach((id, i) => { need(id, `/delegation/tinyAgents/allowedSkills/${i}`); if (kindOf(id) !== "skill") err("E_KIND", `/delegation/tinyAgents/allowedSkills/${i}`, "expected a skill ID"); });
  bp.capabilities.allow.forEach((c, i) => { need(c.id, `/capabilities/allow/${i}/id`); if (!["capability", "skill"].includes(kindOf(c.id))) err("E_KIND", `/capabilities/allow/${i}/id`, "expected a capability or skill ID"); });
  (bp.capabilities.deny ?? []).forEach((id, i) => need(id, `/capabilities/deny/${i}`)); // deny lists must be explicit about what they name
  Object.keys(bp.concurrency.perCapability ?? {}).forEach((id) => need(id, `/concurrency/perCapability/${id}`));
  bp.delegation.rules.forEach((r, i) => {
    if (r.target) need(r.target, `/delegation/rules/${i}/target`);
  });
  const allowedCaps = new Set(bp.capabilities.allow.map((c) => c.id));
  for (const id of bp.capabilities.deny ?? []) if (allowedCaps.has(id)) err("E_CAP_CONFLICT", "/capabilities", `${id} is both allowed and denied`);
  need(bp.jev.gateway.contract, "/jev/gateway/contract");
  need(bp.state.store, "/state/store");
  need(bp.evidence.sink, "/evidence/sink");

  // gateway contract consistency
  if (!semver.validRange(bp.jev.gateway.version)) err("E_RANGE", "/jev/gateway/version", `invalid semver range "${bp.jev.gateway.version}"`);
  if (!semver.validRange(bp.compatibility.runtime.version)) err("E_RANGE", "/compatibility/runtime/version", "invalid semver range");
  const declaredGw = new Map(bp.compatibility.gatewayContracts.map((g) => [g.id, g]));
  for (const g of bp.compatibility.gatewayContracts) if (!semver.validRange(g.version)) err("E_RANGE", "/compatibility/gatewayContracts", `invalid semver range "${g.version}"`);
  for (const [id, where] of [[bp.jev.gateway.contract, "/jev/gateway/contract"], [bp.state.store, "/state/store"], [bp.evidence.sink, "/evidence/sink"]]) {
    if (!declaredGw.has(id)) err("E_GATEWAY_COMPAT", where, `${id} must be listed in compatibility.gatewayContracts`);
  }
  if (bp.jev.gateway.contract.includes("jev") === false) warn("W_JEV_CONTRACT", "/jev/gateway/contract", "System-1 contract ID does not mention jev");

  // ---- internal consistency ----
  const o = bp.orchestration;
  if (!o.allowedStrategies.includes(o.defaultStrategy)) err("E_STRATEGY", "/orchestration/defaultStrategy", "default strategy must be in allowedStrategies");
  if (o.allowedStrategies.includes("swarm") && !bp.swarm.enabled) err("E_SWARM", "/orchestration/allowedStrategies", "swarm strategy allowed but swarm.enabled is false");
  if (bp.delegation.rules.some((r) => r.action === "swarm") && !bp.swarm.enabled) err("E_SWARM", "/delegation/rules", "a rule requests swarm but swarm.enabled is false");
  const ta = bp.delegation.tinyAgents;
  if (!ta.allowCompile && bp.delegation.rules.some((r) => r.action === "compile-tiny-agent")) err("E_TINY", "/delegation/rules", "a rule compiles Tiny Agents but tinyAgents.allowCompile is false");
  if (!ta.allowCompile && bp.delegation.fallback === "compile-tiny-agent") err("E_TINY", "/delegation/fallback", "fallback compiles Tiny Agents but allowCompile is false");
  bp.delegation.rules.forEach((r, i) => {
    if (r.action === "delegate-execution-agent") {
      if (!r.target) err("E_RULE_TARGET", `/delegation/rules/${i}`, "delegate-execution-agent rules need a target");
      else if (!bp.delegation.executionAgents.allow.includes(r.target)) err("E_RULE_TARGET", `/delegation/rules/${i}/target`, `${r.target} is not in executionAgents.allow`);
    }
  });
  const perRun = bp.budgets.perRun;
  if (perRun.maxTinyAgents !== undefined && ta.maxPerRun > perRun.maxTinyAgents) err("E_BUDGET", "/delegation/tinyAgents/maxPerRun", "exceeds budgets.perRun.maxTinyAgents");
  if (perRun.maxTinyAgents !== undefined && bp.concurrency.maxParallelTinyAgents > perRun.maxTinyAgents) warn("W_BUDGET", "/concurrency/maxParallelTinyAgents", "exceeds budgets.perRun.maxTinyAgents (never reachable)");
  if (bp.swarm.enabled && bp.swarm.maxSize > ta.maxPerRun && ta.allowCompile) err("E_BUDGET", "/swarm/maxSize", "swarm size exceeds tinyAgents.maxPerRun");
  if (bp.swarm.enabled && perRun.maxTinyAgents !== undefined && bp.swarm.maxSize > perRun.maxTinyAgents) err("E_BUDGET", "/swarm/maxSize", "swarm size exceeds budgets.perRun.maxTinyAgents");
  if (bp.swarm.enabled && bp.swarm.requiresHitlAbove !== undefined && !bp.hitl.approvals.some((a) => a.when === "swarm-above-threshold")) err("E_HITL", "/swarm/requiresHitlAbove", "needs a hitl approval with when: swarm-above-threshold");
  if (bp.replanning.triggers.includes("budget-pressure") && bp.budgets.softLimitRatio === undefined) err("E_BUDGET", "/budgets/softLimitRatio", "budget-pressure trigger requires softLimitRatio");
  if (bp.checkpointing.granularity && bp.checkpointing.triggers.includes("before-hitl") === false && bp.hitl.approvals.length) warn("W_CHECKPOINT", "/checkpointing/triggers", "HITL approvals exist but checkpointing lacks before-hitl");
  if (bp.context.handoff.maxContextTokens > bp.context.maxWorkingTokens) warn("W_CONTEXT", "/context/handoff/maxContextTokens", "handoff limit exceeds working context");

  // Jev consistency
  const jevOp = (op) => bp.jev.operations.find((x) => x.op === op)?.mode ?? "disabled";
  if (bp.planning.review.systemOneCritique && jevOp("critique") === "disabled") err("E_JEV", "/planning/review/systemOneCritique", "requires jev operation `critique` to be enabled");
  const evals = [...(bp.evaluation.intermediate.evaluators ?? []), ...bp.evaluation.final.evaluators];
  if (evals.some((e) => e.kind === "system-one") && jevOp("evaluate") === "disabled") err("E_JEV", "/evaluation", "system-one evaluators require jev operation `evaluate`");
  if (bp.delegation.executionAgents.selection === "system-one-routed" && jevOp("route") === "disabled") err("E_JEV", "/delegation/executionAgents/selection", "system-one-routed requires jev operation `route`");
  if (bp.jev.onUnavailable === "degrade-to-local-heuristics" && bp.jev.operations.some((x) => x.mode === "required")) warn("W_JEV", "/jev/onUnavailable", "required operations degrade to local heuristics when Jev is unavailable; confirm this is intended");
  if (new Set(bp.jev.operations.map((x) => x.op)).size !== bp.jev.operations.length) err("E_JEV", "/jev/operations", "duplicate operation entries");

  // Safety invariants
  const hitlHas = (w) => bp.hitl.approvals.some((a) => a.when === w);
  bp.capabilities.allow.forEach((c, i) => {
    if (c.scopes.includes("external-send") && !c.requiresHitl && !hitlHas("external-send")) err("E_HITL", `/capabilities/allow/${i}`, "external-send scope requires requiresHitl or a hitl approval with when: external-send");
  });
  if (bp.purpose.taskClasses.some((t) => ["high", "critical"].includes(t.risk)) && bp.planning.review.humanApproval === "never" && !hitlHas("risk-at-least-high")) err("E_HITL", "/planning/review/humanApproval", "high-risk task classes need human approval (planning.review.humanApproval or hitl risk-at-least-high)");
  if (bp.checkpointing.rollback?.allowed && bp.checkpointing.rollback.sideEffects === "ignore") warn("W_ROLLBACK", "/checkpointing/rollback/sideEffects", "rollback ignoring side effects is unsafe for write capabilities");

  // provenance
  if (!bp.provenance.authors.some((a) => a.type === "human")) err("E_PROVENANCE", "/provenance/authors", "at least one human author/approver is required (a QB never authors its own canonical definition)");
  if (bp.provenance.origin === "wisdom-of-compute" && bp.provenance.parent && bp.provenance.parent.slice(0, bp.provenance.parent.indexOf("@")) !== bp.id) err("E_PARENT", "/provenance/parent", "parent must be a version of the same QB");

  // IO contracts must be valid JSON Schema and scenario inputs must satisfy them
  let inputValidator;
  try {
    inputValidator = new Ajv2020({ strict: false, allErrors: true }).compile(bp.contracts.input.schema);
    new Ajv2020({ strict: false }).compile(bp.contracts.output.schema);
  } catch (e) { err("E_IO_SCHEMA", "/contracts", `invalid JSON Schema: ${e.message}`); }

  // ---- synthetic / example data hygiene ----
  const isExample = bp.metadata.labels?.example === "true";
  const SYN_STORE = "evidence://synthetic-example/";
  const synUris = [...(bp.provenance.derivedFrom?.evidenceRefs ?? []), ...(bp.provenance.derivedFrom?.evalRuns ?? [])];
  if (isExample) {
    if (bp.metadata.labels.synthetic !== "true") err("E_SYNTHETIC", "/metadata/labels", 'example blueprints must carry labels.synthetic: "true"');
    if (!bp.metadata.name.startsWith("[EXAMPLE]")) err("E_SYNTHETIC", "/metadata/name", 'example blueprint names must start with "[EXAMPLE]"');
    synUris.forEach((u) => { if (!u.startsWith(SYN_STORE)) err("E_SYNTHETIC", "/provenance/derivedFrom", `example blueprint references non-synthetic evidence ${u}`); });
  } else {
    synUris.forEach((u) => { if (u.startsWith(SYN_STORE)) err("E_SYNTHETIC", "/provenance/derivedFrom", "real blueprint references synthetic evidence"); });
  }
  if (v.suite && typeof v.suite.synthetic === "boolean" && v.suite.synthetic !== isExample) err("E_SYNTHETIC", "/synthetic", isExample ? "example blueprints must ship a synthetic suite (synthetic: true)" : "synthetic suites are only allowed for example blueprints", "evals/suite.yaml");
  if (v.suite && isExample) (v.suite.datasets ?? []).forEach((ds) => { if (!ds.id.startsWith("dataset:synthetic-example/")) err("E_SYNTHETIC", "/datasets", `example suites may only use dataset:synthetic-example/* (got ${ds.id})`, "evals/suite.yaml"); });
  (v.refs?.refs ?? []).forEach((r) => {
    const inSynStore = r.uri.startsWith(SYN_STORE);
    if (typeof r.synthetic === "boolean" && (r.synthetic !== inSynStore)) err("E_SYNTHETIC", `/refs/${r.id}`, "synthetic flag and evidence://synthetic-example/ store must agree", "evidence/refs.yaml");
    if (r.synthetic === true && !isExample) err("E_SYNTHETIC", `/refs/${r.id}`, "synthetic evidence is only allowed for example blueprints", "evidence/refs.yaml");
    if (isExample && r.synthetic !== true) err("E_SYNTHETIC", `/refs/${r.id}`, "example blueprints may only carry synthetic evidence refs", "evidence/refs.yaml");
    if (r.synthetic === true && !r.summary.startsWith("SYNTHETIC EXAMPLE")) err("E_SYNTHETIC", `/refs/${r.id}/summary`, 'synthetic evidence summaries must start with "SYNTHETIC EXAMPLE"', "evidence/refs.yaml");
  });

  // ---- lifecycle artifacts ----
  const status = bp.lifecycle.status;
  const sealed = SEALED.has(status);
  const atLeastCandidate = STATUS_ORDER.indexOf(status) >= 1;
  if (bp.lifecycle.deprecation && status !== "deprecated" && status !== "retired") err("E_LIFECYCLE", "/lifecycle/deprecation", "deprecation block only valid for deprecated/retired");
  if ((status === "deprecated" || status === "retired") && !bp.lifecycle.deprecation) err("E_LIFECYCLE", "/lifecycle", "deprecated/retired versions need a deprecation block");

  if (atLeastCandidate) {
    if (!v.suite) err("E_SUITE", "", "candidate and later require evals/suite.yaml", "evals/suite.yaml");
  }
  if (v.suite) {
    for (const m of schemaErrors("suite", v.suite)) err("E_SCHEMA", "", m, "evals/suite.yaml");
    if (!errors.some((e) => e.file === file("evals/suite.yaml"))) {
      const s = v.suite;
      if (s.for !== `${bp.id}@${bp.version}`) err("E_SUITE", "/for", `suite targets ${s.for}, expected ${bp.id}@${bp.version}`, "evals/suite.yaml");
      const graders = new Set(s.graders.map((g) => g.id));
      if (graders.size !== s.graders.length) err("E_SUITE", "/graders", "duplicate grader ids", "evals/suite.yaml");
      const sc = new Set();
      s.scenarios.forEach((x, i) => {
        if (sc.has(x.id)) err("E_SUITE", `/scenarios/${i}`, `duplicate scenario id ${x.id}`, "evals/suite.yaml");
        sc.add(x.id);
        x.graders.forEach((g) => { if (!graders.has(g)) err("E_SUITE", `/scenarios/${i}/graders`, `unknown grader ${g}`, "evals/suite.yaml"); });
        if (inputValidator && !inputValidator(x.input)) err("E_SUITE", `/scenarios/${i}/input`, `input violates contracts.input.schema: ${inputValidator.errors.map((e) => `${e.instancePath} ${e.message}`).join("; ")}`, "evals/suite.yaml");
      });
      const metrics = new Set(s.metrics.map((m) => m.id));
      for (const [gate, list] of Object.entries(s.gates)) for (const c of list) if (!metrics.has(c.metric)) err("E_SUITE", `/gates/${gate}`, `gate references unknown metric ${c.metric}`, "evals/suite.yaml");
      if (s.baseline && bp.provenance.parent && s.baseline.ref !== bp.provenance.parent) warn("W_SUITE", "/baseline", "baseline differs from provenance.parent", "evals/suite.yaml");
      if (bp.provenance.parent && !s.baseline) warn("W_SUITE", "/baseline", "a version with a parent should declare a baseline", "evals/suite.yaml");
    }
  }

  if (v.refs) {
    for (const m of schemaErrors("refs", v.refs)) err("E_SCHEMA", "", m, "evidence/refs.yaml");
    if (!errors.some((e) => e.file === file("evidence/refs.yaml"))) {
      if (v.refs.for !== `${bp.id}@${bp.version}`) err("E_EVIDENCE", "/for", `refs target ${v.refs.for}`, "evidence/refs.yaml");
      const ids = new Set();
      for (const r of v.refs.refs) { if (ids.has(r.id)) err("E_EVIDENCE", "/refs", `duplicate evidence id ${r.id}`, "evidence/refs.yaml"); ids.add(r.id); }
    }
  }

  const digest = blueprintDigest(bp);
  v.digest = digest;
  if (!sealed && v.release) err("E_RELEASE", "", "release.yaml present on an unsealed version (draft/candidate)", "release.yaml");
  if (sealed) {
    if (!v.release) err("E_RELEASE", "", `${status} versions must be sealed (run npm run seal)`, "release.yaml");
    else {
      for (const m of schemaErrors("release", v.release)) err("E_SCHEMA", "", m, "release.yaml");
      if (v.release.id !== `${bp.id}@${bp.version}`) err("E_RELEASE", "/id", "release id mismatch", "release.yaml");
      if (v.release.blueprintDigest !== digest) err("E_DIGEST", "/blueprintDigest", `blueprint changed after sealing (expected ${v.release.blueprintDigest}, got ${digest})`, "release.yaml");
      if (v.suite && v.release.suiteDigest !== suiteDigest(v.suite)) err("E_DIGEST", "/suiteDigest", "evaluation suite changed after sealing", "release.yaml");
    }
    // promotion evidence: a passing eval-run for the exact digest that meets the gate for the status
    const gateFor = status === "stable" ? "stable" : "canary";
    const passing = (v.refs?.refs ?? []).filter((r) => r.type === "eval-run" && r.result === "pass" && r.blueprintDigest === digest);
    if (status === "canary" || status === "stable") {
      const required = status === "canary" ? ["canary"] : ["canary", "stable"];
      for (const g of required) {
        if (!passing.some((r) => r.gate === g)) err("E_PROMOTION", "", `no passing eval-run for gate "${g}" against digest ${digest}`, "evidence/refs.yaml");
      }
      const run = passing.find((r) => r.gate === gateFor);
      if (run) for (const c of v.suite?.gates?.[gateFor] ?? []) {
        const val = run.metrics?.[c.metric];
        const ok = val !== undefined && ({ ">=": val >= c.value, ">": val > c.value, "<=": val <= c.value, "<": val < c.value, "==": val === c.value })[c.op];
        if (!ok) err("E_GATE", "", `eval-run "${run.id}" fails gate ${gateFor}: ${c.metric} ${c.op} ${c.value} (got ${val})`, "evidence/refs.yaml");
      }
    }
  }

  // ---- peer registry resolution (optional, offline-safe) ----
  for (const d of bp.dependencies) {
    const peers = ctx.peers.filter((p) => p.id === d.id);
    if (!ctx.peers.length) continue;
    const range = semver.validRange(d.version);
    const matches = range ? peers.filter((p) => semver.satisfies(p.version, range, { includePrerelease: true }) && p.status !== "retired") : [];
    if (!matches.length) { (d.optional ? warn : err)("E_UNRESOLVED", `/dependencies/${d.id}`, `no non-retired ${d.id} satisfies ${d.version} in peer indexes`); continue; }
    if (status === "stable" && !d.optional && !matches.some((p) => p.status === "stable")) err("E_UNRESOLVED", `/dependencies/${d.id}`, `stable QB requires a stable ${d.id} satisfying ${d.version}`);
    if (d.digest && !matches.some((p) => p.digest === d.digest)) err("E_DIGEST", `/dependencies/${d.id}`, "pinned digest matches no resolvable version");
  }
}

/** Cross-version rules: parent linkage, semver bumps, permission widening. */
export function validateLineage(all) {
  const byKey = new Map(all.filter((v) => v.blueprint && !v.errors.some((e) => e.code === "E_SCHEMA")).map((v) => [`${v.blueprint.id}@${v.blueprint.version}`, v]));
  for (const v of byKey.values()) {
    const bp = v.blueprint;
    const err = (code, where, message) => v.errors.push({ code, file: `${v.rel}/blueprint.yaml`, where, message });
    const warn = (code, where, message) => v.warnings.push({ code, file: `${v.rel}/blueprint.yaml`, where, message });
    const parentRef = bp.provenance.parent;
    const siblings = all.filter((x) => x.blueprint?.id === bp.id && x !== v);
    if (!parentRef) {
      if (siblings.length && semver.valid(bp.version) && siblings.some((s) => semver.lt(s.blueprint.version, bp.version))) warn("W_LINEAGE", "/provenance/parent", "later version without provenance.parent");
      continue;
    }
    const parent = byKey.get(parentRef);
    if (!parent) { err("E_PARENT", "/provenance/parent", `parent ${parentRef} not found in this registry`); continue; }
    const pv = parent.blueprint.version;
    if (!semver.gt(bp.version, pv)) { err("E_SEMVER", "/version", `version must be greater than parent ${pv}`); continue; }
    const diff = semver.diff(pv, bp.version);
    const major = diff === "major" || diff === "premajor";
    const patchOnly = ["patch", "prepatch", "prerelease"].includes(diff);
    if (bp.compatibility.breaking?.length && !major) err("E_SEMVER", "/compatibility/breaking", "breaking changes declared but major version not bumped");
    if (canonicalize(bp.contracts) !== canonicalize(parent.blueprint.contracts)) {
      if (patchOnly) err("E_SEMVER", "/contracts", "input/output contract changed: at least a minor bump is required");
      else if (!major) warn("W_SEMVER", "/contracts", "contract changed in a minor bump: ensure it is backward compatible, otherwise bump major and list compatibility.breaking");
    }
    const widening = detectWidening(parent.blueprint, bp);
    if (widening.length) {
      widening.forEach((w) => warn("W_PERMISSION_WIDENING", "", `${w} (security review required)`));
      if (patchOnly) err("E_SEMVER", "/version", "permission/budget widening requires at least a minor bump");
    }
  }
}

export function detectWidening(a, b) {
  const out = [];
  const capMap = (bp) => new Map(bp.capabilities.allow.map((c) => [c.id, new Set(c.scopes)]));
  const ca = capMap(a);
  for (const [id, scopes] of capMap(b)) {
    if (!ca.has(id)) out.push(`new capability ${id}`);
    else for (const s of scopes) if (!ca.get(id).has(s)) out.push(`capability ${id} gains scope ${s}`);
  }
  for (const k of ["maxCostUsd", "maxTokens", "maxToolCalls", "maxDelegations", "maxTinyAgents"]) {
    const x = a.budgets.perRun[k], y = b.budgets.perRun[k];
    if (y !== undefined && (x === undefined || y > x)) out.push(`budget ${k} raised`);
  }
  if (a.hitl.approvals.some((h) => !b.hitl.approvals.some((n) => n.when === h.when))) out.push("HITL approval removed");
  if (!a.swarm.enabled && b.swarm.enabled) out.push("swarm enabled");
  if (a.swarm.enabled && b.swarm.enabled && b.swarm.maxSize > a.swarm.maxSize) out.push("swarm maxSize raised");
  if (!a.delegation.tinyAgents.allowCompile && b.delegation.tinyAgents.allowCompile) out.push("Tiny Agent compilation enabled");
  for (const id of b.delegation.executionAgents.allow) if (!a.delegation.executionAgents.allow.includes(id)) out.push(`new execution agent ${id}`);
  const rank = ["public", "internal", "confidential", "restricted"];
  const ra = rank.indexOf(a.jev.dataHandling?.maxClassification ?? "public"), rb = rank.indexOf(b.jev.dataHandling?.maxClassification ?? "public");
  if (rb > ra) out.push("Jev data classification ceiling raised");
  return out;
}

// ---------- top-level ----------
export function loadRegistriesConfig() {
  const cfg = readYaml(path.join(PKG_ROOT, "registries.yaml"));
  return new Set(Object.keys(cfg.kinds));
}

export function loadPeerIndexes(files = []) {
  return files.flatMap((f) => {
    const idx = JSON.parse(fs.readFileSync(f, "utf8"));
    return idx.entries ?? idx;
  });
}

export function validateAll({ root = PKG_ROOT, peerIndexFiles = [] } = {}) {
  const ctx = { kinds: loadRegistriesConfig(), peers: loadPeerIndexes(peerIndexFiles) };
  const all = loadRegistry(root);
  for (const v of all) validateVersion(v, ctx);
  validateLineage(all);
  const seen = new Map();
  for (const v of all) {
    if (!v.blueprint) continue;
    const key = `${v.blueprint.id}@${v.blueprint.version}`;
    if (seen.has(key)) v.errors.push({ code: "E_DUP", file: `${v.rel}/blueprint.yaml`, where: "", message: `duplicate ${key} also at ${seen.get(key)}` });
    seen.set(key, v.rel);
  }
  return {
    versions: all,
    errors: all.flatMap((v) => v.errors),
    warnings: all.flatMap((v) => v.warnings),
  };
}

export function buildIndex(all, commit = "unknown") {
  const entries = all.filter((v) => v.blueprint && v.digest && !v.errors.length).map((v) => {
    const bp = v.blueprint;
    return {
      id: bp.id, version: bp.version, status: bp.lifecycle.status, digest: v.digest, path: v.rel, sealed: SEALED.has(bp.lifecycle.status),
      synthetic: bp.metadata.labels?.example === "true",
      dependencies: bp.dependencies, compatibility: bp.compatibility,
      ...(bp.lifecycle.deprecation?.replacedBy ? { replacedBy: bp.lifecycle.deprecation.replacedBy } : {}),
    };
  }).sort((a, b) => a.id.localeCompare(b.id) || semver.compare(a.version, b.version));
  return { apiVersion: "qb.zeptly.dev/v1", kind: "RegistryIndex", registry: "qb-agents", commit, entries };
}

// ---------- immutability (git-diff based) ----------
const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
function gitShow(root, ref, rel) {
  try { return git(root, ["show", `${ref}:${rel}`]); } catch { return undefined; }
}

/**
 * Compare HEAD working tree against `baseRef`. Sealed versions may only change `lifecycle`
 * (along an allowed transition) and append evidence refs; they may never be deleted.
 */
export function checkImmutability({ root = PKG_ROOT, baseRef }) {
  const errors = [];
  const tree = git(root, ["ls-tree", "-r", "--name-only", baseRef, "qbs"]).split("\n").filter(Boolean);
  const baseBlueprints = tree.filter((f) => /^qbs\/[^/]+\/[^/]+\/blueprint\.yaml$/.test(f));
  for (const rel of baseBlueprints) {
    const dir = path.posix.dirname(rel);
    const before = parseYaml(gitShow(root, baseRef, rel));
    const status0 = before?.lifecycle?.status;
    const headFile = path.join(root, rel);
    const err = (code, file, message) => errors.push({ code, file, message });
    if (!fs.existsSync(headFile)) {
      if (SEALED.has(status0)) err("E_IMMUTABLE", rel, `sealed version (${status0}) cannot be deleted; retire it instead`);
      continue;
    }
    const after = readYaml(headFile);
    const status1 = after.lifecycle?.status;
    if (status0 !== status1) {
      if (!TRANSITIONS[status0]?.includes(status1)) err("E_TRANSITION", rel, `illegal status transition ${status0} -> ${status1} (allowed: ${TRANSITIONS[status0]?.join(", ") || "none"})`);
    }
    if (!SEALED.has(status0)) continue; // unsealed versions may change freely (including becoming sealed)
    if (blueprintDigest(before) !== blueprintDigest(after)) err("E_IMMUTABLE", rel, "sealed blueprint content changed; publish a new version instead");
    for (const f of tree.filter((t) => t.startsWith(dir + "/") && t !== rel)) {
      const name = f.slice(dir.length + 1);
      const head = path.join(root, f);
      if (!fs.existsSync(head)) { err("E_IMMUTABLE", f, "file of a sealed version was deleted"); continue; }
      const b = gitShow(root, baseRef, f);
      const h = fs.readFileSync(head, "utf8");
      if (name === "evidence/refs.yaml") {
        const oldRefs = parseYaml(b)?.refs ?? [], newRefs = parseYaml(h)?.refs ?? [];
        for (const r of oldRefs) {
          const n = newRefs.find((x) => x.id === r.id);
          if (!n || canonicalize(n) !== canonicalize(r)) err("E_IMMUTABLE", f, `evidence ref "${r.id}" was modified or removed (evidence is append-only)`);
        }
      } else if (parseYaml(b) !== undefined && canonicalize(parseYaml(b)) !== canonicalize(parseYaml(h))) {
        err("E_IMMUTABLE", f, "file of a sealed version changed");
      }
    }
  }
  return errors;
}
