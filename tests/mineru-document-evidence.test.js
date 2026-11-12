'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { collectDocumentEvidence } = require('../modules/services/minerU/documentEvidence');
const hash = '0123456789abcdef' + '0'.repeat(48);
function page(number, patch = {}) {
    return { data: {
        schema: 'mineru.pdf-region', schema_version: 1,
        paper_id: `paper_${hash.slice(0, 16)}`, sha256: hash,
        page: number, total_pages: 3, complete: true, truncated: false, read_only: true,
        text: `Page ${number}`, spans: [], page_bounds: [0, 0, 300, 400],
        original_rotation: 0, coordinate_system: 'unrotated points',
        ...patch,
    } };
}
test('collects sequential pages pinned to the first PDF hash', async () => {
    const calls = [];
    const progress = [];
    const result = await collectDocumentEvidence({
        inspect: async options => { calls.push(options); return page(options.page); },
        onProgress: p => progress.push(p),
    });
    assert.equal(result.pages.length, 3);
    assert.equal(result.complete, true);
    assert.equal(result.readingOrderVerified, false);
    assert.equal(calls[0].expectedHash, undefined);
    assert.equal(calls[1].expectedHash, hash);
    assert.equal(calls[2].withImage, false);
    assert.equal(progress.at(-1).completedPages, 3);
});
test('cancellation after an in-flight page prevents all later work', async () => {
    let cancelled = false;
    let calls = 0;
    await assert.rejects(collectDocumentEvidence({
        inspect: async () => { calls++; cancelled = true; return page(1); },
        isCancelled: () => cancelled,
    }), /CANCELLED/);
    assert.equal(calls, 1);
});
test('source changes, truncated pages and backend errors do not return partial success', async () => {
    for (const patch of [
        { sha256: hash.slice(0, 16) + '1'.repeat(48) },
        { total_pages: 4 }, { complete: false }, { truncated: true }, { page: 3 },
    ]) {
        await assert.rejects(collectDocumentEvidence({
            inspect: async options => page(options.page, options.page === 2 ? patch : {}),
        }));
    }
    await assert.rejects(collectDocumentEvidence({
        inspect: async options => {
            if (options.page === 2) throw new Error('backend failed');
            return page(1);
        },
    }), /backend failed/);
});
test('large document is rejected before page two', async () => {
    let calls = 0;
    await assert.rejects(collectDocumentEvidence({
        inspect: async () => { calls++; return page(1, { total_pages: 201 }); },
    }), /PAGE_LIMIT/);
    assert.equal(calls, 1);
});