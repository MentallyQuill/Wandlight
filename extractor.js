/**
 * extractor.js — Wandlight
 * Event/automation entrypoints for checkpointed continuity scanning, context
 * detection, and story-lore scanning.
 *
 * The legacy one-prompt continuity extractor has been replaced by
 * continuity-scanner.js. This file now owns throttle/guard behavior only.
 */

import { LOG_PREFIX } from './constants.js';
import { getSettings } from './state-manager.js';
import { runLoreContextDetection, runStoryLoreScan } from './lore-generator.js';
import { runContinuityScan } from './continuity-scanner.js';
import { validateLoreProviderConfiguration } from './lore-llm-client.js';

/** Guard flag to prevent concurrent continuity scans. */
let _extractionRunning = false;

/**
 * Main continuity scan handler. Called by manual UI/slash command and by
 * GENERATION_ENDED automation when automatic continuity tracking is enabled.
 *
 * @param {Object} [options]
 * @param {boolean} [options.force] - Bypass automatic mode and interval checks.
 * @param {boolean} [options.applyImmediately] - Apply reduced delta instead of storing lastDelta.
 * @returns {Promise<Object>} Structured scan result.
 */
export async function onExtractionTriggered(options = {}) {
    const { force = false, applyImmediately = false } = options;

    if (_extractionRunning) {
        const settings = getSettings();
        if (settings.debugMode) console.log(`${LOG_PREFIX} Continuity scan already running, skipping`);
        return { status: 'skipped_running' };
    }

    const settings = getSettings();
    if (!settings.enabled) return { status: 'disabled' };

    if (!force) {
        const mode = settings.continuityTrackingMode || (settings.autoExtract ? 'automatic' : 'manual');
        if (mode !== 'automatic') return { status: 'skipped_continuity_manual' };

        if (typeof onExtractionTriggered._counter === 'undefined') onExtractionTriggered._counter = 0;
        onExtractionTriggered._counter++;
        const interval = Math.max(1, Math.min(20, Number(settings.continuityAutoInterval || settings.extractionInterval) || 1));
        if (onExtractionTriggered._counter < interval) return { status: 'skipped_interval' };
        onExtractionTriggered._counter = 0;
    }

    const validation = validateLoreProviderConfiguration('continuity');
    if (!validation.ok) return { status: 'api_not_configured', error: validation.message };

    _extractionRunning = true;
    try {
        const result = await runContinuityScan({
            ...options,
            force,
            source: force ? 'manual' : 'auto',
            automationSafe: !force,
            applyImmediately: !!applyImmediately,
        });

        if (typeof globalThis._wandlightRefreshUI === 'function') globalThis._wandlightRefreshUI();
        return result;
    } catch (e) {
        console.error(`${LOG_PREFIX} Continuity scan failed:`, e);
        return { status: 'failed_exception', error: e?.message || String(e) };
    } finally {
        _extractionRunning = false;
    }
}

function shouldRunTurnInterval(counterName, interval) {
    const key = `_${counterName}Counter`;
    if (typeof onGenerationEndedAutomation[key] === 'undefined') onGenerationEndedAutomation[key] = 0;
    onGenerationEndedAutomation[key]++;
    const threshold = Math.max(1, Math.min(20, Number(interval) || 1));
    if (onGenerationEndedAutomation[key] < threshold) return false;
    onGenerationEndedAutomation[key] = 0;
    return true;
}

export async function onGenerationEndedAutomation() {
    const settings = getSettings();
    if (!settings.enabled) return { status: 'disabled' };

    const results = {};

    try {
        results.continuity = await onExtractionTriggered({ force: false });
    } catch (e) {
        results.continuity = { status: 'failed_exception', error: e?.message || String(e) };
    }

    if ((settings.contextDetectionMode || 'manual') === 'automatic'
        && shouldRunTurnInterval('contextDetection', settings.contextDetectionAutoInterval || 5)) {
        try {
            const validation = validateLoreProviderConfiguration('lore');
            if (!validation.ok) results.context = { status: 'api_not_configured', error: validation.message };
            else results.context = await runLoreContextDetection({ force: false });
        } catch (e) {
            results.context = { status: 'failed_exception', error: e?.message || String(e) };
        }
    }

    if ((settings.loreGenerationMode || 'manual') === 'automatic'
        && shouldRunTurnInterval('loreGeneration', settings.loreGenerationAutoInterval || 10)) {
        try {
            const validation = validateLoreProviderConfiguration('lore');
            if (!validation.ok) results.lore = { status: 'api_not_configured', error: validation.message };
            else results.lore = await runStoryLoreScan({ force: false, source: 'auto', automationSafe: true });
        } catch (e) {
            results.lore = { status: 'failed_exception', error: e?.message || String(e) };
        }
    }

    if (typeof globalThis._wandlightRefreshUI === 'function') globalThis._wandlightRefreshUI();
    return { status: 'complete', results };
}

/** Returns whether a continuity scan is currently running. */
export function isExtractionRunning() {
    return _extractionRunning;
}

globalThis._wandlightRunExtraction = onExtractionTriggered;
globalThis._wandlightRunAutomation = onGenerationEndedAutomation;
globalThis._wandlightIsExtractionRunning = isExtractionRunning;

/** Resets the automatic continuity throttle counter. Called on chat change. */
export function resetExtractionCounter() {
    onExtractionTriggered._counter = 0;
}
