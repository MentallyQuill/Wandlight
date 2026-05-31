/**
 * constants.js — Wandlight Continuity
 * Module key, default state object, default settings, extraction prompt template,
 * lore generation prompts, and logging prefix. No other dependencies.
 */

// ── Module key ──────────────────────────────────────────────────────────────────
export const MODULE_KEY = 'wandlight_continuity';

/**
 * The extension folder name under data/default-user/extensions/third-party/.
 * Must match the installed folder name exactly for renderExtensionTemplateAsync.
 */
export const EXTENSION_FOLDER = 'third-party/WandlightContinuity';

/**
 * Dynamically detects the actual installed extension folder from the script src.
 * Falls back to EXTENSION_FOLDER if detection fails.
 * @param {string} [fallback] - Folder to use if detection fails
 * @returns {string} The detected extension folder path
 */
export function detectExtensionFolder(fallback = EXTENSION_FOLDER) {
    try {
        const scripts = Array.from(document.querySelectorAll('script[src]'));
        // Narrow candidates: only match /third-party/.../index.js AND contain "wandlight" (case-insensitive).
        const candidates = scripts
            .map(s => s.src)
            .filter(src =>
                src.includes('/third-party/') &&
                src.endsWith('/index.js') &&
                /wandlight/i.test(src)
            );
        const src = candidates[0];
        const match = src?.match(/third-party\/([^/]+)\/index\.js/);
        if (match?.[1]) {
            return `third-party/${decodeURIComponent(match[1])}`;
        }
    } catch (_) {
        // Silently fall through
    }
    return fallback;
}

// ── Logging prefix ──────────────────────────────────────────────────────────────
export const LOG_PREFIX = '[Wandlight Continuity]';

// ── Schema version ──────────────────────────────────────────────────────────────
export const SCHEMA_VERSION = 6;

// ── Default extension settings ──────────────────────────────────────────────────
export const DEFAULT_SETTINGS = {
    enabled: true,
    injectMemo: true,
    injectContinuity: true,
    autoExtract: false,
    autoApplyDelta: false,
    extractionInterval: 1,
    maxSnapshots: 20,
    debugMode: false,

    // Runtime automation modes. These replace the old single workflow preset for new behavior.
    continuityTrackingMode: 'manual', // 'manual' | 'automatic'
    continuityAutoInterval: 5, // turns between automatic continuity scans
    contextDetectionMode: 'manual', // 'manual' | 'automatic'
    contextDetectionAutoInterval: 5,
    loreGenerationMode: 'manual', // 'manual' | 'automatic'
    loreGenerationAutoInterval: 10,

    // Lore matrix
    injectLore: true,
    maxLoreEntriesInMemo: 6,
    maxLoreEntriesInMatrix: 50,
    autoGenerateLore: false,
    workflowMode: 'manual', // legacy UI preset; explicit tab modes are authoritative

    // Lore generation behavior
    loreSourceMessageCount: 20,
    loreGenerationChunkSize: 10,
    loreReplacementGuard: true,
    loreDuplicateGuard: true,
    loreTagCount: 4,

    // Lore injection / compression
    loreInjectionMode: 'direct', // 'direct' | 'compressed'
    loreCompressionLevel: 2, // 1=minimal, 5=aggressive
    loreCompressionTurnInterval: 8,
    continuityInjectionMode: 'direct', // 'direct' | 'compressed'
    continuityCompressionLevel: 2,
    continuityEmotionDecayTurns: 6,

    // Continuity model provider: used by Scan Continuity State / automatic continuity tracking.
    continuityProvider: 'st', // 'st' | 'profile' | 'openai_compatible'
    continuityProfileId: '',
    continuityCompletionPresetId: '',
    continuityOpenAIBaseUrl: '',
    continuityOpenAIModel: '',
    continuityOpenAIKeyEncrypted: null,
    continuityOpenAIKeySalt: '',
    continuityOpenAIKeyIv: '',
    continuityOpenAIKeySet: false,
    continuityOpenAIUseJsonMode: true,
    continuityOpenAIUseSTProxy: false,
    continuityTemperature: 0.7,
    continuityTopP: 0.98,
    continuityMaxTokens: 1024,

    // Lore model provider: used by Detect Story Context / Generate Pending Lore.
    loreProvider: 'st', // 'st' | 'profile' | 'openai_compatible'
    loreProfileId: '',
    loreCompletionPresetId: '',

    // Lore OpenAI-compatible endpoint
    loreOpenAIBaseUrl: '',
    loreOpenAIModel: '',
    loreOpenAIKeyEncrypted: null,
    loreOpenAIKeySalt: '',
    loreOpenAIKeyIv: '',
    loreOpenAIKeySet: false,
    loreOpenAIUseJsonMode: true,
    loreOpenAIUseSTProxy: false,

    // Lore generation parameters (separate from main RP model settings)
    loreTemperature: 0.7,
    loreTopP: 0.98,
    loreMaxTokens: 2048,
    loreRepairOnParseFail: true,
};

// ── Default per-chat state ──────────────────────────────────────────────────────
export function getDefaultState() {
    return {
        canon: {
            era: '',
            inUniverseDate: '',
            canonBoundary: '',
            divergences: [],
        },
        continuityConfig: {
            canon: true,
            scene: true,
            characters: true,
            appearance: true,
            emotionalState: true,
            knowledge: true,
            secrets: true,
            relationships: true,
            threads: true,
            inventory: true,
            objectives: true,
            flags: true,
        },
        scene: {
            location: '',
            timeOfDay: '',
            weather: '',
            ambience: '',
            presentCharacters: [],
            nearbyCharacters: [],
            currentActivity: '',
        },
        characters: [],
        inventory: [],
        objectives: [],

        // Lore matrix (schema v2)
        loreContext: {
            sceneDate: '',
            subjectiveDate: '',
            canonBoundary: '',
            branchId: 'main',
            timeTravelMode: 'none',
            lastDetectedAt: 0,
            lastGeneratedFor: '',
            lastGenerationSummary: '',
        },
        loreMatrix: [],
        pendingLoreEntries: [],

        // Lore generation lifecycle ledger (schema v3)
        loreGeneration: {
            lastAttemptedFor: '',
            lastProposedFor: '',
            lastAcceptedFor: '',
            lastRejectedFor: '',
            lastFailedFor: '',
            lastForcePendingFor: '',
            attempts: {},
        },

        pendingLoreMeta: null,

        // Prompt injection/compression preview status
        loreCompressionStatus: {
            lastCompressedAt: 0,
            lastSignature: '',
            lastMode: 'direct',
            lastTokenEstimate: 0,
            turnsSinceCompression: 0,
            lastChatLength: 0,
        },
        continuityCompressionStatus: {
            lastCompressedAt: 0,
            lastSignature: '',
            lastMode: 'direct',
            lastTokenEstimate: 0,
            turnsSinceCompression: 0,
            lastChatLength: 0,
        },

        // Lore panel UI state (schema v4)
        lorePanel: {
            isOpen: true,
            collapsed: false,
            selectedCategory: 'all',
            search: '',
            selectedEntryId: '',
            activeTab: 'session',
            reviewSelectedIds: [],
            generationStatus: 'Idle.',
            generationProgress: 0,
            showOnlyActive: false,
            width: 420,
            height: 520,
        },

        // Lore selection (user overrides for active loring)
        loreSelection: {
            pinnedIds: [],
            suppressedIds: [],
        },

        knowledge: {},
        secrets: [],
        relationships: [],
        threads: [],
        continuityFlags: [],
        memoHistory: [],
        stateHistory: [],
        lastDelta: null,
        _version: SCHEMA_VERSION,
    };
}

// ── Extraction prompt template ──────────────────────────────────────────────────
export const EXTRACTION_SYSTEM_PROMPT = `You are the Wandlight Continuity State Extractor for a Harry Potter / Hogwarts roleplay. Your task is to read the latest roleplay messages and the current continuity state, then output a JSON delta describing only what changed.

<rules>
1. Output ONLY a valid JSON object — no markdown fences, no preamble, no commentary.
2. Only include fields that actually changed. Omit unchanged sections entirely.
3. If nothing changed, output exactly: {"summary":"No changes detected","changes":{}}
4. The JSON must follow the WandlightDelta schema exactly.
5. Character knowledge arrays should be merged (added to existing), not replaced.
6. For secrets, relationships, and threads: use "added" for new entries, "updated" for changes to existing entries (with index), "removed" for removed entries.
7. Be conservative — only flag continuity issues when there is a clear contradiction, not just ambiguity.
8. Canon era, in-universe date, and canon boundary should only change when explicitly established in the narrative.
9. Track clothing, posture, physical state, carried items, goals, emotional state, trust, affection, desire, and connection when clearly implied.
10. Emotional state should be current-state, not permanent personality. Avoid feedback loops: reduce or omit heightened emotion unless the latest messages reinforce it.
11. Numeric emotional values use -5 to +5 where 0 is neutral. Do not jump more than 2 points from the current state unless the scene explicitly justifies it.
12. Respect optional continuity sections. If a section is disabled in the current state, omit changes for that section.
</rules>

<delta_schema>
{
  "summary": "One-line description of what changed",
  "changes": {
    "canon": {
      "era": "string (canon era, e.g. Half-Blood Prince)",
      "inUniverseDate": "string (e.g. September 1, 1996)",
      "canonBoundary": "string (e.g. Through Chapter 14 of HBP)",
      "divergences": [{ "description": "string", "sinceDate": "string" }]
    },
    "scene": {
      "location": "string",
      "timeOfDay": "string",
      "weather": "string",
      "ambience": "string",
      "presentCharacters": ["string"],
      "nearbyCharacters": ["string"],
      "currentActivity": "string"
    },
    "characters": {
      "added": [{ "name": "string", "role": "string", "location": "string", "clothing": "string", "posture": "string", "physicalState": "string", "emotionalState": { "affection": 0, "trust": 0, "desire": 0, "connection": 0, "fear": 0, "anger": 0, "sadness": 0, "joy": 0, "notes": "string" }, "inventory": ["string"], "goals": ["string"] }],
      "updated": [{ "name": "string", "index": 0, "changes": {} }],
      "removed": ["string or index"]
    },
    "inventory": { "added": [{ "owner": "string", "item": "string", "status": "string", "location": "string" }], "updated": [{ "index": 0, "changes": {} }], "removed": [0] },
    "objectives": { "added": [{ "owner": "string", "goal": "string", "status": "active|blocked|completed|abandoned", "stakes": "string" }], "updated": [{ "index": 0, "changes": {} }], "removed": [0] },
    "knowledge": { "CharacterName": ["fact1", "fact2"] },
    "secrets": {
      "added": [{ "fact": "string", "trueState": "string", "whoKnows": ["string"], "whoSuspects": ["string"], "publicVersion": "string" }],
      "updated": [{ "index": 0, "changes": {} }],
      "removed": [0]
    },
    "relationships": {
      "added": [{ "pair": "string", "notes": "string", "tension": "low|medium|high|critical", "trust": "low|medium|high|absolute" }],
      "updated": [{ "index": 0, "changes": {} }],
      "removed": [0]
    },
    "threads": {
      "added": [{ "description": "string", "status": "active|dormant|resolved", "unresolvedConsequences": ["string"] }],
      "updated": [{ "index": 0, "changes": {} }]
    },
    "continuityFlags": {
      "added": [{ "type": "contradiction|uncertainty|warning", "description": "string", "severity": "low|medium|high", "timestamp": 0 }],
      "resolved": [0]
    }
  }
}
</delta_schema>

Current continuity state, including optional section settings:
{{stateJson}}

Recent roleplay messages:
{{messages}}
`;

// ── Extraction prompt (user message) ────────────────────────────────────────────
export const EXTRACTION_USER_PROMPT = `Analyze the messages above and extract any changes to the continuity state. Remember: only output fields that actually changed, in valid JSON format.`;

// ── Lore Context Detection prompt ───────────────────────────────────────────────
export const LORE_CONTEXT_DETECTION_SYSTEM_PROMPT = `You are the Wandlight Lore Context Detector for a Harry Potter / Hogwarts roleplay.

Read the current continuity state and recent messages. Infer only the story's current lore context.

Output ONLY valid JSON:
{
  "sceneDate": "string, or empty if unknown",
  "subjectiveDate": "string, or empty if same/unknown",
  "canonBoundary": "string, or empty if unknown",
  "branchId": "main|alternate|custom string",
  "timeTravelMode": "none|visitor_from_future|past_changed|alternate_branch",
  "summary": "one sentence"
}

Rules:
- Do not invent a precise date if only an era is known.
- Prefer canon boundary phrases when precise dates are unclear.
- If time travel is implied, separate sceneDate from subjectiveDate.
- Output JSON only.`;

// ── Lore Generation prompt ──────────────────────────────────────────────────────
export const LORE_GENERATION_SYSTEM_PROMPT = `You are the Wandlight Lore Matrix Generator for a Harry Potter / Hogwarts roleplay.

Generate a small set of lore entries relevant to the current story context. Do not generate a Harry Potter encyclopedia.

Prioritize:
1. Current era/date/canon boundary.
2. Present or nearby characters.
3. Current location.
4. Secrets, public misconceptions, reveal constraints.
5. Facts likely to matter in the next 10-20 turns.

Output ONLY valid JSON:
{
  "summary": "one sentence",
  "entries": [
    {
      "id": "stable_snake_case_id",
      "title": "short title",
      "tags": ["short searchable category tags"],
      "category": "canon|au|secret|rumor|lie|relationship|location|rule|timeline",
      "fact": "what is actually true or believed",
      "canonStatus": "canon|divergent|au|fanon|unknown",
      "truthStatus": "true|false|public-belief|rumor|contested|hidden",
      "validFrom": "string or empty",
      "validTo": "string or empty",
      "branchId": "main",
      "whoKnowsTruth": ["string"],
      "whoSuspects": ["string"],
      "whoBelievesPublicVersion": ["string"],
      "publicVersion": "string",
      "revealPolicy": "public|private|do_not_reveal|only_if_knower_present|only_if_user_reveals",
      "activeWhen": {
        "erasAny": ["string"],
        "locationsAny": ["string"],
        "charactersPresentAny": ["string"],
        "tagsAny": ["string"]
      },
      "priority": 50,
      "status": "active",
      "source": "model-generated",
      "userEdited": false,
      "locked": false,
      "notes": ""
    }
  ]
}

Rules:
- Give every entry the requested number of concise tags. Tags must be searchable labels, not full sentences.
- Tag schema: 1-3 words each; prefer character names, groups, locations, era/year, plot thread, secret type, relationship pair, magic system, faction, object/artifact, event, or villain/ally role.
- Good tags: "Harry", "Voldemort", "villains", "Hogwarts", "Slytherin", "1996", "secret", "relationship", "prophecy". Bad tags: full sentences or conclusions.
- Generate 4-10 entries only unless the source context is sparse.
- Prefer constraints over trivia.
- If a fact is secret in this era, include publicVersion and revealPolicy.
- Do not overwrite user-edited lore. This pass only proposes entries.
- Output JSON only.`;

// ── JSON repair prompt ──────────────────────────────────────────────────────────
export const JSON_REPAIR_SYSTEM_PROMPT = `You repair malformed JSON.

Return ONLY valid JSON.
Do not add markdown.
Do not explain.
Preserve the user's intended data.
The output must have this shape:
{
  "summary": "string",
  "entries": []
}`;

// ── Token budget for memo ───────────────────────────────────────────────────────
export const MEMO_MAX_TOKENS = 500;

// ── Lore entry limits ───────────────────────────────────────────────────────────
export const MAX_LORE_ENTRIES_IN_MEMO = 6;

// ── Character list truncation limits ────────────────────────────────────────────
export const MAX_PRESENT_CHARS_IN_MEMO = 8;
export const MAX_KNOWLEDGE_FACTS_PER_CHAR = 5;
export const MAX_ACTIVE_THREADS_IN_MEMO = 6;
export const MAX_RELATIONSHIPS_IN_MEMO = 6;
export const MAX_FLAGS_IN_MEMO = 4;