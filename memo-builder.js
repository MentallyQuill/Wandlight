/**
 * memo-builder.js — Wandlight
 * Builds split continuity-state and lore-entry injection previews/memos.
 */

import {
    MAX_PRESENT_CHARS_IN_MEMO,
    MAX_ACTIVE_THREADS_IN_MEMO,
} from './constants.js';
import { getSettings } from './state-manager.js';
import { getInjectableLoreEntries, getInjectableLoreEntriesByRelevance, getResolvedLoreInjection } from './lore-matrix.js';
import { normalizeLoreRelevance, LORE_RELEVANCE_LABELS } from './lore-relevance.js';

export function buildMemo(state, settingsOverride = {}) {
    const settings = { ...getSettings(), ...(settingsOverride || {}) };
    const chunks = [];

    if (settings.injectContinuity !== false && settings.injectMemo !== false) {
        const continuity = buildContinuityMemo(state, settings);
        if (continuity) chunks.push(continuity);
    }

    if (settings.injectLore) {
        const lore = buildLoreMemo(state, settings);
        if (lore) chunks.push(lore);
    }

    if (!chunks.length) return '';
    return '[WANDLIGHT CONTINUITY STATE]\n' + chunks.join('\n\n') + '\n[/WANDLIGHT CONTINUITY STATE]';
}

function parseCompressionKind(kind = 'lore') {
    const raw = String(kind || 'lore').toLowerCase().replace(/_/g, '-');
    if (raw === 'continuity') return { base: 'continuity', tier: '' };
    if (raw.includes('high')) return { base: 'lore', tier: 'high' };
    if (raw.includes('normal')) return { base: 'lore', tier: 'normal' };
    if (raw.includes('low')) return { base: 'lore', tier: 'low' };
    return { base: 'lore', tier: '' };
}

function capTier(tier) { return tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : ''; }
function tierSettingKey(tier, suffix) { return tier ? `lore${capTier(tier)}${suffix}` : `lore${suffix}`; }

function getCompressionLevel(settings, kind) {
    const parsed = parseCompressionKind(kind);
    if (parsed.base === 'continuity') return Math.max(1, Math.min(5, Number(settings.continuityCompressionLevel) || 3));
    const raw = parsed.tier ? settings[tierSettingKey(parsed.tier, 'CompressionLevel')] : settings.loreCompressionLevel;
    return Math.max(1, Math.min(5, Number(raw) || 3));
}

function getInjectionMode(settings, kind) {
    const parsed = parseCompressionKind(kind);
    if (parsed.base === 'continuity') return settings.continuityInjectionMode || 'direct';
    if (parsed.tier) return settings[tierSettingKey(parsed.tier, 'InjectionMode')] || (parsed.tier === 'high' ? 'direct' : 'compressed');
    return settings.loreInjectionMode || 'direct';
}

function getCompressionTemplate(settings, kind) {
    const parsed = parseCompressionKind(kind);
    const key = parsed.base === 'continuity' ? 'continuityCompressionPromptTemplate' : 'loreCompressionPromptTemplate';
    return String(settings?.[key] || '');
}

function stableStringHash(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

function buildLoreDirectMemoForTier(state, tier = 'normal', settingsOverride = {}) {
    const normalizedTier = normalizeLoreRelevance(tier);
    return buildLoreDirectMemo(state, {
        ...settingsOverride,
        relevanceTier: normalizedTier,
        loreInjectionMode: 'direct',
        [tierSettingKey(normalizedTier, 'InjectionMode')]: 'direct',
    });
}

export function getCompressionSourceSignature(state, kind = 'lore', directTextOverride = null, settingsOverride = {}) {
    const settings = { ...getSettings(), ...(settingsOverride || {}) };
    const parsed = parseCompressionKind(kind);
    const normalizedKind = parsed.base === 'continuity' ? 'continuity' : (parsed.tier ? `lore-${parsed.tier}` : 'lore');
    const directText = directTextOverride !== null && directTextOverride !== undefined
        ? String(directTextOverride || '')
        : (parsed.base === 'continuity'
            ? buildContinuityDirectMemo(state, { ...settings, continuityInjectionMode: 'direct' })
            : parsed.tier
                ? buildLoreDirectMemoForTier(state, parsed.tier, settings)
                : buildLoreDirectMemo(state, { ...settings, loreInjectionMode: 'direct' }));
    const compressionTemplate = getCompressionTemplate(settings, kind);
    return JSON.stringify({
        signatureVersion: 4,
        kind: normalizedKind,
        compressionLevel: getCompressionLevel(settings, kind),
        compressionTemplateHash: stableStringHash(compressionTemplate),
        compressionTemplateCharacters: compressionTemplate.length,
        pinnedLoreIds: parsed.base === 'lore' ? (state?.loreSelection?.pinnedIds || []).join('|') : '',
        directTextHash: stableStringHash(directText),
        directTextCharacters: directText.length,
    });
}

function getCompressionStatusObject(state, kind) {
    const parsed = parseCompressionKind(kind);
    if (parsed.base === 'continuity') return state?.continuityCompressionStatus || {};
    if (parsed.tier) return state?.loreCompressionStatusByRelevance?.[parsed.tier] || {};
    return state?.loreCompressionStatus || {};
}

function getCachedModelCompression(state, settings, kind) {
    if (!state) return '';
    if (getInjectionMode(settings, kind) !== 'compressed') return '';
    const parsed = parseCompressionKind(kind);
    const status = getCompressionStatusObject(state, kind);
    const directText = parsed.base === 'continuity'
        ? buildContinuityDirectMemo(state, { ...settings, continuityInjectionMode: 'direct' })
        : parsed.tier
            ? buildLoreDirectMemoForTier(state, parsed.tier, settings)
            : buildLoreDirectMemo(state, { ...settings, loreInjectionMode: 'direct' });
    const currentSignature = getCompressionSourceSignature(state, kind, directText, settings);
    return status.lastSignature === currentSignature && typeof status.cachedText === 'string' && status.cachedText.trim()
        ? status.cachedText.trim()
        : '';
}

export function buildContinuityMemo(state, settingsOverride = {}) {
    if (!state) return '';
    const settings = { ...getSettings(), ...(settingsOverride || {}) };
    const cached = getCachedModelCompression(state, settings, 'continuity');
    if (cached) return cached;
    return buildContinuityDirectMemo(state, { ...settings, continuityInjectionMode: 'direct' });
}

function buildContinuityDirectMemo(state, settingsOverride = {}) {
    if (!state) return '';
    const settings = { ...getSettings(), ...(settingsOverride || {}), continuityInjectionMode: 'direct' };
    const cfg = state.continuityConfig || {};
    const lines = [];

    const enabled = (section) => cfg[section] !== false;

    if (enabled('canon')) {
        const canonParts = [];
        if (state.canon?.era) canonParts.push(`Era: ${state.canon.era}`);
        if (state.canon?.inUniverseDate) canonParts.push(`Date: ${state.canon.inUniverseDate}`);
        if (state.canon?.canonBoundary) canonParts.push(`Canon boundary: ${state.canon.canonBoundary}`);
        if (canonParts.length) {
            lines.push('## Scene and Timeline');
            lines.push(compressLine(canonParts.join(' | '), settings, 'continuity'));
        }
    }

    if (enabled('scene')) {
        const hasScene = state.scene?.location || state.scene?.timeOfDay || state.scene?.weather || state.scene?.ambience
            || (state.scene?.presentCharacters || []).length || state.scene?.currentActivity;
        if (hasScene) {
            lines.push('');
            lines.push('## Current Scene');
            const sceneParts = [];
            if (state.scene.location) sceneParts.push(`Location: ${state.scene.location}`);
            if (state.scene.timeOfDay) sceneParts.push(`Time: ${state.scene.timeOfDay}`);
            if (state.scene.weather) sceneParts.push(`Weather: ${state.scene.weather}`);
            if (state.scene.ambience) sceneParts.push(`Ambience: ${state.scene.ambience}`);
            if (sceneParts.length) lines.push(compressLine(sceneParts.join(' | '), settings, 'continuity'));
            if (state.scene.currentActivity) lines.push(compressLine(`Activity: ${state.scene.currentActivity}`, settings, 'continuity'));
            if ((state.scene.presentCharacters || []).length) {
                const chars = state.scene.presentCharacters.slice(0, MAX_PRESENT_CHARS_IN_MEMO);
                const suffix = state.scene.presentCharacters.length > MAX_PRESENT_CHARS_IN_MEMO ? ` (+${state.scene.presentCharacters.length - MAX_PRESENT_CHARS_IN_MEMO} more)` : '';
                lines.push(`Present: ${chars.join(', ')}${suffix}`);
            }
            if ((state.scene.nearbyCharacters || []).length) lines.push(`Nearby: ${state.scene.nearbyCharacters.join(', ')}`);
        }
    }

    if (enabled('characters') && Array.isArray(state.characters) && state.characters.length) {
        lines.push('');
        lines.push('## Character State');
        for (const c of state.characters.slice(0, 10)) {
            const parts = [`- ${c.name}`];
            if (enabled('appearance') && c.clothing) parts.push(`clothing: ${c.clothing}`);
            if (c.location) parts.push(`location: ${c.location}`);
            if (c.posture) parts.push(`posture: ${c.posture}`);
            if (c.physicalState) parts.push(`physical: ${c.physicalState}`);
            if (enabled('emotionalState')) {
                const emotion = formatEmotionalState(c.emotionalState, settings);
                if (emotion) parts.push(`emotion: ${emotion}`);
            }
            if (Array.isArray(c.goals) && c.goals.length) parts.push(`goals: ${c.goals.slice(0, 3).join('; ')}`);
            lines.push(compressLine(parts.join(' | '), settings, 'continuity'));
        }
    }

    if (enabled('threads') && Array.isArray(state.threads) && state.threads.length) {
        const activeThreads = state.threads.filter(t => t.status === 'active').slice(0, MAX_ACTIVE_THREADS_IN_MEMO);
        if (activeThreads.length) {
            lines.push('');
            lines.push('## Active Goals and Threads');
            for (const t of activeThreads) {
                lines.push(compressLine(`- ${t.description}${(t.unresolvedConsequences || []).length ? ` | hooks: ${t.unresolvedConsequences.join('; ')}` : ''}`, settings, 'continuity'));
            }
        }
    }

    if (enabled('inventory') && Array.isArray(state.inventory) && state.inventory.length) {
        lines.push('');
        lines.push('## Key Items');
        for (const i of state.inventory.slice(0, 10)) {
            lines.push(compressLine(`- ${i.owner || 'Unowned'}: ${i.item}${i.status ? ` (${i.status})` : ''}${i.location ? ` at ${i.location}` : ''}`, settings, 'continuity'));
        }
    }

    if (enabled('objectives') && Array.isArray(state.objectives) && state.objectives.length) {
        lines.push('');
        lines.push('## Active Goals');
        for (const o of state.objectives.filter(x => x.status !== 'completed' && x.status !== 'abandoned').slice(0, 8)) {
            lines.push(compressLine(`- ${o.owner || 'Story'}: ${o.goal}${o.status ? ` [${o.status}]` : ''}${o.stakes ? ` | stakes: ${o.stakes}` : ''}`, settings, 'continuity'));
        }
    }


    const body = lines.join('\n').trim();
    return body ? `## Continuity State\n${body}` : '';
}

export function buildLoreMemo(state, settingsOverride = {}) {
    if (!state) return '';
    const settings = { ...getSettings(), ...(settingsOverride || {}) };
    if (settings.relevanceTier) {
        const tier = normalizeLoreRelevance(settings.relevanceTier);
        const cached = getCachedModelCompression(state, settings, `lore-${tier}`);
        if (cached) return cached;
        return buildLoreDirectMemoForTier(state, tier, settings);
    }
    const chunks = [];
    for (const tier of ['high', 'normal', 'low']) {
        const enabledKey = tierSettingKey(tier, 'InjectionEnabled');
        if (settings[enabledKey] === false) continue;
        const cached = getCachedModelCompression(state, settings, `lore-${tier}`);
        const direct = cached || buildLoreDirectMemoForTier(state, tier, settings);
        if (direct) chunks.push(direct);
    }
    return chunks.join('\n\n');
}

function buildLoreDirectMemo(state, settingsOverride = {}) {
    if (!state) return '';
    const settings = { ...getSettings(), ...(settingsOverride || {}), loreInjectionMode: 'direct' };
    const tier = settings.relevanceTier ? normalizeLoreRelevance(settings.relevanceTier) : '';
    const maxKey = tier ? tierSettingKey(tier, 'MaxEntries') : 'maxLoreEntriesInMemo';
    const maxEntries = Number(settings[maxKey] || 0);
    const activeLore = tier ? getInjectableLoreEntriesByRelevance(state, tier, maxEntries) : getInjectableLoreEntries(state, maxEntries);
    if (!activeLore.length) return '';

    const lines = [];
    const label = tier ? `${LORE_RELEVANCE_LABELS[tier]}-Relevance Lore` : 'Lore Entries';
    lines.push(`## ${label}${getInjectionMode(settings, tier ? `lore-${tier}` : 'lore') === 'compressed' ? ' (Compressed)' : ''}`);
    const pinnedIds = new Set(state?.loreSelection?.pinnedIds || []);
    for (const entry of activeLore) {
        lines.push(formatLoreEntryForInjection(entry, settings, pinnedIds.has(entry.id), state));
    }
    return lines.join('\n');
}


function getCurrentChatLength() {
    try {
        const ctx = SillyTavern.getContext();
        return Array.isArray(ctx?.chat) ? ctx.chat.length : 0;
    } catch (_) {
        return 0;
    }
}

function getEmotionMessageAge(raw = {}) {
    const updatedAt = Number(raw?.lastUpdatedChatLength);
    const current = getCurrentChatLength();
    if (!Number.isFinite(updatedAt) || updatedAt <= 0 || current <= 0 || current < updatedAt) return 0;
    return Math.max(0, current - updatedAt);
}

function formatEmotionalState(raw = {}, settings = {}) {
    const keys = ['affection', 'trust', 'desire', 'connection', 'fear', 'anger', 'sadness', 'joy'];
    const labels = [];
    for (const key of keys) {
        const val = Number(raw[key] || 0);
        if (Math.abs(val) >= 2) labels.push(`${key} ${val > 0 ? '+' : ''}${val}`);
    }
    if (raw.notes) labels.push(String(raw.notes));
    const text = labels.join(', ');
    if (!text) return '';
    const confidence = Number(raw.confidence);
    const confidencePrefix = Number.isFinite(confidence) && confidence < 0.65 ? 'uncertain ' : '';

    if (settings.continuityEmotionRecencyEnabled === false) return text;

    const currentWindow = Math.max(0, Number(settings.continuityEmotionCurrentMessageWindow) || 8);
    const recentWindow = Math.max(currentWindow, Number(settings.continuityEmotionRecentMessageWindow) || 20);
    const age = getEmotionMessageAge(raw);

    if (age > recentWindow) {
        const behavior = String(settings.continuityEmotionStaleBehavior || 'omit');
        if (behavior === 'keep') return `${confidencePrefix}stale (${age} messages ago): ${text}; update naturally if contradicted`;
        if (behavior === 'keep_as_recent') return `${confidencePrefix}recent (${age} messages ago): ${text}; do not force if the scene has moved on`;
        return '';
    }

    if (age > currentWindow) {
        return `${confidencePrefix}recent (${age} messages ago): ${text}; update naturally if the scene has moved on`;
    }

    return `${confidencePrefix}current: ${text}`;
}

function compressLine(text, settings, kind) {
    const mode = kind === 'continuity' ? (settings.continuityInjectionMode || 'direct') : (settings.loreInjectionMode || 'direct');
    if (mode !== 'compressed') return text;
    const level = kind === 'continuity'
        ? Math.max(1, Math.min(5, Number(settings.continuityCompressionLevel) || 3))
        : Math.max(1, Math.min(5, Number(settings.loreCompressionLevel) || 3));
    const limits = [420, 320, 240, 170, 110];
    return truncateForInjection(text, limits[level - 1]);
}

function getLoreInjectionText(entry, state = null) {
    const resolved = state ? getResolvedLoreInjection(entry, state) : '';
    const content = entry?.content || {};
    const text = resolved || content.injection || content.fact || entry.fact || '';
    const constraints = Array.isArray(content.constraints) && content.constraints.length
        ? ` Constraints: ${content.constraints.join(' ')}`
        : '';
    const antiLore = Array.isArray(content.antiLore) && content.antiLore.length
        ? ` Avoid: ${content.antiLore.join(' ')}`
        : '';
    return `${text}${constraints}${antiLore}`.trim();
}

function formatLoreEntryForInjection(entry, settings, isPinned = false, state = null) {
    const injectionText = normalizeInjectionLine(getLoreInjectionText(entry, state));
    if (!injectionText) return '';

    // Keep prompt payloads token-efficient: the model needs the resolved lore
    // content, not the UI/database metadata used to organize that lore. Category,
    // kind, title, tags, and pin state remain visible in the UI but are not
    // injected. Compressed mode should receive the same clean direct text as its
    // source material; model compression is handled separately and cached.
    return `- ${injectionText}`;
}

function normalizeInjectionLine(text) {
    return String(text || '')
        .replace(/\s+/g, ' ')
        .trim();
}

function truncateForInjection(text, maxLen) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (value.length <= maxLen) return value;
    return value.slice(0, maxLen).replace(/\s+\S*$/, '') + '...';
}

export function buildMemoPreview(state, mode = null) {
    const override = mode ? { loreInjectionMode: mode } : {};
    return buildMemo(state, override);
}

export function buildContinuityPreview(state, mode = null) {
    const override = mode ? { continuityInjectionMode: mode } : {};
    return buildContinuityMemo(state, override);
}

export function buildLorePreview(state, mode = null, tier = null) {
    const override = mode ? { loreInjectionMode: mode } : {};
    if (tier) {
        const normalizedTier = normalizeLoreRelevance(tier);
        override.relevanceTier = normalizedTier;
        override[tierSettingKey(normalizedTier, 'InjectionMode')] = mode || getSettings()[tierSettingKey(normalizedTier, 'InjectionMode')];
    }
    return buildLoreMemo(state, override);
}

export function getMemoSignature(state, mode = null, kind = 'combined') {
    const settings = { ...getSettings(), ...(mode ? (kind === 'continuity' ? { continuityInjectionMode: mode } : { loreInjectionMode: mode }) : {}) };
    const payload = {
        kind,
        loreMode: settings.loreInjectionMode || 'direct',
        loreHighMode: settings.loreHighInjectionMode || 'direct',
        loreNormalMode: settings.loreNormalInjectionMode || 'compressed',
        loreLowMode: settings.loreLowInjectionMode || 'compressed',
        loreLevel: settings.loreCompressionLevel || 3,
        continuityMode: settings.continuityInjectionMode || 'direct',
        continuityLevel: settings.continuityCompressionLevel || 3,
        injectContinuity: settings.injectContinuity !== false && settings.injectMemo !== false,
        injectLore: !!settings.injectLore,
        continuityConfig: state?.continuityConfig || {},
        continuityState: kind !== 'lore' ? {
            canon: state?.canon || {},
            scene: state?.scene || {},
            characters: state?.characters || [],
            inventory: state?.inventory || [],
            objectives: state?.objectives || [],
            threads: state?.threads || [],
        } : null,
        loreIds: kind !== 'continuity' ? (state?.loreMatrix || []).map(e => `${e?.id || ''}:${e?.relevance || ''}:${e?.priority || 0}:${e?.updatedAt || ''}:${e?.userEdited ? 1 : 0}`).join('|') : '',
        pinned: (state?.loreSelection?.pinnedIds || []).join('|'),
        muted: (state?.loreSelection?.suppressedIds || []).join('|'),
    };
    return JSON.stringify(payload);
}

globalThis._wandlightBuildMemo = buildMemo;
