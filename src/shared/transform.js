// Transform: how a clip's picture sits in the frame. Every video and image clip
// has exactly one transform (unlike effects, which are an optional list).
// For now it holds the crop; position, scale, rotation and flip can follow.
//
// crop: fractions of the source picture (as displayed, after rotation metadata)
// removed from each edge. The remaining area is scaled to fit the frame
// ("zoom to fill"), with black bars only where its shape differs from the frame.

export const MIN_VISIBLE = 0.05; // at least 5% of the width/height stays

export function defaultTransform() {
  return { crop: { left: 0, right: 0, top: 0, bottom: 0 } };
}

const clamp01 = (x) => Math.min(1, Math.max(0, Number(x) || 0));
const round4 = (x) => Math.round(x * 10000) / 10000;

/**
 * Clamp a crop to valid values: each edge 0..1, and opposite edges together
 * leave at least MIN_VISIBLE. `keep` names the edge to preserve when they collide.
 */
export function normalizeCrop(crop, keep = null) {
  const c = { left: 0, right: 0, top: 0, bottom: 0, ...crop };
  for (const k of ['left', 'right', 'top', 'bottom']) c[k] = clamp01(c[k]);
  const fit = (a, b) => {
    const excess = c[a] + c[b] - (1 - MIN_VISIBLE);
    if (excess <= 0) return;
    // Share the cut between the edges (or take it from the one not being kept);
    // what one edge can't give, the other does.
    let fromA = keep === a ? 0 : keep === b ? excess : excess / 2;
    fromA = Math.min(fromA, c[a]);
    let fromB = excess - fromA;
    if (fromB > c[b]) {
      fromB = c[b];
      fromA = excess - fromB;
    }
    c[a] -= fromA;
    c[b] -= fromB;
  };
  fit('left', 'right');
  fit('top', 'bottom');
  for (const k of ['left', 'right', 'top', 'bottom']) c[k] = round4(Math.max(0, c[k]));
  return c;
}

export function cropOf(clip) {
  return clip?.transform?.crop ?? defaultTransform().crop;
}

export function hasCrop(clip) {
  const c = cropOf(clip);
  return c.left > 0 || c.right > 0 || c.top > 0 || c.bottom > 0;
}

/** The crop that removes black bars: cut the picture to the frame's shape, centered. */
export function fillFrameCrop(mediaWidth, mediaHeight, frameWidth, frameHeight) {
  const pictureAspect = mediaWidth / mediaHeight;
  const frameAspect = frameWidth / frameHeight;
  if (Math.abs(pictureAspect - frameAspect) < 1e-3) return defaultTransform().crop;
  if (pictureAspect > frameAspect) {
    const side = (1 - frameAspect / pictureAspect) / 2; // too wide: trim left and right
    return normalizeCrop({ left: side, right: side });
  }
  const side = (1 - pictureAspect / frameAspect) / 2; // too tall: trim top and bottom
  return normalizeCrop({ top: side, bottom: side });
}

/**
 * Where to draw a picture of mediaWidth x mediaHeight so that its cropped area
 * fits (contain) a box of boxWidth x boxHeight, centered. Returns the full
 * picture's rectangle (it overflows the box) plus the crop as CSS inset
 * percentages, which together show exactly the cropped area.
 */
export function cropLayout(mediaWidth, mediaHeight, crop, boxWidth, boxHeight) {
  const c = normalizeCrop(crop);
  const visibleW = mediaWidth * (1 - c.left - c.right);
  const visibleH = mediaHeight * (1 - c.top - c.bottom);
  const scale = Math.min(boxWidth / visibleW, boxHeight / visibleH);
  const offsetX = (boxWidth - visibleW * scale) / 2;
  const offsetY = (boxHeight - visibleH * scale) / 2;
  return {
    left: offsetX - mediaWidth * c.left * scale,
    top: offsetY - mediaHeight * c.top * scale,
    width: mediaWidth * scale,
    height: mediaHeight * scale,
    inset: `${c.top * 100}% ${c.right * 100}% ${c.bottom * 100}% ${c.left * 100}%`,
  };
}
