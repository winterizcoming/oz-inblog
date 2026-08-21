# Changelog

## 1.0.0-alpha.4 - 2026-08-21

- Automatically updates a missing or outdated Codex CLI to the latest stable package during installation.
- Keeps user confirmation for login, global install permission failures, and existing installation replacement.

## 1.0.0-alpha.3 - 2026-08-21

- Relaxed exact tool-version blocking to compatible ranges with live doctor, test, and smoke verification.
- Kept tested tool versions as reproducible baselines in the release manifest.
- Separated a missing Codex executable or login from ordinary version compatibility checks.

## 1.0.0-alpha.2 - 2026-08-20

- Fixed fresh-install checksum verification by publishing a portable basename-only checksum file.
- Fixed readiness detection when `codex login status` reports the login state on stderr.
- Clarified doctor output so critical-check success is not displayed as an overall Codex warning.

## 1.0.0-alpha.1 - 2026-08-20

- Promoted Curated Discovery to the single v1.0a runtime profile.
- Added a Brunch-only local server and UI.
- Moved persistent sessions and optional debug traces to the macOS Application Support directory.
- Added versioned release metadata, installer checks, Writing Skill verification, package allowlist validation, and macOS CI.
- Removed Supabase and legacy Workflow surfaces from the public release package.

## v0.5

- Deterministic Artifact Runtime 안정화
- 자동 Claim Research 복구
- Source ref 불변성
- Claim 중심 Research 선택
- AI Source Discovery 상태 분리
- Source Selection 부분 렌더링
- 기존 v0.4.5 Session 호환
