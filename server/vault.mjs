import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { atomicWrite, readJson, AppError } from './util.mjs';
// Windows uses per-user DPAPI for the encryption key. Other platforms use a
// mode-0600 local master key. This protects against casual file disclosure,
// NOT malicious programs running as the same user or a stolen full profile.
function dpapi(buffer, decrypt = false) {
    const method = decrypt ? 'Unprotect' : 'Protect';
    const script = `Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($s); $r=[Security.Cryptography.ProtectedData]::${method}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
    const r = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { input: buffer.toString('base64'), encoding: 'utf8', windowsHide: true, timeout: 15000 });
    if (r.error || r.status !== 0 || !r.stdout.trim())
        throw new AppError('Windows DPAPI 密钥保护不可用；没有退回到明文存储。请检查 PowerShell。', 500);
    return Buffer.from(r.stdout.trim(), 'base64');
}
export class Vault {
    constructor(dir) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const keyPath = path.join(dir, process.platform === 'win32' ? 'vault-key.dpapi' : 'vault-key.bin');
        let stored;
        if (fs.existsSync(keyPath))
            stored = fs.readFileSync(keyPath);
        else {
            const raw = crypto.randomBytes(32);
            stored = process.platform === 'win32' ? dpapi(raw) : raw;
            atomicWrite(keyPath, stored);
        }
        this.key = process.platform === 'win32' ? dpapi(stored, true) : stored;
        if (this.key.length !== 32)
            throw new AppError('本地密钥文件损坏，请保留文件并恢复备份', 500);
        this.file = path.join(dir, 'vault.json');
        this.data = readJson(this.file, {});
    }
    set(key, value) {
        if (!value)
            delete this.data[key];
        else {
            const iv = crypto.randomBytes(12);
            const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
            cipher.setAAD(Buffer.from(key));
            const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
            this.data[key] = { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
        }
        atomicWrite(this.file, JSON.stringify(this.data, null, 2));
    }
    get(key) {
        const row = this.data[key];
        if (!row)
            return '';
        try {
            const d = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(row.iv, 'base64'));
            d.setAAD(Buffer.from(key));
            d.setAuthTag(Buffer.from(row.tag, 'base64'));
            return Buffer.concat([d.update(Buffer.from(row.data, 'base64')), d.final()]).toString('utf8');
        }
        catch {
            throw new AppError('凭据无法解密：请重新填写 API Key。原凭据文件未修改。', 500);
        }
    }
    has(key) { return Object.hasOwn(this.data, key); }
    secrets() { const values = []; for (const k of Object.keys(this.data)) {
        const value = this.get(k);
        if (!value)
            continue;
        values.push(value);
        if (k.startsWith('mcp-env:')) {
            try {
                values.push(...Object.values(JSON.parse(value)).filter(x => typeof x === 'string'));
            }
            catch { }
        }
    } return values; }
}
