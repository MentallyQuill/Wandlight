/**
 * ui.js — Wandlight
 * Renders the settings panel and state viewer UI.
 *
 * Exports: renderSettingsPanel, renderStatePanel, renderLoreContextPreview, renderLoreMatrixPreview
 * Imported by: index.js
 */

import { buildMemo } from './memo-builder.js';
import { getState, saveState, pushStateSnapshot, importState, getSettings, saveSettings } from './state-manager.js';
import {
    normalizeLoreMatrix,
    normalizeLoreContext,
    getActiveLoreEntries,
} from './lore-matrix.js';
import { storeNamedApiKey, deleteNamedApiKey } from './secure-keyring.js';
import { loadApiKey, fetchLoreModels, testLoreConnection, validateLoreProviderConfiguration, getAvailableConnectionProfiles, getAvailableCompletionPresets } from './lore-llm-client.js';

/**
 * Renders the settings panel HTML into the container.
 * Since settings.html is loaded via renderExtensionTemplateAsync(),
 * this function populates dynamic values, wires range displays,
 * and initializes the memo preview.
 *
 * @param {HTMLElement} container - The settings panel div
 */
export function renderSettingsPanel(container) {
    if (!container) return;

    // Wire range-input live value displays
    wireRangeDisplay('wandlight_extraction_interval', 'wandlight_extraction_interval_value');
    wireRangeDisplay('wandlight_max_lore_entries_in_memo', 'wandlight_max_lore_entries_in_memo_value');
    wireRangeDisplay('wandlight_max_lore_entries_in_matrix', 'wandlight_max_lore_entries_in_matrix_value');

    // Wire the lore-matrix JSON editor
    wireLoreMatrixEditor();

    // Wire the lore model provider panel
    setupLoreProviderPanel(container);

    // State viewer: double-click to edit raw JSON
    const stateDisplay = container.querySelector('#wandlight_state_display');
    const stateEditor = container.querySelector('#wandlight_state_json');
    if (stateDisplay && stateEditor) {
        stateDisplay.addEventListener('dblclick', () => {
            const state = getState();
            stateEditor.value = JSON.stringify(state, null, 2);
            stateDisplay.style.display = 'none';
            stateEditor.style.display = 'block';
            stateEditor.focus();
        });
    }

    // Save edited state — with snapshot, migration, and validation
    const saveStateBtn = container.querySelector('#wandlight_save_state');
    if (saveStateBtn && stateEditor && stateDisplay) {
        saveStateBtn.addEventListener('click', () => {
            try {
                const parsed = JSON.parse(stateEditor.value);
                if (!parsed || typeof parsed !== 'object') {
                    if (typeof toastr !== 'undefined') toastr.error('Invalid state JSON');
                    return;
                }
                // Use importState for migration + validation
                const previous = getState();
                const { state: imported, error } = importState(JSON.stringify(parsed));
                if (error) {
                    if (typeof toastr !== 'undefined') toastr.error('State validation failed: ' + error);
                    return;
                }
                // Snapshot the current state before overwriting
                const settings = getSettings();
                pushStateSnapshot(previous, 'Manual state edit', settings.maxSnapshots);
                // Carry forward stateHistory so the snapshot isn't orphaned
                imported.stateHistory = previous.stateHistory;
                imported.memoHistory = previous.memoHistory || [];
                saveState(imported);
                if (typeof toastr !== 'undefined') toastr.success('State saved (edit snapshotted, undo available)');
                stateEditor.style.display = 'none';
                stateDisplay.style.display = 'block';
                if (typeof globalThis._wandlightRefreshUI === 'function') {
                    globalThis._wandlightRefreshUI();
                }
            } catch (e) {
                if (typeof toastr !== 'undefined') toastr.error('Invalid JSON: ' + e.message);
            }
        });
    }

    // Refresh state button
    const refreshStateBtn = container.querySelector('#wandlight_refresh_state');
    if (refreshStateBtn) {
        refreshStateBtn.addEventListener('click', () => {
            if (typeof globalThis._wandlightRefreshUI === 'function') {
                globalThis._wandlightRefreshUI();
            }
        });
    }

}

/**
 * Refreshes the memo preview area from current state.
 */
export function refreshMemoPreview() {
    const preview = document.getElementById('wandlight_memo_preview');
    if (!preview) return;

    try {
        const state = getState();
        if (!state) {
            preview.textContent = '(No continuity state loaded)';
            return;
        }
        const memo = buildMemo(state);
        if (!memo || !memo.trim()) {
            preview.textContent = '(Memo is empty \u2014 populate continuity state via extraction or manual editing)';
        } else {
            preview.textContent = memo;
        }
    } catch (e) {
        preview.textContent = '(Error building memo: ' + e.message + ')';
    }
}

/**
 * Renders the state viewer panel content.
 * Shows a formatted summary of each state section with edit capability.
 * Uses textContent for all user-derived data to prevent HTML injection.
 *
 * @param {HTMLElement} container - The state display div
 * @param {Object} state - Current WandlightState
 */
export function renderStatePanel(container, state) {
    if (!container || !state) return;

    const sections = [];

    /**
     * Adds a titled section using safe DOM construction (textContent, not innerHTML).
     * @param {string} title - Section title
     * @param {*} data - The data to render
     * @param {string} icon - Emoji icon prefix
     */
    function addSection(title, data, icon) {
        if (!data) return;

        const sectionDiv = document.createElement('div');
        sectionDiv.className = 'wandlight-state-section';
        sectionDiv.style.marginBottom = '8px';

        const headerDiv = document.createElement('div');
        headerDiv.style.fontWeight = 'bold';
        headerDiv.style.opacity = '0.9';
        headerDiv.style.marginBottom = '2px';
        headerDiv.textContent = (icon ? icon + ' ' : '') + title;
        sectionDiv.appendChild(headerDiv);

        const contentDiv = document.createElement('div');
        contentDiv.style.paddingLeft = '12px';
        contentDiv.style.fontSize = '0.95em';
        sectionDiv.appendChild(contentDiv);

        let hasContent = false;

        if (typeof data === 'string') {
            const lineDiv = document.createElement('div');
            lineDiv.textContent = data;
            contentDiv.appendChild(lineDiv);
            hasContent = true;
        } else if (Array.isArray(data)) {
            if (data.length === 0) {
                const emptyDiv = document.createElement('div');
                emptyDiv.style.opacity = '0.5';
                emptyDiv.textContent = '(empty)';
                contentDiv.appendChild(emptyDiv);
                hasContent = true;
            } else {
                data.forEach((item, i) => {
                    const lineDiv = document.createElement('div');
                    if (typeof item === 'string') {
                        const numSpan = document.createElement('span');
                        numSpan.style.opacity = '0.7';
                        numSpan.textContent = (i + 1) + '. ';
                        lineDiv.appendChild(numSpan);
                        lineDiv.appendChild(document.createTextNode(item));
                    } else if (item && typeof item === 'object') {
                        const numSpan = document.createElement('span');
                        numSpan.style.opacity = '0.7';
                        numSpan.textContent = (i + 1) + '. ';
                        lineDiv.appendChild(numSpan);
                        const label = item.name || item.id || item.topic || 'Item ' + (i + 1);
                        const labelStrong = document.createElement('strong');
                        labelStrong.textContent = String(label);
                        lineDiv.appendChild(labelStrong);
                        const detail = item.content || item.detail || item.status || item.state || '';
                        if (detail) {
                            const arrowSpan = document.createElement('span');
                            arrowSpan.textContent = ' \u2192 ';
                            lineDiv.appendChild(arrowSpan);
                            const detailSpan = document.createElement('span');
                            detailSpan.style.opacity = '0.7';
                            detailSpan.textContent = String(detail);
                            lineDiv.appendChild(detailSpan);
                        }
                    }
                    contentDiv.appendChild(lineDiv);
                });
                hasContent = true;
            }
        } else if (data && typeof data === 'object') {
            Object.entries(data).forEach(([k, v]) => {
                if (v === null || v === undefined || v === '') return;
                const lineDiv = document.createElement('div');
                const keyStrong = document.createElement('strong');
                keyStrong.textContent = k + ': ';
                lineDiv.appendChild(keyStrong);
                const valSpan = document.createElement('span');
                valSpan.style.opacity = '0.8';
                valSpan.textContent = typeof v === 'object' ? JSON.stringify(v) : String(v);
                lineDiv.appendChild(valSpan);
                contentDiv.appendChild(lineDiv);
            });
            hasContent = true;
        }

        if (hasContent) {
            sections.push(sectionDiv);
        }
    }

    addSection('Scene and Timeline', { ...(state.canon || {}), ...(state.scene || {}) }, '\uD83C\uDFAC');
    addSection('Active Characters', state.characters, '\uD83D\uDC65');
    addSection('Key Items', state.inventory, '\uD83C\uDF92');
    addSection('Active Goals', state.objectives, '\uD83C\uDFAF');
    addSection('Active Threads', state.threads, '\uD83E\uDDF5');

    // ── Lore Context ──
    if (state.loreContext) {
        addSection('Lore Context', state.loreContext, '\uD83D\uDCD6');
    }

    // ── Lore Matrix ──
    const loreEntries = normalizeLoreMatrix(state.loreMatrix || []);
    if (loreEntries.length > 0) {
        const activeEntries = getActiveLoreEntries(state, 999);
        const label = 'Lore Matrix (' + loreEntries.length + ' entries, ' + activeEntries.length + ' active)';
        addSection(label, loreEntries, '\uD83D\uDCDA');
    }

    if (state.stateHistory && state.stateHistory.length > 0) {
        const historyDiv = document.createElement('div');
        historyDiv.className = 'wandlight-state-section';
        historyDiv.style.marginBottom = '8px';

        const historyHeader = document.createElement('div');
        historyHeader.style.fontWeight = 'bold';
        historyHeader.style.opacity = '0.9';
        historyHeader.style.marginBottom = '2px';
        historyHeader.textContent = '\uD83D\uDCCB History';
        historyDiv.appendChild(historyHeader);

        const historyContent = document.createElement('div');
        historyContent.style.paddingLeft = '12px';
        historyContent.style.fontSize = '0.95em';
        historyContent.style.opacity = '0.7';
        historyContent.textContent = state.stateHistory.length + ' snapshot(s) available for undo';
        historyDiv.appendChild(historyContent);

        sections.push(historyDiv);
    }

    // Version and metadata footer
    const footerDiv = document.createElement('div');
    footerDiv.style.marginTop = '8px';
    footerDiv.style.paddingTop = '6px';
    footerDiv.style.borderTop = '1px solid rgba(255,255,255,0.1)';
    footerDiv.style.fontSize = '0.75em';
    footerDiv.style.opacity = '0.5';
    let footerText = 'Schema version: ' + (state.schemaVersion || '1');
    if (state.lastModified) {
        footerText += ' | Modified: ' + state.lastModified;
    }
    footerDiv.textContent = footerText;
    sections.push(footerDiv);

    // Clear container and append all section divs
    container.textContent = '';
    if (sections.length > 0) {
        sections.forEach(s => container.appendChild(s));
    } else {
        const em = document.createElement('em');
        em.textContent = 'No continuity state data available';
        container.appendChild(em);
    }
}

/**
 * Renders the lore context preview from current state.
 */
export function renderLoreContextPreview() {
    const preview = document.getElementById('wandlight_lore_context_preview');
    if (!preview) return;

    try {
        const state = getState();
        if (!state) {
            preview.textContent = '(No continuity state loaded)';
            return;
        }
        const ctx = normalizeLoreContext(state.loreContext || {});
        const parts = [];
        if (ctx.sceneDate) parts.push('Scene Date: ' + ctx.sceneDate);
        if (ctx.subjectiveDate) parts.push('Subjective Date: ' + ctx.subjectiveDate);
        if (ctx.canonBoundary) parts.push('Canon Boundary: ' + ctx.canonBoundary);
        if (ctx.branchId && ctx.branchId !== 'main') parts.push('Branch: ' + ctx.branchId);
        if (ctx.timeTravelMode && ctx.timeTravelMode !== 'none') parts.push('Time Travel: ' + ctx.timeTravelMode);
        if (ctx.lastDetectedAt) {
            const date = new Date(ctx.lastDetectedAt);
            parts.push('Last Detected: ' + date.toLocaleString());
        }
        if (ctx.lastGenerationSummary) parts.push('Last Generation: ' + ctx.lastGenerationSummary);

        if (parts.length > 0) {
            preview.textContent = parts.join('\n');
        } else {
            preview.textContent = 'Context pending detection';
        }
    } catch (e) {
        preview.textContent = '(Error: ' + e.message + ')';
    }
}

/**
 * Renders the lore matrix preview from current state.
 */
// ── Model Provider Role setup ──────────────────────────────────────────────────

/**
 * Wires the model provider role UI controls.
 * Reads/stores API keys via secure-keyring, populates connection profile dropdowns,
 * and saves provider role settings.
 * @param {HTMLElement} container - The settings panel container
 */
function setupLoreProviderPanel(container) {
    if (!container) return;

    setupProviderControls(container, 'continuity', 'Utility');
    setupProviderControls(container, 'lore', 'Reasoning');

    const settings = getSettings();
    const tempInput = container.querySelector('#wandlight_lore_temperature');
    const topPInput = container.querySelector('#wandlight_lore_top_p');
    const maxTokensInput = container.querySelector('#wandlight_lore_max_tokens');

    if (tempInput) tempInput.value = settings.loreTemperature ?? 0.7;
    if (topPInput) topPInput.value = settings.loreTopP ?? 0.98;
    if (maxTokensInput) maxTokensInput.value = settings.loreMaxTokens ?? 8192;

    if (tempInput) {
        tempInput.addEventListener('change', () => {
            const next = getSettings();
            next.loreTemperature = parseFloat(tempInput.value) || 0.7;
            saveLoreProviderSettings(next);
        });
    }
    if (topPInput) {
        topPInput.addEventListener('change', () => {
            const next = getSettings();
            next.loreTopP = parseFloat(topPInput.value) || 0.98;
            saveLoreProviderSettings(next);
        });
    }
    if (maxTokensInput) {
        maxTokensInput.addEventListener('change', () => {
            const next = getSettings();
            next.loreMaxTokens = parseInt(maxTokensInput.value, 10) || 8192;
            saveLoreProviderSettings(next);
        });
    }
}

function settingPrefix(kind) {
    return kind === 'continuity' ? 'continuity' : 'lore';
}

function secretNameForProvider(kind) {
    return `${settingPrefix(kind)}OpenAI`;
}

function setupProviderControls(container, kind, label) {
    const prefix = settingPrefix(kind);
    const settings = getSettings();

    const providerSelect = container.querySelector(`#wandlight_${prefix}_provider`);
    const profileRow = container.querySelector(`#wandlight_${prefix}_profile_row`);
    const profileIdSelect = container.querySelector(`#wandlight_${prefix}_profile_id`);
    const completionPresetSelect = container.querySelector(`#wandlight_${prefix}_completion_preset_id`);
    const openaiRow = container.querySelector(`#wandlight_${prefix}_openai_row`);
    const openaiBaseUrl = container.querySelector(`#wandlight_${prefix}_openai_base_url`);
    const openaiModel = container.querySelector(`#wandlight_${prefix}_openai_model`);
    const openaiModelSearch = container.querySelector(`#wandlight_${prefix}_openai_model_search`);
    const openaiKey = container.querySelector(`#wandlight_${prefix}_openai_key`);
    const openaiKeySaveBtn = container.querySelector(`#wandlight_${prefix}_openai_key_save`);
    const openaiKeyClearBtn = container.querySelector(`#wandlight_${prefix}_openai_key_clear`);
    const openaiKeyStatus = container.querySelector(`#wandlight_${prefix}_openai_key_status`);
    const openaiJsonMode = container.querySelector(`#wandlight_${prefix}_openai_json_mode`);
    const openaiSTProxy = container.querySelector(`#wandlight_${prefix}_openai_st_proxy`);
    const fetchModelsBtn = container.querySelector(`#wandlight_${prefix}_fetch_models`);
    const testConnectionBtn = container.querySelector(`#wandlight_${prefix}_test_connection`);
    const connectionStatus = container.querySelector(`#wandlight_${prefix}_connection_status`);

    const providerKey = `${prefix}Provider`;
    const profileKey = `${prefix}ProfileId`;
    const presetKey = `${prefix}CompletionPresetId`;
    const baseUrlKey = `${prefix}OpenAIBaseUrl`;
    const modelKey = `${prefix}OpenAIModel`;
    const jsonModeKey = `${prefix}OpenAIUseJsonMode`;
    const proxyKey = `${prefix}OpenAIUseSTProxy`;

    if (providerSelect) providerSelect.value = settings[providerKey] || 'st';
    if (openaiBaseUrl) openaiBaseUrl.value = settings[baseUrlKey] || '';
    if (openaiModelSearch) openaiModelSearch.value = settings[modelKey] || '';
    if (openaiModel) openaiModel.value = settings[modelKey] || '';
    if (openaiJsonMode) openaiJsonMode.checked = settings[jsonModeKey] === true;
    if (openaiSTProxy) openaiSTProxy.checked = !!settings[proxyKey];

    function refreshProviderRows() {
        const provider = providerSelect?.value || 'st';
        if (profileRow) profileRow.style.display = provider === 'profile' ? '' : 'none';
        if (openaiRow) openaiRow.style.display = provider === 'openai_compatible' ? '' : 'none';
    }

    if (providerSelect) {
        providerSelect.addEventListener('change', () => {
            const next = getSettings();
            next[providerKey] = providerSelect.value;
            saveLoreProviderSettings(next);
            if (connectionStatus) connectionStatus.textContent = '';
            refreshProviderRows();
        });
    }

    function populateProfiles() {
        if (profileIdSelect) {
            const current = profileIdSelect.value || getSettings()[profileKey] || '';
            profileIdSelect.innerHTML = '<option value="">— Select Profile —</option>';
            const profiles = getAvailableConnectionProfiles();
            if (!profiles.length) {
                const opt = document.createElement('option');
                opt.value = '';
                opt.textContent = 'No profiles found in this SillyTavern session';
                profileIdSelect.appendChild(opt);
            }
            for (const p of profiles) {
                const id = p.id || p.name || p.profileId || p.uuid || p.profile_id || p.label || '';
                if (!id) continue;
                const opt = document.createElement('option');
                opt.value = id;
                opt.textContent = p.name || p.label || p.id || p.profileId || p.profile_id || id;
                profileIdSelect.appendChild(opt);
            }
            profileIdSelect.value = current;
        }

        if (completionPresetSelect) {
            const current = completionPresetSelect.value || getSettings()[presetKey] || '';
            completionPresetSelect.innerHTML = '<option value="">— Default —</option>';
            const presets = getAvailableCompletionPresets();
            if (!presets.length) {
                const opt = document.createElement('option');
                opt.value = '';
                opt.textContent = 'No completion presets found';
                completionPresetSelect.appendChild(opt);
            }
            for (const pr of presets) {
                const id = pr.name || pr.id || pr.presetId || pr.preset_id || pr.filename || pr.label || '';
                if (!id) continue;
                const opt = document.createElement('option');
                opt.value = id;
                opt.textContent = pr.name || pr.label || pr.id || pr.presetId || pr.preset_id || pr.filename || id;
                completionPresetSelect.appendChild(opt);
            }
            completionPresetSelect.value = current;
        }
    }

    populateProfiles();
    if (profileIdSelect) {
        profileIdSelect.addEventListener('focus', populateProfiles);
        profileIdSelect.addEventListener('click', populateProfiles);
        profileIdSelect.addEventListener('change', () => {
            const next = getSettings();
            next[profileKey] = profileIdSelect.value;
            saveLoreProviderSettings(next);
        });
    }
    if (completionPresetSelect) {
        completionPresetSelect.addEventListener('focus', populateProfiles);
        completionPresetSelect.addEventListener('click', populateProfiles);
        completionPresetSelect.addEventListener('change', () => {
            const next = getSettings();
            next[presetKey] = completionPresetSelect.value;
            saveLoreProviderSettings(next);
        });
    }

    if (openaiBaseUrl) {
        openaiBaseUrl.addEventListener('change', () => {
            const next = getSettings();
            next[baseUrlKey] = openaiBaseUrl.value.trim();
            saveLoreProviderSettings(next);
        });
    }

    let fetchedModels = [];
    function saveModel(value) {
        const next = getSettings();
        next[modelKey] = String(value || '').trim();
        saveLoreProviderSettings(next);
    }

    function renderModelOptions(filter = '') {
        if (!openaiModel) return;
        const currentSettings = getSettings();
        const query = String(filter || '').trim().toLowerCase();
        const current = currentSettings[modelKey] || '';
        const matches = fetchedModels
            .filter(m => {
                const id = String(m.id || '');
                const name = String(m.name || m.id || '');
                return !query || id.toLowerCase().includes(query) || name.toLowerCase().includes(query);
            })
            .slice(0, 200);

        openaiModel.innerHTML = '';
        const typed = String(openaiModelSearch?.value || current || '').trim();
        const first = document.createElement('option');
        first.value = typed || '';
        first.textContent = typed ? `Use typed model: ${typed}` : (fetchedModels.length ? 'Select a fetched model' : 'Fetch models or type a model ID above');
        openaiModel.appendChild(first);

        for (const m of matches) {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id;
            openaiModel.appendChild(opt);
        }

        openaiModel.value = current || typed || '';
    }

    if (openaiModelSearch) {
        openaiModelSearch.addEventListener('input', () => {
            const typed = openaiModelSearch.value.trim();
            saveModel(typed);
            renderModelOptions(typed);
        });
        openaiModelSearch.addEventListener('change', () => saveModel(openaiModelSearch.value.trim()));
    }

    if (openaiModel) {
        openaiModel.addEventListener('change', () => {
            const selected = openaiModel.value.trim();
            if (openaiModelSearch) openaiModelSearch.value = selected;
            saveModel(selected);
            renderModelOptions(selected);
        });
    }

    if (openaiJsonMode) {
        openaiJsonMode.addEventListener('change', () => {
            const next = getSettings();
            next[jsonModeKey] = openaiJsonMode.checked;
            saveLoreProviderSettings(next);
        });
    }

    if (openaiSTProxy) {
        openaiSTProxy.addEventListener('change', () => {
            const next = getSettings();
            next[proxyKey] = openaiSTProxy.checked;
            saveLoreProviderSettings(next);
        });
    }

    async function refreshKeyStatus() {
        if (!openaiKeyStatus) return;
        try {
            const key = await loadApiKey(kind);
            if (key) {
                openaiKeyStatus.textContent = 'Key stored (encrypted at rest)';
                openaiKeyStatus.style.color = '#88cc88';
            } else {
                openaiKeyStatus.textContent = 'No key stored';
                openaiKeyStatus.style.color = '';
            }
        } catch (_) {
            openaiKeyStatus.textContent = 'Keyring unavailable';
            openaiKeyStatus.style.color = '#cc8888';
        }
    }

    if (openaiKeySaveBtn && openaiKey) {
        openaiKeySaveBtn.addEventListener('click', async () => {
            const raw = openaiKey.value.trim();
            if (!raw) {
                if (typeof toastr !== 'undefined') toastr.warning('Enter an API key first.');
                return;
            }
            try {
                await storeNamedApiKey(secretNameForProvider(kind), raw);
                openaiKey.value = '';
                if (typeof toastr !== 'undefined') toastr.success(`${label} API key encrypted and stored.`);
                await refreshKeyStatus();
            } catch (e) {
                if (typeof toastr !== 'undefined') toastr.error('Failed to store key: ' + e.message);
            }
        });
    }

    if (openaiKeyClearBtn) {
        openaiKeyClearBtn.addEventListener('click', async () => {
            try {
                await deleteNamedApiKey(secretNameForProvider(kind));
                if (openaiKey) openaiKey.value = '';
                if (typeof toastr !== 'undefined') toastr.success(`${label} API key removed.`);
                await refreshKeyStatus();
            } catch (e) {
                if (typeof toastr !== 'undefined') toastr.error('Failed to clear key: ' + e.message);
            }
        });
    }

    if (fetchModelsBtn) {
        fetchModelsBtn.addEventListener('click', async () => {
            fetchModelsBtn.disabled = true;
            const original = fetchModelsBtn.textContent;
            fetchModelsBtn.textContent = 'Fetching...';
            try {
                fetchedModels = await fetchLoreModels(kind);
                renderModelOptions(openaiModelSearch?.value || getSettings()[modelKey] || '');
                if (typeof toastr !== 'undefined') toastr.success(`${fetchedModels.length} ${label.toLowerCase()} model(s) fetched; showing up to 200 matching results.`);
            } catch (e) {
                if (typeof toastr !== 'undefined') toastr.error(`${label} model fetch failed: ` + e.message);
            } finally {
                fetchModelsBtn.disabled = false;
                fetchModelsBtn.textContent = original;
            }
        });
    }

    if (testConnectionBtn) {
        testConnectionBtn.addEventListener('click', async () => {
            const original = testConnectionBtn.textContent;
            testConnectionBtn.disabled = true;
            testConnectionBtn.textContent = 'Testing...';
            if (connectionStatus) {
                connectionStatus.textContent = `Testing ${label.toLowerCase()} provider...`;
                connectionStatus.style.color = '';
            }
            try {
                const validation = validateLoreProviderConfiguration(kind);
                if (!validation.ok) throw new Error(validation.message);
                const result = await testLoreConnection(kind);
                if (connectionStatus) {
                    connectionStatus.textContent = `Connected via ${result.provider}.`;
                    connectionStatus.style.color = '#88cc88';
                }
                if (typeof toastr !== 'undefined') toastr.success(`${label} provider connection succeeded.`);
            } catch (e) {
                if (connectionStatus) {
                    connectionStatus.textContent = e?.message || String(e);
                    connectionStatus.style.color = '#cc8888';
                }
                if (typeof toastr !== 'undefined') toastr.error(`${label} connection test failed: ` + (e?.message || e));
            } finally {
                testConnectionBtn.disabled = false;
                testConnectionBtn.textContent = original;
            }
        });
    }

    renderModelOptions(settings[modelKey] || '');
    refreshProviderRows();
    refreshKeyStatus();
}

/**
 * Helper: saves model provider role settings via the settings manager.
 * @param {Object} settings - Current settings object
 */
function saveLoreProviderSettings(settings) {
    try {
        saveSettings(settings);
    } catch (e) {
        console.warn('[Wandlight] Failed to save model provider role settings:', e);
    }
}
export function renderLoreMatrixPreview() {
    const preview = document.getElementById('wandlight_lore_matrix_preview');
    const pendingPreview = document.getElementById('wandlight_pending_lore_preview');
    const countEl = document.getElementById('wandlight_lore_count');
    const staleBadge = document.getElementById('wandlight_lore_stale_badge');
    const batchStatus = document.getElementById('wandlight_lore_batch_status');
    const pendingCountEl = document.getElementById('wandlight_pending_lore_count');
    if (!preview) return;

    try {
        const state = getState();
        if (!state) {
            preview.textContent = '(No continuity state loaded)';
            if (countEl) countEl.textContent = '0';
            if (staleBadge) staleBadge.style.display = 'none';
            if (batchStatus) batchStatus.textContent = '';
            if (pendingCountEl) pendingCountEl.textContent = '0';
            return;
        }

        const entries = normalizeLoreMatrix(state.loreMatrix || []);
        const pendingEntries = normalizeLoreMatrix(state.pendingLoreEntries || []);
        if (countEl) countEl.textContent = String(entries.length);
        if (pendingCountEl) pendingCountEl.textContent = String(pendingEntries.length);

        // ── Stale badge: show when pending lore was generated before a state change ──
        if (staleBadge) {
            const meta = state.pendingLoreMeta || {};
            if (pendingEntries.length > 0 && meta.status === 'stale') {
                staleBadge.style.display = '';
                staleBadge.textContent = '\u26A0\uFE0F Stale — state has changed since these were generated';
            } else {
                staleBadge.style.display = 'none';
            }
        }

        // ── Batch status: show when the pending batch was generated and its size ──
        if (batchStatus) {
            const meta = state.pendingLoreMeta || {};
            if (pendingEntries.length > 0 && meta.createdAt) {
                const generatedDate = new Date(meta.createdAt);
                const timeStr = generatedDate.toLocaleString();
                const parts = [`Generated ${timeStr}`];
                if (meta.validEntryCount !== undefined) {
                    parts.push(`${meta.validEntryCount} valid`);
                }
                if (meta.rawEntryCount !== undefined) {
                    parts.push(`${meta.rawEntryCount} raw`);
                }
                if (meta.droppedEntryCount > 0) {
                    parts.push(`${meta.droppedEntryCount} dropped`);
                }
                batchStatus.textContent = parts.join(' • ');
            } else if (pendingEntries.length > 0) {
                batchStatus.textContent = `${pendingEntries.length} entries pending review`;
            } else {
                batchStatus.textContent = '';
            }
        }

        if (pendingPreview) {
            if (pendingEntries.length === 0) {
                pendingPreview.textContent = '(No pending lore entries)';
            } else {
                pendingPreview.textContent = pendingEntries.map((entry, i) => {
                    const detail = entry.fact ? ` — ${entry.fact}` : '';
                    return `${i + 1}. <${entry.category}> ${entry.title} [${entry.canonStatus}]${detail}`;
                }).join('\n');
            }
        }

        if (entries.length === 0) {
            preview.textContent = '(No accepted lore entries — generate and accept entries to get started)';
            return;
        }

        const activeEntries = getActiveLoreEntries(state, 999);
        const activeIds = new Set(activeEntries.map(e => e.id));
        const lines = [];

        entries.forEach((entry, i) => {
            const isActive = activeIds.has(entry.id);
            const prefix = isActive ? '\u25CF' : '\u25CB'; // ● active, ○ inactive
            const statusIcons = {
                pinned: '\uD83D\uDCCC',
                archived: '\uD83D\uDCC1',
                disabled: '\u2B55',
            };
            const statusIcon = statusIcons[entry.status] || '';

            const line = [
                `${i + 1}. ${prefix} ${statusIcon}`,
                `<${entry.category}>`,
                `**${entry.title}**`,
                `[${entry.canonStatus}]`,
                entry.truthStatus !== 'true' ? `truth:${entry.truthStatus}` : '',
                entry.revealPolicy !== 'private' ? `reveal:${entry.revealPolicy}` : '',
            ].filter(Boolean).join(' ');
            lines.push(line);
        });

        preview.textContent = lines.join('\n');
    } catch (e) {
        preview.textContent = '(Error: ' + e.message + ')';
    }
}

// ── Lore Matrix JSON Editor ────────────────────────────────────────────────────

/**
 * Populates the lore-matrix JSON editor textarea with the accepted matrix.
 * @param {Object} state - WandlightState
 */
function populateLoreMatrixEditor(state) {
    const textarea = document.getElementById('wandlight_lore_matrix_json');
    if (!textarea) return;
    const entries = (state && state.loreMatrix) ? state.loreMatrix : [];
    textarea.value = JSON.stringify(entries, null, 2);
}

/**
 * Hides the lore-matrix JSON editor and the save row.
 */
function hideLoreMatrixEditor() {
    const textarea = document.getElementById('wandlight_lore_matrix_json');
    const saveRow = document.getElementById('wandlight_lore_matrix_save_row');
    if (textarea) textarea.style.display = 'none';
    if (saveRow) saveRow.style.display = 'none';
}

/**
 * Wires the lore-matrix JSON editor toggle and save buttons.
 * Uses the module-level imports getState(), saveState(), getSettings().
 */
function wireLoreMatrixEditor() {
    const toggleBtn = document.getElementById('wandlight_lore_matrix_toggle_editor');
    const textarea = document.getElementById('wandlight_lore_matrix_json');
    const saveRow = document.getElementById('wandlight_lore_matrix_save_row');
    const saveBtn = document.getElementById('wandlight_lore_matrix_save');

    if (!toggleBtn || !textarea || !saveRow || !saveBtn) return;

    toggleBtn.addEventListener('click', () => {
        const isVisible = textarea.style.display !== 'none';
        if (isVisible) {
            textarea.style.display = 'none';
            saveRow.style.display = 'none';
        } else {
            populateLoreMatrixEditor(getState());
            textarea.style.display = '';
            saveRow.style.display = '';
        }
    });

    saveBtn.addEventListener('click', () => {
        try {
            const raw = textarea.value.trim();
            if (!raw) {
                if (typeof toastr !== 'undefined') toastr.warning('Lore matrix JSON is empty. Nothing saved.');
                return;
            }
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) {
                if (typeof toastr !== 'undefined') toastr.error('Lore matrix must be a JSON array of entries.');
                return;
            }

            const state = getState();
            // Snapshot before modifying so the user can undo
            pushStateSnapshot(state, 'Edit lore matrix via JSON editor', getSettings().maxSnapshots);

            // Normalize and mark every entry as user-edited + locked so model-generated
            // entries with the same id cannot overwrite the user's story-specific edits.
            const normalized = normalizeLoreMatrix(parsed).map(entry => ({
                ...entry,
                source: entry.source === 'model-generated' ? 'user' : entry.source,
                userEdited: true,
                locked: true,
            }));
            // Accepted lore is intentionally uncapped; the runtime Lore tab pages the UI.
            state.loreMatrix = normalized;

            saveState(state);
            if (typeof toastr !== 'undefined') toastr.success('Lore matrix saved (' + normalized.length + ' entries).');

            hideLoreMatrixEditor();
            // Refresh the main state panel and lore previews
            if (typeof globalThis._wandlightRefreshUI === 'function') {
                globalThis._wandlightRefreshUI();
            }
            renderLoreMatrixPreview();
        } catch (e) {
            if (typeof toastr !== 'undefined') toastr.error('Invalid JSON: ' + e.message);
        }
    });
}

// ── Range helper ────────────────────────────────────────────────────────────────

/**
 * Wires a range input to display its live value next to it.
 * @param {string} inputId - ID of the range input
 * @param {string} displayId - ID of the value display span
 */
function wireRangeDisplay(inputId, displayId) {
    const input = document.getElementById(inputId);
    const display = document.getElementById(displayId);
    if (!input || !display) return;

    const updateDisplay = () => {
        display.textContent = input.value;
    };
    input.addEventListener('input', updateDisplay);
    updateDisplay();
}