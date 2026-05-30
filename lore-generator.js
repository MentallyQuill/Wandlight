/**
 * lore-generator.js — Wandlight Continuity
 * LLM-calling logic for lore context detection and lore matrix generation.
 * No direct UI dependencies — all state operations go through state-manager.
 *
 * Imports: constants.js, state-manager.js, lore-matrix.js
 * Imported by: index.js
 */

import {
    LOG_PREFIX,
    LORE_CONTEXT_DETECTION_SYSTEM_PROMPT,
    LORE_GENERATION_SYSTEM_PROMPT,
    JSON_REPAIR_SYSTEM_PROMPT,
} from './constants.js';

import {
    getState,
    getSettings,
    setLoreContext,
    recordLoreAttempt,
    setPendingLoreProposal,
    markPendingLoreStale,
    markPendingLoreReplaced,
} from './state-manager.js';

import {
    normalizeLoreContext,
    normalizeLoreMatrix,
    buildLoreGenerationKey,
} from './lore-matrix.js';

import { sendLoreRequest } from './lore-llm-client.js';

// ── Guard flags ─────────────────────────────────────────────────────────────────

let _detectionRunning = false;
let _generationRunning = false;

// ── Helper: quiet LLM prompt ────────────────────────────────────────────────────

/**
 * Sends a controlled JSON task to the LLM via the configured lore provider.
 * Uses sendLoreRequest which dispatches to the provider selected in settings
 * (current ST model, connection profile, or OpenAI-compatible endpoint).
 * @param {string} systemPrompt - System message text
 * @param {string} userMessage - User message text
 * @returns {Promise<string>} LLM response text (may be empty on failure)
 */
async function quietPrompt(systemPrompt, userMessage) {
    try {
        const settings = getSettings();
        return await sendLoreRequest(systemPrompt, userMessage, {
            maxTokens: settings.loreMaxTokens || 2048,
            prefill: '{',
        });
    } catch (e) {
        console.error(`${LOG_PREFIX} Lore generation prompt failed:`, e);
        return '';
    }
}

// ── Robust JSON response parsing ─────────────────────────────────────────────────

/**
 * Strips markdown code fences from text.
 * @param {string} text - Raw text
 * @returns {string} Cleaned text
 */
function stripJsonFences(text) {
    let cleaned = String(text || '').trim();

    const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch) return fenceMatch[1].trim();

    return cleaned;
}

/**
 * Removes think/reasoning blocks that thinking models sometimes emit.
 * @param {string} text - Raw text
 * @returns {string} Cleaned text
 */
function removeLikelyReasoningBlocks(text) {
    return String(text || '')
        .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
        .replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi, '')
        .replace(/<reasoning\b[^>]*>[\s\S]*?<\/reasoning>/gi, '')
        .trim();
}

/**
 * Applies common JSON-ish sanitization (smart quotes, trailing commas, comments, control chars).
 * @param {string} text - Raw text
 * @returns {string} Sanitized text
 */
function sanitizeJsonish(text) {
    return String(text || '')
        .replace(/^\uFEFF/, '')
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/[\u0000-\u001F]+/g, match =>
            match === '\n' || match === '\r' || match === '\t' ? match : ''
        )
        .trim();
}

/**
 * Finds the first balanced JSON object {...} in a string by tracking depth.
 * Handles nested braces, strings, and escape sequences.
 * @param {string} text - Raw text
 * @returns {string} The balanced object substring, or empty string
 */
function findBalancedJsonObject(text) {
    const s = String(text || '');
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < s.length; i++) {
        const ch = s[i];

        if (start === -1) {
            if (ch === '{') {
                start = i;
                depth = 1;
            }
            continue;
        }

        if (escaped) {
            escaped = false;
            continue;
        }

        if (ch === '\\') {
            escaped = true;
            continue;
        }

        if (ch === '"') {
            inString = !inString;
            continue;
        }

        if (inString) continue;

        if (ch === '{') depth++;
        if (ch === '}') depth--;

        if (depth === 0) {
            return s.slice(start, i + 1);
        }
    }

    return start >= 0 ? s.slice(start) : '';
}

/**
 * Coerces various shapes the model may return into the expected { summary, entries } structure.
 * @param {*} parsed - Already-parsed (but possibly wrong-shaped) JSON
 * @returns {Object|null} Normalized shape or null
 */
function coerceLoreShape(parsed) {
    if (!parsed || typeof parsed !== 'object') return null;

    // Already correct.
    if (Array.isArray(parsed.entries)) {
        return {
            summary: typeof parsed.summary === 'string' ? parsed.summary : '',
            entries: parsed.entries,
        };
    }

    // Some models return the array directly under lore/loreMatrix.
    if (Array.isArray(parsed.loreMatrix)) {
        return {
            summary: typeof parsed.summary === 'string' ? parsed.summary : '',
            entries: parsed.loreMatrix,
        };
    }

    if (Array.isArray(parsed.lore)) {
        return {
            summary: typeof parsed.summary === 'string' ? parsed.summary : '',
            entries: parsed.lore,
        };
    }

    // Some models return a single entry.
    if (parsed.id && (parsed.title || parsed.fact)) {
        return {
            summary: '',
            entries: [parsed],
        };
    }

    return null;
}

/**
 * Parses a JSON response from the LLM. Tolerant of markdown fences,
 * reasoning blocks, smart quotes, trailing commas, JS comments, and
 * wrong-shaped objects. Tries multiple candidate extraction strategies
 * before giving up.
 * @param {string} text - Raw LLM response
 * @returns {Object|null} Parsed JSON or null
 */
function parseJsonResponse(text) {
    if (!text || typeof text !== 'string') return null;

    const candidates = [];

    const noReasoning = removeLikelyReasoningBlocks(text);
    candidates.push(noReasoning);
    candidates.push(stripJsonFences(noReasoning));
    candidates.push(findBalancedJsonObject(noReasoning));
    candidates.push(findBalancedJsonObject(stripJsonFences(noReasoning)));

    for (const candidate of candidates) {
        if (!candidate || !candidate.trim()) continue;

        const cleaned = sanitizeJsonish(candidate);

        try {
            const parsed = JSON.parse(cleaned);
            return coerceLoreShape(parsed) || parsed;
        } catch (_) {
            // Continue trying candidates.
        }
    }

    return null;
}

/**
 * When initial parsing fails, sends the raw response to a repair LLM pass.
 * Only attempted when settings.loreRepairOnParseFail is true.
 * @param {string} rawResponse - The raw LLM response that failed parsing
 * @returns {Promise<Object|null>} Repaired and re-parsed JSON, or null
 */
async function repairLoreJsonResponse(rawResponse) {
    const settings = getSettings();
    if (!settings.loreRepairOnParseFail) return null;

    try {
        const repairPrompt = `Repair this malformed lore-generation response into valid JSON.

Required shape:
{
  "summary": "string",
  "entries": []
}

Malformed response:
${String(rawResponse || '').slice(0, 12000)}
`;

        const repaired = await quietPrompt(JSON_REPAIR_SYSTEM_PROMPT, repairPrompt);
        if (!repaired) return null;

        return parseJsonResponse(repaired);
    } catch (e) {
        console.warn(`${LOG_PREFIX} JSON repair pass failed:`, e);
        return null;
    }
}

// ── Build context message ───────────────────────────────────────────────────────

/**
 * Collects recent chat messages for context detection/generation.
 * @param {number} [count=20] - Max messages to include
 * @returns {string} Formatted messages text
 */
function getRecentMessages(count = 8) {
    try {
        const ctx = SillyTavern.getContext();
        const chat = ctx?.chat || [];
        const recent = chat.slice(-count);
        return recent
            .map(m => {
                const name = m?.name || 'Unknown';
                const role = m?.is_user ? 'User' : m?.is_system ? 'System' : name;
                const text = m?.mes || '';
                return `${role}: ${text}`;
            })
            .join('\n\n');
    } catch (_) {
        return '(No messages available)';
    }
}

// ── Lore Context Detection ──────────────────────────────────────────────────────

/**
 * Runs lore context detection via LLM.
 * Guarded by _detectionRunning to prevent concurrent calls.
 * The result is written to state via setLoreContext().
 * @returns {Promise<Object|null>} Detected context or null on failure
 */
export async function runLoreContextDetection() {
    if (_detectionRunning) {
        console.debug(`${LOG_PREFIX} Lore context detection already running, skipping`);
        return null;
    }

    _detectionRunning = true;
    try {
        const state = getState();
        const settings = getSettings();

        if (!settings.debugMode) {
            // In non-debug, only run if not already detected recently
        }

        const stateSummary = JSON.stringify({
            canon: state.canon,
            scene: state.scene,
            loreContext: state.loreContext,
        }, null, 0);

        const messages = getRecentMessages();
        const userMessage = `Current state: ${stateSummary}\n\nRecent messages:\n${messages}\n\nDetect the current lore context. Output ONLY a valid JSON object with no markdown fences, no commentary, no explanations:`;

        const response = await quietPrompt(LORE_CONTEXT_DETECTION_SYSTEM_PROMPT, userMessage);
        if (!response) return null;

        const parsed = parseJsonResponse(response);
        if (!parsed || typeof parsed !== 'object') {
            console.warn(`${LOG_PREFIX} Could not parse lore context detection response`);
            return null;
        }

        const normalized = normalizeLoreContext(parsed);
        setLoreContext(normalized);

        if (settings.debugMode) {
            console.log(`${LOG_PREFIX} Lore context detected:`, normalized);
        }

        return normalized;
    } catch (e) {
        console.error(`${LOG_PREFIX} Lore context detection failed:`, e);
        return null;
    } finally {
        _detectionRunning = false;
    }
}

// ── Lore Generation ─────────────────────────────────────────────────────────────

/**
 * Cooldown window after a failed/empty auto-generation attempt during which
 * the same context will not be retried automatically. Prevents wasting model
 * calls when the model keeps producing malformed or empty lore. Manual
 * (force) generation always bypasses the cooldown.
 */
const FAILED_RETRY_COOLDOWN_MS = 10 * 60 * 1000;

/** Attempt statuses that count as a "recent failure" for cooldown purposes. */
const FAILED_STATUSES = ['failed_parse', 'failed_no_response', 'failed_exception', 'empty'];

/**
 * Runs lore matrix generation via LLM.
 * Guarded by _generationRunning. Results go to pendingLoreEntries (review required).
 * Only runs if contexts have changed since last generation (buildLoreGenerationKey).
 * @param {Object} [options]
 * @param {boolean} [options.force=false] - If true, bypass unchanged-context skip
 * @returns {Promise<Object[]>} Generated lore entries (or empty on skip/failure)
 */
/**
 * Runs lore generation against the LLM and returns a structured result.
 *
 * Auto-generation never silently overwrites unresolved pending lore.
 * Manual generation (force:true) does NOT by itself imply confirmation to
 * replace existing pending lore — the caller must also pass
 * allowReplacePending:true (the UI does so after the user confirms). When
 * force is true but pending lore exists for a different context and
 * allowReplacePending is false, generation is blocked.
 *
 * A context is only marked "proposed" if at least one valid lore entry
 * survives parsing and normalization. Failed/invalid attempts are recorded
 * in the generation ledger but do NOT update lastProposedFor.
 *
 * Skip logic (checked in order):
 *  1. Already running → skipped_running
 *  2. No loreContext detected → no_context_detected
 *  3. Forced, pending exists for different context, not allowed → blocked_pending_exists
 *  4. Auto, pending exists, same context → skipped_same_context_pending
 *  5. Auto, pending exists, different context → skipped_stale_pending_exists
 *     (marks pending as stale)
 *  6. Auto, already accepted → skipped_already_accepted
 *  7. Auto, previously rejected → skipped_previously_rejected
 *  8. Auto, recent failure within cooldown → skipped_recent_failure
 *
 * @param {Object} [options={}]
 * @param {boolean} [options.force=false] - If true, bypass auto-only skip guards (manual generation)
 * @param {boolean} [options.allowReplacePending=false] - If true, a forced run may replace pending lore for a different context
 * @returns {Promise<Object>} Structured result with status, contextKey, and optional entries/error
 */
export async function runLoreGeneration(options = {}) {
    const { force = false, allowReplacePending = false } = options;
    const source = force ? 'manual' : 'auto';

    if (_generationRunning) {
        console.debug(`${LOG_PREFIX} Lore generation already running, skipping`);
        return { status: 'skipped_running' };
    }

    _generationRunning = true;
    try {
        const state = getState();
        const settings = getSettings();
        const contextKey = buildLoreGenerationKey(state);

        // Auto-detect context if none exists (only for manual/forced generation)
        if (!state.loreContext?.lastDetectedAt) {
            if (force) {
                console.debug(`${LOG_PREFIX} Auto-detecting lore context before generation…`);
                const detected = await runLoreContextDetection();
                if (!detected) {
                    _generationRunning = false;
                    return { status: 'no_context_detected', contextKey };
                }
                // Re-read state and contextKey (context detection may have updated it)
                const freshState = getState();
                const freshKey = buildLoreGenerationKey(freshState);
                // Restart the generation with fresh state, release guard first
                // so the recursive call doesn't conflict with _generationRunning
                _generationRunning = false;
                return await runLoreGeneration({ force, allowReplacePending });
            }
            if (settings.debugMode) {
                console.debug(`${LOG_PREFIX} Skipping lore generation — no lore context detected yet`);
            }
            return { status: 'no_context_detected', contextKey };
        }

        const pending = state.pendingLoreEntries || [];
        const pendingMeta = state.pendingLoreMeta || null;
        const pendingIsDifferentContext =
            pending.length > 0 &&
            pendingMeta?.contextKey &&
            pendingMeta.contextKey !== contextKey;

        // ── Pending lore guard ─────────────────────────────────────────
        // Invariant:
        // - Auto generation never overwrites pending lore.
        // - Manual generation only overwrites pending lore if caller explicitly
        //   passed allowReplacePending:true after user confirmation.
        if (pending.length > 0) {
            const pendingKey = pendingMeta?.contextKey || '';

            if (force && !allowReplacePending) {
                return {
                    status: 'blocked_pending_exists',
                    contextKey,
                    pendingContextKey: pendingKey,
                    pendingStatus: pendingMeta?.status || 'pending',
                };
            }

            if (!force) {
                if (pendingKey && pendingKey !== contextKey) {
                    markPendingLoreStale(`Current context changed to ${contextKey}`);
                    return {
                        status: 'skipped_stale_pending_exists',
                        contextKey,
                        pendingContextKey: pendingKey,
                    };
                }

                return {
                    status: 'skipped_same_context_pending',
                    contextKey,
                    pendingContextKey: pendingKey,
                };
            }

            // Manual replacement was explicitly confirmed by caller.
            if (force && allowReplacePending) {
                markPendingLoreReplaced(contextKey);
            }
        }

        // ── Ledger-based skip guards (auto only) ──────────────────────
        const ledger = state.loreGeneration || {};
        const attempt = ledger.attempts?.[contextKey];

        if (!force && attempt?.status === 'accepted') {
            if (settings.debugMode) {
                console.debug(`${LOG_PREFIX} Lore already accepted for this context, skipping`);
            }
            return { status: 'skipped_already_accepted', contextKey };
        }

        if (!force && attempt?.status === 'rejected') {
            if (settings.debugMode) {
                console.debug(`${LOG_PREFIX} Lore previously rejected for this context, skipping`);
            }
            return { status: 'skipped_previously_rejected', contextKey };
        }

        // ── Failed-retry cooldown (auto only) ─────────────────────────
        // Avoid hammering the model after a recent failed/empty attempt for
        // the same context. Manual generation bypasses this entirely.
        if (!force && attempt && FAILED_STATUSES.includes(attempt.status)) {
            const last = attempt.lastAttemptAt || 0;
            if (Date.now() - last < FAILED_RETRY_COOLDOWN_MS) {
                if (settings.debugMode) {
                    console.debug(`${LOG_PREFIX} Recent failed lore generation for this context — within cooldown, skipping`);
                }
                return { status: 'skipped_recent_failure', contextKey };
            }
        }

        // ── If a forced run is replacing pending lore for a different context,
        //    mark the old pending batch's ledger entry as 'replaced' before we
        //    overwrite it, so the ledger stays truthful. ─────────────────────
        if (force && pendingIsDifferentContext && allowReplacePending) {
            markPendingLoreReplaced(contextKey);
        }

        // ── Record the attempt ────────────────────────────────────────
        recordLoreAttempt(contextKey, {
            status: 'running',
            lastSource: source,
            lastError: '',
        });

        // ── Call the LLM ──────────────────────────────────────────────
        const stateSummary = JSON.stringify({
            canon: state.canon,
            scene: state.scene,
            loreContext: state.loreContext,
            loreMatrix: (state.loreMatrix || []).slice(0, 3),
        }, null, 0);

        const messages = getRecentMessages();
        const userMessage = `Current state: ${stateSummary}\n\nRecent messages:\n${messages}\n\nGenerate relevant lore entries. Output ONLY a valid JSON object with no markdown fences, no commentary, no explanations:`;

        const response = await quietPrompt(LORE_GENERATION_SYSTEM_PROMPT, userMessage);
        if (!response) {
            recordLoreAttempt(contextKey, {
                status: 'failed_no_response',
                lastError: 'Quiet prompt returned empty response',
            }, { increment: false });
            return { status: 'failed_no_response', contextKey };
        }

        // ── Parse & validate ──────────────────────────────────────────
        let parsed = parseJsonResponse(response);

        // Repair pass when initial parsing fails
        if (!parsed || !Array.isArray(parsed?.entries)) {
            if (settings.loreRepairOnParseFail) {
                if (settings.debugMode) {
                    console.debug(`${LOG_PREFIX} Initial lore parse failed, attempting repair pass`);
                }
                parsed = await repairLoreJsonResponse(response);
            }
        }

        if (!parsed || !Array.isArray(parsed.entries)) {
            recordLoreAttempt(contextKey, {
                status: 'failed_parse',
                lastError: 'No valid entries array in lore response',
            }, { increment: false });
            if (settings.debugMode) {
                console.debug(`${LOG_PREFIX} Lore generation response had no valid entries array`);
            }
            return { status: 'failed_parse', contextKey };
        }

        const rawEntryCount = parsed.entries.length;
        const entries = normalizeLoreMatrix(parsed.entries);

        if (entries.length === 0) {
            recordLoreAttempt(contextKey, {
                status: 'empty',
                rawEntryCount,
                validEntryCount: 0,
                lastError: 'No valid lore entries after normalization',
            }, { increment: false });
            if (settings.debugMode) {
                console.debug(`${LOG_PREFIX} Lore generation returned no valid entries after normalization`);
            }
            return {
                status: 'empty_valid_entries',
                contextKey,
                rawEntryCount,
                validEntryCount: 0,
            };
        }

        // ── Create proposal (only path that marks context as proposed) ─
        const summary = parsed.summary || '';
        const result = setPendingLoreProposal(entries, {
            contextKey,
            source,
            summary,
            rawEntryCount,
        }, {
            snapshot: source === 'manual',
            snapshotLabel: 'Generate pending lore entries',
        });

        if (settings.debugMode) {
            console.log(`${LOG_PREFIX} Lore generated: ${entries.length} entries pending review`, entries);
        }

        return {
            status: 'proposed',
            contextKey,
            entries,
            rawEntryCount,
            validEntryCount: entries.length,
            droppedEntryCount: rawEntryCount - entries.length,
        };
    } catch (e) {
        console.error(`${LOG_PREFIX} Lore generation failed:`, e);
        const currentKey = buildLoreGenerationKey(getState());
        recordLoreAttempt(currentKey, {
            status: 'failed_exception',
            lastError: e.message,
        }, { increment: false });
        return { status: 'failed_exception', contextKey: currentKey, error: e.message };
    } finally {
        _generationRunning = false;
    }
}

// ── Fluent pipeline: detect + generate ──────────────────────────────────────────

/**
 * Runs the full lore pipeline: detect context, then generate entries.
 * Both steps are guarded. Skips generation if detection fails.
 * @returns {Promise<{ detected: Object|null, generated: Object[] }>}
 */
export async function runLorePipeline() {
    const detected = await runLoreContextDetection();
    const generated = detected ? await runLoreGeneration({ force: false }) : [];
    return { detected, generated };
}

// ── Guard state export (for debugging) ──────────────────────────────────────────

export function isDetectionRunning() {
    return _detectionRunning;
}

export function isGenerationRunning() {
    return _generationRunning;
}