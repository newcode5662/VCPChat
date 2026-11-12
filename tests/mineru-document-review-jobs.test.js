'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDocumentReviewJobs } = require('../modules/services/minerU/documentReviewJobs');
const sha = '0123456789abcdef' + '0'.repeat(48);
const id = `paper_${sha.slice(0, 16)}`;
const tick = () => new Promise(resolve => setImmediate(resolve));
function page() {
    return { data: {
        schema: 'mineru.pdf-region', schema_version: 1, paper_id: id,
        sha256: sha, page: 1, total_pages: 1, complete: true, truncated: false,
        read_only: true, text: 'efficient', spans: [], page_bounds: [0, 0, 100, 100],
    } };
}
function setup() {
    let source = { scope: 'root-a', pdfPath: '/fixture.pdf', markdown: 'e\uFB03cient' };
    let finish;
    const updates = [];
    const jobs = createDocumentReviewJobs({
        readSource: () => ({ ...source }),
        inspect: () => new Promise(resolve => { finish = resolve; }),
        notify: (owner, state) => updates.push({ owner, ...state }),
    });
    return { jobs, updates, finish: () => finish(page()), change: patch => Object.assign(source, patch) };
}
test('complete draft remains isolated to initiating window', async () => {
    const x = setup();
    const job = x.jobs.start(1, id);
    assert.throws(() => x.jobs.get(2, job.id), /NOT_FOUND/);
    assert.throws(() => x.jobs.cancel(2, job.id), /NOT_FOUND/);
    x.finish(); await tick();
    assert.equal(x.jobs.get(1, job.id).state, 'done');
    assert.equal(x.jobs.result(1, job.id).correctedMarkdown, 'efficient');
    assert.equal(x.jobs.result(1, job.id).sourceModified, false);
    assert.equal(x.jobs.isActive(), false);
});
test('cancel waits for in-flight request before freeing slot', async () => {
    const x = setup();
    const job = x.jobs.start(1, id);
    assert.equal(x.jobs.cancel(1, job.id).state, 'stopping');
    assert.throws(() => x.jobs.start(1, id), /BUSY/);
    x.finish(); await tick();
    assert.equal(x.jobs.get(1, job.id).state, 'cancelled');
    assert.throws(() => x.jobs.result(1, job.id), /NOT_COMPLETE/);
    assert.equal(x.jobs.isActive(), false);
});
test('source changes during collection reject stale draft', async () => {
    const x = setup();
    const job = x.jobs.start(1, id);
    x.change({ markdown: 'different source' });
    x.finish(); await tick();
    assert.equal(x.jobs.get(1, job.id).state, 'failed');
    assert.match(x.jobs.get(1, job.id).error, /SOURCE_CHANGED/);
});
test('closing owner requests cancellation without exposing results', async () => {
    const x = setup();
    const job = x.jobs.start(1, id);
    x.jobs.cancelOwner(1);
    x.finish(); await tick();
    assert.equal(x.jobs.get(1, job.id).state, 'cancelled');
});