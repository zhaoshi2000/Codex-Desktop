// TEST FIXTURE ONLY. Production never selects this process automatically.
// Exercises the transport and UI without downloading Codex or calling a model.
import readline from 'node:readline';
import assert from 'node:assert/strict';
const input = readline.createInterface({ input: process.stdin });
let initialized = false, thread = 'fixture-thread', turn = 0, pending = new Map(), timer = null;
const out = m => process.stdout.write(JSON.stringify(m) + '\n');
const reply = (id, result) => out({ id, result });
const event = (method, params) => out({ method, params });
const complete = (id, status = 'completed') => { event('item/completed', { threadId: thread, item: { id: 'assistant-' + id, type: 'agentMessage', text: '测试夹具回复：真实模型尚未接入。\n\n```js\nconsole.log("fixture");\n```' } }); event('thread/tokenUsage/updated', { threadId: thread, tokenUsage: { total: { totalTokens: 123 }, last: { totalTokens: 123 } } }); event('turn/completed', { threadId: thread, turn: { id, status, error: null } }); };
input.on('line', async (line) => {
    try {
        const m = JSON.parse(line);
        if (!m.method) {
            const p = pending.get(String(m.id));
            if (p) {
                pending.delete(String(m.id));
                p(m);
            }
            return;
        }
        const p = m.params || {};
        if (m.method === 'initialize') {
            assert.equal(p.clientInfo.name, 'astrogate_codex_desktop');
            assert.equal(p.capabilities.experimentalApi, true);
            return reply(m.id, { userAgent: 'fixture-0.162.1', platformFamily: 'fixture' });
        }
        if (m.method === 'initialized') {
            initialized = true;
            return;
        }
        assert(initialized, 'must initialize first');
        switch (m.method) {
            case 'ping':
                reply(m.id, { echo: p });
                break;
            case 'hang': break;
            case 'crash':
                process.exit(9);
                break;
            case 'split-utf8': {
                reply(m.id, {});
                const data = Buffer.from(JSON.stringify({ method: 'fixture/unicode', params: { text: '中文🦊输出' } }) + '\n');
                const i = data.indexOf(Buffer.from('中文')) + 2;
                process.stdout.write(data.subarray(0, i));
                setTimeout(() => process.stdout.write(data.subarray(i)), 5);
                break;
            }
            case 'ask-unknown':
                out({ id: 'unknown-reverse', method: 'future/unsupported', params: {} });
                pending.set('unknown-reverse', m2 => reply(m.id, m2));
                break;
            case 'model/list':
                reply(m.id, { data: [{ id: 'fixture-model', model: 'fixture-model', displayName: 'Fixture model · 测试', supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'ultra' }], defaultReasoningEffort: 'high' }], nextCursor: null });
                break;
            case 'thread/start':
                assert(['read-only', 'workspace-write', 'danger-full-access'].includes(p.sandbox));
                assert(p.cwd);
                reply(m.id, { thread: { id: thread, turns: [] } });
                break;
            case 'thread/resume':
                assert.equal(p.threadId, thread);
                reply(m.id, { thread: { id: thread, turns: [] } });
                break;
            case 'turn/start': {
                assert.equal(p.threadId, thread);
                assert.equal(p.input[0].type, 'text');
                assert(Array.isArray(p.input[0].text_elements));
                assert(p.sandboxPolicy.type);
                const t = 'turn-' + (++turn);
                reply(m.id, { turn: { id: t, status: 'inProgress' } });
                event('turn/started', { threadId: thread, turn: { id: t, status: 'inProgress' } });
                if (p.input[0].text === '[hold]')
                    return;
                const begin = () => { event('item/started', { threadId: thread, item: { id: 'assistant-' + t, type: 'agentMessage', text: '' } }); event('item/agentMessage/delta', { threadId: thread, itemId: 'assistant-' + t, delta: '测试夹具回复：' }); timer = setTimeout(() => complete(t), 80); };
                if (p.input[0].text.includes('[approve]')) {
                    out({ id: 'approval-' + t, method: 'item/commandExecution/requestApproval', params: { threadId: thread, turnId: t, itemId: 'cmd-' + t, command: 'echo fixture-only', cwd: p.cwd, reason: '协议测试：不执行真实命令' } });
                    pending.set('approval-' + t, m2 => { if (m2.result?.decision === 'accept')
                        begin();
                    else
                        complete(t, 'interrupted'); });
                }
                else
                    begin();
                break;
            }
            case 'turn/interrupt':
                clearTimeout(timer);
                reply(m.id, {});
                complete(p.turnId, 'interrupted');
                break;
            case 'account/rateLimits/read':
                reply(m.id, { rateLimits: { limitName: 'Fixture quota', primary: { usedPercent: 73, windowDurationMins: 300 }, secondary: null } });
                break;
            case 'account/login/start':
                reply(m.id, { type: 'chatgpt', authUrl: 'https://example.invalid/fixture-login' });
                break;
            case 'mcpServerStatus/list':
                reply(m.id, { data: [], nextCursor: null });
                break;
            case 'app/list':
                reply(m.id, { data: [], nextCursor: null });
                break;
            default: out({ id: m.id, error: { code: -32601, message: 'Unimplemented fixture method ' + m.method } });
        }
    }
    catch (e) {
        process.stderr.write('Fixture assertion: ' + e.message + '\n');
        try {
            const m = JSON.parse(line);
            out({ id: m.id, error: { code: -32602, message: e.message } });
        }
        catch { }
    }
});
input.on('close', () => process.exit(0));
