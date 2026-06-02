/**
 * lore-panel.js - Wandlight
 * Floating roleplay control window.
 *
 * The extension-menu settings panel is reserved for API setup, data/debug, and
 * raw previews. This window is the runtime surface used during roleplay.
 */

import { getPanelLoreState, getInjectableLoreEntries, getLoreRelevanceCounts, normalizeLoreMatrix, normalizeLoreEntry, normalizeLoreTag, LORE_LIFECYCLE_STATUSES } from './lore-matrix.js';
import { LORE_RELEVANCE_TIERS, LORE_RELEVANCE_LABELS, normalizeLoreRelevance, LORE_CATEGORY_VALUES, LORE_PURPOSE_LABELS, normalizeLorePurpose } from './lore-relevance.js';
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
import { buildContinuityPreview, buildLorePreview, getCompressionSourceSignature } from './memo-builder.js';
import { onExtractionTriggered } from './extractor.js';
import { runLoreContextDetection, runBulkLoreGeneration } from './lore-generator.js';
import { sendLoreRequest, validateLoreProviderConfiguration } from './lore-llm-client.js';
import { proposeCanonLoreForContext, previewCanonLoreForContext, addCanonLorePreviewEntriesToPending, getLoreTaxonomySync } from './canon-lore-db.js';
import { runAutoRelevance, applyAutoRelevanceSuggestions, clearAutoRelevanceSuggestions, rejectAutoRelevanceSuggestions } from './auto-relevance.js';

const PANEL_ID = 'wandlight-lore-panel';
const MIN_PANEL_WIDTH = 420;
const MIN_PANEL_HEIGHT = 360;
const MIN_DRAWER_WIDTH = 360;
const MIN_DRAWER_HEIGHT = 320;
const RAIL_WIDTH_COMPACT = 60;
const RAIL_WIDTH_EXPANDED = 206;
const RAIL_DRAWER_GAP = 8;
const MAX_PANEL_MARGIN = 16;

const CATEGORY_LABELS = {
    all: 'All',
    pinned: 'Pinned',
    suppressed: 'Muted',
    pending: 'Pending',
    high: 'High Relevance',
    normal: 'Normal Relevance',
    low: 'Low Relevance',
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

const TAB_ICONS = {
    session: 'S',
    context: 'C',
    continuity: 'K',
    lore: 'L',
    injection: 'I',
};

const TAB_ICON_PATHS = {
    session: './Images/runtime-icons/wandlight_tab_session_256.png',
    context: './Images/runtime-icons/wandlight_tab_context_256.png',
    continuity: './Images/runtime-icons/wandlight_tab_continuity_256.png',
    lore: './Images/runtime-icons/wandlight_tab_lore_256.png',
    injection: './Images/runtime-icons/wandlight_tab_injection_256.png',
};

const BRAND_LOGO_PATHS = {
    compact: './Images/branding/wandlight-logo-minimized-256.png',
    expanded: './Images/branding/wandlight-logo-expanded-512.png',
};

function getRuntimeAssetSrc(assetPath) {
    if (!assetPath) return '';
    try {
        return new URL(assetPath, import.meta.url).href;
    } catch (error) {
        return assetPath;
    }
}

function getTabIconSrc(tabId) {
    return getRuntimeAssetSrc(TAB_ICON_PATHS[tabId]);
}

function getBrandLogoSrc(railMode) {
    return getRuntimeAssetSrc(BRAND_LOGO_PATHS[normalizeRailMode(railMode)] || BRAND_LOGO_PATHS.compact);
}

const TAB_TOOLTIPS = {
    session: 'Runtime overview, instructions, undo history, and destructive cleanup actions.',
    continuity: 'Scan, automatically track, view, and edit lightweight live continuity state: scene/timeline, active characters, key items, and active goals/threads.',
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
let canonPreviewUiState = {
    contextKey: '',
    preview: null,
    selectedPackId: '',
    selectedEntryIds: [],
    detailLevel: 'standard',
};

function getLoreRegistry(registryName) {
    const taxonomy = getLoreTaxonomySync();
    return taxonomy?.[registryName] || {};
}

function getLoreRegistryValues(registryName, fallback = []) {
    if (registryName === 'canonStatuses') return ['canon', 'au'];
    if (registryName === 'categories') return LORE_CATEGORY_VALUES;
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
        if (String(sectionId || '').startsWith('lore.')) scheduleAcceptedLoreLayoutUpdate();
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
let resizeStartDirection = 'right';

let floatingTooltip = null;
let tooltipAnchor = null;

// Public runtime ------------------------------------------------------------

export function showLorePanel() {
    const state = getState();
    if (state?.lorePanel) {
        state.lorePanel.isOpen = true;
        normalizePanelLayoutState(state, { persistLegacyOpenState: true });
        saveState(state);
    }

    removeLorePanel();

    const freshState = getState();
    normalizePanelLayoutState(freshState, { persistLegacyOpenState: true });
    const panelState = freshState?.lorePanel || getDefaultState().lorePanel;

    panelRoot = document.createElement('div');
    panelRoot.id = PANEL_ID;
    panelRoot.className = 'wandlight-lore-panel wandlight-runtime-shell';
    applyRuntimeShellGeometry(panelRoot, panelState);

    renderPanelShell(panelRoot, freshState);
    document.body.appendChild(panelRoot);

    requestAnimationFrame(() => {
        clampRuntimeShellToViewport();
        updateAcceptedLoreScrollRegionHeight();
    });
}

export function hideLorePanel() {
    removeLorePanel();
    const state = getState();
    if (state?.lorePanel) {
        state.lorePanel.isOpen = false;
        saveState(state);
    }
}

export function resetLorePanelLayout() {
    const state = getState();
    if (!state.lorePanel) state.lorePanel = getDefaultState().lorePanel;
    const panelState = state.lorePanel;

    const defaultDrawerWidth = Math.min(560, Math.max(MIN_DRAWER_WIDTH, (window.innerWidth || 1024) - (MAX_PANEL_MARGIN * 2)));
    const defaultDrawerHeight = Math.min(640, Math.max(MIN_DRAWER_HEIGHT, (window.innerHeight || 768) - getDefaultRailY() - MAX_PANEL_MARGIN));

    panelState.isOpen = true;
    panelState.railMode = 'compact';
    panelState.railX = 16;
    panelState.railY = getDefaultRailY();
    panelState.drawerOpen = false;
    panelState.collapsed = true;
    panelState.activeTab = 'session';
    panelState.drawerWidth = defaultDrawerWidth;
    panelState.drawerHeight = defaultDrawerHeight;
    panelState.drawerDirection = 'auto';

    // Keep legacy geometry fields in sync for users migrating from the old floating window.
    panelState.x = panelState.railX;
    panelState.y = panelState.railY;
    panelState.width = panelState.drawerWidth;
    panelState.height = panelState.drawerHeight;

    normalizePanelLayoutState(state, { persistLegacyOpenState: true });
    saveState(state);
    showLorePanel();
    return state.lorePanel;
}

export function refreshLorePanel() {
    const existing = document.getElementById(PANEL_ID);
    if (!existing) return;

    const state = getState();
    if (!state?.lorePanel?.isOpen) {
        removeLorePanel();
        return;
    }

    normalizePanelLayoutState(state);
    const hasDrawer = !!existing.querySelector('.wandlight-runtime-drawer');
    if ((state.lorePanel.drawerOpen === true) !== hasDrawer) {
        renderPanelShell(existing, state);
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
    normalizePanelLayoutState(state);
    const panelState = state?.lorePanel || getDefaultState().lorePanel;
    const railMode = normalizeRailMode(panelState.railMode);
    const activeTab = normalizeTab(panelState.activeTab);
    const drawerOpen = panelState.drawerOpen === true;
    const drawerDirection = drawerOpen ? resolveDrawerDirection(panelState) : 'right';

    root.innerHTML = '';
    root.className = 'wandlight-lore-panel wandlight-runtime-shell';
    root.classList.add(`wandlight-runtime-rail-${railMode}`);
    if (drawerOpen) root.classList.add('wandlight-runtime-drawer-open');
    root.dataset.railMode = railMode;
    root.dataset.drawerDirection = drawerDirection;
    root.style.setProperty('--wandlight-rail-width', `${getRailWidth(panelState)}px`);
    root.style.setProperty('--wandlight-drawer-width', `${getConstrainedDrawerWidth(panelState, drawerDirection)}px`);
    root.style.setProperty('--wandlight-drawer-height', `${getConstrainedDrawerHeight(panelState)}px`);

    root.appendChild(renderRail(state));
    if (drawerOpen) root.appendChild(renderDrawer(state, drawerDirection));

    refreshHeader();
}

function renderRail(state) {
    const panelState = state?.lorePanel || getDefaultState().lorePanel;
    const railMode = normalizeRailMode(panelState.railMode);
    const activeTab = normalizeTab(panelState.activeTab);
    const drawerOpen = panelState.drawerOpen === true;
    const settings = getSettings();
    const metrics = getRailMetrics(state, settings);

    const rail = document.createElement('div');
    rail.className = `wandlight-runtime-rail wandlight-runtime-rail-${railMode}`;

    const drag = document.createElement('div');
    drag.className = 'wandlight-runtime-rail-drag';
    drag.addEventListener('mousedown', onDragStart);
    addTooltip(drag, 'Drag to move the Wandlight rail. The drawer stays anchored to this rail.');

    const mark = document.createElement('div');
    mark.className = 'wandlight-runtime-rail-mark';

    const markImg = document.createElement('img');
    markImg.className = 'wandlight-runtime-rail-logo-img';
    markImg.alt = railMode === 'compact' ? 'Wandlight' : 'Wandlight logo';
    markImg.src = getBrandLogoSrc(railMode);
    markImg.onerror = () => {
        markImg.remove();
        mark.textContent = railMode === 'compact' ? 'W' : 'Wandlight';
        mark.classList.add('wandlight-runtime-rail-mark-fallback');
    };
    mark.appendChild(markImg);
    drag.appendChild(mark);

    const sub = document.createElement('div');
    sub.className = 'wandlight-runtime-rail-subtitle';
    sub.textContent = settings.enabled ? 'Active' : 'Paused';
    drag.appendChild(sub);
    rail.appendChild(drag);

    const tabs = document.createElement('div');
    tabs.className = 'wandlight-runtime-rail-tabs';
    for (const [tabId, label] of Object.entries(TAB_LABELS)) {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'wandlight-runtime-rail-tab';
        tab.dataset.tabId = tabId;
        if (drawerOpen && tabId === activeTab) tab.classList.add('wandlight-runtime-rail-tab-active');
        addTooltip(tab, TAB_TOOLTIPS[tabId]);

        const icon = document.createElement('span');
        icon.className = 'wandlight-runtime-rail-icon';
        icon.dataset.fallbackIcon = TAB_ICONS[tabId] || label.slice(0, 1);
        const iconSrc = getTabIconSrc(tabId);
        if (iconSrc) {
            const iconImg = document.createElement('img');
            iconImg.className = 'wandlight-runtime-rail-icon-img';
            iconImg.src = iconSrc;
            iconImg.alt = '';
            iconImg.draggable = false;
            iconImg.addEventListener('error', () => {
                icon.classList.add('wandlight-runtime-rail-icon-missing');
                icon.textContent = TAB_ICONS[tabId] || label.slice(0, 1);
            }, { once: true });
            icon.appendChild(iconImg);
        } else {
            icon.textContent = TAB_ICONS[tabId] || label.slice(0, 1);
        }
        tab.appendChild(icon);

        const labelEl = document.createElement('span');
        labelEl.className = 'wandlight-runtime-rail-label';
        labelEl.textContent = label;
        tab.appendChild(labelEl);

        const metric = document.createElement('span');
        metric.className = 'wandlight-runtime-rail-metric';
        metric.dataset.tabId = tabId;
        metric.textContent = metrics[tabId] || '';
        tab.appendChild(metric);

        tab.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleDrawerForTab(tabId);
        });
        tabs.appendChild(tab);
    }
    rail.appendChild(tabs);

    const controls = document.createElement('div');
    controls.className = 'wandlight-runtime-rail-controls';

    const density = createIconButton(
        railMode === 'compact' ? '>' : '<',
        railMode === 'compact' ? 'Show labels and compact metrics.' : 'Use icons only.',
        'wandlight-runtime-rail-control wandlight-runtime-rail-density',
        (e) => {
            e.stopPropagation();
            toggleRailMode();
        }
    );
    controls.appendChild(density);

    const close = createIconButton(
        'x',
        'Close the Wandlight rail. Use /wandlight-lore-panel or the extension launcher to reopen it.',
        'wandlight-runtime-rail-control wandlight-runtime-rail-close',
        (e) => {
            e.stopPropagation();
            hideLorePanel();
        }
    );
    controls.appendChild(close);
    rail.appendChild(controls);

    return rail;
}

function renderDrawer(state, direction = 'right') {
    const panelState = state?.lorePanel || getDefaultState().lorePanel;
    const activeTab = normalizeTab(panelState.activeTab);

    const drawer = document.createElement('div');
    drawer.className = `wandlight-runtime-drawer wandlight-runtime-drawer-${direction}`;
    drawer.style.width = `${getConstrainedDrawerWidth(panelState, direction)}px`;
    drawer.style.height = `${getConstrainedDrawerHeight(panelState)}px`;

    const header = document.createElement('div');
    header.className = 'wandlight-runtime-drawer-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'wandlight-lore-panel-title-wrap';
    const title = document.createElement('div');
    title.className = 'wandlight-lore-panel-title wandlight-runtime-drawer-title';
    title.textContent = TAB_LABELS[activeTab] || 'Wandlight';
    addTooltip(title, TAB_TOOLTIPS[activeTab] || 'Wandlight runtime drawer.');
    titleWrap.appendChild(title);

    const status = document.createElement('div');
    status.className = 'wandlight-lore-panel-status wandlight-runtime-drawer-status';
    titleWrap.appendChild(status);
    header.appendChild(titleWrap);

    const collapseBtn = createIconButton('>', 'Collapse the active drawer and leave the rail visible.', 'wandlight-lore-panel-collapse-btn wandlight-runtime-drawer-collapse', (e) => {
        e.stopPropagation();
        setDrawerOpen(false);
    });
    header.appendChild(collapseBtn);

    const closeBtn = createIconButton('x', 'Close the Wandlight rail and drawer.', 'wandlight-lore-panel-close-btn wandlight-runtime-drawer-close', (e) => {
        e.stopPropagation();
        hideLorePanel();
    });
    header.appendChild(closeBtn);
    drawer.appendChild(header);

    const body = document.createElement('div');
    body.className = 'wandlight-lore-panel-body';
    drawer.appendChild(body);
    renderPanelBody(body, state);

    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'wandlight-lore-panel-resize-handle wandlight-runtime-drawer-resize-handle';
    resizeHandle.addEventListener('pointerdown', onResizeStart);
    addTooltip(resizeHandle, 'Drag to resize the active drawer. The size is remembered across tabs.');
    drawer.appendChild(resizeHandle);

    updateDrawerScrollMetrics(drawer);
    return drawer;
}

function refreshHeader() {
    if (!panelRoot) return;

    const state = getState();
    normalizePanelLayoutState(state);
    const settings = getSettings();
    const metrics = getRailMetrics(state, settings);

    for (const metric of panelRoot.querySelectorAll('.wandlight-runtime-rail-metric[data-tab-id]')) {
        metric.textContent = metrics[metric.dataset.tabId] || '';
    }

    const status = panelRoot.querySelector('.wandlight-runtime-drawer-status');
    if (!status) return;

    const pendingLore = (state?.pendingLoreEntries || []).length;
    const pendingDelta = state?.lastDelta ? 1 : 0;
    const counts = getPanelLoreState(state).counts;
    const selectedLore = getSelectedLoreInjectionCount(state, settings);

    status.innerHTML = '';
    status.appendChild(createStatusPill(`Mode: ${getWorkflowLabel(settings)}`, getWorkflowTooltip(settings)));
    status.appendChild(createStatusPill(settings.enabled ? 'Active' : 'Paused', 'Master runtime toggle. When paused, Wandlight does not inject, scan, or generate.'));
    status.appendChild(createStatusPill((settings.injectContinuity !== false && settings.injectMemo !== false) ? 'Continuity Injected' : 'Continuity Not Injected', 'Whether Wandlight includes structured continuity state in roleplay generation prompts.'));
    if (pendingDelta + pendingLore > 0) {
        status.appendChild(createStatusPill(`Pending: ${pendingDelta + pendingLore}`, 'Pending generated lore entries plus any legacy continuity delta.'));
    }
    status.appendChild(createStatusPill(`Lore Selected: ${selectedLore}`, 'Accepted lore entries selected for the next injection after context activation, priority, pinning, and muting.'));
    void counts;
}

function renderPanelBody(container, state) {
    container.innerHTML = '';

    const activeTab = normalizeTab(state?.lorePanel?.activeTab);
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

    installNestedScrollHandoff(tabBody);
    if (activeTab === 'lore') scheduleAcceptedLoreLayoutUpdate();
}

function installNestedScrollHandoff(tabBody) {
    if (!tabBody) return;
    const nestedScrolls = tabBody.querySelectorAll([
        '.wandlight-accepted-lore-scroll-region',
        '.wandlight-pending-lore-list',
        '.wandlight-injection-preview',
        '.wandlight-continuity-json-editor',
        'textarea'
    ].join(','));

    for (const nested of nestedScrolls) {
        nested.addEventListener('wheel', (e) => {
            const outer = nested.closest('.wandlight-runtime-tab-body');
            if (!outer || outer === nested || !e.deltaY) return;

            const canScrollDown = nested.scrollTop + nested.clientHeight < nested.scrollHeight - 1;
            const canScrollUp = nested.scrollTop > 0;
            const shouldHandoff = (e.deltaY > 0 && !canScrollDown) || (e.deltaY < 0 && !canScrollUp);
            if (!shouldHandoff) return;

            outer.scrollTop += e.deltaY;
            e.preventDefault();
            e.stopPropagation();
        }, { passive: false });
    }
}

function getRailMetrics(state, settings = getSettings()) {
    const counts = getPanelLoreState(state).counts;
    const pendingLore = (state?.pendingLoreEntries || []).length;
    const selectedLore = getSelectedLoreInjectionCount(state, settings);
    const injectionStats = getInjectionCharacterStats(state, settings);
    const sceneDate = String(state?.loreContext?.sceneDate || '').trim();
    const canonBoundary = String(state?.loreContext?.canonBoundary || '').trim();
    const activeCharacters = Array.isArray(state?.scene?.presentCharacters)
        ? state.scene.presentCharacters.length
        : (Array.isArray(state?.characters) ? state.characters.length : 0);
    const liveItems = [state?.scene?.location, state?.scene?.currentActivity].filter(Boolean).length;

    return {
        session: settings.enabled ? getWorkflowLabel(settings) : 'Paused',
        context: sceneDate || canonBoundary || 'No date',
        continuity: `${activeCharacters || liveItems || 0} live`,
        lore: pendingLore ? `${counts.active || 0}+${pendingLore}` : `${counts.active || 0} active`,
        injection: injectionStats.totalChars ? `${injectionStats.totalTokens} tk` : `${selectedLore} lore`,
    };
}

function normalizePanelLayoutState(state, options = {}) {
    if (!state) return null;
    if (!state.lorePanel) state.lorePanel = getDefaultState().lorePanel;
    const panelState = state.lorePanel;

    const hadRailFields = panelState.railX != null || panelState.railY != null || panelState.drawerOpen != null;
    panelState.railMode = normalizeRailMode(panelState.railMode);
    if (typeof panelState.drawerOpen !== 'boolean') {
        panelState.drawerOpen = hadRailFields ? false : panelState.collapsed !== true;
    }
    panelState.collapsed = panelState.drawerOpen !== true;
    panelState.activeTab = normalizeTab(panelState.activeTab);
    panelState.drawerDirection = ['auto', 'right', 'left'].includes(panelState.drawerDirection) ? panelState.drawerDirection : 'auto';

    const legacyX = Number(panelState.x);
    const legacyY = Number(panelState.y);
    const defaultY = getDefaultRailY();
    panelState.railX = clampNumber(Number(panelState.railX), 0, Math.max(0, window.innerWidth - getRailWidth(panelState)), Number.isFinite(legacyX) ? legacyX : 16);
    panelState.railY = clampNumber(Number(panelState.railY), 0, Math.max(0, window.innerHeight - 80), Number.isFinite(legacyY) ? legacyY : defaultY);
    panelState.drawerWidth = clampNumber(Number(panelState.drawerWidth), MIN_DRAWER_WIDTH, Math.max(MIN_DRAWER_WIDTH, window.innerWidth - (MAX_PANEL_MARGIN * 2)), Number(panelState.width) || 560);
    panelState.drawerHeight = clampNumber(Number(panelState.drawerHeight), MIN_DRAWER_HEIGHT, Math.max(MIN_DRAWER_HEIGHT, window.innerHeight - (MAX_PANEL_MARGIN * 2)), Number(panelState.height) || 640);

    if (options.persistLegacyOpenState) {
        panelState.x = panelState.railX;
        panelState.y = panelState.railY;
        panelState.width = panelState.drawerWidth;
        panelState.height = panelState.drawerHeight;
    }
    return panelState;
}

function normalizeRailMode(mode) {
    return mode === 'expanded' ? 'expanded' : 'compact';
}

function getRailWidth(panelState) {
    return normalizeRailMode(panelState?.railMode) === 'expanded' ? RAIL_WIDTH_EXPANDED : RAIL_WIDTH_COMPACT;
}

function getDefaultRailY() {
    return Math.max(16, Math.round((window.innerHeight || 800) * 0.35));
}

function getConstrainedDrawerWidth(panelState, direction = 'right') {
    const railX = Number(panelState?.railX) || 0;
    const railWidth = getRailWidth(panelState);
    const requested = Number(panelState?.drawerWidth) || 560;
    const spaceRight = Math.max(MIN_DRAWER_WIDTH, window.innerWidth - railX - railWidth - RAIL_DRAWER_GAP - MAX_PANEL_MARGIN);
    const spaceLeft = Math.max(MIN_DRAWER_WIDTH, railX - RAIL_DRAWER_GAP - MAX_PANEL_MARGIN);
    const maxWidth = direction === 'left' ? spaceLeft : spaceRight;
    return Math.max(MIN_DRAWER_WIDTH, Math.min(requested, maxWidth));
}

function getConstrainedDrawerHeight(panelState) {
    const railY = Number(panelState?.railY) || 0;
    const requested = Number(panelState?.drawerHeight) || 640;
    const maxHeight = Math.max(MIN_DRAWER_HEIGHT, window.innerHeight - railY - MAX_PANEL_MARGIN);
    return Math.max(MIN_DRAWER_HEIGHT, Math.min(requested, maxHeight));
}

function resolveDrawerDirection(panelState) {
    if (panelState?.drawerDirection === 'left') return 'left';
    if (panelState?.drawerDirection === 'right') return 'right';

    const railX = Number(panelState?.railX) || 0;
    const railWidth = getRailWidth(panelState);
    const requested = Number(panelState?.drawerWidth) || 560;
    const spaceRight = window.innerWidth - railX - railWidth - RAIL_DRAWER_GAP - MAX_PANEL_MARGIN;
    const spaceLeft = railX - RAIL_DRAWER_GAP - MAX_PANEL_MARGIN;

    if (spaceRight >= requested) return 'right';
    if (spaceLeft >= requested) return 'left';
    return spaceRight >= spaceLeft ? 'right' : 'left';
}

function applyRuntimeShellGeometry(root, panelState) {
    const railWidth = getRailWidth(panelState);
    const x = clampNumber(Number(panelState?.railX), 0, Math.max(0, window.innerWidth - railWidth), 16);
    const y = clampNumber(Number(panelState?.railY), 0, Math.max(0, window.innerHeight - 80), getDefaultRailY());
    root.style.left = `${x}px`;
    root.style.top = `${y}px`;
    root.style.right = '';
    root.style.bottom = '';
}

function clampRuntimeShellToViewport() {
    if (!panelRoot) return;
    const state = getState();
    const panelState = normalizePanelLayoutState(state);
    if (!panelState) return;
    const railWidth = getRailWidth(panelState);
    const railHeight = panelRoot.querySelector('.wandlight-runtime-rail')?.offsetHeight || 80;
    panelState.railX = clampNumber(Number(panelState.railX), 0, Math.max(0, window.innerWidth - railWidth), 16);
    panelState.railY = clampNumber(Number(panelState.railY), 0, Math.max(0, window.innerHeight - Math.min(railHeight, window.innerHeight)), getDefaultRailY());
    panelState.x = panelState.railX;
    panelState.y = panelState.railY;
    applyRuntimeShellGeometry(panelRoot, panelState);
    panelRoot.style.setProperty('--wandlight-rail-width', `${railWidth}px`);
    panelRoot.style.setProperty('--wandlight-drawer-width', `${getConstrainedDrawerWidth(panelState, resolveDrawerDirection(panelState))}px`);
    panelRoot.style.setProperty('--wandlight-drawer-height', `${getConstrainedDrawerHeight(panelState)}px`);
    updateDrawerScrollMetrics();
    saveState(state);
}

function clampNumber(value, min, max, fallback) {
    const safeMin = Number.isFinite(min) ? min : 0;
    const safeMax = Number.isFinite(max) ? Math.max(safeMin, max) : safeMin;
    const safeFallback = Number.isFinite(fallback) ? fallback : safeMin;
    const n = Number.isFinite(value) ? value : safeFallback;
    return Math.max(safeMin, Math.min(n, safeMax));
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
    stats.appendChild(createKeyValue('High-relevance lore entries', String(counts.active), 'Accepted lore entries currently assigned to the High-Relevance injection tier.'));
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
            body: 'Scan lightweight live state: scene/timeline, active characters, key items, and active goals/threads. Durable memory belongs in Lore.',
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

    actions.appendChild(createButton('Delete All Lore', 'Deletes accepted lore, pending lore, and pin/mute selections. Lightweight continuity state is left intact.', async () => {
        const proceed = await confirmAction('Are you sure? Delete all Wandlight lore?', 'You are about to delete every accepted lore entry, every pending lore entry, and all pin/mute selections for this chat. Lightweight continuity state will remain. A state-history snapshot will be saved first. This cannot be reversed except by Undo Last Change. Continue?');
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
        current.loreBulkGeneration = defaults.loreBulkGeneration;
        current.continuityScan = defaults.continuityScan;
        current.lastDelta = null;
        if (current.lorePanel) current.lorePanel.reviewSelectedIds = [];
        saveState(current);
        refreshPanelBody({ preserveScroll: false });
        refreshHeader();
        toast('Generation state reset.', 'info');
    }, 'wandlight-danger-button'));

    actions.appendChild(createButton('Total Reset', 'Resets Wandlight continuity state for this chat to defaults and clears State History. Panel size and position are preserved.', async () => {
        const proceed = await confirmAction('Are you sure? Total reset?', 'You are about to reset all Wandlight data for this chat: lightweight continuity state, accepted lore, pending lore, generation state, and State History. Window position and size are preserved. Because State History will also be cleared, this action cannot be undone. Continue?');
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
        'Runs automatically after roleplay turns on this interval, using the Reasoning provider.',
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
    help.textContent = 'Preview local canon packs for the current Story Context, choose only the entries you want, then add them to Pending Lore Review. No API/model cost.';
    panel.appendChild(help);

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions wandlight-generation-actions';
    actions.appendChild(createButton('Preview Canon Packs', 'Queries the local Lore Database and groups matching entries into selectable packs with counts.', async (btn) => {
        await handlePreviewCanonLorePacks(btn);
    }, 'wandlight-primary-button'));
    actions.appendChild(createButton('Quick Add Top Matches', `Legacy one-click flow: proposes up to ${settings.canonLoreMaxEntries || 10} top matches into Pending Lore Review.`, async (btn) => {
        await handleSuggestCanonLore(btn);
    }, 'wandlight-secondary-button'));
    panel.appendChild(actions);

    panel.appendChild(createCanonPreviewSection(state));

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
        'Use Local Canon Database',
        settings.canonLoreDatabaseEnabled !== false,
        'Allows manual previews, quick add, and optional auto-suggest to query local pre-generated canon lore files.',
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
        'When enabled, a Story Context detection run also performs the quick top-match canon proposal. It does not affect manual previews.',
        (checked) => {
            const next = getSettings();
            next.canonLoreAutoPropose = checked;
            saveSettings(next);
            refreshPanelBody({ preserveScroll: true });
        }
    ));
    content.appendChild(grid);

    const capRow = document.createElement('label');
    capRow.className = 'wandlight-slider-row wandlight-compact-slider-row';
    const capText = document.createElement('span');
    capText.textContent = `Quick/auto add cap: ${settings.canonLoreMaxEntries || 10}`;
    addTooltip(capText, 'Maximum entries used only by Quick Add Top Matches and auto-suggest after Story Context detection. Pack preview counts are not capped by this slider.');
    const capInput = document.createElement('input');
    capInput.type = 'range';
    capInput.min = '1';
    capInput.max = '200';
    capInput.step = '1';
    capInput.value = String(settings.canonLoreMaxEntries || 10);
    capInput.addEventListener('input', () => {
        const next = getSettings();
        next.canonLoreMaxEntries = Math.max(1, Math.min(200, parseInt(capInput.value, 10) || 10));
        saveSettings(next);
        capText.textContent = `Quick/auto add cap: ${next.canonLoreMaxEntries}`;
    });
    capRow.appendChild(capText);
    capRow.appendChild(capInput);
    content.appendChild(capRow);

    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help';
    help.textContent = 'Auto-suggest runs only when Story Context detection runs. With the default automatic context interval, that is interval-based, not every message. Manual pack preview can be run any time.';
    content.appendChild(help);
    return content;
}

function getCanonPreviewContextKey(context = {}) {
    return [
        context.sceneDate || '',
        context.subjectiveDate || '',
        context.canonBoundary || '',
        context.branchId || '',
        context.timeTravelMode || '',
    ].map(value => String(value || '').trim()).join('|');
}

function getCanonPreviewSelectedIds() {
    return new Set(Array.isArray(canonPreviewUiState.selectedEntryIds) ? canonPreviewUiState.selectedEntryIds : []);
}

function setCanonPreviewSelectedIds(ids = []) {
    canonPreviewUiState.selectedEntryIds = Array.from(new Set((ids || []).map(id => String(id || '')).filter(Boolean)));
}

function getCanonPreviewEntrySummary(entry = {}) {
    const content = entry.content || {};
    return content.injection
        || content.fact
        || entry.fact
        || (Array.isArray(content.constraints) ? content.constraints[0] : '')
        || (Array.isArray(content.antiLore) ? content.antiLore[0] : '')
        || '';
}

function getCanonPreviewEntryMap(preview = null) {
    return new Map((preview?.entries || []).map(entry => [String(entry.id || ''), entry]));
}

function isCanonPreviewEntryAddable(entry = {}) {
    return (entry.extensions?.canonPreview?.duplicateStatus || 'new') === 'new';
}

const CANON_PREVIEW_DETAIL_LEVELS = [
    { id: 'core', label: 'Core', tooltip: 'Only highest-value active guardrails and reveal blockers.' },
    { id: 'standard', label: 'Standard', tooltip: 'Core plus normal character, access, and constraint entries.' },
    { id: 'detailed', label: 'Detailed', tooltip: 'Includes low-priority and micro constraints that are still active.' },
    { id: 'all', label: 'All Active', tooltip: 'Shows every active non-reference entry in each pack.' },
];

function getCanonPreviewDetailLevel() {
    return ['core', 'standard', 'detailed', 'all'].includes(canonPreviewUiState.detailLevel)
        ? canonPreviewUiState.detailLevel
        : 'standard';
}

function getCanonPreviewDetailRank(level) {
    const normalized = String(level || '').toLowerCase();
    if (normalized === 'core') return 1;
    if (normalized === 'standard') return 2;
    if (normalized === 'detailed') return 3;
    return 4;
}

function getCanonPreviewEntryDetailLevel(entry = {}) {
    const level = entry.extensions?.canonPreview?.detailLevel || 'standard';
    return ['core', 'standard', 'detailed'].includes(level) ? level : 'standard';
}

function canonPreviewDetailAllows(entry = {}, detailLevel = getCanonPreviewDetailLevel()) {
    if (detailLevel === 'all') return true;
    return getCanonPreviewDetailRank(getCanonPreviewEntryDetailLevel(entry)) <= getCanonPreviewDetailRank(detailLevel);
}

function createCanonPreviewDetailControls() {
    const active = getCanonPreviewDetailLevel();
    const wrap = document.createElement('div');
    wrap.className = 'wandlight-canon-detail-filter';
    CANON_PREVIEW_DETAIL_LEVELS.forEach(option => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `wandlight-canon-detail-button ${active === option.id ? 'wandlight-canon-detail-active' : ''}`.trim();
        btn.textContent = option.label;
        addTooltip(btn, option.tooltip);
        btn.addEventListener('click', (event) => {
            event.stopPropagation();
            canonPreviewUiState.detailLevel = option.id;
            refreshPanelBody({ preserveScroll: true });
        });
        wrap.appendChild(btn);
    });
    return wrap;
}

function createCanonPreviewSection(state) {
    const section = document.createElement('div');
    section.className = 'wandlight-canon-preview-section';
    const preview = canonPreviewUiState.preview;
    const currentContextKey = getCanonPreviewContextKey(state?.loreContext || {});
    const isStale = !!(preview && canonPreviewUiState.contextKey && canonPreviewUiState.contextKey !== currentContextKey);

    if (!preview) {
        section.appendChild(createEmptyMessage('No canon pack preview yet. Preview packs to choose entries before adding them to Pending Lore Review.'));
        return section;
    }

    if (preview.status === 'disabled') {
        section.appendChild(createEmptyMessage('The local canon database is disabled in Canon Suggestion Settings.'));
        return section;
    }
    if (preview.status === 'no_date') {
        section.appendChild(createEmptyMessage('No parseable Scene date. Detect or enter Story Context before previewing canon packs.'));
        return section;
    }
    if (!preview.entries?.length) {
        section.appendChild(createEmptyMessage('No canon database entries matched this Story Context.'));
        return section;
    }

    const summary = document.createElement('div');
    summary.className = 'wandlight-canon-preview-summary';
    const yearText = preview.schoolYear ? `Year ${preview.schoolYear} | ` : '';
    summary.textContent = `${yearText}${preview.sceneIso || 'unknown date'} | ${preview.matchedCount || preview.entries.length} matches | ${preview.newCount || 0} new | ${preview.duplicateCount || 0} already present`;
    section.appendChild(summary);
    section.appendChild(createCanonPreviewDetailControls());

    if (isStale) {
        const stale = document.createElement('div');
        stale.className = 'wandlight-runtime-help wandlight-warning-text';
        stale.textContent = 'This preview was built for earlier Story Context. Refresh Canon Packs before adding entries.';
        section.appendChild(stale);
    }

    const packs = Array.isArray(preview.packs) ? preview.packs : [];
    const detailLevel = getCanonPreviewDetailLevel();
    const entryMap = getCanonPreviewEntryMap(preview);
    const activePack = packs.find(pack => pack.id === canonPreviewUiState.selectedPackId)
        || packs.find(pack => pack.newCount > 0)
        || packs[0]
        || null;
    if (activePack && canonPreviewUiState.selectedPackId !== activePack.id) {
        canonPreviewUiState.selectedPackId = activePack.id;
    }

    const packGrid = document.createElement('div');
    packGrid.className = 'wandlight-canon-pack-grid';
    packs.forEach(pack => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `wandlight-canon-pack-button ${pack.id === activePack?.id ? 'wandlight-canon-pack-active' : ''}`.trim();
        addTooltip(btn, pack.description || 'Canon preview pack.');
        const packEntriesForDetail = (pack.entryIds || [])
            .map(id => entryMap.get(String(id)))
            .filter(Boolean)
            .filter(entry => canonPreviewDetailAllows(entry, detailLevel));
        const packNewForDetail = packEntriesForDetail.filter(isCanonPreviewEntryAddable).length;

        const label = document.createElement('span');
        label.className = 'wandlight-canon-pack-label';
        label.textContent = `${pack.label} (${packEntriesForDetail.length})`;
        btn.appendChild(label);

        const meta = document.createElement('span');
        meta.className = 'wandlight-canon-pack-meta';
        meta.textContent = `${packNewForDetail} new${packEntriesForDetail.length !== (pack.totalCount || 0) ? ` of ${pack.totalCount || 0}` : ''}${pack.duplicateCount ? `, ${pack.duplicateCount} present` : ''}`;
        btn.appendChild(meta);

        btn.addEventListener('click', (event) => {
            event.stopPropagation();
            canonPreviewUiState.selectedPackId = pack.id;
            refreshPanelBody({ preserveScroll: true });
        });
        packGrid.appendChild(btn);
    });
    section.appendChild(packGrid);

    if (!activePack) {
        section.appendChild(createEmptyMessage('No canon packs are available for this preview.'));
        return section;
    }

    const packEntriesAll = (activePack.entryIds || []).map(id => entryMap.get(String(id))).filter(Boolean);
    const packEntries = packEntriesAll.filter(entry => canonPreviewDetailAllows(entry, detailLevel));
    const addablePackIds = packEntries.filter(isCanonPreviewEntryAddable).map(entry => entry.id);
    const selectedIds = getCanonPreviewSelectedIds();
    const selectedAddableCount = Array.from(selectedIds).filter(id => isCanonPreviewEntryAddable(entryMap.get(String(id)) || {})).length;

    const controls = document.createElement('div');
    controls.className = 'wandlight-canon-preview-actions';
    const count = document.createElement('span');
    count.className = 'wandlight-canon-preview-selected-count';
    count.textContent = `${selectedAddableCount} selected`;
    controls.appendChild(count);
    controls.appendChild(createButton('Select Pack', `Selects all visible new entries in ${activePack.label} at the current detail level.`, () => {
        setCanonPreviewSelectedIds([...selectedIds, ...addablePackIds]);
        refreshPanelBody({ preserveScroll: true });
    }, 'wandlight-small-button'));
    controls.appendChild(createButton('Clear', 'Clears the current canon preview selection.', () => {
        setCanonPreviewSelectedIds([]);
        refreshPanelBody({ preserveScroll: true });
    }, 'wandlight-small-button'));
    const addSelected = createButton('Add Selected to Pending Lore', 'Adds selected canon preview entries to the existing Pending Lore Review list for full inspection before accepting.', async (btn) => {
        await handleAddCanonPreviewEntries(btn, Array.from(getCanonPreviewSelectedIds()));
    }, 'wandlight-primary-button');
    addSelected.disabled = isStale || selectedAddableCount <= 0;
    controls.appendChild(addSelected);
    const addPack = createButton('Add Pack to Pending Lore', `Adds all new entries in ${activePack.label} to Pending Lore Review.`, async (btn) => {
        await handleAddCanonPreviewEntries(btn, addablePackIds);
    }, 'wandlight-secondary-button');
    addPack.disabled = isStale || addablePackIds.length <= 0;
    controls.appendChild(addPack);
    section.appendChild(controls);

    const list = document.createElement('div');
    list.className = 'wandlight-canon-preview-list';
    const visibleEntries = packEntries.slice(0, 80);
    visibleEntries.forEach(entry => {
        list.appendChild(createCanonPreviewEntryRow(entry, selectedIds, isStale));
    });
    if (!visibleEntries.length) {
        list.appendChild(createEmptyMessage(`No ${activePack.label} entries at the ${detailLevel === 'all' ? 'All Active' : detailLevel} detail level.`));
    }
    if (packEntriesAll.length > packEntries.length) {
        const hidden = document.createElement('div');
        hidden.className = 'wandlight-runtime-help wandlight-compact-help';
        hidden.textContent = `${packEntriesAll.length - packEntries.length} entries hidden by the current detail level. Switch to Detailed or All Active to inspect them.`;
        list.appendChild(hidden);
    }
    if (packEntries.length > visibleEntries.length) {
        const note = document.createElement('div');
        note.className = 'wandlight-runtime-help wandlight-compact-help';
        note.textContent = `Showing first ${visibleEntries.length} of ${packEntries.length}. Select Pack still selects every new entry in this pack.`;
        list.appendChild(note);
    }
    section.appendChild(list);
    return section;
}

function createCanonPreviewEntryRow(entry, selectedIds, isStale = false) {
    const id = String(entry?.id || '');
    const duplicateStatus = entry?.extensions?.canonPreview?.duplicateStatus || 'new';
    const duplicateReason = entry?.extensions?.canonPreview?.duplicateReason || '';
    const addable = !isStale && duplicateStatus === 'new';
    const row = document.createElement('label');
    row.className = `wandlight-canon-preview-row ${selectedIds.has(id) ? 'wandlight-canon-preview-row-selected' : ''} ${addable ? '' : 'wandlight-canon-preview-row-disabled'}`.trim();

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selectedIds.has(id);
    checkbox.disabled = !addable;
    checkbox.addEventListener('change', (event) => {
        event.stopPropagation();
        const next = getCanonPreviewSelectedIds();
        if (checkbox.checked) next.add(id);
        else next.delete(id);
        setCanonPreviewSelectedIds(Array.from(next));
        refreshPanelBody({ preserveScroll: true });
    });
    row.appendChild(checkbox);

    const main = document.createElement('div');
    main.className = 'wandlight-canon-preview-row-main';
    const title = document.createElement('div');
    title.className = 'wandlight-canon-preview-row-title';
    title.textContent = entry?.title || 'Canon lore';
    main.appendChild(title);

    const text = document.createElement('div');
    text.className = 'wandlight-canon-preview-row-text';
    text.textContent = getCanonPreviewEntrySummary(entry);
    main.appendChild(text);

    const meta = document.createElement('div');
    meta.className = 'wandlight-lore-entry-meta wandlight-canon-preview-row-meta';
    const previewMeta = entry?.extensions?.canonPreview || {};
    if (entry?.category) meta.appendChild(createBadge(entry.category, 'Canon entry category.'));
    if (entry?.lorePurpose) meta.appendChild(createBadge(LORE_PURPOSE_LABELS[entry.lorePurpose] || entry.lorePurpose, 'Why this canon entry would be useful.'));
    if (previewMeta.suggestionRole) meta.appendChild(createBadge(previewMeta.suggestionRole.replace(/_/g, ' '), 'Canon preview role used for pack sorting.'));
    if (previewMeta.detailLevel) meta.appendChild(createBadge(previewMeta.detailLevel, 'Canon preview detail tier.'));
    if (previewMeta.suggestByDefault === false) meta.appendChild(createBadge('non-default', 'Shown only in All Active or higher-detail review because this is not usually worth suggesting automatically.'));
    if (entry?.relevance) meta.appendChild(createBadge(entry.relevance, 'Recommended relevance tier for Pending Lore Review.'));
    meta.appendChild(createBadge(`P${Number(entry?.priority || 50)}`, 'Canon database priority.'));
    if (duplicateStatus !== 'new') {
        meta.appendChild(createBadge(duplicateStatus, duplicateReason || 'Already present by id/title.'));
    }
    main.appendChild(meta);

    row.appendChild(main);
    return row;
}

function createStoryLoreGenerationPanel(state) {
    const panel = document.createElement('div');
    panel.className = 'wandlight-lore-generation-panel wandlight-story-lore-generation-panel';

    const header = document.createElement('div');
    header.className = 'wandlight-lore-generation-panel-title';
    header.textContent = 'Scan Story Lore';
    addTooltip(header, 'Uses the Reasoning provider to scan chat messages and create story-specific lore entries for Pending Lore Review. The scan can cover recent messages, a custom range, or the entire chat.');
    panel.appendChild(header);

    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help wandlight-lore-scan-help';
    help.textContent = 'Model-based story scan. Uses resumable chunks, partial saves, retries, and configurable scan ranges. Output stays pending until accepted.';
    panel.appendChild(help);

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions wandlight-generation-actions';
    const scanBtn = createButton('Scan Story Lore', 'Scans the configured message range, processes chunks in parallel, and appends generated story-specific lore into Pending Lore Review as chunks complete.', async (btn) => {
        await handleBulkGeneratePendingLore(btn);
    }, 'wandlight-primary-button');
    if (loreGenerationUiRunning || activeLoreGenerationController) {
        scanBtn.disabled = true;
        scanBtn.textContent = 'Scan Running...';
    }
    actions.appendChild(scanBtn);

    const cancelBtn = createButton('Cancel Scan', 'Cancels the current story-lore scan after active provider requests return or abort.', () => {
        if (activeLoreGenerationController) {
            activeLoreGenerationController.abort();
            setFeatureProgress('lore', 'Cancelling story lore scan...', Math.max(1, Number(getState()?.lorePanel?.loreProgress) || 1));
        }
    }, 'wandlight-danger-button');
    cancelBtn.disabled = !activeLoreGenerationController;
    actions.appendChild(cancelBtn);
    panel.appendChild(actions);

    appendGenerationStatus(panel, state, 'lore');
    const resultsCard = createBulkLoreLedgerStatusCard(state);
    if (resultsCard) panel.appendChild(resultsCard);

    panel.appendChild(createCollapsibleSection(
        'lore.storyGenerationSettings',
        'Story Lore Scan Settings',
        getLoreScanSettingsSummary(getSettings()),
        false,
        createStoryLoreSettingsContent(),
        { tooltip: 'Advanced model-based story-lore scan controls. Most users can leave these defaults unchanged.', className: 'wandlight-story-lore-settings-collapsible' }
    ));

    return panel;
}

function getLoreScanSettingsSummary(settings = getSettings()) {
    const mode = settings.loreBulkScanMode || 'recent';
    const label = mode === 'entire' ? 'entire chat' : (mode === 'range' ? 'custom range' : `last ${settings.loreSourceMessageCount || 40}`);
    return `${label} · ${settings.loreBulkChunkSize || 10}/chunk · ${settings.loreBulkConcurrency || 3} parallel`;
}

function createStoryLoreSettingsContent() {
    const settings = getSettings();
    const wrap = document.createElement('div');
    wrap.className = 'wandlight-story-lore-settings-content';

    wrap.appendChild(createCollapsibleSection(
        'lore.story.scanScope',
        'Scan Scope',
        getLoreScanScopeSummary(settings),
        true,
        createLoreScanScopeSettingsContent(),
        { tooltip: 'Choose which chat messages are scanned for story lore.', className: 'wandlight-compact-subsection wandlight-lore-scan-scope-subsection' }
    ));

    wrap.appendChild(createCollapsibleSection(
        'lore.story.performance',
        'Performance',
        getLoreScanPerformanceSummary(settings),
        false,
        createLoreScanPerformanceSettingsContent(),
        { tooltip: 'Controls throughput, chunk size, overlap, and retry behavior for story-lore scanning.', className: 'wandlight-compact-subsection' }
    ));

    wrap.appendChild(createCollapsibleSection(
        'lore.story.quality',
        'Generation Quality',
        getLoreScanQualitySummary(settings),
        false,
        createLoreScanQualitySettingsContent(),
        { tooltip: 'Controls breadth, generated fact count, tags, and duplicate filtering.', className: 'wandlight-compact-subsection' }
    ));

    wrap.appendChild(createCollapsibleSection(
        'lore.story.automation',
        'Automation',
        settings.loreGenerationMode === 'automatic' ? `every ${settings.loreGenerationAutoInterval || 10} turns` : 'manual',
        false,
        createAutomationModeCard(
            'Story Lore Scan',
            'loreGenerationMode',
            'loreGenerationAutoInterval',
            'Only scans when you click Scan Story Lore.',
            'Runs automatically after roleplay turns on this interval, using the Reasoning provider. Generated lore still waits in Pending Lore Review.',
            'Automatic story-lore scan interval in completed model turns.'
        ),
        { tooltip: 'Optional automatic story-lore scanning after roleplay turns.', className: 'wandlight-compact-subsection' }
    ));

    return wrap;
}

function getLoreScanScopeSummary(settings = getSettings()) {
    const mode = settings.loreBulkScanMode || 'recent';
    if (mode === 'entire') return 'entire chat';
    if (mode === 'range') return `${settings.loreBulkRangeStart || 1}-${settings.loreBulkRangeEnd || 'latest'}`;
    return `last ${settings.loreSourceMessageCount || 40}`;
}

function getLoreScanPerformanceSummary(settings = getSettings()) {
    return `${settings.loreBulkChunkSize || 10}/chunk · ${settings.loreBulkConcurrency || 3} simultaneous`;
}

function getLoreScanQualitySummary(settings = getSettings()) {
    return `${settings.loreBulkFactsPerChunk || 14} facts/chunk · ${(settings.loreGenerationBreadthMode || 'auto')}`;
}

function createLoreScanScopeSettingsContent() {
    const settings = getSettings();
    const content = document.createElement('div');
    content.className = 'wandlight-lore-scan-settings-block';

    const grid = document.createElement('div');
    grid.className = 'wandlight-runtime-grid wandlight-lore-scan-compact-grid';
    grid.appendChild(createSelectSettingRow(
        'Scan range',
        'Controls which messages Scan Story Lore processes. Recent uses Lore source messages; Custom uses explicit 1-based message indexes; Entire scans the whole chat.',
        'loreBulkScanMode',
        [
            ['recent', 'Recent messages'],
            ['range', 'Custom range'],
            ['entire', 'Entire chat'],
        ]
    ));
    grid.appendChild(createNumberSettingRow('Start', 'First 1-based message index used when Scan range is Custom range.', 'loreBulkRangeStart', { min: 1, max: 100000, fallback: 1 }));
    grid.appendChild(createNumberSettingRow('End', 'Last 1-based message index used when Scan range is Custom range. Use 0 to mean latest message.', 'loreBulkRangeEnd', { min: 0, max: 100000, fallback: 0 }));
    content.appendChild(grid);

    const sourceRow = document.createElement('label');
    sourceRow.className = 'wandlight-slider-row wandlight-compact-slider-row wandlight-lore-scan-setting-row';
    const sourceText = document.createElement('span');
    sourceText.textContent = `Recent window: ${settings.loreSourceMessageCount || 40}`;
    addTooltip(sourceText, 'How many recent chat messages are scanned when Scan range is Recent messages.');
    const sourceInput = document.createElement('input');
    sourceInput.type = 'range';
    sourceInput.min = '4';
    sourceInput.max = '200';
    sourceInput.step = '1';
    sourceInput.value = String(settings.loreSourceMessageCount || 40);
    sourceInput.addEventListener('input', () => {
        const next = getSettings();
        next.loreSourceMessageCount = Math.max(4, Math.min(200, parseInt(sourceInput.value, 10) || 40));
        saveSettings(next);
        sourceText.textContent = `Recent window: ${next.loreSourceMessageCount}`;
    });
    sourceRow.appendChild(sourceText);
    sourceRow.appendChild(sourceInput);
    content.appendChild(sourceRow);

    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help wandlight-compact-help';
    help.textContent = 'Use Custom range for backfilling old story sections. Use Entire chat for first-time setup on an existing story.';
    content.appendChild(help);
    return content;
}

function createLoreScanPerformanceSettingsContent() {
    const content = document.createElement('div');
    content.className = 'wandlight-lore-scan-settings-block';
    content.appendChild(createRangeSettingRow('Chunk size', 'Messages per scan chunk. Smaller chunks parse more reliably; larger chunks reduce provider calls.', 'loreBulkChunkSize', { min: 3, max: 50, fallback: 10 }));
    content.appendChild(createRangeSettingRow('Overlap', 'Messages repeated at chunk boundaries to preserve facts that span two intervals. Must be lower than chunk size.', 'loreBulkOverlap', { min: 0, max: 10, fallback: 1 }));
    content.appendChild(createRangeSettingRow('Simultaneous chunks', 'Maximum number of story-lore chunks submitted to the Reasoning provider at the same time.', 'loreBulkConcurrency', { min: 1, max: 8, fallback: 3 }));
    content.appendChild(createRangeSettingRow('Retry attempts', 'Chunk-level retry attempts after empty, malformed, or failed extraction responses.', 'loreBulkRetryAttempts', { min: 0, max: 4, fallback: 2 }));
    content.appendChild(createRangeSettingRow('Save checkpoint every chunks', 'How often the scan writes a full compact checkpoint after lightweight per-chunk saves. Lower is safer; higher reduces persistence overhead.', 'loreBulkFullCheckpointEveryChunks', { min: 1, max: 25, fallback: 5 }));
    content.appendChild(createRangeSettingRow('Consolidate every chunks', 'How many completed chunks to collect before converting extracted facts into Pending Lore entries.', 'loreBulkConsolidationChunkWindow', { min: 1, max: 25, fallback: 5 }));

    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help wandlight-compact-help';
    help.textContent = 'Each chunk still checkpoints immediately for recovery. Full saves and Pending Lore consolidation happen in batches to reduce large-scan overhead.';
    content.appendChild(help);
    return content;
}

function createLoreScanQualitySettingsContent() {
    const settings = getSettings();
    const content = document.createElement('div');
    content.className = 'wandlight-lore-scan-settings-block';

    const modeRow = document.createElement('label');
    modeRow.className = 'wandlight-setting-row wandlight-lore-scan-setting-row';
    const modeLabel = document.createElement('span');
    modeLabel.textContent = 'Scan breadth';
    addTooltip(modeLabel, 'Auto uses bootstrap mode for manual first-runs when accepted story-specific lore is sparse, then incremental mode for maintenance. Bootstrap targets broad story coverage; incremental targets only new or changed facts.');
    const modeSelect = document.createElement('select');
    modeSelect.className = 'text_pole';
    [
        ['auto', 'Auto'],
        ['bootstrap', 'Bootstrap'],
        ['incremental', 'Incremental'],
    ].forEach(([value, label]) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        if ((settings.loreGenerationBreadthMode || 'auto') === value) option.selected = true;
        modeSelect.appendChild(option);
    });
    modeSelect.addEventListener('change', () => {
        const next = getSettings();
        next.loreGenerationBreadthMode = modeSelect.value;
        saveSettings(next);
        refreshPanelBody({ preserveScroll: true });
    });
    modeRow.appendChild(modeLabel);
    modeRow.appendChild(modeSelect);
    content.appendChild(modeRow);

    content.appendChild(createRangeSettingRow('Facts per chunk', 'Upper target for compact facts extracted per chunk before conversion into Pending Lore entries.', 'loreBulkFactsPerChunk', { min: 4, max: 30, fallback: 14 }));
    content.appendChild(createRangeSettingRow('Bootstrap target', 'Approximate total pending entries targeted during broad first-run story-lore scan.', 'loreBootstrapTargetEntries', { min: 12, max: 120, fallback: 40 }));
    content.appendChild(createRangeSettingRow('Incremental target', 'Approximate total pending entries targeted during incremental story-lore scan.', 'loreIncrementalTargetEntries', { min: 3, max: 30, fallback: 8 }));
    content.appendChild(createRangeSettingRow('Generated tags', 'Number of short searchable tags requested per generated lore entry. Set to 0 to disable generated tags.', 'loreTagCount', { min: 0, max: 10, fallback: 4 }));

    const grid = document.createElement('div');
    grid.className = 'wandlight-runtime-grid wandlight-lore-scan-compact-grid';
    grid.appendChild(createToggleCard(
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
    grid.appendChild(createToggleCard(
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
    content.appendChild(grid);

    const rescanRow = createSelectSettingRow(
        'What to rescan',
        'Controls whether Scan Story Lore skips unchanged completed chunks, retries failed chunks, rescans stale edited chunks, or rescans all chunks.',
        'loreBulkRescanMode',
        [
            ['skip_unchanged', 'Skip unchanged'],
            ['retry_failed', 'Retry failed only'],
            ['stale_only', 'Rescan edited only'],
            ['rescan_all', 'Rescan all'],
        ]
    );
    content.appendChild(rescanRow);

    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help wandlight-compact-help';
    help.textContent = 'Priority and final review still happen in Pending Lore Review. Generated entries are not accepted automatically.';
    content.appendChild(help);
    return content;
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

async function ensureStoryContextForCanonAction(actionLabel = 'Canon lore') {
    let state = getState();
    if (hasUsableStoryContext(state?.loreContext || {})) {
        return state;
    }

    const proceed = await confirmAction(
        'No Story Context detected',
        `${actionLabel} needs the story date, canon boundary, and branch. Run Detect Story Context now?`
    );
    if (!proceed) {
        setFeatureProgress('canon', `${actionLabel} cancelled: no Story Context.`, 0);
        return null;
    }

    setFeatureProgress('canon', 'Detecting Story Context before querying canon lore...', 5);
    const detected = await performStoryContextDetection({ stayOnTab: 'lore' });
    state = getState();
    if (!detected || !hasUsableStoryContext(state?.loreContext || {})) {
        setFeatureProgress('canon', 'No Story Context available. Canon lore was not queried.', 100);
        toast('Canon lore needs Story Context before it can run.', 'warning');
        return null;
    }
    return state;
}

async function handlePreviewCanonLorePacks(btn) {
    await runBusyAction(btn, 'Previewing...', async () => {
        const state = await ensureStoryContextForCanonAction('Canon pack preview');
        if (!state) return;

        setFeatureProgress('canon', 'Previewing canon packs from local database...', 20);
        const result = await previewCanonLoreForContext(state?.loreContext || {}, { maxCandidates: 500 });
        canonPreviewUiState = {
            contextKey: getCanonPreviewContextKey(getState()?.loreContext || {}),
            preview: result,
            selectedPackId: (result?.packs || []).find(pack => pack.newCount > 0)?.id || result?.packs?.[0]?.id || '',
            selectedEntryIds: [],
            detailLevel: getCanonPreviewDetailLevel(),
        };

        refreshPanelBody({ preserveScroll: false });
        refreshHeader();

        if (result?.status === 'preview') {
            setFeatureProgress('canon', `Previewed ${result.packs?.length || 0} canon packs with ${result.newCount || 0} new entries.`, 100);
            resetFeatureProgress('canon');
            toast(`Previewed ${result.packs?.length || 0} canon packs. Select entries to add to Pending Lore Review.`, 'info');
        } else if (result?.status === 'no_date') {
            setFeatureProgress('canon', 'No parseable Story Context date. Detect or enter a scene date first.', 100);
            toast('Canon pack preview needs a parseable Scene date first.', 'warning');
        } else if (result?.status === 'disabled') {
            setFeatureProgress('canon', 'Canon database is disabled.', 100);
            toast('Canon database is disabled.', 'warning');
        } else {
            setFeatureProgress('canon', 'No matching canon packs for this context.', 100);
            resetFeatureProgress('canon');
            toast('Canon database found no matching entries for this context.', 'info');
        }
    });
}

async function handleAddCanonPreviewEntries(btn, entryIds = []) {
    const ids = Array.from(new Set((entryIds || []).map(id => String(id || '')).filter(Boolean)));
    if (!ids.length) {
        toast('Select at least one new canon preview entry first.', 'warning');
        return;
    }

    await runBusyAction(btn, 'Adding...', async () => {
        const state = await ensureStoryContextForCanonAction('Adding canon preview entries');
        if (!state) return;

        setFeatureProgress('canon', 'Adding selected canon entries to Pending Lore Review...', 35);
        const result = await addCanonLorePreviewEntriesToPending(ids, state?.loreContext || {}, { maxCandidates: 500 });
        if (result?.status === 'proposed') {
            canonPreviewUiState = {
                contextKey: '',
                preview: null,
                selectedPackId: '',
                selectedEntryIds: [],
                detailLevel: getCanonPreviewDetailLevel(),
            };
            setSectionCollapsed('lore.pendingReview', false);
            setPanelState({ activeTab: 'lore' }, { deferSave: true });
            refreshPanelBody({ preserveScroll: false });
            refreshHeader();
            setFeatureProgress('canon', `Added ${result.proposedCount || 0} canon entries to Pending Lore Review.`, 100);
            resetFeatureProgress('canon');
            toast(`Added ${result.proposedCount || 0} canon entries to Pending Lore Review.`);
        } else if (result?.status === 'duplicates_only') {
            setFeatureProgress('canon', 'Selected canon entries were already pending or accepted.', 100);
            resetFeatureProgress('canon');
            refreshHeader();
            toast('Selected canon entries were already pending or accepted.', 'info');
        } else if (result?.status === 'disabled') {
            setFeatureProgress('canon', 'Canon database is disabled.', 100);
            toast('Canon database is disabled.', 'warning');
        } else if (result?.status === 'no_date') {
            setFeatureProgress('canon', 'No parseable Story Context date. Canon entries were not added.', 100);
            toast('Canon entries need a parseable Scene date first.', 'warning');
        } else {
            setFeatureProgress('canon', 'No selected canon entries were added.', 100);
            resetFeatureProgress('canon');
            toast('No selected canon entries were added.', 'info');
        }
    });
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


function createBulkLoreLedgerStatusCard(state) {
    const ledger = state?.loreBulkGeneration || {};
    const batchId = ledger.activeBatchId || ledger.lastBatchId || '';
    const batch = batchId ? ledger.batches?.[batchId] : null;
    if (!batch) return null;

    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card wandlight-bulk-lore-status-card';

    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = 'Lore Scan Results';
    addTooltip(title, 'Shows the latest story-lore scan result, including completed chunks, failed chunks, extracted candidate facts, and Pending Lore Review entries.');
    card.appendChild(title);

    const status = String(batch.status || 'unknown');
    const queued = batch.queuedChunks || batch.totalChunks || 0;
    const completed = batch.completedChunks || 0;
    const failed = batch.failedChunks || 0;
    const candidateCount = batch.candidateCount || 0;
    const pendingCount = batch.pendingEntryCount || (state?.pendingLoreEntries || []).length || 0;

    const summary = document.createElement('div');
    summary.className = 'wandlight-runtime-help wandlight-lore-scan-results-summary';
    summary.textContent = `${status} · ${completed}/${queued} chunks · ${candidateCount} facts · ${pendingCount} pending${failed ? ` · ${failed} failed` : ''}`;
    card.appendChild(summary);

    const grid = document.createElement('div');
    grid.className = 'wandlight-runtime-grid wandlight-lore-scan-results-grid';
    grid.appendChild(createKeyValue('Range', `${batch.rangeStart || '?'}-${batch.rangeEnd || '?'}`, 'Message index range scanned.'));
    grid.appendChild(createKeyValue('Chunks', `${completed}/${queued}`, 'Completed queued chunks over total queued chunks.'));
    grid.appendChild(createKeyValue('Failed', String(failed), 'Chunks that failed after retry attempts and can be retried with What to rescan: Retry failed only.'));
    grid.appendChild(createKeyValue('Facts', String(candidateCount), 'Compact extracted candidate facts stored for this scan.'));
    grid.appendChild(createKeyValue('Pending', String(pendingCount), 'Pending Lore Review entries after scan commits.'));
    card.appendChild(grid);
    return card;
}

async function handleBulkGeneratePendingLore(btn) {
    if (loreGenerationUiRunning || activeLoreGenerationController) {
        toast('Lore generation is already running. Use Cancel Scan to stop it.', 'warning');
        return;
    }
    if (!ensureLoreProviderReadyForAction('Scan Story Lore', 'lore')) return;
    activeLoreGenerationController = new AbortController();
    loreGenerationUiRunning = true;
    refreshPanelBody({ preserveScroll: true });
    await runBusyAction(btn, 'Scanning...', async () => {
        setFeatureProgress('lore', 'Starting story lore scan...', 5);
        const result = await runBulkLoreGeneration({
            force: true,
            signal: activeLoreGenerationController?.signal,
            progress: (message, percent) => setFeatureProgress('lore', message, percent),
        });
        refreshHeader();

        if (result?.status === 'cancelled') {
            refreshPanelBody({ preserveScroll: true });
            setFeatureProgress('lore', 'Story lore scan cancelled.', 0);
            toast('Story lore scan cancelled.', 'warning');
        } else if (['complete', 'partial'].includes(result?.status)) {
            setSectionCollapsed('lore.pendingReview', false);
            setPanelState({ activeTab: 'lore' });
            refreshPanelBody({ preserveScroll: false });
            const failedText = result.failedChunkCount ? ` ${result.failedChunkCount} chunk${result.failedChunkCount === 1 ? '' : 's'} failed and can be retried.` : '';
            const skippedText = result.skippedChunks ? ` ${result.skippedChunks} unchanged chunk${result.skippedChunks === 1 ? '' : 's'} skipped.` : '';
            setFeatureProgress('lore', `Story lore scan ${result.status}: ${result.completedChunkCount || 0} chunks, ${result.candidateCount || 0} candidate facts, ${result.pendingEntryCount || 0} pending entries.`, 100);
            resetFeatureProgress('lore');
            toast(`Story lore scan ${result.status}. ${result.candidateCount || 0} candidate facts extracted; ${result.pendingEntryCount || 0} pending lore entries now available.${failedText}${skippedText}`);
        } else if (result?.status === 'skipped_unchanged') {
            refreshPanelBody({ preserveScroll: true });
            setFeatureProgress('lore', `Story lore scan skipped ${result.skippedChunks || 0} unchanged chunks.`, 100);
            resetFeatureProgress('lore');
            toast('Story lore scan found no changed chunks to process.', 'info');
        } else {
            refreshPanelBody({ preserveScroll: true });
            const details = formatGenerationStatus(result);
            toast(details, 'warning');
        }
    });
    activeLoreGenerationController = null;
    loreGenerationUiRunning = false;
    refreshPanelBody({ preserveScroll: true });
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
        'Use Local Canon Database',
        settings.canonLoreDatabaseEnabled !== false,
        'Allows manual previews, quick queries, and optional auto-suggest to query local pre-generated canon lore files.',
        (checked) => {
            const next = getSettings();
            next.canonLoreDatabaseEnabled = checked;
            saveSettings(next);
            refreshPanelBody({ preserveScroll: true });
        }
    ));
    grid.appendChild(createToggleCard(
        'Auto-suggest After Detection',
        settings.canonLoreAutoPropose !== false,
        'When enabled, a Story Context detection run also performs the quick top-match canon proposal. It does not affect manual pack previews.',
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
    maxText.textContent = `Quick/auto add cap: ${settings.canonLoreMaxEntries || 12}`;
    addTooltip(maxText, 'Maximum entries used only by quick query and auto-suggest after Story Context detection. Pack preview counts are not capped by this slider.');
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
        maxText.textContent = `Quick/auto add cap: ${next.canonLoreMaxEntries}`;
    });
    maxRow.appendChild(maxText);
    maxRow.appendChild(maxInput);
    card.appendChild(maxRow);

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions';
    actions.appendChild(createButton('Quick Add Top Matches', 'Uses the current Story Context fields to query local canon lore and propose the capped top matches into Pending Lore Review.', async (btn) => {
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
    help.textContent = 'Canon reference point means the latest canon knowledge the roleplay should treat as established, such as “through Prisoner of Azkaban” or “before the Triwizard Tournament.” If it stays “not detected,” set it manually or leave it blank for story-original scenes.';
    card.appendChild(help);

    const grid = document.createElement('div');
    grid.className = 'wandlight-runtime-grid wandlight-context-grid';
    grid.appendChild(createTextSettingField('Scene date', state?.loreContext?.sceneDate || '', 'Example: September 1, 1996. Used for date-sensitive lore.', (value) => updateLoreContextField('sceneDate', value)));
    grid.appendChild(createTextSettingField('Canon reference point', state?.loreContext?.canonBoundary || '', 'Example: Through Chapter 14 of Half-Blood Prince. Used to avoid using future canon prematurely.', (value) => updateLoreContextField('canonBoundary', value)));
    grid.appendChild(createTextSettingField('Branch', state?.loreContext?.branchId || 'main', 'Use “main” for the primary timeline, or a custom branch name for story/time-travel branches.', (value) => updateLoreContextField('branchId', value || 'main')));
    card.appendChild(grid);

    card.appendChild(createKeyValue('Last detected', state?.loreContext?.lastDetectedAt ? new Date(state.loreContext.lastDetectedAt).toLocaleString() : 'never', 'When Story Context was last detected automatically. Manual edits also affect generation immediately.'));
    return card;
}


function createSelectSettingRow(labelText, tooltip, settingKey, options, onChange = null) {
    const settings = getSettings();
    const row = document.createElement('label');
    row.className = 'wandlight-setting-row';
    const label = document.createElement('span');
    label.textContent = labelText;
    addTooltip(label, tooltip);
    const select = document.createElement('select');
    select.className = 'text_pole';
    for (const [value, text] of options) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        if (String(settings[settingKey]) === String(value)) option.selected = true;
        select.appendChild(option);
    }
    select.addEventListener('change', () => {
        const next = getSettings();
        next[settingKey] = select.value;
        saveSettings(next);
        if (typeof onChange === 'function') onChange(select.value);
        refreshPanelBody({ preserveScroll: true });
    });
    row.appendChild(label);
    row.appendChild(select);
    return row;
}

function createNumberSettingRow(labelText, tooltip, settingKey, { min = 0, max = 9999, fallback = 0 } = {}) {
    const settings = getSettings();
    const row = document.createElement('label');
    row.className = 'wandlight-setting-row';
    const label = document.createElement('span');
    label.textContent = labelText;
    addTooltip(label, tooltip);
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'text_pole';
    input.min = String(min);
    input.max = String(max);
    input.step = '1';
    input.value = String(settings[settingKey] ?? fallback);
    input.addEventListener('change', () => {
        const next = getSettings();
        const parsed = parseInt(input.value, 10);
        next[settingKey] = Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : fallback));
        input.value = String(next[settingKey]);
        saveSettings(next);
    });
    row.appendChild(label);
    row.appendChild(input);
    return row;
}

function createRangeSettingRow(labelPrefix, tooltip, settingKey, { min = 0, max = 100, fallback = 0, suffix = '' } = {}) {
    const settings = getSettings();
    const row = document.createElement('label');
    row.className = 'wandlight-slider-row wandlight-compact-slider-row';
    const text = document.createElement('span');
    const rawValue = settings[settingKey] ?? fallback;
    const numericValue = Number.isFinite(Number(rawValue)) ? Number(rawValue) : fallback;
    const currentValue = Math.max(min, Math.min(max, numericValue));
    text.textContent = `${labelPrefix}: ${currentValue}${suffix}`;
    addTooltip(text, tooltip);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = '1';
    input.value = String(currentValue);
    input.addEventListener('input', () => {
        const next = getSettings();
        {
            const parsed = parseInt(input.value, 10);
            next[settingKey] = Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : fallback));
        }
        saveSettings(next);
        text.textContent = `${labelPrefix}: ${next[settingKey]}${suffix}`;
    });
    row.appendChild(text);
    row.appendChild(input);
    return row;
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
    if (!result) return 'Story lore scan ended without a result.';
    const modeText = result.generationMode ? `${result.generationMode} mode` : 'story-lore scan';
    const targetText = result.targetEntryCount ? ` Target: ${result.targetEntryCount}.` : '';
    if (result.status === 'empty_valid_entries') {
        if (result.droppedDuplicateCount) {
            return `Scan in ${modeText} produced ${result.normalizedEntryCount || result.rawEntryCount || 0} normalized entries, but all were duplicate/similar (${result.droppedDuplicateCount} filtered). Try disabling Duplicate Guard or broadening Source Messages.`;
        }
        return `Scan in ${modeText} returned ${result.rawEntryCount || 0} raw entries, but none matched the Wandlight lore schema after normalization.${targetText}`;
    }
    if (result.status === 'failed_parse') return 'Story lore scan returned malformed JSON that could not be repaired.';
    if (result.status === 'failed_no_response') return result.chunkCount ? `Story lore scan in ${modeText} returned no usable responses across ${result.chunkCount} chunk(s). Check provider connection, model output format, max tokens, or reduce chunk size.${targetText}` : 'Story lore scan returned an empty response from the selected model/provider.';
    if (result.status === 'api_not_configured') return `API/model settings incomplete: ${result.error || 'missing provider settings'}`;
    if (result.status === 'no_context_detected') return 'No story context could be detected. Set Story Context manually or increase the scan range.';
    return `Story lore scan ended with status: ${result.status || 'unknown'}`;
}



// Continuity tab --------------------------------------------------------------

const CONTINUITY_SECTION_LABELS = {
    canon: 'Timeline / Date',
    scene: 'Scene',
    characters: 'Active Characters',
    appearance: 'Appearance Detail',
    emotionalState: 'Emotional State',
    inventory: 'Key Items',
    objectives: 'Active Goals',
    threads: 'Active Threads',
};


function getContinuityScanScopeSummary(settings = getSettings()) {
    const mode = settings.continuityScanMode || 'recent';
    if (mode === 'entire') return 'entire chat';
    if (mode === 'range') return `${settings.continuityScanRangeStart || 1}-${settings.continuityScanRangeEnd || 'latest'}`;
    return `last ${settings.continuitySourceMessageCount || 10}`;
}

function getContinuityScanPerformanceSummary(settings = getSettings()) {
    const strategy = settings.continuityScanStrategy || 'adaptive';
    const fast = settings.continuityScanFastThreshold || 20;
    const hybrid = settings.continuityScanHybridThreshold || 80;
    return `${strategy} · fast ≤${fast} · hybrid ≤${hybrid}`;
}

function getContinuityScanResultsSummary(state = getState()) {
    const ledger = state?.continuityScan || {};
    const batch = ledger.lastBatchId ? ledger.batches?.[ledger.lastBatchId] : null;
    if (!batch) return 'no scan results yet';
    const status = batch.status || 'unknown';
    const completed = Number(batch.completedChunks || 0);
    const failed = Number(batch.failedChunks || 0);
    const observations = Number(batch.observationCount || 0);
    return `${status} · ${completed} complete · ${failed} failed · ${observations} observations`;
}

function createContinuityScanScopeSettingsContent() {
    const settings = getSettings();
    const content = document.createElement('div');
    content.className = 'wandlight-lore-scan-settings-block';

    const grid = document.createElement('div');
    grid.className = 'wandlight-runtime-grid wandlight-lore-scan-compact-grid';
    grid.appendChild(createSelectSettingRow(
        'Scan range',
        'Controls which messages Scan Continuity State processes. Recent is safest for routine use; Custom and Entire are for backfilling or repair scans.',
        'continuityScanMode',
        [
            ['recent', 'Recent messages'],
            ['range', 'Custom range'],
            ['entire', 'Entire chat'],
        ]
    ));
    grid.appendChild(createNumberSettingRow('Start', 'First 1-based message index used when Scan range is Custom range.', 'continuityScanRangeStart', { min: 1, max: 100000, fallback: 1 }));
    grid.appendChild(createNumberSettingRow('End', 'Last 1-based message index used when Scan range is Custom range. Use 0 to mean latest message.', 'continuityScanRangeEnd', { min: 0, max: 100000, fallback: 0 }));
    content.appendChild(grid);

    const sourceRow = document.createElement('label');
    sourceRow.className = 'wandlight-slider-row wandlight-compact-slider-row wandlight-lore-scan-setting-row';
    const sourceText = document.createElement('span');
    sourceText.textContent = `Recent window: ${settings.continuitySourceMessageCount || 10}`;
    addTooltip(sourceText, 'How many recent chat messages are scanned when Scan range is Recent messages.');
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
        sourceText.textContent = `Recent window: ${next.continuitySourceMessageCount}`;
    });
    sourceRow.appendChild(sourceText);
    sourceRow.appendChild(sourceInput);
    content.appendChild(sourceRow);

    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help wandlight-compact-help';
    help.textContent = 'Adaptive continuity scans use a single compact delta call for small recent windows, grouped calls for medium ranges, and checkpointed chunks only for large backfills.';
    content.appendChild(help);
    return content;
}

function createContinuityScanPerformanceSettingsContent() {
    const content = document.createElement('div');
    content.className = 'wandlight-lore-scan-settings-block';
    content.appendChild(createSelectSettingRow(
        'Scan strategy',
        'Adaptive uses one fast delta call for small recent scans, grouped hybrid calls for medium ranges, and the checkpointed bulk pipeline for large backfills.',
        'continuityScanStrategy',
        [
            ['adaptive', 'Adaptive'],
            ['fast', 'Always fast'],
            ['hybrid', 'Always hybrid'],
            ['bulk', 'Always bulk/checkpointed'],
        ]
    ));
    content.appendChild(createRangeSettingRow('Fast threshold', 'Adaptive scans at or below this message count use the single-call fast continuity delta path.', 'continuityScanFastThreshold', { min: 1, max: 200, fallback: 20 }));
    content.appendChild(createRangeSettingRow('Hybrid threshold', 'Adaptive scans above the fast threshold and at or below this count use grouped hybrid delta calls. Larger scans use the checkpointed bulk path.', 'continuityScanHybridThreshold', { min: 20, max: 500, fallback: 80 }));
    content.appendChild(createRangeSettingRow('Fast max tokens', 'Maximum output tokens for the fast single-call continuity scan.', 'continuityFastMaxTokens', { min: 512, max: 8192, fallback: 2048 }));
    content.appendChild(createRangeSettingRow('Hybrid max tokens', 'Maximum output tokens for each grouped hybrid continuity scan call.', 'continuityHybridMaxTokens', { min: 512, max: 8192, fallback: 3072 }));
    content.appendChild(createRangeSettingRow('Chunk size', 'Messages per continuity observation chunk. Used by the bulk/checkpointed path for large ranges.', 'continuityScanChunkSize', { min: 2, max: 40, fallback: 8 }));
    content.appendChild(createRangeSettingRow('Overlap', 'Messages repeated at chunk boundaries to preserve continuity facts that span intervals.', 'continuityScanOverlap', { min: 0, max: 10, fallback: 1 }));
    content.appendChild(createRangeSettingRow('Simultaneous chunks', 'Maximum continuity observation chunks sent to the Utility provider at the same time.', 'continuityScanConcurrency', { min: 1, max: 8, fallback: 3 }));
    content.appendChild(createRangeSettingRow('Simultaneous reducers', 'Maximum section reducers sent to the Utility provider at the same time after observations are extracted.', 'continuityScanReducerConcurrency', { min: 1, max: 6, fallback: 3 }));
    content.appendChild(createRangeSettingRow('Retry attempts', 'Chunk-level retry attempts after empty, malformed, or failed observation responses.', 'continuityScanRetryAttempts', { min: 0, max: 4, fallback: 2 }));
    content.appendChild(createRangeSettingRow('Observations per chunk', 'Upper target for compact continuity observations extracted from each chunk in the bulk/checkpointed path.', 'continuityScanObservationsPerChunk', { min: 3, max: 30, fallback: 12 }));
    content.appendChild(createRangeSettingRow('Observation max tokens', 'Maximum output tokens for each bulk observation extraction call.', 'continuityObservationMaxTokens', { min: 512, max: 8192, fallback: 1536 }));
    content.appendChild(createRangeSettingRow('Reducer max tokens', 'Maximum output tokens for each bulk section reducer call.', 'continuityReducerMaxTokens', { min: 512, max: 8192, fallback: 1536 }));
    content.appendChild(createRangeSettingRow('Save checkpoint every chunks', 'How often the scan writes a full compact checkpoint after lightweight per-chunk observation saves.', 'continuityScanFullCheckpointEveryChunks', { min: 1, max: 25, fallback: 5 }));

    const rescanRow = createSelectSettingRow(
        'What to rescan',
        'Controls whether Scan Continuity State skips unchanged completed chunks, retries failed chunks, rescans edited chunks, or rescans all chunks.',
        'continuityScanRescanMode',
        [
            ['skip_unchanged', 'Skip unchanged'],
            ['retry_failed', 'Retry failed only'],
            ['stale_only', 'Rescan edited only'],
            ['rescan_all', 'Rescan all'],
        ]
    );
    content.appendChild(rescanRow);

    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help wandlight-compact-help';
    help.textContent = 'Adaptive mode avoids the heavy bulk pipeline for small scans. Chunk checkpoints are still used for large backfills, with prompt injection sync deferred until the final delta is applied or stored for review.';
    content.appendChild(help);
    return content;
}

function createContinuityScanResultsCard(state) {
    const ledger = state?.continuityScan || {};
    const batch = ledger.lastBatchId ? ledger.batches?.[ledger.lastBatchId] : null;
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card wandlight-generation-results-card';

    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = 'Continuity Scan Results';
    addTooltip(title, 'Recoverable results from the latest checkpointed continuity scan.');
    card.appendChild(title);

    if (!batch) {
        card.appendChild(createEmptyMessage('No continuity scan has run yet.'));
        return card;
    }

    card.appendChild(createKeyValue('Status', batch.status || 'unknown', 'Latest scan batch status.'));
    card.appendChild(createKeyValue('Strategy', batch.strategy || 'bulk', 'Continuity scan strategy used for this result.'));
    if (batch.modelCallCount !== undefined) card.appendChild(createKeyValue('Model calls', String(batch.modelCallCount || 0), 'Expected direct model calls used by this strategy, excluding JSON repair retries.'));
    card.appendChild(createKeyValue('Range', `${batch.startIndex || 0}-${batch.endIndex || 0}`, 'Message range used for this scan.'));
    card.appendChild(createKeyValue('Chunks', `${batch.completedChunks || 0} complete / ${batch.failedChunks || 0} failed / ${batch.totalChunks || 0} total`, 'Chunk-level checkpoint status.'));
    card.appendChild(createKeyValue('Observations', String(batch.observationCount || 0), 'Compact observations extracted before reducer passes.'));
    if (Array.isArray(batch.changeKeys) && batch.changeKeys.length) {
        card.appendChild(createKeyValue('Changed sections', batch.changeKeys.join(', '), 'Top-level continuity sections updated by the reduced delta.'));
    }
    if (batch.error) {
        card.appendChild(createKeyValue('Last error', batch.error, 'Latest scan error stored in the checkpoint ledger.'));
    }
    if (batch.completedAt || batch.updatedAt) {
        card.appendChild(createKeyValue('Updated', new Date(batch.completedAt || batch.updatedAt).toLocaleString(), 'Last time this scan batch was updated.'));
    }
    return card;
}

function createContinuityScanCard(state) {
    const settings = getSettings();
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card wandlight-generation-progress-card';

    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = 'Continuity Scan';
    addTooltip(title, 'Adaptive continuity scanning: small scans use one fast delta call, medium scans use grouped section calls, and large scans use the checkpointed bulk pipeline.');
    card.appendChild(title);

    card.appendChild(createAutomationModeCard(
        'Continuity Tracking',
        'continuityTrackingMode',
        'continuityAutoInterval',
        'Continuity scans only run when you click Scan Continuity State.',
        'Wandlight automatically scans recent continuity state every configured number of turns using the Utility provider.',
        'Automatic continuity scan interval in completed model turns.'
    ));

    const settingsWrap = document.createElement('div');
    settingsWrap.className = 'wandlight-lore-scan-settings-wrap';
    settingsWrap.appendChild(createCollapsibleSection(
        'continuity.scanScope',
        'Scan Scope',
        getContinuityScanScopeSummary(settings),
        false,
        createContinuityScanScopeSettingsContent,
        { tooltip: 'Choose recent, custom range, or entire-chat scanning for continuity state.' }
    ));
    settingsWrap.appendChild(createCollapsibleSection(
        'continuity.scanPerformance',
        'Performance and Recovery',
        getContinuityScanPerformanceSummary(settings),
        false,
        createContinuityScanPerformanceSettingsContent,
        { tooltip: 'Chunk size, overlap, parallelism, retry behavior, and checkpoint settings.' }
    ));
    const hasScanResults = !!state?.continuityScan?.lastBatchId;
    if (hasScanResults) {
        settingsWrap.appendChild(createCollapsibleSection(
            'continuity.scanResults',
            'Scan Results',
            getContinuityScanResultsSummary(state),
            false,
            () => createContinuityScanResultsCard(getState()),
            { tooltip: 'Latest checkpointed continuity scan result and recovery status.' }
        ));
    }
    card.appendChild(settingsWrap);

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions';
    actions.appendChild(createButton('Scan Continuity State', 'Scans the selected message range with the adaptive continuity scanner, then applies or stores one ordered continuity state update. Use State History to undo the scan if needed.', async (btn) => {
        if (!ensureContinuityProviderReadyForAction('Scan Continuity State')) return;
        await runBusyAction(btn, 'Scanning...', async () => {
            setFeatureProgress('continuity', 'Scanning continuity state...', 5);
            const result = await onExtractionTriggered({
                force: true,
                applyImmediately: true,
                progress: (message, pct) => setFeatureProgress('continuity', message, pct),
            });
            refreshHeader();
            refreshPanelBody({ preserveScroll: true });

            if (result?.status === 'applied') {
                const keys = result.changeKeys?.length ? ` Updated: ${result.changeKeys.join(', ')}.` : '';
                const chunks = Number(result.completedChunkCount || 0);
                const failed = Number(result.failedChunkCount || 0);
                setFeatureProgress('continuity', `Continuity scan applied.${keys}`, 100);
                resetFeatureProgress('continuity');
                toast(`Continuity state updated from ${chunks} chunk(s)${failed ? `; ${failed} failed` : ''}.${keys}`);
            } else if (result?.status === 'no_changes' || result?.status === 'skipped_unchanged') {
                setFeatureProgress('continuity', 'Continuity scan complete. No state changes detected.', 100);
                resetFeatureProgress('continuity');
                toast(result?.status === 'skipped_unchanged' ? 'Scan skipped unchanged chunks.' : 'Scan complete. No continuity changes detected.', 'info');
            } else if (result?.status === 'pending_review') {
                setFeatureProgress('continuity', 'Continuity scan stored changes for review.', 100);
                resetFeatureProgress('continuity');
                toast('Continuity changes stored for review.', 'info');
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
        'Edit the lightweight live roleplay state Wandlight tracks for the next scene. Durable memory such as knowledge, secrets, milestones, and relationships belongs in Story Lore.'
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

    container.appendChild(createCollapsibleSection('continuity.trackedSections', 'Tracked Sections', 'Enable/disable live-state scan and injection sections', false, createContinuitySectionToggleCard(state), { tooltip: 'Optional lightweight continuity sections for this chat.' }));
    container.appendChild(createCollapsibleSection('continuity.canonScene', 'Scene and Timeline', getContinuityCanonSceneSummary(state), false, createCanonSceneEditorCard(state), { tooltip: 'Current date, scene, cast, and activity fields.' }));
    container.appendChild(createCollapsibleSection('continuity.characters', 'Active Characters', getCountLabel(state.characters || [], 'character'), false, createCharacterStateEditorCard(state), { tooltip: 'Current character-specific state: clothing, posture, emotion, immediate goals, and notes.' }));
    container.appendChild(createCollapsibleSection('continuity.inventory', 'Key Items', getCountLabel(state.inventory || [], 'item'), false, createJsonEditorCard('Key Items', 'Currently relevant items, owners, locations, and object status. Durable item history belongs in Story Lore.', 'inventory', state.inventory || [], false, 'inventory'), { tooltip: 'Current consequential items only.' }));
    container.appendChild(createCollapsibleSection('continuity.activeGoalsThreads', 'Active Goals and Threads', getActiveGoalsThreadsSummary(state), false, createActiveGoalsThreadsEditorCard(state), { tooltip: 'Immediate goals and active threads that affect the next scene.' }));
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

    return card;
}

function createCanonSceneEditorCard(state) {
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card';
    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = 'Scene and Timeline';
    addTooltip(title, 'Lightweight live scene and timeline fields. Durable story-established canon changes belong in Story Lore.');
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
    card.appendChild(createContinuitySectionPromptEditor('canonScene', 'Scene and Timeline'));
    return card;
}

function getContinuityCanonSceneSummary(state) {
    const parts = [state?.canon?.inUniverseDate, state?.scene?.location, state?.scene?.currentActivity]
        .map(v => String(v || '').trim())
        .filter(Boolean);
    return parts.length ? parts.slice(0, 2).join(' · ') : 'core fields';
}


function getActiveGoalsThreadsSummary(state) {
    const objectives = Array.isArray(state?.objectives) ? state.objectives.filter(o => o?.status !== 'completed' && o?.status !== 'abandoned').length : 0;
    const threads = Array.isArray(state?.threads) ? state.threads.filter(t => t?.status !== 'resolved').length : 0;
    const parts = [];
    if (objectives) parts.push(`${objectives} active goal${objectives === 1 ? '' : 's'}`);
    if (threads) parts.push(`${threads} active thread${threads === 1 ? '' : 's'}`);
    return parts.join(' · ') || 'none active';
}

function createActiveGoalsThreadsEditorCard(state) {
    const wrap = document.createElement('div');
    wrap.className = 'wandlight-runtime-grid';
    wrap.appendChild(createJsonEditorCard(
        'Active Goals',
        'Immediate goals, blockers, stakes, and status. Long-term plot memory belongs in Story Lore.',
        'objectives',
        state?.objectives || [],
        true,
        'objectives'
    ));
    wrap.appendChild(createJsonEditorCard(
        'Active Threads',
        'Immediate unresolved threads that should influence the next scene. Durable relationship history, milestones, secrets, and plot history belong in Story Lore.',
        'threads',
        state?.threads || [],
        true,
        'threads'
    ));
    return wrap;
}

function createCharacterStateEditorCard(state) {
    const card = createJsonEditorCard(
        'Active Characters',
        'Live character state supports name, role, current location, clothing, posture, physicalState, emotionalState, carried key items, immediate goals, and notes. Durable knowledge, secrets, relationships, and milestones belong in Story Lore.',
        'characters',
        state?.characters || [],
        false,
        'characters'
    );
    const schema = document.createElement('div');
    schema.className = 'wandlight-runtime-help';
    schema.textContent = 'Recommended active character object: { "name": "Harry", "clothing": "school robes", "physicalState": "tired", "emotionalState": { "trust": 2, "fear": 1, "notes": "uneasy but cooperative" }, "goals": ["find the source of the curse"] }';
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
    const continuityPreview = buildContinuityPreview(state, settings.continuityInjectionMode || 'direct');
    const lorePreview = buildLorePreview(state, settings.loreInjectionMode || 'direct');
    const loreHighPreview = buildLorePreview(state, getLoreTierMode(settings, 'high'), 'high');
    const loreNormalPreview = buildLorePreview(state, getLoreTierMode(settings, 'normal'), 'normal');
    const loreLowPreview = buildLorePreview(state, getLoreTierMode(settings, 'low'), 'low');
    updateCompressionTurnStatus(state, 'lore-high');
    updateCompressionTurnStatus(state, 'lore-normal');
    updateCompressionTurnStatus(state, 'lore-low');
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
        'Injects the editable lightweight Continuity state: scene/timeline, active characters, key items, and active goals/threads. Durable memory is handled by Lore entries.',
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
        'Injects accepted, unmuted Lore entries through relevance-tiered prompt groups. Turn this off if you want Wandlight to track/edit lore without sending lore to the roleplay model.',
        (checked) => {
            const next = getSettings();
            next.injectLore = checked;
            saveSettings(next);
            refreshPanelBody({ preserveScroll: false });
            refreshHeader();
        }
    ));
    container.appendChild(toggles);

    const placementStatus = `${settings.injectionTransport === 'interceptor' ? 'Legacy prepend' : 'Extension Prompt'} · C ${formatPlacementSummary(settings, 'continuity')} · H ${formatPlacementSummary(settings, 'loreHigh')} · N ${formatPlacementSummary(settings, 'loreNormal')} · L ${formatPlacementSummary(settings, 'loreLow')}`;
    container.appendChild(createCollapsibleSection('injection.promptPlacement', 'Prompt Placement', placementStatus, false, createInjectionPlacementCard(settings), { tooltip: 'Role, position, and depth used for prompt injection.' }));

    container.appendChild(createInjectionPreviewCard('Continuity Injection', 'wandlight-continuity-injection-preview', continuityPreview, settings.injectContinuity !== false && settings.injectMemo !== false, 'This is the actual Continuity block currently configured for prompt injection. It can be placed at a different depth because it is separated from Lore.', createContinuityHandlingDropdown(state, settings)));
    container.appendChild(createInjectionPreviewCard('High-Relevance Lore Injection', 'wandlight-lore-high-injection-preview', loreHighPreview, settings.injectLore !== false && settings.loreHighInjectionEnabled !== false, 'Lore injected in the high-relevance prompt group.', createLoreTierHandlingDropdown('high', state, settings)));
    container.appendChild(createInjectionPreviewCard('Normal-Relevance Lore Injection', 'wandlight-lore-normal-injection-preview', loreNormalPreview, settings.injectLore !== false && settings.loreNormalInjectionEnabled !== false, 'Lore injected in the normal-relevance prompt group.', createLoreTierHandlingDropdown('normal', state, settings)));
    container.appendChild(createInjectionPreviewCard('Low-Relevance Lore Injection', 'wandlight-lore-low-injection-preview', loreLowPreview, settings.injectLore !== false && settings.loreLowInjectionEnabled !== false, 'Lore injected in the low-relevance prompt group.', createLoreTierHandlingDropdown('low', state, settings)));
    container.appendChild(createInjectionPreviewCard('Combined Lore Preview', 'wandlight-lore-injection-preview', lorePreview, settings.injectLore !== false, 'Combined read-only preview of all relevance-tiered lore blocks.'));

    container.appendChild(createCollapsibleSection(
        'injection.compressionPrompts',
        'Compression Prompts',
        'Editable templates for model compression',
        false,
        createCompressionPromptEditorCard(),
        { tooltip: 'Editable prompt templates used by Compress Continuity Now and tiered Compress Lore actions.' }
    ));
}


function createContinuityHandlingDropdown(state, settings) {
    return createCollapsibleSection(
        'injection.continuityHandling',
        'Continuity Handling',
        `${settings.continuityInjectionMode || 'direct'} · ${getCompressionStatusTextForSummary(state, 'continuity')}`,
        (settings.continuityInjectionMode || 'direct') === 'compressed',
        createContinuityHandlingCard(state, settings),
        { tooltip: 'Direct or model-compressed handling for Continuity injection.' }
    );
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

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions';
    actions.appendChild(createButton('Compress Continuity Now', 'Uses the Utility provider to compress the direct Continuity Injection block and cache it for compressed injection.', async (btn) => {
        await runModelCompression('continuity', btn);
    }, 'wandlight-primary-button'));
    card.appendChild(actions);
    return card;
}

function createLoreTierHandlingDropdown(tier, state, settings) {
    const label = RELEVANCE_META[tier]?.label || tier;
    const entries = getInjectableLoreEntries(getState(), 0, tier).length;
    return createCollapsibleSection(
        `injection.lore${capTier(tier)}Handling`,
        `${label}-Relevance Lore Handling`,
        `${entries} entries · ${getLoreTierMode(settings, tier)} · ${getCompressionStatusTextForSummary(state, `lore-${tier}`)}`,
        false,
        createLoreTierHandlingCard(tier, state, settings),
        { tooltip: `Direct/compressed handling, compression level, and cache status for ${label}-Relevance Lore.` }
    );
}

function createLoreTierHandlingCard(tier, state, settings) {
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card wandlight-compression-handling-card wandlight-lore-tier-injection-card';
    const label = RELEVANCE_META[tier]?.label || tier;
    const counts = getLoreRelevanceCounts(state);
    card.appendChild(createKeyValue('Lore available', `${counts[tier] || 0} ${label} · ${counts.muted || 0} muted total`, 'Accepted lore grouped by relevance. Muted entries are excluded before injection/compression.'));

    const enabledLabel = document.createElement('label');
    enabledLabel.className = 'wandlight-inline-toggle';
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.checked = settings[tierSettingKey(tier, 'InjectionEnabled')] !== false;
    enabled.addEventListener('change', () => {
        const next = getSettings();
        next[tierSettingKey(tier, 'InjectionEnabled')] = enabled.checked;
        saveSettings(next);
        refreshPanelBody({ preserveScroll: true, preserveWindowScroll: true });
    });
    enabledLabel.appendChild(enabled);
    enabledLabel.appendChild(document.createTextNode(' Enable this lore injection'));
    card.appendChild(enabledLabel);

    const buttons = document.createElement('div');
    buttons.className = 'wandlight-mode-buttons';
    buttons.appendChild(createLoreTierModeButton(tier, 'direct', 'Direct', 'Inject this tier as resolved lore text.'));
    buttons.appendChild(createLoreTierModeButton(tier, 'compressed', 'Compressed', 'Inject this tier from its own cached model compression.'));
    card.appendChild(buttons);

    card.appendChild(createKeyValue('Entries', String(getInjectableLoreEntries(getState(), 0, tier).length), 'Accepted, unmuted entries in this relevance tier.'));
    card.appendChild(createCompressionLevelControl(`lore-${tier}`, settings));
    card.appendChild(createKeyValue('Target budget', getCompressionBudgetSummary(`lore-${tier}`, state), 'Compression budget for this relevance tier.'));
    card.appendChild(createKeyValue('Compression status', getCompressionStatusTextForKind(getState(), `lore-${tier}`), 'Tier-specific compression cache status.'));

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions';
    actions.appendChild(createButton(`Compress ${label} Now`, `Compresses only ${tier} relevance lore.`, async (btn) => {
        await runModelCompression(`lore-${tier}`, btn);
    }, tier === 'high' ? 'wandlight-primary-button' : ''));
    card.appendChild(actions);
    return card;
}

function createLoreTierModeButton(tier, mode, label, tooltip) {
    const settings = getSettings();
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wandlight-mode-button';
    if (getLoreTierMode(settings, tier) === mode) btn.classList.add('wandlight-mode-button-active');
    btn.textContent = label;
    addTooltip(btn, tooltip);
    btn.addEventListener('click', () => {
        const next = getSettings();
        next[tierSettingKey(tier, 'InjectionMode')] = mode;
        saveSettings(next);
        refreshPanelBody({ preserveScroll: true, preserveWindowScroll: true });
        refreshHeader();
        toast(`${RELEVANCE_META[tier]?.label || tier} relevance lore set to ${label}.`);
    });
    return btn;
}


function createCompressionLevelControl(kind, settings) {
    const parsed = parseLoreCompressionKind(kind);
    const levelKey = parsed.base === 'continuity' ? 'continuityCompressionLevel' : parsed.tier ? tierSettingKey(parsed.tier, 'CompressionLevel') : 'loreCompressionLevel';
    const fallback = 3;
    const levelValue = Math.max(1, Math.min(5, Number(settings[levelKey]) || fallback));
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
        next[levelKey] = Number(range.value) || 3;
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
    title.textContent = 'Compression Prompts';
    card.appendChild(title);

    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help';
    help.textContent = 'Variables: {{kind}}, {{compressionLevel}}, {{compressionLabel}}, {{directTokens}}, {{targetTokens}}, {{hardTokenLimit}}, {{directCharacters}}, {{targetCharacters}}, {{hardCharacterLimit}}, {{storyContext}}, {{directText}}.';
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
    const prefix = kind === 'continuity' ? 'continuity' : kind === 'loreHigh' ? 'loreHigh' : kind === 'loreNormal' ? 'loreNormal' : kind === 'loreLow' ? 'loreLow' : 'lore';
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
    const source = String(text || '');
    const directTokens = estimateTokens(source);
    const directCharacters = source.length;
    const profile = getCompressionProfile(level);
    const targetTokens = Math.max(96, Math.ceil(directTokens * profile.ratio));
    const hardTokenLimit = Math.max(128, Math.ceil(targetTokens * 1.2));
    const targetCharacters = Math.max(420, Math.ceil(directCharacters * profile.ratio));
    const hardCharacterLimit = Math.max(560, Math.ceil(targetCharacters * 1.18));
    return {
        directTokens,
        directCharacters,
        targetTokens,
        targetCharacters,
        hardTokenLimit,
        hardCharacterLimit,
        profile,
    };
}

function getCompressionBudgetSummary(kind, state) {
    const settings = getSettings();
    const parsed = parseLoreCompressionKind(kind);
    const level = parsed.base === 'continuity'
        ? Math.max(1, Math.min(5, Number(settings.continuityCompressionLevel) || 3))
        : parsed.tier ? getLoreTierLevel(settings, parsed.tier) : Math.max(1, Math.min(5, Number(settings.loreCompressionLevel) || 3));
    const directText = parsed.base === 'continuity'
        ? buildContinuityPreview(state, 'direct')
        : parsed.tier ? buildLorePreview(state, 'direct', parsed.tier) : buildLorePreview(state, 'direct');
    if (!directText || !directText.trim()) return 'No source text';
    const budget = estimateTokenBudgetForCompression(directText, level);
    return `~${budget.targetTokens} tokens / ${budget.targetCharacters} chars target; max ${budget.hardTokenLimit} tokens / ${budget.hardCharacterLimit} chars from ~${budget.directTokens} tokens / ${budget.directCharacters} chars`;
}

function getCompressionStatusTextForSummary(state, kind) {
    const parsed = parseLoreCompressionKind(kind);
    const status = parsed.base === 'continuity' ? getContinuityCompressionStatusText(state) : getCompressionStatusTextForKind(state, kind);
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
    help.textContent = 'Recommended: Extension Prompt, System role, with Continuity depth 3, High-Relevance Lore depth 2, Normal depth 5, and Low depth 9. Depth 0 is closest to the latest message.';
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
        createPlacementNumber('Depth', 'continuityInjectionDepth', settings.continuityInjectionDepth ?? 3, 0, 1000, 'Depth 0 is closest to the latest message. Higher depth moves the block earlier in chat history.', 'wandlight-placement-depth'),
        createPlacementSelect('Role', 'continuityInjectionRole', String(settings.continuityInjectionRole ?? 0), [
            ['0', 'System'],
            ['1', 'User'],
            ['2', 'Assistant'],
        ], 'Role used for the injected Continuity block when using In-chat extension prompt placement.', 'wandlight-placement-role'),
    ]));

    for (const [tier, label, depth] of [['high', 'High-Relevance Lore', 2], ['normal', 'Normal-Relevance Lore', 5], ['low', 'Low-Relevance Lore', 9]]) {
        placement.appendChild(createPromptPlacementLine(label, [
            createPlacementSelect('Position', tierSettingKey(tier, 'InjectionPosition'), String(settings[tierSettingKey(tier, 'InjectionPosition')] ?? 1), [
                ['1', 'In-chat'],
                ['0', 'After prompt'],
                ['2', 'Before prompt'],
            ], `Where the ${label} block is inserted. Depth only applies to In-chat.`, 'wandlight-placement-position'),
            createPlacementNumber('Depth', tierSettingKey(tier, 'InjectionDepth'), settings[tierSettingKey(tier, 'InjectionDepth')] ?? depth, 0, 1000, 'Depth 0 is closest to the latest message. Higher depth moves the block earlier in chat history.', 'wandlight-placement-depth'),
            createPlacementSelect('Role', tierSettingKey(tier, 'InjectionRole'), String(settings[tierSettingKey(tier, 'InjectionRole')] ?? 0), [
                ['0', 'System'],
                ['1', 'User'],
                ['2', 'Assistant'],
            ], `Role used for ${label}.`, 'wandlight-placement-role'),
        ]));
    }

    card.appendChild(placement);

    const status = typeof globalThis.wandlightGetInjectionStatus === 'function'
        ? globalThis.wandlightGetInjectionStatus()
        : null;
    const statusText = status
        ? `${status.transport || 'unknown'} | continuity ${status.continuityChars || 0} chars | high ${status.loreHighChars || 0} chars | normal ${status.loreNormalChars || 0} chars | low ${status.loreLowChars || 0} chars`
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

function createInjectionPreviewCard(titleText, className, text, enabled, helpText, extraContent = null) {
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

    if (extraContent) previewCard.appendChild(extraContent);

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
    const loreHigh = buildLorePreview(state, getLoreTierMode(settings, 'high'), 'high');
    const loreNormal = buildLorePreview(state, getLoreTierMode(settings, 'normal'), 'normal');
    const loreLow = buildLorePreview(state, getLoreTierMode(settings, 'low'), 'low');
    updateCompressionTurnStatus(state, 'continuity');
    updateCompressionTurnStatus(state, 'lore-high');
    updateCompressionTurnStatus(state, 'lore-normal');
    updateCompressionTurnStatus(state, 'lore-low');

    const continuityPre = panelRoot?.querySelector('.wandlight-continuity-injection-preview');
    if (continuityPre) {
        continuityPre.textContent = getInjectionDisplayText('Continuity Injection', continuity, settings.injectContinuity !== false && settings.injectMemo !== false);
    }

    const loreHighPre = panelRoot?.querySelector('.wandlight-lore-high-injection-preview');
    if (loreHighPre) loreHighPre.textContent = getInjectionDisplayText('High-Relevance Lore Injection', loreHigh, settings.injectLore !== false && settings.loreHighInjectionEnabled !== false);
    const loreNormalPre = panelRoot?.querySelector('.wandlight-lore-normal-injection-preview');
    if (loreNormalPre) loreNormalPre.textContent = getInjectionDisplayText('Normal-Relevance Lore Injection', loreNormal, settings.injectLore !== false && settings.loreNormalInjectionEnabled !== false);
    const loreLowPre = panelRoot?.querySelector('.wandlight-lore-low-injection-preview');
    if (loreLowPre) loreLowPre.textContent = getInjectionDisplayText('Low-Relevance Lore Injection', loreLow, settings.injectLore !== false && settings.loreLowInjectionEnabled !== false);

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
    const parsed = parseLoreCompressionKind(kind);
    let status = null;
    if (parsed.base === 'continuity') status = state.continuityCompressionStatus;
    else if (parsed.tier) status = state.loreCompressionStatusByRelevance?.[parsed.tier];
    else status = state.loreCompressionStatus;
    if (!status?.lastCompressedAt) return;
    const chatLength = getChatLength();
    status.turnsSinceCompression = Math.max(0, chatLength - Number(status.lastChatLength || chatLength));
    saveState(state);
}

async function runModelCompression(kind = 'lore', btn = null) {
    const settings = getSettings();
    // Compression is a frequent transformation task, so it is routed through the
    // Utility provider. Internal key remains `continuity` for backward-compatible
    // settings storage; the UI presents this provider role as Utility.
    const providerKind = 'continuity';
    const validation = validateLoreProviderConfiguration(providerKind);
    if (!validation.ok) {
        toast(`${kind === 'continuity' ? 'Continuity' : 'Lore'} compression blocked: Utility provider unavailable: ${validation.message}`, 'error');
        return null;
    }

    const originalText = btn?.textContent || '';
    if (btn) {
        btn.disabled = true;
        const parsedKindForLabel = parseLoreCompressionKind(kind);
        btn.textContent = parsedKindForLabel.base === 'continuity' ? 'Compressing continuity...' : `Compressing ${parsedKindForLabel.tier || ''} lore...`;
    }

    try {
        const state = getState();
        const parsedKind = parseLoreCompressionKind(kind);
        const directText = parsedKind.base === 'continuity'
            ? buildContinuityPreview(state, 'direct')
            : parsedKind.tier
                ? buildLorePreview(state, 'direct', parsedKind.tier)
                : buildLorePreview(state, 'direct');

        if (!directText || !directText.trim()) {
            toast(`${parsedKind.base === 'continuity' ? 'Continuity' : 'Lore'} preview is empty; nothing to compress.`, 'warning');
            return null;
        }

        const level = parsedKind.base === 'continuity'
            ? Math.max(1, Math.min(5, Number(settings.continuityCompressionLevel) || 3))
            : parsedKind.tier
                ? getLoreTierLevel(settings, parsedKind.tier)
                : Math.max(1, Math.min(5, Number(settings.loreCompressionLevel) || 3));

        const context = JSON.stringify({
            sceneDate: state?.loreContext?.sceneDate || state?.canon?.inUniverseDate || '',
            canonBoundary: state?.loreContext?.canonBoundary || state?.canon?.canonBoundary || '',
            branchId: state?.loreContext?.branchId || 'main',
            scene: state?.scene || {},
        }, null, 2);

        const budget = estimateTokenBudgetForCompression(directText, level);
        const compressionPrompt = buildCompressionPrompt(kind, level, context, directText, budget);
        const compressed = await sendLoreRequest(
            'You are Wandlight Compression. Compress the source into a shorter visible plain-text injection block. Output only that block. Do not use markdown fences, JSON, reasoning, or commentary.',
            compressionPrompt,
            {
                providerKind,
                maxTokens: Math.max(512, Math.min(8192, Math.ceil(budget.hardTokenLimit * 3))),
                prefill: '',
                expectedOutput: 'text',
                task: 'compression',
            }
        );

        let cleaned = cleanCompressedText(compressed);
        let validationResult = validateCompressedText(cleaned, directText, budget, level);
        if (!validationResult.ok && shouldRetryCompression(validationResult, directText, level)) {
            const retryPrompt = buildCompressionRetryPrompt(kind, level, context, directText, cleaned, budget, validationResult.message);
            const retry = await sendLoreRequest(
                'You are Wandlight Compression. Your previous visible output was too long or insufficiently compressed. Output only the corrected shorter plain-text injection block. No markdown, JSON, reasoning, or commentary.',
                retryPrompt,
                {
                    providerKind,
                    maxTokens: Math.max(512, Math.min(8192, Math.ceil(budget.hardTokenLimit * 3))),
                    prefill: '',
                    expectedOutput: 'text',
                    task: 'compression',
                }
            );
            cleaned = cleanCompressedText(retry);
            validationResult = validateCompressedText(cleaned, directText, budget, level);
        }

        if (!validationResult.ok) {
            throw new Error(validationResult.message);
        }

        const freshState = getState();
        let statusKey = parsedKind.base === 'continuity' ? 'continuityCompressionStatus' : 'loreCompressionStatus';
        let statusTarget = null;
        if (parsedKind.base === 'continuity') {
            if (!freshState.continuityCompressionStatus) freshState.continuityCompressionStatus = {};
            statusTarget = freshState.continuityCompressionStatus;
        } else if (parsedKind.tier) {
            if (!freshState.loreCompressionStatusByRelevance) freshState.loreCompressionStatusByRelevance = {};
            if (!freshState.loreCompressionStatusByRelevance[parsedKind.tier]) freshState.loreCompressionStatusByRelevance[parsedKind.tier] = {};
            statusTarget = freshState.loreCompressionStatusByRelevance[parsedKind.tier];
            statusKey = `loreCompressionStatusByRelevance.${parsedKind.tier}`;
        } else {
            if (!freshState.loreCompressionStatus) freshState.loreCompressionStatus = {};
            statusTarget = freshState.loreCompressionStatus;
        }
        const compressedTokens = estimateTokens(cleaned);
        const nextStatus = {
            ...statusTarget,
            lastCompressedAt: Date.now(),
            lastSignature: getCompressionSourceSignature(freshState, kind, directText, settings),
            lastMode: 'compressed',
            lastTokenEstimate: compressedTokens,
            lastCharacterCount: cleaned.length,
            lastDirectTokenEstimate: budget.directTokens,
            lastDirectCharacterCount: budget.directCharacters,
            lastTargetTokenEstimate: budget.targetTokens,
            lastTargetCharacterCount: budget.targetCharacters,
            lastHardTokenLimit: budget.hardTokenLimit,
            lastHardCharacterLimit: budget.hardCharacterLimit,
            lastCompressionRatio: budget.directCharacters ? Number((cleaned.length / budget.directCharacters).toFixed(3)) : 0,
            turnsSinceCompression: 0,
            lastChatLength: getChatLength(),
            cachedText: cleaned,
            lastError: '',
        };
        if (parsedKind.base === 'continuity') freshState.continuityCompressionStatus = nextStatus;
        else if (parsedKind.tier) freshState.loreCompressionStatusByRelevance[parsedKind.tier] = nextStatus;
        else freshState.loreCompressionStatus = nextStatus;
        saveState(freshState);
        refreshPanelBody({ preserveScroll: true, preserveWindowScroll: true });
        toast(`${parsedKind.base === 'continuity' ? 'Continuity' : parsedKind.tier ? `${RELEVANCE_META[parsedKind.tier]?.label || parsedKind.tier} lore` : 'Lore'} compression updated: ${compressedTokens} tokens / ${cleaned.length} chars from ${budget.directTokens} tokens / ${budget.directCharacters} chars.`);
        return cleaned;
    } catch (e) {
        const freshState = getState();
        const parsedKind = parseLoreCompressionKind(kind);
        let status = parsedKind.base === 'continuity' ? freshState.continuityCompressionStatus : parsedKind.tier ? freshState.loreCompressionStatusByRelevance?.[parsedKind.tier] : freshState.loreCompressionStatus;
        if (status) {
            status.lastError = e?.message || String(e);
            saveState(freshState);
        }
        toast(`${kind === 'continuity' ? 'Continuity' : 'Lore'} compression failed: ${e?.message || e}`, 'error');
        refreshPanelBody({ preserveScroll: true, preserveWindowScroll: true });
        return null;
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = originalText;
        }
    }
}


function validateCompressedText(cleaned, directText, budget, level) {
    const text = String(cleaned || '').trim();
    if (!text) return { ok: false, message: 'Compression returned empty visible text.' };
    const source = String(directText || '');
    const sourceChars = source.length;
    const outputChars = text.length;
    const outputTokens = estimateTokens(text);
    if (sourceChars >= 900 && outputChars > budget.hardCharacterLimit) {
        return { ok: false, message: `Compressed output is too long: ${outputChars} chars; hard limit is ${budget.hardCharacterLimit} chars.` };
    }
    if (budget.directTokens >= 220 && outputTokens > Math.ceil(budget.hardTokenLimit * 1.1)) {
        return { ok: false, message: `Compressed output is too long: ~${outputTokens} tokens; hard limit is ~${budget.hardTokenLimit} tokens.` };
    }
    if (level >= 3 && sourceChars >= 1200 && outputChars > Math.ceil(sourceChars * 0.72)) {
        return { ok: false, message: `Compression level ${level} did not significantly reduce the source: ${outputChars} chars from ${sourceChars} chars.` };
    }
    if (level >= 4 && sourceChars >= 1200 && outputChars > Math.ceil(sourceChars * 0.55)) {
        return { ok: false, message: `Compression level ${level} did not meet heavy-reduction expectations: ${outputChars} chars from ${sourceChars} chars.` };
    }
    return { ok: true, message: '' };
}

function shouldRetryCompression(result, directText, level) {
    if (result?.ok) return false;
    const sourceChars = String(directText || '').length;
    return sourceChars >= 600 || level >= 3;
}

function buildCompressionRetryPrompt(kind, level, context, directText, previousOutput, budget, reason) {
    const parsedKind = parseLoreCompressionKind(kind);
    const kindLabel = parsedKind.base === 'continuity' ? 'Continuity State' : parsedKind.tier ? `${RELEVANCE_META[parsedKind.tier]?.label || parsedKind.tier} Relevance Lore Entries` : 'Lore Entries';
    return `Compress the Wandlight ${kindLabel} injection again. The previous output failed validation: ${reason}

Required visible-output limits:
- Source: about ${budget.directTokens} tokens / ${budget.directCharacters} characters.
- Target: <= ${budget.targetTokens} tokens / <= ${budget.targetCharacters} characters.
- Hard maximum: <= ${budget.hardTokenLimit} tokens / <= ${budget.hardCharacterLimit} characters.
- Compression level ${level}: ${budget.profile.description}.

Story context:
${context}

Previous too-long output:
${previousOutput || '(empty)'}

Direct injection block to compress:
${directText}

Output only the corrected compressed injection text. No markdown fences, JSON, reasoning, or commentary.`;
}

function buildCompressionPrompt(kind, level, context, directText, budget = null) {
    const settings = getSettings();
    const parsedKind = parseLoreCompressionKind(kind);
    const kindLabel = parsedKind.base === 'continuity' ? 'Continuity State' : parsedKind.tier ? `${RELEVANCE_META[parsedKind.tier]?.label || parsedKind.tier} Relevance Lore Entries` : 'Lore Entries';
    const computedBudget = budget || estimateTokenBudgetForCompression(directText, level);
    const templateKey = parsedKind.base === 'continuity' ? 'continuityCompressionPromptTemplate' : 'loreCompressionPromptTemplate';
    const fallbackTemplate = parsedKind.base === 'continuity'
        ? DEFAULT_SETTINGS.continuityCompressionPromptTemplate
        : DEFAULT_SETTINGS.loreCompressionPromptTemplate;
    const template = String(settings[templateKey] || fallbackTemplate || '');
    const vars = {
        kind: kindLabel,
        compressionLevel: String(level),
        compressionLabel: computedBudget.profile.description,
        directTokens: String(computedBudget.directTokens),
        targetTokens: String(computedBudget.targetTokens),
        hardTokenLimit: String(computedBudget.hardTokenLimit),
        directCharacters: String(computedBudget.directCharacters),
        targetCharacters: String(computedBudget.targetCharacters),
        hardCharacterLimit: String(computedBudget.hardCharacterLimit),
        storyContext: context,
        directText,
    };
    const rendered = template.replace(/{{\s*(\w+)\s*}}/g, (_, key) => Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : '');
    if (/{{\s*(targetCharacters|hardCharacterLimit|directCharacters)\s*}}/i.test(template)) return rendered;
    // Preserve older/custom advanced templates, but append the dynamic length
    // contract that prevents level 3+ compression from becoming a same-size rewrite.
    return `${rendered}

Compression length contract:
- Source length: about ${vars.directTokens} tokens / ${vars.directCharacters} characters.
- Target length: <= ${vars.targetTokens} tokens / <= ${vars.targetCharacters} characters.
- Hard maximum visible output: <= ${vars.hardTokenLimit} tokens / <= ${vars.hardCharacterLimit} characters.
- If information must be sacrificed, preserve active continuity constraints, secrets, knowledge boundaries, pinned/protected details, and current-scene hazards first.
- Output only the compressed injection text.`;
}


function cleanCompressedText(text) {
    let cleaned = String(text || '')
        .replace(/```(?:text|markdown)?\s*([\s\S]*?)```/i, '$1')
        .trim();
    if (/^\{[\s\S]*\}$/.test(cleaned)) {
        try {
            const parsed = JSON.parse(cleaned);
            cleaned = String(parsed.compressedText || parsed.compressed || parsed.text || parsed.content || parsed.message || cleaned).trim();
        } catch (_) {}
    }
    return cleaned;
}

function parseLoreCompressionKind(kind = 'lore') {
    const raw = String(kind || 'lore').toLowerCase().replace(/_/g, '-');
    if (raw === 'continuity') return { base: 'continuity', tier: '' };
    if (raw.includes('high')) return { base: 'lore', tier: 'high' };
    if (raw.includes('normal')) return { base: 'lore', tier: 'normal' };
    if (raw.includes('low')) return { base: 'lore', tier: 'low' };
    return { base: 'lore', tier: '' };
}
function capTier(tier) { return tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : ''; }
function tierSettingKey(tier, suffix) { return tier ? `lore${capTier(tier)}${suffix}` : `lore${suffix}`; }
function getCompressionStatusObjectForKind(state, kind = 'lore') {
    const parsed = parseLoreCompressionKind(kind);
    if (parsed.base === 'continuity') return state?.continuityCompressionStatus || {};
    if (parsed.tier) return state?.loreCompressionStatusByRelevance?.[parsed.tier] || {};
    return state?.loreCompressionStatus || {};
}
function getCompressionStatusKeyForKind(kind = 'lore') {
    const parsed = parseLoreCompressionKind(kind);
    if (parsed.base === 'continuity') return 'continuityCompressionStatus';
    if (parsed.tier) return `loreCompressionStatusByRelevance.${parsed.tier}`;
    return 'loreCompressionStatus';
}
function getLoreTierMode(settings, tier) { return settings[tierSettingKey(tier, 'InjectionMode')] || (tier === 'high' ? 'direct' : 'compressed'); }
function getLoreTierLevel(settings, tier) { return Math.max(1, Math.min(5, Number(settings[tierSettingKey(tier, 'CompressionLevel')]) || 3)); }

function getCompressionStatusTextForKind(state, kind = 'lore') {
    const settings = getSettings();
    const parsed = parseLoreCompressionKind(kind);
    if (parsed.base === 'continuity') return getContinuityCompressionStatusText(state);
    if (parsed.tier && getLoreTierMode(settings, parsed.tier) !== 'compressed') return 'Direct mode active; compression not used.';
    if (!parsed.tier && (settings.loreInjectionMode || 'direct') !== 'compressed') return 'Direct mode active; compression not used.';
    const status = getCompressionStatusObjectForKind(state, kind);
    const direct = parsed.tier ? buildLorePreview(state, 'direct', parsed.tier) : buildLorePreview(state, 'direct');
    const currentSignature = getCompressionSourceSignature(state, kind, direct);
    if (status.lastSignature !== currentSignature) {
        return status.lastError ? `cached compression is stale; last error: ${status.lastError}` : 'Cached compression is missing or stale. Click Compress Now.';
    }
    if (status.lastError) return `last compression failed: ${status.lastError}`;
    if (!status.lastCompressedAt) return 'No cached model compression yet. Click Compress Now.';
    const when = new Date(status.lastCompressedAt).toLocaleTimeString();
    return `model-compressed ${when}; ${status.turnsSinceCompression || 0} turns since; ~${status.lastTokenEstimate || 0} tokens / ${status.lastCharacterCount || 0} chars${status.lastCompressionRatio ? `; ratio ${Math.round(status.lastCompressionRatio * 100)}%` : ''}`;
}

function getCompressionStatusText(state) {
    const settings = getSettings();
    const status = state?.loreCompressionStatus || {};
    if ((settings.loreInjectionMode || 'direct') !== 'compressed') {
        return 'Direct mode active; compression not used.';
    }
    const currentSignature = getCompressionSourceSignature(state, 'lore', buildLorePreview(state, 'direct'));
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
    return `model-compressed ${when}; ${status.turnsSinceCompression || 0} turns since; ~${status.lastTokenEstimate || 0} tokens / ${status.lastCharacterCount || 0} chars${status.lastTargetTokenEstimate ? ` (target ${status.lastTargetTokenEstimate} tokens / ${status.lastTargetCharacterCount || '?'} chars)` : ''}${status.lastCompressionRatio ? `; ratio ${Math.round(status.lastCompressionRatio * 100)}%` : ''}`;
}

function getContinuityCompressionStatusText(state) {
    const settings = getSettings();
    const status = state?.continuityCompressionStatus || {};
    if ((settings.continuityInjectionMode || 'direct') !== 'compressed') {
        return 'Direct mode active; continuity compression not used.';
    }
    const currentSignature = getCompressionSourceSignature(state, 'continuity', buildContinuityPreview(state, 'direct'));
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
    return `model-compressed ${when}; ${status.turnsSinceCompression || 0} turns since; ~${status.lastTokenEstimate || 0} tokens / ${status.lastCharacterCount || 0} chars${status.lastTargetTokenEstimate ? ` (target ${status.lastTargetTokenEstimate} tokens / ${status.lastTargetCharacterCount || '?'} chars)` : ''}${status.lastCompressionRatio ? `; ratio ${Math.round(status.lastCompressionRatio * 100)}%` : ''}`;
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
    const signature = getCompressionSourceSignature(state, kind, kind === 'continuity' ? buildContinuityPreview(state, 'direct') : buildLorePreview(state, 'direct'));
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
        if (mode === 'compressed' && !hasValidModelCompression('lore')) {
            const directText = buildLorePreview(getState(), 'direct');
            if (!hasCompressibleText(directText)) {
                toast('Lore compressed mode selected, but there is no accepted lore to compress yet. Generate/accept lore entries first, then use Compress Lore Now.', 'warning');
            } else if (hasAnyModelCompression('lore')) {
                toast('Lore compressed mode selected. Existing compressed cache is stale for the current source/settings; using direct preview until you click Compress Lore Now.', 'warning');
            } else {
                toast('Lore compressed mode selected. No cached compression exists yet; using direct preview until you click Compress Lore Now.', 'warning');
            }
        }
        refreshPanelBody({ preserveScroll: true, preserveWindowScroll: true });
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
            const directText = buildContinuityPreview(getState(), 'direct');
            if (!hasCompressibleText(directText)) {
                toast('Continuity compressed mode selected, but there is no continuity state to compress yet. Run Scan Continuity State first, then use Compress Continuity Now.', 'warning');
            } else if (hasAnyModelCompression('continuity')) {
                toast('Continuity compressed mode selected. Existing compressed cache is stale for the current source/settings; using direct preview until you click Compress Continuity Now.', 'warning');
            } else {
                toast('Continuity compressed mode selected. No cached compression exists yet; using direct preview until you click Compress Continuity Now.', 'warning');
            }
        }
        refreshPanelBody({ preserveScroll: true, preserveWindowScroll: true });
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
        section.appendChild(createEmptyMessage('No lore entries are waiting for review. Use Suggest Canon Lore or Scan Story Lore above.'));
    }

    return section;
}

// Shared review-card helpers --------------------------------------------------
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
    actions.appendChild(createEditableLifecycleBadge(entry, { pending: true }));
    const status = document.createElement('span');
    status.className = 'wandlight-lore-badge wandlight-lore-badge-pending';
    status.textContent = 'pending';
    addTooltip(status, 'This lore entry has not been accepted into the accepted lore matrix yet.');
    actions.appendChild(status);
    headerRow.appendChild(actions);
    card.appendChild(headerRow);

    const meta = document.createElement('div');
    meta.className = 'wandlight-lore-entry-meta';
    meta.appendChild(createRegistryBadge('category', entry.category || 'other', `Category: ${entry.category || 'other'}. Pending cards use the same compact metadata style as accepted cards.`));
    meta.appendChild(createLorePurposeBadge(entry));
    meta.appendChild(createRegistryBadge('canonStatus', entry.canon || entry.canonStatus || 'canon', `Canon/Story: ${entry.canon || entry.canonStatus || 'canon'}.`));
    meta.appendChild(createBadge(`P${Number(entry.priority || 50)}`, 'Priority used for sorting, injection preference, and canon-lore suggestion limits.'));
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
    editRow.appendChild(createBulkSelect('Relevance', LORE_RELEVANCE_TIERS, 'Set relevance tier for selected entries.', async value => {
        const ids = selectedIdsNow();
        if (!(await confirmBulkAcceptedAction('Set Relevance', ids, `Selected entries will have relevance set to ${value}.`))) return;
        bulkUpdateAcceptedLore(ids, raw => ({
            ...raw,
            relevance: normalizeLoreRelevance(value),
            lifecycle: { ...(raw.lifecycle || {}), status: '', computedStatus: '', manualOverride: false, reason: 'Relevance replaced lifecycle state.' },
            extensions: { ...(raw.extensions || {}), autoRelevance: { ...(raw.extensions?.autoRelevance || {}), mode: 'manual', confidence: 1, reason: `Bulk relevance set to ${value}.`, updatedAt: Date.now() } },
        }));
    }, disabled, value => RELEVANCE_META[value]?.label || value));
    editRow.appendChild(createBulkSelect('Category', getLoreRegistryValues('categories', LORE_CATEGORY_VALUES), 'Set category for selected entries.', async value => {
        const ids = selectedIdsNow();
        if (!(await confirmBulkAcceptedAction('Set Category', ids, `Selected entries will have category set to ${value}.`))) return;
        bulkUpdateAcceptedLore(ids, raw => ({ ...raw, category: value }));
    }, disabled));
    editRow.appendChild(createBulkSelect('Canon', getLoreRegistryValues('canonStatuses', ['canon', 'au']), 'Set canon status for selected entries.', async value => {
        const ids = selectedIdsNow();
        if (!(await confirmBulkAcceptedAction('Set Canon Status', ids, `Selected entries will have canon status set to ${value}.`))) return;
        bulkUpdateAcceptedLore(ids, raw => ({ ...raw, canon: value, canonStatus: value }));
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
        'Suggest canon lore from the local database, generate story-specific lore with the model, review pending entries, and manage accepted lore.'
    ));
    container.appendChild(createCollapsibleSection(
        'lore.generation',
        'Lore Generation',
        'canon suggestions + story generation',
        true,
        createLoreGenerationCard(state),
        { tooltip: 'Suggest canon lore from the local database or generate story-specific lore from recent chat messages.', className: 'wandlight-lore-generation-collapsible' }
    ));

    container.appendChild(createCollapsibleSection(
        'lore.autoRelevance',
        'Auto-Relevance',
        getSettings().autoRelevanceEnabled ? `every ${getSettings().autoRelevanceEveryTurns || 5} turns` : 'off',
        false,
        createAutoRelevanceCard(state),
        { tooltip: 'Automatically promotes or demotes accepted lore between High, Normal, and Low relevance tiers.' }
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

function createAutoRelevanceCard(state) {
    const settings = getSettings();
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card wandlight-auto-relevance-card';
    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = 'Auto-Relevance';
    addTooltip(title, 'Periodically rescans recent story context and adjusts accepted lore relevance tiers. Mute remains the hard injection on/off control.');
    card.appendChild(title);
    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help';
    help.textContent = 'Auto-Relevance uses local scoring for performance. It can promote or demote High/Normal/Low relevance, but it does not change mute or pin.';
    card.appendChild(help);

    const enabled = document.createElement('label');
    enabled.className = 'wandlight-inline-toggle';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!settings.autoRelevanceEnabled;
    cb.addEventListener('change', () => {
        const next = getSettings();
        next.autoRelevanceEnabled = cb.checked;
        if (cb.checked && (!next.autoRelevanceMode || next.autoRelevanceMode === 'off')) next.autoRelevanceMode = 'suggest';
        saveSettings(next);
        refreshPanelBody({ preserveScroll: true });
    });
    enabled.appendChild(cb);
    enabled.appendChild(document.createTextNode(' Enable Auto-Relevance'));
    card.appendChild(enabled);

    const modeRow = document.createElement('div');
    modeRow.className = 'wandlight-runtime-grid';
    const modeLabel = document.createElement('label');
    modeLabel.className = 'wandlight-inline-field';
    const modeSpan = document.createElement('span');
    modeSpan.textContent = 'Action when enabled';
    addTooltip(modeSpan, 'The checkbox turns Auto-Relevance on or off. This selector controls what Auto-Relevance does when it runs.');
    const modeSelect = document.createElement('select');
    const selectedMode = (settings.autoRelevanceMode || 'suggest') === 'off' ? 'suggest' : (settings.autoRelevanceMode || 'suggest');
    for (const [value, label] of [['suggest', 'Suggest changes for review'], ['apply_high_confidence', 'Apply high-confidence changes']]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        if (selectedMode === value) option.selected = true;
        modeSelect.appendChild(option);
    }
    modeSelect.addEventListener('change', () => {
        const next = getSettings();
        next.autoRelevanceMode = modeSelect.value;
        saveSettings(next);
        refreshPanelBody({ preserveScroll: true });
    });
    modeLabel.appendChild(modeSpan);
    modeLabel.appendChild(modeSelect);
    modeRow.appendChild(modeLabel);
    card.appendChild(modeRow);

    const row = document.createElement('div');
    row.className = 'wandlight-runtime-grid';
    row.appendChild(createNumberSettingMini('Run every turns', 'autoRelevanceEveryTurns', settings.autoRelevanceEveryTurns || 5, 1, 50));
    row.appendChild(createNumberSettingMini('Recent messages', 'autoRelevanceRecentMessages', settings.autoRelevanceRecentMessages || 20, 1, 200));
    row.appendChild(createNumberSettingMini('Candidate cap', 'autoRelevanceCandidateCap', settings.autoRelevanceCandidateCap || 40, 1, 500));
    row.appendChild(createNumberSettingMini('Min confidence %', 'autoRelevanceMinConfidence', Math.round((settings.autoRelevanceMinConfidence || 0.7) * 100), 1, 100, value => Number(value) / 100));
    card.appendChild(row);

    const modelRow = document.createElement('div');
    modelRow.className = 'wandlight-runtime-grid';
    const modelToggle = document.createElement('label');
    modelToggle.className = 'wandlight-inline-toggle';
    const modelCb = document.createElement('input');
    modelCb.type = 'checkbox';
    modelCb.checked = !!settings.autoRelevanceUseModel;
    modelCb.addEventListener('change', () => {
        const next = getSettings();
        next.autoRelevanceUseModel = modelCb.checked;
        saveSettings(next);
        refreshPanelBody({ preserveScroll: true });
    });
    modelToggle.appendChild(modelCb);
    modelToggle.appendChild(document.createTextNode(' Use Utility Provider adjudication'));
    addTooltip(modelToggle, 'Optional second-stage model review. Wandlight still scores locally first and sends only the candidate cap subset.');
    modelRow.appendChild(modelToggle);
    modelRow.appendChild(createNumberSettingMini('Model candidate cap', 'autoRelevanceModelCandidateCap', settings.autoRelevanceModelCandidateCap || 30, 1, 80));
    modelRow.appendChild(createNumberSettingMini('Model max tokens', 'autoRelevanceModelMaxTokens', settings.autoRelevanceModelMaxTokens || 2048, 512, 4096));
    card.appendChild(modelRow);
    const counts = getLoreRelevanceCounts(state);
    card.appendChild(createKeyValue('Current tiers', `High ${counts.high} · Normal ${counts.normal} · Low ${counts.low} · Muted ${counts.muted}`, 'Current accepted lore counts by relevance.'));

    const suggestions = Array.isArray(state.autoRelevanceSuggestions) ? state.autoRelevanceSuggestions : [];
    if (suggestions.length) {
        const box = document.createElement('div');
        box.className = 'wandlight-auto-relevance-suggestions';
        const heading = document.createElement('div');
        heading.className = 'wandlight-runtime-help';
        heading.textContent = `Pending relevance suggestions: ${suggestions.length}`;
        box.appendChild(heading);
        for (const suggestion of suggestions.slice(0, 12)) {
            const row = document.createElement('div');
            row.className = 'wandlight-auto-relevance-suggestion-row';
            const summary = document.createElement('div');
            summary.className = 'wandlight-auto-relevance-suggestion-summary';
            summary.textContent = `${suggestion.title || suggestion.id}: ${suggestion.currentRelevance || '?'} -> ${suggestion.suggestedRelevance} (${Math.round((suggestion.confidence || 0) * 100)}%, ${suggestion.source || 'local'})`;
            addTooltip(summary, suggestion.reason || 'Auto-Relevance suggestion.');
            row.appendChild(summary);
            const applyOne = createButton('Apply', 'Apply this relevance suggestion only.', () => {
                const result = applyAutoRelevanceSuggestions([suggestion.id]);
                refreshPanelBody({ preserveScroll: true });
                refreshHeader();
                toast(`Applied ${result.applied || 0} relevance suggestion.`, 'success');
            }, 'wandlight-mini-button');
            const rejectOne = createButton('Reject', 'Reject this relevance suggestion only.', () => {
                const result = rejectAutoRelevanceSuggestions([suggestion.id]);
                refreshPanelBody({ preserveScroll: true });
                toast(`Rejected ${result.rejected || 0} relevance suggestion.`, 'info');
            }, 'wandlight-mini-button');
            row.appendChild(applyOne);
            row.appendChild(rejectOne);
            box.appendChild(row);
        }
        if (suggestions.length > 12) {
            const more = document.createElement('div');
            more.className = 'wandlight-runtime-help';
            more.textContent = `${suggestions.length - 12} additional suggestions hidden. Use Apply Suggestions or Clear Suggestions for the full queue.`;
            box.appendChild(more);
        }
        card.appendChild(box);
    }

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions';
    actions.appendChild(createButton('Run Auto-Relevance Now', 'Runs Auto-Relevance immediately. Local scoring always runs first; optional Utility Provider adjudication reviews only the candidate set.', async (btn) => {
        const original = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Running...';
        try {
            const result = await runAutoRelevance({ force: true });
            refreshPanelBody({ preserveScroll: true });
            refreshHeader();
            toast(`Auto-Relevance ${result.status}: ${result.changed || 0} changed, ${result.suggested || 0} suggested, ${result.considered || 0} considered${result.modelStatus ? `, model ${result.modelStatus}` : ''}.`, 'info');
        } catch (e) {
            console.error(e);
            toast(`Auto-Relevance failed: ${e?.message || e}`, 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = original;
        }
    }, 'wandlight-primary-button'));
    if (suggestions.length) {
        actions.appendChild(createButton('Apply Suggestions', 'Applies all pending Auto-Relevance suggestions.', () => {
            const result = applyAutoRelevanceSuggestions();
            refreshPanelBody({ preserveScroll: true });
            refreshHeader();
            toast(`Auto-Relevance suggestions applied: ${result.applied || 0}.`, 'success');
        }, 'wandlight-small-button'));
        actions.appendChild(createButton('Reject All Suggestions', 'Rejects all pending Auto-Relevance suggestions without applying them.', () => {
            clearAutoRelevanceSuggestions();
            refreshPanelBody({ preserveScroll: true });
            toast('Auto-Relevance suggestions rejected.', 'info');
        }, 'wandlight-small-button'));
    }
    card.appendChild(actions);
    return card;
}

function createNumberSettingMini(labelText, settingKey, value, min, max, transform = null) {
    const label = document.createElement('label');
    label.className = 'wandlight-inline-field';
    const span = document.createElement('span');
    span.textContent = labelText;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = String(min);
    input.max = String(max);
    input.value = String(value);
    input.addEventListener('change', () => {
        const next = getSettings();
        const raw = Math.max(min, Math.min(max, Number(input.value) || Number(value) || min));
        next[settingKey] = transform ? transform(raw) : raw;
        saveSettings(next);
        refreshPanelBody({ preserveScroll: true });
    });
    label.appendChild(span);
    label.appendChild(input);
    return label;
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
    pinHelp.textContent = 'Pinned = prioritized/protected. Muted = excluded from injection. Relevance controls tier placement, sorting, and compression budget.';
    addTooltip(pinHelp, 'Pin important facts you always want kept prominent. Mute facts that should stay stored but not be sent to the model.');
    controls.appendChild(pinHelp);

    const bulkMount = document.createElement('div');
    bulkMount.className = 'wandlight-lore-bulk-toolbar';
    bulkMount.appendChild(createAcceptedLoreBulkControls(state));
    controls.appendChild(bulkMount);

    section.appendChild(controls);

    const list = document.createElement('div');
    list.className = 'wandlight-lore-entry-list wandlight-accepted-lore-scroll-region';
    list.setAttribute('role', 'region');
    list.setAttribute('aria-label', 'Accepted lore entries');
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
        scheduleAcceptedLoreLayoutUpdate();
    }, SEARCH_RENDER_DEBOUNCE_MS);
}

function refreshAcceptedLoreList(options = {}) {
    if (!panelRoot) return;
    const list = panelRoot.querySelector('.wandlight-lore-entry-list');
    if (!list) return;
    const scrollTop = options.preserveScroll ? list.scrollTop : 0;
    renderEntryList(list, getState());
    scheduleAcceptedLoreLayoutUpdate();
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
    scheduleAcceptedLoreLayoutUpdate();
    return true;
}

let acceptedLoreLayoutFrame = 0;

function scheduleAcceptedLoreLayoutUpdate() {
    if (acceptedLoreLayoutFrame) cancelAnimationFrame(acceptedLoreLayoutFrame);
    acceptedLoreLayoutFrame = requestAnimationFrame(() => {
        acceptedLoreLayoutFrame = requestAnimationFrame(() => {
            acceptedLoreLayoutFrame = 0;
            updateAcceptedLoreScrollRegionHeight();
        });
    });
}

function updateAcceptedLoreScrollRegionHeight() {
    if (!panelRoot) return;
    const drawer = panelRoot.querySelector('.wandlight-runtime-drawer');
    if (!drawer) return;

    updateDrawerScrollMetrics(drawer);

    const list = drawer.querySelector('.wandlight-accepted-lore-scroll-region');
    if (!list) return;

    const acceptedSection = list.closest('.wandlight-accepted-lore-section');
    const acceptedDetails = list.closest('.wandlight-lore-accepted-collapsible');
    const content = acceptedDetails?.querySelector(':scope > .wandlight-collapsible-content');

    // Earlier layout code made the accepted-lore section stretch to the bottom of
    // the drawer. That works for a fixed Lore tab, but it clips later sections
    // when every Lore section is expanded. The drawer tab is now the outer
    // scroller; accepted lore remains a bounded nested scroller. Clear any stale
    // inline sizing before applying the bounded-scroll CSS variables.
    for (const el of [acceptedDetails, content, acceptedSection, list]) {
        if (!el) continue;
        el.style.removeProperty('height');
        el.style.removeProperty('flex');
        el.style.removeProperty('max-height');
    }

    list.style.setProperty('overflow-y', 'auto');
    list.style.setProperty('overscroll-behavior', 'contain');
}

function updateDrawerScrollMetrics(drawer = panelRoot?.querySelector?.('.wandlight-runtime-drawer')) {
    if (!drawer) return;
    const drawerRect = drawer.getBoundingClientRect?.();
    const headerRect = drawer.querySelector('.wandlight-runtime-drawer-header')?.getBoundingClientRect?.();
    const drawerHeight = Number(drawerRect?.height) || Number.parseFloat(drawer.style.height) || 640;
    const headerHeight = Number(headerRect?.height) || 48;
    const bodyHeight = Math.max(120, Math.floor(drawerHeight - headerHeight - 18));
    const nestedMax = Math.max(140, Math.min(420, Math.floor(bodyHeight * 0.52)));
    drawer.style.setProperty('--wandlight-drawer-body-available', `${bodyHeight}px`);
    drawer.style.setProperty('--wandlight-nested-scroll-max', `${nestedMax}px`);
}

if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => {
        clampRuntimeShellToViewport();
        scheduleAcceptedLoreLayoutUpdate();
    });
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
    } else if (panelState.selectedCategory === 'active' || panelState.selectedCategory === 'high') {
        filtered = filtered.filter(e => e.relevance === 'high');
    } else if (panelState.selectedCategory === 'normal') {
        filtered = filtered.filter(e => e.relevance === 'normal');
    } else if (panelState.selectedCategory === 'low') {
        filtered = filtered.filter(e => e.relevance === 'low');
    } else if (panelState.selectedCategory === 'pinned') {
        filtered = filtered.filter(e => e.isPinned);
    } else if (panelState.selectedCategory === 'suppressed') {
        filtered = filtered.filter(e => e.isSuppressed);
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
    const order = ['event', 'timeline', 'character', 'relationship', 'location', 'faction', 'knowledge', 'secret', 'item', 'spell', 'rule', 'other'];
    const idx = order.indexOf(category || '');
    return idx >= 0 ? idx : 99;
}


const RELEVANCE_META = {
    high: { label: 'High', color: '#166534', textColor: '#dcfce7', tooltip: 'Current-scene or immediate story relevance. Injects in the High-Relevance lore group.' },
    normal: { label: 'Normal', color: '#1e3a8a', textColor: '#dbeafe', tooltip: 'Recent, branch-defining, or medium-range story relevance. Injects in the Normal-Relevance lore group.' },
    low: { label: 'Low', color: '#4b5563', textColor: '#f9fafb', tooltip: 'Long-term background or distant past/future lore. Injects in the Low-Relevance lore group if enabled.' },
};
const LIFECYCLE_META = RELEVANCE_META;

function getLifecycleStatus(entry) {
    return normalizeLoreRelevance(entry.relevance || entry.lifecycleStatus || entry.lifecycle?.status || entry.lifecycle?.computedStatus || 'normal');
}

function createEditableLifecycleBadge(entry, options = {}) {
    const value = getLifecycleStatus(entry);
    const meta = RELEVANCE_META[value] || RELEVANCE_META.normal;
    const wrap = document.createElement('label');
    wrap.className = 'wandlight-lore-lifecycle-select-wrap';
    wrap.style.setProperty('--wandlight-chip-bg', meta.color);
    wrap.style.setProperty('--wandlight-chip-fg', meta.textColor);
    addTooltip(wrap, `${meta.label} Relevance: ${meta.tooltip}`);

    const select = document.createElement('select');
    select.className = 'wandlight-lore-lifecycle-select';
    select.setAttribute('aria-label', 'Lore relevance');
    select.addEventListener('click', e => e.stopPropagation());
    select.addEventListener('mousedown', e => e.stopPropagation());

    for (const status of LORE_RELEVANCE_TIERS) {
        const option = document.createElement('option');
        option.value = status;
        option.textContent = RELEVANCE_META[status]?.label || status;
        if (status === value) option.selected = true;
        select.appendChild(option);
    }

    select.addEventListener('change', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const nextRelevance = normalizeLoreRelevance(select.value);
        updateLoreEntryById(entry.id, raw => ({
            ...raw,
            relevance: nextRelevance,
            lifecycle: {
                ...(raw.lifecycle || {}),
                status: '',
                computedStatus: '',
                manualOverride: false,
                reason: `Relevance manually set to ${nextRelevance}.`,
                lastEvaluatedAt: Date.now(),
            },
            extensions: {
                ...(raw.extensions || {}),
                autoRelevance: {
                    ...(raw.extensions?.autoRelevance || {}),
                    mode: 'manual',
                    confidence: 1,
                    reason: `User manually set relevance to ${nextRelevance}.`,
                    updatedAt: Date.now(),
                },
            },
        }), { deferSave: true });
        if (options.pending) refreshPanelBody({ preserveScroll: true });
        else if (!refreshAcceptedLoreRow(entry.id)) refreshAcceptedLoreList({ preserveScroll: true });
        refreshAcceptedLoreBulkToolbar();
        refreshHeader();
        toast(`${entry.title || 'Lore entry'} relevance set to ${RELEVANCE_META[nextRelevance]?.label || nextRelevance}.`, 'info');
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
        category: LORE_CATEGORY_VALUES,
        canon: ['canon', 'au'],
        canonStatus: ['canon', 'au'],
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
    prefix.textContent = (field === 'canonStatus' || field === 'canon')
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
        updateLoreEntryById(entry.id, raw => field === 'canonStatus' || field === 'canon'
            ? ({ ...raw, canon: nextValue, canonStatus: nextValue })
            : ({ ...raw, [field]: nextValue }), { deferSave: true });
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


function createLorePurposeBadge(entry) {
    const purpose = normalizeLorePurpose(entry?.lorePurpose || entry?.purpose, entry) || 'unspecified';
    const label = LORE_PURPOSE_LABELS[purpose] || String(purpose || 'unspecified').replace(/[_-]+/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());
    return createBadge(`Purpose: ${label}`, 'Lore purpose explains why this is specific Wandlight lore rather than a generic reference fact.');
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
        metaRow.appendChild(createEditableLoreMetaBadge(entry, 'category', entry.category || 'other', null, `Category: ${entry.category || 'canon'}. Use dropdown to change.`));
        metaRow.appendChild(createLorePurposeBadge(entry));
        metaRow.appendChild(createEditableLoreMetaBadge(entry, 'canonStatus', entry.canon || entry.canonStatus || 'canon', null, `Canon/Story: ${entry.canon || entry.canonStatus || 'canon'}. Use dropdown to change.`));
        metaRow.appendChild(createEditableLoreMetaBadge(entry, 'truthStatus', entry.truthStatus || 'true', null, `Truth/reveal status: ${entry.truthStatus || 'true'}. Use dropdown to change.`));
        metaRow.appendChild(createEditableLoreMetaBadge(entry, 'revealPolicy', entry.revealPolicy || 'private', null, `Reveal policy: ${entry.revealPolicy || 'private'}. Use dropdown to change.`));
        metaRow.appendChild(createEditablePriorityBadge(entry));
    } else {
        metaRow.appendChild(createRegistryBadge('category', entry.category || 'other', `Category: ${entry.category || 'canon'}. Expand the entry to edit.`));
        metaRow.appendChild(createLorePurposeBadge(entry));
        metaRow.appendChild(createRegistryBadge('canonStatus', entry.canon || entry.canonStatus || 'canon', `Canon/Story: ${entry.canon || entry.canonStatus || 'canon'}. Expand the entry to edit.`));
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
            cond.textContent = `Relevant when: ${conditions.join(' | ')}`;
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
    normalizePanelLayoutState(state);
    state.lorePanel.drawerOpen = state.lorePanel.drawerOpen !== true;
    state.lorePanel.collapsed = state.lorePanel.drawerOpen !== true;
    saveState(state);
    showLorePanel();
}

function setDrawerOpen(open) {
    const state = getState();
    if (!state?.lorePanel) return;
    normalizePanelLayoutState(state);
    state.lorePanel.drawerOpen = open === true;
    state.lorePanel.collapsed = state.lorePanel.drawerOpen !== true;
    saveState(state);
    showLorePanel();
}

function toggleDrawerForTab(tabId) {
    const state = getState();
    if (!state?.lorePanel) return;
    normalizePanelLayoutState(state);
    const normalizedTab = normalizeTab(tabId);
    const sameActiveTab = normalizeTab(state.lorePanel.activeTab) === normalizedTab;
    const shouldClose = sameActiveTab && state.lorePanel.drawerOpen === true;
    state.lorePanel.activeTab = normalizedTab;
    state.lorePanel.drawerOpen = !shouldClose;
    state.lorePanel.collapsed = shouldClose;
    saveState(state);
    showLorePanel();
}

function toggleRailMode() {
    const state = getState();
    if (!state?.lorePanel) return;
    normalizePanelLayoutState(state);
    state.lorePanel.railMode = normalizeRailMode(state.lorePanel.railMode) === 'compact' ? 'expanded' : 'compact';
    saveState(state);
    showLorePanel();
}

function refreshPanelBody(options = {}) {
    if (!panelRoot) return;
    const stateForShell = getState();
    normalizePanelLayoutState(stateForShell);
    const body = panelRoot.querySelector('.wandlight-lore-panel-body');
    if (!body) {
        if (stateForShell?.lorePanel?.drawerOpen === true) renderPanelShell(panelRoot, stateForShell);
        else refreshHeader();
        return;
    }

    const activeNestedScroll = getActiveNestedScrollElement();
    const nestedScrollTop = options.preserveScroll && activeNestedScroll ? activeNestedScroll.scrollTop : 0;
    const tabScroll = getActiveTabScrollElement();
    const tabScrollTop = options.preserveScroll && tabScroll ? tabScroll.scrollTop : 0;
    const drawer = panelRoot.querySelector('.wandlight-runtime-drawer');
    const drawerScrollTop = options.preserveScroll && drawer ? (drawer.scrollTop || 0) : 0;
    const pageScrollElement = typeof document !== 'undefined' ? document.scrollingElement || document.documentElement : null;
    const pageScrollTop = (options.preserveScroll || options.preserveWindowScroll) && pageScrollElement
        ? pageScrollElement.scrollTop
        : null;
    const pageScrollLeft = (options.preserveScroll || options.preserveWindowScroll) && pageScrollElement
        ? pageScrollElement.scrollLeft
        : null;

    const state = stateForShell;
    renderPanelBody(body, state);
    refreshHeader();

    if (options.preserveScroll) {
        const newTabScroll = getActiveTabScrollElement();
        if (newTabScroll) newTabScroll.scrollTop = tabScrollTop;
        const newNestedScroll = getActiveNestedScrollElement();
        if (newNestedScroll) newNestedScroll.scrollTop = nestedScrollTop;
        if (drawer) drawer.scrollTop = drawerScrollTop;
    }
    updateDrawerScrollMetrics(drawer);

    if ((options.preserveScroll || options.preserveWindowScroll) && pageScrollElement && pageScrollTop !== null) {
        const restorePageScroll = () => {
            pageScrollElement.scrollTop = pageScrollTop;
            pageScrollElement.scrollLeft = pageScrollLeft || 0;
        };
        restorePageScroll();
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restorePageScroll);
    }
}

function getActiveTabScrollElement() {
    if (!panelRoot) return null;
    return panelRoot.querySelector('.wandlight-runtime-tab-body');
}

function getActiveNestedScrollElement() {
    if (!panelRoot) return null;
    return panelRoot.querySelector('.wandlight-accepted-lore-scroll-region')
        || panelRoot.querySelector('.wandlight-pending-lore-list')
        || panelRoot.querySelector('.wandlight-injection-preview')
        || panelRoot.querySelector('.wandlight-continuity-json-editor');
}

// Drag and resize -------------------------------------------------------------

function onDragStart(e) {
    if (!panelRoot) return;
    if (e.target.closest('button, input, textarea, select, .wandlight-lore-panel-resize-handle')) return;

    isDragging = true;
    const rect = panelRoot.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;

    panelRoot.style.left = `${rect.left}px`;
    panelRoot.style.top = `${rect.top}px`;
    panelRoot.style.right = '';
    panelRoot.style.bottom = '';
    panelRoot.classList.add('wandlight-runtime-dragging');

    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
}

function onDragMove(e) {
    if (!isDragging || !panelRoot) return;
    const state = getState();
    const panelState = normalizePanelLayoutState(state) || {};
    const railWidth = getRailWidth(panelState);
    const railHeight = panelRoot.querySelector('.wandlight-runtime-rail')?.offsetHeight || 80;
    const x = e.clientX - dragOffsetX;
    const y = e.clientY - dragOffsetY;
    const maxX = Math.max(0, window.innerWidth - railWidth);
    const maxY = Math.max(0, window.innerHeight - Math.min(railHeight, window.innerHeight));
    panelRoot.style.left = `${Math.max(0, Math.min(x, maxX))}px`;
    panelRoot.style.top = `${Math.max(0, Math.min(y, maxY))}px`;
}

function onDragEnd() {
    if (!panelRoot) return;
    isDragging = false;
    panelRoot.classList.remove('wandlight-runtime-dragging');
    saveRailGeometry();
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
}

function onResizeStart(e) {
    if (e.button !== 0 || !panelRoot) return;
    const drawer = panelRoot.querySelector('.wandlight-runtime-drawer');
    if (!drawer) return;

    isResizing = true;
    const rect = drawer.getBoundingClientRect();
    resizeStartX = e.clientX;
    resizeStartY = e.clientY;
    resizeStartWidth = rect.width;
    resizeStartHeight = rect.height;
    resizeStartDirection = panelRoot.dataset.drawerDirection === 'left' ? 'left' : 'right';

    drawer.classList.add('wandlight-lore-panel-resizing');

    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);

    document.addEventListener('pointermove', onResizeMove);
    document.addEventListener('pointerup', onResizeEnd);
    document.addEventListener('pointercancel', onResizeEnd);
}

function onResizeMove(e) {
    if (!isResizing || !panelRoot) return;
    const drawer = panelRoot.querySelector('.wandlight-runtime-drawer');
    if (!drawer) return;
    const state = getState();
    const panelState = normalizePanelLayoutState(state) || {};
    const railX = Number(panelState.railX) || 0;
    const railWidth = getRailWidth(panelState);
    const maxWidth = resizeStartDirection === 'left'
        ? Math.max(MIN_DRAWER_WIDTH, railX - RAIL_DRAWER_GAP - MAX_PANEL_MARGIN)
        : Math.max(MIN_DRAWER_WIDTH, window.innerWidth - railX - railWidth - RAIL_DRAWER_GAP - MAX_PANEL_MARGIN);
    const maxHeight = Math.max(MIN_DRAWER_HEIGHT, window.innerHeight - (Number(panelState.railY) || 0) - MAX_PANEL_MARGIN);
    const deltaX = e.clientX - resizeStartX;
    const requestedWidth = resizeStartDirection === 'left'
        ? resizeStartWidth - deltaX
        : resizeStartWidth + deltaX;
    const width = Math.max(MIN_DRAWER_WIDTH, Math.min(maxWidth, requestedWidth));
    const height = Math.max(MIN_DRAWER_HEIGHT, Math.min(maxHeight, resizeStartHeight + (e.clientY - resizeStartY)));
    drawer.style.width = `${width}px`;
    drawer.style.height = `${height}px`;
    panelRoot.style.setProperty('--wandlight-drawer-width', `${width}px`);
    panelRoot.style.setProperty('--wandlight-drawer-height', `${height}px`);
    updateDrawerScrollMetrics(drawer);
    updateAcceptedLoreScrollRegionHeight();
}

function onResizeEnd() {
    if (!isResizing || !panelRoot) return;
    isResizing = false;
    const drawer = panelRoot.querySelector('.wandlight-runtime-drawer');
    drawer?.classList.remove('wandlight-lore-panel-resizing');
    saveDrawerGeometry();
    document.removeEventListener('pointermove', onResizeMove);
    document.removeEventListener('pointerup', onResizeEnd);
    document.removeEventListener('pointercancel', onResizeEnd);
}

function saveRailGeometry() {
    if (!panelRoot) return;
    const state = getState();
    if (!state?.lorePanel) return;
    normalizePanelLayoutState(state);
    const rect = panelRoot.getBoundingClientRect();
    state.lorePanel.railX = Math.round(rect.left);
    state.lorePanel.railY = Math.round(rect.top);
    state.lorePanel.x = state.lorePanel.railX;
    state.lorePanel.y = state.lorePanel.railY;
    saveState(state);
}

function saveDrawerGeometry() {
    if (!panelRoot) return;
    const state = getState();
    if (!state?.lorePanel) return;
    normalizePanelLayoutState(state);
    const drawer = panelRoot.querySelector('.wandlight-runtime-drawer');
    if (!drawer) {
        saveState(state);
        return;
    }
    const rect = drawer.getBoundingClientRect();
    state.lorePanel.drawerWidth = Math.round(rect.width);
    state.lorePanel.drawerHeight = Math.round(rect.height);
    state.lorePanel.width = state.lorePanel.drawerWidth;
    state.lorePanel.height = state.lorePanel.drawerHeight;
    saveState(state);
}

function savePanelGeometry() {
    saveRailGeometry();
    saveDrawerGeometry();
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
        console.error('[Wandlight] Runtime action failed:', e);
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
    if (cat === 'active' || cat === 'high') return counts.high || counts.active || 0;
    if (cat === 'normal') return counts.normal || 0;
    if (cat === 'low') return counts.low || 0;
    if (cat === 'pinned') return counts.pinned;
    if (cat === 'suppressed') return counts.suppressed;
    if (cat === 'pending') return counts.pending;
    return entries.filter(e => e.category === cat).length;
}

function getCategoryTooltip(cat) {
    const registryMeta = getLoreRegistryMeta('categories', cat);
    if (registryMeta?.description) return registryMeta.description;
    const map = {
        all: 'Shows every accepted and pending lore entry.',
        active: 'Legacy alias for High Relevance.',
        high: 'Shows accepted lore in the High-Relevance injection tier.',
        normal: 'Shows accepted lore in the Normal-Relevance injection tier.',
        low: 'Shows accepted lore in the Low-Relevance injection tier.',
        pinned: 'Shows entries manually prioritized and protected during injection/compression.',
        suppressed: 'Shows muted entries excluded from injection.',
        pending: 'Shows generated entries that still need review.',
    };
    return map[cat] || `Shows lore entries in category: ${cat}.`;
}

function getPendingLoreBatchLabel(state) {
    const meta = state?.pendingLoreMeta || {};
    const parts = [];
    if (meta.createdAt) parts.push(`Generated ${new Date(meta.createdAt).toLocaleString()}`);
    if (meta.status) parts.push(`status: ${meta.status}`);
    if (meta.generationMode) parts.push(`${meta.generationMode} mode`);
    if (meta.targetEntryCount) parts.push(`target ${meta.targetEntryCount}`);
    if (meta.validEntryCount !== undefined) parts.push(`${meta.validEntryCount} valid`);
    if (meta.rawEntryCount !== undefined) parts.push(`${meta.rawEntryCount} raw`);
    if (meta.normalizedEntryCount !== undefined) parts.push(`${meta.normalizedEntryCount} normalized`);
    if (meta.droppedDuplicateCount) parts.push(`${meta.droppedDuplicateCount} duplicates filtered`);
    if (meta.droppedEntryCount) parts.push(`${meta.droppedEntryCount} dropped`);
    if (meta.chunkCount) parts.push(`${meta.chunkCount} chunks`);
    if (meta.sourceMessageCount) parts.push(`${meta.sourceMessageCount} source messages`);
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
