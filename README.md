![Wandlight Continuity](Images/banner.jpg)

# Wandlight Continuity

Wandlight Continuity is a SillyTavern extension for long-form Harry Potter roleplay. It keeps track of the things a model tends to blur over time: what date the scene is in, what canon has or has not happened, who knows which secrets, what the current scene state is, and which lore should be sent back into the prompt.

It is built for stories where chronology, secrets, alternate timelines, and character knowledge matter. The extension does not replace your writing preset. It gives the model a cleaner memory surface so the roleplay can stay anchored without turning every prompt into a recap.

## Who It Is For

Wandlight Continuity is useful if your SillyTavern roleplay depends on:

- canon dates and school years
- private character knowledge
- secrets, reveals, and future-spoiler guards
- AU divergence from the original timeline
- persistent scene and relationship state
- a growing lorebook that needs review, tagging, muting, and injection control

It is designed for users who are comfortable configuring an extension, choosing models, and reviewing generated state before trusting it.

## What It Does

Wandlight separates story memory into four practical layers.

**Context** identifies the story's current date, canon reference point, and branch. This is used to decide which canon constraints are relevant.

**Continuity** tracks live state: scene, characters, appearance, emotions, knowledge, secrets, relationships, objectives, inventory, divergences, and story milestones. This is the state of the roleplay as it currently exists, not a generic summary of canon.

**Lore** stores durable facts and constraints. Lore can come from the local canon database, model-generated story analysis, or manual edits. Accepted lore can be searched, filtered, tagged, pinned, muted, bulk edited, expired, or deleted.

**Injection** controls what is actually sent to the model. Continuity and Lore can be injected separately, placed at configurable prompt depth and role, and sent directly or compressed through a model.

## Key Features

- Date-aware canon lore suggestions from a local database.
- Story lore generation from recent chat history.
- Pending lore review before entries become active.
- Bulk editing for accepted lore entries.
- Story milestone gates so canon knowledge does not activate just because a calendar date passed.
- Lifecycle states such as active, blocked, future, expired, canon overdue, and muted.
- Direct or compressed injection for both Continuity and Lore.
- Configurable prompt placement, role, and depth.
- Editable continuity scan prompts by section.
- State history for undoing Wandlight changes.
- A local `Lore/` database that can be expanded with new entries, categories, gates, and scoring rules.

## Recommended Workflow

Open the Wandlight Continuity window and work left to right.

Start in **Context**. Detect or set the scene date, canon reference point, and branch. This anchors the rest of the system.

Use **Continuity** to scan the current roleplay state. This captures the live scene, character knowledge, secrets, relationships, milestones, and other details that should persist.

Use **Lore** to suggest canon lore from the local database or generate story lore from recent messages. Review pending entries before accepting them. Accepted lore can be edited, tagged, pinned, muted, expired, or bulk managed.

Use **Injection** to decide what gets sent to the model. Keep it direct when detail matters. Use compression when the lore or continuity block grows too large.

The chat remains the source of truth. Wandlight is a working memory layer that helps the model see the right parts of that truth at the right time.

## Canon Lore Database

The extension includes a local `Lore/` folder for date-aware Harry Potter constraints. It is not meant to be a full encyclopedia. Its purpose is to help Wandlight decide what should be true, blocked, expired, or suggested at a given point in the story.

The database is expandable. Add entries to `Lore/user/custom_entries.json`, or add new files through `Lore/manifest.json`. Categories, gate types, scoring weights, and UI labels are defined by registry files so the database can grow without rewriting the parser.

See `Lore/README.md` for the database schema and authoring guidance.

## Installation

Place the extension folder here:

```text
data/default-user/extensions/third-party/WandlightContinuity
```

Restart SillyTavern.

The folder name should remain `WandlightContinuity` unless you also update the extension folder constant in the code.

## Notes

Wandlight Continuity is not a game system. It does not add combat, dice, character sheets, spell slots, or progression mechanics.

It is a continuity and lore-control tool for roleplay sessions where memory, chronology, and secrets matter.

## License

See `LICENSE`.
