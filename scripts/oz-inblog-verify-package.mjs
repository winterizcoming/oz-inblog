import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadReleaseManifest } from "../lib/oz-inblog-release.mjs";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exportedRoot = path.join(scriptRoot, "dist", "oz-inblog");
const root = path.resolve(process.env.OZ_PACKAGE_ROOT || (fs.existsSync(exportedRoot) ? exportedRoot : scriptRoot));
const manifest = loadReleaseManifest(root);
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const indexHtml = fs.readFileSync(path.join(root, "ui", "v0-3", "index.html"), "utf8");
const forbiddenTopLevel = [".codex", ".env", ".tmp", "markdown_sources", "output", "research_runs", "work"];
const forbiddenRuntime = ["v08-writer", "v08-research", "v08-editorial", "knowledge-supabase", "v06-operator", "workflow-runtime"];
const violations = [];

if (packageJson.name !== manifest.name) violations.push("package name does not match release manifest");
if (packageJson.version !== manifest.packageVersion) violations.push("package version does not match release manifest");
if (!indexHtml.includes(manifest.displayVersion)) violations.push("UI version does not match release manifest");
for (const name of forbiddenTopLevel) if (fs.existsSync(path.join(root, name))) violations.push(`forbidden path included: ${name}`);

function inspect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if ([".git", "node_modules"].includes(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) { inspect(fullPath); continue; }
    const relative = path.relative(root, fullPath);
    if (fs.statSync(fullPath).size > 5 * 1024 * 1024) violations.push(`unexpected large file: ${relative}`);
    if (!/\.(?:c?js|mjs|json|md|html|css|txt|yml|yaml|svg)$/iu.test(entry.name)) continue;
    const content = fs.readFileSync(fullPath, "utf8");
    if (/\/Users\/[A-Za-z0-9._-]+\//u.test(content)) violations.push(`absolute user path: ${relative}`);
    if (relative !== "scripts/oz-inblog-verify-package.mjs" && /(?:SUPABASE_SERVICE_ROLE_KEY\s*[:=]\s*\S+|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY)/u.test(content)) violations.push(`secret-bearing content: ${relative}`);
    if (relative === "scripts/oz-inblog-server.mjs") {
      for (const token of forbiddenRuntime) if (content.includes(token)) violations.push(`legacy runtime reference in ${relative}: ${token}`);
    }
  }
}

inspect(root);
const result = { ok: violations.length === 0, root, version: manifest.packageVersion, violations };
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
