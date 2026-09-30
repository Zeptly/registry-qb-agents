#!/usr/bin/env node
// Offline resolver: declared range -> exact version -> digest -> RuntimeLock (Protocol v0.2, JSON on stdout).
// Every declared reference is listed; references that cannot be resolved (e.g. no peer index supplied) appear as `unresolved` with a code.
// Exit codes (Protocol v0.2): 0 complete lock, 1 valid request that cannot be satisfied (lock emitted with unresolved entries),
// 2 malformed input / invalid registry / usage error.
// Usage: node scripts/resolve.mjs <id>@<version> [--index <peer-index.json> ...] [--scope production|synthetic] [--allow-candidates]
// Indexes are LOCAL files supplied by the caller; how peers publish/retrieve indexes is deferred by the protocol.
import { parseArgs } from "node:util";
import { validateAll, buildIndex, loadPeerIndexes, buildRuntimeLock, schemaErrors, SCOPES } from "./lib/core.mjs";

let parsed;
try { parsed = parseArgs({ allowPositionals: true, options: { index: { type: "string", multiple: true }, scope: { type: "string", default: "production" }, "allow-candidates": { type: "boolean" } } }); } catch (e) { console.error(e.message); process.exit(2); }
const { values, positionals } = parsed;
const m = /^([a-z0-9.-]+)@(.+)$/.exec(positionals[0] ?? "");
if (!m || !SCOPES[values.scope]) { console.error("usage: resolve <id>@<version> [--index file ...] [--scope production|synthetic] [--allow-candidates]"); process.exit(2); }
const res = validateAll();
if (res.errors.length) { console.error("registry is invalid; run npm run validate"); process.exit(2); }
const own = buildIndex(res.versions, values.scope).entries;
const root = own.find((e) => e.id === m[1] && e.version === m[2]);
if (!root) { console.error(`${m[1]}@${m[2]} not found in the ${values.scope} domain`); process.exit(2); }
const peerErrors = [];
const peers = loadPeerIndexes(values.index ?? [], peerErrors);
if (peerErrors.length) { for (const e of peerErrors) console.error(`${e.code} ${e.file} ${e.where}: ${e.message}`); process.exit(2); }
const lock = buildRuntimeLock({ registry: root.registry, id: root.id, version: root.version, digest: root.digest }, root.references, [...own, ...peers], { domain: values.scope, allowCandidates: values["allow-candidates"] === true });
const errs = schemaErrors("lock", lock);
if (errs.length) { console.error(errs.join("\n")); process.exit(2); }
console.log(JSON.stringify(lock, null, 2));
process.exit(lock.complete ? 0 : 1);
