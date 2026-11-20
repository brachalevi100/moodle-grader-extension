// Finds the per-week solution material under the chosen root folder:
//   <root>\M_Week<N>\Solution\{*.xlsx|*.xlsm, *.docx, *.py}
// Names are always read from the handles themselves (Hebrew names, no hand-built Windows paths).
(function (root) {
  'use strict';
  const WEEK_DIR_RE = /^M_?Week[\s_-]?(\d+)$/i;
  const SOLUTION_DIR_RE = /^solution$/i;
  const RUBRIC_HINT_RE = /מחוון|rubric/i;
  const DOCX_HINT_RE = /פתרון|solution/i;

  // Excel lock files ("~$name.xlsx") and LibreOffice lock files (".~lock.name.xlsx#").
  const isTempFile = (name) => name.startsWith('~$') || name.startsWith('.~lock');

  async function lastModified(h) {
    try { return (await h.getFile()).lastModified; } catch (_) { return 0; }
  }

  // Preferred (by name hint) first; ties -> most recently modified.
  async function pickBest(handles, hintRe) {
    if (handles.length <= 1) return handles[0] || null;
    const hinted = handles.filter((h) => hintRe.test(h.name));
    const pool = hinted.length ? hinted : handles;
    if (pool.length === 1) return pool[0];
    let best = null, bestTime = -1;
    for (const h of pool) {
      const t = await lastModified(h);
      if (t > bestTime) { best = h; bestTime = t; }
    }
    return best;
  }

  async function findChildDir(dir, re) {
    for await (const [name, h] of dir.entries()) if (h.kind === 'directory' && re.test(name)) return h;
    return null;
  }

  async function scanSolutionDir(dir) {
    const xlsx = [], docx = [], py = [];
    for await (const [name, h] of dir.entries()) {
      if (h.kind !== 'file' || isTempFile(name)) continue;
      if (/\.xls[xm]$/i.test(name)) xlsx.push(h);
      else if (/\.docx$/i.test(name)) docx.push(h);
      else if (/\.py$/i.test(name)) py.push(h);
    }
    const byName = (a, b) => a.name.localeCompare(b.name, 'he');
    return {
      xlsxHandle: await pickBest(xlsx, RUBRIC_HINT_RE),
      xlsxCandidates: xlsx.sort(byName),
      docxHandle: await pickBest(docx, DOCX_HINT_RE),
      pyHandles: py.sort(byName),
    };
  }

  // -> { [weekNumber]: { week, weekDirHandle, solutionDirHandle, solutionIsFallback,
  //                      xlsxHandle, xlsxCandidates, docxHandle, pyHandles, error } }
  // Errors while listing the root itself (moved / deleted / no permission) are thrown to the caller.
  async function discoverWeeks(rootHandle) {
    const weeks = {};
    for await (const [name, h] of rootHandle.entries()) {
      if (h.kind !== 'directory') continue;
      const m = WEEK_DIR_RE.exec(name.trim());
      if (!m) continue;
      const week = parseInt(m[1], 10);
      const entry = {
        week, weekDirHandle: h, solutionDirHandle: h, solutionIsFallback: true,
        xlsxHandle: null, xlsxCandidates: [], docxHandle: null, pyHandles: [], error: null,
      };
      try {
        const sol = await findChildDir(h, SOLUTION_DIR_RE);
        if (sol) { entry.solutionDirHandle = sol; entry.solutionIsFallback = false; }
        Object.assign(entry, await scanSolutionDir(entry.solutionDirHandle));
      } catch (e) {
        entry.error = e;
      }
      // Two folders for the same week (e.g. "M_Week3" and "MWeek03"): keep the one that has a workbook.
      const prev = weeks[week];
      if (!prev || (!prev.xlsxHandle && entry.xlsxHandle)) weeks[week] = entry;
    }
    return weeks;
  }

  // Week number from a Moodle title such as "תרגיל בית 3", "שבוע 3", "Week 3". No bare-number fallback.
  function weekFromTitle(title) {
    const patterns = [
      /(?:תרגיל(?:\s*בית)?|שבוע|שיעור|מטלה)\s*(?:מס(?:פר|['׳.])?\s*)?(\d+)/,
      /(?:week|lesson|homework|hw|assignment|ex(?:ercise)?)\s*[#_-]?\s*(\d+)/i,
    ];
    for (const re of patterns) {
      const m = re.exec(title || '');
      if (m) return parseInt(m[1], 10);
    }
    return null;
  }

  // "M_Week3\Solution" (or just "M_Week3" when there is no Solution subfolder).
  function dirLabel(entry, sep = '\\') {
    return entry.solutionIsFallback ? entry.weekDirHandle.name
      : entry.weekDirHandle.name + sep + entry.solutionDirHandle.name;
  }
  // "M_Week3 → Solution → <file>"
  function pathLabel(entry, fileName) {
    return dirLabel(entry, ' → ') + ' → ' + fileName;
  }

  // Is the workbook currently open in Excel / LibreOffice? (based on their lock files next to it)
  async function isOpenElsewhere(dir, fileName) {
    const candidates = new Set(['~$' + fileName, '~$' + fileName.slice(2), '.~lock.' + fileName + '#']);
    try {
      for await (const [name, h] of dir.entries()) if (h.kind === 'file' && candidates.has(name)) return name;
    } catch (_) { /* can't tell */ }
    return null;
  }

  // 'gone' (moved/deleted/renamed), 'permission', 'locked', or 'other'.
  function classifyError(e) {
    const n = e && e.name;
    if (n === 'NotFoundError') return 'gone';
    if (n === 'NotAllowedError' || n === 'SecurityError') return 'permission';
    if (n === 'NoModificationAllowedError' || n === 'InvalidModificationError' || n === 'InvalidStateError') return 'locked';
    return 'other';
  }

  const api = { discoverWeeks, weekFromTitle, dirLabel, pathLabel, isOpenElsewhere, classifyError, isTempFile, WEEK_DIR_RE };
  root.Discover = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
