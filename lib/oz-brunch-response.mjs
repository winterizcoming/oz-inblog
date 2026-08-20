import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { extractLastJsonObject } from "../scripts/codex-provider-common.mjs";
import { removeAppServerNullableFields } from "./oz-brunch-transport-normalizer.mjs";
import { applySafeBrunchStyleCleanup } from "./oz-brunch-response-style.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brunchResponseSchema = JSON.parse(fs.readFileSync(path.join(ROOT, "schema", "brunch-chat-response.schema.json"), "utf8"));
const validateBrunchResponseSchema = new Ajv2020({ allErrors: true, strict: false }).compile(brunchResponseSchema);

export function buildAppServerOutputSchema() {
  const schema = structuredClone(brunchResponseSchema);
  delete schema.allOf;
  schema.required = Object.keys(schema.properties);
  schema.properties.question = { type: ["string", "null"] };
  const preview = schema.properties.writing_preview;
  preview.properties.subtitle = { type: ["string", "null"] };
  preview.required = Object.keys(preview.properties);
  schema.properties.writing_preview = { anyOf: [preview, { type: "null" }] };
  return schema;
}

export function normalizeBrunchText(value) {
  return String(value ?? "")
    .replaceAll("\\r\\n", "\n")
    .replaceAll("\\n", "\n")
    .replaceAll("\\r", "\n");
}

function normalizeChoices(value) {
  if (!Array.isArray(value)) throw new Error("choices must be an array");
  return value.map((choice, index) => {
    if (!choice || typeof choice !== "object" || Array.isArray(choice)) throw new Error(`choice ${index + 1} must be an object`);
    if (typeof choice.label !== "string" || !choice.label.trim()) throw new Error(`choice ${index + 1} label must be a non-empty string`);
    if (typeof choice.description !== "string" || !choice.description.trim()) throw new Error(`choice ${index + 1} description must be a non-empty string`);
    return { label: normalizeBrunchText(choice.label).trim(), description: normalizeBrunchText(choice.description).trim() };
  });
}

function normalizeQuestion(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("question must be a string when present");
  const question = normalizeBrunchText(value).trim();
  if (!question) throw new Error("question must be a non-empty string when present");
  return question;
}

export function normalizeWritingPreview(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("writing_preview must be an object when present");
  if (typeof value.title !== "string" || !value.title.trim()) throw new Error("writing_preview.title must be a non-empty string");
  if ("subtitle" in value && typeof value.subtitle !== "string") throw new Error("writing_preview.subtitle must be a string when present");
  if (typeof value.markdown !== "string" || !value.markdown.trim()) throw new Error("writing_preview.markdown must be a non-empty string");
  return {
    title: normalizeBrunchText(value.title).trim(),
    ...(typeof value.subtitle === "string" ? { subtitle: normalizeBrunchText(value.subtitle).trim() } : {}),
    markdown: normalizeBrunchText(value.markdown).trim()
  };
}

export function normalizeResponse(value, rawFallback) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("response must be an object");
  if (typeof value.markdown !== "string" || !value.markdown.trim()) throw new Error("markdown must be a non-empty string");
  const choices = normalizeChoices(value.choices);
  const question = normalizeQuestion(value.question);
  const writingPreview = normalizeWritingPreview(value.writing_preview);
  const response = applySafeBrunchStyleCleanup({
    markdown: normalizeBrunchText(value.markdown).trim(),
    choices,
    ...(question ? { question } : {}),
    ...(writingPreview ? { writing_preview: writingPreview } : {})
  });
  if (!validateBrunchResponseSchema(response)) {
    const details = validateBrunchResponseSchema.errors?.map((error) => `${error.instancePath || "response"} ${error.message}`).join("; ");
    throw new Error(details || "response does not match the Brunch chat contract");
  }
  return response;
}

export function parseModelResponse(raw) {
  const text = String(raw ?? "");
  const parseCandidate = (candidate, parseMode) => {
    try {
      return { response: normalizeResponse(removeAppServerNullableFields(JSON.parse(candidate))), parseMode, valid: true };
    } catch (error) {
      return { response: null, parseMode, valid: false, errorCode: "invalid_model_response", errorMessage: error instanceof Error ? error.message : String(error) };
    }
  };
  const trimmed = text.trim();
  try {
    JSON.parse(trimmed);
    return parseCandidate(trimmed, "json");
  } catch {
    const candidate = extractLastJsonObject(text);
    if (candidate !== text) return parseCandidate(candidate, "json-object");
    return { response: null, parseMode: "raw-markdown", valid: false, errorCode: "invalid_model_response", errorMessage: "response must be a single valid Brunch chat JSON object" };
  }
}
