/* =============================================================================
   editor/snapping.js — moteur de snapping générique (bords / centres /
   page / guides). Pure : ne connaît ni le DOM ni le type d'élément, ne
   travaille que sur des bounding boxes en espace canvas.
============================================================================= */

function edgeAndCenterCandidates(frame, axis) {
  return axis === 'x'
    ? [frame.x, frame.x + frame.width / 2, frame.x + frame.width]
    : [frame.y, frame.y + frame.height / 2, frame.y + frame.height];
}

/**
 * movingFrame: {x,y,width,height} — bbox de la sélection en cours de move.
 * otherFrames: [{x,y,width,height}] — bbox des autres éléments de la page.
 * pageBounds: {width, height} — taille de la page (espace canvas).
 * guideLines: [{axis:'x'|'y', value}] — guides manuels (espace canvas), optionnel.
 * toleranceCanvas: tolérance de snap déjà convertie en unités canvas.
 *
 * Retourne { dx, dy, guides } où dx/dy est la correction à appliquer à la
 * position de la sélection, et guides la liste des lignes à afficher
 * pendant le geste.
 */
export function computeSnap(movingFrame, otherFrames, pageBounds, guideLines, toleranceCanvas) {
  const movingX = edgeAndCenterCandidates(movingFrame, 'x');
  const movingY = edgeAndCenterCandidates(movingFrame, 'y');

  const targetsX = [];
  const targetsY = [];

  otherFrames.forEach(f => {
    targetsX.push(...edgeAndCenterCandidates(f, 'x'));
    targetsY.push(...edgeAndCenterCandidates(f, 'y'));
  });
  targetsX.push(0, pageBounds.width / 2, pageBounds.width);
  targetsY.push(0, pageBounds.height / 2, pageBounds.height);
  (guideLines || []).forEach(g => {
    if (g.axis === 'x') targetsX.push(g.value);
    else targetsY.push(g.value);
  });

  let bestDx = 0, bestDxDist = toleranceCanvas, guideX = null;
  movingX.forEach(m => {
    targetsX.forEach(t => {
      const dist = Math.abs(m - t);
      if (dist < bestDxDist) {
        bestDxDist = dist;
        bestDx = t - m;
        guideX = t;
      }
    });
  });

  let bestDy = 0, bestDyDist = toleranceCanvas, guideY = null;
  movingY.forEach(m => {
    targetsY.forEach(t => {
      const dist = Math.abs(m - t);
      if (dist < bestDyDist) {
        bestDyDist = dist;
        bestDy = t - m;
        guideY = t;
      }
    });
  });

  const guides = [];
  if (guideX !== null) guides.push({ axis: 'x', value: guideX });
  if (guideY !== null) guides.push({ axis: 'y', value: guideY });

  return { dx: bestDx, dy: bestDy, guides };
}
