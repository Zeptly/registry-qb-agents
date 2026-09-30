#!/usr/bin/env node
// Usage: node scripts/seal.mjs <id>@<version> [--pr <transport-ref>] [--scope production|synthetic]
// Writes release.yaml (artifact digest + directory seal over the canonical payload files) for a version being promoted to `canonical`.
// Promotion also requires metadata.maturity: canonical, digest-bound attestations and approvals in the blueprint.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import YAML from "yaml";
import { PKG_ROOT, SCOPES, REGISTRY, artifactDigest, directorySeal, parseYaml, DataRejectedError } from "./lib/core.mjs";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { pr: { type: "string" }, scope: { type: "string", default: "production" } } });
const m = /^([a-z0-9.-]+)@(.+)$/.exec(positionals[0] ?? "");
if (!m || !SCOPES[values.scope]) { console.error("usage: seal <id>@<version> [--pr ref] [--scope production|synthetic]"); process.exit(2); }
const dir = path.join(PKG_ROOT, SCOPES[values.scope], m[1], m[2]);
let bp, suite;
try {
  bp = parseYaml(fs.readFileSync(path.join(dir, "blueprint.yaml"), "utf8"));
  suite = parseYaml(fs.readFileSync(path.join(dir, "evals/suite.yaml"), "utf8"));
} catch (e) {
  if (e instanceof DataRejectedError) { for (const d of e.diagnostics) console.error(`${d.code} ${d.path || "/"}: ${d.message}`); } else console.error(`cannot read artifact: ${e.message}`);
  process.exit(1);
}
const digest = artifactDigest(bp);
const { payload, seal } = directorySeal(bp, suite);
const approvals = (bp.security.approvals ?? []).filter((a) => a.subjectDigest === digest).map(({ type, actor, at }) => ({ type, actor, at }));
const release = {
  apiVersion: "registry.zeptly.dev/v1alpha1", kind: "ReleaseRecord",
  metadata: { registry: REGISTRY, id: bp.metadata.id, version: bp.metadata.version },
  digest, directorySeal: seal, payload, sealedAt: new Date().toISOString(),
  ...(values.pr ? { promotionRef: values.pr } : {}), ...(approvals.length ? { approvals } : {}),
};
const banner = bp.metadata.synthetic ? "# SYNTHETIC EXAMPLE DATA. NOT A REAL RELEASE. Placeholder approvers; no real promotion occurred.\n" : "";
fs.writeFileSync(path.join(dir, "release.yaml"), banner + YAML.stringify(release));
console.log(`release record for ${bp.metadata.id}@${bp.metadata.version}\n  digest ${digest}\n  seal   ${seal}`);
