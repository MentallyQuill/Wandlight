/**
 * secure-keyring.js — Wandlight
 * Best-effort secret storage for direct browser-side API calls.
 *
 * Security model:
 * - When WebCrypto is available, API keys are encrypted with AES-GCM.
 * - The encryption key is derived from a session passphrase via PBKDF2.
 * - When WebCrypto is unavailable, Wandlight uses compatibility storage so
 *   remote HTTP/LAN browser sessions can still save keys. This is not strong
 *   encryption; prefer HTTPS/localhost or a SillyTavern connection profile.
 * - Decrypted keys live only in memory.
 * - This does NOT protect against malicious scripts running in the same browser.
 * - For strongest security, use a SillyTavern connection profile or backend proxy.
 *
 * Exports: encryptAndStoreSecret, unlockSecret, decryptSecretIfAvailable,
 *          clearSecretFromMemory, clearStoredSecret
 * Imported by: index.js (via ui.js API key controls)
 */

import { getSettings, saveSettings } from './state-manager.js';

const memoryKeys = new Map();
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const AES_GCM_CIPHER = 'aes-gcm';
const COMPAT_CIPHER = 'compat-v1';

// ── Internal helpers ────────────────────────────────────────────────────────────

function bytesToBase64(bytes) {
    return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function base64ToBytes(base64) {
    return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

function getWebCrypto() {
    const cryptoApi = globalThis?.crypto;
    return cryptoApi?.subtle && typeof cryptoApi.getRandomValues === 'function' ? cryptoApi : null;
}

function getRandomBytes(length) {
    const bytes = new Uint8Array(length);
    const cryptoApi = globalThis?.crypto;
    if (typeof cryptoApi?.getRandomValues === 'function') {
        cryptoApi.getRandomValues(bytes);
        return bytes;
    }
    for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = Math.floor(Math.random() * 256);
    }
    return bytes;
}

function fnv1a32(value) {
    let hash = 0x811c9dc5;
    const text = String(value || '');
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
}

function nextXorshift32(seed) {
    let x = seed >>> 0;
    x ^= (x << 13) >>> 0;
    x ^= x >>> 17;
    x ^= (x << 5) >>> 0;
    return x >>> 0;
}

function compatTransformBytes(bytes, passphrase, saltBase64, ivBase64) {
    const seedMaterial = `${passphrase}|${saltBase64}|${ivBase64}|wandlight-keyring-compat-v1`;
    let state = fnv1a32(seedMaterial) || 0x9e3779b9;
    const out = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i += 1) {
        state = nextXorshift32(state);
        out[i] = bytes[i] ^ (state & 0xff);
    }
    return out;
}

function compatEncryptSecret(plaintext, passphrase, saltBase64, ivBase64) {
    const plaintextBytes = textEncoder.encode(plaintext);
    return bytesToBase64(compatTransformBytes(plaintextBytes, passphrase, saltBase64, ivBase64));
}

function compatDecryptSecret(ciphertextBase64, passphrase, saltBase64, ivBase64) {
    const ciphertextBytes = base64ToBytes(ciphertextBase64);
    const plaintextBytes = compatTransformBytes(ciphertextBytes, passphrase, saltBase64, ivBase64);
    return textDecoder.decode(plaintextBytes);
}

async function deriveAesKey(passphrase, saltBase64) {
    const cryptoApi = getWebCrypto();
    if (!cryptoApi) throw new Error('WebCrypto AES-GCM is unavailable in this browser context.');
    const salt = base64ToBytes(saltBase64);

    const keyMaterial = await cryptoApi.subtle.importKey(
        'raw',
        textEncoder.encode(passphrase),
        'PBKDF2',
        false,
        ['deriveKey'],
    );

    return await cryptoApi.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt,
            iterations: 250_000,
            hash: 'SHA-256',
        },
        keyMaterial,
        {
            name: 'AES-GCM',
            length: 256,
        },
        false,
        ['encrypt', 'decrypt'],
    );
}

// ── Public API ──────────────────────────────────────────────────────────────────

/**
 * Encrypts a plaintext secret with a user passphrase and stores the
 * encrypted material (never plaintext) in extensionSettings.
 *
 * @param {string} secretName - Logical name (e.g. 'loreOpenAI') for the settings key prefix
 * @param {string} plaintext - The secret value to encrypt
 * @param {string} passphrase - User-chosen passphrase
 * @returns {Promise<boolean>} true on success
 * @throws {Error} if arguments are missing
 */
export async function encryptAndStoreSecret(secretName, plaintext, passphrase) {
    if (!plaintext || !passphrase) {
        throw new Error('Secret and passphrase are required.');
    }

    const salt = getRandomBytes(16);
    const iv = getRandomBytes(12);
    const saltBase64 = bytesToBase64(salt);
    const ivBase64 = bytesToBase64(iv);
    const cryptoApi = getWebCrypto();

    let cipher = COMPAT_CIPHER;
    let encrypted = '';
    if (cryptoApi) {
        const key = await deriveAesKey(passphrase, saltBase64);
        const ciphertext = await cryptoApi.subtle.encrypt(
            { name: 'AES-GCM', iv },
            key,
            textEncoder.encode(plaintext),
        );
        encrypted = bytesToBase64(ciphertext);
        cipher = AES_GCM_CIPHER;
    } else {
        encrypted = compatEncryptSecret(plaintext, passphrase, saltBase64, ivBase64);
    }

    const settings = getSettings();

    settings[`${secretName}Encrypted`] = encrypted;
    settings[`${secretName}Salt`] = saltBase64;
    settings[`${secretName}Iv`] = ivBase64;
    settings[`${secretName}Cipher`] = cipher;
    settings[`${secretName}KeySet`] = true;

    // Never store plaintext.
    delete settings[`${secretName}Plaintext`];

    saveSettings(settings);

    memoryKeys.set(secretName, plaintext);
    return { ok: true, encryptedAtRest: cipher === AES_GCM_CIPHER, cipher };
}

/**
 * Decrypts a stored secret using the user's passphrase and loads it into
 * the in-memory key cache.
 *
 * @param {string} secretName - Logical name matching the stored settings prefix
 * @param {string} passphrase - User passphrase used during encryption
 * @returns {Promise<boolean>} true on success
 * @throws {Error} if no encrypted material is stored or decryption fails
 */
export async function unlockSecret(secretName, passphrase) {
    const settings = getSettings();

    const encrypted = settings[`${secretName}Encrypted`];
    const salt = settings[`${secretName}Salt`];
    const iv = settings[`${secretName}Iv`];
    const cipher = settings[`${secretName}Cipher`] || AES_GCM_CIPHER;

    if (!encrypted || !salt || !iv) {
        throw new Error('No encrypted secret is stored.');
    }

    let plaintext = '';
    if (cipher === COMPAT_CIPHER) {
        plaintext = compatDecryptSecret(encrypted, passphrase, salt, iv);
    } else {
        const cryptoApi = getWebCrypto();
        if (!cryptoApi) throw new Error('WebCrypto AES-GCM is unavailable in this browser context.');
        const key = await deriveAesKey(passphrase, salt);

        const plaintextBytes = await cryptoApi.subtle.decrypt(
            { name: 'AES-GCM', iv: base64ToBytes(iv) },
            key,
            base64ToBytes(encrypted),
        );
        plaintext = textDecoder.decode(plaintextBytes);
    }

    memoryKeys.set(secretName, plaintext);

    return true;
}

/**
 * Returns the in-memory (decrypted) secret, or an empty string if not yet unlocked.
 * This does NOT return the stored ciphertext — it only returns a key that has been
 * unlocked during the current session.
 *
 * @param {string} secretName - Logical key name
 * @returns {string} decrypted secret or ''
 */
export async function decryptSecretIfAvailable(secretName) {
    return memoryKeys.get(secretName) || '';
}

/**
 * Removes a secret from the in-memory cache only. Encrypted material stays in
 * extensionSettings for future sessions.
 *
 * @param {string} secretName - Logical key name
 */
export function clearSecretFromMemory(secretName) {
    memoryKeys.delete(secretName);
}

/**
 * Permanently removes both the encrypted material from extensionSettings and
 * the in-memory copy.
 *
 * @param {string} secretName - Logical key name
 */
export function clearStoredSecret(secretName) {
    const settings = getSettings();

    delete settings[`${secretName}Encrypted`];
    delete settings[`${secretName}Salt`];
    delete settings[`${secretName}Iv`];
    delete settings[`${secretName}Cipher`];
    delete settings[`${secretName}KeySet`];

    memoryKeys.delete(secretName);
    saveSettings(settings);
}

// ── Convenience wrappers for Wandlight OpenAI-compatible API keys ───────────────

const LORE_KEY_NAME = 'loreOpenAI';
const CONTINUITY_KEY_NAME = 'continuityOpenAI';

/**
 * Derives a browser-session-scoped passphrase from the SillyTavern context.
 * This is NOT intended as strong security — it merely keeps the key from
 * being stored as plaintext in localStorage/settings. The keyring's
 * security model doc (top of this file) already acknowledges this limitation.
 *
 * The derived value is session-stable (same across reloads within one page
 * load) but not user-specific. For production use, a connection profile or
 * backend proxy should be preferred.
 *
 * @returns {string} derived passphrase
 */
function deriveSessionPassphrase() {
    try {
        // Use a stable session id + extension key as derivation material
        const ctx = SillyTavern?.getContext();
        const sessionId = ctx?.mainApi || ctx?.chatId || ctx?.characterId || 'wandlight';
        return 'wandlight-lore-key-v1-' + String(sessionId);
    } catch (_) {
        return 'wandlight-lore-key-v1-default';
    }
}


export async function loadNamedApiKey(secretName) {
    const settings = getSettings();
    const isStored = settings[`${secretName}KeySet`];
    if (!isStored) return '';

    const cached = await decryptSecretIfAvailable(secretName);
    if (cached) return cached;

    try {
        await unlockSecret(secretName, deriveSessionPassphrase());
        return await decryptSecretIfAvailable(secretName);
    } catch (_) {
        return '';
    }
}

export async function storeNamedApiKey(secretName, plaintext) {
    return await encryptAndStoreSecret(secretName, plaintext, deriveSessionPassphrase());
}

export function getNamedApiKeyStorageInfo(secretName) {
    const settings = getSettings();
    const isStored = !!settings[`${secretName}KeySet`];
    const cipher = settings[`${secretName}Cipher`] || (isStored ? AES_GCM_CIPHER : '');
    return {
        isStored,
        cipher,
        encryptedAtRest: isStored && cipher !== COMPAT_CIPHER,
        webCryptoAvailable: !!getWebCrypto(),
        compatibilityStorage: isStored && cipher === COMPAT_CIPHER,
    };
}

export async function deleteNamedApiKey(secretName) {
    clearStoredSecret(secretName);
}

/**
 * Retrieves the decrypted lore API key, auto-unlocking with the session
 * passphrase if stored but not yet in memory.
 * @returns {Promise<string>} decrypted key or ''
 */
export async function loadApiKey() {
    return await loadNamedApiKey(LORE_KEY_NAME);
}

/**
 * Encrypts and stores the lore API key using the session-derived passphrase.
 * @param {string} plaintext - The API key to store
 * @returns {Promise<boolean>}
 */
export async function storeApiKey(plaintext) {
    return await storeNamedApiKey(LORE_KEY_NAME, plaintext);
}

/**
 * Permanently removes the stored lore API key (both encrypted settings and memory).
 */
export async function deleteApiKey() {
    await deleteNamedApiKey(LORE_KEY_NAME);
}

export async function loadContinuityApiKey() {
    return await loadNamedApiKey(CONTINUITY_KEY_NAME);
}

export async function storeContinuityApiKey(plaintext) {
    return await storeNamedApiKey(CONTINUITY_KEY_NAME, plaintext);
}

export async function deleteContinuityApiKey() {
    await deleteNamedApiKey(CONTINUITY_KEY_NAME);
}
