import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { assert, AppError } from './util.mjs';
const exec = promisify(execFile);
const launch = (exe, args) => new Promise((resolve, reject) => { const p = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true, shell: false }); p.once('error', reject); p.once('spawn', () => { p.unref(); resolve(); }); });
export async function openDirectory(directory) {
    if (process.platform === 'win32')
        return launch('explorer.exe', [directory]);
    if (process.platform === 'darwin')
        return launch('open', [directory]);
    return launch('xdg-open', [directory]);
}
export async function pickDirectory() {
    if (process.platform === 'win32') {
        const script = "Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='Select a project folder'; if($d.ShowDialog() -eq 'OK'){[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Console]::Write($d.SelectedPath)}";
        const { stdout } = await exec('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: true, encoding: 'utf8', timeout: 180000 });
        return stdout.trim() || null;
    }
    if (process.platform === 'darwin') {
        const { stdout } = await exec('osascript', ['-e', 'POSIX path of (choose folder with prompt "Select a project folder")'], { timeout: 180000 });
        return stdout.trim() || null;
    }
    try {
        const { stdout } = await exec('zenity', ['--file-selection', '--directory', '--title=Select a project folder'], { timeout: 180000 });
        return stdout.trim() || null;
    }
    catch {
        return null;
    }
}
export async function openWeb(url) {
    const parsed = new URL(url);
    assert(['http:', 'https:'].includes(parsed.protocol), '只允许打开 HTTP / HTTPS 链接');
    if (process.platform === 'win32') {
        // Never pass an arbitrary URL through cmd.exe /c start (shell metacharacters).
        const script = '$u=[Console]::In.ReadToEnd(); Start-Process -FilePath $u';
        return new Promise((resolve, reject) => { const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true, shell: false }); p.stdin.end(url); p.once('exit', code => code === 0 ? resolve() : reject(new AppError('无法打开外部浏览器'))); p.once('error', reject); });
    }
    return launch(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
}
export async function openAppWindow(url, dataDir) {
    if (process.platform === 'win32') {
        const candidates = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean).flatMap(base => [path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe')]);
        for (const candidate of candidates)
            if (fs.existsSync(candidate)) {
                await launch(candidate, [`--app=${url}`, '--window-size=1420,960', `--user-data-dir=${path.join(dataDir, 'browser-profile')}`]);
                return;
            }
    }
    await openWeb(url);
}
