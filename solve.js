// Fast drop-in for makefun-site 1.0.0 (spec: vendor/makefun-site/README.md).
// Written from the spec; behaviour matches the reference byte for byte.
// Speed ideas: templates compile once per case to flat opcodes run by a
// tight interpreter; Markdown is scanned line by line without per-line
// regexes; the inline renderer jumps between special characters with one
// native regex scan instead of a per-character loop; slugs are cached per
// case; bodies are kept as line arrays (no join/split round trip); cards
// and page objects are built once and reused; word counting uses a
// whitespace table for ASCII. Nothing is kept from one run() call to the
// next: every cache lives in the per-call state created inside run().

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ESC_TEST = /[&<>"']/;
const ESC_REP = /[&<>"']/g;
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const NON_ASCII = /[^\x00-\x7F]/;
const MARK_RE = /\p{M}/gu;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INC_RE = /^include "([a-z0-9-]+)"$/;
const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** HTML-escape, fast path when nothing needs escaping. */
function esc(s) {
  return ESC_TEST.test(s) ? s.replace(ESC_REP, (c) => ESC_MAP[c]) : s;
}

/** Slug of `text`, cached per case in `cache`. */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  if (NON_ASCII.test(text)) plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = '';
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === '') {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  const s = out === '' ? 'untitled' : out;
  cache.set(text, s);
  return s;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqSlug(slug, taken) {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  let n = 2;
  let out;
  do {
    out = slug + '-' + n++;
  } while (taken.has(out));
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(d) {
  return +d.slice(8, 10) + ' ' + MONTHS[+d.slice(5, 7) - 1] + ' ' + d.slice(0, 4);
}

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isBlank(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** A line with spaces/tabs stripped at both ends. */
function trimLine(s) {
  let a = 0;
  let b = s.length;
  while (a < b && (s[a] === ' ' || s[a] === '\t')) a++;
  while (b > a && (s[b - 1] === ' ' || s[b - 1] === '\t')) b--;
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

// ---------------------------------------------------------------- front matter

function stringOf(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

function isDate(raw) {
  if (raw.length !== 10 || raw[4] !== '-' || raw[7] !== '-') return false;
  for (let i = 0; i < 10; i++) {
    if (i === 4 || i === 7) continue;
    const c = raw[i];
    if (c < '0' || c > '9') return false;
  }
  const y = +raw.slice(0, 4);
  const mo = +raw.slice(5, 7);
  const d = +raw.slice(8, 10);
  return y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
}

function nameOk(raw) {
  if (raw === '') return false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-')) return false;
  }
  return true;
}

function slugOk(raw) {
  if (raw.length === 0 || raw.length > 64) return false;
  let prevDash = true; // first char must be alnum
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '-') {
      if (prevDash) return false;
      prevDash = true;
    } else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) prevDash = false;
    else return false;
  }
  return !prevDash; // must not end on '-'
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return s.error !== undefined ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date':
      return isDate(raw) ? { value: raw } : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    case 'tags': {
      if (raw.length < 2 || raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let i = 0; i < t.length; i++) {
          const c = t[i];
          if (c === '"' || c === '[' || c === ']') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return nameOk(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return slugOk(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Parse front matter from a source's lines; `{ data, bodyStart }` or `{ error }`. */
function parseFM(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlank(line) || line[0] === '#') continue;
    let j = 0;
    while (j < line.length) {
      const c = line[j];
      if ((c >= 'a' && c <= 'z') || c === '_') j++;
      else break;
    }
    if (j === 0 || j >= line.length || line[j] !== ':') return { error: `line ${i + 1} is not "key: value"` };
    let raw;
    if (j + 1 === line.length) raw = '';
    else if (line[j + 1] === ' ') raw = line.slice(j + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    let e = raw.length;
    while (e > 0 && (raw[e - 1] === ' ' || raw[e - 1] === '\t')) e--;
    raw = raw.slice(0, e);
    const key = line.slice(0, j);
    if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if (v.error !== undefined) return { error: v.error };
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyStart: close + 1 };
}

// ---------------------------------------------------------------- Markdown

/** Fence language of a fence-open line, or null when it is not one. */
function fenceLang(s) {
  if (!s.startsWith('```')) return null;
  let j = 3;
  while (j < s.length) {
    const c = s[j];
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-') j++;
    else break;
  }
  const lang = s.slice(3, j);
  for (let k = j; k < s.length; k++) {
    const c = s[k];
    if (c !== ' ' && c !== '\t') return null;
  }
  return lang;
}

function isFenceClose(s) {
  if (!s.startsWith('```')) return false;
  for (let i = 3; i < s.length; i++) {
    const c = s[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** A heading line's depth and text, or null. */
function headingOf(line) {
  let c = 0;
  while (c < line.length && line[c] === '#') c++;
  if (c === 0 || c > 6) return null;
  if (c >= line.length || (line[c] !== ' ' && line[c] !== '\t')) return null;
  let s = c;
  while (s < line.length && (line[s] === ' ' || line[s] === '\t')) s++;
  let e = line.length;
  while (e > s && (line[e - 1] === ' ' || line[e - 1] === '\t')) e--;
  if (e === s) return null;
  return { depth: c, text: line.slice(s, e) };
}

function isHR(line) {
  if (line.length < 3) return false;
  const a = line[0];
  const b = line[1];
  const c = line[2];
  if (!((a === '-' && b === '-' && c === '-') || (a === '*' && b === '*' && c === '*'))) return false;
  for (let i = 3; i < line.length; i++) {
    const ch = line[i];
    if (ch !== ' ' && ch !== '\t') return false;
  }
  return true;
}

/** Whether `line` ends a paragraph. */
function endsPara(line) {
  if (line === '') return true;
  const c0 = line[0];
  if (c0 === ' ' || c0 === '\t') return isBlank(line);
  if (c0 === '`') return fenceLang(line) !== null;
  if (c0 === '#') return headingOf(line) !== null;
  if (c0 === '-' || c0 === '*') return isHR(line);
  return false;
}

/** List marker of a line, or null: { ordered, start, text }. */
function listStart(line) {
  if (line[0] === '-' || line[0] === '*') {
    if (line[1] === ' ') return { ordered: false, start: 1, text: line.slice(2) };
    return null;
  }
  let j = 0;
  while (j < line.length && j < 9 && line[j] >= '0' && line[j] <= '9') j++;
  if (j === 0 || line[j] !== '.' || line[j + 1] !== ' ') return null;
  return { ordered: true, start: Number(line.slice(0, j)), text: line.slice(j + 2) };
}

/** Item text when `line` continues a list of `ordered` kind, else null. */
function listMatch(line, ordered) {
  if (!ordered) {
    if ((line[0] === '-' || line[0] === '*') && line[1] === ' ') return line.slice(2);
    return null;
  }
  let j = 0;
  while (j < line.length && j < 9 && line[j] >= '0' && line[j] <= '9') j++;
  if (j === 0 || line[j] !== '.' || line[j + 1] !== ' ') return null;
  return line.slice(j + 2);
}

function isContinued(line) {
  if (line[0] !== ' ' || line[1] !== ' ') return false;
  let k = 2;
  while (k < line.length && line[k] === ' ') k++;
  if (k >= line.length) return false;
  const c = line[k];
  return c !== ' ' && c !== '\t' && c !== '\r' && c !== '\v' && c !== '\f' && c !== '\n' && c !== '\u00a0' && c !== '\u1680' && !(c >= '\u2000' && c <= '\u200a') && c !== '\u2028' && c !== '\u2029' && c !== '\u202f' && c !== '\u205f' && c !== '\u3000' && c !== '\ufeff';
}

/** First index >= `from` holding `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, hi) {
  const wlen = what.length;
  for (let j = from; j <= hi - wlen; j++) {
    if (s[j] === '\\' && j + 1 < hi && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** First single `*` from `from` (one whose run is not `**`), outside an escape, or -1. */
function findSingleStar(s, from, hi) {
  for (let j = from; j < hi; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < hi && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Next inline-special character: backslash, backtick, star, `[`, or one needing escape. */
const INL_RE = /[\\`*\[&<>"']/g;

/** Render `s[lo..hi)` inline into `out`; `link` resolves link targets. */
function inlineInto(s, lo, hi, link, out) {
  let i = lo;
  let plain = lo;
  INL_RE.lastIndex = lo;
  let m;
  while ((m = INL_RE.exec(s)) !== null && m.index < hi) {
    const j = m.index;
    const c = m[0];
    if (c === '\\' && j + 1 < hi && ESCAPABLE.has(s[j + 1])) {
      if (j > plain) out.push(s.slice(plain, j));
      const n = s[j + 1];
      out.push(n === '>' ? '&gt;' : n);
      i = j + 2;
      plain = i;
      INL_RE.lastIndex = i;
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < hi && k > j + 1) {
        if (j > plain) out.push(s.slice(plain, j));
        out.push('<code>', esc(s.slice(j + 1, k)), '</code>');
        i = k + 1;
        plain = i;
        INL_RE.lastIndex = i;
      } else {
        INL_RE.lastIndex = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2, hi);
        if (k !== -1 && k > j + 2) {
          if (j > plain) out.push(s.slice(plain, j));
          out.push('<strong>');
          inlineInto(s, j + 2, k, link, out);
          out.push('</strong>');
          i = k + 2;
          plain = i;
          INL_RE.lastIndex = i;
        } else {
          if (j > plain) out.push(s.slice(plain, j));
          out.push('**');
          i = j + 2;
          plain = i;
          INL_RE.lastIndex = i;
        }
        continue;
      }
      const k = findSingleStar(s, j + 1, hi);
      if (k !== -1 && k > j + 1) {
        if (j > plain) out.push(s.slice(plain, j));
        out.push('<em>');
        inlineInto(s, j + 1, k, link, out);
        out.push('</em>');
        i = k + 1;
        plain = i;
        INL_RE.lastIndex = i;
      } else {
        INL_RE.lastIndex = j + 1;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', j + 1, hi);
      let q = -1;
      if (k !== -1 && k + 1 < hi && s[k + 1] === '(') q = s.indexOf(')', k + 2);
      if (q !== -1 && q < hi) {
        const target = s.slice(k + 2, q);
        if (target !== '' && !/\s/.test(target)) {
          if (j > plain) out.push(s.slice(plain, j));
          out.push('<a href="', esc(link(target)), '">');
          inlineInto(s, j + 1, k, link, out);
          out.push('</a>');
          i = q + 1;
          plain = i;
          INL_RE.lastIndex = i;
          continue;
        }
      }
      INL_RE.lastIndex = j + 1;
      continue;
    }
    // A character needing escape; any other match (a backslash before a
    // non-escapable char) stays in the plain run.
    const e = ENT[c];
    if (e !== undefined) {
      if (j > plain) out.push(s.slice(plain, j));
      out.push(e);
      i = j + 1;
      plain = i;
      INL_RE.lastIndex = i;
    } else {
      INL_RE.lastIndex = j + 1;
    }
  }
  if (hi > plain) out.push(s.slice(plain, hi));
}

function inlineStr(s, link) {
  const out = [];
  inlineInto(s, 0, s.length, link, out);
  return out.join('');
}

/** Render body lines `lines[start..]` to HTML, toc and excerpt. */
function renderMD(lines, start, link, slugCache) {
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  let i = start;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const fl = fenceLang(line);
    if (fl !== null) {
      i++;
      const parts = ['<pre><code' + (fl === '' ? '' : ' class="language-' + fl + '"') + '>'];
      while (i < n && !isFenceClose(lines[i])) {
        parts.push(esc(lines[i]), '\n');
        i++;
      }
      i++;
      parts.push('</code></pre>\n');
      out.push(parts.join(''));
      continue;
    }
    const hd = headingOf(line);
    if (hd !== null) {
      const id = uniqSlug(slugify(hd.text, slugCache), ids);
      const html = inlineStr(hd.text, link);
      out.push('<h' + hd.depth + ' id="' + id + '">' + html + '</h' + hd.depth + '>\n');
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (isHR(line)) {
      out.push('<hr>\n');
      i++;
      continue;
    }
    if (line[0] === '>') {
      const q = [];
      while (i < n && lines[i][0] === '>') {
        const t = lines[i];
        q.push(trimLine(t[1] === ' ' ? t.slice(2) : t.slice(1)));
        i++;
      }
      let any = false;
      for (const l of q) if (l !== '') {
        any = true;
        break;
      }
      if (!any) out.push('<blockquote>\n</blockquote>\n');
      else {
        const joined = q.filter((l) => l !== '').join('\n');
        out.push('<blockquote>\n<p>' + inlineStr(joined, link) + '</p>\n</blockquote>\n');
      }
      continue;
    }
    const li = listStart(line);
    if (li !== null) {
      const items = [];
      let cur = null;
      while (i < n) {
        const m = listMatch(lines[i], li.ordered);
        if (m !== null) {
          cur = [trimLine(m)];
          items.push(cur);
          i++;
        } else if (isContinued(lines[i])) {
          cur.push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = li.ordered ? 'ol' : 'ul';
      const open = li.ordered && li.start !== 1 ? '<ol start="' + li.start + '">' : '<' + tag + '>';
      const parts = [open, '\n'];
      for (const it of items) parts.push('<li>', inlineStr(it.join('\n'), link), '</li>\n');
      parts.push('</' + tag + '>\n');
      out.push(parts.join(''));
      continue;
    }
    const p = [trimLine(line)];
    i++;
    while (i < n && !endsPara(lines[i])) {
      p.push(trimLine(lines[i]));
      i++;
    }
    const html = inlineStr(p.join('\n'), link);
    if (excerpt === null) excerpt = html;
    out.push('<p>' + html + '</p>\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}

/** ASCII whitespace table (codes 9-13 and 32). */
const WS8 = new Uint8Array(128);
WS8[9] = 1;
WS8[10] = 1;
WS8[11] = 1;
WS8[12] = 1;
WS8[13] = 1;
WS8[32] = 1;

/** Words of the body lines: runs of non-whitespace. */
function wordsInLines(lines, start) {
  let n = 0;
  for (let i = start; i < lines.length; i++) {
    const s = lines[i];
    let inW = false;
    for (let j = 0; j < s.length; j++) {
      const c = s.charCodeAt(j);
      let ws;
      if (c < 128) ws = WS8[c] === 1;
      else ws = c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
      if (ws) inW = false;
      else if (!inW) {
        inW = true;
        n++;
      }
    }
  }
  return n;
}

// ---------------------------------------------------------------- templates

class TErr extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TErr(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function isSpaces(s, a, b) {
  for (let k = a; k < b; k++) {
    const c = s[k];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** Tokenize a template: [0,text] | [1,path,raw] | [2,tag]. */
function tokenize(name, src) {
  const toks = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const nx = src[open + 1];
    if (nx !== '{' && nx !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (nx === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TErr(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') toks.push([0, text]);
      text = '';
      toks.push([1, pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()), raw ? 1 : 0]);
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TErr(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isSpaces(src, lineStart, open) && isSpaces(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') toks.push([0, text]);
    text = '';
    toks.push([2, src.slice(open + 2, close).trim()]);
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') toks.push([0, text]);
  return toks;
}

/**
 * Compile a template to flat ops:
 * [0,text] [1,path,raw] [2,path,not,then,else|null] [3,var,path,body] [4,name]
 */
function compileTpl(name, src) {
  const root = [];
  const stack = [{ k: 0, body: root }];
  let body = root;
  for (const tok of tokenize(name, src)) {
    if (tok[0] === 0) body.push([0, tok[1]]);
    else if (tok[0] === 1) body.push([1, tok[1], tok[2]]);
    else {
      const tag = tok[1];
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = [3, m[1], pathOf(name, m[2]), []];
        body.push(node);
        stack.push({ k: 1, body: node[3] });
        body = node[3];
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = [2, pathOf(name, m[2]), m[1] !== undefined ? 1 : 0, [], null];
        body.push(node);
        stack.push({ k: 2, node, body: node[3] });
        body = node[3];
      } else if (tag === 'else') {
        if (top.k !== 2 || top.node[4] !== null) throw new TErr(`template "${name}": an else outside an if`);
        top.node[4] = [];
        top.body = top.node[4];
        body = top.node[4];
      } else if (tag === 'endfor' || tag === 'endif') {
        const want = tag === 'endfor' ? 1 : 2;
        if (top.k !== want) throw new TErr(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        body = stack[stack.length - 1].body;
      } else if ((m = INC_RE.exec(tag)) !== null) body.push([4, m[1]]);
      else throw new TErr(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) {
    const top = stack[stack.length - 1];
    throw new TErr(`template "${name}": a ${top.k === 1 ? 'for' : 'if'} is not closed`);
  }
  return root;
}

/** Value at `path` in the frame chain (innermost first). */
function lookup(frames, path) {
  let f = frames.length - 1;
  for (; f >= 0; f--) {
    if (Object.hasOwn(frames[f], path[0])) break;
  }
  if (f < 0) return undefined;
  let v = frames[f][path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text. */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) s += ', ';
      s += textOf(v[i]);
    }
    return s;
  }
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function runOps(ops, frames, out, tpls, depth) {
  for (let n = 0; n < ops.length; n++) {
    const op = ops[n];
    const k = op[0];
    if (k === 0) {
      out.push(op[1]);
    } else if (k === 1) {
      const t = textOf(lookup(frames, op[1]));
      out.push(op[2] ? t : esc(t));
    } else if (k === 2) {
      const v = truthy(lookup(frames, op[1]));
      const br = v !== (op[2] === 1) ? op[3] : op[4];
      if (br !== null) runOps(br, frames, out, tpls, depth);
    } else if (k === 3) {
      const xs = lookup(frames, op[2]);
      if (!Array.isArray(xs)) continue;
      const fr = { loop: { index: 0, first: false, last: false, length: xs.length } };
      frames.push(fr);
      for (let j = 0; j < xs.length; j++) {
        fr[op[1]] = xs[j];
        const lp = fr.loop;
        lp.index = j + 1;
        lp.first = j === 0;
        lp.last = j === xs.length - 1;
        runOps(op[3], frames, out, tpls, depth);
      }
      frames.pop();
    } else if (k === 4) {
      if (depth < 8) {
        const t = tpls.get(op[1]);
        if (t !== undefined) runOps(t, frames, out, tpls, depth + 1);
      }
    }
  }
}

function renderTpl(tpls, name, vars) {
  const ops = tpls.get(name);
  if (ops === undefined) return null;
  const out = [];
  runOps(ops, [vars], out, tpls, 0);
  return out.join('');
}

// ---------------------------------------------------------------- build

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

function linkOf(s) {
  return s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  const slugCache = new Map();
  const report = [];
  const tpls = new Map();
  for (const name of Object.keys(input.templates).sort(cmp)) {
    try {
      tpls.set(name, compileTpl(name, input.templates[name]));
    } catch (e) {
      if (e instanceof TErr) report.push(e.message);
      else throw e;
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const files = [...input.files].sort((a, b) => cmp(a.path, b.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, lines: f.content.replace(/\r\n?/g, '\n').split('\n') });
    else statics.push(f);
  }

  const kept = [];
  for (const s of sources) {
    const fm = parseFM(s.lines);
    if (fm.error !== undefined) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyStart = fm.bodyStart;
    s.post = s.path.startsWith('posts/');
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!tpls.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? ['posts', 'tags', 'page'] : []);
      taken.set(dir, set);
    }
    const slug = uniqSlug(s.data.slug ?? slugify(s.data.title, slugCache), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (SCHEME_RE.test(target) || target[0] === '/' || target[0] === '#') return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null) {
        const pg = bySource.get(path);
        if (pg !== undefined) return pg.url + frag;
        if (staticPaths.has(path)) return base + '/' + path + frag;
      }
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMD(s.lines, s.bodyStart, link, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  const posts = kept.filter((s) => s.post);
  posts.sort((a, b) => cmp(b.data.date, a.data.date) || cmp(a.slug, b.slug));
  for (let k = 0; k < posts.length; k++) {
    const p = posts[k];
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  }

  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags;
    if (tags) {
      for (const name of tags) {
        const sl = slugify(name, slugCache);
        if (!seen.has(sl)) {
          seen.add(sl);
          out.push(name);
        }
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const sl = slugify(name, slugCache);
      let t = bySlug.get(sl);
      if (t === undefined) {
        t = { name, slug: sl, url: base + '/tags/' + sl + '/', posts: [] };
        bySlug.set(sl, t);
      }
      t.posts.push(p);
      p.tagRefs.push(t);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const sl = slugify(name, slugCache);
      const t = bySlug.get(sl);
      return t !== undefined ? t : { name, slug: sl, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((a, b) => b.posts.length - a.posts.length || cmp(a.slug, b.slug));

  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsInLines(s.lines, s.bodyStart) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  let nPages = 0;
  for (const s of kept) {
    const c = s.post ? cards.get(s) : cardOf(s);
    if (!s.post) nPages++;
    s.pageObj = {
      title: c.title,
      url: c.url,
      date: c.date,
      date_long: c.date_long,
      summary: c.summary,
      excerpt: c.excerpt,
      reading_minutes: c.reading_minutes,
      tags: c.tags,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: s.post ? linkOf(s.newer) : null,
      older: s.post ? linkOf(s.older) : null,
      is_post: s.post,
    };
  }

  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  for (const s of kept) {
    output[s.outDir + '/index.html'] = renderTpl(tpls, s.layout, { site, tags: allTags, recent, page: s.pageObj });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = renderTpl(tpls, 'index', {
      site,
      tags: allTags,
      recent,
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (const t of tags) {
    const html = renderTpl(tpls, 'tag', {
      site,
      tags: allTags,
      recent,
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  {
    const html = renderTpl(tpls, 'tags', { site, tags: allTags, recent });
    if (html !== null) output['tags/index.html'] = html;
  }
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }
  const lines = [...report, ...broken].sort(cmp);
  lines.push(`built ${nPages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
