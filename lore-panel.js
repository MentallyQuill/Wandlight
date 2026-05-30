/**
 * lore-panel.js — Wandlight Continuity
 * Floating lore matrix panel component.
 * Renders a draggable, collapsible panel overlaying the chat area.
 * Shows all lore entries with filtering, search, and pending entry management.
 *
 * Imports: constants.js, state-manager.js, lore-matrix.js
 * Imported by: index.js
 */

import { MODULE_KEY } from './constants.js';
import { getPanelLoreState, normalizeLoreMatrix } from './lore-matrix.js';
import {
    getState,
    getSettings,
    saveState,
    acceptPendingLoreEntries,
    rejectPendingLoreEntries,
    acceptPendingLoreEntry,
    rejectPendingLoreEntry,
} from './state-manager.js';

// ── DOM cache ───────────────────────────────────────────────────────────────────
let panelRoot = null;
let isDragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;

const PANEL_ID = 'wandlight-lore-panel';
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
    relationship: 'Rel.',
    location: 'Location',
    rule: 'Rule',
    timeline: 'Timeline',
};

// ── Panel lifecycle ─────────────────────────────────────────────────────────────

/**
 * Creates or shows the floating lore panel.
 * Call this from index.js on CHAT_CHANGED or when the user clicks a button.
 */
export function showLorePanel() {
    // Persist isOpen = true
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

    // Apply saved collapsed state
    if (panelState.collapsed) {
        panelRoot.classList.add('wandlight-lore-panel-collapsed');
    }

    // Draggable header
    const header = document.createElement('div');
    header.className = 'wandlight-lore-panel-header';
    header.addEventListener('mousedown', onDragStart);

    // Collapse toggle
    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'wandlight-lore-panel-collapse-btn';
    collapseBtn.textContent = panelState.collapsed ? '▶' : '▼';
    collapseBtn.title = panelState.collapsed ? 'Expand lore panel' : 'Collapse lore panel';
    collapseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleCollapse();
    });
    header.appendChild(collapseBtn);

    const title = document.createElement('span');
    title.className = 'wandlight-lore-panel-title';
    title.textContent = '📖 Lore Matrix';
    header.appendChild(title);

    // Pending badge
    const pendingCount = (state?.pendingLoreEntries || []).length;
    if (pendingCount > 0) {
        const badge = document.createElement('span');
        badge.className = 'wandlight-lore-panel-badge';
        badge.textContent = `+${pendingCount} pending`;
        header.appendChild(badge);
    }

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.className = 'wandlight-lore-panel-close-btn';
    closeBtn.textContent = '✕';
    closeBtn.title = 'Close lore panel';
    closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        hideLorePanel();
    });
    header.appendChild(closeBtn);

    panelRoot.appendChild(header);

    // Body container
    const body = document.createElement('div');
    body.className = 'wandlight-lore-panel-body';
    panelRoot.appendChild(body);

    // If collapsed, only render the header
    if (!panelState.collapsed) {
        renderPanelBody(body, state);
    }

    document.body.appendChild(panelRoot);

    // Restore saved position
    if (panelState.x != null && panelState.y != null) {
        panelRoot.style.left = `${Math.max(0, Math.min(panelState.x, window.innerWidth - 340))}px`;
        panelRoot.style.top = `${Math.max(0, Math.min(panelState.y, window.innerHeight - 100))}px`;
    } else {
        // Default: bottom-right of viewport
        panelRoot.style.right = '16px';
        panelRoot.style.bottom = '16px';
    }
}

/**
 * Hides the panel and persists closed state.
 */
export function hideLorePanel() {
    removeLorePanel();
    const state = getState();
    if (state?.lorePanel) {
        state.lorePanel.isOpen = false;
        saveState(state);
    }
}

/**
 * Removes the panel DOM without saving state.
 */
function removeLorePanel() {
    if (panelRoot) {
        panelRoot.remove();
        panelRoot = null;
    }
    // Also clean up any orphaned panel
    const existing = document.getElementById(PANEL_ID);
    if (existing) existing.remove();
}

// ── Rendering ───────────────────────────────────────────────────────────────────

/**
 * Renders the body content of the panel.
 * @param {HTMLElement} container - The panel body element
 * @param {Object} state - WandlightState
 */
function renderPanelBody(container, state) {
    container.innerHTML = '';

    const panelState = state?.lorePanel || {
        selectedCategory: 'all',
        search: '',
        selectedEntryId: '',
        showOnlyActive: false,
    };

    const loreState = getPanelLoreState(state);
    const { entries, categories, counts } = loreState;

    // ── Pending entries bar ──
    const pendingEntries = normalizeLoreMatrix(state?.pendingLoreEntries || []);
    if (pendingEntries.length > 0) {
        const pendingBar = document.createElement('div');
        pendingBar.className = 'wandlight-lore-pending-bar';

        const pendingLabel = document.createElement('span');
        pendingLabel.className = 'wandlight-lore-pending-label';
        pendingLabel.textContent = `${pendingEntries.length} pending entries`;
        pendingBar.appendChild(pendingLabel);

        const pendingActions = document.createElement('div');
        pendingActions.className = 'wandlight-lore-pending-actions';

        const acceptAllBtn = document.createElement('button');
        acceptAllBtn.className = 'wandlight-lore-pending-accept';
        acceptAllBtn.textContent = 'Accept All';
        acceptAllBtn.addEventListener('click', () => {
            acceptPendingLoreEntries();
            refreshLorePanel();
        });
        pendingActions.appendChild(acceptAllBtn);

        const rejectAllBtn = document.createElement('button');
        rejectAllBtn.className = 'wandlight-lore-pending-reject';
        rejectAllBtn.textContent = 'Reject All';
        rejectAllBtn.addEventListener('click', () => {
            rejectPendingLoreEntries();
            refreshLorePanel();
        });
        pendingActions.appendChild(rejectAllBtn);

        pendingBar.appendChild(pendingActions);
        container.appendChild(pendingBar);
    }

    // ── Category tabs ──
    const tabBar = document.createElement('div');
    tabBar.className = 'wandlight-lore-tabs';
    for (const cat of categories) {
        const tab = document.createElement('button');
        tab.className = 'wandlight-lore-tab';
        if (cat === panelState.selectedCategory) {
            tab.classList.add('wandlight-lore-tab-active');
        }
        const label = CATEGORY_LABELS[cat] || cat;
        let catCount;
        if (cat === 'all') {
            catCount = counts.all;
        } else if (cat === 'active') {
            catCount = counts.active;
        } else if (cat === 'pinned') {
            catCount = counts.pinned;
        } else if (cat === 'suppressed') {
            catCount = counts.suppressed;
        } else if (cat === 'pending') {
            catCount = counts.pending;
        } else {
            catCount = entries.filter(e => e.category === cat).length;
        }
        tab.textContent = `${label} (${catCount})`;
        tab.addEventListener('click', () => {
            setPanelFilter('category', cat);
            refreshLorePanel();
        });
        tabBar.appendChild(tab);
    }
    container.appendChild(tabBar);

    // ── Search + filters row ──
    const filterRow = document.createElement('div');
    filterRow.className = 'wandlight-lore-filter-row';

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'wandlight-lore-search';
    searchInput.placeholder = 'Search lore entries…';
    searchInput.value = panelState.search;
    searchInput.addEventListener('input', (e) => {
        setPanelFilter('search', e.target.value);
        refreshLorePanel();
    });
    filterRow.appendChild(searchInput);

    const activeToggle = document.createElement('label');
    activeToggle.className = 'wandlight-lore-active-toggle';
    activeToggle.innerHTML = `
        <input type="checkbox" ${panelState.showOnlyActive ? 'checked' : ''}>
        <span>Active only</span>
    `;
    activeToggle.querySelector('input').addEventListener('change', (e) => {
        setPanelFilter('showOnlyActive', e.target.checked);
        refreshLorePanel();
    });
    filterRow.appendChild(activeToggle);

    container.appendChild(filterRow);

    // ── Filter entries ──
    let filtered = entries;
    if (panelState.selectedCategory === 'active') {
        filtered = filtered.filter(e => e.isActive || e.isPinned);
    } else if (panelState.selectedCategory === 'pinned') {
        filtered = filtered.filter(e => e.isPinned);
    } else if (panelState.selectedCategory === 'suppressed') {
        filtered = filtered.filter(e => e.isSuppressed);
    } else if (panelState.selectedCategory === 'pending') {
        filtered = filtered.filter(e => e.isPending);
    } else if (panelState.selectedCategory !== 'all') {
        filtered = filtered.filter(e => e.category === panelState.selectedCategory);
    }
    if (panelState.search) {
        const query = panelState.search.toLowerCase();
        filtered = filtered.filter(e =>
            e.title.toLowerCase().includes(query)
            || e.fact.toLowerCase().includes(query)
            || (e.id && e.id.toLowerCase().includes(query))
            || (e.notes && e.notes.toLowerCase().includes(query))
        );
    }
    if (panelState.showOnlyActive) {
        filtered = filtered.filter(e => e.isActive || e.isPending);
    }

    // ── Entry list ──
    const list = document.createElement('div');
    list.className = 'wandlight-lore-entry-list';

    if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'wandlight-lore-empty';
        empty.textContent = 'No lore entries found.';
        list.appendChild(empty);
    } else {
        for (const entry of filtered) {
            list.appendChild(createEntryCard(entry, state));
        }
    }

    container.appendChild(list);
}

/**
 * Creates a single lore entry card.
 * @param {Object} entry - Annotated lore entry from getPanelLoreState
 * @param {Object} state - WandlightState
 * @returns {HTMLElement}
 */
function createEntryCard(entry, state) {
    const card = document.createElement('div');
    card.className = 'wandlight-lore-entry-card';

    if (entry.isPending) {
        card.classList.add('wandlight-lore-entry-pending');
    }
    if (entry.isActive) {
        card.classList.add('wandlight-lore-entry-active');
    }
    if (entry.isPinned) {
        card.classList.add('wandlight-lore-entry-pinned');
    }
    if (entry.isSuppressed) {
        card.classList.add('wandlight-lore-entry-suppressed');
    }

    // Show selected entry expanded
    const panelState = state?.lorePanel || {};
    if (panelState.selectedEntryId === entry.id) {
        card.classList.add('wandlight-lore-entry-expanded');
    }

    // ── Header row ──
    const headerRow = document.createElement('div');
    headerRow.className = 'wandlight-lore-entry-header';

    const titleEl = document.createElement('span');
    titleEl.className = 'wandlight-lore-entry-title';
    titleEl.textContent = entry.title;
    titleEl.title = entry.title;
    headerRow.appendChild(titleEl);

    // Action buttons
    const actions = document.createElement('div');
    actions.className = 'wandlight-lore-entry-actions';

    // Pin/Unpin button
    const pinBtn = document.createElement('button');
    pinBtn.className = 'wandlight-lore-entry-btn';
    pinBtn.textContent = entry.isPinned ? '📌' : '📍';
    pinBtn.title = entry.isPinned ? 'Unpin from active lore' : 'Pin to active lore';
    pinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePinEntry(entry.id);
        refreshLorePanel();
    });
    actions.appendChild(pinBtn);

    // Suppress/Unsuppress button
    const suppressBtn = document.createElement('button');
    suppressBtn.className = 'wandlight-lore-entry-btn';
    suppressBtn.textContent = entry.isSuppressed ? '🔇' : '🔊';
    suppressBtn.title = entry.isSuppressed ? 'Unsuppress entry' : 'Suppress entry from injection';
    suppressBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSuppressEntry(entry.id);
        refreshLorePanel();
    });
    actions.appendChild(suppressBtn);

    headerRow.appendChild(actions);
    card.appendChild(headerRow);

    // ── Meta badges ──
    const metaRow = document.createElement('div');
    metaRow.className = 'wandlight-lore-entry-meta';

    const categoryBadge = document.createElement('span');
    categoryBadge.className = `wandlight-lore-badge wandlight-lore-badge-${entry.category}`;
    categoryBadge.textContent = entry.category;
    metaRow.appendChild(categoryBadge);

    if (entry.truthStatus && entry.truthStatus !== 'true') {
        const truthBadge = document.createElement('span');
        truthBadge.className = 'wandlight-lore-badge wandlight-lore-badge-truth';
        truthBadge.textContent = entry.truthStatus;
        metaRow.appendChild(truthBadge);
    }

    if (entry.isPending) {
        const pendingBadge = document.createElement('span');
        pendingBadge.className = 'wandlight-lore-badge wandlight-lore-badge-pending';
        pendingBadge.textContent = 'pending';
        metaRow.appendChild(pendingBadge);
    }

    if (entry.priority) {
        const prioBadge = document.createElement('span');
        prioBadge.className = 'wandlight-lore-badge wandlight-lore-badge-priority';
        prioBadge.textContent = `P${entry.priority}`;
        metaRow.appendChild(prioBadge);
    }

    card.appendChild(metaRow);

    // ── Fact text ──
    const factEl = document.createElement('div');
    factEl.className = 'wandlight-lore-entry-fact';
    factEl.textContent = truncateText(entry.fact || '', 120);
    card.appendChild(factEl);

    // ── Click to toggle expand ──
    card.addEventListener('click', () => {
        const currentPanelState = (getState()?.lorePanel) || {};
        const newId = currentPanelState.selectedEntryId === entry.id ? '' : entry.id;
        setPanelFilter('selectedEntryId', newId);
        refreshLorePanel();
    });

    // ── Expanded details ──
    if (panelState.selectedEntryId === entry.id) {
        const details = document.createElement('div');
        details.className = 'wandlight-lore-entry-details';

        // Full fact
        if (entry.fact && entry.fact.length > 120) {
            const fullFact = document.createElement('div');
            fullFact.className = 'wandlight-lore-entry-full-fact';
            fullFact.textContent = entry.fact;
            details.appendChild(fullFact);
        }

        // Truth info
        const truthInfo = [];
        if (entry.publicVersion) {
            truthInfo.push(`Public version: ${entry.publicVersion}`);
        }
        if (entry.whoKnowsTruth?.length) {
            truthInfo.push(`Who knows: ${entry.whoKnowsTruth.join(', ')}`);
        }
        if (entry.whoSuspects?.length) {
            truthInfo.push(`Who suspects: ${entry.whoSuspects.join(', ')}`);
        }
        if (entry.revealPolicy) {
            truthInfo.push(`Reveal policy: ${entry.revealPolicy}`);
        }
        if (truthInfo.length > 0) {
            const truthEl = document.createElement('div');
            truthEl.className = 'wandlight-lore-entry-truth-info';
            truthEl.innerHTML = truthInfo.map(t => `<div>${escapeHtml(t)}</div>`).join('');
            details.appendChild(truthEl);
        }

        // Date window
        if (entry.validFrom || entry.validTo) {
            const dateEl = document.createElement('div');
            dateEl.className = 'wandlight-lore-entry-date-window';
            dateEl.textContent = `Valid: ${entry.validFrom || '…'} → ${entry.validTo || '…'}`;
            details.appendChild(dateEl);
        }

        // Active conditions
        const aw = entry.activeWhen || {};
        const conditions = [];
        if (aw.erasAny?.length) conditions.push(`Eras: ${aw.erasAny.join(', ')}`);
        if (aw.locationsAny?.length) conditions.push(`Locations: ${aw.locationsAny.join(', ')}`);
        if (aw.charactersPresentAny?.length) conditions.push(`Cast: ${aw.charactersPresentAny.join(', ')}`);
        if (aw.tagsAny?.length) conditions.push(`Tags: ${aw.tagsAny.join(', ')}`);
        if (conditions.length > 0) {
            const condEl = document.createElement('div');
            condEl.className = 'wandlight-lore-entry-conditions';
            condEl.innerHTML = `<strong>Active when:</strong><br>${conditions.map(c => escapeHtml(c)).join('<br>')}`;
            details.appendChild(condEl);
        }

        // Notes
        if (entry.notes) {
            const notesEl = document.createElement('div');
            notesEl.className = 'wandlight-lore-entry-notes';
            notesEl.textContent = `Notes: ${entry.notes}`;
            details.appendChild(notesEl);
        }

        // ── Per-entry accept/reject buttons (only for pending entries) ──
        if (entry.isPending) {
            const entryActions = document.createElement('div');
            entryActions.className = 'wandlight-lore-entry-pending-actions';

            const acceptBtn = document.createElement('button');
            acceptBtn.className = 'wandlight-lore-entry-accept';
            acceptBtn.textContent = '✓ Accept';
            acceptBtn.title = 'Accept this lore entry into the matrix';
            acceptBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                // Find the index of this entry in pending list
                const currentState = getState();
                const pending = normalizeLoreMatrix(currentState?.pendingLoreEntries || []);
                const idx = pending.findIndex(pe => pe.id === entry.id);
                if (idx >= 0) {
                    acceptPendingLoreEntry(idx);
                    refreshLorePanel();
                }
            });
            entryActions.appendChild(acceptBtn);

            const rejectBtn = document.createElement('button');
            rejectBtn.className = 'wandlight-lore-entry-reject';
            rejectBtn.textContent = '✗ Reject';
            rejectBtn.title = 'Reject this lore entry';
            rejectBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const currentState = getState();
                const pending = normalizeLoreMatrix(currentState?.pendingLoreEntries || []);
                const idx = pending.findIndex(pe => pe.id === entry.id);
                if (idx >= 0) {
                    rejectPendingLoreEntry(idx);
                    refreshLorePanel();
                }
            });
            entryActions.appendChild(rejectBtn);

            details.appendChild(entryActions);
        }

        card.appendChild(details);
    }

    return card;
}

// ── User actions ────────────────────────────────────────────────────────────────

/**
 * Toggles a lore entry's pinned state in loreSelection.
 * @param {string} entryId
 */
function togglePinEntry(entryId) {
    const state = getState();
    if (!state?.loreSelection) return;
    const sel = state.loreSelection;
    const idx = sel.pinnedIds.indexOf(entryId);
    if (idx >= 0) {
        sel.pinnedIds.splice(idx, 1);
    } else {
        sel.pinnedIds.push(entryId);
        // Unsuppress when pinning (pin implies active, not suppressed)
        const supIdx = sel.suppressedIds.indexOf(entryId);
        if (supIdx >= 0) sel.suppressedIds.splice(supIdx, 1);
    }
    saveState(state);
}

/**
 * Toggles a lore entry's suppressed state in loreSelection.
 * @param {string} entryId
 */
function toggleSuppressEntry(entryId) {
    const state = getState();
    if (!state?.loreSelection) return;
    const sel = state.loreSelection;
    const idx = sel.suppressedIds.indexOf(entryId);
    if (idx >= 0) {
        sel.suppressedIds.splice(idx, 1);
    } else {
        sel.suppressedIds.push(entryId);
        // Unpin when suppressing (suppress implies not active)
        const pinIdx = sel.pinnedIds.indexOf(entryId);
        if (pinIdx >= 0) sel.pinnedIds.splice(pinIdx, 1);
    }
    saveState(state);
}

/**
 * Sets a specific filter value on the lorePanel state.
 * @param {string} key - 'category', 'search', 'selectedEntryId', or 'showOnlyActive'
 * @param {*} value
 */
function setPanelFilter(key, value) {
    const state = getState();
    if (!state?.lorePanel) return;
    state.lorePanel[key] = value;
    saveState(state);
}

/**
 * Toggles the collapsed state of the panel.
 */
function toggleCollapse() {
    const state = getState();
    if (!state?.lorePanel) return;
    state.lorePanel.collapsed = !state.lorePanel.collapsed;
    saveState(state);
    showLorePanel();
}

/**
 * Re-renders the panel body while keeping the panel root in place.
 */
function refreshLorePanelBody() {
    if (!panelRoot) return;
    const body = panelRoot.querySelector('.wandlight-lore-panel-body');
    if (!body) return;
    const state = getState();
    renderPanelBody(body, state);
}

// ── Drag handling ───────────────────────────────────────────────────────────────

function onDragStart(e) {
    // Don't start dragging if clicking on a button
    if (e.target.tagName === 'BUTTON') return;

    isDragging = true;
    const rect = panelRoot.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;

    // Switch from right/bottom positioning to left/top
    panelRoot.style.right = '';
    panelRoot.style.bottom = '';
    panelRoot.style.left = `${rect.left}px`;
    panelRoot.style.top = `${rect.top}px`;
    panelRoot.style.cursor = 'grabbing';

    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
}

function onDragMove(e) {
    if (!isDragging) return;
    const x = e.clientX - dragOffsetX;
    const y = e.clientY - dragOffsetY;

    // Clamp within viewport
    const maxX = window.innerWidth - panelRoot.offsetWidth;
    const maxY = window.innerHeight - panelRoot.offsetHeight;
    panelRoot.style.left = `${Math.max(0, Math.min(x, maxX))}px`;
    panelRoot.style.top = `${Math.max(0, Math.min(y, maxY))}px`;
}

function onDragEnd() {
    isDragging = false;
    panelRoot.style.cursor = '';

    // Save position
    const state = getState();
    if (state?.lorePanel) {
        state.lorePanel.x = parseInt(panelRoot.style.left, 10);
        state.lorePanel.y = parseInt(panelRoot.style.top, 10);
        saveState(state);
    }

    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function truncateText(text, maxLen) {
    if (!text || text.length <= maxLen) return text;
    return text.slice(0, maxLen).replace(/\s+\S*$/, '') + '…';
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ── Public API ──────────────────────────────────────────────────────────────────

/**
 * Recreates the panel in-place (e.g., after state changes from extraction).
 */
export function refreshLorePanel() {
    // If the panel isn't open, do nothing
    const existing = document.getElementById(PANEL_ID);
    if (!existing) return;

    const state = getState();
    if (!state?.lorePanel?.isOpen) {
        removeLorePanel();
        return;
    }

    // Simple refresh: re-render the body
    removeLorePanel();
    showLorePanel();
}