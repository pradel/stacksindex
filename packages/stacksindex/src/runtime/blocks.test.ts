import { describe, expect, test } from "vite-plus/test";

import { type BlockSourceRange, isBlockSourceHeight, nextBlockSourceHeight } from "./blocks.ts";

/** Heights in `[from, to]` the source runs at, per `isBlockSourceHeight`. */
const runHeights = (source: BlockSourceRange, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index).filter((height) =>
    isBlockSourceHeight(source, height),
  );

/** Heights reached by following `nextBlockSourceHeight` from `from` up to `to`. */
const walkHeights = (source: BlockSourceRange, from: number, to: number) => {
  const heights: number[] = [];

  for (
    let height = nextBlockSourceHeight(source, from);
    height !== undefined && height <= to;
    height = nextBlockSourceHeight(source, height)
  ) {
    heights.push(height);
  }

  return heights;
};

// oxlint-disable-next-line vitest/prefer-describe-function-title
describe("isBlockSourceHeight", () => {
  test("runs at startBlock + k * interval for an unaligned startBlock", () => {
    const source = { interval: 10, startBlock: 103 };

    expect(runHeights(source, 90, 135)).toStrictEqual([103, 113, 123, 133]);
  });

  test("runs at every height from startBlock with interval 1", () => {
    expect(runHeights({ interval: 1, startBlock: 5 }, 0, 9)).toStrictEqual([5, 6, 7, 8, 9]);
  });

  test("includes an endBlock it lands on and nothing past it", () => {
    const source = { interval: 5, startBlock: 100, endBlock: 110 };

    expect(isBlockSourceHeight(source, 110)).toBe(true);
    expect(isBlockSourceHeight(source, 115)).toBe(false);
    expect(runHeights(source, 95, 130)).toStrictEqual([100, 105, 110]);
  });

  test("stops at the last aligned height before an unaligned endBlock", () => {
    expect(runHeights({ interval: 5, startBlock: 100, endBlock: 112 }, 95, 130)).toStrictEqual([
      100, 105, 110,
    ]);
  });

  test("runs at startBlock 0", () => {
    expect(runHeights({ interval: 3, startBlock: 0 }, 0, 7)).toStrictEqual([0, 3, 6]);
  });
});

// oxlint-disable-next-line vitest/prefer-describe-function-title
describe("nextBlockSourceHeight", () => {
  test("returns startBlock for any height below it", () => {
    const source = { interval: 10, startBlock: 103 };

    expect(nextBlockSourceHeight(source, 0)).toBe(103);
    expect(nextBlockSourceHeight(source, 101)).toBe(103);
    expect(nextBlockSourceHeight(source, 102)).toBe(103);
  });

  test("returns the next aligned height above, not at, the given height", () => {
    const source = { interval: 10, startBlock: 103 };

    expect(nextBlockSourceHeight(source, 103)).toBe(113);
    expect(nextBlockSourceHeight(source, 104)).toBe(113);
    expect(nextBlockSourceHeight(source, 112)).toBe(113);
    expect(nextBlockSourceHeight(source, 113)).toBe(123);
  });

  test("returns the following height with interval 1", () => {
    const source = { interval: 1, startBlock: 5 };

    expect(nextBlockSourceHeight(source, 4)).toBe(5);
    expect(nextBlockSourceHeight(source, 5)).toBe(6);
    expect(nextBlockSourceHeight(source, 41)).toBe(42);
  });

  test("returns startBlock 0 from below it", () => {
    expect(nextBlockSourceHeight({ interval: 4, startBlock: 0 }, -1)).toBe(0);
  });

  test("returns an endBlock it lands on, then undefined", () => {
    const source = { interval: 5, startBlock: 100, endBlock: 110 };

    expect(nextBlockSourceHeight(source, 105)).toBe(110);
    expect(nextBlockSourceHeight(source, 109)).toBe(110);
    expect(nextBlockSourceHeight(source, 110)).toBeUndefined();
  });

  test("returns undefined when the next aligned height is past endBlock", () => {
    const source = { interval: 5, startBlock: 100, endBlock: 112 };

    expect(nextBlockSourceHeight(source, 110)).toBeUndefined();
    expect(nextBlockSourceHeight(source, 200)).toBeUndefined();
  });

  test("returns the only height of a source whose startBlock is its endBlock, once", () => {
    expect(
      nextBlockSourceHeight({ interval: 1, startBlock: 50, endBlock: 50 }, 50),
    ).toBeUndefined();
    expect(nextBlockSourceHeight({ interval: 1, startBlock: 50, endBlock: 50 }, 10)).toBe(50);
  });

  test("walks exactly the heights isBlockSourceHeight accepts", () => {
    const sources: BlockSourceRange[] = [
      { interval: 1, startBlock: 7 },
      { interval: 7, startBlock: 3, endBlock: 60 },
      { interval: 30, startBlock: 11, endBlock: 131 },
      { interval: 45, startBlock: 0 },
    ];

    for (const source of sources) {
      expect(walkHeights(source, -1, 200)).toStrictEqual(runHeights(source, 0, 200));
    }
  });
});
