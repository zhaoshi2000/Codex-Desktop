/** CC Switch Codex compatibility adapter.
 * Inspired by farion1231/cc-switch (MIT, Copyright (c) 2025 Jason Young).
 * Schema: Provider.settingsConfig = { auth: { OPENAI_API_KEY }, config: TOML }.
 * Unlike CC Switch this application never rewrites the user's live ~/.codex.
 */
import { assert, text, cleanUrl, safeId, percentage, dotGet, readResponseBody, tomlString, AppError } from './util.mjs';
export const SCREENSHOT_MODELS = [
    ['gpt-6.1-sol', 'GPT-6.1 Sol'], ['gpt-6-astra', 'GPT-6 Astra'], ['gpt-6-sol', 'GPT-6 Sol'], ['gpt-6-luna', 'GPT-6 Luna'],
    ['gpt-5.6-sol', 'GPT-5.6 Sol'], ['gpt-5.6-terra', 'GPT-5.6 Terra'], ['gpt-5.6-luna', 'GPT-5.6 Luna']
].map(([id, label]) => ({ id, label, source: 'preset', efforts: [] }));
export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export function validateProvider(input, old = {}) {
    assert(input && typeof input === 'object', '供应商数据无效');
    const kind = input.kind ?? old.kind ?? 'relay';
    assert(['relay', 'official'].includes(kind), '不支持的供应商类型');
    const p = {
        id: safeId(input.id || old.id), kind,
        name: text(input.name ?? old.name, '名称', 100, true).trim(),
        baseUrl: kind === 'relay' ? cleanUrl(input.baseUrl ?? old.baseUrl, { allowInsecure: input.allowInsecure === true }) : '',
        allowInsecure: input.allowInsecure === true,
        defaultModel: text(input.defaultModel ?? old.defaultModel ?? 'gpt-6-sol', '默认模型', 200, true).trim(),
        notes: text(input.notes ?? old.notes ?? '', '备注', 2000),
        models: input.models ?? old.models ?? structuredClone(SCREENSHOT_MODELS),
        effort: input.effort ?? old.effort ?? 'high',
        usage: input.usage ?? old.usage ?? null,
        createdAt: old.createdAt ?? Date.now()
    };
    assert(Array.isArray(p.models) && p.models.length <= 500, '最多配置 500 个模型');
    p.models = p.models.map(m => {
        if (typeof m === 'string')
            m = { id: m, label: m };
        const efforts = Array.isArray(m.efforts) ? m.efforts.filter(x => EFFORTS.includes(x)) : [];
        return { id: text(m.id, '模型 ID', 200, true).trim(), label: text(m.label || m.id, '模型名称', 200, true).trim(), efforts, source: ['preset', 'api', 'codex', 'manual', 'import'].includes(m.source) ? m.source : 'manual' };
    });
    assert(new Set(p.models.map(m => m.id)).size === p.models.length, '模型 ID 不能重复');
    assert(EFFORTS.includes(p.effort), '推理强度不正确');
    if (p.usage?.url) {
        p.usage = { ...p.usage, url: cleanUrl(p.usage.url, { allowInsecure: p.allowInsecure }), auth: p.usage.auth || 'provider' };
        assert(['provider', 'custom', 'none'].includes(p.usage.auth), '额度认证类型不正确');
        if (p.usage.auth === 'provider')
            assert(p.kind === 'relay' && new URL(p.usage.url).origin === new URL(p.baseUrl).origin, '使用模型 Key 查询额度时，额度接口必须与 API 地址同源；跨域请使用独立额度 Key');
        for (const field of ['totalPath', 'remainingPath', 'usedPath', 'percentPath'])
            if (p.usage[field])
                dotGet({}, p.usage[field]);
        p.usage.unit = text(p.usage.unit || '额度', '额度单位', 20);
        delete p.usage.apiKey;
    }
    else
        p.usage = null;
    return p;
}
// A deliberately bounded TOML scalar reader, not a general TOML evaluator.
// It reads only provider fields in the selected model_providers table; it never
// executes JS usage scripts, shell commands or imported MCP definitions.
function splitOutsideQuotes(s, separator) {
    let q = '', escaped = false, out = [], start = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (q === '"' && c === '\\') {
            escaped = true;
            continue;
        }
        if (q) {
            if (c === q)
                q = '';
            continue;
        }
        if (c === '"' || c === "'") {
            q = c;
            continue;
        }
        if (c === separator) {
            out.push(s.slice(start, i));
            start = i + 1;
        }
    }
    out.push(s.slice(start));
    return out;
}
function scalar(v) {
    v = splitOutsideQuotes(v, '#')[0].trim();
    if (v.startsWith('"""') || v.startsWith("'''"))
        return undefined;
    if (v.startsWith('"')) {
        try {
            return JSON.parse(v);
        }
        catch {
            return undefined;
        }
    }
    if (v.startsWith("'") && v.endsWith("'"))
        return v.slice(1, -1);
    if (v === 'true')
        return true;
    if (v === 'false')
        return false;
    return undefined;
}
export function readCodexScalars(toml) {
    assert(typeof toml === 'string' && toml.length <= 2000000, 'TOML 文本无效或过大');
    let table = '';
    const tables = Object.create(null);
    tables[''] = Object.create(null);
    for (let line of toml.replace(/^\uFEFF/, '').split(/\r?\n/)) {
        line = splitOutsideQuotes(line, '#')[0].trim();
        if (!line)
            continue;
        if (line.startsWith('[')) {
            const match = line.match(/^\[([^\[\]]+)\]$/);
            if (!match) {
                table = '__unsupported';
                continue;
            }
            table = splitOutsideQuotes(match[1], '.').map(x => scalar(x.trim()) ?? x.trim()).join('.');
            if (!tables[table])
                tables[table] = Object.create(null);
            continue;
        }
        const parts = splitOutsideQuotes(line, '=');
        if (parts.length < 2)
            continue;
        const k = scalar(parts[0].trim()) ?? parts[0].trim(), value = scalar(parts.slice(1).join('='));
        if (value !== undefined && tables[table])
            tables[table][k] = value;
    }
    const root = tables[''];
    let active = root.model_provider;
    if (!active) {
        const list = Object.keys(tables).filter(x => /^model_providers\.[^.]+$/.test(x));
        if (list.length === 1)
            active = list[0].slice(16);
    }
    return { root, provider: tables[`model_providers.${active}`] || {}, active };
}
function candidates(data) {
    if (Array.isArray(data))
        return data;
    assert(data && typeof data === 'object', '请导入供应商 JSON，而不是 SQL 数据库备份');
    if (data.settingsConfig || data.auth || data.config)
        return [data];
    if (data.codex)
        return candidates(data.codex);
    if (data.apps?.codex)
        return candidates(data.apps.codex);
    if (data.providers)
        return candidates(data.providers);
    const list = Object.values(data).filter(x => x && typeof x === 'object' && x.settingsConfig);
    assert(list.length, '没有找到 Codex 供应商。请从 CC Switch 复制供应商 JSON 或导入当前 Codex 配置。');
    return list;
}
export function importCcSwitch(data) {
    const warnings = [], providers = [];
    for (const entry of candidates(data).slice(0, 100)) {
        if (entry.appType && entry.appType !== 'codex')
            continue;
        const s = entry.settingsConfig || entry;
        if (typeof s.config !== 'string') {
            warnings.push(`${entry.name || '未知条目'}：无 Codex TOML，已跳过`);
            continue;
        }
        const parsed = readCodexScalars(s.config), p = parsed.provider;
        if (!p.base_url) {
            warnings.push(`${entry.name || '未知条目'}：没有中转 base_url，已跳过（官方账号请使用官方登录）`);
            continue;
        }
        const apiKey = typeof s.auth?.OPENAI_API_KEY === 'string' && s.auth.OPENAI_API_KEY ? s.auth.OPENAI_API_KEY : (p.experimental_bearer_token || '');
        if (p.wire_api && p.wire_api !== 'responses') {
            warnings.push(`${entry.name || p.name}：仅支持 Responses 协议，本次未导入 ${p.wire_api}。`);
            continue;
        }
        const model = parsed.root.model || 'gpt-6-sol';
        const catalog = Array.isArray(s.modelCatalog?.models) ? s.modelCatalog.models.map(m => ({ id: m.model, label: m.displayName || m.display_name || m.model, efforts: (m.reasoningLevels || m.reasoning_levels || []).map(e => typeof e === 'string' ? e : e.effort || e.reasoningEffort).filter(Boolean), source: 'import' })) : [{ id: model, label: model, source: 'import', efforts: [] }];
        providers.push({ name: entry.name || p.name || '导入的中转', kind: 'relay', baseUrl: p.base_url, apiKey, defaultModel: model, models: catalog, effort: EFFORTS.includes(parsed.root.model_reasoning_effort) ? parsed.root.model_reasoning_effort : 'high', notes: '由 CC Switch Codex 配置导入' });
        if (!apiKey)
            warnings.push(`${entry.name || p.name}：未导入 Key；请在供应商编辑页补填（不会读取引用的环境变量）`);
        if (p.http_headers || s.config.includes('http_headers'))
            warnings.push(`${entry.name || p.name}：额外 HTTP 头没有导入；此版本仅支持 Bearer Key`);
    }
    return { providers, warnings };
}
export function exportCcSwitch(p, key = '') {
    const config = [`model = ${tomlString(p.defaultModel)}`, 'model_provider = "astrogate"', `model_reasoning_effort = ${tomlString(p.effort)}`, '', '[model_providers.astrogate]', `name = ${tomlString(p.name)}`, `base_url = ${tomlString(p.baseUrl)}`, 'wire_api = "responses"', 'requires_openai_auth = true', ''].join('\n');
    return { id: p.id, name: p.name, settingsConfig: { auth: { OPENAI_API_KEY: key }, config, modelCatalog: { models: p.models.map(m => ({ model: m.id, displayName: m.label, reasoningLevels: m.efforts })) } } };
}
export function runtimeConfig(provider, mcp = [], secretEnv = {}) {
    const lines = [`# Managed by AstroGate Codex. Original ~/.codex is untouched.`, `model = ${tomlString(provider.defaultModel)}`, `model_reasoning_effort = ${tomlString(provider.effort)}`, 'approval_policy = "on-request"', 'sandbox_mode = "workspace-write"', 'cli_auth_credentials_store = "file"', ''];
    if (provider.kind === 'relay') {
        lines.splice(3, 0, 'model_provider = "astrogate_relay"');
        lines.push('[model_providers.astrogate_relay]', `name = ${tomlString(provider.name)}`, `base_url = ${tomlString(provider.baseUrl)}`, 'wire_api = "responses"', 'env_key = "ASTROGATE_CODEX_KEY"', 'requires_openai_auth = false', 'supports_websockets = false', 'request_max_retries = 2', '');
    }
    for (const plugin of mcp.filter(x => x.enabled)) {
        lines.push(`[mcp_servers.${tomlString(plugin.name)}]`);
        if (plugin.transport === 'http') {
            lines.push(`url = ${tomlString(plugin.url)}`);
            if (plugin.hasToken)
                lines.push(`bearer_token_env_var = ${tomlString('ASTROGATE_MCP_' + plugin.id.replace(/-/g, '_'))}`);
        }
        else {
            lines.push(`command = ${tomlString(plugin.command)}`, `args = ${JSON.stringify(plugin.args)}`);
        }
        lines.push('startup_timeout_sec = 30', '');
        if (secretEnv[plugin.id] && Object.keys(secretEnv[plugin.id]).length) {
            lines.push(`[mcp_servers.${tomlString(plugin.name)}.env]`);
            for (const [k, v] of Object.entries(secretEnv[plugin.id]))
                lines.push(`${tomlString(k)} = ${tomlString(v)}`);
            lines.push('');
        }
    }
    return lines.join('\n');
}
export async function fetchModels(provider, key, fetcher = fetch) {
    assert(provider.kind === 'relay', '官方模型目录请先连接 Codex 内核');
    const start = Date.now();
    const url = provider.baseUrl + '/models';
    const response = await fetcher(url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: AbortSignal.timeout(20000), redirect: 'error' });
    const body = await readResponseBody(response);
    if (!response.ok)
        throw new AppError(`模型接口返回 HTTP ${response.status}：${body.slice(0, 500)}`, 502);
    let data;
    try {
        data = JSON.parse(body);
    }
    catch {
        throw new AppError('模型接口没有返回 JSON，请确认 Base URL 是否需要 /v1', 502);
    }
    assert(Array.isArray(data.data), '返回格式不是 { data: [{ id: "模型ID" }] }');
    const models = data.data.filter(m => typeof m.id === 'string').map(m => ({ id: m.id, label: m.name || m.id, source: 'api', efforts: [] }));
    return { models, latencyMs: Date.now() - start, endpoint: url, note: '仅验证 /models；不代表 /responses、工具调用或推理强度均可用。' };
}
export async function fetchUsage(provider, key, usageKey, fetcher = fetch) {
    if (!provider.usage)
        return { percent: null, reason: '供应商未配置额度接口', updatedAt: Date.now() };
    const u = provider.usage, headers = { Accept: 'application/json' };
    const credential = u.auth === 'custom' ? usageKey : u.auth === 'provider' ? key : '';
    if (u.auth !== 'none')
        assert(credential, '没有可用的额度查询 Key');
    if (credential)
        headers.Authorization = `Bearer ${credential}`;
    const response = await fetcher(u.url, { headers, signal: AbortSignal.timeout(15000), redirect: 'error' });
    const body = await readResponseBody(response, 1024 * 1024);
    if (!response.ok)
        throw new AppError(`额度接口返回 HTTP ${response.status}`, 502);
    let data;
    try {
        data = JSON.parse(body);
    }
    catch {
        throw new AppError('额度接口返回的不是 JSON', 502);
    }
    let total = dotGet(data, u.totalPath), remaining = dotGet(data, u.remainingPath), used = dotGet(data, u.usedPath), percent = null;
    if (remaining === undefined && total !== undefined && used !== undefined && [total, used].every(x => x !== null && x !== '' && Number.isFinite(Number(x))))
        remaining = Number(total) - Number(used);
    if (u.percentPath) {
        const raw = dotGet(data, u.percentPath);
        if (raw !== null && raw !== undefined && raw !== '' && Number.isFinite(Number(raw)) && Number(raw) >= 0 && Number(raw) <= 100)
            percent = Number(raw);
    }
    else
        percent = percentage(total, remaining);
    return { percent, total: total ?? null, remaining: remaining ?? null, unit: u.unit, updatedAt: Date.now(), reason: percent === null ? '返回值不足以计算百分比，请核对 JSON 字段路径' : '' };
}
