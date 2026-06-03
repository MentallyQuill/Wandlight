/**
 * lore-llm-client.js — Wandlight
 * Provider abstraction for continuity scanning, lore context detection, and lore generation.
 *
 * Provider roles:
 *   continuity — Utility Provider: frequent, fast/cheap tasks such as compression and continuity scans
 *   lore       — Reasoning Provider: deeper story context and lore-generation tasks
 *
 * Internal kind names are retained for backward-compatible settings storage.
 */

import { getSettings } from './state-manager.js';
import { loadNamedApiKey } from './secure-keyring.js';

const PROVIDER_KINDS = new Set(['continuity', 'lore']);
const cachedKeys = new Map();

function normalizeProviderKind(kind = 'lore') {
    const normalized = String(kind || 'lore').toLowerCase();
    return PROVIDER_KINDS.has(normalized) ? normalized : 'lore';
}

function capName(kind) {
    return kind === 'continuity' ? 'continuity' : 'lore';
}

function getProviderSettings(kind = 'lore') {
    const settings = getSettings();
    const k = normalizeProviderKind(kind);
    const prefix = capName(k);
    const title = k === 'continuity' ? 'Utility' : 'Reasoning';

    return {
        kind: k,
        title,
        provider: settings[`${prefix}Provider`] || 'st',
        profileId: settings[`${prefix}ProfileId`] || '',
        openAIBaseUrl: settings[`${prefix}OpenAIBaseUrl`] || '',
        openAIModel: settings[`${prefix}OpenAIModel`] || '',
        openAIKeySet: !!settings[`${prefix}OpenAIKeySet`],
        temperature: Number(settings[`${prefix}Temperature`] ?? 0.7),
        topP: Number(settings[`${prefix}TopP`] ?? 0.98),
        maxTokens: Number(settings[`${prefix}MaxTokens`] || 8192),
        secretName: `${prefix}OpenAI`,
    };
}

function normalizeOpenAIChatEndpoint(baseUrl) {
    const base = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('OpenAI-compatible base URL is missing.');
    if (base.endsWith('/chat/completions')) return base;
    if (base.endsWith('/v1')) return `${base}/chat/completions`;
    return `${base}/v1/chat/completions`;
}

function normalizeOpenAIBaseUrl(baseUrl) {
    const base = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('OpenAI-compatible base URL is missing.');
    if (base.endsWith('/v1')) return base;
    if (base.endsWith('/v1/chat/completions')) return base.replace(/\/chat\/completions$/, '/v1');
    if (base.endsWith('/chat/completions')) return base.replace(/\/chat\/completions$/, '');
    return `${base}/v1`;
}

function extractTextFromContent(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
        return value.map(part => {
            if (typeof part === 'string') return part;
            if (part?.type === 'text' && typeof part.text === 'string') return part.text;
            if (typeof part?.text === 'string') return part.text;
            if (typeof part?.content === 'string') return part.content;
            return '';
        }).filter(Boolean).join('');
    }
    if (value && typeof value === 'object') {
        if (typeof value.text === 'string') return value.text;
        if (typeof value.content === 'string') return value.content;
        if (typeof value.value === 'string') return value.value;
    }
    return '';
}

function extractChatCompletionText(json) {
    return extractTextFromContent(json?.choices?.[0]?.message?.content)
        || extractTextFromContent(json?.choices?.[0]?.delta?.content)
        || extractTextFromContent(json?.choices?.[0]?.text)
        || extractTextFromContent(json?.message?.content)
        || extractTextFromContent(json?.content)
        || extractTextFromContent(json?.response)
        || extractTextFromContent(json?.text)
        || '';
}


function extractChatCompletionReasoning(json) {
    const message = json?.choices?.[0]?.message || json?.message || json || {};
    const parts = [];
    const direct = [
        message.reasoning,
        message.reasoning_content,
        message.reasoningContent,
        json?.choices?.[0]?.reasoning,
        json?.reasoning,
    ];
    for (const value of direct) {
        const text = extractTextFromContent(value);
        if (text) parts.push(text);
    }
    const details = message.reasoning_details || json?.choices?.[0]?.message?.reasoning_details || json?.reasoning_details;
    if (Array.isArray(details)) {
        for (const detail of details) {
            if (typeof detail?.text === 'string') parts.push(detail.text);
            else if (typeof detail?.content === 'string') parts.push(detail.content);
        }
    }
    return parts.join('').slice(0, 12000);
}

function normalizeFinishReason(value) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value === 'object') {
        return normalizeFinishReason(
            value.reason
            ?? value.type
            ?? value.code
            ?? value.status
            ?? value.finish_reason
            ?? value.finishReason
            ?? value.stop_reason
            ?? value.stopReason
            ?? value.native_finish_reason
            ?? value.nativeFinishReason
        );
    }
    return String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function collectFinishReasons(json) {
    if (!json || typeof json !== 'object') return [];

    const choice = Array.isArray(json.choices) ? json.choices[0] : null;
    const message = choice?.message || json.message || {};
    const candidate = Array.isArray(json.candidates) ? json.candidates[0] : null;
    const output = Array.isArray(json.outputs) ? json.outputs[0] : Array.isArray(json.output) ? json.output[0] : null;
    const details = choice?.finish_details || choice?.finishDetails || json.finish_details || json.finishDetails;
    const metadata = json.response_metadata || json.responseMetadata || json.metadata || {};

    return [
        choice?.finish_reason,
        choice?.finishReason,
        choice?.native_finish_reason,
        choice?.nativeFinishReason,
        choice?.stop_reason,
        choice?.stopReason,
        message?.finish_reason,
        message?.finishReason,
        message?.stop_reason,
        message?.stopReason,
        json.finish_reason,
        json.finishReason,
        json.native_finish_reason,
        json.nativeFinishReason,
        json.stop_reason,
        json.stopReason,
        details,
        metadata?.finish_reason,
        metadata?.finishReason,
        metadata?.stop_reason,
        metadata?.stopReason,
        candidate?.finish_reason,
        candidate?.finishReason,
        candidate?.stop_reason,
        candidate?.stopReason,
        output?.finish_reason,
        output?.finishReason,
        output?.stop_reason,
        output?.stopReason,
    ].map(normalizeFinishReason).filter(Boolean);
}

function isTokenLimitFinishReason(reason) {
    const normalized = normalizeFinishReason(reason);
    if (!normalized) return false;
    if (['length', 'max_tokens', 'max_token', 'max_completion_tokens', 'max_output_tokens', 'token_limit', 'token_limit_reached', 'length_limit', 'truncated', 'incomplete'].includes(normalized)) return true;
    return normalized.includes('max_token')
        || normalized.includes('token_limit')
        || normalized.includes('length_limit')
        || normalized.includes('output_limit');
}

function assertNotTokenLimitedResponse(cfg, json, options = {}) {
    const reason = collectFinishReasons(json).find(isTokenLimitFinishReason);
    if (!reason) return;

    const maxTokens = Math.max(1, Number(options.maxTokens || cfg.maxTokens || 8192) || 8192);
    throw new Error(`${cfg.title} provider stopped because it hit the response token limit (${reason}; max ${maxTokens}). Increase ${cfg.title} Max Tokens, reduce source messages/chunk size, or use a model/provider with a larger output limit.`);
}

function makeFinalOnlyRetryPrompts(systemPrompt, userPrompt, options = {}) {
    const expectedOutput = String(options.expectedOutput || options.outputFormat || 'json').toLowerCase();
    const wantsText = /text|plain|compression|compressed/.test(expectedOutput);
    const system = wantsText
        ? `${systemPrompt}

CRITICAL OUTPUT REQUIREMENT FOR THINKING MODELS:
- Put the final compressed text in message.content, not hidden reasoning.
- Output only the requested plain-text block.
- Do not include analysis, markdown fences, XML tags, JSON, or commentary.
- Keep the visible answer within the requested length limit.`
        : `${systemPrompt}

CRITICAL OUTPUT REQUIREMENT FOR THINKING MODELS:
- Put the final answer in message.content, not hidden reasoning.
- Output only the requested JSON object.
- Do not include analysis, markdown, XML tags, or prose.
- Keep the JSON compact and omit unchanged/empty optional fields.`;
    const user = wantsText
        ? `${userPrompt}

Return the final compressed text now in visible message.content. Do not leave message.content empty. Do not output JSON or commentary.`
        : `${userPrompt}

Return the final JSON now. The first character of your visible answer must be { and the last character must be }. Do not leave message.content empty.`;
    return { system, user };
}

function getSillyTavernContext() {
    return typeof SillyTavern !== 'undefined' ? SillyTavern.getContext?.() : null;
}

function collectPossibleArrays(root, keys) {
    const seen = new Set();
    const visited = new Set();
    const arrays = [];
    const keySet = new Set(keys.map(k => String(k).toLowerCase()));

    function add(value) {
        if (Array.isArray(value) && !seen.has(value)) {
            seen.add(value);
            arrays.push(value);
        } else if (value && typeof value === 'object' && !Array.isArray(value)) {
            const values = Object.values(value);
            if (values.length && values.every(v => v && typeof v === 'object')) {
                if (!seen.has(value)) {
                    seen.add(value);
                    arrays.push(values);
                }
            }
        }
    }

    function visit(obj, depth = 0) {
        if (!obj || typeof obj !== 'object' || depth > 6 || visited.has(obj)) return;
        visited.add(obj);
        for (const key of keys) add(obj[key]);
        for (const [key, value] of Object.entries(obj)) {
            const lower = key.toLowerCase();
            if (keySet.has(lower) || keys.some(k => lower.includes(String(k).toLowerCase()))) add(value);
        }
        for (const value of Object.values(obj)) {
            if (value && typeof value === 'object') visit(value, depth + 1);
        }
    }
    visit(root);
    return arrays;
}
function getConnectionProfiles(ctx = getSillyTavernContext()) {
    const roots = [
        ctx,
        typeof globalThis !== 'undefined' ? globalThis.connectionManager : null,
        typeof globalThis !== 'undefined' ? globalThis.ConnectionManager : null,
        typeof globalThis !== 'undefined' ? globalThis.extension_settings : null,
        typeof globalThis !== 'undefined' ? globalThis.power_user : null,
    ];
    const arrays = roots.flatMap(root => collectPossibleArrays(root, ['connectionProfiles', 'connection_profiles', 'profileList', 'profiles', 'connectionManagerProfiles']));
    const out = [];
    const seen = new Set();
    for (const arr of arrays) {
        for (const item of arr) {
            if (!item || typeof item !== 'object') continue;
            const id = String(item.id || item.name || item.profileId || item.uuid || item.profile_id || item.label || '').trim();
            if (!id || seen.has(id)) continue;
            seen.add(id);
            out.push(item);
        }
    }
    return out;
}

export function getAvailableConnectionProfiles() {
    return getConnectionProfiles();
}

export async function loadApiKey(kind = 'lore') {
    const cfg = getProviderSettings(kind);
    const key = await loadNamedApiKey(cfg.secretName);
    if (key) cachedKeys.set(cfg.secretName, key);
    return key;
}

export function clearCachedApiKey(kind = 'lore') {
    const cfg = getProviderSettings(kind);
    cachedKeys.delete(cfg.secretName);
}

async function getApiKey(cfg) {
    const cached = cachedKeys.get(cfg.secretName);
    if (cached) return cached;
    const loaded = await loadNamedApiKey(cfg.secretName);
    if (loaded) cachedKeys.set(cfg.secretName, loaded);
    return loaded;
}

function getCachedApiKey(cfg) {
    return cachedKeys.get(cfg.secretName) || '';
}

function validateProviderShape(cfg) {
    try {
        if (cfg.provider === 'openai_compatible') {
            if (!String(cfg.openAIBaseUrl || '').trim()) {
                return { ok: false, provider: cfg.provider, kind: cfg.kind, message: `${cfg.title} OpenAI-compatible Base URL is missing.` };
            }
            if (!String(cfg.openAIModel || '').trim()) {
                return { ok: false, provider: cfg.provider, kind: cfg.kind, message: `${cfg.title} OpenAI-compatible model is missing. Type or select a model ID.` };
            }
            return { ok: true, provider: cfg.provider, kind: cfg.kind };
        }

        if (cfg.provider === 'profile') {
            if (!String(cfg.profileId || '').trim()) {
                return { ok: false, provider: cfg.provider, kind: cfg.kind, message: `No ${cfg.title.toLowerCase()} connection profile is selected.` };
            }
            const ctx = getSillyTavernContext();
            if (!ctx?.ConnectionManagerRequestService?.sendRequest) {
                return { ok: false, provider: cfg.provider, kind: cfg.kind, message: 'ConnectionManagerRequestService is unavailable in this SillyTavern session.' };
            }
            return { ok: true, provider: cfg.provider, kind: cfg.kind };
        }

        if (cfg.provider === 'st') {
            const ctx = getSillyTavernContext();
            if (!ctx || (typeof ctx.generateRaw !== 'function' && typeof ctx.generateQuietPrompt !== 'function')) {
                return { ok: false, provider: cfg.provider, kind: cfg.kind, message: 'Current SillyTavern model generation API is unavailable. Select a connection profile or OpenAI-compatible endpoint.' };
            }
            return { ok: true, provider: 'st', kind: cfg.kind };
        }

        return { ok: false, provider: cfg.provider, kind: cfg.kind, message: `Unknown ${cfg.title.toLowerCase()} provider: ${cfg.provider}` };
    } catch (e) {
        return { ok: false, provider: cfg.provider, kind: cfg.kind, message: e?.message || String(e) };
    }
}

export function validateLoreProviderConfiguration(kind = 'lore') {
    const cfg = getProviderSettings(kind);
    const shape = validateProviderShape(cfg);
    if (!shape.ok) return shape;

    if (cfg.provider === 'openai_compatible' && !getCachedApiKey(cfg) && !cfg.openAIKeySet) {
        return { ok: false, provider: cfg.provider, kind: cfg.kind, message: `${cfg.title} OpenAI-compatible API key is missing. Store an API key first.` };
    }
    return shape;
}

export async function validateLoreProviderConfigurationAsync(kind = 'lore') {
    const cfg = getProviderSettings(kind);
    const validation = validateLoreProviderConfiguration(kind);
    if (!validation.ok || cfg.provider !== 'openai_compatible') return validation;

    const key = await getApiKey(cfg);
    if (!key) {
        return {
            ok: false,
            provider: cfg.provider,
            kind: cfg.kind,
            message: `${cfg.title} OpenAI-compatible API key is stored but could not be read. Store the key again for this session.`,
        };
    }
    return validation;
}

export async function testLoreConnection(kind = 'lore') {
    const validation = await validateLoreProviderConfigurationAsync(kind);
    if (!validation.ok) throw new Error(validation.message);

    const response = await sendLoreRequest(
        'You are a connection test endpoint. Output only valid JSON.',
        'Return exactly: {"ok":true}',
        { maxTokens: 32, prefill: '', providerKind: kind },
    );

    const text = String(response || '').trim();
    if (!text) throw new Error('Connection test returned an empty response.');
    return { ok: true, provider: validation.provider, kind: validation.kind, response: text.slice(0, 300) };
}

async function buildOpenAIHeaders(cfg) {
    const headers = { 'Content-Type': 'application/json' };
    const apiKey = await getApiKey(cfg);
    if (!apiKey) throw new Error(`${cfg.title} OpenAI-compatible API key is unavailable. Store the key again for this session.`);
    headers.Authorization = `Bearer ${apiKey}`;
    return headers;
}

function buildOpenAIEndpoint(cfg) {
    return normalizeOpenAIChatEndpoint(cfg.openAIBaseUrl);
}

async function sendViaOpenAICompatible(cfg, systemPrompt, userPrompt, options = {}) {
    const endpoint = buildOpenAIEndpoint(cfg);
    const headers = await buildOpenAIHeaders(cfg);

    const requestBody = {
        model: cfg.openAIModel,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
        temperature: Number(cfg.temperature ?? 0.7),
        top_p: Number(cfg.topP ?? 0.98),
        max_tokens: Number(options.maxTokens || cfg.maxTokens || 8192),
        stream: false,
    };

    async function post(body) {
        if (options.signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
        const response = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            credentials: 'omit',
            signal: options.signal,
        });
        const text = await response.text().catch(() => '');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (_) {}
        return { response, text, json };
    }

    let attempt = await post(requestBody);

    if (!attempt.response.ok && /max_tokens/i.test(attempt.text)) {
        requestBody.max_completion_tokens = requestBody.max_tokens;
        delete requestBody.max_tokens;
        attempt = await post(requestBody);
    }

    if (!attempt.response.ok && /temperature|top_p/i.test(attempt.text)) {
        delete requestBody.temperature;
        delete requestBody.top_p;
        attempt = await post(requestBody);
    }

    if (!attempt.response.ok) {
        if (attempt.response.status === 401) throw new Error(`${cfg.title} OpenAI-compatible endpoint returned 401. Check API key.`);
        throw new Error(`${cfg.title} OpenAI request failed (${attempt.response.status}): ${attempt.text.slice(0, 500)}`);
    }

    assertNotTokenLimitedResponse(cfg, attempt.json, options);

    let content = extractChatCompletionText(attempt.json);
    if (!content || !content.trim()) {
        const reasoning = extractChatCompletionReasoning(attempt.json);
        if (reasoning && reasoning.trim()) {
            const retryPrompts = makeFinalOnlyRetryPrompts(systemPrompt, userPrompt, options);
            const retryBody = {
                ...requestBody,
                messages: [
                    { role: 'system', content: retryPrompts.system },
                    { role: 'user', content: retryPrompts.user },
                ],
                temperature: Math.min(Number(requestBody.temperature ?? 0.2), 0.2),
                top_p: Math.min(Number(requestBody.top_p ?? 0.9), 0.9),
                // Thinking/reasoning models can consume the entire response budget in hidden reasoning.
                // On the final-only retry, ask compatible providers to minimize reasoning. If rejected,
                // the request is retried again without this field below.
                reasoning_effort: 'low',
            };
            const originalMax = Number(requestBody.max_tokens || requestBody.max_completion_tokens || options.maxTokens || cfg.maxTokens || 8192);
            const expandedMax = Math.max(originalMax * 2, 8192);
            if (requestBody.max_completion_tokens !== undefined) retryBody.max_completion_tokens = Math.min(8192, expandedMax);
            else retryBody.max_tokens = Math.min(8192, expandedMax);

            let retry = await post(retryBody);
            if (!retry.response.ok && /reasoning_effort/i.test(retry.text)) {
                delete retryBody.reasoning_effort;
                retry = await post(retryBody);
            }
            if (retry.response.ok) {
                assertNotTokenLimitedResponse(cfg, retry.json, { ...options, maxTokens: Number(retryBody.max_tokens || retryBody.max_completion_tokens || options.maxTokens || cfg.maxTokens || 8192) });
                content = extractChatCompletionText(retry.json);
                if (content && content.trim()) return content;
            }
            throw new Error(`${cfg.title} OpenAI-compatible endpoint returned reasoning-only output with empty message.content. Retried with final-only visible-output instructions but still received no visible content. Use a non-thinking model, raise max tokens, or lower the model's reasoning effort. Reasoning preview: ${reasoning.slice(0, 300)}`);
        }
        throw new Error(`${cfg.title} OpenAI-compatible endpoint returned empty content. Raw response: ${attempt.text.slice(0, 300)}`);
    }
    return content;
}

async function sendViaSillyTavernRaw(cfg, systemPrompt, userPrompt, options = {}) {
    if (options.signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
    const ctx = getSillyTavernContext();

    let lastResult = '';
    let reasoningPreview = '';
    const responseLength = options.maxTokens || cfg.maxTokens;

    async function tryGenerateRaw(sp, up, lengthMultiplier = 1) {
        if (typeof ctx?.generateRaw !== 'function') return '';
        if (options.signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
        const result = await ctx.generateRaw({
            systemPrompt: sp,
            prompt: up,
            prefill: options.prefill || '',
            responseLength: Math.max(128, Math.min(8192, Math.ceil(Number(responseLength || 8192) * lengthMultiplier))),
            bypassAll: true,
        });
        if (result && typeof result === 'object') {
            assertNotTokenLimitedResponse(cfg, result, { ...options, maxTokens: Math.max(128, Math.min(8192, Math.ceil(Number(responseLength || 8192) * lengthMultiplier))) });
        }
        const content = typeof result === 'string' ? result : extractChatCompletionText(result);
        if (content && content.trim()) return content;
        const reasoning = result && typeof result === 'object' ? extractChatCompletionReasoning(result) : '';
        if (reasoning) reasoningPreview = reasoning;
        return '';
    }

    lastResult = await tryGenerateRaw(systemPrompt, userPrompt, 1);
    if (lastResult && lastResult.trim()) return lastResult;

    if (reasoningPreview) {
        const retryPrompts = makeFinalOnlyRetryPrompts(systemPrompt, userPrompt, options);
        lastResult = await tryGenerateRaw(retryPrompts.system, retryPrompts.user, 2);
        if (lastResult && lastResult.trim()) return lastResult;
    }

    if (typeof ctx?.generateQuietPrompt === 'function') {
        const prompts = reasoningPreview ? makeFinalOnlyRetryPrompts(systemPrompt, userPrompt, options) : { system: systemPrompt, user: userPrompt };
        const quietPrompt = `${prompts.system}\n\n${prompts.user}`;
        let result = await ctx.generateQuietPrompt({ quietPrompt });
        if (result && typeof result === 'object') assertNotTokenLimitedResponse(cfg, result, options);
        lastResult = typeof result === 'string' ? result : extractChatCompletionText(result);
        if (lastResult && lastResult.trim()) return lastResult;

        // Older SillyTavern builds accept a raw string instead of an object.
        result = await ctx.generateQuietPrompt(quietPrompt);
        if (result && typeof result === 'object') assertNotTokenLimitedResponse(cfg, result, options);
        lastResult = typeof result === 'string' ? result : extractChatCompletionText(result);
        if (lastResult && lastResult.trim()) return lastResult;
    }

    if (reasoningPreview) {
        throw new Error(`${cfg.title} provider returned reasoning-only output with empty visible content. Retried with final-only visible-output instructions but still received no visible content. Increase max tokens, reduce reasoning effort, or use a non-thinking model. Reasoning preview: ${reasoningPreview.slice(0, 300)}`);
    }

    if (typeof ctx?.generateRaw === 'function' || typeof ctx?.generateQuietPrompt === 'function') {
        return '';
    }

    throw new Error('No SillyTavern raw generation API available.');
}

async function sendViaConnectionProfile(cfg, systemPrompt, userPrompt, options = {}) {
    if (options.signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
    const ctx = getSillyTavernContext();
    const service = ctx?.ConnectionManagerRequestService;
    if (!cfg.profileId) throw new Error(`${cfg.title} profile is not selected.`);
    if (!service || typeof service.sendRequest !== 'function') throw new Error('ConnectionManagerRequestService unavailable.');

    async function send(messages, lengthMultiplier = 1) {
        return await service.sendRequest(
            cfg.profileId,
            messages,
            Math.max(128, Math.min(8192, Math.ceil(Number(options.maxTokens || cfg.maxTokens || 8192) * lengthMultiplier))),
            {
                stream: false,
                extractData: true,
                includePreset: true,
                includeInstruct: true,
                // Do not force reasoning_effort here. Some providers/profiles, especially DeepSeek-compatible
                // endpoints, reject unsupported values. If a SillyTavern connection profile itself sends
                // reasoning_effort:'auto', fix that profile/preset or use Wandlight's direct OpenAI-compatible provider.
            },
        );
    }

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ];

    let raw = await send(messages, 1);
    if (options.signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
    if (raw && typeof raw === 'object') assertNotTokenLimitedResponse(cfg, raw, options);
    let content = typeof raw === 'string' ? raw : extractChatCompletionText(raw);
    if (content && content.trim()) return content;

    const reasoning = raw && typeof raw === 'object' ? extractChatCompletionReasoning(raw) : '';
    if (reasoning) {
        const retryPrompts = makeFinalOnlyRetryPrompts(systemPrompt, userPrompt, options);
        raw = await send([
            { role: 'system', content: retryPrompts.system },
            { role: 'user', content: retryPrompts.user },
        ], 2);
        if (options.signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
        if (raw && typeof raw === 'object') assertNotTokenLimitedResponse(cfg, raw, { ...options, maxTokens: Math.max(128, Math.min(8192, Math.ceil(Number(options.maxTokens || cfg.maxTokens || 8192) * 2))) });
        content = typeof raw === 'string' ? raw : extractChatCompletionText(raw);
        if (content && content.trim()) return content;
        throw new Error(`${cfg.title} connection profile returned reasoning-only output with empty visible content. Retried with final-only visible-output instructions but still received no visible content. Increase max tokens, reduce reasoning effort in the profile/preset, or use a non-thinking model. Reasoning preview: ${reasoning.slice(0, 300)}`);
    }
    return content;
}

export async function fetchLoreModels(kind = 'lore') {
    const cfg = getProviderSettings(kind);
    if (cfg.provider === 'openai_compatible') {
        const validation = await validateLoreProviderConfigurationAsync(cfg.kind);
        if (!validation.ok) throw new Error(validation.message);
        return await fetchOpenAICompatibleModels(cfg);
    }
    if (cfg.provider === 'profile') return fetchProfileModels(cfg);
    return fetchSTModel();
}

async function fetchOpenAICompatibleModels(cfg) {
    const baseUrl = normalizeOpenAIBaseUrl(cfg.openAIBaseUrl);
    let modelsUrl = `${baseUrl}/models`;
    const headers = await buildOpenAIHeaders(cfg);

    const response = await fetch(modelsUrl, { method: 'GET', headers, credentials: 'omit' });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Failed to fetch ${cfg.title.toLowerCase()} models (${response.status}): ${text.slice(0, 300)}`);
    }

    const json = await response.json();
    const models = json?.data || json?.models || [];
    return models.map(m => ({ id: m.id || m.name || '', name: m.name || m.id || '' })).filter(m => m.id);
}

function fetchProfileModels(cfg) {
    const profiles = getConnectionProfiles();
    const profile = profiles.find(p => String(p.id || p.name || p.profileId || p.uuid || '') === cfg.profileId);
    if (!profile) return [{ id: 'unknown', name: cfg.profileId || 'Unknown profile' }];
    return [{ id: profile.model || profile.modelName || profile.name || 'unknown', name: profile.name || cfg.profileId }];
}

function fetchSTModel() {
    const ctx = getSillyTavernContext();
    const modelName = ctx?.onlineApiModel || ctx?.model || ctx?.mainApi || 'Current ST model';
    return [{ id: modelName, name: modelName }];
}

export async function sendLoreRequest(systemPrompt, userPrompt, options = {}) {
    const cfg = getProviderSettings(options.providerKind || 'lore');
    const validation = await validateLoreProviderConfigurationAsync(cfg.kind);
    if (!validation.ok) throw new Error(validation.message);

    if (cfg.provider === 'openai_compatible') return await sendViaOpenAICompatible(cfg, systemPrompt, userPrompt, options);
    if (cfg.provider === 'profile') return await sendViaConnectionProfile(cfg, systemPrompt, userPrompt, options);
    return await sendViaSillyTavernRaw(cfg, systemPrompt, userPrompt, options);
}
