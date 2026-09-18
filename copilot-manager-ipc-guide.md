# Copilot Manager IPC Guide

> **대상**: Copilot Manager를 통해 GitHub Copilot 모델을 사용하고 싶은 RisuAI 플러그인 개발자.
>
> **요구사항**: RisuAI Plugin API **v3.0** (plugin channel 지원 빌드). Copilot Manager 설정에서 "IPC 활성화"가 켜져 있어야 합니다.

---

## 1. 개요

Copilot Manager는 GitHub Copilot 토큰, 모델 목록, 요청 파이프라인을 다른 플러그인에게 **채널 기반 IPC**로 제공합니다. 호출자는 Copilot 인증이나 API 구현 없이도 모델 추론을 할 수 있습니다.

지원 기능:
- 상태 + 쿼터 조회 (`status`)
- 모델 목록 조회 (`listModels`)
- 채팅 추론 (`chat`) — 스트리밍, 실시간 청크, tool 호출 멀티턴 지원
- 진행 중 요청 취소 (`cancel`)

동시 요청 수는 Copilot Manager 설정의 `ipc_max_concurrent` (기본 1)로 제한됩니다.

---

## 2. 설정

### 2.1 호출자 플러그인 헤더

```javascript
//@name my-plugin
//@api 3.0
//@allowed-ipc my-plugin copilot-manager
```

`//@allowed-ipc`에 `my-plugin`을 집어넣는 이유는 RisuAI v2026.4.181 버전까지 버그로 인해 allowed-ipc가 제대로 인식되지 않기 때문입니다.

### 2.2 Copilot Manager 측 허용 등록

RisuAI의 IPC는 **양방향 허용**이 필요합니다. Copilot Manager 플러그인 파일 상단의 `//@allowed-ipc` 선언에 여러분의 플러그인 이름을 추가해야 합니다.

```diff
- //@allowed-ipc copilot-manager provider-manager
+ //@allowed-ipc copilot-manager provider-manager my-plugin
```

양쪽 모두 선언되지 않으면 메시지가 전달되지 않습니다.

### 2.3 채널 이름

| 방향 | 채널 |
|------|------|
| 호출자 → Copilot Manager | `copilot-manager/request` |
| Copilot Manager → 호출자 | `copilot-manager/response` |

---

## 3. 메시지 형식

### 요청

```typescript
interface IpcRequestEnvelope {
    id: string;        // 요청 고유 ID (호출자가 생성)
    op: "status" | "listModels" | "chat" | "cancel";
    payload?: unknown; // op별 데이터
}
```

### 응답

```typescript
interface IpcResponseEnvelope {
    id: string;        // 요청의 id를 그대로 반영
    type: "status" | "models" | "accepted" | "chunk" | "done" | "error";
    data: unknown;     // type별 데이터
}
```

동일 `id`에 대해 여러 응답이 올 수 있습니다 (스트리밍: `accepted` → `chunk` × N → `done`).

---

## 4. 기본 설정 코드

```javascript
//@name my-plugin
//@display-name My Plugin
//@api 3.0
//@allowed-ipc copilot-manager

const pending = new Map();

risuAPI.addPluginChannelListener("copilot-manager/response", (msg) => {
    const handler = pending.get(msg.id);
    if (handler) handler(msg);
});

function send(op, payload) {
    const id = `mp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    risuAPI.postPluginChannelMessage(
        "copilot-manager",
        "copilot-manager/request",
        { id, op, payload }
    );
    return id;
}

function callOnce(op, payload, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
        const id = send(op, payload);
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error("IPC timeout"));
        }, timeoutMs);
        pending.set(id, (msg) => {
            if (msg.type === "accepted") return; // 정보성 — 무시
            clearTimeout(timer);
            pending.delete(id);
            if (msg.type === "error") reject(new Error(`[${msg.data.code}] ${msg.data.message}`));
            else resolve(msg);
        });
    });
}
```

---

## 5. Operations

### 5.1 `status` — 상태 + 쿼터 조회

페이로드 없음.

```typescript
// 응답 data
{
    configured: boolean,          // 토큰이 설정돼 있는가
    activeIndex: number,          // 현재 활성 키 인덱스
    keys: Array<{
        index: number,
        alias: string,            // 사용자 지정 별칭 (빈 문자열이면 미설정)
        quota: {
            limit: number,        // -1이면 무제한 또는 조회 불가
            used: number
        }
    }>
}
```

```javascript
const { data } = await callOnce("status");
if (!data.configured) console.warn("Copilot 토큰 미설정");
```

### 5.2 `listModels` — 모델 목록

페이로드 없음.

```typescript
// 응답 data
{ modelIds: string[] }  // 예: ["gpt-4.1", "claude-sonnet-4.7", ...]
```

사용자가 숨긴 모델은 제외됩니다.

```javascript
const { data } = await callOnce("listModels");
console.log(data.modelIds);
```

### 5.3 `chat` — 추론 요청

#### 페이로드

```typescript
interface ChatPayload {
    model_id: string;                 // 필수
    messages: IpcChatMessage[];       // 필수

    // Tool 사용 (§6 참조)
    tools?: ToolDefinition[];
    turn?: "auto" | "user" | "agent";
    chain_id?: string;

    // 샘플링 (모두 선택)
    temperature?: number;
    top_p?: number;
    top_k?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    max_tokens?: number;

    // Thinking / Reasoning (누락 시 Copilot Manager 전역 설정 상속)
    effort?: "" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    thinking_budget?: number;
    omit_thinking?: boolean;
    use_instructions?: boolean;
    detailed_summary?: boolean;
    verbosity?: "low" | "medium" | "high";

    // 라우팅
    format?: "auto" | "anthropic" | "responses" | "openai";

    // 전송 모드
    streaming?: boolean;              // 기본 false
    realtime_chunks?: boolean;        // 기본 false. streaming=true일 때만 의미 있음
    raw?: boolean;                    // 기본 false. true면 파싱 없이 원본 전달

    // 키 선택
    key_index?: number;               // 특정 키 사용 (누락 시 현재 활성 키)
}
```

#### 메시지 형식

```typescript
interface IpcChatMessage {
    role: "system" | "user" | "assistant" | "function" | "char" | "tool";
    content?: string;
    name?: string;
    function_call?: unknown;
    tool_calls?: ToolCall[];          // assistant 메시지에 모델이 호출한 tool
    tool_call_id?: string;            // role="tool"에 필수
    is_error?: boolean;               // tool 실행 실패 표시
    multimodals?: Array<{
        type: "image" | "video" | "audio";
        base64: string;               // "data:image/png;base64,..." 형태
    }>;
    provider_contexts?: unknown[];    // 이전 응답의 providerContext를 전달 (고급 용도)
}

interface ToolCall {
    id: string;
    name: string;
    arguments: string;                // JSON 문자열 (검증 없이 보존됨)
}

interface ToolDefinition {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;  // JSON Schema
    strict?: boolean;
}
```

#### 응답 흐름

**`accepted`** — 요청이 수락됨:

```typescript
{
    type: "accepted",
    data: {
        streaming: boolean,
        realtimeChunks: boolean,      // 요청값과 다를 수 있음 (transport 제약)
        raw: boolean,
        turn: "user" | "agent",
        toolCount: number
    }
}
```

**`chunk`** — `streaming=true` + `realtime_chunks=true`일 때만:

```typescript
{
    type: "chunk",
    data: {
        phase: "thinking" | "text" | "raw",
        text: string                  // 단일 청크 (누적 아님)
    }
}
```

**`done`** — 완료:

```typescript
{
    type: "done",
    data: {
        success: true,
        content: string,              // realtime_chunks면 빈 문자열
        thinking?: string,            // realtime_chunks면 undefined
        toolCalls?: ToolCall[],       // 모델이 호출한 tool (§6 참조)
        usage?: { inputTokens?, outputTokens?, thinkingTokens?, cachedInputTokens?, totalTokens? },
        durationMs?: number,
        stopReason?: string,
        providerContext?: unknown     // tool chain 연속성을 위한 불투명 컨텍스트
    }
}
```

**`error`** — 실패 (이후 메시지 없음):

```typescript
{
    type: "error",
    data: { code: string, message: string }
}
```

#### 예제: 비스트리밍 호출

```javascript
const result = await callOnce("chat", {
    model_id: "gpt-4.1",
    messages: [{ role: "user", content: "안녕하세요" }],
});
console.log(result.data.content);
```

#### 예제: 실시간 스트리밍

```javascript
function chatStream(modelId, text, onChunk) {
    return new Promise((resolve, reject) => {
        const id = send("chat", {
            model_id: modelId,
            messages: [{ role: "user", content: text }],
            streaming: true,
            realtime_chunks: true,
        });
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error("IPC timeout"));
        }, 120000);
        pending.set(id, (msg) => {
            if (msg.type === "accepted") return;
            if (msg.type === "chunk") {
                onChunk(msg.data); // { phase, text }
                return;
            }
            clearTimeout(timer);
            pending.delete(id);
            if (msg.type === "error") reject(new Error(`[${msg.data.code}] ${msg.data.message}`));
            else resolve(msg.data);
        });
    });
}

let collected = "";
await chatStream("claude-sonnet-4.7", "5까지 세어줘", ({ phase, text }) => {
    if (phase === "text") collected += text;
});
```

> `accepted.realtimeChunks`가 `false`면 transport 제약으로 실시간 전송 불가. 이 경우 `done.content`에 전체 텍스트가 옵니다.

### 5.4 `cancel` — 요청 취소

```typescript
// 페이로드
{ target_id: string }  // 취소할 chat 요청의 id
```

`cancel` 자체에 대한 성공 응답은 없습니다. 대상 chat이 `CANCELLED` 에러로 종료됩니다.

```javascript
const chatId = send("chat", { model_id: "...", messages: [...], streaming: true, realtime_chunks: true });
// ... 나중에 취소
send("cancel", { target_id: chatId });
// chatId 핸들러가 CANCELLED 에러를 받음
```

---

## 6. Tool 호출 (멀티턴)

Copilot Manager는 tool을 **실행하지 않습니다**. 모델이 tool 호출을 반환하면 호출자가 직접 실행하고 결과를 돌려보내야 합니다.

### 흐름

1. `tools`와 `chain_id`를 포함해 첫 요청 전송
2. `done.toolCalls`가 있으면 tool 실행
3. 결과를 `role: "tool"` 메시지로 포함해 같은 `chain_id`로 재요청
4. 모델이 최종 응답을 줄 때까지 반복

### 규칙

- `tools`를 싣거나 `turn: "agent"`를 보내는 경우 `chain_id`는 **필수**
- `chain_id`는 같은 대화 체인 내에서 재사용 (envelope `id`는 매번 고유해야 함)
- `turn: "auto"` (기본값)는 마지막 메시지가 `tool`이면 자동으로 `agent`로 처리
- 체인 컨텍스트는 서버가 관리하므로 `providerContext`를 수동으로 넘길 필요 없음

### 예제

```javascript
const chainId = `chain-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const tools = [{
    name: "get_weather",
    description: "Get weather for a city",
    parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
    },
}];

// 1. 첫 요청
const first = await callOnce("chat", {
    model_id: "gpt-4.1",
    chain_id: chainId,
    tools,
    messages: [{ role: "user", content: "서울 날씨 알려줘" }],
});

if (first.data.toolCalls?.length) {
    // 2. Tool 실행
    const toolResults = await Promise.all(
        first.data.toolCalls.map(async (call) => {
            try {
                const result = await executeMyTool(call.name, call.arguments);
                return { role: "tool", tool_call_id: call.id, content: result };
            } catch (e) {
                return { role: "tool", tool_call_id: call.id, content: e.message, is_error: true };
            }
        }),
    );

    // 3. 결과 전송 (전체 대화 히스토리를 재구성)
    const final = await callOnce("chat", {
        model_id: "gpt-4.1",
        chain_id: chainId,
        tools,
        messages: [
            { role: "user", content: "서울 날씨 알려줘" },
            { role: "assistant", content: first.data.content, tool_calls: first.data.toolCalls },
            ...toolResults,
        ],
    });
    console.log(final.data.content);
}
```

> `tool_calls[].arguments`는 모델 출력이 깨져 있을 수 있습니다. 파싱 실패 시 `is_error: true`와 함께 에러 내용을 돌려주면 모델이 재시도할 수 있습니다.

---

## 7. 에러 코드

| 코드 | 의미 | 대응 |
|------|------|------|
| `IPC_DISABLED` | IPC 꺼짐 | 사용자에게 설정 활성화 안내 |
| `NOT_CONFIGURED` | 토큰 미설정 | 사용자에게 Copilot Manager 설정 안내 |
| `BUSY` | 동시 요청 상한 도달 | 잠시 후 재시도 |
| `UNKNOWN_MODEL` | model_id 없거나 숨김 처리됨 | `listModels` 재조회 |
| `INVALID_KEY` | `key_index` 범위 초과 | `status`로 키 개수 확인 |
| `INVALID_REQUEST` | 페이로드 검증 실패 | `message` 확인 후 수정 |
| `DUPLICATE_ID` | 같은 id로 이미 진행 중 | 고유 id 생성 확인 |
| `UNKNOWN_REQUEST` | cancel 대상 없음 | 이미 완료됐거나 id 오타 |
| `API_ERROR` | Copilot 서비스 실패 | 재시도 가치 있음 |
| `CANCELLED` | 취소됨 | 의도된 종료 |
| `INTERNAL` | 내부 버그 | 재시도 무의미, 리포트 필요 |

---

## 8. 주의사항

- **타임아웃 필수**: Copilot Manager는 응답을 보장하지 않습니다 (네트워크 장애, 플러그인 언로드 등). 모든 요청에 자체 타임아웃을 구현하세요.

- **id 고유성**: 같은 id를 두 번 쓰면 `DUPLICATE_ID`로 거부됩니다.

- **메모리 누수 방지**: `done`/`error` 수신 및 타임아웃 시 반드시 `pending` 핸들러를 정리하세요.

- **v3.0 API 존재 확인**: `addPluginChannelListener`와 `postPluginChannelMessage`의 존재를 런타임에 확인하는 것을 권장합니다.

- **전역 설정 상속**: `effort`, `thinking_budget`, `format` 등은 누락 시 사용자의 Copilot Manager 전역 설정을 상속합니다. 결정적 동작을 원하면 명시하세요.

- **streaming 독립성**: 페이로드의 `streaming` 값만 적용됩니다 (Copilot Manager 전역 streaming 설정과 무관).

---

## 9. 체크리스트

- [ ] 호출자 플러그인에 `//@allowed-ipc copilot-manager` 선언
- [ ] Copilot Manager의 `//@allowed-ipc`에 본인 플러그인 이름 추가
- [ ] `//@api 3.0` 선언
- [ ] plugin channel API 존재 확인 (없으면 폴백)
- [ ] 모든 요청에 타임아웃
- [ ] `done`/`error` 시 핸들러 정리
- [ ] tool 사용 시 `chain_id` 일관 사용
- [ ] `IPC_DISABLED` / `NOT_CONFIGURED` 시 사용자 안내 UI

---

## 10. TypeScript 클라이언트

`copilot-manager-client.ts`는 위 프로토콜을 감싼 standalone 라이브러리입니다. 타임아웃, 에러 처리, 스트리밍 ReadableStream 변환, OpenAI-compatible 어댑터, RisuAI Provider 브릿지를 제공합니다. 플러그인 소스 트리에 복사해서 사용하세요.

```typescript
import { CopilotManagerClient, toTextStream } from "./copilot-manager-client";

const client = new CopilotManagerClient();
const { modelIds } = await client.listModels();
const { content } = await client.chat({
    model_id: modelIds[0],
    messages: [{ role: "user", content: "hi" }],
});
```
