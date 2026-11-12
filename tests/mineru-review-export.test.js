'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { exportReviewBundle } = require('../modules/services/minerU/reviewExport');
test('exports unique bundles with verifiable audit and never overwrites existing files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mineru-export-'));
    try {
        fs.writeFileSync(path.join(root, 'corrected.md'), 'KEEP');
        const text = '# Ce³⁺/Ce⁴⁺\n';
        const selection = {
            schema: 'mineru.review-selection', paperId: 'paper_0123456789abcdef',
            correctedMarkdown: text,
            correctedSha256: crypto.createHash('sha256').update(text).digest('hex'),
            sourceModified: false, acceptedProposalIndices: [0], edits: [],
            scientificAccuracyVerified: false,
        };
        const a = exportReviewBundle(root, selection);
        const b = exportReviewBundle(root, selection);
        assert.notEqual(a.directory, b.directory);
        assert.equal(fs.readFileSync(a.markdownFile, 'utf8'), text);
        assert.equal(fs.readFileSync(path.join(root, 'corrected.md'), 'utf8'), 'KEEP');
        const report = JSON.parse(fs.readFileSync(a.reportFile, 'utf8'));
        assert.equal(report.correctedSha256, selection.correctedSha256);
        assert.equal(report.complete, true);
        assert.equal(report.scientificAccuracyVerified, false);
        assert.equal(a.imagesCopied, false);
        assert.throws(() => exportReviewBundle(root, { ...selection, correctedMarkdown: 'tampered' }), /HASH_MISMATCH/);
        assert.equal(fs.readdirSync(root).length, 3);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});