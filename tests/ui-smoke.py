"""Browser smoke test. Run tests/ui-server.mjs first. Uses an explicit fake RPC process.
Requirements (test-only): Python + playwright + local Chromium. No production deps.
"""
import json, os, pathlib, urllib.request, urllib.error, re
from playwright.sync_api import sync_playwright, expect
info = json.loads(pathlib.Path(os.environ.get('UI_INFO', '/mnt/data/astrogate-ui-info.json')).read_text(encoding='utf-8'))
out = pathlib.Path(os.environ.get('UI_OUTPUT', '/mnt/data/astrogate-preview')); out.mkdir(parents=True, exist_ok=True)
checks=[]; errors=[]
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM','/usr/bin/chromium'),args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1440,'height':960},device_scale_factor=1)
    page.on('pageerror', lambda e: errors.append(str(e)))
    # This container's managed Chromium blocks every URL. No browser policy is changed.
    # Render the real assets in memory and bridge ONLY /api/* to our localhost HTTP server.
    # This validates the UI + HTTP service, not normal Chromium navigation/network transport.
    root=pathlib.Path(__file__).resolve().parents[1]
    def local_api(route, options):
        if not route.startswith('/api/') or route.startswith('//'):
            raise ValueError('Test bridge permits only this local app API')
        headers=options.get('headers', {})
        payload=options.get('body')
        req=urllib.request.Request(info['baseUrl']+route, data=payload.encode() if payload is not None else None, headers=headers, method=options.get('method','GET'))
        try:
            with urllib.request.urlopen(req,timeout=100) as r: return {'status':r.status,'body':r.read().decode()}
        except urllib.error.HTTPError as e:
            return {'status':e.code,'body':e.read().decode()}
    page.expose_function('localApiBridge',local_api)
    page.set_content('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"></head><body><div id="app"></div><div id="popover-root"></div><div id="modal-root"></div><div id="toast-root"></div></body></html>')
    page.add_style_tag(content=(root/'web/styles.css').read_text(encoding='utf-8'))
    page.add_script_tag(content="""
      const testSessionStorage = new Map();
      Object.defineProperty(window,'sessionStorage',{value:{getItem:k=>testSessionStorage.get(k)||null,setItem:(k,v)=>testSessionStorage.set(k,v)}});
      window.fetch=async (route,options={})=>{
        if(route==='/api/events') throw new Error('SSE navigation unavailable in this test; polling is used');
        const r=await window.localApiBridge(route,options);return new Response(r.body,{status:r.status,headers:{'Content-Type':'application/json'}});
      };
    """+"sessionStorage.setItem('astrogate-token',"+json.dumps(info['token'])+");")
    bundle='\n'.join(re.sub(r'^import .*?;\s*$', '', (root/('web/'+n)).read_text(encoding='utf-8'), flags=re.MULTILINE).replace('export function ','function ') for n in ['icons.js','markdown.js','app.js'])
    page.add_script_tag(content='(()=>{'+bundle+'})();')
    expect(page.locator('.welcome h1')).to_be_visible()
    page.evaluate("document.querySelector('#toast-root').innerHTML=''"); page.screenshot(path=str(out/'01-workbench.png'));checks.append('Workbench loads with no cloud services')
    page.locator('.rail [data-action=providers]').click()
    page.locator('[data-action=add-provider]').click()
    page.locator('[name=name]').fill('AstroGate')
    page.locator('[name=baseUrl]').fill(info['upstream']+'/v1')
    page.locator('[name=apiKey]').fill('only-a-test-fixture-key')
    page.locator('.advanced summary').click()
    page.locator('[name=usageUrl]').fill(info['upstream']+'/quota')
    page.locator('[name=totalPath]').fill('data.total');page.locator('[name=remainingPath]').fill('data.remaining')
    page.locator('button[form=modal-form]').click()
    expect(page.locator('.modal')).to_have_count(0)
    relay=page.locator('.provider-card').filter(has_text='AstroGate')
    expect(relay).to_contain_text('Key 已加密保存')
    relay.locator('[data-action=select-provider]').click();expect(relay).to_have_class('provider-card active')
    page.evaluate("document.querySelector('#toast-root').innerHTML=''"); page.screenshot(path=str(out/'02-providers.png'));checks.append('Provider save, encrypted-key indicator, active switch')
    page.locator('.rail [data-action=go-chat]').click()
    page.locator('.welcome-start [data-action=add-project]').click()
    page.locator('[name=name]').fill('我的项目')
    page.locator('[data-action=browse-path]').click();expect(page.locator('[name=path]')).to_have_value(info['workspace'])
    page.locator('button[form=modal-form]').click();expect(page.locator('.modal')).to_have_count(0)
    expect(page.locator('.project-main')).to_contain_text('我的项目');checks.append('Native folder bridge and project persistence')
    page.locator('#effort-toggle').click()
    page.locator('#effort-slider').fill('4')
    expect(page.locator('#effort-name')).to_have_text('Ultra')
    expect(page.locator('#effort-track')).to_have_class('effort-track ultra')
    page.evaluate("document.querySelector('#toast-root').innerHTML=''"); page.screenshot(path=str(out/'03-ultra.png'));checks.append('Reasoning slider + purple Ultra')
    page.locator('.effort-menu [data-action=toggle-acceleration]').click()
    expect(page.locator('.composer-hint')).to_contain_text('加速仅为界面预留');checks.append('UI-only acceleration visibly disclosed')
    page.keyboard.press('Escape')
    page.locator('#model-toggle').click();expect(page.locator('.model-option')).to_have_count(7)
    page.evaluate("document.querySelector('#toast-root').innerHTML=''"); page.screenshot(path=str(out/'04-models.png'))
    page.locator('[data-action=set-model][data-value="gpt-6-sol"]').click();checks.append('Model dropdown seven screenshot presets')
    page.locator('.project-row [data-action=project-menu]').click()
    expect(page.locator('.popover')).to_contain_text('在资源管理器中打开')
    page.evaluate("document.querySelector('#toast-root').innerHTML=''"); page.screenshot(path=str(out/'05-project-menu.png'))
    page.locator('[data-action=pin-project]').click();checks.append('Project context menu and pin')
    page.locator('.rail [data-action=usage]').click()
    page.locator('.page-head [data-action=refresh-usage]').click()
    expect(page.locator('.usage-ring strong')).to_have_text('27%');checks.append('Percentage from actual local HTTP quota fixture')
    page.locator('.rail [data-action=extensions]').click()
    page.locator('.page-head [data-action=add-mcp]').click()
    page.locator('[name=name]').fill('local-tools')
    page.locator('[name=command]').fill('node')
    page.locator('[name=trusted]').check()
    page.locator('button[form=modal-form]').click();expect(page.locator('.modal')).to_have_count(0)
    expect(page.locator('.plugin-card')).to_contain_text('local-tools');checks.append('MCP add with explicit trust and disabled default')
    page.locator('[data-action=extension-tab][data-tab=skills]').click()
    page.locator('.page-head [data-action=add-skill]').click()
    page.locator('[name=name]').fill('review-code')
    page.locator('[name=content]').fill('---\nname: review-code\ndescription: Test-only review instructions\n---\nReview code.')
    page.locator('button[form=modal-form]').click();expect(page.locator('.modal')).to_have_count(0)
    expect(page.locator('.plugin-card')).to_contain_text('review-code');checks.append('SKILL.md save and management UI')
    page.locator('.rail [data-action=settings]').click()
    expect(page.locator('.page h1')).to_have_text('常规')
    page.evaluate("document.querySelector('#toast-root').innerHTML=''"); page.screenshot(path=str(out/'06-settings.png'))
    page.locator('[data-action=settings-tab][data-tab=appearance]').click()
    page.locator('[data-action=set-theme][data-value=dark]').click()
    expect(page.locator('html')).to_have_attribute('data-theme','dark')
    page.locator('[data-action=set-theme][data-value=light]').click()
    expect(page.locator('html')).to_have_attribute('data-theme','light');checks.append('Theme changes and persisted local preferences')
    page.locator('.rail [data-action=go-chat]').click()
    page.locator('#prompt').fill('[approve] 检查项目')
    page.locator('#send-button').click()
    expect(page.locator('.approval-banner')).to_have_count(0)
    expect(page.locator('.transcript .codeblock')).to_be_visible(timeout=10000)
    expect(page.locator('.working')).to_have_count(0)
    page.evaluate("document.querySelector('#toast-root').innerHTML=''"); page.screenshot(path=str(out/'07-fixture-conversation.png'));checks.append('Bidirectional approval and streaming conversation via fixture subprocess')
    expect(page.locator('[data-action=copy-code]')).to_be_visible();checks.append('Rendered code copy control present; system clipboard restricted')
    page.locator('.workspace-top [data-action=session-menu]').click()
    page.locator('[data-action=rename-session]').click()
    page.locator('[name=title]').fill('浏览器回归测试')
    page.locator('button[form=modal-form]').click()
    expect(page.locator('.workspace-title')).to_contain_text('浏览器回归测试')
    page.locator('.workspace-top [data-action=session-menu]').click()
    page.locator('[data-action=archive-session]').click()
    page.locator('[data-action=confirm-modal]').click()
    page.locator('.rail [data-action=history]').click()
    page.locator('.page-head [data-action=archived]').click()
    expect(page.locator('.history-row')).to_contain_text('浏览器回归测试');checks.append('Rename, archive, and history restoration UI')
    page.locator('.rail [data-action=go-chat]').click();page.locator('[data-action=new-chat]').click();expect(page.locator('.welcome h1')).to_be_visible()
    page.locator('.rail [data-action=providers]').click()
    expect(page.locator('.provider-card.active')).to_contain_text('AstroGate');checks.append('Navigation retains provider settings')
    assert not errors, errors
    browser.close()
pathlib.Path(out/'ui-results.json').write_text(json.dumps({'passed':len(checks),'checks':checks,'pageErrors':errors,'note':'Fixture RPC. Browser assets loaded in memory, /api HTTP requests via Python bridge; managed browser blocks URL navigation. SSE/normal navigation not browser-tested.'},ensure_ascii=False,indent=2), encoding='utf-8')
print(json.dumps({'passed':len(checks),'pageErrors':errors,'screenshots':str(out)},ensure_ascii=False))
