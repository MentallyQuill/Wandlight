/**
 * lore-panel.js - Wandlight Continuity
 * Floating roleplay control window.
 *
 * The extension-menu settings panel is reserved for API setup, data/debug, and
 * raw previews. This window is the runtime surface used during roleplay.
 */

import { getPanelLoreState, normalizeLoreMatrix, normalizeLoreEntry, normalizeLoreTag } from './lore-matrix.js';
import { getDefaultState } from './constants.js';
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
import { proposeCanonLoreForContext } from './canon-lore-db.js';

const PANEL_ID = 'wandlight-lore-panel';
const MIN_PANEL_WIDTH = 420;
const MIN_PANEL_HEIGHT = 360;
const MAX_PANEL_MARGIN = 16;

const CATEGORY_LABELS = {
    all: 'All',
    active: 'Active',
    pinned: 'Pinned',
    suppressed: 'Muted',
    pending: 'Pending',
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


const LORE_CATEGORY_VALUES = ['canon', 'au', 'secret', 'rumor', 'lie', 'relationship', 'location', 'rule', 'timeline', 'character', 'event', 'item', 'knowledge', 'place', 'faction', 'spell', 'artifact'];
const LORE_CANON_STATUS_VALUES = ['canon', 'divergent', 'au', 'fanon', 'unknown'];
const LORE_TRUTH_STATUS_VALUES = ['true', 'false', 'public-belief', 'rumor', 'contested', 'hidden'];
const LORE_REVEAL_POLICY_VALUES = ['public', 'private', 'do_not_reveal', 'only_if_knower_present', 'only_if_user_reveals'];
const LORE_PRIORITY_VALUES = [10, 25, 50, 75, 90];

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
    const activeLore = getPanelLoreState(state).counts.active || 0;

    status.innerHTML = '';
    status.appendChild(createStatusPill(`Mode: ${getWorkflowLabel(settings)}`, getWorkflowTooltip(settings)));
    status.appendChild(createStatusPill(settings.enabled ? 'Wandlight Active' : 'Wandlight Paused', 'Master runtime toggle. When paused, Wandlight does not inject, scan, or generate.'));
    status.appendChild(createStatusPill((settings.injectContinuity !== false && settings.injectMemo !== false) ? 'Continuity Injected' : 'Continuity Not Injected', 'Whether Wandlight includes structured continuity state in roleplay generation prompts.'));
    if (pendingDelta + pendingLore > 0) {
        status.appendChild(createStatusPill(`Pending: ${pendingDelta + pendingLore}`, 'Pending items: generated lore entries in the Lore tab, plus any legacy continuity delta shown in the Continuity tab.'));
    }
    status.appendChild(createStatusPill(`Active Lore: ${activeLore}`, 'Lore entries currently eligible for prompt injection.'));
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

    container.appendChild(createInstructionsCard());

    const stats = document.createElement('div');
    stats.className = 'wandlight-runtime-card';
    const counts = getPanelLoreState(state).counts;
    const memo = buildMemo(state);
    stats.appendChild(createKeyValue('Pending continuity changes', state?.lastDelta ? '1' : '0', 'Legacy extracted state delta waiting in the Continuity tab. New scans apply directly to Continuity sections.'));
    stats.appendChild(createKeyValue('Pending lore entries', String((state?.pendingLoreEntries || []).length), 'Generated lore entries waiting in the Lore tab Pending Lore Review section.'));
    stats.appendChild(createKeyValue('Accepted lore entries', String(counts.all - counts.pending), 'Lore entries currently stored in the accepted lore matrix.'));
    stats.appendChild(createKeyValue('Active lore entries', String(counts.active), 'Accepted entries currently eligible for injection.'));
    stats.appendChild(createKeyValue('Memo estimate', memo ? `${estimateTokens(memo)} tokens` : 'empty', 'Approximate size of the injected continuity memo. The raw preview is in the Injection tab.'));
    container.appendChild(stats);

    container.appendChild(createStateHistoryCard(state));
    container.appendChild(createDangerZoneCard(state));
}

function createInstructionsCard() {
    const details = document.createElement('details');
    details.className = 'wandlight-runtime-card wandlight-instructions-card';

    const summary = document.createElement('summary');
    summary.className = 'wandlight-runtime-card-title';
    summary.textContent = 'Instructions';
    addTooltip(summary, 'Minimal workflow reference for using Wandlight during roleplay. Expand only when needed.');
    details.appendChild(summary);

    const list = document.createElement('ol');
    list.className = 'wandlight-workflow-list';
    const steps = [
        'Continuity: scan or auto-track scene, characters, emotions, knowledge, relationships, and other live state.',
        'Context: detect or manually set the scene date, canon reference point, and story branch.',
        'Lore: generate pending durable facts, review them, then search, edit, tag, pin, or mute accepted entries.',
        'Injection: choose whether Continuity and Lore are sent to the model, and whether each is direct or compressed.',
    ];
    for (const step of steps) {
        const li = document.createElement('li');
        li.textContent = step;
        list.appendChild(li);
    }
    details.appendChild(list);
    return details;
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
    container.appendChild(createCanonLoreDatabaseCard(state));
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
    card.className = 'wandlight-runtime-card wandlight-generation-progress-card';

    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = 'Lore Generation';
    addTooltip(title, 'Generates reviewable lore entries from recent messages. Generated entries stay pending until accepted in Pending Lore Review.');
    card.appendChild(title);

    card.appendChild(createAutomationModeCard(
        'Pending Lore Generation',
        'loreGenerationMode',
        'loreGenerationAutoInterval',
        'Only runs when you click Generate Pending Lore.',
        'Runs automatically after roleplay turns on this interval, using the Lore provider. Generated lore still waits in Pending Lore Review.',
        'Automatic pending-lore generation interval in completed model turns.'
    ));

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions wandlight-generation-actions';
    actions.appendChild(createButton('Generate Pending Lore', 'Generates searchable lore entries in message chunks and places them in Pending Lore Review.', async (btn) => {
        await handleGeneratePendingLore(btn);
    }, 'wandlight-primary-button'));
    card.appendChild(actions);

    appendGenerationStatus(card, state, 'lore');
    return card;
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

async function handleDetectStoryContext(btn) {
    if (!ensureLoreProviderReadyForAction('Detect Story Context', 'context')) return;
    await runBusyAction(btn, 'Detecting...', async () => {
        setFeatureProgress('context', 'Reading chat and detecting story context...', 8);
        const current = getState();
        pushStateSnapshot(current, 'Detect lore context', getSettings().maxSnapshots);
        const detected = await runLoreContextDetection({ progress: (message, percent) => setFeatureProgress('context', message, percent) });
        const after = getState();
        refreshHeader();
        refreshPanelBody({ preserveScroll: false });

        const fields = after?.loreContext || {};
        const filled = ['sceneDate', 'subjectiveDate', 'canonBoundary', 'branchId', 'timeTravelMode']
            .filter(key => String(fields[key] || '').trim()).length;

        if (detected && filled > 0) {
            toast('Story context detected and fields updated.');
        } else if (detected) {
            toast('Story context detection completed, but it did not find date/canon fields to populate.', 'warning');
        } else {
            toast('Story context detection returned no usable result.', 'warning');
        }
    });
}

async function handleGeneratePendingLore(btn) {
    if (!ensureLoreProviderReadyForAction('Generate Pending Lore', 'lore')) return;
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
                setFeatureProgress('lore', 'Generation cancelled by user.', 0);
                return;
            }
            allowReplacePending = true;
        }

        setFeatureProgress('lore', 'Starting chunked lore generation...', 5);
        const result = await runLoreGeneration({
            force: true,
            allowReplacePending,
            progress: (message, percent) => setFeatureProgress('lore', message, percent),
        });
        refreshHeader();

        if (result?.status === 'proposed') {
            setPanelState({ activeTab: 'lore' });
            refreshPanelBody({ preserveScroll: false });
            const duplicateText = result.droppedDuplicateCount ? ` ${result.droppedDuplicateCount} duplicate/similar entries were filtered.` : '';
            const chunkText = result.chunkCount ? ` Processed ${result.chunkCount} chunk${result.chunkCount === 1 ? '' : 's'}.` : '';
            toast(`${result.validEntryCount || 0} pending lore entries generated.${duplicateText}${chunkText} Lore tab opened.`);
        } else {
            refreshPanelBody({ preserveScroll: false });
            const details = formatGenerationStatus(result);
            toast(details, 'warning');
        }
    });
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
    maxInput.max = '50';
    maxInput.step = '1';
    maxInput.value = String(settings.canonLoreMaxEntries || 12);
    maxInput.addEventListener('input', () => {
        const next = getSettings();
        next.canonLoreMaxEntries = Math.max(1, Math.min(50, parseInt(maxInput.value, 10) || 12));
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
            refreshPanelBody({ preserveScroll: false });
            refreshHeader();
            if (result?.status === 'proposed') {
                toast(`Canon database proposed ${result.proposedCount || 0} pending lore entries.`);
            } else if (result?.status === 'duplicates_only') {
                toast('Canon database matches were already present or similar.', 'info');
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
    const statusKind = ['context', 'continuity', 'lore'].includes(kind) ? kind : 'lore';
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
                toast(`Continuity state updated.${keys}`);
            } else if (result?.status === 'no_changes') {
                setFeatureProgress('continuity', 'Continuity scan complete. No state changes detected.', 100);
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

    container.appendChild(createContinuitySectionToggleCard(state));
    container.appendChild(createCanonSceneEditorCard(state));
    container.appendChild(createCharacterStateEditorCard(state));
    container.appendChild(createJsonEditorCard('Knowledge', 'Character-keyed facts. Example: { "Harry": ["knows X"] }', 'knowledge', state.knowledge || {}));
    container.appendChild(createJsonEditorCard('Secrets', 'Non-public facts, who knows them, suspicions, and public versions.', 'secrets', state.secrets || []));
    container.appendChild(createJsonEditorCard('Relationships', 'Relationship state such as trust, tension, and notes.', 'relationships', state.relationships || []));
    container.appendChild(createJsonEditorCard('Threads', 'Active, dormant, or resolved story threads and unresolved consequences.', 'threads', state.threads || []));
    container.appendChild(createJsonEditorCard('Inventory / Objects', 'Tracked items, owners, locations, and object status.', 'inventory', state.inventory || []));
    container.appendChild(createJsonEditorCard('Objectives', 'Character or story goals, status, and stakes.', 'objectives', state.objectives || []));
    container.appendChild(createJsonEditorCard('Continuity Flags', 'Contradictions, warnings, uncertainties, and resolved flags.', 'continuityFlags', state.continuityFlags || []));
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
    card.appendChild(createJsonEditorCard('Canon divergences', 'AU or changed-canon facts with optional sinceDate fields.', 'canon.divergences', state?.canon?.divergences || [], true));
    return card;
}

function createCharacterStateEditorCard(state) {
    const card = createJsonEditorCard(
        'Characters',
        'Character state supports name, role, location, clothing, posture, physicalState, emotionalState, inventory, goals, and notes. Emotional numeric values are -5 to +5 and cool toward neutral in injection previews unless reinforced.',
        'characters',
        state?.characters || []
    );
    const schema = document.createElement('div');
    schema.className = 'wandlight-runtime-help';
    schema.textContent = 'Recommended character object: { "name": "Harry", "clothing": "school robes", "physicalState": "tired", "emotionalState": { "trust": 2, "fear": 1, "notes": "uneasy but cooperative" }, "goals": ["find the source of the curse"] }';
    card.appendChild(schema);
    return card;
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

function createJsonEditorCard(titleText, helpText, path, value, embedded = false) {
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
    const activeLore = getPanelLoreState(state).counts.active || 0;
    const continuityPreview = buildContinuityPreview(state, settings.continuityInjectionMode || 'direct');
    const lorePreview = buildLorePreview(state, settings.loreInjectionMode || 'direct');
    updateCompressionTurnStatus(state, 'lore');
    updateCompressionTurnStatus(state, 'continuity');

    container.appendChild(createSectionHeader(
        'Injection',
        'Final workflow step. Decide whether to inject structured Continuity state, Lore entries, or both, and whether each is direct or compressed.'
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

    const continuityCard = document.createElement('div');
    continuityCard.className = 'wandlight-runtime-card';
    const continuityTitle = document.createElement('div');
    continuityTitle.className = 'wandlight-runtime-card-title';
    continuityTitle.textContent = 'Continuity Handling Mode';
    addTooltip(continuityTitle, 'Direct sends the structured continuity state with detail. Compressed uses the Continuity provider to produce a concise cached version from the direct continuity block.');
    continuityCard.appendChild(continuityTitle);
    const continuityButtons = document.createElement('div');
    continuityButtons.className = 'wandlight-mode-buttons';
    continuityButtons.appendChild(createContinuityModeButton('direct', 'Direct', 'Insert editable continuity state with full section detail.', settings));
    continuityButtons.appendChild(createContinuityModeButton('compressed', 'Compressed', 'Use a model-compressed continuity block. If no cached compression exists, clicking Compressed starts a compression request.', settings));
    continuityCard.appendChild(continuityButtons);

    const continuityLevel = document.createElement('label');
    continuityLevel.className = 'wandlight-slider-row';
    const continuityLevelText = document.createElement('span');
    continuityLevelText.textContent = `Compression level: ${settings.continuityCompressionLevel || 2}`;
    addTooltip(continuityLevelText, 'Higher levels ask the Continuity provider for a shorter compressed continuity block. This does not edit stored state.');
    const continuityRange = document.createElement('input');
    continuityRange.type = 'range';
    continuityRange.min = '1';
    continuityRange.max = '5';
    continuityRange.value = String(settings.continuityCompressionLevel || 2);
    continuityRange.addEventListener('input', () => {
        const next = getSettings();
        next.continuityCompressionLevel = Number(continuityRange.value) || 2;
        saveSettings(next);
        continuityLevelText.textContent = `Compression level: ${next.continuityCompressionLevel}`;
        refreshInjectionPreviewOnly();
    });
    continuityLevel.appendChild(continuityLevelText);
    continuityLevel.appendChild(continuityRange);
    continuityCard.appendChild(continuityLevel);

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
    continuityCard.appendChild(decay);
    continuityCard.appendChild(createKeyValue('Continuity status', getContinuityCompressionStatusText(getState()), 'Shows when model-compressed continuity was last calculated.'));
    const continuityCompressActions = document.createElement('div');
    continuityCompressActions.className = 'wandlight-primary-actions';
    continuityCompressActions.appendChild(createButton('Compress Continuity Now', 'Uses the Continuity provider to compress the direct Continuity Injection Preview and cache it for compressed injection.', async (btn) => {
        await runModelCompression('continuity', btn);
    }, 'wandlight-primary-button'));
    continuityCard.appendChild(continuityCompressActions);
    container.appendChild(continuityCard);

    const loreCard = document.createElement('div');
    loreCard.className = 'wandlight-runtime-card';
    const loreTitle = document.createElement('div');
    loreTitle.className = 'wandlight-runtime-card-title';
    loreTitle.textContent = 'Lore Handling Mode';
    addTooltip(loreTitle, 'Direct sends selected active lore with full facts. Compressed uses the Lore provider to produce a concise cached version of the direct lore block. Pinned entries are emphasized as protected details.');
    loreCard.appendChild(loreTitle);
    const loreButtons = document.createElement('div');
    loreButtons.className = 'wandlight-mode-buttons';
    loreButtons.appendChild(createInjectionModeButton('direct', 'Direct', 'Insert active lore entries mostly verbatim, subject to the active-lore cap.', settings));
    loreButtons.appendChild(createInjectionModeButton('compressed', 'Compressed', 'Use a model-compressed lore block. If no cached compression exists, clicking Compressed starts a compression request. Stored lore is not changed.', settings));
    loreCard.appendChild(loreButtons);
    loreCard.appendChild(createKeyValue('Active lore available', String(activeLore), 'Entries eligible for prompt injection after filters, pinning, and muting.'));
    loreCard.appendChild(createKeyValue('Pinned protection', 'enabled', 'Pinned entries are prioritized and kept less compressed than ordinary entries.'));

    const levelLabel = document.createElement('label');
    levelLabel.className = 'wandlight-slider-row';
    const levelText = document.createElement('span');
    levelText.textContent = `Compression level: ${settings.loreCompressionLevel || 2}`;
    addTooltip(levelText, 'Higher levels ask the Lore provider for a shorter compressed lore block. Pinned entries are identified as protected details.');
    const level = document.createElement('input');
    level.type = 'range';
    level.min = '1';
    level.max = '5';
    level.value = String(settings.loreCompressionLevel || 2);
    level.addEventListener('input', () => {
        const next = getSettings();
        next.loreCompressionLevel = Number(level.value) || 2;
        saveSettings(next);
        levelText.textContent = `Compression level: ${next.loreCompressionLevel}`;
        refreshInjectionPreviewOnly();
    });
    levelLabel.appendChild(levelText);
    levelLabel.appendChild(level);
    loreCard.appendChild(levelLabel);

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
    loreCard.appendChild(intervalLabel);
    loreCard.appendChild(createKeyValue('Lore compression status', getCompressionStatusText(getState()), 'Shows when model-compressed lore was last calculated and how many chat turns have elapsed since then.'));
    const loreCompressActions = document.createElement('div');
    loreCompressActions.className = 'wandlight-primary-actions';
    loreCompressActions.appendChild(createButton('Compress Lore Now', 'Uses the Lore provider to compress the direct Lore Injection Preview and cache it for compressed injection.', async (btn) => {
        await runModelCompression('lore', btn);
    }, 'wandlight-primary-button'));
    loreCard.appendChild(loreCompressActions);
    container.appendChild(loreCard);

    container.appendChild(createInjectionPreviewCard('Continuity Injection Preview', 'wandlight-continuity-injection-preview', continuityPreview, settings.injectContinuity !== false && settings.injectMemo !== false, 'This preview shows only Continuity tab state. It can be placed at a different depth later because it is now separated from Lore.'));
    container.appendChild(createInjectionPreviewCard('Lore Injection Preview', 'wandlight-lore-injection-preview', lorePreview, settings.injectLore !== false, 'This preview shows only accepted Lore entries, using Direct or Compressed lore handling.'));
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
    previewHelp.textContent = enabled ? helpText : `${titleText.replace(' Preview', '')} is currently disabled. The preview shows what would be injected if enabled.`;
    previewCard.appendChild(previewHelp);

    const pre = document.createElement('pre');
    pre.className = `wandlight-injection-preview ${className}`;
    pre.textContent = text && text.trim() ? text : '(Preview is empty.)';
    addTooltip(pre, 'Scrollable preview of the prompt context block. This text is ephemeral and is not written into chat history.');
    previewCard.appendChild(pre);

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions';
    actions.appendChild(createButton('Refresh Preview', 'Rebuilds both split injection previews from current state and settings.', () => {
        refreshInjectionPreviewOnly();
        toast('Injection previews refreshed.', 'info');
    }));
    previewCard.appendChild(actions);
    return previewCard;
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
        continuityPre.textContent = continuity && continuity.trim() ? continuity : '(Preview is empty.)';
    }

    const lorePre = panelRoot?.querySelector('.wandlight-lore-injection-preview');
    if (lorePre) {
        lorePre.textContent = lore && lore.trim() ? lore : '(Preview is empty.)';
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

        const compressionPrompt = buildCompressionPrompt(kind, level, context, directText);
        const compressed = await sendLoreRequest(
            'You are Wandlight Compression. Output only the compressed injection block. Do not use markdown fences. Do not add commentary.',
            compressionPrompt,
            {
                providerKind,
                maxTokens: Math.max(256, Math.min(2048, Math.ceil(directText.length / 3))),
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

function buildCompressionPrompt(kind, level, context, directText) {
    const kindLabel = kind === 'continuity' ? 'Continuity State' : 'Lore Entries';
    const compressionTargets = {
        1: 'light compression: preserve most details; remove redundancy only',
        2: 'moderate compression: concise but still descriptive',
        3: 'firm compression: keep only roleplay-relevant facts and current-scene implications',
        4: 'heavy compression: short bullets; preserve critical secrets, constraints, and pinned/protected details',
        5: 'aggressive compression: minimum viable context; only essential facts, constraints, secrets, and active hazards',
    };

    return `Compress the following Wandlight ${kindLabel} injection block for a Harry Potter roleplay.

Story context:
${context}

Compression level ${level}: ${compressionTargets[level] || compressionTargets[2]}.

Rules:
- Preserve facts that affect current character behavior, secrets, continuity constraints, locations, relationships, active goals, and contradictions.
- Do not invent new facts.
- Do not remove do-not-reveal / only-reveal constraints.
- For lore, preserve pinned/protected entries more fully than ordinary entries.
- For continuity, keep current scene, character state, knowledge boundaries, and active emotional state if relevant.
- Output only the compressed injection text, with the same general heading style if useful.

Direct injection block:
${directText}`;
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
    return `model-compressed ${when}; ${status.turnsSinceCompression || 0} turns since; ~${status.lastTokenEstimate || 0} tokens`;
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
    return `model-compressed ${when}; ${status.turnsSinceCompression || 0} turns since; ~${status.lastTokenEstimate || 0} tokens`;
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
        if (mode === 'compressed' && !hasValidModelCompression('lore')) {
            await runModelCompression('lore', btn);
        } else {
            refreshPanelBody({ preserveScroll: false });
        }
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
        if (mode === 'compressed' && !hasValidModelCompression('continuity')) {
            await runModelCompression('continuity', btn);
        } else {
            refreshPanelBody({ preserveScroll: false });
        }
        refreshHeader();
        toast(`Continuity injection mode set to ${label}.`);
    });
    return btn;
}


function createPendingLoreReviewSection(state) {
    const pendingLore = normalizeLoreMatrix(state?.pendingLoreEntries || []);
    const section = document.createElement('details');
    section.className = 'wandlight-review-section wandlight-pending-lore-section';
    section.open = pendingLore.length > 0;

    const summary = document.createElement('summary');
    summary.className = 'wandlight-runtime-card-title wandlight-pending-lore-summary';
    summary.textContent = pendingLore.length
        ? `Pending Lore Review (${pendingLore.length})`
        : 'Pending Lore Review: none';
    addTooltip(summary, 'Review generated lore entries before accepting them into the Lore Matrix. This is the review queue for generated lore entries.');
    section.appendChild(summary);

    if (pendingLore.length > 0) {
        const batchInfo = document.createElement('div');
        batchInfo.className = 'wandlight-runtime-help';
        batchInfo.textContent = getPendingLoreBatchLabel(state);
        section.appendChild(batchInfo);

        section.appendChild(createPendingLoreBulkControls(pendingLore, state));

        const list = document.createElement('div');
        list.className = 'wandlight-review-lore-list wandlight-pending-lore-list';
        pendingLore.forEach((entry, idx) => list.appendChild(createPendingLoreReviewCard(entry, idx, isPendingLoreSelected(state, entry))));
        section.appendChild(list);
    } else {
        section.appendChild(createEmptyMessage('No generated lore entries are waiting for review. Use Generate Pending Lore above to create a review batch.'));
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
    checkbox.className = 'wandlight-review-lore-checkbox';
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
    card.className = 'wandlight-review-lore-card';
    if (selected) card.classList.add('wandlight-review-lore-card-selected');

    const header = document.createElement('div');
    header.className = 'wandlight-review-lore-card-header';
    header.appendChild(createPendingLoreCheckbox(entry, selected));

    const title = document.createElement('div');
    title.className = 'wandlight-review-lore-title';
    title.textContent = entry.title || `Pending lore ${index + 1}`;
    addTooltip(title, 'Generated lore entry title.');
    header.appendChild(title);

    const status = document.createElement('span');
    status.className = 'wandlight-lore-badge wandlight-lore-badge-pending';
    status.textContent = 'pending';
    addTooltip(status, 'This lore entry has not been accepted into the active lore matrix yet.');
    header.appendChild(status);
    card.appendChild(header);

    const meta = document.createElement('div');
    meta.className = 'wandlight-lore-entry-meta';
    meta.appendChild(createEditableLoreMetaBadge(entry, 'category', entry.category || 'canon', LORE_CATEGORY_VALUES, `Category: ${entry.category || 'canon'}. Click to cycle category.`));
    meta.appendChild(createEditableLoreMetaBadge(entry, 'canonStatus', entry.canonStatus || 'unknown', LORE_CANON_STATUS_VALUES, `Canon status: ${entry.canonStatus || 'unknown'}. Click to cycle.`));
    meta.appendChild(createEditableLoreMetaBadge(entry, 'truthStatus', entry.truthStatus || 'true', LORE_TRUTH_STATUS_VALUES, `Truth/reveal status: ${entry.truthStatus || 'true'}. Click to cycle.`));
    meta.appendChild(createEditableLoreMetaBadge(entry, 'revealPolicy', entry.revealPolicy || 'private', LORE_REVEAL_POLICY_VALUES, `Reveal policy: ${entry.revealPolicy || 'private'}. Click to cycle.`));
    meta.appendChild(createEditablePriorityBadge(entry));
    if (entry.confidence !== undefined) meta.appendChild(createBadge(`confidence ${entry.confidence}`, 'Model-provided confidence for this entry.'));
    card.appendChild(meta);

    if (Array.isArray(entry.tags) && entry.tags.length) {
        card.appendChild(createReadOnlyTags(entry.tags));
    }

    const fact = document.createElement('div');
    fact.className = 'wandlight-lore-entry-fact';
    fact.textContent = entry.fact || '(No fact text)';
    addTooltip(fact, 'The fact that will be merged into the accepted lore matrix if applied.');
    card.appendChild(fact);

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions';
    actions.appendChild(createButton('Apply', 'Accepts this single lore entry and merges it into the accepted lore matrix.', () => {
        const current = getState();
        pushStateSnapshot(current, `Accept lore entry: ${entry.title || index + 1}`, getSettings().maxSnapshots);
        acceptPendingLoreEntry(index);
        togglePendingReviewSelection(getLoreReviewId(entry), false);
        refreshPanelBody({ preserveScroll: true });
        refreshHeader();
        toast('Lore entry accepted.');
    }, 'wandlight-primary-button'));
    actions.appendChild(createButton('Dismiss', 'Rejects this single lore entry without changing accepted lore.', () => {
        rejectPendingLoreEntry(index);
        togglePendingReviewSelection(getLoreReviewId(entry), false);
        refreshPanelBody({ preserveScroll: true });
        refreshHeader();
        toast('Lore entry dismissed.', 'info');
    }));
    card.appendChild(actions);

    return card;
}

// Lore tab --------------------------------------------------------------------

function renderLoreTab(container, state) {
    container.appendChild(createSectionHeader(
        'Lore',
        'Generate durable lore entries, review pending entries, then manage accepted lore with search, filters, tags, pinning, and muting.'
    ));
    container.appendChild(createLoreGenerationCard(state));
    container.appendChild(createGenerationSettingsCard());
    container.appendChild(createPendingLoreReviewSection(state));

    const controls = document.createElement('div');
    controls.className = 'wandlight-lore-controls';

    controls.appendChild(createSectionHeader(
        'Accepted Lore Entries',
        'Manage accepted lore. Search checks titles and tags first, then fact text and notes.'
    ));

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
        const label = CATEGORY_LABELS[cat] || cat;
        const catCount = getCategoryCount(cat, entries, counts);
        tab.textContent = `${label} (${catCount})`;
        addTooltip(tab, getCategoryTooltip(cat));
        tab.addEventListener('click', () => {
            setPanelState({ selectedCategory: cat });
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
        setPanelState({ search: e.target.value });
        const list = container.querySelector('.wandlight-lore-entry-list');
        if (list) renderEntryList(list, getState());
    });
    filterRow.appendChild(searchInput);
    controls.appendChild(filterRow);

    const pinHelp = document.createElement('div');
    pinHelp.className = 'wandlight-runtime-help wandlight-pin-help';
    pinHelp.textContent = 'Pinned = prioritized and protected from aggressive compression. Muted = excluded from injection. Ordinary active entries may still be injected when relevant.';
    addTooltip(pinHelp, 'Pin important facts you always want kept prominent. Mute facts that should stay stored but not be sent to the model.');
    controls.appendChild(pinHelp);

    container.appendChild(controls);

    const list = document.createElement('div');
    list.className = 'wandlight-lore-entry-list';
    renderEntryList(list, state);
    container.appendChild(list);
}

function renderEntryList(list, state) {
    if (!list) return;
    list.innerHTML = '';

    const filtered = getFilteredLoreEntries(state);
    if (filtered.length === 0) {
        list.appendChild(createEmptyMessage('No lore entries match the current filter.'));
        return;
    }

    for (const entry of filtered) {
        list.appendChild(createEntryCard(entry, state));
    }
}

function getFilteredLoreEntries(state) {
    const panelState = state?.lorePanel || {
        selectedCategory: 'all',
        search: '',
        selectedEntryId: '',
    };

    const { entries } = getPanelLoreState(state);
    let filtered = entries;

    if (panelState.selectedCategory === 'active') {
        filtered = filtered.filter(e => e.isActive || e.isPinned);
    } else if (panelState.selectedCategory === 'pinned') {
        filtered = filtered.filter(e => e.isPinned);
    } else if (panelState.selectedCategory === 'suppressed') {
        filtered = filtered.filter(e => e.isSuppressed);
    } else if (panelState.selectedCategory === 'pending') {
        filtered = filtered.filter(e => e.isPending);
    } else if (panelState.selectedCategory && panelState.selectedCategory !== 'all') {
        filtered = filtered.filter(e => e.category === panelState.selectedCategory);
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


function sortLoreEntriesForPanel(a, b) {
    const pinScore = Number(!!b.isPinned) - Number(!!a.isPinned);
    if (pinScore) return pinScore;
    const pendingScore = Number(!!b.isPending) - Number(!!a.isPending);
    if (pendingScore) return pendingScore;
    const categoryScore = getLoreCategoryRank(a.category) - getLoreCategoryRank(b.category);
    if (categoryScore) return categoryScore;
    const priorityScore = Number(b.priority || 50) - Number(a.priority || 50);
    if (priorityScore) return priorityScore;
    return String(a.title || '').localeCompare(String(b.title || ''));
}

function getLoreCategoryRank(category) {
    const order = ['event', 'timeline', 'character', 'relationship', 'place', 'location', 'faction', 'knowledge', 'secret', 'item', 'artifact', 'spell', 'rule', 'canon', 'au', 'rumor', 'lie'];
    const idx = order.indexOf(category || '');
    return idx >= 0 ? idx : 99;
}

function createEditableLoreMetaBadge(entry, field, value, values, tooltip) {
    const label = field === 'category'
        ? (CATEGORY_LABELS[value] || value)
        : value;
    const badge = createBadge(label, tooltip);
    badge.classList.add('wandlight-lore-badge-clickable');
    badge.type = 'button';
    badge.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const currentValue = String(value || values[0]);
        const currentIndex = values.indexOf(currentValue);
        const nextValue = values[(currentIndex + 1) % values.length];
        updateLoreEntryById(entry.id, raw => ({ ...raw, [field]: nextValue }));
        refreshPanelBody({ preserveScroll: true });
        refreshHeader();
        toast(`${entry.title || 'Lore entry'} ${field} set to ${nextValue}.`, 'info');
    });
    return badge;
}

function createEditablePriorityBadge(entry) {
    const current = Number(entry.priority || 50);
    const badge = createBadge(`P${current}`, 'Priority controls sorting and injection preference. Click to cycle through P10, P25, P50, P75, and P90.');
    badge.classList.add('wandlight-lore-badge-clickable', 'wandlight-lore-badge-priority');
    badge.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const nearest = LORE_PRIORITY_VALUES.reduce((best, value) => Math.abs(value - current) < Math.abs(best - current) ? value : best, LORE_PRIORITY_VALUES[0]);
        const idx = LORE_PRIORITY_VALUES.indexOf(nearest);
        const nextValue = LORE_PRIORITY_VALUES[(idx + 1) % LORE_PRIORITY_VALUES.length];
        updateLoreEntryById(entry.id, raw => ({ ...raw, priority: nextValue }));
        refreshPanelBody({ preserveScroll: true });
        refreshHeader();
        toast(`${entry.title || 'Lore entry'} priority set to P${nextValue}.`, 'info');
    });
    return badge;
}

function scoreSearchEntry(entry, query) {
    const title = String(entry.title || '').toLowerCase();
    const tags = Array.isArray(entry.tags) ? entry.tags.map(t => String(t).toLowerCase()) : [];
    const fact = String(entry.fact || '').toLowerCase();
    const id = String(entry.id || '').toLowerCase();
    const notes = String(entry.notes || '').toLowerCase();

    if (title === query) return 100;
    if (tags.some(t => t === query)) return 90;
    if (title.includes(query)) return 80;
    if (tags.some(t => t.includes(query))) return 70;
    if (fact.includes(query)) return 40;
    if (notes.includes(query)) return 30;
    if (id.includes(query)) return 20;
    return 0;
}

function createEntryCard(entry, state) {
    const card = document.createElement('div');
    card.className = 'wandlight-lore-entry-card';

    if (entry.isPending) card.classList.add('wandlight-lore-entry-pending');
    if (entry.isActive) card.classList.add('wandlight-lore-entry-active');
    if (entry.isPinned) card.classList.add('wandlight-lore-entry-pinned');
    if (entry.isSuppressed) card.classList.add('wandlight-lore-entry-suppressed');

    const panelState = state?.lorePanel || {};
    const isExpanded = panelState.selectedEntryId === entry.id;
    if (isExpanded) card.classList.add('wandlight-lore-entry-expanded');

    const headerRow = document.createElement('div');
    headerRow.className = 'wandlight-lore-entry-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'wandlight-lore-entry-title-wrap';

    const titleEl = document.createElement('span');
    titleEl.className = 'wandlight-lore-entry-title';
    titleEl.textContent = entry.title || '(Untitled lore)';
    addTooltip(titleEl, 'Click the card to expand details. Tags beside this title are editable search tags.');
    titleWrap.appendChild(titleEl);
    titleWrap.appendChild(createTagsRow(entry));
    headerRow.appendChild(titleWrap);

    const actions = document.createElement('div');
    actions.className = 'wandlight-lore-entry-actions';

    const pinBtn = createIconButton(
        entry.isPinned ? 'Pinned' : 'Pin',
        entry.isPinned ? 'Remove this entry from pinned lore. Pinned lore is prioritized for injection.' : 'Pin this entry so it is prioritized for injection.',
        'wandlight-lore-entry-btn',
        (e) => {
            e.stopPropagation();
            togglePinEntry(entry.id);
            refreshPanelBody({ preserveScroll: true });
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
            toggleSuppressEntry(entry.id);
            refreshPanelBody({ preserveScroll: true });
            refreshHeader();
        }
    );
    actions.appendChild(suppressBtn);

    headerRow.appendChild(actions);
    card.appendChild(headerRow);

    const metaRow = document.createElement('div');
    metaRow.className = 'wandlight-lore-entry-meta';
    metaRow.appendChild(createEditableLoreMetaBadge(entry, 'category', entry.category || 'canon', LORE_CATEGORY_VALUES, `Category: ${entry.category || 'canon'}. Click to cycle category.`));
    metaRow.appendChild(createEditableLoreMetaBadge(entry, 'canonStatus', entry.canonStatus || 'unknown', LORE_CANON_STATUS_VALUES, `Canon status: ${entry.canonStatus || 'unknown'}. Click to cycle.`));
    metaRow.appendChild(createEditableLoreMetaBadge(entry, 'truthStatus', entry.truthStatus || 'true', LORE_TRUTH_STATUS_VALUES, `Truth/reveal status: ${entry.truthStatus || 'true'}. Click to cycle.`));
    metaRow.appendChild(createEditableLoreMetaBadge(entry, 'revealPolicy', entry.revealPolicy || 'private', LORE_REVEAL_POLICY_VALUES, `Reveal policy: ${entry.revealPolicy || 'private'}. Click to cycle.`));
    metaRow.appendChild(createEditablePriorityBadge(entry));
    if (entry.isPending) metaRow.appendChild(createBadge('pending', 'This entry is pending review.'));
    if (entry.isPinned) metaRow.appendChild(createBadge('pinned', 'Pinned entries are prioritized for injection.'));
    if (entry.isSuppressed) metaRow.appendChild(createBadge('muted', 'Muted entries are excluded from injection.'));
    card.appendChild(metaRow);

    const factEl = document.createElement('div');
    factEl.className = 'wandlight-lore-entry-fact';
    factEl.textContent = truncateText(entry.fact || '', 140);
    addTooltip(factEl, 'Lore fact text. Expand the card to inspect the full entry.');
    card.appendChild(factEl);

    card.addEventListener('click', () => {
        const currentPanelState = getState()?.lorePanel || {};
        const newId = currentPanelState.selectedEntryId === entry.id ? '' : entry.id;
        setPanelState({ selectedEntryId: newId });
        refreshPanelBody({ preserveScroll: true });
    });

    if (isExpanded) {
        const details = document.createElement('div');
        details.className = 'wandlight-lore-entry-details';

        if (entry.fact && entry.fact.length > 140) {
            const fullFact = document.createElement('div');
            fullFact.className = 'wandlight-lore-entry-full-fact';
            fullFact.textContent = entry.fact;
            details.appendChild(fullFact);
        }

        const detailRows = [];
        if (entry.source) detailRows.push(['Source', entry.source]);
        if (entry.scope) detailRows.push(['Scope', entry.scope]);
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
            removeLoreTag(entry.id, tag);
            refreshPanelBody({ preserveScroll: true });
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
    addLoreTag(entryId, tag);
    refreshPanelBody({ preserveScroll: true });
}

function normalizeTag(value) {
    return normalizeLoreTag(value);
}

function updateLoreEntryById(entryId, updater) {
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
            saveState(state);
            return true;
        }
    }
    return false;
}

function addLoreTag(entryId, tag) {
    const clean = normalizeTag(tag);
    if (!clean) return false;
    return updateLoreEntryById(entryId, (entry) => {
        const tags = Array.isArray(entry.tags) ? entry.tags.map(normalizeTag).filter(Boolean) : [];
        const exists = tags.some(t => t.toLowerCase() === clean.toLowerCase());
        return { ...entry, tags: exists ? tags : [...tags, clean] };
    });
}

function removeLoreTag(entryId, tag) {
    const clean = normalizeTag(tag).toLowerCase();
    return updateLoreEntryById(entryId, (entry) => ({
        ...entry,
        tags: (Array.isArray(entry.tags) ? entry.tags : [])
            .map(normalizeTag)
            .filter(t => t && t.toLowerCase() !== clean),
    }));
}

// Mutations -------------------------------------------------------------------

function togglePinEntry(entryId) {
    const state = getState();
    if (!state?.loreSelection) return;
    const sel = state.loreSelection;
    const idx = sel.pinnedIds.indexOf(entryId);
    if (idx >= 0) {
        sel.pinnedIds.splice(idx, 1);
    } else {
        sel.pinnedIds.push(entryId);
        const supIdx = sel.suppressedIds.indexOf(entryId);
        if (supIdx >= 0) sel.suppressedIds.splice(supIdx, 1);
    }
    saveState(state);
}

function toggleSuppressEntry(entryId) {
    const state = getState();
    if (!state?.loreSelection) return;
    const sel = state.loreSelection;
    const idx = sel.suppressedIds.indexOf(entryId);
    if (idx >= 0) {
        sel.suppressedIds.splice(idx, 1);
    } else {
        sel.suppressedIds.push(entryId);
        const pinIdx = sel.pinnedIds.indexOf(entryId);
        if (pinIdx >= 0) sel.pinnedIds.splice(pinIdx, 1);
    }
    saveState(state);
}

function setWorkflowMode(mode) {
    const normalized = normalizeWorkflowMode(mode);
    const settings = getSettings();
    settings.workflowMode = normalized;
    Object.assign(settings, WORKFLOW_MODES[normalized].settings);
    saveSettings(settings);
}

function setPanelState(patch) {
    const state = getState();
    if (!state?.lorePanel) return;
    Object.assign(state.lorePanel, patch || {});
    saveState(state);
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
    v.textContent = String(value ?? '');
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
    return entries.filter(e => e.category === cat).length;
}

function getCategoryTooltip(cat) {
    const map = {
        all: 'Shows every accepted and pending lore entry.',
        active: 'Shows lore currently eligible for injection, including pinned entries.',
        pinned: 'Shows entries manually prioritized for injection.',
        suppressed: 'Shows muted entries excluded from injection.',
        pending: 'Shows generated entries that still need review.',
        canon: 'Shows entries categorized as canon facts.',
        au: 'Shows alternate-universe or branch-specific lore.',
        secret: 'Shows hidden or private facts.',
        rumor: 'Shows uncertain or rumored information.',
        lie: 'Shows false beliefs or deception entries.',
        relationship: 'Shows relationship-specific lore.',
        location: 'Shows place-specific lore.',
        rule: 'Shows rule, magic, or system constraints.',
        timeline: 'Shows date-sensitive events and timeline facts.',
        character: 'Shows character-specific canon or story facts.',
        event: 'Shows dated events and historical/context milestones.',
        item: 'Shows object and item lore.',
        knowledge: 'Shows knowledge-state and information-control lore.',
        place: 'Shows place and setting lore.',
        faction: 'Shows group, house, institution, and faction lore.',
        spell: 'Shows spell and magic-mechanics lore.',
        artifact: 'Shows important magical object lore.',
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
