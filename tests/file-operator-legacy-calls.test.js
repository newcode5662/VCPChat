const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const pluginPath = path.resolve(__dirname, '../VCPDistributedServer/Plugin/FileOperator/FileOperator.js');
const pluginRequire = createRequire(pluginPath);
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-op-legacy-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const context = {
        module: { exports: {} }, __dirname: path.dirname(pluginPath),
        process: { env: { ALLOWED_DIRECTORIES: root }, platform: process.platform,
            cwd: () => root },
        Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval,
        require(id) {
            if (id === 'dotenv') return { config() {} };
            if (id === './writeExecutor') {
                const { createWriteExecutor } = pluginRequire(id);
                return { createWriteExecutor: options => createWriteExecutor({
                    ...options, ledgerRoot: path.join(root, 'operation-ledger'),
                }) };
            }
            // This suite checks dispatch/write behavior, not lint engine rules.
            if (id === './CodeValidator') return { validateCode: async () => [] };
            return pluginRequire(id);
        },
    };
    vm.runInNewContext(fs.readFileSync(pluginPath, 'utf8'), context, { filename: pluginPath });
    return { root, plugin: context.module.exports };
}
test('legacy single request preserves rename default and repeated append, direct result shape stays unchanged', async t => {
    const { root, plugin } = fixture(t);
    const file = path.join(root, 'same.txt');
    const first = await plugin.processRequest({ command: 'WriteFile', filePath: file, content: 'base\n' });
    assert.equal(first.success, true);
    assert.equal(first.data.path, file);
    const second = await plugin.processRequest({ command: 'WriteFile', filePath: file, content: 'other\n' });
    assert.equal(second.success, true);
    assert.equal(second.data.renamed, true);
    assert.notEqual(second.data.path, file);
    assert.equal(fs.readFileSync(file, 'utf8'), 'base\n');
    assert.equal(fs.readFileSync(second.data.path, 'utf8'), 'other\n');
    for (let n = 0; n < 2; n++) {
        const result = await plugin.processToolCall({ command: 'AppendFile', filePath: file, content: 'same\n' });
        assert(Array.isArray(result.content));
        assert(result.details);
        assert.equal(result.status, undefined, 'direct returns result, not stdout envelope');
    }
    assert.equal(fs.readFileSync(file, 'utf8'), 'base\nsame\nsame\n');
    const formatted = plugin.convertToVCPFormat(first);
    assert.equal(formatted.status, 'success');
    assert.equal(formatted.result.details.path, file);
});
test('legacy batch remains serial, keeps summary contract and exposes partial failure in summary', async t => {
    const { root, plugin } = fixture(t);
    const file = path.join(root, 'batch.txt');
    const result = await plugin.processRequest({
        command1: 'WriteFile', filePath1: file, content1: 'A',
        command2: 'AppendFile', filePath2: file, content2: 'B',
        command3: 'AppendFile', filePath3: file, content3: 'B',
        command4: 'EditFile', filePath4: path.join(root, 'missing.txt'), content4: 'never',
    });
    assert.equal(fs.readFileSync(file, 'utf8'), 'ABB');
    assert.equal(result.success, true, 'existing batch aggregate status is preserved');
    assert.match(result.data.message, /Succeeded: 3, Failed: 1/);
    assert(result.data.content.some(part => /Error executing EditFile/.test(part.text || '')));
    const direct = await plugin.processToolCall(JSON.stringify({
        command1: 'AppendFile', filePath1: file, content1: 'C',
    }));
    assert.match(direct.details.message, /Succeeded: 1, Failed: 0/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'ABBC');
});
test('legacy edit keeps CRLF while frontend append remains literal, missing edit throws only in direct wrapper', async t => {
    const { root, plugin } = fixture(t);
    const file = path.join(root, 'eol.txt');
    fs.writeFileSync(file, 'old\r\nline\r\n');
    const edited = await plugin.editFile(file, 'new\nline\n');
    assert.equal(edited.success, true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'new\r\nline\r\n');
    await plugin.appendFile(file, 'literal\n');
    assert.equal(fs.readFileSync(file, 'utf8'), 'new\r\nline\r\nliteral\n');
    const request = { command: 'EditFile', filePath: path.join(root, 'absent.txt'), content: 'x' };
    const internal = await plugin.processRequest(request);
    assert.equal(internal.success, false);
    assert.equal(plugin.convertToVCPFormat(internal).status, 'error');
    await assert.rejects(plugin.processToolCall(request), /not found/i);
});

test('opt-in operations traverse original single/direct/batch dispatch without duplicate writes', async t => {
    const { root, plugin } = fixture(t);
    const file = path.join(root, 'tracked.txt');
    fs.writeFileSync(file, 'base\n');
    const input = { command: 'AppendFile', filePath: file, content: 'once\n', operationId: 'dispatch-append' };
    const first = await plugin.processToolCall(input);
    assert.equal(first.details.operation.state, 'committed');
    const replay = await plugin.processToolCall(JSON.stringify(input));
    assert.equal(replay.details.operation.replayed, true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'base\nonce\n');
    const batch = {
        command1: 'WriteFile', filePath1: file, content1: 'renamed', operationId1: 'dispatch-create',
        command2: 'AppendFile', filePath2: file, content2: 'batch\n', operationId2: 'dispatch-batch',
        command3: 'AppendFile', filePath3: file, content3: 'legacy\n',
    };
    const result = await plugin.processToolCall(batch);
    assert.match(result.details.message, /Succeeded: 3, Failed: 0/);
    assert.equal(result.details.operationResults.length, 2);
    assert.equal(result.details.operationResults[0].renamed, true);
    assert.equal(fs.readFileSync(path.join(root, 'tracked(1).txt'), 'utf8'), 'renamed');
    const retry = await plugin.processToolCall(batch);
    assert(retry.details.operationResults.every(item => item.operation.replayed));
    assert(!fs.existsSync(path.join(root, 'tracked(2).txt')));
    assert.equal(fs.readFileSync(file, 'utf8'), 'base\nonce\nbatch\nlegacy\nlegacy\n',
        'untracked batch item must still append normally on each call');
    const queried = await plugin.processToolCall({ command: 'QueryOperation', operationId: input.operationId });
    const fingerprint = queried.details.operation.record.requestFingerprint;
    await assert.rejects(plugin.processToolCall({ command: 'CleanupOperation',
        operationId: input.operationId, expectedFingerprint: fingerprint }), /CONFIRM_REQUIRED/);
    const cleaned = await plugin.processToolCall({ command: 'CleanupOperation', operationId: input.operationId,
        expectedFingerprint: fingerprint, confirm: true });
    assert.equal(cleaned.details.operation.record.state, 'retired');
    await assert.rejects(plugin.processToolCall(input), /OPERATION_RETIRED/);
    await assert.rejects(plugin.processToolCall({ ...input, operationId: '' }), /ID_INVALID|ID_REQUIRED/);
});