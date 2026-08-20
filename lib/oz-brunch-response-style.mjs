const LEADING_CONNECTOR_PATTERN = /(^|[.!?]\s+|\n)(그리고|그래서|그러나|하지만|따라서|또한|반면|즉)\s+/gu;
const FORBIDDEN_WORDS = [
  "축", "결", "흐름", "구조", "기준", "박다", "굴리다", "넓히다", "좁히다", "열다", "닫다", "붙다", "두께", "두텁다", "척추", "등뼈", "해자", "박하게", "다투다"
];
const FORBIDDEN_WORD_PATTERN = new RegExp(`(?<![가-힣])(?:${FORBIDDEN_WORDS.map((word) => word.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")).join("|")})(?![가-힣])`, "gu");
const CONTRAST_PATTERN = /[^.!?\n]{0,100}(?:가|이|은|는)\s*(?:아니라|라기보다)\s+[^.!?\n]{1,100}/gu;
const NEGATED_MEANING_PATTERN = /[^.!?\n]{0,100}(?:뜻|상황|역할)[^.!?\n]{0,60}(?:이|가)\s*아니(?:다|었습니다|라고)/gu;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function publicFields(response) {
  const fields = [
    ["markdown", response?.markdown],
    ["question", response?.question],
    ...((response?.choices ?? []).flatMap((choice, index) => [
      [`choices[${index}].label`, choice?.label],
      [`choices[${index}].description`, choice?.description]
    ])),
    ["writing_preview.markdown", response?.writing_preview?.markdown]
  ];
  return fields.filter(([, value]) => typeof value === "string" && value.trim());
}

export function stripLeadingBrunchConnectors(value) {
  return String(value ?? "").replace(LEADING_CONNECTOR_PATTERN, "$1");
}

export function lintBrunchResponseStyle(response) {
  const violations = [];
  for (const [field, value] of publicFields(response)) {
    const connectorMatches = [...value.matchAll(LEADING_CONNECTOR_PATTERN)];
    connectorMatches.forEach((match) => violations.push({ rule: "leading_connector", field, match: match[2] }));
    const forbiddenMatches = [...value.matchAll(FORBIDDEN_WORD_PATTERN)];
    forbiddenMatches.forEach((match) => violations.push({ rule: "forbidden_word", field, match: match[0] }));
    const contrastMatches = [...value.matchAll(CONTRAST_PATTERN)];
    contrastMatches.forEach((match) => violations.push({ rule: "negative_contrast", field, match: match[0].trim() }));
    const negatedMatches = [...value.matchAll(NEGATED_MEANING_PATTERN)];
    negatedMatches.forEach((match) => violations.push({ rule: "negative_explanation", field, match: match[0].trim() }));
  }
  return { valid: violations.length === 0, violations: violations.slice(0, 100) };
}

export function applySafeBrunchStyleCleanup(response) {
  const next = clone(response);
  if (!next || typeof next !== "object") return next;
  if (typeof next.markdown === "string") next.markdown = stripLeadingBrunchConnectors(next.markdown);
  if (typeof next.question === "string") next.question = stripLeadingBrunchConnectors(next.question);
  if (Array.isArray(next.choices)) {
    next.choices = next.choices.map((choice) => ({
      ...choice,
      ...(typeof choice?.label === "string" ? { label: stripLeadingBrunchConnectors(choice.label) } : {}),
      ...(typeof choice?.description === "string" ? { description: stripLeadingBrunchConnectors(choice.description) } : {})
    }));
  }
  if (typeof next.writing_preview?.markdown === "string") {
    next.writing_preview.markdown = stripLeadingBrunchConnectors(next.writing_preview.markdown);
  }
  return next;
}

export { FORBIDDEN_WORDS };
