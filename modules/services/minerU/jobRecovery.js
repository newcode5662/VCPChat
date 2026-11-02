'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const STATES = new Set(['queued','starting','running','polling','done','timeout','failed','cancelled','interrupted']);
const ACTIVE = new Set(['queued','starting','running','polling']);
const ID = /^paper_[A-Za-z0-9_-]+$/;
const MAX_BYTES = 4 * 1024 * 1024;
const str = (value, max = 4096) => typeof value === 'string' ? value.slice(0, max) : '';
const timestamp = value => Number.isFinite(value) && value >= 0 ? value : null;

function cleanJob(raw) {
    if (!raw || typeof raw !== 'object' || !['parse','query'].includes(raw.type)
        || !STATES.has(raw.state) || typeof raw.id !== 'string' || !raw.id || raw.id.length > 256) {
        throw new Error('JOB_RECOVERY_INVALID_RECORD');
    }
    if (raw.paperId && !ID.test(raw.paperId)) throw new Error('JOB_RECOVERY_INVALID_PAPER');
    return {
        id: raw.id, type: raw.type, paperId: raw.paperId || '',
        path: str(raw.path), title: str(raw.title, 1024), state: raw.state,
        message: str(raw.message), error: raw.error ? str(raw.error) : null,
        batchId: raw.batchId ? str(raw.batchId, 256) : null,
        createdAt: timestamp(raw.createdAt), startedAt: timestamp(raw.startedAt),
        finishedAt: timestamp(raw.finishedAt),
        recovered: raw.recovered === true,
        recoveryAction: ['query','review_import',null].includes(raw.recoveryAction) ? raw.recoveryAction : null,
    };
}
function snapshot(root, jobs) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('JOB_RECOVERY_ROOT_REQUIRED');
    if (!Array.isArray(jobs) || jobs.length > 500) throw new Error('JOB_RECOVERY_LIMIT');
    const ids = new Set();
    const records = jobs.map(job => {
        const record = cleanJob(job);
        if (ids.has(record.id)) throw new Error('JOB_RECOVERY_DUPLICATE');
        ids.add(record.id); return record;
    });
    return { schema: 'mineru.job-recovery', schemaVersion: 1, toolboxRoot: path.resolve(root), jobs: records };
}
function restore(value, root) {
    if (!value || value.schema !== 'mineru.job-recovery' || value.schemaVersion !== 1
        || value.toolboxRoot !== path.resolve(root)) throw new Error('JOB_RECOVERY_SCOPE_OR_VERSION');
    return snapshot(root, value.jobs).jobs.map(job => {
        if (!ACTIVE.has(job.state)) return job;
        return { ...job, state: 'interrupted', recovered: true, finishedAt: null,
            recoveryAction: job.paperId ? 'query' : 'review_import',
            message: job.paperId
                ? '上次本地执行已中断；请先续查云端状态，不会自动重新上传。'
                : '上次导入未完成；请重新预检确认，不会自动重新上传。' };
    });
}
function read(file, root) {
    let meta;
    try { meta = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (!meta.isFile() || meta.isSymbolicLink() || meta.size > MAX_BYTES) throw new Error('JOB_RECOVERY_INVALID_FILE');
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let used = 0;
    try {
        while (used < buffer.length) {
            const n = fs.readSync(fd, buffer, used, buffer.length - used, null);
            if (!n) break; used += n;
        }
    } finally { fs.closeSync(fd); }
    if (used > MAX_BYTES) throw new Error('JOB_RECOVERY_LIMIT');
    return restore(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, used))), root);
}
function write(file, root, jobs) {
    const bytes = Buffer.from(JSON.stringify(snapshot(root, jobs)));
    if (bytes.length > MAX_BYTES) throw new Error('JOB_RECOVERY_LIMIT');
    const lockPath = `${file}.lock`;
    const lock = fs.openSync(lockPath, 'wx');
    let temp = null;
    let failure = null;
    const cleanupWarnings = [];
    try {
        try {
            const meta = fs.lstatSync(file);
            if (!meta.isFile() || meta.isSymbolicLink()) throw new Error('JOB_RECOVERY_INVALID_FILE');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const name = `${file}.tmp.${crypto.randomUUID()}`;
        const fd = fs.openSync(name, 'wx');
        temp = name;
        try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(temp, file);
    } catch (error) {
        failure = error;
    } finally {
        if (temp) {
            try { fs.unlinkSync(temp); }
            catch (error) { if (error.code !== 'ENOENT') cleanupWarnings.push(error.message); }
        }
        try { fs.closeSync(lock); } catch (error) { cleanupWarnings.push(error.message); }
        try { fs.unlinkSync(lockPath); } catch (error) { cleanupWarnings.push(error.message); }
    }
    if (failure) {
        failure.cleanupWarnings = cleanupWarnings;
        throw failure;
    }
    return { written: true, cleanupWarnings };
}
module.exports = { snapshot, restore, read, write };