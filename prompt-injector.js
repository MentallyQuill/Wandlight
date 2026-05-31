/**
 * prompt-injector.js — Wandlight Continuity
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
import { setExtensionPrompt, extension_prompt_types, extension_prompt_roles } from '../../../../script.js';

const COMBINED_MARKER = '[WANDLIGHT CONTINUITY STATE]';
const CONTINUITY_PROMPT_KEY = 'wandlight_continuity_state';
const LORE_PROMPT_KEY = 'wandlight_lore_entries';

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
    globalThis.wandlightContinuityInterceptor = wandlightContinuityInterceptor;
    globalThis.wandlightSyncPromptInjection = syncPromptInjection;
    globalThis.wandlightClearPromptInjection = clearExtensionPrompts;
    globalThis.wandlightGetInjectionStatus = () => ({ ...lastSyncInfo });

    syncPromptInjection();

    if (typeof globalThis.wandlightContinuityInterceptor === 'function') {
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
        const loreText = injectLore ? wrapLorePrompt(buildLoreMemo(state)) : '';

        setWandlightExtensionPrompt(
            CONTINUITY_PROMPT_KEY,
            continuityText,
            settings.continuityInjectionPosition,
            settings.continuityInjectionDepth,
            settings.continuityInjectionRole,
            !!settings.injectionPromptScan,
        );

        setWandlightExtensionPrompt(
            LORE_PROMPT_KEY,
            loreText,
            settings.loreInjectionPosition,
            settings.loreInjectionDepth,
            settings.loreInjectionRole,
            !!settings.injectionPromptScan,
        );

        lastSyncInfo = {
            transport: 'extension_prompt',
            continuityChars: continuityText.length,
            loreChars: loreText.length,
            combinedChars: continuityText.length + loreText.length,
            syncedAt: Date.now(),
            fallback: false,
            continuity: {
                position: normalizePosition(settings.continuityInjectionPosition),
                depth: normalizeDepth(settings.continuityInjectionDepth),
                role: normalizeRole(settings.continuityInjectionRole),
            },
            lore: {
                position: normalizePosition(settings.loreInjectionPosition),
                depth: normalizeDepth(settings.loreInjectionDepth),
                role: normalizeRole(settings.loreInjectionRole),
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
        setExtensionPrompt(CONTINUITY_PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 4, false, extension_prompt_roles.SYSTEM);
        setExtensionPrompt(LORE_PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 4, false, extension_prompt_roles.SYSTEM);
    } catch (e) {
        console.warn(`${LOG_PREFIX} Failed to clear extension prompts`, e);
    }
}

function setWandlightExtensionPrompt(key, value, position, depth, role, scan = false) {
    setExtensionPrompt(
        key,
        value || '',
        normalizePosition(position),
        normalizeDepth(depth),
        !!scan,
        normalizeRole(role),
    );
}

function normalizePosition(value) {
    const numeric = Number(value);
    if ([extension_prompt_types.IN_PROMPT, extension_prompt_types.IN_CHAT, extension_prompt_types.BEFORE_PROMPT].includes(numeric)) {
        return numeric;
    }
    if (String(value) === 'before') return extension_prompt_types.BEFORE_PROMPT;
    if (String(value) === 'after') return extension_prompt_types.IN_PROMPT;
    return extension_prompt_types.IN_CHAT;
}

function normalizeRole(value) {
    const numeric = Number(value);
    if ([extension_prompt_roles.SYSTEM, extension_prompt_roles.USER, extension_prompt_roles.ASSISTANT].includes(numeric)) {
        return numeric;
    }
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

function wrapLorePrompt(text) {
    const body = String(text || '').trim();
    if (!body) return '';
    return `[WANDLIGHT LORE]\n${body}\n[/WANDLIGHT LORE]`;
}

/**
 * Legacy ST generate_interceptor hook. Used only when injectionTransport is set
 * to 'interceptor'. It prepends the combined memo to the last user message, so
 * it has no role/depth semantics beyond the last user message's role.
 */
function wandlightContinuityInterceptor(chat, contextSize, abort, type) {
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
