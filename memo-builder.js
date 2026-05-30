/**
 * memo-builder.js — Wandlight Continuity
 * Builds a compact continuity memo text from WandlightState, targeting
 * under ~500 tokens for ephemeral injection into prompt context.
 *
 * Imports: constants.js, state-manager.js
 * Imported by: prompt-injector.js, index.js
 * Registered on globalThis as: _wandlightBuildMemo
 */

import {
    LOG_PREFIX,
    MAX_PRESENT_CHARS_IN_MEMO,
    MAX_KNOWLEDGE_FACTS_PER_CHAR,
    MAX_ACTIVE_THREADS_IN_MEMO,
    MAX_RELATIONSHIPS_IN_MEMO,
    MAX_FLAGS_IN_MEMO,
    MAX_LORE_ENTRIES_IN_MEMO,
} from './constants.js';
import { getState } from './state-manager.js';
import { getActiveLoreEntries } from './lore-matrix.js';

/**
 * Builds a compact continuity memo string from the given state object.
 * Targets under ~500 tokens. Returns empty string if state has no meaningful data.
 * @param {Object} state - WandlightState
 * @returns {string} Memo string for ephemeral injection
 */
export function buildMemo(state) {
    if (!state) return '';

    const lines = [];
    let hasContent = false;

    // ── Canon block ──
    const canonParts = [];
    if (state.canon?.era) canonParts.push(`Era: ${state.canon.era}`);
    if (state.canon?.inUniverseDate) canonParts.push(`Date: ${state.canon.inUniverseDate}`);
    if (state.canon?.canonBoundary) canonParts.push(`Canon: ${state.canon.canonBoundary}`);
    if (canonParts.length > 0) {
        lines.push('## Canon');
        lines.push(canonParts.join(' | '));
        hasContent = true;
    }
    if (state.canon?.divergences?.length > 0) {
        for (const d of state.canon.divergences) {
            lines.push(`- Divergence: ${d.description}${d.sinceDate ? ` (since ${d.sinceDate})` : ''}`);
        }
        hasContent = true;
    }

    // ── Scene block ──
    const hasScene = state.scene?.location || state.scene?.timeOfDay || state.scene?.weather
        || (state.scene?.presentCharacters?.length > 0) || state.scene?.currentActivity;
    if (hasScene) {
        const sceneParts = [];
        if (state.scene.location) sceneParts.push(`Location: ${state.scene.location}`);
        if (state.scene.timeOfDay) sceneParts.push(`Time: ${state.scene.timeOfDay}`);
        if (state.scene.weather) sceneParts.push(`Weather: ${state.scene.weather}`);
        if (sceneParts.length > 0) {
            lines.push('');
            lines.push('## Scene');
            lines.push(sceneParts.join(' | '));
        }
        if (state.scene.currentActivity) {
            lines.push(`Activity: ${state.scene.currentActivity}`);
        }
        if (state.scene.presentCharacters?.length > 0) {
            const chars = state.scene.presentCharacters.slice(0, MAX_PRESENT_CHARS_IN_MEMO);
            const suffix = state.scene.presentCharacters.length > MAX_PRESENT_CHARS_IN_MEMO
                ? ` (+${state.scene.presentCharacters.length - MAX_PRESENT_CHARS_IN_MEMO} more)` : '';
            lines.push(`Present: ${chars.join(', ')}${suffix}`);
        }
        if (state.scene.nearbyCharacters?.length > 0) {
            lines.push(`Nearby: ${state.scene.nearbyCharacters.join(', ')}`);
        }
        hasContent = true;
    }

    // ── Character Knowledge (fuzzy-matched to present characters) ──
    if (state.knowledge && Object.keys(state.knowledge).length > 0) {
        const presentChars = state.scene?.presentCharacters || [];
        const presentLower = presentChars.map(c => c.toLowerCase().trim());
        const relevantKnowledge = {};
        for (const [char, facts] of Object.entries(state.knowledge)) {
            // Fuzzy match: substring or word overlap with any present character name
            const charLower = char.toLowerCase().trim();
            const isRelevant = presentLower.some(pc =>
                charLower === pc ||
                charLower.includes(pc) ||
                pc.includes(charLower) ||
                (pc.split(' ').some(w => w.length > 2 && charLower.includes(w)))
            );
            if (isRelevant) {
                relevantKnowledge[char] = facts;
            }
        }
        if (Object.keys(relevantKnowledge).length > 0) {
            lines.push('');
            lines.push('## Character Knowledge');
            for (const [char, facts] of Object.entries(relevantKnowledge)) {
                if (!Array.isArray(facts) || facts.length === 0) continue;
                const truncated = facts.slice(0, MAX_KNOWLEDGE_FACTS_PER_CHAR);
                const suffix = facts.length > MAX_KNOWLEDGE_FACTS_PER_CHAR
                    ? ` (+${facts.length - MAX_KNOWLEDGE_FACTS_PER_CHAR} more)` : '';
                lines.push(`${char}: ${truncated.join('; ')}${suffix}`);
            }
            hasContent = true;
        }
    }

    // ── Secrets (filter to non-public only) ──
    if (state.secrets?.length > 0) {
        const nonPublicSecrets = state.secrets.filter(s => {
            // Consider "non-public" if whoKnows does NOT include "everyone" or "all"
            // Defensive: normalize whoKnows to array if it came in as a string
            const who = Array.isArray(s?.whoKnows) ? s.whoKnows : (typeof s?.whoKnows === 'string' ? [s.whoKnows] : []);
            if (who.length === 0) return true; // unknown audience = non-public
            const whoLower = who.map(w => w.toLowerCase());
            return !whoLower.includes('everyone') && !whoLower.includes('all') && !whoLower.includes('public');
        });
        if (nonPublicSecrets.length > 0) {
            lines.push('');
            lines.push('## Secrets');
            for (const s of nonPublicSecrets) {
                const parts = [`- ${s.fact}`];
                if (s.trueState) parts.push(`(Truth: ${s.trueState})`);
                if (s.publicVersion) parts.push(`(Public: ${s.publicVersion})`);
                const whoDisplay = Array.isArray(s?.whoKnows) ? s.whoKnows : (typeof s?.whoKnows === 'string' ? [s.whoKnows] : []);
                if (whoDisplay.length > 0) parts.push(`[Known by: ${whoDisplay.join(', ')}]`);
                lines.push(parts.join(' '));
            }
            hasContent = true;
        }
    }

    // ── Relationships (filter to medium+ tension only) ──
    if (state.relationships?.length > 0) {
        const tenseRels = state.relationships.filter(r =>
            r.tension === 'high' || r.tension === 'critical' || r.tension === 'medium'
        );
        if (tenseRels.length > 0) {
            lines.push('');
            lines.push('## Relationships');
            const rels = tenseRels.slice(0, MAX_RELATIONSHIPS_IN_MEMO);
            for (const r of rels) {
                const parts = [`- ${r.pair}`];
                if (r.notes) parts.push(`: ${r.notes}`);
                if (r.tension) parts.push(`[Tension: ${r.tension}]`);
                if (r.trust) parts.push(`[Trust: ${r.trust}]`);
                lines.push(parts.join(' '));
            }
            if (tenseRels.length > MAX_RELATIONSHIPS_IN_MEMO) {
                lines.push(`  (+${tenseRels.length - MAX_RELATIONSHIPS_IN_MEMO} more)`);
            }
            hasContent = true;
        }
    }

    // ── Active Threads (active status only) ──
    if (state.threads?.length > 0) {
        const activeThreads = state.threads.filter(t => t.status === 'active');
        if (activeThreads.length > 0) {
            lines.push('');
            lines.push('## Active Story Threads');
            const threads = activeThreads.slice(0, MAX_ACTIVE_THREADS_IN_MEMO);
            for (const t of threads) {
                const parts = [`- [${t.status}] ${t.description}`];
                if (t.unresolvedConsequences?.length > 0) {
                    parts.push(`(Hooks: ${t.unresolvedConsequences.join('; ')})`);
                }
                lines.push(parts.join(' '));
            }
            if (activeThreads.length > MAX_ACTIVE_THREADS_IN_MEMO) {
                lines.push(`  (+${activeThreads.length - MAX_ACTIVE_THREADS_IN_MEMO} more threads)`);
            }
            hasContent = true;
        }
    }

    // ── Continuity Flags ──
    // Defensive: flags may not have a "resolved" property; treat missing as unresolved
    const unresolvedFlags = (state.continuityFlags || []).filter(f => !f?.resolved);
    if (unresolvedFlags.length > 0) {
        lines.push('');
        lines.push('## Continuity Flags');
        const flags = unresolvedFlags.slice(0, MAX_FLAGS_IN_MEMO);
        for (const f of flags) {
            lines.push(`- [${f.severity}] ${f.type}: ${f.description}`);
        }
        if (unresolvedFlags.length > MAX_FLAGS_IN_MEMO) {
            lines.push(`  (+${unresolvedFlags.length - MAX_FLAGS_IN_MEMO} more flags)`);
        }
        hasContent = true;
    }

    // ── Lore Matrix (inject active lore entries) ──
    const activeLore = getActiveLoreEntries(state, MAX_LORE_ENTRIES_IN_MEMO);
    if (activeLore.length > 0) {
        lines.push('');
        lines.push('## Story Lore');
        for (const entry of activeLore) {
            const parts = [`- <${entry.category}> **${entry.title}**`];
            if (entry.fact) {
                parts.push(`\n    ${entry.fact}`);
            }
            // Show reveal policy hint
            if (entry.revealPolicy === 'do_not_reveal') {
                parts.push('\n    (Do Not Reveal — keep hidden from characters)');
            } else if (entry.revealPolicy === 'only_if_knower_present') {
                parts.push(`\n    (Only reveal if knowers present: ${(entry.whoKnowsTruth || []).join(', ') || 'unknown'})`);
            } else if (entry.revealPolicy === 'only_if_user_reveals') {
                parts.push('\n    (Only reveal if {{user}} brings it up)');
            }
            if (entry.publicVersion && entry.truthStatus !== 'true') {
                parts.push(`\n    (Public version: ${entry.publicVersion})`);
            }
            lines.push(parts.join(''));
        }
        hasContent = true;
    }

    if (!hasContent) return '';

    return '[WANDLIGHT CONTINUITY STATE]\n' + lines.join('\n') + '\n[/WANDLIGHT CONTINUITY STATE]';
}

// ── Expose on globalThis for dynamic access from state-manager (saveStateWithSnapshot) ──
globalThis._wandlightBuildMemo = buildMemo;