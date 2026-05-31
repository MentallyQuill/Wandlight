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
        openAIUseJsonMode: settings[`${prefix}OpenAIUseJsonMode`] !== false,
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

function extractChatCompletionText(json) {
    return json?.choices?.[0]?.message?.content
        ?? json?.choices?.[0]?.text
        ?? json?.message?.content
        ?? json?.content
        ?? '';
}

function getSillyTavernContext() {
    return typeof SillyTavern !== 'undefined' ? SillyTavern.getContext?.() : null;
}

function collectPossibleArrays(root, keys) {
    const seen = new Set();
    const arrays = [];
    function add(value) {
        if (Array.isArray(value) && !seen.has(value)) {
            seen.add(value);
            arrays.push(value);
        }
    }
    function visit(obj, depth = 0) {
        if (!obj || typeof obj !== 'object' || depth > 3) return;
        for (const key of keys) add(obj[key]);
        for (const value of Object.values(obj)) {
            if (value && typeof value === 'object') visit(value, depth + 1);
        }
    }
    visit(root);
    return arrays;
}

function getConnectionProfiles(ctx = getSillyTavernContext()) {
    const arrays = collectPossibleArrays(ctx, ['connectionProfiles', 'profiles', 'profileList']);
    const out = [];
    const seen = new Set();
    for (const arr of arrays) {
        for (const item of arr) {
            if (!item || typeof item !== 'object') continue;
            const id = String(item.id || item.name || item.profileId || item.uuid || '').trim();
            if (!id || seen.has(id)) continue;
            seen.add(id);
            out.push(item);
        }
    }
    return out;
}

function getCompletionPresets(ctx = getSillyTavernContext()) {
    const arrays = collectPossibleArrays(ctx, ['completionPresets', 'presets', 'presetList']);
    const out = [];
    const seen = new Set();
    for (const arr of arrays) {
        for (const item of arr) {
            if (!item || typeof item !== 'object') continue;
            const id = String(item.name || item.id || item.presetId || '').trim();
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

    let response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        credentials: 'omit',
    });

    if (!response.ok && cfg.openAIUseJsonMode) {
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
            throw new Error(`${cfg.title} OpenAI request failed (${response.status}): ${text.slice(0, 300)}`);
        }
    }

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        if (response.status === 401) throw new Error(`${cfg.title} OpenAI-compatible endpoint returned 401. Check API key.`);
        throw new Error(`${cfg.title} OpenAI request failed (${response.status}): ${text.slice(0, 300)}`);
    }

    const json = await response.json();
    const content = extractChatCompletionText(json);
    if (!content || !content.trim()) throw new Error(`${cfg.title} OpenAI-compatible endpoint returned empty content.`);
    return content;
}

async function sendViaSillyTavernRaw(cfg, systemPrompt, userPrompt, options = {}) {
    const ctx = getSillyTavernContext();

    if (typeof ctx?.generateRaw === 'function') {
        const result = await ctx.generateRaw({
            systemPrompt,
            prompt: userPrompt,
            prefill: options.prefill || '',
            responseLength: options.maxTokens || cfg.maxTokens,
            bypassAll: true,
        });
        return typeof result === 'string' ? result : '';
    }

    if (typeof ctx?.generateQuietPrompt === 'function') {
        const result = await ctx.generateQuietPrompt({ quietPrompt: `${systemPrompt}\n\n${userPrompt}` });
        return typeof result === 'string' ? result : '';
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
            includePreset: true,
            includeInstruct: true,
            preset: cfg.completionPresetId || undefined,
            completionPreset: cfg.completionPresetId || undefined,
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
