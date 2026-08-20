const EVIDENCE_FIELDS = Object.freeze([
  "anchor_sources",
  "claims",
  "cases",
  "trend_evidence",
  "counterevidence",
  "evidence_gaps",
  "unsupported_claims"
]);

function compactEvidenceContext(bundle) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) return null;
  return Object.fromEntries([
    ...(typeof bundle.checked_at === "string" ? [["checked_at", bundle.checked_at]] : []),
    ...EVIDENCE_FIELDS.flatMap((field) => Array.isArray(bundle[field]) && bundle[field].length
      ? [[field, bundle[field].slice(0, 40)]]
      : [])
  ]);
}

export function buildBrunchReadinessPrompt({ preview, bundle, evidenceBundle = null }) {
  const profile = bundle.references.find((reference) => reference.name === "editorial-profile.md")?.content ?? "";
  const quality = bundle.references.find((reference) => reference.name === "writing-quality.md")?.content ?? "";
  const evidenceContext = compactEvidenceContext(evidenceBundle);
  return [
    "당신은 한국어 브런치 블로그 원고의 발행 준비도를 점검하는 독립적인 편집 평가자입니다.",
    "이 평가는 승인이나 발행 차단이 아니라 작성자가 다음 수정 우선순위를 판단하기 위한 참고 의견입니다.",
    "평가 기준의 원본은 아래 실제 editorial-profile.md와 writing-quality.md 전문입니다.",
    "내부 사고 과정이나 평가 과정을 출력하지 말고 최종 JSON 객체만 반환하세요.",
    `\n--- editorial-profile.md ---\n${profile}`,
    `\n--- writing-quality.md ---\n${quality}`,
    ...(evidenceContext ? ["\n--- 검증된 Evidence Context ---", `<evidence_context>${JSON.stringify(evidenceContext)}</evidence_context>`] : []),
    "\n--- 평가 대상 Writing Preview ---",
    `제목: ${preview.title}`,
    ...(preview.subtitle ? [`부제: ${preview.subtitle}`] : []),
    preview.markdown,
    "\n--- 평가 지시 ---",
    "central_judgment, title_contract, structure_conclusion, evidence_boundaries, voice_readability 다섯 차원을 각각 1~5점으로 평가하세요.",
    "이 평가는 원고의 편집 완성도를 보는 단계입니다. 외부 링크가 없거나 출처가 회사명·매체명으로만 적혔다는 이유만으로 evidence_boundaries를 1~2점으로 낮추거나 치명적 결함으로 처리하지 마세요.",
    "Evidence Context가 있으면 원고의 사실 주장과 대조하세요. context의 claims와 일치하면 supported로, unsupported_claims와 일치하거나 claims를 반대로 바꾸면 해당 critical blocker로 판정하세요. Evidence Context가 없으면 출처 링크가 없다는 이유만으로 critical blocker를 추정하지 마세요.",
    "사실과 작성자의 해석이 구분되고 각 주장의 출처 주체를 알아볼 수 있으면, URL이나 문서명이 본문에 없더라도 evidence_status를 supported로 둘 수 있습니다.",
    "공개 저장소의 별 개수처럼 관찰 대상과 출처 주체가 명확한 시점성 수치는 관찰 시점이 없다는 이유만으로 UNVERIFIED_NUMERIC_CLAIM을 만들지 마세요. 출처·표본·관찰 대상을 특정할 수 없거나 Evidence Context의 기준 수치와 충돌할 때만 사용하세요.",
    "UNSUPPORTED_CLAIM은 근거에 없는 조직 성과·비교 우위·인과 효과를 검증된 사실처럼 새로 단정한 경우에만 사용하세요. 사건을 해석하는 일반적 관찰, 가능성 표현, 독자 질문에는 사용하지 마세요.",
    "SOURCE_CLAIM_MISMATCH는 원고가 명시한 외부 출처의 내용이나 수치가 실제로 뒷받침하는 범위를 반대로 바꾸거나 성과 인과로 확대했을 때만 사용하세요. 제목의 수사적 요약과 본문 표현의 강도 차이는 title_contract에서 평가하고 이 code를 사용하지 마세요.",
    "본문 근거가 실제 서비스 중단·철회·운영 종료를 확인하고 제목이 이를 '버렸다', '끝났다'처럼 편집적으로 압축했다면, 행위 주체나 결과를 반대로 바꾸지 않는 한 TITLE_CONTRACT_MISMATCH나 SOURCE_CLAIM_MISMATCH로 판정하지 마세요.",
    "UNVERIFIED_NUMERIC_CLAIM, UNSUPPORTED_CLAIM, SOURCE_CLAIM_MISMATCH 세 코드는 발행을 막는 critical 결함입니다.",
    "제목과 본문 약속이 어긋나면 TITLE_CONTRACT_MISMATCH, 중심 판단이 없으면 CENTRAL_JUDGMENT_MISSING, 결론이 빠지면 CONCLUSION_MISSING, 같은 주장이나 문단의 역할을 새 정보 없이 반복해 글의 진행을 실제로 막으면 EXCESSIVE_REPETITION을 사용하세요. 이 네 코드는 한 차원의 수정이 필요한 advisory 결함입니다.",
    "EXCESSIVE_REPETITION은 독자가 같은 결론을 여러 번 다시 읽어야 할 정도의 의미 반복에만 사용하세요. 한 번의 우발적 문장 중복, 이미지 캡션이 인접 문장의 사실을 다시 적은 경우, 같은 맥락을 환기하더라도 새로운 사례나 해석으로 논지를 전진시키는 문단은 이 blocker로 판정하지 말고 voice_readability reason에만 적으세요.",
    "교재형 문장, 순서 나열, 정형적 요약은 그 자체로 의미 반복이 아닙니다. 같은 판단을 새 정보 없이 여러 번 되풀이한 경우에만 EXCESSIVE_REPETITION을 사용하고, 내용은 한 번씩만 제시되지만 표현이 기계적이면 voice_readability만 낮추세요.",
    "중심 판단은 사례에서 독자가 추론할 수 있다는 것만으로 충분하지 않습니다. 사건이 왜 중요한지 설명하는 작성자의 명시적 해석 문장이 본문이나 결론에 남아 있는지 확인하세요. 적용 조언과 독자 질문만 남았다면 central_judgment를 3점 이하로 낮추고 CENTRAL_JUDGMENT_MISSING을 사용하세요.",
    "중심 판단이 제거된 글의 마지막 질문이 앞선 정보에서 작성자의 판단을 새로 압축하지 못하고 독자에게 판단을 넘기기만 한다면, CENTRAL_JUDGMENT_MISSING과 함께 CONCLUSION_MISSING도 사용하세요.",
    "결론은 앞에서 이미 세운 판단을 그대로 반복할 필요가 없고, 그 판단을 선명하게 압축하는 독자 질문으로 닫아도 됩니다. 반대로 마지막 실질 문단이 새 사례·수치·후속 상황만 제시한 채 제목의 질문이나 중심 판단으로 돌아오지 않으면 structure_conclusion을 3점 이하로 낮추고 CONCLUSION_MISSING을 사용하세요.",
    "두 사례의 차이를 대조해 놓은 것만으로 결론이 완성되지는 않습니다. 대조 뒤에 그 차이가 왜 중요한지에 대한 작성자의 최종 판단이 없으면 structure_conclusion을 3점 이하로 낮추고 CONCLUSION_MISSING을 사용하세요.",
    "상반된 근거를 검토하는 글이 마지막 사례 하나의 결과만 해석하고 끝나 앞선 사례와 제목의 질문을 함께 종합하지 못했다면, 마지막 문장에 부분적인 판단이 남아 있어도 완결된 결론으로 보지 말고 structure_conclusion을 3점 이하로 낮춰 CONCLUSION_MISSING을 사용하세요.",
    "글 대부분이 자연스럽더라도 논증의 핵심 문단 하나를 교재형 요약이나 정형화된 순서 나열로 바꿔 저자의 목소리와 문단의 논증 기능을 동시에 잃었다면 voice_readability를 2점 이하로 평가하세요. 이런 국소적 문체 결함만으로는 blocker를 만들지 말고, 같은 방식이 글 전반에 반복될 때만 COPYEDITING_REQUIRED를 검토하세요.",
    "출처 주체 자체가 불분명해 특정 주장을 확인할 수 없을 때만 SOURCE_ATTRIBUTION_INCOMPLETE를 사용하세요. COPYEDITING_REQUIRED는 오탈자·초안 메모가 여러 핵심 문단의 이해를 실제로 막을 때만 사용하고, 이미지 캡션·띄어쓰기·소수의 비문은 voice_readability reason에만 적으세요.",
    "blocker는 위 아홉 code 중 실제로 특정할 수 있는 결함에만 사용하고, 막연히 '모든 출처를 다시 확인하라'는 포괄적 blocker는 만들지 마세요. blocker가 없으면 빈 배열을 반환하세요.",
    "각 차원의 이유는 원고에 근거해 짧고 구체적으로 쓰세요. evidence_status가 needs_verification이어도 그 자체가 치명적 판정은 아닙니다.",
    "반드시 다음 JSON 계약만 반환하세요.",
    '{"dimensions":[{"id":"central_judgment","score":4,"reason":"..."},{"id":"title_contract","score":4,"reason":"..."},{"id":"structure_conclusion","score":4,"reason":"..."},{"id":"evidence_boundaries","score":4,"reason":"..."},{"id":"voice_readability","score":4,"reason":"..."}],"blockers":[],"evidence_status":"supported","confidence":"medium","summary":"..."}'
  ].join("\n");
}
