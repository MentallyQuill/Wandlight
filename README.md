![Wandlight Continuity](Images/banner.jpg)

# Wandlight Continuity

Wandlight Continuity is a SillyTavern extension for long-form Harry Potter roleplay where chronology, canon timing, AU branches, secrets, and durable story memory matter.

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

Story Lore Scan uses the Reasoning Provider to extract durable story/AU facts from chat messages. It outputs compact candidate facts and converts them to pending lore entries with Canon/AU, Category, Priority, and Relevance metadata.

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

Each lore relevance tier has independent settings inside that tier's preview section:

- enabled/disabled
- prompt position/depth/role
- Direct or Compressed mode
- Compress Now
- compression interval
- max entries
- compression level
- injection preview

Compression Prompts live below the preview sections.

Muted entries are excluded before tier grouping. Priority sorts entries inside a tier. Pin gives extra protection and sorting boost.

## Compression System

Lore compression is split by relevance tier.

| Tier | Default compression posture |
|---|---|
| High | Direct or lightly compressed; preserve exact scene-critical details. |
| Normal | Balanced compression; preserve recent/background constraints. |
| Low | Aggressive compression; summarize broad background lore. |

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
data/default-user/extensions/third-party/WandlightContinuity
```

Restart SillyTavern and open the Wandlight Runtime Window from the Extensions panel.

## Local Lore Database

The bundled `Lore/` database is a chronology/constraint layer, not a full encyclopedia. It contains date-aware canon references, tightened day-by-day calendar anchors, dead-character gates, future guards, skill/age/behavior windows, and user-expandable lore files.

See `Lore/README.md` for schema guidance.

## License

See `LICENSE`.
