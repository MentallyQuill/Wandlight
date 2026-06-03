<p align="center">
  <img src="Images/documentation/wandlight-banner.png" alt="Wandlight">
</p>

# Wandlight

Wandlight is a SillyTavern extension for long-form Harry Potter writing, roleplay, and fanfiction where canon timing, secrets, alternate branches, and durable story memory matter.

LLMs tend to be lore-rich but timeline-poor. They know fandoms broadly, but lose track of what's true on a specific date, who should know a secret, which canon events have happened, and what your particular story has changed. Generalized ST memory extensions aren't meant to know how established canon characters should act or evolve over a specific span of time, or what facts belong in the current scene at this exact point in the timeline--they're recorders of the story, not arbitrators of truth.

Wandlight is built to be that arbitrator, with a local date-aware lore database, reviewable lore cards, lightweight continuity tracking, and relevance-tiered prompt injection. Because of its focus on durable-lore, it can be used in tandem with memory extensions such as [MemoryBooks](https://github.com/aikohanasaki/SillyTavern-MemoryBooks), [Summaryception](https://github.com/Lodactio/Extension-Summaryception), and [VectFox](https://github.com/KritBlade/VectFox).

## Table of Contents

- [Feature Overview](#feature-overview)
- [Wandlight In Use](#wandlight-in-use)
  - [Canon Lore Suggestions](#canon-lore-suggestions)
  - [Accepted Lore Entries](#accepted-lore-entries)
  - [Lore Workbench](#lore-workbench)
- [Getting Started](#getting-started)
  - [Install Wandlight](#install-wandlight)
  - [Recommended First Workflow](#recommended-first-workflow)
  - [Basic Mode](#basic-mode)
  - [Guided Tours](#guided-tours)
- [Operator's Manual](#operators-manual)
  - [Runtime Shelf](#runtime-shelf)
  - [Session](#session)
  - [Context](#context)
  - [Continuity](#continuity)
  - [Lore](#lore)
  - [Injection](#injection)
  - [Settings And Providers](#settings-and-providers)
    - [Connection Profiles](#connection-profiles)
  - [Local Lore Database](#local-lore-database)
- [Lore Card Model](#lore-card-model)
- [Relevance Tiers](#relevance-tiers)
- [License](#license)

## Feature Overview

<table>
  <tr>
    <td width="50%" valign="top"><strong>Date-Aware Lore Database</strong><br>Wandlight includes a local Harry Potter lore database built around chronology, knowledge boundaries, canon events, secrets, spell plausibility, and AU-safe constraints. Canon lore suggestions run locally and do not require model calls.</td>
    <td width="50%" valign="top"><strong>Lore Generation From Active Chats</strong><br>Wandlight can scan roleplay history with a reasoning model and generate durable story-specific lore, including AU facts, relationship changes, item states, secrets, rules, and long-term continuity constraints.</td>
  </tr>
  <tr>
    <td width="50%" valign="top"><strong>Reviewable Lore Cards</strong><br>Generated, suggested, and manually created lore enters Pending Review before acceptance. Each lore card can be edited, retagged, reprioritized, accepted, dismissed, pinned, muted, or routed as an update to existing lore.</td>
    <td width="50%" valign="top"><strong>Lore Timeline Visualizer</strong><br>Accepted lore changes are tracked over time, including creation, edits, deletions, restores, pin/mute changes, and metadata updates. The timeline visualizer gives long-form stories an audit trail and recovery path.</td>
  </tr>
  <tr>
    <td width="50%" valign="top"><strong>Relevance-Tiered Injection</strong><br>Accepted lore is organized into High, Normal, and Low relevance tiers. Each tier has its own prompt placement, Direct/Compressed mode, token strategy, and compression cache for smarter prompt budgeting.</td>
    <td width="50%" valign="top"><strong>Continuity Tracking</strong><br>Wandlight tracks lightweight live-state details such as scene, timeline, active characters, emotional state, appearance, key items, objectives, and active story threads without turning every moment into permanent lore.</td>
  </tr>
  <tr>
    <td width="50%" valign="top"><strong>Story Context Detection</strong><br>Wandlight detects the current story date, canon boundary, and branch so canon lookup, lore generation, and relevance scoring stay aligned with the Harry Potter timeline.</td>
    <td width="50%" valign="top"><strong>Wandlight Chat Preset Support</strong><br>The bundled Wandlight chat preset adds structured scene headers that improve fast context detection. Wandlight can check and install the preset, but the extension still works without it.</td>
  </tr>
  <tr>
    <td width="50%" valign="top"><strong>Basic And Advanced Experience Modes</strong><br>Basic mode keeps Wandlight focused on the core workflow: context, lore review, and injection. Advanced mode unlocks deeper controls for continuity scanning, automation, workbenches, timeline recovery, prompt placement, compression, and tuning.</td>
    <td width="50%" valign="top"><strong>Guided Walkthroughs</strong><br>Built-in walkthroughs introduce the core workflow in Basic mode and the full operator toolset in Advanced mode, highlighting the relevant controls directly inside the runtime window.</td>
  </tr>
  <tr>
    <td width="50%" valign="top"><strong>Flexible Automation Modes</strong><br>Manual, Assisted, and Automatic modes let users choose how much Wandlight does in the background, from click-only operation to automatic continuity, context, lore, and relevance maintenance.</td>
    <td width="50%" valign="top"></td>
  </tr>
</table>

## Wandlight In Use

Wandlight runs inside SillyTavern as a focused writing companion: it suggests relevant canon lore, keeps accepted lore editable, and provides larger workbench views when a story grows beyond a handful of cards.

### Canon Lore Suggestions

Local canon suggestions use the current Story Context to find date-aware lore cards from the bundled database.

![Wandlight suggesting canon lore](Images/documentation/renders/wandlight-example-suggesting-canon-lore.png)

### Accepted Lore Entries

Accepted lore stays searchable, editable, and organized by relevance, category, source, pin/mute state, and metadata.

![Wandlight accepted lore entries](Images/documentation/renders/wandlight-example-lore-entries.png)

### Lore Workbench

The lore workbench gives long-form stories a larger management surface for reviewing, editing, filtering, and maintaining lore cards.

![Wandlight lore workbench](Images/documentation/renders/wandlight-example-lore-workbench.png)

## Getting Started

### Install Wandlight

In SillyTavern, open **Extensions**, choose **Install extension**, and paste the Wandlight GitHub URL:

```text
https://github.com/MentallyQuill/Wandlight
```

After installation, restart or reload SillyTavern. Open Wandlight from the **Runtime Window** dropdown in the Extensions menu; if the window is ever closed or needs to be reset, use the same dropdown to bring it back.

### Recommended First Workflow

1. Open Wandlight from the Extensions menu's **Runtime Window** dropdown and confirm it is active.
2. Open **API and Model Settings** from the Extensions menu if you want Wandlight to run model-backed tasks. Configure the provider, API, and model settings before using context detection fallback, continuity scans, compression, or story-lore generation. If using a Connection Profile provider, install the **Provider preset** from that provider row, then create or update a SillyTavern Connection Profile that uses it.
3. Check the Wandlight preset status. Install or update the preset if you want structured scene headers.
4. Detect Story Context so Wandlight knows the current date, canon boundary, and branch.
5. Preview Canon Packs or scan Story Lore.
6. Review Pending Lore before accepting it.
7. Open Injection and verify what Wandlight will send into the next prompt.
8. Move to Advanced mode when you want continuity scanning, workbenches, automation, timeline recovery, or prompt-placement controls.

### Basic Mode

Basic mode gives you the shortest path through Wandlight: set context, add or review lore, and inspect injection.

![Basic Lore](Images/documentation/renders/basic-lore-overview.png)

### Guided Tours

Guided tours start from the Session tab. In Basic mode, use **Start Walkthrough** for a practical first pass through Wandlight's core workflow: confirming the extension is active, setting story context, finding relevant lore, reviewing lore cards, and checking what will be injected into the next prompt.

Switch to Advanced mode and use **Start Advanced Walkthrough** for the full operator tour. This walkthrough introduces the expanded controls for automation, continuity, lore generation and review, timeline tools, relevance tuning, prompt placement, injection previewing, and compression behavior.

## Operator's Manual

The operator manual is organized by Wandlight runtime tab. Basic mode is enough for normal use; Advanced mode exposes the full control surface.

### Runtime Shelf

Wandlight opens as a runtime shelf inside SillyTavern. The shelf can stay expanded while you work through context, lore, continuity, and injection tools, or collapse down when you want the chat surface back.

Use the **Runtime Window** dropdown in SillyTavern's Extensions menu to open, refocus, or restore the Wandlight runtime window if it has been closed.

![Runtime Window Dropdown](Images/documentation/renders/wandlight-runtime-window-dropdown.png)

<p align="center">
  <img src="Images/documentation/renders/wandlight-shelf-minimized.png" alt="Wandlight Shelf Minimized" width="79" height="564">
  <img src="Images/documentation/renders/wandlight-shelf-expanded.png" alt="Wandlight Shelf Expanded" width="266" height="600">
</p>

### Session

The Session tab is the runtime status panel. It controls whether Wandlight is active, whether you are in Basic or Advanced mode, and how much automation Wandlight should perform.

![Advanced Session](Images/documentation/renders/advanced-session-overview.png)

Key controls:

- **Experience Mode** switches between Basic and Advanced controls.
- **Automation Mode** controls whether Wandlight is Manual, Assisted, or Automatic.
- **Wandlight Preset** checks whether the bundled chat preset is installed and can install/update it.
- **Session Metrics** show pending lore, accepted lore, selected injection entries, and token estimates.
- **Danger Zone** contains destructive cleanup actions for the current chat.

![Session Danger Zone](Images/documentation/renders/advanced-session-danger-zone.png)

### Context

Story Context tells Wandlight where the story is in the Harry Potter timeline. Canon suggestions, story-lore generation, and relevance scoring all depend on this date/canon/branch anchor.

![Advanced Context](Images/documentation/renders/advanced-context-overview.png)

#### Detect Story Context

Wandlight can detect Story Context from recent chat. If the Wandlight preset is producing structured headers, fast header detection can update context locally before spending a model call.

![Context Detection](Images/documentation/renders/advanced-context-detection.png)

#### Story Context Editor

Use the editor when the story is an AU, time-travel branch, unclear date, or custom canon point. Manual edits immediately affect local canon lookup and story-lore generation.

![Story Context Fields](Images/documentation/renders/advanced-context-fields.png)

### Continuity

Continuity is lightweight live state. It tracks what matters for the next scene without turning every temporary detail into permanent lore.

![Advanced Continuity](Images/documentation/renders/advanced-continuity-overview.png)

#### Continuity Scan

The continuity scanner updates current scene state, active characters, key items, and active goals/threads. It supports recent scans, custom ranges, entire-chat backfills, adaptive strategy selection, retries, and checkpoint recovery.

![Continuity Scan](Images/documentation/renders/advanced-continuity-scan.png)

#### Pending Continuity Changes

When continuity changes need review, Wandlight can show the pending delta before applying it.

![Pending Continuity Changes](Images/documentation/renders/advanced-continuity-pending-delta.png)

#### Tracked Sections

Tracked Sections control which continuity areas are scanned and injected. Disabling a section preserves saved data but stops treating that field as live prompt state.

![Tracked Sections](Images/documentation/renders/advanced-continuity-tracked-sections.png)

#### Scene And Timeline

Scene and Timeline store immediate current-scene context such as date, location, cast, activity, and branch state.

![Scene And Timeline](Images/documentation/renders/advanced-continuity-scene.png)

#### Active Characters

Active Characters track scene-level character state: location, posture, appearance, emotional state, immediate goals, and relevant carried items.

![Active Characters](Images/documentation/renders/advanced-continuity-characters.png)

#### Key Items

Key Items track consequential current objects, ownership, location, and object status.

![Key Items](Images/documentation/renders/advanced-continuity-items.png)

#### Active Goals And Threads

Active Goals and Threads keep immediate unresolved objectives available to the model without making them permanent lore.

![Active Goals And Threads](Images/documentation/renders/advanced-continuity-threads.png)

### Lore

Lore is the durable memory system. Wandlight separates proposed lore from accepted lore so you can review, edit, and reject entries before they affect prompt injection.

![Advanced Lore](Images/documentation/renders/advanced-lore-overview.png)

#### Lore Timeline

The timeline summary shows accepted-lore change history and opens the full timeline visualizer.

![Lore Timeline Card](Images/documentation/renders/advanced-lore-timeline-card.png)

The full timeline visualizer gives long-form stories an audit trail for lore creation, update, deletion, restoration, pin/mute changes, and metadata changes.

![Lore Timeline Visualizer](Images/documentation/renders/advanced-lore-timeline-visualizer.png)

#### Lore Generation

Lore Generation is split into local canon suggestions and model-based story lore scans.

![Lore Generation](Images/documentation/renders/advanced-lore-generation.png)

#### Canon Pack Preview

Preview Canon Packs queries the local `Lore/` database using the current Story Context. It groups date-aware canon constraints into selectable packs and does not require a model call.

![Canon Preview Results](Images/documentation/renders/advanced-lore-canon-preview-results.png)

#### Story Lore Scan

Story Lore Scan uses the Reasoning provider to extract durable story-specific lore from active chat history. Results are checkpointed, quality-gated, routed for update/merge when similar lore exists, and sent to Pending Review.

![Story Lore Scan](Images/documentation/renders/advanced-lore-story-panel.png)

#### New Lore

Manual lore creation lets you create a pending draft directly when you already know what the story needs to remember.

![New Lore Entry](Images/documentation/renders/advanced-lore-new-entry-filled.png)

#### Pending Lore Review

Pending Review is where generated, suggested, and manual lore becomes editable before acceptance.

![Pending Lore Review](Images/documentation/renders/advanced-lore-pending-review.png)

Each pending card shows title, relevance, canon/AU status, category, priority, routing metadata, tags, lore text, injection override, and review actions.

![Pending Lore Entry](Images/documentation/renders/advanced-lore-pending-entry.png)

For large batches, use the Pending Workbench.

![Pending Lore Workbench](Images/documentation/renders/advanced-lore-workbench-pending.png)

#### Accepted Lore

Accepted Lore is stored, searchable, editable, and eligible for injection unless muted.

![Accepted Lore Overview](Images/documentation/renders/advanced-lore-accepted-overview.png)

Accepted entries can be edited after acceptance. Pin protects and prioritizes. Mute keeps the entry stored but excludes it from injection.

![Accepted Lore Entry](Images/documentation/renders/advanced-lore-accepted-entry.png)

For large accepted-lore collections, use the Accepted Workbench.

![Accepted Lore Workbench](Images/documentation/renders/advanced-lore-workbench-accepted.png)

#### Auto-Relevance

Auto-Relevance periodically compares accepted lore against recent chat and Story Context. It can suggest tier changes for review or apply high-confidence changes automatically.

![Auto-Relevance](Images/documentation/renders/advanced-lore-auto-relevance.png)

### Injection

Injection controls what Wandlight sends to the model. Accepted lore is grouped by relevance so immediate details can stay close to the prompt while background lore can be deeper, compressed, or disabled.

![Advanced Injection](Images/documentation/renders/advanced-injection-overview.png)

#### Prompt Placement

Prompt Placement configures role, position, depth, and transport for Continuity and each lore relevance tier.

![Prompt Placement](Images/documentation/renders/advanced-injection-prompt-placement.png)

#### Continuity Injection

Continuity Injection shows the current live-state block and its Direct/Compressed handling controls.

![Continuity Injection Preview](Images/documentation/renders/advanced-injection-continuity-preview.png)

#### Lore Injection Preview

Lore Injection previews the accepted lore selected for injection after relevance tiering, pin/mute rules, sorting, and compression settings.

![Combined Lore Preview](Images/documentation/renders/advanced-injection-combined-preview.png)

#### Compression Prompts

Compression prompts control how Wandlight compacts Continuity and relevance-tiered Lore blocks when a group is set to Compressed mode.

![Compression Prompts](Images/documentation/renders/advanced-injection-compression.png)

### Settings And Providers

Use **API and Model Settings** from SillyTavern's Extensions menu to configure Wandlight's model-backed behavior. This is where you choose provider roles, API mode, model names, token limits, sampling settings, and connection tests.

<p align="center">
  <img src="Images/documentation/renders/wandlight-API-settings-dropdown.png" alt="API and Model Settings Dropdown" width="420">
</p>

Wandlight has two provider roles:

- **Utility Provider** handles frequent, cheaper tasks such as compression and continuity scans.
- **Reasoning Provider** handles deeper tasks such as Story Context model fallback and Story Lore Scan.

Suggested starting points:

| Provider Role | Suggested Models |
| --- | --- |
| **Reasoning** | Opus 4.6+, ChatGPT-5.5, GLM-5.1, Deepseek-V4 Thinking |
| **Utility** | Minimax-M2.7+, DeepSeek V4 Flash (Thinking), Qwen3.6 A3B Thinking |

Each provider can use:

- the current SillyTavern model
- a SillyTavern connection profile
- a direct OpenAI-compatible endpoint with an encrypted local API key

Direct OpenAI-compatible endpoints are the simplest provider path when you are comfortable storing a Wandlight-specific key in the browser session. Connection Profiles are useful when you want SillyTavern to hold the provider key server-side, but they also carry a settings preset. When using a Connection Profile provider, install the **Provider preset** from that provider row in **API and Model Settings**, then create or update a SillyTavern Connection Profile that uses the Provider preset with your preferred provider, model, and key. The bundled Provider preset is intentionally thin, avoiding provider-specific model defaults, normal-chat prompt scaffolding, and the full Wandlight preset in background utility/reasoning calls.

For direct endpoints and the current SillyTavern model, Wandlight exposes temperature, top-p, max tokens, reset defaults, and connection testing. For Connection Profiles, tune sampling and token settings in the SillyTavern profile/preset instead; Wandlight disables those local fields to avoid implying they own the profile.

#### Connection Profiles

Connection Profiles are the recommended setup when you want Wandlight's provider keys and provider routing handled by SillyTavern instead of by Wandlight's browser-local direct endpoint storage.

<p align="center">
  <img src="Images/documentation/renders/API-connection-profiles.png" alt="API settings using Connection Profiles" width="420">
</p>

Use separate profiles when you want different models for different job types. A Utility profile can point at a cheaper, faster model for compression and continuity scans, while a Reasoning profile can point at a stronger model for Story Context fallback and Story Lore Scan.

Recommended setup:

1. In Wandlight's **API and Model Settings**, set Utility Provider and/or Reasoning Provider to **Connection Profile**.
2. Install or reinstall the **Provider preset** from the matching provider row.
3. In SillyTavern, create or update a Connection Profile using your preferred provider, model, key, and the Provider preset.
4. Return to Wandlight, select the saved Connection Profile from the dropdown, then run **Test Utility** or **Test Reasoning**.

When a provider role uses Connection Profile mode, the local temperature, top-p, and max-token fields in Wandlight are disabled because the selected SillyTavern profile and Provider preset own those generation settings. If output shape changes unexpectedly, check the Connection Profile's selected preset first.

### Local Lore Database

The bundled `Lore/` database is a chronology and constraint layer, not a wiki. Its job is to answer questions like:

- What is true on this date?
- What has not happened yet?
- Who knows this secret right now?
- Which future canon facts must not leak?
- Which spells, abilities, ages, or behaviors are plausible at this point?
- How should an AU branch override mainline canon?

See [Lore/README.md](Lore/README.md) for schema guidance, custom file setup, gate types, scoring, and authoring policy.

## Lore Card Model

![Lore Entry Card](Images/documentation/renders/lore-entry-card.png)

Accepted lore entries use independent fields:

| Field | Meaning |
|---|---|
| Relevance | High, Normal, or Low. Controls injection tier, sorting, and compression budget. |
| Canon | Canon or AU. Canon describes mainline/reference lore; AU describes branch or story-specific lore. |
| Category | Character, Event, Location, Item, Spell, Faction, Relationship, Rule, Timeline, Knowledge, Secret, or Other. |
| Priority | Sort order inside the same relevance tier. |
| Pin | Priority/protection during injection and compression. |
| Mute | Hard injection off switch. Muted entries are stored but excluded from injection and compression. |

## Relevance Tiers

| Tier | Use | Default posture |
|---|---|---|
| High | Current-scene facts, present characters, current location, immediate constraints, active secrets/items/events. | Inject close to the prompt; usually direct. |
| Normal | Recent background, near-future or near-past canon, important branch facts, useful medium-context lore. | Inject at medium depth; direct or compressed depending on token pressure. |
| Low | Long-term background, broad canon, distant past/future, low-context facts. | Inject deeper; often compressed or disabled unless needed. |

## License

See [LICENSE](LICENSE).
