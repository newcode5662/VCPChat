'use strict';
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Host-only wiring. principalId MUST come from authenticated host state, not
 * toolArgs, maid/valet, request IP, or an unverified transport field.
 * This module validates scope shape, NOT principal authenticity.
 * dataRoot is a host-owned dedicated data root, never the target file's parent.
 * No filesystem access, automatic expiry, or fallback to a shared principal.
 */
function resolveOperationScope({ dataRoot, endpoint, principalId } = {}) {
    if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot) || dataRoot.includes('\0')) {
        throw new Error('OPERATION_DATA_ROOT_REQUIRED');
    }
    if (!['client', 'server'].includes(endpoint)) throw new Error('OPERATION_ENDPOINT_INVALID');
    if (typeof principalId !== 'string' || !principalId.trim()
        || principalId !== principalId.trim() || Buffer.byteLength(principalId, 'utf8') > 1024
        || [...principalId].some(character => {
            const code = character.codePointAt(0);
            return code < 32 || code === 127;
        })) {
        throw new Error('OPERATION_TRUSTED_PRINCIPAL_REQUIRED');
    }
    // Versioned structured encoding avoids delimiter collisions.
    const scopeId = crypto.createHash('sha256')
        .update(JSON.stringify(['file-operator-scope', 1, endpoint, principalId]))
        .digest('hex');
    return {
        schemaVersion: 1,
        endpoint,
        scopeId,
        ledgerRoot: path.join(path.resolve(dataRoot), 'FileOperatorOperations', 'v1', endpoint, scopeId),
        expiryPolicy: 'explicit_cleanup_only',
    };
}
module.exports = { resolveOperationScope };