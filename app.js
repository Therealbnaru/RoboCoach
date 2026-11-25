const byId = id => document.getElementById(id);
const [file, video, ink, empty, play, seek, time, pen, color, undo, clear, marks] =
  ['file','video','ink','empty','play','seek','time','pen','color','undo','clear','marks'].map(byId);
const context = ink.getContext('2d');
const drawings = new Map();
const notes = new Map();
const timeline = byId("timeline");
const noteDialog = byId("noteDialog");
const description = byId("description");
let noteTime;
function timestamps() {
  return [...new Set([...drawings.keys(), ...notes.keys()])].sort((a, b) => a - b);
}
function openNote(timestamp) {
  video.pause();
  noteTime = timestamp;
  byId("noteLabel").textContent = "What happened at " + format(timestamp) + "?";
  description.value = notes.get(timestamp) ?? "";
  noteDialog.showModal();
}
let url, active, drawing = false;

function format(seconds) {
  return Math.floor(seconds / 60) + ':' + (seconds % 60).toFixed(2).padStart(5, '0');
}
const frozenLiveFrame = byId('frozenLiveFrame');
const frozenDrawings = new Map();
const liveDrawings = new Map();
let drawingLive = false;
function visibleDrawings() {
  return drawingLive ? liveDrawings : frozenLiveFrame.hidden ? drawings : frozenDrawings;
}
function frame() {
  if (drawingLive || !frozenLiveFrame.hidden) return 0;
  return timestamps().find(t => Math.abs(t - video.currentTime) < 0.02) ?? video.currentTime;
}
function redraw() {
  context.clearRect(0, 0, ink.width, ink.height);
  const strokes = video.paused ? visibleDrawings().get(frame()) ?? [] : [];
  context.lineCap = context.lineJoin = 'round';
  context.lineWidth = Math.max(2, ink.width * 0.004);
  for (const stroke of strokes) {
    context.strokeStyle = context.fillStyle = stroke.color;
    context.beginPath();
    const first = stroke.points[0];
    if (stroke.points.length === 1) {
      context.arc(first.x * ink.width, first.y * ink.height, context.lineWidth / 2, 0, 2 * Math.PI);
      context.fill();
    } else {
      context.moveTo(first.x * ink.width, first.y * ink.height);
      for (const point of stroke.points.slice(1)) context.lineTo(point.x * ink.width, point.y * ink.height);
      context.stroke();
    }
  }
  undo.disabled = clear.disabled = !strokes.length;
}
function layout() {
  const frozen = !frozenLiveFrame.hidden;
  const surface = drawingLive ? liveTabVideo : frozen ? frozenLiveFrame : video;
  const nativeWidth = frozen ? surface.width : surface.videoWidth;
  const nativeHeight = frozen ? surface.height : surface.videoHeight;
  if (!nativeWidth || !nativeHeight || !surface.clientWidth || !surface.clientHeight) return;
  const scale = Math.min(surface.clientWidth / nativeWidth, surface.clientHeight / nativeHeight);
  const width = nativeWidth * scale, height = nativeHeight * scale;
  Object.assign(ink.style, {
    width: width + 'px', height: height + 'px',
    left: (surface.clientWidth - width) / 2 + 'px',
    top: (surface.clientHeight - height) / 2 + 'px'
  });
  ink.width = Math.round(width * devicePixelRatio);
  ink.height = Math.round(height * devicePixelRatio);
  redraw();
}
function updateMarks() {
  if (drawingLive || !frozenLiveFrame.hidden) return;
  marks.replaceChildren(new Option('Marked frames', ''));
  timeline.replaceChildren();
  for (const t of timestamps()) {
    marks.add(new Option(format(t), t));
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'marker';
    dot.style.left = (100 * t / (video.duration || 1)) + '%';
    dot.title = format(t) + (notes.has(t) ? ' — ' + notes.get(t) : ' — Drawing');
    dot.setAttribute('aria-label', dot.title);
    dot.onclick = () => {
      video.pause();
      video.currentTime = t;
      if (notes.has(t)) openNote(t);
    };
    timeline.append(dot);
  }
  marks.disabled = !timestamps().length;
}
const eraser = byId('eraser');
let erasing = false;
function setPen(on, erase = false) {
  drawing = on;
  erasing = erase;
  pen.setAttribute('aria-pressed', String(on && !erase));
  eraser.setAttribute('aria-pressed', String(erase));
  ink.classList.toggle('drawing', on);
  ink.classList.toggle('erasing', erase);
  if (on) video.pause();
}
const matchDragType = 'application/x-robocoach-match';
const libraryTree = byId('libraryTree');
const expanded = new Set(['Unfiled']);
let selectedFolder = 'Unfiled';
let switching = false;
let savedFolders = [], savedMatches = [];
const libraryStatus = byId('libraryStatus');
for (const type of ['dragover', 'drop']) {
  window.addEventListener(type, event => {
    if (event.dataTransfer.types.includes('Files')) event.preventDefault();
  });
}
let currentMatch;
const database = new Promise((resolve, reject) => {
  const request = indexedDB.open('RoboCoachLibrary', 2);
  request.onupgradeneeded = event => {
    request.result.createObjectStore('scouting', {keyPath: 'id'});
    if (event.oldVersion !== 0) return;
    request.result.createObjectStore('folders', {keyPath: 'name'});
    request.result.createObjectStore('matches', {keyPath: 'id'});
    request.result.createObjectStore('videos');
    request.result.createObjectStore('annotations');
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
function storageError(error) {
  libraryStatus.textContent = 'Could not save or open library data. Check browser storage and available space.';
  console.error(error);
}
async function read(store, operation, key) {
  const db = await database;
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store)[operation](key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function write(records) {
  const db = await database;
  return new Promise((resolve, reject) => {
    const tx = db.transaction([...new Set(records.map(record => record[0]))], 'readwrite');
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
    for (const [store, value, key] of records) {
      const target = tx.objectStore(store);
      if (value === undefined) {
        target.delete(key);
        continue;
      }
      if (key === undefined) target.put(value);
      else target.put(value, key);
    }
  });
}
let pendingSave = Promise.resolve();
let deletingVideo;
function saveAnnotations() {
  if (drawingLive) return;
  if (!frozenLiveFrame.hidden) return;
  if (!currentMatch || currentMatch.id === deletingVideo) return;
  const id = currentMatch.id;
  const review = structuredClone({drawings: [...drawings], notes: [...notes]});
  pendingSave = pendingSave.then(async () => {
    await write([['annotations', review, id]]);
    libraryStatus.textContent = 'Review saved in this browser.';
  }).catch(storageError);
}
function bindExplorerRow(row, activate, name, rename) {
  let clickTimer;
  row.onclick = event => {
    if (!rename || event.detail === 0) {
      activate();
      return;
    }
    clearTimeout(clickTimer);
    if (event.detail === 1) clickTimer = setTimeout(activate, 500);
  };
  if (!rename) return;
  function edit() {
    clearTimeout(clickTimer);
    const input = document.createElement('input');
    input.className = 'tree-rename';
    input.setAttribute('aria-label', 'Rename ' + name);
    input.value = name;
    row.replaceWith(input);
    input.focus();
    input.select();
    input.onkeydown = async event => {
      if (event.key === 'Escape') {
        input.replaceWith(row);
        row.focus();
        return;
      }
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const next = input.value.trim();
      if (!next || next === name) {
        input.replaceWith(row);
        row.focus();
        return;
      }
      input.disabled = true;
      try {
        await rename(next);
        await refreshLibrary();
      } catch (error) {
        libraryStatus.textContent = error.message || 'Could not rename this item.';
        input.disabled = false;
        input.focus();
      }
    };
  }
  row.ondblclick = edit;
  row.oncontextmenu = event => {
    event.preventDefault();
    edit();
  };
  row.onkeydown = event => {
    if (event.key === 'F2') {
      event.preventDefault();
      edit();
    }
  };
}
async function renameFolder(name, next) {
  if (name === 'Unfiled' && next === 'Unfiled') {
    await write([['folders', undefined, name]]);
    return;
  }
  if (next === 'Unfiled' || savedFolders.some(folder => folder.name === next || folder.label === next)) {
    throw new Error('A folder with that name already exists.');
  }
  if (name === 'Unfiled') {
    await write([['folders', {name, label: next}]]);
    return;
  }
  const matches = savedMatches.filter(match => match.folder === name);
  await write([
    ['folders', {name: next}],
    ['folders', undefined, name],
    ...matches.map(match => ['matches', {...match, folder: next}])
  ]);
  if (expanded.delete(name)) expanded.add(next);
  if (selectedFolder === name) selectedFolder = next;
  if (currentMatch?.folder === name) currentMatch.folder = next;
}
function folderLabel(name) {
  return savedFolders.find(folder => folder.name === name)?.label ?? name;
}
function renderLibrary() {
  libraryTree.replaceChildren();
  byId('saveFolder').textContent = 'Import into ' + folderLabel(selectedFolder);
  for (const name of ['Unfiled', ...savedFolders.filter(folder => folder.name !== 'Unfiled').map(folder => folder.name)]) {
    const open = expanded.has(name);
    const folder = document.createElement('button');
    folder.className = 'tree-folder';
    folder.setAttribute('aria-expanded', String(open));
    folder.dataset.selected = String(name === selectedFolder);
    folder.innerHTML = '<span class="chevron" aria-hidden="true"></span><span class="folder-icon" aria-hidden="true"></span><span></span>';
    folder.lastElementChild.textContent = folderLabel(name);
    bindExplorerRow(folder, () => {
      selectedFolder = name;
      if (open) expanded.delete(name);
      else expanded.add(name);
      renderLibrary();
      [...libraryTree.querySelectorAll('.tree-folder')].find(row => row.dataset.selected === 'true')?.focus();
    }, folderLabel(name), next => renameFolder(name, next));
    const heading = document.createElement('div');
    heading.className = 'folder-heading';
    heading.append(folder);
    bindFolderDrop(heading, name);
    if (name !== 'Unfiled') {
      const remove = document.createElement('button');
      remove.className = 'remove-folder';
      remove.textContent = '🗑';
      remove.title = remove.ariaLabel = 'Delete ' + folderLabel(name);
      remove.onclick = () => deleteFolder(name);
      heading.append(remove);
    }
    libraryTree.append(heading);
    if (!open) continue;
    const children = document.createElement('div');
    children.className = 'tree-children';
    for (const match of savedMatches.filter(item => item.folder === name)) {
      const row = document.createElement('button');
      row.className = 'tree-video';
      row.innerHTML = '<span class="video-icon" aria-hidden="true">▷</span><span></span>';
      row.lastElementChild.textContent = match.name;
      row.title = match.name;
      if (match.id === currentMatch?.id) row.setAttribute('aria-current', 'true');
      bindExplorerRow(row, () => openSavedMatch(match), match.name, async name => {
        await write([['matches', {...match, name}]]);
        if (currentMatch?.id === match.id) currentMatch.name = name;
      });
      row.draggable = true;
      row.addEventListener('dragstart', event => {
        event.dataTransfer.setData(matchDragType, match.id);
        event.dataTransfer.effectAllowed = 'move';
      });
      const videoRow = document.createElement('div');
      videoRow.className = 'video-row';
      const trash = document.createElement('button');
      trash.type = 'button';
      trash.className = 'remove-folder';
      trash.textContent = '🗑';
      trash.title = trash.ariaLabel = 'Delete ' + match.name;
      trash.onclick = () => deleteVideo(match);
      videoRow.append(row, trash);
      children.append(videoRow);
    }
    if (!children.childElementCount) children.textContent = 'No videos yet';
    libraryTree.append(children);
  }
}
async function refreshLibrary() {
  [savedFolders, savedMatches] = await Promise.all([
    read('folders', 'getAll'), read('matches', 'getAll')
  ]);
  renderLibrary();
}
refreshLibrary().catch(storageError);
byId('newFolder').onclick = () => {
  const form = byId('folderForm');
  form.hidden = !form.hidden;
  if (!form.hidden) byId('folderName').focus();
};
byId('folderName').onkeydown = event => {
  if (event.key === 'Escape') {
    byId('folderForm').hidden = true;
    byId('newFolder').focus();
  }
};
byId('folderForm').onsubmit = async event => {
  event.preventDefault();
  const input = byId('folderName');
  const name = input.value.trim();
  if (!name) return;
  try {
    if (savedFolders.some(folder => folder.label === name)) {
      libraryStatus.textContent = 'A folder with that name already exists.';
      return;
    }
    if (name !== 'Unfiled') await write([['folders', {name}]]);
    selectedFolder = name;
    expanded.add(name);
    await refreshLibrary();
    input.value = '';
    byId('folderForm').hidden = true;
    byId('newFolder').focus();
  } catch (error) { storageError(error); }
};
function loadMatch(match, blob, review) {
  stopYouTube();
  stopLiveTab();
  video.pause();
  if (url) URL.revokeObjectURL(url);
  currentMatch = match;
  drawings.clear();
  notes.clear();
  for (const [t, strokes] of review?.drawings ?? []) drawings.set(t, strokes);
  for (const [t, text] of review?.notes ?? []) notes.set(t, text);
  active = undefined;
  timeline.replaceChildren();
  marks.disabled = true;
  setPen(false);
  byId('note').disabled = play.disabled = seek.disabled = pen.disabled = eraser.disabled = true;
  empty.hidden = false;
  empty.textContent = 'Loading video…';
  context.clearRect(0, 0, ink.width, ink.height);
  url = URL.createObjectURL(blob);
  video.src = url;
  resetLiveScore();
}
async function changeMatch(action) {
  if (switching) return;
  switching = file.disabled = true;
  try {
    await action();
  } catch (error) { storageError(error); }
  finally {
    switching = file.disabled = false;
  }
}
function importVideos(blobs, folder) {
  return changeMatch(async () => {
    const matches = blobs.map(blob => ({
      id: crypto.randomUUID(), name: blob.name, folder
    }));
    await write(matches.flatMap((match, index) => [
      ['matches', match], ['videos', blobs[index], match.id]
    ]));
    selectedFolder = folder;
    expanded.add(folder);
    loadMatch(matches[0], blobs[0]);
    await refreshLibrary();
    libraryStatus.textContent = 'Imported ' + matches.length + ' video(s) into ' + folderLabel(folder) + '.';
  });
}
file.onchange = () => {
  const blobs = Array.from(file.files);
  file.value = '';
  if (blobs.length) importVideos(blobs, selectedFolder);
};
function deleteVideo(match) {
  if (switching || !confirm('Delete ' + match.name + ' and its saved drawings and notes?')) return;
  return changeMatch(async () => {
    deletingVideo = match.id;
    try {
      await pendingSave;
      await write([
        ['matches', undefined, match.id],
        ['videos', undefined, match.id],
        ['annotations', undefined, match.id]
      ]);
      if (currentMatch?.id === match.id) {
        video.pause();
        currentMatch = undefined;
        video.removeAttribute('src');
        video.load();
        URL.revokeObjectURL(url);
        url = undefined;
        drawings.clear();
        notes.clear();
        active = undefined;
        setPen(false);
        updateMarks();
        redraw();
        byId('note').disabled = play.disabled = seek.disabled = pen.disabled = eraser.disabled = true;
        seek.value = 0;
        time.value = '0:00 / 0:00';
        empty.hidden = false;
        empty.textContent = 'Open a match video to start.';
      }
      await refreshLibrary();
      libraryStatus.textContent = 'Deleted ' + match.name + '.';
    } finally {
      deletingVideo = undefined;
    }
  });
}
async function deleteFolder(name) {
  return changeMatch(async () => {
    const matches = savedMatches.filter(match => match.folder === name);
    await write([
      ['folders', undefined, name],
      ...matches.map(match => ['matches', {...match, folder: 'Unfiled'}])
    ]);
    if (currentMatch?.folder === name) currentMatch.folder = 'Unfiled';
    if (selectedFolder === name) selectedFolder = 'Unfiled';
    expanded.delete(name);
    expanded.add('Unfiled');
    await refreshLibrary();
    libraryStatus.textContent = matches.length
      ? 'Folder deleted. Videos moved to ' + folderLabel('Unfiled') + '.'
      : 'Folder deleted.';
  });
}
function bindFolderDrop(heading, name) {
  heading.ondragover = event => {
    const types = event.dataTransfer.types;
    if (!types.includes(matchDragType) && !types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = types.includes(matchDragType) ? 'move' : 'copy';
    heading.classList.add('drop-target');
  };
  heading.ondragleave = event => {
    if (!heading.contains(event.relatedTarget)) heading.classList.remove('drop-target');
  };
  heading.ondrop = event => {
    event.preventDefault();
    heading.classList.remove('drop-target');
    const id = event.dataTransfer.getData(matchDragType);
    const match = savedMatches.find(item => item.id === id);
    if (match && match.folder !== name) {
      return changeMatch(async () => {
        await write([['matches', {...match, folder: name}]]);
        if (currentMatch?.id === id) currentMatch.folder = name;
        selectedFolder = name;
        expanded.add(name);
        await refreshLibrary();
        libraryStatus.textContent = 'Video moved to ' + folderLabel(name) + '.';
      });
    }
    const blobs = Array.from(event.dataTransfer.files).filter(blob =>
      blob.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|ogv|mkv|avi)$/i.test(blob.name)
    );
    if (blobs.length) return importVideos(blobs, name);
    if (event.dataTransfer.files.length) libraryStatus.textContent = 'Drop a video file to import it.';
  };
}
function openSavedMatch(match) {
  const id = match.id;
  return changeMatch(async () => {
    const blob = await read('videos', 'get', id);
    await pendingSave;
    if (match.kind === 'live-frame') {
      openLiveFrame(match, await read('videos', 'get', id));
      return;
    }
    const review = await read('annotations', 'get', id);
    selectedFolder = match.folder;
    loadMatch(match, blob, review);
    renderLibrary();
  });
}
video.onloadedmetadata = () => {
  empty.hidden = true;
  byId("note").disabled = play.disabled = seek.disabled = pen.disabled = eraser.disabled = false;
  seek.max = video.duration;
  updateMarks();
  layout();
  sync();
};
video.onerror = () => {
  empty.hidden = false;
  empty.textContent = 'Could not open this video. Try an MP4 or WebM your browser supports.';
};
function sync() {
  seek.value = video.currentTime;
  time.value = format(video.currentTime) + ' / ' + format(video.duration || 0);
  play.textContent = video.paused ? 'Play' : 'Pause';
  redraw();
}
for (const event of ['timeupdate','play','pause','seeked','ended']) video.addEventListener(event, sync);
const reviewResize = new ResizeObserver(layout);
reviewResize.observe(video);
reviewResize.observe(frozenLiveFrame);

const videoReview = byId('videoReview');
const fullscreenReview = byId('fullscreenReview');
const fullscreenTools = document.createElement('button');
fullscreenTools.type = 'button';
fullscreenTools.className = 'fullscreen-tools-toggle';
fullscreenTools.textContent = 'Drawing tools';
fullscreenTools.setAttribute('aria-expanded', 'false');
fullscreenTools.onclick = () => {
  const open = videoReview.classList.toggle('fullscreen-tools-open');
  fullscreenTools.setAttribute('aria-expanded', String(open));
  if (!open) setPen(false);
};
fullscreenReview.before(fullscreenTools);
function setReviewExpanded(expanded) {
  videoReview.classList.toggle('review-expanded', expanded);
  videoReview.classList.remove('fullscreen-tools-open', 'fullscreen-score-open');
  fullscreenTools.setAttribute('aria-expanded', 'false');
  if (expanded) setPen(false);
  if (typeof scoreButton !== 'undefined') {
    scoreButton.textContent = expanded ? 'Score & models' : scorePanel.hidden ? 'Live score' : 'Hide live score';
    scoreButton.setAttribute('aria-expanded', String(!expanded && !scorePanel.hidden));
  }
  fullscreenReview.textContent = expanded ? 'Exit fullscreen' : 'Fullscreen';
  fullscreenReview.setAttribute('aria-pressed', String(expanded));
}
fullscreenReview.onclick = async () => {
  if (videoReview.classList.contains('review-expanded')) {
    if (document.fullscreenElement === videoReview) await document.exitFullscreen();
    else setReviewExpanded(false);
    return;
  }
  setReviewExpanded(true);
  try {
    if (videoReview.requestFullscreen) await videoReview.requestFullscreen();
  } catch {
    // Keep the viewport layout when the browser cannot enter native fullscreen.
  }
};
document.addEventListener('fullscreenchange', () => {
  setReviewExpanded(document.fullscreenElement === videoReview);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !document.fullscreenElement && !noteDialog.open &&
      videoReview.classList.contains('review-expanded')) setReviewExpanded(false);
});
play.onclick = async () => {
  if (video.paused) {
    setPen(false);
    try { await video.play(); }
    catch { byId('status').textContent = 'The browser could not play this video.'; }
  } else video.pause();
};
seek.oninput = () => { video.currentTime = Number(seek.value); };
pen.onclick = () => setPen(!drawing || erasing);
eraser.onclick = () => setPen(!erasing, !erasing);
marks.onchange = () => {
  if (marks.value === '') return;
  video.pause();
  video.currentTime = Number(marks.value);
  marks.value = '';
};
byId('note').onclick = () => openNote(frame());
byId('cancelNote').onclick = () => noteDialog.close();
byId('noteForm').onsubmit = event => {
  event.preventDefault();
  const text = description.value.trim();
  if (text) notes.set(noteTime, text);
  else notes.delete(noteTime);
  updateMarks();
  saveAnnotations();
  noteDialog.close();
};
function point(event) {
  const rect = ink.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
  };
}
function eraseAt(event, timestamp) {
  const bounds = ink.getBoundingClientRect();
  const x = event.clientX - bounds.left;
  const y = event.clientY - bounds.top;
  const strokes = visibleDrawings().get(timestamp);
  if (!strokes) return false;
  const remaining = strokes.filter(({points}) => !points.some((end, index) => {
    const start = points[Math.max(0, index - 1)];
    const ax = start.x * bounds.width;
    const ay = start.y * bounds.height;
    const dx = (end.x - start.x) * bounds.width;
    const dy = (end.y - start.y) * bounds.height;
    const length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length)) : 0;
    return Math.hypot(x - ax - t * dx, y - ay - t * dy) <= 12;
  }));
  if (remaining.length === strokes.length) return false;
  if (remaining.length) visibleDrawings().set(timestamp, remaining);
  else visibleDrawings().delete(timestamp);
  redraw();
  return true;
}
ink.onpointerdown = event => {
  if (!drawing || active || event.button !== 0) return;
  const timestamp = frame();
  if (erasing) {
    active = {id: event.pointerId, timestamp};
    ink.setPointerCapture(event.pointerId);
    if (eraseAt(event, timestamp)) {
      updateMarks();
      saveAnnotations();
    }
    return;
  }
  const strokes = visibleDrawings().get(timestamp) ?? [];
  const stroke = {color: color.value, points: [point(event)]};
  strokes.push(stroke);
  visibleDrawings().set(timestamp, strokes);
  active = {id: event.pointerId, stroke};
  ink.setPointerCapture(event.pointerId);
  redraw();
};
ink.onpointermove = event => {
  if (active?.id !== event.pointerId) return;
  if (!active.stroke) {
    if (eraseAt(event, active.timestamp)) {
      updateMarks();
      saveAnnotations();
    }
    return;
  }
  active.stroke.points.push(point(event));
  redraw();
};
ink.onlostpointercapture = event => {
  if (active?.id !== event.pointerId) return;
  const drew = Boolean(active.stroke);
  active = undefined;
  if (drew) {
    updateMarks();
    saveAnnotations();
  }
};
document.addEventListener('keydown', event => {
  if (byId('videoReview').hidden || undo.disabled || active ||
      event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey ||
      event.key.toLowerCase() !== 'z' ||
      event.target.closest('input, textarea, select, [contenteditable], dialog') ||
      (!liveTabVideo.hidden && !drawingLive) || !youtubeVideo.hidden || !video.paused) return;
  event.preventDefault();
  undo.click();
});
undo.onclick = () => {
  const timestamp = frame();
  const strokes = visibleDrawings().get(timestamp);
  strokes?.pop();
  if (!strokes?.length) visibleDrawings().delete(timestamp);
  updateMarks();
  saveAnnotations();
  redraw();
};
clear.onclick = () => {
  visibleDrawings().delete(frame());
  updateMarks();
  saveAnnotations();
  redraw();
};
const scoutForm = byId('scoutForm');
const scoutEvent = byId('scoutEvent');
const eventInput = scoutForm.elements.event;
const newEvent = byId('newScoutEvent');
const addEventValue = '__robocoach_new_event__';
eventInput.onchange = () => {
  newEvent.hidden = eventInput.value !== addEventValue;
  if (!newEvent.hidden) newEvent.focus();
};
function setEventOptions(names, selected) {
  const options = [...new Set([...names, selected].filter(name => name && name !== addEventValue))].sort();
  eventInput.replaceChildren(new Option('No event', ''), ...options.map(name => new Option(name)), new Option('Add new event…', addEventValue));
  eventInput.value = selected;
  newEvent.hidden = selected !== addEventValue;
}
setEventOptions([], '');
const scoutStatus = byId('scoutStatus');
let scoutingEntries = [];
let editingScoutId;
let scoutBusy = false;
const scoutControls = [...scoutForm.querySelectorAll('[name]')];

function showView(view) {
  if (view !== 'review') mountRoutePlanner(view);
  byId('videoReview').hidden = view !== 'review';
  byId('scouting').hidden = view !== 'scout';
  byId('profile').hidden = view !== 'profile';
  document.querySelector('main').classList.toggle('scouting-active', view !== 'review');
  document.querySelector('header .open').hidden = view !== 'review';
  for (const name of ['review', 'scout', 'profile']) {
    byId(name + 'View').setAttribute('aria-pressed', String(name === view));
  }
  if (view !== 'review') {
    video.pause();
    stopYouTube();
    stopLiveTab();
  }
  if (view === 'scout') {
    renderAutoChoices();
    refreshScouting().catch(reportScoutError);
    renderRouteTabs();
  }
}
for (const view of ['review', 'scout', 'profile']) {
  byId(view + 'View').onclick = () => showView(view);
}
const volume = byId('reviewVolume');
try {
  const savedVolume = localStorage.getItem('robocoach.volume');
  if (savedVolume !== null && Number.isFinite(Number(savedVolume))) {
    video.volume = Math.max(0, Math.min(100, Number(savedVolume))) / 100;
  }
} catch {}
volume.value = Math.round(video.volume * 100);
volume.oninput = () => {
  liveTabVideo.volume = Number(volume.value) / 100;
  if (liveTabStream?.getAudioTracks().length) liveTabVideo.muted = false;
  video.volume = Number(volume.value) / 100;
  try { localStorage.setItem('robocoach.volume', volume.value); } catch {}
};
video.addEventListener('volumechange', () => { volume.value = Math.round(video.volume * 100); });

const liveTabVideo = byId('liveTabVideo');
const shareLiveTab = byId('shareLiveTab');
const startLivePreview = byId('startLivePreview') ?? document.createElement('button');
async function playLivePreview(stream) {
  try {
    await liveTabVideo.play();
    if (liveTabStream !== stream) return;
    startLivePreview.hidden = true;
    reviewStatus.textContent = 'Live tab preview';
  } catch (error) {
    if (liveTabStream !== stream) return;
    console.error('Shared preview could not start:', error);
    startLivePreview.hidden = false;
    reviewStatus.textContent = 'Tab selected. Click Start preview to retry playback (' + error.name + ').';
  }
}
startLivePreview.onclick = () => {
  if (liveTabStream) playLivePreview(liveTabStream);
};
const reviewStatus = byId('status');
const reviewHint = reviewStatus.textContent;
let liveTabStream;
let liveRequest = 0;
const freezeLiveTab = byId('freezeLiveTab');
const scorePanel = byId('scorePanel');
const scoreButton = byId('liveScoreButton');
const scoreGoals = byId('scoreGoals');
let previousScore;
function makeScoreChoices(select, container, choices) {
  for (const [value, text, color] of choices) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'score-choice ' + color;
    button.textContent = text;
    button.dataset.value = value;
    button.setAttribute('aria-pressed', String(select.value === value));
    button.onclick = () => {
      select.value = value;
      refreshLiveScore();
    };
    container.append(button);
  }
}
for (const title of ['Left Toggle', 'Right Toggle', 'Top Toggle', 'Bottom Toggle', 'Midfield']) {
  const midfield = title === 'Midfield';
  const area = document.createElement('fieldset');
  area.className = 'score-area' + (midfield ? ' score-midfield' : '');
  const legend = document.createElement('legend');
  legend.textContent = title;
  area.append(legend);
  const rows = document.createElement('div');
  rows.className = 'score-counters';
  for (const [label, color, shape] of [
    ['Yellow halves', 'yellow', '◆'], ['Red halves', 'red', '●'], ['Blue halves', 'blue', '■'],
    ...(midfield ? [['Red robots', 'red', '▰'], ['Blue robots', 'blue', '▰']] : [])
  ]) {
    const row = document.createElement('div');
    row.className = 'score-counter ' + color;
    const name = document.createElement('label');
    const input = document.createElement('input');
    input.id = 'score-' + scoreGoals.childElementCount + '-' + color + (label.endsWith('robots') ? '-robots' : '');
    input.type = 'number';
    input.min = '0';
    input.step = '1';
    input.value = '0';
    input.inputMode = 'numeric';
    input.setAttribute('aria-label', title + ': ' + label);
    if (label.endsWith('robots')) input.max = '2';
    // Keep the scoring engine's original red, blue, yellow input order.
    input.dataset.scoreOrder = label === 'Red halves' ? 0 : label === 'Blue halves' ? 1 : label === 'Yellow halves' ? 2 : label === 'Red robots' ? 3 : 4;
    name.htmlFor = input.id;
    const icon = document.createElement('span');
    icon.className = 'score-pin';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = shape;
    name.append(icon, ' ', label);
    row.append(name);
    for (const [delta, text] of [[-1, '−'], [1, '+']]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'score-step';
      button.textContent = text;
      button.dataset.delta = delta;
      button.setAttribute('aria-label', (delta > 0 ? 'Add one ' : 'Remove one ') + label.toLowerCase() + ' in ' + title);
      button.onclick = () => {
        const current = Number(input.value) || 0;
        input.value = String(Math.max(0, Math.min(input.max ? Number(input.max) : Infinity, current + delta)));
        refreshLiveScore();
      };
      row.append(button);
      if (delta === -1) row.append(input);
    }
    input.onchange = () => {
      input.value = String(Math.max(0, Math.min(input.max ? Number(input.max) : Infinity, Math.round(Number(input.value) || 0))));
      refreshLiveScore();
    };
    rows.append(row);
  }
  area.append(rows);
  if (!midfield) {
    const label = document.createElement('span');
    label.className = 'score-owner-label';
    label.textContent = 'Toggle color';
    const select = document.createElement('select');
    select.hidden = true;
    select.setAttribute('aria-label', title + ' color');
    for (const [value, text] of [['', 'Neutral'], ['red', 'Red'], ['blue', 'Blue']]) select.add(new Option(text, value));
    const choices = document.createElement('div');
    choices.className = 'score-segments';
    choices.setAttribute('role', 'group');
    choices.setAttribute('aria-label', title + ' color');
    makeScoreChoices(select, choices, [['red', 'Red', 'red'], ['', 'Neutral', 'neutral'], ['blue', 'Blue', 'blue']]);
    area.append(label, select, choices);
  }
  scoreGoals.append(area);
}
for (const area of [...scoreGoals.children].slice(0,4)) {
  const label=document.createElement('label');
  label.className='quadrant-setting';label.hidden=true;
  label.textContent='Field quadrant color ';
  const select=document.createElement('select');select.className='quadrant-color';
  for (const [value,text] of [['','Choose red / blue'],['red','Red quadrant'],['blue','Blue quadrant']])
    select.add(new Option(text,value));
  select.setAttribute('aria-label',area.querySelector('legend').textContent+' field quadrant color');
  label.append(select);area.append(label);
}
for (const id of ['scoreMode','scorePhase']) byId(id).onchange=()=>{
  previousScore=undefined;byId('scoreChange').textContent='';refreshLiveScore();
  document.dispatchEvent(new Event('robocoach-scoring-mode'));
};
window.RoboCoachLiveScore={
  apply(areas) {
    const previous=new Map();
    for(const [index] of areas) {
      const area=scoreGoals.children[index];
      if(area)previous.set(index,Object.fromEntries(['red','blue','yellow'].map(color=>[color,Number(area.querySelector('#score-'+index+'-'+color).value)||0])));
    }
    for(const [index,counts] of areas) {
      const area=scoreGoals.children[index];
      if(!area)continue;
      for(const color of ['red','blue','yellow'])
        area.querySelector('#score-'+index+'-'+color).value=String(Math.max(0,Math.round(counts[color]||0)));
    }
    refreshLiveScore();
    return previous;
  }
};
makeScoreChoices(byId('scoreAuton'), byId('scoreAutonChoices'), [
  ['', 'None', 'neutral'], ['red', 'Red +12', 'red'], ['tie', 'Tie +6', 'neutral'], ['blue', 'Blue +12', 'blue']
]);
byId('resetScore').onclick = () => {
  if (confirm('Reset all scoring counts, Toggle colors and autonomous bonus? Active tracking will keep updating Toggle colors.')) resetLiveScore();
};
function calculateOverrideScore(areas, auton) {
  return OverrideScoring.calculate(areas, {auton,mode:byId('scoreMode').value,phase:byId('scorePhase').value});
}
function refreshLiveScore() {
  const skills = byId('scoreMode').value === 'skills';
  const robotInput = byId('score-4-red-robots');
  robotInput.max = skills ? '1' : '2';
  if (Number(robotInput.value) > Number(robotInput.max)) robotInput.value = robotInput.max;
  const areas = [...scoreGoals.children].map(area => ({
    counts: [...area.querySelectorAll('input')].sort((a, b) => Number(a.dataset.scoreOrder) - Number(b.dataset.scoreOrder)).map(input => input.validity.valid ? Number(input.value) || 0 : 0),
    toggle: area.querySelector('select')?.value,
    quadrant: area.querySelector('.quadrant-color')?.value
  }));
  const score = calculateOverrideScore(areas, byId('scoreAuton').value);
  byId('redScore').textContent = score.red;
  byId('blueScore').textContent = score.blue;
  byId('skillsScore').textContent = score.skills;
  byId('scoreTotal').hidden = skills;
  byId('skillsTotal').hidden = !skills;
  byId('scorePhase').parentElement.hidden = skills;
  byId('scoreAuton').parentElement.hidden = skills || byId('scorePhase').value === 'autonomous';
  for (const label of scoreGoals.querySelectorAll('.quadrant-setting')) label.hidden = !skills;
  const midfield = scoreGoals.lastElementChild;
  const redRobot = midfield.querySelector('#score-4-red-robots');
  const blueRobot = midfield.querySelector('#score-4-blue-robots');
  blueRobot.closest('.score-counter').hidden = skills;
  redRobot.closest('.score-counter').querySelector('label').lastChild.textContent = skills ? ' Robot in midfield' : ' Red robots';
  byId('scoreRulesHint').textContent = skills
    ? 'Skills: choose each quadrant’s field color. Matching colored halves score 5; owned yellow halves score 10; midfield robot scores 8. Unknown colors and unassigned areas are excluded.'
    : 'Match: red/blue halves score 5 for their alliance; owned yellow halves score 10. Robot points and midfield ownership apply to the projected final state, not autonomous.';

  for (const row of scoreGoals.querySelectorAll('.score-counter')) {
    const input = row.querySelector('input');
    const count = Number(input.value) || 0;
    row.querySelector('[data-delta="-1"]').disabled = count <= 0;
    row.querySelector('[data-delta="1"]').disabled = !!input.max && count >= Number(input.max);
  }
  for (const container of [...scoreGoals.children, byId('scoreAuton').parentElement]) {
    const select = container.querySelector('select');
    if (!select) continue;
    for (const button of container.querySelectorAll('.score-choice')) {
      button.setAttribute('aria-pressed', String(button.dataset.value === select.value));
    }
  }
  if (previousScore) {
    const red = score.red - previousScore.red, blue = score.blue - previousScore.blue;
    const signed = value => value > 0 ? '+' + value : String(value);
    if (byId('scoreMode').value === 'skills') {
      const delta = score.skills - previousScore.skills;
      if (delta) byId('scoreChange').textContent = 'Last change · Skills ' + signed(delta);
    } else if (red || blue) byId('scoreChange').textContent = 'Last change · Red ' + signed(red) + ' · Blue ' + signed(blue);
  }
  previousScore = score;
}
function showLiveScore(show) {
  scorePanel.hidden = !show;
  byId('videoReview').classList.toggle('scoring-active', show);
  scoreButton.textContent = show ? 'Hide live score' : 'Live score';
  scoreButton.setAttribute('aria-expanded', String(show));
  if (show) { refreshLiveScore(); checkToggleFrame(); }
}
function resetLiveScore() {
  scoreGoals.querySelectorAll('input[type="number"]').forEach(input => { input.value = '0'; });
  scoreGoals.querySelectorAll('select:not(.quadrant-color)').forEach(select => { select.value = ''; });
  byId('scoreAuton').value = '';
  byId('toggleTarget').selectedIndex = 0;
  if (typeof trackedToggles !== 'undefined') for (const anchor of trackedToggles.values()) { anchor.pendingColor = undefined; anchor.pendingCount = 0; }
  previousScore = undefined;
  byId('scoreChange').textContent = '';
  refreshLiveScore();
}
scoreButton.onclick = () => {
  if (videoReview.classList.contains('review-expanded')) {
    const open = videoReview.classList.toggle('fullscreen-score-open');
    if (open && scorePanel.hidden) showLiveScore(true);
    scoreButton.textContent = open ? 'Close score panel' : 'Score & models';
    scoreButton.setAttribute('aria-expanded', String(open));
  } else showLiveScore(scorePanel.hidden);
};
scorePanel.oninput = refreshLiveScore;
const trackedToggles = new Map();
const sampleCanvas = document.createElement('canvas');
sampleCanvas.width = sampleCanvas.height = 9;
const sampleContext = sampleCanvas.getContext('2d', {willReadFrequently: true});
const trackingStatus = byId('toggleTrackingStatus');
let pickToggleIndex;
function stopToggleTracking() {
  trackingGeneration++;
  trackedToggles.clear();
  debugDetections = [];
  drawToggleDebug();
  byId('clearToggles').disabled = true;
  pickToggleIndex = undefined;
  liveTabVideo.classList.remove('pick-toggle');
  video.classList.remove('pick-toggle');
  trackingStatus.textContent = '';
}
byId('clearToggles').onclick = stopToggleTracking;
function scoringVideo() {
  if (liveTabStream) return liveTabVideo.hidden ? null : liveTabVideo;
  return youtubeVideo.hidden && video.readyState >= 2 ? video : null;
}
byId('pickToggle').onclick = () => {
  const source = scoringVideo();
  if (!source || drawingLive || !frozenLiveFrame.hidden || source.readyState < 2) {
    trackingStatus.textContent = 'Open an uploaded video or return to the live feed, then exit drawing mode to pick a Toggle.';
    return;
  }
  setPen(false);
  pickToggleIndex = Number(byId('toggleTarget').value);
  byId('clearToggles').disabled = false;
  source.classList.add('pick-toggle');
  trackingStatus.textContent = 'Click the field-facing colored strip, even if a different color covers most of the visible Toggle.';
};
for (const source of [video, liveTabVideo]) source.addEventListener('click', event => {
  if (pickToggleIndex === undefined || source !== scoringVideo()) return;
  const bounds = source.getBoundingClientRect();
  const scale = Math.min(bounds.width / source.videoWidth, bounds.height / source.videoHeight);
  const width = source.videoWidth * scale, height = source.videoHeight * scale;
  const x = (event.clientX - bounds.left - (bounds.width - width) / 2) / width;
  const y = (event.clientY - bounds.top - (bounds.height - height) / 2) / height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;
  trackingGeneration++;
  const detection = debugDetections.filter(d => {
    const local = toggleFaceOffset(d, {x, y}, source.videoWidth, source.videoHeight);
    return Math.abs(local.u) <= .65 && Math.abs(local.v) <= .65;
  }).sort((a,b) => b.confidence-a.confidence)[0];
  if (toggleModel && !detection) {
    trackingStatus.textContent = 'Wait for a detection box over this Toggle, then click its field-facing strip inside the box.';
    return;
  }
  const anchor = detection
    ? {...detection, face: toggleFaceOffset(detection, {x, y}, source.videoWidth, source.videoHeight)}
    : {x, y};
  trackedToggles.set(pickToggleIndex, anchor);
  pickToggleIndex = undefined;
  source.classList.remove('pick-toggle');
  lastToggleScoreCheck = -Infinity;
  trackingStatus.textContent = trackedToggles.size + ' assigned · Reading the field-facing strip…';
  checkToggleFrame();
});
video.addEventListener('seeking', () => {
  trackingGeneration++;
  for (const anchor of trackedToggles.values()) { anchor.pendingColor = undefined; anchor.pendingCount = 0; }
  debugDetections = [];
  drawToggleDebug();
});
function toggleFaceOffset(box, point, width, height) {
  const dx = (point.x-box.x)*width, dy = (point.y-box.y)*height;
  const c = Math.cos(box.angle || 0), s = Math.sin(box.angle || 0);
  return {u:(c*dx+s*dy)/(box.width*width), v:(-s*dx+c*dy)/(box.height*height)};
}
function toggleFacePoint(box, face, width, height) {
  const dx=face.u*box.width*width, dy=face.v*box.height*height;
  const c=Math.cos(box.angle || 0), s=Math.sin(box.angle || 0);
  return {x:box.x+(c*dx-s*dy)/width, y:box.y+(s*dx+c*dy)/height};
}
function sampleToggleColor(x, y, source = liveTabVideo) {
  const width = source.videoWidth ?? source.width, height = source.videoHeight ?? source.height;
  const side = Math.min(3, width, height);
  sampleContext.drawImage(source, Math.max(0, Math.min(width - side, x * width - side / 2)),
    Math.max(0, Math.min(height - side, y * height - side / 2)), side, side, 0, 0, 9, 9);
  const pixels = sampleContext.getImageData(0, 0, 9, 9).data;
  const votes = {red: 0, blue: 0, neutral: 0};
  for (let i = 0; i < pixels.length; i += 4) {
    const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
    if (r > 90 && r > g * 1.35 && r > b * 1.35) votes.red++;
    else if (b > 90 && b > r * 1.35 && b > g * 1.12) votes.blue++;
    else if (r > 100 && g > 90 && Math.abs(r - g) < 65 && Math.min(r, g) > b * 1.4) votes.neutral++;
  }
  return Object.keys(votes).find(color => votes[color] >= 49);
}
let toggleModel;
let modelBusy = false;
const debugOverlay = byId('toggleDebugOverlay');
const toggleDevMode = byId('toggleDevMode');
let debugDetections = [];
toggleDevMode.onchange = () => {
  const enabled = toggleDevMode.checked;
  debugOverlay.hidden = !enabled;
  byId('toggleModelControls').hidden = !enabled;
  drawToggleDebug();
  if (enabled) checkToggleFrame();
};
function drawToggleDebug() {
  if (debugOverlay.hidden) return;
  const source = scoringVideo();
  if (!source) { debugOverlay.getContext('2d').clearRect(0, 0, debugOverlay.width, debugOverlay.height); return; }
  const width = source.clientWidth, height = source.clientHeight;
  if (!width || !height || !source.videoWidth || !source.videoHeight) return;
  const ratio = window.devicePixelRatio || 1;
  debugOverlay.width = Math.round(width * ratio);
  debugOverlay.height = Math.round(height * ratio);
  const context = debugOverlay.getContext('2d');
  context.scale(ratio, ratio);
  const scale = Math.min(width / source.videoWidth, height / source.videoHeight);
  const contentWidth = source.videoWidth * scale, contentHeight = source.videoHeight * scale;
  const offsetX = (width - contentWidth) / 2, offsetY = (height - contentHeight) / 2;
  context.font = '12px system-ui';
  context.lineWidth = 2;
  for (const detection of debugDetections) {
    const boxWidth = detection.width * contentWidth;
    const boxHeight = detection.height * contentHeight;
    const x = offsetX + detection.x * contentWidth - boxWidth / 2;
    const y = offsetY + detection.y * contentHeight - boxHeight / 2;
    const side = ['Left', 'Right', 'Top', 'Bottom'][detection.side] ?? 'Toggle';
    const label = side + ' · ' + Math.round(detection.confidence * 100) + '% · ' + (detection.color ?? (detection.side === undefined ? 'face not set' : 'unclear'));
    context.strokeStyle = '#b9f47e';
    context.save();
    context.translate(x + boxWidth / 2, y + boxHeight / 2);
    context.rotate(detection.angle ?? 0);
    context.strokeRect(-boxWidth / 2, -boxHeight / 2, boxWidth, boxHeight);
    context.restore();
    if (detection.sample) {
      context.beginPath();
      context.arc(offsetX+detection.sample.x*contentWidth, offsetY+detection.sample.y*contentHeight, 4, 0, Math.PI*2);
      context.fillStyle='#fff';
      context.fill();
      context.strokeStyle='#15191f';
      context.stroke();
    }
    const labelY = Math.max(0, y - 18);
    context.fillStyle = '#14191e';
    context.fillRect(x, labelY, context.measureText(label).width + 8, 18);
    context.fillStyle = '#fff';
    context.fillText(label, x + 4, labelY + 13);
  }
}
const scoreResize = new ResizeObserver(drawToggleDebug);
scoreResize.observe(liveTabVideo);
scoreResize.observe(video);
let trackingGeneration = 0;
const modelStatus = byId('toggleModelStatus');
const runtimeBase = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
let runtimeLoading;
function loadToggleRuntime() {
  if (window.ort) return Promise.resolve(window.ort);
  return runtimeLoading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = runtimeBase + 'ort.min.js';
    script.onload = () => resolve(window.ort);
    script.onerror = () => {
      runtimeLoading = undefined;
      script.remove();
      reject(new Error('Could not load the ONNX runtime.'));
    };
    document.head.append(script);
  });
}
// One shared ONNX inference supplies Toggle detections from vision-model.js.
const modelFrame = document.createElement('canvas');
let unifiedTogglePoints;
function associateTogglePoints(detections, anchors) {
  const found=new Map();
  found.detections=detections;
  for (const detection of detections) {
    const {x, y, confidence} = detection;
    if (confidence < .5) continue;
    let side, closest = .10;
    for (const [index, anchor] of anchors) {
      const distance = Math.hypot(x - anchor.x, y - anchor.y);
      if (distance < closest) { side = index; closest = distance; }
    }
    if (side !== undefined && confidence > (found.get(side)?.confidence ?? 0))
      found.set(side, {...detection, side});
    if (side !== undefined) detection.side = side;
  }
  return found;
}
window.RoboCoachVision={
  loaded(kind) {
    stopToggleTracking();
    toggleModel={unified:true,hasToggles:kind!=='pins-goals'};
    unifiedTogglePoints=undefined;
    debugOverlay.hidden=!toggleDevMode.checked;
    byId('toggleModelControls').hidden=!toggleDevMode.checked;
    trackingGeneration++;
    modelStatus.textContent=kind==='pins-goals'?'This model detects pins and goals only. Toggle color sampling remains available.':'Model loaded. Pick each Toggle’s field-facing strip to track ownership.';
    if(kind==='pins-goals')toggleModel=undefined;
  },
  clear() {
    unifiedTogglePoints=undefined;debugDetections=[];
    for(const anchor of trackedToggles.values()){anchor.pendingColor=undefined;anchor.pendingCount=0;}
    drawToggleDebug();
  },
  unload() {
    toggleModel=undefined;unifiedTogglePoints=undefined;trackingGeneration++;
    debugDetections=[];drawToggleDebug();modelStatus.textContent='No model loaded. Fixed-point color sampling is available.';
  },
  publish(detections) {
    if(!toggleModel)return;
    unifiedTogglePoints=associateTogglePoints(detections,trackedToggles);
    checkToggleFrame(true);
  }
};

// Rotated polygon overlap avoids drawing the raw model's duplicate candidates.
function suppressToggleDuplicates(candidates, width, height) {
  const cross = (a, b, p) => (b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]);
  const polygon = d => {
    const c = Math.cos(d.angle), s = Math.sin(d.angle);
    return [[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,y]) => {
      const dx = x*d.width*width/2, dy = y*d.height*height/2;
      return [d.x*width+c*dx-s*dy, d.y*height+s*dx+c*dy];
    });
  };
  const area = p => Math.abs(p.reduce((sum,a,i) => {
    const b = p[(i+1)%p.length]; return sum+a[0]*b[1]-b[0]*a[1];
  },0))/2;
  const overlap = (subject, clip) => {
    let result = subject;
    for (let i=0;i<clip.length && result.length;i++) {
      const a=clip[i], b=clip[(i+1)%clip.length], input=result;
      result=[];
      for (let j=0;j<input.length;j++) {
        const p=input[j], q=input[(j+1)%input.length];
        const dp=cross(a,b,p), dq=cross(a,b,q);
        if (dp>=0) result.push(p);
        if ((dp>=0)!==(dq>=0)) {
          const t=dp/(dp-dq);
          result.push([p[0]+t*(q[0]-p[0]),p[1]+t*(q[1]-p[1])]);
        }
      }
    }
    return area(result);
  };
  const kept=[];
  for (const d of candidates.sort((a,b)=>b.confidence-a.confidence).slice(0,200)) {
    const p=polygon(d), size=area(p);
    if (kept.some(k => { const intersection=overlap(p,k.p); return intersection/(size+k.size-intersection)>.45; })) continue;
    kept.push({d,p,size});
    if (kept.length===40) break;
  }
  return kept.map(k=>k.d);
}
let lastToggleScoreCheck = -Infinity;
async function checkToggleFrame(freshUnified = false) {
  if (toggleModel?.unified && freshUnified !== true) return;
  const source = scoringVideo();
  const preview = toggleDevMode.checked && !!toggleModel;
  if (modelBusy || (!trackedToggles.size && !preview) || scorePanel.hidden ||
      !source || source.readyState < 2 || source.seeking || document.hidden) return;
  const updateScore = performance.now() - lastToggleScoreCheck >= 1000;
  if (!preview && !updateScore) return;
  modelBusy = true;
  const generation = trackingGeneration;
  const model = toggleModel;
  let uncertain = 0;
  try {
    const points = model ? unifiedTogglePoints : trackedToggles;
    if (!points) return;
    if (generation !== trackingGeneration || scorePanel.hidden || source !== scoringVideo() || model !== toggleModel) return;
    debugDetections = model ? points.detections : [];
    for (const detection of debugDetections) detection.color = undefined;
    if (updateScore && trackedToggles.size) {
      lastToggleScoreCheck = performance.now();
      for (const [index, anchor] of trackedToggles) {
        const point = points.get(index);
        const sample = point && (model
          ? anchor.face && toggleFacePoint(point, anchor.face, source.videoWidth, source.videoHeight)
          : point);
        const color = sample && sample.x >= 0 && sample.x <= 1 && sample.y >= 0 && sample.y <= 1
          ? sampleToggleColor(sample.x, sample.y, model ? modelFrame : source) : undefined;
        const overlay = debugDetections.find(d => d.side === index);
        if (overlay) { overlay.sample = sample; overlay.color = color; }
        if (!color) { anchor.pendingColor = undefined; anchor.pendingCount = 0; uncertain++; continue; }
        anchor.pendingCount = anchor.pendingColor === color ? (anchor.pendingCount || 0)+1 : 1;
        anchor.pendingColor = color;
        // Two consecutive readings avoid changing ownership on a single noisy frame.
        if (anchor.pendingCount >= 2)
          scoreGoals.children[index].querySelector('select').value = color === 'neutral' ? '' : color;
      }
      refreshLiveScore();
    }
    drawToggleDebug();
    const previewStatus = preview
      ? debugDetections.length + ' Toggle detection(s) · Preview updates about every second. '
      : '';
    trackingStatus.textContent = previewStatus + (trackedToggles.size
      ? trackedToggles.size + ' assigned · Field-facing color checks every second; changes settle after two readings.' + (uncertain ? ' Unclear colors kept unchanged.' : '')
      : 'Pick on video to assign Left / Right / Top / Bottom. Preview alone does not change scores.');
  } catch (error) {
    if (generation === trackingGeneration) {
      debugDetections = [];
      drawToggleDebug();
      trackingStatus.textContent = 'Detection check failed: ' + String(error.message || error).slice(0,180);
    }
  } finally {
    modelBusy = false;
  }
}
setInterval(checkToggleFrame, 1000);
for (const source of [video, liveTabVideo])
  for (const event of ['loadeddata', 'seeked', 'pause', 'play'])
    source.addEventListener(event, checkToggleFrame);
const drawLiveTab = byId('drawLiveTab');
reviewResize.observe(liveTabVideo);
liveTabVideo.addEventListener('resize', layout);
function setLiveDrawing(enabled) {
  drawingLive = enabled;
  liveDrawings.clear();
  active = undefined;
  byId('videoReview').classList.toggle('live-drawing', enabled);
  drawLiveTab.setAttribute('aria-pressed', String(enabled));
  drawLiveTab.textContent = enabled ? 'Exit live drawing' : 'Draw live';
  pen.disabled = eraser.disabled = !enabled && video.readyState === 0;
  setPen(enabled);
  reviewStatus.textContent = enabled ? 'Live drawing · Marks clear when you exit.' : 'Live tab preview';
  layout();
}
drawLiveTab.onclick = () => {
  if (!liveTabVideo.videoWidth) {
    reviewStatus.textContent = 'Wait for the shared video to start before drawing.';
    return;
  }
  setLiveDrawing(!drawingLive);
};
const liveSourceLink = byId('liveSourceLink');
const savedLiveDialog = byId('savedLiveDialog');
const savedLiveImage = byId('savedLiveImage');
const saveLiveAnnotation = byId('saveLiveAnnotation');
const nameLiveAnnotation = byId('nameLiveAnnotation');
const liveAnnotationName = byId('liveAnnotationName');
const confirmLiveAnnotation = byId('confirmLiveAnnotation');
const liveAnnotationError = byId('liveAnnotationError');
saveLiveAnnotation.onclick = () => {
  liveAnnotationName.value = '';
  liveAnnotationError.textContent = '';
  byId('liveAnnotationFolder').textContent = 'Save to ' + folderLabel(selectedFolder);
  nameLiveAnnotation.showModal();
};
byId('cancelLiveAnnotation').onclick = () => nameLiveAnnotation.close();
nameLiveAnnotation.addEventListener('cancel', event => {
  if (confirmLiveAnnotation.disabled) event.preventDefault();
});
byId('saveLiveForm').onsubmit = async event => {
  event.preventDefault();
  const name = liveAnnotationName.value.trim();
  if (!name) {
    liveAnnotationError.textContent = 'Enter a name for this annotation.';
    return;
  }
  if (frozenLiveFrame.hidden) return;
  confirmLiveAnnotation.disabled = byId('cancelLiveAnnotation').disabled = true;
  liveAnnotationError.textContent = '';
  try {
    await saveLiveFrame(name, selectedFolder);
    nameLiveAnnotation.close();
  } catch {
    liveAnnotationError.textContent = 'Could not save the annotation. Try again.';
  } finally {
    confirmLiveAnnotation.disabled = byId('cancelLiveAnnotation').disabled = false;
  }
};
let savedLiveImageUrl;
function sourceVideoUrl(value) {
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}
async function saveLiveFrame(name, folder) {
  const id = crypto.randomUUID();
  const match = {id, kind: 'live-frame', source: sourceVideoUrl(liveSourceLink.value), folder, name};
  const width = frozenLiveFrame.width, height = frozenLiveFrame.height;
  const snapshot = document.createElement('canvas');
  snapshot.width = width;
  snapshot.height = height;
  const surface = snapshot.getContext('2d');
  surface.drawImage(frozenLiveFrame, 0, 0);
  if (ink.width && ink.height) surface.drawImage(ink, 0, 0, width, height);
  const blob = await new Promise(resolve => snapshot.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Could not save the annotated frame.');
  await write([['matches', match], ['videos', blob, id]]);
  expanded.add(folder);
  try {
    await refreshLibrary();
    libraryStatus.textContent = 'Saved ' + name + ' in ' + folderLabel(folder) + '.';
  } catch (error) {
    storageError(error);
  }
}
function openLiveFrame(match, blob) {
  if (!blob) throw new Error('Saved frame is unavailable.');
  if (savedLiveImageUrl) URL.revokeObjectURL(savedLiveImageUrl);
  savedLiveImageUrl = URL.createObjectURL(blob);
  savedLiveImage.src = savedLiveImageUrl;
  byId('savedLiveTitle').textContent = match.name;
  const link = byId('savedLiveSource');
  const source = sourceVideoUrl(match.source ?? '');
  link.hidden = !source;
  if (source) link.href = source;
  else link.removeAttribute('href');
  savedLiveDialog.showModal();
}
savedLiveDialog.onclose = () => {
  URL.revokeObjectURL(savedLiveImageUrl);
  savedLiveImageUrl = undefined;
  savedLiveImage.removeAttribute('src');
};

function returnToLive() {
  if (frozenLiveFrame.hidden) return;
  frozenLiveFrame.hidden = true;
  saveLiveAnnotation.hidden = true;
  if (nameLiveAnnotation.open) nameLiveAnnotation.close();
  liveTabVideo.hidden = false;
  frozenDrawings.clear();
  active = undefined;
  setPen(false);
  pen.disabled = eraser.disabled = video.readyState === 0;
  byId('videoReview').classList.remove('live-frozen');
  freezeLiveTab.textContent = 'Freeze & Annotate';
  drawLiveTab.hidden = false;
  reviewStatus.textContent = 'Live tab preview';
  layout();
}
freezeLiveTab.onclick = () => {
  if (!frozenLiveFrame.hidden) {
    returnToLive();
    return;
  }
  if (liveTabVideo.readyState < 2 || !liveTabVideo.videoWidth) {
    reviewStatus.textContent = 'Wait for the shared video to start before freezing a frame.';
    return;
  }
  if (drawingLive) setLiveDrawing(false);
  drawLiveTab.hidden = true;
  frozenLiveFrame.width = liveTabVideo.videoWidth;
  frozenLiveFrame.height = liveTabVideo.videoHeight;
  frozenLiveFrame.getContext('2d').drawImage(liveTabVideo, 0, 0);
  active = undefined;
  liveTabVideo.hidden = true;
  frozenLiveFrame.hidden = false;
  saveLiveAnnotation.hidden = false;
  byId('videoReview').classList.add('live-frozen');
  pen.disabled = eraser.disabled = false;
  setPen(true);
  freezeLiveTab.textContent = 'Back to live';
  reviewStatus.textContent = 'Frozen frame · Draw or erase, then go back to live.';
  layout();
};
function stopLiveTab(message = reviewHint) {
  returnToLive();
  if (drawingLive) setLiveDrawing(false);
  drawLiveTab.hidden = true;
  freezeLiveTab.hidden = true;
  scoreButton.hidden = false;
  showLiveScore(false);
  stopToggleTracking();
  liveSourceLink.hidden = true;
  liveRequest++;
  const stream = liveTabStream;
  liveTabStream = undefined;
  stream?.getTracks().forEach(track => track.stop());
  startLivePreview.hidden = true;
  liveTabVideo.srcObject = null;
  liveTabVideo.hidden = true;
  byId('videoReview').classList.remove('live-tab-active');
  shareLiveTab.textContent = 'Share live tab';
  shareLiveTab.disabled = false;
  if (stream || message !== reviewHint) reviewStatus.textContent = message;
}
const youtubeDialog = byId('youtubeDialog');
const youtubeVideo = byId('youtubeVideo');
const pauseYouTube = byId('pauseYouTube');
let youtubePlayer;
let youtubeApi;
let youtubeLoad = 0;
function getYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  return youtubeApi ??= new Promise((resolve, reject) => {
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = () => {
      youtubeApi = undefined;
      script.remove();
      reject(new Error('YouTube controls unavailable'));
    };
    document.head.append(script);
  });
}
pauseYouTube.onclick = () => youtubePlayer?.pauseVideo();
const youtubeLink = byId('youtubeLink');
function youtubeVideoId(value) {
  let url;
  try { url = new URL(value.trim()); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol)) return null;
  const [kind, id] = url.pathname.split('/').slice(1);
  let videoId;
  if (url.hostname === 'youtu.be') videoId = kind;
  else if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) {
    videoId = kind === 'watch' ? url.searchParams.get('v') :
      ['live', 'shorts', 'embed'].includes(kind) ? id : null;
  }
  return /^[A-Za-z0-9_-]{11}$/.test(videoId ?? '') ? videoId : null;
}
function stopYouTube() {
  if (youtubeVideo.hidden) return;
  youtubeLoad++;
  youtubePlayer = undefined;
  pauseYouTube.hidden = pauseYouTube.disabled = true;
  youtubeVideo.hidden = true;
  youtubeVideo.removeAttribute('src');
  byId('videoReview').classList.remove('youtube-active');
  byId('closeYouTube').hidden = true;
  reviewStatus.textContent = reviewHint;
}
byId('openYouTube').onclick = () => {
  byId('youtubeError').textContent = '';
  youtubeDialog.showModal();
};
byId('cancelYouTube').onclick = () => youtubeDialog.close();
byId('closeYouTube').onclick = stopYouTube;
byId('youtubeForm').onsubmit = event => {
  event.preventDefault();
  const id = youtubeVideoId(youtubeLink.value);
  if (!id) {
    byId('youtubeError').textContent = 'Enter a YouTube video or livestream link.';
    return;
  }
  stopLiveTab();
  video.pause();
  setPen(false);
  const load = ++youtubeLoad;
  youtubePlayer = undefined;
  pauseYouTube.hidden = false;
  pauseYouTube.disabled = true;
  youtubeVideo.src = 'https://www.youtube.com/embed/' + id +
    '?playsinline=1&enablejsapi=1&origin=' + encodeURIComponent(location.origin);
  getYouTubeApi().then(api => {
    if (load !== youtubeLoad) return;
    new api.Player(youtubeVideo, {
      events: {onReady(event) {
        if (load !== youtubeLoad) return;
        youtubePlayer = event.target;
        pauseYouTube.disabled = false;
      }}
    });
  }).catch(() => { /* The embedded player still has its own pause control. */ });
  youtubeVideo.hidden = false;
  byId('videoReview').classList.add('youtube-active');
  byId('closeYouTube').hidden = false;
  const link = document.createElement('a');
  link.href = 'https://www.youtube.com/watch?v=' + id;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'Open on YouTube';
  reviewStatus.replaceChildren('Playback unavailable here? ', link);
  youtubeDialog.close();
};
shareLiveTab.onclick = async () => {
  if (liveTabStream) {
    stopLiveTab();
    return;
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    reviewStatus.textContent = 'Tab sharing is unavailable here. Open RoboCoach in a desktop browser that supports screen sharing.';
    return;
  }
  const request = ++liveRequest;
  shareLiveTab.disabled = true;
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({video: true, audio: true, selfBrowserSurface: 'exclude'});
    if (request !== liveRequest) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    stopYouTube();
    liveTabStream = stream;
    stream.getVideoTracks()[0].addEventListener('ended', () => {
      if (liveTabStream === stream) stopLiveTab('The browser ended tab sharing. Select the source tab again.');
    }, {once: true});
    video.pause();
    setPen(false);
    liveTabVideo.volume = Number(volume.value) / 100;
    liveTabVideo.srcObject = stream;
    liveTabVideo.hidden = false;
    freezeLiveTab.hidden = false;
    scoreButton.hidden = false;
    resetLiveScore();
    drawLiveTab.hidden = false;
    liveSourceLink.hidden = false;
    byId('videoReview').classList.add('live-tab-active');
    shareLiveTab.textContent = 'Stop sharing';
    shareLiveTab.disabled = false;
    reviewStatus.textContent = 'Connecting to the shared tab…';
    liveTabVideo.muted = stream.getAudioTracks().length === 0;
    const waiting = setTimeout(() => {
      if (liveTabStream === stream && liveTabVideo.readyState < 2) {
        reviewStatus.textContent = 'Sharing is active, but the browser has not delivered a frame. Check that the source tab is playing, then try Start preview.';
        startLivePreview.hidden = false;
      }
    }, 5000);
    await playLivePreview(stream);
    clearTimeout(waiting);
  } catch (error) {
    if (request === liveRequest) {
      console.error('Live tab sharing failed:', error);
      const message = liveTabStream ? 'Could not play the shared feed' :
        error.name === 'NotAllowedError' ? 'Tab sharing was canceled or blocked' : 'Could not start tab sharing';
      stopLiveTab(message + (error.name ? ' (' + error.name + ').' : '.'));
    }
  } finally {
    if (request === liveRequest) shareLiveTab.disabled = false;
  }
};

const profileForm = byId('profileForm');
const profileStatus = byId('profileStatus');
let savedProfileRoutes;
try {
  const savedProfile = JSON.parse(localStorage.getItem('robocoach.profile') ?? '{}');
  savedProfileRoutes = savedProfile?.autonRoutes;
  for (const field of profileForm.querySelectorAll('[name]')) {
    if (typeof savedProfile?.[field.name] === 'string') field.value = savedProfile[field.name];
  }
} catch {
  profileStatus.textContent = 'Could not load the saved profile.';
}
profileForm.oninput = () => { profileStatus.textContent = 'Unsaved changes'; };
profileForm.onsubmit = event => {
  event.preventDefault();
  try {
    const profile = Object.fromEntries(new FormData(profileForm));
    profile.autonRoutes = plannerView === 'profile' ? scoutRoutes : plannerDrafts.profile.routes;
    localStorage.setItem('robocoach.profile', JSON.stringify(profile));
    savedProfileRoutes = structuredClone(profile.autonRoutes);
    profileStatus.textContent = 'Profile saved in this browser.';
  } catch {
    profileStatus.textContent = 'Could not save the profile. Check browser storage.';
  }
};
function updateScoutFields() {
  const pit = scoutForm.elements.kind.value === 'Pit interview';
  byId('matchFields').hidden = pit;
  scoutForm.elements.match.disabled = pit;
}
scoutForm.elements.kind.onchange = updateScoutFields;
updateScoutFields();
const autoFields = {autosWith: 'Autos to run with them', autosAgainst: 'Autos to run against them'};
function selectedAutos(id) {
  return [...byId(id).querySelectorAll('input:checked')].map(input => input.value);
}
function cleanAutos(value) {
  return Array.isArray(value) ? [...new Set(value.filter(item => typeof item === 'string' && item.trim()).map(item => item.slice(0, 128)))] : [];
}
function renderAutoChoices(entry) {
  const choices = normalizeScoutRoutes(savedProfileRoutes)
    .filter(route => route.name || route.color || route.strokes.length || route.file)
    .map(route => routeTitle(route));
  for (const id of Object.keys(autoFields)) {
    const picked = (entry ? cleanAutos(entry[id]) : selectedAutos(id)).map(title => {
      const name = title.replace(/ \(Route \d+\)$/, '');
      return choices.includes(name) ? name : title;
    });
    const group = byId(id);
    group.replaceChildren();
    const options = [...new Set([...choices, ...picked])];
    if (!options.length) group.textContent = 'Save an auto in Profile to choose it here.';
    for (const title of options) {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = title;
      box.checked = picked.includes(title);
      label.append(box, document.createTextNode(title));
      group.append(label);
    }
  }
}
function resetScoutForm() {
  editingScoutId = undefined;
  const {event, scout} = scoutForm.elements;
  const context = [event.value, scout.value];
  scoutForm.reset();
  renderAutoChoices({});
  setScoutRoutes();

  [event.value, scout.value] = context;
  newEvent.hidden = event.value !== addEventValue;
  updateScoutFields();
  byId('saveScout').textContent = 'Save entry';
  byId('resetScout').hidden = true;
}
byId('resetScout').onclick = resetScoutForm;
function reportScoutError(error) {
  scoutStatus.textContent = error.message || 'Could not update scouting entries.';
}
async function refreshScouting() {
  scoutingEntries = await read('scouting', 'getAll');
  const event = scoutEvent.value;
  const events = [...new Set(scoutingEntries.map(entry => entry.event).filter(Boolean))].sort();
  scoutEvent.replaceChildren(new Option('All events', ''), ...events.map(name => new Option(name)));
  scoutEvent.value = events.includes(event) ? event : '';
  setEventOptions(events, eventInput.value);
  renderScoutRows();
}
const ratingKeys = ['scoring', 'driving', 'autonomous', 'compatibility'];
function scoutRating(entry, key) {
  return entry[key] ?? (key === 'compatibility' && entry.fit ? String(Number(entry.fit) * 2) : '');
}
function average(entries, key) {
  const values = entries.map(entry => scoutRating(entry, key)).filter(value => value !== '' && value != null).map(Number);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}
const scoutResultPanel = byId('scoutResultPanel');
const scoutFullscreen = byId('scoutFullscreen');
function setResultsExpanded(expanded) {
  scoutResultPanel.classList.toggle('results-expanded', expanded);
  scoutFullscreen.textContent = expanded ? 'Exit fullscreen' : 'Fullscreen';
  scoutFullscreen.setAttribute('aria-pressed', String(expanded));
}
scoutFullscreen.onclick = async () => {
  if (scoutResultPanel.classList.contains('results-expanded')) {
    if (document.fullscreenElement === scoutResultPanel) await document.exitFullscreen();
    else setResultsExpanded(false);
    return;
  }
  setResultsExpanded(true);
  try {
    await scoutResultPanel.requestFullscreen?.();
  } catch {
    // Keep the full-window view when native fullscreen is unavailable.
  }
};
document.addEventListener('fullscreenchange', () => {
  if (scoutResultPanel.classList.contains('results-expanded')) {
    setResultsExpanded(document.fullscreenElement === scoutResultPanel);
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !document.fullscreenElement &&
      scoutResultPanel.classList.contains('results-expanded')) setResultsExpanded(false);
});
const scoutDataMenu = byId('scoutDataMenu');
scoutDataMenu.addEventListener('click', event => {
  const action = event.target.closest('.scout-data-options button, .scout-data-options a');
  if (!action) return;
  if (action.dataset.picker) byId(action.dataset.picker).click();
  scoutDataMenu.open = false;
  scoutDataMenu.querySelector('summary').focus();
});
document.addEventListener('click', event => {
  if (scoutDataMenu.open && !scoutDataMenu.contains(event.target)) scoutDataMenu.open = false;
});
const skillsStorageKey = 'robocoach.worldSkills';
let skillsRanks = new Map();
try {
  skillsRanks = new Map(JSON.parse(localStorage.getItem(skillsStorageKey) || '[]'));
} catch {}
function parseSkillsCsv(source) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') {
        field += '"';
        index++;
      } else quoted = !quoted;
    } else if (!quoted && char === ',') {
      row.push(field);
      field = '';
    } else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && source[index + 1] === '\n') index++;
      rows.push([...row, field]);
      row = [];
      field = '';
    } else field += char;
  }
  if (quoted) throw new Error('The CSV contains an unfinished quoted field.');
  if (row.length || field) rows.push([...row, field]);
  const header = rows.shift()?.map(value => value.trim().toLowerCase()) ?? [];
  const rankColumn = header.indexOf('rank');
  const scoreColumn = header.indexOf('score');
  const drivingColumn = header.indexOf('driver skills');
  const programmingColumn = header.indexOf('autonomous coding skills');
  function readScore(cells, column) {
    const value = cells[column]?.trim();
    return value && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  }
  const teamColumn = header.indexOf('team number');
  if (rankColumn < 0 || teamColumn < 0) throw new Error('Choose a VEX World Skills CSV with Rank and Team Number columns.');
  const ranks = new Map();
  for (const cells of rows) {
    const team = cells[teamColumn]?.trim().toUpperCase();
    const rank = Number(cells[rankColumn]);
    if (team && Number.isSafeInteger(rank) && rank > 0) {
      const score = readScore(cells, scoreColumn);
      if (ranks.has(team) && ranks.get(team).rank !== rank) throw new Error('The CSV lists different ranks for ' + team + '.');
      const previous = ranks.get(team);
      ranks.set(team, {
        rank, score: score ?? previous?.score ?? null,
        driving: readScore(cells, drivingColumn) ?? previous?.driving ?? null,
        programming: readScore(cells, programmingColumn) ?? previous?.programming ?? null
      });
    }
  }
  if (!ranks.size) throw new Error('No ranked teams found in this CSV.');
  return ranks;
}
byId('importSkills').onchange = async event => {
  const input = event.target;
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  try {
    const ranks = parseSkillsCsv(await file.text());
    localStorage.setItem(skillsStorageKey, JSON.stringify([...ranks]));
    skillsRanks = ranks;
    renderScoutRows();
    scoutStatus.textContent = 'Imported World Skills ranks for ' + ranks.size + ' teams.';
  } catch (error) { reportScoutError(error); }
};
function renderScoutRows() {
  const teams = new Map();
  for (const entry of scoutingEntries) {
    if (scoutEvent.value && entry.event !== scoutEvent.value) continue;
    if (!teams.has(entry.team)) teams.set(entry.team, []);
    teams.get(entry.team).push(entry);
  }
  const rows = [...teams].map(([team, entries]) => {
    const skills = skillsRanks.get(team.trim().toUpperCase());
    return {
      team, entries,
      skillsRank: typeof skills === 'number' ? skills : skills?.rank,
      skillsScore: skills?.score == null ? '—' : String(skills.score) +
        (skills.driving == null && skills.programming == null ? '' :
          ' (' + (skills.driving ?? '—') + ' driving, ' + (skills.programming ?? '—') + ' programming)'),
      ...Object.fromEntries(ratingKeys.map(key => [key, average(entries, key)]))
    };
  });
  const sort = byId('scoutSort').value;
  rows.sort((a, b) => {
    if (sort === 'skillsRank' && a.skillsRank !== b.skillsRank) {
      return (a.skillsRank ?? Infinity) - (b.skillsRank ?? Infinity);
    }
    const delta = sort === 'team' ? 0 : (b[sort] ?? -1) - (a[sort] ?? -1);
    return delta || a.team.localeCompare(b.team, undefined, {numeric: true});
  });
  const body = byId('scoutRows');
  body.replaceChildren();
  if (!rows.length) {
    const cell = body.insertRow().insertCell();
    cell.colSpan = 8;
    cell.textContent = 'No scouting entries yet.';
  }
  for (const {team, entries, ...ratings} of rows) {
    const row = body.insertRow();
    for (const value of [team, ...ratingKeys.map(key => ratings[key]?.toFixed(1) ?? '—'), ratings.skillsRank ? '#' + ratings.skillsRank : '—', ratings.skillsScore ?? '—']) {
      row.insertCell().textContent = value;
    }
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    const history = scoutingEntries.filter(entry => entry.team === team)
      .sort((a, b) => (a.event ?? '').localeCompare(b.event ?? ''));
    summary.textContent = history.length + (history.length === 1 ? ' entry across all events' : ' entries across all events');
    details.append(summary);
    const openScout = document.createElement('a');
    openScout.href = 'https://openscout.ing/teams/V5RC/' + encodeURIComponent(team);
    openScout.target = '_blank';
    openScout.rel = 'noopener noreferrer';
    openScout.style.color = '#83b7e5';
    openScout.textContent = 'View team stats on OpenScout';
    details.append(openScout);
    let lastEvent;
    for (const entry of history) {
      const eventName = entry.event || 'No event';
      if (eventName !== lastEvent) {
        const heading = document.createElement('h3');
        heading.textContent = eventName;
        details.append(heading);
        lastEvent = eventName;
      }
      const info = document.createElement('p');
      const fields = scoutControls.filter(control => control.name !== 'team' && scoutRating(entry, control.name));
      info.textContent = fields.map(control => control.labels[0].firstChild.textContent.trim() + ': ' + scoutRating(entry, control.name)).join('\n');
      const edit = document.createElement('button');
      edit.textContent = 'Edit entry';
      edit.onclick = () => {
        editingScoutId = entry.id;
        setScoutRoutes(entry.autonRoutes);
        renderAutoChoices(entry);

        for (const control of scoutControls) control.value = scoutRating(entry, control.name);
        newEvent.hidden = true;
        updateScoutFields();
        byId('saveScout').textContent = 'Update entry';
        byId('resetScout').hidden = false;
        scoutForm.elements.team.focus();
      };
      details.append(info);
      for (const [id, title] of Object.entries(autoFields)) {
        const picked = cleanAutos(entry[id]);
        if (!picked.length) continue;
        const line = document.createElement('p');
        line.textContent = title + ': ' + picked.join(', ');
        details.append(line);
      }
      if (entry.route?.length) {
        const preview = document.createElement('canvas');
        preview.width = preview.height = 720;
        preview.className = 'route-preview';
        preview.setAttribute('aria-label', 'Saved field route');
        drawField(preview, entry.route);
        details.append(preview);
      }
      for (const savedRoute of entry.autonRoutes ?? []) {
        if (!savedRoute.name && !savedRoute.color && !savedRoute.file && !savedRoute.strokes?.length) continue;
        const item = document.createElement('p');
        item.textContent = routeTitle(savedRoute);
        if (savedRoute.file) {
          const download = document.createElement('button');
          download.textContent = 'Download route';
          download.onclick = () => downloadRouteFile(savedRoute.file);
          item.append(' ', download);
        }
        details.append(item);
        if (savedRoute.strokes?.length) {
          const preview = document.createElement('div');
          preview.className = 'scout-field route-preview';
          const field = document.querySelector('.scout-field img').cloneNode();
          const overlay = document.createElement('canvas');
          overlay.width = overlay.height = 400;
          overlay.style.pointerEvents = 'none';
          preview.append(field, overlay);
          drawField(overlay, savedRoute.strokes, true);
          details.append(preview);
        }
      }
      const remove = document.createElement('button');
      remove.textContent = 'Delete entry';
      remove.onclick = async () => {
        if (scoutBusy || !confirm('Delete this scouting entry for ' + entry.team + '?')) return;
        scoutBusy = true;
        try {
          await write([['scouting', undefined, entry.id]]);
          if (editingScoutId === entry.id) resetScoutForm();
          await refreshScouting();
          scoutStatus.textContent = 'Deleted entry for ' + entry.team + '.';
        } catch (error) { reportScoutError(error); }
        finally { scoutBusy = false; }
      };
      details.append(edit, ' ', remove);
    }
    row.insertCell().append(details);
  }
}
scoutEvent.onchange = byId('scoutSort').onchange = renderScoutRows;
async function saveScoutEntries(entries, message) {
  if (scoutBusy) return false;
  scoutBusy = true;
  try {
    if (entries.length) await write(entries.map(entry => ['scouting', entry]));
    await refreshScouting();
    scoutStatus.textContent = message;
    return true;
  } catch (error) {
    reportScoutError(error);
    return false;
  } finally {
    scoutBusy = false;
  }
}
scoutForm.onsubmit = async event => {
  event.preventDefault();
  const entry = Object.fromEntries([...new FormData(scoutForm)].map(([key, value]) => [key, value.trim()]));
  if (entry.event === addEventValue) {
    entry.event = newEvent.value.trim();
    if (!entry.event || entry.event === addEventValue) {
      scoutStatus.textContent = 'Enter a name for the new event.';
      newEvent.focus();
      return;
    }
  }
  entry.team = entry.team.toUpperCase();
  if (!entry.team) {
    scoutStatus.textContent = 'Enter a team number.';
    return;
  }
  const previous = scoutingEntries.find(item => item.id === editingScoutId);
  entry.autonRoutes = structuredClone(scoutRoutes);
  for (const id of Object.keys(autoFields)) entry[id] = selectedAutos(id);
  entry.id = editingScoutId ?? crypto.randomUUID();
    if (await saveScoutEntries([{...previous, ...entry, match: entry.match ?? ''}], 'Saved entry for ' + entry.team + '.')) {
    eventInput.value = entry.event;
    newEvent.value = '';
    resetScoutForm();
  }
};
byId('exportScout').onclick = async () => {
  try {
    const entries = await read('scouting', 'getAll');
    const objectUrl = URL.createObjectURL(new Blob([JSON.stringify({version: 1, entries}, null, 2)], {type: 'application/json'}));
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = 'robocoach-scouting.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  } catch (error) { reportScoutError(error); }
};
byId('importScout').onchange = async event => {
  const input = event.target;
  const source = input.files[0];
  input.value = '';
  if (!source) return;
  try {
    const data = JSON.parse(await source.text());
    if (data.version !== 1 || !Array.isArray(data.entries)) throw new Error('Choose a RoboCoach scouting export.');
    const ids = new Set((await read('scouting', 'getAll')).map(entry => entry.id));
    const entries = [];
    for (const item of data.entries) {
      if (!item || typeof item.id !== 'string' || !item.id || typeof item.team !== 'string' || !item.team.trim() ||
          !['Match observation', 'Pit interview'].includes(item.kind)) throw new Error('The export contains an invalid scouting entry.');
      if (ids.has(item.id)) continue;
      ids.add(item.id);
      const entry = {id: item.id};
      for (const key of ['fit','points','partner','result','alliance','short','tall','yellow','toggles','loads','midfield','backup','attempts','claim','auton','driver','role']) {
        if (typeof item[key] === 'string') entry[key] = item[key];
      }
      if (!/^[1-5]$/.test(entry.fit ?? '')) delete entry.fit;
      for (const control of scoutControls) {
        const value = item[control.name];
        if (typeof value !== 'string') continue;
        if (control.type === 'number' && value !== '' && (!Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 10)) continue;
        if (control.tagName === 'SELECT' && control.name !== 'event' && ![...control.options].some(option => option.value === value)) continue;
        entry[control.name] = value.trim();
      }
      entry.team = item.team.trim().toUpperCase();
      if (entry.kind === 'Pit interview') delete entry.points;
      entry.route = validateRoute(item.route);
      entry.autonRoutes = normalizeScoutRoutes(item.autonRoutes);
      for (const id of Object.keys(autoFields)) entry[id] = cleanAutos(item[id]);
      entries.push(entry);
    }
    await saveScoutEntries(entries, 'Imported ' + entries.length + ' new entries.');
  } catch (error) { reportScoutError(error); }
};
let scoutRoutes = normalizeScoutRoutes();
let selectedRoute = 0;
let routeHistory = scoutRoutes.map(() => []);
let plannerView = 'scout';
const profileRoutes = normalizeScoutRoutes(savedProfileRoutes);
const plannerDrafts = {
  profile: {routes: profileRoutes, selected: 0, history: profileRoutes.map(() => [])}
};
function mountRoutePlanner(view) {
  if (view === plannerView) return;
  plannerDrafts[plannerView] = {routes: scoutRoutes, selected: selectedRoute, history: routeHistory};
  const draft = plannerDrafts[view];
  scoutRoutes = draft.routes;
  selectedRoute = draft.selected;
  routeHistory = draft.history;
  plannerView = view;
  routeGesture = undefined;
  byId(view === 'profile' ? 'profileWorkspace' : 'scoutWorkspace').append(byId('scoutPlanner'));
  byId('plannerSaveHint').textContent = view === 'profile' ? 'Save your profile to keep your routes.' : 'Save the scouting entry to keep your routes.';
  renderRouteTabs();
}
function markRouteChanged() {
  if (plannerView === 'profile') profileStatus.textContent = 'Unsaved changes';
}
const scoutField = byId('scoutField');
let routeGesture;
let routeTool = 'draw';
for (const [id, tool] of [['routeDraw', 'draw'], ['routeMove', 'move']]) {
  byId(id).onclick = () => {
    routeTool = tool;
    scoutField.dataset.tool = tool;
    byId('routeDraw').setAttribute('aria-pressed', String(tool === 'draw'));
    byId('routeMove').setAttribute('aria-pressed', String(tool === 'move'));
  };
}
const routeName = byId('routeName');
const routeAlliance = byId('routeAlliance');

function normalizeScoutRoutes(value) {
  const count = Array.isArray(value) ? Math.max(3, value.length) : 3;
  return Array.from({length: count}, (_, index) => {
    const item = value?.[index];
    const file = item?.file;
    return {
      number: index + 1,
      name: typeof item?.name === 'string' ? item.name.trim().slice(0, 80) : '',
      color: ['red', 'blue'].includes(item?.color) ? item.color : '',
      strokes: validateRoute(item?.strokes),
      file: typeof file?.name === 'string' && typeof file?.data === 'string' &&
        file.data.length <= 3000000 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data)
        ? {name: file.name, data: file.data} : null
    };
  });
}
function routeTitle(item) {
  return [item.color, item.name || 'Route ' + item.number].filter(Boolean).join(' ');
}
function renderRouteTabs() {
  const tabs = byId('routeTabs');
  while (tabs.childElementCount > scoutRoutes.length) tabs.lastElementChild.remove();
  for (let index = tabs.childElementCount; index < scoutRoutes.length; index++) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.onclick = () => { selectedRoute = index; renderRouteTabs(); };
    tabs.append(tab);
  }
  scoutRoutes.forEach((item, index) => {
    const tab = tabs.children[index];
    tab.textContent = routeTitle(item);
    tab.setAttribute('aria-pressed', String(index === selectedRoute));
  });
  const item = scoutRoutes[selectedRoute];
  if (document.activeElement !== routeName) routeName.value = item.name;
  routeAlliance.value = item.color;
  byId('downloadRoute').hidden = !item.file;
  paintScoutRoute();
}
byId('addScoutRoute').onclick = () => {
  selectedRoute = scoutRoutes.length;
  scoutRoutes.push({number: selectedRoute + 1, name: '', color: '', strokes: [], file: null});
  routeHistory.push([]);
  markRouteChanged();
  renderRouteTabs();
  routeName.focus();
};
function setScoutRoutes(value) {
  const routes = normalizeScoutRoutes(value);
  const history = routes.map(() => []);
  if (plannerView !== 'scout') {
    plannerDrafts.scout = {routes, selected: 0, history};
    return;
  }
  scoutRoutes = routes;
  routeHistory = history;
  selectedRoute = 0;
  routeGesture = undefined;
  renderRouteTabs();
}
routeName.oninput = () => {
  scoutRoutes[selectedRoute].name = routeName.value.trim();
  markRouteChanged();
  renderRouteTabs();
};
routeAlliance.onchange = () => {
  scoutRoutes[selectedRoute].color = routeAlliance.value;
  markRouteChanged();
  renderRouteTabs();
};
function paintScoutRoute() {
  const strokes = scoutRoutes[selectedRoute].strokes;
  drawField(scoutField, strokes, true);
  byId('undoScoutRoute').disabled = !routeHistory[selectedRoute].length;
  byId('clearScoutRoute').disabled = !strokes.length;
}
function scoutFieldPoint(event) {
  const box = scoutField.getBoundingClientRect();
  const normalize = value => Math.max(0, Math.min(1, (600 * value - 10) / 580));
  return [normalize((event.clientX - box.left) / box.width), normalize((event.clientY - box.top) / box.height)];
}
function rememberRoute() {
  markRouteChanged();
  const history = routeHistory[selectedRoute];
  history.push(structuredClone(scoutRoutes[selectedRoute].strokes));
  if (history.length > 50) history.shift();
}
scoutField.onpointerdown = event => {
  const strokes = scoutRoutes[selectedRoute].strokes;
  if (event.button !== 0 || routeGesture) return;
  const point = scoutFieldPoint(event);
  const width = scoutField.getBoundingClientRect().width;
  const existing = routeTool === 'move' ? strokes.findLast(stroke =>
    Math.hypot(point[0] - stroke[0][0], point[1] - stroke[0][1]) * width < 13) : undefined;
  if (routeTool === 'move' ? !existing : strokes.length >= 200) return;
  scoutField.focus();
  scoutField.setPointerCapture(event.pointerId);
  const stroke = existing ?? [point];
  routeGesture = {id: event.pointerId, stroke, existing, moved: false};
  if (!existing) {
    rememberRoute();
    strokes.push(stroke);
  }
  paintScoutRoute();
};
scoutField.onpointermove = event => {
  if (routeGesture?.id !== event.pointerId) return;
  const {stroke, existing} = routeGesture;
  const point = scoutFieldPoint(event);
  const last = existing ? stroke[0] : stroke.at(-1);
  if (Math.hypot(point[0] - last[0], point[1] - last[1]) < .004) return;
  if (existing) {
    if (!routeGesture.moved) rememberRoute();
    routeGesture.moved = true;
    stroke[0] = point;
  } else if (stroke.length < 1000) {
    stroke.push(point);
  }
  paintScoutRoute();
};
scoutField.onlostpointercapture = () => { routeGesture = undefined; };
function undoScoutRoute() {
  if (routeGesture) return;
  const previous = routeHistory[selectedRoute].pop();
  if (previous) {
    scoutRoutes[selectedRoute].strokes = previous;
    markRouteChanged();
  }
  paintScoutRoute();
}
byId('undoScoutRoute').onclick = undoScoutRoute;
document.addEventListener('keydown', event => {
  if (byId('scouting').hidden && byId('profile').hidden) return;
  if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.key.toLowerCase() !== 'z' ||
      event.target.closest('input, textarea, select, [contenteditable]')) return;
  if (!routeHistory[selectedRoute].length) return;
  event.preventDefault();
  undoScoutRoute();
});
byId('clearScoutRoute').onclick = () => {
  rememberRoute();
  scoutRoutes[selectedRoute].strokes = [];
  paintScoutRoute();
};
function downloadRouteFile(file) {
  const bytes = Uint8Array.from(atob(file.data), character => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes]));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
byId('downloadRoute').onclick = () => {
  const file = scoutRoutes[selectedRoute].file;
  if (file) downloadRouteFile(file);
};
function validateRoute(value) {
  if (!Array.isArray(value) || value.length > 200) return [];
  return value.filter(stroke => Array.isArray(stroke) && stroke.length > 0 && stroke.length <= 1000 &&
    stroke.every(point => Array.isArray(point) && point.length === 2 &&
      point.every(coordinate => Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= 1)));
}
function drawField(canvas, strokes, overlay = false) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.scale(canvas.width / 600, canvas.height / 600);

  function line(points, color, width) {
    ctx.beginPath();
    points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.stroke();
  }
  function dot(x, y, radius, color) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
  if (!overlay) {
    ctx.fillStyle = '#707882';
    ctx.fillRect(0, 0, 600, 600);
    for (let i = 100; i < 600; i += 100) {
      line([[i, 0], [i, 600]], '#9299a0', 1);
      line([[0, i], [600, i]], '#9299a0', 1);
    }
    line([[300, 200], [400, 300], [300, 400], [200, 300], [300, 200]], '#e9ebee', 3);
    for (const [x, y, endX, endY] of [[45,45,250,250],[555,45,350,250],[45,555,250,350],[555,555,350,350]]) {
      line([[x,y],[endX,endY]], '#e9ebee', 3);
    }
    for (const [x, y, color] of [[100,200,'#ffcb54'],[200,100,'#ffcb54'],[400,100,'#63b9ff'],[500,200,'#63b9ff'],[100,400,'#ff7272'],[200,500,'#ff7272'],[400,500,'#ffcb54'],[500,400,'#ffcb54'],[300,300,'#ffcb54']]) {
      dot(x, y, 13, '#232a33');
      dot(x, y, 8, color);
    }
    for (const [x, color] of [[8,'#b92e43'],[520,'#135b9c']]) {
      for (const y of [22, 538]) {
        ctx.fillStyle = color;
        ctx.fillRect(x, y, 72, 40);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 12px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText('LOADER', x + 36, y + 24);
      }
    }
  }
  const points = strokes.flat().map(([x, y]) => [10 + x * 580, 10 + y * 580]);
  if (points.length) {
    line(points, '#173323', 10);
    line(points, '#b9f47e', 5);
    for (const stroke of strokes) {
      const [x,y] = stroke[0];
      dot(10 + x * 580, 10 + y * 580, 5, '#e9ffc9');
    }
    dot(...points.at(-1), 7, '#ffd36e');
    dot(...points[0], 8, '#40e398');
  }
  ctx.restore();
}
