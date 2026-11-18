// Small Excel/Google-Sheets formula evaluator: enough to run the rubric's grade and feedback formulas.
// Values: null (blank), number, string, boolean, { error: '#X' }, { range: [values] }.
(function (root) {
  'use strict';

  const colToIdx = (c) => [...c.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  const idxToCol = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

  const REF = String.raw`\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?`;

  function parseRef(sheet, text) {
    const [a, b] = text.replace(/\$/g, '').split(':');
    const p = (x) => { const m = /^([A-Z]+)(\d+)$/i.exec(x); return [colToIdx(m[1]), +m[2]]; };
    const [c1, r1] = p(a);
    const [c2, r2] = b ? p(b) : [null, null];
    return { t: 'ref', sheet, c1, r1, c2, r2 };
  }

  function tokenize(src) {
    const toks = [];
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      const rest = src.slice(i);
      let m;
      if (/\s/.test(ch)) { i++; continue; }
      if (ch === '"') {
        let j = i + 1, s = '';
        for (;;) {
          if (j >= src.length) throw new Error('Unterminated string');
          if (src[j] === '"') { if (src[j + 1] === '"') { s += '"'; j += 2; continue; } break; }
          s += src[j++];
        }
        toks.push({ t: 'str', v: s }); i = j + 1; continue;
      }
      if (ch === "'") {
        let j = i + 1, s = '';
        while (j < src.length && !(src[j] === "'" && src[j + 1] !== "'")) { s += src[j]; j += src[j] === "'" ? 2 : 1; }
        i = j + 1;
        if (src[i] !== '!') throw new Error('Bad sheet reference');
        m = new RegExp('^' + REF, 'i').exec(src.slice(i + 1));
        if (!m) throw new Error('Bad reference after sheet name');
        toks.push(parseRef(s, m[0])); i += 1 + m[0].length; continue;
      }
      if ((m = /^#(REF!|N\/A|VALUE!|DIV\/0!|NAME\?|NUM!|NULL!)/.exec(rest))) { toks.push({ t: 'err', v: m[0] }); i += m[0].length; continue; }
      if ((m = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest))) { toks.push({ t: 'num', v: parseFloat(m[0]) }); i += m[0].length; continue; }
      if ((m = new RegExp(String.raw`^([A-Za-z_֐-׿][\w.֐-׿]*)!(${REF})`, 'i').exec(rest))) {
        toks.push(parseRef(m[1], m[2])); i += m[0].length; continue;
      }
      if ((m = /^(TRUE|FALSE)(?![\w(])/i.exec(rest))) { toks.push({ t: 'bool', v: m[1].toUpperCase() === 'TRUE' }); i += m[0].length; continue; }
      if ((m = new RegExp('^' + REF + String.raw`(?![\w(])`, 'i').exec(rest))) { toks.push(parseRef(null, m[0])); i += m[0].length; continue; }
      if ((m = /^[A-Za-z_][\w.]*(?=\s*\()/.exec(rest))) { toks.push({ t: 'func', v: m[0].toUpperCase().replace(/^_XLFN\./, '') }); i += m[0].length; continue; }
      if ((m = /^(<>|<=|>=|[-+*/^&=<>(),%;])/.exec(rest))) { toks.push({ t: 'op', v: m[0] === ';' ? ',' : m[0] }); i += m[0].length; continue; }
      throw new Error('Unexpected character in formula: ' + rest.slice(0, 15));
    }
    return toks;
  }

  function parse(src) {
    const toks = tokenize(src.replace(/^=/, ''));
    let p = 0;
    const peek = () => toks[p];
    const isOp = (v) => toks[p] && toks[p].t === 'op' && toks[p].v === v;
    const expect = (v) => { if (!isOp(v)) throw new Error(`Expected "${v}"`); p++; };
    const CMP = ['=', '<>', '<', '>', '<=', '>='];

    function binLoop(next, ops) {
      return () => {
        let l = next();
        while (peek() && peek().t === 'op' && ops.includes(peek().v)) { const o = toks[p++].v; l = { k: 'bin', o, l, r: next() }; }
        return l;
      };
    }
    function primary() {
      const t = toks[p++];
      if (!t) throw new Error('Unexpected end of formula');
      if (t.t === 'num' || t.t === 'str' || t.t === 'bool') return { k: 'lit', v: t.v };
      if (t.t === 'err') return { k: 'lit', v: { error: t.v } };
      if (t.t === 'ref') return { k: 'ref', ...t };
      if (t.t === 'func') {
        expect('(');
        const args = [];
        if (!isOp(')')) {
          for (;;) {
            args.push(isOp(',') || isOp(')') ? { k: 'lit', v: null } : expr());
            if (isOp(',')) { p++; continue; }
            break;
          }
        }
        expect(')');
        return { k: 'call', name: t.v, args };
      }
      if (t.t === 'op' && t.v === '(') { const e = expr(); expect(')'); return e; }
      throw new Error('Unexpected token ' + JSON.stringify(t));
    }
    function postfix() { let e = primary(); while (isOp('%')) { p++; e = { k: 'bin', o: '/', l: e, r: { k: 'lit', v: 100 } }; } return e; }
    function unary() {
      if (isOp('-')) { p++; return { k: 'neg', e: unary() }; }
      if (isOp('+')) { p++; return unary(); }
      return postfix();
    }
    const pow = binLoop(unary, ['^']);
    const mul = binLoop(pow, ['*', '/']);
    const add = binLoop(mul, ['+', '-']);
    const concat = binLoop(add, ['&']);
    const expr = binLoop(concat, CMP);
    const ast = expr();
    if (p < toks.length) throw new Error('Unexpected trailing tokens in formula');
    return ast;
  }

  // ---------- evaluation ----------
  const isErr = (v) => v !== null && typeof v === 'object' && 'error' in v;
  const isRange = (v) => v !== null && typeof v === 'object' && 'range' in v;
  const scalar = (v) => (isRange(v) ? (v.range.length ? v.range[0] : null) : v);
  const flat = (vals) => vals.flatMap((v) => (isRange(v) ? v.range : [v]));

  function text(v) {
    v = scalar(v);
    if (v === null || v === undefined) return '';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (typeof v === 'number') return String(Number(v.toPrecision(15)));
    return String(v);
  }
  function num(v) {
    v = scalar(v);
    if (isErr(v)) return v;
    if (v === null || v === '') return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    const n = Number(String(v).trim());
    return String(v).trim() !== '' && !isNaN(n) ? n : { error: '#VALUE!' };
  }
  function truthy(v) {
    v = scalar(v);
    if (isErr(v)) return v;
    if (v === null) return false;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (/^true$/i.test(v)) return true;
    if (/^false$/i.test(v)) return false;
    return { error: '#VALUE!' };
  }
  function compare(a, b) {
    a = scalar(a); b = scalar(b);
    const kind = (v) => (typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : typeof v === 'boolean' ? 2 : -1);
    if (a === null) a = typeof b === 'number' ? 0 : typeof b === 'boolean' ? false : '';
    if (b === null) b = typeof a === 'number' ? 0 : typeof a === 'boolean' ? false : '';
    const ka = kind(a), kb = kind(b);
    if (ka !== kb) return ka - kb;
    if (ka === 1) { a = a.toLowerCase(); b = b.toLowerCase(); }
    return a < b ? -1 : a > b ? 1 : 0;
  }
  function round(x, d) {
    const s = x < 0 ? -1 : 1;
    return s * Number(Math.round(Number(Math.abs(x) + 'e' + d)) + 'e' + -d);
  }

  function evaluate(ast, ctx) {
    function ev(n) {
      switch (n.k) {
        case 'lit': return n.v;
        case 'ref': {
          if (n.c2 === null) return ctx.get(n.sheet, n.c1, n.r1);
          const out = [];
          for (let r = Math.min(n.r1, n.r2); r <= Math.max(n.r1, n.r2); r++)
            for (let c = Math.min(n.c1, n.c2); c <= Math.max(n.c1, n.c2); c++) out.push(ctx.get(n.sheet, c, r));
          return { range: out };
        }
        case 'neg': { const v = num(ev(n.e)); return isErr(v) ? v : -v; }
        case 'bin': return bin(n.o, ev(n.l), ev(n.r));
        case 'call': return call(n.name, n.args);
      }
      throw new Error('Bad AST node');
    }
    function bin(o, a, b) {
      a = scalar(a); b = scalar(b);
      if (isErr(a)) return a;
      if (isErr(b)) return b;
      if (o === '&') return text(a) + text(b);
      if (['=', '<>', '<', '>', '<=', '>='].includes(o)) {
        const c = compare(a, b);
        return { '=': c === 0, '<>': c !== 0, '<': c < 0, '>': c > 0, '<=': c <= 0, '>=': c >= 0 }[o];
      }
      const x = num(a), y = num(b);
      if (isErr(x)) return x;
      if (isErr(y)) return y;
      switch (o) {
        case '+': return x + y;
        case '-': return x - y;
        case '*': return x * y;
        case '/': return y === 0 ? { error: '#DIV/0!' } : x / y;
        case '^': return Math.pow(x, y);
      }
    }
    function nums(args, strict) {
      const out = [];
      for (const a of args) {
        const v = ev(a);
        if (isRange(v)) { for (const x of v.range) { if (isErr(x)) return x; if (typeof x === 'number') out.push(x); } }
        else { const n = num(v); if (isErr(n)) { if (strict) return n; } else if (v !== null) out.push(n); }
      }
      return out;
    }
    function call(name, args) {
      const A = (i) => (args[i] ? ev(args[i]) : null);
      switch (name) {
        case 'IF': {
          const c = truthy(A(0));
          if (isErr(c)) return c;
          if (c) return args.length > 1 ? A(1) : true;
          return args.length > 2 ? A(2) : false;
        }
        case 'IFERROR': { const v = A(0); return isErr(scalar(v)) ? A(1) : v; }
        case 'AND': case 'OR': {
          const vals = flat(args.map(ev)).filter((v) => v !== null && typeof v !== 'string');
          for (const v of vals) if (isErr(v)) return v;
          if (!vals.length) return { error: '#VALUE!' };
          return name === 'AND' ? vals.every((v) => truthy(v)) : vals.some((v) => truthy(v));
        }
        case 'NOT': { const t = truthy(A(0)); return isErr(t) ? t : !t; }
        case 'ISBLANK': return scalar(A(0)) === null;
        case 'ISNUMBER': return typeof scalar(A(0)) === 'number';
        case 'ISTEXT': return typeof scalar(A(0)) === 'string';
        case 'ISERROR': return isErr(scalar(A(0)));
        case 'COUNTA': return flat(args.map(ev)).filter((v) => v !== null).length;
        case 'COUNT': return flat(args.map(ev)).filter((v) => typeof v === 'number').length;
        case 'COUNTBLANK': return flat(args.map(ev)).filter((v) => v === null || v === '').length;
        case 'SUM': { const n = nums(args, true); return isErr(n) ? n : n.reduce((a, b) => a + b, 0); }
        case 'AVERAGE': { const n = nums(args, true); return isErr(n) ? n : n.length ? n.reduce((a, b) => a + b, 0) / n.length : { error: '#DIV/0!' }; }
        case 'MIN': { const n = nums(args, true); return isErr(n) ? n : n.length ? Math.min(...n) : 0; }
        case 'MAX': { const n = nums(args, true); return isErr(n) ? n : n.length ? Math.max(...n) : 0; }
        case 'ROUND': case 'ROUNDUP': case 'ROUNDDOWN': {
          const x = num(A(0)), d = args.length > 1 ? num(A(1)) : 0;
          if (isErr(x)) return x;
          if (isErr(d)) return d;
          if (name === 'ROUND') return round(x, d);
          const f = Math.pow(10, d), s = x < 0 ? -1 : 1;
          return s * (name === 'ROUNDUP' ? Math.ceil(Math.abs(x) * f - 1e-9) : Math.floor(Math.abs(x) * f + 1e-9)) / f;
        }
        case 'INT': { const x = num(A(0)); return isErr(x) ? x : Math.floor(x); }
        case 'ABS': { const x = num(A(0)); return isErr(x) ? x : Math.abs(x); }
        case 'TEXTJOIN': {
          const delim = text(A(0));
          const ignore = truthy(A(1));
          const parts = [];
          for (const v of flat(args.slice(2).map(ev))) {
            if (isErr(v)) return v;
            const t = text(v);
            if (ignore && t === '') continue;
            parts.push(t);
          }
          return parts.join(delim);
        }
        case 'CONCATENATE': case 'CONCAT': {
          let s = '';
          for (const v of flat(args.map(ev))) { if (isErr(v)) return v; s += text(v); }
          return s;
        }
        case 'SUBSTITUTE': {
          const t = text(A(0)), from = text(A(1)), to = text(A(2));
          if (!from) return t;
          if (args.length > 3) {
            const nth = num(A(3));
            let idx = -1;
            for (let k = 0; k < nth; k++) { idx = t.indexOf(from, idx + 1); if (idx < 0) return t; }
            return t.slice(0, idx) + to + t.slice(idx + from.length);
          }
          return t.split(from).join(to);
        }
        case 'CHAR': { const n = num(A(0)); return isErr(n) ? n : String.fromCharCode(n); }
        case 'TRIM': return text(A(0)).replace(/ +/g, ' ').trim();
        case 'LEN': return text(A(0)).length;
        case 'UPPER': return text(A(0)).toUpperCase();
        case 'LOWER': return text(A(0)).toLowerCase();
        case 'VALUE': return num(A(0));
        case 'TEXT': return text(A(0));
      }
      return { error: '#NAME?' };
    }
    return scalar(ev(ast));
  }

  // Shift relative references of a shared formula by (dRow, dCol).
  function shiftFormula(f, dRow, dCol) {
    return f.split(/("(?:[^"]|"")*")/).map((part, i) => (i % 2 ? part : part.replace(
      /(?<![A-Za-z_\d.])(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\w(])/g,
      (_, cAbs, col, rAbs, row) => cAbs + (cAbs ? col : idxToCol(colToIdx(col) + dCol)) + rAbs + (rAbs ? row : +row + dRow)
    ))).join('');
  }

  const api = { parse, evaluate, shiftFormula, colToIdx, idxToCol, text, isErr };
  root.Formula = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
