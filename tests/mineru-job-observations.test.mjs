import test from 'node:test';
import assert from 'node:assert/strict';
import { observeJobs } from '../modules/services/minerU/jobObservations.js';

const paper = (id, status = 'running') => ({
    paper_id: id, title: id, status, state: 'running', batch_id: 'batch',
    updated_at: '2026-11-02T00:00:00Z',
});
test('external tasks are observations only, never runnable local process records', () => {
    const records = observeJobs([paper('paper_a'), paper('paper_b', 'timeout'),
        paper('paper_c', 'indexed'), paper('paper_d', 'failed')], []);
    assert.equal(records.length, 2);
    for (const record of records) {
        assert.equal(record.state, 'observed');
        assert.equal(record.type, 'external');
        assert.equal(record.source, 'library_state');
        assert.equal(record.canContinue, true);
        assert.equal(record.pid, undefined);
        assert.equal(record.path, '');
        assert.match(record.message, /未确认进程/);
    }
    const noBatch = observeJobs([{ ...paper('paper_a'), batch_id: null }], [])[0];
    assert.equal(noBatch.canContinue, false);
});
test('local unfinished records cover observations but done history cannot hide newer cloud state', () => {
    const locals = [
        { paperId: 'paper_a', state: 'running' },
        { paperId: 'paper_b', state: 'interrupted' },
        { paperId: 'paper_c', state: 'timeout' },
        { paperId: 'paper_d', state: 'done' },
    ];
    const result = observeJobs(['a', 'b', 'c', 'd'].map(id => paper(`paper_${id}`)), locals);
    assert.deepEqual(result.map(job => job.paperId), ['paper_d']);
    assert.equal(observeJobs([], locals).length, 0);
});