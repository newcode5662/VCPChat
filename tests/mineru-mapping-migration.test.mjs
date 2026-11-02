import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import migration from '../modules/services/minerU/pdfMappingMigration.js';

function sandbox(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineru-mapping-preview-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, 'pdf-map.json');
}
test('migration preview separates eligible, existing, unverified and failed without writing', async t => {
    const file = sandbox(t);
    const ids = ['paper_good', 'paper_disabled', 'paper_unknown', 'paper_missing'];
    const value = Object.fromEntries(ids.map(id => [id, path.resolve(`${id}.pdf`)]));
    fs.writeFileSync(file, JSON.stringify(value));
    const before = fs.readFileSync(file);
    const calls = [];
    const report = await migration.previewLegacyMappings(file, async request => {
        calls.push(request);
        assert.equal(request.apply, undefined);
        const base = { paper_id: request.paper_id, binding_revision: 'missing' };
        if (request.paper_id === 'paper_disabled') return { ...base, binding_revision: 'existing-tombstone' };
        if (request.paper_id === 'paper_missing') throw new Error('ENOENT');
        if (request.command === 'get_pdf_binding') return base;
        return { ...base, can_apply: request.paper_id === 'paper_good',
            id_prefix_matches: request.paper_id === 'paper_good', sha256: 'a'.repeat(64) };
    });
    assert.deepEqual(report.counts, { eligible: 1, skipped_existing_binding: 1, identity_unverified: 1, failed: 1 });
    assert.equal(report.partial, true);
    assert.equal(report.applied, false);
    assert.equal(report.mappingRevision.length, 64);
    assert.equal(calls.filter(c => c.paper_id === 'paper_disabled').length, 1);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['pdf-map.json']);
});
test('migration preview rejects changed source and malformed or oversized input', async t => {
    const file = sandbox(t);
    fs.writeFileSync(file, JSON.stringify({ paper_a: path.resolve('a.pdf') }));
    await assert.rejects(migration.previewLegacyMappings(file, async request => {
        fs.writeFileSync(file, '{}');
        return { paper_id: request.paper_id, binding_revision: 'already-bound' };
    }), /LEGACY_MAPPING_CHANGED/);
    fs.writeFileSync(file, '{broken');
    await assert.rejects(migration.previewLegacyMappings(file, async () => {}), SyntaxError);
    fs.writeFileSync(file, '[]');
    await assert.rejects(migration.previewLegacyMappings(file, async () => {}), /INVALID/);
    fs.writeFileSync(file, Buffer.alloc(1024 * 1024 + 1));
    await assert.rejects(migration.previewLegacyMappings(file, async () => {}), /INVALID/);
});
test('migration preview handles missing map, foreign receipt and concurrent attachment', async t => {
    const file = sandbox(t);
    const absent = await migration.previewLegacyMappings(file, async () => { throw Error('must not call'); });
    assert.equal(absent.mappingRevision, 'missing');
    assert.equal(fs.existsSync(file), false);
    fs.writeFileSync(file, JSON.stringify({ paper_a: path.resolve('a.pdf') }));
    const foreign = await migration.previewLegacyMappings(file, async () => ({
        paper_id: 'paper_other', binding_revision: 'missing',
    }));
    assert.equal(foreign.items[0].status, 'failed');
    const changed = await migration.previewLegacyMappings(file, async request => ({
        paper_id: request.paper_id,
        binding_revision: request.command === 'get_pdf_binding' ? 'missing' : 'new-binding',
    }));
    assert.equal(changed.items[0].status, 'skipped_concurrent_binding');
});

test('migration apply backs up exact bytes, reports partial success and resumes without overwrite', async t => {
    const file = sandbox(t);
    const map = { paper_a: path.resolve('a.pdf'), paper_b: path.resolve('b.pdf') };
    fs.writeFileSync(file, JSON.stringify(map));
    const original = fs.readFileSync(file);
    const bound = new Set();
    let failB = true;
    let writes = 0;
    const command = async request => {
        const id = request.paper_id;
        if (!request.apply) return {
            paper_id: id, binding_revision: bound.has(id) ? 'already-bound' : 'missing',
            can_apply: true, id_prefix_matches: true, sha256: 'a'.repeat(64),
        };
        assert.equal(request.expected_revision, 'missing');
        assert(!bound.has(id), 'must not overwrite');
        const backup = fs.readdirSync(path.dirname(file)).find(n => n.includes('.backup.'));
        assert.ok(backup, 'backup must precede any commit');
        assert.deepEqual(fs.readFileSync(path.join(path.dirname(file), backup)), original);
        if (id === 'paper_b' && failB) throw Error('simulated failure');
        bound.add(id); writes++;
        return { paper_id: id, applied: true, revision: 'new-revision',
            binding: { paper_id: id, sha256: 'a'.repeat(64), disabled: false } };
    };
    const preview = await migration.previewLegacyMappings(file, command);
    const options = { expectedRevision: preview.mappingRevision,
        expectedPdfHashes: Object.fromEntries(preview.items.map(i => [i.paperId, i.pdfSha256])) };
    const first = await migration.applyLegacyMappings(file, command, options);
    assert.equal(first.applied, true);
    assert.equal(first.partial, true);
    assert.equal(first.outcomeUncertain, true);
    assert.equal(first.counts.migrated, 1);
    assert.equal(first.counts.failed, 1);
    assert.deepEqual(fs.readFileSync(first.backup), original);
    failB = false;
    const second = await migration.applyLegacyMappings(file, command, options);
    assert.equal(second.counts.skipped_existing_binding, 1);
    assert.equal(second.counts.migrated, 1);
    assert.equal(second.partial, false);
    assert.equal(writes, 2);
    assert.deepEqual(fs.readFileSync(file), original);
    assert.equal(fs.existsSync(`${file}.migration.lock`), false);
});
test('migration rejects stale map and changed PDF hash, respects lock and reconciles lost receipt', async t => {
    const file = sandbox(t);
    fs.writeFileSync(file, JSON.stringify({ paper_a: path.resolve('a.pdf') }));
    let bound = false;
    let writes = 0;
    const command = async request => {
        if (!request.apply) return { paper_id: request.paper_id,
            binding_revision: bound ? 'existing' : 'missing',
            can_apply: true, id_prefix_matches: true, sha256: 'a'.repeat(64) };
        writes++; bound = true;
        throw Error('receipt lost after commit');
    };
    const preview = await migration.previewLegacyMappings(file, command);
    const options = { expectedRevision: preview.mappingRevision, expectedPdfHashes: { paper_a: 'a'.repeat(64) } };
    await assert.rejects(migration.applyLegacyMappings(file, command,
        { ...options, expectedRevision: '0'.repeat(64) }), /MAPPING_CHANGED/);
    fs.writeFileSync(`${file}.migration.lock`, 'other', { flag: 'wx' });
    await assert.rejects(migration.applyLegacyMappings(file, command, options), /EEXIST/);
    assert.equal(fs.readFileSync(`${file}.migration.lock`, 'utf8'), 'other');
    fs.unlinkSync(`${file}.migration.lock`);
    const changed = await migration.applyLegacyMappings(file, command,
        { ...options, expectedPdfHashes: { paper_a: 'b'.repeat(64) } });
    assert.equal(changed.items[0].error, 'PDF_CHANGED_SINCE_PREVIEW');
    assert.equal(writes, 0);
    const uncertain = await migration.applyLegacyMappings(file, command, options);
    assert.equal(uncertain.outcomeUncertain, true);
    assert.equal(uncertain.applied, false, 'no acknowledged commit; outcomeUncertain carries the ambiguity');
    const retry = await migration.applyLegacyMappings(file, command, options);
    assert.equal(retry.counts.skipped_existing_binding, 1);
    assert.equal(writes, 1);
});
test('migration source change after first commit stops remaining writes but preserves receipt', async t => {
    const file = sandbox(t);
    fs.writeFileSync(file, JSON.stringify({
        paper_a: path.resolve('a.pdf'), paper_b: path.resolve('b.pdf'),
    }));
    const command = async request => {
        if (!request.apply) return { paper_id: request.paper_id, binding_revision: 'missing',
            can_apply: true, id_prefix_matches: true, sha256: 'a'.repeat(64) };
        fs.writeFileSync(file, '{}');
        return { paper_id: request.paper_id, applied: true, revision: 'new',
            binding: { paper_id: request.paper_id, sha256: 'a'.repeat(64) } };
    };
    const preview = await migration.previewLegacyMappings(file, command);
    const result = await migration.applyLegacyMappings(file, command, {
        expectedRevision: preview.mappingRevision,
        expectedPdfHashes: { paper_a: 'a'.repeat(64), paper_b: 'a'.repeat(64) },
    });
    assert.equal(result.applied, true);
    assert.equal(result.sourceChanged, true);
    assert.equal(result.counts.migrated, 1);
    assert.equal(result.counts.not_attempted, 1);
    assert.equal(result.partial, true);
});