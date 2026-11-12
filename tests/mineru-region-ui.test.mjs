import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = fs.readFileSync(new URL('../MinerUmodules/region-inspector.js', import.meta.url), 'utf8');
const { createRegionInspector } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function setup() {
    const nodes = new Map();
    function node(id) {
        if (!nodes.has(id)) nodes.set(id, {
            hidden: true, disabled: false, value: '', textContent: '',
            events: new Map(),
            addEventListener(k, fn) { this.events.set(k, fn); },
            removeEventListener(k) { this.events.delete(k); },
            setAttribute(k, v) { this[k] = v; },
            removeAttribute(k) { delete this[k]; },
            click() { this.events.get('click')?.(); },
        });
        return nodes.get(id);
    }
    let paper = 'paper_a';
    let resolve;
    let calls = 0;
    const api = { mineruInspectRegion() {
        calls++;
        return new Promise(r => { resolve = r; });
    } };
    const controller = createRegionInspector({
        api, root: { querySelector: selector => node(selector.slice(1)) },
        getPaperId: () => paper, getPage: () => 5,
    });
    const finish = result => { resolve(result); };
    return { node, controller, finish, calls: () => calls, switchPaper(id) { paper = id; controller.reset(); } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function good() {
    return { success: true, data: { data: {
        paper_id: 'paper_a', page: 5, text: '<script>not HTML</script>',
        sha256: 'a'.repeat(64), original_rotation: 0,
    }, imageUrl: 'data:image/png;base64,AAAA' } };
}
test('cancellation discards result and retains occupancy until request finishes', async () => {
    const x = setup();
    x.node('inspect-current').click();
    x.node('inspect-run').click();
    assert.equal(x.calls(), 1);
    x.node('inspect-cancel').click();
    x.node('inspect-run').click();
    assert.equal(x.calls(), 1);
    assert.equal(x.node('inspect-run').disabled, true);
    x.finish(good());
    await tick();
    assert.equal(x.node('inspect-text').textContent, '');
    assert.equal(x.node('inspect-run').disabled, false);
    x.controller.destroy();
});
test('switching paper rejects late image and text', async () => {
    const x = setup();
    x.node('inspect-current').click();
    x.node('inspect-run').click();
    x.switchPaper('paper_b');
    x.finish(good());
    await tick();
    assert.equal(x.node('inspect-image').src, undefined);
    assert.equal(x.node('inspect-text').textContent, '');
    x.controller.destroy();
});
test('evidence uses plain text and failures remain visible', async () => {
    const x = setup();
    x.node('inspect-current').click();
    x.node('inspect-run').click();
    x.finish(good());
    await tick();
    assert.equal(x.node('inspect-text').textContent, '<script>not HTML</script>');
    x.node('inspect-run').click();
    x.finish({ success: false, error: 'PYTHON_NOT_CONFIGURED' });
    await tick();
    assert.match(x.node('inspect-status').textContent, /PYTHON_NOT_CONFIGURED/);
    assert.equal(x.node('inspect-image').src, undefined);
    x.controller.destroy();
    assert.equal(x.node('inspect-run').events.size, 0);
});