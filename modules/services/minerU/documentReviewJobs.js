'use strict';
const crypto = require('crypto');
const { collectDocumentEvidence } = require('./documentEvidence');
const { buildCorrectionDraft } = require('./documentCorrection');
const { composeSelection } = require('./reviewSelection');
const hash = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

function createDocumentReviewJobs({ readSource, inspect, notify = () => {} }) {
    const jobs = new Map();
    let active = null;
    const summary = job => ({
        id: job.id, paperId: job.paperId, state: job.state,
        completedPages: job.completedPages, totalPages: job.totalPages,
        error: job.error, changeCount: job.result?.changes.length ?? null,
        unresolvedCount: job.result?.unresolved.length ?? null,
    });
    function publish(job) {
        try { notify(job.owner, summary(job)); } catch { /* destroyed receiver */ }
    }
    function owned(owner, id) {
        const job = jobs.get(id);
        if (!job || job.owner !== owner) throw new Error('PDF_REVIEW_NOT_FOUND');
        return job;
    }
    async function execute(job, initial) {
        try {
            const evidence = await collectDocumentEvidence({
                inspect: options => inspect(job.paperId, options),
                isCancelled: () => job.cancelled,
                onProgress: progress => { Object.assign(job, progress); publish(job); },
            });
            if (job.cancelled) throw new Error('PDF_REVIEW_CANCELLED');
            const current = readSource(job.paperId);
            if (current.scope !== initial.scope || current.pdfPath !== initial.pdfPath
                || hash(current.markdown) !== job.originalSha256) {
                throw new Error('PDF_REVIEW_SOURCE_CHANGED：原文或库环境已改变，请重试。');
            }
            job.result = buildCorrectionDraft(initial.markdown, evidence);
            job.state = 'done';
        } catch (error) {
            job.state = job.cancelled ? 'cancelled' : 'failed';
            job.error = job.cancelled ? '' : String(error?.message || error);
            job.result = null;
        } finally {
            if (active === job.id) active = null;
            publish(job);
        }
    }
    return {
        start(owner, paperId) {
            if (active) throw new Error('PDF_REVIEW_BUSY：上次任务尚未退出。');
            const initial = readSource(paperId);
            if (typeof initial.markdown !== 'string' || !initial.markdown.trim()) {
                throw new Error('PDF_REVIEW_MARKDOWN_REQUIRED');
            }
            if (!initial.pdfPath) throw new Error('PDF_REVIEW_PDF_REQUIRED');
            // Retain only one completed draft, avoiding unbounded Markdown copies.
            jobs.clear();
            const job = {
                id: crypto.randomUUID(), owner, paperId,
                state: 'running', cancelled: false, completedPages: 0, totalPages: null,
                originalSha256: hash(initial.markdown), error: '', result: null,
                sourceScope: initial.scope, sourcePdfPath: initial.pdfPath,
            };
            jobs.set(job.id, job);
            active = job.id;
            publish(job);
            void execute(job, initial);
            return summary(job);
        },
        get(owner, id) { return summary(owned(owner, id)); },
        result(owner, id) {
            const job = owned(owner, id);
            if (job.state !== 'done') throw new Error('PDF_REVIEW_NOT_COMPLETE');
            return job.result;
        },
        compose(owner, id, selected) {
            const job = owned(owner, id);
            if (job.state !== 'done') throw new Error('PDF_REVIEW_NOT_COMPLETE');
            const source = readSource(job.paperId);
            if (source.scope !== job.sourceScope || source.pdfPath !== job.sourcePdfPath) {
                throw new Error('PDF_REVIEW_SOURCE_CHANGED');
            }
            return composeSelection(source.markdown, job.result, selected);
        },
        cancel(owner, id) {
            const job = owned(owner, id);
            if (job.state === 'running' || job.state === 'stopping') {
                job.cancelled = true;
                job.state = 'stopping';
                publish(job);
            }
            return summary(job);
        },
        cancelOwner(owner) {
            for (const job of jobs.values()) {
                if (job.owner === owner && ['running', 'stopping'].includes(job.state)) {
                    job.cancelled = true;
                    job.state = 'stopping';
                }
            }
        },
        isActive() { return active !== null; },
    };
}
module.exports = { createDocumentReviewJobs };