// Reads a lesson sheet ("שיעור N") from the master rubric workbook, describes it for an AI,
// and turns the AI's answer back into a grade + feedback using the sheet's OWN formulas.
(function (root) {
  'use strict';
  const Formula = root.Formula || (typeof require !== 'undefined' ? require('./formula.js') : null);
  const { colToIdx, idxToCol } = Formula;

  const str = (v) => (v === null || v === undefined || typeof v === 'object' ? '' : String(v).trim());

  // ---------- text cleanup (human-sounding feedback) ----------
  // Emoji + variation selectors, joiners, skin tones and keycaps.
  const EMOJI_RUN = /\s*(?:[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{FE0E}\u{200D}\u{20E3}])+\s*/gu;
  const stripEmoji = (s) => String(s).replace(EMOJI_RUN, ' ').replace(/ {2,}/g, ' ').trim();
  // "- 1. text", "1) text", "• 2. text", "* text" -> "text"
  const stripNumbering = (s) => String(s).replace(/^\s*(?:[-–—•*·]\s*)*(?:\d{1,2}\s*[.)]\s+)?/, '').trim();

  function cleanFeedback(text) {
    return String(text).split('\n').map((line) => {
      let l = line.replace(EMOJI_RUN, ' ').replace(/[ \t]{2,}/g, ' ').trim();
      const bullet = /^[•\-–]\s*/.test(l);
      l = stripNumbering(l);
      return l && bullet ? '• ' + l : l;
    }).filter(Boolean).join('\n');
  }
  const oneLine = (s) => str(s).replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ');

  function findLessonSheet(wb, n) {
    if (!n) return null;
    const exact = new RegExp(`^\\s*(שיעור|מטלה|שבוע|lesson|week)\\s*0*${n}\\s*$`, 'i');
    const loose = new RegExp(`(שיעור|lesson)\\D*0*${n}(\\D|$)`, 'i');
    return wb.sheetNames.find((s) => exact.test(s)) || wb.sheetNames.find((s) => loose.test(s)) || null;
  }

  async function resolveList(wb, sheetName, f1) {
    f1 = (f1 || '').trim();
    if (f1.startsWith('"')) return f1.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
    const m = /^(?:'([^']+)'!|([^'!]+)!)?\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/i.exec(f1);
    if (!m) return [];
    const sh = await wb.load(m[1] || m[2] || sheetName);
    const c1 = colToIdx(m[3]), r1 = +m[4], c2 = m[5] ? colToIdx(m[5]) : c1, r2 = m[6] ? +m[6] : r1;
    const out = [];
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) { const v = str(sh.value(c, r)); if (v) out.push(v); }
    return out;
  }

  async function parseLesson(wb, sheetName) {
    await wb.loadAll(); // formulas may reference other sheets (e.g. "weights")
    const sh = wb.sheet(sheetName);
    if (!sh) throw new Error('גיליון לא נמצא: ' + sheetName);

    // Header row: the row that contains "שם החניכה".
    let headerRow = 0, nameCol = 0;
    for (let r = 1; r <= 10 && !headerRow; r++) {
      for (const c of sh.rowCells(r)) {
        if (/שם\s*ה?(חניכ|תלמיד|סטודנט)/.test(str(c.v))) { headerRow = r; nameCol = c.col; break; }
      }
    }
    if (!headerRow) throw new Error(`בגיליון "${sheetName}" לא נמצאה שורת כותרות ("שם החניכה")`);
    const subRow = headerRow + 1;
    const heads = sh.rowCells(headerRow).filter((c) => str(c.v) && c.col > nameCol);
    const find = (re) => heads.find((h) => re.test(str(h.v)));
    const gradeH = find(/^ציון/), openingH = find(/פתיחת/), feedbackH = find(/משוב/);
    const special = new Set([gradeH, openingH, feedbackH].filter(Boolean).map((h) => h.col));

    // First data row = first row (after headers) holding the grade / feedback formula.
    let dataRow = 0;
    for (let r = subRow + 1; r <= subRow + 10 && !dataRow; r++) {
      if ((gradeH && sh.formula(gradeH.col, r)) || (feedbackH && sh.formula(feedbackH.col, r))) dataRow = r;
    }
    if (!dataRow) for (let r = subRow + 1; r <= subRow + 10 && !dataRow; r++) if (typeof sh.value(1, r) === 'number') dataRow = r;
    if (!dataRow) dataRow = subRow + 2;

    const allCols = heads.map((h) => h.col).sort((a, b) => a - b);
    const categories = [];
    const fields = [];
    for (const h of heads.filter((x) => !special.has(x.col))) {
      const end = allCols.find((c) => c > h.col) || h.col + 3;
      const cat = { name: stripEmoji(oneLine(h.v)), col: h.col, fields: [] };
      for (let c = h.col; c < end; c++) {
        const sub = oneLine(sh.value(c, subRow));
        const role = /ציון|ניקוד/.test(sub) ? 'score' : /לשימור/.test(sub) ? 'keep' : /לשיפור/.test(sub) ? 'improve' : null;
        if (!role) continue;
        const f = { col: c, letter: idxToCol(c), category: cat.name, role, header: sub };
        const v = sh.validationAt(c, dataRow);
        if (v) {
          f.prompt = v.prompt;
          if (v.type === 'list') f.options = await resolveList(wb, sheetName, v.formula1);
          else if (v.type === 'decimal' || v.type === 'whole') { f.min = Number(v.formula1); f.max = Number(v.formula2); }
        }
        if (role === 'score' && f.min === undefined) {
          const m = /(\d+)\s*-\s*(\d+)/.exec(sub);
          if (m) { f.min = +m[1]; f.max = +m[2]; }
        }
        cat.fields.push(f);
        fields.push(f);
      }
      categories.push(cat);
    }
    if (openingH) fields.push({ col: openingH.col, letter: idxToCol(openingH.col), category: '', role: 'opening', header: oneLine(openingH.v) });

    const gradeFormula = gradeH ? sh.formula(gradeH.col, dataRow) : null;
    const feedbackFormula = feedbackH ? sh.formula(feedbackH.col, dataRow) : null;

    // Weights referenced by the grade formula, e.g. weights!$B$3*((G5)/4)
    const weights = [];
    if (gradeFormula) {
      const re = /(?:'([^']+)'|([A-Za-z_֐-׿][\w֐-׿]*))!\$?([A-Z]+)\$?(\d+)\s*\*\s*\(*\s*\$?([A-Z]+)\$?\d+\s*\)*\s*\/\s*(\d+(?:\.\d+)?)/g;
      for (const m of gradeFormula.matchAll(re)) {
        const wsName = m[1] || m[2];
        const ws = wb.sheet(wsName);
        const col = colToIdx(m[5]);
        const field = fields.find((f) => f.col === col);
        weights.push({
          label: ws ? oneLine(ws.value(1, +m[4])) : '', weight: ws ? ws.value(colToIdx(m[3]), +m[4]) : null,
          col, letter: m[5], divisor: +m[6], category: field ? field.category : '',
        });
      }
    }

    // Rubric block below the student rows: title, notes, criteria table.
    let title = '', criteria = [], levels = [], notes = [];
    let titleRow = 0, critRow = 0;
    for (let r = dataRow + 1; r <= sh.maxRow; r++) {
      for (const c of sh.rowCells(r)) {
        const t = str(c.v);
        if (!titleRow && /^מחוון/.test(t)) { title = oneLine(t); titleRow = r; }
        if (!critRow && t === 'קריטריון') critRow = r;
      }
      if (critRow) break;
    }
    if (critRow) {
      const row = sh.rowCells(critRow);
      const critCol = row.find((c) => str(c.v) === 'קריטריון').col;
      levels = row.filter((c) => /^\d/.test(str(c.v))).map((c) => ({ col: c.col, label: oneLine(c.v) }));
      for (let r = critRow + 1; str(sh.value(critCol, r)); r++) {
        criteria.push({
          name: oneLine(sh.value(critCol, r)),
          levels: levels.map((l) => ({ label: l.label, text: oneLine(sh.value(l.col, r)) })).filter((l) => l.text),
        });
      }
      if (titleRow) for (let r = titleRow; r < critRow; r++) for (const c of sh.rowCells(r)) {
        const t = oneLine(c.v);
        if (t && t !== title) notes.push(t);
      }
    }
    const general = sh.rowCells(1).map((c) => str(c.v)).filter(Boolean).join('\n');

    return {
      sheet: sheetName, headerRow, dataRow, nameCol, categories, fields, weights,
      gradeCol: gradeH ? gradeH.col : null, feedbackCol: feedbackH ? feedbackH.col : null,
      gradeFormula, feedbackFormula, title, notes, criteria, general,
      hasRubricTable: criteria.length > 0,
      optionCount: fields.reduce((n, f) => n + (f.options ? f.options.length : 0), 0),
    };
  }

  // ---------- describe for the AI ----------
  const ROLE_LABEL = { score: 'ציון', keep: 'נקודות לשימור', improve: 'נקודות לשיפור', opening: 'פתיחה אישית' };

  function fieldLabel(f) {
    if (f.role === 'opening') return f.header;
    return `${f.category} – ${ROLE_LABEL[f.role]}`;
  }

  function describeLesson(lesson) {
    const L = [];
    L.push(`גיליון: "${lesson.sheet}"`);
    if (lesson.title) L.push(lesson.title);
    for (const n of lesson.notes) L.push(n);
    if (lesson.general) L.push('', 'הנחיות כלליות מהגיליון:', lesson.general);

    if (lesson.weights.length) {
      L.push('', 'שקלול הציון הסופי (מהנוסחה בגיליון):');
      for (const w of lesson.weights) {
        L.push(`  • ${w.category || w.label}: משקל ${w.weight} × (ניקוד ÷ ${w.divisor})  [עמודה ${w.letter}]`);
      }
    } else if (lesson.gradeFormula) {
      L.push('', `נוסחת הציון בגיליון: =${lesson.gradeFormula}`);
    }

    if (lesson.criteria.length) {
      L.push('', 'טבלת קריטריונים:');
      for (const c of lesson.criteria) {
        L.push(`■ ${c.name}`);
        for (const l of c.levels) L.push(`    ${l.label}: ${l.text}`);
      }
    }

    L.push('', 'שדות למילוי (לפי עמודות הגיליון):');
    for (const f of lesson.fields) {
      let kind;
      if (f.role === 'score') kind = f.min !== undefined ? `מספר בין ${f.min} ל-${f.max}` : 'מספר';
      else if (f.role === 'opening') kind = 'טקסט חופשי (משפט פתיחה אישי לחניכה)';
      else kind = f.options && f.options.length
        ? 'משפט אחד בלבד – הבולט והרלוונטי ביותר מהרשימה (או משפט חופשי אחד אם אין מתאים)'
        : 'משפט חופשי אחד בלבד';
      L.push(`[${f.letter}] ${fieldLabel(f)} — ${kind}`);
      // Plain bullets (no numbers) so the AI copies the sentence itself, not a list index.
      if (f.options && f.options.length) for (const o of f.options) L.push(`      • ${stripNumbering(o)}`);
    }
    return L.join('\n');
  }

  function jsonTemplate(lesson) {
    const o = {};
    for (const f of lesson.fields) o[f.letter] = f.role === 'score' ? 0 : '';
    return JSON.stringify(o, null, 2);
  }

  function responseInstructions(lesson) {
    const sentenceCols = lesson.fields.filter((f) => f.role === 'keep' || f.role === 'improve').map((f) => f.letter);
    return [
      'פורמט התשובה הנדרש:',
      `בסוף התשובה יש להחזיר בלוק JSON אחד בלבד (בתוך \`\`\`json) עם המפתחות של עמודות הגיליון "${lesson.sheet}":`,
      '- ציון/ניקוד: מספר בטווח שצוין.',
      `- נקודות לשימור / לשיפור (${sentenceCols.join(', ')}): מחרוזת אחת בלבד עם משפט אחד בלבד – המשפט הבולט והרלוונטי ביותר לחניכה זו.`,
      '  יש להעתיק את המשפט מהרשימה של אותה עמודה כלשונו. רק אם אף משפט ברשימה אינו מתאים – לכתוב משפט חופשי אחד.',
      '  אסור להחזיר מערך, אסור לחבר כמה משפטים, ואסור לכתוב יותר ממשפט אחד בשדה.',
      '- אסור לכתוב ", " (פסיק ורווח) בתוך המשפט – הגיליון מפצל לפי זה. יש להשתמש ב-" - " במקום.',
      '- אם אין נקודה לשיפור בקטגוריה – להשתמש במשפט "אין נקודות לשיפור. כל הכבוד!" אם הוא ברשימה.',
      '- המשפט עצמו בלבד: בלי מספור (כמו "1."), בלי מקף או תבליט בתחילתו ובלי אימוג\'י.',
      '- יש לכתוב באותו סגנון ובאותה לשון פנייה כמו משפטי הרשימה – בטון חם ומעודד של מדריך/ה, כמו משוב שנכתב ביד.',
      `- פתיחה אישית: משפט או שניים בפנייה ישירה לחניכה – אישי וחם, שמתייחס למשהו ספציפי מההגשה שלה.`,
      '',
      '```json',
      jsonTemplate(lesson),
      '```',
    ].join('\n');
  }

  // ---------- AI answer -> sheet row ----------
  function extractJson(text) {
    const fenced = [...String(text).matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1]).reverse();
    const candidates = [...fenced];
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a >= 0 && b > a) candidates.push(text.slice(a, b + 1));
    for (const c of candidates) {
      try { const o = JSON.parse(c.trim()); if (o && typeof o === 'object') return o; } catch (_) { /* try next */ }
    }
    throw new Error('לא נמצא JSON תקין בתשובת ה-AI');
  }

  function parseAiResponse(text, lesson) {
    const obj = extractJson(text);
    const upper = {};
    for (const [k, v] of Object.entries(obj)) upper[k.trim().toUpperCase()] = v;
    const inputs = {};
    const warnings = [];
    for (const f of lesson.fields) {
      const raw = upper[f.letter];
      if (raw === undefined || raw === null || raw === '') continue;
      if (f.role === 'score') {
        const n = Number(raw);
        if (isNaN(n)) { warnings.push(`[${f.letter}] ערך לא מספרי: ${raw}`); continue; }
        if (f.min !== undefined && (n < f.min || n > f.max)) warnings.push(`[${f.letter}] ${n} מחוץ לטווח ${f.min}-${f.max}`);
        inputs[f.col] = n;
      } else if (f.role === 'opening') {
        // An emoji used as a separator between words ("היי נועה ✨ ראיתי") becomes a comma.
        const opening = String(raw).replace(new RegExp(`(?<=[\\p{L}\\p{N}])${EMOJI_RUN.source}(?=[\\p{L}\\p{N}])`, 'gu'), ', ');
        inputs[f.col] = stripEmoji(opening).replace(/[ \t]+\n/g, '\n');
      } else {
        // Exactly one sentence per field.
        const list = (Array.isArray(raw) ? raw : [raw]).map((s) => String(s).trim()).filter(Boolean);
        if (!list.length) continue;
        if (list.length > 1) warnings.push(`[${f.letter}] התקבלו ${list.length} משפטים – נשמר רק הראשון`);
        const sentence = stripNumbering(stripEmoji(list[0].replace(/\s*\n\s*/g, ' '))).replace(/,\s+/g, ' - ');
        if (!sentence) continue;
        if (f.options && f.options.length && !f.options.map(stripNumbering).includes(sentence)) warnings.push(`[${f.letter}] משפט חופשי (לא מהרשימה)`);
        inputs[f.col] = sentence;
      }
    }
    return { inputs, warnings };
  }

  function fallbackFeedback(lesson, inputs) {
    const L = [];
    const opening = lesson.fields.find((f) => f.role === 'opening');
    if (opening && inputs[opening.col]) L.push(inputs[opening.col]);
    L.push('יש לשים לב ולהתייחס למרכיבים הבאים:');
    for (const cat of lesson.categories) {
      const keep = cat.fields.find((f) => f.role === 'keep');
      const imp = cat.fields.find((f) => f.role === 'improve');
      const kv = keep && inputs[keep.col], iv = imp && inputs[imp.col];
      if (!kv && !iv) continue;
      L.push(cat.name);
      if (kv) L.push('נקודות לשימור:', '• ' + kv.split(', ').join('\n• '));
      if (iv) L.push('נקודות לשיפור:', '• ' + iv.split(', ').join('\n• '));
    }
    L.push('נתראה בשיעור הבא!');
    return L.join('\n');
  }

  // Evaluates the sheet's grade/feedback formulas on a virtual row filled with `inputs` ({ colIndex: value }).
  function computeRow(wb, lesson, inputs, studentName) {
    const ctx = {
      get(sheet, c, r) {
        const s = sheet || lesson.sheet;
        if (s === lesson.sheet && r === lesson.dataRow) {
          if (c === lesson.nameCol) return studentName || null;
          const v = inputs[c];
          return v === undefined || v === '' ? null : v;
        }
        const sh = wb.sheet(s);
        return sh ? sh.value(c, r) : { error: '#REF!' };
      },
    };
    const run = (f) => {
      if (!f) return null;
      try {
        const v = Formula.evaluate(Formula.parse(f), ctx);
        return Formula.isErr(v) ? v.error : Formula.text(v);
      } catch (e) {
        return '#ERROR: ' + e.message;
      }
    };
    const grade = run(lesson.gradeFormula);
    let feedback = run(lesson.feedbackFormula);
    let usedFallback = false;
    if (feedback === null || /^#/.test(feedback)) { feedback = fallbackFeedback(lesson, inputs); usedFallback = true; }
    return { grade, feedback: cleanFeedback(feedback), usedFallback };
  }

  // Tab-separated row for pasting into the sheet, from the first to the last input column.
  function sheetRowTsv(lesson, inputs) {
    const cols = lesson.fields.map((f) => f.col);
    const from = Math.min(...cols), to = Math.max(...cols);
    const cells = [];
    for (let c = from; c <= to; c++) {
      const v = inputs[c] === undefined || inputs[c] === null ? '' : String(inputs[c]);
      cells.push(/[\t\n"]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
    }
    return { tsv: cells.join('\t'), startCell: idxToCol(from), endCell: idxToCol(to) };
  }

  // ---------- locate the student's row ----------
  const normName = (s) => str(s).replace(/["'׳״`]/g, '').replace(/\s+/g, ' ').toLowerCase();

  // Data rows = rows from dataRow that carry the row formulas (or a running number in column A).
  function dataRows(sheet, lesson) {
    const rows = [];
    for (let r = lesson.dataRow; r <= sheet.maxRow + 1; r++) {
      const has = (lesson.gradeCol && sheet.formula(lesson.gradeCol, r)) ||
        (lesson.feedbackCol && sheet.formula(lesson.feedbackCol, r)) || typeof sheet.value(1, r) === 'number';
      if (!has) break;
      rows.push(r);
    }
    return rows;
  }

  // -> { row, isNew, matchedName } ; throws if no free row is left.
  function findStudentRow(sheet, lesson, studentName) {
    const target = normName(studentName);
    if (!target) throw new Error('חסר שם חניכה');
    const rows = dataRows(sheet, lesson);
    const names = rows.map((r) => ({ r, name: str(sheet.value(lesson.nameCol, r)) })).filter((x) => x.name);
    const exact = names.find((x) => normName(x.name) === target);
    if (exact) return { row: exact.r, isNew: false, matchedName: exact.name };
    // Partial match (e.g. sheet has only the first name), only when unambiguous.
    const partial = names.filter((x) => {
      const n = normName(x.name);
      return n.length >= 2 && (target.split(' ').includes(n) || target.startsWith(n + ' ') || n.startsWith(target + ' '));
    });
    if (partial.length === 1) return { row: partial[0].r, isNew: false, matchedName: partial[0].name };
    const inputCols = lesson.fields.map((f) => f.col);
    const free = rows.find((r) => !str(sheet.value(lesson.nameCol, r)) && inputCols.every((c) => sheet.value(c, r) === null));
    if (!free) throw new Error(`אין שורה פנויה בגיליון "${lesson.sheet}" (שורות ${rows[0]}–${rows[rows.length - 1]})`);
    return { row: free, isNew: true, matchedName: '' };
  }

  const api = {
    findLessonSheet, parseLesson, describeLesson, responseInstructions, jsonTemplate,
    parseAiResponse, computeRow, sheetRowTsv, findStudentRow,
    cleanFeedback, stripEmoji, stripNumbering,
  };
  root.Rubric = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
