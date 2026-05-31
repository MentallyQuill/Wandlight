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
    filterDuplicateLoreEntries,
} from './lore-matrix.js';

import { sendLoreRequest, validateLoreProviderConfiguration } from './lore-llm-client.js';
import { proposeCanonLoreForContext } from './canon-lore-db.js';

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
async function quietPrompt(systemPrompt, userMessage, options = {}) {
    try {
        const settings = getSettings();
        if (options.signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
        return await sendLoreRequest(systemPrompt, userMessage, {
            maxTokens: options.maxTokens || settings.loreMaxTokens || 2048,
            prefill: '',
            signal: options.signal,
            providerKind: options.providerKind || 'lore',
        });
    } catch (e) {
        if (e?.name === 'AbortError' || /aborted|cancelled|canceled/i.test(e?.message || '')) {
            throw e;
        }
        console.error(`${LOG_PREFIX} Lore generation prompt failed:`, e);
        return '';
    }
}

function isAbortError(e) {
    return e?.name === 'AbortError' || /aborted|cancelled|canceled/i.test(String(e?.message || e || ''));
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw new DOMException('Lore generation cancelled', 'AbortError');
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

function findBalancedJsonArray(text) {
    const s = String(text || '');
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < s.length; i++) {
        const ch = s[i];

        if (start === -1) {
            if (ch === '[') {
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
        if (ch === '[') depth++;
        if (ch === ']') depth--;
        if (depth === 0) return s.slice(start, i + 1);
    }

    return start >= 0 ? s.slice(start) : '';
}

/**
 * Coerces various shapes the model may return into the expected { summary, entries } structure.
 * @param {*} parsed - Already-parsed (but possibly wrong-shaped) JSON
 * @returns {Object|null} Normalized shape or null
 */
function coerceLoreShape(parsed) {
    if (Array.isArray(parsed)) {
        return { summary: '', entries: parsed };
    }
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
    if (noReasoning && !noReasoning.trim().startsWith('{') && !noReasoning.trim().startsWith('[')) {
        candidates.push('{' + noReasoning);
        candidates.push('[' + noReasoning);
    }
    candidates.push(findBalancedJsonObject(noReasoning));
    candidates.push(findBalancedJsonObject(stripJsonFences(noReasoning)));
    candidates.push(findBalancedJsonArray(noReasoning));
    candidates.push(findBalancedJsonArray(stripJsonFences(noReasoning)));

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
function getRecentMessageObjects(count = 8) {
    try {
        const ctx = SillyTavern.getContext();
        const chat = ctx?.chat || [];
        return chat.slice(-Math.max(1, Number(count) || 8));
    } catch (_) {
        return [];
    }
}

function formatMessageObjects(messages = []) {
    return messages
        .map((m, index) => {
            const name = m?.name || 'Unknown';
            const role = m?.is_user ? 'User' : m?.is_system ? 'System' : name;
            const text = String(m?.mes || m?.content || '').trim();
            return text ? `[${index + 1}] ${role}: ${text}` : '';
        })
        .filter(Boolean)
        .join('\n\n');
}

function getRecentMessages(count = 8) {
    const formatted = formatMessageObjects(getRecentMessageObjects(count));
    return formatted || '(No messages available)';
}

function chunkMessages(messages = [], chunkSize = 10) {
    const size = Math.max(1, Math.min(50, Number(chunkSize) || 10));
    const chunks = [];
    for (let i = 0; i < messages.length; i += size) {
        chunks.push(messages.slice(i, i + size));
    }
    return chunks.length ? chunks : [[]];
}


function parseSceneDateParts(value) {
    const text = String(value || '');
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

    let match = text.match(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\.?\s*,?\s*(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t)?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})\b/i);
    if (match) {
        return { month: monthMap[match[1].toLowerCase().replace('.', '')], day: Number(match[2]), year: Number(match[3]) };
    }

    match = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
    if (match) {
        const year = Number(match[3].length === 2 ? `19${match[3]}` : match[3]);
        return { month: Number(match[1]) - 1, day: Number(match[2]), year };
    }

    return null;
}

function inferHarryPotterCanonBoundary(sceneDate) {
    const parts = parseSceneDateParts(sceneDate);
    if (!parts || !Number.isFinite(parts.year) || !Number.isFinite(parts.month)) return '';

    const schoolYear = parts.month >= 8 ? parts.year : parts.year - 1;
    const map = {
        1991: "Philosopher's/Sorcerer's Stone era, Year 1",
        1992: 'Chamber of Secrets era, Year 2',
        1993: 'Prisoner of Azkaban era, Year 3',
        1994: 'Goblet of Fire era, Year 4',
        1995: 'Order of the Phoenix era, Year 5',
        1996: 'Half-Blood Prince era, Year 6',
        1997: 'Deathly Hallows era, Year 7',
    };
    return map[schoolYear] || '';
}

function correctHarryPotterCanonContext(context) {
    const normalized = normalizeLoreContext(context || {});
    const inferred = inferHarryPotterCanonBoundary(normalized.sceneDate || normalized.subjectiveDate || '');
    if (!inferred) return normalized;

    const current = String(normalized.canonBoundary || '');
    const hasKnownWrongHpYear = /\b(OotP|Order of the Phoenix|Half[- ]?Blood Prince|HBP|Deathly Hallows|Goblet of Fire|Prisoner of Azkaban|Chamber of Secrets|Year\s+[1-7])\b/i.test(current)
        && current.toLowerCase() !== inferred.toLowerCase();

    if (!current || hasKnownWrongHpYear) {
        normalized.canonBoundary = inferred;
        normalized.summary = normalized.summary
            ? `${normalized.summary} Canon boundary normalized from scene date.`
            : `Canon boundary inferred from scene date: ${inferred}.`;
    }

    return normalized;
}

function inferContextLocallyFromMessages(messages, state = getState()) {
    const text = String(messages || '');
    const result = {
        sceneDate: state?.loreContext?.sceneDate || state?.canon?.inUniverseDate || '',
        subjectiveDate: state?.loreContext?.subjectiveDate || '',
        canonBoundary: state?.loreContext?.canonBoundary || state?.canon?.canonBoundary || '',
        branchId: state?.loreContext?.branchId || 'main',
        timeTravelMode: state?.loreContext?.timeTravelMode || 'none',
        summary: 'Fallback context inferred locally from message headings and current state.',
    };

    const datePatterns = [
        /(?:^|\n)\s*(?:date|day|in[- ]?universe date|scene date)\s*[:\-]\s*([^\n]+)/i,
        /(?:^|\n)\s*#{1,6}\s*([^\n]*(?:\b\d{4}\b|\bJan\.?\b|\bFeb\.?\b|\bMar\.?\b|\bApr\.?\b|\bJun\.?\b|\bJul\.?\b|\bAug\.?\b|\bSep\.?\b|\bSept\.?\b|\bOct\.?\b|\bNov\.?\b|\bDec\.?\b|\bJanuary\b|\bFebruary\b|\bMarch\b|\bApril\b|\bMay\b|\bJune\b|\bJuly\b|\bAugust\b|\bSeptember\b|\bOctober\b|\bNovember\b|\bDecember\b)[^\n]*)/i,
        /\b((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\.?\s*,?\s*(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t)?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?\s*,?\s+\d{4})\b/i,
        /\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/,
    ];
    for (const pattern of datePatterns) {
        const match = text.match(pattern);
        if (match?.[1]) {
            result.sceneDate = match[1].replace(/^#+\s*/, '').trim();
            break;
        }
    }

    const canonMatch = text.match(/(?:canon|boundary|canon reference|reference point)\s*[:\-]\s*([^\n]+)/i);
    if (canonMatch?.[1]) {
        result.canonBoundary = canonMatch[1].trim();
    }

    const branchMatch = text.match(/(?:branch|timeline|au)\s*[:\-]\s*([^\n]+)/i);
    if (branchMatch?.[1]) {
        result.branchId = branchMatch[1].trim() || 'main';
    }

    const tt = text.match(/\b(time travel|from the future|alternate timeline|changed past|branch)\b/i);
    if (tt) {
        result.timeTravelMode = /future/i.test(tt[0]) ? 'visitor_from_future' : 'alternate_branch';
    }

    const corrected = correctHarryPotterCanonContext(result);
    return corrected.sceneDate || corrected.canonBoundary || corrected.branchId !== 'main' ? corrected : null;
}


async function maybeProposeCanonLoreFromContext(context, progress = null) {
    const settings = getSettings();
    if (settings.canonLoreDatabaseEnabled === false || settings.canonLoreAutoPropose === false) {
        return null;
    }

    try {
        progress?.('Checking local canon lore database...', 88);
        return await proposeCanonLoreForContext(context, {
            progress,
            maxEntries: settings.canonLoreMaxEntries || 12,
            snapshot: false,
        });
    } catch (e) {
        console.warn(`${LOG_PREFIX} Local canon lore database query failed:`, e);
        progress?.(`Canon lore database query failed: ${e.message || e}`, 100);
        return { status: 'failed', error: e.message || String(e) };
    }
}

function formatCanonProposalSuffix(result) {
    if (!result) return '';
    if (result.status === 'proposed') return ` Local canon database proposed ${result.proposedCount || 0} pending lore entries.`;
    if (result.status === 'duplicates_only') return ' Local canon database found matches, but they were already present or similar.';
    if (result.status === 'no_date') return ' Local canon database skipped: no parseable canon date.';
    if (result.status === 'empty') return ' Local canon database found no entries for this date/context.';
    if (result.status === 'disabled') return '';
    if (result.status === 'failed') return ` Local canon database failed: ${result.error || 'unknown error'}.`;
    return '';
}

// ── Lore Context Detection ──────────────────────────────────────────────────────

/**
 * Runs lore context detection via LLM.
 * Guarded by _detectionRunning to prevent concurrent calls.
 * The result is written to state via setLoreContext().
 * @returns {Promise<Object|null>} Detected context or null on failure
 */
export async function runLoreContextDetection(options = {}) {
    if (_detectionRunning) {
        console.debug(`${LOG_PREFIX} Lore context detection already running, skipping`);
        return null;
    }

    _detectionRunning = true;
    try {
        const signal = options.signal || null;
        throwIfAborted(signal);
        const state = getState();
        const settings = getSettings();
        const progress = typeof options.progress === 'function' ? options.progress : null;
        const validation = validateLoreProviderConfiguration();
        if (!validation.ok) {
            progress?.(`API/model settings incomplete: ${validation.message}`, 100);
            return null;
        }
        progress?.('Reading recent messages...', 10);

        if (!settings.debugMode) {
            // In non-debug, only run if not already detected recently
        }

        const stateSummary = JSON.stringify({
            canon: state.canon,
            scene: state.scene,
            loreContext: state.loreContext,
        }, null, 0);

        const messages = getRecentMessages(settings.contextSourceMessageCount || settings.loreSourceMessageCount || 20);
        progress?.('Sending context detection request...', 35);
        const userMessage = `Current state: ${stateSummary}\n\nRecent messages:\n${messages}\n\nDetect the current lore context. Output ONLY a valid JSON object with no markdown fences, no commentary, no explanations:`;

        const response = await quietPrompt(LORE_CONTEXT_DETECTION_SYSTEM_PROMPT, userMessage, { signal });
        if (!response) {
            const fallback = inferContextLocallyFromMessages(messages, state);
            if (fallback) {
                const savedFallback = { ...fallback, lastDetectedAt: Date.now() };
                setLoreContext(savedFallback);
                const canonResult = await maybeProposeCanonLoreFromContext(savedFallback, progress);
                progress?.(`Context inferred locally from message headings.${formatCanonProposalSuffix(canonResult)}`, 100);
                return savedFallback;
            }
            progress?.('Context detection returned no response.', 100);
            return null;
        }

        progress?.('Parsing detected context...', 75);
        const parsed = parseJsonResponse(response);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            console.warn(`${LOG_PREFIX} Could not parse lore context detection response`);
            const fallback = inferContextLocallyFromMessages(messages, state);
            if (fallback) {
                const savedFallback = { ...fallback, lastDetectedAt: Date.now() };
                setLoreContext(savedFallback);
                const canonResult = await maybeProposeCanonLoreFromContext(savedFallback, progress);
                progress?.(`Context inferred locally from message headings.${formatCanonProposalSuffix(canonResult)}`, 100);
                return savedFallback;
            }
            progress?.('Context detection returned no usable result.', 100);
            return null;
        }

        const normalized = correctHarryPotterCanonContext({ ...parsed, lastDetectedAt: Date.now() });
        setLoreContext(normalized);
        const canonResult = await maybeProposeCanonLoreFromContext(normalized, progress);
        progress?.(`Context detection complete.${formatCanonProposalSuffix(canonResult)}`, 100);

        if (settings.debugMode) {
            console.log(`${LOG_PREFIX} Lore context detected:`, normalized);
        }

        return normalized;
    } catch (e) {
        console.error(`${LOG_PREFIX} Lore context detection failed:`, e);
        const progress = typeof options.progress === 'function' ? options.progress : null;
        progress?.(`Context detection failed: ${e.message || e}`, 100);
        return null;
    } finally {
        _detectionRunning = false;
    }
}


function buildLoreGenerationSystemPrompt(settings = getSettings()) {
    const count = Math.max(0, Math.min(10, Number(settings.loreTagCount ?? 4)));
    const tagInstruction = count === 0
        ? 'Do not generate tags. Set tags to an empty array for every entry.'
        : `Generate exactly ${count} tags for each entry unless impossible. Tags must be short searchable labels, not full sentences.`;

    return `${LORE_GENERATION_SYSTEM_PROMPT}\n\nRuntime generation settings:\n- Source window: last ${Math.max(1, Math.min(200, Number(settings.loreSourceMessageCount) || 10))} messages.\n- Tag count: ${count}.\n- ${tagInstruction}`;
}

function normalizeGeneratedEntry(entry, settings = getSettings()) {
    const normalized = { ...entry };
    const tagCount = Math.max(0, Math.min(10, Number(settings.loreTagCount ?? 4)));
    normalized.tags = tagCount === 0
        ? []
        : (Array.isArray(normalized.tags) ? normalized.tags.slice(0, tagCount) : []);
    return normalized;
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
    const { force = false, allowReplacePending = false, signal = null } = options;
    const progress = typeof options.progress === 'function' ? options.progress : null;
    const source = force ? 'manual' : 'auto';

    if (_generationRunning) {
        console.debug(`${LOG_PREFIX} Lore generation already running, skipping`);
        return { status: 'skipped_running' };
    }

    _generationRunning = true;
    try {
        throwIfAborted(signal);
        const state = getState();
        const settings = getSettings();
        const validation = validateLoreProviderConfiguration();
        if (!validation.ok) {
            progress?.(`API/model settings incomplete: ${validation.message}`, 100);
            return { status: 'api_not_configured', error: validation.message };
        }
        progress?.('Preparing lore generation...', 5);
        const contextKey = buildLoreGenerationKey(state);

        // Auto-detect context if none exists (only for manual/forced generation)
        if (!state.loreContext?.lastDetectedAt) {
            if (force) {
                console.debug(`${LOG_PREFIX} Auto-detecting lore context before generation…`);
                const detected = await runLoreContextDetection({ progress, signal });
                if (!detected) {
                    progress?.('No story context could be detected. Set context manually or increase Source Messages.', 100);
                    _generationRunning = false;
                    return { status: 'no_context_detected', contextKey };
                }
                // Re-read state and contextKey (context detection may have updated it)
                const freshState = getState();
                const freshKey = buildLoreGenerationKey(freshState);
                // Restart the generation with fresh state, release guard first
                // so the recursive call doesn't conflict with _generationRunning
                _generationRunning = false;
                return await runLoreGeneration({ force, allowReplacePending, progress });
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

        // ── Call the LLM in message chunks ────────────────────────────
        const stateSummary = JSON.stringify({
            canon: state.canon,
            scene: state.scene,
            loreContext: state.loreContext,
            loreMatrix: (state.loreMatrix || []).slice(0, 6),
        }, null, 0);

        const sourceCount = Math.max(1, Math.min(200, Number(settings.loreSourceMessageCount) || 10));
        const chunkSize = Math.max(1, Math.min(50, Number(settings.loreGenerationChunkSize) || 10));
        const messageObjects = getRecentMessageObjects(sourceCount);
        const chunks = chunkMessages(messageObjects, chunkSize);
        const systemPrompt = buildLoreGenerationSystemPrompt(settings);
        const allRawEntries = [];
        let rawEntryCount = 0;
        let failedChunkCount = 0;
        let emptyChunkCount = 0;
        const chunkSummaries = [];
        const totalSteps = Math.max(1, chunks.length * 2 + 3); // generate + parse per chunk, then normalize/filter/save
        let completedSteps = 0;
        const stepProgress = (message) => {
            const percent = Math.min(94, 6 + Math.round((completedSteps / totalSteps) * 88));
            progress?.(`${message} (${completedSteps}/${totalSteps} steps)`, percent);
        };

        for (let i = 0; i < chunks.length; i++) {
            throwIfAborted(signal);
            const chunkText = formatMessageObjects(chunks[i]);
            stepProgress(`Generating lore chunk ${i + 1}/${chunks.length} (${chunks[i].length} messages)...`);

            const userMessage = `Current state: ${stateSummary}

Recent message chunk ${i + 1} of ${chunks.length}:
${chunkText || '(No message text)'}

Generate relevant lore entries from this chunk only. Do not repeat accepted lore. Output ONLY a valid JSON object with no markdown fences, no commentary, no explanations:`;
            const response = await quietPrompt(systemPrompt, userMessage, { signal });
            completedSteps++;
            throwIfAborted(signal);

            if (!response) {
                failedChunkCount++;
                completedSteps++;
                continue;
            }

            stepProgress(`Parsing lore chunk ${i + 1}/${chunks.length}...`);
            let parsed = parseJsonResponse(response);

            if (!parsed || !Array.isArray(parsed?.entries)) {
                if (settings.loreRepairOnParseFail) {
                    if (settings.debugMode) {
                        console.debug(`${LOG_PREFIX} Initial lore parse failed for chunk ${i + 1}, attempting repair pass`);
                    }
                    progress?.(`Repairing malformed JSON for chunk ${i + 1}/${chunks.length}... (${completedSteps}/${totalSteps} steps)`, Math.min(94, 6 + Math.round((completedSteps / totalSteps) * 88)));
                    parsed = await repairLoreJsonResponse(response);
                }
            }
            completedSteps++;
            throwIfAborted(signal);

            if (!parsed || !Array.isArray(parsed.entries)) {
                failedChunkCount++;
                continue;
            }

            rawEntryCount += parsed.entries.length;
            if (parsed.summary) chunkSummaries.push(String(parsed.summary));
            if (!parsed.entries.length) emptyChunkCount++;
            allRawEntries.push(...parsed.entries.map(entry => ({
                ...entry,
                source: entry?.source || `Generated from message chunk ${i + 1}/${chunks.length}`,
            })));
        }

        if (rawEntryCount === 0 && failedChunkCount >= chunks.length) {
            recordLoreAttempt(contextKey, {
                status: 'failed_no_response',
                lastError: `All ${chunks.length} lore generation chunks returned empty or unparseable responses`,
            }, { increment: false });
            progress?.('Lore generation returned no usable responses from any chunk.', 100);
            return { status: 'failed_no_response', contextKey, failedChunkCount, chunkCount: chunks.length };
        }

        completedSteps++;
        progress?.(`Normalizing and filtering generated lore entries... (${completedSteps}/${totalSteps} steps)`, Math.min(96, 6 + Math.round((completedSteps / totalSteps) * 88)));
        let entries = normalizeLoreMatrix(allRawEntries).map(entry => normalizeGeneratedEntry(entry, settings));
        let duplicateDrops = [];
        if (settings.loreDuplicateGuard !== false) {
            const filtered = filterDuplicateLoreEntries(entries, state.loreMatrix || []);
            entries = filtered.entries;
            duplicateDrops = filtered.dropped;
        }

        if (entries.length === 0) {
            recordLoreAttempt(contextKey, {
                status: 'empty',
                rawEntryCount,
                validEntryCount: 0,
                lastError: duplicateDrops.length ? `All valid lore entries were duplicate/similar to existing entries (${duplicateDrops.length} dropped)` : 'No valid lore entries after normalization',
            }, { increment: false });
            if (settings.debugMode) {
                console.debug(`${LOG_PREFIX} Lore generation returned no valid entries after normalization`);
            }
            progress?.('Lore generation produced no usable non-duplicate entries.', 100);
            return {
                status: 'empty_valid_entries',
                contextKey,
                rawEntryCount,
                validEntryCount: 0,
                droppedDuplicateCount: duplicateDrops.length,
                duplicateDropReasons: duplicateDrops.map(d => d.reason),
                failedChunkCount,
                emptyChunkCount,
                chunkCount: chunks.length,
            };
        }

        // ── Create proposal (only path that marks context as proposed) ─
        const summary = chunkSummaries.filter(Boolean).join(' | ');
        completedSteps++;
        progress?.(`Saving pending lore proposal... (${completedSteps}/${totalSteps} steps)`, 96);
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

        progress?.('Pending lore ready for review.', 100);

        return {
            status: 'proposed',
            contextKey,
            entries,
            rawEntryCount,
            validEntryCount: entries.length,
            droppedEntryCount: rawEntryCount - entries.length,
            droppedDuplicateCount: duplicateDrops.length,
            duplicateDropReasons: duplicateDrops.map(d => d.reason),
            failedChunkCount,
            emptyChunkCount,
            chunkCount: chunks.length,
        };
    } catch (e) {
        const currentKey = buildLoreGenerationKey(getState());
        if (isAbortError(e)) {
            recordLoreAttempt(currentKey, {
                status: 'cancelled',
                lastError: 'Cancelled by user',
            }, { increment: false });
            progress?.('Lore generation cancelled by user.', 0);
            return { status: 'cancelled', contextKey: currentKey, error: 'Cancelled by user' };
        }
        console.error(`${LOG_PREFIX} Lore generation failed:`, e);
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