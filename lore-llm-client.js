/**
 * lore-llm-client.js — Wandlight Continuity
 * Provider abstraction for lore context detection and lore matrix generation.
 *
 * Three provider modes, selected via settings.loreProvider:
 *   'st'               — Current SillyTavern model (generateRaw / generateQuietPrompt fallback)
 *   'profile'          — SillyTavern connection profile (ConnectionManagerRequestService)
 *   'openai_compatible' — Any /v1/chat/completions endpoint
 *
 * Exports: sendLoreRequest
 * Imported by: lore-generator.js
 */

import { getSettings } from './state-manager.js';
import { decryptSecretIfAvailable } from './secure-keyring.js';

// ── Endpoint normalization ──────────────────────────────────────────────────────

function normalizeOpenAIChatEndpoint(baseUrl) {
    const base = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('OpenAI-compatible base URL is missing.');

    if (base.endsWith('/chat/completions')) return base;
    if (base.endsWith('/v1')) return `${base}/chat/completions`;

    return `${base}/v1/chat/completions`;
}

// ── Response content extraction ─────────────────────────────────────────────────

function extractChatCompletionText(json) {
    return json?.choices?.[0]?.message?.content
        ?? json?.choices?.[0]?.text
        ?? json?.message?.content
        ?? json?.content
        ?? '';
}

// ── Provider: OpenAI-compatible endpoint ────────────────────────────────────────

/**
 * Sends a lore request to an OpenAI-compatible /v1/chat/completions endpoint.
 * Retrieves the decrypted key from the in-memory keyring.
 * Retries once without response_format if the endpoint rejects it.
 */
async function sendViaOpenAICompatible(systemPrompt, userPrompt, options = {}) {
    const settings = getSettings();

    const endpoint = normalizeOpenAIChatEndpoint(settings.loreOpenAIBaseUrl);
    const apiKey = await decryptSecretIfAvailable('loreOpenAI');

    if (!settings.loreOpenAIModel) {
        throw new Error('Lore OpenAI-compatible model is missing.');
    }

    const requestBody = {
        model: settings.loreOpenAIModel,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
        temperature: Number(settings.loreTemperature ?? 0.1),
        top_p: Number(settings.loreTopP ?? 0.9),
        max_tokens: Number(options.maxTokens || settings.loreMaxTokens || 2048),
        stream: false,
    };

    if (settings.loreOpenAIUseJsonMode) {
        requestBody.response_format = { type: 'json_object' };
    }

    const headers = {
        'Content-Type': 'application/json',
    };

    if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
    }

    let response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        credentials: 'omit',
    });

    // Some compatible backends reject response_format.
    if (!response.ok && settings.loreOpenAIUseJsonMode) {
        const text = await response.text().catch(() => '');
        if (/response_format|json_object/i.test(text)) {
            delete requestBody.response_format;

            response = await fetch(endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify(requestBody),
                credentials: 'omit',
            });
        } else {
            throw new Error(`Lore OpenAI request failed (${response.status}): ${text.slice(0, 300)}`);
        }
    }

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        if (response.status === 401) {
            throw new Error('Lore OpenAI-compatible endpoint returned 401. Check API key.');
        }
        throw new Error(`Lore OpenAI request failed (${response.status}): ${text.slice(0, 300)}`);
    }

    const json = await response.json();
    const content = extractChatCompletionText(json);

    if (!content || !content.trim()) {
        throw new Error('Lore OpenAI-compatible endpoint returned empty content.');
    }

    return content;
}

// ── Provider: SillyTavern raw APIs (generateRaw / generateQuietPrompt) ──────────

async function sendViaSillyTavernRaw(systemPrompt, userPrompt, options = {}) {
    const ctx = SillyTavern.getContext();

    if (typeof ctx.generateRaw === 'function') {
        const result = await ctx.generateRaw({
            systemPrompt,
            prompt: userPrompt,
            prefill: options.prefill || '',
            responseLength: options.maxTokens,
            bypassAll: true,
        });

        return typeof result === 'string' ? result : '';
    }

    if (typeof ctx.generateQuietPrompt === 'function') {
        const result = await ctx.generateQuietPrompt({
            quietPrompt: `${systemPrompt}\n\n${userPrompt}`,
        });

        return typeof result === 'string' ? result : '';
    }

    throw new Error('No SillyTavern raw generation API available.');
}

// ── Provider: SillyTavern connection profile ────────────────────────────────────

async function sendViaConnectionProfile(systemPrompt, userPrompt, options = {}) {
    const settings = getSettings();
    const ctx = SillyTavern.getContext();
    const service = ctx.ConnectionManagerRequestService;

    if (!settings.loreProfileId) {
        throw new Error('Lore profile is not selected.');
    }

    if (!service || typeof service.sendRequest !== 'function') {
        throw new Error('ConnectionManagerRequestService unavailable.');
    }

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ];

    const maxTokens = Number(options.maxTokens || settings.loreMaxTokens || 2048);

    const raw = await service.sendRequest(
        settings.loreProfileId,
        messages,
        maxTokens,
        {
            stream: false,
            extractData: true,
            includePreset: true,
            includeInstruct: true,
        },
    );

    return typeof raw === 'string'
        ? raw
        : raw?.content
            ?? raw?.message?.content
            ?? raw?.choices?.[0]?.message?.content
            ?? raw?.choices?.[0]?.text
            ?? '';
}

// ── Public API: dispatches to the selected provider ─────────────────────────────

/**
 * Sends a lore request to the configured provider.
 *
 * @param {string} systemPrompt - System message (instructions)
 * @param {string} userPrompt - User message (data/query)
 * @param {Object} [options] - Optional overrides
 * @param {number} [options.maxTokens] - Max response tokens
 * @param {string} [options.prefill] - Prefill text (some providers only)
 * @returns {Promise<string>} LLM response text (may be empty on failure)
 */
export async function sendLoreRequest(systemPrompt, userPrompt, options = {}) {
    const settings = getSettings();

    try {
        if (settings.loreProvider === 'openai_compatible') {
            return await sendViaOpenAICompatible(systemPrompt, userPrompt, options);
        }

        if (settings.loreProvider === 'profile') {
            return await sendViaConnectionProfile(systemPrompt, userPrompt, options);
        }

        // Default: use current SillyTavern model
        return await sendViaSillyTavernRaw(systemPrompt, userPrompt, options);
    } catch (e) {
        // Re-throw so callers can log/display the error
        throw e;
    }
}