/**
 * prompt-injector.js — Wandlight Continuity
 * Registers the generate_interceptor on globalThis that prepends the
 * continuity memo into a structurally cloned chat message before generation.
 * Ephemeral: uses structuredClone/JSON roundtrip so injected text never
 * writes back to stored chat messages.
 *
 * Imports: constants.js, state-manager.js, memo-builder.js
 * Imported by: index.js
 */

import { LOG_PREFIX, MEMO_MAX_TOKENS } from './constants.js';
import { getSettings, getState } from './state-manager.js';
import { buildMemo } from './memo-builder.js';

/** Marker used to detect if memo was already injected into a message */
const MEMO_MARKER = '[WANDLIGHT CONTINUITY STATE]';

/**
 * Installs the interceptor on globalThis.wandlightContinuityInterceptor.
 * Called once from index.js on jQuery document ready.
 */
export function installInterceptor() {
    globalThis.wandlightContinuityInterceptor = wandlightContinuityInterceptor;
    if (typeof globalThis.wandlightContinuityInterceptor === 'function') {
        console.log(`${LOG_PREFIX} generate_interceptor registered`);
    } else {
        console.error(`${LOG_PREFIX} Failed to register generate_interceptor`);
    }
}

/**
 * ST's generate_interceptor hook function. Called mid-flight with a chat array
 * that may be mutable. To prevent injection from persisting into stored chat
 * history, we structurally clone the target message before modifying it and
 * then assign the clone back into the chat array slot.
 *
 * This follows the generate_interceptor contract:
 * - Receives chat array (may be mutable — do NOT assume it's a clone)
 * - Must NOT throw (ST wraps in try/catch but we still guard)
 * - Cannot be async per ST's current manifest hook spec
 *
 * @param {Array} chat - Chat array (may be mutable)
 * @param {number} contextSize - Context window size in tokens
 * @param {AbortSignal} abort - Abort signal for cancellation
 * @param {string} type - Generation type: 'normal', 'quiet', 'regenerate', 'impersonate', 'swipe', etc.
 */
function wandlightContinuityInterceptor(chat, contextSize, abort, type) {
    // ── Skip quiet generations — injection here contaminates extraction ──────
    if (type === 'quiet') return;
    try {
        const settings = getSettings();

        if (!settings.enabled) return;
        if (!settings.injectMemo) return;
        if (!chat || !Array.isArray(chat) || chat.length === 0) return;

        // Get the live continuity state (reacquired from ST context every time)
        const state = getState();
        if (!state) return;

        // Build the compact memo from current state
        const memo = buildMemo(state);
        if (!memo || typeof memo !== 'string' || memo.trim().length === 0) return;

        // ── Token guard: skip if memo exceeds the configured cap ──────────
        const estimatedTokens = estimateTokens(memo);
        if (estimatedTokens > MEMO_MAX_TOKENS) {
            if (settings.debugMode) {
                console.warn(`${LOG_PREFIX} Memo estimated at ${estimatedTokens} tokens (cap: ${MEMO_MAX_TOKENS}) — skipping injection`);
            }
            return;
        }

        // Find the last user message to prepend injection to.
        // Walk backward so we only modify the most recent user turn.
        for (let i = chat.length - 1; i >= 0; i--) {
            const msg = chat[i];
            if (!msg || !msg.is_user) continue;

            // Determine which field holds the message content (ST uses 'mes' primarily)
            const contentField = typeof msg.mes === 'string' ? 'mes'
                : typeof msg.content === 'string' ? 'content'
                : null;
            if (!contentField) continue;

            const originalContent = msg[contentField];

            // DOUBLE-INJECTION GUARD: skip if memo marker already present.
            if (originalContent && originalContent.includes(MEMO_MARKER)) {
                if (settings.debugMode) {
                    console.log(`${LOG_PREFIX} Memo marker already present — skipping injection`);
                }
                return;
            }

            // ── Ephemeral clone to prevent mutation of stored chat history ──
            // structuredClone is the preferred deep-copy mechanism; fall back
            // to JSON roundtrip for older ST engines that lack structuredClone.
            const cloned = typeof structuredClone === 'function'
                ? structuredClone(msg)
                : JSON.parse(JSON.stringify(msg));

            // Prepend the memo before the user's message text in the clone
            cloned[contentField] = memo + '\n\n' + originalContent;

            // Replace the chat array entry with the cloned message
            chat[i] = cloned;

            if (settings.debugMode) {
                console.log(`${LOG_PREFIX} Memo injected into last user message (${memo.length} chars, ~${estimateTokens(memo)} tokens)`);
            }
            return; // Only inject into the last user message
        }

        // If we got here, no valid user message was found — that's fine, skip
        if (settings.debugMode) {
            console.log(`${LOG_PREFIX} No user message found to inject memo into`);
        }
    } catch (e) {
        console.error(`${LOG_PREFIX} Interceptor error:`, e);
        // Never throw from an interceptor — ST silently swallows but we guard anyway
    }
}

/**
 * Rough token estimate from character length.
 * ST uses ~4 chars per token as a rule of thumb.
 * @param {string} text
 * @returns {number} estimated token count
 */
function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
}