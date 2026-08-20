import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadReleaseManifest, releaseMetadata } from "../lib/oz-inblog-release.mjs";
import { createSecureDataDirectories, resolveOzDataPaths } from "../lib/oz-inblog-data.mjs";
import { createOzInblogServer, defaultCodexStatus } from "./oz-inblog-server.mjs";
import { BrunchDebugTraceRecorder } from "../lib/oz-brunch-debug-trace.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("release metadata keeps display, package, and tag versions aligned", () => {
  // Given
  const manifest = loadReleaseManifest(root);

  // When
  const metadata = releaseMetadata(manifest, { buildSha: "abc123" });

  // Then
  assert.deepEqual(metadata, {
    displayVersion: "v1.0a",
    packageVersion: "1.0.0-alpha.2",
    tag: "v1.0.0-alpha.2",
    buildSha: "abc123"
  });
});

test("data paths use the macOS application support directory by default", () => {
  // Given
  const home = "/tmp/example-home";

  // When
  const paths = resolveOzDataPaths({ env: {}, home });

  // Then
  assert.equal(paths.root, "/tmp/example-home/Library/Application Support/oz-inblog/data");
  assert.equal(paths.sessions, "/tmp/example-home/Library/Application Support/oz-inblog/data/sessions");
  assert.equal(paths.debug, "/tmp/example-home/Library/Application Support/oz-inblog/data/debug");
});

test("data directories are private when created", () => {
  // Given
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oz-inblog-data-"));
  const paths = resolveOzDataPaths({ env: { OZ_DATA_DIR: temporaryRoot }, home: "/unused" });

  // When
  createSecureDataDirectories(paths);

  // Then
  assert.equal(fs.statSync(paths.root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(paths.sessions).mode & 0o777, 0o700);
  assert.equal(fs.statSync(paths.debug).mode & 0o777, 0o700);
});

test("Brunch-only server exposes release metadata and readiness", async (t) => {
  // Given
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oz-inblog-server-"));
  const server = createOzInblogServer({ root, env: { OZ_DATA_DIR: temporaryRoot }, codexStatus: async () => ({ ready: true }) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  // When
  const [health, ready, meta] = await Promise.all([
    fetch(`${baseUrl}/healthz`).then((response) => response.json()),
    fetch(`${baseUrl}/readyz`).then((response) => response.json()),
    fetch(`${baseUrl}/api/meta`).then((response) => response.json())
  ]);

  // Then
  assert.equal(health.ok, true);
  assert.equal(ready.ready, true);
  assert.equal(meta.displayVersion, "v1.0a");
  assert.equal(meta.packageVersion, "1.0.0-alpha.2");
});

test("public chat API rejects a caller-supplied runtime profile", async (t) => {
  // Given
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oz-inblog-server-"));
  const server = createOzInblogServer({ root, env: { OZ_DATA_DIR: temporaryRoot }, codexStatus: async () => ({ ready: true }) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();

  // When
  const response = await fetch(`http://127.0.0.1:${address.port}/api/oz-brunch-chat/generations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "test-session", message: "hello", runtimeProfile: "experimental-profile" })
  });

  // Then
  assert.equal(response.status, 422);
  assert.equal((await response.json()).code, "runtime_profile_not_configurable");
});

test("debug traces honor the external data directory", () => {
  // Given
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oz-inblog-debug-"));
  const debugRoot = path.join(temporaryRoot, "debug");

  // When
  const recorder = new BrunchDebugTraceRecorder({ root, sessionId: "session-a", enabled: true, debugDirectory: debugRoot });

  // Then
  assert.equal(recorder.baseDirectory, path.join(debugRoot, "session-a"));
});

test("readiness accepts Codex login reported on stderr", async () => {
  const status = await defaultCodexStatus({
    runCommand: async (command, args) => {
      assert.equal(command, "codex");
      if (args[0] === "doctor") return { stdout: JSON.stringify({ overallStatus: "ok" }), stderr: "" };
      return { stdout: "", stderr: "Logged in using ChatGPT\n" };
    }
  });

  assert.equal(status.ready, true);
  assert.equal(status.doctor.overallStatus, "ok");
});
