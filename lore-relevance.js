/**
 * lore-relevance.js — Wandlight
 * Pure helpers for simplified lore relevance, Canon/AU metadata, and tiered lore injection.
 */

export const LORE_RELEVANCE_TIERS = Object.freeze(['high', 'normal', 'low']);
export const LORE_RELEVANCE_LABELS = Object.freeze({ high: 'High', normal: 'Normal', low: 'Low' });
export const LORE_CANON_MODES = Object.freeze(['canon', 'au']);
export const LORE_CANON_LABELS = Object.freeze({ canon: 'Canon', au: 'AU' });
export const LORE_CATEGORY_VALUES = Object.freeze([
    'character', 'event', 'location', 'item', 'spell', 'faction', 'relationship', 'rule', 'timeline', 'knowledge', 'secret', 'other',
]);

export const LORE_PURPOSE_VALUES = Object.freeze([
    'temporal_gate', 'knowledge_gate', 'ability_gate', 'status_change', 'event_anchor', 'branch_fact',
    'relationship_state', 'secret', 'objective', 'item_state', 'location_state', 'rule_constraint',
    'behavior_constraint', 'age_gate',
]);

export const LORE_PURPOSE_LABELS = Object.freeze({
    temporal_gate: 'Temporal Gate',
    knowledge_gate: 'Knowledge Gate',
    ability_gate: 'Ability Gate',
    status_change: 'Status Change',
    event_anchor: 'Event Anchor',
    branch_fact: 'Story Fact',
    relationship_state: 'Relationship State',
    secret: 'Secret',
    objective: 'Objective',
    item_state: 'Item State',
    location_state: 'Location State',
    rule_constraint: 'Rule Constraint',
    behavior_constraint: 'Behavior Constraint',
    age_gate: 'Age Gate',
});

const PURPOSE_BY_KIND = Object.freeze({
    age_gate: 'age_gate',
    skill_band: 'ability_gate',
    spell_gate: 'ability_gate',
    knowledge_gate: 'knowledge_gate',
    knowledge_guard: 'knowledge_gate',
    future_guard: 'temporal_gate',
    event_anchor: 'event_anchor',
    character_state: 'status_change',
    institution_state: 'status_change',
    faction_state: 'status_change',
    public_belief: 'knowledge_gate',
    artifact_state: 'item_state',
    object_state: 'item_state',
    spell_use: 'ability_gate',
    relationship_gate: 'relationship_state',
    relationship_state: 'relationship_state',
    behavior_gate: 'behavior_constraint',
    place_fact: 'location_state',
    continuity_rule: 'rule_constraint',
});

const PURPOSE_BY_CATEGORY = Object.freeze({
    event: 'event_anchor',
    timeline: 'temporal_gate',
    knowledge: 'knowledge_gate',
    secret: 'secret',
    item: 'item_state',
    spell: 'ability_gate',
    relationship: 'relationship_state',
    rule: 'rule_constraint',
    location: 'location_state',
    faction: 'status_change',
    character: 'status_change',
});

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

export function normalizeLorePurpose(value, entry = {}) {
    const raw = lower(value);
    if (LORE_PURPOSE_VALUES.includes(raw)) return raw;
    if (['reference', 'glossary', 'general_fact', 'encyclopedia', 'background_fact'].includes(raw)) return '';
    const kind = lower(entry.kind || entry.gateType || '');
    const category = lower(entry.category || '');
    const id = lower(entry.id || '');
    if (id.includes('death_state_')) return 'status_change';
    if ((entry.content?.fact || entry.fact || '').toLowerCase?.().includes('horcrux') && category === 'knowledge') return 'knowledge_gate';
    return PURPOSE_BY_KIND[kind] || PURPOSE_BY_CATEGORY[category] || '';
}

export function isSpecificLorePurpose(value) {
    return LORE_PURPOSE_VALUES.includes(normalizeLorePurpose(value));
}

function dateSpanDays(from, to) {
    if (!from || !to) return null;
    return Math.max(0, daysBetween(to, from));
}

function purposeAllowsCharacterOnlyHigh(purpose) {
    return ['knowledge_gate', 'status_change', 'event_anchor', 'branch_fact', 'relationship_state', 'secret', 'objective', 'item_state', 'location_state', 'behavior_constraint'].includes(purpose);
}

function purposeIsAlwaysLowUnlessExplicit(purpose) {
    return ['age_gate'].includes(purpose);
}

export function computeSpecificityScore(entry = {}) {
    const purpose = normalizeLorePurpose(entry.lorePurpose, entry);
    let score = purpose ? 25 : -30;
    const scope = entry.scope || {};
    const date = entry.date || {};
    const content = entry.content || {};
    const fact = String(content.fact || entry.fact || content.injection || '');
    if (date.validFrom && date.validTo) score += 15;
    if (['characters', 'locations', 'objects', 'spells', 'factions'].some(k => arr(scope[k]).length)) score += 15;
    if (arr(scope.topics).length) score += 5;
    if (arr(content.constraints).length || arr(content.antiLore).length) score += 15;
    if (/\b(before|after|until|should not|do not|unless|secret|hidden|dead|revealed|publicly|not know|learns?|expires?|bounded)\b/i.test(fact)) score += 20;
    if (/\b(standard tool|central british wizarding school|gryffindor student|hogwarts student)\b/i.test(fact)) score -= 80;
    return Math.max(0, Math.min(100, Math.round(score)));
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
    const span = dateSpanDays(from, to);
    const nearFutureDays = Math.max(1, Number(options.nearFutureDays ?? options.autoRelevanceNearFutureDays ?? 30));
    const recentPastDays = Math.max(1, Number(options.recentPastDays ?? options.autoRelevanceRecentPastDays ?? 45));
    const scope = entry.scope || {};
    const activeWhen = entry.activeWhen || {};
    const present = arr(state?.scene?.presentCharacters).concat(arr(state?.scene?.nearbyCharacters));
    const location = arr(state?.scene?.location);
    const recentText = String(options.recentText || state?.autoRelevanceContext?.recentText || '').slice(-12000);
    // Topic hits should come from the active scene/recent text, not broad book/era
    // labels. Otherwise every Half-Blood Prince entry becomes High merely because
    // the canon boundary is Half-Blood Prince.
    const topics = arr(state?.scene?.currentActivity).concat(arr(options.recentKeywords));
    const characters = arr(scope.characters).concat(arr(activeWhen.charactersPresentAny));
    const locations = arr(scope.locations).concat(arr(activeWhen.locationsAny));
    const entryTopics = arr(scope.topics).concat(arr(scope.objects), arr(scope.spells), arr(activeWhen.tagsAny));
    const titleText = `${entry.title || ''} ${(entry.content?.fact || entry.fact || '')}`;
    const purpose = normalizeLorePurpose(entry.lorePurpose, entry);
    const specific = isSpecificLorePurpose(purpose);
    const specificityScore = Number.isFinite(Number(entry.specificityScore)) ? Number(entry.specificityScore) : computeSpecificityScore({ ...entry, lorePurpose: purpose });

    const characterHit = anyOverlap(characters, present) || anyOverlap(titleText, present) || containsAny(recentText, characters);
    const locationHit = anyOverlap(locations, location) || anyOverlap(titleText, location) || containsAny(recentText, locations);
    const topicHit = anyOverlap(entryTopics, topics) || anyOverlap(titleText, topics) || containsAny(recentText, entryTopics);
    const titleHit = containsAny(recentText, [entry.title, entry.id]);
    const recentHit = titleHit || characterHit || locationHit || topicHit;

    let temporalRole = 'ongoing';
    let dateScore = 0;
    if (currentDate && from && to) {
        if (currentDate >= from && currentDate <= to) {
            temporalRole = 'current_window';
            if (span !== null && span <= 14) dateScore = 42;
            else if (span !== null && span <= 60) dateScore = 30;
            else if (span !== null && span <= 365) dateScore = 15;
            else dateScore = 5;
        } else if (currentDate < from) {
            const days = daysBetween(from, currentDate);
            temporalRole = days <= nearFutureDays ? 'near_future' : 'distant_future';
            dateScore = days <= nearFutureDays ? 22 : -12;
        } else if (currentDate > to) {
            const days = daysBetween(currentDate, to);
            temporalRole = days <= recentPastDays ? 'recent_past' : 'distant_past';
            dateScore = days <= recentPastDays ? 16 : -16;
        }
    } else if (currentDate && from && !to) {
        if (currentDate >= from) { temporalRole = 'ongoing_from_date'; dateScore = 8; }
        else { temporalRole = daysBetween(from, currentDate) <= nearFutureDays ? 'near_future' : 'distant_future'; dateScore = temporalRole === 'near_future' ? 14 : -12; }
    }

    let score = dateScore;
    // Priority is only a light hint for tier assignment; it primarily sorts inside a tier.
    score += Math.min(8, Math.max(0, Number(entry.priority || 50)) / 15);
    if (specific) score += Math.min(12, specificityScore / 8);
    else score -= 50;

    if (characterHit) score += purposeAllowsCharacterOnlyHigh(purpose) ? 34 : 12;
    if (locationHit) score += purposeAllowsCharacterOnlyHigh(purpose) ? 24 : 8;
    if (topicHit) score += 22;
    if (entry.protected) score += 6;
    if (titleHit) score += 38;
    else if (recentHit) score += 12;

    const kind = lower(entry.kind || entry.gateType || '');
    if (kind.includes('future') && temporalRole === 'near_future') score += 12;
    if (purpose === 'event_anchor' && ['current_window', 'recent_past', 'near_future'].includes(temporalRole)) score += 10;
    if (purpose === 'knowledge_gate' && (topicHit || titleHit)) score += 10;

    let relevance = 'low';
    if (score >= 78) relevance = 'high';
    else if (score >= 30) relevance = 'normal';

    const tightCurrentEvent = purpose === 'event_anchor' && temporalRole === 'current_window' && span !== null && span <= 14;
    const characterStateHit = ['status_change', 'relationship_state', 'secret', 'objective'].includes(purpose) && characterHit;
    const behaviorExplicitHit = purpose === 'behavior_constraint' && titleHit;
    const strongContextHit = titleHit || topicHit || tightCurrentEvent || characterStateHit || behaviorExplicitHit;
    if (relevance === 'high' && (!specific || !strongContextHit)) relevance = 'normal';
    if (specificityScore < 40 && !titleHit) relevance = 'low';
    if (purposeIsAlwaysLowUnlessExplicit(purpose) && !titleHit) relevance = 'low';
    if (purpose === 'ability_gate' && !titleHit && !topicHit) relevance = relevance === 'high' ? 'normal' : relevance;

    // Distant past/future entries should not jump to High solely because their scoped
    // character is currently present. They are background unless the entry's own
    // text/title is explicitly in the recent chat.
    if (temporalRole === 'distant_past' || temporalRole === 'distant_future') {
        relevance = titleHit ? 'normal' : 'low';
    }

    return { relevance, score: Math.round(score), temporalRole, characterHit, locationHit, topicHit, recentHit, titleHit, lorePurpose: purpose, specificityScore };
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
