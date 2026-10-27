import { resolveCodex } from '../server/rpc.mjs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
try {
    const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const c = resolveCodex({ appRoot });
    const r = spawnSync(c.command, [...(c.args || []), '--version'], { encoding: 'utf8', timeout: 20000, windowsHide: true, shell: false });
    if (r.error)
        throw r.error;
    if (r.status !== 0)
        throw new Error(r.stderr || 'Codex --version failed');
    console.log(r.stdout.trim());
    console.log('Engine executable found. API authentication was NOT tested.');
    if (!r.stdout.includes('0.162.1'))
        console.warn('Warning: this GUI targets Codex 0.162.1. Verify API compatibility for this version.');
}
catch (e) {
    console.error(e.message);
    process.exitCode = 1;
}
