/* =============================================================================
   editor/geometry.js — géométrie pure du calque de transform générique.
   Aucun accès DOM ici : uniquement des fonctions sur des données
   { x, y, width, height, rotation } (« frame ») et des points.
============================================================================= */

export function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

export function degToRad(d) { return (d * Math.PI) / 180; }
export function radToDeg(r) { return (r * 180) / Math.PI; }

// Rotation d'un point autour d'un centre (angle en degrés, sens horaire —
// convention écran/canvas où y augmente vers le bas).
export function rotateAround(x, y, cx, cy, angleDeg) {
  if (!angleDeg) return { x, y };
  const a = degToRad(angleDeg);
  const cos = Math.cos(a), sin = Math.sin(a);
  const dx = x - cx, dy = y - cy;
  return {
    x: cx + dx * cos - dy * sin,
    y: cy + dx * sin + dy * cos,
  };
}

// Rotation d'un vecteur (delta, pas de translation) — pour un delta pointeur.
export function rotateVector(dx, dy, angleDeg) {
  if (!angleDeg) return { x: dx, y: dy };
  const a = degToRad(angleDeg);
  const cos = Math.cos(a), sin = Math.sin(a);
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
}

export function frameCenter(frame) {
  return { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
}

export function boundsFromPoints(points) {
  if (!points || points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, width: Math.max(0, maxX - minX), height: Math.max(0, maxY - minY) };
}

// Bounding box englobante d'une liste de frames (utilisé pour la sélection
// multiple). Retourne null si la liste est vide.
export function unionFrames(frames) {
  const list = frames.filter(Boolean);
  if (list.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const f of list) {
    minX = Math.min(minX, f.x);
    minY = Math.min(minY, f.y);
    maxX = Math.max(maxX, f.x + f.width);
    maxY = Math.max(maxY, f.y + f.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// Coins d'une frame (potentiellement pivotée), en espace canvas, dans
// l'ordre nw, ne, se, sw.
export function frameCorners(frame) {
  const c = frameCenter(frame);
  const hw = frame.width / 2, hh = frame.height / 2;
  const local = [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh },
  ];
  return local.map(p => rotateAround(c.x + p.x, c.y + p.y, c.x, c.y, frame.rotation || 0));
}

const HANDLE_SIGN = {
  n: { sx: 0, sy: -1 }, s: { sx: 0, sy: 1 },
  e: { sx: 1, sy: 0 }, w: { sx: -1, sy: 0 },
  ne: { sx: 1, sy: -1 }, nw: { sx: -1, sy: -1 },
  se: { sx: 1, sy: 1 }, sw: { sx: -1, sy: 1 },
};

export const RESIZE_HANDLES = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];

/**
 * Calcule la nouvelle frame issue d'un geste de resize, en tenant
 * correctement compte de la rotation de l'élément : le delta pointeur
 * (espace canvas) est ramené dans l'espace local (non pivoté) de l'élément
 * avant d'ajuster largeur/hauteur, puis le nouveau centre est recalculé et
 * re-pivoté — évite tout décalage de l'objet pendant le resize.
 *
 * oldFrame: {x,y,width,height,rotation} — frame au DÉBUT du geste (snapshot).
 * handle: une valeur de RESIZE_HANDLES.
 * dxCanvas/dyCanvas: delta pointeur cumulé depuis le début du geste (espace canvas).
 * opts: { keepRatio, fromCenter, minWidth, minHeight }
 */
export function computeResizedFrame(oldFrame, handle, dxCanvas, dyCanvas, opts = {}) {
  const { sx, sy } = HANDLE_SIGN[handle] || { sx: 0, sy: 0 };
  const rotation = oldFrame.rotation || 0;
  const minWidth = opts.minWidth ?? 1;
  const minHeight = opts.minHeight ?? 1;
  const fromCenter = !!opts.fromCenter;
  const keepRatio = !!opts.keepRatio;

  const local = rotateVector(dxCanvas, dyCanvas, -rotation);
  const factor = fromCenter ? 2 : 1;

  let newWidth = oldFrame.width + (sx !== 0 ? sx * local.x * factor : 0);
  let newHeight = oldFrame.height + (sy !== 0 ? sy * local.y * factor : 0);

  if (keepRatio && oldFrame.width > 0 && oldFrame.height > 0) {
    const ratio = oldFrame.width / oldFrame.height;
    if (sx !== 0 && sy !== 0) {
      const scaleW = newWidth / oldFrame.width;
      const scaleH = newHeight / oldFrame.height;
      const scale = Math.abs(scaleW - 1) > Math.abs(scaleH - 1) ? scaleW : scaleH;
      newWidth = oldFrame.width * scale;
      newHeight = oldFrame.height * scale;
    } else if (sx !== 0) {
      newHeight = newWidth / ratio;
    } else if (sy !== 0) {
      newWidth = newHeight * ratio;
    }
  }

  newWidth = Math.max(minWidth, newWidth);
  newHeight = Math.max(minHeight, newHeight);

  const oldCenter = frameCenter(oldFrame);
  let anchorCanvas;
  if (fromCenter) {
    anchorCanvas = oldCenter;
  } else {
    const anchorLocal = { x: -sx * oldFrame.width / 2, y: -sy * oldFrame.height / 2 };
    anchorCanvas = rotateAround(oldCenter.x + anchorLocal.x, oldCenter.y + anchorLocal.y, oldCenter.x, oldCenter.y, rotation);
  }

  let newCenter;
  if (fromCenter) {
    newCenter = oldCenter;
  } else {
    const offsetLocal = { x: sx * newWidth / 2, y: sy * newHeight / 2 };
    const rotatedOffset = rotateVector(offsetLocal.x, offsetLocal.y, rotation);
    newCenter = { x: anchorCanvas.x + rotatedOffset.x, y: anchorCanvas.y + rotatedOffset.y };
  }

  return {
    x: newCenter.x - newWidth / 2,
    y: newCenter.y - newHeight / 2,
    width: newWidth,
    height: newHeight,
    rotation,
  };
}

// Angle courant d'un geste de rotation. snapDeg (ex. 15) arrondit par palier.
export function computeRotation(center, startPointer, currentPointer, startRotation, snapDeg) {
  const startAngle = Math.atan2(startPointer.y - center.y, startPointer.x - center.x);
  const currentAngle = Math.atan2(currentPointer.y - center.y, currentPointer.x - center.x);
  let deg = startRotation + radToDeg(currentAngle - startAngle);
  if (snapDeg) deg = Math.round(deg / snapDeg) * snapDeg;
  return ((deg % 360) + 360) % 360;
}

export function pointInRotatedRect(px, py, frame) {
  const c = frameCenter(frame);
  const local = rotateAround(px, py, c.x, c.y, -(frame.rotation || 0));
  return local.x >= frame.x && local.x <= frame.x + frame.width &&
         local.y >= frame.y && local.y <= frame.y + frame.height;
}

export function pointInEllipseFrame(px, py, frame) {
  const c = frameCenter(frame);
  const local = rotateAround(px, py, c.x, c.y, -(frame.rotation || 0));
  const rx = frame.width / 2 || 0.0001;
  const ry = frame.height / 2 || 0.0001;
  const nx = (local.x - c.x) / rx;
  const ny = (local.y - c.y) / ry;
  return nx * nx + ny * ny <= 1;
}

export function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  let t = lengthSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lengthSq : 0;
  t = clamp(t, 0, 1);
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// Deux rectangles (axis-aligned) se chevauchent-ils ? Utilisé pour la
// sélection par rectangle (marquee).
export function rectsIntersect(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x &&
         a.y < b.y + b.height && a.y + a.height > b.y;
}
