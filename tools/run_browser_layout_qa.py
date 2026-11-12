#!/usr/bin/env python3
"""Chromium responsive layout QA using the real HTML and CSS.

Host policy blocks Chromium navigation to local and public URLs. This harness
uses page.set_content() and inlines the project's actual CSS and local assets.
It verifies layout geometry at a device matrix; it does not claim physical
hardware, network, service-worker, or full gameplay certification.
"""
from __future__ import annotations
import base64, json, re
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / 'site'
QA_DIR = ROOT / 'qa'
QA_DIR.mkdir(exist_ok=True)


def data_uri(path: Path, mime: str) -> str:
    return f'data:{mime};base64,' + base64.b64encode(path.read_bytes()).decode('ascii')


def inline_css_assets(css: str) -> str:
    def replace(match):
        raw = match.group(1).strip().strip('"\'')
        if raw.startswith('./fonts/'):
            file = SITE / raw[2:]
            if file.exists(): return f'url("{data_uri(file, "font/ttf")}")'
        if raw == './public/assets/e/umibe_yoru.jpg':
            file = SITE / 'public/assets/e/umibe_yoru.jpg'
            return f'url("{data_uri(file, "image/jpeg")}")'
        if raw == './public/assets/images/narcissu-coastal-background.jpg':
            file = SITE / 'public/assets/images/narcissu-coastal-background.jpg'
            return f'url("{data_uri(file, "image/jpeg")}")'
        return match.group(0)
    return re.sub(r'url\(([^)]+)\)', replace, css)


def build_html() -> str:
    html = (SITE / 'index.html').read_text(encoding='utf-8')
    styles = inline_css_assets((SITE / 'styles.css').read_text(encoding='utf-8'))
    responsive = inline_css_assets((SITE / 'responsive.css').read_text(encoding='utf-8'))
    fox = data_uri(SITE / 'icons/fox-emblem-white.png', 'image/png')
    photo = data_uri(SITE / 'public/assets/images/narcissu-coastal-background.jpg', 'image/jpeg')
    html = html.replace('<link rel="stylesheet" href="./styles.css">', '<style>' + styles + '</style>')
    html = html.replace('<link rel="stylesheet" href="./responsive.css">', '<style>' + responsive + '</style>')
    html = html.replace('./icons/fox-emblem-white.png', fox)
    html = html.replace('./public/assets/images/narcissu-coastal-background.jpg', photo)
    html = html.replace('<script src="./app.js" defer></script>', '')
    html = html.replace('<audio id="homeAmbientAudio" src="./public/assets/audio/narcissu-coastal-ambience.mp3" preload="none" loop></audio>', '')
    # Keep the test reader artwork deterministic and independent of network loading.
    html = html.replace('<img id="backgroundImage" alt="" draggable="false">', f'<img id="backgroundImage" src="{photo}" alt="" draggable="false">')
    return html


def box(page, selector):
    return page.locator(selector).evaluate('''e => { const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom,scrollW:e.scrollWidth,clientW:e.clientWidth,scrollH:e.scrollHeight,clientH:e.clientHeight}; }''')


def overlaps(a, b, tolerance=1):
    return a['x'] < b['right']-tolerance and a['right'] > b['x']+tolerance and a['y'] < b['bottom']-tolerance and a['bottom'] > b['y']+tolerance


def set_state(page, name, language='en'):
    page.evaluate('''({name,language}) => {
      const shell=document.querySelector('.app-shell'), stage=document.querySelector('#stage');
      const home=document.querySelector('#homeScreen'), settings=document.querySelector('#settingsScreen'), reader=document.querySelector('#readerScreen');
      home.hidden = name==='reader'; settings.hidden = name!=='settings'; reader.hidden = name!=='reader';
      stage.classList.toggle('has-home-backdrop', name!=='reader');
      stage.classList.toggle('is-settings-open', name==='settings');
      stage.classList.toggle('is-reading', name==='reader');
      shell.classList.toggle('is-home-backdrop', name!=='reader');
      shell.classList.toggle('is-reading', name==='reader');
      const compact = name==='reader' && (innerWidth<=1100 || matchMedia('(any-pointer: coarse)').matches);
      shell.classList.toggle('is-compact-reading',compact);
      const actions=document.querySelector(compact?'.reader-top-actions':'.topbar-actions');
      actions.appendChild(document.querySelector('#settingsButton'));
      document.querySelectorAll('[data-settings-panel]').forEach(panel=>panel.hidden=panel.dataset.settingsPanel!=='reading');
      document.querySelectorAll('[data-settings-tab]').forEach(tab=>{const active=tab.dataset.settingsTab==='reading';tab.classList.toggle('is-active',active);tab.setAttribute('aria-selected',String(active));});
      const rotate=document.querySelector('#orientationPrompt');
      const portraitBlocked=['home','reader','chapterEnd'].includes(name) && matchMedia('(orientation: portrait)').matches && (matchMedia('(any-pointer: coarse)').matches || innerWidth<=900);
      rotate.hidden=!portraitBlocked; shell.inert=portraitBlocked;
      reader.classList.toggle('is-fa', language==='fa');
      reader.setAttribute('dir', language==='fa'?'rtl':'ltr');
      document.querySelector('#dialogueText').textContent = language==='fa'
        ? 'گاهی تصور می‌کنیم سفر فقط عبور از یک مکان به مکان دیگر است. اما بعضی راه‌ها ما را به خاطراتی بازمی‌گردانند که سال‌ها کوشیده‌ایم پشت سر بگذاریم.'
        : 'Sometimes we imagine that a journey is simply a passage from one place to another. Yet some roads lead us back to memories we have spent years trying to leave behind.';
      document.querySelector('#dialogueLanguage').textContent = language==='fa'?'PERSIAN':'ENGLISH';
    }''', {'name':name,'language':language})


def run():
    touch_sizes = [
        (320,568,'phone-small'), (320,640,'phone-small-tall'), (360,740,'phone'),
        (375,812,'phone'), (390,844,'phone'), (414,896,'phone-large'), (430,932,'phone-large'),
        (600,960,'small-tablet-portrait'), (768,1024,'tablet-portrait'), (800,1280,'tablet-portrait'), (820,1180,'tablet-portrait'), (1024,1366,'tablet-wide-portrait'), (1366,1024,'tablet-wide-landscape'),
        (568,320,'phone-landscape'), (640,360,'phone-landscape'), (740,360,'phone-landscape'), (844,390,'phone-landscape'),
        (900,600,'tablet-landscape'), (1024,768,'tablet-landscape'),
    ]
    desktop_sizes = [(1280,720,'desktop'),(1366,768,'desktop'),(1536,864,'desktop')]
    results=[]
    photo = data_uri(SITE/'public/assets/images/narcissu-coastal-background.jpg','image/jpeg')
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
        for is_touch, sizes in [(True,touch_sizes),(False,desktop_sizes)]:
            context=browser.new_context(viewport={'width':sizes[0][0],'height':sizes[0][1]},has_touch=is_touch,is_mobile=is_touch,reduced_motion='reduce')
            page=context.new_page()
            page.set_content(build_html(),wait_until='domcontentloaded')
            for w,h,label in sizes:
                page.set_viewport_size({'width':w,'height':h})
                page.wait_for_timeout(20)
                record={'viewport':f'{w}x{h}','class':label}
                # Home menu
                set_state(page,'home')
                home={
                    'docW':page.evaluate('document.documentElement.scrollWidth'),
                    'screen':box(page,'#homeScreen'),'content':box(page,'.home-content'),
                    'identity':box(page,'.home-identity'),'menu':box(page,'.home-menu-column'),
                    'footer':box(page,'.home-footer'),
                    'menu_style':page.evaluate('''() => {
                      const read = selector => {
                        const e=document.querySelector(selector), c=getComputedStyle(e);
                        const m=c.backgroundColor.match(/rgba?\\(([^)]+)\\)/);
                        const parts=m?m[1].split(',').map(v=>parseFloat(v.trim())):[];
                        return {background:c.backgroundColor,alpha:parts.length===4?parts[3]:1,
                          backdrop:c.backdropFilter,
                          backgroundImage:c.backgroundImage};
                      };
                      return {primary:read('.menu-actions .primary-button'),secondary:read('.menu-actions .menu-button')};
                    }''')
                }
                prompt_home_visible = page.locator('#orientationPrompt').evaluate('(e)=>!e.hidden')
                prompt_home_expected = h > w and (is_touch or w <= 900)
                home_inert = page.locator('.app-shell').evaluate('(e)=>e.inert')
                # The portrait gate intentionally covers the chapter panel. Check
                # its foreground stacking after temporarily switching to landscape.
                if prompt_home_expected:
                    page.set_viewport_size({'width':h,'height':w})
                    set_state(page,'home')
                    page.wait_for_timeout(20)
                page.locator('#chapterSelectPanel').evaluate('(e)=>e.hidden=false')
                chapter_layer = page.locator('#chapterSelectPanel').evaluate("""e=>{
                  const r=e.getBoundingClientRect(), hit=document.elementFromPoint(r.left+Math.min(20,r.width/3),r.top+Math.min(20,r.height/3));
                  return {z:Number(getComputedStyle(e).zIndex),hitInside:!!hit?.closest('#chapterSelectPanel'),visible:r.width>0&&r.height>0};
                }""")
                page.locator('#chapterSelectPanel').evaluate('(e)=>e.hidden=true')
                if prompt_home_expected:
                    page.set_viewport_size({'width':w,'height':h})
                    set_state(page,'home')
                    page.wait_for_timeout(20)
                menu_style=home['menu_style']
                if w <= 900:
                    mobile_menu_surface = all(
                        0.10 <= menu_style[k]['alpha'] <= 0.35
                        and menu_style[k]['backdrop'] == 'none'
                        and menu_style[k]['backgroundImage'] == 'none'
                        for k in ('primary','secondary')
                    )
                else:
                    mobile_menu_surface = all(
                        menu_style[k]['backdrop'] == 'none'
                        and menu_style[k]['backgroundImage'] == 'none'
                        for k in ('primary','secondary')
                    )
                home_checks={
                    'no_document_horizontal_overflow':home['docW']<=w,
                    'mobile_menu_background_is_translucent_and_unblurred':mobile_menu_surface,
                    'identity_and_menu_do_not_overlap':not overlaps(home['identity'],home['menu']),
                    'menu_inside_home_screen':home['menu']['x']>=home['screen']['x']-1 and home['menu']['right']<=home['screen']['right']+1,
                    'footer_inside_home_screen':home['footer']['bottom']<=home['screen']['bottom']+1 or home['screen']['scrollH']>home['screen']['clientH'],
                    'home_orientation_prompt_matches_viewport':prompt_home_visible==prompt_home_expected,
                    'portrait_home_is_inert':home_inert==prompt_home_expected,
                    'chapter_select_is_foreground_layer':chapter_layer['visible'] and chapter_layer['z']>=50 and chapter_layer['hitInside'],
                }
                if (w,h) in [(320,568),(390,844),(768,1024),(820,1180),(844,390),(1024,768),(1536,864)]:
                    page.screenshot(path=str(QA_DIR/f'home-{w}x{h}.png'))
                # Settings overlay
                set_state(page,'settings')
                settings={
                    'docW':page.evaluate('document.documentElement.scrollWidth'),
                    'panel':box(page,'#settingsScreen'),'sidebar':box(page,'.settings-sidebar'),
                    'main':box(page,'.settings-main'),'actions':box(page,'.settings-actions')
                }
                settings_checks={
                    'no_document_horizontal_overflow':settings['docW']<=w,
                    'panel_inside_viewport':settings['panel']['x']>=0 and settings['panel']['y']>=0 and settings['panel']['right']<=w+1 and settings['panel']['bottom']<=h+1,
                    'actions_inside_panel':settings['actions']['x']>=settings['panel']['x'] and settings['actions']['right']<=settings['panel']['right']+1 and settings['actions']['bottom']<=settings['panel']['bottom']+1,
                    'main_and_actions_do_not_overlap':not overlaps(settings['main'],settings['actions']),
                    'only_one_settings_panel_visible':page.locator('[data-settings-panel]:not([hidden])').count()==1,
                }
                if (w,h) in [(320,568),(390,844),(768,1024),(820,1180),(844,390),(1024,768),(1536,864)]:
                    page.screenshot(path=str(QA_DIR/f'settings-{w}x{h}.png'))
                # English and Persian reader
                reader_checks={}
                for lang in ['en','fa']:
                    set_state(page,'reader',lang)
                    reader={
                        'docW':page.evaluate('document.documentElement.scrollWidth'),
                        'screen':box(page,'#readerScreen'),'dialogue':box(page,'#dialoguePanel'),
                        'text':box(page,'#dialogueText'),'toolbar':box(page,'.reader-toolbar'),
                        'topline':box(page,'.reader-topline'),
                        'dir':page.locator('#readerScreen').get_attribute('dir')
                    }
                    reader_checks[lang]={
                        'orientation_prompt_matches_viewport':page.locator('#orientationPrompt').evaluate('(e)=>!e.hidden') == (h > w and (is_touch or w <= 900)),
                        'reader_portrait_is_inert':page.locator('.app-shell').evaluate('(e)=>e.inert') == (h > w and (is_touch or w <= 900)),
                        'no_document_horizontal_overflow':reader['docW']<=w,
                        'dialogue_inside_viewport':reader['dialogue']['x']>=0 and reader['dialogue']['right']<=w+1 and reader['dialogue']['y']>=0 and reader['dialogue']['bottom']<=h+1,
                        'toolbar_inside_viewport':reader['toolbar']['x']>=0 and reader['toolbar']['right']<=w+1 and reader['toolbar']['y']>=0 and reader['toolbar']['bottom']<=h+1,
                        'dialogue_and_toolbar_do_not_overlap':reader['dialogue']['bottom']<=reader['toolbar']['y']+1,
                        'correct_direction':reader['dir']==('rtl' if lang=='fa' else 'ltr'),
                    }
                    if lang=='en' and (w,h) in [(320,568),(390,844),(768,1024),(820,1180),(844,390),(1024,768),(1536,864)]:
                        page.screenshot(path=str(QA_DIR/f'reader-{w}x{h}.png'))
                record.update({'home':home,'settings':settings,'reader_checks':reader_checks,'checks':{
                    **{f'home_{k}':v for k,v in home_checks.items()},
                    **{f'settings_{k}':v for k,v in settings_checks.items()},
                    **{f'reader_{lang}_{k}':v for lang,checks in reader_checks.items() for k,v in checks.items()},
                }})
                results.append(record)
            context.close()
        browser.close()
    (ROOT/'BROWSER_QA_RESULTS_0.60.json').write_text(json.dumps(results,indent=2,ensure_ascii=False),encoding='utf-8')
    failed=[f"{r['viewport']}: {k}" for r in results for k,v in r['checks'].items() if not v]
    summary={'viewport_count':len(results),'states_tested':['home','settings','reader-en','reader-fa'],'failed_checks':failed,'screenshots':len(list(QA_DIR.glob('*.png'))),'results_file':'BROWSER_QA_RESULTS_0.60.json'}
    (ROOT/'BROWSER_QA_SUMMARY_0.60.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
    print(json.dumps(summary,indent=2))
    return 1 if failed else 0

if __name__=='__main__':
    raise SystemExit(run())
