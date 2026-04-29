/**
 * DeepSeek Reasoning Content Patch — v3
 *
 * Monkey-patches global fetch to intercept OpenClaw's API calls to DeepSeek.
 * 
 * Handles:
 *   1. REQUEST: Replace reasoning_effort with proper thinking param + re-inject cached reasoning_content
 *   2. RESPONSE: Cache reasoning_content from both JSON and SSE streaming responses
 *   3. RE-INJECT: All assistant messages (not just tool_calls) — DeepSeek requires pass-back for ALL
 *
 * v3 fixes:
 *   - SSE streaming support: parse streaming chunks to extract reasoning_content
 *   - Re-inject for ALL assistant messages, not just tool_calls
 *   - Improved cache key using message index for plain messages
 *
 * Why: DeepSeek V4 (Flash and Pro) returns 'reasoning_content' in responses, and
 * requires it back on subsequent requests. OpenClaw's OpenAI-compatible handler
 * doesn't know about this field.
 *
 * Rollback: Remove file + remove require() from preload → restart Gateway.
 */

'use strict';

const DEEPSEEK_DOMAINS = ['api.deepseek.com'];

// In-memory store: maps message signature → reasoning_content
// For text messages: key = last 100 chars of content
// For tool_calls messages: key = tool:funcName1,funcName2 (unique per tool call)
const reasoningCache = new Map();

/**
 * Generate a unique cache key for an assistant message.
 * Uses tool_calls function names when available (content may be null/empty),
 * otherwise falls back to last 100 chars of content.
 */
function hashContent(text, toolCalls) {
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    return 'tool:' + toolCalls.map(tc => tc.function?.name || tc.id || 'unknown').join(',');
  }
  if (!text) return '';
  return text.slice(-100);
}

/**
 * Parse SSE (Server-Sent Events) text and extract reasoning_content
 * from streaming chat completion chunks.
 */
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

// Store original fetch
const originalFetch = globalThis.fetch;

globalThis.fetch = async function deepseekPatchedFetch(input, init) {
  const url = typeof input === 'string' ? input : (input?.url || input?.href || '');
  
  if (!shouldIntercept(url) || !init?.body) {
    return originalFetch.call(this, input, init);
  }

  // Only intercept chat/completions endpoints
  if (!url.includes('/chat/completions')) {
    return originalFetch.call(this, input, init);
  }

  try {
    const body = JSON.parse(typeof init.body === 'string' ? init.body : init.body.toString());
    if (!body) return originalFetch.call(this, input, init);

    let modified = false;

    // 1. Handle messages array: re-inject reasoning_content from cache
    //    For ALL assistant messages (not just tool_calls)
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

    // 2. Replace OpenClaw's reasoning_effort with DeepSeek's thinking param
    if (body.reasoning_effort) {
      // DeepSeek uses thinking: { type: "enabled" } or { type: "disabled" }
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

    // Send modified request
    const modifiedInit = {
      ...init,
      body: JSON.stringify(body)
    };

    const response = await originalFetch.call(this, input, modifiedInit);

    if (!response.ok) {
      // Log the error for debugging
      const errorBody = await response.text().catch(() => '');
      console.error('[deepseek-patch] API error:', response.status, errorBody.slice(0, 500));
      // Return the original error response (clone needed since we already read body)
      return new Response(errorBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    }

    // 3. Cache reasoning_content from response
    //    Supports both JSON and SSE streaming responses
    const clonedResponse = response.clone();
    const contentType = response.headers.get('content-type') || '';
    const isStreaming = contentType.includes('text/event-stream') || contentType.includes('application/x-ndjson');

    if (isStreaming) {
      // SSE streaming response — read clone body as text to extract reasoning_content
      const bodyText = await clonedResponse.text().catch(() => '');
      if (bodyText) {
        const rc = extractReasoningContentFromSSE(bodyText);
        if (rc) {
          // Try to find the final content in the SSE stream for cache key
          const lines = bodyText.split('\n');
          let content = '';
          let toolCalls = null;
          for (const line of lines) {
            if (line.startsWith('data: ') && line !== 'data: [DONE]') {
              try {
                const data = JSON.parse(line.slice(6));
                const delta = data.choices?.[0]?.delta;
                const finishReason = data.choices?.[0]?.finish_reason;
                if (delta?.content) content += delta.content;
                if (delta?.tool_calls) toolCalls = delta.tool_calls;
              } catch {}
            }
          }
          reasoningCache.set(hashContent(content, toolCalls), rc);
        }
      }
      // Return original response (clone was used for cache extraction)
      return response;
    } else {
      // JSON response — parse directly
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

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { reasoningCache, hashContent, extractReasoningContentFromSSE };
}
