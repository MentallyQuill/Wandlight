# Wandlight Continuity Lore Database

This folder contains the local, date-aware lore database used by Wandlight Continuity.

The database is not intended to be a full wiki. It is a chronology and constraint layer. Its job is to keep a roleplay aligned to a specific story date, character knowledge state, spell-learning stage, behavior period, and canon/AU branch.

The most useful entries answer questions like:

- What is true on this date?
- What has not happened yet?
- Who knows this, and who does not know it yet?
- Which future canon facts must not leak?
- What spells or abilities are plausible at this school year or training level?
- How old is a character on this date?
- How should a character's behavior differ at this point in the timeline?

## Files that control the database

### `manifest.json`

The manifest is the load list. Wandlight reads every JSON file listed in `files`.

To add a new lore file:

1. Create the file anywhere under `Lore/`.
2. Add its relative path to `manifest.json`.
3. Keep the file valid JSON.

Example:

```json
{
  "files": [
    "chronology/school_years.json",
    "user/my_custom_year_4_entries.json"
  ]
}
```

### `taxonomy.json`

This controls UI dropdown options, chip labels, and colors. Users can add new categories or statuses without editing JavaScript.

Example category:

```json
{
  "categories": {
    "prophecy": {
      "label": "Prophecy",
      "color": "#4c1d95",
      "textColor": "#f3e8ff",
      "description": "Prophecy-related constraints and knowledge."
    }
  }
}
```

After adding this, the Lore UI metadata dropdown can use `prophecy` as a category.

### `gate-types.json`

This defines expandable gate kinds. A `kind` describes what an entry does, while `category` describes how it is grouped in the UI.

Examples:

- `knowledge_gate`: controls who knows what and when.
- `future_guard`: blocks future canon leakage.
- `spell_gate`: controls spell knowledge or ability timing.
- `age_gate`: computes or constrains age by date.
- `behavior_gate`: gives date-sensitive characterization constraints.
- `skill_band`: describes broad competence for a school year or training level.

You can add new kinds without changing parser code. New behavior-specific logic may still require code if the new kind needs special scoring or injection behavior.

### `scoring.json`

This controls how local canon entries are ranked when Wandlight queries the database for a detected date/context.

Higher weights make a factor more important. For example, increasing `characterMatch` makes entries about present characters rise higher.

## Entry schema v2

A database file should contain an `entries` array:

```json
{
  "schemaVersion": 2,
  "entries": []
}
```

Each entry should use this structure:

```json
{
  "schemaVersion": 2,
  "id": "unique_stable_id",
  "title": "Human-readable title",
  "kind": "knowledge_gate",
  "category": "knowledge",
  "canonStatus": "canon",
  "truthStatus": "hidden",
  "revealPolicy": "do_not_reveal",
  "priority": 90,
  "protected": true,

  "date": {
    "validFrom": "1994-09-01",
    "validTo": "1995-06-30",
    "precision": "school_year",
    "schoolYear": 4,
    "book": "Goblet of Fire",
    "label": "Year 4"
  },

  "scope": {
    "characters": ["Hermione Granger"],
    "locations": ["Hogwarts"],
    "topics": ["horcruxes", "dark magic"],
    "spells": [],
    "objects": [],
    "factions": [],
    "books": ["Goblet of Fire"],
    "schoolYears": [4]
  },

  "visibility": {
    "knownBy": {},
    "notKnownByBefore": {
      "Hermione Granger": "1996-07-01"
    },
    "suspectedBy": {},
    "publicFrom": null,
    "secretUntil": "1996-07-01"
  },

  "content": {
    "fact": "Before summer 1996, Hermione should not know about Horcruxes.",
    "injection": "Do not let Hermione mention or explain Horcruxes before summer 1996 unless the AU explicitly introduced them early.",
    "constraints": [
      "The word Horcrux should not appear in Hermione's dialogue in Year 4."
    ],
    "antiLore": [
      "Hermione should not explain Voldemort's soul-fragment strategy in Year 4."
    ],
    "notes": "Used as a future-knowledge guard."
  },

  "effects": {
    "addsTags": ["horcruxes", "knowledge-gate", "future-guard"],
    "blocksTermsBeforeDate": ["Horcrux", "soul fragment"],
    "protectsEntries": [],
    "stateHints": {},
    "injectionRules": {
      "preferAsConstraint": true,
      "neverRevealAsDialogue": true
    }
  },

  "source": {
    "work": "Harry Potter",
    "book": "Half-Blood Prince",
    "chapter": null,
    "confidence": 0.95,
    "notes": "Approximate canon knowledge boundary."
  },

  "ui": {
    "icon": "lock",
    "color": null,
    "textColor": null,
    "defaultCollapsed": false
  },

  "extensions": {}
}
```

## Required fields

The parser is tolerant, but good entries should include:

- `id`
- `title`
- `kind`
- `category`
- `priority`
- `date.validFrom` or `date.validTo`
- `content.fact`
- `content.injection`

If `content.injection` is missing, Wandlight falls back to `content.fact`.

## Dates and date precision

Supported date formats:

- `YYYY-MM-DD`
- `YYYY-MM`
- `YYYY`

Supported precision values:

- `date`
- `month`
- `year`
- `school_year`
- `era`
- `approximate`
- `unknown`

Use exact dates when possible. Use school-year windows when the canon timing is broad.

Example:

```json
"date": {
  "validFrom": "1996-09-01",
  "validTo": "1997-06-30",
  "precision": "school_year",
  "schoolYear": 6,
  "book": "Half-Blood Prince"
}
```

## Categories vs kinds

Use `kind` for behavior.

Use `category` for UI grouping.

Example:

```json
{
  "kind": "spell_gate",
  "category": "spell"
}
```

This means: the entry behaves like a spell-learning gate and appears under the Spell category.

## Common gate kinds

### `knowledge_gate`

Use for who knows a fact and when.

Best for preventing errors like Hermione mentioning Horcruxes before Year 6.

### `future_guard`

Use for major future events that must not leak before they happen.

Example: Dumbledore's death, the Deathly Hallows, the fall of the Ministry.

### `spell_gate`

Use for spells, magic techniques, magical abilities, or who learns them when.

Add spell names to `scope.spells` so the Lore UI can show spell metadata chips.

### `skill_band`

Use for broad school-year ability constraints.

Example: fourth-years generally should not use advanced nonverbal magic casually.

### `age_gate`

Use for birthdates and date-based age constraints.

### `behavior_gate`

Use for date-sensitive personality/behavior guidance.

Example: Year 6 Harry is more suspicious of Draco and affected by Sirius's death.

## How retrieval works

When Story Context has a parseable date, Wandlight:

1. Parses the date.
2. Loads files listed in `manifest.json`.
3. Keeps entries whose date window contains the story date.
4. Scores entries by date match, character match, location match, topic match, kind boost, future-guard boost, and priority.
5. Proposes the top results into Pending Lore Review.

The query is local. It does not call the model.

## Performance rules

Keep database entries concise. Do not paste wiki articles into `content.fact`.

Recommended size:

- `content.fact`: 1-2 sentences.
- `content.injection`: 1 concise model-facing instruction.
- `constraints`: 1-8 bullets.
- `antiLore`: 1-8 bullets.

Wandlight stores proposed entries in chat metadata. Large entries or large batches can make a chat heavy. Prefer fewer, higher-impact constraints.

The UI paginates Pending Lore Review to avoid rendering huge batches at once.

## Adding a custom file

Create:

```text
Lore/user/my_custom_entries.json
```

Example:

```json
{
  "schemaVersion": 2,
  "entries": [
    {
      "schemaVersion": 2,
      "id": "my_au_sirius_survives",
      "title": "AU: Sirius Survives",
      "kind": "fact",
      "category": "au",
      "canonStatus": "au",
      "truthStatus": "true",
      "revealPolicy": "private",
      "priority": 95,
      "date": {
        "validFrom": "1996-06-18",
        "validTo": null,
        "precision": "date"
      },
      "scope": {
        "characters": ["Sirius Black", "Harry Potter"],
        "topics": ["sirius", "au", "survival"]
      },
      "content": {
        "fact": "In this AU branch, Sirius Black survived the Department of Mysteries.",
        "injection": "Treat Sirius Black as alive in this branch unless the user changes that continuity.",
        "constraints": [
          "Canon entries claiming Sirius is dead should be treated as contested in this branch."
        ]
      },
      "effects": {
        "addsTags": ["sirius", "au", "survival"]
      }
    }
  ]
}
```

Then add the file to `manifest.json`:

```json
"user/my_custom_entries.json"
```

## Adding a new category

Edit `taxonomy.json`:

```json
{
  "categories": {
    "prophecy": {
      "label": "Prophecy",
      "color": "#4c1d95",
      "textColor": "#f3e8ff",
      "description": "Prophecy-related lore, gates, and constraints."
    }
  }
}
```

Now entries can use:

```json
"category": "prophecy"
```

## Adding a new gate type

Edit `gate-types.json`:

```json
{
  "gateTypes": {
    "prophecy_gate": {
      "label": "Prophecy Gate",
      "description": "Controls prophecy knowledge and reveal timing.",
      "defaultPriority": 90,
      "injectionRole": "knowledge_constraint"
    }
  }
}
```

Now entries can use:

```json
"kind": "prophecy_gate"
```

## Troubleshooting

If entries do not appear:

1. Confirm the file is listed in `manifest.json`.
2. Confirm the file is valid JSON.
3. Confirm entries are inside an `entries` array.
4. Confirm the story date falls between `date.validFrom` and `date.validTo`.
5. Increase max canon proposals in the Context tab.
6. Add relevant characters/topics/locations to `scope` so scoring can find the entry.

If too many entries appear:

1. Lower max canon proposals.
2. Increase priorities only for high-impact gates.
3. Make `scope.characters`, `scope.locations`, and `scope.topics` more specific.
4. Move broad background facts to lower priority.

## Style guidance

Good database entries are constraints, not exposition.

Bad:

```text
Hermione Granger is a Muggle-born Gryffindor student and friend of Harry Potter.
```

Better:

```text
Before summer 1996, Hermione should not know about Horcruxes or explain Voldemort's soul-fragment strategy.
```

Wandlight works best when the database focuses on chronology, knowledge gates, future guards, spell plausibility, age, behavior, and AU divergence.

## Schema v3: story milestones and lifecycle states

Wandlight now separates canon timing from story truth.

Canon dates are used to suggest and sort lore, but story milestones determine whether reveal/knowledge lore is actually active. This prevents a story that lags behind canon from suddenly giving characters knowledge just because the canon date passed.

### Core rule

Do not write date rules into `content.injection` unless the date itself is useful to the roleplay model. Store timing in metadata and inject only the resolved truth.

Prefer this:

```json
{
  "id": "guard_trio_no_horcrux_knowledge",
  "title": "Trio Does Not Know Horcruxes",
  "kind": "knowledge_guard",
  "category": "knowledge",
  "canonTiming": {
    "canonExpectedUntil": "1996-07-01",
    "precision": "approximate"
  },
  "activation": {
    "requiresMissingEvents": ["horcruxes_revealed_to_trio"]
  },
  "expiration": {
    "expiresWhenEventsHappen": ["horcruxes_revealed_to_trio"],
    "autoMuteOnExpire": true
  },
  "content": {
    "injection": "Harry, Ron, and Hermione do not know about Horcruxes."
  }
}
```

Avoid this:

```json
{
  "content": {
    "injection": "Before summer 1996, Harry, Ron, and Hermione should not know about Horcruxes."
  }
}
```

The first form lets Wandlight handle the date/milestone logic and keeps injected text shorter.

### `canonTiming`

Use `canonTiming` for canon chronology hints.

```json
"canonTiming": {
  "canonExpectedFrom": "1996-07-01",
  "canonExpectedUntil": "1997-06-30",
  "hardValidFrom": "",
  "hardValidTo": "",
  "precision": "approximate",
  "schoolYear": 6,
  "book": "Half-Blood Prince",
  "label": "Year 6"
}
```

Meanings:

- `canonExpectedFrom`: canon suggests this may apply from this date, but story evidence may still be required.
- `canonExpectedUntil`: canon suggests this guard/condition is usually resolved by this date.
- `hardValidFrom`: the entry cannot apply before this date.
- `hardValidTo`: the entry cannot apply after this date.

Use hard dates sparingly. Most secret knowledge, reveals, relationship changes, deaths, and betrayals should be milestone-gated instead of hard-date-gated.

### `activation`

Use `activation` for story conditions required before an entry becomes injectable.

```json
"activation": {
  "requiresEvents": ["horcruxes_revealed_to_trio"],
  "requiresMissingEvents": [],
  "requiresCharacters": [],
  "requiresLocation": [],
  "requiresTopics": []
}
```

- `requiresEvents`: all listed milestones must be `happened` or `diverged`.
- `requiresMissingEvents`: all listed milestones must not have happened yet.

### `expiration`

Use `expiration` to expire old guards or superseded lore.

```json
"expiration": {
  "expiresWhenEventsHappen": ["horcruxes_revealed_to_trio"],
  "expiresWhenEntriesActive": [],
  "autoMuteOnExpire": true
}
```

Expired entries are not injected by default. They remain visible in the Lore tab under the Expired filter and can be manually changed back to Active if the story diverges.

### `lifecycle`

Wandlight computes a lifecycle status for every accepted lore entry:

- `active`: injectable now.
- `canon_overdue`: canon timing says this should probably have resolved, but the story milestone has not happened. Guards may still inject in this state.
- `blocked`: story/scope conditions are missing.
- `future`: not ready yet.
- `expired`: superseded or past a hard date.
- `divergent`: does not fit the current branch/canon status.
- `muted`: user muted it.
- `archived`: disabled/archived.

Users can override this status from the colored dropdown at the left of each lore entry card.

### Story milestones

Story milestones are stored per chat in the Continuity tab under `storyMilestones`.

Example:

```json
{
  "horcruxes_revealed_to_trio": {
    "status": "not_happened",
    "happenedAtStoryDate": "",
    "happenedAtTurn": 0,
    "evidence": [],
    "confidence": 0,
    "notes": ""
  }
}
```

Valid statuses:

- `not_happened`
- `suspected`
- `happened`
- `blocked`
- `diverged`
- `unknown`

The continuity scanner should only set a milestone to `happened` when the roleplay text establishes it. It should not use canon date alone.

### Recommended milestone IDs

Use stable snake_case IDs:

- `horcruxes_revealed_to_trio`
- `deathly_hallows_revealed_to_trio`
- `sirius_truth_revealed`
- `barty_crouch_jr_revealed`
- `voldemort_return_publicly_acknowledged`
- `dumbledore_death_occurs`
- `cedric_dies`
- `ministry_falls`
- `draco_mission_revealed`
- `snape_loyalty_truth_revealed`
- `sectumsempra_discovered`
- `prophecy_revealed_to_harry`
- `chamber_of_secrets_resolved`

Add new milestones as needed for your AU.
