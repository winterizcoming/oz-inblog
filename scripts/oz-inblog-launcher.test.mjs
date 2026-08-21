import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isNewerVersion, readLatestRelease, syncInstalledApp, versionParts } from "./oz-inblog-launcher.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("launcher compares release versions without opening the app", () => {
  assert.deepEqual(versionParts("v1.0.0-alpha.7"), [1, 0, 0, 0, 7]);
  assert.equal(isNewerVersion("1.0.0-alpha.8", "1.0.0-alpha.7"), true);
  assert.equal(isNewerVersion("1.0.0-alpha.7", "1.0.0-alpha.7"), false);
  assert.equal(isNewerVersion("1.0.0-alpha.6", "1.0.0-alpha.7"), false);
  assert.equal(isNewerVersion("1.0.0", "1.0.0-alpha.7"), true);
});

test("launcher discovers newer prerelease releases from the GitHub release list", async () => {
  const calls = [];
  const latest = await readLatestRelease({ packageVersion: "1.0.0-alpha.7", displayVersion: "v1.0a" }, {
    request: async (url) => {
      calls.push(url);
      if (url.includes("/releases?per_page=30")) return JSON.stringify([{ tag_name: "v1.0.0-alpha.8", html_url: "https://github.com/winterizcoming/oz-inblog/releases/tag/v1.0.0-alpha.8", prerelease: true, draft: false }]);
      return JSON.stringify({ packageVersion: "1.0.0-alpha.8", gitTag: "v1.0.0-alpha.8", displayVersion: "v1.0a" });
    }
  });

  assert.equal(latest.tag, "v1.0.0-alpha.8");
  assert.equal(calls[0].includes("/releases?per_page=30"), true);
});

test("launcher keeps one canonical app and archives duplicate app copies", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oz-inblog-launcher-"));
  const releaseRoot = path.join(temporaryRoot, "release");
  const sourceApp = path.join(releaseRoot, "oz-inblog.app");
  const sourceInfo = path.join(sourceApp, "Contents", "Info.plist");
  const userHome = path.join(temporaryRoot, "home");
  const userApp = path.join(userHome, "Applications", "oz-inblog.app");
  const systemApp = path.join(temporaryRoot, "Applications", "oz-inblog.app");
  const plist = (version) => `<?xml version="1.0"?><plist><dict><key>CFBundleVersion</key><string>${version}</string></dict></plist>`;

  fs.mkdirSync(path.dirname(sourceInfo), { recursive: true });
  fs.writeFileSync(sourceInfo, plist("1.0.0-alpha.8"));
  fs.mkdirSync(path.join(userApp, "Contents"), { recursive: true });
  fs.writeFileSync(path.join(userApp, "Contents", "Info.plist"), plist("1.0.0-alpha.6"));
  fs.mkdirSync(path.join(systemApp, "Contents"), { recursive: true });
  fs.writeFileSync(path.join(systemApp, "Contents", "Info.plist"), plist("1.0.0-alpha.6"));

  const result = syncInstalledApp({
    manifest: { packageVersion: "1.0.0-alpha.8" },
    rootDirectory: releaseRoot,
    userHome,
    launchedAppPath: userApp,
    systemAppPath: systemApp,
    userAppPath: userApp
  });

  assert.equal(result.canonicalPath, userApp);
  assert.equal(result.synced, true);
  assert.equal(fs.readFileSync(path.join(userApp, "Contents", "Info.plist"), "utf8").includes("1.0.0-alpha.8"), true);
  assert.equal(fs.existsSync(systemApp), false);
  assert.equal(result.archived.length, 1);
});

test("macOS launcher bundle keeps the release entrypoint and supplied icon", () => {
  const sourceAppRoot = path.join(root, "packaging", "macos", "OZ Inblog.app");
  const appRoot = fs.existsSync(sourceAppRoot) ? sourceAppRoot : path.join(root, "oz-inblog.app");
  const info = fs.readFileSync(path.join(appRoot, "Contents", "Info.plist"), "utf8");
  const launcher = path.join(appRoot, "Contents", "MacOS", "oz-inblog");

  assert.match(info, /<key>CFBundleExecutable<\/key>\s*<string>oz-inblog<\/string>/u);
  assert.match(info, /<key>CFBundleIconFile<\/key>\s*<string>oz-inblog-icon\.png<\/string>/u);
  assert.equal(fs.existsSync(path.join(appRoot, "Contents", "Resources", "oz-inblog-icon.png")), true);
  assert.equal((fs.statSync(launcher).mode & 0o111) !== 0, true);
});

test("the browser title uses the oz:inblog editor name", () => {
  const index = fs.readFileSync(path.join(root, "ui", "v0-3", "index.html"), "utf8");
  const catalog = fs.readFileSync(path.join(root, "ui", "copy-catalog.js"), "utf8");

  assert.match(index, /<title>oz:inblog editor<\/title>/u);
  assert.match(catalog, /pageTitle:\s*"oz:inblog editor"/u);
});
