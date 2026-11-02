const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLedger } = require('../VCPDistributedServer/Plugin/FileOperator/operationLedger');
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-op-ledger-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}
test('prepared survives restart; committed replays exact historical receipt without target access', t => {
    const root = fixture(t);
    const id = 'append-1', fingerprint = 'a'.repeat(64);
    const first = createLedger(root);
    assert.equal(first.query(id).state, 'missing');
    first.prepare(id, fingerprint, { beforeRevision: 'missing', afterRevision: 'b'.repeat(64) });
    const restarted = createLedger(root);
    assert.equal(restarted.query(id).state, 'prepared');
    assert.equal(restarted.prepare(id, fingerprint, { differentIntent: true }).record.state, 'prepared');
    const receipt = { path: 'historical-output.txt', revision: 'b'.repeat(64), size: 10 };
    restarted.commit(id, fingerprint, receipt);
    assert.deepEqual(createLedger(root).query(id).receipt, receipt);
    assert.deepEqual(restarted.commit(id, fingerprint, { notTheOriginal: true }).record.receipt, receipt);
    assert.throws(() => restarted.prepare(id, 'c'.repeat(64), {}), /PAYLOAD_CONFLICT/);
    assert.throws(() => restarted.commit(id, 'c'.repeat(64), {}), /PAYLOAD_CONFLICT/);
    assert.equal(fs.readdirSync(root).length, 2);
});
test('ledger rejects unprepared commit, invalid IDs and corrupt records without erasing evidence', t => {
    const root = fixture(t), ledger = createLedger(root);
    assert.throws(() => ledger.commit('new', 'a'.repeat(64), {}), /NOT_PREPARED/);
    assert.throws(() => ledger.query('../escape'), /ID_INVALID/);
    ledger.prepare('test', 'a'.repeat(64), {});
    const file = path.join(root, fs.readdirSync(root).find(name => name.endsWith('.prepared.json')));
    fs.writeFileSync(file, '{corrupt');
    assert.throws(() => ledger.query('test'), SyntaxError);
    assert.throws(() => ledger.prepare('test', 'a'.repeat(64), {}), SyntaxError);
    assert.equal(fs.readFileSync(file, 'utf8'), '{corrupt');
});
test('existing lock is never reclaimed and record bounds fail before publish', t => {
    const root = fixture(t), ledger = createLedger(root);
    ledger.prepare('locked', 'a'.repeat(64), {});
    const prepared = fs.readdirSync(root).find(name => name.endsWith('.prepared.json'));
    const lock = path.join(root, prepared.replace('.prepared.json', '.lock'));
    fs.writeFileSync(lock, 'other writer', { flag: 'wx' });
    assert.throws(() => ledger.commit('locked', 'a'.repeat(64), {}), /EEXIST/);
    assert.equal(fs.readFileSync(lock, 'utf8'), 'other writer');
    assert.equal(ledger.query('locked').state, 'prepared');
    assert.throws(() => ledger.prepare('large', 'a'.repeat(64), { content: 'x'.repeat(300000) }), /TOO_LARGE/);
    assert.equal(ledger.query('large').state, 'missing');
});

test('write, sync and publication failures clean owned temporaries and release operation lock', t => {
    for (const method of ['writeFileSync', 'fsyncSync', 'linkSync']) {
        const root = fixture(t);
        let injected = false;
        const io = new Proxy(fs, {
            get(target, key) {
                if (key === method) return (...args) => {
                    if (!injected) {
                        injected = true;
                        throw new Error(`injected-${method}`);
                    }
                    return target[key](...args);
                };
                return target[key];
            },
        });
        const ledger = createLedger(root, { fileSystem: io });
        assert.throws(() => ledger.prepare('fault', 'a'.repeat(64), {}), new RegExp(`injected-${method}`));
        assert.equal(injected, true);
        assert.equal(createLedger(root).query('fault').state, 'missing');
        assert.deepEqual(fs.readdirSync(root), [], 'no owned tmp or lock left after pre-publication failure');
    }
});
test('post-publication temporary cleanup failure returns confirmed record with warning', t => {
    const root = fixture(t);
    const io = new Proxy(fs, {
        get(target, key) {
            if (key === 'unlinkSync') return file => {
                if (file.includes('.tmp.')) throw new Error('injected-temp-cleanup');
                return target.unlinkSync(file);
            };
            return target[key];
        },
    });
    const ledger = createLedger(root, { fileSystem: io });
    const prepared = ledger.prepare('cleanup', 'a'.repeat(64), {});
    assert.equal(prepared.record.state, 'prepared');
    assert(prepared.cleanupWarnings.some(w => w.includes('injected-temp-cleanup')));
    const committed = ledger.commit('cleanup', 'a'.repeat(64), { path: 'historical.txt' });
    assert.equal(committed.record.state, 'committed');
    assert(committed.cleanupWarnings.some(w => w.includes('injected-temp-cleanup')));
    assert.equal(createLedger(root).query('cleanup').receipt.path, 'historical.txt');
    assert(!fs.readdirSync(root).some(name => name.endsWith('.lock')));
    assert.equal(fs.readdirSync(root).filter(name => name.includes('.tmp.')).length, 2,
        'reported orphan temporaries remain for explicit cleanup, not a false failed commit');
});
test('failed commit publication leaves prepared state and can be inspected without replaying target write', t => {
    const root = fixture(t);
    createLedger(root).prepare('commit-fault', 'a'.repeat(64), { path: 'authorized-target' });
    const io = new Proxy(fs, {
        get(target, key) {
            if (key === 'linkSync') return () => { throw new Error('commit-publication-failed'); };
            return target[key];
        },
    });
    assert.throws(() => createLedger(root, { fileSystem: io })
        .commit('commit-fault', 'a'.repeat(64), { revision: 'b'.repeat(64) }), /publication-failed/);
    assert.equal(createLedger(root).query('commit-fault').state, 'prepared');
    assert.equal(fs.readdirSync(root).length, 1);
});

test('explicit cleanup keeps an irreversible tombstone and never makes old operation new', t => {
    const root = fixture(t), ledger = createLedger(root), fingerprint = 'd'.repeat(64);
    ledger.prepare('retire', fingerprint, { path: path.join(root, 'target') });
    ledger.commit('retire', fingerprint, { path: path.join(root, 'target'), privateDetail: 'removed-detail' });
    const result = ledger.retire('retire', fingerprint);
    assert.equal(result.record.state, 'retired');
    assert.deepEqual(result.cleanupWarnings, []);
    assert.equal(fs.readdirSync(root).length, 1);
    assert(fs.readdirSync(root)[0].endsWith('.retired.json'));
    const restarted = createLedger(root);
    assert.equal(restarted.query('retire').state, 'retired');
    assert.equal(restarted.query('retire').receipt, undefined);
    assert(!JSON.stringify(restarted.query('retire')).includes('removed-detail'));
    assert.throws(() => restarted.prepare('retire', fingerprint, {}), /OPERATION_RETIRED/);
    assert.throws(() => restarted.commit('retire', fingerprint, {}), /OPERATION_RETIRED/);
    assert.equal(restarted.retire('retire', fingerprint).record.state, 'retired');
});
test('cleanup refuses prepared, missing or fingerprint mismatch without deleting records', t => {
    const root = fixture(t), ledger = createLedger(root), fingerprint = 'e'.repeat(64);
    ledger.prepare('pending', fingerprint, {});
    const before = fs.readdirSync(root);
    assert.throws(() => ledger.retire('pending', fingerprint), /RECONCILIATION_REQUIRED/);
    assert.throws(() => ledger.retire('pending', 'f'.repeat(64)), /PAYLOAD_CONFLICT/);
    assert.throws(() => ledger.retire('missing', fingerprint), /NOT_FOUND/);
    assert.deepEqual(fs.readdirSync(root), before);
    assert.equal(ledger.query('pending').state, 'prepared');
});
test('cleanup publishes tombstone before deletion; failures remain inspectable and explicitly retryable', t => {
    const root = fixture(t), fingerprint = 'f'.repeat(64);
    const ledger = createLedger(root);
    ledger.prepare('cleanup-fault', fingerprint, {});
    ledger.commit('cleanup-fault', fingerprint, { path: path.join(root, 'target') });
    const noPublish = new Proxy(fs, {
        get(target, key) {
            if (key === 'linkSync') return () => { throw Error('retire-publication-failed'); };
            return target[key];
        },
    });
    assert.throws(() => createLedger(root, { fileSystem: noPublish })
        .retire('cleanup-fault', fingerprint), /publication-failed/);
    assert.equal(ledger.query('cleanup-fault').state, 'committed');
    assert.equal(fs.readdirSync(root).length, 2);
    const noDelete = new Proxy(fs, {
        get(target, key) {
            if (key === 'unlinkSync') return file => {
                if (file.endsWith('.committed.json') || file.endsWith('.prepared.json')) {
                    throw Error('detail-delete-failed');
                }
                return target.unlinkSync(file);
            };
            return target[key];
        },
    });
    const result = createLedger(root, { fileSystem: noDelete }).retire('cleanup-fault', fingerprint);
    assert.equal(result.record.state, 'retired');
    assert.equal(result.cleanupWarnings.length, 2);
    assert.equal(ledger.query('cleanup-fault').state, 'retired');
    assert.equal(fs.readdirSync(root).length, 3);
    assert.throws(() => ledger.prepare('cleanup-fault', fingerprint, {}), /RETIRED/);
    ledger.retire('cleanup-fault', fingerprint);
    assert.equal(fs.readdirSync(root).length, 1);
});