'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function exportReviewBundle(parent, selection) {
    if (typeof parent !== 'string' || !path.isAbsolute(parent)
        || !fs.statSync(parent).isDirectory()) throw new Error('PDF_REVIEW_EXPORT_DIRECTORY_INVALID');
    if (selection?.schema !== 'mineru.review-selection' || selection.sourceModified !== false
        || typeof selection.correctedMarkdown !== 'string'
        || !/^paper_[a-f0-9]{16}$/.test(selection.paperId)) {
        throw new Error('PDF_REVIEW_EXPORT_INVALID');
    }
    const markdown = Buffer.from(selection.correctedMarkdown, 'utf8');
    if (markdown.length > 24 * 1024 * 1024
        || crypto.createHash('sha256').update(markdown).digest('hex') !== selection.correctedSha256) {
        throw new Error('PDF_REVIEW_EXPORT_HASH_MISMATCH');
    }
    const audit = { ...selection };
    delete audit.correctedMarkdown;
    const report = Buffer.from(JSON.stringify({
        ...audit, exportSchema: 'mineru.review-export', exportSchemaVersion: 1,
        exportedAt: new Date().toISOString(),
        markdownFile: 'corrected.md',
        assetPolicy: 'Images are not copied; original relative image links require the original assets.',
        complete: true,
    }, null, 2) + '\n', 'utf8');
    if (report.length > 24 * 1024 * 1024) throw new Error('PDF_REVIEW_EXPORT_REPORT_LIMIT');
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(parent), `${selection.paperId}-review-`));
    function write(name, bytes) {
        const fd = fs.openSync(path.join(dir, name), 'wx');
        try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
    }
    try {
        write('corrected.md', markdown);
        // The report is the completion marker; a killed process may leave an
        // incomplete directory, but it never overwrites the original assets.
        write('review.json.pending', report);
        fs.renameSync(path.join(dir, 'review.json.pending'), path.join(dir, 'review.json'));
        return { directory: dir, markdownFile: path.join(dir, 'corrected.md'),
            reportFile: path.join(dir, 'review.json'), correctedSha256: selection.correctedSha256,
            sourceModified: false, imagesCopied: false };
    } catch (error) {
        try { fs.rmSync(dir, { recursive: true, force: true }); }
        catch { error.message += `; incomplete export may remain: ${dir}`; }
        throw error;
    }
}
module.exports = { exportReviewBundle };