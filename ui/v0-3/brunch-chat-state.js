import { copyCatalog } from "../copy-catalog.js";

export const BRUNCH_CHAT_STORAGE_KEY = "oz-brunch-chat-session-v1";
export const BRUNCH_CHAT_STORAGE_VERSION = 3;
export const BRUNCH_CHAT_DEFAULT_MODEL = Object.freeze({ preset: "luna-medium", model: "gpt-5.6-luna", reasoningEffort: "medium" });
export const BRUNCH_CHAT_DEFAULT_MODEL_PRESET = BRUNCH_CHAT_DEFAULT_MODEL.preset;
export const BRUNCH_CURATED_RUNTIME_PROFILE = "v1.0a";
export const BRUNCH_LEGACY_CURATED_RUNTIME_PROFILE = "v07-curated-discovery";

export function isCuratedBrunchChatProfile(value) {
  return value === BRUNCH_CURATED_RUNTIME_PROFILE || value === BRUNCH_LEGACY_CURATED_RUNTIME_PROFILE;
}

export class BrunchChatStorageError extends Error {
  constructor(message, { recoveryKey = null } = {}) {
    super(message);
    this.name = "BrunchChatStorageError";
    this.code = "brunch_chat_storage_corrupt";
    this.recoveryKey = recoveryKey;
  }
}

export const BRUNCH_CHAT_WELCOME_CHOICES = Object.freeze([
  Object.freeze({ label: "오늘 쓸 만한 브런치 글감을 찾아줘", description: "아카이브와 최신 자료를 비교해 글감을 찾습니다" }),
  Object.freeze({ label: "쓰고 싶은 주제가 있어", description: "제시한 주제를 조사하고 논지를 좁힙니다" }),
  Object.freeze({ label: "작성한 초안을 검수해줘", description: "초안의 논지와 문장을 함께 점검합니다" })
]);

function normalizeBrunchChatText(value) {
  return String(value ?? "")
    .replaceAll("\\r\\n", "\n")
    .replaceAll("\\n", "\n")
    .replaceAll("\\r", "\n");
}

export function normalizeBrunchChatWritingPreview(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.title !== "string" || !value.title.trim()) return null;
  if ("subtitle" in value && typeof value.subtitle !== "string") return null;
  if (typeof value.markdown !== "string" || !value.markdown.trim()) return null;
  return {
    title: normalizeBrunchChatText(value.title).trim(),
    ...(typeof value.subtitle === "string" ? { subtitle: normalizeBrunchChatText(value.subtitle).trim() } : {}),
    markdown: normalizeBrunchChatText(value.markdown).trim()
  };
}

export function normalizeBrunchChatQuestion(value) {
  if (typeof value !== "string") return "";
  const question = normalizeBrunchChatText(value).trim();
  return question;
}

export function getBrunchChatQuestion(content) {
  return normalizeBrunchChatQuestion(content?.question) || copyCatalog.brunchChat.choiceTitle;
}

export function getBrunchChatExplicitQuestion(content) {
  return normalizeBrunchChatQuestion(content?.question);
}

export function getBrunchChatInputVariant(chat = {}) {
  if (chat.isLoading) return "default";
  if (chat.editorialPhase === "open_editing" || chat.editorialPhase === "article") return "default";
  const messages = Array.isArray(chat.messages) ? chat.messages : [];
  const latestAssistant = [...messages]
    .reverse()
    .find((turn) => turn.role === "assistant");
  if (!latestAssistant && messages.length === 0) return BRUNCH_CHAT_WELCOME_CHOICES.length ? "steps" : "default";
  if (latestAssistant?.content?.writing_preview) return "default";
  return latestAssistant?.content?.choices?.length ? "steps" : "default";
}

export function getBrunchChatChatboxState(chat = {}) {
  if (chat.isLoading) {
    if (String(chat.draft ?? "").trim()) return "typing";
    return chat.generationState === "thinking" ? "thinking" : "abort";
  }
  return String(chat.draft ?? "").trim() ? "typing" : "resting";
}

export function isBrunchChatRequestAborted(error, signal) {
  return signal?.aborted === true || error?.name === "AbortError";
}

export function normalizeBrunchChatResponse(value, { allowLegacyQuestionFallback = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.markdown !== "string" || !Array.isArray(value.choices)) return null;
  if (!value.markdown.trim()) return null;
  const choices = value.choices.map((choice) => {
    if (!choice || typeof choice !== "object" || Array.isArray(choice)) return null;
    if (typeof choice.label !== "string" || !choice.label.trim()) return null;
    if (typeof choice.description !== "string" || !choice.description.trim()) return null;
    return { label: normalizeBrunchChatText(choice.label).trim(), description: normalizeBrunchChatText(choice.description).trim() };
  });
  if (choices.some((choice) => choice === null)) return null;
  const writingPreview = "writing_preview" in value ? normalizeBrunchChatWritingPreview(value.writing_preview) : undefined;
  if ("writing_preview" in value && !writingPreview) return null;
  const question = "question" in value ? normalizeBrunchChatQuestion(value.question) : "";
  if ("question" in value && !question) return null;
  if (choices.length > 0 && !question && !allowLegacyQuestionFallback) return null;
  return {
    markdown: normalizeBrunchChatText(value.markdown).trim(),
    choices: choices,
    ...(question ? { question } : choices.length > 0 && allowLegacyQuestionFallback ? { question: copyCatalog.brunchChat.choiceTitle } : {}),
    ...(writingPreview ? { writing_preview: writingPreview } : {})
  };
}

function createSessionId() {
  return globalThis.crypto?.randomUUID?.()
    ?? `brunch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeBrunchChatMessage(message, options = {}) {
  if (!message || typeof message !== "object") throw new BrunchChatStorageError("Stored Brunch chat contains an invalid message.");
  if (message.role === "user" && typeof message.content === "string") {
    return { role: "user", content: message.content };
  }
  if (message.role === "assistant" && message.content && typeof message.content === "object") {
    const content = normalizeBrunchChatResponse(message.content, options);
    if (content) return { role: "assistant", content };
  }
  throw new BrunchChatStorageError("Stored Brunch chat contains an invalid message.");
}

export function normalizeBrunchChatMessages(messages, options = {}) {
  if (messages === undefined || messages === null) return [];
  if (!Array.isArray(messages)) throw new BrunchChatStorageError("Stored Brunch chat messages must be an array.");
  return messages.map((message) => normalizeBrunchChatMessage(message, options));
}

export function defaultBrunchChatChoiceIndex(messages = []) {
  const latestAssistant = [...messages].reverse().find((turn) => turn.role === "assistant");
  if (!latestAssistant) return messages.length === 0 && BRUNCH_CHAT_WELCOME_CHOICES.length ? 0 : -1;
  return latestAssistant.content.choices.length > 0 ? 0 : -1;
}

export function createBrunchChatState(saved = null) {
  const messages = normalizeBrunchChatMessages(saved?.messages);
  const messageMeta = saved?.messageMeta && typeof saved.messageMeta === "object" && !Array.isArray(saved.messageMeta)
    ? Object.fromEntries(Object.entries(saved.messageMeta).filter(([, value]) => value && typeof value === "object"))
    : {};
  return {
    sessionId: typeof saved?.sessionId === "string" && saved.sessionId.trim() ? saved.sessionId : createSessionId(),
    messages,
    messageMeta,
    selectedChoiceIndex: defaultBrunchChatChoiceIndex(messages),
    draft: "",
    isLoading: false,
    generationId: null,
    modelPreset: typeof saved?.modelPreset === "string" ? saved.modelPreset : BRUNCH_CHAT_DEFAULT_MODEL_PRESET,
    runtimeProfile: typeof saved?.runtimeProfile === "string"
      ? saved.runtimeProfile
      : messages.length > 0 ? "v07" : BRUNCH_CURATED_RUNTIME_PROFILE,
    debugTraceEnabled: false,
    modelCapabilities: [],
    writingSkills: [],
    generationState: "resting",
    generationActivity: "request_received",
    editorialPhase: typeof saved?.editorialPhase === "string" ? saved.editorialPhase : "topic_discovery",
    error: null
  };
}

export function readBrunchChatStorage(storage = globalThis.sessionStorage) {
  const raw = storage?.getItem(BRUNCH_CHAT_STORAGE_KEY);
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throwStorageRecoveryError(storage, raw, "저장된 대화를 복원하지 못했습니다. 새 대화로 시작해 주세요.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.sessionId !== "string" || !parsed.sessionId.trim() || !Array.isArray(parsed.messages)) {
    throwStorageRecoveryError(storage, raw, "저장된 대화 형식이 올바르지 않습니다. 새 대화로 시작해 주세요.");
  }
  const isLegacy = parsed.storageVersion === undefined;
  const isV2Migration = parsed.storageVersion === 2;
  if (!isLegacy && !isV2Migration && parsed.storageVersion !== BRUNCH_CHAT_STORAGE_VERSION) {
    throwStorageRecoveryError(storage, raw, "저장된 대화 버전을 읽을 수 없습니다. 새 대화로 시작해 주세요.");
  }
  let messages;
  try {
    messages = normalizeBrunchChatMessages(parsed.messages, { allowLegacyQuestionFallback: isLegacy });
  } catch (error) {
    throwStorageRecoveryError(storage, raw, error instanceof Error ? error.message : "저장된 대화 내용을 읽을 수 없습니다.");
  }
  const messageMeta = parsed.messageMeta && typeof parsed.messageMeta === "object" && !Array.isArray(parsed.messageMeta)
    ? parsed.messageMeta
    : {};
  return {
    sessionId: parsed.sessionId,
    messages,
    ...(Object.keys(messageMeta).length ? { messageMeta } : {}),
    ...(typeof parsed.modelPreset === "string" ? { modelPreset: parsed.modelPreset } : {}),
    ...(typeof parsed.runtimeProfile === "string" ? { runtimeProfile: parsed.runtimeProfile } : {}),
    ...(typeof parsed.editorialPhase === "string" ? { editorialPhase: parsed.editorialPhase } : {}),
    storageVersion: BRUNCH_CHAT_STORAGE_VERSION,
    migrated: isLegacy || isV2Migration
  };
}

export function persistBrunchChatState(state, storage = globalThis.sessionStorage) {
  const payload = {
    storageVersion: BRUNCH_CHAT_STORAGE_VERSION,
    sessionId: state.sessionId,
    messages: normalizeBrunchChatMessages(state.messages),
    messageMeta: state.messageMeta ?? {},
    ...(state.modelPreset && state.modelPreset !== BRUNCH_CHAT_DEFAULT_MODEL_PRESET ? { modelPreset: state.modelPreset } : {}),
    ...(state.runtimeProfile && state.runtimeProfile !== "v07" ? { runtimeProfile: state.runtimeProfile } : {}),
    ...(state.editorialPhase && state.editorialPhase !== "topic_discovery" ? { editorialPhase: state.editorialPhase } : {})
  };
  storage?.setItem(BRUNCH_CHAT_STORAGE_KEY, JSON.stringify(payload));
  return payload;
}

function throwStorageRecoveryError(storage, raw, message) {
  const recoveryKey = `${BRUNCH_CHAT_STORAGE_KEY}:recovery:${Date.now()}`;
  try { storage?.setItem(recoveryKey, raw); } catch {}
  throw new BrunchChatStorageError(message, { recoveryKey });
}

export function chooseBrunchChatMessage({ draft = "", selectedChoice = null } = {}) {
  const freeInput = String(draft).trim();
  if (freeInput) return freeInput;
  return typeof selectedChoice?.label === "string" ? selectedChoice.label.trim() : "";
}

export function brunchChatWelcome() {
  return {
    markdown: copyCatalog.brunchChat.welcome,
    choices: BRUNCH_CHAT_WELCOME_CHOICES,
    question: copyCatalog.brunchChat.welcomeQuestion
  };
}
