/* =============================================================================
   editor/shapes.js — géométrie propre aux shapes (rectangle / ellipse /
   ligne). Sert à la fois au rendu SVG (hit-test des lignes fines) et à
   l'export PDF (contour ramené à une liste de points, pivotée dans l'espace
   visuel puis reprojetée point par point par export.js — voir ce fichier
   pour le pourquoi : ça évite d'avoir à composer la rotation de l'élément
   avec la transformation de page (rotation /Rotate du PDF)).
============================================================================= */

import { frameCenter, rotateAround } from './geometry.js';

const ELLIPSE_SEGMENTS = 64;
const CORNER_SEGMENTS = 8;

function roundedRectLocalPoints(w, h, r) {
  const radius = Math.max(0, Math.min(r || 0, w / 2, h / 2));
  if (radius <= 0.01) {
    return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  }
  const pts = [];
  const corners = [
    { cx: w - radius, cy: radius, start: -90, end: 0 },
    { cx: w - radius, cy: h - radius, start: 0, end: 90 },
    { cx: radius, cy: h - radius, start: 90, end: 180 },
    { cx: radius, cy: radius, start: 180, end: 270 },
  ];
  corners.forEach(c => {
    for (let i = 0; i <= CORNER_SEGMENTS; i++) {
      const t = c.start + (c.end - c.start) * (i / CORNER_SEGMENTS);
      const rad = (t * Math.PI) / 180;
      pts.push({ x: c.cx + radius * Math.cos(rad), y: c.cy + radius * Math.sin(rad) });
    }
  });
  return pts;
}

/**
 * Contour de la shape en espace canvas (page-space), rotation appliquée.
 * Pour 'line'/'arrow' : les deux extrémités. Pour 'rect' : les coins
 * (arrondis échantillonnés si radius). Pour 'ellipse' : un polygone dense.
 */
export function shapeOutlinePoints(anno) {
  const frame = { x: anno.x, y: anno.y, width: anno.width, height: anno.height, rotation: anno.rotation || 0 };
  const c = frameCenter(frame);

  if (anno.shape === 'line' || anno.shape === 'arrow') {
    const p1 = rotateAround(anno.x, anno.y, c.x, c.y, frame.rotation);
    const p2 = rotateAround(anno.x + anno.width, anno.y + anno.height, c.x, c.y, frame.rotation);
    return [p1, p2];
  }

  if (anno.shape === 'ellipse') {
    const rx = anno.width / 2, ry = anno.height / 2;
    const pts = [];
    for (let i = 0; i < ELLIPSE_SEGMENTS; i++) {
      const t = (i / ELLIPSE_SEGMENTS) * Math.PI * 2;
      pts.push(rotateAround(c.x + rx * Math.cos(t), c.y + ry * Math.sin(t), c.x, c.y, frame.rotation));
    }
    return pts;
  }

  // rect (avec coins arrondis éventuels)
  const local = roundedRectLocalPoints(anno.width, anno.height, anno.radius);
  return local.map(p => rotateAround(anno.x + p.x, anno.y + p.y, c.x, c.y, frame.rotation));
}

export const SHAPE_MIN_SIZE = 2;

export const SHAPE_DEFAULTS = {
  rect: { fill: '#f0680022', stroke: '#120f0d', strokeWidth: 2, opacity: 1, radius: 0 },
  ellipse: { fill: '#f0680022', stroke: '#120f0d', strokeWidth: 2, opacity: 1 },
  line: { fill: 'none', stroke: '#120f0d', strokeWidth: 2, opacity: 1 },
};
