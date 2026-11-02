const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createWriteExecutor } = require('../VCPDistributedServer/Plugin/FileOperator/writeExecutor');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t, options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-op-executor-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const targets = path.join(root, 'files');
    fs.mkdirSync(targets);
    const ledgerRoot = path.join(root, 'ledger');
    const authorize = file => path.dirname(file) === targets;
    const config = { ledgerRoot, authorize, ...options };
    return { root, targets, config, executor: createWriteExecutor(config), file: path.join(targets, 'file.txt') };
}
test('append commits once; replay ignores changed target revision and preserves historical receipt', t => {
    const { file, executor, config } = fixture(t);
    fs.writeFileSync(file, 'old\n');
    const input = { command: 'AppendFile', filePath: file, content: 'same\n',
        operationId: 'append-1', expectedRevision: digest(Buffer.from('old\n')) };
    const first = executor.execute(input);
    assert.equal(first.state, 'committed');
    assert.equal(fs.readFileSync(file, 'utf8'), 'old\nsame\n');
    fs.writeFileSync(file, 'external change');
    const restarted = createWriteExecutor(config);
    const replay = restarted.execute(input);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.receipt, first.receipt);
    assert.equal(fs.readFileSync(file, 'utf8'), 'external change');
    assert.throws(() => restarted.execute({ ...input, content: 'changed' }), /PAYLOAD_CONFLICT/);
    assert.equal(restarted.query('append-1').record.state, 'committed');
});
test('distinct operation IDs retain legitimate repeated append and EOL policy', t => {
    const { file, executor } = fixture(t);
    fs.writeFileSync(file, 'same\n');
    for (const operationId of ['one', 'two']) {
        assert.equal(executor.execute({ command: 'AppendFile', filePath: file,
            content: 'same\n', operationId }).state, 'committed');
    }
    assert.equal(fs.readFileSync(file, 'utf8'), 'same\nsame\nsame\n');
    const result = executor.execute({ command: 'EditFile', filePath: file,
        content: 'edited\n', operationId: 'edit' });
    assert.equal(result.state, 'committed');
});
test('fault after preparation does not write target or retry it on restart', t => {
    const { file, executor, config } = fixture(t, {
        onPhase(phase) { if (phase === 'prepared') throw Error('injected-prepared'); },
    });
    fs.writeFileSync(file, 'original');
    const input = { command: 'AppendFile', filePath: file, content: '-append', operationId: 'fault' };
    const failed = executor.execute(input);
    assert.equal(failed.requiresReconciliation, true);
    assert.equal(failed.targetPublicationConfirmed, false);
    const retry = createWriteExecutor({ ...config, onPhase: undefined }).execute(input);
    assert.equal(retry.state, 'prepared');
    assert.equal(fs.readFileSync(file, 'utf8'), 'original');
});
test('fault after target publication exposes uncertainty and never appends a second time', t => {
    const { file, executor, config } = fixture(t, {
        onPhase(phase) { if (phase === 'target_published') throw Error('receipt interrupted'); },
    });
    fs.writeFileSync(file, 'base');
    const input = { command: 'AppendFile', filePath: file, content: '-once', operationId: 'lost' };
    const result = executor.execute(input);
    assert.equal(result.outcomeUncertain, true);
    assert.equal(result.targetPublicationConfirmed, true);
    assert.equal(executor.query('lost').record.state, 'prepared');
    const retry = createWriteExecutor({ ...config, onPhase: undefined }).execute(input);
    assert.equal(retry.requiresReconciliation, true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'base-once');
    assert(!fs.readdirSync(path.dirname(file)).some(name => name.includes('.tmp')));
});
test('staged revision race preserves external update and leaves operation prepared', t => {
    let target;
    const { file, executor } = fixture(t, {
        onPhase(phase) { if (phase === 'staged') fs.writeFileSync(target, 'external'); },
    });
    target = file;
    fs.writeFileSync(file, 'original');
    const result = executor.execute({ command: 'EditFile', filePath: file, content: 'replacement', operationId: 'race' });
    assert.match(result.error, /REVISION_CONFLICT/);
    assert.equal(result.targetPublicationConfirmed, false);
    assert.equal(fs.readFileSync(file, 'utf8'), 'external');
    assert.equal(executor.query('race').record.state, 'prepared');
});
test('explicit create policy, authorization, lock and query disclosure boundaries', t => {
    const { root, file, executor, config } = fixture(t);
    const input = { command: 'WriteFile', filePath: file, content: 'created',
        operationId: 'create', conflictPolicy: 'error', expectedRevision: 'missing' };
    assert.equal(executor.execute(input).state, 'committed');
    assert.throws(() => executor.execute({ ...input, operationId: 'other', expectedRevision: undefined }), /EXISTS/);
    const renamed = executor.execute({ ...input, operationId: 'default-rename',
        conflictPolicy: undefined, expectedRevision: undefined });
    assert.equal(renamed.receipt.renamed, true);
    assert.equal(renamed.receipt.path, path.join(path.dirname(file), 'file(1).txt'));
    assert.equal(fs.readFileSync(file, 'utf8'), 'created');
    assert.equal(executor.execute({ ...input, operationId: 'default-rename',
        conflictPolicy: undefined, expectedRevision: undefined }).replayed, true);
    assert(!fs.existsSync(path.join(path.dirname(file), 'file(2).txt')));
    assert.throws(() => executor.execute({ ...input, filePath: path.join(root, 'outside.txt') }), /ACCESS_DENIED/);
    const denied = createWriteExecutor({ ...config, authorize: () => false });
    assert.throws(() => denied.query('create'), /ACCESS_DENIED/);
    assert.throws(() => denied.execute(input), /ACCESS_DENIED/, 'replay still requires authorization');
    const lock = path.join(config.ledgerRoot, 'executor.lock');
    fs.writeFileSync(lock, 'other', { flag: 'wx' });
    assert.throws(() => executor.execute(input), /EEXIST/);
    assert.equal(fs.readFileSync(lock, 'utf8'), 'other');
});

test('executor cleanup is authorized, leaves target intact and prevents post-cleanup replay', t => {
    const { file, executor, config } = fixture(t);
    const input = { command: 'WriteFile', filePath: file, content: 'keep target',
        operationId: 'retire-target', conflictPolicy: 'error' };
    executor.execute(input);
    const record = executor.query(input.operationId).record;
    const denyCleanup = createWriteExecutor({
        ...config, authorize: (_file, command) => command !== 'CleanupOperation',
    });
    assert.throws(() => denyCleanup.retire(input.operationId, record.requestFingerprint), /ACCESS_DENIED/);
    assert.equal(executor.query(input.operationId).record.state, 'committed');
    const retired = executor.retire(input.operationId, record.requestFingerprint);
    assert.equal(retired.record.state, 'retired');
    assert.equal(fs.readFileSync(file, 'utf8'), 'keep target');
    const restarted = createWriteExecutor(config);
    assert.equal(restarted.query(input.operationId).record.state, 'retired');
    assert.throws(() => restarted.execute(input), /OPERATION_RETIRED/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'keep target');
});