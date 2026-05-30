# Wandlight Continuity

A lightweight SillyTavern extension for HP roleplay continuity.

Wandlight handles prose, tone, and style. Wandlight Continuity tracks the story state that prompt text tends to lose: canon boundary, date, location, present characters, character knowledge, secrets, relationships, unresolved threads, and continuity warnings.

## Getting Started

### 1. Install the Extension

Place the extension folder here:

```text
data/default-user/extensions/third-party/WandlightContinuity
```

Restart SillyTavern.

The folder name matters. If you rename the folder, update `EXTENSION_FOLDER` in `constants.js`.

### 2. Use Wandlight as Your Preset

Wandlight Continuity is built for the Wandlight preset.

Use Wandlight for prose, voice, tense, perspective, and length. Use this extension for state tracking.

### 3. Open the Settings Panel

Open SillyTavern's Extensions panel and find **Wandlight Continuity**.

Recommended starting settings:

- Enable Wandlight Continuity: ON
- Inject Continuity Memo: ON
- Auto-Extract State Deltas: ON
- Auto-Apply Deltas: OFF at first
- Extraction Interval: 1
- Max Snapshots: 20

Review extracted deltas until the behavior is predictable for your model.

## Features

### Continuity State

Tracks the current scene and long-running story facts:

- canon era and boundary
- in-universe date
- location, time, weather, and activity
- present and nearby characters
- character knowledge
- secrets and public versions
- relationship tension and trust
- active story threads
- continuity warnings

### Continuity Memo

Before generation, the extension injects a compact state block:

```text
[WANDLIGHT CONTINUITY STATE]
...
[/WANDLIGHT CONTINUITY STATE]
```

The memo is temporary. It is not written into chat history.

### State Extraction

After a reply, the extension can run a background extraction pass and return a JSON delta.

It looks for persistent changes only: movement, time passing, character arrivals, secret reveals, new knowledge, relationship shifts, unresolved consequences, and canon divergence.

### Delta Review

Deltas can be applied automatically or reviewed first.

Manual review is recommended for new stories, new models, or complex canon scenes.

### Undo and Snapshots

The extension snapshots state before changes. Use **Undo Last Change** to restore the previous state.

### State Editor

The settings panel includes a raw JSON editor, import/export controls, a memo preview, and a last-delta preview.

### Lore Matrix

A structured knowledge table for managing which characters know what facts, with support for canonical truth status, private/public reveal policies, scene activation, and manual review.

Each lore entry has:
- **id / title** — unique identifier and display name
- **category** — character, event, location, object, relationship, spell, secret, or faction
- **canonStatus** — canon, fanon, alternate, divergent, or speculative
- **truthStatus** — what really happened (true / false / ambiguous / unknown)
- **beliefs** — per-character belief entries with belief value, source, and confidence
- **revealPolicy** — private (GM-only), public (in-memo), or condition (revealed when…)
- **status** — active, pinned, archived, or disabled
- **activation** — array of activation conditions (scene, character, topic, location)
- **sceneTags** — tags for scene-based activation filtering

#### Context Detection

Click **Detect Lore Context** (or use the extraction system) to snapshot the current scene's canonical anchoring — date range, subjective timeline position, branch ID, time-travel mode — into `loreContext`. This context drives which lore entries are considered active for the current scene.

#### Generation

Click **Generate Lore** to have the LLM analyze recent chat history and produce `sceneTags` and `beliefs` for entries missing either. Results arrive as pending entries (stored in `_pendingLore`). Review them before accepting.

#### Review

Use **Accept All** or **Reject All** to finalize generated entries. Accepted entries are merged into `loreMatrix` and immediately available for memo injection and the state viewer.

## What It Is Not

Wandlight Continuity is not a game system.

It does not add dice, XP, HP bars, spell slots, combat turns, or D&D mechanics. It does not replace Wandlight's prose controls. It does not bundle a Harry Potter encyclopedia.

## Troubleshooting

### Settings Panel Does Not Appear

Check the installed folder name. By default, the extension expects:

```text
third-party/WandlightContinuity
```

If the folder name is different, update `EXTENSION_FOLDER` in `constants.js`.

### State Is Not Updating

Check that **Auto-Extract State Deltas** is enabled.

If **Auto-Apply Deltas** is off, extracted changes appear in the Last Delta panel and must be applied manually.

### The Memo Is Empty

Add state manually, run extraction, or continue the story until the extractor has something persistent to track.

### The Memo Stops Injecting

The memo may be over the token cap. Reduce stored state or remove stale entries from the state editor.

## Recommended Workflow

Use Wandlight normally.

Let the extension track continuity in the background. Review deltas when canon knowledge, secrets, or relationships matter. Correct the state manually when the model gets something wrong.

Chat history remains the operative truth. Wandlight Continuity is there to keep that truth visible.

## License

See `LICENSE`.
