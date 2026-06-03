/**
 * continuity-scanner.js — Wandlight
 * Checkpointed, chunked continuity scanner.
 *
 * Pipeline:
 * messages -> parallel compact observations -> section reducers -> one ordered delta -> review/apply
 */

import { LOG_PREFIX } from './constants.js';
import {
    getSettings,
    getState,
    saveState,
    pushStateSnapshot,
    applyDelta,
    validateDelta,
} from './state-manager.js';
import { sendLoreRequest, validateLoreProviderConfiguration } from './lore-llm-client.js';

const ACTIVE_CONTINUITY_SECTIONS = ['canon', 'scene', 'characters', 'inventory', 'objectives', 'threads'];
const RETIRED_CONTINUITY_SECTIONS = ['knowledge', 'secrets', 'relationships', 'storyMilestones', 'continuityFlags', 'flags'];

const SECTION_GROUPS = [
    {
        id: 'scene_timeline',
        label: 'Scene and Timeline',
        sections: ['canon', 'scene'],
        enabled: state => state?.continuityConfig?.canon !== false || state?.continuityConfig?.scene !== false,
    },
    {
        id: 'active_characters',
        label: 'Active Characters',
        sections: ['characters'],
        enabled: state => state?.continuityConfig?.characters !== false,
    },
    {
        id: 'key_items',
        label: 'Key Items',
        sections: ['inventory'],
        enabled: state => state?.continuityConfig?.inventory !== false,
    },
    {
        id: 'active_goals_threads',
        label: 'Active Goals and Threads',
        sections: ['objectives', 'threads'],
        enabled: state => state?.continuityConfig?.objectives !== false || state?.continuityConfig?.threads !== false,
    },
];

const OBSERVATION_SECTIONS = new Set(ACTIVE_CONTINUITY_SECTIONS);

function clampInt(value, min, max, fallback) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function truncateText(value, max = 1000) {
    const text = String(value ?? '').trim();
    if (text.length <= max) return text;
    return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function formatElapsed(ms) {
    const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function compactProgressClip(value, max = 180) {
    return truncateText(String(value || '').replace(/\s+/g, ' ').trim(), max);
}

function createProgressHeartbeat(progress, options = {}) {
    if (typeof progress !== 'function') return { stop() {}, pulse() {} };
    const startedAt = Date.now();
    const label = options.label || 'Continuity scan';
    const basePercent = Math.max(0, Math.min(98, Number(options.basePercent) || 10));
    const maxPercent = Math.max(basePercent, Math.min(99, Number(options.maxPercent) || 95));
    const intervalMs = Math.max(2500, Number(options.intervalMs) || 8000);
    let tick = 0;
    let stopped = false;

    function getDetailText() {
        const detail = typeof options.detail === 'function' ? options.detail() : options.detail;
        return compactProgressClip(detail || '', options.detailMax || 180);
    }

    function emit(prefix = 'Still working') {
        if (stopped) return;
        tick += 1;
        const elapsed = formatElapsed(Date.now() - startedAt);
        const eased = Math.min(maxPercent, basePercent + Math.floor(Math.log2(tick + 1) * 6));
        const detail = getDetailText();
        progress(`${prefix}: ${label} (${elapsed})${detail ? ` - ${detail}` : ''}`, eased);
    }

    const timer = globalThis.setInterval ? globalThis.setInterval(() => emit('Still working'), intervalMs) : null;
    return {
        pulse: emit,
        stop() {
            stopped = true;
            if (timer && globalThis.clearInterval) globalThis.clearInterval(timer);
        },
    };
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

function isPlainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

function stripThinking(text) {
    return String(text || '')
        .replace(/<think\b[^>]*>([\s\S]*?)<\/think>/gi, '')
        .replace(/<thinking\b[^>]*>([\s\S]*?)<\/thinking>/gi, '')
        .replace(/<reasoning\b[^>]*>([\s\S]*?)<\/reasoning>/gi, '')
        .trim();
}

function getAllMessageObjects() {
    try {
        const ctx = SillyTavern.getContext();
        const chat = ctx?.chat || [];
        return Array.isArray(chat) ? chat : [];
    } catch (_) {
        return [];
    }
}

function normalizeScanMessage(message, zeroIndex = 0) {
    const rawText = message?.mes || message?.content || '';
    const text = stripThinking(rawText);
    const name = String(message?.name || (message?.is_user ? 'User' : message?.is_system ? 'System' : 'Assistant')).trim() || 'Unknown';
    const role = message?.is_user ? 'user' : message?.is_system ? 'system' : 'assistant';
    const fallbackId = stableStringHash(`${zeroIndex + 1}|${name}|${role}|${text}`);
    const id = String(message?.extra?.id || message?.id || message?.swipe_id || fallbackId);
    const hash = stableStringHash(`${id}|${name}|${role}|${text}`);
    return { index: zeroIndex + 1, zeroIndex, id, role, speaker: name, text, hash };
}

function formatScanMessages(messages = []) {
    return messages
        .filter(m => String(m?.text || '').trim())
        .map(m => `[${m.index}] ${m.speaker || m.role || 'Unknown'} (${m.role || 'message'}): ${m.text}`)
        .join('\n\n');
}

function formatMessageRefs(refs = []) {
    const out = [];
    for (const value of Array.isArray(refs) ? refs : []) {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0 && !out.includes(n)) out.push(n);
    }
    return out.slice(0, 20);
}

function contextKeyForState(state = getState()) {
    const canon = state?.canon || {};
    const scene = state?.scene || {};
    const lore = state?.loreContext || {};
    return stableStringHash([
        canon.era || '',
        canon.inUniverseDate || '',
        canon.canonBoundary || '',
        lore.branchId || 'main',
        scene.location || '',
    ].join('|'));
}

export function buildContinuityProjection(state = getState()) {
    const cfg = state?.continuityConfig || {};
    const compactArray = (arr, max, mapFn = x => x) => (Array.isArray(arr) ? arr.slice(0, max).map(mapFn) : []);
    const compactObject = (obj, maxKeys = 40) => {
        if (!isPlainObject(obj)) return {};
        return Object.fromEntries(Object.entries(obj).slice(0, maxKeys));
    };
    return {
        continuityConfig: { ...cfg },
        canon: cfg.canon === false ? undefined : {
            era: state?.canon?.era || '',
            inUniverseDate: state?.canon?.inUniverseDate || '',
            canonBoundary: state?.canon?.canonBoundary || '',
        },
        scene: cfg.scene === false ? undefined : {
            location: state?.scene?.location || '',
            timeOfDay: state?.scene?.timeOfDay || '',
            weather: state?.scene?.weather || '',
            ambience: state?.scene?.ambience || '',
            presentCharacters: compactArray(state?.scene?.presentCharacters, 30),
            nearbyCharacters: compactArray(state?.scene?.nearbyCharacters, 30),
            currentActivity: state?.scene?.currentActivity || '',
        },
        characters: cfg.characters === false ? undefined : compactArray(state?.characters, 60, c => ({
            name: c?.name || '',
            role: c?.role || '',
            location: c?.location || '',
            physicalState: c?.physicalState || '',
            clothing: cfg.appearance === false ? '' : (c?.clothing || ''),
            posture: c?.posture || '',
            currentGoal: c?.currentGoal || '',
            emotionalState: cfg.emotionalState === false ? undefined : (c?.emotionalState || undefined),
            notes: truncateText(c?.notes || '', 300),
        })),
        inventory: cfg.inventory === false ? undefined : compactArray(state?.inventory, 40),
        objectives: cfg.objectives === false ? undefined : compactArray(state?.objectives, 40),
        threads: cfg.threads === false ? undefined : compactArray(state?.threads, 30),
    };
}


function isContinuitySectionEnabled(state = getState(), sectionKey = '') {
    const normalized = sectionKey === 'continuityFlags' ? 'flags' : String(sectionKey || '');
    if (RETIRED_CONTINUITY_SECTIONS.includes(normalized)) return false;
    if (!ACTIVE_CONTINUITY_SECTIONS.includes(normalized)) return false;
    const cfg = state?.continuityConfig || {};
    return cfg[normalized] !== false;
}

function buildContinuityProjectionForSections(state = getState(), sections = []) {
    const full = buildContinuityProjection(state);
    const wanted = new Set(sections || []);
    const projection = { continuityConfig: full.continuityConfig };
    for (const key of ACTIVE_CONTINUITY_SECTIONS) {
        if (wanted.has(key) && full[key] !== undefined) projection[key] = full[key];
    }
    return projection;
}

function buildContinuityScanHeaderProjection(state = getState()) {
    const characters = Array.isArray(state?.characters) ? state.characters : [];
    return {
        canon: {
            era: state?.canon?.era || '',
            inUniverseDate: state?.canon?.inUniverseDate || '',
            canonBoundary: state?.canon?.canonBoundary || '',
        },
        scene: {
            location: state?.scene?.location || '',
            timeOfDay: state?.scene?.timeOfDay || '',
            presentCharacters: Array.isArray(state?.scene?.presentCharacters) ? state.scene.presentCharacters.slice(0, 20) : [],
            currentActivity: state?.scene?.currentActivity || '',
        },
        trackedCharacters: characters.map(c => c?.name).filter(Boolean).slice(0, 40),
        activeObjectives: Array.isArray(state?.objectives) ? state.objectives.slice(0, 12) : [],
        activeThreads: Array.isArray(state?.threads) ? state.threads.filter(t => t?.status !== 'resolved').slice(0, 12) : [],
    };
}

function deriveEnabledSections(state = getState(), mode = 'all') {
    const essentials = ['canon', 'scene', 'characters', 'inventory', 'objectives'];
    const source = mode === 'essentials' ? essentials : ACTIVE_CONTINUITY_SECTIONS;
    return source.filter(section => isContinuitySectionEnabled(state, section));
}

function buildSectionDecisionTemplate(sections = []) {
    const unique = Array.from(new Set(sections));
    const entries = unique.map(section => `    "${section}": { "status": "changed|unchanged|insufficient", "reason": "one short reason" }`);
    return `"sectionDecisions": {\n${entries.join(',\n')}\n  }`;
}

const COMMON_SCENE_HINTS = [
    'Great Hall', 'common room', 'dormitory', 'classroom', 'library', 'hospital wing', 'grounds', 'Forbidden Forest', 'Hogsmeade', 'Diagon Alley', 'Ministry', 'Burrow', 'Privet Drive', 'Platform 9¾', 'Quidditch pitch', 'corridor', 'office', 'dungeon', 'greenhouse', 'Astronomy Tower', 'Room of Requirement', 'Hogwarts Express',
];

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildLocalContinuityPrepass(plan = {}) {
    const messages = (plan.chunks || []).flatMap(c => c.messages || []);
    const text = messages.map(m => m.text || '').join('\n');
    const speakersSeen = Array.from(new Set(messages.map(m => m.speaker).filter(Boolean))).slice(0, 40);
    const candidateSceneHints = COMMON_SCENE_HINTS.filter(hint => new RegExp(`\\b${escapeRegExp(hint)}\\b`, 'i').test(text)).slice(0, 20);
    const explicitDates = [];
    const datePattern = /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\.?\s*,?\s*(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t)?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?\s*,?\s*\d{4}\b/gi;
    for (const match of text.matchAll(datePattern)) {
        if (!explicitDates.includes(match[0])) explicitDates.push(match[0]);
        if (explicitDates.length >= 10) break;
    }
    const inferredCanon = inferHpBoundaryFromText(text);
    return {
        messageRange: `${plan.startIndex || 0}-${plan.endIndex || 0}`,
        messageCount: Number(plan.sourceMessageCount || messages.length || 0),
        speakersSeen,
        candidatePresentCharacters: speakersSeen,
        candidateSceneHints,
        explicitDates,
        inferredCanon,
    };
}

function chooseContinuityScanStrategy(plan = {}, settings = {}, options = {}) {
    const requested = String(options.strategyOverride || settings.continuityScanStrategy || 'adaptive').toLowerCase();
    if (['fast', 'hybrid', 'bulk'].includes(requested)) return requested;
    const count = Number(plan.sourceMessageCount || 0);
    const fastThreshold = clampInt(settings.continuityScanFastThreshold, 1, 200, 20);
    const hybridThreshold = Math.max(fastThreshold, clampInt(settings.continuityScanHybridThreshold, fastThreshold, 500, 80));
    if (count <= fastThreshold) return 'fast';
    if (count <= hybridThreshold) return 'hybrid';
    return 'bulk';
}

function safeJson(value, fallback = '{}') {
    try { return JSON.stringify(value, null, 2); } catch (_) { return fallback; }
}

function ensureContinuityLedger(state = getState()) {
    if (!state.continuityScan || typeof state.continuityScan !== 'object' || Array.isArray(state.continuityScan)) {
        state.continuityScan = { activeBatchId: '', lastBatchId: '', batches: {}, chunks: {}, observations: {} };
    }
    for (const key of ['batches', 'chunks', 'observations']) {
        if (!state.continuityScan[key] || typeof state.continuityScan[key] !== 'object' || Array.isArray(state.continuityScan[key])) {
            state.continuityScan[key] = {};
        }
    }
    state.continuityScan.activeBatchId = String(state.continuityScan.activeBatchId || '');
    state.continuityScan.lastBatchId = String(state.continuityScan.lastBatchId || '');
    return state.continuityScan;
}

function compactObservation(raw = {}, chunk = {}) {
    if (!raw || typeof raw !== 'object') return null;
    const sectionRaw = String(raw.section || raw.category || 'scene').trim();
    let section = sectionRaw === 'flags' ? 'continuityFlags' : sectionRaw;
    if (section === 'items' || section === 'item') section = 'inventory';
    if (section === 'goals' || section === 'goal') section = 'objectives';
    if (RETIRED_CONTINUITY_SECTIONS.includes(section)) return null;
    if (!OBSERVATION_SECTIONS.has(section)) section = 'scene';
    const observation = truncateText(raw.observation || raw.fact || raw.text || raw.description || '', 900);
    if (!observation) return null;
    return {
        section,
        subject: truncateText(raw.subject || raw.character || raw.item || section, 160),
        observation,
        actionHint: truncateText(raw.actionHint || raw.action || raw.operation || 'upsert', 40),
        confidence: Number.isFinite(Number(raw.confidence)) ? Math.max(0, Math.min(1, Number(raw.confidence))) : 0.75,
        messageRefs: formatMessageRefs(raw.messageRefs || raw.messages || raw.refs),
        evidence: truncateText(raw.evidence || '', 400),
        chunkId: chunk.chunkId || raw.chunkId || '',
        startIndex: Number(chunk.startIndex || raw.startIndex || 0),
        endIndex: Number(chunk.endIndex || raw.endIndex || 0),
    };
}

function saveContinuityLedger(state, { full = false, syncPrompt = false } = {}) {
    compactContinuityLedger(state, { full });
    saveState(state, { syncPrompt, sanitize: !!full });
}

function compactContinuityLedger(state = getState(), options = {}) {
    const ledger = ensureContinuityLedger(state);
    const settings = getSettings();
    const retainCompleted = Math.max(1, Number(settings.continuityScanRetainCompletedBatches) || 3);
    const batches = Object.entries(ledger.batches || {}).sort((a, b) => Number(b[1]?.updatedAt || b[1]?.createdAt || 0) - Number(a[1]?.updatedAt || a[1]?.createdAt || 0));
    const keep = new Set();
    let completedKept = 0;
    for (const [id, batch] of batches) {
        const status = String(batch?.status || '');
        if (id === ledger.activeBatchId || ['running', 'queued', 'partial', 'failed', 'cancelled'].includes(status)) {
            keep.add(id);
        } else if (completedKept < retainCompleted) {
            keep.add(id);
            completedKept++;
        }
    }
    if (ledger.lastBatchId) keep.add(ledger.lastBatchId);
    for (const id of Object.keys(ledger.batches || {})) if (!keep.has(id)) delete ledger.batches[id];
    for (const [id, chunk] of Object.entries(ledger.chunks || {})) if (chunk?.batchId && !keep.has(chunk.batchId)) delete ledger.chunks[id];
    for (const [id, record] of Object.entries(ledger.observations || {})) if (record?.batchId && !keep.has(record.batchId)) delete ledger.observations[id];
    return ledger;
}

function checkpointContinuityChunk(chunkId, payload = {}, options = {}) {
    const state = getState();
    const ledger = ensureContinuityLedger(state);
    const id = String(chunkId || payload.chunkId || '');
    if (!id) return state;
    const batchId = String(payload.batchId || payload.batchPatch?.id || ledger.activeBatchId || ledger.lastBatchId || '');
    const previous = ledger.chunks[id] || { id, attempts: 0, createdAt: Date.now() };
    ledger.chunks[id] = {
        ...previous,
        ...(payload.chunkPatch || {}),
        id,
        batchId: batchId || previous.batchId || '',
        updatedAt: Date.now(),
    };
    if (payload.rawResponse && (getSettings().debugMode || getSettings().continuityScanRetainRawResponses)) {
        ledger.chunks[id].rawResponse = truncateText(payload.rawResponse, 20000);
    } else if ('rawResponse' in ledger.chunks[id]) {
        ledger.chunks[id].rawResponse = '';
    }
    if (Array.isArray(payload.observations)) {
        ledger.observations[id] = {
            batchId,
            chunkId: id,
            observations: payload.observations.map(o => compactObservation(o, payload.chunk || {})).filter(Boolean).slice(0, 100),
            updatedAt: Date.now(),
        };
    }
    if (batchId && payload.batchPatch && typeof payload.batchPatch === 'object') {
        const prevBatch = ledger.batches[batchId] || { id: batchId, createdAt: Date.now() };
        ledger.batches[batchId] = { ...prevBatch, ...payload.batchPatch, id: batchId, updatedAt: Date.now() };
        if (payload.batchPatch.status && !['running', 'queued'].includes(String(payload.batchPatch.status))) {
            if (ledger.activeBatchId === batchId) ledger.activeBatchId = '';
        }
    }
    saveContinuityLedger(state, { full: !!options.full, syncPrompt: false });
    return state;
}

function startContinuityBatch(batch = {}) {
    const state = getState();
    const ledger = ensureContinuityLedger(state);
    const id = String(batch.id || `continuity_scan_${Date.now()}`);
    const prev = ledger.batches[id] || {};
    ledger.batches[id] = {
        ...prev,
        ...batch,
        id,
        status: batch.status || 'running',
        createdAt: prev.createdAt || Date.now(),
        startedAt: batch.startedAt || prev.startedAt || Date.now(),
        updatedAt: Date.now(),
    };
    ledger.activeBatchId = id;
    ledger.lastBatchId = id;
    saveContinuityLedger(state, { full: true, syncPrompt: false });
    return state;
}

function flushContinuityFullCheckpoint(batchId, patch = {}) {
    const state = getState();
    const ledger = ensureContinuityLedger(state);
    const id = String(batchId || ledger.activeBatchId || ledger.lastBatchId || '');
    if (!id) return state;
    const prev = ledger.batches[id] || { id, createdAt: Date.now() };
    ledger.batches[id] = {
        ...prev,
        ...patch,
        id,
        updatedAt: Date.now(),
        lastFullCheckpointAt: Date.now(),
    };
    if (patch.status && !['running', 'queued'].includes(String(patch.status))) {
        if (ledger.activeBatchId === id) ledger.activeBatchId = '';
    }
    saveContinuityLedger(state, { full: true, syncPrompt: false });
    return state;
}

function markContinuityPlanChunksComplete(batchId, plan = {}, status = 'complete') {
    const state = getState();
    const ledger = ensureContinuityLedger(state);
    const now = Date.now();
    for (const chunk of plan.chunks || []) {
        const id = String(chunk.chunkId || '');
        if (!id) continue;
        const previous = ledger.chunks[id] || { id, createdAt: now };
        ledger.chunks[id] = {
            ...previous,
            id,
            batchId,
            status,
            startIndex: chunk.startIndex,
            endIndex: chunk.endIndex,
            messageCount: chunk.messageCount,
            messageHash: chunk.messageHash,
            attempts: Math.max(1, Number(previous.attempts || 0)),
            observationCount: Number(previous.observationCount || 0),
            completedAt: now,
            updatedAt: now,
            error: '',
        };
    }
    saveContinuityLedger(state, { full: false, syncPrompt: false });
    return state;
}

function markInterruptedContinuityChunks(staleMs) {
    const state = getState();
    const ledger = ensureContinuityLedger(state);
    const cutoff = Date.now() - Math.max(1000, Number(staleMs) || 600000);
    let changed = false;
    for (const [id, chunk] of Object.entries(ledger.chunks || {})) {
        const status = String(chunk?.status || '');
        const updatedAt = Number(chunk?.updatedAt || chunk?.startedAt || 0);
        if ((status === 'running' || status === 'retrying') && (!updatedAt || updatedAt < cutoff)) {
            ledger.chunks[id] = { ...chunk, status: 'interrupted', error: chunk?.error || 'Previous continuity scan was interrupted before this chunk completed.', updatedAt: Date.now() };
            changed = true;
        }
    }
    if (changed) saveContinuityLedger(state, { full: false, syncPrompt: false });
    return state;
}

function buildEffectiveContinuitySettings(base = getSettings(), options = {}) {
    const effective = { ...(base || {}) };
    if (options.scanModeOverride) effective.continuityScanMode = String(options.scanModeOverride).toLowerCase();
    if (options.rescanModeOverride) effective.continuityScanRescanMode = String(options.rescanModeOverride).toLowerCase();
    if (Number.isFinite(Number(options.rangeStart))) effective.continuityScanRangeStart = Number(options.rangeStart);
    if (Number.isFinite(Number(options.rangeEnd))) effective.continuityScanRangeEnd = Number(options.rangeEnd);
    if (Number.isFinite(Number(options.sourceMessageCount))) effective.continuitySourceMessageCount = Number(options.sourceMessageCount);
    if (Number.isFinite(Number(options.chunkSize))) effective.continuityScanChunkSize = Number(options.chunkSize);
    if (Number.isFinite(Number(options.overlap))) effective.continuityScanOverlap = Number(options.overlap);
    if (Number.isFinite(Number(options.concurrency))) effective.continuityScanConcurrency = Number(options.concurrency);
    if (Number.isFinite(Number(options.reducerConcurrency))) effective.continuityScanReducerConcurrency = Number(options.reducerConcurrency);
    if (Number.isFinite(Number(options.retryAttempts))) effective.continuityScanRetryAttempts = Number(options.retryAttempts);
    if (Number.isFinite(Number(options.observationsPerChunk))) effective.continuityScanObservationsPerChunk = Number(options.observationsPerChunk);

    if (options.automationSafe) {
        effective.continuityScanMode = 'recent';
        effective.continuityScanRescanMode = String(options.rescanModeOverride || 'skip_unchanged').toLowerCase();
        effective.continuityScanConcurrency = clampInt(effective.continuityScanConcurrency, 1, 3, 2);
        effective.continuityScanReducerConcurrency = clampInt(effective.continuityScanReducerConcurrency, 1, 3, 2);
        effective.continuityScanObservationsPerChunk = clampInt(effective.continuityScanObservationsPerChunk, 3, 12, 8);
    }
    return effective;
}

export function buildContinuityScanPlan(settings = getSettings(), state = getState()) {
    const allMessages = getAllMessageObjects().map((msg, idx) => normalizeScanMessage(msg, idx)).filter(m => m.text);
    const totalMessages = allMessages.length;
    const scanMode = String(settings.continuityScanMode || 'recent').toLowerCase();
    const recentCount = clampInt(settings.continuitySourceMessageCount, 1, 5000, 10);
    let startIndex = 1;
    let endIndex = totalMessages;
    if (scanMode === 'range') {
        startIndex = clampInt(settings.continuityScanRangeStart, 1, Math.max(1, totalMessages), 1);
        const configuredEnd = Number(settings.continuityScanRangeEnd) || totalMessages;
        endIndex = clampInt(configuredEnd, startIndex, Math.max(startIndex, totalMessages), totalMessages);
    } else if (scanMode === 'entire') {
        startIndex = 1;
        endIndex = totalMessages;
    } else {
        endIndex = totalMessages;
        startIndex = Math.max(1, totalMessages - recentCount + 1);
    }
    const selected = allMessages.filter(m => m.index >= startIndex && m.index <= endIndex);
    const chunkSize = clampInt(settings.continuityScanChunkSize, 1, 50, 8);
    const overlap = clampInt(settings.continuityScanOverlap, 0, Math.max(0, chunkSize - 1), 1);
    const step = Math.max(1, chunkSize - overlap);
    const contextKey = contextKeyForState(state);
    const chunks = [];
    for (let offset = 0; offset < selected.length; offset += step) {
        const chunkMessages = selected.slice(offset, offset + chunkSize);
        if (!chunkMessages.length) break;
        const first = chunkMessages[0];
        const last = chunkMessages[chunkMessages.length - 1];
        const messageHash = stableStringHash(chunkMessages.map(m => `${m.index}:${m.hash}`).join('|'));
        // Keep the chunk id tied to the message interval, not mutable continuity state.
        // Staleness is tracked through messageHash so rescans after state changes can still skip unchanged chunks.
        const chunkId = `continuity:${first.index}-${last.index}`;
        chunks.push({ chunkId, startIndex: first.index, endIndex: last.index, messageCount: chunkMessages.length, messages: chunkMessages, messageHash });
        if (offset + chunkSize >= selected.length) break;
    }
    return { chatMessageCount: totalMessages, scanMode, startIndex, endIndex, sourceMessageCount: selected.length, chunkSize, overlap, chunks, contextKey };
}

function getPriorChunk(chunkId) {
    try { return getState()?.continuityScan?.chunks?.[chunkId] || null; } catch (_) { return null; }
}

function shouldQueueChunk(chunk, settings) {
    const mode = String(settings.continuityScanRescanMode || 'skip_unchanged').toLowerCase();
    const prior = getPriorChunk(chunk.chunkId);
    if (mode === 'rescan_all') return true;
    if (mode === 'retry_failed') return prior?.status === 'failed' || prior?.status === 'interrupted';
    if (mode === 'stale_only') return !!prior && prior.messageHash !== chunk.messageHash;
    if (!prior) return true;
    if (prior.status === 'failed' || prior.status === 'interrupted') return true;
    if (prior.messageHash !== chunk.messageHash) return true;
    return prior.status !== 'complete';
}

async function runWithConcurrency(items, limit, worker) {
    const queue = [...items];
    const results = [];
    const count = Math.max(1, Math.min(Math.max(1, items.length), Number(limit) || 1));
    async function runOne() {
        while (queue.length) {
            const item = queue.shift();
            try {
                results.push(await worker(item));
            } catch (e) {
                results.push({ status: 'rejected', error: e?.message || String(e), item });
            }
        }
    }
    await Promise.all(Array.from({ length: count }, runOne));
    return results;
}

function extractJsonText(text) {
    let source = String(text || '').trim();
    const fence = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) source = fence[1].trim();
    return source;
}

function parseJsonObjectFromText(text) {
    const source = extractJsonText(text);
    try { return JSON.parse(source); } catch (_) {}
    const firstObj = source.indexOf('{');
    const lastObj = source.lastIndexOf('}');
    if (firstObj >= 0 && lastObj > firstObj) {
        try { return JSON.parse(source.slice(firstObj, lastObj + 1)); } catch (_) {}
    }
    const firstArr = source.indexOf('[');
    const lastArr = source.lastIndexOf(']');
    if (firstArr >= 0 && lastArr > firstArr) {
        try { return JSON.parse(source.slice(firstArr, lastArr + 1)); } catch (_) {}
    }
    return null;
}

function parseObservationResponse(text, chunk = {}) {
    const parsed = parseJsonObjectFromText(text);
    let raw = [];
    if (Array.isArray(parsed)) raw = parsed;
    else if (Array.isArray(parsed?.observations)) raw = parsed.observations;
    else if (Array.isArray(parsed?.facts)) raw = parsed.facts;
    else if (Array.isArray(parsed?.items)) raw = parsed.items;

    if (!raw.length) {
        const lines = extractJsonText(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        for (const line of lines) {
            if (!line.startsWith('{')) continue;
            try { raw.push(JSON.parse(line)); } catch (_) {}
        }
    }

    if (isPlainObject(parsed?.sceneSnapshot)) {
        const snap = parsed.sceneSnapshot;
        for (const [field, value] of Object.entries(snap)) {
            if (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) continue;
            raw.push({
                section: field === 'canonDateHints' ? 'canon' : 'scene',
                subject: `sceneSnapshot.${field}`,
                observation: `${field}: ${Array.isArray(value) ? value.join(', ') : value}`,
                actionHint: 'update',
                confidence: 0.8,
                messageRefs: [chunk.startIndex, chunk.endIndex].filter(Boolean),
            });
        }
    }

    const observations = raw.map(o => compactObservation(o, chunk)).filter(Boolean);
    return {
        summary: truncateText(parsed?.chunkSummary || parsed?.summary || '', 500),
        observations,
    };
}

function isArrayDeltaShape(value) {
    return isPlainObject(value) && (
        Array.isArray(value.added) || Array.isArray(value.updated) || Array.isArray(value.removed) || Array.isArray(value.resolved)
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
    const knownKeys = ACTIVE_CONTINUITY_SECTIONS;
    let delta = parsed;
    if (!isPlainObject(delta.changes)) {
        const candidate = isPlainObject(parsed.state) ? parsed.state
            : isPlainObject(parsed.continuityState) ? parsed.continuityState
            : isPlainObject(parsed.continuity) ? parsed.continuity
            : parsed;
        const hasKnown = knownKeys.some(k => k in candidate);
        if (hasKnown) {
            const changes = {};
            for (const key of knownKeys) if (candidate[key] !== undefined) changes[key] = candidate[key];
            delta = { summary: parsed.summary || 'Continuity state extracted', changes };
        }
    }
    if (!isPlainObject(delta?.changes)) return delta;
    const changes = { ...delta.changes };
    for (const key of ['characters', 'inventory', 'objectives', 'threads']) {
        if (changes[key] !== undefined) changes[key] = coerceArrayOrPatch(changes[key]);
    }
    for (const key of ['threads']) {
        const value = changes[key];
        if (isPlainObject(value) && !isArrayDeltaShape(value)) changes[key] = { added: [value] };
    }
    return { ...delta, changes };
}

function parseDeltaResponse(text) {
    const parsed = parseJsonObjectFromText(text);
    const candidate = isPlainObject(parsed?.delta) ? { ...parsed.delta, sectionDecisions: parsed.sectionDecisions || parsed.delta.sectionDecisions } : parsed;
    const delta = coerceFullStateOrLooseDelta(candidate);
    if (!isPlainObject(delta?.changes)) return null;
    const validation = validateDelta(delta);
    if (!validation.valid) {
        console.warn(`${LOG_PREFIX} Continuity reducer delta validation failed: ${validation.errors.join('; ')}`);
        return null;
    }
    return { ...delta, sectionDecisions: delta.sectionDecisions || parsed?.sectionDecisions || null };
}

function getCharacterContinuityGuidance(stateProjection = {}) {
    const cfg = stateProjection?.continuityConfig || {};
    const lines = [];
    if (cfg.appearance === false) {
        lines.push('- Appearance Detail is disabled: do not add or update clothing/appearance fields.');
    } else {
        lines.push('- Appearance Detail is enabled: update clothing only when currently visible or explicitly changed.');
    }
    if (cfg.emotionalState === false) {
        lines.push('- Emotional State is disabled: do not add or update emotionalState fields.');
    } else {
        lines.push('- Emotional State is enabled: update emotionalState only for currently observed behavior or explicit narration. Do not preserve old emotions as current unless the latest messages reinforce them.');
    }
    return lines.join('\n');
}

function buildObservationSystemPrompt(settings, stateProjection) {
    const maxObs = clampInt(settings.continuityScanObservationsPerChunk, 3, 30, 12);
    const cfg = stateProjection?.continuityConfig || {};
    const characterBits = ['present active characters', 'physical state', 'carried key items', 'active goals'];
    if (cfg.appearance !== false) characterBits.push('currently visible appearance/clothing');
    if (cfg.emotionalState !== false) characterBits.push('currently observed emotional state');
    const currentContinuityText = ['scene/timeline', ...characterBits, 'immediate unresolved threads'].join(', ');
    return `You are Wandlight's continuity observation extractor.\n\nTask:\n- Read one interval of roleplay messages.\n- Extract compact observations that may change the live continuity state.\n- Do not output a final WandlightDelta. Do not modify state directly.\n- Output ONLY valid JSON.\n\nOutput schema:
{
  "chunkSummary": "short summary",
  "sceneSnapshot": {
    "location": "current/most recent location if evident",
    "timeOfDay": "current/most recent time of day if evident",
    "presentCharacters": ["characters visibly present"],
    "currentActivity": "what is happening now",
    "canonDateHints": ["explicit or implied dates/era hints"]
  },
  "observations": [
    {
      "section": "canon|scene|characters|inventory|objectives|threads",
      "subject": "short subject",
      "observation": "durable factual observation grounded in the messages",
      "actionHint": "add|update|resolve|remove|upsert",
      "confidence": 0.0,
      "messageRefs": [1]
    }
  ]
}

Limits:\n- Return up to ${maxObs} observations.\n- Prefer current actionable continuity only: ${currentContinuityText}.\n- Do not extract knowledge, secrets, relationship history, story milestones, lore facts, or continuity warnings; Story Lore owns those durable memories.\n- Preserve message indexes in messageRefs.\n- If nothing changed, return {"chunkSummary":"No continuity observations.","observations":[]}.\n\nCharacter field guidance:\n${getCharacterContinuityGuidance(stateProjection)}\n\nCurrent compact continuity projection for reference:\n${safeJson(stateProjection)}`;
}

function getSectionPromptText(settings, sectionKey, stateProjection = {}) {
    const prompts = settings?.continuitySectionPrompts || {};
    const keyMap = {
        canon: ['canonScene'],
        scene: ['canonScene'],
        characters: ['characters'],
        inventory: ['inventory'],
        objectives: ['objectives'],
        threads: ['threads'],
    };
    const base = (keyMap[sectionKey] || [])
        .map(k => String(prompts[k] || '').trim())
        .filter(Boolean)
        .join('\n');
    if (sectionKey !== 'characters') return base;
    return [base, getCharacterContinuityGuidance(stateProjection)].filter(Boolean).join('\n');
}

function buildReducerSystemPrompt(settings, group, stateProjection) {
    const prompts = group.sections.map(section => {
        const text = getSectionPromptText(settings, section, stateProjection);
        return text ? `- ${section}: ${text}` : '';
    }).filter(Boolean).join('\n');
    return `You are Wandlight's ${group.label} reducer.\n\nTask:\n- Convert compact continuity observations into ONE valid WandlightDelta partial.\n- Only modify these sections: ${group.sections.join(', ')}.\n- Resolve observations in chronological order using messageRefs.\n- Do not invent facts not supported by observations.\n- If nothing should change for these sections, output {"summary":"No ${group.label} changes","changes":{}}.\n\nReturn ONLY visible valid JSON in WandlightDelta shape.\n\nReducer-specific guidance:\n${prompts || '(none)'}\n\nCurrent compact continuity projection:\n${safeJson(stateProjection)}`;
}

function buildObservationUserPrompt(chunk, plan) {
    return `Continuity scan interval: messages ${chunk.startIndex}-${chunk.endIndex}.\nFull scan range: messages ${plan.startIndex}-${plan.endIndex}.\n\nMessages:\n${formatScanMessages(chunk.messages)}\n\nExtract compact observations only. Return JSON only.`;
}

function buildReducerUserPrompt(group, observations, plan) {
    const relevant = observations.filter(o => group.sections.includes(o.section));
    return `Full scan range: messages ${plan.startIndex}-${plan.endIndex}.\nReducer group: ${group.label}.\nAllowed sections: ${group.sections.join(', ')}.\n\nObservations, already extracted from message chunks:\n${safeJson(relevant)}\n\nReturn one WandlightDelta partial for this reducer group. JSON only.`;
}

async function extractChunkObservations({ chunk, plan, batchId, settings, stateProjection, signal }) {
    const maxAttempts = Math.max(1, Math.min(5, clampInt(settings.continuityScanRetryAttempts, 0, 4, 2) + 1));
    const systemPrompt = buildObservationSystemPrompt(settings, stateProjection);
    const userPrompt = buildObservationUserPrompt(chunk, plan);
    let lastError = '';
    let rawResponse = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (signal?.aborted) throw new Error('Continuity scan aborted');
        checkpointContinuityChunk(chunk.chunkId, {
            batchId,
            chunk,
            chunkPatch: {
                batchId,
                status: attempt === 1 ? 'running' : 'retrying',
                attempts: attempt,
                startIndex: chunk.startIndex,
                endIndex: chunk.endIndex,
                messageCount: chunk.messageCount,
                messageHash: chunk.messageHash,
                startedAt: Date.now(),
                error: '',
            },
        });
        try {
            rawResponse = await sendLoreRequest(systemPrompt, userPrompt, {
                providerKind: 'continuity',
                maxTokens: clampInt(settings.continuityObservationMaxTokens || Math.min(Number(settings.continuityMaxTokens || 4096), 1536), 512, 8192, 1536),
                prefill: '',
                signal,
                expectedOutput: 'json',
            });
            if (!rawResponse || !String(rawResponse).trim()) {
                lastError = 'Empty continuity observation response.';
                continue;
            }
            const parsed = parseObservationResponse(rawResponse, chunk);
            checkpointContinuityChunk(chunk.chunkId, {
                batchId,
                chunk,
                observations: parsed.observations,
                rawResponse,
                chunkPatch: {
                    batchId,
                    status: 'complete',
                    attempts: attempt,
                    startIndex: chunk.startIndex,
                    endIndex: chunk.endIndex,
                    messageCount: chunk.messageCount,
                    messageHash: chunk.messageHash,
                    observationCount: parsed.observations.length,
                    summary: parsed.summary,
                    completedAt: Date.now(),
                    error: '',
                },
            });
            return { status: 'complete', chunk, observations: parsed.observations, summary: parsed.summary };
        } catch (e) {
            lastError = e?.message || String(e || 'Continuity observation extraction failed.');
        }
    }
    checkpointContinuityChunk(chunk.chunkId, {
        batchId,
        chunk,
        rawResponse,
        chunkPatch: {
            batchId,
            status: 'failed',
            attempts: maxAttempts,
            startIndex: chunk.startIndex,
            endIndex: chunk.endIndex,
            messageCount: chunk.messageCount,
            messageHash: chunk.messageHash,
            observationCount: 0,
            error: lastError || 'Continuity observation extraction failed.',
            failedAt: Date.now(),
        },
    });
    return { status: 'failed', chunk, observations: [], error: lastError || 'Continuity observation extraction failed.' };
}

async function reduceObservationGroup({ group, observations, plan, settings, stateProjection, signal }) {
    const relevant = observations.filter(o => group.sections.includes(o.section));
    if (!relevant.length) return { status: 'empty', group, delta: { summary: `No ${group.label} observations`, changes: {} } };
    const systemPrompt = buildReducerSystemPrompt(settings, group, stateProjection);
    const userPrompt = buildReducerUserPrompt(group, relevant, plan);
    try {
        const response = await sendLoreRequest(systemPrompt, userPrompt, {
            providerKind: 'continuity',
            maxTokens: clampInt(settings.continuityReducerMaxTokens || Math.min(Number(settings.continuityMaxTokens || 4096), 1536), 512, 8192, 1536),
            prefill: '',
            signal,
            expectedOutput: 'json',
        });
        const parsedDelta = parseDeltaResponse(response);
        if (!parsedDelta) return { status: 'failed_parse', group, delta: null, error: 'Reducer returned no valid WandlightDelta.' };
        const delta = restrictDeltaToGroup(parsedDelta, group);
        const validation = validateDelta(delta);
        if (!validation.valid) return { status: 'failed_parse', group, delta: null, error: validation.errors.join('; ') };
        return { status: 'complete', group, delta };
    } catch (e) {
        return { status: 'failed_exception', group, delta: null, error: e?.message || String(e || '') };
    }
}


function restrictDeltaToGroup(delta, group) {
    if (!delta?.changes || !Array.isArray(group?.sections)) return delta;
    const allowed = new Set(group.sections);
    const changes = {};
    for (const [key, value] of Object.entries(delta.changes || {})) {
        if (allowed.has(key)) changes[key] = value;
    }
    return { ...delta, changes };
}

function mergeArrayPatch(target = {}, patch = {}) {
    const out = { ...target };
    for (const op of ['added', 'updated', 'removed', 'resolved']) {
        if (Array.isArray(patch[op])) out[op] = [...(out[op] || []), ...patch[op]];
    }
    return out;
}

function mergeDeltaChanges(base = {}, next = {}) {
    const changes = { ...base };
    for (const [key, value] of Object.entries(next || {})) {
        if (value === undefined) continue;
        if (['characters', 'inventory', 'objectives', 'threads'].includes(key)) {
            changes[key] = mergeArrayPatch(changes[key] || {}, value || {});
        } else if (key === 'canon' && isPlainObject(value)) {
            changes.canon = { ...(changes.canon || {}), ...value };
        } else if (key === 'scene' && isPlainObject(value)) {
            changes.scene = { ...(changes.scene || {}), ...value };
        }
    }
    return changes;
}

function mergeReducerDeltas(results = []) {
    let changes = {};
    const summaries = [];
    for (const result of results) {
        if (result?.status !== 'complete' || !result.delta?.changes) continue;
        if (result.delta.summary) summaries.push(result.delta.summary);
        changes = mergeDeltaChanges(changes, result.delta.changes);
    }
    const delta = { summary: summaries.filter(Boolean).join(' | ') || 'Continuity scan changes', changes };
    const validation = validateDelta(delta);
    if (!validation.valid) {
        console.warn(`${LOG_PREFIX} Merged continuity delta failed validation: ${validation.errors.join('; ')}`);
        return null;
    }
    return delta;
}

function inferHpBoundaryFromText(text) {
    const value = String(text || '');
    const monthMap = { jan:0,january:0,feb:1,february:1,mar:2,march:2,apr:3,april:3,may:4,jun:5,june:5,jul:6,july:6,aug:7,august:7,sep:8,sept:8,september:8,oct:9,october:9,nov:10,november:10,dec:11,december:11 };
    const match = value.match(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\.?\s*,?\s*(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t)?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})\b/i);
    if (!match) return { date: '', boundary: '' };
    const month = monthMap[match[1].toLowerCase().replace('.', '')];
    const year = Number(match[3]);
    const schoolYear = month >= 8 ? year : year - 1;
    const map = { 1991:"Philosopher's/Sorcerer's Stone era, Year 1", 1992:'Chamber of Secrets era, Year 2', 1993:'Prisoner of Azkaban era, Year 3', 1994:'Goblet of Fire era, Year 4', 1995:'Order of the Phoenix era, Year 5', 1996:'Half-Blood Prince era, Year 6', 1997:'Deathly Hallows era, Year 7' };
    return { date: match[0].trim(), boundary: map[schoolYear] || '' };
}

function inferFallbackDeltaFromPlan(plan, state = getState()) {
    const text = (plan?.chunks || []).flatMap(c => c.messages || []).map(m => m.text).join('\n');
    const inferred = inferHpBoundaryFromText(text);
    if (!inferred.date && !inferred.boundary) return null;
    const changes = { canon: {} };
    if (inferred.date && state?.canon?.inUniverseDate !== inferred.date) changes.canon.inUniverseDate = inferred.date;
    if (inferred.boundary && state?.canon?.canonBoundary !== inferred.boundary) {
        changes.canon.canonBoundary = inferred.boundary;
        changes.canon.era = inferred.boundary.replace(/,\s*Year\s*\d+$/i, '');
    }
    if (!Object.keys(changes.canon).length) return null;
    return { summary: 'Fallback continuity date/context inferred locally from message heading.', changes };
}

function buildContinuityDeltaSystemPrompt({ settings, stateProjection, enabledSections, prepass, mode = 'fast' }) {
    const sectionTemplate = buildSectionDecisionTemplate(enabledSections);
    const emphasis = mode === 'fast'
        ? 'Use one compact pass. Prioritize Scene and Timeline, Active Characters, Key Items, and Active Goals/Threads, but evaluate every enabled section.'
        : 'This is a grouped continuity reducer pass. Update only the allowed sections and evaluate each allowed section explicitly.';
    return `You are Wandlight's ${mode === 'fast' ? 'fast continuity delta scanner' : 'hybrid continuity section scanner'}.

Task:
- Read the supplied roleplay messages and current compact state.
- Return one valid JSON object with section decisions and a WandlightDelta.
- Scene and Timeline must always be evaluated when enabled. Do not skip them merely because the change seems minor.
- Use only facts grounded in the supplied messages and local prepass hints.
- Do not include reasoning, markdown, or prose outside JSON.

${emphasis}

Output schema:
{
  ${sectionTemplate},
  "delta": {
    "summary": "short summary of proposed continuity changes",
    "changes": {
      "canon": { "era": "", "inUniverseDate": "", "canonBoundary": "" },
      "scene": { "location": "", "timeOfDay": "", "weather": "", "ambience": "", "presentCharacters": [], "nearbyCharacters": [], "currentActivity": "" },
      "characters": { "added": [], "updated": [], "removed": [] },
      "inventory": { "added": [], "updated": [], "removed": [] },
      "objectives": { "added": [], "updated": [], "removed": [] },
      "threads": { "added": [], "updated": [] }
    }
  }
}

Only include change keys that actually change or add useful state. If a section was evaluated but unchanged, mark it unchanged in sectionDecisions and omit it from delta.changes.

Local prepass hints:
${safeJson(prepass)}

Current compact continuity projection:
${safeJson(stateProjection)}

Relevant configured section guidance:
${enabledSections.map(section => {
    const text = getSectionPromptText(settings, section, stateProjection);
    return text ? `- ${section}: ${text}` : '';
}).filter(Boolean).join('\n') || '(none)'}`;
}

function buildFastContinuityUserPrompt(plan = {}) {
    return `Continuity scan strategy: fast single-pass delta.
Scan range: messages ${plan.startIndex}-${plan.endIndex} (${plan.sourceMessageCount} message(s)).

Messages:
${formatScanMessages((plan.chunks || []).flatMap(c => c.messages || []))}

Return the sectionDecisions object and one delta object. JSON only.`;
}

function buildHybridContinuityUserPrompt(group, plan = {}) {
    return `Continuity scan strategy: hybrid grouped delta.
Allowed sections for this call: ${group.sections.join(', ')}.
Scan range: messages ${plan.startIndex}-${plan.endIndex} (${plan.sourceMessageCount} message(s)).

Messages:
${formatScanMessages((plan.chunks || []).flatMap(c => c.messages || []))}

Return sectionDecisions and one delta object for the allowed sections only. JSON only.`;
}

function getDeltaCallMaxTokens(settings, mode) {
    const key = mode === 'fast' ? 'continuityFastMaxTokens' : 'continuityHybridMaxTokens';
    const fallback = mode === 'fast' ? 2048 : 3072;
    return clampInt(settings[key] || Math.min(Number(settings.continuityMaxTokens || fallback), fallback), 512, 8192, fallback);
}

async function requestContinuityDelta(systemPrompt, userPrompt, settings, options = {}, mode = 'fast') {
    const maxAttempts = Math.max(1, Math.min(4, clampInt(settings.continuityScanRetryAttempts, 0, 3, 1) + 1));
    let lastError = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (options.signal?.aborted) throw new Error('Continuity scan aborted');
        try {
            const response = await sendLoreRequest(systemPrompt, userPrompt, {
                providerKind: 'continuity',
                maxTokens: getDeltaCallMaxTokens(settings, mode),
                prefill: '',
                signal: options.signal,
                expectedOutput: 'json',
            });
            const delta = parseDeltaResponse(response);
            if (delta) return delta;
            lastError = 'Model returned no valid WandlightDelta.';
        } catch (e) {
            lastError = e?.message || String(e || 'Continuity delta request failed.');
        }
    }
    throw new Error(lastError || 'Continuity delta request failed.');
}

function finalizeContinuityScanDelta({ batchId, delta, plan, settings, options = {}, progress, scanStatus = 'complete', meta = {} }) {
    const hasChanges = !!delta && Object.keys(delta.changes || {}).length > 0;
    if (meta.markChunksComplete !== false) markContinuityPlanChunksComplete(batchId, plan, scanStatus === 'failed' ? 'failed' : 'complete');
    flushContinuityFullCheckpoint(batchId, {
        status: scanStatus,
        completedAt: Date.now(),
        strategy: meta.strategy || '',
        modelCallCount: meta.modelCallCount || 0,
        changeKeys: hasChanges ? Object.keys(delta.changes || {}) : [],
        sectionDecisions: delta?.sectionDecisions || meta.sectionDecisions || null,
        ...meta,
    });

    if (!hasChanges) {
        progress?.('Continuity scan complete: no state changes.', 100);
        return { status: 'no_changes', batchId, plan, strategy: meta.strategy || '', sectionDecisions: delta?.sectionDecisions || meta.sectionDecisions || null };
    }

    const currentState = getState();
    if (options.applyImmediately || settings.autoApplyDelta) {
        pushStateSnapshot(currentState, `Continuity scan: ${delta.summary || 'state update'}`, settings.maxSnapshots);
        const next = applyDelta(currentState, delta);
        next.lastDelta = null;
        saveState(next, { syncPrompt: true });
        progress?.(`Continuity scan applied: ${Object.keys(delta.changes || {}).join(', ') || 'changes'}.`, 100);
        return { status: 'applied', batchId, delta, summary: delta.summary || '', changeKeys: Object.keys(delta.changes || {}), strategy: meta.strategy || '', sectionDecisions: delta.sectionDecisions || null };
    }

    currentState.lastDelta = delta;
    saveState(currentState, { syncPrompt: true });
    progress?.('Continuity scan stored changes for review.', 100);
    return { status: 'pending_review', batchId, delta, summary: delta.summary || '', changeKeys: Object.keys(delta.changes || {}), strategy: meta.strategy || '', sectionDecisions: delta.sectionDecisions || null };
}

function buildSyntheticBatchId(strategy, plan) {
    return `continuity_${strategy}_${Date.now()}_${stableStringHash(`${plan.contextKey}|${plan.startIndex}|${plan.endIndex}|${plan.sourceMessageCount}`)}`;
}

function hasQueuedContinuityWork(plan, settings) {
    const queued = plan.chunks.filter(chunk => shouldQueueChunk(chunk, settings));
    return { queuedChunks: queued, skippedChunks: plan.chunks.length - queued.length };
}

async function runFastContinuityDeltaScan({ settings, plan, options, stateAtStart }) {
    const { queuedChunks, skippedChunks } = hasQueuedContinuityWork(plan, settings);
    const batchId = buildSyntheticBatchId('fast', plan);
    const progress = typeof options.progress === 'function' ? options.progress : null;
    startContinuityBatch({
        id: batchId,
        status: queuedChunks.length ? 'running' : 'complete',
        strategy: 'fast',
        mode: options.automationSafe ? 'auto-recent' : 'manual',
        scanMode: plan.scanMode,
        startIndex: plan.startIndex,
        endIndex: plan.endIndex,
        sourceMessageCount: plan.sourceMessageCount,
        totalChunks: plan.chunks.length,
        queuedChunks: queuedChunks.length,
        skippedChunks,
        modelCallCount: 1,
    });
    if (!queuedChunks.length) return { status: 'skipped_unchanged', batchId, plan, skippedChunks, strategy: 'fast' };

    const enabledSections = deriveEnabledSections(stateAtStart, options.automationSafe ? 'essentials' : 'all');
    const prepass = buildLocalContinuityPrepass(plan);
    const projection = buildContinuityProjectionForSections(stateAtStart, enabledSections);
    const systemPrompt = buildContinuityDeltaSystemPrompt({ settings, stateProjection: projection, enabledSections, prepass, mode: 'fast' });
    const userPrompt = buildFastContinuityUserPrompt(plan);
    progress?.('Fast continuity scan running.', 25);
    const heartbeat = createProgressHeartbeat(progress, {
        label: 'Fast continuity scan',
        basePercent: 25,
        maxPercent: 88,
        detail: () => `single model call over messages ${plan.startIndex}-${plan.endIndex}`,
    });
    let delta = null;
    try {
        delta = await requestContinuityDelta(systemPrompt, userPrompt, settings, options, 'fast');
    } catch (e) {
        delta = inferFallbackDeltaFromPlan(plan, getState());
        if (!delta) {
            heartbeat.stop();
            flushContinuityFullCheckpoint(batchId, { status: 'failed', strategy: 'fast', error: e?.message || String(e || ''), failedAt: Date.now() });
            return { status: 'failed_exception', batchId, strategy: 'fast', error: e?.message || String(e || '') };
        }
    } finally {
        heartbeat.stop();
    }
    if (!delta || !Object.keys(delta.changes || {}).length) delta = inferFallbackDeltaFromPlan(plan, getState()) || delta;
    return finalizeContinuityScanDelta({ batchId, delta, plan, settings, options, progress, scanStatus: 'complete', meta: { strategy: 'fast', modelCallCount: 1, prepass } });
}

function getHybridDeltaGroups(stateAtStart = getState()) {
    return SECTION_GROUPS
        .map(group => ({
            id: group.id,
            label: group.label,
            sections: group.sections.filter(section => isContinuitySectionEnabled(stateAtStart, section)),
        }))
        .filter(group => group.sections.length);
}

async function runHybridContinuityDeltaScan({ settings, plan, options, stateAtStart }) {
    const { queuedChunks, skippedChunks } = hasQueuedContinuityWork(plan, settings);
    const batchId = buildSyntheticBatchId('hybrid', plan);
    const progress = typeof options.progress === 'function' ? options.progress : null;
    const groups = getHybridDeltaGroups(stateAtStart);
    startContinuityBatch({
        id: batchId,
        status: queuedChunks.length ? 'running' : 'complete',
        strategy: 'hybrid',
        mode: options.automationSafe ? 'auto-recent' : 'manual',
        scanMode: plan.scanMode,
        startIndex: plan.startIndex,
        endIndex: plan.endIndex,
        sourceMessageCount: plan.sourceMessageCount,
        totalChunks: plan.chunks.length,
        queuedChunks: queuedChunks.length,
        skippedChunks,
        modelCallCount: groups.length,
    });
    if (!queuedChunks.length) return { status: 'skipped_unchanged', batchId, plan, skippedChunks, strategy: 'hybrid' };

    const prepass = buildLocalContinuityPrepass(plan);
    const concurrency = clampInt(settings.continuityScanReducerConcurrency, 1, 3, 2);
    let completedGroups = 0;
    let failedGroups = 0;
    const runningGroups = new Set();
    const groupClips = [];
    const progressDetail = () => {
        const running = Array.from(runningGroups).join(', ');
        const latest = groupClips.length ? `Latest: ${groupClips[groupClips.length - 1]}` : '';
        return [`${completedGroups}/${groups.length} groups complete`, running ? `running ${running}` : '', latest].filter(Boolean).join('; ');
    };
    const heartbeat = createProgressHeartbeat(progress, {
        label: 'Hybrid continuity scan',
        basePercent: 20,
        maxPercent: 82,
        detail: progressDetail,
    });
    progress?.(`Hybrid continuity scan running: ${groups.length} section group(s), ${concurrency} at a time.`, 20);
    const results = await runWithConcurrency(groups, concurrency, async group => {
        runningGroups.add(group.label);
        progress?.(`Hybrid continuity scan: ${completedGroups}/${groups.length} groups complete; scanning ${group.label}.`, Math.min(78, 22 + Math.round((completedGroups / Math.max(1, groups.length)) * 52)));
        const projection = buildContinuityProjectionForSections(stateAtStart, group.sections);
        const systemPrompt = buildContinuityDeltaSystemPrompt({ settings, stateProjection: projection, enabledSections: group.sections, prepass, mode: 'hybrid' });
        const userPrompt = buildHybridContinuityUserPrompt(group, plan);
        try {
            const delta = await requestContinuityDelta(systemPrompt, userPrompt, settings, options, 'hybrid');
            const restricted = restrictDeltaToGroup(delta, group);
            completedGroups++;
            runningGroups.delete(group.label);
            const clip = compactProgressClip(restricted?.summary || Object.keys(restricted?.changes || {}).join(', ') || `No ${group.label} changes`, 160);
            if (clip) groupClips.push(`${group.label}: ${clip}`);
            progress?.(`Hybrid continuity scan: ${completedGroups}/${groups.length} groups complete. ${clip ? `Latest: ${clip}` : ''}`, Math.min(82, 24 + Math.round((completedGroups / Math.max(1, groups.length)) * 55)));
            return { status: 'complete', group, delta: restricted };
        } catch (e) {
            failedGroups++;
            runningGroups.delete(group.label);
            const clip = compactProgressClip(e?.message || String(e || ''), 140);
            if (clip) groupClips.push(`${group.label} failed: ${clip}`);
            progress?.(`Hybrid continuity scan: ${completedGroups}/${groups.length} groups complete; ${failedGroups} failed.`, Math.min(82, 24 + Math.round(((completedGroups + failedGroups) / Math.max(1, groups.length)) * 55)));
            return { status: 'failed_exception', group, delta: null, error: e?.message || String(e || '') };
        }
    });
    heartbeat.stop();
    let delta = mergeReducerDeltas(results);
    if (!delta || !Object.keys(delta.changes || {}).length) delta = inferFallbackDeltaFromPlan(plan, getState()) || delta;
    const failures = results.filter(r => String(r?.status || '').startsWith('failed')).length;
    const scanStatus = failures === groups.length ? 'failed' : failures > 0 ? 'partial' : 'complete';
    if ((!delta || !Object.keys(delta.changes || {}).length) && scanStatus === 'failed') {
        flushContinuityFullCheckpoint(batchId, { status: 'failed', strategy: 'hybrid', reducerFailures: failures, failedAt: Date.now() });
        return { status: 'failed_no_valid_delta', batchId, strategy: 'hybrid', reducerFailures: failures };
    }
    return finalizeContinuityScanDelta({ batchId, delta, plan, settings, options, progress, scanStatus, meta: { strategy: 'hybrid', modelCallCount: groups.length, reducerFailures: failures, prepass } });
}

export async function runContinuityScan(options = {}) {
    const settings = buildEffectiveContinuitySettings(getSettings(), options);
    const validation = validateLoreProviderConfiguration('continuity');
    if (!validation.ok) return { status: 'api_not_configured', error: validation.message };
    markInterruptedContinuityChunks(settings.continuityScanRunningCheckpointStaleMs || 10 * 60 * 1000);

    const stateAtStart = getState();
    const plan = buildContinuityScanPlan(settings, stateAtStart);
    if (!plan.sourceMessageCount || !plan.chunks.length) return { status: 'no_messages', plan };

    const strategy = chooseContinuityScanStrategy(plan, settings, options);
    if (strategy === 'fast') return runFastContinuityDeltaScan({ settings, plan, options, stateAtStart });
    if (strategy === 'hybrid') return runHybridContinuityDeltaScan({ settings, plan, options, stateAtStart });
    return runBulkContinuityScan(options);
}

async function runBulkContinuityScan(options = {}) {
    const settings = buildEffectiveContinuitySettings(getSettings(), options);
    const validation = validateLoreProviderConfiguration('continuity');
    if (!validation.ok) return { status: 'api_not_configured', error: validation.message };
    markInterruptedContinuityChunks(settings.continuityScanRunningCheckpointStaleMs || 10 * 60 * 1000);

    const stateAtStart = getState();
    const plan = buildContinuityScanPlan(settings, stateAtStart);
    if (!plan.sourceMessageCount || !plan.chunks.length) return { status: 'no_messages', plan };

    const queuedChunks = plan.chunks.filter(chunk => shouldQueueChunk(chunk, settings));
    const skippedChunks = plan.chunks.length - queuedChunks.length;
    const batchId = `continuity_${Date.now()}_${stableStringHash(`${plan.contextKey}|${plan.startIndex}|${plan.endIndex}|${plan.chunkSize}|${plan.overlap}`)}`;
    const stateProjection = buildContinuityProjection(stateAtStart);
    const extractionProjection = buildContinuityScanHeaderProjection(stateAtStart);
    const concurrency = clampInt(settings.continuityScanConcurrency, 1, 8, 3);
    const reducerConcurrency = clampInt(settings.continuityScanReducerConcurrency, 1, 6, 3);
    const fullEvery = clampInt(settings.continuityScanFullCheckpointEveryChunks, 1, 25, 5);
    const progress = typeof options.progress === 'function' ? options.progress : null;

    startContinuityBatch({
        id: batchId,
        status: queuedChunks.length ? 'running' : 'complete',
        mode: options.automationSafe ? 'auto-recent' : 'manual',
        scanMode: plan.scanMode,
        startIndex: plan.startIndex,
        endIndex: plan.endIndex,
        sourceMessageCount: plan.sourceMessageCount,
        totalChunks: plan.chunks.length,
        queuedChunks: queuedChunks.length,
        skippedChunks,
        chunkSize: plan.chunkSize,
        overlap: plan.overlap,
        concurrency,
        reducerConcurrency,
        contextKey: plan.contextKey,
    });

    if (!queuedChunks.length) {
        progress?.('Continuity scan skipped unchanged chunks.', 100);
        return { status: 'skipped_unchanged', batchId, plan, skippedChunks };
    }

    let completed = 0;
    let failed = 0;
    let observationCount = 0;
    let dirtySinceFull = 0;
    const observations = [];
    const summaries = [];

    try {
        progress?.(`Continuity scan started: ${queuedChunks.length} chunk(s).`, 5);
        const observationHeartbeat = createProgressHeartbeat(progress, {
            label: 'Continuity observation extraction',
            basePercent: 8,
            maxPercent: 78,
            detail: () => {
                const latest = summaries.length ? `Latest: ${summaries[summaries.length - 1]}` : '';
                return [`${completed + failed}/${queuedChunks.length} chunks complete`, `${observationCount} observations`, latest].filter(Boolean).join('; ');
            },
        });
        const chunkResults = await runWithConcurrency(queuedChunks, concurrency, async chunk => {
            progress?.(`Continuity observations: ${completed + failed}/${queuedChunks.length} chunks complete.`, Math.min(80, 8 + Math.round(((completed + failed) / queuedChunks.length) * 65)));
            const result = await extractChunkObservations({ chunk, plan, batchId, settings, stateProjection: extractionProjection, signal: options.signal });
            if (result.status === 'complete') {
                completed++;
                observations.push(...(result.observations || []));
                observationCount += (result.observations || []).length;
                if (result.summary) summaries.push(result.summary);
                const clip = compactProgressClip(result.summary || `${(result.observations || []).length} observations`, 160);
                progress?.(`Continuity observations: ${completed + failed}/${queuedChunks.length} chunks complete. ${clip ? `Latest: ${clip}` : ''}`, Math.min(80, 10 + Math.round(((completed + failed) / queuedChunks.length) * 65)));
            } else {
                failed++;
                progress?.(`Continuity observations: ${completed + failed}/${queuedChunks.length} chunks complete; ${failed} failed.`, Math.min(80, 10 + Math.round(((completed + failed) / queuedChunks.length) * 65)));
            }
            dirtySinceFull++;
            if (dirtySinceFull >= fullEvery) {
                flushContinuityFullCheckpoint(batchId, { completedChunks: completed, failedChunks: failed, observationCount, lastCheckpointReason: 'chunk_window' });
                dirtySinceFull = 0;
            }
            return result;
        });
        observationHeartbeat.stop();

        flushContinuityFullCheckpoint(batchId, { completedChunks: completed, failedChunks: failed, observationCount, summaries: summaries.slice(-20), stage: 'reducing' });
        progress?.(`Continuity reducers running on ${observationCount} observations.`, 84);

        const enabledGroups = SECTION_GROUPS.filter(group => group.enabled(stateAtStart));
        let completedReducers = 0;
        const reducerClips = [];
        const reducerHeartbeat = createProgressHeartbeat(progress, {
            label: 'Continuity reducers',
            basePercent: 84,
            maxPercent: 96,
            detail: () => {
                const latest = reducerClips.length ? `Latest: ${reducerClips[reducerClips.length - 1]}` : '';
                return [`${completedReducers}/${enabledGroups.length} reducers complete`, latest].filter(Boolean).join('; ');
            },
        });
        const reducerResults = await runWithConcurrency(enabledGroups, reducerConcurrency, async group => {
            const result = await reduceObservationGroup({ group, observations, plan, settings, stateProjection: buildContinuityProjectionForSections(stateAtStart, group.sections), signal: options.signal });
            completedReducers++;
            const clip = compactProgressClip(result?.delta?.summary || result?.error || `${group.label} ${result?.status || 'done'}`, 160);
            if (clip) reducerClips.push(`${group.label}: ${clip}`);
            progress?.(`Continuity reducers: ${completedReducers}/${enabledGroups.length} complete. ${clip ? `Latest: ${clip}` : ''}`, Math.min(96, 84 + Math.round((completedReducers / Math.max(1, enabledGroups.length)) * 10)));
            return result;
        });
        reducerHeartbeat.stop();
        let delta = mergeReducerDeltas(reducerResults);
        if (!delta || !Object.keys(delta.changes || {}).length) {
            delta = inferFallbackDeltaFromPlan(plan, getState());
        }

        const reducerFailures = reducerResults.filter(r => String(r?.status || '').startsWith('failed')).length;
        const status = failed === queuedChunks.length ? 'failed' : failed > 0 || reducerFailures > 0 ? 'partial' : 'complete';
        const hasChanges = !!delta && Object.keys(delta.changes || {}).length > 0;
        flushContinuityFullCheckpoint(batchId, {
            status,
            completedAt: Date.now(),
            completedChunks: completed,
            failedChunks: failed,
            reducerFailures,
            observationCount,
            changeKeys: hasChanges ? Object.keys(delta.changes || {}) : [],
            summaries: summaries.slice(-20),
        });

        if (!hasChanges) {
            progress?.(`Continuity scan complete: ${completed} chunk(s), no state changes.`, 100);
            return { status: status === 'failed' ? 'failed_no_valid_delta' : 'no_changes', batchId, plan, completedChunkCount: completed, failedChunkCount: failed, observationCount, reducerFailures, chunkResults, reducerResults };
        }

        const currentState = getState();
        if (options.applyImmediately || settings.autoApplyDelta) {
            pushStateSnapshot(currentState, `Continuity scan: ${delta.summary || 'state update'}`, settings.maxSnapshots);
            const next = applyDelta(currentState, delta);
            next.lastDelta = null;
            saveState(next, { syncPrompt: true });
            progress?.(`Continuity scan applied: ${Object.keys(delta.changes || {}).join(', ') || 'changes'}.`, 100);
            return { status: 'applied', batchId, delta, summary: delta.summary || '', changeKeys: Object.keys(delta.changes || {}), completedChunkCount: completed, failedChunkCount: failed, observationCount, reducerFailures, scanStatus: status };
        }

        currentState.lastDelta = delta;
        saveState(currentState, { syncPrompt: true });
        progress?.('Continuity scan stored changes for review.', 100);
        return { status: 'pending_review', batchId, delta, summary: delta.summary || '', changeKeys: Object.keys(delta.changes || {}), completedChunkCount: completed, failedChunkCount: failed, observationCount, reducerFailures, scanStatus: status };
    } catch (e) {
        flushContinuityFullCheckpoint(batchId, { status: 'failed', error: e?.message || String(e || ''), failedAt: Date.now(), completedChunks: completed, failedChunks: failed });
        console.error(`${LOG_PREFIX} Checkpointed continuity scan failed:`, e);
        progress?.(`Continuity scan failed: ${e?.message || e}`, 100);
        return { status: 'failed_exception', batchId, error: e?.message || String(e || '') };
    }
}

export const __continuityScanTestHooks = {
    buildContinuityProjection,
    buildContinuityScanPlan,
    parseObservationResponse,
    parseDeltaResponse,
    mergeReducerDeltas,
    compactObservation,
    stableStringHash,
    buildLocalContinuityPrepass,
    chooseContinuityScanStrategy,
    buildContinuityProjectionForSections,
    buildContinuityScanHeaderProjection,
};
