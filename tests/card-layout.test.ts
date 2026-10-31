import { describe, expect, it } from "vitest";
import { cardSafeArea, layoutCardLabels, publicCardAddress, type Box } from "../web/card-layout.js";

describe("card placement", () => {
  it("tries right, then left, then vertical gaps, avoiding even unlabelled glyphs", () => {
    const glyph = { left: 480, right: 520, top: 580, bottom: 620 };
    const label = { width: 160, height: 90, topOffset: -30, cy: 600, glyph };
    const right = layoutCardLabels([label], [glyph]);
    expect(right.positions[0]?.left).toBe(538);
    const blockingRight = { left: 560, right: 590, top: 580, bottom: 620 };
    const left = layoutCardLabels([label], [glyph, blockingRight]);
    expect(left.positions[0]?.left).toBe(302);
    const blockingLeft = { left: 400, right: 430, top: 580, bottom: 620 };
    const obstacles = [glyph, blockingRight, blockingLeft];
    const nudged = layoutCardLabels([label, label], obstacles);
    expect(nudged.scale).toBe(1);
    expect(nudged.positions[0]?.top).not.toBe(570);
    expect(layoutCardLabels([label, label], obstacles)).toEqual(nudged);
    const intersects = (a: Box, b: Box) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    nudged.positions.forEach((box, i) => {
      expect(box.left).toBeGreaterThanOrEqual(cardSafeArea.left);
      expect(box.right).toBeLessThanOrEqual(cardSafeArea.right);
      expect(box.top).toBeGreaterThanOrEqual(cardSafeArea.top);
      expect(box.bottom).toBeLessThanOrEqual(cardSafeArea.bottom);
      for (const other of [...obstacles, ...nudged.positions.slice(i + 1)])
        expect(intersects(box, other)).toBe(false);
    });
  });
  it.each(["localhost", "127.0.0.1", "[::1]"])("omits the local %s card address", (host) => {
    expect(publicCardAddress(`http://${host}:3000/card/fixture`)).toBeUndefined();
  });
  it("keeps public card addresses and omits invalid URLs", () => {
    const url = "https://starmark.example/card/fixture";
    expect(publicCardAddress(url)).toBe(url);
    expect(publicCardAddress("invalid")).toBeUndefined();
  });
});
