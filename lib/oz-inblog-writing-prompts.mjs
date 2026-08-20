function historyContext(history, userMessage) {
  return [
    "--- 이전 대화(JSON) ---",
    JSON.stringify(history, null, 2),
    "--- 현재 사용자 메시지 ---",
    userMessage
  ].join("\n");
}

function responseContract() {
  return [
    "응답은 JSON 객체 하나만 반환하세요. JSON 바깥에 설명이나 코드 블록을 붙이지 마세요.",
    '{"markdown":"사용자에게 보여줄 응답","question":"필요한 질문","choices":[{"label":"실제 사건 이름","description":"짧은 설명"}],"writing_preview":null} 형태를 사용하세요.',
    "markdown은 비어 있지 않은 문자열이어야 합니다. choices는 선택지가 필요할 때만 사용하고, 각 choice에는 label과 description을 넣으세요. question은 다음 행동을 묻는 경우에만 넣으세요.",
    "writing_preview는 실제 전체 원고를 작성할 때만 넣으세요. 그때 title과 markdown은 필수입니다."
  ].join("\n");
}

function dateWindow(now = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" });
  const end = new Date(now);
  const start = new Date(end.getTime() - (7 * 24 * 60 * 60 * 1000));
  return {
    today: formatter.format(end),
    since: formatter.format(start)
  };
}

export function buildOutlinePrompt({ history, userMessage, selectedTopic, sourceDiscovery }) {
  return [
    "당신은 브런치 글의 목차를 함께 잡는 편집자입니다.",
    "사용자가 고른 사건과 지금까지 확인한 자료, 대화에서 나온 의견을 반영해 읽을 만한 목차를 제안하세요.",
    "별도의 중심 질문 선택이나 방향 선택을 만들지 마세요. 제목 후보가 필요하면 목차 안에서 자연스럽게 제안하세요.",
    "각 문단이 왜 필요한지 짧게 설명하고, 사건의 장면과 판단이 이어지게 하세요. 조사 보고서나 완성 원고를 쓰지 마세요.",
    "목차를 보여준 뒤 사용자가 승인하거나 수정할 수 있도록 자연스럽게 질문하세요.",
    `선택한 사건: ${selectedTopic}`,
    historyContext(history, userMessage),
    "--- 확인한 원문(JSON) ---",
    JSON.stringify(sourceDiscovery, null, 2),
    responseContract(),
    "writing_preview는 만들지 마세요. choices는 승인을 위한 선택이 실제로 필요할 때만 사용하세요."
  ].join("\n");
}

export function buildArticlePrompt({ history, userMessage, selectedTopic, sourceDiscovery, outlineMarkdown, articleStyle }) {
  return [
    "당신은 브런치 원고를 쓰는 작가입니다.",
    "사용자가 승인한 목차와 확인된 자료를 바탕으로 바로 읽을 수 있는 본문을 작성하세요. 메모나 초안 계획, 검수 보고서로 대신하지 마세요.",
    "원고를 쓸 때만 아래 article style 규칙을 적용하세요. 탐색·조사·목차 대화에는 이 규칙을 적용하지 않습니다.",
    articleStyle ? `--- article style ---\n${articleStyle}` : "",
    "사실·숫자·고유명사·출처의 의미를 바꾸지 마세요. 확인되지 않은 구체적인 수치나 사실을 만들지 마세요.",
    "승인된 목차의 주요 section과 흐름을 본문 markdown에 유지하세요. 목차에 드러난 주요 section은 자연스러운 Markdown ## 소제목으로 보여 주고, 긴 글의 구조가 보이도록 필요한 곳에만 사용하세요. 모든 문단에 소제목을 붙이거나 목차에 없는 구조를 억지로 추가하지 마세요.",
    "문장 앞의 상투적인 접속사와 반복을 줄이되, 의미상 필요한 논리 연결까지 삭제하지 마세요.",
    `선택한 사건: ${selectedTopic}`,
    "--- 승인된 목차 ---",
    outlineMarkdown,
    historyContext(history, userMessage),
    "--- 확인한 원문(JSON) ---",
    JSON.stringify(sourceDiscovery, null, 2),
    responseContract(),
    "writing_preview에는 title, subtitle(선택), markdown 전체 본문을 넣으세요. article 작성 뒤 choices는 비워도 됩니다."
  ].filter(Boolean).join("\n");
}

export function buildOpenEditingPrompt({ history, userMessage, selectedTopic, sourceDiscovery, currentPreview, articleStyle }) {
  return [
    "당신은 이미 작성된 브런치 원고를 사용자와 함께 다듬는 편집자입니다.",
    "현재 원고와 사용자의 요청 범위만 반영해 답하세요. 새 조사를 시작하지 마세요.",
    articleStyle ? `--- article style ---\n${articleStyle}` : "",
    `선택한 사건: ${selectedTopic ?? "현재 원고"}`,
    "--- 현재 원고(JSON) ---",
    JSON.stringify(currentPreview ?? null),
    "현재 원고의 제목·소제목·문단 호흡과 필자의 문체를 기본값으로 유지하세요. 사용자가 구조 변경을 요청하지 않았다면 소제목을 제거하거나 새 구조로 바꾸지 마세요.",
    "문장 앞의 상투적인 접속사와 반복되는 AI 표현만 덜어내고, 필자의 고유한 말투와 의미상 필요한 연결은 보존하세요.",
    historyContext(history, userMessage),
    responseContract(),
    "문장이나 전체 원고를 실제로 수정했다면 writing_preview에 수정된 전체 본문을 넣으세요. 단순 대화라면 writing_preview를 생략해도 됩니다."
  ].filter(Boolean).join("\n");
}
