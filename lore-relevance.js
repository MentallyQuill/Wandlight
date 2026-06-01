/**
 * lore-relevance.js — Wandlight Continuity
 * Pure helpers for simplified lore relevance, Canon/AU metadata, and tiered lore injection.
 */

export const LORE_RELEVANCE_TIERS = Object.freeze(['high', 'normal', 'low']);
export const LORE_RELEVANCE_LABELS = Object.freeze({ high: 'High', normal: 'Normal', low: 'Low' });
export const LORE_CANON_MODES = Object.freeze(['canon', 'au']);
export const LORE_CANON_LABELS = Object.freeze({ canon: 'Canon', au: 'AU' });
export const LORE_CATEGORY_VALUES = Object.freeze([
    'character', 'event', 'location', 'item', 'spell', 'faction', 'relationship', 'rule', 'timeline', 'knowledge', 'secret', 'other',
]);

function lower(value) { return String(value || '').trim().toLowerCase(); }
function text(value) { return String(value || '').trim(); }
function arr(value) {
    if (Array.isArray(value)) return value.flatMap(v => Array.isArray(v) ? v : [v]).map(v => text(v)).filter(Boolean);
    if (typeof value === 'string') return value.split(',').map(v => text(v)).filter(Boolean);
    return [];
}
function dateFrom(value) {
    const raw = text(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
    const d = new Date(`${raw}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d;
}
function daysBetween(a, b) { return Math.round((a.getTime() - b.getTime()) / 86400000); }
function anyOverlap(a, b) {
    const aa = arr(a).map(lower).filter(Boolean);
    const bb = arr(b).map(lower).filter(Boolean);
    if (!aa.length || !bb.length) return false;
    return aa.some(x => bb.some(y => x === y || x.includes(y) || y.includes(x)));
}

function containsAny(haystack, values) {
    const h = lower(haystack);
    if (!h) return false;
    return arr(values).some(value => {
        const v = lower(value);
        if (v.length < 3) return false;
        return h.includes(v);
    });
}

export function normalizeLoreRelevance(value, fallback = 'normal') {
    const raw = lower(value);
    if (LORE_RELEVANCE_TIERS.includes(raw)) return raw;
    if (['active', 'relevant', 'current', 'scene', 'high_relevance', 'high-relevance'].includes(raw)) return 'high';
    if (['background', 'normal_relevance', 'normal-relevance', 'canon_overdue', 'canon-due', 'canon_due'].includes(raw)) return 'normal';
    if (['future', 'past', 'expired', 'archived', 'blocked', 'muted', 'low_relevance', 'low-relevance'].includes(raw)) return 'low';
    if (['divergent', 'au', 'fanon', 'contested'].includes(raw)) return 'normal';
    return LORE_RELEVANCE_TIERS.includes(fallback) ? fallback : 'normal';
}

export function normalizeLoreCanon(value, fallbackSource = '') {
    const raw = lower(value);
    if (raw === 'canon') return 'canon';
    if (raw === 'au' || raw === 'divergent' || raw === 'fanon' || raw === 'contested' || raw === 'branch_variant' || raw === 'story_fact') return 'au';
    const src = lower(fallbackSource);
    if (src.includes('canon') || src.includes('lexicon') || src.includes('hp-lexicon')) return 'canon';
    if (src.includes('story') || src.includes('generated') || src.includes('wandlight')) return 'au';
    return raw === 'unknown' || !raw ? 'canon' : 'au';
}

export function normalizeLoreCategory(value, fallback = 'other') {
    const raw = lower(value).replace(/\s+/g, '_');
    const aliases = {
        canon: 'timeline', au: 'other', place: 'location', artifact: 'item', object: 'item', future_guard: 'timeline',
        age: 'character', behavior: 'character', skill: 'character', institution: 'faction', constraint: 'rule', rumor: 'knowledge', lie: 'knowledge',
    };
    const mapped = aliases[raw] || raw;
    return LORE_CATEGORY_VALUES.includes(mapped) ? mapped : (LORE_CATEGORY_VALUES.includes(fallback) ? fallback : 'other');
}

export function relevanceWeight(value) {
    const tier = normalizeLoreRelevance(value);
    return tier === 'high' ? 3 : tier === 'normal' ? 2 : 1;
}

export function getCurrentStoryDate(state = {}) {
    return text(state?.loreContext?.sceneDate || state?.canon?.inUniverseDate || '');
}

export function computeLocalLoreRelevance(entry = {}, state = {}, options = {}) {
    const currentDate = dateFrom(getCurrentStoryDate(state));
    const date = entry.date || {};
    const from = dateFrom(date.validFrom || entry.validFrom);
    const to = dateFrom(date.validTo || entry.validTo);
    const nearFutureDays = Math.max(1, Number(options.nearFutureDays ?? options.autoRelevanceNearFutureDays ?? 30));
    const recentPastDays = Math.max(1, Number(options.recentPastDays ?? options.autoRelevanceRecentPastDays ?? 45));
    const scope = entry.scope || {};
    const activeWhen = entry.activeWhen || {};
    const present = arr(state?.scene?.presentCharacters).concat(arr(state?.scene?.nearbyCharacters));
    const location = arr(state?.scene?.location);
    const recentText = String(options.recentText || state?.autoRelevanceContext?.recentText || '').slice(-12000);
    const topics = arr(state?.scene?.currentActivity)
        .concat(arr(state?.canon?.era), arr(state?.canon?.canonBoundary), arr(state?.loreContext?.canonBoundary), arr(options.recentKeywords));
    const characters = arr(scope.characters).concat(arr(activeWhen.charactersPresentAny));
    const locations = arr(scope.locations).concat(arr(activeWhen.locationsAny));
    const entryTopics = arr(scope.topics).concat(arr(scope.objects), arr(scope.spells), arr(activeWhen.tagsAny), arr(entry.tags));
    const titleText = `${entry.title || ''} ${(entry.content?.fact || entry.fact || '')}`;

    const characterHit = anyOverlap(characters, present) || anyOverlap(titleText, present) || containsAny(recentText, characters);
    const locationHit = anyOverlap(locations, location) || anyOverlap(titleText, location) || containsAny(recentText, locations);
    const topicHit = anyOverlap(entryTopics, topics) || anyOverlap(titleText, topics) || containsAny(recentText, entryTopics);
    const titleHit = containsAny(recentText, [entry.title, entry.id]);
    const recentHit = titleHit || characterHit || locationHit || topicHit;

    let temporalRole = 'ongoing';
    let dateScore = 0;
    if (currentDate && from && to) {
        if (currentDate >= from && currentDate <= to) { temporalRole = 'current_window'; dateScore = 40; }
        else if (currentDate < from) {
            const days = daysBetween(from, currentDate);
            temporalRole = days <= nearFutureDays ? 'near_future' : 'distant_future';
            dateScore = days <= nearFutureDays ? 24 : -8;
        } else if (currentDate > to) {
            const days = daysBetween(currentDate, to);
            temporalRole = days <= recentPastDays ? 'recent_past' : 'distant_past';
            dateScore = days <= recentPastDays ? 18 : -12;
        }
    } else if (currentDate && from && !to) {
        if (currentDate >= from) { temporalRole = 'ongoing_from_date'; dateScore = 14; }
        else { temporalRole = daysBetween(from, currentDate) <= nearFutureDays ? 'near_future' : 'distant_future'; dateScore = temporalRole === 'near_future' ? 16 : -8; }
    }

    let score = dateScore + Math.min(20, Number(entry.priority || 50) / 5);
    if (characterHit) score += 55;
    if (locationHit) score += 40;
    if (topicHit) score += 24;
    if (entry.protected) score += 8;
    if (titleHit) score += 35;
    else if (recentHit) score += 18;
    const kind = lower(entry.kind || entry.gateType || '');
    if (kind.includes('future') && temporalRole === 'near_future') score += 16;
    if (kind.includes('event') && ['current_window', 'recent_past', 'near_future'].includes(temporalRole)) score += 8;

    let relevance = 'low';
    if (score >= 70) relevance = 'high';
    else if (score >= 28) relevance = 'normal';

    // Broad evergreen items should not jump high solely from priority/date.
    if (!characterHit && !locationHit && !topicHit && relevance === 'high') relevance = 'normal';
    // Distant past/future entries should not jump to High solely because their scoped
    // character is currently present. They are background unless the entry's own
    // text/title is explicitly in the recent chat.
    if (temporalRole === 'distant_past' || temporalRole === 'distant_future') {
        relevance = titleHit ? 'normal' : 'low';
    }

    return { relevance, score: Math.round(score), temporalRole, characterHit, locationHit, topicHit, recentHit, titleHit };
}

export function sortLoreEntriesForInjection(entries = [], pinnedIds = new Set()) {
    return [...entries].sort((a, b) => {
        const tier = relevanceWeight(b.relevance) - relevanceWeight(a.relevance);
        if (tier) return tier;
        const pin = Number(pinnedIds.has(b.id) || b.isPinned) - Number(pinnedIds.has(a.id) || a.isPinned);
        if (pin) return pin;
        const priority = Number(b.priority || 50) - Number(a.priority || 50);
        if (priority) return priority;
        return String(a.title || '').localeCompare(String(b.title || ''));
    });
}
