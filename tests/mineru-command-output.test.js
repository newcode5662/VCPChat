'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const source = fs.readFileSync(path.join(__dirname, '../modules/services/minerU/minerUService.js'), 'utf8');
const start = source.indexOf('function runCommand(');
const end = source.indexOf('// 可替换的命令执行器', start);
assert.ok(start >= 0 && end > start);
function runner(chunks, code = 0) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    child.stdin = { end() {
        queueMicrotask(() => {
            for (const chunk of chunks) child.stdout.emit('data', chunk);
            child.emit('close', code);
        });
    } };
    return vm.runInNewContext(source.slice(start, end) + '\nrunCommand', {
        binaryPath: 'fixture', toolboxRoot: '.', COMMAND_TIMEOUT_MS: 1000,
        spawn: () => child, commandEnv: () => ({}),
        sanitizeError: e => String(e?.message || e),
        parseStdout: text => {
            for (const line of text.trim().split(/\r?\n/).reverse()) {
                try { return JSON.parse(line); } catch { /* Non-JSON log lines are allowed. */ }
            }
            return null;
        },
        Buffer, setTimeout, clearTimeout,
    });
}
const success = Buffer.from(JSON.stringify({ status: 'success', result: { data: { text: '核验🧪' }, content: [] } }));
test('UTF-8 split bytes survive without replacement characters', async () => {
    const chunks = Array.from(success, byte => Buffer.from([byte]));
    const result = await runner(chunks)({ command: 'library_view' });
    assert.equal(result.ok, true);
    assert.equal(result.data.text, '核验🧪');
});
test('ordinary output exactly at 8 MiB is accepted', async () => {
    const limit = 8 * 1024 * 1024;
    const result = await runner([Buffer.alloc(limit - success.length - 1, 32), Buffer.from('\n'), success])({ command: 'library_view' });
    assert.equal(result.ok, true);
});
test('ordinary output over 8 MiB rejects even with a valid success tail', async () => {
    const result = await runner([Buffer.alloc(8 * 1024 * 1024, 32), success])({ command: 'library_view' });
    assert.equal(result.ok, false);
    assert.match(result.error, /MINERU_OUTPUT_LIMIT/);
    assert.equal(result.data, undefined);
});
test('region output between 8 and 16 MiB is accepted', async () => {
    const result = await runner([Buffer.alloc(9 * 1024 * 1024, 32), Buffer.from('\n'), success])({ command: 'inspect_pdf_region' });
    assert.equal(result.ok, true);
});
test('region output over 16 MiB rejects without partial data', async () => {
    const result = await runner([Buffer.alloc(16 * 1024 * 1024, 32), success])({ command: 'inspect_pdf_region' });
    assert.equal(result.ok, false);
    assert.match(result.error, /MINERU_OUTPUT_LIMIT/);
    assert.equal(result.data, undefined);
});
test('success JSON cannot mask a nonzero exit', async () => {
    const result = await runner([success], 7)({ command: 'library_view' });
    assert.equal(result.ok, false);
    assert.match(result.error, /7/);
});