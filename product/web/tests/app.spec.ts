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
  options: {
    shareNotice?: boolean;
    shareActive?: boolean;
    shareRedemptionDelayMs?: number;
    shareRedemptionLabel?: string;
  } = {},
) {
  let nextSession = 0;
  const sessions = new Map<
    string,
    { state: ReturnType<typeof emptyState>; revision: number }
  >([[SESSION_ID, { state: emptyState(), revision: 0 }]]);
  let forkState = emptyState();
  const forkSessionId = "e2e-fork-session-abcdefgh";
  const shareId = "e2e-share-id-abcdefghijkl";
  const shareIdsBySession = new Map<string, string[]>(
    options.shareActive ? [[SESSION_ID, [shareId]]] : [],
  );
  const shareLabelsById = new Map<string, string | null>(
    options.shareActive ? [[shareId, null]] : [],
  );
  const shareLabelsByToken = new Map<string, string | null>();
  const shareNoticeBySession = new Set<string>(
    options.shareNotice ? [SESSION_ID] : [],
  );
  let createdShareCount = 0;
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
  await page.route("**/api/v1/imports/cross-tables", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as {
      url?: string;
    };
    if (body.url !== "https://www.cross-tables.com/annotated.php?u=5241") {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "cross_tables_not_found",
            message: "Cross-Tables game or GCG file was not found",
          },
        }),
      });
      return;
    }
    // Real Cross-Tables GCG files usually omit #lexicon; the page declares it.
    const gcg = `#character-encoding UTF-8\n#player1 A Alice\n#player2 B Bob\n>A: ADEIRST 8D DISRATE +70 70\n>B: ABCDEFG - 0 0\n#rack1 ADEIRST\n`;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        document: parseGcg(gcg),
        encoding: "UTF-8",
        sourceSha256: "e2e-cross-tables-hash",
        lexicon: {
          status: "exact",
          source: "source_page",
          hint: "NWL23",
          id: "nwl23",
        },
        gameId: 5241,
        sourceUrl: body.url,
        gcgUrl:
          "https://www.cross-tables.com/annotated/selfgcg/52/anno5241.gcg",
        gcgBase64: Buffer.from(gcg).toString("base64"),
      }),
    });
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
    if (options.shareRedemptionDelayMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, options.shareRedemptionDelayMs),
      );
    }
    const redeemBody = JSON.parse(route.request().postData() ?? "{}") as {
      token?: string;
    };
    const shareLabel =
      (redeemBody.token ? shareLabelsByToken.get(redeemBody.token) : null) ??
      options.shareRedemptionLabel ??
      "Recipient-visible label";
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
      body: JSON.stringify({
        ...sessionBody(
          { ...forkState, metadata: forkState.metadata },
          0,
          forkSessionId,
        ),
        shareLabel,
      }),
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
          shares: (shareIdsBySession.get(routeSessionId) ?? []).map((id) => ({
            shareId: id,
            sourceRevision: session.revision,
            createdAt: "2026-09-23T00:00:00.000Z",
            expiresAt: null,
            useCount: 0,
            lastUsedAt: null,
            shareLabel: shareLabelsById.get(id) ?? null,
          })),
          notices: shareNoticeBySession.has(routeSessionId)
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
      createdShareCount += 1;
      const newShareId = `e2e-share-${createdShareCount}-abcdefghijkl`;
      const requestBody = JSON.parse(request.postData() ?? "{}") as {
        shareLabel?: unknown;
      };
      const shareLabel =
        typeof requestBody.shareLabel === "string"
          ? requestBody.shareLabel
          : null;
      const token = `share-token-${createdShareCount}-abcdefghijklmnopqrstuvwxyz0123456789`;
      shareIdsBySession.set(routeSessionId, [
        ...(shareIdsBySession.get(routeSessionId) ?? []),
        newShareId,
      ]);
      shareLabelsById.set(newShareId, shareLabel);
      shareLabelsByToken.set(token, shareLabel);
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          share: {
            shareId: newShareId,
            sourceSessionId: routeSessionId,
            sourceRevision: session.revision,
            token,
            expiresAt: null,
            lifetime: "until_revoked",
            shareLabel,
          },
        }),
      });
      return;
    }
    if (
      url.pathname.endsWith("/share-notices/e2e-evicted-share-abcdefghijkl") &&
      request.method() === "DELETE"
    ) {
      shareNoticeBySession.delete(routeSessionId);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ dismissed: true }),
      });
      return;
    }
    const revokeMatch = url.pathname.match(/\/share\/([^/]+)$/);
    if (revokeMatch && request.method() === "DELETE") {
      shareIdsBySession.set(
        routeSessionId,
        (shareIdsBySession.get(routeSessionId) ?? []).filter(
          (id) => id !== revokeMatch[1],
        ),
      );
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
              row: 7,
              col: 3,
              horizontal: true,
              word: "DISRATE",
              tiles: "DISRATE",
              score: 70,
              equity: 72.45531,
              is_bingo: true,
            },
            {
              action: "place",
              position: "8G",
              row: 7,
              col: 6,
              horizontal: true,
              word: "STAIRED",
              tiles: "STAIRED",
              score: 64,
              equity: 66.1,
              is_bingo: true,
            },
          ],
          boardWarnings:
            session.state.metadata?.format === "gcg"
              ? [{ code: "unacceptable_word", word: "QZ" }]
              : [],
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

async function openGameImport(page: Page) {
  await page.getByRole("button", { name: "Open recent scenarios" }).click();
  await page
    .getByRole("dialog", { name: "Your workspace" })
    .getByRole("button", { name: "Import game" })
    .click();
}

async function chooseGcgFileForReview(
  page: Page,
  name: string,
  contents: string,
) {
  await page
    .locator('input[type="file"][accept="text/plain,.gcg,.txt"]')
    .setInputFiles({
      name,
      mimeType: "text/plain",
      buffer: Buffer.from(contents),
    });
  await expect(
    page.getByRole("heading", { name: "Review imported game" }),
  ).toBeVisible();
}

async function clearDraft(page: Page) {
  await page.addInitScript(() => {
    indexedDB.deleteDatabase("quackle-web-drafts");
  });
}

async function readScenarioSnapshot(page: Page, localId: string) {
  return page.evaluate(async (id) => {
    const request = indexedDB.open("quackle-web-drafts");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction(["scenarios", "meta"], "readonly");
    const scenarioRequest = transaction.objectStore("scenarios").get(id);
    const generationRequest = transaction
      .objectStore("meta")
      .get(`scenario-generation:${id}`);
    const [scenario, generation] = await Promise.all([
      new Promise<Record<string, unknown> | null>((resolve, reject) => {
        scenarioRequest.onsuccess = () =>
          resolve(
            (scenarioRequest.result as Record<string, unknown> | undefined) ??
              null,
          );
        scenarioRequest.onerror = () => reject(scenarioRequest.error);
      }),
      new Promise<{ generation?: number } | undefined>((resolve, reject) => {
        generationRequest.onsuccess = () =>
          resolve(
            generationRequest.result as { generation?: number } | undefined,
          );
        generationRequest.onerror = () => reject(generationRequest.error);
      }),
    ]);
    database.close();
    return { scenario, generation: generation?.generation ?? 0 };
  }, localId);
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
    .getByRole("dialog", { name: "Your workspace" })
    .getByRole("button", { name: "Blank position" })
    .click();
  await page.getByRole("button", { name: "Create blank position" }).click();
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
  const created = page.getByRole("dialog", { name: "Share scenario" });
  const url = created.getByRole("textbox", { name: "One-time share URL" });
  await expect(url).toHaveValue(
    /#\/share\/e2e-session-abcdefghijkl\/share-token-/,
  );
  await expect(created.getByText(/shown only now/)).toBeVisible();
  await expect(
    created.getByText(/Recipients will see “New game/),
  ).toBeVisible();
  const sourceHandles = await page.evaluate(async () => {
    const request = indexedDB.open("quackle-web-drafts");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const read = database
      .transaction("shareSources", "readonly")
      .objectStore("shareSources")
      .getAll();
    const result = await new Promise<unknown[]>((resolve, reject) => {
      read.onsuccess = () => resolve(read.result as unknown[]);
      read.onerror = () => reject(read.error);
    });
    database.close();
    return result;
  });
  expect(JSON.stringify(sourceHandles)).not.toContain("share-token-");
  await created.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Close settings" }).click();

  await page.getByRole("button", { name: "Open recent scenarios" }).click();
  const manager = page.getByRole("dialog", { name: "Your workspace" });
  await manager.getByRole("tab", { name: "Share links" }).click();
  const source = manager
    .locator(".share-source-card")
    .filter({ hasText: "New game" })
    .first();
  await expect(source).toBeVisible();
  await source.getByRole("button", { name: /Check|Refresh/ }).click();
  await expect(source.getByText("1 active link")).toBeVisible();
  await expect(source.locator(".share-link-row")).toContainText(/New game/);
  await expect(source).not.toContainText("share-token-");
  await source.getByRole("button", { name: "Revoke" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Revoke this link?" });
  await confirm.getByRole("button", { name: "Revoke link" }).click();
  await expect(source.getByText("0 active links")).toBeVisible();
  await expect(
    source.getByRole("button", { name: "Create link" }),
  ).toBeVisible();
  await source.getByRole("button", { name: "Create link" }).click();
  const replacement = page.getByRole("dialog", { name: "Share scenario" });
  await expect(
    replacement.getByRole("textbox", { name: "One-time share URL" }),
  ).toHaveValue(/#\/share\/e2e-session-abcdefghijkl\/share-token-/);
  await replacement.getByRole("button", { name: "Done" }).click();
  await expect(source.getByText("1 active link")).toBeVisible();
});

test("scenario names can be set on creation and renamed without changing existing share labels", async ({
  page,
}) => {
  await clearDraft(page);
  await mockSessionApi(page);
  await page.goto("/");
  await expect(page.getByText("Session ready")).toBeVisible();

  await page.getByRole("button", { name: "Open recent scenarios" }).click();
  const workspace = page.getByRole("dialog", { name: "Your workspace" });
  await workspace
    .locator(".scenario-create-actions")
    .getByRole("button", { name: /New game/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Start a new game" }),
  ).toBeVisible();
  await page.getByLabel("Scenario name").fill("é".repeat(65));
  await page.getByRole("button", { name: "Create game" }).click();
  await expect(page.getByRole("alert")).toContainText("UTF-8 bytes");
  await page.getByLabel("Scenario name").fill("Opening Study");
  await page.getByRole("button", { name: "Create game" }).click();
  await expect(page.getByText("Opening Study", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("button", { name: "Share scenario" }).click();
  const firstShare = page.getByRole("dialog", { name: "Share scenario" });
  await expect(
    firstShare.getByText(/Recipients will see “Opening Study”/),
  ).toBeVisible();
  const firstUrl = await firstShare
    .getByRole("textbox", { name: "One-time share URL" })
    .inputValue();
  await firstShare.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Close settings" }).click();

  await page.getByRole("button", { name: "Open recent scenarios" }).click();
  const manager = page.getByRole("dialog", { name: "Your workspace" });
  await manager.getByRole("tab", { name: "Share links" }).click();
  const source = manager
    .locator(".share-source-card")
    .filter({ hasText: "Opening Study" })
    .first();
  await source.getByRole("button", { name: /Check|Refresh/ }).click();
  await expect(source.locator(".share-link-row")).toContainText(
    "Opening Study",
  );

  await manager.getByRole("tab", { name: "Scenarios" }).click();
  const currentScenario = manager
    .locator(".scenario-item")
    .filter({ hasText: "Opening Study" })
    .first();
  await currentScenario
    .getByRole("button", { name: "Rename scenario Opening Study" })
    .click();
  const rename = page.getByRole("dialog", { name: "Rename scenario" });
  await rename.getByLabel("Scenario name").fill("Endgame Review");
  await rename.getByRole("button", { name: "Save name" }).click();
  await expect(
    page
      .getByRole("region", { name: "Session context" })
      .getByText("Endgame Review", { exact: true }),
  ).toBeVisible();

  await manager.getByRole("tab", { name: "Share links" }).click();
  const renamedSource = manager
    .locator(".share-source-card")
    .filter({ hasText: "Endgame Review" })
    .first();
  await expect(renamedSource.locator(".share-link-row")).toContainText(
    "Opening Study",
  );
  await renamedSource
    .getByRole("button", { name: "Create another link" })
    .click();
  const secondShare = page.getByRole("dialog", { name: "Share scenario" });
  await expect(
    secondShare.getByText(/Recipients will see “Endgame Review”/),
  ).toBeVisible();
  const secondUrl = await secondShare
    .getByRole("textbox", { name: "One-time share URL" })
    .inputValue();
  expect(secondUrl).not.toBe(firstUrl);
  await secondShare.getByRole("button", { name: "Done" }).click();
  await expect(renamedSource.locator(".share-link-row")).toHaveCount(2);
  await expect(
    renamedSource
      .locator(".share-link-row")
      .filter({ hasText: "Endgame Review" }),
  ).toHaveCount(1);
  await expect(
    renamedSource
      .locator(".share-link-row")
      .filter({ hasText: "Opening Study" }),
  ).toHaveCount(1);
});

test("a cross-tab rename survives a stale tab autosaving its game edits", async ({
  page,
}) => {
  await clearDraft(page);
  await mockSessionApi(page);
  await page.goto("/");
  await expect(page.getByText("Session ready")).toBeVisible();
  await page.getByRole("button", { name: "Open recent scenarios" }).click();
  const ownerWorkspace = page.getByRole("dialog", { name: "Your workspace" });
  const localId = await ownerWorkspace
    .locator(".scenario-item.active")
    .getAttribute("data-local-scenario-id");
  expect(localId).toBeTruthy();
  await page.getByRole("button", { name: "Close scenarios" }).click();

  const otherTab = await page.context().newPage();
  await mockSessionApi(otherTab);
  await otherTab.goto("/");
  await expect(
    otherTab.getByText(
      /Session ready|Recovered local draft|Session changed · local copy preserved/,
    ),
  ).toBeVisible();
  await otherTab.getByRole("button", { name: "Open recent scenarios" }).click();
  const otherWorkspace = otherTab.getByRole("dialog", {
    name: "Your workspace",
  });
  const scenario = otherWorkspace.locator(
    `[data-local-scenario-id="${localId}"]`,
  );
  await scenario.getByRole("button", { name: /Rename scenario/ }).click();
  const rename = otherTab.getByRole("dialog", { name: "Rename scenario" });
  await rename.getByLabel("Scenario name").fill("Named in second tab");
  await rename.getByRole("button", { name: "Save name" }).click();
  await otherTab.getByRole("button", { name: "Close scenarios" }).click();

  await enterRack(page, "B");
  await expect
    .poll(async () => readScenarioSnapshot(page, localId!))
    .toMatchObject({
      scenario: {
        title: "Named in second tab",
        localTitleRevision: 1,
        state: { position: { rack: "B" } },
      },
    });
  await expect(
    page.getByRole("region", { name: "Session context" }),
  ).toContainText("Named in second tab");
  await otherTab.close();
});

test("shows and dismisses automatic share-link eviction notices", async ({
  page,
}) => {
  await clearDraft(page);
  await mockSessionApi(page, { shareNotice: true, shareActive: true });
  await page.goto("/");

  await expect(page.getByText("Session ready")).toBeVisible();
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("button", { name: "Share scenario" }).click();
  await page
    .getByRole("dialog", { name: "Share scenario" })
    .getByRole("button", { name: "Done" })
    .click();
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.getByRole("button", { name: "Open recent scenarios" }).click();
  const manager = page.getByRole("dialog", { name: "Your workspace" });
  await manager.getByRole("tab", { name: "Share links" }).click();
  const source = manager
    .locator(".share-source-card")
    .filter({ hasText: "New game" })
    .first();
  await source.getByRole("button", { name: /Check|Refresh/ }).click();
  await expect(source.getByText("Link removed automatically")).toBeVisible();
  await source.getByRole("button", { name: "Dismiss" }).click();
  await expect(source.getByText("Link removed automatically")).toHaveCount(0);
});

test("removing a shared scenario preserves its link for management", async ({
  page,
}) => {
  await clearDraft(page);
  await mockSessionApi(page);
  await page.goto("/");
  await expect(page.getByText("Session ready")).toBeVisible();

  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("button", { name: "Share scenario" }).click();
  const created = page.getByRole("dialog", { name: "Share scenario" });
  await expect(
    created.getByRole("textbox", { name: "One-time share URL" }),
  ).toHaveValue(/#\/share\/e2e-session-abcdefghijkl\/share-token-/);
  await created.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Close settings" }).click();

  await page.getByRole("button", { name: "Open recent scenarios" }).click();
  const scenarios = page.getByRole("dialog", { name: "Your workspace" });
  await scenarios.getByRole("button", { name: "Blank position" }).click();
  await page.getByRole("button", { name: "Create blank position" }).click();
  await expect(page.getByText("Session ready")).toBeVisible();
  await page.getByRole("button", { name: "Open recent scenarios" }).click();
  const list = page.getByRole("dialog", { name: "Your workspace" });
  const original = list
    .locator(".scenario-item")
    .filter({ hasText: "New game" })
    .first();
  await original
    .getByRole("button", { name: /Remove scenario .* from this browser/ })
    .click();
  const remove = page.getByRole("alertdialog", {
    name: "Remove from this browser?",
  });
  await expect(remove).toContainText(
    "Share links, server-side snapshots, and existing recipient forks are not revoked or deleted",
  );
  await remove
    .getByRole("button", { name: "Remove from this browser" })
    .click();
  await expect(list.getByRole("tab", { name: "Scenarios" })).toBeVisible();
  await expect(
    list.locator(".scenario-item").filter({ hasText: "New game" }),
  ).toHaveCount(0);

  await list.getByRole("tab", { name: "Share links" }).click();
  const source = list
    .locator(".share-source-card")
    .filter({ hasText: "Source scenario removed from this browser" })
    .first();
  await source.getByRole("button", { name: /Check|Refresh/ }).click();
  await expect(source.getByText("1 active link")).toBeVisible();
  await expect(source.getByRole("button", { name: "Revoke" })).toBeVisible();
  await source.getByRole("button", { name: "Create another link" }).click();
  const replacement = page.getByRole("dialog", { name: "Share scenario" });
  await expect(
    replacement.getByRole("textbox", { name: "One-time share URL" }),
  ).toHaveValue(/#\/share\/e2e-session-abcdefghijkl\/share-token-/);
  await replacement.getByRole("button", { name: "Done" }).click();
  await expect(source.getByText("2 active links")).toBeVisible();
});

test("removing the active last scenario opens a new game and Undo restores the saved copy", async ({
  page,
}) => {
  await clearDraft(page);
  await mockSessionApi(page);
  await page.goto("/");
  await expect(page.getByText("Session ready")).toBeVisible();
  await page.getByRole("button", { name: "Open recent scenarios" }).click();
  const scenarios = page.getByRole("dialog", { name: "Your workspace" });
  const current = scenarios
    .locator(".scenario-item")
    .filter({ hasText: "New game" })
    .first();
  await current
    .getByRole("button", { name: /Remove scenario .* from this browser/ })
    .click();
  const remove = page.getByRole("alertdialog", {
    name: "Remove from this browser?",
  });
  await expect(remove).toContainText("This is the current scenario");
  await remove
    .getByRole("button", { name: "Remove from this browser" })
    .click();

  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
  await expect(
    page.getByText(/Removed .* from this browser\. Shares are unchanged\./),
  ).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText(/Restored .* to this browser/)).toBeVisible();
  await expect(
    scenarios.locator(".scenario-item").filter({ hasText: "New game" }),
  ).toHaveCount(2);
  await expect(page.locator(".scenario-item.active")).toContainText("New game");
});

test("removing an active scenario in another tab preserves this tab's draft until copied", async ({
  page,
}) => {
  await clearDraft(page);
  await mockSessionApi(page);
  await page.goto("/");
  await expect(page.getByText("Session ready")).toBeVisible();
  await page.getByRole("button", { name: "Open recent scenarios" }).click();
  const initialManager = page.getByRole("dialog", { name: "Your workspace" });
  const originalLocalId = await initialManager
    .locator(".scenario-item")
    .first()
    .getAttribute("data-local-scenario-id");

  const otherTab = await page.context().newPage();
  await mockSessionApi(otherTab);
  await otherTab.goto("/");
  await expect(
    otherTab.getByText(
      /Session ready|Recovered local draft|Session changed · local copy preserved/,
    ),
  ).toBeVisible();
  await otherTab.getByRole("button", { name: "Open recent scenarios" }).click();
  const otherManager = otherTab.getByRole("dialog", { name: "Your workspace" });
  await otherManager
    .locator(".scenario-item")
    .first()
    .getByRole("button", { name: /Remove scenario .* from this browser/ })
    .click();
  await otherTab
    .getByRole("alertdialog", { name: "Remove from this browser?" })
    .getByRole("button", { name: "Remove from this browser" })
    .click();

  await expect(
    initialManager.getByText(/removed in another tab/),
  ).toBeVisible();
  await initialManager.getByRole("button", { name: "Save a copy" }).click();
  await expect(page.getByText("Session ready")).toBeVisible();
  await expect(
    initialManager.locator(".scenario-item-main strong", {
      hasText: /recovered copy/,
    }),
  ).toBeVisible();
  await expect(
    initialManager.locator(`[data-local-scenario-id="${originalLocalId}"]`),
  ).toHaveCount(0);
  await otherTab.close();
});

test("a stale tab preserves edits instead of overwriting a scenario generation changed in another tab", async ({
  page,
}) => {
  await clearDraft(page);
  await mockSessionApi(page);
  await page.goto("/");
  await expect(page.getByText("Session ready")).toBeVisible();
  await page.getByRole("button", { name: "Open recent scenarios" }).click();
  const firstManager = page.getByRole("dialog", { name: "Your workspace" });
  const activeRow = firstManager.locator(".scenario-item.active").first();
  const activeLocalId = await activeRow.getAttribute("data-local-scenario-id");
  expect(activeLocalId).toBeTruthy();
  await expect
    .poll(async () =>
      page.evaluate(async (localId) => {
        const request = indexedDB.open("quackle-web-drafts");
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const get = database
          .transaction("scenarios", "readonly")
          .objectStore("scenarios")
          .get(localId);
        const scenario = await new Promise<Record<string, unknown> | undefined>(
          (resolve, reject) => {
            get.onsuccess = () =>
              resolve(get.result as Record<string, unknown> | undefined);
            get.onerror = () => reject(get.error);
          },
        );
        database.close();
        return scenario;
      }, activeLocalId),
    )
    .toMatchObject({ dirty: false, sessionId: SESSION_ID });
  await page.getByRole("button", { name: "Close scenarios" }).click();

  const otherTab = await page.context().newPage();
  await mockSessionApi(otherTab);
  await otherTab.goto("/");
  await expect(
    otherTab.getByText(
      /Session ready|Recovered local draft|Session changed · local copy preserved/,
    ),
  ).toBeVisible();
  await otherTab.getByRole("button", { name: "Open recent scenarios" }).click();
  const otherManager = otherTab.getByRole("dialog", { name: "Your workspace" });
  await expect(
    otherManager.locator(`[data-local-scenario-id="${activeLocalId}"]`),
  ).toHaveClass(/active/);
  await otherManager.getByRole("button", { name: "Blank position" }).click();
  await otherTab.getByRole("button", { name: "Create blank position" }).click();
  await expect(otherTab.locator(".rack .rack-empty")).toBeVisible();

  const advancedScenario = await readScenarioSnapshot(page, activeLocalId!);
  expect(advancedScenario.scenario).toBeTruthy();
  expect(advancedScenario.scenario?.localGeneration).toBe(
    advancedScenario.generation,
  );
  expect(advancedScenario.generation).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Save a copy" })).toHaveCount(
    0,
  );

  await enterRack(page, "B");
  await expect(
    page.getByText(/changed or was removed in another tab/),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Save a copy" })).toBeVisible();
  await expect(page.locator(".rack .rack-tile")).toHaveCount(1);
  await page.getByRole("button", { name: "Save a copy" }).click();
  await expect(page.getByText("Session ready")).toBeVisible();
  await expect(page.locator(".rack .rack-tile")).toHaveCount(1);
  await otherTab.close();
});

test("removing an active scenario from a stale tab cannot overwrite a newer cross-tab draft", async ({
  page,
}) => {
  await clearDraft(page);
  await mockSessionApi(page);
  await page.goto("/");
  await expect(page.getByText("Session ready")).toBeVisible();

  await page.getByRole("button", { name: "Open recent scenarios" }).click();
  const firstManager = page.getByRole("dialog", { name: "Your workspace" });
  const activeRow = firstManager.locator(".scenario-item.active").first();
  const activeLocalId = await activeRow.getAttribute("data-local-scenario-id");
  expect(activeLocalId).toBeTruthy();
  await expect
    .poll(
      async () => (await readScenarioSnapshot(page, activeLocalId!)).scenario,
    )
    .toMatchObject({ dirty: false, sessionId: SESSION_ID });
  await page.getByRole("button", { name: "Close scenarios" }).click();

  const otherTab = await page.context().newPage();
  await mockSessionApi(otherTab);
  await otherTab.goto("/");
  await expect(
    otherTab.getByText(
      /Session ready|Recovered local draft|Session changed · local copy preserved/,
    ),
  ).toBeVisible();
  await enterRack(otherTab, "C");
  await otherTab.getByRole("button", { name: "Open recent scenarios" }).click();
  const otherManager = otherTab.getByRole("dialog", { name: "Your workspace" });
  await otherManager.getByRole("button", { name: "Blank position" }).click();
  await otherTab.getByRole("button", { name: "Create blank position" }).click();
  await expect(otherTab.locator(".rack .rack-empty")).toBeVisible();

  await expect
    .poll(async () => readScenarioSnapshot(page, activeLocalId!))
    .toMatchObject({
      scenario: { state: { position: { rack: "C" } } },
    });
  expect(
    (await readScenarioSnapshot(page, activeLocalId!)).generation,
  ).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Open recent scenarios" }).click();
  const manager = page.getByRole("dialog", { name: "Your workspace" });
  const staleRow = manager.locator(
    `[data-local-scenario-id="${activeLocalId}"]`,
  );
  await staleRow
    .getByRole("button", { name: /Remove scenario .* from this browser/ })
    .click();
  const confirmation = page.getByRole("alertdialog", {
    name: "Remove from this browser?",
  });
  await confirmation
    .getByRole("button", { name: "Remove from this browser" })
    .click();

  await expect(
    page.getByRole("alertdialog", { name: "Remove from this browser?" }),
  ).toHaveCount(0);
  await expect(
    manager.locator(`[data-local-scenario-id="${activeLocalId}"]`),
  ).toBeVisible();
  await expect(page.locator(".rack .rack-tile")).toContainText("C");
  await expect
    .poll(async () => readScenarioSnapshot(page, activeLocalId!))
    .toMatchObject({
      scenario: { state: { position: { rack: "C" } } },
    });
  await otherTab.close();
});

test("the version-two scenario migration retains source handles for existing share links", async ({
  page,
}) => {
  await mockSessionApi(page, { shareActive: true });
  await page.goto("/");
  await expect(page.getByText("Session ready")).toBeVisible();
  await page.waitForTimeout(250);

  await page.evaluate(async () => {
    const databaseName = "quackle-web-drafts";
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(new Error("scenario database remained open"));
      request.onsuccess = () => resolve();
    });
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 2);
      request.onupgradeneeded = () => {
        const database = request.result;
        database.createObjectStore("drafts");
        const scenarios = database.createObjectStore("scenarios", {
          keyPath: "localId",
        });
        scenarios.createIndex("sessionId", "sessionId", { unique: false });
        scenarios.createIndex("lastOpenedAt", "lastOpenedAt", {
          unique: false,
        });
        database.createObjectStore("meta");
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction(
          ["scenarios", "meta"],
          "readwrite",
        );
        transaction.objectStore("scenarios").put({
          schemaVersion: 1,
          localId: "legacy-shared-scenario",
          sessionId: "e2e-session-abcdefghijkl",
          kind: "imported",
          title: "Legacy share owner",
          state: {
            position: {
              board: { id: "classic15", cells: [] },
              rack: "ADE",
              scores: { onTurn: 0, opponent: 0 },
              turn: { number: 1, scorelessTurns: 0 },
              unseen: { mode: "derive" },
            },
            history: [],
            lexiconId: "nwl23",
            boardId: "classic15",
            analysisPreferences: { candidateLimit: 20, budgetMs: 2000 },
          },
          revision: 1,
          dirty: true,
          createdAt: "2026-09-27T00:00:00.000Z",
          savedAt: "2026-09-27T00:00:00.000Z",
          lastOpenedAt: "2026-09-27T00:00:00.000Z",
          source: { kind: "imported", format: "gcg", filename: "legacy.gcg" },
        });
        transaction
          .objectStore("meta")
          .put({ localId: "legacy-shared-scenario" }, "activeScenario");
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
      };
    });
  });
  await page.reload();
  await expect(
    page.getByText(/Recovered local draft|Session ready/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open recent scenarios" }).click();
  const manager = page.getByRole("dialog", { name: "Your workspace" });
  await manager.getByRole("tab", { name: "Share links" }).click();
  const source = manager
    .locator(".share-source-card")
    .filter({ hasText: "Legacy share owner" });
  await expect(source).toBeVisible();
  await source.getByRole("button", { name: /Check|Refresh/ }).click();
  await expect(source.getByText("1 active link")).toBeVisible();
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
  await expect(page).not.toHaveURL(/#\/share\//);
  await page.getByRole("button", { name: "Open recent scenarios" }).click();
  const manager = page.getByRole("dialog", { name: "Your workspace" });
  const forkRow = manager
    .locator(".scenario-item")
    .filter({ hasText: "Forked · Recipient-visible label" });
  await expect(forkRow).toBeVisible();
  const forkId = await forkRow.getAttribute("data-local-scenario-id");
  expect(forkId).toBeTruthy();
  const forkScenario = (await readScenarioSnapshot(page, forkId!)).scenario;
  const forkState = forkScenario?.state as
    { metadata?: { title?: string } } | undefined;
  expect(forkState?.metadata?.title).toBe("Shared fixture");
});

test("removes a share bearer fragment before redemption completes", async ({
  page,
}) => {
  await clearDraft(page);
  await mockSessionApi(page, { shareRedemptionDelayMs: 700 });
  await page.goto(
    "/#/share/e2e-session-abcdefghijkl/share-token-abcdefghijklmnopqrstuvwxyz0123456789",
  );

  await expect(page).not.toHaveURL(/#\/share\//);
  await expect(page.getByText("Session ready")).toBeVisible();
  await expect(
    page.getByText(
      "Forked from shared scenario revision 2. This session is independent.",
    ),
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
      .getByRole("dialog", { name: "Your workspace" })
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
  await openGameImport(page);
  await chooseGcgFileForReview(
    page,
    "fixture.gcg",
    `#character-encoding UTF-8\n#title E2E fixture\n#player1 A Alice\n#player2 B Bob\n#lexicon NWL23\n>A: ADEIRST 8D DISRATE +70 70\n>B: ABCDEFG - 0 0\n#rack1 ADEIRST\n`,
  );
  await page.getByLabel("Scenario name").fill("E2E imported study");
  await page.getByRole("button", { name: "Create imported scenario" }).click();
  await expect(page.getByRole("button", { name: "H8 A" })).toBeVisible();
  await expect(page.getByText("2 history records")).toBeVisible();
  await expect(page.getByText("E2E imported study")).toBeVisible();
  await page.getByRole("button", { name: "Open recent scenarios" }).click();
  const workspace = page.getByRole("dialog", { name: "Your workspace" });
  await expect(
    workspace
      .locator(".scenario-item")
      .filter({ hasText: "E2E imported study" }),
  ).toBeVisible();
  await expect(
    workspace.locator(".scenario-item").filter({ hasText: "New game" }),
  ).toBeVisible();
  await expect(workspace.locator(".scenario-item.active")).toContainText(
    "E2E imported study",
  );
  await page.getByRole("button", { name: "Close scenarios" }).click();
  await page.getByRole("button", { name: "Open settings" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export GCG" }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  const exported = await readFile(downloadPath!, "utf8");
  expect(exported).toContain("#lexicon NWL23");
  expect(exported).toContain("#title E2E fixture");
  expect(exported).not.toContain("#title E2E imported study");
  expect(exported).toContain(">A: ADEIRST 8D DISRATE +70 70");
});

test("canceling an import review leaves the current scenario untouched", async ({
  page,
}) => {
  await clearDraft(page);
  await mockSessionApi(page);
  await page.goto("/");
  await expect(page.getByText("Session ready")).toBeVisible();
  await page.getByRole("button", { name: "Open recent scenarios" }).click();
  const workspace = page.getByRole("dialog", { name: "Your workspace" });
  await workspace.getByRole("button", { name: "Import game" }).click();
  await chooseGcgFileForReview(
    page,
    "cancel-me.gcg",
    `#character-encoding UTF-8\n#title Must not replace the active game\n#player1 A Alice\n#player2 B Bob\n#lexicon NWL23\n>A: ADEIRST 8D DISRATE +70 70\n`,
  );
  await expect(page.locator(".board-cell.occupied")).toHaveCount(0);
  await page.getByRole("button", { name: "Back to scenarios" }).click();
  await expect(workspace.locator(".scenario-item")).toHaveCount(1);
  await expect(workspace.locator(".scenario-item.active")).toContainText(
    "New game",
  );
  await expect(page.locator(".rack-tile")).toHaveCount(7);
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
  ).not.toHaveAttribute("disabled", "");
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
  await openGameImport(page);
  await chooseGcgFileForReview(
    page,
    "replay.gcg",
    `#character-encoding UTF-8\n#title Replay fixture\n#player1 A Alice\n#player2 B Bob\n#lexicon NWL23\n>A: ADEIRST 8D DISRATE +70 70\n>B: ABCDEFG - 0 0\n>A: ADEIRST D7 a. +2 72\n>A: ADEIRST -- +0 70\n>B: ABCDEFG (challenge) +5 5\n>A: (T) -1 69\n>B: (ABC) +8 13\n#rack2 ABCDEFG\n`,
  );
  await page.getByRole("button", { name: "Create imported scenario" }).click();
  await expect(page.getByRole("button", { name: "H8 A" })).toBeVisible();
  await expect(page.getByText("7 history records")).toBeVisible();

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
    await openGameImport(page);
    await page
      .getByLabel("Cross-Tables game URL")
      .fill("https://cross-tables.com/annotated.php?u=5241#0#");
    await page.getByRole("button", { name: "Fetch and review game" }).click();
    await expect(
      page.getByRole("heading", { name: "Review imported game" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Create imported scenario" })
      .click();
    await expect(page.getByRole("button", { name: "H8 A" })).toBeVisible();
    await expect(page.getByText("2 history records")).toBeVisible();
    await expect(page.locator(".lexicon-chip")).toContainText("NWL2023");
  });

  test("reports a missing Cross-Tables game clearly", async ({ page }) => {
    await clearDraft(page);
    await mockSessionApi(page);
    await page.goto("/");

    await expect(page.getByText("Session ready")).toBeVisible();
    await openGameImport(page);
    await page
      .getByLabel("Cross-Tables game URL")
      .fill("https://www.cross-tables.com/annotated.php?u=9");
    await page.getByRole("button", { name: "Fetch and review game" }).click();
    await expect(
      page.getByText(
        /Cross-Tables import failed · Cross-Tables game or GCG file was not found/,
      ),
    ).toBeVisible();
  });
});

test("replays a game with both player names, the mover's rack, and turn analysis", async ({
  page,
}) => {
  await clearDraft(page);
  await mockSessionApi(page);
  await page.goto("/");

  await expect(page.getByText("Session ready")).toBeVisible();
  await openGameImport(page);
  await chooseGcgFileForReview(
    page,
    "turns.gcg",
    `#character-encoding UTF-8\n#player1 Samuel_Kaplan Samuel Kaplan\n#player2 Verna Verna Berg\n#lexicon NWL23\n>Samuel_Kaplan: AEMNNUU -NUU +0 0\n>Verna: ADEIRST 8G STAIRED +68 68\n#note Could have played DISRATE.\n>Samuel_Kaplan: AEEGOPT -OPT +0 0\n#rack2 ADEI\n`,
  );
  await page.getByRole("button", { name: "Create imported scenario" }).click();
  // The success message must survive the session connection.
  await expect(page.getByText(/Imported 3 records · NWL2023/)).toBeVisible();
  await expect(page.locator(".score-card").first()).toContainText(
    "Samuel Kaplan",
  );
  await expect(page.locator(".score-card").nth(1)).toContainText("Verna Berg");

  await page.getByRole("button", { name: "Replay game" }).click();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("Record 1 of 3")).toBeVisible();
  await expect(page.getByText("VERNA BERG'S RACK")).toBeVisible();
  await expect(page.locator(".score-card.active")).toContainText("Verna Berg");
  await expect(page.locator(".rack .rack-tile")).toHaveCount(7);
  await expect(page.locator(".replay-event")).toContainText(
    "8G STAIRED +68 · 68",
  );

  await page.getByRole("button", { name: "Analyze this turn" }).click();
  await expect(page.getByText("Analysis complete")).toBeVisible();
  await expect(page.locator(".move-row.played")).toContainText("STAIRED");
  await expect(page.getByText(/The move played ranks #2/)).toBeVisible();
  await expect(page.getByText(/not in NWL2023: QZ/)).toBeVisible();

  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.locator(".replay-note")).toContainText(
    "Could have played DISRATE.",
  );
  await expect(page.getByText("SAMUEL KAPLAN'S RACK")).toBeVisible();
  await expect(page.locator(".move-row")).toHaveCount(0);

  await page.getByRole("button", { name: "Return to final" }).click();
  await expect(page.getByRole("button", { name: "Replay game" })).toBeVisible();
  await expect(page.locator(".rack .rack-tile")).toHaveCount(4);
});

test("asks which dictionary to use for a GCG without #lexicon", async ({
  page,
}) => {
  await clearDraft(page);
  await mockSessionApi(page);
  await page.goto("/");

  await expect(page.getByText("Session ready")).toBeVisible();
  await openGameImport(page);
  await chooseGcgFileForReview(
    page,
    "nolexicon.gcg",
    `#character-encoding UTF-8\n#player1 A Alice\n#player2 B Bob\n>A: ADEIRST 8D DISRATE +70 70\n`,
  );
  await page
    .getByLabel("Which dictionary was this game played with?")
    .selectOption("csw24");
  await page.getByRole("button", { name: "Create imported scenario" }).click();
  await expect(page.getByRole("button", { name: "H8 A" })).toBeVisible();
  await expect(page.locator(".lexicon-chip")).toContainText("CSW24");
});

test("board squares stay square and fit narrow phones", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await clearDraft(page);
  await mockSessionApi(page);
  await page.goto("/");
  await expect(page.getByText("Session ready")).toBeVisible();
  await enterRack(page, "WM");
  await page.locator(".rack-tile").first().click();
  await page.locator(".board-cell").nth(112).click();
  await page.locator(".rack-tile").nth(1).click();
  await page.locator(".board-cell").nth(113).click();
  const metrics = await page.evaluate(() => {
    const cells = [...document.querySelectorAll(".board-cell")].map((cell) =>
      cell.getBoundingClientRect(),
    );
    const board = document.querySelector(".board")!.getBoundingClientRect();
    return {
      scrollWidth: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
      boardRight: board.right,
      sizes: [
        ...new Set(
          cells.map(
            (rect) => `${rect.width.toFixed(2)}x${rect.height.toFixed(2)}`,
          ),
        ),
      ],
      square: cells.every((rect) => Math.abs(rect.width - rect.height) < 0.5),
    };
  });
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.viewport);
  expect(metrics.boardRight).toBeLessThanOrEqual(metrics.viewport);
  expect(metrics.sizes).toHaveLength(1);
  expect(metrics.square).toBe(true);
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
    page.getByText(/This browser shows the 100 most recent scenarios/),
  ).toBeVisible();
  const scenarios = page.getByRole("dialog", { name: "Your workspace" });
  await scenarios.getByRole("button", { name: "Blank position" }).click();
  await page.getByRole("button", { name: "Create blank position" }).click();
  await expect(page.getByText("Session ready")).toBeVisible();
  await enterRack(page, "D");
  await page.locator(".rack-tile").first().click();
  await page.locator(".board-cell").nth(112).click();
  await expect(page.getByRole("button", { name: "H8 D" })).toBeVisible();

  await page.getByRole("button", { name: "Open recent scenarios" }).click();
  const recent = page.getByRole("dialog", { name: "Your workspace" });
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
