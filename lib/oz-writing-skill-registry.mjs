import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_CODEX_SKILLS_ROOT = path.join(os.homedir(), ".codex", "skills");

export class WritingSkillError extends Error {
  constructor(code, message, { status = 500, retryable = false, fieldErrors = undefined, details = undefined } = {}) {
    super(message);
    this.name = "WritingSkillError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.fieldErrors = fieldErrors;
    this.details = details;
  }
}

const WRITING_SKILLS = Object.freeze({
  "korean-humanizer": Object.freeze({
    id: "korean-humanizer",
    label: "Humanizer",
    locale: "ko",
    mode: "inline-transform",
    discovery: "configured-or-codex-skills-root",
    outputSchema: "writing-markdown",
    deterministicValidators: Object.freeze(["preserve_urls", "preserve_numbers", "preserve_information", "preserve_headings"]),
    envPath: "OZ_KOREAN_HUMANIZER_SKILL_PATH",
    skillDirectory: "korean-humanizer",
    requiredReferences: Object.freeze(["references/ko-ai-signals.md"])
  }),
  waza: Object.freeze({
    id: "waza",
    label: "Waza",
    locale: "ko",
    mode: "inline-transform",
    discovery: "configured-or-waza-plugin-cache",
    outputSchema: "writing-markdown",
    deterministicValidators: Object.freeze(["preserve_urls", "preserve_numbers", "preserve_information", "preserve_headings"]),
    envPath: "OZ_WAZA_WRITE_SKILL_PATH",
    skillDirectory: "write",
    pluginCacheDirectory: path.join("waza", "waza"),
    pluginSkillDirectory: path.join("skills", "write"),
    requiredReferences: Object.freeze([])
  })
});

function isReadableFile(filePath) {
  try {
    return fs.statSync(filePath).isFile() && fs.accessSync(filePath, fs.constants.R_OK) === undefined;
  } catch {
    return false;
  }
}

function candidateSkillPaths(definition, { env = process.env, skillsRoot = undefined } = {}) {
  const candidates = [];
  const configuredPath = env?.[definition.envPath];
  if (typeof configuredPath === "string" && configuredPath.trim()) candidates.push(path.resolve(configuredPath.trim()));
  const configuredRoot = env?.OZ_WRITING_SKILLS_ROOT;
  const roots = [
    skillsRoot,
    configuredRoot,
    env?.CODEX_HOME ? path.join(env.CODEX_HOME, "skills") : null,
    DEFAULT_CODEX_SKILLS_ROOT
  ].filter((value) => typeof value === "string" && value.trim());
  roots.forEach((root) => candidates.push(path.join(path.resolve(root), definition.skillDirectory, "SKILL.md")));
  if (definition.pluginCacheDirectory && definition.pluginSkillDirectory) {
    const pluginRoots = roots.map((root) => path.join(path.dirname(path.resolve(root)), "plugins", "cache", definition.pluginCacheDirectory));
    for (const pluginRoot of pluginRoots) {
      let versions = [];
      try {
        versions = fs.readdirSync(pluginRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort()
          .reverse();
      } catch {
        versions = [];
      }
      versions.forEach((version) => candidates.push(path.join(pluginRoot, version, definition.pluginSkillDirectory, "SKILL.md")));
    }
  }
  return [...new Set(candidates)];
}

function referencePath(skillPath, referenceName) {
  return path.resolve(path.dirname(skillPath), referenceName);
}

export function getWritingSkillDefinition(skillId) {
  return typeof skillId === "string" ? WRITING_SKILLS[skillId] ?? null : null;
}

export function listWritingSkillDefinitions() {
  return Object.values(WRITING_SKILLS).map(({ id, label, locale, mode }) => ({ id, label, locale, mode }));
}

export function loadWritingSkillBundle(skillId, { env = process.env, skillsRoot = undefined } = {}) {
  const definition = getWritingSkillDefinition(skillId);
  if (!definition) {
    throw new WritingSkillError("unknown_skill", "The requested writing Skill is not available.", {
      status: 422,
      fieldErrors: { skillId: "skillId is not supported." }
    });
  }
  const skillPath = candidateSkillPaths(definition, { env, skillsRoot }).find(isReadableFile);
  if (!skillPath) {
    throw new WritingSkillError("skill_unavailable", `${definition.label} Skill is not installed or readable.`, { status: 503, retryable: false });
  }
  let content;
  try {
    content = fs.readFileSync(skillPath, "utf8");
  } catch {
    throw new WritingSkillError("skill_unavailable", `${definition.label} Skill could not be read.`, { status: 503, retryable: false });
  }
  const references = definition.requiredReferences.map((referenceName) => {
    const filePath = referencePath(skillPath, referenceName);
    if (!isReadableFile(filePath)) {
      throw new WritingSkillError("skill_unavailable", `${definition.label} Skill reference ${path.basename(filePath)} could not be read.`, { status: 503, retryable: false });
    }
    try {
      return { name: path.basename(filePath), path: filePath, content: fs.readFileSync(filePath, "utf8") };
    } catch {
      throw new WritingSkillError("skill_unavailable", `${definition.label} Skill reference ${path.basename(filePath)} could not be read.`, { status: 503, retryable: false });
    }
  });
  return {
    definition,
    skill: { name: "SKILL.md", path: skillPath, content },
    references
  };
}

export function listAvailableWritingSkills(options = {}) {
  return listWritingSkillDefinitions().filter((definition) => {
    try {
      loadWritingSkillBundle(definition.id, options);
      return true;
    } catch {
      return false;
    }
  });
}
