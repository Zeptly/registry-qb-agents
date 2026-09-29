#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { buildIndex, validateAll, schemaErrors, PKG_ROOT } from "./lib/core.mjs";

const res = validateAll();
if (res.errors.length) { console.error("refusing to build an index from an invalid registry; run npm run validate"); process.exit(1); }
let commit = "unknown";
try { commit = execSync("git rev-parse HEAD", { cwd: PKG_ROOT, encoding: "utf8" }).trim(); } catch { /* not a git checkout */ }
const index = buildIndex(res.versions, commit);
const errs = schemaErrors("index", index);
if (errs.length) { console.error(errs.join("\n")); process.exit(1); }
const out = path.join(PKG_ROOT, "dist");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "index.json"), JSON.stringify(index, null, 2) + "\n");
console.log(`wrote dist/index.json (${index.entries.length} entries)`);
