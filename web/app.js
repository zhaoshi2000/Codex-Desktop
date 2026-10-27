import { icon, esc } from './icons.js';
import { markdown } from './markdown.js';
const $ = s => document.querySelector(s), root = $('#app'), popRoot = $('#popover-root'), modalRoot = $('#modal-root');
const fragment = new URLSearchParams(location.hash.slice(1));
let token = fragment.get('token') || sessionStorage.getItem('astrogate-token') || '';
if (fragment.has('token')) {
    sessionStorage.setItem('astrogate-token', token);
    history.replaceState(null, '', location.pathname);
}
let state = null, view = 'chat', settingsTab = 'general', extensionTab = 'mcp', selectedSessionId = null, currentSession = null, selectedProjectId = null;
let draft = '', model = 'gpt-6-sol', effort = 'high', permission = 'workspace-write', attachments = [], sending = false;
let popover = null, modalResolver = null, streamClosed = false, historyArchived = false, historyFilter = '', appsData = null, mcpStatus = null, modelsByProvider = new Map();
const expandedProjects = new Set(), collapsedSections = new Set();
const presetModels = [['gpt-6.1-sol', 'GPT-6.1 Sol'], ['gpt-6-astra', 'GPT-6 Astra'], ['gpt-6-sol', 'GPT-6 Sol'], ['gpt-6-luna', 'GPT-6 Luna'], ['gpt-5.6-sol', 'GPT-5.6 Sol'], ['gpt-5.6-terra', 'GPT-5.6 Terra'], ['gpt-5.6-luna', 'GPT-5.6 Luna']].map(([id, label]) => ({ id, label, source: 'preset', efforts: [] }));
const effortNames = { none: '无', minimal: '最少', low: '低', medium: '中', high: '高', xhigh: '极高', max: 'Max', ultra: 'Ultra' };
const statusNames = { idle: '未运行', running: '运行中', inProgress: '进行中', completed: '已完成', failed: '失败', interrupted: '已停止', declined: '已拒绝' };
const fmtDate = x => x ? new Date(x).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
const shortDate = x => x ? new Date(x).toLocaleDateString('zh-CN') : '—';
const btn = (label, action, cls = '', extra = '') => `<button type="button" class="btn ${cls}" data-action="${action}" ${extra}>${label}</button>`;
const ib = (name, action, label, extra = '') => `<button type="button" class="icon-btn" data-action="${action}" title="${esc(label)}" aria-label="${esc(label)}" ${extra}>${icon(name)}</button>`;
const activeProvider = () => state?.providers.find(p => p.id === (currentSession?.providerId || state.activeProviderId)) || state?.providers[0];
const activeModels = () => modelsByProvider.get(activeProvider()?.id) || activeProvider()?.models || presetModels;
const modelLabel = () => activeModels().find(m => m.id === model)?.label || model;
const api = async (route, data) => {
    const response = await fetch('/api/' + route, { method: data === undefined ? 'GET' : 'POST', headers: { 'X-AstroGate-Token': token, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), cache: 'no-store' });
    let result;
    try {
        result = await response.json();
    }
    catch {
        throw new Error('本地服务响应异常，请重新启动应用。');
    }
    if (!response.ok) {
        const error = new Error(result.error || `请求失败 ${response.status}`);
        Object.assign(error, result);
        throw error;
    }
    return result;
};
function toast(message, error = false) { const n = document.createElement('div'); n.className = 'toast' + (error ? ' error' : ''); n.textContent = message; $('#toast-root').append(n); setTimeout(() => n.remove(), error ? 8500 : 4300); }
function applyTheme() { const mode = state?.settings.theme || 'light'; document.documentElement.dataset.theme = mode === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : mode; document.body.classList.toggle('theme-dark', document.documentElement.dataset.theme === 'dark'); }
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
let syncTimer, syncSeq = 0, appliedSeq = 0;
async function syncState(initial = false) {
    const seq = ++syncSeq, old = state;
    const next = await api('state');
    if (seq < appliedSeq)
        return;
    appliedSeq = seq;
    state = next;
    if (initial && !old) {
        model = next.settings.model || activeProvider().defaultModel;
        effort = next.settings.effort;
        permission = next.settings.defaultPermission;
    }
    if (sending && !selectedSessionId && state.running) {
        selectedSessionId = state.running.sessionId;
        currentSession = await api('session?id=' + encodeURIComponent(selectedSessionId));
    }
    if (selectedSessionId && old?.running?.sessionId === selectedSessionId && !state.running)
        currentSession = await api('session?id=' + encodeURIComponent(selectedSessionId));
    applyTheme();
    render();
}
function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(() => syncState().catch(e => toast(e.message, true)), 110); }
async function streamEvents() {
    while (!streamClosed) {
        try {
            const response = await fetch('/api/events', { headers: { 'X-AstroGate-Token': token }, cache: 'no-store' });
            if (!response.ok)
                throw new Error('事件连接失效');
            const reader = response.body.getReader(), decoder = new TextDecoder();
            let buffer = '';
            while (true) {
                const { value, done } = await reader.read();
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                let end;
                while ((end = buffer.indexOf('\n\n')) !== -1) {
                    const block = buffer.slice(0, end);
                    buffer = buffer.slice(end + 2);
                    const line = block.split('\n').find(l => l.startsWith('data: '));
                    if (line) {
                        try {
                            handleEvent(JSON.parse(line.slice(6)));
                        }
                        catch (e) {
                            console.error('UI event error', e.message);
                        }
                    }
                }
            }
        }
        catch { }
        if (!streamClosed) {
            await new Promise(r => setTimeout(r, 1800));
            try {
                await syncState();
                if (selectedSessionId) {
                    currentSession = await api('session?id=' + encodeURIComponent(selectedSessionId));
                    renderTranscript();
                }
            }
            catch { }
        }
    }
}
let sessionRenderTimer;
function handleEvent(e) {
    if (e.type === 'ready') {
        scheduleSync();
        if (selectedSessionId)
            api('session?id=' + encodeURIComponent(selectedSessionId)).then(s => { currentSession = s; renderTranscript(); }).catch(() => { });
        return;
    }
    if (e.type === 'state') {
        scheduleSync();
        return;
    }
    if (e.type === 'session') {
        if (sending && !selectedSessionId) {
            selectedSessionId = e.sessionId;
            currentSession = e.session;
            render();
        }
        else if (e.sessionId === selectedSessionId) {
            currentSession = e.session;
            clearTimeout(sessionRenderTimer);
            sessionRenderTimer = setTimeout(renderTranscript, 55);
        }
        return;
    }
    if (e.type === 'approval') {
        if (!state.approvals.some(a => a.id === e.approval.id))
            state.approvals.push(e.approval);
        renderApprovalBanner();
        toast('有一项操作需要你批准。');
        return;
    }
    if (e.type === 'usage') {
        state.usage[e.providerId] = e.usage;
        if (view === 'usage')
            render();
        return;
    }
    if (e.type === 'log') {
        state?.logs.push(e.row);
        if (state?.logs.length > 200)
            state.logs.shift();
        const log = $('#runtime-log');
        if (log)
            log.textContent = logText();
        return;
    }
    if (e.type === 'login') {
        toast(e.success ? '官方登录已完成。' : e.error || '登录没有完成', !e.success);
        scheduleSync();
        return;
    }
    if (e.type === 'sandbox') {
        toast(e.success ? 'Windows 沙箱设置完成。' : e.error || JSON.stringify(e), !e.success);
        return;
    }
}
function render() {
    if (!state)
        return;
    const focused = document.activeElement, focusId = focused?.id, selStart = focused?.selectionStart, selEnd = focused?.selectionEnd;
    const scroll = $('#chat-stage')?.scrollTop, atBottom = $('#chat-stage') ? ($('#chat-stage').scrollHeight - $('#chat-stage').scrollTop - $('#chat-stage').clientHeight < 120) : true;
    const navScroll = $('.nav-scroll')?.scrollTop || 0, pageScroll = $('.page')?.scrollTop || 0;
    root.innerHTML = `${titlebar()}<div class="app-body">${rail()}<div class="shell">${sidebar()}<main class="workspace">${mainView()}</main></div></div>`;
    $('.nav-scroll') && ($('.nav-scroll').scrollTop = navScroll);
    $('.page') && ($('.page').scrollTop = pageScroll);
    if (view === 'chat') {
        $('#prompt').value = draft;
        resizePrompt();
        const stage = $('#chat-stage');
        if (atBottom)
            stage.scrollTop = stage.scrollHeight;
        else if (scroll !== undefined)
            stage.scrollTop = scroll;
    }
    if (focusId && !modalRoot.childElementCount) {
        const field = document.getElementById(focusId);
        if (field) {
            field.focus({ preventScroll: true });
            if (typeof selStart === 'number' && field.setSelectionRange)
                try {
                    field.setSelectionRange(selStart, selEnd);
                }
                catch { }
        }
    }
}
function titlebar() { return `<header class="titlebar">${ib('back', 'go-chat', '返回工作台')}<button class="top-menu" data-action="top-file" data-popover>文件</button><button class="top-menu" data-action="top-edit" data-popover>编辑</button><button class="top-menu" data-action="top-view" data-popover>视图</button><button class="top-menu" data-action="about">帮助</button><span class="window-title">AstroGate Codex · 本地开发工作台</span>${window.desktop ? `<div class="window-buttons">${ib('minimize', 'window-min', '最小化')}${ib('maximize', 'window-max', '最大化 / 还原')}${ib('close', 'window-close', '关闭')}</div>` : ''}</header>`; }
function rail() {
    return `<nav class="rail" aria-label="主导航"><button class="icon-btn ${view === 'chat' ? 'selected' : ''}" data-action="go-chat" title="工作台" aria-label="工作台">${icon('home', 21)}</button>${ib('folder', 'projects', '项目')}
<button class="icon-btn ${view === 'history' ? 'selected' : ''}" data-action="history" title="会话记录" aria-label="会话记录">${icon('history', 21)}</button><button class="icon-btn ${view === 'extensions' ? 'selected' : ''}" data-action="extensions" title="插件与技能" aria-label="插件与技能">${icon('plug', 21)}</button>${ib('more', 'top-view', '更多', 'data-popover')}<hr><button class="icon-btn ${view === 'settings' && settingsTab === 'providers' ? 'selected' : ''}" data-action="providers" title="模型供应商" aria-label="模型供应商">${icon('layers', 20)}</button><button class="icon-btn ${view === 'usage' ? 'selected' : ''}" data-action="usage" title="使用情况" aria-label="使用情况">${icon('meter', 21)}</button><div class="spacer"></div>${ib('settings', 'settings', '设置')}<button class="icon-btn" id="profile-toggle" data-action="profile-menu" data-popover aria-label="个人菜单"><img class="avatar" src="/assets/profile-avatar.png" alt=""></button></nav>`;
}
function sidebar() {
    if (view === 'settings')
        return settingsSidebar();
    if (view === 'extensions')
        return extensionSidebar();
    const projects = state.projects;
    const pinnedProjects = projects.filter(p => p.pinned), pinnedSessions = state.sessions.filter(s => s.pinned && !s.archived).sort((a, b) => b.updatedAt - a.updatedAt);
    const sections = [...new Set(['项目', ...projects.filter(p => !p.pinned).map(p => p.section || '项目')])];
    return `<aside class="sidebar"><div class="sidebar-top between"><div><div class="sidebar-brand">Codex <span class="muted">${icon('down', 13)}</span></div><div class="sidebar-sub">ASTROGATE DESKTOP</div></div><div class="row">${ib('bell', 'approvals', '待审批操作')}${ib('search', 'search', '搜索')}</div></div>
    <button class="nav-item" data-action="new-chat">${icon('edit', 18)}<span>新聊天</span><span class="keyhint">Ctrl N</span></button><div class="row identity"><span class="mini-mark">A</span>本地工作空间</div>
    <div class="nav-scroll"><section class="nav-section"><div class="nav-section-title"><span>置顶</span>${icon('chevron', 12)}</div>${pinnedProjects.map(renderProject).join('')}${pinnedSessions.map(s => renderSessionNav(s, true)).join('')}${!pinnedProjects.length && !pinnedSessions.length ? '<div class="empty-nav">常用项目与会话会显示在这里</div>' : ''}</section>
    ${sections.map(section => `<section class="nav-section"><div class="nav-section-title"><button data-action="toggle-section" data-section="${esc(section)}">${esc(section)}${icon(collapsedSections.has(section) ? 'chevron' : 'down', 12)}</button><div class="spacer"></div>${ib('plus', 'add-project', '添加项目', `data-section="${esc(section)}"`)}</div>${collapsedSections.has(section) ? '' : projects.filter(p => !p.pinned && (p.section || '项目') === section).map(renderProject).join('')}${!projects.length && section === '项目' ? '<div class="empty-nav">添加文件夹，开始构建你的项目</div>' : ''}</section>`).join('')}
    <section class="nav-section"><div class="nav-section-title"><span>最近</span>${icon('chevron', 12)}<span class="spacer"></span>${ib('history', 'history', '查看全部会话')}</div>${state.sessions.filter(s => !s.archived && !s.pinned).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12).map(s => renderSessionNav(s, true)).join('')}${!state.sessions.some(s => !s.archived) ? '<div class="empty-nav">按最近一次任务时间排序</div>' : ''}</section></div>${sidebarFooter()}</aside>`;
}
function sidebarFooter() { return `<div class="sidebar-footer"><span class="dot ${state.engine.connected ? 'online' : ''}"></span><span class="truncate">${state.engine.connected ? '内核已连接' : state.engine.connecting ? '正在连接内核…' : '内核未连接'}</span>${ib('info', 'about', '运行信息')}</div>`; }
function renderProject(p) { const expanded = expandedProjects.has(p.id), sessions = state.sessions.filter(s => s.projectId === p.id && !s.archived).sort((a, b) => b.updatedAt - a.updatedAt); return `<div class="project-row ${selectedProjectId === p.id ? 'active' : ''}"><button class="project-main" data-action="select-project" data-id="${p.id}" title="${esc(p.path)}">${icon('folder', 17)}<span class="truncate">${esc(p.name)}</span></button><div class="row-actions">${ib('more', 'project-menu', '项目操作', `data-id="${p.id}" data-popover`)}${ib('edit', 'project-new-chat', '在项目中新建聊天', `data-id="${p.id}"`)}</div></div>${expanded ? sessions.slice(0, 7).map(s => renderSessionNav(s)).join('') : ''}`; }
function renderSessionNav(s, top = false) { return `<div class="session-nav ${top ? 'top' : ''} ${selectedSessionId === s.id ? 'active' : ''}"><button data-action="open-session" data-id="${s.id}" class="truncate" title="${esc(s.title)}">${esc(s.title)}</button>${s.status === 'running' ? '<span class="status-small">●</span>' : ''}${ib('more', 'session-menu', '会话操作', `data-id="${s.id}" data-popover`)}</div>`; }
function settingsSidebar() { const items = [['general', 'settings', '常规'], ['appearance', 'sun', '外观'], ['providers', 'layers', '模型供应商'], ['storage', 'storage', '数据与存储'], ['about', 'info', '关于与诊断']]; return `<aside class="sidebar"><div class="sidebar-top between"><div class="sidebar-brand">设置</div>${ib('close', 'go-chat', '返回工作台')}</div><button class="side-search" data-action="search">${icon('search', 16)}搜索会话</button><div class="nav-scroll settings-nav"><div class="nav-section-title">个人</div>${items.slice(0, 2).map(([tab, i, label]) => settingsNav(tab, i, label)).join('')}<button class="nav-item" data-action="archived">${icon('archive', 17)}归档聊天</button><button class="nav-item" data-action="usage">${icon('meter', 17)}使用情况与额度</button><div class="nav-section-title">集成</div>${settingsNav('providers', 'layers', '模型供应商')}<button class="nav-item" data-action="extensions">${icon('plug', 17)}插件与技能</button><div class="nav-section-title">应用</div>${items.slice(3).map(([tab, i, label]) => settingsNav(tab, i, label)).join('')}</div>${sidebarFooter()}</aside>`; }
function settingsNav(tab, i, label) { return `<button class="nav-item ${settingsTab === tab ? 'active' : ''}" data-action="settings-tab" data-tab="${tab}">${icon(i, 17)}${label}</button>`; }
function extensionSidebar() { return `<aside class="sidebar"><div class="sidebar-top between"><div class="sidebar-brand">自定义</div>${ib('search', 'search', '搜索')}</div><button class="nav-item ${extensionTab === 'mcp' ? 'active' : ''}" data-action="extension-tab" data-tab="mcp">${icon('plug', 17)}MCP 插件</button><button class="nav-item ${extensionTab === 'skills' ? 'active' : ''}" data-action="extension-tab" data-tab="skills">${icon('code', 17)}技能</button><button class="nav-item ${extensionTab === 'apps' ? 'active' : ''}" data-action="extension-tab" data-tab="apps">${icon('globe', 17)}官方应用目录</button><div class="nav-scroll"><div class="nav-section-title" style="margin-top:25px">已添加</div>${state.mcp.map(m => `<button class="nav-item" data-action="edit-mcp" data-id="${m.id}">${icon('plug', 16)}<span class="truncate">${esc(m.name)}</span><span class="spacer"></span><span class="dot ${m.enabled ? 'online' : ''}"></span></button>`).join('')}${state.skills.map(s => `<button class="nav-item" data-action="edit-skill" data-name="${s.name}">${icon('code', 16)}<span class="truncate">${esc(s.name)}</span></button>`).join('')}${!state.mcp.length && !state.skills.length ? '<div class="empty-nav">尚未添加插件或技能</div>' : ''}</div>${sidebarFooter()}</aside>`; }
function mainView() { if (view === 'chat')
    return chatView(); if (view === 'settings')
    return settingsView(); if (view === 'extensions')
    return extensionsView(); if (view === 'usage')
    return usageView(); return historyView(); }
function chatView() {
    const p = activeProvider();
    return `<div class="workspace-top"><div class="workspace-title truncate">${currentSession ? `${icon('chat', 16)}<span class="truncate">${esc(currentSession.title)}</span>` : `${icon('layers', 15)}<span class="truncate">${esc(p.name)}</span><span class="badge">${p.kind === 'relay' ? 'Responses 中转' : '官方内核'}</span>`}</div><div class="row">${currentSession ? ib('more', 'session-menu', '会话操作', `data-id="${currentSession.id}" data-popover`) : ''}<button class="connect-btn" data-action="connect"><span class="dot ${state.engine.connected ? 'online' : ''}"></span>${state.engine.connected ? '已连接' : state.engine.connecting ? '连接中…' : '连接内核'}</button></div></div>
<div class="chat-view"><div class="chat-stage" id="chat-stage">${transcriptOrWelcome()}</div><div class="composer-region"><div id="approval-banner">${approvalBanner()}</div><div class="context-bar"><button data-action="choose-project" data-popover>${icon('folder', 15)}<span class="truncate">${esc(state.projects.find(p => p.id === selectedProjectId)?.name || '选择项目')}</span></button><span class="device">${icon('laptop', 16)}此计算机</span><span class="spacer"></span>${currentSession ? `<span class="small muted truncate">${esc(state.providers.find(x => x.id === currentSession.providerId)?.name || '原供应商')}</span>` : ''}</div><div class="composer"><div class="attachment-list">${attachments.map((a, i) => `<span class="attachment-chip">${icon('file', 13)}${esc(a.name)}${ib('close', 'remove-attachment', '移除附件', `data-index="${i}"`)}</span>`).join('')}</div><textarea id="prompt" rows="2" placeholder="随心输入，描述你要构建什么…" aria-label="消息输入框" spellcheck="false"></textarea><div class="composer-footer">${ib('plus', 'attach', '附加文本或代码文件')}<button class="permission ${permission === 'danger-full-access' ? 'full' : ''}" data-action="permission-menu" data-popover>${icon('shield', 15)}${permission === 'danger-full-access' ? '完全访问' : permission === 'read-only' ? '只读访问' : '工作区访问'}</button><div class="model-pill">${state.settings.acceleration ? `<span class="bolt-enabled">${icon('bolt', 13)}</span>` : ''}<button id="model-toggle" data-action="model-menu" data-popover title="选择模型"><span class="model-name">${esc(modelLabel())}</span></button><button id="effort-toggle" data-action="effort-menu" data-popover title="选择推理强度"><span class="effort-label ${effort === 'ultra' ? 'ultra-text' : ''}">${esc(effortNames[effort] || effort)}</span>${icon('down', 12)}</button></div><button id="send-button" class="send-btn" data-action="${state.running || sending ? 'stop' : 'send'}" title="${state.running || sending ? '停止任务' : '发送消息'}" aria-label="${state.running || sending ? '停止任务' : '发送消息'}" ${!draft.trim() && !state.running && !sending ? 'disabled' : ''}>${icon(state.running || sending ? 'stop' : 'arrow', 18)}</button></div></div><div class="composer-hint">${state.settings.acceleration ? '⚡ 加速仅为界面预留，不改变请求速度或费用。' : 'Enter 发送 · Shift + Enter 换行 · 模型生成的代码仍需验证。'} ${currentSession?.archived ? '此会话已归档，请先恢复。' : ''}</div></div></div>`;
}
function transcriptOrWelcome() {
    if (!currentSession)
        return `<div class="welcome"><span class="welcome-symbol">${icon('cloud', 55)}</span><h1>我们要构建什么？</h1><p class="welcome-note">${selectedProjectId ? '从这个项目出发，把想法变成可运行的代码。' : '文字对话、项目开发、代码修改，都在同一个工作台。'}</p>${!state.engine.connected ? `<div class="welcome-start">${btn(`${icon('layers', 14)}配置中转`, 'providers')}${btn(`${icon('folder', 14)}添加项目`, 'add-project')}</div>` : ''}</div>`;
    return `<div class="transcript">${currentSession.plan?.plan?.length ? `<div class="plan-box"><div class="small muted">${esc(currentSession.plan.explanation || '任务计划')}</div>${currentSession.plan.plan.map(p => `<div class="plan-step"><span class="${p.status === 'completed' ? 'completed' : 'muted'}">${icon(p.status === 'completed' ? 'check' : 'history', 14)}</span>${esc(p.step)}</div>`).join('')}</div>` : ''}${currentSession.items.map(renderItem).join('')}${state.running?.sessionId === currentSession.id ? '<div class="working"><span class="pulse"></span>Codex 正在处理任务…</div>' : ''}${currentSession.usage ? `<div class="small muted" style="margin-top:15px">内核上报 Token：${esc((currentSession.usage.total?.totalTokens ?? currentSession.usage.last?.totalTokens ?? '—').toLocaleString?.() || '—')} · 不代表账户余额</div>` : ''}</div>`;
}
function renderItem(item) {
    if (item.type === 'userMessage')
        return `<div class="message user"><div class="user-bubble">${esc(item.text || (item.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n'))}</div>${item.attachments?.length ? `<div class="small muted" style="margin-top:7px">${item.attachments.map(a => esc(a.name)).join(' · ')}</div>` : ''}</div>`;
    if (item.type === 'agentMessage')
        return `<article class="message"><div class="message-label"><span class="mini-mark">A</span>Codex</div>${markdown(item.text || '')}</article>`;
    if (item.type === 'system')
        return `<div class="message system-message">${icon('info', 16)}<span>${esc(item.text)}${item.retry ? '\n内核会继续重试。' : ''}</span></div>`;
    if (item.type === 'reasoning') {
        const summary = item.summaryText || (Array.isArray(item.summary) ? item.summary.join('\n') : '');
        return summary ? `<details class="tool-item" data-item-id="${esc(item.id)}"><summary>${icon('cloud', 15)}执行摘要</summary><div class="tool-detail">${esc(summary)}</div></details>` : '';
    }
    if (item.type === 'commandExecution') {
        const command = typeof item.command === 'string' ? item.command : Array.isArray(item.command) ? item.command.join(' ') : JSON.stringify(item.command || '');
        return `<details class="tool-item" data-item-id="${esc(item.id)}"><summary>${icon('terminal', 16)}<span class="truncate mono">${esc(command || '运行命令')}</span><span class="badge">${esc(statusNames[item.status] || item.status || '执行中')}</span></summary><pre>${esc(item.aggregatedOutput || item.output || '等待输出…')}${item.exitCode !== undefined && item.exitCode !== null ? '\n退出码：' + esc(item.exitCode) : ''}</pre></details>`;
    }
    if (item.type === 'fileChange')
        return `<details class="tool-item" data-item-id="${esc(item.id)}"><summary>${icon('file', 16)}修改文件 <span class="badge">${(item.changes || []).length} 个文件 · ${esc(statusNames[item.status] || item.status || '处理中')}</span></summary>${(item.changes || []).map(c => `<div class="tool-detail mono">${esc(c.path)}</div><pre>${esc(c.diff || JSON.stringify(c.kind || {}))}</pre>`).join('')}</details>`;
    if (item.type === 'mcpToolCall')
        return `<details class="tool-item" data-item-id="${esc(item.id)}"><summary>${icon('plug', 16)}${esc(item.server || 'MCP')} / ${esc(item.tool || '工具调用')}<span class="badge">${esc(statusNames[item.status] || item.status || '处理中')}</span></summary><pre>${esc(JSON.stringify({ arguments: item.arguments, result: item.result, error: item.error }, null, 2))}</pre></details>`;
    if (item.type === 'webSearch')
        return `<details class="tool-item" data-item-id="${esc(item.id)}"><summary>${icon('globe', 16)}网页检索</summary><pre>${esc(item.query || JSON.stringify(item.action || {}))}</pre></details>`;
    return `<details class="tool-item" data-item-id="${esc(item.id)}"><summary>${icon('grid', 15)}${esc(item.type || '工具事件')}</summary><pre>${esc(JSON.stringify(item, null, 2))}</pre></details>`;
}
function renderTranscript() { const stage = $('#chat-stage'); if (!stage || view !== 'chat')
    return; const bottom = stage.scrollHeight - stage.scrollTop - stage.clientHeight < 150, scroll = stage.scrollTop; const openIds = [...stage.querySelectorAll('details[open]')].map(d => d.dataset.itemId); stage.innerHTML = transcriptOrWelcome(); for (const details of stage.querySelectorAll('details'))
    if (openIds.includes(details.dataset.itemId))
        details.open = true; if (bottom)
    stage.scrollTop = stage.scrollHeight;
else
    stage.scrollTop = scroll; renderApprovalBanner(); }
function approvalBanner() { const count = state.approvals.length; return count ? `<div class="approval-banner"><span class="row">${icon('shield', 17)}${count} 项操作等待你的确认</span>${btn('查看并处理', 'approvals')}</div>` : ''; }
function renderApprovalBanner() { const n = $('#approval-banner'); if (n)
    n.innerHTML = approvalBanner(); }
function page(title, subtitle, content, actions = '') { return `<div class="page"><div class="page-inner"><div class="page-head"><div><h1>${title}</h1>${subtitle ? `<p class="page-subtitle">${subtitle}</p>` : ''}</div>${actions ? `<div class="row">${actions}</div>` : ''}</div>${content}</div></div>`; }
function settingRow(title, description, control) { return `<div class="setting-row"><div class="grow"><h3>${title}</h3><p>${description}</p></div><div class="control">${control}</div></div>`; }
function logText() { return state.logs.map(l => new Date(l.time).toLocaleTimeString('zh-CN') + ' ' + l.text).join('\n') || '尚无运行日志。连接内核后将在此显示脱敏诊断信息。'; }
function settingsView() {
    const s = state.settings;
    if (settingsTab === 'providers')
        return providersView();
    if (settingsTab === 'appearance')
        return page('外观', '让工作台保持你喜欢的样子。', `<div class="theme-options">${[['light', 'sun', '浅色'], ['dark', 'moon', '深色'], ['system', 'laptop', '跟随系统']].map(([v, i, n]) => `<button class="theme-card ${s.theme === v ? 'active' : ''}" data-action="set-theme" data-value="${v}">${icon(i, 25)}<strong>${n}</strong>${s.theme === v ? icon('check', 16) : ''}</button>`).join('')}</div><div class="notice" style="margin-top:25px">推理强度为 Ultra 时，文字和滑块使用紫色。加速开关目前仅保存界面偏好，不发送加速或计费参数。</div>`);
    if (settingsTab === 'storage')
        return page('数据与存储', '记录保存在这台电脑上，不上传到 AstroGate 云端。', `<div class="setting-group">${settingRow('应用数据目录', `<span class="mono">${esc(state.runtime.dataDir)}</span>`, btn('打开目录', 'open-data'))}${settingRow('对话与项目', '项目路径、会话消息、供应商配置和技能分别保存；凭据独立加密存放。', `<span class="badge">${state.sessions.length} 个会话 / ${state.projects.length} 个项目</span>`)}${settingRow('导出记录', '导出不包含已保存的 API Key、官方登录态和 MCP 凭据，但对话中可能有私有代码或你自行输入的秘密。', btn('导出 JSON', 'export-data'))}</div><div class="notice">原来的 CC Switch 数据及用户目录下的 .codex 不会被覆盖。每个供应商使用本应用独立的 CODEX_HOME；导入本机配置只执行读取与复制。</div>`);
    if (settingsTab === 'about')
        return page('关于与诊断', 'AstroGate Codex Desktop · 0.1.0', `<div class="setting-group">${settingRow('本地编程工作台', '独立实现的图形客户端，接入开源 Codex App Server，并兼容 CC Switch Codex 中转配置。不是官方桌面应用的修改版。', `<span class="badge">MIT</span>`)}${settingRow('目标内核版本', '协议适配基于 Codex 0.162.1。更换内核版本后，需要重新检查协议兼容性。', `<span class="badge">${esc(state.runtime.expectedCodex)}</span>`)}${settingRow('本机环境', `${esc(state.runtime.platform)} / ${esc(state.runtime.arch)} · Node ${esc(state.runtime.node)}`, btn('连接内核', 'connect'))}${settingRow('缺少内核？', '关闭此页前先运行压缩包中的 Install-Engine.cmd，或在常规设置中选择 codex.exe。安装内核需要联网。', btn('内核设置', 'settings-general'))}</div><h2 class="section-title">运行日志</h2><pre class="diagnostic-log" id="runtime-log">${esc(logText())}</pre><div class="notice">没有内置 API Key，不会模拟模型回复或剩余额度。外部插件、官方应用目录和模型可用性取决于实际内核、账号与供应商。</div>`);
    return page('常规', '管理本机环境、工作目录与操作权限。', `<h2 class="section-title">权限</h2><div class="setting-group">${settingRow('默认任务权限', '工作区访问允许内核在项目中操作，必要时请求审批。只读模式更保守。', `<select id="default-permission"><option value="workspace-write" ${s.defaultPermission === 'workspace-write' ? 'selected' : ''}>工作区访问</option><option value="read-only" ${s.defaultPermission === 'read-only' ? 'selected' : ''}>只读访问</option></select>`)}${settingRow('完全访问权限', '不默认开启。切换后，每次发送任务都必须明确确认：内核可以修改工作区外的文件并访问网络。', `<span class="badge">逐次确认</span>`)}${state.runtime.platform === 'win32' ? settingRow('Windows 沙箱', '由 Codex 内核执行非提权沙箱初始化；可能弹出 Windows 系统窗口。', btn('初始化沙箱', 'setup-sandbox')) : ''}</div><h2 class="section-title">本地环境</h2><div class="setting-group">${settingRow('无项目任务文件夹', `<span class="mono">${esc(s.workspace)}</span>`, btn('更改', 'workspace-edit'))}${settingRow('Codex 可执行文件', `<span class="mono">${esc(s.codexPath || '自动发现：内置运行时 / 本机安装 / PATH')}</span>`, btn('配置路径', 'codex-path'))}${settingRow('显示名称', '仅用于本地界面，不创建云端账号。', btn(esc(s.displayName), 'display-name'))}${settingRow('供应商', '在同一个图形界面内添加和切换 API 中转，不需要手工编辑 TOML。', btn('管理供应商', 'providers'))}${settingRow('加速界面开关', '按设计保留闪电图标，不改变实际模型请求、速度或费用。', `<button class="switch ${s.acceleration ? 'on' : ''}" role="switch" aria-checked="${s.acceleration}" data-action="toggle-acceleration"><span></span></button>`)}</div>`);
}
function providersView() { return page('模型供应商', '添加 GPT 中转地址与 Key，使用同一个 Codex 工作台。', `<div class="provider-mode"><span class="pill">${icon('plug', 14)}直连</span><span class="small muted">${esc(state.providers.find(p => p.id === state.activeProviderId)?.name)} · 独立配置，不覆盖原 Codex</span></div><div class="provider-list">${state.providers.map(p => { const active = p.id === state.activeProviderId, u = state.usage[p.id]; return `<article class="provider-card ${active ? 'active' : ''}"><div class="provider-icon">${p.kind === 'official' ? icon('cloud', 23) : esc(p.name.slice(0, 1).toUpperCase())}</div><div class="provider-main"><div class="provider-name">${esc(p.name)} <span class="badge">${p.kind === 'official' ? '官方登录' : 'Responses'}</span></div><div class="provider-desc truncate">${p.kind === 'official' ? '独立官方登录态 · 可连接本机 Codex 内核' : esc(p.baseUrl)}</div><div class="provider-desc">${p.kind === 'relay' ? `${p.hasKey ? 'Key 已加密保存' : '尚未填写 Key'} · ${esc(p.defaultModel)}` : '通过内核提供的官方登录页授权'}</div></div>${u ? `<span class="provider-usage">剩余 ${u.percent === null ? '—' : Math.round(u.percent) + '%'}</span>` : ''}${active ? '<span class="provider-active-label">● 使用中</span>' : ib('play', 'select-provider', '使用此供应商', `data-id="${p.id}"`)}${ib('edit', 'edit-provider', '编辑供应商', `data-id="${p.id}"`)}${ib('more', 'provider-menu', '更多操作', `data-id="${p.id}" data-popover`)}</article>`; }).join('')}</div><div class="notice"><strong>连接提示</strong><br>Base URL 应填写供应商给出的 API 根路径（通常以 /v1 结尾），不要填写完整的 /responses 地址。必须支持 Responses 与 Codex 所需的工具调用；仅有 Chat Completions 的接口无法直接替代。模型 ID 以供应商实际提供的为准。</div>`, `${btn(`${icon('download', 15)}导入`, 'import-providers')}${btn(`${icon('plus', 15)}添加供应商`, 'add-provider', 'orange')}`); }
function extensionsView() {
    if (extensionTab === 'skills')
        return page('技能', '把可复用的任务说明保存为 SKILL.md，供 Codex 内核发现。', `<div class="plugin-grid">${state.skills.map(s => `<article class="plugin-card"><span class="plugin-icon">${icon('code', 24)}</span><div class="grow"><h3>${esc(s.name)}</h3><p>本地技能 · 已同步到独立内核目录</p><div class="row">${btn('编辑', 'edit-skill', '', `data-name="${s.name}"`)}${ib('trash', 'delete-skill', '删除技能', `data-name="${s.name}"`)}</div></div></article>`).join('')}</div>${!state.skills.length ? emptyState('code', '将常用工作流变成技能', '添加规范、检查清单或项目操作指引，减少重复说明。', '添加技能', 'add-skill') : ''}<div class="notice">技能是给模型的指引，不是权限边界。启用后仍应审查模型的操作请求，不要在技能文件里写入秘密。</div>`, btn(`${icon('plus', 15)}添加技能`, 'add-skill', 'primary'));
    if (extensionTab === 'apps')
        return page('官方应用目录', '从实际内核获取账号可用的应用，而不是静态展示已安装状态。', `${appsData ? `<pre class="diagnostic-log">${esc(JSON.stringify(appsData, null, 2))}</pre>` : emptyState('globe', '连接你的官方账号', '该入口读取 app/list 返回的实际目录。应用安装、授权请在官方界面完成；这里不会冒充官方插件市场。', '加载目录', 'load-apps')}<div class="notice">API 中转不等于官方账号授权。供应商不支持该接口、账号没有权限或内核不兼容时，会显示实际错误。</div>`, btn('刷新目录', 'load-apps'));
    return page('MCP 插件', '连接本地工具或远程 MCP 服务，让 Codex 与你的工具协同工作。', `<div class="plugin-grid">${state.mcp.map(m => `<article class="plugin-card"><span class="plugin-icon">${icon('plug', 23)}</span><div class="grow"><div class="between"><h3>${esc(m.name)}</h3><button class="switch ${m.enabled ? 'on' : ''}" role="switch" aria-label="启用 ${esc(m.name)}" aria-checked="${m.enabled}" data-action="toggle-mcp" data-id="${m.id}"><span></span></button></div><p>${esc(m.description || m.url || [m.command, ...(m.args || [])].join(' '))}</p><div class="row"><span class="badge">${esc(m.transport)}</span>${btn('编辑', 'edit-mcp', '', `data-id="${m.id}"`)}${ib('trash', 'delete-mcp', '移除插件', `data-id="${m.id}"`)}</div></div></article>`).join('')}</div>${!state.mcp.length ? emptyState('plug', '工具，从这里接入', '支持 stdio 本地命令与 HTTP MCP；每个插件都由你明确添加和启用。', '添加 MCP', 'add-mcp') : ''}${mcpStatus ? `<h2 class="section-title">内核返回的插件状态</h2><pre class="diagnostic-log">${esc(JSON.stringify(mcpStatus, null, 2))}</pre>` : ''}<div class="notice">启用本地 MCP 可能在你的电脑运行命令。请仅添加可信来源；本应用不会自动安装任意市场插件，或执行 CC Switch 导入数据里的 JavaScript 额度脚本。</div>`, `${btn('检查状态', 'mcp-status')}${btn(`${icon('plus', 15)}添加 MCP`, 'add-mcp', 'primary')}`);
}
function emptyState(i, title, description, label, action) { return `<div class="empty-state">${icon(i, 35)}<h2>${title}</h2><p>${description}</p>${label ? btn(label, action) : ''}</div>`; }
function usageView() { const p = state.providers.find(p => p.id === state.activeProviderId), u = state.usage[p.id], percent = u?.percent; return page('使用情况', '额度百分比来自供应商或官方内核，未返回的数据不作估算。', `<div class="usage-hero"><div class="usage-ring" style="--percent:${Number.isFinite(percent) ? percent : 0}"><div><strong>${Number.isFinite(percent) ? Math.round(percent) + '%' : '—'}</strong><small>剩余额度</small></div></div><div class="grow"><span class="badge">${p.kind === 'relay' ? '中转供应商' : '官方账号'}</span><h2>${esc(p.name)}</h2><p>${esc(u?.reason || (!u ? '点击刷新，从真实接口读取。' : '已读取供应商返回的数据。'))}</p><div class="small muted">${u?.updatedAt ? '更新时间：' + fmtDate(u.updatedAt) : '尚未查询'}</div>${u?.remaining !== undefined && u?.remaining !== null ? `<div class="small" style="margin-top:8px">剩余 ${esc(u.remaining)} / 总量 ${esc(u.total ?? '未提供')} ${esc(p.usage?.unit || '')}</div>` : ''}</div></div>${u?.windows?.length ? `<div class="setting-group" style="margin-top:20px">${u.windows.map(w => settingRow(esc(w.bucket), w.window === 'primary' ? '主要配额窗口' : '次要配额窗口', `剩余 ${Math.max(0, 100 - w.usedPercent).toFixed(1)}%`)).join('')}</div>` : ''}<h2 class="section-title">本地任务记录</h2><div class="setting-group">${settingRow('累计会话', '这是本应用的本地记录，不等于供应商账单。', `<strong>${state.sessions.length}</strong>`)}${settingRow('没有统一的中转额度接口', '在供应商编辑页配置额度 URL 与 JSON 字段路径。缺少总量和剩余量、或者接口未提供百分比时，显示“—”。', btn('配置额度接口', 'edit-provider', '', `data-id="${p.id}"`))}</div>`, btn(`${icon('refresh', 15)}刷新额度`, 'refresh-usage', '', `data-id="${p.id}"`)); }
function historyView() { const q = historyFilter.toLowerCase(), items = state.sessions.filter(s => !!s.archived === historyArchived && (!q || s.title.toLowerCase().includes(q))).sort((a, b) => b.updatedAt - a.updatedAt); return page(historyArchived ? '归档聊天' : '会话记录', '按最近一次任务时间排序；查看旧会话不会把它自动置顶。', `<div class="row" style="margin-bottom:20px"><input id="history-search" placeholder="搜索会话名称" value="${esc(historyFilter)}" class="grow"><span class="badge">${items.length} 个会话</span></div><div class="history-list">${items.map(s => `<div class="history-row"><button class="grow" data-action="open-session" data-id="${s.id}"><strong>${esc(s.title)}</strong><small>${esc(state.projects.find(p => p.id === s.projectId)?.name || '无项目')} · ${esc(state.providers.find(p => p.id === s.providerId)?.name || '')} · ${esc(statusNames[s.status] || s.status)}</small></button><span class="small muted">${fmtDate(s.updatedAt)}</span>${ib('more', 'session-menu', '会话操作', `data-id="${s.id}" data-popover`)}</div>`).join('')}</div>${!items.length ? emptyState('history', '这里还没有会话', historyArchived ? '归档的会话会在这里保留。' : '从工作台发送第一条开发任务。', '返回工作台', 'go-chat') : ''}`, btn(historyArchived ? '查看最近' : '查看归档', historyArchived ? 'history' : 'archived')); }
function closePopover() { popRoot.innerHTML = ''; popover = null; }
function openPopover(anchor, html, kind = '', width = 250) { closePopover(); const n = document.createElement('div'); n.className = `popover ${kind}`; n.style.width = width + 'px'; n.innerHTML = html; popRoot.append(n); const rect = anchor?.getBoundingClientRect() || { left: 70, right: 70, top: 70, bottom: 90 }; const h = n.offsetHeight; let x = rect.right - width, y = rect.bottom + 7; if (y + h > innerHeight - 12)
    y = Math.max(12, rect.top - h - 8); x = Math.max(10, Math.min(x, innerWidth - width - 10)); n.style.left = x + 'px'; n.style.top = y + 'px'; popover = { node: n, anchor, kind }; return n; }
function menuItem(i, label, action, extra = '', tail = '', danger = false) { return `<button class="menu-item ${danger ? 'danger' : ''}" data-action="${action}" ${extra}>${icon(i, 16)}<span>${label}</span>${tail ? `<small>${tail}</small>` : ''}</button>`; }
function closeModal(result = false) { modalRoot.innerHTML = ''; const r = modalResolver; modalResolver = null; if (r)
    r(result); }
function modal(title, body, footer, cls = '') { closePopover(); closeModal(); modalRoot.innerHTML = `<div class="modal-backdrop"><section class="modal ${cls}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-header"><h2>${esc(title)}</h2>${ib('close', 'close-modal', '关闭')}</div><div class="modal-body"><div class="form-error" id="form-error"></div>${body}</div><div class="modal-footer">${footer}</div></section></div>`; requestAnimationFrame(() => modalRoot.querySelector('input:not([type=checkbox]),textarea,select,button')?.focus()); }
function confirmDialog(title, message, accept = '确认', danger = false) { modal(title, `<p class="confirm-text">${esc(message)}</p>`, `${btn('取消', 'close-modal')}${btn(accept, 'confirm-modal', danger ? 'danger' : 'primary')}`, 'small-modal'); return new Promise(resolve => modalResolver = resolve); }
function formModal(title, body, onSubmit, { submit = '保存', cls = '' } = {}) { modal(title, `<form id="modal-form">${body}</form>`, `${btn('取消', 'close-modal')}<button class="btn primary" type="submit" form="modal-form">${submit}</button>`, cls); $('#modal-form').addEventListener('submit', async (event) => { event.preventDefault(); const f = event.currentTarget, b = modalRoot.querySelector('[type=submit]'), err = $('#form-error'); err.textContent = ''; b.disabled = true; try {
    await onSubmit(new FormData(f), f);
    closeModal();
    await syncState();
}
catch (e) {
    err.textContent = e.message;
    b.disabled = false;
    err.scrollIntoView({ block: 'nearest' });
} }); }
function field(name, label, value = '', help = '', opts = {}) { return `<div class="form-field ${opts.full ? 'full' : ''}"><label for="form-${name}">${label}</label>${opts.textarea ? `<textarea id="form-${name}" name="${name}" rows="${opts.rows || 4}" class="${opts.code ? 'code-input' : ''}" ${opts.required ? 'required' : ''}>${esc(value)}</textarea>` : `<input id="form-${name}" name="${name}" type="${opts.type || 'text'}" value="${esc(value)}" ${opts.required ? 'required' : ''} ${opts.placeholder ? `placeholder="${esc(opts.placeholder)}"` : ''} autocomplete="off">`}${help ? `<div class="help">${help}</div>` : ''}</div>`; }
function editProvider(id) { const p = state.providers.find(p => p.id === id) || { kind: 'relay', name: '', baseUrl: '', models: presetModels, defaultModel: 'gpt-6-sol', effort: 'high' }, u = p.usage || {}; formModal(id ? '编辑供应商' : '添加供应商', `<div class="form-grid">${field('name', '供应商名称', p.name, '', { required: true })}<div class="form-field"><label>类型</label><select name="kind"><option value="relay" ${p.kind === 'relay' ? 'selected' : ''}>GPT / Responses 中转</option><option value="official" ${p.kind === 'official' ? 'selected' : ''}>官方 ChatGPT 登录</option></select></div>${field('baseUrl', 'Base URL', p.baseUrl, '填写 API 根路径，不要附加 /responses。官方登录类型忽略此字段。', { full: true, placeholder: 'https://api.example.com/v1' })}<div class="form-field full"><label>API Key</label><div class="input-with-btn"><input name="apiKey" id="form-apiKey" type="password" autocomplete="new-password" placeholder="${p.hasKey ? '已加密保存，留空表示不修改' : '仅保存在本机，不要发给其他人'}">${ib('eye', 'toggle-secret', '显示 / 隐藏', `data-target="form-apiKey"`)}</div></div>${field('defaultModel', '默认模型 ID', p.defaultModel, '必须是上游接受的实际 ID，不是显示名称。', { required: true })}<div class="form-field"><label>默认推理强度</label><select name="effort">${Object.entries(effortNames).map(([v, n]) => `<option value="${v}" ${p.effort === v ? 'selected' : ''}>${n} (${v})</option>`).join('')}</select></div>${field('models', '模型列表', (p.models || []).map(m => `${m.id} | ${m.label}`).join('\n'), '每行：模型 ID | 显示名称。截图预设仅方便展示，不保证账号有权限。', { full: true, textarea: true, rows: 6, code: true })}${field('notes', '备注', p.notes || '', '', { full: true })}<label class="checkbox-label form-field full"><span class="row"><input type="checkbox" name="allowInsecure" ${p.allowInsecure ? 'checked' : ''}>允许远端 HTTP（不安全；Key 将明文传输，建议仅测试网络使用）</span></label></div><details class="advanced" ${u.url ? 'open' : ''}><summary>额度百分比：接口与字段映射</summary><div class="form-grid">${field('usageUrl', '额度查询 URL', u.url || '', '仅发送 GET，不执行供应商脚本；留空表示不提供额度。', { full: true })}<div class="form-field"><label>额度接口认证</label><select name="usageAuth">${[['provider', '与模型相同 Key（必须同源）'], ['custom', '独立额度 Key'], ['none', '无需认证']].map(([v, n]) => `<option value="${v}" ${u.auth === v ? 'selected' : ''}>${n}</option>`).join('')}</select></div>${field('usageKey', '独立额度 Key', '', '留空保留已有额度凭据。', { type: 'password' })}${field('percentPath', '剩余百分比字段', u.percentPath || '', '例如 data.remaining_percent；必须为 0–100。')}${field('unit', '额度单位', u.unit || '额度')}${field('totalPath', '总量字段', u.totalPath || '', '例如 data.total')}${field('remainingPath', '剩余量字段', u.remainingPath || '', '例如 data.remaining')}${field('usedPath', '已用量字段', u.usedPath || '', '无剩余量时，使用 总量 − 已用量。')}</div></details>`, async (f) => { const models = f.get('models').split('\n').filter(l => l.trim()).map(line => { const [i, ...label] = line.split('|'); const old = (p.models || []).find(m => m.id === i.trim()); return { ...old, id: i.trim(), label: label.join('|').trim() || i.trim(), source: old?.source || 'manual' }; }); await api('provider/save', { id: p.id, kind: f.get('kind'), name: f.get('name'), baseUrl: f.get('baseUrl'), apiKey: f.get('apiKey'), defaultModel: f.get('defaultModel'), effort: f.get('effort'), models, notes: f.get('notes'), allowInsecure: f.has('allowInsecure'), usageKey: f.get('usageKey'), usage: f.get('usageUrl').trim() ? { url: f.get('usageUrl'), auth: f.get('usageAuth'), percentPath: f.get('percentPath'), totalPath: f.get('totalPath'), remainingPath: f.get('remainingPath'), usedPath: f.get('usedPath'), unit: f.get('unit') } : null }); toast('供应商已保存。'); }); }
function importProviders() { formModal('导入 CC Switch 配置', `<div class="notice" style="margin-bottom:15px">支持包含 settingsConfig.auth / config 的 JSON 单项或供应商集合。不支持直接导入 SQLite / SQL 数据库备份，也不会执行用量脚本。</div><div class="row" style="margin-bottom:12px"><input id="import-json-file" type="file" accept=".json,application/json" class="grow"></div>${field('json', '供应商 JSON', '', '内容可能包含密钥，只在本机读取。', { textarea: true, rows: 11, code: true, required: true })}`, async (f) => { let data; try {
    data = JSON.parse(f.get('json'));
}
catch {
    throw new Error('JSON 格式不正确。');
} const result = await api('provider/import', { data }); toast(`已导入 ${result.count} 个供应商。${result.warnings.length ? '\n' + result.warnings.join('\n') : ''}`, !result.count); }, { submit: '导入' }); $('#import-json-file').addEventListener('change', async (e) => { const file = e.target.files[0]; if (!file)
    return; if (file.size > 3e6)
    return toast('文件不能超过 3 MB。', true); $('#form-json').value = await file.text(); }); }
function editProject(id, section = '项目') { const p = state.projects.find(p => p.id === id) || {}; formModal(id ? '编辑项目' : '添加项目', `<div class="form-grid">${field('name', '项目名称', p.name || '', '可留空，使用文件夹名。', { full: true })}<div class="form-field full"><label>本机项目文件夹</label><div class="input-with-btn"><input id="form-project-path" name="path" value="${esc(p.path || '')}" placeholder="D:\\Projects\\my-app" required>${btn('选择', 'browse-path', '', `data-target="form-project-path"`)}</div><div class="help">选择已有的绝对路径。不上传整个项目，文件操作由你本机的内核执行。</div></div>${field('section', '分区', p.section || section, '不同分区会在侧栏分组显示。', { full: true })}</div>`, async (f) => { const result = await api('project/save', { id: p.id, name: f.get('name'), path: f.get('path'), section: f.get('section') || '项目' }); selectedProjectId = result.id; expandedProjects.add(result.id); if (!id) {
    selectedSessionId = null;
    currentSession = null;
    view = 'chat';
} toast('项目已添加到本地工作台。'); }); }
function editMcp(id) { const p = state.mcp.find(p => p.id === id) || { transport: 'stdio', enabled: false }; formModal(id ? '编辑 MCP 插件' : '添加 MCP 插件', `<div class="form-grid">${field('name', '插件 ID', p.name || '', '字母、数字、横线或下划线。', { required: true })}<div class="form-field"><label>连接类型</label><select name="transport"><option value="stdio" ${p.transport === 'stdio' ? 'selected' : ''}>stdio · 本地命令</option><option value="http" ${p.transport === 'http' ? 'selected' : ''}>HTTP · 远程服务</option></select></div>${field('description', '说明', p.description || '', '', { full: true })}${field('command', '本地命令', p.command || '', '例如 npx 或可执行文件路径。不是整段 Shell 命令。', { full: true })}${field('args', '命令参数（JSON 数组）', JSON.stringify(p.args || []), '例如 ["-y", "@vendor/mcp-server"]', { full: true, textarea: true, code: true, rows: 2 })}${field('url', 'HTTP MCP URL', p.url || '', '远程服务必须 HTTPS，或者是本地环回 HTTP。', { full: true })}${field('token', 'HTTP Bearer Token', '', '留空不修改已保存值。', { type: 'password', full: true })}${field('env', '本地环境变量（JSON 对象）', '', '留空保留；填 {} 可清空。值均须是字符串。', { full: true, textarea: true, code: true, rows: 3 })}<label class="checkbox-label form-field full"><span class="row"><input name="enabled" type="checkbox" ${p.enabled ? 'checked' : ''}>启用此插件</span></label><label class="checkbox-label form-field full"><span class="row"><input name="trusted" type="checkbox" required>我信任该工具来源，理解启用本地插件会启动其命令；远程插件可接收模型发送的数据。</span></label></div>`, async (f) => { let args, env; try {
    args = JSON.parse(f.get('args'));
    env = f.get('env').trim() ? JSON.parse(f.get('env')) : undefined;
}
catch {
    throw new Error('参数或环境变量 JSON 格式错误。');
} await api('mcp/save', { id: p.id, name: f.get('name'), transport: f.get('transport'), description: f.get('description'), command: f.get('command'), args, url: f.get('url'), token: f.get('token'), ...(env !== undefined ? { env } : {}), enabled: f.has('enabled'), trusted: f.has('trusted') }); toast('插件配置已保存，下次连接内核时生效。'); }); }
async function editSkill(name) { const skill = name ? await api('skill?name=' + encodeURIComponent(name)) : null; formModal(name ? '编辑技能' : '添加技能', `<div class="form-grid">${field('name', '技能文件夹名称', name || '', '仅字母、数字、下划线、横线。', { full: true, required: true })}${field('content', 'SKILL.md 内容', skill?.content || '---\nname: my-skill\ndescription: 描述何时使用此技能\n---\n\n# 工作步骤\n\n1. 先检查项目结构。\n2. 明确修改范围。\n3. 执行测试并报告结果。\n', '技能会同步至各供应商的独立 Codex 目录。', { full: true, textarea: true, rows: 15, code: true, required: true })}</div>`, async (f) => { if (name && f.get('name') !== name)
    throw new Error('编辑时不能改文件夹名，请新建另一个技能。'); await api('skill/save', { name: f.get('name'), content: f.get('content') }); toast('技能已保存。'); }, { cls: 'wide' }); }
function textEdit(title, name, value, onSave, description = '') { formModal(title, field(name, title, value, description, { full: true, required: true }), async (f) => { await onSave(f.get(name)); }); }
function projectMenu(anchor, id) { const p = state.projects.find(p => p.id === id); openPopover(anchor, menuItem('pin', p.pinned ? '取消置顶' : '置顶', 'pin-project', `data-id="${id}"`) + menuItem('edit', '编辑 / 分区', 'edit-project', `data-id="${id}"`) + '<hr>' + menuItem('folder', '在资源管理器中打开', 'open-project', `data-id="${id}"`) + menuItem('archive', '归档项目聊天', 'archive-project', `data-id="${id}"`) + '<hr>' + menuItem('close', '移除项目', 'remove-project', `data-id="${id}"`, '', true)); }
function sessionMenu(anchor, id) { const s = state.sessions.find(s => s.id === id); if (!s)
    return; openPopover(anchor, menuItem('pin', s.pinned ? '取消置顶' : '置顶', 'pin-session', `data-id="${id}"`) + menuItem('edit', '重命名', 'rename-session', `data-id="${id}"`) + menuItem('download', '导出会话', 'export-session', `data-id="${id}"`) + '<hr>' + menuItem('archive', s.archived ? '恢复会话' : '归档会话', 'archive-session', `data-id="${id}"`)); }
function providerMenu(anchor, id) { const p = state.providers.find(p => p.id === id); openPopover(anchor, (p.kind === 'official' ? menuItem('key', '官方登录', 'official-login', `data-id="${id}"`) + menuItem('download', '复制本机官方登录态', 'import-auth', `data-id="${id}"`) : menuItem('globe', '获取模型 / 测试连接', 'test-provider', `data-id="${id}"`) + menuItem('download', '导出 CC Switch 配置', 'export-provider', `data-id="${id}"`)) + menuItem('meter', '查询额度', 'refresh-usage', `data-id="${id}"`) + '<hr>' + menuItem('trash', '移除供应商', 'delete-provider', `data-id="${id}"`, '', true)); }
function modelMenu(anchor) { const n = openPopover(anchor, `<input class="model-search" id="model-search" placeholder="搜索或输入模型 ID"><div class="menu-label">选择模型 · 截图预设不代表实际可用</div><div id="model-options"></div><hr>${menuItem('refresh', '从内核读取可用模型', 'load-models')}<div class="input-with-btn" style="padding:5px"><input id="custom-model" style="font-size:11px;width:100%" placeholder="上游实际模型 ID">${btn('使用', 'custom-model')}</div>`, 'model-menu', 300); renderModelOptions(''); n.querySelector('#model-search').addEventListener('input', e => renderModelOptions(e.target.value)); }
function renderModelOptions(q) { const options = $('#model-options'); if (!options)
    return; options.innerHTML = activeModels().filter(m => (m.label + ' ' + m.id).toLowerCase().includes(q.toLowerCase())).map(m => `<button class="model-option" data-action="set-model" data-value="${esc(m.id)}"><span>${esc(m.label)}<small class="model-source">${m.source === 'codex' ? '内核目录' : m.source === 'api' ? '供应商 /models' : m.source === 'preset' ? '截图预设 · 需上游支持' : '自定义配置'}</small></span>${model === m.id ? `<span class="check-mark">${icon('check', 15)}</span>` : ''}</button>`).join('') || '<div class="menu-label">没有匹配项，可在下方输入模型 ID。</div>'; }
function effortMenu(anchor) {
    const found = activeModels().find(m => m.id === model), choices = found?.efforts?.length ? found.efforts : ['low', 'medium', 'high', 'xhigh', 'ultra'];
    const current = Math.max(0, choices.indexOf(effort));
    const n = openPopover(anchor, `<div class="effort-top">${ib('bolt', 'toggle-acceleration', '加速界面开关', state.settings.acceleration ? 'style="color:var(--purple)"' : '')}<div><div class="effort-title ${effort === 'ultra' ? 'ultra-text' : ''}" id="effort-name">${esc(effortNames[effort] || effort)}</div><span class="effort-model">${esc(modelLabel())}</span></div>${ib('refresh', 'reset-effort', '重置强度')}</div><div class="effort-track ${effort === 'ultra' ? 'ultra' : ''}" id="effort-track"><input id="effort-slider" type="range" min="0" max="${choices.length - 1}" step="1" value="${current}" style="--fill:${choices.length < 2 ? 100 : current / (choices.length - 1) * 100}%" aria-label="推理强度"></div><div class="effort-foot">${found?.efforts?.length ? '按模型目录显示可用强度。' : '预设档位需要上游支持；不支持时返回错误，不偷偷降级。'}<br>⚡ 加速仅为界面预留。</div>`, 'effort-menu', 286);
    const slider = n.querySelector('#effort-slider');
    slider.addEventListener('input', () => { effort = choices[+slider.value]; $('#effort-name').textContent = effortNames[effort] || effort; $('#effort-name').classList.toggle('ultra-text', effort === 'ultra'); $('#effort-track').classList.toggle('ultra', effort === 'ultra'); slider.style.setProperty('--fill', `${choices.length < 2 ? 100 : +slider.value / (choices.length - 1) * 100}%`); render(); });
    slider.addEventListener('change', () => { if (!state.running)
        api('settings', { effort }).then(() => scheduleSync()).catch(e => toast(e.message, true)); });
}
function permissionMenu(anchor) { const options = [['read-only', '只读访问', '只读检查项目；修改和额外权限请求仍由内核策略决定。'], ['workspace-write', '工作区访问', '在项目工作区中操作，额外权限由你审批。'], ['danger-full-access', '完全访问', '每次任务单独确认，允许工作区外文件和网络访问。']]; openPopover(anchor, options.map(([v, n, d]) => `<button class="permission-option ${v === 'danger-full-access' ? 'full' : ''}" data-action="set-permission" data-value="${v}">${icon('shield', 17)}<span><strong>${n}</strong><p>${d}</p></span>${permission === v ? `<span class="check-mark">${icon('check', 15)}</span>` : ''}</button>`).join(''), 'permission-menu', 320); }
function chooseProject(anchor) { openPopover(anchor, `<div class="menu-label">选择本机项目</div>${menuItem('laptop', '无项目工作区', 'choose-project-id', `data-id=""`)}${state.projects.map(p => menuItem('folder', esc(p.name), 'choose-project-id', `data-id="${p.id}"`)).join('')}<hr>${menuItem('plus', '添加新项目', 'add-project')}`, '', 270); }
function profileMenu(anchor) { const p = activeProvider(), u = state.usage[p.id]; openPopover(anchor, `<div class="profile-info"><img class="avatar" src="/assets/profile-avatar.png" alt=""><div><strong>${esc(state.settings.displayName)}</strong><small>本地工作台 · 无云端账户</small></div></div><hr>${menuItem('meter', '使用情况', 'usage', '', `剩余 ${Number.isFinite(u?.percent) ? Math.round(u.percent) + '%' : '未提供'}`)}${menuItem('settings', '设置', 'settings')}${menuItem('info', '关于与诊断', 'about')}<hr>${menuItem('close', '退出本地服务', 'quit', '', '', true)}`, 'profile-menu', 270); }
async function openSession(id) { closePopover(); const s = await api('session?id=' + encodeURIComponent(id)); selectedSessionId = s.id; currentSession = s; selectedProjectId = s.projectId; model = s.model; effort = s.effort; permission = state.settings.defaultPermission; view = 'chat'; render(); }
function newChat(projectId = selectedProjectId) { closePopover(); selectedSessionId = null; currentSession = null; selectedProjectId = projectId || null; view = 'chat'; model = state.providers.find(p => p.id === state.activeProviderId)?.defaultModel || state.settings.model; effort = state.settings.effort; permission = state.settings.defaultPermission; render(); $('#prompt')?.focus(); }
function resizePrompt() { const p = $('#prompt'); if (!p)
    return; p.style.height = 'auto'; p.style.height = Math.min(180, Math.max(50, p.scrollHeight)) + 'px'; const b = $('#send-button'); if (b)
    b.disabled = !draft.trim() && !state?.running && !sending; }
async function sendMessage() {
    if (sending || state.running || !draft.trim())
        return;
    let fullAccessConfirmed = false;
    if (permission === 'danger-full-access') {
        fullAccessConfirmed = await confirmDialog('允许本次任务完全访问？', '内核将不受工作区范围限制，可以修改电脑上的文件、执行命令和访问网络。请确保任务、项目和 MCP 来源可信。此授权仅针对你现在发送的这一轮任务。', '授权并发送', true);
        if (!fullAccessConfirmed)
            return;
    }
    const original = draft, files = attachments.map(a => ({ ...a }));
    sending = true;
    draft = '';
    attachments = [];
    render();
    try {
        const result = await api('send', { sessionId: selectedSessionId, projectId: selectedProjectId, providerId: activeProvider().id, text: original, attachments: files, model, effort, permission, fullAccessConfirmed });
        selectedSessionId = result.sessionId;
        currentSession = await api('session?id=' + result.sessionId);
    }
    catch (e) {
        if (e.sessionId) {
            selectedSessionId = e.sessionId;
            currentSession = await api('session?id=' + e.sessionId);
        }
        else {
            draft = original;
            attachments = files;
        }
        toast(e.message, true);
    }
    finally {
        sending = false;
        await syncState();
    }
}
function attachFiles() { const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.accept = '.txt,.md,.js,.mjs,.cjs,.ts,.tsx,.jsx,.json,.py,.java,.kt,.vue,.css,.html,.xml,.yml,.yaml,.toml,.sql,.rs,.go,.c,.cpp,.h,.uvue,.sh,.ps1,.log,.csv'; input.onchange = async () => { try {
    for (const f of input.files) {
        if (attachments.length >= 6)
            throw new Error('每轮最多附加 6 个文本文件。');
        if (f.size > 512 * 1024)
            throw new Error(f.name + ' 超过 512 KB，请缩小文件。');
        const content = await f.text();
        if (content.includes('\0'))
            throw new Error('仅支持文本和代码，不能上传二进制文件。');
        attachments.push({ name: f.name, text: content });
    }
    render();
}
catch (e) {
    toast(e.message, true);
    render();
} }; input.click(); }
function download(name, data, type = 'application/json') { const blob = new Blob([typeof data === 'string' ? data : JSON.stringify(data, null, 2)], { type }), url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000); }
async function openExternal(url) { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol))
    throw new Error('仅允许打开 HTTP/HTTPS 页面'); if (window.desktop)
    await window.desktop.openExternal(url);
else
    window.open(url, '_blank', 'noopener,noreferrer'); }
function showSearch() { modal('搜索项目与会话', '<input id="global-search" style="width:100%" placeholder="输入项目名或会话名称"><div id="search-results" class="search-results"></div>', btn('关闭', 'close-modal')); const update = q => { q = q.toLowerCase(); $('#search-results').innerHTML = [...state.projects.filter(p => p.name.toLowerCase().includes(q)).map(p => `<button class="menu-item" data-action="search-project" data-id="${p.id}">${icon('folder', 17)}<span>${esc(p.name)}<small>${esc(p.path)}</small></span></button>`), ...state.sessions.filter(s => s.title.toLowerCase().includes(q)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 25).map(s => `<button class="menu-item" data-action="search-session" data-id="${s.id}">${icon('chat', 17)}<span>${esc(s.title)}<small>${s.archived ? '已归档 · ' : ''}${fmtDate(s.updatedAt)}</small></span></button>`)].join('') || '<div class="empty-nav" style="padding:20px">没有匹配结果。</div>'; }; $('#global-search').addEventListener('input', e => update(e.target.value)); update(''); }
function showApproval() {
    const a = state.approvals[0];
    if (!a)
        return toast('当前没有待审批操作。');
    const p = a.params;
    if (a.method === 'item/tool/requestUserInput') {
        formModal('Codex 需要你的回答', `<div class="small muted">回答将发送给内核继续当前任务。</div>${(p.questions || []).map((q, i) => `<div class="approval-question"><label>${esc(q.question || q.header || q.id)}</label>${q.options?.length ? `<select name="answer-${i}">${q.options.map(o => `<option value="${esc(o.label)}">${esc(o.label)}${o.description ? ' — ' + esc(o.description) : ''}</option>`).join('')}</select>` : ''}<input style="margin-top:8px" name="custom-${i}" ${q.isSecret ? 'type="password"' : ''} placeholder="${q.options?.length ? '或填写自己的回答' : '填写回答'}"></div>`).join('')}`, async (f) => { const answers = {}; for (const [q, i] of (p.questions || []).map((q, i) => [q, i])) {
            const value = f.get('custom-' + i) || f.get('answer-' + i);
            if (!value)
                throw new Error('请回答所有问题。');
            answers[q.id] = [value];
        } await api('approval', { id: a.id, answers }); }, { submit: '发送回答' });
        return;
    }
    if (a.method === 'mcpServer/elicitation/request') {
        const props = p.requestedSchema?.properties || p.request?.requestedSchema?.properties || {};
        formModal('MCP 请求补充信息', `<p class="confirm-text">${esc(p.message || p.request?.message || '工具需要你提供以下内容。')}</p><pre class="approval-command">${esc(JSON.stringify({ server: p.serverName || p.server, method: a.method }, null, 2))}</pre><div class="form-grid">${Object.entries(props).map(([k, v]) => field(k, esc(v.title || k), '', esc(v.description || ''), { full: true, required: (p.requestedSchema?.required || []).includes(k), type: v.type === 'number' || v.type === 'integer' ? 'number' : 'text' })).join('')}</div><div class="small muted">不要填写你不愿发送给该工具的数据。</div>`, async (f) => { const content = {}; for (const [k, v] of Object.entries(props)) {
            const raw = f.get(k);
            if (raw === '')
                continue;
            content[k] = ['number', 'integer'].includes(v.type) ? Number(raw) : v.type === 'boolean' ? raw === 'true' : raw;
        } await api('approval', { id: a.id, action: 'accept', content }); }, { submit: '发送信息' });
        $('.modal-footer').insertAdjacentHTML('afterbegin', btn('拒绝', 'deny-approval', 'danger', `data-id="${a.id}"`));
        return;
    }
    const isPermission = a.method === 'item/permissions/requestApproval';
    modal(isPermission ? '确认本轮额外权限' : '确认内核操作', `<p class="confirm-text">${esc(p.reason || '请检查具体命令、目标路径和修改内容，仅在符合你的任务意图时允许。')}</p><pre class="approval-command">${esc(JSON.stringify(p, null, 2))}</pre><div class="small muted">允许仅针对本次操作；权限请求最多授权至当前轮次。不会自动批准后续未知请求。</div>`, `${btn('拒绝', 'deny-approval', 'danger', `data-id="${a.id}"`)}${btn('允许本次', 'accept-approval', 'primary', `data-id="${a.id}"`)}`, 'wide');
}
async function resolveApproval(id, allow) { const a = state.approvals.find(a => a.id === id); if (!a)
    throw new Error('审批已失效。'); const payload = a.method === 'item/permissions/requestApproval' ? { accept: allow } : a.method === 'mcpServer/elicitation/request' ? { action: allow ? 'accept' : 'decline' } : { decision: allow ? 'accept' : 'decline' }; await api('approval', { id, ...payload }); closeModal(); await syncState(); if (state.approvals.length)
    showApproval(); }
async function action(name, b) {
    const d = b.dataset, id = d.id;
    switch (name) {
        case 'go-chat':
            view = 'chat';
            closePopover();
            render();
            break;
        case 'new-chat':
            newChat();
            break;
        case 'projects':
        case 'add-project':
            editProject(undefined, d.section || '项目');
            break;
        case 'edit-project':
            editProject(id);
            break;
        case 'project-new-chat':
            newChat(id);
            break;
        case 'select-project':
            if (expandedProjects.has(id))
                expandedProjects.delete(id);
            else
                expandedProjects.add(id);
            newChat(id);
            break;
        case 'toggle-section':
            collapsedSections.has(d.section) ? collapsedSections.delete(d.section) : collapsedSections.add(d.section);
            render();
            break;
        case 'project-menu':
            projectMenu(b, id);
            break;
        case 'pin-project': {
            const p = state.projects.find(p => p.id === id);
            await api('project/save', { ...p, pinned: !p.pinned });
            closePopover();
            await syncState();
            break;
        }
        case 'open-project':
            await api('native/open', { projectId: id });
            closePopover();
            break;
        case 'archive-project':
            if (await confirmDialog('归档项目聊天？', '所有该项目的会话将从最近记录中隐藏。文件不会修改，聊天可从归档页恢复。', '归档')) {
                await api('project/archive', { id, confirmed: true });
                await syncState();
            }
            break;
        case 'remove-project':
            if (await confirmDialog('移除项目？', '只移除应用内的项目关联，不会删除磁盘文件。历史会话仍然保留。', '移除', true)) {
                await api('project/remove', { id, confirmed: true });
                if (selectedProjectId === id)
                    selectedProjectId = null;
                await syncState();
            }
            break;
        case 'choose-project':
            chooseProject(b);
            break;
        case 'choose-project-id':
            if (currentSession && !(await confirmDialog('新建项目会话？', '已有会话的工作目录不变。选择其他项目会开始一个新会话。', '新建会话')))
                break;
            newChat(id || null);
            break;
        case 'history':
            view = 'history';
            historyArchived = false;
            closePopover();
            render();
            break;
        case 'archived':
            view = 'history';
            historyArchived = true;
            closePopover();
            render();
            break;
        case 'open-session':
            await openSession(id);
            break;
        case 'session-menu':
            sessionMenu(b, id || selectedSessionId);
            break;
        case 'pin-session': {
            const s = state.sessions.find(s => s.id === id);
            await api('session/edit', { id, pinned: !s.pinned });
            closePopover();
            await syncState();
            break;
        }
        case 'rename-session':
            textEdit('会话名称', 'title', state.sessions.find(s => s.id === id).title, async (title) => { const s = await api('session/edit', { id, title }); if (selectedSessionId === id)
                currentSession = s; });
            break;
        case 'archive-session': {
            const s = state.sessions.find(s => s.id === id);
            if (!s.archived && !(await confirmDialog('归档会话？', '聊天会保留，可从「归档聊天」恢复。', '归档')))
                break;
            const updated = await api('session/edit', { id, archived: !s.archived });
            if (selectedSessionId === id)
                currentSession = updated;
            closePopover();
            await syncState();
            break;
        }
        case 'export-session':
            if (await confirmDialog('导出此会话？', '导出内容可能含私有代码、你输入的密钥和项目路径，请妥善保存。', '导出'))
                download('codex-session-' + id + '.json', await api('session?id=' + encodeURIComponent(id)));
            break;
        case 'settings':
            view = 'settings';
            settingsTab = 'general';
            closePopover();
            render();
            break;
        case 'settings-tab':
            view = 'settings';
            settingsTab = d.tab;
            render();
            break;
        case 'settings-general':
            view = 'settings';
            settingsTab = 'general';
            render();
            break;
        case 'about':
            view = 'settings';
            settingsTab = 'about';
            closePopover();
            render();
            break;
        case 'providers':
            view = 'settings';
            settingsTab = 'providers';
            closePopover();
            render();
            break;
        case 'usage':
            view = 'usage';
            closePopover();
            render();
            break;
        case 'extensions':
            view = 'extensions';
            closePopover();
            render();
            break;
        case 'extension-tab':
            view = 'extensions';
            extensionTab = d.tab;
            render();
            break;
        case 'add-provider':
            editProvider();
            break;
        case 'edit-provider':
            editProvider(id);
            break;
        case 'provider-menu':
            providerMenu(b, id);
            break;
        case 'select-provider':
            await api('provider/select', { id });
            modelsByProvider.delete(id);
            selectedSessionId = null;
            currentSession = null;
            await syncState();
            model = activeProvider().defaultModel;
            effort = activeProvider().effort;
            render();
            toast('已切换供应商。原会话仍绑定原供应商。');
            break;
        case 'delete-provider':
            if (await confirmDialog('移除供应商？', '将移除配置与保存的 Key。有历史会话的供应商不会被删除，以保护会话绑定。', '移除', true)) {
                await api('provider/delete', { id, confirmed: true });
                await syncState();
            }
            break;
        case 'import-providers':
            importProviders();
            break;
        case 'import-live':
            if (await confirmDialog('读取本机 Codex 配置？', '只读取当前用户 .codex/config.toml 和 auth.json，尝试提取中转供应商。不会修改原文件。', '读取并导入')) {
                const r = await api('provider/import-live', { confirmed: true });
                toast(`导入 ${r.count} 项\n${r.warnings.join('\n')}`);
                await syncState();
            }
            break;
        case 'test-provider': {
            closePopover();
            toast('正在查询供应商 /models…');
            const r = await api('provider/test', { id });
            modelsByProvider.delete(id);
            await syncState();
            toast(`获取 ${r.models.length} 个模型，耗时 ${r.latencyMs} ms。\n${r.note || '此测试不验证 Responses 工具调用。'}`);
            break;
        }
        case 'export-provider':
            if (await confirmDialog('导出 CC Switch 配置？', '默认导出不包含 API Key，可在 CC Switch 中粘贴配置并重新填入 Key。', '导出无密钥配置'))
                download('cc-switch-' + id + '.json', await api('provider/export', { id, includeKey: false }));
            break;
        case 'official-login': {
            closePopover();
            toast('正在启动官方登录…');
            const r = await api('engine/login', { id });
            if (r.authUrl)
                await openExternal(r.authUrl);
            else
                toast(JSON.stringify(r));
            break;
        }
        case 'import-auth':
            if (await confirmDialog('复制本机官方登录态？', '会把当前用户 Codex 登录态复制到本应用独立目录。原文件不会修改。复制的登录态可能需要重新登录刷新。', '复制')) {
                const r = await api('engine/import-auth', { id, confirmed: true });
                toast(r.message);
                await syncState();
            }
            break;
        case 'refresh-usage':
            closePopover();
            toast('正在查询实际额度…');
            {
                const r = await api('usage', { id: id || state.activeProviderId });
                state.usage[id || state.activeProviderId] = r;
                if (view === 'usage')
                    render();
                toast(Number.isFinite(r.percent) ? `剩余额度 ${r.percent.toFixed(1)}%` : r.reason || '接口未提供可计算的百分比。', !Number.isFinite(r.percent));
            }
            break;
        case 'connect': {
            toast('正在连接 Codex 内核…');
            await api('engine/connect', { id: activeProvider().id });
            await syncState();
            toast('Codex 内核已连接。');
            break;
        }
        case 'disconnect':
            await api('engine/disconnect', {});
            await syncState();
            break;
        case 'setup-sandbox':
            if (await confirmDialog('初始化 Windows 沙箱？', '由本机 Codex 内核执行初始化。请留意 Windows 系统提示。', '初始化')) {
                await api('engine/sandbox', { confirmed: true });
                toast('已请求初始化，结果由内核返回。');
            }
            break;
        case 'workspace-edit':
            formModal('无项目任务文件夹', `<div class="form-field"><label>已有文件夹的绝对路径</label><div class="input-with-btn"><input name="path" id="workspace-path" value="${esc(state.settings.workspace)}" required>${btn('选择', 'browse-path', '', `data-target="workspace-path"`)}</div></div>`, async (f) => api('settings', { workspace: f.get('path') }));
            break;
        case 'codex-path':
            formModal('Codex 内核路径', field('path', '可执行文件绝对路径', state.settings.codexPath || '', '留空自动查找。Windows 请选择 codex.exe，不是 codex.cmd。', { full: true }), async (f) => api('settings', { codexPath: f.get('path') }));
            break;
        case 'display-name':
            textEdit('本地显示名称', 'name', state.settings.displayName, name => api('settings', { displayName: name }));
            break;
        case 'set-theme':
            await api('settings', { theme: d.value });
            await syncState();
            break;
        case 'open-data':
            await api('native/open', { target: 'data' });
            break;
        case 'export-data':
            if (await confirmDialog('导出本地记录？', '不导出凭据库或官方登录文件。会话内容可能包含你输入的秘密、项目路径和私有代码；请勿随意分享。', '导出'))
                download('astrogate-records.json', await api('export', { confirmed: true }));
            break;
        case 'add-mcp':
            editMcp();
            break;
        case 'edit-mcp':
            editMcp(id);
            break;
        case 'toggle-mcp': {
            const m = state.mcp.find(m => m.id === id);
            if (!m.enabled && !(await confirmDialog('启用 MCP 插件？', `你将启用 ${m.name}。本地插件可运行其配置命令，远程插件可接收工具调用数据。确认你信任此来源。`, '信任并启用')))
                break;
            await api('mcp/toggle', { id, enabled: !m.enabled, trusted: true });
            await syncState();
            break;
        }
        case 'delete-mcp':
            if (await confirmDialog('移除 MCP 插件？', '删除本应用的插件配置和保存的凭据，不卸载外部工具。', '移除', true)) {
                await api('mcp/remove', { id, confirmed: true });
                await syncState();
            }
            break;
        case 'mcp-status':
            mcpStatus = await api('mcp/status', {});
            render();
            break;
        case 'add-skill':
            await editSkill();
            break;
        case 'edit-skill':
            await editSkill(d.name);
            break;
        case 'delete-skill':
            if (await confirmDialog('删除技能？', '删除本应用管理的 SKILL.md 与其内核目录副本。', '删除', true)) {
                await api('skill/remove', { name: d.name, confirmed: true });
                await syncState();
            }
            break;
        case 'load-apps':
            toast('正在读取真实应用目录…');
            appsData = await api('apps', {});
            render();
            break;
        case 'profile-menu':
            profileMenu(b);
            break;
        case 'model-menu':
            modelMenu(b);
            break;
        case 'effort-menu':
            effortMenu(b);
            break;
        case 'set-model':
            model = d.value;
            closePopover();
            if (!state.running)
                await api('settings', { model });
            render();
            break;
        case 'custom-model': {
            const value = $('#custom-model').value.trim();
            if (!value)
                throw new Error('请输入模型 ID');
            model = value;
            closePopover();
            if (!state.running)
                await api('settings', { model });
            render();
            break;
        }
        case 'load-models': {
            closePopover();
            toast('正在读取内核模型目录…');
            const r = await api('models', { id: activeProvider().id });
            modelsByProvider.set(activeProvider().id, r.models);
            toast(`获取 ${r.models.length} 个模型。`);
            render();
            modelMenu($('#model-toggle'));
            break;
        }
        case 'reset-effort':
            effort = activeProvider().effort || 'high';
            if (!state.running)
                await api('settings', { effort });
            render();
            effortMenu($('#effort-toggle'));
            break;
        case 'toggle-acceleration': {
            const reopen = popover?.kind === 'effort-menu';
            await api('settings', { acceleration: !state.settings.acceleration });
            await syncState();
            if (reopen)
                effortMenu($('#effort-toggle'));
            toast('加速为界面预留，不改变请求和计费。');
            break;
        }
        case 'permission-menu':
            permissionMenu(b);
            break;
        case 'set-permission':
            permission = d.value;
            closePopover();
            render();
            break;
        case 'send':
            await sendMessage();
            break;
        case 'stop':
            await api('stop', {});
            toast('已发送停止请求。');
            await syncState();
            break;
        case 'attach':
            attachFiles();
            break;
        case 'remove-attachment':
            attachments.splice(+d.index, 1);
            render();
            break;
        case 'approvals':
            showApproval();
            break;
        case 'accept-approval':
            await resolveApproval(id, true);
            break;
        case 'deny-approval':
            await resolveApproval(id, false);
            break;
        case 'browse-path': {
            const r = await api('native/folder', {});
            if (r.path)
                document.getElementById(d.target).value = r.path;
            else
                toast('未选择目录，可直接输入绝对路径。');
            break;
        }
        case 'toggle-secret': {
            const f = document.getElementById(d.target);
            f.type = f.type === 'password' ? 'text' : 'password';
            break;
        }
        case 'search':
            showSearch();
            break;
        case 'search-session':
            closeModal();
            await openSession(id);
            break;
        case 'search-project':
            closeModal();
            expandedProjects.add(id);
            newChat(id);
            break;
        case 'close-modal':
            closeModal();
            break;
        case 'confirm-modal':
            closeModal(true);
            break;
        case 'copy-code': {
            const content = b.closest('.codeblock').querySelector('code').textContent;
            if (window.desktop?.copyText)
                await window.desktop.copyText(content);
            else if (navigator.clipboard)
                await navigator.clipboard.writeText(content);
            else
                throw new Error('此浏览器不能访问剪贴板，请手动选择代码复制。');
            toast('代码已复制。');
            break;
        }
        case 'top-file':
            openPopover(b, menuItem('edit', '新聊天', 'new-chat', '', 'Ctrl N') + menuItem('folder', '添加项目', 'add-project') + menuItem('download', '导入 CC Switch JSON', 'import-providers') + menuItem('download', '读取本机 Codex 配置', 'import-live') + '<hr>' + menuItem('storage', '导出本地记录', 'export-data'));
            break;
        case 'top-edit':
            openPopover(b, menuItem('search', '搜索会话与项目', 'search', '', 'Ctrl K') + menuItem('settings', '设置', 'settings', '', 'Ctrl ,'));
            break;
        case 'top-view':
            openPopover(b, menuItem('home', '工作台', 'go-chat') + menuItem('layers', '模型供应商', 'providers') + menuItem('plug', '插件与技能', 'extensions') + menuItem('meter', '使用情况', 'usage') + menuItem('history', '会话记录', 'history'));
            break;
        case 'window-min':
            await window.desktop?.windowAction('minimize');
            break;
        case 'window-max':
            await window.desktop?.windowAction('maximize');
            break;
        case 'window-close':
            await window.desktop?.windowAction('close');
            break;
        case 'quit':
            if (await confirmDialog('退出本地服务？', state.running ? '当前任务会被停止；关闭不会撤销已经产生的文件修改。' : '退出后需要重新运行 Start.cmd 启动。', '退出', true)) {
                streamClosed = true;
                await api('shutdown', { confirmed: true });
                root.innerHTML = '<div class="boot"><div class="boot-mark">A</div><p>本地服务已关闭，可以关闭此窗口。</p></div>';
            }
            break;
    }
}
document.addEventListener('click', event => { const link = event.target.closest('a[href]'); if (link && !link.download) {
    event.preventDefault();
    openExternal(link.href).catch(e => toast(e.message, true));
    return;
} const b = event.target.closest('[data-action]'); if (b) {
    event.preventDefault();
    if (b.disabled)
        return;
    action(b.dataset.action, b).catch(e => toast(e.message, true));
}
else if (popover && !event.target.closest('.popover'))
    closePopover(); });
document.addEventListener('input', event => { if (event.target.id === 'prompt') {
    draft = event.target.value;
    resizePrompt();
} if (event.target.id === 'history-search') {
    historyFilter = event.target.value;
    render();
} });
document.addEventListener('change', event => { if (event.target.id === 'default-permission')
    api('settings', { defaultPermission: event.target.value }).then(() => { permission = event.target.value; scheduleSync(); }).catch(e => toast(e.message, true)); });
document.addEventListener('keydown', event => { if (event.isComposing)
    return; if (event.key === 'Escape') {
    closePopover();
    if (modalRoot.childElementCount)
        closeModal();
    return;
} if (event.target.id === 'prompt' && event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage().catch(e => toast(e.message, true));
} if ((event.ctrlKey || event.metaKey) && !event.shiftKey) {
    if (event.key.toLowerCase() === 'k') {
        event.preventDefault();
        showSearch();
    }
    if (event.key.toLowerCase() === 'n') {
        event.preventDefault();
        newChat();
    }
    if (event.key === ',') {
        event.preventDefault();
        view = 'settings';
        settingsTab = 'general';
        render();
    }
} });
document.addEventListener('contextmenu', event => { const p = event.target.closest('.project-row'), s = event.target.closest('.session-nav'); if (p) {
    event.preventDefault();
    const b = p.querySelector('[data-action=project-menu]');
    projectMenu(b, b.dataset.id);
}
else if (s) {
    event.preventDefault();
    const b = s.querySelector('[data-action=session-menu]');
    sessionMenu(b, b.dataset.id);
} });
window.addEventListener('resize', closePopover);
window.addEventListener('beforeunload', event => { if (state?.running) {
    event.preventDefault();
    event.returnValue = '';
} });
(async () => { try {
    if (!token)
        throw new Error('缺少本地访问令牌。请从 Start.cmd 或桌面客户端启动，不要手动输入网页地址。');
    await syncState(true);
    streamEvents();
}
catch (e) {
    root.innerHTML = `<div class="boot"><div class="boot-mark">A</div><h2>工作台暂时无法连接</h2><div class="error-box">${esc(e.message)}</div><p>重新启动本地服务后，使用它提供的访问地址。</p></div>`;
} })();
