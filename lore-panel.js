/**
 * lore-panel.js — Wandlight Continuity
 * Floating lore matrix panel component.
 * Renders a draggable, collapsible, resizable panel overlaying the chat area.
 * Shows all lore entries with filtering, search, and pending entry management.
 *
 * Imports: constants.js, state-manager.js, lore-matrix.js
 * Imported by: index.js
 */

import { MODULE_KEY } from './constants.js';
import { getPanelLoreState, normalizeLoreMatrix, normalizeLoreEntry } from './lore-matrix.js';
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

// ── Resize state ────────────────────────────────────────────────────────────────
let isResizing = false;
let resizeStartX = 0;
let resizeStartY = 0;
let resizeStartWidth = 0;
let resizeStartHeight = 0;

const MIN_PANEL_WIDTH = 320;
const MIN_PANEL_HEIGHT = 260;
const MAX_PANEL_MARGIN = 16;

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

    // Apply saved dimensions
    const savedWidth = Math.max(MIN_PANEL_WIDTH, Number(panelState.width) || 420);
    const savedHeight = Math.max(MIN_PANEL_HEIGHT, Number(panelState.height) || 520);

    panelRoot.style.width = `${Math.min(savedWidth, window.innerWidth - MAX_PANEL_MARGIN)}px`;
    panelRoot.style.height = `${Math.min(savedHeight, window.innerHeight - MAX_PANEL_MARGIN)}px`;

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
    title.textContent = '\uD83D\uDCD6 Lore Matrix';
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
    closeBtn.textContent = '\u2715';
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

    // If collapsed, only render the header
    if (!panelState.collapsed) {
        renderPanelBody(body, state);
    }

    panelRoot.appendChild(body);

    // Add resize handle before appending
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'wandlight-lore-panel-resize-handle';
    resizeHandle.title = 'Resize lore panel';
    resizeHandle.addEventListener('pointerdown', onResizeStart);
    panelRoot.appendChild(resizeHandle);

    document.body.appendChild(panelRoot);

    // Restore saved position (clamp with actual panel dimensions)
    if (panelState.x != null && panelState.y != null) {
        // Wait for browser to compute dimensions
        requestAnimationFrame(() => {
            if (!panelRoot) return;
            panelRoot.style.left = `${Math.max(0, Math.min(panelState.x, window.innerWidth - panelRoot.offsetWidth))}px`;
            panelRoot.style.top = `${Math.max(0, Math.min(panelState.y, window.innerHeight - panelRoot.offsetHeight))}px`;
        });
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
            refreshLorePanelBody({ preserveScroll: true });
        });
        pendingActions.appendChild(acceptAllBtn);

        const rejectAllBtn = document.createElement('button');
        rejectAllBtn.className = 'wandlight-lore-pending-reject';
        rejectAllBtn.textContent = 'Reject All';
        rejectAllBtn.addEventListener('click', () => {
            rejectPendingLoreEntries();
            refreshLorePanelBody({ preserveScroll: true });
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
            refreshLorePanelBody({ preserveScroll: false });
        });
        tabBar.appendChild(tab);
    }
    container.appendChild(tabBar);

    // ── Search row ──
    const filterRow = document.createElement('div');
    filterRow.className = 'wandlight-lore-filter-row';

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'wandlight-lore-search';
    searchInput.placeholder = 'Search lore entries\u2026';
    searchInput.value = panelState.search;
    searchInput.addEventListener('input', (e) => {
        setPanelFilter('search', e.target.value);

        const list = container.querySelector('.wandlight-lore-entry-list');
        if (list) {
            renderEntryList(list, getState());
        }
    });
    filterRow.appendChild(searchInput);

    container.appendChild(filterRow);

    // ── Entry list ──
    const list = document.createElement('div');
    list.className = 'wandlight-lore-entry-list';
    renderEntryList(list, state);
    container.appendChild(list);
}

/**
 * Filters lore entries by category and search query, then renders into the list element.
 * @param {HTMLElement} list - The entry list container
 * @param {Object} state - WandlightState
 */
function renderEntryList(list, state) {
    if (!list) return;

    list.innerHTML = '';

    const filtered = getFilteredLoreEntries(state);

    if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'wandlight-lore-empty';
        empty.textContent = 'No lore entries found.';
        list.appendChild(empty);
        return;
    }

    for (const entry of filtered) {
        list.appendChild(createEntryCard(entry, state));
    }
}

/**
 * Returns lore entries filtered by category and search query.
 * Search matches title, tags, fact, notes, and id — scored and sorted.
 * @param {Object} state - WandlightState
 * @returns {Object[]} Filtered and sorted lore entries
 */
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
    } else if (panelState.selectedCategory !== 'all') {
        filtered = filtered.filter(e => e.category === panelState.selectedCategory);
    }

    const query = String(panelState.search || '').trim().toLowerCase();
    if (!query) return filtered;

    const score = (entry) => {
        const title = String(entry.title || '').toLowerCase();
        const tags = Array.isArray(entry.tags)
            ? entry.tags.map(t => String(t).toLowerCase())
            : [];
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
    };

    return filtered
        .map(entry => ({ entry, score: score(entry) }))
        .filter(item => item.score > 0)
        .sort((a, b) =>
            b.score - a.score
            || Number(b.entry.priority || 50) - Number(a.entry.priority || 50)
            || String(a.entry.title || '').localeCompare(String(b.entry.title || ''))
        )
        .map(item => item.entry);
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

    const titleWrap = document.createElement('div');
    titleWrap.className = 'wandlight-lore-entry-title-wrap';

    const titleEl = document.createElement('span');
    titleEl.className = 'wandlight-lore-entry-title';
    titleEl.textContent = entry.title;
    titleEl.title = entry.title;
    titleWrap.appendChild(titleEl);

    titleWrap.appendChild(createTagsRow(entry));
    headerRow.appendChild(titleWrap);

    // Action buttons
    const actions = document.createElement('div');
    actions.className = 'wandlight-lore-entry-actions';

    // Pin/Unpin button
    const pinBtn = document.createElement('button');
    pinBtn.className = 'wandlight-lore-entry-btn';
    pinBtn.textContent = entry.isPinned ? '\uD83D\uDCCC' : '\uD83D\uDCCD';
    pinBtn.title = entry.isPinned ? 'Unpin from active lore' : 'Pin to active lore';
    pinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePinEntry(entry.id);
        refreshLorePanelBody({ preserveScroll: true });
    });
    actions.appendChild(pinBtn);

    // Suppress/Unsuppress button
    const suppressBtn = document.createElement('button');
    suppressBtn.className = 'wandlight-lore-entry-btn';
    suppressBtn.textContent = entry.isSuppressed ? '\uD83D\uDD07' : '\uD83D\uDD0A';
    suppressBtn.title = entry.isSuppressed ? 'Unsuppress entry' : 'Suppress entry from injection';
    suppressBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSuppressEntry(entry.id);
        refreshLorePanelBody({ preserveScroll: true });
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
        refreshLorePanelBody({ preserveScroll: true });
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
            dateEl.textContent = `Valid: ${entry.validFrom || '\u2026'} \u2192 ${entry.validTo || '\u2026'}`;
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
            acceptBtn.textContent = '\u2713 Accept';
            acceptBtn.title = 'Accept this lore entry into the matrix';
            acceptBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const currentState = getState();
                const pending = normalizeLoreMatrix(currentState?.pendingLoreEntries || []);
                const idx = pending.findIndex(pe => pe.id === entry.id);
                if (idx >= 0) {
                    acceptPendingLoreEntry(idx);
                    refreshLorePanelBody({ preserveScroll: true });
                }
            });
            entryActions.appendChild(acceptBtn);

            const rejectBtn = document.createElement('button');
            rejectBtn.className = 'wandlight-lore-entry-reject';
            rejectBtn.textContent = '\u2717 Reject';
            rejectBtn.title = 'Reject this lore entry';
            rejectBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const currentState = getState();
                const pending = normalizeLoreMatrix(currentState?.pendingLoreEntries || []);
                const idx = pending.findIndex(pe => pe.id === entry.id);
                if (idx >= 0) {
                    rejectPendingLoreEntry(idx);
                    refreshLorePanelBody({ preserveScroll: true });
                }
            });
            entryActions.appendChild(rejectBtn);

            details.appendChild(entryActions);
        }

        card.appendChild(details);
    }

    return card;
}

// ── Tag rendering ───────────────────────────────────────────────────────────────

/**
 * Creates the tags row element for an entry card.
 * @param {Object} entry - Lore entry
 * @returns {HTMLElement}
 */
function createTagsRow(entry) {
    const row = document.createElement('div');
    row.className = 'wandlight-lore-entry-tags';

    const tags = Array.isArray(entry.tags) ? entry.tags : [];

    for (const tag of tags) {
        const chip = document.createElement('span');
        chip.className = 'wandlight-lore-tag-chip';

        const removeBtn = document.createElement('button');
        removeBtn.className = 'wandlight-lore-tag-remove';
        removeBtn.type = 'button';
        removeBtn.textContent = 'x';
        removeBtn.title = `Remove tag: ${tag}`;
        removeBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            removeLoreTag(entry.id, tag);
            refreshLorePanelBody({ preserveScroll: true });
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
    addBtn.title = 'Add search tag';
    addBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showInlineTagInput(row, entry.id, addBtn);
    });
    row.appendChild(addBtn);

    return row;
}

/**
 * Shows an inline text input for adding a new tag.
 * @param {HTMLElement} row - The tags row element
 * @param {string} entryId
 * @param {HTMLElement} addBtn - The add button element
 */
function showInlineTagInput(row, entryId, addBtn) {
    if (row.querySelector('.wandlight-lore-tag-input')) return;

    const input = document.createElement('input');
    input.className = 'wandlight-lore-tag-input';
    input.type = 'text';
    input.placeholder = 'tag';

    input.addEventListener('click', e => e.stopPropagation());
    input.addEventListener('mousedown', e => e.stopPropagation());

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            commitInlineTagInput(entryId, input.value);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            input.remove();
        }
    });

    input.addEventListener('blur', () => {
        if (input.value.trim()) {
            commitInlineTagInput(entryId, input.value);
        } else {
            input.remove();
        }
    });

    row.insertBefore(input, addBtn);
    requestAnimationFrame(() => input.focus());
}

/**
 * Commits the inline tag input value.
 * @param {string} entryId
 * @param {string} rawTag
 */
function commitInlineTagInput(entryId, rawTag) {
    const tag = normalizeTag(rawTag);

    if (!tag) {
        refreshLorePanelBody({ preserveScroll: true });
        return;
    }

    addLoreTag(entryId, tag);
    refreshLorePanelBody({ preserveScroll: true });
}

/**
 * Normalizes a tag string: trimmed, single-space, max 40 chars.
 * @param {string} value
 * @returns {string}
 */
function normalizeTag(value) {
    return String(value || '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 40);
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
 * Updates a lore entry in-place by entryId.
 * @param {string} entryId
 * @param {Function} updater - Receives the entry, returns the updated entry
 * @returns {boolean} Whether the entry was found and updated
 */
function updateLoreEntryById(entryId, updater) {
    const state = getState();

    if (!entryId || typeof updater !== 'function') {
        return false;
    }

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

/**
 * Adds a tag to a lore entry.
 * @param {string} entryId
 * @param {string} tag
 * @returns {boolean}
 */
function addLoreTag(entryId, tag) {
    const clean = normalizeTag(tag);

    if (!clean) {
        return false;
    }

    return updateLoreEntryById(entryId, (entry) => {
        const tags = Array.isArray(entry.tags)
            ? entry.tags.map(normalizeTag).filter(Boolean)
            : [];

        const exists = tags.some(t => t.toLowerCase() === clean.toLowerCase());

        return {
            ...entry,
            tags: exists ? tags : [...tags, clean],
        };
    });
}

/**
 * Removes a tag from a lore entry.
 * @param {string} entryId
 * @param {string} tag
 * @returns {boolean}
 */
function removeLoreTag(entryId, tag) {
    const clean = normalizeTag(tag).toLowerCase();

    return updateLoreEntryById(entryId, (entry) => ({
        ...entry,
        tags: (Array.isArray(entry.tags) ? entry.tags : [])
            .map(normalizeTag)
            .filter(t => t && t.toLowerCase() !== clean),
    }));
}

/**
 * Sets a specific filter value on the lorePanel state.
 * @param {string} key - 'category', 'search', or 'selectedEntryId'
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
 * Optionally preserves scroll position.
 * @param {Object} [options]
 * @param {boolean} [options.preserveScroll=false]
 */
function refreshLorePanelBody(options = {}) {
    if (!panelRoot) return;

    const body = panelRoot.querySelector('.wandlight-lore-panel-body');
    if (!body) return;

    const list = panelRoot.querySelector('.wandlight-lore-entry-list');
    const scrollTop = options.preserveScroll && list ? list.scrollTop : 0;

    const state = getState();
    renderPanelBody(body, state);

    if (options.preserveScroll) {
        const newList = panelRoot.querySelector('.wandlight-lore-entry-list');
        if (newList) {
            newList.scrollTop = scrollTop;
        }
    }
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

    savePanelGeometry();

    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
}

// ── Resize handling ─────────────────────────────────────────────────────────────

function onResizeStart(e) {
    if (e.button !== 0) return;
    if (!panelRoot) return;

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

    const maxWidth = Math.max(
        MIN_PANEL_WIDTH,
        window.innerWidth - rect.left - MAX_PANEL_MARGIN
    );

    const maxHeight = Math.max(
        MIN_PANEL_HEIGHT,
        window.innerHeight - rect.top - MAX_PANEL_MARGIN
    );

    const width = Math.max(
        MIN_PANEL_WIDTH,
        Math.min(maxWidth, resizeStartWidth + (e.clientX - resizeStartX))
    );

    const height = Math.max(
        MIN_PANEL_HEIGHT,
        Math.min(maxHeight, resizeStartHeight + (e.clientY - resizeStartY))
    );

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

/**
 * Saves the current panel geometry (x, y, width, height) to state.
 */
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

// ── Helpers ─────────────────────────────────────────────────────────────────────

function truncateText(text, maxLen) {
    if (!text || text.length <= maxLen) return text;
    return text.slice(0, maxLen).replace(/\s+\S*$/, '') + '\u2026';
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
    const existing = document.getElementById(PANEL_ID);

    if (!existing) {
        return;
    }

    const state = getState();

    if (!state?.lorePanel?.isOpen) {
        removeLorePanel();
        return;
    }

    refreshLorePanelBody({ preserveScroll: true });
}