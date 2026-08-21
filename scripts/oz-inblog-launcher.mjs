import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.OZ_INBLOG_HOME || path.join(os.homedir(), "Library", "Application Support", "oz-inblog");
const port = Number(process.env.PORT || 4174);
const repository = process.env.OZ_INBLOG_RELEASE_REPOSITORY || "winterizcoming/oz-inblog";
const appUrl = `http://127.0.0.1:${port}`;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function currentManifest() {
  try { return readJson(path.join(root, "release-manifest.json")); } catch { return { packageVersion: "0.0.0", displayVersion: "unknown" }; }
}

function versionParts(value) {
  return String(value ?? "0").replace(/^v/u, "").split(/[.-]/u).map((part) => Number.parseInt(part, 10) || 0);
}

function isNewerVersion(candidate, current) {
  const left = versionParts(candidate);
  const right = versionParts(current);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) > (right[index] ?? 0);
  }
  return false;
}

function requestText(url, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https:") ? https : http;
    const request = client.get(url, { headers: { accept: "application/json", "user-agent": "oz-inblog-launcher" } }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`update request returned ${response.statusCode}`));
        return;
      }
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("update request timed out")));
    request.on("error", reject);
  });
}

async function readLatestRelease(manifest) {
  if (process.env.OZ_INBLOG_DISABLE_UPDATE_CHECK === "1") return null;
  try {
    const release = JSON.parse(await requestText(`https://api.github.com/repos/${repository}/releases/latest`));
    const tag = typeof release.tag_name === "string" ? release.tag_name : "";
    const remoteManifest = JSON.parse(await requestText(`https://raw.githubusercontent.com/${repository}/${encodeURIComponent(tag)}/release-manifest.json`));
    if (!isNewerVersion(remoteManifest.packageVersion, manifest.packageVersion)) return null;
    return { tag, manifest: remoteManifest, url: release.html_url || `https://github.com/${repository}/releases/latest` };
  } catch {
    return null;
  }
}

async function askUpdate(latest, current) {
  const message = `새 버전 ${latest.manifest.displayVersion} (${latest.manifest.packageVersion})을 사용할 수 있습니다.\n현재 버전: ${current.displayVersion}\n\n업데이트 안내를 클립보드에 복사할까요?`;
  try {
    const result = await execFileAsync("/usr/bin/osascript", ["-e", `display dialog ${JSON.stringify(message)} with title "oz:inblog editor" buttons {"나중에", "업데이트 안내 복사"} default button "업데이트 안내 복사"`]);
    if (!String(result.stdout).includes("업데이트 안내 복사")) return;
  } catch {
    return;
  }
  const prompt = `GitHub의 https://github.com/${repository}/tree/${latest.tag} 에 있는 INSTALL.md와 release-manifest.json을 읽고 oz-inblog ${latest.manifest.displayVersion}으로 업데이트해줘. 기존 데이터와 설정은 보존하고 release checksum을 검증한 뒤 doctor, test, smoke를 통과시키고 로컬 서비스를 재시작해줘.`;
  try {
    await copyToClipboard(prompt);
    await execFileAsync("/usr/bin/open", [latest.url]);
  } catch {
    process.stderr.write(`${prompt}\n`);
  }
}

function checkHealth() {
  return new Promise((resolve) => {
    const request = http.get(`${appUrl}/healthz`, { timeout: 800 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on("error", () => resolve(false));
    request.on("timeout", () => { request.destroy(); resolve(false); });
  });
}

async function copyToClipboard(value) {
  await new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`pbcopy exited with ${code}`)));
    child.stdin.end(value);
  });
}

async function waitForHealth(timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await checkHealth()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function findNode() {
  const candidates = [process.env.OZ_NODE_BIN, "/opt/homebrew/bin/node", "/usr/local/bin/node", process.execPath].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || "node";
}

async function startServer() {
  if (await checkHealth()) return false;
  const configDir = path.join(home, "config");
  const dataDir = path.join(home, "data");
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(configDir, "oz-inblog-service.log");
  const output = fs.openSync(logPath, "a");
  const child = spawn(findNode(), ["--env-file-if-exists=.env", "scripts/oz-inblog-server.mjs"], {
    cwd: root,
    detached: true,
    env: { ...process.env, PORT: String(port), OZ_DATA_DIR: dataDir },
    stdio: ["ignore", output, output]
  });
  child.unref();
  fs.writeFileSync(path.join(configDir, "oz-inblog-service.pid"), `${child.pid}\n`, { mode: 0o600 });
  if (!(await waitForHealth())) throw new Error("oz-inblog server did not become healthy within 30 seconds.");
  return true;
}

async function openApp() {
  const manifest = currentManifest();
  await startServer();
  const latest = await readLatestRelease(manifest);
  if (latest) await askUpdate(latest, manifest);
  await execFileAsync("/usr/bin/open", [appUrl]);
}

if (process.argv.includes("--open")) {
  openApp().catch((error) => {
    process.stderr.write(`oz-inblog could not start: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { isNewerVersion, versionParts };
