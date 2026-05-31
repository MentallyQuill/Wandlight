# Wandlight Continuity live feedback fix - 2026-05-31

## Fixed

- Accepted Lore Entries now receives an explicit runtime-calculated height based on the remaining Wandlight Continuity panel height.
- The accepted lore list keeps `overflow-y: scroll` and `max-height: none`, and the height is recalculated after Lore tab rendering, filter/list refreshes, collapsible-section toggles, browser resize, and panel drag-resize.
- Pending Lore Review cards now use the same compact metadata chip pattern as accepted lore cards:
  - pending state badge remains in the right-side action slot
  - category chip uses the registry badge style
  - canon status chip uses the registry badge style
  - priority appears as the same compact `P#` chip
  - lifecycle state is no longer duplicated as a left-side pending-card metadata chip

## Validation

- Chromium layout test confirmed the accepted-lore region remains scrollable and responds to increasing panel height.
- Static source checks confirmed pending cards no longer render the lifecycle state chip in their metadata row and use accepted-card registry chips.
- `node --check` passed for all JavaScript files.
- All JSON files parsed successfully.
