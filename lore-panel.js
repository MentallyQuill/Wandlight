/**
 * lore-panel.js - Wandlight
 * Floating roleplay control window.
 *
 * The extension-menu settings panel is reserved for API setup and
 * runtime launch controls. This window is the runtime surface used during roleplay.
 */

import { getPanelLoreState, getInjectableLoreEntries, getLoreRelevanceCounts, normalizeLoreMatrix, normalizeLoreEntry, normalizeLoreTag, LORE_LIFECYCLE_STATUSES } from './lore-matrix.js';
import { LORE_RELEVANCE_TIERS, LORE_RELEVANCE_LABELS, normalizeLoreRelevance, LORE_CATEGORY_VALUES, LORE_PURPOSE_LABELS, normalizeLorePurpose } from './lore-relevance.js';
import {
    getDefaultState,
    DEFAULT_SETTINGS,
    WANDLIGHT_PRESET_NAME,
    WANDLIGHT_PRESET_VERSION,
    WANDLIGHT_PRESET_ASSET_PATH,
    BASIC_EXPERIENCE_SETTINGS,
    BASIC_EXPERIENCE_MANAGED_SETTING_KEYS,
    BASIC_EXPERIENCE_PROFILE_VERSION,
} from './constants.js';
import {
    getState,
    getSettings,
    saveSettings,
    saveState,
    applyDelta,
    pushStateSnapshot,
    acceptPendingLoreEntries,
    rejectPendingLoreEntries,
    acceptPendingLoreEntry,
    rejectPendingLoreEntry,
    appendPendingLoreEntries,
    restoreLoreTimelineEntriesToPending,
    setLoreContext,
} from './state-manager.js';
import { buildContinuityPreview, buildLorePreview, getCompressionSourceSignature } from './memo-builder.js';
import { onExtractionTriggered } from './extractor.js';
import { runLoreContextDetection, runBulkLoreGeneration } from './lore-generator.js';
import { sendLoreRequest, validateLoreProviderConfiguration } from './lore-llm-client.js';
import { proposeCanonLoreForContext, previewCanonLoreForContext, addCanonLorePreviewEntriesToPending, getLoreTaxonomySync } from './canon-lore-db.js';
import { runAutoRelevance, applyAutoRelevanceSuggestions, clearAutoRelevanceSuggestions, rejectAutoRelevanceSuggestions } from './auto-relevance.js';
import {
    captureLoreTimelineState,
    recordLoreTimelineEvent,
    getLoreTimelineEvents,
    getLoreTimelineSummary,
    getRecoverableTimelineEntries,
} from './lore-timeline.js';

const PANEL_ID = 'wandlight-lore-panel';
const LORE_WORKBENCH_ID = 'wandlight-lore-workbench';
const LORE_TIMELINE_ID = 'wandlight-lore-timeline';
const MIN_PANEL_WIDTH = 420;
const MIN_PANEL_HEIGHT = 360;
const MIN_DRAWER_WIDTH = 360;
const MIN_DRAWER_HEIGHT = 320;
const RAIL_WIDTH_COMPACT = 60;
const RAIL_WIDTH_EXPANDED = 206;
const RAIL_DRAWER_GAP = 8;
const MAX_PANEL_MARGIN = 16;
const DEFAULT_RAIL_LEFT = 20;
const DEFAULT_COMPACT_RAIL_HEIGHT_ESTIMATE = 420;
const DEFAULT_EXPANDED_RAIL_HEIGHT_ESTIMATE = 420;
const LAYOUT_VERSION = 2;
const WANDLIGHT_PRESET_API_ID = 'openai';
const LEGACY_WANDLIGHT_PRESET_NAMES = Object.freeze([
    'Wandlight-1.0',
    'Wandlight-1.1',
    'Wandlight-1.2',
    'Wandlight-1.3',
]);
const STORED_API_KEY_SETTING_PREFIXES = Object.freeze(['loreOpenAI', 'continuityOpenAI']);
const STORED_API_KEY_SETTING_SUFFIXES = Object.freeze(['Encrypted', 'Salt', 'Iv', 'KeyEncrypted', 'KeySalt', 'KeyIv', 'KeySet']);
const CONTEXT_DETECTION_SETTING_KEYS = Object.freeze([
    'contextDetectionMode',
    'contextDetectionAutoInterval',
    'contextHeaderDetectionEnabled',
    'contextSourceMessageCount',
]);
const STORY_LORE_SCAN_SCOPE_SETTING_KEYS = Object.freeze([
    'loreBulkScanMode',
    'loreBulkRangeStart',
    'loreBulkRangeEnd',
    'loreSourceMessageCount',
]);
const STORY_LORE_SCAN_PERFORMANCE_SETTING_KEYS = Object.freeze([
    'loreBulkChunkSize',
    'loreBulkOverlap',
    'loreBulkConcurrency',
    'loreBulkRetryAttempts',
    'loreBulkFullCheckpointEveryChunks',
    'loreBulkConsolidationChunkWindow',
]);
const STORY_LORE_SCAN_QUALITY_SETTING_KEYS = Object.freeze([
    'loreGenerationBreadthMode',
    'loreBulkFactsPerChunk',
    'loreBootstrapTargetEntries',
    'loreIncrementalTargetEntries',
    'loreTagCount',
    'loreReplacementGuard',
    'loreDuplicateGuard',
    'loreSimilarityRouting',
    'loreStrictQualityGate',
    'loreBulkRescanMode',
]);
const STORY_LORE_AUTOMATION_SETTING_KEYS = Object.freeze([
    'loreGenerationMode',
    'loreGenerationAutoInterval',
    'loreGenerationAutoMinTurns',
    'loreGenerationAutoWordThreshold',
]);
const CONTINUITY_SCAN_SCOPE_SETTING_KEYS = Object.freeze([
    'continuityScanMode',
    'continuityScanRangeStart',
    'continuityScanRangeEnd',
    'continuitySourceMessageCount',
]);
const CONTINUITY_SCAN_PERFORMANCE_SETTING_KEYS = Object.freeze([
    'continuityScanStrategy',
    'continuityScanFastThreshold',
    'continuityScanHybridThreshold',
    'continuityFastMaxTokens',
    'continuityHybridMaxTokens',
    'continuityScanChunkSize',
    'continuityScanOverlap',
    'continuityScanConcurrency',
    'continuityScanReducerConcurrency',
    'continuityScanRetryAttempts',
    'continuityScanObservationsPerChunk',
    'continuityObservationMaxTokens',
    'continuityReducerMaxTokens',
    'continuityScanFullCheckpointEveryChunks',
    'continuityScanRescanMode',
]);
const CONTINUITY_EMOTION_FRESHNESS_SETTING_KEYS = Object.freeze([
    'continuityEmotionRecencyEnabled',
    'continuityEmotionCurrentMessageWindow',
    'continuityEmotionRecentMessageWindow',
    'continuityEmotionStaleBehavior',
]);
const PROMPT_PLACEMENT_SETTING_KEYS = Object.freeze([
    'injectionTransport',
    'continuityInjectionPosition',
    'continuityInjectionDepth',
    'continuityInjectionRole',
    'loreHighInjectionPosition',
    'loreHighInjectionDepth',
    'loreHighInjectionRole',
    'loreNormalInjectionPosition',
    'loreNormalInjectionDepth',
    'loreNormalInjectionRole',
    'loreLowInjectionPosition',
    'loreLowInjectionDepth',
    'loreLowInjectionRole',
]);
const AUTO_RELEVANCE_SETTING_KEYS = Object.freeze([
    'autoRelevanceEnabled',
    'autoRelevanceMode',
    'autoRelevanceEveryTurns',
    'autoRelevanceRecentMessages',
    'autoRelevanceCandidateCap',
    'autoRelevanceMinConfidence',
    'autoRelevanceNearFutureDays',
    'autoRelevanceRecentPastDays',
    'autoRelevanceProtectPinned',
    'autoRelevanceEvaluateMuted',
    'autoRelevanceUseModel',
    'autoRelevanceModelCandidateCap',
    'autoRelevanceModelMaxTokens',
    'autoRelevanceModelRecentChars',
]);

let bundledWandlightPresetCache = null;

const CATEGORY_LABELS = {
    all: 'All',
    pinned: 'Pinned',
    suppressed: 'Muted',
    pending: 'Pending',
    high: 'High Relevance',
    normal: 'Normal Relevance',
    low: 'Low Relevance',
    canon: 'Canon',
    au: 'AU',
    secret: 'Secret',
    rumor: 'Rumor',
    lie: 'Lie',
    relationship: 'Relationship',
    location: 'Location',
    rule: 'Rule',
    timeline: 'Timeline',
    character: 'Character',
    event: 'Event',
    item: 'Item',
    knowledge: 'Knowledge',
    place: 'Place',
    faction: 'Faction',
    spell: 'Spell',
    artifact: 'Artifact',
};

const TAB_LABELS = {
    session: 'Session',
    context: 'Context',
    continuity: 'Continuity',
    lore: 'Lore',
    injection: 'Injection',
};

const TAB_ICONS = {
    session: 'S',
    context: 'C',
    continuity: 'K',
    lore: 'L',
    injection: 'I',
};

const TAB_ICON_PATHS = {
    session: './Images/runtime-icons/wandlight_tab_session_256.png',
    context: './Images/runtime-icons/wandlight_tab_context_256.png',
    continuity: './Images/runtime-icons/wandlight_tab_continuity_256.png',
    lore: './Images/runtime-icons/wandlight_tab_lore_256.png',
    injection: './Images/runtime-icons/wandlight_tab_injection_256.png',
};

const BRAND_LOGO_PATHS = {
    compact: './Images/branding/wandlight-logo-minimized-256.png',
    expanded: './Images/branding/wandlight-logo-expanded-512.png',
};

function getLocalAssetSrc(assetPath) {
    if (!assetPath) return '';
    try {
        return new URL(assetPath, import.meta.url).href;
    } catch (error) {
        return assetPath;
    }
}

function getTabIconSrc(tabId) {
    return getLocalAssetSrc(TAB_ICON_PATHS[tabId]);
}

function getBrandLogoSrc(railMode) {
    const key = normalizeRailMode(railMode) === 'expanded' ? 'expanded' : 'compact';
    return getLocalAssetSrc(BRAND_LOGO_PATHS[key]);
}

const TAB_TOOLTIPS = {
    session: 'Runtime overview, preset status, instructions, and destructive cleanup actions.',
    continuity: 'Scan, automatically track, view, and edit lightweight live continuity state: scene/timeline, active characters, key items, and active goals/threads.',
    context: 'Detect, automatically update, view, and edit story context: scene date, canon reference point, branch, and source range.',
    lore: 'Generate pending lore, review generated entries, and manage accepted lore with search, filters, tags, pinning, and muting.',
    injection: 'Choose what Wandlight sends to the model: continuity state, lore entries, direct/compressed handling, and live split injection previews.',
};



function getSelectedLoreInjectionCount(state, settings = getSettings()) {
    void settings;
    return getInjectableLoreEntries(state, 0).length;
}

function getInjectionCharacterStats(state, settings = getSettings()) {
    const continuityEnabled = settings.injectContinuity !== false && settings.injectMemo !== false;
    const loreEnabled = settings.injectLore !== false;
    const continuityText = continuityEnabled ? buildContinuityPreview(state, settings.continuityInjectionMode || 'direct') : '';
    const loreText = loreEnabled ? buildLorePreview(state, settings.loreInjectionMode || 'direct') : '';
    return {
        continuityChars: continuityText.length,
        loreChars: loreText.length,
        totalChars: continuityText.length + loreText.length,
        totalTokens: estimateTokens(`${continuityText}
${loreText}`),
    };
}

const LORE_PRIORITY_VALUES = [10, 25, 50, 75, 90, 100];
const LORE_SCOPE_DISPLAY_ORDER = [
    { key: 'characters', label: 'Characters', weight: 80 },
    { key: 'locations', label: 'Locations', weight: 64 },
    { key: 'factions', label: 'Factions', weight: 56 },
    { key: 'objects', label: 'Objects', weight: 48 },
    { key: 'spells', label: 'Spells', weight: 48 },
    { key: 'topics', label: 'Topics', weight: 32 },
    { key: 'eras', label: 'Eras', weight: 24 },
    { key: 'schoolYears', label: 'School years', weight: 24 },
    { key: 'books', label: 'Books', weight: 16 },
];

let activeLoreGenerationController = null;

const ACCEPTED_LORE_INITIAL_VISIBLE_LIMIT = 40;
const ACCEPTED_LORE_PAGE_INCREMENT = 40;
const SEARCH_RENDER_DEBOUNCE_MS = 160;
const MINOR_STATE_SAVE_DEBOUNCE_MS = 350;
const LORE_WORKBENCH_ROW_LIMIT = 500;
const LORE_TIMELINE_MIN_VIEW_MESSAGES = 20;
const LORE_TIMELINE_DEFAULT_VIEW_MESSAGES = 520;
const LORE_TIMELINE_MAX_MAIN_TICKS = 900;
const LORE_TIMELINE_MAX_MINIMAP_TICKS = 1200;

const LORE_TIMELINE_NODE_FILTERS = [
    { id: 'canon_lore', label: 'Canon', short: 'C', color: '#d8a84f' },
    { id: 'story_lore', label: 'Story Lore', short: 'S', color: '#b889ff' },
    { id: 'canon_divergence', label: 'Divergences', short: 'D', color: '#d45a3e' },
    { id: 'character_knowledge', label: 'Knowledge', short: 'K', color: '#6cc0bf' },
    { id: 'location_lore', label: 'Locations', short: 'L', color: '#4d92d8' },
    { id: 'relationship_change', label: 'Relationships', short: 'R', color: '#d18b8b' },
    { id: 'timeline_event', label: 'Timeline Events', short: 'T', color: '#d49c43' },
    { id: 'object_lore', label: 'Objects', short: 'O', color: '#bda463' },
    { id: 'resolved_continuity', label: 'Resolved', short: 'OK', color: '#7ca65a' },
];

const LORE_TIMELINE_NODE_ICON_PATHS = {
    canon_lore: './Images/lore-timeline-icons/canon_lore.svg',
    story_lore: './Images/lore-timeline-icons/story_lore.svg',
    canon_divergence: './Images/lore-timeline-icons/canon_divergence.svg',
    character_knowledge: './Images/lore-timeline-icons/character_knowledge.svg',
    location_lore: './Images/lore-timeline-icons/location_lore.svg',
    relationship_change: './Images/lore-timeline-icons/relationship_change.svg',
    timeline_event: './Images/lore-timeline-icons/timeline_event.svg',
    object_lore: './Images/lore-timeline-icons/object_lore.svg',
    resolved_continuity: './Images/lore-timeline-icons/resolved_continuity.svg',
};

const LORE_TIMELINE_SENDER_PALETTE = [
    '#f2e2bd',
    '#3f8bdc',
    '#b8453d',
    '#bd7e3b',
    '#6a8d49',
    '#5f8680',
    '#8169d8',
    '#c98a52',
    '#9ca6c9',
    '#d0b05e',
];

let searchRenderTimer = null;
let loreWorkbenchSearchTimer = null;
let deferredStateSaveTimer = null;
let deferredStateSaveRef = null;
let loreGenerationUiRunning = false;
let loreWorkbenchOpen = false;
let loreWorkbenchMode = 'accepted';
let loreWorkbenchSelectedId = '';
let loreWorkbenchPendingQuery = '';
let loreWorkbenchFocusSelector = '';
let loreTimelineOpen = false;
let loreTimelineSelectedId = '';
let loreTimelineViewport = null;
let loreTimelineActiveFilters = new Set(LORE_TIMELINE_NODE_FILTERS.map(filter => filter.id));
let canonPreviewUiState = {
    contextKey: '',
    preview: null,
    selectedPackId: '',
    selectedEntryIds: [],
    detailLevel: 'standard',
};

function getLoreRegistry(registryName) {
    const taxonomy = getLoreTaxonomySync();
    return taxonomy?.[registryName] || {};
}

function getLoreRegistryValues(registryName, fallback = []) {
    if (registryName === 'canonStatuses') return ['canon', 'au'];
    if (registryName === 'categories') return LORE_CATEGORY_VALUES;
    const registry = getLoreRegistry(registryName);
    const values = Object.keys(registry);
    return values.length ? values : fallback;
}

function getLoreFieldRegistry(field) {
    if (field === 'category') return 'categories';
    if (field === 'canonStatus') return 'canonStatuses';
    if (field === 'truthStatus') return 'truthStatuses';
    if (field === 'revealPolicy') return 'revealPolicies';
    return '';
}

function getLoreRegistryMeta(registryName, value) {
    const registry = getLoreRegistry(registryName);
    return registry?.[value] || null;
}


function isSectionCollapsed(sectionId, defaultOpen = true) {
    const settings = getSettings();
    const collapsed = settings.collapsedSections || {};
    if (Object.prototype.hasOwnProperty.call(collapsed, sectionId)) {
        return !!collapsed[sectionId];
    }
    return !defaultOpen;
}

function setSectionCollapsed(sectionId, collapsed) {
    const next = getSettings();
    next.collapsedSections = {
        ...(DEFAULT_SETTINGS.collapsedSections || {}),
        ...(next.collapsedSections || {}),
        [sectionId]: !!collapsed,
    };
    saveSettings(next);
}

function createCollapsibleSection(sectionId, titleText, subtitleText, defaultOpen, content, options = {}) {
    const details = document.createElement('details');
    details.className = `wandlight-runtime-card wandlight-collapsible-card ${options.className || ''}`.trim();
    details.open = !isSectionCollapsed(sectionId, defaultOpen);

    const summary = document.createElement('summary');
    summary.className = 'wandlight-collapsible-summary';
    const title = document.createElement('span');
    title.className = 'wandlight-collapsible-title';
    title.textContent = titleText;
    addTooltip(title, options.tooltip || subtitleText || titleText);
    summary.appendChild(title);

    if (subtitleText) {
        const subtitle = document.createElement('span');
        subtitle.className = 'wandlight-collapsible-subtitle';
        subtitle.textContent = subtitleText;
        summary.appendChild(subtitle);
    }
    details.appendChild(summary);

    const wrap = document.createElement('div');
    wrap.className = 'wandlight-collapsible-content';
    const built = typeof content === 'function' ? content() : content;
    if (Array.isArray(built)) {
        for (const item of built) if (item) wrap.appendChild(item);
    } else if (built) {
        wrap.appendChild(built);
    }
    details.appendChild(wrap);

    details.addEventListener('toggle', () => {
        setSectionCollapsed(sectionId, !details.open);
        if (String(sectionId || '').startsWith('lore.')) scheduleAcceptedLoreLayoutUpdate();
    });

    return details;
}

function openPendingLoreReviewSections() {
    setSectionCollapsed('lore.pendingReview', false);
    setSectionCollapsed('lore.basic.pendingReview', false);
}

function getCountLabel(value, label) {
    const count = Array.isArray(value) ? value.length : (value && typeof value === 'object' ? Object.keys(value).length : 0);
    return `${count} ${label}${count === 1 ? '' : 's'}`;
}

function getLoreDisplayLabel(field, value) {
    if (field === 'priority') return `P${value}`;
    const registryName = getLoreFieldRegistry(field);
    const meta = registryName ? getLoreRegistryMeta(registryName, value) : null;
    return meta?.label || CATEGORY_LABELS[value] || String(value || '');
}

function applyLoreRegistryStyle(el, field, value) {
    const registryName = getLoreFieldRegistry(field);
    const meta = registryName ? getLoreRegistryMeta(registryName, value) : null;
    if (!meta) return el;
    if (meta.color) el.style.background = meta.color;
    if (meta.textColor) el.style.color = meta.textColor;
    if (meta.color) el.style.borderColor = meta.color;
    return el;
}

const AUTOMATION_MODES = {
    manual: {
        label: 'Manual',
        description: 'No automatic extraction or lore generation. Use the buttons in this window when you want Wandlight to scan or generate.',
        settings: {
            autoExtract: false,
            autoApplyDelta: false,
            autoGenerateLore: false,
            continuityTrackingMode: 'manual',
            contextDetectionMode: 'manual',
            loreGenerationMode: 'manual',
        },
    },
    assisted: {
        label: 'Assisted',
        description: 'Automatically scans continuity state after turns. Story context and lore generation stay manual.',
        settings: {
            autoExtract: true,
            autoApplyDelta: true,
            autoGenerateLore: false,
            continuityTrackingMode: 'automatic',
            contextDetectionMode: 'manual',
            loreGenerationMode: 'manual',
        },
    },
    automatic: {
        label: 'Automatic',
        description: 'Automatically scans continuity, detects story context, and generates pending lore on their configured intervals. Generated lore still goes to Pending Lore Review in the Lore tab.',
        settings: {
            autoExtract: true,
            autoApplyDelta: true,
            autoGenerateLore: true,
            continuityTrackingMode: 'automatic',
            contextDetectionMode: 'automatic',
            loreGenerationMode: 'automatic',
        },
    },
};

const BASIC_EXPERIENCE_TABS = Object.freeze(['session', 'context', 'lore', 'injection']);
const ADVANCED_EXPERIENCE_TABS = Object.freeze(Object.keys(TAB_LABELS));

function guideStep(id, title, body, tab, target, options = {}) {
    return Object.freeze({
        id,
        title,
        body,
        tab,
        target,
        actionLabel: 'Show',
        ...options,
    });
}

function freezeGuideSteps(steps) {
    return Object.freeze(steps.map(step => Object.freeze(step)));
}

const GUIDE_STEPS = Object.freeze({
    basic: freezeGuideSteps([
        guideStep('active', 'Wandlight Active', 'The master runtime switch. Keep it on when you want Wandlight to select and inject accepted lore.', 'session', 'session.active', {
            expected: 'When enabled, Wandlight can update prompt injection and run any manual tools you click.',
            when: 'Turn it off only when you want the chat to ignore Wandlight without changing saved lore.',
        }),
        guideStep('preset', 'Wandlight Preset Status', 'Shows whether the bundled Wandlight chat preset is installed and current.', 'session', 'session.preset', {
            expected: 'A current preset enables reply headers that make Story Context detection faster.',
            when: 'Check this after installing Wandlight or updating the extension.',
        }),
        guideStep('metrics', 'Session Metrics', 'Summarizes pending lore, accepted lore, selected injection entries, and estimated injected tokens.', 'session', 'session.metrics', {
            expected: 'These numbers tell you whether Wandlight has lore to review and whether lore is being selected for injection.',
            when: 'Use this as a quick health check when the model seems unaware of stored lore.',
        }),
        guideStep('context-detect', 'Detect Story Context', 'Reads recent chat and fills the scene date, canon boundary, and branch fields.', 'context', 'context.detect', {
            expected: 'The fields below update with the current date/canon point. Canon lore suggestions become date-aware.',
            when: 'Run this before canon suggestions and whenever the story jumps dates.',
        }),
        guideStep('context-fields', 'Story Context Fields', 'Manually correct the Scene date, Canon reference point, and Branch when detection is incomplete.', 'context', 'context.fields', {
            expected: 'Manual edits immediately affect canon suggestions and story-lore generation.',
            when: 'Use this for alternate timelines, unclear dates, or scenes where the chat has not stated the date.',
        }),
        guideStep('new-lore', 'New Lore', 'Creates a manual pending lore draft from your own judgment.', 'lore', 'lore.new', {
            expandSections: Object.freeze(['lore.generation']),
            expected: 'The draft enters Pending Lore Review so it can be edited before acceptance.',
            when: 'Use this for important objects, rules, promises, relationships, secrets, or story-specific facts.',
        }),
        guideStep('lore-context', 'Lore Context Status', 'Shows the date and canon reference point used by lore tools on this tab.', 'lore', 'lore.contextStatus', {
            expandSections: Object.freeze(['lore.generation']),
            expected: 'If the context is missing or stale, refresh it before adding canon lore.',
            when: 'Check this before Preview Canon Packs or Scan Story Lore.',
        }),
        guideStep('canon-preview', 'Preview Canon Packs', 'Queries the local canon database without an API call and groups matching entries into packs.', 'lore', 'lore.canon.preview', {
            expandSections: Object.freeze(['lore.generation']),
            expected: 'A preview appears below with selectable date-aware canon constraints.',
            when: 'Use this to add canon guardrails without paying for model generation.',
        }),
        guideStep('canon-results', 'Canon Preview Results', 'Review packs, detail level, selected count, and candidate entries before adding anything.', 'lore', 'lore.canon.previewResults', {
            fallbackTarget: 'lore.canon.preview',
            expandSections: Object.freeze(['lore.generation']),
            expected: 'Selected entries move to Pending Lore Review, not directly into accepted lore.',
            when: 'Use this to avoid adding too many low-value canon entries.',
        }),
        guideStep('story-scan', 'Scan Story Lore', 'Uses the Reasoning provider to extract story-specific lore from recent chat.', 'lore', 'lore.story.scan', {
            expandSections: Object.freeze(['lore.generation']),
            expected: 'Generated entries appear in Pending Lore Review after the scan completes.',
            when: 'Run this after a meaningful amount of new story has happened.',
        }),
        guideStep('pending-workbench', 'Pending Workbench', 'Opens a larger review surface for many pending entries.', 'lore', 'lore.pending.workbench', {
            fallbackTarget: 'lore.pending',
            expandSections: Object.freeze(['lore.basic.pendingReview', 'lore.pendingReview']),
            expected: 'You get denser rows and a detail pane for batch review.',
            when: 'Use this when there are dozens of pending entries.',
        }),
        guideStep('pending-entry', 'Pending Entry Anatomy', 'A pending entry shows title, metadata chips, tags, fact text, routing, and review actions.', 'lore', 'lore.pending.entry', {
            fallbackTarget: 'lore.pending',
            expandSections: Object.freeze(['lore.basic.pendingReview', 'lore.pendingReview']),
            expected: 'Accept durable lore. Dismiss recap facts or entries that are not useful for future prompting.',
            when: 'Use this every time generated or canon lore is proposed.',
        }),
        guideStep('pending-bulk', 'Pending Bulk Actions', 'Select, apply, or dismiss groups of pending lore entries.', 'lore', 'lore.pending.bulk', {
            fallbackTarget: 'lore.pending',
            expandSections: Object.freeze(['lore.basic.pendingReview', 'lore.pendingReview']),
            expected: 'Bulk actions process only selected entries unless you choose Apply All or Dismiss All.',
            when: 'Use this after scanning a large range or adding a whole canon pack.',
        }),
        guideStep('accepted-filters', 'Accepted Lore Filters', 'Search and filter accepted entries by category or source.', 'lore', 'lore.accepted.filters', {
            fallbackTarget: 'lore.accepted',
            expandSections: Object.freeze(['lore.basic.acceptedEntries', 'lore.acceptedEntries']),
            expected: 'Only matching accepted entries remain visible.',
            when: 'Use this once accepted lore grows beyond a small handful of entries.',
        }),
        guideStep('accepted-entry', 'Accepted Entry Controls', 'Accepted entries can be expanded, edited, retagged, pinned, muted, and assigned relevance.', 'lore', 'lore.accepted.entry', {
            fallbackTarget: 'lore.accepted',
            expandSections: Object.freeze(['lore.basic.acceptedEntries', 'lore.acceptedEntries']),
            expected: 'Pin prioritizes an entry. Mute stores it but excludes it from injection.',
            when: 'Use this to keep high-value lore precise and remove noise from prompt injection.',
        }),
        guideStep('accepted-workbench', 'Accepted Workbench', 'Opens large-list management for accepted lore.', 'lore', 'lore.accepted.workbench', {
            fallbackTarget: 'lore.accepted',
            expandSections: Object.freeze(['lore.basic.acceptedEntries', 'lore.acceptedEntries']),
            expected: 'You get dense rows, filters, bulk actions, and a detail pane.',
            when: 'Use this for large accepted-lore sets.',
        }),
        guideStep('inject-lore-toggle', 'Inject Lore Toggle', 'Controls whether accepted lore is sent into the next roleplay prompt.', 'injection', 'injection.loreToggle', {
            expected: 'When on, enabled relevance tiers can contribute prompt text.',
            when: 'Turn this off if you want to store lore but keep it out of the current prompt.',
        }),
        guideStep('high-tier', 'High-Relevance Lore', 'Immediate scene-critical lore. This tier is closest to the latest prompt context.', 'injection', 'injection.tier.high', {
            expected: 'High lore should usually stay direct unless it becomes very large.',
            when: 'Use this for current secrets, active objects, live promises, and scene-critical constraints.',
        }),
        guideStep('normal-tier', 'Normal-Relevance Lore', 'Useful background lore that may matter soon but is not the current scene focus.', 'injection', 'injection.tier.normal', {
            expected: 'Normal lore can be direct or compressed depending on token pressure.',
            when: 'Use this for recent relationship changes, recurring facts, and branch-defining context.',
        }),
        guideStep('low-tier', 'Low-Relevance Lore', 'Longer-range background lore. Basic defaults keep this conservative.', 'injection', 'injection.tier.low', {
            expected: 'Low lore is often disabled or compressed unless the scene needs broad context.',
            when: 'Use this for distant history or low-priority world state.',
        }),
    ]),
    advanced: freezeGuideSteps([
        guideStep('experience-mode', 'Experience Mode', 'Switches between focused Basic controls and the full Advanced toolset.', 'session', 'session.experienceMode', {
            expected: 'Basic applies a simpler profile. Advanced restores detailed controls and backed-up settings.',
            when: 'Use Advanced when you need automation, continuity tuning, workbenches, timeline, or placement control.',
        }),
        guideStep('automation-mode', 'Automation Mode', 'Chooses whether Wandlight stays manual, scans continuity automatically, or runs broader automation.', 'session', 'session.automation', {
            expected: 'Manual only runs when clicked. Assisted tracks continuity. Automatic also runs context/lore automation.',
            when: 'Use Manual while configuring; use Assisted or Automatic once settings are stable.',
        }),
        guideStep('active', 'Wandlight Active', 'The master runtime switch for Wandlight behavior.', 'session', 'session.active', {
            expected: 'When enabled, prompt injection and configured automation can run.',
            when: 'Use this to pause Wandlight without deleting state.',
        }),
        guideStep('preset', 'Wandlight Preset', 'Detects whether the bundled Wandlight preset is installed and current.', 'session', 'session.preset', {
            expected: 'Install/update from here, then verify your SillyTavern connection profile if the preset changed it.',
            when: 'Check this after extension updates or when fast context detection fails.',
        }),
        guideStep('metrics', 'Session Metrics', 'Shows pending continuity, pending lore, accepted lore, selected injection count, and injection token estimate.', 'session', 'session.metrics', {
            expected: 'These values help diagnose whether Wandlight has data and whether it is injecting data.',
            when: 'Use this as a quick runtime status check.',
        }),
        guideStep('context-automation', 'Context Automation', 'Controls whether Story Context detection runs only on click or automatically after turns.', 'context', 'context.automation', {
            expected: 'Automatic detection can keep dates current, especially with the Wandlight preset header format.',
            when: 'Use automatic detection if your story frequently moves scenes or dates.',
        }),
        guideStep('fast-header', 'Fast Header Detection', 'Scans recent model reply headers for date/time/location/weather before using a model call.', 'context', 'context.fastHeader', {
            expected: 'If a valid header is found, Wandlight updates Story Context locally and skips provider cost.',
            when: 'Use this with the Wandlight preset.',
        }),
        guideStep('context-window', 'Context Source Messages', 'Controls how many recent chat messages are scanned for headers or sent to model fallback.', 'context', 'context.sourceMessages', {
            expected: 'Larger windows improve detection but cost more time when model fallback is needed.',
            when: 'Increase it if context detection misses dates stated earlier in the scene.',
        }),
        guideStep('context-detect', 'Detect Story Context', 'Runs context detection immediately.', 'context', 'context.detect', {
            expected: 'Scene date, canon boundary, branch, and detection timestamp update below.',
            when: 'Run before canon suggestions or after timeline jumps.',
        }),
        guideStep('context-fields', 'Story Context Editor', 'Manually correct context fields when detection is ambiguous or the story is alternate-universe.', 'context', 'context.fields', {
            expected: 'Manual edits immediately affect generation and canon pack previews.',
            when: 'Use this for branches, time travel, unclear dates, or custom fanfiction canon points.',
        }),
        guideStep('continuity-automation', 'Continuity Automation', 'Controls whether continuity state scanning is manual or turn-interval based.', 'continuity', 'continuity.automation', {
            expected: 'Automatic scans update lightweight scene state at the configured interval.',
            when: 'Use this when you want Wandlight to maintain current-scene state in the background.',
        }),
        guideStep('continuity-scope', 'Continuity Scan Scope', 'Chooses recent, custom, or entire-chat scanning for continuity state.', 'continuity', 'continuity.scanScope', {
            expandSections: Object.freeze(['continuity.scanScope']),
            expected: 'Recent is best for maintenance. Custom or entire chat is for backfill.',
            when: 'Use custom ranges when a specific section of chat needs recovery.',
        }),
        guideStep('continuity-performance', 'Continuity Performance', 'Controls chunking, overlap, parallelism, retry behavior, and checkpoint recovery.', 'continuity', 'continuity.performance', {
            expandSections: Object.freeze(['continuity.scanPerformance']),
            expected: 'Smaller chunks are more reliable; higher concurrency is faster but heavier.',
            when: 'Tune this for large stories or provider instability.',
        }),
        guideStep('continuity-run', 'Scan Continuity State', 'Runs the adaptive continuity scanner now.', 'continuity', 'continuity.scan.button', {
            fallbackTarget: 'continuity.scan',
            expected: 'Continuity sections update with current scene, cast, items, and active threads.',
            when: 'Run after a scene changes or after a long section of roleplay.',
        }),
        guideStep('tracked-sections', 'Tracked Sections', 'Enables or disables which continuity state sections are updated and injected.', 'continuity', 'continuity.trackedSections', {
            expandSections: Object.freeze(['continuity.trackedSections']),
            expected: 'Disabled sections preserve saved data but stop being scanned and injected.',
            when: 'Use this to reduce noise or keep only the continuity sections you care about.',
        }),
        guideStep('character-fields', 'Active Character Fields', 'Appearance Detail and Emotional State are child fields inside Active Characters, not separate top-level continuity sections.', 'continuity', 'continuity.characterFields', {
            expandSections: Object.freeze(['continuity.trackedSections']),
            expected: 'Disabling a child field preserves saved values but prevents scans and injection from treating that field as live state.',
            when: 'Use this when clothing or emotion should stop influencing the next prompt without deleting character state.',
        }),
        guideStep('emotional-freshness', 'Emotional State Freshness', 'Controls how long emotional state is injected as current, recent, or omitted as stale.', 'continuity', 'continuity.emotionalState', {
            expandSections: Object.freeze(['continuity.trackedSections']),
            expected: 'Old emotions decay by message age so characters can naturally move out of prior moods.',
            when: 'Tune this if characters seem emotionally stuck or if scans run infrequently.',
        }),
        guideStep('scene-editor', 'Scene and Timeline', 'Edits current date, location, activity, and timeline state.', 'continuity', 'continuity.scene', {
            expandSections: Object.freeze(['continuity.canonScene']),
            expected: 'This is immediate state, not permanent lore.',
            when: 'Use this to correct the next-scene anchor.',
        }),
        guideStep('character-editor', 'Active Characters', 'Tracks current cast state such as posture, emotions, appearance, and immediate goals.', 'continuity', 'continuity.characters', {
            expandSections: Object.freeze(['continuity.characters']),
            expected: 'The model receives current-state cues without needing a full summary.',
            when: 'Use this for scene-level character state that should not become durable lore.',
        }),
        guideStep('character-emotion-summary', 'Emotional State Summary', 'Shows saved emotional state inside Active Characters and labels it as current, recent, stale, or disabled.', 'continuity', 'continuity.emotionalStateSummary', {
            expandSections: Object.freeze(['continuity.characters']),
            expected: 'Emotion remains visible for review while stale values stop acting like permanent character mood.',
            when: 'Use this to verify whether a character emotion is fresh enough to influence injection.',
        }),
        guideStep('items-editor', 'Key Items', 'Tracks consequential current items and object status.', 'continuity', 'continuity.items', {
            expandSections: Object.freeze(['continuity.inventory']),
            expected: 'Current item state stays available for continuity injection.',
            when: 'Use this for items currently affecting the scene.',
        }),
        guideStep('threads-editor', 'Active Goals and Threads', 'Tracks immediate unresolved goals and active story threads.', 'continuity', 'continuity.threads', {
            expandSections: Object.freeze(['continuity.activeGoalsThreads']),
            expected: 'The model gets concise reminders of current objectives.',
            when: 'Use this for short-term direction rather than permanent lore.',
        }),
        guideStep('timeline-summary', 'Lore Timeline Summary', 'Shows accepted-lore change history and opens the full timeline visualizer.', 'lore', 'lore.timeline', {
            expected: 'Creation, update, deletion, restoration, pin, mute, and metadata events are tracked.',
            when: 'Use this to audit or recover lore changes.',
        }),
        guideStep('timeline-open', 'Open Timeline', 'Opens the full Lore Timeline window.', 'lore', 'lore.timeline.open', {
            fallbackTarget: 'lore.timeline',
            expected: 'The visualizer can inspect lore events and restore entries back to pending review.',
            when: 'Use this for recovery or timeline-aware lore audits.',
        }),
        guideStep('new-lore', 'New Lore', 'Creates a manual lore draft with title, text, injection override, notes, tags, and metadata.', 'lore', 'lore.new', {
            expected: 'The draft goes to Pending Lore Review for editing and acceptance.',
            when: 'Use this when you know a detail should be remembered without running a model scan.',
        }),
        guideStep('lore-context', 'Lore Context Status', 'Shows the Story Context currently driving lore tools.', 'lore', 'lore.contextStatus', {
            expandSections: Object.freeze(['lore.generation']),
            expected: 'Context should be current before canon preview or story-lore scan.',
            when: 'Use this as the Lore tab’s context sanity check.',
        }),
        guideStep('canon-preview', 'Preview Canon Packs', 'Runs the local canon database query and builds selectable lore packs.', 'lore', 'lore.canon.preview', {
            expandSections: Object.freeze(['lore.generation']),
            expected: 'No provider call is used. Results are grouped by relevance and pack.',
            when: 'Use this for date-aware canon guardrails.',
        }),
        guideStep('canon-detail', 'Canon Detail Level', 'Filters canon preview results from Core to All Active.', 'lore', 'lore.canon.detailFilter', {
            fallbackTarget: 'lore.canon.preview',
            expandSections: Object.freeze(['lore.generation']),
            expected: 'Higher detail shows more low-priority constraints.',
            when: 'Use Core/Standard for regular play; use Detailed/All when auditing.',
        }),
        guideStep('canon-packs', 'Canon Pack Selection', 'Switches between grouped canon packs for the current Story Context.', 'lore', 'lore.canon.packGrid', {
            fallbackTarget: 'lore.canon.preview',
            expandSections: Object.freeze(['lore.generation']),
            expected: 'Only the active pack’s entries are shown below.',
            when: 'Use packs to add focused canon sets instead of dumping everything.',
        }),
        guideStep('canon-add', 'Add Canon to Pending', 'Adds selected or pack-wide canon entries to Pending Lore Review.', 'lore', 'lore.canon.addPending', {
            fallbackTarget: 'lore.canon.preview',
            expandSections: Object.freeze(['lore.generation']),
            expected: 'Added entries remain pending until explicitly accepted.',
            when: 'Use selected entries for precision; pack add for trusted small packs.',
        }),
        guideStep('canon-settings', 'Canon Suggestion Settings', 'Controls local canon database use, auto-suggest behavior, and quick-add cap.', 'lore', 'lore.canon.settings', {
            expandSections: Object.freeze(['lore.generation', 'lore.canonSuggestionSettings']),
            expected: 'These settings affect preview/quick-add behavior, not story-lore model scans.',
            when: 'Use this to tune canon suggestions after context detection.',
        }),
        guideStep('story-scan', 'Scan Story Lore', 'Runs model-based extraction for story-specific lore.', 'lore', 'lore.story.scan', {
            expandSections: Object.freeze(['lore.generation']),
            expected: 'Results are chunked, checkpointed, and added to Pending Lore Review.',
            when: 'Use after substantial new story content or for backfilling old chats.',
        }),
        guideStep('story-scope', 'Story Lore Scan Scope', 'Chooses recent, custom range, or entire-chat story-lore scanning.', 'lore', 'lore.story.scope', {
            expandSections: Object.freeze(['lore.generation', 'lore.storyGenerationSettings', 'lore.story.scanScope']),
            expected: 'Recent is maintenance. Custom and entire chat are backfill tools.',
            when: 'Use custom ranges for targeted extraction.',
        }),
        guideStep('story-performance', 'Story Lore Performance', 'Controls chunk size, overlap, concurrency, retries, checkpoint cadence, and consolidation.', 'lore', 'lore.story.performance', {
            expandSections: Object.freeze(['lore.generation', 'lore.storyGenerationSettings', 'lore.story.performance']),
            expected: 'Lower chunk size and concurrency improve reliability; higher values speed up strong providers.',
            when: 'Tune this for large scans or provider rate limits.',
        }),
        guideStep('story-quality', 'Story Lore Quality', 'Controls scan breadth, fact targets, generated tags, duplicate guard, similarity routing, and quality gate.', 'lore', 'lore.story.quality', {
            expandSections: Object.freeze(['lore.generation', 'lore.storyGenerationSettings', 'lore.story.quality']),
            expected: 'Quality controls shape what becomes Pending Lore, but users still review entries.',
            when: 'Use this when scans produce too much recap or miss important story-specific facts.',
        }),
        guideStep('story-automation', 'Story Lore Automation', 'Runs story-lore scans after enough words or turns have accumulated.', 'lore', 'lore.story.automation', {
            expandSections: Object.freeze(['lore.generation', 'lore.storyGenerationSettings', 'lore.story.automation']),
            expected: 'Automatic scans remain conservative and still route entries to Pending Lore Review.',
            when: 'Use after the prompt and quality settings are stable.',
        }),
        guideStep('pending-entry', 'Pending Entry Anatomy', 'Shows generated operation, quality route, similarity route, relevance, priority, tags, fact, injection text, and review actions.', 'lore', 'lore.pending.entry', {
            fallbackTarget: 'lore.pending',
            expandSections: Object.freeze(['lore.pendingReview']),
            expected: 'Apply good durable lore; dismiss recap or low-value entries.',
            when: 'Use this for every canon or generated proposal.',
        }),
        guideStep('pending-actions', 'Pending Entry Actions', 'Applies, updates, separates, or dismisses a single pending entry.', 'lore', 'lore.pending.actions', {
            fallbackTarget: 'lore.pending.entry',
            expandSections: Object.freeze(['lore.pendingReview']),
            expected: 'Similarity-routed updates can merge into existing lore or be kept as new.',
            when: 'Use single-entry actions when batch acceptance would be too blunt.',
        }),
        guideStep('pending-bulk', 'Pending Bulk Actions', 'Selects and processes many pending entries at once.', 'lore', 'lore.pending.bulk', {
            fallbackTarget: 'lore.pending',
            expandSections: Object.freeze(['lore.pendingReview']),
            expected: 'Bulk actions respect current selection.',
            when: 'Use after reviewing a batch from canon preview or story scan.',
        }),
        guideStep('pending-workbench', 'Pending Workbench', 'Opens a larger pending-lore review workspace.', 'lore', 'lore.pending.workbench', {
            fallbackTarget: 'lore.pending',
            expandSections: Object.freeze(['lore.pendingReview']),
            expected: 'Dense rows and a detail pane make large batches practical.',
            when: 'Use this when the drawer list is too cramped.',
        }),
        guideStep('accepted-tabs', 'Accepted Category Tabs', 'Filters accepted lore by category, relevance, pin/mute state, and generated categories.', 'lore', 'lore.accepted.categoryTabs', {
            fallbackTarget: 'lore.accepted',
            expandSections: Object.freeze(['lore.acceptedEntries']),
            expected: 'The accepted list updates without leaving the Lore tab.',
            when: 'Use tabs to quickly isolate a type of lore.',
        }),
        guideStep('accepted-filters', 'Accepted Search and Source Filter', 'Searches accepted lore and filters by Canon Database, Story Generation, or Manual source.', 'lore', 'lore.accepted.filters', {
            fallbackTarget: 'lore.accepted',
            expandSections: Object.freeze(['lore.acceptedEntries']),
            expected: 'Only matching entries render in the accepted list.',
            when: 'Use this for cleanup or when finding a specific entry.',
        }),
        guideStep('accepted-pin-mute', 'Pin, Mute, and Relevance', 'Pin prioritizes, mute excludes from injection, and relevance assigns prompt tier.', 'lore', 'lore.accepted.pinMuteHelp', {
            fallbackTarget: 'lore.accepted',
            expandSections: Object.freeze(['lore.acceptedEntries']),
            expected: 'These controls determine what lore is stored versus injected.',
            when: 'Use this to reduce prompt noise without deleting lore.',
        }),
        guideStep('accepted-bulk', 'Accepted Bulk Edit', 'Bulk pin, mute, retag, reprioritize, or delete selected accepted entries.', 'lore', 'lore.accepted.bulk', {
            fallbackTarget: 'lore.accepted',
            expandSections: Object.freeze(['lore.acceptedEntries']),
            expected: 'Bulk changes are recorded in Lore Timeline.',
            when: 'Use this for large cleanup passes.',
        }),
        guideStep('accepted-entry', 'Accepted Entry Editor', 'Expand an entry to edit text, injection override, notes, metadata chips, tags, and priority.', 'lore', 'lore.accepted.entry', {
            fallbackTarget: 'lore.accepted',
            expandSections: Object.freeze(['lore.acceptedEntries']),
            expected: 'Saved edits update the accepted lore matrix and timeline.',
            when: 'Use this to refine generated entries into high-value durable lore.',
        }),
        guideStep('accepted-workbench', 'Accepted Workbench', 'Opens a full accepted-lore management window.', 'lore', 'lore.accepted.workbench', {
            fallbackTarget: 'lore.accepted',
            expandSections: Object.freeze(['lore.acceptedEntries']),
            expected: 'Use dense rows, filters, bulk tools, and detail editing in a larger surface.',
            when: 'Use for large accepted-lore collections.',
        }),
        guideStep('auto-toggle', 'Auto-Relevance Toggle', 'Enables periodic local relevance scoring for accepted lore.', 'lore', 'lore.autoRelevance.toggle', {
            fallbackTarget: 'lore.autoRelevance',
            expandSections: Object.freeze(['lore.autoRelevance']),
            expected: 'Auto-Relevance can suggest or apply tier changes, but does not pin or mute entries.',
            when: 'Use when accepted lore grows large enough that manual tiering is tedious.',
        }),
        guideStep('auto-mode', 'Auto-Relevance Mode', 'Chooses whether to suggest changes for review or apply high-confidence changes.', 'lore', 'lore.autoRelevance.mode', {
            fallbackTarget: 'lore.autoRelevance',
            expandSections: Object.freeze(['lore.autoRelevance']),
            expected: 'Suggest mode is safer. Apply high-confidence reduces review work.',
            when: 'Start with Suggest until you trust the tuning.',
        }),
        guideStep('auto-tuning', 'Auto-Relevance Tuning', 'Controls scan interval, recent-message window, candidate cap, and confidence threshold.', 'lore', 'lore.autoRelevance.tuning', {
            fallbackTarget: 'lore.autoRelevance',
            expandSections: Object.freeze(['lore.autoRelevance']),
            expected: 'Higher caps are broader but heavier; higher confidence is more conservative.',
            when: 'Use this to balance responsiveness and noise.',
        }),
        guideStep('auto-model', 'Utility Provider Adjudication', 'Optionally asks the Utility provider to review locally scored relevance candidates.', 'lore', 'lore.autoRelevance.model', {
            fallbackTarget: 'lore.autoRelevance',
            expandSections: Object.freeze(['lore.autoRelevance']),
            expected: 'Only the candidate subset is sent to the model.',
            when: 'Use when local scoring is not nuanced enough.',
        }),
        guideStep('injection-toggles', 'Injection Toggles', 'Turns Continuity and Lore injection on or off independently.', 'injection', 'injection.toggles', {
            expected: 'Disabled blocks remain editable but are not sent.',
            when: 'Use this to isolate whether continuity or lore is affecting model behavior.',
        }),
        guideStep('prompt-placement', 'Prompt Placement', 'Sets injection method, role, position, and depth for each prompt group.', 'injection', 'injection.promptPlacement', {
            expandSections: Object.freeze(['injection.promptPlacement']),
            expected: 'Depth 0 is closest to the latest chat message; larger depths place blocks earlier.',
            when: 'Use this to tune how strongly each prompt block influences the model.',
        }),
        guideStep('continuity-injection', 'Continuity Injection Preview', 'Shows the current continuity block and its direct/compressed handling controls.', 'injection', 'injection.preview.continuity', {
            expected: 'This is the actual continuity text Wandlight plans to send.',
            when: 'Use this to verify current-scene state before prompting.',
        }),
        guideStep('high-injection', 'High-Relevance Lore Injection', 'Shows scene-critical accepted lore and direct/compressed handling.', 'injection', 'injection.preview.high', {
            expected: 'High lore should stay close and usually direct unless token pressure is high.',
            when: 'Use this for immediately relevant constraints.',
        }),
        guideStep('normal-injection', 'Normal-Relevance Lore Injection', 'Shows useful background lore selected for the Normal tier.', 'injection', 'injection.preview.normal', {
            expected: 'Normal tier can carry broader context at a deeper prompt position.',
            when: 'Use this for medium-range context.',
        }),
        guideStep('low-injection', 'Low-Relevance Lore Injection', 'Shows distant background lore selected for the Low tier.', 'injection', 'injection.preview.low', {
            expected: 'Low tier is safest compressed or disabled unless broad context matters.',
            when: 'Use this when distant context is still useful.',
        }),
        guideStep('compression-prompts', 'Compression Prompts', 'Edits prompt templates used to compress continuity and relevance-tiered lore.', 'injection', 'injection.compression', {
            expandSections: Object.freeze(['injection.compressionPrompts']),
            expected: 'Reset restores defaults; copy helps audit prompts.',
            when: 'Use this when compression output needs better style or stricter constraints.',
        }),
    ]),
});

const GUIDE_CONTENT = Object.freeze({
    basic: Object.freeze({
        title: 'Getting Started',
        subtitle: 'first steps',
        tooltip: 'A short guided setup for core Wandlight use.',
        lede: 'Start with story context, add reviewable lore, accept what matters, then check what Wandlight will send into the next prompt.',
        note: 'The chat remains the source of truth. Wandlight keeps the useful details editable, searchable, and ready for injection.',
        tourLabel: 'Start Walkthrough',
    }),
    advanced: Object.freeze({
        title: 'Wandlight Guide',
        subtitle: 'workflow + tools',
        tooltip: 'A guided map of Wandlight runtime tools and configuration areas.',
        lede: 'Use this guide to move through automation, context, continuity, lore generation, review, timeline recovery, and injection controls.',
        note: '',
        tourLabel: 'Start Advanced Walkthrough',
    }),
});

let activeWandlightTour = null;

let panelRoot = null;
let isDragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;

let isResizing = false;
let resizeStartX = 0;
let resizeStartY = 0;
let resizeStartWidth = 0;
let resizeStartHeight = 0;
let resizeStartDirection = 'right';

let floatingTooltip = null;
let tooltipAnchor = null;

// Public runtime ------------------------------------------------------------

export function showLorePanel() {
    const state = getState();
    if (state?.lorePanel) {
        state.lorePanel.isOpen = true;
        normalizePanelLayoutState(state, { persistLegacyOpenState: true });
        saveState(state);
    }

    removeLorePanel();

    const freshState = getState();
    normalizePanelLayoutState(freshState, { persistLegacyOpenState: true });
    const panelState = freshState?.lorePanel || getDefaultState().lorePanel;

    panelRoot = document.createElement('div');
    panelRoot.id = PANEL_ID;
    panelRoot.className = 'wandlight-lore-panel wandlight-runtime-shell';
    applyRuntimeShellGeometry(panelRoot, panelState);

    renderPanelShell(panelRoot, freshState);
    document.body.appendChild(panelRoot);

    requestAnimationFrame(() => {
        clampRuntimeShellToViewport();
        updateAcceptedLoreScrollRegionHeight();
    });
}

export function hideLorePanel() {
    closeWandlightTour();
    closeLoreWorkbench();
    removeLorePanel();
    const state = getState();
    if (state?.lorePanel) {
        state.lorePanel.isOpen = false;
        saveState(state);
    }
}

export function refreshLorePanel() {
    const existing = document.getElementById(PANEL_ID);
    if (!existing) return;

    const state = getState();
    if (!state?.lorePanel?.isOpen) {
        closeWandlightTour();
        removeLorePanel();
        return;
    }

    normalizePanelLayoutState(state);
    const hasDrawer = !!existing.querySelector('.wandlight-runtime-drawer');
    if ((state.lorePanel.drawerOpen === true) !== hasDrawer) {
        renderPanelShell(existing, state);
        return;
    }
    refreshPanelBody({ preserveScroll: true });
    refreshHeader();
}

function removeLorePanel() {
    if (panelRoot) {
        panelRoot.remove();
        panelRoot = null;
    }
    const existing = document.getElementById(PANEL_ID);
    if (existing) existing.remove();
}

// Shell -----------------------------------------------------------------------

function renderPanelShell(root, state) {
    normalizePanelLayoutState(state);
    const panelState = state?.lorePanel || getDefaultState().lorePanel;
    const railMode = normalizeRailMode(panelState.railMode);
    const drawerOpen = panelState.drawerOpen === true;
    const drawerDirection = drawerOpen ? resolveDrawerDirection(panelState) : 'right';

    root.innerHTML = '';
    root.className = 'wandlight-lore-panel wandlight-runtime-shell';
    root.classList.add(`wandlight-runtime-rail-${railMode}`);
    if (drawerOpen) root.classList.add('wandlight-runtime-drawer-open');
    root.dataset.railMode = railMode;
    root.dataset.drawerDirection = drawerDirection;
    root.style.setProperty('--wandlight-rail-width', `${getRailWidth(panelState)}px`);
    root.style.setProperty('--wandlight-drawer-width', `${getConstrainedDrawerWidth(panelState, drawerDirection)}px`);
    root.style.setProperty('--wandlight-drawer-height', `${getConstrainedDrawerHeight(panelState)}px`);

    root.appendChild(renderRail(state));
    if (drawerOpen) root.appendChild(renderDrawer(state, drawerDirection));

    refreshHeader();
}

function renderRail(state) {
    const panelState = state?.lorePanel || getDefaultState().lorePanel;
    const railMode = normalizeRailMode(panelState.railMode);
    const drawerOpen = panelState.drawerOpen === true;
    const settings = getSettings();
    const activeTab = normalizeTabForExperience(panelState.activeTab, settings);
    const metrics = getRailMetrics(state, settings);

    const rail = document.createElement('div');
    rail.className = `wandlight-runtime-rail wandlight-runtime-rail-${railMode}`;

    const drag = document.createElement('div');
    drag.className = 'wandlight-runtime-rail-drag';
    drag.addEventListener('mousedown', onDragStart);
    addTooltip(drag, 'Drag to move the Wandlight rail. The drawer stays anchored to this rail.');

    const mark = document.createElement('div');
    mark.className = 'wandlight-runtime-rail-mark';

    const markImg = document.createElement('img');
    markImg.className = 'wandlight-runtime-rail-logo-img';
    markImg.src = getBrandLogoSrc(railMode);
    markImg.alt = railMode === 'compact' ? 'Wandlight' : 'Wandlight logo';
    markImg.draggable = false;
    markImg.addEventListener('error', () => {
        markImg.remove();
        mark.textContent = railMode === 'compact' ? 'W' : 'Wandlight';
        mark.classList.add('wandlight-runtime-rail-mark-fallback');
    }, { once: true });
    mark.appendChild(markImg);
    drag.appendChild(mark);

    const sub = document.createElement('div');
    sub.className = 'wandlight-runtime-rail-subtitle';
    sub.textContent = '';
    drag.appendChild(sub);
    rail.appendChild(drag);
    rail.appendChild(createExperienceModeSwitch(settings));

    const tabs = document.createElement('div');
    tabs.className = 'wandlight-runtime-rail-tabs';
    for (const tabId of getVisibleTabsForExperience(settings)) {
        const label = TAB_LABELS[tabId];
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'wandlight-runtime-rail-tab';
        tab.dataset.tabId = tabId;
        if (drawerOpen && tabId === activeTab) tab.classList.add('wandlight-runtime-rail-tab-active');
        addTooltip(tab, TAB_TOOLTIPS[tabId]);

        const icon = document.createElement('span');
        icon.className = 'wandlight-runtime-rail-icon';
        icon.dataset.fallbackIcon = TAB_ICONS[tabId] || label.slice(0, 1);
        const iconSrc = getTabIconSrc(tabId);
        if (iconSrc) {
            const iconImg = document.createElement('img');
            iconImg.className = 'wandlight-runtime-rail-icon-img';
            iconImg.src = iconSrc;
            iconImg.alt = '';
            iconImg.draggable = false;
            iconImg.addEventListener('error', () => {
                icon.classList.add('wandlight-runtime-rail-icon-missing');
                icon.textContent = TAB_ICONS[tabId] || label.slice(0, 1);
            }, { once: true });
            icon.appendChild(iconImg);
        } else {
            icon.textContent = TAB_ICONS[tabId] || label.slice(0, 1);
        }
        tab.appendChild(icon);

        const labelEl = document.createElement('span');
        labelEl.className = 'wandlight-runtime-rail-label';
        labelEl.textContent = label;
        tab.appendChild(labelEl);

        const metric = document.createElement('span');
        metric.className = 'wandlight-runtime-rail-metric';
        metric.dataset.tabId = tabId;
        metric.textContent = metrics[tabId] || '';
        tab.appendChild(metric);

        tab.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleDrawerForTab(tabId);
        });
        tabs.appendChild(tab);
    }
    rail.appendChild(tabs);

    const controls = document.createElement('div');
    controls.className = 'wandlight-runtime-rail-controls';

    const density = createIconButton(
        railMode === 'compact' ? '>' : '<',
        railMode === 'compact' ? 'Show labels and compact metrics.' : 'Use icons only.',
        'wandlight-runtime-rail-control wandlight-runtime-rail-density',
        (e) => {
            e.stopPropagation();
            toggleRailMode();
        }
    );
    controls.appendChild(density);

    const close = createIconButton(
        'x',
        'Close the Wandlight rail. Use /wandlight-lore-panel or the extension launcher to reopen it.',
        'wandlight-runtime-rail-control wandlight-runtime-rail-close',
        (e) => {
            e.stopPropagation();
            hideLorePanel();
        }
    );
    controls.appendChild(close);
    rail.appendChild(controls);

    return rail;
}

function createExperienceModeSwitch(settings = getSettings()) {
    const mode = normalizeExperienceMode(settings.experienceMode);
    const control = document.createElement('div');
    control.className = `wandlight-experience-switch wandlight-experience-switch-${mode}`;
    markTourTarget(control, 'session.experienceMode');
    control.setAttribute('role', 'radiogroup');
    control.setAttribute('aria-label', `Experience Mode: ${getExperienceLabel(settings)}`);
    addTooltip(control, getExperienceTooltip(settings));

    const basic = document.createElement('button');
    basic.type = 'button';
    basic.className = 'wandlight-experience-switch-label wandlight-experience-switch-label-basic';
    basic.textContent = 'Basic';
    basic.setAttribute('role', 'radio');
    basic.setAttribute('aria-checked', mode === 'basic' ? 'true' : 'false');
    addTooltip(basic, 'Switch to Basic Experience.');
    basic.addEventListener('click', (event) => {
        event.stopPropagation();
        selectExperienceMode('basic');
    });
    control.appendChild(basic);

    const advanced = document.createElement('button');
    advanced.type = 'button';
    advanced.className = 'wandlight-experience-switch-label wandlight-experience-switch-label-advanced';
    advanced.textContent = 'Advanced';
    advanced.setAttribute('role', 'radio');
    advanced.setAttribute('aria-checked', mode === 'advanced' ? 'true' : 'false');
    addTooltip(advanced, 'Switch to Advanced Experience.');
    advanced.addEventListener('click', (event) => {
        event.stopPropagation();
        selectExperienceMode('advanced');
    });
    control.appendChild(advanced);

    const knob = document.createElement('span');
    knob.className = 'wandlight-experience-switch-knob';
    control.appendChild(knob);

    return control;
}

function selectExperienceMode(mode) {
    const normalized = normalizeExperienceMode(mode);
    const current = normalizeExperienceMode(getSettings().experienceMode);
    if (current === normalized) return;
    setExperienceMode(normalized);
    showLorePanel();
    toast(`Experience Mode set to ${normalized === 'advanced' ? 'Advanced' : 'Basic'}.`, 'info');
}

function renderDrawer(state, direction = 'right') {
    const panelState = state?.lorePanel || getDefaultState().lorePanel;
    const activeTab = normalizeTabForExperience(panelState.activeTab);

    const drawer = document.createElement('div');
    drawer.className = `wandlight-runtime-drawer wandlight-runtime-drawer-${direction}`;
    drawer.style.width = `${getConstrainedDrawerWidth(panelState, direction)}px`;
    drawer.style.height = `${getConstrainedDrawerHeight(panelState)}px`;

    const header = document.createElement('div');
    header.className = 'wandlight-runtime-drawer-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'wandlight-lore-panel-title-wrap';
    const title = document.createElement('div');
    title.className = 'wandlight-lore-panel-title wandlight-runtime-drawer-title';
    title.textContent = TAB_LABELS[activeTab] || 'Wandlight';
    addTooltip(title, TAB_TOOLTIPS[activeTab] || 'Wandlight runtime drawer.');
    titleWrap.appendChild(title);

    const status = document.createElement('div');
    status.className = 'wandlight-lore-panel-status wandlight-runtime-drawer-status';
    titleWrap.appendChild(status);
    header.appendChild(titleWrap);

    drawer.appendChild(header);

    const body = document.createElement('div');
    body.className = 'wandlight-lore-panel-body';
    drawer.appendChild(body);
    renderPanelBody(body, state);

    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'wandlight-lore-panel-resize-handle wandlight-runtime-drawer-resize-handle';
    resizeHandle.addEventListener('pointerdown', onResizeStart);
    addTooltip(resizeHandle, 'Drag to resize the active drawer. The size is remembered across tabs.');
    drawer.appendChild(resizeHandle);

    updateDrawerScrollMetrics(drawer);
    return drawer;
}

function refreshHeader() {
    if (!panelRoot) return;

    const state = getState();
    normalizePanelLayoutState(state);
    const settings = getSettings();
    const metrics = getRailMetrics(state, settings);

    for (const metric of panelRoot.querySelectorAll('.wandlight-runtime-rail-metric[data-tab-id]')) {
        metric.textContent = metrics[metric.dataset.tabId] || '';
    }

    const status = panelRoot.querySelector('.wandlight-runtime-drawer-status');
    if (!status) return;

    const pendingLore = (state?.pendingLoreEntries || []).length;
    const pendingDelta = state?.lastDelta ? 1 : 0;
    const counts = getPanelLoreState(state).counts;
    const selectedLore = getSelectedLoreInjectionCount(state, settings);

    status.innerHTML = '';
    status.appendChild(createStatusPill(`Experience: ${getExperienceLabel(settings)}`, getExperienceTooltip(settings)));
    status.appendChild(createStatusPill(`Automation: ${getAutomationLabel(settings)}`, getAutomationTooltip(settings)));
    status.appendChild(createStatusPill(settings.enabled ? 'Active' : 'Paused', 'Master runtime toggle. When paused, Wandlight does not inject, scan, or generate.'));
    status.appendChild(createStatusPill((settings.injectContinuity !== false && settings.injectMemo !== false) ? 'Continuity Injected' : 'Continuity Not Injected', 'Whether Wandlight includes structured continuity state in roleplay generation prompts.'));
    if (pendingDelta + pendingLore > 0) {
        status.appendChild(createStatusPill(`Pending: ${pendingDelta + pendingLore}`, 'Pending generated lore entries plus any legacy continuity delta.'));
    }
    status.appendChild(createStatusPill(`Lore Selected: ${selectedLore}`, 'Accepted lore entries selected for the next injection after context activation, priority, pinning, and muting.'));
    void counts;
}

function renderPanelBody(container, state) {
    container.innerHTML = '';

    const activeTab = normalizeTabForExperience(state?.lorePanel?.activeTab);
    const tabBody = document.createElement('div');
    tabBody.className = `wandlight-runtime-tab-body wandlight-runtime-tab-body-${activeTab}`;
    container.appendChild(tabBody);

    if (activeTab === 'session') {
        renderSessionTab(tabBody, state);
    } else if (activeTab === 'context') {
        renderContextTab(tabBody, state);
    } else if (activeTab === 'continuity') {
        renderContinuityTab(tabBody, state);
    } else if (activeTab === 'lore') {
        renderLoreTab(tabBody, state);
    } else {
        renderInjectionTab(tabBody, state);
    }

    installNestedScrollHandoff(tabBody);
    if (activeTab === 'lore') scheduleAcceptedLoreLayoutUpdate();
}

function installNestedScrollHandoff(tabBody) {
    if (!tabBody) return;
    const nestedScrolls = tabBody.querySelectorAll([
        '.wandlight-accepted-lore-scroll-region',
        '.wandlight-pending-lore-list',
        '.wandlight-injection-preview',
        '.wandlight-continuity-json-editor',
        'textarea'
    ].join(','));

    for (const nested of nestedScrolls) {
        nested.addEventListener('wheel', (e) => {
            const outer = nested.closest('.wandlight-runtime-tab-body');
            if (!outer || outer === nested || !e.deltaY) return;

            const canScrollDown = nested.scrollTop + nested.clientHeight < nested.scrollHeight - 1;
            const canScrollUp = nested.scrollTop > 0;
            const shouldHandoff = (e.deltaY > 0 && !canScrollDown) || (e.deltaY < 0 && !canScrollUp);
            if (!shouldHandoff) return;

            outer.scrollTop += e.deltaY;
            e.preventDefault();
            e.stopPropagation();
        }, { passive: false });
    }
}

function getRailMetrics(state, settings = getSettings()) {
    const counts = getPanelLoreState(state).counts;
    const pendingLore = (state?.pendingLoreEntries || []).length;
    const selectedLore = getSelectedLoreInjectionCount(state, settings);
    const injectionStats = getInjectionCharacterStats(state, settings);
    const sceneDate = String(state?.loreContext?.sceneDate || '').trim();
    const canonBoundary = String(state?.loreContext?.canonBoundary || '').trim();
    const activeCharacters = Array.isArray(state?.scene?.presentCharacters)
        ? state.scene.presentCharacters.length
        : (Array.isArray(state?.characters) ? state.characters.length : 0);
    const liveItems = [state?.scene?.location, state?.scene?.currentActivity].filter(Boolean).length;

    return {
        session: settings.enabled ? getExperienceLabel(settings) : 'Paused',
        context: sceneDate || canonBoundary || 'No date',
        continuity: `${activeCharacters || liveItems || 0} live`,
        lore: pendingLore ? `${counts.active || 0}+${pendingLore}` : `${counts.active || 0} active`,
        injection: injectionStats.totalChars ? `${injectionStats.totalTokens} tk` : `${selectedLore} lore`,
    };
}

function normalizePanelLayoutState(state, options = {}) {
    if (!state) return null;
    if (!state.lorePanel || typeof state.lorePanel !== 'object') state.lorePanel = getDefaultState().lorePanel;
    const panelState = state.lorePanel;

    const hadRailFields = panelState.railX != null || panelState.railY != null || panelState.drawerOpen != null;
    panelState.railMode = normalizeRailMode(panelState.railMode);
    if (typeof panelState.drawerOpen !== 'boolean') {
        panelState.drawerOpen = hadRailFields ? false : panelState.collapsed !== true;
    }
    panelState.collapsed = panelState.drawerOpen !== true;
    panelState.activeTab = normalizeTabForExperience(panelState.activeTab);
    panelState.drawerDirection = ['auto', 'right', 'left'].includes(panelState.drawerDirection) ? panelState.drawerDirection : 'auto';

    const legacyX = Number(panelState.x);
    const legacyY = Number(panelState.y);
    const rawRailX = Number(panelState.railX);
    const rawRailY = Number(panelState.railY);
    const defaultY = getDefaultRailY(panelState);
    const looksLikeOldDefaultPosition = panelState.layoutVersion !== LAYOUT_VERSION
        && [16, 20].includes(rawRailX)
        && rawRailY === 220
        && (!Number.isFinite(legacyX) || [16, 20].includes(legacyX))
        && (!Number.isFinite(legacyY) || legacyY === 220);

    const railXValue = looksLikeOldDefaultPosition ? Number.NaN : rawRailX;
    const railYValue = looksLikeOldDefaultPosition ? Number.NaN : rawRailY;

    panelState.railX = clampNumber(
        railXValue,
        0,
        Math.max(0, getViewportWidth() - getRailWidth(panelState)),
        looksLikeOldDefaultPosition ? DEFAULT_RAIL_LEFT : (Number.isFinite(legacyX) ? legacyX : DEFAULT_RAIL_LEFT),
    );
    panelState.railY = clampNumber(
        railYValue,
        0,
        Math.max(0, getViewportHeight() - 80),
        looksLikeOldDefaultPosition ? defaultY : (Number.isFinite(legacyY) ? legacyY : defaultY),
    );
    panelState.drawerWidth = clampNumber(Number(panelState.drawerWidth), MIN_DRAWER_WIDTH, Math.max(MIN_DRAWER_WIDTH, getViewportWidth() - (MAX_PANEL_MARGIN * 2)), Number(panelState.width) || 560);
    panelState.drawerHeight = clampNumber(Number(panelState.drawerHeight), MIN_DRAWER_HEIGHT, Math.max(MIN_DRAWER_HEIGHT, getViewportHeight() - (MAX_PANEL_MARGIN * 2)), Number(panelState.height) || 640);
    panelState.layoutVersion = LAYOUT_VERSION;

    if (options.persistLegacyOpenState || looksLikeOldDefaultPosition) {
        panelState.x = panelState.railX;
        panelState.y = panelState.railY;
        panelState.width = panelState.drawerWidth;
        panelState.height = panelState.drawerHeight;
    }
    return panelState;
}

function normalizeRailMode(mode) {
    return mode === 'expanded' ? 'expanded' : 'compact';
}

function getRailWidth(panelState) {
    return normalizeRailMode(panelState?.railMode) === 'expanded' ? RAIL_WIDTH_EXPANDED : RAIL_WIDTH_COMPACT;
}

function getViewportWidth() {
    return window.innerWidth || document.documentElement?.clientWidth || 1024;
}

function getViewportHeight() {
    return window.innerHeight || document.documentElement?.clientHeight || 800;
}

function getEstimatedRailHeight(panelState = null) {
    return normalizeRailMode(panelState?.railMode) === 'expanded'
        ? DEFAULT_EXPANDED_RAIL_HEIGHT_ESTIMATE
        : DEFAULT_COMPACT_RAIL_HEIGHT_ESTIMATE;
}

function getDefaultRailY(panelState = null) {
    const viewportHeight = getViewportHeight();
    const estimatedHeight = Math.min(
        getEstimatedRailHeight(panelState),
        Math.max(80, viewportHeight - (MAX_PANEL_MARGIN * 2)),
    );
    return Math.max(MAX_PANEL_MARGIN, Math.round((viewportHeight - estimatedHeight) / 2));
}

function getMeasuredCenteredRailY(root = panelRoot) {
    const viewportHeight = getViewportHeight();
    const rail = root?.querySelector?.('.wandlight-runtime-rail');
    const measuredHeight = Number(rail?.offsetHeight) || getEstimatedRailHeight(getState()?.lorePanel);
    const safeHeight = Math.min(measuredHeight, Math.max(80, viewportHeight - (MAX_PANEL_MARGIN * 2)));
    return Math.max(MAX_PANEL_MARGIN, Math.round((viewportHeight - safeHeight) / 2));
}

function centerRuntimeRailInViewport(options = {}) {
    if (!panelRoot) return;
    const state = getState();
    if (!state?.lorePanel) return;
    normalizePanelLayoutState(state);

    const railWidth = getRailWidth(state.lorePanel);
    const maxX = Math.max(0, getViewportWidth() - railWidth);
    const railX = options.forceLeft === true
        ? Math.min(DEFAULT_RAIL_LEFT, maxX)
        : clampNumber(Number(state.lorePanel.railX), 0, maxX, DEFAULT_RAIL_LEFT);
    const railY = getMeasuredCenteredRailY(panelRoot);

    state.lorePanel.railX = railX;
    state.lorePanel.railY = railY;
    state.lorePanel.x = railX;
    state.lorePanel.y = railY;
    panelRoot.style.left = `${railX}px`;
    panelRoot.style.top = `${railY}px`;

    if (options.persist === true) saveState(state);
}

function getConstrainedDrawerWidth(panelState, direction = 'right') {
    const railX = Number(panelState?.railX) || 0;
    const railWidth = getRailWidth(panelState);
    const requested = Number(panelState?.drawerWidth) || 560;
    const spaceRight = Math.max(MIN_DRAWER_WIDTH, getViewportWidth() - railX - railWidth - RAIL_DRAWER_GAP - MAX_PANEL_MARGIN);
    const spaceLeft = Math.max(MIN_DRAWER_WIDTH, railX - RAIL_DRAWER_GAP - MAX_PANEL_MARGIN);
    const maxWidth = direction === 'left' ? spaceLeft : spaceRight;
    return Math.max(MIN_DRAWER_WIDTH, Math.min(requested, maxWidth));
}

function getConstrainedDrawerHeight(panelState) {
    const railY = Number(panelState?.railY) || 0;
    const requested = Number(panelState?.drawerHeight) || 640;
    const maxHeight = Math.max(MIN_DRAWER_HEIGHT, getViewportHeight() - railY - MAX_PANEL_MARGIN);
    return Math.max(MIN_DRAWER_HEIGHT, Math.min(requested, maxHeight));
}

function resolveDrawerDirection(panelState) {
    if (panelState?.drawerDirection === 'left') return 'left';
    if (panelState?.drawerDirection === 'right') return 'right';

    const railX = Number(panelState?.railX) || 0;
    const railWidth = getRailWidth(panelState);
    const requested = Number(panelState?.drawerWidth) || 560;
    const spaceRight = getViewportWidth() - railX - railWidth - RAIL_DRAWER_GAP - MAX_PANEL_MARGIN;
    const spaceLeft = railX - RAIL_DRAWER_GAP - MAX_PANEL_MARGIN;

    if (spaceRight >= requested) return 'right';
    if (spaceLeft >= requested) return 'left';
    return spaceRight >= spaceLeft ? 'right' : 'left';
}

function applyRuntimeShellGeometry(root, panelState) {
    const railWidth = getRailWidth(panelState);
    const x = clampNumber(Number(panelState?.railX), 0, Math.max(0, getViewportWidth() - railWidth), DEFAULT_RAIL_LEFT);
    const y = clampNumber(Number(panelState?.railY), 0, Math.max(0, getViewportHeight() - 80), getDefaultRailY());
    root.style.left = `${x}px`;
    root.style.top = `${y}px`;
    root.style.right = '';
    root.style.bottom = '';
}

function clampRuntimeShellToViewport() {
    if (!panelRoot) return;
    const state = getState();
    const panelState = normalizePanelLayoutState(state);
    if (!panelState) return;
    const railWidth = getRailWidth(panelState);
    const railHeight = panelRoot.querySelector('.wandlight-runtime-rail')?.offsetHeight || 80;
    panelState.railX = clampNumber(Number(panelState.railX), 0, Math.max(0, getViewportWidth() - railWidth), DEFAULT_RAIL_LEFT);
    panelState.railY = clampNumber(Number(panelState.railY), 0, Math.max(0, getViewportHeight() - Math.min(railHeight, getViewportHeight())), getDefaultRailY());
    panelState.x = panelState.railX;
    panelState.y = panelState.railY;
    applyRuntimeShellGeometry(panelRoot, panelState);
    panelRoot.style.setProperty('--wandlight-rail-width', `${railWidth}px`);
    panelRoot.style.setProperty('--wandlight-drawer-width', `${getConstrainedDrawerWidth(panelState, resolveDrawerDirection(panelState))}px`);
    panelRoot.style.setProperty('--wandlight-drawer-height', `${getConstrainedDrawerHeight(panelState)}px`);
    updateDrawerScrollMetrics();
    saveState(state);
}

function clampNumber(value, min, max, fallback) {
    const safeMin = Number.isFinite(min) ? min : 0;
    const safeMax = Number.isFinite(max) ? Math.max(safeMin, max) : safeMin;
    const safeFallback = Number.isFinite(fallback) ? fallback : safeMin;
    const n = Number.isFinite(value) ? value : safeFallback;
    return Math.max(safeMin, Math.min(n, safeMax));
}

// Session tab -----------------------------------------------------------------

function renderSessionTab(container, state) {
    const settings = getSettings();
    const guideMode = isBasicExperience(settings) ? 'basic' : 'advanced';
    const guide = GUIDE_CONTENT[guideMode] || GUIDE_CONTENT.basic;

    container.appendChild(createSectionHeader(
        'Session Controls',
        'Set how Wandlight behaves during roleplay.'
    ));

    const toggles = document.createElement('div');
    toggles.className = 'wandlight-runtime-grid';
    toggles.appendChild(markTourTarget(createToggleCard(
        'Wandlight Active',
        settings.enabled,
        'Master switch for Wandlight runtime behavior. Pausing disables prompt injection, automatic extraction, and generation actions.',
        (checked) => {
            const next = getSettings();
            next.enabled = checked;
            saveSettings(next);
            refreshPanelBody({ preserveScroll: false });
            refreshHeader();
        }
    ), 'session.active'));
    container.appendChild(toggles);

    if (!isBasicExperience(settings)) {
        const modeCard = document.createElement('div');
        modeCard.className = 'wandlight-runtime-card';

        const modeTitle = document.createElement('div');
        modeTitle.className = 'wandlight-runtime-card-title';
        modeTitle.textContent = 'Automation Mode';
        addTooltip(modeTitle, 'Automation Mode controls whether Wandlight scans and generates only when clicked, or automatically after roleplay turns. Experience Mode lives on the shelf.');
        modeCard.appendChild(modeTitle);

        const modeButtons = document.createElement('div');
        modeButtons.className = 'wandlight-mode-buttons';
        for (const [mode, cfg] of Object.entries(AUTOMATION_MODES)) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'wandlight-mode-button';
            if (normalizeAutomationMode(settings.automationMode || settings.workflowMode) === mode) btn.classList.add('wandlight-mode-button-active');
            btn.textContent = cfg.label;
            addTooltip(btn, cfg.description);
            btn.addEventListener('click', () => {
                setAutomationMode(mode);
                refreshPanelBody({ preserveScroll: false });
                refreshHeader();
                toast(`Automation mode set to ${cfg.label}`);
            });
            modeButtons.appendChild(btn);
        }
        modeCard.appendChild(modeButtons);

        const modeDesc = document.createElement('div');
        modeDesc.className = 'wandlight-runtime-help';
        modeDesc.textContent = AUTOMATION_MODES[normalizeAutomationMode(settings.automationMode || settings.workflowMode)].description;
        modeCard.appendChild(modeDesc);

        container.appendChild(markTourTarget(modeCard, 'session.automation'));
    }

    container.appendChild(createWandlightPresetStatusCard());

    container.appendChild(createCollapsibleSection(
        `session.instructions.${guideMode}`,
        guide.title,
        guide.subtitle,
        false,
        createInstructionsCard(guideMode),
        { tooltip: guide.tooltip }
    ));

    const stats = document.createElement('div');
    stats.className = 'wandlight-runtime-card';
    markTourTarget(stats, 'session.metrics');
    const counts = getPanelLoreState(state).counts;
    const selectedLoreCount = getSelectedLoreInjectionCount(state, settings);
    const injectionStats = getInjectionCharacterStats(state, settings);
    stats.appendChild(createKeyValue('Pending continuity changes', state?.lastDelta ? '1' : '0', 'Legacy extracted state delta waiting in the Continuity tab. New scans apply directly to Continuity sections.'));
    stats.appendChild(createKeyValue('Pending lore entries', String((state?.pendingLoreEntries || []).length), 'Generated lore entries waiting in the Lore tab Pending Lore Review section.'));
    stats.appendChild(createKeyValue('Accepted lore entries', String(counts.all - counts.pending), 'Lore entries currently stored in the accepted lore matrix.'));
    stats.appendChild(createKeyValue('High-relevance lore entries', String(counts.active), 'Accepted lore entries currently assigned to the High-Relevance injection tier.'));
    stats.appendChild(createKeyValue('Lore selected for injection', String(selectedLoreCount), 'Accepted lore entries that Wandlight is currently selecting for Lore Injection after pin/mute rules, context activation, and fallback priority selection. There is no hidden entry cap; mute entries to exclude them.'));
    stats.appendChild(createKeyValue('Injection token estimate', injectionStats.totalChars ? `${injectionStats.totalTokens} tokens` : 'empty', 'Approximate token count for the combined Continuity + Lore injection previews.'));
    stats.appendChild(createKeyValue('Total chars injected', `${injectionStats.totalChars} chars`, 'Combined character count of Continuity Injection plus Lore Injection using current Injection tab toggles and handling modes.'));
    container.appendChild(stats);

    container.appendChild(createCollapsibleSection('session.dangerZone', 'Danger Zone', 'Destructive cleanup actions', false, createDangerZoneCard(state), { tooltip: 'Destructive cleanup actions for this chat.', className: 'wandlight-danger-zone-collapsible' }));
}

function createInstructionsCard(guideMode = normalizeExperienceMode(getSettings().experienceMode)) {
    const wrap = document.createElement('div');
    wrap.className = 'wandlight-instructions-card';
    const mode = normalizeExperienceMode(guideMode);
    const guide = GUIDE_CONTENT[mode] || GUIDE_CONTENT.basic;
    const steps = GUIDE_STEPS[mode] || GUIDE_STEPS.basic;

    const intro = document.createElement('p');
    intro.className = 'wandlight-instructions-lede';
    intro.textContent = guide.lede;
    wrap.appendChild(intro);

    const flow = document.createElement('div');
    flow.className = 'wandlight-instructions-flow';

    const actions = document.createElement('div');
    actions.className = 'wandlight-guide-actions';
    actions.appendChild(createButton(guide.tourLabel || 'Start Walkthrough', 'Open a guided walkthrough that moves through the related Wandlight tabs and controls.', () => {
        startWandlightTour(mode);
    }, 'wandlight-primary-button'));
    wrap.appendChild(actions);

    for (const item of steps) {
        const card = document.createElement('div');
        card.className = 'wandlight-instructions-step-card';
        const main = document.createElement('div');
        main.className = 'wandlight-instructions-step-main';
        const title = document.createElement('div');
        title.className = 'wandlight-instructions-step-title';
        title.textContent = item.title;
        const body = document.createElement('div');
        body.className = 'wandlight-instructions-step-body';
        body.textContent = item.body;
        main.appendChild(title);
        main.appendChild(body);
        card.appendChild(main);
        if (item.actionLabel) {
            const action = createButton(item.actionLabel, `Open ${item.title}.`, () => {
                showGuideStep(item, { highlight: true });
            }, 'wandlight-mini-button wandlight-guide-step-button');
            card.appendChild(action);
        }
        flow.appendChild(card);
    }

    wrap.appendChild(flow);

    if (String(guide.note || '').trim()) {
        const close = document.createElement('p');
        close.className = 'wandlight-instructions-note';
        close.textContent = guide.note;
        wrap.appendChild(close);
    }

    return wrap;
}

function createWandlightPresetStatusCard() {
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card wandlight-preset-status-card';
    markTourTarget(card, 'session.preset');
    card.textContent = 'Checking Wandlight preset...';
    refreshWandlightPresetStatusCard(card);
    return card;
}

async function refreshWandlightPresetStatusCard(card) {
    if (!card) return;
    card.textContent = '';

    let status;
    try {
        status = await getWandlightPresetStatus();
    } catch (e) {
        status = {
            state: 'error',
            pill: 'Error',
            message: e?.message || 'Could not check Wandlight preset.',
            installedVersion: 'unknown',
            bundledVersion: WANDLIGHT_PRESET_VERSION,
            canInstall: false,
        };
    }

    const header = document.createElement('div');
    header.className = 'wandlight-preset-status-header';
    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = 'Wandlight Preset';
    addTooltip(title, 'The bundled Wandlight chat-completion preset enables reply headers used by fast Story Context detection.');
    header.appendChild(title);
    header.appendChild(createStatusPill(status.pill || 'Unknown', status.message || 'Wandlight preset status'));
    card.appendChild(header);

    const meta = document.createElement('div');
    meta.className = 'wandlight-preset-status-meta';
    meta.appendChild(createCompactPresetStat('Installed', status.installedVersion || 'not found'));
    meta.appendChild(createCompactPresetStat('Bundled', status.bundledVersion || WANDLIGHT_PRESET_VERSION));
    card.appendChild(meta);

    const message = document.createElement('div');
    message.className = 'wandlight-preset-status-message';
    message.textContent = status.message || '';
    card.appendChild(message);

    const actions = document.createElement('div');
    actions.className = 'wandlight-preset-status-actions';
    if (status.actionLabel) {
        actions.appendChild(createButton(status.actionLabel, status.actionTooltip || status.actionLabel, async (btn) => {
            await handleInstallWandlightPreset(btn, card, status);
        }, status.primaryAction ? 'wandlight-primary-button' : ''));
    }
    if (status.canDownload) {
        actions.appendChild(createButton('Download JSON', 'Download the bundled Wandlight preset for manual import.', async (btn) => {
            await runBusyAction(btn, 'Downloading...', async () => {
                const preset = await loadBundledWandlightPreset();
                downloadJson(preset, `${WANDLIGHT_PRESET_VERSION}.json`);
                toast('Bundled Wandlight preset downloaded.', 'info');
            });
        }));
    }
    if (actions.childElementCount) card.appendChild(actions);
}

function createCompactPresetStat(label, value) {
    const row = document.createElement('div');
    row.className = 'wandlight-preset-status-stat';
    const key = document.createElement('span');
    key.textContent = label;
    const val = document.createElement('strong');
    val.textContent = value;
    row.appendChild(key);
    row.appendChild(val);
    return row;
}

async function getWandlightPresetStatus() {
    const bundled = await loadBundledWandlightPreset();
    const bundledMeta = getWandlightPresetMetadata(bundled, { fallbackVersion: WANDLIGHT_PRESET_VERSION });
    const bundledVersion = bundledMeta.displayVersion || WANDLIGHT_PRESET_VERSION;
    const pm = getWandlightPresetManager();

    if (!pm) {
        return {
            state: 'unavailable',
            pill: 'Manual',
            message: 'Preset manager unavailable. Download the bundled JSON and import it manually.',
            installedVersion: 'unknown',
            bundledVersion,
            canDownload: true,
        };
    }

    const installed = getInstalledWandlightPreset(pm);
    if (!installed.preset) {
        return {
            state: 'missing',
            pill: 'Not Installed',
            message: 'Install the bundled preset, then select it manually in SillyTavern when ready.',
            installedVersion: 'not found',
            bundledVersion,
            actionLabel: 'Install',
            actionTooltip: 'Import the bundled Wandlight preset into Chat Completion presets without intentionally switching to it.',
            primaryAction: true,
            canInstall: true,
        };
    }

    const installedMeta = getWandlightPresetMetadata(installed.preset);
    const installedVersion = installedMeta.displayVersion || 'unknown';
    const comparison = compareWandlightPresetVersions(installedMeta.displayVersion, bundledVersion);
    const legacyNameMessage = installed.legacyName
        ? ` Legacy preset name "${installed.name}" was found; updating installs the stable "${WANDLIGHT_PRESET_NAME}" preset name, and the old named preset can be removed afterward.`
        : '';

    if (comparison === null) {
        return {
            state: 'unknown',
            pill: 'Version Unknown',
            message: `A Wandlight preset is installed, but its version metadata is missing or unreadable.${legacyNameMessage}`,
            installedVersion,
            bundledVersion,
            actionLabel: 'Update',
            actionTooltip: 'Replace the installed Wandlight preset with the bundled version.',
            primaryAction: true,
            canInstall: true,
            installedName: installed.name,
        };
    }

    if (comparison < 0) {
        return {
            state: 'behind',
            pill: 'Update Available',
            message: `The installed Wandlight preset is older than the bundled preset.${legacyNameMessage}`,
            installedVersion,
            bundledVersion,
            actionLabel: 'Update',
            actionTooltip: 'Update the installed Wandlight preset to the bundled version.',
            primaryAction: true,
            canInstall: true,
            installedName: installed.name,
        };
    }

    if (comparison > 0) {
        if (installed.legacyName) {
            return {
                state: 'legacy-name',
                pill: 'Legacy Name',
                message: legacyNameMessage.trim(),
                installedVersion,
                bundledVersion,
                actionLabel: 'Update',
                actionTooltip: 'Install the bundled Wandlight preset under the stable preset name.',
                primaryAction: true,
                canInstall: true,
                installedName: installed.name,
            };
        }
        return {
            state: 'ahead',
            pill: 'Newer Installed',
            message: 'The installed Wandlight preset appears newer than the bundled preset. No update needed.',
            installedVersion,
            bundledVersion,
            installedName: installed.name,
        };
    }

    if (installed.legacyName) {
        return {
            state: 'legacy-name',
            pill: 'Legacy Name',
            message: legacyNameMessage.trim(),
            installedVersion,
            bundledVersion,
            actionLabel: 'Update',
            actionTooltip: 'Install the bundled Wandlight preset under the stable preset name.',
            primaryAction: true,
            canInstall: true,
            installedName: installed.name,
        };
    }

    return {
        state: 'current',
        pill: 'Current',
        message: 'The installed Wandlight preset matches the bundled version.',
        installedVersion,
        bundledVersion,
        installedName: installed.name,
        actionLabel: 'Reinstall',
        actionTooltip: 'Reset the installed Wandlight preset to the bundled default values.',
        canInstall: true,
    };
}

function getWandlightPresetManager() {
    try {
        if (typeof SillyTavern === 'undefined' || typeof SillyTavern.getContext !== 'function') return null;
        const ctx = SillyTavern.getContext();
        if (!ctx || typeof ctx.getPresetManager !== 'function') return null;
        return ctx.getPresetManager(WANDLIGHT_PRESET_API_ID) || null;
    } catch (_) {
        return null;
    }
}

function getInstalledWandlightPreset(pm) {
    const names = typeof pm?.getAllPresets === 'function' ? pm.getAllPresets() : [];
    const candidates = [WANDLIGHT_PRESET_NAME, ...LEGACY_WANDLIGHT_PRESET_NAMES];
    let installedName = '';
    if (Array.isArray(names)) {
        installedName = candidates
            .map(candidate => names.find(name => String(name || '').trim().toLowerCase() === candidate.toLowerCase()) || '')
            .find(Boolean) || '';
    }
    if (!installedName) {
        installedName = candidates.find(candidate => getWandlightPresetByName(pm, candidate)) || '';
    }
    if (!installedName) return { name: '', preset: null, legacyName: false };

    const preset = getWandlightPresetByName(pm, installedName) || {
        extensions: {
            wandlight: {
                presetName: installedName,
                presetVersion: installedName,
            },
        },
    };
    return {
        name: installedName,
        preset,
        legacyName: installedName.toLowerCase() !== WANDLIGHT_PRESET_NAME.toLowerCase(),
    };
}

function getWandlightPresetByName(pm, name) {
    if (!name) return null;
    let preset = null;
    if (typeof pm?.getCompletionPresetByName === 'function') {
        preset = pm.getCompletionPresetByName(name) || null;
    }
    if (!preset && typeof pm?.readPresetExtensionField === 'function') {
        const wandlightMeta = pm.readPresetExtensionField({ name, path: 'wandlight' });
        if (wandlightMeta) preset = { extensions: { wandlight: wandlightMeta } };
    }
    return preset;
}

async function loadBundledWandlightPreset() {
    if (bundledWandlightPresetCache) return cloneJson(bundledWandlightPresetCache);
    const response = await fetch(getLocalAssetSrc(WANDLIGHT_PRESET_ASSET_PATH), { cache: 'no-store' });
    if (!response.ok) throw new Error('Bundled Wandlight preset could not be loaded.');
    const preset = ensureWandlightPresetMetadata(await response.json());
    bundledWandlightPresetCache = preset;
    return cloneJson(preset);
}

function ensureWandlightPresetMetadata(preset) {
    const next = cloneJson(preset || {});
    next.extensions = isPlainObjectValue(next.extensions) ? next.extensions : {};
    next.extensions.wandlight = {
        ...(isPlainObjectValue(next.extensions.wandlight) ? next.extensions.wandlight : {}),
        presetName: WANDLIGHT_PRESET_NAME,
        presetVersion: WANDLIGHT_PRESET_VERSION,
        version: formatComparablePresetVersion(WANDLIGHT_PRESET_VERSION) || '1.4',
        supportsReplyHeaders: true,
    };
    return next;
}

function getWandlightPresetMetadata(preset, options = {}) {
    const ext = isPlainObjectValue(preset?.extensions?.wandlight) ? preset.extensions.wandlight : {};
    const notes = String(preset?.notes || '');
    const explicit = ext.presetVersion || ext.version || '';
    const noteMatch = notes.match(/\bWandlight[-\s]+v?(\d+(?:\.\d+){0,3})\b/i);
    const rawVersion = explicit || (noteMatch ? noteMatch[1] : '') || options.fallbackVersion || '';
    const comparable = formatComparablePresetVersion(rawVersion);
    return {
        displayVersion: comparable ? `Wandlight-${comparable}` : '',
        comparable,
        source: explicit ? 'metadata' : noteMatch ? 'notes' : '',
    };
}

function formatComparablePresetVersion(value) {
    const match = String(value || '').trim().match(/(?:Wandlight[-\s]*)?v?(\d+(?:\.\d+){0,3})/i);
    return match?.[1] || '';
}

function compareWandlightPresetVersions(installed, bundled) {
    const a = formatComparablePresetVersion(installed);
    const b = formatComparablePresetVersion(bundled);
    if (!a || !b) return null;
    const left = a.split('.').map(v => Number(v) || 0);
    const right = b.split('.').map(v => Number(v) || 0);
    const length = Math.max(left.length, right.length, 3);
    for (let i = 0; i < length; i += 1) {
        const av = left[i] || 0;
        const bv = right[i] || 0;
        if (av < bv) return -1;
        if (av > bv) return 1;
    }
    return 0;
}

async function handleInstallWandlightPreset(btn, card, status) {
    const isReinstall = status.state === 'current';
    const busyLabel = status.state === 'missing' ? 'Installing...' : isReinstall ? 'Reinstalling...' : 'Updating...';
    await runBusyAction(btn, busyLabel, async () => {
        if (status.state !== 'missing') {
            const title = isReinstall ? 'Reinstall Wandlight preset?' : 'Update Wandlight preset?';
            const message = isReinstall
                ? "Are you sure you want to reset the Wandlight preset's values to the bundled defaults? This will overwrite any manual edits to that preset. It will not intentionally switch your active preset."
                : 'This will replace the installed Wandlight preset with the bundled version. It will not intentionally switch your active preset.';
            const proceed = await confirmAction(title, message);
            if (!proceed) return;
        }

        const result = await installBundledWandlightPreset();
        await refreshWandlightPresetStatusCard(card);
        toast(status.state === 'missing' ? 'Wandlight preset installed.' : isReinstall ? 'Wandlight preset reinstalled.' : 'Wandlight preset updated.');
        if (result?.selectionTouched) {
            await showNoticePopup(
                'Preset saved',
                'SillyTavern may briefly change the active preset while importing. I restored the previous selection where possible; verify your active preset and connection profile before generating.'
            );
        }
    });
}

async function installBundledWandlightPreset() {
    const pm = getWandlightPresetManager();
    if (!pm || typeof pm.savePreset !== 'function') {
        throw new Error('SillyTavern preset manager is unavailable.');
    }

    const preset = await loadBundledWandlightPreset();
    const previousValue = typeof pm.getSelectedPreset === 'function' ? pm.getSelectedPreset() : '';
    const previousName = typeof pm.getSelectedPresetName === 'function' ? pm.getSelectedPresetName() : '';

    await pm.savePreset(WANDLIGHT_PRESET_NAME, preset);

    let restored = false;
    if (previousValue && typeof pm.selectPreset === 'function') {
        try {
            const currentName = typeof pm.getSelectedPresetName === 'function' ? pm.getSelectedPresetName() : '';
            if (currentName !== previousName) {
                pm.selectPreset(previousValue);
                restored = true;
            }
        } catch (e) {
            console.warn('[Wandlight] Could not restore previous preset after importing Wandlight preset:', e);
        }
    }

    return { selectionTouched: previousName !== WANDLIGHT_PRESET_NAME, restored };
}

function downloadJson(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 4)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

function cloneJson(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function cloneDefaultSettings() {
    return cloneJson(DEFAULT_SETTINGS);
}

function copyStoredApiKeySettings(source, target) {
    if (!source || !target) return target;
    for (const prefix of STORED_API_KEY_SETTING_PREFIXES) {
        for (const suffix of STORED_API_KEY_SETTING_SUFFIXES) {
            const key = `${prefix}${suffix}`;
            if (Object.prototype.hasOwnProperty.call(source, key)) {
                target[key] = cloneJson(source[key]);
            }
        }
    }
    return target;
}

function resetAllSettingsToDefaults() {
    const current = getSettings();
    const defaults = cloneDefaultSettings();
    copyStoredApiKeySettings(current, defaults);
    saveSettings(defaults);
}

function resetSettingKeysToDefaults(settingKeys, label = 'Settings') {
    const keys = Array.isArray(settingKeys) ? settingKeys : [];
    if (!keys.length) return;

    const next = getSettings();
    let changed = 0;
    for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) continue;
        next[key] = cloneJson(DEFAULT_SETTINGS[key]);
        changed += 1;
    }

    if (!changed) return;
    saveSettings(next);
    refreshPanelBody({ preserveScroll: true });
    toast(`${label} reset to defaults.`, 'info');
}

function appendSettingsResetButton(container, settingKeys, label = 'Settings') {
    if (!container || !Array.isArray(settingKeys) || !settingKeys.length) return;
    const row = document.createElement('div');
    row.className = 'wandlight-settings-reset-row';
    row.appendChild(createButton(
        'Reset Defaults',
        `Reset only the ${label.toLowerCase()} controls in this section to bundled defaults.`,
        () => resetSettingKeysToDefaults(settingKeys, label),
        'wandlight-small-button wandlight-settings-reset-button'
    ));
    container.appendChild(row);
}

function createDangerZoneCard(state) {
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card wandlight-danger-zone-card';

    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title wandlight-danger-zone-title';
    title.textContent = 'Danger Zone';
    addTooltip(title, 'Destructive cleanup actions for the current chat. Deleted accepted lore can be recovered through Lore Timeline when payloads are retained. Total Reset clears all Wandlight data.');
    card.appendChild(title);

    card.appendChild(createKeyValue('Accepted lore', String((state?.loreMatrix || []).length), 'Lore entries currently stored in the accepted lore matrix.'));
    card.appendChild(createKeyValue('Pending lore', String((state?.pendingLoreEntries || []).length), 'Generated lore entries waiting in the Lore tab Pending Lore Review section.'));
    card.appendChild(createKeyValue('Pending continuity changes', state?.lastDelta ? '1' : '0', 'Legacy extracted continuity delta waiting in the Continuity tab.'));

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions';

    actions.appendChild(createButton('Delete All Lore', 'Deletes accepted lore, pending lore, and pin/mute selections. Lightweight continuity state is left intact.', async () => {
        const proceed = await confirmAction('Are you sure? Delete all Wandlight lore?', 'You are about to delete every accepted lore entry, every pending lore entry, and all pin/mute selections for this chat. Lightweight continuity state will remain. Accepted lore can be restored to Pending Review through Lore Timeline when retained. Continue?');
        if (!proceed) return;
        const current = getState();
        const beforeTimeline = captureLoreTimelineState(current);
        const deleted = normalizeLoreMatrix(current.loreMatrix || []).length;
        current.loreMatrix = [];
        current.pendingLoreEntries = [];
        current.pendingLoreMeta = null;
        current.loreSelection = { pinnedIds: [], suppressedIds: [] };
        if (current.lorePanel) {
            current.lorePanel.selectedEntryId = '';
            current.lorePanel.reviewSelectedIds = [];
        }
        if (deleted > 0) {
            recordLoreTimelineEvent(current, {
                before: beforeTimeline,
                after: captureLoreTimelineState(current),
                type: 'delete_all',
                source: 'danger_zone',
                summary: `Deleted all accepted lore (${deleted} entr${deleted === 1 ? 'y' : 'ies'}).`,
            });
        }
        saveState(current);
        refreshPanelBody({ preserveScroll: false });
        refreshHeader();
        toast('All lore entries deleted.', 'info');
    }, 'wandlight-danger-button'));

    actions.appendChild(createButton('Reset Generation State', 'Clears detected lore context, pending generated lore, pending deltas, and generation ledger. Accepted lore remains intact.', async () => {
        const proceed = await confirmAction('Are you sure? Reset generation state?', 'You are about to clear detected context, pending generated lore, pending continuity changes, and the lore-generation ledger. Accepted lore entries and Lore Timeline will remain. Continue?');
        if (!proceed) return;
        const current = getState();
        const defaults = getDefaultState();
        current.loreContext = defaults.loreContext;
        current.pendingLoreEntries = [];
        current.pendingLoreMeta = null;
        current.loreGeneration = defaults.loreGeneration;
        current.loreBulkGeneration = defaults.loreBulkGeneration;
        current.continuityScan = defaults.continuityScan;
        current.lastDelta = null;
        if (current.lorePanel) current.lorePanel.reviewSelectedIds = [];
        saveState(current);
        refreshPanelBody({ preserveScroll: false });
        refreshHeader();
        toast('Generation state reset.', 'info');
    }, 'wandlight-danger-button'));

    actions.appendChild(createButton('Reset All Settings', 'Resets Wandlight preferences and provider settings to bundled defaults. Stored API keys are preserved.', async () => {
        const proceed = await confirmAction('Are you sure? Reset all Wandlight settings?', 'You are about to reset Wandlight preferences, workflow settings, provider selections, generation settings, injection settings, and UI defaults. Stored API keys are preserved. Chat state, accepted lore, pending lore, and Lore Timeline are not changed. Continue?');
        if (!proceed) return;
        resetAllSettingsToDefaults();
        refreshPanelBody({ preserveScroll: false });
        refreshHeader();
        toast('Wandlight settings reset to defaults. Stored API keys were preserved.', 'info');
    }, 'wandlight-danger-button'));

    actions.appendChild(createButton('Total Reset', 'Resets Wandlight continuity state for this chat to defaults and clears Lore Timeline. Panel size and position are preserved.', async () => {
        const proceed = await confirmAction('Are you sure? Total reset?', 'You are about to reset all Wandlight data for this chat: lightweight continuity state, accepted lore, pending lore, generation state, and Lore Timeline. Window position and size are preserved. Because recovery data will also be cleared, this action cannot be undone. Continue?');
        if (!proceed) return;
        const current = getState();
        const defaults = getDefaultState();
        defaults.stateHistory = [];
        defaults.memoHistory = [];
        if (current.lorePanel) {
            defaults.lorePanel = {
                ...defaults.lorePanel,
                isOpen: true,
                x: current.lorePanel.x,
                y: current.lorePanel.y,
                width: current.lorePanel.width,
                height: current.lorePanel.height,
                activeTab: 'session',
            };
        }
        saveState(defaults);
        refreshPanelBody({ preserveScroll: false });
        refreshHeader();
        toast('Wandlight state reset. Lore Timeline cleared.', 'info');
    }, 'wandlight-danger-button'));

    card.appendChild(actions);
    return card;
}

function ensureProviderReadyForAction(kind = 'lore', actionLabel = 'this action', statusKind = kind) {
    const validation = validateLoreProviderConfiguration(kind);
    if (validation.ok) return true;

    const message = `API/model settings incomplete for ${actionLabel}: ${validation.message}`;
    setFeatureProgress(statusKind, message, 100);
    toast(message, 'error');
    return false;
}

function ensureLoreProviderReadyForAction(actionLabel = 'this action', statusKind = 'lore') {
    return ensureProviderReadyForAction('lore', actionLabel, statusKind);
}

function ensureContinuityProviderReadyForAction(actionLabel = 'this action') {
    return ensureProviderReadyForAction('continuity', actionLabel, 'continuity');
}


// Context tab -----------------------------------------------------------------

function renderContextTab(container, state) {
    container.appendChild(createSectionHeader(
        'Story Context',
        'Detect and edit the date, canon reference point, and branch used by lore generation. Actions are colocated with the fields they update.'
    ));

    container.appendChild(createContextDetectionCard(state));
    container.appendChild(createContextEditorCard(state));
}

function createContextDetectionCard(state) {
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card wandlight-generation-progress-card';
    markTourTarget(card, 'context.detect.card');

    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = 'Context Detection';
    addTooltip(title, 'Detects story context from recent chat and fills the Story Context fields below. It does not create lore entries.');
    card.appendChild(title);

    const settings = getSettings();
    if (!isBasicExperience(settings)) {
        const automationCard = createAutomationModeCard(
            'Story Context Detection',
            'contextDetectionMode',
            'contextDetectionAutoInterval',
            'Only runs when you click Detect Story Context.',
            'Runs automatically after roleplay turns on this interval. When fast header detection is enabled, it scans reply headers first and only uses the Reasoning provider if no header is found.',
            'Automatic story-context detection interval in completed model turns.'
        );
        markTourTarget(automationCard, 'context.automation');
        card.appendChild(automationCard);

        const fastGrid = document.createElement('div');
        fastGrid.className = 'wandlight-runtime-grid';
        markTourTarget(fastGrid, 'context.fastHeader');
        fastGrid.appendChild(createToggleCard(
            'Fast reply-header detection',
            settings.contextHeaderDetectionEnabled !== false,
            'Scans recent model replies for the Wandlight date/time/location/weather header. If a valid header is found, Story Context is set locally and the model call is skipped.',
            (checked) => {
                const next = getSettings();
                next.contextHeaderDetectionEnabled = checked;
                saveSettings(next);
            }
        ));
        card.appendChild(fastGrid);

        const sourceRow = document.createElement('label');
        sourceRow.className = 'wandlight-slider-row wandlight-compact-slider-row';
        markTourTarget(sourceRow, 'context.sourceMessages');
        const sourceText = document.createElement('span');
        sourceText.textContent = `Context source messages: ${settings.contextSourceMessageCount || 20}`;
        addTooltip(sourceText, 'How many recent chat messages are scanned for reply headers or sent to model story-context detection. This is separate from the Lore generation source window.');
        const sourceInput = document.createElement('input');
        sourceInput.type = 'range';
        sourceInput.min = '4';
        sourceInput.max = '200';
        sourceInput.step = '1';
        sourceInput.value = String(settings.contextSourceMessageCount || 20);
        sourceInput.addEventListener('input', () => {
            const next = getSettings();
            next.contextSourceMessageCount = Math.max(4, Math.min(200, parseInt(sourceInput.value, 10) || 20));
            saveSettings(next);
            sourceText.textContent = `Context source messages: ${next.contextSourceMessageCount}`;
        });
        sourceRow.appendChild(sourceText);
        sourceRow.appendChild(sourceInput);
        card.appendChild(sourceRow);

        appendSettingsResetButton(card, CONTEXT_DETECTION_SETTING_KEYS, 'Context detection settings');
    }

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions wandlight-generation-actions';
    actions.appendChild(markTourTarget(createButton('Detect Story Context', 'Analyzes recent messages and fills the Story Context fields below. It does not create lore entries.', async (btn) => {
        await handleDetectStoryContext(btn);
    }, 'wandlight-primary-button'), 'context.detect'));
    card.appendChild(actions);

    appendGenerationStatus(card, state, 'context');
    return card;
}

function createLoreGenerationCard(state) {
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card wandlight-generation-progress-card wandlight-lore-generation-card';
    markTourTarget(card, 'lore.generation');

    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = 'Lore Generation';
    addTooltip(title, 'Create reviewable lore entries either from the local canon database or from model analysis of recent story messages.');
    card.appendChild(title);

    card.appendChild(createLoreContextStatusCard(state));

    const actionsGrid = document.createElement('div');
    actionsGrid.className = 'wandlight-lore-generation-grid';
    actionsGrid.appendChild(createCanonSuggestionPanel(state));
    actionsGrid.appendChild(createStoryLoreGenerationPanel(state));
    card.appendChild(actionsGrid);

    return card;
}

function createLoreContextStatusCard(state) {
    const context = state?.loreContext || {};
    const card = document.createElement('div');
    card.className = 'wandlight-lore-context-status';
    markTourTarget(card, 'lore.contextStatus');

    const label = document.createElement('div');
    label.className = 'wandlight-lore-context-status-label';
    label.textContent = 'Story Context';
    addTooltip(label, 'Canon suggestions use Story Context to know the current date, canon boundary, and branch. Detect or edit this in the Context tab.');
    card.appendChild(label);

    const value = document.createElement('div');
    value.className = 'wandlight-lore-context-status-value';
    if (hasUsableStoryContext(context)) {
        const parts = [context.sceneDate, context.canonBoundary, context.branchId ? `Branch: ${context.branchId}` : '']
            .map(part => String(part || '').trim())
            .filter(Boolean);
        value.textContent = parts.join(' · ') || 'Story Context detected';
    } else {
        value.textContent = 'No Story Context';
        value.classList.add('wandlight-warning-text');
    }
    card.appendChild(value);

    const action = createButton('Refresh Context', 'Runs Detect Story Context, then returns here. Useful before suggesting canon lore.', async (btn) => {
        await handleDetectStoryContext(btn, { stayOnTab: 'lore' });
    }, 'wandlight-secondary-button wandlight-compact-action-button');
    markTourTarget(action, 'lore.contextRefresh');
    card.appendChild(action);

    return card;
}

function createCanonSuggestionPanel(state) {
    const settings = getSettings();
    const db = state?.canonLoreDatabase || {};
    const panel = document.createElement('div');
    panel.className = 'wandlight-lore-generation-panel wandlight-canon-suggestion-panel';

    const header = document.createElement('div');
    header.className = 'wandlight-lore-generation-panel-title';
    header.textContent = 'Suggest Canon Lore';
    addTooltip(header, 'Uses the local Lore Database and current Story Context to propose date-aware canon constraints. No model call.');
    panel.appendChild(header);

    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help';
    help.textContent = 'Preview local canon packs for the current Story Context, choose only the entries you want, then add them to Pending Lore Review. No API/model cost.';
    panel.appendChild(help);

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions wandlight-generation-actions';
    actions.appendChild(markTourTarget(createButton('Preview Canon Packs', 'Queries the local Lore Database and groups matching entries into selectable packs with counts.', async (btn) => {
        await handlePreviewCanonLorePacks(btn);
    }, 'wandlight-primary-button'), 'lore.canon.preview'));
    actions.appendChild(markTourTarget(createButton('Quick Add Top Matches', `Legacy one-click flow: proposes up to ${settings.canonLoreMaxEntries || 10} top matches into Pending Lore Review.`, async (btn) => {
        await handleSuggestCanonLore(btn);
    }, 'wandlight-secondary-button'), 'lore.canon.quick'));
    panel.appendChild(actions);

    panel.appendChild(createCanonPreviewSection(state));

    if (!isBasicExperience(settings)) {
        const advanced = createCollapsibleSection(
            'lore.canonSuggestionSettings',
            'Canon Suggestion Settings',
            settings.canonLoreDatabaseEnabled === false ? 'disabled' : (settings.canonLoreAutoPropose === false ? 'manual' : 'auto after context'),
            false,
            createCanonSuggestionSettingsContent(state),
            { tooltip: 'Low-frequency local canon database settings.' }
        );
        markTourTarget(advanced, 'lore.canon.settings');
        panel.appendChild(advanced);
    }

    appendGenerationStatus(panel, state, 'canon');
    panel.appendChild(createKeyValue('Last query', db.lastQueriedAt ? new Date(db.lastQueriedAt).toLocaleString() : 'never', 'When the local canon database was last queried.'));
    panel.appendChild(createKeyValue('Last result', db.lastStatus || 'Not queried.', 'Summary of the last local canon lore query.'));

    return panel;
}

function createCanonSuggestionSettingsContent(state) {
    const settings = getSettings();
    const content = document.createElement('div');
    content.className = 'wandlight-canon-suggestion-settings';

    const grid = document.createElement('div');
    grid.className = 'wandlight-runtime-grid';
    markTourTarget(grid, 'lore.canon.settingsToggles');
    grid.appendChild(createToggleCard(
        'Use Local Canon Database',
        settings.canonLoreDatabaseEnabled !== false,
        'Allows manual previews, quick add, and optional auto-suggest to query local pre-generated canon lore files.',
        (checked) => {
            const next = getSettings();
            next.canonLoreDatabaseEnabled = checked;
            saveSettings(next);
            refreshPanelBody({ preserveScroll: true });
        }
    ));
    grid.appendChild(createToggleCard(
        'Auto-suggest after Context detection',
        settings.canonLoreAutoPropose !== false,
        'When enabled, a Story Context detection run also performs the quick top-match canon proposal. It does not affect manual previews.',
        (checked) => {
            const next = getSettings();
            next.canonLoreAutoPropose = checked;
            saveSettings(next);
            refreshPanelBody({ preserveScroll: true });
        }
    ));
    content.appendChild(grid);

    const capRow = document.createElement('label');
    capRow.className = 'wandlight-slider-row wandlight-compact-slider-row';
    markTourTarget(capRow, 'lore.canon.cap');
    const capText = document.createElement('span');
    capText.textContent = `Quick/auto add cap: ${settings.canonLoreMaxEntries || 10}`;
    addTooltip(capText, 'Maximum entries used only by Quick Add Top Matches and auto-suggest after Story Context detection. Pack preview counts are not capped by this slider.');
    const capInput = document.createElement('input');
    capInput.type = 'range';
    capInput.min = '1';
    capInput.max = '200';
    capInput.step = '1';
    capInput.value = String(settings.canonLoreMaxEntries || 10);
    capInput.addEventListener('input', () => {
        const next = getSettings();
        next.canonLoreMaxEntries = Math.max(1, Math.min(200, parseInt(capInput.value, 10) || 10));
        saveSettings(next);
        capText.textContent = `Quick/auto add cap: ${next.canonLoreMaxEntries}`;
    });
    capRow.appendChild(capText);
    capRow.appendChild(capInput);
    content.appendChild(capRow);

    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help';
    help.textContent = 'Auto-suggest runs only when Story Context detection runs. With the default automatic context interval, that is interval-based, not every message. Manual pack preview can be run any time.';
    content.appendChild(help);
    return content;
}

function getCanonPreviewContextKey(context = {}) {
    return [
        context.sceneDate || '',
        context.subjectiveDate || '',
        context.canonBoundary || '',
        context.branchId || '',
        context.timeTravelMode || '',
    ].map(value => String(value || '').trim()).join('|');
}

function getCanonPreviewSelectedIds() {
    return new Set(Array.isArray(canonPreviewUiState.selectedEntryIds) ? canonPreviewUiState.selectedEntryIds : []);
}

function setCanonPreviewSelectedIds(ids = []) {
    canonPreviewUiState.selectedEntryIds = Array.from(new Set((ids || []).map(id => String(id || '')).filter(Boolean)));
}

function getCanonPreviewEntrySummary(entry = {}) {
    const content = entry.content || {};
    return content.injection
        || content.fact
        || entry.fact
        || (Array.isArray(content.constraints) ? content.constraints[0] : '')
        || (Array.isArray(content.antiLore) ? content.antiLore[0] : '')
        || '';
}

function getCanonPreviewEntryMap(preview = null) {
    return new Map((preview?.entries || []).map(entry => [String(entry.id || ''), entry]));
}

function isCanonPreviewEntryAddable(entry = {}) {
    return (entry.extensions?.canonPreview?.duplicateStatus || 'new') === 'new';
}

const CANON_PREVIEW_DETAIL_LEVELS = [
    { id: 'core', label: 'Core', tooltip: 'Only highest-value active guardrails and reveal blockers.' },
    { id: 'standard', label: 'Standard', tooltip: 'Core plus normal character, access, and constraint entries.' },
    { id: 'detailed', label: 'Detailed', tooltip: 'Includes low-priority and micro constraints that are still active.' },
    { id: 'all', label: 'All Active', tooltip: 'Shows every active non-reference entry in each pack.' },
];

function getCanonPreviewDetailLevel() {
    return ['core', 'standard', 'detailed', 'all'].includes(canonPreviewUiState.detailLevel)
        ? canonPreviewUiState.detailLevel
        : 'standard';
}

function getCanonPreviewDetailRank(level) {
    const normalized = String(level || '').toLowerCase();
    if (normalized === 'core') return 1;
    if (normalized === 'standard') return 2;
    if (normalized === 'detailed') return 3;
    return 4;
}

function getCanonPreviewEntryDetailLevel(entry = {}) {
    const level = entry.extensions?.canonPreview?.detailLevel || 'standard';
    return ['core', 'standard', 'detailed'].includes(level) ? level : 'standard';
}

function canonPreviewDetailAllows(entry = {}, detailLevel = getCanonPreviewDetailLevel()) {
    if (detailLevel === 'all') return true;
    return getCanonPreviewDetailRank(getCanonPreviewEntryDetailLevel(entry)) <= getCanonPreviewDetailRank(detailLevel);
}

function createCanonPreviewDetailControls() {
    const active = getCanonPreviewDetailLevel();
    const wrap = document.createElement('div');
    wrap.className = 'wandlight-canon-detail-filter';
    CANON_PREVIEW_DETAIL_LEVELS.forEach(option => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `wandlight-canon-detail-button ${active === option.id ? 'wandlight-canon-detail-active' : ''}`.trim();
        btn.textContent = option.label;
        addTooltip(btn, option.tooltip);
        btn.addEventListener('click', (event) => {
            event.stopPropagation();
            canonPreviewUiState.detailLevel = option.id;
            refreshPanelBody({ preserveScroll: true });
        });
        wrap.appendChild(btn);
    });
    return wrap;
}

function createCanonPreviewSection(state) {
    const section = document.createElement('div');
    section.className = 'wandlight-canon-preview-section';
    markTourTarget(section, 'lore.canon.previewResults');
    const preview = canonPreviewUiState.preview;
    const currentContextKey = getCanonPreviewContextKey(state?.loreContext || {});
    const isStale = !!(preview && canonPreviewUiState.contextKey && canonPreviewUiState.contextKey !== currentContextKey);

    if (!preview) {
        section.appendChild(createEmptyMessage('No canon pack preview yet. Preview packs to choose entries before adding them to Pending Lore Review.'));
        return section;
    }

    if (preview.status === 'disabled') {
        section.appendChild(createEmptyMessage('The local canon database is disabled in Canon Suggestion Settings.'));
        return section;
    }
    if (preview.status === 'no_date') {
        section.appendChild(createEmptyMessage('No parseable Scene date. Detect or enter Story Context before previewing canon packs.'));
        return section;
    }
    if (!preview.entries?.length) {
        section.appendChild(createEmptyMessage('No canon database entries matched this Story Context.'));
        return section;
    }

    const summary = document.createElement('div');
    summary.className = 'wandlight-canon-preview-summary';
    const yearText = preview.schoolYear ? `Year ${preview.schoolYear} | ` : '';
    summary.textContent = `${yearText}${preview.sceneIso || 'unknown date'} | ${preview.matchedCount || preview.entries.length} matches | ${preview.newCount || 0} new | ${preview.duplicateCount || 0} already present`;
    section.appendChild(summary);
    section.appendChild(markTourTarget(createCanonPreviewDetailControls(), 'lore.canon.detailFilter'));

    if (isStale) {
        const stale = document.createElement('div');
        stale.className = 'wandlight-runtime-help wandlight-warning-text';
        stale.textContent = 'This preview was built for earlier Story Context. Refresh Canon Packs before adding entries.';
        section.appendChild(stale);
    }

    const packs = Array.isArray(preview.packs) ? preview.packs : [];
    const detailLevel = getCanonPreviewDetailLevel();
    const entryMap = getCanonPreviewEntryMap(preview);
    const activePack = packs.find(pack => pack.id === canonPreviewUiState.selectedPackId)
        || packs.find(pack => pack.newCount > 0)
        || packs[0]
        || null;
    if (activePack && canonPreviewUiState.selectedPackId !== activePack.id) {
        canonPreviewUiState.selectedPackId = activePack.id;
    }

    const packGrid = document.createElement('div');
    packGrid.className = 'wandlight-canon-pack-grid';
    markTourTarget(packGrid, 'lore.canon.packGrid');
    packs.forEach(pack => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `wandlight-canon-pack-button ${pack.id === activePack?.id ? 'wandlight-canon-pack-active' : ''}`.trim();
        addTooltip(btn, pack.description || 'Canon preview pack.');
        const packEntriesForDetail = (pack.entryIds || [])
            .map(id => entryMap.get(String(id)))
            .filter(Boolean)
            .filter(entry => canonPreviewDetailAllows(entry, detailLevel));
        const packNewForDetail = packEntriesForDetail.filter(isCanonPreviewEntryAddable).length;

        const label = document.createElement('span');
        label.className = 'wandlight-canon-pack-label';
        label.textContent = `${pack.label} (${packEntriesForDetail.length})`;
        btn.appendChild(label);

        const meta = document.createElement('span');
        meta.className = 'wandlight-canon-pack-meta';
        meta.textContent = `${packNewForDetail} new${packEntriesForDetail.length !== (pack.totalCount || 0) ? ` of ${pack.totalCount || 0}` : ''}${pack.duplicateCount ? `, ${pack.duplicateCount} present` : ''}`;
        btn.appendChild(meta);

        btn.addEventListener('click', (event) => {
            event.stopPropagation();
            canonPreviewUiState.selectedPackId = pack.id;
            refreshPanelBody({ preserveScroll: true });
        });
        packGrid.appendChild(btn);
    });
    section.appendChild(packGrid);

    if (!activePack) {
        section.appendChild(createEmptyMessage('No canon packs are available for this preview.'));
        return section;
    }

    const packEntriesAll = (activePack.entryIds || []).map(id => entryMap.get(String(id))).filter(Boolean);
    const packEntries = packEntriesAll.filter(entry => canonPreviewDetailAllows(entry, detailLevel));
    const addablePackIds = packEntries.filter(isCanonPreviewEntryAddable).map(entry => entry.id);
    const selectedIds = getCanonPreviewSelectedIds();
    const selectedAddableCount = Array.from(selectedIds).filter(id => isCanonPreviewEntryAddable(entryMap.get(String(id)) || {})).length;

    const controls = document.createElement('div');
    controls.className = 'wandlight-canon-preview-actions';
    markTourTarget(controls, 'lore.canon.addPending');
    const count = document.createElement('span');
    count.className = 'wandlight-canon-preview-selected-count';
    count.textContent = `${selectedAddableCount} selected`;
    controls.appendChild(count);
    controls.appendChild(createButton('Select Pack', `Selects all visible new entries in ${activePack.label} at the current detail level.`, () => {
        setCanonPreviewSelectedIds([...selectedIds, ...addablePackIds]);
        refreshPanelBody({ preserveScroll: true });
    }, 'wandlight-small-button'));
    controls.appendChild(createButton('Clear', 'Clears the current canon preview selection.', () => {
        setCanonPreviewSelectedIds([]);
        refreshPanelBody({ preserveScroll: true });
    }, 'wandlight-small-button'));
    const addSelected = createButton('Add Selected to Pending Lore', 'Adds selected canon preview entries to the existing Pending Lore Review list for full inspection before accepting.', async (btn) => {
        await handleAddCanonPreviewEntries(btn, Array.from(getCanonPreviewSelectedIds()));
    }, 'wandlight-primary-button');
    addSelected.disabled = isStale || selectedAddableCount <= 0;
    controls.appendChild(addSelected);
    const addPack = createButton('Add Pack to Pending Lore', `Adds all new entries in ${activePack.label} to Pending Lore Review.`, async (btn) => {
        await handleAddCanonPreviewEntries(btn, addablePackIds);
    }, 'wandlight-secondary-button');
    addPack.disabled = isStale || addablePackIds.length <= 0;
    controls.appendChild(addPack);
    section.appendChild(controls);

    const list = document.createElement('div');
    list.className = 'wandlight-canon-preview-list';
    markTourTarget(list, 'lore.canon.entryList');
    const visibleEntries = packEntries.slice(0, 80);
    visibleEntries.forEach(entry => {
        list.appendChild(createCanonPreviewEntryRow(entry, selectedIds, isStale));
    });
    if (!visibleEntries.length) {
        list.appendChild(createEmptyMessage(`No ${activePack.label} entries at the ${detailLevel === 'all' ? 'All Active' : detailLevel} detail level.`));
    }
    if (packEntriesAll.length > packEntries.length) {
        const hidden = document.createElement('div');
        hidden.className = 'wandlight-runtime-help wandlight-compact-help';
        hidden.textContent = `${packEntriesAll.length - packEntries.length} entries hidden by the current detail level. Switch to Detailed or All Active to inspect them.`;
        list.appendChild(hidden);
    }
    if (packEntries.length > visibleEntries.length) {
        const note = document.createElement('div');
        note.className = 'wandlight-runtime-help wandlight-compact-help';
        note.textContent = `Showing first ${visibleEntries.length} of ${packEntries.length}. Select Pack still selects every new entry in this pack.`;
        list.appendChild(note);
    }
    section.appendChild(list);
    return section;
}

function createCanonPreviewEntryRow(entry, selectedIds, isStale = false) {
    const id = String(entry?.id || '');
    const duplicateStatus = entry?.extensions?.canonPreview?.duplicateStatus || 'new';
    const duplicateReason = entry?.extensions?.canonPreview?.duplicateReason || '';
    const addable = !isStale && duplicateStatus === 'new';
    const row = document.createElement('label');
    row.className = `wandlight-canon-preview-row ${selectedIds.has(id) ? 'wandlight-canon-preview-row-selected' : ''} ${addable ? '' : 'wandlight-canon-preview-row-disabled'}`.trim();
    markTourTarget(row, 'lore.canon.entry');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selectedIds.has(id);
    checkbox.disabled = !addable;
    checkbox.addEventListener('change', (event) => {
        event.stopPropagation();
        const next = getCanonPreviewSelectedIds();
        if (checkbox.checked) next.add(id);
        else next.delete(id);
        setCanonPreviewSelectedIds(Array.from(next));
        refreshPanelBody({ preserveScroll: true });
    });
    row.appendChild(checkbox);

    const main = document.createElement('div');
    main.className = 'wandlight-canon-preview-row-main';
    const title = document.createElement('div');
    title.className = 'wandlight-canon-preview-row-title';
    title.textContent = entry?.title || 'Canon lore';
    main.appendChild(title);

    const text = document.createElement('div');
    text.className = 'wandlight-canon-preview-row-text';
    text.textContent = getCanonPreviewEntrySummary(entry);
    main.appendChild(text);

    const meta = document.createElement('div');
    meta.className = 'wandlight-lore-entry-meta wandlight-canon-preview-row-meta';
    const previewMeta = entry?.extensions?.canonPreview || {};
    if (entry?.category) meta.appendChild(createBadge(entry.category, 'Canon entry category.'));
    if (entry?.lorePurpose) meta.appendChild(createBadge(LORE_PURPOSE_LABELS[entry.lorePurpose] || entry.lorePurpose, 'Why this canon entry would be useful.'));
    if (previewMeta.suggestionRole) meta.appendChild(createBadge(previewMeta.suggestionRole.replace(/_/g, ' '), 'Canon preview role used for pack sorting.'));
    if (previewMeta.detailLevel) meta.appendChild(createBadge(previewMeta.detailLevel, 'Canon preview detail tier.'));
    if (previewMeta.suggestByDefault === false) meta.appendChild(createBadge('non-default', 'Shown only in All Active or higher-detail review because this is not usually worth suggesting automatically.'));
    if (entry?.relevance) meta.appendChild(createBadge(entry.relevance, 'Recommended relevance tier for Pending Lore Review.'));
    meta.appendChild(createBadge(`P${Number(entry?.priority || 50)}`, 'Canon database priority.'));
    if (duplicateStatus !== 'new') {
        meta.appendChild(createBadge(duplicateStatus, duplicateReason || 'Already present by id/title.'));
    }
    main.appendChild(meta);

    row.appendChild(main);
    return row;
}

function createStoryLoreGenerationPanel(state) {
    const panel = document.createElement('div');
    panel.className = 'wandlight-lore-generation-panel wandlight-story-lore-generation-panel';
    markTourTarget(panel, 'lore.story');

    const header = document.createElement('div');
    header.className = 'wandlight-lore-generation-panel-title';
    header.textContent = 'Scan Story Lore';
    addTooltip(header, 'Uses the Reasoning provider to scan chat messages and create story-specific lore entries for Pending Lore Review. The scan can cover recent messages, a custom range, or the entire chat.');
    panel.appendChild(header);

    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help wandlight-lore-scan-help';
    help.textContent = 'Model-based story scan. Uses resumable chunks, partial saves, retries, and configurable scan ranges. Output stays pending until accepted.';
    panel.appendChild(help);

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions wandlight-generation-actions';
    const scanBtn = markTourTarget(createButton('Scan Story Lore', 'Scans the configured message range, processes chunks in parallel, and appends generated story-specific lore into Pending Lore Review as chunks complete.', async (btn) => {
        await handleBulkGeneratePendingLore(btn);
    }, 'wandlight-primary-button'), 'lore.story.scan');
    if (loreGenerationUiRunning || activeLoreGenerationController) {
        scanBtn.disabled = true;
        scanBtn.textContent = 'Scan Running...';
    }
    actions.appendChild(scanBtn);

    const cancelBtn = createButton('Cancel Scan', 'Cancels the current story-lore scan after active provider requests return or abort.', () => {
        if (activeLoreGenerationController) {
            activeLoreGenerationController.abort();
            setFeatureProgress('lore', 'Cancelling story lore scan...', Math.max(1, Number(getState()?.lorePanel?.loreProgress) || 1));
        }
    }, 'wandlight-danger-button');
    cancelBtn.disabled = !activeLoreGenerationController;
    actions.appendChild(cancelBtn);
    panel.appendChild(actions);

    appendGenerationStatus(panel, state, 'lore');
    const resultsCard = createBulkLoreLedgerStatusCard(state);
    if (resultsCard) panel.appendChild(resultsCard);

    if (!isBasicExperience()) {
        const settingsSection = createCollapsibleSection(
            'lore.storyGenerationSettings',
            'Story Lore Scan Settings',
            getLoreScanSettingsSummary(getSettings()),
            false,
            createStoryLoreSettingsContent(),
            { tooltip: 'Advanced model-based story-lore scan controls. Most users can leave these defaults unchanged.', className: 'wandlight-story-lore-settings-collapsible' }
        );
        markTourTarget(settingsSection, 'lore.story.settings');
        panel.appendChild(settingsSection);
    }

    return panel;
}

function getLoreScanSettingsSummary(settings = getSettings()) {
    const mode = settings.loreBulkScanMode || 'recent';
    const label = mode === 'entire' ? 'entire chat' : (mode === 'range' ? 'custom range' : `last ${settings.loreSourceMessageCount || 40}`);
    return `${label} · ${settings.loreBulkChunkSize || 10}/chunk · ${settings.loreBulkConcurrency || 3} parallel`;
}

function createStoryLoreSettingsContent() {
    const settings = getSettings();
    const wrap = document.createElement('div');
    wrap.className = 'wandlight-story-lore-settings-content';

    const scopeSection = createCollapsibleSection(
        'lore.story.scanScope',
        'Scan Scope',
        getLoreScanScopeSummary(settings),
        true,
        createLoreScanScopeSettingsContent(),
        { tooltip: 'Choose which chat messages are scanned for story lore.', className: 'wandlight-compact-subsection wandlight-lore-scan-scope-subsection' }
    );
    markTourTarget(scopeSection, 'lore.story.scope');
    wrap.appendChild(scopeSection);

    const performanceSection = createCollapsibleSection(
        'lore.story.performance',
        'Performance',
        getLoreScanPerformanceSummary(settings),
        false,
        createLoreScanPerformanceSettingsContent(),
        { tooltip: 'Controls throughput, chunk size, overlap, and retry behavior for story-lore scanning.', className: 'wandlight-compact-subsection' }
    );
    markTourTarget(performanceSection, 'lore.story.performance');
    wrap.appendChild(performanceSection);

    const qualitySection = createCollapsibleSection(
        'lore.story.quality',
        'Generation Quality',
        getLoreScanQualitySummary(settings),
        false,
        createLoreScanQualitySettingsContent(),
        { tooltip: 'Controls breadth, generated fact count, tags, and duplicate filtering.', className: 'wandlight-compact-subsection' }
    );
    markTourTarget(qualitySection, 'lore.story.quality');
    wrap.appendChild(qualitySection);

    const automationSection = createCollapsibleSection(
        'lore.story.automation',
        'Automation',
        getStoryLoreAutomationSummary(settings),
        false,
        createStoryLoreAutomationSettingsContent(),
        { tooltip: 'Optional automatic story-lore scanning after roleplay turns.', className: 'wandlight-compact-subsection' }
    );
    markTourTarget(automationSection, 'lore.story.automation');
    wrap.appendChild(automationSection);

    return wrap;
}

function getLoreScanScopeSummary(settings = getSettings()) {
    const mode = settings.loreBulkScanMode || 'recent';
    if (mode === 'entire') return 'entire chat';
    if (mode === 'range') return `${settings.loreBulkRangeStart || 1}-${settings.loreBulkRangeEnd || 'latest'}`;
    return `last ${settings.loreSourceMessageCount || 40}`;
}

function getLoreScanPerformanceSummary(settings = getSettings()) {
    return `${settings.loreBulkChunkSize || 10}/chunk · ${settings.loreBulkConcurrency || 3} simultaneous`;
}

function getLoreScanQualitySummary(settings = getSettings()) {
    return `${settings.loreBulkFactsPerChunk || 14} facts/chunk · ${(settings.loreGenerationBreadthMode || 'auto')}`;
}

function getStoryLoreAutomationSummary(settings = getSettings()) {
    if (settings.loreGenerationMode !== 'automatic') return 'manual';
    const words = Number(settings.loreGenerationAutoWordThreshold || 2500);
    const maxTurns = Number(settings.loreGenerationAutoInterval || 50);
    return `~${words} words or ${maxTurns} turns`;
}

function createStoryLoreAutomationSettingsContent() {
    const content = document.createElement('div');
    content.className = 'wandlight-story-lore-automation-content';
    appendSettingsResetButton(content, STORY_LORE_AUTOMATION_SETTING_KEYS, 'Story lore automation settings');
    content.appendChild(createAutomationModeCard(
        'Story Lore Scan',
        'loreGenerationMode',
        'loreGenerationAutoInterval',
        'Only scans when you click Scan Story Lore.',
        'Runs automatically after enough new story text accumulates or the maximum turn interval is reached. Generated lore still waits in Pending Lore Review.',
        'Maximum completed model turns between automatic story-lore scans.'
    ));
    content.appendChild(createRangeSettingRow('Minimum turns', 'Automatic story lore waits at least this many completed model turns unless the maximum turn interval is reached.', 'loreGenerationAutoMinTurns', { min: 1, max: 100, fallback: 20 }));
    content.appendChild(createRangeSettingRow('Word threshold', 'Automatic story lore runs after roughly this many new chat words have accumulated, once the minimum turn count has passed. Set to 0 to use turn interval only.', 'loreGenerationAutoWordThreshold', { min: 0, max: 10000, fallback: 2500, suffix: ' words' }));
    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help wandlight-compact-help';
    help.textContent = 'Automatic story-lore scans are intentionally conservative because they are expensive and produce review work.';
    content.appendChild(help);
    return content;
}

function createLoreScanScopeSettingsContent() {
    const settings = getSettings();
    const content = document.createElement('div');
    content.className = 'wandlight-lore-scan-settings-block';
    appendSettingsResetButton(content, STORY_LORE_SCAN_SCOPE_SETTING_KEYS, 'Story lore scan scope settings');

    const grid = document.createElement('div');
    grid.className = 'wandlight-runtime-grid wandlight-lore-scan-compact-grid';
    grid.appendChild(createSelectSettingRow(
        'Scan range',
        'Controls which messages Scan Story Lore processes. Recent uses Lore source messages; Custom uses explicit 1-based message indexes; Entire scans the whole chat.',
        'loreBulkScanMode',
        [
            ['recent', 'Recent messages'],
            ['range', 'Custom range'],
            ['entire', 'Entire chat'],
        ]
    ));
    grid.appendChild(createNumberSettingRow('Start', 'First 1-based message index used when Scan range is Custom range.', 'loreBulkRangeStart', { min: 1, max: 100000, fallback: 1 }));
    grid.appendChild(createNumberSettingRow('End', 'Last 1-based message index used when Scan range is Custom range. Use 0 to mean latest message.', 'loreBulkRangeEnd', { min: 0, max: 100000, fallback: 0 }));
    content.appendChild(grid);

    const sourceRow = document.createElement('label');
    sourceRow.className = 'wandlight-slider-row wandlight-compact-slider-row wandlight-lore-scan-setting-row';
    const sourceText = document.createElement('span');
    sourceText.textContent = `Recent window: ${settings.loreSourceMessageCount || 40}`;
    addTooltip(sourceText, 'How many recent chat messages are scanned when Scan range is Recent messages.');
    const sourceInput = document.createElement('input');
    sourceInput.type = 'range';
    sourceInput.min = '4';
    sourceInput.max = '200';
    sourceInput.step = '1';
    sourceInput.value = String(settings.loreSourceMessageCount || 40);
    sourceInput.addEventListener('input', () => {
        const next = getSettings();
        next.loreSourceMessageCount = Math.max(4, Math.min(200, parseInt(sourceInput.value, 10) || 40));
        saveSettings(next);
        sourceText.textContent = `Recent window: ${next.loreSourceMessageCount}`;
    });
    sourceRow.appendChild(sourceText);
    sourceRow.appendChild(sourceInput);
    content.appendChild(sourceRow);

    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help wandlight-compact-help';
    help.textContent = 'Use Custom range for backfilling old story sections. Use Entire chat for first-time setup on an existing story.';
    content.appendChild(help);
    return content;
}

function createLoreScanPerformanceSettingsContent() {
    const content = document.createElement('div');
    content.className = 'wandlight-lore-scan-settings-block';
    appendSettingsResetButton(content, STORY_LORE_SCAN_PERFORMANCE_SETTING_KEYS, 'Story lore scan performance settings');
    content.appendChild(createRangeSettingRow('Chunk size', 'Messages per scan chunk. Smaller chunks parse more reliably; larger chunks reduce provider calls.', 'loreBulkChunkSize', { min: 3, max: 50, fallback: 10 }));
    content.appendChild(createRangeSettingRow('Overlap', 'Messages repeated at chunk boundaries to preserve facts that span two intervals. Must be lower than chunk size.', 'loreBulkOverlap', { min: 0, max: 10, fallback: 1 }));
    content.appendChild(createRangeSettingRow('Simultaneous chunks', 'Maximum number of story-lore chunks submitted to the Reasoning provider at the same time.', 'loreBulkConcurrency', { min: 1, max: 8, fallback: 3 }));
    content.appendChild(createRangeSettingRow('Retry attempts', 'Chunk-level retry attempts after empty, malformed, or failed extraction responses.', 'loreBulkRetryAttempts', { min: 0, max: 4, fallback: 2 }));
    content.appendChild(createRangeSettingRow('Save checkpoint every chunks', 'How often the scan writes a full compact checkpoint after lightweight per-chunk saves. Lower is safer; higher reduces persistence overhead.', 'loreBulkFullCheckpointEveryChunks', { min: 1, max: 25, fallback: 5 }));
    content.appendChild(createRangeSettingRow('Consolidate every chunks', 'How many completed chunks to collect before converting extracted facts into Pending Lore entries.', 'loreBulkConsolidationChunkWindow', { min: 1, max: 25, fallback: 5 }));

    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help wandlight-compact-help';
    help.textContent = 'Each chunk still checkpoints immediately for recovery. Full saves and Pending Lore consolidation happen in batches to reduce large-scan overhead.';
    content.appendChild(help);
    return content;
}

function createLoreScanQualitySettingsContent() {
    const settings = getSettings();
    const content = document.createElement('div');
    content.className = 'wandlight-lore-scan-settings-block';
    appendSettingsResetButton(content, STORY_LORE_SCAN_QUALITY_SETTING_KEYS, 'Story lore generation quality settings');

    const modeRow = document.createElement('label');
    modeRow.className = 'wandlight-setting-row wandlight-lore-scan-setting-row';
    const modeLabel = document.createElement('span');
    modeLabel.textContent = 'Scan breadth';
    addTooltip(modeLabel, 'Auto uses bootstrap mode for manual first-runs when accepted story-specific lore is sparse, then incremental mode for maintenance. Bootstrap targets broad story coverage; incremental targets only new or changed facts.');
    const modeSelect = document.createElement('select');
    modeSelect.className = 'text_pole';
    [
        ['auto', 'Auto'],
        ['bootstrap', 'Bootstrap'],
        ['incremental', 'Incremental'],
    ].forEach(([value, label]) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        if ((settings.loreGenerationBreadthMode || 'auto') === value) option.selected = true;
        modeSelect.appendChild(option);
    });
    modeSelect.addEventListener('change', () => {
        const next = getSettings();
        next.loreGenerationBreadthMode = modeSelect.value;
        saveSettings(next);
        refreshPanelBody({ preserveScroll: true });
    });
    modeRow.appendChild(modeLabel);
    modeRow.appendChild(modeSelect);
    content.appendChild(modeRow);

    content.appendChild(createRangeSettingRow('Facts per chunk', 'Upper target for compact facts extracted per chunk before conversion into Pending Lore entries.', 'loreBulkFactsPerChunk', { min: 4, max: 30, fallback: 14 }));
    content.appendChild(createRangeSettingRow('Bootstrap target', 'Approximate total pending entries targeted during broad first-run story-lore scan.', 'loreBootstrapTargetEntries', { min: 12, max: 120, fallback: 40 }));
    content.appendChild(createRangeSettingRow('Incremental target', 'Approximate total pending entries targeted during incremental story-lore scan.', 'loreIncrementalTargetEntries', { min: 3, max: 30, fallback: 8 }));
    content.appendChild(createRangeSettingRow('Generated tags', 'Number of short searchable tags requested per generated lore entry. Set to 0 to disable generated tags.', 'loreTagCount', { min: 0, max: 10, fallback: 4 }));

    const grid = document.createElement('div');
    grid.className = 'wandlight-runtime-grid wandlight-lore-scan-compact-grid';
    grid.appendChild(createToggleCard(
        'Replacement Guard',
        settings.loreReplacementGuard !== false,
        'When enabled, Wandlight asks before replacing an unresolved pending lore batch.',
        (checked) => {
            const next = getSettings();
            next.loreReplacementGuard = checked;
            saveSettings(next);
            refreshPanelBody({ preserveScroll: true });
        }
    ));
    grid.appendChild(createToggleCard(
        'Duplicate Guard',
        settings.loreDuplicateGuard !== false,
        'When enabled, exact duplicate generated entries are filtered and similar entries are routed for update/merge review.',
        (checked) => {
            const next = getSettings();
            next.loreDuplicateGuard = checked;
            saveSettings(next);
            refreshPanelBody({ preserveScroll: true });
        }
    ));
    grid.appendChild(createToggleCard(
        'Similarity Routing',
        settings.loreSimilarityRouting !== false,
        'When enabled, similar generated lore is kept as a possible update or merge instead of being thrown away as a duplicate.',
        (checked) => {
            const next = getSettings();
            next.loreSimilarityRouting = checked;
            saveSettings(next);
            refreshPanelBody({ preserveScroll: true });
        }
    ));
    grid.appendChild(createToggleCard(
        'Strict Quality Gate',
        settings.loreStrictQualityGate !== false,
        'When enabled, low-value recap facts are filtered before Pending Lore Review.',
        (checked) => {
            const next = getSettings();
            next.loreStrictQualityGate = checked;
            saveSettings(next);
            refreshPanelBody({ preserveScroll: true });
        }
    ));
    content.appendChild(grid);

    const rescanRow = createSelectSettingRow(
        'What to rescan',
        'Controls whether Scan Story Lore skips unchanged completed chunks, retries failed chunks, rescans stale edited chunks, or rescans all chunks.',
        'loreBulkRescanMode',
        [
            ['skip_unchanged', 'Skip unchanged'],
            ['retry_failed', 'Retry failed only'],
            ['stale_only', 'Rescan edited only'],
            ['rescan_all', 'Rescan all'],
        ]
    );
    content.appendChild(rescanRow);

    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help wandlight-compact-help';
    help.textContent = 'Priority and final review still happen in Pending Lore Review. Generated entries are not accepted automatically.';
    content.appendChild(help);
    return content;
}

function appendGenerationStatus(card, state, kind = 'lore') {
    const statusKey = `${kind}Status`;
    const progressKey = `${kind}Progress`;

    const status = document.createElement('div');
    status.className = 'wandlight-generation-status-text';
    status.dataset.wandlightStatus = kind;
    status.textContent = state?.lorePanel?.[statusKey] || 'Idle.';
    card.appendChild(status);

    const bar = document.createElement('div');
    bar.className = 'wandlight-progress-bar';
    const fill = document.createElement('div');
    fill.className = 'wandlight-progress-fill';
    fill.dataset.wandlightProgress = kind;
    fill.style.width = `${Math.max(0, Math.min(100, Number(state?.lorePanel?.[progressKey]) || 0))}%`;
    bar.appendChild(fill);
    card.appendChild(bar);
}

async function handleDetectStoryContext(btn, options = {}) {
    if (btn) {
        let result = false;
        await runBusyAction(btn, 'Detecting...', async () => { result = await performStoryContextDetection(options); });
        return result;
    }
    return await performStoryContextDetection(options);
}

async function performStoryContextDetection(options = {}) {
    setFeatureProgress('context', 'Reading chat and detecting story context...', 8);
    const detected = await runLoreContextDetection({ progress: (message, percent) => setFeatureProgress('context', message, percent) });
    const after = getState();
    if (options.stayOnTab) setPanelState({ activeTab: options.stayOnTab }, { deferSave: true });
    refreshHeader();
    refreshPanelBody({ preserveScroll: false });

    const fields = after?.loreContext || {};
    const filled = ['sceneDate', 'subjectiveDate', 'canonBoundary', 'branchId', 'timeTravelMode']
        .filter(key => String(fields[key] || '').trim()).length;

    if (detected && filled > 0) {
        setFeatureProgress('context', 'Story context detected and fields updated.', 100);
        resetFeatureProgress('context');
        toast('Story context detected and fields updated.');
        return true;
    }
    if (detected) {
        toast('Story context detection completed, but it did not find date/canon fields to populate.', 'warning');
        return false;
    }
    const validation = validateLoreProviderConfiguration('lore');
    if (!validation.ok) {
        const message = `API/model settings incomplete for Detect Story Context: ${validation.message}`;
        setFeatureProgress('context', message, 100);
        toast(message, 'error');
        return false;
    }
    toast('Story context detection returned no usable result.', 'warning');
    return false;
}

function hasUsableStoryContext(context = {}) {
    return !![
        context.sceneDate,
        context.subjectiveDate,
        context.canonBoundary,
        context.branchId && context.branchId !== 'main' ? context.branchId : '',
    ].map(value => String(value || '').trim()).find(Boolean);
}

async function ensureStoryContextForCanonAction(actionLabel = 'Canon lore') {
    let state = getState();
    if (hasUsableStoryContext(state?.loreContext || {})) {
        return state;
    }

    const proceed = await confirmAction(
        'No Story Context detected',
        `${actionLabel} needs the story date, canon boundary, and branch. Run Detect Story Context now?`
    );
    if (!proceed) {
        setFeatureProgress('canon', `${actionLabel} cancelled: no Story Context.`, 0);
        return null;
    }

    setFeatureProgress('canon', 'Detecting Story Context before querying canon lore...', 5);
    const detected = await performStoryContextDetection({ stayOnTab: 'lore' });
    state = getState();
    if (!detected || !hasUsableStoryContext(state?.loreContext || {})) {
        setFeatureProgress('canon', 'No Story Context available. Canon lore was not queried.', 100);
        toast('Canon lore needs Story Context before it can run.', 'warning');
        return null;
    }
    return state;
}

async function handlePreviewCanonLorePacks(btn) {
    await runBusyAction(btn, 'Previewing...', async () => {
        const state = await ensureStoryContextForCanonAction('Canon pack preview');
        if (!state) return;

        setFeatureProgress('canon', 'Previewing canon packs from local database...', 20);
        const result = await previewCanonLoreForContext(state?.loreContext || {}, { maxCandidates: 500 });
        canonPreviewUiState = {
            contextKey: getCanonPreviewContextKey(getState()?.loreContext || {}),
            preview: result,
            selectedPackId: (result?.packs || []).find(pack => pack.newCount > 0)?.id || result?.packs?.[0]?.id || '',
            selectedEntryIds: [],
            detailLevel: getCanonPreviewDetailLevel(),
        };

        refreshPanelBody({ preserveScroll: false });
        refreshHeader();

        if (result?.status === 'preview') {
            setFeatureProgress('canon', `Previewed ${result.packs?.length || 0} canon packs with ${result.newCount || 0} new entries.`, 100);
            resetFeatureProgress('canon');
            toast(`Previewed ${result.packs?.length || 0} canon packs. Select entries to add to Pending Lore Review.`, 'info');
        } else if (result?.status === 'no_date') {
            setFeatureProgress('canon', 'No parseable Story Context date. Detect or enter a scene date first.', 100);
            toast('Canon pack preview needs a parseable Scene date first.', 'warning');
        } else if (result?.status === 'disabled') {
            setFeatureProgress('canon', 'Canon database is disabled.', 100);
            toast('Canon database is disabled.', 'warning');
        } else {
            setFeatureProgress('canon', 'No matching canon packs for this context.', 100);
            resetFeatureProgress('canon');
            toast('Canon database found no matching entries for this context.', 'info');
        }
    });
}

async function handleAddCanonPreviewEntries(btn, entryIds = []) {
    const ids = Array.from(new Set((entryIds || []).map(id => String(id || '')).filter(Boolean)));
    if (!ids.length) {
        toast('Select at least one new canon preview entry first.', 'warning');
        return;
    }

    await runBusyAction(btn, 'Adding...', async () => {
        const state = await ensureStoryContextForCanonAction('Adding canon preview entries');
        if (!state) return;

        setFeatureProgress('canon', 'Adding selected canon entries to Pending Lore Review...', 35);
        const result = await addCanonLorePreviewEntriesToPending(ids, state?.loreContext || {}, { maxCandidates: 500 });
        if (result?.status === 'proposed') {
            canonPreviewUiState = {
                contextKey: '',
                preview: null,
                selectedPackId: '',
                selectedEntryIds: [],
                detailLevel: getCanonPreviewDetailLevel(),
            };
            openPendingLoreReviewSections();
            setPanelState({ activeTab: 'lore' }, { deferSave: true });
            refreshPanelBody({ preserveScroll: false });
            refreshHeader();
            setFeatureProgress('canon', `Added ${result.proposedCount || 0} canon entries to Pending Lore Review.`, 100);
            resetFeatureProgress('canon');
            toast(`Added ${result.proposedCount || 0} canon entries to Pending Lore Review.`);
        } else if (result?.status === 'duplicates_only') {
            setFeatureProgress('canon', 'Selected canon entries were already pending or accepted.', 100);
            resetFeatureProgress('canon');
            refreshHeader();
            toast('Selected canon entries were already pending or accepted.', 'info');
        } else if (result?.status === 'disabled') {
            setFeatureProgress('canon', 'Canon database is disabled.', 100);
            toast('Canon database is disabled.', 'warning');
        } else if (result?.status === 'no_date') {
            setFeatureProgress('canon', 'No parseable Story Context date. Canon entries were not added.', 100);
            toast('Canon entries need a parseable Scene date first.', 'warning');
        } else {
            setFeatureProgress('canon', 'No selected canon entries were added.', 100);
            resetFeatureProgress('canon');
            toast('No selected canon entries were added.', 'info');
        }
    });
}

async function handleSuggestCanonLore(btn) {
    await runBusyAction(btn, 'Suggesting...', async () => {
        let state = getState();
        if (!hasUsableStoryContext(state?.loreContext || {})) {
            const proceed = await confirmAction(
                'No Story Context detected',
                'Canon lore suggestions need the story date, canon boundary, and branch. Run Detect Story Context now?'
            );
            if (!proceed) {
                setFeatureProgress('canon', 'Canon suggestion cancelled: no Story Context.', 0);
                return;
            }
            setFeatureProgress('canon', 'Detecting Story Context before suggesting canon lore...', 5);
            const detected = await performStoryContextDetection({ stayOnTab: 'lore' });
            if (!detected || !hasUsableStoryContext(getState()?.loreContext || {})) {
                setFeatureProgress('canon', 'No Story Context available. Canon suggestions were not run.', 100);
                toast('Canon suggestions need Story Context before they can run.', 'warning');
                return;
            }
            setFeatureProgress('canon', 'Story Context detected. Continuing to canon suggestion...', 15);
            state = getState();
        }

        setFeatureProgress('canon', 'Suggesting canon lore from local database...', 20);
        const result = await proposeCanonLoreForContext(state?.loreContext || {}, {
            maxEntries: getSettings().canonLoreMaxEntries || 10,
            progress: (message, percent) => setFeatureProgress('canon', message, percent),
        });

        if (result?.status === 'proposed') {
            openPendingLoreReviewSections();
            setPanelState({ activeTab: 'lore' }, { deferSave: true });
            refreshPanelBody({ preserveScroll: false });
            refreshHeader();
            setFeatureProgress('canon', `Suggested ${result.proposedCount || 0} canon lore entries.`, 100);
            resetFeatureProgress('canon');
            toast(`Suggested ${result.proposedCount || 0} canon lore entries. Review them in Pending Lore Review.`);
        } else if (result?.status === 'duplicates_only') {
            setFeatureProgress('canon', `Matched ${result.matchedCount || 0}, but all selected suggestions already exist.`, 100);
            resetFeatureProgress('canon');
            refreshHeader();
            toast('Canon database matches were already present by id/title.', 'info');
        } else if (result?.status === 'no_date') {
            setFeatureProgress('canon', 'No parseable Story Context date. Detect or enter a scene date first.', 100);
            toast('Canon suggestions need a parseable Scene date first.', 'warning');
        } else if (result?.status === 'disabled') {
            setFeatureProgress('canon', 'Canon database is disabled.', 100);
            toast('Canon database is disabled.', 'warning');
        } else {
            setFeatureProgress('canon', 'No matching canon suggestions for this context.', 100);
            resetFeatureProgress('canon');
            toast('Canon database found no matching entries for this context.', 'info');
        }
    });
}


function createBulkLoreLedgerStatusCard(state) {
    const ledger = state?.loreBulkGeneration || {};
    const batchId = ledger.activeBatchId || ledger.lastBatchId || '';
    const batch = batchId ? ledger.batches?.[batchId] : null;
    if (!batch) return null;

    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card wandlight-bulk-lore-status-card';

    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = 'Lore Scan Results';
    addTooltip(title, 'Shows the latest story-lore scan result, including completed chunks, failed chunks, extracted candidate facts, and Pending Lore Review entries.');
    card.appendChild(title);

    const status = String(batch.status || 'unknown');
    const queued = batch.queuedChunks || batch.totalChunks || 0;
    const completed = batch.completedChunks || 0;
    const failed = batch.failedChunks || 0;
    const candidateCount = batch.candidateCount || 0;
    const pendingCount = batch.pendingEntryCount || (state?.pendingLoreEntries || []).length || 0;
    const qualityDropped = batch.droppedQualityCount || state?.pendingLoreMeta?.droppedQualityCount || 0;
    const routedSimilar = batch.routedSimilarCount || state?.pendingLoreMeta?.routedSimilarCount || 0;

    const summary = document.createElement('div');
    summary.className = 'wandlight-runtime-help wandlight-lore-scan-results-summary';
    summary.textContent = `${status} · ${completed}/${queued} chunks · ${candidateCount} facts · ${pendingCount} pending${failed ? ` · ${failed} failed` : ''}`;
    card.appendChild(summary);

    const grid = document.createElement('div');
    grid.className = 'wandlight-runtime-grid wandlight-lore-scan-results-grid';
    grid.appendChild(createKeyValue('Range', `${batch.rangeStart || '?'}-${batch.rangeEnd || '?'}`, 'Message index range scanned.'));
    grid.appendChild(createKeyValue('Chunks', `${completed}/${queued}`, 'Completed queued chunks over total queued chunks.'));
    grid.appendChild(createKeyValue('Failed', String(failed), 'Chunks that failed after retry attempts and can be retried with What to rescan: Retry failed only.'));
    grid.appendChild(createKeyValue('Facts', String(candidateCount), 'Compact extracted candidate facts stored for this scan.'));
    grid.appendChild(createKeyValue('Pending', String(pendingCount), 'Pending Lore Review entries after scan commits.'));
    if (qualityDropped) grid.appendChild(createKeyValue('Quality filtered', String(qualityDropped), 'Generated candidates discarded by the strict quality gate as low-value recap or insufficiently specific lore.'));
    if (routedSimilar) grid.appendChild(createKeyValue('Routed updates', String(routedSimilar), 'Similar generated candidates kept as possible updates or merges instead of discarded as duplicates.'));
    card.appendChild(grid);
    return card;
}

async function handleBulkGeneratePendingLore(btn) {
    if (loreGenerationUiRunning || activeLoreGenerationController) {
        toast('Lore generation is already running. Use Cancel Scan to stop it.', 'warning');
        return;
    }
    if (!ensureLoreProviderReadyForAction('Scan Story Lore', 'lore')) return;
    activeLoreGenerationController = new AbortController();
    loreGenerationUiRunning = true;
    refreshPanelBody({ preserveScroll: true });
    await runBusyAction(btn, 'Scanning...', async () => {
        setFeatureProgress('lore', 'Starting story lore scan...', 5);
        let result = await runBulkLoreGeneration({
            force: true,
            signal: activeLoreGenerationController?.signal,
            progress: (message, percent) => setFeatureProgress('lore', message, percent),
        });
        if (result?.status === 'pending_lore_exists') {
            const pendingCount = result.pendingCount || 0;
            const sameContext = result.sameContext !== false;
            const proceed = await confirmAction(
                'Pending lore already exists',
                sameContext
                    ? `There are ${pendingCount} unresolved pending lore entr${pendingCount === 1 ? 'y' : 'ies'} for this context. Continue and append/merge new scan results into Pending Lore Review?`
                    : `There are ${pendingCount} unresolved pending lore entr${pendingCount === 1 ? 'y' : 'ies'} from another context. Continue by marking the old batch replaced and starting a fresh scan?`
            );
            if (!proceed) {
                setFeatureProgress('lore', 'Story lore scan cancelled: pending lore still needs review.', 0);
                toast('Review or dismiss existing pending lore before scanning again.', 'info');
                return;
            }
            setFeatureProgress('lore', sameContext ? 'Continuing scan and appending to pending lore...' : 'Replacing stale pending lore and starting scan...', 5);
            result = await runBulkLoreGeneration({
                force: true,
                signal: activeLoreGenerationController?.signal,
                progress: (message, percent) => setFeatureProgress('lore', message, percent),
                allowPendingAppend: sameContext,
                replacePending: !sameContext,
            });
        }
        refreshHeader();

        if (result?.status === 'cancelled') {
            refreshPanelBody({ preserveScroll: true });
            setFeatureProgress('lore', 'Story lore scan cancelled.', 0);
            toast('Story lore scan cancelled.', 'warning');
        } else if (['complete', 'partial'].includes(result?.status)) {
            openPendingLoreReviewSections();
            setPanelState({ activeTab: 'lore' });
            refreshPanelBody({ preserveScroll: false });
            const failedText = result.failedChunkCount ? ` ${result.failedChunkCount} chunk${result.failedChunkCount === 1 ? '' : 's'} failed and can be retried.` : '';
            const skippedText = result.skippedChunks ? ` ${result.skippedChunks} unchanged chunk${result.skippedChunks === 1 ? '' : 's'} skipped.` : '';
            const qualityText = result.droppedQualityCount ? ` ${result.droppedQualityCount} low-value candidate${result.droppedQualityCount === 1 ? '' : 's'} filtered.` : '';
            const routedText = result.routedSimilarCount ? ` ${result.routedSimilarCount} similar candidate${result.routedSimilarCount === 1 ? '' : 's'} routed for update review.` : '';
            setFeatureProgress('lore', `Story lore scan ${result.status}: ${result.completedChunkCount || 0} chunks, ${result.candidateCount || 0} candidate facts, ${result.pendingEntryCount || 0} pending entries.`, 100);
            resetFeatureProgress('lore');
            toast(`Story lore scan ${result.status}. ${result.candidateCount || 0} candidate facts extracted; ${result.pendingEntryCount || 0} pending lore entries now available.${failedText}${skippedText}${qualityText}${routedText}`);
        } else if (result?.status === 'skipped_unchanged') {
            refreshPanelBody({ preserveScroll: true });
            setFeatureProgress('lore', `Story lore scan skipped ${result.skippedChunks || 0} unchanged chunks.`, 100);
            resetFeatureProgress('lore');
            toast('Story lore scan found no changed chunks to process.', 'info');
        } else {
            refreshPanelBody({ preserveScroll: true });
            const details = formatGenerationStatus(result);
            toast(details, 'warning');
        }
    });
    activeLoreGenerationController = null;
    loreGenerationUiRunning = false;
    refreshPanelBody({ preserveScroll: true });
}

function createCanonLoreDatabaseCard(state) {
    const settings = getSettings();
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card wandlight-canon-db-card';

    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = 'Local Canon Lore Database';
    addTooltip(title, 'After Story Context detection finds a parseable canon date, Wandlight locally queries files under the extension Lore folder and proposes relevant canon entries into Pending Lore Review. This does not call the model.');
    card.appendChild(title);

    const db = state?.canonLoreDatabase || {};
    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help';
    help.textContent = 'Canon database entries are proposed for review, not automatically accepted. The database is organized under Lore/characters, Lore/events, Lore/items, Lore/knowledge, and Lore/places.';
    card.appendChild(help);

    const grid = document.createElement('div');
    grid.className = 'wandlight-runtime-grid';
    grid.appendChild(createToggleCard(
        'Use Local Canon Database',
        settings.canonLoreDatabaseEnabled !== false,
        'Allows manual previews, quick queries, and optional auto-suggest to query local pre-generated canon lore files.',
        (checked) => {
            const next = getSettings();
            next.canonLoreDatabaseEnabled = checked;
            saveSettings(next);
            refreshPanelBody({ preserveScroll: true });
        }
    ));
    grid.appendChild(createToggleCard(
        'Auto-suggest After Detection',
        settings.canonLoreAutoPropose !== false,
        'When enabled, a Story Context detection run also performs the quick top-match canon proposal. It does not affect manual pack previews.',
        (checked) => {
            const next = getSettings();
            next.canonLoreAutoPropose = checked;
            saveSettings(next);
            refreshPanelBody({ preserveScroll: true });
        }
    ));
    card.appendChild(grid);

    const maxRow = document.createElement('label');
    maxRow.className = 'wandlight-slider-row wandlight-compact-slider-row';
    const maxText = document.createElement('span');
    maxText.textContent = `Quick/auto add cap: ${settings.canonLoreMaxEntries || 12}`;
    addTooltip(maxText, 'Maximum entries used only by quick query and auto-suggest after Story Context detection. Pack preview counts are not capped by this slider.');
    const maxInput = document.createElement('input');
    maxInput.type = 'range';
    maxInput.min = '1';
    maxInput.max = '200';
    maxInput.step = '1';
    maxInput.value = String(settings.canonLoreMaxEntries || 12);
    maxInput.addEventListener('input', () => {
        const next = getSettings();
        next.canonLoreMaxEntries = Math.max(1, Math.min(200, parseInt(maxInput.value, 10) || 12));
        saveSettings(next);
        maxText.textContent = `Quick/auto add cap: ${next.canonLoreMaxEntries}`;
    });
    maxRow.appendChild(maxText);
    maxRow.appendChild(maxInput);
    card.appendChild(maxRow);

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions';
    actions.appendChild(createButton('Quick Add Top Matches', 'Uses the current Story Context fields to query local canon lore and propose the capped top matches into Pending Lore Review.', async (btn) => {
        await runBusyAction(btn, 'Querying...', async () => {
            setFeatureProgress('context', 'Querying local canon lore database...', 80);
            const result = await proposeCanonLoreForContext(getState()?.loreContext || {}, {
                maxEntries: getSettings().canonLoreMaxEntries || 12,
                progress: (message, percent) => setFeatureProgress('context', message, percent),
            });
            if (result?.status === 'proposed') {
                refreshPanelBody({ preserveScroll: false });
                refreshHeader();
                setFeatureProgress('context', `Canon database proposed ${result.proposedCount || 0} pending lore entries.`, 100);
                resetFeatureProgress('context');
                toast(`Canon database proposed ${result.proposedCount || 0} pending lore entries.`);
            } else if (result?.status === 'duplicates_only') {
                // Do not refresh the whole panel for a no-op duplicate result. In chats that
                // already contain oversized pending canon entries, a full refresh can freeze.
                setFeatureProgress('context', `Canon database matched ${result.matchedCount || 0}, but selected proposals were already present by id/title.`, 100);
                resetFeatureProgress('context');
                refreshHeader();
                toast('Canon database matches were already present by id/title.', 'info');
            } else if (result?.status === 'no_date') {
                toast('Canon database needs a parseable Scene date first.', 'warning');
            } else if (result?.status === 'disabled') {
                toast('Canon database is disabled.', 'warning');
            } else {
                toast('Canon database found no matching entries for this context.', 'info');
            }
        });
    }, 'wandlight-primary-button'));
    card.appendChild(actions);

    card.appendChild(createKeyValue('Last query', db.lastQueriedAt ? new Date(db.lastQueriedAt).toLocaleString() : 'never', 'When the local canon database was last queried.'));
    card.appendChild(createKeyValue('Last result', db.lastStatus || 'Not queried.', 'Summary of the last local canon lore query.'));
    return card;
}

function createContextEditorCard(state) {
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card';
    markTourTarget(card, 'context.editor');

    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = 'Story Context';
    addTooltip(title, 'Date and canon reference data used by lore generation. Detection can infer these, but you can also set them manually when the story has not stated them clearly.');
    card.appendChild(title);

    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help';
    help.textContent = 'Canon reference point means the latest canon knowledge the roleplay should treat as established, such as “through Prisoner of Azkaban” or “before the Triwizard Tournament.” If it stays “not detected,” set it manually or leave it blank for story-original scenes.';
    card.appendChild(help);

    const grid = document.createElement('div');
    grid.className = 'wandlight-runtime-grid wandlight-context-grid';
    markTourTarget(grid, 'context.fields');
    grid.appendChild(createTextSettingField('Scene date', state?.loreContext?.sceneDate || '', 'Example: September 1, 1996. Used for date-sensitive lore.', (value) => updateLoreContextField('sceneDate', value)));
    grid.appendChild(createTextSettingField('Canon reference point', state?.loreContext?.canonBoundary || '', 'Example: Through Chapter 14 of Half-Blood Prince. Used to avoid using future canon prematurely.', (value) => updateLoreContextField('canonBoundary', value)));
    grid.appendChild(createTextSettingField('Branch', state?.loreContext?.branchId || 'main', 'Use “main” for the primary timeline, or a custom branch name for story/time-travel branches.', (value) => updateLoreContextField('branchId', value || 'main')));
    card.appendChild(grid);

    card.appendChild(createKeyValue('Last detected', state?.loreContext?.lastDetectedAt ? new Date(state.loreContext.lastDetectedAt).toLocaleString() : 'never', 'When Story Context was last detected automatically. Manual edits also affect generation immediately.'));
    return card;
}


function createSelectSettingRow(labelText, tooltip, settingKey, options, onChange = null) {
    const settings = getSettings();
    const row = document.createElement('label');
    row.className = 'wandlight-setting-row';
    const label = document.createElement('span');
    label.textContent = labelText;
    addTooltip(label, tooltip);
    const select = document.createElement('select');
    select.className = 'text_pole';
    for (const [value, text] of options) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        if (String(settings[settingKey]) === String(value)) option.selected = true;
        select.appendChild(option);
    }
    select.addEventListener('change', () => {
        const next = getSettings();
        next[settingKey] = select.value;
        saveSettings(next);
        if (typeof onChange === 'function') onChange(select.value);
        refreshPanelBody({ preserveScroll: true });
    });
    row.appendChild(label);
    row.appendChild(select);
    return row;
}

function createNumberSettingRow(labelText, tooltip, settingKey, { min = 0, max = 9999, fallback = 0 } = {}) {
    const settings = getSettings();
    const row = document.createElement('label');
    row.className = 'wandlight-setting-row';
    const label = document.createElement('span');
    label.textContent = labelText;
    addTooltip(label, tooltip);
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'text_pole';
    input.min = String(min);
    input.max = String(max);
    input.step = '1';
    input.value = String(settings[settingKey] ?? fallback);
    input.addEventListener('change', () => {
        const next = getSettings();
        const parsed = parseInt(input.value, 10);
        next[settingKey] = Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : fallback));
        input.value = String(next[settingKey]);
        saveSettings(next);
    });
    row.appendChild(label);
    row.appendChild(input);
    return row;
}

function createRangeSettingRow(labelPrefix, tooltip, settingKey, { min = 0, max = 100, fallback = 0, suffix = '' } = {}) {
    const settings = getSettings();
    const row = document.createElement('label');
    row.className = 'wandlight-slider-row wandlight-compact-slider-row';
    const text = document.createElement('span');
    const rawValue = settings[settingKey] ?? fallback;
    const numericValue = Number.isFinite(Number(rawValue)) ? Number(rawValue) : fallback;
    const currentValue = Math.max(min, Math.min(max, numericValue));
    text.textContent = `${labelPrefix}: ${currentValue}${suffix}`;
    addTooltip(text, tooltip);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = '1';
    input.value = String(currentValue);
    input.addEventListener('input', () => {
        const next = getSettings();
        {
            const parsed = parseInt(input.value, 10);
            next[settingKey] = Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : fallback));
        }
        saveSettings(next);
        text.textContent = `${labelPrefix}: ${next[settingKey]}${suffix}`;
    });
    row.appendChild(text);
    row.appendChild(input);
    return row;
}

function createAutomationModeCard(titleText, modeKey, intervalKey, manualTooltip, automaticTooltip, intervalTooltip) {
    const settings = getSettings();
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card wandlight-automation-mode-card';

    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = titleText;
    addTooltip(title, `${titleText} can run manually from its button or automatically every configured number of turns.`);
    card.appendChild(title);

    const buttons = document.createElement('div');
    buttons.className = 'wandlight-mode-buttons';
    for (const [mode, label, tip] of [
        ['manual', 'Manual', manualTooltip],
        ['automatic', 'Automatic', automaticTooltip],
    ]) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wandlight-mode-button';
        if ((settings[modeKey] || 'manual') === mode) btn.classList.add('wandlight-mode-button-active');
        btn.textContent = label;
        addTooltip(btn, tip);
        btn.addEventListener('click', () => {
            const next = getSettings();
            next[modeKey] = mode;
            saveSettings(next);
            refreshPanelBody({ preserveScroll: true });
            toast(`${titleText} mode set to ${label}.`, 'info');
        });
        buttons.appendChild(btn);
    }
    card.appendChild(buttons);

    const row = document.createElement('label');
    row.className = 'wandlight-slider-row wandlight-compact-slider-row';
    const label = document.createElement('span');
    label.textContent = `Every ${settings[intervalKey] || 5} turns`;
    addTooltip(label, intervalTooltip);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '1';
    input.max = '100';
    input.step = '1';
    input.value = String(settings[intervalKey] || 5);
    input.addEventListener('input', () => {
        const next = getSettings();
        next[intervalKey] = Math.max(1, Math.min(100, parseInt(input.value, 10) || 5));
        saveSettings(next);
        label.textContent = `Every ${next[intervalKey]} turns`;
    });
    row.appendChild(label);
    row.appendChild(input);
    card.appendChild(row);

    return card;
}

function setFeatureProgress(kind = 'lore', message, percent = 0) {
    const statusKind = ['context', 'continuity', 'lore', 'canon'].includes(kind) ? kind : 'lore';
    const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
    const state = getState();
    if (state?.lorePanel) {
        state.lorePanel[`${statusKind}Status`] = message;
        state.lorePanel[`${statusKind}Progress`] = safePercent;
        if (statusKind === 'lore') {
            state.lorePanel.generationStatus = message;
            state.lorePanel.generationProgress = safePercent;
        }
        saveState(state);
    }

    if (!panelRoot) return;
    const text = panelRoot.querySelector(`[data-wandlight-status="${statusKind}"]`);
    const fill = panelRoot.querySelector(`[data-wandlight-progress="${statusKind}"]`);
    if (text) text.textContent = message;
    if (fill) fill.style.width = `${safePercent}%`;
}

const progressResetTimers = new Map();

function resetFeatureProgress(kind = 'lore', delayMs = 1400) {
    const statusKind = ['context', 'continuity', 'lore', 'canon'].includes(kind) ? kind : 'lore';
    const existing = progressResetTimers.get(statusKind);
    if (existing) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
        progressResetTimers.delete(statusKind);
        resetFeatureProgressNow(statusKind);
    }, Math.max(0, Number(delayMs) || 0));
    progressResetTimers.set(statusKind, timer);
}

function resetFeatureProgressNow(kind = 'lore') {
    const statusKind = ['context', 'continuity', 'lore', 'canon'].includes(kind) ? kind : 'lore';
    const existing = progressResetTimers.get(statusKind);
    if (existing) {
        window.clearTimeout(existing);
        progressResetTimers.delete(statusKind);
    }
    const state = getState();
    if (state?.lorePanel) {
        state.lorePanel[`${statusKind}Status`] = 'Idle.';
        state.lorePanel[`${statusKind}Progress`] = 0;
        if (statusKind === 'lore') {
            state.lorePanel.generationStatus = 'Idle.';
            state.lorePanel.generationProgress = 0;
        }
        saveState(state);
    }
    if (!panelRoot) return;
    const text = panelRoot.querySelector(`[data-wandlight-status="${statusKind}"]`);
    const fill = panelRoot.querySelector(`[data-wandlight-progress="${statusKind}"]`);
    if (text) text.textContent = 'Idle.';
    if (fill) fill.style.width = '0%';
}

function resetAllFeatureProgressNow() {
    ['context', 'continuity', 'lore', 'canon'].forEach(kind => resetFeatureProgressNow(kind));
}

function updateLoreContextField(key, value) {
    const current = getState();
    pushStateSnapshot(current, `Edit story context: ${key}`, getSettings().maxSnapshots);
    setLoreContext({ [key]: value, lastDetectedAt: Date.now() });
    refreshHeader();
}

function createTextSettingField(label, value, tooltip, onChange) {
    const wrap = document.createElement('label');
    wrap.className = 'wandlight-inline-field wandlight-context-field';
    addTooltip(wrap, tooltip);

    const span = document.createElement('span');
    span.textContent = label;
    wrap.appendChild(span);

    const input = document.createElement('input');
    input.type = 'text';
    input.value = value || '';
    input.addEventListener('change', () => onChange?.(input.value.trim()));
    wrap.appendChild(input);
    return wrap;
}

function formatGenerationStatus(result) {
    if (!result) return 'Story lore scan ended without a result.';
    const modeText = result.generationMode ? `${result.generationMode} mode` : 'story-lore scan';
    const targetText = result.targetEntryCount ? ` Target: ${result.targetEntryCount}.` : '';
    if (result.status === 'empty_valid_entries') {
        if (result.droppedDuplicateCount) {
            return `Scan in ${modeText} produced ${result.normalizedEntryCount || result.rawEntryCount || 0} normalized entries, but all were duplicate/similar (${result.droppedDuplicateCount} filtered). Try disabling Duplicate Guard or broadening Source Messages.`;
        }
        return `Scan in ${modeText} returned ${result.rawEntryCount || 0} raw entries, but none matched the Wandlight lore schema after normalization.${targetText}`;
    }
    if (result.status === 'failed_parse') return 'Story lore scan returned malformed JSON that could not be repaired.';
    if (result.status === 'failed_no_response') return result.chunkCount ? `Story lore scan in ${modeText} returned no usable responses across ${result.chunkCount} chunk(s). Check provider connection, model output format, max tokens, or reduce chunk size.${targetText}` : 'Story lore scan returned an empty response from the selected model/provider.';
    if (result.status === 'api_not_configured') return `API/model settings incomplete: ${result.error || 'missing provider settings'}`;
    if (result.status === 'no_context_detected') return 'No story context could be detected. Set Story Context manually or increase the scan range.';
    return `Story lore scan ended with status: ${result.status || 'unknown'}`;
}



// Continuity tab --------------------------------------------------------------

const CONTINUITY_SECTION_LABELS = {
    canon: 'Timeline / Date',
    scene: 'Scene',
    characters: 'Active Characters',
    inventory: 'Key Items',
    objectives: 'Active Goals',
    threads: 'Active Threads',
};

const CHARACTER_CONTINUITY_FIELD_LABELS = {
    appearance: 'Appearance Detail',
    emotionalState: 'Emotional State',
};


function getContinuityScanScopeSummary(settings = getSettings()) {
    const mode = settings.continuityScanMode || 'recent';
    if (mode === 'entire') return 'entire chat';
    if (mode === 'range') return `${settings.continuityScanRangeStart || 1}-${settings.continuityScanRangeEnd || 'latest'}`;
    return `last ${settings.continuitySourceMessageCount || 10}`;
}

function getContinuityScanPerformanceSummary(settings = getSettings()) {
    const strategy = settings.continuityScanStrategy || 'adaptive';
    const fast = settings.continuityScanFastThreshold || 4;
    const hybrid = settings.continuityScanHybridThreshold || 80;
    return `${strategy} · fast ≤${fast} · hybrid ≤${hybrid}`;
}

function getContinuityScanResultsSummary(state = getState()) {
    const ledger = state?.continuityScan || {};
    const batch = ledger.lastBatchId ? ledger.batches?.[ledger.lastBatchId] : null;
    if (!batch) return 'no scan results yet';
    const status = batch.status || 'unknown';
    const completed = Number(batch.completedChunks || 0);
    const failed = Number(batch.failedChunks || 0);
    const observations = Number(batch.observationCount || 0);
    return `${status} · ${completed} complete · ${failed} failed · ${observations} observations`;
}

function createContinuityScanScopeSettingsContent() {
    const settings = getSettings();
    const content = document.createElement('div');
    content.className = 'wandlight-lore-scan-settings-block';
    appendSettingsResetButton(content, CONTINUITY_SCAN_SCOPE_SETTING_KEYS, 'Continuity scan scope settings');

    const grid = document.createElement('div');
    grid.className = 'wandlight-runtime-grid wandlight-lore-scan-compact-grid';
    grid.appendChild(createSelectSettingRow(
        'Scan range',
        'Controls which messages Scan Continuity State processes. Recent is safest for routine use; Custom and Entire are for backfilling or repair scans.',
        'continuityScanMode',
        [
            ['recent', 'Recent messages'],
            ['range', 'Custom range'],
            ['entire', 'Entire chat'],
        ]
    ));
    grid.appendChild(createNumberSettingRow('Start', 'First 1-based message index used when Scan range is Custom range.', 'continuityScanRangeStart', { min: 1, max: 100000, fallback: 1 }));
    grid.appendChild(createNumberSettingRow('End', 'Last 1-based message index used when Scan range is Custom range. Use 0 to mean latest message.', 'continuityScanRangeEnd', { min: 0, max: 100000, fallback: 0 }));
    content.appendChild(grid);

    const sourceRow = document.createElement('label');
    sourceRow.className = 'wandlight-slider-row wandlight-compact-slider-row wandlight-lore-scan-setting-row';
    const sourceText = document.createElement('span');
    sourceText.textContent = `Recent window: ${settings.continuitySourceMessageCount || 10}`;
    addTooltip(sourceText, 'How many recent chat messages are scanned when Scan range is Recent messages.');
    const sourceInput = document.createElement('input');
    sourceInput.type = 'range';
    sourceInput.min = '1';
    sourceInput.max = '200';
    sourceInput.step = '1';
    sourceInput.value = String(settings.continuitySourceMessageCount || 10);
    sourceInput.addEventListener('input', () => {
        const next = getSettings();
        next.continuitySourceMessageCount = Math.max(1, Math.min(200, parseInt(sourceInput.value, 10) || 10));
        saveSettings(next);
        sourceText.textContent = `Recent window: ${next.continuitySourceMessageCount}`;
    });
    sourceRow.appendChild(sourceText);
    sourceRow.appendChild(sourceInput);
    content.appendChild(sourceRow);

    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help wandlight-compact-help';
    help.textContent = 'Adaptive continuity scans use a single compact delta call only for very small windows, parallel grouped calls for routine recent scans, and checkpointed chunks for large backfills.';
    content.appendChild(help);
    return content;
}

function createContinuityScanPerformanceSettingsContent() {
    const content = document.createElement('div');
    content.className = 'wandlight-lore-scan-settings-block';
    appendSettingsResetButton(content, CONTINUITY_SCAN_PERFORMANCE_SETTING_KEYS, 'Continuity performance and recovery settings');
    content.appendChild(createSelectSettingRow(
        'Scan strategy',
        'Adaptive uses one fast delta call only for very small scans, grouped hybrid calls for routine recent ranges, and the checkpointed bulk pipeline for large backfills.',
        'continuityScanStrategy',
        [
            ['adaptive', 'Adaptive'],
            ['fast', 'Always fast'],
            ['hybrid', 'Always hybrid'],
            ['bulk', 'Always bulk/checkpointed'],
        ]
    ));
    content.appendChild(createRangeSettingRow('Fast threshold', 'Adaptive scans at or below this message count use the single-call fast continuity delta path. Keep this low if your provider is slow on large JSON calls.', 'continuityScanFastThreshold', { min: 1, max: 200, fallback: 4 }));
    content.appendChild(createRangeSettingRow('Hybrid threshold', 'Adaptive scans above the fast threshold and at or below this count use grouped hybrid delta calls. Larger scans use the checkpointed bulk path.', 'continuityScanHybridThreshold', { min: 20, max: 500, fallback: 80 }));
    content.appendChild(createRangeSettingRow('Fast max tokens', 'Maximum output tokens for the fast single-call continuity scan.', 'continuityFastMaxTokens', { min: 512, max: 8192, fallback: 2048 }));
    content.appendChild(createRangeSettingRow('Hybrid max tokens', 'Maximum output tokens for each grouped hybrid continuity scan call.', 'continuityHybridMaxTokens', { min: 512, max: 8192, fallback: 3072 }));
    content.appendChild(createRangeSettingRow('Chunk size', 'Messages per continuity observation chunk. Used by the bulk/checkpointed path for large ranges.', 'continuityScanChunkSize', { min: 2, max: 40, fallback: 8 }));
    content.appendChild(createRangeSettingRow('Overlap', 'Messages repeated at chunk boundaries to preserve continuity facts that span intervals.', 'continuityScanOverlap', { min: 0, max: 10, fallback: 1 }));
    content.appendChild(createRangeSettingRow('Simultaneous chunks', 'Maximum continuity observation chunks sent to the Utility provider at the same time.', 'continuityScanConcurrency', { min: 1, max: 8, fallback: 3 }));
    content.appendChild(createRangeSettingRow('Simultaneous reducers', 'Maximum section reducers sent to the Utility provider at the same time after observations are extracted.', 'continuityScanReducerConcurrency', { min: 1, max: 6, fallback: 3 }));
    content.appendChild(createRangeSettingRow('Retry attempts', 'Chunk-level retry attempts after empty, malformed, or failed observation responses.', 'continuityScanRetryAttempts', { min: 0, max: 4, fallback: 2 }));
    content.appendChild(createRangeSettingRow('Observations per chunk', 'Upper target for compact continuity observations extracted from each chunk in the bulk/checkpointed path.', 'continuityScanObservationsPerChunk', { min: 3, max: 30, fallback: 12 }));
    content.appendChild(createRangeSettingRow('Observation max tokens', 'Maximum output tokens for each bulk observation extraction call.', 'continuityObservationMaxTokens', { min: 512, max: 8192, fallback: 1536 }));
    content.appendChild(createRangeSettingRow('Reducer max tokens', 'Maximum output tokens for each bulk section reducer call.', 'continuityReducerMaxTokens', { min: 512, max: 8192, fallback: 1536 }));
    content.appendChild(createRangeSettingRow('Save checkpoint every chunks', 'How often the scan writes a full compact checkpoint after lightweight per-chunk observation saves.', 'continuityScanFullCheckpointEveryChunks', { min: 1, max: 25, fallback: 5 }));

    const rescanRow = createSelectSettingRow(
        'What to rescan',
        'Controls whether Scan Continuity State skips unchanged completed chunks, retries failed chunks, rescans edited chunks, or rescans all chunks.',
        'continuityScanRescanMode',
        [
            ['skip_unchanged', 'Skip unchanged'],
            ['retry_failed', 'Retry failed only'],
            ['stale_only', 'Rescan edited only'],
            ['rescan_all', 'Rescan all'],
        ]
    );
    content.appendChild(rescanRow);

    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help wandlight-compact-help';
    help.textContent = 'Adaptive mode avoids the heavy bulk pipeline for small scans. Chunk checkpoints are still used for large backfills, with prompt injection sync deferred until the final delta is applied or stored for review.';
    content.appendChild(help);
    return content;
}

function createContinuityScanResultsCard(state) {
    const ledger = state?.continuityScan || {};
    const batch = ledger.lastBatchId ? ledger.batches?.[ledger.lastBatchId] : null;
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card wandlight-generation-results-card';

    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = 'Continuity Scan Results';
    addTooltip(title, 'Recoverable results from the latest checkpointed continuity scan.');
    card.appendChild(title);

    if (!batch) {
        card.appendChild(createEmptyMessage('No continuity scan has run yet.'));
        return card;
    }

    card.appendChild(createKeyValue('Status', batch.status || 'unknown', 'Latest scan batch status.'));
    card.appendChild(createKeyValue('Strategy', batch.strategy || 'bulk', 'Continuity scan strategy used for this result.'));
    if (batch.modelCallCount !== undefined) card.appendChild(createKeyValue('Model calls', String(batch.modelCallCount || 0), 'Expected direct model calls used by this strategy, excluding JSON repair retries.'));
    card.appendChild(createKeyValue('Range', `${batch.startIndex || 0}-${batch.endIndex || 0}`, 'Message range used for this scan.'));
    card.appendChild(createKeyValue('Chunks', `${batch.completedChunks || 0} complete / ${batch.failedChunks || 0} failed / ${batch.totalChunks || 0} total`, 'Chunk-level checkpoint status.'));
    card.appendChild(createKeyValue('Observations', String(batch.observationCount || 0), 'Compact observations extracted before reducer passes.'));
    if (Array.isArray(batch.changeKeys) && batch.changeKeys.length) {
        card.appendChild(createKeyValue('Changed sections', batch.changeKeys.join(', '), 'Top-level continuity sections updated by the reduced delta.'));
    }
    if (batch.error) {
        card.appendChild(createKeyValue('Last error', batch.error, 'Latest scan error stored in the checkpoint ledger.'));
    }
    if (batch.completedAt || batch.updatedAt) {
        card.appendChild(createKeyValue('Updated', new Date(batch.completedAt || batch.updatedAt).toLocaleString(), 'Last time this scan batch was updated.'));
    }
    return card;
}

function createContinuityScanCard(state) {
    const settings = getSettings();
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card wandlight-generation-progress-card';
    markTourTarget(card, 'continuity.scan');

    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = 'Continuity Scan';
    addTooltip(title, 'Adaptive continuity scanning: small scans use one fast delta call, medium scans use grouped section calls, and large scans use the checkpointed bulk pipeline.');
    card.appendChild(title);

    const automationCard = createAutomationModeCard(
        'Continuity Tracking',
        'continuityTrackingMode',
        'continuityAutoInterval',
        'Continuity scans only run when you click Scan Continuity State.',
        'Wandlight automatically scans recent continuity state every configured number of turns using the Utility provider.',
        'Automatic continuity scan interval in completed model turns.'
    );
    markTourTarget(automationCard, 'continuity.automation');
    card.appendChild(automationCard);

    const settingsWrap = document.createElement('div');
    settingsWrap.className = 'wandlight-lore-scan-settings-wrap';
    const scopeSection = createCollapsibleSection(
        'continuity.scanScope',
        'Scan Scope',
        getContinuityScanScopeSummary(settings),
        false,
        createContinuityScanScopeSettingsContent,
        { tooltip: 'Choose recent, custom range, or entire-chat scanning for continuity state.' }
    );
    markTourTarget(scopeSection, 'continuity.scanScope');
    settingsWrap.appendChild(scopeSection);
    const performanceSection = createCollapsibleSection(
        'continuity.scanPerformance',
        'Performance and Recovery',
        getContinuityScanPerformanceSummary(settings),
        false,
        createContinuityScanPerformanceSettingsContent,
        { tooltip: 'Chunk size, overlap, parallelism, retry behavior, and checkpoint settings.' }
    );
    markTourTarget(performanceSection, 'continuity.performance');
    settingsWrap.appendChild(performanceSection);
    const hasScanResults = !!state?.continuityScan?.lastBatchId;
    if (hasScanResults) {
        const resultsSection = createCollapsibleSection(
            'continuity.scanResults',
            'Scan Results',
            getContinuityScanResultsSummary(state),
            false,
            () => createContinuityScanResultsCard(getState()),
            { tooltip: 'Latest checkpointed continuity scan result and recovery status.' }
        );
        markTourTarget(resultsSection, 'continuity.results');
        settingsWrap.appendChild(resultsSection);
    }
    card.appendChild(settingsWrap);

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions';
    actions.appendChild(markTourTarget(createButton('Scan Continuity State', 'Scans the selected message range with the adaptive continuity scanner, then applies or stores one ordered continuity state update.', async (btn) => {
        if (!ensureContinuityProviderReadyForAction('Scan Continuity State')) return;
        await runBusyAction(btn, 'Scanning...', async () => {
            setFeatureProgress('continuity', 'Scanning continuity state...', 5);
            const result = await onExtractionTriggered({
                force: true,
                applyImmediately: true,
                progress: (message, pct) => setFeatureProgress('continuity', message, pct),
            });
            refreshHeader();
            refreshPanelBody({ preserveScroll: true });

            if (result?.status === 'applied') {
                const keys = result.changeKeys?.length ? ` Updated: ${result.changeKeys.join(', ')}.` : '';
                const chunks = Number(result.completedChunkCount || 0);
                const failed = Number(result.failedChunkCount || 0);
                setFeatureProgress('continuity', `Continuity scan applied.${keys}`, 100);
                resetFeatureProgress('continuity');
                toast(`Continuity state updated from ${chunks} chunk(s)${failed ? `; ${failed} failed` : ''}.${keys}`);
            } else if (result?.status === 'no_changes' || result?.status === 'skipped_unchanged') {
                setFeatureProgress('continuity', 'Continuity scan complete. No state changes detected.', 100);
                resetFeatureProgress('continuity');
                toast(result?.status === 'skipped_unchanged' ? 'Scan skipped unchanged chunks.' : 'Scan complete. No continuity changes detected.', 'info');
            } else if (result?.status === 'pending_review') {
                setFeatureProgress('continuity', 'Continuity scan stored changes for review.', 100);
                resetFeatureProgress('continuity');
                toast('Continuity changes stored for review.', 'info');
            } else {
                const status = result?.error || result?.status || 'unknown result';
                setFeatureProgress('continuity', `Continuity scan did not update state: ${status}`, 100);
                toast(`Continuity scan did not update state: ${status}`, 'warning');
            }
        });
    }, 'wandlight-primary-button'), 'continuity.scan.button'));
    card.appendChild(actions);

    appendGenerationStatus(card, state, 'continuity');
    return card;
}


function renderContinuityTab(container, state) {
    container.appendChild(createSectionHeader(
        'Continuity State',
        'Edit the lightweight live roleplay state Wandlight tracks for the next scene. Durable memory such as knowledge, secrets, milestones, and relationships belongs in Story Lore.'
    ));

    container.appendChild(createContinuityScanCard(state));

    if (state?.lastDelta) {
        const pendingDelta = document.createElement('div');
        pendingDelta.className = 'wandlight-review-section';
        const title = document.createElement('h4');
        title.textContent = 'Pending Continuity Changes';
        addTooltip(title, 'Older or manually created continuity deltas waiting to be applied. New scans apply directly to the editable sections below.');
        pendingDelta.appendChild(title);
        pendingDelta.appendChild(createDeltaReviewCard(state.lastDelta));
        container.appendChild(pendingDelta);
    }

    const trackedSection = createCollapsibleSection('continuity.trackedSections', 'Tracked Sections', 'Enable/disable live-state scan and injection sections', false, createContinuitySectionToggleCard(state), { tooltip: 'Optional lightweight continuity sections for this chat.' });
    markTourTarget(trackedSection, 'continuity.trackedSections');
    container.appendChild(trackedSection);
    const sceneSection = createCollapsibleSection('continuity.canonScene', 'Scene and Timeline', getContinuityCanonSceneSummary(state), false, createCanonSceneEditorCard(state), { tooltip: 'Current date, scene, cast, and activity fields.' });
    markTourTarget(sceneSection, 'continuity.scene');
    container.appendChild(sceneSection);
    const charactersSection = createCollapsibleSection('continuity.characters', 'Active Characters', getCountLabel(state.characters || [], 'character'), false, createCharacterStateEditorCard(state), { tooltip: 'Current character-specific state: clothing, posture, emotion, immediate goals, and notes.' });
    markTourTarget(charactersSection, 'continuity.characters');
    container.appendChild(charactersSection);
    const inventorySection = createCollapsibleSection('continuity.inventory', 'Key Items', getCountLabel(state.inventory || [], 'item'), false, createJsonEditorCard('Key Items', 'Currently relevant items, owners, locations, and object status. Durable item history belongs in Story Lore.', 'inventory', state.inventory || [], false, 'inventory'), { tooltip: 'Current consequential items only.' });
    markTourTarget(inventorySection, 'continuity.items');
    container.appendChild(inventorySection);
    const threadsSection = createCollapsibleSection('continuity.activeGoalsThreads', 'Active Goals and Threads', getActiveGoalsThreadsSummary(state), false, createActiveGoalsThreadsEditorCard(state), { tooltip: 'Immediate goals and active threads that affect the next scene.' });
    markTourTarget(threadsSection, 'continuity.threads');
    container.appendChild(threadsSection);
}

function createContinuitySectionToggleCard(state) {
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card';
    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = 'Tracked Sections';
    addTooltip(title, 'Disabled top-level sections are not updated by Scan Continuity State and are omitted from continuity injection. Character child fields control nested character details.');
    card.appendChild(title);

    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help';
    help.textContent = 'Top-level sections control the live continuity blocks. Appearance Detail and Emotional State are child fields inside Active Characters.';
    card.appendChild(help);

    const grid = document.createElement('div');
    grid.className = 'wandlight-runtime-grid wandlight-continuity-toggle-grid';
    const cfg = state?.continuityConfig || {};
    for (const [key, label] of Object.entries(CONTINUITY_SECTION_LABELS)) {
        grid.appendChild(createContinuityConfigToggle(key, label, `${label} tracking. Turn off to preserve existing data but omit it from scans and continuity injection.`, cfg[key] !== false));
    }
    card.appendChild(grid);

    const characterFields = document.createElement('div');
    characterFields.className = 'wandlight-continuity-child-fields';
    markTourTarget(characterFields, 'continuity.characterFields');
    const childTitle = document.createElement('div');
    childTitle.className = 'wandlight-runtime-card-title wandlight-runtime-card-subtitle';
    childTitle.textContent = 'Active Character Fields';
    addTooltip(childTitle, 'Nested fields inside Active Characters. These apply only when Active Characters is enabled.');
    characterFields.appendChild(childTitle);

    const childHelp = document.createElement('div');
    childHelp.className = 'wandlight-runtime-help';
    childHelp.textContent = 'Appearance and emotion are stored inside each active character. Disabling one preserves saved values but keeps scans and injection from treating it as live state.';
    characterFields.appendChild(childHelp);

    const childGrid = document.createElement('div');
    childGrid.className = 'wandlight-runtime-grid wandlight-continuity-toggle-grid';
    for (const [key, label] of Object.entries(CHARACTER_CONTINUITY_FIELD_LABELS)) {
        const tooltip = key === 'emotionalState'
            ? 'Emotional State tracking. Turn off to preserve saved emotions but stop scans and continuity injection from treating them as live state.'
            : 'Appearance Detail tracking. Turn off to preserve saved clothing/appearance details but omit them from scans and continuity injection.';
        childGrid.appendChild(createContinuityConfigToggle(key, label, tooltip, cfg[key] !== false));
    }
    characterFields.appendChild(childGrid);
    card.appendChild(characterFields);

    card.appendChild(createEmotionFreshnessControls());

    return card;
}

function createContinuityConfigToggle(key, label, tooltip, checked) {
    return createToggleCard(label, checked, tooltip, (nextChecked) => {
        const current = getState();
        pushStateSnapshot(current, `Toggle continuity section: ${label}`, getSettings().maxSnapshots);
        current.continuityConfig = { ...(current.continuityConfig || {}), [key]: nextChecked };
        saveState(current);
        refreshPanelBody({ preserveScroll: true });
        refreshHeader();
    });
}

function createEmotionFreshnessControls() {
    const settings = getSettings();
    const wrap = document.createElement('div');
    wrap.className = 'wandlight-continuity-emotion-freshness';
    markTourTarget(wrap, 'continuity.emotionalState');

    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title wandlight-runtime-card-subtitle';
    title.textContent = 'Emotional State Freshness';
    addTooltip(title, 'Controls how long emotional state is treated as current in continuity injection.');
    wrap.appendChild(title);

    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help';
    help.textContent = 'Emotion decays by chat-message age so an old feeling does not keep steering the character after the scene moves on.';
    wrap.appendChild(help);
    appendSettingsResetButton(wrap, CONTINUITY_EMOTION_FRESHNESS_SETTING_KEYS, 'Emotional state freshness settings');

    const grid = document.createElement('div');
    grid.className = 'wandlight-runtime-grid wandlight-continuity-toggle-grid';
    grid.appendChild(createToggleCard(
        'Use emotion recency labels',
        settings.continuityEmotionRecencyEnabled !== false,
        'When enabled, injected emotional state is labeled current or recent, and stale emotions can be omitted.',
        (checked) => {
            const next = getSettings();
            next.continuityEmotionRecencyEnabled = checked;
            saveSettings(next);
            refreshPanelBody({ preserveScroll: true });
            refreshHeader();
        }
    ));
    wrap.appendChild(grid);

    wrap.appendChild(createRangeSettingRow('Current emotion window', 'Messages after an emotional update where emotion is injected as current.', 'continuityEmotionCurrentMessageWindow', { min: 0, max: 50, fallback: 8, suffix: ' messages' }));
    wrap.appendChild(createRangeSettingRow('Recent emotion window', 'Messages after an emotional update where emotion is injected only as recent context. Older emotions follow stale handling.', 'continuityEmotionRecentMessageWindow', { min: 0, max: 100, fallback: 20, suffix: ' messages' }));
    wrap.appendChild(createSelectSettingRow(
        'Stale emotion handling',
        'Controls what happens after the recent emotion window expires.',
        'continuityEmotionStaleBehavior',
        [
            ['omit', 'Omit stale emotions'],
            ['keep_as_recent', 'Keep as recent warning'],
            ['keep', 'Keep with stale label'],
        ]
    ));

    return wrap;
}

function createCanonSceneEditorCard(state) {
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card';
    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = 'Scene and Timeline';
    addTooltip(title, 'Lightweight live scene and timeline fields. Durable story-established canon changes belong in Story Lore.');
    card.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'wandlight-runtime-grid wandlight-context-grid';
    grid.appendChild(createContinuityTextField('Era', state?.canon?.era || '', 'canon', 'era', 'Canon era or broad story period.'));
    grid.appendChild(createContinuityTextField('In-universe date', state?.canon?.inUniverseDate || '', 'canon', 'inUniverseDate', 'Current in-universe date if known.'));
    grid.appendChild(createContinuityTextField('Canon boundary', state?.canon?.canonBoundary || '', 'canon', 'canonBoundary', 'Latest canon point treated as established.'));
    grid.appendChild(createContinuityTextField('Location', state?.scene?.location || '', 'scene', 'location', 'Current scene location.'));
    grid.appendChild(createContinuityTextField('Time of day', state?.scene?.timeOfDay || '', 'scene', 'timeOfDay', 'Current scene time of day.'));
    grid.appendChild(createContinuityTextField('Weather', state?.scene?.weather || '', 'scene', 'weather', 'Current weather if relevant.'));
    grid.appendChild(createContinuityTextField('Ambience', state?.scene?.ambience || '', 'scene', 'ambience', 'Scene mood or ambient conditions.'));
    grid.appendChild(createContinuityTextField('Current activity', state?.scene?.currentActivity || '', 'scene', 'currentActivity', 'What is currently happening in the scene.'));
    card.appendChild(grid);

    card.appendChild(createArrayTextField('Present characters', state?.scene?.presentCharacters || [], 'scene', 'presentCharacters', 'Comma-separated characters currently present.'));
    card.appendChild(createArrayTextField('Nearby characters', state?.scene?.nearbyCharacters || [], 'scene', 'nearbyCharacters', 'Comma-separated characters nearby but not necessarily in the active conversation.'));
    card.appendChild(createContinuitySectionPromptEditor('canonScene', 'Scene and Timeline'));
    return card;
}

function getContinuityCanonSceneSummary(state) {
    const parts = [state?.canon?.inUniverseDate, state?.scene?.location, state?.scene?.currentActivity]
        .map(v => String(v || '').trim())
        .filter(Boolean);
    return parts.length ? parts.slice(0, 2).join(' · ') : 'core fields';
}


function getActiveGoalsThreadsSummary(state) {
    const objectives = Array.isArray(state?.objectives) ? state.objectives.filter(o => o?.status !== 'completed' && o?.status !== 'abandoned').length : 0;
    const threads = Array.isArray(state?.threads) ? state.threads.filter(t => t?.status !== 'resolved').length : 0;
    const parts = [];
    if (objectives) parts.push(`${objectives} active goal${objectives === 1 ? '' : 's'}`);
    if (threads) parts.push(`${threads} active thread${threads === 1 ? '' : 's'}`);
    return parts.join(' · ') || 'none active';
}

function createActiveGoalsThreadsEditorCard(state) {
    const wrap = document.createElement('div');
    wrap.className = 'wandlight-runtime-grid';
    wrap.appendChild(createJsonEditorCard(
        'Active Goals',
        'Immediate goals, blockers, stakes, and status. Long-term plot memory belongs in Story Lore.',
        'objectives',
        state?.objectives || [],
        true,
        'objectives'
    ));
    wrap.appendChild(createJsonEditorCard(
        'Active Threads',
        'Immediate unresolved threads that should influence the next scene. Durable relationship history, milestones, secrets, and plot history belong in Story Lore.',
        'threads',
        state?.threads || [],
        true,
        'threads'
    ));
    return wrap;
}

function createCharacterStateEditorCard(state) {
    const card = createJsonEditorCard(
        'Active Characters',
        'Live character state supports name, role, current location, clothing, posture, physicalState, emotionalState, carried key items, immediate goals, and notes. Durable knowledge, secrets, relationships, and milestones belong in Story Lore.',
        'characters',
        state?.characters || [],
        false,
        'characters'
    );
    card.appendChild(createCharacterAppearanceSummary(state));
    card.appendChild(createCharacterEmotionSummary(state));
    const schema = document.createElement('div');
    schema.className = 'wandlight-runtime-help';
    schema.textContent = 'Recommended active character object: { "name": "Harry", "clothing": "school robes", "physicalState": "tired", "emotionalState": { "trust": 2, "fear": 1, "confidence": 0.8, "notes": "uneasy but cooperative" }, "goals": ["find the source of the curse"] }';
    card.appendChild(schema);
    return card;
}

function createCharacterAppearanceSummary(state) {
    const cfg = state?.continuityConfig || {};
    const characters = Array.isArray(state?.characters) ? state.characters : [];
    return createCharacterFieldSummary(
        'Appearance Detail',
        cfg.appearance === false ? 'disabled for scans and injection' : 'active child field',
        characters
            .map(c => {
                return c?.clothing ? `${c.name || 'Unnamed'} - clothing: ${c.clothing}` : '';
            })
            .filter(Boolean),
        'continuity.appearanceDetail',
        'Appearance Detail is stored inside Active Characters. Disabling it preserves saved values but omits clothing/appearance from scans and injection.'
    );
}

function createCharacterEmotionSummary(state) {
    const cfg = state?.continuityConfig || {};
    const settings = getSettings();
    const characters = Array.isArray(state?.characters) ? state.characters : [];
    return createCharacterFieldSummary(
        'Emotional State',
        cfg.emotionalState === false ? 'disabled for scans and injection' : getEmotionFreshnessSummary(settings),
        characters
            .map(c => {
                const emotion = formatEmotionSummaryForPanel(c?.emotionalState || {}, settings);
                return emotion ? `${c.name || 'Unnamed'} - ${emotion}` : '';
            })
            .filter(Boolean),
        'continuity.emotionalStateSummary',
        'Emotional State is stored inside Active Characters. Injection uses freshness windows so old emotions do not keep steering the character.'
    );
}

function createCharacterFieldSummary(titleText, statusText, lines, tourTarget, tooltip) {
    const wrap = document.createElement('div');
    wrap.className = 'wandlight-character-field-summary';
    markTourTarget(wrap, tourTarget);

    const head = document.createElement('div');
    head.className = 'wandlight-character-field-summary-head';
    const title = document.createElement('span');
    title.textContent = titleText;
    addTooltip(title, tooltip);
    head.appendChild(title);
    const status = document.createElement('span');
    status.textContent = statusText;
    head.appendChild(status);
    wrap.appendChild(head);

    if (lines.length) {
        for (const line of lines.slice(0, 8)) {
            const row = document.createElement('div');
            row.className = 'wandlight-character-field-summary-row';
            row.textContent = line;
            wrap.appendChild(row);
        }
        if (lines.length > 8) {
            const more = document.createElement('div');
            more.className = 'wandlight-character-field-summary-row';
            more.textContent = `+${lines.length - 8} more`;
            wrap.appendChild(more);
        }
    } else {
        const empty = document.createElement('div');
        empty.className = 'wandlight-character-field-summary-row wandlight-character-field-empty';
        empty.textContent = 'No saved values yet.';
        wrap.appendChild(empty);
    }

    return wrap;
}

function getPanelChatLength() {
    try {
        const ctx = SillyTavern.getContext();
        return Array.isArray(ctx?.chat) ? ctx.chat.length : 0;
    } catch (_) {
        return 0;
    }
}

function getEmotionFreshnessSummary(settings = getSettings()) {
    if (settings.continuityEmotionRecencyEnabled === false) return 'recency labels off';
    return `current ${settings.continuityEmotionCurrentMessageWindow || 8} / recent ${settings.continuityEmotionRecentMessageWindow || 20} messages`;
}

function formatEmotionSummaryForPanel(raw = {}, settings = getSettings()) {
    const keys = ['affection', 'trust', 'desire', 'connection', 'fear', 'anger', 'sadness', 'joy'];
    const parts = [];
    for (const key of keys) {
        const value = Number(raw?.[key] || 0);
        if (Math.abs(value) >= 2) parts.push(`${key} ${value > 0 ? '+' : ''}${value}`);
    }
    if (raw?.notes) parts.push(String(raw.notes));
    if (!parts.length) return '';

    const current = getPanelChatLength();
    const updatedAt = Number(raw?.lastUpdatedChatLength);
    const age = Number.isFinite(updatedAt) && updatedAt > 0 && current >= updatedAt ? current - updatedAt : 0;
    if (settings.continuityEmotionRecencyEnabled === false) return parts.join(', ');

    const currentWindow = Math.max(0, Number(settings.continuityEmotionCurrentMessageWindow) || 8);
    const recentWindow = Math.max(currentWindow, Number(settings.continuityEmotionRecentMessageWindow) || 20);
    const confidence = Number(raw?.confidence);
    const confidenceText = Number.isFinite(confidence) && confidence < 0.65 ? 'uncertain, ' : '';
    if (age > recentWindow) return `${confidenceText}stale ${age} messages ago; omitted unless stale handling keeps it (${parts.join(', ')})`;
    if (age > currentWindow) return `${confidenceText}recent ${age} messages ago: ${parts.join(', ')}`;
    return `${confidenceText}current: ${parts.join(', ')}`;
}


function createContinuitySectionPromptEditor(sectionKey, label) {
    const settings = getSettings();
    const prompts = settings.continuitySectionPrompts || {};
    const defaults = DEFAULT_SETTINGS.continuitySectionPrompts || {};

    const wrap = document.createElement('div');
    wrap.className = 'wandlight-section-prompt-editor-wrap';

    const textarea = document.createElement('textarea');
    textarea.className = 'wandlight-section-prompt-editor';
    textarea.spellcheck = false;
    textarea.value = String(prompts[sectionKey] || defaults[sectionKey] || '');
    addTooltip(textarea, `User-editable scan prompt for ${label}. This is appended to Scan Continuity State when this section is enabled/tracked.`);

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions wandlight-section-prompt-actions';
    actions.appendChild(createButton('Save Prompt', `Save the Scan Continuity prompt for ${label}.`, () => {
        const next = getSettings();
        next.continuitySectionPrompts = {
            ...(DEFAULT_SETTINGS.continuitySectionPrompts || {}),
            ...(next.continuitySectionPrompts || {}),
            [sectionKey]: textarea.value.trim(),
        };
        saveSettings(next);
        toast(`${label} scan prompt saved.`);
    }, 'wandlight-primary-button'));
    actions.appendChild(createButton('Reset Default', `Restore the default Scan Continuity prompt for ${label}.`, () => {
        textarea.value = String(defaults[sectionKey] || '');
        const next = getSettings();
        next.continuitySectionPrompts = {
            ...(DEFAULT_SETTINGS.continuitySectionPrompts || {}),
            ...(next.continuitySectionPrompts || {}),
            [sectionKey]: textarea.value.trim(),
        };
        saveSettings(next);
        toast(`${label} scan prompt reset.`);
    }));

    wrap.appendChild(textarea);
    wrap.appendChild(actions);

    return createCollapsibleSection(
        `continuity.prompt.${sectionKey}`,
        'Scan Prompt',
        'used when this section is tracked',
        false,
        wrap,
        { tooltip: `Editable prompt guidance appended to continuity scans for ${label}.` }
    );
}

function createContinuityTextField(label, value, section, field, tooltip) {
    return createTextSettingField(label, value, tooltip, (nextValue) => {
        const current = getState();
        pushStateSnapshot(current, `Edit continuity: ${label}`, getSettings().maxSnapshots);
        current[section] = { ...(current[section] || {}), [field]: nextValue };
        saveState(current);
        refreshHeader();
    });
}

function createArrayTextField(label, values, section, field, tooltip) {
    const wrap = document.createElement('label');
    wrap.className = 'wandlight-inline-field wandlight-context-field';
    addTooltip(wrap, tooltip);
    const span = document.createElement('span');
    span.textContent = label;
    wrap.appendChild(span);
    const input = document.createElement('input');
    input.type = 'text';
    input.value = Array.isArray(values) ? values.join(', ') : '';
    input.addEventListener('change', () => {
        const current = getState();
        pushStateSnapshot(current, `Edit continuity: ${label}`, getSettings().maxSnapshots);
        current[section] = { ...(current[section] || {}), [field]: input.value.split(',').map(x => x.trim()).filter(Boolean) };
        saveState(current);
        refreshHeader();
    });
    wrap.appendChild(input);
    return wrap;
}

function createJsonEditorCard(titleText, helpText, path, value, embedded = false, promptSectionKey = '') {
    const card = document.createElement('div');
    card.className = embedded ? 'wandlight-json-editor-embedded' : 'wandlight-runtime-card wandlight-json-editor-card';
    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = titleText;
    addTooltip(title, helpText);
    card.appendChild(title);

    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help';
    help.textContent = helpText;
    card.appendChild(help);

    const textarea = document.createElement('textarea');
    textarea.className = 'wandlight-continuity-json-editor';
    textarea.value = JSON.stringify(value ?? null, null, 2);
    textarea.spellcheck = false;
    addTooltip(textarea, `Editable JSON for ${titleText}. Save validates JSON before writing to state.`);
    card.appendChild(textarea);

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions';
    actions.appendChild(createButton('Save Section', `Save edited ${titleText} JSON into the current chat continuity state.`, () => {
        try {
            const parsed = JSON.parse(textarea.value || 'null');
            const current = getState();
            pushStateSnapshot(current, `Edit continuity section: ${titleText}`, getSettings().maxSnapshots);
            setStatePath(current, path, parsed);
            saveState(current);
            refreshPanelBody({ preserveScroll: true });
            refreshHeader();
            toast(`${titleText} saved.`);
        } catch (e) {
            toast(`Invalid JSON in ${titleText}: ${e.message}`, 'error');
        }
    }, 'wandlight-primary-button'));
    actions.appendChild(createButton('Revert', `Reload ${titleText} from saved state.`, () => {
        refreshPanelBody({ preserveScroll: true });
    }));
    card.appendChild(actions);
    if (promptSectionKey) {
        card.appendChild(createContinuitySectionPromptEditor(promptSectionKey, titleText));
    }
    return card;
}

function setStatePath(state, path, value) {
    const parts = String(path).split('.');
    let target = state;
    for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i];
        if (!target[key] || typeof target[key] !== 'object') target[key] = {};
        target = target[key];
    }
    target[parts[parts.length - 1]] = value;
}

// Injection tab ---------------------------------------------------------------

function renderBasicInjectionTab(container, state, settings = getSettings()) {
    updateCompressionTurnStatus(state, 'lore-high');
    updateCompressionTurnStatus(state, 'lore-normal');
    updateCompressionTurnStatus(state, 'lore-low');

    container.appendChild(createSectionHeader(
        'Injection',
        'Choose which accepted lore tiers Wandlight sends into the next roleplay prompt.'
    ));

    const toggles = document.createElement('div');
    toggles.className = 'wandlight-runtime-grid';
    markTourTarget(toggles, 'injection.basic');
    toggles.appendChild(markTourTarget(createToggleCard(
        'Inject Lore',
        settings.injectLore !== false,
        'Injects accepted, unmuted Lore entries through relevance-tiered prompt groups.',
        (checked) => {
            const next = getSettings();
            next.injectLore = checked;
            saveSettings(next);
            refreshPanelBody({ preserveScroll: false });
            refreshHeader();
        }
    ), 'injection.loreToggle'));
    container.appendChild(toggles);

    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help';
    help.textContent = 'Lore is organized by scene relevance so current details stay close while background details can stay compact.';
    container.appendChild(help);

    for (const tier of ['high', 'normal', 'low']) {
        container.appendChild(createBasicLoreTierInjectionCard(tier, state, settings));
    }
}

function createBasicLoreTierInjectionCard(tier, state, settings) {
    const label = RELEVANCE_META[tier]?.label || tier;
    const preview = buildLorePreview(state, getLoreTierMode(settings, tier), tier);
    const enabled = settings.injectLore !== false && settings[tierSettingKey(tier, 'InjectionEnabled')] !== false;
    const entryCount = getInjectableLoreEntries(state, 0, tier).length;

    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card wandlight-injection-preview-card wandlight-basic-injection-tier-card';
    markTourTarget(card, `injection.tier.${tier}`);

    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = `${label}-Relevance Lore`;
    addTooltip(title, `${label}-Relevance lore injection controls.`);
    card.appendChild(title);

    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help';
    help.textContent = `${entryCount} accepted, unmuted lore entr${entryCount === 1 ? 'y' : 'ies'} available in this tier.`;
    card.appendChild(help);

    const controls = document.createElement('div');
    controls.className = 'wandlight-basic-injection-controls';

    const enabledLabel = document.createElement('label');
    enabledLabel.className = 'wandlight-inline-toggle';
    const enabledInput = document.createElement('input');
    enabledInput.type = 'checkbox';
    enabledInput.checked = settings[tierSettingKey(tier, 'InjectionEnabled')] !== false;
    enabledInput.addEventListener('change', () => {
        const next = getSettings();
        next[tierSettingKey(tier, 'InjectionEnabled')] = enabledInput.checked;
        saveSettings(next);
        refreshPanelBody({ preserveScroll: true, preserveWindowScroll: true });
        refreshHeader();
    });
    enabledLabel.appendChild(enabledInput);
    enabledLabel.appendChild(document.createTextNode(' Use this lore tier'));
    controls.appendChild(enabledLabel);

    const modes = document.createElement('div');
    modes.className = 'wandlight-mode-buttons wandlight-basic-injection-mode-buttons';
    modes.appendChild(createLoreTierModeButton(tier, 'direct', 'Direct', 'Inject this tier as resolved lore text.'));
    modes.appendChild(createLoreTierModeButton(tier, 'compressed', 'Compressed', 'Inject this tier from a cached balanced compression.'));
    controls.appendChild(modes);

    controls.appendChild(createButton(`Compress ${label} Now`, `Compresses ${label}-Relevance lore using the balanced Basic default.`, async (btn) => {
        const next = getSettings();
        next[tierSettingKey(tier, 'CompressionLevel')] = 3;
        saveSettings(next);
        await runModelCompression(`lore-${tier}`, btn);
    }, tier === 'high' ? 'wandlight-primary-button' : ''));

    card.appendChild(controls);

    const status = document.createElement('div');
    status.className = 'wandlight-runtime-help wandlight-basic-injection-status';
    status.textContent = `${getLoreTierMode(settings, tier)} | ${getCompressionStatusTextForSummary(state, `lore-${tier}`)}`;
    card.appendChild(status);

    const pre = document.createElement('pre');
    pre.className = `wandlight-injection-preview wandlight-lore-${tier}-injection-preview`;
    pre.textContent = getInjectionDisplayText(`${label}-Relevance Lore Injection`, preview, enabled);
    addTooltip(pre, 'Scrollable prompt context block for this relevance tier.');
    card.appendChild(pre);

    return card;
}

function renderInjectionTab(container, state) {
    const settings = getSettings();
    if (isBasicExperience(settings)) {
        renderBasicInjectionTab(container, state, settings);
        return;
    }

    const continuityPreview = buildContinuityPreview(state, settings.continuityInjectionMode || 'direct');
    const lorePreview = buildLorePreview(state, settings.loreInjectionMode || 'direct');
    const loreHighPreview = buildLorePreview(state, getLoreTierMode(settings, 'high'), 'high');
    const loreNormalPreview = buildLorePreview(state, getLoreTierMode(settings, 'normal'), 'normal');
    const loreLowPreview = buildLorePreview(state, getLoreTierMode(settings, 'low'), 'low');
    updateCompressionTurnStatus(state, 'lore-high');
    updateCompressionTurnStatus(state, 'lore-normal');
    updateCompressionTurnStatus(state, 'lore-low');
    updateCompressionTurnStatus(state, 'continuity');

    container.appendChild(createSectionHeader(
        'Injection',
        'Final workflow step. Decide whether to inject structured Continuity state, Lore entries, or both, and whether each is direct or model-compressed.'
    ));

    const toggles = document.createElement('div');
    toggles.className = 'wandlight-runtime-grid';
    markTourTarget(toggles, 'injection.toggles');
    toggles.appendChild(createToggleCard(
        'Inject Continuity',
        settings.injectContinuity !== false && settings.injectMemo !== false,
        'Injects the editable lightweight Continuity state: scene/timeline, active characters, key items, and active goals/threads. Durable memory is handled by Lore entries.',
        (checked) => {
            const next = getSettings();
            next.injectContinuity = checked;
            next.injectMemo = checked;
            saveSettings(next);
            refreshPanelBody({ preserveScroll: false });
            refreshHeader();
        }
    ));
    toggles.appendChild(createToggleCard(
        'Inject Lore',
        settings.injectLore !== false,
        'Injects accepted, unmuted Lore entries through relevance-tiered prompt groups. Turn this off if you want Wandlight to track/edit lore without sending lore to the roleplay model.',
        (checked) => {
            const next = getSettings();
            next.injectLore = checked;
            saveSettings(next);
            refreshPanelBody({ preserveScroll: false });
            refreshHeader();
        }
    ));
    container.appendChild(toggles);

    const placementStatus = `${settings.injectionTransport === 'interceptor' ? 'Legacy prepend' : 'Extension Prompt'} · C ${formatPlacementSummary(settings, 'continuity')} · H ${formatPlacementSummary(settings, 'loreHigh')} · N ${formatPlacementSummary(settings, 'loreNormal')} · L ${formatPlacementSummary(settings, 'loreLow')}`;
    const placementSection = createCollapsibleSection('injection.promptPlacement', 'Prompt Placement', placementStatus, false, createInjectionPlacementCard(settings), { tooltip: 'Role, position, and depth used for prompt injection.' });
    markTourTarget(placementSection, 'injection.promptPlacement');
    container.appendChild(placementSection);

    container.appendChild(createInjectionPreviewCard('Continuity Injection', 'wandlight-continuity-injection-preview', continuityPreview, settings.injectContinuity !== false && settings.injectMemo !== false, 'This is the actual Continuity block currently configured for prompt injection. It can be placed at a different depth because it is separated from Lore.', createContinuityHandlingDropdown(state, settings)));
    container.appendChild(createInjectionPreviewCard('High-Relevance Lore Injection', 'wandlight-lore-high-injection-preview', loreHighPreview, settings.injectLore !== false && settings.loreHighInjectionEnabled !== false, 'Lore injected in the high-relevance prompt group.', createLoreTierHandlingDropdown('high', state, settings)));
    container.appendChild(createInjectionPreviewCard('Normal-Relevance Lore Injection', 'wandlight-lore-normal-injection-preview', loreNormalPreview, settings.injectLore !== false && settings.loreNormalInjectionEnabled !== false, 'Lore injected in the normal-relevance prompt group.', createLoreTierHandlingDropdown('normal', state, settings)));
    container.appendChild(createInjectionPreviewCard('Low-Relevance Lore Injection', 'wandlight-lore-low-injection-preview', loreLowPreview, settings.injectLore !== false && settings.loreLowInjectionEnabled !== false, 'Lore injected in the low-relevance prompt group.', createLoreTierHandlingDropdown('low', state, settings)));
    container.appendChild(createInjectionPreviewCard('Combined Lore Preview', 'wandlight-lore-injection-preview', lorePreview, settings.injectLore !== false, 'Combined read-only preview of all relevance-tiered lore blocks.'));

    const compressionSection = createCollapsibleSection(
        'injection.compressionPrompts',
        'Compression Prompts',
        'Editable templates for model compression',
        false,
        createCompressionPromptEditorCard(),
        { tooltip: 'Editable prompt templates used by Compress Continuity Now and tiered Compress Lore actions.' }
    );
    markTourTarget(compressionSection, 'injection.compression');
    container.appendChild(compressionSection);
}


function createContinuityHandlingDropdown(state, settings) {
    return createCollapsibleSection(
        'injection.continuityHandling',
        'Continuity Handling',
        `${settings.continuityInjectionMode || 'direct'} · ${getCompressionStatusTextForSummary(state, 'continuity')}`,
        (settings.continuityInjectionMode || 'direct') === 'compressed',
        createContinuityHandlingCard(state, settings),
        { tooltip: 'Direct or model-compressed handling for Continuity injection.' }
    );
}

function createContinuityHandlingCard(state, settings) {
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card wandlight-compression-handling-card';
    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = 'Continuity Handling Mode';
    addTooltip(title, 'Direct sends structured continuity state. Compressed uses a cached model compression generated from the direct continuity preview.');
    card.appendChild(title);

    const buttons = document.createElement('div');
    buttons.className = 'wandlight-mode-buttons';
    buttons.appendChild(createContinuityModeButton('direct', 'Direct', 'Insert editable continuity state with full section detail.', settings));
    buttons.appendChild(createContinuityModeButton('compressed', 'Compressed', 'Use a saved model-compressed continuity block. If the cache is stale or missing, direct text is used until you click Compress Continuity Now.', settings));
    card.appendChild(buttons);

    card.appendChild(createCompressionLevelControl('continuity', settings));
    card.appendChild(createKeyValue('Target budget', getCompressionBudgetSummary('continuity', state), 'Compression levels set an explicit target token budget for the model request.'));
    card.appendChild(createKeyValue('Continuity status', getContinuityCompressionStatusText(getState()), 'Shows whether cached model-compressed continuity is current, stale, missing, or failed.'));

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions';
    actions.appendChild(createButton('Compress Continuity Now', 'Uses the Utility provider to compress the direct Continuity Injection block and cache it for compressed injection.', async (btn) => {
        await runModelCompression('continuity', btn);
    }, 'wandlight-primary-button'));
    card.appendChild(actions);
    return card;
}

function createLoreTierHandlingDropdown(tier, state, settings) {
    const label = RELEVANCE_META[tier]?.label || tier;
    const entries = getInjectableLoreEntries(getState(), 0, tier).length;
    return createCollapsibleSection(
        `injection.lore${capTier(tier)}Handling`,
        `${label}-Relevance Lore Handling`,
        `${entries} entries · ${getLoreTierMode(settings, tier)} · ${getCompressionStatusTextForSummary(state, `lore-${tier}`)}`,
        false,
        createLoreTierHandlingCard(tier, state, settings),
        { tooltip: `Direct/compressed handling, compression level, and cache status for ${label}-Relevance Lore.` }
    );
}

function createLoreTierHandlingCard(tier, state, settings) {
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card wandlight-compression-handling-card wandlight-lore-tier-injection-card';
    const label = RELEVANCE_META[tier]?.label || tier;
    const counts = getLoreRelevanceCounts(state);
    card.appendChild(createKeyValue('Lore available', `${counts[tier] || 0} ${label} · ${counts.muted || 0} muted total`, 'Accepted lore grouped by relevance. Muted entries are excluded before injection/compression.'));

    const enabledLabel = document.createElement('label');
    enabledLabel.className = 'wandlight-inline-toggle';
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.checked = settings[tierSettingKey(tier, 'InjectionEnabled')] !== false;
    enabled.addEventListener('change', () => {
        const next = getSettings();
        next[tierSettingKey(tier, 'InjectionEnabled')] = enabled.checked;
        saveSettings(next);
        refreshPanelBody({ preserveScroll: true, preserveWindowScroll: true });
    });
    enabledLabel.appendChild(enabled);
    enabledLabel.appendChild(document.createTextNode(' Enable this lore injection'));
    card.appendChild(enabledLabel);

    const buttons = document.createElement('div');
    buttons.className = 'wandlight-mode-buttons';
    buttons.appendChild(createLoreTierModeButton(tier, 'direct', 'Direct', 'Inject this tier as resolved lore text.'));
    buttons.appendChild(createLoreTierModeButton(tier, 'compressed', 'Compressed', 'Inject this tier from its own cached model compression.'));
    card.appendChild(buttons);

    card.appendChild(createKeyValue('Entries', String(getInjectableLoreEntries(getState(), 0, tier).length), 'Accepted, unmuted entries in this relevance tier.'));
    card.appendChild(createCompressionLevelControl(`lore-${tier}`, settings));
    card.appendChild(createKeyValue('Target budget', getCompressionBudgetSummary(`lore-${tier}`, state), 'Compression budget for this relevance tier.'));
    card.appendChild(createKeyValue('Compression status', getCompressionStatusTextForKind(getState(), `lore-${tier}`), 'Tier-specific compression cache status.'));

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions';
    actions.appendChild(createButton(`Compress ${label} Now`, `Compresses only ${tier} relevance lore.`, async (btn) => {
        await runModelCompression(`lore-${tier}`, btn);
    }, tier === 'high' ? 'wandlight-primary-button' : ''));
    card.appendChild(actions);
    return card;
}

function createLoreTierModeButton(tier, mode, label, tooltip) {
    const settings = getSettings();
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wandlight-mode-button';
    if (getLoreTierMode(settings, tier) === mode) btn.classList.add('wandlight-mode-button-active');
    btn.textContent = label;
    addTooltip(btn, tooltip);
    btn.addEventListener('click', () => {
        const next = getSettings();
        next[tierSettingKey(tier, 'InjectionMode')] = mode;
        saveSettings(next);
        refreshPanelBody({ preserveScroll: true, preserveWindowScroll: true });
        refreshHeader();
        toast(`${RELEVANCE_META[tier]?.label || tier} relevance lore set to ${label}.`);
    });
    return btn;
}


function createCompressionLevelControl(kind, settings) {
    const parsed = parseLoreCompressionKind(kind);
    const levelKey = parsed.base === 'continuity' ? 'continuityCompressionLevel' : parsed.tier ? tierSettingKey(parsed.tier, 'CompressionLevel') : 'loreCompressionLevel';
    const fallback = 3;
    const levelValue = Math.max(1, Math.min(5, Number(settings[levelKey]) || fallback));
    const label = document.createElement('label');
    label.className = 'wandlight-slider-row';
    const text = document.createElement('span');
    text.textContent = `Compression level: ${levelValue} (${getCompressionProfile(levelValue).label})`;
    addTooltip(text, 'Compression level changes both the wording and the target token budget for the model compression request.');
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '1';
    range.max = '5';
    range.value = String(levelValue);
    range.addEventListener('input', () => {
        const next = getSettings();
        next[levelKey] = Number(range.value) || 3;
        saveSettings(next);
        text.textContent = `Compression level: ${next[levelKey]} (${getCompressionProfile(next[levelKey]).label})`;
        refreshInjectionPreviewOnly();
    });
    label.appendChild(text);
    label.appendChild(range);
    return label;
}

function createCompressionPromptEditorCard() {
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card wandlight-compression-prompt-card';
    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = 'Compression Prompts';
    card.appendChild(title);

    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help';
    help.textContent = 'Variables: {{kind}}, {{compressionLevel}}, {{compressionLabel}}, {{directTokens}}, {{targetTokens}}, {{hardTokenLimit}}, {{directCharacters}}, {{targetCharacters}}, {{hardCharacterLimit}}, {{storyContext}}, {{directText}}.';
    card.appendChild(help);

    card.appendChild(createCompressionPromptTextarea('Continuity Compression Prompt', 'continuityCompressionPromptTemplate', DEFAULT_SETTINGS.continuityCompressionPromptTemplate));
    card.appendChild(createCompressionPromptTextarea('Lore Compression Prompt', 'loreCompressionPromptTemplate', DEFAULT_SETTINGS.loreCompressionPromptTemplate));
    return card;
}

function createCompressionPromptTextarea(labelText, settingKey, defaultValue) {
    const wrap = document.createElement('div');
    wrap.className = 'wandlight-compression-template-wrap';
    const label = document.createElement('div');
    label.className = 'wandlight-runtime-card-title wandlight-compression-template-title';
    label.textContent = labelText;
    addTooltip(label, `Editable template used for ${labelText}.`);
    wrap.appendChild(label);

    const textarea = document.createElement('textarea');
    textarea.className = 'wandlight-compression-template-editor';
    textarea.spellcheck = false;
    textarea.value = String(getSettings()[settingKey] || defaultValue || '');
    wrap.appendChild(textarea);

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions';
    actions.appendChild(createButton('Save Template', `Save ${labelText}.`, () => {
        const next = getSettings();
        next[settingKey] = textarea.value;
        saveSettings(next);
        toast(`${labelText} saved.`);
    }, 'wandlight-primary-button'));
    actions.appendChild(createButton('Reset Default', `Restore Wandlight's default ${labelText}.`, () => {
        const next = getSettings();
        next[settingKey] = defaultValue;
        saveSettings(next);
        textarea.value = defaultValue;
        toast(`${labelText} reset to default.`, 'info');
    }));
    actions.appendChild(createButton('Copy Prompt', `Copy ${labelText} to clipboard.`, async () => {
        try {
            await navigator.clipboard?.writeText(textarea.value);
            toast(`${labelText} copied.`, 'info');
        } catch (_) {
            toast('Clipboard copy unavailable in this browser context.', 'warning');
        }
    }));
    wrap.appendChild(actions);
    return wrap;
}



function formatPlacementSummary(settings, kind) {
    const prefix = kind === 'continuity' ? 'continuity' : kind === 'loreHigh' ? 'loreHigh' : kind === 'loreNormal' ? 'loreNormal' : kind === 'loreLow' ? 'loreLow' : 'lore';
    const position = Number(settings[`${prefix}InjectionPosition`] ?? 1);
    const role = Number(settings[`${prefix}InjectionRole`] ?? 0);
    const depth = Number(settings[`${prefix}InjectionDepth`] ?? 4);
    const positionLabel = position === 1 ? 'in-chat' : (position === 2 ? 'before' : 'after');
    const roleLabel = role === 1 ? 'user' : (role === 2 ? 'assistant' : 'system');
    return `${positionLabel}@${depth}/${roleLabel}`;
}

function getCompressionProfile(level) {
    const profiles = {
        1: { label: 'Light', ratio: 0.8, description: 'preserve most details; remove redundancy only' },
        2: { label: 'Moderate', ratio: 0.6, description: 'concise but still descriptive' },
        3: { label: 'Balanced', ratio: 0.4, description: 'keep roleplay-relevant facts and current-scene implications' },
        4: { label: 'Heavy', ratio: 0.25, description: 'short bullets; preserve critical secrets, constraints, and protected details' },
        5: { label: 'Minimal', ratio: 0.15, description: 'minimum viable context; only essential facts, constraints, secrets, and hazards' },
    };
    return profiles[Math.max(1, Math.min(5, Number(level) || 2))] || profiles[2];
}

function estimateTokenBudgetForCompression(text, level) {
    const source = String(text || '');
    const directTokens = estimateTokens(source);
    const directCharacters = source.length;
    const profile = getCompressionProfile(level);
    const targetTokens = Math.max(96, Math.ceil(directTokens * profile.ratio));
    const hardTokenLimit = Math.max(128, Math.ceil(targetTokens * 1.2));
    const targetCharacters = Math.max(420, Math.ceil(directCharacters * profile.ratio));
    const hardCharacterLimit = Math.max(560, Math.ceil(targetCharacters * 1.18));
    return {
        directTokens,
        directCharacters,
        targetTokens,
        targetCharacters,
        hardTokenLimit,
        hardCharacterLimit,
        profile,
    };
}

function getCompressionBudgetSummary(kind, state) {
    const settings = getSettings();
    const parsed = parseLoreCompressionKind(kind);
    const level = parsed.base === 'continuity'
        ? Math.max(1, Math.min(5, Number(settings.continuityCompressionLevel) || 3))
        : parsed.tier ? getLoreTierLevel(settings, parsed.tier) : Math.max(1, Math.min(5, Number(settings.loreCompressionLevel) || 3));
    const directText = parsed.base === 'continuity'
        ? buildContinuityPreview(state, 'direct')
        : parsed.tier ? buildLorePreview(state, 'direct', parsed.tier) : buildLorePreview(state, 'direct');
    if (!directText || !directText.trim()) return 'No source text';
    const budget = estimateTokenBudgetForCompression(directText, level);
    return `~${budget.targetTokens} tokens / ${budget.targetCharacters} chars target; max ${budget.hardTokenLimit} tokens / ${budget.hardCharacterLimit} chars from ~${budget.directTokens} tokens / ${budget.directCharacters} chars`;
}

function getCompressionStatusTextForSummary(state, kind) {
    const parsed = parseLoreCompressionKind(kind);
    const status = parsed.base === 'continuity' ? getContinuityCompressionStatusText(state) : getCompressionStatusTextForKind(state, kind);
    if (/Direct mode active/i.test(status)) return 'direct';
    if (/current/i.test(status) || /model-compressed/i.test(status)) return 'current cache';
    if (/stale/i.test(status)) return 'stale cache';
    if (/missing|No cached/i.test(status)) return 'no cache';
    return status.slice(0, 40);
}


function createInjectionPlacementCard(settings) {
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card wandlight-prompt-placement-card';
    markTourTarget(card, 'injection.placement.card');

    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = 'Prompt Placement';
    addTooltip(title, 'Controls how Wandlight injects Continuity and Lore into SillyTavern prompts. Extension Prompt mode uses SillyTavern role/depth injection; Legacy mode prepends a combined block to the last user message.');
    card.appendChild(title);

    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help';
    help.textContent = 'Recommended: Extension Prompt, System role, with Continuity depth 3, High-Relevance Lore depth 2, Normal depth 5, and Low depth 9. Depth 0 is closest to the latest message.';
    card.appendChild(help);
    appendSettingsResetButton(card, PROMPT_PLACEMENT_SETTING_KEYS, 'Prompt placement settings');

    const placement = document.createElement('div');
    placement.className = 'wandlight-prompt-placement-lines';

    const methodRow = document.createElement('div');
    methodRow.className = 'wandlight-prompt-placement-line wandlight-prompt-placement-method-line';
    markTourTarget(methodRow, 'injection.placement.method');
    methodRow.appendChild(createPlacementSelect('Injection method', 'injectionTransport', settings.injectionTransport || 'extension_prompt', [
        ['extension_prompt', 'Extension Prompt'],
        ['interceptor', 'Legacy prepend'],
    ], 'Extension Prompt uses SillyTavern setExtensionPrompt and supports role/depth. Legacy mode has no true depth and appears as part of the last user message.', 'wandlight-placement-method'));
    placement.appendChild(methodRow);

    placement.appendChild(createPromptPlacementLine('Continuity', [
        createPlacementSelect('Position', 'continuityInjectionPosition', String(settings.continuityInjectionPosition ?? 1), [
            ['1', 'In-chat'],
            ['0', 'After prompt'],
            ['2', 'Before prompt'],
        ], 'Where the Continuity Injection block is inserted. Depth only applies to In-chat.', 'wandlight-placement-position'),
        createPlacementNumber('Depth', 'continuityInjectionDepth', settings.continuityInjectionDepth ?? 3, 0, 1000, 'Depth 0 is closest to the latest message. Higher depth moves the block earlier in chat history.', 'wandlight-placement-depth'),
        createPlacementSelect('Role', 'continuityInjectionRole', String(settings.continuityInjectionRole ?? 0), [
            ['0', 'System'],
            ['1', 'User'],
            ['2', 'Assistant'],
        ], 'Role used for the injected Continuity block when using In-chat extension prompt placement.', 'wandlight-placement-role'),
    ]));

    for (const [tier, label, depth] of [['high', 'High-Relevance Lore', 2], ['normal', 'Normal-Relevance Lore', 5], ['low', 'Low-Relevance Lore', 9]]) {
        placement.appendChild(createPromptPlacementLine(label, [
            createPlacementSelect('Position', tierSettingKey(tier, 'InjectionPosition'), String(settings[tierSettingKey(tier, 'InjectionPosition')] ?? 1), [
                ['1', 'In-chat'],
                ['0', 'After prompt'],
                ['2', 'Before prompt'],
            ], `Where the ${label} block is inserted. Depth only applies to In-chat.`, 'wandlight-placement-position'),
            createPlacementNumber('Depth', tierSettingKey(tier, 'InjectionDepth'), settings[tierSettingKey(tier, 'InjectionDepth')] ?? depth, 0, 1000, 'Depth 0 is closest to the latest message. Higher depth moves the block earlier in chat history.', 'wandlight-placement-depth'),
            createPlacementSelect('Role', tierSettingKey(tier, 'InjectionRole'), String(settings[tierSettingKey(tier, 'InjectionRole')] ?? 0), [
                ['0', 'System'],
                ['1', 'User'],
                ['2', 'Assistant'],
            ], `Role used for ${label}.`, 'wandlight-placement-role'),
        ]));
    }

    card.appendChild(placement);

    const status = typeof globalThis.wandlightGetInjectionStatus === 'function'
        ? globalThis.wandlightGetInjectionStatus()
        : null;
    const statusText = status
        ? `${status.transport || 'unknown'} | continuity ${status.continuityChars || 0} chars | high ${status.loreHighChars || 0} chars | normal ${status.loreNormalChars || 0} chars | low ${status.loreLowChars || 0} chars`
        : 'Prompt sync status unavailable until extension initialization completes.';
    card.appendChild(createKeyValue('Current sync', statusText, 'Shows the last Wandlight prompt sync result.'));

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions';
    actions.appendChild(createButton('Sync Injection Now', 'Immediately updates SillyTavern extension prompts from the current Continuity and Lore previews.', () => {
        if (typeof globalThis.wandlightSyncPromptInjection === 'function') {
            const info = globalThis.wandlightSyncPromptInjection();
            toast(`Synced injection: ${info.transport}, continuity ${info.continuityChars || 0} chars, lore ${info.loreChars || 0} chars.`, 'info');
        } else {
            toast('Wandlight prompt sync function is not available.', 'error');
        }
    }));
    card.appendChild(actions);

    return card;
}

function createPromptPlacementLine(labelText, controls) {
    const row = document.createElement('div');
    row.className = 'wandlight-prompt-placement-line';

    const label = document.createElement('div');
    label.className = 'wandlight-prompt-placement-line-label';
    label.textContent = labelText;
    addTooltip(label, `${labelText} prompt placement settings.`);
    row.appendChild(label);

    const controlWrap = document.createElement('div');
    controlWrap.className = 'wandlight-prompt-placement-control-wrap';
    for (const control of controls) {
        controlWrap.appendChild(control);
    }
    row.appendChild(controlWrap);

    return row;
}

function createPlacementSelect(labelText, settingKey, value, options, tooltip, extraClass = '') {
    const label = document.createElement('label');
    label.className = `wandlight-inline-field ${extraClass}`.trim();
    const span = document.createElement('span');
    span.textContent = labelText;
    addTooltip(span, tooltip);
    const select = document.createElement('select');
    select.value = String(value);
    for (const [optionValue, optionLabel] of options) {
        const option = document.createElement('option');
        option.value = optionValue;
        option.textContent = optionLabel;
        select.appendChild(option);
    }
    select.value = String(value);
    select.addEventListener('change', () => {
        const next = getSettings();
        if (settingKey.endsWith('Position') || settingKey.endsWith('Role')) {
            next[settingKey] = Number(select.value);
        } else {
            next[settingKey] = select.value;
        }
        saveSettings(next);
        refreshPanelBody({ preserveScroll: false });
    });
    label.appendChild(span);
    label.appendChild(select);
    return label;
}

function createPlacementNumber(labelText, settingKey, value, min, max, tooltip, extraClass = '') {
    const label = document.createElement('label');
    label.className = `wandlight-inline-field ${extraClass}`.trim();
    const span = document.createElement('span');
    span.textContent = labelText;
    addTooltip(span, tooltip);
    const input = document.createElement('input');
    input.type = 'number';
    input.min = String(min);
    input.max = String(max);
    input.value = String(value);
    input.addEventListener('change', () => {
        const next = getSettings();
        next[settingKey] = Math.max(min, Math.min(max, parseInt(input.value, 10) || Number(value) || 0));
        saveSettings(next);
        refreshPanelBody({ preserveScroll: false });
    });
    label.appendChild(span);
    label.appendChild(input);
    return label;
}

function createInjectionPreviewCard(titleText, className, text, enabled, helpText, extraContent = null) {
    const previewCard = document.createElement('div');
    previewCard.className = 'wandlight-runtime-card wandlight-injection-preview-card';
    if (String(className || '').includes('continuity')) markTourTarget(previewCard, 'injection.preview.continuity');
    else if (String(className || '').includes('lore-high')) markTourTarget(previewCard, 'injection.preview.high');
    else if (String(className || '').includes('lore-normal')) markTourTarget(previewCard, 'injection.preview.normal');
    else if (String(className || '').includes('lore-low')) markTourTarget(previewCard, 'injection.preview.low');
    else if (String(className || '').includes('lore-injection-preview')) markTourTarget(previewCard, 'injection.preview.combined');
    const previewTitle = document.createElement('div');
    previewTitle.className = 'wandlight-runtime-card-title';
    previewTitle.textContent = titleText;
    addTooltip(previewTitle, helpText);
    previewCard.appendChild(previewTitle);

    const previewHelp = document.createElement('div');
    previewHelp.className = 'wandlight-runtime-help';
    previewHelp.textContent = enabled
        ? helpText
        : `${titleText} is currently disabled. This panel shows what would be injected if enabled.`;
    previewCard.appendChild(previewHelp);

    const pre = document.createElement('pre');
    pre.className = `wandlight-injection-preview ${className}`;
    pre.textContent = getInjectionDisplayText(titleText, text, enabled);
    addTooltip(pre, 'Scrollable prompt context block. This text is ephemeral and is not written into chat history.');
    previewCard.appendChild(pre);

    if (extraContent) previewCard.appendChild(extraContent);

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions';
    actions.appendChild(createButton('Refresh Injection Text', 'Rebuilds both split injection blocks from current state and settings.', () => {
        refreshInjectionPreviewOnly();
        toast('Injection text refreshed.', 'info');
    }));
    previewCard.appendChild(actions);
    return previewCard;
}

function getInjectionDisplayText(titleText, text, enabled = true) {
    const clean = String(text || '').trim();
    if (clean) return clean;
    const lower = String(titleText || '').toLowerCase();
    if (lower.includes('lore')) return enabled ? '(No lore data to inject.)' : '(Lore injection is disabled.)';
    if (lower.includes('continuity')) return enabled ? '(No continuity data to inject.)' : '(Continuity injection is disabled.)';
    return '(No data to inject.)';
}

function refreshInjectionPreviewOnly() {
    const state = getState();
    const settings = getSettings();
    const continuity = buildContinuityPreview(state, settings.continuityInjectionMode || 'direct');
    const lore = buildLorePreview(state, settings.loreInjectionMode || 'direct');
    const loreHigh = buildLorePreview(state, getLoreTierMode(settings, 'high'), 'high');
    const loreNormal = buildLorePreview(state, getLoreTierMode(settings, 'normal'), 'normal');
    const loreLow = buildLorePreview(state, getLoreTierMode(settings, 'low'), 'low');
    updateCompressionTurnStatus(state, 'continuity');
    updateCompressionTurnStatus(state, 'lore-high');
    updateCompressionTurnStatus(state, 'lore-normal');
    updateCompressionTurnStatus(state, 'lore-low');

    const continuityPre = panelRoot?.querySelector('.wandlight-continuity-injection-preview');
    if (continuityPre) {
        continuityPre.textContent = getInjectionDisplayText('Continuity Injection', continuity, settings.injectContinuity !== false && settings.injectMemo !== false);
    }

    const loreHighPre = panelRoot?.querySelector('.wandlight-lore-high-injection-preview');
    if (loreHighPre) loreHighPre.textContent = getInjectionDisplayText('High-Relevance Lore Injection', loreHigh, settings.injectLore !== false && settings.loreHighInjectionEnabled !== false);
    const loreNormalPre = panelRoot?.querySelector('.wandlight-lore-normal-injection-preview');
    if (loreNormalPre) loreNormalPre.textContent = getInjectionDisplayText('Normal-Relevance Lore Injection', loreNormal, settings.injectLore !== false && settings.loreNormalInjectionEnabled !== false);
    const loreLowPre = panelRoot?.querySelector('.wandlight-lore-low-injection-preview');
    if (loreLowPre) loreLowPre.textContent = getInjectionDisplayText('Low-Relevance Lore Injection', loreLow, settings.injectLore !== false && settings.loreLowInjectionEnabled !== false);

    const lorePre = panelRoot?.querySelector('.wandlight-lore-injection-preview');
    if (lorePre) {
        lorePre.textContent = getInjectionDisplayText('Lore Injection', lore, settings.injectLore !== false);
    }

    if (typeof globalThis.wandlightSyncPromptInjection === 'function') {
        globalThis.wandlightSyncPromptInjection();
    }
}

function updateCompressionTurnStatus(state, kind = 'lore') {
    if (!state) return;
    const parsed = parseLoreCompressionKind(kind);
    let status = null;
    if (parsed.base === 'continuity') status = state.continuityCompressionStatus;
    else if (parsed.tier) status = state.loreCompressionStatusByRelevance?.[parsed.tier];
    else status = state.loreCompressionStatus;
    if (!status?.lastCompressedAt) return;
    const chatLength = getChatLength();
    status.turnsSinceCompression = Math.max(0, chatLength - Number(status.lastChatLength || chatLength));
    saveState(state);
}

async function runModelCompression(kind = 'lore', btn = null) {
    const settings = getSettings();
    // Compression is a frequent transformation task, so it is routed through the
    // Utility provider. Internal key remains `continuity` for backward-compatible
    // settings storage; the UI presents this provider role as Utility.
    const providerKind = 'continuity';
    const validation = validateLoreProviderConfiguration(providerKind);
    if (!validation.ok) {
        toast(`${kind === 'continuity' ? 'Continuity' : 'Lore'} compression blocked: Utility provider unavailable: ${validation.message}`, 'error');
        return null;
    }

    const originalText = btn?.textContent || '';
    if (btn) {
        btn.disabled = true;
        const parsedKindForLabel = parseLoreCompressionKind(kind);
        btn.textContent = parsedKindForLabel.base === 'continuity' ? 'Compressing continuity...' : `Compressing ${parsedKindForLabel.tier || ''} lore...`;
    }

    try {
        const state = getState();
        const parsedKind = parseLoreCompressionKind(kind);
        const directText = parsedKind.base === 'continuity'
            ? buildContinuityPreview(state, 'direct')
            : parsedKind.tier
                ? buildLorePreview(state, 'direct', parsedKind.tier)
                : buildLorePreview(state, 'direct');

        if (!directText || !directText.trim()) {
            toast(`${parsedKind.base === 'continuity' ? 'Continuity' : 'Lore'} preview is empty; nothing to compress.`, 'warning');
            return null;
        }

        const level = parsedKind.base === 'continuity'
            ? Math.max(1, Math.min(5, Number(settings.continuityCompressionLevel) || 3))
            : parsedKind.tier
                ? getLoreTierLevel(settings, parsedKind.tier)
                : Math.max(1, Math.min(5, Number(settings.loreCompressionLevel) || 3));

        const context = JSON.stringify({
            sceneDate: state?.loreContext?.sceneDate || state?.canon?.inUniverseDate || '',
            canonBoundary: state?.loreContext?.canonBoundary || state?.canon?.canonBoundary || '',
            branchId: state?.loreContext?.branchId || 'main',
            scene: state?.scene || {},
        }, null, 2);

        const budget = estimateTokenBudgetForCompression(directText, level);
        const compressionPrompt = buildCompressionPrompt(kind, level, context, directText, budget);
        const compressed = await sendLoreRequest(
            'You are Wandlight Compression. Compress the source into a shorter visible plain-text injection block. Output only that block. Do not use markdown fences, JSON, reasoning, or commentary.',
            compressionPrompt,
            {
                providerKind,
                maxTokens: Math.max(512, Math.min(8192, Math.ceil(budget.hardTokenLimit * 3))),
                prefill: '',
                expectedOutput: 'text',
                task: 'compression',
            }
        );

        let cleaned = cleanCompressedText(compressed);
        let validationResult = validateCompressedText(cleaned, directText, budget, level);
        if (!validationResult.ok && shouldRetryCompression(validationResult, directText, level)) {
            const retryPrompt = buildCompressionRetryPrompt(kind, level, context, directText, cleaned, budget, validationResult.message);
            const retry = await sendLoreRequest(
                'You are Wandlight Compression. Your previous visible output was too long or insufficiently compressed. Output only the corrected shorter plain-text injection block. No markdown, JSON, reasoning, or commentary.',
                retryPrompt,
                {
                    providerKind,
                    maxTokens: Math.max(512, Math.min(8192, Math.ceil(budget.hardTokenLimit * 3))),
                    prefill: '',
                    expectedOutput: 'text',
                    task: 'compression',
                }
            );
            cleaned = cleanCompressedText(retry);
            validationResult = validateCompressedText(cleaned, directText, budget, level);
        }

        if (!validationResult.ok) {
            throw new Error(validationResult.message);
        }

        const freshState = getState();
        let statusKey = parsedKind.base === 'continuity' ? 'continuityCompressionStatus' : 'loreCompressionStatus';
        let statusTarget = null;
        if (parsedKind.base === 'continuity') {
            if (!freshState.continuityCompressionStatus) freshState.continuityCompressionStatus = {};
            statusTarget = freshState.continuityCompressionStatus;
        } else if (parsedKind.tier) {
            if (!freshState.loreCompressionStatusByRelevance) freshState.loreCompressionStatusByRelevance = {};
            if (!freshState.loreCompressionStatusByRelevance[parsedKind.tier]) freshState.loreCompressionStatusByRelevance[parsedKind.tier] = {};
            statusTarget = freshState.loreCompressionStatusByRelevance[parsedKind.tier];
            statusKey = `loreCompressionStatusByRelevance.${parsedKind.tier}`;
        } else {
            if (!freshState.loreCompressionStatus) freshState.loreCompressionStatus = {};
            statusTarget = freshState.loreCompressionStatus;
        }
        const compressedTokens = estimateTokens(cleaned);
        const nextStatus = {
            ...statusTarget,
            lastCompressedAt: Date.now(),
            lastSignature: getCompressionSourceSignature(freshState, kind, directText, settings),
            lastMode: 'compressed',
            lastTokenEstimate: compressedTokens,
            lastCharacterCount: cleaned.length,
            lastDirectTokenEstimate: budget.directTokens,
            lastDirectCharacterCount: budget.directCharacters,
            lastTargetTokenEstimate: budget.targetTokens,
            lastTargetCharacterCount: budget.targetCharacters,
            lastHardTokenLimit: budget.hardTokenLimit,
            lastHardCharacterLimit: budget.hardCharacterLimit,
            lastCompressionRatio: budget.directCharacters ? Number((cleaned.length / budget.directCharacters).toFixed(3)) : 0,
            turnsSinceCompression: 0,
            lastChatLength: getChatLength(),
            cachedText: cleaned,
            lastError: '',
        };
        if (parsedKind.base === 'continuity') freshState.continuityCompressionStatus = nextStatus;
        else if (parsedKind.tier) freshState.loreCompressionStatusByRelevance[parsedKind.tier] = nextStatus;
        else freshState.loreCompressionStatus = nextStatus;
        saveState(freshState);
        refreshPanelBody({ preserveScroll: true, preserveWindowScroll: true });
        toast(`${parsedKind.base === 'continuity' ? 'Continuity' : parsedKind.tier ? `${RELEVANCE_META[parsedKind.tier]?.label || parsedKind.tier} lore` : 'Lore'} compression updated: ${compressedTokens} tokens / ${cleaned.length} chars from ${budget.directTokens} tokens / ${budget.directCharacters} chars.`);
        return cleaned;
    } catch (e) {
        const freshState = getState();
        const parsedKind = parseLoreCompressionKind(kind);
        let status = parsedKind.base === 'continuity' ? freshState.continuityCompressionStatus : parsedKind.tier ? freshState.loreCompressionStatusByRelevance?.[parsedKind.tier] : freshState.loreCompressionStatus;
        if (status) {
            status.lastError = e?.message || String(e);
            saveState(freshState);
        }
        toast(`${kind === 'continuity' ? 'Continuity' : 'Lore'} compression failed: ${e?.message || e}`, 'error');
        refreshPanelBody({ preserveScroll: true, preserveWindowScroll: true });
        return null;
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = originalText;
        }
    }
}


function validateCompressedText(cleaned, directText, budget, level) {
    const text = String(cleaned || '').trim();
    if (!text) return { ok: false, message: 'Compression returned empty visible text.' };
    const source = String(directText || '');
    const sourceChars = source.length;
    const outputChars = text.length;
    const outputTokens = estimateTokens(text);
    if (sourceChars >= 900 && outputChars > budget.hardCharacterLimit) {
        return { ok: false, message: `Compressed output is too long: ${outputChars} chars; hard limit is ${budget.hardCharacterLimit} chars.` };
    }
    if (budget.directTokens >= 220 && outputTokens > Math.ceil(budget.hardTokenLimit * 1.1)) {
        return { ok: false, message: `Compressed output is too long: ~${outputTokens} tokens; hard limit is ~${budget.hardTokenLimit} tokens.` };
    }
    if (level >= 3 && sourceChars >= 1200 && outputChars > Math.ceil(sourceChars * 0.72)) {
        return { ok: false, message: `Compression level ${level} did not significantly reduce the source: ${outputChars} chars from ${sourceChars} chars.` };
    }
    if (level >= 4 && sourceChars >= 1200 && outputChars > Math.ceil(sourceChars * 0.55)) {
        return { ok: false, message: `Compression level ${level} did not meet heavy-reduction expectations: ${outputChars} chars from ${sourceChars} chars.` };
    }
    return { ok: true, message: '' };
}

function shouldRetryCompression(result, directText, level) {
    if (result?.ok) return false;
    const sourceChars = String(directText || '').length;
    return sourceChars >= 600 || level >= 3;
}

function buildCompressionRetryPrompt(kind, level, context, directText, previousOutput, budget, reason) {
    const parsedKind = parseLoreCompressionKind(kind);
    const kindLabel = parsedKind.base === 'continuity' ? 'Continuity State' : parsedKind.tier ? `${RELEVANCE_META[parsedKind.tier]?.label || parsedKind.tier} Relevance Lore Entries` : 'Lore Entries';
    return `Compress the Wandlight ${kindLabel} injection again. The previous output failed validation: ${reason}

Required visible-output limits:
- Source: about ${budget.directTokens} tokens / ${budget.directCharacters} characters.
- Target: <= ${budget.targetTokens} tokens / <= ${budget.targetCharacters} characters.
- Hard maximum: <= ${budget.hardTokenLimit} tokens / <= ${budget.hardCharacterLimit} characters.
- Compression level ${level}: ${budget.profile.description}.

Story context:
${context}

Previous too-long output:
${previousOutput || '(empty)'}

Direct injection block to compress:
${directText}

Output only the corrected compressed injection text. No markdown fences, JSON, reasoning, or commentary.`;
}

function buildCompressionPrompt(kind, level, context, directText, budget = null) {
    const settings = getSettings();
    const parsedKind = parseLoreCompressionKind(kind);
    const kindLabel = parsedKind.base === 'continuity' ? 'Continuity State' : parsedKind.tier ? `${RELEVANCE_META[parsedKind.tier]?.label || parsedKind.tier} Relevance Lore Entries` : 'Lore Entries';
    const computedBudget = budget || estimateTokenBudgetForCompression(directText, level);
    const templateKey = parsedKind.base === 'continuity' ? 'continuityCompressionPromptTemplate' : 'loreCompressionPromptTemplate';
    const fallbackTemplate = parsedKind.base === 'continuity'
        ? DEFAULT_SETTINGS.continuityCompressionPromptTemplate
        : DEFAULT_SETTINGS.loreCompressionPromptTemplate;
    const template = String(settings[templateKey] || fallbackTemplate || '');
    const vars = {
        kind: kindLabel,
        compressionLevel: String(level),
        compressionLabel: computedBudget.profile.description,
        directTokens: String(computedBudget.directTokens),
        targetTokens: String(computedBudget.targetTokens),
        hardTokenLimit: String(computedBudget.hardTokenLimit),
        directCharacters: String(computedBudget.directCharacters),
        targetCharacters: String(computedBudget.targetCharacters),
        hardCharacterLimit: String(computedBudget.hardCharacterLimit),
        storyContext: context,
        directText,
    };
    const rendered = template.replace(/{{\s*(\w+)\s*}}/g, (_, key) => Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : '');
    if (/{{\s*(targetCharacters|hardCharacterLimit|directCharacters)\s*}}/i.test(template)) return rendered;
    // Preserve older/custom advanced templates, but append the dynamic length
    // contract that prevents level 3+ compression from becoming a same-size rewrite.
    return `${rendered}

Compression length contract:
- Source length: about ${vars.directTokens} tokens / ${vars.directCharacters} characters.
- Target length: <= ${vars.targetTokens} tokens / <= ${vars.targetCharacters} characters.
- Hard maximum visible output: <= ${vars.hardTokenLimit} tokens / <= ${vars.hardCharacterLimit} characters.
- If information must be sacrificed, preserve active continuity constraints, secrets, knowledge boundaries, pinned/protected details, and current-scene hazards first.
- Output only the compressed injection text.`;
}


function cleanCompressedText(text) {
    let cleaned = String(text || '')
        .replace(/```(?:text|markdown)?\s*([\s\S]*?)```/i, '$1')
        .trim();
    if (/^\{[\s\S]*\}$/.test(cleaned)) {
        try {
            const parsed = JSON.parse(cleaned);
            cleaned = String(parsed.compressedText || parsed.compressed || parsed.text || parsed.content || parsed.message || cleaned).trim();
        } catch (_) {}
    }
    return cleaned;
}

function parseLoreCompressionKind(kind = 'lore') {
    const raw = String(kind || 'lore').toLowerCase().replace(/_/g, '-');
    if (raw === 'continuity') return { base: 'continuity', tier: '' };
    if (raw.includes('high')) return { base: 'lore', tier: 'high' };
    if (raw.includes('normal')) return { base: 'lore', tier: 'normal' };
    if (raw.includes('low')) return { base: 'lore', tier: 'low' };
    return { base: 'lore', tier: '' };
}
function capTier(tier) { return tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : ''; }
function tierSettingKey(tier, suffix) { return tier ? `lore${capTier(tier)}${suffix}` : `lore${suffix}`; }
function getCompressionStatusObjectForKind(state, kind = 'lore') {
    const parsed = parseLoreCompressionKind(kind);
    if (parsed.base === 'continuity') return state?.continuityCompressionStatus || {};
    if (parsed.tier) return state?.loreCompressionStatusByRelevance?.[parsed.tier] || {};
    return state?.loreCompressionStatus || {};
}
function getCompressionStatusKeyForKind(kind = 'lore') {
    const parsed = parseLoreCompressionKind(kind);
    if (parsed.base === 'continuity') return 'continuityCompressionStatus';
    if (parsed.tier) return `loreCompressionStatusByRelevance.${parsed.tier}`;
    return 'loreCompressionStatus';
}
function getLoreTierMode(settings, tier) { return settings[tierSettingKey(tier, 'InjectionMode')] || (tier === 'high' ? 'direct' : 'compressed'); }
function getLoreTierLevel(settings, tier) { return Math.max(1, Math.min(5, Number(settings[tierSettingKey(tier, 'CompressionLevel')]) || 3)); }

function getCompressionStatusTextForKind(state, kind = 'lore') {
    const settings = getSettings();
    const parsed = parseLoreCompressionKind(kind);
    if (parsed.base === 'continuity') return getContinuityCompressionStatusText(state);
    if (parsed.tier && getLoreTierMode(settings, parsed.tier) !== 'compressed') return 'Direct mode active; compression not used.';
    if (!parsed.tier && (settings.loreInjectionMode || 'direct') !== 'compressed') return 'Direct mode active; compression not used.';
    const status = getCompressionStatusObjectForKind(state, kind);
    const direct = parsed.tier ? buildLorePreview(state, 'direct', parsed.tier) : buildLorePreview(state, 'direct');
    const currentSignature = getCompressionSourceSignature(state, kind, direct);
    if (status.lastSignature !== currentSignature) {
        return status.lastError ? `cached compression is stale; last error: ${status.lastError}` : 'Cached compression is missing or stale. Click Compress Now.';
    }
    if (status.lastError) return `last compression failed: ${status.lastError}`;
    if (!status.lastCompressedAt) return 'No cached model compression yet. Click Compress Now.';
    const when = new Date(status.lastCompressedAt).toLocaleTimeString();
    return `model-compressed ${when}; ${status.turnsSinceCompression || 0} turns since; ~${status.lastTokenEstimate || 0} tokens / ${status.lastCharacterCount || 0} chars${status.lastCompressionRatio ? `; ratio ${Math.round(status.lastCompressionRatio * 100)}%` : ''}`;
}

function getCompressionStatusText(state) {
    const settings = getSettings();
    const status = state?.loreCompressionStatus || {};
    if ((settings.loreInjectionMode || 'direct') !== 'compressed') {
        return 'Direct mode active; compression not used.';
    }
    const currentSignature = getCompressionSourceSignature(state, 'lore', buildLorePreview(state, 'direct'));
    if (status.lastSignature !== currentSignature) {
        return status.lastError ? `cached compression is stale; last error: ${status.lastError}` : 'Cached compression is missing or stale. Click Compress Lore Now.';
    }
    if (status.lastError) {
        return `last compression failed: ${status.lastError}`;
    }
    if (!status.lastCompressedAt) {
        return 'No cached model compression yet. Click Compress Lore Now.';
    }
    const when = new Date(status.lastCompressedAt).toLocaleTimeString();
    return `model-compressed ${when}; ${status.turnsSinceCompression || 0} turns since; ~${status.lastTokenEstimate || 0} tokens / ${status.lastCharacterCount || 0} chars${status.lastTargetTokenEstimate ? ` (target ${status.lastTargetTokenEstimate} tokens / ${status.lastTargetCharacterCount || '?'} chars)` : ''}${status.lastCompressionRatio ? `; ratio ${Math.round(status.lastCompressionRatio * 100)}%` : ''}`;
}

function getContinuityCompressionStatusText(state) {
    const settings = getSettings();
    const status = state?.continuityCompressionStatus || {};
    if ((settings.continuityInjectionMode || 'direct') !== 'compressed') {
        return 'Direct mode active; continuity compression not used.';
    }
    const currentSignature = getCompressionSourceSignature(state, 'continuity', buildContinuityPreview(state, 'direct'));
    if (status.lastSignature !== currentSignature) {
        return status.lastError ? `cached compression is stale; last error: ${status.lastError}` : 'Cached compression is missing or stale. Click Compress Continuity Now.';
    }
    if (status.lastError) {
        return `last compression failed: ${status.lastError}`;
    }
    if (!status.lastCompressedAt) {
        return 'No cached model compression yet. Click Compress Continuity Now.';
    }
    const when = new Date(status.lastCompressedAt).toLocaleTimeString();
    return `model-compressed ${when}; ${status.turnsSinceCompression || 0} turns since; ~${status.lastTokenEstimate || 0} tokens / ${status.lastCharacterCount || 0} chars${status.lastTargetTokenEstimate ? ` (target ${status.lastTargetTokenEstimate} tokens / ${status.lastTargetCharacterCount || '?'} chars)` : ''}${status.lastCompressionRatio ? `; ratio ${Math.round(status.lastCompressionRatio * 100)}%` : ''}`;
}

function getChatLength() {
    try {
        const ctx = SillyTavern.getContext();
        return Array.isArray(ctx?.chat) ? ctx.chat.length : 0;
    } catch (_) {
        return 0;
    }
}

function hasValidModelCompression(kind = 'lore') {
    const state = getState();
    const statusKey = kind === 'continuity' ? 'continuityCompressionStatus' : 'loreCompressionStatus';
    const status = state?.[statusKey] || {};
    const signature = getCompressionSourceSignature(state, kind, kind === 'continuity' ? buildContinuityPreview(state, 'direct') : buildLorePreview(state, 'direct'));
    return status.lastSignature === signature && typeof status.cachedText === 'string' && status.cachedText.trim();
}

function hasAnyModelCompression(kind = 'lore') {
    const state = getState();
    const statusKey = kind === 'continuity' ? 'continuityCompressionStatus' : 'loreCompressionStatus';
    const status = state?.[statusKey] || {};
    return typeof status.cachedText === 'string' && status.cachedText.trim() && status.lastCompressedAt;
}

function hasCompressibleText(text) {
    const clean = String(text || '')
        .replace(/Direct mode active;[^\n]*/gi, '')
        .replace(/No accepted active lore entries[^\n]*/gi, '')
        .replace(/No continuity state[^\n]*/gi, '')
        .trim();
    return clean.length > 80;
}

function createInjectionModeButton(mode, label, tooltip, settings) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wandlight-mode-button';
    if ((settings.loreInjectionMode || 'direct') === mode) btn.classList.add('wandlight-mode-button-active');
    btn.textContent = label;
    addTooltip(btn, tooltip);
    btn.addEventListener('click', async () => {
        const next = getSettings();
        next.loreInjectionMode = mode;
        saveSettings(next);
        if (mode === 'compressed' && !hasValidModelCompression('lore')) {
            const directText = buildLorePreview(getState(), 'direct');
            if (!hasCompressibleText(directText)) {
                toast('Lore compressed mode selected, but there is no accepted lore to compress yet. Generate/accept lore entries first, then use Compress Lore Now.', 'warning');
            } else if (hasAnyModelCompression('lore')) {
                toast('Lore compressed mode selected. Existing compressed cache is stale for the current source/settings; using direct preview until you click Compress Lore Now.', 'warning');
            } else {
                toast('Lore compressed mode selected. No cached compression exists yet; using direct preview until you click Compress Lore Now.', 'warning');
            }
        }
        refreshPanelBody({ preserveScroll: true, preserveWindowScroll: true });
        refreshHeader();
        toast(`Lore injection mode set to ${label}.`);
    });
    return btn;
}

function createContinuityModeButton(mode, label, tooltip, settings) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wandlight-mode-button';
    if ((settings.continuityInjectionMode || 'direct') === mode) btn.classList.add('wandlight-mode-button-active');
    btn.textContent = label;
    addTooltip(btn, tooltip);
    btn.addEventListener('click', async () => {
        const next = getSettings();
        next.continuityInjectionMode = mode;
        saveSettings(next);
        if (mode === 'compressed' && !hasValidModelCompression('continuity')) {
            const directText = buildContinuityPreview(getState(), 'direct');
            if (!hasCompressibleText(directText)) {
                toast('Continuity compressed mode selected, but there is no continuity state to compress yet. Run Scan Continuity State first, then use Compress Continuity Now.', 'warning');
            } else if (hasAnyModelCompression('continuity')) {
                toast('Continuity compressed mode selected. Existing compressed cache is stale for the current source/settings; using direct preview until you click Compress Continuity Now.', 'warning');
            } else {
                toast('Continuity compressed mode selected. No cached compression exists yet; using direct preview until you click Compress Continuity Now.', 'warning');
            }
        }
        refreshPanelBody({ preserveScroll: true, preserveWindowScroll: true });
        refreshHeader();
        toast(`Continuity injection mode set to ${label}.`);
    });
    return btn;
}


function createPendingLoreReviewSection(state) {
    const pendingLore = normalizeLoreMatrix(state?.pendingLoreEntries || []);
    const section = document.createElement('div');
    section.className = 'wandlight-review-section wandlight-pending-lore-section';

    section.appendChild(createLoreWorkbenchLaunchRow('pending', pendingLore.length ? `${pendingLore.length} pending entries` : 'No pending entries yet'));

    if (pendingLore.length > 0) {
        const batchInfo = document.createElement('div');
        batchInfo.className = 'wandlight-runtime-help';
        batchInfo.textContent = getPendingLoreBatchLabel(state);
        section.appendChild(batchInfo);

        section.appendChild(markTourTarget(createPendingLoreBulkControls(pendingLore, state), 'lore.pending.bulk'));

        const visibleLimit = Math.max(5, Math.min(1000, Number(state?.lorePanel?.pendingReviewVisibleLimit) || 10));
        const list = document.createElement('div');
        list.className = 'wandlight-review-lore-list wandlight-pending-lore-list';
        markTourTarget(list, 'lore.pending.list');
        pendingLore.slice(0, visibleLimit).forEach((entry, idx) => list.appendChild(createPendingLoreReviewCard(entry, idx, isPendingLoreSelected(state, entry))));
        section.appendChild(list);

        if (pendingLore.length > visibleLimit) {
            const more = createButton(`Show ${Math.min(25, pendingLore.length - visibleLimit)} more`, 'Renders more pending lore cards. Keeping this list paged prevents large canon batches from freezing the browser.', () => {
                const current = getState();
                current.lorePanel.pendingReviewVisibleLimit = Math.min(pendingLore.length, visibleLimit + 25);
                saveState(current);
                refreshPanelBody({ preserveScroll: true });
            });
            more.classList.add('wandlight-small-button');
            section.appendChild(more);
        }
    } else {
        section.appendChild(createEmptyMessage('No lore entries are waiting for review. Use Suggest Canon Lore or Scan Story Lore above.'));
    }

    return section;
}

function createLoreWorkbenchLaunchRow(mode, summaryText) {
    const row = document.createElement('div');
    row.className = 'wandlight-lore-workbench-launch-row';
    markTourTarget(row, mode === 'pending' ? 'lore.pending.workbench' : 'lore.accepted.workbench');

    const text = document.createElement('div');
    text.className = 'wandlight-lore-workbench-launch-text';
    text.textContent = summaryText || (mode === 'pending' ? 'Review pending lore in a larger surface.' : 'Manage accepted lore in a larger surface.');
    row.appendChild(text);

    const btn = createButton(
        'Open Workbench',
        mode === 'pending'
            ? 'Open a larger Pending Lore Review workspace with dense rows and a detail pane.'
            : 'Open a larger Accepted Lore workspace with filters, bulk actions, dense rows, and a detail pane.',
        () => openLoreWorkbench(mode),
        'wandlight-small-button wandlight-lore-workbench-open-button'
    );
    row.appendChild(btn);
    return row;
}

function openLoreWorkbench(mode = 'accepted') {
    loreWorkbenchOpen = true;
    loreWorkbenchMode = mode === 'pending' ? 'pending' : 'accepted';
    ensureLoreWorkbenchSelection(getState());
    renderLoreWorkbench();
}

function closeLoreWorkbench() {
    flushScheduledStateSave();
    loreWorkbenchOpen = false;
    const existing = document.getElementById(LORE_WORKBENCH_ID);
    if (existing) existing.remove();
}

function refreshLoreWorkbench() {
    if (!loreWorkbenchOpen) return;
    ensureLoreWorkbenchSelection(getState());
    renderLoreWorkbench();
}

function scheduleLoreWorkbenchRefresh() {
    if (loreWorkbenchSearchTimer) clearTimeout(loreWorkbenchSearchTimer);
    loreWorkbenchSearchTimer = setTimeout(() => {
        loreWorkbenchSearchTimer = null;
        refreshLoreWorkbench();
    }, SEARCH_RENDER_DEBOUNCE_MS);
}

function ensureLoreWorkbenchSelection(state = getState()) {
    if (loreWorkbenchMode === 'pending') {
        const rows = getPendingWorkbenchRows(state);
        if (!rows.some(row => getLoreReviewId(row.entry) === loreWorkbenchSelectedId)) {
            loreWorkbenchSelectedId = rows[0] ? getLoreReviewId(rows[0].entry) : '';
        }
        return;
    }

    const accepted = getFilteredLoreEntries(state);
    if (!accepted.some(entry => entry.id === loreWorkbenchSelectedId)) {
        loreWorkbenchSelectedId = accepted[0]?.id || '';
    }
}

function renderLoreWorkbench() {
    if (!loreWorkbenchOpen) return;
    const state = getState();
    ensureLoreWorkbenchSelection(state);

    let overlay = document.getElementById(LORE_WORKBENCH_ID);
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = LORE_WORKBENCH_ID;
        overlay.className = 'wandlight-lore-workbench-overlay';
        overlay.tabIndex = -1;
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) closeLoreWorkbench();
        });
        overlay.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') closeLoreWorkbench();
        });
        document.body.appendChild(overlay);
    }

    const focusSelector = loreWorkbenchFocusSelector;
    loreWorkbenchFocusSelector = '';
    overlay.replaceChildren(createLoreWorkbenchShell(state));
    requestAnimationFrame(() => {
        const focusTarget = focusSelector ? overlay.querySelector(focusSelector) : overlay;
        focusTarget?.focus?.();
        if (focusTarget && typeof focusTarget.setSelectionRange === 'function') {
            const len = String(focusTarget.value || '').length;
            focusTarget.setSelectionRange(len, len);
        }
    });
}

function createLoreWorkbenchShell(state) {
    const shell = document.createElement('div');
    shell.className = 'wandlight-lore-workbench-shell';
    shell.addEventListener('click', event => event.stopPropagation());

    shell.appendChild(createLoreWorkbenchHeader(state));

    const body = document.createElement('div');
    body.className = 'wandlight-lore-workbench-body';
    body.appendChild(loreWorkbenchMode === 'pending'
        ? createPendingLoreWorkbenchView(state)
        : createAcceptedLoreWorkbenchView(state));
    shell.appendChild(body);

    return shell;
}

function createLoreWorkbenchHeader(state) {
    const header = document.createElement('div');
    header.className = 'wandlight-lore-workbench-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'wandlight-lore-workbench-title-wrap';
    const title = document.createElement('div');
    title.className = 'wandlight-lore-workbench-title';
    title.textContent = 'Lore Workbench';
    titleWrap.appendChild(title);

    const acceptedCount = normalizeLoreMatrix(state?.loreMatrix || []).length;
    const pendingCount = normalizeLoreMatrix(state?.pendingLoreEntries || []).length;
    const subtitle = document.createElement('div');
    subtitle.className = 'wandlight-lore-workbench-subtitle';
    subtitle.textContent = `${acceptedCount} accepted | ${pendingCount} pending`;
    titleWrap.appendChild(subtitle);
    header.appendChild(titleWrap);

    const modeTabs = document.createElement('div');
    modeTabs.className = 'wandlight-lore-workbench-mode-tabs';
    for (const [mode, label, count] of [
        ['accepted', 'Accepted', acceptedCount],
        ['pending', 'Pending', pendingCount],
    ]) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wandlight-lore-workbench-mode-tab';
        if (loreWorkbenchMode === mode) btn.classList.add('wandlight-lore-workbench-mode-tab-active');
        btn.textContent = `${label} (${count})`;
        btn.addEventListener('click', () => {
            loreWorkbenchMode = mode;
            loreWorkbenchSelectedId = '';
            ensureLoreWorkbenchSelection(getState());
            renderLoreWorkbench();
        });
        modeTabs.appendChild(btn);
    }
    header.appendChild(modeTabs);

    const close = createButton('Close', 'Close the Lore Workbench.', () => closeLoreWorkbench(), 'wandlight-small-button wandlight-lore-workbench-close');
    header.appendChild(close);
    return header;
}

function createAcceptedLoreWorkbenchView(state) {
    const view = document.createElement('div');
    view.className = 'wandlight-lore-workbench-view wandlight-lore-workbench-view-accepted';

    view.appendChild(createAcceptedWorkbenchControls(state));

    const bulk = document.createElement('div');
    bulk.className = 'wandlight-workbench-bulk-toolbar wandlight-workbench-accepted-bulk-toolbar';
    bulk.appendChild(createAcceptedLoreBulkControls(state));
    view.appendChild(bulk);

    const main = document.createElement('div');
    main.className = 'wandlight-lore-workbench-main';

    const filtered = getFilteredLoreEntries(state);
    main.appendChild(createAcceptedWorkbenchTable(filtered, state));
    main.appendChild(createAcceptedWorkbenchDetail(filtered, state));
    view.appendChild(main);

    return view;
}

function createAcceptedWorkbenchControls(state) {
    const controls = document.createElement('div');
    controls.className = 'wandlight-lore-workbench-controls';
    const panelState = state?.lorePanel || {};
    const loreState = getPanelLoreState(state);

    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'wandlight-lore-workbench-search';
    search.dataset.workbenchFocus = 'accepted-search';
    search.placeholder = 'Search accepted lore...';
    search.value = panelState.search || '';
    search.addEventListener('input', () => {
        setPanelState({ search: search.value, acceptedLoreVisibleLimit: ACCEPTED_LORE_INITIAL_VISIBLE_LIMIT }, { deferSave: true });
        loreWorkbenchFocusSelector = '[data-workbench-focus="accepted-search"]';
        scheduleAcceptedLoreListRender(panelRoot);
        scheduleLoreWorkbenchRefresh();
    });
    controls.appendChild(search);

    const category = document.createElement('select');
    category.className = 'wandlight-lore-workbench-select';
    for (const cat of loreState.categories || ['all']) {
        if (cat === 'pending') continue;
        const opt = document.createElement('option');
        opt.value = cat;
        opt.textContent = `${getLoreDisplayLabel('category', cat)} (${getCategoryCount(cat, loreState.entries, loreState.counts)})`;
        if ((panelState.selectedCategory || 'all') === cat) opt.selected = true;
        category.appendChild(opt);
    }
    category.addEventListener('change', () => {
        setPanelState({ selectedCategory: category.value, acceptedLoreVisibleLimit: ACCEPTED_LORE_INITIAL_VISIBLE_LIMIT }, { deferSave: true });
        refreshAcceptedLoreCategoryTabs(category.value);
        refreshAcceptedLoreFilterResults({ resetListScroll: true });
        refreshLoreWorkbench();
    });
    controls.appendChild(category);

    const source = document.createElement('select');
    source.className = 'wandlight-lore-workbench-select';
    for (const [value, label] of [
        ['all', 'Source: All'],
        ['canon-db', 'Canon Database'],
        ['story-generation', 'Story Generation'],
        ['manual', 'Manual / User'],
    ]) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        if ((panelState.sourceFilter || 'all') === value) opt.selected = true;
        source.appendChild(opt);
    }
    source.addEventListener('change', () => {
        setPanelState({ sourceFilter: source.value, acceptedLoreVisibleLimit: ACCEPTED_LORE_INITIAL_VISIBLE_LIMIT }, { deferSave: true });
        refreshAcceptedLoreFilterResults({ resetListScroll: true });
        refreshLoreWorkbench();
    });
    controls.appendChild(source);

    const count = document.createElement('div');
    count.className = 'wandlight-lore-workbench-count';
    count.textContent = `${getFilteredLoreEntries(state).length} matching`;
    controls.appendChild(count);

    return controls;
}

function createAcceptedWorkbenchTable(entries, state) {
    const table = document.createElement('div');
    table.className = 'wandlight-lore-workbench-table wandlight-lore-workbench-accepted-table';

    const header = document.createElement('div');
    header.className = 'wandlight-lore-workbench-row wandlight-lore-workbench-row-header';
    for (const label of ['', 'Title', 'Relevance', 'Source', 'Category', 'Canon', 'Priority', 'Flags']) {
        const cell = document.createElement('div');
        cell.textContent = label;
        header.appendChild(cell);
    }
    table.appendChild(header);

    const visible = entries.slice(0, LORE_WORKBENCH_ROW_LIMIT);
    if (!visible.length) {
        table.appendChild(createEmptyMessage('No accepted lore entries match the current filters.'));
        return table;
    }

    const selected = getAcceptedSelectionSet(state);
    for (const entry of visible) {
        const row = document.createElement('div');
        row.className = 'wandlight-lore-workbench-row wandlight-lore-workbench-entry-row';
        if (entry.id === loreWorkbenchSelectedId) row.classList.add('wandlight-lore-workbench-row-active');
        row.addEventListener('click', () => {
            loreWorkbenchSelectedId = entry.id;
            renderLoreWorkbench();
        });

        const checkCell = document.createElement('div');
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = selected.has(entry.id);
        check.addEventListener('click', event => event.stopPropagation());
        check.addEventListener('change', () => {
            toggleAcceptedLoreSelection(entry.id, check.checked);
            refreshAcceptedLoreList({ preserveScroll: true });
            refreshAcceptedLoreBulkToolbar();
            refreshLoreWorkbench();
        });
        checkCell.appendChild(check);
        row.appendChild(checkCell);

        row.appendChild(createWorkbenchTextCell(entry.title || '(Untitled lore)', entry.fact || ''));
        row.appendChild(createWorkbenchTextCell(RELEVANCE_META[getLifecycleStatus(entry)]?.label || getLifecycleStatus(entry)));
        row.appendChild(createWorkbenchTextCell(getLoreSourceBucketLabel(getLoreSourceBucket(entry))));
        row.appendChild(createWorkbenchTextCell(getLoreDisplayLabel('category', entry.category || 'other')));
        row.appendChild(createWorkbenchTextCell(getLoreDisplayLabel('canonStatus', entry.canon || entry.canonStatus || 'canon')));
        row.appendChild(createWorkbenchTextCell(`P${Number(entry.priority || 50)}`));
        row.appendChild(createWorkbenchTextCell([
            entry.isPinned ? 'Pinned' : '',
            entry.isSuppressed ? 'Muted' : '',
        ].filter(Boolean).join(', ') || '-'));

        table.appendChild(row);
    }

    if (entries.length > visible.length) {
        const more = document.createElement('div');
        more.className = 'wandlight-lore-workbench-row-note';
        more.textContent = `Showing first ${visible.length} of ${entries.length} matching entries. Narrow filters or search to reduce the set.`;
        table.appendChild(more);
    }

    return table;
}

function createAcceptedWorkbenchDetail(entries, state) {
    const detail = document.createElement('div');
    detail.className = 'wandlight-lore-workbench-detail';

    const entry = entries.find(item => item.id === loreWorkbenchSelectedId) || entries[0];
    if (!entry) {
        detail.appendChild(createEmptyMessage('Select an accepted lore entry to inspect it.'));
        return detail;
    }

    const detailState = {
        ...state,
        lorePanel: {
            ...(state?.lorePanel || {}),
            selectedEntryId: entry.id,
        },
    };
    const card = createEntryCard(entry, detailState);
    card.classList.add('wandlight-lore-workbench-detail-card');
    detail.appendChild(card);
    return detail;
}

function createPendingLoreWorkbenchView(state) {
    const view = document.createElement('div');
    view.className = 'wandlight-lore-workbench-view wandlight-lore-workbench-view-pending';

    view.appendChild(createPendingWorkbenchControls(state));

    const pending = normalizeLoreMatrix(state?.pendingLoreEntries || []);
    if (pending.length) {
        const bulk = document.createElement('div');
        bulk.className = 'wandlight-workbench-bulk-toolbar wandlight-workbench-pending-bulk-toolbar';
        bulk.appendChild(createPendingLoreBulkControls(pending, state));
        view.appendChild(bulk);
    }

    const main = document.createElement('div');
    main.className = 'wandlight-lore-workbench-main';
    const rows = getPendingWorkbenchRows(state);
    main.appendChild(createPendingWorkbenchTable(rows, state));
    main.appendChild(createPendingWorkbenchDetail(rows, state));
    view.appendChild(main);

    return view;
}

function createPendingWorkbenchControls(state) {
    const controls = document.createElement('div');
    controls.className = 'wandlight-lore-workbench-controls';

    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'wandlight-lore-workbench-search';
    search.dataset.workbenchFocus = 'pending-search';
    search.placeholder = 'Search pending lore...';
    search.value = loreWorkbenchPendingQuery || '';
    search.addEventListener('input', () => {
        loreWorkbenchPendingQuery = search.value;
        loreWorkbenchFocusSelector = '[data-workbench-focus="pending-search"]';
        scheduleLoreWorkbenchRefresh();
    });
    controls.appendChild(search);

    const rows = getPendingWorkbenchRows(state);
    const count = document.createElement('div');
    count.className = 'wandlight-lore-workbench-count';
    count.textContent = `${rows.length} matching pending`;
    controls.appendChild(count);

    const selectFiltered = createButton('Select Filtered', 'Select every pending entry matching the current Workbench search.', () => {
        setPendingReviewSelection(rows.map(row => getLoreReviewId(row.entry)));
        refreshPanelBody({ preserveScroll: true });
        refreshLoreWorkbench();
    }, 'wandlight-small-button');
    controls.appendChild(selectFiltered);

    const clear = createButton('Clear Selection', 'Clear pending lore selection.', () => {
        clearPendingReviewSelection();
        refreshPanelBody({ preserveScroll: true });
        refreshLoreWorkbench();
    }, 'wandlight-small-button');
    controls.appendChild(clear);

    return controls;
}

function createPendingWorkbenchTable(rows, state) {
    const table = document.createElement('div');
    table.className = 'wandlight-lore-workbench-table wandlight-lore-workbench-pending-table';

    const header = document.createElement('div');
    header.className = 'wandlight-lore-workbench-row wandlight-lore-workbench-row-header';
    for (const label of ['', 'Title', 'Operation', 'Route', 'Category', 'Canon', 'Priority']) {
        const cell = document.createElement('div');
        cell.textContent = label;
        header.appendChild(cell);
    }
    table.appendChild(header);

    const visible = rows.slice(0, LORE_WORKBENCH_ROW_LIMIT);
    if (!visible.length) {
        table.appendChild(createEmptyMessage('No pending lore entries match the current search.'));
        return table;
    }

    const selected = getPendingReviewSelectedIds(state);
    for (const rowInfo of visible) {
        const entry = rowInfo.entry;
        const reviewId = getLoreReviewId(entry);
        const generation = entry.extensions?.wandlightGeneration || {};
        const reviewMeta = entry.extensions?.wandlightPendingReview || {};
        const row = document.createElement('div');
        row.className = 'wandlight-lore-workbench-row wandlight-lore-workbench-entry-row';
        if (reviewId === loreWorkbenchSelectedId) row.classList.add('wandlight-lore-workbench-row-active');
        row.addEventListener('click', () => {
            loreWorkbenchSelectedId = reviewId;
            renderLoreWorkbench();
        });

        const checkCell = document.createElement('div');
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = selected.has(reviewId);
        check.addEventListener('click', event => event.stopPropagation());
        check.addEventListener('change', () => {
            togglePendingReviewSelection(reviewId, check.checked);
            refreshPanelBody({ preserveScroll: true });
            refreshLoreWorkbench();
        });
        checkCell.appendChild(check);
        row.appendChild(checkCell);

        row.appendChild(createWorkbenchTextCell(entry.title || '(Untitled pending lore)', entry.fact || ''));
        row.appendChild(createWorkbenchTextCell(generation.operation || reviewMeta.reviewRoute || 'create'));
        row.appendChild(createWorkbenchTextCell(generation.similarityRoute || reviewMeta.reviewRoute || '-'));
        row.appendChild(createWorkbenchTextCell(getLoreDisplayLabel('category', entry.category || 'other')));
        row.appendChild(createWorkbenchTextCell(getLoreDisplayLabel('canonStatus', entry.canon || entry.canonStatus || 'canon')));
        row.appendChild(createWorkbenchTextCell(`P${Number(entry.priority || 50)}`));
        table.appendChild(row);
    }

    if (rows.length > visible.length) {
        const more = document.createElement('div');
        more.className = 'wandlight-lore-workbench-row-note';
        more.textContent = `Showing first ${visible.length} of ${rows.length} matching pending entries. Narrow search to reduce the set.`;
        table.appendChild(more);
    }
    return table;
}

function createPendingWorkbenchDetail(rows, state) {
    const detail = document.createElement('div');
    detail.className = 'wandlight-lore-workbench-detail';

    const selected = rows.find(row => getLoreReviewId(row.entry) === loreWorkbenchSelectedId) || rows[0];
    if (!selected) {
        detail.appendChild(createEmptyMessage('Select a pending lore entry to inspect it.'));
        return detail;
    }
    detail.appendChild(createPendingLoreReviewCard(selected.entry, selected.index, isPendingLoreSelected(state, selected.entry)));
    return detail;
}

function getPendingWorkbenchRows(state = getState()) {
    const pending = normalizeLoreMatrix(state?.pendingLoreEntries || []);
    const query = String(loreWorkbenchPendingQuery || '').trim().toLowerCase();
    const rows = pending.map((entry, index) => ({ entry, index }));
    if (!query) return rows;
    return rows
        .map(row => ({ ...row, score: scoreSearchEntry(row.entry, query) }))
        .filter(row => row.score > 0)
        .sort((a, b) => b.score - a.score || String(a.entry.title || '').localeCompare(String(b.entry.title || '')));
}

function createWorkbenchTextCell(primary, secondary = '') {
    const cell = document.createElement('div');
    cell.className = 'wandlight-lore-workbench-cell';
    const main = document.createElement('span');
    main.className = 'wandlight-lore-workbench-cell-main';
    main.textContent = primary || '-';
    cell.appendChild(main);
    if (secondary) {
        const sub = document.createElement('span');
        sub.className = 'wandlight-lore-workbench-cell-sub';
        sub.textContent = truncateText(secondary, 150);
        cell.appendChild(sub);
    }
    return cell;
}

function getLoreSourceBucketLabel(bucket) {
    if (bucket === 'canon-db') return 'Canon DB';
    if (bucket === 'story-generation') return 'Story';
    if (bucket === 'manual') return 'Manual';
    return 'Other';
}

// Shared review-card helpers --------------------------------------------------
function createDeltaReviewCard(delta) {
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card wandlight-delta-review-card';

    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = delta?.summary || 'Pending continuity changes';
    addTooltip(title, 'Summary generated by the extraction pass.');
    card.appendChild(title);

    const keys = Object.keys(delta?.changes || {});
    card.appendChild(createKeyValue('Sections changed', keys.length ? keys.join(', ') : 'none', 'Top-level state sections affected by this pending delta.'));

    const pre = document.createElement('pre');
    pre.className = 'wandlight-delta-json-preview';
    pre.textContent = JSON.stringify(delta, null, 2);
    addTooltip(pre, 'Raw pending delta. This remains visible here because it is directly relevant to the review decision.');
    card.appendChild(pre);

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions';
    actions.appendChild(createButton('Apply Changes', 'Applies this pending delta to the continuity state and clears it.', () => {
        const current = getState();
        if (!current.lastDelta) {
            toast('No pending continuity changes to apply.', 'warning');
            refreshPanelBody({ preserveScroll: false });
            return;
        }
        pushStateSnapshot(current, 'Apply pending continuity changes', getSettings().maxSnapshots);
        const next = applyDelta(current, current.lastDelta);
        next.lastDelta = null;
        saveState(next);
        refreshPanelBody({ preserveScroll: false });
        refreshHeader();
        toast('Continuity changes applied.');
    }, 'wandlight-primary-button'));
    actions.appendChild(createButton('Dismiss Changes', 'Discards this pending delta without changing continuity state.', () => {
        const current = getState();
        current.lastDelta = null;
        saveState(current);
        refreshPanelBody({ preserveScroll: false });
        refreshHeader();
        toast('Continuity changes dismissed.', 'info');
    }));
    card.appendChild(actions);

    return card;
}


function createPendingLoreBulkControls(pendingLore, state) {
    const selectedIds = getPendingReviewSelectedIds(state);
    const pendingIds = pendingLore.map(getLoreReviewId);
    const selectedCount = pendingIds.filter(id => selectedIds.has(id)).length;

    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card wandlight-review-bulk-card';

    const header = document.createElement('label');
    header.className = 'wandlight-review-select-all';
    const selectAll = document.createElement('input');
    selectAll.type = 'checkbox';
    selectAll.checked = selectedCount > 0 && selectedCount === pendingIds.length;
    selectAll.indeterminate = selectedCount > 0 && selectedCount < pendingIds.length;
    addTooltip(selectAll, 'Select or clear all pending lore entries in this batch.');
    selectAll.addEventListener('change', () => {
        setPendingReviewSelection(selectAll.checked ? pendingIds : []);
        refreshPanelBody({ preserveScroll: true });
        refreshLoreWorkbench();
    });
    header.appendChild(selectAll);
    const label = document.createElement('span');
    label.textContent = selectedCount ? `${selectedCount} of ${pendingIds.length} selected` : `Select all ${pendingIds.length} pending entries`;
    header.appendChild(label);
    card.appendChild(header);

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions';
    actions.appendChild(createButton('Apply Selected', 'Accepts only the selected pending lore entries. Use Select All for large batches.', () => {
        applySelectedPendingLore();
    }, 'wandlight-primary-button'));
    actions.appendChild(createButton('Dismiss Selected', 'Rejects only the selected pending lore entries.', () => {
        dismissSelectedPendingLore();
    }));
    actions.appendChild(createButton('Apply All', 'Accepts every pending lore entry in the current batch.', () => {
        const current = getState();
        const count = (current.pendingLoreEntries || []).length;
        acceptPendingLoreEntries();
        clearPendingReviewSelection();
        refreshPanelBody({ preserveScroll: false });
        refreshHeader();
        refreshLoreWorkbench();
        toast(`${count} lore entries accepted.`);
    }));
    actions.appendChild(createButton('Dismiss All', 'Rejects every pending lore entry in the current batch.', () => {
        const current = getState();
        const count = (current.pendingLoreEntries || []).length;
        rejectPendingLoreEntries();
        clearPendingReviewSelection();
        refreshPanelBody({ preserveScroll: false });
        refreshHeader();
        refreshLoreWorkbench();
        toast(`${count} lore entries dismissed.`, 'info');
    }));
    card.appendChild(actions);

    return card;
}

function createPendingLoreCheckbox(entry, checked) {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'wandlight-review-lore-checkbox wandlight-lore-entry-select';
    checkbox.checked = checked;
    addTooltip(checkbox, checked ? 'Remove this lore entry from the current bulk selection.' : 'Add this lore entry to the current bulk selection.');
    checkbox.addEventListener('click', e => e.stopPropagation());
    checkbox.addEventListener('change', () => {
        togglePendingReviewSelection(getLoreReviewId(entry), checkbox.checked);
        refreshPanelBody({ preserveScroll: true });
        refreshLoreWorkbench();
    });
    return checkbox;
}

function getLoreReviewId(entry) {
    return entry?.id || `${entry?.title || 'pending'}:${entry?.fact || ''}`;
}

function getPendingReviewSelectedIds(state = getState()) {
    return new Set(Array.isArray(state?.lorePanel?.reviewSelectedIds) ? state.lorePanel.reviewSelectedIds : []);
}

function isPendingLoreSelected(state, entry) {
    return getPendingReviewSelectedIds(state).has(getLoreReviewId(entry));
}

function setPendingReviewSelection(ids) {
    const state = getState();
    if (!state?.lorePanel) return;
    state.lorePanel.reviewSelectedIds = Array.from(new Set((ids || []).filter(Boolean)));
    saveState(state);
}

function togglePendingReviewSelection(id, selected) {
    if (!id) return;
    const current = getPendingReviewSelectedIds();
    if (selected) current.add(id);
    else current.delete(id);
    setPendingReviewSelection(Array.from(current));
}

function clearPendingReviewSelection() {
    setPendingReviewSelection([]);
}

function getSelectedPendingIndexes() {
    const state = getState();
    const selected = getPendingReviewSelectedIds(state);
    const pending = normalizeLoreMatrix(state?.pendingLoreEntries || []);
    return pending
        .map((entry, index) => ({ entry, index }))
        .filter(item => selected.has(getLoreReviewId(item.entry)))
        .map(item => item.index);
}

function applySelectedPendingLore() {
    const indexes = getSelectedPendingIndexes().sort((a, b) => b - a);
    if (!indexes.length) {
        toast('No pending lore entries selected.', 'warning');
        return;
    }
    const current = getState();
    for (const idx of indexes) acceptPendingLoreEntry(idx);
    clearPendingReviewSelection();
    refreshPanelBody({ preserveScroll: true });
    refreshHeader();
    refreshLoreWorkbench();
    toast(`${indexes.length} selected lore entries accepted.`);
}

function dismissSelectedPendingLore() {
    const indexes = getSelectedPendingIndexes().sort((a, b) => b - a);
    if (!indexes.length) {
        toast('No pending lore entries selected.', 'warning');
        return;
    }
    for (const idx of indexes) rejectPendingLoreEntry(idx);
    clearPendingReviewSelection();
    refreshPanelBody({ preserveScroll: true });
    refreshHeader();
    refreshLoreWorkbench();
    toast(`${indexes.length} selected lore entries dismissed.`, 'info');
}

function createPendingLoreReviewCard(entry, index, selected = false) {
    const card = document.createElement('div');
    card.className = 'wandlight-lore-entry-card wandlight-lore-entry-pending wandlight-pending-review-entry-card';
    markTourTarget(card, 'lore.pending.entry');
    if (selected) card.classList.add('wandlight-review-lore-card-selected');

    const headerRow = document.createElement('div');
    headerRow.className = 'wandlight-lore-entry-header';
    headerRow.appendChild(createPendingLoreCheckbox(entry, selected));

    const titleWrap = document.createElement('div');
    titleWrap.className = 'wandlight-lore-entry-title-wrap';
    const title = document.createElement('span');
    title.className = 'wandlight-lore-entry-title';
    title.textContent = entry.title || `Pending lore ${index + 1}`;
    addTooltip(title, 'Generated lore entry title. This entry is pending until accepted.');
    titleWrap.appendChild(title);
    headerRow.appendChild(titleWrap);

    const actions = document.createElement('div');
    actions.className = 'wandlight-lore-entry-actions';
    actions.appendChild(createEditableLifecycleBadge(entry, { pending: true }));
    const status = document.createElement('span');
    status.className = 'wandlight-lore-badge wandlight-lore-badge-pending';
    status.textContent = 'pending';
    addTooltip(status, 'This lore entry has not been accepted into the accepted lore matrix yet.');
    actions.appendChild(status);
    headerRow.appendChild(actions);
    card.appendChild(headerRow);

    const meta = document.createElement('div');
    meta.className = 'wandlight-lore-entry-meta';
    meta.appendChild(createRegistryBadge('category', entry.category || 'other', `Category: ${entry.category || 'other'}. Pending cards use the same compact metadata style as accepted cards.`));
    meta.appendChild(createLorePurposeBadge(entry));
    meta.appendChild(createRegistryBadge('canonStatus', entry.canon || entry.canonStatus || 'canon', `Canon/Story: ${entry.canon || entry.canonStatus || 'canon'}.`));
    meta.appendChild(createBadge(`P${Number(entry.priority || 50)}`, 'Priority used for sorting, injection preference, and canon-lore suggestion limits.'));
    const generation = entry.extensions?.wandlightGeneration || {};
    const reviewMeta = entry.extensions?.wandlightPendingReview || {};
    if (generation.operation) meta.appendChild(createBadge(`Op: ${generation.operation}`, 'Generated lore operation proposed by the story-lore scan.'));
    if (generation.qualityRoute || reviewMeta.qualityRoute) meta.appendChild(createBadge(`Quality: ${generation.qualityRoute || reviewMeta.qualityRoute}`, generation.qualityReason || reviewMeta.qualityReason || 'Generated-lore quality route.'));
    if (generation.similarityRoute || reviewMeta.reviewRoute) meta.appendChild(createBadge(`Route: ${generation.similarityRoute || reviewMeta.reviewRoute}`, generation.similarityReason || reviewMeta.similarityReason || 'Similarity/update routing result.'));
    if (generation.recommendedPin) meta.appendChild(createBadge('pin suggested', 'Generator recommends pinning/protecting this entry after acceptance.'));
    if (generation.recommendedMute) meta.appendChild(createBadge('mute suggested', 'Generator recommends storing but muting this entry after acceptance.'));
    meta.appendChild(createSpellMetadataBadges(entry));
    if (entry.confidence !== undefined) meta.appendChild(createBadge(`confidence ${entry.confidence}`, 'Model-provided confidence for this entry.'));
    card.appendChild(meta);

    const targetId = generation.targetEntryId || reviewMeta.targetEntryId || '';
    if (targetId) {
        const target = normalizeLoreMatrix(getState()?.loreMatrix || []).find(item => item.id === targetId);
        const targetBox = document.createElement('div');
        targetBox.className = 'wandlight-runtime-help wandlight-pending-target-help';
        targetBox.textContent = target
            ? `Targets existing lore: ${target.title || target.id}${target.fact ? ` - ${target.fact}` : ''}`
            : `Targets existing lore id: ${targetId}`;
        addTooltip(targetBox, generation.similarityReason || reviewMeta.similarityReason || 'Accepting this candidate will update or merge into the target if it still exists and is not locked.');
        card.appendChild(targetBox);
    }

    if (Array.isArray(entry.tags) && entry.tags.length) {
        const tags = createReadOnlyTags(entry.tags);
        tags.classList.add('wandlight-pending-readonly-tags');
        card.appendChild(tags);
    }

    const fact = document.createElement('div');
    fact.className = 'wandlight-lore-entry-fact';
    fact.textContent = entry.fact || '(No fact text)';
    addTooltip(fact, 'The fact that will be merged into the accepted lore matrix if applied.');
    card.appendChild(fact);

    if (entry.content?.injection && entry.content.injection !== entry.fact) {
        const injection = document.createElement('div');
        injection.className = 'wandlight-runtime-help wandlight-pending-injection-preview';
        injection.textContent = `Injection: ${entry.content.injection}`;
        addTooltip(injection, 'Model-facing lore text that will be injected after acceptance.');
        card.appendChild(injection);
    }
    if (Array.isArray(entry.content?.constraints) && entry.content.constraints.length) {
        const constraints = document.createElement('div');
        constraints.className = 'wandlight-runtime-help wandlight-pending-constraints-preview';
        constraints.textContent = `Constraints: ${entry.content.constraints.join(' ')}`;
        addTooltip(constraints, 'Specific constraints captured by generated lore.');
        card.appendChild(constraints);
    }

    const actionsRow = document.createElement('div');
    actionsRow.className = 'wandlight-primary-actions wandlight-pending-entry-actions';
    markTourTarget(actionsRow, 'lore.pending.actions');
    const applyLabel = targetId ? 'Apply Update' : 'Apply';
    actionsRow.appendChild(createButton(applyLabel, targetId ? 'Accepts this generated update and merges it into the targeted accepted lore entry.' : 'Accepts this single lore entry and merges it into the accepted lore matrix.', () => {
        acceptPendingLoreEntry(index);
        togglePendingReviewSelection(getLoreReviewId(entry), false);
        refreshPanelBody({ preserveScroll: true });
        refreshHeader();
        refreshLoreWorkbench();
        toast('Lore entry accepted.');
    }, 'wandlight-primary-button'));
    if (targetId) {
        actionsRow.appendChild(createButton('Apply as New', 'Accepts this generated lore as a separate new entry instead of updating the routed target.', () => {
            const current = getState();
            const pending = normalizeLoreMatrix(current.pendingLoreEntries || []);
            if (pending[index]) {
                const generationMeta = pending[index].extensions?.wandlightGeneration || {};
                const reviewMeta = pending[index].extensions?.wandlightPendingReview || {};
                pending[index] = normalizeLoreEntry({
                    ...pending[index],
                    extensions: {
                        ...(pending[index].extensions || {}),
                        wandlightGeneration: {
                            ...generationMeta,
                            operation: 'create',
                            targetEntryId: '',
                            similarityRoute: 'kept_separate',
                        },
                        wandlightPendingReview: {
                            ...reviewMeta,
                            reviewRoute: 'kept_separate',
                            targetEntryId: '',
                        },
                    },
                });
                current.pendingLoreEntries = pending;
                saveState(current, { syncPrompt: false });
            }
            acceptPendingLoreEntry(index);
            togglePendingReviewSelection(getLoreReviewId(entry), false);
            refreshPanelBody({ preserveScroll: true });
            refreshHeader();
            refreshLoreWorkbench();
            toast('Lore entry accepted as new.');
        }));
    }
    actionsRow.appendChild(createButton('Dismiss', 'Rejects this single lore entry without changing accepted lore.', () => {
        rejectPendingLoreEntry(index);
        togglePendingReviewSelection(getLoreReviewId(entry), false);
        refreshPanelBody({ preserveScroll: true });
        refreshHeader();
        refreshLoreWorkbench();
        toast('Lore entry dismissed.', 'info');
    }));
    card.appendChild(actionsRow);

    return card;
}


// Accepted lore bulk selection and editing --------------------------------------

function getAcceptedSelectionSet(state = getState()) {
    const ids = Array.isArray(state?.lorePanel?.acceptedSelectedIds) ? state.lorePanel.acceptedSelectedIds : [];
    const acceptedIds = new Set(normalizeLoreMatrix(state?.loreMatrix || []).map(entry => entry.id));
    return new Set(ids.filter(id => acceptedIds.has(id)));
}

function setAcceptedLoreSelection(ids = [], options = {}) {
    const state = getState();
    if (!state.lorePanel) state.lorePanel = getDefaultState().lorePanel;
    const acceptedIds = new Set(normalizeLoreMatrix(state.loreMatrix || []).map(entry => entry.id));
    state.lorePanel.acceptedSelectedIds = Array.from(new Set((ids || []).filter(id => acceptedIds.has(id))));
    if (options.deferSave) scheduleStateSave(state);
    else saveState(state);
}

function toggleAcceptedLoreSelection(entryId, selected) {
    const state = getState();
    const selection = getAcceptedSelectionSet(state);
    if (selected) selection.add(entryId);
    else selection.delete(entryId);
    state.lorePanel.acceptedSelectedIds = Array.from(selection);
    scheduleStateSave(state);
}

function getFilteredAcceptedLoreIds(state = getState()) {
    return getFilteredLoreEntries(state).map(entry => entry.id);
}

function refreshAcceptedLoreBulkToolbar() {
    if (!panelRoot) return;
    const mount = panelRoot.querySelector('.wandlight-lore-bulk-toolbar');
    if (!mount) return;
    mount.replaceChildren(createAcceptedLoreBulkControls(getState()));
}

function createAcceptedLoreBulkControls(state) {
    const wrap = document.createElement('div');
    wrap.className = 'wandlight-lore-bulk-controls-card';

    const selected = getAcceptedSelectionSet(state);
    const filteredIds = getFilteredAcceptedLoreIds(state);
    const selectedCount = selected.size;
    const disabled = selectedCount === 0;

    const summary = document.createElement('div');
    summary.className = 'wandlight-lore-bulk-summary';
    summary.textContent = `${selectedCount} selected · ${filteredIds.length} matching current filters`;
    addTooltip(summary, 'Bulk actions apply to selected accepted lore entries. Use Select Filtered to select every accepted entry matching the current search and filters, not just the rendered page.');
    wrap.appendChild(summary);

    const selectRow = document.createElement('div');
    selectRow.className = 'wandlight-lore-bulk-row';
    const selectFiltered = createButton('Select Filtered', 'Selects every accepted lore entry matching the current search and filters, including entries not currently rendered by paging.', () => {
        setAcceptedLoreSelection(filteredIds, { deferSave: true });
        refreshAcceptedLoreList({ preserveScroll: true });
        refreshAcceptedLoreBulkToolbar();
        refreshLoreWorkbench();
    }, 'wandlight-small-button');
    selectRow.appendChild(selectFiltered);

    const clearSelection = createButton('Clear Selection', 'Clears the accepted-lore selection.', () => {
        setAcceptedLoreSelection([], { deferSave: true });
        refreshAcceptedLoreList({ preserveScroll: true });
        refreshAcceptedLoreBulkToolbar();
        refreshLoreWorkbench();
    }, 'wandlight-small-button');
    clearSelection.disabled = disabled;
    selectRow.appendChild(clearSelection);
    wrap.appendChild(selectRow);

    const actionRow = document.createElement('div');
    actionRow.className = 'wandlight-lore-bulk-row';

    const addAction = (label, tooltip, fn, className = 'wandlight-small-button', detail = '') => {
        const btn = createButton(label, tooltip, async () => {
            const ids = Array.from(getAcceptedSelectionSet(getState()));
            if (!ids.length) {
                toast('Select one or more accepted lore entries first.', 'warning');
                return;
            }
            const proceed = await confirmBulkAcceptedAction(label, ids, detail || tooltip);
            if (!proceed) return;
            await fn(ids);
        }, className);
        btn.disabled = disabled;
        actionRow.appendChild(btn);
        return btn;
    };

    addAction('Pin', 'Pins selected accepted lore entries so they are prioritized for injection.', ids => bulkSetAcceptedPinned(ids, true), 'wandlight-small-button', 'Selected entries will be pinned and prioritized for lore injection.');
    addAction('Unpin', 'Removes selected accepted lore entries from pinned lore.', ids => bulkSetAcceptedPinned(ids, false), 'wandlight-small-button', 'Selected entries will no longer be pinned. They may still inject if unmuted and active.');
    addAction('Mute', 'Mutes selected accepted lore entries so they are excluded from injection.', ids => bulkSetAcceptedMuted(ids, true), 'wandlight-small-button', 'Selected entries will be muted and excluded from injection.');
    addAction('Unmute', 'Unmutes selected accepted lore entries.', ids => bulkSetAcceptedMuted(ids, false), 'wandlight-small-button', 'Selected entries will be unmuted and may be injected again.');
    addAction('Delete', 'Deletes selected accepted lore entries from this chat after confirmation.', ids => bulkDeleteAcceptedLore(ids), 'wandlight-small-button wandlight-danger-button', 'Deleted accepted lore can be restored to Pending Review from Lore Timeline while the recovery payload is retained.');
    wrap.appendChild(actionRow);

    const editRow = document.createElement('div');
    editRow.className = 'wandlight-lore-bulk-row wandlight-lore-bulk-edit-row';
    const selectedIdsNow = () => Array.from(getAcceptedSelectionSet(getState()));
    editRow.appendChild(createBulkSelect('Relevance', LORE_RELEVANCE_TIERS, 'Set relevance tier for selected entries.', async value => {
        const ids = selectedIdsNow();
        if (!(await confirmBulkAcceptedAction('Set Relevance', ids, `Selected entries will have relevance set to ${value}.`))) return;
        bulkUpdateAcceptedLore(ids, raw => ({
            ...raw,
            relevance: normalizeLoreRelevance(value),
            lifecycle: { ...(raw.lifecycle || {}), status: '', computedStatus: '', manualOverride: false, reason: 'Relevance replaced lifecycle state.' },
            extensions: { ...(raw.extensions || {}), autoRelevance: { ...(raw.extensions?.autoRelevance || {}), mode: 'manual', confidence: 1, reason: `Bulk relevance set to ${value}.`, updatedAt: Date.now() } },
        }));
    }, disabled, value => RELEVANCE_META[value]?.label || value));
    editRow.appendChild(createBulkSelect('Category', getLoreRegistryValues('categories', LORE_CATEGORY_VALUES), 'Set category for selected entries.', async value => {
        const ids = selectedIdsNow();
        if (!(await confirmBulkAcceptedAction('Set Category', ids, `Selected entries will have category set to ${value}.`))) return;
        bulkUpdateAcceptedLore(ids, raw => ({ ...raw, category: value }));
    }, disabled));
    editRow.appendChild(createBulkSelect('Canon', getLoreRegistryValues('canonStatuses', ['canon', 'au']), 'Set canon status for selected entries.', async value => {
        const ids = selectedIdsNow();
        if (!(await confirmBulkAcceptedAction('Set Canon Status', ids, `Selected entries will have canon status set to ${value}.`))) return;
        bulkUpdateAcceptedLore(ids, raw => ({ ...raw, canon: value, canonStatus: value }));
    }, disabled));
    editRow.appendChild(createBulkSelect('Truth', getLoreRegistryValues('truthStatuses', ['true', 'false', 'public_belief', 'rumor', 'contested', 'hidden']), 'Set truth status for selected entries.', async value => {
        const ids = selectedIdsNow();
        if (!(await confirmBulkAcceptedAction('Set Truth Status', ids, `Selected entries will have truth status set to ${value}.`))) return;
        bulkUpdateAcceptedLore(ids, raw => ({ ...raw, truthStatus: value }));
    }, disabled));
    editRow.appendChild(createBulkSelect('Reveal', getLoreRegistryValues('revealPolicies', ['public', 'private', 'do_not_reveal', 'only_if_knower_present', 'only_if_user_reveals']), 'Set reveal policy for selected entries.', async value => {
        const ids = selectedIdsNow();
        if (!(await confirmBulkAcceptedAction('Set Reveal Policy', ids, `Selected entries will have reveal policy set to ${value}.`))) return;
        bulkUpdateAcceptedLore(ids, raw => ({ ...raw, revealPolicy: value }));
    }, disabled));
    editRow.appendChild(createBulkSelect('Priority', LORE_PRIORITY_VALUES.map(String), 'Set priority for selected entries.', async value => {
        const ids = selectedIdsNow();
        if (!(await confirmBulkAcceptedAction('Set Priority', ids, `Selected entries will have priority set to P${value}.`))) return;
        bulkUpdateAcceptedLore(ids, raw => ({ ...raw, priority: Number(value) || 50 }));
    }, disabled, value => `P${value}`));
    wrap.appendChild(editRow);

    const tagRow = document.createElement('div');
    tagRow.className = 'wandlight-lore-bulk-row wandlight-lore-bulk-tag-row';
    const tagInput = document.createElement('input');
    tagInput.type = 'text';
    tagInput.className = 'wandlight-lore-bulk-tag-input';
    tagInput.placeholder = 'Add tag to selected...';
    tagInput.disabled = disabled;
    addTooltip(tagInput, 'Adds one searchable tag to all selected accepted lore entries.');
    tagInput.addEventListener('click', e => e.stopPropagation());
    tagRow.appendChild(tagInput);
    const addTagBtn = createButton('Add Tag', 'Adds the typed tag to selected entries.', () => {
        const ids = Array.from(getAcceptedSelectionSet(getState()));
        const tag = normalizeTag(tagInput.value);
        if (!ids.length || !tag) {
            toast(ids.length ? 'Enter a tag first.' : 'Select entries first.', 'warning');
            return;
        }
        confirmBulkAcceptedAction('Add Tag', ids, `The tag "${tag}" will be added to selected accepted lore entries.`).then(proceed => {
            if (!proceed) return;
            bulkAddTagToAcceptedLore(ids, tag);
            tagInput.value = '';
        });
    }, 'wandlight-small-button');
    addTagBtn.disabled = disabled;
    tagRow.appendChild(addTagBtn);
    wrap.appendChild(tagRow);

    return wrap;
}

async function confirmBulkAcceptedAction(actionLabel, ids, detail = '') {
    const safeIds = Array.isArray(ids) ? ids : [];
    if (!safeIds.length) {
        toast('Select one or more accepted lore entries first.', 'warning');
        return false;
    }
    const state = getState();
    const byId = new Map(normalizeLoreMatrix(state?.loreMatrix || []).map(entry => [entry.id, entry]));
    const names = safeIds
        .map(id => byId.get(id)?.title || id)
        .filter(Boolean)
        .slice(0, 6);
    const extra = safeIds.length > names.length ? `\n…and ${safeIds.length - names.length} more.` : '';
    const message = [
        `You are about to perform this bulk action on ${safeIds.length} accepted lore entr${safeIds.length === 1 ? 'y' : 'ies'}:`,
        '',
        actionLabel,
        detail ? `\n${detail}` : '',
        names.length ? `\nSelected entries:\n- ${names.join('\n- ')}${extra}` : '',
        '',
        'Continue?'
    ].join('\n');
    return await confirmAction(`Confirm bulk lore action: ${actionLabel}`, message);
}

function createBulkSelect(label, values, tooltip, onChange, disabled = false, display = null) {
    const select = document.createElement('select');
    select.className = 'wandlight-lore-bulk-select';
    select.disabled = disabled;
    addTooltip(select, tooltip);
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = `Set ${label}...`;
    placeholder.selected = true;
    select.appendChild(placeholder);
    for (const value of values) {
        const option = document.createElement('option');
        option.value = String(value);
        option.textContent = display ? display(value) : getLoreDisplayLabel(labelToField(label), value);
        select.appendChild(option);
    }
    select.addEventListener('click', e => e.stopPropagation());
    select.addEventListener('change', async () => {
        if (!select.value) return;
        const value = select.value;
        select.value = '';
        await onChange(value);
    });
    return select;
}

function labelToField(label) {
    if (label === 'Category') return 'category';
    if (label === 'Canon') return 'canonStatus';
    if (label === 'Relevance') return 'relevance';
    if (label === 'Priority') return 'priority';
    if (label === 'Truth') return 'truthStatus';
    if (label === 'Reveal') return 'revealPolicy';
    return 'category';
}

function bulkUpdateAcceptedLore(ids, updater) {
    if (!ids?.length || typeof updater !== 'function') return false;
    const state = getState();
    const beforeTimeline = captureLoreTimelineState(state);
    const idSet = new Set(ids);
    let count = 0;
    state.loreMatrix = normalizeLoreMatrix(state.loreMatrix || []).map(entry => {
        if (!idSet.has(entry.id)) return entry;
        count += 1;
        return normalizeLoreEntry({ ...updater(entry), userEdited: true });
    });
    if (count) {
        recordLoreTimelineEvent(state, {
            before: beforeTimeline,
            after: captureLoreTimelineState(state),
            type: 'bulk_edit',
            source: 'manual',
            summary: `Bulk edited ${count} accepted lore entr${count === 1 ? 'y' : 'ies'}.`,
        });
    }
    saveState(state);
    refreshAcceptedLoreList({ preserveScroll: true });
    refreshAcceptedLoreBulkToolbar();
    refreshHeader();
    refreshLoreWorkbench();
    if (count) toast(`Updated ${count} accepted lore entr${count === 1 ? 'y' : 'ies'}.`, 'success');
    return count > 0;
}

function bulkSetAcceptedPinned(ids, pinned) {
    const state = getState();
    if (!state.loreSelection) state.loreSelection = { pinnedIds: [], suppressedIds: [] };
    const beforeTimeline = captureLoreTimelineState(state);
    const idSet = new Set(ids);
    const acceptedIds = new Set(normalizeLoreMatrix(state.loreMatrix || []).map(entry => entry.id));
    const pinSet = new Set((state.loreSelection.pinnedIds || []).filter(id => acceptedIds.has(id)));
    const suppressedSet = new Set((state.loreSelection.suppressedIds || []).filter(id => acceptedIds.has(id)));
    for (const id of idSet) {
        if (!acceptedIds.has(id)) continue;
        if (pinned) {
            pinSet.add(id);
            suppressedSet.delete(id);
        } else {
            pinSet.delete(id);
        }
    }
    state.loreSelection.pinnedIds = Array.from(pinSet);
    state.loreSelection.suppressedIds = Array.from(suppressedSet);
    recordLoreTimelineEvent(state, {
        before: beforeTimeline,
        after: captureLoreTimelineState(state),
        type: pinned ? 'pin' : 'unpin',
        source: 'manual',
        summary: `${pinned ? 'Pinned' : 'Unpinned'} ${idSet.size} accepted lore entr${idSet.size === 1 ? 'y' : 'ies'}.`,
    });
    saveState(state);
    refreshAcceptedLoreList({ preserveScroll: true });
    refreshAcceptedLoreBulkToolbar();
    refreshHeader();
    refreshLoreWorkbench();
    toast(`${pinned ? 'Pinned' : 'Unpinned'} ${idSet.size} accepted lore entr${idSet.size === 1 ? 'y' : 'ies'}.`, 'success');
}

function bulkSetAcceptedMuted(ids, muted) {
    const state = getState();
    if (!state.loreSelection) state.loreSelection = { pinnedIds: [], suppressedIds: [] };
    const beforeTimeline = captureLoreTimelineState(state);
    const idSet = new Set(ids);
    const acceptedIds = new Set(normalizeLoreMatrix(state.loreMatrix || []).map(entry => entry.id));
    const pinSet = new Set((state.loreSelection.pinnedIds || []).filter(id => acceptedIds.has(id)));
    const suppressedSet = new Set((state.loreSelection.suppressedIds || []).filter(id => acceptedIds.has(id)));
    for (const id of idSet) {
        if (!acceptedIds.has(id)) continue;
        if (muted) {
            suppressedSet.add(id);
            pinSet.delete(id);
        } else {
            suppressedSet.delete(id);
        }
    }
    state.loreSelection.pinnedIds = Array.from(pinSet);
    state.loreSelection.suppressedIds = Array.from(suppressedSet);
    recordLoreTimelineEvent(state, {
        before: beforeTimeline,
        after: captureLoreTimelineState(state),
        type: muted ? 'mute' : 'unmute',
        source: 'manual',
        summary: `${muted ? 'Muted' : 'Unmuted'} ${idSet.size} accepted lore entr${idSet.size === 1 ? 'y' : 'ies'}.`,
    });
    saveState(state);
    refreshAcceptedLoreList({ preserveScroll: true });
    refreshAcceptedLoreBulkToolbar();
    refreshHeader();
    refreshLoreWorkbench();
    toast(`${muted ? 'Muted' : 'Unmuted'} ${idSet.size} accepted lore entr${idSet.size === 1 ? 'y' : 'ies'}.`, 'success');
}

function bulkAddTagToAcceptedLore(ids, tag) {
    const clean = normalizeTag(tag);
    if (!clean) return false;
    return bulkUpdateAcceptedLore(ids, entry => {
        const tags = Array.isArray(entry.tags) ? entry.tags.map(normalizeTag).filter(Boolean) : [];
        const exists = tags.some(t => t.toLowerCase() === clean.toLowerCase());
        return { ...entry, tags: exists ? tags : [...tags, clean] };
    });
}

function bulkDeleteAcceptedLore(ids) {
    const state = getState();
    const beforeTimeline = captureLoreTimelineState(state);
    const idSet = new Set(ids);
    const before = Array.isArray(state.loreMatrix) ? state.loreMatrix.length : 0;
    state.loreMatrix = normalizeLoreMatrix(state.loreMatrix || []).filter(entry => !idSet.has(entry.id));
    const acceptedIds = new Set(state.loreMatrix.map(entry => entry.id));
    if (state.loreSelection) {
        state.loreSelection.pinnedIds = (state.loreSelection.pinnedIds || []).filter(id => acceptedIds.has(id));
        state.loreSelection.suppressedIds = (state.loreSelection.suppressedIds || []).filter(id => acceptedIds.has(id));
    }
    if (state.lorePanel) {
        state.lorePanel.acceptedSelectedIds = (state.lorePanel.acceptedSelectedIds || []).filter(id => acceptedIds.has(id));
        if (idSet.has(state.lorePanel.selectedEntryId)) state.lorePanel.selectedEntryId = '';
    }
    const deleted = before - state.loreMatrix.length;
    if (deleted > 0) {
        recordLoreTimelineEvent(state, {
            before: beforeTimeline,
            after: captureLoreTimelineState(state),
            type: 'delete',
            source: 'manual',
            summary: `Deleted ${deleted} accepted lore entr${deleted === 1 ? 'y' : 'ies'}.`,
        });
    }
    saveState(state);
    refreshAcceptedLoreList({ preserveScroll: true });
    refreshAcceptedLoreBulkToolbar();
    refreshHeader();
    refreshLoreWorkbench();
    toast(`Deleted ${deleted} accepted lore entr${deleted === 1 ? 'y' : 'ies'}.`, 'success');
}

function createEditableLoreEntryEditor(entry) {
    const editor = document.createElement('div');
    editor.className = 'wandlight-lore-entry-editor';
    addTooltip(editor, 'Edit accepted lore directly. Changes are saved only when you click Save Entry.');

    const makeField = (labelText, value, multiline = false) => {
        const label = document.createElement('label');
        label.className = 'wandlight-lore-editor-field';
        const span = document.createElement('span');
        span.textContent = labelText;
        label.appendChild(span);
        const input = multiline ? document.createElement('textarea') : document.createElement('input');
        input.className = multiline ? 'wandlight-lore-editor-textarea' : 'wandlight-lore-editor-input';
        if (!multiline) input.type = 'text';
        input.value = value || '';
        input.addEventListener('click', e => e.stopPropagation());
        input.addEventListener('mousedown', e => e.stopPropagation());
        label.appendChild(input);
        editor.appendChild(label);
        return input;
    };

    const titleInput = makeField('Title', entry.title || '', false);
    const factInput = makeField('Lore text / fact', entry.fact || entry.content?.fact || '', true);
    const injectionInput = makeField('Injection override', entry.content?.injection || '', true);
    const notesInput = makeField('Notes', entry.notes || entry.content?.notes || '', true);
    const metaGrid = document.createElement('div');
    metaGrid.className = 'wandlight-new-lore-meta-grid wandlight-lore-editor-meta-grid';
    editor.appendChild(metaGrid);
    const categorySelect = createNewLoreSelect(metaGrid, 'Category', getLoreRegistryValues('categories', LORE_CATEGORY_VALUES), entry.category || 'other');
    const canonSelect = createNewLoreSelect(metaGrid, 'Canon', getLoreRegistryValues('canonStatuses', ['canon', 'au']), entry.canon || entry.canonStatus || 'canon');
    const relevanceSelect = createNewLoreSelect(metaGrid, 'Relevance', LORE_RELEVANCE_TIERS, entry.relevance || 'normal', value => RELEVANCE_META[value]?.label || value);
    const prioritySelect = createNewLoreSelect(metaGrid, 'Priority', LORE_PRIORITY_VALUES.map(String), String(entry.priority || 50));
    const truthSelect = createNewLoreSelect(metaGrid, 'Truth', getLoreRegistryValues('truthStatuses', ['true', 'rumor', 'contested', 'hidden']), entry.truthStatus || 'true');
    const revealSelect = createNewLoreSelect(metaGrid, 'Reveal', getLoreRegistryValues('revealPolicies', ['private', 'public', 'do_not_reveal']), entry.revealPolicy || 'private');
    const tagsInput = makeField('Tags', (entry.tags || []).join(', '), false);

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions';
    const saveBtn = createButton('Save Entry', 'Saves the edited title, lore text, injection override, and notes for this accepted lore entry.', (btn, e) => {
        e?.stopPropagation?.();
        const title = titleInput.value.trim() || entry.title || '(Untitled lore)';
        const fact = factInput.value.trim();
        const injection = injectionInput.value.trim();
        const notes = notesInput.value.trim();
        updateLoreEntryById(entry.id, raw => ({
            ...raw,
            title,
            fact,
            notes,
            category: categorySelect.value,
            canon: canonSelect.value,
            canonStatus: canonSelect.value,
            relevance: normalizeLoreRelevance(relevanceSelect.value),
            priority: Number(prioritySelect.value) || 50,
            truthStatus: truthSelect.value,
            revealPolicy: revealSelect.value,
            tags: tagsInput.value,
            content: {
                ...(raw.content || {}),
                fact,
                injection,
                notes,
            },
            userEdited: true,
        }), { deferSave: false });
        if (!refreshAcceptedLoreRow(entry.id)) refreshAcceptedLoreList({ preserveScroll: true });
        refreshHeader();
        refreshLoreWorkbench();
        toast('Lore entry saved.', 'success');
    }, 'wandlight-primary-button');
    actions.appendChild(saveBtn);
    editor.appendChild(actions);
    return editor;
}

// Lore tab --------------------------------------------------------------------

function renderLoreTab(container, state) {
    const basic = isBasicExperience();
    container.appendChild(createSectionHeader(
        'Lore',
        'Suggest canon lore from the local database, generate story-specific lore with the model, review pending entries, and manage accepted lore.'
    ));
    container.appendChild(createLoreTimelineCard(state));

    const generationSection = createCollapsibleSection(
        'lore.generation',
        'Lore Generation',
        'canon suggestions + story generation',
        true,
        createLoreGenerationCard(state),
        { tooltip: 'Suggest canon lore from the local database or generate story-specific lore from recent chat messages.', className: 'wandlight-lore-generation-collapsible' }
    );
    markTourTarget(generationSection, 'lore.generation.section');
    container.appendChild(generationSection);

    if (!isBasicExperience()) {
        const autoRelevanceSection = createCollapsibleSection(
            'lore.autoRelevance',
            'Auto-Relevance',
            getSettings().autoRelevanceEnabled ? `every ${getSettings().autoRelevanceEveryTurns || 5} turns` : 'off',
            false,
            createAutoRelevanceCard(state),
            { tooltip: 'Automatically promotes or demotes accepted lore between High, Normal, and Low relevance tiers.' }
        );
        markTourTarget(autoRelevanceSection, 'lore.autoRelevance');
        container.appendChild(autoRelevanceSection);
    }

    const pendingCount = (state?.pendingLoreEntries || []).length;
    const pendingSection = createCollapsibleSection(
        basic ? 'lore.basic.pendingReview' : 'lore.pendingReview',
        'Pending Lore Review',
        pendingCount ? `${pendingCount} pending` : 'none',
        basic ? true : pendingCount > 0,
        createPendingLoreReviewSection(state),
        { tooltip: 'Review suggested/generated lore entries before accepting them.', className: 'wandlight-lore-pending-collapsible' }
    );
    markTourTarget(pendingSection, 'lore.pending');
    container.appendChild(pendingSection);

    const loreState = getPanelLoreState(state);
    const acceptedCount = Math.max(0, (loreState.counts?.all || 0) - (loreState.counts?.pending || 0));
    const injectableCount = getSelectedLoreInjectionCount(state, getSettings());
    const acceptedSection = createCollapsibleSection(
        basic ? 'lore.basic.acceptedEntries' : 'lore.acceptedEntries',
        'Accepted Lore Entries',
        `${acceptedCount} accepted · ${injectableCount} injectable`,
        true,
        createAcceptedLoreEntriesSection(state),
        { tooltip: 'Search, filter, bulk edit, tag, pin, mute, and edit accepted lore entries.', className: 'wandlight-lore-accepted-collapsible' }
    );
    markTourTarget(acceptedSection, 'lore.accepted');
    container.appendChild(acceptedSection);
}

function createLoreTimelineCard(state) {
    const basic = isBasicExperience();
    const summary = getLoreTimelineSummary(state);
    const counts = summary.counts || {};
    const latest = summary.latest;
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card wandlight-lore-timeline-card';
    markTourTarget(card, 'lore.timeline');

    const top = document.createElement('div');
    top.className = 'wandlight-lore-timeline-card-top';
    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = basic ? 'Lore Tools' : 'Lore Timeline';
    addTooltip(title, basic ? 'Create manual lore and review suggested/generated entries below.' : 'Story-aware audit trail for accepted lore changes and recoverable lore versions.');
    top.appendChild(title);
    if (!basic) {
        top.appendChild(createStatusPill(summary.eventCount ? `${summary.eventCount} events` : 'No events', 'Lore timeline event count for this chat.'));
    }
    card.appendChild(top);

    if (!basic) {
        const stats = document.createElement('div');
        stats.className = 'wandlight-lore-timeline-stats';
        stats.appendChild(createCompactPresetStat('Added', `+${counts.added || 0}`));
        stats.appendChild(createCompactPresetStat('Deleted', `-${counts.deleted || 0}`));
        stats.appendChild(createCompactPresetStat('Updated', String(counts.updated || 0)));
        stats.appendChild(createCompactPresetStat('Restored', String(counts.restored || 0)));
        card.appendChild(stats);

        const rail = document.createElement('div');
        rail.className = 'wandlight-lore-timeline-mini-rail';
        const events = getLoreTimelineEvents(state).slice(-18);
        if (events.length) {
            for (const event of events) {
                const tick = document.createElement('span');
                tick.className = `wandlight-lore-timeline-mini-tick ${getLoreTimelineEventClass(event)}`.trim();
                addTooltip(tick, event.summary || event.type);
                rail.appendChild(tick);
            }
        } else {
            const empty = document.createElement('span');
            empty.className = 'wandlight-lore-timeline-mini-empty';
            empty.textContent = 'No accepted-lore changes recorded yet.';
            rail.appendChild(empty);
        }
        card.appendChild(rail);
    }

    const foot = document.createElement('div');
    foot.className = 'wandlight-lore-timeline-card-foot';
    const latestText = document.createElement('div');
    latestText.className = 'wandlight-lore-timeline-latest';
    latestText.textContent = basic
        ? 'Create a manual lore draft, or use the generation tools below to add reviewable lore.'
        : (latest ? `Last: ${latest.summary || latest.type}` : 'Manual creations, accepted lore changes, and recoveries will appear here.');
    foot.appendChild(latestText);
    const actions = document.createElement('div');
    actions.className = 'wandlight-lore-timeline-actions';
    actions.appendChild(markTourTarget(createButton('New Lore', 'Create a manual lore draft in Pending Lore Review.', () => {
        openNewLoreDialog();
    }, 'wandlight-primary-button'), 'lore.new'));
    if (!basic) {
        actions.appendChild(markTourTarget(createButton('Open Timeline', 'Open the full Lore Timeline workbench.', () => {
            openLoreTimeline();
        }), 'lore.timeline.open'));
    }
    foot.appendChild(actions);
    card.appendChild(foot);
    return card;
}

function getLoreTimelineEventClass(event = {}) {
    const counts = event.counts || {};
    if (counts.deleted > 0 || /delete|remove/i.test(event.type || '')) return 'wandlight-lore-timeline-event-delete';
    if (counts.restored > 0 || /restore|recover/i.test(event.type || '')) return 'wandlight-lore-timeline-event-restore';
    if (counts.updated > 0 || counts.pinned > 0 || counts.muted > 0 || /edit|relevance|pin|mute|metadata/i.test(event.type || '')) return 'wandlight-lore-timeline-event-update';
    if (counts.pending > 0 || /pending|generate/i.test(event.type || '')) return 'wandlight-lore-timeline-event-pending';
    return 'wandlight-lore-timeline-event-add';
}

function openLoreTimeline() {
    loreTimelineOpen = true;
    const events = getLoreTimelineEvents(getState());
    if (!loreTimelineSelectedId || !events.some(event => event.id === loreTimelineSelectedId)) {
        loreTimelineSelectedId = events[events.length - 1]?.id || '';
    }
    renderLoreTimeline();
}

function closeLoreTimeline() {
    loreTimelineOpen = false;
    const existing = document.getElementById(LORE_TIMELINE_ID);
    existing?.remove();
}

function refreshLoreTimeline() {
    if (loreTimelineOpen) renderLoreTimeline();
}

function renderLoreTimeline() {
    if (!loreTimelineOpen) return;
    hideContinuityTooltip();
    let overlay = document.getElementById(LORE_TIMELINE_ID);
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = LORE_TIMELINE_ID;
        overlay.className = 'wandlight-lore-timeline-overlay';
        document.body.appendChild(overlay);
    }
    overlay.replaceChildren();

    const state = getState();
    const events = getLoreTimelineEvents(state);
    const summary = getLoreTimelineSummary(state);
    const model = buildLoreTimelineVisualizerModel(state, events);
    ensureLoreTimelineViewport(model.messages.length);
    const selected = events.find(event => event.id === loreTimelineSelectedId) || events[events.length - 1] || null;
    if (selected) loreTimelineSelectedId = selected.id;
    const selectedNode = model.nodes.find(node => node.event.id === loreTimelineSelectedId) || null;
    const visibleNodes = model.nodes.filter(node => isLoreTimelineFilterActive(node.type));
    const visibleEventIds = new Set(visibleNodes.map(node => node.event.id));

    const shell = document.createElement('div');
    shell.className = 'wandlight-lore-timeline-shell';
    overlay.appendChild(shell);

    shell.appendChild(createLoreTimelineFilterBar(model, summary));

    const stage = document.createElement('div');
    stage.className = 'wandlight-continuity-stage';
    shell.appendChild(stage);

    const graphWrap = document.createElement('div');
    graphWrap.className = 'wandlight-continuity-graph-wrap';
    graphWrap.appendChild(createLoreTimelineGraph(model, visibleNodes, selectedNode));
    graphWrap.appendChild(createLoreTimelineRuler(model));
    graphWrap.appendChild(createLoreTimelineMinimap(model, visibleNodes));
    graphWrap.appendChild(createLoreTimelineGraphControls(model));
    stage.appendChild(graphWrap);

    stage.appendChild(createLoreTimelineLegend(model, visibleNodes, summary));

    const body = document.createElement('div');
    body.className = 'wandlight-lore-timeline-body wandlight-continuity-detail-body';
    shell.appendChild(body);

    const list = document.createElement('div');
    list.className = 'wandlight-lore-timeline-event-list';
    const listedEvents = [...events].reverse().filter(event => !model.nodes.length || visibleEventIds.has(event.id));
    if (!events.length) {
        list.appendChild(createEmptyMessage('No lore timeline events yet. Create, accept, edit, or delete lore to begin the audit trail.'));
    } else if (!listedEvents.length) {
        list.appendChild(createEmptyMessage('No lore nodes match the active filters.'));
    } else {
        for (const event of listedEvents) {
            list.appendChild(createLoreTimelineEventRow(event, event.id === loreTimelineSelectedId));
        }
    }
    body.appendChild(list);

    const detail = document.createElement('div');
    detail.className = 'wandlight-lore-timeline-detail';
    detail.appendChild(createLoreTimelineEventDetail(selected));
    body.appendChild(detail);
}

function createLoreTimelineFilterBar(model, summary) {
    const bar = document.createElement('div');
    bar.className = 'wandlight-continuity-filter-bar';

    const heading = document.createElement('div');
    heading.className = 'wandlight-continuity-heading';
    const label = document.createElement('div');
    label.className = 'wandlight-continuity-filter-label';
    label.textContent = 'Lore Timeline Visualizer';
    heading.appendChild(label);
    const status = document.createElement('div');
    status.className = 'wandlight-continuity-status';
    status.textContent = `${summary.eventCount || 0} lore nodes | +${summary.counts.added || 0} added | -${summary.counts.deleted || 0} deleted | ${summary.counts.updated || 0} updated`;
    heading.appendChild(status);
    bar.appendChild(heading);

    const chips = document.createElement('div');
    chips.className = 'wandlight-continuity-filter-chips';
    for (const filter of LORE_TIMELINE_NODE_FILTERS) {
        const count = model.nodes.filter(node => node.type === filter.id).length;
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'wandlight-continuity-filter-chip';
        if (isLoreTimelineFilterActive(filter.id)) chip.classList.add('wandlight-continuity-filter-chip-active');
        chip.style.setProperty('--wl-chip-color', filter.color);
        chip.textContent = `${filter.short} ${filter.label}${count ? ` ${count}` : ''}`;
        addTooltip(chip, `Toggle ${filter.label} nodes in the timeline graph.`);
        chip.addEventListener('click', () => {
            if (isLoreTimelineFilterActive(filter.id)) loreTimelineActiveFilters.delete(filter.id);
            else loreTimelineActiveFilters.add(filter.id);
            renderLoreTimeline();
        });
        chips.appendChild(chip);
    }
    bar.appendChild(chips);

    const actions = document.createElement('div');
    actions.className = 'wandlight-continuity-header-actions';
    actions.appendChild(createButton('New Lore', 'Create a manual lore draft in Pending Lore Review.', () => openNewLoreDialog(), 'wandlight-primary-button'));
    actions.appendChild(createButton('Close', 'Close Lore Timeline.', closeLoreTimeline));
    bar.appendChild(actions);
    return bar;
}

function isLoreTimelineFilterActive(type) {
    if (!(loreTimelineActiveFilters instanceof Set)) {
        loreTimelineActiveFilters = new Set(LORE_TIMELINE_NODE_FILTERS.map(filter => filter.id));
    }
    return loreTimelineActiveFilters.has(type);
}

function buildLoreTimelineVisualizerModel(state, events) {
    const messages = buildLoreTimelineMessages(events);
    const senderMap = new Map();
    for (const message of messages) {
        if (!senderMap.has(message.senderId)) {
            senderMap.set(message.senderId, {
                id: message.senderId,
                name: message.senderName,
                type: message.senderType,
                color: resolveLoreTimelineSenderColor(message.senderId, message.senderType, senderMap.size),
            });
        }
    }
    for (const message of messages) {
        message.color = senderMap.get(message.senderId)?.color || '#f2e2bd';
    }
    const messageCount = Math.max(1, messages.length);
    const nodes = events.map((event, index) => createLoreTimelineNode(event, index, messageCount));
    const connections = buildLoreTimelineConnections(nodes);
    const milestones = buildLoreTimelineMilestones(state, messageCount);
    const wordStats = computeTimelineWordStats(messages);
    return {
        messages,
        senders: Array.from(senderMap.values()),
        nodes,
        connections,
        milestones,
        maxWordCount: wordStats.max,
        wordScaleMax: wordStats.scaleMax,
        wordStats,
    };
}

function computeTimelineWordStats(messages = []) {
    const values = messages
        .map(message => Math.max(1, Number(message.wordCount) || 1))
        .sort((a, b) => a - b);
    if (!values.length) return { max: 1, median: 1, p90: 1, p95: 1, average: 1, scaleMax: 1 };
    const percentile = pct => values[Math.min(values.length - 1, Math.max(0, Math.floor((values.length - 1) * pct)))];
    const max = values[values.length - 1];
    const median = percentile(0.5);
    const p90 = percentile(0.9);
    const p95 = percentile(0.95);
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    const robustCap = Math.max(40, p95, median * 2.5, average * 1.5);
    return {
        max,
        median,
        p90,
        p95,
        average,
        scaleMax: Math.max(1, Math.min(max, Math.round(robustCap))),
    };
}

function buildLoreTimelineMessages(events = []) {
    const chat = getSillyTavernChatMessages();
    if (chat.length) {
        return chat.map((message, index) => {
            const text = getTimelineMessageText(message);
            const header = extractTimelineWandlightHeader(text);
            const sampleText = header?.body || text;
            const sender = getTimelineMessageSender(message, index);
            return {
                id: String(message?.id || message?.swipe_id || `message_${index + 1}`),
                index: index + 1,
                senderId: sender.id,
                senderName: sender.name,
                senderType: sender.type,
                wordCount: countTimelineWords(sampleText),
                preview: compactTimelineText(sampleText, 260),
                detectedDateTime: header?.dateTime || '',
                timestamp: message?.send_date || message?.extra?.timestamp || '',
            };
        });
    }
    const maxAnchor = Math.max(1, ...events.map(event => Number(event.messageRange?.latest || event.messageRange?.end || event.messageRange?.start) || 0));
    return Array.from({ length: maxAnchor }, (_, index) => ({
        id: `message_${index + 1}`,
        index: index + 1,
        senderId: 'unknown',
        senderName: 'Unknown / Offline',
        senderType: 'system',
        wordCount: 1,
        preview: 'Chat message unavailable in this context.',
        detectedDateTime: '',
        timestamp: '',
    }));
}

function getSillyTavernChatMessages() {
    try {
        if (typeof SillyTavern === 'undefined' || typeof SillyTavern.getContext !== 'function') return [];
        const chat = SillyTavern.getContext()?.chat;
        return Array.isArray(chat) ? chat : [];
    } catch (_) {
        return [];
    }
}

function getTimelineMessageText(message) {
    for (const value of [message?.mes, message?.message, message?.text, message?.content]) {
        if (typeof value === 'string' && value.trim()) return value;
    }
    return '';
}

function extractTimelineWandlightHeader(text) {
    const raw = String(text || '');
    const match = raw.match(/^\s*\*?\s*([A-Za-z]+,\s+[A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})\s*\|\s*(\d{1,2}:\d{2}\s*(?:AM|PM))\s*\|[^*\n]*(?:\*|\n|$)/i);
    if (!match) return null;
    const headerText = match[0];
    const body = raw.slice(headerText.length).replace(/^\s+/, '');
    return {
        date: match[1].trim(),
        time: match[2].trim(),
        dateTime: `${match[1].trim()} | ${match[2].trim()}`,
        body,
    };
}

function getTimelineMessageSender(message, index) {
    if (message?.is_user) return { id: 'user', name: 'You', type: 'user' };
    const rawName = String(message?.name || message?.ch_name || '').trim();
    if (rawName && !isTimelineSystemSenderName(rawName)) {
        const key = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'story';
        const type = /narrator|story/i.test(rawName) ? 'narrator' : 'character';
        return { id: `${type}:${key}`, name: rawName, type };
    }
    if (message?.is_system || message?.extra?.type === 'system') return { id: 'system', name: rawName || 'System', type: 'system' };
    const name = rawName || (index === 0 ? 'Narrator / Story' : 'Story');
    const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'story';
    const type = /narrator|story/i.test(name) ? 'narrator' : 'character';
    return { id: `${type}:${key}`, name, type };
}

function isTimelineSystemSenderName(name) {
    return /^(system|lore engine|wandlight|wandlight continuity)$/i.test(String(name || '').trim());
}

function countTimelineWords(text) {
    return String(text || '').trim().split(/\s+/).filter(Boolean).length || 1;
}

function compactTimelineText(text, max = 160) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (clean.length <= max) return clean;
    return `${clean.slice(0, Math.max(0, max - 3))}...`;
}

function resolveLoreTimelineSenderColor(senderId, senderType, ordinal) {
    if (senderType === 'user') return '#f2e2bd';
    if (senderType === 'narrator') return '#3f8bdc';
    if (senderType === 'system') return '#8169d8';
    const hash = hashTimelineString(senderId);
    return LORE_TIMELINE_SENDER_PALETTE[(hash + ordinal) % LORE_TIMELINE_SENDER_PALETTE.length] || '#d0b05e';
}

function hashTimelineString(value) {
    const text = String(value || '');
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
}

function createLoreTimelineNode(event, ordinal, messageCount) {
    const messageIndex = clampMessageIndex(Number(event.messageRange?.latest || event.messageRange?.end || event.messageRange?.start) || messageCount, messageCount);
    const type = classifyLoreTimelineNodeType(event);
    const filter = LORE_TIMELINE_NODE_FILTERS.find(item => item.id === type) || LORE_TIMELINE_NODE_FILTERS[1];
    const counts = event.counts || {};
    const weight = Math.max(1, counts.added || 0, counts.deleted || 0, counts.updated || 0, counts.pending || 0, counts.restored || 0);
    const lane = ordinal % 2 === 0 ? -1 : 1;
    return {
        id: event.id,
        event,
        type,
        label: filter.label,
        short: filter.short,
        color: filter.color,
        messageIndex,
        importance: Math.max(1, Math.min(5, Math.ceil(Math.sqrt(weight)))),
        lane,
        refs: Array.isArray(event.refs) ? event.refs : [],
    };
}

function classifyLoreTimelineNodeType(event = {}) {
    const type = String(event.type || '').toLowerCase();
    const source = String(event.source || '').toLowerCase();
    const refs = Array.isArray(event.refs) ? event.refs : [];
    const categories = refs.map(ref => String(ref.category || '').toLowerCase());
    if (/restore|recover|resolved/.test(type)) return 'resolved_continuity';
    if (/delete|remove|diverg/.test(type)) return 'canon_divergence';
    if (/canon/.test(type) || /canon/.test(source) || refs.some(ref => ref.canon === 'canon')) return 'canon_lore';
    if (categories.some(category => ['relationship', 'faction'].includes(category))) return 'relationship_change';
    if (categories.some(category => ['location', 'place'].includes(category))) return 'location_lore';
    if (categories.some(category => ['timeline', 'event'].includes(category))) return 'timeline_event';
    if (categories.some(category => ['character', 'knowledge', 'secret'].includes(category))) return 'character_knowledge';
    if (categories.some(category => ['item', 'artifact', 'spell', 'object'].includes(category))) return 'object_lore';
    if (/relevance|knowledge|pin|mute|edit|metadata/.test(type)) return 'character_knowledge';
    return 'story_lore';
}

function buildLoreTimelineConnections(nodes) {
    const connections = [];
    const lastByRef = new Map();
    for (const node of nodes) {
        const refIds = node.refs.map(ref => ref.id).filter(Boolean);
        for (const refId of refIds) {
            const prior = lastByRef.get(refId);
            if (prior && prior.id !== node.id) {
                connections.push({
                    id: `${prior.id}_${node.id}_${refId}`,
                    sourceId: prior.id,
                    targetId: node.id,
                    relation: node.type === 'canon_divergence' ? 'contradicts' : node.type === 'resolved_continuity' ? 'resolves' : 'updates',
                    strength: 0.72,
                });
            }
            lastByRef.set(refId, node);
        }
    }
    return connections.slice(-80);
}

function buildLoreTimelineMilestones(state, messageCount) {
    const context = state?.loreContext || {};
    const milestones = [
        { id: 'start', label: 'Start', messageIndex: 1 },
    ];
    if (messageCount >= 300) milestones.push({ id: 'act_i', label: 'Act I', messageIndex: Math.max(1, Math.round(messageCount * 0.2)) });
    if (messageCount >= 900) milestones.push({ id: 'midpoint', label: 'Midpoint', messageIndex: Math.max(1, Math.round(messageCount * 0.5)) });
    if (context.sceneDate) milestones.push({ id: 'scene_date', label: context.sceneDate, messageIndex: Math.max(1, Math.round(messageCount * 0.75)) });
    milestones.push({ id: 'current', label: 'Current', messageIndex: messageCount });
    return milestones;
}

function ensureLoreTimelineViewport(messageCount) {
    const total = Math.max(1, messageCount || 1);
    if (!loreTimelineViewport || !Number.isFinite(loreTimelineViewport.start) || !Number.isFinite(loreTimelineViewport.end)) {
        const span = Math.min(total, LORE_TIMELINE_DEFAULT_VIEW_MESSAGES);
        loreTimelineViewport = { start: Math.max(1, total - span + 1), end: total };
        return;
    }
    setLoreTimelineViewport(loreTimelineViewport.start, loreTimelineViewport.end, total);
}

function setLoreTimelineViewport(start, end, messageCount) {
    const total = Math.max(1, messageCount || 1);
    const requestedStart = Math.round(start);
    const requestedEnd = Math.round(end);
    let span = Math.max(LORE_TIMELINE_MIN_VIEW_MESSAGES, requestedEnd - requestedStart + 1);
    span = Math.min(total, span);
    let nextStart = requestedStart;
    if (nextStart < 1) nextStart = 1;
    if (nextStart + span - 1 > total) nextStart = Math.max(1, total - span + 1);
    const nextEnd = Math.min(total, nextStart + span - 1);
    loreTimelineViewport = { start: nextStart, end: nextEnd };
}

function keepLoreTimelineIndexVisible(index, messageCount) {
    ensureLoreTimelineViewport(messageCount);
    const current = loreTimelineViewport;
    if (!current || (index >= current.start && index <= current.end)) return;
    const span = current.end - current.start + 1;
    const start = Math.round(index - span / 2);
    setLoreTimelineViewport(start, start + span - 1, messageCount);
}

function panLoreTimeline(delta, messageCount) {
    ensureLoreTimelineViewport(messageCount);
    const span = loreTimelineViewport.end - loreTimelineViewport.start + 1;
    setLoreTimelineViewport(loreTimelineViewport.start + delta, loreTimelineViewport.start + delta + span - 1, messageCount);
}

function zoomLoreTimeline(factor, messageCount, anchorIndex = null) {
    ensureLoreTimelineViewport(messageCount);
    const current = loreTimelineViewport;
    const total = Math.max(1, messageCount || 1);
    const oldSpan = current.end - current.start + 1;
    const newSpan = Math.max(LORE_TIMELINE_MIN_VIEW_MESSAGES, Math.min(total, Math.round(oldSpan * factor)));
    const anchor = anchorIndex || Math.round((current.start + current.end) / 2);
    const ratio = oldSpan <= 1 ? 0.5 : (anchor - current.start) / oldSpan;
    const start = Math.round(anchor - newSpan * ratio);
    setLoreTimelineViewport(start, start + newSpan - 1, total);
}

function clampMessageIndex(value, messageCount) {
    const total = Math.max(1, messageCount || 1);
    return Math.max(1, Math.min(total, Math.round(value) || total));
}

function createLoreTimelineGraph(model, nodes, selectedNode) {
    const svg = createTimelineSvg(1180, 180, 'wandlight-continuity-main-svg', 'xMidYMid meet');
    svg.setAttribute('aria-label', 'Continuity message timeline graph');
    const viewport = loreTimelineViewport || { start: 1, end: Math.max(1, model.messages.length) };
    const width = 1180;
    const height = 180;
    const padX = 44;
    const baselineY = 90;
    const innerWidth = width - padX * 2;
    const visibleSpan = Math.max(1, viewport.end - viewport.start);
    const indexToX = index => padX + ((index - viewport.start) / visibleSpan) * innerWidth;

    svg.appendChild(createTimelineSvgEl('rect', { x: 0, y: 0, width, height, rx: 12, class: 'wandlight-continuity-svg-bg' }));
    svg.appendChild(createTimelineSvgEl('line', { x1: padX, y1: baselineY, x2: width - padX, y2: baselineY, class: 'wandlight-continuity-baseline' }));

    const visibleMessages = model.messages.filter(message => message.index >= viewport.start && message.index <= viewport.end);
    const stride = Math.max(1, Math.ceil(visibleMessages.length / LORE_TIMELINE_MAX_MAIN_TICKS));
    visibleMessages.forEach((message, i) => {
        if (i % stride !== 0) return;
        const x = indexToX(message.index);
        const scaled = Math.sqrt(Math.min(Math.max(1, message.wordCount), model.wordScaleMax || model.maxWordCount) / Math.max(1, model.wordScaleMax || model.maxWordCount));
        const tickHeight = 4 + scaled * 52;
        const line = createTimelineSvgEl('line', {
            x1: x,
            y1: baselineY - tickHeight / 2,
            x2: x,
            y2: baselineY + tickHeight / 2,
            class: 'wandlight-continuity-message-tick',
            style: `--wl-tick-color:${message.color};--wl-tick-width:${Math.min(4, 1 + scaled * 2.4)}px;`,
        });
        svg.appendChild(line);
        const hit = createTimelineSvgEl('line', {
            x1: x,
            y1: baselineY - Math.max(18, tickHeight / 2 + 6),
            x2: x,
            y2: baselineY + Math.max(18, tickHeight / 2 + 6),
            class: 'wandlight-continuity-message-hit',
        });
        hit.addEventListener('mouseenter', event => showTimelineMessageTooltip(event, message));
        hit.addEventListener('mousemove', event => positionContinuityTooltip(event));
        hit.addEventListener('mouseleave', hideContinuityTooltip);
        svg.appendChild(hit);
    });

    const visibleNodeMap = new Map(nodes.filter(node => node.messageIndex >= viewport.start && node.messageIndex <= viewport.end).map(node => [node.id, node]));
    for (const connection of model.connections) {
        const source = visibleNodeMap.get(connection.sourceId);
        const target = visibleNodeMap.get(connection.targetId);
        if (!source || !target) continue;
        const sx = indexToX(source.messageIndex);
        const tx = indexToX(target.messageIndex);
        const sy = getTimelineNodeY(source, baselineY);
        const ty = getTimelineNodeY(target, baselineY);
        const cy = Math.min(sy, ty) - 42;
        svg.appendChild(createTimelineSvgEl('path', {
            d: `M ${sx} ${sy} Q ${(sx + tx) / 2} ${cy} ${tx} ${ty}`,
            class: `wandlight-continuity-connection wandlight-continuity-connection-${connection.relation}`,
        }));
    }

    for (const node of visibleNodeMap.values()) {
        const x = indexToX(node.messageIndex);
        const y = getTimelineNodeY(node, baselineY);
        const radius = 9 + node.importance * 1.5;
        svg.appendChild(createTimelineSvgEl('line', {
            x1: x,
            y1: baselineY,
            x2: x,
            y2: y,
            class: 'wandlight-continuity-node-stem',
            style: `--wl-node-color:${node.color};`,
        }));
        const group = createTimelineSvgEl('g', {
            class: `wandlight-continuity-node ${selectedNode?.id === node.id ? 'wandlight-continuity-node-selected' : ''}`,
            tabindex: '0',
            role: 'button',
            'aria-label': `${node.label}: ${node.event.summary || node.event.type}`,
            style: `--wl-node-color:${node.color};`,
        });
        group.appendChild(createTimelineSvgTitle(`${node.label} | message ${node.messageIndex} | ${node.event.summary || node.event.type}`));
        group.appendChild(createTimelineSvgEl('circle', { cx: x, cy: y, r: radius, class: 'wandlight-continuity-node-ring' }));
        const iconHref = getLoreTimelineNodeIconHref(node.type);
        if (iconHref) {
            group.appendChild(createTimelineSvgEl('image', {
                href: iconHref,
                x: x - radius * 0.58,
                y: y - radius * 0.58,
                width: radius * 1.16,
                height: radius * 1.16,
                class: 'wandlight-continuity-node-image',
                preserveAspectRatio: 'xMidYMid meet',
            }));
        } else {
            const text = createTimelineSvgEl('text', { x, y: y + 4, class: 'wandlight-continuity-node-icon', 'text-anchor': 'middle' });
            text.textContent = node.short;
            group.appendChild(text);
        }
        group.addEventListener('click', () => {
            loreTimelineSelectedId = node.event.id;
            renderLoreTimeline();
        });
        group.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                loreTimelineSelectedId = node.event.id;
                renderLoreTimeline();
            }
        });
        svg.appendChild(group);
    }

    svg.addEventListener('wheel', event => {
        event.preventDefault();
        const rect = svg.getBoundingClientRect();
        const ratio = rect.width ? Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) : 0.5;
        const anchor = Math.round(viewport.start + ratio * Math.max(1, viewport.end - viewport.start));
        if (event.ctrlKey || event.metaKey) zoomLoreTimeline(event.deltaY < 0 ? 0.72 : 1.28, model.messages.length, anchor);
        else panLoreTimeline(Math.round((event.deltaY || event.deltaX || 0) / 30), model.messages.length);
        renderLoreTimeline();
    }, { passive: false });
    return svg;
}

function getLoreTimelineNodeIconHref(type) {
    const path = LORE_TIMELINE_NODE_ICON_PATHS[type] || '';
    return path ? getLocalAssetSrc(path) : '';
}

function getTimelineNodeY(node, baselineY) {
    const laneGap = 32 + Math.min(18, node.importance * 5);
    return baselineY + node.lane * laneGap;
}

function createLoreTimelineRuler(model) {
    const ruler = document.createElement('div');
    ruler.className = 'wandlight-continuity-ruler';
    const viewport = loreTimelineViewport || { start: 1, end: model.messages.length || 1 };
    const span = Math.max(1, viewport.end - viewport.start);
    for (const milestone of model.milestones) {
        if (milestone.messageIndex < viewport.start || milestone.messageIndex > viewport.end) continue;
        const mark = document.createElement('div');
        mark.className = 'wandlight-continuity-ruler-mark';
        mark.style.left = `${((milestone.messageIndex - viewport.start) / span) * 100}%`;
        mark.textContent = `${milestone.label} ${milestone.messageIndex}`;
        ruler.appendChild(mark);
    }
    return ruler;
}

function createLoreTimelineMinimap(model, nodes) {
    const svg = createTimelineSvg(1180, 44, 'wandlight-continuity-minimap-svg', 'none');
    const total = Math.max(1, model.messages.length);
    const width = 1180;
    const height = 44;
    const padX = 28;
    const baselineY = 22;
    const innerWidth = width - padX * 2;
    const indexToX = index => padX + ((index - 1) / Math.max(1, total - 1)) * innerWidth;
    const xToIndex = x => clampMessageIndex(1 + ((Math.max(padX, Math.min(width - padX, x)) - padX) / innerWidth) * Math.max(1, total - 1), total);
    svg.appendChild(createTimelineSvgEl('rect', { x: 0, y: 0, width, height, rx: 10, class: 'wandlight-continuity-minimap-bg' }));
    svg.appendChild(createTimelineSvgEl('line', { x1: padX, y1: baselineY, x2: width - padX, y2: baselineY, class: 'wandlight-continuity-minimap-line' }));

    const stride = Math.max(1, Math.ceil(model.messages.length / LORE_TIMELINE_MAX_MINIMAP_TICKS));
    model.messages.forEach((message, i) => {
        if (i % stride !== 0) return;
        const scaled = Math.sqrt(Math.min(Math.max(1, message.wordCount), model.wordScaleMax || model.maxWordCount) / Math.max(1, model.wordScaleMax || model.maxWordCount));
        const tickHeight = 2 + scaled * 16;
        svg.appendChild(createTimelineSvgEl('line', {
            x1: indexToX(message.index),
            y1: baselineY - tickHeight / 2,
            x2: indexToX(message.index),
            y2: baselineY + tickHeight / 2,
            class: 'wandlight-continuity-minimap-tick',
            style: `--wl-tick-color:${message.color};`,
        }));
    });

    for (const node of nodes) {
        svg.appendChild(createTimelineSvgEl('circle', {
            cx: indexToX(node.messageIndex),
            cy: 7,
            r: 3,
            class: 'wandlight-continuity-minimap-node',
            style: `--wl-node-color:${node.color};`,
        }));
    }

    const viewport = loreTimelineViewport || { start: 1, end: total };
    const vx = indexToX(viewport.start);
    const vw = Math.max(10, indexToX(viewport.end) - vx);
    svg.appendChild(createTimelineSvgEl('rect', { x: vx, y: 4, width: vw, height: 36, rx: 5, class: 'wandlight-continuity-minimap-window' }));
    svg.appendChild(createTimelineSvgEl('rect', { x: vx - 5, y: 5, width: 10, height: 34, rx: 3, class: 'wandlight-continuity-minimap-handle wandlight-continuity-minimap-handle-left' }));
    svg.appendChild(createTimelineSvgEl('rect', { x: vx + vw - 5, y: 5, width: 10, height: 34, rx: 3, class: 'wandlight-continuity-minimap-handle wandlight-continuity-minimap-handle-right' }));

    svg.addEventListener('pointerdown', event => {
        event.preventDefault();
        const rect = svg.getBoundingClientRect();
        const localX = rect.width ? ((event.clientX - rect.left) / rect.width) * width : vx + vw / 2;
        const handleZone = 12;
        const span = viewport.end - viewport.start + 1;
        const pointerIndex = xToIndex(localX);
        const mode = Math.abs(localX - vx) <= handleZone
            ? 'resize-left'
            : Math.abs(localX - (vx + vw)) <= handleZone
                ? 'resize-right'
                : localX >= vx && localX <= vx + vw
                    ? 'drag'
                    : 'center';
        const dragOffset = pointerIndex - viewport.start;
        let lastRender = 0;
        const updateFromClientX = clientX => {
            const currentLocalX = rect.width ? ((clientX - rect.left) / rect.width) * width : vx + vw / 2;
            const index = xToIndex(currentLocalX);
            if (mode === 'resize-left') {
                resizeLoreTimelineViewport('left', index, total);
            } else if (mode === 'resize-right') {
                resizeLoreTimelineViewport('right', index, total);
            } else if (mode === 'drag') {
                const start = index - dragOffset;
                setLoreTimelineViewport(start, start + span - 1, total);
            } else {
                const start = index - Math.floor(span / 2);
                setLoreTimelineViewport(start, start + span - 1, total);
            }
            const now = Date.now();
            if (now - lastRender > 45) {
                lastRender = now;
                renderLoreTimeline();
            }
        };
        const onMove = moveEvent => updateFromClientX(moveEvent.clientX);
        const onUp = upEvent => {
            updateFromClientX(upEvent.clientX);
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            renderLoreTimeline();
        };
        updateFromClientX(event.clientX);
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp, { once: true });
    });
    return svg;
}

function resizeLoreTimelineViewport(edge, index, messageCount) {
    ensureLoreTimelineViewport(messageCount);
    const total = Math.max(1, messageCount || 1);
    const current = loreTimelineViewport || { start: 1, end: total };
    if (edge === 'left') {
        const start = Math.min(index, current.end - LORE_TIMELINE_MIN_VIEW_MESSAGES + 1);
        setLoreTimelineViewport(start, current.end, total);
    } else {
        const end = Math.max(index, current.start + LORE_TIMELINE_MIN_VIEW_MESSAGES - 1);
        setLoreTimelineViewport(current.start, end, total);
    }
}

function createLoreTimelineGraphControls(model) {
    const controls = document.createElement('div');
    controls.className = 'wandlight-continuity-graph-controls';
    controls.appendChild(createButton('Fit', 'Show the full message timeline.', () => {
        setLoreTimelineViewport(1, model.messages.length || 1, model.messages.length || 1);
        renderLoreTimeline();
    }, 'wandlight-small-button'));
    controls.appendChild(createButton('+', 'Zoom into the current timeline range.', () => {
        zoomLoreTimeline(0.7, model.messages.length || 1);
        renderLoreTimeline();
    }, 'wandlight-small-button wandlight-continuity-zoom-button'));
    controls.appendChild(createButton('-', 'Zoom out from the current timeline range.', () => {
        zoomLoreTimeline(1.35, model.messages.length || 1);
        renderLoreTimeline();
    }, 'wandlight-small-button wandlight-continuity-zoom-button'));
    controls.appendChild(createButton('Current', 'Jump to the latest messages.', () => {
        const total = model.messages.length || 1;
        const span = Math.min(total, loreTimelineViewport ? loreTimelineViewport.end - loreTimelineViewport.start + 1 : LORE_TIMELINE_DEFAULT_VIEW_MESSAGES);
        setLoreTimelineViewport(total - span + 1, total, total);
        renderLoreTimeline();
    }, 'wandlight-small-button wandlight-primary-button'));
    return controls;
}

function createLoreTimelineLegend(model, visibleNodes, summary) {
    const legend = document.createElement('div');
    legend.className = 'wandlight-continuity-legend';
    legend.appendChild(createContinuityMetric('Messages', formatInteger(model.messages.length), 'Total'));
    legend.appendChild(createContinuityMetric('Lore Nodes', formatInteger(visibleNodes.length), `${summary.eventCount || 0} total`));

    const senderBox = document.createElement('div');
    senderBox.className = 'wandlight-continuity-legend-box';
    const senderTitle = document.createElement('div');
    senderTitle.className = 'wandlight-continuity-legend-title';
    senderTitle.textContent = 'Sender Color';
    senderBox.appendChild(senderTitle);
    for (const sender of model.senders.slice(0, 9)) {
        const row = document.createElement('div');
        row.className = 'wandlight-continuity-legend-row';
        row.style.setProperty('--wl-sender-color', sender.color);
        row.appendChild(document.createElement('span')).className = 'wandlight-continuity-legend-dot';
        const text = document.createElement('span');
        text.textContent = sender.name;
        row.appendChild(text);
        senderBox.appendChild(row);
    }
    legend.appendChild(senderBox);

    const scaleBox = document.createElement('div');
    scaleBox.className = 'wandlight-continuity-legend-box';
    const scaleTitle = document.createElement('div');
    scaleTitle.className = 'wandlight-continuity-legend-title';
    scaleTitle.textContent = 'Daily Writing Volume';
    scaleBox.appendChild(scaleTitle);
    const scale = document.createElement('div');
    scale.className = 'wandlight-continuity-day-volume';
    const bins = buildDailyWritingBins(model.messages);
    const maxTotal = Math.max(1, ...bins.map(bin => bin.words || 0));
    const labelStride = Math.max(1, Math.ceil(bins.length / 5));
    const strip = document.createElement('div');
    strip.className = 'wandlight-continuity-day-volume-strip';
    strip.style.minWidth = `${Math.max(100, bins.length * 8)}px`;
    bins.forEach((bin, idx) => {
        const binEl = document.createElement('div');
        binEl.className = 'wandlight-continuity-day-volume-bin';
        const bar = document.createElement('span');
        const scaled = Math.sqrt((bin.words || 0) / maxTotal);
        bar.style.height = `${Math.max(2, 4 + scaled * 34)}px`;
        binEl.appendChild(bar);
        const label = document.createElement('small');
        label.textContent = idx === 0 || idx === bins.length - 1 || idx % labelStride === 0 ? bin.shortLabel : '';
        binEl.appendChild(label);
        addTooltip(binEl, `${bin.longLabel}: ${formatInteger(bin.words)} words across ${bin.messages} message${bin.messages === 1 ? '' : 's'}.`);
        strip.appendChild(binEl);
    });
    scale.appendChild(strip);
    scaleBox.appendChild(scale);
    legend.appendChild(scaleBox);
    return legend;
}

function buildDailyWritingBins(messages = []) {
    const dated = messages
        .map(message => ({ message, time: parseTimelineRealtime(message.timestamp) }))
        .filter(item => item.time);
    if (!dated.length) {
        return [{
            key: 'undated',
            shortLabel: 'No date',
            longLabel: 'No realtime dates available',
            words: messages.reduce((sum, message) => sum + (Number(message.wordCount) || 0), 0),
            messages: messages.length,
        }];
    }

    const totals = new Map();
    for (const item of dated) {
        const key = getTimelineDayKey(item.time);
        const existing = totals.get(key) || { key, time: getTimelineDayStart(item.time), words: 0, messages: 0 };
        existing.words += Number(item.message.wordCount) || 0;
        existing.messages += 1;
        totals.set(key, existing);
    }

    const starts = Array.from(totals.values()).map(item => item.time).sort((a, b) => a - b);
    const first = starts[0];
    const last = starts[starts.length - 1];
    const bins = [];
    for (let time = first; time <= last; time = addTimelineDays(time, 1)) {
        const key = getTimelineDayKey(time);
        const existing = totals.get(key) || { key, time, words: 0, messages: 0 };
        bins.push({
            ...existing,
            shortLabel: formatTimelineRealtimeDate(time),
            longLabel: new Date(time).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' }),
        });
    }
    return bins;
}

function getTimelineDayStart(value) {
    const date = new Date(Number(value));
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function getTimelineDayKey(value) {
    const date = new Date(Number(value));
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}

function addTimelineDays(value, days) {
    const date = new Date(Number(value));
    date.setDate(date.getDate() + days);
    return date.getTime();
}

function parseTimelineRealtime(value) {
    if (!value) return null;
    if (typeof value === 'number') {
        const ms = value < 1000000000000 ? value * 1000 : value;
        return Number.isFinite(ms) ? ms : null;
    }
    const raw = String(value).trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) return parseTimelineRealtime(Number(raw));
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
}

function formatTimelineRealtimeDate(value) {
    const date = new Date(Number(value));
    if (Number.isNaN(date.getTime())) return 'No date';
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function createContinuityMetric(label, value, sublabel) {
    const metric = document.createElement('div');
    metric.className = 'wandlight-continuity-metric';
    const title = document.createElement('div');
    title.textContent = label;
    metric.appendChild(title);
    const count = document.createElement('strong');
    count.textContent = value;
    metric.appendChild(count);
    const sub = document.createElement('span');
    sub.textContent = sublabel;
    metric.appendChild(sub);
    return metric;
}

function formatInteger(value) {
    return Number(value || 0).toLocaleString();
}

function createTimelineSvg(width, height, className, preserveAspectRatio = 'none') {
    const svg = createTimelineSvgEl('svg', {
        viewBox: `0 0 ${width} ${height}`,
        class: className,
        preserveAspectRatio,
    });
    return svg;
}

function createTimelineSvgEl(tag, attrs = {}) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (value === undefined || value === null) continue;
        if (key === 'class') el.setAttribute('class', value);
        else if (key === 'style') el.setAttribute('style', value);
        else el.setAttribute(key, String(value));
    }
    return el;
}

function createTimelineSvgTitle(text) {
    const title = createTimelineSvgEl('title');
    title.textContent = text || '';
    return title;
}

function showTimelineMessageTooltip(event, message) {
    const tooltip = ensureContinuityTooltip();
    tooltip.replaceChildren();
    const title = document.createElement('div');
    title.className = 'wandlight-continuity-tooltip-title';
    title.textContent = `Message ${message.index} | ${message.senderName}`;
    tooltip.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'wandlight-continuity-tooltip-meta';
    meta.textContent = `${message.wordCount || 0} words${message.detectedDateTime ? ` | ${message.detectedDateTime}` : ''}`;
    tooltip.appendChild(meta);

    const sample = document.createElement('div');
    sample.className = 'wandlight-continuity-tooltip-sample';
    sample.textContent = compactTimelineSentences(message.preview || 'No message text available.', 240);
    tooltip.appendChild(sample);
    positionContinuityTooltip(event);
}

function compactTimelineSentences(text, max = 240) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    const sentences = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g);
    const sample = sentences?.length ? sentences.slice(0, 2).join(' ').trim() : clean;
    return compactTimelineText(sample, max);
}

function ensureContinuityTooltip() {
    let tooltip = document.querySelector('.wandlight-continuity-tooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.className = 'wandlight-continuity-tooltip';
        document.body.appendChild(tooltip);
    }
    return tooltip;
}

function positionContinuityTooltip(event) {
    const tooltip = document.querySelector('.wandlight-continuity-tooltip');
    if (!tooltip || !event) return;
    const margin = 12;
    const width = 280;
    const x = Math.min(window.innerWidth - width - margin, Math.max(margin, event.clientX + 14));
    const y = Math.min(window.innerHeight - 120 - margin, Math.max(margin, event.clientY + 14));
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
}

function hideContinuityTooltip() {
    document.querySelector('.wandlight-continuity-tooltip')?.remove();
}

function createLoreTimelineEventRow(event, selected = false) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `wandlight-lore-timeline-event-row ${getLoreTimelineEventClass(event)}`.trim();
    if (selected) row.classList.add('wandlight-lore-timeline-event-row-selected');
    row.addEventListener('click', () => {
        loreTimelineSelectedId = event.id;
        renderLoreTimeline();
    });

    const marker = document.createElement('span');
    marker.className = 'wandlight-lore-timeline-event-marker';
    row.appendChild(marker);

    const main = document.createElement('span');
    main.className = 'wandlight-lore-timeline-event-main';
    const summary = document.createElement('span');
    summary.className = 'wandlight-lore-timeline-event-summary';
    summary.textContent = event.summary || event.type;
    main.appendChild(summary);
    const meta = document.createElement('span');
    meta.className = 'wandlight-lore-timeline-event-meta';
    const message = event.messageRange?.latest ? `msg ${event.messageRange.latest}` : 'no message anchor';
    meta.textContent = `${formatShortDate(event.timestamp)} | ${message} | ${event.source || 'manual'}`;
    main.appendChild(meta);
    row.appendChild(main);

    const counts = document.createElement('span');
    counts.className = 'wandlight-lore-timeline-event-counts';
    counts.textContent = formatTimelineCounts(event.counts);
    row.appendChild(counts);
    return row;
}

function createLoreTimelineEventDetail(event) {
    const wrap = document.createElement('div');
    wrap.className = 'wandlight-lore-timeline-detail-card';
    if (!event) {
        wrap.appendChild(createEmptyMessage('Select a timeline event to inspect affected entries.'));
        return wrap;
    }

    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = event.summary || event.type;
    wrap.appendChild(title);

    wrap.appendChild(createKeyValue('When', formatLongDate(event.timestamp), 'When this lore event was recorded.'));
    wrap.appendChild(createKeyValue('Message', event.messageRange?.latest ? `Latest ${event.messageRange.latest}` : 'No anchor', 'Approximate chat message anchor at the time of the lore change.'));
    wrap.appendChild(createKeyValue('Source', event.source || 'manual', 'Source or workflow that created this lore event.'));
    if (event.sceneDate || event.canonBoundary) {
        wrap.appendChild(createKeyValue('Story context', [event.sceneDate, event.canonBoundary].filter(Boolean).join(' | '), 'Story context at the time of the event.'));
    }
    wrap.appendChild(createKeyValue('Counts', formatTimelineCounts(event.counts), 'Lore changes recorded in this event.'));

    const refs = Array.isArray(event.refs) ? event.refs : [];
    const refBox = document.createElement('div');
    refBox.className = 'wandlight-lore-timeline-ref-box';
    const refTitle = document.createElement('div');
    refTitle.className = 'wandlight-runtime-help';
    refTitle.textContent = refs.length ? `Affected entries (${refs.length})` : 'No entry references stored.';
    refBox.appendChild(refTitle);
    for (const ref of refs.slice(0, 24)) {
        const chip = document.createElement('span');
        chip.className = 'wandlight-lore-timeline-ref-chip';
        chip.textContent = ref.title || ref.id;
        addTooltip(chip, `${ref.category || 'lore'} | ${ref.relevance || 'normal'} | ${ref.canon || 'canon'}`);
        refBox.appendChild(chip);
    }
    if (refs.length > 24) {
        const more = document.createElement('span');
        more.className = 'wandlight-lore-timeline-ref-chip';
        more.textContent = `+${refs.length - 24} more`;
        refBox.appendChild(more);
    }
    wrap.appendChild(refBox);

    const recoverable = getRecoverableTimelineEntries(event);
    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions';
    const restore = createButton(
        recoverable.length ? `Restore ${recoverable.length} to Pending` : 'Nothing to Restore',
        'Restores recoverable deleted or prior-version entries into Pending Lore Review for editing and acceptance.',
        async () => {
            if (!recoverable.length) return;
            const proceed = await confirmAction('Restore lore to Pending Review?', `This will add ${recoverable.length} recovered lore entr${recoverable.length === 1 ? 'y' : 'ies'} to Pending Lore Review. Accepted lore will not be changed.`);
            if (!proceed) return;
            const result = restoreLoreTimelineEntriesToPending(event.id);
            refreshPanelBody({ preserveScroll: true });
            refreshHeader();
            refreshLoreTimeline();
            refreshLoreWorkbench();
            toast(`Restored ${result.restored || 0} lore entr${(result.restored || 0) === 1 ? 'y' : 'ies'} to Pending Review.`, result.restored ? 'success' : 'warning');
        },
        recoverable.length ? 'wandlight-primary-button' : ''
    );
    restore.disabled = recoverable.length === 0;
    actions.appendChild(restore);
    wrap.appendChild(actions);

    if (recoverable.length) {
        const preview = document.createElement('div');
        preview.className = 'wandlight-lore-timeline-recovery-preview';
        for (const item of recoverable.slice(0, 10)) {
            const line = document.createElement('div');
            line.className = 'wandlight-lore-timeline-recovery-row';
            line.textContent = `${item.recoveryKind}: ${item.entry.title || item.entry.id}`;
            preview.appendChild(line);
        }
        wrap.appendChild(preview);
    }

    return wrap;
}

function formatTimelineCounts(counts = {}) {
    const parts = [];
    if (counts.added) parts.push(`+${counts.added}`);
    if (counts.deleted) parts.push(`-${counts.deleted}`);
    if (counts.updated) parts.push(`${counts.updated} updated`);
    if (counts.pinned) parts.push(`${counts.pinned} pin`);
    if (counts.muted) parts.push(`${counts.muted} mute`);
    if (counts.pending) parts.push(`${counts.pending} pending`);
    if (counts.restored) parts.push(`${counts.restored} restored`);
    return parts.join(' | ') || 'no visible changes';
}

function formatShortDate(timestamp) {
    const date = new Date(Number(timestamp) || Date.now());
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatLongDate(timestamp) {
    const date = new Date(Number(timestamp) || Date.now());
    return date.toLocaleString();
}

function openNewLoreDialog() {
    const existing = document.querySelector('.wandlight-new-lore-overlay');
    existing?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'wandlight-new-lore-overlay';
    document.body.appendChild(overlay);

    const shell = document.createElement('div');
    shell.className = 'wandlight-new-lore-shell';
    overlay.appendChild(shell);

    const header = document.createElement('div');
    header.className = 'wandlight-lore-workbench-header';
    const titleWrap = document.createElement('div');
    titleWrap.className = 'wandlight-lore-workbench-title-wrap';
    const title = document.createElement('div');
    title.className = 'wandlight-lore-workbench-title';
    title.textContent = 'New Lore Entry';
    titleWrap.appendChild(title);
    const subtitle = document.createElement('div');
    subtitle.className = 'wandlight-lore-workbench-subtitle';
    subtitle.textContent = 'Creates a pending draft for review, editing, and acceptance.';
    titleWrap.appendChild(subtitle);
    header.appendChild(titleWrap);
    header.appendChild(createButton('Close', 'Close without creating lore.', () => overlay.remove()));
    shell.appendChild(header);

    const form = document.createElement('div');
    form.className = 'wandlight-new-lore-form';
    shell.appendChild(form);

    const titleInput = createNewLoreInput(form, 'Title', 'Short descriptive title', '', false, 'Conundrum Confidicus opening hazard');
    const factInput = createNewLoreInput(form, 'Lore Text', 'The durable fact, rule, constraint, or state to remember', '', true, 'The Conundrum Confidicus is an ancient book that whispers whenever it is opened and chills the room around it.');
    const injectionInput = createNewLoreInput(form, 'Injection Override', 'Optional model-facing phrasing; blank uses Lore Text', '', true, 'When this book opens, describe faint whispers and an unnatural chill before any spell effect is revealed.');
    const notesInput = createNewLoreInput(form, 'Notes', 'Optional private notes for the user', '', true, 'Introduced during the Restricted Section scene. Keep as AU unless later tied to canon.');

    const metaGrid = document.createElement('div');
    metaGrid.className = 'wandlight-new-lore-meta-grid';
    form.appendChild(metaGrid);
    const categorySelect = createNewLoreSelect(metaGrid, 'Category', getLoreRegistryValues('categories', LORE_CATEGORY_VALUES), 'knowledge');
    const canonSelect = createNewLoreSelect(metaGrid, 'Canon', getLoreRegistryValues('canonStatuses', ['canon', 'au']), 'au');
    const relevanceSelect = createNewLoreSelect(metaGrid, 'Relevance', LORE_RELEVANCE_TIERS, 'normal', value => RELEVANCE_META[value]?.label || value);
    const prioritySelect = createNewLoreSelect(metaGrid, 'Priority', LORE_PRIORITY_VALUES.map(String), '50');
    const truthSelect = createNewLoreSelect(metaGrid, 'Truth', getLoreRegistryValues('truthStatuses', ['true', 'rumor', 'contested', 'hidden']), 'true');
    const revealSelect = createNewLoreSelect(metaGrid, 'Reveal', getLoreRegistryValues('revealPolicies', ['private', 'public', 'do_not_reveal']), 'private');
    const tagsInput = createNewLoreInput(form, 'Tags', 'Comma-separated tags', '', false, 'restricted-section, cursed-book, whispers');

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions';
    actions.appendChild(createButton('Create Pending Lore', 'Adds this draft to Pending Lore Review.', () => {
        const title = titleInput.value.trim();
        const fact = factInput.value.trim();
        if (!title || !fact) {
            toast('New lore needs both a title and lore text.', 'warning');
            return;
        }

        const entry = normalizeLoreEntry({
            title,
            fact,
            category: categorySelect.value,
            canon: canonSelect.value,
            canonStatus: canonSelect.value,
            relevance: relevanceSelect.value,
            priority: Number(prioritySelect.value) || 50,
            truthStatus: truthSelect.value,
            revealPolicy: revealSelect.value,
            tags: tagsInput.value,
            source: 'manual',
            sourceInfo: {
                work: 'Manual Lore',
                notes: 'Created manually by the user.',
                confidence: 1,
            },
            content: {
                fact,
                injection: injectionInput.value.trim() || fact,
                notes: notesInput.value.trim(),
            },
            userEditable: true,
            userEdited: true,
            extensions: {
                wandlightManualDraft: {
                    createdAt: Date.now(),
                    reviewRoute: 'manual_pending',
                },
            },
        });

        const result = appendPendingLoreEntries([entry], {
            source: 'manual',
            status: 'pending',
            summary: `Manual lore draft: ${entry.title}`,
            normalizedEntryCount: 1,
            rawEntryCount: 1,
        }, { snapshot: false, snapshotLabel: 'Create manual lore draft' });
        recordLoreTimelineEvent(result.state, {
            type: 'manual_create_pending',
            source: 'manual',
            summary: `Created manual pending lore: ${entry.title}`,
            counts: { pending: 1 },
            refs: [{ id: entry.id, title: entry.title, category: entry.category, relevance: entry.relevance, canon: entry.canon }],
            patch: { pendingEntries: [entry] },
            reversible: false,
            force: true,
        });
        saveState(result.state);
        overlay.remove();
        refreshPanelBody({ preserveScroll: true });
        refreshHeader();
        refreshLoreTimeline();
        refreshLoreWorkbench();
        toast('Manual lore draft added to Pending Review.', 'success');
    }, 'wandlight-primary-button'));
    actions.appendChild(createButton('Cancel', 'Close without creating lore.', () => overlay.remove()));
    form.appendChild(actions);

    requestAnimationFrame(() => titleInput.focus());
}

function createNewLoreInput(container, labelText, tooltip, value = '', multiline = false, placeholder = '') {
    const label = document.createElement('label');
    label.className = 'wandlight-new-lore-field';
    const span = document.createElement('span');
    span.textContent = labelText;
    addTooltip(span, tooltip);
    label.appendChild(span);
    const input = multiline ? document.createElement('textarea') : document.createElement('input');
    input.className = multiline ? 'wandlight-lore-editor-textarea' : 'wandlight-lore-editor-input';
    if (!multiline) input.type = 'text';
    input.value = value || '';
    input.placeholder = placeholder || '';
    label.appendChild(input);
    container.appendChild(label);
    return input;
}

function createNewLoreSelect(container, labelText, values, selected, display = null) {
    const label = document.createElement('label');
    label.className = 'wandlight-new-lore-field';
    const span = document.createElement('span');
    span.textContent = labelText;
    label.appendChild(span);
    const select = document.createElement('select');
    select.className = 'wandlight-lore-editor-input';
    for (const value of values) {
        const option = document.createElement('option');
        option.value = String(value);
        option.textContent = display ? display(value) : getLoreDisplayLabel(labelToField(labelText), value);
        if (String(value) === String(selected)) option.selected = true;
        select.appendChild(option);
    }
    label.appendChild(select);
    container.appendChild(label);
    return select;
}

function createAutoRelevanceCard(state) {
    const settings = getSettings();
    const card = document.createElement('div');
    card.className = 'wandlight-runtime-card wandlight-auto-relevance-card';
    const title = document.createElement('div');
    title.className = 'wandlight-runtime-card-title';
    title.textContent = 'Auto-Relevance';
    addTooltip(title, 'Periodically rescans recent story context and adjusts accepted lore relevance tiers. Mute remains the hard injection on/off control.');
    card.appendChild(title);
    const help = document.createElement('div');
    help.className = 'wandlight-runtime-help';
    help.textContent = 'Auto-Relevance uses local scoring for performance. It can promote or demote High/Normal/Low relevance, but it does not change mute or pin.';
    card.appendChild(help);
    appendSettingsResetButton(card, AUTO_RELEVANCE_SETTING_KEYS, 'Auto-Relevance settings');

    const enabled = document.createElement('label');
    enabled.className = 'wandlight-inline-toggle';
    markTourTarget(enabled, 'lore.autoRelevance.toggle');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!settings.autoRelevanceEnabled;
    cb.addEventListener('change', () => {
        const next = getSettings();
        next.autoRelevanceEnabled = cb.checked;
        if (cb.checked && (!next.autoRelevanceMode || next.autoRelevanceMode === 'off')) next.autoRelevanceMode = 'suggest';
        saveSettings(next);
        refreshPanelBody({ preserveScroll: true });
    });
    enabled.appendChild(cb);
    enabled.appendChild(document.createTextNode(' Enable Auto-Relevance'));
    card.appendChild(enabled);

    const modeRow = document.createElement('div');
    modeRow.className = 'wandlight-runtime-grid';
    markTourTarget(modeRow, 'lore.autoRelevance.mode');
    const modeLabel = document.createElement('label');
    modeLabel.className = 'wandlight-inline-field';
    const modeSpan = document.createElement('span');
    modeSpan.textContent = 'Action when enabled';
    addTooltip(modeSpan, 'The checkbox turns Auto-Relevance on or off. This selector controls what Auto-Relevance does when it runs.');
    const modeSelect = document.createElement('select');
    const selectedMode = (settings.autoRelevanceMode || 'suggest') === 'off' ? 'suggest' : (settings.autoRelevanceMode || 'suggest');
    for (const [value, label] of [['suggest', 'Suggest changes for review'], ['apply_high_confidence', 'Apply high-confidence changes']]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        if (selectedMode === value) option.selected = true;
        modeSelect.appendChild(option);
    }
    modeSelect.addEventListener('change', () => {
        const next = getSettings();
        next.autoRelevanceMode = modeSelect.value;
        saveSettings(next);
        refreshPanelBody({ preserveScroll: true });
    });
    modeLabel.appendChild(modeSpan);
    modeLabel.appendChild(modeSelect);
    modeRow.appendChild(modeLabel);
    card.appendChild(modeRow);

    const row = document.createElement('div');
    row.className = 'wandlight-runtime-grid';
    markTourTarget(row, 'lore.autoRelevance.tuning');
    row.appendChild(createNumberSettingMini('Run every turns', 'autoRelevanceEveryTurns', settings.autoRelevanceEveryTurns || 5, 1, 50));
    row.appendChild(createNumberSettingMini('Recent messages', 'autoRelevanceRecentMessages', settings.autoRelevanceRecentMessages || 20, 1, 200));
    row.appendChild(createNumberSettingMini('Candidate cap', 'autoRelevanceCandidateCap', settings.autoRelevanceCandidateCap || 40, 1, 500));
    row.appendChild(createNumberSettingMini('Min confidence %', 'autoRelevanceMinConfidence', Math.round((settings.autoRelevanceMinConfidence || 0.7) * 100), 1, 100, value => Number(value) / 100));
    card.appendChild(row);

    const modelRow = document.createElement('div');
    modelRow.className = 'wandlight-runtime-grid';
    markTourTarget(modelRow, 'lore.autoRelevance.model');
    const modelToggle = document.createElement('label');
    modelToggle.className = 'wandlight-inline-toggle';
    const modelCb = document.createElement('input');
    modelCb.type = 'checkbox';
    modelCb.checked = !!settings.autoRelevanceUseModel;
    modelCb.addEventListener('change', () => {
        const next = getSettings();
        next.autoRelevanceUseModel = modelCb.checked;
        saveSettings(next);
        refreshPanelBody({ preserveScroll: true });
    });
    modelToggle.appendChild(modelCb);
    modelToggle.appendChild(document.createTextNode(' Use Utility Provider adjudication'));
    addTooltip(modelToggle, 'Optional second-stage model review. Wandlight still scores locally first and sends only the candidate cap subset.');
    modelRow.appendChild(modelToggle);
    modelRow.appendChild(createNumberSettingMini('Model candidate cap', 'autoRelevanceModelCandidateCap', settings.autoRelevanceModelCandidateCap || 30, 1, 80));
    modelRow.appendChild(createNumberSettingMini('Model max tokens', 'autoRelevanceModelMaxTokens', settings.autoRelevanceModelMaxTokens || 2048, 512, 4096));
    card.appendChild(modelRow);
    const counts = getLoreRelevanceCounts(state);
    card.appendChild(createKeyValue('Current tiers', `High ${counts.high} · Normal ${counts.normal} · Low ${counts.low} · Muted ${counts.muted}`, 'Current accepted lore counts by relevance.'));

    const suggestions = Array.isArray(state.autoRelevanceSuggestions) ? state.autoRelevanceSuggestions : [];
    if (suggestions.length) {
        const box = document.createElement('div');
        box.className = 'wandlight-auto-relevance-suggestions';
        markTourTarget(box, 'lore.autoRelevance.suggestions');
        const heading = document.createElement('div');
        heading.className = 'wandlight-runtime-help';
        heading.textContent = `Pending relevance suggestions: ${suggestions.length}`;
        box.appendChild(heading);
        for (const suggestion of suggestions.slice(0, 12)) {
            const row = document.createElement('div');
            row.className = 'wandlight-auto-relevance-suggestion-row';
            const summary = document.createElement('div');
            summary.className = 'wandlight-auto-relevance-suggestion-summary';
            summary.textContent = `${suggestion.title || suggestion.id}: ${suggestion.currentRelevance || '?'} -> ${suggestion.suggestedRelevance} (${Math.round((suggestion.confidence || 0) * 100)}%, ${suggestion.source || 'local'})`;
            addTooltip(summary, suggestion.reason || 'Auto-Relevance suggestion.');
            row.appendChild(summary);
            const applyOne = createButton('Apply', 'Apply this relevance suggestion only.', () => {
                const result = applyAutoRelevanceSuggestions([suggestion.id]);
                refreshPanelBody({ preserveScroll: true });
                refreshHeader();
                toast(`Applied ${result.applied || 0} relevance suggestion.`, 'success');
            }, 'wandlight-mini-button');
            const rejectOne = createButton('Reject', 'Reject this relevance suggestion only.', () => {
                const result = rejectAutoRelevanceSuggestions([suggestion.id]);
                refreshPanelBody({ preserveScroll: true });
                toast(`Rejected ${result.rejected || 0} relevance suggestion.`, 'info');
            }, 'wandlight-mini-button');
            row.appendChild(applyOne);
            row.appendChild(rejectOne);
            box.appendChild(row);
        }
        if (suggestions.length > 12) {
            const more = document.createElement('div');
            more.className = 'wandlight-runtime-help';
            more.textContent = `${suggestions.length - 12} additional suggestions hidden. Use Apply Suggestions or Clear Suggestions for the full queue.`;
            box.appendChild(more);
        }
        card.appendChild(box);
    }

    const actions = document.createElement('div');
    actions.className = 'wandlight-primary-actions';
    markTourTarget(actions, 'lore.autoRelevance.actions');
    actions.appendChild(createButton('Run Auto-Relevance Now', 'Runs Auto-Relevance immediately. Local scoring always runs first; optional Utility Provider adjudication reviews only the candidate set.', async (btn) => {
        const original = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Running...';
        try {
            const result = await runAutoRelevance({ force: true });
            refreshPanelBody({ preserveScroll: true });
            refreshHeader();
            toast(`Auto-Relevance ${result.status}: ${result.changed || 0} changed, ${result.suggested || 0} suggested, ${result.considered || 0} considered${result.modelStatus ? `, model ${result.modelStatus}` : ''}.`, 'info');
        } catch (e) {
            console.error(e);
            toast(`Auto-Relevance failed: ${e?.message || e}`, 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = original;
        }
    }, 'wandlight-primary-button'));
    if (suggestions.length) {
        actions.appendChild(createButton('Apply Suggestions', 'Applies all pending Auto-Relevance suggestions.', () => {
            const result = applyAutoRelevanceSuggestions();
            refreshPanelBody({ preserveScroll: true });
            refreshHeader();
            toast(`Auto-Relevance suggestions applied: ${result.applied || 0}.`, 'success');
        }, 'wandlight-small-button'));
        actions.appendChild(createButton('Reject All Suggestions', 'Rejects all pending Auto-Relevance suggestions without applying them.', () => {
            clearAutoRelevanceSuggestions();
            refreshPanelBody({ preserveScroll: true });
            toast('Auto-Relevance suggestions rejected.', 'info');
        }, 'wandlight-small-button'));
    }
    card.appendChild(actions);
    return card;
}

function createNumberSettingMini(labelText, settingKey, value, min, max, transform = null) {
    const label = document.createElement('label');
    label.className = 'wandlight-inline-field';
    const span = document.createElement('span');
    span.textContent = labelText;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = String(min);
    input.max = String(max);
    input.value = String(value);
    input.addEventListener('change', () => {
        const next = getSettings();
        const raw = Math.max(min, Math.min(max, Number(input.value) || Number(value) || min));
        next[settingKey] = transform ? transform(raw) : raw;
        saveSettings(next);
        refreshPanelBody({ preserveScroll: true });
    });
    label.appendChild(span);
    label.appendChild(input);
    return label;
}

function createAcceptedLoreEntriesSection(state) {
    const section = document.createElement('div');
    section.className = 'wandlight-accepted-lore-section';

    const controls = document.createElement('div');
    controls.className = 'wandlight-lore-controls';

    const panelState = state?.lorePanel || { selectedCategory: 'all', search: '' };
    const loreState = getPanelLoreState(state);
    const { entries, categories, counts } = loreState;
    const acceptedCount = Math.max(0, (counts?.all || 0) - (counts?.pending || 0));

    controls.appendChild(createLoreWorkbenchLaunchRow('accepted', `${acceptedCount} accepted entries`));

    const tabs = document.createElement('div');
    tabs.className = 'wandlight-lore-tabs';
    markTourTarget(tabs, 'lore.accepted.categoryTabs');
    for (const cat of categories) {
        const tab = document.createElement('button');
        tab.className = 'wandlight-lore-tab';
        if (cat === panelState.selectedCategory) tab.classList.add('wandlight-lore-tab-active');
        tab.type = 'button';
        const label = getLoreDisplayLabel('category', cat);
        const catCount = getCategoryCount(cat, entries, counts);
        tab.textContent = `${label} (${catCount})`;
        tab.dataset.category = cat;
        addTooltip(tab, getCategoryTooltip(cat));
        tab.addEventListener('click', () => {
            setPanelState({ selectedCategory: cat, acceptedLoreVisibleLimit: ACCEPTED_LORE_INITIAL_VISIBLE_LIMIT }, { deferSave: true });
            refreshAcceptedLoreCategoryTabs(cat);
            refreshAcceptedLoreFilterResults({ resetListScroll: true });
        });
        tabs.appendChild(tab);
    }
    controls.appendChild(tabs);

    const filterRow = document.createElement('div');
    filterRow.className = 'wandlight-lore-filter-row';
    markTourTarget(filterRow, 'lore.accepted.filters');

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'wandlight-lore-search';
    searchInput.placeholder = 'Search titles and tags...';
    searchInput.value = panelState.search || '';
    addTooltip(searchInput, 'Searches lore entry titles and tags first. Fact text, notes, and IDs are searched as fallback.');
    searchInput.addEventListener('input', (e) => {
        setPanelState({ search: e.target.value, acceptedLoreVisibleLimit: ACCEPTED_LORE_INITIAL_VISIBLE_LIMIT }, { deferSave: true });
        scheduleAcceptedLoreListRender(section);
    });
    filterRow.appendChild(searchInput);

    const sourceSelect = document.createElement('select');
    sourceSelect.className = 'wandlight-lore-source-filter';
    addTooltip(sourceSelect, 'Filter accepted lore by origin: canon database, story generation, or manual/user-created entries.');
    const sourceOptions = [
        ['all', 'Source: All'],
        ['canon-db', 'Canon Database'],
        ['story-generation', 'Story Generation'],
        ['manual', 'Manual / User'],
    ];
    for (const [value, label] of sourceOptions) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        if ((panelState.sourceFilter || 'all') === value) opt.selected = true;
        sourceSelect.appendChild(opt);
    }
    sourceSelect.addEventListener('change', () => {
        setPanelState({ sourceFilter: sourceSelect.value, acceptedLoreVisibleLimit: ACCEPTED_LORE_INITIAL_VISIBLE_LIMIT }, { deferSave: true });
        refreshAcceptedLoreFilterResults({ resetListScroll: true });
    });
    filterRow.appendChild(sourceSelect);
    controls.appendChild(filterRow);

    const pinHelp = document.createElement('div');
    pinHelp.className = 'wandlight-runtime-help wandlight-pin-help';
    markTourTarget(pinHelp, 'lore.accepted.pinMuteHelp');
    pinHelp.textContent = 'Pinned = prioritized/protected. Muted = excluded from injection. Relevance controls tier placement, sorting, and compression budget.';
    addTooltip(pinHelp, 'Pin important facts you always want kept prominent. Mute facts that should stay stored but not be sent to the model.');
    controls.appendChild(pinHelp);

    const bulkMount = document.createElement('div');
    bulkMount.className = 'wandlight-lore-bulk-toolbar';
    markTourTarget(bulkMount, 'lore.accepted.bulk');
    bulkMount.appendChild(createAcceptedLoreBulkControls(state));
    controls.appendChild(bulkMount);

    section.appendChild(controls);

    const list = document.createElement('div');
    list.className = 'wandlight-lore-entry-list wandlight-accepted-lore-scroll-region';
    markTourTarget(list, 'lore.accepted.list');
    list.setAttribute('role', 'region');
    list.setAttribute('aria-label', 'Accepted lore entries');
    renderEntryList(list, state);
    section.appendChild(list);
    return section;
}

function renderEntryList(list, state) {
    if (!list) return;
    list.replaceChildren();

    const filtered = getFilteredLoreEntries(state);
    if (filtered.length === 0) {
        list.appendChild(createEmptyMessage('No lore entries match the current filter.'));
        return;
    }

    const panelState = state?.lorePanel || {};
    const visibleLimit = Math.max(10, Math.min(
        filtered.length,
        Number(panelState.acceptedLoreVisibleLimit) || ACCEPTED_LORE_INITIAL_VISIBLE_LIMIT
    ));
    const visible = filtered.slice(0, visibleLimit);
    const fragment = document.createDocumentFragment();

    const summary = document.createElement('div');
    summary.className = 'wandlight-lore-list-summary';
    summary.textContent = filtered.length > visible.length
        ? `Showing ${visible.length} of ${filtered.length} accepted lore entries.`
        : `Showing ${filtered.length} accepted lore entr${filtered.length === 1 ? 'y' : 'ies'}.`;
    fragment.appendChild(summary);

    for (const entry of visible) {
        fragment.appendChild(createEntryCard(entry, state));
    }

    if (filtered.length > visible.length) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'wandlight-secondary-button wandlight-lore-show-more';
        const nextCount = Math.min(ACCEPTED_LORE_PAGE_INCREMENT, filtered.length - visible.length);
        more.textContent = `Show ${nextCount} more`;
        addTooltip(more, 'Renders more accepted lore entries. Keeping the list paged prevents large lore matrices from slowing the browser.');
        more.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            setPanelState({ acceptedLoreVisibleLimit: visible.length + ACCEPTED_LORE_PAGE_INCREMENT }, { deferSave: true });
            refreshAcceptedLoreList({ preserveScroll: true });
            refreshAcceptedLoreBulkToolbar();
        });
        fragment.appendChild(more);
    }

    list.appendChild(fragment);
}

function scheduleAcceptedLoreListRender(container) {
    if (searchRenderTimer) clearTimeout(searchRenderTimer);
    searchRenderTimer = setTimeout(() => {
        const root = container || panelRoot;
        const list = root?.querySelector?.('.wandlight-lore-entry-list');
        if (list) renderEntryList(list, getState());
        refreshAcceptedLoreBulkToolbar();
        scheduleAcceptedLoreLayoutUpdate();
    }, SEARCH_RENDER_DEBOUNCE_MS);
}

function refreshAcceptedLoreList(options = {}) {
    if (!panelRoot) return;
    const list = panelRoot.querySelector('.wandlight-lore-entry-list');
    if (!list) return;
    const scrollTop = options.preserveScroll ? list.scrollTop : 0;
    renderEntryList(list, getState());
    scheduleAcceptedLoreLayoutUpdate();
    if (options.preserveScroll) list.scrollTop = scrollTop;
}

function refreshAcceptedLoreCategoryTabs(activeCategory) {
    if (!panelRoot) return;
    panelRoot.querySelectorAll('.wandlight-lore-tabs .wandlight-lore-tab').forEach(tab => {
        tab.classList.toggle('wandlight-lore-tab-active', tab.dataset.category === activeCategory);
    });
}

function refreshAcceptedLoreFilterResults(options = {}) {
    if (!panelRoot) return;
    const section = panelRoot.querySelector('.wandlight-accepted-lore-section');
    const list = section?.querySelector?.('.wandlight-lore-entry-list');
    if (!list) return;
    renderEntryList(list, getState());
    if (options.resetListScroll !== false) list.scrollTop = 0;
    refreshAcceptedLoreBulkToolbar();
    scheduleAcceptedLoreLayoutUpdate();
    if (loreWorkbenchOpen && loreWorkbenchMode === 'accepted') refreshLoreWorkbench();
}

function refreshAcceptedLoreRow(entryId) {
    if (!panelRoot || !entryId) return false;
    const list = panelRoot.querySelector('.wandlight-lore-entry-list');
    const existing = list?.querySelector?.(`[data-entry-id="${cssEscape(entryId)}"]`);
    if (!existing) return false;
    const state = getState();
    const entry = getFilteredLoreEntries(state).find(item => item.id === entryId);
    if (!entry) {
        existing.remove();
        return true;
    }
    existing.replaceWith(createEntryCard(entry, state));
    scheduleAcceptedLoreLayoutUpdate();
    return true;
}

let acceptedLoreLayoutFrame = 0;

function scheduleAcceptedLoreLayoutUpdate() {
    if (acceptedLoreLayoutFrame) cancelAnimationFrame(acceptedLoreLayoutFrame);
    acceptedLoreLayoutFrame = requestAnimationFrame(() => {
        acceptedLoreLayoutFrame = requestAnimationFrame(() => {
            acceptedLoreLayoutFrame = 0;
            updateAcceptedLoreScrollRegionHeight();
        });
    });
}

function updateAcceptedLoreScrollRegionHeight() {
    if (!panelRoot) return;
    const drawer = panelRoot.querySelector('.wandlight-runtime-drawer');
    if (!drawer) return;

    updateDrawerScrollMetrics(drawer);

    const list = drawer.querySelector('.wandlight-accepted-lore-scroll-region');
    if (!list) return;

    const acceptedSection = list.closest('.wandlight-accepted-lore-section');
    const acceptedDetails = list.closest('.wandlight-lore-accepted-collapsible');
    const content = acceptedDetails?.querySelector(':scope > .wandlight-collapsible-content');

    // Earlier layout code made the accepted-lore section stretch to the bottom of
    // the drawer. That works for a fixed Lore tab, but it clips later sections
    // when every Lore section is expanded. The drawer tab is now the outer
    // scroller; accepted lore remains a bounded nested scroller. Clear any stale
    // inline sizing before applying the bounded-scroll CSS variables.
    for (const el of [acceptedDetails, content, acceptedSection, list]) {
        if (!el) continue;
        el.style.removeProperty('height');
        el.style.removeProperty('flex');
        el.style.removeProperty('max-height');
    }

    list.style.setProperty('overflow-y', 'auto');
    list.style.setProperty('overscroll-behavior', 'contain');
}

function updateDrawerScrollMetrics(drawer = panelRoot?.querySelector?.('.wandlight-runtime-drawer')) {
    if (!drawer) return;
    const drawerRect = drawer.getBoundingClientRect?.();
    const headerRect = drawer.querySelector('.wandlight-runtime-drawer-header')?.getBoundingClientRect?.();
    const drawerHeight = Number(drawerRect?.height) || Number.parseFloat(drawer.style.height) || 640;
    const headerHeight = Number(headerRect?.height) || 48;
    const bodyHeight = Math.max(120, Math.floor(drawerHeight - headerHeight - 18));
    const nestedMax = Math.max(140, Math.min(420, Math.floor(bodyHeight * 0.52)));
    drawer.style.setProperty('--wandlight-drawer-body-available', `${bodyHeight}px`);
    drawer.style.setProperty('--wandlight-nested-scroll-max', `${nestedMax}px`);
}

if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => {
        clampRuntimeShellToViewport();
        scheduleAcceptedLoreLayoutUpdate();
    });
}

function cssEscape(value) {
    if (window.CSS?.escape) return window.CSS.escape(String(value));
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function getFilteredLoreEntries(state) {
    const panelState = state?.lorePanel || {
        selectedCategory: 'all',
        search: '',
        selectedEntryId: '',
    };

    const { entries } = getPanelLoreState(state);
    let filtered = entries.filter(entry => !entry.isPending);

    if (panelState.selectedCategory === 'pending') {
        filtered = [];
    } else if (panelState.selectedCategory === 'active' || panelState.selectedCategory === 'high') {
        filtered = filtered.filter(e => e.relevance === 'high');
    } else if (panelState.selectedCategory === 'normal') {
        filtered = filtered.filter(e => e.relevance === 'normal');
    } else if (panelState.selectedCategory === 'low') {
        filtered = filtered.filter(e => e.relevance === 'low');
    } else if (panelState.selectedCategory === 'pinned') {
        filtered = filtered.filter(e => e.isPinned);
    } else if (panelState.selectedCategory === 'suppressed') {
        filtered = filtered.filter(e => e.isSuppressed);
    } else if (panelState.selectedCategory && panelState.selectedCategory !== 'all') {
        filtered = filtered.filter(e => e.category === panelState.selectedCategory);
    }

    const sourceFilter = panelState.sourceFilter || 'all';
    if (sourceFilter && sourceFilter !== 'all') {
        filtered = filtered.filter(entry => getLoreSourceBucket(entry) === sourceFilter);
    }

    filtered = [...filtered].sort(sortLoreEntriesForPanel);

    const query = String(panelState.search || '').trim().toLowerCase();
    if (!query) return filtered;

    return filtered
        .map(entry => ({ entry, score: scoreSearchEntry(entry, query) }))
        .filter(item => item.score > 0)
        .sort((a, b) =>
            b.score - a.score
            || Number(b.entry.priority || 50) - Number(a.entry.priority || 50)
            || String(a.entry.title || '').localeCompare(String(b.entry.title || ''))
        )
        .map(item => item.entry);
}


function getLoreSourceBucket(entry) {
    const source = String(entry?.source || entry?.sourceInfo?.id || '').toLowerCase();
    const id = String(entry?.id || '').toLowerCase();
    const userEdited = !!entry?.userEdited;
    if (source.includes('canon-lore-db') || source.includes('canon database') || id.startsWith('canon_db_') || id.includes('_canon_')) return 'canon-db';
    if (source.includes('model-generated') || source.includes('story') || source.includes('lore-generator')) return 'story-generation';
    if (userEdited || source === 'user' || source === 'manual') return 'manual';
    return 'story-generation';
}

function sortLoreEntriesForPanel(a, b) {
    const pinScore = Number(!!b.isPinned) - Number(!!a.isPinned);
    if (pinScore) return pinScore;
    const pendingScore = Number(!!b.isPending) - Number(!!a.isPending);
    if (pendingScore) return pendingScore;
    const categoryScore = getLoreCategoryRank(a.category) - getLoreCategoryRank(b.category);
    if (categoryScore) return categoryScore;
    const priorityScore = Number(b.priority || 50) - Number(a.priority || 50);
    if (priorityScore) return priorityScore;
    const scopeScore = getLoreScopeSpecificity(b) - getLoreScopeSpecificity(a);
    if (scopeScore) return scopeScore;
    return String(a.title || '').localeCompare(String(b.title || ''));
}

function getLoreCategoryRank(category) {
    const order = ['event', 'timeline', 'character', 'relationship', 'location', 'faction', 'knowledge', 'secret', 'item', 'spell', 'rule', 'other'];
    const idx = order.indexOf(category || '');
    return idx >= 0 ? idx : 99;
}


const RELEVANCE_META = {
    high: { label: 'High', color: '#166534', textColor: '#dcfce7', tooltip: 'Current-scene or immediate story relevance. Injects in the High-Relevance lore group.' },
    normal: { label: 'Normal', color: '#1e3a8a', textColor: '#dbeafe', tooltip: 'Recent, branch-defining, or medium-range story relevance. Injects in the Normal-Relevance lore group.' },
    low: { label: 'Low', color: '#4b5563', textColor: '#f9fafb', tooltip: 'Long-term background or distant past/future lore. Injects in the Low-Relevance lore group if enabled.' },
};
const LIFECYCLE_META = RELEVANCE_META;

function getLifecycleStatus(entry) {
    return normalizeLoreRelevance(entry.relevance || entry.lifecycleStatus || entry.lifecycle?.status || entry.lifecycle?.computedStatus || 'normal');
}

function createEditableLifecycleBadge(entry, options = {}) {
    const value = getLifecycleStatus(entry);
    const meta = RELEVANCE_META[value] || RELEVANCE_META.normal;
    const wrap = document.createElement('label');
    wrap.className = 'wandlight-lore-lifecycle-select-wrap';
    wrap.style.setProperty('--wandlight-chip-bg', meta.color);
    wrap.style.setProperty('--wandlight-chip-fg', meta.textColor);
    addTooltip(wrap, `${meta.label} Relevance: ${meta.tooltip}`);

    const select = document.createElement('select');
    select.className = 'wandlight-lore-lifecycle-select';
    select.setAttribute('aria-label', 'Lore relevance');
    select.addEventListener('click', e => e.stopPropagation());
    select.addEventListener('mousedown', e => e.stopPropagation());

    for (const status of LORE_RELEVANCE_TIERS) {
        const option = document.createElement('option');
        option.value = status;
        option.textContent = RELEVANCE_META[status]?.label || status;
        if (status === value) option.selected = true;
        select.appendChild(option);
    }

    select.addEventListener('change', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const nextRelevance = normalizeLoreRelevance(select.value);
        updateLoreEntryById(entry.id, raw => ({
            ...raw,
            relevance: nextRelevance,
            lifecycle: {
                ...(raw.lifecycle || {}),
                status: '',
                computedStatus: '',
                manualOverride: false,
                reason: `Relevance manually set to ${nextRelevance}.`,
                lastEvaluatedAt: Date.now(),
            },
            extensions: {
                ...(raw.extensions || {}),
                autoRelevance: {
                    ...(raw.extensions?.autoRelevance || {}),
                    mode: 'manual',
                    confidence: 1,
                    reason: `User manually set relevance to ${nextRelevance}.`,
                    updatedAt: Date.now(),
                },
            },
        }), { deferSave: true });
        if (options.pending) refreshPanelBody({ preserveScroll: true });
        else if (!refreshAcceptedLoreRow(entry.id)) refreshAcceptedLoreList({ preserveScroll: true });
        refreshAcceptedLoreBulkToolbar();
        refreshHeader();
        refreshLoreWorkbench();
        toast(`${entry.title || 'Lore entry'} relevance set to ${RELEVANCE_META[nextRelevance]?.label || nextRelevance}.`, 'info');
    });

    wrap.appendChild(select);
    return wrap;
}


function createRegistryBadge(field, value, tooltip = '') {
    const label = getLoreDisplayLabel(field, value);
    const badge = createBadge(label, tooltip || `${field}: ${label}. Expand the entry to edit.`);
    badge.classList.add('wandlight-lore-registry-badge');
    applyLoreRegistryStyle(badge, field, value);
    return badge;
}

function createEditableLoreMetaBadge(entry, field, value, values = null, tooltip = '') {
    const fallbackValues = {
        category: LORE_CATEGORY_VALUES,
        canon: ['canon', 'au'],
        canonStatus: ['canon', 'au'],
        truthStatus: ['true', 'false', 'public_belief', 'rumor', 'contested', 'hidden'],
        revealPolicy: ['public', 'private', 'do_not_reveal', 'only_if_knower_present', 'only_if_user_reveals'],
    };
    const registryName = getLoreFieldRegistry(field);
    const effectiveValues = Array.from(new Set((Array.isArray(values) && values.length
        ? values
        : getLoreRegistryValues(registryName, fallbackValues[field] || [])
    ).map(v => String(v || '').trim()).filter(Boolean)));

    const currentValue = String(value || effectiveValues[0] || '').trim();
    const currentLabel = getLoreDisplayLabel(field, currentValue);
    const meta = registryName ? getLoreRegistryMeta(registryName, currentValue) : null;
    const help = tooltip || meta?.description || `${field}: ${currentLabel}. Choose a new value from the dropdown.`;

    const wrap = document.createElement('label');
    wrap.className = 'wandlight-lore-meta-select-wrap';
    applyLoreRegistryStyle(wrap, field, currentValue);
    addTooltip(wrap, help);

    const prefix = document.createElement('span');
    prefix.className = 'wandlight-lore-meta-select-prefix';
    prefix.textContent = (field === 'canonStatus' || field === 'canon')
        ? 'Canon'
        : field === 'truthStatus'
            ? 'Truth'
            : field === 'revealPolicy'
                ? 'Reveal'
                : 'Category';
    wrap.appendChild(prefix);

    const select = document.createElement('select');
    select.className = 'wandlight-lore-meta-select';
    select.setAttribute('aria-label', `${prefix.textContent} metadata`);
    select.addEventListener('click', e => e.stopPropagation());
    select.addEventListener('mousedown', e => e.stopPropagation());

    for (const optionValue of effectiveValues) {
        const option = document.createElement('option');
        option.value = optionValue;
        option.textContent = getLoreDisplayLabel(field, optionValue);
        if (optionValue === currentValue) option.selected = true;
        select.appendChild(option);
    }

    // Preserve custom values even if they are not currently in the registry.
    if (currentValue && !effectiveValues.includes(currentValue)) {
        const option = document.createElement('option');
        option.value = currentValue;
        option.textContent = getLoreDisplayLabel(field, currentValue);
        option.selected = true;
        select.insertBefore(option, select.firstChild);
    }

    select.addEventListener('change', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const nextValue = select.value;
        updateLoreEntryById(entry.id, raw => field === 'canonStatus' || field === 'canon'
            ? ({ ...raw, canon: nextValue, canonStatus: nextValue })
            : ({ ...raw, [field]: nextValue }), { deferSave: true });
        if (!refreshAcceptedLoreRow(entry.id)) refreshAcceptedLoreList({ preserveScroll: true });
        refreshHeader();
        refreshLoreWorkbench();
        toast(`${entry.title || 'Lore entry'} ${prefix.textContent.toLowerCase()} set to ${getLoreDisplayLabel(field, nextValue)}.`, 'info');
    });

    wrap.appendChild(select);
    return wrap;
}

function createEditablePriorityBadge(entry) {
    const current = Number(entry.priority || 50);
    const wrap = document.createElement('label');
    wrap.className = 'wandlight-lore-meta-select-wrap wandlight-lore-meta-select-priority';
    addTooltip(wrap, 'Priority controls sorting and injection preference. Choose P10 through P100.');

    const prefix = document.createElement('span');
    prefix.className = 'wandlight-lore-meta-select-prefix';
    prefix.textContent = 'Priority';
    wrap.appendChild(prefix);

    const select = document.createElement('select');
    select.className = 'wandlight-lore-meta-select';
    select.setAttribute('aria-label', 'Priority metadata');
    select.addEventListener('click', e => e.stopPropagation());
    select.addEventListener('mousedown', e => e.stopPropagation());

    for (const value of LORE_PRIORITY_VALUES) {
        const option = document.createElement('option');
        option.value = String(value);
        option.textContent = `P${value}`;
        if (value === current) option.selected = true;
        select.appendChild(option);
    }

    select.addEventListener('change', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const nextValue = Math.max(0, Math.min(100, Number(select.value) || 50));
        updateLoreEntryById(entry.id, raw => ({ ...raw, priority: nextValue }), { deferSave: true });
        if (!refreshAcceptedLoreRow(entry.id)) refreshAcceptedLoreList({ preserveScroll: true });
        refreshHeader();
        refreshLoreWorkbench();
        toast(`${entry.title || 'Lore entry'} priority set to P${nextValue}.`, 'info');
    });

    wrap.appendChild(select);
    return wrap;
}


function createLorePurposeBadge(entry) {
    const purpose = normalizeLorePurpose(entry?.lorePurpose || entry?.purpose, entry) || 'unspecified';
    const label = LORE_PURPOSE_LABELS[purpose] || String(purpose || 'unspecified').replace(/[_-]+/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());
    return createBadge(`Purpose: ${label}`, 'Lore purpose explains why this is specific Wandlight lore rather than a generic reference fact.');
}

function createSpellMetadataBadges(entry) {
    const row = document.createDocumentFragment();
    const spells = Array.from(new Set([
        ...((entry?.scope?.spells || []).map(v => String(v || '').trim()).filter(Boolean)),
        ...((entry?.tags || []).filter(tag => /spell|patronus|expelliarmus|sectumsempra|occlumency|legilimency|apparition/i.test(String(tag || '')))),
    ])).slice(0, 4);

    if (!spells.length && (entry?.kind === 'spell_gate' || entry?.category === 'spell')) {
        spells.push(entry?.title || 'Spell gate');
    }

    for (const spell of spells) {
        const badge = createBadge(`Spell: ${spell}`, 'Spell metadata. This identifies spell knowledge, spell-learning gates, or magic-ability constraints attached to this lore entry.');
        badge.classList.add('wandlight-lore-badge-spell');
        row.appendChild(badge);
    }

    return row;
}

function scoreSearchEntry(entry, query) {
    const title = String(entry.title || '').toLowerCase();
    const tags = Array.isArray(entry.tags) ? entry.tags.map(t => String(t).toLowerCase()) : [];
    const scope = formatLoreScope(entry.scope).toLowerCase();
    const fact = String(entry.fact || '').toLowerCase();
    const id = String(entry.id || '').toLowerCase();
    const notes = String(entry.notes || '').toLowerCase();

    if (title === query) return 100;
    if (tags.some(t => t === query)) return 90;
    if (title.includes(query)) return 80;
    if (tags.some(t => t.includes(query))) return 70;
    if (scope.includes(query)) return 55;
    if (fact.includes(query)) return 40;
    if (notes.includes(query)) return 30;
    if (id.includes(query)) return 20;
    return 0;
}

function createEntryCard(entry, state) {
    const card = document.createElement('div');
    card.className = 'wandlight-lore-entry-card';
    markTourTarget(card, entry.isPending ? 'lore.pending.entry' : 'lore.accepted.entry');
    if (entry.id) card.dataset.entryId = entry.id;

    if (entry.isPending) card.classList.add('wandlight-lore-entry-pending');
    if (entry.isActive) card.classList.add('wandlight-lore-entry-active');
    if (entry.isPinned) card.classList.add('wandlight-lore-entry-pinned');
    if (entry.isSuppressed) card.classList.add('wandlight-lore-entry-suppressed');
    if (getAcceptedSelectionSet(state).has(entry.id)) card.classList.add('wandlight-lore-entry-selected');

    const panelState = state?.lorePanel || {};
    const isExpanded = panelState.selectedEntryId === entry.id;
    if (isExpanded) card.classList.add('wandlight-lore-entry-expanded');

    const headerRow = document.createElement('div');
    headerRow.className = 'wandlight-lore-entry-header';

    const selectBox = document.createElement('input');
    selectBox.type = 'checkbox';
    selectBox.className = 'wandlight-lore-entry-select';
    selectBox.checked = getAcceptedSelectionSet(state).has(entry.id);
    selectBox.setAttribute('aria-label', 'Select accepted lore entry for bulk actions');
    addTooltip(selectBox, selectBox.checked ? 'Remove this accepted lore entry from the bulk selection.' : 'Select this accepted lore entry for bulk actions.');
    selectBox.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleAcceptedLoreSelection(entry.id, selectBox.checked);
        if (!refreshAcceptedLoreRow(entry.id)) refreshAcceptedLoreList({ preserveScroll: true });
        refreshAcceptedLoreBulkToolbar();
    });
    headerRow.appendChild(selectBox);

    const titleWrap = document.createElement('div');
    titleWrap.className = 'wandlight-lore-entry-title-wrap';

    const titleEl = document.createElement('span');
    titleEl.className = 'wandlight-lore-entry-title';
    titleEl.textContent = entry.title || '(Untitled lore)';
    addTooltip(titleEl, 'Click the card to expand details. Tags beside this title are editable search tags.');
    titleWrap.appendChild(titleEl);
    headerRow.appendChild(titleWrap);

    const actions = document.createElement('div');
    actions.className = 'wandlight-lore-entry-actions';
    actions.appendChild(createEditableLifecycleBadge(entry));

    const pinBtn = createIconButton(
        entry.isPinned ? 'Pinned' : 'Pin',
        entry.isPinned ? 'Remove this entry from pinned lore. Pinned lore is prioritized for injection.' : 'Pin this entry so it is prioritized for injection.',
        'wandlight-lore-entry-btn',
        (e) => {
            e.stopPropagation();
            togglePinEntry(entry.id, { deferSave: true });
            if (!refreshAcceptedLoreRow(entry.id)) refreshAcceptedLoreList({ preserveScroll: true });
            refreshAcceptedLoreBulkToolbar();
            refreshHeader();
            refreshLoreWorkbench();
        }
    );
    actions.appendChild(pinBtn);

    const suppressBtn = createIconButton(
        entry.isSuppressed ? 'Muted' : 'Mute',
        entry.isSuppressed ? 'Unmute this entry so it can become active again.' : 'Mute this entry so it will not be injected into prompts.',
        'wandlight-lore-entry-btn',
        (e) => {
            e.stopPropagation();
            toggleSuppressEntry(entry.id, { deferSave: true });
            if (!refreshAcceptedLoreRow(entry.id)) refreshAcceptedLoreList({ preserveScroll: true });
            refreshAcceptedLoreBulkToolbar();
            refreshHeader();
            refreshLoreWorkbench();
        }
    );
    actions.appendChild(suppressBtn);

    headerRow.appendChild(actions);
    card.appendChild(headerRow);

    const metaRow = document.createElement('div');
    metaRow.className = 'wandlight-lore-entry-meta';
    if (isExpanded) {
        metaRow.appendChild(createEditableLoreMetaBadge(entry, 'category', entry.category || 'other', null, `Category: ${entry.category || 'canon'}. Use dropdown to change.`));
        metaRow.appendChild(createLorePurposeBadge(entry));
        metaRow.appendChild(createEditableLoreMetaBadge(entry, 'canonStatus', entry.canon || entry.canonStatus || 'canon', null, `Canon/Story: ${entry.canon || entry.canonStatus || 'canon'}. Use dropdown to change.`));
        metaRow.appendChild(createEditableLoreMetaBadge(entry, 'truthStatus', entry.truthStatus || 'true', null, `Truth/reveal status: ${entry.truthStatus || 'true'}. Use dropdown to change.`));
        metaRow.appendChild(createEditableLoreMetaBadge(entry, 'revealPolicy', entry.revealPolicy || 'private', null, `Reveal policy: ${entry.revealPolicy || 'private'}. Use dropdown to change.`));
        metaRow.appendChild(createEditablePriorityBadge(entry));
    } else {
        metaRow.appendChild(createRegistryBadge('category', entry.category || 'other', `Category: ${entry.category || 'canon'}. Expand the entry to edit.`));
        metaRow.appendChild(createLorePurposeBadge(entry));
        metaRow.appendChild(createRegistryBadge('canonStatus', entry.canon || entry.canonStatus || 'canon', `Canon/Story: ${entry.canon || entry.canonStatus || 'canon'}. Expand the entry to edit.`));
        metaRow.appendChild(createBadge(`P${Number(entry.priority || 50)}`, 'Priority. Expand the entry to edit.'));
    }
    metaRow.appendChild(createSpellMetadataBadges(entry));
    if (entry.isPending) metaRow.appendChild(createBadge('pending', 'This entry is pending review.'));
    if (entry.isPinned) metaRow.appendChild(createBadge('pinned', 'Pinned entries are prioritized for injection.'));
    if (entry.isSuppressed) metaRow.appendChild(createBadge('muted', 'Muted entries are excluded from injection.'));
    card.appendChild(metaRow);

    card.appendChild(createTagsRow(entry));

    const factEl = document.createElement('div');
    factEl.className = 'wandlight-lore-entry-fact';
    factEl.textContent = truncateText(entry.fact || '', 140);
    addTooltip(factEl, 'Lore fact text. Expand the card to inspect the full entry.');
    card.appendChild(factEl);

    card.addEventListener('click', () => {
        const currentPanelState = getState()?.lorePanel || {};
        const newId = currentPanelState.selectedEntryId === entry.id ? '' : entry.id;
        setPanelState({ selectedEntryId: newId }, { deferSave: true });
        if (!refreshAcceptedLoreRow(entry.id)) refreshAcceptedLoreList({ preserveScroll: true });
    });

    if (isExpanded) {
        const details = document.createElement('div');
        details.className = 'wandlight-lore-entry-details';

        details.appendChild(createEditableLoreEntryEditor(entry));

        if (entry.fact && entry.fact.length > 140) {
            const fullFact = document.createElement('div');
            fullFact.className = 'wandlight-lore-entry-full-fact';
            fullFact.textContent = entry.fact;
            details.appendChild(fullFact);
        }

        const detailRows = [];
        if (entry.source) detailRows.push(['Source', entry.source]);
        if (hasDisplayableScope(entry.scope)) detailRows.push(['Scope', entry.scope]);
        if (entry.appliesTo?.length) detailRows.push(['Applies to', entry.appliesTo.join(', ')]);
        if (entry.publicVersion) detailRows.push(['Public version', entry.publicVersion]);
        if (entry.whoKnowsTruth?.length) detailRows.push(['Who knows truth', entry.whoKnowsTruth.join(', ')]);
        if (entry.whoSuspects?.length) detailRows.push(['Who suspects', entry.whoSuspects.join(', ')]);
        if (entry.revealPolicy) detailRows.push(['Reveal policy', entry.revealPolicy]);
        if (entry.validFrom || entry.validTo) detailRows.push(['Valid window', `${entry.validFrom || '...'} to ${entry.validTo || '...'}`]);
        if (entry.notes) detailRows.push(['Notes', entry.notes]);

        for (const [label, value] of detailRows) {
            details.appendChild(createKeyValue(label, value, `${label} metadata for this lore entry.`));
        }

        const aw = entry.activeWhen || {};
        const conditions = [];
        if (aw.erasAny?.length) conditions.push(`Eras: ${aw.erasAny.join(', ')}`);
        if (aw.locationsAny?.length) conditions.push(`Locations: ${aw.locationsAny.join(', ')}`);
        if (aw.charactersPresentAny?.length) conditions.push(`Cast: ${aw.charactersPresentAny.join(', ')}`);
        if (aw.tagsAny?.length) conditions.push(`Tags: ${aw.tagsAny.join(', ')}`);
        if (conditions.length) {
            const cond = document.createElement('div');
            cond.className = 'wandlight-lore-entry-conditions';
            cond.textContent = `Relevant when: ${conditions.join(' | ')}`;
            addTooltip(cond, 'Context conditions used to determine whether this lore entry should be active.');
            details.appendChild(cond);
        }

        if (entry.isPending) {
            const pendingActions = document.createElement('div');
            pendingActions.className = 'wandlight-lore-entry-pending-actions';
            pendingActions.appendChild(createButton('Apply', 'Accepts this pending entry into the lore matrix.', (btn, e) => {
                e?.stopPropagation?.();
                const current = getState();
                const pending = normalizeLoreMatrix(current?.pendingLoreEntries || []);
                const idx = pending.findIndex(pe => pe.id === entry.id);
                if (idx >= 0) {
                    acceptPendingLoreEntry(idx);
                    refreshPanelBody({ preserveScroll: true });
                    refreshHeader();
                }
            }, 'wandlight-primary-button'));
            pendingActions.appendChild(createButton('Dismiss', 'Rejects this pending entry.', (btn, e) => {
                e?.stopPropagation?.();
                const current = getState();
                const pending = normalizeLoreMatrix(current?.pendingLoreEntries || []);
                const idx = pending.findIndex(pe => pe.id === entry.id);
                if (idx >= 0) {
                    rejectPendingLoreEntry(idx);
                    refreshPanelBody({ preserveScroll: true });
                    refreshHeader();
                }
            }));
            details.appendChild(pendingActions);
        }

        card.appendChild(details);
    }

    return card;
}

// Tags ------------------------------------------------------------------------

function createTagsRow(entry) {
    const row = document.createElement('div');
    row.className = 'wandlight-lore-entry-tags';
    addTooltip(row, 'Tags are editable search labels. Search matches tags as well as entry titles.');

    const tags = Array.isArray(entry.tags) ? entry.tags : [];
    for (const tag of tags) {
        const chip = document.createElement('span');
        chip.className = 'wandlight-lore-tag-chip';

        const removeBtn = document.createElement('button');
        removeBtn.className = 'wandlight-lore-tag-remove';
        removeBtn.type = 'button';
        removeBtn.textContent = 'x';
        addTooltip(removeBtn, `Remove tag: ${tag}`);
        removeBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            removeLoreTag(entry.id, tag, { deferSave: true });
            if (!refreshAcceptedLoreRow(entry.id)) refreshAcceptedLoreList({ preserveScroll: true });
            refreshLoreWorkbench();
        });
        chip.appendChild(removeBtn);

        const label = document.createElement('span');
        label.className = 'wandlight-lore-tag-label';
        label.textContent = tag;
        chip.appendChild(label);
        row.appendChild(chip);
    }

    const addBtn = document.createElement('button');
    addBtn.className = 'wandlight-lore-tag-add';
    addBtn.type = 'button';
    addBtn.textContent = '+';
    addTooltip(addBtn, 'Add a searchable tag to this lore entry.');
    addBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showInlineTagInput(row, entry.id, addBtn);
    });
    row.appendChild(addBtn);

    return row;
}

function createReadOnlyTags(tags) {
    const row = document.createElement('div');
    row.className = 'wandlight-lore-entry-tags';
    for (const tag of tags) {
        const chip = document.createElement('span');
        chip.className = 'wandlight-lore-tag-chip';
        const label = document.createElement('span');
        label.className = 'wandlight-lore-tag-label';
        label.textContent = tag;
        chip.appendChild(label);
        row.appendChild(chip);
    }
    return row;
}

function showInlineTagInput(row, entryId, addBtn) {
    if (row.querySelector('.wandlight-lore-tag-input')) return;

    const input = document.createElement('input');
    input.className = 'wandlight-lore-tag-input';
    input.type = 'text';
    input.placeholder = 'tag';
    addTooltip(input, 'Type a tag and press Enter. Press Escape to cancel.');

    input.addEventListener('click', e => e.stopPropagation());
    input.addEventListener('mousedown', e => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            input.dataset.committed = '1';
            commitInlineTagInput(entryId, input.value);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            input.remove();
        }
    });
    input.addEventListener('blur', () => {
        if (input.dataset.committed === '1') return;
        if (input.value.trim()) {
            input.dataset.committed = '1';
            commitInlineTagInput(entryId, input.value);
        } else {
            input.remove();
        }
    });

    row.insertBefore(input, addBtn);
    requestAnimationFrame(() => input.focus());
}

function commitInlineTagInput(entryId, rawTag) {
    const tag = normalizeTag(rawTag);
    if (!tag) {
        refreshPanelBody({ preserveScroll: true });
        return;
    }
    addLoreTag(entryId, tag, { deferSave: true });
    if (!refreshAcceptedLoreRow(entryId)) refreshAcceptedLoreList({ preserveScroll: true });
    refreshLoreWorkbench();
}

function normalizeTag(value) {
    return normalizeLoreTag(value);
}

function updateLoreEntryById(entryId, updater, options = {}) {
    const state = getState();
    if (!entryId || typeof updater !== 'function') return false;
    const beforeTimeline = captureLoreTimelineState(state);

    for (const key of ['loreMatrix', 'pendingLoreEntries']) {
        const list = Array.isArray(state[key]) ? state[key] : [];
        const idx = list.findIndex(entry => entry?.id === entryId);
        if (idx >= 0) {
            const updated = normalizeLoreEntry(updater(list[idx]));
            updated.userEdited = true;
            list[idx] = updated;
            state[key] = list;
            if (key === 'loreMatrix') {
                recordLoreTimelineEvent(state, {
                    before: beforeTimeline,
                    after: captureLoreTimelineState(state),
                    type: options.timelineType || 'edit',
                    source: options.timelineSource || 'manual',
                    summary: options.timelineSummary || `Edited lore entry: ${updated.title || updated.id}.`,
                });
            }
            if (options.deferSave) scheduleStateSave(state);
            else saveState(state);
            return true;
        }
    }
    return false;
}

function addLoreTag(entryId, tag, options = {}) {
    const clean = normalizeTag(tag);
    if (!clean) return false;
    return updateLoreEntryById(entryId, (entry) => {
        const tags = Array.isArray(entry.tags) ? entry.tags.map(normalizeTag).filter(Boolean) : [];
        const exists = tags.some(t => t.toLowerCase() === clean.toLowerCase());
        return { ...entry, tags: exists ? tags : [...tags, clean] };
    }, options);
}

function removeLoreTag(entryId, tag, options = {}) {
    const clean = normalizeTag(tag).toLowerCase();
    return updateLoreEntryById(entryId, (entry) => ({
        ...entry,
        tags: (Array.isArray(entry.tags) ? entry.tags : [])
            .map(normalizeTag)
            .filter(t => t && t.toLowerCase() !== clean),
    }), options);
}

function scheduleStateSave(state, delay = MINOR_STATE_SAVE_DEBOUNCE_MS) {
    deferredStateSaveRef = state || deferredStateSaveRef;
    if (deferredStateSaveTimer) clearTimeout(deferredStateSaveTimer);
    deferredStateSaveTimer = setTimeout(() => {
        if (deferredStateSaveRef) saveState(deferredStateSaveRef);
        deferredStateSaveRef = null;
        deferredStateSaveTimer = null;
    }, delay);
}

function flushScheduledStateSave() {
    if (deferredStateSaveTimer) clearTimeout(deferredStateSaveTimer);
    if (deferredStateSaveRef) saveState(deferredStateSaveRef);
    deferredStateSaveRef = null;
    deferredStateSaveTimer = null;
}

// Mutations -------------------------------------------------------------------

function togglePinEntry(entryId, options = {}) {
    const state = getState();
    if (!state?.loreSelection) return;
    const beforeTimeline = captureLoreTimelineState(state);
    const sel = state.loreSelection;
    sel.pinnedIds = Array.isArray(sel.pinnedIds) ? sel.pinnedIds : [];
    sel.suppressedIds = Array.isArray(sel.suppressedIds) ? sel.suppressedIds : [];
    const idx = sel.pinnedIds.indexOf(entryId);
    if (idx >= 0) {
        sel.pinnedIds.splice(idx, 1);
    } else {
        sel.pinnedIds.push(entryId);
        const supIdx = sel.suppressedIds.indexOf(entryId);
        if (supIdx >= 0) sel.suppressedIds.splice(supIdx, 1);
    }
    recordLoreTimelineEvent(state, {
        before: beforeTimeline,
        after: captureLoreTimelineState(state),
        type: idx >= 0 ? 'unpin' : 'pin',
        source: 'manual',
        summary: `${idx >= 0 ? 'Unpinned' : 'Pinned'} lore entry.`,
    });
    if (options.deferSave) scheduleStateSave(state);
    else saveState(state);
}

function toggleSuppressEntry(entryId, options = {}) {
    const state = getState();
    if (!state?.loreSelection) return;
    const beforeTimeline = captureLoreTimelineState(state);
    const sel = state.loreSelection;
    sel.pinnedIds = Array.isArray(sel.pinnedIds) ? sel.pinnedIds : [];
    sel.suppressedIds = Array.isArray(sel.suppressedIds) ? sel.suppressedIds : [];
    const idx = sel.suppressedIds.indexOf(entryId);
    if (idx >= 0) {
        sel.suppressedIds.splice(idx, 1);
    } else {
        sel.suppressedIds.push(entryId);
        const pinIdx = sel.pinnedIds.indexOf(entryId);
        if (pinIdx >= 0) sel.pinnedIds.splice(pinIdx, 1);
    }
    recordLoreTimelineEvent(state, {
        before: beforeTimeline,
        after: captureLoreTimelineState(state),
        type: idx >= 0 ? 'unmute' : 'mute',
        source: 'manual',
        summary: `${idx >= 0 ? 'Unmuted' : 'Muted'} lore entry.`,
    });
    if (options.deferSave) scheduleStateSave(state);
    else saveState(state);
}

function setAutomationMode(mode) {
    const normalized = normalizeAutomationMode(mode);
    const settings = getSettings();
    settings.automationMode = normalized;
    settings.workflowMode = normalized;
    Object.assign(settings, AUTOMATION_MODES[normalized].settings);
    saveSettings(settings);
}

function setExperienceMode(mode) {
    const normalized = normalizeExperienceMode(mode);
    const settings = getSettings();
    const current = normalizeExperienceMode(settings.experienceMode);
    if (current === normalized) return;

    if (normalized === 'basic') {
        settings.advancedExperienceSettingsBackup = pickManagedExperienceSettings(settings);
        Object.assign(settings, BASIC_EXPERIENCE_SETTINGS);
        settings.experienceMode = 'basic';
        settings.basicExperienceProfileVersion = BASIC_EXPERIENCE_PROFILE_VERSION;
    } else {
        const backup = isPlainObjectValue(settings.advancedExperienceSettingsBackup)
            ? settings.advancedExperienceSettingsBackup
            : {};
        for (const key of BASIC_EXPERIENCE_MANAGED_SETTING_KEYS) {
            if (Object.prototype.hasOwnProperty.call(backup, key)) {
                settings[key] = backup[key];
            } else if (Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) {
                settings[key] = DEFAULT_SETTINGS[key];
            }
        }
        settings.experienceMode = 'advanced';
        settings.workflowMode = settings.automationMode || settings.workflowMode || 'manual';
    }

    saveSettings(settings);
    const state = getState();
    if (state?.lorePanel) {
        normalizePanelLayoutState(state);
        state.lorePanel.activeTab = normalizeTabForExperience(state.lorePanel.activeTab, settings);
        saveState(state);
    }
}

function pickManagedExperienceSettings(settings = {}) {
    const backup = {};
    for (const key of BASIC_EXPERIENCE_MANAGED_SETTING_KEYS) {
        if (Object.prototype.hasOwnProperty.call(settings, key)) backup[key] = settings[key];
    }
    return backup;
}

function setPanelState(patch, options = {}) {
    const state = getState();
    if (!state?.lorePanel) return;
    Object.assign(state.lorePanel, patch || {});
    if (options.deferSave) scheduleStateSave(state);
    else saveState(state);
}

function toggleCollapse() {
    const state = getState();
    if (!state?.lorePanel) return;
    normalizePanelLayoutState(state);
    state.lorePanel.drawerOpen = state.lorePanel.drawerOpen !== true;
    state.lorePanel.collapsed = state.lorePanel.drawerOpen !== true;
    saveState(state);
    showLorePanel();
}

function setDrawerOpen(open) {
    const state = getState();
    if (!state?.lorePanel) return;
    normalizePanelLayoutState(state);
    state.lorePanel.drawerOpen = open === true;
    state.lorePanel.collapsed = state.lorePanel.drawerOpen !== true;
    saveState(state);
    showLorePanel();
}

export function resetLorePanelLayout(options = {}) {
    const state = getState();
    if (!state) return;
    if (!state.lorePanel || typeof state.lorePanel !== 'object') {
        state.lorePanel = getDefaultState().lorePanel;
    }

    const drawerWidth = Number(getDefaultState()?.lorePanel?.drawerWidth) || 560;
    const drawerHeight = Number(getDefaultState()?.lorePanel?.drawerHeight) || 640;
    const railX = DEFAULT_RAIL_LEFT;
    const railY = getDefaultRailY({ railMode: 'compact' });

    Object.assign(state.lorePanel, {
        railMode: 'compact',
        railX,
        railY,
        drawerOpen: false,
        activeTab: 'session',
        drawerWidth,
        drawerHeight,
        collapsed: true,
        isOpen: true,
        x: railX,
        y: railY,
        width: drawerWidth,
        height: drawerHeight,
        layoutVersion: LAYOUT_VERSION,
    });

    const settings = getSettings();
    settings.collapsedSections = { ...(DEFAULT_SETTINGS.collapsedSections || {}) };
    saveSettings(settings);
    saveState(state);
    showLorePanel();

    const schedule = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (fn) => setTimeout(fn, 0);
    schedule(() => centerRuntimeRailInViewport({ forceLeft: true, persist: true }));

    if (typeof toastr !== 'undefined' && options.silent !== true) {
        toastr.success('Wandlight window layout reset.');
    }
}

function toggleDrawerForTab(tabId) {
    const state = getState();
    if (!state?.lorePanel) return;
    normalizePanelLayoutState(state);
    const settings = getSettings();
    const normalizedTab = normalizeTabForExperience(tabId, settings);
    const sameActiveTab = normalizeTabForExperience(state.lorePanel.activeTab, settings) === normalizedTab;
    const shouldClose = sameActiveTab && state.lorePanel.drawerOpen === true;
    state.lorePanel.activeTab = normalizedTab;
    state.lorePanel.drawerOpen = !shouldClose;
    state.lorePanel.collapsed = shouldClose;
    saveState(state);
    showLorePanel();
}

function toggleRailMode() {
    const state = getState();
    if (!state?.lorePanel) return;
    normalizePanelLayoutState(state);
    state.lorePanel.railMode = normalizeRailMode(state.lorePanel.railMode) === 'compact' ? 'expanded' : 'compact';
    saveState(state);
    showLorePanel();
}

function refreshPanelBody(options = {}) {
    if (!panelRoot) return;
    const stateForShell = getState();
    normalizePanelLayoutState(stateForShell);
    const body = panelRoot.querySelector('.wandlight-lore-panel-body');
    if (!body) {
        if (stateForShell?.lorePanel?.drawerOpen === true) renderPanelShell(panelRoot, stateForShell);
        else refreshHeader();
        return;
    }

    const activeNestedScroll = getActiveNestedScrollElement();
    const nestedScrollTop = options.preserveScroll && activeNestedScroll ? activeNestedScroll.scrollTop : 0;
    const tabScroll = getActiveTabScrollElement();
    const tabScrollTop = options.preserveScroll && tabScroll ? tabScroll.scrollTop : 0;
    const drawer = panelRoot.querySelector('.wandlight-runtime-drawer');
    const drawerScrollTop = options.preserveScroll && drawer ? (drawer.scrollTop || 0) : 0;
    const pageScrollElement = typeof document !== 'undefined' ? document.scrollingElement || document.documentElement : null;
    const pageScrollTop = (options.preserveScroll || options.preserveWindowScroll) && pageScrollElement
        ? pageScrollElement.scrollTop
        : null;
    const pageScrollLeft = (options.preserveScroll || options.preserveWindowScroll) && pageScrollElement
        ? pageScrollElement.scrollLeft
        : null;

    const state = stateForShell;
    renderPanelBody(body, state);
    refreshHeader();

    if (options.preserveScroll) {
        const newTabScroll = getActiveTabScrollElement();
        if (newTabScroll) newTabScroll.scrollTop = tabScrollTop;
        const newNestedScroll = getActiveNestedScrollElement();
        if (newNestedScroll) newNestedScroll.scrollTop = nestedScrollTop;
        if (drawer) drawer.scrollTop = drawerScrollTop;
    }
    updateDrawerScrollMetrics(drawer);

    if ((options.preserveScroll || options.preserveWindowScroll) && pageScrollElement && pageScrollTop !== null) {
        const restorePageScroll = () => {
            pageScrollElement.scrollTop = pageScrollTop;
            pageScrollElement.scrollLeft = pageScrollLeft || 0;
        };
        restorePageScroll();
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restorePageScroll);
    }
}

function getActiveTabScrollElement() {
    if (!panelRoot) return null;
    return panelRoot.querySelector('.wandlight-runtime-tab-body');
}

function getActiveNestedScrollElement() {
    if (!panelRoot) return null;
    return panelRoot.querySelector('.wandlight-accepted-lore-scroll-region')
        || panelRoot.querySelector('.wandlight-pending-lore-list')
        || panelRoot.querySelector('.wandlight-injection-preview')
        || panelRoot.querySelector('.wandlight-continuity-json-editor');
}

// Drag and resize -------------------------------------------------------------

function onDragStart(e) {
    if (!panelRoot) return;
    if (e.target.closest('button, input, textarea, select, .wandlight-lore-panel-resize-handle')) return;

    isDragging = true;
    const rect = panelRoot.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;

    panelRoot.style.left = `${rect.left}px`;
    panelRoot.style.top = `${rect.top}px`;
    panelRoot.style.right = '';
    panelRoot.style.bottom = '';
    panelRoot.classList.add('wandlight-runtime-dragging');

    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
}

function onDragMove(e) {
    if (!isDragging || !panelRoot) return;
    const state = getState();
    const panelState = normalizePanelLayoutState(state) || {};
    const railWidth = getRailWidth(panelState);
    const railHeight = panelRoot.querySelector('.wandlight-runtime-rail')?.offsetHeight || 80;
    const x = e.clientX - dragOffsetX;
    const y = e.clientY - dragOffsetY;
    const maxX = Math.max(0, getViewportWidth() - railWidth);
    const maxY = Math.max(0, getViewportHeight() - Math.min(railHeight, getViewportHeight()));
    panelRoot.style.left = `${Math.max(0, Math.min(x, maxX))}px`;
    panelRoot.style.top = `${Math.max(0, Math.min(y, maxY))}px`;
}

function onDragEnd() {
    if (!panelRoot) return;
    isDragging = false;
    panelRoot.classList.remove('wandlight-runtime-dragging');
    saveRailGeometry();
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
}

function onResizeStart(e) {
    if (e.button !== 0 || !panelRoot) return;
    const drawer = panelRoot.querySelector('.wandlight-runtime-drawer');
    if (!drawer) return;

    isResizing = true;
    const rect = drawer.getBoundingClientRect();
    resizeStartX = e.clientX;
    resizeStartY = e.clientY;
    resizeStartWidth = rect.width;
    resizeStartHeight = rect.height;
    resizeStartDirection = panelRoot.dataset.drawerDirection === 'left' ? 'left' : 'right';

    drawer.classList.add('wandlight-lore-panel-resizing');

    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);

    document.addEventListener('pointermove', onResizeMove);
    document.addEventListener('pointerup', onResizeEnd);
    document.addEventListener('pointercancel', onResizeEnd);
}

function onResizeMove(e) {
    if (!isResizing || !panelRoot) return;
    const drawer = panelRoot.querySelector('.wandlight-runtime-drawer');
    if (!drawer) return;
    const state = getState();
    const panelState = normalizePanelLayoutState(state) || {};
    const railX = Number(panelState.railX) || 0;
    const railWidth = getRailWidth(panelState);
    const maxWidth = resizeStartDirection === 'left'
        ? Math.max(MIN_DRAWER_WIDTH, railX - RAIL_DRAWER_GAP - MAX_PANEL_MARGIN)
        : Math.max(MIN_DRAWER_WIDTH, getViewportWidth() - railX - railWidth - RAIL_DRAWER_GAP - MAX_PANEL_MARGIN);
    const maxHeight = Math.max(MIN_DRAWER_HEIGHT, window.innerHeight - (Number(panelState.railY) || 0) - MAX_PANEL_MARGIN);
    const deltaX = e.clientX - resizeStartX;
    const requestedWidth = resizeStartDirection === 'left'
        ? resizeStartWidth - deltaX
        : resizeStartWidth + deltaX;
    const width = Math.max(MIN_DRAWER_WIDTH, Math.min(maxWidth, requestedWidth));
    const height = Math.max(MIN_DRAWER_HEIGHT, Math.min(maxHeight, resizeStartHeight + (e.clientY - resizeStartY)));
    drawer.style.width = `${width}px`;
    drawer.style.height = `${height}px`;
    panelRoot.style.setProperty('--wandlight-drawer-width', `${width}px`);
    panelRoot.style.setProperty('--wandlight-drawer-height', `${height}px`);
    updateDrawerScrollMetrics(drawer);
    updateAcceptedLoreScrollRegionHeight();
}

function onResizeEnd() {
    if (!isResizing || !panelRoot) return;
    isResizing = false;
    const drawer = panelRoot.querySelector('.wandlight-runtime-drawer');
    drawer?.classList.remove('wandlight-lore-panel-resizing');
    saveDrawerGeometry();
    document.removeEventListener('pointermove', onResizeMove);
    document.removeEventListener('pointerup', onResizeEnd);
    document.removeEventListener('pointercancel', onResizeEnd);
}

function saveRailGeometry() {
    if (!panelRoot) return;
    const state = getState();
    if (!state?.lorePanel) return;
    normalizePanelLayoutState(state);
    const rect = panelRoot.getBoundingClientRect();
    state.lorePanel.railX = Math.round(rect.left);
    state.lorePanel.railY = Math.round(rect.top);
    state.lorePanel.x = state.lorePanel.railX;
    state.lorePanel.y = state.lorePanel.railY;
    saveState(state);
}

function saveDrawerGeometry() {
    if (!panelRoot) return;
    const state = getState();
    if (!state?.lorePanel) return;
    normalizePanelLayoutState(state);
    const drawer = panelRoot.querySelector('.wandlight-runtime-drawer');
    if (!drawer) {
        saveState(state);
        return;
    }
    const rect = drawer.getBoundingClientRect();
    state.lorePanel.drawerWidth = Math.round(rect.width);
    state.lorePanel.drawerHeight = Math.round(rect.height);
    state.lorePanel.width = state.lorePanel.drawerWidth;
    state.lorePanel.height = state.lorePanel.drawerHeight;
    saveState(state);
}

function savePanelGeometry() {
    saveRailGeometry();
    saveDrawerGeometry();
}

// UI helpers ------------------------------------------------------------------

function createSectionHeader(title, description) {
    const wrap = document.createElement('div');
    wrap.className = 'wandlight-section-header';
    const h = document.createElement('h3');
    h.textContent = title;
    addTooltip(h, description);
    wrap.appendChild(h);
    const p = document.createElement('p');
    p.textContent = description;
    wrap.appendChild(p);
    return wrap;
}

function createToggleCard(label, checked, tooltip, onChange) {
    const card = document.createElement('label');
    card.className = 'wandlight-toggle-card';
    addTooltip(card, tooltip);

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!checked;
    card.appendChild(input);

    const text = document.createElement('span');
    text.textContent = label;
    card.appendChild(text);

    const state = document.createElement('span');
    state.className = 'wandlight-toggle-state';
    state.textContent = checked ? 'On' : 'Off';
    card.appendChild(state);

    input.addEventListener('change', () => {
        state.textContent = input.checked ? 'On' : 'Off';
        onChange(input.checked);
    });

    return card;
}

function markTourTarget(el, target) {
    if (el && target) el.dataset.wandlightTour = String(target);
    return el;
}

function startWandlightTour(mode = normalizeExperienceMode(getSettings().experienceMode)) {
    const normalized = normalizeExperienceMode(mode);
    const steps = [...(GUIDE_STEPS[normalized] || GUIDE_STEPS.basic)];
    if (!steps.length) return;

    closeWandlightTour({ preserveToast: true });
    activeWandlightTour = {
        mode: normalized,
        steps,
        index: 0,
        renderToken: 0,
        currentTarget: null,
    };
    document.addEventListener('keydown', onWandlightTourKeydown);
    window.addEventListener('resize', repositionWandlightTourPopover);
    renderActiveWandlightTourStep();
}

function renderActiveWandlightTourStep(skipCount = 0) {
    const tour = activeWandlightTour;
    if (!tour) return;
    if (tour.index < 0) tour.index = 0;
    if (tour.index >= tour.steps.length) {
        closeWandlightTour();
        return;
    }

    const step = tour.steps[tour.index];
    showGuideStep(step, {
        highlight: true,
        tour: true,
        onReady: (target) => {
            if (!activeWandlightTour || activeWandlightTour !== tour) return;
            if (!target && skipCount < tour.steps.length - 1) {
                tour.index += 1;
                renderActiveWandlightTourStep(skipCount + 1);
                return;
            }
            renderWandlightTourPopover(step, target);
        },
    });
}

function showGuideStep(step, options = {}) {
    if (!step) return;

    for (const sectionId of step.expandSections || []) {
        setSectionCollapsed(sectionId, false);
    }

    const state = getState();
    if (state?.lorePanel) {
        normalizePanelLayoutState(state);
        state.lorePanel.drawerOpen = true;
        state.lorePanel.collapsed = false;
        state.lorePanel.activeTab = normalizeTabForExperience(step.tab || 'session');
        saveState(state);
    }
    showLorePanel();

    const token = activeWandlightTour ? ++activeWandlightTour.renderToken : 0;
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            if (activeWandlightTour && token !== activeWandlightTour.renderToken) return;
            const target = getTourTargetElement(step.target) || getTourTargetElement(step.fallbackTarget);
            if (options.highlight) {
                highlightWandlightTourTarget(target);
                if (!options.tour) {
                    window.setTimeout(() => {
                        if (!activeWandlightTour) clearWandlightTourHighlight();
                    }, 2200);
                }
            }
            if (!target && !options.tour) {
                toast(`${step.title || 'Feature'} is not visible in the current state.`, 'info');
            }
            options.onReady?.(target);
        });
    });
}

function getTourTargetElement(targetName) {
    if (!targetName) return null;
    const root = panelRoot || document.getElementById(PANEL_ID) || document.body;
    const candidates = [
        ...Array.from(root.querySelectorAll('[data-wandlight-tour]')),
        ...Array.from(document.querySelectorAll('[data-wandlight-tour]')),
    ];
    return candidates.find(el => el?.dataset?.wandlightTour === targetName) || null;
}

function highlightWandlightTourTarget(target) {
    clearWandlightTourHighlight();
    if (!target) return;
    target.classList.add('wandlight-tour-highlight');
    target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
}

function clearWandlightTourHighlight() {
    for (const el of document.querySelectorAll('.wandlight-tour-highlight')) {
        el.classList.remove('wandlight-tour-highlight');
    }
}

function renderWandlightTourPopover(step, target) {
    const tour = activeWandlightTour;
    if (!tour) return;

    let popover = document.getElementById('wandlight-tour-popover');
    if (!popover) {
        popover = document.createElement('div');
        popover.id = 'wandlight-tour-popover';
        popover.className = 'wandlight-tour-popover';
        document.body.appendChild(popover);
    }

    popover.innerHTML = '';
    const progress = document.createElement('div');
    progress.className = 'wandlight-tour-progress';
    progress.textContent = `${tour.index + 1} / ${tour.steps.length}`;
    popover.appendChild(progress);

    const title = document.createElement('div');
    title.className = 'wandlight-tour-title';
    title.textContent = step.title || 'Wandlight';
    popover.appendChild(title);

    const body = document.createElement('div');
    body.className = 'wandlight-tour-body';
    body.textContent = step.body || '';
    popover.appendChild(body);

    appendWandlightTourDetail(popover, 'When to use', step.when);
    appendWandlightTourDetail(popover, 'Expected result', step.expected);

    const actions = document.createElement('div');
    actions.className = 'wandlight-tour-actions';
    const back = createButton('Back', 'Return to the previous walkthrough step.', () => {
        if (!activeWandlightTour) return;
        activeWandlightTour.index = Math.max(0, activeWandlightTour.index - 1);
        renderActiveWandlightTourStep();
    }, 'wandlight-mini-button');
    back.disabled = tour.index <= 0;
    actions.appendChild(back);

    const close = createButton('Close', 'Close the walkthrough.', () => closeWandlightTour(), 'wandlight-mini-button');
    actions.appendChild(close);

    const nextLabel = tour.index >= tour.steps.length - 1 ? 'Finish' : 'Next';
    const next = createButton(nextLabel, nextLabel === 'Finish' ? 'Close the walkthrough.' : 'Move to the next walkthrough step.', () => {
        if (!activeWandlightTour) return;
        if (activeWandlightTour.index >= activeWandlightTour.steps.length - 1) {
            closeWandlightTour();
            return;
        }
        activeWandlightTour.index += 1;
        renderActiveWandlightTourStep();
    }, 'wandlight-primary-button wandlight-mini-button');
    actions.appendChild(next);
    popover.appendChild(actions);

    activeWandlightTour.currentTarget = target || null;
    requestAnimationFrame(repositionWandlightTourPopover);
}

function appendWandlightTourDetail(popover, labelText, value) {
    const text = String(value || '').trim();
    if (!text) return;
    const row = document.createElement('div');
    row.className = 'wandlight-tour-detail';
    const label = document.createElement('span');
    label.className = 'wandlight-tour-detail-label';
    label.textContent = `${labelText}:`;
    row.appendChild(label);
    row.appendChild(document.createTextNode(` ${text}`));
    popover.appendChild(row);
}

function repositionWandlightTourPopover() {
    const popover = document.getElementById('wandlight-tour-popover');
    if (!popover) return;
    const target = activeWandlightTour?.currentTarget;
    const margin = 12;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 768;
    const popRect = popover.getBoundingClientRect();

    if (!target) {
        popover.style.left = `${Math.max(margin, (viewportWidth - popRect.width) / 2)}px`;
        popover.style.top = `${Math.max(margin, (viewportHeight - popRect.height) / 2)}px`;
        return;
    }

    const rect = target.getBoundingClientRect();
    let left = rect.right + margin;
    if (left + popRect.width > viewportWidth - margin) {
        left = rect.left - popRect.width - margin;
    }
    if (left < margin) {
        left = rect.left + (rect.width / 2) - (popRect.width / 2);
    }
    left = Math.max(margin, Math.min(left, viewportWidth - popRect.width - margin));

    let top = rect.top + (rect.height / 2) - (popRect.height / 2);
    if (top < margin) top = rect.bottom + margin;
    if (top + popRect.height > viewportHeight - margin) top = rect.top - popRect.height - margin;
    top = Math.max(margin, Math.min(top, viewportHeight - popRect.height - margin));

    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
}

function closeWandlightTour(options = {}) {
    activeWandlightTour = null;
    clearWandlightTourHighlight();
    document.removeEventListener('keydown', onWandlightTourKeydown);
    window.removeEventListener('resize', repositionWandlightTourPopover);
    const popover = document.getElementById('wandlight-tour-popover');
    if (popover) popover.remove();
    if (!options.preserveToast) hideFloatingTooltip();
}

function onWandlightTourKeydown(event) {
    if (!activeWandlightTour) return;
    if (event.key === 'Escape') {
        event.preventDefault();
        closeWandlightTour();
    } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        if (activeWandlightTour.index >= activeWandlightTour.steps.length - 1) closeWandlightTour();
        else {
            activeWandlightTour.index += 1;
            renderActiveWandlightTourStep();
        }
    } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        activeWandlightTour.index = Math.max(0, activeWandlightTour.index - 1);
        renderActiveWandlightTourStep();
    }
}


function isPlainObjectValue(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

function uniqueDisplayStrings(value) {
    const rawValues = Array.isArray(value) ? value : (typeof value === 'string' ? value.split(',') : []);
    const seen = new Set();
    const out = [];
    for (const raw of rawValues) {
        if (raw && typeof raw === 'object') continue;
        const text = String(raw ?? '').trim();
        if (!text) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(text);
    }
    return out.sort(compareScopeDisplayValues);
}

function compareScopeDisplayValues(a, b) {
    const yearA = String(a).match(/\bYear\s+(\d+)\b/i);
    const yearB = String(b).match(/\bYear\s+(\d+)\b/i);
    if (yearA && yearB) return Number(yearA[1]) - Number(yearB[1]);
    const numA = String(a).match(/\b(19\d{2}|20\d{2})\b/);
    const numB = String(b).match(/\b(19\d{2}|20\d{2})\b/);
    if (numA && numB && numA[1] !== numB[1]) return Number(numA[1]) - Number(numB[1]);
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

function getDisplayableScopeEntries(scope = {}) {
    if (!isPlainObjectValue(scope)) return [];
    const known = new Set(LORE_SCOPE_DISPLAY_ORDER.map(item => item.key));
    const ordered = LORE_SCOPE_DISPLAY_ORDER
        .map(item => ({ ...item, values: uniqueDisplayStrings(scope[item.key]) }))
        .filter(item => item.values.length > 0);

    const extras = Object.entries(scope)
        .filter(([key]) => !known.has(key))
        .map(([key, value]) => ({ key, label: humanizeScopeKey(key), weight: 1, values: uniqueDisplayStrings(value) }))
        .filter(item => item.values.length > 0)
        .sort((a, b) => a.label.localeCompare(b.label));

    return [...ordered, ...extras];
}

function humanizeScopeKey(key) {
    return String(key || '')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^./, c => c.toUpperCase());
}

function hasDisplayableScope(scope) {
    return getDisplayableScopeEntries(scope).length > 0;
}

function formatLoreScope(scope = {}) {
    const entries = getDisplayableScopeEntries(scope);
    if (!entries.length) return 'Global / broad context';
    return entries
        .map(item => `${item.label}: ${item.values.join(', ')}`)
        .join(' | ');
}

function getLoreScopeSpecificity(entry = {}) {
    return getDisplayableScopeEntries(entry.scope || {}).reduce((total, item) => {
        const first = Math.max(0, Number(item.weight) || 1);
        const additional = Math.max(0, item.values.length - 1) * Math.max(1, Math.round(first / 8));
        return total + first + additional;
    }, 0);
}

function formatStructuredValue(value) {
    if (value == null) return '';
    if (Array.isArray(value)) return uniqueDisplayStrings(value).join(', ');
    if (!isPlainObjectValue(value)) return String(value);

    const parts = Object.entries(value)
        .map(([key, val]) => {
            if (Array.isArray(val) || typeof val === 'string') {
                const values = uniqueDisplayStrings(val);
                return values.length ? `${humanizeScopeKey(key)}: ${values.join(', ')}` : '';
            }
            if (isPlainObjectValue(val)) {
                const nested = Object.entries(val)
                    .map(([nestedKey, nestedValue]) => `${humanizeScopeKey(nestedKey)}=${formatStructuredValue(nestedValue)}`)
                    .filter(Boolean)
                    .join(', ');
                return nested ? `${humanizeScopeKey(key)}: ${nested}` : '';
            }
            const text = String(val ?? '').trim();
            return text ? `${humanizeScopeKey(key)}: ${text}` : '';
        })
        .filter(Boolean);

    return parts.join(' | ');
}

function formatKeyValueDisplay(label, value) {
    if (String(label || '').toLowerCase() === 'scope') return formatLoreScope(value);
    return formatStructuredValue(value);
}

function createKeyValue(label, value, tooltip) {
    const row = document.createElement('div');
    row.className = 'wandlight-key-value';
    addTooltip(row, tooltip || label);

    const k = document.createElement('span');
    k.className = 'wandlight-key';
    k.textContent = label;
    row.appendChild(k);

    const v = document.createElement('span');
    v.className = 'wandlight-value';
    v.textContent = formatKeyValueDisplay(label, value);
    row.appendChild(v);

    return row;
}

function createButton(label, tooltip, handler, className = '') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `wandlight-runtime-button ${className}`.trim();
    btn.textContent = label;
    addTooltip(btn, tooltip);
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        handler?.(btn, e);
    });
    return btn;
}

function createIconButton(label, tooltip, className, handler) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.textContent = label;
    addTooltip(btn, tooltip);
    btn.addEventListener('click', handler);
    return btn;
}


function getLoreBadgeClass(text) {
    const normalized = String(text || '')
        .trim()
        .toLowerCase()
        .replace(/^p\d+$/, 'priority')
        .replace(/[^a-z0-9]+/g, '-');
    return normalized ? `wandlight-lore-badge-${normalized}` : '';
}

function createBadge(text, tooltip) {
    const badge = document.createElement('span');
    badge.className = `wandlight-lore-badge ${getLoreBadgeClass(text)}`.trim();
    badge.textContent = text;
    addTooltip(badge, tooltip);
    return badge;
}

function createStatusPill(text, tooltip) {
    const pill = document.createElement('span');
    pill.className = 'wandlight-status-pill';
    pill.textContent = text;
    addTooltip(pill, tooltip);
    return pill;
}

function createEmptyMessage(text) {
    const empty = document.createElement('div');
    empty.className = 'wandlight-lore-empty';
    empty.textContent = text;
    return empty;
}

function addTooltip(el, text) {
    if (!el || !text) return el;
    el.dataset.wandlightTooltip = text;
    el.setAttribute('aria-label', text);
    // Do not use native title for primary behavior; it is slow, inconsistent,
    // and the CSS pseudo-tooltip was clipped by the floating window.
    el.removeAttribute('title');
    el.addEventListener('mouseenter', () => showFloatingTooltip(el));
    el.addEventListener('focus', () => showFloatingTooltip(el));
    el.addEventListener('mouseleave', hideFloatingTooltip);
    el.addEventListener('blur', hideFloatingTooltip);
    return el;
}

function showFloatingTooltip(anchor) {
    const text = anchor?.dataset?.wandlightTooltip;
    if (!text) return;
    tooltipAnchor = anchor;
    if (!floatingTooltip) {
        floatingTooltip = document.createElement('div');
        floatingTooltip.className = 'wandlight-floating-tooltip';
        document.body.appendChild(floatingTooltip);
    }
    floatingTooltip.textContent = text;
    floatingTooltip.style.display = 'block';
    requestAnimationFrame(() => positionFloatingTooltip(anchor));
}

function positionFloatingTooltip(anchor) {
    if (!floatingTooltip || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const tipRect = floatingTooltip.getBoundingClientRect();
    const margin = 8;

    let left = rect.left + (rect.width / 2) - (tipRect.width / 2);
    left = Math.max(margin, Math.min(left, window.innerWidth - tipRect.width - margin));

    let top = rect.top - tipRect.height - margin;
    if (top < margin) {
        top = rect.bottom + margin;
    }
    top = Math.max(margin, Math.min(top, window.innerHeight - tipRect.height - margin));

    floatingTooltip.style.left = `${left}px`;
    floatingTooltip.style.top = `${top}px`;
}

function hideFloatingTooltip() {
    tooltipAnchor = null;
    if (floatingTooltip) floatingTooltip.style.display = 'none';
}

async function runBusyAction(btn, busyText, action) {
    if (!btn || typeof action !== 'function') return;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = busyText;
    try {
        await action();
    } catch (e) {
        console.error('[Wandlight] Runtime action failed:', e);
        toast(e?.message ? `Action failed: ${e.message}` : 'Action failed.', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = original;
    }
}

async function confirmAction(title, message) {
    const hasPopupConfirm = typeof Popup !== 'undefined' && Popup.show && typeof Popup.show.confirm === 'function';
    if (hasPopupConfirm) return await Popup.show.confirm(title, message);
    if (typeof confirm === 'function') return confirm(`${title}\n\n${message}`);
    return true;
}

async function showNoticePopup(title, message) {
    const hasPopupAlert = typeof Popup !== 'undefined' && Popup.show && typeof Popup.show.alert === 'function';
    if (hasPopupAlert) {
        await Popup.show.alert(title, message);
        return;
    }
    if (typeof alert === 'function') {
        alert(`${title}\n\n${message}`);
        return;
    }
    toast(message, 'info');
}

function toast(message, type = 'success') {
    if (typeof toastr === 'undefined') return;
    if (type === 'error' && toastr.error) toastr.error(message);
    else if (type === 'warning' && toastr.warning) toastr.warning(message);
    else if (type === 'info' && toastr.info) toastr.info(message);
    else if (toastr.success) toastr.success(message);
}

function normalizeTab(tab) {
    return Object.prototype.hasOwnProperty.call(TAB_LABELS, tab) ? tab : 'session';
}

function getVisibleTabsForExperience(settings = getSettings()) {
    return normalizeExperienceMode(settings?.experienceMode) === 'basic'
        ? BASIC_EXPERIENCE_TABS
        : ADVANCED_EXPERIENCE_TABS;
}

function isBasicExperience(settings = getSettings()) {
    return normalizeExperienceMode(settings?.experienceMode) === 'basic';
}

function normalizeTabForExperience(tab, settings = getSettings()) {
    const normalized = normalizeTab(tab);
    return getVisibleTabsForExperience(settings).includes(normalized) ? normalized : 'session';
}

function normalizeAutomationMode(mode) {
    return Object.prototype.hasOwnProperty.call(AUTOMATION_MODES, mode) ? mode : 'manual';
}

function normalizeExperienceMode(mode) {
    return mode === 'advanced' ? 'advanced' : 'basic';
}

function getAutomationLabel(settings) {
    return AUTOMATION_MODES[normalizeAutomationMode(settings?.automationMode || settings?.workflowMode)].label;
}

function getAutomationTooltip(settings) {
    return AUTOMATION_MODES[normalizeAutomationMode(settings?.automationMode || settings?.workflowMode)].description;
}

function getExperienceLabel(settings) {
    return normalizeExperienceMode(settings?.experienceMode) === 'advanced' ? 'Advanced' : 'Basic';
}

function getExperienceTooltip(settings) {
    return normalizeExperienceMode(settings?.experienceMode) === 'advanced'
        ? 'Advanced Experience gives you detailed control over Wandlight behavior.'
        : 'Basic Experience keeps Wandlight focused on the main roleplay workflow.';
}

function getCategoryCount(cat, entries, counts) {
    if (cat === 'all') return counts.all;
    if (cat === 'active' || cat === 'high') return counts.high || counts.active || 0;
    if (cat === 'normal') return counts.normal || 0;
    if (cat === 'low') return counts.low || 0;
    if (cat === 'pinned') return counts.pinned;
    if (cat === 'suppressed') return counts.suppressed;
    if (cat === 'pending') return counts.pending;
    return entries.filter(e => e.category === cat).length;
}

function getCategoryTooltip(cat) {
    const registryMeta = getLoreRegistryMeta('categories', cat);
    if (registryMeta?.description) return registryMeta.description;
    const map = {
        all: 'Shows every accepted and pending lore entry.',
        active: 'Legacy alias for High Relevance.',
        high: 'Shows accepted lore in the High-Relevance injection tier.',
        normal: 'Shows accepted lore in the Normal-Relevance injection tier.',
        low: 'Shows accepted lore in the Low-Relevance injection tier.',
        pinned: 'Shows entries manually prioritized and protected during injection/compression.',
        suppressed: 'Shows muted entries excluded from injection.',
        pending: 'Shows generated entries that still need review.',
    };
    return map[cat] || `Shows lore entries in category: ${cat}.`;
}

function getPendingLoreBatchLabel(state) {
    const meta = state?.pendingLoreMeta || {};
    const parts = [];
    if (meta.createdAt) parts.push(`Generated ${new Date(meta.createdAt).toLocaleString()}`);
    if (meta.status) parts.push(`status: ${meta.status}`);
    if (meta.generationMode) parts.push(`${meta.generationMode} mode`);
    if (meta.targetEntryCount) parts.push(`target ${meta.targetEntryCount}`);
    if (meta.validEntryCount !== undefined) parts.push(`${meta.validEntryCount} valid`);
    if (meta.rawEntryCount !== undefined) parts.push(`${meta.rawEntryCount} raw`);
    if (meta.normalizedEntryCount !== undefined) parts.push(`${meta.normalizedEntryCount} normalized`);
    if (meta.droppedDuplicateCount) parts.push(`${meta.droppedDuplicateCount} duplicates filtered`);
    if (meta.droppedEntryCount) parts.push(`${meta.droppedEntryCount} dropped`);
    if (meta.chunkCount) parts.push(`${meta.chunkCount} chunks`);
    if (meta.sourceMessageCount) parts.push(`${meta.sourceMessageCount} source messages`);
    return parts.length ? parts.join(' | ') : 'Pending lore batch awaiting review.';
}

function estimateTokens(text) {
    return Math.ceil(String(text || '').length / 4);
}

function truncateText(text, maxLen) {
    const value = String(text || '');
    if (value.length <= maxLen) return value;
    return value.slice(0, maxLen).replace(/\s+\S*$/, '') + '...';
}
