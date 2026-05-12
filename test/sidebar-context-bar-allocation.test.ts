import { describe, expect, test } from "bun:test";
import { allocateContextBarCells } from "../src/tui/sidebar.js";

describe("allocateContextBarCells", () => {
  test("when usage exceeds cap, scales all segments proportionally so small slices stay visible", () => {
    const cap = 200_000;
    const breakdown = {
      systemPrompt: 6_400,
      messages: 200_000,
      localMemory: 10_000,
      globalMemory: 9_600,
    };
    const used =
      breakdown.systemPrompt + breakdown.messages + breakdown.localMemory + breakdown.globalMemory;

    const { segmentCells, untrackedCells, emptyCells } = allocateContextBarCells(
      breakdown,
      used,
      cap,
      25,
    );

    const filled = segmentCells.reduce((a, b) => a + b, 0) + untrackedCells;
    expect(filled + emptyCells).toBe(25);
    expect(filled).toBe(25);
    expect(emptyCells).toBe(0);
    expect(segmentCells[0]).toBeGreaterThan(0);
    expect(segmentCells[1]).toBeGreaterThan(0);
    expect(segmentCells[2]).toBeGreaterThan(0);
    expect(segmentCells[3]).toBeGreaterThan(0);
    expect(untrackedCells).toBe(0);
    expect(segmentCells[1]).toBeGreaterThan(segmentCells[2]);
    expect(segmentCells[2]).toBeGreaterThanOrEqual(1);
    expect(segmentCells[3]).toBeGreaterThanOrEqual(1);
  });

  test("under cap leaves empty headroom and keeps proportions", () => {
    const cap = 200_000;
    const breakdown = {
      systemPrompt: 5_000,
      messages: 30_000,
      localMemory: 0,
      globalMemory: 10_000,
    };
    const used = 78_000;

    const { segmentCells, untrackedCells, emptyCells } = allocateContextBarCells(
      breakdown,
      used,
      cap,
      25,
    );

    expect(segmentCells.reduce((a, b) => a + b, 0) + untrackedCells + emptyCells).toBe(25);
    expect(segmentCells[2]).toBe(0);
    expect(untrackedCells).toBeGreaterThan(0);
    expect(emptyCells).toBeGreaterThan(0);
  });
});
