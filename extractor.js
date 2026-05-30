/**
 * extractor.js — Wandlight Continuity
 * Runs the LLM extraction process on GENERATION_ENDED to produce JSON deltas
 * that are validated, merged into state, and persisted.
 *
 * Uses generateQuietPrompt (with generateRaw fallback) for the extraction call.
 * Guard flag _extractionRunning prevents concurrent extraction passes.
 *
 * Imports: constants.js, state-manager.js
 * Imported by: index.js
 * Registered on globalThis as: _wandlightRunExtraction
 */

import { LOG_PREFIX, EXTRACTION_SYSTEM_PROMPT, EXTRACTION_USER_PROMPT } from './constants.js';
import {
    getSettings,
    getState,
    applyDelta,
    saveState,
    pushStateSnapshot,
    validateDelta,
} from './state-manager.js';

/** Guard flag to prevent concurrent extraction passes. */
let _extractionRunning = false;

/**
 * Collects recent narrative text from the chat array for the extraction prompt.
 * Collects from the last user turn forward (user message + all assistant replies
 * since then, up through current generation end).
 * @param {Array} chat - The chat array from SillyTavern.getContext()
 * @returns {string} Formatted recent messages string
 */
function collectRecentMessages(chat) {
    if (!chat || chat.length === 0) return '';

    // Walk backward to find the last user message, then collect everything after it
    let startIdx = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i]?.is_user) {
            startIdx = i;
            break;
        }
    }
    if (startIdx === -1) startIdx = 0;

    const messages = [];
    for (let i = startIdx; i < chat.length; i++) {
        const msg = chat[i];
        if (!msg) continue;
        const role = msg.is_user ? 'User' : (msg.is_system ? 'System' : 'Assistant');
        let content = msg.mes || msg.content || '';
        if (!content.trim()) continue;

        // Strip thinking/reasoning tags so the extraction prompt is clean
        content = content.replace(/<think\b[^>]*>([\s\S]*?)<\/think>/gi, '');
        content = content.replace(/<thinking\b[^>]*>([\s\S]*?)<\/thinking>/gi, '');
        content = content.replace(/<reasoning\b[^>]*>([\s\S]*?)<\/reasoning>/gi, '');
        content = content.trim();

        if (content) {
            messages.push(`[${role}]\n${content}`);
        }
    }

    return messages.join('\n\n');
}

/**
 * Parses a JSON delta string from the LLM extraction response.
 * Handles markdown fences, leading/trailing non-JSON text, and bad escapes.
 * Then validates the parsed delta against the schema.
 *
 * @param {string} response - Raw LLM response text
 * @returns {Object|null} Parsed + validated WandlightDelta or null on failure
 */
function parseDeltaResponse(response) {
    if (!response || typeof response !== 'string') return null;

    let jsonStr = response.trim();

    // Remove ```json fences if present
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch) {
        jsonStr = fenceMatch[1].trim();
    } else {
        // Try to find the first { and last }
        const firstBrace = jsonStr.indexOf('{');
        const lastBrace = jsonStr.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace > firstBrace) {
            jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);
        }
    }

    let parsed;
    try {
        parsed = JSON.parse(jsonStr);
    } catch (e) {
        console.warn(`${LOG_PREFIX} Failed to parse delta JSON:`, e.message);
        console.debug(`${LOG_PREFIX} Raw response (first 300 chars):`, response.substring(0, 300));
        return null;
    }

    // Ensure parsed has changes key — LLMs sometimes return bare objects
    if (parsed && typeof parsed === 'object' && !parsed.changes) {
        // If the object has known change keys at top level, wrap them
        const knownKeys = ['canon', 'scene', 'knowledge', 'secrets', 'relationships', 'threads', 'continuityFlags'];
        const hasChangesKey = knownKeys.some(k => k in parsed);
        if (hasChangesKey) {
            parsed = { summary: parsed.summary || '', changes: parsed };
        } else if (Object.keys(parsed).length === 0) {
            // Empty object — treat as no-op
            parsed = { summary: 'No changes detected', changes: {} };
        }
    }

    // Validate against the formal delta schema
    if (!parsed.changes) {
        console.warn(`${LOG_PREFIX} Parsed delta has no "changes" key`);
        return null;
    }

    const { valid, errors } = validateDelta(parsed);
    if (!valid) {
        console.warn(`${LOG_PREFIX} Delta validation failed:`, errors.join('; '));
        return null;
    }

    return parsed;
}

/**
 * Runs a quiet LLM call to extract continuity state changes.
 * Uses object-style API: generateQuietPrompt({ quietPrompt }) and
 * generateRaw({ systemPrompt, prompt, prefill }) per current ST docs.
 *
 * @param {string} stateJson - JSON string of current state
 * @param {string} messages - Recent roleplay messages text
 * @returns {Promise<Object|null>} Parsed + validated WandlightDelta or null on failure
 */
async function runExtractionCall(stateJson, messages) {
    const ctx = SillyTavern.getContext();
    const settings = getSettings();

    // Build the system prompt with state and messages interpolated
    const systemPrompt = EXTRACTION_SYSTEM_PROMPT
        .replace('{{stateJson}}', stateJson)
        .replace('{{messages}}', messages);

    // Prepare the user-side prompt (what the extraction LLM sees as "the task")
    const userPrompt = EXTRACTION_USER_PROMPT;

    let response = null;

    try {
        // ── Primary: generateRaw (full prompt control, object-style) ────────
        // Extraction requires both the state+message context (systemPrompt)
        // and the extraction task instruction (userPrompt) to reach the model.
        // generateRaw passes both fields reliably; generateQuietPrompt may not
        // forward systemPromptOverride, so we use it only as a fallback.
        if (ctx && typeof ctx.generateRaw === 'function') {
            if (settings.debugMode) {
                console.log(`${LOG_PREFIX} Calling generateRaw for extraction...`);
            }
            response = await ctx.generateRaw({
                systemPrompt: systemPrompt,
                prompt: userPrompt,
                prefill: '',
            });
        }
        // ── Fallback: generateQuietPrompt with combined prompt ───────────────
        else if (ctx && typeof ctx.generateQuietPrompt === 'function') {
            if (settings.debugMode) {
                console.log(`${LOG_PREFIX} generateRaw unavailable, falling back to generateQuietPrompt`);
            }
            // Combine system+user into quietPrompt so state context is not lost
            const combinedPrompt = `${systemPrompt}\n\n${userPrompt}`;
            response = await ctx.generateQuietPrompt({
                quietPrompt: combinedPrompt,
            });
        }
        // ── Hard fallback: ctx.generate() ───────────────────────────────────
        else if (ctx && typeof ctx.generate === 'function') {
            console.log(`${LOG_PREFIX} Falling back to ctx.generate() for extraction`);
            response = await ctx.generate(systemPrompt + '\n\n' + userPrompt);
        } else {
            console.warn(`${LOG_PREFIX} No generation function available for extraction`);
            return null;
        }
    } catch (e) {
        console.error(`${LOG_PREFIX} Extraction call failed:`, e);
        return null;
    }

    if (!response || typeof response !== 'string') {
        console.warn(`${LOG_PREFIX} Extraction response was empty or non-string`);
        return null;
    }

    if (settings.debugMode) {
        console.log(`${LOG_PREFIX} Extraction response received (${response.length} chars)`);
    }

    return parseDeltaResponse(response);
}

/**
 * Main extraction handler. Called on GENERATION_ENDED if autoExtract is enabled.
 * Collects recent messages, calls the LLM for delta extraction, validates,
 * applies the delta (or stores it for manual review), and persists state.
 *
 * Guarded by _extractionRunning to prevent concurrent passes.
 *
 * @param {Object} [options]
 * @param {boolean} [options.force] - If true, bypasses throttle and autoExtract check
 */
export async function onExtractionTriggered(options = {}) {
    const { force = false } = options;

    if (_extractionRunning) {
        const settings = getSettings();
        if (settings.debugMode) {
            console.log(`${LOG_PREFIX} Extraction already running, skipping`);
        }
        return;
    }

    const settings = getSettings();
    if (!settings.enabled) return;
    if (!force && !settings.autoExtract) return;

    // Throttle: only run every N generations (skip if forced)
    if (!force) {
        if (typeof onExtractionTriggered._counter === 'undefined') {
            onExtractionTriggered._counter = 0;
        }
        onExtractionTriggered._counter++;
        const interval = settings.extractionInterval || 1;
        if (onExtractionTriggered._counter < interval) return;
        onExtractionTriggered._counter = 0;
    }

    _extractionRunning = true;

    try {
        const ctx = SillyTavern.getContext();
        const chat = ctx && ctx.chat ? ctx.chat : null;
        if (!chat || !Array.isArray(chat) || chat.length === 0) {
            if (settings.debugMode) {
                console.log(`${LOG_PREFIX} No chat messages \u2014 cannot run extraction`);
            }
            return;
        }

        // Collect recent messages
        const messages = collectRecentMessages(chat);
        if (!messages) {
            if (settings.debugMode) {
                console.log(`${LOG_PREFIX} No recent messages to extract from`);
            }
            return;
        }

        // Get current state (reacquired from ST context)
        const state = getState();

        let stateJson;
        try {
            stateJson = JSON.stringify(state);
        } catch (e) {
            console.error(`${LOG_PREFIX} Failed to serialize state:`, e);
            return;
        }

        if (settings.debugMode) {
            console.log(`${LOG_PREFIX} Running extraction pass...`);
            console.debug(`${LOG_PREFIX} Messages length:`, messages.length, `State JSON:`, stateJson.length);
        }

        // Run the extraction LLM call
        const delta = await runExtractionCall(stateJson, messages);

        if (!delta) {
            if (settings.debugMode) {
                console.log(`${LOG_PREFIX} Extraction returned no valid delta`);
            }
            return;
        }

        // Check for no-op delta (empty changes)
        if (!delta.changes || Object.keys(delta.changes).length === 0) {
            if (settings.debugMode) {
                console.log(`${LOG_PREFIX} Extraction delta has no changes — skipping`);
            }
            return;
        }

        if (settings.debugMode) {
            console.log(`${LOG_PREFIX} Extraction delta valid:`, delta.summary || '(no summary)');
            console.debug(`${LOG_PREFIX} Change keys:`, Object.keys(delta.changes));
        }

        // ── Manual vs auto-apply branching ────────────────────────────────────
        const currentState = getState();

        if (settings.autoApplyDelta) {
            // Push a snapshot BEFORE applying for undo support,
            // then apply the delta and save
            pushStateSnapshot(currentState, 'Auto-extract: ' + (delta.summary || 'unnamed change'), settings.maxSnapshots);

            const newState = applyDelta(currentState, delta);
            newState.lastDelta = null; // critical: do not leave applied delta pending
            saveState(newState);

            if (settings.debugMode) {
                console.log(`${LOG_PREFIX} Delta auto-applied and state saved`);
            }
        } else {
            // Manual mode: store delta as lastDelta but don't apply
            currentState.lastDelta = delta;
            saveState(currentState);

            if (settings.debugMode) {
                console.log(`${LOG_PREFIX} Delta stored as lastDelta (manual review mode)`);
            }
        }

        // Trigger UI refresh if available
        if (typeof globalThis._wandlightRefreshUI === 'function') {
            globalThis._wandlightRefreshUI();
        }
    } catch (e) {
        console.error(`${LOG_PREFIX} Extraction failed:`, e);
    } finally {
        _extractionRunning = false;
    }
}

// ── Expose guard and handler on globalThis for external access ──

/**
 * Returns whether extraction is currently running.
 * @returns {boolean}
 */
export function isExtractionRunning() {
    return _extractionRunning;
}

globalThis._wandlightRunExtraction = onExtractionTriggered;
globalThis._wandlightIsExtractionRunning = isExtractionRunning;

/**
 * Resets the throttle counter. Called on chat change.
 */
export function resetExtractionCounter() {
    onExtractionTriggered._counter = 0;
}