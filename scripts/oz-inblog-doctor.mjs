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

function parseVersion(value) {
  const match = String(value ?? "").match(/(\d+)\.(\d+)\.(\d+)/u);
  return match ? match.slice(1).map(Number) : null;
}

function parseConstraintVersion(value) {
  const match = String(value ?? "").match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/u);
  return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}

export function isVersionCompatible(actual, range) {
  const version = parseVersion(actual);
  if (!version || typeof range !== "string") return false;
  return range.trim().split(/\s+/u).filter(Boolean).every((constraint) => {
    const match = constraint.match(/^(>=|<=|>|<|=)?(\d+(?:\.\d+){0,2})$/u);
    if (!match) return false;
    const comparison = compareVersions(version, parseConstraintVersion(match[2]));
    switch (match[1] ?? "=") {
      case ">=": return comparison >= 0;
      case "<=": return comparison <= 0;
      case ">": return comparison > 0;
      case "<": return comparison < 0;
      default: return comparison === 0;
    }
  });
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
  const toolRanges = manifest.compatibility?.tools ?? {
    node: `=${manifest.tools.node}`,
    npm: `=${manifest.tools.npm}`,
    codex: `=${manifest.tools.codex}`
  };
  const checks = {
    platform: { ok: process.platform === manifest.platform.os, actual: process.platform, expected: manifest.platform.os },
    architecture: { ok: process.arch === manifest.platform.architecture, actual: process.arch, expected: manifest.platform.architecture },
    node: { ok: isVersionCompatible(process.version, toolRanges.node), actual: process.version.slice(1), expected: toolRanges.node },
    npm: { ok: npm.ok && isVersionCompatible(npm.value, toolRanges.npm), actual: npm.value, expected: toolRanges.npm },
    codex: { ok: codex.ok && isVersionCompatible(codex.value, toolRanges.codex), actual: codex.value, expected: toolRanges.codex },
    codexDoctor: {
      ok: doctorReport !== null && doctorCriticalChecks.every((id) => doctorReport.checks?.[id]?.status === "ok"),
      actual: doctorReport === null
        ? codexDoctor.code
        : doctorCriticalChecks.every((id) => doctorReport.checks?.[id]?.status === "ok")
          ? "critical checks ok"
          : doctorReport.overallStatus
    },
    codexLogin: { ok: /logged in/iu.test(login.value ?? ""), actual: login.value || login.code },
    dataDirectory: { ok: fs.existsSync(data.root) && (fs.statSync(data.root).mode & 0o777) === 0o700, actual: data.root },
    writingSkills: { ok: ["korean-humanizer", "waza"].every((id) => installedSkills.includes(id)), actual: installedSkills }
  };
  return { ok: Object.values(checks).every((check) => check.ok), version: manifest.displayVersion, dataDirectory: data.root, checks };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runDoctor();
  if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(`oz-inblog ${result.version} doctor\n`);
    for (const [name, check] of Object.entries(result.checks)) process.stdout.write(`${check.ok ? "PASS" : "FAIL"} ${name}: ${Array.isArray(check.actual) ? check.actual.join(", ") : check.actual}\n`);
    process.stdout.write(`Data: ${result.dataDirectory}\n`);
  }
  if (!result.ok) process.exitCode = 1;
}
