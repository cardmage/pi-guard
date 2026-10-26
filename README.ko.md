# pi-guard

[English](./README.md) | 한국어

에이전트의 최종 답변에 포함된 모든 URL을 검증하여 환각(hallucinated) 출처 링크나 사실과 다르게 인용된 링크를 잡아내는 [Pi](https://pi.dev) 확장(extension)입니다.

LLM은 기억만으로 임의의 URL이 실제로 존재하는지 알 수 없으며, 주소 형태가 그럴듯한지만 추측할 수 있습니다. 따라서 `pi-guard`는 **먼저 HTTP를 통해 URL을 확인**하고, 검증 LLM을 통해 **인용 내용 일치 여부(Content Grounding)**(실제 페이지 본문이 에이전트의 주장을 뒷받침하는지 및 soft-404가 아닌지)와 HTTP만으로 판단할 수 없는 경우(403/429 봇 차단, 5xx 서버 오류, 타임아웃, 네트워크 오류 등)의 **실존 여부 폴백 판정**을 수행합니다.

인용된 URL이 검증에 실패하면(HTTP `404`, `410`, DNS `ENOTFOUND` 또는 검증 모델의 `NOT_EXISTS` / `CONTRADICTED` 판정):
- **`rewrite`** (기본값): 에이전트에게 피드백 메시지를 전달하여 가짜 링크나 잘못된 주장을 수정해 답변을 다시 작성하도록 요청합니다(사용자 프롬프트당 최대 `maxRewrites`회까지 재시도하며, 초과 시 `warn`으로 강등).
- **`warn`**: 경고 알림만 표시하고 답변은 그대로 유지합니다.

## 설치

```bash
pi install npm:pi-guard
```

설치하지 않고 단일 세션에서 바로 테스트하려면:

```bash
pi -e npm:pi-guard
# 또는 로컬 체크아웃 경로에서 실행:
pi -e ./
```

**Node.js ≥ 22.19.0**이 필요합니다(Pi 요구사항과 동일). Windows, macOS, Linux를 모두 지원합니다.

## 동작 방식

`agent_before_settle` 이벤트 시점(실행이 `outcome === "completed"`로 정상 종료될 때):

1. **URL 추출**: 마지막 어시스턴트 메시지에서 `http://` 및 `https://` URL(마크다운 링크, `<autolink>`, 일반 URL)을 추출합니다. 끝에 붙은 문장 부호, 짝이 맞지 않는 닫는 괄호, ASCII 경로 뒤에 바로 붙은 한국어 조사(예: `https://a.com/docs에서`) 등을 자동으로 분리하며, 프래그먼트(`#...`)를 제거하고 중복을 하나로 합칩니다.
2. **검증 제외 대상 필터링**:
   - 사설/로컬 호스트: `localhost`, `127.*`, `10.*`, `172.16–31.*`, `192.168.*`, `169.254.*`, `::1`, `fc00::/7`, `fe80::/10`, 단일 라벨 호스트, `*.local`, `*.internal`, `*.corp`, `*.lan`.
   - 예약된 예시 도메인(RFC 2606 / RFC 6761): `example.com/.net/.org`, `*.test`, `*.example`, `*.invalid`, `*.localhost`.
   - `bypassDomains` 설정과 일치하는 호스트 또는 경로 접두사(예: `"*.mycompany.com"`, `"github.com/private-repo"`).
   - 코드 블록 및 인라인 코드 안의 URL(`skipCodeBlocks: true`일 때).
3. **HTTP 확인** (`verifyContent: true`일 때는 `GET`으로 텍스트 일부 추출, `false`일 때는 `HEAD` 요청 후 필요 시 본문을 읽지 않고 즉시 취소하는 `GET` 폴백):
   - `2xx` / `3xx → 2xx` → `OK` (`verifyContent: true`이면 페이지 텍스트 추출)
   - `404`, `410`, DNS `ENOTFOUND` → `NOT_FOUND` (실패)
   - `401`, `403`, `429`, `5xx`, 타임아웃, TLS/프록시/네트워크 오류 → `UNCERTAIN` (보류)
4. **LLM 판정**: `UNCERTAIN` URL(실존 판정: `EXISTS` | `NOT_EXISTS` | `UNKNOWN`)과 `verifyContent: true`일 때 본문이 추출된 `OK` URL(인용 내용 검증: `SUPPORTED` | `CONTRADICTED` | `NOT_EXISTS`(soft-404) | `UNKNOWN`)을 한 번의 호출로 일괄 판정합니다. `UNKNOWN`이거나 모델/인증/파싱 오류가 발생하면 세션이 멈추지 않도록 통과(fail-open) 처리합니다.

## 설정

`~/.pi/agent/pi-guard.json` (Windows의 경우 `%USERPROFILE%\.pi\agent\pi-guard.json`, `PI_CODING_AGENT_DIR` 환경변수 존중) 파일을 생성합니다. 수정 후에는 Pi에서 `/reload`를 실행하면 반영됩니다. 설정 파일이 없으면 모든 항목에 기본값이 적용됩니다.

```json
{
  "enabled": true,
  "mode": "rewrite",
  "maxRewrites": 1,
  "maxUrls": 20,
  "skipCodeBlocks": true,
  "verifyContent": true,
  "bypassDomains": [
    "*.mycompany.com",
    "jira.mycompany.io"
  ],
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

| 키 | 기본값 | 설명 |
|---|---|---|
| `enabled` | `true` | 확장 기능을 활성화하거나 비활성화합니다. |
| `mode` | `"rewrite"` | `"rewrite"`는 에이전트에게 답변 재작성을 요청하고, `"warn"`은 경고 알림만 표시합니다. |
| `maxRewrites` | `1` | 사용자 프롬프트당 최대 재작성 요청 횟수입니다. 초과 시 `"warn"`으로 강등됩니다. |
| `maxUrls` | `20` | 답변 하나에서 검사할 최대 URL 개수입니다. |
| `skipCodeBlocks` | `true` | 펜스 코드 블록 및 인라인 코드 내부의 URL을 무시합니다. |
| `verifyContent` | `true` | HTTP 200 응답 페이지의 본문 텍스트를 추출해 에이전트가 해당 URL 주변에서 주장한 내용을 실제로 뒷받침하는지(및 soft-404가 아닌지) 검증 LLM으로 대조합니다. |
| `bypassDomains` | `[]` | 검사를 건너뛸 도메인 또는 경로 접두사 목록입니다(`"foo.com"`은 루트 도메인과 서브도메인 모두 매칭, `"*.foo.com"`은 서브도메인만 매칭, `"github.com/org/repo"`는 해당 경로 하위만 매칭). |
| `verifier.provider` / `verifier.model` | `null` | `UNCERTAIN` URL 판정에 사용할 모델입니다. `null`이면 현재 세션 모델(`ctx.model`)을 사용합니다. 지정한 모델을 찾을 수 없거나 인증 정보가 없으면 경고를 띄우고 `ctx.model`로 대체합니다. |
| `verifier.thinking` | `"low"` | `"off"` \| `"minimal"` \| `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` \| `"max"`. `"off"`이거나 모델이 추론(reasoning)을 지원하지 않으면 생략됩니다. |
| `verifier.systemPrompt` | `null` | 설정 시 내장된 검증용 시스템 프롬프트 전체를 교체합니다. |
| `verifier.timeoutMs` | `30000` | 검증 LLM 호출 타임아웃(밀리초)입니다. |
| `http.enabled` | `true` | `false`로 설정하면 HTTP 확인을 건너뛰고 모든 URL을 LLM으로만 판정합니다. |
| `http.timeoutMs` | `8000` | URL당 HTTP 타임아웃(밀리초)입니다. |
| `http.concurrency` | `5` | 동시에 실행할 최대 HTTP 확인 요청 수입니다. |
| `http.userAgent` | `null` | 커스텀 `User-Agent` 헤더입니다(`null`이면 브라우저 유사 기본값을 사용). |
| `http.proxy` | `"env"` | `"env"` (`HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` 환경변수 사용), `"none"` (항상 직접 연결), 또는 명시적 프록시 URL (`http://`, `https://`, `socks5://`). |
| `http.noProxy` | `[]` | 명시적 `http.proxy` URL을 우회할 호스트 목록입니다(예: `[".corp.com", "10.0.0.1:8080"]`). `"env"` 모드에서는 `NO_PROXY` 환경변수를 사용하세요. |
| `http.useSystemCa` | `true` | Node 내장 CA 외에 OS 인증서 저장소의 루트 인증서도 신뢰합니다(사내 TLS 검사 프록시 환경 대응). |

## 사내 프록시 및 TLS 검사 환경

기본 설정(`"proxy": "env"`, `"useSystemCa": true`)에서 표준 프록시 환경변수를 자동으로 읽으며, Windows 인증서 저장소, macOS 키체인(Keychain), Linux 시스템 번들에 등록된 루트 인증서를 신뢰합니다.

### 프록시 환경변수 설정 방법

**Windows (PowerShell — 현재 세션에만 적용):**
```powershell
$env:HTTPS_PROXY = "http://proxy.corp.com:8080"
$env:HTTP_PROXY  = "http://proxy.corp.com:8080"
$env:NO_PROXY    = "localhost,127.0.0.1,.corp.com"
```

**Windows (사용자 계정에 영구 적용):**
```powershell
setx HTTPS_PROXY "http://proxy.corp.com:8080"
setx NO_PROXY "localhost,127.0.0.1,.corp.com"
```

**macOS / Linux (`~/.zshrc` 또는 `~/.bashrc`):**
```bash
export HTTPS_PROXY="http://proxy.corp.com:8080"
export HTTP_PROXY="http://proxy.corp.com:8080"
export NO_PROXY="localhost,127.0.0.1,.corp.com"
```

또는 `pi-guard.json`에 `"http": { "proxy": "http://proxy.corp.com:8080", "noProxy": [".corp.com"] }`를 직접 지정할 수도 있습니다. 단, `pi-guard.json` 파일은 평문으로 저장되므로 `user:password@` 형태의 자격증명은 설정 파일에 넣지 말고 가급적 환경변수를 사용하는 것을 권장합니다.

> **참고 사항**
> - OS의 자동 프록시 설정(Windows 인터넷 옵션 / macOS 네트워크 설정) 및 PAC/WPAD 스크립트는 자동으로 감지하지 않으므로 환경변수 또는 `http.proxy`에 프록시 주소를 명시해야 합니다.
> - Undici의 `socks5://` 프록시 지원은 실험적(Experimental) 기능입니다.

## 개발 및 테스트

```bash
npm test          # vitest run
npm run typecheck # tsc --noEmit
npm run check     # 타입체크 및 테스트 전체 실행
```
