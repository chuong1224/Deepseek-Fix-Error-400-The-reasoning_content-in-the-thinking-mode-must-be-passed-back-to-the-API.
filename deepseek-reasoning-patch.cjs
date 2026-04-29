/**
 * DeepSeek Reasoning Content Patch — v4
 *
 * Monkey-patches global fetch to intercept OpenClaw's API calls to DeepSeek.
 *
 * Handles:
 *   1. REQUEST: Replace reasoning_effort with proper thinking param + re-inject cached reasoning_content
 *   2. RESPONSE: Cache reasoning_content from both JSON and SSE streaming responses
 *   3. RE-INJECT: All assistant messages (not just tool_calls) — DeepSeek requires pass-back for ALL
 *   4. PERSISTENT CACHE: reasoning_content saved to disk, survives Gateway restarts
 *   5. GRACEFUL DEGRADATION: If cache is missing (first run / corrupted), disable thinking
 *      temporarily for that request so no 400 error is raised
 *
 * v4 fixes:
 *   - Persistent file-based cache (survives Gateway restart/SIGUSR1)
 *   - Graceful degradation: auto-disable thinking when cache lacks reasoning_content
 *   - Debounced file writes to avoid excessive I/O
 *   - Cache file saved alongside the patch script
 *
 * Why: DeepSeek V4 (Flash and Pro) returns 'reasoning_content' in responses, and
 * requires it back on subsequent requests. OpenClaw's OpenAI-compatible handler
 * doesn't know about this field.
 *
 * Rollback: Remove file + remove require() from preload → restart Gateway.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEEPSEEK_DOMAINS = ['api.deepseek.com'];

// ── Persistent cache ──
const CACHE_FILE = path.join(__dirname, '.reasoning-cache.json');
const CACHE_DEBOUNCE_MS = 2000; // Write to disk at most once per 2s

// In-memory store: maps message signature → reasoning_content
// For text messages: key = last 100 chars of content
// For tool_calls messages: key = tool:funcName1,funcName2 (unique per tool call)
const reasoningCache = new Map();

// ── Load cache from disk on startup ──
function loadCacheFromDisk() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (data && typeof data === 'object') {
        let count = 0;
        for (const [key, value] of Object.entries(data)) {
          if (typeof value === 'string' && value.length > 0) {
            reasoningCache.set(key, value);
            count++;
          }
        }
        console.error(`[deepseek-patch] Loaded ${count} reasoning cache entries from disk`);
      }
    }
  } catch (e) {
    console.error('[deepseek-patch] Failed to load cache from disk:', e.message);
  }
}

// ── Save cache to disk (debounced) ──
let saveTimer = null;
let pendingSave = false;

function scheduleSaveToDisk() {
  if (pendingSave) return;
  pendingSave = true;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    pendingSave = false;
    saveTimer = null;
    try {
      const obj = {};
      for (const [key, value] of reasoningCache) {
        obj[key] = value;
      }
      fs.writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) {
      console.error('[deepseek-patch] Failed to save cache to disk:', e.message);
    }
  }, CACHE_DEBOUNCE_MS);
}

// Load cache at startup
loadCacheFromDisk();

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
  // Use full content as key for better reliability (avoids collision on first 100 chars)
  // But trim very long responses to prevent bloated cache file
  return text.length > 500 ? text.slice(-500) : text;
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
    let cacheMiss = false;

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
            } else {
              // Found an assistant message that needs reasoning_content but cache is missing it
              // Only flag as cacheMiss if we actually need thinking
              cacheMiss = true;
            }
          }
        }
      }
    }

    // 2. Determine if thinking should be enabled/disabled
    let thinkingEnabled = false;
    if (body.reasoning_effort) {
      const effort = body.reasoning_effort;
      if (effort === 'high' || effort === 'medium' || effort === 'low' || effort === true) {
        thinkingEnabled = true;
      }
    } else if (body.thinking?.type === 'enabled') {
      thinkingEnabled = true;
    }

    // 3. Graceful degradation: if cache miss AND thinking is enabled,
    //    disable thinking for THIS request to prevent 400 error.
    //    The response won't have reasoning_content, but the NEXT request
    //    will build the cache properly (since no assistant message yet).
    if (cacheMiss && thinkingEnabled) {
      console.error('[deepseek-patch] Cache miss detected — disabling thinking for this request to prevent 400.');
      console.error('[deepseek-patch] Next request will re-enable thinking with fresh cache.');
      thinkingEnabled = false;
      body.thinking = { type: 'disabled' };
      if (body.reasoning_effort) delete body.reasoning_effort;
      modified = true;
    }

    // 4. Replace OpenClaw's reasoning_effort with DeepSeek's thinking param
    if (body.reasoning_effort) {
      body.thinking = { type: thinkingEnabled ? 'enabled' : 'disabled' };
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

    // 5. Cache reasoning_content from response
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
                if (delta?.content) content += delta.content;
                if (delta?.tool_calls) toolCalls = delta.tool_calls;
              } catch {}
            }
          }
          reasoningCache.set(hashContent(content, toolCalls), rc);
          scheduleSaveToDisk();
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
        scheduleSaveToDisk();
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
  module.exports = { reasoningCache, hashContent, extractReasoningContentFromSSE, CACHE_FILE };
}
