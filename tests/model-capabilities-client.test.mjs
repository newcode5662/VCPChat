import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapabilitiesClient } from '../modules/services/modelCapabilitiesClient.js';

function fixture(options = {}) {
    let time = 0;
    let settings = { vcpServerUrl: 'https://one.test', vcpApiKey: 'secret-one' };
    const calls = [];
    const get = createModelCapabilitiesClient({
        readSettings: async () => ({ ...settings }), now: () => time,
        fetchImpl: async (url, init) => {
            calls.push({ url, init });
            return { ok: true, json: async () => ({ version: 1, model: url.searchParams.get('model'), reasoning: {} }) };
        }, ...options
    });
    return { get, calls, advance: ms => { time += ms; }, settings: patch => { settings = { ...settings, ...patch }; } };
}

test('coalesces renderer requests, caches 60s from completion and isolates URL/key/model', async () => {
    const f = fixture();
    await Promise.all(Array.from({ length: 20 }, () => f.get('m')));
    assert.equal(f.calls.length, 1);
    f.advance(59999);
    await f.get('m');
    assert.equal(f.calls.length, 1);
    f.advance(1);
    await f.get('m');
    await f.get('other');
    f.settings({ vcpApiKey: 'secret-two' });
    await f.get('m');
    f.settings({ vcpServerUrl: 'https://two.test' });
    await f.get('m');
    assert.equal(f.calls.length, 5);
    f.settings({ vcpServerUrl: 'https://one.test', vcpApiKey: 'secret-one' });
    await f.get('m');
    assert.equal(f.calls.length, 5);
});

for (const [name, fetchImpl, expected] of [
    ['404', async () => ({ ok: false, status: 404 }), 'CAPABILITY_ENDPOINT_MISSING'],
    ['auth', async () => ({ ok: false, status: 401 }), 'CAPABILITY_AUTH_FAILED'],
    ['http', async () => ({ ok: false, status: 500 }), 'CAPABILITY_HTTP_ERROR'],
    ['network', async () => { throw new Error('secret-one'); }, 'CAPABILITY_NETWORK_ERROR'],
    ['invalid', async () => ({ ok: true, json: async () => ({ version: 1, model: 'wrong' }) }), 'CAPABILITY_INVALID_RESPONSE'],
    ['json', async () => ({ ok: true, json: async () => { throw new Error('secret-one'); } }), 'CAPABILITY_NETWORK_ERROR'],
    ['unavailable manual', async () => ({ ok: true, json: async () => ({ version: 1, model: 'm', reasoning: { manual: true, unavailable: true } }) }), undefined]
]) {
    test(`${name}: shares failures for 15s without exposing credentials`, async () => {
        let count = 0;
        const f = fixture({ fetchImpl: (...args) => { count++; return fetchImpl(...args); } });
        const results = await Promise.all([f.get('m'), f.get('m')]);
        assert.equal(results[0].error, expected);
        assert.ok(!JSON.stringify(results).includes('secret-one'));
        f.advance(14999);
        await f.get('m');
        assert.equal(count, 1);
        f.advance(1);
        await f.get('m');
        assert.equal(count, 2);
    });
}

test('bounded LRU eviction preserves recently used entries', async () => {
    const f = fixture({ maxEntries: 2 });
    await f.get('a'); await f.get('b'); await f.get('a'); await f.get('c'); await f.get('a');
    assert.equal(f.calls.length, 3);
    await f.get('b');
    assert.equal(f.calls.length, 4);
});

test('pending calls remain coalesced despite completed-cache eviction', async () => {
    let release;
    let count = 0;
    const f = fixture({ maxEntries: 1, fetchImpl: async url => {
        count++;
        const model = url.searchParams.get('model');
        if (model === 'slow') await new Promise(resolve => { release = resolve; });
        return { ok: true, json: async () => ({ version: 1, model }) };
    } });
    const first = f.get('slow');
    await f.get('fast');
    await f.get('other');
    const second = f.get('slow');
    release();
    await Promise.all([first, second]);
    assert.equal(count, 3);
});

test('timeout is sanitized and cached; invalid models never fetch', async () => {
    let count = 0;
    const f = fixture({ timeoutMs: 5, fetchImpl: (_url, { signal }) => {
        count++;
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('secret-one'))));
    } });
    for (const model of [null, '', 1, 'x'.repeat(513)]) assert.equal(await f.get(model), null);
    assert.deepEqual(await f.get('m'), { error: 'CAPABILITY_TIMEOUT' });
    assert.deepEqual(await f.get('m'), { error: 'CAPABILITY_TIMEOUT' });
    assert.equal(count, 1);
});
