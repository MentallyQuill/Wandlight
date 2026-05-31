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
    appendPendingLoreEntries,
    startLoreBulkBatch,
    updateLoreBulkBatch,
    updateLoreBulkChunk,
    storeLoreBulkCandidates,
    patchPendingLoreMeta,
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
 * Sends a controlled JSON task to the LLM via the configured Reasoning provider.
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
            maxTokens: options.maxTokens || settings.loreMaxTokens || 8192,
            prefill: '',
            signal: options.signal,
            providerKind: options.providerKind || 'lore',
            expectedOutput: options.expectedOutput || 'json',
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


function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
}

function entrySourceText(entry = {}) {
    const source = entry?.source;
    const sourceInfo = entry?.sourceInfo || {};
    if (typeof source === 'string') return source;
    if (source && typeof source === 'object') {
        return [source.id, source.work, source.book, source.chapter, source.notes].filter(Boolean).join(' ');
    }
    return [sourceInfo.id, sourceInfo.work, sourceInfo.book, sourceInfo.chapter, sourceInfo.notes].filter(Boolean).join(' ');
}

function isAcceptedStoryLoreEntry(entry = {}) {
    const e = entry || {};
    const source = entrySourceText(e).toLowerCase();
    const canonStatus = String(e.canonStatus || '').toLowerCase();
    const category = String(e.category || '').toLowerCase();
    if (/model-generated|story-generation|lore-generator|manual|user|au|divergent/.test(source)) return true;
    if (['au', 'divergent', 'fanon', 'contested', 'unknown'].includes(canonStatus)) return true;
    if (['relationship', 'character', 'item', 'knowledge', 'place', 'faction', 'spell', 'artifact', 'behavior', 'skill', 'secret', 'timeline', 'event'].includes(category) && canonStatus !== 'canon') return true;
    return false;
}

function countAcceptedStoryLore(entries = []) {
    return normalizeLoreMatrix(entries).filter(isAcceptedStoryLoreEntry).length;
}

function determineLoreGenerationProfile(settings, state, { force = false, sourceCount = 40, chunkCount = 1 } = {}) {
    const configured = String(settings.loreGenerationBreadthMode || 'auto').toLowerCase();
    const storyLoreCount = countAcceptedStoryLore(state?.loreMatrix || []);
    const bootstrapThreshold = clampInt(settings.loreBootstrapStoryLoreThreshold, 0, 100, 12);
    const autoBootstrap = configured === 'auto' && force && storyLoreCount < bootstrapThreshold;
    const mode = configured === 'bootstrap' || autoBootstrap ? 'bootstrap' : 'incremental';
    const targetTotal = mode === 'bootstrap'
        ? clampInt(settings.loreBootstrapTargetEntries, 12, 120, 40)
        : clampInt(settings.loreIncrementalTargetEntries, 3, 30, 8);
    const safeChunkCount = Math.max(1, Number(chunkCount) || 1);
    const perChunkTarget = mode === 'bootstrap'
        ? clampInt(Math.ceil(targetTotal / safeChunkCount), 6, 20, 10)
        : clampInt(Math.ceil(targetTotal / safeChunkCount), 1, 8, 3);
    const perChunkMin = mode === 'bootstrap'
        ? Math.max(4, Math.min(perChunkTarget, Math.floor(perChunkTarget * 0.7)))
        : Math.max(1, Math.min(perChunkTarget, Math.floor(perChunkTarget * 0.6)));
    const perChunkMax = mode === 'bootstrap'
        ? Math.max(perChunkTarget + 2, Math.min(24, perChunkTarget + 6))
        : Math.max(perChunkTarget + 1, Math.min(10, perChunkTarget + 3));

    return {
        mode,
        configuredMode: configured,
        autoBootstrap,
        storyLoreCount,
        bootstrapThreshold,
        sourceCount,
        chunkCount: safeChunkCount,
        targetTotal,
        perChunkTarget,
        perChunkMin,
        perChunkMax,
        maxTokens: clampInt(settings.loreMaxTokens, 1024, 16384, 8192),
    };
}

function priorityGuidanceText(mode) {
    if (mode === 'bootstrap') {
        return `Priority guidance for bootstrap mode:
- 90-100: active secrets, active safety/reveal constraints, current identity/state facts, major AU divergences, facts that will immediately derail continuity if missed.
- 70-89: current character goals, relationships, possessions, spell/skill capabilities, locations, factions, unresolved active threads.
- 45-69: useful durable background from the current story that may matter later.
- 20-44: low-frequency detail, color, or recap facts. Use sparingly.
Do not assign every entry high priority. A broad bootstrap batch should contain a realistic spread.`;
    }
    return `Priority guidance for incremental mode:
- 80-100: newly changed facts, active secrets, constraints, or immediate-scene facts.
- 55-79: useful durable updates that could matter in the next few turns.
- 20-54: background updates; include only if clearly durable.
Do not assign every entry high priority.`;
}

function categoryCoverageText(mode) {
    if (mode === 'bootstrap') {
        return `Bootstrap coverage categories. Search the supplied messages for all of these, and create entries for every supported durable fact:
- Characters: new/original characters, canon characters in the story, aliases, roles, house/year, current state, injuries, disguises, transformations.
- Relationships: alliances, enemies, trusts, debts, promises, romances, rivalries, family links, mentor/student ties.
- Items and possessions: wands, artifacts, books, potions, tools, keys, money, clothing/disguises, ownership or custody changes.
- Spells and skills: spells used, spells learned, capability limits, nonverbal/wandless ability, magical specializations.
- Secrets and knowledge: who knows what, who must not know, public misconceptions, hidden identities, reveal constraints.
- Locations: current location, home bases, restricted areas, portals, safe houses, schools, businesses, magical places.
- Factions and institutions: Ministry, Hogwarts, Death Eaters, Order, houses, clubs, families, political alignment.
- Goals and threads: active plans, quests, obligations, unresolved hooks, threats, bargains, mysteries.
- Timeline anchors and AU divergences: date/era, canon boundary, changed events, time travel or branch rules.
Prefer specific scoped entries over one giant summary entry.`;
    }
    return `Incremental coverage categories. Extract only durable new or changed facts: character state changes, relationship changes, possessions gained/lost, spells used/learned, secrets revealed, location changes, active plans, timeline shifts, and AU divergences.`;
}

function buildLoreGenerationSystemPrompt(settings = getSettings(), profile = {}) {
    const count = Math.max(0, Math.min(10, Number(settings.loreTagCount ?? 4)));
    const tagInstruction = count === 0
        ? 'Do not generate tags. Set tags to an empty array for every entry.'
        : `Generate exactly ${count} tags for each entry unless impossible. Tags must be short searchable labels, not full sentences.`;
    const mode = profile.mode || 'incremental';
    const modeLabel = mode === 'bootstrap' ? 'BOOTSTRAP STORY LORE' : 'INCREMENTAL STORY LORE';
    const targetLine = mode === 'bootstrap'
        ? `Target output: approximately ${profile.targetTotal || 40} total entries across all chunks. For each chunk, aim for ${profile.perChunkMin || 6}-${profile.perChunkMax || 16} entries when the source supports it. It is acceptable to produce fewer only when the chunk is genuinely sparse.`
        : `Target output: approximately ${profile.targetTotal || 8} total entries across all chunks. For each chunk, aim for ${profile.perChunkMin || 1}-${profile.perChunkMax || 6} entries focused on new durable changes.`;

    return `${LORE_GENERATION_SYSTEM_PROMPT}

Runtime generation settings:
- Generation mode: ${modeLabel}.
- Source window: last ${Math.max(1, Math.min(200, Number(settings.loreSourceMessageCount) || 40))} messages.
- Existing accepted story/AU lore entries: ${profile.storyLoreCount ?? 'unknown'}.
- Chunk count: ${profile.chunkCount || 1}.
- ${targetLine}
- Tag count: ${count}.
- ${tagInstruction}

${categoryCoverageText(mode)}

${priorityGuidanceText(mode)}

Mode-specific rules:
- Bootstrap mode is for a first pass on an existing story. It should populate a broad foundation of pending lore, not a tiny summary.
- Incremental mode is for maintenance after the story already has accepted lore. It should be more selective.
- Do not create generic canon-only encyclopedia entries. Canon facts are useful only when they constrain this story's current state, timeline, knowledge boundary, or AU branch.
- If the messages establish multiple small durable facts, split them into multiple scoped entries rather than merging them into one broad entry.
- Every entry must have a concrete content.fact and content.injection.`;
}

function buildLoreChunkUserMessage({ stateSummary, chunkText, chunkIndex, chunkCount, profile, previousTitles = [] }) {
    const mode = profile?.mode || 'incremental';
    const previous = previousTitles.length
        ? `\nAlready generated in earlier chunks; avoid repeating these titles/facts unless the current chunk adds a distinct update:\n- ${previousTitles.slice(-40).join('\n- ')}\n`
        : '';
    const target = mode === 'bootstrap'
        ? `For this chunk, produce ${profile.perChunkMin}-${profile.perChunkMax} supported entries if possible. Capture characters, possessions, spells/skills, secrets, relationships, locations, factions, active goals, and AU/timeline facts found in this chunk.`
        : `For this chunk, produce ${profile.perChunkMin}-${profile.perChunkMax} supported entries focused on new or changed durable facts.`;

    return `Current state: ${stateSummary}

Generation mode: ${mode}.
Chunk ${chunkIndex + 1} of ${chunkCount}.
${target}
${previous}
Recent message chunk ${chunkIndex + 1} of ${chunkCount}:
${chunkText || '(No message text)'}

Generate story/AU lore entries from this chunk. Do not repeat accepted lore unless this chunk makes the fact story-specific, current-state-specific, or divergent. Output ONLY a valid JSON object with no markdown fences, no commentary, no explanations:`;
}

function normalizeGeneratedEntry(entry, settings = getSettings(), profile = {}) {
    const normalized = { ...entry };
    const tagCount = Math.max(0, Math.min(10, Number(settings.loreTagCount ?? 4)));
    normalized.tags = tagCount === 0
        ? []
        : (Array.isArray(normalized.tags) ? normalized.tags.slice(0, tagCount) : []);
    normalized.source = normalized.source || `model-generated:${profile.mode || 'incremental'}`;
    normalized.extensions = {
        ...(normalized.extensions || {}),
        wandlightGeneration: {
            ...((normalized.extensions || {}).wandlightGeneration || {}),
            mode: profile.mode || 'incremental',
            generatedAt: Date.now(),
            targetTotal: profile.targetTotal || 0,
        },
    };
    return normalized;
}


// ── Bulk Lore Scan Helpers ──────────────────────────────────────────────────────

function getAllMessageObjects() {
    try {
        const ctx = SillyTavern.getContext();
        const chat = ctx?.chat || [];
        return Array.isArray(chat) ? chat : [];
    } catch (_) {
        return [];
    }
}

function stableStringHash(value) {
    const text = String(value || '');
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

function normalizeScanMessage(message, zeroIndex = 0) {
    const text = String(message?.mes || message?.content || '').trim();
    const name = String(message?.name || (message?.is_user ? 'User' : message?.is_system ? 'System' : 'Unknown')).trim() || 'Unknown';
    const role = message?.is_user ? 'user' : message?.is_system ? 'system' : 'character';
    const fallbackId = stableStringHash(`${zeroIndex + 1}|${name}|${role}|${text}`);
    const id = String(message?.extra?.id || message?.id || message?.swipe_id || fallbackId);
    const hash = stableStringHash(`${id}|${name}|${role}|${text}`);
    return {
        index: zeroIndex + 1,
        zeroIndex,
        id,
        role,
        speaker: name,
        text,
        hash,
    };
}

function formatScanMessages(messages = []) {
    return messages
        .filter(m => String(m?.text || '').trim())
        .map(m => `[${m.index}] ${m.speaker || m.role || 'Unknown'}: ${m.text}`)
        .join('\n\n');
}

function buildLoreBulkScanPlan(settings = getSettings(), state = getState()) {
    const allMessages = getAllMessageObjects().map((message, idx) => normalizeScanMessage(message, idx));
    const totalMessages = allMessages.length;
    const scanMode = String(settings.loreBulkScanMode || 'recent').toLowerCase();
    const recentCount = clampInt(settings.loreSourceMessageCount, 1, 5000, 40);
    let startIndex = 1;
    let endIndex = totalMessages;

    if (scanMode === 'range') {
        startIndex = clampInt(settings.loreBulkRangeStart, 1, Math.max(1, totalMessages), 1);
        const configuredEnd = Number(settings.loreBulkRangeEnd) || totalMessages;
        endIndex = clampInt(configuredEnd, startIndex, Math.max(startIndex, totalMessages), totalMessages);
    } else if (scanMode === 'entire') {
        startIndex = 1;
        endIndex = totalMessages;
    } else {
        endIndex = totalMessages;
        startIndex = Math.max(1, totalMessages - recentCount + 1);
    }

    const selected = allMessages.filter(m => m.index >= startIndex && m.index <= endIndex);
    const chunkSize = clampInt(settings.loreBulkChunkSize || settings.loreGenerationChunkSize, 1, 50, 10);
    const overlap = clampInt(settings.loreBulkOverlap, 0, Math.max(0, chunkSize - 1), 1);
    const step = Math.max(1, chunkSize - overlap);
    const contextKey = buildLoreGenerationKey(state);
    const chunks = [];

    for (let offset = 0; offset < selected.length; offset += step) {
        const chunkMessages = selected.slice(offset, offset + chunkSize);
        if (!chunkMessages.length) break;
        const first = chunkMessages[0];
        const last = chunkMessages[chunkMessages.length - 1];
        const messageHash = stableStringHash(chunkMessages.map(m => `${m.index}:${m.hash}`).join('|'));
        const chunkId = `${contextKey || 'context'}:bulk:${first.index}-${last.index}`;
        chunks.push({
            chunkId,
            startIndex: first.index,
            endIndex: last.index,
            messageCount: chunkMessages.length,
            messages: chunkMessages,
            messageHash,
        });
        if (offset + chunkSize >= selected.length) break;
    }

    return {
        chatMessageCount: totalMessages,
        scanMode,
        startIndex,
        endIndex,
        sourceMessageCount: selected.length,
        chunkSize,
        overlap,
        chunks,
        contextKey,
    };
}

function getBulkChunkPriorState(chunkId) {
    try {
        return getState()?.loreBulkGeneration?.chunks?.[chunkId] || null;
    } catch (_) {
        return null;
    }
}

function shouldQueueBulkChunk(chunk, settings = getSettings()) {
    const mode = String(settings.loreBulkRescanMode || 'skip_unchanged').toLowerCase();
    const prior = getBulkChunkPriorState(chunk.chunkId);
    if (mode === 'rescan_all') return true;
    if (mode === 'retry_failed') return prior?.status === 'failed';
    if (mode === 'stale_only') return !!prior && prior.messageHash !== chunk.messageHash;
    if (!prior) return true;
    if (prior.status === 'failed') return true;
    if (prior.messageHash !== chunk.messageHash) return true;
    return prior.status !== 'complete';
}

function buildBulkCandidateSystemPrompt(settings = getSettings(), profile = {}) {
    const factsPerChunk = clampInt(settings.loreBulkFactsPerChunk, 4, 30, 14);
    return `You are Wandlight Continuity's bulk story-lore extractor.

Task:
- Extract compact, durable story/AU candidate facts from a message interval.
- This is a bulk backfill pass. Prefer coverage and recoverability over polished prose.
- Do not output full lore-entry schema. Output compact candidate facts only.
- Do not create generic Harry Potter encyclopedia facts unless the story messages make them current, divergent, private, or plot-relevant.
- Capture new/original characters, canon characters as used by this story, relationships, possessions/items, spells/skills, secrets/knowledge boundaries, locations, factions, goals/threads, timeline anchors, and AU divergences.
- Use priorityHint: high only for active secrets, identity/state constraints, major relationship/current-goal facts, critical possessions, current injuries/conditions, or major AU divergences; medium for durable useful facts; low for flavor/background.

Output requirements:
- Return ONLY valid JSON. No markdown fences. No commentary.
- Required shape: {"chunkSummary":"string","facts":[...]}
- Produce up to ${factsPerChunk} facts when supported by the chunk. Sparse chunks may produce fewer.
- Every fact must include: category, subject, fact, priorityHint, messageRefs.
- messageRefs must be message numbers from the bracketed message labels.
- Keep facts atomic: one durable claim per fact.
- Use categories: character, relationship, item, spell, knowledge, place, faction, goal, timeline, event, secret, artifact, skill, rule.

Generation mode: ${profile.mode || 'bootstrap'}.
Target total entries for this scan: ${profile.targetTotal || 40}.`;
}

function buildBulkCandidateUserMessage({ stateSummary, chunk, plan, profile }) {
    return `Current Wandlight state summary:
${stateSummary}

Bulk scan range: messages ${plan.startIndex}-${plan.endIndex} (${plan.sourceMessageCount} messages).
Current chunk: messages ${chunk.startIndex}-${chunk.endIndex}.
Generation mode: ${profile.mode || 'bootstrap'}.

Message interval:
${formatScanMessages(chunk.messages) || '(No message text)'}

Extract compact candidate facts from this interval. Output ONLY the JSON object now.`;
}

function normalizeCandidateFact(raw = {}, chunk = {}) {
    if (!raw || typeof raw !== 'object') return null;
    const category = String(raw.category || raw.kind || raw.type || 'knowledge').trim().toLowerCase().replace(/[^a-z_ -]+/g, '').replace(/\s+/g, '_') || 'knowledge';
    const subject = String(raw.subject || raw.character || raw.item || raw.location || raw.title || '').trim();
    const fact = String(raw.fact || raw.detail || raw.description || raw.text || raw.summary || '').trim();
    if (!fact || fact.length < 8) return null;
    const messageRefs = Array.isArray(raw.messageRefs) ? raw.messageRefs : Array.isArray(raw.messages) ? raw.messages : Array.isArray(raw.evidenceMessageRefs) ? raw.evidenceMessageRefs : [];
    return {
        category,
        subject: subject || fact.split(/[.;]/)[0].slice(0, 80).trim() || 'Story fact',
        fact,
        priorityHint: String(raw.priorityHint || raw.priority || 'medium').trim().toLowerCase(),
        confidence: Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence) : 0.75,
        messageRefs: messageRefs.map(v => Number(v)).filter(n => Number.isFinite(n) && n > 0),
        scope: raw.scope && typeof raw.scope === 'object' ? raw.scope : {},
        evidence: String(raw.evidence || raw.quote || '').trim().slice(0, 500),
        chunkId: chunk.chunkId || '',
        startIndex: chunk.startIndex || 0,
        endIndex: chunk.endIndex || 0,
    };
}

function coerceBulkFactsShape(parsed) {
    if (Array.isArray(parsed)) return { chunkSummary: '', facts: parsed };
    if (!parsed || typeof parsed !== 'object') return null;
    if (Array.isArray(parsed.facts)) return { chunkSummary: String(parsed.chunkSummary || parsed.summary || ''), facts: parsed.facts };
    if (Array.isArray(parsed.candidates)) return { chunkSummary: String(parsed.chunkSummary || parsed.summary || ''), facts: parsed.candidates };
    if (Array.isArray(parsed.entries)) return { chunkSummary: String(parsed.chunkSummary || parsed.summary || ''), facts: parsed.entries };
    if (parsed.fact || parsed.description || parsed.text) return { chunkSummary: '', facts: [parsed] };
    return null;
}

function parseJsonLinesAsFacts(text) {
    const facts = [];
    for (const line of String(text || '').split(/\r?\n/)) {
        const trimmed = line.trim().replace(/,$/, '');
        if (!trimmed || !trimmed.startsWith('{')) continue;
        try {
            facts.push(JSON.parse(sanitizeJsonish(trimmed)));
        } catch (_) {
            // Keep scanning; JSONL salvage should preserve good lines.
        }
    }
    return facts.length ? { chunkSummary: '', facts } : null;
}

function parseBulkCandidateResponse(text, chunk = {}) {
    if (!text || typeof text !== 'string') return null;
    const parsed = parseJsonResponse(text);
    const shaped = coerceBulkFactsShape(parsed);
    if (shaped) {
        const facts = shaped.facts.map(f => normalizeCandidateFact(f, chunk)).filter(Boolean);
        return { chunkSummary: shaped.chunkSummary || '', facts };
    }
    const jsonl = parseJsonLinesAsFacts(text);
    if (jsonl) {
        const facts = jsonl.facts.map(f => normalizeCandidateFact(f, chunk)).filter(Boolean);
        return { chunkSummary: jsonl.chunkSummary || '', facts };
    }
    return null;
}

function priorityFromHint(hint, category = '') {
    const h = String(hint || '').toLowerCase();
    const c = String(category || '').toLowerCase();
    if (/^(critical|highest|very_high|high|90|100)/.test(h)) return 85;
    if (/^(low|minor|background|flavor|20|30)/.test(h)) return 35;
    if (['secret', 'goal', 'timeline', 'event', 'rule'].includes(c)) return 75;
    if (['character', 'relationship', 'item', 'artifact', 'spell', 'skill'].includes(c)) return 65;
    return 55;
}

function cleanIdPart(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 48) || 'story_fact';
}

function inferScopeFromCandidate(candidate = {}) {
    const scope = candidate.scope && typeof candidate.scope === 'object' ? { ...candidate.scope } : {};
    const subject = String(candidate.subject || '').trim();
    const category = String(candidate.category || '').toLowerCase();
    if (subject) {
        if (['character', 'relationship', 'secret'].includes(category)) {
            scope.characters = Array.from(new Set([...(Array.isArray(scope.characters) ? scope.characters : []), subject]));
        } else if (['place', 'location'].includes(category)) {
            scope.locations = Array.from(new Set([...(Array.isArray(scope.locations) ? scope.locations : []), subject]));
        } else if (['item', 'artifact'].includes(category)) {
            scope.objects = Array.from(new Set([...(Array.isArray(scope.objects) ? scope.objects : []), subject]));
        } else if (category === 'spell') {
            scope.spells = Array.from(new Set([...(Array.isArray(scope.spells) ? scope.spells : []), subject]));
        } else {
            scope.topics = Array.from(new Set([...(Array.isArray(scope.topics) ? scope.topics : []), subject]));
        }
    }
    return scope;
}

function categoryToLoreCategory(category = '') {
    const c = String(category || '').toLowerCase();
    if (c === 'location') return 'place';
    if (c === 'goal') return 'event';
    if (c === 'rule') return 'knowledge';
    return ['character', 'relationship', 'item', 'spell', 'knowledge', 'place', 'faction', 'timeline', 'event', 'secret', 'artifact', 'skill'].includes(c) ? c : 'knowledge';
}

function candidateFactToLoreEntry(candidate = {}, { batchId = '', chunk = {}, profile = {} } = {}) {
    const category = categoryToLoreCategory(candidate.category);
    const subject = String(candidate.subject || 'Story fact').trim();
    const fact = String(candidate.fact || '').trim();
    const rangeLabel = chunk?.startIndex && chunk?.endIndex ? `Messages ${chunk.startIndex}-${chunk.endIndex}` : '';
    const hash = stableStringHash(`${batchId}|${chunk?.chunkId || ''}|${subject}|${fact}`);
    const titleFact = fact.replace(/\s+/g, ' ').replace(/[\r\n]+/g, ' ').slice(0, 96);
    const title = `${subject}: ${titleFact}`.slice(0, 140);
    const messageRefs = Array.isArray(candidate.messageRefs) ? candidate.messageRefs : [];
    return {
        id: `story_bulk_${cleanIdPart(subject)}_${hash}`,
        title,
        kind: category === 'spell' ? 'spell_use' : category === 'relationship' ? 'relationship_state' : category === 'item' || category === 'artifact' ? 'object_state' : 'fact',
        gateType: category === 'spell' ? 'spell_use' : category === 'relationship' ? 'relationship_state' : category === 'item' || category === 'artifact' ? 'object_state' : 'fact',
        category,
        canonStatus: 'au',
        truthStatus: category === 'secret' ? 'hidden' : 'true',
        revealPolicy: category === 'secret' ? 'private' : 'public',
        priority: priorityFromHint(candidate.priorityHint, category),
        tags: [subject, category, 'bulk scan', rangeLabel].filter(Boolean),
        scope: inferScopeFromCandidate(candidate),
        content: {
            fact,
            injection: fact,
            notes: candidate.evidence ? `Evidence: ${candidate.evidence}` : '',
        },
        source: `model-generated:bulk:${batchId}:${chunk?.chunkId || ''}`,
        sourceInfo: {
            id: `bulk-lore:${batchId}:${chunk?.chunkId || ''}`,
            work: 'Current chat',
            chapter: rangeLabel,
            confidence: Math.max(0, Math.min(1, Number(candidate.confidence) || 0.75)),
            notes: messageRefs.length ? `Evidence messages: ${messageRefs.join(', ')}` : rangeLabel,
        },
        extensions: {
            wandlightGeneration: {
                mode: 'bulk-bootstrap',
                batchId,
                chunkId: chunk?.chunkId || '',
                startIndex: chunk?.startIndex || 0,
                endIndex: chunk?.endIndex || 0,
                messageHash: chunk?.messageHash || '',
                evidenceMessageRefs: messageRefs,
                candidateCategory: candidate.category || category,
                generatedAt: Date.now(),
                targetTotal: profile.targetTotal || 0,
            },
        },
    };
}

async function runWithConcurrency(items, concurrency, worker) {
    const limit = Math.max(1, Math.min(12, Number(concurrency) || 1));
    const results = new Array(items.length);
    let nextIndex = 0;

    async function runner() {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            try {
                results[index] = { status: 'fulfilled', value: await worker(items[index], index) };
            } catch (error) {
                results[index] = { status: 'rejected', reason: error };
            }
        }
    }

    const workers = Array.from({ length: Math.min(limit, items.length) }, () => runner());
    await Promise.all(workers);
    return results;
}

async function extractBulkChunkCandidates({ chunk, plan, batchId, profile, settings, stateSummary, signal }) {
    const maxAttempts = Math.max(1, Math.min(5, clampInt(settings.loreBulkRetryAttempts, 0, 4, 2) + 1));
    const systemPrompt = buildBulkCandidateSystemPrompt(settings, profile);
    const userMessage = buildBulkCandidateUserMessage({ stateSummary, chunk, plan, profile });
    let lastError = '';
    let rawResponse = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        throwIfAborted(signal);
        updateLoreBulkChunk(chunk.chunkId, {
            batchId,
            status: attempt === 1 ? 'running' : 'retrying',
            attempts: attempt,
            startIndex: chunk.startIndex,
            endIndex: chunk.endIndex,
            messageHash: chunk.messageHash,
            messageCount: chunk.messageCount,
        });

        try {
            rawResponse = await quietPrompt(systemPrompt, userMessage, { signal, maxTokens: profile.maxTokens, expectedOutput: 'json' });
            throwIfAborted(signal);
            let parsed = parseBulkCandidateResponse(rawResponse, chunk);
            if ((!parsed || !parsed.facts.length) && settings.loreRepairOnParseFail) {
                const repaired = await repairLoreJsonResponse(rawResponse);
                const shaped = coerceBulkFactsShape(repaired);
                if (shaped) {
                    parsed = { chunkSummary: shaped.chunkSummary || '', facts: shaped.facts.map(f => normalizeCandidateFact(f, chunk)).filter(Boolean) };
                }
            }
            if (!parsed) {
                lastError = 'Response was empty or unparseable.';
                continue;
            }

            const candidates = parsed.facts || [];
            storeLoreBulkCandidates(batchId, chunk.chunkId, candidates);
            updateLoreBulkChunk(chunk.chunkId, {
                batchId,
                status: 'complete',
                attempts: attempt,
                startIndex: chunk.startIndex,
                endIndex: chunk.endIndex,
                messageHash: chunk.messageHash,
                messageCount: chunk.messageCount,
                candidateCount: candidates.length,
                chunkSummary: parsed.chunkSummary || '',
                rawResponse: settings.debugMode ? String(rawResponse || '').slice(0, 20000) : '',
                error: '',
                lastScannedAt: Date.now(),
            });
            return { status: 'complete', chunk, candidates, summary: parsed.chunkSummary || '', attempts: attempt };
        } catch (e) {
            if (isAbortError(e)) throw e;
            lastError = e?.message || String(e || 'Unknown provider error');
        }
    }

    updateLoreBulkChunk(chunk.chunkId, {
        batchId,
        status: 'failed',
        startIndex: chunk.startIndex,
        endIndex: chunk.endIndex,
        messageHash: chunk.messageHash,
        messageCount: chunk.messageCount,
        error: lastError || 'Bulk extraction failed.',
        rawResponse: settings.debugMode ? String(rawResponse || '').slice(0, 20000) : '',
        lastScannedAt: Date.now(),
    });
    return { status: 'failed', chunk, candidates: [], summary: '', error: lastError || 'Bulk extraction failed.' };
}

/**
 * Runs a resumable, range-based bulk story lore scan.
 * Processes chunks concurrently, writes chunk/candidate ledger records, and appends Pending Lore entries as chunks complete.
 * @param {Object} [options]
 * @param {boolean} [options.force=true]
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.progress]
 * @returns {Promise<Object>} Structured bulk scan result
 */
export async function runBulkLoreGeneration(options = {}) {
    const { force = true, signal = null } = options;
    const progress = typeof options.progress === 'function' ? options.progress : null;

    if (_generationRunning) {
        return { status: 'skipped_running' };
    }

    _generationRunning = true;
    try {
        throwIfAborted(signal);
        let state = getState();
        const settings = getSettings();
        const validation = validateLoreProviderConfiguration();
        if (!validation.ok) {
            progress?.(`API/model settings incomplete: ${validation.message}`, 100);
            return { status: 'api_not_configured', error: validation.message };
        }

        if (!state.loreContext?.lastDetectedAt && force) {
            progress?.('Detecting story context before bulk lore scan...', 4);
            const detected = await runLoreContextDetection({ progress, signal });
            if (!detected) {
                progress?.('No story context could be detected. Bulk lore scan cancelled.', 100);
                return { status: 'no_context_detected' };
            }
            state = getState();
        }

        const plan = buildLoreBulkScanPlan(settings, state);
        if (!plan.sourceMessageCount || !plan.chunks.length) {
            progress?.('No chat messages found in the configured bulk scan range.', 100);
            return { status: 'empty_range', plan };
        }

        const allChunks = plan.chunks;
        const queuedChunks = allChunks.filter(chunk => shouldQueueBulkChunk(chunk, settings));
        const skippedChunks = allChunks.length - queuedChunks.length;
        const contextKey = plan.contextKey || buildLoreGenerationKey(state);
        const batchId = `bulk_lore_${Date.now()}_${stableStringHash(`${contextKey}|${plan.startIndex}|${plan.endIndex}|${plan.chunkSize}|${plan.overlap}`)}`;
        const profile = determineLoreGenerationProfile(settings, state, {
            force,
            sourceCount: plan.sourceMessageCount,
            chunkCount: Math.max(1, queuedChunks.length || allChunks.length),
        });
        profile.mode = 'bootstrap';
        profile.bulk = true;
        profile.targetTotal = Math.max(profile.targetTotal, Math.ceil(plan.sourceMessageCount / Math.max(1, plan.chunkSize)) * 6);

        const concurrency = clampInt(settings.loreBulkConcurrency, 1, 8, 3);
        const stateSummary = JSON.stringify({
            canon: state.canon,
            scene: state.scene,
            loreContext: state.loreContext,
            acceptedStoryLoreCount: countAcceptedStoryLore(state.loreMatrix || []),
        }, null, 0);

        startLoreBulkBatch({
            id: batchId,
            contextKey,
            status: 'running',
            mode: 'bulk-bootstrap',
            scanMode: plan.scanMode,
            rangeStart: plan.startIndex,
            rangeEnd: plan.endIndex,
            sourceMessageCount: plan.sourceMessageCount,
            chunkSize: plan.chunkSize,
            overlap: plan.overlap,
            concurrency,
            rescanMode: settings.loreBulkRescanMode || 'skip_unchanged',
            totalChunks: allChunks.length,
            queuedChunks: queuedChunks.length,
            skippedChunks,
            completedChunks: 0,
            failedChunks: 0,
            candidateCount: 0,
            pendingEntryCount: (state.pendingLoreEntries || []).length,
        });

        if (!queuedChunks.length) {
            updateLoreBulkBatch(batchId, { status: 'complete', completedAt: Date.now(), skippedChunks, completedChunks: 0 });
            progress?.(`Bulk lore scan found no changed chunks. Skipped ${skippedChunks} unchanged chunk${skippedChunks === 1 ? '' : 's'}.`, 100);
            return { status: 'skipped_unchanged', batchId, plan, skippedChunks };
        }

        progress?.(`Bulk lore scan queued ${queuedChunks.length}/${allChunks.length} chunks from messages ${plan.startIndex}-${plan.endIndex}. Running ${concurrency} in parallel.`, 8);

        let completed = 0;
        let failed = 0;
        let candidateCount = 0;
        let pendingEntryCount = (state.pendingLoreEntries || []).length;
        let duplicateDrops = 0;
        const summaries = [];

        const results = await runWithConcurrency(queuedChunks, concurrency, async (chunk, index) => {
            throwIfAborted(signal);
            progress?.(`Bulk lore scan running: ${completed + failed}/${queuedChunks.length} chunks complete, ${Math.min(concurrency, queuedChunks.length - completed - failed)} active.`, Math.min(95, 8 + Math.round(((completed + failed) / queuedChunks.length) * 85)));
            const result = await extractBulkChunkCandidates({ chunk, plan, batchId, profile, settings, stateSummary, signal });

            if (result.status === 'complete') {
                const entries = normalizeLoreMatrix(result.candidates.map(candidate => candidateFactToLoreEntry(candidate, { batchId, chunk, profile })));
                let filteredEntries = entries;
                let drops = [];
                if (settings.loreDuplicateGuard !== false && filteredEntries.length) {
                    const current = getState();
                    const guardBase = [ ...(current.loreMatrix || []) ];
                    const filtered = filterDuplicateLoreEntries(filteredEntries, guardBase, {
                        storyGeneration: true,
                        ignoreCanonicalSourceSimilarity: true,
                    });
                    filteredEntries = filtered.entries;
                    drops = filtered.dropped || [];
                }
                duplicateDrops += drops.length;
                if (settings.loreBulkConsolidateAsPending !== false && filteredEntries.length) {
                    const append = appendPendingLoreEntries(filteredEntries, {
                        id: batchId,
                        contextKey,
                        source: 'manual_bulk',
                        summary: `Bulk story lore scan messages ${plan.startIndex}-${plan.endIndex}`,
                        rawEntryCount: entries.length,
                        normalizedEntryCount: entries.length,
                        droppedDuplicateCount: drops.length,
                        sourceMessageCount: plan.sourceMessageCount,
                        chunkSize: plan.chunkSize,
                        chunkCount: allChunks.length,
                        completedChunkCount: completed + 1,
                        failedChunkCount: failed,
                        generationMode: 'bulk-bootstrap',
                        generationConfiguredMode: settings.loreGenerationBreadthMode || 'auto',
                        targetEntryCount: profile.targetTotal,
                        storyLoreCountBefore: profile.storyLoreCount,
                        bulkBatchId: batchId,
                        bulkChunkId: chunk.chunkId,
                        bulk: true,
                    }, { snapshot: completed === 0, snapshotLabel: 'Bulk Generate pending lore entries' });
                    pendingEntryCount = append.pendingCount;
                }
                candidateCount += result.candidates.length;
                if (result.summary) summaries.push(result.summary);
                completed++;
            } else {
                failed++;
            }

            updateLoreBulkBatch(batchId, {
                completedChunks: completed,
                failedChunks: failed,
                candidateCount,
                pendingEntryCount,
                lastChunkId: chunk.chunkId,
            });
            progress?.(`Bulk lore scan: ${completed} complete, ${failed} failed, ${candidateCount} candidate facts, ${pendingEntryCount} pending entries.`, Math.min(98, 8 + Math.round(((completed + failed) / queuedChunks.length) * 88)));
            return result;
        });

        const status = failed === queuedChunks.length ? 'failed' : failed > 0 ? 'partial' : 'complete';
        updateLoreBulkBatch(batchId, {
            status,
            completedAt: Date.now(),
            completedChunks: completed,
            failedChunks: failed,
            candidateCount,
            pendingEntryCount,
            droppedDuplicateCount: duplicateDrops,
            summaries: summaries.slice(-20),
        });
        patchPendingLoreMeta({
            bulkBatchId: batchId,
            generationMode: 'bulk-bootstrap',
            completedChunkCount: completed,
            failedChunkCount: failed,
            chunkCount: allChunks.length,
            rawEntryCount: candidateCount,
            normalizedEntryCount: candidateCount,
            droppedDuplicateCount: duplicateDrops,
            sourceMessageCount: plan.sourceMessageCount,
            chunkSize: plan.chunkSize,
            targetEntryCount: profile.targetTotal,
            summary: `Bulk story lore scan messages ${plan.startIndex}-${plan.endIndex}`,
        });

        const rejected = results.filter(r => r.status === 'rejected').length;
        progress?.(`Bulk lore scan ${status}: ${completed} chunks complete, ${failed + rejected} failed, ${candidateCount} candidate facts, ${pendingEntryCount} pending lore entries.`, 100);
        return {
            status,
            batchId,
            contextKey,
            plan,
            totalChunks: allChunks.length,
            queuedChunks: queuedChunks.length,
            skippedChunks,
            completedChunkCount: completed,
            failedChunkCount: failed + rejected,
            candidateCount,
            pendingEntryCount,
            droppedDuplicateCount: duplicateDrops,
        };
    } catch (e) {
        const batchId = getState()?.loreBulkGeneration?.activeBatchId || '';
        if (batchId) updateLoreBulkBatch(batchId, { status: isAbortError(e) ? 'cancelled' : 'failed', error: e?.message || String(e || '') });
        if (isAbortError(e)) {
            progress?.('Bulk lore scan cancelled by user.', 0);
            return { status: 'cancelled', error: 'Cancelled by user' };
        }
        console.error(`${LOG_PREFIX} Bulk lore generation failed:`, e);
        progress?.(`Bulk lore scan failed: ${e.message || e}`, 100);
        return { status: 'failed_exception', error: e.message || String(e || '') };
    } finally {
        _generationRunning = false;
    }
}

export const __bulkLoreTestHooks = {
    stableStringHash,
    normalizeScanMessage,
    buildLoreBulkScanPlan,
    parseBulkCandidateResponse,
    candidateFactToLoreEntry,
    runWithConcurrency,
};

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
                return await runLoreGeneration({ force, allowReplacePending, progress, signal });
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

        const sourceCount = Math.max(1, Math.min(200, Number(settings.loreSourceMessageCount) || 40));
        const chunkSize = Math.max(1, Math.min(50, Number(settings.loreGenerationChunkSize) || 10));
        const messageObjects = getRecentMessageObjects(sourceCount);
        const chunks = chunkMessages(messageObjects, chunkSize);
        const profile = determineLoreGenerationProfile(settings, state, {
            force,
            sourceCount,
            chunkCount: chunks.length,
        });
        const systemPrompt = buildLoreGenerationSystemPrompt(settings, profile);
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

        progress?.(`${profile.mode === 'bootstrap' ? 'Bootstrap' : 'Incremental'} story lore generation: target ${profile.targetTotal} entries from ${sourceCount} messages.`, 8);

        for (let i = 0; i < chunks.length; i++) {
            throwIfAborted(signal);
            const chunkText = formatMessageObjects(chunks[i]);
            const previousTitles = allRawEntries.map(entry => String(entry?.title || '').trim()).filter(Boolean);
            stepProgress(`Generating ${profile.mode} lore chunk ${i + 1}/${chunks.length} (${chunks[i].length} messages)...`);

            const userMessage = buildLoreChunkUserMessage({
                stateSummary,
                chunkText,
                chunkIndex: i,
                chunkCount: chunks.length,
                profile,
                previousTitles,
            });
            const response = await quietPrompt(systemPrompt, userMessage, { signal, maxTokens: profile.maxTokens });
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
            allRawEntries.push(...parsed.entries.map((entry, entryIndex) => ({
                ...entry,
                source: entry?.source || `model-generated:${profile.mode}:chunk-${i + 1}-of-${chunks.length}`,
                extensions: {
                    ...(entry?.extensions || {}),
                    wandlightGeneration: {
                        ...((entry?.extensions || {}).wandlightGeneration || {}),
                        mode: profile.mode,
                        chunkIndex: i + 1,
                        chunkCount: chunks.length,
                        entryIndex: entryIndex + 1,
                        targetTotal: profile.targetTotal,
                    },
                },
            })));
        }

        if (rawEntryCount === 0 && failedChunkCount >= chunks.length) {
            recordLoreAttempt(contextKey, {
                status: 'failed_no_response',
                generationMode: profile.mode,
                targetEntryCount: profile.targetTotal,
                lastError: `All ${chunks.length} lore generation chunks returned empty or unparseable responses`,
            }, { increment: false });
            progress?.('Lore generation returned no usable responses from any chunk.', 100);
            return {
                status: 'failed_no_response',
                contextKey,
                generationMode: profile.mode,
                targetEntryCount: profile.targetTotal,
                failedChunkCount,
                emptyChunkCount,
                chunkCount: chunks.length,
            };
        }

        completedSteps++;
        progress?.(`Normalizing and filtering generated lore entries... (${completedSteps}/${totalSteps} steps)`, Math.min(96, 6 + Math.round((completedSteps / totalSteps) * 88)));
        let entries = normalizeLoreMatrix(allRawEntries).map(entry => normalizeGeneratedEntry(entry, settings, profile));
        const normalizedEntryCount = entries.length;
        let duplicateDrops = [];
        if (settings.loreDuplicateGuard !== false) {
            const filtered = filterDuplicateLoreEntries(entries, state.loreMatrix || [], {
                storyGeneration: true,
                ignoreCanonicalSourceSimilarity: profile.mode === 'bootstrap',
            });
            entries = filtered.entries;
            duplicateDrops = filtered.dropped;
        }

        if (entries.length === 0) {
            recordLoreAttempt(contextKey, {
                status: 'empty',
                rawEntryCount,
                normalizedEntryCount,
                validEntryCount: 0,
                generationMode: profile.mode,
                targetEntryCount: profile.targetTotal,
                lastError: duplicateDrops.length ? `All valid lore entries were duplicate/similar to existing entries (${duplicateDrops.length} dropped)` : 'No valid lore entries after normalization',
            }, { increment: false });
            if (settings.debugMode) {
                console.debug(`${LOG_PREFIX} Lore generation returned no valid entries after normalization`);
            }
            progress?.('Lore generation produced no usable non-duplicate entries.', 100);
            return {
                status: 'empty_valid_entries',
                contextKey,
                generationMode: profile.mode,
                targetEntryCount: profile.targetTotal,
                rawEntryCount,
                normalizedEntryCount,
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
            normalizedEntryCount,
            droppedDuplicateCount: duplicateDrops.length,
            failedChunkCount,
            emptyChunkCount,
            chunkCount: chunks.length,
            sourceMessageCount: sourceCount,
            chunkSize,
            generationMode: profile.mode,
            generationConfiguredMode: profile.configuredMode,
            targetEntryCount: profile.targetTotal,
            storyLoreCountBefore: profile.storyLoreCount,
        }, {
            snapshot: source === 'manual',
            snapshotLabel: 'Generate pending lore entries',
        });

        if (settings.debugMode) {
            console.log(`${LOG_PREFIX} Lore generated: ${entries.length} entries pending review`, entries);
        }

        progress?.(`${profile.mode === 'bootstrap' ? 'Bootstrap' : 'Incremental'} story lore ready for review: ${entries.length}/${profile.targetTotal} target entries.`, 100);

        return {
            status: 'proposed',
            contextKey,
            entries,
            generationMode: profile.mode,
            generationConfiguredMode: profile.configuredMode,
            targetEntryCount: profile.targetTotal,
            sourceMessageCount: sourceCount,
            rawEntryCount,
            normalizedEntryCount,
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