/**
 * ui.js - Wandlight
 * Renders the settings panel and model provider UI.
 *
 * Exports: renderSettingsPanel
 * Imported by: index.js
 */

import { DEFAULT_SETTINGS } from './constants.js';
import { getSettings, saveSettings } from './state-manager.js';
import { storeNamedApiKey, deleteNamedApiKey } from './secure-keyring.js';
import {
    clearCachedApiKey,
    loadApiKey,
    fetchLoreModels,
    testLoreConnection,
    validateLoreProviderConfigurationAsync,
    getAvailableConnectionProfiles,
    getAvailableCompletionPresets,
} from './lore-llm-client.js';

/**
 * Renders the settings panel HTML into the container.
 * Since settings.html is loaded via renderExtensionTemplateAsync(), this
 * function populates dynamic provider values and wires API/model controls.
 *
 * @param {HTMLElement} container - The settings panel div
 */
export function renderSettingsPanel(container) {
    if (!container) return;
    setupLoreProviderPanel(container);
}

function setupLoreProviderPanel(container) {
    if (!container) return;
    setupProviderControls(container, 'continuity', 'Utility');
    setupProviderControls(container, 'lore', 'Reasoning');
}

function settingPrefix(kind) {
    return kind === 'continuity' ? 'continuity' : 'lore';
}

function secretNameForProvider(kind) {
    return `${settingPrefix(kind)}OpenAI`;
}

function parseNumericSetting(input, fallback, min, max, integer = false) {
    const parsed = Number(input?.value);
    if (!Number.isFinite(parsed)) return fallback;
    const clamped = Math.min(max, Math.max(min, parsed));
    return integer ? Math.round(clamped) : clamped;
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
    const fetchModelsBtn = container.querySelector(`#wandlight_${prefix}_fetch_models`);
    const testConnectionBtn = container.querySelector(`#wandlight_${prefix}_test_connection`);
    const resetDefaultsBtn = container.querySelector(`#wandlight_${prefix}_provider_reset_defaults`);
    const connectionStatus = container.querySelector(`#wandlight_${prefix}_connection_status`);
    const temperatureInput = container.querySelector(`#wandlight_${prefix}_temperature`);
    const topPInput = container.querySelector(`#wandlight_${prefix}_top_p`);
    const maxTokensInput = container.querySelector(`#wandlight_${prefix}_max_tokens`);

    const providerKey = `${prefix}Provider`;
    const profileKey = `${prefix}ProfileId`;
    const presetKey = `${prefix}CompletionPresetId`;
    const baseUrlKey = `${prefix}OpenAIBaseUrl`;
    const modelKey = `${prefix}OpenAIModel`;
    const temperatureKey = `${prefix}Temperature`;
    const topPKey = `${prefix}TopP`;
    const maxTokensKey = `${prefix}MaxTokens`;
    const providerSettingKeys = [
        providerKey,
        profileKey,
        presetKey,
        baseUrlKey,
        modelKey,
        temperatureKey,
        topPKey,
        maxTokensKey,
    ];

    if (providerSelect) providerSelect.value = settings[providerKey] || 'st';
    if (openaiBaseUrl) openaiBaseUrl.value = settings[baseUrlKey] || '';
    if (openaiModelSearch) openaiModelSearch.value = settings[modelKey] || '';
    if (openaiModel) openaiModel.value = settings[modelKey] || '';
    if (temperatureInput) temperatureInput.value = settings[temperatureKey] ?? 0.7;
    if (topPInput) topPInput.value = settings[topPKey] ?? 0.98;
    if (maxTokensInput) maxTokensInput.value = settings[maxTokensKey] ?? 8192;

    function refreshProviderRows() {
        const provider = providerSelect?.value || 'st';
        if (profileRow) profileRow.style.display = provider === 'profile' ? '' : 'none';
        if (openaiRow) openaiRow.style.display = provider === 'openai_compatible' ? '' : 'none';
    }

    function getProfileWarningText() {
        return `${label} connection profiles can include their own preset and generation parameters, which may change Wandlight's structured output. Test this profile before relying on model-backed tasks.`;
    }

    function showProfileWarning() {
        const warning = getProfileWarningText();
        if (connectionStatus) {
            connectionStatus.textContent = warning;
            connectionStatus.style.color = '#d6b35a';
        }
        if (typeof toastr !== 'undefined') toastr.warning(warning);
    }

    if (providerSelect) {
        providerSelect.addEventListener('change', () => {
            const next = getSettings();
            next[providerKey] = providerSelect.value;
            saveLoreProviderSettings(next);
            if (connectionStatus) connectionStatus.textContent = '';
            refreshProviderRows();
            if (providerSelect.value === 'profile') showProfileWarning();
        });
    }

    function populateProfiles() {
        if (profileIdSelect) {
            const current = profileIdSelect.value || getSettings()[profileKey] || '';
            profileIdSelect.innerHTML = '<option value="">Select Profile</option>';
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
            completionPresetSelect.innerHTML = '<option value="">Default</option>';
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

    function wireNumericInput(input, key, fallback, min, max, integer = false) {
        if (!input) return;
        input.addEventListener('change', () => {
            const next = getSettings();
            const value = parseNumericSetting(input, fallback, min, max, integer);
            input.value = String(value);
            next[key] = value;
            saveLoreProviderSettings(next);
        });
    }

    wireNumericInput(temperatureInput, temperatureKey, 0.7, 0, 2);
    wireNumericInput(topPInput, topPKey, 0.98, 0, 1);
    wireNumericInput(maxTokensInput, maxTokensKey, 8192, 64, 16384, true);

    if (resetDefaultsBtn) {
        resetDefaultsBtn.addEventListener('click', () => {
            const next = getSettings();
            for (const key of providerSettingKeys) {
                if (Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) {
                    next[key] = DEFAULT_SETTINGS[key];
                }
            }
            saveLoreProviderSettings(next);
            if (providerSelect) providerSelect.value = next[providerKey] || 'st';
            if (profileIdSelect) profileIdSelect.value = next[profileKey] || '';
            if (completionPresetSelect) completionPresetSelect.value = next[presetKey] || '';
            if (openaiBaseUrl) openaiBaseUrl.value = next[baseUrlKey] || '';
            if (openaiModelSearch) openaiModelSearch.value = next[modelKey] || '';
            if (temperatureInput) temperatureInput.value = String(next[temperatureKey] ?? 0.7);
            if (topPInput) topPInput.value = String(next[topPKey] ?? 0.98);
            if (maxTokensInput) maxTokensInput.value = String(next[maxTokensKey] ?? 8192);
            populateProfiles();
            if (profileIdSelect) profileIdSelect.value = next[profileKey] || '';
            if (completionPresetSelect) completionPresetSelect.value = next[presetKey] || '';
            renderModelOptions(next[modelKey] || '');
            refreshProviderRows();
            if (connectionStatus) connectionStatus.textContent = '';
            if (typeof toastr !== 'undefined') toastr.info(`${label} provider settings reset to defaults. Stored API keys were preserved.`);
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
                clearCachedApiKey(kind);
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
                clearCachedApiKey(kind);
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
                const validation = await validateLoreProviderConfigurationAsync(kind);
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

function saveLoreProviderSettings(settings) {
    try {
        saveSettings(settings);
    } catch (e) {
        console.warn('[Wandlight] Failed to save model provider role settings:', e);
    }
}
