<p align="center">
  <a href="https://github.com/chuong1224/Deepseek-Fix-Error-400-The-reasoning_content-in-the-thinking-mode-must-be-passed-back-to-the-API./releases">
    <img src="https://img.shields.io/github/v/release/chuong1224/Deepseek-Fix-Error-400-The-reasoning_content-in-the-thinking-mode-must-be-passed-back-to-the-API.?color=brightgreen&label=version" alt="Version">
  </a>
  <img src="https://img.shields.io/badge/language-JavaScript-yellow.svg" alt="Language: JavaScript">
  <a href="https://github.com/chuong1224/Deepseek-Fix-Error-400-The-reasoning_content-in-the-thinking-mode-must-be-passed-back-to-the-API./blob/main/LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT">
  </a>
  <a href="https://github.com/chuong1224/Deepseek-Fix-Error-400-The-reasoning_content-in-the-thinking-mode-must-be-passed-back-to-the-API./commits/main">
    <img src="https://img.shields.io/github/last-commit/chuong1224/Deepseek-Fix-Error-400-The-reasoning_content-in-the-thinking-mode-must-be-passed-back-to-the-API." alt="Last commit">
  </a>
</p>

# Fixing DeepSeek V4 Thinking Mode 400 Error

> A runtime monkey-patch for OpenClaw / Cursor / Continue / any OpenAI-compatible client that doesn't handle DeepSeek's `reasoning_content` field.
>
> *Runtime monkey-patch cho OpenClaw / Cursor / Continue / bất kỳ client tương thích OpenAI nào không xử lý được trường `reasoning_content` của DeepSeek.*

---

## English

### Problem

When thinking mode is enabled, DeepSeek V4 (both Flash and Pro) returns a `reasoning_content` field alongside `content` in each assistant response. This field contains the model's internal chain-of-thought reasoning.

DeepSeek's API enforces a strict rule:

- **With tool calls**: if the model performed a tool call, `reasoning_content` from that turn **MUST** be passed back in all subsequent requests.
- **Without tool calls**: `reasoning_content` is optional (ignored by the API if present).

OpenClaw uses the OpenAI-compatible API adapter (`api: "openai-completions"`). Like most OpenAI-compatible clients (Cursor, VSCode, RooCode, Continue, etc.), it only handles `content` and `tool_calls` — it has no knowledge of the `reasoning_content` field.

This causes a **HTTP 400 error** on turn 2+ (after the first tool call):

```
reasoning_content in thinking mode must be passed back to the API
```

### Root Cause

The error occurs because:

1. **First request**: OpenClaw sends `{"reasoning_effort": "high"}` → DeepSeek returns SSE stream containing `delta.reasoning_content` in each chunk.
2. **OpenClaw's processing**: OpenClaw reconstructs the assistant message from deltas, extracting only `content` and `tool_calls`. The `reasoning_content` from the SSE stream is **dropped**.
3. **Subsequent request**: OpenClaw sends the conversation history including the assistant message — but **without** `reasoning_content`.
4. **DeepSeek rejects**: The API requires `reasoning_content` for messages that had tool calls → HTTP 400.

Additionally, there's a parameter format mismatch:
- OpenClaw sends: `{"reasoning_effort": "high"}` (OpenAI format)
- DeepSeek expects: `{"thinking": {"type": "enabled"}}` (native format)
- Both are accepted, but the `reasoning_content` pass-back requirement applies regardless.

### Solution: Runtime Monkey-Patch

We created a **Node.js CJS script** (`deepseek-reasoning-patch.cjs`) that monkey-patches `globalThis.fetch` to intercept all HTTP requests to `api.deepseek.com` at the process level.

The patch does three things:

#### 1. Request Transformation
| Before (OpenClaw) | After (Patched) |
|---|---|
| `reasoning_effort: "high"` | `thinking: {type: "enabled"}` |

#### 2. Response Caching
- **For JSON (non-streaming)**: reads `choices[0].message.reasoning_content` directly from the response body.
- **For SSE (streaming)**: reads the clone response body as text, parses each `data: {...}` line, and accumulates `delta.reasoning_content` across all chunks.
- Caches the result in an in-memory Map with a content-based key.

#### 3. Request Re-injection
Before each request, scans the `messages` array for any assistant message that lacks `reasoning_content`. If found, restores it from the cache.

**Cache key strategy:**
- **With tool calls**: `tool:funcName1,funcName2` — ensures each unique tool call combination gets its own cache entry.
- **Without tool calls**: last 100 characters of `content` — sufficient to distinguish messages in practice.

### Installation

#### Prerequisites
- OpenClaw running inside CrawBot (or any Node.js environment with `--require` support)
- DeepSeek V4 Flash or Pro model configured

#### Step 1: Create the patch script

Save `deepseek-reasoning-patch.cjs` to your project:

```bash
# Example: save to scripts/ directory
mkdir -p scripts
```

Paste the full source code (see below) into `scripts/deepseek-reasoning-patch.cjs`.

#### Step 2: Load the patch

Add `require()` to your startup preload file (e.g., `openclaw-patches-preload.cjs`):

```javascript
try {
  require('/path/to/scripts/deepseek-reasoning-patch.cjs');
} catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND') {
    console.error('[deepseek-patch] Load error:', e.message);
  }
}
```

If your environment supports `--require` flag:

```bash
node --require ./scripts/deepseek-reasoning-patch.cjs dist/index.js
```

#### Step 3: Configure thinking mode

In your `openclaw.json`:

```json
{
  "agents": {
    "defaults": {
      "thinkingDefault": "high"
    }
  },
  "models": {
    "providers": {
      "custom": {
        "models": [
          {
            "id": "deepseek-v4-pro",
            "reasoning": true
          }
        ]
      }
    }
  }
}
```

#### Step 4: Restart

Restart the Gateway (or the entire application) to load the patch.

### Full Source Code

The complete patch script is in `deepseek-reasoning-patch.cjs` in this repo. Key architecture:

```javascript
// Core data flow:
// 1. Request intercept → re-inject reasoning_content from cache + convert reasoning_effort → thinking
// 2. Response intercept → extract reasoning_content from JSON/SSE → save to persistent cache file
// 3. Graceful degradation → if cache miss on existing assistant messages, disable thinking temporarily
//
// Cache: file-based (.reasoning-cache.json), survives Gateway restart
// Debounced writes: 2s interval to minimize disk I/O
// Hash key: full content (up to 500 chars) for plain messages, tool:funcName for tool calls
```

For the full source, see `deepseek-reasoning-patch.cjs`.

```javascript
/**
 * DeepSeek Reasoning Content Patch — v3
 *
 * Monkey-patches globalThis.fetch to intercept OpenClaw's API calls to DeepSeek.
 *
 * Handles:
 *   1. REQUEST: Replace reasoning_effort with proper thinking param
 *      + re-inject cached reasoning_content for ALL assistant messages
 *   2. RESPONSE: Cache reasoning_content from both JSON and SSE streaming responses
 *   3. RE-INJECT: All assistant messages (not just tool_calls)
 *
 * v3 fixes:
 *   - SSE streaming support: parse streaming chunks to extract reasoning_content
 *   - Re-inject for ALL assistant messages, not just tool_calls (defensive)
 *   - Improved cache key using message content for plain messages
 */

'use strict';

const DEEPSEEK_DOMAINS = ['api.deepseek.com'];

// In-memory store: maps message signature → reasoning_content
const reasoningCache = new Map();

function hashContent(text, toolCalls) {
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    return 'tool:' + toolCalls.map(tc => tc.function?.name || tc.id || 'unknown').join(',');
  }
  if (!text) return '';
  return text.slice(-100);
}

function extractReasoningContentFromSSE(bodyText) {
  const lines = bodyText.split('\n');
  let reasoningContent = '';
  for (const line of lines) {
    if (line.startsWith('data: ') && line !== 'data: [DONE]') {
      try {
        const data = JSON.parse(line.slice(6));
        const delta = data.choices?.[0]?.delta;
        if (delta?.reasoning_content) {
          reasoningContent += delta.reasoning_content;
        }
      } catch {
        // Skip malformed JSON lines
      }
    }
  }
  return reasoningContent || null;
}

function shouldIntercept(url) {
  try {
    const u = new URL(url);
    return DEEPSEEK_DOMAINS.some(d => u.hostname === d || u.hostname.endsWith('.' + d));
  } catch {
    return false;
  }
}

const originalFetch = globalThis.fetch;

globalThis.fetch = async function deepseekPatchedFetch(input, init) {
  const url = typeof input === 'string' ? input : (input?.url || input?.href || '');
  
  if (!shouldIntercept(url) || !init?.body) {
    return originalFetch.call(this, input, init);
  }

  if (!url.includes('/chat/completions')) {
    return originalFetch.call(this, input, init);
  }

  try {
    const body = JSON.parse(typeof init.body === 'string' ? init.body : init.body.toString());
    if (!body) return originalFetch.call(this, input, init);

    let modified = false;

    // 1. Re-inject reasoning_content for ALL assistant messages
    if (Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (msg.role === 'assistant') {
          if (!msg.reasoning_content) {
            const key = hashContent(msg.content, msg.tool_calls);
            const cached = reasoningCache.get(key);
            if (cached) {
              msg.reasoning_content = cached;
              modified = true;
            }
          }
        }
      }
    }

    // 2. Replace reasoning_effort → thinking param
    if (body.reasoning_effort) {
      const effort = body.reasoning_effort;
      let thinkingType = 'disabled';
      if (effort === 'high' || effort === 'medium' || effort === 'low' || effort === true) {
        thinkingType = 'enabled';
      }
      body.thinking = { type: thinkingType };
      delete body.reasoning_effort;
      modified = true;
    }

    if (!modified) {
      return originalFetch.call(this, input, init);
    }

    const modifiedInit = { ...init, body: JSON.stringify(body) };
    const response = await originalFetch.call(this, input, modifiedInit);

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      console.error('[deepseek-patch] API error:', response.status, errorBody.slice(0, 500));
      return new Response(errorBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    }

    // 3. Cache reasoning_content from response (JSON or SSE)
    const clonedResponse = response.clone();
    const contentType = response.headers.get('content-type') || '';
    const isStreaming = contentType.includes('text/event-stream') || contentType.includes('application/x-ndjson');

    if (isStreaming) {
      const bodyText = await clonedResponse.text().catch(() => '');
      if (bodyText) {
        const rc = extractReasoningContentFromSSE(bodyText);
        if (rc) {
          // Extract content from SSE for cache key
          const lines = bodyText.split('\n');
          let content = '';
          let toolCalls = null;
          for (const line of lines) {
            if (line.startsWith('data: ') && line !== 'data: [DONE]') {
              try {
                const data = JSON.parse(line.slice(6));
                const delta = data.choices?.[0]?.delta;
                if (delta?.content) content += delta.content;
                if (delta?.tool_calls) toolCalls = delta.tool_calls;
              } catch {}
            }
          }
          reasoningCache.set(hashContent(content, toolCalls), rc);
        }
      }
      return response;
    } else {
      const resBody = await clonedResponse.json().catch(() => null);
      if (resBody?.choices?.[0]?.message?.reasoning_content) {
        const rc = resBody.choices[0].message.reasoning_content;
        const content = resBody.choices[0].message.content || '';
        const toolCalls = resBody.choices[0].message.tool_calls;
        reasoningCache.set(hashContent(content, toolCalls), rc);
      }
      return response;
    }

  } catch (err) {
    console.error('[deepseek-patch] Error:', err.message);
    return originalFetch.call(this, input, init);
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { reasoningCache, hashContent, extractReasoningContentFromSSE };
}
```

### How It Works (Detailed)

#### Cache Key Strategy

The cache key must uniquely identify an assistant message so `reasoning_content` can be restored on subsequent requests.

| Scenario | Key | Example |
|---|---|---|
| Tool calls present | `tool:func1,func2` | `tool:get_weather,get_date` |
| Plain text | Last 100 chars of content | `"...the weather forecast for Hangzhou tomorrow"` |

#### SSE vs JSON Handling

**Non-streaming (JSON)**: The entire response body is JSON. `response.clone().json()` parses it directly, and `reasoning_content` is at `choices[0].message.reasoning_content`.

**Streaming (SSE)**: The response body is a stream of `data: {...}\n\n` lines. The clone's body is read as text (consuming the clone, leaving the original stream intact for the client), then each SSE line is parsed to find `delta.reasoning_content`. The accumulated reasoning content is cached.

#### Why Clone the Response?

`response.clone()` creates two independent streams. Reading the clone's body (to extract `reasoning_content`) does not affect the original response body, which is consumed normally by OpenClaw's SSE parser.

### Testing

We verified the fix with this test sequence:

1. **Turn 1**: Question that triggers a tool call (e.g., weather check) → DeepSeek returns response with `reasoning_content`
2. **Turn 2**: Plain follow-up question (no tool calls) → no 400 error ✅
3. **Turn 3**: Another tool call (e.g., weather in different city) → no 400 error ✅

All three turns pass without errors. The patch correctly caches `reasoning_content` from Turn 1's SSE stream, re-injects it on Turn 2, and continues to work on subsequent turns.

### Rollback

To disable the patch:

1. Delete the patch file:
   ```bash
   rm scripts/deepseek-reasoning-patch.cjs
   ```
2. Remove the `require()` line from your preload file.
3. Disable thinking mode in config:
   ```json
   { "thinkingDefault": "off", "reasoning": false }
   ```
4. Restart the Gateway.

### Caveats

1. **Persistent cache (v4+)**: The cache is saved to `.reasoning-cache.json` alongside the patch script and survives Gateway restarts. Cache writes are debounced (2s interval) to minimize disk I/O.
2. **Cache key collisions**: Two different assistant messages with identical last-500-characters of content would share the same cache entry. Extremely unlikely in practice. v4 improved from 100 to 500 chars for better uniqueness.
3. **Memory for SSE parsing**: The entire SSE body is read into memory for cache extraction. For very long streaming responses, this could add memory pressure. In practice, `reasoning_content` is typically a few KB.
4. **Only intercepts `api.deepseek.com`**: Other providers are unaffected.
5. **CrawBot updates**: If CrawBot is updated, the preload file may be overwritten. Re-patching may be required.

### Patch Version History

| Version | Date | Changes |
|---|---|---|
| v1 | 29 Apr 10:05 | Initial patch using content hash as cache key. Failed when multiple tool-call messages with empty content collided (all mapped to `""`). |
| v2 | 29 Apr 10:50 | Fixed cache key to use tool function name(s). Tool-call messages now have unique entries. |
| **v3** | **29 Apr 11:04** | **Added SSE streaming support. Re-inject for ALL assistant messages, not just tool calls. This is the recommended version.** |
| **v4** | **29 Apr 13:40** | **Persistent file-based cache (survives Gateway restart). Graceful degradation: auto-disables thinking on cache miss to prevent 400. Improved hash key (500 chars instead of 100). Debounced disk writes.** |

### Technical Notes

- **OpenClaw version**: 2026.3.13
- **CrawBot version**: 2026.4.7
- **Models**: `deepseek-v4-flash`, `deepseek-v4-pro`
- **Node.js**: v22+ (v24.13.1 tested)
- **Why not a reverse proxy?**: An in-process approach is more robust — no separate process to manage, no auto-start complexity, and no risk of proxy process death.

---

## Tiếng Việt

### Vấn đề

Khi bật thinking mode, DeepSeek V4 (cả Flash và Pro) trả về thêm trường `reasoning_content` bên cạnh `content` trong mỗi câu trả lời. Trường này chứa chuỗi suy nghĩ nội bộ (chain-of-thought) của model.

DeepSeek API có quy tắc nghiêm ngặt:

- **Có tool calls**: nếu model đã gọi tool, `reasoning_content` của turn đó **BẮT BUỘC** phải được gửi lại trong các request sau.
- **Không có tool calls**: `reasoning_content` là tùy chọn (API sẽ bỏ qua nếu có).

OpenClaw dùng OpenAI-compatible API adapter (`api: "openai-completions"`). Giống hầu hết client tương thích OpenAI (Cursor, VSCode, RooCode, Continue...), nó chỉ xử lý `content` và `tool_calls` — hoàn toàn không biết trường `reasoning_content` tồn tại.

Điều này gây ra **lỗi HTTP 400** ở turn thứ 2+ (sau tool call đầu tiên):

```
reasoning_content in thinking mode must be passed back to the API
```

### Nguyên nhân gốc

Lỗi xảy ra vì:

1. **Request đầu tiên**: OpenClaw gửi `{"reasoning_effort": "high"}` → DeepSeek trả về SSE stream chứa `delta.reasoning_content` trong từng chunk.
2. **Xử lý của OpenClaw**: OpenClaw tái tạo assistant message từ các delta, chỉ lấy `content` và `tool_calls`. `reasoning_content` từ SSE stream bị **bỏ qua**.
3. **Request tiếp theo**: OpenClaw gửi lịch sử hội thoại bao gồm assistant message — nhưng **không có** `reasoning_content`.
4. **DeepSeek từ chối**: API yêu cầu `reasoning_content` cho những message có tool calls → HTTP 400.

Ngoài ra, có sự khác biệt về định dạng tham số:
- OpenClaw gửi: `{"reasoning_effort": "high"}` (định dạng OpenAI)
- DeepSeek mong đợi: `{"thinking": {"type": "enabled"}}` (định dạng native)
- Cả hai đều được chấp nhận, nhưng yêu cầu pass-back `reasoning_content` vẫn áp dụng.

### Giải pháp: Runtime Monkey-Patch

Chúng tôi tạo một **script CJS** (`deepseek-reasoning-patch.cjs`) monkey-patch `globalThis.fetch` để chặn tất cả request HTTP đến `api.deepseek.com` ở cấp tiến trình.

Patch làm ba việc:

#### 1. Biến đổi Request
| Trước (OpenClaw) | Sau (Patched) |
|---|---|
| `reasoning_effort: "high"` | `thinking: {type: "enabled"}` |

#### 2. Cache Response
- **JSON (non-streaming)**: đọc `choices[0].message.reasoning_content` trực tiếp từ body response.
- **SSE (streaming)**: đọc clone response body dưới dạng text, parse từng dòng `data: {...}`, và gộp `delta.reasoning_content` từ tất cả chunk.
- Lưu kết quả vào Map trong RAM với key dựa trên nội dung.

#### 3. Chèn lại vào Request
Trước mỗi request, quét mảng `messages` tìm message assistant nào thiếu `reasoning_content`. Nếu tìm thấy, khôi phục từ cache.

**Chiến lược cache key:**
- **Có tool calls**: `tool:funcName1,funcName2` — mỗi tổ hợp tool call có entry riêng.
- **Không có tool calls**: 100 ký tự cuối của `content` — đủ để phân biệt trong thực tế.

### Cài đặt

#### Bước 1: Tạo file patch

Lưu `deepseek-reasoning-patch.cjs` vào project:

```bash
mkdir -p scripts
```

Copy toàn bộ source code (xem ở trên) vào `scripts/deepseek-reasoning-patch.cjs`.

#### Bước 2: Load patch

Thêm `require()` vào file preload (vd: `openclaw-patches-preload.cjs`):

```javascript
try {
  require('/path/to/scripts/deepseek-reasoning-patch.cjs');
} catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND') {
    console.error('[deepseek-patch] Load error:', e.message);
  }
}
```

Nếu môi trường hỗ trợ flag `--require`:

```bash
node --require ./scripts/deepseek-reasoning-patch.cjs dist/index.js
```

#### Bước 3: Cấu hình thinking mode

Trong `openclaw.json`:

```json
{
  "agents": {
    "defaults": {
      "thinkingDefault": "high"
    }
  },
  "models": {
    "providers": {
      "custom": {
        "models": [
          {
            "id": "deepseek-v4-pro",
            "reasoning": true
          }
        ]
      }
    }
  }
}
```

#### Bước 4: Restart

Khởi động lại Gateway (hoặc toàn bộ ứng dụng) để load patch.

### Source Code Đầy Đủ

(Xem phần English ở trên — source code giống nhau.)

### Cách Hoạt Động (Chi Tiết)

#### Chiến Lược Cache Key

Cache key phải định danh duy nhất một assistant message để `reasoning_content` có thể được khôi phục trong request sau:

| Kịch bản | Key | Ví dụ |
|---|---|---|
| Có tool calls | `tool:func1,func2` | `tool:get_weather,get_date` |
| Plain text | 100 ký tự cuối của content | `"...dự báo thời tiết cho Hà Nội ngày mai"` |

#### Xử Lý SSE vs JSON

**Non-streaming (JSON)**: Toàn bộ body response là JSON. `response.clone().json()` parse trực tiếp, `reasoning_content` nằm ở `choices[0].message.reasoning_content`.

**Streaming (SSE)**: Body response là stream các dòng `data: {...}\n\n`. Clone body được đọc dưới dạng text (tiêu thụ clone, giữ nguyên stream gốc cho client), sau đó mỗi dòng SSE được parse để tìm `delta.reasoning_content`. Kết quả được cache lại.

#### Tại Sao Phải Clone Response?

`response.clone()` tạo hai stream độc lập. Đọc body của clone (để trích xuất `reasoning_content`) không ảnh hưởng đến response gốc, được OpenClaw tiêu thụ bình thường.

### Kiểm Thử

Chúng tôi đã kiểm tra với chuỗi test sau:

1. **Turn 1**: Câu hỏi kích hoạt tool call (ví dụ: xem thời tiết) → DeepSeek trả về response kèm `reasoning_content`
2. **Turn 2**: Câu hỏi tiếp theo không có tool → không lỗi 400 ✅
3. **Turn 3**: Tool call khác (thời tiết thành phố khác) → không lỗi 400 ✅

Cả ba turn đều pass. Patch cache chính xác `reasoning_content` từ SSE stream của Turn 1, chèn lại vào Turn 2, và tiếp tục hoạt động ở các turn sau.

### Khôi Phục (Rollback)

Để tắt patch:

1. Xoá file patch:
   ```bash
   rm scripts/deepseek-reasoning-patch.cjs
   ```
2. Xoá dòng `require()` khỏi file preload.
3. Tắt thinking mode trong config:
   ```json
   { "thinkingDefault": "off", "reasoning": false }
   ```
4. Restart Gateway.

### Lưu Ý

1. **Cache persistent (v4+)**: Cache được lưu vào file `.reasoning-cache.json` cạnh file patch và sống sót sau restart Gateway. Ghi file có debounce (2s) để giảm I/O đĩa.
2. **Collision cache key**: Hai assistant message khác nhau có 500 ký tự cuối giống nhau sẽ dùng chung cache key. Rất hiếm trong thực tế. v4 cải thiện từ 100 lên 500 ký tự.
3. **Bộ nhớ cho SSE parsing**: Toàn bộ body SSE được đọc vào RAM để trích xuất cache. Với stream rất dài, có thể tăng áp lực bộ nhớ. Trong thực tế, `reasoning_content` thường chỉ vài KB.
4. **Chỉ chặn `api.deepseek.com`**: Các provider khác không bị ảnh hưởng.
5. **CrawBot update**: Nếu CrawBot được cập nhật, file preload có thể bị ghi đè. Cần patch lại.

### Lịch Sử Phiên Bản Patch

| Phiên bản | Ngày | Thay đổi |
|---|---|---|
| v1 | 29/04 10:05 | Patch đầu dùng content hash làm cache key. Lỗi khi nhiều tool-call messages có content rỗng (tất cả map về key `""`). |
| v2 | 29/04 10:50 | Sửa cache key dùng tên function của tool. Mỗi loại tool call có entry riêng. |
| **v3** | **29/04 11:04** | **Thêm hỗ trợ SSE streaming. Chèn lại cho TẤT CẢ assistant messages (không chỉ tool calls). Đây là phiên bản khuyến nghị.** |
| **v4** | **29/04 13:40** | **Cache persistent (file `.reasoning-cache.json`), sống sót sau restart Gateway. Graceful degradation: tự động tắt thinking khi cache miss để tránh lỗi 400. Cải thiện hash key (500 ký tự thay vì 100). Ghi file có debounce.** |

### Ghi Chú Kỹ Thuật

- **OpenClaw version**: 2026.3.13
- **CrawBot version**: 2026.4.7
- **Models**: `deepseek-v4-flash`, `deepseek-v4-pro`
- **Node.js**: v22+ (đã test với v24.13.1)
- **Tại sao không dùng reverse proxy?**: Cách in-process ổn định hơn — không cần quản lý process riêng, không phức tạp auto-start, không rủi ro process chết.

---

*Document created: 2026-04-29*
*Last updated: 2026-04-29 13:40 PM (Asia/Ho_Chi_Minh)*
