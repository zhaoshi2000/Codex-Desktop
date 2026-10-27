import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
let total = 0, failed = false;
function check(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const filename = path.join(dir, entry.name);
    if (entry.isDirectory())
        check(filename);
    else if (/\.(mjs|cjs|js)$/.test(filename)) {
        const result = spawnSync(process.execPath, ['--check', filename], { encoding: 'utf8' });
        if (result.status !== 0) {
            console.error(result.stderr);
            failed = true;
        }
        total++;
    }
} }
for (const dir of ['server', 'web', 'electron', 'scripts', 'tests'])
    check(dir);
console.log(`${total} JavaScript files syntax checked.`);
if (failed)
    process.exitCode = 1;
