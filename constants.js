/**
 * constants.js — Wandlight Continuity
 * Module key, default state object, default settings, extraction prompt template,
 * and logging prefix. No other dependencies. This is the root constants file.
 */

// ── Module key ──────────────────────────────────────────────────────────────────
export const MODULE_KEY = 'wandlight_continuity';

/**
 * The extension folder name under data/default-user/extensions/third-party/.
 * Must match the installed folder name exactly for renderExtensionTemplateAsync.
 */
export const EXTENSION_FOLDER = 'third-party/WandlightContinuity';

// ── Logging prefix ──────────────────────────────────────────────────────────────
export const LOG_PREFIX = '[Wandlight Continuity]';

// ── Schema version ──────────────────────────────────────────────────────────────
export const SCHEMA_VERSION = 1;

// ── Default extension settings ──────────────────────────────────────────────────
export const DEFAULT_SETTINGS = {
    enabled: true,
    injectMemo: true,
    autoExtract: true,
    autoApplyDelta: true,
    extractionInterval: 1,
    maxSnapshots: 20,
    debugMode: false,
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
        scene: {
            location: '',
            timeOfDay: '',
            weather: '',
            presentCharacters: [],
            nearbyCharacters: [],
            currentActivity: '',
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
      "presentCharacters": ["string"],
      "nearbyCharacters": ["string"],
      "currentActivity": "string"
    },
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

Current continuity state:
{{stateJson}}

Recent roleplay messages:
{{messages}}
`;

// ── Extraction prompt (user message) ────────────────────────────────────────────
export const EXTRACTION_USER_PROMPT = `Analyze the messages above and extract any changes to the continuity state. Remember: only output fields that actually changed, in valid JSON format.`;

// ── Token budget for memo ───────────────────────────────────────────────────────
export const MEMO_MAX_TOKENS = 500;

// ── Character list truncation limits ────────────────────────────────────────────
export const MAX_PRESENT_CHARS_IN_MEMO = 8;
export const MAX_KNOWLEDGE_FACTS_PER_CHAR = 5;
export const MAX_ACTIVE_THREADS_IN_MEMO = 6;
export const MAX_RELATIONSHIPS_IN_MEMO = 6;
export const MAX_FLAGS_IN_MEMO = 4;