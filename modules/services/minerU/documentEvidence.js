'use strict';

const MAX_PAGES = 200;
const MAX_BYTES = 24 * 1024 * 1024;

async function collectDocumentEvidence({ inspect, isCancelled = () => false, onProgress = () => {} }) {
    if (typeof inspect !== 'function') throw new Error('PDF_REVIEW_INSPECT_REQUIRED');
    const pages = [];
    let hash = null;
    let paperId = null;
    let total = null;
    let bytes = 0;
    function checkCancel() {
        if (isCancelled()) throw new Error('PDF_REVIEW_CANCELLED');
    }
    for (let page = 1; total === null || page <= total; page++) {
        checkCancel();
        const result = await inspect({
            page, withImage: false, dpi: 72,
            ...(hash ? { expectedHash: hash } : {}),
        });
        checkCancel();
        const data = result?.data;
        if (!data || data.schema !== 'mineru.pdf-region' || data.schema_version !== 1
            || data.page !== page || data.complete !== true || data.truncated !== false
            || data.read_only !== true || !/^[a-f0-9]{64}$/.test(data.sha256)
            || data.paper_id !== `paper_${data.sha256.slice(0, 16)}`
            || !Number.isInteger(data.total_pages) || data.total_pages < 1
            || typeof data.text !== 'string' || !Array.isArray(data.spans)) {
            throw new Error('PDF_REVIEW_INVALID_PAGE');
        }
        if (total === null) {
            total = data.total_pages;
            hash = data.sha256;
            paperId = data.paper_id;
            if (total > MAX_PAGES) throw new Error('PDF_REVIEW_PAGE_LIMIT：最多200页，不生成截断校正版。');
        }
        if (data.sha256 !== hash || data.paper_id !== paperId || data.total_pages !== total) {
            throw new Error('PDF_REVIEW_SOURCE_CHANGED');
        }
        const evidence = {
            page, text: data.text, spans: data.spans,
            pageBounds: data.page_bounds, originalRotation: data.original_rotation,
            coordinateSystem: data.coordinate_system,
        };
        bytes += Buffer.byteLength(JSON.stringify(evidence), 'utf8');
        if (bytes > MAX_BYTES) throw new Error('PDF_REVIEW_EVIDENCE_LIMIT：证据超过24MB，未返回部分校正版。');
        pages.push(evidence);
        onProgress({ phase: 'collecting', completedPages: page, totalPages: total });
    }
    checkCancel();
    return {
        schema: 'mineru.document-evidence', schemaVersion: 1,
        paperId, pdfSha256: hash, totalPages: total, pages,
        complete: true, truncated: false,
        readingOrderVerified: false, correctionsApplied: false,
    };
}

module.exports = { collectDocumentEvidence };