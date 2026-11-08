'use strict';

const $ = (id) => document.getElementById(id);
const STORAGE_KEYS = { progress: 'narcissu-progress-v1', settings: 'narcissu-settings-v1', history: 'narcissu-history-v1' };
const DEFAULT_SETTINGS = { mode: 'classic', textSize: 23, autoDelay: 5, musicVolume: 0.55, sfxVolume: 0.8, reduceMotion: false, showReviewedSource: false, showEditorialDrafts: false };
const DEFAULT_LANGUAGE = 'en';

let story = null;
let assetManifest = null;
let faData = { translations: {} };
let revisedOverlay = { translations: {} };
let historicalEventAlignment = {};
let state = {
  screen: 'home', chapterIndex: 0, eventIndex: 0, currentEvent: null,
  backgroundPath: null, currentMusic: null, language: DEFAULT_LANGUAGE,
  windowMode: 'main', auto: false, awaitingClick: false, waitingTimer: null,
  settings: { ...DEFAULT_SETTINGS }, audioChannels: new Map(), musicAudio: null, currentMusicLoop: false,
  centerNext: false, chapterComplete: false, pendingAdvance: false,
  history: [], downloadBusy: false
};

function safeJSONParse(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function normalizePath(path) { return String(path || '').replace(/\\/g, '/').replace(/^\/+/, '').toLocaleLowerCase('en-US'); }
function assetURL(path) {
  const item = assetManifest?.assets?.[normalizePath(path)];
  return item ? new URL(`./public/${item.url}`, document.baseURI).toString() : null;
}
function showToast(message) {
  const el = $('toast'); el.textContent = message; el.classList.add('show');
  clearTimeout(showToast.timer); showToast.timer = setTimeout(() => el.classList.remove('show'), 2600);
}
function chapter() { return story.chapters[state.chapterIndex]; }
function setScreen(name) {
  state.screen = name;
  $('homeScreen').hidden = name !== 'home';
  $('readerScreen').hidden = name !== 'reader';
  $('chapterEndScreen').hidden = name !== 'chapterEnd';
  if (name !== 'reader') $('languageNotice').hidden = true;
}
function applyVisualPreferences() {
  state.settings.mode = state.settings.mode === 'enhanced' ? 'enhanced' : 'classic';
  document.body.dataset.mode = state.settings.mode;
  document.documentElement.style.setProperty('--text-size', `${state.settings.textSize}px`);
  document.body.classList.toggle('reduce-motion', !!state.settings.reduceMotion);
}
function setMode(mode) {
  state.settings.mode = mode === 'enhanced' ? 'enhanced' : 'classic';
  document.body.dataset.mode = state.settings.mode;
  persistSettings();
}
function persistSettings() { localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(state.settings)); }
function loadSettings() {
  state.settings = { ...DEFAULT_SETTINGS, ...safeJSONParse(localStorage.getItem(STORAGE_KEYS.settings), {}) };
  state.settings.showReviewedSource = !!state.settings.showReviewedSource;
  state.settings.showEditorialDrafts = !!state.settings.showEditorialDrafts;
  applyVisualPreferences();
}
function setLanguage(language) {
  state.language = language === 'fa' ? 'fa' : 'en';
  localStorage.setItem('narcissu-language-v1', state.language);
  document.documentElement.lang = state.language;
  document.documentElement.dir = state.language === 'fa' ? 'rtl' : 'ltr';
  $('readerScreen').classList.toggle('is-fa', state.language === 'fa');
  const target = state.language === 'en' ? 'Persian' : 'English';
  $('languageSwitch').setAttribute('aria-label', `Switch to ${target}`);
  $('languageSwitch').title = `Switch to ${target}`;
  $('languageSwitch').innerHTML = state.language === 'en'
    ? '<span class="switch-current">EN</span><span class="switch-arrow">↔</span><span>FA</span>'
    : '<span class="switch-current">FA</span><span class="switch-arrow">↔</span><span>EN</span>';
  if (state.currentEvent) renderCurrentDialogue();
}
function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function renderMarkedText(value) {
  let html = escapeHTML(value || '');
  html = html.replace(/~i~([\s\S]*?)~i~/g, '<em>$1</em>');
  html = html.replace(/~s~([\s\S]*?)~s~/g, '<span class="small">$1</span>');
  return html;
}
function isCoveredWithoutVisiblePersian(ev, sourceEntry, overlayEntry) {
  if (!ev || ev.type !== 'say' || historicalEventAlignment?.[ev.id]?.status !== 'covered') return false;
  const sourceStatus = typeof sourceEntry === 'string' ? 'verified' : (sourceEntry?.status || 'unresolved');
  const sourceVisible = typeof sourceEntry === 'string' ||
    (sourceStatus === 'verified' && !!sourceEntry?.text) ||
    (sourceStatus === 'reviewed' && state.settings.showReviewedSource && !!sourceEntry?.text);
  const defaultOverlayStatuses = ['confirmed_no_change','pause_preserved','localized_sound_effect','transition_translation','orthographic_copy_edit','alignment_correction','assistant_reviewed_revision','assistant_new_translation'];
  const overlayVisible = !!overlayEntry?.text && (defaultOverlayStatuses.includes(overlayEntry.status) || state.settings.showEditorialDrafts);
  return !sourceVisible && !overlayVisible;
}
function renderCurrentDialogue() {
  const ev = state.currentEvent;
  if (!ev || ev.type !== 'say') return;
  const sourceEntry = faData?.translations?.[ev.id] || ev.text_fa || null;
  const overlayEntry = revisedOverlay?.translations?.[ev.id] || null;
  const sourceStatus = typeof sourceEntry === 'string' ? 'verified' : (sourceEntry?.status || 'unresolved');
  const overlayStatus = overlayEntry?.status || null;
  let translated = typeof sourceEntry === 'string' ? sourceEntry : (sourceStatus === 'verified' ? sourceEntry?.text : null);
  let notice = '';
  if (overlayEntry && ['confirmed_no_change','pause_preserved','localized_sound_effect','transition_translation','orthographic_copy_edit','alignment_correction','assistant_reviewed_revision','assistant_new_translation'].includes(overlayStatus)) {
    translated = overlayEntry.text;
    if (overlayStatus === 'assistant_reviewed_revision') notice = 'بازبینی ادبی توسط دستیار انجام شده؛ تأیید مستقل انسانی دریافت نشده است.';
    if (overlayStatus === 'assistant_new_translation') notice = 'این متن فارسی بر اساس انگلیسی بازبینی شده؛ برای این رویداد متن مستقل فارسی در نسخهٔ ۲۰۱۶ در دسترس نیست.';
    if (overlayStatus === 'orthographic_copy_edit') notice = 'اصلاح فاصله‌گذاریِ جزئی؛ در انتظار بازبینی مستقل فارسی.';
    if (overlayStatus === 'alignment_correction') notice = 'اصلاح هم‌ترازی با صفحهٔ منبع؛ در انتظار بازبینی مستقل فارسی.';
  } else if (overlayEntry && state.settings.showEditorialDrafts) {
    translated = overlayEntry.text;
    notice = 'پیش‌نمایش بازنگری: این متن هنوز تأیید نهایی مستقل نشده است.';
  } else if (!translated && sourceStatus === 'reviewed' && state.settings.showReviewedSource) {
    translated = sourceEntry?.text;
    notice = 'این عبارت از ترجمهٔ چاپی ۲۰۱۶ است و هنوز به‌عنوان ترجمهٔ نهایی تأیید نشده است.';
  }
  const isPersian = state.language === 'fa';
  $('dialogueLanguage').textContent = isPersian ? 'فارسی' : 'ENGLISH';
  if (isPersian && isCoveredWithoutVisiblePersian(ev, sourceEntry, overlayEntry)) {
    $('dialogueText').textContent = '';
    $('dialogueText').setAttribute('lang', 'fa');
    $('dialogueText').setAttribute('dir', 'rtl');
    $('languageNotice').textContent = 'این بخش در ترجمهٔ چاپی با جملهٔ قبلی ادغام شده است.';
    $('languageNotice').hidden = false;
  } else if (isPersian && translated) {
    $('dialogueText').innerHTML = renderMarkedText(translated);
    $('dialogueText').setAttribute('lang', 'fa');
    $('dialogueText').setAttribute('dir', 'rtl');
    $('languageNotice').textContent = notice;
    $('languageNotice').hidden = !notice;
  } else if (isPersian) {
    $('dialogueText').textContent = 'ترجمهٔ فارسی این بخش هنوز با متن اصلی هم‌تراز و بازبینی نشده است. برای جلوگیری از نمایش متن نادرست، این بخش فعلاً در نسخهٔ فارسی در دسترس نیست.';
    $('dialogueText').setAttribute('lang', 'fa');
    $('dialogueText').setAttribute('dir', 'rtl');
    $('languageNotice').textContent = 'ترجمهٔ ۲۰۱۶ در حال استخراج و هم‌ترازسازی با متن اصلی است. متن‌های پیش‌نویس فقط با فعال‌کردن پیش‌نمایش QA نمایش داده می‌شوند.';
    $('languageNotice').hidden = false;
  } else {
    $('dialogueText').innerHTML = renderMarkedText(ev.text_en);
    $('dialogueText').setAttribute('lang', 'en');
    $('dialogueText').setAttribute('dir', 'ltr');
    $('languageNotice').hidden = true;
  }
  $('dialoguePanel').classList.toggle('centered', ev.align === 'center');
  $('readerScreen').classList.toggle('caption-mode', ev.window === 'caption');
  $('dialogueStatus').textContent = state.auto ? `Auto · ${state.settings.autoDelay}s` : 'Tap to continue';
  updateProgress();
}
function updateProgress() {
  const ch = chapter();
  if (!ch) return;
  const pct = Math.min(100, (state.eventIndex / Math.max(1, ch.events.length)) * 100);
  $('progressFill').style.width = `${pct}%`;
}
function setBackground(path, effect = 0, duration = 0) {
  const url = assetURL(path);
  state.backgroundPath = path;
  if (!url) { showToast(`Missing background resource: ${path}`); return; }
  const img = $('backgroundImage');
  const ms = state.settings.reduceMotion ? 0 : (duration || ({1:300,3:600,5:1000,10:1000}[effect] || 450));
  img.classList.add('fade-out');
  const apply = () => {
    img.onload = () => { img.classList.remove('fade-out'); img.onload = null; };
    img.onerror = () => { img.classList.remove('fade-out'); showToast(`Could not load image: ${path}`); };
    img.src = url;
    if (img.complete) img.classList.remove('fade-out');
  };
  setTimeout(apply, ms ? Math.min(ms, 220) : 0);
}
function setAudioVolume(audio, volume) { try { audio.volume = Math.max(0, Math.min(1, volume)); } catch {} }
function stopChannel(channel) {
  const audio = state.audioChannels.get(channel);
  if (audio) { audio.pause(); audio.currentTime = 0; state.audioChannels.delete(channel); }
}
function playChannel(ev) {
  const url = assetURL(ev.path);
  if (!url) { showToast(`Missing audio resource: ${ev.path}`); return; }
  stopChannel(ev.channel);
  const audio = new Audio(url);
  audio.loop = !!ev.loop;
  setAudioVolume(audio, ev.channel === 0 ? state.settings.sfxVolume : state.settings.sfxVolume);
  audio.addEventListener('ended', () => { if (state.audioChannels.get(ev.channel) === audio) state.audioChannels.delete(ev.channel); });
  state.audioChannels.set(ev.channel, audio);
  audio.play().catch(() => showToast('Audio will start after your first interaction with the reader.'));
}
function stopMusic() {
  if (state.musicAudio) { state.musicAudio.pause(); state.musicAudio.currentTime = 0; state.musicAudio = null; }
  state.currentMusic = null; state.currentMusicLoop = false;
}
function playMusic(path, loop) {
  const url = assetURL(path);
  if (!url) { showToast(`Missing music resource: ${path}`); return; }
  stopMusic();
  const audio = new Audio(url); audio.loop = !!loop; setAudioVolume(audio, state.settings.musicVolume);
  state.musicAudio = audio; state.currentMusic = path; state.currentMusicLoop = !!loop;
  audio.play().catch(() => showToast('Music will start after your first interaction with the reader.'));
}
function fadeMusic(duration) {
  const audio = state.musicAudio;
  if (!audio) return;
  const steps = 12, start = audio.volume, interval = Math.max(20, duration / steps);
  let step = 0;
  const timer = setInterval(() => {
    step++; setAudioVolume(audio, start * (1 - step / steps));
    if (step >= steps) { clearInterval(timer); stopMusic(); }
  }, interval);
}
function stopAllAudio() {
  for (const channel of [...state.audioChannels.keys()]) stopChannel(channel);
  stopMusic();
}
function saveProgress() {
  if (!story || state.screen === 'home') return;
  const payload = {
    chapterIndex: state.chapterIndex, eventIndex: state.eventIndex,
    currentEventId: state.currentEvent?.id || null, backgroundPath: state.backgroundPath,
    language: state.language, windowMode: state.windowMode, settings: state.settings,
    screen: state.screen, chapterComplete: !!state.chapterComplete,
    currentMusic: state.currentMusic, currentMusicLoop: !!state.currentMusicLoop,
    savedAt: new Date().toISOString()
  };
  localStorage.setItem(STORAGE_KEYS.progress, JSON.stringify(payload));
  $('continueButton').disabled = false;
}
function getProgress() { return safeJSONParse(localStorage.getItem(STORAGE_KEYS.progress), null); }
function restoreProgress(payload) {
  if (!payload || !story) return false;
  clearWaitingTimer();
  stopAllAudio();
  state.auto = false;
  $('autoButton').setAttribute('aria-pressed', 'false');
  state.pendingAdvance = false;
  state.awaitingClick = false;
  state.chapterIndex = Math.max(0, Math.min(story.chapters.length - 1, payload.chapterIndex || 0));
  const ch = chapter(); state.eventIndex = Math.max(0, Math.min(ch.events.length, payload.eventIndex || 0));
  state.currentEvent = payload.currentEventId ? ch.events.find(e => e.id === payload.currentEventId) || null : null;
  state.backgroundPath = payload.backgroundPath || null; state.windowMode = payload.windowMode || 'main';
  state.chapterComplete = !!payload.chapterComplete || payload.screen === 'chapterEnd';
  if (payload.settings) state.settings = { ...DEFAULT_SETTINGS, ...state.settings, ...payload.settings };
  applyVisualPreferences();
  setAudioVolume(state.musicAudio, state.settings.musicVolume);
  setLanguage(payload.language || state.language);
  if (state.backgroundPath) setBackground(state.backgroundPath, 0, 0);
  renderChapterHeading();
  if (state.chapterComplete) {
    renderChapterEndScreen();
  } else {
    setScreen('reader');
    if (state.currentEvent) renderCurrentDialogue(); else { $('dialogueText').textContent = ''; processNext(); }
  }
  if (payload.currentMusic) playMusic(payload.currentMusic, !!payload.currentMusicLoop);
  persistSettings();
  return true;
}
function addHistory(ev) {
  const item = { id: ev.id, chapter: chapter().title_en, text: ev.text_en, at: new Date().toISOString() };
  state.history.unshift(item); state.history = state.history.slice(0, 80);
  localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(state.history));
}
function clearWaitingTimer() { if (state.waitingTimer) clearTimeout(state.waitingTimer); state.waitingTimer = null; }
function renderChapterHeading() {
  const ch = chapter();
  $('chapterNumber').textContent = ch.chapter.toUpperCase();
  $('chapterTitle').textContent = ch.title_en;
}
function startChapter(index, eventIndex = 0) {
  clearWaitingTimer(); stopAllAudio();
  state.auto = false; $('autoButton').setAttribute('aria-pressed', 'false');
  state.chapterIndex = Math.max(0, Math.min(story.chapters.length - 1, index));
  state.eventIndex = eventIndex; state.currentEvent = null; state.windowMode = 'main';
  state.awaitingClick = false; state.chapterComplete = false; state.centerNext = false;
  $('backgroundImage').src = '';
  state.backgroundPath = null;
  setScreen('reader'); renderChapterHeading();
  $('dialogueText').textContent = ''; $('languageNotice').hidden = true;
  processNext(); saveProgress();
}
function startNewGame() { state.history = []; localStorage.setItem(STORAGE_KEYS.history, '[]'); startChapter(0, 0); }
function processNext() {
  if (state.screen !== 'reader') return;
  clearWaitingTimer(); state.awaitingClick = false; state.pendingAdvance = false;
  const ch = chapter();
  while (state.eventIndex < ch.events.length) {
    const ev = ch.events[state.eventIndex++];
    switch (ev.type) {
      case 'background': setBackground(ev.path, ev.effect, ev.duration_ms); break;
      case 'audio_play': playChannel(ev); break;
      case 'audio_stop_channel': stopChannel(ev.channel); break;
      case 'music_play': playMusic(ev.path, ev.loop); break;
      case 'music_fadeout': fadeMusic(ev.duration_ms); break;
      case 'window_mode': state.windowMode = ev.window; break;
      case 'alignment_hint': state.centerNext = true; break;
      case 'clear_text': state.currentEvent = null; $('dialogueText').textContent = ''; break;
      case 'text_speed': break;
      case 'state_flag': break;
      case 'engine_stop_hint': break;
      case 'wait':
        state.awaitingClick = true; state.pendingAdvance = true;
        $('dialogueStatus').textContent = `…`;
        state.waitingTimer = setTimeout(() => { state.waitingTimer = null; processNext(); }, Math.max(0, ev.duration_ms));
        updateProgress(); saveProgress(); return;
      case 'click_wait':
        state.awaitingClick = true; state.pendingAdvance = true;
        $('dialogueText').textContent = ''; $('dialogueLanguage').textContent = '';
        $('dialogueStatus').textContent = 'Tap to continue';
        updateProgress(); saveProgress(); return;
      case 'say':
        state.currentEvent = ev; state.awaitingClick = true; addHistory(ev);
        renderCurrentDialogue(); saveProgress();
        if (state.auto) {
          $('dialogueStatus').textContent = `Auto · ${state.settings.autoDelay}s`;
          state.waitingTimer = setTimeout(() => { state.waitingTimer = null; processNext(); }, state.settings.autoDelay * 1000);
        }
        return;
      case 'chapter_jump':
        showChapterEnd(); return;
      case 'unsupported_command':
        console.warn('Unsupported Ponscripter command retained in data:', ev); break;
      default: console.warn('Unknown event type:', ev.type, ev);
    }
  }
  showChapterEnd();
}
function advance() {
  if (state.screen !== 'reader') return;
  if (state.waitingTimer) { clearWaitingTimer(); state.waitingTimer = null; }
  if (state.awaitingClick || state.pendingAdvance) { processNext(); return; }
  processNext();
}
function renderChapterEndScreen() {
  const ch = chapter(); const hasNext = state.chapterIndex < story.chapters.length - 1;
  $('chapterEndKicker').textContent = hasNext ? 'CHAPTER COMPLETE' : 'THE END';
  $('chapterEndTitle').textContent = ch.title_en;
  $('chapterEndMessage').textContent = hasNext ? 'You have reached the end of this chapter.' : 'You have reached the end of Narcissu 1.';
  $('nextChapterButton').textContent = hasNext ? 'Continue to next chapter' : 'Return to Main Menu';
  $('nextChapterButton').dataset.last = hasNext ? 'false' : 'true';
  setScreen('chapterEnd');
}
function showChapterEnd() {
  clearWaitingTimer(); state.awaitingClick = false; state.chapterComplete = true;
  renderChapterEndScreen();
  saveProgress();
}
function continueChapter() {
  if ($('nextChapterButton').dataset.last === 'true') { setScreen('home'); return; }
  startChapter(state.chapterIndex + 1, 0);
}
function returnHome() { clearWaitingTimer(); saveProgress(); state.auto = false; $('autoButton').setAttribute('aria-pressed','false'); setScreen('home'); stopAllAudio(); }
function renderChapters() {
  const list = $('chapterList'); list.innerHTML = '';
  story.chapters.forEach((ch, i) => {
    const button = document.createElement('button'); button.className = 'chapter-choice'; button.type = 'button';
    const index = String(i).padStart(2,'0');
    button.innerHTML = `<span class="chapter-index">${index}</span><span><strong>${escapeHTML(ch.title_en)}</strong><small>${escapeHTML(ch.chapter)} · ${ch.events.filter(e=>e.type==='say').length} passages</small></span>`;
    button.addEventListener('click', () => { $('chapterSelectPanel').hidden = true; startChapter(i,0); });
    list.appendChild(button);
  });
}
function openSlots(mode) {
  const dialog = $('slotsDialog'); $('slotsEyebrow').textContent = mode === 'save' ? 'Progress' : 'Saved progress';
  $('slotsTitle').textContent = mode === 'save' ? 'Save Game' : 'Load Game';
  const list = $('slotList'); list.innerHTML = '';
  for (let i=1;i<=5;i++) {
    const key = `narcissu-slot-${i}`; const data = safeJSONParse(localStorage.getItem(key), null);
    const row = document.createElement('div'); row.className = 'slot-item';
    const meta = document.createElement('div'); meta.className = 'slot-meta';
    const title = data ? (story.chapters[data.chapterIndex]?.title_en || 'Unknown chapter') : 'Empty slot';
    const date = data ? new Date(data.savedAt).toLocaleString() : 'No saved game';
    meta.innerHTML = `<strong>Slot ${i} · ${escapeHTML(title)}</strong><small>${escapeHTML(date)}</small>`;
    const actions = document.createElement('div'); actions.className = 'slot-actions';
    if (mode === 'save') {
      const b=document.createElement('button');b.textContent='Save here';b.addEventListener('click',()=>{const p=buildSavePayload();localStorage.setItem(key,JSON.stringify(p));dialog.close();showToast(`Saved to slot ${i}.`);});actions.appendChild(b);
    } else if (data) {
      const b=document.createElement('button');b.textContent='Load';b.addEventListener('click',()=>{dialog.close();restoreProgress(data);showToast(`Loaded slot ${i}.`);});actions.appendChild(b);
    }
    row.append(meta,actions); list.appendChild(row);
  }
  dialog.showModal();
}
function buildSavePayload() {
  return { chapterIndex:state.chapterIndex,eventIndex:state.eventIndex,currentEventId:state.currentEvent?.id||null,
    backgroundPath:state.backgroundPath,language:state.language,windowMode:state.windowMode,settings:state.settings,
    screen:state.screen,chapterComplete:!!state.chapterComplete,currentMusic:state.currentMusic,currentMusicLoop:!!state.currentMusicLoop,
    savedAt:new Date().toISOString() };
}
function openHistory() {
  const list=$('historyList');list.innerHTML='';
  state.history=safeJSONParse(localStorage.getItem(STORAGE_KEYS.history),[]);
  if(!state.history.length){list.innerHTML='<p class="small-note">No reading history yet.</p>';}
  for(const item of state.history.slice(0,50)){
    const row=document.createElement('div');row.className='history-entry';
    row.innerHTML=`<small>${escapeHTML(item.chapter)} · ${new Date(item.at).toLocaleString()}</small><p>${escapeHTML(item.text)}</p>`;list.appendChild(row);
  }
  $('historyDialog').showModal();
}
function updateNetworkStatus() {
  const online=navigator.onLine;const el=$('networkStatus');el.classList.toggle('offline',!online);el.querySelector('span').textContent=online?'Online':'Offline';
}
async function registerServiceWorker() {
  if(!('serviceWorker' in navigator)) return;
  try { await navigator.serviceWorker.register('./service-worker.js'); } catch(e) { console.warn('Service worker registration failed',e); }
}
async function openOfflineDialog() {
  $('offlineDialog').showModal();
  $('downloadMeterFill').style.width='0%';$('downloadPercent').textContent='0%';$('downloadStatus').textContent='Not downloaded';
  try {
    const est=await navigator.storage?.estimate?.();
    if(est) $('storageStatus').textContent=`Storage estimate: ${Math.round((est.usage||0)/1024/1024)} MB used of ${Math.round((est.quota||0)/1024/1024)} MB available.`;
    else $('storageStatus').textContent='Storage quota information is not available in this browser.';
  } catch { $('storageStatus').textContent='Could not read storage quota.'; }
}
async function downloadOfflineAssets() {
  if(state.downloadBusy)return;
  state.downloadBusy=true;
  $('startDownloadButton').disabled=true;
  $('downloadStatus').textContent='Preparing resources…';
  let done=0,failed=0,total=0;
  try {
    const items=Object.values(assetManifest.assets).map(x=>new URL(`./public/${x.url}`,document.baseURI).toString());
    total=items.length;
    const cache=await caches.open('narcissu-assets-v2');
    let cursor=0;
    const worker=async()=>{
      while(true){
        const i=cursor++;
        if(i>=items.length)return;
        const url=items[i];
        try {
          const existing=await cache.match(url);
          if(!existing){
            const response=await fetch(url);
            if(!response.ok)throw new Error(`HTTP ${response.status}`);
            await cache.put(url,response.clone());
          }
        } catch(e) {
          failed++;
          console.warn('Offline asset download failed',url,e);
        }
        done++;
        const pct=total?Math.round(done/total*100):100;
        $('downloadMeterFill').style.width=`${pct}%`;
        $('downloadPercent').textContent=`${pct}%`;
        $('downloadStatus').textContent=`${done} of ${total} resources${failed?` · ${failed} failed`:''}`;
      }
    };
    await Promise.all(Array.from({length:4},worker));
    $('downloadStatus').textContent=failed?`Completed with ${failed} failed resources.`:'All referenced resources are cached for offline use.';
    showToast(failed?`Offline download finished; ${failed} files need another attempt.`:'Offline resources are ready.');
  } catch(e) {
    console.error('Offline asset download could not start',e);
    $('downloadStatus').textContent='Could not start offline download. Check browser storage permissions and try again.';
    showToast('Offline download could not start.');
  } finally {
    state.downloadBusy=false;
    $('startDownloadButton').disabled=false;
  }
}
async function clearOfflineAssets() {
  await caches.delete('narcissu-assets-v2');$('downloadMeterFill').style.width='0%';$('downloadPercent').textContent='0%';$('downloadStatus').textContent='Offline assets cleared.';showToast('Offline assets cleared.');
}
function setupSettings() {
  $('modeSetting').value=state.settings.mode;$('textSizeSetting').value=state.settings.textSize;$('autoDelaySetting').value=state.settings.autoDelay;
  $('musicVolumeSetting').value=state.settings.musicVolume;$('sfxVolumeSetting').value=state.settings.sfxVolume;$('reduceMotionSetting').checked=state.settings.reduceMotion;
  $('showReviewedSourceSetting').checked=!!state.settings.showReviewedSource;$('showEditorialDraftsSetting').checked=!!state.settings.showEditorialDrafts;
  $('settingsDialog').showModal();
}
function applySettings() {
  state.settings.mode=$('modeSetting').value;state.settings.textSize=Number($('textSizeSetting').value);state.settings.autoDelay=Number($('autoDelaySetting').value);
  state.settings.musicVolume=Number($('musicVolumeSetting').value);state.settings.sfxVolume=Number($('sfxVolumeSetting').value);state.settings.reduceMotion=$('reduceMotionSetting').checked;
  state.settings.showReviewedSource=$('showReviewedSourceSetting').checked;state.settings.showEditorialDrafts=$('showEditorialDraftsSetting').checked;
  applyVisualPreferences();
  if(state.musicAudio)setAudioVolume(state.musicAudio,state.settings.musicVolume);for(const [channel,audio] of state.audioChannels)setAudioVolume(audio,state.settings.sfxVolume);
  persistSettings();$('settingsDialog').close();if(state.currentEvent)renderCurrentDialogue();showToast('Settings applied.');
}
function toggleAuto() {
  state.auto=!state.auto;$('autoButton').setAttribute('aria-pressed',String(state.auto));
  if(state.auto&&state.currentEvent){clearWaitingTimer();$('dialogueStatus').textContent=`Auto · ${state.settings.autoDelay}s`;state.waitingTimer=setTimeout(()=>{state.waitingTimer=null;processNext();},state.settings.autoDelay*1000);}
  else {clearWaitingTimer();$('dialogueStatus').textContent='Tap to continue';}
}
function toggleFullscreen() {
  if(!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(()=>showToast('Fullscreen is not available here.'));
  else document.exitFullscreen?.();
}
function bindUI() {
  $('brandHome').addEventListener('click',e=>{e.preventDefault();returnHome();});
  $('newGameButton').addEventListener('click',startNewGame);
  $('continueButton').addEventListener('click',()=>{const p=getProgress();if(p)restoreProgress(p);});
  $('chaptersButton').addEventListener('click',()=>{$('chapterSelectPanel').hidden=false;});
  $('closeChapters').addEventListener('click',()=>{$('chapterSelectPanel').hidden=true;});
  $('loadButton').addEventListener('click',()=>openSlots('load'));
  $('settingsButton').addEventListener('click',setupSettings);
  $('saveSettingsButton').addEventListener('click',applySettings);
  $('fullscreenButton').addEventListener('click',toggleFullscreen);
  $('languageSwitch').addEventListener('click',()=>setLanguage(state.language==='en'?'fa':'en'));
  $('nextButton').addEventListener('click',advance);$('dialoguePanel').addEventListener('click',advance);
  $('dialoguePanel').addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();advance();}});
  $('autoButton').addEventListener('click',toggleAuto);
  $('historyButton').addEventListener('click',openHistory);
  $('saveButton').addEventListener('click',()=>openSlots('save'));
  $('readerLoadButton').addEventListener('click',()=>openSlots('load'));
  $('readerMenuButton').addEventListener('click',returnHome);
  $('nextChapterButton').addEventListener('click',continueChapter);
  $('endMenuButton').addEventListener('click',()=>{setScreen('home');});
  $('offlineDownloadButton').addEventListener('click',openOfflineDialog);
  $('startDownloadButton').addEventListener('click',downloadOfflineAssets);
  $('clearDownloadButton').addEventListener('click',clearOfflineAssets);
  window.addEventListener('online',updateNetworkStatus);window.addEventListener('offline',updateNetworkStatus);
  window.addEventListener('beforeunload',saveProgress);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)saveProgress();});
}

async function boot() {
  try {
    const [storyResponse, assetsResponse, faResponse, historicalAlignmentResponse, overlayResponse, increment20Response, chapter2RecoveryResponse, chapter3RecoveryResponse, chapter4RecoveryResponse, chapter4Page44RecoveryResponse, chapter4Page45RecoveryResponse, chapter4Pages46to50RecoveryResponse, chapter1Chapter3RecoveryResponse, literaryProofreadResponse, finalProofreadResponse, increment31ProofreadResponse, increment32ProofreadResponse, increment33ProofreadResponse, increment34ProofreadResponse, increment35ProofreadResponse, increment38AssistantReviewResponse] = await Promise.all([
      fetch('./data/story-gp32.json'), fetch('./data/asset-manifest.json'), fetch('./data/localization/fa.json'),
      fetch('./data/localization/fa-historical-alignment-increment28.json'),
      fetch('./data/localization/fa-revised-overlay-recovery.json'),
      fetch('./data/localization/fa-revised-overlay-increment20.json'),
      fetch('./data/localization/fa-recovered-chapter2-increment21.json'),
      fetch('./data/localization/fa-recovered-chapter3-increment22.json'),
      fetch('./data/localization/fa-recovered-chapter4-increment23.json'),
      fetch('./data/localization/fa-recovered-chapter4-page44-increment24.json'),
      fetch('./data/localization/fa-recovered-chapter4-page45-increment25.json'),
      fetch('./data/localization/fa-recovered-chapter4-pages46-50-increment26.json'),
      fetch('./data/localization/fa-recovered-chapter1-chapter3-increment27.json'),
      fetch('./data/localization/fa-literary-proofread-increment29.json'),
      fetch('./data/localization/fa-literary-proofread-increment30.json'),
      fetch('./data/localization/fa-literary-proofread-increment31.json'),
      fetch('./data/localization/fa-literary-proofread-increment32.json'),
      fetch('./data/localization/fa-literary-proofread-increment33.json'),
      fetch('./data/localization/fa-literary-proofread-increment34.json'),
      fetch('./data/localization/fa-literary-proofread-increment35.json'),
      fetch('./data/localization/fa-assistant-editorial-review-increment38.json')
    ]);
    if(!storyResponse.ok||!assetsResponse.ok)throw new Error('Could not load game data.');
    story=await storyResponse.json();assetManifest=await assetsResponse.json();
    const archivalFaData=faResponse.ok?await faResponse.json():{translations:{}};
    const historicalAlignmentData=historicalAlignmentResponse.ok?await historicalAlignmentResponse.json():{translations:{},event_alignment:{}};
    historicalEventAlignment=historicalAlignmentData.event_alignment||{};
    // Precedence: historical alignment data supersedes the archival fa.json where IDs collide;
    // Increment 17–32 overlays are applied afterwards; the newest proofread layer has final precedence.
    faData={...archivalFaData,translations:{...(archivalFaData.translations||{}),...(historicalAlignmentData.translations||{})}};
    const recoveredOverlay=overlayResponse.ok?await overlayResponse.json():{translations:{}};
    const increment20Overlay=increment20Response.ok?await increment20Response.json():{translations:{}};
    const chapter2RecoveryOverlay=chapter2RecoveryResponse.ok?await chapter2RecoveryResponse.json():{translations:{}};
    const chapter3RecoveryOverlay=chapter3RecoveryResponse.ok?await chapter3RecoveryResponse.json():{translations:{}};
    const chapter4RecoveryOverlay=chapter4RecoveryResponse.ok?await chapter4RecoveryResponse.json():{translations:{}};
    const chapter4Page44RecoveryOverlay=chapter4Page44RecoveryResponse.ok?await chapter4Page44RecoveryResponse.json():{translations:{}};
    const chapter4Page45RecoveryOverlay=chapter4Page45RecoveryResponse.ok?await chapter4Page45RecoveryResponse.json():{translations:{}};
    const chapter4Pages46to50RecoveryOverlay=chapter4Pages46to50RecoveryResponse.ok?await chapter4Pages46to50RecoveryResponse.json():{translations:{}};
    const chapter1Chapter3RecoveryOverlay=chapter1Chapter3RecoveryResponse.ok?await chapter1Chapter3RecoveryResponse.json():{translations:{}};
    const literaryProofreadOverlay=literaryProofreadResponse.ok?await literaryProofreadResponse.json():{translations:{}};
    const finalProofreadOverlay=finalProofreadResponse.ok?await finalProofreadResponse.json():{translations:{}};
    const increment31ProofreadOverlay=increment31ProofreadResponse.ok?await increment31ProofreadResponse.json():{translations:{}};
    const increment32ProofreadOverlay=increment32ProofreadResponse.ok?await increment32ProofreadResponse.json():{translations:{}};
    const increment33ProofreadOverlay=increment33ProofreadResponse.ok?await increment33ProofreadResponse.json():{translations:{}};
    const increment34ProofreadOverlay=increment34ProofreadResponse.ok?await increment34ProofreadResponse.json():{translations:{}};
    const increment35ProofreadOverlay=increment35ProofreadResponse.ok?await increment35ProofreadResponse.json():{translations:{}};
    const increment38AssistantReviewOverlay=increment38AssistantReviewResponse.ok?await increment38AssistantReviewResponse.json():{translations:{}};
    revisedOverlay={...recoveredOverlay,translations:{...(recoveredOverlay.translations||{}),...(increment20Overlay.translations||{}),...(chapter2RecoveryOverlay.translations||{}),...(chapter3RecoveryOverlay.translations||{}),...(chapter4RecoveryOverlay.translations||{}),...(chapter4Page44RecoveryOverlay.translations||{}),...(chapter4Page45RecoveryOverlay.translations||{}),...(chapter4Pages46to50RecoveryOverlay.translations||{}),...(chapter1Chapter3RecoveryOverlay.translations||{}),...(literaryProofreadOverlay.translations||{}),...(finalProofreadOverlay.translations||{}),...(increment31ProofreadOverlay.translations||{}),...(increment32ProofreadOverlay.translations||{}),...(increment33ProofreadOverlay.translations||{}),...(increment34ProofreadOverlay.translations||{}),...(increment35ProofreadOverlay.translations||{}),...(increment38AssistantReviewOverlay.translations||{})}};
    state.history=safeJSONParse(localStorage.getItem(STORAGE_KEYS.history),[]);
    state.language=localStorage.getItem('narcissu-language-v1')||DEFAULT_LANGUAGE;
    loadSettings();bindUI();renderChapters();setLanguage(state.language);updateNetworkStatus();
    $('continueButton').disabled=!getProgress();
    registerServiceWorker();
    if(location.hash==='#play') {const p=getProgress();if(p)restoreProgress(p);}
  } catch(e) {
    console.error(e);document.body.innerHTML=`<main style="max-width:720px;margin:12vh auto;padding:24px;font:16px sans-serif;color:#eee;background:#111"> <h1>Narcissu could not start</h1><p>${escapeHTML(e.message)}</p><p>Serve this folder through a local web server or HTTPS. Opening index.html directly as a file will not load the game data.</p></main>`;
  }
}

boot();
