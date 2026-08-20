import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

export const CODEX_PROVIDER_MODEL = "gpt-5.6-luna";
export const CODEX_PROVIDER_REASONING_EFFORTS = Object.freeze({ high: "high", medium: "medium" });

const HIGH_REASONING_STEPS = new Set([
  "topic_selection",
  "topic_refinement",
  "angle_selection",
  "title_selection",
  "outline_review",
  "draft_review"
]);

export function plannerReasoningEffort(targetStep, { repair = false } = {}) {
  if (repair || !HIGH_REASONING_STEPS.has(targetStep)) return CODEX_PROVIDER_REASONING_EFFORTS.medium;
  return CODEX_PROVIDER_REASONING_EFFORTS.high;
}

export const PROVIDER_TIMEOUTS_MS = Object.freeze({
  track_selection: 30000,
  purpose_selection: 30000,
  source_selection: 30000,
  topic_selection: 90000,
  topic_refinement: 90000,
  outline_review: 120000,
  draft_review: 180000,
  publish_package_review: 120000,
  default: 120000
});

export function textByteLength(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

export function shortHash(value) {
  return crypto.createHash("sha256").update(String(value ?? ""), "utf8").digest("hex").slice(0, 16);
}

export function summarizeProcessResult(result) {
  return {
    command: "codex exec",
    model: result?.model ?? CODEX_PROVIDER_MODEL,
    reasoning_effort: result?.reasoning_effort ?? null,
    timeout_ms: result?.timeout_ms ?? null,
    started_at: result?.started_at ?? null,
    ended_at: result?.ended_at ?? null,
    duration_ms: result?.duration_ms ?? null,
    exit_code: result?.code ?? null,
    aborted: result?.aborted === true,
    stdout_bytes: textByteLength(result?.stdout),
    stderr_bytes: textByteLength(result?.stderr),
    stdout_hash: shortHash(result?.stdout),
    stderr_hash: shortHash(result?.stderr)
  };
}

export function writeEvidence(root, file, body) {
  const evidenceDir = path.join(root, ".omo", "evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, file), body);
}

export function summarizeProcessFailure(result, fallback = "Codex process failed") {
  if (!result) return fallback;

  if (result.aborted) {
    return "Codex planner generation was cancelled.";
  }

  const stderr = String(result.stderr ?? "");
  const stdout = String(result.stdout ?? "");
  const combined = `${stderr}\n${stdout}`;

  if (/usage limit|You've hit your usage limit|try again at/i.test(combined)) {
    const match = combined.match(/try again at\s+([^\.\n]+)\.?/i);
    const reset = match?.[1]?.trim();
    return reset
      ? `Codex usage limit reached. Try again at ${reset}.`
      : "Codex usage limit reached. Try again after the limit resets.";
  }

  if (result.code === 124 || /Timed out after\s+\d+s/i.test(combined)) {
    return "Codex planner generation timed out. The model did not return JSON within the provider timeout.";
  }

  if (/not authenticated|authentication|login required|unauthorized/i.test(combined)) {
    return "Codex is not authenticated. Please sign in to Codex and try again.";
  }

  if (/rate limit|too many requests/i.test(combined)) {
    return "Codex rate limit reached. Please wait and try again.";
  }

  if (/output-last-message/i.test(combined) && /No such file|ENOENT/i.test(combined)) {
    return "Codex did not write an output message file.";
  }

  const errorLine = combined
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^ERROR:/i.test(line));

  if (errorLine) {
    const errorText = errorLine.replace(/^ERROR:\s*/i, "").trim();
    try {
      const parsed = JSON.parse(errorText);
      const message = parsed?.error?.message ?? parsed?.message;
      if (typeof message === "string" && message.trim()) return message.trim().slice(0, 240);
    } catch {
      // Keep the plain-text error when stderr is not JSON.
    }
    return errorText.replace(/[{}\[\]"]+/g, "").replace(/\s+/g, " ").trim().slice(0, 240);
  }

  return `${fallback}: exited ${result.code ?? "unknown"}. See .omo/evidence for full logs.`;
}

export function buildCodexExecArgs({ root, rawPath, prompt, outputSchemaPath, model = CODEX_PROVIDER_MODEL, reasoningEffort = CODEX_PROVIDER_REASONING_EFFORTS.medium }) {
  return [
    "exec",
    "--model",
    model,
    "-c",
    `model_reasoning_effort=\"${reasoningEffort}\"`,
    "--cd",
    root,
    "--sandbox",
    "read-only",
    "--ephemeral",
    "--ignore-user-config",
    "--output-last-message",
    rawPath,
    ...(outputSchemaPath ? ["--output-schema", outputSchemaPath] : []),
    prompt
  ];
}

export function runProcess({ root, rawPath, prompt, timeoutMs = 15000, signal, outputSchemaPath, model = CODEX_PROVIDER_MODEL, reasoningEffort = CODEX_PROVIDER_REASONING_EFFORTS.medium }) {
  fs.mkdirSync(path.dirname(rawPath), { recursive: true });
  if (fs.existsSync(rawPath)) {
    fs.unlinkSync(rawPath);
  }

  const args = buildCodexExecArgs({ root, rawPath, prompt, outputSchemaPath, model, reasoningEffort });

  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const child = spawn("codex", args, {
      cwd: root,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve({
        ...result,
        model,
        reasoning_effort: reasoningEffort,
        timeout_ms: timeoutMs,
        started_at: startedAt,
        ended_at: new Date().toISOString(),
        duration_ms: Date.now() - startedMs
      });
    }

    function terminate() {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
          return;
        } catch {
          // Fall through to terminating the direct child.
        }
      }
      child.kill("SIGTERM");
    }

    function abort() {
      terminate();
      finish({ code: 130, aborted: true, stdout, stderr: `${stderr}\nCancelled by request` });
    }

    const timer = setTimeout(() => {
      terminate();
      finish({ code: 124, stdout, stderr: `${stderr}\nTimed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);

    if (signal?.aborted) {
      abort();
      return;
    }

    signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      finish({ code: code ?? 1, stdout, stderr });
    });

    child.on("error", (error) => {
      finish({ code: 127, stdout, stderr: error.message });
    });
  });
}

export function extractLastJsonObject(raw) {
  const trimmed = raw.trim();
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // Runtime output can contain logs followed by more than one JSON object.
  }

  const stack = [];
  let start = -1;
  let lastObject = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      if (stack.length === 0) start = index;
      stack.push(character);
      continue;
    }
    if (character === "}" || character === "]") {
      const expected = character === "}" ? "{" : "[";
      if (stack.at(-1) === expected) stack.pop();
      if (stack.length === 0 && start >= 0 && character === "}") {
        lastObject = trimmed.slice(start, index + 1);
        start = -1;
      }
    }
  }

  if (lastObject) return lastObject;

  // Codex occasionally emits a complete response with only the final closing
  // brace omitted. Schema and semantic validation still run after extraction,
  // so incomplete or otherwise invalid responses remain rejected.
  if (start >= 0 && stack.length > 0 && !inString) {
    const closing = [...stack].reverse().map((opening) => opening === "{" ? "}" : "]").join("");
    return `${trimmed.slice(start)}${closing}`;
  }

  return trimmed;
}
