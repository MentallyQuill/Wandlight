/**
 * lore-matrix.js — Wandlight Continuity
 * Pure helpers for lore normalization, activation, and merging.
 * No SillyTavern calls. All functions are pure or use only their arguments.
 *
 * Imported by: state-manager.js, memo-builder.js, lore-generator.js, index.js
 */

const DEFAULT_CATEGORIES = [
    'canon', 'au', 'secret', 'rumor', 'lie', 'relationship', 'location', 'rule', 'timeline',
    'character', 'event', 'item', 'knowledge', 'place', 'faction', 'spell', 'artifact',
    'constraint', 'future_guard', 'age', 'behavior', 'skill', 'institution', 'object', 'emotion',
];

const DEFAULT_CANON_STATUS = [
    'canon', 'divergent', 'au', 'fanon', 'contested', 'unknown',
];

const DEFAULT_TRUTH_STATUS = [
    'true', 'false', 'public-belief', 'public_belief', 'rumor', 'contested', 'hidden',
];

const DEFAULT_REVEAL_POLICIES = [
    'public', 'private', 'do_not_reveal', 'only_if_knower_present', 'only_if_user_reveals',
];

const VALID_STATUS = new Set([
    'active', 'disabled', 'pinned', 'archived',
]);

const VALID_TIME_TRAVEL_MODES = new Set([
    'none', 'visitor_from_future', 'past_changed', 'alternate_branch',
]);

const KNOWN_TOP_LEVEL_FIELDS = new Set([
    'schemaVersion', 'id', 'title', 'name', 'kind', 'gateType', 'category', 'canonStatus', 'truthStatus',
    'revealPolicy', 'tags', 'priority', 'status', 'protected', 'locked', 'userEditable', 'userEdited',
    'date', 'scope', 'visibility', 'content', 'effects', 'source', 'sourceInfo', 'ui', 'extensions',
    // legacy aliases
    'fact', 'description', 'detail', 'text', 'summary', 'notes', 'validFrom', 'validTo', 'branchId',
    'whoKnowsTruth', 'whoSuspects', 'whoBelievesPublicVersion', 'publicVersion', 'activeWhen',
    'appliesTo', 'confidence',
]);

function asString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function asNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function asStringArray(value) {
    if (Array.isArray(value)) {
        return value
            .flatMap(v => Array.isArray(v) ? v : [v])
            .map(v => typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '')
            .filter(Boolean);
    }
    if (typeof value === 'string') {
        return value.split(',').map(v => v.trim()).filter(Boolean);
    }
    return [];
}

function uniqueLimitedStringArray(values, limit = 32) {
    const seen = new Set();
    const out = [];

    for (const raw of asStringArray(values)) {
        const text = String(raw || '').trim();
        if (!text) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(text);
        if (out.length >= limit) break;
    }

    return out;
}

function asFirstString(...values) {
    for (const value of values) {
        if (value && typeof value === 'object' && !Array.isArray(value)) continue;
        const text = asString(value);
        if (text) return text;
    }
    return '';
}

function asPlainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asBoolean(value, fallback = false) {
    return typeof value === 'boolean' ? value : fallback;
}

function asPriority(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 50;
    return Math.max(0, Math.min(100, Math.round(n)));
}

function stableIdFromTitle(title, fallback = 'lore_entry') {
    const base = String(title || fallback)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 72);

    return base || fallback;
}

function normalizeEnum(value, fallback, allowed = null) {
    const raw = asString(value);
    if (!raw) return fallback;
    if (!allowed) return raw;
    const set = new Set(allowed);
    return set.has(raw) ? raw : raw;
}

export function normalizeLoreTag(value) {
    const cleaned = String(value || '')
        .trim()
        .replace(/[\r\n]+/g, ' ')
        .replace(/[^\p{L}\p{N} _-]+/gu, '')
        .replace(/\s+/g, ' ')
        .trim();

    if (!cleaned) return '';

    const words = cleaned.split(' ').filter(Boolean);
    const compact = words.length > 3 ? words.slice(0, 3).join(' ') : cleaned;
    return compact.slice(0, 32).trim();
}

function normalizeLoreTags(value, limit = 10) {
    const seen = new Set();
    const output = [];

    for (const raw of asStringArray(value)) {
        const tag = normalizeLoreTag(raw);
        const key = tag.toLowerCase();
        if (!tag || seen.has(key)) continue;
        seen.add(key);
        output.push(tag);
        if (output.length >= limit) break;
    }

    return output;
}

function normalizeStringMap(value) {
    if (Array.isArray(value)) {
        return Object.fromEntries(asStringArray(value).map(v => [v, 'unknown']));
    }
    const input = asPlainObject(value);
    const out = {};
    for (const [key, val] of Object.entries(input)) {
        const cleanKey = asString(key);
        if (!cleanKey) continue;
        if (Array.isArray(val)) out[cleanKey] = asStringArray(val).join(', ');
        else if (val && typeof val === 'object') out[cleanKey] = JSON.stringify(val);
        else out[cleanKey] = asString(val) || String(val ?? '').trim() || 'unknown';
    }
    return out;
}

function stringMapKeys(value) {
    return Object.keys(normalizeStringMap(value));
}

function preserveUnknownFields(input) {
    const unknown = {};
    for (const [key, value] of Object.entries(asPlainObject(input))) {
        if (!KNOWN_TOP_LEVEL_FIELDS.has(key)) {
            unknown[key] = value;
        }
    }
    return unknown;
}

function mergeExtensions(input) {
    const extensions = { ...asPlainObject(input.extensions) };
    const unknown = preserveUnknownFields(input);
    if (Object.keys(unknown).length) {
        extensions.unrecognized = {
            ...(asPlainObject(extensions.unrecognized)),
            ...unknown,
        };
    }
    return extensions;
}

function normalizeDateBlock(input) {
    const raw = asPlainObject(input.date);
    return {
        validFrom: asFirstString(raw.validFrom, input.validFrom),
        validTo: asFirstString(raw.validTo, input.validTo),
        precision: asFirstString(raw.precision, input.datePrecision) || 'unknown',
        schoolYear: raw.schoolYear ?? input.schoolYear ?? null,
        book: asFirstString(raw.book, input.book),
        era: asFirstString(raw.era, input.era),
        label: asFirstString(raw.label, input.dateLabel),
        approximate: asBoolean(raw.approximate, false),
    };
}

function normalizeScope(input) {
    const raw = asPlainObject(input.scope);
    const activeWhen = asPlainObject(input.activeWhen);
    const appliesTo = asStringArray(input.appliesTo);
    const knownScopeFields = new Set(['characters', 'locations', 'factions', 'topics', 'objects', 'spells', 'schoolYears', 'books', 'eras']);
    const extra = {};

    for (const [key, value] of Object.entries(raw)) {
        if (!knownScopeFields.has(key)) extra[key] = value;
    }

    return {
        characters: uniqueLimitedStringArray([raw.characters, activeWhen.charactersPresentAny, appliesTo], 32),
        locations: uniqueLimitedStringArray([raw.locations, activeWhen.locationsAny], 32),
        factions: uniqueLimitedStringArray(raw.factions, 24),
        topics: uniqueLimitedStringArray([raw.topics, activeWhen.tagsAny], 40),
        objects: uniqueLimitedStringArray(raw.objects, 24),
        spells: uniqueLimitedStringArray(raw.spells, 24),
        schoolYears: uniqueLimitedStringArray(raw.schoolYears, 12),
        books: uniqueLimitedStringArray(raw.books, 12),
        eras: uniqueLimitedStringArray([raw.eras, activeWhen.erasAny], 24),
        ...extra,
    };
}

function normalizeVisibility(input) {
    const raw = asPlainObject(input.visibility);
    return {
        publicFrom: asString(raw.publicFrom),
        secretUntil: asString(raw.secretUntil),
        knownBy: normalizeStringMap(raw.knownBy ?? input.knownBy ?? input.whoKnowsTruth),
        notKnownByBefore: normalizeStringMap(raw.notKnownByBefore ?? input.notKnownByBefore),
        suspectedBy: normalizeStringMap(raw.suspectedBy ?? input.suspectedBy ?? input.whoSuspects),
        believedBy: normalizeStringMap(raw.believedBy ?? input.whoBelievesPublicVersion),
    };
}

function normalizeContentBlock(input, factFallback) {
    const raw = asPlainObject(input.content);
    const publicVersion = asFirstString(raw.publicVersion, input.publicVersion);
    return {
        fact: asFirstString(raw.fact, raw.text, input.fact, input.description, input.detail, input.text, input.summary, factFallback),
        injection: asFirstString(raw.injection, input.injection),
        constraints: asStringArray(raw.constraints ?? input.constraints),
        antiLore: asStringArray(raw.antiLore ?? input.antiLore),
        publicVersion,
        notes: asFirstString(raw.notes, input.notes),
    };
}

function normalizeEffectsBlock(input) {
    const raw = asPlainObject(input.effects);
    return {
        addsTags: asStringArray(raw.addsTags),
        blocksTermsBeforeDate: asStringArray(raw.blocksTermsBeforeDate),
        protectsEntries: asStringArray(raw.protectsEntries),
        stateHints: asPlainObject(raw.stateHints),
        injectionRules: asPlainObject(raw.injectionRules),
    };
}

function normalizeSourceBlock(input) {
    const raw = asPlainObject(input.source);
    if (typeof input.source === 'string') {
        return {
            id: input.source,
            work: '',
            book: '',
            chapter: '',
            confidence: asNumber(input.confidence, 0.5),
            notes: '',
        };
    }
    return {
        id: asFirstString(raw.id, input.sourceId),
        work: asFirstString(raw.work, input.work),
        book: asFirstString(raw.book, input.sourceBook),
        chapter: asFirstString(raw.chapter, input.chapter),
        confidence: Math.max(0, Math.min(1, asNumber(raw.confidence ?? input.confidence, 0.5))),
        notes: asFirstString(raw.notes, input.sourceNotes),
    };
}

function normalizeUiBlock(input) {
    const raw = asPlainObject(input.ui);
    return {
        color: asString(raw.color),
        textColor: asString(raw.textColor),
        icon: asString(raw.icon),
        defaultCollapsed: asBoolean(raw.defaultCollapsed, false),
    };
}

function deriveActiveWhen(scope, input) {
    // Important: activeWhen is a legacy compatibility block. Do NOT mirror scope
    // back into activeWhen here. Mirroring scope <-> activeWhen caused exponential
    // chatMetadata growth in older builds because each normalization pass copied
    // one block into the other. Activation now checks scope directly at runtime.
    const activeWhen = asPlainObject(input.activeWhen);
    return {
        erasAny: uniqueLimitedStringArray(activeWhen.erasAny, 16),
        locationsAny: uniqueLimitedStringArray(activeWhen.locationsAny, 16),
        charactersPresentAny: uniqueLimitedStringArray(activeWhen.charactersPresentAny, 16),
        tagsAny: uniqueLimitedStringArray(activeWhen.tagsAny, 24),
    };
}

function deriveSourceString(sourceInfo, input) {
    if (typeof input.source === 'string' && input.source.trim()) return input.source.trim();
    return sourceInfo.id || [sourceInfo.work, sourceInfo.book, sourceInfo.chapter].filter(Boolean).join(':') || 'model-generated';
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
 * Normalizes a single lore entry to its canonical v2 shape while preserving legacy aliases.
 * New user-defined fields are kept under extensions.unrecognized instead of being discarded.
 * @param {*} input - Raw lore entry (may be partial or malformed)
 * @returns {Object} Normalized lore entry
 */
export function normalizeLoreEntry(input = {}) {
    if (!input || typeof input !== 'object') input = {};

    const legacyContentString = typeof input.content === 'string' ? input.content : '';
    const title = asFirstString(input.title, input.name, input.fact, legacyContentString, input.description, input.detail, input.text, input.summary) || 'Lore Entry';
    const kind = asFirstString(input.kind, input.gateType) || 'fact';
    const category = asFirstString(input.category) || 'canon';
    const date = normalizeDateBlock(input);
    const scope = normalizeScope(input);
    const visibility = normalizeVisibility(input);
    const content = normalizeContentBlock(input, legacyContentString || title);
    const effects = normalizeEffectsBlock(input);
    const sourceInfo = normalizeSourceBlock(input);
    const ui = normalizeUiBlock(input);
    const extensions = mergeExtensions(input);
    const tags = normalizeLoreTags([
        ...asStringArray(input.tags),
        ...asStringArray(effects.addsTags),
        kind,
        category,
    ]);
    const status = asString(input.status);
    const canonStatus = normalizeEnum(input.canonStatus, 'unknown', DEFAULT_CANON_STATUS);
    const truthStatus = normalizeEnum(input.truthStatus, 'true', DEFAULT_TRUTH_STATUS);
    const revealPolicy = normalizeEnum(input.revealPolicy, 'private', DEFAULT_REVEAL_POLICIES);
    const priority = asPriority(input.priority);
    const source = deriveSourceString(sourceInfo, input);
    const activeWhen = deriveActiveWhen(scope, input);
    const publicVersion = content.publicVersion;
    const whoKnowsTruth = Array.from(new Set([...asStringArray(input.whoKnowsTruth), ...stringMapKeys(visibility.knownBy)]));
    const whoSuspects = Array.from(new Set([...asStringArray(input.whoSuspects), ...stringMapKeys(visibility.suspectedBy)]));
    const whoBelievesPublicVersion = Array.from(new Set([...asStringArray(input.whoBelievesPublicVersion), ...stringMapKeys(visibility.believedBy)]));

    return {
        schemaVersion: Number.isFinite(Number(input.schemaVersion)) ? Number(input.schemaVersion) : 2,
        id: asString(input.id) || stableIdFromTitle(title),
        title,
        kind,
        gateType: asFirstString(input.gateType, kind),
        tags,
        category,
        canonStatus,
        truthStatus,
        revealPolicy,
        priority,
        status: VALID_STATUS.has(status) ? status : 'active',
        protected: asBoolean(input.protected, false),
        userEditable: input.userEditable === undefined ? true : asBoolean(input.userEditable, true),
        userEdited: asBoolean(input.userEdited),
        locked: asBoolean(input.locked),
        branchId: asString(input.branchId) || 'main',

        date,
        scope,
        visibility,
        content,
        effects,
        sourceInfo,
        ui,
        extensions,

        // Legacy aliases retained for current UI, duplicate detection, injection, and old states.
        fact: content.fact,
        validFrom: date.validFrom,
        validTo: date.validTo,
        whoKnowsTruth,
        whoSuspects,
        whoBelievesPublicVersion,
        publicVersion,
        activeWhen,
        source,
        notes: content.notes,
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
    const scope = entry.scope || {};
    const era = state?.canon?.era ? [state.canon.era] : [];
    const canonBoundary = state?.canon?.canonBoundary ? [state.canon.canonBoundary] : [];
    const location = state?.scene?.location ? [state.scene.location] : [];
    const present = state?.scene?.presentCharacters || [];

    // Runtime activation reads both legacy activeWhen and schema-v2 scope, but
    // normalization/storage no longer mirrors them into each other.
    const erasAny = uniqueLimitedStringArray([activeWhen.erasAny, scope.eras, scope.books], 32);
    const locationsAny = uniqueLimitedStringArray([activeWhen.locationsAny, scope.locations], 32);
    const charactersPresentAny = uniqueLimitedStringArray([activeWhen.charactersPresentAny, scope.characters], 32);

    if (erasAny.length && !anyOverlap(erasAny, era.concat(canonBoundary))) return false;
    if (locationsAny.length && !anyOverlap(locationsAny, location)) return false;
    if (charactersPresentAny.length && !anyOverlap(charactersPresentAny, present)) return false;

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


// ── Duplicate detection ────────────────────────────────────────────────────────

function tokenizeForSimilarity(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]+/g, ' ')
        .split(/\s+/)
        .map(w => w.trim())
        .filter(w => w.length > 2);
}

function jaccardSimilarity(a, b) {
    const aa = new Set(tokenizeForSimilarity(a));
    const bb = new Set(tokenizeForSimilarity(b));
    if (!aa.size || !bb.size) return 0;
    let intersection = 0;
    for (const token of aa) {
        if (bb.has(token)) intersection++;
    }
    const union = aa.size + bb.size - intersection;
    return union > 0 ? intersection / union : 0;
}

export function getLoreDuplicateReason(entry, existingEntries = []) {
    const candidate = normalizeLoreEntry(entry);
    const existing = normalizeLoreMatrix(existingEntries);
    const candidateId = candidate.id.toLowerCase();
    const candidateTitle = candidate.title.toLowerCase();

    for (const current of existing) {
        if (current.id.toLowerCase() === candidateId) {
            return `duplicate id: ${current.id}`;
        }
        if (current.title.toLowerCase() === candidateTitle) {
            return `duplicate title: ${current.title}`;
        }
        const titleScore = jaccardSimilarity(candidate.title, current.title);
        const factScore = jaccardSimilarity(candidate.fact, current.fact);
        if (titleScore >= 0.82) {
            return `similar title: ${current.title}`;
        }
        if (factScore >= 0.72) {
            return `similar fact: ${current.title}`;
        }
    }

    return '';
}

export function filterDuplicateLoreEntries(entries = [], existingEntries = []) {
    const accepted = [];
    const dropped = [];
    const comparison = normalizeLoreMatrix(existingEntries);

    for (const raw of entries) {
        const entry = normalizeLoreEntry(raw);
        const reason = getLoreDuplicateReason(entry, comparison.concat(accepted));
        if (reason) {
            dropped.push({ entry, reason });
        } else if (entry.id && entry.title && entry.fact) {
            accepted.push(entry);
        }
    }

    return { entries: accepted, dropped };
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
 * Normalizes a single key part to a trimmed lowercase string.
 * Used by buildLoreGenerationKey for deterministic comparisons.
 * @param {string|*} value
 * @returns {string}
 */
function normalizeKeyPart(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

/**
 * Normalizes a list of values for deterministic key inclusion.
 * Strips blanks, sorts alphabetically, and joins with comma.
 * @param {string[]} values
 * @returns {string}
 */
function normalizeList(values) {
    return Array.isArray(values)
        ? values
            .map(v => normalizeKeyPart(v))
            .filter(Boolean)
            .sort()
            .join(',')
        : '';
}

/**
 * Returns all lore entries filtered/annotated for the floating lore panel.
 * Does NOT filter by activeWhen — the panel shows all entries, not just active ones.
 * Annotations include: isPinned, isSuppressed, isActive, and category matches.
 *
 * @param {Object} state - WandlightState
 * @returns {{ entries: Object[], categories: string[], counts: Object }}
 */
export function getPanelLoreState(state) {
    const allEntries = normalizeLoreMatrix(state?.loreMatrix || []);
    const pendingEntries = normalizeLoreMatrix(state?.pendingLoreEntries || []);
    const pinnedIds = new Set(state?.loreSelection?.pinnedIds || []);
    const suppressedIds = new Set(state?.loreSelection?.suppressedIds || []);

    const categories = new Set();
    const counts = { all: 0, active: 0, pinned: 0, suppressed: 0, pending: pendingEntries.length };

    const entries = allEntries.map(entry => {
        const isActive = isLoreEntryActive(entry, state);
        const isPinned = pinnedIds.has(entry.id);
        const isSuppressed = suppressedIds.has(entry.id);

        if (entry.category) categories.add(entry.category);

        counts.all++;
        if (isActive) counts.active++;
        if (isPinned) counts.pinned++;
        if (isSuppressed) counts.suppressed++;

        return {
            ...entry,
            isActive,
            isPinned,
            isSuppressed,
            isPending: false,
        };
    });

    // Add pending entries (not yet in loreMatrix)
    const pendingAnnotated = pendingEntries.map(entry => {
        if (entry.category) categories.add(entry.category);
        return {
            ...entry,
            isActive: true,  // pending entries are assumed active since they were just generated
            isPinned: pinnedIds.has(entry.id),
            isSuppressed: suppressedIds.has(entry.id),
            isPending: true,
        };
    });

    // Merge: pending entries should not duplicate active matrix entries by id
    const entryIds = new Set(entries.map(e => e.id));
    const uniquePending = pendingAnnotated.filter(e => !entryIds.has(e.id));
    const allAnnotated = [...entries, ...uniquePending];

    // Count suppressed across all annotated entries (including pending)
    counts.suppressed = allAnnotated.filter(e => e.isSuppressed).length;

    return {
        entries: allAnnotated,
        categories: [
            'all',
            'active',
            'pinned',
            'suppressed',
            'pending',
            ...Array.from(categories).sort(),
        ],
        counts,
    };
}

/**
 * Returns the list of lore entries that should be injected into the memo/prompt.
 * Respects user selection: pinned entries are always included (even if suppressed by activeWhen),
 * suppressed entries are excluded regardless of activeWhen.
 * Falls back to getActiveLoreEntries if loreSelection is missing.
 *
 * @param {Object} state - WandlightState
 * @param {number} limit - Max entries to return
 * @returns {Object[]} Injectable lore entries
 */
export function getInjectableLoreEntries(state, limit = 0) {
    const allEntries = normalizeLoreMatrix(state?.loreMatrix || []);
    const pinnedIds = new Set(state?.loreSelection?.pinnedIds || []);
    const suppressedIds = new Set(state?.loreSelection?.suppressedIds || []);
    const explicitLimit = Number(limit);
    const settingsCap = Number(state?._settings?.maxLoreEntriesInMemo);
    const caps = [explicitLimit, settingsCap]
        .filter(v => Number.isFinite(v) && v > 0);
    const effectiveLimit = caps.length ? Math.min(...caps) : Infinity;

    if (allEntries.length === 0) return [];

    const pinnedEntries = [];
    const activeCandidateEntries = [];
    const inactiveEntries = [];

    for (const entry of allEntries) {
        if (suppressedIds.has(entry.id)) continue;

        const isActive = isLoreEntryActive(entry, state);

        if (pinnedIds.has(entry.id)) {
            pinnedEntries.push(entry);
        } else if (isActive) {
            activeCandidateEntries.push(entry);
        } else {
            inactiveEntries.push(entry);
        }
    }

    const sortLoreForInjection = (a, b) =>
        Number(b.priority || 50) - Number(a.priority || 50)
        || String(a.title || '').localeCompare(String(b.title || ''));

    pinnedEntries.sort(sortLoreForInjection);
    activeCandidateEntries.sort(sortLoreForInjection);
    inactiveEntries.sort(sortLoreForInjection);

    let result = [...pinnedEntries, ...activeCandidateEntries];

    // If strict context activation selects nothing, fall back to all unmuted lore
    // so users can still control injection with mute/pin rather than a hidden cap.
    if (result.length === 0) {
        result = [...inactiveEntries];
    }

    if (Number.isFinite(effectiveLimit)) {
        return result.slice(0, effectiveLimit);
    }

    return result;
}


/**
 * Builds a fingerprint string representing the current context.
 * Used to detect when lore should be regenerated.
 *
 * Fields included are those that should trigger a meaningfully different
 * lore proposal. Transient fields like weather or current activity are
 * deliberately excluded to avoid unnecessary regeneration.
 *
 * @param {Object} state - WandlightState
 * @returns {string} Context fingerprint
 */
export function buildLoreGenerationKey(state) {
    const ctx = normalizeLoreContext(state?.loreContext || {});
    const canon = state?.canon || {};
    const scene = state?.scene || {};

    return [
        normalizeKeyPart(ctx.sceneDate || canon.inUniverseDate),
        normalizeKeyPart(ctx.subjectiveDate),
        normalizeKeyPart(ctx.canonBoundary || canon.canonBoundary),
        normalizeKeyPart(canon.era),
        normalizeKeyPart(ctx.branchId),
        normalizeKeyPart(ctx.timeTravelMode),
        normalizeKeyPart(scene.location),
        normalizeList(scene.presentCharacters),
        normalizeList(scene.nearbyCharacters),
    ].join('|');
}
