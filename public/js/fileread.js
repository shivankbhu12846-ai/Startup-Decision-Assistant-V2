// fileread.js — turns an uploaded pitch file into plain text, inside the browser.
// The file itself is never uploaded anywhere: only the extracted text is shown
// to the analyst and, on request, sent to the AI (same as pasted text).
// Libraries are self-hosted in /vendor and loaded only when needed.

export const ACCEPT = '.pdf,.docx,.pptx,.txt,.md,.csv,application/pdf,text/plain,text/markdown,text/csv,'
  + 'application/vnd.openxmlformats-officedocument.wordprocessingml.document,'
  + 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

export const MAX_FILE_MB = 25;

const vendor = (f) => new URL(`../vendor/${f}`, import.meta.url).href;

function loadScript(src, globalName) {
  if (window[globalName]) return Promise.resolve(window[globalName]);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => (window[globalName] ? resolve(window[globalName]) : reject(new Error(`Could not load ${globalName}.`)));
    s.onerror = () => reject(new Error(`Could not load the ${globalName} reader. Check your internet connection and try again.`));
    document.head.appendChild(s);
  });
}

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(vendor('pdf.min.mjs')).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = vendor('pdf.worker.min.mjs');
      return lib;
    }).catch((e) => { pdfjsPromise = null; throw e; });
  }
  return pdfjsPromise;
}

function extOf(name) { return (name.split('.').pop() || '').toLowerCase(); }

// ---------- PDF ----------
async function readPdf(file, onProgress) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  let doc;
  try {
    doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  } catch (e) {
    if (e?.name === 'PasswordException') throw new Error(`“${file.name}” is password-protected. Save a copy without a password and upload that.`);
    throw new Error(`“${file.name}” could not be opened as a PDF.`);
  }
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    onProgress?.(`Reading page ${i} of ${doc.numPages}…`);
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let text = '';
    for (const item of tc.items) {
      if (!('str' in item)) continue;
      text += item.str;
      text += item.hasEOL ? '\n' : (item.str && !item.str.endsWith(' ') ? ' ' : '');
    }
    pages.push(text.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim());
  }
  await doc.destroy();
  return { text: pages.map((t, i) => (doc.numPages > 1 ? `[Page ${i + 1}]\n${t}` : t)).join('\n\n'), units: pages.length, unitName: 'page' };
}

// ---------- Word (.docx) ----------
async function readDocx(file) {
  const mammoth = await loadScript(vendor('mammoth.browser.min.js'), 'mammoth');
  const res = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return { text: res.value.replace(/\n{3,}/g, '\n\n').trim(), units: null, unitName: '' };
}

// ---------- PowerPoint (.pptx) ----------
function xmlText(xml, tag) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const paras = doc.getElementsByTagNameNS('*', 'p');
  const out = [];
  for (const p of paras) {
    let line = '';
    for (const t of p.getElementsByTagNameNS('*', tag)) line += t.textContent;
    if (line.trim()) out.push(line.trim());
  }
  return out.join('\n');
}

async function readPptx(file) {
  const JSZip = await loadScript(vendor('jszip.min.js'), 'JSZip');
  let zip;
  try { zip = await JSZip.loadAsync(await file.arrayBuffer()); } catch { throw new Error(`“${file.name}” could not be opened as a PowerPoint file.`); }
  const num = (p) => Number((p.match(/(\d+)\.xml$/) || [])[1] || 0);
  const slides = Object.keys(zip.files).filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p)).sort((a, b) => num(a) - num(b));
  const parts = [];
  for (const p of slides) {
    const body = xmlText(await zip.file(p).async('string'), 't');
    const notesPath = `ppt/notesSlides/notesSlide${num(p)}.xml`;
    let notes = '';
    if (zip.file(notesPath)) notes = xmlText(await zip.file(notesPath).async('string'), 't').replace(/^\d+$/gm, '').trim();
    parts.push(`[Slide ${num(p)}]\n${body}${notes ? `\nSpeaker notes: ${notes}` : ''}`);
  }
  return { text: parts.join('\n\n'), units: slides.length, unitName: 'slide' };
}

// ---------- entry point ----------
export async function readPitchFile(file, onProgress) {
  if (file.size > MAX_FILE_MB * 1024 * 1024) throw new Error(`“${file.name}” is larger than ${MAX_FILE_MB} MB. Export a smaller version (for example without images).`);
  const ext = extOf(file.name);
  let res;
  if (ext === 'pdf' || file.type === 'application/pdf') res = await readPdf(file, onProgress);
  else if (ext === 'docx') res = await readDocx(file);
  else if (ext === 'pptx') res = await readPptx(file);
  else if (['txt', 'md', 'csv'].includes(ext) || file.type.startsWith('text/')) res = { text: (await file.text()).trim(), units: null, unitName: '' };
  else if (['doc', 'ppt', 'key', 'pages'].includes(ext)) throw new Error(`“${file.name}” is in an old or Apple format. Save it as PDF, .docx or .pptx and upload that.`);
  else throw new Error(`“${file.name}” is not a supported file. Use PDF, Word (.docx), PowerPoint (.pptx) or a text file.`);

  const letters = (res.text.match(/[A-Za-zÄÖÜäöüß]/g) || []).length;
  const perUnit = res.units ? letters / res.units : letters;
  if (letters < 80 || (res.units && perUnit < 25)) {
    throw new Error(`“${file.name}” has almost no selectable text. It is probably scanned or made of images. Export the deck from PowerPoint, Keynote or Google Slides as a PDF with text, or paste the key text instead.`);
  }
  return { name: file.name, text: res.text, chars: res.text.length, units: res.units, unitName: res.unitName };
}
