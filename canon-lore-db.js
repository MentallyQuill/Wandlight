/**
 * canon-lore-db.js — Wandlight Continuity
 * Local date-aware lore database loader for pre-generated canon reference entries.
 *
 * The database lives under ./Lore and is queried locally after Story Context
 * detection. Matching entries are proposed into Pending Lore Review; they are
 * not silently accepted into the active lore matrix.
 */

import { LOG_PREFIX } from './constants.js';
import { getState, getSettings, saveState, pushStateSnapshot } from './state-manager.js';
import { normalizeLoreMatrix, filterDuplicateLoreEntries, buildLoreGenerationKey } from './lore-matrix.js';

const INDEX_URL = new URL('./Lore/index.json', import.meta.url);
let _dbCache = null;
let _dbLoadPromise = null;

export const CANON_DB_SOURCE = 'canon-lore-db';

export async function loadCanonLoreDatabase() {
    if (_dbCache) return _dbCache;
    if (_dbLoadPromise) return _dbLoadPromise;

    _dbLoadPromise = (async () => {
        const indexResponse = await fetch(INDEX_URL);
        if (!indexResponse.ok) {
            throw new Error(`Canon lore index failed to load: ${indexResponse.status} ${indexResponse.statusText}`);
        }

        const index = await indexResponse.json();
        const files = Array.isArray(index.files) ? index.files : [];
        const entries = [];

        for (const file of files) {
            try {
                const url = new URL(file, INDEX_URL);
                const response = await fetch(url);
                if (!response.ok) {
                    console.warn(`${LOG_PREFIX} Canon lore file failed to load: ${file}`, response.status, response.statusText);
                    continue;
                }
                const json = await response.json();
                const fileEntries = Array.isArray(json.entries) ? json.entries : (Array.isArray(json) ? json : []);
                entries.push(...fileEntries.map(entry => ({
                    ...entry,
                    source: entry?.source || `${CANON_DB_SOURCE}:${file}`,
                    canonStatus: entry?.canonStatus || 'canon',
                    branchId: entry?.branchId || 'main',
                })));
            } catch (e) {
                console.warn(`${LOG_PREFIX} Canon lore file could not be read: ${file}`, e);
            }
        }

        _dbCache = {
            version: index.version || 1,
            generatedAt: index.generatedAt || '',
            files,
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
        const day = Number(match[2]);
        const year = Number(match[3]);
        return toIsoDate(year, month, day);
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

function dateInRange(sceneIso, entry) {
    if (!sceneIso) return false;
    const from = parseCanonDbDate(entry.validFrom) || '0000-01-01';
    const to = parseCanonDbDate(entry.validTo) || '9999-12-31';
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

function scoreCanonEntry(entry, state, context, sceneIso) {
    let score = 0;
    if (dateInRange(sceneIso, entry)) score += 40;

    const present = state?.scene?.presentCharacters || [];
    const nearby = state?.scene?.nearbyCharacters || [];
    const location = state?.scene?.location || '';
    const canonBoundary = context?.canonBoundary || state?.canon?.canonBoundary || '';
    const era = state?.canon?.era || canonBoundary;

    score += overlapScore(entry.tags || [], present.concat(nearby), 8);
    score += overlapScore(entry.activeWhen?.charactersPresentAny || [], present.concat(nearby), 12);
    score += overlapScore(entry.activeWhen?.locationsAny || [], [location], 10);
    score += overlapScore(entry.activeWhen?.erasAny || [], [era, canonBoundary], 6);
    score += overlapScore([entry.title, entry.fact], [location, canonBoundary, era].concat(present), 2);

    if (entry.category === 'event' || entry.category === 'timeline') score += 8;
    if (entry.category === 'character' && present.length) score += 5;
    if (entry.category === 'knowledge' || entry.truthStatus === 'hidden') score += 4;
    if (entry.priority) score += Math.min(10, Number(entry.priority) / 10);

    return score;
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
    const max = Math.max(1, Math.min(50, Number(options.maxEntries ?? settings.canonLoreMaxEntries) || 12));
    const candidates = db.entries
        .filter(entry => dateInRange(sceneIso, entry))
        .map(entry => ({ entry, score: scoreCanonEntry(entry, state, effectiveContext, sceneIso) }))
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score || (b.entry.priority || 50) - (a.entry.priority || 50) || a.entry.title.localeCompare(b.entry.title));

    return {
        status: candidates.length ? 'matched' : 'empty',
        entries: candidates.slice(0, max).map(item => ({
            ...item.entry,
            source: item.entry.source || CANON_DB_SOURCE,
        })),
        matchedCount: candidates.length,
        sceneIso,
        databaseVersion: db.version,
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

    const existing = normalizeLoreMatrix([...(state.loreMatrix || []), ...(state.pendingLoreEntries || [])]);
    const filtered = filterDuplicateLoreEntries(query.entries, existing);
    const entries = normalizeLoreMatrix(filtered.entries).map(entry => ({
        ...entry,
        source: entry.source || CANON_DB_SOURCE,
    }));

    if (!entries.length) {
        dbState.lastProposedCount = 0;
        dbState.lastStatus = `Matched ${query.matchedCount} canon database entries, but all were already present or similar.`;
        state.canonLoreDatabase = dbState;
        saveState(state);
        return { ...query, status: 'duplicates_only', proposedCount: 0, dropped: filtered.dropped };
    }

    if (options.snapshot !== false) {
        pushStateSnapshot(state, 'Propose canon lore from local database', settings.maxSnapshots);
    }

    const pending = normalizeLoreMatrix(state.pendingLoreEntries || []);
    state.pendingLoreEntries = normalizeLoreMatrix([...pending, ...entries]);
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
