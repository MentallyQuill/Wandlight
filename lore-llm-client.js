/**
 * lore-llm-client.js — Wandlight Continuity
 * Provider abstraction for continuity scanning, lore context detection, and lore generation.
 *
 * Provider kinds:
 *   continuity — Scan Continuity State / automatic continuity tracking
 *   lore       — Detect Story Context / Generate Pending Lore
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
    const title = k === 'continuity' ? 'Continuity' : 'Lore';

    return {
        kind: k,
        title,
        provider: settings[`${prefix}Provider`] || 'st',
        profileId: settings[`${prefix}ProfileId`] || '',
        completionPresetId: settings[`${prefix}CompletionPresetId`] || '',
        openAIBaseUrl: settings[`${prefix}OpenAIBaseUrl`] || '',
        openAIModel: settings[`${prefix}OpenAIModel`] || '',
        openAIKeySet: !!settings[`${prefix}OpenAIKeySet`],
        openAIUseJsonMode: settings[`${prefix}OpenAIUseJsonMode`] === true,
        openAIUseSTProxy: !!settings[`${prefix}OpenAIUseSTProxy`],
        temperature: Number(settings[`${prefix}Temperature`] ?? 0.7),
        topP: Number(settings[`${prefix}TopP`] ?? 0.98),
        maxTokens: Number(settings[`${prefix}MaxTokens`] || (k === 'continuity' ? 1024 : 2048)),
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

function makeFinalOnlyRetryPrompts(systemPrompt, userPrompt) {
    const system = `${systemPrompt}\n\nCRITICAL OUTPUT REQUIREMENT FOR THINKING MODELS:\n- Put the final answer in message.content, not hidden reasoning.\n- Output only the requested JSON object.\n- Do not include analysis, markdown, XML tags, or prose.\n- Keep the JSON compact and omit unchanged/empty optional fields.`;
    const user = `${userPrompt}\n\nReturn the final JSON now. The first character of your visible answer must be { and the last character must be }. Do not leave message.content empty.`;
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

function getCompletionPresets(ctx = getSillyTavernContext()) {
    const roots = [
        ctx,
        typeof globalThis !== 'undefined' ? globalThis.extension_settings : null,
        typeof globalThis !== 'undefined' ? globalThis.power_user : null,
        typeof globalThis !== 'undefined' ? globalThis.kai_settings : null,
        typeof globalThis !== 'undefined' ? globalThis.textgenerationwebui_settings : null,
    ];
    const arrays = roots.flatMap(root => collectPossibleArrays(root, ['completionPresets', 'completion_presets', 'presetList', 'presets', 'kai_settings', 'textgenerationwebui_presets']));
    const out = [];
    const seen = new Set();
    for (const arr of arrays) {
        for (const item of arr) {
            if (!item || typeof item !== 'object') continue;
            const id = String(item.name || item.id || item.presetId || item.preset_id || item.filename || item.label || '').trim();
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

export function getAvailableCompletionPresets() {
    return getCompletionPresets();
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

export function validateLoreProviderConfiguration(kind = 'lore') {
    const cfg = getProviderSettings(kind);

    try {
        if (cfg.provider === 'openai_compatible') {
            if (!String(cfg.openAIBaseUrl || '').trim()) {
                return { ok: false, provider: cfg.provider, kind: cfg.kind, message: `${cfg.title} OpenAI-compatible Base URL is missing.` };
            }
            if (!String(cfg.openAIModel || '').trim()) {
                return { ok: false, provider: cfg.provider, kind: cfg.kind, message: `${cfg.title} OpenAI-compatible model is missing. Type or select a model ID.` };
            }
            if (!cfg.openAIUseSTProxy && !getCachedApiKey(cfg) && !cfg.openAIKeySet) {
                return { ok: false, provider: cfg.provider, kind: cfg.kind, message: `${cfg.title} OpenAI-compatible API key is missing. Store an API key or enable an ST proxy.` };
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

export async function testLoreConnection(kind = 'lore') {
    const validation = validateLoreProviderConfiguration(kind);
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
    if (cfg.openAIUseSTProxy) return { 'Content-Type': 'application/json' };
    const headers = { 'Content-Type': 'application/json' };
    const apiKey = await getApiKey(cfg);
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    return headers;
}

function buildOpenAIEndpoint(cfg) {
    if (cfg.openAIUseSTProxy) {
        try {
            const ctx = getSillyTavernContext();
            const proxyUrl = ctx?.openaiProxyUrl;
            if (proxyUrl) return normalizeOpenAIChatEndpoint(proxyUrl);
        } catch (_) {}
    }
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
        max_tokens: Number(options.maxTokens || cfg.maxTokens || 2048),
        stream: false,
    };

    if (cfg.openAIUseJsonMode) requestBody.response_format = { type: 'json_object' };

    async function post(body) {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            credentials: 'omit',
        });
        const text = await response.text().catch(() => '');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (_) {}
        return { response, text, json };
    }

    let attempt = await post(requestBody);

    if (!attempt.response.ok && requestBody.response_format && /response_format|json_object/i.test(attempt.text)) {
        delete requestBody.response_format;
        attempt = await post(requestBody);
    }

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

    let content = extractChatCompletionText(attempt.json);
    if (!content || !content.trim()) {
        const reasoning = extractChatCompletionReasoning(attempt.json);
        if (reasoning && reasoning.trim()) {
            const retryPrompts = makeFinalOnlyRetryPrompts(systemPrompt, userPrompt);
            const retryBody = {
                ...requestBody,
                messages: [
                    { role: 'system', content: retryPrompts.system },
                    { role: 'user', content: retryPrompts.user },
                ],
                temperature: Math.min(Number(requestBody.temperature ?? 0.2), 0.2),
                top_p: Math.min(Number(requestBody.top_p ?? 0.9), 0.9),
            };
            const originalMax = Number(requestBody.max_tokens || requestBody.max_completion_tokens || options.maxTokens || cfg.maxTokens || 2048);
            const expandedMax = Math.max(originalMax * 2, cfg.kind === 'continuity' ? 4096 : 2048);
            if (requestBody.max_completion_tokens !== undefined) retryBody.max_completion_tokens = Math.min(8192, expandedMax);
            else retryBody.max_tokens = Math.min(8192, expandedMax);

            let retry = await post(retryBody);
            if (!retry.response.ok && retryBody.response_format && /response_format|json_object/i.test(retry.text)) {
                delete retryBody.response_format;
                retry = await post(retryBody);
            }
            if (retry.response.ok) {
                content = extractChatCompletionText(retry.json);
                if (content && content.trim()) return content;
            }
            throw new Error(`${cfg.title} OpenAI-compatible endpoint returned reasoning-only output with empty message.content. Retried with final-only JSON instructions but still received no visible content. Use a non-thinking model, raise max tokens, or lower the model's reasoning effort. Reasoning preview: ${reasoning.slice(0, 300)}`);
        }
        throw new Error(`${cfg.title} OpenAI-compatible endpoint returned empty content. Raw response: ${attempt.text.slice(0, 300)}`);
    }
    return content;
}

async function sendViaSillyTavernRaw(cfg, systemPrompt, userPrompt, options = {}) {
    const ctx = getSillyTavernContext();

    let lastResult = '';

    if (typeof ctx?.generateRaw === 'function') {
        const result = await ctx.generateRaw({
            systemPrompt,
            prompt: userPrompt,
            prefill: options.prefill || '',
            responseLength: options.maxTokens || cfg.maxTokens,
            bypassAll: true,
        });
        lastResult = typeof result === 'string' ? result : extractChatCompletionText(result);
        if (lastResult && lastResult.trim()) return lastResult;
        if (result && typeof result === 'object' && extractChatCompletionReasoning(result)) {
            throw new Error(`${cfg.title} provider returned reasoning-only output with empty visible content. Increase max tokens or use a non-thinking model for extraction.`);
        }
    }

    if (typeof ctx?.generateQuietPrompt === 'function') {
        const quietPrompt = `${systemPrompt}\n\n${userPrompt}`;
        let result = await ctx.generateQuietPrompt({ quietPrompt });
        lastResult = typeof result === 'string' ? result : extractChatCompletionText(result);
        if (lastResult && lastResult.trim()) return lastResult;

        // Older SillyTavern builds accept a raw string instead of an object.
        result = await ctx.generateQuietPrompt(quietPrompt);
        lastResult = typeof result === 'string' ? result : extractChatCompletionText(result);
        if (lastResult && lastResult.trim()) return lastResult;
    }

    if (typeof ctx?.generateRaw === 'function' || typeof ctx?.generateQuietPrompt === 'function') {
        return '';
    }

    throw new Error('No SillyTavern raw generation API available.');
}

async function sendViaConnectionProfile(cfg, systemPrompt, userPrompt, options = {}) {
    const ctx = getSillyTavernContext();
    const service = ctx?.ConnectionManagerRequestService;
    if (!cfg.profileId) throw new Error(`${cfg.title} profile is not selected.`);
    if (!service || typeof service.sendRequest !== 'function') throw new Error('ConnectionManagerRequestService unavailable.');

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ];

    const raw = await service.sendRequest(
        cfg.profileId,
        messages,
        Number(options.maxTokens || cfg.maxTokens || 2048),
        {
            stream: false,
            extractData: true,
            includePreset: !!cfg.completionPresetId,
            includeInstruct: true,
            preset: cfg.completionPresetId || undefined,
            completionPreset: cfg.completionPresetId || undefined,
            // Do not force reasoning_effort here. Some providers/profiles, especially DeepSeek-compatible
            // endpoints, reject unsupported values. If a SillyTavern connection profile itself sends
            // reasoning_effort:'auto', fix that profile/preset or use Wandlight's direct OpenAI-compatible provider.
        },
    );

    const content = typeof raw === 'string' ? raw : extractChatCompletionText(raw);
    if (content && content.trim()) return content;
    if (raw && typeof raw === 'object' && extractChatCompletionReasoning(raw)) {
        throw new Error(`${cfg.title} connection profile returned reasoning-only output with empty visible content. Increase max tokens, reduce reasoning effort in the profile/preset, or use a non-thinking model for extraction.`);
    }
    return content;
}

export async function fetchLoreModels(kind = 'lore') {
    const cfg = getProviderSettings(kind);
    if (cfg.provider === 'openai_compatible') return await fetchOpenAICompatibleModels(cfg);
    if (cfg.provider === 'profile') return fetchProfileModels(cfg);
    return fetchSTModel();
}

async function fetchOpenAICompatibleModels(cfg) {
    const baseUrl = normalizeOpenAIBaseUrl(cfg.openAIBaseUrl);
    let modelsUrl = `${baseUrl}/models`;
    const headers = await buildOpenAIHeaders(cfg);

    if (cfg.openAIUseSTProxy) {
        try {
            const ctx = getSillyTavernContext();
            const proxyUrl = ctx?.openaiProxyUrl;
            if (proxyUrl) modelsUrl = `${normalizeOpenAIBaseUrl(proxyUrl)}/models`;
        } catch (_) {}
    }

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
    const validation = validateLoreProviderConfiguration(cfg.kind);
    if (!validation.ok) throw new Error(validation.message);

    if (cfg.provider === 'openai_compatible') return await sendViaOpenAICompatible(cfg, systemPrompt, userPrompt, options);
    if (cfg.provider === 'profile') return await sendViaConnectionProfile(cfg, systemPrompt, userPrompt, options);
    return await sendViaSillyTavernRaw(cfg, systemPrompt, userPrompt, options);
}
