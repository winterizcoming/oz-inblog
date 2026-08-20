import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uiRoot = path.join(root, "ui", "v0-3");
const index = fs.readFileSync(path.join(uiRoot, "index.html"), "utf8");
const styles = fs.readFileSync(path.join(uiRoot, "styles.css"), "utf8");
const app = fs.readFileSync(path.join(uiRoot, "app.js"), "utf8");
const required = [
  [index, "aria-label=\"Conversation\""],
  [index, "/assets/ozinblog_logo.svg"],
  [index, "src=\"/app.js\""],
  [app, "brunch-chat-state.js"]
];
const failures = required.filter(([content, token]) => !content.includes(token)).map(([, token]) => `missing UI contract: ${token}`);
if (!fs.existsSync(path.join(uiRoot, "assets", "ozinblog_logo.svg"))) failures.push("brand asset is missing");
if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("oz-inblog UI contract OK\n");
}
