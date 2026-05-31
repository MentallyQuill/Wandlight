/**
 * canon-lore-db.js — Wandlight Continuity
 * Local date-aware lore database loader for schema-v2 canon/reference entries.
 *
 * The database is registry-driven:
 * - Lore/manifest.json lists files and registry locations.
 * - Lore/taxonomy.json defines UI chip values/colors.
 * - Lore/gate-types.json defines user-expandable gate kinds.
 * - Lore/scoring.json defines retrieval weights.
 *
 * Matching entries are proposed into Pending Lore Review; they are not silently
 * accepted into the active lore matrix.
 */

import { LOG_PREFIX } from './constants.js';
import { getState, getSettings, saveState, pushStateSnapshot } from './state-manager.js';
import { normalizeLoreMatrix, buildLoreGenerationKey } from './lore-matrix.js';

const MANIFEST_URL = new URL('./Lore/manifest.json', import.meta.url);
const LEGACY_INDEX_URL = new URL('./Lore/index.json', import.meta.url);

let _dbCache = null;
let _dbLoadPromise = null;

export const CANON_DB_SOURCE = 'canon-lore-db';

export const DEFAULT_LORE_TAXONOMY = Object.freeze({
    schemaVersion: 2,
    categories: {
        canon: { label: 'Canon', color: '#7f1d1d', textColor: '#f8e7c9', description: 'Canon-aligned information.' },
        au: { label: 'AU', color: '#4c1d95', textColor: '#f3e8ff', description: 'Alternate-universe divergence.' },
        secret: { label: 'Secret', color: '#581c87', textColor: '#f5d0fe', description: 'Hidden or private information.' },
        relationship: { label: 'Relationship', color: '#9d174d', textColor: '#fce7f3', description: 'Relationship state.' },
        timeline: { label: 'Timeline', color: '#92400e', textColor: '#ffedd5', description: 'Date-sensitive timeline information.' },
        character: { label: 'Character', color: '#1e3a8a', textColor: '#dbeafe', description: 'Character-specific information.' },
        event: { label: 'Event', color: '#92400e', textColor: '#ffedd5', description: 'Timeline event or canon anchor.' },
        item: { label: 'Item', color: '#365314', textColor: '#ecfccb', description: 'Object or item information.' },
        knowledge: { label: 'Knowledge', color: '#065f46', textColor: '#d1fae5', description: 'Who knows what and when.' },
        place: { label: 'Place', color: '#0f766e', textColor: '#ccfbf1', description: 'Place or setting information.' },
        faction: { label: 'Faction', color: '#4338ca', textColor: '#e0e7ff', description: 'Group, institution, house, or faction.' },
        spell: { label: 'Spell', color: '#312e81', textColor: '#e0e7ff', description: 'Spell knowledge or magical ability.' },
        artifact: { label: 'Artifact', color: '#713f12', textColor: '#fef3c7', description: 'Important magical object.' },
        behavior: { label: 'Behavior', color: '#831843', textColor: '#fce7f3', description: 'Date-sensitive characterization guidance.' },
        skill: { label: 'Skill', color: '#155e75', textColor: '#cffafe', description: 'Academic or magical competency guidance.' },
        age: { label: 'Age', color: '#374151', textColor: '#f3f4f6', description: 'Date-based age or school-year constraint.' },
        future_guard: { label: 'Future Guard', color: '#111827', textColor: '#fde68a', description: 'Prevents future-canon leakage.' },
        constraint: { label: 'Constraint', color: '#4b5563', textColor: '#f9fafb', description: 'General continuity constraint.' },
    },
    canonStatuses: {
        canon: { label: 'Canon', color: '#7f1d1d' },
        divergent: { label: 'Divergent', color: '#9a3412' },
        au: { label: 'AU', color: '#4c1d95' },
        fanon: { label: 'Fanon', color: '#155e75' },
        contested: { label: 'Contested', color: '#a16207' },
        unknown: { label: 'Unknown', color: '#374151' },
    },
    truthStatuses: {
        true: { label: 'True', color: '#166534' },
        false: { label: 'False', color: '#991b1b' },
        public_belief: { label: 'Public Belief', color: '#0369a1' },
        'public-belief': { label: 'Public Belief', color: '#0369a1' },
        rumor: { label: 'Rumor', color: '#854d0e' },
        hidden: { label: 'Hidden', color: '#581c87' },
        contested: { label: 'Contested', color: '#a16207' },
    },
    revealPolicies: {
        public: { label: 'Public', description: 'Safe to reveal generally.' },
        private: { label: 'Private', description: 'Only reveal when context supports it.' },
        do_not_reveal: { label: 'Do Not Reveal', description: 'Use as hidden constraint only.' },
        only_if_knower_present: { label: 'Knower Present', description: 'Reveal only if a character who knows it is present.' },
        only_if_user_reveals: { label: 'User Reveals', description: 'Never reveal unless the user introduces it first.' },
    },
    priorities: { P10: 10, P25: 25, P50: 50, P75: 75, P90: 90, P100: 100 },
});

export const DEFAULT_GATE_TYPES = Object.freeze({
    schemaVersion: 2,
    gateTypes: {
        fact: { label: 'Fact', defaultPriority: 50, injectionRole: 'positive_context' },
        event_anchor: { label: 'Event Anchor', defaultPriority: 75, injectionRole: 'timeline_anchor' },
        knowledge_gate: { label: 'Knowledge Gate', defaultPriority: 90, injectionRole: 'knowledge_constraint' },
        future_guard: { label: 'Future Guard', defaultPriority: 95, injectionRole: 'negative_constraint' },
        age_gate: { label: 'Age Gate', defaultPriority: 60, injectionRole: 'character_constraint' },
        spell_gate: { label: 'Spell Gate', defaultPriority: 80, injectionRole: 'ability_constraint' },
        skill_band: { label: 'Skill Band', defaultPriority: 70, injectionRole: 'ability_constraint' },
        behavior_gate: { label: 'Behavior Gate', defaultPriority: 65, injectionRole: 'behavior_constraint' },
        relationship_gate: { label: 'Relationship Gate', defaultPriority: 65, injectionRole: 'relationship_constraint' },
    },
});

export const DEFAULT_SCORING = Object.freeze({
    schemaVersion: 2,
    weights: {
        dateMatch: 30,
        characterMatch: 25,
        locationMatch: 12,
        topicMatch: 18,
        priority: 15,
        futureGuard: 20,
        conflictPenalty: -50,
    },
    kindBoosts: {
        future_guard: 20,
        knowledge_gate: 18,
        spell_gate: 12,
        behavior_gate: 10,
        age_gate: 8,
        event_anchor: 14,
        skill_band: 10,
        relationship_gate: 10,
    },
});

async function fetchJson(url, fallback = null) {
    try {
        const response = await fetch(url);
        if (!response.ok) return fallback;
        return await response.json();
    } catch (e) {
        return fallback;
    }
}

function mergeRegistry(defaults, loaded) {
    if (!loaded || typeof loaded !== 'object') return defaults;
    const output = { ...defaults, ...loaded };
    for (const key of Object.keys(defaults)) {
        if (defaults[key] && typeof defaults[key] === 'object' && !Array.isArray(defaults[key])) {
            output[key] = { ...(defaults[key] || {}), ...(loaded[key] || {}) };
        }
    }
    return output;
}

export function getLoreTaxonomySync() {
    return _dbCache?.taxonomy || DEFAULT_LORE_TAXONOMY;
}

export function getGateTypesSync() {
    return _dbCache?.gateTypes || DEFAULT_GATE_TYPES;
}

export function getLoreScoringSync() {
    return _dbCache?.scoring || DEFAULT_SCORING;
}

export async function loadCanonLoreDatabase() {
    if (_dbCache) return _dbCache;
    if (_dbLoadPromise) return _dbLoadPromise;

    _dbLoadPromise = (async () => {
        let manifest = await fetchJson(MANIFEST_URL, null);
        let baseUrl = MANIFEST_URL;
        if (!manifest) {
            manifest = await fetchJson(LEGACY_INDEX_URL, null);
            baseUrl = LEGACY_INDEX_URL;
        }
        if (!manifest) {
            throw new Error('Canon lore manifest/index failed to load.');
        }

        const registries = manifest.registries || {};
        const taxonomy = mergeRegistry(
            DEFAULT_LORE_TAXONOMY,
            registries.taxonomy ? await fetchJson(new URL(registries.taxonomy, baseUrl), null) : null
        );
        const gateTypes = mergeRegistry(
            DEFAULT_GATE_TYPES,
            registries.gateTypes ? await fetchJson(new URL(registries.gateTypes, baseUrl), null) : null
        );
        const scoring = mergeRegistry(
            DEFAULT_SCORING,
            registries.scoring ? await fetchJson(new URL(registries.scoring, baseUrl), null) : null
        );

        const files = Array.isArray(manifest.files) ? manifest.files : [];
        const entries = [];

        for (const file of files) {
            try {
                const url = new URL(file, baseUrl);
                const json = await fetchJson(url, null);
                if (!json) {
                    console.warn(`${LOG_PREFIX} Canon lore file failed to load: ${file}`);
                    continue;
                }
                const fileEntries = Array.isArray(json.entries) ? json.entries : (Array.isArray(json) ? json : []);
                entries.push(...fileEntries.map(entry => ({
                    ...entry,
                    source: entry?.source || `${CANON_DB_SOURCE}:${file}`,
                    canonStatus: entry?.canonStatus || 'canon',
                    branchId: entry?.branchId || 'main',
                    schemaVersion: entry?.schemaVersion || manifest.schemaVersion || 2,
                })));
            } catch (e) {
                console.warn(`${LOG_PREFIX} Canon lore file could not be read: ${file}`, e);
            }
        }

        _dbCache = {
            version: manifest.schemaVersion || manifest.version || 2,
            databaseId: manifest.databaseId || 'wandlight.canon',
            title: manifest.title || 'Wandlight Canon Lore Database',
            generatedAt: manifest.generatedAt || '',
            files,
            taxonomy,
            gateTypes,
            scoring,
            entries: normalizeLoreMatrix(entries),
        };
        return _dbCache;
    })();

    try {
        return await _dbLoadPromise;
    } finally {
        _dbLoadPromise = null;
    }
}

export function clearCanonLoreDatabaseCache() {
    _dbCache = null;
    _dbLoadPromise = null;
}

export function parseCanonDbDate(value) {
    const text = String(value || '').trim();
    if (!text) return '';

    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    if (/^\d{4}-\d{2}$/.test(text)) return `${text}-01`;
    if (/^\d{4}$/.test(text)) return `${text}-01-01`;

    const monthMap = {
        jan: 1, january: 1,
        feb: 2, february: 2,
        mar: 3, march: 3,
        apr: 4, april: 4,
        may: 5,
        jun: 6, june: 6,
        jul: 7, july: 7,
        aug: 8, august: 8,
        sep: 9, sept: 9, september: 9,
        oct: 10, october: 10,
        nov: 11, november: 11,
        dec: 12, december: 12,
    };

    let match = text.match(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\.?\s*,?\s*(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t)?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})\b/i);
    if (match) {
        const month = monthMap[match[1].toLowerCase().replace('.', '')];
        return toIsoDate(Number(match[3]), month, Number(match[2]));
    }

    match = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
    if (match) {
        const year = Number(match[3].length === 2 ? `19${match[3]}` : match[3]);
        return toIsoDate(year, Number(match[1]), Number(match[2]));
    }

    return '';
}

function toIsoDate(year, month, day) {
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return '';
    if (month < 1 || month > 12 || day < 1 || day > 31) return '';
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseRangeDate(value, edge = 'start') {
    const text = String(value || '').trim();
    if (!text) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    if (/^\d{4}-\d{2}$/.test(text)) return `${text}-${edge === 'end' ? '31' : '01'}`;
    if (/^\d{4}$/.test(text)) return `${text}-${edge === 'end' ? '12-31' : '01-01'}`;
    return parseCanonDbDate(text);
}

function dateInRange(sceneIso, entry) {
    if (!sceneIso) return false;
    const date = entry?.date || {};
    const from = parseRangeDate(date.validFrom || entry.validFrom, 'start') || '0000-01-01';
    const to = parseRangeDate(date.validTo || entry.validTo, 'end') || '9999-12-31';
    return sceneIso >= from && sceneIso <= to;
}

function lowerTokens(values) {
    return (Array.isArray(values) ? values : [values])
        .flatMap(value => String(value || '').toLowerCase().split(/[^a-z0-9]+/i))
        .map(v => v.trim())
        .filter(v => v.length > 2);
}

function overlapScore(entryValues, contextValues, weight = 1) {
    const a = new Set(lowerTokens(entryValues));
    const b = new Set(lowerTokens(contextValues));
    if (!a.size || !b.size) return 0;
    let score = 0;
    for (const token of a) {
        if (b.has(token)) score += weight;
    }
    return score;
}

function flattenScope(scope = {}) {
    const values = [];
    for (const value of Object.values(scope || {})) {
        if (Array.isArray(value)) values.push(...value);
        else if (typeof value === 'string') values.push(value);
    }
    return values;
}

function scoreCanonEntry(entry, state, context, sceneIso, scoring = DEFAULT_SCORING) {
    let score = 0;
    const weights = scoring.weights || DEFAULT_SCORING.weights;
    const kindBoosts = scoring.kindBoosts || DEFAULT_SCORING.kindBoosts;

    if (dateInRange(sceneIso, entry)) score += Number(weights.dateMatch) || 30;

    const present = state?.scene?.presentCharacters || [];
    const nearby = state?.scene?.nearbyCharacters || [];
    const location = state?.scene?.location || '';
    const canonBoundary = context?.canonBoundary || state?.canon?.canonBoundary || '';
    const era = state?.canon?.era || canonBoundary;
    const topics = [context?.branchId, context?.canonBoundary, state?.scene?.currentActivity, state?.scene?.ambience].filter(Boolean);
    const scope = entry.scope || {};

    score += overlapScore(entry.tags || [], present.concat(nearby), 4);
    score += overlapScore(scope.characters || entry.activeWhen?.charactersPresentAny || [], present.concat(nearby), Number(weights.characterMatch) || 25);
    score += overlapScore(scope.locations || entry.activeWhen?.locationsAny || [], [location], Number(weights.locationMatch) || 12);
    score += overlapScore(scope.topics || entry.activeWhen?.tagsAny || [], topics.concat([location, canonBoundary, era]), Number(weights.topicMatch) || 18);
    score += overlapScore(scope.eras || entry.activeWhen?.erasAny || [], [era, canonBoundary], 6);
    score += overlapScore([entry.title, entry.fact, entry.content?.injection, ...(entry.content?.constraints || [])], [location, canonBoundary, era].concat(present, topics), 2);
    score += overlapScore(flattenScope(scope), present.concat([location, canonBoundary, era], topics), 2);

    score += Number(kindBoosts[entry.kind]) || 0;
    if (entry.kind === 'future_guard' || entry.category === 'future_guard') score += Number(weights.futureGuard) || 20;
    if (entry.category === 'event' || entry.category === 'timeline') score += 8;
    if (entry.category === 'character' && present.length) score += 5;
    if (entry.category === 'knowledge' || entry.truthStatus === 'hidden') score += 4;
    if (entry.priority) score += Math.min(Number(weights.priority) || 15, Number(entry.priority) / 6);

    return score;
}

function compactCanonLoreEntryForPending(entry) {
    const normalized = normalizeLoreMatrix([entry])[0] || entry;
    return {
        schemaVersion: normalized.schemaVersion || 2,
        id: normalized.id,
        title: normalized.title,
        kind: normalized.kind || 'fact',
        gateType: normalized.gateType || normalized.kind || 'fact',
        category: normalized.category || 'canon',
        canonStatus: normalized.canonStatus || 'canon',
        truthStatus: normalized.truthStatus || 'true',
        revealPolicy: normalized.revealPolicy || 'private',
        priority: normalized.priority || 50,
        protected: !!normalized.protected,
        userEditable: normalized.userEditable !== false,
        date: normalized.date || {},
        scope: normalized.scope || {},
        visibility: normalized.visibility || {},
        content: {
            fact: normalized.content?.fact || normalized.fact || '',
            injection: normalized.content?.injection || '',
            constraints: Array.isArray(normalized.content?.constraints) ? normalized.content.constraints.slice(0, 8) : [],
            antiLore: Array.isArray(normalized.content?.antiLore) ? normalized.content.antiLore.slice(0, 8) : [],
            notes: normalized.content?.notes || '',
        },
        effects: {
            addsTags: Array.isArray(normalized.effects?.addsTags) ? normalized.effects.addsTags.slice(0, 12) : [],
            blocksTermsBeforeDate: Array.isArray(normalized.effects?.blocksTermsBeforeDate) ? normalized.effects.blocksTermsBeforeDate.slice(0, 12) : [],
            protectsEntries: Array.isArray(normalized.effects?.protectsEntries) ? normalized.effects.protectsEntries.slice(0, 12) : [],
            injectionRules: normalized.effects?.injectionRules || {},
        },
        sourceInfo: normalized.sourceInfo || {},
        source: typeof normalized.source === 'string' ? normalized.source : CANON_DB_SOURCE,
        ui: normalized.ui || {},
        tags: Array.isArray(normalized.tags) ? normalized.tags.slice(0, 10) : [],
    };
}

function canonicalKey(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function compactStringMap(value, limit = 12, textLimit = 80) {
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const out = {};
    for (const [key, raw] of Object.entries(input).slice(0, limit)) {
        const cleanKey = String(key || '').slice(0, textLimit).trim();
        if (!cleanKey) continue;
        out[cleanKey] = String(raw || '').slice(0, textLimit).trim() || 'unknown';
    }
    return out;
}

function compactPendingCanonEntryForStorage(entry) {
    const normalized = normalizeLoreMatrix([entry])[0] || entry;
    const trim = (value, limit = 800) => String(value || '').slice(0, limit);
    const sliceStrings = (values, limit = 8, textLimit = 180) => Array.isArray(values)
        ? values.map(v => trim(v, textLimit)).filter(Boolean).slice(0, limit)
        : [];

    return {
        schemaVersion: normalized.schemaVersion || 2,
        id: normalized.id,
        title: trim(normalized.title, 160),
        kind: normalized.kind || 'fact',
        gateType: normalized.gateType || normalized.kind || 'fact',
        category: normalized.category || 'canon',
        canonStatus: normalized.canonStatus || 'canon',
        truthStatus: normalized.truthStatus || 'true',
        revealPolicy: normalized.revealPolicy || 'private',
        priority: Number.isFinite(Number(normalized.priority)) ? Number(normalized.priority) : 50,
        protected: !!normalized.protected,
        userEditable: normalized.userEditable !== false,
        date: {
            validFrom: trim(normalized.date?.validFrom || normalized.validFrom, 32),
            validTo: trim(normalized.date?.validTo || normalized.validTo, 32),
            precision: trim(normalized.date?.precision, 32),
            schoolYear: normalized.date?.schoolYear ?? null,
            book: trim(normalized.date?.book, 80),
            label: trim(normalized.date?.label, 120),
        },
        canonTiming: {
            canonExpectedFrom: trim(normalized.canonTiming?.canonExpectedFrom, 32),
            canonExpectedUntil: trim(normalized.canonTiming?.canonExpectedUntil, 32),
            hardValidFrom: trim(normalized.canonTiming?.hardValidFrom, 32),
            hardValidTo: trim(normalized.canonTiming?.hardValidTo, 32),
            precision: trim(normalized.canonTiming?.precision, 32),
            schoolYear: normalized.canonTiming?.schoolYear ?? null,
            book: trim(normalized.canonTiming?.book, 80),
            label: trim(normalized.canonTiming?.label, 120),
        },
        activation: {
            requiresEvents: sliceStrings(normalized.activation?.requiresEvents, 8, 80),
            requiresMissingEvents: sliceStrings(normalized.activation?.requiresMissingEvents, 8, 80),
            requiresCharacters: sliceStrings(normalized.activation?.requiresCharacters, 8, 80),
            requiresLocation: sliceStrings(normalized.activation?.requiresLocation, 4, 80),
            requiresTopics: sliceStrings(normalized.activation?.requiresTopics, 8, 80),
            requiresCanonStrictness: trim(normalized.activation?.requiresCanonStrictness, 32),
        },
        expiration: {
            expiresWhenEventsHappen: sliceStrings(normalized.expiration?.expiresWhenEventsHappen, 8, 80),
            expiresWhenEntriesActive: sliceStrings(normalized.expiration?.expiresWhenEntriesActive, 8, 80),
            autoMuteOnExpire: normalized.expiration?.autoMuteOnExpire !== false,
        },
        lifecycle: {
            status: '',
            computedStatus: '',
            manualOverride: false,
            expired: false,
        },
        scope: {
            characters: sliceStrings(normalized.scope?.characters, 10, 80),
            locations: sliceStrings(normalized.scope?.locations, 8, 80),
            factions: sliceStrings(normalized.scope?.factions, 8, 80),
            topics: sliceStrings(normalized.scope?.topics, 12, 80),
            objects: sliceStrings(normalized.scope?.objects, 8, 80),
            spells: sliceStrings(normalized.scope?.spells, 8, 80),
            schoolYears: sliceStrings(normalized.scope?.schoolYears, 8, 32),
            books: sliceStrings(normalized.scope?.books, 8, 80),
            eras: sliceStrings(normalized.scope?.eras, 8, 80),
        },
        visibility: {
            publicFrom: trim(normalized.visibility?.publicFrom, 32),
            secretUntil: trim(normalized.visibility?.secretUntil, 32),
            knownBy: compactStringMap(normalized.visibility?.knownBy, 12, 80),
            notKnownByBefore: compactStringMap(normalized.visibility?.notKnownByBefore, 12, 80),
            suspectedBy: compactStringMap(normalized.visibility?.suspectedBy, 8, 80),
        },
        content: {
            fact: trim(normalized.content?.fact || normalized.fact, 900),
            injection: trim(normalized.content?.injection, 900),
            constraints: sliceStrings(normalized.content?.constraints, 6, 240),
            antiLore: sliceStrings(normalized.content?.antiLore, 6, 240),
            notes: trim(normalized.content?.notes || normalized.notes, 400),
        },
        source: CANON_DB_SOURCE,
        sourceInfo: typeof normalized.sourceInfo === 'object' && normalized.sourceInfo ? {
            work: trim(normalized.sourceInfo.work, 80),
            book: trim(normalized.sourceInfo.book, 80),
            chapter: trim(normalized.sourceInfo.chapter, 80),
            confidence: normalized.sourceInfo.confidence,
        } : {},
        tags: sliceStrings(normalized.tags, 10, 40),
    };
}

function fastFilterCanonDuplicates(entries = [], existingEntries = []) {
    const existingIds = new Set();
    const existingTitles = new Set();
    const acceptedIds = new Set();
    const acceptedTitles = new Set();
    const accepted = [];
    const dropped = [];

    for (const entry of Array.isArray(existingEntries) ? existingEntries : []) {
        const id = canonicalKey(entry?.id);
        const title = canonicalKey(entry?.title || entry?.name);
        if (id) existingIds.add(id);
        if (title) existingTitles.add(title);
    }

    for (const raw of Array.isArray(entries) ? entries : []) {
        const entry = compactPendingCanonEntryForStorage(raw);
        const id = canonicalKey(entry.id);
        const title = canonicalKey(entry.title);
        let reason = '';
        if (!id || !title || !(entry.content?.fact || entry.fact)) reason = 'missing id, title, or fact';
        else if (existingIds.has(id) || acceptedIds.has(id)) reason = `duplicate id: ${entry.id}`;
        else if (existingTitles.has(title) || acceptedTitles.has(title)) reason = `duplicate title: ${entry.title}`;

        if (reason) {
            dropped.push({ id: entry.id, title: entry.title, reason });
            continue;
        }
        accepted.push(entry);
        acceptedIds.add(id);
        acceptedTitles.add(title);
    }

    return { entries: accepted, dropped };
}



export async function queryCanonLoreDatabase(context = null, options = {}) {
    const settings = getSettings();
    if (settings.canonLoreDatabaseEnabled === false) {
        return { status: 'disabled', entries: [], matchedCount: 0, sceneIso: '' };
    }

    const state = getState();
    const effectiveContext = context || state?.loreContext || {};
    const sceneDate = effectiveContext.sceneDate || state?.canon?.inUniverseDate || '';
    const sceneIso = parseCanonDbDate(sceneDate);

    if (!sceneIso) {
        return { status: 'no_date', entries: [], matchedCount: 0, sceneIso: '' };
    }

    const db = await loadCanonLoreDatabase();
    const max = Math.max(1, Math.min(200, Number(options.maxEntries ?? settings.canonLoreMaxEntries) || 10));
    const candidates = db.entries
        .filter(entry => dateInRange(sceneIso, entry))
        .map(entry => ({ entry, score: scoreCanonEntry(entry, state, effectiveContext, sceneIso, db.scoring) }))
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score || (b.entry.priority || 50) - (a.entry.priority || 50) || a.entry.title.localeCompare(b.entry.title));

    return {
        status: candidates.length ? 'matched' : 'empty',
        entries: candidates.slice(0, max).map(item => compactPendingCanonEntryForStorage({
            ...item.entry,
            source: item.entry.source || CANON_DB_SOURCE,
        })),
        matchedCount: candidates.length,
        sceneIso,
        databaseVersion: db.version,
        databaseId: db.databaseId,
    };
}

export async function proposeCanonLoreForContext(context = null, options = {}) {
    const settings = getSettings();
    if (settings.canonLoreDatabaseEnabled === false || settings.canonLoreAutoPropose === false) {
        return { status: 'disabled', entries: [], proposedCount: 0 };
    }

    const progress = typeof options.progress === 'function' ? options.progress : null;
    const state = getState();
    const query = await queryCanonLoreDatabase(context, options);
    const dbState = state.canonLoreDatabase || {};

    dbState.lastQueriedAt = Date.now();
    dbState.lastSceneDate = query.sceneIso || parseCanonDbDate(context?.sceneDate || state?.loreContext?.sceneDate || '') || '';
    dbState.lastCanonBoundary = context?.canonBoundary || state?.loreContext?.canonBoundary || '';
    dbState.lastMatchedCount = query.matchedCount || 0;

    if (!query.entries?.length) {
        dbState.lastProposedCount = 0;
        dbState.lastStatus = query.status === 'no_date'
            ? 'No canon database query: Story Context has no parseable date.'
            : query.status === 'disabled'
                ? 'Canon lore database disabled.'
                : 'No matching canon database entries for this date/context.';
        state.canonLoreDatabase = dbState;
        saveState(state);
        return { ...query, proposedCount: 0 };
    }

    // Canon database proposals use a deliberately cheap duplicate pass.
    // Do not run fuzzy/Jaccard duplicate checks here: if an older chat already contains
    // oversized pending canon entries, full normalization + fuzzy comparison can lock the browser.
    const existing = [...(Array.isArray(state.loreMatrix) ? state.loreMatrix : []), ...(Array.isArray(state.pendingLoreEntries) ? state.pendingLoreEntries : [])];
    const filtered = fastFilterCanonDuplicates(query.entries, existing);
    const entries = filtered.entries;

    if (!entries.length) {
        dbState.lastProposedCount = 0;
        dbState.lastStatus = `Matched ${query.matchedCount} canon database entries, but the top ${query.entries.length} proposal(s) were already present by id/title.`;
        state.canonLoreDatabase = dbState;
        // getState() sanitizes oversized legacy canon payloads before we reach this point,
        // so saving here persists the repair instead of serializing the old heavy data.
        saveState(state);
        return { ...query, status: 'duplicates_only', proposedCount: 0, dropped: filtered.dropped };
    }

    if (options.snapshot !== false) {
        pushStateSnapshot(state, 'Propose canon lore from local database', settings.maxSnapshots);
    }

    const pending = Array.isArray(state.pendingLoreEntries) ? state.pendingLoreEntries : [];
    // Canon DB proposals are already storage-compact. Avoid another normalize->derive
    // pass here; saveState() will run the final bounded sanitizer.
    state.pendingLoreEntries = [...pending, ...entries].slice(-250);
    state.pendingLoreMeta = {
        id: `canon-db-${Date.now()}`,
        contextKey: buildLoreGenerationKey(state),
        source: CANON_DB_SOURCE,
        status: 'pending',
        summary: `Local canon database proposed ${entries.length} entries for ${query.sceneIso}.`,
        rawEntryCount: query.entries.length,
        validEntryCount: entries.length,
        createdAt: Date.now(),
    };

    dbState.lastProposedCount = entries.length;
    dbState.lastStatus = `Matched ${query.matchedCount} canon entries; proposed ${entries.length} new pending entries.`;
    state.canonLoreDatabase = dbState;
    saveState(state);

    progress?.(`Canon database proposed ${entries.length} pending lore entries.`, 100);
    return { ...query, status: 'proposed', entries, proposedCount: entries.length, dropped: filtered.dropped };
}
