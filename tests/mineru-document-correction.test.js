'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { buildCorrectionDraft } = require('../modules/services/minerU/documentCorrection');
const evidence = {
    schema: 'mineru.document-evidence', complete: true, truncated: false,
    totalPages: 2, paperId: 'paper_0123456789abcdef',
    pdfSha256: '0123456789abcdef' + '0'.repeat(48),
    pages: [{ page: 1, text: 'efficient film effect' }, { page: 2, text: 'efficient' }],
};
test('ligatures expand with evidence, preserving source and accurate offsets', () => {
    const source = '# Title\n\ne\uFB03cient film and e\uFB03cient effect.\n';
    const result = buildCorrectionDraft(source, evidence);
    assert.equal(result.correctedMarkdown, '# Title\n\nefficient film and efficient effect.\n');
    assert.equal(result.changes.length, 2);
    for (const change of result.changes) {
        assert.equal(source.slice(change.start, change.end), change.before);
        assert.deepEqual(change.evidencePages, [1, 2]);
    }
    assert.equal(result.originalSha256, crypto.createHash('sha256').update(source).digest('hex'));
    assert.equal(result.sourceModified, false);
    assert.equal(result.coverage.scientificAccuracyVerified, false);
});
test('math, fenced/inline code, links and image references are untouched', () => {
    const source = [
        '`e\uFB03cient`', '$e\uFB03cient$', '$$e\uFB03cient$$',
        '\\(e\uFB03cient\\)', '\\[e\uFB03cient\\]',
        '```text\ne\uFB03cient\n```', '~~~\ne\uFB03cient\n~~~',
        '![e\uFB03cient](images/fi.png)', '[e\uFB03cient](https://example.invalid)',
    ].join('\n');
    const result = buildCorrectionDraft(source, evidence);
    assert.equal(result.correctedMarkdown, source);
    assert.equal(result.changes.length, 0);
});
test('unverified words are review candidates, not applied replacements', () => {
    const source = 'unknown\uFB00word';
    const result = buildCorrectionDraft(source, evidence);
    assert.equal(result.correctedMarkdown, source);
    assert.equal(result.unresolved.length, 1);
    assert.equal(result.requiresReview, true);
});
test('incomplete evidence rejects rather than presenting a full correction', () => {
    assert.throws(() => buildCorrectionDraft('text', { ...evidence, complete: false }));
    assert.throws(() => buildCorrectionDraft('text', { ...evidence, totalPages: 3 }));
});