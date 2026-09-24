import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { render } from "preact";
import {
  parseCrossTablesGcgUrl,
  parseCrossTablesUrl,
} from "../../shared/cross-tables";
import {
  classicPremiumAt,
  decodeGcgBytes,
  exportGcg,
  parseGcg,
  replayGcgHistory,
  resolveLexiconHint,
  type GcgHistoryEntry,
  type GcgImportResult,
  type GcgPlayer,
} from "../../shared/gcg";
import {
  getScenario,
  listScenarios,
  loadActiveScenario,
  MAX_LOCAL_SCENARIOS,
  newScenarioId,
  saveScenario,
  setActiveScenario,
  type ScenarioKind,
  type ScenarioRecord,
  type ScenarioSource,
} from "./scenario-store";
import "./styles.css";

const API_BASE_URL = (import.meta.env.VITE_QUACKLE_API_BASE_URL ?? "").replace(
  /\/+$/,
  "",
);
const apiUrl = (path: string) => `${API_BASE_URL}${path}`;

type Cell = { letter: string; blank?: boolean };
type Move = {
  action: string;
  row?: number;
  col?: number;
  horizontal?: boolean;
  position?: string;
  word?: string;
  score?: number;
  equity?: number | null;
  rank?: number;
  leave?: string;
  used_tiles?: string;
  tiles?: string;
  is_bingo?: boolean;
};
type ConnectionState = "connecting" | "online" | "offline";
type AnalysisPhase =
  "idle" | "saving" | "starting" | "warming" | "queued" | "running";
type AnalysisMode = "fast" | "deep";
type SessionResponse = {
  session: {
    id: string;
    revision: number;
    state: unknown;
  };
};

type ShareLink = {
  shareId: string;
  sourceRevision: number;
  createdAt: string;
  expiresAt: string | null;
  useCount: number;
  lastUsedAt: string | null;
};

type ShareLinkNotice = {
  shareId: string;
  sourceRevision: number;
  createdAt: string;
  evictedAt: string;
  reason: "active_limit" | "storage_limit";
};

type AnalysisJobResponse = {
  job: {
    id: string;
    status:
      | "queued"
      | "starting"
      | "running"
      | "succeeded"
      | "failed"
      | "cancelled"
      | "interrupted";
    progressSeq: number;
    progress: { fraction?: number; elapsedMs?: number } | null;
    result: { moves?: Move[] } | null;
    error: { code?: string; message?: string; retryable?: boolean } | null;
  };
};

const SIZE = 15;
const NWL_COPYRIGHT_NOTICE =
  "NASPA Word List, 2023 Edition (NWL23), © 2023 North American Word Game Players Association. All rights reserved.";
const TILE_VALUES: Readonly<Record<string, number>> = {
  A: 1,
  B: 3,
  C: 3,
  D: 2,
  E: 1,
  F: 4,
  G: 2,
  H: 4,
  I: 1,
  J: 8,
  K: 5,
  L: 1,
  M: 3,
  N: 1,
  O: 1,
  P: 3,
  Q: 10,
  R: 1,
  S: 1,
  T: 1,
  U: 1,
  V: 4,
  W: 4,
  X: 8,
  Y: 4,
  Z: 10,
  "?": 0,
};
const ENGLISH_TILE_BAG = [
  "A".repeat(9),
  "B".repeat(2),
  "C".repeat(2),
  "D".repeat(4),
  "E".repeat(12),
  "F".repeat(2),
  "G".repeat(3),
  "H".repeat(2),
  "I".repeat(9),
  "J",
  "K",
  "L".repeat(4),
  "M".repeat(2),
  "N".repeat(6),
  "O".repeat(8),
  "P".repeat(2),
  "Q",
  "R".repeat(6),
  "S".repeat(4),
  "T".repeat(6),
  "U".repeat(4),
  "V".repeat(2),
  "W".repeat(2),
  "X",
  "Y".repeat(2),
  "Z",
  "??",
].join("");
const TILE_KEYBOARD = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ?", "⌫"];
const EMPTY_RACK = "";
type LexiconId = "nwl23" | "csw24";

type LexiconDetails = {
  displayName: string;
  copyright: string;
  deepAnalysis: boolean;
};

const LEXICON_DETAILS: Record<LexiconId, LexiconDetails> = {
  nwl23: {
    displayName: "NWL2023",
    copyright: NWL_COPYRIGHT_NOTICE,
    deepAnalysis: true,
  },
  csw24: {
    displayName: "CSW24",
    copyright:
      "Collins Offical Scrabble™ Wordlist 2024, Published under license with Collins, an imprint of HarperCollins Publishers Limited",
    deepAnalysis: false,
  },
};

const MAX_IMPORT_BYTES = 256 * 1024;
type SessionStateDraft = {
  position: {
    board: {
      id: string;
      cells: Array<{
        row: number;
        col: number;
        letter: string;
        blank: boolean;
      }>;
    };
    rack: string;
    scores: { onTurn: number; opponent: number };
    turn: { number: number; scorelessTurns: number };
    unseen: { mode: string };
  };
  history: GcgHistoryEntry[];
  lexiconId: LexiconId;
  boardId: string;
  analysisPreferences: { candidateLimit: number; budgetMs: number };
  metadata?: {
    format?: "gcg";
    title?: string;
    description?: string;
    players?: GcgPlayer[];
    finalPlayer?: string;
    lexiconHint?: string | null;
    sourceSha256?: string;
    sourceEncoding?: string;
    sourceUrl?: string;
    importedAt?: string;
    forkedFrom?: { sourceSessionId: string; sourceRevision: number };
  };
};

type PositionExport = {
  format: "quackle-web.position";
  formatVersion: 1;
  exportedAt: string;
  lexicon: {
    id: LexiconId;
    displayName: string;
    copyright: string;
  };
  state: SessionStateDraft;
};

const DEFAULT_SESSION_STATE: SessionStateDraft = {
  position: {
    board: { id: "classic15", cells: [] },
    rack: EMPTY_RACK,
    scores: { onTurn: 0, opponent: 0 },
    turn: { number: 1, scorelessTurns: 0 },
    unseen: { mode: "derive" },
  },
  history: [],
  lexiconId: "nwl23",
  boardId: "classic15",
  analysisPreferences: { candidateLimit: 20, budgetMs: 2000 },
};

function randomOpeningRack(): string {
  const bag = [...ENGLISH_TILE_BAG];
  let rack = "";
  const random = new Uint32Array(7);
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.getRandomValues === "function"
  )
    crypto.getRandomValues(random);
  for (let index = 0; index < 7; index += 1) {
    const source = random[index] ?? Math.floor(Math.random() * 0xffffffff);
    const chosen = source % bag.length;
    rack += bag.splice(chosen, 1)[0];
  }
  return rack;
}

function freshPositionState(rack = EMPTY_RACK): SessionStateDraft {
  return stateForCells(
    {},
    {
      ...DEFAULT_SESSION_STATE,
      position: { ...DEFAULT_SESSION_STATE.position, rack },
      history: [],
      metadata: undefined,
    },
  );
}

function formatScenarioTime(timestamp = new Date().toISOString()): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

const positionFor = (index: number) =>
  `${String.fromCharCode(65 + (index % SIZE))}${Math.floor(index / SIZE) + 1}`;

function previewCellsForMove(
  base: Record<number, Cell>,
  move: Move,
): Record<number, Cell> {
  if (move.action !== "place") return base;
  let row = move.row;
  let col = move.col;
  if (row === undefined || col === undefined) {
    const match = move.position?.match(/^(\d{1,2})([A-O])$/i);
    if (!match) return base;
    row = Number(match[1]) - 1;
    col = match[2].toUpperCase().charCodeAt(0) - 65;
  }
  if (
    !Number.isInteger(row) ||
    !Number.isInteger(col) ||
    row < 0 ||
    row >= SIZE ||
    col < 0 ||
    col >= SIZE
  )
    return base;
  const tiles = move.tiles ?? move.word;
  if (!tiles) return base;
  const result = { ...base };
  const horizontal = move.horizontal !== false;
  [...tiles].forEach((token, offset) => {
    if (token === ".") return;
    const targetRow = row! + (horizontal ? 0 : offset);
    const targetCol = col! + (horizontal ? offset : 0);
    if (
      targetRow < 0 ||
      targetRow >= SIZE ||
      targetCol < 0 ||
      targetCol >= SIZE
    )
      return;
    const letter = token.toUpperCase();
    if (!/^[A-Z]$/.test(letter)) return;
    const index = targetRow * SIZE + targetCol;
    if (!result[index]) result[index] = { letter, blank: token !== letter };
  });
  return result;
}

function stateForCells(
  cells: Record<number, Cell>,
  base: SessionStateDraft = DEFAULT_SESSION_STATE,
): SessionStateDraft {
  return {
    ...base,
    position: {
      ...base.position,
      board: {
        id: "classic15",
        cells: Object.entries(cells).map(([index, cell]) => ({
          row: Math.floor(Number(index) / SIZE),
          col: Number(index) % SIZE,
          letter: cell.letter,
          blank: cell.blank ?? false,
        })),
      },
    },
  };
}

function isLegacyFixtureScenario(scenario: ScenarioRecord): boolean {
  if (scenario.kind !== "new" || scenario.title !== "New position")
    return false;
  const state = draftStateFromUnknown(scenario.state);
  return (
    state.position.rack === "ADEIRST" &&
    state.position.board.cells.length === 0 &&
    state.history.length === 0 &&
    !state.metadata
  );
}

function scenarioKindLabel(kind: ScenarioKind): string {
  if (kind === "imported") return "Imported";
  if (kind === "forked") return "Forked";
  return "New position";
}

function scenarioTileCount(state: unknown): number {
  return Object.keys(cellsFromState(state)).length;
}

function scenarioTimeLabel(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "recently";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function replayEventLabel(event: GcgHistoryEntry): string {
  if (event.kind === "place")
    return `${event.player} · ${event.tiles} · ${event.computedScore ?? event.score ?? 0} points`;
  if (event.kind === "pass") return `${event.player} · pass`;
  if (event.kind === "exchange") return `${event.player} · exchange`;
  if (event.kind === "challenge")
    return `${event.player} · ${event.challengeKind === "phony" ? "phony challenge" : `score adjustment ${event.adjustment ?? 0}`}`;
  if (event.kind === "time")
    return `${event.player} · time adjustment ${event.score ?? 0}`;
  return `${event.player} · end bonus ${event.score ?? 0}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readShareFragment(): {
  sourceSessionId: string;
  token: string;
} | null {
  const match = window.location.hash.match(
    /^#\/share\/([A-Za-z0-9_-]{20,128})\/([A-Za-z0-9_-]{32,256})$/,
  );
  return match ? { sourceSessionId: match[1], token: match[2] } : null;
}

function importedCellsFromState(state: unknown): Record<number, Cell> | null {
  if (
    !isObject(state) ||
    !isObject(state.position) ||
    !isObject(state.position.board)
  )
    return null;
  const board = state.position.board;
  if (
    board.id !== "classic15" ||
    !Array.isArray(board.cells) ||
    board.cells.length > SIZE * SIZE
  )
    return null;
  if (
    typeof state.position.rack !== "string" ||
    !/^[A-Z?]{0,7}$/.test(state.position.rack)
  )
    return null;
  const result: Record<number, Cell> = {};
  const coordinates = new Set<string>();
  for (const value of board.cells) {
    if (!isObject(value)) return null;
    const row = value.row;
    const col = value.col;
    if (
      typeof row !== "number" ||
      typeof col !== "number" ||
      !Number.isInteger(row) ||
      !Number.isInteger(col) ||
      row < 0 ||
      row >= SIZE ||
      col < 0 ||
      col >= SIZE
    )
      return null;
    if (
      typeof value.letter !== "string" ||
      !/^[A-Z]$/.test(value.letter) ||
      typeof value.blank !== "boolean"
    )
      return null;
    const coordinate = `${row}:${col}`;
    if (coordinates.has(coordinate)) return null;
    coordinates.add(coordinate);
    result[row * SIZE + col] = { letter: value.letter, blank: value.blank };
  }
  return result;
}

function cellsFromState(state: unknown): Record<number, Cell> {
  if (!state || typeof state !== "object") return {};
  const position = (state as { position?: unknown }).position;
  if (!position || typeof position !== "object") return {};
  const board = (position as { board?: unknown }).board;
  if (!board || typeof board !== "object") return {};
  const cells = (board as { cells?: unknown }).cells;
  if (!Array.isArray(cells)) return {};
  const result: Record<number, Cell> = {};
  for (const value of cells) {
    if (!value || typeof value !== "object") continue;
    const cell = value as {
      row?: unknown;
      col?: unknown;
      letter?: unknown;
      blank?: unknown;
    };
    const row = typeof cell.row === "number" ? cell.row : null;
    const col = typeof cell.col === "number" ? cell.col : null;
    if (
      row === null ||
      col === null ||
      !Number.isInteger(row) ||
      !Number.isInteger(col) ||
      typeof cell.letter !== "string"
    )
      continue;
    if (row < 0 || row >= SIZE || col < 0 || col >= SIZE) continue;
    result[row * SIZE + col] = {
      letter: cell.letter,
      blank: cell.blank === true,
    };
  }
  return result;
}

function historyFromState(value: unknown): GcgHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is GcgHistoryEntry => {
    return (
      isObject(entry) &&
      typeof entry.kind === "string" &&
      typeof entry.player === "string" &&
      typeof entry.rack === "string"
    );
  });
}

function playersFromState(value: unknown): GcgPlayer[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const players = value.filter((player): player is GcgPlayer => {
    return (
      isObject(player) &&
      typeof player.id === "number" &&
      Number.isInteger(player.id) &&
      typeof player.abbreviation === "string" &&
      typeof player.name === "string"
    );
  });
  return players.length > 0 ? players : undefined;
}

function lexiconIdFromUnknown(value: unknown): LexiconId {
  if (value === undefined) return "nwl23";
  if (value === "nwl23" || value === "csw24") return value;
  throw new Error("unsupported_lexicon");
}

function draftStateFromUnknown(value: unknown): SessionStateDraft {
  if (!isObject(value)) return stateForCells({});
  const position = isObject(value.position) ? value.position : {};
  const scores = isObject(position.scores) ? position.scores : {};
  const turn = isObject(position.turn) ? position.turn : {};
  const metadata = isObject(value.metadata) ? value.metadata : {};
  const lexiconId = lexiconIdFromUnknown(value.lexiconId);
  const forkedFrom =
    isObject(metadata.forkedFrom) &&
    typeof metadata.forkedFrom.sourceSessionId === "string" &&
    typeof metadata.forkedFrom.sourceRevision === "number" &&
    Number.isInteger(metadata.forkedFrom.sourceRevision)
      ? {
          sourceSessionId: metadata.forkedFrom.sourceSessionId,
          sourceRevision: metadata.forkedFrom.sourceRevision,
        }
      : undefined;
  const hasScenarioMetadata =
    metadata.format === "gcg" || forkedFrom !== undefined;
  const base: SessionStateDraft = {
    ...DEFAULT_SESSION_STATE,
    position: {
      ...DEFAULT_SESSION_STATE.position,
      rack:
        typeof position.rack === "string" && /^[A-Z?]{0,7}$/.test(position.rack)
          ? position.rack
          : EMPTY_RACK,
      scores: {
        onTurn:
          typeof scores.onTurn === "number" &&
          Number.isInteger(scores.onTurn) &&
          scores.onTurn >= 0
            ? scores.onTurn
            : 0,
        opponent:
          typeof scores.opponent === "number" &&
          Number.isInteger(scores.opponent) &&
          scores.opponent >= 0
            ? scores.opponent
            : 0,
      },
      turn: {
        number:
          typeof turn.number === "number" &&
          Number.isInteger(turn.number) &&
          turn.number >= 1
            ? turn.number
            : 1,
        scorelessTurns:
          typeof turn.scorelessTurns === "number" &&
          Number.isInteger(turn.scorelessTurns) &&
          turn.scorelessTurns >= 0
            ? turn.scorelessTurns
            : 0,
      },
    },
    history: historyFromState(value.history),
    lexiconId,
    metadata: hasScenarioMetadata
      ? {
          ...(metadata.format === "gcg" ? { format: "gcg" as const } : {}),
          title:
            typeof metadata.title === "string" ? metadata.title : undefined,
          description:
            typeof metadata.description === "string"
              ? metadata.description
              : undefined,
          players: playersFromState(metadata.players),
          finalPlayer:
            typeof metadata.finalPlayer === "string"
              ? metadata.finalPlayer
              : undefined,
          lexiconHint:
            typeof metadata.lexiconHint === "string"
              ? metadata.lexiconHint
              : null,
          sourceSha256:
            typeof metadata.sourceSha256 === "string"
              ? metadata.sourceSha256
              : undefined,
          sourceEncoding:
            typeof metadata.sourceEncoding === "string"
              ? metadata.sourceEncoding
              : undefined,
          sourceUrl:
            typeof metadata.sourceUrl === "string"
              ? metadata.sourceUrl
              : undefined,
          importedAt:
            typeof metadata.importedAt === "string"
              ? metadata.importedAt
              : undefined,
          forkedFrom,
        }
      : undefined,
  };
  return stateForCells(cellsFromState(value), base);
}
async function readBoundedResponse(
  response: Response,
  maximum: number,
): Promise<ArrayBuffer> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > maximum
  )
    throw new Error("response_too_large");
  if (!response.body) {
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > maximum) throw new Error("response_too_large");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new Error("response_too_large");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

function App() {
  const [draftState, setDraftState] = useState<SessionStateDraft>(
    DEFAULT_SESSION_STATE,
  );
  const [selectedRackIndex, setSelectedRackIndex] = useState<number | null>(
    null,
  );
  const [selectedPaletteTile, setSelectedPaletteTile] = useState<string | null>(
    null,
  );
  const [moves, setMoves] = useState<Move[]>([]);
  const [selectedMoveIndex, setSelectedMoveIndex] = useState<number | null>(
    null,
  );
  const [status, setStatus] = useState("Restoring session…");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [aboutMeta, setAboutMeta] = useState<Record<string, unknown> | null>(
    null,
  );
  const [analyzing, setAnalyzing] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [sessionReady, setSessionReady] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("connecting");
  const [analysisPhase, setAnalysisPhase] = useState<AnalysisPhase>("idle");
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>("fast");
  const [retryAvailable, setRetryAvailable] = useState(false);
  const [scenarioList, setScenarioList] = useState<ScenarioRecord[]>([]);
  const [activeLocalId, setActiveLocalId] = useState<string | null>(null);
  const [scenarioDirty, setScenarioDirty] = useState(false);
  const [scenariosOpen, setScenariosOpen] = useState(false);
  const [scenarioBusy, setScenarioBusy] = useState(false);
  const [replayIndex, setReplayIndex] = useState<number | null>(null);
  const [entryMode, setEntryMode] = useState<"tap" | "type">("tap");
  const [rackEditMode, setRackEditMode] = useState(false);
  const [boardDirection, setBoardDirection] = useState<
    "horizontal" | "vertical"
  >("horizontal");
  const [activeCellIndex, setActiveCellIndex] = useState(112);
  const [blankPickerIndex, setBlankPickerIndex] = useState<number | null>(null);
  const [movesOpen, setMovesOpen] = useState(true);
  const activeCellRef = useRef<HTMLButtonElement | null>(null);
  const dragRef = useRef<{
    letter: string;
    rackIndex: number;
    pointerId: number;
    startX: number;
    startY: number;
    active: boolean;
    targetIndex: number | null;
  }>({
    letter: "",
    rackIndex: -1,
    pointerId: -1,
    startX: 0,
    startY: 0,
    active: false,
    targetIndex: null,
  });
  const suppressRackClickRef = useRef(false);
  const [crossTablesUrl, setCrossTablesUrl] = useState("");
  const [crossTablesBusy, setCrossTablesBusy] = useState(false);
  const [shareLinks, setShareLinks] = useState<ShareLink[]>([]);
  const [shareNotices, setShareNotices] = useState<ShareLinkNotice[]>([]);
  const [shareLinksLoading, setShareLinksLoading] = useState(false);
  const [shareLinkAction, setShareLinkAction] = useState<string | null>(null);
  const [shareNoticeAction, setShareNoticeAction] = useState<string | null>(
    null,
  );
  const activeJobIdRef = useRef<string | null>(null);
  const analysisAbortRef = useRef<AbortController | null>(null);
  const analysisCancelledRef = useRef(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const importGcgInputRef = useRef<HTMLInputElement>(null);

  const cells = useMemo(() => cellsFromState(draftState), [draftState]);
  const rack = draftState.position.rack;
  const selectedTile =
    selectedRackIndex === null
      ? selectedPaletteTile
      : (rack[selectedRackIndex] ?? null);
  const boardCells = useMemo(
    () => Array.from({ length: SIZE * SIZE }, (_, index) => index),
    [],
  );
  const replayFrames = useMemo(() => {
    if (
      draftState.metadata?.format !== "gcg" ||
      !draftState.metadata.players ||
      draftState.history.length === 0
    )
      return [];
    try {
      return replayGcgHistory(draftState.metadata.players, draftState.history);
    } catch {
      return [];
    }
  }, [
    draftState.history,
    draftState.metadata?.format,
    draftState.metadata?.players,
  ]);
  const activeReplayIndex =
    replayIndex === null || replayFrames.length === 0
      ? null
      : Math.min(replayIndex, replayFrames.length - 1);
  const replayFrame =
    activeReplayIndex === null ? null : replayFrames[activeReplayIndex];
  const isReplaying = replayFrame !== null;
  const visibleCells = useMemo(
    () =>
      replayFrame
        ? Object.fromEntries(
            replayFrame.board.map((cell) => [
              cell.row * SIZE + cell.col,
              { letter: cell.letter, blank: cell.blank },
            ]),
          )
        : cells,
    [cells, replayFrame],
  );
  const previewCells = useMemo(() => {
    if (isReplaying || selectedMoveIndex === null || !moves[selectedMoveIndex])
      return visibleCells;
    return previewCellsForMove(visibleCells, moves[selectedMoveIndex]);
  }, [isReplaying, moves, selectedMoveIndex, visibleCells]);
  const visibleFilledCount = Object.keys(visibleCells).length;
  const visibleScores = useMemo(() => {
    if (!replayFrame) return draftState.position.scores;
    const current = replayFrame.currentPlayer;
    const opponent = draftState.metadata?.players?.find(
      (player) => player.abbreviation !== current,
    )?.abbreviation;
    return {
      onTurn: current ? (replayFrame.scores[current] ?? 0) : 0,
      opponent: opponent ? (replayFrame.scores[opponent] ?? 0) : 0,
    };
  }, [draftState.metadata?.players, draftState.position.scores, replayFrame]);
  const visibleTurn = replayFrame?.turn ?? draftState.position.turn;

  useEffect(() => {
    let cancelled = false;
    setConnectionState("connecting");
    setSessionReady(false);
    setStatus(
      sessionAttempt === 0 ? "Starting session…" : "Reconnecting session…",
    );
    void (async () => {
      let scenario: ScenarioRecord | null = null;
      const share = readShareFragment();
      if (share) {
        try {
          const response = await fetch(apiUrl("/api/v1/shares/redeem"), {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(share),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = (await response.json()) as SessionResponse;
          const sharedState = draftStateFromUnknown(data.session.state);
          const timestamp = new Date().toISOString();
          scenario = {
            schemaVersion: 1,
            localId: newScenarioId(),
            sessionId: data.session.id,
            kind: "forked",
            title: sharedState.metadata?.title
              ? `Forked · ${sharedState.metadata.title}`
              : "Forked shared scenario",
            state: sharedState,
            revision: data.session.revision,
            dirty: false,
            createdAt: timestamp,
            savedAt: timestamp,
            lastOpenedAt: timestamp,
            source: {
              kind: "forked",
              sourceSessionId: share.sourceSessionId,
              ...(sharedState.metadata?.forkedFrom?.sourceRevision !== undefined
                ? {
                    sourceRevision:
                      sharedState.metadata.forkedFrom.sourceRevision,
                  }
                : {}),
            },
          };
          await saveScenario(scenario).catch(() => undefined);
          await setActiveScenario(scenario.localId).catch(() => undefined);
          window.history.replaceState(
            null,
            "",
            `${window.location.pathname}${window.location.search}`,
          );
        } catch {
          setStatus("Share link unavailable · opening the last local scenario");
        }
      }
      if (!scenario) scenario = await loadActiveScenario().catch(() => null);
      if (scenario && isLegacyFixtureScenario(scenario)) {
        const timestamp = new Date().toISOString();
        scenario = {
          ...scenario,
          sessionId: null,
          title: `New game · ${formatScenarioTime(timestamp)}`,
          state: freshPositionState(randomOpeningRack()),
          revision: 0,
          dirty: true,
          savedAt: timestamp,
          lastOpenedAt: timestamp,
        };
        await saveScenario(scenario).catch(() => undefined);
      }
      if (!scenario) {
        const timestamp = new Date().toISOString();
        scenario = {
          schemaVersion: 1,
          localId: newScenarioId(),
          sessionId: null,
          kind: "new",
          title: `New game · ${formatScenarioTime(timestamp)}`,
          state: freshPositionState(randomOpeningRack()),
          revision: 0,
          dirty: true,
          createdAt: timestamp,
          savedAt: timestamp,
          lastOpenedAt: timestamp,
          source: { kind: "new" },
        };
        await saveScenario(scenario).catch(() => undefined);
      }
      if (cancelled) return;

      const localState = draftStateFromUnknown(scenario.state);
      setActiveLocalId(scenario.localId);
      setDraftState(localState);
      setSessionId(scenario.sessionId);
      setRevision(scenario.revision);
      setScenarioDirty(scenario.dirty);
      setScenarioList(await listScenarios().catch(() => [scenario]));

      try {
        let response: Response;
        let sessionWasRecreated = false;
        if (scenario.sessionId) {
          response = await fetch(
            apiUrl(`/api/v1/sessions/${scenario.sessionId}`),
            { credentials: "include" },
          );
          if (response.status === 404) {
            response = await fetch(apiUrl("/api/v1/sessions"), {
              method: "POST",
              credentials: "include",
            });
            sessionWasRecreated = true;
          }
        } else {
          response = await fetch(apiUrl("/api/v1/sessions"), {
            method: "POST",
            credentials: "include",
          });
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        let data = (await response.json()) as SessionResponse;
        let restoredState = localState;
        let nextState = localState;
        let nextRevision = data.session.revision;
        let nextDirty = scenario.dirty;

        if (!scenario.sessionId || sessionWasRecreated) {
          setSessionId(data.session.id);
          const update = await fetch(
            apiUrl(`/api/v1/sessions/${data.session.id}`),
            {
              method: "PUT",
              credentials: "include",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                expectedRevision: data.session.revision,
                state: localState,
              }),
            },
          );
          if (!update.ok) throw new Error(`HTTP ${update.status}`);
          data = (await update.json()) as SessionResponse;
          nextRevision = data.session.revision;
          nextState = draftStateFromUnknown(data.session.state);
          restoredState = nextState;
          nextDirty = false;
        } else if (!scenario.dirty) {
          restoredState = draftStateFromUnknown(data.session.state);
          nextState = restoredState;
          nextDirty = false;
        } else if (scenario.revision !== data.session.revision) {
          setStatus("Session changed · local copy preserved");
        }

        if (cancelled) return;
        setDraftState(restoredState);
        setSessionId(data.session.id);
        setRevision(nextRevision);
        setScenarioDirty(nextDirty);
        setSessionReady(true);
        setConnectionState("online");
        if (sessionWasRecreated) {
          setStatus("Session restored from local copy");
        } else if (
          scenario.dirty &&
          scenario.sessionId &&
          scenario.revision !== data.session.revision
        ) {
          setStatus("Session changed · local copy preserved");
        } else {
          setStatus(nextDirty ? "Recovered local draft" : "Session ready");
        }
        const updatedScenario: ScenarioRecord = {
          ...scenario,
          sessionId: data.session.id,
          state: nextState,
          revision: nextRevision,
          dirty: nextDirty,
          savedAt: new Date().toISOString(),
          lastOpenedAt: new Date().toISOString(),
        };
        await saveScenario(updatedScenario).catch(() => undefined);
        setScenarioList(await listScenarios().catch(() => [updatedScenario]));
      } catch (error) {
        if (cancelled) return;
        setSessionReady(false);
        setConnectionState("offline");
        setDraftState(localState);
        setSessionId(scenario.sessionId);
        setRevision(scenario.revision);
        if (error instanceof Error && error.message === "session_unavailable") {
          setStatus("Session unavailable · local copy preserved");
        } else if (scenario.sessionId) {
          setStatus("Offline draft recovered · reconnect to analyze");
        } else {
          setStatus("Offline · draft saved locally");
        }
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionAttempt]);

  useEffect(() => {
    const handleOnline = () => {
      if (!sessionReady) {
        setConnectionState("connecting");
        setSessionAttempt((attempt) => attempt + 1);
      }
    };
    const handleOffline = () => {
      setConnectionState("offline");
      setSessionReady(false);
      if (!analyzing) setStatus("Offline · draft saved locally");
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [analyzing, sessionReady]);

  useEffect(() => {
    if (!hydrated || !activeLocalId) return;
    void getScenario(activeLocalId)
      .then((existing) => {
        if (!existing) return;
        return saveScenario({
          ...existing,
          sessionId,
          revision,
          state: draftState,
          dirty: scenarioDirty,
          savedAt: new Date().toISOString(),
          lastOpenedAt: new Date().toISOString(),
        }).then(() => listScenarios().then(setScenarioList));
      })
      .catch(() => undefined);
  }, [activeLocalId, draftState, hydrated, revision, scenarioDirty, sessionId]);

  const startReplay = () => {
    if (replayFrames.length === 0) return;
    setSelectedRackIndex(null);
    setReplayIndex(0);
    setStatus("Replay started · read-only history");
  };

  const setReplayCursor = (index: number) => {
    if (replayFrames.length === 0) return;
    setSelectedRackIndex(null);
    setReplayIndex(Math.max(0, Math.min(index, replayFrames.length - 1)));
  };

  const returnToFinal = () => {
    setReplayIndex(null);
    setStatus("Returned to final position");
  };

  const clearAnalysisResults = () => {
    setMoves([]);
    setSelectedMoveIndex(null);
    setRetryAvailable(false);
  };

  const markPositionEdited = (
    message: string,
    update: (previous: SessionStateDraft) => SessionStateDraft,
  ) => {
    if (isReplaying) return;
    setDraftState((previous) => {
      const next = update(previous);
      if (previous.metadata?.format === "gcg" && previous.history.length > 0) {
        next.history = [];
        next.metadata = {
          ...next.metadata,
          format: undefined,
          players: undefined,
          finalPlayer: undefined,
          description:
            "Edited from an imported game; replay history was cleared.",
        };
      }
      return next;
    });
    setScenarioDirty(true);
    clearAnalysisResults();
    setStatus(message);
  };

  const writeBoardTile = (
    index: number,
    letter: string,
    blank = false,
    advance = false,
  ) => {
    if (isReplaying || index < 0 || index >= SIZE * SIZE) return;
    markPositionEdited(
      `Placed ${blank ? `${letter} as a blank` : letter} at ${positionFor(index)}`,
      (previous) => {
        const next = {
          ...cellsFromState(previous),
          [index]: { letter, blank },
        };
        return stateForCells(next, previous);
      },
    );
    setActiveCellIndex(index);
    if (advance) {
      const row = Math.floor(index / SIZE);
      const col = index % SIZE;
      const nextIndex =
        boardDirection === "horizontal"
          ? col < SIZE - 1
            ? index + 1
            : index
          : row < SIZE - 1
            ? index + SIZE
            : index;
      setActiveCellIndex(nextIndex);
    }
  };

  const clearBoardTile = (index: number) => {
    if (!cells[index]) return;
    markPositionEdited(`Cleared ${positionFor(index)}`, (previous) => {
      const next = { ...cellsFromState(previous) };
      delete next[index];
      return stateForCells(next, previous);
    });
  };

  const placeTile = (index: number, explicitTile?: string) => {
    if (isReplaying) return;
    setActiveCellIndex(index);
    const tile = explicitTile ?? selectedTile;
    if (!tile) {
      clearBoardTile(index);
      return;
    }
    if (tile === "?") {
      setBlankPickerIndex(index);
      return;
    }
    writeBoardTile(index, tile, false, false);
    setSelectedRackIndex(null);
    setSelectedPaletteTile(null);
  };

  const handleBoardKeyDown = (event: KeyboardEvent, index: number) => {
    if (isReplaying) return;
    const key = event.key.toUpperCase();
    if (/^[A-Z]$/.test(key)) {
      event.preventDefault();
      writeBoardTile(index, key, false, true);
      return;
    }
    if (event.key === "?") {
      event.preventDefault();
      setActiveCellIndex(index);
      setBlankPickerIndex(index);
      return;
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      clearBoardTile(index);
      return;
    }
    if (event.key === " ") {
      event.preventDefault();
      setBoardDirection((direction) =>
        direction === "horizontal" ? "vertical" : "horizontal",
      );
      return;
    }
    const movements: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -SIZE,
      ArrowDown: SIZE,
    };
    const delta = movements[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    const row = Math.floor(index / SIZE);
    const col = index % SIZE;
    const nextRow =
      row + (event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0);
    const nextCol =
      col +
      (event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0);
    if (nextRow >= 0 && nextRow < SIZE && nextCol >= 0 && nextCol < SIZE)
      setActiveCellIndex(nextRow * SIZE + nextCol);
  };

  const addRackTile = (letter: string) => {
    if (isReplaying || rack.length >= 7) return;
    markPositionEdited(
      `Added ${letter === "?" ? "a blank" : letter} to the rack`,
      (previous) => ({
        ...previous,
        position: {
          ...previous.position,
          rack: `${previous.position.rack}${letter}`,
        },
      }),
    );
  };

  const removeRackTile = (index: number) => {
    if (isReplaying) return;
    markPositionEdited("Removed a tile from the rack", (previous) => ({
      ...previous,
      position: {
        ...previous.position,
        rack: [...previous.position.rack]
          .filter((_, tileIndex) => tileIndex !== index)
          .join(""),
      },
    }));
    setSelectedRackIndex(null);
  };

  const shuffleRack = () => {
    if (isReplaying || rack.length < 2) return;
    const letters = [...rack];
    for (let index = letters.length - 1; index > 0; index -= 1) {
      const random =
        typeof crypto !== "undefined" &&
        typeof crypto.getRandomValues === "function"
          ? crypto.getRandomValues(new Uint32Array(1))[0]
          : Math.floor(Math.random() * 0xffffffff);
      const swapIndex = random % (index + 1);
      [letters[index], letters[swapIndex]] = [
        letters[swapIndex],
        letters[index],
      ];
    }
    markPositionEdited("Rack shuffled", (previous) => ({
      ...previous,
      position: { ...previous.position, rack: letters.join("") },
    }));
    setSelectedRackIndex(null);
  };

  const handleTileKeyboard = (letter: string) => {
    if (rackEditMode) {
      if (letter === "⌫") {
        if (rack.length > 0) removeRackTile(rack.length - 1);
        return;
      }
      addRackTile(letter);
      return;
    }
    if (letter === "⌫") {
      clearBoardTile(activeCellIndex);
      return;
    }
    if (entryMode === "type") {
      if (letter === "?") setBlankPickerIndex(activeCellIndex);
      else writeBoardTile(activeCellIndex, letter, false, true);
      return;
    }
    setSelectedRackIndex(null);
    setSelectedPaletteTile(letter);
    setStatus(
      `Selected ${letter === "?" ? "blank" : letter} · tap a board square`,
    );
  };

  const chooseBlankLetter = (letter: string) => {
    if (blankPickerIndex === null) return;
    writeBoardTile(blankPickerIndex, letter, true, entryMode === "type");
    setBlankPickerIndex(null);
    setSelectedRackIndex(null);
    setSelectedPaletteTile(null);
  };

  const beginRackDrag = (
    event: PointerEvent,
    rackIndex: number,
    letter: string,
  ) => {
    if (isReplaying || rackEditMode) return;
    dragRef.current = {
      letter,
      rackIndex,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      targetIndex: null,
    };
  };
  useEffect(() => {
    activeCellRef.current?.focus();
  }, [activeCellIndex]);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (drag.pointerId !== event.pointerId) return;
      if (
        !drag.active &&
        Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >=
          7
      )
        drag.active = true;
      if (!drag.active) return;
      const target = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-board-cell-index]");
      drag.targetIndex = target ? Number(target.dataset.boardCellIndex) : null;
      event.preventDefault();
    };
    const onPointerUp = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (drag.pointerId !== event.pointerId) return;
      if (drag.active && drag.targetIndex !== null) {
        suppressRackClickRef.current = true;
        placeTile(drag.targetIndex, drag.letter);
        window.setTimeout(() => {
          suppressRackClickRef.current = false;
        }, 0);
      }
      dragRef.current = {
        letter: "",
        rackIndex: -1,
        pointerId: -1,
        startX: 0,
        startY: 0,
        active: false,
        targetIndex: null,
      };
    };
    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, [
    isReplaying,
    rackEditMode,
    selectedTile,
    activeCellIndex,
    cells,
    entryMode,
    boardDirection,
  ]);

  const persistSession = async (): Promise<number | null> => {
    if (!sessionId) return null;
    const response = await fetch(apiUrl(`/api/v1/sessions/${sessionId}`), {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: revision, state: draftState }),
    });
    if (response.status === 409) {
      setStatus("Session changed in another tab");
      return null;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as SessionResponse;
    setRevision(data.session.revision);
    setSessionReady(true);
    setConnectionState("online");
    setScenarioDirty(false);
    return data.session.revision;
  };

  const reconnectSession = () => {
    setSessionReady(false);
    setConnectionState("connecting");
    setStatus("Reconnecting session…");
    setSessionAttempt((attempt) => attempt + 1);
  };

  const stopAnalysisForScenarioSwitch = () => {
    const jobId = activeJobIdRef.current;
    if (jobId && sessionId) {
      void fetch(
        apiUrl(`/api/v1/sessions/${sessionId}/analysis/jobs/${jobId}`),
        {
          method: "DELETE",
          credentials: "include",
        },
      ).catch(() => undefined);
    }
    analysisCancelledRef.current = true;
    analysisAbortRef.current?.abort();
    activeJobIdRef.current = null;
    setAnalysisPhase("idle");
    setAnalyzing(false);
  };

  const activateScenario = async (scenario: ScenarioRecord) => {
    stopAnalysisForScenarioSwitch();
    setScenarioBusy(true);
    setStatus(`Opening ${scenario.title}…`);
    try {
      const opened: ScenarioRecord = {
        ...scenario,
        lastOpenedAt: new Date().toISOString(),
        savedAt: new Date().toISOString(),
      };
      await saveScenario(opened);
      await setActiveScenario(opened.localId);
      setActiveLocalId(opened.localId);
      setDraftState(draftStateFromUnknown(opened.state));
      setSessionId(opened.sessionId);
      setRevision(opened.revision);
      setScenarioDirty(opened.dirty);
      setReplayIndex(null);
      setSelectedRackIndex(null);
      setSelectedPaletteTile(null);
      setSelectedMoveIndex(null);
      setBlankPickerIndex(null);
      setMoves([]);
      setRetryAvailable(false);
      setScenariosOpen(false);
      setSessionAttempt((attempt) => attempt + 1);
      setScenarioList(await listScenarios());
    } finally {
      setScenarioBusy(false);
    }
  };

  const createScenario = async (
    kind: ScenarioKind,
    title: string,
    state: SessionStateDraft,
    source: ScenarioSource,
  ) => {
    const timestamp = new Date().toISOString();
    await activateScenario({
      schemaVersion: 1,
      localId: newScenarioId(),
      sessionId: null,
      kind,
      title,
      state,
      revision: 0,
      dirty:
        kind === "imported" ||
        kind === "forked" ||
        state.position.rack.length > 0 ||
        state.position.board.cells.length > 0,
      createdAt: timestamp,
      savedAt: timestamp,
      lastOpenedAt: timestamp,
      source,
    });
  };

  const createNewGame = () =>
    void createScenario(
      "new",
      `New game · ${formatScenarioTime()}`,
      freshPositionState(randomOpeningRack()),
      { kind: "new" },
    );
  const createBlankPosition = () =>
    void createScenario(
      "new",
      `Blank position · ${formatScenarioTime()}`,
      freshPositionState(),
      { kind: "new" },
    );

  const loadShareLinks = async () => {
    if (!sessionId || !sessionReady) return;
    setShareLinksLoading(true);
    try {
      const response = await fetch(
        apiUrl(`/api/v1/sessions/${sessionId}/share`),
        { credentials: "include" },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as {
        shares?: unknown;
        notices?: unknown;
      };
      const links = Array.isArray(data.shares)
        ? data.shares.flatMap((value): ShareLink[] => {
            if (
              !isObject(value) ||
              typeof value.shareId !== "string" ||
              typeof value.sourceRevision !== "number" ||
              typeof value.createdAt !== "string" ||
              (value.expiresAt !== null &&
                typeof value.expiresAt !== "string") ||
              typeof value.useCount !== "number" ||
              (value.lastUsedAt !== null &&
                typeof value.lastUsedAt !== "string")
            )
              return [];
            return [
              {
                shareId: value.shareId,
                sourceRevision: value.sourceRevision,
                createdAt: value.createdAt,
                expiresAt: value.expiresAt,
                useCount: value.useCount,
                lastUsedAt: value.lastUsedAt,
              },
            ];
          })
        : [];
      const notices = Array.isArray(data.notices)
        ? data.notices.flatMap((value): ShareLinkNotice[] => {
            if (
              !isObject(value) ||
              typeof value.shareId !== "string" ||
              typeof value.sourceRevision !== "number" ||
              typeof value.createdAt !== "string" ||
              typeof value.evictedAt !== "string" ||
              (value.reason !== "active_limit" &&
                value.reason !== "storage_limit")
            )
              return [];
            return [
              {
                shareId: value.shareId,
                sourceRevision: value.sourceRevision,
                createdAt: value.createdAt,
                evictedAt: value.evictedAt,
                reason: value.reason,
              },
            ];
          })
        : [];
      setShareLinks(links);
      setShareNotices(notices);
    } catch {
      setStatus("Shared links unavailable · retry");
    } finally {
      setShareLinksLoading(false);
    }
  };

  const openAbout = () => {
    setAboutOpen(true);
    if (aboutMeta) return;
    void fetch(apiUrl("/api/v1/meta"), { credentials: "include" })
      .then((response) =>
        response.ok
          ? (response.json() as Promise<Record<string, unknown>>)
          : Promise.reject(new Error("meta_unavailable")),
      )
      .then(setAboutMeta)
      .catch(() => setAboutMeta(null));
  };

  useEffect(() => {
    if (settingsOpen && sessionReady) void loadShareLinks();
  }, [settingsOpen, sessionId, sessionReady]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setBlankPickerIndex(null);
      setSettingsOpen(false);
      setScenariosOpen(false);
      setAboutOpen(false);
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, []);

  const revokeShareLink = async (shareId: string) => {
    if (!sessionId || !sessionReady) return;
    setShareLinkAction(shareId);
    try {
      const response = await fetch(
        apiUrl(`/api/v1/sessions/${sessionId}/share/${shareId}`),
        {
          method: "DELETE",
          credentials: "include",
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await loadShareLinks();
      setStatus("Share link revoked · existing forks remain independent");
    } catch {
      setStatus("Share link could not be revoked · retry");
    } finally {
      setShareLinkAction(null);
    }
  };

  const dismissShareNotice = async (shareId: string) => {
    if (!sessionId || !sessionReady) return;
    setShareNoticeAction(shareId);
    try {
      const response = await fetch(
        apiUrl(`/api/v1/sessions/${sessionId}/share-notices/${shareId}`),
        {
          method: "DELETE",
          credentials: "include",
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await loadShareLinks();
    } catch {
      setStatus("Share-link notice could not be dismissed · retry");
    } finally {
      setShareNoticeAction(null);
    }
  };

  const shareScenario = async () => {
    if (!sessionId || !sessionReady) {
      setStatus("Session unavailable · reconnect before sharing");
      return;
    }
    try {
      if (scenarioDirty) {
        const persistedRevision = await persistSession();
        if (persistedRevision === null) throw new Error("session_conflict");
      }
      const response = await fetch(
        apiUrl(`/api/v1/sessions/${sessionId}/share`),
        {
          method: "POST",
          credentials: "include",
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as {
        share?: {
          shareId?: unknown;
          sourceSessionId?: unknown;
          token?: unknown;
          expiresAt?: unknown;
          lifetime?: unknown;
        };
      };
      if (
        !data.share ||
        typeof data.share.shareId !== "string" ||
        typeof data.share.sourceSessionId !== "string" ||
        typeof data.share.token !== "string" ||
        data.share.expiresAt !== null ||
        data.share.lifetime !== "until_revoked"
      )
        throw new Error("invalid_share_response");
      const shareUrl = new URL(
        `/#/share/${data.share.sourceSessionId}/${data.share.token}`,
        window.location.origin,
      ).toString();
      let copied = true;
      try {
        await navigator.clipboard?.writeText(shareUrl);
      } catch {
        copied = false;
      }
      void loadShareLinks();
      setStatus(
        copied
          ? "Permanent share link copied · recipients get independent forks"
          : "Permanent share link created · clipboard unavailable",
      );
    } catch (error) {
      setStatus(
        error instanceof Error && error.message === "session_conflict"
          ? "Session changed · reconnect before sharing"
          : "Share link unavailable · retry",
      );
    }
  };

  const exportPosition = () => {
    const document: PositionExport = {
      format: "quackle-web.position",
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      lexicon: {
        id: draftState.lexiconId,
        displayName: LEXICON_DETAILS[draftState.lexiconId].displayName,
        copyright: LEXICON_DETAILS[draftState.lexiconId].copyright,
      },
      state: draftState,
    };
    const blob = new Blob([`${JSON.stringify(document, null, 2)}\n`], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement("a");
    anchor.href = url;
    anchor.download = `quackle-position-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setStatus("Position exported");
  };

  const exportGcgFile = () => {
    const metadata = draftState.metadata;
    const exported = exportGcg({
      players: metadata?.players,
      title: metadata?.title,
      description: metadata?.description,
      lexiconHint:
        metadata?.lexiconHint ??
        (draftState.lexiconId === "csw24" ? "CSW24" : "NWL23"),
      history: draftState.history,
      finalRack: draftState.position.rack,
      finalPlayer: metadata?.finalPlayer,
      board: Object.entries(cells).map(([index, cell]) => ({
        row: Math.floor(Number(index) / SIZE),
        col: Number(index) % SIZE,
        letter: cell.letter,
        blank: cell.blank === true,
      })),
    });
    const blob = new Blob([exported.text], {
      type: "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement("a");
    anchor.href = url;
    anchor.download = `quackle-game-${new Date().toISOString().slice(0, 10)}.gcg`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setStatus(
      exported.warnings.length > 0
        ? "GCG exported · use JSON for a lossless position snapshot"
        : "GCG exported",
    );
  };

  const importPosition = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new Error("file_too_large");
      const parsed = JSON.parse(await file.text()) as unknown;
      if (
        !isObject(parsed) ||
        parsed.format !== "quackle-web.position" ||
        parsed.formatVersion !== 1
      ) {
        throw new Error("unsupported_format");
      }
      const importedState = draftStateFromUnknown(parsed.state);
      const importedCells = importedCellsFromState(importedState);
      if (!importedCells) throw new Error("invalid_position");
      await createScenario(
        "imported",
        `Imported · ${file.name.slice(0, 48)}`,
        stateForCells(importedCells, importedState),
        {
          kind: "imported",
          format: "quackle-web.position",
          filename: file.name.slice(0, 128),
        },
      );
    } catch {
      setStatus("Import failed · choose a Quackle Web JSON export");
    }
  };

  const importGcgBytes = async (
    bytes: ArrayBuffer,
    filename: string,
    sourceUrl?: string,
  ): Promise<boolean> => {
    try {
      const decoded = decodeGcgBytes(bytes);
      const localParsed = parseGcg(decoded.text);
      const localLexiconResolution = resolveLexiconHint(
        localParsed.lexiconHint,
      );
      if (localLexiconResolution === "unsupported")
        throw new Error("unsupported_lexicon");
      const validationResponse = await fetch(apiUrl("/api/v1/imports/gcg"), {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: bytes,
      });
      if (!validationResponse.ok)
        throw new Error("server_gcg_validation_failed");
      const validation = (await validationResponse.json()) as {
        document?: unknown;
        sourceSha256?: unknown;
        encoding?: unknown;
        lexicon?: { id?: unknown; status?: unknown };
      };
      if (!isObject(validation) || !isObject(validation.document))
        throw new Error("server_gcg_validation_failed");
      const parsed = validation.document as unknown as GcgImportResult;
      const lexiconResolution = resolveLexiconHint(parsed.lexiconHint);
      if (lexiconResolution === "unsupported")
        throw new Error("unsupported_lexicon");
      const importedLexicon: LexiconId =
        lexiconResolution === "csw24" ? "csw24" : "nwl23";
      if (
        lexiconResolution === "missing" &&
        !window.confirm(
          "This GCG file does not identify a dictionary. Import it explicitly as NWL2023?",
        )
      ) {
        throw new Error("lexicon_not_confirmed");
      }
      if (parsed.finalRack.length > 7) throw new Error("rack_too_large");
      const importedAt = new Date().toISOString();
      const title =
        parsed.title.trim() || `Imported GCG · ${filename.slice(0, 40)}`;
      const state: SessionStateDraft = stateForCells(
        Object.fromEntries(
          parsed.board.map((cell) => [
            cell.row * SIZE + cell.col,
            { letter: cell.letter, blank: cell.blank },
          ]),
        ),
        {
          ...DEFAULT_SESSION_STATE,
          lexiconId: importedLexicon,
          position: {
            ...DEFAULT_SESSION_STATE.position,
            rack: parsed.finalRack,
            scores: parsed.scores,
            turn: parsed.turn,
          },
          history: parsed.history,
          metadata: {
            format: "gcg",
            title: parsed.title || undefined,
            description: parsed.description || undefined,
            players: parsed.players,
            finalPlayer: parsed.finalPlayer ?? undefined,
            lexiconHint: parsed.lexiconHint,
            sourceSha256:
              typeof validation.sourceSha256 === "string"
                ? validation.sourceSha256
                : undefined,
            sourceEncoding:
              typeof validation.encoding === "string"
                ? validation.encoding
                : decoded.encoding,
            sourceUrl,
            importedAt,
          },
        },
      );
      await createScenario("imported", title, state, {
        kind: "imported",
        format: "gcg",
        filename: filename.slice(0, 128),
        ...(sourceUrl ? { sourceUrl } : {}),
      });
      setStatus(
        parsed.warnings.length > 0
          ? `Imported GCG · ${parsed.warnings[0]}`
          : `Imported GCG · ${typeof validation.encoding === "string" ? validation.encoding : decoded.encoding}`,
      );
      return true;
    } catch (error) {
      if (error instanceof Error && error.message === "unsupported_lexicon") {
        setStatus("GCG import blocked · dictionary is not enabled");
      } else if (
        error instanceof Error &&
        error.message === "lexicon_not_confirmed"
      ) {
        setStatus("GCG import cancelled · dictionary mapping required");
      } else {
        setStatus("GCG import failed · check the file and dictionary identity");
      }
      return false;
    }
  };

  const importGcg = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      setStatus("GCG import failed · file exceeds the 256 KiB limit");
      return;
    }
    await importGcgBytes(await file.arrayBuffer(), file.name);
  };

  const openCrossTablesLink = () => {
    try {
      const link = parseCrossTablesUrl(crossTablesUrl);
      window.open(link.url, "_blank", "noopener,noreferrer");
      setStatus(`Opened Cross-Tables game ${link.gameId}`);
    } catch (error) {
      setStatus(
        error instanceof Error
          ? `Cross-Tables link rejected · ${error.message}`
          : "Cross-Tables link rejected",
      );
    }
  };

  const importCrossTables = async () => {
    let link: { url: string; gameId: number };
    try {
      link = parseCrossTablesUrl(crossTablesUrl);
    } catch (error) {
      setStatus(
        error instanceof Error
          ? `Cross-Tables link rejected · ${error.message}`
          : "Cross-Tables link rejected",
      );
      return;
    }
    setCrossTablesBusy(true);
    try {
      const pageResponse = await fetch(link.url, {
        mode: "cors",
        credentials: "omit",
        redirect: "error",
      });
      if (!pageResponse.ok) throw new Error("page_unavailable");
      const pageBytes = await readBoundedResponse(
        pageResponse,
        MAX_IMPORT_BYTES,
      );
      const pageText = new TextDecoder("utf-8", { fatal: false }).decode(
        pageBytes,
      );
      const page = new DOMParser().parseFromString(pageText, "text/html");
      let gcgUrl: string | null = null;
      for (const anchor of [...page.querySelectorAll("a[href]")]) {
        try {
          const href = (anchor as HTMLAnchorElement).getAttribute("href");
          if (!href) continue;
          gcgUrl = parseCrossTablesGcgUrl(
            new URL(href, link.url).toString(),
            link.gameId,
          );
          break;
        } catch {
          // Ignore non-GCG links and continue through the bounded page.
        }
      }
      if (!gcgUrl) {
        const derived = `https://www.cross-tables.com/annotated/selfgcg/${Math.floor(link.gameId / 100)}/anno${link.gameId}.gcg`;
        try {
          gcgUrl = parseCrossTablesGcgUrl(derived, link.gameId);
        } catch {
          throw new Error("gcg_link_missing");
        }
      }
      const gcgResponse = await fetch(gcgUrl, {
        mode: "cors",
        credentials: "omit",
        redirect: "error",
      });
      if (!gcgResponse.ok) throw new Error("gcg_unavailable");
      const gcgBytes = await readBoundedResponse(gcgResponse, MAX_IMPORT_BYTES);
      const imported = await importGcgBytes(
        gcgBytes,
        `cross-tables-${link.gameId}.gcg`,
        link.url,
      );
      if (imported) setCrossTablesUrl("");
    } catch (error) {
      setStatus(
        `Cross-Tables fetch unavailable · ${error instanceof Error ? error.message : "browser fetch blocked"} · open the link, download .gcg, then use Import GCG`,
      );
    } finally {
      setCrossTablesBusy(false);
    }
  };

  const pollDeepJob = async (
    jobId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    for (;;) {
      const response = await fetch(
        apiUrl(`/api/v1/sessions/${sessionId}/analysis/jobs/${jobId}`),
        {
          credentials: "include",
          signal,
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as AnalysisJobResponse;
      const job = data.job;
      if (job.status === "queued") {
        setAnalysisPhase("queued");
        setStatus("Deep analysis queued…");
      } else if (job.status === "starting") {
        setAnalysisPhase("warming");
        setStatus("Waking deep analysis engine…");
      } else if (job.status === "running") {
        setAnalysisPhase("running");
        const fraction = job.progress?.fraction;
        setStatus(
          typeof fraction === "number"
            ? `Deep analysis · ${Math.round(fraction * 100)}%`
            : "Deep analysis running…",
        );
      } else if (job.status === "succeeded") {
        setMoves(job.result?.moves ?? []);
        setSelectedMoveIndex(null);
        setStatus("Deep analysis complete");
        return;
      } else if (job.status === "interrupted") {
        throw new Error("job_interrupted");
      } else if (job.status === "cancelled") {
        throw new Error("job_cancelled");
      } else {
        throw new Error("job_failed");
      }
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(resolve, 1000);
        signal.addEventListener(
          "abort",
          () => {
            window.clearTimeout(timer);
            reject(
              new DOMException("analysis polling cancelled", "AbortError"),
            );
          },
          { once: true },
        );
      });
    }
  };

  const cancelAnalysis = async () => {
    const jobId = activeJobIdRef.current;
    analysisCancelledRef.current = true;
    if (jobId && sessionId) {
      await fetch(
        apiUrl(`/api/v1/sessions/${sessionId}/analysis/jobs/${jobId}`),
        {
          method: "DELETE",
          credentials: "include",
        },
      ).catch(() => undefined);
    }
    analysisAbortRef.current?.abort();
    activeJobIdRef.current = null;
    setAnalysisPhase("idle");
    setAnalyzing(false);
    setRetryAvailable(false);
    setStatus("Analysis cancelled");
  };

  const analyze = async () => {
    setRetryAvailable(false);
    analysisCancelledRef.current = false;
    if (!sessionReady || !sessionId) {
      setStatus("Session unavailable · draft saved locally");
      setMoves([]);
      return;
    }
    const controller = new AbortController();
    analysisAbortRef.current = controller;
    setAnalyzing(true);
    setAnalysisPhase("saving");
    setStatus("Saving position…");
    let warmingTimer: number | undefined;
    try {
      const persistedRevision = await persistSession();
      if (persistedRevision === null) throw new Error("session_conflict");
      if (analysisMode === "deep") {
        setAnalysisPhase("queued");
        setStatus("Queueing deep analysis…");
        const idempotencyKey = crypto.randomUUID();
        const response = await fetch(
          apiUrl(`/api/v1/sessions/${sessionId}/analysis/jobs`),
          {
            method: "POST",
            credentials: "include",
            signal: controller.signal,
            headers: {
              "content-type": "application/json",
              "Idempotency-Key": idempotencyKey,
            },
            body: JSON.stringify({
              sessionRevision: persistedRevision,
              options: { budgetMs: 60000, candidateLimit: 20, seed: 123456789 },
            }),
          },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const created = (await response.json()) as AnalysisJobResponse;
        activeJobIdRef.current = created.job.id;
        await pollDeepJob(created.job.id, controller.signal);
      } else {
        setAnalysisPhase("starting");
        setStatus("Starting analysis engine…");
        warmingTimer = window.setTimeout(() => {
          setAnalysisPhase("warming");
          setStatus("Waking analysis engine…");
        }, 900);
        const response = await fetch(
          apiUrl(`/api/v1/sessions/${sessionId}/moves/generate`),
          {
            method: "POST",
            credentials: "include",
            signal: controller.signal,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              sessionRevision: persistedRevision,
              options: {
                candidateLimit: 20,
                deadlineMs: 5000,
                seed: 123456789,
              },
            }),
          },
        );
        if (!response.ok) {
          if (
            response.status === 502 ||
            response.status === 503 ||
            response.status === 504
          ) {
            throw new Error("engine_wake_failed");
          }
          throw new Error(`HTTP ${response.status}`);
        }
        const result = await response.json();
        setMoves(Array.isArray(result?.moves) ? result.moves : []);
        setSelectedMoveIndex(null);
        setStatus("Analysis complete");
      }
    } catch (error) {
      if (analysisCancelledRef.current) return;
      setMoves([]);
      setSelectedMoveIndex(null);
      setRetryAvailable(true);
      if (error instanceof Error && error.message === "engine_wake_failed") {
        setStatus("Engine unavailable after wake-up · retry");
      } else if (
        error instanceof Error &&
        error.message === "session_conflict"
      ) {
        setStatus("Session changed · reconnect and retry");
      } else if (
        error instanceof Error &&
        error.message === "job_interrupted"
      ) {
        setStatus("Deep analysis interrupted · retry");
      } else if (error instanceof Error && error.message === "job_cancelled") {
        setStatus("Analysis cancelled");
      } else {
        setStatus(
          analysisMode === "deep"
            ? "Deep analysis unavailable · retry"
            : "Analysis unavailable · retry saved draft",
        );
      }
    } finally {
      if (warmingTimer !== undefined) window.clearTimeout(warmingTimer);
      if (analysisAbortRef.current === controller)
        analysisAbortRef.current = null;
      activeJobIdRef.current = null;
      setAnalysisPhase("idle");
      setAnalyzing(false);
    }
  };

  const changeLexicon = (event: Event) => {
    const lexiconId = (event.currentTarget as HTMLSelectElement)
      .value as LexiconId;
    setDraftState((previous) => ({ ...previous, lexiconId }));
    setScenarioDirty(true);
    clearAnalysisResults();
    if (lexiconId === "csw24") setAnalysisMode("fast");
    setStatus(
      `${LEXICON_DETAILS[lexiconId].displayName} selected · save or analyze to apply`,
    );
  };

  const analysisLabel = analyzing
    ? analysisPhase === "saving"
      ? "Saving…"
      : analysisPhase === "warming"
        ? "Waking engine…"
        : analysisPhase === "queued"
          ? "Queued…"
          : analysisPhase === "running"
            ? "Deep analyzing…"
            : "Analyzing…"
    : retryAvailable
      ? "Retry analysis"
      : sessionReady
        ? "Analyze position"
        : "Starting session…";
  const lexicon = LEXICON_DETAILS[draftState.lexiconId];

  return (
    <div class="app-shell">
      <header class="topbar">
        <div class="brand-lockup">
          <span class="brand-mark" aria-hidden="true">
            Q
          </span>
          <div>
            <strong>Quackle Web</strong>
            <span>Position analysis</span>
          </div>
        </div>
        <div class="topbar-actions">
          <span class="lexicon-chip">
            <span class="status-dot" /> {lexicon.displayName}
          </span>
          <button
            class="icon-button desktop-about-button"
            type="button"
            onClick={openAbout}
            aria-label="Open About and legal information"
          >
            ⓘ
          </button>
          <button
            class="icon-button"
            type="button"
            onClick={() => setScenariosOpen(true)}
            aria-label="Open recent scenarios"
          >
            ↶
          </button>
          <button
            class="icon-button"
            type="button"
            onClick={() => setSettingsOpen(true)}
            aria-label="Open settings"
          >
            ☰
          </button>
        </div>
      </header>

      <main class="workspace">
        <section class="context-strip" aria-label="Session context">
          <div>
            <span class="eyebrow">SESSION</span>
            <strong>
              {isReplaying
                ? "Replay snapshot"
                : sessionReady
                  ? "Saved position"
                  : connectionState === "offline"
                    ? "Offline draft"
                    : "Connecting session"}
            </strong>
          </div>
          <div class="context-stats">
            <span>Turn {visibleTurn.number}</span>
            <span>{visibleFilledCount} tiles</span>
            {draftState.history.length > 0 && (
              <span>{draftState.history.length} history records</span>
            )}
            <span
              class={`online-state ${connectionState}`}
              role="status"
              aria-live="polite"
            >
              {status}
            </span>
          </div>
        </section>

        {replayFrames.length > 1 && (
          <section class="replay-panel" aria-label="Game replay">
            <div class="replay-heading">
              <div>
                <span class="eyebrow">GAME REPLAY</span>
                <strong>
                  {isReplaying
                    ? `Record ${activeReplayIndex} of ${draftState.history.length}`
                    : "Final position"}
                </strong>
              </div>
              {!isReplaying && (
                <button
                  class="secondary-button"
                  type="button"
                  onClick={startReplay}
                >
                  Replay game
                </button>
              )}
            </div>
            {isReplaying && (
              <>
                <div class="replay-controls">
                  <button
                    class="secondary-button"
                    type="button"
                    onClick={() => setReplayCursor(0)}
                    disabled={activeReplayIndex === 0}
                  >
                    First
                  </button>
                  <button
                    class="secondary-button"
                    type="button"
                    onClick={() =>
                      setReplayCursor((activeReplayIndex ?? 0) - 1)
                    }
                    disabled={activeReplayIndex === 0}
                  >
                    Previous
                  </button>
                  <button
                    class="secondary-button"
                    type="button"
                    onClick={() =>
                      setReplayCursor((activeReplayIndex ?? 0) + 1)
                    }
                    disabled={activeReplayIndex === replayFrames.length - 1}
                  >
                    Next
                  </button>
                  <button
                    class="secondary-button"
                    type="button"
                    onClick={() => setReplayCursor(replayFrames.length - 1)}
                    disabled={activeReplayIndex === replayFrames.length - 1}
                  >
                    Final record
                  </button>
                  <button
                    class="text-button"
                    type="button"
                    onClick={returnToFinal}
                  >
                    Return to final
                  </button>
                </div>
                <p class="replay-event" aria-live="polite">
                  {replayFrame?.event
                    ? replayEventLabel(replayFrame.event)
                    : "Initial position"}
                </p>
              </>
            )}
          </section>
        )}

        {draftState.metadata?.forkedFrom && !isReplaying && (
          <p class="fork-note" role="status">
            Forked from shared scenario revision{" "}
            {draftState.metadata.forkedFrom.sourceRevision}. This session is
            independent.
          </p>
        )}

        <div class="analysis-layout">
          <section class="board-column" aria-label="Position editor">
            <div class="score-row">
              <div class="score-card active">
                <span>{isReplaying ? "On turn" : "You"}</span>
                <strong>{visibleScores.onTurn}</strong>
                <small>
                  {isReplaying
                    ? (replayFrame?.currentPlayer ?? "unknown")
                    : "on turn"}
                </small>
              </div>
              <div class="score-card">
                <span>Opponent</span>
                <strong>{visibleScores.opponent}</strong>
                <small>{isReplaying ? "other player" : "unknown rack"}</small>
              </div>
            </div>
            <div class="board-wrap">
              <div class="board-labels top-labels" aria-hidden="true">
                {Array.from({ length: SIZE }, (_, i) => (
                  <span key={i}>{String.fromCharCode(65 + i)}</span>
                ))}
              </div>
              <div class="board-with-row-labels">
                <div class="row-labels" aria-hidden="true">
                  {Array.from({ length: SIZE }, (_, i) => (
                    <span key={i}>{i + 1}</span>
                  ))}
                </div>
                <div
                  class="board"
                  role="grid"
                  aria-label="15 by 15 board"
                  aria-activedescendant={`board-cell-${activeCellIndex}`}
                >
                  {boardCells.map((index) => {
                    const cell = previewCells[index];
                    const isPreview = !visibleCells[index] && Boolean(cell);
                    const premium = classicPremiumAt(
                      Math.floor(index / SIZE),
                      index % SIZE,
                    );
                    const premiumText =
                      premium === "center"
                        ? "center"
                        : premium
                            .replace("triple-word", "triple word")
                            .replace("double-word", "double word")
                            .replace("triple-letter", "triple letter")
                            .replace("double-letter", "double letter");
                    return (
                      <button
                        key={index}
                        ref={
                          activeCellIndex === index ? activeCellRef : undefined
                        }
                        type="button"
                        class={`board-cell ${premium} ${cell ? "occupied" : ""} ${isPreview ? "preview-tile" : ""} ${activeCellIndex === index ? "active-cell" : ""} ${cell?.blank ? "blank-tile" : ""}`}
                        onClick={() => placeTile(index)}
                        onFocus={() => setActiveCellIndex(index)}
                        onKeyDown={(event) => handleBoardKeyDown(event, index)}
                        data-board-cell-index={index}
                        tabIndex={activeCellIndex === index ? 0 : -1}
                        disabled={isReplaying}
                        aria-label={`${positionFor(index)}${cell ? ` ${isPreview ? "preview " : ""}${cell.blank ? "blank " : ""}${cell.letter}` : " empty"}${premiumText ? `, ${premiumText}` : ""}`}
                      >
                        {cell?.letter ??
                          (!cell && premium !== "" ? (
                            <small>
                              {premium === "center"
                                ? "★"
                                : premium === "triple-word"
                                  ? "TW"
                                  : premium === "double-word"
                                    ? "DW"
                                    : premium === "triple-letter"
                                      ? "TL"
                                      : "DL"}
                            </small>
                          ) : (
                            ""
                          ))}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            <div class="rack-panel">
              <div class="rack-heading">
                <span class="eyebrow">
                  {isReplaying ? "FINAL RACK SNAPSHOT" : "YOUR RACK"}
                </span>
                <div class="rack-actions">
                  <button
                    type="button"
                    class="text-button"
                    onClick={shuffleRack}
                    disabled={isReplaying || rack.length < 2}
                  >
                    Shuffle
                  </button>
                  <button
                    type="button"
                    class="text-button"
                    onClick={() => {
                      setRackEditMode((open) => !open);
                      setSelectedRackIndex(null);
                    }}
                    disabled={isReplaying}
                  >
                    {rackEditMode ? "Done" : "Edit rack"}
                  </button>
                  <button
                    type="button"
                    class="text-button"
                    onClick={() => setSelectedRackIndex(null)}
                    disabled={isReplaying}
                  >
                    Clear selection
                  </button>
                </div>
              </div>
              <div class="rack" aria-label="Rack">
                {Array.from(rack).map((letter, index) => (
                  <button
                    key={`${letter}-${index}`}
                    type="button"
                    class={`rack-tile ${selectedRackIndex === index ? "selected" : ""}`}
                    onPointerDown={(event) =>
                      beginRackDrag(event, index, letter)
                    }
                    onClick={() => {
                      if (suppressRackClickRef.current) return;
                      if (rackEditMode) {
                        removeRackTile(index);
                        return;
                      }
                      setSelectedRackIndex(
                        selectedRackIndex === index ? null : index,
                      );
                      setSelectedPaletteTile(null);
                      setStatus(
                        selectedRackIndex === index
                          ? "Rack selection cleared"
                          : `Selected ${letter} · tap a board square or drag it`,
                      );
                    }}
                    disabled={isReplaying}
                    aria-pressed={selectedRackIndex === index}
                    aria-label={
                      rackEditMode
                        ? `Remove rack tile ${letter}`
                        : `Rack tile ${index + 1}, ${letter}, ${TILE_VALUES[letter] ?? 0} points`
                    }
                  >
                    <span>{letter}</span>
                    <small>{TILE_VALUES[letter] ?? 0}</small>
                  </button>
                ))}
                {rack.length === 0 && (
                  <span class="rack-empty">No tiles · use Edit rack</span>
                )}
              </div>
              <div class="editor-toolbar" aria-label="Board entry controls">
                <button
                  class="mode-button"
                  type="button"
                  aria-pressed={entryMode === "tap"}
                  onClick={() => setEntryMode("tap")}
                >
                  Tap to place
                </button>
                <button
                  class="mode-button"
                  type="button"
                  aria-pressed={entryMode === "type"}
                  onClick={() => setEntryMode("type")}
                >
                  Tile typing
                </button>
                <button
                  class="mode-button"
                  type="button"
                  onClick={() =>
                    setBoardDirection((direction) =>
                      direction === "horizontal" ? "vertical" : "horizontal",
                    )
                  }
                >
                  {boardDirection === "horizontal" ? "Across" : "Down"}
                </button>
              </div>
              <div
                class="tile-keyboard"
                aria-label={
                  rackEditMode ? "Rack tile keyboard" : "Board tile keyboard"
                }
              >
                {TILE_KEYBOARD.map((letter) => (
                  <button
                    key={letter}
                    type="button"
                    class={`tile-key ${letter === "⌫" ? "wide" : ""}`}
                    onClick={() => handleTileKeyboard(letter)}
                    disabled={
                      isReplaying ||
                      (rackEditMode && rack.length >= 7 && letter !== "⌫")
                    }
                    aria-label={
                      letter === "⌫"
                        ? "Delete tile"
                        : letter === "?"
                          ? "Blank tile"
                          : `Tile ${letter}`
                    }
                  >
                    {letter}
                  </button>
                ))}
              </div>
              <p class="hint" aria-live="polite">
                {isReplaying
                  ? "Replay is read-only; racks remain the final imported snapshot."
                  : rackEditMode
                    ? "Tap letters to edit the rack. Tap a rack tile again to remove it."
                    : entryMode === "type"
                      ? `Select a board square, then use the tile keys · ${boardDirection === "horizontal" ? "across" : "down"}`
                      : selectedTile
                        ? `Tap a board square to place ${selectedTile}`
                        : "Tap a rack/palette tile, then tap a square · drag tiles to the board"}
              </p>
            </div>
            <div class="action-row">
              <button
                class="secondary-button"
                type="button"
                onClick={() =>
                  markPositionEdited("Board cleared", (previous) =>
                    stateForCells({}, previous),
                  )
                }
                disabled={isReplaying}
              >
                Clear board
              </button>
              <button
                class="primary-button"
                type="button"
                onClick={() => void analyze()}
                disabled={analyzing || !sessionReady || isReplaying}
              >
                {isReplaying ? "Replay is read-only" : analysisLabel}
              </button>
              {analyzing && (
                <button
                  class="secondary-button"
                  type="button"
                  onClick={() => void cancelAnalysis()}
                >
                  Cancel
                </button>
              )}
            </div>
            {!sessionReady && (
              <div class="reconnect-row" role="status" aria-live="polite">
                <span>
                  Draft stays on this device while the session reconnects.
                </span>
                <button
                  class="text-button"
                  type="button"
                  onClick={reconnectSession}
                >
                  Reconnect session
                </button>
              </div>
            )}
            {analysisPhase === "warming" && (
              <p class="engine-note" role="status" aria-live="polite">
                The native engine may be waking after five minutes idle. Keep
                this tab open.
              </p>
            )}
          </section>

          <aside
            class={`moves-panel ${movesOpen ? "open" : "collapsed"}`}
            aria-label="Candidate moves"
          >
            <div class="panel-heading">
              <button
                class="panel-heading-toggle"
                type="button"
                onClick={() => setMovesOpen((open) => !open)}
                aria-expanded={movesOpen}
              >
                <div>
                  <span class="eyebrow">CANDIDATE MOVES</span>
                  <h2>Best plays</h2>
                </div>
                <span class="moves-count">
                  {moves.length > 0 ? moves.length : "—"}
                </span>
              </button>
              <button
                class="filter-button"
                type="button"
                onClick={() =>
                  setStatus(
                    "Candidate limit is controlled in the position settings",
                  )
                }
              >
                {analysisMode === "deep" ? "Deep · 20" : "Static · 20"}
              </button>
            </div>
            {movesOpen && (
              <>
                <div class="move-list">
                  {moves.length === 0 && (
                    <p class="moves-empty">
                      Analyze this position to see candidate moves. Results will
                      appear here without changing your editable position.
                    </p>
                  )}
                  {moves.map((move, index) => {
                    const score =
                      typeof move.score === "number" ? move.score : "—";
                    const equity =
                      typeof move.equity === "number"
                        ? move.equity.toFixed(2)
                        : "—";
                    const label =
                      move.action === "place"
                        ? `${move.word ?? move.tiles ?? "play"} ${move.position ?? ""}`
                        : move.action === "exchange"
                          ? `Exchange ${move.tiles ?? "tiles"}`
                          : "Pass";
                    return (
                      <button
                        class={`move-row ${selectedMoveIndex === index ? "selected" : ""}`}
                        type="button"
                        key={`${move.position ?? ""}-${move.word ?? move.action}-${index}`}
                        onClick={() => {
                          setSelectedMoveIndex(index);
                          setStatus(`Selected ${label}`);
                        }}
                        aria-selected={selectedMoveIndex === index}
                      >
                        <span class="move-rank">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <span class="move-main">
                          <strong>{label}</strong>
                          <small>
                            {move.position ?? move.action}
                            {move.is_bingo ? " · BINGO" : ""}
                            {move.leave ? ` · leave ${move.leave}` : ""}
                          </small>
                        </span>
                        <span class="move-score">
                          <strong>{score}</strong>
                          <small>{equity}</small>
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div class="panel-footer">
                  <span>
                    {analyzing
                      ? analysisLabel
                      : moves.length > 0
                        ? "Results for current position"
                        : "No analysis yet"}
                  </span>
                  <span class="engine-badge">Quackle · native</span>
                </div>
              </>
            )}
          </aside>
        </div>
      </main>

      <nav class="bottom-nav" aria-label="Workspace navigation">
        <button class="nav-item active" type="button">
          <span>▦</span>
          <small>Board</small>
        </button>
        <button
          class="nav-item"
          type="button"
          onClick={() => setSettingsOpen(true)}
        >
          <span>⚙</span>
          <small>Settings</small>
        </button>
        <button
          class="nav-item"
          type="button"
          onClick={() => setScenariosOpen(true)}
          aria-label="Open scenarios"
        >
          <span>↶</span>
          <small>Scenarios</small>
        </button>
        <button class="nav-item" type="button" onClick={openAbout}>
          <span>ⓘ</span>
          <small>About</small>
        </button>
      </nav>

      {settingsOpen && (
        <div
          class="drawer-backdrop"
          role="presentation"
          onClick={() => setSettingsOpen(false)}
        >
          <section
            class="settings-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div class="drawer-heading">
              <div>
                <span class="eyebrow">POSITION SETTINGS</span>
                <h2 id="settings-title">Analysis context</h2>
              </div>
              <button
                class="icon-button"
                type="button"
                onClick={() => setSettingsOpen(false)}
                aria-label="Close settings"
              >
                ×
              </button>
            </div>
            <label>
              Analysis
              <select
                value={analysisMode}
                onChange={(event) =>
                  setAnalysisMode(
                    (event.currentTarget as HTMLSelectElement)
                      .value as AnalysisMode,
                  )
                }
                disabled={analyzing}
              >
                <option value="fast">Fast static moves</option>
                <option value="deep" disabled={!lexicon.deepAnalysis}>
                  Deep analysis job
                  {!lexicon.deepAnalysis ? " (NWL23 only)" : ""}
                </option>
              </select>
            </label>
            <label>
              Lexicon
              <select
                value={draftState.lexiconId}
                onChange={changeLexicon}
                disabled={analyzing}
              >
                <option value="nwl23">NWL2023</option>
                <option value="csw24">CSW24</option>
                <option disabled>Custom list (coming soon)</option>
              </select>
            </label>
            {draftState.lexiconId === "csw24" && (
              <p class="engine-note" role="status">
                CSW24 supports dictionary validation and static move generation.
                Deep strategy analysis is intentionally unavailable.
              </p>
            )}
            <label>
              Unseen tiles
              <select>
                <option>Derive from position</option>
                <option>Enter manually</option>
              </select>
            </label>
            <div class="data-actions" aria-label="Position file actions">
              <button
                class="secondary-button"
                type="button"
                onClick={exportPosition}
              >
                Export JSON
              </button>
              <button
                class="secondary-button"
                type="button"
                onClick={() => void shareScenario()}
                disabled={!sessionReady || scenarioBusy}
              >
                Share scenario
              </button>
              <button
                class="secondary-button"
                type="button"
                onClick={exportGcgFile}
              >
                Export GCG
              </button>
              <button
                class="secondary-button"
                type="button"
                onClick={() => importInputRef.current?.click()}
              >
                Import JSON
              </button>
              <button
                class="secondary-button"
                type="button"
                onClick={() => importGcgInputRef.current?.click()}
              >
                Import GCG
              </button>
              <input
                ref={importInputRef}
                class="visually-hidden"
                type="file"
                accept="application/json,.json"
                onChange={(event) => void importPosition(event)}
              />
              <input
                ref={importGcgInputRef}
                class="visually-hidden"
                type="file"
                accept="text/plain,.gcg,.txt"
                onChange={(event) => void importGcg(event)}
              />
            </div>
            <p class="share-disclosure">
              Share links are permanent until revoked. Up to 100 remain active;
              creating another automatically removes the oldest. Anyone with a
              link can create independent forks, and revoking does not change
              existing ones.
            </p>
            <section class="share-links-section" aria-label="Shared links">
              <div class="share-links-heading">
                <strong>Shared links</strong>
                <button
                  class="text-button"
                  type="button"
                  onClick={() => void loadShareLinks()}
                  disabled={shareLinksLoading}
                >
                  {shareLinksLoading ? "Refreshing…" : "Refresh"}
                </button>
              </div>
              {shareNotices.map((notice) => (
                <div
                  class="share-link-notice"
                  key={notice.shareId}
                  role="status"
                >
                  <div>
                    <strong>Share link removed automatically</strong>
                    <small>
                      Revision {notice.sourceRevision} ·{" "}
                      {notice.reason === "storage_limit"
                        ? "storage pressure"
                        : "100-link limit"}{" "}
                      · created {scenarioTimeLabel(notice.createdAt)}
                    </small>
                  </div>
                  <button
                    class="text-button"
                    type="button"
                    onClick={() => void dismissShareNotice(notice.shareId)}
                    disabled={shareNoticeAction !== null}
                  >
                    {shareNoticeAction === notice.shareId
                      ? "Dismissing…"
                      : "Dismiss"}
                  </button>
                </div>
              ))}
              {shareLinks.length === 0 && !shareLinksLoading && (
                <p class="scenario-empty">No active share links.</p>
              )}
              <div class="share-links-list">
                {shareLinks.map((share) => (
                  <div class="share-link-row" key={share.shareId}>
                    <div>
                      <strong>Revision {share.sourceRevision}</strong>
                      <small>
                        Permanent · {share.useCount}{" "}
                        {share.useCount === 1 ? "fork" : "forks"} · created{" "}
                        {scenarioTimeLabel(share.createdAt)}
                      </small>
                    </div>
                    <button
                      class="text-button"
                      type="button"
                      onClick={() => void revokeShareLink(share.shareId)}
                      disabled={shareLinkAction !== null}
                    >
                      {shareLinkAction === share.shareId
                        ? "Revoking…"
                        : "Revoke"}
                    </button>
                  </div>
                ))}
              </div>
            </section>
            <label>
              Cross-Tables game URL
              <input
                type="url"
                placeholder="https://www.cross-tables.com/annotated.php?u=…"
                value={crossTablesUrl}
                onInput={(event) =>
                  setCrossTablesUrl(event.currentTarget.value)
                }
              />
            </label>
            <div class="data-actions" aria-label="Cross-Tables actions">
              <button
                class="secondary-button"
                type="button"
                onClick={() => void importCrossTables()}
                disabled={crossTablesBusy || crossTablesUrl.trim() === ""}
              >
                {crossTablesBusy ? "Fetching public GCG…" : "Import public GCG"}
              </button>
              <button
                class="secondary-button"
                type="button"
                onClick={openCrossTablesLink}
                disabled={crossTablesUrl.trim() === ""}
              >
                Open link
              </button>
            </div>
            <p class="scenario-note">
              Only validated HTTPS Cross-Tables annotated-game links are opened.
              If browser CORS blocks the GCG download, use Open link, download
              the file, then Import GCG.
            </p>
            <p class="disclosure">
              <strong>{lexicon.copyright}</strong>
              <br />
              Quackle Web is an independent project. Dictionary assets have
              separate restrictions.
            </p>
          </section>
        </div>
      )}
      {scenariosOpen && (
        <div
          class="drawer-backdrop"
          role="presentation"
          onClick={() => setScenariosOpen(false)}
        >
          <section
            class="settings-drawer scenario-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="scenarios-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div class="drawer-heading">
              <div>
                <span class="eyebrow">LOCAL SCENARIOS</span>
                <h2 id="scenarios-title">Recent scenarios</h2>
              </div>
              <button
                class="icon-button"
                type="button"
                onClick={() => setScenariosOpen(false)}
                aria-label="Close scenarios"
              >
                ×
              </button>
            </div>
            <div class="scenario-create-actions">
              <button
                class="primary-button scenario-new-button"
                type="button"
                onClick={createNewGame}
                disabled={scenarioBusy}
              >
                New game <small>random opening rack</small>
              </button>
              <button
                class="secondary-button scenario-new-button"
                type="button"
                onClick={createBlankPosition}
                disabled={scenarioBusy}
              >
                Blank position
              </button>
            </div>
            <p class="scenario-note">
              New game starts with an empty board and a fresh random rack, like
              Quackle. Use Blank position to set up a historical or hypothetical
              position manually.
            </p>
            <p class="scenario-note">
              This browser remembers the {MAX_LOCAL_SCENARIOS} most recent
              scenarios. Local drafts stay available if a session is offline or
              expires.
            </p>
            <div class="scenario-list" aria-label="Recent scenarios">
              {scenarioList.slice(0, MAX_LOCAL_SCENARIOS).map((scenario) => (
                <button
                  class={`scenario-item ${scenario.localId === activeLocalId ? "active" : ""}`}
                  type="button"
                  key={scenario.localId}
                  onClick={() => void activateScenario(scenario)}
                  disabled={scenarioBusy}
                  aria-current={
                    scenario.localId === activeLocalId ? "true" : undefined
                  }
                  aria-label={`Open scenario ${scenario.title}`}
                >
                  <span class="scenario-item-main">
                    <strong>{scenario.title}</strong>
                    <small>
                      {scenarioKindLabel(scenario.kind)} ·{" "}
                      {scenarioTileCount(scenario.state)} tiles ·{" "}
                      {scenario.dirty ? "local changes" : "saved"}
                    </small>
                  </span>
                  <span class="scenario-item-meta">
                    {scenarioTimeLabel(scenario.lastOpenedAt)}
                    {scenario.localId === activeLocalId ? " · current" : ""}
                  </span>
                </button>
              ))}
              {scenarioList.length === 0 && (
                <p class="scenario-empty">No saved scenarios yet.</p>
              )}
            </div>
          </section>
        </div>
      )}
      {blankPickerIndex !== null && (
        <div
          class="drawer-backdrop"
          role="presentation"
          onClick={() => setBlankPickerIndex(null)}
        >
          <section
            class="blank-picker"
            role="dialog"
            aria-modal="true"
            aria-labelledby="blank-picker-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div class="drawer-heading">
              <div>
                <span class="eyebrow">BLANK TILE</span>
                <h2 id="blank-picker-title">Choose its letter</h2>
              </div>
              <button
                class="icon-button"
                type="button"
                onClick={() => setBlankPickerIndex(null)}
                aria-label="Close blank tile picker"
              >
                ×
              </button>
            </div>
            <div class="blank-letter-grid">
              {[..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map((letter) => (
                <button
                  key={letter}
                  type="button"
                  class="tile-key blank-letter"
                  onClick={() => chooseBlankLetter(letter)}
                >
                  {letter}
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
      {aboutOpen && (
        <div
          class="drawer-backdrop"
          role="presentation"
          onClick={() => setAboutOpen(false)}
        >
          <section
            class="settings-drawer about-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="about-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div class="drawer-heading">
              <div>
                <span class="eyebrow">ABOUT / LEGAL</span>
                <h2 id="about-title">Quackle Web</h2>
              </div>
              <button
                class="icon-button"
                type="button"
                onClick={() => setAboutOpen(false)}
                aria-label="Close About"
              >
                ×
              </button>
            </div>
            <p class="about-lede">
              A mobile-first position analysis workspace powered by the native
              Quackle engine.
            </p>
            <dl class="about-details">
              <div>
                <dt>Engine</dt>
                <dd>
                  {isObject(aboutMeta?.engine) &&
                  typeof aboutMeta.engine.quackle_commit === "string"
                    ? `Quackle ${aboutMeta.engine.quackle_commit.slice(0, 12)}`
                    : "Quackle native engine"}
                </dd>
              </div>
              <div>
                <dt>Board</dt>
                <dd>Classic 15×15</dd>
              </div>
              <div>
                <dt>Active lexicon</dt>
                <dd>{lexicon.displayName}</dd>
              </div>
              <div>
                <dt>Capabilities</dt>
                <dd>
                  {lexicon.deepAnalysis
                    ? "Static moves and deep analysis"
                    : "Validation and static moves"}
                </dd>
              </div>
            </dl>
            <p class="disclosure">
              <strong>{lexicon.copyright}</strong>
              <br />
              Quackle Web is an independent project and is not affiliated with
              the Quackle authors or dictionary licensors. Quackle and
              dictionary assets retain their separate licenses and notices.
            </p>
            <p class="about-note">
              Position drafts are stored in this browser for recovery. Native
              analysis requires a network connection; session and share-link
              state remains server-authoritative.
            </p>
            <button
              class="secondary-button"
              type="button"
              onClick={() => {
                setAboutOpen(false);
                setSettingsOpen(true);
              }}
            >
              Open settings and data tools
            </button>
          </section>
        </div>
      )}
    </div>
  );
}

render(<App />, document.getElementById("app")!);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () =>
    navigator.serviceWorker.register("/sw.js").catch(() => undefined),
  );
}
