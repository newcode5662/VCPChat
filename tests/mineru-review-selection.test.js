'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { composeSelection } = require('../modules/services/minerU/reviewSelection');
const original = 'A ﬁlm.\n\nCe3+ example.';
function draft() {
    return {
        originalSha256: crypto.createHash('sha256').update(original).digest('hex'),
        changes: [{ start: 2, end: 5, before: 'ﬁlm', after: 'film' }],
        reviewProposals: [
            { start: 0, end: 7, before: 'A ﬁlm.\n', proposed: 'A thin film.\n' },
            { start: 8, end: original.length, before: 'Ce3+ example.', proposed: 'Ce³⁺ example.' },
        ],
    };
}
test('selection uses original offsets and supersedes contained automatic edits', () => {
    const d = draft();
    const result = composeSelection(original, d, [1, 0]);
    assert.equal(result.correctedMarkdown, 'A thin film.\n\nCe³⁺ example.');
    assert.equal(result.edits.length, 2);
    assert.deepEqual(result.acceptedProposalIndices, [0, 1]);
    assert.equal(composeSelection(original, d, []).correctedMarkdown, 'A film.\n\nCe3+ example.');
    assert.equal(d.reviewProposals[0].before, 'A ﬁlm.\n');
});
test('stale source, duplicate indices and injected indices fail closed', () => {
    assert.throws(() => composeSelection(original + 'changed', draft(), []), /SOURCE_CHANGED/);
    for (const indices of [[0, 0], [-1], [2], ['0'], null]) {
        assert.throws(() => composeSelection(original, draft(), indices), /SELECTION_INVALID/);
    }
});
test('overlapping or altered proposal anchors reject', () => {
    const d = draft();
    d.reviewProposals.push({ start: 2, end: 5, before: 'ﬁlm', proposed: 'film' });
    assert.throws(() => composeSelection(original, d, [0, 2]), /OVERLAPPING/);
    d.reviewProposals[0].before = 'wrong anchor';
    assert.throws(() => composeSelection(original, d, [0]), /EDIT_INVALID/);
});