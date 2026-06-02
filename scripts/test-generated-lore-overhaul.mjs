import assert from 'node:assert/strict';
import { __bulkLoreTestHooks } from '../lore-generator.js';
import { routeSimilarLoreEntries, normalizeLoreMatrix } from '../lore-matrix.js';

const {
  candidateFactToLoreEntry,
  classifyGeneratedLoreValue,
  applyGeneratedLoreQualityRouting,
  parseBulkCandidateResponse,
} = __bulkLoreTestHooks;

const batch = 'test_batch';
const chunk = { chunkId: 'chunk_1', startIndex: 1, endIndex: 10, messageHash: 'abc' };

const lowValue = candidateFactToLoreEntry({
  category: 'item',
  subject: 'Conundrum Confidicus',
  fact: 'Hermione found the Conundrum Confidicus book in the restricted section.',
  lorePurpose: 'item_state',
  priorityHint: 'medium',
  relevanceHint: 'normal',
}, { batchId: batch, chunk, profile: { mode: 'bootstrap' } });

assert.equal(lowValue.title, 'Conundrum Confidicus item state');
assert.equal(classifyGeneratedLoreValue(lowValue).route, 'low_value_summary');
assert.equal(applyGeneratedLoreQualityRouting([lowValue], { loreStrictQualityGate: true }).entries.length, 0);

const highValue = candidateFactToLoreEntry({
  operation: 'create',
  category: 'item',
  subject: 'Conundrum Confidicus',
  title: 'Conundrum Confidicus opening hazard',
  fact: 'The Conundrum Confidicus is an ancient book filled with dangerous spells that defy known magic.',
  injection: 'Treat the Conundrum Confidicus as dangerous; whenever it is opened, faint whispers are heard.',
  constraints: ['Each opening produces faint whispers.'],
  antiLore: ['Do not treat it as an ordinary restricted-section book.'],
  lorePurpose: 'item_state',
  priorityHint: 'high',
  relevanceHint: 'high',
}, { batchId: batch, chunk, profile: { mode: 'bootstrap' } });

assert.equal(highValue.title, 'Conundrum Confidicus opening hazard');
assert.equal(classifyGeneratedLoreValue(highValue).keep, true);
assert.equal(highValue.content.injection.includes('whenever it is opened'), true);
assert.equal(highValue.content.constraints.length, 1);

const existing = normalizeLoreMatrix([{
  id: 'conundrum_confidicus',
  title: 'Conundrum Confidicus opening hazard',
  category: 'item',
  canon: 'au',
  relevance: 'normal',
  lorePurpose: 'item_state',
  priority: 80,
  content: {
    fact: 'The Conundrum Confidicus is an ancient book with dangerous magic.',
    injection: 'Treat the Conundrum Confidicus as dangerous.',
  },
}]);

const routed = routeSimilarLoreEntries([highValue], existing, { storyGeneration: true });
assert.equal(routed.dropped.length, 0);
assert.equal(routed.entries.length, 1);
assert.equal(routed.entries[0].extensions.wandlightGeneration.targetEntryId, 'conundrum_confidicus');
assert.match(routed.entries[0].extensions.wandlightGeneration.operation, /merge|update/);

const exactDuplicate = routeSimilarLoreEntries([{
  ...highValue,
  id: 'conundrum_confidicus',
}], existing, { storyGeneration: true });
assert.equal(exactDuplicate.entries.length, 0);
assert.equal(exactDuplicate.dropped.length, 1);

const parsed = parseBulkCandidateResponse(JSON.stringify({
  chunkSummary: 'Book behavior established.',
  facts: [{
    operation: 'merge',
    targetEntryId: 'conundrum_confidicus',
    category: 'item',
    subject: 'Conundrum Confidicus',
    title: 'Conundrum Confidicus opening hazard',
    fact: 'The book whispers whenever opened.',
    injection: 'Whenever the Conundrum Confidicus opens, faint whispers are heard.',
    constraints: ['Opening trigger repeats.'],
    lorePurpose: 'item_state',
    priorityHint: 'high',
    relevanceHint: 'high',
    durabilityReason: 'Recurring object behavior.',
    messageRefs: [3],
  }],
}), chunk);
assert.equal(parsed.facts[0].operation, 'merge');
assert.equal(parsed.facts[0].targetEntryId, 'conundrum_confidicus');
assert.equal(parsed.facts[0].constraints[0], 'Opening trigger repeats.');

console.log('Generated lore overhaul validation passed.');
