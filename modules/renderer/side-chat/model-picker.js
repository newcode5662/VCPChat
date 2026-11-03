/* sideChatSurfaceOwner.js
 * Surface owner for Workspace Side Chat, supporting independent conversation,
 * concurrent streaming, cancellation, selection references, and lifecycle disposal.
 */
'use strict';

import { createModelPickerPopup } from '../model-picker-popup.js';

export function createSideChatModelPicker({
    store,
    chatCapabilities,
    doc,
    modelNameSpan,
    modelPickerBtn,
    modelPopover,
    persistMetadata,
    onModelChange,
    getReasoningSelection = () => null,
    onReasoningChange = () => {},
    updateComposerState
}) {
    const disposeCleanups = [];
    let capabilitySeq = 0;
    const select = doc.createElement('select');
    select.className = 'side-chat-thinking-select';
    select.setAttribute('aria-label', '思考强度');
    select.style.cssText = 'background:transparent;color:inherit;border:0;font:inherit;font-size:12px;max-width:155px';
    const budget = doc.createElement('input');
    budget.type = 'number';
    budget.min = '1';
    budget.step = '1';
    budget.hidden = true;
    budget.placeholder = '思考 token';
    budget.setAttribute('aria-label', '思考 token 预算，按 Enter 保存');
    budget.style.width = '90px';
    modelPickerBtn?.parentNode?.insertBefore(select, modelPickerBtn);
    modelPickerBtn?.parentNode?.insertBefore(budget, modelPickerBtn);
    const option = (label, value) => {
        const element = doc.createElement('option');
        element.textContent = label;
        element.value = value;
        return element;
    };
    async function refreshThinking() {
        const seq = ++capabilitySeq;
        const model = store.currentModel;
        select.replaceChildren(option('思考：默认', 'default'));
        select.disabled = true;
        const api = chatCapabilities?.electronAPI;
        let result = null;
        try {
            result = chatCapabilities?.getModelCapabilities
                ? await chatCapabilities.getModelCapabilities(model)
                : await api?.getModelCapabilities?.(model);
        } catch { /* Default remains available. */ }
        if (store.isDisposed || seq !== capabilitySeq || model !== store.currentModel) return;
        const capability = result?.version === 1 ? result.reasoning : null;
        const labels = { none: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大' };
        for (const effort of capability?.efforts || []) select.add(option(`思考：${labels[effort] || effort}${capability.manual ? '（手动）' : ''}`, effort));
        if (capability?.supportsBudget) select.add(option('思考：自定义预算', 'budget'));
        const saved = getReasoningSelection();
        const value = saved?.mode === 'effort' ? saved.value : saved?.mode === 'budget' ? 'budget' : 'default';
        if (![...select.options].some(item => item.value === value)) {
            const missing = option(`思考：${value}（不可用）`, value);
            missing.disabled = true;
            select.add(missing);
        }
        select.value = value;
        select.disabled = false;
        const errors = {
            CAPABILITY_ENDPOINT_MISSING: '后端能力接口不存在（404）：请确认后端运行版本与目录',
            CAPABILITY_AUTH_FAILED: '能力查询认证失败',
            CAPABILITY_TIMEOUT: '能力查询超时',
            CAPABILITY_NETWORK_ERROR: '无法连接能力接口',
            CAPABILITY_HTTP_ERROR: '能力接口返回错误',
            CAPABILITY_INVALID_RESPONSE: '能力接口响应格式不兼容'
        };
        select.title = !capability ? (errors[result?.error] || '能力查询不可用：请确认客户端与后端版本')
            : capability.manual ? `${capability.unavailable ? '后端无法获取上游模型目录；' : ''}上游未声明能力；手动发送 reasoning_effort，是否支持由上游决定；默认不覆盖上游策略；仅作用于本分支`
                : capability.unavailable ? '后端无法获取上游模型目录'
                : capability.status === 'supported' ? '按后端声明设置；仅作用于本分支' : '上游未声明可用配置';
        if (!capability) select.options[0].textContent = '思考：接口不可用';
        budget.hidden = value !== 'budget';
        if (saved?.mode === 'budget') budget.value = String(saved.value);
    }
    function saveThinking() {
        if (store.isDisposed) return;
        const value = select.value;
        if (value === 'budget' && (!Number.isSafeInteger(Number(budget.value)) || Number(budget.value) <= 0)) {
            budget.focus();
            return;
        }
        const selection = { version: 1, mode: value === 'default' ? 'default' : value === 'budget' ? 'budget' : 'effort',
            ...(value === 'default' ? {} : { value: value === 'budget' ? Number(budget.value) : value }) };
        onReasoningChange(selection);
        persistMetadata().catch(error => console.warn('[SideChat] Failed to save thinking:', error));
    }
    select.addEventListener('change', () => {
        budget.hidden = select.value !== 'budget';
        if (select.value === 'budget') budget.focus();
        else saveThinking();
    });
    budget.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); saveThinking(); }
    });
    void refreshThinking();
    disposeCleanups.push(() => { capabilitySeq++; select.remove(); budget.remove(); });

    // 移除模板中遗留的静态 popover，改由通用组件动态管理与渲染
    if (modelPopover && modelPopover.parentNode) {
        modelPopover.remove();
    }

    function updateModel(newModel) {
        if (!newModel || store.isDisposed) return;
        store.currentModel = newModel;
        store.currentDescriptor = { ...store.currentDescriptor, model: newModel };
        onModelChange(newModel);
        void refreshThinking();
        if (modelNameSpan) modelNameSpan.textContent = newModel;
        if (modelPickerBtn) {
            modelPickerBtn.title = `切换模型 (当前: ${newModel})`;
            modelPickerBtn.setAttribute('aria-expanded', 'false');
        }
        popup?.close();
        persistMetadata().catch(e => console.warn('[SideChat] Failed to persist model update:', e));
    }

    let popup = null;
    if (modelPickerBtn) {
        const wrap = modelPickerBtn.closest('.side-chat-model-picker-wrapper') || modelPickerBtn.parentElement;
        popup = createModelPickerPopup({
            doc,
            win: doc.defaultView,
            wrap,
            trigger: modelPickerBtn,
            getCatalog: async () => {
                try {
                    return await (chatCapabilities?.listModels?.() ?? { ids: [], favorites: new Set() });
                } catch (error) {
                    console.warn('[SideChat] Failed to load model list:', error);
                    return { ids: [], favorites: new Set() };
                }
            },
            getActiveModel: () => store.currentModel || '',
            onSelect: (newModel) => {
                if (!newModel) return;
                updateModel(newModel);
                updateComposerState?.();
                modelPickerBtn.focus?.();
            },
            enableCheckMenu: true
        });

        disposeCleanups.push(() => {
            popup?.dispose();
        });
    }

    return Object.freeze({
        updateModel,
        dispose() {
            disposeCleanups.splice(0).forEach(fn => { try { fn(); } catch {} });
        }
    });
}
