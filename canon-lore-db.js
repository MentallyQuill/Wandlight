/**
 * canon-lore-db.js — Wandlight
 * Local date-aware lore database loader for schema-v2 specific canon lore entries.
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
import { getState, getSettings, saveState, pushStateSnapshot, MAX_PENDING_LORE_ENTRIES } from './state-manager.js';
import { normalizeLoreMatrix, buildLoreGenerationKey } from './lore-matrix.js';
import { preprocessPendingLoreEntries } from './pending-lore-preprocessor.js';
import { normalizeLorePurpose, computeSpecificityScore, isSpecificLorePurpose } from './lore-relevance.js';

const MANIFEST_URL = new URL('./Lore/manifest.json', import.meta.url);
const LEGACY_INDEX_URL = new URL('./Lore/index.json', import.meta.url);

let _dbCache = null;
let _dbLoadPromise = null;

export const CANON_DB_SOURCE = 'canon-lore-db';

export const DEFAULT_LORE_TAXONOMY = Object.freeze({
    schemaVersion: 2,
    categories: {
        canon: { label: 'Canon', color: '#7f1d1d', textColor: '#f8e7c9', description: 'Canon-aligned information.' },
        au: { label: 'AU', color: '#4c1d95', textColor: '#f3e8ff', description: 'Story-specific change from main canon.' },
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
        au: { label: 'AU', color: '#4c1d95' },
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
        future_guard: { label: 'Future Guard', defaultPriority: 100, injectionRole: 'negative_constraint' },
        age_gate: { label: 'Age Gate', defaultPriority: 25, injectionRole: 'character_constraint' },
        spell_gate: { label: 'Spell Gate', defaultPriority: 75, injectionRole: 'ability_constraint' },
        skill_band: { label: 'Skill Band', defaultPriority: 75, injectionRole: 'ability_constraint' },
        behavior_gate: { label: 'Behavior Gate', defaultPriority: 50, injectionRole: 'behavior_constraint' },
        relationship_gate: { label: 'Relationship Gate', defaultPriority: 50, injectionRole: 'relationship_constraint' },
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

    const lorePurpose = normalizeLorePurpose(entry.lorePurpose || entry.purpose, entry);
    const specificPurpose = isSpecificLorePurpose(lorePurpose);
    if (!specificPurpose || entry.injectableByDefault === false) return -1000;
    if (dateInRange(sceneIso, entry)) {
        const from = parseCanonDbDate(entry.date?.validFrom || entry.validFrom);
        const to = parseCanonDbDate(entry.date?.validTo || entry.validTo);
        const span = from && to ? Math.max(0, (Date.parse(to) - Date.parse(from)) / 86400000) : 9999;
        const base = Number(weights.dateMatch) || 30;
        score += span <= 14 ? base : span <= 60 ? Math.round(base * 0.75) : span <= 365 ? Math.round(base * 0.45) : 4;
    }

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

    const purposeBoosts = {
        temporal_gate: 10, knowledge_gate: 16, ability_gate: 8, status_change: 12, event_anchor: 14, branch_fact: 14,
        relationship_state: 12, secret: 18, objective: 12, item_state: 10, location_state: 6, rule_constraint: 10, behavior_constraint: 10, age_gate: 2,
    };
    score += purposeBoosts[lorePurpose] || 0;
    score += Number(kindBoosts[entry.kind]) || 0;
    if (entry.kind === 'future_guard' || entry.category === 'future_guard') score += Number(weights.futureGuard) || 20;
    if (entry.category === 'event' || entry.category === 'timeline') score += 8;
    if (entry.category === 'character' && present.length) score += 5;
    if (entry.category === 'knowledge' || entry.truthStatus === 'hidden') score += 4;
    if (entry.priority) score += Math.min(Number(weights.priority) || 15, Number(entry.priority) / 6);

    return score;
}

function canonPriorityBand(priority = 50) {
    const p = Number(priority) || 50;
    if (p >= 100) return 5;
    if (p >= 90) return 4;
    if (p >= 75) return 3;
    if (p >= 50) return 2;
    if (p >= 25) return 1;
    return 0;
}

function canonScopeSpecificity(entry = {}) {
    const scope = entry.scope || {};
    const keys = ['characters', 'locations', 'factions', 'topics', 'objects', 'spells', 'schoolYears', 'books', 'phases'];
    return keys.reduce((total, key) => {
        const value = scope[key];
        return total + (Array.isArray(value) ? value.length : (value ? 1 : 0));
    }, 0);
}

function canonKindQuotaKey(entry = {}) {
    const kind = entry.kind || entry.gateType || '';
    const category = entry.category || '';
    if (kind === 'future_guard' || category === 'future_guard') return 'guard';
    if (kind === 'knowledge_gate' || category === 'knowledge') return 'knowledge';
    if (kind === 'event_anchor' || category === 'event' || category === 'timeline') return 'event';
    if (kind === 'behavior_gate' || kind === 'character_state' || category === 'behavior' || category === 'character') return 'character';
    if (kind === 'spell_gate' || kind === 'skill_band' || category === 'spell' || category === 'skill') return 'ability';
    if (kind === 'age_gate' || category === 'age') return 'age';
    return 'support';
}

function sortCanonCandidates(a, b) {
    const ap = Number(a.entry.priority) || 50;
    const bp = Number(b.entry.priority) || 50;
    return canonPriorityBand(bp) - canonPriorityBand(ap)
        || b.score - a.score
        || bp - ap
        || canonScopeSpecificity(b.entry) - canonScopeSpecificity(a.entry)
        || a.entry.title.localeCompare(b.entry.title);
}

function selectPriorityAwareCanonCandidates(candidates = [], max = 10) {
    const sorted = candidates.slice().sort(sortCanonCandidates);
    const selected = [];
    const bucketCounts = { guard: 0, knowledge: 0, event: 0, character: 0, ability: 0, age: 0, support: 0 };
    const quota = {
        guard: Math.max(1, Math.min(3, Math.ceil(max * 0.30))),
        knowledge: Math.max(1, Math.min(3, Math.ceil(max * 0.30))),
        event: Math.max(1, Math.min(3, Math.ceil(max * 0.30))),
        character: Math.max(1, Math.min(3, Math.ceil(max * 0.30))),
        ability: Math.max(1, Math.min(2, Math.ceil(max * 0.20))),
        age: Math.max(0, Math.min(1, Math.floor(max * 0.10))),
        support: Math.max(1, Math.min(3, Math.ceil(max * 0.30))),
    };

    for (const item of sorted) {
        if (selected.length >= max) break;
        const key = canonKindQuotaKey(item.entry);
        const priority = Number(item.entry.priority) || 50;
        const hardGuard = priority >= 100 && (key === 'guard' || key === 'knowledge');
        if (!hardGuard && bucketCounts[key] >= quota[key]) continue;
        selected.push(item);
        bucketCounts[key] += 1;
    }

    if (selected.length < max) {
        const selectedIds = new Set(selected.map(item => item.entry.id));
        for (const item of sorted) {
            if (selected.length >= max) break;
            if (selectedIds.has(item.entry.id)) continue;
            selected.push(item);
            selectedIds.add(item.entry.id);
        }
    }

    return selected;
}


function capPreprocessedByRelevance(entries = [], max = 10) {
    const buckets = { high: [], normal: [], low: [] };
    for (const entry of entries) {
        const tier = ['high', 'normal', 'low'].includes(entry.relevance) ? entry.relevance : 'normal';
        buckets[tier].push(entry);
    }
    const highCap = Math.max(1, Math.ceil(max * 0.40));
    const normalCap = Math.max(1, Math.ceil(max * 0.40));
    const lowCap = Math.max(0, max - highCap - normalCap);
    const selected = [...buckets.high.slice(0, highCap), ...buckets.normal.slice(0, normalCap), ...buckets.low.slice(0, lowCap)];
    if (selected.length < max) {
        const ids = new Set(selected.map(e => e.id));
        for (const entry of [...buckets.high, ...buckets.normal, ...buckets.low]) {
            if (selected.length >= max) break;
            if (ids.has(entry.id)) continue;
            selected.push(entry);
            ids.add(entry.id);
        }
    }
    return selected.slice(0, max);
}

function compactCanonLoreEntryForPending(entry) {
    const normalized = normalizeLoreMatrix([entry])[0] || entry;
    return {
        schemaVersion: normalized.schemaVersion || 2,
        id: normalized.id,
        title: normalized.title,
        kind: normalized.kind || 'fact',
        gateType: normalized.gateType || normalized.kind || 'fact',
        category: normalized.category || 'other',
        relevance: normalized.relevance || 'normal',
        lorePurpose: normalizeLorePurpose(normalized.lorePurpose || normalized.purpose, normalized),
        specificityScore: Number.isFinite(Number(normalized.specificityScore)) ? Math.max(0, Math.min(100, Number(normalized.specificityScore))) : computeSpecificityScore(normalized),
        injectableByDefault: normalized.injectableByDefault !== false,
        canon: normalized.canon || normalized.canonStatus || 'canon',
        canonStatus: normalized.canon || normalized.canonStatus || 'canon',
        truthStatus: normalized.truthStatus || 'true',
        revealPolicy: normalized.revealPolicy || 'private',
        priority: normalized.priority || 50,
        protected: !!normalized.protected,
        userEditable: normalized.userEditable !== false,
        branchId: normalized.branchId || 'main',
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
        category: normalized.category || 'other',
        relevance: normalized.relevance || 'normal',
        lorePurpose: normalizeLorePurpose(normalized.lorePurpose || normalized.purpose, normalized),
        specificityScore: Number.isFinite(Number(normalized.specificityScore)) ? Math.max(0, Math.min(100, Number(normalized.specificityScore))) : computeSpecificityScore(normalized),
        injectableByDefault: normalized.injectableByDefault !== false,
        canon: normalized.canon || normalized.canonStatus || 'canon',
        canonStatus: normalized.canon || normalized.canonStatus || 'canon',
        truthStatus: normalized.truthStatus || 'true',
        revealPolicy: normalized.revealPolicy || 'private',
        priority: Number.isFinite(Number(normalized.priority)) ? Number(normalized.priority) : 50,
        protected: !!normalized.protected,
        userEditable: normalized.userEditable !== false,
        branchId: normalized.branchId || 'main',
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
        ui: typeof normalized.ui === 'object' && normalized.ui && !Array.isArray(normalized.ui) ? normalized.ui : {},
        extensions: typeof normalized.extensions === 'object' && normalized.extensions && !Array.isArray(normalized.extensions) ? normalized.extensions : {},
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

function deriveSceneSchoolYear(sceneIso) {
    if (!sceneIso) return null;
    const match = String(sceneIso).match(/^(\d{4})-(\d{2})-\d{2}$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const schoolStartYear = month >= 9 ? year : year - 1;
    const schoolYear = schoolStartYear - 1990;
    return schoolYear >= 1 && schoolYear <= 7 ? schoolYear : null;
}

function normalizedEntryArray(value) {
    if (Array.isArray(value)) {
        return value.map(item => String(item || '').trim()).filter(Boolean);
    }
    return value ? [String(value).trim()].filter(Boolean) : [];
}

function textFromCanonEntry(entry = {}) {
    const content = entry.content || {};
    return [
        entry.id,
        entry.title,
        entry.fact,
        entry.generationHint,
        entry.lorePurpose,
        entry.kind,
        entry.category,
        content.fact,
        content.injection,
        content.notes,
        ...(Array.isArray(content.constraints) ? content.constraints : []),
        ...(Array.isArray(content.antiLore) ? content.antiLore : []),
        ...(Array.isArray(entry.tags) ? entry.tags : []),
    ].filter(Boolean).join(' ').toLowerCase();
}

function entryHasAnyText(entry, needles = []) {
    const text = textFromCanonEntry(entry);
    return needles.some(needle => text.includes(needle));
}

function entryMatchesSchoolYear(entry = {}, schoolYear = null) {
    if (!schoolYear) return false;
    const values = [
        entry.date?.schoolYear,
        entry.canonTiming?.schoolYear,
        entry.scope?.schoolYear,
        entry.scope?.schoolYears,
        entry.schoolYear,
        entry.year,
    ].flatMap(normalizedEntryArray);
    return values.some(value => {
        const lower = value.toLowerCase();
        return lower === String(schoolYear)
            || lower === `year ${schoolYear}`
            || lower === `hogwarts year ${schoolYear}`;
    });
}

function buildExistingCanonKeySets(currentState = getState()) {
    const acceptedEntries = Array.isArray(currentState?.loreMatrix) ? currentState.loreMatrix : [];
    const pendingEntries = Array.isArray(currentState?.pendingLoreEntries) ? currentState.pendingLoreEntries : [];
    const sets = {
        acceptedIds: new Set(),
        acceptedTitles: new Set(),
        pendingIds: new Set(),
        pendingTitles: new Set(),
    };
    const addEntry = (entry, idSet, titleSet) => {
        const idKey = canonicalKey(entry?.id);
        const titleKey = canonicalKey(entry?.title || entry?.name);
        if (idKey) idSet.add(idKey);
        if (titleKey) titleSet.add(titleKey);
    };
    acceptedEntries.forEach(entry => addEntry(entry, sets.acceptedIds, sets.acceptedTitles));
    pendingEntries.forEach(entry => addEntry(entry, sets.pendingIds, sets.pendingTitles));
    return sets;
}

function getCanonPreviewDuplicateMeta(entry = {}, keySets = buildExistingCanonKeySets()) {
    const idKey = canonicalKey(entry.id);
    const titleKey = canonicalKey(entry.title || entry.name);
    if ((idKey && keySets.pendingIds.has(idKey)) || (titleKey && keySets.pendingTitles.has(titleKey))) {
        return { duplicateStatus: 'pending', duplicateReason: 'Already in Pending Lore' };
    }
    if ((idKey && keySets.acceptedIds.has(idKey)) || (titleKey && keySets.acceptedTitles.has(titleKey))) {
        return { duplicateStatus: 'accepted', duplicateReason: 'Already in Lore Matrix' };
    }
    return { duplicateStatus: 'new', duplicateReason: '' };
}

function normalizeCanonPreviewPackId(value) {
    const id = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const aliases = {
        guardrails: 'essential_guardrails',
        essential: 'essential_guardrails',
        secrets: 'year_secrets',
        active_secrets: 'year_secrets',
        hidden_knowledge: 'year_secrets',
        year_hidden_knowledge: 'year_secrets',
        events: 'year_events',
        characters: 'present_characters',
        character: 'present_characters',
        spells: 'spells_skills',
        skills: 'spells_skills',
        abilities: 'spells_skills',
        items: 'items_access',
        access: 'items_access',
        all: 'all_active',
        all_matches: 'all_active',
    };
    return aliases[id] || id;
}

function normalizeCanonPreviewDetailLevel(value) {
    const level = String(value || '').trim().toLowerCase();
    if (['core', 'standard', 'detailed'].includes(level)) return level;
    if (['micro', 'advanced', 'expert', 'all'].includes(level)) return 'detailed';
    return '';
}

function getRawCanonPreviewConfig(entry = {}) {
    return entry?.ui?.preview && typeof entry.ui.preview === 'object' && !Array.isArray(entry.ui.preview)
        ? entry.ui.preview
        : {};
}

function inferCanonSuggestionRole(entry = {}) {
    const raw = getRawCanonPreviewConfig(entry);
    if (raw.suggestionRole) return String(raw.suggestionRole);
    const purpose = String(entry.lorePurpose || '').toLowerCase();
    const kind = String(entry.kind || entry.gateType || '').toLowerCase();
    const category = String(entry.category || '').toLowerCase();
    const text = textFromCanonEntry(entry);
    if (raw.activeUse === 'reference_only' || raw.referenceOnly === true) return 'reference_only';
    if (category === 'character' || category === 'relationship' || kind.includes('behavior') || kind.includes('relationship') || purpose.includes('behavior') || purpose.includes('relationship')) {
        return 'character_state';
    }
    if (category.includes('item') || category.includes('artifact') || category.includes('object') || kind.includes('artifact') || kind.includes('object')) {
        return 'access_gate';
    }
    if (category.includes('spell') || category.includes('skill') || kind.includes('spell') || kind.includes('skill')) {
        return 'ability_gate';
    }
    if (category.includes('secret') || category.includes('knowledge') || entry.truthStatus === 'hidden' || purpose.includes('knowledge') || purpose.includes('secret') || text.includes('not know') || text.includes('do not reveal')) {
        return 'reveal_gate';
    }
    if (kind.includes('guard') || category.includes('future_guard') || purpose.includes('temporal') || purpose.includes('constraint') || text.includes('do not') || text.includes('should not') || text.includes('before ')) {
        return 'active_guardrail';
    }
    if (category.includes('event') || category.includes('timeline') || kind.includes('event') || kind.includes('anchor') || purpose.includes('event') || purpose.includes('timeline')) {
        return 'event_anchor';
    }
    return 'reference_only';
}

function inferCanonPreviewPack(entry = {}, suggestionRole = inferCanonSuggestionRole(entry), currentState = getState()) {
    const raw = getRawCanonPreviewConfig(entry);
    if (raw.primaryPack) return normalizeCanonPreviewPackId(raw.primaryPack);
    if (suggestionRole === 'character_state' && isCanonPresentCharacterEntry(entry, currentState)) return 'present_characters';
    if (suggestionRole === 'access_gate') return 'items_access';
    if (suggestionRole === 'ability_gate') return 'spells_skills';
    if (suggestionRole === 'reveal_gate') return 'year_secrets';
    if (suggestionRole === 'event_anchor') return 'year_events';
    if (suggestionRole === 'active_guardrail') return 'essential_guardrails';
    return 'all_active';
}

function inferCanonPreviewDetailLevel(entry = {}, suggestionRole = inferCanonSuggestionRole(entry)) {
    const raw = getRawCanonPreviewConfig(entry);
    const explicit = normalizeCanonPreviewDetailLevel(raw.detailLevel);
    if (explicit) return explicit;
    const priority = Number(entry.priority) || 50;
    const includeOnlyWhenRelevant = entry.effects?.injectionRules?.includeOnlyWhenRelevant === true;
    if (priority >= 90 || ['active_guardrail', 'reveal_gate'].includes(suggestionRole)) return 'core';
    if (suggestionRole === 'character_state' || suggestionRole === 'access_gate') return 'standard';
    if (suggestionRole === 'event_anchor') return 'detailed';
    if (suggestionRole === 'ability_gate') return includeOnlyWhenRelevant || priority < 90 ? 'detailed' : 'standard';
    return 'standard';
}

function shouldSuggestCanonEntryByDefault(entry = {}, suggestionRole = inferCanonSuggestionRole(entry)) {
    const raw = getRawCanonPreviewConfig(entry);
    if (raw.suggestByDefault !== undefined) return raw.suggestByDefault !== false;
    if (raw.showByDefault !== undefined) return raw.showByDefault !== false;
    if (suggestionRole === 'reference_only') return false;
    if (entry.injectableByDefault === false) return false;
    if (suggestionRole === 'ability_gate' && entry.effects?.injectionRules?.includeOnlyWhenRelevant === true && Number(entry.priority || 50) < 90) {
        return false;
    }
    return true;
}

function getCanonPreviewConfig(entry = {}, currentState = getState()) {
    const raw = getRawCanonPreviewConfig(entry);
    const suggestionRole = inferCanonSuggestionRole(entry);
    const primaryPack = inferCanonPreviewPack(entry, suggestionRole, currentState);
    const secondaryPacks = normalizedEntryArray(raw.secondaryPacks)
        .map(normalizeCanonPreviewPackId)
        .filter(Boolean);
    const detailLevel = inferCanonPreviewDetailLevel(entry, suggestionRole);
    const suggestByDefault = shouldSuggestCanonEntryByDefault(entry, suggestionRole);
    return {
        primaryPack,
        secondaryPacks,
        suggestionRole,
        detailLevel,
        suggestByDefault,
        activeUse: raw.activeUse || '',
    };
}

function isCanonGuardrailEntry(entry = {}) {
    const purpose = String(entry.lorePurpose || '').toLowerCase();
    const kind = String(entry.kind || entry.gateType || '').toLowerCase();
    const category = String(entry.category || '').toLowerCase();
    const priority = Number(entry.priority) || 0;
    return purpose.includes('gate')
        || purpose.includes('constraint')
        || purpose.includes('exclusion')
        || kind.includes('gate')
        || kind.includes('guard')
        || kind.includes('constraint')
        || category.includes('future_guard')
        || (priority >= 90 && entryHasAnyText(entry, ['do not', 'should not', 'before ', 'has not', 'does not know']));
}

function isCanonSecretEntry(entry = {}) {
    const truthStatus = String(entry.truthStatus || '').toLowerCase();
    const revealPolicy = String(entry.revealPolicy || '').toLowerCase();
    const category = String(entry.category || '').toLowerCase();
    return truthStatus.includes('hidden')
        || revealPolicy.includes('private')
        || revealPolicy.includes('do_not_reveal')
        || revealPolicy.includes('do not reveal')
        || category.includes('secret')
        || entryHasAnyText(entry, [' secret', 'hidden', 'horcrux', 'unknown to', 'does not know', 'cannot know']);
}

function isCanonEventEntry(entry = {}) {
    const category = String(entry.category || '').toLowerCase();
    const kind = String(entry.kind || entry.gateType || '').toLowerCase();
    const purpose = String(entry.lorePurpose || '').toLowerCase();
    return category.includes('event')
        || category.includes('timeline')
        || kind.includes('event')
        || kind.includes('anchor')
        || purpose.includes('timeline')
        || purpose.includes('event');
}

function isCanonSpellOrSkillEntry(entry = {}) {
    const category = String(entry.category || '').toLowerCase();
    const kind = String(entry.kind || entry.gateType || '').toLowerCase();
    return category.includes('spell')
        || category.includes('skill')
        || kind.includes('spell')
        || kind.includes('skill')
        || normalizedEntryArray(entry.scope?.spells).length > 0;
}

function isCanonItemEntry(entry = {}) {
    const category = String(entry.category || '').toLowerCase();
    const kind = String(entry.kind || entry.gateType || '').toLowerCase();
    return category.includes('item')
        || category.includes('artifact')
        || category.includes('object')
        || kind.includes('artifact')
        || kind.includes('object')
        || normalizedEntryArray(entry.scope?.objects).length > 0;
}

function getPresentCharacterNames(currentState = getState()) {
    const scene = currentState?.scene || currentState?.currentScene || currentState?.loreContext || {};
    return [
        scene.presentCharacters,
        scene.nearbyCharacters,
        scene.characters,
    ].flatMap(normalizedEntryArray).map(name => name.toLowerCase());
}

function isCanonPresentCharacterEntry(entry = {}, currentState = getState()) {
    const present = getPresentCharacterNames(currentState);
    if (!present.length) return false;
    const category = String(entry.category || '').toLowerCase();
    const kind = String(entry.kind || entry.gateType || '').toLowerCase();
    const purpose = String(entry.lorePurpose || '').toLowerCase();
    const characterEntry = category === 'character'
        || category === 'relationship'
        || kind.includes('character')
        || kind.includes('behavior')
        || kind.includes('relationship')
        || purpose.includes('behavior')
        || purpose.includes('relationship');
    if (!characterEntry) return false;
    const scoped = [
        entry.scope?.characters,
        entry.characters,
        entry.subjects,
    ].flatMap(normalizedEntryArray).map(name => name.toLowerCase());
    return scoped.some(name => present.some(presentName => name === presentName || name.includes(presentName) || presentName.includes(name)));
}

function dedupeIds(ids = []) {
    return [...new Set(ids.filter(Boolean))];
}

function buildCanonPreviewPacks(entries = [], { schoolYear = null, sceneIso = '', currentState = getState() } = {}) {
    const yearLabel = schoolYear ? `Year ${schoolYear}` : 'Current Story';
    const definitions = [
        {
            id: 'essential_guardrails',
            label: 'Essential Guardrails',
            description: 'Highest-value active suppressors and future-leak blockers.',
        },
        {
            id: 'year_secrets',
            label: `${yearLabel} Active Secrets`,
            description: 'Currently active hidden-knowledge and reveal-state constraints.',
        },
        {
            id: 'year_events',
            label: `${yearLabel} Events`,
            description: 'Optional dated anchors for broad timeline orientation.',
        },
        {
            id: 'spells_skills',
            label: 'Spells & Skills',
            description: 'Active ability restrictions, not reminders that spells exist.',
        },
        {
            id: 'items_access',
            label: 'Items & Access',
            description: 'Active possession, access, and object-use constraints.',
        },
        {
            id: 'present_characters',
            label: 'Present Characters',
            description: 'Character-specific behavior, status, or relationship entries for characters detected in the scene.',
        },
    ];

    const addable = entry => entry?.extensions?.canonPreview?.duplicateStatus === 'new';
    const packIdsForEntry = (entry) => {
        const meta = entry.extensions?.canonPreview || getCanonPreviewConfig(entry, currentState);
        const ids = new Set();
        if (meta.suggestByDefault !== false) {
            if (meta.primaryPack) ids.add(normalizeCanonPreviewPackId(meta.primaryPack));
            for (const packId of normalizedEntryArray(meta.secondaryPacks).map(normalizeCanonPreviewPackId)) {
                ids.add(packId);
            }
        }
        return ids;
    };
    const packs = definitions.map(definition => {
        const packEntries = entries.filter(entry => packIdsForEntry(entry).has(definition.id));
        const ids = dedupeIds(packEntries.map(entry => entry.id));
        return {
            id: definition.id,
            label: definition.label,
            description: definition.description,
            entryIds: ids,
            totalCount: ids.length,
            newCount: packEntries.filter(addable).length,
            duplicateCount: packEntries.filter(entry => !addable(entry)).length,
        };
    }).filter(pack => pack.totalCount > 0);

    if (entries.length) {
        const activeEntries = entries.filter(entry => (entry.extensions?.canonPreview?.suggestionRole || getCanonPreviewConfig(entry, currentState).suggestionRole) !== 'reference_only');
        packs.push({
            id: 'all_active',
            label: 'All Active Constraints',
            description: 'Every active non-reference canon constraint matching the current date window.',
            entryIds: dedupeIds(activeEntries.map(entry => entry.id)),
            totalCount: activeEntries.length,
            newCount: activeEntries.filter(addable).length,
            duplicateCount: activeEntries.filter(entry => !addable(entry)).length,
        });
    }

    return packs;
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
        .filter(entry => isSpecificLorePurpose(normalizeLorePurpose(entry.lorePurpose || entry.purpose, entry)))
        .filter(entry => entry.injectableByDefault !== false)
        .filter(entry => shouldSuggestCanonEntryByDefault(entry))
        .filter(entry => dateInRange(sceneIso, entry))
        .map(entry => ({ entry, score: scoreCanonEntry(entry, state, effectiveContext, sceneIso, db.scoring) }))
        .filter(item => item.score > 0);
    const selectedCandidates = selectPriorityAwareCanonCandidates(candidates, max);

    return {
        status: candidates.length ? 'matched' : 'empty',
        entries: selectedCandidates.map(item => compactPendingCanonEntryForStorage({
            ...item.entry,
            source: item.entry.source || CANON_DB_SOURCE,
        })),
        matchedCount: candidates.length,
        sceneIso,
        databaseVersion: db.version,
        databaseId: db.databaseId,
    };
}

export async function previewCanonLoreForContext(context = null, options = {}) {
    const settings = getSettings();
    if (settings.canonLoreDatabaseEnabled === false) {
        return { status: 'disabled', entries: [], packs: [], matchedCount: 0, sceneIso: '' };
    }

    const currentState = getState();
    const effectiveContext = context || currentState?.loreContext || {};
    const sceneDate = effectiveContext.sceneDate || currentState?.canon?.inUniverseDate || '';
    const sceneIso = parseCanonDbDate(sceneDate);

    if (!sceneIso) {
        return { status: 'no_date', entries: [], packs: [], matchedCount: 0, sceneIso: '' };
    }

    const db = await loadCanonLoreDatabase();
    const maxCandidates = Math.max(10, Math.min(500, Number(options.maxCandidates ?? 300) || 300));
    const candidateItems = db.entries
        .filter(entry => isSpecificLorePurpose(normalizeLorePurpose(entry.lorePurpose || entry.purpose, entry)))
        .filter(entry => entry.injectableByDefault !== false)
        .filter(entry => dateInRange(sceneIso, entry))
        .map(entry => ({ entry, score: scoreCanonEntry(entry, currentState, effectiveContext, sceneIso, db.scoring) }))
        .filter(item => item.score > 0)
        .sort(sortCanonCandidates)
        .slice(0, maxCandidates);

    const keySets = buildExistingCanonKeySets(currentState);
    const compactEntries = candidateItems.map(item => {
        const previewConfig = getCanonPreviewConfig(item.entry, currentState);
        const compact = compactPendingCanonEntryForStorage({
            ...item.entry,
            source: item.entry.source || CANON_DB_SOURCE,
        });
        const duplicateMeta = getCanonPreviewDuplicateMeta(compact, keySets);
        compact.extensions = {
            ...(compact.extensions || {}),
            canonPreview: {
                score: item.score,
                ...previewConfig,
                duplicateStatus: duplicateMeta.duplicateStatus,
                duplicateReason: duplicateMeta.duplicateReason,
            },
        };
        return compact;
    });

    const entries = preprocessPendingLoreEntries(compactEntries, currentState, settings).map(entry => {
        const duplicateMeta = getCanonPreviewDuplicateMeta(entry, keySets);
        const previewMeta = entry.extensions?.canonPreview || {};
        return {
            ...entry,
            extensions: {
                ...(entry.extensions || {}),
                canonPreview: {
                    ...getCanonPreviewConfig(entry, currentState),
                    ...previewMeta,
                    duplicateStatus: duplicateMeta.duplicateStatus,
                    duplicateReason: duplicateMeta.duplicateReason,
                },
            },
        };
    });
    const schoolYear = deriveSceneSchoolYear(sceneIso);
    const packs = buildCanonPreviewPacks(entries, { schoolYear, sceneIso, currentState });
    const newCount = entries.filter(entry => entry.extensions?.canonPreview?.duplicateStatus === 'new').length;

    return {
        status: entries.length ? 'preview' : 'empty',
        source: CANON_DB_SOURCE,
        entries,
        packs,
        matchedCount: entries.length,
        newCount,
        duplicateCount: entries.length - newCount,
        sceneIso,
        schoolYear,
        databaseVersion: db.version,
        databaseId: db.databaseId,
    };
}

export async function addCanonLorePreviewEntriesToPending(entryIds = [], context = null, options = {}) {
    const selectedIds = new Set((Array.isArray(entryIds) ? entryIds : []).map(id => String(id || '')).filter(Boolean));
    if (!selectedIds.size) {
        return { status: 'empty', entries: [], proposedCount: 0, selectedCount: 0 };
    }

    const settings = getSettings();
    const currentState = getState();
    const preview = await previewCanonLoreForContext(context, options);
    if (preview.status !== 'preview') {
        return { ...preview, proposedCount: 0, selectedCount: selectedIds.size };
    }

    const selectedEntries = preview.entries.filter(entry => selectedIds.has(String(entry.id || '')));
    const addableEntries = selectedEntries.filter(entry => entry.extensions?.canonPreview?.duplicateStatus === 'new');
    if (!addableEntries.length) {
        return {
            ...preview,
            status: 'duplicates_only',
            entries: [],
            proposedCount: 0,
            selectedCount: selectedEntries.length,
            skippedDuplicateCount: selectedEntries.length,
        };
    }

    const existing = [
        ...(Array.isArray(currentState.loreMatrix) ? currentState.loreMatrix : []),
        ...(Array.isArray(currentState.pendingLoreEntries) ? currentState.pendingLoreEntries : []),
    ];
    const filtered = fastFilterCanonDuplicates(addableEntries, existing);
    const entries = preprocessPendingLoreEntries(filtered.entries, currentState, settings);

    if (!entries.length) {
        return {
            ...preview,
            status: 'duplicates_only',
            entries: [],
            proposedCount: 0,
            selectedCount: selectedEntries.length,
            skippedDuplicateCount: selectedEntries.length,
            dropped: filtered.dropped,
        };
    }

    if (options.snapshot !== false) {
        pushStateSnapshot(currentState, 'Add selected canon lore preview to pending review', settings.maxSnapshots);
    }

    const pending = Array.isArray(currentState.pendingLoreEntries) ? currentState.pendingLoreEntries : [];
    currentState.pendingLoreEntries = [...pending, ...entries].slice(-MAX_PENDING_LORE_ENTRIES);
    currentState.pendingLoreMeta = {
        id: `canon-preview-${Date.now()}`,
        contextKey: buildLoreGenerationKey(currentState),
        source: CANON_DB_SOURCE,
        status: 'pending',
        summary: `Selected canon database packs added ${entries.length} entries for ${preview.sceneIso}.`,
        rawEntryCount: selectedEntries.length,
        validEntryCount: entries.length,
        createdAt: Date.now(),
    };

    currentState.canonLoreDatabase = {
        ...(currentState.canonLoreDatabase || {}),
        lastQueriedAt: Date.now(),
        lastSceneDate: preview.sceneIso || '',
        lastCanonBoundary: context?.canonBoundary || currentState?.loreContext?.canonBoundary || '',
        lastMatchedCount: preview.matchedCount || 0,
        lastProposedCount: entries.length,
        lastStatus: `Selected ${selectedEntries.length} canon entries; added ${entries.length} new pending entries.`,
    };
    saveState(currentState);

    return {
        ...preview,
        status: 'proposed',
        entries,
        proposedCount: entries.length,
        selectedCount: selectedEntries.length,
        skippedDuplicateCount: Math.max(0, selectedEntries.length - entries.length),
        dropped: filtered.dropped,
    };
}

export async function proposeCanonLoreForContext(context = null, options = {}) {
    const settings = getSettings();
    if (settings.canonLoreDatabaseEnabled === false) {
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
    const entries = capPreprocessedByRelevance(preprocessPendingLoreEntries(filtered.entries, state, settings), Number(options.maxEntries ?? settings.canonLoreMaxEntries) || 10);

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
    // Canon DB proposals are preprocessed into relevance tiers before review; saveState() runs final bounded sanitization.
    state.pendingLoreEntries = [...pending, ...entries].slice(-MAX_PENDING_LORE_ENTRIES);
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
