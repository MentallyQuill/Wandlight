/**
 * pending-lore-preprocessor.js — Wandlight
 * Assigns user-facing relevance/canon/category defaults before entries enter Pending Lore Review.
 */

import { normalizeLoreEntry, normalizeLoreMatrix } from './lore-matrix.js';
import { normalizeLoreCanon, normalizeLoreCategory, computeLocalLoreRelevance, normalizeLorePurpose, computeSpecificityScore } from './lore-relevance.js';

function sourceText(entry = {}) {
    return [entry.source, entry.sourceInfo?.work, entry.sourceInfo?.book, entry.extensions?.wandlightGeneration?.mode]
        .map(v => String(v || '').toLowerCase())
        .join(' ');
}

function currentBranchId(state = {}) {
    return String(state?.loreContext?.branchId || state?.branchId || 'main').trim() || 'main';
}

function isCanonDatabaseEntry(entry = {}) {
    const text = sourceText(entry);
    return text.includes('canon-lore-db') || text.includes('lexicon') || entry.canonStatus === 'canon' || entry.canon === 'canon';
}

function isStoryGeneratedEntry(entry = {}) {
    const text = sourceText(entry);
    return text.includes('story') || text.includes('bulk') || text.includes('wandlight') || text.includes('generated');
}

export function preprocessPendingLoreEntry(rawEntry = {}, state = {}, options = {}) {
    const normalized = normalizeLoreEntry(rawEntry);
    const local = computeLocalLoreRelevance(normalized, state, options);
    const canon = isStoryGeneratedEntry(normalized) && !isCanonDatabaseEntry(normalized)
        ? 'au'
        : normalizeLoreCanon(normalized.canon || normalized.canonStatus, normalized.source || normalized.sourceInfo?.work || '');
    const branch = currentBranchId(state);
    const canonDatabase = isCanonDatabaseEntry(normalized);
    const storyGenerated = isStoryGeneratedEntry(normalized) && !canonDatabase;
    const currentBranchCanonReference = canonDatabase && branch !== 'main' && options.strictCanon !== true;
    const manualRelevance = normalized.extensions?.autoRelevance?.mode === 'manual'
        || normalized.extensions?.wandlightPendingReview?.manualRelevance === true
        || options.preserveRelevance === true;
    const shouldPreserveRelevance = manualRelevance;
    const recommendedRelevance = shouldPreserveRelevance && rawEntry.relevance
        ? normalized.relevance
        : local.relevance;
    const next = normalizeLoreEntry({
        ...normalized,
        branchId: currentBranchCanonReference || canon === 'au' ? branch : (normalized.branchId || branch),
        canon,
        canonStatus: canon,
        category: normalizeLoreCategory(normalized.category),
        lorePurpose: normalizeLorePurpose(normalized.lorePurpose || normalized.purpose, normalized),
        specificityScore: Number.isFinite(Number(normalized.specificityScore)) ? Math.max(0, Math.min(100, Number(normalized.specificityScore))) : computeSpecificityScore(normalized),
        injectableByDefault: normalized.injectableByDefault !== false,
        relevance: recommendedRelevance,
        lifecycle: {
            ...(normalized.lifecycle || {}),
            status: '',
            computedStatus: '',
            manualOverride: false,
            reason: 'Deprecated lifecycle state replaced by relevance-tiered lore.',
            lastEvaluatedAt: Date.now(),
        },
        extensions: {
            ...(normalized.extensions || {}),
            wandlightPendingReview: {
                ...(normalized.extensions?.wandlightPendingReview || {}),
                relevanceRecommendation: recommendedRelevance,
                relevanceScore: local.score,
                lorePurpose: local.lorePurpose || normalizeLorePurpose(normalized.lorePurpose || normalized.purpose, normalized),
                specificityScore: local.specificityScore || computeSpecificityScore(normalized),
                temporalRole: local.temporalRole,
                canonRecommendation: canon,
                modelRelevanceHint: storyGenerated ? (normalized.extensions?.wandlightGeneration?.relevanceHint || rawEntry.relevance || '') : '',
                currentBranchId: branch,
                preprocessedAt: Date.now(),
                preservedStaticRelevance: shouldPreserveRelevance && !!rawEntry.relevance,
                recommendationReason: shouldPreserveRelevance && rawEntry.relevance
                    ? `Preserved explicit relevance ${normalized.relevance}; local score suggested ${local.relevance} (${local.temporalRole}, score ${local.score}).`
                    : `Relevance ${local.relevance} from fresh local date/scope scoring (${local.temporalRole}, score ${local.score}).`,
            },
        },
    });
    return next;
}

export function preprocessPendingLoreEntries(entries = [], state = {}, options = {}) {
    return normalizeLoreMatrix(Array.isArray(entries) ? entries : [])
        .map(entry => preprocessPendingLoreEntry(entry, state, options))
        .filter(entry => entry.id && entry.title && entry.fact);
}
