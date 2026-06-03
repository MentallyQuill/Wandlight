/**
 * state-manager.js — Wandlight
 * State CRUD, settings I/O, migration, delta merging, snapshot history, and undo.
 * Reads reacquire from SillyTavern's context, with one-session migration caching so UI clicks do not repeatedly normalize the full lore matrix.
 *
 * Imports: constants.js
 * Imported by: index.js, memo-builder.js, extractor.js, ui.js
 */

import {
    MODULE_KEY,
    LEGACY_MODULE_KEYS,
    DEFAULT_SETTINGS,
    getDefaultState,
    SCHEMA_VERSION,
    LOG_PREFIX,
    AUTOMATION_MODE_VALUES,
    EXPERIENCE_MODE_VALUES,
    BASIC_EXPERIENCE_SETTINGS,
    BASIC_EXPERIENCE_PROFILE_VERSION,
} from './constants.js';
import { normalizeLoreContext, normalizeLoreMatrix, mergeLoreEntries, normalizeLoreEntry, buildLoreGenerationKey, applyLoreLifecycleEvaluation } from './lore-matrix.js';
import { normalizeLoreRelevance, normalizeLoreCanon, normalizeLoreCategory, computeLocalLoreRelevance, normalizeLorePurpose, computeSpecificityScore } from './lore-relevance.js';
import { preprocessPendingLoreEntries } from './pending-lore-preprocessor.js';
import { normalizeLoreTimeline, captureLoreTimelineState, recordLoreTimelineEvent, restoreTimelineEntriesToPending } from './lore-timeline.js';

const MAX_CHAT_STATE_BYTES_BEFORE_AUTO_PERSIST = 200000;
const migratedStateRefs = new WeakSet();

const RETIRED_CONTINUITY_CONFIG_KEYS = ['knowledge', 'secrets', 'relationships', 'flags', 'storyMilestones'];
const ACTIVE_CONTINUITY_CHANGE_KEYS = ['canon', 'scene', 'characters', 'inventory', 'objectives', 'threads'];

function disableRetiredContinuitySections(state) {
    if (!state || typeof state !== 'object') return state;
    if (!state.continuityConfig || typeof state.continuityConfig !== 'object' || Array.isArray(state.continuityConfig)) {
        state.continuityConfig = {};
    }
    for (const key of RETIRED_CONTINUITY_CONFIG_KEYS) {
        state.continuityConfig[key] = false;
    }
    return state;
}


function migrateLoreEntryToRelevance(entry = {}, state = {}) {
    const normalized = normalizeLoreEntry(entry);
    const local = computeLocalLoreRelevance(normalized, state, getSettings());
    const previousState = normalized.lifecycle?.status || normalized.lifecycle?.computedStatus || entry.status || '';
    let relevance = normalizeLoreRelevance(entry.relevance || previousState || local.relevance || 'normal');
    if (!entry.relevance) {
        if (['expired', 'archived', 'muted', 'blocked'].includes(String(previousState || '').toLowerCase())) relevance = 'low';
        else if (['active', 'canon_overdue'].includes(String(previousState || '').toLowerCase())) relevance = local.relevance === 'low' ? 'normal' : local.relevance;
        else relevance = local.relevance || relevance;
    }
    const canon = normalizeLoreCanon(entry.canon || entry.canonStatus || normalized.canon, normalized.source || normalized.sourceInfo?.work || '');
    return normalizeLoreEntry({
        ...normalized,
        relevance,
        canon,
        canonStatus: canon,
        category: normalizeLoreCategory(normalized.category),
        extensions: {
            ...(normalized.extensions || {}),
            relevanceMigration: {
                ...(normalized.extensions?.relevanceMigration || {}),
                migratedAt: Date.now(),
                previousLifecycleStatus: previousState || '',
                localRelevanceScore: local.score || 0,
                temporalRole: local.temporalRole || '',
            },
        },
    });
}

function migrateLoreCollectionsToRelevance(state = {}) {
    if (Array.isArray(state.loreMatrix)) state.loreMatrix = state.loreMatrix.map(entry => migrateLoreEntryToRelevance(entry, state));
    if (Array.isArray(state.pendingLoreEntries)) state.pendingLoreEntries = state.pendingLoreEntries.map(entry => migrateLoreEntryToRelevance(entry, state));
    return state;
}

function ensureTierCompressionStatus(state = {}) {
    const defaults = getDefaultState().loreCompressionStatusByRelevance;
    if (!state.loreCompressionStatusByRelevance || typeof state.loreCompressionStatusByRelevance !== 'object') {
        state.loreCompressionStatusByRelevance = JSON.parse(JSON.stringify(defaults));
    } else {
        state.loreCompressionStatusByRelevance = mergeDefaults(state.loreCompressionStatusByRelevance, defaults);
    }
    for (const tier of ['high', 'normal', 'low']) {
        if (!state.loreCompressionStatusByRelevance[tier] || typeof state.loreCompressionStatusByRelevance[tier] !== 'object') {
            state.loreCompressionStatusByRelevance[tier] = { ...defaults[tier] };
        } else {
            state.loreCompressionStatusByRelevance[tier] = mergeDefaults(state.loreCompressionStatusByRelevance[tier], defaults[tier]);
        }
        normalizeCompressionStatusNumbers(state.loreCompressionStatusByRelevance[tier]);
    }
}



function migrateBucket(container, bucketName = 'storage') {
    if (!container || typeof container !== 'object') return null;
    const current = container[MODULE_KEY];
    if (current && typeof current === 'object') return current;
    for (const legacyKey of LEGACY_MODULE_KEYS || []) {
        const legacy = container[legacyKey];
        if (legacy && typeof legacy === 'object') {
            container[MODULE_KEY] = legacy;
            return legacy;
        }
    }
    container[MODULE_KEY] = {};
    return container[MODULE_KEY];
}

function removeLegacyBuckets(container) {
    if (!container || typeof container !== 'object') return;
    for (const legacyKey of LEGACY_MODULE_KEYS || []) {
        if (legacyKey !== MODULE_KEY && Object.prototype.hasOwnProperty.call(container, legacyKey)) {
            delete container[legacyKey];
        }
    }
}

// ── Settings I/O ────────────────────────────────────────────────────────────────

function normalizeAutomationModeValue(value, fallback = 'manual') {
    return AUTOMATION_MODE_VALUES.includes(value) ? value : fallback;
}

function normalizeExperienceModeValue(value, fallback = 'basic') {
    return EXPERIENCE_MODE_VALUES.includes(value) ? value : fallback;
}

function hasStoredWandlightSettings(stored = {}) {
    return !!(stored && typeof stored === 'object' && Object.keys(stored).length > 0);
}

function applyBasicExperienceProfile(settings) {
    Object.assign(settings, BASIC_EXPERIENCE_SETTINGS);
    settings.experienceMode = 'basic';
    settings.basicExperienceProfileVersion = BASIC_EXPERIENCE_PROFILE_VERSION;
    return settings;
}

/**
 * Reads extensionSettings.wandlight, deep-merges defaults for any
 * missing keys, and returns the live settings object. Always reacquires from
 * SillyTavern.getContext().
 * @returns {Object} WandlightSettings
 */
export function getSettings() {
    const ctx = SillyTavern.getContext();
    if (!ctx || !ctx.extensionSettings) {
        return { ...DEFAULT_SETTINGS };
    }
    const { extensionSettings } = ctx;
    const stored = migrateBucket(extensionSettings, 'extensionSettings') || {};
    // Merge defaults into stored, preserving existing user values. Nested setting
    // registries currently only need a one-level merge.
    const merged = { ...DEFAULT_SETTINGS, ...stored };
    merged.collapsedSections = {
        ...(DEFAULT_SETTINGS.collapsedSections || {}),
        ...(stored.collapsedSections || {}),
    };
    merged.continuitySectionPrompts = {
        ...(DEFAULT_SETTINGS.continuitySectionPrompts || {}),
        ...(stored.continuitySectionPrompts || {}),
    };

    const hasStoredSettings = hasStoredWandlightSettings(stored);
    const legacyAutomationMode = normalizeAutomationModeValue(stored.workflowMode, '');
    merged.automationMode = normalizeAutomationModeValue(stored.automationMode, legacyAutomationMode || DEFAULT_SETTINGS.automationMode || 'manual');
    merged.workflowMode = merged.automationMode;
    if (stored.experienceMode === undefined && hasStoredSettings) {
        merged.experienceMode = 'advanced';
    } else {
        merged.experienceMode = normalizeExperienceModeValue(merged.experienceMode, DEFAULT_SETTINGS.experienceMode || 'basic');
    }
    if (merged.experienceMode === 'basic'
        && Number(stored.basicExperienceProfileVersion || 0) < BASIC_EXPERIENCE_PROFILE_VERSION) {
        applyBasicExperienceProfile(merged);
    }

    // One-time upgrade from the old conservative story-lore generation defaults.
    // Previous builds wrote defaults into user settings, so simply changing
    // DEFAULT_SETTINGS would not affect existing installs that still hold the old
    // 10-message / 2048-token values.
    if (stored.loreBootstrapDefaultsMigrated20260531 !== true) {
        if (stored.loreSourceMessageCount === undefined || Number(stored.loreSourceMessageCount) === 10) {
            merged.loreSourceMessageCount = 40;
        }
        if (stored.loreMaxTokens === undefined || Number(stored.loreMaxTokens) === 2048) {
            merged.loreMaxTokens = 8192;
        }
        merged.loreBootstrapDefaultsMigrated20260531 = true;
    }

    // One-time migration for stricter, less expensive story-lore automation.
    // Older defaults treated generated lore like lightweight continuity and ran
    // too often for roleplay sessions with short turns.
    if (stored.loreAutomationDefaultsMigrated20260602 !== true) {
        if (stored.loreGenerationAutoInterval === undefined || Number(stored.loreGenerationAutoInterval) === 10) {
            merged.loreGenerationAutoInterval = 50;
        }
        if (stored.loreGenerationAutoMinTurns === undefined) {
            merged.loreGenerationAutoMinTurns = 20;
        }
        if (stored.loreGenerationAutoWordThreshold === undefined) {
            merged.loreGenerationAutoWordThreshold = 2500;
        }
        if (stored.loreBulkFactsPerChunk === undefined || Number(stored.loreBulkFactsPerChunk) === 14) {
            merged.loreBulkFactsPerChunk = 8;
        }
        if (stored.loreIncrementalTargetEntries === undefined || Number(stored.loreIncrementalTargetEntries) === 8) {
            merged.loreIncrementalTargetEntries = 5;
        }
        if (stored.loreSimilarityRouting === undefined) {
            merged.loreSimilarityRouting = true;
        }
        if (stored.loreStrictQualityGate === undefined) {
            merged.loreStrictQualityGate = true;
        }
        merged.loreAutomationDefaultsMigrated20260602 = true;
    }

    // One-time prompt-depth default migration for the relevance-tiered injection UI.
    // Preserve user-customized values; only move old defaults one layer closer.
    if (stored.relevancePromptDepthDefaultsMigrated20260602 !== true) {
        const migrateDepth = (key, oldValue, newValue) => {
            if (stored[key] === undefined || Number(stored[key]) === oldValue) merged[key] = newValue;
        };
        migrateDepth('continuityInjectionDepth', 4, 3);
        migrateDepth('loreInjectionDepth', 4, 3);
        migrateDepth('loreHighInjectionDepth', 3, 2);
        migrateDepth('loreNormalInjectionDepth', 6, 5);
        migrateDepth('loreLowInjectionDepth', 10, 9);
        merged.relevancePromptDepthDefaultsMigrated20260602 = true;
    }

    if (merged.autoRelevanceMode === 'off') {
        merged.autoRelevanceEnabled = false;
        merged.autoRelevanceMode = 'suggest';
    }

    // One-time compression-level default migration. Preserve user-customized values;
    // only move old defaults from earlier tier profiles to the new uniform level 3.
    if (stored.compressionLevelDefaultsMigrated20260602 !== true) {
        const migrateLevel = (key, oldValues, newValue = 3) => {
            const current = stored[key];
            if (current === undefined || oldValues.includes(Number(current))) merged[key] = newValue;
        };
        migrateLevel('continuityCompressionLevel', [2]);
        migrateLevel('loreCompressionLevel', [2]);
        migrateLevel('loreHighCompressionLevel', [1]);
        migrateLevel('loreNormalCompressionLevel', [2]);
        migrateLevel('loreLowCompressionLevel', [4]);
        merged.compressionLevelDefaultsMigrated20260602 = true;
    }

    // One-time API/model settings migration. Provider generation parameters are
    // now shown per provider, with matching defaults. Retire fragile OpenAI
    // JSON/proxy toggles from old saved settings so they cannot keep breaking
    // connection tests after the UI no longer exposes them.
    if (stored.providerParameterDefaultsMigrated20260602 !== true) {
        if (stored.continuityTemperature === undefined) merged.continuityTemperature = 0.7;
        if (stored.continuityTopP === undefined) merged.continuityTopP = 0.98;
        if (stored.continuityMaxTokens === undefined || Number(stored.continuityMaxTokens) === 4096) {
            merged.continuityMaxTokens = 8192;
        }
        if (stored.loreTemperature === undefined) merged.loreTemperature = 0.7;
        if (stored.loreTopP === undefined) merged.loreTopP = 0.98;
        if (stored.loreMaxTokens === undefined || Number(stored.loreMaxTokens) === 2048) {
            merged.loreMaxTokens = 8192;
        }
        merged.continuityOpenAIUseJsonMode = false;
        merged.continuityOpenAIUseSTProxy = false;
        merged.loreOpenAIUseJsonMode = false;
        merged.loreOpenAIUseSTProxy = false;
        merged.providerParameterDefaultsMigrated20260602 = true;
    }

    // One-time continuity performance migration. Earlier defaults used a
    // single-call scan for routine recent windows, which looked frozen on slow
    // JSON models. Preserve explicit user changes and move only old defaults.
    if (stored.continuityPerformanceDefaultsMigrated20260603 !== true) {
        if (stored.continuityAutoInterval === undefined || Number(stored.continuityAutoInterval) === 5) {
            merged.continuityAutoInterval = 10;
        }
        if (stored.continuityScanFastThreshold === undefined || Number(stored.continuityScanFastThreshold) === 20) {
            merged.continuityScanFastThreshold = 4;
        }
        merged.continuityPerformanceDefaultsMigrated20260603 = true;
    }

    // Write back merged defaults so the object is complete going forward
    extensionSettings[MODULE_KEY] = merged;
    removeLegacyBuckets(extensionSettings);
    return merged;
}

/**
 * Writes settings to extensionSettings.wandlight and persists
 * via saveSettingsDebounced().
 * @param {Object} settings - WandlightSettings to save
 */
export function saveSettings(settings) {
    const ctx = SillyTavern.getContext();
    if (!ctx || !ctx.extensionSettings) return;
    const { extensionSettings, saveSettingsDebounced } = ctx;
    extensionSettings[MODULE_KEY] = settings;
    removeLegacyBuckets(extensionSettings);
    if (typeof saveSettingsDebounced === 'function') {
        saveSettingsDebounced();
    }
    queuePromptInjectionSync();
}


function queuePromptInjectionSync() {
    try {
        if (typeof globalThis.wandlightSyncPromptInjection === 'function') {
            queueMicrotask(() => {
                try {
                    globalThis.wandlightSyncPromptInjection();
                } catch (e) {
                    console.warn(`${LOG_PREFIX} Failed to sync prompt injection after state/settings save`, e);
                }
            });
        }
    } catch (_) {
        // Never let prompt-sync bookkeeping break persistence.
    }
}

// ── State I/O ───────────────────────────────────────────────────────────────────

/**
 * Reads chatMetadata.wandlight, migrates if needed, merges with
 * defaults, and returns the live state object. Always reacquires from
 * SillyTavern.getContext().
 * @returns {Object} WandlightState
 */
export function getState() {
    const ctx = SillyTavern.getContext();
    if (!ctx || !ctx.chatMetadata) {
        console.warn(`${LOG_PREFIX} chatMetadata not available, returning default state`);
        return getDefaultState();
    }
    const { chatMetadata } = ctx;
    let state = migrateBucket(chatMetadata, 'chatMetadata');
    if (!state || typeof state !== 'object' || Object.keys(state).length === 0) {
        state = getDefaultState();
        chatMetadata[MODULE_KEY] = state;
        removeLegacyBuckets(chatMetadata);
        migratedStateRefs.add(state);
        return state;
    }

    // Fast path: once a state object has been migrated/sanitized in this browser
    // session, do not repeat full migration/normalization on every UI click.
    // saveState() still sanitizes before persistence, and a new chat/state object
    // naturally misses this WeakSet and gets migrated once.
    if (migratedStateRefs.has(state)) {
        return state;
    }

    // Always run migration on first read. If migration/compaction shrinks an oversized
    // Wandlight block, persist immediately so a poisoned chat does not keep
    // rehydrating the same megabyte-scale pending lore payload.
    const beforeSize = safeJsonSize(state);
    state = migrateState(state);
    state = sanitizeLoreArraysForStorage(state);
    // Ensure arrays exist post-migration
    if (!Array.isArray(state.memoHistory)) state.memoHistory = [];
    if (!Array.isArray(state.stateHistory)) state.stateHistory = [];
    if (state.lastDelta === undefined) state.lastDelta = null;
    chatMetadata[MODULE_KEY] = state;
    removeLegacyBuckets(chatMetadata);

    const afterSize = safeJsonSize(state);
    if (typeof ctx.saveMetadata === 'function' && beforeSize > 0 && (afterSize < beforeSize || beforeSize > MAX_CHAT_STATE_BYTES_BEFORE_AUTO_PERSIST)) {
        try {
            ctx.saveMetadata();
        } catch (e) {
            console.warn(`${LOG_PREFIX} Failed to persist compacted Wandlight state on read`, e);
        }
    }

    migratedStateRefs.add(state);
    return state;
}

/**
 * Writes state to chatMetadata.wandlight and persists via saveMetadata().
 * @param {Object} state - WandlightState to save
 */
export function saveState(state, options = {}) {
    const { syncPrompt = true, sanitize = true } = options || {};
    const ctx = SillyTavern.getContext();
    if (!ctx || !ctx.chatMetadata) {
        console.warn(`${LOG_PREFIX} chatMetadata not available, cannot save state`);
        return;
    }
    const { chatMetadata, saveMetadata } = ctx;
    if (!state._version) {
        state._version = SCHEMA_VERSION;
    }
    if (sanitize !== false) {
        state = sanitizeLoreArraysForStorage(state);
    }
    chatMetadata[MODULE_KEY] = state;
    removeLegacyBuckets(chatMetadata);
    migratedStateRefs.add(state);
    if (typeof saveMetadata === 'function') {
        saveMetadata();
    }
    if (syncPrompt !== false) {
        queuePromptInjectionSync();
    }
}

// ── Snapshot History (real state undo) ──────────────────────────────────────────

/**
 * Pushes a full state snapshot onto stateHistory before a mutation.
 * The snapshot is stripped of its own stateHistory to avoid recursive nesting.
 * Also strips memoHistory to keep snapshots compact.
 *
 * @param {Object} state - Current WandlightState (before mutation)
 * @param {string} summary - One-line description of what change is about to occur
 * @param {number} maxSnapshots - Max snapshots to keep (default from settings)
 * @returns {Object} state with snapshot pushed (mutates in place)
 */
export function pushStateSnapshot(state, summary, maxSnapshots) {
    if (!state || typeof state !== 'object') return state;
    if (!Array.isArray(state.stateHistory)) state.stateHistory = [];

    const max = maxSnapshots || DEFAULT_SETTINGS.maxSnapshots;

    // Use structuredClone for full deep copy; fall back to JSON roundtrip
    let snapshotState;
    if (typeof structuredClone === 'function') {
        try {
            snapshotState = structuredClone(state);
        } catch (_e) {
            snapshotState = JSON.parse(JSON.stringify(state));
        }
    } else {
        snapshotState = JSON.parse(JSON.stringify(state));
    }

    // Strip the snapshot of its own history/meta fields to keep it compact.
    // Pending canon database proposals can be large and should never be copied into undo history.
    snapshotState.stateHistory = [];
    snapshotState.memoHistory = [];
    snapshotState.pendingLoreEntries = [];
    snapshotState.pendingLoreMeta = null;
    snapshotState.lastDelta = null;

    const snapshot = {
        timestamp: Date.now(),
        summary: summary || 'Manual edit',
        state: snapshotState,
    };

    state.stateHistory.push(snapshot);

    // Trim to max snapshots
    if (state.stateHistory.length > max) {
        state.stateHistory = state.stateHistory.slice(-max);
    }

    return state;
}

/**
 * Restores the most recent state snapshot from stateHistory.
 * The snapshot's stored state becomes the new live state, and the snapshot
 * is removed from history (undo is destructive — one level per call).
 * Sets lastDelta to null since the change was undone.
 *
 * @param {Object} state - Current WandlightState
 * @returns {{ state: Object, undone: boolean }} New settings and whether undo occurred
 */
export function undoLastChange(state) {
    if (!state || !Array.isArray(state.stateHistory) || state.stateHistory.length === 0) {
        return { state, undone: false };
    }

    // Pop the last snapshot
    const snapshot = state.stateHistory[state.stateHistory.length - 1];
    if (!snapshot || !snapshot.state || typeof snapshot.state !== 'object') {
        // Corrupt snapshot — remove it
        state.stateHistory.pop();
        return { state, undone: false };
    }

    // Restore the snapshot's state
    const restoredState = { ...snapshot.state };

    // Preserve the remaining stateHistory (minus the one we just used)
    restoredState.stateHistory = state.stateHistory.slice(0, -1);
    // Preserve memoHistory from current state if it exists (memo history is independent)
    restoredState.memoHistory = Array.isArray(state.memoHistory) ? [...state.memoHistory] : [];
    restoredState.lastDelta = null;
    restoredState._version = SCHEMA_VERSION;

    // Re-migrate to ensure current schema
    return { state: migrateState(restoredState), undone: true };
}

/**
 * Saves state and also pushes a memo snapshot to memoHistory (for display/debug).
 * NOTE: memoHistory is separate from stateHistory. memoHistory stores memo text
 * for inspection; stateHistory stores full state for undo.
 *
 * @param {Object} state - WandlightState
 * @param {number} maxSnapshots - Max memo snapshots to keep
 */
export function saveStateWithSnapshot(state, maxSnapshots) {
    const ctx = SillyTavern.getContext();
    if (!ctx || !ctx.chatMetadata) return;
    const { chatMetadata, saveMetadata } = ctx;
    if (!state._version) state._version = SCHEMA_VERSION;
    state = sanitizeLoreArraysForStorage(state);

    // Build compact memo snapshot for display history
    if (typeof globalThis._wandlightBuildMemo === 'function') {
        const memo = globalThis._wandlightBuildMemo(state);
        if (memo) {
            if (!Array.isArray(state.memoHistory)) state.memoHistory = [];
            state.memoHistory.push(memo);
            const max = maxSnapshots || DEFAULT_SETTINGS.maxSnapshots;
            if (state.memoHistory.length > max) {
                state.memoHistory = state.memoHistory.slice(-max);
            }
        }
    }

    chatMetadata[MODULE_KEY] = state;
    removeLegacyBuckets(chatMetadata);
    if (typeof saveMetadata === 'function') {
        saveMetadata();
    }
}


// ── Storage safety / recovery helpers ─────────────────────────────────────────

export const MAX_PENDING_LORE_ENTRIES = 300;
const MAX_ACCEPTED_LORE_ENTRIES_FOR_AUTOSANITIZE = 0; // 0 = uncapped; never drop accepted lore during storage sanitization


function safeJsonSize(value) {
    try {
        return JSON.stringify(value || {}).length;
    } catch (_e) {
        return 0;
    }
}

function prePruneStringArray(values, limit = 32, textLimit = 160) {
    const rawValues = Array.isArray(values) ? values : [];
    const seen = new Set();
    const out = [];

    for (const raw of rawValues) {
        const text = truncateText(raw, textLimit).trim();
        if (!text) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(text);
        if (out.length >= limit) break;
    }

    return out;
}

function prePruneLoreEntryForNormalization(entry) {
    if (!entry || typeof entry !== 'object') return entry;

    const pruned = { ...entry };

    if (entry.scope && typeof entry.scope === 'object' && !Array.isArray(entry.scope)) {
        pruned.scope = {
            ...entry.scope,
            characters: prePruneStringArray(entry.scope.characters, 16, 100),
            locations: prePruneStringArray(entry.scope.locations, 12, 100),
            factions: prePruneStringArray(entry.scope.factions, 12, 100),
            topics: prePruneStringArray(entry.scope.topics, 18, 100),
            objects: prePruneStringArray(entry.scope.objects, 12, 100),
            spells: prePruneStringArray(entry.scope.spells, 12, 100),
            schoolYears: prePruneStringArray(entry.scope.schoolYears, 8, 32),
            books: prePruneStringArray(entry.scope.books, 8, 100),
            eras: prePruneStringArray(entry.scope.eras, 8, 100),
        };
    }

    // ActiveWhen is derived/legacy compatibility only. Never preserve massive
    // activeWhen arrays in storage; they can be reconstructed for activation from
    // scope at runtime.
    if (entry.activeWhen && typeof entry.activeWhen === 'object' && !Array.isArray(entry.activeWhen)) {
        pruned.activeWhen = {
            erasAny: prePruneStringArray(entry.activeWhen.erasAny, 8, 100),
            locationsAny: prePruneStringArray(entry.activeWhen.locationsAny, 8, 100),
            charactersPresentAny: prePruneStringArray(entry.activeWhen.charactersPresentAny, 12, 100),
            tagsAny: prePruneStringArray(entry.activeWhen.tagsAny, 12, 100),
        };
    }

    if (entry.content && typeof entry.content === 'object' && !Array.isArray(entry.content)) {
        pruned.content = {
            ...entry.content,
            fact: truncateText(entry.content.fact, 1200),
            injection: truncateText(entry.content.injection, 1200),
            constraints: prePruneStringArray(entry.content.constraints, 8, 260),
            antiLore: prePruneStringArray(entry.content.antiLore, 8, 260),
            notes: truncateText(entry.content.notes, 400),
        };
    }

    pruned.tags = prePruneStringArray(entry.tags, 10, 40);
    const generation = entry.extensions?.wandlightGeneration;
    const relevanceMigration = entry.extensions?.relevanceMigration;
    const autoRelevance = entry.extensions?.autoRelevance;
    const pendingReview = entry.extensions?.wandlightPendingReview;
    const extensions = {};
    if (generation && typeof generation === 'object') {
        extensions.wandlightGeneration = {
            mode: truncateText(generation.mode, 40),
            batchId: truncateText(generation.batchId, 120),
            chunkId: truncateText(generation.chunkId, 180),
            startIndex: Number.isFinite(Number(generation.startIndex)) ? Number(generation.startIndex) : 0,
            endIndex: Number.isFinite(Number(generation.endIndex)) ? Number(generation.endIndex) : 0,
            messageHash: truncateText(generation.messageHash, 32),
            evidenceMessageRefs: prePruneStringArray(generation.evidenceMessageRefs, 20, 32),
            operation: truncateText(generation.operation, 24),
            targetEntryId: truncateText(generation.targetEntryId, 140),
            qualityRoute: truncateText(generation.qualityRoute, 40),
            qualityReason: truncateText(generation.qualityReason, 240),
            similarityRoute: truncateText(generation.similarityRoute, 40),
            similarityReason: truncateText(generation.similarityReason, 240),
            durabilityReason: truncateText(generation.durabilityReason, 240),
            recommendedPin: !!generation.recommendedPin,
            recommendedMute: !!generation.recommendedMute,
            acceptedAsOperation: truncateText(generation.acceptedAsOperation, 24),
            acceptedTargetEntryId: truncateText(generation.acceptedTargetEntryId, 140),
            acceptedAt: Number.isFinite(Number(generation.acceptedAt)) ? Number(generation.acceptedAt) : 0,
            candidateCategory: truncateText(generation.candidateCategory, 60),
            generatedAt: Number.isFinite(Number(generation.generatedAt)) ? Number(generation.generatedAt) : 0,
            targetTotal: Number.isFinite(Number(generation.targetTotal)) ? Number(generation.targetTotal) : 0,
        };
    }
    if (relevanceMigration && typeof relevanceMigration === 'object') extensions.relevanceMigration = {
        migratedAt: Number.isFinite(Number(relevanceMigration.migratedAt)) ? Number(relevanceMigration.migratedAt) : 0,
        previousLifecycleStatus: truncateText(relevanceMigration.previousLifecycleStatus, 40),
        localRelevanceScore: Number.isFinite(Number(relevanceMigration.localRelevanceScore)) ? Number(relevanceMigration.localRelevanceScore) : 0,
        temporalRole: truncateText(relevanceMigration.temporalRole, 40),
    };
    if (autoRelevance && typeof autoRelevance === 'object') extensions.autoRelevance = {
        mode: truncateText(autoRelevance.mode, 20),
        confidence: Number.isFinite(Number(autoRelevance.confidence)) ? Number(autoRelevance.confidence) : 0,
        reason: truncateText(autoRelevance.reason, 240),
        updatedAt: Number.isFinite(Number(autoRelevance.updatedAt)) ? Number(autoRelevance.updatedAt) : 0,
    };
    if (pendingReview && typeof pendingReview === 'object') extensions.wandlightPendingReview = pendingReview;
    pruned.extensions = extensions;
    return pruned;
}

function truncateText(value, limit = 1000) {
    return String(value || '').slice(0, limit);
}

function compactStringArray(values, limit = 12, textLimit = 160) {
    const rawValues = Array.isArray(values) ? values : [];
    const seen = new Set();
    const out = [];

    for (const raw of rawValues) {
        const text = truncateText(raw, textLimit).trim();
        if (!text) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(text);
        if (out.length >= limit) break;
    }

    return out;
}

function compactStringMapForStorage(value, limit = 16, textLimit = 120) {
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const out = {};
    for (const [key, raw] of Object.entries(input).slice(0, limit)) {
        const cleanKey = truncateText(key, textLimit).trim();
        if (!cleanKey) continue;
        out[cleanKey] = truncateText(raw, textLimit).trim() || 'unknown';
    }
    return out;
}


function compactLoreExtensionsForStorage(normalized) {
    const out = {};
    const generation = normalized?.extensions?.wandlightGeneration;
    if (generation && typeof generation === 'object') {
        out.wandlightGeneration = {
            mode: truncateText(generation.mode, 40),
            batchId: truncateText(generation.batchId, 120),
            chunkId: truncateText(generation.chunkId, 180),
            startIndex: Number.isFinite(Number(generation.startIndex)) ? Number(generation.startIndex) : 0,
            endIndex: Number.isFinite(Number(generation.endIndex)) ? Number(generation.endIndex) : 0,
            messageHash: truncateText(generation.messageHash, 32),
            evidenceMessageRefs: compactStringArray(generation.evidenceMessageRefs, 20, 32),
            operation: truncateText(generation.operation, 24),
            targetEntryId: truncateText(generation.targetEntryId, 140),
            qualityRoute: truncateText(generation.qualityRoute, 40),
            qualityReason: truncateText(generation.qualityReason, 240),
            similarityRoute: truncateText(generation.similarityRoute, 40),
            similarityReason: truncateText(generation.similarityReason, 240),
            durabilityReason: truncateText(generation.durabilityReason, 240),
            recommendedPin: !!generation.recommendedPin,
            recommendedMute: !!generation.recommendedMute,
            acceptedAsOperation: truncateText(generation.acceptedAsOperation, 24),
            acceptedTargetEntryId: truncateText(generation.acceptedTargetEntryId, 140),
            acceptedAt: Number.isFinite(Number(generation.acceptedAt)) ? Number(generation.acceptedAt) : 0,
            candidateCategory: truncateText(generation.candidateCategory, 60),
            generatedAt: Number.isFinite(Number(generation.generatedAt)) ? Number(generation.generatedAt) : 0,
            targetTotal: Number.isFinite(Number(generation.targetTotal)) ? Number(generation.targetTotal) : 0,
        };
    }
    const relevanceMigration = normalized?.extensions?.relevanceMigration;
    if (relevanceMigration && typeof relevanceMigration === 'object') out.relevanceMigration = {
        migratedAt: Number.isFinite(Number(relevanceMigration.migratedAt)) ? Number(relevanceMigration.migratedAt) : 0,
        previousLifecycleStatus: truncateText(relevanceMigration.previousLifecycleStatus, 40),
        localRelevanceScore: Number.isFinite(Number(relevanceMigration.localRelevanceScore)) ? Number(relevanceMigration.localRelevanceScore) : 0,
        temporalRole: truncateText(relevanceMigration.temporalRole, 40),
    };
    const autoRelevance = normalized?.extensions?.autoRelevance;
    if (autoRelevance && typeof autoRelevance === 'object') out.autoRelevance = {
        mode: truncateText(autoRelevance.mode, 20),
        confidence: Number.isFinite(Number(autoRelevance.confidence)) ? Number(autoRelevance.confidence) : 0,
        reason: truncateText(autoRelevance.reason, 240),
        updatedAt: Number.isFinite(Number(autoRelevance.updatedAt)) ? Number(autoRelevance.updatedAt) : 0,
    };
    const pendingReview = normalized?.extensions?.wandlightPendingReview;
    if (pendingReview && typeof pendingReview === 'object') out.wandlightPendingReview = pendingReview;
    return Object.keys(out).length ? out : undefined;
}

function compactLoreEntryForStorage(entry) {
    const normalized = normalizeLoreEntry(prePruneLoreEntryForNormalization(entry || {}));
    return {
        schemaVersion: normalized.schemaVersion || 2,
        id: truncateText(normalized.id, 140),
        title: truncateText(normalized.title, 180),
        kind: normalized.kind || 'fact',
        gateType: normalized.gateType || normalized.kind || 'fact',
        category: normalized.category || 'other',
        relevance: normalizeLoreRelevance(normalized.relevance || 'normal'),
        lorePurpose: normalizeLorePurpose(normalized.lorePurpose || normalized.purpose, normalized),
        specificityScore: Number.isFinite(Number(normalized.specificityScore)) ? Math.max(0, Math.min(100, Number(normalized.specificityScore))) : computeSpecificityScore(normalized),
        injectableByDefault: normalized.injectableByDefault !== false,
        canon: normalizeLoreCanon(normalized.canon || normalized.canonStatus, normalized.source || normalized.sourceInfo?.work || ''),
        canonStatus: normalizeLoreCanon(normalized.canon || normalized.canonStatus, normalized.source || normalized.sourceInfo?.work || ''),
        truthStatus: normalized.truthStatus || 'true',
        revealPolicy: normalized.revealPolicy || 'private',
        tags: compactStringArray(normalized.tags, 10, 40),
        priority: Number.isFinite(Number(normalized.priority)) ? Number(normalized.priority) : 50,
        status: normalized.status || 'active',
        protected: !!normalized.protected,
        locked: !!normalized.locked,
        userEditable: normalized.userEditable !== false,
        userEdited: !!normalized.userEdited,
        branchId: truncateText(normalized.branchId, 100) || 'main',
        date: {
            validFrom: truncateText(normalized.date?.validFrom || normalized.validFrom, 32),
            validTo: truncateText(normalized.date?.validTo || normalized.validTo, 32),
            precision: truncateText(normalized.date?.precision, 32),
            schoolYear: normalized.date?.schoolYear ?? null,
            book: truncateText(normalized.date?.book, 100),
            era: truncateText(normalized.date?.era, 100),
            label: truncateText(normalized.date?.label, 140),
        },
        canonTiming: {
            canonExpectedFrom: truncateText(normalized.canonTiming?.canonExpectedFrom, 32),
            canonExpectedUntil: truncateText(normalized.canonTiming?.canonExpectedUntil, 32),
            hardValidFrom: truncateText(normalized.canonTiming?.hardValidFrom, 32),
            hardValidTo: truncateText(normalized.canonTiming?.hardValidTo, 32),
            precision: truncateText(normalized.canonTiming?.precision, 32),
            schoolYear: normalized.canonTiming?.schoolYear ?? null,
            book: truncateText(normalized.canonTiming?.book, 100),
            label: truncateText(normalized.canonTiming?.label, 140),
        },
        activation: {
            requiresEvents: compactStringArray(normalized.activation?.requiresEvents, 10, 100),
            requiresMissingEvents: compactStringArray(normalized.activation?.requiresMissingEvents, 10, 100),
            requiresCharacters: compactStringArray(normalized.activation?.requiresCharacters, 10, 100),
            requiresLocation: compactStringArray(normalized.activation?.requiresLocation, 5, 100),
            requiresTopics: compactStringArray(normalized.activation?.requiresTopics, 10, 100),
            requiresCanonStrictness: truncateText(normalized.activation?.requiresCanonStrictness, 32),
        },
        expiration: {
            expiresWhenEventsHappen: compactStringArray(normalized.expiration?.expiresWhenEventsHappen, 10, 100),
            expiresWhenEntriesActive: compactStringArray(normalized.expiration?.expiresWhenEntriesActive, 10, 100),
            autoMuteOnExpire: normalized.expiration?.autoMuteOnExpire !== false,
        },
        lifecycle: {
            status: truncateText(normalized.lifecycle?.status, 32),
            computedStatus: truncateText(normalized.lifecycle?.computedStatus, 32),
            manualOverride: !!normalized.lifecycle?.manualOverride,
            expired: !!normalized.lifecycle?.expired,
            expiredAt: truncateText(normalized.lifecycle?.expiredAt, 32),
            expiredReason: truncateText(normalized.lifecycle?.expiredReason, 200),
            autoMutedOnExpire: !!normalized.lifecycle?.autoMutedOnExpire,
            lastEvaluatedAt: Number.isFinite(Number(normalized.lifecycle?.lastEvaluatedAt)) ? Number(normalized.lifecycle.lastEvaluatedAt) : 0,
            lastEvaluatedDate: truncateText(normalized.lifecycle?.lastEvaluatedDate, 32),
            reason: truncateText(normalized.lifecycle?.reason, 200),
        },
        scope: {
            characters: compactStringArray(normalized.scope?.characters, 12, 100),
            locations: compactStringArray(normalized.scope?.locations, 10, 100),
            factions: compactStringArray(normalized.scope?.factions, 10, 100),
            topics: compactStringArray(normalized.scope?.topics, 14, 100),
            objects: compactStringArray(normalized.scope?.objects, 10, 100),
            spells: compactStringArray(normalized.scope?.spells, 10, 100),
            schoolYears: compactStringArray(normalized.scope?.schoolYears, 8, 32),
            books: compactStringArray(normalized.scope?.books, 8, 100),
            eras: compactStringArray(normalized.scope?.eras, 8, 100),
        },
        visibility: {
            publicFrom: truncateText(normalized.visibility?.publicFrom, 32),
            secretUntil: truncateText(normalized.visibility?.secretUntil, 32),
            knownBy: compactStringMapForStorage(normalized.visibility?.knownBy, 16, 120),
            notKnownByBefore: compactStringMapForStorage(normalized.visibility?.notKnownByBefore, 16, 120),
            suspectedBy: compactStringMapForStorage(normalized.visibility?.suspectedBy, 12, 120),
        },
        content: {
            fact: truncateText(normalized.content?.fact || normalized.fact, 1200),
            injection: truncateText(normalized.content?.injection, 1200),
            constraints: compactStringArray(normalized.content?.constraints, 8, 260),
            antiLore: compactStringArray(normalized.content?.antiLore, 8, 260),
            publicVersion: truncateText(normalized.content?.publicVersion, 500),
            notes: truncateText(normalized.content?.notes || normalized.notes, 600),
        },
        fact: truncateText(normalized.fact || normalized.content?.fact, 1200),
        source: typeof normalized.source === 'string' ? truncateText(normalized.source, 180) : 'wandlight',
        sourceInfo: {
            work: truncateText(normalized.sourceInfo?.work, 100),
            book: truncateText(normalized.sourceInfo?.book, 100),
            chapter: truncateText(normalized.sourceInfo?.chapter, 100),
            confidence: normalized.sourceInfo?.confidence,
        },
        extensions: compactLoreExtensionsForStorage(normalized),
    };
}

function compactCompressionStatusForStorage(status) {
    if (!status || typeof status !== 'object' || Array.isArray(status)) return status;
    const out = { ...status };
    const signature = typeof out.lastSignature === 'string' ? out.lastSignature : '';
    if (signature.length > 1200 || signature.includes('"directText"')) {
        out.lastSignature = '';
    }
    return out;
}

function sanitizeCompressionStatusesForStorage(state) {
    if (!state || typeof state !== 'object') return state;
    state.continuityCompressionStatus = compactCompressionStatusForStorage(state.continuityCompressionStatus || {});
    state.loreCompressionStatus = compactCompressionStatusForStorage(state.loreCompressionStatus || {});
    if (state.loreCompressionStatusByRelevance && typeof state.loreCompressionStatusByRelevance === 'object' && !Array.isArray(state.loreCompressionStatusByRelevance)) {
        state.loreCompressionStatusByRelevance = Object.fromEntries(
            Object.entries(state.loreCompressionStatusByRelevance)
                .map(([tier, status]) => [tier, compactCompressionStatusForStorage(status || {})])
        );
    }
    return state;
}

function sanitizeLoreArraysForStorage(state) {
    if (!state || typeof state !== 'object') return state;
    sanitizeCompressionStatusesForStorage(state);

    if (Array.isArray(state.pendingLoreEntries)) {
        state.pendingLoreEntries = state.pendingLoreEntries
            .slice(0, MAX_PENDING_LORE_ENTRIES)
            .map(compactLoreEntryForStorage);
    } else {
        state.pendingLoreEntries = [];
    }

    if (Array.isArray(state.loreMatrix)) {
        if (!state.loreSelection || typeof state.loreSelection !== 'object') state.loreSelection = { pinnedIds: [], suppressedIds: [] };
        state.loreSelection.suppressedIds = Array.isArray(state.loreSelection.suppressedIds) ? state.loreSelection.suppressedIds : [];
        const suppressedSet = new Set(state.loreSelection.suppressedIds);
        const cap = Number(MAX_ACCEPTED_LORE_ENTRIES_FOR_AUTOSANITIZE) || 0;
        const limited = cap > 0 && state.loreMatrix.length > cap
            ? state.loreMatrix.slice(-cap)
            : state.loreMatrix;
        state.loreMatrix = limited.map(raw => {
            // Relevance-tier architecture: lifecycle/date evaluation may add review
            // metadata, but it must not secretly mutate mute/injection state. Mute is
            // the only hard injection exclusion control.
            let evaluated = raw;
            try { evaluated = applyLoreLifecycleEvaluation(raw, state); } catch (_) { evaluated = raw; }
            return compactLoreEntryForStorage(evaluated);
        });
        state.loreSelection.suppressedIds = Array.from(suppressedSet);
    } else {
        state.loreMatrix = [];
    }

    if (Array.isArray(state.stateHistory)) {
        state.stateHistory = state.stateHistory.slice(-Math.max(0, Number(getSettings().maxSnapshots) || DEFAULT_SETTINGS.maxSnapshots || 5)).map(snapshot => {
            if (!snapshot || typeof snapshot !== 'object') return snapshot;
            if (snapshot.state && typeof snapshot.state === 'object') {
                snapshot.state.pendingLoreEntries = [];
                if (Array.isArray(snapshot.state.loreMatrix) && snapshot.state.loreMatrix.length > 200) {
                    snapshot.state.loreMatrix = snapshot.state.loreMatrix.slice(-200).map(entry => {
                        const source = typeof entry?.source === 'string' ? entry.source : '';
                        return source.includes('canon-lore-db') ? compactLoreEntryForStorage(entry) : entry;
                    });
                }
                snapshot.state.stateHistory = [];
                snapshot.state.memoHistory = [];
            }
            return snapshot;
        });
    }

    state.loreTimeline = normalizeLoreTimeline(state.loreTimeline || {});

    if (state.pendingLoreEntries.length === 0) {
        state.pendingLoreMeta = null;
    }

    if (Array.isArray(state.autoRelevanceSuggestions)) {
        state.autoRelevanceSuggestions = state.autoRelevanceSuggestions.slice(0, 100).map(s => ({
            id: truncateText(s?.id, 140),
            title: truncateText(s?.title, 180),
            currentRelevance: truncateText(s?.currentRelevance, 20),
            suggestedRelevance: truncateText(s?.suggestedRelevance, 20),
            confidence: Number.isFinite(Number(s?.confidence)) ? Number(s.confidence) : 0,
            score: Number.isFinite(Number(s?.score)) ? Number(s.score) : 0,
            temporalRole: truncateText(s?.temporalRole, 40),
            source: truncateText(s?.source, 20),
            reason: truncateText(s?.reason, 240),
            suggestedAt: Number.isFinite(Number(s?.suggestedAt)) ? Number(s.suggestedAt) : 0,
        })).filter(s => s.id && s.suggestedRelevance);
    } else {
        state.autoRelevanceSuggestions = [];
    }

    return state;
}

// ── State migration ─────────────────────────────────────────────────────────────

/**
 * Checks _version and applies migration steps to bring old state objects
 * forward to the current schema version.
 * @param {Object} state - Raw state from storage (may be any schema version)
 * @returns {Object} Migrated WandlightState
 */
export function migrateState(state) {
    const defaults = getDefaultState();
    if (!state || typeof state !== 'object') {
        return defaults;
    }

    // Version 0 (no _version) → Version 1
    if (!state._version || state._version < 1) {
        // Ensure canon block exists
        if (!state.canon) state.canon = { ...defaults.canon };
        else {
            state.canon.era = state.canon.era || '';
            state.canon.inUniverseDate = state.canon.inUniverseDate || '';
            state.canon.canonBoundary = state.canon.canonBoundary || '';
            if (!Array.isArray(state.canon.divergences)) state.canon.divergences = [];
        }

        // Ensure scene block exists
        if (!state.scene) state.scene = { ...defaults.scene };
        else {
            state.scene.location = state.scene.location || '';
            state.scene.timeOfDay = state.scene.timeOfDay || '';
            state.scene.weather = state.scene.weather || '';
            if (!Array.isArray(state.scene.presentCharacters)) state.scene.presentCharacters = [];
            if (!Array.isArray(state.scene.nearbyCharacters)) state.scene.nearbyCharacters = [];
            state.scene.currentActivity = state.scene.currentActivity || '';
        }

        // Ensure knowledge exists
        if (!state.knowledge || typeof state.knowledge !== 'object' || Array.isArray(state.knowledge)) {
            state.knowledge = {};
        }

        // Ensure arrays exist
        if (!Array.isArray(state.secrets)) state.secrets = [];
        if (!Array.isArray(state.relationships)) state.relationships = [];
        if (!Array.isArray(state.threads)) state.threads = [];
        if (!Array.isArray(state.continuityFlags)) state.continuityFlags = [];
        if (!Array.isArray(state.memoHistory)) state.memoHistory = [];
        if (!Array.isArray(state.stateHistory)) state.stateHistory = [];
        if (state.lastDelta === undefined) state.lastDelta = null;

        state._version = 1;
    }

    // Future migration: ensure stateHistory always exists even in v1
    if (!Array.isArray(state.stateHistory)) {
        state.stateHistory = [];
    }

    // ── Schema v1 → v2: Lore Matrix migration ───────────────────────────────
    if (state._version < 2) {
        const defaults = getDefaultState();

        // Add loreContext if missing
        state.loreContext = normalizeLoreContext(state.loreContext || {});
        if (!state.loreContext.sceneDate && state.canon?.inUniverseDate) {
            state.loreContext.sceneDate = state.canon.inUniverseDate;
        }
        if (!state.loreContext.canonBoundary && state.canon?.canonBoundary) {
            state.loreContext.canonBoundary = state.canon.canonBoundary;
        }

        // Add loreMatrix if missing
        if (!Array.isArray(state.loreMatrix)) {
            state.loreMatrix = [];
        } else {
            state.loreMatrix = normalizeLoreMatrix(state.loreMatrix);
        }

        // Add pendingLoreEntries if missing
        if (!Array.isArray(state.pendingLoreEntries)) {
            state.pendingLoreEntries = [];
        } else {
            state.pendingLoreEntries = normalizeLoreMatrix(state.pendingLoreEntries);
        }

        state._version = 2;
    }

    // ── Schema v2 → v3: Lore generation lifecycle ledger ───────────────────
    if (state._version < 3) {
        const defaults = getDefaultState();

        // Add loreGeneration ledger if missing
        if (!state.loreGeneration || typeof state.loreGeneration !== 'object') {
            state.loreGeneration = { ...defaults.loreGeneration };
        } else {
            state.loreGeneration.lastAttemptedFor = state.loreGeneration.lastAttemptedFor || '';
            state.loreGeneration.lastProposedFor = state.loreGeneration.lastProposedFor || '';
            state.loreGeneration.lastAcceptedFor = state.loreGeneration.lastAcceptedFor || '';
            state.loreGeneration.lastRejectedFor = state.loreGeneration.lastRejectedFor || '';
            state.loreGeneration.lastFailedFor = state.loreGeneration.lastFailedFor || '';
            if (!state.loreGeneration.attempts || typeof state.loreGeneration.attempts !== 'object') {
                state.loreGeneration.attempts = {};
            }
        }

        // Add pendingLoreMeta if missing (preserve existing null)
        if (state.pendingLoreMeta === undefined) {
            state.pendingLoreMeta = null;
        } else if (state.pendingLoreMeta && typeof state.pendingLoreMeta !== 'object') {
            state.pendingLoreMeta = null;
        } else if (state.pendingLoreMeta && state.pendingLoreEntries?.length === 0) {
            // Stale metadata with no actual pending entries — clean up
            state.pendingLoreMeta = null;
        }

        state._version = 3;
    }

    // ── Schema v4: lore panel UI state and lore selection ────────────────────
    if (state._version < 4) {
        const defaults = getDefaultState();
        state.lorePanel = mergeDefaults(state.lorePanel, defaults.lorePanel);
        state.loreSelection = mergeDefaults(state.loreSelection, defaults.loreSelection);
        state._version = 4;
    }

    // ── Schema v5: expanded editable continuity state and split injection preview ─────────
    if (state._version < 5) {
        const defaults = getDefaultState();
        state.continuityConfig = { ...defaults.continuityConfig, ...(state.continuityConfig || {}) };
        state.characters = Array.isArray(state.characters) ? state.characters : [];
        state.inventory = Array.isArray(state.inventory) ? state.inventory : [];
        state.objectives = Array.isArray(state.objectives) ? state.objectives : [];
        state.continuityCompressionStatus = state.continuityCompressionStatus || defaults.continuityCompressionStatus;
        state._version = 5;
    }

    // ── Schema v7: local canon lore database status ─────────────────────────
    if (state._version < 7) {
        const defaults = getDefaultState();
        state.canonLoreDatabase = mergeDefaults(state.canonLoreDatabase, defaults.canonLoreDatabase);
        state._version = 7;
    }

    // ── Schema v8: resumable bulk lore scan ledger ─────────────────────────
    if (state._version < 8) {
        const defaults = getDefaultState();
        state.loreBulkGeneration = mergeDefaults(state.loreBulkGeneration, defaults.loreBulkGeneration);
        state._version = 8;
    }

    // ── Schema v9: resumable checkpointed continuity scan ledger ───────────
    if (state._version < 9) {
        const defaults = getDefaultState();
        state.continuityScan = mergeDefaults(state.continuityScan, defaults.continuityScan);
        state._version = 9;
    }

    // ── Schema v10: streamlined live continuity sections ─────────────────────
    if (state._version < 10) {
        disableRetiredContinuitySections(state);
        state._version = 10;
    }

    // ── Schema v12: relevance-tiered lore injection and simplified Canon/AU metadata ──
    if (state._version < 12) {
        migrateLoreCollectionsToRelevance(state);
        ensureTierCompressionStatus(state);
        state._version = 12;
    }

    // ── Schema v13: Auto-Relevance suggestions and no lifecycle-driven auto-mute ──
    if (state._version < 13) {
        state.autoRelevanceSuggestions = Array.isArray(state.autoRelevanceSuggestions) ? state.autoRelevanceSuggestions : [];
        state.autoRelevanceLastRun = state.autoRelevanceLastRun || null;
        if (Array.isArray(state.loreMatrix)) {
            state.loreMatrix = state.loreMatrix.map(entry => ({
                ...entry,
                lifecycle: {
                    ...(entry.lifecycle || {}),
                    autoMutedOnExpire: false,
                },
            }));
        }
        state._version = 13;
    }

    // ── Schema v14: Auto-Relevance model adjudication and per-suggestion review ──
    if (state._version < 14) {
        state.autoRelevanceSuggestions = Array.isArray(state.autoRelevanceSuggestions) ? state.autoRelevanceSuggestions.map(s => ({
            ...s,
            source: s.source || 'local',
        })) : [];
        state.autoRelevanceLastRun = state.autoRelevanceLastRun || null;
        state._version = 14;
    }

    // ── Schema v15: strict specific-lore purpose metadata ───────────────────
    if (state._version < 15) {
        if (Array.isArray(state.loreMatrix)) {
            state.loreMatrix = state.loreMatrix.map(entry => ({
                ...entry,
                lorePurpose: normalizeLorePurpose(entry?.lorePurpose || entry?.purpose, entry),
                specificityScore: Number.isFinite(Number(entry?.specificityScore)) ? Math.max(0, Math.min(100, Number(entry.specificityScore))) : computeSpecificityScore(entry),
                injectableByDefault: entry?.injectableByDefault !== false,
            }));
        }
        if (Array.isArray(state.pendingLoreEntries)) {
            state.pendingLoreEntries = state.pendingLoreEntries.map(entry => ({
                ...entry,
                lorePurpose: normalizeLorePurpose(entry?.lorePurpose || entry?.purpose, entry),
                specificityScore: Number.isFinite(Number(entry?.specificityScore)) ? Math.max(0, Math.min(100, Number(entry.specificityScore))) : computeSpecificityScore(entry),
                injectableByDefault: entry?.injectableByDefault !== false,
            }));
        }
        state._version = 15;
    }

    // ── Schema v16: runtime rail + anchored drawer layout ────────────────
    if (state._version < 16) {
        const defaults = getDefaultState();
        const previousPanel = state.lorePanel && typeof state.lorePanel === 'object' ? { ...state.lorePanel } : {};
        const hadDrawerOpen = Object.prototype.hasOwnProperty.call(previousPanel, 'drawerOpen');
        state.lorePanel = mergeDefaults(previousPanel, defaults.lorePanel);
        state.lorePanel.railMode = previousPanel.railMode === 'expanded' ? 'expanded' : defaults.lorePanel.railMode;
        state.lorePanel.drawerOpen = hadDrawerOpen ? previousPanel.drawerOpen === true : previousPanel.collapsed !== true;
        state.lorePanel.collapsed = state.lorePanel.drawerOpen !== true;
        state.lorePanel.railX = Number.isFinite(Number(previousPanel.railX)) ? Number(previousPanel.railX) : (Number.isFinite(Number(previousPanel.x)) ? Number(previousPanel.x) : defaults.lorePanel.railX);
        state.lorePanel.railY = Number.isFinite(Number(previousPanel.railY)) ? Number(previousPanel.railY) : (Number.isFinite(Number(previousPanel.y)) ? Number(previousPanel.y) : defaults.lorePanel.railY);
        state.lorePanel.drawerWidth = Number.isFinite(Number(previousPanel.drawerWidth)) ? Number(previousPanel.drawerWidth) : (Number.isFinite(Number(previousPanel.width)) ? Number(previousPanel.width) : defaults.lorePanel.drawerWidth);
        state.lorePanel.drawerHeight = Number.isFinite(Number(previousPanel.drawerHeight)) ? Number(previousPanel.drawerHeight) : (Number.isFinite(Number(previousPanel.height)) ? Number(previousPanel.height) : defaults.lorePanel.drawerHeight);
        state.lorePanel.drawerDirection = ['auto', 'right', 'left'].includes(previousPanel.drawerDirection) ? previousPanel.drawerDirection : defaults.lorePanel.drawerDirection;
        state.lorePanel.x = state.lorePanel.railX;
        state.lorePanel.y = state.lorePanel.railY;
        state.lorePanel.width = state.lorePanel.drawerWidth;
        state.lorePanel.height = state.lorePanel.drawerHeight;
        state._version = 16;
    }

    // Schema v18: lore event timeline replaces visible full-state history for lore recovery
    if (state._version < 18) {
        state.loreTimeline = normalizeLoreTimeline(state.loreTimeline || getDefaultState().loreTimeline);
        state._version = 18;
    }

    // ── Always normalize lore fields post-migration ────────────────────────
    // First compact known-heavy canon DB payloads and oversized pending batches so
    // a poisoned chat can recover instead of freezing during panel render/save.
    sanitizeLoreArraysForStorage(state);
    // Even v4 states can become malformed through manual editing or old imports.
    state.loreContext = normalizeLoreContext(state.loreContext || {});
    state.loreMatrix = normalizeLoreMatrix(state.loreMatrix || []);
    state.pendingLoreEntries = normalizeLoreMatrix(state.pendingLoreEntries || []);
    state.loreTimeline = normalizeLoreTimeline(state.loreTimeline || {});
    sanitizeLoreArraysForStorage(state);

    normalizeContinuityStructure(state);

    if (!state.loreCompressionStatus || typeof state.loreCompressionStatus !== 'object') {
        state.loreCompressionStatus = getDefaultState().loreCompressionStatus;
    } else {
        const defaults = getDefaultState().loreCompressionStatus;
        state.loreCompressionStatus = mergeDefaults(state.loreCompressionStatus, defaults);
        normalizeCompressionStatusNumbers(state.loreCompressionStatus);
    }
    ensureTierCompressionStatus(state);

    // Normalize lorePanel
    if (!state.lorePanel || typeof state.lorePanel !== 'object') {
        state.lorePanel = getDefaultState().lorePanel;
    } else {
        const defaultsPanel = getDefaultState().lorePanel;
        state.lorePanel.isOpen = state.lorePanel.isOpen !== false;
        state.lorePanel.railMode = state.lorePanel.railMode === 'expanded' ? 'expanded' : 'compact';
        state.lorePanel.drawerOpen = state.lorePanel.drawerOpen === true;
        state.lorePanel.collapsed = state.lorePanel.drawerOpen !== true;
        state.lorePanel.drawerDirection = ['auto', 'right', 'left'].includes(state.lorePanel.drawerDirection) ? state.lorePanel.drawerDirection : 'auto';
        state.lorePanel.railX = Number.isFinite(Number(state.lorePanel.railX)) ? Number(state.lorePanel.railX) : (Number.isFinite(Number(state.lorePanel.x)) ? Number(state.lorePanel.x) : defaultsPanel.railX);
        state.lorePanel.railY = Number.isFinite(Number(state.lorePanel.railY)) ? Number(state.lorePanel.railY) : (Number.isFinite(Number(state.lorePanel.y)) ? Number(state.lorePanel.y) : defaultsPanel.railY);
        state.lorePanel.drawerWidth = Number.isFinite(Number(state.lorePanel.drawerWidth)) && Number(state.lorePanel.drawerWidth) >= 320 ? Number(state.lorePanel.drawerWidth) : (Number.isFinite(Number(state.lorePanel.width)) ? Number(state.lorePanel.width) : defaultsPanel.drawerWidth);
        state.lorePanel.drawerHeight = Number.isFinite(Number(state.lorePanel.drawerHeight)) && Number(state.lorePanel.drawerHeight) >= 260 ? Number(state.lorePanel.drawerHeight) : (Number.isFinite(Number(state.lorePanel.height)) ? Number(state.lorePanel.height) : defaultsPanel.drawerHeight);
        state.lorePanel.selectedCategory = state.lorePanel.selectedCategory || 'all';
        state.lorePanel.search = state.lorePanel.search || '';
        state.lorePanel.selectedEntryId = state.lorePanel.selectedEntryId || '';
        state.lorePanel.activeTab = ['session', 'continuity', 'context', 'lore', 'injection'].includes(state.lorePanel.activeTab)
            ? state.lorePanel.activeTab
            : (state.lorePanel.activeTab === 'generate' ? 'context' : (state.lorePanel.activeTab === 'review' ? 'lore' : 'session'));
        state.lorePanel.reviewSelectedIds = Array.isArray(state.lorePanel.reviewSelectedIds) ? state.lorePanel.reviewSelectedIds : [];
        state.lorePanel.generationStatus = typeof state.lorePanel.generationStatus === 'string' ? state.lorePanel.generationStatus : 'Idle.';
        state.lorePanel.generationProgress = Number.isFinite(Number(state.lorePanel.generationProgress)) ? Number(state.lorePanel.generationProgress) : 0;
        for (const key of ['context', 'continuity', 'lore']) {
            const statusKey = `${key}Status`;
            const progressKey = `${key}Progress`;
            state.lorePanel[statusKey] = typeof state.lorePanel[statusKey] === 'string'
                ? state.lorePanel[statusKey]
                : (key === 'lore' ? state.lorePanel.generationStatus : 'Idle.');
            state.lorePanel[progressKey] = Number.isFinite(Number(state.lorePanel[progressKey]))
                ? Number(state.lorePanel[progressKey])
                : (key === 'lore' ? Number(state.lorePanel.generationProgress || 0) : 0);
        }
        state.lorePanel.showOnlyActive = false;
        state.lorePanel.pendingReviewVisibleLimit = Number.isFinite(Number(state.lorePanel.pendingReviewVisibleLimit))
            ? Math.max(5, Math.min(1000, Number(state.lorePanel.pendingReviewVisibleLimit)))
            : getDefaultState().lorePanel.pendingReviewVisibleLimit;
        state.lorePanel.width = Number.isFinite(Number(state.lorePanel.width)) && Number(state.lorePanel.width) >= 320 ? Number(state.lorePanel.width) : state.lorePanel.drawerWidth;
        state.lorePanel.height = Number.isFinite(Number(state.lorePanel.height)) && Number(state.lorePanel.height) >= 260 ? Number(state.lorePanel.height) : state.lorePanel.drawerHeight;
        state.lorePanel.x = Number.isFinite(Number(state.lorePanel.x)) ? Number(state.lorePanel.x) : state.lorePanel.railX;
        state.lorePanel.y = Number.isFinite(Number(state.lorePanel.y)) ? Number(state.lorePanel.y) : state.lorePanel.railY;
    }

    // Normalize loreSelection
    if (!state.loreSelection || typeof state.loreSelection !== 'object') {
        state.loreSelection = getDefaultState().loreSelection;
    } else {
        state.loreSelection.pinnedIds = Array.isArray(state.loreSelection.pinnedIds) ? state.loreSelection.pinnedIds : [];
        state.loreSelection.suppressedIds = Array.isArray(state.loreSelection.suppressedIds) ? state.loreSelection.suppressedIds : [];
    }

    if (!state.canonLoreDatabase || typeof state.canonLoreDatabase !== 'object' || Array.isArray(state.canonLoreDatabase)) {
        state.canonLoreDatabase = getDefaultState().canonLoreDatabase;
    } else {
        state.canonLoreDatabase = mergeDefaults(state.canonLoreDatabase, getDefaultState().canonLoreDatabase);
        state.canonLoreDatabase.lastQueriedAt = Number.isFinite(Number(state.canonLoreDatabase.lastQueriedAt)) ? Number(state.canonLoreDatabase.lastQueriedAt) : 0;
        state.canonLoreDatabase.lastMatchedCount = Number.isFinite(Number(state.canonLoreDatabase.lastMatchedCount)) ? Number(state.canonLoreDatabase.lastMatchedCount) : 0;
        state.canonLoreDatabase.lastProposedCount = Number.isFinite(Number(state.canonLoreDatabase.lastProposedCount)) ? Number(state.canonLoreDatabase.lastProposedCount) : 0;
    }

    // Ensure ledger always has a valid structure
    if (!state.loreGeneration || typeof state.loreGeneration !== 'object') {
        state.loreGeneration = getDefaultState().loreGeneration;
    }
    if (typeof state.loreGeneration.attempts !== 'object' || Array.isArray(state.loreGeneration.attempts)) {
        state.loreGeneration.attempts = {};
    }

    if (!state.loreBulkGeneration || typeof state.loreBulkGeneration !== 'object' || Array.isArray(state.loreBulkGeneration)) {
        state.loreBulkGeneration = getDefaultState().loreBulkGeneration;
    } else {
        const defaults = getDefaultState().loreBulkGeneration;
        state.loreBulkGeneration = mergeDefaults(state.loreBulkGeneration, defaults);
        for (const key of ['batches', 'chunks', 'candidates']) {
            if (!state.loreBulkGeneration[key] || typeof state.loreBulkGeneration[key] !== 'object' || Array.isArray(state.loreBulkGeneration[key])) {
                state.loreBulkGeneration[key] = {};
            }
        }
        state.loreBulkGeneration.activeBatchId = String(state.loreBulkGeneration.activeBatchId || '');
        state.loreBulkGeneration.lastBatchId = String(state.loreBulkGeneration.lastBatchId || '');
    }


    if (!state.continuityScan || typeof state.continuityScan !== 'object' || Array.isArray(state.continuityScan)) {
        state.continuityScan = getDefaultState().continuityScan;
    } else {
        const defaults = getDefaultState().continuityScan;
        state.continuityScan = mergeDefaults(state.continuityScan, defaults);
        for (const key of ['batches', 'chunks', 'observations']) {
            if (!state.continuityScan[key] || typeof state.continuityScan[key] !== 'object' || Array.isArray(state.continuityScan[key])) {
                state.continuityScan[key] = {};
            }
        }
        state.continuityScan.activeBatchId = String(state.continuityScan.activeBatchId || '');
        state.continuityScan.lastBatchId = String(state.continuityScan.lastBatchId || '');
    }
    // Clean up orphaned metadata
    if (state.pendingLoreMeta && state.pendingLoreEntries?.length === 0) {
        state.pendingLoreMeta = null;
    }

    return state;
}



function normalizeCompressionStatusNumbers(status) {
    if (!status || typeof status !== 'object') return;
    for (const key of [
        'lastCompressedAt',
        'lastTokenEstimate',
        'lastCharacterCount',
        'lastDirectTokenEstimate',
        'lastDirectCharacterCount',
        'lastTargetTokenEstimate',
        'lastTargetCharacterCount',
        'lastHardTokenLimit',
        'lastHardCharacterLimit',
        'lastCompressionRatio',
        'turnsSinceCompression',
        'lastChatLength',
    ]) {
        status[key] = Number.isFinite(Number(status[key])) ? Number(status[key]) : 0;
    }
}


// ── Continuity structure helpers ───────────────────────────────────────────────

function normalizeContinuityStructure(state) {
    const defaults = getDefaultState();

    if (!state.continuityConfig || typeof state.continuityConfig !== 'object' || Array.isArray(state.continuityConfig)) {
        state.continuityConfig = { ...defaults.continuityConfig };
    } else {
        state.continuityConfig = { ...defaults.continuityConfig, ...state.continuityConfig };
        for (const key of Object.keys(defaults.continuityConfig)) {
            state.continuityConfig[key] = state.continuityConfig[key] !== false;
        }
    }
    disableRetiredContinuitySections(state);

    if (!state.scene || typeof state.scene !== 'object' || Array.isArray(state.scene)) {
        state.scene = { ...defaults.scene };
    } else {
        state.scene = { ...defaults.scene, ...state.scene };
        state.scene.presentCharacters = Array.isArray(state.scene.presentCharacters) ? state.scene.presentCharacters.filter(Boolean).map(String) : [];
        state.scene.nearbyCharacters = Array.isArray(state.scene.nearbyCharacters) ? state.scene.nearbyCharacters.filter(Boolean).map(String) : [];
    }

    if (!state.storyMilestones || typeof state.storyMilestones !== 'object' || Array.isArray(state.storyMilestones)) {
        state.storyMilestones = {};
    } else {
        state.storyMilestones = Object.fromEntries(Object.entries(state.storyMilestones).map(([id, value]) => [String(id), normalizeStoryMilestone(value)]));
    }

    normalizeStateEntries(state);

    if (!state.continuityCompressionStatus || typeof state.continuityCompressionStatus !== 'object') {
        state.continuityCompressionStatus = getDefaultState().continuityCompressionStatus;
    } else {
        const defaults = getDefaultState().continuityCompressionStatus;
        state.continuityCompressionStatus = mergeDefaults(state.continuityCompressionStatus, defaults);
        normalizeCompressionStatusNumbers(state.continuityCompressionStatus);
    }
}

function isSectionEnabled(state, section) {
    return state?.continuityConfig?.[section] !== false;
}

function applyArrayDelta(target, patch, identityKey, normalizer) {
    if (!Array.isArray(target) || !patch || typeof patch !== 'object') return;

    if (Array.isArray(patch.added)) {
        for (const item of patch.added) {
            target.push(normalizer(item));
        }
    }

    if (Array.isArray(patch.updated)) {
        for (const upd of patch.updated) {
            let idx = Number.isInteger(upd.index) ? upd.index : -1;
            if (idx < 0 && upd[identityKey]) {
                const wanted = String(upd[identityKey]).toLowerCase();
                idx = target.findIndex(item => String(item?.[identityKey] || '').toLowerCase() === wanted);
            }
            if (idx >= 0 && idx < target.length) {
                const merged = { ...target[idx], ...(upd.changes || {}) };
                if (upd.changes?.emotionalState && target[idx]?.emotionalState) {
                    merged.emotionalState = {
                        ...target[idx].emotionalState,
                        ...upd.changes.emotionalState,
                        lastUpdatedAt: Date.now(),
                        lastUpdatedChatLength: getCurrentChatLength(),
                    };
                }
                target[idx] = normalizer(merged);
            }
        }
    }

    if (Array.isArray(patch.removed)) {
        const removals = new Set();
        for (const raw of patch.removed) {
            if (Number.isInteger(raw)) {
                removals.add(raw);
            } else if (typeof raw === 'string') {
                const wanted = raw.toLowerCase();
                const idx = target.findIndex(item => String(item?.[identityKey] || '').toLowerCase() === wanted);
                if (idx >= 0) removals.add(idx);
            }
        }
        const sorted = [...removals].sort((a, b) => b - a);
        for (const idx of sorted) {
            if (idx >= 0 && idx < target.length) target.splice(idx, 1);
        }
    }
}

function sanitizeCharacterPatchForConfig(patch, state) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;

    const appearanceEnabled = isSectionEnabled(state, 'appearance');
    const emotionalStateEnabled = isSectionEnabled(state, 'emotionalState');
    if (appearanceEnabled && emotionalStateEnabled) return patch;

    const sanitized = { ...patch };
    const sanitizeCharacter = (raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
        const next = { ...raw };
        if (!appearanceEnabled) delete next.clothing;
        if (!emotionalStateEnabled) delete next.emotionalState;
        return next;
    };
    const sanitizeUpdate = (raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
        const next = { ...raw };
        if (next.changes && typeof next.changes === 'object' && !Array.isArray(next.changes)) {
            next.changes = sanitizeCharacter(next.changes);
        }
        return next;
    };

    if (Array.isArray(sanitized.added)) sanitized.added = sanitized.added.map(sanitizeCharacter);
    if (Array.isArray(sanitized.updated)) sanitized.updated = sanitized.updated.map(sanitizeUpdate);
    return sanitized;
}

function clampEmotion(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(-5, Math.min(5, Math.round(n)));
}

function clampConfidence(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 1;
    return Math.max(0, Math.min(1, n));
}

function normalizeEmotionalState(raw = {}) {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return {
        affection: clampEmotion(src.affection),
        trust: clampEmotion(src.trust),
        desire: clampEmotion(src.desire),
        connection: clampEmotion(src.connection),
        fear: clampEmotion(src.fear),
        anger: clampEmotion(src.anger),
        sadness: clampEmotion(src.sadness),
        joy: clampEmotion(src.joy),
        notes: typeof src.notes === 'string' ? src.notes : '',
        confidence: clampConfidence(src.confidence),
        lastUpdatedAt: Number.isFinite(Number(src.lastUpdatedAt)) ? Number(src.lastUpdatedAt) : Date.now(),
        lastUpdatedChatLength: Number.isFinite(Number(src.lastUpdatedChatLength)) ? Number(src.lastUpdatedChatLength) : getCurrentChatLength(),
    };
}

function getCurrentChatLength() {
    try {
        const ctx = SillyTavern.getContext();
        return Array.isArray(ctx?.chat) ? ctx.chat.length : 0;
    } catch (_) {
        return 0;
    }
}

function normalizeCharacter(raw = {}) {
    const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const emotionalState = normalizeEmotionalState(c.emotionalState || {});
    return {
        name: typeof c.name === 'string' ? c.name.trim() : '',
        aliases: Array.isArray(c.aliases) ? c.aliases.filter(Boolean).map(String) : [],
        role: typeof c.role === 'string' ? c.role : '',
        location: typeof c.location === 'string' ? c.location : '',
        clothing: typeof c.clothing === 'string' ? c.clothing : '',
        posture: typeof c.posture === 'string' ? c.posture : '',
        physicalState: typeof c.physicalState === 'string' ? c.physicalState : '',
        emotionalState,
        inventory: Array.isArray(c.inventory) ? c.inventory.filter(Boolean).map(String) : [],
        goals: Array.isArray(c.goals) ? c.goals.filter(Boolean).map(String) : [],
        notes: typeof c.notes === 'string' ? c.notes : '',
    };
}

function normalizeInventoryItem(raw = {}) {
    const item = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return {
        owner: typeof item.owner === 'string' ? item.owner : '',
        item: typeof item.item === 'string' ? item.item : '',
        status: typeof item.status === 'string' ? item.status : '',
        location: typeof item.location === 'string' ? item.location : '',
        notes: typeof item.notes === 'string' ? item.notes : '',
    };
}

function normalizeObjective(raw = {}) {
    const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const allowed = new Set(['active', 'blocked', 'completed', 'abandoned']);
    return {
        owner: typeof obj.owner === 'string' ? obj.owner : '',
        goal: typeof obj.goal === 'string' ? obj.goal : '',
        status: allowed.has(obj.status) ? obj.status : 'active',
        stakes: typeof obj.stakes === 'string' ? obj.stakes : '',
        notes: typeof obj.notes === 'string' ? obj.notes : '',
    };
}

function normalizeStoryMilestone(raw = {}) {
    const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const allowed = new Set(['not_happened', 'suspected', 'happened', 'blocked', 'diverged', 'unknown']);
    return {
        status: allowed.has(obj.status) ? obj.status : 'unknown',
        happenedAtStoryDate: typeof obj.happenedAtStoryDate === 'string' ? obj.happenedAtStoryDate : '',
        happenedAtTurn: Number.isFinite(Number(obj.happenedAtTurn)) ? Number(obj.happenedAtTurn) : 0,
        evidence: Array.isArray(obj.evidence) ? obj.evidence.filter(x => typeof x === 'string') : [],
        confidence: Number.isFinite(Number(obj.confidence)) ? Math.max(0, Math.min(1, Number(obj.confidence))) : 0,
        notes: typeof obj.notes === 'string' ? obj.notes : '',
    };
}

// ── Delta validation ────────────────────────────────────────────────────────────

/** Valid enum values for validation */
const VALID_ENUMS = {
    tension: new Set(['low', 'medium', 'high', 'critical']),
    trust: new Set(['low', 'medium', 'high', 'absolute']),
    threadStatus: new Set(['active', 'dormant', 'resolved']),
    flagType: new Set(['contradiction', 'uncertainty', 'warning']),
    flagSeverity: new Set(['low', 'medium', 'high']),
};

/** Known top-level change keys */
const KNOWN_CHANGE_KEYS = new Set(ACTIVE_CONTINUITY_CHANGE_KEYS);

/**
 * Validates a WandlightDelta against the schema.
 * @param {Object} delta - The delta to validate
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateDelta(delta) {
    const errors = [];

    if (!delta || typeof delta !== 'object') {
        return { valid: false, errors: ['Delta must be an object'] };
    }

    // Empty changes is valid (no-op delta)
    if (!delta.changes) {
        return { valid: false, errors: ['Delta must have a "changes" key'] };
    }

    if (typeof delta.changes !== 'object' || Array.isArray(delta.changes)) {
        return { valid: false, errors: ['Delta.changes must be an object'] };
    }

    // Accept empty changes as a valid no-op
    if (Object.keys(delta.changes).length === 0) {
        return { valid: true, errors: [] };
    }

    const changes = delta.changes;

    // Check for unknown change keys
    for (const key of Object.keys(changes)) {
        if (!KNOWN_CHANGE_KEYS.has(key)) {
            errors.push(`Unknown change key: "${key}"`);
        }
    }

    // Validate scene sub-fields with deep structural assertions
    if (changes.scene && typeof changes.scene === 'object') {
        // Type-check presentCharacters
        if (changes.scene.presentCharacters !== undefined) {
            if (!Array.isArray(changes.scene.presentCharacters)) {
                errors.push('scene.presentCharacters must be an array');
            } else {
                for (let i = 0; i < changes.scene.presentCharacters.length; i++) {
                    if (typeof changes.scene.presentCharacters[i] !== 'string') {
                        errors.push(`scene.presentCharacters[${i}] must be a string`);
                    }
                }
            }
        }
        // Type-check nearbyCharacters
        if (changes.scene.nearbyCharacters !== undefined) {
            if (!Array.isArray(changes.scene.nearbyCharacters)) {
                errors.push('scene.nearbyCharacters must be an array');
            } else {
                for (let i = 0; i < changes.scene.nearbyCharacters.length; i++) {
                    if (typeof changes.scene.nearbyCharacters[i] !== 'string') {
                        errors.push(`scene.nearbyCharacters[${i}] must be a string`);
                    }
                }
            }
        }
    }

    // Validate knowledge (character key -> array of strings)
    if (changes.knowledge && typeof changes.knowledge === 'object' && !Array.isArray(changes.knowledge)) {
        for (const [char, facts] of Object.entries(changes.knowledge)) {
            if (!Array.isArray(facts)) {
                errors.push(`knowledge.${char} must be an array of strings`);
            } else {
                for (let i = 0; i < facts.length; i++) {
                    if (typeof facts[i] !== 'string') {
                        errors.push(`knowledge.${char}[${i}] must be a string`);
                    }
                }
            }
        }
    } else if (changes.knowledge !== undefined && (typeof changes.knowledge !== 'object' || Array.isArray(changes.knowledge))) {
        errors.push('knowledge must be a character-keyed object');
    }

    // Validate secrets
    if (changes.secrets && typeof changes.secrets === 'object') {
        ['added', 'updated', 'removed'].forEach(op => {
            if (changes.secrets[op] !== undefined) {
                if (!Array.isArray(changes.secrets[op])) {
                    errors.push(`secrets.${op} must be an array`);
                } else if (op === 'updated') {
                    changes.secrets.updated.forEach((upd, i) => {
                        if (!Number.isInteger(upd.index) || upd.index < 0) {
                            errors.push(`secrets.updated[${i}].index must be a nonnegative integer`);
                        }
                        if (upd.changes === undefined || upd.changes === null || typeof upd.changes !== 'object' || Array.isArray(upd.changes)) {
                            errors.push(`secrets.updated[${i}].changes must be a non-null object`);
                        }
                    });
                } else if (op === 'removed') {
                    changes.secrets.removed.forEach((idx, i) => {
                        if (!Number.isInteger(idx) || idx < 0) {
                            errors.push(`secrets.removed[${i}] must be a nonnegative integer`);
                        }
                    });
                }
            }
        });
    } else if (changes.secrets !== undefined) {
        errors.push('secrets must be an object with added/updated/removed arrays');
    }

    // Validate relationships
    if (changes.relationships && typeof changes.relationships === 'object') {
        ['added', 'updated', 'removed'].forEach(op => {
            if (changes.relationships[op] !== undefined) {
                if (!Array.isArray(changes.relationships[op])) {
                    errors.push(`relationships.${op} must be an array`);
                } else if (op === 'added') {
                    changes.relationships.added.forEach((rel, i) => {
                        if (rel.tension !== undefined && !VALID_ENUMS.tension.has(rel.tension)) {
                            errors.push(`relationships.added[${i}].tension "${rel.tension}" must be low|medium|high|critical`);
                        }
                        if (rel.trust !== undefined && !VALID_ENUMS.trust.has(rel.trust)) {
                            errors.push(`relationships.added[${i}].trust "${rel.trust}" must be low|medium|high|absolute`);
                        }
                    });
                } else if (op === 'updated') {
                    changes.relationships.updated.forEach((upd, i) => {
                        if (!Number.isInteger(upd.index) || upd.index < 0) {
                            errors.push(`relationships.updated[${i}].index must be a nonnegative integer`);
                        }
                        // Validate enum values in the changes sub-object
                        if (upd.changes && typeof upd.changes === 'object') {
                            if (upd.changes.tension !== undefined && !VALID_ENUMS.tension.has(upd.changes.tension)) {
                                errors.push(`relationships.updated[${i}].changes.tension "${upd.changes.tension}" must be low|medium|high|critical`);
                            }
                            if (upd.changes.trust !== undefined && !VALID_ENUMS.trust.has(upd.changes.trust)) {
                                errors.push(`relationships.updated[${i}].changes.trust "${upd.changes.trust}" must be low|medium|high|absolute`);
                            }
                        }
                    });
                } else if (op === 'removed') {
                    changes.relationships.removed.forEach((idx, i) => {
                        if (!Number.isInteger(idx) || idx < 0) {
                            errors.push(`relationships.removed[${i}] must be a nonnegative integer`);
                        }
                    });
                }
            }
        });
    } else if (changes.relationships !== undefined) {
        errors.push('relationships must be an object with added/updated/removed arrays');
    }

    // Validate threads
    if (changes.threads && typeof changes.threads === 'object') {
        ['added', 'updated'].forEach(op => {
            if (changes.threads[op] !== undefined) {
                if (!Array.isArray(changes.threads[op])) {
                    errors.push(`threads.${op} must be an array`);
                } else if (op === 'added') {
                    changes.threads.added.forEach((t, i) => {
                        if (t.status !== undefined && !VALID_ENUMS.threadStatus.has(t.status)) {
                            errors.push(`threads.added[${i}].status "${t.status}" must be active|dormant|resolved`);
                        }
                    });
                } else if (op === 'updated') {
                    changes.threads.updated.forEach((upd, i) => {
                        if (!Number.isInteger(upd.index) || upd.index < 0) {
                            errors.push(`threads.updated[${i}].index must be a nonnegative integer`);
                        }
                        // Validate enum values in the changes sub-object
                        if (upd.changes && typeof upd.changes === 'object') {
                            if (upd.changes.status !== undefined && !VALID_ENUMS.threadStatus.has(upd.changes.status)) {
                                errors.push(`threads.updated[${i}].changes.status "${upd.changes.status}" must be active|dormant|resolved`);
                            }
                        }
                    });
                }
            }
        });
    } else if (changes.threads !== undefined) {
        errors.push('threads must be an object with added/updated arrays');
    }

    // Validate continuityFlags
    if (changes.continuityFlags && typeof changes.continuityFlags === 'object') {
        if (changes.continuityFlags.added !== undefined) {
            if (!Array.isArray(changes.continuityFlags.added)) {
                errors.push('continuityFlags.added must be an array');
            } else {
                changes.continuityFlags.added.forEach((f, i) => {
                    if (f.type !== undefined && !VALID_ENUMS.flagType.has(f.type)) {
                        errors.push(`continuityFlags.added[${i}].type "${f.type}" must be contradiction|uncertainty|warning`);
                    }
                    if (f.severity !== undefined && !VALID_ENUMS.flagSeverity.has(f.severity)) {
                        errors.push(`continuityFlags.added[${i}].severity "${f.severity}" must be low|medium|high`);
                    }
                });
            }
        }
        if (changes.continuityFlags.resolved !== undefined) {
            if (!Array.isArray(changes.continuityFlags.resolved)) {
                errors.push('continuityFlags.resolved must be an array');
            } else {
                changes.continuityFlags.resolved.forEach((idx, i) => {
                    if (!Number.isInteger(idx) || idx < 0) {
                        errors.push(`continuityFlags.resolved[${i}] must be a nonnegative integer`);
                    }
                });
            }
        }
    } else if (changes.continuityFlags !== undefined) {
        errors.push('continuityFlags must be an object with added/resolved arrays');
    }

    if (changes.storyMilestones && typeof changes.storyMilestones === 'object' && !Array.isArray(changes.storyMilestones)) {
        const allowed = new Set(['not_happened', 'suspected', 'happened', 'blocked', 'diverged', 'unknown']);
        for (const [id, value] of Object.entries(changes.storyMilestones)) {
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                errors.push(`storyMilestones.${id} must be an object`);
                continue;
            }
            if (value.status !== undefined && !allowed.has(value.status)) {
                errors.push(`storyMilestones.${id}.status must be not_happened|suspected|happened|blocked|diverged|unknown`);
            }
            if (value.evidence !== undefined && !Array.isArray(value.evidence)) {
                errors.push(`storyMilestones.${id}.evidence must be an array`);
            }
        }
    } else if (changes.storyMilestones !== undefined) {
        errors.push('storyMilestones must be an object keyed by milestone id');
    }

    return { valid: errors.length === 0, errors };
}

// ── Delta application ───────────────────────────────────────────────────────────

/**
 * Deep-merges a validated WandlightDelta into the current WandlightState.
 * Returns a new state object — does not mutate the input.
 *
 * @param {Object} state - Current WandlightState
 * @param {Object} delta - Validated WandlightDelta to apply
 * @returns {Object} New WandlightState
 */
export function applyDelta(state, delta) {
    if (!delta || !delta.changes) return state;

    // Shallow clone top level
    const next = {
        ...state,
        canon: { ...state.canon, divergences: [...(state.canon.divergences || [])] },
        scene: { ...state.scene, presentCharacters: [...(state.scene.presentCharacters || [])], nearbyCharacters: [...(state.scene.nearbyCharacters || [])] },
        continuityConfig: { ...(state.continuityConfig || {}) },
        characters: [...(state.characters || [])],
        inventory: [...(state.inventory || [])],
        objectives: [...(state.objectives || [])],
        knowledge: { ...state.knowledge },
        secrets: [...(state.secrets || [])],
        relationships: [...(state.relationships || [])],
        threads: [...(state.threads || [])],
        continuityFlags: [...(state.continuityFlags || [])],
        storyMilestones: { ...(state.storyMilestones || {}) },
        memoHistory: [...(state.memoHistory || [])],
        stateHistory: [...(state.stateHistory || [])],
        lastDelta: delta,
    };

    const changes = delta.changes;

    // Canon block — shallow merge
    if (isSectionEnabled(next, 'canon') && changes.canon) {
        if (changes.canon.era !== undefined) next.canon.era = changes.canon.era;
        if (changes.canon.inUniverseDate !== undefined) next.canon.inUniverseDate = changes.canon.inUniverseDate;
        if (changes.canon.canonBoundary !== undefined) next.canon.canonBoundary = changes.canon.canonBoundary;
        if (Array.isArray(changes.canon.divergences)) {
            next.canon.divergences = changes.canon.divergences;
        }
    }

    // Scene block — shallow merge
    if (isSectionEnabled(next, 'scene') && changes.scene) {
        if (changes.scene.location !== undefined) next.scene.location = changes.scene.location;
        if (changes.scene.timeOfDay !== undefined) next.scene.timeOfDay = changes.scene.timeOfDay;
        if (isSectionEnabled(next, 'scene') && changes.scene.weather !== undefined) next.scene.weather = changes.scene.weather;
        if (isSectionEnabled(next, 'scene') && changes.scene.ambience !== undefined) next.scene.ambience = changes.scene.ambience;
        if (Array.isArray(changes.scene.presentCharacters)) {
            next.scene.presentCharacters = changes.scene.presentCharacters;
        }
        if (Array.isArray(changes.scene.nearbyCharacters)) {
            next.scene.nearbyCharacters = changes.scene.nearbyCharacters;
        }
        if (changes.scene.currentActivity !== undefined) next.scene.currentActivity = changes.scene.currentActivity;
    }

    // Characters — add/update/remove by name or index
    if (isSectionEnabled(next, 'characters') && changes.characters) {
        applyArrayDelta(next.characters, sanitizeCharacterPatchForConfig(changes.characters, next), 'name', normalizeCharacter);
    }

    // Inventory — add/update/remove by index
    if (isSectionEnabled(next, 'inventory') && changes.inventory) {
        applyArrayDelta(next.inventory, changes.inventory, 'item', normalizeInventoryItem);
    }

    // Objectives — add/update/remove by index
    if (isSectionEnabled(next, 'objectives') && changes.objectives) {
        applyArrayDelta(next.objectives, changes.objectives, 'goal', normalizeObjective);
    }

    // Knowledge — character-keyed, merge arrays per character
    if (isSectionEnabled(next, 'knowledge') && changes.knowledge) {
        for (const [char, facts] of Object.entries(changes.knowledge)) {
            if (!Array.isArray(facts)) continue;
            const existing = next.knowledge[char] || [];
            const merged = [...existing];
            for (const fact of facts) {
                if (!merged.includes(fact)) merged.push(fact);
            }
            next.knowledge[char] = merged;
        }
    }

    // Secrets — add/update/remove pattern
    if (isSectionEnabled(next, 'secrets') && changes.secrets) {
        if (Array.isArray(changes.secrets.added)) {
            next.secrets.push(...changes.secrets.added);
        }
        if (Array.isArray(changes.secrets.updated)) {
            for (const upd of changes.secrets.updated) {
                const idx = upd.index;
                if (idx >= 0 && idx < next.secrets.length) {
                    next.secrets[idx] = { ...next.secrets[idx], ...upd.changes };
                }
            }
        }
        if (Array.isArray(changes.secrets.removed)) {
            const sorted = [...changes.secrets.removed].sort((a, b) => b - a);
            for (const idx of sorted) {
                if (idx >= 0 && idx < next.secrets.length) {
                    next.secrets.splice(idx, 1);
                }
            }
        }
    }

    // Relationships — add/update/remove pattern
    if (isSectionEnabled(next, 'relationships') && changes.relationships) {
        if (Array.isArray(changes.relationships.added)) {
            next.relationships.push(...changes.relationships.added);
        }
        if (Array.isArray(changes.relationships.updated)) {
            for (const upd of changes.relationships.updated) {
                const idx = upd.index;
                if (idx >= 0 && idx < next.relationships.length) {
                    next.relationships[idx] = { ...next.relationships[idx], ...upd.changes };
                }
            }
        }
        if (Array.isArray(changes.relationships.removed)) {
            const sorted = [...changes.relationships.removed].sort((a, b) => b - a);
            for (const idx of sorted) {
                if (idx >= 0 && idx < next.relationships.length) {
                    next.relationships.splice(idx, 1);
                }
            }
        }
    }

    // Threads — add/update pattern (no removal — threads resolve, not delete)
    if (isSectionEnabled(next, 'threads') && changes.threads) {
        if (Array.isArray(changes.threads.added)) {
            next.threads.push(...changes.threads.added);
        }
        if (Array.isArray(changes.threads.updated)) {
            for (const upd of changes.threads.updated) {
                const idx = upd.index;
                if (idx >= 0 && idx < next.threads.length) {
                    next.threads[idx] = { ...next.threads[idx], ...upd.changes };
                }
            }
        }
    }

    // Continuity flags — add/resolve pattern
    if (isSectionEnabled(next, 'flags') && changes.continuityFlags) {
        if (Array.isArray(changes.continuityFlags.added)) {
            next.continuityFlags.push(...changes.continuityFlags.added);
        }
        if (Array.isArray(changes.continuityFlags.resolved)) {
            next.continuityFlags = next.continuityFlags.filter(
                (_, i) => !changes.continuityFlags.resolved.includes(i)
            );
        }
    }

    if (isSectionEnabled(next, 'storyMilestones') && changes.storyMilestones && typeof changes.storyMilestones === 'object' && !Array.isArray(changes.storyMilestones)) {
        next.storyMilestones = { ...(next.storyMilestones || {}) };
        for (const [id, raw] of Object.entries(changes.storyMilestones)) {
            next.storyMilestones[id] = normalizeStoryMilestone({ ...(next.storyMilestones[id] || {}), ...(raw || {}) });
        }
    }

    return next;
}

// ── Entry normalizers (defensive — prevent malformed imports from crashing memo builder) ──

/**
 * Normalizes a secret entry to its canonical shape.
 * If whoKnows/whoSuspects are strings instead of arrays, wraps them.
 * @param {*} s - Raw secret entry
 * @returns {Object} Normalized secret
 */
function normalizeSecret(s) {
    return {
        fact: typeof s?.fact === 'string' ? s.fact : '',
        trueState: typeof s?.trueState === 'string' ? s.trueState : '',
        whoKnows: Array.isArray(s?.whoKnows) ? s.whoKnows.filter(x => typeof x === 'string') : [],
        whoSuspects: Array.isArray(s?.whoSuspects) ? s.whoSuspects.filter(x => typeof x === 'string') : [],
        publicVersion: typeof s?.publicVersion === 'string' ? s.publicVersion : '',
    };
}

/**
 * Normalizes a relationship entry to its canonical shape.
 * @param {*} r - Raw relationship entry
 * @returns {Object} Normalized relationship
 */
function normalizeRelationship(r) {
    return {
        pair: typeof r?.pair === 'string' ? r.pair : '',
        notes: typeof r?.notes === 'string' ? r.notes : '',
        tension: (r?.tension && VALID_ENUMS.tension.has(r.tension)) ? r.tension : '',
        trust: (r?.trust && VALID_ENUMS.trust.has(r.trust)) ? r.trust : '',
    };
}

/**
 * Normalizes a thread entry to its canonical shape.
 * @param {*} t - Raw thread entry
 * @returns {Object} Normalized thread
 */
function normalizeThread(t) {
    return {
        description: typeof t?.description === 'string' ? t.description : '',
        status: (t?.status && VALID_ENUMS.threadStatus.has(t.status)) ? t.status : 'active',
        unresolvedConsequences: Array.isArray(t?.unresolvedConsequences)
            ? t.unresolvedConsequences.filter(x => typeof x === 'string') : [],
    };
}

/**
 * Normalizes a continuity flag entry to its canonical shape.
 * @param {*} f - Raw flag entry
 * @returns {Object} Normalized flag
 */
function normalizeFlag(f) {
    return {
        type: (f?.type && VALID_ENUMS.flagType.has(f.type)) ? f.type : 'warning',
        description: typeof f?.description === 'string' ? f.description : '',
        severity: (f?.severity && VALID_ENUMS.flagSeverity.has(f.severity)) ? f.severity : 'low',
        timestamp: Number.isFinite(f?.timestamp) ? f.timestamp : Date.now(),
        resolved: typeof f?.resolved === 'boolean' ? f.resolved : false,
    };
}

/**
 * Normalizes all arrays in a state object (secrets, relationships, threads, flags).
 * Mutates the state in place.
 * @param {Object} state - WandlightState to normalize
 */
function normalizeStateEntries(state) {
    if (Array.isArray(state.characters)) {
        state.characters = state.characters.map(normalizeCharacter).filter(c => c.name);
    } else {
        state.characters = [];
    }
    if (Array.isArray(state.inventory)) {
        state.inventory = state.inventory.map(normalizeInventoryItem).filter(i => i.item || i.owner || i.status);
    } else {
        state.inventory = [];
    }
    if (Array.isArray(state.objectives)) {
        state.objectives = state.objectives.map(normalizeObjective).filter(o => o.goal || o.owner);
    } else {
        state.objectives = [];
    }
    if (Array.isArray(state.secrets)) {
        state.secrets = state.secrets.map(normalizeSecret);
    }
    if (Array.isArray(state.relationships)) {
        state.relationships = state.relationships.map(normalizeRelationship);
    }
    if (Array.isArray(state.threads)) {
        state.threads = state.threads.map(normalizeThread);
    }
    if (Array.isArray(state.continuityFlags)) {
        state.continuityFlags = state.continuityFlags.map(normalizeFlag);
    }
    // Also normalize knowledge values: ensure each char has an array of strings
    if (state.knowledge && typeof state.knowledge === 'object' && !Array.isArray(state.knowledge)) {
        for (const [char, facts] of Object.entries(state.knowledge)) {
            if (!Array.isArray(facts)) {
                state.knowledge[char] = typeof facts === 'string' ? [facts] : [];
            } else {
                state.knowledge[char] = facts.filter(x => typeof x === 'string');
            }
        }
    }
}

// ── State import (validated) ────────────────────────────────────────────────────

/**
 * Imports state from a JSON string with validation and migration.
 * Always merges with defaults to fill missing fields.
 * @param {string} json - JSON string representing a WandlightState
 * @returns {{ state: Object|null, error: string|null }}
 */
export function importState(json) {
    try {
        const parsed = JSON.parse(json);
        if (!parsed || typeof parsed !== 'object') {
            return { state: null, error: 'Imported JSON must be an object' };
        }
        if (Array.isArray(parsed)) {
            return { state: null, error: 'Imported JSON must be an object, not an array' };
        }

        // Merge with defaults to fill missing fields safely
        const defaults = getDefaultState();
        const merged = {
            ...defaults,
            ...parsed,
            canon: { ...defaults.canon, ...(parsed.canon || {}) },
            scene: { ...defaults.scene, ...(parsed.scene || {}) },
            continuityConfig: { ...defaults.continuityConfig, ...(parsed.continuityConfig || {}) },
            characters: Array.isArray(parsed.characters) ? parsed.characters : [],
            inventory: Array.isArray(parsed.inventory) ? parsed.inventory : [],
            objectives: Array.isArray(parsed.objectives) ? parsed.objectives : [],
            knowledge: parsed.knowledge && typeof parsed.knowledge === 'object' && !Array.isArray(parsed.knowledge)
                ? parsed.knowledge : {},
            secrets: Array.isArray(parsed.secrets) ? parsed.secrets : [],
            relationships: Array.isArray(parsed.relationships) ? parsed.relationships : [],
            threads: Array.isArray(parsed.threads) ? parsed.threads : [],
            continuityFlags: Array.isArray(parsed.continuityFlags) ? parsed.continuityFlags : [],
            memoHistory: Array.isArray(parsed.memoHistory) ? parsed.memoHistory : [],
            stateHistory: Array.isArray(parsed.stateHistory) ? parsed.stateHistory : [],
            lastDelta: parsed.lastDelta || null,
            _version: SCHEMA_VERSION,

            // Lore fields (schema v2)
            loreContext: normalizeLoreContext(parsed.loreContext || {}),
            loreMatrix: normalizeLoreMatrix(parsed.loreMatrix || []),
            pendingLoreEntries: normalizeLoreMatrix(parsed.pendingLoreEntries || []),

            // Lore generation lifecycle ledger (schema v3)
            loreGeneration: parsed.loreGeneration && typeof parsed.loreGeneration === 'object' && !Array.isArray(parsed.loreGeneration)
                ? {
                    lastAttemptedFor: parsed.loreGeneration.lastAttemptedFor || '',
                    lastProposedFor: parsed.loreGeneration.lastProposedFor || '',
                    lastAcceptedFor: parsed.loreGeneration.lastAcceptedFor || '',
                    lastRejectedFor: parsed.loreGeneration.lastRejectedFor || '',
                    lastFailedFor: parsed.loreGeneration.lastFailedFor || '',
                    attempts: parsed.loreGeneration.attempts && typeof parsed.loreGeneration.attempts === 'object' && !Array.isArray(parsed.loreGeneration.attempts)
                        ? parsed.loreGeneration.attempts : {},
                }
                : { ...getDefaultState().loreGeneration },

            loreBulkGeneration: parsed.loreBulkGeneration && typeof parsed.loreBulkGeneration === 'object' && !Array.isArray(parsed.loreBulkGeneration)
                ? {
                    activeBatchId: parsed.loreBulkGeneration.activeBatchId || '',
                    lastBatchId: parsed.loreBulkGeneration.lastBatchId || '',
                    batches: parsed.loreBulkGeneration.batches && typeof parsed.loreBulkGeneration.batches === 'object' && !Array.isArray(parsed.loreBulkGeneration.batches)
                        ? parsed.loreBulkGeneration.batches : {},
                    chunks: parsed.loreBulkGeneration.chunks && typeof parsed.loreBulkGeneration.chunks === 'object' && !Array.isArray(parsed.loreBulkGeneration.chunks)
                        ? parsed.loreBulkGeneration.chunks : {},
                    candidates: parsed.loreBulkGeneration.candidates && typeof parsed.loreBulkGeneration.candidates === 'object' && !Array.isArray(parsed.loreBulkGeneration.candidates)
                        ? parsed.loreBulkGeneration.candidates : {},
                }
                : { ...getDefaultState().loreBulkGeneration },

            continuityScan: parsed.continuityScan && typeof parsed.continuityScan === 'object' && !Array.isArray(parsed.continuityScan)
                ? {
                    activeBatchId: parsed.continuityScan.activeBatchId || '',
                    lastBatchId: parsed.continuityScan.lastBatchId || '',
                    batches: parsed.continuityScan.batches && typeof parsed.continuityScan.batches === 'object' && !Array.isArray(parsed.continuityScan.batches)
                        ? parsed.continuityScan.batches : {},
                    chunks: parsed.continuityScan.chunks && typeof parsed.continuityScan.chunks === 'object' && !Array.isArray(parsed.continuityScan.chunks)
                        ? parsed.continuityScan.chunks : {},
                    observations: parsed.continuityScan.observations && typeof parsed.continuityScan.observations === 'object' && !Array.isArray(parsed.continuityScan.observations)
                        ? parsed.continuityScan.observations : {},
                }
                : { ...getDefaultState().continuityScan },

            pendingLoreMeta: parsed.pendingLoreMeta && typeof parsed.pendingLoreMeta === 'object' && !Array.isArray(parsed.pendingLoreMeta)
                ? parsed.pendingLoreMeta : null,
        };

        // Normalize all array entries to prevent malformed imports from crashing memo builder
        normalizeStateEntries(merged);

        // Re-migrate to ensure current schema
        const migrated = migrateState(merged);
        return { state: migrated, error: null };
    } catch (e) {
        console.error(`${LOG_PREFIX} Failed to import state:`, e);
        return { state: null, error: `JSON parse failed: ${e.message}` };
    }
}

/**
 * Serializes state to a pretty-printed JSON string.
 * @param {Object} state - WandlightState
 * @returns {string} JSON string
 */
export function exportState(state) {
    try {
        return JSON.stringify(state, null, 2);
    } catch (e) {
        console.error(`${LOG_PREFIX} Failed to export state:`, e);
        return '{}';
    }
}

// ── Lore-specific state operations ──────────────────────────────────────────────

/**
 * Updates loreContext on the live state object and persists.
 * Used after lore context detection completes.
 * @param {Object} contextUpdate - Partial lore context to merge
 * @returns {Object} Updated state (the live object, not a clone)
 */
/**
 * If the candidate is a non-blank string, return it; otherwise keep the fallback.
 * Prevents an empty detection result from overwriting a known context value.
 * @param {*} candidate - The detected value (may be empty string, null, undefined)
 * @param {string} fallback - The previous known value
 * @returns {string}
 */
function keepIfBlank(candidate, fallback) {
    return typeof candidate === 'string' && candidate.trim()
        ? candidate.trim()
        : (fallback || '');
}

/**
 * Updates loreContext on the live state object and persists.
 * Used after lore context detection completes.
 *
 * Empty-string detector results are treated as "unknown" and do NOT overwrite
 * previously known context. Only non-blank values replace existing fields.
 *
 * @param {Object} contextUpdate - Partial lore context to merge
 * @returns {Object} Updated state (the live object, not a clone)
 */
export function setLoreContext(contextUpdate) {
    const state = getState();
    const previous = state.loreContext || {};

    // Only allow detection to update actual context fields, never metadata.
    // normalizeLoreContext fills missing fields with empty strings,
    // so spreading it unconditionally would clear lastGeneratedFor/lastGenerationSummary.
    state.loreContext = normalizeLoreContext({
        ...previous,
        sceneDate: keepIfBlank(contextUpdate?.sceneDate, previous.sceneDate),
        subjectiveDate: keepIfBlank(contextUpdate?.subjectiveDate, previous.subjectiveDate),
        canonBoundary: keepIfBlank(contextUpdate?.canonBoundary, previous.canonBoundary),
        branchId: keepIfBlank(contextUpdate?.branchId, previous.branchId || 'main'),
        timeTravelMode: keepIfBlank(contextUpdate?.timeTravelMode, previous.timeTravelMode || 'none'),
        lastDetectedAt: Date.now(),
        lastGeneratedFor: previous.lastGeneratedFor || '',
        lastGenerationSummary: previous.lastGenerationSummary || '',
    });

    saveState(state);
    return state;
}

// ── Lore generation lifecycle ledger ────────────────────────────────────────────

/**
 * Records a lore generation attempt in the ledger.
 * Does NOT mark the context as proposed — just logs the attempt.
 * Safe to call even if loreGeneration doesn't exist yet (initializes on demand).
 *
 * The attemptCount only increments when options.increment is true (default).
 * Pass { increment: false } for status updates that follow an already-counted
 * attempt (e.g. recording a failure for an attempt that was already started),
 * so a single real generation attempt is not counted multiple times.
 *
 * When the patched status is a failure ('failed_*') or 'empty', the top-level
 * loreGeneration.lastFailedFor is updated to this context key.
 *
 * @param {string} contextKey - The current lore generation key
 * @param {Object} [patch={}] - Additional fields to merge into the attempt record
 * @param {Object} [options={}] - { increment?: boolean } — whether to bump attemptCount
 * @returns {Object} Updated state
 */
export function recordLoreAttempt(contextKey, patch = {}, options = {}) {
    const { increment = true, syncPrompt = true } = options;
    const state = getState();

    if (!state.loreGeneration || typeof state.loreGeneration !== 'object') {
        state.loreGeneration = getDefaultState().loreGeneration;
    }

    const previous = state.loreGeneration.attempts[contextKey] || {
        attemptCount: 0,
    };

    state.loreGeneration.attempts[contextKey] = {
        ...previous,
        ...patch,
        attemptCount: previous.attemptCount + (increment ? 1 : 0),
        lastAttemptAt: increment ? Date.now() : previous.lastAttemptAt,
        lastUpdatedAt: Date.now(),
    };

    if (increment) {
        state.loreGeneration.lastAttemptedFor = contextKey;
    }

    // Track the most recent failed/empty context at the top level
    const status = String(patch.status || '');
    if (status.startsWith('failed') || status === 'empty') {
        state.loreGeneration.lastFailedFor = contextKey;
    }

    saveState(state, { syncPrompt });
    return state;
}

function ensureLoreBulkGenerationLedger(state = getState()) {
    if (!state.loreBulkGeneration || typeof state.loreBulkGeneration !== 'object' || Array.isArray(state.loreBulkGeneration)) {
        state.loreBulkGeneration = getDefaultState().loreBulkGeneration;
    }
    for (const key of ['batches', 'chunks', 'candidates']) {
        if (!state.loreBulkGeneration[key] || typeof state.loreBulkGeneration[key] !== 'object' || Array.isArray(state.loreBulkGeneration[key])) {
            state.loreBulkGeneration[key] = {};
        }
    }
    state.loreBulkGeneration.activeBatchId = String(state.loreBulkGeneration.activeBatchId || '');
    state.loreBulkGeneration.lastBatchId = String(state.loreBulkGeneration.lastBatchId || '');
    return state.loreBulkGeneration;
}

function compactBulkCandidateFact(raw = {}) {
    if (!raw || typeof raw !== 'object') return null;
    const messageRefs = Array.isArray(raw.messageRefs) ? raw.messageRefs : [];
    return {
        category: truncateText(raw.category || 'knowledge', 60),
        subject: truncateText(raw.subject || 'Story fact', 160),
        fact: truncateText(raw.fact || raw.text || raw.description || '', 900),
        priorityHint: truncateText(raw.priorityHint || raw.priority || 'medium', 40),
        confidence: Number.isFinite(Number(raw.confidence)) ? Math.max(0, Math.min(1, Number(raw.confidence))) : 0.75,
        messageRefs: messageRefs.map(v => Number(v)).filter(n => Number.isFinite(n) && n > 0).slice(0, 20),
        scope: raw.scope && typeof raw.scope === 'object' ? raw.scope : {},
        evidence: truncateText(raw.evidence || '', 400),
        chunkId: truncateText(raw.chunkId || '', 180),
        startIndex: Number.isFinite(Number(raw.startIndex)) ? Number(raw.startIndex) : 0,
        endIndex: Number.isFinite(Number(raw.endIndex)) ? Number(raw.endIndex) : 0,
    };
}

function compactBulkCandidates(candidates = [], limit = 80) {
    const raw = Array.isArray(candidates) ? candidates : [];
    return raw.slice(0, Math.max(0, Number(limit) || 80)).map(compactBulkCandidateFact).filter(Boolean);
}

function compactBulkLedger(state, options = {}) {
    const ledger = ensureLoreBulkGenerationLedger(state);
    const retainCompletedBatches = Math.max(1, Number(options.retainCompletedBatches) || Number(getSettings().loreBulkRetainCompletedBatches) || 3);
    const batchEntries = Object.entries(ledger.batches || {}).sort((a, b) => Number(b[1]?.updatedAt || b[1]?.createdAt || 0) - Number(a[1]?.updatedAt || a[1]?.createdAt || 0));
    const keepBatchIds = new Set();
    let completedKept = 0;
    for (const [id, batch] of batchEntries) {
        const status = String(batch?.status || '');
        if (id === ledger.activeBatchId || status === 'running' || status === 'queued' || status === 'partial' || status === 'failed') {
            keepBatchIds.add(id);
        } else if (completedKept < retainCompletedBatches) {
            keepBatchIds.add(id);
            completedKept++;
        }
    }
    if (ledger.lastBatchId) keepBatchIds.add(ledger.lastBatchId);

    for (const id of Object.keys(ledger.batches || {})) {
        if (!keepBatchIds.has(id)) delete ledger.batches[id];
    }
    for (const [chunkId, chunk] of Object.entries(ledger.chunks || {})) {
        if (chunk?.batchId && !keepBatchIds.has(chunk.batchId)) delete ledger.chunks[chunkId];
    }
    for (const [chunkId, record] of Object.entries(ledger.candidates || {})) {
        if (record?.batchId && !keepBatchIds.has(record.batchId)) delete ledger.candidates[chunkId];
    }
    return ledger;
}

function saveBulkLedgerState(state, options = {}) {
    const { full = false, syncPrompt = false } = options || {};
    if (full) {
        compactBulkLedger(state, options);
    }
    saveState(state, { syncPrompt, sanitize: full });
}

/**
 * Creates or updates a resumable bulk lore scan batch.
 * Batch creation is an immediate durable checkpoint, but it deliberately does
 * not queue prompt-injection sync because pending/accepted lore has not changed.
 * @param {Object} batch - Batch metadata. Must include id.
 * @returns {Object} Updated state
 */
export function startLoreBulkBatch(batch = {}) {
    const state = getState();
    const ledger = ensureLoreBulkGenerationLedger(state);
    const id = String(batch.id || `lore_bulk_${Date.now()}`);
    const previous = ledger.batches[id] || {};
    ledger.batches[id] = {
        ...previous,
        ...batch,
        id,
        status: batch.status || 'running',
        createdAt: previous.createdAt || Date.now(),
        updatedAt: Date.now(),
        startedAt: batch.startedAt || previous.startedAt || Date.now(),
        lastFullCheckpointAt: previous.lastFullCheckpointAt || 0,
        lastFullCheckpointChunkCount: previous.lastFullCheckpointChunkCount || 0,
    };
    ledger.activeBatchId = id;
    ledger.lastBatchId = id;
    saveBulkLedgerState(state, { full: true, syncPrompt: false });
    return state;
}

/**
 * Patches a bulk lore scan batch.
 * @param {string} batchId - Batch id
 * @param {Object} patch - Fields to merge
 * @param {Object} [options] - { full?: boolean, syncPrompt?: boolean }
 * @returns {Object} Updated state
 */
export function updateLoreBulkBatch(batchId, patch = {}, options = {}) {
    const state = getState();
    const ledger = ensureLoreBulkGenerationLedger(state);
    const id = String(batchId || ledger.activeBatchId || ledger.lastBatchId || '');
    if (!id) return state;
    const previous = ledger.batches[id] || { id, createdAt: Date.now() };
    ledger.batches[id] = {
        ...previous,
        ...patch,
        id,
        updatedAt: Date.now(),
    };
    if (patch.status && !['running', 'queued'].includes(String(patch.status))) {
        if (ledger.activeBatchId === id) ledger.activeBatchId = '';
    }
    saveBulkLedgerState(state, { full: options.full !== false, syncPrompt: !!options.syncPrompt });
    return state;
}

/**
 * Patches a single chunk in the bulk lore scan ledger.
 * @param {string} chunkId - Stable chunk id
 * @param {Object} patch - Fields to merge
 * @param {Object} [options] - { full?: boolean, syncPrompt?: boolean }
 * @returns {Object} Updated state
 */
export function updateLoreBulkChunk(chunkId, patch = {}, options = {}) {
    const state = getState();
    const ledger = ensureLoreBulkGenerationLedger(state);
    const id = String(chunkId || '');
    if (!id) return state;
    const previous = ledger.chunks[id] || { id, attempts: 0, createdAt: Date.now() };
    ledger.chunks[id] = {
        ...previous,
        ...patch,
        id,
        updatedAt: Date.now(),
    };
    saveBulkLedgerState(state, { full: !!options.full, syncPrompt: !!options.syncPrompt });
    return state;
}

/**
 * Stores compact candidate facts for a completed bulk lore chunk.
 * @param {string} batchId - Batch id
 * @param {string} chunkId - Chunk id
 * @param {Object[]} candidates - Candidate fact objects
 * @param {Object} [options] - { full?: boolean, syncPrompt?: boolean }
 * @returns {Object} Updated state
 */
export function storeLoreBulkCandidates(batchId, chunkId, candidates = [], options = {}) {
    const state = getState();
    const ledger = ensureLoreBulkGenerationLedger(state);
    const id = String(chunkId || '');
    if (!id) return state;
    ledger.candidates[id] = {
        batchId: String(batchId || ''),
        chunkId: id,
        candidates: compactBulkCandidates(candidates, options.maxCandidates || 80),
        updatedAt: Date.now(),
    };
    saveBulkLedgerState(state, { full: !!options.full, syncPrompt: !!options.syncPrompt });
    return state;
}

/**
 * Writes a single durable bulk-scan checkpoint. This is the primary write-ahead
 * log primitive for large scans: one small, prompt-sync-free save records chunk
 * status, optional candidates, and optional batch counters.
 * @param {string} chunkId - Stable chunk id
 * @param {Object} payload - { batchId, chunkPatch, candidates, batchPatch, rawResponse }
 * @param {Object} [options] - { full?: boolean, syncPrompt?: boolean }
 * @returns {Object} Updated state
 */
export function checkpointLoreBulkChunk(chunkId, payload = {}, options = {}) {
    const state = getState();
    const ledger = ensureLoreBulkGenerationLedger(state);
    const id = String(chunkId || payload.chunkId || '');
    if (!id) return state;
    const batchId = String(payload.batchId || payload.chunkPatch?.batchId || payload.batchPatch?.id || ledger.activeBatchId || ledger.lastBatchId || '');
    const previous = ledger.chunks[id] || { id, attempts: 0, createdAt: Date.now() };
    const rawResponse = payload.rawResponse && getSettings().loreBulkRetainRawResponses ? truncateText(payload.rawResponse, 20000) : '';
    ledger.chunks[id] = {
        ...previous,
        ...(payload.chunkPatch || {}),
        id,
        batchId: batchId || previous.batchId || '',
        rawResponse,
        updatedAt: Date.now(),
    };
    if (Array.isArray(payload.candidates)) {
        ledger.candidates[id] = {
            batchId,
            chunkId: id,
            candidates: compactBulkCandidates(payload.candidates, payload.maxCandidates || 80),
            updatedAt: Date.now(),
        };
    }
    if (batchId && payload.batchPatch && typeof payload.batchPatch === 'object') {
        const batchPrevious = ledger.batches[batchId] || { id: batchId, createdAt: Date.now() };
        ledger.batches[batchId] = {
            ...batchPrevious,
            ...payload.batchPatch,
            id: batchId,
            updatedAt: Date.now(),
        };
        if (payload.batchPatch.status && !['running', 'queued'].includes(String(payload.batchPatch.status))) {
            if (ledger.activeBatchId === batchId) ledger.activeBatchId = '';
        }
    }
    saveBulkLedgerState(state, { full: !!options.full, syncPrompt: !!options.syncPrompt });
    return state;
}

/**
 * Marks stale in-flight chunks as interrupted so resuming scans can distinguish
 * abandoned work from currently running work.
 * @param {number} [staleMs] - Running/retrying chunks older than this are interrupted
 * @returns {Object} Updated state
 */
export function markInterruptedLoreBulkChunks(staleMs = 10 * 60 * 1000) {
    const state = getState();
    const ledger = ensureLoreBulkGenerationLedger(state);
    const cutoff = Date.now() - Math.max(1000, Number(staleMs) || 600000);
    let changed = false;
    for (const [id, chunk] of Object.entries(ledger.chunks || {})) {
        const status = String(chunk?.status || '');
        const updatedAt = Number(chunk?.updatedAt || chunk?.startedAt || chunk?.lastScannedAt || 0);
        if ((status === 'running' || status === 'retrying') && (!updatedAt || updatedAt < cutoff)) {
            ledger.chunks[id] = {
                ...chunk,
                status: 'interrupted',
                error: chunk?.error || 'Previous scan was interrupted before this chunk completed.',
                updatedAt: Date.now(),
            };
            changed = true;
        }
    }
    if (changed) saveBulkLedgerState(state, { full: false, syncPrompt: false });
    return state;
}

/**
 * Forces a full bulk ledger checkpoint after a batch of lightweight chunk writes.
 * @param {string} batchId - Batch id
 * @param {Object} [patch] - Optional batch patch
 * @returns {Object} Updated state
 */
export function flushLoreBulkFullCheckpoint(batchId, patch = {}) {
    const state = getState();
    const ledger = ensureLoreBulkGenerationLedger(state);
    const id = String(batchId || ledger.activeBatchId || ledger.lastBatchId || '');
    if (!id) return state;
    const previous = ledger.batches[id] || { id, createdAt: Date.now() };
    ledger.batches[id] = {
        ...previous,
        ...patch,
        id,
        updatedAt: Date.now(),
        lastFullCheckpointAt: Date.now(),
        lastFullCheckpointChunkCount: Number(patch.completedChunks ?? previous.completedChunks ?? 0) + Number(patch.failedChunks ?? previous.failedChunks ?? 0),
    };
    if (patch.status && !['running', 'queued'].includes(String(patch.status))) {
        if (ledger.activeBatchId === id) ledger.activeBatchId = '';
    }
    saveBulkLedgerState(state, { full: true, syncPrompt: false });
    return state;
}

/**
 * Appends generated lore into Pending Lore Review without replacing existing pending entries.
 * Used by bulk lore scans so successful chunks commit partial progress immediately.
 * @param {Object[]} entries - Raw lore entries to append/merge
 * @param {Object} meta - Pending/batch metadata
 * @param {Object} options - { snapshot?: boolean, snapshotLabel?: string }
 * @returns {{ state: Object, changed: boolean, appendedCount: number, pendingCount: number }}
 */
export function appendPendingLoreEntries(entries, meta = {}, options = {}) {
    const { snapshot = false, snapshotLabel = 'Append bulk pending lore entries', syncPrompt = true, full = true } = options;
    const state = getState();
    const settings = getSettings();
    const incoming = preprocessPendingLoreEntries(entries || [], state, settings);
    if (incoming.length === 0) {
        return { state, changed: false, appendedCount: 0, pendingCount: (state.pendingLoreEntries || []).length };
    }

    if (snapshot) {
        pushStateSnapshot(state, snapshotLabel, settings.maxSnapshots);
    }

    const before = normalizeLoreMatrix(state.pendingLoreEntries || []);
    const merged = mergeLoreEntries(before, incoming);
    state.pendingLoreEntries = merged;

    const contextKey = meta.contextKey || state.pendingLoreMeta?.contextKey || buildLoreGenerationKey(state);
    const oldMeta = state.pendingLoreMeta && typeof state.pendingLoreMeta === 'object' ? state.pendingLoreMeta : {};
    const rawEntryCount = Math.max(0, Number(oldMeta.rawEntryCount) || 0) + Math.max(0, Number(meta.rawEntryCount ?? incoming.length) || incoming.length);
    const normalizedEntryCount = Math.max(0, Number(oldMeta.normalizedEntryCount) || 0) + Math.max(0, Number(meta.normalizedEntryCount ?? incoming.length) || incoming.length);
    const duplicateCount = Math.max(0, Number(oldMeta.droppedDuplicateCount) || 0) + Math.max(0, Number(meta.droppedDuplicateCount) || 0);
    const qualityCount = Math.max(0, Number(oldMeta.droppedQualityCount) || 0) + Math.max(0, Number(meta.droppedQualityCount) || 0);
    const routedSimilarCount = Math.max(0, Number(oldMeta.routedSimilarCount) || 0) + Math.max(0, Number(meta.routedSimilarCount) || 0);
    const failedChunkCount = Math.max(0, Number(meta.failedChunkCount ?? oldMeta.failedChunkCount) || 0);
    const completedChunkCount = Math.max(0, Number(meta.completedChunkCount ?? oldMeta.completedChunkCount) || 0);
    const chunkCount = Math.max(0, Number(meta.chunkCount ?? oldMeta.chunkCount) || 0);

    state.pendingLoreMeta = {
        ...oldMeta,
        id: oldMeta.id || meta.id || `lore_batch_${Date.now()}`,
        contextKey,
        source: meta.source || oldMeta.source || 'manual_bulk',
        status: 'pending',
        createdAt: oldMeta.createdAt || Date.now(),
        updatedAt: Date.now(),
        summary: meta.summary || oldMeta.summary || '',
        rawEntryCount,
        normalizedEntryCount,
        validEntryCount: merged.length,
        droppedEntryCount: Math.max(0, rawEntryCount - merged.length),
        droppedDuplicateCount: duplicateCount,
        droppedQualityCount: qualityCount,
        routedSimilarCount,
        failedChunkCount,
        emptyChunkCount: Math.max(0, Number(meta.emptyChunkCount ?? oldMeta.emptyChunkCount) || 0),
        chunkCount,
        completedChunkCount,
        sourceMessageCount: Math.max(0, Number(meta.sourceMessageCount ?? oldMeta.sourceMessageCount) || 0),
        chunkSize: Math.max(0, Number(meta.chunkSize ?? oldMeta.chunkSize) || 0),
        generationMode: meta.generationMode || oldMeta.generationMode || '',
        generationConfiguredMode: meta.generationConfiguredMode || oldMeta.generationConfiguredMode || '',
        targetEntryCount: Math.max(0, Number(meta.targetEntryCount ?? oldMeta.targetEntryCount) || 0),
        storyLoreCountBefore: Math.max(0, Number(meta.storyLoreCountBefore ?? oldMeta.storyLoreCountBefore) || 0),
        bulkBatchId: meta.bulkBatchId || oldMeta.bulkBatchId || '',
        bulkChunkId: meta.bulkChunkId || oldMeta.bulkChunkId || '',
        bulk: meta.bulk === undefined ? (oldMeta.bulk || false) : !!meta.bulk,
    };

    if (!state.loreGeneration || typeof state.loreGeneration !== 'object') {
        state.loreGeneration = getDefaultState().loreGeneration;
    }
    state.loreGeneration.lastProposedFor = contextKey;
    state.loreGeneration.attempts[contextKey] = {
        ...(state.loreGeneration.attempts[contextKey] || {}),
        status: 'pending',
        lastProposedAt: Date.now(),
        validEntryCount: merged.length,
        rawEntryCount,
        normalizedEntryCount,
        droppedDuplicateCount: duplicateCount,
        droppedQualityCount: qualityCount,
        routedSimilarCount,
        generationMode: state.pendingLoreMeta.generationMode,
        targetEntryCount: state.pendingLoreMeta.targetEntryCount,
        lastSource: state.pendingLoreMeta.source,
    };

    saveState(state, { syncPrompt, sanitize: full });
    return { state, changed: true, appendedCount: Math.max(0, merged.length - before.length), pendingCount: merged.length };
}


/**
 * Patches pending lore metadata without changing pending entries.
 * Used by bulk scans to update final chunk/duplicate diagnostics even when later chunks add no new entries.
 * @param {Object} patch - Metadata fields to merge
 * @returns {Object} Updated state
 */
export function patchPendingLoreMeta(patch = {}, options = {}) {
    const state = getState();
    if (!state.pendingLoreMeta || typeof state.pendingLoreMeta !== 'object') {
        return state;
    }
    state.pendingLoreMeta = {
        ...state.pendingLoreMeta,
        ...patch,
        updatedAt: Date.now(),
        validEntryCount: Array.isArray(state.pendingLoreEntries) ? state.pendingLoreEntries.length : 0,
    };
    saveState(state, { syncPrompt: options.syncPrompt !== false, sanitize: options.full !== false });
    return state;
}

/**
 * Marks the current pending lore batch as stale because the context changed.
 * Updates pendingLoreMeta.status to 'stale' and persists.
 *
 * @param {string} [reason=''] - Why the pending lore is stale
 * @returns {Object} Updated state
 */
export function markPendingLoreStale(reason = '') {
    const state = getState();

    if (state.pendingLoreMeta && state.pendingLoreEntries?.length > 0) {
        state.pendingLoreMeta.status = 'stale';
        state.pendingLoreMeta.staleAt = Date.now();
        state.pendingLoreMeta.staleReason = reason || 'Context changed';
        saveState(state);
    }

    return state;
}

/**
 * Marks the old pending lore batch's ledger entry as 'replaced' when a new
 * generation overwrites it for a different context. Keeps the ledger truthful
 * so an abandoned 'pending' entry is not left dangling.
 *
 * No-op when there is no old pending context, or when the old context equals
 * the incoming one (a re-generation for the same context).
 *
 * @param {string} newContextKey - The context key of the incoming proposal
 * @returns {Object} Updated state
 */
export function markPendingLoreReplaced(newContextKey) {
    const state = getState();

    const oldMeta = state.pendingLoreMeta;
    const oldKey = oldMeta?.contextKey || '';
    const oldBatchId = oldMeta?.id || '';

    if (!oldKey || !state.loreGeneration?.attempts) {
        return state;
    }

    const previousAttempt = state.loreGeneration.attempts[oldKey] || {};

    state.loreGeneration.attempts[oldKey] = {
        ...previousAttempt,
        status: 'replaced',
        replacedAt: Date.now(),
        replacedBy: newContextKey || '',
        replacedBatchId: oldBatchId,
    };

    saveState(state);
    return state;
}

function uniqueMergedStrings(...arrays) {
    const seen = new Set();
    const out = [];
    for (const array of arrays) {
        for (const raw of Array.isArray(array) ? array : []) {
            const text = String(raw || '').trim();
            if (!text) continue;
            const key = text.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(text);
        }
    }
    return out;
}

function preparePendingLoreEntryForAcceptance(pendingEntry, existingEntries = []) {
    const pending = normalizeLoreEntry(pendingEntry);
    const generation = pending.extensions?.wandlightGeneration || {};
    const review = pending.extensions?.wandlightPendingReview || {};
    const operation = String(generation.operation || review.reviewRoute || '').toLowerCase();
    const targetId = String(generation.targetEntryId || review.targetEntryId || '').trim();
    if (!targetId || !['update', 'merge', 'supersede', 'conflict', 'possible_update', 'possible_merge'].includes(operation)) return pending;

    const current = normalizeLoreMatrix(existingEntries).find(entry => entry.id === targetId);
    if (!current || current.locked) return pending;

    const mergeMode = operation === 'merge' || operation === 'possible_merge';
    const currentContent = current.content || {};
    const pendingContent = pending.content || {};
    const mergedFact = mergeMode && current.fact && pending.fact && !String(current.fact).includes(pending.fact)
        ? `${current.fact} ${pending.fact}`.trim()
        : (pending.fact || current.fact);
    const mergedInjection = mergeMode && currentContent.injection && pendingContent.injection && !String(currentContent.injection).includes(pendingContent.injection)
        ? `${currentContent.injection} ${pendingContent.injection}`.trim()
        : (pendingContent.injection || currentContent.injection || mergedFact);

    return normalizeLoreEntry({
        ...current,
        ...pending,
        id: current.id,
        title: mergeMode ? current.title : (pending.title || current.title),
        locked: current.locked,
        userEdited: current.userEdited || pending.userEdited,
        protected: current.protected || pending.protected,
        tags: uniqueMergedStrings(current.tags, pending.tags),
        scope: {
            ...(current.scope || {}),
            ...(pending.scope || {}),
            characters: uniqueMergedStrings(current.scope?.characters, pending.scope?.characters),
            locations: uniqueMergedStrings(current.scope?.locations, pending.scope?.locations),
            factions: uniqueMergedStrings(current.scope?.factions, pending.scope?.factions),
            topics: uniqueMergedStrings(current.scope?.topics, pending.scope?.topics),
            objects: uniqueMergedStrings(current.scope?.objects, pending.scope?.objects),
            spells: uniqueMergedStrings(current.scope?.spells, pending.scope?.spells),
            schoolYears: uniqueMergedStrings(current.scope?.schoolYears, pending.scope?.schoolYears),
            books: uniqueMergedStrings(current.scope?.books, pending.scope?.books),
            eras: uniqueMergedStrings(current.scope?.eras, pending.scope?.eras),
        },
        content: {
            ...currentContent,
            ...pendingContent,
            fact: mergedFact,
            injection: mergedInjection,
            constraints: uniqueMergedStrings(currentContent.constraints, pendingContent.constraints),
            antiLore: uniqueMergedStrings(currentContent.antiLore, pendingContent.antiLore),
            notes: [currentContent.notes, pendingContent.notes].filter(Boolean).join(' '),
        },
        extensions: {
            ...(current.extensions || {}),
            ...(pending.extensions || {}),
            wandlightGeneration: {
                ...(pending.extensions?.wandlightGeneration || {}),
                acceptedAsOperation: operation,
                acceptedTargetEntryId: current.id,
                acceptedAt: Date.now(),
            },
        },
    });
}

function applyAcceptedLoreSelectionRecommendations(state, entries = []) {
    if (!state.loreSelection || typeof state.loreSelection !== 'object') state.loreSelection = { pinnedIds: [], suppressedIds: [] };
    const pinSet = new Set(Array.isArray(state.loreSelection.pinnedIds) ? state.loreSelection.pinnedIds : []);
    const muteSet = new Set(Array.isArray(state.loreSelection.suppressedIds) ? state.loreSelection.suppressedIds : []);
    for (const entry of normalizeLoreMatrix(entries)) {
        const generation = entry.extensions?.wandlightGeneration || {};
        if (generation.recommendedMute) {
            muteSet.add(entry.id);
            pinSet.delete(entry.id);
        } else if (generation.recommendedPin || entry.protected) {
            pinSet.add(entry.id);
        }
    }
    state.loreSelection.pinnedIds = Array.from(pinSet);
    state.loreSelection.suppressedIds = Array.from(muteSet);
}


function getPendingLoreTimelineSource(meta = {}, entries = []) {
    const source = String(meta?.source || entries?.[0]?.source || entries?.[0]?.sourceInfo?.work || '').toLowerCase();
    if (source.includes('canon')) return 'canon_database';
    if (source.includes('timeline')) return 'timeline_recovery';
    if (source.includes('manual') || source.includes('user')) return 'manual';
    if (source.includes('story') || source.includes('generation') || source.includes('bulk')) return 'story_generation';
    return 'pending_review';
}

function recordAcceptedLoreTimelineMutation(state, before, type, source, summary) {
    const after = captureLoreTimelineState(state);
    recordLoreTimelineEvent(state, { before, after, type, source, summary });
}


/**
 * Accepts pending lore entries by merging them into loreMatrix.
 * Updates the generation ledger so the context is marked as accepted.
 * Locked/user-edited entries in the matrix are preserved.
 * @returns {Object} Updated state
 */
export function acceptPendingLoreEntries() {
    const settings = getSettings();
    const state = getState();
    const pending = normalizeLoreMatrix(state.pendingLoreEntries || []);
    const existing = normalizeLoreMatrix(state.loreMatrix || []);

    if (pending.length === 0) return state;

    const beforeTimeline = captureLoreTimelineState(state);
    const contextKey = state.pendingLoreMeta?.contextKey || buildLoreGenerationKey(state);
    const source = getPendingLoreTimelineSource(state.pendingLoreMeta, pending);

    const prepared = pending.map(entry => preparePendingLoreEntryForAcceptance(entry, existing));
    const merged = mergeLoreEntries(existing, prepared);

    // Accepted lore is intentionally uncapped. The Lore tab uses paged rendering
    // so large matrices stay usable without deleting lower-priority entries.
    state.loreMatrix = merged;
    applyAcceptedLoreSelectionRecommendations(state, prepared);
    state.pendingLoreEntries = [];
    state.pendingLoreMeta = null;

    if (state.loreContext) {
        state.loreContext.lastGenerationSummary = '';
    }

    // Update generation ledger
    if (!state.loreGeneration || typeof state.loreGeneration !== 'object') {
        state.loreGeneration = getDefaultState().loreGeneration;
    }
    state.loreGeneration.lastAcceptedFor = contextKey;
    state.loreGeneration.attempts[contextKey] = {
        ...(state.loreGeneration.attempts[contextKey] || {}),
        status: 'accepted',
        acceptedAt: Date.now(),
        validEntryCount: pending.length,
    };

    recordAcceptedLoreTimelineMutation(state, beforeTimeline, 'accept_pending', source, `Accepted ${pending.length} pending lore entr${pending.length === 1 ? 'y' : 'ies'}.`);
    saveState(state);
    return state;
}

/**
 * Rejects pending lore entries by clearing them without merging.
 * Updates the generation ledger so the context is marked as rejected
 * and auto-generation will not repeat it until context changes.
 * @returns {Object} Updated state
 */
export function rejectPendingLoreEntries() {
    const state = getState();
    const contextKey = state.pendingLoreMeta?.contextKey || buildLoreGenerationKey(state);

    state.pendingLoreEntries = [];
    state.pendingLoreMeta = null;

    if (state.loreContext) {
        state.loreContext.lastGenerationSummary = '';
    }

    // Update generation ledger
    if (!state.loreGeneration || typeof state.loreGeneration !== 'object') {
        state.loreGeneration = getDefaultState().loreGeneration;
    }
    state.loreGeneration.lastRejectedFor = contextKey;
    state.loreGeneration.attempts[contextKey] = {
        ...(state.loreGeneration.attempts[contextKey] || {}),
        status: 'rejected',
        rejectedAt: Date.now(),
    };

    saveState(state);
    return state;
}

/**
 * Accepts a single pending lore entry by index, merging it into the lore matrix.
 * The remaining pending entries stay pending.
 * @param {number} entryIndex - Index into pendingLoreEntries array
 * @returns {{ state: Object, accepted: Object|null }} Updated state and the accepted entry
 */
export function acceptPendingLoreEntry(entryIndex) {
    const state = getState();
    const pending = normalizeLoreMatrix(state.pendingLoreEntries || []);
    const existing = normalizeLoreMatrix(state.loreMatrix || []);

    if (entryIndex < 0 || entryIndex >= pending.length || pending.length === 0) {
        return { state, accepted: null };
    }

    const beforeTimeline = captureLoreTimelineState(state);
    const acceptedEntry = preparePendingLoreEntryForAcceptance(pending[entryIndex], existing);
    const contextKey = state.pendingLoreMeta?.contextKey || buildLoreGenerationKey(state);
    const source = getPendingLoreTimelineSource(state.pendingLoreMeta, [acceptedEntry]);

    // Merge the single entry into the uncapped lore matrix. UI paging handles scale.
    const merged = mergeLoreEntries(existing, [acceptedEntry]);

    state.loreMatrix = merged;
    applyAcceptedLoreSelectionRecommendations(state, [acceptedEntry]);

    // Remove the accepted entry from pending
    state.pendingLoreEntries = pending.filter((_, i) => i !== entryIndex);

    // If no more pending entries, clear the meta
    if (state.pendingLoreEntries.length === 0) {
        state.pendingLoreMeta = null;
        if (state.loreContext) {
            state.loreContext.lastGenerationSummary = '';
        }
    }

    // Update generation ledger
    if (!state.loreGeneration || typeof state.loreGeneration !== 'object') {
        state.loreGeneration = getDefaultState().loreGeneration;
    }
    state.loreGeneration.lastAcceptedFor = contextKey;
    state.loreGeneration.attempts[contextKey] = {
        ...(state.loreGeneration.attempts[contextKey] || {}),
        status: state.pendingLoreEntries.length === 0 ? 'accepted' : 'partial_accept',
        acceptedAt: Date.now(),
        acceptedEntryCount: (state.loreGeneration.attempts[contextKey]?.acceptedEntryCount || 0) + 1,
    };

    recordAcceptedLoreTimelineMutation(state, beforeTimeline, 'accept_pending_entry', source, `Accepted pending lore: ${acceptedEntry.title || acceptedEntry.id}.`);
    saveState(state);
    return { state, accepted: acceptedEntry };
}

/**
 * Rejects a single pending lore entry by index, removing it from pending.
 * The remaining pending entries stay pending.
 * @param {number} entryIndex - Index into pendingLoreEntries array
 * @returns {{ state: Object, rejected: Object|null }} Updated state and the rejected entry
 */
export function rejectPendingLoreEntry(entryIndex) {
    const state = getState();
    const pending = normalizeLoreMatrix(state.pendingLoreEntries || []);

    if (entryIndex < 0 || entryIndex >= pending.length || pending.length === 0) {
        return { state, rejected: null };
    }

    const rejectedEntry = pending[entryIndex];
    const contextKey = state.pendingLoreMeta?.contextKey || buildLoreGenerationKey(state);

    // Remove the rejected entry from pending
    state.pendingLoreEntries = pending.filter((_, i) => i !== entryIndex);

    // If no more pending entries, clear the meta
    if (state.pendingLoreEntries.length === 0) {
        state.pendingLoreMeta = null;
        if (state.loreContext) {
            state.loreContext.lastGenerationSummary = '';
        }
    }

    // Update generation ledger
    if (!state.loreGeneration || typeof state.loreGeneration !== 'object') {
        state.loreGeneration = getDefaultState().loreGeneration;
    }
    state.loreGeneration.lastRejectedFor = contextKey;
    state.loreGeneration.attempts[contextKey] = {
        ...(state.loreGeneration.attempts[contextKey] || {}),
        status: state.pendingLoreEntries.length === 0 ? 'rejected' : 'partial_reject',
        rejectedAt: Date.now(),
        rejectedEntryCount: (state.loreGeneration.attempts[contextKey]?.rejectedEntryCount || 0) + 1,
    };

    saveState(state);
    return { state, rejected: rejectedEntry };
}


// ── Utility: deep-merge defaults ────────────────────────────────────────────────

/**
 * Deep-merges default values into target for missing or invalid keys.
 * Returns target (mutated in place, but safe since these are schema-level objects).
 * @param {*} target - The existing value (may be undefined/null/non-object)
 * @param {Object} defaults - Default object to merge
 * @returns {Object} target with defaults filled in
 */
export function restoreLoreTimelineEntriesToPending(eventId, entryIds = null) {
    const state = getState();
    const result = restoreTimelineEntriesToPending(state, eventId, entryIds);
    if (result.restored > 0) saveState(state);
    return { state, ...result };
}

function mergeDefaults(target, defaults) {
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
        return { ...defaults };
    }
    const result = { ...target };
    for (const key of Object.keys(defaults)) {
        if (result[key] === undefined || result[key] === null) {
            result[key] = defaults[key];
        }
    }
    return result;
}

// ── Export the default state factory for convenience ────────────────────────────
export { getDefaultState };
