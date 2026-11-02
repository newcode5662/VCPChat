'use strict';
const LOCAL_PENDING = new Set(['queued', 'starting', 'running', 'polling', 'interrupted', 'timeout']);

function observeJobs(papers, localJobs) {
    const covered = new Set(localJobs.filter(job => LOCAL_PENDING.has(job.state))
        .map(job => job.paperId).filter(Boolean));
    return papers.filter(paper => ['running', 'timeout'].includes(paper.status)
        && !covered.has(paper.paper_id)).map(paper => ({
        id: `mineru-observed-${paper.paper_id}`,
        type: 'external',
        source: 'library_state',
        paperId: paper.paper_id,
        path: '',
        title: paper.title || paper.paper_id,
        state: 'observed',
        observedState: paper.state || paper.status,
        canContinue: typeof paper.batch_id === 'string' && Boolean(paper.batch_id.trim()),
        message: '检测到磁盘中的未完成任务记录；未确认进程仍存活，不会自动接管或重新上传。',
        error: paper.error || null,
        batchId: paper.batch_id || null,
        progress: paper.progress ? {
            extracted: paper.progress.extracted_pages, total: paper.progress.total_pages,
        } : null,
        chunks: paper.chunks || null,
        createdAt: Number.isFinite(Date.parse(paper.updated_at)) ? Date.parse(paper.updated_at) : 0,
        startedAt: null,
        finishedAt: null,
        recovered: false,
        recoveryAction: 'query',
    }));
}
module.exports = { observeJobs };