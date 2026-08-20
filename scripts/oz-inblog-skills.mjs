import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { loadReleaseManifest } from "../lib/oz-inblog-release.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = loadReleaseManifest(root);
const humanizer = manifest.externalSkills.find((skill) => skill.id === "korean-humanizer");
const waza = manifest.externalSkills.find((skill) => skill.id === "waza");
const humanizerPath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "skills", "korean-humanizer");

async function gitHead(directory) {
  try { return (await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"], { timeout: 20_000 })).stdout.trim(); }
  catch { return null; }
}

async function pluginList() {
  try { return JSON.parse((await execFileAsync("codex", ["plugin", "list", "--json"], { timeout: 30_000 })).stdout).installed ?? []; }
  catch { return []; }
}

export async function verifySkills() {
  const humanizerHead = await gitHead(humanizerPath);
  const plugins = await pluginList();
  const installedWaza = plugins.find((plugin) => plugin.pluginId === "waza@waza");
  return {
    ok: humanizerHead === humanizer.version && installedWaza?.enabled === true && `v${installedWaza.version}` === waza.version,
    skills: {
      "korean-humanizer": { ok: humanizerHead === humanizer.version, expected: humanizer.version, actual: humanizerHead, path: humanizerPath },
      waza: { ok: installedWaza?.enabled === true && `v${installedWaza.version}` === waza.version, expected: waza.version, actual: installedWaza?.version ? `v${installedWaza.version}` : null }
    }
  };
}

async function installHumanizer() {
  const current = await gitHead(humanizerPath);
  if (current === humanizer.version) return "skipped";
  if (fs.existsSync(humanizerPath)) throw new Error(`korean-humanizer version conflict at ${humanizerPath}`);
  const parent = path.dirname(humanizerPath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "oz-inblog-humanizer-"));
  try {
    await execFileAsync("git", ["clone", "--no-checkout", humanizer.repository, temporary], { timeout: 120_000 });
    await execFileAsync("git", ["-C", temporary, "checkout", "--detach", humanizer.version], { timeout: 60_000 });
    fs.renameSync(temporary, humanizerPath);
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  return "installed";
}

async function installWaza() {
  const plugins = await pluginList();
  const current = plugins.find((plugin) => plugin.pluginId === "waza@waza");
  if (current?.enabled && `v${current.version}` === waza.version) return "skipped";
  if (current) throw new Error(`waza version conflict: installed ${current.version}, expected ${waza.version}`);
  await execFileAsync("codex", ["plugin", "marketplace", "add", "tw93/Waza", "--ref", waza.version, "--json"], { timeout: 120_000 });
  await execFileAsync("codex", ["plugin", "add", "waza@waza", "--json"], { timeout: 120_000 });
  return "installed";
}

const command = process.argv[2] || "verify";
if (!new Set(["install", "verify"]).has(command)) throw new Error("Usage: npm run install:skills or npm run verify:skills");
if (command === "install") {
  const changes = { "korean-humanizer": await installHumanizer(), waza: await installWaza() };
  const verification = await verifySkills();
  process.stdout.write(`${JSON.stringify({ ...verification, changes }, null, 2)}\n`);
  if (!verification.ok) process.exitCode = 1;
} else {
  const verification = await verifySkills();
  process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);
  if (!verification.ok) process.exitCode = 1;
}
