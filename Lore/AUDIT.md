# Wandlight Canon Lore Audit

Audit date: 2026-06-01

This audit looks at the bundled lore database as an injection-risk system, not as a canon completeness system. The guiding question is:

> Does this entry prevent a likely temporal/continuity mistake, or does it merely remind the model of canon it probably already knows?

## Scope

- Manifest-loaded files: 35
- Total entries: 293
- Active/injectable entries: 275
- Disabled metadata entries: 18

## Audit Buckets

| Bucket | Meaning | Desired default |
|---|---|---|
| suppressor | Blocks premature knowledge, events, abilities, terms, or outcomes. | Keep injectable. |
| state_constraint | Maintains date-sensitive status, role, relationship, age, institution, or behavior. | Keep if concise and date-useful. |
| event_anchor | Places a specific event in a narrow date window. | Keep only near the event or with strong topic match. |
| positive_availability | Says a spell, item, event, or plot beat is available/true after a date. | Usually convert, narrow, or disable. |
| mixed_gate | Contains both useful constraint language and spotlighting positive canon. | Rewrite toward the constraint. |
| reference_or_metadata | Explains canon rather than constraining a mistake. | Usually disable or keep metadata-only. |
| metadata_disabled | Non-injectable database support entry. | No action unless needed for retrieval. |

## Current Shape

Among active/injectable entries:

| Bucket | Count |
|---|---:|
| state_constraint | 95 |
| event_anchor | 91 |
| suppressor | 58 |
| positive_availability | 22 |
| mixed_gate | 5 |
| reference_or_metadata | 4 |

The database is already mostly specific lore, but it still leans too positive in two places: broad event/window anchors and post-learning spell/item availability.

## Strong Areas

- `spell_gates/spell_gates.json` is the best current model: its core entries mostly act as ability suppressors rather than spell suggestions.
- `characters/death_states.json` is structurally useful as state lore. It should stay date-gated and AU-flexible.
- `behavior_gates/core_behaviors.json` is mostly appropriate because it constrains characterization by date rather than reciting biography.
- `knowledge_gates/consolidated_story_gates.json` has the right strategy for major spoilers: "before our story establishes X, do not use X."

## Main Findings

### 1. Positive availability creates token bloat and priming

Entries that say a thing is plausible after a date are often unnecessary because models already assume broad Harry Potter canon is available. These entries risk making the model reach for that canon.

Examples:

- `spell_gates/expanded_spell_gates.json`: `spell_gate_riddikulus`
- `expanded_books/book_6_half_blood_prince_expansion.json`: `hbp_sectumsempra_incident_gate`
- `lexicon_calendars/year_6_hbp_calendar_anchors.json`: `lexcal_y6_sectumsempra_consequence`
- `skills/school_year_skill_bands.json`: several year bands describe added competence rather than blocking implausible competence

Preferred conversion:

```text
Before the relevant lesson/training/event, do not let ordinary students use or recognize X unless this story has established early training.
```

### 2. Broad event anchors spotlight canon

Some entries are date-valid for months or most of a school year and inject positive plot information. They may be true, but they can over-steer scenes.

Examples:

- `chronology/major_events.json`: `event_triwizard_tournament`
- `chronology/major_events.json`: `event_sirius_public_fugitive`
- `expanded_books/book_2_chamber_of_secrets_expansion.json`: `cos_chamber_attack_progression`
- `expanded_books/book_3_prisoner_of_azkaban_expansion.json`: `poa_buckbeak_trial_schedule`

Preferred conversion:

- If the entry controls atmosphere or public belief, make it a `state_constraint`.
- If it exists only to mark an event, narrow the date window or require an explicit topic/location match.
- If it merely recalls the plot, set `injectableByDefault: false`.

### 3. Calendar anchors should be narrow and topic-sensitive

The lexicon calendar files are useful for day-by-day continuity, but exact plot anchors can become spoilers or scene magnets if proposed outside a scene that actually needs them.

Recommended rule:

```text
Event anchors longer than 14 days should not be proposed unless they are suppressors/state constraints or the current scene topic/title strongly matches.
```

### 4. Some post-acquisition item lore should become pre-acquisition suppressors

The Marauder's Map is the clearest example. The current item entry begins after Harry receives it, but the model's common failure is giving Harry map access too early.

Needed entry:

```text
Before Fred and George give Harry the Marauder's Map in Year 3, Harry should not have or use it unless this story has established an early acquisition.
```

Candidate similar gates:

- Harry's Invisibility Cloak before Christmas 1991.
- Hermione's Time-Turner before Year 3.
- DA coins and DA training before Year 5.
- Room of Requirement as a known/useful resource before discovery in the relevant context.

### 5. Duplicates should be consolidated by purpose

Some subjects have both a good suppressor and a later positive incident anchor. The positive incident can remain as a near-date event anchor, but it should not compete with the suppressor as general spell lore.

Examples:

- `spell_gate_sectumsempra` is good suppressor lore.
- `hbp_sectumsempra_incident_gate` and `lexcal_y6_sectumsempra_consequence` are positive event anchors and should be date/topic-limited or metadata-only.

## File-Level Triage

| File | Triage |
|---|---|
| `spell_gates/spell_gates.json` | Mostly keep. Use as authoring model. |
| `spell_gates/expanded_spell_gates.json` | Rewrite Riddikulus/Protego/Stupefy toward negative gates. |
| `skills/school_year_skill_bands.json` | Rewrite year bands as "avoid implausible skill leakage" constraints. |
| `items/artifacts_and_objects.json` | Add pre-acquisition suppressors; consider making post-acquisition item facts metadata-only. |
| `chronology/major_events.json` | Convert broad positive year/term events into states or narrower anchors. |
| `expanded_books/*.json` | Keep gates/states; review broad positive plot summaries. |
| `lexicon_calendars/*.json` | Keep narrow anchors, but avoid long-window plot priming. |
| `knowledge_gates/*.json` | Keep and expand this pattern for major spoilers and knowledge boundaries. |
| `future_guards/*.json` | Keep; these are aligned with the exclusionary strategy. |

## Recommended Cleanup Order

1. Add missing high-impact suppressors for pre-acquisition/pre-reveal temptations.
2. Convert obvious positive spell availability entries into negative ability gates.
3. Make post-acquisition item facts metadata-only unless the scene explicitly involves the item.
4. Narrow or disable broad positive event anchors.
5. Add retrieval logic that gives suppressors and state constraints preference over positive event anchors.

## First Cleanup Pass Applied

Applied on 2026-06-01.

Validation note: the live loader accepts both `{ "entries": [...] }` files and bare-array files. The original audit count above came from the first heuristic pass; the validation count below reflects the loader-compatible count after changes.

Current loader-compatible shape:

| Metric | Count |
|---|---:|
| Total entries | 302 |
| Active/injectable entries | 280 |
| Disabled metadata entries | 22 |

Active bucket counts after this pass:

| Bucket | Count |
|---|---:|
| state_constraint | 95 |
| event_anchor | 91 |
| suppressor | 74 |
| positive_availability | 12 |
| reference_or_metadata | 4 |
| mixed_gate | 4 |

Applied changes:

- Added pre-acquisition/pre-reveal suppressors for the Marauder's Map, Harry's Invisibility Cloak, Hermione's Time-Turner, Dumbledore's Army, and the Room of Requirement.
- Extended the Pre-Horcrux Knowledge gate into early Year 6 so September sixth-year scenes do not leak Horcrux knowledge by default.
- Rewrote Riddikulus, Stupefy, Protego, and school-year skill bands toward "do not grant this too early" constraints.
- Made post-acquisition Marauder's Map and Invisibility Cloak item facts metadata-only.
- Strengthened the Horcrux restricted-knowledge item entry as a knowledge boundary.
- Converted broad Sirius public-fugitive and Triwizard year entries from positive plot reminders into public-belief/future-guard constraints.
- Disabled positive Sectumsempra incident recap entries, leaving the core Sectumsempra suppressor as the injectable spell lore.

## Proposed Authoring Test

Before accepting a bundled canon entry, ask:

1. What exact model mistake does this prevent?
2. Is the mistake likely for this date?
3. Can the line be phrased as a constraint rather than a reminder?
4. Does it preserve AU flexibility with "unless this story has established otherwise"?
5. Would injecting it make the model more likely to introduce an unwanted plot beat?

If the answer to 5 is yes and the entry is not a necessary guard, the entry should be metadata-only, lower priority, or rewritten.
