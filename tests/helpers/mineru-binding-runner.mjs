// Protocol mock only; native digest/locking is covered by Rust stdio smoke tests.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

export function installBindingRunner(service) {
    const calls = [];
    service._test.setCommandRunner(async request => {
        calls.push(request);
        const record = service.getRecord(request.paper_id);
        if (!record) return { ok: false, error: 'paper missing' };
        const file = path.join(record.fileDir, 'pdf-binding.json');
        const raw = fs.existsSync(file) ? fs.readFileSync(file) : null;
        const revision = raw ? crypto.createHash('sha256').update(raw).digest('hex') : 'missing';
        const old = raw ? JSON.parse(raw) : null;
        const base = { paper_id: request.paper_id, binding_revision: revision };
        if (request.command === 'get_pdf_binding') return { ok: true, data: { ...base, binding: old } };
        if (!request.apply) {
            return { ok: true, data: request.command === 'link_pdf'
                ? { ...base, sha256: 'fixture-digest', can_apply: true }
                : base };
        }
        assert.equal(request.expected_revision, revision);
        if (request.command === 'link_pdf') assert.equal(request.expected_pdf_sha256, 'fixture-digest');
        const binding = request.command === 'unlink_pdf'
            ? { schema_version: 1, paper_id: request.paper_id, disabled: true }
            : { schema_version: 1, paper_id: request.paper_id, path: request.file_path, disabled: false };
        fs.writeFileSync(file, JSON.stringify(binding));
        return { ok: true, data: { paper_id: request.paper_id, applied: true, binding,
            disabled: binding.disabled, revision: 'fixture-revision' } };
    });
    return calls;
}