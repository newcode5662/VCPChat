'use strict';

const ID = /^paper_[a-f0-9]{16}$/;
const HASH = /^[a-f0-9]{64}$/;

function makeRequest(record, options = {}) {
    if (!record || !ID.test(record.paperId)) throw new Error('PDF_REGION_EXACT_ID_REQUIRED');
    if (!record.pdfPath || record.pdfBindingStatus === 'disabled') {
        throw new Error('PDF_REGION_UNAVAILABLE：请先关联正确的本机 PDF。');
    }
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
        throw new Error('PDF_REGION_OPTIONS_INVALID');
    }
    const allowed = new Set(['page', 'bbox', 'dpi', 'withImage', 'expectedHash']);
    if (Object.keys(options).some(key => !allowed.has(key))) {
        throw new Error('PDF_REGION_OPTIONS_INVALID：不接受文件路径或任意命令。');
    }
    const { page, bbox, dpi = 120, withImage = true, expectedHash } = options;
    if (!Number.isInteger(page) || page < 1 || page > 100000) throw new Error('PDF_REGION_PAGE_INVALID');
    if (!Number.isInteger(dpi) || dpi < 36 || dpi > 300) throw new Error('PDF_REGION_DPI_INVALID');
    if (typeof withImage !== 'boolean') throw new Error('PDF_REGION_IMAGE_FLAG_INVALID');
    if (bbox !== undefined && (!Array.isArray(bbox) || bbox.length !== 4
        || !bbox.every(Number.isFinite) || bbox[0] >= bbox[2] || bbox[1] >= bbox[3])) {
        throw new Error('PDF_REGION_BBOX_INVALID');
    }
    if (expectedHash !== undefined && !HASH.test(expectedHash)) throw new Error('PDF_REGION_HASH_INVALID');
    return {
        command: 'inspect_pdf_region', paper_id: record.paperId,
        file_path: record.pdfPath, page, dpi, with_base64: withImage,
        ...(bbox !== undefined ? { bbox: [...bbox] } : {}),
        ...(expectedHash !== undefined ? { expected_pdf_sha256: expectedHash } : {}),
    };
}

function validateResult(result, request) {
    if (!result?.ok) throw new Error(result?.error || 'PDF_REGION_FAILED');
    const d = result.data;
    const bad = () => { throw new Error('PDF_REGION_RESPONSE_INVALID'); };
    if (!d || d.schema !== 'mineru.pdf-region' || d.schema_version !== 1
        || d.paper_id !== request.paper_id || d.page !== request.page
        || d.complete !== true || d.truncated !== false || d.read_only !== true
        || d.ocr_used !== false || d.corrections_applied !== false
        || typeof d.sha256 !== 'string' || !HASH.test(d.sha256)
        || `paper_${d.sha256.slice(0, 16)}` !== request.paper_id
        || (request.expected_pdf_sha256 && d.sha256 !== request.expected_pdf_sha256)
        || !Number.isInteger(d.total_pages) || d.total_pages < d.page
        || typeof d.text !== 'string' || d.text.length > 120000
        || !Array.isArray(d.spans) || d.spans.length > 4000) bad();
    for (const key of ['bbox', 'page_bounds']) {
        const b = d[key];
        if (!Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite)
            || b[0] >= b[2] || b[1] >= b[3]) bad();
    }
    if (request.bbox && request.bbox.some((n, i) => Math.abs(n - d.bbox[i]) > 0.01)) bad();
    let imageUrl = null;
    if (request.with_base64) {
        const images = (result.content || []).filter(p => p?.type === 'image_url');
        if (images.length !== 1) bad();
        imageUrl = images[0].image_url?.url;
        if (typeof imageUrl !== 'string' || imageUrl.length > 9 * 1024 * 1024
            || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(imageUrl)) bad();
        if (!Number.isInteger(d.image?.width) || !Number.isInteger(d.image?.height)
            || d.image.width <= 0 || d.image.height <= 0
            || d.image.width * d.image.height > 8000000) bad();
    }
    return { data: d, imageUrl };
}

module.exports = { makeRequest, validateResult };