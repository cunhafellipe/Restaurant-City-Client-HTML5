/**
 * Deterministic shelf packers for atlas building.
 *
 * Frames are sorted by height desc, then key, so the same input always
 * produces the same layout. Large corpora are split into bounded pages.
 */
function sortedFrames(frames) {
  return [...frames].sort(
    (a, b) => b.h - a.h || String(a.key).localeCompare(String(b.key)),
  );
}

export function packFramePages(
  frames,
  { maxWidth = 4096, maxHeight = 4096, padding = 2 } = {},
) {
  if (maxWidth <= 0 || maxHeight <= 0 || padding < 0) {
    throw new Error('invalid atlas bounds');
  }

  const pages = [];
  let placements = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  let width = 0;

  const finishPage = () => {
    if (placements.length === 0) return;
    pages.push({ width, height: y + rowH, placements });
    placements = [];
    x = 0;
    y = 0;
    rowH = 0;
    width = 0;
  };

  for (const f of sortedFrames(frames)) {
    const paddedW = f.w + padding * 2;
    const paddedH = f.h + padding * 2;

    if (paddedW > maxWidth || paddedH > maxHeight) {
      throw new Error(
        `frame ${f.key} (${f.w}x${f.h}) exceeds atlas page ${maxWidth}x${maxHeight}`,
      );
    }

    let nextX = x;
    let nextY = y;
    let nextRowH = rowH;

    if (nextX > 0 && nextX + paddedW > maxWidth) {
      nextY += nextRowH;
      nextX = 0;
      nextRowH = 0;
    }

    if (placements.length > 0 && nextY + paddedH > maxHeight) {
      finishPage();
      nextX = 0;
      nextY = 0;
      nextRowH = 0;
    }

    placements.push({
      key: f.key,
      x: nextX + padding,
      y: nextY + padding,
      w: f.w,
      h: f.h,
    });

    nextX += paddedW;
    nextRowH = Math.max(nextRowH, paddedH);
    x = nextX;
    y = nextY;
    rowH = nextRowH;
    width = Math.max(width, x);
  }

  finishPage();
  return pages;
}

export function packFrames(frames, { maxWidth = 4096, padding = 2 } = {}) {
  const pages = packFramePages(frames, {
    maxWidth,
    maxHeight: Number.MAX_SAFE_INTEGER,
    padding,
  });
  return pages[0] ?? { width: 0, height: 0, placements: [] };
}
