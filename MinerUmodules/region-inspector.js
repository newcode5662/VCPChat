export function createRegionInspector({ api, root, getPaperId, getPage }) {
    const find = id => root.querySelector(`#${id}`);
    const panel = find('inspect-region-panel');
    const toggle = find('inspect-region-toggle');
    const run = find('inspect-run');
    const cancel = find('inspect-cancel');
    const page = find('inspect-page');
    const bbox = find('inspect-bbox');
    const status = find('inspect-status');
    const image = find('inspect-image');
    const text = find('inspect-text');
    let generation = 0;
    let busy = false;
    let destroyed = false;
    const listeners = [];
    function listen(node, event, handler) {
        node.addEventListener(event, handler);
        listeners.push(() => node.removeEventListener(event, handler));
    }
    function clear() {
        image.hidden = true;
        image.removeAttribute('src');
        text.textContent = '';
    }
    function invalidate() {
        generation += 1;
        clear();
        status.textContent = busy ? '已取消显示，等待当前只读核验退出后可重试。' : '';
        cancel.disabled = true;
    }
    async function inspect() {
        if (busy || destroyed) return;
        const paperId = getPaperId();
        if (!paperId) { status.textContent = '请先选择论文。'; return; }
        if (typeof api.mineruInspectRegion !== 'function') {
            status.textContent = '当前客户端未加载区域核验 API，请更新并重开工作台。';
            return;
        }
        let options;
        try {
            options = { page: Number(page.value), dpi: 120, withImage: true };
            if (bbox.value.trim()) options.bbox = JSON.parse(bbox.value);
            if (!Number.isInteger(options.page) || options.page < 1) throw new Error('页码必须是正整数');
            if (options.bbox && (!Array.isArray(options.bbox) || options.bbox.length !== 4
                || !options.bbox.every(Number.isFinite))) throw new Error('裁框必须为四个有限数值');
        } catch (error) {
            status.textContent = `输入错误：${error.message}`;
            return;
        }
        const seq = ++generation;
        busy = true;
        run.disabled = true;
        cancel.disabled = false;
        clear();
        status.textContent = `正在核验第 ${options.page} 页…`;
        try {
            const result = await api.mineruInspectRegion(paperId, options);
            if (destroyed || seq !== generation || getPaperId() !== paperId) return;
            if (!result?.success) throw new Error(result?.error || '核验失败');
            const evidence = result.data;
            if (evidence?.data?.paper_id !== paperId || evidence.data.page !== options.page) {
                throw new Error('核验回执身份不匹配');
            }
            text.textContent = evidence.data.text;
            if (typeof evidence.imageUrl === 'string'
                && evidence.imageUrl.startsWith('data:image/png;base64,')) {
                image.src = evidence.imageUrl;
                image.hidden = false;
            }
            status.textContent = `第 ${evidence.data.page} 页 · SHA256 ${evidence.data.sha256} · 原旋转 ${evidence.data.original_rotation}°，图像按0°输出。源文本顺序未校正。`;
        } catch (error) {
            if (!destroyed && seq === generation && getPaperId() === paperId) {
                status.textContent = `核验失败：${error.message}`;
            }
        } finally {
            busy = false;
            if (!destroyed) {
                run.disabled = false;
                cancel.disabled = true;
                if (seq !== generation) status.textContent = '上次核验已退出，可重新核验。';
            }
        }
    }
    listen(toggle, 'click', () => {
        panel.hidden = !panel.hidden;
        toggle.setAttribute('aria-expanded', String(!panel.hidden));
        if (!panel.hidden) page.value = String(getPage() || 1);
    });
    listen(find('inspect-current'), 'click', () => { page.value = String(getPage() || 1); });
    listen(run, 'click', () => { void inspect(); });
    listen(cancel, 'click', invalidate);
    return {
        reset() { invalidate(); page.value = '1'; bbox.value = ''; },
        destroy() { destroyed = true; invalidate(); listeners.forEach(dispose => dispose()); },
    };
}