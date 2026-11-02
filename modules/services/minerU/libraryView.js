'use strict';
const ID = /^paper_[A-Za-z0-9_-]+$/;
const STATES = new Set(['indexed','running','timeout','failed','unknown']);

function validateLibraryView(data) {
    const fail = message => { throw new Error(`LIBRARY_VIEW_INVALID: ${message}`); };
    if (!data || data.schema !== 'mineru.library-view' || data.schema_version !== 1) fail('不支持的契约版本');
    if (data.complete !== true || data.truncated !== false) fail('后端未返回完整库');
    if (!Array.isArray(data.papers) || !Number.isSafeInteger(data.total)
        || data.total < 0 || data.total !== data.papers.length || data.total > 5000) fail('数量不一致');
    if (!/^[a-f0-9]{64}$/.test(data.revision || '')) fail('缺少快照指纹');
    const seen = new Set();
    const leaf = (value, id) => typeof value === 'string' && value.length > 0
        && !value.includes('\0') && !/[\\/]/.test(value) && !value.includes('..')
        && (value === id || value.endsWith(`__${id}`));
    for (const paper of data.papers) {
        if (!paper || !ID.test(paper.paper_id || '') || seen.has(paper.paper_id)) fail('无效或重复论文ID');
        seen.add(paper.paper_id);
        if (!leaf(paper.asset_dir, paper.paper_id)) fail('资产路径越界或身份不匹配');
        if (!STATES.has(paper.status)) fail('未知状态编码');
        if (!Array.isArray(paper.duplicate_dirs)
            || paper.duplicate_dirs.some(dir => !leaf(dir, paper.paper_id))) fail('重复资产路径无效');
        if (typeof paper.has_index !== 'boolean' || typeof paper.has_state !== 'boolean') fail('缺少产物标志');
    }
    // This validates shape, not cryptographic authenticity or a transactional snapshot.
    return data;
}

function validatePaperView(data, paperId) {
    const fail = message => { throw new Error(`PAPER_VIEW_INVALID: ${message}`); };
    if (!data || data.schema !== 'mineru.paper-view' || data.schema_version !== 1
        || data.complete !== true || data.truncated !== false
        || !/^[a-f0-9]{64}$/.test(data.revision || '')) fail('详情版本或完整性无效');
    validateLibraryView({
        schema: 'mineru.library-view', schema_version: 1, complete: true, truncated: false,
        revision: data.revision, total: 1, papers: [data.paper],
    });
    if (data.paper.paper_id !== paperId) fail('论文身份不匹配');
    for (const [key, present] of [['index', data.paper.has_index], ['state', data.paper.has_state]]) {
        const value = data[key];
        if (value == null) {
            if (present) fail(`${key}缺失`);
        } else if (typeof value !== 'object' || Array.isArray(value) || value.paper_id !== paperId) {
            fail(`${key}身份无效`);
        }
    }
    if (data.index && (!Array.isArray(data.index.images) || !Array.isArray(data.index.outline)
        || !Array.isArray(data.index.errors) || !Array.isArray(data.index.warnings))) fail('索引数组缺失');
    return data;
}

module.exports = { validateLibraryView, validatePaperView };