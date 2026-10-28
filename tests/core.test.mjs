import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import http from 'node:http';
import { Vault } from '../server/vault.mjs';
import { Store } from '../server/store.mjs';
import { markdown } from '../web/markdown.js';
import { createServer } from '../server/index.mjs';
import { temp, fixture, makeService, waitUntil } from './helpers.mjs';
const cleanup = s => { fs.rmSync(s.dataDir, { recursive: true, force: true }); };
test('vault encrypts at rest, survives reload and detects tampering', () => { const dir = temp(); try {
    const v = new Vault(dir);
    v.set('provider:test', 'very-secret-fixture-key');
    const raw = fs.readFileSync(path.join(dir, 'vault.json'), 'utf8');
    assert(!raw.includes('very-secret-fixture-key'));
    assert.equal(new Vault(dir).get('provider:test'), 'very-secret-fixture-key');
    v.data['provider:other'] = { ...v.data['provider:test'] };
    assert.throws(() => v.get('provider:other'));
    delete v.data['provider:other'];
    v.set('mcp-env:m', JSON.stringify({ TOKEN: 'env-secret-fixture' }));
    assert(v.secrets().includes('env-secret-fixture'));
    v.set('provider:test', '');
    assert(!v.has('provider:test'));
}
finally {
    fs.rmSync(dir, { recursive: true, force: true });
} });
test('Markdown escapes untrusted HTML and only renders http(s) links', () => { const html = markdown('<script>alert(1)</script>\n[click](javascript:alert(1))\n```html\n<img src=x onerror=alert(1)>\n```'); assert(!html.includes('<script>')); assert(!html.includes('href="javascript:')); assert(!html.includes('<img ')); assert(html.includes('data-action="copy-code"')); });
test('RPC handshake, split UTF-8 notifications, reverse response and timeout', async (t) => { const rpc = fixture(); t.after(() => rpc.close()); await rpc.start(); assert.deepEqual(await rpc.request('ping', { x: 1 }), { echo: { x: 1 } }); const event = once(rpc, 'notification'); await rpc.request('split-utf8', {}); assert.equal((await event)[0].params.text, '中文🦊输出'); rpc.on('request', m => rpc.reject(m.id, 'unsupported')); const unknown = await rpc.request('ask-unknown'); assert.equal(unknown.error.code, -32601); await assert.rejects(() => rpc.request('hang', {}, 40), /超时/); });
test('RPC crash rejects pending calls and marks process disconnected', async () => { const rpc = fixture(); await rpc.start(); await assert.rejects(() => rpc.request('crash'), /退出/); assert.equal(rpc.ready, false); await rpc.close(); });
test('project, provider and skill persistence; secrets not in state or runtime config', async () => { const s = makeService(); try {
    const { id } = await s.saveProvider({ name: 'Relay', kind: 'relay', baseUrl: 'https://relay.example/v1', apiKey: 'relay-secret-fixture' });
    const p = s.saveProject({ path: s.data.settings.workspace, name: '我的项目' });
    assert.throws(() => s.saveProject({ path: p.path, name: 'duplicate' }));
    s.saveSkill({ name: 'code-review', content: '---\nname: code-review\ndescription: test\n---\nReview code.' });
    await s.selectProvider(id);
    await s.connect(id);
    const snapshot = JSON.stringify(s.snapshot());
    assert(!snapshot.includes('relay-secret-fixture'));
    assert(!fs.readFileSync(path.join(s.home(id), 'config.toml'), 'utf8').includes('relay-secret-fixture'));
    assert(fs.existsSync(path.join(s.home(id), 'skills', 'astrogate-code-review', 'SKILL.md')));
    s.removeProject(p.id);
    assert(fs.existsSync(p.path));
    assert(!s.exportData().vault);
}
finally {
    await s.close();
    cleanup(s);
} });
test('settings save the default full-access mode and remain transactional on invalid input', async () => { const s = makeService(); try {
    assert.equal(s.data.settings.defaultPermission, 'danger-full-access');
    await s.saveSettings({ theme: 'dark', defaultPermission: 'workspace-write' });
    await assert.rejects(() => s.saveSettings({ theme: 'light', defaultPermission: 'invalid' }));
    assert.equal(s.data.settings.theme, 'dark');
    assert.equal(s.data.settings.defaultPermission, 'workspace-write');
}
finally {
    await s.close();
    cleanup(s);
} });
test('complete task, text attachment, history reload and resume through real child transport', async () => { const s = makeService(); try {
    const p = s.saveProject({ path: s.data.settings.workspace, name: 'Project' });
    const r = await s.send({ text: '检查项目', projectId: p.id, model: 'fixture-model', effort: 'high', attachments: [{ name: 'hello.txt', text: '附加内容' }] });
    await waitUntil(() => !s.running);
    let session = s.store.session(r.sessionId);
    assert.equal(session.status, 'completed');
    assert.equal(session.items[0].attachments[0].text, '附加内容');
    assert(session.items.some(i => i.type === 'agentMessage' && i.text.includes('测试夹具')));
    assert.equal(session.usage.total.totalTokens, 123);
    await s.disconnect();
    await s.send({ sessionId: r.sessionId, text: '继续', model: 'fixture-model', effort: 'ultra' });
    await waitUntil(() => !s.running);
    assert.equal(session.items.filter(i => i.type === 'userMessage').length, 2);
    s.editSession({ id: session.id, archived: true });
    await assert.rejects(() => s.send({ sessionId: session.id, text: '归档测试' }), /归档/);
    s.editSession({ id: session.id, archived: false });
    const now = session.updatedAt;
    s.store.session(session.id);
    assert.equal(session.updatedAt, now);
}
finally {
    await s.close();
    cleanup(s);
} });
test('approval blocks until explicit choice, provider edits blocked mid-turn and stop works', async () => { const s = makeService(); try {
    await s.saveSettings({ defaultPermission: 'workspace-write' });
    const r = await s.send({ text: '[approve]', model: 'fixture-model', effort: 'high' });
    await waitUntil(() => s.approvals.size === 1);
    assert(s.running);
    await assert.rejects(() => s.selectProvider('official'), /等待/);
    const a = [...s.approvals.values()][0];
    s.respondApproval({ id: a.id, decision: 'decline' });
    await waitUntil(() => !s.running);
    assert.equal(s.store.session(r.sessionId).status, 'interrupted');
    await s.send({ text: '[hold]', model: 'fixture-model', effort: 'high' });
    assert(s.running);
    await s.stop();
    await waitUntil(() => !s.running);
}
finally {
    await s.close();
    cleanup(s);
} });
test('full access auto-approves command requests and unsupported effort is not downgraded', async () => { const s = makeService(); try {
    await s.engineModels('official');
    await assert.rejects(() => s.send({ text: 'x', model: 'fixture-model', effort: 'low' }), /未自动降级/);
    const r = await s.send({ text: '[approve]', model: 'fixture-model', effort: 'ultra', permission: 'danger-full-access' });
    await waitUntil(() => !s.running);
    assert.equal(s.approvals.size, 0);
    assert.equal(s.store.session(r.sessionId).status, 'completed');
}
finally {
    await s.close();
    cleanup(s);
} });
test('official provider requires an isolated official login before creating a turn', async () => { const s = makeService(); try {
    s.runtimeFactory = null;
    assert.equal(s.snapshot().providers.find(p => p.id === 'official').officialLoggedIn, false);
    await assert.rejects(() => s.send({ text: '需要登录' }), e => e.code === 'OFFICIAL_LOGIN_REQUIRED' && /官方尚未登录/.test(e.message));
    assert.equal(s.data.sessions.length, 0);
}
finally {
    await s.close();
    cleanup(s);
} });
test('restart marks interrupted tasks without auto-resending', () => { const dir = temp(); try {
    const first = new Store(dir), s = first.createSession({ providerId: 'official', cwd: first.data.settings.workspace, model: 'test', effort: 'high', text: 'pending' });
    s.status = 'running';
    first.saveSession(s, true);
    const second = new Store(dir);
    assert.equal(second.session(s.id).status, 'interrupted');
    assert(second.session(s.id).items[0].text.includes('未自动重发'));
}
finally {
    fs.rmSync(dir, { recursive: true, force: true });
} });
test('localhost HTTP API requires capability, rejects cross-origin/Host and protects filesystem', async () => { const dir = temp(); const b = await createServer({ dataDir: dir, runtimeFactory: fixture }); try {
    const headers = { 'X-AstroGate-Token': b.token };
    assert.equal((await fetch(b.baseUrl + '/api/state')).status, 401);
    assert.equal((await fetch(b.baseUrl + '/api/state', { headers })).status, 200);
    assert.equal((await fetch(b.baseUrl + '/api/state', { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
    assert.equal(await new Promise((resolve, reject) => http.get(b.baseUrl + '/api/state', { headers: { ...headers, Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject)), 403);
    assert.equal((await fetch(b.baseUrl + '/../server/service.mjs')).status, 404);
    const r = await fetch(b.baseUrl + '/api/settings', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: 'dark' }) });
    assert.equal(r.status, 200);
    assert.equal(b.service.data.settings.theme, 'dark');
    await assert.rejects(() => createServer({ dataDir: dir }), /已有/);
    assert.match((await fetch(b.baseUrl + '/')).headers.get('content-security-policy'), /frame-ancestors 'none'/);
}
finally {
    await b.close();
    fs.rmSync(dir, { recursive: true, force: true });
} });
test('authenticated HTTP SSE delivers notifications and disconnects cleanly', async () => { const dir = temp(), b = await createServer({ dataDir: dir, runtimeFactory: fixture }); const abort = new AbortController(); try {
    const r = await fetch(b.baseUrl + '/api/events', { headers: { 'X-AstroGate-Token': b.token }, signal: abort.signal });
    assert.equal(r.status, 200);
    const reader = r.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert(first.includes('"type":"ready"'));
    b.service.event('fixture-sse', { text: 'stream event 中文' });
    const second = await Promise.race([reader.read(), new Promise((_, reject) => setTimeout(() => reject(new Error('SSE event timed out')), 1500))]);
    assert(new TextDecoder().decode(second.value).includes('stream event 中文'));
    await reader.cancel();
}
finally {
    abort.abort();
    await b.close();
    fs.rmSync(dir, { recursive: true, force: true });
} });
test('fresh service without configured native runtime fails clearly instead of fabricating a reply', async () => { const s = makeService(); try {
    s.runtimeFactory = null;
    fs.mkdirSync(s.home('official'), { recursive: true });
    fs.writeFileSync(path.join(s.home('official'), 'auth.json'), JSON.stringify({ tokens: { access_token: 'fixture-token' } }));
    await s.saveSettings({ codexPath: path.join(s.dataDir, 'definitely-missing-codex') });
    await assert.rejects(() => s.send({ text: 'Check project' }), /路径必须/);
    assert.equal(s.data.sessions.length, 1);
    const session = s.store.session(s.data.sessions[0].id);
    assert.equal(session.status, 'failed');
    assert(!session.items.some(i => i.type === 'agentMessage'));
    assert.equal(s.running, null);
}
finally {
    await s.close();
    cleanup(s);
} });
