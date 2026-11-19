'use strict';
/**
 * Syllabus experiment extractor.
 *
 * Reads the text actually present in an uploaded syllabus (DOCX, PDF, XLSX/CSV, TXT),
 * locates the practical experiment list, and returns the experiments in their original
 * order and wording. It never pads, truncates, or invents experiments: when nothing can
 * be found it throws a SyllabusError that explains why, so staff can enter the list.
 */

const AdmZip = require('adm-zip');
const XLSX = require('xlsx');

class SyllabusError extends Error {
  constructor(msg) { super(msg); this.name = 'SyllabusError'; this.statusCode = 422; }
}

// ─── Entry point ──────────────────────────────────────────────────────────────
async function parseSyllabus(buffer, originalName) {
  const ext = String(originalName || '').split('.').pop().toLowerCase();
  let lines = [];
  const source = { type: ext, pages: null, characters: 0 };

  if (ext === 'docx') {
    lines = docxLines(buffer);
  } else if (ext === 'pdf') {
    const pdf = await pdfLines(buffer);
    lines = pdf.lines;
    source.pages = pdf.pages;
  } else if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
    const exps = spreadsheetExperiments(buffer);
    if (!exps.length) throw new SyllabusError('No experiment rows were found. Use columns: Experiment No, Title, Sub-question A, Sub-question B.');
    return finish(exps, [], { ...source, characters: 0 }, true);
  } else if (ext === 'txt') {
    lines = buffer.toString('utf8').split(/\r?\n/);
  } else if (ext === 'doc') {
    throw new SyllabusError('Old Word .doc files cannot be read. Open the file in Word and save it as .docx, or upload a PDF.');
  } else {
    throw new SyllabusError('Unsupported file type. Upload a PDF or DOCX syllabus (CSV/XLSX lists are also accepted).');
  }

  lines = lines.map(l => (typeof l === 'string' ? { text: l, block: 'p' } : l))
    .map(l => ({ ...l, text: cleanLine(l.text) })).filter(l => l.text);
  source.characters = lines.reduce((n, l) => n + l.text.length + 1, 0);
  if (source.characters < 20) {
    if (ext === 'pdf') {
      throw new SyllabusError('This PDF has no readable text layer (it appears to be a scanned image). OCR is not available in this installation. Upload a DOCX or text-based PDF, or enter the experiments manually.');
    }
    throw new SyllabusError('The file contains no readable text.');
  }

  const { experiments, sectionFound, skipped } = parseLines(lines);
  if (!experiments.length) {
    throw new SyllabusError('No numbered experiment list was found in this file. The extractor looks for experiments numbered 1, 2, 3 … (optionally under a "List of Experiments" heading). Enter the experiments manually or upload a different file.');
  }
  const warnings = [];
  for (const n of skipped) warnings.push(`Text after a page break near experiment ${n} was not included because it did not look like part of the experiment. Compare experiment ${n} with the file.`);
  if (!sectionFound) warnings.push('No "List of Experiments" heading was found; experiments were taken from numbered lines in the whole document. Check that no theory topics were included.');
  return finish(experiments, warnings, source, sectionFound);
}

function finish(experiments, warnings, source, sectionFound) {
  experiments.forEach((e, i) => {
    e.display_order = i + 1;
    e.subquestions = e.subquestions.filter(s => s.text);
    if (!e.subquestions.length) warnings.push(`Experiment ${e.exp_no} has no sub-questions (a)/(b). Review it before approval.`);
    else if (e.subquestions.length === 1) warnings.push(`Experiment ${e.exp_no} has only sub-question (${e.subquestions[0].letter}).`);
  });
  for (let i = 1; i < experiments.length; i++) {
    if (experiments[i].exp_no !== experiments[i - 1].exp_no + 1) {
      warnings.push(`Numbering jumps from ${experiments[i - 1].exp_no} to ${experiments[i].exp_no}; check for a missing experiment.`);
    }
  }
  return { experiments, warnings, source, section_found: sectionFound };
}

// ─── Text helpers ─────────────────────────────────────────────────────────────
function cleanLine(s) {
  return String(s || '')
    .replace(/[   \t]/g, ' ')
    .replace(/[​﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

// ─── DOCX: paragraphs and table cells in document order, with list numbering ─
function docxLines(buffer) {
  let zip;
  try { zip = new AdmZip(buffer); } catch { throw new SyllabusError('The DOCX file is damaged or not a Word document.'); }
  const docEntry = zip.getEntry('word/document.xml');
  if (!docEntry) throw new SyllabusError('The DOCX file has no document body.');
  const xml = docEntry.getData().toString('utf8');
  const numbering = readNumbering(zip);
  const styleNum = readStyleNumbering(zip);
  const counters = {};
  const seenNumIds = new Set();

  function paraText(p) {
    let out = '';
    const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br(?:\s[^>]*)?\/>|<w:noBreakHyphen\/>/g;
    let m;
    while ((m = re.exec(p))) {
      if (m[1] !== undefined) out += decodeXml(m[1]);
      else if (m[0].startsWith('<w:noBreakHyphen')) out += '-';
      else out += ' ';
    }
    return out;
  }

  function listPrefix(p) {
    const pPr = (p.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [''])[0];
    let numId = (pPr.match(/<w:numId w:val="(\d+)"/) || [])[1];
    let ilvl = +((pPr.match(/<w:ilvl w:val="(\d+)"/) || [])[1] || 0);
    if (!numId) {
      const style = (pPr.match(/<w:pStyle w:val="([^"]+)"/) || [])[1];
      if (style && styleNum[style]) { numId = styleNum[style].numId; ilvl = styleNum[style].ilvl; }
    }
    if (!numId || numId === '0') return '';
    const num = numbering.nums[numId];
    if (!num) return '';
    const abs = numbering.abstracts[num.abstractId];
    if (!abs) return '';
    const key = num.abstractId;
    counters[key] = counters[key] || {};
    if (!seenNumIds.has(numId)) {
      seenNumIds.add(numId);
      for (const [lv, start] of Object.entries(num.overrides)) counters[key][lv] = start - 1;
    }
    const lvl = abs[ilvl] || abs[0];
    if (!lvl) return '';
    const start = lvl.start;
    counters[key][ilvl] = (counters[key][ilvl] ?? start - 1) + 1;
    for (const lv of Object.keys(counters[key])) if (+lv > ilvl) delete counters[key][lv];
    if (lvl.fmt === 'bullet' || lvl.fmt === 'none') return '';
    return lvl.text.replace(/%(\d)/g, (_, n) => {
      const L = +n - 1;
      const def = abs[L] || lvl;
      const val = counters[key][L] ?? def.start;
      return formatNumber(val, def.fmt);
    }) + ' ';
  }

  const lines = [];
  let tableNo = 0;
  // Walk top-level body children in order; tables are expanded row by row.
  const body = xml.slice(xml.indexOf('<w:body>') + 8, xml.lastIndexOf('</w:body>'));
  for (const el of topLevel(body)) {
    if (el.startsWith('<w:p')) {
      lines.push({ text: listPrefix(el) + paraText(el), block: 'p' });
    } else if (el.startsWith('<w:tbl')) {
      const block = 't' + (++tableNo);
      for (const row of matchAll(el, /<w:tr[\s>][\s\S]*?<\/w:tr>/g)) {
        const cells = matchAll(row, /<w:tc>[\s\S]*?<\/w:tc>/g).map(c =>
          matchAll(c, /<w:p[\s>][\s\S]*?<\/w:p>|<w:p\/>/g).map(p => cleanLine(listPrefix(p) + paraText(p))).filter(Boolean)
        );
        const first = (cells[0] || []).join(' ');
        if (cells.length >= 2 && /^\d{1,2}\s*[.)]?$/.test(first)) {
          const rest = cells.slice(1).flat();
          const n = first.replace(/\D/g, '');
          lines.push({ text: `${n}. ${rest[0] || ''}`, block });
          rest.slice(1).forEach(t => lines.push({ text: t, block }));
        } else {
          cells.flat().forEach(t => lines.push({ text: t, block }));
        }
      }
    }
  }
  return lines;
}

function matchAll(s, re) { return s.match(re) || []; }

/** Split body XML into its top-level <w:p> and <w:tbl> elements in order. */
function topLevel(body) {
  const out = [];
  const re = /<(\/?)w:(p|tbl)(?=[\s>\/])[^>]*?(\/?)>/g;
  let depth = 0, start = -1, m, tag = '';
  while ((m = re.exec(body))) {
    const closing = m[1] === '/', self = m[3] === '/';
    if (depth === 0 && !closing) {
      if (self) { out.push(m[0]); continue; }
      start = m.index; tag = m[2]; depth = 1; continue;
    }
    if (depth > 0) {
      if (self) continue;
      if (!closing) depth++;
      else { depth--; if (depth === 0) out.push(body.slice(start, re.lastIndex)); }
    }
  }
  return out;
}

function readNumbering(zip) {
  const res = { abstracts: {}, nums: {} };
  const e = zip.getEntry('word/numbering.xml');
  if (!e) return res;
  const x = e.getData().toString('utf8');
  for (const a of matchAll(x, /<w:abstractNum [\s\S]*?<\/w:abstractNum>/g)) {
    const id = (a.match(/w:abstractNumId="(\d+)"/) || [])[1];
    const lvls = {};
    for (const l of matchAll(a, /<w:lvl [\s\S]*?<\/w:lvl>/g)) {
      const il = +(l.match(/w:ilvl="(\d+)"/) || [])[1];
      lvls[il] = {
        start: +((l.match(/<w:start w:val="(\d+)"/) || [])[1] || 1),
        fmt: (l.match(/<w:numFmt w:val="([^"]+)"/) || [])[1] || 'decimal',
        text: decodeXml((l.match(/<w:lvlText w:val="([^"]*)"/) || [])[1] || ''),
      };
    }
    res.abstracts[id] = lvls;
  }
  for (const n of matchAll(x, /<w:num w:numId="\d+"[\s\S]*?<\/w:num>/g)) {
    const id = (n.match(/w:numId="(\d+)"/) || [])[1];
    const overrides = {};
    for (const o of matchAll(n, /<w:lvlOverride w:ilvl="\d+">[\s\S]*?<\/w:lvlOverride>/g)) {
      const lv = (o.match(/w:ilvl="(\d+)"/) || [])[1];
      const st = (o.match(/<w:startOverride w:val="(\d+)"/) || [])[1];
      if (st) overrides[lv] = +st;
    }
    res.nums[id] = { abstractId: (n.match(/<w:abstractNumId w:val="(\d+)"/) || [])[1], overrides };
  }
  return res;
}

function readStyleNumbering(zip) {
  const out = {};
  const e = zip.getEntry('word/styles.xml');
  if (!e) return out;
  const x = e.getData().toString('utf8');
  for (const s of matchAll(x, /<w:style [\s\S]*?<\/w:style>/g)) {
    const id = (s.match(/w:styleId="([^"]+)"/) || [])[1];
    const numId = (s.match(/<w:numId w:val="(\d+)"/) || [])[1];
    if (id && numId) out[id] = { numId, ilvl: +((s.match(/<w:ilvl w:val="(\d+)"/) || [])[1] || 0) };
  }
  return out;
}

function formatNumber(n, fmt) {
  if (fmt === 'lowerLetter') return letters(n).toLowerCase();
  if (fmt === 'upperLetter') return letters(n);
  if (fmt === 'lowerRoman') return roman(n).toLowerCase();
  if (fmt === 'upperRoman') return roman(n);
  return String(n);
}
function letters(n) { let s = ''; while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); } return s || 'A'; }
function roman(n) {
  const map = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let s = ''; for (const [v, r] of map) while (n >= v) { s += r; n -= v; } return s;
}

// ─── PDF (pdf-parse v2) ──────────────────────────────────────────────────────
async function pdfLines(buffer) {
  let PDFParse;
  try { ({ PDFParse } = require('pdf-parse')); } catch { throw new SyllabusError('PDF reading is not available on this server (pdf-parse is missing).'); }
  let result;
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    result = await parser.getText();
  } catch (e) {
    throw new SyllabusError('The PDF could not be read: ' + (e.message || 'unknown error') + '. If it is password-protected, remove the password and upload again.');
  } finally {
    try { await parser.destroy(); } catch { /* ignore */ }
  }
  const pages = Array.isArray(result.pages) && result.pages.length ? result.pages.map(p => p.text || '') : [result.text || ''];
  const lines = [];
  for (const [pageIdx, pageText] of pages.entries()) {
    const pl = pageText.split(/\r?\n/).map(cleanLine).filter(Boolean)
      .filter(l => !/^--\s*\d+\s*of\s*\d+\s*--$/.test(l) && !/^page\s*\d+(\s*(of|\/)\s*\d+)?$/i.test(l));
    // A bare number as the first or last line of a page is a page number.
    if (pl.length && /^\d{1,3}$/.test(pl[0])) pl.shift();
    if (pl.length && /^\d{1,3}$/.test(pl[pl.length - 1])) pl.pop();
    lines.push(...pl.map(text => ({ text, block: 'p', page: pageIdx + 1 })));
  }
  // Table extraction sometimes puts the experiment number on its own line.
  const merged = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].text, next = lines[i + 1];
    if (/^\d{1,2}\.?$/.test(t) && next && !/^\d/.test(next.text)) {
      merged.push({ ...next, text: t.replace('.', '') + '. ' + next.text });
      i++;
    } else merged.push(lines[i]);
  }
  return { lines: merged, pages: pages.length };
}

// ─── Spreadsheet / CSV (columns: No, Title, A, B) ────────────────────────────
function spreadsheetExperiments(buffer) {
  let rows;
  try {
    const wb = XLSX.read(buffer, { type: 'buffer', raw: true });
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false });
  } catch { throw new SyllabusError('The spreadsheet could not be read.'); }
  const exps = [];
  for (const r of rows) {
    const no = parseInt(String(r[0]).trim(), 10);
    if (!Number.isInteger(no) || no < 1) continue; // header or blank row
    const title = cleanLine(r[1]);
    const subs = [];
    if (cleanLine(r[2])) subs.push({ letter: 'a', text: cleanLine(r[2]) });
    if (cleanLine(r[3])) subs.push({ letter: 'b', text: cleanLine(r[3]) });
    if (title || subs.length) exps.push({ exp_no: no, title, description: '', subquestions: subs });
  }
  return exps;
}

// ─── Line parser ─────────────────────────────────────────────────────────────
const SECTION_START = /^(?:\d+\.?\s*)?(?:list\s+of\s+(?:experiments?|exercises?|practicals?|programs?|programmes?)|(?:practical|laboratory|lab)\s+(?:exercises?|experiments?|list)|experiments?|exercises?)\s*[:.-]?$/i;
const SECTION_END = /^(?:text\s*books?|reference\s*books?|references|web\s*(?:references|resources)|course\s+outcomes?|equipment\b|list\s+of\s+equipment|(?:requirement|list)\s+of\s+(?:hardware|software)|hardware\s+(?:and|&)\s+software|software\s+requirements?|board\s+practical|scheme\s+of\s+(?:evaluation|valuation)|total\s*:?\s*\d+\s*(?:hours|hrs|periods))/i;
const EXP_PREFIXED = /^(?:ex(?:p(?:eriment)?|ercise)?|expt|practical|program(?:me)?)\.?\s*(?:no\.?\s*)?(\d{1,2})\b\s*[.):\-–]?\s*(.*)$/i;
const EXP_NUMBERED = /^(\d{1,2})\s*[.):\-–]\s*(.*)$/;
const EXP_BEFORE_SUB = /^(\d{1,2})\s+(\(?[a-hA-H]\s*[).].*)$/;   // "1 a) text" (PDF tables)
const SUB_PUNCT = /^\(?([a-h])\s*[).:]\s*(.*)$/;      // a) a. (a) a:
const SUB_UPPER = /^\(?([A-H])\)\s*(.*)$/;             // A)
const SUB_BARE = /^([a-h])\s+(?=[A-Z])(.*)$/;          // "a Write a program"

function isHeading(t) {
  const letters = t.replace(/[^A-Za-z]/g, '');
  return letters.length >= 6 && t.length <= 90 && letters === letters.toUpperCase() && /\s/.test(t.trim());
}

function parseLines(input) {
  const allLines = input.map(l => (typeof l === 'string' ? { text: cleanLine(l), block: 'p' } : l)).filter(l => l.text);
  let start = 0, sectionFound = false;
  for (let i = 0; i < allLines.length; i++) {
    if (SECTION_START.test(allLines[i].text)) { start = i + 1; sectionFound = true; break; }
  }
  const lines = allLines.slice(start);
  const exps = [];
  let cur = null, listBlock = null, prevPage = null, closed = false;
  const skipped = new Set();

  const expectedLetter = () => String.fromCharCode(97 + (cur ? cur.subquestions.length : 0));

  for (const { text: line, block, page } of lines) {
    if (cur && page && prevPage && page !== prevPage) {
      const lastSub = cur.subquestions[cur.subquestions.length - 1];
      const lastText = lastSub ? lastSub.text : cur.title;
      if (/[.?!]["”']?$/.test(lastText.trim()) && !/^[a-z]/.test(line)) closed = true;
    }
    if (page) prevPage = page;
    if (exps.length) {
      if (SECTION_END.test(line)) break;
      if (listBlock && listBlock !== 'p' && block !== listBlock) break; // table list ended
      if (listBlock === 'p' && isHeading(line)) break;
    }

    const em = line.match(EXP_PREFIXED) || line.match(EXP_NUMBERED) || line.match(EXP_BEFORE_SUB);
    if (em) {
      const n = parseInt(em[1], 10);
      const last = exps.length ? exps[exps.length - 1].exp_no : null;
      const acceptable = last === null ? n >= 1 && n <= 3 : n === last + 1;
      if (acceptable) {
        cur = { exp_no: n, title: '', description: '', subquestions: [] };
        if (!exps.length) listBlock = block;
        exps.push(cur);
        closed = false;
        addText(cur, em[2] || '', true);
        continue;
      }
    }
    if (!cur) continue;
    if (closed) {
      const want = expectedLetter();
      const sm = line.match(SUB_PUNCT) || line.match(SUB_UPPER);
      if (!(sm && sm[1].toLowerCase() === want)) { skipped.add(cur.exp_no); continue; }
      closed = false;
    }
    addText(cur, line, false);
  }

  for (const e of exps) {
    e.title = e.title.trim();
    if (!e.subquestions.length) {
      const split = splitInline(e.title);
      if (split) { e.title = split.lead; e.subquestions = split.subs; }
    } else {
      for (let i = 0; i < e.subquestions.length; i++) {
        const split = splitInline(e.subquestions[i].text, e.subquestions[i].letter);
        if (split && split.subs.length > 1) {
          e.subquestions.splice(i, 1, { letter: e.subquestions[i].letter, text: split.lead }, ...split.subs.slice(1));
        }
      }
    }
    e.subquestions.forEach(s => (s.text = s.text.trim()));
  }
  return { experiments: exps, sectionFound, skipped: [...skipped] };

  function addText(exp, text, isHeadLine) {
    text = text.trim();
    if (!text) return;
    const want = expectedLetter();
    const sm = text.match(SUB_PUNCT) || text.match(SUB_UPPER);
    let m = sm && sm[1].toLowerCase() === want ? sm : null;
    if (!m && !isHeadLine) {
      const bare = text.match(SUB_BARE);
      if (bare && bare[1] === want) m = bare;
    }
    if (m) {
      exp.subquestions.push({ letter: want, text: m[2] });
      return;
    }
    if (exp.subquestions.length) {
      const last = exp.subquestions[exp.subquestions.length - 1];
      last.text += (last.text ? ' ' : '') + text;
    } else {
      exp.title += (exp.title ? ' ' : '') + text;
    }
  }
}

/** Split "a) first b) second" (or text that starts at b when startLetter='a'). */
function splitInline(text, startLetter = null) {
  if (!text) return null;
  const marks = [];
  const re = /(?:^|\s)\(?([a-h])\s*\)\s*/g;
  let m;
  let want = startLetter ? String.fromCharCode(startLetter.charCodeAt(0) + 1) : 'a';
  while ((m = re.exec(text))) {
    if (m[1] === want) { marks.push({ letter: m[1], at: m.index, end: re.lastIndex }); want = String.fromCharCode(want.charCodeAt(0) + 1); }
  }
  if (startLetter) {
    if (!marks.length) return null;
    const subs = [{ letter: startLetter, text: text.slice(0, marks[0].at).trim() }];
    marks.forEach((mk, i) => subs.push({ letter: mk.letter, text: text.slice(mk.end, marks[i + 1] ? marks[i + 1].at : undefined).trim() }));
    return { lead: subs[0].text, subs };
  }
  if (marks.length < 2) return null;
  const lead = text.slice(0, marks[0].at).trim();
  const subs = marks.map((mk, i) => ({ letter: mk.letter, text: text.slice(mk.end, marks[i + 1] ? marks[i + 1].at : undefined).trim() }));
  return { lead, subs };
}

module.exports = { parseSyllabus, parseLines, SyllabusError };
