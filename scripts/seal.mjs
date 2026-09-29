#!/usr/bin/env node
// Usage: node scripts/seal.mjs qb:<slug>@<version> [--pr Zeptly/registry-qb-agents#N] [--approver user]
// Writes release.yaml pinning blueprint + suite digests. Run in the PR that first moves a version to `canary`.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import YAML from "yaml";
import { PKG_ROOT, blueprintDigest, suiteDigest, parseYaml } from "./lib/core.mjs";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { pr: { type: "string" }, approver: { type: "string", multiple: true } } });
const m = /^qb:([a-z0-9-]+)@(.+)$/.exec(positionals[0] ?? "");
if (!m) { console.error("usage: seal qb:<slug>@<version> [--pr ref] [--approver github-login]"); process.exit(2); }
const dir = path.join(PKG_ROOT, "qbs", m[1], m[2]);
const bp = parseYaml(fs.readFileSync(path.join(dir, "blueprint.yaml"), "utf8"));
const suite = parseYaml(fs.readFileSync(path.join(dir, "evals/suite.yaml"), "utf8"));
const release = {
  apiVersion: "qb.zeptly.dev/v1", kind: "QBRelease", id: `${bp.id}@${bp.version}`,
  blueprintDigest: blueprintDigest(bp), suiteDigest: suiteDigest(suite), sealedAt: new Date().toISOString(),
  ...(values.pr ? { promotionPr: values.pr } : {}),
  ...(values.approver?.length ? { approvals: values.approver.map((id) => ({ type: "human", id })) } : {}),
};
const banner = bp.metadata.labels?.example === "true" ? "# SYNTHETIC EXAMPLE DATA. NOT A REAL RELEASE. Placeholder approvers; no real promotion occurred.\n" : "";
fs.writeFileSync(path.join(dir, "release.yaml"), banner + YAML.stringify(release));
console.log(`sealed ${release.id}\n  blueprint ${release.blueprintDigest}\n  suite     ${release.suiteDigest}`);
