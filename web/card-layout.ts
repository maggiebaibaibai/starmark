export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export interface CardLabel {
  width: number;
  height: number;
  /** Preferred top relative to the star, measured after fonts have loaded. */
  topOffset: number;
  cy: number;
  glyph: Box;
}
export const cardSafeArea: Box = { left: 84, top: 420, right: 996, bottom: 1080 };

function intersects(a: Box, b: Box, gap = 12) {
  return (
    a.left < b.right + gap && a.right > b.left - gap &&
    a.top < b.bottom + gap && a.bottom > b.top - gap
  );
}

/** Stable priority order, real text bounds, and all glyphs (including later stars).
 * First try right, then left, then the nearest clear vertical position.
 * Only exceptionally crowded cards compact labels; glyphs never move or scale.
 */
export function layoutCardLabels(labels: CardLabel[], obstacles: Box[]) {
  for (let scale = 1; scale >= 0.25; scale *= 0.9) {
    const occupied = [...obstacles];
    const positions: Box[] = [];
    for (const label of labels) {
      const width = label.width * scale, height = label.height * scale;
      const preferredTop = label.cy + label.topOffset * scale;
      const sides = [label.glyph.right + 18, label.glyph.left - 18 - width];
      const rows = [...new Set([
        preferredTop, cardSafeArea.top, cardSafeArea.bottom - height,
        ...occupied.flatMap((box) => [box.top - 12 - height, box.bottom + 12]),
      ])].sort((a, b) =>
        Math.abs(a - preferredTop) - Math.abs(b - preferredTop) || a - b,
      );
      const fits = (left: number, top: number) => {
        const box = { left, top, right: left + width, bottom: top + height };
        return (
          box.left >= cardSafeArea.left && box.right <= cardSafeArea.right &&
          box.top >= cardSafeArea.top && box.bottom <= cardSafeArea.bottom &&
          !occupied.some((other) => intersects(box, other))
        ) ? box : undefined;
      };
      let position: Box | undefined;
      for (const row of rows) {
        for (const side of sides) {
          position = fits(side, row);
          if (position) break;
        }
        if (position) break;
      }
      // At an edge or in a dense cluster, use the remaining interior gaps.
      if (!position) {
        const columns = [
          cardSafeArea.left, cardSafeArea.right - width,
          ...occupied.flatMap((box) => [box.left - 12 - width, box.right + 12]),
        ];
        for (const row of rows) {
          for (const column of columns) {
            position = fits(column, row);
            if (position) break;
          }
          if (position) break;
        }
      }
      if (!position) break;
      occupied.push(position);
      positions.push(position);
    }
    if (positions.length === labels.length) return { positions, scale };
  }
  throw new Error("Card labels exceed the available safe area");
}

export function publicCardAddress(url: string): string | undefined {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)
      ? undefined : url;
  } catch {
    return undefined;
  }
}
