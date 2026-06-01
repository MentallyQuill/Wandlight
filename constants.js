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
export const SCHEMA_VERSION = 9;

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

    // Checkpointed continuity scan behavior
    continuityScanMode: 'recent', // 'recent' | 'range' | 'entire'
    continuityScanRangeStart: 1,
    continuityScanRangeEnd: 0, // 0 = latest message
    continuityScanChunkSize: 8,
    continuityScanOverlap: 1,
    continuityScanConcurrency: 3,
    continuityScanReducerConcurrency: 3,
    continuityScanRescanMode: 'skip_unchanged', // 'skip_unchanged' | 'retry_failed' | 'stale_only' | 'rescan_all'
    continuityScanRetryAttempts: 2,
    continuityScanObservationsPerChunk: 12,
    continuityScanFullCheckpointEveryChunks: 5,
    continuityScanRunningCheckpointStaleMs: 10 * 60 * 1000,
    continuityScanRetainRawResponses: false,
    continuityScanRetainCompletedBatches: 3,

    // Lore matrix
    injectLore: true,
    maxLoreEntriesInMemo: 0, // 0 = unlimited; users control injection by muting entries
    // Accepted Lore Matrix is intentionally uncapped. UI uses paging so hundreds of entries remain usable.
    maxLoreEntriesInMatrix: 0,
    autoGenerateLore: false,
    workflowMode: 'manual', // legacy UI preset; explicit tab modes are authoritative

    // Lore generation behavior
    loreSourceMessageCount: 40,
    loreGenerationChunkSize: 10,
    loreGenerationBreadthMode: 'auto', // 'auto' | 'bootstrap' | 'incremental'
    loreBootstrapTargetEntries: 40,
    loreIncrementalTargetEntries: 8,
    loreBootstrapStoryLoreThreshold: 12,
    loreBootstrapDefaultsMigrated20260531: true,
    loreReplacementGuard: true,
    loreDuplicateGuard: true,
    loreTagCount: 4,

    // Bulk story lore scan/backfill behavior
    loreBulkScanMode: 'recent', // 'recent' | 'range' | 'entire'
    loreBulkRangeStart: 1,
    loreBulkRangeEnd: 0, // 0 = latest message
    loreBulkChunkSize: 10,
    loreBulkOverlap: 1,
    loreBulkConcurrency: 3,
    loreBulkRescanMode: 'skip_unchanged', // 'skip_unchanged' | 'retry_failed' | 'stale_only' | 'rescan_all'
    loreBulkRetryAttempts: 2,
    loreBulkFactsPerChunk: 14,
    loreBulkConsolidateAsPending: true,
    loreBulkConsolidationChunkWindow: 5,
    loreBulkConsolidationFactWindow: 80,
    loreBulkFullCheckpointEveryChunks: 5,
    loreBulkFullCheckpointEveryMs: 12000,
    loreBulkRunningCheckpointStaleMs: 10 * 60 * 1000,
    loreBulkRetainRawResponses: false,
    loreBulkRetainCompletedBatches: 3,

    // Local canon lore database
    canonLoreDatabaseEnabled: true,
    canonLoreAutoPropose: true,
    canonLoreMaxEntries: 10,

    // Lore lifecycle / canon timing
    canonTimelineStrictness: 'balanced', // 'loose' | 'balanced' | 'strict'
    autoReevaluateLoreLifecycle: true,
    autoMuteExpiredLore: true,
    includeCanonOverdueLore: true,

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

    // Advanced compression prompt templates. Variables: {{kind}}, {{compressionLevel}},
    // {{compressionLabel}}, {{directTokens}}, {{targetTokens}}, {{hardTokenLimit}},
    // {{directCharacters}}, {{targetCharacters}}, {{hardCharacterLimit}},
    // {{storyContext}}, {{directText}}.
    continuityCompressionPromptTemplate: `Compress the following Wandlight {{kind}} injection block for a Harry Potter roleplay.

Story context:
{{storyContext}}

Compression level {{compressionLevel}} — {{compressionLabel}}.
Source length: about {{directTokens}} tokens / {{directCharacters}} characters.
Target length: at most {{targetTokens}} tokens / {{targetCharacters}} characters.
Hard maximum visible output: {{hardTokenLimit}} tokens / {{hardCharacterLimit}} characters.

Rules:
- Preserve current scene state, character state, knowledge boundaries, secrets, active goals, relationships, and contradictions.
- Keep emotional state only when it currently affects character behavior.
- Merge redundant details and rewrite for density; do not simply restate the source.
- At compression level 3 or higher, prefer compact bullets and phrase fragments over prose.
- Do not invent facts.
- Output only the compressed injection text. No markdown fences or commentary.

Direct injection block:
{{directText}}`,
    loreCompressionPromptTemplate: `Compress the following Wandlight {{kind}} injection block for a Harry Potter roleplay.

Story context:
{{storyContext}}

Compression level {{compressionLevel}} — {{compressionLabel}}.
Source length: about {{directTokens}} tokens / {{directCharacters}} characters.
Target length: at most {{targetTokens}} tokens / {{targetCharacters}} characters.
Hard maximum visible output: {{hardTokenLimit}} tokens / {{hardCharacterLimit}} characters.

Rules:
- Preserve secrets, knowledge boundaries, canon/AU constraints, current-scene relevant facts, and active hazards.
- Preserve pinned/protected lore more fully than ordinary lore.
- Merge redundant entries where possible and drop low-value wording.
- At compression level 3 or higher, prefer compact bullets and phrase fragments over prose.
- Do not invent facts.
- Output only the compressed injection text. No markdown fences or commentary.

Direct injection block:
{{directText}}`,

    // Runtime-window collapsible sections. true = collapsed.
    collapsedSections: {
        'session.instructions': true,
        'session.stateHistory': true,
        'session.dangerZone': true,
        'context.canonDatabase': true,
        'context.automation': true,
        'lore.generationSettings': true,
        'lore.storyGenerationSettings': true,
        'lore.story.scanScope': false,
        'lore.story.performance': true,
        'lore.story.quality': true,
        'lore.story.automation': true,
        'injection.promptPlacement': true,
        'injection.continuityHandling': true,
        'injection.loreHandling': true,
        'injection.compressionPrompts': true,
        'continuity.trackedSections': true,
        'continuity.knowledge': true,
        'continuity.secrets': true,
        'continuity.relationships': true,
        'continuity.threads': true,
        'continuity.inventory': true,
        'continuity.objectives': true,
        'continuity.flags': true,
        'continuity.prompt.canonScene': true,
        'continuity.prompt.canonDivergences': true,
        'continuity.prompt.characters': true,
        'continuity.prompt.storyMilestones': true,
        'continuity.prompt.knowledge': true,
        'continuity.prompt.secrets': true,
        'continuity.prompt.relationships': true,
        'continuity.prompt.threads': true,
        'continuity.prompt.inventory': true,
        'continuity.prompt.objectives': true,
        'continuity.prompt.flags': true,
    },



    // Continuity scan prompt overrides. These are appended to the extractor prompt only
    // when the corresponding section is enabled/tracked for the current chat.
    continuitySectionPrompts: {
        canonScene: 'Extract only explicitly established canon/date and scene details: era, in-universe date, canon boundary, location, time of day, weather, ambience, present/nearby characters, and current activity. Do not invent missing fields.',
        canonDivergences: 'Track AU or changed-canon divergences separately from ordinary scene state. Only add a divergence when the roleplay clearly contradicts or departs from canon.',
        characters: 'Track character-specific state when clearly supported: role, location, clothing, posture, physical condition, current emotional state, inventory, and immediate goals. Keep emotions current-state, not permanent personality.',
        storyMilestones: 'Detect story milestone status changes only from roleplay evidence. Do not mark milestones happened merely because a canon date passed.',
        knowledge: 'Track who knows what. Prefer character-keyed concise facts. Do not give characters knowledge that has not been established in this roleplay.',
        secrets: 'Track non-public truths, who knows them, who suspects them, and the public version. Preserve reveal boundaries.',
        relationships: 'Track relationship state changes such as trust, tension, alliance, suspicion, affection, rivalry, or dependence only when the scene supports them.',
        threads: 'Track active, dormant, or resolved story threads and unresolved consequences that should influence future turns.',
        inventory: 'Track important carried items, ownership, locations, object status, and temporary possessions only when likely to matter later.',
        objectives: 'Track current goals, plans, blockers, stakes, and whether objectives are active, blocked, completed, or abandoned.',
        flags: 'Track contradictions, warnings, uncertainties, and resolved continuity issues. Be conservative; do not flag ambiguity as contradiction.'
    },

    // Utility provider: used by compression and Scan Continuity State / automatic continuity tracking. Internal key retained for backward compatibility.
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

    // Reasoning provider: used by Detect Story Context / Generate Pending Lore. Internal key retained for backward compatibility.
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
    loreMaxTokens: 8192,
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
            storyMilestones: true,
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
        storyMilestones: {},

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

        // Resumable bulk lore scan ledger (schema v8)
        loreBulkGeneration: {
            activeBatchId: '',
            lastBatchId: '',
            batches: {},
            chunks: {},
            candidates: {},
        },

        // Resumable continuity scan ledger (schema v9)
        continuityScan: {
            activeBatchId: '',
            lastBatchId: '',
            batches: {},
            chunks: {},
            observations: {},
        },

        pendingLoreMeta: null,

        // Prompt injection/compression preview status
        loreCompressionStatus: {
            lastCompressedAt: 0,
            lastSignature: '',
            lastMode: 'direct',
            lastTokenEstimate: 0,
            lastCharacterCount: 0,
            lastDirectTokenEstimate: 0,
            lastDirectCharacterCount: 0,
            lastTargetTokenEstimate: 0,
            lastTargetCharacterCount: 0,
            lastHardTokenLimit: 0,
            lastHardCharacterLimit: 0,
            lastCompressionRatio: 0,
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
            lastCharacterCount: 0,
            lastDirectTokenEstimate: 0,
            lastDirectCharacterCount: 0,
            lastTargetTokenEstimate: 0,
            lastTargetCharacterCount: 0,
            lastHardTokenLimit: 0,
            lastHardCharacterLimit: 0,
            lastCompressionRatio: 0,
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
            acceptedSelectedIds: [],
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

// ── JSON repair prompt ──────────────────────────────────────────────────────────
export const JSON_REPAIR_SYSTEM_PROMPT = `You repair malformed JSON.

Return ONLY valid JSON.
Do not add markdown.
Do not explain.
Preserve the user's intended data and conform to the required shape provided in the user's repair request.`;

// ── Token budget for memo ───────────────────────────────────────────────────────
export const MEMO_MAX_TOKENS = 500;


// ── Character list truncation limits ────────────────────────────────────────────
export const MAX_PRESENT_CHARS_IN_MEMO = 8;
export const MAX_KNOWLEDGE_FACTS_PER_CHAR = 5;
export const MAX_ACTIVE_THREADS_IN_MEMO = 6;
export const MAX_RELATIONSHIPS_IN_MEMO = 6;
export const MAX_FLAGS_IN_MEMO = 4;