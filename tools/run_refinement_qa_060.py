#!/usr/bin/env python3
"""Focused QA for Narcissu 0.60 title lockup, mobile menu and welcome screen."""
from pathlib import Path
import json, sys
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools'))
from run_browser_layout_qa import build_html, box
QA=ROOT/'qa'; QA.mkdir(exist_ok=True)
VIEWPORTS=[(568,320),(640,360),(740,360),(844,390),(900,600),(1024,768)]
results=[]
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    for w,h in VIEWPORTS:
        context=browser.new_context(viewport={'width':w,'height':h},has_touch=True,is_mobile=True)
        page=context.new_page()
        page.set_content(build_html(),wait_until='domcontentloaded')
        page.wait_for_timeout(30)
        page.locator('#homeScreen').evaluate('(e)=>e.hidden=false')
        menu=page.locator('.menu-actions .menu-button').first.evaluate('''e=>{const c=getComputedStyle(e),r=e.getBoundingClientRect();return {textAlign:c.textAlign,justifyContent:c.justifyContent,fontSize:parseFloat(c.fontSize),height:r.height,paddingLeft:parseFloat(c.paddingLeft),paddingRight:parseFloat(c.paddingRight)}}''')
        title=page.locator('#homeTitle').evaluate('''e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,center:(r.left+r.right)/2}}''')
        jp=page.locator('.home-japanese-title').evaluate('''e=>{const r=e.getBoundingClientRect(),c=getComputedStyle(e);return {left:r.left,right:r.right,center:(r.left+r.right)/2,textAlign:c.textAlign}}''')
        subtitle=page.locator('.home-subtitle').inner_text()
        home_checks={
          'menu_labels_align_toward_arrows':menu['textAlign']=='right' and menu['justifyContent']=='flex-end',
          'menu_text_slightly_enlarged':menu['fontSize']>=11,
          'menu_rows_not_too_short':menu['height']>=29,
          'japanese_title_centered_under_wordmark':abs(title['center']-jp['center'])<=2 and jp['textAlign']=='center',
          'unnecessary_narcissu_1_removed':'Narcissu 1' not in subtitle,
        }
        if (w,h) in [(568,320),(844,390)]:
            page.screenshot(path=str(QA/f'home-{w}x{h}.png'))
        # First-visit screen, same viewport.
        page.locator('#welcomeScreen').evaluate("e=>{e.hidden=false;e.setAttribute('aria-hidden','false')}")
        welcome=page.locator('.welcome-preload-card').evaluate('''e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight,overflow:getComputedStyle(e).overflow}}''')
        welcome_scroll=page.locator('#welcomeScreen').evaluate('(e)=>({scrollHeight:e.scrollHeight,clientHeight:e.clientHeight,overflowY:getComputedStyle(e).overflowY})')
        actions=box(page,'.welcome-actions')
        note=box(page,'.welcome-note')
        welcome_checks={
          'welcome_card_inside_viewport':welcome['x']>=0 and welcome['y']>=0 and welcome['right']<=w+1 and welcome['bottom']<=h+1,
          'welcome_card_does_not_need_vertical_scroll':welcome['scrollHeight']<=welcome['clientHeight']+1,
          'welcome_actions_visible':actions['y']>=0 and actions['bottom']<=h+1,
          'welcome_note_visible':note['y']>=0 and note['bottom']<=h+1,
        }
        if (w,h) in [(568,320),(844,390)]:
            page.screenshot(path=str(QA/f'welcome-{w}x{h}.png'))
        results.append({'viewport':f'{w}x{h}','menu':menu,'title':title,'japanese':jp,'subtitle':subtitle,'welcome':welcome,'home_checks':home_checks,'welcome_checks':welcome_checks})
        context.close()
    browser.close()
failed=[f"{r['viewport']} {k}" for r in results for group in ['home_checks','welcome_checks'] for k,v in r[group].items() if not v]
summary={'viewport_count':len(results),'failed_checks':failed,'results_file':'REFINEMENT_QA_RESULTS_0.60.json','screenshots':[p.name for p in QA.glob('welcome-*.png')]+[p.name for p in QA.glob('home-*.png') if p.name in ('home-568x320.png','home-844x390.png')]}
(ROOT/'REFINEMENT_QA_RESULTS_0.60.json').write_text(json.dumps({'summary':summary,'results':results},indent=2,ensure_ascii=False),encoding='utf-8')
print(json.dumps(summary,indent=2))
raise SystemExit(1 if failed else 0)
