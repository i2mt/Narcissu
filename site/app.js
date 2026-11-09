'use strict';

const $ = (id) => document.getElementById(id);
const STORAGE_KEYS = { progress: 'narcissu-progress-v1', settings: 'narcissu-settings-v1', history: 'narcissu-history-v1' };
const DEFAULT_SETTINGS = { mode: 'enhanced', persianFont: 'parastoo', textSize: 18, autoDelay: 5, musicVolume: 0.55, sfxVolume: 0.8, reduceMotion: false };
const DEFAULT_LANGUAGE = 'en';
const PERSIAN_FONT_SOURCES = {
  parastoo: {
    family: 'NarcissuParastoo',
    cssUrl: 'https://fonts.googleapis.com/css2?family=Parastoo:wght@400..700&display=swap'
  },
  vazirmatn: {
    family: 'NarcissuVazirmatn',
    cssUrl: 'https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400..700&display=swap'
  }
};
const loadedPersianFonts = new Set();
const pendingPersianFonts = new Map();
let dedicationTimer = null;
let dedicationDismissed = false;
let dialogueFitFrame = 0;

let story = null;
let assetManifest = null;
let faData = { translations: {} };
let revisedOverlay = { translations: {} };
let historicalEventAlignment = {};
let deferredInstallPrompt = null;
let state = {
  screen: 'home', chapterIndex: 0, eventIndex: 0, currentEvent: null,
  backgroundPath: null, currentMusic: null, language: DEFAULT_LANGUAGE,
  windowMode: 'main', auto: false, awaitingClick: false, waitingTimer: null,
  settings: { ...DEFAULT_SETTINGS }, audioChannels: new Map(), musicAudio: null, currentMusicLoop: false,
  musicFadeTimer: null,
  centerNext: false, chapterComplete: false, pendingAdvance: false,
  history: [], passageHistory: [], downloadBusy: false,
  revealActive: false, revealTimer: null, revealDurationMs: 0, revealEndsAt: 0
};

function safeJSONParse(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function normalizePath(path) { return String(path || '').replace(/\\/g, '/').replace(/^\/+/, '').toLocaleLowerCase('en-US'); }
function isMobileArtworkViewport() {
  return !!window.matchMedia?.('(max-width: 760px), (max-height: 500px) and (orientation: landscape)').matches;
}
function isMobileLandscapeViewport() {
  return !!window.matchMedia?.('(max-height: 500px) and (orientation: landscape)').matches;
}
function assetURL(path, preferMobileArtwork = false) {
  const item = assetManifest?.assets?.[normalizePath(path)];
  if (!item) return null;
  let selectedPath = item.url;
  if (preferMobileArtwork && isMobileArtworkViewport()) {
    selectedPath = isMobileLandscapeViewport()
      ? (item.mobile_landscape_url || item.mobile_url || item.url)
      : (item.mobile_url || item.url);
  }
  return new URL(`./public/${selectedPath}`, document.baseURI).toString();
}
function showToast(message) {
  const el = $('toast'); el.textContent = message; el.classList.add('show');
  clearTimeout(showToast.timer); showToast.timer = setTimeout(() => el.classList.remove('show'), 2600);
}
function chapter() { return story.chapters[state.chapterIndex]; }
function updateReaderChrome() {
  const reading = state.screen === 'reader';
  const compact = reading && isMobileArtworkViewport();
  const shell = document.querySelector('.app-shell');
  shell?.classList.toggle('is-reading', reading);
  shell?.classList.toggle('is-compact-reading', compact);
  // Desktop keeps its familiar top bar. Phones move only the essential actions
  // into the compact reader header while the global chrome is collapsed.
  const targetActions = compact
    ? document.querySelector('.reader-top-actions')
    : document.querySelector('.topbar-actions');
  if (targetActions) {
    targetActions.appendChild($('fullscreenButton'));
    targetActions.appendChild($('settingsButton'));
  }
}
function setScreen(name) {
  state.screen = name;
  $('homeScreen').hidden = name !== 'home';
  $('readerScreen').hidden = name !== 'reader';
  $('chapterEndScreen').hidden = name !== 'chapterEnd';
  $('stage').classList.toggle('is-reading', name === 'reader');
  updateReaderChrome();
  $('languageNotice').hidden = true;
  updateOrientationPrompt();
  if (name === 'reader') scheduleDialogueFit();
}
function dismissDedication() {
  if (dedicationDismissed) return;
  dedicationDismissed = true;
  if (dedicationTimer) clearTimeout(dedicationTimer);
  dedicationTimer = null;
  const screen = $('dedicationScreen');
  if (!screen) return;
  screen.setAttribute('aria-hidden', 'true');
  screen.classList.add('is-leaving');
  const finish = () => { screen.hidden = true; screen.classList.remove('is-leaving'); };
  if (state.settings.reduceMotion || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) finish();
  else setTimeout(finish, 740);
}
function startDedicationSequence() {
  const screen = $('dedicationScreen');
  if (!screen || dedicationDismissed) return;
  screen.hidden = false;
  screen.setAttribute('aria-hidden', 'false');
  // The dedication is a brief opening card, not an interaction gate.
  // It advances automatically after 4.8 seconds; no click is required.
  dedicationTimer = setTimeout(dismissDedication, 4800);
}
function applyVisualPreferences() {
  state.settings.mode = 'enhanced';
  state.settings.persianFont = ['parastoo', 'vazirmatn', 'noto'].includes(state.settings.persianFont)
    ? state.settings.persianFont : 'parastoo';
  document.body.dataset.mode = state.settings.mode;
  document.documentElement.dataset.persianFont = state.settings.persianFont;
  document.documentElement.style.setProperty('--text-size', `${state.settings.textSize}px`);
  document.body.classList.toggle('reduce-motion', !!state.settings.reduceMotion);
  scheduleDialogueFit();
}

function extractArabicFontFaces(cssText, targetFamily) {
  const blocks = cssText.match(/@font-face\s*\{[^}]+\}/gi) || [];
  return blocks.filter(block => {
    const range = block.match(/unicode-range\s*:\s*([^;]+);/i)?.[1] || '';
    return /U\+0600|U\+0750|U\+08A0|U\+FB50|U\+FE70/i.test(range);
  }).map(block => block.replace(/font-family\s*:\s*[^;]+;/i, `font-family: "${targetFamily}";`));
}

async function ensurePersianFontLoaded(name) {
  const source = PERSIAN_FONT_SOURCES[name];
  if (!source) return true;
  if (loadedPersianFonts.has(name)) return true;
  if (pendingPersianFonts.has(name)) return pendingPersianFonts.get(name);
  const task = (async () => {
    const response = await fetch(source.cssUrl, { mode: 'cors' });
    if (!response.ok) throw new Error(`Could not load ${name} font stylesheet (${response.status}).`);
    const cssText = await response.text();
    const arabicFaces = extractArabicFontFaces(cssText, source.family);
    if (!arabicFaces.length) throw new Error(`No Persian/Arabic font subset was found for ${name}.`);
    let style = document.getElementById(`persian-font-${name}`);
    if (!style) {
      style = document.createElement('style');
      style.id = `persian-font-${name}`;
      style.textContent = arabicFaces.join('\n');
      document.head.appendChild(style);
    }
    if (document.fonts?.load) {
      await document.fonts.load(`400 ${state.settings.textSize || 18}px "${source.family}"`, 'سلام دنیا');
      await document.fonts.load(`700 ${state.settings.textSize || 18}px "${source.family}"`, 'سلام دنیا');
    }
    loadedPersianFonts.add(name);
    return true;
  })().finally(() => pendingPersianFonts.delete(name));
  pendingPersianFonts.set(name, task);
  return task;
}

function preloadPersianFonts() {
  // Load both selectable Persian faces in the background. The service worker
  // caches their CORS font responses, so both choices remain available offline.
  Promise.all(Object.keys(PERSIAN_FONT_SOURCES).map(name =>
    ensurePersianFontLoaded(name).catch(error => {
      console.info(`Persian font ${name} will use the bundled Noto fallback until it can be downloaded.`, error);
      return false;
    })
  ));
}
function setMode() {
  state.settings.mode = 'enhanced';
  document.body.dataset.mode = 'enhanced';
  persistSettings();
}
function persistSettings() { localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(state.settings)); }
function loadSettings() {
  state.settings = { ...DEFAULT_SETTINGS, ...safeJSONParse(localStorage.getItem(STORAGE_KEYS.settings), {}) };
  delete state.settings.showReviewedSource;
  delete state.settings.showEditorialDrafts;
  state.settings.textSize = Math.min(24, Math.max(16, Number(state.settings.textSize) || 18));
  applyVisualPreferences();
}
function setLanguage(language, { render = true } = {}) {
  state.language = language === 'fa' ? 'fa' : 'en';
  localStorage.setItem('narcissu-language-v1', state.language);
  document.documentElement.lang = state.language;
  document.documentElement.dir = 'ltr';
  $('readerScreen').classList.toggle('is-fa', state.language === 'fa');
  const target = state.language === 'en' ? 'Persian' : 'English';
  $('languageSwitch').setAttribute('aria-label', `Switch to ${target}`);
  $('languageSwitch').title = `Switch to ${target}`;
  $('languageSwitch').innerHTML = `<span class="${state.language === 'en' ? 'switch-current' : ''}">EN</span><span class="switch-arrow">↔</span><span class="${state.language === 'fa' ? 'switch-current' : ''}">FA</span>`;
  if (render && state.currentEvent) {
    renderCurrentDialogue({ animate: false });
    if (state.auto && state.screen === 'reader' && !state.pendingAdvance) scheduleAutoAdvance();
  }
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
function clearDialogueReveal() {
  if (state.revealTimer) clearTimeout(state.revealTimer);
  state.revealTimer = null;
  state.revealActive = false;
  state.revealDurationMs = 0;
  state.revealEndsAt = 0;
  const textNode = $('dialogueText');
  if (textNode && typeof textNode.querySelectorAll === 'function') {
    textNode.querySelectorAll('.word-reveal').forEach(word => {
      word.classList.remove('word-reveal');
      word.style.removeProperty('--word-delay');
    });
  }
}
function finishDialogueReveal() {
  clearDialogueReveal();
  if (state.currentEvent && state.screen === 'reader') {
    $('dialogueStatus').textContent = state.auto
      ? `Auto · ${state.settings.autoDelay}s`
      : 'Tap to continue';
  }
}
function remainingDialogueRevealMs() {
  return state.revealActive ? Math.max(0, state.revealEndsAt - Date.now()) : 0;
}
function prepareWordReveal(textNode, animate = false) {
  clearDialogueReveal();
  const systemReduceMotion = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (!animate || state.settings.reduceMotion || systemReduceMotion || !textNode ||
      typeof document.createTreeWalker !== 'function' || typeof NodeFilter === 'undefined') return 0;

  const walker = document.createTreeWalker(textNode, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  let wordCount = 0;
  for (const node of textNodes) {
    const parts = node.textContent.match(/\s+|[^\s]+/gu) || [];
    if (!parts.some(part => !/^\s+$/u.test(part))) continue;
    const fragment = document.createDocumentFragment();
    for (const part of parts) {
      if (/^\s+$/u.test(part)) {
        fragment.append(document.createTextNode(part));
      } else {
        const word = document.createElement('span');
        word.className = 'word-reveal';
        word.textContent = part;
        fragment.append(word);
        wordCount += 1;
      }
    }
    node.replaceWith(fragment);
  }

  if (!wordCount) return 0;
  const enhanced = state.settings.mode === 'enhanced';
  const animationMs = enhanced ? 210 : 140;
  const baseInterval = enhanced ? 85 : 55;
  const interval = wordCount > 1
    ? Math.min(baseInterval, 2200 / (wordCount - 1))
    : 0;
  let index = 0;
  textNode.querySelectorAll('.word-reveal').forEach(word => {
    word.style.setProperty('--word-delay', `${Math.round(index * interval)}ms`);
    index += 1;
  });

  state.revealDurationMs = Math.round((wordCount - 1) * interval + animationMs);
  state.revealEndsAt = Date.now() + state.revealDurationMs;
  state.revealActive = true;
  state.revealTimer = setTimeout(finishDialogueReveal, state.revealDurationMs + 30);
  return state.revealDurationMs;
}
function fitDialogueText() {
  const textNode = $('dialogueText');
  const panel = $('dialoguePanel');
  if (!textNode || !panel || state.screen !== 'reader' || panel.getBoundingClientRect().height < 1) return;

  // The setting is the preferred size. Only unusually long passages are reduced,
  // and the saved preference itself is never changed.
  const preferred = Math.max(16, Math.min(24, Number(state.settings.textSize) || 18));
  const minimum = 11.5;
  textNode.style.lineHeight = '';
  textNode.style.fontSize = `${preferred}px`;
  if (textNode.clientHeight < 1) return;

  const fits = () => textNode.scrollHeight <= textNode.clientHeight + 1;
  let fitted = preferred;
  while (fitted > minimum && !fits()) {
    fitted = Math.max(minimum, fitted - 0.5);
    textNode.style.fontSize = `${fitted}px`;
  }

  // Very long passages get a little tighter leading before the type is reduced
  // below a comfortable reading size. This is a visual fallback, not scrolling.
  if (!fits()) {
    textNode.style.lineHeight = state.language === 'fa' ? '1.34' : '1.25';
    while (fitted > 10.5 && !fits()) {
      fitted = Math.max(10.5, fitted - 0.5);
      textNode.style.fontSize = `${fitted}px`;
    }
  }
  textNode.dataset.fittedSize = fitted.toFixed(1);
}
function scheduleDialogueFit() {
  if (dialogueFitFrame) window.cancelAnimationFrame(dialogueFitFrame);
  dialogueFitFrame = window.requestAnimationFrame(() => {
    dialogueFitFrame = 0;
    fitDialogueText();
  });
}

function renderCurrentDialogue({ animate = false } = {}) {
  const ev = state.currentEvent;
  if (!ev || ev.type !== 'say') return 0;
  const sourceEntry = faData?.translations?.[ev.id] || ev.text_fa || null;
  const overlayEntry = revisedOverlay?.translations?.[ev.id] || null;
  const translated = overlayEntry?.text ||
    (typeof sourceEntry === 'string' ? sourceEntry : sourceEntry?.text) || '';
  const isPersian = state.language === 'fa';

  $('dialogueLanguage').textContent = isPersian ? 'فارسی' : 'ENGLISH';
  $('languageNotice').hidden = true;
  $('languageNotice').textContent = '';

  if (isPersian) {
    $('dialogueText').innerHTML = renderMarkedText(translated);
    $('dialogueText').setAttribute('lang', 'fa');
    $('dialogueText').setAttribute('dir', 'rtl');
  } else {
    $('dialogueText').innerHTML = renderMarkedText(ev.text_en);
    $('dialogueText').setAttribute('lang', 'en');
    $('dialogueText').setAttribute('dir', 'ltr');
  }

  $('dialoguePanel').classList.toggle('centered', ev.align === 'center');
  $('readerScreen').classList.toggle('caption-mode', ev.window === 'caption');
  const revealDuration = prepareWordReveal($('dialogueText'), animate);
  scheduleDialogueFit();
  $('dialogueStatus').textContent = state.auto
    ? `Auto · ${state.settings.autoDelay}s`
    : revealDuration > 0 ? 'Tap to reveal' : 'Tap to continue';
  updateProgress();
  return revealDuration;
}
function updateProgress() {
  const ch = chapter();
  if (!ch) return;
  const pct = Math.min(100, (state.eventIndex / Math.max(1, ch.events.length)) * 100);
  $('progressFill').style.width = `${pct}%`;
}
function setBackground(path, effect = 0, duration = 0) {
  const url = assetURL(path, true);
  state.backgroundPath = path;
  const item = assetManifest?.assets?.[normalizePath(path)];
  const mobileRatio = isMobileLandscapeViewport()
    ? item?.mobile_landscape_aspect_ratio : item?.mobile_aspect_ratio;
  $('stage').classList.toggle('is-panorama', isMobileArtworkViewport() && Number(mobileRatio) >= 2.5);
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
function refreshBackgroundForViewport() {
  updateReaderChrome();
  updateOrientationPrompt();
  if (state.screen !== 'reader' || !state.backgroundPath || !assetManifest) return;
  const url = assetURL(state.backgroundPath, true);
  const item = assetManifest.assets?.[normalizePath(state.backgroundPath)];
  const mobileRatio = isMobileLandscapeViewport()
    ? item?.mobile_landscape_aspect_ratio : item?.mobile_aspect_ratio;
  $('stage').classList.toggle('is-panorama', isMobileArtworkViewport() && Number(mobileRatio) >= 2.5);
  const img = $('backgroundImage');
  if (url && img.src !== url) img.src = url;
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
function clearMusicFade() {
  if (state.musicFadeTimer !== null) {
    clearInterval(state.musicFadeTimer);
    state.musicFadeTimer = null;
  }
}
function stopMusic() {
  // A pending fade belongs to the track that was active when it began. Always
  // cancel it before changing or stopping the current track.
  clearMusicFade();
  const audio = state.musicAudio;
  state.musicAudio = null;
  state.currentMusic = null;
  state.currentMusicLoop = false;
  if (audio) {
    audio.pause();
    try { audio.currentTime = 0; } catch {}
  }
}
function playMusic(path, loop) {
  const url = assetURL(path);
  if (!url) { showToast(`Missing music resource: ${path}`); return; }
  // stopMusic also cancels any fade timer for the previous track. This prevents
  // an old fade-out from stopping the newly-started track a few seconds later.
  stopMusic();
  const audio = new Audio(url);
  audio.preload = 'auto';
  audio.loop = !!loop;
  setAudioVolume(audio, state.settings.musicVolume);
  state.musicAudio = audio;
  state.currentMusic = path;
  state.currentMusicLoop = !!loop;
  audio.addEventListener('ended', () => {
    if (state.musicAudio !== audio) return;
    if (!state.currentMusicLoop) {
      state.musicAudio = null;
      state.currentMusic = null;
      state.currentMusicLoop = false;
      return;
    }
    // Browsers normally handle loop=true natively. This is a guarded fallback
    // for engines that still dispatch ended for a looping background track.
    try {
      audio.currentTime = 0;
      const restarted = audio.play();
      if (restarted?.catch) restarted.catch(() => {});
    } catch {}
  });
  audio.addEventListener('error', () => {
    if (state.musicAudio === audio) showToast('Background music could not be loaded.');
  });
  const playback = audio.play();
  if (playback?.catch) playback.catch(() => {
    if (state.musicAudio === audio) showToast('Music will start after your first interaction with the reader.');
  });
}
function getMusicRoomTracks() {
  const seen = new Set();
  const tracks = [];
  for (const ch of (story?.chapters || [])) {
    for (const ev of ch.events || []) {
      if (ev.type !== 'music_play' || !ev.path || seen.has(ev.path)) continue;
      if (!assetURL(ev.path)) continue;
      seen.add(ev.path);
      const fileName = ev.path.replaceAll('\\', '/').split('/').pop();
      tracks.push({ path: ev.path, code: fileName.replace('.mp3', '').toUpperCase() });
    }
  }
  return tracks;
}
function renderMusicRoom() {
  const list = $('musicTrackList');
  if (!list || !story) return;
  const tracks = getMusicRoomTracks();
  list.replaceChildren();
  const selectedTrack = state.musicAudio ? state.currentMusic : null;
  const isPlayingNow = !!(state.musicAudio && !state.musicAudio.paused);
  const currentIndex = tracks.findIndex(t => t.path === selectedTrack);
  $('musicRoomNow').textContent = currentIndex >= 0
    ? `${isPlayingNow ? 'Now playing' : 'Paused'} · Track ${String(currentIndex + 1).padStart(2, '0')}`
    : 'Nothing is playing';
  tracks.forEach((track, index) => {
    const row = document.createElement('div');
    row.className = 'music-track-row';
    const meta = document.createElement('div');
    meta.className = 'music-track-meta';
    const title = document.createElement('strong');
    title.textContent = `Track ${String(index + 1).padStart(2, '0')}`;
    const code = document.createElement('small');
    code.textContent = track.code;
    meta.append(title, code);
    const button = document.createElement('button');
    button.type = 'button';
    const isCurrent = selectedTrack === track.path;
    const isPlaying = isCurrent && isPlayingNow;
    button.className = isCurrent ? 'music-track-play is-playing' : 'music-track-play';
    button.textContent = isPlaying ? 'Pause' : isCurrent ? 'Resume' : 'Play';
    button.setAttribute('aria-label', `${button.textContent} track ${index + 1}`);
    button.addEventListener('click', () => {
      if (isPlaying && state.musicAudio) {
        state.musicAudio.pause();
      } else if (isCurrent && state.musicAudio) {
        const resumed = state.musicAudio.play();
        if (resumed?.catch) resumed.catch(() => showToast('Music will resume after your next interaction.'));
      } else {
        playMusic(track.path, false);
        const audio = state.musicAudio;
        if (audio) audio.addEventListener('ended', () => {
          if (state.musicAudio === audio) {
            state.musicAudio = null; state.currentMusic = null; state.currentMusicLoop = false;
          }
          renderMusicRoom();
        }, { once: true });
      }
      renderMusicRoom();
    });
    row.append(meta, button);
    list.append(row);
  });
}
function openMusicRoom() {
  renderMusicRoom();
  $('musicRoomDialog').showModal();
}
function stopMusicRoom() {
  stopMusic();
  renderMusicRoom();
}
function isStandaloneMode() {
  return !!(window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true);
}
function requestLandscapeOrientation() {
  if (!isStandaloneMode()) return;
  try {
    const lock = screen.orientation?.lock?.('landscape');
    if (lock && typeof lock.catch === 'function') lock.catch(() => {});
  } catch {}
}
function updateOrientationPrompt() {
  const prompt = $('orientationPrompt');
  if (!prompt) return;
  const portrait = window.matchMedia?.('(orientation: portrait)').matches;
  const touch = window.matchMedia?.('(pointer: coarse)').matches;
  const reading = state.screen === 'reader';
  prompt.hidden = !(portrait && touch && (isStandaloneMode() || reading));
}
function updateInstallButton() {
  const button = $('installAppButton');
  if (button) button.hidden = isStandaloneMode();
}
async function installApp() {
  if (deferredInstallPrompt) {
    const promptEvent = deferredInstallPrompt;
    deferredInstallPrompt = null;
    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice?.outcome === 'accepted') showToast('Narcissu is being installed.');
    } catch {
      showToast('Use your browser menu to install Narcissu.');
    }
    updateInstallButton();
    return;
  }
  $('installHelpDialog').showModal();
}
function fadeMusic(duration) {
  const audio = state.musicAudio;
  if (!audio) return;
  clearMusicFade();
  const totalDuration = Math.max(0, Number(duration) || 0);
  if (totalDuration === 0) {
    if (state.musicAudio === audio) stopMusic();
    return;
  }
  const steps = 12, start = audio.volume, interval = Math.max(20, totalDuration / steps);
  let step = 0;
  const timer = setInterval(() => {
    // A newer track may have replaced this one. A stale fade must never touch
    // or stop that newer track, even if its callback was already queued.
    if (state.musicAudio !== audio) {
      clearInterval(timer);
      if (state.musicFadeTimer === timer) state.musicFadeTimer = null;
      return;
    }
    step++;
    setAudioVolume(audio, start * (1 - Math.min(1, step / steps)));
    if (step >= steps) {
      clearInterval(timer);
      if (state.musicFadeTimer === timer) state.musicFadeTimer = null;
      if (state.musicAudio === audio) stopMusic();
    }
  }, interval);
  state.musicFadeTimer = timer;
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
    passageHistory: state.passageHistory.slice(-500),
    savedAt: new Date().toISOString()
  };
  localStorage.setItem(STORAGE_KEYS.progress, JSON.stringify(payload));
  $('continueButton').disabled = false;
}
function getProgress() { return safeJSONParse(localStorage.getItem(STORAGE_KEYS.progress), null); }
function restoreProgress(payload) {
  if (!payload || !story) return false;
  clearWaitingTimer(); clearDialogueReveal();
  stopAllAudio();
  state.auto = false;
  $('autoButton').setAttribute('aria-pressed', 'false');
  state.pendingAdvance = false;
  state.awaitingClick = false;
  requestLandscapeOrientation();
  state.chapterIndex = Math.max(0, Math.min(story.chapters.length - 1, payload.chapterIndex || 0));
  const ch = chapter(); state.eventIndex = Math.max(0, Math.min(ch.events.length, payload.eventIndex || 0));
  state.currentEvent = payload.currentEventId ? ch.events.find(e => e.id === payload.currentEventId) || null : null;
  state.backgroundPath = payload.backgroundPath || null; state.windowMode = payload.windowMode || 'main';
  state.chapterComplete = !!payload.chapterComplete || payload.screen === 'chapterEnd';
  state.passageHistory = Array.isArray(payload.passageHistory) ? payload.passageHistory.slice(-500) : [];
  if (payload.settings) state.settings = { ...DEFAULT_SETTINGS, ...state.settings, ...payload.settings };
  delete state.settings.showReviewedSource;
  delete state.settings.showEditorialDrafts;
  state.settings.textSize = Math.min(24, Math.max(16, Number(state.settings.textSize) || 18));
  applyVisualPreferences();
  setAudioVolume(state.musicAudio, state.settings.musicVolume);
  setLanguage(payload.language || state.language, { render: false });
  if (state.backgroundPath) setBackground(state.backgroundPath, 0, 0);
  renderChapterHeading();
  updatePreviousButton();
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
function startChapter(index, eventIndex = 0, options = {}) {
  requestLandscapeOrientation();
  clearWaitingTimer(); clearDialogueReveal(); stopAllAudio();
  if (!options.preserveHistory) state.passageHistory = [];
  state.auto = false; $('autoButton').setAttribute('aria-pressed', 'false');
  state.chapterIndex = Math.max(0, Math.min(story.chapters.length - 1, index));
  state.eventIndex = eventIndex; state.currentEvent = null; state.windowMode = 'main';
  state.awaitingClick = false; state.chapterComplete = false; state.centerNext = false;
  $('backgroundImage').src = '';
  state.backgroundPath = null;
  setScreen('reader'); renderChapterHeading();
  $('dialogueText').textContent = ''; $('languageNotice').hidden = true;
  processNext(); saveProgress(); updatePreviousButton();
}
function startNewGame() { state.history = []; state.passageHistory = []; localStorage.setItem(STORAGE_KEYS.history, '[]'); startChapter(0, 0); }
function updatePreviousButton() {
  const button = $('previousButton');
  if (!button) return;
  const last = state.passageHistory[state.passageHistory.length - 1];
  const currentIsLastHistoryEntry = !!(
    last && state.currentEvent &&
    last.chapterIndex === state.chapterIndex &&
    last.eventId === state.currentEvent.id
  );
  // During chapter-intro commands there may be no current dialogue yet; the
  // previous chapter's last passage is still a valid rewind destination.
  const available = currentIsLastHistoryEntry
    ? state.passageHistory.length > 1
    : state.passageHistory.length > 0;
  button.disabled = !available;
}
function rememberPassage(ev) {
  const snapshot = {
    chapterIndex: state.chapterIndex,
    eventIndex: state.eventIndex,
    eventId: ev.id,
    backgroundPath: state.backgroundPath,
    windowMode: state.windowMode,
    currentMusic: state.currentMusic,
    currentMusicLoop: !!state.currentMusicLoop
  };
  const last = state.passageHistory[state.passageHistory.length - 1];
  if (!last || last.chapterIndex !== snapshot.chapterIndex || last.eventId !== snapshot.eventId) {
    state.passageHistory.push(snapshot);
    if (state.passageHistory.length > 500) state.passageHistory.shift();
  }
  updatePreviousButton();
}
function goPrevious() {
  if (!['reader', 'chapterEnd'].includes(state.screen)) return;
  clearWaitingTimer();
  state.auto = false;
  $('autoButton').setAttribute('aria-pressed', 'false');

  const current = state.passageHistory[state.passageHistory.length - 1];
  let target;
  if (state.screen === 'chapterEnd') {
    // Chapter-end is a separate screen after the final dialogue; return to that
    // final passage first rather than skipping back by two passages.
    target = current || null;
  } else {
    if (current && state.currentEvent && current.chapterIndex === state.chapterIndex && current.eventId === state.currentEvent.id) {
      state.passageHistory.pop();
    }
    target = state.passageHistory[state.passageHistory.length - 1];
  }
  if (!target) {
    if (current) state.passageHistory.push(current);
    updatePreviousButton();
    showToast('You are already at the beginning of this reading session.');
    return;
  }

  const chapterChanged = target.chapterIndex !== state.chapterIndex;
  if (chapterChanged) {
    stopAllAudio();
  } else {
    // Rewind within the same chapter must not restart or seek the background music.
    for (const channel of [...state.audioChannels.keys()]) stopChannel(channel);
  }
  state.chapterIndex = Math.max(0, Math.min(story.chapters.length - 1, target.chapterIndex));
  const ch = chapter();
  state.eventIndex = Math.max(0, Math.min(ch.events.length, target.eventIndex));
  state.currentEvent = ch.events.find(event => event.id === target.eventId) || null;
  state.backgroundPath = target.backgroundPath || null;
  state.windowMode = target.windowMode || 'main';
  state.chapterComplete = false;
  state.awaitingClick = true;
  state.pendingAdvance = false;
  setScreen('reader');
  renderChapterHeading();
  if (state.backgroundPath) setBackground(state.backgroundPath, 0, 0);
  setLanguage(state.language, { render: false });
  if (chapterChanged && target.currentMusic) playMusic(target.currentMusic, !!target.currentMusicLoop);
  if (state.currentEvent) renderCurrentDialogue({ animate: true });
  updatePreviousButton();
  saveProgress();
}
function scheduleAutoAdvance(extraDelayMs = 0) {
  clearWaitingTimer();
  state.waitingTimer = setTimeout(() => {
    state.waitingTimer = null;
    processNext();
  }, Math.max(0, extraDelayMs) + state.settings.autoDelay * 1000);
}
function processNext() {
  if (state.screen !== 'reader') return;
  clearWaitingTimer(); state.awaitingClick = false; state.pendingAdvance = false;
  const ch = chapter();
  while (state.eventIndex < ch.events.length) {
    const ev = ch.events[state.eventIndex++];
    switch (ev.type) {
      case 'background':
        setBackground(ev.path, ev.effect, ev.duration_ms);
        if (Number(ev.hold_ms) > 0) {
          state.awaitingClick = true; state.pendingAdvance = true;
          $('dialogueStatus').textContent = '…';
          state.waitingTimer = setTimeout(() => { state.waitingTimer = null; processNext(); }, Number(ev.hold_ms));
          updateProgress(); saveProgress(); return;
        }
        break;
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
        state.currentEvent = ev; state.awaitingClick = true; rememberPassage(ev); addHistory(ev);
        const revealDuration = renderCurrentDialogue({ animate: true }); saveProgress();
        if (state.auto) {
          $('dialogueStatus').textContent = `Auto · ${state.settings.autoDelay}s`;
          scheduleAutoAdvance(revealDuration);
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
  if (state.revealActive) {
    clearWaitingTimer();
    finishDialogueReveal();
    if (state.auto && !state.pendingAdvance) scheduleAutoAdvance();
    return;
  }
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
  startChapter(state.chapterIndex + 1, 0, { preserveHistory: true });
}
function returnHome() { clearWaitingTimer(); clearDialogueReveal(); saveProgress(); state.auto = false; $('autoButton').setAttribute('aria-pressed','false'); setScreen('home'); stopAllAudio(); }
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
    passageHistory:state.passageHistory.slice(-500),savedAt:new Date().toISOString() };
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
  if (!('serviceWorker' in navigator)) return null;
  try {
    const registration = await navigator.serviceWorker.register('./service-worker.js', { updateViaCache: 'none' });
    // Ask GitHub Pages for the newest worker script instead of relying on a stale HTTP cache.
    if (typeof registration.update === 'function') registration.update().catch(() => {});
    // Wait briefly for the worker to take control so the first font downloads
    // can be cached; do not block font loading if activation is delayed.
    await Promise.race([navigator.serviceWorker.ready, new Promise(resolve => setTimeout(resolve, 2500))]);
    return registration;
  } catch (e) {
    console.warn('Service worker registration failed', e);
    return null;
  }
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
    const items=Object.values(assetManifest.assets).flatMap(x=>{
      const paths=[x.url];
      if(x.mobile_url) paths.push(x.mobile_url);
      if(x.mobile_landscape_url && x.mobile_landscape_url!==x.mobile_url) paths.push(x.mobile_landscape_url);
      return paths.map(path=>new URL(`./public/${path}`,document.baseURI).toString());
    });
    total=items.length;
    const cache=await caches.open('narcissu-assets-v4');
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
  await caches.delete('narcissu-assets-v4');$('downloadMeterFill').style.width='0%';$('downloadPercent').textContent='0%';$('downloadStatus').textContent='Offline assets cleared.';showToast('Offline assets cleared.');
}
function setupSettings() {
$('persianFontSetting').value=state.settings.persianFont;$('textSizeSetting').value=state.settings.textSize;$('autoDelaySetting').value=state.settings.autoDelay;
  $('musicVolumeSetting').value=state.settings.musicVolume;$('sfxVolumeSetting').value=state.settings.sfxVolume;$('reduceMotionSetting').checked=state.settings.reduceMotion;
  $('settingsDialog').showModal();
}
function applySettings() {
  state.settings.mode='enhanced';state.settings.persianFont=$('persianFontSetting').value;state.settings.textSize=Number($('textSizeSetting').value);state.settings.autoDelay=Number($('autoDelaySetting').value);
  state.settings.musicVolume=Number($('musicVolumeSetting').value);state.settings.sfxVolume=Number($('sfxVolumeSetting').value);state.settings.reduceMotion=$('reduceMotionSetting').checked;
  applyVisualPreferences();
  if(state.settings.reduceMotion && state.revealActive){
    finishDialogueReveal();
    if(state.auto&&!state.pendingAdvance)scheduleAutoAdvance();
  }
  if(state.musicAudio)setAudioVolume(state.musicAudio,state.settings.musicVolume);for(const [channel,audio] of state.audioChannels)setAudioVolume(audio,state.settings.sfxVolume);
  persistSettings();
  if (state.settings.persianFont !== 'noto') {
    ensurePersianFontLoaded(state.settings.persianFont).then(scheduleDialogueFit).catch(error => {
      console.warn('Selected Persian font is not available yet; the bundled Noto fallback remains active.', error);
      showToast('Persian font unavailable offline; using the original font for now.');
    });
  }
  $('settingsDialog').close();showToast('Settings applied.');
}
function toggleAuto() {
  state.auto=!state.auto;$('autoButton').setAttribute('aria-pressed',String(state.auto));
  // Do not replace a timeline wait (including the opening statistics cards) with the auto timer.
  if(state.auto&&state.currentEvent&&!state.pendingAdvance){$('dialogueStatus').textContent=`Auto · ${state.settings.autoDelay}s`;scheduleAutoAdvance(remainingDialogueRevealMs());}
  else if(!state.auto&&!state.pendingAdvance){clearWaitingTimer();$('dialogueStatus').textContent=state.revealActive?'Tap to reveal':'Tap to continue';}
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
  $('musicRoomButton').addEventListener('click',openMusicRoom);
  $('closeMusicRoom').addEventListener('click',()=>$('musicRoomDialog').close());
  $('stopMusicRoomButton').addEventListener('click',stopMusicRoom);
  $('installAppButton').addEventListener('click',installApp);
  $('closeInstallHelp').addEventListener('click',()=>$('installHelpDialog').close());
  $('closeInstallHelpButton').addEventListener('click',()=>$('installHelpDialog').close());
  $('settingsButton').addEventListener('click',setupSettings);
  $('saveSettingsButton').addEventListener('click',applySettings);
  $('fullscreenButton').addEventListener('click',toggleFullscreen);
  $('languageSwitch').addEventListener('click',()=>setLanguage(state.language==='en'?'fa':'en'));
  $('nextButton').addEventListener('click',advance);$('previousButton').addEventListener('click',goPrevious);$('dialoguePanel').addEventListener('click',advance);
  $('dialoguePanel').addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();advance();}});
  $('autoButton').addEventListener('click',toggleAuto);
  $('historyButton').addEventListener('click',openHistory);
  $('saveButton').addEventListener('click',()=>openSlots('save'));
  $('readerLoadButton').addEventListener('click',()=>openSlots('load'));
  $('readerMenuButton').addEventListener('click',returnHome);
  $('nextChapterButton').addEventListener('click',continueChapter);
  $('chapterEndPreviousButton').addEventListener('click',goPrevious);
  $('endMenuButton').addEventListener('click',()=>{setScreen('home');});
  $('offlineDownloadButton').addEventListener('click',openOfflineDialog);
  $('startDownloadButton').addEventListener('click',downloadOfflineAssets);
  $('clearDownloadButton').addEventListener('click',clearOfflineAssets);
  window.addEventListener('beforeinstallprompt',event=>{
    event.preventDefault();
    deferredInstallPrompt=event;
    updateInstallButton();
  });
  window.addEventListener('appinstalled',()=>{
    deferredInstallPrompt=null;
    updateInstallButton();
    showToast('Narcissu has been installed.');
  });
  window.addEventListener('resize',()=>{refreshBackgroundForViewport();scheduleDialogueFit();},{passive:true});
  window.addEventListener('orientationchange',()=>{refreshBackgroundForViewport();scheduleDialogueFit();},{passive:true});
  if (document.fonts?.ready) document.fonts.ready.then(scheduleDialogueFit);
  updateInstallButton(); refreshBackgroundForViewport();
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
    registerServiceWorker().then(preloadPersianFonts);
    if(location.hash==='#play') {const p=getProgress();if(p)restoreProgress(p);}
    startDedicationSequence();
  } catch(e) {
    console.error(e);document.body.innerHTML=`<main style="max-width:720px;margin:12vh auto;padding:24px;font:16px sans-serif;color:#eee;background:#111"> <h1>Narcissu could not start</h1><p>${escapeHTML(e.message)}</p><p>Serve this folder through a local web server or HTTPS. Opening index.html directly as a file will not load the game data.</p></main>`;
  }
}

// Bind the dedication skip control as soon as the deferred script executes,
// so it remains responsive even while the story data is loading.

boot();
