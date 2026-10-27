import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RpcProcess } from '../server/rpc.mjs';
import { Service } from '../server/service.mjs';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'astrogate-test-'));
export const fixture = ({ env = process.env, cwd = root } = {}) => new RpcProcess({ command: process.execPath, args: [path.join(root, 'tests', 'fixture-rpc.mjs')], env, cwd, timeout: 1500 });
export const makeService = () => new Service({ dataDir: temp(), appRoot: root, runtimeFactory: fixture });
export async function waitUntil(fn, timeout = 3500) { const start = Date.now(); while (!fn()) {
    if (Date.now() - start > timeout)
        throw new Error('Timed out waiting for fixture event');
    await new Promise(r => setTimeout(r, 12));
} }
