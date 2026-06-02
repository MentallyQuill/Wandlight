#!/usr/bin/env node
/**
 * Audits Wandlight canon lore preview metadata without a model call.
 *
 * Default mode is report-only:
 *   node scripts/audit-canon-preview.mjs
 *
 * Optional machine-readable output:
 *   node scripts/audit-canon-preview.mjs --json
 *
 * Optional safe metadata fill for entries missing ui.preview:
 *   node scripts/audit-canon-preview.mjs --write-safe
 */

import fs from 'node:fs';
import path from 'node:path';

const args = new Set(process.argv.slice(2));
const root = process.cwd();
const loreRoot = path.join(root, 'Lore');
const manifestPath = path.join(loreRoot, 'manifest.json');

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function asArray(value) {
    if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean);
    return value ? [String(value).trim()].filter(Boolean) : [];
}

function textFromEntry(entry = {}) {
    const content = entry.content || {};
    return [
        entry.id,
        entry.title,
        entry.kind,
        entry.category,
        entry.lorePurpose,
        entry.truthStatus,
        entry.revealPolicy,
        content.fact,
        content.injection,
        content.notes,
        ...asArray(content.constraints),
        ...asArray(content.antiLore),
        ...asArray(entry.tags),
    ].filter(Boolean).join(' ').toLowerCase();
}

function hasConstraintLanguage(entry = {}) {
    const text = textFromEntry(entry);
    return ['do not', 'should not', 'before ', 'not know', 'not reveal', 'unless our story', 'unless this story', 'without a story-established'].some(term => text.includes(term));
}

function normalizePackId(value) {
    const id = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const aliases = {
        guardrails: 'essential_guardrails',
        essential: 'essential_guardrails',
        secrets: 'year_secrets',
        active_secrets: 'year_secrets',
        hidden_knowledge: 'year_secrets',
        events: 'year_events',
        characters: 'present_characters',
        character: 'present_characters',
        spells: 'spells_skills',
        skills: 'spells_skills',
        items: 'items_access',
        access: 'items_access',
        all: 'all_active',
        all_matches: 'all_active',
    };
    return aliases[id] || id;
}

function previewConfig(entry = {}) {
    return entry?.ui?.preview && typeof entry.ui.preview === 'object' && !Array.isArray(entry.ui.preview)
        ? entry.ui.preview
        : {};
}

function inferRole(entry = {}) {
    const raw = previewConfig(entry);
    if (raw.suggestionRole) return String(raw.suggestionRole);
    const purpose = String(entry.lorePurpose || entry.purpose || '').toLowerCase();
    const kind = String(entry.kind || entry.gateType || '').toLowerCase();
    const category = String(entry.category || '').toLowerCase();
    const text = textFromEntry(entry);
    if (raw.activeUse === 'reference_only' || raw.referenceOnly === true) return 'reference_only';
    if (category === 'character' || category === 'relationship' || kind.includes('behavior') || kind.includes('relationship') || purpose.includes('behavior') || purpose.includes('relationship')) return 'character_state';
    if (category.includes('item') || category.includes('artifact') || category.includes('object') || kind.includes('artifact') || kind.includes('object')) return 'access_gate';
    if (category.includes('spell') || category.includes('skill') || kind.includes('spell') || kind.includes('skill')) return 'ability_gate';
    if (category.includes('secret') || category.includes('knowledge') || entry.truthStatus === 'hidden' || purpose.includes('knowledge') || purpose.includes('secret') || text.includes('not know') || text.includes('do not reveal')) return 'reveal_gate';
    if (kind.includes('guard') || category.includes('future_guard') || purpose.includes('temporal') || purpose.includes('constraint') || hasConstraintLanguage(entry)) return 'active_guardrail';
    if (category.includes('event') || category.includes('timeline') || kind.includes('event') || kind.includes('anchor') || purpose.includes('event') || purpose.includes('timeline')) return 'event_anchor';
    return 'reference_only';
}

function isCharacterEntry(entry = {}) {
    const purpose = String(entry.lorePurpose || entry.purpose || '').toLowerCase();
    const kind = String(entry.kind || entry.gateType || '').toLowerCase();
    const category = String(entry.category || '').toLowerCase();
    return category === 'character'
        || category === 'relationship'
        || kind.includes('behavior')
        || kind.includes('relationship')
        || purpose.includes('behavior')
        || purpose.includes('relationship');
}

function inferPack(entry = {}, role = inferRole(entry)) {
    const raw = previewConfig(entry);
    if (raw.primaryPack) return normalizePackId(raw.primaryPack);
    if (role === 'character_state') return 'present_characters';
    if (role === 'access_gate') return 'items_access';
    if (role === 'ability_gate') return 'spells_skills';
    if (role === 'reveal_gate') return 'year_secrets';
    if (role === 'event_anchor') return 'year_events';
    if (role === 'active_guardrail') return 'essential_guardrails';
    return 'all_active';
}

function inferDetail(entry = {}, role = inferRole(entry)) {
    const raw = previewConfig(entry);
    if (['core', 'standard', 'detailed'].includes(String(raw.detailLevel || '').toLowerCase())) return String(raw.detailLevel).toLowerCase();
    const priority = Number(entry.priority) || 50;
    const includeOnlyWhenRelevant = entry.effects?.injectionRules?.includeOnlyWhenRelevant === true;
    if (priority >= 90 || ['active_guardrail', 'reveal_gate'].includes(role)) return 'core';
    if (role === 'character_state' || role === 'access_gate') return 'standard';
    if (role === 'event_anchor') return 'detailed';
    if (role === 'ability_gate') return includeOnlyWhenRelevant || priority < 85 ? 'detailed' : 'standard';
    return 'standard';
}

function inferSuggestByDefault(entry = {}, role = inferRole(entry)) {
    const raw = previewConfig(entry);
    if (raw.suggestByDefault !== undefined) return raw.suggestByDefault !== false;
    if (raw.showByDefault !== undefined) return raw.showByDefault !== false;
    if (role === 'reference_only' || entry.injectableByDefault === false) return false;
    if (role === 'ability_gate' && entry.effects?.injectionRules?.includeOnlyWhenRelevant === true && Number(entry.priority || 50) < 85) return false;
    return true;
}

function dateSpanDays(entry = {}) {
    const from = Date.parse(entry.date?.validFrom || entry.validFrom || '');
    const to = Date.parse(entry.date?.validTo || entry.validTo || '');
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    return Math.max(0, Math.round((to - from) / 86400000));
}

function proposedPreview(entry = {}) {
    const raw = previewConfig(entry);
    const role = inferRole(entry);
    return {
        primaryPack: inferPack(entry, role),
        suggestionRole: role,
        detailLevel: inferDetail(entry, role),
        suggestByDefault: inferSuggestByDefault(entry, role),
        activeUse: raw.activeUse || (role === 'reference_only' ? 'reference_only' : ''),
    };
}

function flagsFor(entry = {}, proposed = proposedPreview(entry)) {
    const flags = [];
    const raw = previewConfig(entry);
    const allPacks = [raw.primaryPack, ...asArray(raw.secondaryPacks)].map(normalizePackId).filter(Boolean);
    const kind = String(entry.kind || entry.gateType || '').toLowerCase();
    const category = String(entry.category || '').toLowerCase();
    const span = dateSpanDays(entry);
    if (!raw.primaryPack) flags.push('missing-preview-metadata');
    if (allPacks.includes('present_characters') && !isCharacterEntry(entry)) flags.push('present-pack-non-character');
    if (proposed.suggestionRole === 'reference_only' && entry.injectableByDefault !== false) flags.push('reference-like-injectable');
    if ((kind.includes('spell') || category.includes('spell')) && span !== null && span > 730 && Number(entry.priority || 50) < 85 && proposed.suggestByDefault && proposed.activeUse !== 'blocks_early_spell_knowledge') {
        flags.push('long-lived-low-priority-spell-gate');
    }
    if ((kind.includes('event') || category.includes('event') || category.includes('timeline')) && !hasConstraintLanguage(entry) && entry.injectableByDefault !== false) {
        flags.push('positive-event-anchor-injectable');
    }
    return flags;
}

const manifest = readJson(manifestPath);
const files = asArray(manifest.files).map(file => path.join(loreRoot, file));
const entries = [];
for (const file of files) {
    const json = readJson(file);
    const list = Array.isArray(json.entries) ? json.entries : [];
    list.forEach((entry, index) => entries.push({ file, json, entry, index }));
}

const byRole = {};
const byPack = {};
const byDetail = {};
const byFlag = {};
const flagged = [];
let writtenFiles = 0;

for (const item of entries) {
    const proposed = proposedPreview(item.entry);
    const flags = flagsFor(item.entry, proposed);
    byRole[proposed.suggestionRole] = (byRole[proposed.suggestionRole] || 0) + 1;
    byPack[proposed.primaryPack] = (byPack[proposed.primaryPack] || 0) + 1;
    byDetail[proposed.detailLevel] = (byDetail[proposed.detailLevel] || 0) + 1;
    flags.forEach(flag => { byFlag[flag] = (byFlag[flag] || 0) + 1; });
    if (flags.length) {
        flagged.push({
            id: item.entry.id,
            title: item.entry.title,
            file: path.relative(root, item.file).replaceAll(path.sep, '/'),
            proposed,
            flags,
        });
    }
}

if (args.has('--write-safe')) {
    const changed = new Set();
    for (const item of entries) {
        const raw = previewConfig(item.entry);
        if (raw.primaryPack) continue;
        item.entry.ui = item.entry.ui && typeof item.entry.ui === 'object' && !Array.isArray(item.entry.ui) ? item.entry.ui : {};
        item.entry.ui.preview = proposedPreview(item.entry);
        changed.add(item.file);
    }
    for (const file of changed) {
        const item = entries.find(candidate => candidate.file === file);
        writeJson(file, item.json);
        writtenFiles += 1;
    }
}

const report = {
    files: files.length,
    entries: entries.length,
    byRole,
    byPack,
    byDetail,
    byFlag,
    flaggedCount: flagged.length,
    flagged: args.has('--json') ? flagged : flagged.slice(0, 80),
    writeSafe: args.has('--write-safe') ? { writtenFiles } : undefined,
};

if (args.has('--json')) {
    console.log(JSON.stringify(report, null, 2));
} else {
    console.log(`Canon preview audit: ${entries.length} entries across ${files.length} files`);
    console.log(`Roles: ${JSON.stringify(byRole)}`);
    console.log(`Packs: ${JSON.stringify(byPack)}`);
    console.log(`Detail: ${JSON.stringify(byDetail)}`);
    console.log(`Flags: ${JSON.stringify(byFlag)}`);
    if (flagged.length) {
        console.log('\nTop flagged entries:');
        for (const item of flagged.slice(0, 40)) {
            console.log(`- ${item.id || '(no id)'} | ${item.title || '(no title)'} | ${item.file} | ${item.flags.join(', ')}`);
        }
    }
    if (args.has('--write-safe')) {
        console.log(`\n--write-safe updated ${writtenFiles} file(s).`);
    }
}
