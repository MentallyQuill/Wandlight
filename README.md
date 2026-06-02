![Wandlight](Images/banner.jpg)

# Wandlight

Wandlight is a SillyTavern extension for long-form Harry Potter roleplay where chronology, canon timing, AU branches, secrets, and durable story memory matter.

The current lore system is relevance-tiered. Accepted lore is not treated as simply active or inactive. Instead, each lore entry has a **Relevance** tier that controls where it is injected, how it is sorted, and how aggressively it is compressed.

## Who It Is For

Wandlight is useful for stories that need:

- canon dates, school years, deaths, reveals, and spoiler boundaries
- AU/fanfic branches that diverge from main canon
- durable story lore generated from long chats
- reviewable pending lore before it becomes accepted
- prompt injection split by immediate scene relevance versus background lore
- separate compression budgets for different kinds of lore

## Mental Model

```text
Context    = where the story is in time/canon/branch
Continuity = lightweight current scene state
Lore       = durable accepted facts and constraints
Relevance  = how close a lore entry is to the current scene/story moment
Injection  = where each relevance tier is placed in the prompt
Compression = compacting each injection group independently
```

## The Accepted Lore Model

Accepted lore entries use five independent concepts.

| Concept | Meaning |
|---|---|
| Relevance | High, Normal, or Low. Controls injection tier, sorting, and compression budget. |
| Canon | Canon or AU. Canon describes mainline canon/reference lore; AU describes branch/story-specific lore. |
| Category | What kind of lore it is: Character, Event, Location, Item, Spell, Faction, Relationship, Rule, Timeline, Knowledge, Secret, or Other. |
| Priority | Ordering inside the same relevance tier. P100 Low Relevance stays in Low Relevance, but sorts near the top of Low. |
| Mute | Hard injection off switch. Muted entries are excluded before injection and compression. |
| Pin | Priority/protection. Pinned entries sort higher and are preserved more strongly during compression. |

There is no user-facing lifecycle state model. Legacy lifecycle fields may still exist internally for migration and diagnostics, but the card-level control is **Relevance**.

## Relevance Tiers

| Tier | Use | Default injection behavior |
|---|---|---|
| High | Current-scene facts, present characters, current location, immediate constraints, active secrets/items/events. | Inject close to the prompt; direct or light compression. |
| Normal | Recent background, near-future or near-past canon, important branch facts, useful medium-context lore. | Inject at medium depth; balanced compression. |
| Low | Long-term background, broad canon, distant past/future, low-context facts. | Inject deeper; aggressive compression or omit if muted. |

## Pending Lore Review

Pending entries can be edited before acceptance:

- Relevance: High / Normal / Low
- Canon: Canon / AU
- Category
- Priority
- Pin / Mute after acceptance

The pending preprocessor assigns these fields using the current story date, scope, branch, source, and local relevance scoring. Canon suggestions usually enter as Canon. Story Lore Scan entries usually enter as AU unless the scan clearly restates mainline canon.

## Lore Generation

### Suggest Canon Lore

Suggest Canon Lore reads the bundled local `Lore/` database. It preprocesses candidate entries into relevance tiers before they enter Pending Lore Review. Date windows, dead-character gates, tightened HP Lexicon calendar anchors, canon/AU branch handling, and scope matches all affect the suggested relevance.

### Scan Story Lore

Story Lore Scan uses the Reasoning Provider to extract durable story/AU lore from chat messages. It now asks for lore operations rather than simple fact snippets: create, update, merge, supersede, or conflict. Generated entries are expected to include concise titles, model-facing injection text, constraints/anti-lore when useful, durability reasons, evidence message refs, Canon/Story, Category, Priority, and locally recomputed Relevance metadata.

Generated lore is filtered through a strict quality gate by default. Low-value recap facts that belong in a summarizer are discarded before Pending Lore Review. Similar lore is routed as a possible update or merge instead of being silently thrown away as a duplicate.

## API And Model Settings

Wandlight has two model roles:

- Utility Provider: frequent, cheaper calls for compression and continuity scans.
- Reasoning Provider: deeper calls for story context detection and Story Lore Scan.

Each role can use the current SillyTavern model, a SillyTavern connection profile, or a direct OpenAI-compatible endpoint. Direct OpenAI-compatible endpoints use Wandlight's encrypted local keyring.

Each provider role has its own generation parameters: temperature, top-p, and max tokens. Both roles use the same defaults: temperature `0.7`, top-p `0.98`, and max tokens `8192`.

Wandlight no longer exposes explicit JSON mode or SillyTavern proxy toggles. JSON mode was too provider-specific for reliable connection tests, and Wandlight already uses JSON-focused prompts plus repair handling. For SillyTavern-managed routing, use Current SillyTavern Model or Connection Profile instead of the direct OpenAI-compatible endpoint.

## Auto-Relevance

Auto-Relevance periodically scans recent chat messages and accepted lore. It does not mutate Mute or Pin. It promotes/demotes accepted entries between High, Normal, and Low relevance.

When enabled, Auto-Relevance has these actions:

| Action | Behavior |
|---|---|
| Suggest changes | Stores reviewable relevance suggestions. Users can apply or reject each one. |
| Apply high confidence | Applies changes above the configured confidence threshold. |

Performance design:

1. Score all accepted entries locally.
2. Select a limited candidate set.
3. Optionally send only that compact candidate set to the Utility Provider for model adjudication.
4. Store suggestions or apply high-confidence changes depending on mode.

## Injection System

Wandlight now has separate injection groups:

- Continuity
- High-Relevance Lore
- Normal-Relevance Lore
- Low-Relevance Lore

Continuity and each lore relevance tier have their handling settings inside that group's preview section:

- enabled/disabled
- prompt position/depth/role
- Direct or Compressed mode
- Compress Now
- compression interval
- max entries
- compression level, defaulting to level 3
- injection preview

Compression Prompts live below the preview sections.

Muted entries are excluded before tier grouping. Priority sorts entries inside a tier. Pin gives extra protection and sorting boost.

## Compression System

Lore compression is split by relevance tier.

| Tier | Default compression posture |
|---|---|
| High | Defaults to level 3 when compressed; preserve exact scene-critical details. |
| Normal | Defaults to level 3; preserve recent/background constraints. |
| Low | Defaults to level 3; summarize broad background lore compactly. |

Changing High-Relevance lore should not invalidate Low-Relevance compression, and vice versa. Each tier has its own compression signature and cache.

## Recommended Workflow

1. Set or detect Story Context.
2. Scan Continuity for the current scene.
3. Suggest Canon Lore or run Story Lore Scan.
4. Review Pending Lore and edit Relevance/Canon/Category/Priority before acceptance.
5. Use Accepted Lore to pin, mute, search, and bulk edit.
6. Configure Injection groups by relevance tier.
7. Enable Auto-Relevance in Suggest mode first.
8. Move to Apply high confidence only after the suggestions look correct for your story.

## Installation

Place the extension folder here:

```text
data/default-user/extensions/third-party/Wandlight
```

Restart SillyTavern and open the Wandlight Runtime Window from the Extensions panel.

## Local Lore Database

The bundled `Lore/` database is a chronology/constraint layer, not a full encyclopedia. It contains date-aware canon references, tightened day-by-day calendar anchors, dead-character gates, future guards, skill/age/behavior windows, and user-expandable lore files.

See `Lore/README.md` for schema guidance.

## License

See `LICENSE`.


## Specific Lore Policy

Wandlight Lore is no longer treated as an encyclopedia or glossary. Bundled lore is meant to solve timing, knowledge-boundary, branch/story-memory, and long-chat continuity problems that models commonly mishandle. Basic reference facts such as “wands are standard tools,” “Hogwarts is the British wizarding school,” or “Ron is a Gryffindor” are intentionally removed from the bundled injectable lore database.

Accepted lore now carries an internal `lorePurpose` such as `knowledge_gate`, `event_anchor`, `status_change`, `ability_gate`, `relationship_state`, `item_state`, `behavior_constraint`, or `age_gate`. Auto-Relevance and Suggest Canon Lore use this purpose metadata before promoting an entry. High Relevance requires both a specific lore purpose and a strong current-story match; broad date validity or a character name alone is not enough.

## Generated Lore Policy

Generated Story Lore follows the same philosophy as the bundled database. It should protect durable continuity, not summarize chat history.

Good generated entries capture recurring object behavior, knowledge boundaries, secrets, status changes, relationship states, AU/canon-branch changes, active objectives, timeline anchors, or concrete rules. Weak recap entries such as "Hermione found a book" are filtered unless they carry durable consequences.

Automatic Story Lore Scan is conservative by default because it is slow and expensive. Manual scans remain available for deliberate backfills. When automatic mode is enabled, Wandlight waits for enough new story text or a longer turn fallback before scanning.

Injected text should speak in story terms, not metadata jargon. Prefer “unless our story has established otherwise” or “unless accepted story lore has established a different outcome.” Avoid model-facing phrases like “unless AU divergence says so.”
