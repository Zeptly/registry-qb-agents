#!/usr/bin/env node
// Usage: node scripts/check-immutability.mjs [--base origin/main]
import { parseArgs } from "node:util";
import { checkImmutability } from "./lib/core.mjs";

const { values } = parseArgs({ options: { base: { type: "string", default: "origin/main" } } });
let errors;
try {
  errors = checkImmutability({ baseRef: values.base });
} catch (e) {
  if (/unknown revision|bad revision|Not a valid object name|not a tree object|ambiguous argument/i.test(String(e.stderr ?? e.message))) {
    console.log(`base ref ${values.base} not found (first commit or shallow clone): skipping immutability check`);
    process.exit(0);
  }
  throw e;
}
errors.forEach((e) => console.log(`ERROR ${e.code} ${e.file}\n    ${e.message}`));
console.log(`immutability vs ${values.base}: ${errors.length} error(s)`);
process.exit(errors.length ? 2 : 0); // Protocol v0.2: exit 2 = validation errors
