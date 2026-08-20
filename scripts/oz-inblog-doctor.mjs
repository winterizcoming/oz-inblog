import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createSecureDataDirectories, resolveOzDataPaths } from "../lib/oz-inblog-data.mjs";
import { loadReleaseManifest } from "../lib/oz-inblog-release.mjs";
import { listAvailableWritingSkills } from "../lib/oz-writing-skill-registry.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function commandVersion(command, args) {
  try {
    const result = await execFileAsync(command, args, { timeout: 20_000 });
    return { ok: true, value: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim() };
  }
  catch (error) {
    const output = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`.trim();
    return { ok: false, value: output || null, code: error?.code ?? "command_failed" };
  }
}

export async function runDoctor({ env = process.env } = {}) {
  const manifest = loadReleaseManifest(root);
  const data = createSecureDataDirectories(resolveOzDataPaths({ env }));
  const [npm, codex, codexDoctor, login] = await Promise.all([
    commandVersion("npm", ["--version"]),
    commandVersion("codex", ["--version"]),
    commandVersion("codex", ["doctor", "--json"]),
    commandVersion("codex", ["login", "status"])
  ]);
  const installedSkills = listAvailableWritingSkills({ env }).map((skill) => skill.id);
  let doctorReport = null;
  try { doctorReport = JSON.parse(codexDoctor.value); } catch { doctorReport = null; }
  const doctorCriticalChecks = ["auth.credentials", "config.load", "installation", "network.provider_reachability", "network.websocket_reachability"];
  const checks = {
    platform: { ok: process.platform === manifest.platform.os, actual: process.platform, expected: manifest.platform.os },
    architecture: { ok: process.arch === manifest.platform.architecture, actual: process.arch, expected: manifest.platform.architecture },
    node: { ok: process.version === `v${manifest.tools.node}`, actual: process.version.slice(1), expected: manifest.tools.node },
    npm: { ok: npm.ok && npm.value === manifest.tools.npm, actual: npm.value, expected: manifest.tools.npm },
    codex: { ok: codex.ok && codex.value.includes(manifest.tools.codex), actual: codex.value, expected: manifest.tools.codex },
    codexDoctor: { ok: doctorReport !== null && doctorCriticalChecks.every((id) => doctorReport.checks?.[id]?.status === "ok"), actual: doctorReport?.overallStatus ?? codexDoctor.code },
    codexLogin: { ok: /logged in/iu.test(login.value ?? ""), actual: login.value || login.code },
    dataDirectory: { ok: fs.existsSync(data.root) && (fs.statSync(data.root).mode & 0o777) === 0o700, actual: data.root },
    writingSkills: { ok: ["korean-humanizer", "waza"].every((id) => installedSkills.includes(id)), actual: installedSkills }
  };
  return { ok: Object.values(checks).every((check) => check.ok), version: manifest.displayVersion, dataDirectory: data.root, checks };
}

const result = await runDoctor();
if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
else {
  process.stdout.write(`oz-inblog ${result.version} doctor\n`);
  for (const [name, check] of Object.entries(result.checks)) process.stdout.write(`${check.ok ? "PASS" : "FAIL"} ${name}: ${Array.isArray(check.actual) ? check.actual.join(", ") : check.actual}\n`);
  process.stdout.write(`Data: ${result.dataDirectory}\n`);
}
if (!result.ok) process.exitCode = 1;
