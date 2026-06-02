/**
 * auto-relevance.js — Wandlight
 * Local high-performance Auto-Relevance pass for accepted lore entries.
 *
 * The pass is deliberately local-first: every accepted entry is scored without an
 * LLM call, then only high-signal promotion and demotion candidates are changed
 * or proposed. Suggest mode never mutates loreMatrix; it stores reviewable
 * suggestions under state.autoRelevanceSuggestions.
 */

import { getSettings, getState, saveState } from './state-manager.js';
import { normalizeLoreMatrix } from './lore-matrix.js';
import { computeLocalLoreRelevance, normalizeLoreRelevance, relevanceWeight } from './lore-relevance.js';
import { sendLoreRequest, validateLoreProviderConfiguration } from './lore-llm-client.js';
import { captureLoreTimelineState, recordLoreTimelineEvent } from './lore-timeline.js';

let turnCounter = 0;
let autoRelevanceRunning = false;

function stripJsonFences(text) {
    const raw = String(text || '').trim();
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    return (fence ? fence[1] : raw).trim();
}

function parseJsonObject(text) {
    const cleaned = stripJsonFences(text).replace(/^\uFEFF/, '').trim();
    try { return JSON.parse(cleaned); } catch (_) {}
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
        try { return JSON.parse(cleaned.slice(start, end + 1)); } catch (_) {}
    }
    return null;
}

function summarizeEntryForModel(item) {
    const e = item.entry || {};
    const scope = e.scope || {};
    const date = e.date || {};
    const content = e.content || {};
    return {
        id: e.id,
        title: e.title || e.id,
        currentRelevance: item.current,
        localSuggestedRelevance: item.next,
        priority: Number(e.priority || 50),
        pinned: !!item.pinned,
        canon: e.canon || e.canonStatus || 'canon',
        category: e.category || 'other',
        lorePurpose: e.lorePurpose || '',
        specificityScore: Number(e.specificityScore || 0),
        dateWindow: [date.validFrom || e.validFrom || '', date.validTo || e.validTo || ''].filter(Boolean).join(' to '),
        scope: {
            characters: (scope.characters || []).slice?.(0, 8) || [],
            locations: (scope.locations || []).slice?.(0, 6) || [],
            topics: (scope.topics || []).slice?.(0, 8) || [],
            tags: (e.tags || []).slice?.(0, 10) || [],
        },
        fact: String(content.fact || e.fact || content.injection || '').slice(0, 500),
        localReason: `score=${item.local.score}; temporal=${item.local.temporalRole}; recentHit=${!!item.local.recentHit}`,
    };
}

function buildModelAdjudicationPrompts({ state, settings, candidates, recentText }) {
    const scene = state?.scene || {};
    const context = state?.loreContext || {};
    const system = `You are Wandlight's Auto-Relevance adjudicator.

Task:
- Review a compact candidate set of accepted lore entries.
- Assign only a relevance tier: high, normal, or low.
- Relevance is about current story usefulness, not Canon/AU status and not injection on/off.
- High = specific lore that directly constrains the next reply: current scene, immediately relevant characters/locations/items/secrets/events, or a current timing/knowledge/status gate.
- Normal = specific recent background, near-future/near-past, important story facts, or medium-context lore.
- Low = specific but long-term background, distant past/future, or not currently needed.
- Never promote generic reference/glossary/basic canon facts to High. If an entry lacks a specific lorePurpose, keep it Low.
- Respect pinned entries: do not demote them unless clearly irrelevant.
- Treat priority as ordering inside a tier, not as a reason to make generic facts High.
- Output only JSON: {"changes":[{"id":"...","relevance":"high|normal|low","confidence":0.0-1.0,"reason":"short"}]}
- Include an entry only when you recommend a change from currentRelevance and confidence is meaningful.`;
    const payload = {
        storyContext: {
            sceneDate: context.sceneDate || state?.canon?.inUniverseDate || '',
            canonBoundary: context.canonBoundary || state?.canon?.canonBoundary || '',
            branchId: context.branchId || 'main',
        },
        scene: {
            location: scene.location || '',
            currentActivity: scene.currentActivity || '',
            presentCharacters: scene.presentCharacters || [],
            nearbyCharacters: scene.nearbyCharacters || [],
        },
        recentMessages: String(recentText || '').slice(-Math.max(1000, Math.min(12000, Number(settings.autoRelevanceModelRecentChars) || 5000))),
        candidates: candidates.map(summarizeEntryForModel),
    };
    return { system, user: JSON.stringify(payload, null, 2) };
}

async function adjudicateCandidatesWithModel(candidates, state, settings, recentText) {
    if (!settings.autoRelevanceUseModel) return { changes: [], status: 'skipped' };
    const validation = validateLoreProviderConfiguration('continuity');
    if (!validation.ok) return { changes: [], status: 'unavailable', error: validation.message };
    const maxModelCandidates = Math.max(1, Math.min(80, Number(settings.autoRelevanceModelCandidateCap) || 30));
    const modelCandidates = candidates.slice(0, maxModelCandidates);
    if (!modelCandidates.length) return { changes: [], status: 'no_candidates' };
    const { system, user } = buildModelAdjudicationPrompts({ state, settings, candidates: modelCandidates, recentText });
    const response = await sendLoreRequest(system, user, {
        providerKind: 'continuity',
        expectedOutput: 'json',
        maxTokens: Math.max(512, Math.min(4096, Number(settings.autoRelevanceModelMaxTokens) || 2048)),
    });
    const parsed = parseJsonObject(response);
    const rawChanges = Array.isArray(parsed?.changes) ? parsed.changes : [];
    const candidateById = new Map(modelCandidates.map(item => [item.entry.id, item]));
    const changes = [];
    for (const raw of rawChanges) {
        const id = String(raw?.id || '').trim();
        const item = candidateById.get(id);
        if (!item) continue;
        const next = normalizeLoreRelevance(raw.relevance || raw.suggestedRelevance, item.next);
        if (next === item.current) continue;
        changes.push({
            item,
            next,
            confidence: Math.max(0, Math.min(1, Number(raw.confidence) || item.confidence || 0.7)),
            reason: String(raw.reason || `Model adjusted relevance to ${next}.`).slice(0, 240),
            source: 'model',
        });
    }
    return { changes, status: 'model', rawCount: rawChanges.length };
}

function getRecentChatText(limit = 20) {
    try {
        const ctx = globalThis.SillyTavern?.getContext?.();
        const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
        const recent = chat.slice(-Math.max(1, Math.min(200, Number(limit) || 20)));
        return recent.map(msg => {
            if (!msg) return '';
            const speaker = msg.name || (msg.is_user ? 'User' : 'Assistant');
            const body = typeof msg.mes === 'string' ? msg.mes : typeof msg.content === 'string' ? msg.content : '';
            return body ? `${speaker}: ${body}` : '';
        }).filter(Boolean).join('\n').slice(-12000);
    } catch (_) {
        return '';
    }
}

function isManualLocked(entry) {
    return entry?.extensions?.autoRelevance?.mode === 'manual' || entry?.extensions?.autoRelevance?.locked === true;
}

function buildScoredCandidates(entries, state, settings, suppressed, pinned) {
    const recentText = getRecentChatText(settings.autoRelevanceRecentMessages || 20);
    const scoringOptions = { ...settings, recentText };
    return entries
        .filter(entry => entry.injectableByDefault !== false)
        .filter(entry => settings.autoRelevanceEvaluateMuted === true || !suppressed.has(entry.id))
        .map(entry => {
            const local = computeLocalLoreRelevance(entry, { ...state, autoRelevanceContext: { recentText } }, scoringOptions);
            const current = normalizeLoreRelevance(entry.relevance || 'normal');
            const next = normalizeLoreRelevance(local.relevance || 'normal');
            const delta = relevanceWeight(next) - relevanceWeight(current);
            let confidence;
            if (delta < 0) {
                // Demotion confidence must not be so conservative that high/normal
                // entries only ever move upward. Use distance below the current
                // tier threshold rather than raw score/70.
                const threshold = current === 'high' ? 78 : current === 'normal' ? 30 : 0;
                const denominator = current === 'high' ? 78 : current === 'normal' ? 30 : 1;
                const distance = Math.max(0, threshold - local.score);
                confidence = Math.max(0, Math.min(0.98, 0.62 + Math.min(0.36, (distance / denominator) * 0.36)));
                if (!local.recentHit) confidence = Math.min(0.98, confidence + 0.08);
            } else {
                confidence = Math.max(0, Math.min(1, Math.abs(local.score) / 100));
            }
            return { entry, current, next, local, confidence, delta, pinned: pinned.has(entry.id) };
        });
}

function dedupeCandidates(items, cap) {
    const out = [];
    const seen = new Set();
    for (const item of items) {
        if (!item?.entry?.id || seen.has(item.entry.id)) continue;
        seen.add(item.entry.id);
        out.push(item);
        if (out.length >= cap) break;
    }
    return out;
}

function selectCandidates(scored, settings, candidateCap) {
    const promotionLane = [...scored]
        .filter(item => item.delta > 0 || item.local.score >= 78)
        .sort((a, b) => b.local.score - a.local.score || Number(b.entry.priority || 50) - Number(a.entry.priority || 50));

    const demotionLane = [...scored]
        .filter(item => item.delta < 0 || (['high', 'normal'].includes(item.current) && item.local.score < 26))
        .sort((a, b) => a.local.score - b.local.score || relevanceWeight(b.current) - relevanceWeight(a.current));

    const half = Math.max(1, Math.floor(candidateCap / 2));
    return dedupeCandidates([
        ...promotionLane.slice(0, half),
        ...demotionLane.slice(0, candidateCap - Math.min(half, promotionLane.length)),
        ...promotionLane.slice(half),
        ...demotionLane.slice(candidateCap - Math.min(half, promotionLane.length)),
    ], candidateCap);
}

function shouldApplyCandidate(item, settings, threshold, pinned) {
    if (!item || item.current === item.next) return false;
    if (item.confidence < threshold) return false;
    if (isManualLocked(item.entry) && settings.autoRelevanceOverrideManual !== true) return false;
    const protectPinned = settings.autoRelevanceProtectPinned !== false;
    if (protectPinned && pinned.has(item.entry.id) && relevanceWeight(item.next) < relevanceWeight(item.current)) return false;
    return true;
}

function suggestionFromCandidate(item, override = {}) {
    const next = normalizeLoreRelevance(override.next || item.next);
    return {
        id: item.entry.id,
        title: item.entry.title || item.entry.id,
        currentRelevance: item.current,
        suggestedRelevance: next,
        confidence: Math.max(0, Math.min(1, Number(override.confidence ?? item.confidence) || 0)),
        score: item.local.score,
        temporalRole: item.local.temporalRole,
        source: override.source || 'local',
        reason: override.reason || `Local relevance score ${item.local.score}; temporal role ${item.local.temporalRole}${item.local.recentHit ? '; recent-message match' : ''}.`,
        suggestedAt: Date.now(),
    };
}

export function applyAutoRelevanceSuggestions(ids = null) {
    const state = getState();
    const suggestions = Array.isArray(state.autoRelevanceSuggestions) ? state.autoRelevanceSuggestions : [];
    const idSet = ids ? new Set(Array.isArray(ids) ? ids : [ids]) : null;
    const apply = suggestions.filter(s => !idSet || idSet.has(s.id));
    if (!apply.length) return { status: 'no_suggestions', applied: 0 };
    const byId = new Map(apply.map(s => [s.id, s]));
    const beforeTimeline = captureLoreTimelineState(state);
    let applied = 0;
    state.loreMatrix = normalizeLoreMatrix(state.loreMatrix || []).map(entry => {
        const suggestion = byId.get(entry.id);
        if (!suggestion) return entry;
        applied += 1;
        return {
            ...entry,
            relevance: normalizeLoreRelevance(suggestion.suggestedRelevance),
            extensions: {
                ...(entry.extensions || {}),
                autoRelevance: {
                    mode: 'local',
                    confidence: suggestion.confidence,
                    score: suggestion.score,
                    reason: suggestion.reason,
                    updatedAt: Date.now(),
                },
            },
        };
    });
    state.autoRelevanceSuggestions = suggestions.filter(s => !byId.has(s.id));
    if (applied > 0) {
        recordLoreTimelineEvent(state, {
            before: beforeTimeline,
            after: captureLoreTimelineState(state),
            type: 'auto_relevance',
            source: 'auto_relevance',
            summary: `Applied ${applied} Auto-Relevance suggestion${applied === 1 ? '' : 's'}.`,
        });
    }
    saveState(state, { syncPrompt: true });
    return { status: 'applied', applied };
}

export function clearAutoRelevanceSuggestions() {
    const state = getState();
    state.autoRelevanceSuggestions = [];
    saveState(state, { syncPrompt: false });
    return { status: 'cleared' };
}

export function rejectAutoRelevanceSuggestions(ids = null) {
    const state = getState();
    const suggestions = Array.isArray(state.autoRelevanceSuggestions) ? state.autoRelevanceSuggestions : [];
    const idSet = ids ? new Set(Array.isArray(ids) ? ids : [ids]) : null;
    const before = suggestions.length;
    state.autoRelevanceSuggestions = idSet ? suggestions.filter(s => !idSet.has(s.id)) : [];
    saveState(state, { syncPrompt: false });
    return { status: 'rejected', rejected: before - state.autoRelevanceSuggestions.length };
}

export async function runAutoRelevance(options = {}) {
    if (autoRelevanceRunning) {
        return { status: 'skipped_running' };
    }
    autoRelevanceRunning = true;
    try {
        return await runAutoRelevanceInternal(options);
    } finally {
        autoRelevanceRunning = false;
    }
}

async function runAutoRelevanceInternal(options = {}) {
    const settings = getSettings();
    const mode = options.mode || settings.autoRelevanceMode || 'suggest';
    if (!options.force && (settings.autoRelevanceEnabled === false || mode === 'off')) {
        return { status: 'disabled' };
    }
    const state = getState();
    const entries = normalizeLoreMatrix(state.loreMatrix || []);
    if (!entries.length) return { status: 'no_lore' };

    const suppressed = new Set(state?.loreSelection?.suppressedIds || []);
    const pinned = new Set(state?.loreSelection?.pinnedIds || []);
    const candidateCap = Math.max(1, Math.min(500, Number(settings.autoRelevanceCandidateCap) || 40));
    const threshold = Math.max(0, Math.min(1, Number(settings.autoRelevanceMinConfidence) || 0.7));
    const recentText = getRecentChatText(settings.autoRelevanceRecentMessages || 20);

    const scored = buildScoredCandidates(entries, state, settings, suppressed, pinned);
    const candidates = selectCandidates(scored, settings, candidateCap);
    let adjudicated = { changes: [], status: 'local' };
    try {
        adjudicated = await adjudicateCandidatesWithModel(candidates, state, settings, recentText);
    } catch (e) {
        console.warn('[Wandlight Auto-Relevance] Model adjudication failed; using local relevance only.', e);
        adjudicated = { changes: [], status: 'model_failed', error: e?.message || String(e || '') };
    }

    const modelById = new Map((adjudicated.changes || []).map(change => [change.item.entry.id, change]));
    const actionable = candidates
        .map(item => {
            const model = modelById.get(item.entry.id);
            if (!model) return item;
            return { ...item, next: normalizeLoreRelevance(model.next), confidence: model.confidence, modelReason: model.reason, modelSource: model.source || 'model' };
        })
        .filter(item => shouldApplyCandidate(item, settings, threshold, pinned));
    const suggestions = actionable.map(item => suggestionFromCandidate(item, {
        next: item.next,
        confidence: item.confidence,
        source: item.modelSource || 'local',
        reason: item.modelReason || undefined,
    }));
    const promotionCount = actionable.filter(item => relevanceWeight(item.next) > relevanceWeight(item.current)).length;
    const demotionCount = actionable.filter(item => relevanceWeight(item.next) < relevanceWeight(item.current)).length;

    if (mode === 'suggest') {
        state.autoRelevanceSuggestions = suggestions;
        state.autoRelevanceLastRun = {
            status: suggestions.length ? 'suggested' : 'unchanged',
            considered: candidates.length,
            suggested: suggestions.length,
            promotions: promotionCount,
            demotions: demotionCount,
            modelStatus: adjudicated.status,
            modelError: adjudicated.error || '',
            recentMessageChars: recentText.length,
            ranAt: Date.now(),
        };
        saveState(state, { syncPrompt: false });
        return { status: suggestions.length ? 'suggested' : 'unchanged', suggested: suggestions.length, changed: 0, promotions: promotionCount, demotions: demotionCount, considered: candidates.length, modelStatus: adjudicated.status };
    }

    let changed = 0;
    const byId = new Map(actionable.map(item => [item.entry.id, item]));
    const beforeTimeline = captureLoreTimelineState(state);
    state.loreMatrix = entries.map(entry => {
        const item = byId.get(entry.id);
        if (!item) return entry;
        changed += 1;
        return {
            ...entry,
            relevance: normalizeLoreRelevance(item.next),
            extensions: {
                ...(entry.extensions || {}),
                autoRelevance: {
                    mode: item.modelSource || 'local',
                    confidence: item.confidence,
                    score: item.local.score,
                    reason: item.modelReason || `Local relevance score ${item.local.score}; temporal role ${item.local.temporalRole}${item.local.recentHit ? '; recent-message match' : ''}.`,
                    updatedAt: Date.now(),
                },
            },
        };
    });
    state.autoRelevanceSuggestions = [];
    state.autoRelevanceLastRun = {
        status: changed ? 'changed' : 'unchanged',
        considered: candidates.length,
        changed,
        promotions: promotionCount,
        demotions: demotionCount,
        modelStatus: adjudicated.status,
        modelError: adjudicated.error || '',
        recentMessageChars: recentText.length,
        ranAt: Date.now(),
    };
    if (changed > 0) {
        recordLoreTimelineEvent(state, {
            before: beforeTimeline,
            after: captureLoreTimelineState(state),
            type: 'auto_relevance',
            source: 'auto_relevance',
            summary: `Auto-Relevance applied ${changed} high-confidence change${changed === 1 ? '' : 's'}.`,
        });
    }
    if (changed || options.force) saveState(state, { syncPrompt: changed > 0 });
    return { status: changed ? 'changed' : 'unchanged', changed, suggested: 0, promotions: promotionCount, demotions: demotionCount, considered: candidates.length, modelStatus: adjudicated.status };
}

export function onGenerationEndedAutoRelevance() {
    const settings = getSettings();
    if (!settings.autoRelevanceEnabled || settings.autoRelevanceMode === 'off') return { status: 'disabled' };
    turnCounter += 1;
    const every = Math.max(1, Number(settings.autoRelevanceEveryTurns) || 5);
    if (turnCounter < every) return { status: 'waiting', turnCounter, every };
    if (autoRelevanceRunning) return { status: 'skipped_running' };
    turnCounter = 0;
    runAutoRelevance().catch(e => console.error('[Wandlight Auto-Relevance] failed:', e));
    return { status: 'scheduled' };
}
