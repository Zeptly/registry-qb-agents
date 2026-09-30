#!/usr/bin/env node
import { parseArgs } from "node:util";
import { validateAll } from "./lib/core.mjs";

const { values } = parseArgs({ options: { "peer-index": { type: "string", multiple: true }, json: { type: "boolean" }, "warnings-as-errors": { type: "boolean" } } });
const res = validateAll({ peerIndexFiles: values["peer-index"] ?? [] });

if (values.json) {
  console.log(JSON.stringify({ errors: res.errors, warnings: res.warnings }, null, 2));
} else {
  const show = (kind, list) => list.forEach((e) => console.log(`${kind} ${e.code} ${e.file}${e.where ? ` ${e.where}` : ""}\n    ${e.message}`));
  show("WARN ", res.warnings);
  show("ERROR", res.errors);
  console.log(`\n${res.versions.length} blueprint version(s) checked: ${res.errors.length} error(s), ${res.warnings.length} warning(s)`);
  if (!(values["peer-index"] ?? []).length) console.log("note: cross-registry references were checked syntactically only (no --peer-index given)");
}
// exit codes (Protocol v0.2): 0 valid, 2 malformed input or validation errors
process.exit(res.errors.length || (values["warnings-as-errors"] && res.warnings.length) ? 2 : 0);
