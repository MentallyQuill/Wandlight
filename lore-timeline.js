/**
 * lore-timeline.js - Wandlight
 * Compact lore-event ledger, per-entry history helpers, and recovery utilities.
 */

import { normalizeLoreEntry, normalizeLoreMatrix, mergeLoreEntries } from './lore-matrix.js';

export const LORE_TIMELINE_SCHEMA_VERSION = 1;
export const LORE_TIMELINE_MAX_EVENTS = 500;
export const LORE_TIMELINE_MAX_PAYLOAD_ENTRIES = 80;

function now() {
    return Date.now();
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function asString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function cloneJson(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

function uniqueStrings(values = []) {
    const seen = new Set();
    const out = [];
    for (const raw of values) {
        const text = asString(raw);
        if (!text) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(text);
    }
    return out;
}

function truncateText(value, max = 1200) {
    const text = asString(value);
    if (text.length <= max) return text;
    return `${text.slice(0, Math.max(0, max - 3))}...`;
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

function getCurrentMessageRange() {
    try {
        if (typeof SillyTavern === 'undefined' || typeof SillyTavern.getContext !== 'function') return null;
        const chat = SillyTavern.getContext()?.chat || [];
        const latest = Array.isArray(chat) ? chat.length : 0;
        return latest > 0 ? { start: latest, end: latest, latest } : null;
    } catch (_) {
        return null;
    }
}

function compactLoreEntry(entry) {
    const normalized = normalizeLoreEntry(entry || {});
    return normalizeLoreEntry({
        id: normalized.id,
        title: truncateText(normalized.title, 220),
        category: normalized.category,
        canon: normalized.canon,
        canonStatus: normalized.canonStatus,
        relevance: normalized.relevance,
        lorePurpose: normalized.lorePurpose,
        truthStatus: normalized.truthStatus,
        revealPolicy: normalized.revealPolicy,
        priority: normalized.priority,
        tags: uniqueStrings(normalized.tags).slice(0, 16),
        branchId: normalized.branchId || 'main',
        protected: normalized.protected,
        locked: normalized.locked,
        userEditable: normalized.userEditable,
        userEdited: normalized.userEdited,
        date: normalized.date,
        canonTiming: normalized.canonTiming,
        activation: normalized.activation,
        expiration: normalized.expiration,
        scope: normalized.scope,
        visibility: normalized.visibility,
        content: {
            fact: truncateText(normalized.content?.fact || normalized.fact, 1800),
            injection: truncateText(normalized.content?.injection, 1800),
            constraints: uniqueStrings(normalized.content?.constraints).slice(0, 10),
            antiLore: uniqueStrings(normalized.content?.antiLore).slice(0, 10),
            publicVersion: truncateText(normalized.content?.publicVersion, 700),
            notes: truncateText(normalized.content?.notes || normalized.notes, 900),
        },
        fact: truncateText(normalized.fact || normalized.content?.fact, 1800),
        source: normalized.source,
        sourceInfo: normalized.sourceInfo,
        extensions: normalized.extensions,
    });
}

function compactRef(entry) {
    const e = normalizeLoreEntry(entry || {});
    return {
        id: e.id,
        title: truncateText(e.title, 160),
        category: e.category,
        relevance: e.relevance,
        canon: e.canon || e.canonStatus,
        hash: hashLoreEntry(e),
    };
}

export function hashLoreEntry(entry) {
    const e = normalizeLoreEntry(entry || {});
    return stableStringHash({
        id: e.id,
        title: e.title,
        category: e.category,
        canon: e.canon,
        canonStatus: e.canonStatus,
        relevance: e.relevance,
        lorePurpose: e.lorePurpose,
        truthStatus: e.truthStatus,
        revealPolicy: e.revealPolicy,
        priority: e.priority,
        tags: uniqueStrings(e.tags).sort(),
        fact: e.fact || e.content?.fact || '',
        injection: e.content?.injection || '',
        constraints: uniqueStrings(e.content?.constraints).sort(),
        antiLore: uniqueStrings(e.content?.antiLore).sort(),
        notes: e.notes || e.content?.notes || '',
        branchId: e.branchId || '',
        date: e.date || {},
        scope: e.scope || {},
        visibility: e.visibility || {},
    });
}

export function normalizeLoreTimeline(value = {}) {
    const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const events = asArray(raw.events)
        .filter(event => event && typeof event === 'object')
        .slice(-LORE_TIMELINE_MAX_EVENTS)
        .map(event => ({
            id: asString(event.id) || `lore_event_${now()}_${Math.random().toString(36).slice(2, 8)}`,
            timestamp: Number.isFinite(Number(event.timestamp)) ? Number(event.timestamp) : now(),
            messageRange: event.messageRange && typeof event.messageRange === 'object' ? event.messageRange : null,
            sceneDate: asString(event.sceneDate),
            canonBoundary: asString(event.canonBoundary),
            branchId: asString(event.branchId) || 'main',
            type: asString(event.type) || 'lore_change',
            source: asString(event.source) || 'manual',
            summary: asString(event.summary) || 'Lore changed.',
            counts: {
                added: Math.max(0, Number(event.counts?.added) || 0),
                deleted: Math.max(0, Number(event.counts?.deleted) || 0),
                updated: Math.max(0, Number(event.counts?.updated) || 0),
                pinned: Math.max(0, Number(event.counts?.pinned) || 0),
                muted: Math.max(0, Number(event.counts?.muted) || 0),
                pending: Math.max(0, Number(event.counts?.pending) || 0),
                restored: Math.max(0, Number(event.counts?.restored) || 0),
            },
            refs: asArray(event.refs).filter(ref => ref && typeof ref === 'object').slice(0, 80),
            reversible: event.reversible !== false,
            patch: event.patch && typeof event.patch === 'object' ? event.patch : {},
        }));
    return {
        schemaVersion: LORE_TIMELINE_SCHEMA_VERSION,
        events,
    };
}

export function ensureLoreTimeline(state) {
    if (!state || typeof state !== 'object') return normalizeLoreTimeline();
    state.loreTimeline = normalizeLoreTimeline(state.loreTimeline);
    return state.loreTimeline;
}

export function captureLoreTimelineState(state = {}) {
    const entries = normalizeLoreMatrix(state?.loreMatrix || []);
    const byId = new Map(entries.map(entry => [entry.id, entry]));
    const pinSet = new Set(asArray(state?.loreSelection?.pinnedIds).filter(Boolean));
    const muteSet = new Set(asArray(state?.loreSelection?.suppressedIds).filter(Boolean));
    return {
        entries,
        byId,
        hashes: new Map(entries.map(entry => [entry.id, hashLoreEntry(entry)])),
        pinnedIds: Array.from(pinSet),
        mutedIds: Array.from(muteSet),
    };
}

function listChangedSelection(beforeIds = [], afterIds = []) {
    const before = new Set(beforeIds);
    const after = new Set(afterIds);
    const added = [];
    const removed = [];
    for (const id of after) if (!before.has(id)) added.push(id);
    for (const id of before) if (!after.has(id)) removed.push(id);
    return { added, removed };
}

function buildDiff(before, after) {
    const beforeById = before?.byId || new Map();
    const afterById = after?.byId || new Map();
    const beforeHashes = before?.hashes || new Map();
    const afterHashes = after?.hashes || new Map();

    const addedEntries = [];
    const deletedEntries = [];
    const beforeEntries = [];
    const afterEntries = [];
    const touchedIds = new Set();

    for (const entry of after?.entries || []) {
        if (!beforeById.has(entry.id)) {
            addedEntries.push(compactLoreEntry(entry));
            touchedIds.add(entry.id);
        }
    }

    for (const entry of before?.entries || []) {
        if (!afterById.has(entry.id)) {
            deletedEntries.push(compactLoreEntry(entry));
            touchedIds.add(entry.id);
        }
    }

    for (const entry of after?.entries || []) {
        if (!beforeById.has(entry.id)) continue;
        if (beforeHashes.get(entry.id) === afterHashes.get(entry.id)) continue;
        beforeEntries.push(compactLoreEntry(beforeById.get(entry.id)));
        afterEntries.push(compactLoreEntry(entry));
        touchedIds.add(entry.id);
    }

    const pinChanges = listChangedSelection(before?.pinnedIds, after?.pinnedIds);
    const muteChanges = listChangedSelection(before?.mutedIds, after?.mutedIds);
    for (const id of [...pinChanges.added, ...pinChanges.removed, ...muteChanges.added, ...muteChanges.removed]) {
        touchedIds.add(id);
    }

    const refs = Array.from(touchedIds)
        .map(id => afterById.get(id) || beforeById.get(id))
        .filter(Boolean)
        .map(compactRef);

    return {
        addedEntries,
        deletedEntries,
        beforeEntries,
        afterEntries,
        pinChanges,
        muteChanges,
        refs,
        touchedIds: Array.from(touchedIds),
        counts: {
            added: addedEntries.length,
            deleted: deletedEntries.length,
            updated: beforeEntries.length,
            pinned: pinChanges.added.length + pinChanges.removed.length,
            muted: muteChanges.added.length + muteChanges.removed.length,
        },
    };
}

function summarizeEvent(type, counts, fallback = 'Lore changed.') {
    const parts = [];
    if (counts.added) parts.push(`+${counts.added} added`);
    if (counts.deleted) parts.push(`-${counts.deleted} deleted`);
    if (counts.updated) parts.push(`${counts.updated} updated`);
    if (counts.pinned) parts.push(`${counts.pinned} pin changes`);
    if (counts.muted) parts.push(`${counts.muted} mute changes`);
    if (counts.pending) parts.push(`${counts.pending} pending`);
    if (counts.restored) parts.push(`${counts.restored} restored`);
    return parts.length ? `${type.replace(/_/g, ' ')}: ${parts.join(', ')}` : fallback;
}

export function recordLoreTimelineEvent(state, input = {}) {
    if (!state || typeof state !== 'object') return null;
    const timeline = ensureLoreTimeline(state);
    const before = input.before || null;
    const after = input.after || captureLoreTimelineState(state);
    const diff = before ? buildDiff(before, after) : {
        addedEntries: asArray(input.addedEntries).map(compactLoreEntry),
        deletedEntries: asArray(input.deletedEntries).map(compactLoreEntry),
        beforeEntries: asArray(input.beforeEntries).map(compactLoreEntry),
        afterEntries: asArray(input.afterEntries).map(compactLoreEntry),
        pinChanges: input.pinChanges || { added: [], removed: [] },
        muteChanges: input.muteChanges || { added: [], removed: [] },
        refs: asArray(input.refs),
        touchedIds: asArray(input.touchedIds),
        counts: input.counts || {},
    };

    const counts = {
        added: Math.max(0, Number(input.counts?.added ?? diff.counts?.added) || 0),
        deleted: Math.max(0, Number(input.counts?.deleted ?? diff.counts?.deleted) || 0),
        updated: Math.max(0, Number(input.counts?.updated ?? diff.counts?.updated) || 0),
        pinned: Math.max(0, Number(input.counts?.pinned ?? diff.counts?.pinned) || 0),
        muted: Math.max(0, Number(input.counts?.muted ?? diff.counts?.muted) || 0),
        pending: Math.max(0, Number(input.counts?.pending) || 0),
        restored: Math.max(0, Number(input.counts?.restored) || 0),
    };

    const hasChange = Object.values(counts).some(value => value > 0);
    if (!hasChange && input.force !== true) return null;

    const context = state.loreContext || {};
    const type = asString(input.type) || 'lore_change';
    const refs = asArray(input.refs).length ? asArray(input.refs) : diff.refs;
    const event = {
        id: asString(input.id) || `lore_event_${now()}_${stableStringHash(`${type}:${now()}:${refs.map(ref => ref.id).join('|')}`).slice(0, 8)}`,
        timestamp: Number.isFinite(Number(input.timestamp)) ? Number(input.timestamp) : now(),
        messageRange: input.messageRange || getCurrentMessageRange(),
        sceneDate: asString(input.sceneDate) || asString(context.sceneDate),
        canonBoundary: asString(input.canonBoundary) || asString(context.canonBoundary),
        branchId: asString(input.branchId) || asString(context.branchId) || 'main',
        type,
        source: asString(input.source) || 'manual',
        summary: asString(input.summary) || summarizeEvent(type, counts),
        counts,
        refs: refs.slice(0, 80),
        reversible: input.reversible !== false,
        patch: {
            addedEntries: diff.addedEntries.slice(0, LORE_TIMELINE_MAX_PAYLOAD_ENTRIES),
            deletedEntries: diff.deletedEntries.slice(0, LORE_TIMELINE_MAX_PAYLOAD_ENTRIES),
            beforeEntries: diff.beforeEntries.slice(0, LORE_TIMELINE_MAX_PAYLOAD_ENTRIES),
            afterEntries: diff.afterEntries.slice(0, LORE_TIMELINE_MAX_PAYLOAD_ENTRIES),
            pinChanges: diff.pinChanges,
            muteChanges: diff.muteChanges,
            touchedIds: diff.touchedIds.slice(0, LORE_TIMELINE_MAX_PAYLOAD_ENTRIES),
            ...(input.patch && typeof input.patch === 'object' ? input.patch : {}),
        },
    };

    timeline.events.push(event);
    if (timeline.events.length > LORE_TIMELINE_MAX_EVENTS) {
        timeline.events = timeline.events.slice(-LORE_TIMELINE_MAX_EVENTS);
    }
    state.loreTimeline = timeline;
    return event;
}

export function getLoreTimelineEvents(state = {}) {
    return normalizeLoreTimeline(state?.loreTimeline).events;
}

export function getLoreTimelineSummary(state = {}) {
    const events = getLoreTimelineEvents(state);
    const counts = events.reduce((acc, event) => {
        acc.added += Number(event.counts?.added) || 0;
        acc.deleted += Number(event.counts?.deleted) || 0;
        acc.updated += Number(event.counts?.updated) || 0;
        acc.pending += Number(event.counts?.pending) || 0;
        acc.restored += Number(event.counts?.restored) || 0;
        return acc;
    }, { added: 0, deleted: 0, updated: 0, pending: 0, restored: 0 });
    return {
        eventCount: events.length,
        counts,
        latest: events[events.length - 1] || null,
    };
}

export function getEntryLoreHistory(state = {}, entryId = '') {
    const id = asString(entryId);
    if (!id) return [];
    return getLoreTimelineEvents(state).filter(event => {
        if (event.refs?.some(ref => ref.id === id)) return true;
        const patch = event.patch || {};
        return [
            patch.addedEntries,
            patch.deletedEntries,
            patch.beforeEntries,
            patch.afterEntries,
        ].some(list => asArray(list).some(entry => entry?.id === id));
    });
}

export function getRecoverableTimelineEntries(event = {}) {
    const patch = event.patch || {};
    const out = [];
    const pushEntries = (entries, recoveryKind) => {
        for (const entry of asArray(entries)) {
            if (!entry?.id) continue;
            out.push({ recoveryKind, entry: compactLoreEntry(entry) });
        }
    };
    pushEntries(patch.deletedEntries, 'deleted');
    pushEntries(patch.beforeEntries, 'prior_version');
    if (!out.length) pushEntries(patch.addedEntries, 'created_version');

    const seen = new Set();
    return out.filter(item => {
        const key = `${item.recoveryKind}:${item.entry.id}:${hashLoreEntry(item.entry)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export function restoreTimelineEntriesToPending(state, eventId, entryIds = null) {
    if (!state || typeof state !== 'object') return { restored: 0, entries: [] };
    const events = getLoreTimelineEvents(state);
    const event = events.find(item => item.id === eventId);
    if (!event) return { restored: 0, entries: [] };
    const wanted = entryIds ? new Set(asArray(entryIds).filter(Boolean)) : null;
    const recoverable = getRecoverableTimelineEntries(event)
        .filter(item => !wanted || wanted.has(item.entry.id));
    if (!recoverable.length) return { restored: 0, entries: [] };

    const recoveredAt = now();
    const recovered = recoverable.map(item => normalizeLoreEntry({
        ...cloneJson(item.entry),
        source: 'timeline-recovery',
        sourceInfo: {
            ...(item.entry.sourceInfo || {}),
            work: 'Wandlight Timeline',
            notes: `Recovered from timeline event ${event.id}.`,
            confidence: item.entry.sourceInfo?.confidence || 1,
        },
        extensions: {
            ...(item.entry.extensions || {}),
            wandlightTimelineRecovery: {
                eventId: event.id,
                eventType: event.type,
                recoveryKind: item.recoveryKind,
                recoveredAt,
                originalTimestamp: event.timestamp,
            },
        },
    }));

    const pending = normalizeLoreMatrix(state.pendingLoreEntries || []);
    state.pendingLoreEntries = mergeLoreEntries(pending, recovered);
    state.pendingLoreMeta = {
        ...(state.pendingLoreMeta && typeof state.pendingLoreMeta === 'object' ? state.pendingLoreMeta : {}),
        id: state.pendingLoreMeta?.id || `timeline_recovery_${recoveredAt}`,
        source: 'timeline_recovery',
        status: 'pending',
        updatedAt: recoveredAt,
        summary: `Recovered ${recovered.length} lore entr${recovered.length === 1 ? 'y' : 'ies'} from Lore Timeline.`,
        validEntryCount: state.pendingLoreEntries.length,
    };

    recordLoreTimelineEvent(state, {
        type: 'restore_to_pending',
        source: 'timeline_recovery',
        summary: `Restored ${recovered.length} timeline entr${recovered.length === 1 ? 'y' : 'ies'} to Pending Lore Review.`,
        counts: { pending: recovered.length, restored: recovered.length },
        refs: recovered.map(compactRef),
        patch: { restoredFromEventId: event.id },
        reversible: false,
        force: true,
    });

    return { restored: recovered.length, entries: recovered };
}

export const __loreTimelineTestHooks = {
    compactLoreEntry,
    hashLoreEntry,
    buildDiff,
    stableStringHash,
};
