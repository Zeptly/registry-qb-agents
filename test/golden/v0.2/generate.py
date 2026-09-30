#!/usr/bin/env python3
"""Independent generator for the shared Protocol v0.2 vectors (jcs.json, digest-seal.json, suite-binding.json).
Implements RFC 8785 (UTF-16 key order, ES number serialisation, JSON string escaping) and the v0.2 digest/seal contract from scratch,
without sharing code with scripts/lib/core.mjs. Run: python3 test/golden/v0.2/generate.py"""
import copy, hashlib, json, os, re
from decimal import Decimal

def es_number(v):
    if isinstance(v, bool): raise TypeError
    if isinstance(v, int):
        assert abs(v) <= 2**53 - 1
        return str(v)
    if v != v or v in (float("inf"), float("-inf")): raise ValueError("non-finite")
    if v == 0: return "0"
    sign = "-" if v < 0 else ""
    d = Decimal(repr(abs(v)))
    t = d.as_tuple(); digits = "".join(map(str, t.digits)).rstrip("0") or "0"
    n = len(t.digits) + t.exponent  # position of decimal point relative to digit string start
    k = len(digits)
    if k <= n <= 21: out = digits + "0" * (n - k)
    elif 0 < n <= 21: out = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0: out = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        es = ("+" if e >= 0 else "-") + str(abs(e))
        out = digits[0] + ("." + digits[1:] if k > 1 else "") + "e" + es
    return sign + out

def jcs(v):
    if v is None: return "null"
    if v is True: return "true"
    if v is False: return "false"
    if isinstance(v, (int, float)): return es_number(v)
    if isinstance(v, str): return json.dumps(v, ensure_ascii=False)
    if isinstance(v, list): return "[" + ",".join(jcs(x) for x in v) + "]"
    if isinstance(v, dict):
        keys = sorted(v, key=lambda k: k.encode("utf-16-be"))
        return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + jcs(v[k]) for k in keys) + "}"
    raise TypeError(type(v))

def sha(s): return "sha256:" + hashlib.sha256(s.encode("utf-8")).hexdigest()

def projection(a):
    a = copy.deepcopy(a)
    for k in ("version", "maturity", "lifecycle"): a.get("metadata", {}).pop(k, None)
    a.get("security", {}).pop("approvals", None)
    a.pop("attestations", None)
    return a
def artifact_digest(a): return sha(jcs(projection(a)))
def seal(registry, id_, version, payload):
    payload = sorted(payload, key=lambda p: p["path"].encode("utf-32-be"))  # code-point order of POSIX paths
    return sha(jcs({"registry": registry, "id": id_, "version": version, "payload": payload})), payload

here = os.path.dirname(os.path.abspath(__file__))
def write(name, doc): open(os.path.join(here, name), "w").write(json.dumps(doc, indent=2, ensure_ascii=True) + "\n")

# ---------------- JCS ----------------
J = lambda s: json.loads(s, parse_int=lambda t: int(t) if abs(int(t)) <= 2**53 - 1 else float(t))  # inputs are JSON texts so number literals stay language-neutral
jcs_in = [
  ("RFC 8785 3.2.3: keys sort by UTF-16 code units (emoji U+1F600 < U+FB33)", '{"\\u20ac":"Euro Sign","\\r":"Carriage Return","\\ufb33":"Hebrew Letter Dalet With Dagesh","1":"One","\\ud83d\\ude00":"Emoji: Grinning Face","\\u0080":"Control","\\u00f6":"Latin Small Letter O With Diaeresis"}'),
  ("UTF-16 order differs from code-point order: U+FFFF sorts after U+10000", '{"\\uffff":1,"\\ud800\\udc00":2,"b":3,"B":4}'),
  ("RFC 8785 3.2.2: numbers", '[333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001]'),
  ("number edge cases", '[0, -0, 1, -1, 0.5, 100, 1e21, 1e-7, 123456789012345680000, 0.000001, 9007199254740991, -9007199254740991, 1.5e300]'),
  ("RFC 8785 3.2.2: literals and string escaping", '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}'),
  ("no Unicode normalisation: NFC and NFD stay distinct", '{"k":"\\u00e9","k2":"e\\u0301"}'),
  ("no line-ending rewriting inside values or keys", '{"a\\r\\nb":"x\\r\\ny\\rz\\nw"}'),
  ("non-ASCII, U+2028 and astral characters are emitted literally", '{"s":"h\\u00e9llo \\u2713 \\ud83d\\ude00 \\u2028 \\u007f"}'),
  ("array order preserved, empty containers", '{"b":[],"a":{},"c":[3,1,2,{"y":null,"x":true}]}'),
]
vec = []
for name, txt in jcs_in:
    c = jcs(J(txt)); vec.append({"name": name, "inputJson": txt, "canonical": c, "sha256": sha(c)})
rej = [
  {"name": "NaN is rejected, never null", "kind": "nan"}, {"name": "+Infinity is rejected", "kind": "infinity"},
  {"name": "-Infinity is rejected", "kind": "-infinity"}, {"name": "lone high surrogate is rejected", "kind": "lone-surrogate", "value": "\ud800"},
  {"name": "lone low surrogate in a key is rejected", "kind": "lone-surrogate-key"}, {"name": "undefined/non-JSON values are rejected", "kind": "unsupported"},
]
write("jcs.json", {"digestAlgorithm": "zeptly-jcs-v1", "generator": "test/golden/v0.2/generate.py (independent implementation)", "vectors": vec, "rejections": rej})

# ---------------- artifact digest + directory seal ----------------
art = {
  "apiVersion": "registry.zeptly.dev/v1alpha1", "kind": "QBBlueprint",
  "metadata": {"id": "example.vector", "registry": "qb-agents", "version": "1.0.0", "maturity": "canonical", "lifecycle": "active",
               "origin": {"type": "evolved", "evolution": {"kind": "generalised", "sourceRefs": [{"registry": "qb-agents", "id": "example.vector", "version": "0.9.0"}]}}, "name": "Vector é😀"},
  "spec": {"￿": 1, "𐀀": 2, "limits": {"maxCostUsd": 0.5, "maxRuns": 100}, "text": "line1\nline2\r\nline3"},
  "references": [{"registry": "skills", "id": "example.skill", "version": "^1.0.0", "digest": "sha256:" + "a" * 64, "digestAlgorithm": "zeptly-jcs-v1"}],
  "provenance": {"authors": [{"type": "human", "id": "example-human"}]},
  "security": {"classification": "internal", "capabilities": ["capability:example"], "approvals": [{"type": "release-approval", "subjectDigest": "sha256:" + "b" * 64}]},
  "attestations": [{"type": "evaluation", "result": "pass", "subjectDigest": "sha256:" + "b" * 64}],
}
base = artifact_digest(art)
def mut(fn):
    a = copy.deepcopy(art); fn(a); return a
excluded = [
  ("metadata.version", lambda a: a["metadata"].__setitem__("version", "2.0.0")),
  ("metadata.maturity", lambda a: a["metadata"].__setitem__("maturity", "candidate")),
  ("metadata.lifecycle", lambda a: a["metadata"].__setitem__("lifecycle", "revoked")),
  ("security.approvals", lambda a: a["security"].__setitem__("approvals", [])),
  ("attestations", lambda a: a.__setitem__("attestations", [])),
]
included = [
  ("metadata.id", lambda a: a["metadata"].__setitem__("id", "example.other")),
  ("metadata.registry", lambda a: a["metadata"].__setitem__("registry", "tiny-agents")),
  ("metadata.origin", lambda a: a["metadata"]["origin"]["evolution"].__setitem__("kind", "refined")),
  ("spec", lambda a: a["spec"]["limits"].__setitem__("maxRuns", 101)),
  ("references", lambda a: a["references"][0].__setitem__("version", "^1.1.0")),
  ("references digestAlgorithm", lambda a: a["references"][0].__setitem__("digestAlgorithm", "other")),
  ("provenance", lambda a: a["provenance"]["authors"][0].__setitem__("id", "someone-else")),
  ("security.classification", lambda a: a["security"].__setitem__("classification", "restricted")),
  ("security.capabilities", lambda a: a["security"]["capabilities"].append("capability:more")),
  ("line ending inside a value (LF vs CRLF is significant)", lambda a: a["spec"].__setitem__("text", "line1\r\nline2\r\nline3")),
]
pay = [{"path": "blueprint.yaml", "digest": base}, {"path": "evals/suite.yaml", "digest": "sha256:" + "c" * 64}]
s0, sorted_pay = seal("qb-agents", "example.vector", "1.0.0", pay)
seal_cases = [
  {"name": "payload listed in reverse order seals identically (ordered by path)", "payload": list(reversed(pay)), "seal": s0},
  {"name": "payload file mutation changes the seal", "payload": [pay[0], {"path": "evals/suite.yaml", "digest": "sha256:" + "d" * 64}], "seal": seal("qb-agents", "example.vector", "1.0.0", [pay[0], {"path": "evals/suite.yaml", "digest": "sha256:" + "d" * 64}])[0]},
  {"name": "version is bound by the seal", "version": "1.0.1", "payload": pay, "seal": seal("qb-agents", "example.vector", "1.0.1", pay)[0]},
  {"name": "registry is bound by the seal", "registry": "tiny-agents", "payload": pay, "seal": seal("tiny-agents", "example.vector", "1.0.0", pay)[0]},
  {"name": "payload paths are ordered by code point (U+FF5E < U+1F600, the opposite of UTF-16 order)", "payload": [{"path": "😀.yaml", "digest": "sha256:" + "e" * 64}, {"path": "～.yaml", "digest": "sha256:" + "f" * 64}], "seal": seal("qb-agents", "example.vector", "1.0.0", [{"path": "😀.yaml", "digest": "sha256:" + "e" * 64}, {"path": "～.yaml", "digest": "sha256:" + "f" * 64}])[0]},
]
write("digest-seal.json", {
  "digestAlgorithm": "zeptly-jcs-v1", "generator": "test/golden/v0.2/generate.py (independent implementation)",
  "artifact": art, "artifactDigest": base, "projectionCanonical": jcs(projection(art)),
  "excludedFieldChanges": [{"field": n, "artifact": mut(f), "artifactDigest": artifact_digest(mut(f))} for n, f in excluded],
  "includedFieldChanges": [{"field": n, "artifact": mut(f), "artifactDigest": artifact_digest(mut(f))} for n, f in included],
  "seal": {"registry": "qb-agents", "id": "example.vector", "version": "1.0.0", "payload": pay, "sortedPayload": sorted_pay, "directorySeal": s0},
  "sealCases": seal_cases,
})

# ---------------- suite binding ----------------
suite = {"apiVersion": "registry.zeptly.dev/v1alpha1", "kind": "QBEvalSuite", "metadata": {"registry": "qb-agents", "id": "example.vector", "version": "1.0.0"},
         "metrics": [{"id": "task-success-rate"}], "gates": {"canonical": [{"metric": "task-success-rate", "op": ">=", "value": 0.85}]}}
sd = sha(jcs(suite))
suite2 = copy.deepcopy(suite); suite2["gates"]["canonical"][0]["value"] = 0.5
write("suite-binding.json", {
  "digestAlgorithm": "zeptly-jcs-v1", "generator": "test/golden/v0.2/generate.py (independent implementation)",
  "suite": suite, "suiteDigest": sd, "changedSuite": suite2, "changedSuiteDigest": sha(jcs(suite2)),
  "cases": [
    {"name": "binding matches the exact suite", "binding": {"id": "example.vector", "version": "1.0.0", "digest": sd}, "suite": "suite", "expect": None},
    {"name": "suite edited after the assessment: same id/version, different digest -> stale", "binding": {"id": "example.vector", "version": "1.0.0", "digest": sd}, "suite": "changedSuite", "expect": "E_SUITE_STALE"},
    {"name": "binding names another suite id", "binding": {"id": "example.other", "version": "1.0.0", "digest": sd}, "suite": "suite", "expect": "E_SUITE_MISMATCH"},
    {"name": "binding names another suite version", "binding": {"id": "example.vector", "version": "1.0.1", "digest": sd}, "suite": "suite", "expect": "E_SUITE_MISMATCH"},
    {"name": "optional registry must match when present", "binding": {"registry": "skills", "id": "example.vector", "version": "1.0.0", "digest": sd}, "suite": "suite", "expect": "E_SUITE_MISMATCH"},
  ],
})
print("ok", base, s0, sd)
