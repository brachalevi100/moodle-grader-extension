'use strict';
const GRADER_RE = /^https:\/\/moodle\.cyber\.org\.il\/mod\/assign\/view\.php\?.*\baction=grader\b/;
const REFERENCE_FILE = '_reference_for_AI.txt';
const BOM = '﻿';
const DEFAULT_SETTINGS = { folderTemplate: 'M_Week{n}', prompt: '' };

const $ = (id) => document.getElementById(id);
const state = {
  tabId: null, ctx: null, ctxKey: '', base: null, settings: { ...DEFAULT_SETTINGS },
  dirty: {}, summary: '', reference: '', referenceKey: '', activeTab: 'summary',
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
}
$('saveSettings').addEventListener('click', async () => {
  const prompt = $('promptTemplate').value.trim();
  state.settings = {
    folderTemplate: $('folderTemplate').value.trim() || DEFAULT_SETTINGS.folderTemplate,
    prompt: prompt === Extract.DEFAULT_PROMPT ? '' : prompt,
  };
  await chrome.storage.sync.set(state.settings);
  if (!state.dirty.weekFolder) $('weekFolder').value = weekFor($('assignmentNumber').value.trim());
  updateDestPath();
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
  } catch (e) {
    if (e.name !== 'AbortError') log('שגיאה בבחירת תיקייה: ' + e.message, 'err');
  }
});
$('forgetFolder').addEventListener('click', async () => {
  await FsStore.del('base');
  state.base = null;
  state.reference = '';
  state.referenceKey = '';
  renderFolder();
});

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
    if (id === 'assignmentNumber' && !state.dirty.weekFolder) $('weekFolder').value = weekFor($(id).value.trim());
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
    $('outSummary').value = '';
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
    } else {
      // Fallback: chrome.downloads can only save under the Downloads folder.
      if (zipBytes) await downloadBlob(new Blob([zipBytes], { type: 'application/zip' }), `${week}/${zipName}`);
      await downloadBlob(textBlob(summary.text), `${week}/${summaryName}`);
      log(`נשמר בתיקיית ההורדות: Downloads\\${week}\\ (לשמירה ישירה ב-${week} יש לבחור תיקיית בסיס)`, 'ok');
    }

    $('results').hidden = false;
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
  $('outReference').hidden = name !== 'reference';
}
for (const b of document.querySelectorAll('.tab')) {
  b.addEventListener('click', async () => {
    showTab(b.dataset.tab);
    if (b.dataset.tab === 'reference' && !state.reference) await refreshReference(true);
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
  const t = state.activeTab === 'summary' ? state.summary : state.reference;
  if (t) copyText(t, 'הועתק ✓');
});
$('copyPrompt').addEventListener('click', async () => {
  if (!state.summary) return;
  if (!state.reference && state.base) await refreshReference(true);
  if (!state.reference) {
    await copyText(Extract.buildAiPrompt('(לא נמצאו חומרי ייחוס – יש לצרף פתרון ומחוון ידנית)', state.summary, state.settings.prompt), 'הועתק ללא חומרי ייחוס ⚠️');
    return;
  }
  await copyText(Extract.buildAiPrompt(state.reference, state.summary, state.settings.prompt), 'פרומפט מלא הועתק ✓ – אפשר להדביק בצ׳אט AI');
});

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
