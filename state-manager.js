/**
 * state-manager.js — Wandlight Continuity
 * State CRUD, settings I/O, migration, delta merging, snapshot history, and undo.
 * All reads reacquire from SillyTavern's context — nothing is cached.
 *
 * Imports: constants.js
 * Imported by: index.js, memo-builder.js, extractor.js, ui.js
 */

import { MODULE_KEY, DEFAULT_SETTINGS, getDefaultState, SCHEMA_VERSION, LOG_PREFIX } from './constants.js';
import { normalizeLoreContext, normalizeLoreMatrix, mergeLoreEntries, normalizeLoreEntry, buildLoreGenerationKey } from './lore-matrix.js';

// ── Settings I/O ────────────────────────────────────────────────────────────────

/**
 * Reads extensionSettings.wandlight_continuity, deep-merges defaults for any
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
    if (!extensionSettings[MODULE_KEY]) {
        extensionSettings[MODULE_KEY] = {};
    }
    const stored = extensionSettings[MODULE_KEY];
    // Deep-merge defaults into stored, preserving any existing keys
    const merged = { ...DEFAULT_SETTINGS, ...stored };
    // Write back merged defaults so the object is complete going forward
    extensionSettings[MODULE_KEY] = merged;
    return merged;
}

/**
 * Writes settings to extensionSettings.wandlight_continuity and persists
 * via saveSettingsDebounced().
 * @param {Object} settings - WandlightSettings to save
 */
export function saveSettings(settings) {
    const ctx = SillyTavern.getContext();
    if (!ctx || !ctx.extensionSettings) return;
    const { extensionSettings, saveSettingsDebounced } = ctx;
    extensionSettings[MODULE_KEY] = settings;
    if (typeof saveSettingsDebounced === 'function') {
        saveSettingsDebounced();
    }
}

// ── State I/O ───────────────────────────────────────────────────────────────────

/**
 * Reads chatMetadata.wandlight_continuity, migrates if needed, merges with
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
    let state = chatMetadata[MODULE_KEY];
    if (!state || typeof state !== 'object') {
        state = getDefaultState();
        chatMetadata[MODULE_KEY] = state;
        return state;
    }
    // Always run migration on read
    state = migrateState(state);
    // Ensure arrays exist post-migration
    if (!Array.isArray(state.memoHistory)) state.memoHistory = [];
    if (!Array.isArray(state.stateHistory)) state.stateHistory = [];
    if (state.lastDelta === undefined) state.lastDelta = null;
    chatMetadata[MODULE_KEY] = state;
    return state;
}

/**
 * Writes state to chatMetadata.wandlight_continuity and persists via saveMetadata().
 * @param {Object} state - WandlightState to save
 */
export function saveState(state) {
    const ctx = SillyTavern.getContext();
    if (!ctx || !ctx.chatMetadata) {
        console.warn(`${LOG_PREFIX} chatMetadata not available, cannot save state`);
        return;
    }
    const { chatMetadata, saveMetadata } = ctx;
    if (!state._version) {
        state._version = SCHEMA_VERSION;
    }
    chatMetadata[MODULE_KEY] = state;
    if (typeof saveMetadata === 'function') {
        saveMetadata();
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

    // Strip the snapshot of its own history/meta fields to keep it compact
    snapshotState.stateHistory = [];
    snapshotState.memoHistory = [];
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
    if (typeof saveMetadata === 'function') {
        saveMetadata();
    }
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

    // ── Always normalize lore fields post-migration ────────────────────────
    // Even v4 states can become malformed through manual editing or old imports.
    state.loreContext = normalizeLoreContext(state.loreContext || {});
    state.loreMatrix = normalizeLoreMatrix(state.loreMatrix || []);
    state.pendingLoreEntries = normalizeLoreMatrix(state.pendingLoreEntries || []);

    normalizeContinuityStructure(state);

    if (!state.loreCompressionStatus || typeof state.loreCompressionStatus !== 'object') {
        state.loreCompressionStatus = getDefaultState().loreCompressionStatus;
    } else {
        const defaults = getDefaultState().loreCompressionStatus;
        state.loreCompressionStatus = mergeDefaults(state.loreCompressionStatus, defaults);
        state.loreCompressionStatus.lastCompressedAt = Number.isFinite(Number(state.loreCompressionStatus.lastCompressedAt)) ? Number(state.loreCompressionStatus.lastCompressedAt) : 0;
        state.loreCompressionStatus.lastTokenEstimate = Number.isFinite(Number(state.loreCompressionStatus.lastTokenEstimate)) ? Number(state.loreCompressionStatus.lastTokenEstimate) : 0;
        state.loreCompressionStatus.turnsSinceCompression = Number.isFinite(Number(state.loreCompressionStatus.turnsSinceCompression)) ? Number(state.loreCompressionStatus.turnsSinceCompression) : 0;
    }

    // Normalize lorePanel
    if (!state.lorePanel || typeof state.lorePanel !== 'object') {
        state.lorePanel = getDefaultState().lorePanel;
    } else {
        state.lorePanel.isOpen = state.lorePanel.isOpen !== false;
        state.lorePanel.collapsed = !!state.lorePanel.collapsed;
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
        state.lorePanel.width = Number.isFinite(Number(state.lorePanel.width)) && Number(state.lorePanel.width) >= 320 ? Number(state.lorePanel.width) : 420;
        state.lorePanel.height = Number.isFinite(Number(state.lorePanel.height)) && Number(state.lorePanel.height) >= 260 ? Number(state.lorePanel.height) : 520;
        if (state.lorePanel.x !== undefined) {
            state.lorePanel.x = Number.isFinite(Number(state.lorePanel.x)) ? Number(state.lorePanel.x) : undefined;
        }
        if (state.lorePanel.y !== undefined) {
            state.lorePanel.y = Number.isFinite(Number(state.lorePanel.y)) ? Number(state.lorePanel.y) : undefined;
        }
    }

    // Normalize loreSelection
    if (!state.loreSelection || typeof state.loreSelection !== 'object') {
        state.loreSelection = getDefaultState().loreSelection;
    } else {
        state.loreSelection.pinnedIds = Array.isArray(state.loreSelection.pinnedIds) ? state.loreSelection.pinnedIds : [];
        state.loreSelection.suppressedIds = Array.isArray(state.loreSelection.suppressedIds) ? state.loreSelection.suppressedIds : [];
    }

    // Ensure ledger always has a valid structure
    if (!state.loreGeneration || typeof state.loreGeneration !== 'object') {
        state.loreGeneration = getDefaultState().loreGeneration;
    }
    if (typeof state.loreGeneration.attempts !== 'object' || Array.isArray(state.loreGeneration.attempts)) {
        state.loreGeneration.attempts = {};
    }
    // Clean up orphaned metadata
    if (state.pendingLoreMeta && state.pendingLoreEntries?.length === 0) {
        state.pendingLoreMeta = null;
    }

    return state;
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

    if (!state.scene || typeof state.scene !== 'object' || Array.isArray(state.scene)) {
        state.scene = { ...defaults.scene };
    } else {
        state.scene = { ...defaults.scene, ...state.scene };
        state.scene.presentCharacters = Array.isArray(state.scene.presentCharacters) ? state.scene.presentCharacters.filter(Boolean).map(String) : [];
        state.scene.nearbyCharacters = Array.isArray(state.scene.nearbyCharacters) ? state.scene.nearbyCharacters.filter(Boolean).map(String) : [];
    }

    normalizeStateEntries(state);

    if (!state.continuityCompressionStatus || typeof state.continuityCompressionStatus !== 'object') {
        state.continuityCompressionStatus = getDefaultState().continuityCompressionStatus || {
            lastCompressedAt: 0,
            lastSignature: '',
            lastMode: 'direct',
            lastTokenEstimate: 0,
            turnsSinceCompression: 0,
            lastChatLength: 0,
        };
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

function clampEmotion(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(-5, Math.min(5, Math.round(n)));
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
const KNOWN_CHANGE_KEYS = new Set([
    'canon', 'scene', 'characters', 'inventory', 'objectives', 'knowledge', 'secrets', 'relationships', 'threads', 'continuityFlags',
]);

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
        applyArrayDelta(next.characters, changes.characters, 'name', normalizeCharacter);
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
    const { increment = true } = options;
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

    saveState(state);
    return state;
}

/**
 * Sets pending lore entries with full lifecycle metadata.
 * This is the authoritative way to create a pending lore proposal.
 * Normalizes entries, creates pendingLoreMeta, and updates the ledger.
 *
 * Does NOT update loreContext.lastGeneratedFor directly — that's handled
 * by loreContext metadata in setLoreContext.
 *
 * @param {Object[]} entries - Array of raw lore entry objects
 * @param {Object} meta - Proposal metadata
 * @param {string} meta.contextKey - The generation context key
 * @param {string} [meta.source='manual'] - 'auto' or 'manual'
 * @param {string} [meta.summary=''] - One-line generation summary
 * @param {string} [meta.id] - Optional batch id (auto-generated if omitted)
 * @param {number} [meta.rawEntryCount] - Pre-normalization entry count
 * @returns {{ state: Object, changed: boolean }} Updated state and whether a proposal was created
 */
export function setPendingLoreProposal(entries, meta, options = {}) {
    const {
        snapshot = true,
        snapshotLabel = 'Generate pending lore entries',
    } = options;

    const state = getState();
    const settings = getSettings();
    const normalized = normalizeLoreMatrix(entries || []);

    if (normalized.length === 0) {
        return { state, changed: false };
    }

    if (snapshot) {
        pushStateSnapshot(state, snapshotLabel, settings.maxSnapshots);
    }

    const contextKey = meta.contextKey || buildLoreGenerationKey(state);
    const rawEntryCount = meta.rawEntryCount ?? normalized.length;

    state.pendingLoreEntries = normalized;
    state.pendingLoreMeta = {
        id: meta.id || `lore_batch_${Date.now()}`,
        contextKey,
        source: meta.source || 'manual',
        status: 'pending',
        createdAt: Date.now(),
        summary: meta.summary || '',
        rawEntryCount,
        validEntryCount: normalized.length,
        droppedEntryCount: Math.max(0, rawEntryCount - normalized.length),
    };

    // Sync loreContext for backward compatibility
    if (state.loreContext) {
        state.loreContext.lastGeneratedFor = contextKey;
        state.loreContext.lastGenerationSummary = meta.summary || '';
    }

    // Update generation ledger
    if (!state.loreGeneration || typeof state.loreGeneration !== 'object') {
        state.loreGeneration = getDefaultState().loreGeneration;
    }
    state.loreGeneration.lastProposedFor = contextKey;
    state.loreGeneration.attempts[contextKey] = {
        ...(state.loreGeneration.attempts[contextKey] || {}),
        status: 'pending',
        lastProposedAt: Date.now(),
        validEntryCount: normalized.length,
        lastSource: meta.source || 'manual',
    };

    saveState(state);
    return { state, changed: true };
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

/**
 * Backward-compatible wrapper that delegates to setPendingLoreProposal.
 * Used by code that hasn't been updated to the lifecycle ledger yet.
 *
 * @param {Object[]} entries - Array of lore entry objects
 * @param {string} [summary] - One-line generation summary
 * @param {string} [generationKey] - Context key this generation was produced for
 * @returns {Object} Updated state
 */
export function setPendingLoreEntries(entries, summary, generationKey) {
    return setPendingLoreProposal(entries, {
        contextKey: generationKey || buildLoreGenerationKey(getState()),
        source: 'manual',
        summary,
        rawEntryCount: (entries || []).length,
    }).state;
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

    const contextKey = state.pendingLoreMeta?.contextKey || buildLoreGenerationKey(state);

    let merged = mergeLoreEntries(existing, pending);

    // Enforce maxLoreEntriesInMatrix cap, preserving locked/userEdited/pinned entries.
    const max = Number(settings.maxLoreEntriesInMatrix) || 50;
    if (merged.length > max) {
        const protectedEntries = merged.filter(e => e.locked || e.userEdited || e.status === 'pinned');
        const regularEntries = merged
            .filter(e => !(e.locked || e.userEdited || e.status === 'pinned'))
            .sort((a, b) => (b.priority || 50) - (a.priority || 50) || (a.title || '').localeCompare(b.title || ''));

        if (protectedEntries.length > max) {
            merged = protectedEntries;
        } else {
            merged = [...protectedEntries, ...regularEntries].slice(0, max);
        }
    }

    state.loreMatrix = merged;
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

    const acceptedEntry = pending[entryIndex];
    const contextKey = state.pendingLoreMeta?.contextKey || buildLoreGenerationKey(state);

    // Merge the single entry into loreMatrix
    const settings = getSettings();
    let merged = mergeLoreEntries(existing, [acceptedEntry]);

    // Enforce cap
    const max = Number(settings.maxLoreEntriesInMatrix) || 50;
    if (merged.length > max) {
        const protectedEntries = merged.filter(e => e.locked || e.userEdited || e.status === 'pinned');
        const regularEntries = merged
            .filter(e => !(e.locked || e.userEdited || e.status === 'pinned'))
            .sort((a, b) => (b.priority || 50) - (a.priority || 50) || (a.title || '').localeCompare(b.title || ''));
        if (protectedEntries.length > max) {
            merged = protectedEntries;
        } else {
            merged = [...protectedEntries, ...regularEntries].slice(0, max);
        }
    }

    state.loreMatrix = merged;

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
