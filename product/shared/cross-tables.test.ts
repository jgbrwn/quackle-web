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

  it("accepts only the default HTTPS port and canonicalizes it away", () => {
    expect(
      parseCrossTablesUrl("https://cross-tables.com:443/annotated.php?u=5241")
        .url,
    ).toBe("https://www.cross-tables.com/annotated.php?u=5241");
    expect(() =>
      parseCrossTablesUrl("https://cross-tables.com:8443/annotated.php?u=5241"),
    ).toThrowError(expect.objectContaining({ code: "port_not_allowed" }));
  });

  it("rejects userinfo, including an empty userinfo delimiter", () => {
    for (const value of [
      "https://user:pass@cross-tables.com/annotated.php?u=5241",
      "https://user@www.cross-tables.com/annotated.php?u=5241",
      "https://@www.cross-tables.com/annotated.php?u=5241",
    ]) {
      expect(() => parseCrossTablesUrl(value)).toThrowError(
        expect.objectContaining({ code: "credentials_not_allowed" }),
      );
    }
  });

  it("accepts only the matching public GCG download path", () => {
    expect(
      parseCrossTablesGcgUrl(
        "https://www.cross-tables.com/annotated/selfgcg/52/anno5241.gcg",
        5241,
      ),
    ).toBe("https://www.cross-tables.com/annotated/selfgcg/52/anno5241.gcg");
    expect(
      parseCrossTablesGcgUrl(
        "https://www.cross-tables.com:443/annotated/selfgcg/52/anno5241.gcg",
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

  it("rejects credentials and nondefault ports on GCG download links", () => {
    for (const [value, code] of [
      [
        "https://u:p@www.cross-tables.com/annotated/selfgcg/52/anno5241.gcg",
        "credentials_not_allowed",
      ],
      [
        "https://www.cross-tables.com:444/annotated/selfgcg/52/anno5241.gcg",
        "port_not_allowed",
      ],
      [
        "https:\\@www.cross-tables.com/annotated/selfgcg/52/anno5241.gcg",
        "credentials_not_allowed",
      ],
      [
        "https://%77ww.cross-tables.com/annotated/selfgcg/52/anno5241.gcg",
        "host_not_allowed",
      ],
    ]) {
      expect(() => parseCrossTablesGcgUrl(value, 5241)).toThrowError(
        expect.objectContaining({ code }),
      );
    }
  });

  it("rejects non-HTTPS, arbitrary hosts, extra query parameters, and nonnumeric ids", () => {
    for (const value of [
      "http://www.cross-tables.com/annotated.php?u=5241",
      "https://evil.example/annotated.php?u=5241",
      "https://%77ww.cross-tables.com/annotated.php?u=5241",
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

  it("does not normalize credentials or alternate ports out of discovered GCG links", () => {
    for (const href of [
      "https://@www.cross-tables.com/annotated/selfgcg/999/anno61491.gcg",
      "https:\\@www.cross-tables.com/annotated/selfgcg/999/anno61491.gcg",
      "https://%77ww.cross-tables.com/annotated/selfgcg/999/anno61491.gcg",
      "https://www.cross-tables.com:444/annotated/selfgcg/999/anno61491.gcg",
    ]) {
      const html = `<a href="${href}">Download</a>`;
      expect(parseCrossTablesPage(html, link).gcgUrl).toBe(
        "https://www.cross-tables.com/annotated/selfgcg/614/anno61491.gcg",
      );
    }
  });
});
