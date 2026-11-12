import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = fs.readFileSync(new URL('../MinerUmodules/document-review.js', import.meta.url), 'utf8');
const { createDocumentReview } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function setup() {
    const nodes = new Map();
    function node(name) {
        if (!nodes.has(name)) nodes.set(name, {
            hidden: true, disabled: false, value: '', textContent: '', events: new Map(),
            children: [], append(...items) { this.children.push(...items); },
            addEventListener(k, fn) { this.events.set(k, fn); },
            removeEventListener(k) { this.events.delete(k); },
            setAttribute(k, v) { this[k] = v; },
            click() { this.events.get('click')?.(); },
        });
        return nodes.get(name);
    }
    let paperId = 'paper_a';
    let unsubscribed = false;
    let progress;
    let elementSeq = 0;
    const composed = [], exports = [];
    const exportReply = deferred();
    const start = deferred(), result = deferred(), cancelled = [];
    const job = { id: 'job1', paperId: 'paper_a', state: 'done', completedPages: 1, totalPages: 1 };
    const api = {
        mineruStartReview: () => start.promise,
        mineruReviewStatus: async () => ({ success: true, data: job }),
        mineruReviewResult: () => result.promise,
        mineruCancelReview: async id => { cancelled.push(id); return { success: true, data: { ...job, state: 'cancelled' } }; },
        mineruComposeReview: async (id, selected) => {
            composed.push({ id, selected });
            return { success: true, data: { paperId: 'paper_a',
                correctedMarkdown: '# selected', edits: [], acceptedProposalIndices: selected } };
        },
        mineruExportReview: (id, selected) => {
            exports.push({ id, selected });
            return exportReply.promise;
        },
        onMineruReviewProgress: fn => { progress = fn; return () => { unsubscribed = true; }; },
    };
    const controller = createDocumentReview({
        api, root: {
            querySelector: id => node(id.replace('#review-document-', '')),
            createElement: () => node(`element-${++elementSeq}`),
            createTextNode: value => ({ textContent: value }),
        },
        getPaperId: () => paperId,
    });
    return { node, controller, start, result, cancelled, job,
        composed, exports, exportReply, progress: () => progress(job),
        switchPaper() { paperId = 'paper_b'; controller.reset(); },
        unsubscribed: () => unsubscribed };
}
const draft = { paperId: 'paper_a', correctedMarkdown: '# draft',
    changes: [], unresolved: [], limitations: ['not semantic correction'] };
test('switching before start reply cancels orphaned task', async () => {
    const x = setup();
    x.node('start').click();
    x.switchPaper();
    x.start.resolve({ success: true, data: x.job });
    await tick();
    assert.deepEqual(x.cancelled, ['job1']);
    assert.equal(x.node('markdown').value, '');
    x.controller.destroy();
    assert.equal(x.unsubscribed(), true);
});
test('switching during result retrieval drops stale draft', async () => {
    const x = setup();
    x.node('start').click();
    x.start.resolve({ success: true, data: x.job });
    await tick();
    x.switchPaper();
    x.result.resolve({ success: true, data: draft });
    await tick();
    assert.equal(x.node('markdown').value, '');
    x.controller.destroy();
});
test('completed draft displays limitations rather than claiming correctness', async () => {
    const x = setup();
    x.node('start').click();
    x.start.resolve({ success: true, data: x.job });
    x.result.resolve({ success: true, data: draft });
    await tick();
    assert.equal(x.node('markdown').value, '# draft');
    assert.match(x.node('status').textContent, /待复核/);
    assert.match(x.node('diff').textContent, /not semantic correction/);
    x.controller.destroy();
});

test('checkbox selection survives repeated done; export is single-flight and cancellation is explicit', async () => {
    const x = setup();
    x.node('start').click();
    x.start.resolve({ success: true, data: x.job });
    x.result.resolve({ success: true, data: { ...draft, reviewProposals: [{
        before: 'original', proposed: 'candidate', similarity: 0.9,
        evidence: { page: 1 },
    }] } });
    await tick();
    const item = x.node('proposals').children[0];
    assert.ok(item, 'candidate must be rendered');
    const checkbox = item.children[1].children[0];
    assert.ok(!checkbox.checked, 'candidate starts unselected');
    checkbox.checked = true;
    checkbox.events.get('change')();
    x.progress();
    await tick();
    assert.equal(x.node('proposals').children.length, 1, 'done must not duplicate candidates');
    x.node('compose').click();
    await tick();
    assert.deepEqual(x.composed, [{ id: 'job1', selected: [0] }]);
    assert.equal(x.node('markdown').value, '# selected');
    x.node('export').click();
    x.node('export').click();
    assert.equal(x.exports.length, 1);
    assert.deepEqual(x.exports[0].selected, [0]);
    assert.equal(x.node('export').disabled, true);
    x.exportReply.resolve({ success: true, data: { cancelled: true } });
    await tick();
    assert.match(x.node('status').textContent, /取消导出/);
    assert.equal(x.node('export').disabled, false);
    x.controller.destroy();
});