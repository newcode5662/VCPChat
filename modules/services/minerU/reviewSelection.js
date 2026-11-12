'use strict';
const crypto = require('crypto');
const hash = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

function composeSelection(original, draft, selected) {
    if (typeof original !== 'string' || hash(original) !== draft?.originalSha256) {
        throw new Error('PDF_REVIEW_SOURCE_CHANGED');
    }
    const proposals = draft.reviewProposals || [];
    if (!Array.isArray(selected) || selected.length > 300
        || selected.some(i => !Number.isInteger(i) || i < 0 || i >= proposals.length)
        || new Set(selected).size !== selected.length) {
        throw new Error('PDF_REVIEW_SELECTION_INVALID');
    }
    function validate(edit, replacement) {
        if (!Number.isInteger(edit.start) || !Number.isInteger(edit.end)
            || edit.start < 0 || edit.end <= edit.start || edit.end > original.length
            || typeof replacement !== 'string'
            || original.slice(edit.start, edit.end) !== edit.before) {
            throw new Error('PDF_REVIEW_EDIT_INVALID');
        }
        return { ...edit, after: replacement };
    }
    const accepted = selected.map(index => ({
        ...validate(proposals[index], proposals[index].proposed),
        proposalIndex: index, acceptance: 'user-selected',
    })).sort((a, b) => a.start - b.start);
    for (let i = 1; i < accepted.length; i++) {
        if (accepted[i].start < accepted[i - 1].end) throw new Error('PDF_REVIEW_OVERLAPPING_SELECTION');
    }
    const automatic = [];
    for (const item of draft.changes || []) {
        const change = validate(item, item.after);
        const overlap = accepted.find(p => change.start < p.end && change.end > p.start);
        if (overlap) {
            if (change.start < overlap.start || change.end > overlap.end) {
                throw new Error('PDF_REVIEW_OVERLAPPING_SELECTION');
            }
            continue;
        }
        automatic.push(change);
    }
    const edits = [...accepted, ...automatic].sort((a, b) => a.start - b.start);
    for (let i = 1; i < edits.length; i++) {
        if (edits[i].start < edits[i - 1].end) throw new Error('PDF_REVIEW_OVERLAPPING_SELECTION');
    }
    let markdown = original;
    for (const edit of [...edits].reverse()) {
        markdown = markdown.slice(0, edit.start) + edit.after + markdown.slice(edit.end);
    }
    if (Buffer.byteLength(markdown, 'utf8') > 24 * 1024 * 1024) {
        throw new Error('PDF_REVIEW_RESULT_LIMIT');
    }
    return {
        schema: 'mineru.review-selection', schemaVersion: 1,
        paperId: draft.paperId, pdfSha256: draft.pdfSha256,
        originalSha256: draft.originalSha256, correctedSha256: hash(markdown),
        correctedMarkdown: markdown, acceptedProposalIndices: [...selected].sort((a, b) => a - b),
        edits, sourceModified: false, scientificAccuracyVerified: false,
        coverage: draft.coverage, alignmentCoverage: draft.alignmentCoverage,
        limitations: draft.limitations,
    };
}
module.exports = { composeSelection };