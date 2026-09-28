export type ScenarioKind = "new" | "imported" | "forked";

export type ScenarioSource =
  | { kind: "new" }
  | { kind: "imported"; format: string; filename?: string; sourceUrl?: string }
  | { kind: "forked"; sourceSessionId?: string; sourceRevision?: number };

export interface ScenarioRecord {
  schemaVersion: 1;
  localId: string;
  /** Local-only generation counter; never sent to the Worker or exported. */
  localGeneration?: number;
  /** Independent local-name version used to preserve renames across autosaves. */
  localTitleRevision?: number;
  sessionId: string | null;
  kind: ScenarioKind;
  title: string;
  state: unknown;
  revision: number;
  dirty: boolean;
  createdAt: string;
  savedAt: string;
  lastOpenedAt: string;
  source?: ScenarioSource;
}

/**
 * Local management handle for a source session. It contains no capability or
 * share bearer token, and survives removal/pruning of the scenario itself.
 */
export interface ShareSourceRecord {
  sessionId: string;
  title: string;
  localId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface DeletedScenario {
  scenario: ScenarioRecord;
  generation: number;
  deletionId: string;
  deletedAt: string;
  shareSources: ShareSourceRecord[];
}

export type ScenarioStoreEvent =
  | { type: "removed"; localIds: string[] }
  | { type: "restored"; localId: string }
  | { type: "renamed"; localId: string; title: string; titleRevision: number }
  | { type: "sources-changed"; sessionId: string };

const DATABASE_NAME = "quackle-web-drafts";
const DATABASE_VERSION = 3;
const DRAFT_STORE_NAME = "drafts";
const SCENARIO_STORE_NAME = "scenarios";
const SHARE_SOURCE_STORE_NAME = "shareSources";
const META_STORE_NAME = "meta";
const LEGACY_ACTIVE_KEY = "active";
const LEGACY_SCENARIO_ID = "legacy-active";
const ACTIVE_SCENARIO_KEY = "activeScenario";
const SCENARIO_TOMBSTONE_PREFIX = "scenario-deleted:";
const SCENARIO_GENERATION_PREFIX = "scenario-generation:";
const SCENARIO_CHANNEL_NAME = "quackle-web-scenarios";
export const MAX_LOCAL_SCENARIOS = 100;
export const MAX_SCENARIO_TITLE_BYTES = 128;

function now(): string {
  return new Date().toISOString();
}

export function newScenarioId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    return crypto.randomUUID();
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function validSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{20,128}$/.test(value);
}

export function validateScenarioTitle(value: string): string | null {
  const title = value.trim();
  if (
    title.length === 0 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(title) ||
    new TextEncoder().encode(title).byteLength > MAX_SCENARIO_TITLE_BYTES
  ) {
    return null;
  }
  return title;
}

function tombstoneKey(localId: string): string {
  return `${SCENARIO_TOMBSTONE_PREFIX}${localId}`;
}

function generationKey(localId: string): string {
  return `${SCENARIO_GENERATION_PREFIX}${localId}`;
}

function sourceRecord(
  scenario: Pick<ScenarioRecord, "localId" | "sessionId" | "title">,
  existing?: ShareSourceRecord,
): ShareSourceRecord | null {
  if (!validSessionId(scenario.sessionId)) return null;
  const timestamp = now();
  return {
    sessionId: scenario.sessionId,
    title: scenario.title.slice(0, 128),
    localId: scenario.localId,
    firstSeenAt: existing?.firstSeenAt ?? timestamp,
    lastSeenAt: timestamp,
  };
}

function publishScenarioEvent(event: ScenarioStoreEvent): void {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(SCENARIO_CHANNEL_NAME);
  channel.postMessage(event);
  channel.close();
}

export function subscribeToScenarioEvents(
  listener: (event: ScenarioStoreEvent) => void,
): () => void {
  if (typeof BroadcastChannel === "undefined") return () => undefined;
  const channel = new BroadcastChannel(SCENARIO_CHANNEL_NAME);
  channel.onmessage = (event: MessageEvent<ScenarioStoreEvent>) => {
    if (
      event.data &&
      ["removed", "restored", "renamed", "sources-changed"].includes(
        event.data.type,
      )
    ) {
      listener(event.data);
    }
  };
  return () => channel.close();
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("indexeddb_unavailable"));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onerror = () =>
      reject(request.error ?? new Error("indexeddb_open_failed"));
    request.onupgradeneeded = (event) => {
      const oldVersion = (event as IDBVersionChangeEvent).oldVersion;
      const database = request.result;
      const transaction = request.transaction;
      if (!transaction) return;
      if (!database.objectStoreNames.contains(DRAFT_STORE_NAME))
        database.createObjectStore(DRAFT_STORE_NAME);
      if (!database.objectStoreNames.contains(SCENARIO_STORE_NAME)) {
        const store = database.createObjectStore(SCENARIO_STORE_NAME, {
          keyPath: "localId",
        });
        store.createIndex("sessionId", "sessionId", { unique: false });
        store.createIndex("lastOpenedAt", "lastOpenedAt", { unique: false });
      }
      if (!database.objectStoreNames.contains(SHARE_SOURCE_STORE_NAME)) {
        database.createObjectStore(SHARE_SOURCE_STORE_NAME, {
          keyPath: "sessionId",
        });
      }
      if (!database.objectStoreNames.contains(META_STORE_NAME))
        database.createObjectStore(META_STORE_NAME);

      if (oldVersion < 2) {
        const legacyRequest = transaction
          .objectStore(DRAFT_STORE_NAME)
          .get(LEGACY_ACTIVE_KEY);
        legacyRequest.onsuccess = () => {
          const legacy = legacyRequest.result as
            | {
                sessionId?: string | null;
                revision?: number;
                state?: unknown;
                savedAt?: string;
              }
            | undefined;
          if (!legacy) return;
          const savedAt =
            typeof legacy.savedAt === "string" ? legacy.savedAt : now();
          const scenario: ScenarioRecord = {
            schemaVersion: 1,
            localId: LEGACY_SCENARIO_ID,
            localGeneration: 0,
            sessionId:
              typeof legacy.sessionId === "string" ? legacy.sessionId : null,
            kind: "new",
            title: "Current position",
            state: legacy.state ?? {},
            revision: typeof legacy.revision === "number" ? legacy.revision : 0,
            dirty: true,
            createdAt: savedAt,
            savedAt,
            lastOpenedAt: savedAt,
            source: { kind: "new" },
          };
          transaction.objectStore(SCENARIO_STORE_NAME).put(scenario);
          transaction
            .objectStore(META_STORE_NAME)
            .put({ localId: LEGACY_SCENARIO_ID }, ACTIVE_SCENARIO_KEY);
          const source = sourceRecord(scenario);
          if (source)
            transaction.objectStore(SHARE_SOURCE_STORE_NAME).put(source);
        };
      }
      if (oldVersion < 3) {
        const scenarios = transaction.objectStore(SCENARIO_STORE_NAME);
        const shareSources = transaction.objectStore(SHARE_SOURCE_STORE_NAME);
        const cursorRequest = scenarios.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const scenario = cursor.value as ScenarioRecord;
          const generation =
            Number.isInteger(scenario.localGeneration) &&
            (scenario.localGeneration ?? 0) >= 0
              ? scenario.localGeneration!
              : 0;
          if (scenario.localGeneration !== generation) {
            cursor.update({ ...scenario, localGeneration: generation });
          }
          const source = sourceRecord({
            localId: scenario.localId,
            sessionId: scenario.sessionId,
            title: scenario.title,
          });
          if (source) shareSources.put(source);
          cursor.continue();
        };
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

async function withDatabase<T>(
  operation: (database: IDBDatabase) => Promise<T>,
): Promise<T> {
  const database = await openDatabase();
  try {
    return await operation(database);
  } finally {
    database.close();
  }
}

function sortScenarios(scenarios: ScenarioRecord[]): ScenarioRecord[] {
  return scenarios.sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
}

export async function listScenarios(): Promise<ScenarioRecord[]> {
  return withDatabase(async (database) => {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(
        [SCENARIO_STORE_NAME, META_STORE_NAME],
        "readonly",
      );
      const request = transaction.objectStore(SCENARIO_STORE_NAME).getAll();
      const meta = transaction.objectStore(META_STORE_NAME);
      request.onerror = () =>
        reject(request.error ?? new Error("indexeddb_read_failed"));
      request.onsuccess = () => {
        const records = (request.result as ScenarioRecord[]) ?? [];
        if (records.length === 0) {
          resolve([]);
          return;
        }
        const visible: ScenarioRecord[] = [];
        let remaining = records.length;
        for (const record of records) {
          const deletedRequest = meta.get(tombstoneKey(record.localId));
          const generationRequest = meta.get(generationKey(record.localId));
          let settled = 0;
          let deleted = false;
          let generation = 0;
          const finish = () => {
            settled += 1;
            if (settled !== 2) return;
            if (!deleted && (record.localGeneration ?? 0) >= generation)
              visible.push(record);
            remaining -= 1;
            if (remaining === 0) resolve(sortScenarios(visible));
          };
          deletedRequest.onsuccess = () => {
            deleted = Boolean(deletedRequest.result);
            finish();
          };
          generationRequest.onsuccess = () => {
            const value = generationRequest.result as
              { generation?: unknown } | undefined;
            generation =
              typeof value?.generation === "number" &&
              Number.isInteger(value.generation)
                ? value.generation
                : 0;
            finish();
          };
          deletedRequest.onerror = () =>
            reject(deletedRequest.error ?? new Error("indexeddb_read_failed"));
          generationRequest.onerror = () =>
            reject(
              generationRequest.error ?? new Error("indexeddb_read_failed"),
            );
        }
      };
    });
  });
}

export async function getScenario(
  localId: string,
): Promise<ScenarioRecord | null> {
  return withDatabase(async (database) => {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(
        [SCENARIO_STORE_NAME, META_STORE_NAME],
        "readonly",
      );
      const request = transaction.objectStore(SCENARIO_STORE_NAME).get(localId);
      const deleted = transaction
        .objectStore(META_STORE_NAME)
        .get(tombstoneKey(localId));
      const generationRequest = transaction
        .objectStore(META_STORE_NAME)
        .get(generationKey(localId));
      let scenario: ScenarioRecord | null = null;
      let isDeleted = false;
      let generation = 0;
      let settled = 0;
      const complete = () => {
        settled += 1;
        if (settled === 3) {
          resolve(
            isDeleted ||
              (scenario && (scenario.localGeneration ?? 0) < generation)
              ? null
              : scenario,
          );
        }
      };
      request.onerror = () =>
        reject(request.error ?? new Error("indexeddb_read_failed"));
      request.onsuccess = () => {
        scenario = (request.result as ScenarioRecord | undefined) ?? null;
        complete();
      };
      deleted.onerror = () =>
        reject(deleted.error ?? new Error("indexeddb_read_failed"));
      deleted.onsuccess = () => {
        isDeleted = Boolean(deleted.result);
        complete();
      };
      generationRequest.onerror = () =>
        reject(generationRequest.error ?? new Error("indexeddb_read_failed"));
      generationRequest.onsuccess = () => {
        const value = generationRequest.result as
          { generation?: unknown } | undefined;
        generation =
          typeof value?.generation === "number" &&
          Number.isInteger(value.generation)
            ? value.generation
            : 0;
        complete();
      };
    });
  });
}

export async function listShareSources(): Promise<ShareSourceRecord[]> {
  return withDatabase(async (database) => {
    return new Promise((resolve, reject) => {
      const request = database
        .transaction(SHARE_SOURCE_STORE_NAME, "readonly")
        .objectStore(SHARE_SOURCE_STORE_NAME)
        .getAll();
      request.onerror = () =>
        reject(request.error ?? new Error("indexeddb_read_failed"));
      request.onsuccess = () =>
        resolve(
          ((request.result as ShareSourceRecord[]) ?? []).sort((a, b) =>
            b.lastSeenAt.localeCompare(a.lastSeenAt),
          ),
        );
    });
  });
}

export async function rememberShareSource(
  sessionId: string,
  title: string,
  localId: string | null,
): Promise<void> {
  if (!validSessionId(sessionId)) throw new Error("invalid_share_source");
  return withDatabase(async (database) => {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(
        [SCENARIO_STORE_NAME, META_STORE_NAME, SHARE_SOURCE_STORE_NAME],
        "readwrite",
      );
      const scenarios = transaction.objectStore(SCENARIO_STORE_NAME);
      const meta = transaction.objectStore(META_STORE_NAME);
      const store = transaction.objectStore(SHARE_SOURCE_STORE_NAME);
      const existingRequest = store.get(sessionId);
      let existing: ShareSourceRecord | undefined;
      let localScenario: ScenarioRecord | undefined;
      let deleted = false;
      let generation = 0;
      let checksRemaining = localId ? 4 : 1;
      const write = () => {
        checksRemaining -= 1;
        if (checksRemaining !== 0) return;
        const attachedLocalId =
          localId &&
          localScenario?.sessionId === sessionId &&
          !deleted &&
          (localScenario.localGeneration ?? 0) >= generation
            ? localId
            : null;
        store.put({
          sessionId,
          title: (attachedLocalId && localScenario
            ? localScenario.title
            : title
          ).slice(0, 128),
          localId: attachedLocalId,
          firstSeenAt: existing?.firstSeenAt ?? now(),
          lastSeenAt: now(),
        } satisfies ShareSourceRecord);
      };
      existingRequest.onsuccess = () => {
        existing = existingRequest.result as ShareSourceRecord | undefined;
        write();
      };
      existingRequest.onerror = () =>
        reject(existingRequest.error ?? new Error("indexeddb_read_failed"));
      if (localId) {
        const scenarioRequest = scenarios.get(localId);
        const deletedRequest = meta.get(tombstoneKey(localId));
        const generationRequest = meta.get(generationKey(localId));
        scenarioRequest.onsuccess = () => {
          localScenario = scenarioRequest.result as ScenarioRecord | undefined;
          write();
        };
        deletedRequest.onsuccess = () => {
          deleted = Boolean(deletedRequest.result);
          write();
        };
        generationRequest.onsuccess = () => {
          const value = generationRequest.result as
            { generation?: unknown } | undefined;
          generation =
            typeof value?.generation === "number" &&
            Number.isInteger(value.generation)
              ? value.generation
              : 0;
          write();
        };
        for (const request of [
          scenarioRequest,
          deletedRequest,
          generationRequest,
        ]) {
          request.onerror = () =>
            reject(request.error ?? new Error("indexeddb_read_failed"));
        }
      }
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("indexeddb_write_failed"));
      transaction.oncomplete = () => {
        publishScenarioEvent({ type: "sources-changed", sessionId });
        resolve();
      };
    });
  });
}

/**
 * Rename only the browser-local label. Game/session state and its revision are
 * untouched; share-source labels are updated only while still associated.
 */
export async function renameScenario(
  localId: string,
  title: string,
  expectedTitleRevision?: number,
): Promise<ScenarioRecord | null> {
  const validTitle = validateScenarioTitle(title);
  if (!validTitle) throw new Error("invalid_scenario_title");
  return withDatabase(async (database) => {
    return new Promise<ScenarioRecord | null>((resolve, reject) => {
      const transaction = database.transaction(
        [SCENARIO_STORE_NAME, META_STORE_NAME, SHARE_SOURCE_STORE_NAME],
        "readwrite",
      );
      const scenarios = transaction.objectStore(SCENARIO_STORE_NAME);
      const meta = transaction.objectStore(META_STORE_NAME);
      const shareSources = transaction.objectStore(SHARE_SOURCE_STORE_NAME);
      const scenarioRequest = scenarios.get(localId);
      const tombstoneRequest = meta.get(tombstoneKey(localId));
      const generationRequest = meta.get(generationKey(localId));
      let scenario: ScenarioRecord | undefined;
      let tombstone: unknown;
      let storedGeneration = 0;
      let checksRemaining = 3;
      let renamed: ScenarioRecord | null = null;
      let changed = false;
      const finish = () => {
        checksRemaining -= 1;
        if (checksRemaining !== 0) return;
        if (
          !scenario ||
          tombstone ||
          (scenario.localGeneration ?? 0) < storedGeneration ||
          (expectedTitleRevision !== undefined &&
            (scenario.localTitleRevision ?? 0) !== expectedTitleRevision)
        )
          return;
        const currentTitleRevision = scenario.localTitleRevision ?? 0;
        if (scenario.title === validTitle) {
          renamed = scenario;
          return;
        }
        renamed = {
          ...scenario,
          title: validTitle,
          localTitleRevision: currentTitleRevision + 1,
          savedAt: now(),
        };
        changed = true;
        scenarios.put(renamed);
        if (validSessionId(scenario.sessionId)) {
          const sourceRequest = shareSources.get(scenario.sessionId);
          sourceRequest.onsuccess = () => {
            const source = sourceRequest.result as
              ShareSourceRecord | undefined;
            if (source?.localId === localId) {
              shareSources.put({
                ...source,
                title: validTitle,
                lastSeenAt: now(),
              });
            }
          };
          sourceRequest.onerror = () =>
            reject(sourceRequest.error ?? new Error("indexeddb_read_failed"));
        }
      };
      scenarioRequest.onsuccess = () => {
        scenario = scenarioRequest.result as ScenarioRecord | undefined;
        finish();
      };
      scenarioRequest.onerror = () =>
        reject(scenarioRequest.error ?? new Error("indexeddb_read_failed"));
      tombstoneRequest.onsuccess = () => {
        tombstone = tombstoneRequest.result;
        finish();
      };
      tombstoneRequest.onerror = () =>
        reject(tombstoneRequest.error ?? new Error("indexeddb_read_failed"));
      generationRequest.onsuccess = () => {
        const value = generationRequest.result as
          { generation?: unknown } | undefined;
        storedGeneration =
          typeof value?.generation === "number" &&
          Number.isInteger(value.generation)
            ? value.generation
            : 0;
        finish();
      };
      generationRequest.onerror = () =>
        reject(generationRequest.error ?? new Error("indexeddb_read_failed"));
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("indexeddb_write_failed"));
      transaction.oncomplete = () => {
        if (changed && renamed) {
          publishScenarioEvent({
            type: "renamed",
            localId,
            title: renamed.title,
            titleRevision: renamed.localTitleRevision ?? 0,
          });
        }
        resolve(renamed);
      };
    });
  });
}

export async function getScenarioBySessionId(
  sessionId: string,
): Promise<ScenarioRecord | null> {
  return withDatabase(async (database) => {
    return new Promise((resolve, reject) => {
      const index = database
        .transaction(SCENARIO_STORE_NAME, "readonly")
        .objectStore(SCENARIO_STORE_NAME)
        .index("sessionId");
      const request = index.get(sessionId);
      request.onerror = () =>
        reject(request.error ?? new Error("indexeddb_read_failed"));
      request.onsuccess = () =>
        resolve((request.result as ScenarioRecord | undefined) ?? null);
    });
  });
}

export async function loadActiveScenario(): Promise<ScenarioRecord | null> {
  return withDatabase(async (database) => {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(
        [SCENARIO_STORE_NAME, META_STORE_NAME],
        "readonly",
      );
      const metaRequest = transaction
        .objectStore(META_STORE_NAME)
        .get(ACTIVE_SCENARIO_KEY);
      metaRequest.onerror = () =>
        reject(metaRequest.error ?? new Error("indexeddb_read_failed"));
      metaRequest.onsuccess = () => {
        const localId = (metaRequest.result as { localId?: string } | undefined)
          ?.localId;
        if (!localId) {
          resolve(null);
          return;
        }
        const scenarios = transaction.objectStore(SCENARIO_STORE_NAME);
        const meta = transaction.objectStore(META_STORE_NAME);
        const scenarioRequest = scenarios.get(localId);
        const deletedRequest = meta.get(tombstoneKey(localId));
        const generationRequest = meta.get(generationKey(localId));
        let scenario: ScenarioRecord | null = null;
        let deleted = false;
        let generation = 0;
        let settled = 0;
        const finish = () => {
          settled += 1;
          if (settled === 3) {
            resolve(
              deleted ||
                (scenario && (scenario.localGeneration ?? 0) < generation)
                ? null
                : scenario,
            );
          }
        };
        scenarioRequest.onerror = () =>
          reject(scenarioRequest.error ?? new Error("indexeddb_read_failed"));
        scenarioRequest.onsuccess = () => {
          scenario =
            (scenarioRequest.result as ScenarioRecord | undefined) ?? null;
          finish();
        };
        deletedRequest.onerror = () =>
          reject(deletedRequest.error ?? new Error("indexeddb_read_failed"));
        deletedRequest.onsuccess = () => {
          deleted = Boolean(deletedRequest.result);
          finish();
        };
        generationRequest.onerror = () =>
          reject(generationRequest.error ?? new Error("indexeddb_read_failed"));
        generationRequest.onsuccess = () => {
          const value = generationRequest.result as
            { generation?: unknown } | undefined;
          generation =
            typeof value?.generation === "number" &&
            Number.isInteger(value.generation)
              ? value.generation
              : 0;
          finish();
        };
      };
    });
  });
}

export async function setActiveScenario(localId: string): Promise<void> {
  return withDatabase(async (database) => {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(
        [SCENARIO_STORE_NAME, META_STORE_NAME],
        "readwrite",
      );
      const meta = transaction.objectStore(META_STORE_NAME);
      const scenarioRequest = transaction
        .objectStore(SCENARIO_STORE_NAME)
        .get(localId);
      const deletedRequest = meta.get(tombstoneKey(localId));
      const generationRequest = meta.get(generationKey(localId));
      let scenario: ScenarioRecord | undefined;
      let deleted = false;
      let generation = 0;
      let settled = 0;
      const finish = () => {
        settled += 1;
        if (settled !== 3) return;
        if (
          !scenario ||
          deleted ||
          (scenario.localGeneration ?? 0) < generation
        ) {
          reject(new Error("scenario_removed"));
          return;
        }
        meta.put({ localId }, ACTIVE_SCENARIO_KEY);
      };
      scenarioRequest.onsuccess = () => {
        scenario = scenarioRequest.result as ScenarioRecord | undefined;
        finish();
      };
      scenarioRequest.onerror = () =>
        reject(scenarioRequest.error ?? new Error("indexeddb_read_failed"));
      deletedRequest.onsuccess = () => {
        deleted = Boolean(deletedRequest.result);
        finish();
      };
      deletedRequest.onerror = () =>
        reject(deletedRequest.error ?? new Error("indexeddb_read_failed"));
      generationRequest.onsuccess = () => {
        const value = generationRequest.result as
          { generation?: unknown } | undefined;
        generation =
          typeof value?.generation === "number" &&
          Number.isInteger(value.generation)
            ? value.generation
            : 0;
        finish();
      };
      generationRequest.onerror = () =>
        reject(generationRequest.error ?? new Error("indexeddb_read_failed"));
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("indexeddb_write_failed"));
      transaction.oncomplete = () => resolve();
    });
  });
}

export async function saveScenario(
  scenario: ScenarioRecord,
  makeActive = true,
  advanceLocalGeneration = false,
): Promise<boolean> {
  return withDatabase(async (database) => {
    return new Promise<boolean>((resolve, reject) => {
      const transaction = database.transaction(
        [
          DRAFT_STORE_NAME,
          SCENARIO_STORE_NAME,
          META_STORE_NAME,
          SHARE_SOURCE_STORE_NAME,
        ],
        "readwrite",
      );
      const drafts = transaction.objectStore(DRAFT_STORE_NAME);
      const scenarios = transaction.objectStore(SCENARIO_STORE_NAME);
      const meta = transaction.objectStore(META_STORE_NAME);
      const shareSources = transaction.objectStore(SHARE_SOURCE_STORE_NAME);
      const tombstoneRequest = meta.get(tombstoneKey(scenario.localId));
      const generationRequest = meta.get(generationKey(scenario.localId));
      const existingRequest = scenarios.get(scenario.localId);
      const activeRequest = makeActive ? null : meta.get(ACTIVE_SCENARIO_KEY);
      let tombstone: unknown;
      let storedGeneration = 0;
      let existingScenario: ScenarioRecord | undefined;
      let activeLocalId: string | null = makeActive ? scenario.localId : null;
      let checksRemaining = activeRequest ? 4 : 3;
      let saved = false;
      const prunedLocalIds: string[] = [];

      const prepareSave = () => {
        checksRemaining -= 1;
        if (checksRemaining !== 0) return;
        const localGeneration = scenario.localGeneration ?? 0;
        if (tombstone || localGeneration < storedGeneration) return;
        const generation =
          Math.max(localGeneration, storedGeneration) +
          (advanceLocalGeneration ? 1 : 0);
        const storedTitleRevision = existingScenario?.localTitleRevision ?? 0;
        const incomingTitleRevision = scenario.localTitleRevision ?? 0;
        const savedScenario = {
          ...scenario,
          ...(storedTitleRevision > incomingTitleRevision
            ? {
                title: existingScenario!.title,
                localTitleRevision: storedTitleRevision,
              }
            : { localTitleRevision: incomingTitleRevision }),
          localGeneration: generation,
        };
        scenarios.put(savedScenario);
        meta.put({ generation }, generationKey(scenario.localId));
        if (makeActive)
          meta.put({ localId: scenario.localId }, ACTIVE_SCENARIO_KEY);
        saved = true;

        const source = sourceRecord(savedScenario);
        if (source) {
          const sourceRequest = shareSources.get(source.sessionId);
          sourceRequest.onsuccess = () => {
            const existing = sourceRequest.result as
              ShareSourceRecord | undefined;
            if (
              existing &&
              (existing.localId !== source.localId ||
                existing.title !== source.title)
            ) {
              shareSources.put({
                ...existing,
                title: source.title,
                localId: source.localId,
                lastSeenAt: now(),
              });
            }
          };
        }

        const allRequest = scenarios.getAll();
        allRequest.onsuccess = () => {
          const records = sortScenarios(
            (allRequest.result as ScenarioRecord[]) ?? [],
          );
          const keep = new Set(
            records
              .slice(0, MAX_LOCAL_SCENARIOS)
              .map((record) => record.localId),
          );
          if (activeLocalId) keep.add(activeLocalId);
          for (const record of records) {
            if (record.dirty || keep.has(record.localId)) continue;
            scenarios.delete(record.localId);
            if (record.localId === LEGACY_SCENARIO_ID)
              drafts.delete(LEGACY_ACTIVE_KEY);
            prunedLocalIds.push(record.localId);
            const nextGeneration = (record.localGeneration ?? 0) + 1;
            meta.put(
              { generation: nextGeneration },
              generationKey(record.localId),
            );
            meta.put(
              {
                generation: nextGeneration,
                deletionId: newScenarioId(),
                deletedAt: now(),
                reason: "pruned",
              },
              tombstoneKey(record.localId),
            );
            if (validSessionId(record.sessionId)) {
              const priorSource = shareSources.get(record.sessionId);
              priorSource.onsuccess = () => {
                const existing = priorSource.result as
                  ShareSourceRecord | undefined;
                if (existing)
                  shareSources.put({
                    ...existing,
                    localId: null,
                    lastSeenAt: now(),
                  });
              };
            }
          }
        };
        allRequest.onerror = () =>
          reject(allRequest.error ?? new Error("indexeddb_read_failed"));
      };

      tombstoneRequest.onsuccess = () => {
        tombstone = tombstoneRequest.result;
        prepareSave();
      };
      tombstoneRequest.onerror = () =>
        reject(tombstoneRequest.error ?? new Error("indexeddb_read_failed"));
      generationRequest.onsuccess = () => {
        const value = generationRequest.result as
          { generation?: unknown } | undefined;
        storedGeneration =
          typeof value?.generation === "number" &&
          Number.isInteger(value.generation)
            ? value.generation
            : 0;
        prepareSave();
      };
      generationRequest.onerror = () =>
        reject(generationRequest.error ?? new Error("indexeddb_read_failed"));
      existingRequest.onsuccess = () => {
        existingScenario = existingRequest.result as ScenarioRecord | undefined;
        prepareSave();
      };
      existingRequest.onerror = () =>
        reject(existingRequest.error ?? new Error("indexeddb_read_failed"));
      activeRequest?.addEventListener("success", () => {
        const active = activeRequest.result as
          { localId?: unknown } | undefined;
        activeLocalId =
          typeof active?.localId === "string" ? active.localId : null;
        prepareSave();
      });
      activeRequest?.addEventListener("error", () => {
        reject(activeRequest.error ?? new Error("indexeddb_read_failed"));
      });
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("indexeddb_write_failed"));
      transaction.oncomplete = () => {
        if (prunedLocalIds.length > 0)
          publishScenarioEvent({ type: "removed", localIds: prunedLocalIds });
        resolve(saved);
      };
    });
  });
}

export async function deleteScenario(
  localId: string,
): Promise<DeletedScenario | null> {
  return withDatabase(async (database) => {
    return new Promise<DeletedScenario | null>((resolve, reject) => {
      const transaction = database.transaction(
        [
          DRAFT_STORE_NAME,
          SCENARIO_STORE_NAME,
          META_STORE_NAME,
          SHARE_SOURCE_STORE_NAME,
        ],
        "readwrite",
      );
      const drafts = transaction.objectStore(DRAFT_STORE_NAME);
      const scenarios = transaction.objectStore(SCENARIO_STORE_NAME);
      const meta = transaction.objectStore(META_STORE_NAME);
      const shareSources = transaction.objectStore(SHARE_SOURCE_STORE_NAME);
      const scenarioRequest = scenarios.get(localId);
      const generationRequest = meta.get(generationKey(localId));
      const tombstoneRequest = meta.get(tombstoneKey(localId));
      const activeRequest = meta.get(ACTIVE_SCENARIO_KEY);
      const shareSourceRequest = shareSources.getAll();
      let scenario: ScenarioRecord | undefined;
      let storedGeneration = 0;
      let isDeleted = false;
      let activeLocalId: string | null = null;
      let knownShareSources: ShareSourceRecord[] = [];
      let settled = 0;
      let deletion: DeletedScenario | null = null;
      const finish = () => {
        settled += 1;
        if (settled !== 5) return;
        if (!scenario || isDeleted) return;
        const generation =
          Math.max(scenario.localGeneration ?? 0, storedGeneration) + 1;
        const deletionId = newScenarioId();
        const deletedAt = now();
        scenarios.delete(localId);
        if (localId === LEGACY_SCENARIO_ID) drafts.delete(LEGACY_ACTIVE_KEY);
        meta.put({ generation }, generationKey(localId));
        meta.put(
          { generation, deletionId, deletedAt, reason: "user" },
          tombstoneKey(localId),
        );
        if (activeLocalId === localId) meta.delete(ACTIVE_SCENARIO_KEY);
        const associated = knownShareSources.filter(
          (source) => source.localId === localId,
        );
        for (const source of associated) {
          shareSources.put({ ...source, localId: null, lastSeenAt: now() });
        }
        deletion = {
          scenario,
          generation,
          deletionId,
          deletedAt,
          shareSources: associated,
        };
      };
      scenarioRequest.onsuccess = () => {
        scenario = scenarioRequest.result as ScenarioRecord | undefined;
        finish();
      };
      generationRequest.onsuccess = () => {
        const value = generationRequest.result as
          { generation?: unknown } | undefined;
        storedGeneration =
          typeof value?.generation === "number" &&
          Number.isInteger(value.generation)
            ? value.generation
            : 0;
        finish();
      };
      tombstoneRequest.onsuccess = () => {
        isDeleted = Boolean(tombstoneRequest.result);
        finish();
      };
      activeRequest.onsuccess = () => {
        const value = activeRequest.result as { localId?: unknown } | undefined;
        activeLocalId =
          typeof value?.localId === "string" ? value.localId : null;
        finish();
      };
      shareSourceRequest.onsuccess = () => {
        knownShareSources =
          (shareSourceRequest.result as ShareSourceRecord[]) ?? [];
        finish();
      };
      for (const request of [
        scenarioRequest,
        generationRequest,
        tombstoneRequest,
        activeRequest,
        shareSourceRequest,
      ]) {
        request.onerror = () =>
          reject(request.error ?? new Error("indexeddb_read_failed"));
      }
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("indexeddb_delete_failed"));
      transaction.oncomplete = () => {
        if (deletion)
          publishScenarioEvent({ type: "removed", localIds: [localId] });
        resolve(deletion);
      };
    });
  });
}

export async function restoreDeletedScenario(
  deletion: DeletedScenario,
): Promise<ScenarioRecord | null> {
  return withDatabase(async (database) => {
    return new Promise<ScenarioRecord | null>((resolve, reject) => {
      const transaction = database.transaction(
        [SCENARIO_STORE_NAME, META_STORE_NAME, SHARE_SOURCE_STORE_NAME],
        "readwrite",
      );
      const scenarios = transaction.objectStore(SCENARIO_STORE_NAME);
      const meta = transaction.objectStore(META_STORE_NAME);
      const shareSources = transaction.objectStore(SHARE_SOURCE_STORE_NAME);
      const tombstoneRequest = meta.get(
        tombstoneKey(deletion.scenario.localId),
      );
      const generationRequest = meta.get(
        generationKey(deletion.scenario.localId),
      );
      const existingScenarioRequest = scenarios.get(deletion.scenario.localId);
      let tombstone: { deletionId?: unknown; generation?: unknown } | undefined;
      let storedGeneration = 0;
      let settled = 0;
      let restored: ScenarioRecord | null = null;
      const finish = () => {
        settled += 1;
        if (settled !== 3) return;
        if (
          !tombstone ||
          tombstone.deletionId !== deletion.deletionId ||
          tombstone.generation !== deletion.generation ||
          storedGeneration !== deletion.generation ||
          existingScenarioRequest.result ||
          Date.now() - Date.parse(deletion.deletedAt) > 10_000
        )
          return;
        const generation = storedGeneration + 1;
        const restoredScenario: ScenarioRecord = {
          ...deletion.scenario,
          localGeneration: generation,
          lastOpenedAt: now(),
          savedAt: now(),
        };
        restored = restoredScenario;
        scenarios.put(restoredScenario);
        meta.put({ generation }, generationKey(restoredScenario.localId));
        meta.delete(tombstoneKey(restoredScenario.localId));
        for (const source of deletion.shareSources) {
          const sourceRequest = shareSources.get(source.sessionId);
          sourceRequest.onsuccess = () => {
            const existing = sourceRequest.result as
              ShareSourceRecord | undefined;
            // Do not resurrect a manager handle the user deliberately forgot
            // during the Undo window or steal one reassociated in another tab.
            if (
              !existing ||
              (existing.localId !== null &&
                existing.localId !== deletion.scenario.localId)
            )
              return;
            shareSources.put({
              ...existing,
              title: restoredScenario.title,
              localId: restoredScenario.localId,
              lastSeenAt: now(),
            });
          };
        }
      };
      tombstoneRequest.onsuccess = () => {
        tombstone = tombstoneRequest.result as typeof tombstone;
        finish();
      };
      generationRequest.onsuccess = () => {
        const value = generationRequest.result as
          { generation?: unknown } | undefined;
        storedGeneration =
          typeof value?.generation === "number" &&
          Number.isInteger(value.generation)
            ? value.generation
            : 0;
        finish();
      };
      existingScenarioRequest.onsuccess = () => finish();
      existingScenarioRequest.onerror = () =>
        reject(
          existingScenarioRequest.error ?? new Error("indexeddb_read_failed"),
        );
      tombstoneRequest.onerror = () =>
        reject(tombstoneRequest.error ?? new Error("indexeddb_read_failed"));
      generationRequest.onerror = () =>
        reject(generationRequest.error ?? new Error("indexeddb_read_failed"));
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("indexeddb_write_failed"));
      transaction.oncomplete = () => {
        if (restored)
          publishScenarioEvent({ type: "restored", localId: restored.localId });
        resolve(restored);
      };
    });
  });
}

export async function clearScenarioStore(): Promise<void> {
  return withDatabase(async (database) => {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(
        [
          DRAFT_STORE_NAME,
          SCENARIO_STORE_NAME,
          SHARE_SOURCE_STORE_NAME,
          META_STORE_NAME,
        ],
        "readwrite",
      );
      transaction.objectStore(DRAFT_STORE_NAME).clear();
      transaction.objectStore(SCENARIO_STORE_NAME).clear();
      transaction.objectStore(SHARE_SOURCE_STORE_NAME).clear();
      transaction.objectStore(META_STORE_NAME).clear();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("indexeddb_delete_failed"));
      transaction.oncomplete = () => resolve();
    });
  });
}
