#!/usr/bin/env python3
"""Smoke-test key Narcissu interactions using the real app.js in a controlled page."""
from __future__ import annotations
import base64, json, re
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
SITE=ROOT/'site'

def b64(p): return base64.b64encode(p.read_bytes()).decode('ascii')
def inline_css(css):
    def sub(m):
        raw=m.group(1).strip().strip('"\'')
        if raw.startswith('./fonts/'):
            p=SITE/raw[2:]
            if p.exists(): return f'url("data:font/ttf;base64,{b64(p)}")'
        if raw=='./public/assets/images/narcissu-coastal-background.jpg':
            p=SITE/'public/assets/images/narcissu-coastal-background.jpg'
            return f'url("data:image/jpeg;base64,{b64(p)}")'
        if raw=='./public/assets/e/umibe_yoru.jpg':
            p=SITE/'public/assets/e/umibe_yoru.jpg'
            return f'url("data:image/jpeg;base64,{b64(p)}")'
        return m.group(0)
    return re.sub(r'url\(([^)]+)\)',sub,css)
def build_html():
    h=(SITE/'index.html').read_text()
    h=h.replace('<head>','<head><base href="https://narcissu.test/Narcissu/">')
    h=h.replace('<link rel="stylesheet" href="./styles.css">','<style>'+inline_css((SITE/'styles.css').read_text())+'</style>')
    h=h.replace('<link rel="stylesheet" href="./responsive.css">','<style>'+inline_css((SITE/'responsive.css').read_text())+'</style>')
    h=h.replace('./public/assets/images/narcissu-coastal-background.jpg', 'data:image/jpeg;base64,'+b64(SITE/'public/assets/images/narcissu-coastal-background.jpg'))
    h=h.replace('<script src="./app.js" defer></script>','')
    return h

def main():
    fixtures={}
    for rel in ['data/story-gp32.json','data/asset-manifest.json','data/localization/fa.json']:
        fixtures[rel]=json.loads((SITE/rel).read_text(encoding='utf-8'))
    fixtures64=base64.b64encode(json.dumps(fixtures,ensure_ascii=False).encode()).decode()
    prelude=f'''(() => {{
      const fixtures=JSON.parse(atob("{fixtures64}"));
      window.fetch=async (input,init)=>{{
        const raw=(typeof input==='string'||input instanceof URL)?String(input):input.url;
        const url=new URL(raw,document.baseURI); const key=url.pathname.replace(/^\\/Narcissu\\//,'');
        return new Response(JSON.stringify(fixtures[key]??{{}}),{{status:200,headers:{{'Content-Type':'application/json'}}}});
      }};
      const makeStorage=()=>{{const m=new Map();return {{get length(){{return m.size}},key(i){{return [...m.keys()][i]??null}},getItem(k){{return m.has(String(k))?m.get(String(k)):null}},setItem(k,v){{m.set(String(k),String(v))}},removeItem(k){{m.delete(String(k))}},clear(){{m.clear()}}}}}};
      Object.defineProperty(window,'localStorage',{{configurable:true,value:makeStorage()}});
      Object.defineProperty(window,'sessionStorage',{{configurable:true,value:makeStorage()}});
      localStorage.setItem('narcissu-welcome-prepared-v1','1');
      localStorage.setItem('narcissu-ambient-enabled-v1','0');
      HTMLMediaElement.prototype.play=function(){{return Promise.resolve()}};
      HTMLMediaElement.prototype.pause=function(){{}};
    }})();'''
    app=(SITE/'app.js').read_text(encoding='utf-8')
    viewports=[(390,844,'phone-portrait'),(844,390,'phone-landscape'),(768,1024,'tablet-portrait'),(1024,768,'tablet-landscape'),(1536,864,'desktop')]
    out=[]
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
        for w,h,label in viewports:
            context=browser.new_context(viewport={'width':w,'height':h},has_touch=(w<=1024),is_mobile=(w<=600),reduced_motion='reduce')
            page=context.new_page()
            errors=[]; warnings=[]
            page.on('pageerror',lambda e,arr=errors:arr.append(str(e)))
            page.on('console',lambda m,arr=warnings:arr.append(m.text) if m.type=='error' else None)
            def handler(route):
                url=route.request.url
                marker='/Narcissu/'
                rel=url.split(marker,1)[1] if marker in url else ''
                file=SITE/rel
                if file.is_file():
                    mime={'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.ogg':'audio/ogg','.mp3':'audio/mpeg','.ttf':'font/ttf'}.get(file.suffix.lower(),'application/octet-stream')
                    route.fulfill(status=200,body=file.read_bytes(),content_type=mime,headers={'Access-Control-Allow-Origin':'*'})
                else:
                    route.fulfill(status=404,body='missing test asset')
            page.route('https://narcissu.test/Narcissu/**',handler)
            page.set_content(build_html(),wait_until='domcontentloaded')
            page.add_script_tag(content=prelude)
            page.add_script_tag(content=app)
            # The app starts with its first-visit dedication card. Dismiss it for deterministic interaction checks.
            page.wait_for_timeout(250)
            if page.locator('#dedicationScreen').count():
                page.locator('#dedicationScreen').evaluate("e=>{e.hidden=true;e.setAttribute('aria-hidden','true')}")
            # Settings controls and tab switching.
            page.locator('#settingsButton').click(timeout=5000)
            page.locator('[data-settings-tab="audio"]').click(timeout=2000)
            audio_panel=page.locator('[data-settings-panel="audio"]').evaluate("e=>!e.hidden && getComputedStyle(e).display!=='none'")
            page.locator('#fullLanguage').select_option('fa')
            page.locator('#saveFullSettings').click(timeout=2000)
            settings_language_applied = page.evaluate('document.documentElement.lang') == 'fa'
            # Open the menu ambience and turn it back off.
            page.locator('#ambientToggle').click(timeout=2000)
            page.wait_for_timeout(30)
            ambient_on=page.locator('#ambientToggle').get_attribute('aria-pressed')
            page.locator('#ambientToggle').click(timeout=2000)
            ambient_off=page.locator('#ambientToggle').get_attribute('aria-pressed')
            # Start a new game, check the mobile artwork mapping, and switch languages live.
            page.locator('#newGameButton').click(timeout=5000)
            page.wait_for_timeout(250)
            reader_visible=not page.locator('#readerScreen').evaluate('(e)=>e.hidden')
            first_dialogue=page.locator('#dialogueText').inner_text()
            background_src=page.locator('#backgroundImage').get_attribute('src') or ''
            start_language=page.evaluate('document.documentElement.lang')
            page.locator('#languageSwitch').click(timeout=2000)
            page.wait_for_timeout(80)
            after_switch=page.evaluate('document.documentElement.lang')
            page.locator('#languageSwitch').click(timeout=2000)
            page.wait_for_timeout(80)
            after_switch_back=page.evaluate('document.documentElement.lang')
            # Save to slot one, return home, then exercise Continue.
            page.locator('#saveButton').click(timeout=2000)
            page.locator('#slotsDialog .slot-item').first.locator('button').click(timeout=2000)
            page.locator('#readerMenuButton').click(timeout=2000)
            continue_enabled=not page.locator('#continueButton').is_disabled()
            page.locator('#continueButton').click(timeout=3000)
            continue_restored=not page.locator('#readerScreen').evaluate('(e)=>e.hidden')
            out.append({
                'viewport':f'{w}x{h}','class':label,'settings_audio_tab_works':audio_panel,
                'settings_language_apply_works':settings_language_applied,
                'ambient_toggle_on':ambient_on=='true','ambient_toggle_off':ambient_off=='false',
                'new_game_opens_reader':reader_visible,'dialogue_loaded':bool(first_dialogue.strip()),
                'background_asset_path':background_src,'language_after_continue':page.evaluate('document.documentElement.lang'),'live_language_switch_round_trip':start_language=='fa' and after_switch=='en' and after_switch_back=='fa',
                'save_slot_and_continue_work':continue_enabled and continue_restored,
                'page_errors':errors,'console_errors':warnings[:8]
            })
            context.close()
        browser.close()
    (ROOT/'INTERACTION_SMOKE_RESULTS_0.54.json').write_text(json.dumps(out,indent=2,ensure_ascii=False),encoding='utf-8')
    failed=[]
    for r in out:
        for key in ['settings_audio_tab_works','ambient_toggle_on','ambient_toggle_off','new_game_opens_reader','dialogue_loaded','live_language_switch_round_trip','save_slot_and_continue_work']:
            if not r.get(key): failed.append(f"{r['viewport']}: {key}")
        if r['page_errors']: failed.append(f"{r['viewport']}: page errors {r['page_errors']}")
    print(json.dumps({'runs':len(out),'failed_checks':failed,'results_file':'INTERACTION_SMOKE_RESULTS_0.54.json','details':out},indent=2,ensure_ascii=False))
    return 1 if failed else 0
if __name__=='__main__': raise SystemExit(main())
