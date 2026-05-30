/**
 * index.js — Wandlight Continuity
 * Extension entrypoint. Wires events, renders settings panel, registers
 * slash commands, and exposes globalThis bridge functions.
 *
 * Imported modules: constants.js, state-manager.js, memo-builder.js,
 *                    prompt-injector.js, extractor.js, ui.js
 */

import { MODULE_KEY, LOG_PREFIX, DEFAULT_SETTINGS, EXTENSION_FOLDER } from './constants.js';
import {
    getSettings,
    saveSettings,
    getState,
    saveState,
    applyDelta,
    pushStateSnapshot,
    undoLastChange,
    exportState,
    importState,
    validateDelta,
    getDefaultState,
} from './state-manager.js';
import { buildMemo } from './memo-builder.js';
import { installInterceptor } from './prompt-injector.js';
import { onExtractionTriggered, resetExtractionCounter, isExtractionRunning } from './extractor.js';
import { renderSettingsPanel, renderStatePanel } from './ui.js';

// ════════════════════════════════════════════════════════════════════════════════
// jQuery ready — this is the SillyTavern extension lifecycle entrypoint.
// SillyTavern loads all .js files in the extension folder and waits for them to
// execute. We use jQuery's $(document).ready() which fires after the page DOM
// is ready (including any HTML templates rendered by renderExtensionTemplateAsync).
// ════════════════════════════════════════════════════════════════════════════════
$(document).ready(async () => {
    'use strict';

    console.log(`${LOG_PREFIX} Wandlight Continuity extension initializing...`);

    // ── Defensive API guard ──────────────────────────────────────────────────
    if (typeof SillyTavern === 'undefined' || !SillyTavern.getContext) {
        console.error(`${LOG_PREFIX} SillyTavern.getContext() not available. Extension cannot load.`);
        return;
    }

    const ctx = SillyTavern.getContext();
    if (!ctx) {
        console.error(`${LOG_PREFIX} SillyTavern context returned null. Extension cannot load.`);
        return;
    }

    // ── Install the generate_interceptor ─────────────────────────────────────
    installInterceptor();

    // ── Wire ST events ──────────────────────────────────────────────────────
    wireEvents(ctx);

    // ── Register slash commands ─────────────────────────────────────────────
    registerSlashCommands(ctx);

    // ── Mount settings panel via ST's template system ───────────────────────
    await mountSettingsPanel(ctx);

    // ── Expose global bridge functions ───────────────────────────────────────
    exposeGlobalBridge();

    console.log(`${LOG_PREFIX} Extension initialized successfully`);
});

// ════════════════════════════════════════════════════════════════════════════════
// Event wiring
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Wires GENERATION_ENDED and CHAT_CHANGED events using ST's eventSource API.
 * @param {Object} ctx - SillyTavern.getContext() result
 */
function wireEvents(ctx) {
    // ── Primary API: eventSource.on(event_types.EVENT_NAME, handler) ─────
    if (ctx.eventSource && ctx.event_types) {
        ctx.eventSource.on(ctx.event_types.GENERATION_ENDED, () => {
            try {
                onExtractionTriggered();
            } catch (e) {
                console.error(`${LOG_PREFIX} Error in GENERATION_ENDED handler:`, e);
            }
        });

        ctx.eventSource.on(ctx.event_types.CHAT_CHANGED, () => {
            try {
                resetExtractionCounter();
                // Refresh state panel if visible
                if (typeof globalThis._wandlightRefreshUI === 'function') {
                    globalThis._wandlightRefreshUI();
                }
            } catch (e) {
                console.error(`${LOG_PREFIX} Error in CHAT_CHANGED handler:`, e);
            }
        });

        console.log(`${LOG_PREFIX} Events wired via eventSource`);
        return;
    }

    // ── Fallback 1: eventBus ─────────────────────────────────────────────
    const bus = ctx.eventBus || (typeof eventBus !== 'undefined' ? eventBus : null);
    if (bus && bus.on) {
        bus.on('GENERATION_ENDED', () => {
            try { onExtractionTriggered(); } catch (e) { console.error(e); }
        });
        bus.on('CHAT_CHANGED', () => {
            try { resetExtractionCounter(); } catch (e) { console.error(e); }
        });
        console.log(`${LOG_PREFIX} Events wired via eventBus`);
        return;
    }

    // ── Fallback 2: eventTypes object (legacy) ───────────────────────────
    if (ctx.eventTypes) {
        ctx.eventTypes['GENERATION_ENDED'] = ctx.eventTypes['GENERATION_ENDED'] || [];
        ctx.eventTypes['GENERATION_ENDED'].push(() => {
            try { onExtractionTriggered(); } catch (e) { console.error(e); }
        });
        ctx.eventTypes['CHAT_CHANGED'] = ctx.eventTypes['CHAT_CHANGED'] || [];
        ctx.eventTypes['CHAT_CHANGED'].push(() => {
            try { resetExtractionCounter(); } catch (e) { console.error(e); }
        });
        console.log(`${LOG_PREFIX} Events wired via eventTypes object`);
        return;
    }

    console.warn(`${LOG_PREFIX} No event API found. Manual extraction via slash command is still available.`);
}

// ════════════════════════════════════════════════════════════════════════════════
// Slash commands
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Registers slash commands for manual control.
 * @param {Object} ctx - SillyTavern.getContext() result
 */
function registerSlashCommands(ctx) {
    if (typeof registerSlashCommand !== 'function') {
        console.warn(`${LOG_PREFIX} Slash command registration unavailable`);
        return;
    }

    const register = registerSlashCommand;

    // ── /wandlight-extract ───────────────────────────────────────────────────
    register('wandlight-extract', async () => {
        await onExtractionTriggered({ force: true });
    }, undefined, '👁️ Manually run continuity state extraction', 'Wandlight');

    // ── /wandlight-memo ─────────────────────────────────────────────────────
    register('wandlight-memo', async () => {
        const state = getState();
        const memo = buildMemo(state);
        if (!memo) {
            if (typeof toastr !== 'undefined') toastr.info('No continuity state to build memo from.');
        } else {
            navigator.clipboard.writeText(memo).then(() => {
                if (typeof toastr !== 'undefined') toastr.success('Continuity memo copied to clipboard');
            }).catch(() => {
                if (typeof toastr !== 'undefined') toastr.info(`[Wandlight Continuity State]\n${memo}`);
            });
        }
    }, undefined, '📋 Copy continuity memo to clipboard', 'Wandlight');

    // ── /wandlight-state ────────────────────────────────────────────────────
    register('wandlight-state', async () => {
        const state = getState();
        const json = exportState(state);
        navigator.clipboard.writeText(json).then(() => {
            if (typeof toastr !== 'undefined') toastr.success('Continuity state JSON copied to clipboard');
        }).catch(() => {
            if (typeof toastr !== 'undefined') toastr.info(`State JSON (${json.length} chars) ready; clipboard unavailable`);
        });
    }, undefined, '📄 Export full continuity state as JSON', 'Wandlight');

    console.log(`${LOG_PREFIX} Slash commands registered`);
}

// ════════════════════════════════════════════════════════════════════════════════
// Settings panel mounting
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Mounts the settings panel using ST's renderExtensionTemplateAsync.
 * This renders settings.html into the DOM and then wires all controls.
 * @param {Object} ctx - SillyTavern.getContext() result
 */
async function mountSettingsPanel(ctx) {
    // ── Render the template async ────────────────────────────────────────────
    if (ctx.renderExtensionTemplateAsync) {
        try {
            const html = await ctx.renderExtensionTemplateAsync(
                EXTENSION_FOLDER,
                'settings'
            );
            const extensionsSettings = document.getElementById('extensions_settings2');
            if (extensionsSettings) {
                extensionsSettings.insertAdjacentHTML('beforeend', html);
            } else {
                // Fallback: append to the older settings area
                const legacyArea = document.getElementById('extensions_settings');
                if (legacyArea) {
                    legacyArea.insertAdjacentHTML('beforeend', html);
                } else {
                    console.warn(`${LOG_PREFIX} No extensions_settings container found — settings panel unavailable`);
                    return;
                }
            }
        } catch (e) {
            console.error(`${LOG_PREFIX} renderExtensionTemplateAsync failed:`, e);
            return;
        }
    } else {
        console.warn(`${LOG_PREFIX} renderExtensionTemplateAsync not available — settings panel unavailable`);
        return;
    }

    // ── Wire UI after a brief DOM settle ───────────────────────────────────
    setTimeout(() => {
        const container = document.getElementById('wandlight_continuity_settings');
        if (container) {
            renderSettingsPanel(container);
            wireSettingsPanel(container);
            // Refresh the state/memo/delta displays after wiring
            // Use the local refreshStatePanel() directly since _wandlightRefreshUI
            // is not yet exposed by exposeGlobalBridge() at this point.
            try {
                refreshStatePanel();
            } catch (e) {
                // Silently ignore — state panel might not exist yet
            }
        }
    }, 100);

    console.log(`${LOG_PREFIX} Settings panel mounted`);
}

/**
 * Wires the settings panel form controls (save, buttons).
 * Called after the settings HTML is rendered into the DOM.
 * @param {HTMLElement} container - The settings panel div
 */
function wireSettingsPanel(container) {
    if (!container) return;

    const settings = getSettings();

    // ── Toggle controls → save settings ───────────────────────────────────
    const toggles = container.querySelectorAll('[data-setting]');
    toggles.forEach(el => {
        const key = el.dataset.setting;
        if (!key) return;

        // Set initial value from settings
        if (el.type === 'checkbox') {
            el.checked = !!settings[key];
        } else if (el.type === 'number' || el.type === 'range') {
            el.value = settings[key] !== undefined ? settings[key] : DEFAULT_SETTINGS[key];
        } else {
            el.value = settings[key] !== undefined ? String(settings[key]) : '';
        }

        // Wire change handler
        el.addEventListener('change', () => {
            const currentSettings = getSettings();
            if (el.type === 'checkbox') {
                currentSettings[key] = el.checked;
            } else if (el.type === 'number' || el.type === 'range') {
                currentSettings[key] = Number(el.value);
            } else {
                currentSettings[key] = el.value;
            }
            saveSettings(currentSettings);
            if (currentSettings.debugMode) {
                console.log(`${LOG_PREFIX} Setting "${key}" →`, currentSettings[key]);
            }
        });
    });

    // ── "Extract Now" button ──────────────────────────────────────────────
    const extractBtn = container.querySelector('#wandlight_extract_now');
    if (extractBtn) {
        extractBtn.addEventListener('click', async () => {
            extractBtn.disabled = true;
            extractBtn.textContent = 'Extracting...';
            try {
                await onExtractionTriggered({ force: true });
            } finally {
                extractBtn.disabled = false;
                extractBtn.textContent = 'Extract Now';
            }
        });
    }

    // ── "Apply Last Delta" button ─────────────────────────────────────────
    const applyDeltaBtn = container.querySelector('#wandlight_apply_delta');
    if (applyDeltaBtn) {
        applyDeltaBtn.addEventListener('click', () => {
            const state = getState();
            if (!state.lastDelta) {
                if (typeof toastr !== 'undefined') toastr.warning('No pending delta to apply');
                return;
            }
            // Snapshot before applying
            pushStateSnapshot(state, 'Manual delta apply: ' + (state.lastDelta.summary || 'unnamed'), settings.maxSnapshots);
            const newState = applyDelta(state, state.lastDelta);
            newState.lastDelta = null;
            saveState(newState);
            if (typeof toastr !== 'undefined') toastr.success('Delta applied');
            if (typeof globalThis._wandlightRefreshUI === 'function') {
                globalThis._wandlightRefreshUI();
            }
        });
    }

    // ── "Dismiss Delta" button ────────────────────────────────────────────
    const dismissBtn = container.querySelector('#wandlight_dismiss_delta');
    if (dismissBtn) {
        dismissBtn.addEventListener('click', () => {
            const state = getState();
            state.lastDelta = null;
            saveState(state);
            if (typeof toastr !== 'undefined') toastr.info('Delta dismissed');
            if (typeof globalThis._wandlightRefreshUI === 'function') {
                globalThis._wandlightRefreshUI();
            }
        });
    }

    // ── "Undo Last Change" button ─────────────────────────────────────────
    const undoBtn = container.querySelector('#wandlight_undo_change');
    if (undoBtn) {
        undoBtn.addEventListener('click', () => {
            const state = getState();
            const { state: restoredState, undone } = undoLastChange(state);
            if (undone) {
                saveState(restoredState);
                if (typeof toastr !== 'undefined') toastr.success('Last change undone');
                if (typeof globalThis._wandlightRefreshUI === 'function') {
                    globalThis._wandlightRefreshUI();
                }
            } else {
                if (typeof toastr !== 'undefined') toastr.info('No changes to undo');
            }
        });
    }

    // ── "Export State" button ─────────────────────────────────────────────
    const exportBtn = container.querySelector('#wandlight_export_state');
    if (exportBtn) {
        exportBtn.addEventListener('click', () => {
            const state = getState();
            const json = exportState(state);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `wandlight_state_${Date.now()}.json`;
            a.click();
            URL.revokeObjectURL(url);
            if (typeof toastr !== 'undefined') toastr.success('State exported');
        });
    }

    // ── "Import State" button ─────────────────────────────────────────────
    const importBtn = container.querySelector('#wandlight_import_state');
    if (importBtn) {
        importBtn.addEventListener('click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json';
            input.onchange = (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (re) => {
                    const previous = getState();
                    const { state, error } = importState(re.target.result);
                    if (error) {
                        if (typeof toastr !== 'undefined') toastr.error('Import failed: ' + error);
                        return;
                    }
                    // Snapshot the existing state before importing over it
                    pushStateSnapshot(previous, 'Import state snapshot', settings.maxSnapshots);
                    // Carry forward stateHistory so the snapshot isn't orphaned
                    state.stateHistory = previous.stateHistory;
                    state.memoHistory = previous.memoHistory || [];
                    saveState(state);
                    if (typeof toastr !== 'undefined') toastr.success('State imported successfully');
                    if (typeof globalThis._wandlightRefreshUI === 'function') {
                        globalThis._wandlightRefreshUI();
                    }
                };
                reader.readAsText(file);
            };
            input.click();
        });
    }

    // ── "Reset State" button ─────────────────────────────────────────────
    const resetBtn = container.querySelector('#wandlight_reset_state');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            if (!confirm('Reset all continuity state to defaults? You can undo this via Undo Last Change.')) {
                return;
            }
            // Snapshot before resetting so it can be undone
            const previous = getState();
            pushStateSnapshot(previous, 'Pre-reset snapshot', settings.maxSnapshots);
            const fresh = getDefaultState();
            fresh.stateHistory = previous.stateHistory;
            fresh.memoHistory = previous.memoHistory || [];
            saveState(fresh);
            if (typeof toastr !== 'undefined') toastr.success('State reset to defaults (undo available)');
            if (typeof globalThis._wandlightRefreshUI === 'function') {
                globalThis._wandlightRefreshUI();
            }
        });
    }

    console.log(`${LOG_PREFIX} Settings panel wired`);
}

// ════════════════════════════════════════════════════════════════════════════════
// Global bridge (expose functions for cross-module and external access)
// ════════════════════════════════════════════════════════════════════════════════

function exposeGlobalBridge() {
    globalThis._wandlightBuildMemo = buildMemo;
    globalThis._wandlightRefreshUI = refreshStatePanel;
    globalThis._wandlightGetState = getState;
    globalThis._wandlightValidateDelta = validateDelta;
    console.log(`${LOG_PREFIX} Global bridge exposed`);
}

// ════════════════════════════════════════════════════════════════════════════════
// State panel rendering
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Refreshes the state display panel. Called from buttons, events, and
 * via globalThis._wandlightRefreshUI().
 */
function refreshStatePanel() {
    const container = document.getElementById('wandlight_state_display');
    if (!container) return;

    const state = getState();
    if (!state) {
        container.textContent = '';
        const em = document.createElement('em');
        em.textContent = 'No continuity state loaded';
        container.appendChild(em);
        return;
    }

    renderStatePanel(container, state);

    // Also update the Last Delta preview area
    const deltaContainer = document.getElementById('wandlight_delta_preview');
    if (deltaContainer) {
        if (state.lastDelta) {
            const summary = state.lastDelta.summary || '(no summary)';
            const changeKeys = Object.keys(state.lastDelta.changes || {});
            const deltaJson = JSON.stringify(state.lastDelta, null, 2);

            // Build preview using safe DOM construction to avoid HTML injection
            deltaContainer.textContent = ''; // clear
            const wrapper = document.createElement('div');

            const strong = document.createElement('strong');
            strong.textContent = 'Pending Delta: ';
            wrapper.appendChild(strong);
            wrapper.appendChild(document.createTextNode(summary));

            const keyDiv = document.createElement('div');
            keyDiv.className = 'wandlight-delta-changes';
            keyDiv.textContent = 'Keys: ' + (changeKeys.length ? changeKeys.join(', ') : '(none)');
            wrapper.appendChild(keyDiv);

            const pre = document.createElement('pre');
            pre.className = 'wandlight-delta-json';
            pre.textContent = deltaJson;
            wrapper.appendChild(pre);

            deltaContainer.appendChild(wrapper);
        } else {
            deltaContainer.textContent = '';
            const em = document.createElement('em');
            em.textContent = 'No pending delta';
            deltaContainer.appendChild(em);
        }
    }
}


