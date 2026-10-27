import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite, readJson, safeId, id, AppError } from './util.mjs';
import { SCREENSHOT_MODELS } from './providers.mjs';
export class Store {
    constructor(dir) {
        this.dir = dir;
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        this.file = path.join(dir, 'state.json');
        this.data = readJson(this.file, {
            version: 1, activeProviderId: 'official',
            settings: { theme: 'light', codexPath: '', workspace: path.join(dir, 'workspace'), defaultPermission: 'workspace-write', effort: 'high', model: 'gpt-6-sol', acceleration: false, displayName: '开发者' },
            providers: [{ id: 'official', name: 'OpenAI 官方', kind: 'official', baseUrl: '', defaultModel: 'gpt-6-sol', effort: 'high', models: structuredClone(SCREENSHOT_MODELS), notes: '在本应用隔离环境中登录，或显式导入本机 Codex 登录态', usage: null, createdAt: Date.now() }],
            projects: [], sessions: [], mcp: [], skills: []
        });
        if (this.data.version !== 1)
            throw new AppError('不兼容的数据版本，请使用匹配的软件版本', 500);
        this.sessions = new Map();
        this.timers = new Map();
        fs.mkdirSync(this.data.settings.workspace, { recursive: true, mode: 0o700 });
        for (const summary of this.data.sessions)
            if (summary.status === 'running') {
                const s = this.session(summary.id);
                s.status = 'interrupted';
                s.items.push({ id: id('sys-'), type: 'system', text: '上次客户端已关闭，任务未自动重发。请确认文件状态后继续。', createdAt: Date.now() });
                this.saveSession(s, true);
            }
        this.save();
    }
    save() { atomicWrite(this.file, JSON.stringify(this.data, null, 2)); }
    session(sessionId) {
        safeId(sessionId);
        if (!this.data.sessions.some(s => s.id === sessionId))
            throw new AppError('会话不存在', 404);
        if (!this.sessions.has(sessionId))
            this.sessions.set(sessionId, readJson(path.join(this.dir, 'sessions', sessionId + '.json'), null));
        const s = this.sessions.get(sessionId);
        if (!s)
            throw new AppError('会话内容文件不存在，索引未删除', 500);
        return s;
    }
    createSession({ providerId, projectId, cwd, model, effort, text }) {
        const now = Date.now();
        const s = { id: id('s-'), threadId: null, providerId, projectId: projectId || null, cwd, model, effort, title: text.trim().split('\n')[0].slice(0, 60) || '新会话', createdAt: now, updatedAt: now, archived: false, pinned: false, status: 'idle', items: [], usage: null, plan: null };
        this.data.sessions.push(this.summary(s));
        this.sessions.set(s.id, s);
        this.saveSession(s, true);
        return s;
    }
    summary(s) { const { id, threadId, providerId, projectId, cwd, model, effort, title, createdAt, updatedAt, archived, pinned, status } = s; return { id, threadId, providerId, projectId, cwd, model, effort, title, createdAt, updatedAt, archived, pinned, status }; }
    saveSession(s, immediate = false) {
        const i = this.data.sessions.findIndex(x => x.id === s.id);
        if (i !== -1)
            this.data.sessions[i] = this.summary(s);
        const write = () => { this.timers.delete(s.id); atomicWrite(path.join(this.dir, 'sessions', s.id + '.json'), JSON.stringify(s, null, 2)); this.save(); };
        if (immediate) {
            clearTimeout(this.timers.get(s.id));
            write();
        }
        else if (!this.timers.has(s.id))
            this.timers.set(s.id, setTimeout(write, 180));
    }
    flush() { for (const key of [...this.timers.keys()])
        this.saveSession(this.session(key), true); this.save(); }
}
