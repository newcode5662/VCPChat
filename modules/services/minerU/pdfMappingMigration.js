'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 1024 * 1024;
const MAX_ITEMS = 500;
const revisionOf = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function readSnapshot(file) {
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) {
        throw new Error('LEGACY_MAPPING_INVALID: 旧映射须为1MB以内普通文件。');
    }
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let used = 0;
    try {
        while (used < buffer.length) {
            const n = fs.readSync(fd, buffer, used, buffer.length - used, null);
            if (!n) break;
            used += n;
        }
    } finally { fs.closeSync(fd); }
    if (used > MAX_BYTES) throw new Error('LEGACY_MAPPING_TOO_LARGE');
    const bytes = buffer.subarray(0, used);
    // Reject invalid UTF-8 rather than replacement-decoding a path.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value = JSON.parse(text);
    if (!value || Array.isArray(value) || typeof value !== 'object') {
        throw new Error('LEGACY_MAPPING_INVALID: 旧映射必须是对象。');
    }
    if (Object.keys(value).length > MAX_ITEMS) throw new Error('LEGACY_MAPPING_TOO_MANY: 最多500项。');
    return { value, bytes, revision: revisionOf(bytes) };
}

async function previewLegacyMappings(file, command) {
    const snapshot = readSnapshot(file);
    if (!snapshot) return { dryRun: true, applied: false, mappingRevision: 'missing', items: [], partial: false };
    const items = [];
    const invoke = async request => {
        const data = await command(request);
        if (!data || data.paper_id !== request.paper_id) throw new Error('PDF_BINDING_RECEIPT_INVALID');
        return data;
    };
    for (const [paperId, pdfPath] of Object.entries(snapshot.value)) {
        try {
            if (!/^paper_[A-Za-z0-9_-]+$/.test(paperId)
                || typeof pdfPath !== 'string' || !path.isAbsolute(pdfPath)
                || path.extname(pdfPath).toLowerCase() !== '.pdf') {
                throw new Error('INVALID_LEGACY_ENTRY');
            }
            const current = await invoke({ command: 'get_pdf_binding', paper_id: paperId });
            if (typeof current.binding_revision !== 'string') throw new Error('MISSING_BINDING_REVISION');
            if (current.binding_revision !== 'missing') {
                items.push({ paperId, status: 'skipped_existing_binding' });
                continue;
            }
            const candidate = await invoke({ command: 'link_pdf', paper_id: paperId, file_path: pdfPath });
            if (candidate.binding_revision !== 'missing') {
                items.push({ paperId, status: 'skipped_concurrent_binding' });
                continue;
            }
            if (candidate.can_apply !== true || candidate.id_prefix_matches !== true
                || !/^[a-f0-9]{64}$/.test(candidate.sha256 || '')) {
                items.push({ paperId, status: 'identity_unverified' });
                continue;
            }
            items.push({ paperId, pdfPath, status: 'eligible',
                pdfSha256: candidate.sha256, bindingRevision: 'missing' });
        } catch (error) {
            items.push({ paperId, status: 'failed', error: String(error.message || error) });
        }
    }
    const after = readSnapshot(file);
    if (!after || after.revision !== snapshot.revision) {
        throw new Error('LEGACY_MAPPING_CHANGED: 预演期间旧映射变化，请重新预演。');
    }
    return { dryRun: true, applied: false, mappingRevision: snapshot.revision,
        items, partial: items.some(item => item.status === 'failed'),
        counts: items.reduce((counts, item) => {
            counts[item.status] = (counts[item.status] || 0) + 1;
            return counts;
        }, {}) };
}

async function applyLegacyMappings(file, command, { expectedRevision, expectedPdfHashes } = {}) {
    if (!/^[a-f0-9]{64}$/.test(expectedRevision || '')
        || !expectedPdfHashes || Array.isArray(expectedPdfHashes)
        || typeof expectedPdfHashes !== 'object'
        || Object.keys(expectedPdfHashes).length > MAX_ITEMS) {
        throw new Error('MIGRATION_PRECONDITION_REQUIRED: 需预演映射修订及逐项PDF完整哈希。');
    }
    for (const [id, hash] of Object.entries(expectedPdfHashes)) {
        if (!/^paper_[A-Za-z0-9_-]+$/.test(id) || !/^[a-f0-9]{64}$/.test(hash)) {
            throw new Error('MIGRATION_PRECONDITION_INVALID');
        }
    }
    const lockPath = `${file}.migration.lock`;
    // Never unlink a lock we did not create; no stale-lock takeover.
    const lock = fs.openSync(lockPath, 'wx');
    let backup = null;
    let report = null;
    try {
        const snapshot = readSnapshot(file);
        if (!snapshot || snapshot.revision !== expectedRevision) {
            throw new Error('LEGACY_MAPPING_CHANGED: 执行前映射修订不一致。');
        }
        const plan = await previewLegacyMappings(file, command);
        if (plan.mappingRevision !== expectedRevision) throw new Error('LEGACY_MAPPING_CHANGED');
        const eligible = plan.items.filter(item => item.status === 'eligible'
            && Object.hasOwn(expectedPdfHashes, item.paperId));
        // Exclusive backup of exact source bytes, verified before any binding write.
        if (eligible.length) {
            backup = `${file}.backup.${expectedRevision}.${crypto.randomUUID()}`;
            const fd = fs.openSync(backup, 'wx');
            try {
                fs.writeFileSync(fd, snapshot.bytes);
                fs.fsyncSync(fd);
            } finally { fs.closeSync(fd); }
            if (!fs.readFileSync(backup).equals(snapshot.bytes)) {
                throw new Error('MIGRATION_BACKUP_INVALID: 尚未提交任何绑定。');
            }
        }
        const items = [];
        let sourceChanged = false;
        for (const item of plan.items) {
            if (item.status !== 'eligible') { items.push(item); continue; }
            if (!Object.hasOwn(expectedPdfHashes, item.paperId)) {
                items.push({ paperId: item.paperId, status: 'not_selected' });
                continue;
            }
            if (item.pdfSha256 !== expectedPdfHashes[item.paperId]) {
                items.push({ paperId: item.paperId, status: 'failed', error: 'PDF_CHANGED_SINCE_PREVIEW' });
                continue;
            }
            try {
                const current = readSnapshot(file);
                if (sourceChanged || !current || current.revision !== expectedRevision) {
                    sourceChanged = true;
                    items.push({ paperId: item.paperId, status: 'not_attempted', error: 'LEGACY_MAPPING_CHANGED' });
                    continue;
                }
                const receipt = await command({
                    command: 'link_pdf', paper_id: item.paperId, file_path: item.pdfPath,
                    apply: true, expected_revision: 'missing',
                    expected_pdf_sha256: item.pdfSha256,
                });
                if (!receipt || receipt.paper_id !== item.paperId || receipt.applied !== true
                    || receipt.binding?.paper_id !== item.paperId
                    || receipt.binding?.sha256 !== item.pdfSha256 || receipt.binding?.disabled === true
                    || typeof receipt.revision !== 'string') {
                    throw new Error('MIGRATION_RECEIPT_UNCERTAIN: 请查询绑定现状，不要盲重试。');
                }
                items.push({ paperId: item.paperId, status: 'migrated', revision: receipt.revision });
            } catch (error) {
                // A lost receipt may follow a successful native commit. Report it,
                // keep backup, and let rerun skip any now-existing binding.
                items.push({ paperId: item.paperId, status: 'failed',
                    error: String(error.message || error), requiresReconciliation: true });
            }
        }
        try {
            const after = readSnapshot(file);
            sourceChanged ||= !after || after.revision !== expectedRevision;
        } catch { sourceChanged = true; }
        report = {
            dryRun: false,
            applied: items.some(item => item.status === 'migrated'),
            outcomeUncertain: items.some(item => item.requiresReconciliation),
            mappingRevision: expectedRevision, backup, sourceChanged,
            partial: sourceChanged || items.some(item => ['failed', 'not_attempted'].includes(item.status)),
            items, counts: items.reduce((counts, item) => {
                counts[item.status] = (counts[item.status] || 0) + 1;
                return counts;
            }, {}),
            note: '旧映射保留；逐项提交非跨文件事务。失败/回执不明需查询现状，重跑会跳过已有绑定。',
        };
        return report;
    } finally {
        // Cleanup errors must not turn known partial commits into an opaque
        // rejection. Leave an explicit gate for a human to reconcile.
        let cleanupError = null;
        try { fs.closeSync(lock); } catch (error) { cleanupError = error; }
        try { fs.unlinkSync(lockPath); } catch (error) { cleanupError ||= error; }
        if (cleanupError && report) {
            report.partial = true;
            report.cleanupWarning = `迁移锁清理失败，请核查：${cleanupError.message}`;
        }
    }
}

module.exports = { previewLegacyMappings, applyLegacyMappings };