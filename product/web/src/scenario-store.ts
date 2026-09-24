export type ScenarioKind = "new" | "imported" | "forked";

export type ScenarioSource =
  | { kind: "new" }
  | { kind: "imported"; format: string; filename?: string; sourceUrl?: string }
  | { kind: "forked"; sourceSessionId?: string; sourceRevision?: number };

export interface ScenarioRecord {
  schemaVersion: 1;
  localId: string;
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

const DATABASE_NAME = "quackle-web-drafts";
const DATABASE_VERSION = 2;
const DRAFT_STORE_NAME = "drafts";
const SCENARIO_STORE_NAME = "scenarios";
const META_STORE_NAME = "meta";
const LEGACY_ACTIVE_KEY = "active";
const LEGACY_SCENARIO_ID = "legacy-active";
const ACTIVE_SCENARIO_KEY = "activeScenario";
export const MAX_LOCAL_SCENARIOS = 100;

function now(): string {
  return new Date().toISOString();
}

export function newScenarioId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    return crypto.randomUUID();
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
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
        };
      }
    };
    request.onsuccess = () => resolve(request.result);
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
      const request = database
        .transaction(SCENARIO_STORE_NAME, "readonly")
        .objectStore(SCENARIO_STORE_NAME)
        .getAll();
      request.onerror = () =>
        reject(request.error ?? new Error("indexeddb_read_failed"));
      request.onsuccess = () =>
        resolve(sortScenarios((request.result as ScenarioRecord[]) ?? []));
    });
  });
}

export async function getScenario(
  localId: string,
): Promise<ScenarioRecord | null> {
  return withDatabase(async (database) => {
    return new Promise((resolve, reject) => {
      const request = database
        .transaction(SCENARIO_STORE_NAME, "readonly")
        .objectStore(SCENARIO_STORE_NAME)
        .get(localId);
      request.onerror = () =>
        reject(request.error ?? new Error("indexeddb_read_failed"));
      request.onsuccess = () =>
        resolve((request.result as ScenarioRecord | undefined) ?? null);
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
        const scenarioRequest = transaction
          .objectStore(SCENARIO_STORE_NAME)
          .get(localId);
        scenarioRequest.onerror = () =>
          reject(scenarioRequest.error ?? new Error("indexeddb_read_failed"));
        scenarioRequest.onsuccess = () =>
          resolve(
            (scenarioRequest.result as ScenarioRecord | undefined) ?? null,
          );
      };
    });
  });
}

export async function setActiveScenario(localId: string): Promise<void> {
  return withDatabase(async (database) => {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(META_STORE_NAME, "readwrite");
      transaction
        .objectStore(META_STORE_NAME)
        .put({ localId }, ACTIVE_SCENARIO_KEY);
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("indexeddb_write_failed"));
      transaction.oncomplete = () => resolve();
    });
  });
}

export async function saveScenario(
  scenario: ScenarioRecord,
  makeActive = true,
): Promise<void> {
  return withDatabase(async (database) => {
    await new Promise<void>((resolve, reject) => {
      const storeNames = makeActive
        ? [SCENARIO_STORE_NAME, META_STORE_NAME]
        : [SCENARIO_STORE_NAME];
      const transaction = database.transaction(storeNames, "readwrite");
      transaction.objectStore(SCENARIO_STORE_NAME).put(scenario);
      if (makeActive)
        transaction
          .objectStore(META_STORE_NAME)
          .put({ localId: scenario.localId }, ACTIVE_SCENARIO_KEY);
      const allRequest = transaction.objectStore(SCENARIO_STORE_NAME).getAll();
      allRequest.onsuccess = () => {
        const records = sortScenarios(
          (allRequest.result as ScenarioRecord[]) ?? [],
        );
        const keep = new Set(
          records.slice(0, MAX_LOCAL_SCENARIOS).map((record) => record.localId),
        );
        for (const record of records.slice(MAX_LOCAL_SCENARIOS)) {
          if (!record.dirty && !keep.has(record.localId))
            transaction.objectStore(SCENARIO_STORE_NAME).delete(record.localId);
        }
      };
      allRequest.onerror = () =>
        reject(allRequest.error ?? new Error("indexeddb_read_failed"));
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("indexeddb_write_failed"));
      transaction.oncomplete = () => resolve();
    });
  });
}

export async function deleteScenario(localId: string): Promise<void> {
  return withDatabase(async (database) => {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(
        [SCENARIO_STORE_NAME, META_STORE_NAME],
        "readwrite",
      );
      transaction.objectStore(SCENARIO_STORE_NAME).delete(localId);
      const activeRequest = transaction
        .objectStore(META_STORE_NAME)
        .get(ACTIVE_SCENARIO_KEY);
      activeRequest.onsuccess = () => {
        const active = activeRequest.result as { localId?: string } | undefined;
        if (active?.localId === localId)
          transaction.objectStore(META_STORE_NAME).delete(ACTIVE_SCENARIO_KEY);
      };
      activeRequest.onerror = () =>
        reject(activeRequest.error ?? new Error("indexeddb_read_failed"));
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("indexeddb_delete_failed"));
      transaction.oncomplete = () => resolve();
    });
  });
}

export async function clearScenarioStore(): Promise<void> {
  return withDatabase(async (database) => {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(
        [SCENARIO_STORE_NAME, META_STORE_NAME],
        "readwrite",
      );
      transaction.objectStore(SCENARIO_STORE_NAME).clear();
      transaction.objectStore(META_STORE_NAME).clear();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("indexeddb_delete_failed"));
      transaction.oncomplete = () => resolve();
    });
  });
}
