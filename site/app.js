'use strict';

const $ = (id) => document.getElementById(id);
const STORAGE_KEYS = { progress: 'narcissu-progress-v1', settings: 'narcissu-settings-v1', history: 'narcissu-history-v1' };
const HOME_INSTALL_REMINDER_KEY = 'narcissu-home-install-reminder-seen-v1';
const DEFAULT_SETTINGS = { mode: 'enhanced', persianFont: 'parastoo', textSize: 18, textSizeVersion: 4, autoDelay: 5, musicVolume: 0.55, sfxVolume: 0.8, ambientVolume: 0.6, reduceMotion: false, highContrast: false, fontStyle: 'serif', messageBoxOpacity: 80 };
const DEFAULT_LANGUAGE = 'fa';
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
let settingsReturnScreen = 'home';
let dedicationTimer = null;
let dedicationDismissed = false;
let dialogueFitFrame = 0;
let backgroundTransitionTimer = null;
let backgroundTransitionSequence = 0;
let appServiceWorkerRegistration = null;
let appUpdateCheckPromise = null;
let lastAppUpdateCheckAt = 0;
let appUpdateInterval = null;
let serviceWorkerHadController = false;
let serviceWorkerUpdateReloading = false;
const APP_UPDATE_CHECK_INTERVAL_MS = 20 * 60 * 1000;
const ASSET_CACHE_NAME = 'narcissu-assets-v6';


let ambientAudioContext = null;
let ambientMasterGain = null;
let ambientEnabled = false;
let ambientStartPending = false;
// True only while a track selected from Music Room owns the menu audio space.
let musicRoomTrackActive = false;

// Reuse the same media elements for the complete story. Several mobile browsers
// grant playback permission to media elements that were first played during a
// real user gesture; creating a brand-new Audio() for every scene can make a
// later Auto-mode soundtrack silently fail.
let musicAudioElement = null;
const channelAudioElements = new Map();
const primedAudioElements = new WeakSet();
const audioPrimePromises = new WeakMap();
let silentAudioDataUrl = null;
let pendingMusicPlayback = null;
let endingMessagePending = false;
const pendingChannelPlayback = new Map();
const STORY_AUDIO_CHANNELS = [0, 4, 5, 6];
const AMBIENT_PREFERENCE_KEY = 'narcissu-ambient-enabled-v1';
function ambientAutoplayAllowed() {
  try { return localStorage.getItem(AMBIENT_PREFERENCE_KEY) !== '0'; } catch { return true; }
}
function syncMusicRoomAmbient(isMusicPlaying) {
  musicRoomTrackActive = !!isMusicPlaying;
  if (state.screen !== 'home') return;
  if (musicRoomTrackActive) {
    // A selected Music Room track temporarily replaces, but does not disable,
    // the user's saved sea-ambience preference.
    silenceAmbientForNonMenu();
    return;
  }
  if (ambientAutoplayAllowed() && Number(state.settings.ambientVolume ?? 0.6) > 0 && !document.hidden) {
    startAmbientSound();
  } else {
    silenceAmbientForNonMenu();
  }
}
function startAmbientSound() {
  // Menu ambience must never be started from Settings, even if a delayed
  // autoplay promise from the previous screen resolves after navigation.
  if (state.screen !== 'home' || document.hidden) return;
  if (musicRoomTrackActive && state.musicAudio && !state.musicAudio.paused) {
    ambientStartPending = false;
    silenceAmbientForNonMenu();
    return;
  }
  // A track can be paused by the operating system while Settings is open;
  // in that case its pause event must not start ambience behind Settings, but
  // returning to the main menu should restore ambience normally.
  if (musicRoomTrackActive) musicRoomTrackActive = false;
  const button = $('ambientToggle');
  const audio = $('homeAmbientAudio');
  if (audio) {
    audio.volume = Math.max(0, Math.min(1, Number(state.settings.ambientVolume ?? 0.6)));
    audio.loop = true;
    ambientStartPending = true;
    let audioPlayResult;
    try { audioPlayResult = audio.play(); }
    catch (error) {
      ambientStartPending = false;
      console.warn('Recorded ambience could not start; using the synthesized fallback.', error);
      startSyntheticAmbientSound();
      return;
    }
    Promise.resolve(audioPlayResult).then(() => {
      ambientStartPending = false;
      if (state.screen !== 'home' || document.hidden || musicRoomTrackActive) {
        audio.pause();
        ambientEnabled = false;
        if (button) { button.setAttribute('aria-pressed', 'false'); button.setAttribute('aria-label', 'Enable sea ambience'); }
        return;
      }
      ambientEnabled = true;
      try { localStorage.setItem(AMBIENT_PREFERENCE_KEY, '1'); } catch {}
      if (button) { button.textContent = '♫'; button.title = 'Sea ambience on'; button.setAttribute('aria-label', 'Turn sea ambience off'); button.setAttribute('aria-pressed', 'true'); }
    }).catch(error => {
      ambientStartPending = false;
      if (state.screen !== 'home' || document.hidden || musicRoomTrackActive) return;
      console.warn('Recorded ambience could not be played; using the synthesized fallback.', error);
      startSyntheticAmbientSound();
    });
    return;
  }
  startSyntheticAmbientSound();
}

function startSyntheticAmbientSound() {
  const button = $('ambientToggle');
  if (state.screen !== 'home' || document.hidden || musicRoomTrackActive) {
    ambientStartPending = false;
    if (ambientMasterGain && ambientAudioContext) {
      ambientMasterGain.gain.cancelScheduledValues(ambientAudioContext.currentTime);
      ambientMasterGain.gain.setTargetAtTime(0, ambientAudioContext.currentTime, 0.2);
    }
    ambientEnabled = false;
    return;
  }
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    if (button) button.textContent = 'Ambient audio unavailable';
    return;
  }

  try {
    // Build the graph once. Every manual press calls resume() again, even if a
    // previous autoplay attempt was left suspended by iOS Safari.
    if (!ambientAudioContext) {
      ambientAudioContext = new AudioContextClass();
      const context = ambientAudioContext;
      const master = context.createGain();
      master.gain.value = 0;
      master.connect(context.destination);
      ambientMasterGain = master;

      const bufferSize = context.sampleRate * 6;
      const noiseBuffer = context.createBuffer(1, bufferSize, context.sampleRate);
      const samples = noiseBuffer.getChannelData(0);
      let brown = 0;
      for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        brown = (brown + 0.035 * white) / 1.035;
        samples[i] = brown * 4.2;
      }

      const surf = context.createBufferSource();
      surf.buffer = noiseBuffer;
      surf.loop = true;
      const surfFilter = context.createBiquadFilter();
      surfFilter.type = 'lowpass';
      surfFilter.frequency.value = 620;
      surfFilter.Q.value = 0.55;
      const surfGain = context.createGain();
      surfGain.gain.value = 0.42;

      const windFilter = context.createBiquadFilter();
      windFilter.type = 'bandpass';
      windFilter.frequency.value = 1050;
      windFilter.Q.value = 0.38;
      const windGain = context.createGain();
      windGain.gain.value = 0.075;

      const swell = context.createOscillator();
      const swellDepth = context.createGain();
      swell.type = 'sine';
      swell.frequency.value = 0.065;
      swellDepth.gain.value = 0.13;
      swell.connect(swellDepth);
      swellDepth.connect(surfGain.gain);

      surf.connect(surfFilter);
      surfFilter.connect(surfGain);
      surfGain.connect(master);
      surfFilter.connect(windFilter);
      windFilter.connect(windGain);
      windGain.connect(master);

      surf.start();
      swell.start();
    }

    // Invoke resume immediately in the user-gesture call stack. Do not let a
    // stale "pending" flag prevent a later button press from retrying.
    ambientStartPending = true;
    const resumeResult = ambientAudioContext.resume();
    Promise.resolve(resumeResult).then(() => {
      if (!ambientAudioContext || !ambientMasterGain) return;
      if (state.screen !== 'home' || document.hidden || musicRoomTrackActive) {
        ambientStartPending = false;
        ambientMasterGain.gain.cancelScheduledValues(ambientAudioContext.currentTime);
        ambientMasterGain.gain.setTargetAtTime(0, ambientAudioContext.currentTime, 0.2);
        ambientEnabled = false;
        if (button) { button.setAttribute('aria-pressed', 'false'); button.setAttribute('aria-label', 'Enable sea ambience'); }
        return;
      }
      if (ambientAudioContext.state !== 'running') {
        ambientStartPending = false;
        if (button) button.textContent = '♫ Tap to enable sea ambience';
        return;
      }
      ambientMasterGain.gain.cancelScheduledValues(ambientAudioContext.currentTime);
      ambientMasterGain.gain.setTargetAtTime(
        Math.max(0, Math.min(1, Number(state.settings.ambientVolume ?? 0.6))),
        ambientAudioContext.currentTime,
        0.9
      );
      ambientEnabled = true;
      ambientStartPending = false;
      try { localStorage.setItem(AMBIENT_PREFERENCE_KEY, '1'); } catch {}
      if (button) {
        button.textContent = '♫';
        button.title = 'Sea ambience on';
        button.setAttribute('aria-label', 'Turn sea ambience off');
        button.setAttribute('aria-pressed', 'true');
      }
    }).catch(error => {
      ambientStartPending = false;
      console.warn('Ambient audio resume failed.', error);
      if (button) button.textContent = '♫ Tap to retry ambience';
    });
  } catch (error) {
    ambientStartPending = false;
    console.warn('Ambient audio could not be initialized.', error);
    if (button) button.textContent = 'Ambient audio unavailable';
  }
}
function silenceAmbientForNonMenu() {
  // Scene music owns the audio space while reading. Pause menu ambience
  // without changing the user's saved preference.
  const audio = $('homeAmbientAudio');
  if (audio) audio.pause();
  ambientStartPending = false;
  if (ambientAudioContext && ambientMasterGain) {
    ambientMasterGain.gain.cancelScheduledValues(ambientAudioContext.currentTime);
    ambientMasterGain.gain.setTargetAtTime(0, ambientAudioContext.currentTime, 0.25);
  }
  ambientEnabled = false;
  const button = $('ambientToggle');
  if (button) {
    button.textContent = '♫';
    button.title = 'Sea ambience paused';
    button.setAttribute('aria-label', 'Enable sea ambience');
    button.setAttribute('aria-pressed', 'false');
  }
}
function stopAmbientSound() {
  try { localStorage.setItem(AMBIENT_PREFERENCE_KEY, '0'); } catch {}
  const audio = $('homeAmbientAudio');
  if (audio) { audio.pause(); try { audio.currentTime = 0; } catch {} }
  ambientStartPending = false;
  if (ambientAudioContext && ambientMasterGain) {
    ambientMasterGain.gain.cancelScheduledValues(ambientAudioContext.currentTime);
    ambientMasterGain.gain.setTargetAtTime(0, ambientAudioContext.currentTime, 0.35);
  }
  ambientEnabled = false;
  const button = $('ambientToggle');
  if (button) {
    button.textContent = '♫';
    button.title = 'Sea ambience paused';
    button.setAttribute('aria-label', 'Enable sea ambience');
    button.setAttribute('aria-pressed', 'false');
  }
}

const WELCOME_CACHE_NAME = 'narcissu-welcome-assets-v1';
const WELCOME_ASSETS = [
  './public/assets/images/narcissu-coastal-background.jpg',
  './public/assets/e/umibe_yoru.jpg',
  './public/assets/se/nami02b.ogg',
  './public/assets/se/umi13.ogg',
  './public/assets/audio/narcissu-coastal-ambience.mp3',
  './public/assets/bgm/a01.mp3',
  './icons/fox-emblem-white.png'
];
async function prepareWelcomeAssets() {
  const screen = $('welcomeScreen');
  if (!screen) { startDedicationSequence(); return; }
  let alreadyPrepared = false;
  try { alreadyPrepared = localStorage.getItem('narcissu-welcome-prepared-v1') === '1'; } catch {}
  if (alreadyPrepared) { startDedicationSequence(); return; }

  screen.hidden = false;
  screen.setAttribute('aria-hidden', 'false');
  const continueButton = $('welcomeContinueButton');
  const skipButton = $('welcomeSkipButton');
  const fill = $('welcomeProgressFill');
  const status = $('welcomeStatus');
  const percent = $('welcomePercent');
  const progress = $('welcomeProgress');
  let entered = false;
  const enter = () => {
    if (entered) return;
    entered = true;
    try { localStorage.setItem('narcissu-welcome-prepared-v1', '1'); } catch {}
    screen.hidden = true;
    screen.setAttribute('aria-hidden', 'true');
    if (ambientAutoplayAllowed() && (state.settings.ambientVolume ?? 0.6) > 0) startAmbientSound();
    startDedicationSequence();
  };
  skipButton.addEventListener('click', enter, { once: true });
  let cache = null;
  try { if ('caches' in window) cache = await caches.open(WELCOME_CACHE_NAME); } catch {}
  let complete = 0, failed = 0;
  const update = () => {
    const value = Math.round((complete / WELCOME_ASSETS.length) * 100);
    fill.style.width = value + '%';
    percent.textContent = value + '%';
    progress.setAttribute('aria-valuenow', String(value));
    status.textContent = failed ? `Prepared ${complete} of ${WELCOME_ASSETS.length} files · ${failed} unavailable` : `Preparing opening assets · ${complete} of ${WELCOME_ASSETS.length}`;
  };
  for (const path of WELCOME_ASSETS) {
    try {
      const request = new Request(new URL(path, document.baseURI), { cache: 'reload' });
      const cached = cache ? await cache.match(request) : null;
      if (!cached) {
        const response = await fetch(request);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (cache) await cache.put(request, response.clone());
      }
    } catch (error) {
      failed++;
      console.info('Welcome asset could not be cached; it can load later.', path, error);
    }
    complete++;
    update();
  }
  status.textContent = failed
    ? `Preparation finished with ${failed} optional file(s) unavailable`
    : 'Opening assets are ready on this device';
  continueButton.disabled = false;
  continueButton.textContent = failed ? 'Enter Narcissu' : 'Begin the journey';
  continueButton.addEventListener('click', enter, { once: true });
}

const SERVICE_WORKER_RESUME_KEY = 'narcissu-resume-after-sw-update';

let story = null;
let assetManifest = null;
let faData = { translations: {} };
let revisedOverlay = { translations: {} };
let historicalEventAlignment = {};
let deferredInstallPrompt = null;
let homeInstallReminderShown = false;
let state = {
  screen: 'home', chapterIndex: 0, eventIndex: 0, currentEvent: null,
  backgroundPath: null, currentMusic: null, language: DEFAULT_LANGUAGE,
  windowMode: 'main', auto: false, awaitingClick: false, waitingTimer: null,
  settings: { ...DEFAULT_SETTINGS }, audioChannels: new Map(), musicAudio: null, currentMusicLoop: false,
  musicFadeTimer: null,
  centerNext: false, chapterComplete: false, pendingAdvance: false,
  history: [], passageHistory: [], downloadBusy: false, orientationPaused: false,
  revealActive: false, revealTimer: null, revealDurationMs: 0, revealEndsAt: 0,
  dialogueSourceText: '', dialoguePages: [], dialoguePageIndex: 0, previewTextSize: null
};

function safeJSONParse(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function normalizeSettings(raw, fallback = DEFAULT_SETTINGS) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const merged = { ...fallback, ...source };
  const version = Number(source.textSizeVersion) || 1;
  const oldSize = Number(source.textSize);
  if (version < 2) {
    // Migrate Increment 49's 16–24 range into the legacy 11–18 range first.
    merged.textSize = Number.isFinite(oldSize) && oldSize > 0
      ? Math.round(13 + (oldSize - 16) * 0.625) : 13;
  } else if (version < 3) {
    merged.textSize = Number.isFinite(oldSize) && oldSize > 0 ? oldSize - 1 : 13;
  }
  if (version < 4) {
    // Raise legacy dialogue sizes proportionally; the old 13px default becomes 18px.
    const legacySize = Number.isFinite(Number(merged.textSize)) ? Number(merged.textSize) : 13;
    merged.textSize = Math.round(15 + (legacySize - 11) * (9 / 7));
  }
  merged.textSize = Math.min(24, Math.max(15, Number(merged.textSize) || 18));
  merged.textSizeVersion = 4;
  return merged;
}
function normalizePath(path) { return String(path || '').replace(/\\/g, '/').replace(/^\/+/, '').toLocaleLowerCase('en-US'); }
function isMobileArtworkViewport() {
  return !!window.matchMedia?.('(max-width: 900px)').matches;
}
function isCompactReaderViewport() {
  return !!window.matchMedia?.('(max-width: 1100px)').matches || !!window.matchMedia?.('(any-pointer: coarse)').matches;
}
function isMobileLandscapeViewport() {
  return !!window.matchMedia?.('(max-width: 900px) and (orientation: landscape)').matches;
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
  const reading = state.screen === 'reader' || (state.screen === 'settings' && settingsReturnScreen === 'reader');
  const compact = reading && isCompactReaderViewport();
  const shell = document.querySelector('.app-shell');
  shell?.classList.toggle('is-reading', reading);
  shell?.classList.toggle('is-compact-reading', compact);
  // Desktop keeps its familiar top bar. Phones and tablets move the essential
  // actions into the compact reader header to prevent collision with the chapter title.
  const targetActions = compact
    ? document.querySelector('.reader-top-actions')
    : document.querySelector('.topbar-actions');
  if (targetActions) {
    targetActions.appendChild($('settingsButton'));
  }
}
function setScreen(name) {
  const settingsOverReader = name === 'settings' && state.settingsReturnScreen === 'reader';
  const menuBackdrop = name === 'home' || (name === 'settings' && !settingsOverReader);
  const readerBackdrop = name === 'reader' || settingsOverReader;
  // Update the screen state before starting/stopping ambience so the menu-only
  // audio guard sees the destination screen, including when returning from play.
  state.screen = name;
  if (name !== 'reader' && !(name === 'settings' && settingsOverReader)) stopEndingMessage();
  if (name === 'home') {
    if (ambientAutoplayAllowed() && (state.settings.ambientVolume ?? 0.6) > 0) {
      startAmbientSound();
    } else {
      silenceAmbientForNonMenu();
    }
  } else {
    // Coastal ambience belongs to the main menu only. Settings, reading and
    // chapter-end screens must remain quiet unless story audio is playing.
    silenceAmbientForNonMenu();
  }
  $('stage')?.classList.toggle('has-home-backdrop', menuBackdrop);
  $('stage')?.classList.toggle('is-settings-open', name === 'settings');
  document.querySelector('.app-shell')?.classList.toggle('is-home-backdrop', menuBackdrop);
  document.querySelector('.app-shell')?.classList.toggle('is-settings-open', name === 'settings');
  try { localStorage.setItem('narcissu-active-screen', name); } catch {}
  $('homeScreen').hidden = !menuBackdrop;
  $('readerScreen').hidden = !readerBackdrop;
  $('chapterEndScreen').hidden = name !== 'chapterEnd';
  if ($('settingsScreen')) $('settingsScreen').hidden = name !== 'settings';
  $('stage').classList.toggle('is-reading', readerBackdrop);
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
  const finish = () => {
    screen.hidden = true;
    screen.classList.remove('is-leaving');
    // The home-menu orientation gate appears after the dedication card has
    // cleared, so the first-visit introduction is not covered by the prompt.
    updateOrientationPrompt();
  };
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
function getEffectiveDialogueFontSize() {
  const candidate = state.previewTextSize ?? state.settings.textSize;
  return Math.min(24, Math.max(15, Number(candidate) || 18));
}
function applyDialogueTypography(size = getEffectiveDialogueFontSize()) {
  const px = `${Math.min(24, Math.max(15, Number(size) || 18))}px`;
  document.documentElement.style.setProperty('--text-size', px);
  const textNode = $('dialogueText');
  if (textNode) {
    textNode.style.setProperty('font-size', px, 'important');
  }
}
function applyVisualPreferences() {
  state.settings.mode = 'enhanced';
  document.body.classList.toggle('high-contrast', !!state.settings.highContrast);
  document.body.classList.toggle('interface-sans', state.settings.fontStyle === 'sans');
  document.documentElement.style.setProperty('--dialogue-opacity', String(Math.min(100, Math.max(40, Number(state.settings.messageBoxOpacity) || 80)) / 100));
  state.settings.persianFont = ['parastoo', 'vazirmatn', 'noto'].includes(state.settings.persianFont)
    ? state.settings.persianFont : 'parastoo';
  document.body.dataset.mode = state.settings.mode;
  document.documentElement.dataset.persianFont = state.settings.persianFont;
  applyDialogueTypography();
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
function getResponsiveDefaultTextSize() {
  // Choose a comfortable first-run dialogue size from the available CSS
  // viewport width. Existing user preferences are never changed.
  if (window.matchMedia('(max-width: 380px)').matches) return 16;
  if (window.matchMedia('(max-width: 430px)').matches) return 17;
  return 18;
}
function loadSettings() {
  const savedValue = localStorage.getItem(STORAGE_KEYS.settings);
  const saved = safeJSONParse(savedValue, {});
  const firstRunDefaults = { ...DEFAULT_SETTINGS, textSize: getResponsiveDefaultTextSize() };
  state.settings = savedValue === null
    ? firstRunDefaults
    : normalizeSettings(saved, DEFAULT_SETTINGS);
  delete state.settings.showReviewedSource;
  delete state.settings.showEditorialDrafts;
  persistSettings();
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
    $('dialogueStatus').textContent = dialogueStatusLabel('continue');
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
function tokenizeMarkedDialogue(value) {
  const tokens = [];
  const source = String(value || '');
  const marked = /~i~([\s\S]*?)~i~|~s~([\s\S]*?)~s~/g;
  let cursor = 0;
  const addSegment = (text, style = '') => {
    const parts = text.match(/\S+(?:\s+|$)|\s+/gu) || [];
    for (const part of parts) {
      if (part) tokens.push({ text: part, style });
    }
  };
  let match;
  while ((match = marked.exec(source))) {
    addSegment(source.slice(cursor, match.index));
    addSegment(match[1] ?? match[2] ?? '', match[1] !== undefined ? 'italic' : 'small');
    cursor = marked.lastIndex;
  }
  addSegment(source.slice(cursor));
  return tokens.length ? tokens : [{ text: source, style: '' }];
}
function dialogueTokensHTML(tokens) {
  return tokens.map(token => {
    const safe = escapeHTML(token.text);
    if (token.style === 'italic') return `<em>${safe}</em>`;
    if (token.style === 'small') return `<span class="small">${safe}</span>`;
    return safe;
  }).join('');
}
function makeDialogueMeasureProbe(textNode) {
  const style = getComputedStyle(textNode);
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  Object.assign(probe.style, {
    position: 'fixed', left: '-10000px', top: '0', visibility: 'hidden',
    pointerEvents: 'none', zIndex: '-1', display: 'block',
    width: `${Math.max(1, textNode.clientWidth)}px`,
    height: 'auto', minHeight: '0', maxHeight: 'none',
    margin: '0', padding: '0', border: '0', flex: 'none',
    overflow: 'visible', boxSizing: 'border-box',
    fontFamily: style.fontFamily,
    fontSize: `${getEffectiveDialogueFontSize()}px`,
    fontWeight: style.fontWeight,
    fontStyle: style.fontStyle,
    lineHeight: style.lineHeight,
    letterSpacing: style.letterSpacing,
    textAlign: style.textAlign,
    direction: style.direction,
    whiteSpace: style.whiteSpace,
    overflowWrap: 'anywhere',
    wordBreak: 'normal'
  });
  document.body.append(probe);
  return probe;
}
function paginateDialogueText(value) {
  const textNode = $('dialogueText');
  if (!textNode) return [renderMarkedText(value)];
  const availableHeight = textNode.clientHeight;
  if (availableHeight < 8 || !textNode.clientWidth) return [renderMarkedText(value)];

  const tokens = tokenizeMarkedDialogue(value);
  const probe = makeDialogueMeasureProbe(textNode);
  const pages = [];
  let current = [];
  const fits = candidate => {
    probe.innerHTML = dialogueTokensHTML(candidate);
    return probe.scrollHeight <= availableHeight + 1;
  };
  for (const token of tokens) {
    current.push(token);
    if (!fits(current) && current.length > 1) {
      const overflow = current.pop();
      while (current.length && /^\s+$/u.test(current[current.length - 1].text)) current.pop();
      if (current.length) pages.push(dialogueTokensHTML(current));
      const firstToken = { ...overflow, text: overflow.text.trimStart() };
      current = firstToken.text ? [firstToken] : [];
    }
  }
  while (current.length && /^\s+$/u.test(current[current.length - 1].text)) current.pop();
  if (current.length) pages.push(dialogueTokensHTML(current));
  probe.remove();

  return pages.length ? pages : [renderMarkedText(value)];
}
function dialogueStatusLabel(action = 'continue') {
  const pagePrefix = state.dialoguePages.length > 1
    ? `Part ${state.dialoguePageIndex + 1}/${state.dialoguePages.length} · `
    : '';
  if (state.auto) return `${pagePrefix}Auto · ${state.settings.autoDelay}s`;
  return `${pagePrefix}${action === 'reveal' ? 'Tap to reveal' : 'Tap to continue'}`;
}
function renderDialoguePage({ animate = false } = {}) {
  const textNode = $('dialogueText');
  if (!textNode) return 0;
  applyDialogueTypography();
  textNode.innerHTML = state.dialoguePages[state.dialoguePageIndex] || '';
  const revealDuration = prepareWordReveal(textNode, animate);
  $('dialogueStatus').textContent = dialogueStatusLabel(revealDuration > 0 ? 'reveal' : 'continue');
  return revealDuration;
}
function rebuildDialoguePages({ preservePage = true } = {}) {
  if (state.screen !== 'reader' || !state.currentEvent || state.currentEvent.type !== 'say') return;
  const previousPage = preservePage ? state.dialoguePageIndex : 0;
  const textNode = $('dialogueText');
  textNode.innerHTML = renderMarkedText(state.dialogueSourceText);
  state.dialoguePages = paginateDialogueText(state.dialogueSourceText);
  state.dialoguePageIndex = Math.max(0, Math.min(previousPage, state.dialoguePages.length - 1));
  renderDialoguePage({ animate: false });
}
function scheduleDialogueFit() {
  if (dialogueFitFrame) window.cancelAnimationFrame(dialogueFitFrame);
  dialogueFitFrame = window.requestAnimationFrame(() => {
    dialogueFitFrame = 0;
    rebuildDialoguePages({ preservePage: true });
  });
}

function applyPersianSourceQuoteStyle(ev, value) {
  let source = String(ev?.text_en || '').trim();
  // Ignore a standalone speaker label before source dialogue delimiters.
  source = source.replace(/^(?:Pharmacist|Boyfriend|Couple)\n(?=``)/u, '');
  // A few gp32 speech lines span adjacent events: preserve an opening
  // guillemet on the first event and a closing guillemet on the next.
  // Sound-effect annotations use paired backticks and must not be quoted.
  const isSoundEffect = /^``\*[\s\S]*\*``$/.test(source);
  const opensQuote = source.startsWith('``');
  const closesQuote = source.endsWith("''");
  const isCompleteQuote = opensQuote && closesQuote;
  const isSplitQuoteStart = opensQuote && !closesQuote && !isSoundEffect;
  const isSplitQuoteEnd = closesQuote && !opensQuote;
  const isStandaloneUnclosedDialogue = ev?.id === 'gp32_honpen7:097550';
  if (!isCompleteQuote && !isSplitQuoteStart && !isSplitQuoteEnd && !isStandaloneUnclosedDialogue) {
    return String(value || '');
  }
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(String(value || ''));
  if (!match || !match[2]) return String(value || '');
  const leading = match[1], content = match[2], trailing = match[3];
  if (isStandaloneUnclosedDialogue) {
    if (content.startsWith('«') && content.endsWith('»')) return String(value || '');
    return leading + '«' + content.replace(/^«/, '').replace(/»$/, '') + '»' + trailing;
  }
  if (isSplitQuoteStart) {
    if (content.startsWith('«')) return String(value || '');
    return leading + '«' + content + trailing;
  }
  if (isSplitQuoteEnd) {
    if (content.endsWith('»')) return String(value || '');
    return leading + content + '»' + trailing;
  }
  if ((content.startsWith('«') && content.endsWith('»')) ||
      (content.startsWith('“') && content.endsWith('”')) ||
      (content.startsWith('"') && content.endsWith('"'))) return String(value || '');
  if (content.includes('«') || content.includes('»')) {
    const firstQuote = Math.min(...['«', '»'].map(mark => {
      const index = content.indexOf(mark);
      return index < 0 ? Infinity : index;
    }));
    const prefix = content.slice(0, firstQuote);
    if (/گفتم\s*[:،]|گفتیم\s*[:،]/u.test(prefix)) return String(value || '');
    const normalized = content.replace(/«([^»]*)»/gu, '“$1”');
    return leading + '«' + normalized + '»' + trailing;
  }
  if (content.includes('“') || content.includes('”')) return leading + '«' + content + '»' + trailing;
  return leading + '«' + content + '»' + trailing;
}

function renderCurrentDialogue({ animate = false } = {}) {
  const ev = state.currentEvent;
  if (!ev || ev.type !== 'say') return 0;
  const sourceEntry = faData?.translations?.[ev.id] || ev.text_fa || null;
  const overlayEntry = revisedOverlay?.translations?.[ev.id] || null;
  const rawTranslated = overlayEntry?.text ||
    (typeof sourceEntry === 'string' ? sourceEntry : sourceEntry?.text) || '';
  const isPersian = state.language === 'fa';
  const translated = isPersian ? applyPersianSourceQuoteStyle(ev, rawTranslated) : rawTranslated;

  $('dialogueLanguage').textContent = isPersian ? 'فارسی' : 'ENGLISH';
  $('languageNotice').hidden = true;
  $('languageNotice').textContent = '';

  const sourceText = isPersian ? translated : ev.text_en;
  state.dialogueSourceText = sourceText || '';
  applyDialogueTypography();
  $('dialogueText').setAttribute('lang', isPersian ? 'fa' : 'en');
  $('dialogueText').setAttribute('dir', isPersian ? 'rtl' : 'ltr');
  $('dialoguePanel').classList.toggle('centered', ev.align === 'center');
  $('readerScreen').classList.toggle('caption-mode', ev.window === 'caption');

  // Measure at the exact selected size, then split long passages into pages.
  // The typeface and font size are never silently changed to force a fit.
  $('dialogueText').innerHTML = renderMarkedText(state.dialogueSourceText);
  state.dialoguePages = paginateDialogueText(state.dialogueSourceText);
  state.dialoguePageIndex = 0;
  const revealDuration = renderDialoguePage({ animate });
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
  const transitionMs = state.settings.reduceMotion
    ? 0
    : Math.max(0, Number(duration) || ({1:300,3:600,5:1000,10:1000}[effect] || 450));
  const sequence = ++backgroundTransitionSequence;

  // A newer scene change supersedes any pending fade or delayed image swap.
  // Split the source transition duration evenly between fade-out and fade-in.
  if (backgroundTransitionTimer !== null) {
    clearTimeout(backgroundTransitionTimer);
    backgroundTransitionTimer = null;
  }
  const finishTransition = () => {
    if (sequence !== backgroundTransitionSequence) return;
    img.classList.remove('fade-out');
  };
  img.style.transitionDuration = `${transitionMs / 2}ms`;
  img.classList.add('fade-out');

  const apply = () => {
    if (sequence !== backgroundTransitionSequence) return;
    img.onload = () => {
      if (sequence !== backgroundTransitionSequence) return;
      img.onload = null;
      img.onerror = null;
      finishTransition();
    };
    img.onerror = () => {
      if (sequence !== backgroundTransitionSequence) return;
      img.onload = null;
      img.onerror = null;
      finishTransition();
      showToast(`Could not load image: ${path}`);
    };
    img.src = url;
    // Cached or unchanged images may already be complete without firing load.
    if (img.complete && img.naturalWidth > 0) {
      window.requestAnimationFrame(() => {
        if (sequence !== backgroundTransitionSequence) return;
        img.onload = null;
        img.onerror = null;
        finishTransition();
      });
    }
  };

  if (transitionMs === 0) apply();
  else {
    backgroundTransitionTimer = window.setTimeout(() => {
      backgroundTransitionTimer = null;
      apply();
    }, transitionMs / 2);
  }
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
function setAudioVolume(audio, volume) { try { if (audio) audio.volume = Math.max(0, Math.min(1, volume)); } catch {} }
function getSilentAudioDataUrl() {
  if (silentAudioDataUrl) return silentAudioDataUrl;
  // A tiny, genuinely silent PCM WAV primes mobile media playback without
  // producing an audible click or tone.
  const sampleRate = 8000;
  const sampleCount = 800; // 100 ms
  const buffer = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(buffer);
  const write = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  write(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); write(8, 'WAVE');
  write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, sampleCount * 2, true);
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  silentAudioDataUrl = `data:audio/wav;base64,${btoa(binary)}`;
  return silentAudioDataUrl;
}
function getMusicAudioElement() {
  if (!musicAudioElement) {
    musicAudioElement = new Audio();
    musicAudioElement.preload = 'auto';
    musicAudioElement.addEventListener('ended', () => {
      if (state.musicAudio !== musicAudioElement) return;
      if (!state.currentMusicLoop) {
        state.musicAudio = null;
        state.currentMusic = null;
        state.currentMusicLoop = false;
        if (musicRoomTrackActive) syncMusicRoomAmbient(false);
        if ($('musicRoomDialog')?.open) renderMusicRoom();
        return;
      }
      // Native loop should normally handle this; retain a guarded fallback.
      try { musicAudioElement.currentTime = 0; const restarted = musicAudioElement.play(); if (restarted?.catch) restarted.catch(() => {}); } catch {}
    });
    musicAudioElement.addEventListener('play', () => {
      if (musicRoomTrackActive && state.screen === 'home') silenceAmbientForNonMenu();
      if ($('musicRoomDialog')?.open) renderMusicRoom();
    });
    musicAudioElement.addEventListener('pause', () => {
      if (musicRoomTrackActive && state.screen === 'home' && state.musicAudio === musicAudioElement && musicAudioElement.paused && !musicAudioElement.ended) {
        syncMusicRoomAmbient(false);
      }
      if ($('musicRoomDialog')?.open) renderMusicRoom();
    });
    musicAudioElement.addEventListener('error', () => {
      if (state.musicAudio === musicAudioElement) showToast('Background music could not be loaded.');
    });
  }
  return musicAudioElement;
}
function getChannelAudioElement(channel) {
  if (!channelAudioElements.has(channel)) {
    const audio = new Audio();
    audio.preload = 'auto';
    audio.addEventListener('ended', () => {
      if (state.audioChannels.get(channel) === audio) state.audioChannels.delete(channel);
    });
    audio.addEventListener('error', () => {
      if (state.audioChannels.get(channel) === audio) showToast('A story sound could not be loaded.');
    });
    channelAudioElements.set(channel, audio);
  }
  return channelAudioElements.get(channel);
}
function primeAudioElement(audio) {
  if (!audio || primedAudioElements.has(audio)) return Promise.resolve(true);
  if (audioPrimePromises.has(audio)) return audioPrimePromises.get(audio);
  const token = {};
  audio.__narcissuPrimeToken = token;
  try {
    audio.pause();
    audio.src = getSilentAudioDataUrl();
    audio.loop = false;
    audio.volume = 1;
    try { audio.currentTime = 0; } catch {}
    const result = audio.play();
    const promise = Promise.resolve(result).then(() => {
      primedAudioElements.add(audio);
      // If a real story track replaced the silent source meanwhile, do not
      // pause it when the priming promise settles.
      if (audio.__narcissuPrimeToken === token) {
        audio.pause();
        try { audio.currentTime = 0; } catch {}
        audio.__narcissuPrimeToken = null;
      }
      return true;
    }).catch(() => {
      if (audio.__narcissuPrimeToken === token) audio.__narcissuPrimeToken = null;
      return false;
    }).finally(() => audioPrimePromises.delete(audio));
    audioPrimePromises.set(audio, promise);
    return promise;
  } catch {
    if (audio.__narcissuPrimeToken === token) audio.__narcissuPrimeToken = null;
    return Promise.resolve(false);
  }
}
function retryPendingStoryAudio() {
  if (!(state.screen === 'reader' || $('musicRoomDialog')?.open)) return;
  if (pendingMusicPlayback) {
    const request = pendingMusicPlayback;
    pendingMusicPlayback = null;
    playMusic(request.path, request.loop, request.musicRoom ? 'musicRoom' : 'story');
  }
  for (const [channel, ev] of [...pendingChannelPlayback]) {
    pendingChannelPlayback.delete(channel);
    playChannel(ev);
  }
}
function unlockStoryAudioFromGesture(event) {
  const endingAudio = $('endingMessageAudio');
  const restoringProgress = event?.target?.closest?.('#continueButton, #loadButton, #readerLoadButton, #slotList');
  // Continue/load immediately restores the saved scene soundtrack in its click
  // handler. Do not replace the shared music element with the silent priming
  // source on pointerdown first; that races the restored track's play() call.
  const elements = [
    ...(restoringProgress ? [] : [getMusicAudioElement()]),
    ...STORY_AUDIO_CHANNELS.map(getChannelAudioElement)
  ];
  if (endingAudio) elements.push(endingAudio);
  Promise.all(elements.map(primeAudioElement)).then(() => {
    retryPendingStoryAudio();
    if (endingMessagePending && isEndingCreditsActive()) playEndingMessage();
  }).catch(() => {});
}
function stopChannel(channel) {
  pendingChannelPlayback.delete(channel);
  const audio = state.audioChannels.get(channel);
  if (audio) { audio.pause(); try { audio.currentTime = 0; } catch {} state.audioChannels.delete(channel); }
}
function playChannel(ev) {
  const url = assetURL(ev.path);
  if (!url) { showToast(`Missing audio resource: ${ev.path}`); return; }
  stopChannel(ev.channel);
  const audio = getChannelAudioElement(ev.channel);
  audio.loop = !!ev.loop;
  audio.preload = 'auto';
  audio.__narcissuPrimeToken = null;
  audio.src = url;
  try { audio.load(); } catch {}
  setAudioVolume(audio, state.settings.sfxVolume);
  state.audioChannels.set(ev.channel, audio);
  let playback;
  try { playback = audio.play(); }
  catch (error) { playback = Promise.reject(error); }
  if (playback?.catch) playback.catch(error => {
    if (state.audioChannels.get(ev.channel) !== audio) return;
    if (error?.name === 'NotAllowedError') {
      pendingChannelPlayback.set(ev.channel, { ...ev });
      showToast('Story sound is waiting for the next interaction.');
    } else if (error?.name !== 'AbortError') showToast('A story sound could not be played.');
  });
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
  pendingMusicPlayback = null;
  const audio = state.musicAudio || musicAudioElement;
  state.musicAudio = null;
  state.currentMusic = null;
  state.currentMusicLoop = false;
  musicRoomTrackActive = false;
  if (audio) {
    audio.pause();
    try { audio.currentTime = 0; } catch {}
  }
}
function playMusic(path, loop, source = 'story') {
  const url = assetURL(path);
  if (!url) { showToast(`Missing music resource: ${path}`); return null; }
  // Reuse one element across scene changes. This preserves the media-playback
  // permission granted by the player's first touch/click on mobile browsers.
  stopMusic();
  const audio = getMusicAudioElement();
  audio.pause();
  audio.__narcissuPrimeToken = null;
  audio.src = url;
  audio.preload = 'auto';
  audio.loop = !!loop;
  try { audio.load(); } catch {}
  setAudioVolume(audio, state.settings.musicVolume);
  state.musicAudio = audio;
  state.currentMusic = path;
  state.currentMusicLoop = !!loop;
  if (source === 'musicRoom') syncMusicRoomAmbient(true);
  let playback;
  try { playback = audio.play(); }
  catch (error) { playback = Promise.reject(error); }
  if (playback?.catch) playback.catch(error => {
    if (state.musicAudio !== audio || state.currentMusic !== path) return;
    if (error?.name === 'NotAllowedError') {
      pendingMusicPlayback = { path, loop: !!loop, musicRoom: source === 'musicRoom' };
      if (source === 'musicRoom') syncMusicRoomAmbient(false);
      showToast('The soundtrack will resume after your next interaction.');
    } else if (error?.name !== 'AbortError') {
      if (source === 'musicRoom') syncMusicRoomAmbient(false);
      showToast('Background music could not be played.');
    }
  });
  return playback;
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
  $('musicRoomNow').dataset.playing = String(isPlayingNow);
  tracks.forEach((track, index) => {
    const row = document.createElement('div');
    row.className = 'music-track-row';
    row.dataset.trackIndex = String(index + 1);
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
        syncMusicRoomAmbient(false);
      } else if (isCurrent && state.musicAudio) {
        syncMusicRoomAmbient(true);
        const resumed = state.musicAudio.play();
        if (resumed?.catch) resumed.catch(() => {
          syncMusicRoomAmbient(false);
          showToast('Music will resume after your next interaction.');
        });
      } else {
        playMusic(track.path, false, 'musicRoom');
        const audio = state.musicAudio;
        if (audio) audio.addEventListener('ended', () => renderMusicRoom(), { once: true });
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
  syncMusicRoomAmbient(false);
  renderMusicRoom();
}
function isStandaloneMode() {
  return !!(window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true);
}
function requestLandscapeOrientation() {
  // Browsers generally permit orientation locking only in installed/fullscreen
  // contexts. The rotate prompt below remains the reliable cross-browser path.
  if (!isStandaloneMode()) return;
  try {
    const lock = screen.orientation?.lock?.('landscape');
    if (lock && typeof lock.catch === 'function') lock.catch(() => {});
  } catch {}
}
function isPortraitGameplayBlocked() {
  // The orientation requirement applies to the main menu as well as the story:
  // visitors should see the landscape reminder before starting a chapter.
  const orientationRequiredScreen = state.screen === 'home' || state.screen === 'reader' || state.screen === 'chapterEnd';
  if (!orientationRequiredScreen) return false;
  const portrait = !!window.matchMedia?.('(orientation: portrait)').matches;
  const touchDevice = !!window.matchMedia?.('(any-pointer: coarse)').matches || !!window.matchMedia?.('(max-width: 900px)').matches;
  return portrait && touchDevice;
}
function updateOrientationPrompt() {
  const prompt = $('orientationPrompt');
  const blocked = isPortraitGameplayBlocked();
  if (prompt) {
    prompt.hidden = !blocked;
    prompt.setAttribute('aria-hidden', String(!blocked));
  }
  // The prompt is outside .app-shell. Inert makes the whole app (including the
  // top bar and menu buttons) genuinely non-interactive while portrait-locked.
  const appShell = document.querySelector('.app-shell');
  if (appShell) appShell.inert = blocked;

  // If Auto or a timed story command reached its next event while the device
  // was upright, resume the timeline once the device returns to landscape.
  if (!blocked && state.orientationPaused && state.screen === 'reader') {
    state.orientationPaused = false;
    processNext();
  } else if (!blocked && state.screen !== 'settings' && state.screen !== 'reader' && state.screen !== 'chapterEnd') {
    state.orientationPaused = false;
  }
  if (!blocked) maybeShowHomeInstallReminder();
}
function updateInstallButton() {
  const button = $('installAppButton');
  if (button) button.hidden = isStandaloneMode();
  const reminderAction = $('homeInstallActionButton');
  if (reminderAction && deferredInstallPrompt) {
    reminderAction.textContent = 'افزودن به صفحهٔ اصلی';
    reminderAction.dataset.action = 'install';
    const reminderDialog = $('homeInstallReminderDialog');
    if (reminderDialog?.open) $('homeInstallGuidance').textContent = getHomeInstallGuidance();
  }
}
function getHomeInstallGuidance() {
  const ua = navigator.userAgent || '';
  const isIOS = /iPhone|iPad|iPod/i.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(ua);
  if (isIOS) {
    return 'برای افزودن بازی، منوی اشتراک‌گذاری مرورگر را باز کنید و گزینهٔ «Add to Home Screen» را بزنید. در Safari این گزینه در منوی Share قرار دارد. سپس بازی را از آیکون صفحهٔ اصلی اجرا کنید.';
  }
  if (isAndroid && deferredInstallPrompt) {
    return 'می‌توانید با دکمهٔ زیر پنجرهٔ نصب مرورگر را باز کنید و Narcissu را به صفحهٔ اصلی اضافه کنید.';
  }
  if (isAndroid) {
    return 'در Chrome، منوی سه‌نقطه را باز کنید و گزینهٔ «Install app» یا «Add to Home screen» را انتخاب کنید؛ نام گزینه ممکن است با نسخهٔ مرورگر فرق داشته باشد.';
  }
  if (deferredInstallPrompt) {
    return 'مرورگر شما از نصب مستقیم پشتیبانی می‌کند. با دکمهٔ زیر پنجرهٔ نصب Narcissu را باز کنید.';
  }
  return 'در مرورگر، آیکون نصب کنار نوار نشانی یا گزینهٔ «Install app» در منوی مرورگر را انتخاب کنید. اگر این گزینه در دسترس نیست، می‌توانید بازی را همچنان در همین زبانه اجرا کنید.';
}
function maybeShowHomeInstallReminder() {
  if (!dedicationDismissed || homeInstallReminderShown || state.screen !== 'home' || isStandaloneMode() || isPortraitGameplayBlocked()) return;
  try {
    if (localStorage.getItem(HOME_INSTALL_REMINDER_KEY) === '1') {
      homeInstallReminderShown = true;
      return;
    }
  } catch {}
  const dialog = $('homeInstallReminderDialog');
  if (!dialog || dialog.open) return;
  $('homeInstallGuidance').textContent = getHomeInstallGuidance();
  const action = $('homeInstallActionButton');
  action.textContent = deferredInstallPrompt ? 'افزودن به صفحهٔ اصلی' : 'متوجه شدم';
  action.dataset.action = deferredInstallPrompt ? 'install' : 'dismiss';
  dialog.showModal();
}
function markHomeInstallReminderSeen() {
  homeInstallReminderShown = true;
  try { localStorage.setItem(HOME_INSTALL_REMINDER_KEY, '1'); } catch {}
}
async function handleHomeInstallAction() {
  const dialog = $('homeInstallReminderDialog');
  const promptEvent = deferredInstallPrompt;
  if (promptEvent && $('homeInstallActionButton').dataset.action === 'install') {
    deferredInstallPrompt = null;
    markHomeInstallReminderSeen();
    dialog.close();
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
  dialog.close();
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
function stopEndingMessage() {
  endingMessagePending = false;
  const audio = $('endingMessageAudio');
  if (!audio) return;
  audio.pause();
  try { audio.currentTime = 0; } catch {}
}
function isEndingMessagePlaying() {
  const audio = $('endingMessageAudio');
  return !!audio && !audio.paused && !audio.ended;
}
function playEndingMessage() {
  const audio = $('endingMessageAudio');
  if (!audio) return;
  endingMessagePending = false;
  audio.src = new URL('./public/assets/audio/narcissu-ending-message.m4a', document.baseURI).toString();
  audio.preload = 'auto';
  try { audio.currentTime = 0; } catch {}
  audio.volume = Math.max(0, Math.min(1, Number(state.settings.sfxVolume ?? 0.8)));
  try { audio.load(); } catch {}
  let playback;
  try { playback = audio.play(); }
  catch (error) { playback = Promise.reject(error); }
  Promise.resolve(playback).catch(error => {
    if (error?.name === 'NotAllowedError') {
      endingMessagePending = true;
    } else if (error?.name !== 'AbortError') {
      console.info('The closing message could not start.', error);
    }
  });
}
function stopAllAudio() {
  for (const channel of [...state.audioChannels.keys()]) stopChannel(channel);
  pendingChannelPlayback.clear();
  stopMusic();
  stopEndingMessage();
}
function saveProgress() {
  if (!story || state.screen === 'home') return;
  const payload = {
    chapterIndex: state.chapterIndex, eventIndex: state.eventIndex,
    currentEventId: state.currentEvent?.id || null, backgroundPath: state.backgroundPath,
    language: state.language, windowMode: state.windowMode, settings: state.settings,
    screen: state.screen, chapterComplete: !!state.chapterComplete,
    currentMusic: state.currentMusic, currentMusicLoop: !!state.currentMusicLoop,
    currentMusicTime: state.musicAudio && Number.isFinite(state.musicAudio.currentTime) ? state.musicAudio.currentTime : 0,
    dialoguePageIndex: state.dialoguePageIndex,
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
  if (payload.settings) state.settings = normalizeSettings(payload.settings, state.settings);
  delete state.settings.showReviewedSource;
  delete state.settings.showEditorialDrafts;
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
    // If progress is restored during the final photo/credit sequence, resume
    // its voice message rather than leaving the player with silent credits.
    if (isEndingCreditsActive()) {
      stopAllAudio();
      playEndingMessage();
    }
    if (state.currentEvent) {
      renderCurrentDialogue();
      if (Number(payload.dialoguePageIndex) > 0 && state.dialoguePages.length > 1) {
        state.dialoguePageIndex = Math.min(state.dialoguePages.length - 1, Number(payload.dialoguePageIndex));
        renderDialoguePage({ animate: false });
      }
    } else { $('dialogueText').textContent = ''; processNext(); }
  }
  if (payload.currentMusic) {
    playMusic(payload.currentMusic, !!payload.currentMusicLoop);
    const resumeTime = Math.max(0, Number(payload.currentMusicTime) || 0);
    const audio = state.musicAudio;
    if (audio && resumeTime > 0) {
      const restoreMusicTime = () => {
        if (state.musicAudio !== audio) return;
        try { audio.currentTime = resumeTime; } catch {}
      };
      if (audio.readyState >= 1) restoreMusicTime();
      else audio.addEventListener('loadedmetadata', restoreMusicTime, { once: true });
    }
  }
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
    advance();
  }, Math.max(0, extraDelayMs) + state.settings.autoDelay * 1000);
}
function isEndingCreditsBackground(ev) {
  return state.chapterIndex === story.chapters.length - 1 &&
    ev?.type === 'background' &&
    normalizePath(ev.path) === 'english/1/st01.jpg';
}
function isEndingCreditsActive() {
  if (!story || state.screen !== 'reader' || state.chapterIndex !== story.chapters.length - 1) return false;
  const events = chapter()?.events || [];
  const startIndex = events.findIndex(ev => isEndingCreditsBackground(ev));
  return startIndex >= 0 && state.eventIndex > startIndex && state.eventIndex < events.length;
}
function processNext() {
  if (state.screen !== 'reader') return;
  if (isPortraitGameplayBlocked()) { state.orientationPaused = true; return; }
  clearWaitingTimer(); state.awaitingClick = false; state.pendingAdvance = false;
  const ch = chapter();
  while (state.eventIndex < ch.events.length) {
    const ev = ch.events[state.eventIndex++];
    switch (ev.type) {
      case 'background':
        if (isEndingCreditsBackground(ev)) {
          // The final photo sequence is the credit roll. Give the voice message
          // the audio space before the first credit image appears.
          stopAllAudio();
          playEndingMessage();
        }
        setBackground(ev.path, ev.effect, ev.duration_ms);
        if (Number(ev.hold_ms) > 0) {
          state.awaitingClick = true; state.pendingAdvance = true;
          $('dialogueStatus').textContent = '…';
          state.waitingTimer = setTimeout(() => { state.waitingTimer = null; processNext(); }, Number(ev.hold_ms));
          updateProgress(); saveProgress(); return;
        }
        break;
      case 'audio_play':
        if (!isEndingMessagePlaying() && !endingMessagePending) playChannel(ev);
        break;
      case 'audio_stop_channel': stopChannel(ev.channel); break;
      case 'music_play':
        if (!isEndingMessagePlaying() && !endingMessagePending) playMusic(ev.path, ev.loop);
        break;
      case 'music_fadeout': fadeMusic(ev.duration_ms); break;
      case 'window_mode': state.windowMode = ev.window; break;
      case 'alignment_hint': state.centerNext = true; break;
      case 'clear_text': state.currentEvent = null; state.dialogueSourceText = ''; state.dialoguePages = []; state.dialoguePageIndex = 0; $('dialogueText').textContent = ''; break;
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
        $('dialogueStatus').textContent = state.auto ? `Auto · ${state.settings.autoDelay}s` : 'Tap to continue';
        // Ponscripter click-waits are timeline gates. Auto mode must be allowed
        // to pass them, otherwise later scene changes and their music never run.
        if (state.auto) scheduleAutoAdvance();
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
  if (isPortraitGameplayBlocked()) { state.orientationPaused = true; return; }
  if (state.revealActive) {
    clearWaitingTimer();
    finishDialogueReveal();
    if (state.auto && !state.pendingAdvance) scheduleAutoAdvance();
    return;
  }
  if (state.waitingTimer) { clearWaitingTimer(); state.waitingTimer = null; }

  // A long dialogue event may span multiple fixed-size pages. Each tap advances
  // within the same event first; only the final page advances the story timeline.
  if (state.currentEvent?.type === 'say' &&
      state.dialoguePageIndex < state.dialoguePages.length - 1) {
    state.dialoguePageIndex += 1;
    const revealDuration = renderDialoguePage({ animate: true });
    saveProgress();
    if (state.auto) scheduleAutoAdvance(revealDuration);
    return;
  }
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
  if (!hasNext) stopAllAudio();
  // The closing message now plays automatically over the final photo/credit sequence.
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
    button.addEventListener('click', () => {
      $('chapterSelectPanel').hidden = true;
      $('chaptersButton').setAttribute('aria-expanded','false');
      startChapter(i,0);
    });
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
async function checkForAppUpdate(force = false) {
  const registration = appServiceWorkerRegistration;
  if (!registration || !navigator.onLine || document.visibilityState === 'hidden') return;
  const now = Date.now();
  if (!force && now - lastAppUpdateCheckAt < APP_UPDATE_CHECK_INTERVAL_MS) return;
  if (appUpdateCheckPromise) return appUpdateCheckPromise;
  lastAppUpdateCheckAt = now;
  appUpdateCheckPromise = registration.update().catch(error => {
    console.debug('Narcissu update check deferred:', error);
  }).finally(() => {
    appUpdateCheckPromise = null;
  });
  return appUpdateCheckPromise;
}
function handleServiceWorkerControllerChange() {
  const controller = navigator.serviceWorker?.controller;
  if (!controller) return;
  // The first controller on a fresh installation should not cause a reload.
  if (!serviceWorkerHadController) {
    serviceWorkerHadController = true;
    return;
  }
  if (serviceWorkerUpdateReloading) return;
  serviceWorkerUpdateReloading = true;
  if (state.screen !== 'home') {
    saveProgress();
    try { sessionStorage.setItem(SERVICE_WORKER_RESUME_KEY, '1'); } catch {}
  }
  // The activating worker normally navigates this client with a one-time
  // resume marker. Keep a delayed fallback in case a browser blocks client.navigate.
  window.setTimeout(() => {
    if (serviceWorkerUpdateReloading && !document.hidden) window.location.reload();
  }, 2500);
}
function watchServiceWorkerRegistration(registration) {
  appServiceWorkerRegistration = registration;
  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed' && navigator.serviceWorker.controller) {
        showToast('A new Narcissu version is ready. Updating…');
      }
    });
  });
  if (!appUpdateInterval) {
    appUpdateInterval = setInterval(() => checkForAppUpdate(false), APP_UPDATE_CHECK_INTERVAL_MS);
  }
}
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    serviceWorkerHadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.removeEventListener('controllerchange', handleServiceWorkerControllerChange);
    navigator.serviceWorker.addEventListener('controllerchange', handleServiceWorkerControllerChange);
    const registration = await navigator.serviceWorker.register('./service-worker.js', { updateViaCache: 'none' });
    watchServiceWorkerRegistration(registration);
    // Wait briefly for the worker to take control; update checks continue when
    // the PWA is reopened, foregrounded, or comes back online.
    await Promise.race([navigator.serviceWorker.ready, new Promise(resolve => setTimeout(resolve, 2500))]);
    await checkForAppUpdate(true);
    return registration;
  } catch (e) {
    console.warn('Service worker registration failed', e);
    return null;
  }
}
function getOfflineAssetUrls() {
  const urls = new Set();
  const add = path => {
    if (!path) return;
    urls.add(new URL(`./public/${path}`,document.baseURI).toString());
  };
  Object.values(assetManifest?.assets || {}).forEach(item => {
    add(item.url);
    add(item.mobile_url);
    add(item.mobile_landscape_url);
  });
  // The menu photograph and ambient track are not part of the original archive
  // manifest, so include them explicitly in the optional offline library.
  add('assets/images/narcissu-coastal-background.jpg');
  add('assets/audio/narcissu-coastal-ambience.mp3');
  add('assets/audio/narcissu-ending-message.m4a');
  return [...urls];
}
async function openOfflineDialog() {
  const dialog = $('offlineDialog');
  if (!dialog.open) dialog.showModal();
  $('downloadMeterFill').style.width='0%';
  $('downloadPercent').textContent='0%';
  $('downloadStatus').textContent='Checking saved resources…';
  try {
    const items = getOfflineAssetUrls();
    const cache = await caches.open(ASSET_CACHE_NAME);
    let cached = 0;
    for (const url of items) if (await cache.match(url)) cached++;
    const pct = items.length ? Math.round(cached / items.length * 100) : 100;
    $('downloadMeterFill').style.width = `${pct}%`;
    $('downloadPercent').textContent = `${pct}%`;
    $('downloadStatus').textContent = cached === items.length
      ? `All ${items.length} resources are already saved on this device.`
      : `${cached} of ${items.length} resources already saved.`;
    const est=await navigator.storage?.estimate?.();
    if(est) $('storageStatus').textContent=`Storage estimate: ${Math.round((est.usage||0)/1024/1024)} MB used of ${Math.round((est.quota||0)/1024/1024)} MB available.`;
    else $('storageStatus').textContent='Storage quota information is not available in this browser.';
  } catch {
    $('downloadStatus').textContent='Could not inspect saved resources. You can still try the download.';
    $('storageStatus').textContent='Storage information is not available in this browser.';
  }
}
async function downloadOfflineAssets() {
  if(state.downloadBusy)return;
  state.downloadBusy=true;
  $('startDownloadButton').disabled=true;
  $('downloadStatus').textContent='Preparing the complete game library…';
  let done=0,failed=0,total=0;
  try {
    const items=getOfflineAssetUrls();
    total=items.length;
    const cache=await caches.open(ASSET_CACHE_NAME);
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
    $('downloadStatus').textContent=failed
      ? `Completed with ${failed} failed resources. Retry to fetch the missing files.`
      : `All ${total} game resources are saved for offline use.`;
    showToast(failed?`Offline download finished; ${failed} files need another attempt.`:'The complete game library is ready offline.');
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
  await caches.delete(ASSET_CACHE_NAME);$('downloadMeterFill').style.width='0%';$('downloadPercent').textContent='0%';$('downloadStatus').textContent='Offline assets cleared.';showToast('Offline assets cleared.');
}
function updateTextSizeReadout(size) {
  const value = Math.min(18, Math.max(11, Number(size) || 13));
  const output = $('textSizeValue');
  if (output) output.textContent = `${value} px`;
}
function previewTextSize(size) {
  state.previewTextSize = Math.min(18, Math.max(11, Number(size) || 13));
  updateTextSizeReadout(state.previewTextSize);
  applyDialogueTypography(state.previewTextSize);
  scheduleDialogueFit();
}
function cancelTextSizePreview() {
  state.previewTextSize = null;
  applyDialogueTypography(state.settings.textSize);
  updateTextSizeReadout(state.settings.textSize);
  scheduleDialogueFit();
}

function activateSettingsTab(tab, { focus = false } = {}) {
  const validTabs = new Set(['reading', 'appearance', 'audio', 'accessibility']);
  const activeTab = validTabs.has(tab) ? tab : 'reading';
  document.querySelectorAll('[data-settings-tab]').forEach(button => {
    const active = button.dataset.settingsTab === activeTab;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    if (active && focus) button.focus();
  });
  document.querySelectorAll('[data-settings-panel]').forEach(panel => {
    const active = panel.dataset.settingsPanel === activeTab;
    panel.hidden = !active;
    panel.classList.toggle('is-active', active);
    panel.setAttribute('aria-hidden', String(!active));
  });
}

function openSettingsScreen() {
  settingsReturnScreen = state.screen === 'settings' ? settingsReturnScreen : state.screen;
  const s=state.settings;
  $('fullTextSize').value=s.textSize;
  $('fullTextSizeValue').textContent=s.textSize+' px';
  $('fullAutoAdvance').checked=!!state.auto;
  $('fullAutoDelay').value=s.autoDelay;
  $('fullAutoDelayValue').textContent=s.autoDelay+' s';
  $('fullFontStyle').value=s.fontStyle||'serif';
  $('fullMessageOpacity').value=s.messageBoxOpacity||80;
  $('fullMessageOpacityValue').textContent=(s.messageBoxOpacity||80)+'%';
  $('fullPersianFont').value=s.persianFont;
  $('fullMusicVolume').value=Math.round(s.musicVolume*100);
  $('fullMusicVolumeValue').textContent=Math.round(s.musicVolume*100)+'%';
  $('fullSfxVolume').value=Math.round(s.sfxVolume*100);
  $('fullSfxVolumeValue').textContent=Math.round(s.sfxVolume*100)+'%';
  $('fullAmbientVolume').value=Math.round((s.ambientVolume??0.6)*100);
  $('fullAmbientVolumeValue').textContent=Math.round((s.ambientVolume??0.6)*100)+'%';
  $('fullReduceMotion').checked=!!s.reduceMotion;
  $('fullHighContrast').checked=!!s.highContrast;
  $('fullLanguage').value=state.language;
  activateSettingsTab('reading');
  setScreen('settings');
}
function saveFullSettings() {
  state.settings.textSize=Number($('fullTextSize').value);
  state.settings.textSizeVersion=4;
  state.settings.autoDelay=Number($('fullAutoDelay').value);
  state.settings.fontStyle=$('fullFontStyle').value;
  state.settings.messageBoxOpacity=Number($('fullMessageOpacity').value);
  state.settings.persianFont=$('fullPersianFont').value;
  state.settings.musicVolume=Number($('fullMusicVolume').value)/100;
  state.settings.sfxVolume=Number($('fullSfxVolume').value)/100;
  state.settings.ambientVolume=Number($('fullAmbientVolume').value)/100;
  state.settings.reduceMotion=$('fullReduceMotion').checked;
  state.settings.highContrast=$('fullHighContrast').checked;
  applyVisualPreferences();
  if(state.musicAudio)setAudioVolume(state.musicAudio,state.settings.musicVolume);
  for(const [,audio] of state.audioChannels)setAudioVolume(audio,state.settings.sfxVolume);
  const ambienceAudio=$('homeAmbientAudio');if(ambienceAudio)ambienceAudio.volume=state.settings.ambientVolume;if(ambientMasterGain&&ambientAudioContext)ambientMasterGain.gain.setTargetAtTime(ambientEnabled?state.settings.ambientVolume:0,ambientAudioContext.currentTime,.35);
  persistSettings();
  if(state.settings.persianFont!=='noto')ensurePersianFontLoaded(state.settings.persianFont).then(scheduleDialogueFit).catch(()=>showToast('Persian font unavailable; using the bundled fallback.'));
  setLanguage($('fullLanguage').value);
  setScreen(settingsReturnScreen);
  if($('fullAutoAdvance').checked!==state.auto)toggleAuto();
  showToast('Settings applied.');
}
function resetFullSettings() {
  state.settings=normalizeSettings({},DEFAULT_SETTINGS);
  clearWaitingTimer();
  state.auto=false;
  $('autoButton').setAttribute('aria-pressed','false');
  applyVisualPreferences();
  const ambienceAudio=$('homeAmbientAudio');if(ambienceAudio)ambienceAudio.volume=state.settings.ambientVolume;
  persistSettings();
  openSettingsScreen();
  showToast('Settings restored to defaults.');
}
function bindFullSettings() {
  const settingsTabs = [...document.querySelectorAll('[data-settings-tab]')];
  settingsTabs.forEach((button, index) => {
    button.addEventListener('click', () => activateSettingsTab(button.dataset.settingsTab));
    button.addEventListener('keydown', event => {
      const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
      const backward = event.key === 'ArrowUp' || event.key === 'ArrowLeft';
      let nextIndex = index;
      if (forward) nextIndex = (index + 1) % settingsTabs.length;
      else if (backward) nextIndex = (index - 1 + settingsTabs.length) % settingsTabs.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = settingsTabs.length - 1;
      else return;
      event.preventDefault();
      activateSettingsTab(settingsTabs[nextIndex].dataset.settingsTab, { focus: true });
    });
  });
  const pairs=[['fullTextSize','fullTextSizeValue',v=>v+' px'],['fullAutoDelay','fullAutoDelayValue',v=>v+' s'],['fullMessageOpacity','fullMessageOpacityValue',v=>v+'%'],['fullMusicVolume','fullMusicVolumeValue',v=>v+'%'],['fullSfxVolume','fullSfxVolumeValue',v=>v+'%'],['fullAmbientVolume','fullAmbientVolumeValue',v=>v+'%']];
  pairs.forEach(([id,out,format])=>$(id).addEventListener('input',e=>$(out).textContent=format(e.target.value)));
  $('saveFullSettings').addEventListener('click',saveFullSettings);
  $('resetFullSettings').addEventListener('click',resetFullSettings);
  $('backFromSettings').addEventListener('click',()=>setScreen(settingsReturnScreen));
}

function setupSettings() {
  $('persianFontSetting').value=state.settings.persianFont;
  $('textSizeSetting').value=state.settings.textSize;
  updateTextSizeReadout(state.settings.textSize);
  state.previewTextSize = null;
  $('autoDelaySetting').value=state.settings.autoDelay;
  $('musicVolumeSetting').value=state.settings.musicVolume;
  $('sfxVolumeSetting').value=state.settings.sfxVolume;
  $('reduceMotionSetting').checked=state.settings.reduceMotion;
  $('settingsDialog').showModal();
}
function applySettings() {
  state.settings.mode='enhanced';state.settings.persianFont=$('persianFontSetting').value;state.settings.textSize=Number($('textSizeSetting').value);state.settings.textSizeVersion=4;state.previewTextSize=null;state.settings.autoDelay=Number($('autoDelaySetting').value);
  state.settings.musicVolume=Number($('musicVolumeSetting').value);state.settings.sfxVolume=Number($('sfxVolumeSetting').value);state.settings.reduceMotion=$('reduceMotionSetting').checked;
  applyVisualPreferences();
  updateTextSizeReadout(state.settings.textSize);
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
  // Preserve real timeline waits. A click_wait has no timer of its own, so Auto
  // must schedule it explicitly; this is also what lets its following music_play
  // event execute without a manual tap.
  if(state.auto && state.pendingAdvance && !state.waitingTimer) {
    $('dialogueStatus').textContent=`Auto · ${state.settings.autoDelay}s`;
    scheduleAutoAdvance();
  } else if(state.auto && state.currentEvent && !state.pendingAdvance) {
    $('dialogueStatus').textContent=dialogueStatusLabel(state.revealActive?'reveal':'continue');
    scheduleAutoAdvance(remainingDialogueRevealMs());
  } else if(!state.auto && !state.pendingAdvance) {
    clearWaitingTimer();
    $('dialogueStatus').textContent=dialogueStatusLabel(state.revealActive?'reveal':'continue');
  }
}
function bindUI() {
  bindFullSettings();
  $('brandHome').addEventListener('click',e=>{e.preventDefault();returnHome();});
  $('newGameButton').addEventListener('click',startNewGame);
  $('ambientToggle')?.addEventListener('click', () => ambientEnabled ? stopAmbientSound() : startAmbientSound());
  // Browsers such as iOS Safari block audible autoplay until a real user
  // gesture. Start on the first interaction anywhere, rather than requiring
  // a separate tap on the ambience control. Respect an explicit opt-out.
  const tryAmbientAfterGesture = (event) => {
    if (!ambientAutoplayAllowed()) return;
    if (event.target?.closest?.('#ambientToggle')) return;
    if ((state.settings.ambientVolume ?? 0.6) <= 0) return;
    startAmbientSound();
  };
  document.addEventListener('pointerdown', (event) => {
    unlockStoryAudioFromGesture(event);
    if (state.screen === 'home') tryAmbientAfterGesture(event);
  }, { capture: true });
  document.addEventListener('keydown', (event) => {
    unlockStoryAudioFromGesture();
    if (state.screen === 'home') tryAmbientAfterGesture(event);
  }, { capture: true });
  $('continueButton').addEventListener('click',()=>{const p=getProgress();if(p)restoreProgress(p);});
  $('chaptersButton').addEventListener('click',()=>{
    const panel=$('chapterSelectPanel');
    panel.hidden=false;
    $('chaptersButton').setAttribute('aria-expanded','true');
    $('closeChapters').focus();
  });
  $('closeChapters').addEventListener('click',()=>{
    $('chapterSelectPanel').hidden=true;
    $('chaptersButton').setAttribute('aria-expanded','false');
    $('chaptersButton').focus();
  });
  document.addEventListener('keydown',event=>{
    const panel=$('chapterSelectPanel');
    if(panel.hidden) return;
    if(event.key==='Escape'){
      event.preventDefault();
      panel.hidden=true;
      $('chaptersButton').setAttribute('aria-expanded','false');
      $('chaptersButton').focus();
      return;
    }
    if(event.key==='Tab'){
      const focusable=[...panel.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
      if(!focusable.length) return;
      const first=focusable[0], last=focusable[focusable.length-1];
      if(event.shiftKey && document.activeElement===first){event.preventDefault();last.focus();}
      else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first.focus();}
    }
  });
  $('loadButton').addEventListener('click',()=>openSlots('load'));
  $('musicRoomButton').addEventListener('click',openMusicRoom);
  $('closeMusicRoom').addEventListener('click',()=>$('musicRoomDialog').close());
  $('stopMusicRoomButton').addEventListener('click',stopMusicRoom);
  $('installAppButton').addEventListener('click',installApp);
  $('homeInstallActionButton').addEventListener('click',handleHomeInstallAction);
  $('homeInstallLaterButton').addEventListener('click',()=>$('homeInstallReminderDialog').close());
  $('homeInstallReminderDialog').addEventListener('close',markHomeInstallReminderSeen);
  $('closeInstallHelp').addEventListener('click',()=>$('installHelpDialog').close());
  $('closeInstallHelpButton').addEventListener('click',()=>$('installHelpDialog').close());
  $('settingsButton').addEventListener('click',openSettingsScreen);
  $('textSizeSetting').addEventListener('input', event => previewTextSize(event.target.value));
  $('settingsDialog').addEventListener('close', cancelTextSizePreview);
  $('saveSettingsButton').addEventListener('click',applySettings);
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
  $('homeOfflineDownloadButton').addEventListener('click',openOfflineDialog);
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
  window.addEventListener('resize',()=>{refreshBackgroundForViewport();scheduleDialogueFit();updateOrientationPrompt();},{passive:true});
  window.addEventListener('orientationchange',()=>{refreshBackgroundForViewport();scheduleDialogueFit();updateOrientationPrompt();},{passive:true});
  if (document.fonts?.ready) document.fonts.ready.then(scheduleDialogueFit);
  updateInstallButton(); refreshBackgroundForViewport();
  window.addEventListener('online',()=>{updateNetworkStatus();checkForAppUpdate(true);});
  window.addEventListener('offline',updateNetworkStatus);
  window.addEventListener('pageshow',()=>checkForAppUpdate(true));
  window.addEventListener('focus',()=>checkForAppUpdate(true));
  window.addEventListener('beforeunload',saveProgress);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)saveProgress();else checkForAppUpdate(true);});
}

async function boot() {
  let resumeAfterServiceWorkerUpdate = false;
  let serviceWorkerNavigation = false;
  let previousScreenAtBoot = null;
  try {
    previousScreenAtBoot = localStorage.getItem('narcissu-active-screen');
    localStorage.setItem('narcissu-active-screen', 'home');
  } catch {}
  try {
    resumeAfterServiceWorkerUpdate = sessionStorage.getItem(SERVICE_WORKER_RESUME_KEY) === '1';
    if (resumeAfterServiceWorkerUpdate) sessionStorage.removeItem(SERVICE_WORKER_RESUME_KEY);
  } catch {}
  try {
    const updateUrl = new URL(window.location.href);
    if (updateUrl.searchParams.get('narcissu-updated') === '1') {
      serviceWorkerNavigation = true;
      resumeAfterServiceWorkerUpdate = true;
      updateUrl.searchParams.delete('narcissu-updated');
      history.replaceState(null, '', `${updateUrl.pathname}${updateUrl.search}${updateUrl.hash}`);
    }
  } catch {}
  try {
    const [storyResponse, assetsResponse, faResponse, historicalAlignmentResponse, overlayResponse, increment20Response, chapter2RecoveryResponse, chapter3RecoveryResponse, chapter4RecoveryResponse, chapter4Page44RecoveryResponse, chapter4Page45RecoveryResponse, chapter4Pages46to50RecoveryResponse, chapter1Chapter3RecoveryResponse, literaryProofreadResponse, finalProofreadResponse, increment31ProofreadResponse, increment32ProofreadResponse, increment33ProofreadResponse, increment34ProofreadResponse, increment35ProofreadResponse, increment38AssistantReviewResponse, conversationalToneResponse, literaryRevisionResponse, increment54Response, increment55Response, increment56Response, increment57Response, increment58Response, increment60Response, increment61Response, increment62Response, increment63Response, increment64Response, increment65Response, conversationalPolishResponse] = await Promise.all([
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
      fetch('./data/localization/fa-assistant-editorial-review-increment38.json'),
      fetch('./data/localization/fa-conversational-tone-increment52.json'),
      fetch('./data/localization/fa-literary-revision-increment53.json'),
      fetch('./data/localization/fa-literary-revision-increment54.json'),
      fetch('./data/localization/fa-literary-revision-increment55.json'),
      fetch('./data/localization/fa-literary-revision-increment56.json'),
      fetch('./data/localization/fa-literary-revision-increment57.json'),
      fetch('./data/localization/fa-literary-revision-increment58.json'),
      fetch('./data/localization/fa-literary-revision-increment60.json'),
      fetch('./data/localization/fa-literary-revision-increment61.json'),
      fetch('./data/localization/fa-literary-revision-increment62.json'),
      fetch('./data/localization/fa-literary-revision-increment63.json'),
      fetch('./data/localization/fa-literary-revision-increment64.json'),
      fetch('./data/localization/fa-literary-revision-increment65.json'),
      fetch('./data/localization/fa-conversational-polish-increment66.json')
    ]);
    if(!storyResponse.ok||!assetsResponse.ok)throw new Error('Could not load game data.');
    story=await storyResponse.json();assetManifest=await assetsResponse.json();
    const archivalFaData=faResponse.ok?await faResponse.json():{translations:{}};
    const historicalAlignmentData=historicalAlignmentResponse.ok?await historicalAlignmentResponse.json():{translations:{},event_alignment:{}};
    historicalEventAlignment=historicalAlignmentData.event_alignment||{};
    // Precedence: historical alignment data supersedes the archival fa.json where IDs collide;
    // Recovery and proofread overlays are applied next; Increment 52 sets conversational tone; later literary increments apply targeted revisions in order.
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
    const conversationalToneOverlay=conversationalToneResponse.ok?await conversationalToneResponse.json():{translations:{}};
    const literaryRevisionOverlay=literaryRevisionResponse.ok?await literaryRevisionResponse.json():{translations:{}};
    const increment54Overlay=increment54Response.ok?await increment54Response.json():{translations:{}};
    const increment55Overlay=increment55Response.ok?await increment55Response.json():{translations:{}};
    const increment56Overlay=increment56Response.ok?await increment56Response.json():{translations:{}};
    const increment57Overlay=increment57Response.ok?await increment57Response.json():{translations:{}};
    const increment58Overlay=increment58Response.ok?await increment58Response.json():{translations:{}};
    const increment60Overlay=increment60Response.ok?await increment60Response.json():{translations:{}};
    const increment61Overlay=increment61Response.ok?await increment61Response.json():{translations:{}};
    const increment62Overlay=increment62Response.ok?await increment62Response.json():{translations:{}};
    const increment63Overlay=increment63Response.ok?await increment63Response.json():{translations:{}};
    const increment64Overlay=increment64Response.ok?await increment64Response.json():{translations:{}};
    const increment65Overlay=increment65Response.ok?await increment65Response.json():{translations:{}};
    const conversationalPolishOverlay=conversationalPolishResponse.ok?await conversationalPolishResponse.json():{translations:{}};
    revisedOverlay={...recoveredOverlay,translations:{...(recoveredOverlay.translations||{}),...(increment20Overlay.translations||{}),...(chapter2RecoveryOverlay.translations||{}),...(chapter3RecoveryOverlay.translations||{}),...(chapter4RecoveryOverlay.translations||{}),...(chapter4Page44RecoveryOverlay.translations||{}),...(chapter4Page45RecoveryOverlay.translations||{}),...(chapter4Pages46to50RecoveryOverlay.translations||{}),...(chapter1Chapter3RecoveryOverlay.translations||{}),...(literaryProofreadOverlay.translations||{}),...(finalProofreadOverlay.translations||{}),...(increment31ProofreadOverlay.translations||{}),...(increment32ProofreadOverlay.translations||{}),...(increment33ProofreadOverlay.translations||{}),...(increment34ProofreadOverlay.translations||{}),...(increment35ProofreadOverlay.translations||{}),...(increment38AssistantReviewOverlay.translations||{}),...(conversationalToneOverlay.translations||{}),...(literaryRevisionOverlay.translations||{}),...(increment54Overlay.translations||{}),...(increment55Overlay.translations||{}),...(increment56Overlay.translations||{}),...(increment57Overlay.translations||{}),...(increment58Overlay.translations||{}),...(increment60Overlay.translations||{}),...(increment61Overlay.translations||{}),...(increment62Overlay.translations||{}),...(increment63Overlay.translations||{}),...(increment64Overlay.translations||{}),...(increment65Overlay.translations||{}),...(conversationalPolishOverlay.translations||{})}};
    state.history=safeJSONParse(localStorage.getItem(STORAGE_KEYS.history),[]);
    state.language=localStorage.getItem('narcissu-language-v1')||DEFAULT_LANGUAGE;
    loadSettings();bindUI();renderChapters();setLanguage(state.language);updateNetworkStatus();
    $('continueButton').disabled=!getProgress();
    registerServiceWorker().then(preloadPersianFonts);
    if (resumeAfterServiceWorkerUpdate) {
      const saved = getProgress();
      const savedAt = Date.parse(saved?.savedAt || '');
      const recentlySaved = Number.isFinite(savedAt) && Date.now() - savedAt < 30000;
      const wasReadingBeforeUpdate = previousScreenAtBoot === 'reader' || previousScreenAtBoot === 'chapterEnd';
      const canSafelyResume = saved && saved.screen !== 'home' &&
        (!serviceWorkerNavigation || wasReadingBeforeUpdate || (!previousScreenAtBoot && recentlySaved));
      if (canSafelyResume) restoreProgress(saved);
    } else if(location.hash==='#play') {
      const p=getProgress();if(p)restoreProgress(p);
    }
    prepareWelcomeAssets();
  } catch(e) {
    console.error(e);document.body.innerHTML=`<main style="max-width:720px;margin:12vh auto;padding:24px;font:16px sans-serif;color:#eee;background:#111"> <h1>Narcissu could not start</h1><p>${escapeHTML(e.message)}</p><p>Serve this folder through a local web server or HTTPS. Opening index.html directly as a file will not load the game data.</p></main>`;
  }
}

// Bind the dedication skip control as soon as the deferred script executes,
// so it remains responsive even while the story data is loading.

boot();
