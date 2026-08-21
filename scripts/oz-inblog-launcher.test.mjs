import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isNewerVersion, versionParts } from "./oz-inblog-launcher.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("launcher compares release versions without opening the app", () => {
  assert.deepEqual(versionParts("v1.0.0-alpha.5"), [1, 0, 0, 0, 5]);
  assert.equal(isNewerVersion("1.0.0-alpha.6", "1.0.0-alpha.5"), true);
  assert.equal(isNewerVersion("1.0.0-alpha.5", "1.0.0-alpha.5"), false);
  assert.equal(isNewerVersion("1.0.0-alpha.4", "1.0.0-alpha.5"), false);
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
