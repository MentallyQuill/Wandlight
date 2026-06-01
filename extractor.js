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
import { runLoreContextDetection, runStoryLoreScan } from './lore-generator.js';
import { sendLoreRequest, validateLoreProviderConfiguration } from './lore-llm-client.js';

/** Guard flag to prevent concurrent extraction passes. */
let _extractionRunning = false;

/**
 * Collects recent narrative text from the chat array for the extraction prompt.
 * Collects from the last user turn forward (user message + all assistant replies
 * since then, up through current generation end).
 * @param {Array} chat - The chat array from SillyTavern.getContext()
 * @returns {string} Formatted recent messages string
 */
function collectRecentMessages(chat, count = 10) {
    if (!chat || chat.length === 0) return '';

    const limit = Math.max(1, Math.min(200, Number(count) || 10));
    const startIdx = Math.max(0, chat.length - limit);

    const messages = [];
    for (let i = startIdx; i < chat.length; i++) {
        const msg = chat[i];
        if (!msg) continue;
        const role = msg.is_user ? 'User' : (msg.is_system ? 'System' : 'Assistant');
        let content = msg.mes || msg.content || '';
        if (!String(content).trim()) continue;

        // Strip thinking/reasoning tags so the extraction prompt is clean
        content = String(content).replace(/<think\b[^>]*>([\s\S]*?)<\/think>/gi, '');
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
function isPlainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

function isArrayDeltaShape(value) {
    return isPlainObject(value) && (
        Array.isArray(value.added) ||
        Array.isArray(value.updated) ||
        Array.isArray(value.removed) ||
        Array.isArray(value.resolved)
    );
}

function coerceArrayOrPatch(value) {
    if (Array.isArray(value)) return { added: value };
    if (isArrayDeltaShape(value)) return value;
    return value;
}

function coerceContinuityFlags(value) {
    if (Array.isArray(value)) return { added: value };
    if (isPlainObject(value)) return value;
    return value;
}

function coerceFullStateOrLooseDelta(parsed) {
    if (!isPlainObject(parsed)) return parsed;

    const knownKeys = ['canon', 'scene', 'characters', 'inventory', 'objectives', 'knowledge', 'secrets', 'relationships', 'threads', 'continuityFlags'];
    let delta = parsed;

    // Models often return a full state object on first scan instead of a WandlightDelta.
    // Treat known top-level continuity sections as changes, then normalize section shapes.
    if (!isPlainObject(delta.changes)) {
        const candidate = isPlainObject(parsed.state) ? parsed.state
            : isPlainObject(parsed.continuityState) ? parsed.continuityState
            : isPlainObject(parsed.continuity) ? parsed.continuity
            : parsed;
        const hasKnownTopLevel = knownKeys.some(k => k in candidate);
        if (hasKnownTopLevel) {
            const changes = {};
            for (const key of knownKeys) {
                if (candidate[key] !== undefined) changes[key] = candidate[key];
            }
            delta = { summary: parsed.summary || 'Initial continuity state extracted', changes };
        } else if (Object.keys(parsed).length === 0) {
            delta = { summary: 'No changes detected', changes: {} };
        }
    }

    if (!isPlainObject(delta.changes)) return delta;

    const changes = { ...delta.changes };

    if (changes.characters !== undefined) changes.characters = coerceArrayOrPatch(changes.characters);
    if (changes.inventory !== undefined) changes.inventory = coerceArrayOrPatch(changes.inventory);
    if (changes.objectives !== undefined) changes.objectives = coerceArrayOrPatch(changes.objectives);
    if (changes.secrets !== undefined) changes.secrets = coerceArrayOrPatch(changes.secrets);
    if (changes.relationships !== undefined) changes.relationships = coerceArrayOrPatch(changes.relationships);
    if (changes.threads !== undefined) changes.threads = coerceArrayOrPatch(changes.threads);
    if (changes.continuityFlags !== undefined) changes.continuityFlags = coerceContinuityFlags(changes.continuityFlags);

    // Some models return singular fields for secrets/relationships/threads under the object.
    for (const key of ['secrets', 'relationships', 'threads']) {
        const value = changes[key];
        if (isPlainObject(value) && !isArrayDeltaShape(value)) {
            changes[key] = { added: [value] };
        }
    }

    delta = { ...delta, changes };
    return delta;
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

    parsed = coerceFullStateOrLooseDelta(parsed);

    // Validate against the formal delta schema after coercion.
    if (!parsed?.changes) {
        console.warn(`${LOG_PREFIX} Parsed continuity response has no usable changes/state object`);
        return null;
    }

    const { valid, errors } = validateDelta(parsed);
    if (!valid) {
        console.warn(`${LOG_PREFIX} Delta validation failed after coercion:`, errors.join('; '));
        console.debug(`${LOG_PREFIX} Coerced delta candidate:`, parsed);
        return null;
    }

    return parsed;
}

function inferHpBoundaryFromText(text) {
    const value = String(text || '');
    const monthMap = {
        jan: 0, january: 0,
        feb: 1, february: 1,
        mar: 2, march: 2,
        apr: 3, april: 3,
        may: 4,
        jun: 5, june: 5,
        jul: 6, july: 6,
        aug: 7, august: 7,
        sep: 8, sept: 8, september: 8,
        oct: 9, october: 9,
        nov: 10, november: 10,
        dec: 11, december: 11,
    };
    const match = value.match(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\.?\s*,?\s*(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t)?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})\b/i);
    if (!match) return { date: '', boundary: '' };
    const month = monthMap[match[1].toLowerCase().replace('.', '')];
    const year = Number(match[3]);
    const schoolYear = month >= 8 ? year : year - 1;
    const map = {
        1991: "Philosopher's/Sorcerer's Stone era, Year 1",
        1992: 'Chamber of Secrets era, Year 2',
        1993: 'Prisoner of Azkaban era, Year 3',
        1994: 'Goblet of Fire era, Year 4',
        1995: 'Order of the Phoenix era, Year 5',
        1996: 'Half-Blood Prince era, Year 6',
        1997: 'Deathly Hallows era, Year 7',
    };
    return { date: match[0].trim(), boundary: map[schoolYear] || '' };
}

function inferFallbackContinuityDelta(messages, state = {}) {
    const inferred = inferHpBoundaryFromText(messages);
    if (!inferred.date && !inferred.boundary) return null;

    const changes = { canon: {} };
    if (inferred.date && state?.canon?.inUniverseDate !== inferred.date) {
        changes.canon.inUniverseDate = inferred.date;
    }
    if (inferred.boundary && state?.canon?.canonBoundary !== inferred.boundary) {
        changes.canon.canonBoundary = inferred.boundary;
        changes.canon.era = inferred.boundary.replace(/,\s*Year\s*\d+$/i, '');
    }

    if (!Object.keys(changes.canon).length) return null;
    return {
        summary: 'Fallback continuity date/context inferred locally from message heading.',
        changes,
    };
}


function getEnabledContinuitySectionPrompts(settings, state) {
    const prompts = settings?.continuitySectionPrompts || {};
    const config = state?.continuityConfig || {};
    const entries = [
        ['canonScene', 'Canon and Scene', () => config.canon !== false || config.scene !== false],
        ['canonDivergences', 'Canon Divergences', () => config.canon !== false],
        ['characters', 'Characters', () => config.characters !== false || config.appearance !== false || config.emotionalState !== false],
        ['storyMilestones', 'Story Milestones', () => config.storyMilestones !== false],
        ['knowledge', 'Knowledge', () => config.knowledge !== false],
        ['secrets', 'Secrets', () => config.secrets !== false],
        ['relationships', 'Relationships', () => config.relationships !== false],
        ['threads', 'Story Threads', () => config.threads !== false],
        ['inventory', 'Inventory / Objects', () => config.inventory !== false],
        ['objectives', 'Objectives', () => config.objectives !== false],
        ['flags', 'Continuity Flags', () => config.flags !== false],
    ];

    const lines = [];
    for (const [key, label, enabled] of entries) {
        const text = String(prompts[key] || '').trim();
        if (!text || !enabled()) continue;
        lines.push(`- ${label}: ${text}`);
    }

    if (!lines.length) return '';
    return `\n\n<section_specific_scan_prompts>\nApply these user-editable section instructions in addition to the global extraction rules. Only update sections that are enabled/tracked for this chat.\n${lines.join('\n')}\n</section_specific_scan_prompts>`;
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
    const settings = getSettings();
    const validation = validateLoreProviderConfiguration('continuity');
    if (!validation.ok) {
        throw new Error(validation.message);
    }

    const currentStateForPrompts = getState();
    const sectionPrompts = getEnabledContinuitySectionPrompts(settings, currentStateForPrompts);
    const systemPrompt = EXTRACTION_SYSTEM_PROMPT
        .replace('{{stateJson}}', stateJson)
        .replace('{{messages}}', messages)
        + sectionPrompts;

    const userPrompt = EXTRACTION_USER_PROMPT;

    let response = null;
    try {
        if (settings.debugMode) {
            console.log(`${LOG_PREFIX} Calling ${validation.provider} for continuity extraction...`);
        }
        response = await sendLoreRequest(systemPrompt, userPrompt, {
            providerKind: 'continuity',
            maxTokens: settings.continuityMaxTokens || 1024,
            prefill: '',
        });
    } catch (e) {
        console.error(`${LOG_PREFIX} Continuity extraction provider call failed:`, e);
        throw e;
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
    const { force = false, applyImmediately = false } = options;

    if (_extractionRunning) {
        const settings = getSettings();
        if (settings.debugMode) {
            console.log(`${LOG_PREFIX} Extraction already running, skipping`);
        }
        return { status: 'skipped_running' };
    }

    const settings = getSettings();
    if (!settings.enabled) return { status: 'disabled' };

    if (!force) {
        const mode = settings.continuityTrackingMode || (settings.autoExtract ? 'automatic' : 'manual');
        if (mode !== 'automatic') return { status: 'skipped_continuity_manual' };

        if (typeof onExtractionTriggered._counter === 'undefined') {
            onExtractionTriggered._counter = 0;
        }
        onExtractionTriggered._counter++;
        const interval = Math.max(1, Math.min(20, Number(settings.continuityAutoInterval || settings.extractionInterval) || 1));
        if (onExtractionTriggered._counter < interval) return { status: 'skipped_interval' };
        onExtractionTriggered._counter = 0;
    }

    const validation = validateLoreProviderConfiguration('continuity');
    if (!validation.ok) {
        return { status: 'api_not_configured', error: validation.message };
    }

    _extractionRunning = true;

    try {
        const ctx = SillyTavern.getContext();
        const chat = ctx && ctx.chat ? ctx.chat : null;
        if (!chat || !Array.isArray(chat) || chat.length === 0) {
            if (settings.debugMode) {
                console.log(`${LOG_PREFIX} No chat messages — cannot run extraction`);
            }
            return { status: 'no_chat' };
        }

        // Collect recent messages
        const messages = collectRecentMessages(chat, settings.continuitySourceMessageCount || 10);
        if (!messages) {
            if (settings.debugMode) {
                console.log(`${LOG_PREFIX} No recent messages to extract from`);
            }
            return { status: 'no_messages' };
        }

        // Get current state (reacquired from ST context)
        const state = getState();

        let stateJson;
        try {
            stateJson = JSON.stringify(state);
        } catch (e) {
            console.error(`${LOG_PREFIX} Failed to serialize state:`, e);
            return { status: 'state_serialize_failed', error: e?.message || String(e) };
        }

        if (settings.debugMode) {
            console.log(`${LOG_PREFIX} Running extraction pass...`);
            console.debug(`${LOG_PREFIX} Messages length:`, messages.length, `State JSON:`, stateJson.length);
        }

        // Run the extraction LLM call
        let delta = await runExtractionCall(stateJson, messages);
        if (!delta) {
            delta = inferFallbackContinuityDelta(messages, state);
        }
        let result = { status: 'no_valid_delta' };

        if (delta) {
            // Check for no-op delta (empty changes)
            const hasChanges = delta.changes && Object.keys(delta.changes).length > 0;

            if (hasChanges) {
                if (settings.debugMode) {
                    console.log(`${LOG_PREFIX} Extraction delta valid:`, delta.summary || '(no summary)');
                    console.debug(`${LOG_PREFIX} Change keys:`, Object.keys(delta.changes));
                }

                // ── Manual vs auto-apply branching ───────────────────────────────────
                const currentState = getState();

                if (settings.autoApplyDelta || applyImmediately) {
                    // Push a snapshot BEFORE applying for undo support,
                    // then apply the delta and save.
                    pushStateSnapshot(
                        currentState,
                        (applyImmediately ? 'Manual continuity scan: ' : 'Auto-extract: ') + (delta.summary || 'unnamed change'),
                        settings.maxSnapshots,
                    );

                    const newState = applyDelta(currentState, delta);
                    newState.lastDelta = null; // critical: do not leave applied delta pending
                    saveState(newState);

                    if (settings.debugMode) {
                        console.log(`${LOG_PREFIX} Delta applied and state saved`);
                    }

                    result = { status: 'applied', delta, summary: delta.summary || '', changeKeys: Object.keys(delta.changes || {}) };
                } else {
                    // Manual mode: store delta as lastDelta but don't apply
                    currentState.lastDelta = delta;
                    saveState(currentState);

                    if (settings.debugMode) {
                        console.log(`${LOG_PREFIX} Delta stored as lastDelta (manual review mode)`);
                    }

                    result = { status: 'pending_review', delta, summary: delta.summary || '', changeKeys: Object.keys(delta.changes || {}) };
                }
            } else {
                if (settings.debugMode) {
                    console.log(`${LOG_PREFIX} Extraction delta has no changes — skipping`);
                }
                result = { status: 'no_changes' };
            }
        } else if (settings.debugMode) {
            console.log(`${LOG_PREFIX} Extraction returned no valid delta`);
        }

        // Trigger UI refresh if available
        if (typeof globalThis._wandlightRefreshUI === 'function') {
            globalThis._wandlightRefreshUI();
        }

        return result;
    } catch (e) {
        console.error(`${LOG_PREFIX} Extraction failed:`, e);
        return { status: 'failed_exception', error: e?.message || String(e) };
    } finally {
        _extractionRunning = false;
    }
}


function shouldRunTurnInterval(counterName, interval) {
    const key = `_${counterName}Counter`;
    if (typeof onGenerationEndedAutomation[key] === 'undefined') {
        onGenerationEndedAutomation[key] = 0;
    }
    onGenerationEndedAutomation[key]++;
    const threshold = Math.max(1, Math.min(20, Number(interval) || 1));
    if (onGenerationEndedAutomation[key] < threshold) return false;
    onGenerationEndedAutomation[key] = 0;
    return true;
}

export async function onGenerationEndedAutomation() {
    const settings = getSettings();
    if (!settings.enabled) return { status: 'disabled' };

    const results = {};

    try {
        results.continuity = await onExtractionTriggered({ force: false });
    } catch (e) {
        results.continuity = { status: 'failed_exception', error: e?.message || String(e) };
    }

    if ((settings.contextDetectionMode || 'manual') === 'automatic'
        && shouldRunTurnInterval('contextDetection', settings.contextDetectionAutoInterval || 5)) {
        try {
            const validation = validateLoreProviderConfiguration('lore');
            if (!validation.ok) {
                results.context = { status: 'api_not_configured', error: validation.message };
            } else {
                results.context = await runLoreContextDetection({ force: false });
            }
        } catch (e) {
            results.context = { status: 'failed_exception', error: e?.message || String(e) };
        }
    }

    if ((settings.loreGenerationMode || 'manual') === 'automatic'
        && shouldRunTurnInterval('loreGeneration', settings.loreGenerationAutoInterval || 10)) {
        try {
            const validation = validateLoreProviderConfiguration('lore');
            if (!validation.ok) {
                results.lore = { status: 'api_not_configured', error: validation.message };
            } else {
                results.lore = await runStoryLoreScan({ force: false, source: 'auto', automationSafe: true });
            }
        } catch (e) {
            results.lore = { status: 'failed_exception', error: e?.message || String(e) };
        }
    }

    if (typeof globalThis._wandlightRefreshUI === 'function') {
        globalThis._wandlightRefreshUI();
    }

    return { status: 'complete', results };
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
globalThis._wandlightRunAutomation = onGenerationEndedAutomation;
globalThis._wandlightIsExtractionRunning = isExtractionRunning;

/**
 * Resets the throttle counter. Called on chat change.
 */
export function resetExtractionCounter() {
    onExtractionTriggered._counter = 0;
}