const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { resolveOperationScope } = require('../VCPDistributedServer/Plugin/FileOperator/operationScope');

test('scope is stable per trusted user and endpoint, never uses target directory', () => {
    const dataRoot = path.resolve('dedicated-host-data');
    const a = resolveOperationScope({ dataRoot, endpoint: 'client', principalId: 'user-a' });
    const same = resolveOperationScope({ dataRoot, endpoint: 'client', principalId: 'user-a' });
    const otherUser = resolveOperationScope({ dataRoot, endpoint: 'client', principalId: 'user-b' });
    const otherEnd = resolveOperationScope({ dataRoot, endpoint: 'server', principalId: 'user-a' });
    assert.deepEqual(a, same);
    assert.notEqual(a.scopeId, otherUser.scopeId);
    assert.notEqual(a.scopeId, otherEnd.scopeId);
    assert.equal(a.expiryPolicy, 'explicit_cleanup_only');
    assert.equal(a.ledgerRoot, path.join(dataRoot, 'FileOperatorOperations', 'v1', 'client', a.scopeId));
    assert(!a.ledgerRoot.includes('user-a'));
    assert.equal(a.scopeId.length, 64);
});
test('missing trusted identity fails even when request-like identity fields exist', () => {
    const base = { dataRoot: path.resolve('data'), endpoint: 'client' };
    for (const principalId of [undefined, null, '', ' ', ' user', 'user ', 123,
        'bad\nid', 'x'.repeat(1025)]) {
        assert.throws(() => resolveOperationScope({ ...base, principalId }), /TRUSTED_PRINCIPAL/);
    }
    assert.throws(() => resolveOperationScope({ ...base,
        toolArgs: { userId: 'claimed' }, userId: 'claimed', maid: 'Kerr', requestIp: '127.0.0.1',
    }), /TRUSTED_PRINCIPAL/);
    assert.throws(() => resolveOperationScope({ ...base, dataRoot: 'relative', principalId: 'user' }), /DATA_ROOT/);
    assert.throws(() => resolveOperationScope({ ...base, endpoint: 'guessed', principalId: 'user' }), /ENDPOINT/);
});
test('unusual valid principal remains opaque and cannot escape dedicated root', () => {
    const dataRoot = path.resolve('host-data');
    const result = resolveOperationScope({ dataRoot, endpoint: 'server', principalId: '../../泉/user:1' });
    const relative = path.relative(dataRoot, result.ledgerRoot);
    assert(!relative.startsWith('..'));
    assert(!path.isAbsolute(relative));
    assert(!result.ledgerRoot.includes('泉'));
    assert(!result.ledgerRoot.includes('user:1'));
});