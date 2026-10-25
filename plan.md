# Pi Guard (`pi-guard`) 구현 계획서

> 대상: Pi `@earendil-works/pi-coding-agent` 1.4.x Extension (npm pi package로 배포)
> 지원 OS: Windows / macOS / Linux (Node ≥ 22.19, Pi 요구사항과 동일)

## 1. 개요

에이전트의 **마지막 답변**에 포함된 URL이 실제로 존재하는지 검증한다.
존재하지 않는 URL(환각)이 감지되면 설정된 `mode`에 따라
- `rewrite`: 에이전트에게 피드백을 주고 답변을 다시 작성하게 하거나 (최대 N회)
- `warn`: 사용자에게 경고만 표시한다.

## 2. 핵심 원칙

### 2.1 하이브리드 검증 (HTTP 우선, LLM 보조)
LLM만으로는 URL 실존 여부를 알 수 없으므로(그럴듯함만 판단) **HTTP 확인을 1차 판정**으로 쓰고, HTTP로 판정 불가능한 경우에만 LLM이 판정한다.

| HTTP 결과 | 판정 |
|---|---|
| 2xx, 3xx(리다이렉트 추적 후 2xx) | `OK` |
| 404, 410, DNS 실패(`ENOTFOUND`) | `NOT_FOUND` |
| 401, 403, 429, 5xx, 타임아웃, 기타 네트워크 오류 | `UNCERTAIN` → LLM 판정 |

- 요청: `HEAD` → 실패/405/501이면 `GET`(본문은 읽지 않고 즉시 abort).
- 전송: `undici`의 `fetch` + dispatcher(프록시/CA 설정 반영, §3.3). 전역 `fetch`에 외부 undici dispatcher를 섞으면 버전 불일치 위험이 있으므로 쓰지 않음.
- 프록시 오류(407, 프록시 연결 거부)와 TLS 인증서 오류는 `UNCERTAIN` 처리 + 세션당 1회 경고("프록시/인증서 설정 확인").
- LLM 판정 결과: `EXISTS` | `NOT_EXISTS` | `UNKNOWN`. `UNKNOWN`은 통과(fail-open).
- 최종 FAIL 조건: `NOT_FOUND`(HTTP) 또는 `NOT_EXISTS`(LLM).

### 2.2 오탐 방지 (검증 생략 대상)
- **사설/로컬**: `localhost`, `127.*`, `10.*`, `172.16–31.*`, `192.168.*`, `::1`, `*.local`, `*.internal`, `*.corp`, `*.lan`
- **예시 도메인**(RFC 2606/6761): `example.com/.net/.org`, `*.test`, `*.example`, `*.invalid`, `*.localhost`
- **설정 bypass**: `bypassDomains` (와일드카드 `*.foo.com` 지원)
- **컨텍스트 화이트리스트**: `event.context.contextMessages` 안의 user 메시지, toolResult 내용, assistant toolCall 인자에 이미 등장한 URL → 실제로 읽었거나 사용자가 준 것이므로 통과.
  - 별도 `tool_result` 추적 상태 불필요 → 브랜치 전환/resume에도 정확.
- **코드 블록**: `skipCodeBlocks: true`(기본)면 펜스/인라인 코드 안의 URL은 제외 (예제 코드 오탐 방지).

### 2.3 안정성 (Fail-Open & Loop Guard)
- 검증 모델 미존재/인증 없음/호출 실패/타임아웃/JSON 파싱 실패 → 해당 URL `UNKNOWN` 처리, 세션은 멈추지 않음.
- `outcome !== "completed"`(abort/error)인 실행은 검증하지 않음.
- 재작성 카운터는 사용자 입력 시(`before_agent_start`, `messageType === "user"`) 0으로 초기화. 재작성 continuation은 `before_agent_start`를 거치지 않으므로 카운터가 유지됨.
- `maxRewrites` 도달 후에도 FAIL이면 `warn` 동작으로 강등.
- 세션 단위 URL 결과 캐시(`Map<url, result>`), `session_start`에서 초기화.

## 3. 설정

### 3.1 위치
전역 단일 파일: `~/.pi/agent/pi-guard.json` (`getAgentDir()` 기준). 프로젝트별 설정 없음.
- `session_start`마다 다시 읽음 (`/reload`로 반영).
- 파일 없음 → 전부 기본값. 파싱/검증 오류 → 기본값 사용 + `ctx.ui.notify` 경고 1회.

### 3.2 스키마 (기본값)
```json
{
  "enabled": true,
  "mode": "rewrite",
  "maxRewrites": 1,
  "maxUrls": 20,
  "skipCodeBlocks": true,
  "bypassDomains": [],
  "verifier": {
    "provider": null,
    "model": null,
    "thinking": "low",
    "systemPrompt": null,
    "timeoutMs": 30000
  },
  "http": {
    "enabled": true,
    "timeoutMs": 8000,
    "concurrency": 5,
    "userAgent": null,
    "proxy": "env",
    "noProxy": [],
    "useSystemCa": true
  }
}
```

| 키 | 설명 |
|---|---|
| `mode` | `"rewrite"` \| `"warn"` |
| `maxRewrites` | 한 사용자 입력당 재작성 요청 최대 횟수 |
| `maxUrls` | 한 답변에서 검증할 최대 URL 수 (초과분은 생략) |
| `verifier.provider` / `verifier.model` | 검증 LLM. `null`이면 **현재 세션 모델(`ctx.model`)** 사용. 지정했는데 찾을 수 없거나 인증이 없으면 경고 후 `ctx.model`로 대체 |
| `verifier.thinking` | `"off"` \| `"minimal"` \| `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` \| `"max"`. `"off"` 또는 모델이 reasoning 미지원이면 `reasoning` 옵션 생략 |
| `verifier.systemPrompt` | 지정 시 기본 시스템 프롬프트를 **전체 교체**. 출력 JSON 형식은 사용자 메시지 쪽에 명시하므로 교체해도 파서는 동작 |
| `http.enabled` | `false`면 모든 URL을 LLM으로만 판정 |
| `http.userAgent` | `null`이면 브라우저 유사 기본 UA |
| `http.proxy` | `"env"`(기본): 환경변수 사용, 없으면 직접 연결 / `"none"`: 항상 직접 연결 / URL: `http://[user:pass@]host:port`, `https://…`, `socks5://…` |
| `http.noProxy` | 프록시 제외 호스트(`.corp.com`, `*.corp.com`, `host:port`). `proxy`가 URL일 때만 적용. `"env"`면 `NO_PROXY` 환경변수 사용 |
| `http.useSystemCa` | OS 인증서 저장소의 CA도 신뢰 (사내 TLS 검사 프록시 대응) |

### 3.3 프록시 / TLS 구현
- 의존성: `undici@^8` (`dependencies`, engines `>=22.19.0`으로 Pi와 동일).
- dispatcher는 설정 로드 시 1회 생성, `session_shutdown`에서 `close()`.

| `http.proxy` | dispatcher |
|---|---|
| `"env"` | `new EnvHttpProxyAgent(opts)` — `http_proxy`/`https_proxy`/`no_proxy`(대문자 포함, 소문자 우선) 자동 처리, 미설정 시 직접 연결 |
| `"none"` | `new Agent(opts)` |
| URL | `new EnvHttpProxyAgent({ ...opts, httpProxy: url, httpsProxy: url, noProxy: noProxy.join(",") })` |

- `opts.connect.ca` (`useSystemCa: true`): `tls.getCACertificates("default")` + `tls.getCACertificates("system")` 중복 제거 (Node ≥ 22.15 API). Windows 인증서 저장소/macOS Keychain/Linux 시스템 번들을 OS별로 Node가 읽어줌. `NODE_EXTRA_CA_CERTS`도 `"default"`에 포함됨.
- 프록시 URL 형식 오류 → 경고 후 `"env"`로 대체.
- 사설/예시/bypass URL은 프록시 여부와 관계없이 **요청 자체를 보내지 않음**.
- 로그/알림/LLM 입력에 프록시 URL을 표시할 때 `user:pass`는 마스킹.
- SOCKS5는 undici에서 실험적(Experimental) 기능 → README에 명시.
- 미지원: OS 시스템 프록시 자동 감지(Windows 인터넷 옵션, macOS 네트워크 설정), PAC/WPAD. → 환경변수 또는 `http.proxy`로 명시해야 함.

### 3.4 크로스 플랫폼 원칙
- 경로: `path.join(getAgentDir(), "pi-guard.json")`. `~`·구분자 하드코딩 금지 (`PI_CODING_AGENT_DIR` 오버라이드 자동 반영).
- 설정 파일 읽기: UTF-8 BOM 제거(`\uFEFF`, Windows 메모장 대응) 후 `JSON.parse`.
- 셸 명령/OS별 바이너리(curl 등) 사용 금지. 네트워크는 전부 Node API.
- npm scripts는 OS 중립 명령만 사용 (`rm -rf`, `VAR=x cmd` 금지 → `vitest`, `tsc`만).
- `.gitattributes`: `* text=auto eol=lf`.
- 환경변수는 Windows에서 대소문자 무시, Unix에서 구분 → undici의 대/소문자 양쪽 처리에 맡김.

## 4. 처리 흐름 (`agent_before_settle`)

```
outcome != completed or !enabled ─────────────────────────► 패스
마지막 assistant 메시지(text 파트만) 추출
  → URL 추출 (markdown 링크, <autolink>, bare URL; 끝 구두점/괄호 정리, 정규화·중복 제거)
  → 필터 (사설/예시/bypass/컨텍스트 화이트리스트/코드블록)
  → 남은 URL 없음 ──────────────────────────────────────► 패스
  → HTTP 확인 (동시성 제한, 캐시)
  → UNCERTAIN 묶음을 LLM 1회 호출로 일괄 판정
  → FAIL 없음 ──────────────────────────────────────────► 패스
  → mode=rewrite && count < maxRewrites
       → count++, return { entries: [...event.entries, customMessage], continue: true }
  → 그 외(warn)
       → ctx.ui.notify(경고) + pi.appendEntry 기록(컨텍스트 미포함), return undefined
```

- `customMessage` = `{ type: "custom_message", customType: "pi-guard", display: true, content }`
  - content: 문제 URL 목록 + 근거(HTTP 상태/LLM reason) + "해당 URL을 제거하거나, 도구로 확인한 실제 URL로 교체해 답변을 다시 작성하라"는 지시.
- **반환 `entries`는 기존 값을 덮어쓰므로 반드시 `...event.entries`를 포함**.
- 진행 중 `ctx.ui.setStatus("pi-guard", "Checking N URLs…")`, 끝나면 해제. `ctx.hasUI`가 false면 UI 호출 생략.
- 중첩 호출은 `ctx.signal`을 전달해 사용자 abort 시 즉시 중단.

### 4.1 LLM 호출
```ts
const stream = ctx.modelRegistry.streamSimple(model,
  { systemPrompt, messages: [userMessage] },
  { reasoning /* off면 생략 */, signal, timeoutMs, maxTokens });
const msg = await stream.result();
```
- 입력: URL별 `{ url, httpStatus | error }` + 답변 중 해당 URL 주변 문맥(앞뒤 ~200자).
- 출력(JSON만): `{"results":[{"url":"...","verdict":"EXISTS|NOT_EXISTS|UNKNOWN","reason":"..."}]}`
- 파싱: 코드펜스 제거 → 첫 `{`~마지막 `}` 추출 → `JSON.parse` → 스키마 검사. 실패 시 전부 `UNKNOWN`.

## 5. 마일스톤

### Phase 1: 프로젝트 기초
- [x] 디렉토리 생성, `plan.md` 작성
- [x] `package.json`
  - `name: "pi-guard"`, `type: "module"`, `keywords: ["pi-package"]`
  - `pi.extensions: ["./src/index.ts"]` (jiti 로드, 빌드 불필요)
  - `peerDependencies`: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai` → `"*"` (`dependencies`에 넣지 않음)
  - `dependencies`: `undici@^8`
  - `devDependencies`: `typescript`, `vitest`, 위 peer 패키지(타입용)
  - `engines: { "node": ">=22.19.0" }`
  - `files: ["src", "README.md"]`
- [x] `tsconfig.json` (`noEmit`, `strict`, `moduleResolution: "bundler"`, `allowImportingTsExtensions`)
- [x] `src/types.ts`, `src/config.ts` (기본값 병합 + 검증)

### Phase 2: 핵심 모듈
1. `src/extractor.ts` — URL 추출/정규화, 코드블록 제거, 컨텍스트 메시지에서 화이트리스트 URL 수집
2. `src/filter.ts` — `isPrivateOrLocal`, `isExampleDomain`, `matchesBypass`
3. `src/http-check.ts` — HEAD/GET, 타임아웃, 동시성 제한, 상태/오류 코드 → `OK|NOT_FOUND|UNCERTAIN` 분류, 캐시
4. `src/dispatcher.ts` — `http.proxy`/`noProxy`/`useSystemCa` → undici dispatcher 생성·종료, 프록시 URL 마스킹
5. `src/verifier.ts` — 모델 해석(설정 → `ctx.model` 대체), 기본 프롬프트, `streamSimple` 호출, JSON 파서
6. `src/index.ts` — 이벤트 등록(`session_start`, `session_shutdown`, `before_agent_start`, `agent_before_settle`), 파이프라인 조립, mode 처리

### Phase 3: 테스트
- [x] 단위 테스트 (vitest)
  - 추출: markdown/autolink/bare, 끝 구두점·괄호, 코드블록 제외, 중복 제거
  - 필터: 사설 IP 경계값(172.15/172.16/172.31/172.32), 예시 도메인, 와일드카드 bypass
  - HTTP 분류: 로컬 테스트 서버로 200/301/404/410/403/429/500/타임아웃, ENOTFOUND, HEAD 405 → GET 대체
  - 프록시: 테스트용 로컬 HTTP 프록시(node:http, CONNECT 지원)로 `proxy: URL` 경유 확인, `noProxy` 직접 연결 확인, `"env"` + `HTTPS_PROXY` 확인, 407 → UNCERTAIN, 잘못된 URL → `"env"` 대체, 자격증명 마스킹
  - 설정: BOM 포함 파일, CRLF 파일 파싱
  - 파서: 정상 JSON, 코드펜스 포함, 깨진 JSON → UNKNOWN
  - 설정: 누락 키 기본값 병합, 잘못된 enum → 기본값
- [x] 통합 테스트 (`pi -e ./`)
  - URL 없는 답변 → 즉시 통과
  - 사내/로컬 URL → bypass
  - `web_search`/`fetch_content`로 읽은 URL → 화이트리스트 통과
  - 가짜 URL(`https://docs.docker.com/v999/fake-cli`) → 감지 → 재작성 1회 → 종료
  - `mode: "warn"` → 알림만, continuation 없음
  - 검증 모델 미지정 → 세션 모델 사용 / 잘못된 모델 → 경고 후 세션 모델
  - 검증 중 Esc → 즉시 중단
- [x] CI: GitHub Actions 매트릭스 `windows-latest` / `macos-latest` / `ubuntu-latest` × Node 22, 24 에서 `tsc --noEmit` + `vitest run`
- [x] README (설치: `pi install npm:pi-guard`, 설정 예시, OS별 프록시 환경변수 설정법 — PowerShell `$env:HTTPS_PROXY` / `setx`, bash·zsh `export`)
- [ ] `npm publish`

## 6. 파일 구조
```
pi-guard/
├── plan.md
├── README.md
├── package.json
├── tsconfig.json
├── .gitattributes
├── .github/workflows/ci.yml
├── src/
│   ├── index.ts        # 엔트리: 이벤트 등록, 파이프라인, mode 처리
│   ├── types.ts        # 설정/결과 타입
│   ├── config.ts       # ~/.pi/agent/pi-guard.json 로드·검증
│   ├── extractor.ts    # URL 추출, 컨텍스트 화이트리스트 수집
│   ├── filter.ts       # 사설망/예시/bypass 판별
│   ├── http-check.ts   # HTTP 실존 확인
│   ├── dispatcher.ts   # 프록시/CA 설정 → undici dispatcher
│   └── verifier.ts     # LLM 판정
└── test/
    ├── extractor.test.ts
    ├── filter.test.ts
    ├── http-check.test.ts
    ├── dispatcher.test.ts
    ├── verifier.test.ts
    └── config.test.ts
```

## 7. 리스크 / 미결 사항
- **프록시 미설정**: 시스템 프록시/PAC는 자동 감지하지 않음. 프록시 필수 환경에서 설정이 없으면 HTTP가 전부 `UNCERTAIN` → LLM 의존. 연속 네트워크 오류 시 "프록시 설정 확인" 경고로 안내.
- **프록시 자격증명 평문 저장**: `http.proxy` URL에 비밀번호를 넣으면 설정 파일에 평문으로 남음. 가능하면 환경변수(`"env"`) 사용을 README에서 권장.
- **봇 차단 사이트**: 403/429는 LLM으로 넘기므로 오탐은 줄지만 판정 품질은 LLM 수준.
- **지연**: 답변 종료 시 HTTP(최대 `timeoutMs`) + LLM 호출만큼 settle이 늦어짐. 캐시·동시성·`maxUrls`로 완화.
- **SPA soft-404**: 200을 반환하는 존재하지 않는 페이지는 감지 불가 (범위 외).
