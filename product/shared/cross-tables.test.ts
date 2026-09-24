import { describe, expect, it } from "vitest";
import {
  CrossTablesUrlError,
  parseCrossTablesGcgUrl,
  parseCrossTablesUrl,
} from "./cross-tables";

describe("Cross-Tables URL boundary", () => {
  it("canonicalizes an annotated game URL and strips fragments", () => {
    expect(
      parseCrossTablesUrl("https://cross-tables.com/annotated.php?u=5241#0#"),
    ).toEqual({
      url: "https://www.cross-tables.com/annotated.php?u=5241",
      gameId: 5241,
    });
  });

  it("accepts only the matching public GCG download path", () => {
    expect(
      parseCrossTablesGcgUrl(
        "https://www.cross-tables.com/annotated/selfgcg/52/anno5241.gcg",
        5241,
      ),
    ).toBe("https://www.cross-tables.com/annotated/selfgcg/52/anno5241.gcg");
    expect(() =>
      parseCrossTablesGcgUrl(
        "https://www.cross-tables.com/annotated/selfgcg/52/anno5242.gcg",
        5241,
      ),
    ).toThrow(CrossTablesUrlError);
  });

  it("rejects non-HTTPS, arbitrary hosts, extra query parameters, and nonnumeric ids", () => {
    for (const value of [
      "http://www.cross-tables.com/annotated.php?u=5241",
      "https://evil.example/annotated.php?u=5241",
      "https://www.cross-tables.com/annotated.php?u=5241&x=1",
      "https://www.cross-tables.com/annotated.php?u=abc",
      "https://www.cross-tables.com/game.php?u=5241",
    ]) {
      expect(() => parseCrossTablesUrl(value)).toThrow(CrossTablesUrlError);
    }
  });
});
