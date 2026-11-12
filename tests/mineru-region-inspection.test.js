'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeRequest, validateResult } = require('../modules/services/minerU/regionInspection');
const hash = '0123456789abcdef' + '0'.repeat(48);
const record = { paperId: 'paper_0123456789abcdef', pdfPath: '/fixtures/a.pdf', pdfBindingStatus: 'bound' };
function response() {
    return { ok: true, data: {
        schema: 'mineru.pdf-region', schema_version: 1,
        paper_id: record.paperId, sha256: hash, page: 1, total_pages: 2,
        complete: true, truncated: false, read_only: true,
        ocr_used: false, corrections_applied: false,
        text: 'Evidence', spans: [], bbox: [0, 0, 100, 100], page_bounds: [0, 0, 100, 100],
        image: { width: 100, height: 100 },
    }, content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] };
}
test('request derives path from trusted record and rejects injected options', () => {
    const r = makeRequest(record, { page: 1, withImage: false, expectedHash: hash });
    assert.equal(r.file_path, record.pdfPath);
    assert.equal(r.with_base64, false);
    for (const options of [{ page: 1, file_path: '/secret' }, { page: true },
        { page: 1, bbox: [0, 0, NaN, 10] }, { page: 1, dpi: 301 }]) {
        assert.throws(() => makeRequest(record, options));
    }
    assert.throws(() => makeRequest({ ...record, pdfBindingStatus: 'disabled' }, { page: 1 }));
});
test('valid response preserves image and rejects incomplete or foreign metadata', () => {
    const request = makeRequest(record, { page: 1 });
    assert.equal(validateResult(response(), request).data.text, 'Evidence');
    assert.ok(validateResult(response(), request).imageUrl);
    for (const patch of [{ page: 2 }, { paper_id: 'paper_ffffffffffffffff' },
        { sha256: 'f'.repeat(64) }, { complete: false }, { truncated: true },
        { read_only: false }, { bbox: [0, 0, 0, 0] }]) {
        const result = response();
        Object.assign(result.data, patch);
        assert.throws(() => validateResult(result, request), /RESPONSE_INVALID/);
    }
});
test('expected hash and crop must match; text-only does not require image', () => {
    const request = makeRequest(record, { page: 1, withImage: false, expectedHash: hash, bbox: [0, 0, 100, 100] });
    const result = response();
    delete result.content;
    assert.equal(validateResult(result, request).imageUrl, null);
    result.data.bbox = [1, 0, 100, 100];
    assert.throws(() => validateResult(result, request));
    result.data.bbox = request.bbox;
    result.data.sha256 = hash.slice(0, 16) + '1'.repeat(48);
    assert.throws(() => validateResult(result, request));
});