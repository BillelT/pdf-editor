/* =============================================================================
   editor/source-text.js — suppression du texte d'origine d'un PDF (pdf-lib).
   ---------------------------------------------------------------------------
   Le texte n'est pas masqué par un rectangle blanc : les opérateurs qui
   l'affichent (Tj, TJ, ', ") sont retirés du flux de contenu de la page, donc
   le texte disparaît aussi des données (copier/coller, recherche, extraction).

   Les zones à supprimer sont des boîtes en espace utilisateur PDF (celui des
   items de pdf.js getTextContent). On interprète le flux de façon minimale
   (CTM via q/Q/cm, matrices texte via BT, Tm, Td, TD, T*, TL) pour connaître
   l'origine de chaque opération d'affichage, et on retire celles dont
   l'origine tombe dans une boîte. L'avance après un Tj n'est qu'estimée (pas
   de lecture des métriques de police) : quand un texte conservé suit sur la
   même ligne sans repositionnement explicite, l'opération supprimée est
   gardée en mode invisible (3 Tr) pour ne pas décaler la suite.

   Filet de sécurité : une boîte qui ne correspond à aucune opération (texte
   dans un Form XObject, flux exotique…) est recouverte d'un rectangle blanc.
============================================================================= */

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

// Tokenise un flux de contenu en opérations { op, operands, start, end }
// (start/end = positions en octets, opérandes compris).
function parseOperations(bytes) {
  const ops = [];
  const n = bytes.length;
  let i = 0;
  let operands = [];
  let opStart = -1;

  const skipWs = () => {
    while (i < n) {
      const c = bytes[i];
      if (WS.has(c)) i++;
      else if (c === 0x25) { while (i < n && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++; }
      else break;
    }
  };

  const readLiteralString = () => {
    let depth = 0;
    const out = [];
    i++; // (
    while (i < n) {
      const c = bytes[i];
      if (c === 0x5c) { out.push(c, bytes[i + 1]); i += 2; continue; }
      if (c === 0x28) depth++;
      if (c === 0x29) { if (depth === 0) { i++; break; } depth--; }
      out.push(c);
      i++;
    }
    return { type: 'str', len: out.length };
  };

  const readHexString = () => {
    i++; // <
    let len = 0;
    while (i < n && bytes[i] !== 0x3e) { if (!WS.has(bytes[i])) len++; i++; }
    i++; // >
    return { type: 'str', len: Math.ceil(len / 2) };
  };

  const readValue = () => {
    const c = bytes[i];
    if (c === 0x28) return readLiteralString();
    if (c === 0x3c && bytes[i + 1] === 0x3c) {
      // Dictionnaire (ex. opérande de BDC) : on le saute en équilibrant << >>.
      let depth = 0;
      while (i < n) {
        if (bytes[i] === 0x3c && bytes[i + 1] === 0x3c) { depth++; i += 2; continue; }
        if (bytes[i] === 0x3e && bytes[i + 1] === 0x3e) { depth--; i += 2; if (depth === 0) break; continue; }
        if (bytes[i] === 0x28) { readLiteralString(); continue; }
        i++;
      }
      return { type: 'dict' };
    }
    if (c === 0x3c) return readHexString();
    if (c === 0x5b) {
      i++;
      const items = [];
      for (;;) {
        skipWs();
        if (i >= n) break;
        if (bytes[i] === 0x5d) { i++; break; }
        items.push(readValue());
      }
      return { type: 'arr', items };
    }
    if (c === 0x2f) {
      const s = i++;
      while (i < n && !WS.has(bytes[i]) && !DELIM.has(bytes[i])) i++;
      return { type: 'name', value: String.fromCharCode(...bytes.subarray(s, i)) };
    }
    const s = i;
    while (i < n && !WS.has(bytes[i]) && !DELIM.has(bytes[i])) i++;
    if (i === s) { i++; return { type: 'junk' }; }
    const word = String.fromCharCode(...bytes.subarray(s, i));
    const num = Number(word);
    if (!Number.isNaN(num) && /^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { type: 'num', value: num };
    return { type: 'op', value: word };
  };

  while (i < n) {
    skipWs();
    if (i >= n) break;
    const tokStart = i;
    const v = readValue();
    if (v.type !== 'op') {
      if (opStart < 0) opStart = tokStart;
      operands.push(v);
      continue;
    }
    if (v.value === 'BI') {
      // Image inline : on saute jusqu'à "EI" délimité par des blancs.
      while (i < n && !(WS.has(bytes[i - 1]) && bytes[i] === 0x45 && bytes[i + 1] === 0x49
        && (i + 2 >= n || WS.has(bytes[i + 2])))) i++;
      i += 2;
      operands = [];
      opStart = -1;
      continue;
    }
    ops.push({ op: v.value, operands, start: opStart < 0 ? tokStart : opStart, end: i });
    operands = [];
    opStart = -1;
  }
  return ops;
}

const mul = (m, n) => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];
const ID = [1, 0, 0, 1, 0, 0];
const nums = (operands) => operands.map(o => o.value);

const SHOW_OPS = new Set(['Tj', 'TJ', "'", '"']);
const LINE_OPS = new Set(['BT', 'ET', 'Tm', 'Td', 'TD', 'T*', "'", '"']);

function inBox(p, boxes, tol = 1) {
  for (let k = 0; k < boxes.length; k++) {
    const b = boxes[k];
    if (p.x >= b.x0 - tol && p.x <= b.x1 + tol && p.y >= b.y0 - tol && p.y <= b.y1 + tol) return k;
  }
  return -1;
}

// Renvoie { bytes, hits } : flux réécrit + indices des boîtes touchées.
function stripTextFromContent(bytes, boxes) {
  const ops = parseOperations(bytes);
  let ctm = ID, tm = ID, tlm = ID, tl = 0, fs = 0, tz = 1, tr = 0;
  const stack = [];
  const hits = new Set();
  const shows = []; // { idx, remove }

  ops.forEach((o, idx) => {
    const a = o.operands;
    switch (o.op) {
      case 'q': stack.push({ ctm, tl, fs, tz, tr }); break;
      case 'Q': if (stack.length) ({ ctm, tl, fs, tz, tr } = stack.pop()); break;
      case 'cm': if (a.length === 6) ctm = mul(nums(a), ctm); break;
      case 'BT': tm = tlm = ID; break;
      case 'Tm': if (a.length === 6) tm = tlm = nums(a); break;
      case 'TD': if (a.length === 2) tl = -a[1].value; // fallthrough
      case 'Td': if (a.length === 2) tm = tlm = mul([1, 0, 0, 1, a[0].value, a[1].value], tlm); break;
      case 'T*': tm = tlm = mul([1, 0, 0, 1, 0, -tl], tlm); break;
      case 'TL': if (a.length) tl = a[0].value; break;
      case 'Tf': if (a.length === 2) fs = a[1].value; break;
      case 'Tz': if (a.length) tz = a[0].value / 100; break;
      case 'Tr': if (a.length) tr = a[0].value; break;
    }
    if (!SHOW_OPS.has(o.op)) return;
    if (o.op === "'" || o.op === '"') tm = tlm = mul([1, 0, 0, 1, 0, -tl], tlm);

    const m = mul(tm, ctm);
    const k = inBox({ x: m[4], y: m[5] }, boxes);
    if (k >= 0) hits.add(k);
    shows.push({ idx, remove: k >= 0, tr });

    // Avance estimée (~0,5 em par glyphe) — sert seulement à localiser
    // les opérations suivantes de la même ligne.
    let adv = 0;
    const strOf = o.op === 'TJ' ? (a[0]?.items || []) : a.filter(x => x.type === 'str');
    strOf.forEach(it => {
      if (it.type === 'str') adv += it.len * 0.5 * fs;
      else if (it.type === 'num') adv -= (it.value / 1000) * fs;
    });
    tm = mul([1, 0, 0, 1, adv * tz, 0], tm);
  });

  if (!shows.some(s => s.remove)) return { bytes, hits };

  // Une opération supprimée suivie, sur la même ligne, d'une opération
  // conservée → mode invisible plutôt que retrait (garde l'avance).
  const keepAdvance = new Set();
  shows.forEach((s, j) => {
    if (!s.remove) return;
    for (let x = s.idx + 1; x < ops.length; x++) {
      const op = ops[x].op;
      if (SHOW_OPS.has(op)) {
        const next = shows.find(t => t.idx === x);
        if (next && !next.remove && op !== "'" && op !== '"') keepAdvance.add(j);
        break;
      }
      if (LINE_OPS.has(op)) break;
    }
  });

  const enc = (s) => Uint8Array.from(s, ch => ch.charCodeAt(0));
  const parts = [];
  let cursor = 0;
  shows.forEach((s, j) => {
    if (!s.remove) return;
    const o = ops[s.idx];
    parts.push(bytes.subarray(cursor, o.start));
    if (keepAdvance.has(j)) {
      parts.push(enc(' 3 Tr '), bytes.subarray(o.start, o.end), enc(` ${s.tr} Tr `));
    } else if (o.op === "'" || o.op === '"') {
      parts.push(enc(' T* '));
    } else {
      parts.push(enc(' '));
    }
    cursor = o.end;
  });
  parts.push(bytes.subarray(cursor));

  const total = parts.reduce((t, p) => t + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  parts.forEach(p => { out.set(p, off); off += p.length; });
  return { bytes: out, hits };
}

function readPageContent(pdfDoc, pdfPage) {
  const { PDFArray, PDFRawStream, decodePDFRawStream } = window.PDFLib;
  const ctx = pdfDoc.context;
  const contents = pdfPage.node.Contents();
  if (!contents) return new Uint8Array(0);
  const streams = contents instanceof PDFArray
    ? contents.asArray().map(r => ctx.lookup(r))
    : [contents];
  const chunks = streams.map(s => (s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents()));
  const total = chunks.reduce((t, c) => t + c.length + 1, 0);
  const out = new Uint8Array(total);
  let off = 0;
  chunks.forEach(c => { out.set(c, off); off += c.length; out[off++] = 0x0a; });
  return out;
}

/**
 * Retire du flux de contenu de pdfPage (page pdf-lib de pdfDoc) le texte
 * dont l'origine tombe dans l'une des boîtes (espace utilisateur PDF :
 * { x0, y0, x1, y1 }). Les boîtes sans correspondance sont recouvertes.
 */
export function removeSourceText(pdfDoc, pdfPage, boxes) {
  if (!boxes || boxes.length === 0) return;
  const { PDFName } = window.PDFLib;
  const original = readPageContent(pdfDoc, pdfPage);
  const { bytes, hits } = stripTextFromContent(original, boxes);

  let tail = '';
  boxes.forEach((b, k) => {
    if (hits.has(k)) return;
    tail += `\nq 1 1 1 rg ${b.x0} ${b.y0} ${b.x1 - b.x0} ${b.y1 - b.y0} re f Q`;
  });

  // On réécrit le contenu en un seul flux, enveloppé dans q/Q pour qu'un
  // état graphique laissé ouvert n'affecte pas le cache de repli.
  const head = Uint8Array.from('q\n', c => c.charCodeAt(0));
  const foot = Uint8Array.from(`\nQ${tail}\n`, c => c.charCodeAt(0));
  const merged = new Uint8Array(head.length + bytes.length + foot.length);
  merged.set(head, 0);
  merged.set(bytes, head.length);
  merged.set(foot, head.length + bytes.length);

  const stream = pdfDoc.context.flateStream(merged);
  pdfPage.node.set(PDFName.of('Contents'), pdfDoc.context.register(stream));
}

/**
 * Boîte de suppression (espace utilisateur PDF) d'un item pdf.js
 * getTextContent. Texte horizontal supposé ; un peu de marge sous la ligne
 * de base pour les jambages.
 */
export function textItemBox(item) {
  const [a, b, c, d, e, f] = item.transform;
  const h = Math.hypot(c, d) || Math.hypot(a, b);
  return { x0: e, y0: f - h * 0.25, x1: e + item.width, y1: f + h };
}
