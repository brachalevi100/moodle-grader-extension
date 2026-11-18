// Writes values into one row of an .xlsx sheet by patching the sheet XML in place.
// Untouched: styles, merges, validations, formulas and every other sheet/part of the workbook.
(function (root) {
  'use strict';
  const MiniZip = root.MiniZip || (typeof require !== 'undefined' ? require('./zip.js') : null);
  const Formula = root.Formula || (typeof require !== 'undefined' ? require('./formula.js') : null);
  const { colToIdx, idxToCol } = Formula;

  const esc = (s) => String(s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function cellAttrs(cellXml) {
    const open = /^<c\b([^>]*?)\/?>/.exec(cellXml)[1];
    const get = (n) => { const m = new RegExp(`\\b${n}="([^"]*)"`).exec(open); return m ? m[1] : null; };
    return { r: get('r'), s: get('s') };
  }

  // A plain value cell (number / inline string / empty), keeping the original style.
  function valueCell(ref, style, value) {
    const s = style !== null && style !== undefined ? ` s="${style}"` : '';
    if (value === null || value === undefined || value === '') return style !== null && style !== undefined ? `<c r="${ref}"${s}/>` : '';
    if (typeof value === 'number' && isFinite(value)) return `<c r="${ref}"${s}><v>${value}</v></c>`;
    return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
  }

  // Keeps the formula of a cell but refreshes its cached result.
  function withCachedValue(cellXml, value) {
    const f = /<f\b[^>]*?(?:\/>|>[\s\S]*?<\/f>)/.exec(cellXml);
    if (!f) return cellXml;
    const { r, s } = cellAttrs(cellXml);
    const sAttr = s !== null ? ` s="${s}"` : '';
    const num = typeof value === 'number' || (value !== '' && value !== null && !isNaN(Number(value)) && /^-?\d+(\.\d+)?$/.test(String(value)));
    if (num) return `<c r="${r}"${sAttr}>${f[0]}<v>${Number(value)}</v></c>`;
    return `<c r="${r}"${sAttr} t="str">${f[0]}<v>${esc(value === null ? '' : value)}</v></c>`;
  }

  // values / cached: { colIndex: value }
  function patchSheetXml(xml, rowNum, values, cached) {
    const rowRe = new RegExp(`<row\\b(?=[^>]*\\br="${rowNum}")([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/row>)`);
    const m = rowRe.exec(xml);
    let rowAttrs, inner;
    if (m) { rowAttrs = m[1]; inner = m[2] || ''; } else { rowAttrs = ` r="${rowNum}"`; inner = ''; }

    const cells = new Map();
    for (const c of inner.matchAll(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)) {
      const { r } = cellAttrs(c[0]);
      const col = colToIdx(/^[A-Z]+/i.exec(r)[0]);
      cells.set(col, c[0]);
    }
    for (const [colStr, value] of Object.entries(values)) {
      const col = +colStr;
      const old = cells.get(col);
      const style = old ? cellAttrs(old).s : null;
      const xmlCell = valueCell(idxToCol(col) + rowNum, style, value);
      if (xmlCell) cells.set(col, xmlCell); else cells.delete(col);
    }
    for (const [colStr, value] of Object.entries(cached || {})) {
      const old = cells.get(+colStr);
      if (old && value !== null && value !== undefined) cells.set(+colStr, withCachedValue(old, value));
    }
    const newInner = [...cells.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]).join('');
    const cleanAttrs = rowAttrs.replace(/\s+spans="[^"]*"/, ''); // spans is optional; drop it so it can't go stale
    const newRow = `<row${cleanAttrs}>${newInner}</row>`;

    if (m) return xml.slice(0, m.index) + newRow + xml.slice(m.index + m[0].length);
    // Row did not exist: insert it in order.
    if (/<sheetData\s*\/>/.test(xml)) return xml.replace(/<sheetData\s*\/>/, `<sheetData>${newRow}</sheetData>`);
    let insertAt = xml.indexOf('</sheetData>');
    for (const rm of xml.matchAll(/<row\b[^>]*\br="(\d+)"/g)) {
      if (+rm[1] > rowNum) { insertAt = rm.index; break; }
    }
    return xml.slice(0, insertAt) + newRow + xml.slice(insertAt);
  }

  // Ask Excel to recalculate every formula when the file is opened.
  function forceRecalc(workbookXml) {
    if (/<calcPr\b/.test(workbookXml)) {
      return workbookXml.replace(/<calcPr\b([^>]*?)(\/?)>/, (_, a, sc) =>
        `<calcPr${a.replace(/\s*fullCalcOnLoad="[^"]*"/, '')} fullCalcOnLoad="1"${sc}>`);
    }
    return workbookXml.replace('</workbook>', '<calcPr fullCalcOnLoad="1"/></workbook>');
  }

  // Newer Excel functions must be stored as "_xlfn.NAME(" inside the file, otherwise Excel shows #NAME?.
  // (Google Sheets exports write plain "TEXTJOIN(" – which breaks the feedback column when Excel recalculates.)
  const FUTURE_FNS = /(?<![\w.])(TEXTJOIN|CONCAT|IFS|SWITCH|MAXIFS|MINIFS|XLOOKUP|XMATCH|FILTER|UNIQUE|SORT|SORTBY|SEQUENCE|LET|IFNA)\(/g;
  // Emoji inside formula text literals (e.g. "📝 שאלות מילוליות" in the feedback template) are removed,
  // so the feedback Excel recalculates matches the clean text the extension produces.
  const EMOJI_RUN = /\s*(?:[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{FE0E}\u{200D}\u{20E3}])+\s*/gu;
  const HAS_EMOJI = /[\p{Extended_Pictographic}\u{FE0F}]/u;
  const xmlText = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const xmlEsc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function cleanFormula(body) {
    let f = xmlText(body).replace(FUTURE_FNS, '_xlfn.$1(');
    if (HAS_EMOJI.test(f)) {
      f = f.replace(/"((?:[^"]|"")*)"/g, (lit, inner) => (HAS_EMOJI.test(inner)
        ? '"' + inner.replace(EMOJI_RUN, ' ').replace(/ {2,}/g, ' ').trim() + '"'
        : lit));
    }
    return xmlEsc(f);
  }

  function fixFutureFunctions(sheetXml) {
    // Opening tag must not be self-closing (<f t="shared" si="1"/> has no body).
    return sheetXml.replace(/(<f>|<f\s[^>]*[^/>]>)([\s\S]*?)(<\/f>)/g, (_, a, body, b) => a + cleanFormula(body) + b);
  }

  // Returns new .xlsx bytes. sheetPath e.g. "xl/worksheets/sheet4.xml".
  async function writeRow(bytes, sheetPath, rowNum, values, cached) {
    const entries = MiniZip.readZip(bytes);
    if (!entries.some((e) => e.name === sheetPath)) throw new Error('הגיליון לא נמצא בקובץ: ' + sheetPath);
    const dec = new TextDecoder('utf-8');
    const enc = new TextEncoder();
    const files = [];
    for (const e of entries) {
      if (e.dir) continue;
      let data = await e.read();
      if (e.name === sheetPath) data = enc.encode(fixFutureFunctions(patchSheetXml(dec.decode(data), rowNum, values, cached)));
      else if (/^xl\/worksheets\/[^/]+\.xml$/.test(e.name)) data = enc.encode(fixFutureFunctions(dec.decode(data)));
      else if (e.name === 'xl/workbook.xml') data = enc.encode(forceRecalc(dec.decode(data)));
      else if (e.name === 'xl/calcChain.xml') continue; // optional; Excel rebuilds it
      files.push({ name: e.name, data });
    }
    // calcChain removed -> drop its references too.
    for (const f of files) {
      if (f.name === '[Content_Types].xml' || f.name === 'xl/_rels/workbook.xml.rels') {
        const t = dec.decode(f.data);
        if (/calcChain/.test(t)) f.data = enc.encode(t.replace(/<(Override|Relationship)\b[^>]*calcChain[^>]*\/>/g, ''));
      }
    }
    return MiniZip.writeZipCompressed(files);
  }

  const api = { writeRow, patchSheetXml, forceRecalc, fixFutureFunctions };
  root.XlsxWrite = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
