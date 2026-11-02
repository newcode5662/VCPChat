import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import recovery from '../modules/services/minerU/jobRecovery.js';

const job = state => ({ id: `job-${state}`, type: 'parse', paperId: 'paper_a',
    path: '/source.pdf', state, createdAt: 1, pid: 1234,
    child: { kill: true }, token: 'secret', options: { MINERU_TOKEN: 'secret' } });
test('restored in-flight jobs are parked, never runnable, and runtime handles are stripped', () => {
    const root = path.resolve('toolbox');
    const states = ['queued','starting','running','polling','done','timeout','failed','cancelled'];
    const saved = recovery.snapshot(root, states.map(job));
    assert(!JSON.stringify(saved).includes('secret'));
    assert(!JSON.stringify(saved).includes('"pid"'));
    const restored = recovery.restore(saved, root);
    for (const item of restored.slice(0, 4)) {
        assert.equal(item.state, 'interrupted');
        assert.equal(item.recoveryAction, 'query');
        assert.equal(item.recovered, true);
    }
    assert.equal(restored[4].state, 'done');
    const unidentified = recovery.restore(recovery.snapshot(root, [{ ...job('queued'), paperId: '' }]), root);
    assert.equal(unidentified[0].recoveryAction, 'review_import');
    assert.throws(() => recovery.restore(saved, path.resolve('other')), /SCOPE/);
    assert.throws(() => recovery.snapshot(root, [job('done'), job('done')]), /DUPLICATE/);
});
test('durable snapshot roundtrip rejects malformed files and preserves another writer lock', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineru-recovery-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'jobs.json');
    assert.deepEqual(recovery.read(file, dir), []);
    recovery.write(file, dir, [job('running')]);
    assert.equal(recovery.read(file, dir)[0].state, 'interrupted');
    const old = fs.readFileSync(file);
    fs.writeFileSync(`${file}.lock`, 'other', { flag: 'wx' });
    assert.throws(() => recovery.write(file, dir, []), /EEXIST/);
    assert.deepEqual(fs.readFileSync(file), old);
    assert.equal(fs.readFileSync(`${file}.lock`, 'utf8'), 'other');
    fs.unlinkSync(`${file}.lock`);
    fs.writeFileSync(file, '{broken');
    assert.throws(() => recovery.read(file, dir), SyntaxError);
    assert.throws(() => recovery.restore({ schema: 'wrong' }, dir), /VERSION/);
    assert.deepEqual(fs.readdirSync(dir), ['jobs.json']);
});