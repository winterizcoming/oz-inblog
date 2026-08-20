# oz-inblog v1.0a 설치

## 공식 지원 환경

- macOS arm64
- Node.js 24.19.0
- npm 11.17.0
- Codex CLI 0.144.1

설치 도우미는 먼저 운영체제와 도구 버전을 확인해야 합니다. Codex 로그인, 도구 버전 변경, 기존 설치 교체가 필요할 때만 사용자에게 확인합니다. 인증 파일, 쿠키, 토큰은 읽거나 복사하지 않습니다.

## 설치 위치

```text
~/Library/Application Support/oz-inblog/
├─ releases/1.0.0-alpha.2/
├─ current -> releases/1.0.0-alpha.2/
├─ data/
├─ config/
└─ backups/
```

`data`와 `config`는 release 폴더 밖에 있어 업데이트해도 유지됩니다. 동일 버전이 이미 검증되어 있으면 다시 설치하지 않습니다.

## 설치 절차

1. `uname -s`, `uname -m`, `node --version`, `npm --version`, `codex --version`을 확인합니다.
2. `codex doctor --json`과 `codex login status`를 실행합니다. 로그인이 없으면 사용자에게 `codex login`을 요청합니다.
3. 기존 `current`, `data`, Writing Skill 버전을 확인합니다. 다른 버전이 있으면 덮어쓰기 전에 확인합니다.
4. GitHub Release `v1.0.0-alpha.2`의 `oz-inblog-1.0.0-alpha.2.tar.gz`와 `.sha256`을 같은 임시 폴더에 다운로드합니다.
5. 다운로드한 폴더에서 `.sha256`을 확인하고 tarball의 파일명만 대상으로 SHA-256을 검증합니다. 제작자 컴퓨터의 절대 경로를 사용하지 않습니다.
6. release 폴더에서 `npm ci`를 실행합니다.
7. `npm run install:skills`와 `npm run verify:skills`를 실행합니다.
8. `npm run doctor`, `npm test`, `npm run smoke`를 순서대로 실행합니다.
9. 모두 통과하면 `current` 심볼릭 링크를 새 release로 원자적으로 전환합니다.
10. `current`에서 `npm start`를 실행하고 `http://127.0.0.1:4174` 및 데이터 위치를 알립니다.

checksum 불일치, 포트 충돌, 로그인 없음, Writing Skill 버전 충돌은 자동으로 덮어쓰지 않고 중단합니다.

## 환경 변수

- `PORT`: 기본 `4174`
- `OZ_DATA_DIR`: 기본 `~/Library/Application Support/oz-inblog/data`
- `OZ_BRUNCH_DEBUG_TRACE=1`: 상세 로컬 trace 활성화. 기본값은 off입니다.
- `OZ_KOREAN_HUMANIZER_SKILL_PATH`: Humanizer Skill 경로를 명시할 때만 사용합니다.
- `OZ_WAZA_WRITE_SKILL_PATH`: Waza write Skill 경로를 명시할 때만 사용합니다.

## 삭제

release 폴더와 `current` 링크를 제거해도 `data`는 남습니다. 대화와 원고까지 지우려면 사용자가 `data` 삭제를 별도로 명시해야 합니다.
