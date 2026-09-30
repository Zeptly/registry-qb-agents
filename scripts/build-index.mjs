#!/usr/bin/env node
// Builds deterministic derived indexes: dist/index.json (production) and dist/synthetic-index.json (synthetic examples).
// `--verify` builds twice and fails if the output differs. Indexes contain no timestamps or commit ids.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildIndex, validateAll, schemaErrors, PKG_ROOT } from "./lib/core.mjs";

const { values } = parseArgs({ options: { verify: { type: "boolean" } } });
const render = () => {
  const res = validateAll();
  if (res.errors.length) { console.error("refusing to build an index from an invalid registry; run npm run validate"); process.exit(2); }
  const out = {};
  for (const scope of ["production", "synthetic"]) {
    const idx = buildIndex(res.versions, scope);
    const errs = schemaErrors("index", idx);
    if (errs.length) { console.error(errs.join("\n")); process.exit(2); }
    out[scope] = JSON.stringify(idx, null, 2) + "\n";
  }
  return out;
};
const a = render();
if (values.verify) {
  const b = render();
  for (const k of Object.keys(a)) if (a[k] !== b[k]) { console.error(`non-deterministic ${k} index`); process.exit(1); }
  console.log("indexes are deterministic");
}
const dist = path.join(PKG_ROOT, "dist");
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, "index.json"), a.production);
fs.writeFileSync(path.join(dist, "synthetic-index.json"), a.synthetic);
console.log(`wrote dist/index.json (${JSON.parse(a.production).entries.length} production entries) and dist/synthetic-index.json (${JSON.parse(a.synthetic).entries.length} synthetic entries)`);
