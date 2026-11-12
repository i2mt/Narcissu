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
      localStorage.setItem('narcissu-ambient-enabled-v1','1');
      window.__audioPlayCalls=[]; window.__primedStoryAudio=new WeakSet();
      HTMLMediaElement.prototype.play=function(){{
        const src=this.src||'';
        if(src.startsWith('data:audio/wav')){{window.__primedStoryAudio.add(this);return Promise.resolve();}}
        if(!window.__primedStoryAudio.has(this))return Promise.reject(new DOMException('User gesture required','NotAllowedError'));
        window.__audioPlayCalls.push(src);return Promise.resolve();
      }};
      HTMLMediaElement.prototype.pause=function(){{}};
      const ambient=document.getElementById('homeAmbientAudio');
      let ambientPlaying=false, resolveAmbient=null, deferAmbient=true;
      Object.defineProperty(ambient,'paused',{{configurable:true,get(){{return !ambientPlaying}}}});
      ambient.play=function(){{ambientPlaying=true;if(deferAmbient)return new Promise(resolve=>{{resolveAmbient=()=>resolve()}});return Promise.resolve()}};
      ambient.pause=function(){{ambientPlaying=false}};
      window.__resolveAmbient=()=>{{deferAmbient=false;if(resolveAmbient){{const r=resolveAmbient;resolveAmbient=null;r()}}}};
      window.__setAmbientPlaying=(value)=>{{ambientPlaying=!!value}};
    }})();'''
    app=(SITE/'app.js').read_text(encoding='utf-8')
    viewports=[(568,320,'compact-phone-landscape'),(844,390,'phone-landscape')]
    out=[]
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
        for w,h,label in viewports:
            context=browser.new_context(viewport={'width':w,'height':h},has_touch=(w<=1024 or 'tablet' in label),is_mobile=(w<=600),reduced_motion='reduce')
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
            page.evaluate('window.__resolveAmbient()')
            page.wait_for_timeout(30)
            ambience_silent_in_settings = page.evaluate("ambientEnabled === false && document.getElementById('homeAmbientAudio').paused") and page.locator('#ambientToggle').is_hidden()
            page.locator('[data-settings-tab="audio"]').click(timeout=2000)
            audio_panel=page.locator('[data-settings-panel="audio"]').evaluate("e=>!e.hidden && getComputedStyle(e).display!=='none'")
            hidden_panels=page.locator('[data-settings-panel][hidden]').count()==3
            page.locator('[data-settings-tab="audio"]').focus()
            page.keyboard.press('ArrowRight')
            accessibility_panel=page.locator('[data-settings-panel="accessibility"]').evaluate("e=>!e.hidden && getComputedStyle(e).display!=='none'")
            keyboard_tab_navigation=accessibility_panel and page.locator('[data-settings-tab="accessibility"]').get_attribute('aria-selected')=='true'
            page.locator('#fullLanguage').select_option('fa')
            page.locator('#saveFullSettings').click(timeout=2000)
            settings_language_applied = page.evaluate('document.documentElement.lang') == 'fa'
            # Open the menu ambience and turn it back off.
            page.evaluate("localStorage.setItem('narcissu-ambient-enabled-v1','0'); window.__resolveAmbient()")
            page.evaluate("stopAmbientSound(); document.getElementById('homeAmbientAudio').play = function(){ window.__setAmbientPlaying(true); return Promise.resolve(); }; document.getElementById('homeAmbientAudio').pause = function(){ window.__setAmbientPlaying(false); };")
            page.locator('#ambientToggle').click(timeout=2000)
            page.wait_for_timeout(30)
            ambient_on=page.locator('#ambientToggle').get_attribute('aria-pressed')
            page.locator('#ambientToggle').click(timeout=2000)
            ambient_off=page.locator('#ambientToggle').get_attribute('aria-pressed')
            page.locator('#settingsButton').click(timeout=2000)
            page.locator('#backFromSettings').click(timeout=2000)
            # Start a new game, check the mobile artwork mapping, and switch languages live.
            page.locator('#newGameButton').click(timeout=5000)
            page.wait_for_timeout(250)
            reader_visible=not page.locator('#readerScreen').evaluate('(e)=>e.hidden')
            orientation_prompt_visible=not page.locator('#orientationPrompt').evaluate('(e)=>e.hidden')
            orientation_prompt_expected = (h > w and (w <= 900 or 'tablet' in label))
            if h > w and (w <= 900 or 'tablet' in label):
                page.set_viewport_size({'width':h,'height':w})
                page.wait_for_timeout(80)
            orientation_prompt_dismisses_in_landscape=page.locator('#orientationPrompt').evaluate('(e)=>e.hidden')
            first_dialogue=page.locator('#dialogueText').inner_text()
            background_src=page.locator('#backgroundImage').get_attribute('src') or ''
            start_language=page.evaluate('document.documentElement.lang')
            page.locator('#languageSwitch').click(timeout=2000)
            page.wait_for_timeout(80)
            after_switch=page.evaluate('document.documentElement.lang')
            page.locator('#languageSwitch').click(timeout=2000)
            page.wait_for_timeout(80)
            after_switch_back=page.evaluate('document.documentElement.lang')
            touch_targets_ok=page.evaluate("""() => {
              const settings=document.getElementById('settingsButton');
              const language=document.getElementById('languageSwitch');
              const sr=settings.getBoundingClientRect(), lr=language.getBoundingClientRect();
              return sr.width >= 28 && sr.width <= 36 && sr.height >= 28 && sr.height <= 36 &&
                lr.height >= 30 && lr.height <= 35;
            }""")
            fullscreen_control_absent=page.evaluate("!document.querySelector('#fullscreenButton, #fullScreenButton, [data-action=fullscreen]')")
            offline_assets_include_photo_and_ambience=page.evaluate("""() => {
              const urls=getOfflineAssetUrls().join(' ').toLowerCase();
              return urls.includes('narcissu-coastal-background.jpg') && urls.includes('narcissu-coastal-ambience.mp3');
            }""")
            # Save to slot one, return home, then exercise Continue.
            page.locator('#saveButton').click(timeout=2000)
            page.locator('#slotsDialog .slot-item').first.locator('button').click(timeout=2000)
            page.locator('#readerMenuButton').click(timeout=2000)
            continue_enabled=not page.locator('#continueButton').is_disabled()
            page.locator('#continueButton').click(timeout=3000)
            continue_restored=not page.locator('#readerScreen').evaluate('(e)=>e.hidden')
            # Exercise a real Ponscripter click_wait followed by music_play.
            page.evaluate("""() => {
              clearWaitingTimer(); state.chapterIndex=1; state.eventIndex=7; state.currentEvent=null;
              state.auto=true; state.settings.autoDelay=0.025; state.pendingAdvance=false; state.awaitingClick=false;
              processNext();
            }""")
            page.wait_for_timeout(220)
            auto_click_wait_reaches_scene_music=page.evaluate("String(state.currentMusic || '').includes('n04.mp3')")
            auto_scene_music_play_attempted=page.evaluate("window.__audioPlayCalls.some(src => src.toLowerCase().includes('n04.mp3'))")
            page.evaluate("playChannel({channel:5,path:'se/umi13.ogg',loop:false})")
            page.wait_for_timeout(40)
            auto_channel_sound_play_attempted=page.evaluate("window.__audioPlayCalls.some(src => src.toLowerCase().includes('umi13.ogg'))")
            page.evaluate("localStorage.setItem('narcissu-ambient-enabled-v1','1')")
            page.locator('#readerMenuButton').click(timeout=2000)
            page.wait_for_timeout(30)
            menu_ambience_restarts_on_return=page.evaluate('ambientEnabled === true')
            page.locator('#settingsButton').click(timeout=2000)
            page.wait_for_timeout(30)
            ambience_stays_off_in_settings_after_return=page.evaluate("ambientEnabled === false && document.getElementById('homeAmbientAudio').paused")
            page.locator('#backFromSettings').click(timeout=2000)
            page.locator('#homeOfflineDownloadButton').click(timeout=2000)
            offline_dialog_opens=page.locator('#offlineDialog').evaluate('(e)=>e.open')
            out.append({
                'viewport':f'{w}x{h}','class':label,'settings_audio_tab_works':audio_panel,
                'settings_keyboard_tab_navigation':keyboard_tab_navigation,
                'only_selected_settings_panel_visible':hidden_panels,
                'ambient_silent_in_settings':ambience_silent_in_settings,
                'orientation_prompt_matches_viewport':orientation_prompt_visible == orientation_prompt_expected,
                'rotate_prompt_hides_in_landscape':orientation_prompt_dismisses_in_landscape,
                'auto_mode_passes_click_wait_and_starts_scene_music':auto_click_wait_reaches_scene_music,
                'auto_mode_music_playback_attempted_after_audio_unlock':auto_scene_music_play_attempted,
                'story_sound_effect_playback_after_audio_unlock':auto_channel_sound_play_attempted,
                'main_menu_offline_download_opens':offline_dialog_opens,
                'settings_language_apply_works':settings_language_applied,
                'ambient_toggle_on':ambient_on=='true','ambient_toggle_off':ambient_off=='false',
                'new_game_opens_reader':reader_visible,'dialogue_loaded':bool(first_dialogue.strip()),
                'background_asset_path':background_src,'language_after_continue':page.evaluate('document.documentElement.lang'),'live_language_switch_round_trip':start_language=='fa' and after_switch=='en' and after_switch_back=='fa',
                'settings_and_language_touch_targets_are_larger':touch_targets_ok,
                'fullscreen_control_removed':fullscreen_control_absent,
                'offline_download_includes_photo_and_ambience':offline_assets_include_photo_and_ambience,
                'menu_ambience_restarts_on_return_home':menu_ambience_restarts_on_return,
                'ambience_stays_off_in_settings_after_return':ambience_stays_off_in_settings_after_return,
                'save_slot_and_continue_work':continue_enabled and continue_restored,
                'page_errors':errors,'console_errors':warnings[:8]
            })
            context.close()
        browser.close()
    (ROOT/'MOBILE_LANDSCAPE_SMOKE_RESULTS_0.60.json').write_text(json.dumps(out,indent=2,ensure_ascii=False),encoding='utf-8')
    failed=[]
    for r in out:
        for key in ['settings_audio_tab_works','settings_keyboard_tab_navigation','only_selected_settings_panel_visible','ambient_silent_in_settings','orientation_prompt_matches_viewport','rotate_prompt_hides_in_landscape','auto_mode_passes_click_wait_and_starts_scene_music','auto_mode_music_playback_attempted_after_audio_unlock','story_sound_effect_playback_after_audio_unlock','main_menu_offline_download_opens','settings_and_language_touch_targets_are_larger','fullscreen_control_removed','offline_download_includes_photo_and_ambience','menu_ambience_restarts_on_return_home','ambience_stays_off_in_settings_after_return','ambient_toggle_on','ambient_toggle_off','new_game_opens_reader','dialogue_loaded','live_language_switch_round_trip','save_slot_and_continue_work']:
            if not r.get(key): failed.append(f"{r['viewport']}: {key}")
        if r['page_errors']: failed.append(f"{r['viewport']}: page errors {r['page_errors']}")
    print(json.dumps({'runs':len(out),'failed_checks':failed,'results_file':'MOBILE_LANDSCAPE_SMOKE_RESULTS_0.60.json','details':out},indent=2,ensure_ascii=False))
    return 1 if failed else 0
if __name__=='__main__': raise SystemExit(main())
