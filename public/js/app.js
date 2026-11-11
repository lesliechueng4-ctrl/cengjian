import { SyncPlayer, SPEEDS } from './player.js';
import { runSeparation, separationLimitMessage, STEMS, STEM_NOTES } from './separator.js';
import { encodeWav } from './wav.js';
import { evictStemCaches, waitForDuration } from './library.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const els = {
  views: $$('.view'),
  tabs: $$('.tab'),
  fileInput: $('#fileInput'),
  dropzone: $('#dropzone'),
  mediaCard: $('#mediaCard'),
  video: $('#video'),
  masterAudio: $('#masterAudio'),
  audioArt: $('#audioArt'),
  audioName: $('#audioName'),
  stageTap: $('#stageTap'),
  progress: $('#progress'),
  progressFill: $('#progressFill'),
  progressThumb: $('#progressThumb'),
  timeTop: $('#timeTop'),
  timeBottom: $('#timeBottom'),
  ctlPlay: $('#ctlPlay'),
  speedBtn: $('#speedBtn'),
  loopBtn: $('#loopBtn'),
  stemStatus: $('#stemStatus'),
  stemButtons: $$('.stem-btn'),
  playBtn: $('#playBtn'),
  uploadBtn: $('#uploadBtn'),
  analysisLink: $('#analysisLink'),
  sheet: $('#analysisSheet'),
  sheetBackdrop: $('#sheetBackdrop'),
  sheetBody: $('#sheetBody'),
  sheetClose: $('#sheetClose'),
  libraryList: $('#libraryList'),
  libraryEmpty: $('#libraryEmpty'),
  defaultSpeed: $('#defaultSpeed'),
  defaultLoop: $('#defaultLoop'),
};

const state = {
  entries: [], // { id, file, name, kind, duration }
  current: null,
  selected: 'original',
  stemsReady: false,
  separating: false,
  progress: 0,
  error: '',
  analysis: null, // { duration, sampleRate, channels, bpm }
  abort: null,
  nextId: 1,
};

// ---------------------------------------------------------------------------
// Settings (stored locally)
// ---------------------------------------------------------------------------

const SETTINGS_KEY = 'cengjian.settings';
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return { speed: SPEEDS.includes(s.speed) ? s.speed : 1, loop: !!s.loop };
  } catch {
    return { speed: 1, loop: false };
  }
}
const settings = loadSettings();
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
}
els.defaultSpeed.value = String(settings.speed);
els.defaultLoop.checked = settings.loop;
els.defaultSpeed.addEventListener('change', () => {
  settings.speed = Number(els.defaultSpeed.value);
  saveSettings();
});
els.defaultLoop.addEventListener('change', () => {
  settings.loop = els.defaultLoop.checked;
  saveSettings();
});

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

let scrubbing = null; // ratio while dragging the progress bar

const player = new SyncPlayer({ video: els.video, audio: els.masterAudio, onUpdate: render });
player.setRate(settings.speed);
player.setLoop(settings.loop);

export function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function render() {
  const loaded = !!state.current;
  const d = player.duration;
  // Files that skip decoding (too large, undecodable) still get a duration in 音乐台.
  if (loaded && !state.current.duration && d) {
    state.current.duration = d;
    renderLibrary();
  }
  const t = scrubbing != null ? scrubbing * d : player.currentTime;
  const ratio = d ? Math.min(1, t / d) : 0;
  const pct = `${(ratio * 100).toFixed(2)}%`;
  els.progressFill.style.width = pct;
  els.progressThumb.style.left = pct;
  els.progress.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  const time = `${formatTime(t)} / ${formatTime(d)}`;
  if (els.timeTop.textContent !== time) {
    els.timeTop.textContent = time;
    els.timeBottom.textContent = time;
  }
  const playing = loaded && !player.paused;
  els.playBtn.classList.toggle('is-playing', playing);
  els.ctlPlay.classList.toggle('is-playing', playing);
  els.ctlPlay.setAttribute('aria-label', playing ? '暂停' : '播放');
  els.mediaCard.classList.toggle('is-playing', playing);
  els.playBtn.disabled = !loaded;
  els.speedBtn.textContent = `${player.rate}×`;
  els.loopBtn.classList.toggle('on', player.loop);
  els.loopBtn.setAttribute('aria-pressed', String(player.loop));
}

function renderStems() {
  for (const btn of els.stemButtons) {
    const id = btn.dataset.stem;
    btn.classList.toggle('selected', id === state.selected);
    btn.setAttribute('aria-pressed', String(id === state.selected));
    btn.disabled = id === 'original' ? !state.current : !state.stemsReady;
  }
  let text;
  if (!state.current) text = '上传后会自动分离音轨';
  else if (state.error) text = state.error;
  else if (state.separating) text = `正在分离音轨… ${Math.floor(state.progress * 100)}%（可以先播放原曲）`;
  else if (state.stemsReady) text = '音轨已就绪，点一下切换';
  else text = '';
  els.stemStatus.textContent = text;
  els.stemStatus.classList.toggle('busy', state.separating);
  els.stemStatus.style.setProperty('--p', `${Math.floor(state.progress * 100)}%`);
}

// ---------------------------------------------------------------------------
// Loading and separation
// ---------------------------------------------------------------------------

function kindOf(file) {
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  return /\.(mp4|m4v|mov|webm|mkv|3gp)$/i.test(file.name) ? 'video' : 'audio';
}

function decodeAudio(arrayBuffer) {
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Offline(2, 44100, 44100);
  return new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(arrayBuffer, resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });
}

// Phones get tighter memory limits for separation (see separationLimitMessage).
const isMobile = () => !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);

// Separated stems stay cached on their 音乐台 entry so re-opening a file is
// instant. Only the most recently used few are kept (see STEM_CACHE_LIMITS),
// and older ones are dropped before a new separation starts.
let useCounter = 0;

async function openEntry(entry) {
  if (state.abort) state.abort.abort();
  state.current = entry;
  entry.lastUsed = ++useCounter;
  state.stemsReady = false;
  state.separating = !entry.cache;
  state.progress = entry.cache ? 1 : 0;
  state.error = '';
  state.analysis = entry.cache ? entry.cache.analysis : null;
  state.selected = 'original';

  player.load(entry.file, entry.kind);
  player.setRate(settings.speed);
  player.setLoop(settings.loop);
  els.dropzone.hidden = true;
  els.mediaCard.hidden = false;
  els.mediaCard.classList.toggle('audio-only', entry.kind === 'audio');
  els.video.hidden = entry.kind !== 'video';
  els.audioArt.hidden = entry.kind === 'video';
  els.audioName.textContent = entry.name;
  renderStems();
  render();
  renderLibrary();

  if (entry.cache) {
    player.setStems(entry.cache.urls);
    state.stemsReady = true;
    renderStems();
    renderSheet();
    return;
  }

  const abort = new AbortController();
  state.abort = abort;
  const stillCurrent = () => state.current === entry && !abort.signal.aborted;
  const mobile = isMobile();
  try {
    const sizeMessage = separationLimitMessage({ bytes: entry.file.size, mobile });
    if (sizeMessage) throw new Error(sizeMessage);
    // The media element usually knows the duration within milliseconds, so a
    // long file is refused before it is read and decoded. Containers that
    // report no duration fall through to the check after decoding.
    const metaDuration = await waitForDuration(player.master, { signal: abort.signal });
    if (!stillCurrent()) return;
    const metaMessage = separationLimitMessage({ duration: metaDuration || null, mobile });
    if (metaMessage) throw new Error(metaMessage);
    evictStemCaches(state.entries, entry, { mobile, revoke: (u) => URL.revokeObjectURL(u) });
    const buf = await entry.file.arrayBuffer();
    if (!stillCurrent()) return;
    let audioBuffer;
    try {
      audioBuffer = await decodeAudio(buf);
    } catch {
      throw new Error('这个文件的音轨没法在浏览器里解码，原曲可以正常播放；想分离音轨请换成 MP4 / MP3 / WAV / M4A。');
    }
    if (!stillCurrent()) return;
    entry.duration = audioBuffer.duration;
    state.analysis = {
      duration: audioBuffer.duration,
      sampleRate: audioBuffer.sampleRate,
      channels: audioBuffer.numberOfChannels,
      bpm: null,
    };
    renderLibrary();
    renderSheet();
    const lengthMessage = separationLimitMessage({ duration: audioBuffer.duration, mobile });
    if (lengthMessage) throw new Error(lengthMessage);
    const { urls, bpm } = await runSeparation(audioBuffer, {
      encode: encodeWav,
      signal: abort.signal,
      onProgress: (p) => {
        if (!stillCurrent()) return;
        state.progress = p;
        renderStems();
      },
    });
    if (!stillCurrent()) {
      for (const u of Object.values(urls)) URL.revokeObjectURL(u);
      return;
    }
    player.setStems(urls);
    state.analysis.bpm = bpm;
    entry.cache = { urls, analysis: state.analysis };
    state.stemsReady = true;
    state.separating = false;
    state.progress = 1;
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    if (!stillCurrent()) return;
    state.separating = false;
    state.error = err && err.message ? err.message : '音轨分离失败';
    console.error(err);
  }
  renderStems();
  renderSheet();
}

function addFile(file) {
  if (!file) return;
  const entry = { id: state.nextId++, file, name: file.name, kind: kindOf(file), duration: 0 };
  state.entries.unshift(entry);
  showView('practice');
  openEntry(entry);
}

function pickFile() {
  els.fileInput.value = '';
  els.fileInput.click();
}

els.fileInput.addEventListener('change', () => addFile(els.fileInput.files[0]));
els.uploadBtn.addEventListener('click', pickFile);

// drag and drop on desktop: anywhere in the window
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('dragging');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const file = Array.from(e.dataTransfer?.files || []).find((f) => /^(video|audio)\//.test(f.type) || /\.(mp4|m4v|mov|webm|mkv|mp3|m4a|aac|wav|ogg|flac)$/i.test(f.name));
  if (file) addFile(file);
});

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function togglePlay() {
  if (!state.current) { pickFile(); return; }
  player.toggle();
}

els.playBtn.addEventListener('click', togglePlay);
els.ctlPlay.addEventListener('click', togglePlay);
els.stageTap.addEventListener('click', togglePlay);

function cycleSpeed() {
  const i = SPEEDS.indexOf(player.rate);
  player.setRate(SPEEDS[(i + 1) % SPEEDS.length]);
}
els.speedBtn.addEventListener('click', cycleSpeed);
els.loopBtn.addEventListener('click', () => player.setLoop(!player.loop));

function selectStem(id) {
  if (id !== 'original' && !state.stemsReady) return;
  if (!state.current) return;
  state.selected = id;
  player.select(id);
  renderStems();
}
for (const btn of els.stemButtons) btn.addEventListener('click', () => selectStem(btn.dataset.stem));

// progress bar: pointer events cover mouse, touch and pen
function ratioFromEvent(e) {
  const rect = els.progress.getBoundingClientRect();
  return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
}
els.progress.addEventListener('pointerdown', (e) => {
  if (!player.duration) return;
  els.progress.setPointerCapture(e.pointerId);
  scrubbing = ratioFromEvent(e);
  els.progress.classList.add('scrubbing');
  render();
});
els.progress.addEventListener('pointermove', (e) => {
  if (scrubbing == null) return;
  scrubbing = ratioFromEvent(e);
  render();
});
const endScrub = (e) => {
  if (scrubbing == null) return;
  if (e.type === 'pointerup') scrubbing = ratioFromEvent(e);
  player.seek(scrubbing * player.duration);
  scrubbing = null;
  els.progress.classList.remove('scrubbing');
  render();
};
els.progress.addEventListener('pointerup', endScrub);
els.progress.addEventListener('pointercancel', endScrub);
els.progress.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    e.stopPropagation();
    player.seek(player.currentTime + (e.key === 'ArrowLeft' ? -5 : 5));
  }
});

// keyboard shortcuts (desktop)
// Space toggles playback even when a button has focus, so stop the button's own activation.
window.addEventListener('keyup', (e) => {
  if ((e.key === ' ' || e.code === 'Space') && state.current && e.target && e.target.tagName === 'BUTTON') e.preventDefault();
}, true);
window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = (e.target && e.target.tagName) || '';
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(tag)) return;
  if (e.key === 'Escape') { closeSheet(); return; }
  if (!state.current) return;
  if (e.key === ' ' || e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    player.seek(player.currentTime - 5);
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    player.seek(player.currentTime + 5);
  } else if (/^[1-9]$/.test(e.key)) {
    selectStem(STEMS[Number(e.key) - 1].id);
  } else if (e.key === 'l' || e.key === 'L') {
    player.setLoop(!player.loop);
  }
});

// ---------------------------------------------------------------------------
// Tabs and 音乐台
// ---------------------------------------------------------------------------

function showView(name) {
  for (const v of els.views) {
    const on = v.dataset.view === name;
    v.hidden = !on;
    v.classList.toggle('active', on);
  }
  for (const t of els.tabs) {
    const on = t.dataset.tab === name;
    t.classList.toggle('active', on);
    if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  }
  window.scrollTo(0, 0);
}
for (const t of els.tabs) t.addEventListener('click', () => showView(t.dataset.tab));
for (const b of $$('[data-goto]')) b.addEventListener('click', () => showView(b.dataset.goto));

function renderLibrary() {
  els.libraryList.textContent = '';
  els.libraryEmpty.hidden = state.entries.length > 0;
  for (const entry of state.entries) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'library-item' + (entry === state.current ? ' current' : '');
    const icon = document.createElement('span');
    icon.className = 'library-icon';
    icon.textContent = entry.kind === 'video' ? '🎬' : '🎵';
    const text = document.createElement('span');
    text.className = 'library-text';
    const name = document.createElement('span');
    name.className = 'library-name';
    name.textContent = entry.name;
    const meta = document.createElement('span');
    meta.className = 'library-meta';
    meta.textContent = `${entry.kind === 'video' ? '视频' : '音频'} · ${entry.duration ? formatTime(entry.duration) : '读取中'}${entry === state.current ? ' · 正在练习' : ''}`;
    text.append(name, meta);
    btn.append(icon, text);
    btn.addEventListener('click', () => {
      showView('practice');
      if (entry !== state.current) openEntry(entry);
    });
    li.append(btn);
    els.libraryList.append(li);
  }
}

// ---------------------------------------------------------------------------
// 真实分析 sheet
// ---------------------------------------------------------------------------

function row(label, value) {
  const div = document.createElement('div');
  div.className = 'stat';
  const l = document.createElement('span');
  l.textContent = label;
  const v = document.createElement('strong');
  v.textContent = value;
  div.append(l, v);
  return div;
}

function renderSheet() {
  if (els.sheet.hidden) return;
  const body = els.sheetBody;
  body.textContent = '';
  if (!state.current) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = '先上传一个视频或音频，这里会显示时长、采样率、声道和估计的 BPM。';
    body.append(p);
    return;
  }
  const a = state.analysis;
  const pending = state.separating ? '读取中' : '未知';
  const stats = document.createElement('div');
  stats.className = 'stats';
  stats.append(
    row('文件', state.current.name),
    row('时长', a ? formatTime(a.duration) : player.duration ? formatTime(player.duration) : pending),
    row('采样率', a ? `${a.sampleRate} Hz` : pending),
    row('声道', a ? (a.channels > 1 ? `立体声（${a.channels}）` : '单声道') : pending),
    row('估计 BPM', a && a.bpm ? String(Math.round(a.bpm)) : state.separating ? '分析中…' : '未知'),
  );
  body.append(stats);

  const h = document.createElement('h4');
  h.textContent = '每条音轨是怎么来的';
  body.append(h);
  const list = document.createElement('ul');
  list.className = 'stem-notes';
  for (const s of STEMS) {
    const li = document.createElement('li');
    const b = document.createElement('b');
    b.textContent = s.label;
    li.append(b, document.createTextNode(`：${STEM_NOTES[s.id]}`));
    list.append(li);
  }
  body.append(list);

  const note = document.createElement('p');
  note.className = 'muted small';
  note.textContent = '说明：这些音轨是浏览器里用信号处理算法（中置声道提取、谐波/打击分离、滤波）近似拆出来的，不是 AI 模型，不同歌曲效果差别较大。'
    + (a && a.channels < 2 ? ' 当前文件是单声道，人声和伴奏只能按频段和音色粗分。' : '')
    + ' 所有处理都在你的设备上完成，文件不会上传。';
  body.append(note);
}

function openSheet() {
  els.sheet.hidden = false;
  els.sheetBackdrop.hidden = false;
  requestAnimationFrame(() => document.body.classList.add('sheet-open'));
  renderSheet();
  els.sheetClose.focus();
}
function closeSheet() {
  if (els.sheet.hidden) return;
  document.body.classList.remove('sheet-open');
  els.sheet.hidden = true;
  els.sheetBackdrop.hidden = true;
}
els.analysisLink.addEventListener('click', (e) => { e.preventDefault(); openSheet(); });
els.sheetClose.addEventListener('click', closeSheet);
els.sheetBackdrop.addEventListener('click', closeSheet);

renderStems();
renderLibrary();
render();
