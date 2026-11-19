'use strict';
/**
 * DOCX → PDF using the word processor installed on the server, so the PDF is a faithful
 * rendering of the generated DOCX. Microsoft Word (COM automation, Windows) is preferred;
 * LibreOffice is used when Word is not available. Conversions run one at a time.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const crypto = require('crypto');

const WORD_SCRIPT = `
param([string]$in, [string]$out)
$ErrorActionPreference = 'Stop'
$w = New-Object -ComObject Word.Application
$w.Visible = $false
$w.DisplayAlerts = 0
try {
  $d = $w.Documents.Open($in, $false, $true, $false)
  $d.ExportAsFixedFormat($out, 17)
  $d.Close(0)
} finally { $w.Quit(); [System.Runtime.Interopservices.Marshal]::ReleaseComObject($w) | Out-Null }
`;

let queue = Promise.resolve();
let detected = null;

function run(cmd, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || '').toString().trim().slice(0, 400)));
      else resolve(stdout);
    });
  });
}

function findSoffice() {
  const candidates = process.platform === 'win32'
    ? ['C:\\Program Files\\LibreOffice\\program\\soffice.exe', 'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe']
    : ['/usr/bin/soffice', '/usr/local/bin/soffice', '/usr/bin/libreoffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice'];
  return candidates.find(p => fs.existsSync(p)) || null;
}

function findWord() {
  if (process.platform !== 'win32') return false;
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
  return roots.some(r => ['Microsoft Office\\root\\Office16', 'Microsoft Office\\Office16', 'Microsoft Office\\root\\Office15']
    .some(sub => fs.existsSync(path.join(r, sub, 'WINWORD.EXE'))));
}

function engine() {
  if (detected === null) detected = findWord() ? 'word' : (findSoffice() ? 'soffice' : '');
  return detected;
}

async function convertOnce(docxBuffer) {
  const eng = engine();
  if (!eng) {
    const err = new Error('PDF export needs Microsoft Word or LibreOffice installed on the server. Download the DOCX instead, or install one of them.');
    err.statusCode = 501;
    throw err;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pems-pdf-'));
  const id = crypto.randomBytes(6).toString('hex');
  const inFile = path.join(dir, `doc-${id}.docx`);
  const outFile = path.join(dir, `doc-${id}.pdf`);
  try {
    fs.writeFileSync(inFile, docxBuffer);
    if (eng === 'word') {
      const script = path.join(dir, 'convert.ps1');
      fs.writeFileSync(script, WORD_SCRIPT, 'utf8');
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, inFile, outFile], 120000);
    } else {
      await run(findSoffice(), ['--headless', '--convert-to', 'pdf', '--outdir', dir, inFile], 120000);
    }
    if (!fs.existsSync(outFile)) throw new Error('The converter produced no PDF.');
    return fs.readFileSync(outFile);
  } catch (e) {
    const err = new Error('PDF conversion failed: ' + e.message);
    err.statusCode = 500;
    throw err;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Convert one DOCX buffer to PDF; calls are serialized. */
function docxToPdf(docxBuffer) {
  const job = queue.then(() => convertOnce(docxBuffer));
  queue = job.catch(() => {});
  return job;
}

module.exports = { docxToPdf, engine };
