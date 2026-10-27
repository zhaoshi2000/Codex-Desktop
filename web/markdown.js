import { esc } from './icons.js';
function inline(raw) {
    // Escape first: no model-generated HTML can become executable markup.
    let s = esc(raw);
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (_, x) => { codes.push(`<code>${x}</code>`); return `\u0001${codes.length - 1}\u0001`; });
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    return s.replace(/\u0001(\d+)\u0001/g, (_, i) => codes[Number(i)]);
}
export function markdown(text) {
    const lines = String(text || '').split('\n');
    let html = '', inCode = false, code = [], lang = '', inList = false;
    const endList = () => { if (inList) {
        html += '</ul>';
        inList = false;
    } };
    const renderCode = () => { html += `<div class="codeblock"><div class="code-head"><span>${esc(lang || 'code')}</span><button type="button" class="text-btn copy-code" data-action="copy-code">复制</button></div><pre><code>${esc(code.join('\n'))}</code></pre></div>`; code = []; };
    for (const line of lines) {
        if (/^\s*```/.test(line)) {
            if (inCode) {
                renderCode();
                inCode = false;
            }
            else {
                endList();
                lang = line.trim().slice(3);
                inCode = true;
            }
            continue;
        }
        if (inCode) {
            code.push(line);
            continue;
        }
        const h = line.match(/^(#{1,4})\s+(.+)/);
        if (h) {
            endList();
            const level = h[1].length + 1;
            html += `<h${level}>${inline(h[2])}</h${level}>`;
            continue;
        }
        const list = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)/);
        if (list) {
            if (!inList) {
                html += '<ul>';
                inList = true;
            }
            html += `<li>${inline(list[1])}</li>`;
            continue;
        }
        endList();
        if (line.startsWith('> ')) {
            html += `<blockquote>${inline(line.slice(2))}</blockquote>`;
            continue;
        }
        if (/^\s*---+\s*$/.test(line)) {
            html += '<hr>';
            continue;
        }
        html += line.trim() ? `<p>${inline(line)}</p>` : '<div class="md-gap"></div>';
    }
    endList();
    if (inCode)
        renderCode();
    return html;
}
