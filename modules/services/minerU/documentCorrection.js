'use strict';
const crypto = require('crypto');
const { proposeParagraphCorrections } = require('./paragraphAlignment');
const LIGATURES = Object.freeze({
    '\uFB00': 'ff', '\uFB01': 'fi', '\uFB02': 'fl', '\uFB03': 'ffi',
    '\uFB04': 'ffl', '\uFB05': 'st', '\uFB06': 'st',
});
const expand = text => text.replace(/[\uFB00-\uFB06]/g, c => LIGATURES[c]);
const digest = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

function buildCorrectionDraft(markdown, evidence) {
    if (typeof markdown !== 'string' || Buffer.byteLength(markdown, 'utf8') > 24 * 1024 * 1024) {
        throw new Error('PDF_CORRECTION_MARKDOWN_LIMIT');
    }
    if (evidence?.schema !== 'mineru.document-evidence' || evidence.complete !== true
        || evidence.truncated !== false || !Array.isArray(evidence.pages)
        || evidence.pages.length !== evidence.totalPages) {
        throw new Error('PDF_CORRECTION_INCOMPLETE_EVIDENCE');
    }
    const vocabulary = new Map();
    for (const page of evidence.pages) {
        for (const match of expand(page.text).matchAll(/[A-Za-z]{2,}/g)) {
            const key = match[0];
            if (!vocabulary.has(key)) vocabulary.set(key, new Set());
            vocabulary.get(key).add(page.page);
        }
    }
    const changes = [];
    const unresolved = [];
    // Conservative protection. This is not a Markdown reserializer:
    // retain byte-for-byte source outside explicit replacement ranges.
    const protectedRanges = [];
    const protectedPattern = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\r\n]*`|\$\$[\s\S]*?(?:\$\$|$)|\$[^$\r\n]*\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|!?\[[^\]\r\n]*\]\([^)\r\n]*\)|<[^>]*>/g;
    for (const m of markdown.matchAll(protectedPattern)) {
        protectedRanges.push([m.index, m.index + m[0].length]);
    }
    let protectedIndex = 0;
    for (const match of markdown.matchAll(/[A-Za-z\uFB00-\uFB06]+/g)) {
        const before = match[0];
        if (!/[\uFB00-\uFB06]/.test(before)) continue;
        const start = match.index;
        const end = start + before.length;
        while (protectedIndex < protectedRanges.length && protectedRanges[protectedIndex][1] <= start) protectedIndex++;
        const interval = protectedRanges[protectedIndex];
        if (interval && interval[0] < end && interval[1] > start) continue;
        const after = expand(before);
        const pages = vocabulary.get(after);
        const item = { start, end, before, after, rule: 'unicode-ligature-expansion' };
        if (!pages || after.length < 2) {
            unresolved.push({ ...item, reason: 'No matching PDF text-layer word' });
            continue;
        }
        changes.push({ ...item, evidencePages: [...pages],
            evidenceKind: 'word-presence-not-paragraph-alignment' });
    }
    let corrected = markdown;
    for (let i = changes.length - 1; i >= 0; i--) {
        const change = changes[i];
        corrected = corrected.slice(0, change.start) + change.after + corrected.slice(change.end);
    }
    const alignment = proposeParagraphCorrections(markdown, evidence);
    return {
        schema: 'mineru.correction-draft', schemaVersion: 1,
        reviewProposals: alignment.proposals,
        alignmentCoverage: {
            inspectedParagraphs: alignment.inspectedParagraphs,
            pagesWithoutSpans: alignment.pagesWithoutSpans,
            proposalLimitReached: alignment.proposalLimitReached,
        },
        paperId: evidence.paperId, pdfSha256: evidence.pdfSha256,
        originalSha256: digest(markdown), correctedSha256: digest(corrected),
        correctedMarkdown: corrected, changes, unresolved,
        sourceModified: false, requiresReview: true,
        coverage: {
            pagesCollected: evidence.pages.length,
            rules: ['unicode-ligature-expansion'],
            paragraphAlignmentVerified: false,
            scientificAccuracyVerified: false,
        },
        limitations: [
            'Only evidenced Unicode ligatures are expanded; this is not full semantic correction.',
            'Hyphenation, chemistry, numerical values, formulas and reading order require separate review.',
            'PDF text-layer word presence is not proof of paragraph-level alignment.',
        ],
    };
}
module.exports = { buildCorrectionDraft };