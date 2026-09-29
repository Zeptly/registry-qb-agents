#!/usr/bin/env node
// Offline resolver: declared range -> exact version -> digest -> ResolutionLock (JSON on stdout).
// Usage: node scripts/resolve.mjs <id>@<version> --index <index.json> [--index <peer-index.json> ...] [--scope production|synthetic]
// Indexes are LOCAL files supplied by the caller; how peers publish/retrieve indexes is deferred by the protocol.
import { parseArgs } from "node:util";
import { validateAll, buildIndex, loadPeerIndexes, buildResolutionLock, schemaErrors } from "./lib/core.mjs";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { index: { type: "string", multiple: true }, scope: { type: "string", default: "production" } } });
const m = /^([a-z0-9.-]+)@(.+)$/.exec(positionals[0] ?? "");
if (!m) { console.error("usage: resolve <id>@<version> [--index file ...] [--scope production|synthetic]"); process.exit(2); }
const res = validateAll();
if (res.errors.length) { console.error("registry is invalid; run npm run validate"); process.exit(1); }
const own = buildIndex(res.versions, values.scope).entries;
const root = own.find((e) => e.id === m[1] && e.version === m[2]);
if (!root) { console.error(`${m[1]}@${m[2]} not found in the ${values.scope} scope`); process.exit(1); }
let lock;
try {
  lock = buildResolutionLock({ registry: root.registry, id: root.id, version: root.version, digest: root.digest }, root.references, [...own, ...loadPeerIndexes(values.index ?? [])]);
} catch (e) { console.error(`resolution failed: ${e.message}`); process.exit(1); }
const errs = schemaErrors("lock", lock);
if (errs.length) { console.error(errs.join("\n")); process.exit(1); }
console.log(JSON.stringify(lock, null, 2));
