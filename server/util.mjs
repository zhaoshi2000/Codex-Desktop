import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export class AppError extends Error {
    constructor(message, status = 400, code = 'BAD_REQUEST') { super(message); this.status = status; this.code = code; }
}
export function assert(condition, message, status = 400) { if (!condition)
    throw new AppError(message, status); }
export function id(prefix = '') { return prefix + crypto.randomUUID(); }
export function text(value, name, max = 4000, required = false) {
    assert(typeof value === 'string', `${name}必须是文本`);
    assert(value.length <= max, `${name}过长（上限 ${max} 字符）`);
    assert(!value.includes('\0'), `${name}含有无效字符`);
    if (required)
        assert(value.trim(), `请填写${name}`);
    return value;
}
export function atomicWrite(filename, content, mode = 0o600) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const tmp = `${filename}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
    let fd;
    try {
        fd = fs.openSync(tmp, 'wx', mode);
        fs.writeFileSync(fd, content);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(tmp, filename);
        if (process.platform !== 'win32')
            fs.chmodSync(filename, mode);
    }
    finally {
        if (fd !== undefined)
            fs.closeSync(fd);
        if (fs.existsSync(tmp))
            fs.unlinkSync(tmp);
    }
}
export function readJson(filename, fallback) {
    if (!fs.existsSync(filename))
        return structuredClone(fallback);
    try {
        return JSON.parse(fs.readFileSync(filename, 'utf8'));
    }
    catch {
        throw new AppError(`数据文件损坏：${path.basename(filename)}。原文件已保留，请从备份恢复。`, 500, 'DATA_CORRUPT');
    }
}
export function realDirectory(value) {
    text(value, '目录', 4096, true);
    assert(path.isAbsolute(value), '请填写绝对目录路径');
    let resolved;
    try {
        resolved = fs.realpathSync(value);
        assert(fs.statSync(resolved).isDirectory(), '选择的路径不是目录');
    }
    catch (e) {
        if (e instanceof AppError)
            throw e;
        throw new AppError('目录不存在或没有访问权限');
    }
    return resolved;
}
export function safeId(value) { assert(typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value), '无效的 ID'); return value; }
export function safeName(value) { assert(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value), '名称只允许英文字母、数字、下划线和短横线'); return value; }
export function cleanUrl(value, { allowInsecure = false } = {}) {
    text(value, 'URL', 2048, true);
    let url;
    try {
        url = new URL(value.trim());
    }
    catch {
        throw new AppError('URL 格式不正确，请包含 https://');
    }
    assert(!url.username && !url.password, 'URL 中不能包含账号密码');
    assert(!url.hash && !url.search, '此处填写不含查询参数和 # 的基础 URL');
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    assert(url.protocol === 'https:' || (url.protocol === 'http:' && (loopback || allowInsecure)), '非本机 HTTP 会明文传输 API Key；请改用 HTTPS，或明确勾选允许 HTTP');
    assert(['https:', 'http:'].includes(url.protocol), '只支持 HTTP / HTTPS');
    return url.toString().replace(/\/+$/, '');
}
export function redact(input, secrets = []) {
    let out = typeof input === 'string' ? input : JSON.stringify(input);
    for (const secret of secrets.filter(x => typeof x === 'string' && x.length >= 4).sort((a, b) => b.length - a.length))
        out = out.split(secret).join('[REDACTED]');
    return out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]').replace(/\bsk-[A-Za-z0-9_-]{10,}/g, '[REDACTED]');
}
export function dotGet(object, key) {
    if (!key)
        return undefined;
    assert(typeof key === 'string' && /^[A-Za-z0-9_.-]+$/.test(key), 'JSON 路径只支持点号字段路径，例如 data.remaining');
    return key.split('.').reduce((a, k) => a && Object.hasOwn(a, k) ? a[k] : undefined, object);
}
export function percentage(total, remaining) {
    if (total === null || remaining === null || total === undefined || remaining === undefined || total === '' || remaining === '')
        return null;
    total = Number(total);
    remaining = Number(remaining);
    if (!Number.isFinite(total) || !Number.isFinite(remaining) || total <= 0 || remaining < 0 || remaining > total)
        return null;
    return Math.round(remaining / total * 1000) / 10;
}
export async function readResponseBody(response, max = 8 * 1024 * 1024) {
    const reader = response.body?.getReader();
    if (!reader)
        return '';
    let total = 0;
    const chunks = [];
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            total += value.length;
            if (total > max)
                throw new AppError('远程返回内容过大');
            chunks.push(Buffer.from(value));
        }
    }
    catch (e) {
        await reader.cancel().catch(() => { });
        throw e;
    }
    return Buffer.concat(chunks).toString('utf8');
}
export function tomlString(value) { return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }
