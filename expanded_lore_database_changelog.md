# Wandlight Expanded Lore Database Changelog

Expanded the bundled canon lore database for seven-book timeline coverage. Entries are compact paraphrased continuity facts intended for roleplay state and suggestion filtering.

## New files

- `Lore/expanded_books/book_1_philosophers_stone_expansion.json`
- `Lore/expanded_books/book_2_chamber_of_secrets_expansion.json`
- `Lore/expanded_books/book_3_prisoner_of_azkaban_expansion.json`
- `Lore/expanded_books/book_4_goblet_of_fire_expansion.json`
- `Lore/expanded_books/book_5_order_of_the_phoenix_expansion.json`
- `Lore/expanded_books/book_6_half_blood_prince_expansion.json`
- `Lore/expanded_books/book_7_deathly_hallows_expansion.json`

## New entries by book

- Philosopher's Stone: 13 entries
- Chamber of Secrets: 13 entries
- Prisoner of Azkaban: 12 entries
- Goblet of Fire: 13 entries
- Order of the Phoenix: 13 entries
- Half-Blood Prince: 10 entries
- Deathly Hallows: 20 entries

## Metadata cleanup

- Normalized `Philosopher Stone` to `Philosopher's Stone`.
- Added explicit `kind`/`gateType` values where absent.
- Added `scope.books`, `scope.schoolYears`, and inferred `scope.phases` where possible.
- Fixed known Deathly Hallows entries that were marked as `schoolYear: 1`.
- Removed duplicate IDs while preserving the first load-order entry.

## Duplicate IDs removed from later files

- `spell_gate_expelliarmus` from `spell_gates/expanded_spell_gates.json` (Disarming Charm learning gate)
- `spell_gate_nonverbal_magic` from `spell_gates/expanded_spell_gates.json` (Nonverbal magic skill gate)
- `age_ginny_weasley` from `ages/expanded_character_ages.json` (Ginny Weasley age constraint)
- `age_neville_longbottom` from `ages/expanded_character_ages.json` (Neville Longbottom age constraint)
- `age_luna_lovegood` from `ages/expanded_character_ages.json` (Luna Lovegood age constraint)
- `age_draco_malfoy` from `ages/expanded_character_ages.json` (Draco Malfoy age constraint)

## Priority policy

Priorities are intentionally distributed: P95-100 for hard spoilers/death/identity gates, P85-94 for major active phase and institution states, P70-84 for scene-useful context, P50-69 for broad support or optional flavor.
