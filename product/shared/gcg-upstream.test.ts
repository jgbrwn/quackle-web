import { describe, expect, it } from "vitest";
import { parseGcg } from "./gcg";

const PINNED_COMMIT = "6a41f7c0b40216c611abada4be08b1920006e62c";
const FIXTURES = [
  {
    path: "quackleio/iotest/capp.gcg",
    placements: 25,
    computedScores: { Brian: 481, Pakorn: 393 },
  },
  {
    path: "test/positions/fivepoint.gcg",
    placements: 24,
    computedScores: { Ganesh: 452, Paul: 360 },
  },
  {
    path: "test/positions/boys2.gcg",
    placements: 25,
    computedScores: { David: 423, Quackle: 357 },
  },
  {
    path: "test/positions/deadwoodendgame.gcg",
    placements: 22,
    computedScores: { jasonkb: 407, MartyGabriel: 446 },
  },
] as const;

const upstream = (path: string) =>
  `https://raw.githubusercontent.com/quackle/quackle/${PINNED_COMMIT}/${path}`;

describe.skipIf(process.env.UPSTREAM_GCG_FIXTURES !== "1")(
  "pinned upstream GCG compatibility",
  () => {
    for (const fixture of FIXTURES) {
      it(`parses and recomputes scores for ${fixture.path}`, async () => {
        const response = await fetch(upstream(fixture.path));
        expect(response.ok).toBe(true);
        const result = parseGcg(await response.text());
        const placements = result.history.filter(
          (entry) => entry.kind === "place",
        );
        expect(result.players.length).toBeGreaterThanOrEqual(2);
        expect(placements).toHaveLength(fixture.placements);
        expect(placements.every((entry) => entry.scoreStatus === "match")).toBe(
          true,
        );
        expect(
          placements.every((entry) => entry.computedScore === entry.score),
        ).toBe(true);
        expect(result.computedScores).toEqual(fixture.computedScores);
        expect(result.warnings).toEqual([]);
        expect(
          result.history.every(
            (entry) =>
              entry.score === undefined || Number.isSafeInteger(entry.score),
          ),
        ).toBe(true);
      });
    }
  },
);
