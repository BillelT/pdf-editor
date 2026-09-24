/* =============================================================================
   editor/export.js — construction du PDF exporté (pdf-lib).
   ---------------------------------------------------------------------------
   Le contenu d'origine (texte, images, vecteurs du PDF source) est recopié
   tel quel via pdf-lib (copyPages) au lieu d'être rasterisé — voir
   drawAnnotationsVector. Les annotations (texte, tracés, shapes) sont
   dessinées en tant qu'objets PDF natifs, donc résolution-indépendantes.

   Rotation : plutôt que de composer la rotation propre d'un élément avec la
   transformation de page (rotation /Rotate + flip y de repère), on calcule
   le contour de l'élément (points) déjà pivoté en espace VISUEL, puis on
   reprojette CHAQUE POINT individuellement vers l'espace PDF brut via
   visualToRaw — exactement comme le fait déjà le tracé au stylo (une liste
   de points). Ça évite tout calcul de composition de rotations/réflexions.
   Le texte n'est pas pivotable dans cette version (drawText ne se prête pas
   au même traitement point par point) : rotation toujours 0 pour le texte.
============================================================================= */

import { shapeOutlinePoints } from './shapes.js';

function hexToRgb01(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex || '#000000');
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

// Une page PDF a un contenu "brut" (raw, origine en bas à gauche, non
// affecté par /Rotate) et un rendu "visuel" tel qu'affiché par le lecteur
// (celui que voit pdf.js/le canvas d'édition, origine en haut à gauche).
// Nos annotations sont créées en coordonnées visuelles ; pour les dessiner
// dans le PDF il faut les reprojeter en coordonnées brutes selon la
// rotation de la page. Vérifié empiriquement (rendu pdf.js) pour les 4
// valeurs possibles de /Rotate.
function pageTransform(pdfPage, page) {
  const rot = ((pdfPage.getRotation().angle % 360) + 360) % 360;
  return { rot, rawWidth: pdfPage.getWidth(), rawHeight: pdfPage.getHeight(), scale: page.scale };
}

function visualToRaw(t, canvasX, canvasY) {
  const vx = canvasX / t.scale;
  const vy = canvasY / t.scale;
  switch (t.rot) {
    case 90: return { x: vy, y: vx };
    case 180: return { x: t.rawWidth - vx, y: vy };
    case 270: return { x: t.rawWidth - vy, y: t.rawHeight - vx };
    default: return { x: vx, y: t.rawHeight - vy };
  }
}

const STANDARD_FONT_VARIANTS = {
  sans: { regular: 'Helvetica', bold: 'HelveticaBold', italic: 'HelveticaOblique', boldItalic: 'HelveticaBoldOblique' },
  serif: { regular: 'TimesRoman', bold: 'TimesRomanBold', italic: 'TimesRomanItalic', boldItalic: 'TimesRomanBoldItalic' },
};

async function getStandardFont(pdfDoc, fontCache, family, weight, italic) {
  const bold = weight >= 600;
  const variant = bold && italic ? 'boldItalic' : bold ? 'bold' : italic ? 'italic' : 'regular';
  const key = STANDARD_FONT_VARIANTS[family === 'serif' ? 'serif' : 'sans'][variant];
  if (!fontCache[key]) {
    const { StandardFonts } = window.PDFLib;
    fontCache[key] = await pdfDoc.embedFont(StandardFonts[key]);
  }
  return fontCache[key];
}

function wrapTextForFont(font, text, maxWidthPt, fontSizePt) {
  const out = [];
  text.split('\n').forEach(paragraph => {
    const words = paragraph.split(' ');
    let line = '';
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(test, fontSizePt) > maxWidthPt && line) {
        out.push(line);
        line = w;
      } else {
        line = test;
      }
    }
    out.push(line);
  });
  return out;
}

async function drawTextVector(pdfPage, anno, pdfDoc, fontCache, t) {
  if (!anno.content) return;
  const { rgb, degrees } = window.PDFLib;
  const font = await getStandardFont(pdfDoc, fontCache, anno.font, anno.weight, anno.italic);
  const scale = t.scale;
  const fontSizePt = anno.size / scale;
  const maxWidthPt = anno.width / scale;
  const lineHeightCanvas = anno.size * 1.3;
  const ascentPt = font.heightAtSize(fontSizePt, { descender: false });
  const [r, g, b] = hexToRgb01(anno.color);

  const lines = wrapTextForFont(font, anno.content, maxWidthPt, fontSizePt);
  lines.forEach((line, i) => {
    if (!line) return;
    const visualBaselineY = anno.y + 2 + i * lineHeightCanvas + ascentPt * scale;
    const raw = visualToRaw(t, anno.x + 4, visualBaselineY);
    pdfPage.drawText(line, {
      x: raw.x, y: raw.y,
      size: fontSizePt, font, color: rgb(r, g, b),
      rotate: degrees(t.rot),
    });
  });
}

function drawStrokeVector(pdfPage, stroke, t) {
  if (!stroke.points || stroke.points.length === 0) return;
  const { rgb, LineCapStyle } = window.PDFLib;
  const [r, g, b] = hexToRgb01(stroke.color);
  const toPt = (p) => visualToRaw(t, p.x, p.y);
  const thickness = Math.max(0.1, stroke.size / t.scale);
  const color = rgb(r, g, b);

  if (stroke.points.length === 1) {
    const p = toPt(stroke.points[0]);
    pdfPage.drawLine({ start: p, end: p, thickness, color, lineCap: LineCapStyle.Round });
    return;
  }
  for (let i = 1; i < stroke.points.length; i++) {
    pdfPage.drawLine({
      start: toPt(stroke.points[i - 1]),
      end: toPt(stroke.points[i]),
      thickness, color, lineCap: LineCapStyle.Round,
    });
  }
}

function drawShapeVector(pdfPage, anno, t) {
  const { rgb, LineCapStyle } = window.PDFLib;
  const hasFill = anno.fill && anno.fill !== 'none';
  const hasStroke = anno.stroke && anno.stroke !== 'none' && (anno.strokeWidth || 0) > 0;
  const opacity = anno.opacity ?? 1;
  const pts = shapeOutlinePoints(anno).map(p => visualToRaw(t, p.x, p.y));

  if (anno.shape === 'line' || anno.shape === 'arrow') {
    if (!hasStroke) return;
    const [r, g, b] = hexToRgb01(anno.stroke);
    pdfPage.drawLine({
      start: pts[0], end: pts[1],
      thickness: Math.max(0.1, anno.strokeWidth / t.scale),
      color: rgb(r, g, b), opacity, lineCap: LineCapStyle.Round,
    });
    return;
  }

  if (!hasFill && !hasStroke) return;
  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ') + ' Z';
  const opts = { opacity, borderOpacity: opacity };
  if (hasFill) {
    const [r, g, b] = hexToRgb01(anno.fill);
    opts.color = rgb(r, g, b);
  }
  if (hasStroke) {
    const [r, g, b] = hexToRgb01(anno.stroke);
    opts.borderColor = rgb(r, g, b);
    opts.borderWidth = Math.max(0, anno.strokeWidth / t.scale);
  }
  pdfPage.drawSvgPath(path, opts);
}

async function drawAnnotationsVector(pdfPage, page, pdfDoc, fontCache) {
  const t = pageTransform(pdfPage, page);
  for (const a of page.annotations) {
    if (a.type === 'shape') drawShapeVector(pdfPage, a, t);
    else if (a.type === 'stroke') drawStrokeVector(pdfPage, a, t);
  }
  for (const a of page.annotations) {
    if (a.type === 'text') await drawTextVector(pdfPage, a, pdfDoc, fontCache, t);
  }
}

// ---------- Repli raster (cas limite, ex. caractère non supporté) ---------
//
// Composite canvas (rendu PDF + strokes + shapes + textes) → PNG embarqué.
// Perd en résolution ; ne sert que de filet de sécurité si le dessin
// vectoriel d'une page échoue, pour cette page uniquement.

function drawStrokeToCtx(ctx, stroke) {
  if (stroke.points.length === 0) return;
  ctx.save();
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
  for (let i = 1; i < stroke.points.length; i++) {
    const p = stroke.points[i];
    const prev = stroke.points[i - 1];
    const mx = (p.x + prev.x) / 2;
    const my = (p.y + prev.y) / 2;
    ctx.quadraticCurveTo(prev.x, prev.y, mx, my);
  }
  const last = stroke.points[stroke.points.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
  ctx.restore();
}

function drawShapeToCtx(ctx, anno) {
  ctx.save();
  ctx.globalAlpha = anno.opacity ?? 1;
  const pts = shapeOutlinePoints(anno);
  if (anno.shape === 'line' || anno.shape === 'arrow') {
    if (anno.stroke && anno.stroke !== 'none') {
      ctx.strokeStyle = anno.stroke;
      ctx.lineWidth = anno.strokeWidth || 1;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[1].x, pts[1].y);
      ctx.stroke();
    }
    ctx.restore();
    return;
  }
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
  if (anno.fill && anno.fill !== 'none') {
    ctx.fillStyle = anno.fill;
    ctx.fill();
  }
  if (anno.stroke && anno.stroke !== 'none' && (anno.strokeWidth || 0) > 0) {
    ctx.strokeStyle = anno.stroke;
    ctx.lineWidth = anno.strokeWidth;
    ctx.stroke();
  }
  ctx.restore();
}

function wrapText(ctx, text, maxWidth) {
  const out = [];
  text.split('\n').forEach(paragraph => {
    const words = paragraph.split(' ');
    let line = '';
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (ctx.measureText(test).width > maxWidth && line) {
        out.push(line);
        line = w;
      } else {
        line = test;
      }
    }
    out.push(line);
  });
  return out;
}

function drawTextToCtx(ctx, anno) {
  ctx.save();
  const family = anno.font === 'serif'
    ? "'Zodiak', Georgia, serif"
    : "'Switzer', system-ui, sans-serif";
  const style = anno.italic ? 'italic' : 'normal';
  ctx.font = `${style} ${anno.weight} ${anno.size}px ${family}`;
  ctx.fillStyle = anno.color;
  ctx.textBaseline = 'top';
  const lines = wrapText(ctx, anno.content || '', anno.width);
  const lineHeight = anno.size * 1.3;
  lines.forEach((line, i) => {
    ctx.fillText(line, anno.x + 4, anno.y + 2 + i * lineHeight);
  });
  ctx.restore();
}

async function rasterizePageIntoDoc(pdfDoc, page) {
  const out = document.createElement('canvas');
  out.width = page.width;
  out.height = page.height;
  const ctx = out.getContext('2d');

  ctx.drawImage(page.canvas, 0, 0);
  for (const a of page.annotations) {
    if (a.type === 'shape') drawShapeToCtx(ctx, a);
    else if (a.type === 'stroke') drawStrokeToCtx(ctx, a);
  }
  for (const a of page.annotations) {
    if (a.type === 'text') drawTextToCtx(ctx, a);
  }

  const pngBytes = await new Promise(resolve => {
    out.toBlob(blob => blob.arrayBuffer().then(resolve), 'image/png');
  });
  const img = await pdfDoc.embedPng(pngBytes);
  const pdfPage = pdfDoc.addPage([page.pdfWidth, page.pdfHeight]);
  pdfPage.drawImage(img, { x: 0, y: 0, width: page.pdfWidth, height: page.pdfHeight });
}

/**
 * Construit les bytes du PDF exporté à partir des pages de l'éditeur.
 * pages: state.pages (voir app.js) — chaque page a annotations/canvas/scale/pdfWidth/pdfHeight.
 * sourcePdfBytes: bytes du PDF d'origine chargé dans l'éditeur, ou null (page(s) blanche(s)).
 */
export async function buildExportedPdfBytes(pages, sourcePdfBytes) {
  const { PDFDocument } = window.PDFLib;
  const pdfDoc = await PDFDocument.create();
  const fontCache = {};

  let srcDoc = null;
  if (sourcePdfBytes) {
    try {
      srcDoc = await PDFDocument.load(sourcePdfBytes, { ignoreEncryption: true });
    } catch {
      srcDoc = null; // source illisible → repli raster page par page
    }
  }

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];

    if (srcDoc && i < srcDoc.getPageCount()) {
      const [copied] = await pdfDoc.copyPages(srcDoc, [i]);
      const pdfPage = pdfDoc.addPage(copied);
      try {
        await drawAnnotationsVector(pdfPage, page, pdfDoc, fontCache);
      } catch {
        // Ex : caractère non supporté par les fonts standard PDF → repli
        // raster pour cette page uniquement, le reste du document garde
        // son export vectoriel.
        pdfDoc.removePage(pdfDoc.getPageCount() - 1);
        await rasterizePageIntoDoc(pdfDoc, page);
      }
      continue;
    }

    // Page vierge (pas de PDF source) : page pdf-lib native, 100% vectorielle
    const pdfPage = pdfDoc.addPage([page.pdfWidth, page.pdfHeight]);
    try {
      await drawAnnotationsVector(pdfPage, page, pdfDoc, fontCache);
    } catch {
      pdfDoc.removePage(pdfDoc.getPageCount() - 1);
      await rasterizePageIntoDoc(pdfDoc, page);
    }
  }

  return pdfDoc.save();
}
