import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createSideChatDraftStore } from '../modules/renderer/side-chat/draft-store.js';
import { createSideChatModelPicker } from '../modules/renderer/side-chat/model-picker.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 10));

for (const unavailable of [false, true]) {
    test(`side manual choices remain available (metadata unavailable: ${unavailable})`, async t => {
        const dom = new JSDOM('<div><button>m</button></div>');
        t.after(() => dom.window.close());
        const doc = dom.window.document;
        let selection = null;
        let saves = 0;
        const efforts = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'];
        const owner = createSideChatModelPicker({
            store: { currentModel: 'm', currentDescriptor: {} }, doc,
            modelPickerBtn: doc.querySelector('button'),
            chatCapabilities: { getModelCapabilities: async () => ({ version: 1, model: 'm',
                reasoning: { status: 'unknown', source: 'manual', manual: true, unavailable, efforts } }) },
            getReasoningSelection: () => selection,
            onReasoningChange: value => { selection = value; }, onModelChange() {},
            persistMetadata: async () => { saves++; }
        });
        t.after(() => owner.dispose());
        await tick();
        const select = doc.querySelector('select');
        assert.deepEqual([...select.options].map(o => o.value), ['default', ...efforts]);
        assert.equal(select.value, 'default');
        assert.equal(saves, 0);
        assert.equal(select.disabled, false);
        assert.match(select.title, /上游未声明能力；手动发送 reasoning_effort，是否支持由上游决定/);
        assert.match(select.title, /默认不覆盖/);
        for (const option of [...select.options].slice(1)) {
            assert.match(option.textContent, /手动/);
            assert.equal(option.disabled, false);
        }
        for (const value of ['max', 'none', 'default']) {
            select.value = value;
            select.dispatchEvent(new dom.window.Event('change'));
            assert.deepEqual(selection, value === 'default' ? { version: 1, mode: 'default' }
                : { version: 1, mode: 'effort', value });
        }
        assert.equal(saves, 3);
    });
}

test('branch reasoning survives browser persistence without changing another branch', () => {
    const values = new Map();
    const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
    const drafts = createSideChatDraftStore({ getStorage: () => storage });
    const a = { parent: { itemId: 'a', topicId: 'p' }, child: { itemId: 'a', topicId: 'child' } };
    const b = { ...a, child: { itemId: 'a', topicId: 'other' } };
    const selection = { version: 1, mode: 'effort', value: 'high' };
    assert.equal(drafts.save(a, { draft: '', model: 'm', reasoningSelection: selection }).ok, true);
    assert.deepEqual(drafts.read(a).input.reasoningSelection, selection);
    assert.equal(drafts.read(b).input, null);
    assert.equal(drafts.save(a, { draft: '', model: 'm', reasoningSelection: { version: 1, mode: 'default' } }).ok, true);
    assert.equal(drafts.read(a).input.reasoningSelection.mode, 'default');
});

test('side thinking is capability driven, ignores old response and persists only local choice', async t => {
    const dom = new JSDOM('<div><button class="model">m</button><span></span></div>');
    t.after(() => dom.window.close());
    const doc = dom.window.document;
    const store = { currentModel: 'a', currentDescriptor: {}, isDisposed: false };
    let selection = null;
    let saves = 0;
    const pending = [];
    const owner = createSideChatModelPicker({
        store, doc, modelPickerBtn: doc.querySelector('button'), modelNameSpan: doc.querySelector('span'),
        chatCapabilities: { electronAPI: { getModelCapabilities: model => new Promise(resolve => pending.push({ model, resolve })) } },
        onModelChange() {}, getReasoningSelection: () => selection,
        onReasoningChange: value => { selection = value; },
        persistMetadata: async () => { saves++; }
    });
    t.after(() => { store.isDisposed = true; owner.dispose(); });
    owner.updateModel('b');
    pending[1].resolve({ version: 1, model: 'b', reasoning: { efforts: ['low'] } });
    await tick();
    pending[0].resolve({ version: 1, model: 'a', reasoning: { efforts: ['high'] } });
    await tick();
    const select = doc.querySelector('.side-chat-thinking-select');
    assert.deepEqual([...select.options].map(option => option.value), ['default', 'low']);
    select.value = 'low';
    select.dispatchEvent(new dom.window.Event('change'));
    assert.deepEqual(selection, { version: 1, mode: 'effort', value: 'low' });
    assert.ok(saves >= 2);
});