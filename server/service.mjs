import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { Store } from './store.mjs';
import { Vault } from './vault.mjs';
import { RpcProcess, resolveCodex } from './rpc.mjs';
import { AppError, assert, id, text, realDirectory, safeId, safeName, atomicWrite, cleanUrl, redact } from './util.mjs';
import { validateProvider, importCcSwitch, exportCcSwitch, runtimeConfig, fetchModels, fetchUsage, EFFORTS } from './providers.mjs';
export class Service extends EventEmitter {
    constructor({ dataDir, appRoot, resourcesPath = '', runtimeFactory = null, native = {} }) {
        super();
        Object.assign(this, { dataDir, appRoot, resourcesPath, runtimeFactory, native });
        this.store = new Store(dataDir);
        this.vault = new Vault(dataDir);
        this.engine = null;
        this.engineProvider = null;
        this.connecting = null;
        this.running = null;
        this.approvals = new Map();
        this.logs = [];
        this.usage = new Map();
        this.modelCatalog = new Map();
        this.loaded = new Set();
        this.closing = false;
    }
    get data() { return this.store.data; }
    log(message) { const row = { time: Date.now(), text: this.sanitize(message) }; this.logs.push(row); if (this.logs.length > 200)
        this.logs.shift(); this.emit('event', { type: 'log', row }); }
    sanitize(value) { try {
        return redact(value, this.vault.secrets());
    }
    catch {
        return '[日志已隐藏：凭据库无法解密，请检查本地数据]';
    } }
    event(type, payload = {}) { this.emit('event', { type, ...payload }); }
    changed() { this.store.save(); this.event('state'); }
    provider(providerId = this.data.activeProviderId) { const p = this.data.providers.find(p => p.id === providerId); assert(p, '供应商不存在', 404); return p; }
    home(providerId) { return path.join(this.dataDir, 'codex-homes', safeId(providerId)); }
    requireOfficialLogin(provider) {
        // Fixture runtimes do not persist a real Codex auth file. Production
        // always uses the isolated file-backed CODEX_HOME configured below.
        if (provider.kind !== 'official' || this.runtimeFactory)
            return;
        if (!this.officialLoggedIn(provider))
            throw new AppError('OpenAI 官方尚未登录。请前往「设置 → 模型供应商」，在 OpenAI 官方的更多菜单选择“官方登录”，完成授权后再发送。', 401, 'OFFICIAL_LOGIN_REQUIRED');
    }
    officialLoggedIn(provider) {
        if (provider.kind !== 'official')
            return null;
        try {
            const auth = JSON.parse(fs.readFileSync(path.join(this.home(provider.id), 'auth.json'), 'utf8'));
            return !!auth?.tokens && typeof auth.tokens === 'object' && Object.keys(auth.tokens).length > 0;
        }
        catch {
            return false;
        }
    }
    snapshot() {
        return { ...structuredClone(this.data), providers: this.data.providers.map(p => ({ ...p, hasKey: this.vault.has('provider:' + p.id), hasUsageKey: this.vault.has('usage:' + p.id), officialLoggedIn: this.officialLoggedIn(p) })),
            engine: { connected: !!this.engine?.ready, providerId: this.engineProvider, connecting: !!this.connecting }, running: this.running ? { ...this.running } : null,
            approvals: [...this.approvals.values()].map(x => ({ id: x.id, method: x.method, params: x.params })), usage: Object.fromEntries(this.usage),
            runtime: { platform: process.platform, arch: process.arch, node: process.versions.node, dataDir: this.dataDir, expectedCodex: '0.162.1', native: !!this.native.pickDirectory }, logs: this.logs };
    }
    async saveProvider(input) {
        assert(input && typeof input === 'object', '无效的供应商');
        const old = input.id ? this.data.providers.find(x => x.id === input.id) : null;
        if (old && this.running?.providerId === old.id)
            throw new AppError('任务运行中不能修改它的供应商');
        const provider = validateProvider({ ...input, id: old?.id || id('p-') }, old || {});
        if (input.apiKey !== undefined && input.apiKey !== '')
            this.vault.set('provider:' + provider.id, text(input.apiKey, 'API Key', 16000).trim());
        if (input.clearKey === true)
            this.vault.set('provider:' + provider.id, '');
        if (input.usageKey !== undefined && input.usageKey !== '')
            this.vault.set('usage:' + provider.id, text(input.usageKey, '额度 Key', 16000).trim());
        if (input.clearUsageKey === true)
            this.vault.set('usage:' + provider.id, '');
        if (old)
            this.data.providers[this.data.providers.indexOf(old)] = provider;
        else
            this.data.providers.push(provider);
        if (this.engineProvider === provider.id)
            await this.disconnect();
        this.modelCatalog.delete(provider.id);
        this.usage.delete(provider.id);
        this.changed();
        return { id: provider.id };
    }
    async selectProvider(providerId) { this.provider(providerId); if (this.running)
        throw new AppError('请等待当前任务完成或先停止，再切换供应商'); await this.disconnect(); this.data.activeProviderId = providerId; this.data.settings.model = this.provider(providerId).defaultModel; this.changed(); }
    async deleteProvider(providerId) { this.provider(providerId); assert(!this.running, '任务运行中不能移除供应商'); assert(this.data.providers.length > 1, '至少保留一个供应商'); assert(!this.data.sessions.some(s => s.providerId === providerId), '该供应商仍有会话记录；为保护历史，不能删除，可编辑其配置'); if (this.engineProvider === providerId)
        await this.disconnect(); this.data.providers = this.data.providers.filter(p => p.id !== providerId); this.vault.set('provider:' + providerId, ''); this.vault.set('usage:' + providerId, ''); if (this.data.activeProviderId === providerId)
        this.data.activeProviderId = this.data.providers[0].id; this.changed(); }
    async importProviders(raw) { const result = importCcSwitch(raw); const ids = []; for (const input of result.providers) {
        try {
            ids.push((await this.saveProvider(input)).id);
        }
        catch (e) {
            result.warnings.push(`${input.name}：${this.sanitize(e.message)}`);
        }
    } return { count: ids.length, ids, warnings: result.warnings }; }
    async importLive() { const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'); const configPath = path.join(home, 'config.toml'); assert(fs.existsSync(configPath), '没有找到当前用户的 Codex config.toml'); let auth = {}; const ap = path.join(home, 'auth.json'); if (fs.existsSync(ap)) {
        try {
            auth = JSON.parse(fs.readFileSync(ap, 'utf8'));
        }
        catch {
            throw new AppError('本机 auth.json 无法解析，未导入');
        }
    } return this.importProviders({ name: '本机 Codex 中转', settingsConfig: { config: fs.readFileSync(configPath, 'utf8'), auth } }); }
    exportProvider(providerId, includeKey = false, confirmed = false) { const p = this.provider(providerId); assert(p.kind === 'relay', '仅导出中转供应商'); assert(!includeKey || confirmed, '导出明文 Key 需要确认'); return exportCcSwitch(p, includeKey ? this.vault.get('provider:' + p.id) : ''); }
    async modelTest(providerId) { assert(!this.running, '任务运行中不能刷新供应商配置'); const p = this.provider(providerId), key = this.vault.get('provider:' + p.id); assert(key, '请先填写 API Key'); const result = await fetchModels(p, key); p.models = result.models; this.modelCatalog.delete(p.id); this.changed(); return result; }
    async usageRead(providerId) {
        const p = this.provider(providerId);
        let result;
        try {
            if (p.kind === 'official') {
                assert(this.engine?.ready && this.engineProvider === p.id, '官方额度需要先连接并登录内核');
                const raw = await this.engine.request('account/rateLimits/read', {});
                const buckets = raw.rateLimitsByLimitId ? Object.values(raw.rateLimitsByLimitId) : [raw.rateLimits].filter(Boolean);
                const windows = buckets.flatMap(bucket => ['primary', 'secondary'].map(k => ({ bucket: bucket.limitName || bucket.limitId || 'Codex', window: k, ...bucket[k] })).filter(w => Number.isFinite(w.usedPercent)));
                result = { percent: windows.length ? Math.max(0, Math.min(...windows.map(w => 100 - w.usedPercent))) : null, windows, updatedAt: Date.now(), reason: windows.length ? '' : '服务端未返回额度数据' };
            }
            else
                result = await fetchUsage(p, this.vault.get('provider:' + p.id), this.vault.get('usage:' + p.id));
        }
        catch (e) {
            result = { percent: null, reason: this.sanitize(e.message), updatedAt: Date.now() };
        }
        this.usage.set(p.id, result);
        this.event('usage', { providerId: p.id, usage: result });
        return result;
    }
    async connect(providerId = this.data.activeProviderId) {
        if (this.engine?.ready && this.engineProvider === providerId)
            return this.snapshot().engine;
        assert(!this.running || this.running.providerId === providerId, '另一个供应商正在运行任务');
        if (this.connecting) {
            await this.connecting;
            if (this.engineProvider === providerId && this.engine?.ready)
                return this.snapshot().engine;
            throw new AppError('另一个供应商正在连接，请稍后重试');
        }
        this.connecting = this._connect(providerId);
        try {
            return await this.connecting;
        }
        finally {
            this.connecting = null;
            this.event('state');
        }
    }
    async _connect(providerId) {
        const provider = this.provider(providerId);
        const key = this.vault.get('provider:' + provider.id);
        assert(provider.kind !== 'relay' || key, '请在「设置 → 模型供应商」填写中转 API Key');
        await this.disconnect(false);
        const home = this.home(provider.id);
        fs.mkdirSync(home, { recursive: true, mode: 0o700 });
        const env = { ...process.env, CODEX_HOME: home };
        delete env.OPENAI_API_KEY;
        delete env.CODEX_API_KEY;
        delete env.OPENAI_BASE_URL;
        if (provider.kind === 'relay')
            env.ASTROGATE_CODEX_KEY = key;
        else
            delete env.ASTROGATE_CODEX_KEY;
        const mcpEnvs = {};
        for (const m of this.data.mcp.filter(m => m.enabled)) {
            if (m.hasToken)
                env['ASTROGATE_MCP_' + m.id.replace(/-/g, '_')] = this.vault.get('mcp-token:' + m.id);
            if (m.hasEnv)
                mcpEnvs[m.id] = JSON.parse(this.vault.get('mcp-env:' + m.id) || '{}');
        }
        atomicWrite(path.join(home, 'config.toml'), runtimeConfig(provider, this.data.mcp, mcpEnvs));
        this.syncSkills(home);
        const command = this.runtimeFactory ? {} : resolveCodex({ override: this.data.settings.codexPath, appRoot: this.appRoot, resourcesPath: this.resourcesPath });
        if (command.nodeMode)
            env.ELECTRON_RUN_AS_NODE = '1';
        const engine = this.runtimeFactory ? this.runtimeFactory({ env, cwd: home }) : new RpcProcess({ ...command, env, cwd: home });
        this.engine = engine;
        this.engineProvider = provider.id;
        this.loaded.clear();
        engine.on('notification', message => { try {
            this.notification(provider.id, message);
        }
        catch (e) {
            this.log(`事件处理失败：${e.message}`);
        } });
        engine.on('request', message => this.serverRequest(provider.id, message));
        engine.on('diagnostic', message => this.log(message));
        engine.on('problem', message => this.log(message));
        engine.on('closed', message => { if (this.engine !== engine)
            return; this.log(message); this.approvals.clear(); this.loaded.clear(); if (this.running) {
            const s = this.store.session(this.running.sessionId);
            s.status = 'interrupted';
            s.items.push({ id: id('sys-'), type: 'system', text: '内核连接断开。任务未自动重发，请确认项目文件状态后继续。' });
            this.store.saveSession(s, true);
            this.running = null;
        } this.event('state'); });
        this.event('state');
        try {
            await engine.start();
            this.log('Codex App Server 已连接：' + provider.name);
            this.event('state');
            return { connected: true, providerId: provider.id };
        }
        catch (e) {
            await engine.close();
            this.engine = null;
            this.engineProvider = null;
            throw e;
        }
    }
    async disconnect(checkBusy = true) { if (checkBusy)
        assert(!this.running, '任务运行中不能断开内核，请先停止'); const engine = this.engine; this.engine = null; this.engineProvider = null; this.loaded.clear(); this.approvals.clear(); if (engine)
        await engine.close(); this.event('state'); }
    async engineModels(providerId) {
        await this.connect(providerId);
        let cursor = null, all = [];
        const seen = new Set();
        do {
            const result = await this.engine.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
            all.push(...(result.data || []));
            cursor = result.nextCursor;
            if (cursor) {
                assert(!seen.has(cursor), '模型目录分页游标重复');
                seen.add(cursor);
            }
        } while (cursor && all.length < 1000);
        const models = all.map(m => ({ id: m.model || m.id, label: m.displayName || m.model || m.id, efforts: (m.supportedReasoningEfforts || []).map(e => e.reasoningEffort), defaultEffort: m.defaultReasoningEffort, source: 'codex' }));
        this.modelCatalog.set(providerId, models);
        return { models };
    }
    async login(providerId) { assert(this.provider(providerId).kind === 'official', '中转使用 API Key，不需要官方登录'); await this.connect(providerId); return this.engine.request('account/login/start', { type: 'chatgpt' }); }
    async importAuth(providerId) { assert(this.provider(providerId).kind === 'official', '只能向官方供应商导入官方登录'); assert(!this.running, '任务运行中不能导入登录'); await this.disconnect(); const source = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json'); assert(fs.existsSync(source), '未找到本机 Codex auth.json，请先在官方 Codex CLI 登录'); const raw = fs.readFileSync(source, 'utf8'); let parsed; try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new AppError('auth.json 无法解析');
    } assert(parsed.tokens, '该 auth.json 不包含官方登录 tokens；中转 Key 请使用导入配置'); atomicWrite(path.join(this.home(providerId), 'auth.json'), raw); return { message: '登录态已复制；原文件未修改。副本可能需要重新登录刷新。' }; }
    async setupSandbox() { assert(process.platform === 'win32', '仅 Windows 需要此设置'); await this.connect(); return this.engine.request('windowsSandbox/setupStart', { mode: 'unelevated' }); }
    async saveSettings(input) {
        assert(!this.running, '任务运行中暂不能修改运行设置');
        const s = { ...this.data.settings };
        if (input.theme !== undefined) {
            assert(['light', 'dark', 'system'].includes(input.theme), '无效的外观');
            s.theme = input.theme;
        }
        if (input.codexPath !== undefined)
            s.codexPath = text(input.codexPath, '内核路径', 4096);
        if (input.workspace !== undefined)
            s.workspace = realDirectory(input.workspace);
        if (input.displayName !== undefined)
            s.displayName = text(input.displayName, '显示名称', 40, true);
        if (input.defaultPermission !== undefined) {
            assert(['read-only', 'workspace-write'].includes(input.defaultPermission), '完整访问权限只能在任务开始前显式授权');
            s.defaultPermission = input.defaultPermission;
        }
        if (input.model !== undefined)
            s.model = text(input.model, '模型', 200, true);
        if (input.effort !== undefined) {
            assert(EFFORTS.includes(input.effort), '无效的强度');
            s.effort = input.effort;
        }
        if (input.acceleration !== undefined)
            s.acceleration = input.acceleration === true;
        if (input.codexPath !== undefined)
            await this.disconnect();
        this.data.settings = s;
        this.changed();
        return s;
    }
    saveProject(input) { const existing = input.id ? this.data.projects.find(p => p.id === input.id) : null; const cwd = realDirectory(input.path || existing?.path); assert(!this.data.projects.some(p => p.id !== existing?.id && p.path === cwd), '该目录已经添加'); if (existing)
        assert(!this.running || this.store.session(this.running.sessionId).projectId !== existing.id, '任务运行中不能编辑项目'); const project = { id: existing?.id || id('p-'), name: text(input.name || existing?.name || path.basename(cwd), '项目名称', 100, true), path: cwd, section: text(input.section ?? existing?.section ?? '项目', '分区', 40), pinned: input.pinned ?? existing?.pinned ?? false, createdAt: existing?.createdAt || Date.now() }; if (existing)
        this.data.projects[this.data.projects.indexOf(existing)] = project;
    else
        this.data.projects.push(project); this.changed(); return project; }
    removeProject(projectId) { assert(!this.running || this.store.session(this.running.sessionId).projectId !== projectId, '任务运行中不能移除项目'); assert(this.data.projects.some(x => x.id === projectId), '项目不存在'); this.data.projects = this.data.projects.filter(x => x.id !== projectId); for (const summary of this.data.sessions.filter(s => s.projectId === projectId)) {
        const s = this.store.session(summary.id);
        s.projectId = null;
        this.store.saveSession(s, true);
    } this.changed(); return { message: '只移除了应用内项目关联，没有删除磁盘文件。' }; }
    editSession(input) { const s = this.store.session(input.id); assert(this.running?.sessionId !== s.id, '任务运行中不能归档或编辑会话'); if (input.title !== undefined)
        s.title = text(input.title, '会话名称', 120, true); if (input.pinned !== undefined)
        s.pinned = !!input.pinned; if (input.archived !== undefined)
        s.archived = !!input.archived; this.store.saveSession(s, true); this.event('state'); return s; }
    archiveProject(projectId) { assert(!this.running || this.store.session(this.running.sessionId).projectId !== projectId, '请先停止该项目任务'); for (const s of this.data.sessions.filter(s => s.projectId === projectId))
        this.editSession({ id: s.id, archived: true }); return { ok: true }; }
    async send(input) {
        assert(!this.running, '已有任务正在运行，请先等待或停止');
        const message = text(input.text, '消息', 100000, true).trim();
        const rawAttachments = input.attachments || [];
        assert(Array.isArray(rawAttachments) && rawAttachments.length <= 6, '最多附加 6 个文本文件');
        const attachments = rawAttachments.map(a => ({ name: text(a.name, '附件名称', 200, true), text: text(a.text, '附件内容', 512 * 1024) }));
        assert(attachments.reduce((n, a) => n + Buffer.byteLength(a.text, 'utf8'), 0) <= 3 * 1024 * 1024, '附件内容总共不能超过 3 MiB');
        let s = input.sessionId ? this.store.session(input.sessionId) : null;
        assert(!s?.archived, '请先恢复该归档会话');
        const provider = this.provider(s?.providerId || input.providerId || this.data.activeProviderId);
        this.requireOfficialLogin(provider);
        const project = s?.projectId ? this.data.projects.find(p => p.id === s.projectId) : input.projectId ? this.data.projects.find(p => p.id === input.projectId) : null;
        assert(!input.projectId || project || s, '项目不存在');
        const cwd = realDirectory(s?.cwd || project?.path || this.data.settings.workspace), model = text(input.model || s?.model || provider.defaultModel, '模型', 200, true), effort = input.effort || s?.effort || provider.effort;
        assert(EFFORTS.includes(effort), '无效的推理强度');
        const advertised = this.modelCatalog.get(provider.id)?.find(m => m.id === model);
        if (advertised?.efforts?.length)
            assert(advertised.efforts.includes(effort), `模型目录未声明支持 ${effort}；请选择支持的强度：${advertised.efforts.join(', ')}。未自动降级。`);
        const permission = input.permission || this.data.settings.defaultPermission;
        assert(['read-only', 'workspace-write', 'danger-full-access'].includes(permission), '无效的权限模式');
        if (permission === 'danger-full-access')
            assert(input.fullAccessConfirmed === true, '完整访问权限需在本次任务前确认');
        if (!s)
            s = this.store.createSession({ providerId: provider.id, projectId: project?.id, cwd, model, effort, text: message });
        s.model = model;
        s.effort = effort;
        s.status = 'running';
        s.updatedAt = Date.now();
        const userId = id('user-');
        s.items.push({ id: userId, type: 'userMessage', text: message, attachments, createdAt: Date.now() });
        this.running = { sessionId: s.id, providerId: provider.id, turnId: null, startedAt: Date.now(), stopping: false };
        this.store.saveSession(s, true);
        this.event('state');
        try {
            await this.connect(provider.id);
            if (this.running?.stopping)
                throw new AppError('任务已取消');
            const common = { model, modelProvider: provider.kind === 'relay' ? 'astrogate_relay' : 'openai', cwd, approvalPolicy: permission === 'danger-full-access' ? 'never' : 'on-request', sandbox: permission };
            if (!s.threadId) {
                const result = await this.engine.request('thread/start', common, 90000);
                s.threadId = result.thread.id;
                this.loaded.add(s.threadId);
            }
            else if (!this.loaded.has(s.threadId)) {
                await this.engine.request('thread/resume', { ...common, threadId: s.threadId }, 90000);
                this.loaded.add(s.threadId);
            }
            if (this.running?.stopping)
                throw new AppError('任务已取消');
            const policy = permission === 'danger-full-access' ? { type: 'dangerFullAccess' } : permission === 'read-only' ? { type: 'readOnly', networkAccess: false } : { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
            const result = await this.engine.request('turn/start', { threadId: s.threadId, clientUserMessageId: userId, input: [{ type: 'text', text: message, text_elements: [] }, ...attachments.map(a => ({ type: 'text', text: `用户附加的文本文件：${a.name}\n\n${a.text}`, text_elements: [] }))], model, effort, cwd, approvalPolicy: common.approvalPolicy, sandboxPolicy: policy }, 90000);
            if (this.running?.sessionId === s.id)
                this.running.turnId = result.turn.id;
            this.store.saveSession(s, true);
            this.event('state');
            return { sessionId: s.id, threadId: s.threadId, turnId: result.turn.id };
        }
        catch (e) {
            if (this.running?.sessionId === s.id)
                this.running = null;
            s.status = 'failed';
            s.items.push({ id: id('sys-'), type: 'system', text: this.sanitize(e.message), createdAt: Date.now() });
            this.store.saveSession(s, true);
            this.event('state');
            e.sessionId = s.id;
            throw e;
        }
    }
    async stop() { const running = this.running; if (!running)
        return { ok: true }; running.stopping = true; if (running.turnId && this.engine?.ready) {
        await this.engine.request('turn/interrupt', { threadId: this.store.session(running.sessionId).threadId, turnId: running.turnId });
        return { ok: true };
    } if (this.engine) {
        const engine = this.engine;
        await engine.close();
    } return { ok: true }; }
    notification(providerId, message) {
        const { method, params: p = {} } = message;
        if (method === 'serverRequest/resolved') {
            this.approvals.delete(String(p.requestId));
            this.event('state');
            return;
        }
        if (method === 'account/login/completed') {
            this.event('login', { ...p });
            return;
        }
        if (method === 'account/updated') {
            this.event('account', { ...p });
            return;
        }
        if (method === 'windowsSandbox/setupCompleted') {
            this.event('sandbox', { ...p });
            return;
        }
        let s = this.running?.providerId === providerId ? this.store.session(this.running.sessionId) : null;
        if (p.threadId && s?.threadId && p.threadId !== s.threadId) {
            this.log(`后台线程事件：${method}`);
            return;
        }
        if (!s) {
            if (method === 'error')
                this.log(p.error?.message || JSON.stringify(p));
            return;
        }
        if (method === 'turn/started') {
            if (this.running)
                this.running.turnId = p.turn?.id || null;
        }
        if (method === 'item/started' || method === 'item/completed') {
            const item = p.item;
            if (item && item.type !== 'userMessage') {
                const old = s.items.find(x => x.id === item.id);
                if (old)
                    Object.assign(old, item);
                else
                    s.items.push({ ...item, createdAt: Date.now() });
            }
        }
        else if (method === 'item/agentMessage/delta')
            this.delta(s, p.itemId, 'agentMessage', 'text', p.delta);
        else if (method === 'item/commandExecution/outputDelta')
            this.delta(s, p.itemId, 'commandExecution', 'aggregatedOutput', p.delta);
        else if (method === 'item/reasoning/summaryTextDelta')
            this.delta(s, p.itemId, 'reasoning', 'summaryText', p.delta);
        else if (method === 'turn/plan/updated')
            s.plan = { explanation: p.explanation, plan: p.plan || [] };
        else if (method === 'turn/diff/updated')
            s.diff = p.diff;
        else if (method === 'thread/tokenUsage/updated')
            s.usage = p.tokenUsage;
        else if (method === 'error')
            s.items.push({ id: id('sys-'), type: 'system', text: this.sanitize(p.error?.message || p.message || JSON.stringify(p)), retry: !!p.willRetry });
        else if (method === 'turn/completed') {
            s.status = p.turn?.status || 'completed';
            s.updatedAt = Date.now();
            if (p.turn?.error)
                s.items.push({ id: id('sys-'), type: 'system', text: this.sanitize(p.turn.error.message || JSON.stringify(p.turn.error)) });
            if (this.running?.sessionId === s.id)
                this.running = null;
            this.approvals.clear();
            this.store.saveSession(s, true);
            this.event('state');
        }
        this.store.saveSession(s);
        this.event('session', { sessionId: s.id, session: structuredClone(s) });
    }
    delta(s, itemId, type, field, value) { let item = s.items.find(i => i.id === itemId); if (!item) {
        item = { id: itemId, type, [field]: '', createdAt: Date.now() };
        s.items.push(item);
    } const old = typeof item[field] === 'string' ? item[field] : ''; item[field] = (old + (value || '')).slice(-8 * 1024 * 1024); }
    serverRequest(providerId, message) {
        const allowed = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request'];
        if (!allowed.includes(message.method)) {
            this.engine?.reject(message.id, `AstroGate 未实现 ${message.method}，已拒绝而非自动批准`);
            this.log(`已拒绝未知的服务端请求：${message.method}`);
            return;
        }
        if (this.approvals.size >= 100) {
            this.engine?.reject(message.id, '待审批请求过多');
            return;
        }
        const row = { id: String(message.id), rpcId: message.id, providerId, method: message.method, params: JSON.parse(this.sanitize(message.params || {})) };
        this.approvals.set(row.id, row);
        this.event('approval', { approval: { id: row.id, method: row.method, params: row.params } });
        this.event('state');
    }
    respondApproval(input) {
        const a = this.approvals.get(String(input.id));
        assert(a && this.engine?.ready, '审批已失效，请刷新');
        let result;
        if (a.method === 'item/tool/requestUserInput') {
            const answers = {};
            for (const q of a.params.questions || []) {
                const values = input.answers?.[q.id];
                assert(Array.isArray(values) && values.length > 0 && values.length < 20, `请回答：${q.question || q.header}`);
                answers[q.id] = { answers: values.map(v => text(v, '回答', 4000)) };
            }
            result = { answers };
        }
        else if (a.method === 'item/permissions/requestApproval') {
            result = { permissions: input.accept === true ? a.params.permissions || {} : {}, scope: 'turn' };
        }
        else if (a.method === 'mcpServer/elicitation/request') {
            assert(['accept', 'decline', 'cancel'].includes(input.action), '无效的操作');
            result = { action: input.action, ...(input.action === 'accept' ? { content: input.content || {} } : {}) };
        }
        else {
            assert(['accept', 'decline', 'cancel'].includes(input.decision), '仅支持允许本次、拒绝或取消');
            result = { decision: input.decision };
        }
        this.engine.answer(a.rpcId, result);
        this.approvals.delete(a.id);
        this.event('state');
        return { ok: true };
    }
    async saveMcp(input) {
        assert(!this.running, '请等待当前任务完成再修改插件');
        const old = input.id ? this.data.mcp.find(m => m.id === input.id) : null;
        const name = safeName(input.name);
        assert(!this.data.mcp.some(m => m.name === name && m.id !== old?.id), '插件名称已存在');
        const transport = input.transport;
        assert(['stdio', 'http'].includes(transport), '无效的 MCP 传输方式');
        const plugin = { id: old?.id || id('m-'), name, transport, enabled: input.enabled === true, description: text(input.description || '', '说明', 300), hasToken: old?.hasToken || false, hasEnv: old?.hasEnv || false };
        if (transport === 'http')
            plugin.url = cleanUrl(input.url);
        else {
            plugin.command = text(input.command, '命令', 2000, true);
            assert(Array.isArray(input.args) && input.args.length <= 100, '参数必须为 JSON 字符串数组');
            plugin.args = input.args.map(a => text(a, '参数', 4000));
        }
        if (input.token) {
            this.vault.set('mcp-token:' + plugin.id, text(input.token, '令牌', 16000));
            plugin.hasToken = true;
        }
        if (input.env !== undefined) {
            assert(input.env && typeof input.env === 'object' && !Array.isArray(input.env), '环境变量必须是 JSON 对象');
            for (const [k, v] of Object.entries(input.env)) {
                assert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(k), '环境变量名不正确');
                text(v, '环境变量值', 16000);
            }
            this.vault.set('mcp-env:' + plugin.id, JSON.stringify(input.env));
            plugin.hasEnv = Object.keys(input.env).length > 0;
        }
        if (old)
            this.data.mcp[this.data.mcp.indexOf(old)] = plugin;
        else
            this.data.mcp.push(plugin);
        await this.disconnect();
        this.changed();
        return plugin;
    }
    async removeMcp(pluginId) { assert(!this.running, '请先停止任务'); this.data.mcp = this.data.mcp.filter(m => m.id !== pluginId); this.vault.set('mcp-token:' + pluginId, ''); this.vault.set('mcp-env:' + pluginId, ''); await this.disconnect(); this.changed(); }
    async toggleMcp(pluginId, enabled) { assert(!this.running, '请先停止任务'); const m = this.data.mcp.find(m => m.id === pluginId); assert(m, '插件不存在'); m.enabled = enabled === true; await this.disconnect(); this.changed(); }
    async mcpStatus() { assert(this.engine?.ready, '请先连接内核'); return this.engine.request('mcpServerStatus/list', { limit: 100 }); }
    saveSkill(input) { assert(!this.running, '请等待任务完成再修改技能'); const name = safeName(input.name); const content = text(input.content, 'SKILL.md', 200000, true); assert(content.startsWith('---\n') || content.startsWith('---\r\n'), 'SKILL.md 需要 YAML 前置信息（--- 开头）'); const exists = this.data.skills.find(s => s.name === name); if (!exists)
        this.data.skills.push({ name, enabled: true }); atomicWrite(path.join(this.dataDir, 'skills', name, 'SKILL.md'), content); for (const p of this.data.providers)
        if (fs.existsSync(this.home(p.id)))
            this.syncSkills(this.home(p.id)); this.changed(); return { name }; }
    readSkill(name) { safeName(name); assert(this.data.skills.some(s => s.name === name), '技能不存在'); return { name, content: fs.readFileSync(path.join(this.dataDir, 'skills', name, 'SKILL.md'), 'utf8') }; }
    removeSkill(name) { assert(!this.running, '请先停止任务'); safeName(name); this.data.skills = this.data.skills.filter(s => s.name !== name); const f = path.join(this.dataDir, 'skills', name, 'SKILL.md'); if (fs.existsSync(f))
        fs.unlinkSync(f); for (const p of this.data.providers) {
        const managed = path.join(this.home(p.id), 'skills', 'astrogate-' + name, 'SKILL.md');
        if (fs.existsSync(managed))
            fs.unlinkSync(managed);
    } this.changed(); }
    syncSkills(home) { for (const s of this.data.skills.filter(x => x.enabled)) {
        const source = path.join(this.dataDir, 'skills', safeName(s.name), 'SKILL.md');
        if (fs.existsSync(source))
            atomicWrite(path.join(home, 'skills', 'astrogate-' + s.name, 'SKILL.md'), fs.readFileSync(source));
    } }
    async listApps() { await this.connect(); return this.engine.request('app/list', { limit: 100, forceRefetch: true }); }
    exportData() { return { format: 'astrogate-redacted-export', version: 1, exportedAt: new Date().toISOString(), ...structuredClone(this.data), sessions: this.data.sessions.map(s => structuredClone(this.store.session(s.id))), warning: '不含 API Key、官方登录态或 MCP 凭据；可能含私有项目路径、对话和代码，请谨慎分享。' }; }
    async close() { if (this.closing)
        return; this.closing = true; if (this.running) {
        try {
            await this.stop();
        }
        catch { }
    } this.store.flush(); await this.disconnect(false); this.store.flush(); }
}
