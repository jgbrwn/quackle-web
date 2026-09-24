import { describe, expect, it } from "vitest";
import {
  classicPremiumAt,
  decodeGcgBytes,
  exportGcg,
  GcgParseError,
  parseGcg,
  replayGcgHistory,
  resolveLexiconHint,
  resolveNwl23Hint,
} from "./gcg";

const fixture = `#character-encoding UTF-8
#title Round trip fixture
#description A bounded parser fixture
#player1 A Alice Example
#player2 B Bob Example
#lexicon NWL23
>A: ADEIRST 8D DISRATE +70 70
#note opening move
>B: ABCDEFG - 0 0
>A: ADEIRST D7 a. +1 71
#rack2 ABCDEFG
`;

describe("Quackle GCG adapter", () => {
  it("uses the canonical Quackle classic premium layout", () => {
    expect(classicPremiumAt(0, 0)).toBe("triple-word");
    expect(classicPremiumAt(0, 7)).toBe("triple-word");
    expect(classicPremiumAt(1, 1)).toBe("double-word");
    expect(classicPremiumAt(1, 5)).toBe("triple-letter");
    expect(classicPremiumAt(0, 3)).toBe("double-letter");
    expect(classicPremiumAt(7, 7)).toBe("center");
  });

  it("replays placements, passes, racks, scores, and notes", () => {
    const result = parseGcg(fixture);
    expect(result.title).toBe("Round trip fixture");
    expect(result.players.map((player) => player.name)).toEqual([
      "Alice Example",
      "Bob Example",
    ]);
    expect(result.lexiconHint).toBe("NWL23");
    expect(result.history.map((entry) => entry.kind)).toEqual([
      "place",
      "pass",
      "place",
    ]);
    expect(result.history[0]).toMatchObject({
      kind: "place",
      row: 7,
      col: 3,
      direction: "horizontal",
      tiles: "DISRATE",
      note: "opening move",
      computedScore: 70,
      scoreStatus: "match",
    });
    expect(result.history[2]).toMatchObject({
      kind: "place",
      row: 6,
      col: 3,
      direction: "vertical",
      tiles: "a.",
      computedScore: 2,
      scoreStatus: "mismatch",
      scoreDelta: -1,
    });
    expect(result.board).toContainEqual({
      row: 6,
      col: 3,
      letter: "A",
      blank: true,
    });
    expect(result.finalRack).toBe("ABCDEFG");
    expect(result.finalPlayer).toBe("B");
    expect(result.scores).toEqual({ onTurn: 0, opponent: 72 });
    expect(result.computedScores).toEqual({ A: 72, B: 0 });
    expect(result.warnings).toContain(
      "score mismatch for A: recorded 1, computed 2",
    );
    expect(result.turn).toEqual({ number: 3, scorelessTurns: 0 });
  });

  it("round-trips its supported semantic records deterministically", () => {
    const parsed = parseGcg(fixture);
    const exported = exportGcg({
      players: parsed.players,
      title: parsed.title,
      description: parsed.description,
      lexiconHint: parsed.lexiconHint ?? undefined,
      history: parsed.history,
      finalRack: parsed.finalRack,
      finalPlayer: parsed.finalPlayer ?? undefined,
      board: parsed.board,
    });
    expect(exported.text).toContain("#lexicon NWL23");
    expect(exported.text).toContain(">A: ADEIRST 8D DISRATE +70 70");
    expect(exported.warnings).toEqual([]);
    const reparsed = parseGcg(exported.text);
    expect(reparsed.board).toEqual(parsed.board);
    expect(reparsed.history).toEqual(parsed.history);
    expect(reparsed.computedScores).toEqual(parsed.computedScores);
    expect(reparsed.finalRack).toBe(parsed.finalRack);
  });

  it("replays challenge rollback, adjustments, time, and end-bonus records", () => {
    const parsed = parseGcg(
      `#player1 A Alice\n#player2 B Bob\n>A: ADEIRST 8D DISRATE +70 70\n>B: ABCDEFG - 0 0\n>A: ADEIRST D7 a. +2 72\n>A: ADEIRST -- +0 70\n>B: ABCDEFG (challenge) +5 5\n>A: (T) -1 69\n>B: (ABC) +8 13\n`,
    );
    expect(parsed.computedScores).toEqual({ A: 69, B: 13 });
    expect(
      parsed.history.find((entry) => entry.kind === "end-bonus"),
    ).toMatchObject({ rack: "", score: 8 });
    const frames = replayGcgHistory(parsed.players, parsed.history);
    expect(frames).toHaveLength(parsed.history.length + 1);
    expect(frames[1].board).toHaveLength(7);
    expect(frames[3].board).toHaveLength(8);
    expect(frames[4].board).toHaveLength(7);
    expect(frames[4].scores).toEqual({ A: 70, B: 0 });
    expect(frames.at(-1)?.scores).toEqual({ A: 69, B: 13 });
    const exported = exportGcg({
      players: parsed.players,
      history: parsed.history,
    });
    expect((exported.text.match(/ -- /g) ?? []).length).toBe(1);
  });

  it("preserves ambiguous lexicon identity instead of falling back", () => {
    expect(resolveNwl23Hint(null)).toBe("missing");
    expect(resolveNwl23Hint("NWL2023")).toBe("exact");
    expect(resolveNwl23Hint("CSW24")).toBe("unsupported");
    expect(resolveLexiconHint("CSW24")).toBe("csw24");
    expect(resolveLexiconHint("CSW 2024")).toBe("csw24");
  });

  it("rejects malformed and unsafe placement input", () => {
    expect(() =>
      parseGcg("#player1 A Alice\n#player2 B Bob\n>A: ABCDEFG 16A WORD +1 1\n"),
    ).toThrow(GcgParseError);
    expect(() => parseGcg(`\0`)).toThrow(/NUL/);
    expect(() =>
      parseGcg(
        `#player1 A Alice\n#player2 B Bob\n>A: ABCDEFG 8D DISRATE ${"1".repeat(5000)}\n`,
      ),
    ).toThrow(/too long/);
  });

  it("decodes UTF-8 and Windows-1252 bytes within the bounded input surface", () => {
    const utf8 = decodeGcgBytes(
      new TextEncoder().encode("#title Café\n").buffer,
    );
    expect(utf8.encoding).toBe("UTF-8");
    expect(utf8.text).toContain("Café");
    const latin1 = decodeGcgBytes(
      Uint8Array.from([
        0x23, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x20, 0x43, 0x61, 0x66, 0xe9, 0x0a,
      ]).buffer,
    );
    expect(latin1.encoding).toBe("windows-1252");
    expect(latin1.text).toContain("Café");
  });
});
