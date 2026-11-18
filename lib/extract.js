// Content extraction + summary/reference builders. Works in extension pages and in Node (for tests).
(function (root) {
  'use strict';
  const MiniZip = root.MiniZip || (typeof require !== 'undefined' ? require('./zip.js') : null);

  const CODE_EXT = {
    py: 'python', pyw: 'python', js: 'javascript', mjs: 'javascript', ts: 'typescript',
    java: 'java', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp',
    go: 'go', rs: 'rust', rb: 'ruby', php: 'php', sh: 'bash', bash: 'bash', ps1: 'powershell',
    bat: 'bat', cmd: 'bat', sql: 'sql', html: 'html', htm: 'html', css: 'css', json: 'json',
    xml: 'xml', yml: 'yaml', yaml: 'yaml', md: 'markdown', txt: 'text', csv: 'csv',
    asm: 'asm', s: 'asm', kt: 'kotlin', swift: 'swift', lua: 'lua', r: 'r', ini: 'ini', cfg: 'ini',
  };
  const MAX_TEXT_BYTES = 400 * 1024;
  const JUNK_RE = /(^|\/)(__MACOSX|__pycache__|\.git|\.idea|\.vscode|venv|\.venv|env|node_modules|\.ipynb_checkpoints)(\/|$)|(^|\/)(\._[^/]*|\.DS_Store|~\$[^/]*|Thumbs\.db)$|\.(pyc|pyo|class|o|obj|exe|dll)$/i;

  function ext(name) {
    const m = /\.([^./\\]+)$/.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }
  function baseName(p) { return String(p).split(/[\\/]/).pop(); }

  function classify(name) {
    const e = ext(name);
    if (e === 'zip') return 'zip';
    if (e === 'docx') return 'docx';
    if (e === 'pdf') return 'pdf';
    if (e === 'ipynb') return 'ipynb';
    if (e === 'doc' || e === 'rar' || e === '7z') return 'unsupported';
    if (CODE_EXT[e]) return e === 'txt' || e === 'md' ? 'text' : 'code';
    return 'other';
  }

  function decodeText(bytes) {
    let s;
    try {
      s = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (_) {
      s = new TextDecoder('windows-1255').decode(bytes); // Hebrew legacy encoding
    }
    return s.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  }

  function xmlUnescape(s) {
    return s
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&amp;/g, '&');
  }

  // Converts WordprocessingML (word/document.xml) into readable plain text.
  function wordXmlToText(xml) {
    const re = /<(\/?)([A-Za-z0-9]+:[A-Za-z0-9]+|[A-Za-z0-9]+)\b[^>]*?(\/?)>|([^<]+)/g;
    let out = '';
    let inText = false;
    let skip = 0; // inside pPr / rPr / mc:Fallback / deleted text etc.
    let cellDepth = 0;
    const SKIP = new Set(['w:pPr', 'w:rPr', 'mc:Fallback', 'w:instrText', 'w:delText', 'w:sectPr', 'w:tblPr', 'w:trPr', 'w:tcPr']);
    let m;
    while ((m = re.exec(xml))) {
      const [, close, tag, selfClose, text] = m;
      if (text !== undefined) {
        if (inText && !skip) out += xmlUnescape(text);
        continue;
      }
      if (SKIP.has(tag)) {
        if (selfClose) continue;
        skip += close ? -1 : 1;
        continue;
      }
      if (skip) continue;
      switch (tag) {
        case 'w:t': inText = !close && !selfClose; break;
        case 'w:tab': if (!close) out += '\t'; break;
        case 'w:br': case 'w:cr': if (!close) out += '\n'; break;
        case 'w:p': if (close) out += '\n'; break;
        // Table cells: keep each cell's paragraphs on their own lines (answers often live in tables).
        case 'w:tc': if (close) { cellDepth--; out = out.replace(/\s+$/, '') + '\n'; } else if (!selfClose) cellDepth++; break;
        case 'w:tr': if (close) out += '\n'; break;
        case 'w:tbl': if (close) out += '\n'; break;
      }
    }
    return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  async function docxToText(bytes) {
    const entries = MiniZip.readZip(bytes);
    const want = (n) => entries.find((e) => e.name === n);
    const main = want('word/document.xml');
    if (!main) throw new Error('word/document.xml not found');
    const parts = [wordXmlToText(decodeText(await main.read()))];
    // Footnotes / comments can contain answers too.
    for (const extra of ['word/footnotes.xml', 'word/comments.xml']) {
      const e = want(extra);
      if (e) {
        const t = wordXmlToText(decodeText(await e.read()));
        if (t) parts.push(`[${extra.replace('word/', '').replace('.xml', '')}]\n${t}`);
      }
    }
    return parts.join('\n\n');
  }

  function ipynbToText(str) {
    const nb = JSON.parse(str);
    const cells = nb.cells || (nb.worksheets && nb.worksheets[0] && nb.worksheets[0].cells) || [];
    return cells.map((c, i) => {
      const src = Array.isArray(c.source) ? c.source.join('') : (c.source || c.input || '');
      if (c.cell_type === 'markdown') return `# [cell ${i + 1} - markdown]\n` + src.split('\n').map((l) => '# ' + l).join('\n');
      return `# [cell ${i + 1} - ${c.cell_type}]\n${src}`;
    }).join('\n\n');
  }

  // Best-effort PDF text extraction (works for simple, non-CID PDFs only).
  async function pdfToText(bytes) {
    const latin = new TextDecoder('latin1').decode(bytes);
    const chunks = [];
    const re = /<<([\s\S]*?)>>\s*stream\r?\n/g;
    let m;
    while ((m = re.exec(latin))) {
      const start = m.index + m[0].length;
      const end = latin.indexOf('endstream', start);
      if (end < 0) break;
      let data = bytes.subarray(start, end);
      if (/\/FlateDecode/.test(m[1])) {
        try {
          const ds = new DecompressionStream('deflate');
          data = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(ds)).arrayBuffer());
        } catch (_) { continue; }
      } else if (/\/Filter/.test(m[1])) continue;
      const content = new TextDecoder('latin1').decode(data);
      const lines = [];
      const tj = /\[((?:[^\]\\]|\\.)*)\]\s*TJ|\(((?:[^)\\]|\\.)*)\)\s*(?:Tj|'|")|(T\*|ET)/g;
      let t;
      while ((t = tj.exec(content))) {
        if (t[3]) { lines.push('\n'); continue; }
        const raw = t[2] !== undefined ? t[2] : (t[1].match(/\((?:[^)\\]|\\.)*\)/g) || []).map((x) => x.slice(1, -1)).join('');
        lines.push(raw.replace(/\\([nrtbf()\\])/g, (_, c) => ({ n: '\n', r: '', t: '\t', b: '', f: '' }[c] ?? c)));
      }
      if (lines.length) chunks.push(lines.join(''));
    }
    return chunks.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // Flattens submitted files: expands ZIPs (also nested ones) into a list of { path, data }.
  async function expandFiles(files, depth = 0, prefix = '') {
    const out = [];
    for (const f of files) {
      const path = prefix + f.name;
      if (JUNK_RE.test(path)) continue;
      if (classify(f.name) === 'zip' && depth < 3 && MiniZip.isZip(f.data)) {
        let entries;
        try { entries = MiniZip.readZip(f.data); } catch (e) { out.push({ path, data: f.data, error: e.message }); continue; }
        const inner = [];
        for (const e of entries) {
          if (e.dir || JUNK_RE.test(e.name)) continue;
          if (e.encrypted) { out.push({ path: path + '/' + e.name, data: new Uint8Array(), error: 'encrypted' }); continue; }
          try { inner.push({ name: e.name, data: await e.read() }); } catch (err) {
            out.push({ path: path + '/' + e.name, data: new Uint8Array(), error: err.message });
          }
        }
        out.push(...(await expandFiles(inner, depth + 1, path + '/')));
      } else {
        out.push({ path, data: f.data });
      }
    }
    return out;
  }

  const LINE = '='.repeat(78);
  const SUB = '-'.repeat(78);

  // Renders one file into text; returns { kind, text } or null when not textual.
  async function renderFile(f) {
    const kind = classify(f.path);
    if (f.error) return { kind: 'error', text: `[לא ניתן לקרוא: ${f.error}]` };
    try {
      if (kind === 'docx') return { kind, text: await docxToText(f.data) };
      if (kind === 'ipynb') return { kind: 'code', text: ipynbToText(decodeText(f.data)) };
      if (kind === 'pdf') {
        const t = await pdfToText(f.data);
        return { kind, text: t || '[PDF – לא ניתן היה לחלץ טקסט אוטומטית. יש לצרף את הקובץ ידנית ל-AI.]' };
      }
      if (kind === 'code' || kind === 'text') {
        if (f.data.length > MAX_TEXT_BYTES) return { kind, text: `[קובץ גדול מדי (${f.data.length} bytes) – דולג]` };
        return { kind, text: decodeText(f.data) };
      }
      if (kind === 'unsupported') return { kind, text: '[פורמט לא נתמך לחילוץ אוטומטי (doc/rar/7z) – יש לפתוח ידנית]' };
    } catch (e) {
      return { kind: 'error', text: `[שגיאה בחילוץ: ${e.message}]` };
    }
    return null;
  }

  function fence(path, text) {
    const lang = CODE_EXT[ext(path)] || (ext(path) === 'ipynb' ? 'python' : '');
    return '```' + lang + '\n' + text.replace(/\s+$/, '') + '\n```';
  }

  async function buildStudentSummary({ student, userid, assignmentTitle, weekFolder, files, onlineText, sourceUrl }) {
    const flat = await expandFiles(files);
    const answers = [];
    const code = [];
    const other = [];
    for (const f of flat) {
      const r = await renderFile(f);
      if (!r) { other.push(f.path); continue; }
      if (r.kind === 'code') code.push({ path: f.path, text: r.text });
      else answers.push({ path: f.path, text: r.text, kind: r.kind });
    }

    const out = [];
    out.push(LINE, 'סיכום הגשת סטודנט', LINE);
    out.push(`סטודנט/ית: ${student}`);
    out.push(`מזהה משתמש (userid): ${userid || '-'}`);
    out.push(`מטלה: ${assignmentTitle || '-'}`);
    out.push(`תיקייה: ${weekFolder}`);
    if (sourceUrl) out.push(`קישור לבדיקה: ${sourceUrl}`);
    out.push(`נוצר: ${new Date().toLocaleString('he-IL')}`);
    out.push('', 'קבצים שהוגשו:');
    for (const f of flat) out.push(`  • ${f.path}${f.error ? '  (שגיאה: ' + f.error + ')' : ''}`);
    if (!flat.length) out.push('  (לא נמצאו קבצים)');

    out.push('', LINE, 'חלק א׳ – תשובות הסטודנט (העתק מדויק)', LINE);
    if (onlineText && onlineText.trim()) {
      out.push('', SUB, '>>> טקסט מקוון מתוך Moodle', SUB, onlineText.trim());
    }
    for (const a of answers) out.push('', SUB, `>>> ${a.path}`, SUB, a.text);
    if (!answers.length && !(onlineText && onlineText.trim())) out.push('(לא נמצא קובץ תשובות / טקסט מקוון)');

    out.push('', LINE, 'חלק ב׳ – קבצי הקוד של הסטודנט', LINE);
    for (const c of code) out.push('', SUB, `>>> ${c.path}`, SUB, fence(c.path, c.text));
    if (!code.length) out.push('(לא נמצאו קבצי קוד)');

    if (other.length) out.push('', LINE, 'קבצים נוספים שלא חולצו (בינאריים/אחר):', ...other.map((p) => '  • ' + p));
    out.push('');
    return { text: out.join('\n'), stats: { files: flat.length, answers: answers.length, code: code.length } };
  }

  // files: [{ name, data }] from the "Solution" folder
  async function buildReference({ assignmentTitle, weekFolder, files }) {
    const flat = await expandFiles(files);
    const docs = [];
    const code = [];
    const skipped = [];
    for (const f of flat) {
      const r = await renderFile(f);
      if (!r) { skipped.push(f.path); continue; }
      (r.kind === 'code' ? code : docs).push({ path: f.path, text: r.text });
    }
    const rubricFirst = (a, b) => rubricScore(b.path) - rubricScore(a.path);
    docs.sort(rubricFirst);

    const out = [];
    out.push(LINE, 'חומרי ייחוס לבדיקה – פתרון רשמי ומחוון', LINE);
    out.push(`מטלה: ${assignmentTitle || '-'}`, `תיקייה: ${weekFolder}\\Solution`, '');
    out.push(LINE, 'חלק א׳ – דף תשובות רשמי / מחוון', LINE);
    for (const d of docs) out.push('', SUB, `>>> ${d.path}`, SUB, d.text);
    if (!docs.length) out.push('(לא נמצא קובץ docx/pdf בתיקיית Solution)');
    out.push('', LINE, 'חלק ב׳ – קוד הפתרון הרשמי', LINE);
    for (const c of code) out.push('', SUB, `>>> ${c.path}`, SUB, fence(c.path, c.text));
    if (!code.length) out.push('(לא נמצאו קבצי קוד בתיקיית Solution)');
    if (skipped.length) out.push('', 'קבצים שלא נכללו: ' + skipped.join(', '));
    out.push('');
    return { text: out.join('\n'), stats: { docs: docs.length, code: code.length } };
  }

  function rubricScore(p) {
    const n = baseName(p);
    if (/מחוון|rubric|grading|ניקוד/i.test(n)) return 2;
    if (/פתרון|solution|תשובות|answers/i.test(n)) return 1;
    return 0;
  }

  const DEFAULT_PROMPT =
`את/ה בודק/ת שיעורי בית בקורס סייבר ומערכות הפעלה. לפניך:
(1) מחוון הבדיקה מתוך גיליון השיעור – קריטריונים, משקלים ורשימות משפטי משוב;
(2) הפתרון הרשמי ודף התשובות;
(3) הגשת החניכה – תשובות מילוליות וקבצי קוד.
בדוק/י את ההגשה מול הפתרון והמחוון בלבד:
- שאלות פתוחות: ציון לפי הטווח שבמחוון, עם פירוט לפי סעיפים (מה נכון ומה חסר).
- לכל קריטריון קוד: ניקוד לפי טבלת הקריטריונים, עם נימוק קצר ודוגמאות מהקוד (שם קובץ / פונקציה).
- נקודות לשימור ולשיפור: בכל שדה משפט אחד בלבד – הבולט והרלוונטי ביותר מהרשימה של אותה עמודה; משפט חופשי אחד רק כשאין משפט מתאים.
- המשוב נקרא כאילו מדריך/ה כתב/ה אותו ביד: טון חם, מעודד ואישי, בלי מספור ובלי אימוג'י.
אין להמציא דרישות שאינן מופיעות במחוון או בפתרון.`;

  // parts: { template, rubric, reference, summary, response }
  function buildAiPrompt(parts) {
    const out = [parts.template || DEFAULT_PROMPT];
    if (parts.rubric) out.push('', '##### מחוון הבדיקה (מגיליון ה-Excel) #####', parts.rubric);
    out.push('', '##### פתרון רשמי ודף תשובות #####', parts.reference || '(לא נמצאו חומרי ייחוס – יש לצרף פתרון ידנית)');
    out.push('', '##### הגשת החניכה #####', parts.summary);
    if (parts.response) out.push('', '##### ' + parts.response);
    return out.join('\n');
  }

  const api = {
    classify, decodeText, wordXmlToText, docxToText, ipynbToText, pdfToText, expandFiles,
    buildStudentSummary, buildReference, buildAiPrompt, DEFAULT_PROMPT,
  };
  root.Extract = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
