# oz-inblog

`oz-inblog v1.0a`는 디자인·브랜딩·제품 글감을 찾고, 리서치와 목차를 거쳐 Brunch 원고를 작성하는 macOS용 로컬 애플리케이션입니다. 대화와 원고는 사용자의 Mac에 저장되며 Codex CLI를 통해 모델을 실행합니다.

## Codex로 한 줄 설치

아래 문장을 Codex에 그대로 전달하세요.

```text
GitHub의 https://github.com/winterizcoming/oz-inblog/tree/v1.0.0-alpha.4 에 있는 INSTALL.md와 release-manifest.json을 읽고 oz-inblog v1.0a를 설치해줘. 허용된 도구 버전 범위 안이면 기존 도구를 그대로 사용하고, Codex CLI가 없거나 최소 버전보다 낮으면 @openai/codex 최신 안정 버전으로 자동 업데이트한 뒤 계속 진행해줘. release checksum을 검증하고 기존 데이터는 보존하며, 로그인·전역 설치 권한 오류·기존 설치 덮어쓰기가 필요할 때만 나에게 확인한 뒤 doctor, test, smoke를 통과시키고 로컬 서비스를 시작해 접속 주소와 데이터 위치를 알려줘.
```

지원 환경과 설치 절차는 [INSTALL.md](INSTALL.md)를 확인하세요.

## 로컬 실행

```bash
npm ci
npm run verify:skills
npm run doctor
npm test
npm run smoke
npm start
```

접속 주소는 `http://127.0.0.1:4174`입니다. 데이터는 기본적으로 `~/Library/Application Support/oz-inblog/data`에 저장됩니다.

## 지원 범위

- macOS arm64
- Node.js `>=24.19.0 <26` (검증 기준 `24.19.0`)
- npm `>=11.10.0 <12` (검증 기준 `11.17.0`)
- Codex CLI `>=0.144.1` (검증 기준 `0.144.1`, 부족하면 최신 안정 버전 자동 업데이트)
- GPT-5.6 Luna Mid 기본값

Intel Mac, Linux, Windows는 아직 검증하지 않았습니다.

## 개인정보

oz-inblog은 계정을 만들거나 원고를 외부 데이터베이스에 저장하지 않습니다. Codex가 처리하는 데이터의 범위와 로컬 저장 정책은 [PRIVACY.md](PRIVACY.md)를 참고하세요.

## 라이선스

MIT. 외부 Writing Skill은 별도 프로젝트이며 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)에 고정 버전과 라이선스를 기록합니다.
