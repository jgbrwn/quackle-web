import { readFile } from "node:fs/promises";
import { parseGcg } from "../../shared/gcg";
import { expect, test, type Page } from "@playwright/test";

const SESSION_ID = "e2e-session-abcdefghijkl";
const CSW_COPYRIGHT =
  "Collins Offical Scrabble™ Wordlist 2024, Published under license with Collins, an imprint of HarperCollins Publishers Limited";
const NWL_COPYRIGHT =
  "NASPA Word List, 2023 Edition (NWL23), © 2023 North American Word Game Players Association. All rights reserved.";

function emptyState() {
  return {
    position: {
      board: { id: "classic15", cells: [] },
      rack: "",
      scores: { onTurn: 0, opponent: 0 },
      turn: { number: 1, scorelessTurns: 0 },
      unseen: { mode: "derive" },
    },
    history: [],
    lexiconId: "nwl23",
    boardId: "classic15",
    analysisPreferences: { candidateLimit: 20, budgetMs: 2000 },
  };
}

function sessionBody(
  state: ReturnType<typeof emptyState>,
  revision: number,
  id = SESSION_ID,
) {
  return {
    session: {
      id,
      revision,
      state,
      createdAt: "2026-09-22T00:00:00.000Z",
      updatedAt: "2026-09-22T00:00:00.000Z",
    },
  };
}

async function mockSessionApi(
  page: Page,
  options: { shareNotice?: boolean } = {},
) {
  let nextSession = 0;
  const sessions = new Map<
    string,
    { state: ReturnType<typeof emptyState>; revision: number }
  >([[SESSION_ID, { state: emptyState(), revision: 0 }]]);
  let forkState = emptyState();
  const forkSessionId = "e2e-fork-session-abcdefgh";
  const shareId = "e2e-share-id-abcdefghijkl";
  let shareActive = false;
  let shareNoticeActive = options.shareNotice === true;
  let deepJobPolls = 0;
  const deepJobId = "e2e-deep-job-abcdefghijkl";

  await page.route("**/api/v1/meta", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        engine: { quackle_commit: "6a41f7c0b40216c611abada4be08b1920006e62c" },
        supported_lexica: [],
      }),
    });
  });
  await page.route(/https:\/\/www\.cross-tables\.com\/.*/, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith(".gcg")) {
      await route.fulfill({
        status: 200,
        contentType: "text/plain",
        headers: { "access-control-allow-origin": "*" },
        body: `#character-encoding UTF-8\n#title Cross-Tables fixture\n#player1 A Alice\n#player2 B Bob\n#lexicon NWL23\n>A: ADEIRST 8D DISRATE +70 70\n>B: ABCDEFG - 0 0\n#rack1 ADEIRST\n`,
      });
      return;
    }
    if (
      url.pathname === "/annotated.php" &&
      url.searchParams.get("u") === "5241"
    ) {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        headers: { "access-control-allow-origin": "*" },
        body: '<a href="https://www.cross-tables.com/annotated/selfgcg/52/anno5241.gcg">Download .gcg game file</a>',
      });
      return;
    }
    await route.fallback();
  });
  await page.route("**/api/v1/imports/gcg", async (route) => {
    const text = route.request().postData() ?? "";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        document: parseGcg(text),
        encoding: "UTF-8",
        sourceSha256: "e2e-gcg-hash",
        lexicon: { status: "exact" },
      }),
    });
  });

  await page.route("**/api/v1/shares/redeem", async (route) => {
    forkState = {
      ...emptyState(),
      metadata: {
        format: "gcg",
        title: "Shared fixture",
        forkedFrom: { sourceSessionId: SESSION_ID, sourceRevision: 2 },
      },
    };
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      headers: {
        "set-cookie":
          "__Host-quackle_capability_e2e-fork-session-abcdefgh=fork-capability",
      },
      body: JSON.stringify(
        sessionBody(
          { ...forkState, metadata: forkState.metadata },
          0,
          forkSessionId,
        ),
      ),
    });
  });

  await page.route("**/api/v1/sessions", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const id =
      nextSession++ === 0
        ? SESSION_ID
        : `e2e-session-${nextSession}-abcdefghijkl`;
    sessions.set(id, { state: emptyState(), revision: 0 });
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(sessionBody(emptyState(), 0, id)),
    });
  });

  await page.route("**/api/v1/sessions/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const routeSessionId = url.pathname.split("/")[4] ?? SESSION_ID;
    const session = sessions.get(routeSessionId) ?? {
      state: emptyState(),
      revision: 0,
    };
    if (url.pathname.endsWith("/share") && request.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          shares: shareActive
            ? [
                {
                  shareId,
                  sourceRevision: session.revision,
                  createdAt: "2026-09-23T00:00:00.000Z",
                  expiresAt: null,
                  useCount: 0,
                  lastUsedAt: null,
                },
              ]
            : [],
          notices: shareNoticeActive
            ? [
                {
                  shareId: "e2e-evicted-share-abcdefghijkl",
                  sourceRevision: 1,
                  createdAt: "2026-09-22T00:00:00.000Z",
                  evictedAt: "2026-09-23T00:00:00.000Z",
                  reason: "active_limit",
                },
              ]
            : [],
        }),
      });
      return;
    }
    if (url.pathname.endsWith("/share") && request.method() === "POST") {
      shareActive = true;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          share: {
            shareId,
            sourceSessionId: routeSessionId,
            sourceRevision: session.revision,
            token: "share-token-abcdefghijklmnopqrstuvwxyz0123456789",
            expiresAt: null,
            lifetime: "until_revoked",
          },
        }),
      });
      return;
    }
    if (
      url.pathname.endsWith("/share-notices/e2e-evicted-share-abcdefghijkl") &&
      request.method() === "DELETE"
    ) {
      shareNoticeActive = false;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ dismissed: true }),
      });
      return;
    }
    if (
      url.pathname.endsWith(`/share/${shareId}`) &&
      request.method() === "DELETE"
    ) {
      shareActive = false;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ revoked: true }),
      });
      return;
    }
    if (
      url.pathname.endsWith("/analysis/jobs") &&
      request.method() === "POST"
    ) {
      deepJobPolls = 0;
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          job: {
            id: deepJobId,
            status: "queued",
            attempt: 1,
            progressSeq: 0,
            progress: null,
            result: null,
            error: null,
          },
        }),
      });
      return;
    }
    if (
      url.pathname.endsWith(`/analysis/jobs/${deepJobId}`) &&
      request.method() === "GET"
    ) {
      deepJobPolls += 1;
      const running = deepJobPolls === 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          job: running
            ? {
                id: deepJobId,
                status: "running",
                attempt: 1,
                progressSeq: 1,
                progress: { fraction: 0.5, elapsedMs: 900 },
                result: null,
                error: null,
              }
            : {
                id: deepJobId,
                status: "succeeded",
                attempt: 1,
                progressSeq: 2,
                progress: { fraction: 1, elapsedMs: 1800 },
                result: {
                  moves: [
                    {
                      action: "place",
                      position: "8D",
                      word: "DIASTER",
                      score: 70,
                      equity: 73.5,
                      is_bingo: true,
                    },
                  ],
                },
                error: null,
              },
        }),
      });
      return;
    }
    if (
      url.pathname.endsWith(`/analysis/jobs/${deepJobId}`) &&
      request.method() === "DELETE"
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          job: {
            id: deepJobId,
            status: "cancelled",
            attempt: 1,
            progressSeq: 1,
            progress: null,
            result: null,
            error: { code: "job_cancelled" },
          },
        }),
      });
      return;
    }
    if (url.pathname.endsWith("/moves/generate")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          identity: {
            sessionRevision: session.revision,
            engineId: "e2e-engine",
            protocol: 1,
            lexiconId: session.state.lexiconId,
            positionHash: "e2e-position",
            seed: 123456789,
          },
          moves: [
            {
              action: "place",
              position: "8D",
              word: "DISRATE",
              score: 70,
              equity: 72.45531,
              is_bingo: true,
            },
          ],
          count: 1,
          elapsedMs: 4,
        }),
      });
      return;
    }
    if (request.method() === "PUT") {
      const body = JSON.parse(request.postData() ?? "{}");
      const nextRevision = session.revision + 1;
      const nextState = body.state;
      sessions.set(routeSessionId, {
        state: nextState,
        revision: nextRevision,
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          sessionBody(nextState, nextRevision, routeSessionId),
        ),
      });
      return;
    }
    if (request.method() === "GET") {
      const responseState =
        routeSessionId === forkSessionId ? forkState : session.state;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          sessionBody(responseState, session.revision, routeSessionId),
        ),
      });
      return;
    }
    await route.fallback();
  });
}

async function enterRack(page: Page, letters: string) {
  await page.getByRole("button", { name: "Edit rack" }).click();
  const existing = await page.locator(".rack-tile").count();
  for (let index = existing - 1; index >= 0; index -= 1)
    await page.locator(".rack-tile").nth(index).click();
  for (const letter of letters)
    await page
      .getByRole("button", { name: `Tile ${letter}`, exact: true })
      .click();
  await page.getByRole("button", { name: "Done" }).click();
}

async function clearDraft(page: Page) {
  await page.addInitScript(() => {
    indexedDB.deleteDatabase("quackle-web-drafts");
  });
}

test("starts without fixture candidates, offers a random New game, and opens About", async ({
  page,
}) => {
  await clearDraft(page);
  await mockSessionApi(page);
  await page.goto("/");

  await expect(page.getByText("Session ready")).toBeVisible();
  await expect(page.locator(".rack-tile")).toHaveCount(7);
  await expect(page.locator(".board-cell.occupied")).toHaveCount(0);
  await expect(
    page.getByText("Analyze this position to see candidate moves."),
  ).toBeVisible();
  await expect(page.getByText("DISRATE")).toHaveCount(0);

  if (await page.locator(".bottom-nav:visible").count())
    await page
      .locator(".bottom-nav")
      .getByRole("button", { name: "About" })
      .click();
  else
    await page
      .getByRole("button", { name: "Open About and legal information" })
      .click();
  await expect(page.getByRole("dialog", { name: "Quackle Web" })).toContainText(
    "6a41f7c0b402",
  );
  await page.getByRole("button", { name: "Close About" }).click();

  await page.getByRole("button", { name: "Open recent scenarios" }).click();
  await page
    .getByRole("dialog", { name: "Recent scenarios" })
    .getByRole("button", { name: "Blank position" })
    .click();
  await expect(page.getByText("Session ready")).toBeVisible();
  await expect(page.locator(".rack-tile")).toHaveCount(0);
  await expect(page.locator(".board-cell.occupied")).toHaveCount(0);
});

test("uses an in-app tile keyboard for typing and blanks without a native keyboard", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium-mobile",
    "mobile-only interaction coverage",
  );
  await clearDraft(page);
  await mockSessionApi(page);
  await page.goto("/");

  await expect(page.getByText("Session ready")).toBeVisible();
  await page.getByRole("button", { name: "Edit rack" }).click();
  const existing = await page.locator(".rack-tile").count();
  for (let index = existing - 1; index >= 0; index -= 1)
    await page.locator(".rack-tile").nth(index).click();
  await page.getByRole("button", { name: "Blank tile", exact: true }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Tile typing" }).click();
  await page.locator(".board-cell").nth(112).click();
  await page.getByRole("button", { name: "Blank tile" }).click();
  await page.getByRole("button", { name: "Z", exact: true }).last().click();
  await expect(page.getByRole("button", { name: "H8 blank Z" })).toBeVisible();
  await expect(
    page.locator('input:focus, textarea:focus, [contenteditable="true"]:focus'),
  ).toHaveCount(0);
});

test("creates an independent snapshot share link", async ({ page }) => {
  await clearDraft(page);
  await mockSessionApi(page);
  await page.goto("/");

  await expect(page.getByText("Session ready")).toBeVisible();
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("button", { name: "Share scenario" }).click();
  await expect(
    page.getByText(
      /Permanent share link (copied · recipients get independent forks|created · clipboard unavailable)/,
    ),
  ).toBeVisible();
  await expect(page.getByText(/Permanent · 0 forks/)).toBeVisible();
  await page.getByRole("button", { name: "Revoke" }).click();
  await expect(
    page.getByText("Share link revoked · existing forks remain independent"),
  ).toBeVisible();
});

test("shows and dismisses automatic share-link eviction notices", async ({
  page,
}) => {
  await clearDraft(page);
  await mockSessionApi(page, { shareNotice: true });
  await page.goto("/");

  await expect(page.getByText("Session ready")).toBeVisible();
  await page.getByRole("button", { name: "Open settings" }).click();
  await expect(
    page.getByText("Share link removed automatically"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByText("Share link removed automatically")).toHaveCount(
    0,
  );
});

test("redeems a share fragment into an independent fork scenario", async ({
  page,
}) => {
  await clearDraft(page);
  await mockSessionApi(page);
  await page.goto(
    "/#/share/e2e-session-abcdefghijkl/share-token-abcdefghijklmnopqrstuvwxyz0123456789",
  );

  await expect(page.getByText("Session ready")).toBeVisible();
  await expect(
    page.getByText(
      "Forked from shared scenario revision 2. This session is independent.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open recent scenarios" }).click();
  await expect(
    page
      .getByRole("dialog", { name: "Recent scenarios" })
      .getByRole("button", { name: /Open scenario Forked · Shared fixture/ }),
  ).toBeVisible();
});

test("desktop edits, exports, imports, and analyzes a position", async ({
  page,
}) => {
  await clearDraft(page);
  await mockSessionApi(page);
  await page.goto("/");

  await expect(page.getByText("Session ready")).toBeVisible();
  await enterRack(page, "A");
  await page.locator(".rack-tile").first().click();
  await page.locator(".board-cell").nth(112).click();
  await expect(page.getByRole("button", { name: "H8 A" })).toBeVisible();

  await page.getByRole("button", { name: "Open settings" }).click();
  await expect(page.getByText(NWL_COPYRIGHT)).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON" }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  const exported = JSON.parse(await readFile(downloadPath!, "utf8"));
  expect(exported.format).toBe("quackle-web.position");
  expect(exported.lexicon.copyright).toBe(NWL_COPYRIGHT);

  await page.getByRole("button", { name: "Close settings" }).click();
  await page.getByRole("button", { name: "Clear board" }).click();
  await expect(page.getByRole("button", { name: "H8 empty" })).toBeVisible();

  await page.getByRole("button", { name: "Open settings" }).click();
  await page
    .locator('input[type="file"][accept="application/json,.json"]')
    .setInputFiles({
      name: "position.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(exported)),
    });
  await expect(page.getByText(/Session ready|Opening Imported/)).toBeVisible();
  await expect(page.getByRole("button", { name: "H8 A" })).toBeVisible();
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.getByRole("button", { name: "Open recent scenarios" }).click();
  await expect(
    page
      .getByRole("dialog", { name: "Recent scenarios" })
      .getByRole("button", { name: /Open scenario Imported/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close scenarios" }).click();

  await page.getByRole("button", { name: "Analyze position" }).click();
  await expect(page.getByText("Analysis complete")).toBeVisible();
  await expect(page.getByText("DISRATE").first()).toBeVisible();
  await page.getByRole("button", { name: /DISRATE 8D/ }).click();
  await expect(
    page.getByRole("button", { name: "D8 preview D" }),
  ).toBeVisible();
});

test("imports and exports a bounded Quackle GCG game", async ({ page }) => {
  await clearDraft(page);
  await mockSessionApi(page);
  await page.goto("/");

  await expect(page.getByText("Session ready")).toBeVisible();
  await page.getByRole("button", { name: "Open settings" }).click();
  await page
    .locator('input[type="file"][accept="text/plain,.gcg,.txt"]')
    .setInputFiles({
      name: "fixture.gcg",
      mimeType: "text/plain",
      buffer: Buffer.from(
        `#character-encoding UTF-8\n#title E2E fixture\n#player1 A Alice\n#player2 B Bob\n#lexicon NWL23\n>A: ADEIRST 8D DISRATE +70 70\n>B: ABCDEFG - 0 0\n#rack1 ADEIRST\n`,
      ),
    });
  await expect(page.getByRole("button", { name: "H8 A" })).toBeVisible();
  await expect(page.getByText("2 history records")).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export GCG" }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  const exported = await readFile(downloadPath!, "utf8");
  expect(exported).toContain("#lexicon NWL23");
  expect(exported).toContain(">A: ADEIRST 8D DISRATE +70 70");
});

test("selects CSW24 for static generation and preserves its identity", async ({
  page,
}) => {
  await clearDraft(page);
  await mockSessionApi(page);
  await page.goto("/");

  await expect(page.getByText("Session ready")).toBeVisible();
  await page.getByRole("button", { name: "Open settings" }).click();
  const settings = page.getByRole("dialog", { name: "Analysis context" });
  await settings.getByLabel("Lexicon").selectOption("csw24");
  await expect(
    page.getByText("CSW24 selected · save or analyze to apply"),
  ).toBeVisible();
  await expect(page.locator(".lexicon-chip")).toContainText("CSW24");
  await expect(
    settings.getByLabel("Analysis").locator('option[value="deep"]'),
  ).toHaveAttribute("disabled", "");
  await expect(page.getByText(CSW_COPYRIGHT)).toBeVisible();
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.getByRole("button", { name: "Analyze position" }).click();
  await expect(page.getByText("Analysis complete")).toBeVisible();
  await expect(page.getByText("DISRATE").first()).toBeVisible();
});

test("replays imported GCG records and returns to the editable final position", async ({
  page,
}) => {
  await clearDraft(page);
  await mockSessionApi(page);
  await page.goto("/");

  await expect(page.getByText("Session ready")).toBeVisible();
  await page.getByRole("button", { name: "Open settings" }).click();
  await page
    .locator('input[type="file"][accept="text/plain,.gcg,.txt"]')
    .setInputFiles({
      name: "replay.gcg",
      mimeType: "text/plain",
      buffer: Buffer.from(
        `#character-encoding UTF-8\n#title Replay fixture\n#player1 A Alice\n#player2 B Bob\n#lexicon NWL23\n>A: ADEIRST 8D DISRATE +70 70\n>B: ABCDEFG - 0 0\n>A: ADEIRST D7 a. +2 72\n>A: ADEIRST -- +0 70\n>B: ABCDEFG (challenge) +5 5\n>A: (T) -1 69\n>B: (ABC) +8 13\n#rack2 ABCDEFG\n`,
      ),
    });
  await expect(page.getByRole("button", { name: "H8 A" })).toBeVisible();
  await expect(page.getByText("7 history records")).toBeVisible();
  await page.getByRole("button", { name: "Close settings" }).click();

  await page.getByRole("button", { name: "Replay game" }).click();
  await expect(page.getByText("Record 0 of 7")).toBeVisible();
  await expect(page.getByRole("button", { name: "H8 empty" })).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("Record 1 of 7")).toBeVisible();
  await expect(page.getByRole("button", { name: "H8 A" })).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("button", { name: "D7 blank A" })).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("button", { name: "D7 empty" })).toBeVisible();
  await page.getByRole("button", { name: "Return to final" }).click();
  await expect(page.getByRole("button", { name: "Replay game" })).toBeVisible();

  await page.locator(".rack-tile").first().click();
  await page.locator(".board-cell").first().click();
  await expect(page.getByRole("button", { name: "A1 A" })).toBeVisible();
});

test.describe("Cross-Tables browser mediation", () => {
  test.use({ serviceWorkers: "block" });

  test("imports a validated Cross-Tables public GCG link", async ({ page }) => {
    await clearDraft(page);
    await mockSessionApi(page);
    await page.goto("/");

    await expect(page.getByText("Session ready")).toBeVisible();
    await page.getByRole("button", { name: "Open settings" }).click();
    await page
      .getByLabel("Cross-Tables game URL")
      .fill("https://cross-tables.com/annotated.php?u=5241#0#");
    await page.getByRole("button", { name: "Import public GCG" }).click();
    await expect(page.getByRole("button", { name: "H8 A" })).toBeVisible();
    await expect(page.getByText("2 history records")).toBeVisible();
  });
});

test("recent scenarios switch without losing local positions", async ({
  page,
}) => {
  await clearDraft(page);
  await mockSessionApi(page);
  await page.goto("/");

  await expect(page.getByText("Session ready")).toBeVisible();
  await enterRack(page, "A");
  await page.locator(".rack-tile").first().click();
  await page.locator(".board-cell").nth(112).click();
  await expect(page.getByRole("button", { name: "H8 A" })).toBeVisible();

  await page.getByRole("button", { name: "Open recent scenarios" }).click();
  await expect(
    page.getByText("This browser remembers the 100 most recent scenarios."),
  ).toBeVisible();
  const scenarios = page.getByRole("dialog", { name: "Recent scenarios" });
  await scenarios.getByRole("button", { name: "Blank position" }).click();
  await expect(page.getByText("Session ready")).toBeVisible();
  await enterRack(page, "D");
  await page.locator(".rack-tile").first().click();
  await page.locator(".board-cell").nth(112).click();
  await expect(page.getByRole("button", { name: "H8 D" })).toBeVisible();

  await page.getByRole("button", { name: "Open recent scenarios" }).click();
  const recent = page.getByRole("dialog", { name: "Recent scenarios" });
  await expect(
    recent.getByRole("button", { name: /Open scenario New game/ }),
  ).toHaveCount(1);
  await recent.getByRole("button", { name: /Open scenario New game/ }).click();
  await expect(page.getByRole("button", { name: "H8 A" })).toBeVisible();
  await expect(page.getByRole("button", { name: "H8 D" })).toHaveCount(0);
});

test("deep analysis jobs surface progress and terminal results", async ({
  page,
}) => {
  await clearDraft(page);
  await mockSessionApi(page);
  await page.goto("/");

  await expect(page.getByText("Session ready")).toBeVisible();
  await page.getByRole("button", { name: "Open settings" }).click();
  await page
    .getByRole("dialog", { name: "Analysis context" })
    .getByLabel("Analysis")
    .selectOption("deep");
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.getByRole("button", { name: "Analyze position" }).click();
  await expect(
    page.getByText(/Deep analysis · 50%|Deep analysis running…/),
  ).toBeVisible();
  await expect(page.getByText("Deep analysis complete")).toBeVisible();
  await expect(page.getByText("DIASTER").first()).toBeVisible();
});

test("mobile preserves the draft while offline and reconnects", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium-mobile",
    "mobile-only coverage",
  );
  await clearDraft(page);
  await mockSessionApi(page);
  await page.goto("/");

  await expect(page.getByText("Session ready")).toBeVisible();
  await expect(page.locator(".bottom-nav")).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(page.getByText("Offline · draft saved locally")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reconnect session" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Starting session…" }),
  ).toBeDisabled();

  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(
    page.getByText(/Session ready|Recovered local draft/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reconnect session" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Analyze position" }),
  ).toBeEnabled();
});
