# Wandlight Continuity compression system audit and fix report

## Package baseline

Baseline package: `WandlightContinuity_lore_ui_layout_fixed.zip`.

## Confirmed faults

### 1. Compression cache appeared to break when switching Direct/Compressed

Root cause: compressed-cache validity was checked with `getMemoSignature(state, 'compressed', kind)`. That signature included broad injection settings and mode state rather than only the actual source text and compression contract. As a result, unrelated settings could make a still-valid cache appear stale.

Fix: added `getCompressionSourceSignature()` in `memo-builder.js`. The new cache signature is based on:

- compression kind: continuity or lore
- compression level
- compression prompt template
- exact direct-source text being compressed
- pinned lore IDs for lore compression, because pinned state changes preservation priority even though it is not included in the direct source text

The cache now survives switching Direct -> Compressed -> Direct -> Compressed when the underlying direct source and compression settings have not changed.

### 2. Reasoning-only empty-content errors during compression

Root cause: `lore-llm-client.js` used a JSON-specific final-output retry for all reasoning-only model responses. Compression is a plain-text task, so the retry incorrectly asked for JSON and could still return empty visible content.

Fixes:

- added `expectedOutput: 'text'` for compression calls
- made final-only retry prompts output-format-aware
- added text-specific visible-output retry handling for:
  - OpenAI-compatible provider
  - SillyTavern raw provider
  - SillyTavern connection profile provider
- increased retry response budget for reasoning models

### 3. Compression level 3 could behave like a rewrite instead of compression

Root cause: the advanced compression prompts only expressed target length in approximate tokens. Existing customized/older templates could omit dynamic target data entirely, and the runtime did not validate whether the result was actually shorter.

Fixes:

- budgets now track both tokens and characters
- prompts now include source length, target length, and hard maximum in both tokens and characters
- older/custom advanced templates automatically receive an appended dynamic length contract if they omit the new character-budget variables
- level 3+ outputs are validated for real reduction
- overlong or insufficiently compressed output triggers one stricter retry
- final status now reports token count, character count, target, and compression ratio

## Files changed

- `constants.js`
- `memo-builder.js`
- `lore-llm-client.js`
- `lore-panel.js`
- `state-manager.js`

## Validation performed

- JavaScript syntax check passed for all extension `.js` files.
- JSON parse validation passed for all bundled `.json` files.
- Cache-signature test passed: compressed continuity cache survives Direct/Compressed mode toggles and unrelated lore-mode changes, but stales correctly when compression level changes.
- Reasoning-only retry test passed: compression retries use visible plain-text instructions, not JSON instructions.
- Pinned-lore signature test passed: changing pinned lore invalidates lore compression cache.
- Zip integrity test passed.

## Notes

This package was validated statically and with isolated runtime-style Node tests. It was not run inside a live SillyTavern browser session in this environment.
