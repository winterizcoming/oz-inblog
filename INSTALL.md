# oz-inblog v1.0a 설치

## 공식 검증 기준과 허용 범위

- macOS arm64
- Node.js: `>=24.19.0 <26` (검증 기준 `24.19.0`)
- npm: `>=11.10.0 <12` (검증 기준 `11.17.0`)
- Codex CLI: `>=0.144.1` (검증 기준 `0.144.1`, 필요하면 최신 안정 버전으로 자동 업데이트)

검증 기준 버전은 재현 가능한 기준값이며, 허용 범위 안의 더 새로운 버전은 실제 `doctor`, `test`, `smoke` 검증을 통과하면 그대로 사용합니다. Codex CLI가 없거나 최소 버전보다 낮으면 사용자에게 다시 묻지 않고 최신 안정 버전으로 업데이트한 뒤 검증을 이어갑니다. 업데이트가 실패할 때만 중단하고 원인과 수동 실행 방법을 알립니다. 인증 파일, 쿠키, 토큰은 읽거나 복사하지 않습니다.

## 설치 위치

```text
~/Library/Application Support/oz-inblog/
├─ releases/1.0.0-alpha.5/
├─ current -> releases/1.0.0-alpha.5/
├─ data/
├─ config/
└─ backups/
```

`data`와 `config`는 release 폴더 밖에 있어 업데이트해도 유지됩니다. 동일 버전이 이미 검증되어 있으면 다시 설치하지 않습니다.

## 설치 절차

1. `uname -s`, `uname -m`, `node --version`, `npm --version`, `codex --version`을 확인합니다. 허용 범위 안이면 정확한 검증 기준 버전과 달라도 계속 진행합니다.
2. Codex CLI가 없거나 `codex --version`이 실패하거나 최소 버전보다 낮으면 다음을 자동 실행합니다.

   ```bash
   npm install -g @openai/codex@latest --no-audit --no-fund
   ```

   설치 후 `codex --version`을 다시 확인합니다. 전역 설치 권한 오류 등으로 업데이트가 실패하면 자동으로 우회하지 않고 해당 오류와 위 명령을 알립니다.
3. `codex doctor --json`과 `codex login status`를 실행합니다. 로그인이 없으면 사용자에게 `codex login`을 요청합니다.
4. 기존 `current`, `data`, Writing Skill 버전을 확인합니다. 다른 버전이 있으면 덮어쓰기 전에 확인합니다.
5. GitHub Release `v1.0.0-alpha.5`의 `oz-inblog-1.0.0-alpha.5.tar.gz`와 `.sha256`을 같은 임시 폴더에 다운로드합니다.
6. 다운로드한 폴더에서 `.sha256`을 확인하고 tarball의 파일명만 대상으로 SHA-256을 검증합니다. 제작자 컴퓨터의 절대 경로를 사용하지 않습니다.
7. release 폴더에서 `npm ci`를 실행합니다.
8. `npm run install:skills`와 `npm run verify:skills`를 실행합니다.
9. `npm run doctor`, `npm test`, `npm run smoke`를 순서대로 실행합니다.
10. 모두 통과하면 `current` 심볼릭 링크를 새 release로 원자적으로 전환합니다.
11. `current/oz-inblog.app`을 `~/Applications/oz-inblog.app` 또는 `/Applications/oz-inblog.app`으로 복사하고 실행합니다. 앱이 현재 릴리스에서 서버를 시작한 뒤 `http://127.0.0.1:4174`를 엽니다. 앱을 사용하지 않을 때는 `current`에서 `npm start`를 직접 실행해도 됩니다.

앱을 다시 실행하면 공개 릴리스의 최신 버전을 확인합니다. 새 버전이 있으면 업데이트용 Codex 안내를 클립보드에 복사할지 묻습니다. 데이터와 설정은 release 폴더 밖에 있으므로 업데이트해도 보존됩니다.

checksum 불일치, 포트 충돌, 로그인 없음, Writing Skill 버전 충돌은 자동으로 덮어쓰지 않고 중단합니다.

## 환경 변수

- `PORT`: 기본 `4174`
- `OZ_DATA_DIR`: 기본 `~/Library/Application Support/oz-inblog/data`
- `OZ_BRUNCH_DEBUG_TRACE=1`: 상세 로컬 trace 활성화. 기본값은 off입니다.
- `OZ_KOREAN_HUMANIZER_SKILL_PATH`: Humanizer Skill 경로를 명시할 때만 사용합니다.
- `OZ_WAZA_WRITE_SKILL_PATH`: Waza write Skill 경로를 명시할 때만 사용합니다.

## 삭제

release 폴더와 `current` 링크를 제거해도 `data`는 남습니다. 대화와 원고까지 지우려면 사용자가 `data` 삭제를 별도로 명시해야 합니다.
