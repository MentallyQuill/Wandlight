import assert from 'node:assert/strict';
import {
  captureLoreTimelineState,
  recordLoreTimelineEvent,
  getLoreTimelineEvents,
  getLoreTimelineSummary,
  getEntryLoreHistory,
  getRecoverableTimelineEntries,
  restoreTimelineEntriesToPending,
} from '../lore-timeline.js';
import { normalizeLoreMatrix } from '../lore-matrix.js';

const state = {
  loreContext: {
    sceneDate: 'Saturday, Jan 25, 1997',
    canonBoundary: 'Half-Blood Prince era, Year 6',
    branchId: 'main',
  },
  loreSelection: { pinnedIds: [], suppressedIds: [] },
  loreMatrix: [],
  pendingLoreEntries: [],
  pendingLoreMeta: null,
  loreTimeline: { schemaVersion: 1, events: [] },
};

let before = captureLoreTimelineState(state);
state.loreMatrix = normalizeLoreMatrix([{
  id: 'conundrum_confidicus',
  title: 'Conundrum Confidicus opening hazard',
  category: 'item',
  canon: 'au',
  relevance: 'high',
  priority: 80,
  fact: 'The Conundrum Confidicus whispers when opened.',
  content: {
    fact: 'The Conundrum Confidicus whispers when opened.',
    injection: 'Whenever the Conundrum Confidicus opens, faint whispers are heard.',
  },
}]);
recordLoreTimelineEvent(state, {
  before,
  after: captureLoreTimelineState(state),
  type: 'manual_create',
  source: 'manual',
  summary: 'Created Conundrum Confidicus lore.',
});

assert.equal(getLoreTimelineEvents(state).length, 1);
assert.equal(getLoreTimelineSummary(state).counts.added, 1);

before = captureLoreTimelineState(state);
state.loreMatrix[0] = {
  ...state.loreMatrix[0],
  fact: 'The Conundrum Confidicus whispers and chills the room when opened.',
  content: {
    ...state.loreMatrix[0].content,
    fact: 'The Conundrum Confidicus whispers and chills the room when opened.',
  },
};
recordLoreTimelineEvent(state, {
  before,
  after: captureLoreTimelineState(state),
  type: 'edit',
  source: 'manual',
  summary: 'Edited Conundrum Confidicus lore.',
});

assert.equal(getLoreTimelineSummary(state).counts.updated, 1);
assert.equal(getEntryLoreHistory(state, 'conundrum_confidicus').length, 2);

before = captureLoreTimelineState(state);
state.loreMatrix = [];
recordLoreTimelineEvent(state, {
  before,
  after: captureLoreTimelineState(state),
  type: 'delete',
  source: 'manual',
  summary: 'Deleted Conundrum Confidicus lore.',
});

const deleteEvent = getLoreTimelineEvents(state).at(-1);
assert.equal(deleteEvent.counts.deleted, 1);
assert.equal(getRecoverableTimelineEntries(deleteEvent).length, 1);

const restored = restoreTimelineEntriesToPending(state, deleteEvent.id);
assert.equal(restored.restored, 1);
assert.equal(state.pendingLoreEntries.length, 1);
assert.equal(state.pendingLoreEntries[0].id, 'conundrum_confidicus');
assert.equal(state.pendingLoreEntries[0].extensions.wandlightTimelineRecovery.eventId, deleteEvent.id);
assert.equal(getLoreTimelineEvents(state).at(-1).type, 'restore_to_pending');

console.log('Lore timeline tests passed.');
