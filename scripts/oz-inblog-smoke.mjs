import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createOzInblogServer } from "./oz-inblog-server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryData = fs.mkdtempSync(path.join(os.tmpdir(), "oz-inblog-smoke-"));
const server = createOzInblogServer({ root, env: { ...process.env, OZ_DATA_DIR: temporaryData }, codexStatus: async () => ({ ready: true }) });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const checks = await Promise.all([
    fetch(`${base}/healthz`),
    fetch(`${base}/readyz`),
    fetch(`${base}/api/meta`),
    fetch(`${base}/`),
    fetch(`${base}/api/oz-brunch-chat/capabilities`)
  ]);
  if (checks.some((response) => !response.ok)) throw new Error(`Smoke endpoint failed: ${checks.map((response) => response.status).join(",")}`);
  const html = await checks[3].text();
  if (!html.includes("ozinblog") || !html.includes("v1.0a")) throw new Error("Existing UI identity check failed.");
  process.stdout.write(`${JSON.stringify({ ok: true, endpoints: checks.length, dataIsolation: temporaryData }, null, 2)}\n`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(temporaryData, { recursive: true, force: true });
}
