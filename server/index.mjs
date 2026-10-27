import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Service } from './service.mjs';
import { AppError, assert, text, atomicWrite } from './util.mjs';
import { openAppWindow, openDirectory, pickDirectory } from './native.mjs';
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
async function body(req) { let size = 0, chunks = []; for await (const chunk of req) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024)
        throw new AppError('请求超过 4 MiB 限制', 413);
    chunks.push(chunk);
} try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
catch {
    throw new AppError('请求不是有效的 JSON');
} }
function acquireLock(dir) {
    const filename = path.join(dir, 'instance.lock');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const fd = fs.openSync(filename, 'wx', 0o600);
            fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
            fs.closeSync(fd);
            return () => { try {
                const lock = JSON.parse(fs.readFileSync(filename, 'utf8'));
                if (lock.pid === process.pid)
                    fs.unlinkSync(filename);
            }
            catch { } };
        }
        catch (e) {
            if (e.code !== 'EEXIST')
                throw e;
            let old;
            try {
                old = JSON.parse(fs.readFileSync(filename, 'utf8'));
            }
            catch {
                throw new AppError('实例锁损坏；确认软件已关闭后删除 instance.lock', 409);
            }
            try {
                process.kill(old.pid, 0);
                throw new AppError('此数据目录已有 AstroGate 实例在运行。请使用已打开的窗口。', 409);
            }
            catch (e2) {
                if (e2.code === 'ESRCH') {
                    fs.unlinkSync(filename);
                    continue;
                }
                throw e2;
            }
        }
    }
    throw new AppError('无法取得数据目录锁', 409);
}
export async function createServer(options = {}) {
    const dataDir = options.dataDir || process.env.ASTROGATE_DATA_DIR || path.join(os.homedir(), '.astrogate-codex');
    const releaseLock = options.lock === false ? () => { } : acquireLock(dataDir);
    let service;
    try {
        service = options.service || new Service({ dataDir, appRoot, resourcesPath: options.resourcesPath || '', runtimeFactory: options.runtimeFactory, native: options.native || {} });
    }
    catch (e) {
        releaseLock();
        throw e;
    }
    const token = crypto.randomBytes(32).toString('base64url'), clients = new Set();
    let sequence = 0, port = 0, closing = false;
    const serviceListener = event => {
        const text = `id: ${++sequence}\ndata: ${JSON.stringify(event)}\n\n`;
        for (const res of clients)
            if (!res.destroyed) {
                if (res.writableLength > 16 * 1024 * 1024) {
                    res.destroy();
                    clients.delete(res);
                }
                else
                    res.write(text);
            }
    };
    service.on('event', serviceListener);
    const server = http.createServer(async (req, res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
        try {
            assert(req.headers.host === `127.0.0.1:${port}`, '拒绝非本机 Host', 403);
            const url = new URL(req.url, `http://127.0.0.1:${port}`), route = url.pathname;
            if (route.startsWith('/api/')) {
                const supplied = req.headers['x-astrogate-token'];
                assert(typeof supplied === 'string' && supplied.length === token.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(token)), '本地访问令牌无效，请通过启动器打开本应用', 401);
                if (req.headers.origin)
                    assert(req.headers.origin === `http://127.0.0.1:${port}`, '拒绝跨站请求', 403);
                if (req.headers['sec-fetch-site'])
                    assert(['same-origin', 'none'].includes(req.headers['sec-fetch-site']), '拒绝跨站请求', 403);
                if (route === '/api/events' && req.method === 'GET') {
                    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive' });
                    res.write(`data: ${JSON.stringify({ type: 'ready', sequence })}\n\n`);
                    clients.add(res);
                    const t = setInterval(() => { if (!res.destroyed)
                        res.write(': heartbeat\n\n'); }, 15000);
                    req.once('close', () => { clearInterval(t); clients.delete(res); });
                    return;
                }
                if (req.method === 'GET') {
                    if (route === '/api/state')
                        return json(res, 200, service.snapshot());
                    if (route === '/api/session')
                        return json(res, 200, service.store.session(url.searchParams.get('id')));
                    if (route === '/api/skill')
                        return json(res, 200, service.readSkill(url.searchParams.get('name')));
                    throw new AppError('接口不存在', 404);
                }
                assert(req.method === 'POST', '不支持此方法', 405);
                assert((req.headers['content-type'] || '').startsWith('application/json'), '请求必须是 application/json', 415);
                const input = await body(req);
                let result;
                switch (route) {
                    case '/api/provider/save':
                        result = await service.saveProvider(input);
                        break;
                    case '/api/provider/select':
                        result = await service.selectProvider(input.id);
                        break;
                    case '/api/provider/delete':
                        assert(input.confirmed === true, '需要确认删除');
                        result = await service.deleteProvider(input.id);
                        break;
                    case '/api/provider/import':
                        result = await service.importProviders(input.data);
                        break;
                    case '/api/provider/import-live':
                        assert(input.confirmed === true, '读取本机配置需要确认');
                        result = await service.importLive();
                        break;
                    case '/api/provider/export':
                        result = service.exportProvider(input.id, input.includeKey === true, input.confirmed === true);
                        break;
                    case '/api/provider/test':
                        result = await service.modelTest(input.id);
                        break;
                    case '/api/usage':
                        result = await service.usageRead(input.id);
                        break;
                    case '/api/models':
                        result = await service.engineModels(input.id || service.data.activeProviderId);
                        break;
                    case '/api/engine/connect':
                        result = await service.connect(input.id);
                        break;
                    case '/api/engine/disconnect':
                        result = await service.disconnect();
                        break;
                    case '/api/engine/login':
                        result = await service.login(input.id);
                        break;
                    case '/api/engine/import-auth':
                        assert(input.confirmed === true, '需要确认复制官方登录态');
                        result = await service.importAuth(input.id);
                        break;
                    case '/api/engine/sandbox':
                        assert(input.confirmed === true, '需要确认设置 Windows 沙箱');
                        result = await service.setupSandbox();
                        break;
                    case '/api/settings':
                        result = await service.saveSettings(input);
                        break;
                    case '/api/project/save':
                        result = service.saveProject(input);
                        break;
                    case '/api/project/remove':
                        assert(input.confirmed === true, '需要确认移除项目');
                        result = service.removeProject(input.id);
                        break;
                    case '/api/project/archive':
                        assert(input.confirmed === true, '需要确认归档');
                        result = service.archiveProject(input.id);
                        break;
                    case '/api/session/edit':
                        result = service.editSession(input);
                        break;
                    case '/api/send':
                        result = await service.send(input);
                        break;
                    case '/api/stop':
                        result = await service.stop();
                        break;
                    case '/api/approval':
                        result = service.respondApproval(input);
                        break;
                    case '/api/mcp/save':
                        assert(!input.enabled || input.trusted === true, '启用 MCP 需要确认信任');
                        result = await service.saveMcp(input);
                        break;
                    case '/api/mcp/toggle':
                        assert(!input.enabled || input.trusted === true, '启用 MCP 需要确认信任');
                        result = await service.toggleMcp(input.id, input.enabled);
                        break;
                    case '/api/mcp/remove':
                        assert(input.confirmed === true, '需要确认移除');
                        result = await service.removeMcp(input.id);
                        break;
                    case '/api/mcp/status':
                        result = await service.mcpStatus();
                        break;
                    case '/api/skill/save':
                        result = service.saveSkill(input);
                        break;
                    case '/api/skill/remove':
                        assert(input.confirmed === true, '需要确认移除');
                        result = service.removeSkill(input.name);
                        break;
                    case '/api/apps':
                        result = await service.listApps();
                        break;
                    case '/api/export':
                        assert(input.confirmed === true, '导出可能包含私有代码与路径，需要确认');
                        result = service.exportData();
                        break;
                    case '/api/native/folder':
                        result = { path: await (options.native?.pickDirectory || pickDirectory)() };
                        break;
                    case '/api/native/open': {
                        let directory;
                        if (input.target === 'data')
                            directory = dataDir;
                        else if (input.target === 'workspace')
                            directory = service.data.settings.workspace;
                        else {
                            const p = service.data.projects.find(p => p.id === input.projectId);
                            assert(p, '项目不存在');
                            directory = p.path;
                        }
                        await (options.native?.openDirectory || openDirectory)(directory);
                        result = { ok: true };
                        break;
                    }
                    case '/api/shutdown':
                        assert(input.confirmed === true, '退出需要确认');
                        json(res, 200, { ok: true });
                        setTimeout(() => void close().then(() => options.onShutdown?.()), 100);
                        return;
                    default: throw new AppError('接口不存在', 404);
                }
                return json(res, 200, result ?? { ok: true });
            }
            assert(req.method === 'GET', '不支持此方法', 405);
            // Only explicitly public filenames are ever served. No path-based filesystem API.
            const filename = route === '/' ? 'index.html' : route.slice(1);
            assert(/^(?:[A-Za-z0-9_-]+\.(?:html|css|js|mjs|svg|png)|assets\/[A-Za-z0-9_-]+\.png)$/.test(filename), '资源不存在', 404);
            const file = path.join(appRoot, 'web', filename);
            assert(fs.existsSync(file), '资源不存在', 404);
            res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
            fs.createReadStream(file).pipe(res);
        }
        catch (e) {
            if (!res.headersSent)
                json(res, e.status || 500, { error: service.sanitize(e.message || '内部错误'), code: e.code || 'INTERNAL', ...(e.sessionId ? { sessionId: e.sessionId } : {}) });
            else
                res.end();
        }
    });
    server.requestTimeout = 180000;
    server.headersTimeout = 15000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port || 0, '127.0.0.1', resolve); });
    port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`, url = `${baseUrl}/#token=${token}`;
    async function close() { if (closing)
        return; closing = true; for (const client of clients)
        client.end(); clients.clear(); service.off('event', serviceListener); await service.close(); await new Promise(resolve => server.close(resolve)); releaseLock(); }
    return { server, service, token, url, baseUrl, port, close };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        const app = await createServer({ onShutdown: () => process.exit(0) });
        console.log('AstroGate Codex is running locally. Keep this window open.');
        console.log(app.url); // Local launch capability; never written to disk or shared with remote providers.
        const end = () => void app.close().then(() => process.exit(0));
        process.once('SIGINT', end);
        process.once('SIGTERM', end);
        if (process.argv.includes('--open'))
            await openAppWindow(app.url, app.service.dataDir).catch(e => console.error('自动打开失败，请使用上面的本机链接：' + e.message));
    }
    catch (e) {
        console.error(e.message);
        process.exitCode = 1;
    }
}
