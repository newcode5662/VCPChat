export function createDocumentReview({ api, root, getPaperId }) {
    const node = suffix => root.querySelector(`#review-document-${suffix}`);
    let generation = 0;
    let current = null;
    let starting = false;
    let destroyed = false;
    let fetching = null;
    let composing = false;
    let exporting = false;
    let loadedJob = null;
    let selectionSeq = 0;
    const selected = new Set();
    const listeners = [];
    function listen(element, event, handler) {
        element.addEventListener(event, handler);
        listeners.push(() => element.removeEventListener(event, handler));
    }
    async function call(promise) {
        const response = await promise;
        if (!response?.success) throw new Error(response?.error || '调用失败');
        return response.data;
    }
    function clear() {
        loadedJob = null;
        selected.clear();
        selectionSeq++;
        node('proposals').textContent = '';
        node('compose').disabled = true;
        node('export').disabled = true;
        node('diff').textContent = '';
        node('markdown').value = '';
    }
    function controls() {
        const active = current && ['running', 'stopping'].includes(current.state);
        node('start').disabled = starting || Boolean(active) || fetching !== null || composing || exporting;
        node('compose').disabled = loadedJob !== current?.id || fetching !== null || composing || exporting;
        node('export').disabled = loadedJob !== current?.id || fetching !== null || composing || exporting;
        node('cancel').disabled = !active || current.state === 'stopping';
    }
    async function accept(job) {
        if (destroyed || !current || current.id !== job.id
            || job.paperId !== getPaperId()) return;
        current = job;
        controls();
        if (job.state === 'done' && loadedJob === job.id) return;
        node('status').textContent = job.state === 'running'
            ? `正在逐页核验 ${job.completedPages}/${job.totalPages ?? '?'}`
            : job.state === 'stopping' ? '停止已请求，等待当前页退出…'
            : job.state === 'failed' ? `失败：${job.error}`
            : job.state === 'cancelled' ? '已取消，未生成全篇草稿。'
            : '逐页核验结束，正在读取草稿…';
        if (job.state !== 'done' || fetching === job.id) return;
        const seq = generation;
        fetching = job.id;
        controls();
        try {
            const draft = await call(api.mineruReviewResult(job.id));
            if (destroyed || seq !== generation || current?.id !== job.id
                || draft.paperId !== getPaperId()) return;
            loadedJob = job.id;
            node('markdown').value = draft.correctedMarkdown;
            node('proposals').textContent = '';
            selected.clear();
            selectionSeq++;
            for (const [index, proposal] of (draft.reviewProposals || []).entries()) {
                const doc = root.ownerDocument || root;
                const item = doc.createElement('details');
                const summary = doc.createElement('summary');
                summary.textContent = `候选 ${index + 1} · 第 ${proposal.evidence.page} 页 · 相似度 ${proposal.similarity}（非正确率）`;
                const label = doc.createElement('label');
                const checkbox = doc.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.addEventListener('change', () => {
                    if (checkbox.checked) selected.add(index); else selected.delete(index);
                    selectionSeq++;
                    node('status').textContent = '选择已改变，请重新生成预览；原文未修改。';
                });
                label.append(checkbox, doc.createTextNode('已核对原页，接受此候选'));
                const before = doc.createElement('pre');
                before.textContent = `原文：
${proposal.before}`;
                const after = doc.createElement('pre');
                after.textContent = `候选：
${proposal.proposed}`;
                item.append(summary, label, before, after);
                node('proposals').append(item);
            }
            node('diff').textContent = JSON.stringify({
                sourceSha256: draft.originalSha256,
                pdfSha256: draft.pdfSha256,
                coverage: draft.coverage,
                alignmentCoverage: draft.alignmentCoverage,
                reviewProposals: draft.reviewProposals || [],
                changes: draft.changes,
                unresolved: draft.unresolved,
                limitations: draft.limitations,
            }, null, 2);
            node('status').textContent = `草稿待复核：${draft.changes.length} 项连字修改，${draft.reviewProposals?.length || 0} 项段落替换候选，${draft.unresolved.length} 项连字未解决。候选未应用、草稿未保存；0项不代表原文无错。`;
        } catch (error) {
            if (!destroyed && seq === generation) node('status').textContent = `读取草稿失败：${error.message}`;
        } finally {
            if (fetching === job.id) fetching = null;
            if (!destroyed) controls();
        }
    }
    async function start() {
        if (starting || fetching || composing || exporting
            || current && ['running', 'stopping'].includes(current.state)) return;
        const paperId = getPaperId();
        if (!paperId) return;
        if (typeof api.mineruStartReview !== 'function') {
            node('status').textContent = '客户端尚未加载全篇核验 API，请更新并重开工作台。';
            return;
        }
        const seq = ++generation;
        starting = true;
        clear();
        controls();
        try {
            const job = await call(api.mineruStartReview(paperId));
            if (destroyed || seq !== generation || paperId !== getPaperId()) {
                await call(api.mineruCancelReview(job.id)).catch(() => {});
                return;
            }
            current = job;
            await accept(job);
            if (!destroyed && seq === generation && current?.id === job.id) {
                await accept(await call(api.mineruReviewStatus(job.id)));
            }
        } catch (error) {
            if (!destroyed && seq === generation) node('status').textContent = `启动失败：${error.message}`;
        } finally {
            starting = false;
            if (!destroyed) controls();
        }
    }
    function reset() {
        generation++;
        const previous = current;
        current = null;
        clear();
        if (previous && ['running', 'stopping'].includes(previous.state)) {
            void call(api.mineruCancelReview(previous.id)).catch(() => {});
        }
        node('status').textContent = '';
        if (!destroyed) controls();
    }
    listen(node('toggle'), 'click', () => {
        node('panel').hidden = !node('panel').hidden;
        node('toggle').setAttribute('aria-expanded', String(!node('panel').hidden));
    });
    listen(node('start'), 'click', () => { void start(); });
    listen(node('compose'), 'click', async () => {
        if (composing || exporting || loadedJob !== current?.id || current?.state !== 'done') return;
        const seq = generation, selection = selectionSeq, job = current;
        composing = true;
        controls();
        try {
            const preview = await call(api.mineruComposeReview(job.id, [...selected]));
            if (destroyed || seq !== generation || selection !== selectionSeq
                || current?.id !== job.id || preview.paperId !== getPaperId()) return;
            node('markdown').value = preview.correctedMarkdown;
            node('diff').textContent = JSON.stringify(preview.edits, null, 2);
            node('status').textContent = `预览已生成：接受 ${preview.acceptedProposalIndices.length} 项候选。未保存，原文未修改。`;
        } catch (error) {
            if (!destroyed && seq === generation) node('status').textContent = `生成失败：${error.message}`;
        } finally {
            composing = false;
            if (!destroyed) controls();
        }
    });
    listen(node('export'), 'click', async () => {
        if (exporting || composing || loadedJob !== current?.id || current?.state !== 'done') return;
        const seq = generation, job = current, indices = [...selected];
        exporting = true;
        controls();
        try {
            const receipt = await call(api.mineruExportReview(job.id, indices));
            if (destroyed || seq !== generation || current?.id !== job.id) return;
            node('status').textContent = receipt.cancelled
                ? '已取消导出，未写文件。'
                : `已导出点击时所选候选至 ${receipt.directory}。原文未修改；未复制图片，图片相对链接仍依赖原资产。`;
        } catch (error) {
            if (!destroyed && seq === generation) node('status').textContent = `导出失败：${error.message}`;
        } finally {
            exporting = false;
            if (!destroyed) controls();
        }
    });
    listen(node('cancel'), 'click', async () => {
        const job = current;
        if (!job) return;
        try { await accept(await call(api.mineruCancelReview(job.id))); }
        catch (error) {
            if (!destroyed && current?.id === job.id) node('status').textContent = `取消失败：${error.message}`;
        }
    });
    const unsubscribe = api.onMineruReviewProgress?.(job => { void accept(job); });
    return {
        reset,
        destroy() {
            destroyed = true;
            reset();
            if (typeof unsubscribe === 'function') unsubscribe();
            listeners.forEach(dispose => dispose());
        },
    };
}