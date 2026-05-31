# Expanded Lore Database Validation

Package target: `WandlightContinuity_expanded_lore_database.zip`

## Summary

- Total bundled lore entries: 220
- New expanded-book entries: 94
- Manifest lore files: 29
- Duplicate ID check: passed
- Required metadata check: passed
- JSON parse check: passed
- JavaScript syntax check: passed

## New entries by book

- Philosopher's Stone: 13
- Chamber of Secrets: 13
- Prisoner of Azkaban: 12
- Goblet of Fire: 13
- Order of the Phoenix: 13
- Half-Blood Prince: 10
- Deathly Hallows: 20

## Total entries by book after expansion

- Philosopher's Stone: 30
- Chamber of Secrets: 29
- Prisoner of Azkaban: 31
- Goblet of Fire: 37
- Order of the Phoenix: 43
- Half-Blood Prince: 52
- Deathly Hallows: 45

## Entry kinds after expansion

- event_anchor: 51
- knowledge_gate: 43
- future_guard: 18
- institution_state: 17
- spell_gate: 16
- behavior_gate: 16
- artifact_state: 11
- age_gate: 11
- character_state: 9
- skill_band: 8
- place_fact: 8
- relationship_gate: 5
- public_belief: 4
- faction_state: 2
- continuity_rule: 1

## Priority distribution

- P95-100: 34
- P85-94: 55
- P70-84: 102
- P50-69: 28
- P0-49: 1

## Suggestion selection change

The canon database query now selects max suggestions with priority bands, score, priority, scope specificity, and per-kind balancing instead of score-only slicing. This is a preparatory change for future priority/filter presets.
