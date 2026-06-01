/**
 * pending-lore-preprocessor.js — Wandlight Continuity
 * Pure preprocessing helpers for entries entering Pending Lore Review.
 *
 * Goals:
 * - Keep canon database entries useful on alternate story branches instead of
 *   defaulting to Divergent merely because the branch is not "main".
 * - Separate source alignment, branch applicability, temporal role, and lifecycle
 *   recommendation so the Pending Review UI can show a clearer decision.
 * - Treat far-future sentinel end dates as open-ended lookup horizons, not hard
 *   expiry windows.
 */

import { normalizeLoreEntry, normalizeLoreMatrix, evaluateLoreEntryLifecycle } from './lore-matrix.js';

const FAR_FUTURE_YEAR = 2030;
const OPEN_ENDED_DATE_PATTERNS = [/^9999(?:-|$)/, /^3000(?:-|$)/, /^999(?:-|$)/];

function asString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function sourceText(entry = {}) {
    const source = typeof entry.source === 'string' ? entry.source : '';
    const sourceInfo = asObject(entry.sourceInfo);
    const ext = asObject(entry.extensions);
    const generation = asObject(ext.wandlightGeneration);
    return [
        source,
        sourceInfo.id,
        sourceInfo.work,
        sourceInfo.book,
        generation.mode,
        generation.batchId,
        generation.chunkId,
    ].map(v => String(v || '').toLowerCase()).join(' ');
}

function isCanonDatabaseEntry(entry = {}) {
    const text = sourceText(entry);
    return text.includes('canon-lore-db')
        || text.includes('local canon')
        || text.includes('lexicon')
        || text.includes('hp lexicon')
        || entry.category === 'canon'
        || entry.canonStatus === 'canon';
}

function isStoryGeneratedEntry(entry = {}) {
    const text = sourceText(entry);
    return text.includes('wandlightgeneration')
        || text.includes('bulk')
        || text.includes('story')
        || text.includes('model-generated')
        || text.includes('lore-generator')
        || text.includes('manual')
        || ['au', 'fanon', 'divergent'].includes(String(entry.canonStatus || '').toLowerCase());
}

function currentBranchId(state = {}) {
    return asString(state?.loreContext?.branchId) || asString(state?.branchId) || 'main';
}

function isOpenEndedDate(value) {
    const text = asString(value);
    if (!text) return false;
    if (OPEN_ENDED_DATE_PATTERNS.some(pattern => pattern.test(text))) return true;
    const year = Number((text.match(/\b(\d{4})\b/) || [])[1]);
    return Number.isFinite(year) && year >= FAR_FUTURE_YEAR;
}

function classifySourceAlignment(entry = {}) {
    const status = String(entry.canonStatus || '').toLowerCase();
    if (status === 'contested') return 'contested';
    if (status === 'fanon') return 'fanon';
    if (status === 'divergent') return 'branch_variant';
    if (status === 'au') return 'story_fact';
    if (isStoryGeneratedEntry(entry)) return 'story_fact';
    if (isCanonDatabaseEntry(entry)) return 'canon_reference';
    return 'unknown';
}

function classifyTemporalRole(entry = {}, adjusted = {}) {
    const kind = String(entry.kind || entry.gateType || '').toLowerCase();
    const category = String(entry.category || '').toLowerCase();
    const tags = Array.isArray(entry.tags) ? entry.tags.map(t => String(t || '').toLowerCase()) : [];
    const date = asObject(entry.date);
    const timing = asObject(entry.canonTiming);
    const activation = asObject(entry.activation);
    const expiration = asObject(entry.expiration);

    if (kind.includes('future') || category === 'future_guard' || tags.includes('future_guard')) return 'future_guard';
    if (adjusted.openEndedDate) return 'ongoing_fact';
    if (activation.requiresEvents?.length || activation.requiresMissingEvents?.length || expiration.expiresWhenEventsHappen?.length) return 'until_story_event';
    if (date.validFrom && !date.validTo) return 'ongoing_fact';
    if (date.validFrom && date.validTo && date.validFrom === date.validTo) return 'point_event';
    if (date.validFrom || date.validTo || timing.hardValidFrom || timing.hardValidTo) return 'active_window';
    if (timing.canonExpectedFrom || timing.canonExpectedUntil) return 'historical_anchor';
    return isCanonDatabaseEntry(entry) ? 'lookup_window' : 'ongoing_fact';
}

function lifecycleLabel(status) {
    return ({
        active: 'Accept Active',
        canon_overdue: 'Accept Active / Canon Overdue',
        future: 'Accept as Future Guard',
        blocked: 'Hold for Later',
        expired: 'Expired / Superseded',
        divergent: 'Possible Conflict',
        muted: 'Reference Only',
        archived: 'Reference Only',
    })[status] || 'Needs Review';
}

function branchApplicabilityFor(entry = {}, sourceAlignment, state = {}, options = {}) {
    const current = currentBranchId(state);
    const branch = asString(entry.branchId) || 'main';
    const strictCanon = options.strictCanon === true || options.strictBranching === true;

    if (sourceAlignment === 'canon_reference' && current !== 'main' && !strictCanon) {
        return 'current_branch';
    }
    if (branch === current) return 'current_branch';
    if (branch === 'all' || branch === '*' || branch === 'any') return 'all_branches';
    if (branch === 'main' && current !== 'main') return strictCanon ? 'main_canon_only' : 'current_branch';
    return 'other_branch';
}

function adjustEntryForPending(rawEntry = {}, state = {}, options = {}) {
    const entry = normalizeLoreEntry(rawEntry);
    const branch = currentBranchId(state);
    const sourceAlignment = classifySourceAlignment(entry);
    const adjusted = { ...entry };
    const date = { ...(entry.date || {}) };
    const canonTiming = { ...(entry.canonTiming || {}) };
    const expiration = { ...(entry.expiration || {}) };
    const preserved = {};

    // Far-future sentinel values mean "effectively open-ended" in many imported
    // lore files. Keep the original value in metadata, but do not use it as a
    // hard lifecycle boundary for Pending Review defaults.
    if (isOpenEndedDate(date.validTo)) {
        preserved.dateValidTo = date.validTo;
        date.validTo = '';
        adjusted.validTo = '';
    }
    if (isOpenEndedDate(canonTiming.hardValidTo)) {
        preserved.hardValidTo = canonTiming.hardValidTo;
        canonTiming.hardValidTo = '';
        adjusted.hardValidTo = '';
    }
    if (isOpenEndedDate(canonTiming.canonExpectedUntil)) {
        preserved.canonExpectedUntil = canonTiming.canonExpectedUntil;
        canonTiming.canonExpectedUntil = '';
        adjusted.canonExpectedUntil = '';
    }

    adjusted.date = date;
    adjusted.canonTiming = canonTiming;
    adjusted.expiration = expiration;

    // Pending canon references should be evaluated against the active branch by
    // default. Otherwise nearly every AU/alternate-branch story marks useful
    // canon proposals as Divergent before the user even reviews them.
    const branchApplicability = branchApplicabilityFor(adjusted, sourceAlignment, state, options);
    if (branchApplicability === 'current_branch' && branch) {
        adjusted.branchId = branch;
    }

    const temporalRole = classifyTemporalRole(adjusted, { openEndedDate: Object.keys(preserved).length > 0 });
    let lifecycleEvaluation = { status: 'active', reason: 'Pending review default.' };
    try {
        lifecycleEvaluation = evaluateLoreEntryLifecycle(adjusted, state);
    } catch (_) {
        lifecycleEvaluation = { status: 'active', reason: 'Pending review default; lifecycle evaluation unavailable.' };
    }

    // Only keep Divergent as a default when the entry truly points at another
    // explicit branch. Canon references on the current AU branch remain usable.
    let recommendedStatus = lifecycleEvaluation.status || 'active';
    if (recommendedStatus === 'divergent' && branchApplicability === 'current_branch') {
        recommendedStatus = 'active';
    }
    if (branchApplicability === 'other_branch' || branchApplicability === 'main_canon_only') {
        recommendedStatus = 'divergent';
    }

    const now = Date.now();
    const previousExtensions = asObject(entry.extensions);
    const previousPending = asObject(previousExtensions.wandlightPendingReview);
    const review = {
        ...previousPending,
        sourceAlignment,
        branchApplicability,
        temporalRole,
        lifecycleRecommendation: lifecycleLabel(recommendedStatus),
        recommendedStatus,
        recommendationReason: recommendedStatus === lifecycleEvaluation.status
            ? (lifecycleEvaluation.reason || 'Derived from pending-lore preprocessing.')
            : 'Adjusted so canon references proposed on the current branch are not treated as divergent by default.',
        currentBranchId: branch,
        strictCanon: options.strictCanon === true || options.strictBranching === true,
        preprocessedAt: now,
    };
    if (Object.keys(preserved).length) {
        review.originalTemporalBounds = {
            ...(asObject(previousPending.originalTemporalBounds)),
            ...preserved,
        };
        review.temporalNote = 'Far-future sentinel dates were treated as open-ended lookup horizons for Pending Review.';
    }

    adjusted.lifecycle = {
        ...(adjusted.lifecycle || {}),
        status: adjusted.lifecycle?.manualOverride ? adjusted.lifecycle.status : recommendedStatus,
        computedStatus: recommendedStatus,
        manualOverride: !!adjusted.lifecycle?.manualOverride,
        reason: adjusted.lifecycle?.manualOverride
            ? (adjusted.lifecycle.reason || `Manually set to ${adjusted.lifecycle.status}.`)
            : review.recommendationReason,
        lastEvaluatedAt: now,
    };

    adjusted.extensions = {
        ...previousExtensions,
        wandlightPendingReview: review,
    };

    return normalizeLoreEntry(adjusted);
}

export function preprocessPendingLoreEntry(entry = {}, state = {}, options = {}) {
    return adjustEntryForPending(entry, state, options);
}

export function preprocessPendingLoreEntries(entries = [], state = {}, options = {}) {
    return normalizeLoreMatrix(Array.isArray(entries) ? entries : [])
        .map(entry => preprocessPendingLoreEntry(entry, state, options))
        .filter(entry => entry.id && entry.title && entry.fact);
}

export function getPendingLoreReviewMetadata(entry = {}) {
    const normalized = normalizeLoreEntry(entry);
    return asObject(normalized.extensions?.wandlightPendingReview);
}
