import assert from 'node:assert/strict';
import { __bulkLoreTestHooks } from '../lore-generator.js';

const {
  extractWandlightReplyHeader,
  inferStoryContextFromReplyHeaders,
  inferHarryPotterCanonBoundary,
  parseSceneDateParts,
} = __bulkLoreTestHooks;

const presetHeader = '*Saturday, Jan 25, 1997 | 10:12 AM | Disused Third-Floor Classroom | Overcast - Light Snow*';
const parsedHeader = extractWandlightReplyHeader(`${presetHeader}\n\nHermione looked up from the book.`);

assert.equal(parsedHeader.sceneDate, 'Saturday, Jan 25, 1997');
assert.equal(parsedHeader.timeOfDay, '10:12 AM');
assert.equal(parsedHeader.location, 'Disused Third-Floor Classroom');
assert.equal(parsedHeader.weather, 'Overcast - Light Snow');

const fullWeekdayDate = parseSceneDateParts('Saturday, Jan 25, 1997');
assert.equal(fullWeekdayDate.year, 1997);
assert.equal(fullWeekdayDate.month, 0);
assert.equal(fullWeekdayDate.day, 25);
assert.match(inferHarryPotterCanonBoundary('Saturday, Jan 25, 1997'), /Half-Blood Prince era, Year 6/);

const state = {
  loreContext: {
    branchId: 'au_conundrum',
    timeTravelMode: 'alternate_branch',
    subjectiveDate: 'Hermione remembers the original Year 6 timeline',
    canonBoundary: 'Order of the Phoenix era, Year 5',
  },
  canon: {},
};

const inferred = inferStoryContextFromReplyHeaders([
  { is_user: true, name: 'User', mes: 'Can we continue the scene?' },
  { is_user: false, name: 'Hermione', mes: '*Friday, Sep 13, 1996 | 9:00 PM | Library | Clear*\nOlder reply.' },
  { is_user: true, name: 'User', mes: '*Sunday, Jun 1, 1997 | 8:00 PM | Quoted Header | Rain*\nThis user line should not win.' },
  { is_user: false, name: 'Hermione', mes: `${presetHeader}\n\n"That whisper was not normal," Hermione said.` },
], state);

assert.equal(inferred.sceneDate, 'Saturday, Jan 25, 1997');
assert.match(inferred.canonBoundary, /Half-Blood Prince era, Year 6/);
assert.equal(inferred.branchId, 'au_conundrum');
assert.equal(inferred.timeTravelMode, 'alternate_branch');
assert.equal(inferred.subjectiveDate, 'Hermione remembers the original Year 6 timeline');

const noHeader = inferStoryContextFromReplyHeaders([
  { is_user: true, name: 'User', mes: presetHeader },
  { is_user: false, name: 'Hermione', mes: 'No header in this assistant reply.' },
], state);

assert.equal(noHeader, null);

console.log('Story context header detection tests passed.');
