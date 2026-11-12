import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const binary = process.env.MINERU_TEST_BINARY;
const service = (await import('../modules/services/minerU/minerUService.js')).default;
const targets = {
    'win32:x64': 'x86_64-pc-windows-msvc.exe',
    'win32:arm64': 'aarch64-pc-windows-msvc.exe',
    'linux:x64': 'x86_64-unknown-linux-gnu',
    'linux:arm64': 'aarch64-unknown-linux-gnu',
    'darwin:x64': 'x86_64-apple-darwin',
    'darwin:arm64': 'aarch64-apple-darwin',
};
test('real frontend service binds, reads, disables and rebinds through native engine', {
    skip: !binary ? 'Set MINERU_TEST_BINARY to a trusted built MinerUParser executable' : false,
    timeout: 30000,
}, async t => {
    assert.ok(fs.existsSync(binary), 'explicit test binary must exist');
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mineru-ui-native-'));
    t.after(() => {
        service._test.reset();
        fs.rmSync(sandbox, { recursive: true, force: true });
    });
    const root = path.join(sandbox, 'VCPToolBox');
    const plugin = path.join(root, 'Plugin/MinerUParser');
    const suffix = targets[`${process.platform}:${process.arch}`];
    assert.ok(suffix, 'supported platform');
    const exe = path.join(plugin, 'bin', `MinerUParser-${suffix}`);
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.copyFileSync(binary, exe);
    if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
    fs.writeFileSync(path.join(plugin, 'plugin-manifest.json'), JSON.stringify({ name: 'MinerUParser', version: 'test' }));
    const pdf = path.join(sandbox, 'source.pdf');
    const bytes = Buffer.from('%PDF-1.4 frontend-native fixture');
    fs.writeFileSync(pdf, bytes);
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    const id = `paper_${sha.slice(0, 16)}`;
    const dir = path.join(root, 'file/mineru', id);
    fs.mkdirSync(dir, { recursive: true });
    const index = { paper_id: id, title: 'Native UI', file_name: 'source.pdf',
        pages: 1, text_chars: 1, image_count: 0, table_count: 0, formula_count: 0,
        md_path: '', render_url: '',
        outline: Array.from({ length: 45 }, (_, n) => ({ level: 1, text: `Section ${n}`, page_idx: n })),
        images: Array.from({ length: 20 }, (_, n) => ({ rel: `images/${n}.png`, url: '', caption: null, page_idx: n })),
        errors: [], warnings: [], custom_extension: { retained: true },
        source_path: pdf, created_at: 'original' };
    const raw = JSON.stringify(index);
    fs.writeFileSync(path.join(dir, 'index.json'), raw);
    fs.writeFileSync(path.join(dir, 'full.md'), '# Native body');
    const appDataRoot = path.join(sandbox, 'AppData');
    fs.mkdirSync(path.join(appDataRoot, 'MinerU'), { recursive: true });
    const legacy = path.join(appDataRoot, 'MinerU/pdf-map.json');
    const legacyRaw = JSON.stringify({ [id]: pdf });
    fs.writeFileSync(legacy, legacyRaw);
    service._test.reset();
    service._test.reinitialize({ appDataRoot, projectRoot: path.join(sandbox, 'VCPChat') });
    service.saveConfig({ toolboxRoot: root });
    assert.equal(service.getStatus().binary, exe);
    const library = await service.refreshLibrary();
    assert.equal(library.length, 1);
    assert.equal(library[0].paperId, id);
    assert.equal(library[0].group, 'indexed');
    assert.equal(service.getRecord(id).title, 'Native UI');
    const detail = await service.fetchPaperDetail(id);
    assert.equal(detail.index.images.length, 20);
    assert.equal(detail.index.outline.length, 45);
    assert.equal(detail.markdown, '# Native body');
    assert.equal(detail.paper.paperId, id);
    assert.equal(detail.state && Object.keys(detail.state).length, 0);
    const plan = await service.previewPdfMappingMigration();
    assert.equal(plan.counts.eligible, 1);
    const migrationOptions = {
        expectedRevision: plan.mappingRevision,
        expectedPdfHashes: { [id]: plan.items[0].pdfSha256 },
    };
    const migrated = await service.applyPdfMappingMigration(migrationOptions);
    assert.equal(migrated.counts.migrated, 1);
    assert.equal(migrated.outcomeUncertain, false);
    assert.equal(fs.readFileSync(migrated.backup, 'utf8'), legacyRaw);
    const resumed = await service.applyPdfMappingMigration(migrationOptions);
    assert.equal(resumed.counts.skipped_existing_binding, 1);
    assert.equal(resumed.applied, false);
    assert.equal(resumed.backup, null, 'no backup needed when no new writes');
    const receipt = await service.setPdfMapping(id, pdf);
    assert.equal(service.getRecord(id).pdfBindingStatus, 'bound');
    assert.deepEqual(service.readPdf(id).data, bytes);
    assert.equal(receipt.pdfName, 'source.pdf');
    await service.clearPdfMapping(id);
    assert.equal(service.getRecord(id).pdfBindingStatus, 'disabled');
    assert.equal(service.readPdf(id).available, false, 'do not fall back to old map OR source_path');
    await service.setPdfMapping(id, pdf);
    assert.equal(service.readPdf(id).available, true);
    assert.equal(fs.readFileSync(legacy, 'utf8'), legacyRaw, 'legacy map must not be written');
    assert.equal(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'), raw);
    assert.deepEqual(fs.readFileSync(pdf), bytes);
});