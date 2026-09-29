#!/usr/bin/env node
// Usage: node scripts/seal.mjs <id>@<version> [--pr <transport-ref>] [--scope production|synthetic]
// Writes release.yaml (digest + suite digest) for a version being promoted to `canonical`.
// Promotion also requires editing blueprint metadata.maturity -> canonical, digest-bound attestations and approvals.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import YAML from "yaml";
import { PKG_ROOT, SCOPES, REGISTRY, artifactDigest, suiteDigest, parseYaml } from "./lib/core.mjs";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { pr: { type: "string" }, scope: { type: "string", default: "production" } } });
const m = /^([a-z0-9.-]+)@(.+)$/.exec(positionals[0] ?? "");
if (!m || !SCOPES[values.scope]) { console.error("usage: seal <id>@<version> [--pr ref] [--scope production|synthetic]"); process.exit(2); }
const dir = path.join(PKG_ROOT, SCOPES[values.scope], m[1], m[2]);
const bp = parseYaml(fs.readFileSync(path.join(dir, "blueprint.yaml"), "utf8"));
const suite = parseYaml(fs.readFileSync(path.join(dir, "evals/suite.yaml"), "utf8"));
const approvals = (bp.security.approvals ?? []).filter((a) => a.subjectDigest === artifactDigest(bp)).map(({ type, actor, at }) => ({ type, actor, at }));
const release = {
  apiVersion: "registry.zeptly.dev/v1alpha1", kind: "ReleaseRecord",
  metadata: { registry: REGISTRY, id: bp.metadata.id, version: bp.metadata.version },
  digest: artifactDigest(bp), suiteDigest: suiteDigest(suite), sealedAt: new Date().toISOString(),
  ...(values.pr ? { promotionRef: values.pr } : {}), ...(approvals.length ? { approvals } : {}),
};
const banner = bp.metadata.synthetic ? "# SYNTHETIC EXAMPLE DATA. NOT A REAL RELEASE. Placeholder approvers; no real promotion occurred.\n" : "";
fs.writeFileSync(path.join(dir, "release.yaml"), banner + YAML.stringify(release));
console.log(`release record for ${bp.metadata.id}@${bp.metadata.version}\n  digest ${release.digest}\n  suite  ${release.suiteDigest}`);
