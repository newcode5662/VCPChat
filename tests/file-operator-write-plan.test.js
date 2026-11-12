const test = require('node:test');
const assert = require('node:assert/strict');
const { identifyWrite, planWrite, classifyOperation } = require('../VCPDistributedServer/Plugin/FileOperator/writePlan');
const request = (command = 'WriteFile', patch = {}) => ({
    command, filePath: 'authorized-normalized-path.txt', content: '泉🦀\n', ...patch,
});

test('missing and empty revisions differ; explicit conflict policy preserves rename default', () => {
    const created = planWrite(request(), null);
    const empty = planWrite(request(), Buffer.alloc(0));
    assert.equal(created.beforeRevision, 'missing');
    assert.equal(created.disposition, 'replace');
    assert.equal(empty.disposition, 'rename_required');
    assert.notEqual(created.beforeRevision, empty.beforeRevision);
    assert.throws(() => planWrite(request('WriteFile', { conflictPolicy: 'error' }), Buffer.from('old')), /EXISTS/);
    assert.equal(planWrite(request('WriteFile', { conflictPolicy: 'overwrite' }), Buffer.from('old')).bytes.toString(), '泉🦀\n');
    assert.throws(() => planWrite(request('EditFile'), null), /EXISTING/);
});
test('normal repeated appends are preserved, never tail-deduplicated', () => {
    const input = request('AppendFile', { content: 'same\n' });
    const first = planWrite(input, Buffer.from('same\n'));
    assert.equal(first.bytes.toString(), 'same\nsame\n');
    const second = planWrite(input, first.bytes);
    assert.equal(second.bytes.toString(), 'same\nsame\nsame\n');
    assert.equal(first.requestFingerprint, second.requestFingerprint);
});
test('expected revision is over original bytes and guards missing/create semantics', () => {
    const old = Buffer.from('old\r\n');
    const revision = planWrite(request(), old).beforeRevision;
    assert.throws(() => planWrite(request('EditFile', { expectedRevision: 'missing' }), old), /REVISION_CONFLICT/);
    assert.doesNotThrow(() => planWrite(request('EditFile', { expectedRevision: revision }), old));
    assert.doesNotThrow(() => planWrite(request('WriteFile', { expectedRevision: 'missing' }), null));
});
test('operation identity is explicit and prepared operations require reconciliation, not blind append', () => {
    const plan = planWrite(request('AppendFile', { operationId: 'task-1' }), Buffer.from('old'));
    assert.equal(classifyOperation(null, plan), 'new');
    assert.equal(classifyOperation({ state: 'committed', requestFingerprint: plan.requestFingerprint }, plan), 'replay');
    assert.equal(classifyOperation({ state: 'prepared', requestFingerprint: plan.requestFingerprint }, plan), 'reconcile_required');
    const changed = planWrite(request('AppendFile', { operationId: 'task-1', content: 'different' }), Buffer.from('old'));
    assert.throws(() => classifyOperation({ state: 'committed', requestFingerprint: plan.requestFingerprint }, changed), /PAYLOAD_CONFLICT/);
});
test('line ending compatibility is explicit, original buffers unchanged', () => {
    const old = Buffer.from('a\r\nb\r\n');
    const before = Buffer.from(old);
    const edit = planWrite(request('EditFile', { content: 'new\nline\n' }), old);
    assert.equal(edit.bytes.toString(), 'new\r\nline\r\n');
    const frontend = planWrite(request('AppendFile', { content: 'new\n' }), old);
    const backend = planWrite(request('AppendFile', { content: 'new\n' }), old, { preserveAppendEol: true });
    assert.equal(frontend.bytes.toString(), 'a\r\nb\r\nnew\n');
    assert.equal(backend.bytes.toString(), 'a\r\nb\r\nnew\r\n');
    assert.notEqual(frontend.requestFingerprint, backend.requestFingerprint);
    assert.deepEqual(old, before);
});
test('bounds and invalid contracts fail before any write', () => {
    assert.throws(() => planWrite(request(), null, { maxBytes: 1 }), /SIZE_LIMIT/);
    for (const patch of [{ operationId: '../bad' }, { expectedRevision: 'bad' },
        { encoding: 'invalid' }, { content: undefined }, { conflictPolicy: 'guess' }]) {
        assert.throws(() => planWrite(request('WriteFile', patch), null));
    }
    assert.throws(() => planWrite(request('AppendFile', { conflictPolicy: 'overwrite' }), null), /NOT_APPLICABLE/);
    assert.equal(planWrite(request('WriteFile', { content: '中文', encoding: 'utf16le' }), null).size, 4);
});

test('committed retry is identified before stale expected revision or target read', () => {
    const original = Buffer.from('old');
    const expectedRevision = planWrite(request(), original).beforeRevision;
    const input = request('AppendFile', { operationId: 'retry-1', expectedRevision });
    const first = planWrite(input, original);
    const identity = identifyWrite(input);
    assert.equal(identity.requestFingerprint, first.requestFingerprint);
    const stored = { state: 'committed', requestFingerprint: first.requestFingerprint,
        receipt: { path: 'historical-output.txt', revision: first.afterRevision } };
    assert.equal(classifyOperation(stored, identity), 'replay');
    assert.throws(() => planWrite(input, first.bytes), /REVISION_CONFLICT/,
        'planning again would be incorrect for a committed replay');
    assert.equal(stored.receipt.path, 'historical-output.txt');
    const changed = identifyWrite({ ...input, expectedRevision: 'missing' });
    assert.throws(() => classifyOperation(stored, changed), /PAYLOAD_CONFLICT/);
});
test('identity is snapshot independent but binds command, path, bytes and transformation policy', () => {
    const input = request('AppendFile', { operationId: 'identity-1' });
    const fingerprint = identifyWrite(input).requestFingerprint;
    assert.equal(fingerprint, identifyWrite({ ...input, operationId: 'identity-2' }).requestFingerprint);
    for (const patch of [
        { content: 'other' }, { command: 'EditFile' }, { filePath: 'another.txt' },
        { encoding: 'utf16le' },
    ]) {
        assert.notEqual(identifyWrite({ ...input, ...patch }).requestFingerprint, fingerprint);
    }
    assert.notEqual(identifyWrite(input, { preserveAppendEol: true }).requestFingerprint, fingerprint);
    assert.throws(() => identifyWrite(input, { preserveAppendEol: 'false' }), /POLICY_INVALID/);
    assert.equal(classifyOperation({ state: 'prepared', requestFingerprint: fingerprint },
        identifyWrite(input)), 'reconcile_required',
    'a prepared record is never proof that an append should be repeated');
});