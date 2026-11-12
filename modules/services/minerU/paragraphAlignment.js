'use strict';

function expand(text) {
    const map = { '\uFB00':'ff', '\uFB01':'fi', '\uFB02':'fl',
        '\uFB03':'ffi', '\uFB04':'ffl', '\uFB05':'st', '\uFB06':'st' };
    return text.replace(/[\uFB00-\uFB06]/g, c => map[c]);
}
function tokens(text) {
    return new Set(expand(text).toLowerCase().replace(/\\[a-z]+/g, ' ')
        .match(/[a-z]{3,}/g) || []);
}
function similarity(a, b) {
    if (!a.size || !b.size) return 0;
    let common = 0;
    for (const word of a) if (b.has(word)) common++;
    return 2 * common / (a.size + b.size);
}
function blocksFromEvidence(evidence) {
    const blocks = [];
    for (const page of evidence.pages) {
        if (!Array.isArray(page.spans)) continue;
        const grouped = new Map();
        for (const span of page.spans) {
            if (!Number.isInteger(span.block) || !Number.isInteger(span.line)
                || typeof span.text !== 'string' || !Array.isArray(span.bbox)
                || span.bbox.length !== 4 || !span.bbox.every(Number.isFinite)) continue;
            if (!grouped.has(span.block)) grouped.set(span.block, []);
            grouped.get(span.block).push(span);
        }
        for (const [block, spans] of grouped) {
            const lines = new Map();
            const rawLines = new Map();
            const superscripts = '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻';
            const normalByLine = new Map();
            for (const span of spans) {
                if (!(span.flags & 1) && span.text.trim() && Number.isFinite(span.size)) {
                    const previous = normalByLine.get(span.line);
                    if (!previous || span.size > previous.size) normalByLine.set(span.line, span);
                }
            }
            for (const span of spans) {
                if (!lines.has(span.line)) lines.set(span.line, []);
                if (!rawLines.has(span.line)) rawLines.set(span.line, []);
                rawLines.get(span.line).push(span.text);
                const normal = normalByLine.get(span.line);
                const supportedSuper = normal && (span.flags & 1)
                    && /^[0-9+-]+$/.test(span.text)
                    && Number.isFinite(span.size) && span.size < normal.size * 0.8
                    && Array.isArray(span.origin) && Array.isArray(normal.origin)
                    && normal.origin[1] - span.origin[1] > normal.size * 0.2;
                const text = supportedSuper
                    ? [...span.text].map(c => superscripts['0123456789+-'.indexOf(c)]).join('')
                    : span.text;
                lines.get(span.line).push(text);
            }
            const raw = [...rawLines.values()].map(parts => parts.join('')).join('\n');
            const candidate = [...lines.values()].map(parts => parts.join('')).join('\n');
            const text = expand(candidate).replace(/\s+/g, ' ').trim();
            if (text.length < 40 || text.length > 16000) continue;
            blocks.push({
                page: page.page, block, text, raw, tokens: tokens(text),
                bbox: [
                    Math.min(...spans.map(s => s.bbox[0])),
                    Math.min(...spans.map(s => s.bbox[1])),
                    Math.max(...spans.map(s => s.bbox[2])),
                    Math.max(...spans.map(s => s.bbox[3])),
                ],
            });
        }
    }
    return blocks;
}
function proposeParagraphCorrections(markdown, evidence) {
    const blocks = blocksFromEvidence(evidence);
    const proposals = [];
    let inspected = 0;
    // Markdown boundaries are retained; never rebuild the document from PDF order.
    const pattern = /[^\r\n]+(?:\r?\n(?!\s*\r?\n)[^\r\n]+)*/g;
    for (const match of markdown.matchAll(pattern)) {
        const before = match[0];
        if (before.length < 60 || before.length > 16000
            || /```|~~~|!\[|^\s*\||<table|^\s*</m.test(before)) continue;
        if (++inspected > 3000) break;
        const words = tokens(before);
        if (words.size < 10) continue;
        const ranked = blocks.map(block => ({ block, score: similarity(words, block.tokens) }))
            .filter(item => item.score >= 0.80)
            .sort((a, b) => b.score - a.score);
        if (!ranked.length) continue;
        const best = ranked[0];
        if (ranked[1] && best.score - ranked[1].score < 0.08) continue;
        const heading = before.match(/^(#{1,6})\s+/)?.[1];
        // A PDF text block is not Markdown: escape inline syntax before proposing.
        const escaped = [...best.block.text].map(c =>
            '\\`*_{}[]<>$'.includes(c) ? '\\' + c : c).join('');
        const after = (heading ? heading + ' ' : '') + escaped;
        if (expand(before).replace(/\s+/g, ' ').trim() === after) continue;
        proposals.push({
            start: match.index, end: match.index + before.length,
            before, proposed: after, rule: 'pdf-block-alignment',
            status: 'review-required', autoApply: false,
            similarity: Number(best.score.toFixed(4)),
            evidence: { page: best.block.page, block: best.block.block,
                bbox: best.block.bbox, rawText: best.block.raw },
            warnings: [
                'Token overlap is not semantic equivalence.',
                'PDF text may flatten superscripts and retain line-end hyphenation.',
                'Check numbers, chemical notation, formulas, citations and paragraph boundaries before accepting.',
            ],
        });
        if (proposals.length >= 300) break;
    }
    return { proposals, inspectedParagraphs: inspected,
        pagesWithoutSpans: evidence.pages.filter(page =>
            !Array.isArray(page.spans) || page.spans.length === 0).map(page => page.page),
        proposalLimitReached: proposals.length >= 300 || inspected > 3000 };
}
module.exports = { proposeParagraphCorrections, blocksFromEvidence };