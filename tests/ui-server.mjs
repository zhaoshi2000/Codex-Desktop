// Explicit test harness: not referenced by Start.cmd or packaged Electron files.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createServer } from '../server/index.mjs';
import { temp, fixture } from './helpers.mjs';
const dataDir = temp(), workspace = path.join(dataDir, 'ui-project');
fs.mkdirSync(workspace);
const upstream = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); if (req.url === '/v1/models')
    res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
else if (req.url === '/quota')
    res.end(JSON.stringify({ data: { total: 100, remaining: 27 } }));
else {
    res.writeHead(404);
    res.end('{}');
} });
await new Promise(r => upstream.listen(0, '127.0.0.1', r));
const bridge = await createServer({ dataDir, runtimeFactory: fixture, native: { pickDirectory: async () => workspace, openDirectory: async () => { } } });
const info = { url: bridge.url, baseUrl: bridge.baseUrl, token: bridge.token, upstream: `http://127.0.0.1:${upstream.address().port}`, dataDir, workspace };
fs.writeFileSync(process.env.UI_INFO || '/mnt/data/astrogate-ui-info.json', JSON.stringify(info));
console.log(bridge.url);
const stop = async () => { await bridge.close(); upstream.close(); fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
