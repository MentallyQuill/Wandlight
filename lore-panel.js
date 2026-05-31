/**
 * lore-panel.js - Wandlight Continuity
 * Floating roleplay control window.
 *
 * The extension-menu settings panel is reserved for API setup, data/debug, and
 * raw previews. This window is the runtime surface used during roleplay.
 */

import { getPanelLoreState, normalizeLoreMatrix, normalizeLoreEntry } from './lore-matrix.js';
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
} from './state-manager.js';
import { buildMemo } from './memo-builder.js';
import { onExtractionTriggered } from './extractor.js';
import { runLoreContextDetection, runLoreGeneration } from './lore-generator.js';

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
};

const TAB_LABELS = {
    session: 'Session',
    generate: 'Generate',
    review: 'Review',
    injection: 'Injection',
    lore: 'Lore',
};

const TAB_TOOLTIPS = {
    session: 'Runtime controls for the current roleplay session: mode, continuity, prompt injection, and quick scan.',
    generate: 'Run context detection and create pending lore entries from recent roleplay.',
    review: 'Approve or dismiss extracted continuity changes and pending lore entries before they affect play.',
    injection: 'Choose how active lore is inserted into the prompt: direct verbatim insertion or deterministic compression.',
    lore: 'Search, filter, pin, mute, tag, and inspect accepted or pending lore entries.',
};

const WORKFLOW_MODES = {
    manual: {
        label: 'Manual',
        description: 'No automatic extraction or lore generation. Use the buttons in this window when you want Wandlight to scan or generate.',
        settings: {
            autoExtract: false,
            autoApplyDelta: false,
            autoGenerateLore: false,
        },
    },
    assisted: {
        label: 'Assisted',
        description: 'Extracts continuity changes after turns, but stores them for review instead of applying automatically.',
        settings: {
            autoExtract: true,
            autoApplyDelta: false,
            autoGenerateLore: false,
        },
    },
    automatic: {
        label: 'Automatic',
        description: 'Extracts and applies continuity changes automatically. Story-lore generation can run automatically, but generated lore still remains pending review.',
        settings: {
            autoExtract: true,
            autoApplyDelta: true,
            autoGenerateLore: true,
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
    status.appendChild(createStatusPill(settings.enabled ? 'Continuity On' : 'Continuity Off', 'Master runtime toggle. When off, Wandlight does not inject, scan, or generate.'));
    status.appendChild(createStatusPill(settings.injectMemo ? 'Injection On' : 'Injection Off', 'Whether the continuity memo is injected into roleplay generation prompts.'));
    if (pendingDelta + pendingLore > 0) {
        status.appendChild(createStatusPill(`Pending: ${pendingDelta + pendingLore}`, 'Items waiting in Review: extracted continuity changes plus generated lore entries.'));
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
    } else if (activeTab === 'generate') {
        renderGenerateTab(tabBody, state);
    } else if (activeTab === 'review') {
        renderReviewTab(tabBody, state);
    } else if (activeTab === 'injection') {
        renderInjectionTab(tabBody, state);
    } else {
        renderLoreTab(tabBody, state);
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
        'Continuity',
        settings.enabled,
        'Master runtime toggle. Off disables prompt injection, automatic extraction, and generation actions until turned back on.',
        (checked) => {
            const next = getSettings();
            next.enabled = checked;
            saveSettings(next);
            refreshPanelBody({ preserveScroll: false });
            refreshHeader();
        }
    ));
    toggles.appendChild(createToggleCard(
        'Prompt Injection',
        settings.injectMemo,
        'Injects the compact continuity memo into roleplay generation prompts. This is ephemeral and does not write into chat history.',
        (checked) => {
            const next = getSettings();
            next.injectMemo = checked;
            saveSettings(next);
            refreshPanelBody({ preserveScroll: false });
            refreshHeader();
        }
    ));
    toggles.appendChild(createToggleCard(
        'Lore Injection',
        settings.injectLore,
        'Allows active lore matrix entries to be included inside the injected continuity memo.',
        (checked) => {
            const next = getSettings();
            next.injectLore = checked;
            saveSettings(next);
            refreshPanelBody({ preserveScroll: false });
            refreshHeader();
        }
    ));
    container.appendChild(toggles);

    const stats = document.createElement('div');
    stats.className = 'wandlight-runtime-card';
    const counts = getPanelLoreState(state).counts;
    const memo = buildMemo(state);
    stats.appendChild(createKeyValue('Pending continuity changes', state?.lastDelta ? '1' : '0', 'Extracted state delta waiting in Review.'));
    stats.appendChild(createKeyValue('Pending lore entries', String((state?.pendingLoreEntries || []).length), 'Generated lore entries waiting in Review.'));
    stats.appendChild(createKeyValue('Accepted lore entries', String(counts.all - counts.pending), 'Lore entries currently stored in the accepted lore matrix.'));
    stats.appendChild(createKeyValue('Active lore entries', String(counts.active), 'Accepted entries currently eligible for injection.'));
    stats.appendChild(createKeyValue('Memo estimate', memo ? `${estimateTokens(memo)} tokens` : 'empty', 'Approximate size of the injected continuity memo. Raw preview remains in extension settings.'));
    container.appendChild(stats);

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions';
    actions.appendChild(createButton('Scan Current Chat', 'Runs continuity extraction now. In Manual or Assisted mode, changes are sent to Review instead of silently applying.', async (btn) => {
        await runBusyAction(btn, 'Scanning...', async () => {
            await onExtractionTriggered({ force: true });
            refreshPanelBody({ preserveScroll: false });
            refreshHeader();
            const nextState = getState();
            if (nextState.lastDelta) {
                setPanelState({ activeTab: 'review' });
                refreshPanelBody({ preserveScroll: false });
                toast('Continuity changes found. Review tab opened.');
            } else {
                toast('Scan complete. No pending continuity changes were stored.');
            }
        });
    }, 'wandlight-primary-button'));
    actions.appendChild(createButton('Open Review', 'Opens the Review tab for pending continuity changes and generated lore entries.', () => {
        setPanelState({ activeTab: 'review' });
        refreshPanelBody({ preserveScroll: false });
    }));
    actions.appendChild(createButton('Open Lore', 'Opens the Lore tab for searching, pinning, muting, tagging, and inspecting lore entries.', () => {
        setPanelState({ activeTab: 'lore' });
        refreshPanelBody({ preserveScroll: false });
    }));

    container.appendChild(actions);

    container.appendChild(createStateHistoryCard(state));
    container.appendChild(createDangerZoneCard(state));
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
    card.appendChild(createKeyValue('History limit', String(getSettings().maxSnapshots || 20), 'Maximum number of undo points retained. Configure this in API/settings.'));

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
    addTooltip(title, 'Destructive cleanup actions for the current chat. Each action takes a state-history snapshot first where possible.');
    card.appendChild(title);

    card.appendChild(createKeyValue('Accepted lore', String((state?.loreMatrix || []).length), 'Lore entries currently stored in the accepted lore matrix.'));
    card.appendChild(createKeyValue('Pending lore', String((state?.pendingLoreEntries || []).length), 'Generated lore entries waiting in Review.'));
    card.appendChild(createKeyValue('Pending continuity changes', state?.lastDelta ? '1' : '0', 'Extracted continuity delta waiting in Review.'));

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions';

    actions.appendChild(createButton('Delete All Lore', 'Deletes accepted lore, pending lore, and pin/mute selections. Canon/scene/relationship continuity state is left intact.', async () => {
        const proceed = await confirmAction('Delete all Wandlight lore?', 'This removes accepted lore entries, pending lore entries, and pin/mute selections for this chat. Other continuity state is not deleted. Continue?');
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
        const proceed = await confirmAction('Reset Wandlight generation state?', 'This clears context-detection and generation bookkeeping, pending lore, and pending continuity changes. Accepted lore remains. Continue?');
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

    actions.appendChild(createButton('Total Reset', 'Resets Wandlight continuity state for this chat to defaults. Panel size and position are preserved.', async () => {
        const proceed = await confirmAction('Totally reset Wandlight state?', 'This resets all Wandlight continuity data for the current chat. A state-history snapshot is taken first. Continue?');
        if (!proceed) return;
        const current = getState();
        pushStateSnapshot(current, 'Total Wandlight reset', getSettings().maxSnapshots);
        const defaults = getDefaultState();
        defaults.stateHistory = current.stateHistory || [];
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
        toast('Wandlight state reset.', 'info');
    }, 'wandlight-danger-button'));

    card.appendChild(actions);
    return card;
}

// Generate tab ----------------------------------------------------------------

function renderGenerateTab(container, state) {
    container.appendChild(createSectionHeader(
        'Generate Pending Lore',
        'Generation creates reviewable pending lore entries. It does not directly mutate accepted lore.'
    ));

    const contextCard = document.createElement('div');
    contextCard.className = 'wandlight-runtime-card';
    contextCard.appendChild(createKeyValue('Scene date', state?.loreContext?.sceneDate || 'not detected', 'The in-universe date used to select date-sensitive lore.'));
    contextCard.appendChild(createKeyValue('Canon boundary', state?.loreContext?.canonBoundary || 'not detected', 'The canon cutoff or reference point the detector inferred from the roleplay.'));
    contextCard.appendChild(createKeyValue('Branch', state?.loreContext?.branchId || 'main', 'Story branch or AU identifier used when generating and filtering lore.'));
    contextCard.appendChild(createKeyValue('Last detected', state?.loreContext?.lastDetectedAt ? new Date(state.loreContext.lastDetectedAt).toLocaleString() : 'never', 'When Wandlight last detected lore context.'));
    container.appendChild(contextCard);

    const options = document.createElement('div');
    options.className = 'wandlight-runtime-card';
    const optionsTitle = document.createElement('div');
    optionsTitle.className = 'wandlight-runtime-card-title';
    optionsTitle.textContent = 'Current Generation Behavior';
    addTooltip(optionsTitle, 'These are active implemented behaviors in the current generation pipeline.');
    options.appendChild(optionsTitle);
    options.appendChild(createKeyValue('Source', 'recent roleplay messages', 'Uses the recent chat window collected by the lore generator.'));
    options.appendChild(createKeyValue('Output', 'pending lore entries', 'Generated entries are stored in pendingLoreEntries and must be accepted in Review.'));
    options.appendChild(createKeyValue('Replacement guard', 'enabled', 'If pending entries already exist, the Generate button asks before replacing them.'));
    options.appendChild(createKeyValue('Tags', '3-5 generated per entry', 'The lore prompt asks the model to create editable tags for search.'));
    container.appendChild(options);

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions';
    actions.appendChild(createButton('Detect Context', 'Analyzes current roleplay to infer scene date, canon boundary, branch, and time-travel mode.', async (btn) => {
        await runBusyAction(btn, 'Detecting...', async () => {
            const current = getState();
            pushStateSnapshot(current, 'Detect lore context', getSettings().maxSnapshots);
            const detected = await runLoreContextDetection();
            refreshPanelBody({ preserveScroll: false });
            refreshHeader();
            toast(detected ? 'Lore context detected.' : 'Lore context detection returned no result.', detected ? 'success' : 'warning');
        });
    }, 'wandlight-primary-button'));

    actions.appendChild(createButton('Generate Pending Lore', 'Generates lore entries from recent roleplay and the detected context. Results go to Review.', async (btn) => {
        await runBusyAction(btn, 'Generating...', async () => {
            const current = getState();
            const pendingCount = (current.pendingLoreEntries || []).length;
            if (pendingCount > 0) {
                const proceed = await confirmAction(
                    'Replace pending lore?',
                    `There are already ${pendingCount} pending lore entries. Generating again will replace them. Continue?`
                );
                if (!proceed) return;
            }

            const result = await runLoreGeneration({ force: true, allowReplacePending: true });
            refreshHeader();
            if (result?.status === 'proposed') {
                setPanelState({ activeTab: 'review' });
                refreshPanelBody({ preserveScroll: false });
                toast(`${result.validEntryCount || 0} pending lore entries generated. Review tab opened.`);
            } else {
                refreshPanelBody({ preserveScroll: false });
                toast(`Lore generation ended with status: ${result?.status || 'unknown'}`, 'warning');
            }
        });
    }, 'wandlight-primary-button'));

    container.appendChild(actions);
}


// Injection tab ---------------------------------------------------------------

function renderInjectionTab(container, state) {
    const settings = getSettings();
    const activeLore = getPanelLoreState(state).counts.active || 0;
    const memo = buildMemo(state);

    container.appendChild(createSectionHeader(
        'Injection Controls',
        'Controls how accepted active lore is packed into prompt injection. This changes injection format only; it does not rewrite stored lore entries.'
    ));

    const modeCard = document.createElement('div');
    modeCard.className = 'wandlight-runtime-card';
    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = 'Lore Injection Mode';
    addTooltip(title, 'Direct inserts selected active lore mostly verbatim. Compressed shortens unpinned entries before injection; pinned entries remain protected and detailed.');
    modeCard.appendChild(title);

    const buttons = document.createElement('div');
    buttons.className = 'wandlight-mode-buttons';
    buttons.appendChild(createInjectionModeButton('direct', 'Direct', 'Insert active lore entries verbatim, subject to the active-lore cap.', settings));
    buttons.appendChild(createInjectionModeButton('compressed', 'Compressed', 'Shorten unpinned lore facts during injection so more entries fit into context. Stored lore is not changed.', settings));
    modeCard.appendChild(buttons);

    modeCard.appendChild(createKeyValue('Active lore available', String(activeLore), 'Entries eligible for prompt injection after filters, pinning, and muting.'));
    modeCard.appendChild(createKeyValue('Injected memo estimate', memo ? `${estimateTokens(memo)} tokens` : 'empty', 'Approximate size after current injection mode and compression settings.'));
    modeCard.appendChild(createKeyValue('Pinned protection', 'enabled', 'Pinned entries are prioritized and kept less compressed than ordinary entries.'));
    container.appendChild(modeCard);

    const compressionCard = document.createElement('div');
    compressionCard.className = 'wandlight-runtime-card';
    const compressionTitle = document.createElement('div');
    compressionTitle.className = 'wandlight-runtime-card-title';
    compressionTitle.textContent = 'Compression';
    addTooltip(compressionTitle, 'Deterministic injection compression. This is not model summarization and does not edit the lore matrix.');
    compressionCard.appendChild(compressionTitle);

    const levelLabel = document.createElement('label');
    levelLabel.className = 'wandlight-slider-row';
    const levelText = document.createElement('span');
    levelText.textContent = `Level: ${settings.loreCompressionLevel || 2}`;
    addTooltip(levelText, 'Higher levels shorten unpinned entries more aggressively. Pinned entries are preserved with more detail.');
    const level = document.createElement('input');
    level.type = 'range';
    level.min = '1';
    level.max = '5';
    level.value = String(settings.loreCompressionLevel || 2);
    level.addEventListener('input', () => {
        const next = getSettings();
        next.loreCompressionLevel = Number(level.value) || 2;
        saveSettings(next);
        levelText.textContent = `Level: ${next.loreCompressionLevel}`;
    });
    level.addEventListener('change', () => {
        refreshPanelBody({ preserveScroll: false });
        refreshHeader();
    });
    levelLabel.appendChild(levelText);
    levelLabel.appendChild(level);
    compressionCard.appendChild(levelLabel);

    const intervalLabel = document.createElement('label');
    intervalLabel.className = 'wandlight-inline-field';
    const intervalText = document.createElement('span');
    intervalText.textContent = 'Refresh interval';
    addTooltip(intervalText, 'Reserved interval for future model-based compression cache refresh. Current deterministic compression updates immediately when lore or settings change.');
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
    compressionCard.appendChild(intervalLabel);

    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help';
    help.textContent = 'Vector/lorebook retrieval is intentionally not exposed here yet because this extension does not currently own a reliable SillyTavern vector-store integration path. No inert vector button has been added.';
    compressionCard.appendChild(help);

    container.appendChild(compressionCard);
}

function createInjectionModeButton(mode, label, tooltip, settings) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wandlight-mode-button';
    if ((settings.loreInjectionMode || 'direct') === mode) btn.classList.add('wandlight-mode-button-active');
    btn.textContent = label;
    addTooltip(btn, tooltip);
    btn.addEventListener('click', () => {
        const next = getSettings();
        next.loreInjectionMode = mode;
        saveSettings(next);
        refreshPanelBody({ preserveScroll: false });
        refreshHeader();
        toast(`Lore injection mode set to ${label}.`);
    });
    return btn;
}

// Review tab ------------------------------------------------------------------

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
    actions.appendChild(createButton('Apply Changes', 'Applies this pending delta to the continuity state and clears it from Review.', () => {
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
    meta.appendChild(createBadge(entry.category || 'canon', `Category: ${entry.category || 'canon'}`));
    meta.appendChild(createBadge(`P${entry.priority || 50}`, 'Priority used when selecting active lore for injection.'));
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
    const controls = document.createElement('div');
    controls.className = 'wandlight-lore-controls';

    controls.appendChild(createSectionHeader(
        'Lore Matrix',
        'Manage accepted and pending lore. Search checks titles and tags first, then fact text and notes.'
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
    metaRow.appendChild(createBadge(entry.category || 'canon', `Category: ${entry.category || 'canon'}`));
    if (entry.truthStatus && entry.truthStatus !== 'true') metaRow.appendChild(createBadge(entry.truthStatus, 'Truth/reveal status for this entry.'));
    if (entry.isPending) metaRow.appendChild(createBadge('pending', 'This entry is pending review.'));
    if (entry.priority) metaRow.appendChild(createBadge(`P${entry.priority}`, 'Priority used when selecting active lore for injection.'));
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
    return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 40);
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

function createBadge(text, tooltip) {
    const badge = document.createElement('span');
    badge.className = 'wandlight-lore-badge';
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
