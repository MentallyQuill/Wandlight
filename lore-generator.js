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
    setPendingLoreEntries,
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
 * Runs lore matrix generation via LLM.
 * Guarded by _generationRunning. Results go to pendingLoreEntries (review required).
 * Only runs if contexts have changed since last generation (buildLoreGenerationKey).
 * @param {Object} [options]
 * @param {boolean} [options.force=false] - If true, bypass unchanged-context skip
 * @returns {Promise<Object[]>} Generated lore entries (or empty on skip/failure)
 */
export async function runLoreGeneration(options = {}) {
    const { force = false } = options;

    if (_generationRunning) {
        console.debug(`${LOG_PREFIX} Lore generation already running, skipping`);
        return [];
    }

    _generationRunning = true;
    try {
        const state = getState();
        const settings = getSettings();

        // Skip if loreContext hasn't been detected yet
        if (!state.loreContext?.lastDetectedAt) {
            if (settings.debugMode) {
                console.debug(`${LOG_PREFIX} Skipping lore generation — no lore context detected yet`);
            }
            return [];
        }

        // Check if context has changed since last generation. Manual generation passes
        // force:true so the user can intentionally refresh pending proposals.
        const currentKey = buildLoreGenerationKey(state);
        if (!force && currentKey === state.loreContext.lastGeneratedFor) {
            if (settings.debugMode) {
                console.debug(`${LOG_PREFIX} Lore context unchanged since last generation, skipping`);
            }
            return [];
        }

        const stateSummary = JSON.stringify({
            canon: state.canon,
            scene: state.scene,
            loreContext: state.loreContext,
            loreMatrix: state.loreMatrix.slice(0, 3), // Brief existing entries
        }, null, 0);

        const messages = getRecentMessages(20);
        const userMessage = `Current state: ${stateSummary}\n\nRecent messages:\n${messages}\n\nGenerate relevant lore entries (JSON only):`;

        const response = await quietPrompt(LORE_GENERATION_SYSTEM_PROMPT, userMessage);
        if (!response) return [];

        const parsed = parseJsonResponse(response);
        if (!parsed || !Array.isArray(parsed.entries)) {
            console.warn(`${LOG_PREFIX} Could not parse lore generation response`);
            return [];
        }

        const entries = normalizeLoreMatrix(parsed.entries);
        const summary = parsed.summary || '';

        // Set as pending (user review required) and persist the generation key atomically.
        setPendingLoreEntries(entries, summary, currentKey);

        if (settings.debugMode) {
            console.log(`${LOG_PREFIX} Lore generated: ${entries.length} entries pending review`, entries);
        }

        return entries;
    } catch (e) {
        console.error(`${LOG_PREFIX} Lore generation failed:`, e);
        return [];
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