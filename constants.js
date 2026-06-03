/**
 * constants.js — Wandlight
 * Module key, default state object, default settings, extraction prompt template,
 * lore generation prompts, and logging prefix. No other dependencies.
 */

// ── Module key ──────────────────────────────────────────────────────────────────
export const MODULE_KEY = 'wandlight';
export const LEGACY_MODULE_KEYS = Object.freeze(['wandlight_continuity']);
export const WANDLIGHT_PRESET_NAME = 'Wandlight';
export const WANDLIGHT_PRESET_VERSION = 'Wandlight-1.4';
export const WANDLIGHT_PRESET_ASSET_PATH = './Presets/Wandlight-1.4.json';
export const WANDLIGHT_PROVIDER_PRESET_NAME = 'Provider';
export const WANDLIGHT_PROVIDER_PRESET_VERSION = 'Provider-1.2';
export const WANDLIGHT_PROVIDER_PRESET_ASSET_PATH = './Presets/Provider-1.2.json';

/**
 * The extension folder name under data/default-user/extensions/third-party/.
 * Must match the installed folder name exactly for renderExtensionTemplateAsync.
 */
export const EXTENSION_FOLDER = 'third-party/Wandlight';
export const LEGACY_EXTENSION_FOLDERS = Object.freeze(['third-party/WandlightContinuity']);

/**
 * Dynamically detects the actual installed extension folder from the script src.
 * Falls back to EXTENSION_FOLDER if detection fails.
 * @param {string} [fallback] - Folder to use if detection fails
 * @returns {string} The detected extension folder path
 */
export function detectExtensionFolder(fallback = EXTENSION_FOLDER) {
    try {
        const scripts = Array.from(document.querySelectorAll('script[src]'));
        // Match the actual script location instead of assuming a fixed folder name.
        // This supports both the rebranded /third-party/Wandlight/ folder and legacy installs.
        for (const script of scripts) {
            const rawSrc = script?.src || '';
            if (!/wandlight/i.test(rawSrc) || !rawSrc.includes('/third-party/')) continue;
            const url = new URL(rawSrc, document.baseURI);
            const match = url.pathname.match(/third-party\/([^/]+)\/index\.js$/);
            if (match?.[1]) {
                return `third-party/${decodeURIComponent(match[1])}`;
            }
        }
    } catch (_) {
        // Silently fall through.
    }
    return fallback;
}

// ── Logging prefix ──────────────────────────────────────────────────────────────
export const LOG_PREFIX = '[Wandlight]';

// ── Schema version ──────────────────────────────────────────────────────────────
export const SCHEMA_VERSION = 18;

export const AUTOMATION_MODE_VALUES = Object.freeze(['manual', 'assisted', 'automatic']);
export const EXPERIENCE_MODE_VALUES = Object.freeze(['basic', 'advanced']);
export const BASIC_EXPERIENCE_PROFILE_VERSION = 2;

export const BASIC_EXPERIENCE_SETTINGS = Object.freeze({
    autoExtract: false,
    autoApplyDelta: true,
    autoGenerateLore: false,
    automationMode: 'manual',
    workflowMode: 'manual',
    continuityTrackingMode: 'manual',
    contextDetectionMode: 'manual',
    loreGenerationMode: 'manual',
    contextHeaderDetectionEnabled: true,
    contextSourceMessageCount: 20,
    canonLoreDatabaseEnabled: true,
    canonLoreAutoPropose: true,
    canonLoreMaxEntries: 10,
    loreBulkScanMode: 'recent',
    loreSourceMessageCount: 40,
    loreBulkChunkSize: 10,
    loreBulkOverlap: 1,
    loreBulkConcurrency: 2,
    loreBulkFactsPerChunk: 8,
    loreGenerationBreadthMode: 'auto',
    loreBootstrapTargetEntries: 40,
    loreIncrementalTargetEntries: 5,
    loreReplacementGuard: true,
    loreDuplicateGuard: true,
    loreSimilarityRouting: true,
    loreStrictQualityGate: true,
    loreTagCount: 4,
    autoRelevanceEnabled: false,
    autoRelevanceUseModel: false,
    injectionTransport: 'extension_prompt',
    injectMemo: true,
    injectContinuity: false,
    injectLore: true,
    continuityInjectionMode: 'direct',
    loreHighInjectionEnabled: true,
    loreNormalInjectionEnabled: true,
    loreLowInjectionEnabled: false,
    loreHighInjectionMode: 'direct',
    loreNormalInjectionMode: 'direct',
    loreLowInjectionMode: 'direct',
    loreHighCompressionLevel: 3,
    loreNormalCompressionLevel: 3,
    loreLowCompressionLevel: 3,
    continuityInjectionDepth: 3,
    loreHighInjectionDepth: 2,
    loreNormalInjectionDepth: 5,
    loreLowInjectionDepth: 9,
});

export const BASIC_EXPERIENCE_MANAGED_SETTING_KEYS = Object.freeze(Object.keys(BASIC_EXPERIENCE_SETTINGS));

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
    experienceMode: 'basic',
    advancedExperienceSettingsBackup: null,
    basicExperienceProfileVersion: BASIC_EXPERIENCE_PROFILE_VERSION,

    // Runtime automation modes. These replace the old single workflow preset for new behavior.
    automationMode: 'manual',
    continuityTrackingMode: 'manual', // 'manual' | 'automatic'
    continuityAutoInterval: 10, // turns between automatic continuity scans
    contextDetectionMode: 'manual', // 'manual' | 'automatic'
    contextDetectionAutoInterval: 5,
    contextHeaderDetectionEnabled: true,
    loreGenerationMode: 'manual', // 'manual' | 'automatic'
    loreGenerationAutoInterval: 50,
    loreGenerationAutoMinTurns: 20,
    loreGenerationAutoWordThreshold: 2500,
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
    continuityScanStrategy: 'adaptive', // 'adaptive' | 'fast' | 'hybrid' | 'bulk'
    continuityScanFastThreshold: 4,
    continuityScanHybridThreshold: 80,
    continuityFastMaxTokens: 2048,
    continuityHybridMaxTokens: 3072,
    continuityObservationMaxTokens: 1536,
    continuityReducerMaxTokens: 1536,

    // Lore matrix
    injectLore: true,
    maxLoreEntriesInMemo: 0, // 0 = unlimited; users control injection by muting entries
    // Accepted Lore Matrix is intentionally uncapped. UI uses paging so hundreds of entries remain usable.
    maxLoreEntriesInMatrix: 0,
    autoGenerateLore: false,
    workflowMode: 'manual', // deprecated legacy alias for automationMode

    // Lore generation behavior
    loreSourceMessageCount: 40,
    loreGenerationChunkSize: 10,
    loreGenerationBreadthMode: 'auto', // 'auto' | 'bootstrap' | 'incremental'
    loreBootstrapTargetEntries: 40,
    loreIncrementalTargetEntries: 5,
    loreBootstrapStoryLoreThreshold: 12,
    loreBootstrapDefaultsMigrated20260531: true,
    loreAutomationDefaultsMigrated20260602: true,
    continuityPerformanceDefaultsMigrated20260603: true,
    loreReplacementGuard: true,
    loreDuplicateGuard: true,
    loreSimilarityRouting: true,
    loreStrictQualityGate: true,
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
    loreBulkFactsPerChunk: 8,
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

    // Lore relevance / canon timing
    canonTimelineStrictness: 'balanced', // 'loose' | 'balanced' | 'strict'
    autoReevaluateLoreLifecycle: false, // Deprecated by relevance-tiered lore. Kept for old settings compatibility.
    autoMuteExpiredLore: false,
    includeCanonOverdueLore: false,
    autoRelevanceEnabled: false,
    autoRelevanceMode: 'suggest', // 'suggest' | 'apply_high_confidence' (legacy 'off' is normalized to disabled settings)
    autoRelevanceEveryTurns: 5,
    autoRelevanceRecentMessages: 20,
    autoRelevanceCandidateCap: 40,
    autoRelevanceMinConfidence: 0.7,
    autoRelevanceNearFutureDays: 30,
    autoRelevanceRecentPastDays: 45,
    autoRelevanceProtectPinned: true,
    autoRelevanceEvaluateMuted: false,
    autoRelevanceUseModel: false,
    autoRelevanceModelCandidateCap: 30,
    autoRelevanceModelMaxTokens: 2048,
    autoRelevanceModelRecentChars: 5000,

    // Prompt injection transport / placement
    // 'extension_prompt' uses SillyTavern setExtensionPrompt with role/depth.
    // 'interceptor' preserves the legacy behavior: prepend combined memo to the last user message.
    injectionTransport: 'extension_prompt',
    continuityInjectionPosition: 1, // SillyTavern extension_prompt_types.IN_CHAT
    continuityInjectionDepth: 3,
    continuityInjectionRole: 0, // SillyTavern extension_prompt_roles.SYSTEM
    loreInjectionPosition: 1,
    loreInjectionDepth: 3,
    loreInjectionRole: 0,
    loreHighInjectionPosition: 1,
    loreHighInjectionDepth: 2,
    loreHighInjectionRole: 0,
    loreNormalInjectionPosition: 1,
    loreNormalInjectionDepth: 5,
    loreNormalInjectionRole: 0,
    loreLowInjectionPosition: 1,
    loreLowInjectionDepth: 9,
    loreLowInjectionRole: 0,
    injectionPromptScan: false,

    // Lore injection / compression
    loreInjectionMode: 'direct', // legacy aggregate compatibility
    loreHighInjectionEnabled: true,
    loreNormalInjectionEnabled: true,
    loreLowInjectionEnabled: true,
    loreHighInjectionMode: 'direct', // 'direct' | 'compressed'
    loreNormalInjectionMode: 'compressed',
    loreLowInjectionMode: 'compressed',
    loreHighCompressionLevel: 3,
    loreNormalCompressionLevel: 3,
    loreLowCompressionLevel: 3,
    loreHighCompressionTurnInterval: 4,
    loreNormalCompressionTurnInterval: 8,
    loreLowCompressionTurnInterval: 16,
    loreHighMaxEntries: 30,
    loreNormalMaxEntries: 60,
    loreLowMaxEntries: 120,
    loreCompressionLevel: 3, // legacy aggregate compatibility
    loreCompressionTurnInterval: 8,
    continuityInjectionMode: 'direct', // 'direct' | 'compressed'
    continuityCompressionLevel: 3,
    continuityEmotionRecencyEnabled: true,
    continuityEmotionCurrentMessageWindow: 8,
    continuityEmotionRecentMessageWindow: 20,
    continuityEmotionStaleBehavior: 'omit', // 'omit' | 'keep_as_recent' | 'keep'

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
- Preserve current scene/timeline state, active character state, key items, and active goals/threads.
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
- Preserve secrets, knowledge boundaries, canon or story-established constraints, current-scene relevant facts, and active hazards.
- Preserve pinned/protected lore more fully than ordinary lore.
- Merge redundant entries where possible and drop low-value wording. Drop generic reference/glossary facts if they appear; preserve only specific constraints, dates, knowledge boundaries, status changes, and story-established facts.
- At compression level 3 or higher, prefer compact bullets and phrase fragments over prose.
- Do not invent facts.
- Output only the compressed injection text. No markdown fences or commentary.

Direct injection block:
{{directText}}`,

    // Runtime-window collapsible sections. true = collapsed.
    collapsedSections: {
        'session.instructions': true,
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
        'continuity.threads': true,
        'continuity.inventory': true,
        'continuity.objectives': true,
        'continuity.prompt.canonScene': true,
        'continuity.prompt.characters': true,
        'continuity.prompt.threads': true,
        'continuity.prompt.inventory': true,
        'continuity.prompt.objectives': true,
    },



    // Continuity scan prompt overrides. These are appended to the extractor prompt only
    // when the corresponding section is enabled/tracked for the current chat.
    continuitySectionPrompts: {
        canonScene: 'Extract only explicitly established scene and timeline details: era, in-universe date, canon boundary, location, time of day, weather, ambience, present/nearby characters, and current activity. Do not invent missing fields. Durable story-established canon changes belong in Story Lore, not Continuity.',
        characters: 'Track active character state when clearly supported: role, current location, clothing, posture, physical condition, currently observed emotional state, carried key items, and immediate goals. For emotionalState, include confidence from 0 to 1 when uncertain, and only update it when the latest messages show or explicitly state the emotion. Do not summarize relationship history or durable knowledge here; Story Lore owns that memory.',
        threads: 'Track only active immediate threads that affect the next scene or next few replies. Durable plot history, milestones, secrets, and relationship history belong in Story Lore.',
        inventory: 'Track only consequential currently relevant items: carried key items, ownership, location, and immediate object status. Item history belongs in Story Lore.',
        objectives: 'Track current goals, plans, blockers, stakes, and whether objectives are active, blocked, completed, or abandoned. Long-term plot facts belong in Story Lore.'
    },

    // Utility provider: used by compression and Scan Continuity State / automatic continuity tracking. Internal key retained for backward compatibility.
    continuityProvider: 'st', // 'st' | 'profile' | 'openai_compatible'
    continuityProfileId: '',
    // Deprecated: Connection Profiles now own their settings preset.
    continuityCompletionPresetId: '',
    continuityOpenAIBaseUrl: '',
    continuityOpenAIModel: '',
    continuityOpenAIKeyEncrypted: null,
    continuityOpenAIKeySalt: '',
    continuityOpenAIKeyIv: '',
    continuityOpenAIKeySet: false,
    // Deprecated compatibility flags. Wandlight now uses plain direct
    // OpenAI-compatible calls for this provider path.
    continuityOpenAIUseJsonMode: false,
    continuityOpenAIUseSTProxy: false,
    continuityTemperature: 0.7,
    continuityTopP: 0.98,
    continuityMaxTokens: 8192,

    // Reasoning provider: used by Detect Story Context / Generate Pending Lore. Internal key retained for backward compatibility.
    loreProvider: 'st', // 'st' | 'profile' | 'openai_compatible'
    loreProfileId: '',
    // Deprecated: Connection Profiles now own their settings preset.
    loreCompletionPresetId: '',

    // Lore OpenAI-compatible endpoint
    loreOpenAIBaseUrl: '',
    loreOpenAIModel: '',
    loreOpenAIKeyEncrypted: null,
    loreOpenAIKeySalt: '',
    loreOpenAIKeyIv: '',
    loreOpenAIKeySet: false,
    // Deprecated compatibility flags. Wandlight now relies on JSON-focused
    // prompts and repair rather than forcing provider-specific JSON mode.
    loreOpenAIUseJsonMode: false,
    loreOpenAIUseSTProxy: false,

    // Reasoning generation parameters (separate from main RP model settings)
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
            threads: true,
            inventory: true,
            objectives: true,
            // Retired continuity sections remain in saved state for backward compatibility
            // but are no longer scanned, injected, or shown in the streamlined UI.
            knowledge: false,
            secrets: false,
            relationships: false,
            flags: false,
            storyMilestones: false,
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

        // Auto-Relevance suggestion queue/status. Suggest mode writes here instead of mutating accepted lore.
        autoRelevanceSuggestions: [],
        autoRelevanceLastRun: null,

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
        loreCompressionStatusByRelevance: {
            high: {
                lastCompressedAt: 0, lastSignature: '', lastMode: 'direct', lastTokenEstimate: 0, lastCharacterCount: 0,
                lastDirectTokenEstimate: 0, lastDirectCharacterCount: 0, lastTargetTokenEstimate: 0, lastTargetCharacterCount: 0,
                lastHardTokenLimit: 0, lastHardCharacterLimit: 0, lastCompressionRatio: 0, turnsSinceCompression: 0, lastChatLength: 0,
                cachedText: '', lastError: '',
            },
            normal: {
                lastCompressedAt: 0, lastSignature: '', lastMode: 'direct', lastTokenEstimate: 0, lastCharacterCount: 0,
                lastDirectTokenEstimate: 0, lastDirectCharacterCount: 0, lastTargetTokenEstimate: 0, lastTargetCharacterCount: 0,
                lastHardTokenLimit: 0, lastHardCharacterLimit: 0, lastCompressionRatio: 0, turnsSinceCompression: 0, lastChatLength: 0,
                cachedText: '', lastError: '',
            },
            low: {
                lastCompressedAt: 0, lastSignature: '', lastMode: 'direct', lastTokenEstimate: 0, lastCharacterCount: 0,
                lastDirectTokenEstimate: 0, lastDirectCharacterCount: 0, lastTargetTokenEstimate: 0, lastTargetCharacterCount: 0,
                lastHardTokenLimit: 0, lastHardCharacterLimit: 0, lastCompressionRatio: 0, turnsSinceCompression: 0, lastChatLength: 0,
                cachedText: '', lastError: '',
            },
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

        // Runtime rail + drawer UI state (schema v16). Legacy x/y/width/height
        // remain as migration aliases for older saved Wandlight panels.
        lorePanel: {
            isOpen: true,
            collapsed: true,
            railMode: 'compact',
            railX: 20,
            railY: 220,
            drawerOpen: false,
            drawerWidth: 560,
            drawerHeight: 640,
            drawerDirection: 'auto',
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
            x: 20,
            y: 220,
            width: 560,
            height: 640,
        },
        loreTimeline: {
            schemaVersion: 1,
            events: [],
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
