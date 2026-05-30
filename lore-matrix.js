/**
 * lore-matrix.js — Wandlight Continuity
 * Pure helpers for lore normalization, activation, and merging.
 * No SillyTavern calls. All functions are pure or use only their arguments.
 *
 * Imported by: state-manager.js, memo-builder.js, lore-generator.js, index.js
 */

const VALID_CATEGORIES = new Set([
    'canon', 'au', 'secret', 'rumor', 'lie', 'relationship', 'location', 'rule', 'timeline',
]);

const VALID_CANON_STATUS = new Set([
    'canon', 'divergent', 'au', 'fanon', 'unknown',
]);

const VALID_TRUTH_STATUS = new Set([
    'true', 'false', 'public-belief', 'rumor', 'contested', 'hidden',
]);

const VALID_REVEAL_POLICIES = new Set([
    'public', 'private', 'do_not_reveal', 'only_if_knower_present', 'only_if_user_reveals',
]);

const VALID_STATUS = new Set([
    'active', 'disabled', 'pinned', 'archived',
]);

const VALID_TIME_TRAVEL_MODES = new Set([
    'none', 'visitor_from_future', 'past_changed', 'alternate_branch',
]);

function asString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function asStringArray(value) {
    return Array.isArray(value)
        ? value.filter(v => typeof v === 'string').map(v => v.trim()).filter(Boolean)
        : [];
}

function asBoolean(value, fallback = false) {
    return typeof value === 'boolean' ? value : fallback;
}

function asPriority(value) {
    if (!Number.isFinite(value)) return 50;
    return Math.max(0, Math.min(100, Math.round(value)));
}

function stableIdFromTitle(title, fallback = 'lore_entry') {
    const base = String(title || fallback)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 72);

    return base || fallback;
}

// ── Lore Context normalization ──────────────────────────────────────────────────

/**
 * Normalizes a lore context object to its canonical shape.
 * @param {*} input - Raw lore context (may be partial or malformed)
 * @returns {Object} Normalized lore context
 */
export function normalizeLoreContext(input = {}) {
    if (!input || typeof input !== 'object') input = {};
    const mode = asString(input.timeTravelMode);
    return {
        sceneDate: asString(input.sceneDate),
        subjectiveDate: asString(input.subjectiveDate),
        canonBoundary: asString(input.canonBoundary),
        branchId: asString(input.branchId) || 'main',
        timeTravelMode: VALID_TIME_TRAVEL_MODES.has(mode) ? mode : 'none',
        lastDetectedAt: Number.isFinite(input.lastDetectedAt) ? input.lastDetectedAt : 0,
        lastGeneratedFor: asString(input.lastGeneratedFor),
        lastGenerationSummary: asString(input.lastGenerationSummary),
    };
}

// ── Lore Entry normalization ────────────────────────────────────────────────────

/**
 * Normalizes a single lore entry to its canonical shape.
 * @param {*} input - Raw lore entry (may be partial or malformed)
 * @returns {Object} Normalized lore entry
 */
export function normalizeLoreEntry(input = {}) {
    if (!input || typeof input !== 'object') input = {};
    const title = asString(input.title) || asString(input.fact) || 'Lore Entry';
    const category = asString(input.category);
    const canonStatus = asString(input.canonStatus);
    const truthStatus = asString(input.truthStatus);
    const revealPolicy = asString(input.revealPolicy);
    const status = asString(input.status);

    const activeWhen = input.activeWhen && typeof input.activeWhen === 'object' && !Array.isArray(input.activeWhen)
        ? input.activeWhen
        : {};

    return {
        id: asString(input.id) || stableIdFromTitle(title),
        title,
        category: VALID_CATEGORIES.has(category) ? category : 'canon',
        fact: asString(input.fact),
        canonStatus: VALID_CANON_STATUS.has(canonStatus) ? canonStatus : 'unknown',
        truthStatus: VALID_TRUTH_STATUS.has(truthStatus) ? truthStatus : 'true',

        validFrom: asString(input.validFrom),
        validTo: asString(input.validTo),
        branchId: asString(input.branchId) || 'main',

        whoKnowsTruth: asStringArray(input.whoKnowsTruth),
        whoSuspects: asStringArray(input.whoSuspects),
        whoBelievesPublicVersion: asStringArray(input.whoBelievesPublicVersion),
        publicVersion: asString(input.publicVersion),

        revealPolicy: VALID_REVEAL_POLICIES.has(revealPolicy) ? revealPolicy : 'private',

        activeWhen: {
            erasAny: asStringArray(activeWhen.erasAny),
            locationsAny: asStringArray(activeWhen.locationsAny),
            charactersPresentAny: asStringArray(activeWhen.charactersPresentAny),
            tagsAny: asStringArray(activeWhen.tagsAny),
        },

        priority: asPriority(input.priority),
        status: VALID_STATUS.has(status) ? status : 'active',
        source: asString(input.source) || 'model-generated',
        userEdited: asBoolean(input.userEdited),
        locked: asBoolean(input.locked),
        notes: asString(input.notes),
    };
}

/**
 * Normalizes a full lore matrix array.
 * @param {*} value - Raw lore matrix (may be anything)
 * @returns {Object[]} Normalized lore entries
 */
export function normalizeLoreMatrix(value) {
    if (!Array.isArray(value)) return [];
    return value
        .map(normalizeLoreEntry)
        .filter(entry => entry.id && entry.title && entry.fact);
}

// ── Activation helpers ──────────────────────────────────────────────────────────

function lowerSet(values) {
    return new Set(asStringArray(values).map(v => v.toLowerCase()));
}

function anyOverlap(a, b) {
    const aa = lowerSet(a);
    const bb = lowerSet(b);
    for (const x of aa) {
        if (bb.has(x)) return true;
        for (const y of bb) {
            if (x.includes(y) || y.includes(x)) return true;
        }
    }
    return false;
}

function entryBranchMatches(entry, state) {
    const branch = state?.loreContext?.branchId || 'main';

    // No branchId means the entry applies everywhere (legacy behavior).
    if (!entry.branchId) return true;
    // Explicit "global" means the entry applies in all branches.
    if (entry.branchId === 'global') return true;
    // "main" entries only activate in the main branch.
    if (entry.branchId === 'main') return branch === 'main';
    // Otherwise match the exact branch.
    return entry.branchId === branch;
}

function activeWhenMatches(entry, state) {
    const activeWhen = entry.activeWhen || {};
    const era = state?.canon?.era ? [state.canon.era] : [];
    const location = state?.scene?.location ? [state.scene.location] : [];
    const present = state?.scene?.presentCharacters || [];

    if (activeWhen.erasAny?.length && !anyOverlap(activeWhen.erasAny, era)) return false;
    if (activeWhen.locationsAny?.length && !anyOverlap(activeWhen.locationsAny, location)) return false;
    if (activeWhen.charactersPresentAny?.length && !anyOverlap(activeWhen.charactersPresentAny, present)) return false;

    return true;
}

/**
 * Determines whether the current scene date falls within an entry's date window.
 * Supports ISO 8601 YYYY-MM-DD dates for precise comparison,
 * and falls back to permissive fuzzy matching for HP-era dates.
 */
function dateWindowMatches(entry, state) {
    const raw = state?.loreContext?.sceneDate || state?.canon?.inUniverseDate || '';
    if (!raw) return true;

    const scene = parseIsoDate(raw);
    const from = parseIsoDate(entry.validFrom);
    const to = parseIsoDate(entry.validTo);

    // If we have ISO dates on both sides, do a precise comparison.
    if (scene && (from || to)) {
        if (from && scene < from) return false;
        if (to && scene > to) return false;
        return true;
    }

    // Fallback: permissive substring matching for non-ISO dates
    // (e.g. "early September 1993", "Half-Blood Prince era")
    if (entry.validFrom && entry.validTo && entry.validFrom === entry.validTo) {
        return raw.includes(entry.validFrom) || entry.validFrom.includes(raw);
    }

    // If no ISO parse on either side and no exact window, treat as always eligible.
    return true;
}

/**
 * Parses a value as an ISO 8601 date (YYYY-MM-DD).
 * Returns a Date object at midnight UTC, or null if the value is not ISO.
 * @param {string} value
 * @returns {Date|null}
 */
function parseIsoDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Determines whether a lore entry is currently active based on
 * status, branch, date window, and trigger conditions.
 * @param {Object} entry - A lore entry (normalized)
 * @param {Object} state - WandlightState
 * @returns {boolean}
 */
export function isLoreEntryActive(entry, state) {
    const e = normalizeLoreEntry(entry);

    if (e.status === 'archived' || e.status === 'disabled') return false;
    if (e.status === 'pinned') return true;
    if (!entryBranchMatches(e, state)) return false;
    if (!dateWindowMatches(e, state)) return false;
    if (!activeWhenMatches(e, state)) return false;

    return true;
}

/**
 * Returns currently active lore entries, sorted by priority descending,
 * limited to `limit` entries.
 * @param {Object} state - WandlightState
 * @param {number} [limit=6] - Max entries to return
 * @returns {Object[]} Active lore entries
 */
export function getActiveLoreEntries(state, limit = 6) {
    const entries = normalizeLoreMatrix(state?.loreMatrix || []);
    return entries
        .filter(entry => isLoreEntryActive(entry, state))
        .sort((a, b) => b.priority - a.priority || a.title.localeCompare(b.title))
        .slice(0, limit);
}

// ── Merging ─────────────────────────────────────────────────────────────────────

/**
 * Merges incoming lore entries into the existing matrix.
 * Locked or user-edited entries are never overwritten.
 * Entries are matched by id.
 * @param {Object[]} existing - Current lore matrix
 * @param {Object[]} incoming - New entries to merge
 * @returns {Object[]} Merged lore matrix
 */
export function mergeLoreEntries(existing, incoming) {
    const byId = new Map();

    for (const entry of normalizeLoreMatrix(existing)) {
        byId.set(entry.id, entry);
    }

    for (const entry of normalizeLoreMatrix(incoming)) {
        const current = byId.get(entry.id);

        if (current?.locked || current?.userEdited) {
            continue;
        }

        byId.set(entry.id, {
            ...(current || {}),
            ...entry,
        });
    }

    return Array.from(byId.values());
}

// ── Generation key (for tracking when lore was last generated) ─────────────────

/**
 * Builds a fingerprint string representing the current context.
 * Used to detect when lore should be regenerated.
 * @param {Object} state - WandlightState
 * @returns {string} Context fingerprint
 */
export function buildLoreGenerationKey(state) {
    const ctx = normalizeLoreContext(state?.loreContext || {});
    return [
        ctx.sceneDate,
        ctx.subjectiveDate,
        ctx.canonBoundary || state?.canon?.canonBoundary || '',
        ctx.branchId,
        ctx.timeTravelMode,
        state?.scene?.location || '',
        ...(state?.scene?.presentCharacters || []),
    ].filter(Boolean).join('|');
}