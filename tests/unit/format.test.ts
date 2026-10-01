import { describe, expect, it } from "vitest";
import { pluralPl } from "@/lib/format";

const word = (n: number) => pluralPl(n, "materiał", "materiały", "materiałów");

describe("pluralPl", () => {
  it.each([
    [0, "materiałów"],
    [1, "materiał"],
    [2, "materiały"],
    [3, "materiały"],
    [4, "materiały"],
    [5, "materiałów"],
    [11, "materiałów"],
    [12, "materiałów"],
    [13, "materiałów"],
    [14, "materiałów"],
    [21, "materiałów"],
    [22, "materiały"],
    [24, "materiały"],
    [25, "materiałów"],
    [101, "materiałów"],
    [112, "materiałów"],
    [122, "materiały"],
  ])("%i → %s", (n, expected) => {
    expect(word(n)).toBe(expected);
  });
});
