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

// ── Guard flags ─────────────────────────────────────────────────────────────────

let _detectionRunning = false;
let _generationRunning = false;

// ── Helper: quiet LLM prompt ────────────────────────────────────────────────────

/**
 * Sends a controlled JSON task to the LLM using current SillyTavern object-style APIs.
 * Prefers generateRaw for system/user separation, then falls back to generateQuietPrompt.
 * @param {string} systemPrompt - System message text
 * @param {string} userMessage - User message text
 * @returns {Promise<string>} LLM response text
 */
async function quietPrompt(systemPrompt, userMessage) {
    try {
        const ctx = SillyTavern.getContext();
        if (!ctx) throw new Error('SillyTavern context unavailable');

        if (typeof ctx.generateRaw === 'function') {
            const result = await ctx.generateRaw({
                systemPrompt,
                prompt: userMessage,
                prefill: '',
            });
            return typeof result === 'string' ? result : '';
        }

        if (typeof ctx.generateQuietPrompt === 'function') {
            const result = await ctx.generateQuietPrompt({
                quietPrompt: `${systemPrompt}\n\n${userMessage}`,
            });
            return typeof result === 'string' ? result : '';
        }

        console.warn(`${LOG_PREFIX} No generation API available for lore task`);
        return '';
    } catch (e) {
        console.error(`${LOG_PREFIX} Lore generation prompt failed:`, e);
        return '';
    }
}

/**
 * Parses a JSON response from the LLM. Handles markdown fences.
 * @param {string} text - Raw LLM response
 * @returns {Object|null} Parsed JSON or null
 */
function parseJsonResponse(text) {
    if (!text || typeof text !== 'string') return null;

    // Strip markdown fences
    let cleaned = text.trim();
    if (cleaned.startsWith('```')) {
        const firstNewline = cleaned.indexOf('\n');
        if (firstNewline > 0) {
            cleaned = cleaned.slice(firstNewline + 1);
        }
        if (cleaned.endsWith('```')) {
            cleaned = cleaned.slice(0, -3);
        }
    }
    cleaned = cleaned.trim();

    try {
        return JSON.parse(cleaned);
    } catch (_) {
        // Try to find JSON object boundary
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start >= 0 && end > start) {
            try {
                return JSON.parse(cleaned.slice(start, end + 1));
            } catch (_2) {
                return null;
            }
        }
        return null;
    }
}

// ── Build context message ───────────────────────────────────────────────────────

/**
 * Collects recent chat messages for context detection/generation.
 * @param {number} [count=20] - Max messages to include
 * @returns {string} Formatted messages text
 */
function getRecentMessages(count = 20) {
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

        const messages = getRecentMessages(20);
        const userMessage = `Current state: ${stateSummary}\n\nRecent messages:\n${messages}\n\nDetect the current lore context (JSON only):`;

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

        // Skip if loreContext hasn't been detected yet
        if (!state.loreContext?.lastDetectedAt) {
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

        const messages = getRecentMessages(20);
        const userMessage = `Current state: ${stateSummary}\n\nRecent messages:\n${messages}\n\nGenerate relevant lore entries (JSON only):`;

        const response = await quietPrompt(LORE_GENERATION_SYSTEM_PROMPT, userMessage);
        if (!response) {
            recordLoreAttempt(contextKey, {
                status: 'failed_no_response',
                lastError: 'Quiet prompt returned empty response',
            }, { increment: false });
            return { status: 'failed_no_response', contextKey };
        }

        // ── Parse & validate ──────────────────────────────────────────
        const parsed = parseJsonResponse(response);
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