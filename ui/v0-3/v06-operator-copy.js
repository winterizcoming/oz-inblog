export const V06_OPERATOR_COPY = Object.freeze({
  start: Object.freeze({
    railTitle: "새 글 설정",
    railDescription: "조사 범위를 저장한 뒤 자료 검토를 시작합니다.",
    contextTitle: "조사 범위",
    contextDescription: "필수 항목을 입력하면 새 작업이 생성됩니다.",
    seedUrlsHint: "여러 URL은 줄바꿈으로 나눠 입력하세요.",
    comparisonHintsHint: "비교할 대상이 있으면 줄바꿈으로 입력하세요.",
    sourceCountHint: "최소·권장·최대 순서로 입력하세요."
  }),
  research: Object.freeze({
    readyTitle: "조사 범위를 저장했습니다.",
    readyDescription: "입력한 주제와 시작 자료를 바탕으로 자료 조사를 시작할 수 있습니다.",
    runningTitle: "자료를 조사하고 있습니다.",
    runningDescription: "현재 실행 중인 조사 작업이 끝나면 자료 검토 단계로 이동합니다.",
    runningRefreshError: "진행 상태를 확인하지 못했습니다. 새로고침하면 최신 상태를 확인할 수 있습니다.",
    runningSteps: ["조사 계획 생성", "시작 자료 확인", "기존 자료 검색", "부족한 관점 보충", "자료 정리"],
    failedTitle: "자료 조사를 완료하지 못했습니다.",
    failedDescription: "조사 중 문제가 발생했습니다. 입력한 범위는 보존되어 다시 시도할 수 있습니다.",
    restrictedTitle: "자료가 아직 충분하지 않습니다.",
    restrictedDescription: "현재 자료는 목표 최소 수에 미달하며 일부 조사 관점이 부족합니다.",
    restrictedContinueWarning: "자료 수는 충분하지만 핵심 질문을 직접 뒷받침하는 자료가 부족합니다. 현재 상태로 계속하면 글의 범위를 AI 도구와 포트폴리오 표현 방식의 변화 정도로 제한해야 합니다.",
    readinessTitle: "핵심 질문을 뒷받침하는 근거를 확인해야 합니다.",
    readinessDescription: "자료 수보다 중요한 것은 이 글의 질문을 직접 다루는 자료가 있는지입니다.",
    restrictedApproval: "현재 자료로 확인할 수 있는 범위에 맞춰 글의 질문을 좁힙니다.\n\nAI 시대, 디자인 포트폴리오에서 결과물뿐 아니라 과정과 판단을 어떻게 보여줘야 할까?\n\n현재 자료로는 디자인 채용 전반의 변화, AI 이전과 이후의 차이, 주니어와 시니어의 차이를 일반화할 수 없습니다.",
    decisionTitle: "어떻게 진행할까요?",
    freeRevisePlaceholder: "아니오, Codex가 뭘 할지 말씀해주세요 (free-revise)",
    sourceSummaryTitle: "자료에서 확인할 내용",
    sourceSummaryFallback: "원문에서 확인할 수 있는 내용이 아직 준비되지 않았습니다.",
    sourceScopeTitle: "이 자료를 사용할 수 있는 범위",
    sourceScopePrefix: "현재 자료는 다음 주제의 맥락 근거로 사용할 수 있습니다.",
    approvalNextTitle: "승인하면 다음 단계",
    approvalNextStep: "발견 정리",
    approvalNextRestricted: "현재 자료의 범위와 한계를 기록한 뒤, 자료 사이의 반복·차이·연결을 확인합니다.",
    approvalNextNormal: "승인한 자료를 바탕으로 자료 사이의 반복·차이·연결을 확인합니다."
  }),
  writing: Object.freeze({
    draftHeading: "초안 본문"
  }),
  steps: Object.freeze({
    research_review: "자료 검토",
    synthesis_review: "발견 정리",
    editorial_direction_review: "글의 방향",
    argument_review: "논증 구성",
    writing_review: "글 검토",
    publish_package_review: "발행 준비"
  }),
  states: Object.freeze({
    not_started: "대기",
    pending: "대기",
    generated: "검토 필요",
    completed: "검토 필요",
    review_required: "검토 필요",
    approved: "승인 완료",
    running: "작업 중",
    blocked: "수정 필요",
    stale: "이전 결과 변경됨",
    failed: "실패"
  }),
  empty: "아직 생성되지 않았습니다. 이전 단계 승인 후 생성할 수 있습니다."
});
