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
export const SCOPE_ROOT_FILES = new Set(["README.md"]);
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_VERSION_BYTES = 1024 * 1024;
/** First id segment must not be a registry/kind word: the `registry` field carries that, ids stay prefix-free. */
export const RESERVED_ID_PREFIXES = new Set(["skills", "skill", "tiny-agents", "tiny-agent", "tiny", "execution-agents", "execution-agent", "execution", "qb-agents", "qb-agent", "qb", "registry"]);
const CLASSIFICATION_ORDER = ["public", "internal", "confidential", "restricted"];

// ---------- helpers ----------
/**
 * Deterministic code-point comparator (no locale, no UTF-16 code-unit ordering). Compares Unicode scalar values, which is
 * also the byte order of UTF-8.
 */
export function compareCodePoints(a, b) {
  const x = Array.from(a), y = Array.from(b), n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}
const toLF = (s) => s.replace(/\r\n?/g, "\n");
const ptr = (p) => (p.length ? "/" + p.map((x) => String(x).replace(/~/g, "~0").replace(/\//g, "~1")).join("/") : "");

/** Controlled rejection of data that cannot be canonicalised or hashed. `diagnostics` = [{code, path, message}] (path = JSON pointer). */
export class DataRejectedError extends TypeError {
  constructor(diagnostics) {
    super(`invalid data: ${diagnostics.slice(0, 3).map((d) => `${d.path || "/"} ${d.message}`).join("; ")}${diagnostics.length > 3 ? ` (+${diagnostics.length - 3} more)` : ""}`);
    this.name = "DataRejectedError";
    this.diagnostics = diagnostics;
  }
}
const MAX_DATA_DEPTH = 128;
const bad = (p, message, code = "E_DATA_TYPE") => ({ code, path: ptr(p), message });
const typeLabel = (v) => (v === undefined ? "undefined" : typeof v !== "object" ? typeof v : (v.constructor?.name ?? "object"));
/**
 * Validates that a parsed value is supported JSON data BEFORE it is cloned or hashed: null, boolean, string, finite number,
 * array (no holes), plain object. NaN, Infinity, undefined, bigint, symbols, functions, Date/Map/Set/Buffer/class instances and
 * excessive nesting (or cycles) are reported with their JSON-pointer path. Never converts or drops anything.
 */
export function findInvalidData(value, p = [], out = [], depth = 0) {
  if (depth > MAX_DATA_DEPTH) { out.push(bad(p, `nesting deeper than ${MAX_DATA_DEPTH} levels (or a reference cycle)`)); return out; }
  if (value === null) return out;
  switch (typeof value) {
    case "string": case "boolean": return out;
    case "number":
      if (!Number.isFinite(value)) out.push(bad(p, `non-finite number (${String(value)}) is not supported`));
      return out;
    case "object": {
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) { if (!(i in value)) out.push(bad([...p, i], "array hole is not supported")); else findInvalidData(value[i], [...p, i], out, depth + 1); }
        return out;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) { out.push(bad(p, `unsupported value of type ${typeLabel(value)}`)); return out; }
      for (const k of Object.keys(value)) findInvalidData(value[k], [...p, k], out, depth + 1);
      return out;
    }
    default: out.push(bad(p, `unsupported value of type ${typeLabel(value)}`)); return out;
  }
}
const copyData = (v) => {
  if (Array.isArray(v)) return v.map(copyData);
  if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v)) Object.defineProperty(o, k, { value: copyData(v[k]), enumerable: true, writable: true, configurable: true }); return o; }
  return v;
};
/** Validating deep clone (replaces JSON.parse(JSON.stringify(x)), which silently turns Infinity into null and mangles non-JSON values). */
export function cloneCanonicalData(value) {
  const invalid = findInvalidData(value);
  if (invalid.length) throw new DataRejectedError(invalid);
  return copyData(value);
}

/**
 * Canonical JSON (see docs/canonicalization.md): UTF-8, no insignificant whitespace, object keys sorted by code point,
 * array order preserved, numbers via ECMAScript Number-to-String (finite only), string values and keys normalised to LF line
 * endings. Anything that is not supported JSON data throws DataRejectedError (a TypeError) naming the offending path.
 */
export function canonicalize(v) { return ser(v, [], 0); }
function ser(v, p, depth) {
  if (depth > MAX_DATA_DEPTH) throw new DataRejectedError([bad(p, `nesting deeper than ${MAX_DATA_DEPTH} levels (or a reference cycle)`)]);
  if (v === null) return "null";
  switch (typeof v) {
    case "string": return JSON.stringify(toLF(v));
    case "boolean": return v ? "true" : "false";
    case "number":
      if (!Number.isFinite(v)) throw new DataRejectedError([bad(p, `non-finite number (${String(v)}) is not supported`)]);
      return JSON.stringify(v);
    case "object": {
      if (Array.isArray(v)) {
        const parts = [];
        for (let i = 0; i < v.length; i++) { if (!(i in v)) throw new DataRejectedError([bad([...p, i], "array hole is not supported")]); parts.push(ser(v[i], [...p, i], depth + 1)); }
        return `[${parts.join(",")}]`;
      }
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new DataRejectedError([bad(p, `unsupported value of type ${typeLabel(v)}`)]);
      const keys = Object.keys(v).map((k) => [toLF(k), k]).sort((x, y) => compareCodePoints(x[0], y[0]));
      for (let i = 1; i < keys.length; i++) if (keys[i][0] === keys[i - 1][0]) throw new DataRejectedError([bad(p, "duplicate key after line-ending normalisation")]);
      return `{${keys.map(([nk, k]) => `${JSON.stringify(nk)}:${ser(v[k], [...p, k], depth + 1)}`).join(",")}}`;
    }
    default: throw new DataRejectedError([bad(p, `unsupported value of type ${typeLabel(v)}`)]);
  }
}
export const sha256 = (s) => "sha256:" + crypto.createHash("sha256").update(s, "utf8").digest("hex");

/**
 * Artifact digest: sha256 of canonical JSON of the artifact EXCLUDING metadata.version, metadata.maturity, metadata.lifecycle,
 * security.approvals and attestations. Included: kind/apiVersion, identity (metadata.id/registry/origin/...), spec,
 * references, provenance and security classification/capabilities. Attestations and approvals bind to this digest, so they
 * cannot be inside it; the version is bound by the directory seal and the index entry instead. Throws DataRejectedError for
 * unsupported data (NaN/Infinity/non-JSON values) instead of coercing it.
 */
export function artifactDigest(bp) {
  const c = cloneCanonicalData(bp); // validates supported types first; never coerces (no JSON round trip)
  if (c.metadata) { delete c.metadata.version; delete c.metadata.maturity; delete c.metadata.lifecycle; }
  if (c.security) delete c.security.approvals;
  delete c.attestations;
  return sha256(canonicalize(c));
}
export const suiteDigest = (suite) => sha256(canonicalize(suite));

/**
 * Directory seal over the canonical PAYLOAD files (blueprint.yaml via the artifact digest, evals/suite.yaml via its canonical
 * digest). Sidecars that legitimately change after release (release.yaml, lifecycle.yaml, evidence/refs.yaml) are not payload.
 * The seal binds registry, id and version, so identical content under two versions seals differently.
 */
export function directorySeal(bp, suite) {
  const payload = [{ path: "blueprint.yaml", digest: artifactDigest(bp) }];
  if (suite) payload.push({ path: "evals/suite.yaml", digest: suiteDigest(suite) });
  payload.sort((a, b) => compareCodePoints(a.path, b.path));
  const seal = sha256(canonicalize({ registry: bp.metadata.registry, id: bp.metadata.id, version: bp.metadata.version, payload }));
  return { payload, seal };
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
/**
 * True when a numeric SOURCE literal denotes an integer value outside +/-(2^53-1). Decides from the literal text (decimal, 0x, 0o,
 * fraction and exponent forms) using exact BigInt arithmetic, before any double rounding. Fractional literals (e.g. 0.5, 1e-7,
 * 123456789012345678.5) and in-range integers (e.g. 1e3, 9007199254740991, 1.0) are accepted.
 */
export function unsafeIntegerLiteral(src) {
  const t = String(src).trim();
  if (/^[-+]?(0x[0-9a-fA-F]+|0o[0-7]+)$/.test(t)) return BigInt(t.replace(/^[-+]/, "")) > MAX_SAFE;
  const m = /^[-+]?(\d*)(?:\.(\d*))?(?:[eE]([-+]?)(\d+))?$/.exec(t);
  if (!m) return false; // not a plain decimal literal (e.g. .inf / .nan: rejected separately as non-finite)
  const [, ip = "", fp = "", esign = "+", edigits = "0"] = m;
  let D = (ip + fp).replace(/^0+/, "");
  if (D === "") return false; // zero
  let tz = 0; while (D.endsWith("0")) { D = D.slice(0, -1); tz++; }
  if (edigits.replace(/^0+/, "").length > 9) return esign !== "-"; // astronomically large exponent: positive => integer far outside range; negative => fractional
  let e = BigInt(edigits) * (esign === "-" ? -1n : 1n) - BigInt(fp.length) + BigInt(tz);
  if (e < 0n) return false; // has a non-zero fractional part
  if (e + BigInt(D.length) - 1n > 15n) return true; // >= 1e16 > 2^53
  return BigInt(D) * 10n ** e > MAX_SAFE;
}
function scanNumberLiterals(doc) {
  const out = [];
  const check = (n, p, what) => {
    if (YAML.isScalar(n) && typeof n.value === "number" && Number.isFinite(n.value) && typeof n.source === "string" && unsafeIntegerLiteral(n.source)) {
      out.push(bad(p, `${what} ${n.source} is an integer outside the safe integer range (+/-9007199254740991) and would be rounded silently; use a value within range or quote it as a string`, "E_UNSAFE_INTEGER"));
    }
  };
  const walk = (n, p) => {
    if (YAML.isMap(n)) for (const pair of n.items) { const k = YAML.isScalar(pair.key) ? String(pair.key.source ?? pair.key.value) : "?"; check(pair.key, [...p, k], "mapping key"); walk(pair.value, [...p, k]); }
    else if (YAML.isSeq(n)) n.items.forEach((x, i) => walk(x, [...p, i]));
    else check(n, p, "numeric literal");
  };
  walk(doc.contents, []);
  return out;
}
/**
 * Parses YAML 1.2 (core schema, unique keys). Rejects, with controlled DataRejectedError diagnostics, unsafe integer literals
 * (checked on the source text before rounding), non-finite numbers and unsupported value types (!!binary etc.).
 */
export function parseYaml(text) {
  const doc = YAML.parseDocument(text, { schema: "core", uniqueKeys: true });
  if (doc.errors.length) throw doc.errors[0];
  const problems = scanNumberLiterals(doc);
  const value = doc.toJS();
  problems.push(...findInvalidData(value));
  if (problems.length) throw new DataRejectedError(problems);
  return value;
}
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

// ---------- loading (allow-listed, size-limited, symlink-safe) ----------
const isRuntimePayload = (node) => {
  if (Array.isArray(node)) {
    if (node.length >= 2 && node.every((x) => x && typeof x === "object" && typeof x.role === "string" && "content" in x)) return "chat-transcript-shaped array (role/content messages)";
    for (const x of node) { const r = isRuntimePayload(x); if (r) return r; }
  } else if (node && typeof node === "object") {
    if ("sessionId" in node && ("runId" in node || "eventId" in node || "branchId" in node)) return "evidence-envelope/tape-shaped object (sessionId + runId/eventId)";
    if (Array.isArray(node.events) && node.events.length >= 2 && node.events.every((e) => e && typeof e === "object" && "seq" in e && "ts" in e)) return "event tape (events with seq/ts)";
    for (const v of Object.values(node)) { const r = isRuntimePayload(v); if (r) return r; }
  }
  return null;
};

export function loadRegistry(root) {
  const versions = [];
  versions.structureErrors = [];
  const se = (code, file, message) => versions.structureErrors.push({ code, file, message });
  for (const [scope, sub] of Object.entries(SCOPES)) {
    const base = path.join(root, sub);
    if (!fs.existsSync(base)) continue;
    for (const idDir of fs.readdirSync(base, { withFileTypes: true })) {
      const idRel = `${sub}/${idDir.name}`;
      if (idDir.isSymbolicLink()) { se("E_SYMLINK", idRel, "symbolic links are not allowed"); continue; }
      if (!idDir.isDirectory()) { if (!SCOPE_ROOT_FILES.has(idDir.name)) se("E_UNEXPECTED_FILE", idRel, "only README.md may sit directly in a scope root"); continue; }
      for (const ver of fs.readdirSync(path.join(base, idDir.name), { withFileTypes: true })) {
        const vRel = `${idRel}/${ver.name}`;
        if (ver.isSymbolicLink()) { se("E_SYMLINK", vRel, "symbolic links are not allowed"); continue; }
        if (!ver.isDirectory()) { se("E_UNEXPECTED_FILE", vRel, "only version directories may sit under an artifact id directory"); continue; }
        const dir = path.join(base, idDir.name, ver.name);
        const entry = { scope, dirId: idDir.name, dirVersion: ver.name, dir, rel: vRel, errors: [], warnings: [], symlinks: [], files: [], bytes: 0 };
        walkVersion(dir, "", entry);
        const load = (name) => {
          if (!entry.files.includes(name)) return undefined;
          const f = path.join(dir, name), st = fs.lstatSync(f), ferr = (code, message, where) => entry.errors.push({ code, file: `${vRel}/${name}`, ...(where !== undefined ? { where } : {}), message });
          if (st.isSymbolicLink() || !st.isFile()) return null; // already reported by walkVersion
          if (st.size > MAX_FILE_BYTES) { ferr("E_SIZE", `file is ${st.size} bytes; the limit is ${MAX_FILE_BYTES}`); return null; }
          const buf = fs.readFileSync(f);
          if (buf.includes(0)) { ferr("E_BINARY", "binary content (NUL byte) is not allowed"); return null; }
          const text = buf.toString("utf8");
          if (!Buffer.from(text, "utf8").equals(buf) || text.charCodeAt(0) === 0xfeff) { ferr("E_ENCODING", "file must be UTF-8 without BOM"); return null; }
          if (text.includes("\r")) ferr("E_LINE_ENDING", "CR characters are not allowed; registry files use LF line endings");
          let doc;
          try { doc = parseYaml(text); } catch (e) {
            if (e instanceof DataRejectedError) { for (const d of e.diagnostics) ferr(d.code, d.message, d.path); } else ferr("E_YAML", e.message);
            return null;
          }
          const why = isRuntimePayload(doc);
          if (why) { ferr("E_RUNTIME_ARTIFACT", `content looks like a runtime artifact: ${why}. Raw tapes, traces and transcripts must stay in the evidence store`); return null; }
          return doc;
        };
        entry.blueprint = load("blueprint.yaml");
        entry.suite = load("evals/suite.yaml");
        entry.refs = load("evidence/refs.yaml");
        entry.release = load("release.yaml");
        entry.overlay = load("lifecycle.yaml");
        versions.push(entry);
      }
    }
  }
  return versions;
}
/** lstat-based walk: never follows symlinks; records files, symlinks and total bytes. */
function walkVersion(dir, prefix, entry) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = `${prefix}${d.name}`;
    if (d.isSymbolicLink()) { entry.symlinks.push(rel); continue; }
    if (d.isDirectory()) { walkVersion(path.join(dir, d.name), `${rel}/`, entry); continue; }
    entry.files.push(rel);
    if (d.isFile()) entry.bytes += fs.lstatSync(path.join(dir, d.name)).size;
  }
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
/**
 * Secret and endpoint lint for accepted SIDECAR files (evals/suite.yaml, evidence/refs.yaml, lifecycle.yaml, release.yaml).
 * Scans every string value (and mapping key) for credentials (E_SECRET) and for http(s) URLs / infrastructure hosts (E_ENDPOINT).
 * Scoped exemptions only: `endpointAllowed(path)` marks designated pointer fields (they are still secret-scanned), `$schema` / `$id`
 * keys are schema identifiers and skipped, and `evidence://` pointers are not http(s) URLs. This is not a blanket URL ban.
 */
export function lintSidecar(doc, err, endpointAllowed = () => false) {
  const visit = (s, p) => {
    const where = ptr(p);
    if (SECRET_RES.some((r) => r.test(s))) err("E_SECRET", where, "value looks like a credential");
    if (!endpointAllowed(p) && (URL_RE.test(s) || INFRA_HOST_RE.test(s))) err("E_ENDPOINT", where, "http(s) URLs and infrastructure hosts are not allowed here; use an evidence:// pointer or a designated pointer field");
  };
  const walk = (n, p) => {
    if (typeof n === "string") visit(n, p);
    else if (Array.isArray(n)) n.forEach((x, i) => walk(x, [...p, i]));
    else if (n && typeof n === "object") for (const [k, x] of Object.entries(n)) { if (k === "$schema" || k === "$id") continue; visit(k, [...p, k]); walk(x, [...p, k]); }
  };
  walk(doc, []);
}
const SIDECAR_POINTER_FIELDS = {
  "evals/suite.yaml": () => false,
  "lifecycle.yaml": () => false,
  "evidence/refs.yaml": (p) => p[0] === "refs" && typeof p[1] === "number" && p[2] === "uri", // evidence:// pointer field
  "release.yaml": (p) => p.length === 1 && p[0] === "promotionRef", // governance transport reference (e.g. a pull request)
};

export function validateVersion(v, ctx) {
  const { errors, warnings } = v;
  const bp = v.blueprint;
  const file = (n) => `${v.rel}/${n}`;
  const err = (code, where, message, f = "blueprint.yaml") => errors.push({ code, file: file(f), where, message });
  const warn = (code, where, message, f = "blueprint.yaml") => warnings.push({ code, file: file(f), where, message });

  // repository hygiene: no runtime tapes / unexpected artifacts
  for (const f of v.files) if (!ALLOWED_FILES.has(f)) err("E_UNEXPECTED_FILE", "", `${f} is not on the filename allow-list (${[...ALLOWED_FILES].join(", ")}). Raw tapes, traces, transcripts and runtime payloads must stay in the evidence store, never in Git`, f);
  for (const f of v.symlinks) err("E_SYMLINK", "", "symbolic links are not allowed in registry artifacts", f);
  if (v.bytes > MAX_VERSION_BYTES) err("E_SIZE", "", `version directory is ${v.bytes} bytes; the limit is ${MAX_VERSION_BYTES}`, ".");

  // accepted sidecars are scanned for secrets/endpoints even when the blueprint itself is unusable
  for (const [name, doc] of [["evals/suite.yaml", v.suite], ["evidence/refs.yaml", v.refs], ["lifecycle.yaml", v.overlay], ["release.yaml", v.release]]) {
    if (doc) lintSidecar(doc, (code, where, message) => err(code, where, message, name), SIDECAR_POINTER_FIELDS[name]);
  }

  if (bp === undefined) { if (!v.symlinks.includes("blueprint.yaml")) err("E_MISSING", "", "blueprint.yaml is missing"); return; }
  if (bp === null) return;
  for (const m of schemaErrors("blueprint", bp)) err("E_SCHEMA", "", m);
  if (errors.some((e) => e.code === "E_SCHEMA")) return;

  const md = bp.metadata, spec = bp.spec;
  const id = md.id;
  const digest = (v.digest = artifactDigest(bp));

  // directory / scope identity
  if (id !== v.dirId) err("E_PATH", "/metadata/id", `directory ${v.dirId} does not match metadata.id ${id}`);
  if (md.version !== v.dirVersion) err("E_PATH", "/metadata/version", `directory ${v.dirVersion} does not match metadata.version ${md.version}`);
  const idHead = (x) => x.split(".").filter((seg) => seg !== "synthetic")[0];
  if (RESERVED_ID_PREFIXES.has(idHead(id))) err("E_ID_PREFIX", "/metadata/id", `ids must not start with a registry/kind word ("${idHead(id)}"); the registry field carries that`);
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
    if (RESERVED_ID_PREFIXES.has(idHead(r.id))) err("E_ID_PREFIX", `/references/${i}/id`, `ids must not start with a registry/kind word ("${idHead(r.id)}")`);
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
    const suiteSchema = schemaErrors("suite", v.suite);
    for (const m of suiteSchema) err("E_SCHEMA", "", m, "evals/suite.yaml");
    if (!suiteSchema.length) {
      const s = v.suite;
      const curSuiteDigest = suiteDigest(s);
      // evaluation attestations must name and bind the exact suite assessed (identity = the suite's own metadata triple; digest = suiteDigest)
      bp.attestations.forEach((a, i) => {
        if (a.type !== "evaluation" || !a.suite) return;
        if (a.suite.registry !== s.metadata.registry || a.suite.id !== s.metadata.id || a.suite.version !== s.metadata.version) err("E_SUITE_MISMATCH", `/attestations/${i}/suite`, `evaluation names suite ${a.suite.id}@${a.suite.version} but evals/suite.yaml is ${s.metadata.id}@${s.metadata.version}`);
        else if (a.suite.digest !== curSuiteDigest) err("E_SUITE_STALE", `/attestations/${i}/suite/digest`, `evaluation assessed suite ${a.suite.digest} but the current suite digest is ${curSuiteDigest}; re-run the evaluation against the current suite (resealing does not refresh it)`);
      });
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
  } else if (v.suite === undefined && bp.attestations.some((a) => a.type === "evaluation")) err("E_SUITE", "", "evaluation attestations require evals/suite.yaml", "evals/suite.yaml");

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
    const refsSchema = schemaErrors("refs", v.refs);
    for (const m of refsSchema) err("E_SCHEMA", "", m, "evidence/refs.yaml");
    if (!refsSchema.length) {
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
    const overlaySchema = schemaErrors("lifecycle", v.overlay);
    for (const m of overlaySchema) err("E_SCHEMA", "", m, "lifecycle.yaml");
    if (!overlaySchema.length) {
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
    if (v.release !== undefined) err("E_RELEASE", "", "release record present on a candidate", "release.yaml");
  } else {
    if (v.release === undefined) err("E_RELEASE", "", "canonical versions require a release record (npm run seal)", "release.yaml");
    else if (v.release !== null) {
      for (const m of schemaErrors("release", v.release)) err("E_SCHEMA", "", m, "release.yaml");
      if (v.release.metadata?.id !== id || v.release.metadata?.version !== md.version) err("E_RELEASE", "/metadata", "release record identity mismatch", "release.yaml");
      if (v.release.digest !== digest) err("E_DIGEST", "/digest", `artifact changed after release (release ${v.release.digest}, computed ${digest})`, "release.yaml");
      if (v.suite !== null) { // a rejected (invalid-data) suite already has diagnostics; its seal cannot be computed
      const { payload, seal } = directorySeal(bp, v.suite);
      v.directorySeal = seal;
      for (const p of payload) { const rp = v.release.payload?.find((x) => x.path === p.path); if (!rp || rp.digest !== p.digest) err("E_SEAL", `/payload/${p.path}`, `payload file ${p.path} changed after release`, "release.yaml"); }
      if (v.release.payload && v.release.payload.length !== payload.length) err("E_SEAL", "/payload", "release payload file list differs from the canonical payload files", "release.yaml");
      if (v.release.directorySeal !== seal) err("E_SEAL", "/directorySeal", `directory seal mismatch (release ${v.release.directorySeal}, computed ${seal})`, "release.yaml");
      }
    }
    if (v.suite === undefined) err("E_SUITE", "", "canonical versions require evals/suite.yaml", "evals/suite.yaml");
    const curSuite = v.suite ? suiteDigest(v.suite) : null;
    if (!bp.attestations.some((a) => a.type === "evaluation" && a.gate === "canonical" && a.result === "pass" && a.subjectDigest === digest && curSuite && a.suite?.digest === curSuite && a.suite?.id === v.suite.metadata?.id && a.suite?.version === v.suite.metadata?.version)) err("E_PROMOTION", "/attestations", "canonical requires a passing evaluation attestation for gate `canonical` bound to the current artifact digest AND the current evaluation suite (id, version, digest)");
    if (!bp.security.approvals.some((a) => a.type === "security-review" && a.actor.type === "human" && a.subjectDigest === digest)) err("E_PROMOTION", "/security/approvals", "canonical requires a human security-review approval bound to the current digest");
    if (!bp.security.approvals.some((a) => a.type === "release-approval" && a.actor.type === "human" && a.subjectDigest === digest)) err("E_PROMOTION", "/security/approvals", "canonical requires a human release-approval bound to the current digest");
  }

  // ---- peer resolution (optional, offline-safe, local index files only) ----
  if (ctx.peers.length) {
    for (const r of bp.references) {
      const cand = ctx.peers.filter((p) => p.registry === r.registry && p.id === r.id && versionSatisfies(p.version, r.version) && p.lifecycle !== "revoked");
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

// ---------- version eligibility (single local policy shared by the resolver and the peer-index validator) ----------
/**
 * Local policy: npm semver semantics WITHOUT includePrerelease. A prerelease version (e.g. 1.1.0-rc.1) satisfies a range only when
 * the range itself contains a comparator with a prerelease tag on the same major.minor.patch (^1.1.0-rc.0 admits 1.1.0-rc.1;
 * ^1.0.0 does not). Not a cross-registry policy.
 */
export function versionSatisfies(version, range) {
  const r = semver.validRange(range);
  return Boolean(r) && semver.satisfies(version, r);
}

// ---------- top-level ----------
export function loadRegistries() {
  const cfg = readYaml(path.join(PKG_ROOT, "registries.yaml"));
  return new Set(Object.keys(cfg.registries));
}
export function loadPeerIndexes(files = []) {
  return files.flatMap((f) => { const idx = JSON.parse(fs.readFileSync(f, "utf8")); return idx.entries ?? idx; });
}

const RUNTIME_ARTIFACT_RE = /\.(jsonl|ndjson|tapes?|har|traces?|transcripts?)$/i;
const RUNTIME_DIR_RE = /^(tapes?|trajector(y|ies)|sessions|traces?|transcripts?)$/i;
const RUNTIME_NAME_TOKEN_RE = /(^|[._-])(tapes?|traces?|transcripts?|trajector(y|ies)|sessions?)([._-]|$)/i;
/** Repo-wide scan: raw runtime artifacts must never be committed; symlinks are never followed. */
export function scanRuntimeArtifacts(root) {
  const out = [];
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if ([".git", "node_modules", "dist"].includes(d.name)) continue;
      const p = path.join(dir, d.name), rel = path.relative(root, p).split(path.sep).join("/");
      const inPayload = Object.values(SCOPES).some((sub) => rel === sub || rel.startsWith(sub + "/"));
      if (d.isSymbolicLink()) { out.push({ code: "E_SYMLINK", file: rel, message: "symbolic links are not allowed in this repository" }); continue; }
      if (d.isDirectory()) {
        if (RUNTIME_DIR_RE.test(d.name)) out.push({ code: "E_RUNTIME_ARTIFACT", file: rel, message: "runtime tape/trajectory/trace/transcript directories must not be committed" });
        else if (inPayload && RUNTIME_NAME_TOKEN_RE.test(d.name)) out.push({ code: "E_RUNTIME_ARTIFACT", file: rel, message: "directory name looks like runtime evidence" });
        walk(p);
      } else if (RUNTIME_ARTIFACT_RE.test(d.name) || (inPayload && RUNTIME_NAME_TOKEN_RE.test(d.name))) {
        out.push({ code: "E_RUNTIME_ARTIFACT", file: rel, message: "runtime tape/trace/transcript files must not be committed; keep them in the evidence store" });
      }
    }
  };
  walk(root);
  return out;
}

export function validateAll({ root = PKG_ROOT, peerIndexFiles = [] } = {}) {
  const ctx = { registries: loadRegistries(), peers: loadPeerIndexes(peerIndexFiles) };
  const all = loadRegistry(root);
  const controlled = (v, e, where) => {
    if (e instanceof DataRejectedError) for (const d of e.diagnostics) v.errors.push({ code: d.code, file: `${v.rel}/blueprint.yaml`, where: d.path, message: d.message });
    else v.errors.push({ code: "E_INTERNAL", file: `${v.rel}/${where}`, where: "", message: `unexpected ${e?.constructor?.name ?? "error"}: ${e?.message ?? e}` });
  };
  for (const v of all) { try { validateVersion(v, ctx); } catch (e) { controlled(v, e, "blueprint.yaml"); } }
  try { validateLineage(all); } catch (e) { if (all[0]) controlled(all[0], e, "blueprint.yaml"); else throw e; }
  const seen = new Map();
  for (const v of all) {
    if (!v.blueprint?.metadata) continue;
    const key = `${v.blueprint.metadata.id}@${v.blueprint.metadata.version}`;
    if (seen.has(key)) v.errors.push({ code: "E_DUP", file: `${v.rel}/blueprint.yaml`, where: "", message: `duplicate ${key} also at ${seen.get(key)}` });
    seen.set(key, v.rel);
  }
  const repoErrors = [...(all.structureErrors ?? []), ...scanRuntimeArtifacts(root)];
  const seenErr = new Set();
  const errors = [...all.flatMap((v) => v.errors), ...repoErrors].filter((e) => { const k = `${e.code}|${e.file}|${e.where ?? ""}|${e.message}`; if (seenErr.has(k)) return false; seenErr.add(k); return true; });
  return { versions: all, errors, warnings: all.flatMap((v) => v.warnings) };
}

/** Deterministic derived index: a pure function of registry content (no timestamps, no commit ids). */
export function buildIndex(all, scope) {
  const entries = all.filter((v) => v.scope === scope && v.blueprint && v.digest && !v.errors.length).map((v) => {
    const bp = v.blueprint, md = bp.metadata;
    return {
      registry: REGISTRY, id: md.id, version: md.version, digest: v.digest, maturity: md.maturity, lifecycle: md.lifecycle,
      origin: md.origin.type, location: v.rel, synthetic: md.synthetic === true, sealed: md.maturity === "canonical",
      references: bp.references, compatibility: bp.spec.compatibility,
      ...(v.directorySeal ? { directorySeal: v.directorySeal } : {}),
      ...(v.overlay?.entries?.at(-1)?.replacedBy ? { replacedBy: v.overlay.entries.at(-1).replacedBy } : {}),
    };
  }).sort((a, b) => compareCodePoints(a.id, b.id) || semver.compare(a.version, b.version));
  return { apiVersion: "registry.zeptly.dev/v1alpha1", kind: "RegistryIndex", registry: REGISTRY, scope, entries };
}

// ---------- resolution (declared range -> exact version -> digest -> lock) ----------
/**
 * Resolve one declared reference against index entries. Never throws for unresolvable references: the result is explicit.
 * Only canonical, non-revoked versions are selectable; candidates never are. Reasons: peer-index-unavailable (no entries at all
 * for that registry), invalid-range, no-satisfying-version, digest-mismatch.
 */
export function resolveRef(ref, entries) {
  const range = semver.validRange(ref.version);
  if (!range) return { status: "unresolved", reason: "invalid-range" };
  if (!entries.some((e) => e.registry === ref.registry)) return { status: "unresolved", reason: "peer-index-unavailable" };
  const c = entries.filter((e) => e.registry === ref.registry && e.id === ref.id && e.maturity === "canonical" && e.lifecycle !== "revoked" && versionSatisfies(e.version, ref.version));
  if (!c.length) return { status: "unresolved", reason: "no-satisfying-version" };
  c.sort((a, b) => semver.rcompare(a.version, b.version));
  const hit = c[0];
  if (ref.digest && ref.digest !== hit.digest) return { status: "unresolved", reason: "digest-mismatch" };
  return { status: "resolved", resolved: { registry: hit.registry, id: hit.id, version: hit.version, digest: hit.digest } };
}
/** Every declared reference appears in the lock, in declaration order; unresolved ones are explicit, never omitted. */
export function buildResolutionLock(root, references, entries) {
  const locks = references.map((r) => {
    const declared = { registry: r.registry, id: r.id, version: r.version, ...(r.digest ? { digest: r.digest } : {}) };
    return { declared, ...resolveRef(r, entries) };
  });
  return { apiVersion: "registry.zeptly.dev/v1alpha1", kind: "ResolutionLock", root, complete: locks.every((l) => l.status === "resolved"), locks };
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
  // never throw on unparseable/invalid content: report controlled file/path diagnostics and keep checking other files
  const parse = (text, file) => {
    try { return { doc: parseYaml(text) }; } catch (e) {
      if (e instanceof DataRejectedError) for (const d of e.diagnostics) errors.push({ code: d.code, file, where: d.path, message: d.message });
      else errors.push({ code: "E_YAML", file, message: e.message });
      return null;
    }
  };
  const IDENTITY = ["id", "registry", "version"];
  const sameIdentity = (a, b) => IDENTITY.every((k) => a?.metadata?.[k] === b?.metadata?.[k]);
  for (const rel of tree.filter((f) => /\/blueprint\.yaml$/.test(f))) {
    const dir = path.posix.dirname(rel);
    const err = (code, file, message) => errors.push({ code, file, message });
    const beforeP = parse(gitShow(root, baseRef, rel), rel);
    if (!beforeP) continue;
    const before = beforeP.doc;
    const m0 = before?.metadata?.maturity;
    const headFile = path.join(root, rel);
    if (!fs.existsSync(headFile)) { if (m0 === "canonical") err("E_IMMUTABLE", rel, "canonical version cannot be deleted; revoke it via the lifecycle overlay"); continue; }
    const afterP = parse(fs.readFileSync(headFile, "utf8"), rel);
    if (!afterP) continue;
    const after = afterP.doc;
    if (m0 === "canonical" && after.metadata?.maturity !== "canonical") err("E_TRANSITION", rel, "a canonical version cannot return to candidate");
    if (m0 === "canonical") {
      // identity (id, registry, version) is immutable. The artifact digest deliberately excludes metadata.version, so it is compared explicitly:
      // a version-only mutation (directory name unchanged) is caught here. metadata.lifecycle/maturity are NOT identity and are handled separately.
      for (const k of IDENTITY) if (before.metadata?.[k] !== after.metadata?.[k]) err("E_IMMUTABLE", rel, `canonical identity field metadata.${k} changed (${before.metadata?.[k]} -> ${after.metadata?.[k]}); identity is immutable, publish a new version instead`);
      if (artifactDigest(before) !== artifactDigest(after)) err("E_IMMUTABLE", rel, "canonical artifact content changed; publish a new version instead");
      if (!appendOnly(before.attestations, after.attestations)) err("E_IMMUTABLE", rel, "attestations are append-only on canonical versions");
      if (!appendOnly(before.security?.approvals, after.security?.approvals)) err("E_IMMUTABLE", rel, "security approvals are append-only on canonical versions");
      for (const f of tree.filter((t) => t.startsWith(dir + "/") && t !== rel)) {
        const name = f.slice(dir.length + 1);
        const head = path.join(root, f);
        if (!fs.existsSync(head)) { err("E_IMMUTABLE", f, "file of a canonical version was deleted"); continue; }
        const bP = parse(gitShow(root, baseRef, f), f), hP = parse(fs.readFileSync(head, "utf8"), f);
        if (!bP || !hP) continue;
        const b = bP.doc, h = hP.doc;
        if (name === "evidence/refs.yaml") {
          if (!sameIdentity(b, h)) err("E_IMMUTABLE", f, "evidence refs identity (metadata id/registry/version) changed on a canonical version");
          if (!appendOnly(b?.refs, h?.refs)) err("E_IMMUTABLE", f, "evidence refs are append-only");
        } else if (name === "lifecycle.yaml") {
          if (!sameIdentity(b, h)) err("E_IMMUTABLE", f, "lifecycle overlay identity (metadata id/registry/version) changed on a canonical version"); // entries checked below
        } else if (canonicalize(b) !== canonicalize(h)) err("E_IMMUTABLE", f, "file of a canonical version changed");
      }
    }
    // lifecycle overlay: append-only for every version, with legal transitions
    const ovRel = `${dir}/lifecycle.yaml`;
    if (tree.includes(ovRel)) {
      const bP = parse(gitShow(root, baseRef, ovRel), ovRel);
      const hf = path.join(root, ovRel);
      if (!fs.existsSync(hf)) err("E_IMMUTABLE", ovRel, "lifecycle overlay cannot be deleted");
      else { const hP = parse(fs.readFileSync(hf, "utf8"), ovRel); if (bP && hP && !appendOnly(bP.doc?.entries ?? [], hP.doc?.entries ?? [])) err("E_IMMUTABLE", ovRel, "lifecycle overlay is append-only; existing entries were changed or removed"); }
    }
  }
  return errors;
}
