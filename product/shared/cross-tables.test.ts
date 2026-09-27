import { describe, expect, it } from "vitest";
import {
  CrossTablesUrlError,
  parseCrossTablesGcgUrl,
  parseCrossTablesPage,
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

describe("Cross-Tables page parsing", () => {
  const link = {
    url: "https://www.cross-tables.com/annotated.php?u=61491",
    gameId: 61491,
  };

  it("extracts the matching GCG download and declared dictionary", () => {
    const html = `<p>Dictionary: <b>NWL23</b></p><a href='./annotated/selfgcg/614/anno61491.gcg' download='anno61491.gcg'>Download</a>`;
    expect(parseCrossTablesPage(html, link)).toEqual({
      gcgUrl:
        "https://www.cross-tables.com/annotated/selfgcg/614/anno61491.gcg",
      dictionary: "NWL23",
    });
  });

  it("ignores foreign or mismatched links and falls back to the derived path", () => {
    const html = `<a href="https://evil.example/anno61491.gcg">x</a><a href="./annotated/selfgcg/1/anno1.gcg">y</a>`;
    expect(parseCrossTablesPage(html, link)).toEqual({
      gcgUrl:
        "https://www.cross-tables.com/annotated/selfgcg/614/anno61491.gcg",
      dictionary: null,
    });
  });
});
