import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AppError } from './util.mjs';
const triples = { 'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc', 'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl', 'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin' };
function nativeFromNodeModules(root) {
    const triple = triples[`${process.platform}-${process.arch}`], exe = process.platform === 'win32' ? 'codex.exe' : 'codex';
    if (!triple)
        return null;
    for (const base of [path.join(root, '@openai', `codex-${process.platform}-${process.arch}`, 'vendor'), path.join(root, '@openai', 'codex', 'vendor')]) {
        for (const sub of ['bin', 'codex']) {
            const p = path.join(base, triple, sub, exe);
            if (fs.existsSync(p))
                return p;
        }
    }
    return null;
}
export function resolveCodex({ override = '', appRoot = '', resourcesPath = '' } = {}) {
    if (override) {
        if (!path.isAbsolute(override) || !fs.existsSync(override))
            throw new AppError('Codex 路径必须指向存在的绝对路径文件');
        if (/\.(cmd|bat|ps1)$/i.test(override)) {
            const found = nativeFromNodeModules(path.join(path.dirname(override), 'node_modules'));
            if (found)
                return { command: found, args: [] };
            throw new AppError('请选择 codex.exe 原生程序，不要选择 .cmd / .bat。可清空路径自动检测 npm 安装。');
        }
        if (/\.(mjs|js)$/i.test(override))
            return { command: process.execPath, args: [override], nodeMode: true };
        return { command: override, args: [] };
    }
    const roots = [path.join(appRoot, '.runtime', 'codex', 'node_modules'), path.join(appRoot, 'node_modules')];
    if (resourcesPath)
        roots.unshift(path.join(resourcesPath, 'codex', 'node_modules'));
    if (process.env.APPDATA)
        roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
    roots.push(path.resolve(path.dirname(process.execPath), '../lib/node_modules'));
    for (const dir of (process.env.PATH || '').split(path.delimiter))
        if (dir)
            roots.push(path.join(dir, 'node_modules'), path.resolve(dir, '../lib/node_modules'));
    for (const root of new Set(roots)) {
        const found = nativeFromNodeModules(root);
        if (found)
            return { command: found, args: [] };
    }
    const exe = process.platform === 'win32' ? 'codex.exe' : 'codex';
    for (const dir of [path.join(os.homedir(), '.local', 'bin'), ...(process.env.PATH || '').split(path.delimiter)]) {
        if (!dir)
            continue;
        const p = path.join(dir, exe);
        if (fs.existsSync(p))
            return { command: p, args: [] };
    }
    throw new AppError('未找到 Codex 内核。运行「Install-Engine.cmd」，或在设置中选择 codex.exe。界面无需内核也可管理配置。', 503, 'CODEX_NOT_FOUND');
}
/** Bidirectional newline-delimited Codex app-server JSON-RPC transport. */
export class RpcProcess extends EventEmitter {
    constructor({ command, args = [], env = {}, cwd, timeout = 45000 }) { super(); Object.assign(this, { command, args, env, cwd, timeout }); this.pending = new Map(); this.sequence = 1; this.child = null; this.ready = false; this.closed = false; }
    async start() {
        if (this.child)
            throw new AppError('内核已启动');
        this.closed = false;
        this.child = spawn(this.command, [...this.args, 'app-server'], { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32', shell: false });
        const decoder = new StringDecoder('utf8');
        let buffer = '';
        this.child.stdout.on('data', chunk => {
            buffer += decoder.write(chunk);
            if (buffer.length > 24 * 1024 * 1024) {
                this.emit('problem', 'Codex 单条响应超过 24 MiB，连接已关闭');
                void this.close();
                return;
            }
            let index;
            while ((index = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, index).trim();
                buffer = buffer.slice(index + 1);
                if (line)
                    this.consume(line);
            }
        });
        this.child.stderr.setEncoding('utf8');
        this.child.stderr.on('data', s => this.emit('diagnostic', s.slice(0, 12000)));
        this.child.stdin.on('error', e => this.emit('problem', e.message));
        this.child.once('error', e => this.finish(new AppError(`无法启动 Codex：${e.message}`, 503)));
        this.child.once('exit', (code, signal) => this.finish(new AppError(`Codex 进程退出（${code ?? signal ?? '已关闭'}）`, 503)));
        const result = await this.request('initialize', { clientInfo: { name: 'astrogate_codex_desktop', title: 'AstroGate Codex', version: '0.1.0' }, capabilities: { experimentalApi: true } }, 20000);
        this.notify('initialized', {});
        this.ready = true;
        return result;
    }
    consume(line) {
        let m;
        try {
            m = JSON.parse(line);
        }
        catch {
            this.emit('diagnostic', `忽略非 JSON 输出：${line.slice(0, 300)}`);
            return;
        }
        if (!m || typeof m !== 'object')
            return;
        if (m.method && Object.hasOwn(m, 'id')) {
            this.emit('request', m);
            return;
        }
        if (m.method) {
            this.emit('notification', m);
            return;
        }
        if (Object.hasOwn(m, 'id')) {
            const pending = this.pending.get(String(m.id));
            if (!pending)
                return;
            clearTimeout(pending.timer);
            this.pending.delete(String(m.id));
            if (m.error) {
                const e = new AppError(m.error.message || 'Codex RPC 错误', 502, 'CODEX_RPC');
                e.rpcCode = m.error.code;
                e.data = m.error.data;
                pending.reject(e);
            }
            else
                pending.resolve(m.result);
        }
    }
    write(message) {
        if (this.closed || !this.child?.stdin?.writable)
            throw new AppError('Codex 内核未连接', 503);
        this.child.stdin.write(JSON.stringify(message) + '\n');
    }
    request(method, params = {}, timeout = this.timeout) {
        const rpcId = this.sequence++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(String(rpcId)); reject(new AppError(`Codex 请求超时：${method}。请检查网络与内核日志。`, 504, 'RPC_TIMEOUT')); }, timeout);
            this.pending.set(String(rpcId), { resolve, reject, timer });
            try {
                this.write({ id: rpcId, method, params });
            }
            catch (e) {
                clearTimeout(timer);
                this.pending.delete(String(rpcId));
                reject(e);
            }
        });
    }
    notify(method, params = {}) { this.write({ method, params }); }
    answer(rpcId, result) { this.write({ id: rpcId, result }); }
    reject(rpcId, message = '此客户端未实现该请求') { this.write({ id: rpcId, error: { code: -32601, message } }); }
    finish(error) {
        if (this.closed)
            return;
        this.closed = true;
        this.ready = false;
        for (const p of this.pending.values()) {
            clearTimeout(p.timer);
            p.reject(error);
        }
        this.pending.clear();
        this.emit('closed', error.message);
    }
    async close() {
        const child = this.child;
        if (!child || this.closed)
            return;
        child.stdin.end();
        await new Promise(resolve => { const t = setTimeout(resolve, 500); child.once('exit', () => { clearTimeout(t); resolve(); }); });
        if (child.exitCode === null && child.signalCode === null) {
            if (process.platform === 'win32')
                await new Promise(resolve => { const p = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); p.once('exit', resolve); p.once('error', resolve); });
            else {
                try {
                    process.kill(-child.pid, 'SIGTERM');
                }
                catch {
                    child.kill('SIGTERM');
                }
            }
        }
        if (child.exitCode !== null || child.signalCode !== null) {
            this.finish(new AppError('内核已关闭', 503));
            return;
        }
        await new Promise(resolve => { const t = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) {
            try {
                process.kill(-child.pid, 'SIGKILL');
            }
            catch {
                child.kill('SIGKILL');
            }
        } resolve(); }, 1200); child.once('exit', () => { clearTimeout(t); resolve(); }); });
        this.finish(new AppError('内核已关闭', 503));
    }
}
