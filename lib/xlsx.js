// Minimal .xlsx reader: values, formulas (incl. shared), data validations. Read-only.
(function (root) {
  'use strict';
  const MiniZip = root.MiniZip || (typeof require !== 'undefined' ? require('./zip.js') : null);
  const Formula = root.Formula || (typeof require !== 'undefined' ? require('./formula.js') : null);
  const { colToIdx, idxToCol } = Formula;

  const unescape = (s) => s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&amp;/g, '&');
  function attrs(s) {
    const o = {};
    for (const m of (s || '').matchAll(/([\w:]+)="([^"]*)"/g)) o[m[1]] = unescape(m[2]);
    return o;
  }
  const richText = (xml) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
    .map((m) => unescape(m[1])).join('');

  function splitRef(ref) {
    const m = /^\$?([A-Z]+)\$?(\d+)$/i.exec(ref);
    return m ? { col: colToIdx(m[1]), row: +m[2] } : null;
  }
  // "A1:B5 D3" -> [{c1,r1,c2,r2}]
  function parseSqref(sq) {
    return (sq || '').trim().split(/\s+/).filter(Boolean).map((part) => {
      const [a, b] = part.split(':').map(splitRef);
      return { c1: a.col, r1: a.row, c2: (b || a).col, r2: (b || a).row };
    });
  }

  function parseSheet(xml, sharedStrings) {
    const cells = new Map(); // "col,row" -> { v, f }
    const masters = {};
    const children = [];
    let maxRow = 0;
    const dataMatch = /<sheetData[^>]*>([\s\S]*?)<\/sheetData>/.exec(xml);
    const data = dataMatch ? dataMatch[1] : '';

    for (const m of data.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = attrs(m[1]);
      const inner = m[2] || '';
      const pos = splitRef(a.r || '');
      if (!pos) continue;
      let v = null;
      const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
      if (a.t === 's' && vm) v = sharedStrings[+vm[1]];
      else if (a.t === 'inlineStr') v = richText(inner);
      else if (a.t === 'str' && vm) v = unescape(vm[1]);
      else if (a.t === 'b' && vm) v = vm[1] === '1';
      else if (a.t === 'e' && vm) v = { error: vm[1] };
      else if (vm) v = Number(vm[1]);

      let f = null;
      const fm = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/.exec(inner);
      if (fm) {
        const fa = attrs(fm[1]);
        const ftext = fm[2] !== undefined ? unescape(fm[2]) : '';
        if (fa.t === 'shared') {
          if (ftext) { masters[fa.si] = { f: ftext, ...pos }; f = ftext; } else children.push({ si: fa.si, ...pos });
        } else if (ftext) f = ftext;
      }
      if (v === null && f === null && !(fm && fm[1].includes('shared'))) continue;
      cells.set(pos.col + ',' + pos.row, { v, f });
      if (pos.row > maxRow) maxRow = pos.row;
    }
    for (const ch of children) {
      const ms = masters[ch.si];
      const cell = cells.get(ch.col + ',' + ch.row);
      if (ms && cell) cell.f = Formula.shiftFormula(ms.f, ch.row - ms.row, ch.col - ms.col);
    }

    const validations = [];
    for (const m of xml.matchAll(/<dataValidation\b([^>]*)>([\s\S]*?)<\/dataValidation>/g)) {
      const a = attrs(m[1]);
      const f1 = /<formula1>([\s\S]*?)<\/formula1>/.exec(m[2]);
      const f2 = /<formula2>([\s\S]*?)<\/formula2>/.exec(m[2]);
      validations.push({ type: a.type, prompt: a.prompt || '', areas: parseSqref(a.sqref),
        formula1: f1 ? unescape(f1[1]) : '', formula2: f2 ? unescape(f2[1]) : '' });
    }
    // Excel 2010+ stores some validations (e.g. lists from other sheets) in an extension block.
    for (const m of xml.matchAll(/<x14:dataValidation\b([^>]*)>([\s\S]*?)<\/x14:dataValidation>/g)) {
      const a = attrs(m[1]);
      const f1 = /<x14:formula1>\s*<xm:f>([\s\S]*?)<\/xm:f>/.exec(m[2]);
      const f2 = /<x14:formula2>\s*<xm:f>([\s\S]*?)<\/xm:f>/.exec(m[2]);
      const sq = /<xm:sqref>([\s\S]*?)<\/xm:sqref>/.exec(m[2]);
      validations.push({ type: a.type, prompt: a.prompt || '', areas: parseSqref(sq ? sq[1] : ''),
        formula1: f1 ? unescape(f1[1]) : '', formula2: f2 ? unescape(f2[1]) : '' });
    }

    return {
      maxRow,
      // col may be a number (1 = A) or a letter ("A").
      cell: (col, row) => cells.get((typeof col === 'string' ? colToIdx(col) : col) + ',' + row) || null,
      value(col, row) { const c = this.cell(col, row); return c ? c.v : null; },
      formula(col, row) { const c = this.cell(col, row); return c ? c.f : null; },
      rowCells(row) {
        const out = [];
        for (const [k, c] of cells) { const [col, r] = k.split(',').map(Number); if (r === row) out.push({ col, ...c }); }
        return out.sort((a, b) => a.col - b.col);
      },
      validationAt(col, row) {
        return validations.find((v) => v.areas.some((a) => col >= a.c1 && col <= a.c2 && row >= a.r1 && row <= a.r2)) || null;
      },
    };
  }

  async function readWorkbook(bytes) {
    const entries = MiniZip.readZip(bytes);
    const read = async (name) => {
      const e = entries.find((x) => x.name === name);
      return e ? new TextDecoder('utf-8').decode(await e.read()) : null;
    };
    const ssXml = await read('xl/sharedStrings.xml');
    const sharedStrings = ssXml ? [...ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => richText(m[1])) : [];
    const wbXml = await read('xl/workbook.xml');
    const relsXml = await read('xl/_rels/workbook.xml.rels');
    if (!wbXml || !relsXml) throw new Error('קובץ ה-Excel אינו תקין');
    const rels = {};
    for (const m of relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)) { const a = attrs(m[1]); rels[a.Id] = a.Target; }

    const sheetDefs = [...wbXml.matchAll(/<sheet\b([^>]*)\/?>/g)].map((m) => {
      const a = attrs(m[1]);
      let target = rels[a['r:id']] || '';
      target = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
      return { name: a.name, path: target, state: a.state || 'visible' };
    });

    const cache = {};
    const wb = {
      sheetNames: sheetDefs.map((s) => s.name),
      async load(name) {
        if (cache[name]) return cache[name];
        const def = sheetDefs.find((s) => s.name === name);
        if (!def) throw new Error('גיליון לא נמצא: ' + name);
        cache[name] = parseSheet(await read(def.path), sharedStrings);
        return cache[name];
      },
      // Synchronous access to an already-loaded sheet.
      sheet(name) { return cache[name] || null; },
      async loadAll() { for (const s of sheetDefs) await wb.load(s.name); return wb; },
    };
    return wb;
  }

  const api = { readWorkbook, parseSqref, colToIdx, idxToCol };
  root.Xlsx = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
