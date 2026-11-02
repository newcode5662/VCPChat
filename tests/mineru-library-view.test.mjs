import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLibraryView, validatePaperView } from '../modules/services/minerU/libraryView.js';

const valid = () => ({
    schema: 'mineru.library-view', schema_version: 1, complete: true, truncated: false,
    revision: 'a'.repeat(64), total: 1, papers: [{
        paper_id: 'paper_a', asset_dir: 'Title__paper_a', duplicate_dirs: [],
        status: 'indexed', has_index: true, has_state: false,
    }],
});
test('machine view accepts complete metadata including an empty library', () => {
    const data = valid();
    assert.equal(validateLibraryView(data), data);
    assert.equal(validateLibraryView({ ...valid(), papers: [], total: 0 }).total, 0);
});
test('machine view refuses incomplete, foreign-version, duplicate and unsafe records', () => {
    const bad = [];
    bad.push({ ...valid(), complete: false }, { ...valid(), truncated: true },
        { ...valid(), schema_version: 2 }, { ...valid(), total: 2 },
        { ...valid(), revision: 'not-a-digest' });
    const duplicate = valid(); duplicate.papers.push(duplicate.papers[0]); duplicate.total = 2; bad.push(duplicate);
    for (const patch of [
        { asset_dir: '../escape' }, { asset_dir: 'Other__paper_b' },
        { duplicate_dirs: ['../x'] }, { status: 'made-up' }, { has_index: null },
    ]) {
        const data = valid(); Object.assign(data.papers[0], patch); bad.push(data);
    }
    for (const data of bad) assert.throws(() => validateLibraryView(data), /LIBRARY_VIEW_INVALID/);
});

test('paper view preserves complete arrays and rejects partial or foreign metadata', () => {
    const detail = () => ({
        schema: 'mineru.paper-view', schema_version: 1, complete: true, truncated: false,
        revision: 'b'.repeat(64), paper: valid().papers[0], state: null,
        index: { paper_id: 'paper_a', images: Array.from({ length: 20 }, (_, n) => ({ rel: `${n}.png` })),
            outline: Array.from({ length: 45 }, (_, n) => ({ text: `Section ${n}` })),
            errors: [], warnings: [], custom_extension: { retained: true } },
    });
    const good = validatePaperView(detail(), 'paper_a');
    assert.equal(good.index.images.length, 20);
    assert.equal(good.index.outline.length, 45);
    assert.equal(good.index.custom_extension.retained, true);
    for (const mutate of [
        d => { d.complete = false; }, d => { d.truncated = true; },
        d => { d.index.paper_id = 'paper_other'; }, d => { d.index = null; },
        d => { d.index.images = {}; }, d => { d.state = { paper_id: 'paper_other' }; },
    ]) {
        const data = detail(); mutate(data);
        assert.throws(() => validatePaperView(data, 'paper_a'), /PAPER_VIEW_INVALID/);
    }
    assert.throws(() => validatePaperView(detail(), 'paper_other'), /PAPER_VIEW_INVALID/);
});