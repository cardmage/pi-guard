# Answer Decider 기능 추가 계획서 (`plan.md`)

> 대상: `pi-guard` (`@earendil-works/pi-coding-agent` 1.4.x Extension)
> 브랜치: `feat/answer-decider`

## 1. 개요

기존 `pi-guard`의 **URL 검증(HTTP + LLM Verifier)** 기능과 별개로, 에이전트의 **직전 최종 응답 전체**를 로컬 Classifier/Decision 모델(예: `llama.cpp` 프로바이더를 통한 `pplx-decider-v1.1-27b` 등 설정된 모델)에 전달하여 **"응답이 틀렸는지(환각·모순·오류 여부)만 확률로 판별"**하는 기능을 추가한다.

- **URL 검사와 완전 분리**: 응답에 URL이 없어도 `decider.enabled: true`이면 직전 응답을 검사한다. 응답에 URL이 있는 경우 URL 검사와 Decider 검사가 각각 독립적인 설정(`mode`, `maxRewrites` 등)으로 동작한다.
- **모델 이름 설정화**: 특정 모델(`pplx-decider-v1.1-27b` 등)을 코드에 하드코딩하지 않고 `pi-guard.json`의 `decider.model`(및 `decider.provider`)로 설정한다.
- **Pi 내장 `llama.cpp` 연동**: Pi에 기본 포함된 `llama` 익스텐션(`provider: "llama.cpp"`) 및 `ctx.modelRegistry.classify()` API를 사용하여 Decision 모델(`/v1/systemone`)과 일반 로컬 모델(`llama-cpp-classify`) 모두 단일 인터페이스로 호출한다.

---

## 2. 핵심 설계 원칙

### 2.1 Pi 내장 Classifier API (`ctx.modelRegistry.classify`) 활용
- Pi의 내장 `llama.cpp` 프로바이더는 `llama-server`에 로드된 모델을 자동으로 `type: "classifier"` 카탈로그에 등록한다:
  - **Decision 모델** (`architecture.output_modalities`에 `"decisions"` 포함, 예: `pplx-decider`, `OpenJev` 등): `typesafe-system-one` API(`/v1/systemone`)로 단일 forward pass(출력 토큰 0) 판별.
  - **일반 Chat 모델**: `llama-cpp-classify` API(next-token 확률)로 판별.
- 모델 해석 규칙 (`resolveDeciderModel`):
  1. `decider.provider`(기본값 `"llama.cpp"`)와 `decider.model`이 지정된 경우 `ctx.modelRegistry.findOfType("classifier", provider, model)`로 조회.
  2. `decider.model`이 `null`이고 `decider.provider`(예: `"llama.cpp"`)에 등록된 classifier 모델이 정확히 1개뿐이면 해당 모델을 자동 선택. 여러 개이거나 없으면 세션당 1회 경고 후 통과(fail-open).

### 2.2 판별 입력(`state`) 및 질문(`questions`) 구성
단순히 최종 답변 텍스트만 넣으면 문맥을 알 수 없으므로, `event.context.contextMessages`에서 **마지막 사용자 입력 이후의 현재 턴 컨텍스트**를 추출하여 `state`로 전달한다.

```ts
interface DeciderState {
  userPrompt: string;        // 직전 사용자 메시지 텍스트 (최대 길이 제한 적용)
  toolResults?: Array<{      // 현재 턴에서 실행된 도구 결과 요약 (있을 경우)
    toolName: string;
    isError?: boolean;
    content: string;
  }>;
  assistantAnswer: string;   // 에이전트의 직전 최종 응답
}
```

- **토큰/길이 예산 관리**: Decision 모델(예: `pplx-decider` 8,192 토큰 한도)이 입력 초과로 거절하지 않도록 `userPrompt`, `toolResults`, `assistantAnswer`에 안전한 문자 길이 상한(truncation)을 적용한다.
- **단일 Binary Gate 질문 (`type: "bool"`)**:
  - `wrong` 질문 1개로 "직전 응답이 틀렸는가?"의 확률(`probability`: `0.0 ~ 1.0`)만 계산한다.
  - 판정 조건: `probability >= decider.threshold` 이면 **FAIL (틀림)**, 미만이면 **PASS**.

```ts
questions: {
  wrong: {
    type: "bool",
    instructions:
      cfg.decider.instructions ??
      "Judge whether `assistantAnswer` is wrong: does it contradict `toolResults`, fabricate facts or outputs not supported by the turn context, or contain clear factual or logical errors in response to `userPrompt`?",
    criteria: {
      true: "The answer is wrong, hallucinated, or contradicts the tool outputs or user prompt.",
      false: "The answer is accurate, faithful to the tool outputs, and properly addresses the user prompt.",
    },
  },
}
```

### 2.3 URL 검사와의 독립 실행 및 결합 (`agent_before_settle`)
1. `agent_before_settle` 이벤트 발생 (`outcome === "completed"`이고 마지막 assistant 텍스트가 비어있지 않을 때).
2. **Track 1 — URL Guard**:
   - `cfg.enabled`가 `true`이고 응답에 검사 대상 URL이 있을 때 실행.
   - 자체 `cfg.mode` (`"rewrite"` | `"warn"`) 및 `cfg.maxRewrites` 적용.
3. **Track 2 — Answer Decider**:
   - `cfg.decider.enabled`가 `true`일 때 URL 유무와 무관하게 실행.
   - 자체 `cfg.decider.mode` (`"rewrite"` | `"warn"`) 및 `cfg.decider.maxRewrites` 적용.
4. **병렬 실행 및 결과 처리**:
   - 두 트랙이 모두 활성화된 경우 `Promise.all`로 병렬 실행하여 지연을 최소화하고 동일한 AbortSignal(TUI `Esc` 취소 포함)을 공유한다.
   - 어느 한쪽(또는 양쪽)에서 `rewrite`가 트리거되면:
     - 해당 트랙의 rewrite 카운터를 증가시키고, 실패 사유(URL 실패 목록 및/또는 Decider 판정 확률)를 포함한 `custom_message`를 추가한 뒤 `continue: true`를 반환한다.
   - `warn` 모드이거나 해당 트랙의 `maxRewrites`에 도달한 경우:
     - `ctx.ui.notify(..., "warning")`으로 사용자에게 경고를 표시하고 세션 엔트리에 기록한다.

### 2.4 안정성 (Fail-Open)
- `llama.cpp` 서버 미실행, 모델 미발견, 타임아웃, 네트워크 오류, `stopReason !== "stop"` 발생 시:
  - 세션당 1회 `warnOnce`로 사용자에게 알리고 응답은 통과(fail-open)시킨다.

---

## 3. 설정 스키마 (`~/.pi/agent/pi-guard.json`)

기존 설정을 하위 호환성 있게 유지하면서 `decider` 섹션을 추가한다.

```json
{
  "enabled": true,
  "mode": "rewrite",
  "maxRewrites": 1,
  "maxUrls": 20,
  "skipCodeBlocks": true,
  "verifyContent": true,
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
  },
  "decider": {
    "enabled": false,
    "mode": "rewrite",
    "maxRewrites": 1,
    "provider": "llama.cpp",
    "model": null,
    "threshold": 0.8,
    "timeoutMs": 15000,
    "instructions": null
  }
}
```

### `decider` 설정 필드 상세

| 키 | 타입 | 기본값 | 설명 |
|---|---|---|---|
| `decider.enabled` | `boolean` | `false` | 직전 응답 판별 기능 활성화 여부 |
| `decider.mode` | `"rewrite" \| "warn"` | `"rewrite"` | 틀렸다고 판별됐을 때 재작성 요청(`rewrite`) 또는 경고만 표시(`warn`) |
| `decider.maxRewrites` | `integer` (`0..10`) | `1` | 사용자 프롬프트당 Decider가 요청할 수 있는 최대 재작성 횟수 |
| `decider.provider` | `string` | `"llama.cpp"` | Classifier 모델 프로바이더 ID (Pi 기본 `llama` 익스텐션은 `"llama.cpp"`) |
| `decider.model` | `string \| null` | `null` | 사용할 모델 ID (예: `"pplx-decider-v1.1-27b"`). `null`이면 해당 provider에 단일 classifier 모델이 있을 때 자동 선택 |
| `decider.threshold` | `number` (`(0, 1]`) | `0.8` | 응답이 틀렸다고 판정할 확률 임계값 (`probability >= threshold` 시 실패) |
| `decider.timeoutMs` | `integer` (`500..600000`) | `15000` | 로컬/원격 Classifier 호출 타임아웃(ms) |
| `decider.instructions` | `string \| null` | `null` | 커스텀 판별 지시문 (`null`이면 기본 지시문 사용) |

---

## 4. 파일별 변경 및 모듈 구조

```text
src/
├── index.ts          # agent_before_settle에서 URL Guard와 Answer Decider 병렬 실행 및 rewrite/warn 결합
├── types.ts          # DeciderConfig, DeciderFinding 타입 추가
├── config.ts         # decider 섹션 기본값 및 Validator.number(threshold) 검증 추가
├── extractor.ts      # extractTurnContext(messages): 마지막 user 프롬프트 및 toolResult 요약 추출 헬퍼 추가
├── decider.ts        # (신규) resolveDeciderModel(), evaluateWithDecider() 구현
├── verifier.ts       # 기존 URL LLM 검증 유지
├── http-check.ts     # 기존 URL HTTP 검증 유지
├── dispatcher.ts     # 기존 HTTP dispatcher 유지
└── filter.ts         # 기존 도메인 필터 유지
```

### 4.1 `src/decider.ts` (신규 모듈)
- `DEFAULT_DECIDER_INSTRUCTIONS`: 기본 판별 지시문 상수
- `resolveDeciderModel(cfg, registry)`:
  - `registry.findOfType("classifier", cfg.provider, cfg.model)` 또는 `registry.getModelsOfType("classifier", cfg.provider)` 조회
  - 모델 미발견 시 명확한 안내 메시지 반환 (예: `decider model "llama.cpp/..." not found; load it with /llama or check decider.model`)
- `evaluateWithDecider(turn, { model, registry, config, signal })`:
  - `registry.classify(model, { state, questions }, { signal, timeoutMs })` 호출
  - `result.answers.wrong`의 `probability` 추출
  - `failed = probability >= config.threshold` 계산 후 `DeciderFinding` 반환

### 4.2 `src/extractor.ts` 확장
- `extractTurnContext(messages: readonly LooseMessage[], assistantIdx: number)`:
  - `assistantIdx` 이전의 마지막 `role === "user"` 메시지를 찾아 `userPrompt` 추출 (최대 4,000자 제한)
  - 그 사이의 `role === "toolResult"` 메시지들에서 `toolName`, `isError`, 텍스트 본문 요약(건당 최대 1,500자, 총합 최대 8,000자) 추출
  - `assistantAnswer` (최대 8,000자)와 함께 반환하여 로컬 모델의 8K 컨텍스트 한도를 안전하게 준수

### 4.3 피드백 및 경고 메시지 (`src/index.ts`)
- **Rewrite 메시지 (`buildDeciderRewriteMessage` / 통합 메시지)**:
  - `[pi-guard] The answer verifier flagged your last response as likely incorrect (probability: 91% >= 80%).`
  - `Re-check your claims against the user prompt and tool outputs from this turn, fix any factual errors or unsupported claims, and provide a corrected answer. Do not mention this check.`
- **Warn 메시지 (`buildDeciderWarning`)**:
  - `pi-guard: answer flagged as potentially incorrect (91%, model: llama.cpp/...)`

---

## 5. 구현 및 테스트 단계

1. **Step 1 — 타입 및 설정(`src/types.ts`, `src/config.ts`)**
   - `DeciderConfig`, `DeciderFinding` 정의
   - `validateConfig`에서 `decider` 섹션 파싱 및 유효성 검사 (`threshold` 범위 `0 < t <= 1` 등)
   - `test/config.test.ts`에 `decider` 설정 테스트 추가
2. **Step 2 — 턴 컨텍스트 추출(`src/extractor.ts`) 및 `src/decider.ts` 구현**
   - `extractTurnContext` 구현 및 길이 제한(truncation) 테스트
   - `resolveDeciderModel`, `evaluateWithDecider` 구현 및 단위 테스트(`test/decider.test.ts`) 작성
3. **Step 3 — `src/index.ts` 통합**
   - URL이 없는 응답에서도 `decider.enabled`이면 동작하도록 `agent_before_settle` 플로우 개선
   - URL Guard + Answer Decider 독립 `mode` / `maxRewrites` 관리 및 통합 테스트(`test/extension.test.ts`) 추가
4. **Step 4 — 문서 업데이트 (`README.md`, `README.ko.md`)**
   - `llama.cpp` 연동 및 `decider` 설정 예시 문서화
   - `npm run check` (`tsc --noEmit && vitest run`) 통과 확인
