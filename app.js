// ---------- IndexedDB layer ----------
const DB_NAME = 'shadowPracticeDB';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'session_id' });
      }
      if (!db.objectStoreNames.contains('progress')) {
        db.createObjectStore('progress', { keyPath: 'session_id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(storeName, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(storeName, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbGetAll(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(storeName, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- Client-side validation (mirrors the Phase 1 validator) ----------
function validateSession(json) {
  const errors = [];
  const required = ['session_id', 'title', 'source_audio', 'source_duration_sec', 'chunks'];
  for (const key of required) {
    if (!(key in json)) errors.push(`missing required field '${key}'`);
  }
  if (errors.length) return { ok: false, errors };

  const chunks = json.chunks;
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return { ok: false, errors: ['chunks must be a non-empty array'] };
  }

  const seenIds = new Set();
  let prevEnd = 0;
  let totalCovered = 0;

  chunks.forEach((c, i) => {
    if (c.id == null || c.start == null || c.end == null || c.index == null) {
      errors.push(`chunk at position ${i} is missing id/index/start/end`);
      return;
    }
    if (seenIds.has(c.id)) errors.push(`duplicate chunk id '${c.id}'`);
    seenIds.add(c.id);
    if (c.index !== i + 1) errors.push(`chunk '${c.id}' has index ${c.index}, expected ${i + 1}`);
    if (!c.text || !String(c.text).trim()) errors.push(`chunk '${c.id}' has empty text`);

    const dur = c.end - c.start;
    if (dur <= 0) { errors.push(`chunk '${c.id}' has non-positive duration`); return; }
    if (c.start < prevEnd - 0.01) errors.push(`chunk '${c.id}' overlaps the previous chunk`);
    prevEnd = c.end;
    totalCovered += dur;
  });

  if (prevEnd > json.source_duration_sec + 1.5) {
    errors.push(`last chunk ends at ${prevEnd.toFixed(2)}s, past the source duration`);
  }

  const coveragePct = json.source_duration_sec > 0 ? (totalCovered / json.source_duration_sec) * 100 : 0;
  return { ok: errors.length === 0, errors, coveragePct };
}

// ---------- App state ----------
let currentSession = null;
let currentProgress = null;
const audioEl = document.getElementById('audioEl');

function setPlaybackRate(rate) {
  audioEl.playbackRate = rate;
  // Force pitch preservation explicitly rather than trusting browser
  // defaults -- older WebKit/Safari versions defaulted this to false,
  // which would make slowed-down speech sound distorted/deepened rather
  // than naturally slower. Setting all three vendor variants is a
  // harmless no-op on browsers that don't need them.
  audioEl.preservesPitch = true;
  audioEl.mozPreservesPitch = true;
  audioEl.webkitPreservesPitch = true;
}

// ---------- View switching ----------
function showView(id) {
  ['libraryView', 'importView', 'practiceView'].forEach(v => {
    document.getElementById(v).classList.toggle('hidden', v !== id);
  });
}

// ---------- Library ----------
async function renderLibrary() {
  const sessions = await idbGetAll('sessions');
  const list = document.getElementById('libraryList');
  if (sessions.length === 0) {
    list.innerHTML = '<div class="empty">No sessions yet. Add your first audio to get started.</div>';
    return;
  }
  const progresses = await idbGetAll('progress');
  const progMap = Object.fromEntries(progresses.map(p => [p.session_id, p]));

  list.innerHTML = '';
  sessions.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  for (const s of sessions) {
    const prog = progMap[s.session_id];
    const done = prog ? prog.completed_ids.length : 0;
    const pct = Math.round((done / s.chunks.length) * 100);
    const row = document.createElement('button');
    row.className = 'row-tap';
    row.innerHTML = `
      <div class="row-meta">
        <h3>${escapeHtml(s.title)}</h3>
        <p>${s.chunks.length} chunks · ${done}/${s.chunks.length} done</p>
        <div class="row-track"><div style="width:${pct}%"></div></div>
      </div>
      <button class="row-del" data-del="${s.session_id}">Delete</button>
    `;
    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-del]')) return;
      openPractice(s.session_id);
    });
    row.querySelector('[data-del]').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm(`Delete "${s.title}"? This can't be undone.`)) {
        await idbDelete('sessions', s.session_id);
        await idbDelete('progress', s.session_id);
        renderLibrary();
      }
    });
    list.appendChild(row);
  }
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ---------- Import ----------
document.getElementById('showImportBtn').addEventListener('click', () => {
  document.getElementById('jsonInput').value = '';
  document.getElementById('audioInput').value = '';
  document.getElementById('jsonFileLabel').textContent = 'Choose file';
  document.getElementById('audioFileLabel').textContent = 'Choose file';
  document.getElementById('importErrors').textContent = '';
  document.getElementById('importOk').textContent = '';
  document.getElementById('confirmImportBtn').disabled = true;
  showView('importView');
});
document.getElementById('cancelImportBtn').addEventListener('click', () => showView('libraryView'));

let pendingJson = null, pendingAudioFile = null;

async function checkImportReady() {
  const errBox = document.getElementById('importErrors');
  const okBox = document.getElementById('importOk');
  errBox.textContent = ''; okBox.textContent = '';
  document.getElementById('confirmImportBtn').disabled = true;

  const jsonFile = document.getElementById('jsonInput').files[0];
  const audioFile = document.getElementById('audioInput').files[0];
  document.getElementById('jsonFileLabel').textContent = jsonFile ? jsonFile.name : 'Choose file';
  document.getElementById('audioFileLabel').textContent = audioFile ? audioFile.name : 'Choose file';
  if (!jsonFile || !audioFile) return;

  try {
    const text = await jsonFile.text();
    pendingJson = JSON.parse(text);
  } catch (e) {
    errBox.textContent = 'Could not parse the JSON file: ' + e.message;
    return;
  }
  pendingAudioFile = audioFile;

  const result = validateSession(pendingJson);
  if (!result.ok) {
    errBox.textContent = 'This session failed validation and cannot be imported:\n' + result.errors.join('\n');
    return;
  }

  const existing = await idbGet('sessions', pendingJson.session_id);
  const jsonBase = jsonFile.name.replace(/\.json$/i, '');
  const audioBase = audioFile.name.replace(/\.[^.]+$/, '');
  let warnMsg = `Looks good — ${pendingJson.chunks.length} chunks, ${result.coveragePct.toFixed(0)}% speech coverage.`;
  if (jsonBase !== audioBase) {
    warnMsg += `\nNote: filenames don't match ("${jsonFile.name}" / "${audioFile.name}") — make sure you picked the right pair.`;
  }
  if (existing) {
    warnMsg += `\nA session called "${existing.title}" already exists with this ID. Importing will update its audio/text but your existing progress on it will be kept, not reset.`;
  }
  okBox.textContent = warnMsg;
  document.getElementById('confirmImportBtn').disabled = false;
}
document.getElementById('jsonInput').addEventListener('change', checkImportReady);
document.getElementById('audioInput').addEventListener('change', checkImportReady);

document.getElementById('confirmImportBtn').addEventListener('click', async () => {
  if (!pendingJson || !pendingAudioFile) return;
  const record = {
    ...pendingJson,
    audioBlob: pendingAudioFile,
    addedAt: Date.now()
  };
  await idbPut('sessions', record);

  const existingProgress = await idbGet('progress', pendingJson.session_id);
  if (!existingProgress) {
    await idbPut('progress', {
      session_id: pendingJson.session_id,
      current_chunk_index: 0,
      completed_ids: [],
      last_opened: Date.now()
    });
  }
  // if progress already existed, it's left untouched -- re-importing the
  // same session must never silently reset how far the user got.

  showView('libraryView');
  renderLibrary();
});

// ---------- Practice ----------
async function openPractice(sessionId) {
  currentSession = await idbGet('sessions', sessionId);
  currentProgress = await idbGet('progress', sessionId);
  if (!currentSession) return;

  const url = URL.createObjectURL(currentSession.audioBlob);
  audioEl.src = url;
  setPlaybackRate(parseFloat(document.querySelector('#speedSegmented button.active').dataset.rate));
  showPlaybackStatus('');

  showView('practiceView');
  document.getElementById('backToLibraryBtn').classList.remove('hidden');
  document.getElementById('headerTitle').textContent = currentSession.title;
  renderChunk();
}

function renderWaveform() {
  const container = document.getElementById('waveform');
  const chunks = currentSession.chunks;
  const durations = chunks.map(c => c.end - c.start);
  const maxDur = Math.max(...durations);
  const minDur = Math.min(...durations);
  const span = Math.max(0.001, maxDur - minDur);
  const currentIdx = currentProgress.current_chunk_index;
  const completedSet = new Set(currentProgress.completed_ids);

  container.innerHTML = '';
  chunks.forEach((c, i) => {
    const dur = c.end - c.start;
    const heightPct = 28 + ((dur - minDur) / span) * 72;
    const tick = document.createElement('div');
    tick.className = 'tick';
    if (i === currentIdx) tick.classList.add('current');
    else if (completedSet.has(c.id)) tick.classList.add('done');
    tick.style.height = `${heightPct}%`;
    container.appendChild(tick);
  });
}

function renderChunk() {
  const idx = currentProgress.current_chunk_index;
  const chunk = currentSession.chunks[idx];
  document.getElementById('chunkText').textContent = chunk.text;
  document.getElementById('chunkPos').textContent =
    `chunk ${idx + 1} of ${currentSession.chunks.length} · ${currentProgress.completed_ids.length} done`;
  renderWaveform();

  document.getElementById('prevBtn').disabled = idx === 0;
  document.getElementById('nextBtn').textContent = idx === currentSession.chunks.length - 1 ? '✓' : '⏭';
}

async function saveProgress() {
  currentProgress.last_opened = Date.now();
  await idbPut('progress', currentProgress);
}

let activeStopHandler = null;

function stopPlayback() {
  audioEl.pause();
  if (activeStopHandler) {
    audioEl.removeEventListener('timeupdate', activeStopHandler);
    activeStopHandler = null;
  }
}

function showPlaybackStatus(msg, isError) {
  const el = document.getElementById('playbackStatus');
  el.textContent = msg || '';
  el.style.display = msg ? 'block' : 'none';
  el.style.color = isError ? 'var(--danger)' : 'var(--muted)';
}

audioEl.addEventListener('error', () => {
  const err = audioEl.error;
  const codeMap = {
    1: 'loading was aborted',
    2: 'a network error occurred',
    3: 'the audio could not be decoded -- the file may be corrupted',
    4: "this audio format/file isn't supported by this browser"
  };
  const reason = err ? (codeMap[err.code] || `error code ${err.code}`) : 'unknown error';
  showPlaybackStatus(`Couldn't load this audio: ${reason}. Try deleting and re-importing this session.`, true);
});

function playCurrentChunk() {
  stopPlayback();
  showPlaybackStatus('');
  const chunk = currentSession.chunks[currentProgress.current_chunk_index];

  // Call play() immediately and synchronously, inside the tap handler --
  // mobile browsers only honor a direct user gesture if play() isn't
  // deferred behind any async wait. Seeking is handled separately since
  // seeking mid-playback isn't gated by autoplay policy the way play() is.
  const playPromise = audioEl.play();
  if (playPromise && typeof playPromise.catch === 'function') {
    playPromise.catch((err) => {
      showPlaybackStatus(`Couldn't start playback: ${err.message}. Tap play again.`, true);
    });
  }

  if (audioEl.readyState >= 1) {
    audioEl.currentTime = chunk.start;
  } else {
    audioEl.addEventListener('loadedmetadata', () => {
      audioEl.currentTime = chunk.start;
    }, { once: true });
  }

  activeStopHandler = () => {
    if (audioEl.currentTime >= chunk.end) stopPlayback();
  };
  audioEl.addEventListener('timeupdate', activeStopHandler);
}

document.getElementById('playRepeatBtn').addEventListener('click', playCurrentChunk);

document.querySelectorAll('#speedSegmented button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#speedSegmented button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    setPlaybackRate(parseFloat(btn.dataset.rate));
  });
});

document.getElementById('nextBtn').addEventListener('click', async () => {
  stopPlayback();
  const idx = currentProgress.current_chunk_index;
  const chunkId = currentSession.chunks[idx].id;
  if (!currentProgress.completed_ids.includes(chunkId)) {
    currentProgress.completed_ids.push(chunkId);
  }
  if (idx < currentSession.chunks.length - 1) {
    currentProgress.current_chunk_index = idx + 1;
  }
  renderChunk();
  await saveProgress();
});

document.getElementById('prevBtn').addEventListener('click', async () => {
  stopPlayback();
  if (currentProgress.current_chunk_index > 0) {
    currentProgress.current_chunk_index -= 1;
    renderChunk();
    await saveProgress();
  }
});

document.getElementById('backToLibraryBtn').addEventListener('click', () => {
  stopPlayback();
  document.getElementById('backToLibraryBtn').classList.add('hidden');
  document.getElementById('headerTitle').textContent = 'Shadow Practice';
  showView('libraryView');
  renderLibrary();
});

// ---------- Boot ----------
(async () => {
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }
  renderLibrary();
})();
