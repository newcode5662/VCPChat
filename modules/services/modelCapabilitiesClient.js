'use strict';

const { createHash } = require('node:crypto');

// Shared by all renderer callers; credentials never leave the main process cache key.
function createModelCapabilitiesClient({ readSettings, fetchImpl = globalThis.fetch, now = Date.now,
    maxEntries = 128, successTtl = 60000, errorTtl = 15000, timeoutMs = 10000 }) {
    const cache = new Map();
    const pending = new Map();

    async function request(url, apiKey, model) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetchImpl(url, {
                headers: { Authorization: `Bearer ${apiKey}` }, signal: controller.signal
            });
            if (!response.ok) return {
                error: response.status === 404 ? 'CAPABILITY_ENDPOINT_MISSING'
                    : [401, 403].includes(response.status) ? 'CAPABILITY_AUTH_FAILED' : 'CAPABILITY_HTTP_ERROR',
                status: response.status
            };
            const result = await response.json();
            return result?.version === 1 && result.model === model
                ? result : { error: 'CAPABILITY_INVALID_RESPONSE' };
        } catch {
            return { error: controller.signal.aborted ? 'CAPABILITY_TIMEOUT' : 'CAPABILITY_NETWORK_ERROR' };
        } finally {
            clearTimeout(timer);
        }
    }

    return async function getModelCapabilities(model) {
        if (typeof model !== 'string' || !model || model.length > 512) return null;
        let settings, url, key;
        try {
            settings = await readSettings();
            url = new URL('/v1/model-capabilities', settings.vcpServerUrl);
            url.searchParams.set('model', model);
            key = createHash('sha256').update(JSON.stringify([
                settings.vcpServerUrl, settings.vcpApiKey, model
            ])).digest('hex');
        } catch {
            return { error: 'CAPABILITY_NETWORK_ERROR' };
        }
        const entry = cache.get(key);
        if (entry && entry.expires > now()) {
            cache.delete(key);
            cache.set(key, entry);
            return entry.value;
        }
        cache.delete(key);
        if (pending.has(key)) return pending.get(key);
        const task = request(url, settings.vcpApiKey, model).then(value => {
            // Metadata failures may still expose manual choices, but should retry sooner.
            const failed = value?.error || value?.reasoning?.unavailable;
            cache.set(key, { value, expires: now() + (failed ? errorTtl : successTtl) });
            while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
            return value;
        }).finally(() => pending.delete(key));
        pending.set(key, task);
        return task;
    };
}

module.exports = { createModelCapabilitiesClient };
