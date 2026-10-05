import { describe, expect, it } from "vitest";
import { formatNumber, isCorrect, normalizeAnswer, parseNumber } from "../src/grading.js";

describe("tallsvar", () => {
  it("leser tall slik elever skriver dem", () => {
    expect(parseNumber("12,5")).toBe(12.5);
    expect(parseNumber("12.5")).toBe(12.5);
    expect(parseNumber(" 12 500 ")).toBe(12500);
    expect(parseNumber("−3")).toBe(-3);
    expect(parseNumber(",5")).toBe(0.5);
    expect(parseNumber("12,50")).toBe(12.5);
    expect(parseNumber("12 kr")).toBeNull();
    expect(parseNumber("1/2")).toBeNull();
    expect(parseNumber("")).toBeNull();
  });

  it("skriver tall på norsk form", () => {
    expect(formatNumber(12.5)).toBe("12,5");
    expect(formatNumber(-3)).toBe("−3");
    expect(formatNumber(0.1 + 0.2)).toBe("0,3");
  });

  it("retter tallsvar uavhengig av skrivemåte", () => {
    const task = { kind: "number", answer: "12,5", options: null };
    const given = normalizeAnswer(task, "12.50");
    expect(given).toBe("12,5");
    expect(isCorrect(task, given!)).toBe(true);
    expect(isCorrect(task, normalizeAnswer(task, "12")!)).toBe(false);
    expect(normalizeAnswer(task, "tolv")).toBeNull();
  });

  it("retter bokstavsvar som før", () => {
    const task = { kind: "choice", answer: "C", options: ["A", "B", "C", "D", "E"] };
    expect(normalizeAnswer(task, "c")).toBe("C");
    expect(normalizeAnswer(task, "F")).toBeNull();
    expect(isCorrect(task, "C")).toBe(true);
  });
});
