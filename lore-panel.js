/**
 * lore-panel.js - Wandlight Continuity
 * Floating roleplay control window.
 *
 * The extension-menu settings panel is reserved for API setup, data/debug, and
 * raw previews. This window is the runtime surface used during roleplay.
 */

import { getPanelLoreState, getInjectableLoreEntries, normalizeLoreMatrix, normalizeLoreEntry, normalizeLoreTag, LORE_LIFECYCLE_STATUSES } from './lore-matrix.js';
import { getDefaultState, DEFAULT_SETTINGS } from './constants.js';
import {
    getState,
    getSettings,
    saveSettings,
    saveState,
    applyDelta,
    pushStateSnapshot,
    acceptPendingLoreEntries,
    rejectPendingLoreEntries,
    acceptPendingLoreEntry,
    rejectPendingLoreEntry,
    undoLastChange,
    setLoreContext,
} from './state-manager.js';
import { buildMemo, buildMemoPreview, buildContinuityPreview, buildLorePreview, getMemoSignature } from './memo-builder.js';
import { onExtractionTriggered } from './extractor.js';
import { runLoreContextDetection, runLoreGeneration } from './lore-generator.js';
import { sendLoreRequest, validateLoreProviderConfiguration } from './lore-llm-client.js';
import { proposeCanonLoreForContext, getLoreTaxonomySync } from './canon-lore-db.js';

const PANEL_ID = 'wandlight-lore-panel';
const MIN_PANEL_WIDTH = 420;
const MIN_PANEL_HEIGHT = 360;
const MAX_PANEL_MARGIN = 16;

const CATEGORY_LABELS = {
    all: 'All',
    active: 'Context Active',
    pinned: 'Pinned',
    suppressed: 'Muted',
    pending: 'Pending',
    expired: 'Expired',
    blocked: 'Story Blocked',
    future: 'Future',
    canon_overdue: 'Canon Overdue',
    divergent: 'Divergent',
    canon: 'Canon',
    au: 'AU',
    secret: 'Secret',
    rumor: 'Rumor',
    lie: 'Lie',
    relationship: 'Relationship',
    location: 'Location',
    rule: 'Rule',
    timeline: 'Timeline',
    character: 'Character',
    event: 'Event',
    item: 'Item',
    knowledge: 'Knowledge',
    place: 'Place',
    faction: 'Faction',
    spell: 'Spell',
    artifact: 'Artifact',
};

const TAB_LABELS = {
    session: 'Session',
    context: 'Context',
    continuity: 'Continuity',
    lore: 'Lore',
    injection: 'Injection',
};

const TAB_TOOLTIPS = {
    session: 'Runtime overview, instructions, undo history, and destructive cleanup actions.',
    continuity: 'Scan, automatically track, view, and edit structured continuity state: scene, characters, emotions, inventory, knowledge, relationships, and flags.',
    context: 'Detect, automatically update, view, and edit story context: scene date, canon reference point, branch, and source range.',
    lore: 'Generate pending lore, review generated entries, and manage accepted lore with search, filters, tags, pinning, and muting.',
    injection: 'Choose what Wandlight sends to the model: continuity state, lore entries, direct/compressed handling, and live split injection previews.',
};



function getSelectedLoreInjectionCount(state, settings = getSettings()) {
    void settings;
    return getInjectableLoreEntries(state, 0).length;
}

function getInjectionCharacterStats(state, settings = getSettings()) {
    const continuityEnabled = settings.injectContinuity !== false && settings.injectMemo !== false;
    const loreEnabled = settings.injectLore !== false;
    const continuityText = continuityEnabled ? buildContinuityPreview(state, settings.continuityInjectionMode || 'direct') : '';
    const loreText = loreEnabled ? buildLorePreview(state, settings.loreInjectionMode || 'direct') : '';
    return {
        continuityChars: continuityText.length,
        loreChars: loreText.length,
        totalChars: continuityText.length + loreText.length,
        totalTokens: estimateTokens(`${continuityText}
${loreText}`),
    };
}

const LORE_PRIORITY_VALUES = [10, 25, 50, 75, 90, 100];
const LORE_SCOPE_DISPLAY_ORDER = [
    { key: 'characters', label: 'Characters', weight: 80 },
    { key: 'locations', label: 'Locations', weight: 64 },
    { key: 'factions', label: 'Factions', weight: 56 },
    { key: 'objects', label: 'Objects', weight: 48 },
    { key: 'spells', label: 'Spells', weight: 48 },
    { key: 'topics', label: 'Topics', weight: 32 },
    { key: 'eras', label: 'Eras', weight: 24 },
    { key: 'schoolYears', label: 'School years', weight: 24 },
    { key: 'books', label: 'Books', weight: 16 },
];

let activeLoreGenerationController = null;

const ACCEPTED_LORE_INITIAL_VISIBLE_LIMIT = 40;
const ACCEPTED_LORE_PAGE_INCREMENT = 40;
const SEARCH_RENDER_DEBOUNCE_MS = 160;
const MINOR_STATE_SAVE_DEBOUNCE_MS = 350;

let searchRenderTimer = null;
let deferredStateSaveTimer = null;
let deferredStateSaveRef = null;
let loreGenerationUiRunning = false;

function getLoreRegistry(registryName) {
    const taxonomy = getLoreTaxonomySync();
    return taxonomy?.[registryName] || {};
}

function getLoreRegistryValues(registryName, fallback = []) {
    const registry = getLoreRegistry(registryName);
    const values = Object.keys(registry);
    return values.length ? values : fallback;
}

function getLoreFieldRegistry(field) {
    if (field === 'category') return 'categories';
    if (field === 'canonStatus') return 'canonStatuses';
    if (field === 'truthStatus') return 'truthStatuses';
    if (field === 'revealPolicy') return 'revealPolicies';
    return '';
}

function getLoreRegistryMeta(registryName, value) {
    const registry = getLoreRegistry(registryName);
    return registry?.[value] || null;
}


function isSectionCollapsed(sectionId, defaultOpen = true) {
    const settings = getSettings();
    const collapsed = settings.collapsedSections || {};
    if (Object.prototype.hasOwnProperty.call(collapsed, sectionId)) {
        return !!collapsed[sectionId];
    }
    return !defaultOpen;
}

function setSectionCollapsed(sectionId, collapsed) {
    const next = getSettings();
    next.collapsedSections = {
        ...(DEFAULT_SETTINGS.collapsedSections || {}),
        ...(next.collapsedSections || {}),
        [sectionId]: !!collapsed,
    };
    saveSettings(next);
}

function createCollapsibleSection(sectionId, titleText, subtitleText, defaultOpen, content, options = {}) {
    const details = document.createElement('details');
    details.className = `wandlight-runtime-card wandlight-collapsible-card ${options.className || ''}`.trim();
    details.open = !isSectionCollapsed(sectionId, defaultOpen);

    const summary = document.createElement('summary');
    summary.className = 'wandlight-collapsible-summary';
    const title = document.createElement('span');
    title.className = 'wandlight-collapsible-title';
    title.textContent = titleText;
    addTooltip(title, options.tooltip || subtitleText || titleText);
    summary.appendChild(title);

    if (subtitleText) {
        const subtitle = document.createElement('span');
        subtitle.className = 'wandlight-collapsible-subtitle';
        subtitle.textContent = subtitleText;
        summary.appendChild(subtitle);
    }
    details.appendChild(summary);

    const wrap = document.createElement('div');
    wrap.className = 'wandlight-collapsible-content';
    const built = typeof content === 'function' ? content() : content;
    if (Array.isArray(built)) {
        for (const item of built) if (item) wrap.appendChild(item);
    } else if (built) {
        wrap.appendChild(built);
    }
    details.appendChild(wrap);

    details.addEventListener('toggle', () => {
        setSectionCollapsed(sectionId, !details.open);
    });

    return details;
}

function getCountLabel(value, label) {
    const count = Array.isArray(value) ? value.length : (value && typeof value === 'object' ? Object.keys(value).length : 0);
    return `${count} ${label}${count === 1 ? '' : 's'}`;
}

function getLoreDisplayLabel(field, value) {
    if (field === 'priority') return `P${value}`;
    const registryName = getLoreFieldRegistry(field);
    const meta = registryName ? getLoreRegistryMeta(registryName, value) : null;
    return meta?.label || CATEGORY_LABELS[value] || String(value || '');
}

function applyLoreRegistryStyle(el, field, value) {
    const registryName = getLoreFieldRegistry(field);
    const meta = registryName ? getLoreRegistryMeta(registryName, value) : null;
    if (!meta) return el;
    if (meta.color) el.style.background = meta.color;
    if (meta.textColor) el.style.color = meta.textColor;
    if (meta.color) el.style.borderColor = meta.color;
    return el;
}

const WORKFLOW_MODES = {
    manual: {
        label: 'Manual',
        description: 'No automatic extraction or lore generation. Use the buttons in this window when you want Wandlight to scan or generate.',
        settings: {
            autoExtract: false,
            autoApplyDelta: false,
            autoGenerateLore: false,
            continuityTrackingMode: 'manual',
            contextDetectionMode: 'manual',
            loreGenerationMode: 'manual',
        },
    },
    assisted: {
        label: 'Assisted',
        description: 'Automatically scans continuity state after turns. Story context and lore generation stay manual.',
        settings: {
            autoExtract: true,
            autoApplyDelta: true,
            autoGenerateLore: false,
            continuityTrackingMode: 'automatic',
            contextDetectionMode: 'manual',
            loreGenerationMode: 'manual',
        },
    },
    automatic: {
        label: 'Automatic',
        description: 'Automatically scans continuity, detects story context, and generates pending lore on their configured intervals. Generated lore still goes to Pending Lore Review in the Lore tab.',
        settings: {
            autoExtract: true,
            autoApplyDelta: true,
            autoGenerateLore: true,
            continuityTrackingMode: 'automatic',
            contextDetectionMode: 'automatic',
            loreGenerationMode: 'automatic',
        },
    },
};

let panelRoot = null;
let isDragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;

let isResizing = false;
let resizeStartX = 0;
let resizeStartY = 0;
let resizeStartWidth = 0;
let resizeStartHeight = 0;

let floatingTooltip = null;
let tooltipAnchor = null;

// Public lifecycle ------------------------------------------------------------

export function showLorePanel() {
    const state = getState();
    if (state?.lorePanel) {
        state.lorePanel.isOpen = true;
        saveState(state);
    }

    removeLorePanel();

    const freshState = getState();
    const panelState = freshState?.lorePanel || { isOpen: true, collapsed: false };

    panelRoot = document.createElement('div');
    panelRoot.id = PANEL_ID;
    panelRoot.className = 'wandlight-lore-panel';

    const savedWidth = Math.max(MIN_PANEL_WIDTH, Number(panelState.width) || 520);
    const savedHeight = Math.max(MIN_PANEL_HEIGHT, Number(panelState.height) || 640);
    panelRoot.style.width = `${Math.min(savedWidth, Math.max(MIN_PANEL_WIDTH, window.innerWidth - MAX_PANEL_MARGIN))}px`;
    panelRoot.style.height = `${Math.min(savedHeight, Math.max(MIN_PANEL_HEIGHT, window.innerHeight - MAX_PANEL_MARGIN))}px`;

    if (panelState.collapsed) {
        panelRoot.classList.add('wandlight-lore-panel-collapsed');
    }

    renderPanelShell(panelRoot, freshState);
    document.body.appendChild(panelRoot);

    if (panelState.x != null && panelState.y != null) {
        requestAnimationFrame(() => {
            if (!panelRoot) return;
            panelRoot.style.left = `${Math.max(0, Math.min(panelState.x, window.innerWidth - panelRoot.offsetWidth))}px`;
            panelRoot.style.top = `${Math.max(0, Math.min(panelState.y, window.innerHeight - panelRoot.offsetHeight))}px`;
        });
    } else {
        panelRoot.style.right = '16px';
        panelRoot.style.bottom = '16px';
    }
}

export function hideLorePanel() {
    removeLorePanel();
    const state = getState();
    if (state?.lorePanel) {
        state.lorePanel.isOpen = false;
        saveState(state);
    }
}

export function refreshLorePanel() {
    const existing = document.getElementById(PANEL_ID);
    if (!existing) return;

    const state = getState();
    if (!state?.lorePanel?.isOpen) {
        removeLorePanel();
        return;
    }

    refreshPanelBody({ preserveScroll: true });
    refreshHeader();
}

function removeLorePanel() {
    if (panelRoot) {
        panelRoot.remove();
        panelRoot = null;
    }
    const existing = document.getElementById(PANEL_ID);
    if (existing) existing.remove();
}

// Shell -----------------------------------------------------------------------

function renderPanelShell(root, state) {
    root.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'wandlight-lore-panel-header';
    header.addEventListener('mousedown', onDragStart);

    const collapseBtn = createIconButton(
        state?.lorePanel?.collapsed ? '>' : 'v',
        state?.lorePanel?.collapsed ? 'Expand Wandlight Continuity window.' : 'Collapse Wandlight Continuity window.',
        'wandlight-lore-panel-collapse-btn',
        (e) => {
            e.stopPropagation();
            toggleCollapse();
        }
    );
    header.appendChild(collapseBtn);

    const titleWrap = document.createElement('div');
    titleWrap.className = 'wandlight-lore-panel-title-wrap';

    const title = document.createElement('div');
    title.className = 'wandlight-lore-panel-title';
    title.textContent = 'Wandlight Continuity';
    addTooltip(title, 'Roleplay control window for continuity scanning, generation, review, and lore management.');
    titleWrap.appendChild(title);

    const status = document.createElement('div');
    status.className = 'wandlight-lore-panel-status';
    titleWrap.appendChild(status);
    header.appendChild(titleWrap);

    const closeBtn = createIconButton('x', 'Close the Wandlight Continuity window. Use /wandlight-lore-panel or the extensions-menu launcher to reopen it.', 'wandlight-lore-panel-close-btn', (e) => {
        e.stopPropagation();
        hideLorePanel();
    });
    header.appendChild(closeBtn);

    root.appendChild(header);

    const body = document.createElement('div');
    body.className = 'wandlight-lore-panel-body';
    root.appendChild(body);

    if (!state?.lorePanel?.collapsed) {
        renderPanelBody(body, state);
    }

    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'wandlight-lore-panel-resize-handle';
    resizeHandle.addEventListener('pointerdown', onResizeStart);
    addTooltip(resizeHandle, 'Drag from this corner to resize the Wandlight Continuity window.');
    root.appendChild(resizeHandle);

    refreshHeader();
}

function refreshHeader() {
    if (!panelRoot) return;
    const status = panelRoot.querySelector('.wandlight-lore-panel-status');
    if (!status) return;

    const state = getState();
    const settings = getSettings();
    const pendingLore = (state?.pendingLoreEntries || []).length;
    const pendingDelta = state?.lastDelta ? 1 : 0;
    const counts = getPanelLoreState(state).counts;
    const selectedLore = getSelectedLoreInjectionCount(state, settings);

    status.innerHTML = '';
    status.appendChild(createStatusPill(`Mode: ${getWorkflowLabel(settings)}`, getWorkflowTooltip(settings)));
    status.appendChild(createStatusPill(settings.enabled ? 'Wandlight Active' : 'Wandlight Paused', 'Master runtime toggle. When paused, Wandlight does not inject, scan, or generate.'));
    status.appendChild(createStatusPill((settings.injectContinuity !== false && settings.injectMemo !== false) ? 'Continuity Injected' : 'Continuity Not Injected', 'Whether Wandlight includes structured continuity state in roleplay generation prompts.'));
    if (pendingDelta + pendingLore > 0) {
        status.appendChild(createStatusPill(`Pending: ${pendingDelta + pendingLore}`, 'Pending items: generated lore entries in the Lore tab, plus any legacy continuity delta shown in the Continuity tab.'));
    }
    status.appendChild(createStatusPill(`Lore Selected: ${selectedLore}`, 'Accepted lore entries selected for the next injection after context activation, priority, pinning, and muting. There is no hidden entry cap; mute entries to exclude them.'));
}

function renderPanelBody(container, state) {
    container.innerHTML = '';

    const tabs = document.createElement('div');
    tabs.className = 'wandlight-runtime-tabs';

    const activeTab = normalizeTab(state?.lorePanel?.activeTab);
    for (const [tabId, label] of Object.entries(TAB_LABELS)) {
        const tab = document.createElement('button');
        tab.className = 'wandlight-runtime-tab';
        if (tabId === activeTab) tab.classList.add('wandlight-runtime-tab-active');
        tab.type = 'button';
        tab.textContent = label;
        addTooltip(tab, TAB_TOOLTIPS[tabId]);
        tab.addEventListener('click', () => {
            setPanelState({ activeTab: tabId });
            refreshPanelBody({ preserveScroll: false });
        });
        tabs.appendChild(tab);
    }
    container.appendChild(tabs);

    const tabBody = document.createElement('div');
    tabBody.className = `wandlight-runtime-tab-body wandlight-runtime-tab-body-${activeTab}`;
    container.appendChild(tabBody);

    if (activeTab === 'session') {
        renderSessionTab(tabBody, state);
    } else if (activeTab === 'context') {
        renderContextTab(tabBody, state);
    } else if (activeTab === 'continuity') {
        renderContinuityTab(tabBody, state);
    } else if (activeTab === 'lore') {
        renderLoreTab(tabBody, state);
    } else {
        renderInjectionTab(tabBody, state);
    }
}

// Session tab -----------------------------------------------------------------

function renderSessionTab(container, state) {
    const settings = getSettings();

    container.appendChild(createSectionHeader(
        'Session Controls',
        'Set how Wandlight behaves during roleplay. These controls are intentionally kept out of the extension settings panel.'
    ));

    const modeCard = document.createElement('div');
    modeCard.className = 'wandlight-runtime-card';

    const modeTitle = document.createElement('div');
    modeTitle.className = 'wandlight-runtime-card-title';
    modeTitle.textContent = 'Workflow Mode';
    addTooltip(modeTitle, 'Mode is a real behavior preset. Changing it updates automatic extraction, automatic apply, and automatic lore generation settings.');
    modeCard.appendChild(modeTitle);

    const modeButtons = document.createElement('div');
    modeButtons.className = 'wandlight-mode-buttons';
    for (const [mode, cfg] of Object.entries(WORKFLOW_MODES)) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wandlight-mode-button';
        if (normalizeWorkflowMode(settings.workflowMode) === mode) btn.classList.add('wandlight-mode-button-active');
        btn.textContent = cfg.label;
        addTooltip(btn, cfg.description);
        btn.addEventListener('click', () => {
            setWorkflowMode(mode);
            refreshPanelBody({ preserveScroll: false });
            refreshHeader();
            toast(`Workflow mode set to ${cfg.label}`);
        });
        modeButtons.appendChild(btn);
    }
    modeCard.appendChild(modeButtons);

    const modeDesc = document.createElement('div');
    modeDesc.className = 'wandlight-runtime-help';
    modeDesc.textContent = WORKFLOW_MODES[normalizeWorkflowMode(settings.workflowMode)].description;
    modeCard.appendChild(modeDesc);

    container.appendChild(modeCard);

    const toggles = document.createElement('div');
    toggles.className = 'wandlight-runtime-grid';
    toggles.appendChild(createToggleCard(
        'Wandlight Active',
        settings.enabled,
        'Master switch for Wandlight runtime behavior. Pausing disables prompt injection, automatic extraction, and generation actions.',
        (checked) => {
            const next = getSettings();
            next.enabled = checked;
            saveSettings(next);
            refreshPanelBody({ preserveScroll: false });
            refreshHeader();
        }
    ));
    container.appendChild(toggles);

    container.appendChild(createCollapsibleSection('session.instructions', 'Instructions', 'workflow guide', false, createInstructionsCard(), { tooltip: 'Minimal workflow reference for using Wandlight during roleplay.' }));

    const stats = document.createElement('div');
    stats.className = 'wandlight-runtime-card';
    const counts = getPanelLoreState(state).counts;
    const selectedLoreCount = getSelectedLoreInjectionCount(state, settings);
    const injectionStats = getInjectionCharacterStats(state, settings);
    stats.appendChild(createKeyValue('Pending continuity changes', state?.lastDelta ? '1' : '0', 'Legacy extracted state delta waiting in the Continuity tab. New scans apply directly to Continuity sections.'));
    stats.appendChild(createKeyValue('Pending lore entries', String((state?.pendingLoreEntries || []).length), 'Generated lore entries waiting in the Lore tab Pending Lore Review section.'));
    stats.appendChild(createKeyValue('Accepted lore entries', String(counts.all - counts.pending), 'Lore entries currently stored in the accepted lore matrix.'));
    stats.appendChild(createKeyValue('Context-active lore entries', String(counts.active), 'Accepted lore entries whose date, branch, character, location, or scope rules match the current Continuity/Context state. This can be 0 even when fallback priority-based lore is still selected for injection.'));
    stats.appendChild(createKeyValue('Lore selected for injection', String(selectedLoreCount), 'Accepted lore entries that Wandlight is currently selecting for Lore Injection after pin/mute rules, context activation, and fallback priority selection. There is no hidden entry cap; mute entries to exclude them.'));
    stats.appendChild(createKeyValue('Injection token estimate', injectionStats.totalChars ? `${injectionStats.totalTokens} tokens` : 'empty', 'Approximate token count for the combined Continuity + Lore injection previews.'));
    stats.appendChild(createKeyValue('Total chars injected', `${injectionStats.totalChars} chars`, 'Combined character count of Continuity Injection plus Lore Injection using current Injection tab toggles and handling modes.'));
    container.appendChild(stats);

    container.appendChild(createCollapsibleSection('session.stateHistory', 'State History', getCountLabel(state?.stateHistory || [], 'undo point'), false, createStateHistoryCard(state), { tooltip: 'Undo history for Wandlight state.' }));
    container.appendChild(createCollapsibleSection('session.dangerZone', 'Danger Zone', 'Destructive cleanup actions', false, createDangerZoneCard(state), { tooltip: 'Destructive cleanup actions for this chat.', className: 'wandlight-danger-zone-collapsible' }));
}

function createInstructionsCard() {
    const wrap = document.createElement('div');
    wrap.className = 'wandlight-instructions-card';

    const intro = document.createElement('p');
    intro.className = 'wandlight-instructions-lede';
    intro.textContent = 'Wandlight is a working memory layer for the story. Use it to anchor date, state, lore, and injection without turning the chat itself into a recap.';
    wrap.appendChild(intro);

    const flow = document.createElement('div');
    flow.className = 'wandlight-instructions-flow';

    const cards = [
        {
            title: 'Context',
            body: 'Set the scene date, canon reference point, and branch. Canon suggestions depend on this anchor.',
        },
        {
            title: 'Continuity',
            body: 'Scan the live story state: scene, characters, knowledge, secrets, relationships, objectives, and milestones.',
        },
        {
            title: 'Lore',
            body: 'Suggest canon lore from the local database or generate story lore from chat. Review before accepting.',
        },
        {
            title: 'Injection',
            body: 'Choose what is sent to the model. Inject Continuity, Lore, or both, directly or compressed.',
        },
    ];

    for (const item of cards) {
        const card = document.createElement('div');
        card.className = 'wandlight-instructions-step-card';
        const title = document.createElement('div');
        title.className = 'wandlight-instructions-step-title';
        title.textContent = item.title;
        const body = document.createElement('div');
        body.className = 'wandlight-instructions-step-body';
        body.textContent = item.body;
        card.appendChild(title);
        card.appendChild(body);
        flow.appendChild(card);
    }

    wrap.appendChild(flow);

    const close = document.createElement('p');
    close.className = 'wandlight-instructions-note';
    close.textContent = 'The chat remains the source of truth. Wandlight keeps the relevant state visible, editable, and ready for injection.';
    wrap.appendChild(close);

    return wrap;
}

function createStateHistoryCard(state) {
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card';

    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = 'State History';
    addTooltip(title, 'Previously called snapshots. This is the undo history for Wandlight continuity state, not a branching timeline.');
    card.appendChild(title);

    const historyCount = Array.isArray(state?.stateHistory) ? state.stateHistory.length : 0;
    const latest = historyCount ? state.stateHistory[historyCount - 1] : null;
    card.appendChild(createKeyValue('Undo points', String(historyCount), 'Number of saved state-history points currently available.'));
    card.appendChild(createKeyValue('Latest undo point', latest ? (latest.summary || 'Unnamed change') : 'none', 'Most recent state-history entry.'));

    const settings = getSettings();
    const limitRow = document.createElement('label');
    limitRow.className = 'wandlight-slider-row wandlight-compact-slider-row';
    const limitText = document.createElement('span');
    limitText.textContent = `History limit: ${settings.maxSnapshots || 20}`;
    addTooltip(limitText, 'Maximum number of undo points Wandlight keeps for this chat. Higher values use more chat metadata storage.');
    const limitInput = document.createElement('input');
    limitInput.type = 'range';
    limitInput.min = '5';
    limitInput.max = '100';
    limitInput.step = '1';
    limitInput.value = String(settings.maxSnapshots || 20);
    limitInput.addEventListener('input', () => {
        const next = getSettings();
        next.maxSnapshots = Math.max(5, Math.min(100, parseInt(limitInput.value, 10) || 20));
        saveSettings(next);
        limitText.textContent = `History limit: ${next.maxSnapshots}`;
    });
    limitRow.appendChild(limitText);
    limitRow.appendChild(limitInput);
    card.appendChild(limitRow);

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions';
    actions.appendChild(createButton('Undo Last Change', 'Restores the most recent state-history point. This is a destructive one-step undo, not forward/back timeline travel.', async () => {
        const proceed = await confirmAction('Undo last Wandlight change?', 'This restores the most recent state-history point and removes that undo point from history. Continue?');
        if (!proceed) return;
        const result = undoLastChange(getState());
        saveState(result.state);
        resetAllFeatureProgressNow();
        refreshPanelBody({ preserveScroll: false });
        refreshHeader();
        toast(result.undone ? 'Last Wandlight change undone.' : 'No state-history point is available.', result.undone ? 'success' : 'warning');
    }));
    actions.appendChild(createButton('Clear History', 'Deletes the undo history only. Current lore and continuity state are not changed.', async () => {
        const proceed = await confirmAction('Clear Wandlight state history?', 'This deletes undo history but does not delete current lore or continuity state. Continue?');
        if (!proceed) return;
        const current = getState();
        current.stateHistory = [];
        saveState(current);
        refreshPanelBody({ preserveScroll: false });
        toast('State history cleared.', 'info');
    }));
    card.appendChild(actions);

    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help';
    help.textContent = 'True back/forward timeline navigation would require a new non-destructive history cursor. This panel exposes the current implemented undo system accurately.';
    card.appendChild(help);

    return card;
}

function createDangerZoneCard(state) {
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card wandlight-danger-zone-card';

    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title wandlight-danger-zone-title';
    title.textContent = 'Danger Zone';
    addTooltip(title, 'Destructive cleanup actions for the current chat. Delete All Lore and Reset Generation are undoable through State History. Total Reset clears State History and is not undoable.');
    card.appendChild(title);

    card.appendChild(createKeyValue('Accepted lore', String((state?.loreMatrix || []).length), 'Lore entries currently stored in the accepted lore matrix.'));
    card.appendChild(createKeyValue('Pending lore', String((state?.pendingLoreEntries || []).length), 'Generated lore entries waiting in the Lore tab Pending Lore Review section.'));
    card.appendChild(createKeyValue('Pending continuity changes', state?.lastDelta ? '1' : '0', 'Legacy extracted continuity delta waiting in the Continuity tab.'));

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions';

    actions.appendChild(createButton('Delete All Lore', 'Deletes accepted lore, pending lore, and pin/mute selections. Canon/scene/relationship continuity state is left intact.', async () => {
        const proceed = await confirmAction('Are you sure? Delete all Wandlight lore?', 'You are about to delete every accepted lore entry, every pending lore entry, and all pin/mute selections for this chat. Scene, character knowledge, secrets, relationships, threads, and other continuity state will remain. A state-history snapshot will be saved first. This cannot be reversed except by Undo Last Change. Continue?');
        if (!proceed) return;
        const current = getState();
        pushStateSnapshot(current, 'Delete all lore', getSettings().maxSnapshots);
        current.loreMatrix = [];
        current.pendingLoreEntries = [];
        current.pendingLoreMeta = null;
        current.loreSelection = { pinnedIds: [], suppressedIds: [] };
        if (current.lorePanel) {
            current.lorePanel.selectedEntryId = '';
            current.lorePanel.reviewSelectedIds = [];
        }
        saveState(current);
        refreshPanelBody({ preserveScroll: false });
        refreshHeader();
        toast('All lore entries deleted.', 'info');
    }, 'wandlight-danger-button'));

    actions.appendChild(createButton('Reset Generation State', 'Clears detected lore context, pending generated lore, pending deltas, and generation ledger. Accepted lore remains intact.', async () => {
        const proceed = await confirmAction('Are you sure? Reset generation state?', 'You are about to clear detected context, pending generated lore, pending continuity changes, and the lore-generation ledger. Accepted lore entries will remain. A state-history snapshot will be saved first. Continue?');
        if (!proceed) return;
        const current = getState();
        const defaults = getDefaultState();
        pushStateSnapshot(current, 'Reset generation state', getSettings().maxSnapshots);
        current.loreContext = defaults.loreContext;
        current.pendingLoreEntries = [];
        current.pendingLoreMeta = null;
        current.loreGeneration = defaults.loreGeneration;
        current.lastDelta = null;
        if (current.lorePanel) current.lorePanel.reviewSelectedIds = [];
        saveState(current);
        refreshPanelBody({ preserveScroll: false });
        refreshHeader();
        toast('Generation state reset.', 'info');
    }, 'wandlight-danger-button'));

    actions.appendChild(createButton('Total Reset', 'Resets Wandlight continuity state for this chat to defaults and clears State History. Panel size and position are preserved.', async () => {
        const proceed = await confirmAction('Are you sure? Total reset?', 'You are about to reset all Wandlight continuity data for this chat: canon/scene state, knowledge, secrets, relationships, threads, flags, accepted lore, pending lore, generation state, and State History. Window position and size are preserved. Because State History will also be cleared, this action cannot be undone. Continue?');
        if (!proceed) return;
        const current = getState();
        const defaults = getDefaultState();
        defaults.stateHistory = [];
        defaults.memoHistory = [];
        if (current.lorePanel) {
            defaults.lorePanel = {
                ...defaults.lorePanel,
                isOpen: true,
                x: current.lorePanel.x,
                y: current.lorePanel.y,
                width: current.lorePanel.width,
                height: current.lorePanel.height,
                activeTab: 'session',
            };
        }
        saveState(defaults);
        refreshPanelBody({ preserveScroll: false });
        refreshHeader();
        toast('Wandlight state reset. State History cleared.', 'info');
    }, 'wandlight-danger-button'));

    card.appendChild(actions);
    return card;
}

function ensureProviderReadyForAction(kind = 'lore', actionLabel = 'this action', statusKind = kind) {
    const validation = validateLoreProviderConfiguration(kind);
    if (validation.ok) return true;

    const message = `API/model settings incomplete for ${actionLabel}: ${validation.message}`;
    setFeatureProgress(statusKind, message, 100);
    toast(message, 'error');
    return false;
}

function ensureLoreProviderReadyForAction(actionLabel = 'this action', statusKind = 'lore') {
    return ensureProviderReadyForAction('lore', actionLabel, statusKind);
}

function ensureContinuityProviderReadyForAction(actionLabel = 'this action') {
    return ensureProviderReadyForAction('continuity', actionLabel, 'continuity');
}


// Context tab -----------------------------------------------------------------

function renderContextTab(container, state) {
    container.appendChild(createSectionHeader(
        'Story Context',
        'Detect and edit the date, canon reference point, and branch used by lore generation. Actions are colocated with the fields they update.'
    ));

    container.appendChild(createContextDetectionCard(state));
    container.appendChild(createContextEditorCard(state));
}

function createContextDetectionCard(state) {
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card wandlight-generation-progress-card';

    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = 'Context Detection';
    addTooltip(title, 'Detects story context from recent chat and fills the Story Context fields below. It does not create lore entries.');
    card.appendChild(title);

    card.appendChild(createAutomationModeCard(
        'Story Context Detection',
        'contextDetectionMode',
        'contextDetectionAutoInterval',
        'Only runs when you click Detect Story Context.',
        'Runs automatically after roleplay turns on this interval, using the Lore provider.',
        'Automatic story-context detection interval in completed model turns.'
    ));

    const settings = getSettings();
    const sourceRow = document.createElement('label');
    sourceRow.className = 'wandlight-slider-row wandlight-compact-slider-row';
    const sourceText = document.createElement('span');
    sourceText.textContent = `Context source messages: ${settings.contextSourceMessageCount || 20}`;
    addTooltip(sourceText, 'How many recent chat messages are sent to story-context detection. This is separate from the Lore generation source window.');
    const sourceInput = document.createElement('input');
    sourceInput.type = 'range';
    sourceInput.min = '4';
    sourceInput.max = '200';
    sourceInput.step = '1';
    sourceInput.value = String(settings.contextSourceMessageCount || 20);
    sourceInput.addEventListener('input', () => {
        const next = getSettings();
        next.contextSourceMessageCount = Math.max(4, Math.min(200, parseInt(sourceInput.value, 10) || 20));
        saveSettings(next);
        sourceText.textContent = `Context source messages: ${next.contextSourceMessageCount}`;
    });
    sourceRow.appendChild(sourceText);
    sourceRow.appendChild(sourceInput);
    card.appendChild(sourceRow);

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions wandlight-generation-actions';
    actions.appendChild(createButton('Detect Story Context', 'Analyzes recent messages and fills the Story Context fields below. It does not create lore entries.', async (btn) => {
        await handleDetectStoryContext(btn);
    }, 'wandlight-primary-button'));
    card.appendChild(actions);

    appendGenerationStatus(card, state, 'context');
    return card;
}

function createLoreGenerationCard(state) {
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card wandlight-generation-progress-card wandlight-lore-generation-card';

    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = 'Lore Generation';
    addTooltip(title, 'Create reviewable lore entries either from the local canon database or from model analysis of recent story messages.');
    card.appendChild(title);

    card.appendChild(createLoreContextStatusCard(state));

    const actionsGrid = document.createElement('div');
    actionsGrid.className = 'wandlight-lore-generation-grid';
    actionsGrid.appendChild(createCanonSuggestionPanel(state));
    actionsGrid.appendChild(createStoryLoreGenerationPanel(state));
    card.appendChild(actionsGrid);

    return card;
}

function createLoreContextStatusCard(state) {
    const context = state?.loreContext || {};
    const card = document.createElement('div');
    card.className = 'wandlight-lore-context-status';

    const label = document.createElement('div');
    label.className = 'wandlight-lore-context-status-label';
    label.textContent = 'Story Context';
    addTooltip(label, 'Canon suggestions use Story Context to know the current date, canon boundary, and branch. Detect or edit this in the Context tab.');
    card.appendChild(label);

    const value = document.createElement('div');
    value.className = 'wandlight-lore-context-status-value';
    if (hasUsableStoryContext(context)) {
        const parts = [context.sceneDate, context.canonBoundary, context.branchId ? `Branch: ${context.branchId}` : '']
            .map(part => String(part || '').trim())
            .filter(Boolean);
        value.textContent = parts.join(' · ') || 'Story Context detected';
    } else {
        value.textContent = 'No Story Context';
        value.classList.add('wandlight-warning-text');
    }
    card.appendChild(value);

    const action = createButton('Refresh Context', 'Runs Detect Story Context, then returns here. Useful before suggesting canon lore.', async (btn) => {
        await handleDetectStoryContext(btn, { stayOnTab: 'lore' });
    }, 'wandlight-secondary-button wandlight-compact-action-button');
    card.appendChild(action);

    return card;
}

function createCanonSuggestionPanel(state) {
    const settings = getSettings();
    const db = state?.canonLoreDatabase || {};
    const panel = document.createElement('div');
    panel.className = 'wandlight-lore-generation-panel wandlight-canon-suggestion-panel';

    const header = document.createElement('div');
    header.className = 'wandlight-lore-generation-panel-title';
    header.textContent = 'Suggest Canon Lore';
    addTooltip(header, 'Uses the local Lore Database and current Story Context to propose date-aware canon constraints. No model call.');
    panel.appendChild(header);

    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help';
    help.textContent = 'Local database lookup. No API/model cost. Requires Story Context so Wandlight knows the date, canon boundary, and branch.';
    panel.appendChild(help);

    const maxRow = document.createElement('label');
    maxRow.className = 'wandlight-slider-row wandlight-compact-slider-row';
    const maxText = document.createElement('span');
    maxText.textContent = `Max suggestions: ${settings.canonLoreMaxEntries || 10}`;
    addTooltip(maxText, 'Maximum local canon database entries proposed into Pending Lore Review. This does not accept them automatically.');
    const maxInput = document.createElement('input');
    maxInput.type = 'range';
    maxInput.min = '1';
    maxInput.max = '200';
    maxInput.step = '1';
    maxInput.value = String(settings.canonLoreMaxEntries || 10);
    maxInput.addEventListener('input', () => {
        const next = getSettings();
        next.canonLoreMaxEntries = Math.max(1, Math.min(200, parseInt(maxInput.value, 10) || 10));
        saveSettings(next);
        maxText.textContent = `Max suggestions: ${next.canonLoreMaxEntries}`;
    });
    maxRow.appendChild(maxText);
    maxRow.appendChild(maxInput);
    panel.appendChild(maxRow);

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions wandlight-generation-actions';
    actions.appendChild(createButton('Suggest Canon Lore', 'Queries the local Lore Database with the current Story Context and proposes matching entries into Pending Lore Review.', async (btn) => {
        await handleSuggestCanonLore(btn);
    }, 'wandlight-primary-button'));
    panel.appendChild(actions);

    const advanced = createCollapsibleSection(
        'lore.canonSuggestionSettings',
        'Canon Suggestion Settings',
        settings.canonLoreDatabaseEnabled === false ? 'disabled' : (settings.canonLoreAutoPropose === false ? 'manual' : 'auto after context'),
        false,
        createCanonSuggestionSettingsContent(state),
        { tooltip: 'Low-frequency local canon database settings.' }
    );
    panel.appendChild(advanced);

    appendGenerationStatus(panel, state, 'canon');
    panel.appendChild(createKeyValue('Last query', db.lastQueriedAt ? new Date(db.lastQueriedAt).toLocaleString() : 'never', 'When the local canon database was last queried.'));
    panel.appendChild(createKeyValue('Last result', db.lastStatus || 'Not queried.', 'Summary of the last local canon lore query.'));

    return panel;
}

function createCanonSuggestionSettingsContent(state) {
    const settings = getSettings();
    const content = document.createElement('div');
    content.className = 'wandlight-canon-suggestion-settings';

    const grid = document.createElement('div');
    grid.className = 'wandlight-runtime-grid';
    grid.appendChild(createToggleCard(
        'Enable Canon Database',
        settings.canonLoreDatabaseEnabled !== false,
        'Allows Wandlight to query local pre-generated canon lore files when Story Context has a parseable date.',
        (checked) => {
            const next = getSettings();
            next.canonLoreDatabaseEnabled = checked;
            saveSettings(next);
            refreshPanelBody({ preserveScroll: true });
        }
    ));
    grid.appendChild(createToggleCard(
        'Auto-suggest after Context detection',
        settings.canonLoreAutoPropose !== false,
        'When enabled, Detect Story Context automatically proposes matching local canon entries into Pending Lore Review.',
        (checked) => {
            const next = getSettings();
            next.canonLoreAutoPropose = checked;
            saveSettings(next);
            refreshPanelBody({ preserveScroll: true });
        }
    ));
    content.appendChild(grid);

    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help';
    help.textContent = 'Canon suggestions are proposed for review, not automatically accepted. Duplicate IDs/titles are skipped cheaply before insertion.';
    content.appendChild(help);
    return content;
}

function createStoryLoreGenerationPanel(state) {
    const panel = document.createElement('div');
    panel.className = 'wandlight-lore-generation-panel wandlight-story-lore-generation-panel';

    const header = document.createElement('div');
    header.className = 'wandlight-lore-generation-panel-title';
    header.textContent = 'Generate Story Lore';
    addTooltip(header, 'Uses the Lore provider to analyze recent chat messages and create story/AU lore entries for Pending Lore Review. This uses model/API tokens.');
    panel.appendChild(header);

    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help';
    help.textContent = 'Model-based generation. Uses the Lore provider, source-message window, and chunk size settings. Output stays pending until accepted.';
    panel.appendChild(help);

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions wandlight-generation-actions';
    const generateBtn = createButton('Generate Story Lore', 'Generates searchable story/AU lore entries in message chunks and places them in Pending Lore Review.', async (btn) => {
        await handleGeneratePendingLore(btn);
    }, 'wandlight-primary-button');
    if (loreGenerationUiRunning || activeLoreGenerationController) {
        generateBtn.disabled = true;
        generateBtn.textContent = 'Generation Running...';
    }
    actions.appendChild(generateBtn);
    const cancelBtn = createButton('Cancel Generation', 'Cancels the current chunked lore generation after the active provider request returns or aborts.', () => {
        if (activeLoreGenerationController) {
            activeLoreGenerationController.abort();
            setFeatureProgress('lore', 'Cancelling story lore generation...', Math.max(1, Number(getState()?.lorePanel?.loreProgress) || 1));
        }
    }, 'wandlight-danger-button');
    cancelBtn.disabled = !activeLoreGenerationController;
    actions.appendChild(cancelBtn);
    panel.appendChild(actions);

    appendGenerationStatus(panel, state, 'lore');

    panel.appendChild(createCollapsibleSection(
        'lore.storyGenerationSettings',
        'Story Lore Settings',
        'automation, source, chunks, tags, guards',
        false,
        createStoryLoreSettingsContent(),
        { tooltip: 'Advanced model-based story lore generation controls.' }
    ));

    return panel;
}

function createStoryLoreSettingsContent() {
    const wrap = document.createElement('div');
    wrap.className = 'wandlight-story-lore-settings-content';
    wrap.appendChild(createAutomationModeCard(
        'Story Lore Generation',
        'loreGenerationMode',
        'loreGenerationAutoInterval',
        'Only runs when you click Generate Story Lore.',
        'Runs automatically after roleplay turns on this interval, using the Lore provider. Generated lore still waits in Pending Lore Review.',
        'Automatic story-lore generation interval in completed model turns.'
    ));
    wrap.appendChild(createGenerationSettingsCard());
    return wrap;
}

function appendGenerationStatus(card, state, kind = 'lore') {
    const statusKey = `${kind}Status`;
    const progressKey = `${kind}Progress`;

    const status = document.createElement('div');
    status.className = 'wandlight-generation-status-text';
    status.dataset.wandlightStatus = kind;
    status.textContent = state?.lorePanel?.[statusKey] || 'Idle.';
    card.appendChild(status);

    const bar = document.createElement('div');
    bar.className = 'wandlight-progress-bar';
    const fill = document.createElement('div');
    fill.className = 'wandlight-progress-fill';
    fill.dataset.wandlightProgress = kind;
    fill.style.width = `${Math.max(0, Math.min(100, Number(state?.lorePanel?.[progressKey]) || 0))}%`;
    bar.appendChild(fill);
    card.appendChild(bar);
}

async function handleDetectStoryContext(btn, options = {}) {
    if (!ensureLoreProviderReadyForAction('Detect Story Context', 'context')) return false;
    if (btn) {
        let result = false;
        await runBusyAction(btn, 'Detecting...', async () => { result = await performStoryContextDetection(options); });
        return result;
    }
    return await performStoryContextDetection(options);
}

async function performStoryContextDetection(options = {}) {
    setFeatureProgress('context', 'Reading chat and detecting story context...', 8);
    const current = getState();
    pushStateSnapshot(current, 'Detect lore context', getSettings().maxSnapshots);
    const detected = await runLoreContextDetection({ progress: (message, percent) => setFeatureProgress('context', message, percent) });
    const after = getState();
    if (options.stayOnTab) setPanelState({ activeTab: options.stayOnTab }, { deferSave: true });
    refreshHeader();
    refreshPanelBody({ preserveScroll: false });

    const fields = after?.loreContext || {};
    const filled = ['sceneDate', 'subjectiveDate', 'canonBoundary', 'branchId', 'timeTravelMode']
        .filter(key => String(fields[key] || '').trim()).length;

    if (detected && filled > 0) {
        setFeatureProgress('context', 'Story context detected and fields updated.', 100);
        resetFeatureProgress('context');
        toast('Story context detected and fields updated.');
        return true;
    }
    if (detected) {
        toast('Story context detection completed, but it did not find date/canon fields to populate.', 'warning');
        return false;
    }
    toast('Story context detection returned no usable result.', 'warning');
    return false;
}

function hasUsableStoryContext(context = {}) {
    return !![
        context.sceneDate,
        context.subjectiveDate,
        context.canonBoundary,
        context.branchId && context.branchId !== 'main' ? context.branchId : '',
    ].map(value => String(value || '').trim()).find(Boolean);
}

async function handleSuggestCanonLore(btn) {
    await runBusyAction(btn, 'Suggesting...', async () => {
        let state = getState();
        if (!hasUsableStoryContext(state?.loreContext || {})) {
            const proceed = await confirmAction(
                'No Story Context detected',
                'Canon lore suggestions need the story date, canon boundary, and branch. Run Detect Story Context now?'
            );
            if (!proceed) {
                setFeatureProgress('canon', 'Canon suggestion cancelled: no Story Context.', 0);
                return;
            }
            setFeatureProgress('canon', 'Detecting Story Context before suggesting canon lore...', 5);
            const detected = await performStoryContextDetection({ stayOnTab: 'lore' });
            if (!detected || !hasUsableStoryContext(getState()?.loreContext || {})) {
                setFeatureProgress('canon', 'No Story Context available. Canon suggestions were not run.', 100);
                toast('Canon suggestions need Story Context before they can run.', 'warning');
                return;
            }
            setFeatureProgress('canon', 'Story Context detected. Continuing to canon suggestion...', 15);
            state = getState();
        }

        setFeatureProgress('canon', 'Suggesting canon lore from local database...', 20);
        const result = await proposeCanonLoreForContext(state?.loreContext || {}, {
            maxEntries: getSettings().canonLoreMaxEntries || 10,
            progress: (message, percent) => setFeatureProgress('canon', message, percent),
        });

        if (result?.status === 'proposed') {
            setSectionCollapsed('lore.pendingReview', false);
            setPanelState({ activeTab: 'lore' }, { deferSave: true });
            refreshPanelBody({ preserveScroll: false });
            refreshHeader();
            setFeatureProgress('canon', `Suggested ${result.proposedCount || 0} canon lore entries.`, 100);
            resetFeatureProgress('canon');
            toast(`Suggested ${result.proposedCount || 0} canon lore entries. Review them in Pending Lore Review.`);
        } else if (result?.status === 'duplicates_only') {
            setFeatureProgress('canon', `Matched ${result.matchedCount || 0}, but all selected suggestions already exist.`, 100);
            resetFeatureProgress('canon');
            refreshHeader();
            toast('Canon database matches were already present by id/title.', 'info');
        } else if (result?.status === 'no_date') {
            setFeatureProgress('canon', 'No parseable Story Context date. Detect or enter a scene date first.', 100);
            toast('Canon suggestions need a parseable Scene date first.', 'warning');
        } else if (result?.status === 'disabled') {
            setFeatureProgress('canon', 'Canon database is disabled.', 100);
            toast('Canon database is disabled.', 'warning');
        } else {
            setFeatureProgress('canon', 'No matching canon suggestions for this context.', 100);
            resetFeatureProgress('canon');
            toast('Canon database found no matching entries for this context.', 'info');
        }
    });
}

async function handleGeneratePendingLore(btn) {
    if (loreGenerationUiRunning || activeLoreGenerationController) {
        toast('Lore generation is already running. Use Cancel Generation to stop it.', 'warning');
        return;
    }
    if (!ensureLoreProviderReadyForAction('Generate Story Lore', 'lore')) return;
    activeLoreGenerationController = new AbortController();
    loreGenerationUiRunning = true;
    refreshPanelBody({ preserveScroll: true });
    await runBusyAction(btn, 'Generating...', async () => {
        const settings = getSettings();
        const current = getState();
        const pendingCount = (current.pendingLoreEntries || []).length;
        let allowReplacePending = true;

        if (pendingCount > 0 && settings.loreReplacementGuard !== false) {
            const proceed = await confirmAction(
                'Replace pending lore?',
                `There are already ${pendingCount} pending lore entries. Generating again will replace that pending batch. Accepted lore entries are not deleted. Continue?`
            );
            if (!proceed) {
                setFeatureProgress('lore', 'Story lore generation cancelled by user.', 0);
                return;
            }
            allowReplacePending = true;
        }

        setFeatureProgress('lore', 'Starting chunked lore generation...', 5);
        const result = await runLoreGeneration({
            force: true,
            allowReplacePending,
            signal: activeLoreGenerationController?.signal,
            progress: (message, percent) => setFeatureProgress('lore', message, percent),
        });
        refreshHeader();

        if (result?.status === 'cancelled') {
            refreshPanelBody({ preserveScroll: true });
            setFeatureProgress('lore', 'Story lore generation cancelled.', 0);
            toast('Story lore generation cancelled.', 'warning');
        } else if (result?.status === 'proposed') {
            setSectionCollapsed('lore.pendingReview', false);
            setPanelState({ activeTab: 'lore' });
            refreshPanelBody({ preserveScroll: false });
            const duplicateText = result.droppedDuplicateCount ? ` ${result.droppedDuplicateCount} duplicate/similar entries were filtered.` : '';
            const chunkText = result.chunkCount ? ` Processed ${result.chunkCount} chunk${result.chunkCount === 1 ? '' : 's'}.` : '';
            setFeatureProgress('lore', `${result.validEntryCount || 0} story lore entries generated.`, 100);
            resetFeatureProgress('lore');
            toast(`${result.validEntryCount || 0} story lore entries generated.${duplicateText}${chunkText} Pending Lore Review opened.`);
        } else {
            refreshPanelBody({ preserveScroll: false });
            const details = formatGenerationStatus(result);
            toast(details, 'warning');
        }
    });
    activeLoreGenerationController = null;
    loreGenerationUiRunning = false;
    refreshPanelBody({ preserveScroll: true });
}

// Legacy Generate tab fallback -------------------------------------------------

function renderGenerateTab(container, state) {
    // Legacy fallback for older saved panel states. The Generate tab was split into Context and Lore.
    renderContextTab(container, state);
}


function createCanonLoreDatabaseCard(state) {
    const settings = getSettings();
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card wandlight-canon-db-card';

    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = 'Local Canon Lore Database';
    addTooltip(title, 'After Story Context detection finds a parseable canon date, Wandlight locally queries files under the extension Lore folder and proposes relevant canon entries into Pending Lore Review. This does not call the model.');
    card.appendChild(title);

    const db = state?.canonLoreDatabase || {};
    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help';
    help.textContent = 'Canon database entries are proposed for review, not automatically accepted. The database is organized under Lore/characters, Lore/events, Lore/items, Lore/knowledge, and Lore/places.';
    card.appendChild(help);

    const grid = document.createElement('div');
    grid.className = 'wandlight-runtime-grid';
    grid.appendChild(createToggleCard(
        'Enable Canon Database',
        settings.canonLoreDatabaseEnabled !== false,
        'Allows Wandlight to query local pre-generated canon lore files when Story Context has a parseable date.',
        (checked) => {
            const next = getSettings();
            next.canonLoreDatabaseEnabled = checked;
            saveSettings(next);
            refreshPanelBody({ preserveScroll: true });
        }
    ));
    grid.appendChild(createToggleCard(
        'Auto-Propose After Detection',
        settings.canonLoreAutoPropose !== false,
        'When enabled, Detect Story Context automatically proposes matching local canon entries into Pending Lore Review.',
        (checked) => {
            const next = getSettings();
            next.canonLoreAutoPropose = checked;
            saveSettings(next);
            refreshPanelBody({ preserveScroll: true });
        }
    ));
    card.appendChild(grid);

    const maxRow = document.createElement('label');
    maxRow.className = 'wandlight-slider-row wandlight-compact-slider-row';
    const maxText = document.createElement('span');
    maxText.textContent = `Max canon proposals: ${settings.canonLoreMaxEntries || 12}`;
    addTooltip(maxText, 'Maximum local canon database entries proposed after context detection or manual database query.');
    const maxInput = document.createElement('input');
    maxInput.type = 'range';
    maxInput.min = '1';
    maxInput.max = '200';
    maxInput.step = '1';
    maxInput.value = String(settings.canonLoreMaxEntries || 12);
    maxInput.addEventListener('input', () => {
        const next = getSettings();
        next.canonLoreMaxEntries = Math.max(1, Math.min(200, parseInt(maxInput.value, 10) || 12));
        saveSettings(next);
        maxText.textContent = `Max canon proposals: ${next.canonLoreMaxEntries}`;
    });
    maxRow.appendChild(maxText);
    maxRow.appendChild(maxInput);
    card.appendChild(maxRow);

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions';
    actions.appendChild(createButton('Query Canon Database', 'Uses the current Story Context fields to query local canon lore and propose matching entries into Pending Lore Review.', async (btn) => {
        await runBusyAction(btn, 'Querying...', async () => {
            setFeatureProgress('context', 'Querying local canon lore database...', 80);
            const result = await proposeCanonLoreForContext(getState()?.loreContext || {}, {
                maxEntries: getSettings().canonLoreMaxEntries || 12,
                progress: (message, percent) => setFeatureProgress('context', message, percent),
            });
            if (result?.status === 'proposed') {
                refreshPanelBody({ preserveScroll: false });
                refreshHeader();
                setFeatureProgress('context', `Canon database proposed ${result.proposedCount || 0} pending lore entries.`, 100);
                resetFeatureProgress('context');
                toast(`Canon database proposed ${result.proposedCount || 0} pending lore entries.`);
            } else if (result?.status === 'duplicates_only') {
                // Do not refresh the whole panel for a no-op duplicate result. In chats that
                // already contain oversized pending canon entries, a full refresh can freeze.
                setFeatureProgress('context', `Canon database matched ${result.matchedCount || 0}, but selected proposals were already present by id/title.`, 100);
                resetFeatureProgress('context');
                refreshHeader();
                toast('Canon database matches were already present by id/title.', 'info');
            } else if (result?.status === 'no_date') {
                toast('Canon database needs a parseable Scene date first.', 'warning');
            } else if (result?.status === 'disabled') {
                toast('Canon database is disabled.', 'warning');
            } else {
                toast('Canon database found no matching entries for this context.', 'info');
            }
        });
    }, 'wandlight-primary-button'));
    card.appendChild(actions);

    card.appendChild(createKeyValue('Last query', db.lastQueriedAt ? new Date(db.lastQueriedAt).toLocaleString() : 'never', 'When the local canon database was last queried.'));
    card.appendChild(createKeyValue('Last result', db.lastStatus || 'Not queried.', 'Summary of the last local canon lore query.'));
    return card;
}

function createContextEditorCard(state) {
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card';

    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = 'Story Context';
    addTooltip(title, 'Date and canon reference data used by lore generation. Detection can infer these, but you can also set them manually when the story has not stated them clearly.');
    card.appendChild(title);

    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help';
    help.textContent = 'Canon reference point means the latest canon knowledge the roleplay should treat as established, such as “through Prisoner of Azkaban” or “before the Triwizard Tournament.” If it stays “not detected,” set it manually or leave it blank for AU/original scenes.';
    card.appendChild(help);

    const grid = document.createElement('div');
    grid.className = 'wandlight-runtime-grid wandlight-context-grid';
    grid.appendChild(createTextSettingField('Scene date', state?.loreContext?.sceneDate || '', 'Example: September 1, 1996. Used for date-sensitive lore.', (value) => updateLoreContextField('sceneDate', value)));
    grid.appendChild(createTextSettingField('Canon reference point', state?.loreContext?.canonBoundary || '', 'Example: Through Chapter 14 of Half-Blood Prince. Used to avoid using future canon prematurely.', (value) => updateLoreContextField('canonBoundary', value)));
    grid.appendChild(createTextSettingField('Branch', state?.loreContext?.branchId || 'main', 'Use “main” for the primary timeline, or a custom branch name for AU/time-travel branches.', (value) => updateLoreContextField('branchId', value || 'main')));
    card.appendChild(grid);

    card.appendChild(createKeyValue('Last detected', state?.loreContext?.lastDetectedAt ? new Date(state.loreContext.lastDetectedAt).toLocaleString() : 'never', 'When Story Context was last detected automatically. Manual edits also affect generation immediately.'));
    return card;
}

function createGenerationSettingsCard() {
    const settings = getSettings();
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card';

    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = 'Lore Generation Settings';
    addTooltip(title, 'These controls affect pending lore generation and duplicate filtering. Context detection has its own source window on the Context tab.');
    card.appendChild(title);

    const sourceRow = document.createElement('label');
    sourceRow.className = 'wandlight-slider-row wandlight-compact-slider-row';
    const sourceText = document.createElement('span');
    sourceText.textContent = `Lore source messages: ${settings.loreSourceMessageCount || 10}`;
    addTooltip(sourceText, 'How many recent chat messages are sent to lore generation. Lower values are faster; higher values provide more context.');
    const sourceInput = document.createElement('input');
    sourceInput.type = 'range';
    sourceInput.min = '4';
    sourceInput.max = '200';
    sourceInput.step = '1';
    sourceInput.value = String(settings.loreSourceMessageCount || 10);
    sourceInput.addEventListener('input', () => {
        const next = getSettings();
        next.loreSourceMessageCount = Math.max(4, Math.min(200, parseInt(sourceInput.value, 10) || 10));
        saveSettings(next);
        sourceText.textContent = `Lore source messages: ${next.loreSourceMessageCount}`;
    });
    sourceRow.appendChild(sourceText);
    sourceRow.appendChild(sourceInput);
    card.appendChild(sourceRow);

    const chunkRow = document.createElement('label');
    chunkRow.className = 'wandlight-slider-row wandlight-compact-slider-row';
    const chunkText = document.createElement('span');
    chunkText.textContent = `Chunk size: ${settings.loreGenerationChunkSize || 10}`;
    addTooltip(chunkText, 'How many recent messages are sent per lore-generation request. Lower values reduce prompt size and make progress clearer; higher values produce fewer model calls.');
    const chunkInput = document.createElement('input');
    chunkInput.type = 'range';
    chunkInput.min = '1';
    chunkInput.max = '50';
    chunkInput.step = '1';
    chunkInput.value = String(settings.loreGenerationChunkSize || 10);
    chunkInput.addEventListener('input', () => {
        const next = getSettings();
        next.loreGenerationChunkSize = Math.max(1, Math.min(50, parseInt(chunkInput.value, 10) || 10));
        saveSettings(next);
        chunkText.textContent = `Chunk size: ${next.loreGenerationChunkSize}`;
    });
    chunkRow.appendChild(chunkText);
    chunkRow.appendChild(chunkInput);
    card.appendChild(chunkRow);

    const chunkHelp = document.createElement('div');
    chunkHelp.className = 'wandlight-runtime-help';
    chunkHelp.textContent = 'Lore generation processes Source Messages in chunks, so 100 source messages at chunk size 10 means 10 smaller model requests instead of one huge prompt.';
    card.appendChild(chunkHelp);

    const tagRow = document.createElement('label');
    tagRow.className = 'wandlight-slider-row wandlight-compact-slider-row';
    const tagText = document.createElement('span');
    tagText.textContent = `Generated tags: ${settings.loreTagCount ?? 4}`;
    addTooltip(tagText, 'Number of short searchable tags requested per generated lore entry. Set to 0 to disable generated tags.');
    const tagInput = document.createElement('input');
    tagInput.type = 'range';
    tagInput.min = '0';
    tagInput.max = '10';
    tagInput.step = '1';
    tagInput.value = String(settings.loreTagCount ?? 4);
    tagInput.addEventListener('input', () => {
        const next = getSettings();
        next.loreTagCount = Math.max(0, Math.min(10, parseInt(tagInput.value, 10) || 0));
        saveSettings(next);
        tagText.textContent = `Generated tags: ${next.loreTagCount}`;
    });
    tagRow.appendChild(tagText);
    tagRow.appendChild(tagInput);
    card.appendChild(tagRow);

    const guardGrid = document.createElement('div');
    guardGrid.className = 'wandlight-runtime-grid';
    guardGrid.appendChild(createToggleCard(
        'Replacement Guard',
        settings.loreReplacementGuard !== false,
        'When enabled, Wandlight asks before replacing an unresolved pending lore batch.',
        (checked) => {
            const next = getSettings();
            next.loreReplacementGuard = checked;
            saveSettings(next);
            refreshPanelBody({ preserveScroll: true });
        }
    ));
    guardGrid.appendChild(createToggleCard(
        'Duplicate Guard',
        settings.loreDuplicateGuard !== false,
        'When enabled, generated entries that have duplicate IDs, duplicate titles, or very similar facts to accepted lore are filtered before Pending Lore Review.',
        (checked) => {
            const next = getSettings();
            next.loreDuplicateGuard = checked;
            saveSettings(next);
            refreshPanelBody({ preserveScroll: true });
        }
    ));
    card.appendChild(guardGrid);

    const tagHelp = document.createElement('div');
    tagHelp.className = 'wandlight-runtime-help';
    tagHelp.textContent = 'Tag schema: short labels only. Prefer character names, factions/groups, locations, era/year, plot thread, secret type, relationship pair, magic system, object/artifact, event, or villain/ally role. Full-sentence tags are trimmed and normalized.';
    card.appendChild(tagHelp);

    return card;
}

function createAutomationModeCard(titleText, modeKey, intervalKey, manualTooltip, automaticTooltip, intervalTooltip) {
    const settings = getSettings();
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card wandlight-automation-mode-card';

    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = titleText;
    addTooltip(title, `${titleText} can run manually from its button or automatically every configured number of turns.`);
    card.appendChild(title);

    const buttons = document.createElement('div');
    buttons.className = 'wandlight-mode-buttons';
    for (const [mode, label, tip] of [
        ['manual', 'Manual', manualTooltip],
        ['automatic', 'Automatic', automaticTooltip],
    ]) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wandlight-mode-button';
        if ((settings[modeKey] || 'manual') === mode) btn.classList.add('wandlight-mode-button-active');
        btn.textContent = label;
        addTooltip(btn, tip);
        btn.addEventListener('click', () => {
            const next = getSettings();
            next[modeKey] = mode;
            saveSettings(next);
            refreshPanelBody({ preserveScroll: true });
            toast(`${titleText} mode set to ${label}.`, 'info');
        });
        buttons.appendChild(btn);
    }
    card.appendChild(buttons);

    const row = document.createElement('label');
    row.className = 'wandlight-slider-row wandlight-compact-slider-row';
    const label = document.createElement('span');
    label.textContent = `Every ${settings[intervalKey] || 5} turns`;
    addTooltip(label, intervalTooltip);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '1';
    input.max = '20';
    input.step = '1';
    input.value = String(settings[intervalKey] || 5);
    input.addEventListener('input', () => {
        const next = getSettings();
        next[intervalKey] = Math.max(1, Math.min(20, parseInt(input.value, 10) || 5));
        saveSettings(next);
        label.textContent = `Every ${next[intervalKey]} turns`;
    });
    row.appendChild(label);
    row.appendChild(input);
    card.appendChild(row);

    return card;
}

function createGenerationProgressCard(state) {
    // Legacy compatibility; new UI uses createContextDetectionCard and createLoreGenerationCard.
    return createLoreGenerationCard(state);
}

function setFeatureProgress(kind = 'lore', message, percent = 0) {
    const statusKind = ['context', 'continuity', 'lore', 'canon'].includes(kind) ? kind : 'lore';
    const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
    const state = getState();
    if (state?.lorePanel) {
        state.lorePanel[`${statusKind}Status`] = message;
        state.lorePanel[`${statusKind}Progress`] = safePercent;
        if (statusKind === 'lore') {
            state.lorePanel.generationStatus = message;
            state.lorePanel.generationProgress = safePercent;
        }
        saveState(state);
    }

    if (!panelRoot) return;
    const text = panelRoot.querySelector(`[data-wandlight-status="${statusKind}"]`);
    const fill = panelRoot.querySelector(`[data-wandlight-progress="${statusKind}"]`);
    if (text) text.textContent = message;
    if (fill) fill.style.width = `${safePercent}%`;
}

const progressResetTimers = new Map();

function resetFeatureProgress(kind = 'lore', delayMs = 1400) {
    const statusKind = ['context', 'continuity', 'lore', 'canon'].includes(kind) ? kind : 'lore';
    const existing = progressResetTimers.get(statusKind);
    if (existing) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
        progressResetTimers.delete(statusKind);
        resetFeatureProgressNow(statusKind);
    }, Math.max(0, Number(delayMs) || 0));
    progressResetTimers.set(statusKind, timer);
}

function resetFeatureProgressNow(kind = 'lore') {
    const statusKind = ['context', 'continuity', 'lore', 'canon'].includes(kind) ? kind : 'lore';
    const existing = progressResetTimers.get(statusKind);
    if (existing) {
        window.clearTimeout(existing);
        progressResetTimers.delete(statusKind);
    }
    const state = getState();
    if (state?.lorePanel) {
        state.lorePanel[`${statusKind}Status`] = 'Idle.';
        state.lorePanel[`${statusKind}Progress`] = 0;
        if (statusKind === 'lore') {
            state.lorePanel.generationStatus = 'Idle.';
            state.lorePanel.generationProgress = 0;
        }
        saveState(state);
    }
    if (!panelRoot) return;
    const text = panelRoot.querySelector(`[data-wandlight-status="${statusKind}"]`);
    const fill = panelRoot.querySelector(`[data-wandlight-progress="${statusKind}"]`);
    if (text) text.textContent = 'Idle.';
    if (fill) fill.style.width = '0%';
}

function resetAllFeatureProgressNow() {
    ['context', 'continuity', 'lore', 'canon'].forEach(kind => resetFeatureProgressNow(kind));
}

function setGenerateProgress(message, percent = 0) {
    setFeatureProgress('lore', message, percent);
}

function updateLoreContextField(key, value) {
    const current = getState();
    pushStateSnapshot(current, `Edit story context: ${key}`, getSettings().maxSnapshots);
    setLoreContext({ [key]: value, lastDetectedAt: Date.now() });
    refreshHeader();
}

function createTextSettingField(label, value, tooltip, onChange) {
    const wrap = document.createElement('label');
    wrap.className = 'wandlight-inline-field wandlight-context-field';
    addTooltip(wrap, tooltip);

    const span = document.createElement('span');
    span.textContent = label;
    wrap.appendChild(span);

    const input = document.createElement('input');
    input.type = 'text';
    input.value = value || '';
    input.addEventListener('change', () => onChange?.(input.value.trim()));
    wrap.appendChild(input);
    return wrap;
}

function formatGenerationStatus(result) {
    if (!result) return 'Lore generation ended without a result.';
    if (result.status === 'empty_valid_entries') {
        if (result.droppedDuplicateCount) {
            return `Generation produced only duplicate/similar entries (${result.droppedDuplicateCount} filtered). Try disabling Duplicate Guard or broadening Source Messages.`;
        }
        return `Generation returned ${result.rawEntryCount || 0} raw entries, but none matched the Wandlight lore schema. The parser now accepts common aliases, but the model may still have returned unusable fields.`;
    }
    if (result.status === 'failed_parse') return 'Lore generation returned malformed JSON that could not be repaired.';
    if (result.status === 'failed_no_response') return result.chunkCount ? `Lore generation returned no usable responses across ${result.chunkCount} chunk(s). Check provider connection, model output format, or reduce chunk size.` : 'Lore generation returned an empty response from the selected model/provider.';
    if (result.status === 'api_not_configured') return `API/model settings incomplete: ${result.error || 'missing provider settings'}`;
    if (result.status === 'no_context_detected') return 'No story context could be detected. Set Story Context manually or increase Source Messages.';
    return `Lore generation ended with status: ${result.status || 'unknown'}`;
}



// Continuity tab --------------------------------------------------------------

const CONTINUITY_SECTION_LABELS = {
    canon: 'Canon / Date',
    scene: 'Scene',
    characters: 'Characters',
    appearance: 'Appearance',
    emotionalState: 'Emotional State',
    knowledge: 'Knowledge',
    secrets: 'Secrets',
    relationships: 'Relationships',
    threads: 'Story Threads',
    inventory: 'Inventory / Objects',
    objectives: 'Objectives',
    flags: 'Continuity Flags',
    storyMilestones: 'Story Milestones',
};


function createContinuityScanCard(state) {
    const settings = getSettings();
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card wandlight-generation-progress-card';

    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = 'Continuity Scan';
    addTooltip(title, 'Scans recent chat and applies structured state updates directly into the editable Continuity sections below.');
    card.appendChild(title);

    card.appendChild(createAutomationModeCard(
        'Continuity Tracking',
        'continuityTrackingMode',
        'continuityAutoInterval',
        'Continuity scans only run when you click Scan Continuity State.',
        'Wandlight automatically scans continuity state every configured number of turns using the Continuity provider.',
        'Automatic continuity scan interval in completed model turns.'
    ));

    const sourceRow = document.createElement('label');
    sourceRow.className = 'wandlight-slider-row wandlight-compact-slider-row';
    const sourceText = document.createElement('span');
    sourceText.textContent = `Continuity source messages: ${settings.continuitySourceMessageCount || 10}`;
    addTooltip(sourceText, 'How many recent chat messages are sent to Scan Continuity State. This is separate from Context and Lore source windows.');
    const sourceInput = document.createElement('input');
    sourceInput.type = 'range';
    sourceInput.min = '1';
    sourceInput.max = '200';
    sourceInput.step = '1';
    sourceInput.value = String(settings.continuitySourceMessageCount || 10);
    sourceInput.addEventListener('input', () => {
        const next = getSettings();
        next.continuitySourceMessageCount = Math.max(1, Math.min(200, parseInt(sourceInput.value, 10) || 10));
        saveSettings(next);
        sourceText.textContent = `Continuity source messages: ${next.continuitySourceMessageCount}`;
    });
    sourceRow.appendChild(sourceText);
    sourceRow.appendChild(sourceInput);
    card.appendChild(sourceRow);

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions';
    actions.appendChild(createButton('Scan Continuity State', 'Scans recent chat and applies structured state updates directly into the editable Continuity sections below. Use State History to undo the scan if needed.', async (btn) => {
        if (!ensureContinuityProviderReadyForAction('Scan Continuity State')) return;
        await runBusyAction(btn, 'Scanning...', async () => {
            setFeatureProgress('continuity', 'Scanning continuity state...', 10);
            const result = await onExtractionTriggered({ force: true, applyImmediately: true });
            refreshHeader();
            refreshPanelBody({ preserveScroll: false });

            if (result?.status === 'applied') {
                const keys = result.changeKeys?.length ? ` Updated: ${result.changeKeys.join(', ')}.` : '';
                setFeatureProgress('continuity', `Continuity scan applied.${keys}`, 100);
                resetFeatureProgress('continuity');
                toast(`Continuity state updated.${keys}`);
            } else if (result?.status === 'no_changes') {
                setFeatureProgress('continuity', 'Continuity scan complete. No state changes detected.', 100);
                resetFeatureProgress('continuity');
                toast('Scan complete. No continuity changes detected.', 'info');
            } else {
                const status = result?.error || result?.status || 'unknown result';
                setFeatureProgress('continuity', `Continuity scan did not update state: ${status}`, 100);
                toast(`Continuity scan did not update state: ${status}`, 'warning');
            }
        });
    }, 'wandlight-primary-button'));
    card.appendChild(actions);

    appendGenerationStatus(card, state, 'continuity');
    return card;
}

function renderContinuityTab(container, state) {
    container.appendChild(createSectionHeader(
        'Continuity State',
        'Edit the structured roleplay state Wandlight tracks and injects separately from Lore entries. Each section can be enabled or disabled for this chat.'
    ));

    container.appendChild(createContinuityScanCard(state));

    if (state?.lastDelta) {
        const pendingDelta = document.createElement('div');
        pendingDelta.className = 'wandlight-review-section';
        const title = document.createElement('h4');
        title.textContent = 'Pending Continuity Changes';
        addTooltip(title, 'Older or manually created continuity deltas waiting to be applied. New scans apply directly to the editable sections below.');
        pendingDelta.appendChild(title);
        pendingDelta.appendChild(createDeltaReviewCard(state.lastDelta));
        container.appendChild(pendingDelta);
    }

    container.appendChild(createCollapsibleSection('continuity.trackedSections', 'Tracked Sections', 'Enable/disable scan and injection sections', false, createContinuitySectionToggleCard(state), { tooltip: 'Optional continuity sections for this chat.' }));
    container.appendChild(createCollapsibleSection('continuity.canonScene', 'Canon and Scene', getContinuityCanonSceneSummary(state), false, createCanonSceneEditorCard(state), { tooltip: 'Core date, scene, cast, and activity fields.' }));
    container.appendChild(createCollapsibleSection('continuity.canonDivergences', 'Canon Divergences', getCountLabel(state?.canon?.divergences || [], 'divergence'), false, createCanonDivergencesEditorCard(state), { tooltip: 'AU or changed-canon facts separated from the core scene fields.' }));
    container.appendChild(createCollapsibleSection('continuity.characters', 'Characters', getCountLabel(state.characters || [], 'character'), false, createCharacterStateEditorCard(state), { tooltip: 'Character-specific state: clothing, posture, emotion, goals, and notes.' }));
    container.appendChild(createCollapsibleSection('continuity.storyMilestones', 'Story Milestones', getCountLabel(state.storyMilestones || {}, 'milestone'), false, createStoryMilestonesEditorCard(state), { tooltip: 'Story-state switches that control lore activation and expiration.' }));
    container.appendChild(createCollapsibleSection('continuity.knowledge', 'Knowledge', getCountLabel(state.knowledge || {}, 'character'), false, createJsonEditorCard('Knowledge', 'Character-keyed facts. Example: { "Harry": ["knows X"] }', 'knowledge', state.knowledge || {}, false, 'knowledge'), { tooltip: 'Character-keyed knowledge facts.' }));
    container.appendChild(createCollapsibleSection('continuity.secrets', 'Secrets', getCountLabel(state.secrets || [], 'secret'), false, createJsonEditorCard('Secrets', 'Non-public facts, who knows them, suspicions, and public versions.', 'secrets', state.secrets || [], false, 'secrets'), { tooltip: 'Secret facts and reveal state.' }));
    container.appendChild(createCollapsibleSection('continuity.relationships', 'Relationships', getCountLabel(state.relationships || [], 'relationship'), false, createJsonEditorCard('Relationships', 'Relationship state such as trust, tension, and notes.', 'relationships', state.relationships || [], false, 'relationships'), { tooltip: 'Relationship state such as trust, tension, and notes.' }));
    container.appendChild(createCollapsibleSection('continuity.threads', 'Threads', getCountLabel(state.threads || [], 'thread'), false, createJsonEditorCard('Threads', 'Active, dormant, or resolved story threads and unresolved consequences.', 'threads', state.threads || [], false, 'threads'), { tooltip: 'Story threads and unresolved consequences.' }));
    container.appendChild(createCollapsibleSection('continuity.inventory', 'Inventory / Objects', getCountLabel(state.inventory || [], 'item'), false, createJsonEditorCard('Inventory / Objects', 'Tracked items, owners, locations, and object status.', 'inventory', state.inventory || [], false, 'inventory'), { tooltip: 'Tracked items, owners, locations, and object status.' }));
    container.appendChild(createCollapsibleSection('continuity.objectives', 'Objectives', getCountLabel(state.objectives || [], 'objective'), false, createJsonEditorCard('Objectives', 'Character or story goals, status, and stakes.', 'objectives', state.objectives || [], false, 'objectives'), { tooltip: 'Character or story goals, status, and stakes.' }));
    container.appendChild(createCollapsibleSection('continuity.flags', 'Continuity Flags', getCountLabel(state.continuityFlags || [], 'flag'), false, createJsonEditorCard('Continuity Flags', 'Contradictions, warnings, uncertainties, and resolved flags.', 'continuityFlags', state.continuityFlags || [], false, 'flags'), { tooltip: 'Contradictions, warnings, uncertainties, and resolved flags.' }));
}

function createContinuitySectionToggleCard(state) {
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card';
    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = 'Tracked Sections';
    addTooltip(title, 'Disabled sections are not updated by Scan Continuity State and are omitted from continuity injection. Existing data is preserved unless you delete it.');
    card.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'wandlight-runtime-grid wandlight-continuity-toggle-grid';
    const cfg = state?.continuityConfig || {};
    for (const [key, label] of Object.entries(CONTINUITY_SECTION_LABELS)) {
        grid.appendChild(createToggleCard(label, cfg[key] !== false, `${label} tracking. Turn off to preserve existing data but omit it from scans and continuity injection.`, (checked) => {
            const current = getState();
            pushStateSnapshot(current, `Toggle continuity section: ${label}`, getSettings().maxSnapshots);
            current.continuityConfig = { ...(current.continuityConfig || {}), [key]: checked };
            saveState(current);
            refreshPanelBody({ preserveScroll: true });
            refreshHeader();
        }));
    }
    card.appendChild(grid);

    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help';
    help.textContent = 'This follows tracker-style design: schema sections are chat-specific and optional, so a simple scene can track only date and scene while a detailed sim can track emotions, clothing, objects, and goals.';
    card.appendChild(help);
    return card;
}

function createCanonSceneEditorCard(state) {
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card';
    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = 'Canon and Scene';
    addTooltip(title, 'Frequently edited continuity fields. Changes save into chatMetadata.wandlight_continuity.');
    card.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'wandlight-runtime-grid wandlight-context-grid';
    grid.appendChild(createContinuityTextField('Era', state?.canon?.era || '', 'canon', 'era', 'Canon era or broad story period.'));
    grid.appendChild(createContinuityTextField('In-universe date', state?.canon?.inUniverseDate || '', 'canon', 'inUniverseDate', 'Current in-universe date if known.'));
    grid.appendChild(createContinuityTextField('Canon boundary', state?.canon?.canonBoundary || '', 'canon', 'canonBoundary', 'Latest canon point treated as established.'));
    grid.appendChild(createContinuityTextField('Location', state?.scene?.location || '', 'scene', 'location', 'Current scene location.'));
    grid.appendChild(createContinuityTextField('Time of day', state?.scene?.timeOfDay || '', 'scene', 'timeOfDay', 'Current scene time of day.'));
    grid.appendChild(createContinuityTextField('Weather', state?.scene?.weather || '', 'scene', 'weather', 'Current weather if relevant.'));
    grid.appendChild(createContinuityTextField('Ambience', state?.scene?.ambience || '', 'scene', 'ambience', 'Scene mood or ambient conditions.'));
    grid.appendChild(createContinuityTextField('Current activity', state?.scene?.currentActivity || '', 'scene', 'currentActivity', 'What is currently happening in the scene.'));
    card.appendChild(grid);

    card.appendChild(createArrayTextField('Present characters', state?.scene?.presentCharacters || [], 'scene', 'presentCharacters', 'Comma-separated characters currently present.'));
    card.appendChild(createArrayTextField('Nearby characters', state?.scene?.nearbyCharacters || [], 'scene', 'nearbyCharacters', 'Comma-separated characters nearby but not necessarily in the active conversation.'));
    card.appendChild(createContinuitySectionPromptEditor('canonScene', 'Canon and Scene'));
    return card;
}

function getContinuityCanonSceneSummary(state) {
    const parts = [state?.canon?.inUniverseDate, state?.scene?.location, state?.scene?.currentActivity]
        .map(v => String(v || '').trim())
        .filter(Boolean);
    return parts.length ? parts.slice(0, 2).join(' · ') : 'core fields';
}

function createCanonDivergencesEditorCard(state) {
    return createJsonEditorCard(
        'Canon Divergences',
        'AU or changed-canon facts with optional sinceDate fields. Kept separate from Canon and Scene so it can stay collapsed during normal play.',
        'canon.divergences',
        state?.canon?.divergences || [],
        false,
        'canonDivergences'
    );
}

function createStoryMilestonesEditorCard(state) {
    const card = createJsonEditorCard(
        'Story Milestones',
        'Story-state switches used by Lore entries. Canon dates can suggest entries, but milestones decide whether reveal/knowledge entries are actually true. Example: { "horcruxes_revealed_to_trio": { "status": "not_happened", "evidence": [] } }',
        'storyMilestones',
        state?.storyMilestones || {},
        false,
        'storyMilestones'
    );
    const schema = document.createElement('div');
    schema.className = 'wandlight-runtime-help';
    schema.textContent = 'Statuses: not_happened, suspected, happened, blocked, diverged, unknown. Wandlight should only mark happened when the roleplay establishes it, not merely because the canon date passed.';
    card.appendChild(schema);
    return card;
}

function createCharacterStateEditorCard(state) {
    const card = createJsonEditorCard(
        'Characters',
        'Character state supports name, role, location, clothing, posture, physicalState, emotionalState, inventory, goals, and notes. Emotional numeric values are -5 to +5 and cool toward neutral in injection previews unless reinforced.',
        'characters',
        state?.characters || [],
        false,
        'characters'
    );
    const schema = document.createElement('div');
    schema.className = 'wandlight-runtime-help';
    schema.textContent = 'Recommended character object: { "name": "Harry", "clothing": "school robes", "physicalState": "tired", "emotionalState": { "trust": 2, "fear": 1, "notes": "uneasy but cooperative" }, "goals": ["find the source of the curse"] }';
    card.appendChild(schema);
    return card;
}


function createContinuitySectionPromptEditor(sectionKey, label) {
    const settings = getSettings();
    const prompts = settings.continuitySectionPrompts || {};
    const defaults = DEFAULT_SETTINGS.continuitySectionPrompts || {};

    const wrap = document.createElement('div');
    wrap.className = 'wandlight-section-prompt-editor-wrap';

    const textarea = document.createElement('textarea');
    textarea.className = 'wandlight-section-prompt-editor';
    textarea.spellcheck = false;
    textarea.value = String(prompts[sectionKey] || defaults[sectionKey] || '');
    addTooltip(textarea, `User-editable scan prompt for ${label}. This is appended to Scan Continuity State when this section is enabled/tracked.`);

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions wandlight-section-prompt-actions';
    actions.appendChild(createButton('Save Prompt', `Save the Scan Continuity prompt for ${label}.`, () => {
        const next = getSettings();
        next.continuitySectionPrompts = {
            ...(DEFAULT_SETTINGS.continuitySectionPrompts || {}),
            ...(next.continuitySectionPrompts || {}),
            [sectionKey]: textarea.value.trim(),
        };
        saveSettings(next);
        toast(`${label} scan prompt saved.`);
    }, 'wandlight-primary-button'));
    actions.appendChild(createButton('Reset Default', `Restore the default Scan Continuity prompt for ${label}.`, () => {
        textarea.value = String(defaults[sectionKey] || '');
        const next = getSettings();
        next.continuitySectionPrompts = {
            ...(DEFAULT_SETTINGS.continuitySectionPrompts || {}),
            ...(next.continuitySectionPrompts || {}),
            [sectionKey]: textarea.value.trim(),
        };
        saveSettings(next);
        toast(`${label} scan prompt reset.`);
    }));

    wrap.appendChild(textarea);
    wrap.appendChild(actions);

    return createCollapsibleSection(
        `continuity.prompt.${sectionKey}`,
        'Scan Prompt',
        'used when this section is tracked',
        false,
        wrap,
        { tooltip: `Editable prompt guidance appended to continuity scans for ${label}.` }
    );
}

function createContinuityTextField(label, value, section, field, tooltip) {
    return createTextSettingField(label, value, tooltip, (nextValue) => {
        const current = getState();
        pushStateSnapshot(current, `Edit continuity: ${label}`, getSettings().maxSnapshots);
        current[section] = { ...(current[section] || {}), [field]: nextValue };
        saveState(current);
        refreshHeader();
    });
}

function createArrayTextField(label, values, section, field, tooltip) {
    const wrap = document.createElement('label');
    wrap.className = 'wandlight-inline-field wandlight-context-field';
    addTooltip(wrap, tooltip);
    const span = document.createElement('span');
    span.textContent = label;
    wrap.appendChild(span);
    const input = document.createElement('input');
    input.type = 'text';
    input.value = Array.isArray(values) ? values.join(', ') : '';
    input.addEventListener('change', () => {
        const current = getState();
        pushStateSnapshot(current, `Edit continuity: ${label}`, getSettings().maxSnapshots);
        current[section] = { ...(current[section] || {}), [field]: input.value.split(',').map(x => x.trim()).filter(Boolean) };
        saveState(current);
        refreshHeader();
    });
    wrap.appendChild(input);
    return wrap;
}

function createJsonEditorCard(titleText, helpText, path, value, embedded = false, promptSectionKey = '') {
    const card = document.createElement('div');
    card.className = embedded ? 'wandlight-json-editor-embedded' : 'wandlight-runtime-card wandlight-json-editor-card';
    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = titleText;
    addTooltip(title, helpText);
    card.appendChild(title);

    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help';
    help.textContent = helpText;
    card.appendChild(help);

    const textarea = document.createElement('textarea');
    textarea.className = 'wandlight-continuity-json-editor';
    textarea.value = JSON.stringify(value ?? null, null, 2);
    textarea.spellcheck = false;
    addTooltip(textarea, `Editable JSON for ${titleText}. Save validates JSON before writing to state.`);
    card.appendChild(textarea);

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions';
    actions.appendChild(createButton('Save Section', `Save edited ${titleText} JSON into the current chat continuity state.`, () => {
        try {
            const parsed = JSON.parse(textarea.value || 'null');
            const current = getState();
            pushStateSnapshot(current, `Edit continuity section: ${titleText}`, getSettings().maxSnapshots);
            setStatePath(current, path, parsed);
            saveState(current);
            refreshPanelBody({ preserveScroll: true });
            refreshHeader();
            toast(`${titleText} saved.`);
        } catch (e) {
            toast(`Invalid JSON in ${titleText}: ${e.message}`, 'error');
        }
    }, 'wandlight-primary-button'));
    actions.appendChild(createButton('Revert', `Reload ${titleText} from saved state.`, () => {
        refreshPanelBody({ preserveScroll: true });
    }));
    card.appendChild(actions);
    if (promptSectionKey) {
        card.appendChild(createContinuitySectionPromptEditor(promptSectionKey, titleText));
    }
    return card;
}

function setStatePath(state, path, value) {
    const parts = String(path).split('.');
    let target = state;
    for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i];
        if (!target[key] || typeof target[key] !== 'object') target[key] = {};
        target = target[key];
    }
    target[parts[parts.length - 1]] = value;
}

// Injection tab ---------------------------------------------------------------

function renderInjectionTab(container, state) {
    const settings = getSettings();
    const activeLore = getInjectableLoreEntries(state, 0).length;
    const continuityPreview = buildContinuityPreview(state, settings.continuityInjectionMode || 'direct');
    const lorePreview = buildLorePreview(state, settings.loreInjectionMode || 'direct');
    updateCompressionTurnStatus(state, 'lore');
    updateCompressionTurnStatus(state, 'continuity');

    container.appendChild(createSectionHeader(
        'Injection',
        'Final workflow step. Decide whether to inject structured Continuity state, Lore entries, or both, and whether each is direct or model-compressed.'
    ));

    const toggles = document.createElement('div');
    toggles.className = 'wandlight-runtime-grid';
    toggles.appendChild(createToggleCard(
        'Inject Continuity',
        settings.injectContinuity !== false && settings.injectMemo !== false,
        'Injects the editable Continuity tab state: scene, characters, emotions, knowledge, relationships, threads, objects, objectives, and flags. This is separate from Lore entries.',
        (checked) => {
            const next = getSettings();
            next.injectContinuity = checked;
            next.injectMemo = checked;
            saveSettings(next);
            refreshPanelBody({ preserveScroll: false });
            refreshHeader();
        }
    ));
    toggles.appendChild(createToggleCard(
        'Inject Lore',
        settings.injectLore !== false,
        'Injects accepted active Lore tab entries. Turn this off if you want Wandlight to track/edit lore without sending lore entries to the roleplay model.',
        (checked) => {
            const next = getSettings();
            next.injectLore = checked;
            saveSettings(next);
            refreshPanelBody({ preserveScroll: false });
            refreshHeader();
        }
    ));
    container.appendChild(toggles);

    const placementStatus = `${settings.injectionTransport === 'interceptor' ? 'Legacy prepend' : 'Extension Prompt'} · C ${formatPlacementSummary(settings, 'continuity')} · L ${formatPlacementSummary(settings, 'lore')}`;
    container.appendChild(createCollapsibleSection('injection.promptPlacement', 'Prompt Placement', placementStatus, false, createInjectionPlacementCard(settings), { tooltip: 'Role, position, and depth used for prompt injection.' }));

    container.appendChild(createCollapsibleSection(
        'injection.continuityHandling',
        'Continuity Handling',
        `${settings.continuityInjectionMode || 'direct'} · ${getCompressionStatusTextForSummary(state, 'continuity')}`,
        (settings.continuityInjectionMode || 'direct') === 'compressed',
        createContinuityHandlingCard(state, settings),
        { tooltip: 'Direct or model-compressed handling for Continuity injection.' }
    ));

    container.appendChild(createCollapsibleSection(
        'injection.loreHandling',
        'Lore Handling',
        `${settings.loreInjectionMode || 'direct'} · ${activeLore} entries · ${getCompressionStatusTextForSummary(state, 'lore')}`,
        (settings.loreInjectionMode || 'direct') === 'compressed',
        createLoreHandlingCard(state, settings, activeLore),
        { tooltip: 'Direct or model-compressed handling for Lore injection.' }
    ));

    container.appendChild(createCollapsibleSection(
        'injection.compressionPrompts',
        'Advanced Compression Prompts',
        'Editable templates for model compression',
        false,
        createCompressionPromptEditorCard(),
        { tooltip: 'Advanced editable prompt templates used by Compress Continuity Now and Compress Lore Now.' }
    ));

    container.appendChild(createInjectionPreviewCard('Continuity Injection', 'wandlight-continuity-injection-preview', continuityPreview, settings.injectContinuity !== false && settings.injectMemo !== false, 'This is the actual Continuity block currently configured for prompt injection. It can be placed at a different depth because it is separated from Lore.'));
    container.appendChild(createInjectionPreviewCard('Lore Injection', 'wandlight-lore-injection-preview', lorePreview, settings.injectLore !== false, 'This is the actual Lore block currently configured for prompt injection, using Direct or cached model-compressed handling.'));
}

function createContinuityHandlingCard(state, settings) {
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card wandlight-compression-handling-card';
    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = 'Continuity Handling Mode';
    addTooltip(title, 'Direct sends structured continuity state. Compressed uses a cached model compression generated from the direct continuity preview.');
    card.appendChild(title);

    const buttons = document.createElement('div');
    buttons.className = 'wandlight-mode-buttons';
    buttons.appendChild(createContinuityModeButton('direct', 'Direct', 'Insert editable continuity state with full section detail.', settings));
    buttons.appendChild(createContinuityModeButton('compressed', 'Compressed', 'Use a saved model-compressed continuity block. If the cache is stale or missing, direct text is used until you click Compress Continuity Now.', settings));
    card.appendChild(buttons);

    card.appendChild(createCompressionLevelControl('continuity', settings));
    card.appendChild(createKeyValue('Target budget', getCompressionBudgetSummary('continuity', state), 'Compression levels set an explicit target token budget for the model request.'));
    card.appendChild(createKeyValue('Continuity status', getContinuityCompressionStatusText(getState()), 'Shows whether cached model-compressed continuity is current, stale, missing, or failed.'));

    const decay = document.createElement('label');
    decay.className = 'wandlight-inline-field';
    const decayText = document.createElement('span');
    decayText.textContent = 'Emotion cool-off turns';
    addTooltip(decayText, 'Number of chat turns before temporary high emotions move one step toward neutral in injection preview. Stored emotional state is not overwritten.');
    const decayInput = document.createElement('input');
    decayInput.type = 'number';
    decayInput.min = '1';
    decayInput.max = '50';
    decayInput.value = String(settings.continuityEmotionDecayTurns || 6);
    decayInput.addEventListener('change', () => {
        const next = getSettings();
        next.continuityEmotionDecayTurns = Math.max(1, Math.min(50, parseInt(decayInput.value, 10) || 6));
        saveSettings(next);
        refreshPanelBody({ preserveScroll: false });
    });
    decay.appendChild(decayText);
    decay.appendChild(decayInput);
    card.appendChild(decay);

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions';
    actions.appendChild(createButton('Compress Continuity Now', 'Uses the Continuity provider to compress the direct Continuity Injection block and cache it for compressed injection.', async (btn) => {
        await runModelCompression('continuity', btn);
    }, 'wandlight-primary-button'));
    card.appendChild(actions);
    return card;
}

function createLoreHandlingCard(state, settings, activeLore) {
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card wandlight-compression-handling-card';
    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = 'Lore Handling Mode';
    addTooltip(title, 'Direct sends resolved accepted lore text. Compressed uses a cached model compression generated from the direct lore preview.');
    card.appendChild(title);

    const buttons = document.createElement('div');
    buttons.className = 'wandlight-mode-buttons';
    buttons.appendChild(createInjectionModeButton('direct', 'Direct', 'Insert all accepted, unmuted lore entries as resolved text. There is no hidden entry cap.', settings));
    buttons.appendChild(createInjectionModeButton('compressed', 'Compressed', 'Use a saved model-compressed lore block. If the cache is stale or missing, direct text is used until you click Compress Lore Now.', settings));
    card.appendChild(buttons);

    card.appendChild(createKeyValue('Lore available', String(activeLore), 'Accepted, unmuted lore entries eligible for prompt injection. Muting controls exclusion.'));
    card.appendChild(createKeyValue('Pinned protection', 'enabled', 'Pinned entries are identified as protected details in the compression prompt.'));
    card.appendChild(createCompressionLevelControl('lore', settings));
    card.appendChild(createKeyValue('Target budget', getCompressionBudgetSummary('lore', state), 'Compression levels set an explicit target token budget for the model request.'));

    const intervalLabel = document.createElement('label');
    intervalLabel.className = 'wandlight-inline-field';
    const intervalText = document.createElement('span');
    intervalText.textContent = 'Auto-compress interval';
    addTooltip(intervalText, 'Number of completed chat turns before Wandlight should refresh model-compressed lore after lore changes. Manual compression is available with Compress Lore Now.');
    const interval = document.createElement('input');
    interval.type = 'number';
    interval.min = '1';
    interval.max = '100';
    interval.step = '1';
    interval.value = String(settings.loreCompressionTurnInterval || 8);
    interval.addEventListener('change', () => {
        const next = getSettings();
        next.loreCompressionTurnInterval = Math.max(1, Math.min(100, parseInt(interval.value, 10) || 8));
        saveSettings(next);
        refreshPanelBody({ preserveScroll: false });
    });
    intervalLabel.appendChild(intervalText);
    intervalLabel.appendChild(interval);
    card.appendChild(intervalLabel);
    card.appendChild(createKeyValue('Lore compression status', getCompressionStatusText(getState()), 'Shows whether cached model-compressed lore is current, stale, missing, or failed.'));

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions';
    actions.appendChild(createButton('Compress Lore Now', 'Uses the Lore provider to compress the direct Lore Injection block and cache it for compressed injection.', async (btn) => {
        await runModelCompression('lore', btn);
    }, 'wandlight-primary-button'));
    card.appendChild(actions);
    return card;
}

function createCompressionLevelControl(kind, settings) {
    const levelKey = kind === 'continuity' ? 'continuityCompressionLevel' : 'loreCompressionLevel';
    const levelValue = Math.max(1, Math.min(5, Number(settings[levelKey]) || 2));
    const label = document.createElement('label');
    label.className = 'wandlight-slider-row';
    const text = document.createElement('span');
    text.textContent = `Compression level: ${levelValue} (${getCompressionProfile(levelValue).label})`;
    addTooltip(text, 'Compression level changes both the wording and the target token budget for the model compression request.');
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '1';
    range.max = '5';
    range.value = String(levelValue);
    range.addEventListener('input', () => {
        const next = getSettings();
        next[levelKey] = Number(range.value) || 2;
        saveSettings(next);
        text.textContent = `Compression level: ${next[levelKey]} (${getCompressionProfile(next[levelKey]).label})`;
        refreshInjectionPreviewOnly();
    });
    label.appendChild(text);
    label.appendChild(range);
    return label;
}

function createCompressionPromptEditorCard() {
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card wandlight-compression-prompt-card';
    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = 'Compression Prompt Templates';
    card.appendChild(title);

    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help';
    help.textContent = 'Variables: {{kind}}, {{compressionLevel}}, {{compressionLabel}}, {{targetTokens}}, {{hardTokenLimit}}, {{storyContext}}, {{directText}}.';
    card.appendChild(help);

    card.appendChild(createCompressionPromptTextarea('Continuity Compression Prompt', 'continuityCompressionPromptTemplate', DEFAULT_SETTINGS.continuityCompressionPromptTemplate));
    card.appendChild(createCompressionPromptTextarea('Lore Compression Prompt', 'loreCompressionPromptTemplate', DEFAULT_SETTINGS.loreCompressionPromptTemplate));
    return card;
}

function createCompressionPromptTextarea(labelText, settingKey, defaultValue) {
    const wrap = document.createElement('div');
    wrap.className = 'wandlight-compression-template-wrap';
    const label = document.createElement('div');
    label.className = 'wandlight-runtime-card-title wandlight-compression-template-title';
    label.textContent = labelText;
    addTooltip(label, `Editable template used for ${labelText}.`);
    wrap.appendChild(label);

    const textarea = document.createElement('textarea');
    textarea.className = 'wandlight-compression-template-editor';
    textarea.spellcheck = false;
    textarea.value = String(getSettings()[settingKey] || defaultValue || '');
    wrap.appendChild(textarea);

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions';
    actions.appendChild(createButton('Save Template', `Save ${labelText}.`, () => {
        const next = getSettings();
        next[settingKey] = textarea.value;
        saveSettings(next);
        toast(`${labelText} saved.`);
    }, 'wandlight-primary-button'));
    actions.appendChild(createButton('Reset Default', `Restore Wandlight's default ${labelText}.`, () => {
        const next = getSettings();
        next[settingKey] = defaultValue;
        saveSettings(next);
        textarea.value = defaultValue;
        toast(`${labelText} reset to default.`, 'info');
    }));
    actions.appendChild(createButton('Copy Prompt', `Copy ${labelText} to clipboard.`, async () => {
        try {
            await navigator.clipboard?.writeText(textarea.value);
            toast(`${labelText} copied.`, 'info');
        } catch (_) {
            toast('Clipboard copy unavailable in this browser context.', 'warning');
        }
    }));
    wrap.appendChild(actions);
    return wrap;
}



function formatPlacementSummary(settings, kind) {
    const prefix = kind === 'continuity' ? 'continuity' : 'lore';
    const position = Number(settings[`${prefix}InjectionPosition`] ?? 1);
    const role = Number(settings[`${prefix}InjectionRole`] ?? 0);
    const depth = Number(settings[`${prefix}InjectionDepth`] ?? 4);
    const positionLabel = position === 1 ? 'in-chat' : (position === 2 ? 'before' : 'after');
    const roleLabel = role === 1 ? 'user' : (role === 2 ? 'assistant' : 'system');
    return `${positionLabel}@${depth}/${roleLabel}`;
}

function getCompressionProfile(level) {
    const profiles = {
        1: { label: 'Light', ratio: 0.8, description: 'preserve most details; remove redundancy only' },
        2: { label: 'Moderate', ratio: 0.6, description: 'concise but still descriptive' },
        3: { label: 'Balanced', ratio: 0.4, description: 'keep roleplay-relevant facts and current-scene implications' },
        4: { label: 'Heavy', ratio: 0.25, description: 'short bullets; preserve critical secrets, constraints, and protected details' },
        5: { label: 'Minimal', ratio: 0.15, description: 'minimum viable context; only essential facts, constraints, secrets, and hazards' },
    };
    return profiles[Math.max(1, Math.min(5, Number(level) || 2))] || profiles[2];
}

function estimateTokenBudgetForCompression(text, level) {
    const directTokens = estimateTokens(text || '');
    const profile = getCompressionProfile(level);
    const targetTokens = Math.max(96, Math.ceil(directTokens * profile.ratio));
    const hardTokenLimit = Math.max(128, Math.ceil(targetTokens * 1.2));
    return {
        directTokens,
        targetTokens,
        hardTokenLimit,
        profile,
    };
}

function getCompressionBudgetSummary(kind, state) {
    const settings = getSettings();
    const level = kind === 'continuity'
        ? Math.max(1, Math.min(5, Number(settings.continuityCompressionLevel) || 2))
        : Math.max(1, Math.min(5, Number(settings.loreCompressionLevel) || 2));
    const directText = kind === 'continuity'
        ? buildContinuityPreview(state, 'direct')
        : buildLorePreview(state, 'direct');
    if (!directText || !directText.trim()) return 'No source text';
    const budget = estimateTokenBudgetForCompression(directText, level);
    return `~${budget.targetTokens} target / ${budget.hardTokenLimit} max tokens from ~${budget.directTokens} direct tokens`;
}

function getCompressionStatusTextForSummary(state, kind) {
    const status = kind === 'continuity' ? getContinuityCompressionStatusText(state) : getCompressionStatusText(state);
    if (/Direct mode active/i.test(status)) return 'direct';
    if (/current/i.test(status) || /model-compressed/i.test(status)) return 'current cache';
    if (/stale/i.test(status)) return 'stale cache';
    if (/missing|No cached/i.test(status)) return 'no cache';
    return status.slice(0, 40);
}


function createInjectionPlacementCard(settings) {
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card wandlight-prompt-placement-card';

    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = 'Prompt Placement';
    addTooltip(title, 'Controls how Wandlight injects Continuity and Lore into SillyTavern prompts. Extension Prompt mode uses SillyTavern role/depth injection; Legacy mode prepends a combined block to the last user message.');
    card.appendChild(title);

    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help';
    help.textContent = 'Recommended: Extension Prompt, System role, In-chat depth 4. Depth is relative to the final prompt stack, so the visible payload message index can vary.';
    card.appendChild(help);

    const placement = document.createElement('div');
    placement.className = 'wandlight-prompt-placement-lines';

    const methodRow = document.createElement('div');
    methodRow.className = 'wandlight-prompt-placement-line wandlight-prompt-placement-method-line';
    methodRow.appendChild(createPlacementSelect('Injection method', 'injectionTransport', settings.injectionTransport || 'extension_prompt', [
        ['extension_prompt', 'Extension Prompt'],
        ['interceptor', 'Legacy prepend'],
    ], 'Extension Prompt uses SillyTavern setExtensionPrompt and supports role/depth. Legacy mode has no true depth and appears as part of the last user message.', 'wandlight-placement-method'));
    placement.appendChild(methodRow);

    placement.appendChild(createPromptPlacementLine('Continuity', [
        createPlacementSelect('Position', 'continuityInjectionPosition', String(settings.continuityInjectionPosition ?? 1), [
            ['1', 'In-chat'],
            ['0', 'After prompt'],
            ['2', 'Before prompt'],
        ], 'Where the Continuity Injection block is inserted. Depth only applies to In-chat.', 'wandlight-placement-position'),
        createPlacementNumber('Depth', 'continuityInjectionDepth', settings.continuityInjectionDepth ?? 4, 0, 1000, 'Depth 0 is closest to the latest message. Higher depth moves the block earlier in chat history.', 'wandlight-placement-depth'),
        createPlacementSelect('Role', 'continuityInjectionRole', String(settings.continuityInjectionRole ?? 0), [
            ['0', 'System'],
            ['1', 'User'],
            ['2', 'Assistant'],
        ], 'Role used for the injected Continuity block when using In-chat extension prompt placement.', 'wandlight-placement-role'),
    ]));

    placement.appendChild(createPromptPlacementLine('Lore', [
        createPlacementSelect('Position', 'loreInjectionPosition', String(settings.loreInjectionPosition ?? 1), [
            ['1', 'In-chat'],
            ['0', 'After prompt'],
            ['2', 'Before prompt'],
        ], 'Where the Lore Injection block is inserted. Depth only applies to In-chat.', 'wandlight-placement-position'),
        createPlacementNumber('Depth', 'loreInjectionDepth', settings.loreInjectionDepth ?? 4, 0, 1000, 'Depth 0 is closest to the latest message. Higher depth moves the block earlier in chat history.', 'wandlight-placement-depth'),
        createPlacementSelect('Role', 'loreInjectionRole', String(settings.loreInjectionRole ?? 0), [
            ['0', 'System'],
            ['1', 'User'],
            ['2', 'Assistant'],
        ], 'Role used for the injected Lore block when using In-chat extension prompt placement.', 'wandlight-placement-role'),
    ]));

    card.appendChild(placement);

    const status = typeof globalThis.wandlightGetInjectionStatus === 'function'
        ? globalThis.wandlightGetInjectionStatus()
        : null;
    const statusText = status
        ? `${status.transport || 'unknown'} | continuity ${status.continuityChars || 0} chars | lore ${status.loreChars || 0} chars`
        : 'Prompt sync status unavailable until extension initialization completes.';
    card.appendChild(createKeyValue('Current sync', statusText, 'Shows the last Wandlight prompt sync result.'));

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions';
    actions.appendChild(createButton('Sync Injection Now', 'Immediately updates SillyTavern extension prompts from the current Continuity and Lore previews.', () => {
        if (typeof globalThis.wandlightSyncPromptInjection === 'function') {
            const info = globalThis.wandlightSyncPromptInjection();
            toast(`Synced injection: ${info.transport}, continuity ${info.continuityChars || 0} chars, lore ${info.loreChars || 0} chars.`, 'info');
        } else {
            toast('Wandlight prompt sync function is not available.', 'error');
        }
    }));
    card.appendChild(actions);

    return card;
}

function createPromptPlacementLine(labelText, controls) {
    const row = document.createElement('div');
    row.className = 'wandlight-prompt-placement-line';

    const label = document.createElement('div');
    label.className = 'wandlight-prompt-placement-line-label';
    label.textContent = labelText;
    addTooltip(label, `${labelText} prompt placement settings.`);
    row.appendChild(label);

    const controlWrap = document.createElement('div');
    controlWrap.className = 'wandlight-prompt-placement-control-wrap';
    for (const control of controls) {
        controlWrap.appendChild(control);
    }
    row.appendChild(controlWrap);

    return row;
}

function createPlacementSelect(labelText, settingKey, value, options, tooltip, extraClass = '') {
    const label = document.createElement('label');
    label.className = `wandlight-inline-field ${extraClass}`.trim();
    const span = document.createElement('span');
    span.textContent = labelText;
    addTooltip(span, tooltip);
    const select = document.createElement('select');
    select.value = String(value);
    for (const [optionValue, optionLabel] of options) {
        const option = document.createElement('option');
        option.value = optionValue;
        option.textContent = optionLabel;
        select.appendChild(option);
    }
    select.value = String(value);
    select.addEventListener('change', () => {
        const next = getSettings();
        if (settingKey.endsWith('Position') || settingKey.endsWith('Role')) {
            next[settingKey] = Number(select.value);
        } else {
            next[settingKey] = select.value;
        }
        saveSettings(next);
        refreshPanelBody({ preserveScroll: false });
    });
    label.appendChild(span);
    label.appendChild(select);
    return label;
}

function createPlacementNumber(labelText, settingKey, value, min, max, tooltip, extraClass = '') {
    const label = document.createElement('label');
    label.className = `wandlight-inline-field ${extraClass}`.trim();
    const span = document.createElement('span');
    span.textContent = labelText;
    addTooltip(span, tooltip);
    const input = document.createElement('input');
    input.type = 'number';
    input.min = String(min);
    input.max = String(max);
    input.value = String(value);
    input.addEventListener('change', () => {
        const next = getSettings();
        next[settingKey] = Math.max(min, Math.min(max, parseInt(input.value, 10) || Number(value) || 0));
        saveSettings(next);
        refreshPanelBody({ preserveScroll: false });
    });
    label.appendChild(span);
    label.appendChild(input);
    return label;
}

function createInjectionPreviewCard(titleText, className, text, enabled, helpText) {
    const previewCard = document.createElement('div');
    previewCard.className = 'wandlight-runtime-card wandlight-injection-preview-card';
    const previewTitle = document.createElement('div');
    previewTitle.className = 'wandlight-runtime-card-title';
    previewTitle.textContent = titleText;
    addTooltip(previewTitle, helpText);
    previewCard.appendChild(previewTitle);

    const previewHelp = document.createElement('div');
    previewHelp.className = 'wandlight-runtime-help';
    previewHelp.textContent = enabled
        ? helpText
        : `${titleText} is currently disabled. This panel shows what would be injected if enabled.`;
    previewCard.appendChild(previewHelp);

    const pre = document.createElement('pre');
    pre.className = `wandlight-injection-preview ${className}`;
    pre.textContent = getInjectionDisplayText(titleText, text, enabled);
    addTooltip(pre, 'Scrollable prompt context block. This text is ephemeral and is not written into chat history.');
    previewCard.appendChild(pre);

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions';
    actions.appendChild(createButton('Refresh Injection Text', 'Rebuilds both split injection blocks from current state and settings.', () => {
        refreshInjectionPreviewOnly();
        toast('Injection text refreshed.', 'info');
    }));
    previewCard.appendChild(actions);
    return previewCard;
}

function getInjectionDisplayText(titleText, text, enabled = true) {
    const clean = String(text || '').trim();
    if (clean) return clean;
    const lower = String(titleText || '').toLowerCase();
    if (lower.includes('lore')) return enabled ? '(No lore data to inject.)' : '(Lore injection is disabled.)';
    if (lower.includes('continuity')) return enabled ? '(No continuity data to inject.)' : '(Continuity injection is disabled.)';
    return '(No data to inject.)';
}

function refreshInjectionPreviewOnly() {
    const state = getState();
    const settings = getSettings();
    const continuity = buildContinuityPreview(state, settings.continuityInjectionMode || 'direct');
    const lore = buildLorePreview(state, settings.loreInjectionMode || 'direct');
    updateCompressionTurnStatus(state, 'continuity');
    updateCompressionTurnStatus(state, 'lore');

    const continuityPre = panelRoot?.querySelector('.wandlight-continuity-injection-preview');
    if (continuityPre) {
        continuityPre.textContent = getInjectionDisplayText('Continuity Injection', continuity, settings.injectContinuity !== false && settings.injectMemo !== false);
    }

    const lorePre = panelRoot?.querySelector('.wandlight-lore-injection-preview');
    if (lorePre) {
        lorePre.textContent = getInjectionDisplayText('Lore Injection', lore, settings.injectLore !== false);
    }

    if (typeof globalThis.wandlightSyncPromptInjection === 'function') {
        globalThis.wandlightSyncPromptInjection();
    }
}

function updateCompressionTurnStatus(state, kind = 'lore') {
    if (!state) return;
    const statusKey = kind === 'continuity' ? 'continuityCompressionStatus' : 'loreCompressionStatus';
    const status = state[statusKey];
    if (!status?.lastCompressedAt) return;
    const chatLength = getChatLength();
    status.turnsSinceCompression = Math.max(0, chatLength - Number(status.lastChatLength || chatLength));
    saveState(state);
}

async function runModelCompression(kind = 'lore', btn = null) {
    const settings = getSettings();
    const providerKind = kind === 'continuity' ? 'continuity' : 'lore';
    const validation = validateLoreProviderConfiguration(providerKind);
    if (!validation.ok) {
        toast(`${kind === 'continuity' ? 'Continuity' : 'Lore'} compression blocked: ${validation.message}`, 'error');
        return null;
    }

    const originalText = btn?.textContent || '';
    if (btn) {
        btn.disabled = true;
        btn.textContent = kind === 'continuity' ? 'Compressing continuity...' : 'Compressing lore...';
    }

    try {
        const state = getState();
        const directText = kind === 'continuity'
            ? buildContinuityPreview(state, 'direct')
            : buildLorePreview(state, 'direct');

        if (!directText || !directText.trim()) {
            toast(`${kind === 'continuity' ? 'Continuity' : 'Lore'} preview is empty; nothing to compress.`, 'warning');
            return null;
        }

        const level = kind === 'continuity'
            ? Math.max(1, Math.min(5, Number(settings.continuityCompressionLevel) || 2))
            : Math.max(1, Math.min(5, Number(settings.loreCompressionLevel) || 2));

        const context = JSON.stringify({
            sceneDate: state?.loreContext?.sceneDate || state?.canon?.inUniverseDate || '',
            canonBoundary: state?.loreContext?.canonBoundary || state?.canon?.canonBoundary || '',
            branchId: state?.loreContext?.branchId || 'main',
            scene: state?.scene || {},
        }, null, 2);

        const budget = estimateTokenBudgetForCompression(directText, level);
        const compressionPrompt = buildCompressionPrompt(kind, level, context, directText, budget);
        const compressed = await sendLoreRequest(
            'You are Wandlight Compression. Output only the compressed injection block. Do not use markdown fences. Do not add commentary.',
            compressionPrompt,
            {
                providerKind,
                maxTokens: Math.max(128, Math.min(4096, budget.hardTokenLimit)),
                prefill: '',
            }
        );

        const cleaned = cleanCompressedText(compressed);
        if (!cleaned) {
            throw new Error('Compression returned empty text.');
        }

        const freshState = getState();
        const statusKey = kind === 'continuity' ? 'continuityCompressionStatus' : 'loreCompressionStatus';
        if (!freshState[statusKey]) freshState[statusKey] = {};
        freshState[statusKey] = {
            ...freshState[statusKey],
            lastCompressedAt: Date.now(),
            lastSignature: getMemoSignature(freshState, 'compressed', kind),
            lastMode: 'compressed',
            lastTokenEstimate: estimateTokens(cleaned),
            lastTargetTokenEstimate: budget.targetTokens,
            lastHardTokenLimit: budget.hardTokenLimit,
            turnsSinceCompression: 0,
            lastChatLength: getChatLength(),
            cachedText: cleaned,
            lastError: '',
        };
        saveState(freshState);
        refreshPanelBody({ preserveScroll: false });
        toast(`${kind === 'continuity' ? 'Continuity' : 'Lore'} compression updated.`);
        return cleaned;
    } catch (e) {
        const freshState = getState();
        const statusKey = kind === 'continuity' ? 'continuityCompressionStatus' : 'loreCompressionStatus';
        if (freshState[statusKey]) {
            freshState[statusKey].lastError = e?.message || String(e);
            saveState(freshState);
        }
        toast(`${kind === 'continuity' ? 'Continuity' : 'Lore'} compression failed: ${e?.message || e}`, 'error');
        refreshPanelBody({ preserveScroll: false });
        return null;
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = originalText;
        }
    }
}

function buildCompressionPrompt(kind, level, context, directText, budget = null) {
    const settings = getSettings();
    const kindLabel = kind === 'continuity' ? 'Continuity State' : 'Lore Entries';
    const computedBudget = budget || estimateTokenBudgetForCompression(directText, level);
    const templateKey = kind === 'continuity' ? 'continuityCompressionPromptTemplate' : 'loreCompressionPromptTemplate';
    const fallbackTemplate = kind === 'continuity'
        ? DEFAULT_SETTINGS.continuityCompressionPromptTemplate
        : DEFAULT_SETTINGS.loreCompressionPromptTemplate;
    const template = String(settings[templateKey] || fallbackTemplate || '');
    const vars = {
        kind: kindLabel,
        compressionLevel: String(level),
        compressionLabel: computedBudget.profile.description,
        targetTokens: String(computedBudget.targetTokens),
        hardTokenLimit: String(computedBudget.hardTokenLimit),
        storyContext: context,
        directText,
    };
    return template.replace(/{{\s*(\w+)\s*}}/g, (_, key) => Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : '');
}


function cleanCompressedText(text) {
    return String(text || '')
        .replace(/```(?:text|markdown)?\s*([\s\S]*?)```/i, '$1')
        .trim();
}

function getCompressionStatusText(state) {
    const settings = getSettings();
    const status = state?.loreCompressionStatus || {};
    if ((settings.loreInjectionMode || 'direct') !== 'compressed') {
        return 'Direct mode active; compression not used.';
    }
    const currentSignature = getMemoSignature(state, 'compressed', 'lore');
    if (status.lastSignature !== currentSignature) {
        return status.lastError ? `cached compression is stale; last error: ${status.lastError}` : 'Cached compression is missing or stale. Click Compress Lore Now.';
    }
    if (status.lastError) {
        return `last compression failed: ${status.lastError}`;
    }
    if (!status.lastCompressedAt) {
        return 'No cached model compression yet. Click Compress Lore Now.';
    }
    const when = new Date(status.lastCompressedAt).toLocaleTimeString();
    return `model-compressed ${when}; ${status.turnsSinceCompression || 0} turns since; ~${status.lastTokenEstimate || 0} tokens${status.lastTargetTokenEstimate ? ` (target ${status.lastTargetTokenEstimate})` : ''}`;
}

function getContinuityCompressionStatusText(state) {
    const settings = getSettings();
    const status = state?.continuityCompressionStatus || {};
    if ((settings.continuityInjectionMode || 'direct') !== 'compressed') {
        return 'Direct mode active; continuity compression not used.';
    }
    const currentSignature = getMemoSignature(state, 'compressed', 'continuity');
    if (status.lastSignature !== currentSignature) {
        return status.lastError ? `cached compression is stale; last error: ${status.lastError}` : 'Cached compression is missing or stale. Click Compress Continuity Now.';
    }
    if (status.lastError) {
        return `last compression failed: ${status.lastError}`;
    }
    if (!status.lastCompressedAt) {
        return 'No cached model compression yet. Click Compress Continuity Now.';
    }
    const when = new Date(status.lastCompressedAt).toLocaleTimeString();
    return `model-compressed ${when}; ${status.turnsSinceCompression || 0} turns since; ~${status.lastTokenEstimate || 0} tokens${status.lastTargetTokenEstimate ? ` (target ${status.lastTargetTokenEstimate})` : ''}`;
}

function getChatLength() {
    try {
        const ctx = SillyTavern.getContext();
        return Array.isArray(ctx?.chat) ? ctx.chat.length : 0;
    } catch (_) {
        return 0;
    }
}

function hasValidModelCompression(kind = 'lore') {
    const state = getState();
    const statusKey = kind === 'continuity' ? 'continuityCompressionStatus' : 'loreCompressionStatus';
    const status = state?.[statusKey] || {};
    const signature = getMemoSignature(state, 'compressed', kind);
    return status.lastSignature === signature && typeof status.cachedText === 'string' && status.cachedText.trim();
}

function hasAnyModelCompression(kind = 'lore') {
    const state = getState();
    const statusKey = kind === 'continuity' ? 'continuityCompressionStatus' : 'loreCompressionStatus';
    const status = state?.[statusKey] || {};
    return typeof status.cachedText === 'string' && status.cachedText.trim() && status.lastCompressedAt;
}

function hasCompressibleText(text) {
    const clean = String(text || '')
        .replace(/Direct mode active;[^\n]*/gi, '')
        .replace(/No accepted active lore entries[^\n]*/gi, '')
        .replace(/No continuity state[^\n]*/gi, '')
        .trim();
    return clean.length > 80;
}

function createInjectionModeButton(mode, label, tooltip, settings) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wandlight-mode-button';
    if ((settings.loreInjectionMode || 'direct') === mode) btn.classList.add('wandlight-mode-button-active');
    btn.textContent = label;
    addTooltip(btn, tooltip);
    btn.addEventListener('click', async () => {
        const next = getSettings();
        next.loreInjectionMode = mode;
        saveSettings(next);
        if (mode === 'compressed' && !hasAnyModelCompression('lore')) {
            const directText = buildLorePreview(getState(), 'direct');
            if (!hasCompressibleText(directText)) {
                toast('Lore compressed mode selected, but there is no accepted lore to compress yet. Generate/accept lore entries first, then use Compress Lore Now.', 'warning');
            } else {
                toast('Lore compressed mode selected. No cached compression exists yet; using direct preview until you click Compress Lore Now.', 'warning');
            }
        }
        refreshPanelBody({ preserveScroll: false });
        refreshHeader();
        toast(`Lore injection mode set to ${label}.`);
    });
    return btn;
}

function createContinuityModeButton(mode, label, tooltip, settings) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wandlight-mode-button';
    if ((settings.continuityInjectionMode || 'direct') === mode) btn.classList.add('wandlight-mode-button-active');
    btn.textContent = label;
    addTooltip(btn, tooltip);
    btn.addEventListener('click', async () => {
        const next = getSettings();
        next.continuityInjectionMode = mode;
        saveSettings(next);
        if (mode === 'compressed' && !hasAnyModelCompression('continuity')) {
            const directText = buildContinuityPreview(getState(), 'direct');
            if (!hasCompressibleText(directText)) {
                toast('Continuity compressed mode selected, but there is no continuity state to compress yet. Run Scan Continuity State first, then use Compress Continuity Now.', 'warning');
            } else {
                toast('Continuity compressed mode selected. No cached compression exists yet; using direct preview until you click Compress Continuity Now.', 'warning');
            }
        }
        refreshPanelBody({ preserveScroll: false });
        refreshHeader();
        toast(`Continuity injection mode set to ${label}.`);
    });
    return btn;
}


function createPendingLoreReviewSection(state) {
    const pendingLore = normalizeLoreMatrix(state?.pendingLoreEntries || []);
    const section = document.createElement('div');
    section.className = 'wandlight-review-section wandlight-pending-lore-section';

    if (pendingLore.length > 0) {
        const batchInfo = document.createElement('div');
        batchInfo.className = 'wandlight-runtime-help';
        batchInfo.textContent = getPendingLoreBatchLabel(state);
        section.appendChild(batchInfo);

        section.appendChild(createPendingLoreBulkControls(pendingLore, state));

        const visibleLimit = Math.max(5, Math.min(1000, Number(state?.lorePanel?.pendingReviewVisibleLimit) || 10));
        const list = document.createElement('div');
        list.className = 'wandlight-review-lore-list wandlight-pending-lore-list';
        pendingLore.slice(0, visibleLimit).forEach((entry, idx) => list.appendChild(createPendingLoreReviewCard(entry, idx, isPendingLoreSelected(state, entry))));
        section.appendChild(list);

        if (pendingLore.length > visibleLimit) {
            const more = createButton(`Show ${Math.min(25, pendingLore.length - visibleLimit)} more`, 'Renders more pending lore cards. Keeping this list paged prevents large canon batches from freezing the browser.', () => {
                const current = getState();
                current.lorePanel.pendingReviewVisibleLimit = Math.min(pendingLore.length, visibleLimit + 25);
                saveState(current);
                refreshPanelBody({ preserveScroll: true });
            });
            more.classList.add('wandlight-small-button');
            section.appendChild(more);
        }
    } else {
        section.appendChild(createEmptyMessage('No lore entries are waiting for review. Use Suggest Canon Lore or Generate Story Lore above.'));
    }

    return section;
}

// Legacy Review tab fallback and shared review-card helpers --------------------

function renderReviewTab(container, state) {
    const pendingLore = normalizeLoreMatrix(state?.pendingLoreEntries || []);
    const hasDelta = !!state?.lastDelta;

    container.appendChild(createSectionHeader(
        'Review Pending Changes',
        'Approve or dismiss model-produced changes before they enter active continuity or accepted lore.'
    ));

    const summaryCard = document.createElement('div');
    summaryCard.className = 'wandlight-runtime-card wandlight-review-summary-card';
    summaryCard.appendChild(createKeyValue('Continuity changes', hasDelta ? '1 pending' : 'none', 'Extracted state delta from the continuity scanner.'));
    summaryCard.appendChild(createKeyValue('Lore entries', `${pendingLore.length} pending`, 'Generated lore matrix entries waiting for acceptance.'));
    container.appendChild(summaryCard);

    const deltaSection = document.createElement('div');
    deltaSection.className = 'wandlight-review-section';
    const deltaTitle = document.createElement('h4');
    deltaTitle.textContent = 'Continuity Changes';
    addTooltip(deltaTitle, 'These are state changes extracted from recent roleplay: canon date, scene, knowledge, secrets, relationships, threads, and flags.');
    deltaSection.appendChild(deltaTitle);

    if (hasDelta) {
        deltaSection.appendChild(createDeltaReviewCard(state.lastDelta));
    } else {
        deltaSection.appendChild(createEmptyMessage('No extracted continuity changes are waiting for review.'));
    }
    container.appendChild(deltaSection);

    const loreSection = document.createElement('div');
    loreSection.className = 'wandlight-review-section';
    const loreTitle = document.createElement('h4');
    loreTitle.textContent = 'Pending Lore Entries';
    addTooltip(loreTitle, 'These are generated lore entries. Accepting merges them into the accepted lore matrix; dismissing removes them.');
    loreSection.appendChild(loreTitle);

    if (pendingLore.length > 0) {
        const batchInfo = document.createElement('div');
        batchInfo.className = 'wandlight-runtime-help';
        batchInfo.textContent = getPendingLoreBatchLabel(state);
        loreSection.appendChild(batchInfo);

        loreSection.appendChild(createPendingLoreBulkControls(pendingLore, state));

        const list = document.createElement('div');
        list.className = 'wandlight-review-lore-list';
        pendingLore.forEach((entry, idx) => list.appendChild(createPendingLoreReviewCard(entry, idx, isPendingLoreSelected(state, entry))));
        loreSection.appendChild(list);
    } else {
        loreSection.appendChild(createEmptyMessage('No generated lore entries are waiting for review.'));
    }
    container.appendChild(loreSection);
}

function createDeltaReviewCard(delta) {
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card wandlight-delta-review-card';

    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = delta?.summary || 'Pending continuity changes';
    addTooltip(title, 'Summary generated by the extraction pass.');
    card.appendChild(title);

    const keys = Object.keys(delta?.changes || {});
    card.appendChild(createKeyValue('Sections changed', keys.length ? keys.join(', ') : 'none', 'Top-level state sections affected by this pending delta.'));

    const pre = document.createElement('pre');
    pre.className = 'wandlight-delta-json-preview';
    pre.textContent = JSON.stringify(delta, null, 2);
    addTooltip(pre, 'Raw pending delta. This remains visible here because it is directly relevant to the review decision.');
    card.appendChild(pre);

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions';
    actions.appendChild(createButton('Apply Changes', 'Applies this pending delta to the continuity state and clears it.', () => {
        const current = getState();
        if (!current.lastDelta) {
            toast('No pending continuity changes to apply.', 'warning');
            refreshPanelBody({ preserveScroll: false });
            return;
        }
        pushStateSnapshot(current, 'Apply pending continuity changes', getSettings().maxSnapshots);
        const next = applyDelta(current, current.lastDelta);
        next.lastDelta = null;
        saveState(next);
        refreshPanelBody({ preserveScroll: false });
        refreshHeader();
        toast('Continuity changes applied.');
    }, 'wandlight-primary-button'));
    actions.appendChild(createButton('Dismiss Changes', 'Discards this pending delta without changing continuity state.', () => {
        const current = getState();
        current.lastDelta = null;
        saveState(current);
        refreshPanelBody({ preserveScroll: false });
        refreshHeader();
        toast('Continuity changes dismissed.', 'info');
    }));
    card.appendChild(actions);

    return card;
}


function createPendingLoreBulkControls(pendingLore, state) {
    const selectedIds = getPendingReviewSelectedIds(state);
    const pendingIds = pendingLore.map(getLoreReviewId);
    const selectedCount = pendingIds.filter(id => selectedIds.has(id)).length;

    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card wandlight-review-bulk-card';

    const header = document.createElement('label');
    header.className = 'wandlight-review-select-all';
    const selectAll = document.createElement('input');
    selectAll.type = 'checkbox';
    selectAll.checked = selectedCount > 0 && selectedCount === pendingIds.length;
    selectAll.indeterminate = selectedCount > 0 && selectedCount < pendingIds.length;
    addTooltip(selectAll, 'Select or clear all pending lore entries in this batch.');
    selectAll.addEventListener('change', () => {
        setPendingReviewSelection(selectAll.checked ? pendingIds : []);
        refreshPanelBody({ preserveScroll: true });
    });
    header.appendChild(selectAll);
    const label = document.createElement('span');
    label.textContent = selectedCount ? `${selectedCount} of ${pendingIds.length} selected` : `Select all ${pendingIds.length} pending entries`;
    header.appendChild(label);
    card.appendChild(header);

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions';
    actions.appendChild(createButton('Apply Selected', 'Accepts only the selected pending lore entries. Use Select All for large batches.', () => {
        applySelectedPendingLore();
    }, 'wandlight-primary-button'));
    actions.appendChild(createButton('Dismiss Selected', 'Rejects only the selected pending lore entries.', () => {
        dismissSelectedPendingLore();
    }));
    actions.appendChild(createButton('Apply All', 'Accepts every pending lore entry in the current batch.', () => {
        const current = getState();
        pushStateSnapshot(current, 'Accept pending lore entries', getSettings().maxSnapshots);
        const count = (current.pendingLoreEntries || []).length;
        acceptPendingLoreEntries();
        clearPendingReviewSelection();
        refreshPanelBody({ preserveScroll: false });
        refreshHeader();
        toast(`${count} lore entries accepted.`);
    }));
    actions.appendChild(createButton('Dismiss All', 'Rejects every pending lore entry in the current batch.', () => {
        const current = getState();
        const count = (current.pendingLoreEntries || []).length;
        rejectPendingLoreEntries();
        clearPendingReviewSelection();
        refreshPanelBody({ preserveScroll: false });
        refreshHeader();
        toast(`${count} lore entries dismissed.`, 'info');
    }));
    card.appendChild(actions);

    return card;
}

function createPendingLoreCheckbox(entry, checked) {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'wandlight-review-lore-checkbox wandlight-lore-entry-select';
    checkbox.checked = checked;
    addTooltip(checkbox, checked ? 'Remove this lore entry from the current bulk selection.' : 'Add this lore entry to the current bulk selection.');
    checkbox.addEventListener('click', e => e.stopPropagation());
    checkbox.addEventListener('change', () => {
        togglePendingReviewSelection(getLoreReviewId(entry), checkbox.checked);
        refreshPanelBody({ preserveScroll: true });
    });
    return checkbox;
}

function getLoreReviewId(entry) {
    return entry?.id || `${entry?.title || 'pending'}:${entry?.fact || ''}`;
}

function getPendingReviewSelectedIds(state = getState()) {
    return new Set(Array.isArray(state?.lorePanel?.reviewSelectedIds) ? state.lorePanel.reviewSelectedIds : []);
}

function isPendingLoreSelected(state, entry) {
    return getPendingReviewSelectedIds(state).has(getLoreReviewId(entry));
}

function setPendingReviewSelection(ids) {
    const state = getState();
    if (!state?.lorePanel) return;
    state.lorePanel.reviewSelectedIds = Array.from(new Set((ids || []).filter(Boolean)));
    saveState(state);
}

function togglePendingReviewSelection(id, selected) {
    if (!id) return;
    const current = getPendingReviewSelectedIds();
    if (selected) current.add(id);
    else current.delete(id);
    setPendingReviewSelection(Array.from(current));
}

function clearPendingReviewSelection() {
    setPendingReviewSelection([]);
}

function getSelectedPendingIndexes() {
    const state = getState();
    const selected = getPendingReviewSelectedIds(state);
    const pending = normalizeLoreMatrix(state?.pendingLoreEntries || []);
    return pending
        .map((entry, index) => ({ entry, index }))
        .filter(item => selected.has(getLoreReviewId(item.entry)))
        .map(item => item.index);
}

function applySelectedPendingLore() {
    const indexes = getSelectedPendingIndexes().sort((a, b) => b - a);
    if (!indexes.length) {
        toast('No pending lore entries selected.', 'warning');
        return;
    }
    const current = getState();
    pushStateSnapshot(current, `Accept ${indexes.length} selected lore entries`, getSettings().maxSnapshots);
    for (const idx of indexes) acceptPendingLoreEntry(idx);
    clearPendingReviewSelection();
    refreshPanelBody({ preserveScroll: true });
    refreshHeader();
    toast(`${indexes.length} selected lore entries accepted.`);
}

function dismissSelectedPendingLore() {
    const indexes = getSelectedPendingIndexes().sort((a, b) => b - a);
    if (!indexes.length) {
        toast('No pending lore entries selected.', 'warning');
        return;
    }
    for (const idx of indexes) rejectPendingLoreEntry(idx);
    clearPendingReviewSelection();
    refreshPanelBody({ preserveScroll: true });
    refreshHeader();
    toast(`${indexes.length} selected lore entries dismissed.`, 'info');
}

function createPendingLoreReviewCard(entry, index, selected = false) {
    const card = document.createElement('div');
    card.className = 'wandlight-lore-entry-card wandlight-lore-entry-pending wandlight-pending-review-entry-card';
    if (selected) card.classList.add('wandlight-review-lore-card-selected');

    const headerRow = document.createElement('div');
    headerRow.className = 'wandlight-lore-entry-header';
    headerRow.appendChild(createPendingLoreCheckbox(entry, selected));

    const titleWrap = document.createElement('div');
    titleWrap.className = 'wandlight-lore-entry-title-wrap';
    const title = document.createElement('span');
    title.className = 'wandlight-lore-entry-title';
    title.textContent = entry.title || `Pending lore ${index + 1}`;
    addTooltip(title, 'Generated lore entry title. This entry is pending until accepted.');
    titleWrap.appendChild(title);
    headerRow.appendChild(titleWrap);

    const actions = document.createElement('div');
    actions.className = 'wandlight-lore-entry-actions';
    const status = document.createElement('span');
    status.className = 'wandlight-lore-badge wandlight-lore-badge-pending';
    status.textContent = 'pending';
    addTooltip(status, 'This lore entry has not been accepted into the active lore matrix yet.');
    actions.appendChild(status);
    headerRow.appendChild(actions);
    card.appendChild(headerRow);

    const meta = document.createElement('div');
    meta.className = 'wandlight-lore-entry-meta';
    meta.appendChild(createEditableLifecycleBadge(entry));
    meta.appendChild(createEditableLoreMetaBadge(entry, 'category', entry.category || 'canon', null, `Category: ${entry.category || 'canon'}. Use dropdown to change.`));
    meta.appendChild(createEditableLoreMetaBadge(entry, 'canonStatus', entry.canonStatus || 'unknown', null, `Canon status: ${entry.canonStatus || 'unknown'}. Use dropdown to change.`));
    meta.appendChild(createEditableLoreMetaBadge(entry, 'truthStatus', entry.truthStatus || 'true', null, `Truth/reveal status: ${entry.truthStatus || 'true'}. Use dropdown to change.`));
    meta.appendChild(createEditableLoreMetaBadge(entry, 'revealPolicy', entry.revealPolicy || 'private', null, `Reveal policy: ${entry.revealPolicy || 'private'}. Use dropdown to change.`));
    meta.appendChild(createEditablePriorityBadge(entry));
    meta.appendChild(createSpellMetadataBadges(entry));
    if (entry.confidence !== undefined) meta.appendChild(createBadge(`confidence ${entry.confidence}`, 'Model-provided confidence for this entry.'));
    card.appendChild(meta);

    if (Array.isArray(entry.tags) && entry.tags.length) {
        const tags = createReadOnlyTags(entry.tags);
        tags.classList.add('wandlight-pending-readonly-tags');
        card.appendChild(tags);
    }

    const fact = document.createElement('div');
    fact.className = 'wandlight-lore-entry-fact';
    fact.textContent = entry.fact || '(No fact text)';
    addTooltip(fact, 'The fact that will be merged into the accepted lore matrix if applied.');
    card.appendChild(fact);

    const actionsRow = document.createElement('div');
    actionsRow.className = 'wandlight-primary-actions wandlight-pending-entry-actions';
    actionsRow.appendChild(createButton('Apply', 'Accepts this single lore entry and merges it into the accepted lore matrix.', () => {
        const current = getState();
        pushStateSnapshot(current, `Accept lore entry: ${entry.title || index + 1}`, getSettings().maxSnapshots);
        acceptPendingLoreEntry(index);
        togglePendingReviewSelection(getLoreReviewId(entry), false);
        refreshPanelBody({ preserveScroll: true });
        refreshHeader();
        toast('Lore entry accepted.');
    }, 'wandlight-primary-button'));
    actionsRow.appendChild(createButton('Dismiss', 'Rejects this single lore entry without changing accepted lore.', () => {
        rejectPendingLoreEntry(index);
        togglePendingReviewSelection(getLoreReviewId(entry), false);
        refreshPanelBody({ preserveScroll: true });
        refreshHeader();
        toast('Lore entry dismissed.', 'info');
    }));
    card.appendChild(actionsRow);

    return card;
}


// Accepted lore bulk selection and editing --------------------------------------

function getAcceptedSelectionSet(state = getState()) {
    const ids = Array.isArray(state?.lorePanel?.acceptedSelectedIds) ? state.lorePanel.acceptedSelectedIds : [];
    const acceptedIds = new Set(normalizeLoreMatrix(state?.loreMatrix || []).map(entry => entry.id));
    return new Set(ids.filter(id => acceptedIds.has(id)));
}

function setAcceptedLoreSelection(ids = [], options = {}) {
    const state = getState();
    if (!state.lorePanel) state.lorePanel = getDefaultState().lorePanel;
    const acceptedIds = new Set(normalizeLoreMatrix(state.loreMatrix || []).map(entry => entry.id));
    state.lorePanel.acceptedSelectedIds = Array.from(new Set((ids || []).filter(id => acceptedIds.has(id))));
    if (options.deferSave) scheduleStateSave(state);
    else saveState(state);
}

function toggleAcceptedLoreSelection(entryId, selected) {
    const state = getState();
    const selection = getAcceptedSelectionSet(state);
    if (selected) selection.add(entryId);
    else selection.delete(entryId);
    state.lorePanel.acceptedSelectedIds = Array.from(selection);
    scheduleStateSave(state);
}

function getFilteredAcceptedLoreIds(state = getState()) {
    return getFilteredLoreEntries(state).map(entry => entry.id);
}

function refreshAcceptedLoreBulkToolbar() {
    if (!panelRoot) return;
    const mount = panelRoot.querySelector('.wandlight-lore-bulk-toolbar');
    if (!mount) return;
    mount.replaceChildren(createAcceptedLoreBulkControls(getState()));
}

function createAcceptedLoreBulkControls(state) {
    const wrap = document.createElement('div');
    wrap.className = 'wandlight-lore-bulk-controls-card';

    const selected = getAcceptedSelectionSet(state);
    const filteredIds = getFilteredAcceptedLoreIds(state);
    const selectedCount = selected.size;
    const disabled = selectedCount === 0;

    const summary = document.createElement('div');
    summary.className = 'wandlight-lore-bulk-summary';
    summary.textContent = `${selectedCount} selected · ${filteredIds.length} matching current filters`;
    addTooltip(summary, 'Bulk actions apply to selected accepted lore entries. Use Select Filtered to select every accepted entry matching the current search and filters, not just the rendered page.');
    wrap.appendChild(summary);

    const selectRow = document.createElement('div');
    selectRow.className = 'wandlight-lore-bulk-row';
    const selectFiltered = createButton('Select Filtered', 'Selects every accepted lore entry matching the current search and filters, including entries not currently rendered by paging.', () => {
        setAcceptedLoreSelection(filteredIds, { deferSave: true });
        refreshAcceptedLoreList({ preserveScroll: true });
        refreshAcceptedLoreBulkToolbar();
    }, 'wandlight-small-button');
    selectRow.appendChild(selectFiltered);

    const clearSelection = createButton('Clear Selection', 'Clears the accepted-lore selection.', () => {
        setAcceptedLoreSelection([], { deferSave: true });
        refreshAcceptedLoreList({ preserveScroll: true });
        refreshAcceptedLoreBulkToolbar();
    }, 'wandlight-small-button');
    clearSelection.disabled = disabled;
    selectRow.appendChild(clearSelection);
    wrap.appendChild(selectRow);

    const actionRow = document.createElement('div');
    actionRow.className = 'wandlight-lore-bulk-row';

    const addAction = (label, tooltip, fn, className = 'wandlight-small-button', detail = '') => {
        const btn = createButton(label, tooltip, async () => {
            const ids = Array.from(getAcceptedSelectionSet(getState()));
            if (!ids.length) {
                toast('Select one or more accepted lore entries first.', 'warning');
                return;
            }
            const proceed = await confirmBulkAcceptedAction(label, ids, detail || tooltip);
            if (!proceed) return;
            await fn(ids);
        }, className);
        btn.disabled = disabled;
        actionRow.appendChild(btn);
        return btn;
    };

    addAction('Pin', 'Pins selected accepted lore entries so they are prioritized for injection.', ids => bulkSetAcceptedPinned(ids, true), 'wandlight-small-button', 'Selected entries will be pinned and prioritized for lore injection.');
    addAction('Unpin', 'Removes selected accepted lore entries from pinned lore.', ids => bulkSetAcceptedPinned(ids, false), 'wandlight-small-button', 'Selected entries will no longer be pinned. They may still inject if unmuted and active.');
    addAction('Mute', 'Mutes selected accepted lore entries so they are excluded from injection.', ids => bulkSetAcceptedMuted(ids, true), 'wandlight-small-button', 'Selected entries will be muted and excluded from injection.');
    addAction('Unmute', 'Unmutes selected accepted lore entries.', ids => bulkSetAcceptedMuted(ids, false), 'wandlight-small-button', 'Selected entries will be unmuted and may be injected again.');
    addAction('Delete', 'Deletes selected accepted lore entries from this chat after confirmation.', ids => bulkDeleteAcceptedLore(ids), 'wandlight-small-button wandlight-danger-button', 'Selected entries will be permanently removed from accepted lore for this chat. This cannot be undone unless you use State History.');
    wrap.appendChild(actionRow);

    const editRow = document.createElement('div');
    editRow.className = 'wandlight-lore-bulk-row wandlight-lore-bulk-edit-row';
    const selectedIdsNow = () => Array.from(getAcceptedSelectionSet(getState()));
    editRow.appendChild(createBulkSelect('State', LORE_LIFECYCLE_STATUSES, 'Set lifecycle state for selected entries.', async value => {
        const ids = selectedIdsNow();
        if (!(await confirmBulkAcceptedAction('Set State', ids, `Selected entries will have lifecycle state set to ${value}.`))) return;
        bulkUpdateAcceptedLore(ids, raw => ({
            ...raw,
            lifecycle: {
                ...(raw.lifecycle || {}),
                status: value,
                manualOverride: true,
                reason: 'Bulk lifecycle override.',
            },
        }));
    }, disabled));
    editRow.appendChild(createBulkSelect('Category', getLoreRegistryValues('categories', Object.keys(CATEGORY_LABELS)), 'Set category for selected entries.', async value => {
        const ids = selectedIdsNow();
        if (!(await confirmBulkAcceptedAction('Set Category', ids, `Selected entries will have category set to ${value}.`))) return;
        bulkUpdateAcceptedLore(ids, raw => ({ ...raw, category: value }));
    }, disabled));
    editRow.appendChild(createBulkSelect('Canon', getLoreRegistryValues('canonStatuses', ['canon', 'divergent', 'au', 'fanon', 'contested', 'unknown']), 'Set canon status for selected entries.', async value => {
        const ids = selectedIdsNow();
        if (!(await confirmBulkAcceptedAction('Set Canon Status', ids, `Selected entries will have canon status set to ${value}.`))) return;
        bulkUpdateAcceptedLore(ids, raw => ({ ...raw, canonStatus: value }));
    }, disabled));
    editRow.appendChild(createBulkSelect('Truth', getLoreRegistryValues('truthStatuses', ['true', 'false', 'public_belief', 'rumor', 'contested', 'hidden']), 'Set truth status for selected entries.', async value => {
        const ids = selectedIdsNow();
        if (!(await confirmBulkAcceptedAction('Set Truth Status', ids, `Selected entries will have truth status set to ${value}.`))) return;
        bulkUpdateAcceptedLore(ids, raw => ({ ...raw, truthStatus: value }));
    }, disabled));
    editRow.appendChild(createBulkSelect('Reveal', getLoreRegistryValues('revealPolicies', ['public', 'private', 'do_not_reveal', 'only_if_knower_present', 'only_if_user_reveals']), 'Set reveal policy for selected entries.', async value => {
        const ids = selectedIdsNow();
        if (!(await confirmBulkAcceptedAction('Set Reveal Policy', ids, `Selected entries will have reveal policy set to ${value}.`))) return;
        bulkUpdateAcceptedLore(ids, raw => ({ ...raw, revealPolicy: value }));
    }, disabled));
    editRow.appendChild(createBulkSelect('Priority', LORE_PRIORITY_VALUES.map(String), 'Set priority for selected entries.', async value => {
        const ids = selectedIdsNow();
        if (!(await confirmBulkAcceptedAction('Set Priority', ids, `Selected entries will have priority set to P${value}.`))) return;
        bulkUpdateAcceptedLore(ids, raw => ({ ...raw, priority: Number(value) || 50 }));
    }, disabled, value => `P${value}`));
    wrap.appendChild(editRow);

    const tagRow = document.createElement('div');
    tagRow.className = 'wandlight-lore-bulk-row wandlight-lore-bulk-tag-row';
    const tagInput = document.createElement('input');
    tagInput.type = 'text';
    tagInput.className = 'wandlight-lore-bulk-tag-input';
    tagInput.placeholder = 'Add tag to selected...';
    tagInput.disabled = disabled;
    addTooltip(tagInput, 'Adds one searchable tag to all selected accepted lore entries.');
    tagInput.addEventListener('click', e => e.stopPropagation());
    tagRow.appendChild(tagInput);
    const addTagBtn = createButton('Add Tag', 'Adds the typed tag to selected entries.', () => {
        const ids = Array.from(getAcceptedSelectionSet(getState()));
        const tag = normalizeTag(tagInput.value);
        if (!ids.length || !tag) {
            toast(ids.length ? 'Enter a tag first.' : 'Select entries first.', 'warning');
            return;
        }
        confirmBulkAcceptedAction('Add Tag', ids, `The tag "${tag}" will be added to selected accepted lore entries.`).then(proceed => {
            if (!proceed) return;
            bulkAddTagToAcceptedLore(ids, tag);
            tagInput.value = '';
        });
    }, 'wandlight-small-button');
    addTagBtn.disabled = disabled;
    tagRow.appendChild(addTagBtn);
    wrap.appendChild(tagRow);

    return wrap;
}

async function confirmBulkAcceptedAction(actionLabel, ids, detail = '') {
    const safeIds = Array.isArray(ids) ? ids : [];
    if (!safeIds.length) {
        toast('Select one or more accepted lore entries first.', 'warning');
        return false;
    }
    const state = getState();
    const byId = new Map(normalizeLoreMatrix(state?.loreMatrix || []).map(entry => [entry.id, entry]));
    const names = safeIds
        .map(id => byId.get(id)?.title || id)
        .filter(Boolean)
        .slice(0, 6);
    const extra = safeIds.length > names.length ? `\n…and ${safeIds.length - names.length} more.` : '';
    const message = [
        `You are about to perform this bulk action on ${safeIds.length} accepted lore entr${safeIds.length === 1 ? 'y' : 'ies'}:`,
        '',
        actionLabel,
        detail ? `\n${detail}` : '',
        names.length ? `\nSelected entries:\n- ${names.join('\n- ')}${extra}` : '',
        '',
        'Continue?'
    ].join('\n');
    return await confirmAction(`Confirm bulk lore action: ${actionLabel}`, message);
}

function createBulkSelect(label, values, tooltip, onChange, disabled = false, display = null) {
    const select = document.createElement('select');
    select.className = 'wandlight-lore-bulk-select';
    select.disabled = disabled;
    addTooltip(select, tooltip);
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = `Set ${label}...`;
    placeholder.selected = true;
    select.appendChild(placeholder);
    for (const value of values) {
        const option = document.createElement('option');
        option.value = String(value);
        option.textContent = display ? display(value) : getLoreDisplayLabel(labelToField(label), value);
        select.appendChild(option);
    }
    select.addEventListener('click', e => e.stopPropagation());
    select.addEventListener('change', async () => {
        if (!select.value) return;
        const value = select.value;
        select.value = '';
        await onChange(value);
    });
    return select;
}

function labelToField(label) {
    if (label === 'Category') return 'category';
    if (label === 'Canon') return 'canonStatus';
    if (label === 'Truth') return 'truthStatus';
    if (label === 'Reveal') return 'revealPolicy';
    return 'category';
}

function bulkUpdateAcceptedLore(ids, updater) {
    if (!ids?.length || typeof updater !== 'function') return false;
    const state = getState();
    const idSet = new Set(ids);
    let count = 0;
    state.loreMatrix = normalizeLoreMatrix(state.loreMatrix || []).map(entry => {
        if (!idSet.has(entry.id)) return entry;
        count += 1;
        return normalizeLoreEntry({ ...updater(entry), userEdited: true });
    });
    saveState(state);
    refreshAcceptedLoreList({ preserveScroll: true });
    refreshAcceptedLoreBulkToolbar();
    refreshHeader();
    if (count) toast(`Updated ${count} accepted lore entr${count === 1 ? 'y' : 'ies'}.`, 'success');
    return count > 0;
}

function bulkSetAcceptedPinned(ids, pinned) {
    const state = getState();
    if (!state.loreSelection) state.loreSelection = { pinnedIds: [], suppressedIds: [] };
    const idSet = new Set(ids);
    const acceptedIds = new Set(normalizeLoreMatrix(state.loreMatrix || []).map(entry => entry.id));
    const pinSet = new Set((state.loreSelection.pinnedIds || []).filter(id => acceptedIds.has(id)));
    const suppressedSet = new Set((state.loreSelection.suppressedIds || []).filter(id => acceptedIds.has(id)));
    for (const id of idSet) {
        if (!acceptedIds.has(id)) continue;
        if (pinned) {
            pinSet.add(id);
            suppressedSet.delete(id);
        } else {
            pinSet.delete(id);
        }
    }
    state.loreSelection.pinnedIds = Array.from(pinSet);
    state.loreSelection.suppressedIds = Array.from(suppressedSet);
    saveState(state);
    refreshAcceptedLoreList({ preserveScroll: true });
    refreshAcceptedLoreBulkToolbar();
    refreshHeader();
    toast(`${pinned ? 'Pinned' : 'Unpinned'} ${idSet.size} accepted lore entr${idSet.size === 1 ? 'y' : 'ies'}.`, 'success');
}

function bulkSetAcceptedMuted(ids, muted) {
    const state = getState();
    if (!state.loreSelection) state.loreSelection = { pinnedIds: [], suppressedIds: [] };
    const idSet = new Set(ids);
    const acceptedIds = new Set(normalizeLoreMatrix(state.loreMatrix || []).map(entry => entry.id));
    const pinSet = new Set((state.loreSelection.pinnedIds || []).filter(id => acceptedIds.has(id)));
    const suppressedSet = new Set((state.loreSelection.suppressedIds || []).filter(id => acceptedIds.has(id)));
    for (const id of idSet) {
        if (!acceptedIds.has(id)) continue;
        if (muted) {
            suppressedSet.add(id);
            pinSet.delete(id);
        } else {
            suppressedSet.delete(id);
        }
    }
    state.loreSelection.pinnedIds = Array.from(pinSet);
    state.loreSelection.suppressedIds = Array.from(suppressedSet);
    saveState(state);
    refreshAcceptedLoreList({ preserveScroll: true });
    refreshAcceptedLoreBulkToolbar();
    refreshHeader();
    toast(`${muted ? 'Muted' : 'Unmuted'} ${idSet.size} accepted lore entr${idSet.size === 1 ? 'y' : 'ies'}.`, 'success');
}

function bulkAddTagToAcceptedLore(ids, tag) {
    const clean = normalizeTag(tag);
    if (!clean) return false;
    return bulkUpdateAcceptedLore(ids, entry => {
        const tags = Array.isArray(entry.tags) ? entry.tags.map(normalizeTag).filter(Boolean) : [];
        const exists = tags.some(t => t.toLowerCase() === clean.toLowerCase());
        return { ...entry, tags: exists ? tags : [...tags, clean] };
    });
}

function bulkDeleteAcceptedLore(ids) {
    const state = getState();
    const idSet = new Set(ids);
    const before = Array.isArray(state.loreMatrix) ? state.loreMatrix.length : 0;
    state.loreMatrix = normalizeLoreMatrix(state.loreMatrix || []).filter(entry => !idSet.has(entry.id));
    const acceptedIds = new Set(state.loreMatrix.map(entry => entry.id));
    if (state.loreSelection) {
        state.loreSelection.pinnedIds = (state.loreSelection.pinnedIds || []).filter(id => acceptedIds.has(id));
        state.loreSelection.suppressedIds = (state.loreSelection.suppressedIds || []).filter(id => acceptedIds.has(id));
    }
    if (state.lorePanel) {
        state.lorePanel.acceptedSelectedIds = (state.lorePanel.acceptedSelectedIds || []).filter(id => acceptedIds.has(id));
        if (idSet.has(state.lorePanel.selectedEntryId)) state.lorePanel.selectedEntryId = '';
    }
    saveState(state);
    refreshAcceptedLoreList({ preserveScroll: true });
    refreshAcceptedLoreBulkToolbar();
    refreshHeader();
    toast(`Deleted ${before - state.loreMatrix.length} accepted lore entr${before - state.loreMatrix.length === 1 ? 'y' : 'ies'}.`, 'success');
}

function createEditableLoreEntryEditor(entry) {
    const editor = document.createElement('div');
    editor.className = 'wandlight-lore-entry-editor';
    addTooltip(editor, 'Edit accepted lore directly. Changes are saved only when you click Save Entry.');

    const makeField = (labelText, value, multiline = false) => {
        const label = document.createElement('label');
        label.className = 'wandlight-lore-editor-field';
        const span = document.createElement('span');
        span.textContent = labelText;
        label.appendChild(span);
        const input = multiline ? document.createElement('textarea') : document.createElement('input');
        input.className = multiline ? 'wandlight-lore-editor-textarea' : 'wandlight-lore-editor-input';
        if (!multiline) input.type = 'text';
        input.value = value || '';
        input.addEventListener('click', e => e.stopPropagation());
        input.addEventListener('mousedown', e => e.stopPropagation());
        label.appendChild(input);
        editor.appendChild(label);
        return input;
    };

    const titleInput = makeField('Title', entry.title || '', false);
    const factInput = makeField('Lore text / fact', entry.fact || entry.content?.fact || '', true);
    const injectionInput = makeField('Injection override', entry.content?.injection || '', true);
    const notesInput = makeField('Notes', entry.notes || entry.content?.notes || '', true);

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions';
    const saveBtn = createButton('Save Entry', 'Saves the edited title, lore text, injection override, and notes for this accepted lore entry.', (btn, e) => {
        e?.stopPropagation?.();
        const title = titleInput.value.trim() || entry.title || '(Untitled lore)';
        const fact = factInput.value.trim();
        const injection = injectionInput.value.trim();
        const notes = notesInput.value.trim();
        updateLoreEntryById(entry.id, raw => ({
            ...raw,
            title,
            fact,
            notes,
            content: {
                ...(raw.content || {}),
                fact,
                injection,
                notes,
            },
            userEdited: true,
        }), { deferSave: false });
        if (!refreshAcceptedLoreRow(entry.id)) refreshAcceptedLoreList({ preserveScroll: true });
        refreshHeader();
        toast('Lore entry saved.', 'success');
    }, 'wandlight-primary-button');
    actions.appendChild(saveBtn);
    editor.appendChild(actions);
    return editor;
}

// Lore tab --------------------------------------------------------------------

function renderLoreTab(container, state) {
    container.appendChild(createSectionHeader(
        'Lore',
        'Suggest canon lore from the local database, generate story/AU lore with the model, review pending entries, and manage accepted lore.'
    ));
    container.appendChild(createCollapsibleSection(
        'lore.generation',
        'Lore Generation',
        'canon suggestions + story generation',
        true,
        createLoreGenerationCard(state),
        { tooltip: 'Suggest canon lore from the local database or generate story/AU lore from recent chat messages.', className: 'wandlight-lore-generation-collapsible' }
    ));

    const pendingCount = (state?.pendingLoreEntries || []).length;
    container.appendChild(createCollapsibleSection(
        'lore.pendingReview',
        'Pending Lore Review',
        pendingCount ? `${pendingCount} pending` : 'none',
        pendingCount > 0,
        createPendingLoreReviewSection(state),
        { tooltip: 'Review suggested/generated lore entries before accepting them.', className: 'wandlight-lore-pending-collapsible' }
    ));

    const loreState = getPanelLoreState(state);
    const acceptedCount = Math.max(0, (loreState.counts?.all || 0) - (loreState.counts?.pending || 0));
    const injectableCount = getSelectedLoreInjectionCount(state, getSettings());
    container.appendChild(createCollapsibleSection(
        'lore.acceptedEntries',
        'Accepted Lore Entries',
        `${acceptedCount} accepted · ${injectableCount} injectable`,
        true,
        createAcceptedLoreEntriesSection(state),
        { tooltip: 'Search, filter, bulk edit, tag, pin, mute, and edit accepted lore entries.', className: 'wandlight-lore-accepted-collapsible' }
    ));
}

function createAcceptedLoreEntriesSection(state) {
    const section = document.createElement('div');
    section.className = 'wandlight-accepted-lore-section';

    const controls = document.createElement('div');
    controls.className = 'wandlight-lore-controls';

    const panelState = state?.lorePanel || { selectedCategory: 'all', search: '' };
    const loreState = getPanelLoreState(state);
    const { entries, categories, counts } = loreState;

    const tabs = document.createElement('div');
    tabs.className = 'wandlight-lore-tabs';
    for (const cat of categories) {
        const tab = document.createElement('button');
        tab.className = 'wandlight-lore-tab';
        if (cat === panelState.selectedCategory) tab.classList.add('wandlight-lore-tab-active');
        tab.type = 'button';
        const label = getLoreDisplayLabel('category', cat);
        const catCount = getCategoryCount(cat, entries, counts);
        tab.textContent = `${label} (${catCount})`;
        addTooltip(tab, getCategoryTooltip(cat));
        tab.addEventListener('click', () => {
            setPanelState({ selectedCategory: cat, acceptedLoreVisibleLimit: ACCEPTED_LORE_INITIAL_VISIBLE_LIMIT });
            refreshPanelBody({ preserveScroll: false });
        });
        tabs.appendChild(tab);
    }
    controls.appendChild(tabs);

    const filterRow = document.createElement('div');
    filterRow.className = 'wandlight-lore-filter-row';

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'wandlight-lore-search';
    searchInput.placeholder = 'Search titles and tags...';
    searchInput.value = panelState.search || '';
    addTooltip(searchInput, 'Searches lore entry titles and tags first. Fact text, notes, and IDs are searched as fallback.');
    searchInput.addEventListener('input', (e) => {
        setPanelState({ search: e.target.value, acceptedLoreVisibleLimit: ACCEPTED_LORE_INITIAL_VISIBLE_LIMIT }, { deferSave: true });
        scheduleAcceptedLoreListRender(section);
    });
    filterRow.appendChild(searchInput);

    const sourceSelect = document.createElement('select');
    sourceSelect.className = 'wandlight-lore-source-filter';
    addTooltip(sourceSelect, 'Filter accepted lore by origin: canon database, story generation, or manual/user-created entries.');
    const sourceOptions = [
        ['all', 'Source: All'],
        ['canon-db', 'Canon Database'],
        ['story-generation', 'Story Generation'],
        ['manual', 'Manual / User'],
    ];
    for (const [value, label] of sourceOptions) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        if ((panelState.sourceFilter || 'all') === value) opt.selected = true;
        sourceSelect.appendChild(opt);
    }
    sourceSelect.addEventListener('change', () => {
        setPanelState({ sourceFilter: sourceSelect.value, acceptedLoreVisibleLimit: ACCEPTED_LORE_INITIAL_VISIBLE_LIMIT });
        refreshPanelBody({ preserveScroll: false });
    });
    filterRow.appendChild(sourceSelect);
    controls.appendChild(filterRow);

    const pinHelp = document.createElement('div');
    pinHelp.className = 'wandlight-runtime-help wandlight-pin-help';
    pinHelp.textContent = 'Pinned = prioritized and protected from aggressive compression. Muted = excluded from injection. Lifecycle state controls whether an entry is eligible for injection.';
    addTooltip(pinHelp, 'Pin important facts you always want kept prominent. Mute facts that should stay stored but not be sent to the model.');
    controls.appendChild(pinHelp);

    const bulkMount = document.createElement('div');
    bulkMount.className = 'wandlight-lore-bulk-toolbar';
    bulkMount.appendChild(createAcceptedLoreBulkControls(state));
    controls.appendChild(bulkMount);

    section.appendChild(controls);

    const list = document.createElement('div');
    list.className = 'wandlight-lore-entry-list';
    renderEntryList(list, state);
    section.appendChild(list);
    return section;
}

function renderEntryList(list, state) {
    if (!list) return;
    list.replaceChildren();

    const filtered = getFilteredLoreEntries(state);
    if (filtered.length === 0) {
        list.appendChild(createEmptyMessage('No lore entries match the current filter.'));
        return;
    }

    const panelState = state?.lorePanel || {};
    const visibleLimit = Math.max(10, Math.min(
        filtered.length,
        Number(panelState.acceptedLoreVisibleLimit) || ACCEPTED_LORE_INITIAL_VISIBLE_LIMIT
    ));
    const visible = filtered.slice(0, visibleLimit);
    const fragment = document.createDocumentFragment();

    const summary = document.createElement('div');
    summary.className = 'wandlight-lore-list-summary';
    summary.textContent = filtered.length > visible.length
        ? `Showing ${visible.length} of ${filtered.length} accepted lore entries.`
        : `Showing ${filtered.length} accepted lore entr${filtered.length === 1 ? 'y' : 'ies'}.`;
    fragment.appendChild(summary);

    for (const entry of visible) {
        fragment.appendChild(createEntryCard(entry, state));
    }

    if (filtered.length > visible.length) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'wandlight-secondary-button wandlight-lore-show-more';
        const nextCount = Math.min(ACCEPTED_LORE_PAGE_INCREMENT, filtered.length - visible.length);
        more.textContent = `Show ${nextCount} more`;
        addTooltip(more, 'Renders more accepted lore entries. Keeping the list paged prevents large lore matrices from slowing the browser.');
        more.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            setPanelState({ acceptedLoreVisibleLimit: visible.length + ACCEPTED_LORE_PAGE_INCREMENT }, { deferSave: true });
            refreshAcceptedLoreList({ preserveScroll: true });
            refreshAcceptedLoreBulkToolbar();
        });
        fragment.appendChild(more);
    }

    list.appendChild(fragment);
}

function scheduleAcceptedLoreListRender(container) {
    if (searchRenderTimer) clearTimeout(searchRenderTimer);
    searchRenderTimer = setTimeout(() => {
        const root = container || panelRoot;
        const list = root?.querySelector?.('.wandlight-lore-entry-list');
        if (list) renderEntryList(list, getState());
        refreshAcceptedLoreBulkToolbar();
    }, SEARCH_RENDER_DEBOUNCE_MS);
}

function refreshAcceptedLoreList(options = {}) {
    if (!panelRoot) return;
    const list = panelRoot.querySelector('.wandlight-lore-entry-list');
    if (!list) return;
    const scrollTop = options.preserveScroll ? list.scrollTop : 0;
    renderEntryList(list, getState());
    if (options.preserveScroll) list.scrollTop = scrollTop;
}

function refreshAcceptedLoreRow(entryId) {
    if (!panelRoot || !entryId) return false;
    const list = panelRoot.querySelector('.wandlight-lore-entry-list');
    const existing = list?.querySelector?.(`[data-entry-id="${cssEscape(entryId)}"]`);
    if (!existing) return false;
    const state = getState();
    const entry = getFilteredLoreEntries(state).find(item => item.id === entryId);
    if (!entry) {
        existing.remove();
        return true;
    }
    existing.replaceWith(createEntryCard(entry, state));
    return true;
}

function cssEscape(value) {
    if (window.CSS?.escape) return window.CSS.escape(String(value));
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function getFilteredLoreEntries(state) {
    const panelState = state?.lorePanel || {
        selectedCategory: 'all',
        search: '',
        selectedEntryId: '',
    };

    const { entries } = getPanelLoreState(state);
    let filtered = entries.filter(entry => !entry.isPending);

    if (panelState.selectedCategory === 'pending') {
        filtered = [];
    } else if (panelState.selectedCategory === 'active') {
        filtered = filtered.filter(e => e.isActive || e.isPinned);
    } else if (panelState.selectedCategory === 'pinned') {
        filtered = filtered.filter(e => e.isPinned);
    } else if (panelState.selectedCategory === 'suppressed') {
        filtered = filtered.filter(e => e.isSuppressed);
    } else if (['expired', 'blocked', 'future', 'canon_overdue', 'divergent'].includes(panelState.selectedCategory)) {
        filtered = filtered.filter(e => (e.lifecycleStatus || e.lifecycle?.status || 'active') === panelState.selectedCategory);
    } else if (panelState.selectedCategory && panelState.selectedCategory !== 'all') {
        filtered = filtered.filter(e => e.category === panelState.selectedCategory);
    }

    const sourceFilter = panelState.sourceFilter || 'all';
    if (sourceFilter && sourceFilter !== 'all') {
        filtered = filtered.filter(entry => getLoreSourceBucket(entry) === sourceFilter);
    }

    filtered = [...filtered].sort(sortLoreEntriesForPanel);

    const query = String(panelState.search || '').trim().toLowerCase();
    if (!query) return filtered;

    return filtered
        .map(entry => ({ entry, score: scoreSearchEntry(entry, query) }))
        .filter(item => item.score > 0)
        .sort((a, b) =>
            b.score - a.score
            || Number(b.entry.priority || 50) - Number(a.entry.priority || 50)
            || String(a.entry.title || '').localeCompare(String(b.entry.title || ''))
        )
        .map(item => item.entry);
}


function getLoreSourceBucket(entry) {
    const source = String(entry?.source || entry?.sourceInfo?.id || '').toLowerCase();
    const id = String(entry?.id || '').toLowerCase();
    const userEdited = !!entry?.userEdited;
    if (source.includes('canon-lore-db') || source.includes('canon database') || id.startsWith('canon_db_') || id.includes('_canon_')) return 'canon-db';
    if (source.includes('model-generated') || source.includes('story') || source.includes('lore-generator')) return 'story-generation';
    if (userEdited || source === 'user' || source === 'manual') return 'manual';
    return 'story-generation';
}

function sortLoreEntriesForPanel(a, b) {
    const pinScore = Number(!!b.isPinned) - Number(!!a.isPinned);
    if (pinScore) return pinScore;
    const pendingScore = Number(!!b.isPending) - Number(!!a.isPending);
    if (pendingScore) return pendingScore;
    const categoryScore = getLoreCategoryRank(a.category) - getLoreCategoryRank(b.category);
    if (categoryScore) return categoryScore;
    const priorityScore = Number(b.priority || 50) - Number(a.priority || 50);
    if (priorityScore) return priorityScore;
    const scopeScore = getLoreScopeSpecificity(b) - getLoreScopeSpecificity(a);
    if (scopeScore) return scopeScore;
    return String(a.title || '').localeCompare(String(b.title || ''));
}

function getLoreCategoryRank(category) {
    const order = ['event', 'timeline', 'character', 'relationship', 'place', 'location', 'faction', 'knowledge', 'secret', 'item', 'artifact', 'spell', 'rule', 'canon', 'au', 'rumor', 'lie'];
    const idx = order.indexOf(category || '');
    return idx >= 0 ? idx : 99;
}


const LIFECYCLE_META = {
    active: { label: 'Active', color: '#166534', textColor: '#dcfce7', tooltip: 'Injectable now.' },
    canon_overdue: { label: 'Canon Overdue', color: '#a16207', textColor: '#fef3c7', tooltip: 'Canon timing suggests this should have resolved, but the story milestone has not happened. Still injectable if it is a guard.' },
    blocked: { label: 'Blocked', color: '#92400e', textColor: '#ffedd5', tooltip: 'Not injected because required story conditions are missing.' },
    future: { label: 'Future', color: '#1e3a8a', textColor: '#dbeafe', tooltip: 'Not injected yet.' },
    expired: { label: 'Expired', color: '#4b5563', textColor: '#f9fafb', tooltip: 'Expired by story milestone or hard date. Not injected unless manually overridden.' },
    divergent: { label: 'Divergent', color: '#7c2d12', textColor: '#ffedd5', tooltip: 'Conflicts with current branch or canon status. Not injected by default.' },
    muted: { label: 'Muted', color: '#374151', textColor: '#f3f4f6', tooltip: 'Muted by user.' },
    archived: { label: 'Archived', color: '#111827', textColor: '#e5e7eb', tooltip: 'Archived or disabled.' },
};

function getLifecycleStatus(entry) {
    return entry.lifecycleStatus || entry.lifecycle?.status || entry.lifecycle?.computedStatus || 'active';
}

function createEditableLifecycleBadge(entry) {
    const value = getLifecycleStatus(entry);
    const meta = LIFECYCLE_META[value] || LIFECYCLE_META.active;
    const wrap = document.createElement('label');
    wrap.className = 'wandlight-lore-lifecycle-select-wrap';
    wrap.style.setProperty('--wandlight-chip-bg', meta.color);
    wrap.style.setProperty('--wandlight-chip-fg', meta.textColor);
    addTooltip(wrap, `${meta.label}: ${entry.lifecycle?.reason || meta.tooltip} Use the dropdown to override this computed state.`);

    const select = document.createElement('select');
    select.className = 'wandlight-lore-lifecycle-select';
    select.setAttribute('aria-label', 'Lore lifecycle status');
    select.addEventListener('click', e => e.stopPropagation());
    select.addEventListener('mousedown', e => e.stopPropagation());

    for (const status of LORE_LIFECYCLE_STATUSES) {
        const option = document.createElement('option');
        option.value = status;
        option.textContent = LIFECYCLE_META[status]?.label || status;
        if (status === value) option.selected = true;
        select.appendChild(option);
    }

    select.addEventListener('change', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const nextStatus = select.value;
        updateLoreEntryById(entry.id, raw => ({
            ...raw,
            lifecycle: {
                ...(raw.lifecycle || {}),
                status: nextStatus,
                manualOverride: true,
                reason: `Manually set to ${nextStatus}.`,
                lastEvaluatedAt: Date.now(),
            },
        }), { deferSave: true });
        if (!refreshAcceptedLoreRow(entry.id)) refreshAcceptedLoreList({ preserveScroll: true });
        refreshAcceptedLoreBulkToolbar();
        refreshHeader();
        toast(`${entry.title || 'Lore entry'} status set to ${LIFECYCLE_META[nextStatus]?.label || nextStatus}.`, 'info');
    });

    wrap.appendChild(select);
    return wrap;
}

function createRegistryBadge(field, value, tooltip = '') {
    const label = getLoreDisplayLabel(field, value);
    const badge = createBadge(label, tooltip || `${field}: ${label}. Expand the entry to edit.`);
    badge.classList.add('wandlight-lore-registry-badge');
    applyLoreRegistryStyle(badge, field, value);
    return badge;
}

function createEditableLoreMetaBadge(entry, field, value, values = null, tooltip = '') {
    const fallbackValues = {
        category: ['canon', 'au', 'secret', 'relationship', 'timeline', 'character', 'event', 'item', 'knowledge', 'place', 'faction', 'spell', 'artifact', 'behavior', 'skill', 'age', 'future_guard', 'constraint'],
        canonStatus: ['canon', 'divergent', 'au', 'fanon', 'contested', 'unknown'],
        truthStatus: ['true', 'false', 'public_belief', 'rumor', 'contested', 'hidden'],
        revealPolicy: ['public', 'private', 'do_not_reveal', 'only_if_knower_present', 'only_if_user_reveals'],
    };
    const registryName = getLoreFieldRegistry(field);
    const effectiveValues = Array.from(new Set((Array.isArray(values) && values.length
        ? values
        : getLoreRegistryValues(registryName, fallbackValues[field] || [])
    ).map(v => String(v || '').trim()).filter(Boolean)));

    const currentValue = String(value || effectiveValues[0] || '').trim();
    const currentLabel = getLoreDisplayLabel(field, currentValue);
    const meta = registryName ? getLoreRegistryMeta(registryName, currentValue) : null;
    const help = tooltip || meta?.description || `${field}: ${currentLabel}. Choose a new value from the dropdown.`;

    const wrap = document.createElement('label');
    wrap.className = 'wandlight-lore-meta-select-wrap';
    applyLoreRegistryStyle(wrap, field, currentValue);
    addTooltip(wrap, help);

    const prefix = document.createElement('span');
    prefix.className = 'wandlight-lore-meta-select-prefix';
    prefix.textContent = field === 'canonStatus'
        ? 'Canon'
        : field === 'truthStatus'
            ? 'Truth'
            : field === 'revealPolicy'
                ? 'Reveal'
                : 'Category';
    wrap.appendChild(prefix);

    const select = document.createElement('select');
    select.className = 'wandlight-lore-meta-select';
    select.setAttribute('aria-label', `${prefix.textContent} metadata`);
    select.addEventListener('click', e => e.stopPropagation());
    select.addEventListener('mousedown', e => e.stopPropagation());

    for (const optionValue of effectiveValues) {
        const option = document.createElement('option');
        option.value = optionValue;
        option.textContent = getLoreDisplayLabel(field, optionValue);
        if (optionValue === currentValue) option.selected = true;
        select.appendChild(option);
    }

    // Preserve custom values even if they are not currently in the registry.
    if (currentValue && !effectiveValues.includes(currentValue)) {
        const option = document.createElement('option');
        option.value = currentValue;
        option.textContent = getLoreDisplayLabel(field, currentValue);
        option.selected = true;
        select.insertBefore(option, select.firstChild);
    }

    select.addEventListener('change', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const nextValue = select.value;
        updateLoreEntryById(entry.id, raw => ({ ...raw, [field]: nextValue }), { deferSave: true });
        if (!refreshAcceptedLoreRow(entry.id)) refreshAcceptedLoreList({ preserveScroll: true });
        refreshHeader();
        toast(`${entry.title || 'Lore entry'} ${prefix.textContent.toLowerCase()} set to ${getLoreDisplayLabel(field, nextValue)}.`, 'info');
    });

    wrap.appendChild(select);
    return wrap;
}

function createEditablePriorityBadge(entry) {
    const current = Number(entry.priority || 50);
    const wrap = document.createElement('label');
    wrap.className = 'wandlight-lore-meta-select-wrap wandlight-lore-meta-select-priority';
    addTooltip(wrap, 'Priority controls sorting and injection preference. Choose P10 through P100.');

    const prefix = document.createElement('span');
    prefix.className = 'wandlight-lore-meta-select-prefix';
    prefix.textContent = 'Priority';
    wrap.appendChild(prefix);

    const select = document.createElement('select');
    select.className = 'wandlight-lore-meta-select';
    select.setAttribute('aria-label', 'Priority metadata');
    select.addEventListener('click', e => e.stopPropagation());
    select.addEventListener('mousedown', e => e.stopPropagation());

    for (const value of LORE_PRIORITY_VALUES) {
        const option = document.createElement('option');
        option.value = String(value);
        option.textContent = `P${value}`;
        if (value === current) option.selected = true;
        select.appendChild(option);
    }

    select.addEventListener('change', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const nextValue = Math.max(0, Math.min(100, Number(select.value) || 50));
        updateLoreEntryById(entry.id, raw => ({ ...raw, priority: nextValue }), { deferSave: true });
        if (!refreshAcceptedLoreRow(entry.id)) refreshAcceptedLoreList({ preserveScroll: true });
        refreshHeader();
        toast(`${entry.title || 'Lore entry'} priority set to P${nextValue}.`, 'info');
    });

    wrap.appendChild(select);
    return wrap;
}

function createSpellMetadataBadges(entry) {
    const row = document.createDocumentFragment();
    const spells = Array.from(new Set([
        ...((entry?.scope?.spells || []).map(v => String(v || '').trim()).filter(Boolean)),
        ...((entry?.tags || []).filter(tag => /spell|patronus|expelliarmus|sectumsempra|occlumency|legilimency|apparition/i.test(String(tag || '')))),
    ])).slice(0, 4);

    if (!spells.length && (entry?.kind === 'spell_gate' || entry?.category === 'spell')) {
        spells.push(entry?.title || 'Spell gate');
    }

    for (const spell of spells) {
        const badge = createBadge(`Spell: ${spell}`, 'Spell metadata. This identifies spell knowledge, spell-learning gates, or magic-ability constraints attached to this lore entry.');
        badge.classList.add('wandlight-lore-badge-spell');
        row.appendChild(badge);
    }

    return row;
}

function scoreSearchEntry(entry, query) {
    const title = String(entry.title || '').toLowerCase();
    const tags = Array.isArray(entry.tags) ? entry.tags.map(t => String(t).toLowerCase()) : [];
    const scope = formatLoreScope(entry.scope).toLowerCase();
    const fact = String(entry.fact || '').toLowerCase();
    const id = String(entry.id || '').toLowerCase();
    const notes = String(entry.notes || '').toLowerCase();

    if (title === query) return 100;
    if (tags.some(t => t === query)) return 90;
    if (title.includes(query)) return 80;
    if (tags.some(t => t.includes(query))) return 70;
    if (scope.includes(query)) return 55;
    if (fact.includes(query)) return 40;
    if (notes.includes(query)) return 30;
    if (id.includes(query)) return 20;
    return 0;
}

function createEntryCard(entry, state) {
    const card = document.createElement('div');
    card.className = 'wandlight-lore-entry-card';
    if (entry.id) card.dataset.entryId = entry.id;

    if (entry.isPending) card.classList.add('wandlight-lore-entry-pending');
    if (entry.isActive) card.classList.add('wandlight-lore-entry-active');
    if (entry.isPinned) card.classList.add('wandlight-lore-entry-pinned');
    if (entry.isSuppressed) card.classList.add('wandlight-lore-entry-suppressed');
    if (getAcceptedSelectionSet(state).has(entry.id)) card.classList.add('wandlight-lore-entry-selected');

    const panelState = state?.lorePanel || {};
    const isExpanded = panelState.selectedEntryId === entry.id;
    if (isExpanded) card.classList.add('wandlight-lore-entry-expanded');

    const headerRow = document.createElement('div');
    headerRow.className = 'wandlight-lore-entry-header';

    const selectBox = document.createElement('input');
    selectBox.type = 'checkbox';
    selectBox.className = 'wandlight-lore-entry-select';
    selectBox.checked = getAcceptedSelectionSet(state).has(entry.id);
    selectBox.setAttribute('aria-label', 'Select accepted lore entry for bulk actions');
    addTooltip(selectBox, selectBox.checked ? 'Remove this accepted lore entry from the bulk selection.' : 'Select this accepted lore entry for bulk actions.');
    selectBox.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleAcceptedLoreSelection(entry.id, selectBox.checked);
        if (!refreshAcceptedLoreRow(entry.id)) refreshAcceptedLoreList({ preserveScroll: true });
        refreshAcceptedLoreBulkToolbar();
    });
    headerRow.appendChild(selectBox);

    const titleWrap = document.createElement('div');
    titleWrap.className = 'wandlight-lore-entry-title-wrap';

    const titleEl = document.createElement('span');
    titleEl.className = 'wandlight-lore-entry-title';
    titleEl.textContent = entry.title || '(Untitled lore)';
    addTooltip(titleEl, 'Click the card to expand details. Tags beside this title are editable search tags.');
    titleWrap.appendChild(titleEl);
    headerRow.appendChild(titleWrap);

    const actions = document.createElement('div');
    actions.className = 'wandlight-lore-entry-actions';
    actions.appendChild(createEditableLifecycleBadge(entry));

    const pinBtn = createIconButton(
        entry.isPinned ? 'Pinned' : 'Pin',
        entry.isPinned ? 'Remove this entry from pinned lore. Pinned lore is prioritized for injection.' : 'Pin this entry so it is prioritized for injection.',
        'wandlight-lore-entry-btn',
        (e) => {
            e.stopPropagation();
            togglePinEntry(entry.id, { deferSave: true });
            if (!refreshAcceptedLoreRow(entry.id)) refreshAcceptedLoreList({ preserveScroll: true });
            refreshAcceptedLoreBulkToolbar();
            refreshHeader();
        }
    );
    actions.appendChild(pinBtn);

    const suppressBtn = createIconButton(
        entry.isSuppressed ? 'Muted' : 'Mute',
        entry.isSuppressed ? 'Unmute this entry so it can become active again.' : 'Mute this entry so it will not be injected into prompts.',
        'wandlight-lore-entry-btn',
        (e) => {
            e.stopPropagation();
            toggleSuppressEntry(entry.id, { deferSave: true });
            if (!refreshAcceptedLoreRow(entry.id)) refreshAcceptedLoreList({ preserveScroll: true });
            refreshAcceptedLoreBulkToolbar();
            refreshHeader();
        }
    );
    actions.appendChild(suppressBtn);

    headerRow.appendChild(actions);
    card.appendChild(headerRow);

    const metaRow = document.createElement('div');
    metaRow.className = 'wandlight-lore-entry-meta';
    if (isExpanded) {
        metaRow.appendChild(createEditableLoreMetaBadge(entry, 'category', entry.category || 'canon', null, `Category: ${entry.category || 'canon'}. Use dropdown to change.`));
        metaRow.appendChild(createEditableLoreMetaBadge(entry, 'canonStatus', entry.canonStatus || 'unknown', null, `Canon status: ${entry.canonStatus || 'unknown'}. Use dropdown to change.`));
        metaRow.appendChild(createEditableLoreMetaBadge(entry, 'truthStatus', entry.truthStatus || 'true', null, `Truth/reveal status: ${entry.truthStatus || 'true'}. Use dropdown to change.`));
        metaRow.appendChild(createEditableLoreMetaBadge(entry, 'revealPolicy', entry.revealPolicy || 'private', null, `Reveal policy: ${entry.revealPolicy || 'private'}. Use dropdown to change.`));
        metaRow.appendChild(createEditablePriorityBadge(entry));
    } else {
        metaRow.appendChild(createRegistryBadge('category', entry.category || 'canon', `Category: ${entry.category || 'canon'}. Expand the entry to edit.`));
        metaRow.appendChild(createRegistryBadge('canonStatus', entry.canonStatus || 'unknown', `Canon status: ${entry.canonStatus || 'unknown'}. Expand the entry to edit.`));
        metaRow.appendChild(createBadge(`P${Number(entry.priority || 50)}`, 'Priority. Expand the entry to edit.'));
    }
    metaRow.appendChild(createSpellMetadataBadges(entry));
    if (entry.isPending) metaRow.appendChild(createBadge('pending', 'This entry is pending review.'));
    if (entry.isPinned) metaRow.appendChild(createBadge('pinned', 'Pinned entries are prioritized for injection.'));
    if (entry.isSuppressed) metaRow.appendChild(createBadge('muted', 'Muted entries are excluded from injection.'));
    card.appendChild(metaRow);

    card.appendChild(createTagsRow(entry));

    const factEl = document.createElement('div');
    factEl.className = 'wandlight-lore-entry-fact';
    factEl.textContent = truncateText(entry.fact || '', 140);
    addTooltip(factEl, 'Lore fact text. Expand the card to inspect the full entry.');
    card.appendChild(factEl);

    card.addEventListener('click', () => {
        const currentPanelState = getState()?.lorePanel || {};
        const newId = currentPanelState.selectedEntryId === entry.id ? '' : entry.id;
        setPanelState({ selectedEntryId: newId }, { deferSave: true });
        if (!refreshAcceptedLoreRow(entry.id)) refreshAcceptedLoreList({ preserveScroll: true });
    });

    if (isExpanded) {
        const details = document.createElement('div');
        details.className = 'wandlight-lore-entry-details';

        details.appendChild(createEditableLoreEntryEditor(entry));

        if (entry.fact && entry.fact.length > 140) {
            const fullFact = document.createElement('div');
            fullFact.className = 'wandlight-lore-entry-full-fact';
            fullFact.textContent = entry.fact;
            details.appendChild(fullFact);
        }

        const detailRows = [];
        if (entry.source) detailRows.push(['Source', entry.source]);
        if (hasDisplayableScope(entry.scope)) detailRows.push(['Scope', entry.scope]);
        if (entry.appliesTo?.length) detailRows.push(['Applies to', entry.appliesTo.join(', ')]);
        if (entry.publicVersion) detailRows.push(['Public version', entry.publicVersion]);
        if (entry.whoKnowsTruth?.length) detailRows.push(['Who knows truth', entry.whoKnowsTruth.join(', ')]);
        if (entry.whoSuspects?.length) detailRows.push(['Who suspects', entry.whoSuspects.join(', ')]);
        if (entry.revealPolicy) detailRows.push(['Reveal policy', entry.revealPolicy]);
        if (entry.validFrom || entry.validTo) detailRows.push(['Valid window', `${entry.validFrom || '...'} to ${entry.validTo || '...'}`]);
        if (entry.notes) detailRows.push(['Notes', entry.notes]);

        for (const [label, value] of detailRows) {
            details.appendChild(createKeyValue(label, value, `${label} metadata for this lore entry.`));
        }

        const aw = entry.activeWhen || {};
        const conditions = [];
        if (aw.erasAny?.length) conditions.push(`Eras: ${aw.erasAny.join(', ')}`);
        if (aw.locationsAny?.length) conditions.push(`Locations: ${aw.locationsAny.join(', ')}`);
        if (aw.charactersPresentAny?.length) conditions.push(`Cast: ${aw.charactersPresentAny.join(', ')}`);
        if (aw.tagsAny?.length) conditions.push(`Tags: ${aw.tagsAny.join(', ')}`);
        if (conditions.length) {
            const cond = document.createElement('div');
            cond.className = 'wandlight-lore-entry-conditions';
            cond.textContent = `Active when: ${conditions.join(' | ')}`;
            addTooltip(cond, 'Context conditions used to determine whether this lore entry should be active.');
            details.appendChild(cond);
        }

        if (entry.isPending) {
            const pendingActions = document.createElement('div');
            pendingActions.className = 'wandlight-lore-entry-pending-actions';
            pendingActions.appendChild(createButton('Apply', 'Accepts this pending entry into the lore matrix.', (btn, e) => {
                e?.stopPropagation?.();
                const current = getState();
                const pending = normalizeLoreMatrix(current?.pendingLoreEntries || []);
                const idx = pending.findIndex(pe => pe.id === entry.id);
                if (idx >= 0) {
                    pushStateSnapshot(current, `Accept lore entry: ${entry.title}`, getSettings().maxSnapshots);
                    acceptPendingLoreEntry(idx);
                    refreshPanelBody({ preserveScroll: true });
                    refreshHeader();
                }
            }, 'wandlight-primary-button'));
            pendingActions.appendChild(createButton('Dismiss', 'Rejects this pending entry.', (btn, e) => {
                e?.stopPropagation?.();
                const current = getState();
                const pending = normalizeLoreMatrix(current?.pendingLoreEntries || []);
                const idx = pending.findIndex(pe => pe.id === entry.id);
                if (idx >= 0) {
                    rejectPendingLoreEntry(idx);
                    refreshPanelBody({ preserveScroll: true });
                    refreshHeader();
                }
            }));
            details.appendChild(pendingActions);
        }

        card.appendChild(details);
    }

    return card;
}

// Tags ------------------------------------------------------------------------

function createTagsRow(entry) {
    const row = document.createElement('div');
    row.className = 'wandlight-lore-entry-tags';
    addTooltip(row, 'Tags are editable search labels. Search matches tags as well as entry titles.');

    const tags = Array.isArray(entry.tags) ? entry.tags : [];
    for (const tag of tags) {
        const chip = document.createElement('span');
        chip.className = 'wandlight-lore-tag-chip';

        const removeBtn = document.createElement('button');
        removeBtn.className = 'wandlight-lore-tag-remove';
        removeBtn.type = 'button';
        removeBtn.textContent = 'x';
        addTooltip(removeBtn, `Remove tag: ${tag}`);
        removeBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            removeLoreTag(entry.id, tag, { deferSave: true });
            if (!refreshAcceptedLoreRow(entry.id)) refreshAcceptedLoreList({ preserveScroll: true });
        });
        chip.appendChild(removeBtn);

        const label = document.createElement('span');
        label.className = 'wandlight-lore-tag-label';
        label.textContent = tag;
        chip.appendChild(label);
        row.appendChild(chip);
    }

    const addBtn = document.createElement('button');
    addBtn.className = 'wandlight-lore-tag-add';
    addBtn.type = 'button';
    addBtn.textContent = '+';
    addTooltip(addBtn, 'Add a searchable tag to this lore entry.');
    addBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showInlineTagInput(row, entry.id, addBtn);
    });
    row.appendChild(addBtn);

    return row;
}

function createReadOnlyTags(tags) {
    const row = document.createElement('div');
    row.className = 'wandlight-lore-entry-tags';
    for (const tag of tags) {
        const chip = document.createElement('span');
        chip.className = 'wandlight-lore-tag-chip';
        const label = document.createElement('span');
        label.className = 'wandlight-lore-tag-label';
        label.textContent = tag;
        chip.appendChild(label);
        row.appendChild(chip);
    }
    return row;
}

function showInlineTagInput(row, entryId, addBtn) {
    if (row.querySelector('.wandlight-lore-tag-input')) return;

    const input = document.createElement('input');
    input.className = 'wandlight-lore-tag-input';
    input.type = 'text';
    input.placeholder = 'tag';
    addTooltip(input, 'Type a tag and press Enter. Press Escape to cancel.');

    input.addEventListener('click', e => e.stopPropagation());
    input.addEventListener('mousedown', e => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            input.dataset.committed = '1';
            commitInlineTagInput(entryId, input.value);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            input.remove();
        }
    });
    input.addEventListener('blur', () => {
        if (input.dataset.committed === '1') return;
        if (input.value.trim()) {
            input.dataset.committed = '1';
            commitInlineTagInput(entryId, input.value);
        } else {
            input.remove();
        }
    });

    row.insertBefore(input, addBtn);
    requestAnimationFrame(() => input.focus());
}

function commitInlineTagInput(entryId, rawTag) {
    const tag = normalizeTag(rawTag);
    if (!tag) {
        refreshPanelBody({ preserveScroll: true });
        return;
    }
    addLoreTag(entryId, tag, { deferSave: true });
    if (!refreshAcceptedLoreRow(entryId)) refreshAcceptedLoreList({ preserveScroll: true });
}

function normalizeTag(value) {
    return normalizeLoreTag(value);
}

function updateLoreEntryById(entryId, updater, options = {}) {
    const state = getState();
    if (!entryId || typeof updater !== 'function') return false;

    for (const key of ['loreMatrix', 'pendingLoreEntries']) {
        const list = Array.isArray(state[key]) ? state[key] : [];
        const idx = list.findIndex(entry => entry?.id === entryId);
        if (idx >= 0) {
            const updated = normalizeLoreEntry(updater(list[idx]));
            updated.userEdited = true;
            list[idx] = updated;
            state[key] = list;
            if (options.deferSave) scheduleStateSave(state);
            else saveState(state);
            return true;
        }
    }
    return false;
}

function addLoreTag(entryId, tag, options = {}) {
    const clean = normalizeTag(tag);
    if (!clean) return false;
    return updateLoreEntryById(entryId, (entry) => {
        const tags = Array.isArray(entry.tags) ? entry.tags.map(normalizeTag).filter(Boolean) : [];
        const exists = tags.some(t => t.toLowerCase() === clean.toLowerCase());
        return { ...entry, tags: exists ? tags : [...tags, clean] };
    }, options);
}

function removeLoreTag(entryId, tag, options = {}) {
    const clean = normalizeTag(tag).toLowerCase();
    return updateLoreEntryById(entryId, (entry) => ({
        ...entry,
        tags: (Array.isArray(entry.tags) ? entry.tags : [])
            .map(normalizeTag)
            .filter(t => t && t.toLowerCase() !== clean),
    }), options);
}

function scheduleStateSave(state, delay = MINOR_STATE_SAVE_DEBOUNCE_MS) {
    deferredStateSaveRef = state || deferredStateSaveRef;
    if (deferredStateSaveTimer) clearTimeout(deferredStateSaveTimer);
    deferredStateSaveTimer = setTimeout(() => {
        if (deferredStateSaveRef) saveState(deferredStateSaveRef);
        deferredStateSaveRef = null;
        deferredStateSaveTimer = null;
    }, delay);
}

function flushScheduledStateSave() {
    if (deferredStateSaveTimer) clearTimeout(deferredStateSaveTimer);
    if (deferredStateSaveRef) saveState(deferredStateSaveRef);
    deferredStateSaveRef = null;
    deferredStateSaveTimer = null;
}

// Mutations -------------------------------------------------------------------

function togglePinEntry(entryId, options = {}) {
    const state = getState();
    if (!state?.loreSelection) return;
    const sel = state.loreSelection;
    sel.pinnedIds = Array.isArray(sel.pinnedIds) ? sel.pinnedIds : [];
    sel.suppressedIds = Array.isArray(sel.suppressedIds) ? sel.suppressedIds : [];
    const idx = sel.pinnedIds.indexOf(entryId);
    if (idx >= 0) {
        sel.pinnedIds.splice(idx, 1);
    } else {
        sel.pinnedIds.push(entryId);
        const supIdx = sel.suppressedIds.indexOf(entryId);
        if (supIdx >= 0) sel.suppressedIds.splice(supIdx, 1);
    }
    if (options.deferSave) scheduleStateSave(state);
    else saveState(state);
}

function toggleSuppressEntry(entryId, options = {}) {
    const state = getState();
    if (!state?.loreSelection) return;
    const sel = state.loreSelection;
    sel.pinnedIds = Array.isArray(sel.pinnedIds) ? sel.pinnedIds : [];
    sel.suppressedIds = Array.isArray(sel.suppressedIds) ? sel.suppressedIds : [];
    const idx = sel.suppressedIds.indexOf(entryId);
    if (idx >= 0) {
        sel.suppressedIds.splice(idx, 1);
    } else {
        sel.suppressedIds.push(entryId);
        const pinIdx = sel.pinnedIds.indexOf(entryId);
        if (pinIdx >= 0) sel.pinnedIds.splice(pinIdx, 1);
    }
    if (options.deferSave) scheduleStateSave(state);
    else saveState(state);
}

function setWorkflowMode(mode) {
    const normalized = normalizeWorkflowMode(mode);
    const settings = getSettings();
    settings.workflowMode = normalized;
    Object.assign(settings, WORKFLOW_MODES[normalized].settings);
    saveSettings(settings);
}

function setPanelState(patch, options = {}) {
    const state = getState();
    if (!state?.lorePanel) return;
    Object.assign(state.lorePanel, patch || {});
    if (options.deferSave) scheduleStateSave(state);
    else saveState(state);
}

function toggleCollapse() {
    const state = getState();
    if (!state?.lorePanel) return;
    state.lorePanel.collapsed = !state.lorePanel.collapsed;
    saveState(state);
    showLorePanel();
}

function refreshPanelBody(options = {}) {
    if (!panelRoot) return;
    const body = panelRoot.querySelector('.wandlight-lore-panel-body');
    if (!body) return;

    const activeScroll = getActiveScrollElement();
    const scrollTop = options.preserveScroll && activeScroll ? activeScroll.scrollTop : 0;

    const state = getState();
    renderPanelBody(body, state);

    if (options.preserveScroll) {
        const newScroll = getActiveScrollElement();
        if (newScroll) newScroll.scrollTop = scrollTop;
    }
}

function getActiveScrollElement() {
    if (!panelRoot) return null;
    return panelRoot.querySelector('.wandlight-lore-entry-list')
        || panelRoot.querySelector('.wandlight-runtime-tab-body');
}

// Drag and resize -------------------------------------------------------------

function onDragStart(e) {
    if (!panelRoot) return;
    if (e.target.closest('button, input, textarea, select, .wandlight-lore-panel-resize-handle')) return;

    isDragging = true;
    const rect = panelRoot.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;

    panelRoot.style.right = '';
    panelRoot.style.bottom = '';
    panelRoot.style.left = `${rect.left}px`;
    panelRoot.style.top = `${rect.top}px`;
    panelRoot.style.cursor = 'grabbing';

    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
}

function onDragMove(e) {
    if (!isDragging || !panelRoot) return;
    const x = e.clientX - dragOffsetX;
    const y = e.clientY - dragOffsetY;
    const maxX = window.innerWidth - panelRoot.offsetWidth;
    const maxY = window.innerHeight - panelRoot.offsetHeight;
    panelRoot.style.left = `${Math.max(0, Math.min(x, maxX))}px`;
    panelRoot.style.top = `${Math.max(0, Math.min(y, maxY))}px`;
}

function onDragEnd() {
    if (!panelRoot) return;
    isDragging = false;
    panelRoot.style.cursor = '';
    savePanelGeometry();
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
}

function onResizeStart(e) {
    if (e.button !== 0 || !panelRoot) return;

    isResizing = true;
    const rect = panelRoot.getBoundingClientRect();
    resizeStartX = e.clientX;
    resizeStartY = e.clientY;
    resizeStartWidth = rect.width;
    resizeStartHeight = rect.height;

    panelRoot.style.left = `${rect.left}px`;
    panelRoot.style.top = `${rect.top}px`;
    panelRoot.style.right = '';
    panelRoot.style.bottom = '';
    panelRoot.classList.add('wandlight-lore-panel-resizing');

    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);

    document.addEventListener('pointermove', onResizeMove);
    document.addEventListener('pointerup', onResizeEnd);
    document.addEventListener('pointercancel', onResizeEnd);
}

function onResizeMove(e) {
    if (!isResizing || !panelRoot) return;
    const rect = panelRoot.getBoundingClientRect();
    const maxWidth = Math.max(MIN_PANEL_WIDTH, window.innerWidth - rect.left - MAX_PANEL_MARGIN);
    const maxHeight = Math.max(MIN_PANEL_HEIGHT, window.innerHeight - rect.top - MAX_PANEL_MARGIN);
    const width = Math.max(MIN_PANEL_WIDTH, Math.min(maxWidth, resizeStartWidth + (e.clientX - resizeStartX)));
    const height = Math.max(MIN_PANEL_HEIGHT, Math.min(maxHeight, resizeStartHeight + (e.clientY - resizeStartY)));
    panelRoot.style.width = `${width}px`;
    panelRoot.style.height = `${height}px`;
}

function onResizeEnd() {
    if (!isResizing || !panelRoot) return;
    isResizing = false;
    panelRoot.classList.remove('wandlight-lore-panel-resizing');
    savePanelGeometry();
    document.removeEventListener('pointermove', onResizeMove);
    document.removeEventListener('pointerup', onResizeEnd);
    document.removeEventListener('pointercancel', onResizeEnd);
}

function savePanelGeometry() {
    if (!panelRoot) return;
    const state = getState();
    if (!state?.lorePanel) return;
    const rect = panelRoot.getBoundingClientRect();
    state.lorePanel.x = Math.round(rect.left);
    state.lorePanel.y = Math.round(rect.top);
    if (!panelRoot.classList.contains('wandlight-lore-panel-collapsed')) {
        state.lorePanel.width = Math.round(rect.width);
        state.lorePanel.height = Math.round(rect.height);
    }
    saveState(state);
}

// UI helpers ------------------------------------------------------------------

function createSectionHeader(title, description) {
    const wrap = document.createElement('div');
    wrap.className = 'wandlight-section-header';
    const h = document.createElement('h3');
    h.textContent = title;
    addTooltip(h, description);
    wrap.appendChild(h);
    const p = document.createElement('p');
    p.textContent = description;
    wrap.appendChild(p);
    return wrap;
}

function createToggleCard(label, checked, tooltip, onChange) {
    const card = document.createElement('label');
    card.className = 'wandlight-toggle-card';
    addTooltip(card, tooltip);

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!checked;
    input.addEventListener('change', () => onChange(input.checked));
    card.appendChild(input);

    const text = document.createElement('span');
    text.textContent = label;
    card.appendChild(text);

    const state = document.createElement('span');
    state.className = 'wandlight-toggle-state';
    state.textContent = checked ? 'On' : 'Off';
    card.appendChild(state);

    return card;
}


function isPlainObjectValue(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

function uniqueDisplayStrings(value) {
    const rawValues = Array.isArray(value) ? value : (typeof value === 'string' ? value.split(',') : []);
    const seen = new Set();
    const out = [];
    for (const raw of rawValues) {
        if (raw && typeof raw === 'object') continue;
        const text = String(raw ?? '').trim();
        if (!text) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(text);
    }
    return out.sort(compareScopeDisplayValues);
}

function compareScopeDisplayValues(a, b) {
    const yearA = String(a).match(/\bYear\s+(\d+)\b/i);
    const yearB = String(b).match(/\bYear\s+(\d+)\b/i);
    if (yearA && yearB) return Number(yearA[1]) - Number(yearB[1]);
    const numA = String(a).match(/\b(19\d{2}|20\d{2})\b/);
    const numB = String(b).match(/\b(19\d{2}|20\d{2})\b/);
    if (numA && numB && numA[1] !== numB[1]) return Number(numA[1]) - Number(numB[1]);
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

function getDisplayableScopeEntries(scope = {}) {
    if (!isPlainObjectValue(scope)) return [];
    const known = new Set(LORE_SCOPE_DISPLAY_ORDER.map(item => item.key));
    const ordered = LORE_SCOPE_DISPLAY_ORDER
        .map(item => ({ ...item, values: uniqueDisplayStrings(scope[item.key]) }))
        .filter(item => item.values.length > 0);

    const extras = Object.entries(scope)
        .filter(([key]) => !known.has(key))
        .map(([key, value]) => ({ key, label: humanizeScopeKey(key), weight: 1, values: uniqueDisplayStrings(value) }))
        .filter(item => item.values.length > 0)
        .sort((a, b) => a.label.localeCompare(b.label));

    return [...ordered, ...extras];
}

function humanizeScopeKey(key) {
    return String(key || '')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^./, c => c.toUpperCase());
}

function hasDisplayableScope(scope) {
    return getDisplayableScopeEntries(scope).length > 0;
}

function formatLoreScope(scope = {}) {
    const entries = getDisplayableScopeEntries(scope);
    if (!entries.length) return 'Global / broad context';
    return entries
        .map(item => `${item.label}: ${item.values.join(', ')}`)
        .join(' | ');
}

function getLoreScopeSpecificity(entry = {}) {
    return getDisplayableScopeEntries(entry.scope || {}).reduce((total, item) => {
        const first = Math.max(0, Number(item.weight) || 1);
        const additional = Math.max(0, item.values.length - 1) * Math.max(1, Math.round(first / 8));
        return total + first + additional;
    }, 0);
}

function formatStructuredValue(value) {
    if (value == null) return '';
    if (Array.isArray(value)) return uniqueDisplayStrings(value).join(', ');
    if (!isPlainObjectValue(value)) return String(value);

    const parts = Object.entries(value)
        .map(([key, val]) => {
            if (Array.isArray(val) || typeof val === 'string') {
                const values = uniqueDisplayStrings(val);
                return values.length ? `${humanizeScopeKey(key)}: ${values.join(', ')}` : '';
            }
            if (isPlainObjectValue(val)) {
                const nested = Object.entries(val)
                    .map(([nestedKey, nestedValue]) => `${humanizeScopeKey(nestedKey)}=${formatStructuredValue(nestedValue)}`)
                    .filter(Boolean)
                    .join(', ');
                return nested ? `${humanizeScopeKey(key)}: ${nested}` : '';
            }
            const text = String(val ?? '').trim();
            return text ? `${humanizeScopeKey(key)}: ${text}` : '';
        })
        .filter(Boolean);

    return parts.join(' | ');
}

function formatKeyValueDisplay(label, value) {
    if (String(label || '').toLowerCase() === 'scope') return formatLoreScope(value);
    return formatStructuredValue(value);
}

function createKeyValue(label, value, tooltip) {
    const row = document.createElement('div');
    row.className = 'wandlight-key-value';
    addTooltip(row, tooltip || label);

    const k = document.createElement('span');
    k.className = 'wandlight-key';
    k.textContent = label;
    row.appendChild(k);

    const v = document.createElement('span');
    v.className = 'wandlight-value';
    v.textContent = formatKeyValueDisplay(label, value);
    row.appendChild(v);

    return row;
}

function createButton(label, tooltip, handler, className = '') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `wandlight-runtime-button ${className}`.trim();
    btn.textContent = label;
    addTooltip(btn, tooltip);
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        handler?.(btn, e);
    });
    return btn;
}

function createIconButton(label, tooltip, className, handler) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.textContent = label;
    addTooltip(btn, tooltip);
    btn.addEventListener('click', handler);
    return btn;
}


function getLoreBadgeClass(text) {
    const normalized = String(text || '')
        .trim()
        .toLowerCase()
        .replace(/^p\d+$/, 'priority')
        .replace(/[^a-z0-9]+/g, '-');
    return normalized ? `wandlight-lore-badge-${normalized}` : '';
}

function createBadge(text, tooltip) {
    const badge = document.createElement('span');
    badge.className = `wandlight-lore-badge ${getLoreBadgeClass(text)}`.trim();
    badge.textContent = text;
    addTooltip(badge, tooltip);
    return badge;
}

function createStatusPill(text, tooltip) {
    const pill = document.createElement('span');
    pill.className = 'wandlight-status-pill';
    pill.textContent = text;
    addTooltip(pill, tooltip);
    return pill;
}

function createEmptyMessage(text) {
    const empty = document.createElement('div');
    empty.className = 'wandlight-lore-empty';
    empty.textContent = text;
    return empty;
}

function addTooltip(el, text) {
    if (!el || !text) return el;
    el.dataset.wandlightTooltip = text;
    el.setAttribute('aria-label', text);
    // Do not use native title for primary behavior; it is slow, inconsistent,
    // and the CSS pseudo-tooltip was clipped by the floating window.
    el.removeAttribute('title');
    el.addEventListener('mouseenter', () => showFloatingTooltip(el));
    el.addEventListener('focus', () => showFloatingTooltip(el));
    el.addEventListener('mouseleave', hideFloatingTooltip);
    el.addEventListener('blur', hideFloatingTooltip);
    return el;
}

function showFloatingTooltip(anchor) {
    const text = anchor?.dataset?.wandlightTooltip;
    if (!text) return;
    tooltipAnchor = anchor;
    if (!floatingTooltip) {
        floatingTooltip = document.createElement('div');
        floatingTooltip.className = 'wandlight-floating-tooltip';
        document.body.appendChild(floatingTooltip);
    }
    floatingTooltip.textContent = text;
    floatingTooltip.style.display = 'block';
    requestAnimationFrame(() => positionFloatingTooltip(anchor));
}

function positionFloatingTooltip(anchor) {
    if (!floatingTooltip || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const tipRect = floatingTooltip.getBoundingClientRect();
    const margin = 8;

    let left = rect.left + (rect.width / 2) - (tipRect.width / 2);
    left = Math.max(margin, Math.min(left, window.innerWidth - tipRect.width - margin));

    let top = rect.top - tipRect.height - margin;
    if (top < margin) {
        top = rect.bottom + margin;
    }
    top = Math.max(margin, Math.min(top, window.innerHeight - tipRect.height - margin));

    floatingTooltip.style.left = `${left}px`;
    floatingTooltip.style.top = `${top}px`;
}

function hideFloatingTooltip() {
    tooltipAnchor = null;
    if (floatingTooltip) floatingTooltip.style.display = 'none';
}

async function runBusyAction(btn, busyText, action) {
    if (!btn || typeof action !== 'function') return;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = busyText;
    try {
        await action();
    } catch (e) {
        console.error('[Wandlight Continuity] Runtime action failed:', e);
        toast(e?.message ? `Action failed: ${e.message}` : 'Action failed.', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = original;
    }
}

async function confirmAction(title, message) {
    const hasPopupConfirm = typeof Popup !== 'undefined' && Popup.show && typeof Popup.show.confirm === 'function';
    if (hasPopupConfirm) return await Popup.show.confirm(title, message);
    if (typeof confirm === 'function') return confirm(`${title}\n\n${message}`);
    return true;
}

function toast(message, type = 'success') {
    if (typeof toastr === 'undefined') return;
    if (type === 'error' && toastr.error) toastr.error(message);
    else if (type === 'warning' && toastr.warning) toastr.warning(message);
    else if (type === 'info' && toastr.info) toastr.info(message);
    else if (toastr.success) toastr.success(message);
}

function normalizeTab(tab) {
    return Object.prototype.hasOwnProperty.call(TAB_LABELS, tab) ? tab : 'session';
}

function normalizeWorkflowMode(mode) {
    return Object.prototype.hasOwnProperty.call(WORKFLOW_MODES, mode) ? mode : 'assisted';
}

function getWorkflowLabel(settings) {
    return WORKFLOW_MODES[normalizeWorkflowMode(settings?.workflowMode)].label;
}

function getWorkflowTooltip(settings) {
    return WORKFLOW_MODES[normalizeWorkflowMode(settings?.workflowMode)].description;
}

function getCategoryCount(cat, entries, counts) {
    if (cat === 'all') return counts.all;
    if (cat === 'active') return counts.active;
    if (cat === 'pinned') return counts.pinned;
    if (cat === 'suppressed') return counts.suppressed;
    if (cat === 'pending') return counts.pending;
    if (['expired', 'blocked', 'future', 'canon_overdue', 'divergent'].includes(cat)) return counts[cat] || 0;
    return entries.filter(e => e.category === cat).length;
}

function getCategoryTooltip(cat) {
    const registryMeta = getLoreRegistryMeta('categories', cat);
    if (registryMeta?.description) return registryMeta.description;
    const map = {
        all: 'Shows every accepted and pending lore entry.',
        active: 'Shows entries whose date, branch, character, location, or scope rules match the current Continuity/Context state. Lore may still inject fallback high-priority entries when this count is 0.',
        pinned: 'Shows entries manually prioritized for injection.',
        suppressed: 'Shows muted entries excluded from injection.',
        pending: 'Shows generated entries that still need review.',
        expired: 'Shows lore that has expired by story milestone or hard date. Expired entries are not injected unless manually overridden.',
        blocked: 'Shows lore blocked by missing story milestones or scene conditions.',
        future: 'Shows lore not yet active for the current story state.',
        canon_overdue: 'Shows canon-timed lore where the canon date has passed, but the story milestone has not happened.',
        divergent: 'Shows lore that does not match the current branch or canon status.',
    };
    return map[cat] || `Shows lore entries in category: ${cat}.`;
}

function getPendingLoreBatchLabel(state) {
    const meta = state?.pendingLoreMeta || {};
    const parts = [];
    if (meta.createdAt) parts.push(`Generated ${new Date(meta.createdAt).toLocaleString()}`);
    if (meta.status) parts.push(`status: ${meta.status}`);
    if (meta.validEntryCount !== undefined) parts.push(`${meta.validEntryCount} valid`);
    if (meta.rawEntryCount !== undefined) parts.push(`${meta.rawEntryCount} raw`);
    if (meta.droppedEntryCount) parts.push(`${meta.droppedEntryCount} dropped`);
    return parts.length ? parts.join(' | ') : 'Pending lore batch awaiting review.';
}

function estimateTokens(text) {
    return Math.ceil(String(text || '').length / 4);
}

function truncateText(text, maxLen) {
    const value = String(text || '');
    if (value.length <= maxLen) return value;
    return value.slice(0, maxLen).replace(/\s+\S*$/, '') + '...';
}
