const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const plugin = path.resolve(__dirname, '../../VCPToolBox/Plugin/FileOperator/FileOperator.js');

// Real backend module and its stdin/stdout handler run in a child process.
// Isolate config.env and document-parser startup; no network/parser behavior
// or real CodeValidator behavior is claimed by these dispatch baseline tests.
const bootstrap = `
const Module = require('node:module');
const original = Module._load;
Module._load = function(id, parent, isMain) {
    if (id === 'dotenv') return { config() {} };
    if (id === './writeExecutor' && parent?.filename === process.argv[1]) {
        const { createWriteExecutor } = original.call(this, id, parent, false);
        return { createWriteExecutor: options => createWriteExecutor({
            ...options, ledgerRoot: require('node:path').join(process.cwd(), 'operation-ledger'),
        }) };
    }
    if (id === './CodeValidator.js') return { validateCode: async () => [] };
    if (id === 'pdf-parse') return { PDFParse: class {} };
    if (id === 'mammoth') return {};
    if (id === 'exceljs') return {};
    return original.call(this, id, parent, isMain);
};
require(process.argv[1]);
`;

function sandbox(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-op-server-stdio-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}
function request(root, input) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', bootstrap, plugin], {
            cwd: root, windowsHide: true,
            env: { ...process.env, ALLOWED_DIRECTORIES: root, DEBUG_MODE: 'false',
                MAX_FILE_SIZE: '20971520', CANVAS_DIRECTORY: path.join(root, 'canvas') },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '', stderr = '', response = null, failure = null;
        const stop = error => {
            failure ||= error;
            child.kill();
        };
        const timer = setTimeout(() => stop(new Error('server stdio timeout')), 15000);
        const force = setTimeout(() => {
            child.kill('SIGKILL');
            reject(failure || new Error('server did not exit'));
        }, 18000);
        child.stdout.on('data', chunk => {
            stdout += chunk.toString('utf8');
            if (stdout.length > 1024 * 1024) return stop(new Error('stdout exceeded test budget'));
            const lineEnd = stdout.indexOf('\n');
            if (lineEnd < 0 || response || failure) return;
            try {
                response = JSON.parse(stdout.slice(0, lineEnd));
                child.kill('SIGTERM');
            } catch (error) { stop(error); }
        });
        child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-16000); });
        child.on('error', error => {
            clearTimeout(timer); clearTimeout(force); reject(error);
        });
        child.stdin.on('error', error => stop(error));
        child.on('close', () => {
            clearTimeout(timer); clearTimeout(force);
            if (failure) reject(failure);
            else if (!response) reject(new Error(`No VCP response: ${stderr}`));
            else resolve(response);
        });
        // One complete JSON line: baseline does not claim fragmented-frame safety.
        child.stdin.end(`${JSON.stringify(input)}\n`);
    });
}

test('backend stdio single calls retain rename, append EOL and error envelope', async t => {
    const root = sandbox(t), file = path.join(root, 'same.txt');
    const first = await request(root, { command: 'WriteFile', filePath: file, content: 'base\r\n' });
    assert.equal(first.status, 'success');
    assert.equal(first.result.details.path, file);
    const second = await request(root, { command: 'WriteFile', filePath: file, content: 'other\n' });
    assert.equal(second.status, 'success');
    assert.equal(second.result.details.renamed, true);
    assert.notEqual(second.result.details.path, file);
    assert.equal(fs.readFileSync(file, 'utf8'), 'base\r\n');
    assert.equal(fs.readFileSync(second.result.details.path, 'utf8'), 'other\n');
    for (let n = 0; n < 2; n++) {
        const appended = await request(root, { command: 'AppendFile', filePath: file, content: 'same\n' });
        assert.equal(appended.status, 'success');
        assert(Array.isArray(appended.result.content));
    }
    assert.equal(fs.readFileSync(file, 'utf8'), 'base\r\nsame\r\nsame\r\n');
    const edited = await request(root, { command: 'EditFile', filePath: file, content: 'edited\nline\n' });
    assert.equal(edited.status, 'success');
    assert.equal(fs.readFileSync(file, 'utf8'), 'edited\r\nline\r\n');
    const missing = await request(root, {
        command: 'EditFile', filePath: path.join(root, 'missing.txt'), content: 'no',
    });
    assert.equal(missing.status, 'error');
    assert.match(missing.error, /not found/i);
    assert(!fs.existsSync(path.join(root, 'missing.txt')));
});
test('backend stdio batch remains serial and retains partial failure summary', async t => {
    const root = sandbox(t), file = path.join(root, 'batch.txt');
    const response = await request(root, {
        command1: 'WriteFile', filePath1: file, content1: 'A\r\n',
        command2: 'AppendFile', filePath2: file, content2: 'B\n',
        command3: 'AppendFile', filePath3: file, content3: 'B\n',
        command4: 'EditFile', filePath4: path.join(root, 'missing.txt'), content4: 'no',
    });
    assert.equal(response.status, 'success', 'legacy aggregate remains successful with item errors');
    assert.match(response.result.details.message, /Succeeded: 3, Failed: 1/);
    assert(response.result.content.some(part => /Error executing EditFile/.test(part.text || '')));
    assert.equal(fs.readFileSync(file, 'utf8'), 'A\r\nB\r\nB\r\n');
});

test('backend opt-in survives process restart and mixed batches preserve untracked append semantics', async t => {
    const root = sandbox(t), file = path.join(root, 'tracked.txt');
    fs.writeFileSync(file, 'base\r\n');
    const input = { command: 'AppendFile', filePath: file, content: 'once\n', operationId: 'server-append' };
    const first = await request(root, input);
    assert.equal(first.status, 'success');
    assert.equal(first.result.details.operation.state, 'committed');
    const replay = await request(root, input);
    assert.equal(replay.result.details.operation.replayed, true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'base\r\nonce\r\n');
    const conflict = await request(root, { ...input, content: 'different' });
    assert.equal(conflict.status, 'error');
    assert.match(conflict.error, /PAYLOAD_CONFLICT/);
    const batch = {
        command1: 'WriteFile', filePath1: file, content1: 'new', operationId1: 'server-rename',
        command2: 'AppendFile', filePath2: file, content2: 'tracked\n', operationId2: 'server-batch',
        command3: 'AppendFile', filePath3: file, content3: 'legacy\n',
    };
    const firstBatch = await request(root, batch);
    assert.equal(firstBatch.status, 'success');
    assert.match(firstBatch.result.details.message, /Succeeded: 3, Failed: 0/);
    assert.equal(firstBatch.result.details.operationResults.length, 2);
    const secondBatch = await request(root, batch);
    assert(secondBatch.result.details.operationResults.every(item => item.operation.replayed));
    assert.equal(fs.readFileSync(file, 'utf8'), 'base\r\nonce\r\ntracked\r\nlegacy\r\nlegacy\r\n');
    assert.equal(fs.readFileSync(path.join(root, 'tracked(1).txt'), 'utf8'), 'new');
    assert(!fs.existsSync(path.join(root, 'tracked(2).txt')));
    const queried = await request(root, { command: 'QueryOperation', operationId: input.operationId });
    const expectedFingerprint = queried.result.details.operation.record.requestFingerprint;
    const noConfirm = await request(root, {
        command: 'CleanupOperation', operationId: input.operationId, expectedFingerprint,
    });
    assert.equal(noConfirm.status, 'error');
    const cleaned = await request(root, {
        command: 'CleanupOperation', operationId: input.operationId, expectedFingerprint, confirm: 'true',
    });
    assert.equal(cleaned.result.details.operation.record.state, 'retired');
    const retired = await request(root, input);
    assert.equal(retired.status, 'error');
    assert.match(retired.error, /OPERATION_RETIRED/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'base\r\nonce\r\ntracked\r\nlegacy\r\nlegacy\r\n');
});