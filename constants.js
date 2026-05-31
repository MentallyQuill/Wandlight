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
export const SCHEMA_VERSION = 7;

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
    contextSourceMessageCount: 20,
    continuitySourceMessageCount: 10,

    // Lore matrix
    injectLore: true,
    maxLoreEntriesInMemo: 0, // 0 = unlimited; users control injection by muting entries
    // Accepted Lore Matrix is intentionally uncapped. UI uses paging so hundreds of entries remain usable.
    maxLoreEntriesInMatrix: 0,
    autoGenerateLore: false,
    workflowMode: 'manual', // legacy UI preset; explicit tab modes are authoritative

    // Lore generation behavior
    loreSourceMessageCount: 10,
    loreGenerationChunkSize: 10,
    loreReplacementGuard: true,
    loreDuplicateGuard: true,
    loreTagCount: 4,

    // Local canon lore database
    canonLoreDatabaseEnabled: true,
    canonLoreAutoPropose: true,
    canonLoreMaxEntries: 10,

    // Prompt injection transport / placement
    // 'extension_prompt' uses SillyTavern setExtensionPrompt with role/depth.
    // 'interceptor' preserves the legacy behavior: prepend combined memo to the last user message.
    injectionTransport: 'extension_prompt',
    continuityInjectionPosition: 1, // SillyTavern extension_prompt_types.IN_CHAT
    continuityInjectionDepth: 4,
    continuityInjectionRole: 0, // SillyTavern extension_prompt_roles.SYSTEM
    loreInjectionPosition: 1,
    loreInjectionDepth: 4,
    loreInjectionRole: 0,
    injectionPromptScan: false,

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
    continuityOpenAIUseJsonMode: false,
    continuityOpenAIUseSTProxy: false,
    continuityTemperature: 0.7,
    continuityTopP: 0.98,
    continuityMaxTokens: 4096,

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
    loreOpenAIUseJsonMode: false,
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
        canonLoreDatabase: {
            lastQueriedAt: 0,
            lastSceneDate: '',
            lastCanonBoundary: '',
            lastMatchedCount: 0,
            lastProposedCount: 0,
            lastStatus: 'Not queried.',
        },

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
            cachedText: '',
            lastError: '',
        },
        continuityCompressionStatus: {
            lastCompressedAt: 0,
            lastSignature: '',
            lastMode: 'direct',
            lastTokenEstimate: 0,
            turnsSinceCompression: 0,
            lastChatLength: 0,
            cachedText: '',
            lastError: '',
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
            pendingReviewVisibleLimit: 10,
            generationStatus: 'Idle.',
            generationProgress: 0,
            contextStatus: 'Idle.',
            contextProgress: 0,
            continuityStatus: 'Idle.',
            continuityProgress: 0,
            loreStatus: 'Idle.',
            loreProgress: 0,
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
export const EXTRACTION_SYSTEM_PROMPT = `You are the Wandlight Continuity State Extractor for a Harry Potter / Hogwarts roleplay. Your task is to read the latest roleplay messages and the current continuity state, then output a JSON delta describing what changed. If this is the first useful scan and the current state is mostly empty, output all clearly established continuity details as additions/changes.

<rules>
1. Output ONLY a valid JSON object — no markdown fences, no preamble, no commentary.
2. Only include fields that actually changed. Omit unchanged sections entirely.
3. If nothing changed, output exactly: {"summary":"No changes detected","changes":{}}
4. The JSON must follow the WandlightDelta schema exactly.
5. Character knowledge arrays should be merged (added to existing), not replaced.
6. For secrets, relationships, and threads: use "added" for new entries, "updated" for changes to existing entries (with index), "removed" for removed entries.
7. Be conservative — only flag continuity issues when there is a clear contradiction, not just ambiguity.
8. Canon era, in-universe date, and canon boundary should only change when explicitly established in the narrative. If the current state is empty/unset, treat clearly established details as additions instead of returning no changes.
9. Track clothing, posture, physical state, carried items, goals, emotional state, trust, affection, desire, and connection when clearly implied.
10. Emotional state should be current-state, not permanent personality. Avoid feedback loops: reduce or omit heightened emotion unless the latest messages reinforce it.
11. Numeric emotional values use -5 to +5 where 0 is neutral. Do not jump more than 2 points from the current state unless the scene explicitly justifies it.
12. Respect optional continuity sections. If a section is disabled in the current state, omit changes for that section.
13. If the current state is sparse or empty, perform an initial-state extraction: populate every active section that is clearly supported by the messages. Do not return only 1-2 categories when scene, characters, knowledge, objectives, inventory, or relationships are evident.
14. For thinking/reasoning models: put the final JSON in visible message.content. Do not leave the visible answer empty. Do not put the JSON only in hidden reasoning.
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
export const EXTRACTION_USER_PROMPT = `Analyze the messages above and extract continuity-state changes. If this is a first or sparse scan, populate every active tracked section that is clearly supported: canon, scene, characters, appearance/clothing, emotional state, knowledge, secrets, relationships, threads, inventory, objectives, and flags. Return ONLY visible valid JSON in the WandlightDelta shape. Do not leave message.content empty.`;

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
- Recognize Harry Potter school-year mapping: Sep 1991-Aug 1992 = Philosopher/Sorcerer's Stone Year 1; Sep 1992-Aug 1993 = Chamber of Secrets Year 2; Sep 1993-Aug 1994 = Prisoner of Azkaban Year 3; Sep 1994-Aug 1995 = Goblet of Fire Year 4; Sep 1995-Aug 1996 = Order of the Phoenix Year 5; Sep 1996-Aug 1997 = Half-Blood Prince Year 6; Sep 1997-Aug 1998 = Deathly Hallows Year 7.
- Prefer canon boundary phrases when precise dates are unclear.
- If time travel is implied, separate sceneDate from subjectiveDate.
- Output JSON only.`;

// ── Lore Generation prompt ──────────────────────────────────────────────────────
export const LORE_GENERATION_SYSTEM_PROMPT = `You are the Wandlight Lore Matrix Generator for a Harry Potter / Hogwarts roleplay.

Generate a small set of durable lore entries relevant to the current story context. Do not generate a Harry Potter encyclopedia.

Prioritize:
1. Current era/date/canon boundary.
2. Present or nearby characters.
3. Current location.
4. Secrets, public misconceptions, reveal constraints.
5. Facts likely to matter in the next 10-20 turns.
6. Date-sensitive constraints: who knows what, what has not happened yet, spell/skill plausibility, age-appropriate behavior.

Output ONLY valid JSON:
{
  "summary": "one sentence",
  "entries": [
    {
      "schemaVersion": 2,
      "id": "stable_snake_case_id",
      "title": "short title",
      "kind": "fact|event_anchor|knowledge_gate|future_guard|age_gate|spell_gate|skill_band|behavior_gate|relationship_gate|institution_state",
      "category": "canon|au|contested|secret|relationship|timeline|character|event|item|knowledge|place|faction|spell|artifact|behavior|skill|age|future_guard|constraint",
      "canonStatus": "canon|divergent|au|fanon|contested|unknown",
      "truthStatus": "true|false|public_belief|rumor|contested|hidden",
      "revealPolicy": "public|private|do_not_reveal|only_if_knower_present|only_if_user_reveals",
      "tags": ["short searchable category tags"],
      "priority": 50,
      "status": "active",
      "date": {
        "validFrom": "YYYY-MM-DD or empty",
        "validTo": "YYYY-MM-DD or empty",
        "precision": "date|month|year|school_year|era|approximate|unknown",
        "schoolYear": null,
        "book": "",
        "label": ""
      },
      "scope": {
        "characters": ["string"],
        "locations": ["string"],
        "factions": ["string"],
        "topics": ["string"],
        "objects": ["string"],
        "spells": ["string"],
        "schoolYears": [],
        "books": []
      },
      "visibility": {
        "knownBy": {},
        "notKnownByBefore": {},
        "suspectedBy": {},
        "publicFrom": "",
        "secretUntil": ""
      },
      "content": {
        "fact": "what is actually true or believed",
        "injection": "concise model-facing constraint wording",
        "constraints": ["date/knowledge/reveal constraints"],
        "antiLore": ["things the model should not assume"],
        "publicVersion": "",
        "notes": ""
      },
      "effects": {
        "addsTags": [],
        "blocksTermsBeforeDate": [],
        "stateHints": {},
        "injectionRules": {}
      },
      "source": "model-generated",
      "userEdited": false,
      "locked": false,
      "extensions": {}
    }
  ]
}

Rules:
- Give every entry the requested number of concise tags. Tags must be searchable labels, not full sentences.
- Tag schema: 1-3 words each; prefer character names, groups, locations, era/year, plot thread, secret type, relationship pair, magic system, faction, object/artifact, event, or villain/ally role.
- Good tags: "Harry", "Voldemort", "villains", "Hogwarts", "Slytherin", "1996", "secret", "relationship", "prophecy". Bad tags: full sentences or conclusions.
- Generate 4-10 entries only unless the source context is sparse.
- Prefer constraints over trivia.
- If a fact is secret in this era, include content.publicVersion and revealPolicy.
- If the entry blocks future knowledge leakage, use kind "future_guard" or "knowledge_gate" and include content.antiLore.
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