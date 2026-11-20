'use strict';
const GRADER_RE = /^https:\/\/moodle\.cyber\.org\.il\/mod\/assign\/view\.php\?.*\baction=grader\b/;
const REFERENCE_FILE = '_reference_for_AI.txt';
const BOM = '﻿';
const DEFAULT_SETTINGS = { folderTemplate: 'M_Week{n}', prompt: '', rubricFile: '' };

const $ = (id) => document.getElementById(id);
const state = {
  tabId: null, ctx: null, ctxKey: '', base: null, settings: { ...DEFAULT_SETTINGS },
  dirty: {}, summary: '', reference: '', referenceKey: '', activeTab: 'summary',
  wb: null, wbKey: '', lesson: null, lessonText: '', lastRow: null,
  // week discovery (lib/discover.js)
  weeks: {}, week: null, weekSource: '', pageWeek: null, weekOverride: null, lastWeek: null, cmid: '',
  rootStatus: 'none', scanError: '', manualRubric: null, rubricProblem: '', rubricManualOk: true,
};

// ---------- helpers ----------
function sanitize(name) {
  return (name || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
}
function weekFor(n) {
  return n ? (state.settings.folderTemplate || DEFAULT_SETTINGS.folderTemplate).replace('{n}', n) : '';
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function textBlob(s) { return new Blob([BOM + s], { type: 'text/plain;charset=utf-8' }); }

function log(msg, cls = '') {
  $('logCard').hidden = false;
  const li = document.createElement('li');
  li.textContent = msg;
  if (cls) li.className = cls;
  $('log').appendChild(li);
  return li;
}
function clearLog() { $('log').textContent = ''; }

async function activeTab() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t;
}

async function sendToTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (_) {
    // Tab was opened before the extension was installed/reloaded: inject and retry.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return chrome.tabs.sendMessage(tabId, msg);
  }
}

// ---------- settings ----------
async function loadSettings() {
  state.settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  $('folderTemplate').value = state.settings.folderTemplate;
  $('promptTemplate').value = state.settings.prompt || Extract.DEFAULT_PROMPT;
  $('rubricFile').value = state.settings.rubricFile;
}
$('saveSettings').addEventListener('click', async () => {
  const prompt = $('promptTemplate').value.trim();
  const rubricChanged = $('rubricFile').value.trim() !== state.settings.rubricFile;
  state.settings = {
    folderTemplate: $('folderTemplate').value.trim() || DEFAULT_SETTINGS.folderTemplate,
    prompt: prompt === Extract.DEFAULT_PROMPT ? '' : prompt,
    rubricFile: $('rubricFile').value.trim(),
  };
  await chrome.storage.sync.set(state.settings);
  syncWeekFolder();
  if (rubricChanged) { state.wbKey = ''; await updateLesson(true); }
  $('saveSettings').textContent = 'נשמר ✓';
  setTimeout(() => ($('saveSettings').textContent = 'שמירה'), 1200);
});
$('resetPrompt').addEventListener('click', () => ($('promptTemplate').value = Extract.DEFAULT_PROMPT));

// ---------- root folder ----------
const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const warnHtml = (s) => `<span class="warn" style="display:block">${s}</span>`;

async function loadFolder() {
  state.base = (await FsStore.get('base')) || null;
  state.manualRubric = (await FsStore.get('manualRubric')) || null;
  const { lastWeek } = await chrome.storage.local.get({ lastWeek: null });
  state.lastWeek = lastWeek;
  await rescan(); // no prompt here: requestPermission() needs a click (see "reauth")
}

function renderFolder() {
  const name = $('folderName');
  const hint = $('folderHint');
  $('reauth').hidden = !(state.base && state.rootStatus === 'needsPermission');
  $('rescan').hidden = !state.base;
  if (!state.base) {
    name.textContent = 'לא נבחרה';
    name.classList.add('muted');
    $('pickFolder').textContent = 'בחירת תיקיית Solution';
    hint.innerHTML = 'יש לבחור פעם אחת את התיקייה <b>Solution</b> (‏Desktop\\Projects\\Solution) שמכילה את תיקיות <code>M_WeekN</code>. ' +
      'בלי בחירה, הקבצים יישמרו בתיקיית ההורדות (Downloads\\M_WeekN) ולא ייווצרו חומרי ייחוס.';
    updateDestPath();
    return;
  }
  const rootName = escHtml(state.base.name);
  name.textContent = state.base.name;
  name.classList.remove('muted');
  $('pickFolder').textContent = 'החלפה';
  const count = Object.keys(state.weeks).length;
  if (state.rootStatus === 'needsPermission') {
    hint.innerHTML = warnHtml('🔒 אין הרשאת גישה לתיקייה (למשל אחרי הפעלה מחדש של הדפדפן). יש ללחוץ על "אישור גישה מחדש".');
  } else if (state.rootStatus === 'gone') {
    hint.innerHTML = warnHtml(`⚠️ התיקייה <code>${rootName}</code> לא נמצאה – ייתכן שהועברה, נמחקה או ששמה שונה. יש לבחור אותה מחדש.`);
  } else if (state.rootStatus === 'error') {
    hint.innerHTML = warnHtml('⚠️ שגיאה בסריקת התיקייה: ' + escHtml(state.scanError));
  } else if (!count && Discover.WEEK_DIR_RE.test(state.base.name)) {
    hint.innerHTML = warnHtml(`⚠️ נבחרה התיקייה <code>${rootName}</code>. יש לבחור את תיקיית ההורה (Solution), אחרת תיווצר תיקייה מקוננת.`);
  } else if (!count) {
    hint.innerHTML = warnHtml('⚠️ לא נמצאו תיקיות M_WeekN בתוך התיקייה שנבחרה. ייתכן שנבחרה תיקיית Solution של שבוע ולא תיקיית השורש.');
  } else {
    hint.innerHTML = `נמצאו ${count} תיקיות שבוע. קובץ ה-ZIP והסיכום יישמרו ב-<code>${rootName}\\M_WeekN\\</code>.`;
  }
  updateDestPath();
}

// Rebuilds the week map from disk. Never prompts unless `request` is set (only from a click).
async function rescan({ request = false } = {}) {
  state.weeks = {};
  state.scanError = '';
  if (!state.base) {
    state.rootStatus = 'none';
  } else {
    let ok = false;
    try { ok = await FsStore.ensurePermission(state.base, request); } catch (_) { /* e.g. root deleted */ }
    if (!ok) {
      state.rootStatus = 'needsPermission';
    } else {
      try {
        state.weeks = await Discover.discoverWeeks(state.base);
        state.rootStatus = 'ok';
      } catch (e) {
        const kind = Discover.classifyError(e);
        state.rootStatus = kind === 'gone' ? 'gone' : kind === 'permission' ? 'needsPermission' : 'error';
        state.scanError = e.message;
      }
    }
  }
  renderFolder();
  chooseWeek();
}

$('pickFolder').addEventListener('click', async () => {
  try {
    const h = await window.showDirectoryPicker({ id: 'moodle-grader-base', mode: 'readwrite', startIn: 'desktop' });
    await FsStore.set('base', h);
    state.base = h;
    await rescan();
    reloadMaterials(false);
  } catch (e) {
    if (e.name !== 'AbortError') log('שגיאה בבחירת תיקייה: ' + e.message, 'err');
  }
});
$('reauth').addEventListener('click', async () => {
  await rescan({ request: true });
  if (state.rootStatus === 'needsPermission') log('הגישה לתיקייה לא אושרה', 'err');
  reloadMaterials(false);
});
$('rescan').addEventListener('click', async () => {
  await rescan({ request: true });
  reloadMaterials(false);
});
$('forgetFolder').addEventListener('click', async () => {
  await FsStore.del('base');
  state.base = null;
  state.reference = '';
  state.lesson = null;
  await rescan();
  reloadMaterials(false);
});

// Forgets cached workbook/solution so they are re-read for the current week.
function reloadMaterials(requestPermission) {
  state.wb = null;
  state.wbKey = '';
  state.lesson = null;
  state.referenceKey = '';
  refreshReference(requestPermission);
  return updateLesson(requestPermission);
}

// ---------- week selection ----------
const weekNumbers = () => Object.keys(state.weeks).map(Number).sort((a, b) => a - b);
const selectedWeek = () => (state.week !== null && state.weeks[state.week]) || null;
const toWeekNum = (s) => (/^\s*\d+\s*$/.test(s || '') ? parseInt(s, 10) : null);

// Week number suggested by the Moodle page (or by the assignment number the user typed).
function pageWeekNumber() {
  const typed = toWeekNum($('assignmentNumber').value);
  if (state.dirty.assignmentNumber) return typed;
  const fromTitle = state.ctx ? Discover.weekFromTitle(state.ctx.assignmentTitle) : null;
  return fromTitle !== null ? fromTitle : typed;
}

// Priority: manual choice for this assignment > page title > last used > highest week.
function chooseWeek() {
  const has = (n) => n !== null && n !== undefined && !!state.weeks[n];
  const fromPage = pageWeekNumber();
  let week = null, source = '';
  if (has(state.weekOverride)) { week = state.weekOverride; source = 'manual'; }
  else if (has(fromPage)) { week = fromPage; source = 'page'; }
  else if (has(state.lastWeek)) { week = state.lastWeek; source = 'last'; }
  else if (weekNumbers().length) { week = weekNumbers().pop(); source = 'max'; }
  const changed = week !== state.week;
  state.week = week;
  state.weekSource = source;
  state.pageWeek = fromPage;
  if (changed) { state.wb = null; state.wbKey = ''; state.lesson = null; state.referenceKey = ''; }
  renderWeeks();
  syncWeekFolder();
  return changed;
}

function renderWeeks() {
  const select = $('weekSelect');
  const nums = weekNumbers();
  $('weekRow').hidden = !nums.length;
  select.textContent = '';
  for (const n of nums) {
    const e = state.weeks[n];
    select.appendChild(new Option(e.weekDirHandle.name + (e.xlsxHandle ? '' : ' (אין XLSX)'), String(n)));
  }
  select.value = state.week !== null ? String(state.week) : '';
  const hint = $('weekHint');
  const p = state.pageWeek;
  let text = '';
  if (nums.length && state.weekSource !== 'manual') {
    if (state.weekSource === 'page') text = `נבחר אוטומטית לפי שם המטלה (${p}).`;
    else if (p !== null) text = `⚠️ לא נמצאה תיקיית שבוע ${p} – נבחר ${state.weeks[state.week].weekDirHandle.name}. אפשר לשנות.`;
  }
  hint.textContent = text;
  hint.hidden = !text;
}

$('weekSelect').addEventListener('change', async () => {
  const n = toWeekNum($('weekSelect').value);
  state.weekOverride = n;
  state.lastWeek = n;
  await chrome.storage.local.set({ lastWeek: n });
  chooseWeek();
  reloadMaterials(false);
});

// The destination folder follows the selected week when it matches the page (or was chosen by hand);
// otherwise it stays M_Week<assignment number>, which is created on save if missing.
function defaultWeekFolder() {
  const e = selectedWeek();
  if (e && (state.weekSource === 'manual' || state.weekSource === 'page')) return e.weekDirHandle.name;
  return weekFor($('assignmentNumber').value.trim()) || (e ? e.weekDirHandle.name : '');
}
function syncWeekFolder() {
  if (!state.dirty.weekFolder) $('weekFolder').value = defaultWeekFolder();
  updateDestPath();
}

// ---------- master rubric workbook ----------
function setRubricLabel(label, problem, showManual) {
  const el = $('rubricFileName');
  el.textContent = '';
  if (label) {
    // <bdi> keeps a Hebrew file name readable inside the left-to-right path.
    const parts = label.split(' → ');
    parts.forEach((p, i) => {
      const b = document.createElement('bdi');
      b.textContent = p;
      el.appendChild(b);
      if (i < parts.length - 1) el.appendChild(document.createTextNode(' → '));
    });
  } else {
    el.textContent = '—';
  }
  el.classList.toggle('muted', !label);
  $('rubricMissing').hidden = !problem;
  $('rubricMissingText').textContent = problem || '';
  $('pickRubricFile').hidden = !showManual;
}

// -> { handle, dir, label } or null. Sets state.rubricProblem / state.rubricManualOk when not found.
async function findRubricFile(requestPermission) {
  state.rubricProblem = '';
  state.rubricManualOk = true;
  if (state.base) {
    let ok = false;
    try { ok = await FsStore.ensurePermission(state.base, requestPermission); } catch (_) { /* root gone */ }
    if (!ok) {
      if (state.rootStatus !== 'needsPermission') { state.rootStatus = 'needsPermission'; renderFolder(); }
      state.rubricProblem = 'אין הרשאת גישה לתיקיית השורש – יש ללחוץ על "אישור גישה מחדש".';
      state.rubricManualOk = false;
      return null;
    }
    if (state.rootStatus !== 'ok') await rescan(); // permission was just granted, or the root is back
    const e = selectedWeek();
    if (e) {
      if (state.settings.rubricFile) {
        try {
          const h = await e.solutionDirHandle.getFileHandle(state.settings.rubricFile);
          return { handle: h, dir: e.solutionDirHandle, label: Discover.pathLabel(e, h.name) };
        } catch (_) { /* fall through to auto-detection */ }
      }
      if (e.xlsxHandle) return { handle: e.xlsxHandle, dir: e.solutionDirHandle, label: Discover.pathLabel(e, e.xlsxHandle.name) };
      state.rubricProblem = `לא נמצא קובץ XLSX בתיקיית ${Discover.dirLabel(e)}`;
    } else if (state.rootStatus === 'gone') {
      state.rubricProblem = 'תיקיית השורש לא נמצאה (הועברה או נמחקה) – יש לבחור אותה מחדש.';
    } else if (state.rootStatus === 'ok') {
      state.rubricProblem = 'לא נמצאו תיקיות M_WeekN בתיקיית השורש.';
    }
    // Legacy layout: the workbook directly in the root folder.
    if (state.rootStatus === 'ok') {
      for await (const [name, h] of state.base.entries()) {
        if (h.kind === 'file' && /\.xls[xm]$/i.test(name) && !Discover.isTempFile(name) &&
            (name === state.settings.rubricFile || /מחוון|rubric/i.test(name))) {
          return { handle: h, dir: state.base, label: state.base.name + ' → ' + name };
        }
      }
    }
  } else {
    state.rubricProblem = 'לא נבחרה תיקיית שורש – יש לבחור את תיקיית Solution או קובץ מחוון ידנית.';
  }
  // Manual fallback: a workbook picked by hand earlier.
  if (state.manualRubric) {
    let ok = false;
    try { ok = await FsStore.ensurePermission(state.manualRubric, requestPermission); } catch (_) { /* file gone */ }
    if (ok) return { handle: state.manualRubric, dir: null, label: state.manualRubric.name + ' (נבחר ידנית)' };
  }
  return null;
}

$('pickRubricFile').addEventListener('click', async () => {
  try {
    const [h] = await window.showOpenFilePicker({
      id: 'moodle-grader-rubric', startIn: selectedWeek() ? selectedWeek().solutionDirHandle : 'desktop',
      types: [{ description: 'Excel', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx', '.xlsm'] } }],
    });
    if (!(await FsStore.ensurePermission(h, true))) throw new Error('לא ניתנה הרשאת כתיבה לקובץ');
    await FsStore.set('manualRubric', h);
    state.manualRubric = h;
    reloadMaterials(false);
  } catch (e) {
    if (e.name !== 'AbortError') setLessonStatus('שגיאה בבחירת קובץ: ' + e.message, true);
  }
});

// Loads (or reuses) the workbook; reloads automatically when the file changes on disk.
async function loadWorkbook(requestPermission, retried) {
  const found = await findRubricFile(requestPermission);
  if (!found) {
    state.wb = null;
    state.wbKey = '';
    setRubricLabel('', state.rubricProblem, state.rubricManualOk);
    return null;
  }
  setRubricLabel(found.label, found.dir ? '' : state.rubricProblem, !found.dir);
  let file;
  try {
    file = await found.handle.getFile();
  } catch (e) {
    // The file was renamed/moved since the last scan: rescan once and try again.
    if (Discover.classifyError(e) === 'gone' && !retried && found.dir) { await rescan(); return loadWorkbook(requestPermission, true); }
    if (Discover.classifyError(e) === 'gone' && !found.dir) {
      await FsStore.del('manualRubric');
      state.manualRubric = null;
      throw new Error('הקובץ שנבחר ידנית לא נמצא (הועבר או נמחק)');
    }
    throw e;
  }
  const key = found.label + ':' + file.lastModified;
  if (state.wb && state.wbKey === key) return state.wb;
  state.wb = await Xlsx.readWorkbook(new Uint8Array(await file.arrayBuffer()));
  state.wbKey = key;
  state.lesson = null;
  return state.wb;
}

function setLessonStatus(text, bad) {
  $('lessonStatus').textContent = text;
  $('lessonStatus').classList.toggle('bad', !!bad);
}

// Picks the "שיעור N" sheet for the current assignment number and parses it.
async function updateLesson(requestPermission) {
  const select = $('lessonSheet');
  let wb;
  try {
    wb = await loadWorkbook(requestPermission);
  } catch (e) {
    setLessonStatus('שגיאה בקריאת קובץ המחוון: ' + e.message, true);
    return null;
  }
  if (!wb) {
    select.textContent = '';
    state.lesson = null;
    setLessonStatus(state.rubricProblem || 'קובץ המחוון לא נמצא', true);
    return null;
  }

  const previous = select.value;
  select.textContent = '';
  select.appendChild(new Option('— ללא מחוון —', ''));
  for (const n of wb.sheetNames.filter((s) => s !== 'weights')) select.appendChild(new Option(n, n));
  select.value = state.dirty.lessonSheet ? previous : Rubric.findLessonSheet(wb, $('assignmentNumber').value.trim()) || '';

  const sheet = select.value;
  if (!sheet) {
    state.lesson = null;
    setLessonStatus(`לא נמצא גיליון "שיעור ${$('assignmentNumber').value.trim()}" בקובץ המחוון`, true);
    return null;
  }
  if (!state.lesson || state.lesson.sheet !== sheet) {
    try {
      state.lesson = await Rubric.parseLesson(wb, sheet);
    } catch (e) {
      state.lesson = null;
      setLessonStatus(e.message, true);
      return null;
    }
    state.lessonText = Rubric.describeLesson(state.lesson);
    $('outRubric').value = state.lessonText + '\n\n' + Rubric.responseInstructions(state.lesson);
  }
  const l = state.lesson;
  const parts = [`${l.categories.length} קטגוריות`, `${l.fields.length} עמודות`];
  parts.push(l.optionCount ? `${l.optionCount} משפטי משוב` : 'אין רשימות משפטים');
  parts.push(l.hasRubricTable ? 'טבלת קריטריונים ✓' : 'אין טבלת קריטריונים');
  if (l.gradeFormula) parts.push('נוסחת ציון ✓');
  if (l.feedbackFormula) parts.push('נוסחת משוב ✓');
  setLessonStatus(parts.join(' · '), !l.optionCount && !l.hasRubricTable);
  return l;
}

$('lessonSheet').addEventListener('change', () => {
  state.dirty.lessonSheet = true;
  state.lesson = null;
  updateLesson(false);
});
$('reloadRubric').addEventListener('click', () => { state.wbKey = ''; state.lesson = null; updateLesson(true); });

// ---------- page context ----------
function updateDestPath() {
  const week = sanitize($('weekFolder').value);
  const name = sanitize($('studentName').value);
  const root = state.base ? state.base.name : 'Downloads';
  $('destPath').textContent = week && name ? `${root}\\${week}\\${name}.zip` : '';
}

for (const id of ['studentName', 'assignmentNumber', 'weekFolder', 'onlineText']) {
  $(id).addEventListener('input', () => {
    state.dirty[id] = true;
    if (id === 'assignmentNumber') {
      state.weekOverride = null; // a typed assignment number wins over an earlier manual week choice
      state.dirty.lessonSheet = false;
      chooseWeek();
      updateLesson(false);
      refreshReference(false);
    }
    updateDestPath();
  });
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 250);
}

async function refresh() {
  const tab = await activeTab();
  state.tabId = tab ? tab.id : null;
  const onGrader = !!tab && GRADER_RE.test(tab.url || '');
  $('notGrader').hidden = onGrader;
  $('ctxCard').hidden = !onGrader;
  if (!onGrader) return;

  let ctx;
  try {
    ctx = await sendToTab(tab.id, { type: 'GET_CONTEXT' });
  } catch (e) {
    $('loadingNote').hidden = false;
    $('loadingNote').textContent = 'לא ניתן לקרוא את העמוד: ' + e.message;
    return;
  }
  if (!ctx || ctx.error || !ctx.isGrader) return;

  const key = `${ctx.cmid}:${ctx.userid}`;
  if (key !== state.ctxKey) {
    state.ctxKey = key;
    state.dirty = {};
    state.summary = '';
    state.lastRow = null;
    $('outSummary').value = '';
    $('aiAnswer').value = '';
    $('gradeOut').hidden = true;
    $('aiWarnings').hidden = true;
    $('aiCard').hidden = true;
    $('results').hidden = true;
    clearLog();
    $('logCard').hidden = true;
  }
  state.ctx = ctx;
  if (ctx.cmid !== state.cmid) { state.cmid = ctx.cmid; state.weekOverride = null; } // new assignment

  if (!state.dirty.studentName) $('studentName').value = ctx.studentName || '';
  if (!state.dirty.assignmentNumber) $('assignmentNumber').value = ctx.assignmentNumber || '';
  chooseWeek();
  if (!state.dirty.onlineText) $('onlineText').value = ctx.onlineText || '';
  $('assignmentTitle').textContent = ctx.assignmentTitle || '—';
  $('userid').textContent = ctx.userid || '—';
  $('loadingNote').hidden = !ctx.loading;
  $('loadingNote').textContent = 'העמוד עדיין טוען את הסטודנט/ית… הנתונים יתעדכנו אוטומטית.';

  const list = $('fileList');
  list.textContent = '';
  for (const f of ctx.files) {
    const li = document.createElement('li');
    li.textContent = '📎 ' + f.name;
    list.appendChild(li);
  }
  if (!ctx.files.length) {
    const li = document.createElement('li');
    li.textContent = ctx.loading ? 'טוען…' : 'לא נמצאו קבצי הגשה בעמוד';
    list.appendChild(li);
  }
  updateDestPath();
  refreshReference(false);
  updateLesson(false);
}

// ---------- reference (official solution + rubric) ----------
async function refreshReference(requestPermission) {
  const week = sanitize($('weekFolder').value);
  if (!state.base || !week) return null;
  const key = state.base.name + '/' + week;
  if (state.referenceKey === key && state.reference) return state.reference;
  let permitted = false;
  try { permitted = await FsStore.ensurePermission(state.base, requestPermission); } catch (_) { /* root gone */ }
  if (!permitted) return null;
  // Prefer the discovered folders (case-insensitive "Solution", fallback to the week folder itself).
  const entry = Object.values(state.weeks).find((e) => e.weekDirHandle.name.toLowerCase() === week.toLowerCase());
  let weekDir, files;
  try {
    if (entry && !entry.solutionIsFallback) {
      weekDir = entry.weekDirHandle;
      files = await FsStore.readAll(entry.solutionDirHandle);
    } else if (entry && (entry.docxHandle || entry.pyHandles.length)) {
      // No Solution subfolder: use only the solution files at the top of the week folder,
      // not the students' ZIPs/summaries saved next to them.
      weekDir = entry.weekDirHandle;
      files = [];
      for (const h of [entry.docxHandle, ...entry.pyHandles].filter(Boolean)) {
        files.push({ name: h.name, data: new Uint8Array(await (await h.getFile()).arrayBuffer()) });
      }
    } else {
      weekDir = await state.base.getDirectoryHandle(week);
      files = await FsStore.readAll(await weekDir.getDirectoryHandle('Solution'));
    }
  } catch (_) {
    state.reference = '';
    state.referenceKey = '';
    $('outReference').value = `(לא נמצאה התיקייה ${week}\\Solution)`;
    return null;
  }
  const ref = await Extract.buildReference({
    assignmentTitle: state.ctx ? state.ctx.assignmentTitle : '', weekFolder: week, files,
  });
  state.reference = ref.text;
  state.referenceKey = key;
  $('outReference').value = ref.text;
  return { text: ref.text, stats: ref.stats, weekDir };
}

// ---------- main action ----------
$('process').addEventListener('click', processSubmission);

async function processSubmission() {
  const btn = $('process');
  btn.disabled = true;
  clearLog();
  try {
    const name = sanitize($('studentName').value);
    const week = sanitize($('weekFolder').value);
    if (!name) throw new Error('חסר שם סטודנט/ית');
    if (!week) throw new Error('חסרה תיקיית יעד (מספר מטלה)');

    // Ask for folder permission first, while the click still counts as a user gesture.
    let weekDir = null;
    if (state.base) {
      if (!(await FsStore.ensurePermission(state.base, true))) throw new Error('לא ניתנה הרשאת כתיבה לתיקיית הבסיס');
      try {
        weekDir = await state.base.getDirectoryHandle(week);
      } catch (_) {
        weekDir = await state.base.getDirectoryHandle(week, { create: true });
        log(`נוצרה תיקייה חדשה: ${week}`);
      }
    }

    // Re-read the page so we use the files of the student currently shown.
    const ctx = await sendToTab(state.tabId, { type: 'GET_CONTEXT' });
    if (!ctx || ctx.error) throw new Error('לא ניתן לקרוא את עמוד הבדיקה');
    if (state.ctx && ctx.userid !== state.ctx.userid) {
      await refresh();
      throw new Error('הסטודנט/ית בעמוד השתנה/תה – הנתונים עודכנו, יש ללחוץ שוב');
    }
    if (ctx.loading) throw new Error('העמוד עדיין טוען – יש לנסות שוב בעוד רגע');

    const downloaded = [];
    for (const f of ctx.files) {
      const li = log(`מוריד: ${f.name}…`);
      const r = await sendToTab(state.tabId, { type: 'FETCH_FILE', url: f.url });
      if (!r || r.error) throw new Error(`הורדת ${f.name} נכשלה: ${r ? r.error : 'אין תשובה'}`);
      downloaded.push({ name: f.name, data: b64ToBytes(r.base64) });
      li.textContent = `הורד: ${f.name} (${Math.round(r.size / 1024)} KB)`;
    }
    if (!downloaded.length) log('לא נמצאו קבצי הגשה – ייווצר סיכום בלבד', 'err');

    // ZIP: keep the student's ZIP as-is (renamed); otherwise bundle the files into one ZIP.
    let zipBytes = null;
    if (downloaded.length === 1 && MiniZip.isZip(downloaded[0].data)) zipBytes = downloaded[0].data;
    else if (downloaded.length) zipBytes = MiniZip.writeZip(downloaded);

    const onlineText = $('onlineText').value;
    const summary = await Extract.buildStudentSummary({
      student: $('studentName').value.trim(), userid: ctx.userid, assignmentTitle: ctx.assignmentTitle,
      weekFolder: week, files: downloaded, onlineText, sourceUrl: ctx.url,
    });
    state.summary = summary.text;
    $('outSummary').value = summary.text;
    log(`סיכום: ${summary.stats.answers} קבצי תשובות, ${summary.stats.code} קבצי קוד`);

    const zipName = `${name}.zip`;
    const summaryName = `${name} - סיכום.txt`;

    if (weekDir) {
      if (zipBytes) {
        const r = await FsStore.writeFile(weekDir, zipName, zipBytes);
        log(`נשמר: ${week}\\${zipName}${r.existed ? ' (הוחלף קובץ קיים)' : ''}`, 'ok');
      }
      const r2 = await FsStore.writeFile(weekDir, summaryName, textBlob(summary.text));
      log(`נשמר: ${week}\\${summaryName}${r2.existed ? ' (הוחלף קובץ קיים)' : ''}`, 'ok');

      state.referenceKey = ''; // rebuild so edits to the Solution folder are picked up
      const ref = await refreshReference(true);
      if (ref) {
        await FsStore.writeFile(weekDir, REFERENCE_FILE, textBlob(ref.text));
        log(`חומרי ייחוס: ${ref.stats.docs} מסמכים, ${ref.stats.code} קבצי קוד → ${week}\\${REFERENCE_FILE}`, 'ok');
      } else {
        log(`לא נמצאה התיקייה ${week}\\Solution – לא נוצרו חומרי ייחוס`, 'err');
      }

      // Rubric for this lesson from the master Excel file.
      state.wbKey = ''; // re-read so recent edits to the Excel file are picked up
      const lesson = await updateLesson(true);
      if (lesson) {
        log(`מחוון: גיליון "${lesson.sheet}" – ${lesson.fields.length} עמודות, ${lesson.optionCount} משפטי משוב`, 'ok');
      } else {
        log('לא נטען מחוון מקובץ ה-Excel – החבילה תכלול רק את הפתרון', 'err');
      }
      const packageName = `${name} - חבילת AI.txt`;
      await FsStore.writeFile(weekDir, packageName, textBlob(buildPackage()));
      log(`נשמר: ${week}\\${packageName}`, 'ok');
    } else {
      // Fallback: chrome.downloads can only save under the Downloads folder.
      if (zipBytes) await downloadBlob(new Blob([zipBytes], { type: 'application/zip' }), `${week}/${zipName}`);
      await downloadBlob(textBlob(summary.text), `${week}/${summaryName}`);
      log(`נשמר בתיקיית ההורדות: Downloads\\${week}\\ (לשמירה ישירה ב-${week} יש לבחור תיקיית בסיס)`, 'ok');
    }

    $('results').hidden = false;
    $('aiCard').hidden = !state.lesson;
    showTab('summary');
  } catch (e) {
    log(e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename, conflictAction: 'overwrite', saveAs: false });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

// ---------- results / copy ----------
function showTab(name) {
  state.activeTab = name;
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === name);
  $('outSummary').hidden = name !== 'summary';
  $('outRubric').hidden = name !== 'rubric';
  $('outReference').hidden = name !== 'reference';
}

function buildPackage() {
  return Extract.buildAiPrompt({
    template: state.settings.prompt,
    rubric: state.lesson ? state.lessonText : '',
    reference: state.reference,
    summary: state.summary,
    response: state.lesson ? Rubric.responseInstructions(state.lesson) : '',
  });
}
for (const b of document.querySelectorAll('.tab')) {
  b.addEventListener('click', async () => {
    showTab(b.dataset.tab);
    if (b.dataset.tab === 'reference' && !state.reference) await refreshReference(true);
    if (b.dataset.tab === 'rubric' && !state.lesson) await updateLesson(true);
  });
}

async function copyText(text, note) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  $('copyNote').textContent = `${note} (${text.length.toLocaleString()} תווים)`;
}
$('copyTab').addEventListener('click', () => {
  const t = { summary: state.summary, reference: state.reference, rubric: $('outRubric').value }[state.activeTab];
  if (t) copyText(t, 'הועתק ✓');
});
$('copyPrompt').addEventListener('click', async () => {
  if (!state.summary) return;
  if (!state.reference && state.base) await refreshReference(true);
  if (!state.lesson) await updateLesson(true);
  const missing = [!state.reference && 'פתרון', !state.lesson && 'מחוון'].filter(Boolean);
  await copyText(buildPackage(), missing.length
    ? `הועתק ללא ${missing.join(' ו')} ⚠️`
    : 'חבילה מלאה הועתקה ✓ – להדביק בצ׳אט AI, ואת התשובה להדביק למטה');
  $('aiCard').hidden = !state.lesson;
});

// ---------- AI answer -> grade + feedback -> written into the master Excel file ----------
function setSaveStatus(text, cls) {
  const el = $('saveStatus');
  el.textContent = text;
  el.className = 'hint save-status ' + (cls || '');
  el.hidden = !text;
}

// Keeps one untouched copy of the rubric per day in <base>\_גיבוי מחוון\ before the first write.
async function backupRubric(fileName, bytes) {
  const dir = await state.base.getDirectoryHandle('_גיבוי מחוון', { create: true });
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const m = /\.xls[xm]$/i.exec(fileName);
  const name = (m ? fileName.slice(0, m.index) : fileName) + ` ${stamp}${m ? m[0] : '.xlsx'}`;
  try { await dir.getFileHandle(name); return null; } catch (_) { /* no backup yet today */ }
  await FsStore.writeFile(dir, name, bytes);
  return name;
}

$('computeGrade').addEventListener('click', async () => {
  const btn = $('computeGrade');
  const warn = $('aiWarnings');
  warn.hidden = true;
  $('gradeOut').hidden = true;
  setSaveStatus('');
  if (!state.lesson) { warn.textContent = 'המחוון לא נטען'; warn.hidden = false; return; }
  const student = $('studentName').value.trim();
  if (!student) { warn.textContent = 'חסר שם חניכה'; warn.hidden = false; return; }

  btn.disabled = true;
  try {
    // Permission first, while the click still counts as a user gesture.
    const found = await findRubricFile(true);
    if (!found) throw new Error(state.rubricProblem || 'קובץ המחוון לא נמצא');
    const fh = found.handle;

    // Always work on the file as it is on disk right now (it may have been edited since it was loaded).
    const bytes = new Uint8Array(await (await fh.getFile()).arrayBuffer());
    const wb = await Xlsx.readWorkbook(bytes);
    const lesson = await Rubric.parseLesson(wb, state.lesson.sheet);

    const parsed = Rubric.parseAiResponse($('aiAnswer').value, lesson);
    const res = Rubric.computeRow(wb, lesson, parsed.inputs, student);
    const warnings = [...parsed.warnings];
    if (res.usedFallback) warnings.push('לא נמצאה נוסחת משוב תקינה בגיליון – המשוב נבנה בפורמט ברירת המחדל');
    if (warnings.length) { warn.textContent = warnings.join('\n'); warn.hidden = false; }
    $('gradeValue').textContent = res.grade === null ? '(אין נוסחת ציון בגיליון)' : res.grade;
    $('feedbackOut').value = res.feedback;
    $('gradeOut').hidden = false;

    // Row: existing row of this student, otherwise the first empty row.
    const loc = Rubric.findStudentRow(wb.sheet(lesson.sheet), lesson, student);
    const values = {};
    for (const f of lesson.fields) values[f.col] = parsed.inputs[f.col] !== undefined ? parsed.inputs[f.col] : null;
    if (loc.isNew) values[lesson.nameCol] = student;
    const cached = {};
    if (lesson.gradeCol && res.grade !== null) cached[lesson.gradeCol] = res.grade;
    if (lesson.feedbackCol && !res.usedFallback) cached[lesson.feedbackCol] = res.feedback;

    // Excel keeps a "~$<name>" lock file next to a workbook it has open; writing now would be lost.
    const lock = found.dir ? await Discover.isOpenElsewhere(found.dir, fh.name) : null;
    if (lock) {
      throw new Error(`קובץ המחוון פתוח ב-Excel – יש לסגור את הקובץ ב-Excel ולנסות שוב. ` +
        `(אם Excel סגור, יש למחוק את קובץ הנעילה "${lock}" מהתיקייה)`);
    }
    const backup = state.base && state.rootStatus === 'ok' ? await backupRubric(fh.name, bytes) : null;
    const out = await XlsxWrite.writeRow(bytes, wb.sheetPath(lesson.sheet), loc.row, values, cached);
    try {
      await FsStore.writeHandle(fh, out); // back into the same file that was read
    } catch (e) {
      const kind = Discover.classifyError(e);
      if (kind === 'gone') throw new Error('קובץ המחוון הועבר או נמחק – יש ללחוץ על "סריקה מחדש".');
      if (kind === 'permission') throw new Error('אין הרשאת כתיבה לקובץ המחוון – יש ללחוץ על "אישור גישה מחדש".');
      throw new Error('לא ניתן לשמור את קובץ המחוון – ייתכן שהוא פתוח ב-Excel. יש לסגור את הקובץ ב-Excel ולנסות שוב. (' + e.name + ')');
    }

    const where = `גיליון "${lesson.sheet}", שורה ${loc.row}`;
    const head = loc.isNew ? `✓ נשמר בקובץ המחוון – ${where} (שורה חדשה)` : `✓ עודכן בקובץ המחוון – ${where} (${loc.matchedName})`;
    setSaveStatus(head + (backup ? ` · גיבוי יומי: _גיבוי מחוון\\${backup}` : ''), 'ok');
    state.wbKey = '';
    state.lesson = null;
    await updateLesson(false);
  } catch (e) {
    setSaveStatus(e.message, 'bad');
  } finally {
    btn.disabled = false;
  }
});
$('copyFeedback').addEventListener('click', () => copyText($('feedbackOut').value, 'המשוב הועתק ✓'));

// ---------- wiring ----------
$('refresh').addEventListener('click', () => { state.ctxKey = ''; refresh(); });
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'CONTEXT_CHANGED' && sender.tab && sender.tab.id === state.tabId) scheduleRefresh();
});
chrome.tabs.onActivated.addListener(scheduleRefresh);
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === state.tabId && (info.url || info.status === 'complete')) scheduleRefresh();
});
window.addEventListener('focus', scheduleRefresh);

(async function init() {
  await loadSettings();
  await loadFolder();
  await refresh();
})();
