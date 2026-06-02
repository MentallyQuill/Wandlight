/**
 * prompt-injector.js — Wandlight
 * Registers Wandlight prompt injection.
 *
 * Preferred path: SillyTavern setExtensionPrompt(), which supports role/depth.
 * Legacy fallback: generate_interceptor that prepends the combined memo to the
 * last user message. The legacy path has no true role/depth control.
 *
 * Ephemeral: neither path writes injected text back to stored chat messages.
 */

import { LOG_PREFIX, MEMO_MAX_TOKENS } from './constants.js';
import { getSettings, getState } from './state-manager.js';
import { buildMemo, buildContinuityMemo, buildLoreMemo } from './memo-builder.js';

const COMBINED_MARKER = '[WANDLIGHT CONTINUITY STATE]';
const CONTINUITY_PROMPT_KEY = 'wandlight_continuity_state';
const LORE_PROMPT_KEY = 'wandlight_lore_entries'; // legacy aggregate key, cleared for compatibility
const LORE_HIGH_PROMPT_KEY = 'wandlight_lore_high_relevance';
const LORE_NORMAL_PROMPT_KEY = 'wandlight_lore_normal_relevance';
const LORE_LOW_PROMPT_KEY = 'wandlight_lore_low_relevance';


// Do not statically import SillyTavern's root script.js here. Some ST builds do
// not export the exact names we need, and a missing named export prevents this
// entire extension module from loading. Resolve the API lazily at runtime.
const FALLBACK_EXTENSION_PROMPT_TYPES = Object.freeze({
    IN_PROMPT: 0,
    IN_CHAT: 1,
    BEFORE_PROMPT: 2,
});

const FALLBACK_EXTENSION_PROMPT_ROLES = Object.freeze({
    SYSTEM: 0,
    USER: 1,
    ASSISTANT: 2,
});

function getExtensionPromptApi() {
    const ctx = getSillyTavernContextSafe();
    const promptTypes = globalThis.extension_prompt_types || ctx?.extension_prompt_types || FALLBACK_EXTENSION_PROMPT_TYPES;
    const promptRoles = globalThis.extension_prompt_roles || ctx?.extension_prompt_roles || FALLBACK_EXTENSION_PROMPT_ROLES;
    const setter = ctx?.setExtensionPrompt || globalThis.setExtensionPrompt || globalThis.SillyTavern?.setExtensionPrompt;

    return {
        setExtensionPrompt: typeof setter === 'function' ? setter : null,
        extension_prompt_types: promptTypes,
        extension_prompt_roles: promptRoles,
    };
}

function getSillyTavernContextSafe() {
    try {
        if (typeof globalThis.SillyTavern?.getContext === 'function') {
            return globalThis.SillyTavern.getContext();
        }
    } catch (_) {
        // Ignore context lookup failures during early extension load.
    }
    return null;
}

let lastSyncInfo = {
    transport: 'unknown',
    continuityChars: 0,
    loreChars: 0,
    combinedChars: 0,
    syncedAt: 0,
    fallback: false,
};

/**
 * Installs the legacy generate_interceptor and exposes prompt-sync utilities.
 * Called once from index.js on jQuery document ready.
 */
export function installInterceptor() {
    globalThis.wandlightInterceptor = wandlightInterceptor;
    globalThis.wandlightContinuityInterceptor = wandlightInterceptor; // legacy alias
    globalThis.wandlightSyncPromptInjection = syncPromptInjection;
    globalThis.wandlightClearPromptInjection = clearExtensionPrompts;
    globalThis.wandlightGetInjectionStatus = () => ({ ...lastSyncInfo });

    syncPromptInjection();

    if (typeof globalThis.wandlightInterceptor === 'function') {
        console.log(`${LOG_PREFIX} prompt injection registered`);
    } else {
        console.error(`${LOG_PREFIX} Failed to register generate_interceptor`);
    }
}

/**
 * Updates SillyTavern extension prompts from current settings/state. This should
 * be called before prompt assembly and after relevant settings/state changes.
 */
export function syncPromptInjection() {
    try {
        const settings = getSettings();
        const state = getState();

        if (!settings.enabled) {
            clearExtensionPrompts();
            lastSyncInfo = { transport: 'disabled', continuityChars: 0, loreChars: 0, combinedChars: 0, syncedAt: Date.now(), fallback: false };
            return lastSyncInfo;
        }

        if ((settings.injectionTransport || 'extension_prompt') !== 'extension_prompt') {
            clearExtensionPrompts();
            lastSyncInfo = { transport: 'interceptor', continuityChars: 0, loreChars: 0, combinedChars: 0, syncedAt: Date.now(), fallback: true };
            return lastSyncInfo;
        }

        const injectContinuity = settings.injectContinuity !== false && settings.injectMemo !== false;
        const injectLore = settings.injectLore !== false;

        const continuityText = injectContinuity ? wrapContinuityPrompt(buildContinuityMemo(state)) : '';
        const loreHighText = injectLore && settings.loreHighInjectionEnabled !== false ? wrapLorePrompt(buildLoreMemo(state, { relevanceTier: 'high' }), 'HIGH RELEVANCE LORE') : '';
        const loreNormalText = injectLore && settings.loreNormalInjectionEnabled !== false ? wrapLorePrompt(buildLoreMemo(state, { relevanceTier: 'normal' }), 'NORMAL RELEVANCE LORE') : '';
        const loreLowText = injectLore && settings.loreLowInjectionEnabled !== false ? wrapLorePrompt(buildLoreMemo(state, { relevanceTier: 'low' }), 'LOW RELEVANCE LORE') : '';
        const loreText = [loreHighText, loreNormalText, loreLowText].filter(Boolean).join('\n\n');

        setWandlightExtensionPrompt(
            CONTINUITY_PROMPT_KEY,
            continuityText,
            settings.continuityInjectionPosition,
            settings.continuityInjectionDepth,
            settings.continuityInjectionRole,
            !!settings.injectionPromptScan,
        );

        // Legacy aggregate lore prompt is cleared; relevance tiers are injected as independent prompt groups.
        setWandlightExtensionPrompt(LORE_PROMPT_KEY, '', settings.loreInjectionPosition, settings.loreInjectionDepth, settings.loreInjectionRole, !!settings.injectionPromptScan);
        setWandlightExtensionPrompt(
            LORE_HIGH_PROMPT_KEY,
            loreHighText,
            settings.loreHighInjectionPosition ?? settings.loreInjectionPosition,
            settings.loreHighInjectionDepth ?? settings.loreInjectionDepth,
            settings.loreHighInjectionRole ?? settings.loreInjectionRole,
            !!settings.injectionPromptScan,
        );
        setWandlightExtensionPrompt(
            LORE_NORMAL_PROMPT_KEY,
            loreNormalText,
            settings.loreNormalInjectionPosition ?? settings.loreInjectionPosition,
            settings.loreNormalInjectionDepth ?? settings.loreInjectionDepth,
            settings.loreNormalInjectionRole ?? settings.loreInjectionRole,
            !!settings.injectionPromptScan,
        );
        setWandlightExtensionPrompt(
            LORE_LOW_PROMPT_KEY,
            loreLowText,
            settings.loreLowInjectionPosition ?? settings.loreInjectionPosition,
            settings.loreLowInjectionDepth ?? settings.loreInjectionDepth,
            settings.loreLowInjectionRole ?? settings.loreInjectionRole,
            !!settings.injectionPromptScan,
        );

        lastSyncInfo = {
            transport: 'extension_prompt',
            continuityChars: continuityText.length,
            loreChars: loreText.length,
            loreHighChars: loreHighText.length,
            loreNormalChars: loreNormalText.length,
            loreLowChars: loreLowText.length,
            combinedChars: continuityText.length + loreText.length,
            syncedAt: Date.now(),
            fallback: false,
            continuity: {
                position: normalizePosition(settings.continuityInjectionPosition),
                depth: normalizeDepth(settings.continuityInjectionDepth),
                role: normalizeRole(settings.continuityInjectionRole),
            },
            lore: {
                high: { position: normalizePosition(settings.loreHighInjectionPosition ?? settings.loreInjectionPosition), depth: normalizeDepth(settings.loreHighInjectionDepth ?? settings.loreInjectionDepth), role: normalizeRole(settings.loreHighInjectionRole ?? settings.loreInjectionRole) },
                normal: { position: normalizePosition(settings.loreNormalInjectionPosition ?? settings.loreInjectionPosition), depth: normalizeDepth(settings.loreNormalInjectionDepth ?? settings.loreInjectionDepth), role: normalizeRole(settings.loreNormalInjectionRole ?? settings.loreInjectionRole) },
                low: { position: normalizePosition(settings.loreLowInjectionPosition ?? settings.loreInjectionPosition), depth: normalizeDepth(settings.loreLowInjectionDepth ?? settings.loreInjectionDepth), role: normalizeRole(settings.loreLowInjectionRole ?? settings.loreInjectionRole) },
            },
        };

        if (settings.debugMode) {
            console.log(`${LOG_PREFIX} Extension prompts synced`, lastSyncInfo);
        }

        return lastSyncInfo;
    } catch (e) {
        console.error(`${LOG_PREFIX} Failed to sync extension prompts`, e);
        clearExtensionPrompts();
        lastSyncInfo = { transport: 'error', continuityChars: 0, loreChars: 0, combinedChars: 0, syncedAt: Date.now(), fallback: false, error: String(e?.message || e) };
        return lastSyncInfo;
    }
}

export function clearExtensionPrompts() {
    try {
        const api = getExtensionPromptApi();
        if (!api.setExtensionPrompt) return;
        api.setExtensionPrompt(CONTINUITY_PROMPT_KEY, '', api.extension_prompt_types.IN_CHAT, 4, false, api.extension_prompt_roles.SYSTEM);
        api.setExtensionPrompt(LORE_PROMPT_KEY, '', api.extension_prompt_types.IN_CHAT, 4, false, api.extension_prompt_roles.SYSTEM);
        api.setExtensionPrompt(LORE_HIGH_PROMPT_KEY, '', api.extension_prompt_types.IN_CHAT, 4, false, api.extension_prompt_roles.SYSTEM);
        api.setExtensionPrompt(LORE_NORMAL_PROMPT_KEY, '', api.extension_prompt_types.IN_CHAT, 4, false, api.extension_prompt_roles.SYSTEM);
        api.setExtensionPrompt(LORE_LOW_PROMPT_KEY, '', api.extension_prompt_types.IN_CHAT, 4, false, api.extension_prompt_roles.SYSTEM);
    } catch (e) {
        console.warn(`${LOG_PREFIX} Failed to clear extension prompts`, e);
    }
}

function setWandlightExtensionPrompt(key, value, position, depth, role, scan = false) {
    const api = getExtensionPromptApi();
    if (!api.setExtensionPrompt) {
        if (getSettings().debugMode) {
            console.warn(`${LOG_PREFIX} setExtensionPrompt API unavailable; extension prompt injection not synced`);
        }
        return;
    }
    api.setExtensionPrompt(
        key,
        value || '',
        normalizePosition(position),
        normalizeDepth(depth),
        !!scan,
        normalizeRole(role),
    );
}

function normalizePosition(value) {
    const { extension_prompt_types } = getExtensionPromptApi();
    const numeric = Number(value);
    const valid = [
        extension_prompt_types.IN_PROMPT,
        extension_prompt_types.IN_CHAT,
        extension_prompt_types.BEFORE_PROMPT,
    ].filter(v => Number.isFinite(Number(v)));
    if (valid.includes(numeric)) return numeric;
    const text = String(value || '').toLowerCase();
    if (text === 'before' || text === 'before_prompt') return extension_prompt_types.BEFORE_PROMPT;
    if (text === 'after' || text === 'in_prompt') return extension_prompt_types.IN_PROMPT;
    return extension_prompt_types.IN_CHAT;
}

function normalizeRole(value) {
    const { extension_prompt_roles } = getExtensionPromptApi();
    const numeric = Number(value);
    const valid = [
        extension_prompt_roles.SYSTEM,
        extension_prompt_roles.USER,
        extension_prompt_roles.ASSISTANT,
    ].filter(v => Number.isFinite(Number(v)));
    if (valid.includes(numeric)) return numeric;
    switch (String(value || '').toLowerCase()) {
        case 'user': return extension_prompt_roles.USER;
        case 'assistant': return extension_prompt_roles.ASSISTANT;
        case 'system':
        default: return extension_prompt_roles.SYSTEM;
    }
}

function normalizeDepth(value) {
    return Math.max(0, Math.min(1000, parseInt(value, 10) || 0));
}

function wrapContinuityPrompt(text) {
    const body = String(text || '').trim();
    if (!body) return '';
    return `[WANDLIGHT CONTINUITY]\n${body}\n[/WANDLIGHT CONTINUITY]`;
}

function wrapLorePrompt(text, label = 'LORE') {
    const body = String(text || '').trim();
    if (!body) return '';
    return `[WANDLIGHT ${label}]\n${body}\n[/WANDLIGHT ${label}]`;
}

/**
 * Legacy ST generate_interceptor hook. Used only when injectionTransport is set
 * to 'interceptor'. It prepends the combined memo to the last user message, so
 * it has no role/depth semantics beyond the last user message's role.
 */
function wandlightInterceptor(chat, contextSize, abort, type) {
    if (type === 'quiet') return;
    try {
        const settings = getSettings();
        if ((settings.injectionTransport || 'extension_prompt') !== 'interceptor') return;

        if (!settings.enabled) return;
        const injectContinuity = settings.injectContinuity !== false && settings.injectMemo !== false;
        const injectLore = settings.injectLore !== false;
        if (!injectContinuity && !injectLore) return;
        if (!chat || !Array.isArray(chat) || chat.length === 0) return;

        const state = getState();
        if (!state) return;

        const memo = buildMemo(state);
        if (!memo || typeof memo !== 'string' || memo.trim().length === 0) return;

        const estimatedTokens = estimateTokens(memo);
        if (estimatedTokens > MEMO_MAX_TOKENS) {
            if (settings.debugMode) {
                console.warn(`${LOG_PREFIX} Memo estimated at ${estimatedTokens} tokens (cap: ${MEMO_MAX_TOKENS}) — skipping legacy injection`);
            }
            return;
        }

        for (let i = chat.length - 1; i >= 0; i--) {
            const msg = chat[i];
            if (!msg || !msg.is_user) continue;

            const contentField = typeof msg.mes === 'string' ? 'mes'
                : typeof msg.content === 'string' ? 'content'
                : null;
            if (!contentField) continue;

            const originalContent = msg[contentField];
            if (originalContent && originalContent.includes(COMBINED_MARKER)) {
                if (settings.debugMode) console.log(`${LOG_PREFIX} Memo marker already present — skipping legacy injection`);
                return;
            }

            const cloned = typeof structuredClone === 'function'
                ? structuredClone(msg)
                : JSON.parse(JSON.stringify(msg));

            cloned[contentField] = memo + '\n\n' + originalContent;
            chat[i] = cloned;

            lastSyncInfo = {
                transport: 'interceptor',
                continuityChars: 0,
                loreChars: 0,
                combinedChars: memo.length,
                syncedAt: Date.now(),
                fallback: true,
                role: 'last_user_message',
                depth: null,
            };

            if (settings.debugMode) {
                console.log(`${LOG_PREFIX} Legacy memo injected into last user message (${memo.length} chars, ~${estimateTokens(memo)} tokens)`);
            }
            return;
        }

        if (settings.debugMode) console.log(`${LOG_PREFIX} No user message found to inject legacy memo into`);
    } catch (e) {
        console.error(`${LOG_PREFIX} Interceptor error:`, e);
    }
}

function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
}
