import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { validateProvider, importCcSwitch, exportCcSwitch, runtimeConfig, fetchModels, fetchUsage } from '../server/providers.mjs';
import { cleanUrl, percentage, dotGet, redact } from '../server/util.mjs';
const provider = changes => validateProvider({ id: 'test', kind: 'relay', name: 'AstroGate', baseUrl: 'https://relay.example/v1', ...changes });
test('provider URL requires HTTPS unless loopback or explicit insecure flag', () => { assert.equal(cleanUrl('https://relay.example/v1///'), 'https://relay.example/v1'); assert.throws(() => cleanUrl('http://relay.example/v1')); assert.throws(() => cleanUrl('file:///etc/passwd')); assert.throws(() => cleanUrl('https://user:pass@relay.example')); assert.equal(cleanUrl('http://127.0.0.1:123/v1'), 'http://127.0.0.1:123/v1'); assert.throws(() => provider({ baseUrl: 'https://host/v1?api_key=secret' })); });
test('usage provider key cannot be forwarded to a different origin', () => { assert.throws(() => provider({ usage: { url: 'https://billing.example/me', auth: 'provider' } }), /同源/); assert.equal(provider({ usage: { url: 'https://billing.example/me', auth: 'custom' } }).usage.auth, 'custom'); });
test('percentage is unknown for missing, zero denominator and invalid inputs', () => { for (const pair of [[undefined, 1], [0, 0], [100, null], [100, -1], [100, 101], [Infinity, 3], ['', 1]])
    assert.equal(percentage(...pair), null); assert.equal(percentage(100, 27), 27); assert.equal(percentage('300', '120'), 40); });
test('safe JSON fields cannot evaluate code or access inherited properties', () => { assert.equal(dotGet({ data: { remaining: 27 } }, 'data.remaining'), 27); assert.equal(dotGet({}, '__proto__.constructor'), undefined); assert.throws(() => dotGet({}, 'a[0]')); });
test('CC Switch imports selected provider, not unrelated tables, and preserves key/model', () => { const result = importCcSwitch({ name: 'Relay import', settingsConfig: { auth: { OPENAI_API_KEY: 'fixture-key' }, config: 'model = "relay-model"\nmodel_provider = "selected"\n[model_providers.other]\nbase_url = "https://wrong.example/v1"\n[model_providers.selected]\nname = "chosen"\nbase_url = "https://correct.example/v1"\nwire_api = "responses"\n' } }); assert.equal(result.providers.length, 1); assert.equal(result.providers[0].baseUrl, 'https://correct.example/v1'); assert.equal(result.providers[0].apiKey, 'fixture-key'); assert.equal(result.providers[0].defaultModel, 'relay-model'); });
test('CC Switch export is credential-free by default and round trips', () => { const p = provider({ defaultModel: 'custom-model' }); const out = exportCcSwitch(p); assert.equal(out.settingsConfig.auth.OPENAI_API_KEY, ''); const loaded = importCcSwitch(out); assert.equal(loaded.providers[0].baseUrl, p.baseUrl); assert.equal(loaded.providers[0].defaultModel, p.defaultModel); });
test('unsupported Chat Completions import is rejected or skipped, never silently changed', () => { const r = importCcSwitch({ name: 'wrong', settingsConfig: { config: 'model_provider="x"\n[model_providers.x]\nbase_url="https://x.example"\nwire_api="chat"', auth: { OPENAI_API_KEY: 'x' } } }); assert.equal(r.providers.length, 0); assert(r.warnings.length); });
test('runtime TOML uses isolated provider env_key rather than embedding API Key', () => { const c = runtimeConfig(provider({ name: 'A "quoted" provider' })); assert.match(c, /env_key = "ASTROGATE_CODEX_KEY"/); assert.match(c, /wire_api = "responses"/); assert.match(c, /requires_openai_auth = false/); assert(!c.includes('OPENAI_API_KEY =')); assert(!c.includes('danger-full-access')); });
test('redaction removes known secrets and bearer strings', () => { assert(!redact('api=secretXYZ and Bearer abc123', ['secretXYZ']).includes('secretXYZ')); assert(!redact('Bearer abc123').includes('abc123')); });
test('actual local HTTP requests verify headers, model catalog and quota mapping', async (t) => { let lastAuth = ''; const server = http.createServer((req, res) => { lastAuth = req.headers.authorization; res.setHeader('Content-Type', 'application/json'); if (req.url === '/v1/models')
    res.end(JSON.stringify({ data: [{ id: 'actual-local-model' }] }));
else if (req.url === '/quota')
    res.end(JSON.stringify({ data: { total: 200, remaining: 54 } }));
else if (req.url === '/empty')
    res.end('{}');
else if (req.url === '/redirect') {
    res.writeHead(302, { Location: '/quota' });
    res.end();
}
else {
    res.writeHead(401);
    res.end('{"error":"bad key"}');
} }); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r))); const base = `http://127.0.0.1:${server.address().port}`; const p = provider({ baseUrl: base + '/v1', usage: { url: base + '/quota', auth: 'provider', totalPath: 'data.total', remainingPath: 'data.remaining' } }); const m = await fetchModels(p, 'fixture-key'); assert.equal(m.models[0].id, 'actual-local-model'); assert.equal(lastAuth, 'Bearer fixture-key'); const u = await fetchUsage(p, 'fixture-key', ''); assert.equal(u.percent, 27); const empty = await fetchUsage({ ...p, usage: { ...p.usage, url: base + '/empty' } }, 'fixture-key', ''); assert.equal(empty.percent, null); await assert.rejects(() => fetchUsage({ ...p, usage: { ...p.usage, url: base + '/redirect' } }, 'fixture-key', '')); await assert.rejects(() => fetchModels({ ...p, baseUrl: base + '/bad' }, 'fixture-key')); });
