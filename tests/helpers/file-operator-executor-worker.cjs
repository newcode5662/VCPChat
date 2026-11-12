'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createWriteExecutor } = require('../../VCPDistributedServer/Plugin/FileOperator/writeExecutor');
const [root, mode] = process.argv.slice(2);
const file = path.join(root, 'target.txt');
const input = { command: 'AppendFile', filePath: file, content: '-once', operationId: 'shared-id' };
function send(value) {
    if (process.send) process.send(value, () => process.disconnect());
}
try {
    const executor = createWriteExecutor({
        ledgerRoot: path.join(root, 'ledger'),
        authorize: target => path.dirname(target) === root,
        onPhase(phase) {
            if (phase !== 'prepared') return;
            if (mode === 'exit-prepared') process.exit(86);
            if (mode !== 'hold') return;
            process.send?.({ phase: 'prepared' });
            const deadline = Date.now() + 10000;
            const sleeper = new Int32Array(new SharedArrayBuffer(4));
            while (!fs.existsSync(path.join(root, 'release'))) {
                if (Date.now() > deadline) throw Error('worker barrier timeout');
                Atomics.wait(sleeper, 0, 0, 20);
            }
        },
    });
    send({ ok: true, result: executor.execute(input) });
} catch (error) {
    send({ ok: false, error: error.message, code: error.code });
}