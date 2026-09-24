import {
  getScenario,
  loadActiveScenario,
  newScenarioId,
  saveScenario,
  type ScenarioRecord,
} from "./scenario-store";

export interface DraftSnapshot {
  sessionId: string | null;
  revision: number;
  state: unknown;
  savedAt: string;
}

function scenarioFromDraft(
  snapshot: DraftSnapshot,
  existing: ScenarioRecord | null,
): ScenarioRecord {
  const savedAt = snapshot.savedAt || new Date().toISOString();
  return {
    schemaVersion: 1,
    localId: existing?.localId ?? newScenarioId(),
    sessionId: snapshot.sessionId,
    kind: existing?.kind ?? "new",
    title: existing?.title ?? "Current position",
    state: snapshot.state,
    revision: snapshot.revision,
    dirty: true,
    createdAt: existing?.createdAt ?? savedAt,
    savedAt,
    lastOpenedAt: existing?.lastOpenedAt ?? savedAt,
    source: existing?.source ?? { kind: "new" },
  };
}

export async function loadDraft(): Promise<DraftSnapshot | null> {
  const scenario = await loadActiveScenario();
  if (!scenario) return null;
  return {
    sessionId: scenario.sessionId,
    revision: scenario.revision,
    state: scenario.state,
    savedAt: scenario.savedAt,
  };
}

export async function saveDraft(snapshot: DraftSnapshot): Promise<void> {
  const existing = await loadActiveScenario();
  await saveScenario(scenarioFromDraft(snapshot, existing));
}

export async function clearDraft(): Promise<void> {
  const existing = await loadActiveScenario();
  if (!existing) return;
  await saveScenario({
    ...existing,
    state: {},
    dirty: true,
    savedAt: new Date().toISOString(),
    lastOpenedAt: new Date().toISOString(),
  });
}
