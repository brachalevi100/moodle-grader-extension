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
  if (!state.dirty.weekFolder) $('weekFolder').value = weekFor($('assignmentNumber').value.trim());
  updateDestPath();
  if (rubricChanged) { state.wbKey = ''; await updateLesson(true); }
  $('saveSettings').textContent = 'נשמר ✓';
  setTimeout(() => ($('saveSettings').textContent = 'שמירה'), 1200);
});
$('resetPrompt').addEventListener('click', () => ($('promptTemplate').value = Extract.DEFAULT_PROMPT));

// ---------- base folder ----------
async function loadFolder() {
  state.base = (await FsStore.get('base')) || null;
  renderFolder();
}
function renderFolder(warning) {
  const name = $('folderName');
  const hint = $('folderHint');
  if (state.base) {
    name.textContent = state.base.name;
    name.classList.remove('muted');
    $('pickFolder').textContent = 'החלפה';
    hint.innerHTML = warning ||
      `קובץ ה-ZIP והסיכום יישמרו ב-<code>${state.base.name}\\M_WeekN\\</code> (ליד התיקייה Solution).`;
  } else {
    name.textContent = 'לא נבחרה';
    name.classList.add('muted');
    $('pickFolder').textContent = 'בחירת תיקייה';
    hint.innerHTML = 'יש לבחור את התיקייה <b>Solution</b> (‏Desktop\\Projects\\Solution). ' +
      'בלי בחירה, הקבצים יישמרו בתיקיית ההורדות (Downloads\\M_WeekN) ולא ייווצרו חומרי ייחוס.';
  }
  updateDestPath();
}
$('pickFolder').addEventListener('click', async () => {
  try {
    const h = await window.showDirectoryPicker({ id: 'moodle-grader-base', mode: 'readwrite', startIn: 'desktop' });
    await FsStore.set('base', h);
    state.base = h;
    state.referenceKey = '';
    let warning = '';
    if (/^M_Week\d+$/i.test(h.name)) {
      warning = `⚠️ נבחרה התיקייה <code>${h.name}</code>. יש לבחור את תיקיית ההורה (Solution), אחרת תיווצר תיקייה מקוננת.`;
    } else if (h.name === 'Solution') {
      // Could be the base or a week's Solution subfolder: check for M_Week* children.
      let hasWeeks = false;
      for await (const [n, c] of h.entries()) if (c.kind === 'directory' && /^M_Week/i.test(n)) { hasWeeks = true; break; }
      if (!hasWeeks) warning = '⚠️ לא נמצאו תיקיות M_Week בתוך התיקייה שנבחרה. ייתכן שנבחרה תיקיית Solution של שבוע ולא תיקיית הבסיס.';
    }
    renderFolder(warning ? `<span class="warn" style="display:block">${warning}</span>` : '');
    refreshReference(false);
    state.wbKey = '';
    updateLesson(false);
  } catch (e) {
    if (e.name !== 'AbortError') log('שגיאה בבחירת תיקייה: ' + e.message, 'err');
  }
});
$('forgetFolder').addEventListener('click', async () => {
  await FsStore.del('base');
  state.base = null;
  state.reference = '';
  state.referenceKey = '';
  state.wb = null;
  state.wbKey = '';
  state.lesson = null;
  renderFolder();
  updateLesson(false);
});

// ---------- master rubric workbook ----------
async function findRubricFile(requestPermission) {
  if (!state.base) return null;
  if (!(await FsStore.ensurePermission(state.base, requestPermission))) return null;
  if (state.settings.rubricFile) {
    try { return await state.base.getFileHandle(state.settings.rubricFile); } catch (_) { return null; }
  }
  let best = null;
  for await (const [name, h] of state.base.entries()) {
    if (h.kind !== 'file' || !/\.xlsx$/i.test(name) || name.startsWith('~$')) continue;
    if (!best || (/מחוון/.test(name) && !/מחוון/.test(best.name))) best = h;
  }
  return best;
}

// Loads (or reuses) the workbook; reloads automatically when the file changes on disk.
async function loadWorkbook(requestPermission) {
  const fh = await findRubricFile(requestPermission);
  if (!fh) {
    state.wb = null;
    state.wbKey = '';
    $('rubricFileName').textContent = state.base ? 'לא נמצא קובץ ‎.xlsx‎ עם "מחוון" בתיקיית הבסיס' : '—';
    $('rubricFileName').classList.add('muted');
    return null;
  }
  const file = await fh.getFile();
  const key = file.name + ':' + file.lastModified;
  if (state.wb && state.wbKey === key) return state.wb;
  state.wb = await Xlsx.readWorkbook(new Uint8Array(await file.arrayBuffer()));
  state.wbKey = key;
  state.lesson = null;
  $('rubricFileName').textContent = file.name;
  $('rubricFileName').classList.remove('muted');
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
    setLessonStatus(state.base ? 'קובץ המחוון לא נמצא / אין הרשאה – ייטען בלחיצה על "שמירת ההגשה"' : 'יש לבחור תיקיית בסיס כדי לטעון את המחוון', true);
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
      if (!state.dirty.weekFolder) $('weekFolder').value = weekFor($(id).value.trim());
      state.dirty.lessonSheet = false;
      updateLesson(false);
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

  if (!state.dirty.studentName) $('studentName').value = ctx.studentName || '';
  if (!state.dirty.assignmentNumber) $('assignmentNumber').value = ctx.assignmentNumber || '';
  if (!state.dirty.weekFolder) $('weekFolder').value = weekFor($('assignmentNumber').value.trim());
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
  if (!(await FsStore.ensurePermission(state.base, requestPermission))) return null;
  let weekDir, solDir;
  try {
    weekDir = await state.base.getDirectoryHandle(week);
    solDir = await weekDir.getDirectoryHandle('Solution');
  } catch (_) {
    state.reference = '';
    state.referenceKey = '';
    $('outReference').value = `(לא נמצאה התיקייה ${week}\\Solution)`;
    return null;
  }
  const files = await FsStore.readAll(solDir);
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
  if (!state.lesson && state.base) await updateLesson(true);
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
  const name = fileName.replace(/\.xlsx$/i, '') + ` ${stamp}.xlsx`;
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
    const fh = await findRubricFile(true);
    if (!fh) throw new Error('קובץ המחוון לא נמצא בתיקיית הבסיס');

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

    const backup = await backupRubric(fh.name, bytes);
    const out = await XlsxWrite.writeRow(bytes, wb.sheetPath(lesson.sheet), loc.row, values, cached);
    try {
      await FsStore.writeFile(state.base, fh.name, out);
    } catch (e) {
      throw new Error('לא ניתן לשמור את קובץ המחוון – ייתכן שהוא פתוח ב-Excel. יש לסגור אותו ולנסות שוב. (' + e.name + ')');
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
