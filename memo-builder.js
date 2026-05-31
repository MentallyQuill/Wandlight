/**
 * memo-builder.js — Wandlight Continuity
 * Builds split continuity-state and lore-entry injection previews/memos.
 */

import {
    MAX_PRESENT_CHARS_IN_MEMO,
    MAX_KNOWLEDGE_FACTS_PER_CHAR,
    MAX_ACTIVE_THREADS_IN_MEMO,
    MAX_RELATIONSHIPS_IN_MEMO,
    MAX_FLAGS_IN_MEMO,
    MAX_LORE_ENTRIES_IN_MEMO,
} from './constants.js';
import { getSettings } from './state-manager.js';
import { getInjectableLoreEntries } from './lore-matrix.js';

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

function getCachedModelCompression(state, settings, kind) {
    if (!state) return '';
    const mode = kind === 'continuity' ? settings.continuityInjectionMode : settings.loreInjectionMode;
    if (mode !== 'compressed') return '';
    const statusKey = kind === 'continuity' ? 'continuityCompressionStatus' : 'loreCompressionStatus';
    const status = state[statusKey] || {};
    // If the user selects compressed mode, prefer the last saved model compression.
    // It may be stale relative to the latest state; the Injection tab status reports that.
    // Do not silently trigger recompression from preview/injection construction.
    return typeof status.cachedText === 'string' && status.cachedText.trim()
        ? status.cachedText.trim()
        : '';
}

export function buildContinuityMemo(state, settingsOverride = {}) {
    if (!state) return '';
    const settings = { ...getSettings(), ...(settingsOverride || {}) };
    const cached = getCachedModelCompression(state, settings, 'continuity');
    if (cached) return cached;
    // Compressed mode should use model-compressed cached text only. If no cache
    // exists, fall back to direct preview/injection rather than deterministic
    // truncation; the Injection tab tells the user to run Compress Continuity Now.
    if ((settings.continuityInjectionMode || 'direct') === 'compressed') {
        settings.continuityInjectionMode = 'direct';
    }
    const cfg = state.continuityConfig || {};
    const lines = [];

    const enabled = (section) => cfg[section] !== false;

    if (enabled('canon')) {
        const canonParts = [];
        if (state.canon?.era) canonParts.push(`Era: ${state.canon.era}`);
        if (state.canon?.inUniverseDate) canonParts.push(`Date: ${state.canon.inUniverseDate}`);
        if (state.canon?.canonBoundary) canonParts.push(`Canon boundary: ${state.canon.canonBoundary}`);
        if (canonParts.length) {
            lines.push('## Canon / Date');
            lines.push(compressLine(canonParts.join(' | '), settings, 'continuity'));
        }
        if (Array.isArray(state.canon?.divergences) && state.canon.divergences.length) {
            for (const d of state.canon.divergences.slice(0, 5)) {
                lines.push(compressLine(`- Divergence: ${d.description || d}${d.sinceDate ? ` (since ${d.sinceDate})` : ''}`, settings, 'continuity'));
            }
        }
    }

    if (enabled('scene')) {
        const hasScene = state.scene?.location || state.scene?.timeOfDay || state.scene?.weather || state.scene?.ambience
            || (state.scene?.presentCharacters || []).length || state.scene?.currentActivity;
        if (hasScene) {
            lines.push('');
            lines.push('## Scene');
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

    if (enabled('knowledge') && state.knowledge && Object.keys(state.knowledge).length) {
        const relevantKnowledge = filterRelevantKnowledge(state);
        if (Object.keys(relevantKnowledge).length) {
            lines.push('');
            lines.push('## Character Knowledge');
            for (const [char, facts] of Object.entries(relevantKnowledge).slice(0, 8)) {
                const truncated = facts.slice(0, MAX_KNOWLEDGE_FACTS_PER_CHAR);
                lines.push(compressLine(`${char}: ${truncated.join('; ')}`, settings, 'continuity'));
            }
        }
    }

    if (enabled('secrets') && Array.isArray(state.secrets) && state.secrets.length) {
        const nonPublicSecrets = state.secrets.filter(isNonPublicSecret).slice(0, 8);
        if (nonPublicSecrets.length) {
            lines.push('');
            lines.push('## Secrets');
            for (const s of nonPublicSecrets) {
                const parts = [`- ${s.fact}`];
                if (s.trueState) parts.push(`Truth: ${s.trueState}`);
                if (s.publicVersion) parts.push(`Public: ${s.publicVersion}`);
                if ((s.whoKnows || []).length) parts.push(`Known by: ${s.whoKnows.join(', ')}`);
                lines.push(compressLine(parts.join(' | '), settings, 'continuity'));
            }
        }
    }

    if (enabled('relationships') && Array.isArray(state.relationships) && state.relationships.length) {
        const rels = state.relationships.slice(0, MAX_RELATIONSHIPS_IN_MEMO);
        if (rels.length) {
            lines.push('');
            lines.push('## Relationships');
            for (const r of rels) {
                const parts = [`- ${r.pair}`];
                if (r.notes) parts.push(r.notes);
                if (r.tension) parts.push(`tension: ${r.tension}`);
                if (r.trust) parts.push(`trust: ${r.trust}`);
                lines.push(compressLine(parts.join(' | '), settings, 'continuity'));
            }
        }
    }

    if (enabled('threads') && Array.isArray(state.threads) && state.threads.length) {
        const activeThreads = state.threads.filter(t => t.status === 'active').slice(0, MAX_ACTIVE_THREADS_IN_MEMO);
        if (activeThreads.length) {
            lines.push('');
            lines.push('## Active Threads');
            for (const t of activeThreads) {
                lines.push(compressLine(`- ${t.description}${(t.unresolvedConsequences || []).length ? ` | hooks: ${t.unresolvedConsequences.join('; ')}` : ''}`, settings, 'continuity'));
            }
        }
    }

    if (enabled('inventory') && Array.isArray(state.inventory) && state.inventory.length) {
        lines.push('');
        lines.push('## Inventory / Objects');
        for (const i of state.inventory.slice(0, 10)) {
            lines.push(compressLine(`- ${i.owner || 'Unowned'}: ${i.item}${i.status ? ` (${i.status})` : ''}${i.location ? ` at ${i.location}` : ''}`, settings, 'continuity'));
        }
    }

    if (enabled('objectives') && Array.isArray(state.objectives) && state.objectives.length) {
        lines.push('');
        lines.push('## Objectives');
        for (const o of state.objectives.filter(x => x.status !== 'completed' && x.status !== 'abandoned').slice(0, 8)) {
            lines.push(compressLine(`- ${o.owner || 'Story'}: ${o.goal}${o.status ? ` [${o.status}]` : ''}${o.stakes ? ` | stakes: ${o.stakes}` : ''}`, settings, 'continuity'));
        }
    }

    if (enabled('flags')) {
        const flags = (state.continuityFlags || []).filter(f => !f?.resolved).slice(0, MAX_FLAGS_IN_MEMO);
        if (flags.length) {
            lines.push('');
            lines.push('## Continuity Flags');
            for (const f of flags) lines.push(`- [${f.severity}] ${f.type}: ${f.description}`);
        }
    }

    const body = lines.join('\n').trim();
    return body ? `## Continuity State\n${body}` : '';
}

export function buildLoreMemo(state, settingsOverride = {}) {
    if (!state) return '';
    const settings = { ...getSettings(), ...(settingsOverride || {}) };
    const cached = getCachedModelCompression(state, settings, 'lore');
    if (cached) return cached;
    // Same rule as continuity: compressed mode uses cached model compression only.
    // Without a cache, use direct injection until the user explicitly compresses.
    if ((settings.loreInjectionMode || 'direct') === 'compressed') {
        settings.loreInjectionMode = 'direct';
    }
    const maxLore = Number(settings.maxLoreEntriesInMemo) || 0;
    const activeLore = getInjectableLoreEntries(state, maxLore);
    if (!activeLore.length) return '';

    const lines = [];
    lines.push(settings.loreInjectionMode === 'compressed' ? '## Lore Entries (Compressed)' : '## Lore Entries');
    const pinnedIds = new Set(state?.loreSelection?.pinnedIds || []);
    for (const entry of activeLore) {
        lines.push(formatLoreEntryForInjection(entry, settings, pinnedIds.has(entry.id)));
    }
    return lines.join('\n');
}

function filterRelevantKnowledge(state) {
    const presentChars = state.scene?.presentCharacters || [];
    if (!presentChars.length) return state.knowledge || {};
    const presentLower = presentChars.map(c => c.toLowerCase().trim());
    const relevant = {};
    for (const [char, facts] of Object.entries(state.knowledge || {})) {
        const charLower = char.toLowerCase().trim();
        const isRelevant = presentLower.some(pc => charLower === pc || charLower.includes(pc) || pc.includes(charLower) || pc.split(' ').some(w => w.length > 2 && charLower.includes(w)));
        if (isRelevant && Array.isArray(facts) && facts.length) relevant[char] = facts;
    }
    return relevant;
}

function isNonPublicSecret(s) {
    const who = Array.isArray(s?.whoKnows) ? s.whoKnows : (typeof s?.whoKnows === 'string' ? [s.whoKnows] : []);
    if (!who.length) return true;
    const whoLower = who.map(w => w.toLowerCase());
    return !whoLower.includes('everyone') && !whoLower.includes('all') && !whoLower.includes('public');
}

function formatEmotionalState(raw = {}, settings = getSettings()) {
    const turns = getChatLength() - Number(raw.lastUpdatedChatLength || getChatLength());
    const decayWindow = Math.max(1, Number(settings.continuityEmotionDecayTurns || 6));
    const decaySteps = Math.max(0, Math.floor(turns / decayWindow));
    const keys = ['affection', 'trust', 'desire', 'connection', 'fear', 'anger', 'sadness', 'joy'];
    const labels = [];
    for (const key of keys) {
        let val = Number(raw[key] || 0);
        if (['fear', 'anger', 'sadness', 'joy', 'desire'].includes(key)) {
            val = coolTowardZero(val, decaySteps);
        }
        if (Math.abs(val) >= 2) labels.push(`${key} ${val > 0 ? '+' : ''}${val}`);
    }
    if (raw.notes) labels.push(String(raw.notes));
    return labels.join(', ');
}

function coolTowardZero(value, steps) {
    if (!steps) return value;
    if (value > 0) return Math.max(0, value - steps);
    if (value < 0) return Math.min(0, value + steps);
    return value;
}

function getChatLength() {
    try {
        const ctx = SillyTavern.getContext();
        return Array.isArray(ctx?.chat) ? ctx.chat.length : 0;
    } catch (_) {
        return 0;
    }
}

function compressLine(text, settings, kind) {
    const mode = kind === 'continuity' ? (settings.continuityInjectionMode || 'direct') : (settings.loreInjectionMode || 'direct');
    if (mode !== 'compressed') return text;
    const level = kind === 'continuity'
        ? Math.max(1, Math.min(5, Number(settings.continuityCompressionLevel) || 2))
        : Math.max(1, Math.min(5, Number(settings.loreCompressionLevel) || 2));
    const limits = [420, 320, 240, 170, 110];
    return truncateForInjection(text, limits[level - 1]);
}

function getLoreInjectionText(entry) {
    const content = entry?.content || {};
    const text = content.injection || content.fact || entry.fact || '';
    const constraints = Array.isArray(content.constraints) && content.constraints.length
        ? ` Constraints: ${content.constraints.join(' ')}`
        : '';
    const antiLore = Array.isArray(content.antiLore) && content.antiLore.length
        ? ` Avoid: ${content.antiLore.join(' ')}`
        : '';
    return `${text}${constraints}${antiLore}`.trim();
}

function formatLoreEntryForInjection(entry, settings, isPinned = false) {
    const injectionText = getLoreInjectionText(entry);
    const kind = entry.kind && entry.kind !== 'fact' ? `/${entry.kind}` : '';
    if ((settings?.loreInjectionMode || 'direct') !== 'compressed') {
        const parts = [`- <${entry.category}${kind}> **${entry.title}**`];
        if (injectionText) parts.push(`\n    ${injectionText}`);
        appendRevealHints(parts, entry);
        return parts.join('');
    }

    const level = Math.max(1, Math.min(5, Number(settings?.loreCompressionLevel) || 2));
    const regularLimits = [320, 240, 180, 120, 80];
    const pinnedLimits = [520, 420, 320, 240, 180];
    const limit = isPinned ? pinnedLimits[level - 1] : regularLimits[level - 1];
    const tags = Array.isArray(entry.tags) && entry.tags.length ? ` [${entry.tags.slice(0, 4).join(', ')}]` : '';
    const pin = isPinned ? ' pinned' : '';
    const fact = truncateForInjection(injectionText, limit);
    const parts = [`- <${entry.category}${kind}${pin}> ${entry.title}${tags}: ${fact}`];
    appendRevealHints(parts, entry, true);
    return parts.join('');
}

function appendRevealHints(parts, entry, compact = false) {
    const prefix = compact ? ' ' : '\n    ';
    if (entry.revealPolicy === 'do_not_reveal') {
        parts.push(`${prefix}(Do Not Reveal)`);
    } else if (entry.revealPolicy === 'only_if_knower_present') {
        parts.push(`${prefix}(Only reveal if knowers present: ${(entry.whoKnowsTruth || []).join(', ') || 'unknown'})`);
    } else if (entry.revealPolicy === 'only_if_user_reveals') {
        parts.push(`${prefix}(Only reveal if user brings it up)`);
    }
    if (entry.publicVersion && entry.truthStatus !== 'true') {
        parts.push(`${prefix}(Public version: ${truncateForInjection(entry.publicVersion, 160)})`);
    }
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

export function buildLorePreview(state, mode = null) {
    const override = mode ? { loreInjectionMode: mode } : {};
    return buildLoreMemo(state, override);
}

export function getMemoSignature(state, mode = null, kind = 'combined') {
    const settings = { ...getSettings(), ...(mode ? (kind === 'continuity' ? { continuityInjectionMode: mode } : { loreInjectionMode: mode }) : {}) };
    const payload = {
        kind,
        loreMode: settings.loreInjectionMode || 'direct',
        loreLevel: settings.loreCompressionLevel || 2,
        continuityMode: settings.continuityInjectionMode || 'direct',
        continuityLevel: settings.continuityCompressionLevel || 2,
        injectContinuity: settings.injectContinuity !== false && settings.injectMemo !== false,
        injectLore: !!settings.injectLore,
        continuityConfig: state?.continuityConfig || {},
        continuityState: kind !== 'lore' ? {
            canon: state?.canon || {},
            scene: state?.scene || {},
            characters: state?.characters || [],
            inventory: state?.inventory || [],
            objectives: state?.objectives || [],
            knowledge: state?.knowledge || {},
            secrets: state?.secrets || [],
            relationships: state?.relationships || [],
            threads: state?.threads || [],
            flags: state?.continuityFlags || [],
        } : null,
        loreIds: kind !== 'continuity' ? (state?.loreMatrix || []).map(e => `${e?.id || ''}:${e?.updatedAt || ''}:${e?.userEdited ? 1 : 0}`).join('|') : '',
        pinned: (state?.loreSelection?.pinnedIds || []).join('|'),
        muted: (state?.loreSelection?.suppressedIds || []).join('|'),
    };
    return JSON.stringify(payload);
}

globalThis._wandlightBuildMemo = buildMemo;
