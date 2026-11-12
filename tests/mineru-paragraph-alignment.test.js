'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { proposeParagraphCorrections } = require('../modules/services/minerU/paragraphAlignment');
const { buildCorrectionDraft } = require('../modules/services/minerU/documentCorrection');
const original = 'Radial dielectric gradient composites combine electromagnetic wave absorption and antibacterial activity through efficient charge migration and valence modulation.';
const corrupted = original.replace('efficient', 'eficient');
function evidence(text = original) {
    return {
        schema: 'mineru.document-evidence', complete: true, truncated: false, totalPages: 1,
        paperId: 'paper_0123456789abcdef', pdfSha256: '0123456789abcdef' + '0'.repeat(48),
        pages: [{ page: 1, text, spans: [
            { block: 0, line: 0, text, bbox: [20, 40, 500, 80] },
        ] }],
    };
}
test('distinct PDF block produces sourced review candidate only', () => {
    const result = proposeParagraphCorrections(corrupted, evidence());
    assert.equal(result.proposals.length, 1);
    const proposal = result.proposals[0];
    assert.equal(proposal.proposed, original);
    assert.equal(proposal.autoApply, false);
    assert.equal(proposal.evidence.page, 1);
    assert.deepEqual(proposal.evidence.bbox, [20, 40, 500, 80]);
    const draft = buildCorrectionDraft(corrupted, evidence());
    assert.equal(draft.correctedMarkdown, corrupted);
    assert.equal(draft.reviewProposals.length, 1);
});
test('equally matching blocks are rejected rather than arbitrarily chosen', () => {
    const e = evidence();
    e.pages[0].spans.push({ ...e.pages[0].spans[0], block: 1 });
    assert.equal(proposeParagraphCorrections(corrupted, e).proposals.length, 0);
});
test('unchanged paragraphs and unrelated blocks yield no proposals', () => {
    assert.equal(proposeParagraphCorrections(original, evidence()).proposals.length, 0);
    assert.equal(proposeParagraphCorrections(corrupted,
        evidence('This unrelated article concerns marine ecology and habitat protection in coastal environments.')).proposals.length, 0);
});

test('superscript candidate retains untouched raw evidence and escapes Markdown', () => {
    const { blocksFromEvidence } = require('../modules/services/minerU/paragraphAlignment');
    const e = evidence();
    const prefix = 'Radial dielectric gradient composites combine electromagnetic wave absorption and antibacterial activity via Ce';
    e.pages[0].spans = [
        { block: 0, line: 0, text: prefix, bbox: [20, 40, 400, 60], size: 20, flags: 0, origin: [20, 55] },
        { block: 0, line: 0, text: '3+', bbox: [400, 35, 420, 48], size: 13, flags: 1, origin: [400, 48] },
        { block: 0, line: 0, text: ' valence modulation by authors*', bbox: [420, 40, 550, 60], size: 20, flags: 0, origin: [420, 55] },
    ];
    const block = blocksFromEvidence(e)[0];
    assert.match(block.text, /Ce³⁺/);
    assert.match(block.raw, /Ce3\+/);
    assert.doesNotMatch(block.raw, /³/);
    const source = '# ' + prefix + '3+ valence modulation by authors*';
    const proposals = proposeParagraphCorrections(source, e).proposals;
    assert.equal(proposals.length, 1);
    assert.ok(proposals[0].proposed.endsWith('authors\\*'));
    assert.match(proposals[0].proposed, /Ce³⁺/);
    assert.equal(proposals[0].autoApply, false);
});

test('superscript flag without smaller raised font does not alter numbers', () => {
    const { blocksFromEvidence } = require('../modules/services/minerU/paragraphAlignment');
    const e = evidence();
    e.pages[0].spans = [
        { block: 0, line: 0, text: original + ' Ce', bbox: [0, 0, 300, 30], size: 20, flags: 0, origin: [0, 20] },
        { block: 0, line: 0, text: '3+', bbox: [300, 0, 320, 30], size: 20, flags: 1, origin: [300, 20] },
    ];
    assert.ok(blocksFromEvidence(e)[0].text.endsWith('Ce3+'));
});