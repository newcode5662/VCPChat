const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { createLedger } = require('../VCPDistributedServer/Plugin/FileOperator/operationLedger');
const worker = path.join(__dirname, 'helpers/file-operator-executor-worker.cjs');

function sandbox(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-op-process-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'target.txt'), 'base');
    return root;
}
function launch(t, root, mode = 'normal') {
    const child = fork(worker, [root, mode], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    let stderr = '', packet = null;
    child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-8000); });
    let readyResolve;
    const ready = new Promise(resolve => { readyResolve = resolve; });
    child.on('message', message => {
        if (message.phase === 'prepared') readyResolve();
        else packet = message;
    });
    const completion = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(Error(`worker timeout: ${stderr}`));
        }, 15000);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, packet, stderr }); });
    });
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await completion.catch(() => {});
    });
    return { ready, completion };
}
test('two real processes share executor gate; successful retry replays without a second append', { timeout: 25000 }, async t => {
    const root = sandbox(t);
    const first = launch(t, root, 'hold');
    await Promise.race([first.ready, first.completion.then(result => {
        throw Error(`first exited before barrier: ${JSON.stringify(result)}`);
    })]);
    const second = await launch(t, root).completion;
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.packet.ok, false);
    assert.equal(second.packet.code, 'EEXIST');
    assert.equal(fs.readFileSync(path.join(root, 'target.txt'), 'utf8'), 'base');
    fs.writeFileSync(path.join(root, 'release'), '');
    const committed = await first.completion;
    assert.equal(committed.packet.ok, true);
    assert.equal(committed.packet.result.state, 'committed');
    const retry = await launch(t, root).completion;
    assert.equal(retry.packet.result.replayed, true);
    assert.deepEqual(retry.packet.result.receipt, committed.packet.result.receipt);
    assert.equal(fs.readFileSync(path.join(root, 'target.txt'), 'utf8'), 'base-once');
    assert(!fs.existsSync(path.join(root, 'ledger/executor.lock')));
});
test('process exit after preparation leaves evidence and gate, never automatically reclaims or writes', { timeout: 25000 }, async t => {
    const root = sandbox(t);
    const exited = await launch(t, root, 'exit-prepared').completion;
    assert.equal(exited.code, 86);
    assert.equal(fs.readFileSync(path.join(root, 'target.txt'), 'utf8'), 'base');
    const ledgerRoot = path.join(root, 'ledger');
    assert.equal(createLedger(ledgerRoot).query('shared-id').state, 'prepared');
    const lock = path.join(ledgerRoot, 'executor.lock');
    assert(fs.existsSync(lock));
    const before = fs.readFileSync(lock);
    const retry = await launch(t, root).completion;
    assert.equal(retry.packet.ok, false);
    assert.equal(retry.packet.code, 'EEXIST');
    assert.deepEqual(fs.readFileSync(lock), before);
    assert.equal(createLedger(ledgerRoot).query('shared-id').state, 'prepared');
    assert.equal(fs.readFileSync(path.join(root, 'target.txt'), 'utf8'), 'base');
});