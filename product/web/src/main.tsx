import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { render } from "preact";
import { parseCrossTablesUrl } from "../../shared/cross-tables";
import {
  classicPremiumAt,
  decodeGcgBytes,
  exportGcg,
  GcgParseError,
  isDecisionRecord,
  parseGcg,
  replayGcgHistory,
  resolveLexiconHint,
  type GcgHistoryEntry,
  type GcgImportResult,
  type GcgPlayer,
  type GcgReplayFrame,
} from "../../shared/gcg";
import {
  deleteScenario,
  getScenario,
  listScenarios,
  listShareSources,
  loadActiveScenario,
  MAX_LOCAL_SCENARIOS,
  newScenarioId,
  rememberShareSource,
  restoreDeletedScenario,
  saveScenario,
  setActiveScenario,
  subscribeToScenarioEvents,
  type ScenarioKind,
  type ScenarioRecord,
  type ScenarioSource,
  type ShareSourceRecord,
  type DeletedScenario,
} from "./scenario-store";
import "./styles.css";

const API_BASE_URL = (import.meta.env.VITE_QUACKLE_API_BASE_URL ?? "").replace(
  /\/+$/,
  "",
);
const apiUrl = (path: string) => `${API_BASE_URL}${path}`;

async function fetchShareCollection(
  sourceSessionId: string,
): Promise<{ links: ShareLink[]; notices: ShareLinkNotice[] }> {
  const response = await fetch(
    apiUrl(`/api/v1/sessions/${sourceSessionId}/share`),
    { credentials: "include" },
  );
  if (!response.ok) throw new Error(`share_http_${response.status}`);
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
          (value.expiresAt !== null && typeof value.expiresAt !== "string") ||
          typeof value.useCount !== "number" ||
          (value.lastUsedAt !== null && typeof value.lastUsedAt !== "string")
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
          (value.reason !== "active_limit" && value.reason !== "storage_limit")
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
  return { links, notices };
}

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

type SessionPersistResult = {
  revision: number;
  draftVersion: number;
  draftChangedDuringSave: boolean;
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

type ShareSourceView = {
  status: "unchecked" | "checking" | "ready" | "offline" | "unavailable";
  links: ShareLink[];
  notices: ShareLinkNotice[];
  checkedAt?: string;
};

type PendingShareRevoke = {
  sourceSessionId: string;
  shareId: string;
  title: string;
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
    result: { moves?: Move[]; board_warnings?: unknown } | null;
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
    deepAnalysis: true,
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
    /** Replay cursor: number of history records applied. Absent = editable final position. */
    replayCursor?: number;
    /** Final (post-game) rack/scores/turn so leaving replay restores them exactly. */
    finalPosition?: FinalPositionSnapshot;
  };
};

type FinalPositionSnapshot = {
  rack: string;
  scores: { onTurn: number; opponent: number };
  turn: { number: number; scorelessTurns: number };
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

function finalPositionFromUnknown(
  value: unknown,
): FinalPositionSnapshot | undefined {
  if (
    !isObject(value) ||
    typeof value.rack !== "string" ||
    !/^[A-Z?]{0,7}$/.test(value.rack)
  )
    return undefined;
  const scores = isObject(value.scores) ? value.scores : {};
  const turn = isObject(value.turn) ? value.turn : {};
  const integer = (candidate: unknown, fallback: number) =>
    typeof candidate === "number" &&
    Number.isInteger(candidate) &&
    candidate >= 0
      ? candidate
      : fallback;
  return {
    rack: value.rack,
    scores: {
      onTurn: integer(scores.onTurn, 0),
      opponent: integer(scores.opponent, 0),
    },
    turn: {
      number: Math.max(1, integer(turn.number, 1)),
      scorelessTurns: integer(turn.scorelessTurns, 0),
    },
  };
}

function gcgCoordinate(
  row: number,
  col: number,
  direction: "horizontal" | "vertical",
): string {
  const letter = String.fromCharCode(65 + col);
  return direction === "horizontal"
    ? `${row + 1}${letter}`
    : `${letter}${row + 1}`;
}

/** Full word of a GCG placement, resolving play-through dots from the board. */
function placementWord(
  entry: Extract<GcgHistoryEntry, { kind: "place" }>,
  board: GcgReplayFrame["board"],
): string {
  const letters = new Map(
    board.map((cell) => [
      `${cell.row}:${cell.col}`,
      cell.blank ? cell.letter.toLowerCase() : cell.letter,
    ]),
  );
  return [...entry.tiles]
    .map((token, offset) => {
      if (token !== ".") return token;
      const row = entry.row + (entry.direction === "vertical" ? offset : 0);
      const col = entry.col + (entry.direction === "horizontal" ? offset : 0);
      return letters.get(`${row}:${col}`) ?? "?";
    })
    .join("");
}

/** GCG-style description such as "8D JOUAL +40 · 40". */
function describeRecord(
  event: GcgHistoryEntry,
  board: GcgReplayFrame["board"] | null,
): string {
  const total = event.total !== undefined ? ` · ${event.total}` : "";
  if (event.kind === "place") {
    const word = board ? placementWord(event, board) : event.tiles;
    const score = event.score ?? event.computedScore ?? 0;
    return `${gcgCoordinate(event.row, event.col, event.direction)} ${word} +${score}${total}${event.challenged ? " (withdrawn)" : ""}`;
  }
  if (event.kind === "pass") return `Pass +0${total}`;
  if (event.kind === "exchange")
    return `Exchange ${event.tiles ?? (event.blindCount ? `${event.blindCount} tiles` : "")} +0${total}`.replace(
      "  ",
      " ",
    );
  if (event.kind === "challenge")
    return event.challengeKind === "phony"
      ? `Phony challenged off ${event.score ?? ""}${total}`
      : `Challenge bonus ${event.adjustment !== undefined && event.adjustment >= 0 ? "+" : ""}${event.adjustment ?? 0}${total}`;
  if (event.kind === "time") return `Time penalty ${event.score ?? 0}${total}`;
  return `End of game (${event.unusedTiles}) ${event.score !== undefined && event.score >= 0 ? "+" : ""}${event.score ?? 0}${total}`;
}

function sortedLetters(value: string): string {
  return [...value.toUpperCase()].sort().join("");
}

/** Whether an engine candidate is the move actually played at a history record. */
function candidateMatchesRecord(
  move: Move,
  record: GcgHistoryEntry,
  board: GcgReplayFrame["board"],
): boolean {
  if (record.kind === "pass") return move.action === "pass";
  if (record.kind === "exchange")
    return (
      move.action === "exchange" &&
      (!record.tiles ||
        sortedLetters(move.tiles ?? "") === sortedLetters(record.tiles))
    );
  if (record.kind !== "place" || move.action !== "place") return false;
  if (
    move.row !== record.row ||
    move.col !== record.col ||
    (move.horizontal !== false) !== (record.direction === "horizontal")
  )
    return false;
  const word = placementWord(record, board).toUpperCase();
  return (move.word ?? "").toUpperCase() === word;
}

type ReplayPosition = SessionStateDraft["position"];

/** Position at a replay cursor: the board after `index` records with the next mover's rack. */
function replayPositionAt(
  frames: GcgReplayFrame[],
  history: GcgHistoryEntry[],
  players: GcgPlayer[],
  index: number,
  final: FinalPositionSnapshot,
): ReplayPosition {
  const frame = frames[index]!;
  const board = {
    id: "classic15",
    cells: frame.board.map((cell) => ({
      row: cell.row,
      col: cell.col,
      letter: cell.letter,
      blank: cell.blank,
    })),
  };
  if (index >= frames.length - 1)
    return {
      board,
      rack: final.rack,
      scores: final.scores,
      turn: final.turn,
      unseen: { mode: "derive" },
    };
  const decision = history[index];
  const mover = isDecisionRecord(decision)
    ? decision.player
    : frame.currentPlayer;
  const other = players.find(
    (player) => player.abbreviation !== mover,
  )?.abbreviation;
  const rack =
    isDecisionRecord(decision) && /^[A-Z?]{0,7}$/.test(decision.rack)
      ? decision.rack
      : "";
  return {
    board,
    rack,
    scores: {
      onTurn: Math.max(0, mover ? (frame.scores[mover] ?? 0) : 0),
      opponent: Math.max(0, other ? (frame.scores[other] ?? 0) : 0),
    },
    turn: frame.turn,
    unseen: { mode: "derive" },
  };
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
          replayCursor:
            typeof metadata.replayCursor === "number" &&
            Number.isInteger(metadata.replayCursor) &&
            metadata.replayCursor >= 0
              ? metadata.replayCursor
              : undefined,
          finalPosition: finalPositionFromUnknown(metadata.finalPosition),
        }
      : undefined,
  };
  return stateForCells(cellsFromState(value), base);
}
interface GcgValidationResponse {
  document?: unknown;
  sourceSha256?: unknown;
  encoding?: unknown;
  lexicon?: {
    id?: unknown;
    status?: unknown;
    hint?: unknown;
    source?: unknown;
  };
}

class GcgImportError extends Error {}

function warningWords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.flatMap((item) =>
        isObject(item) && typeof item.word === "string" ? [item.word] : [],
      ),
    ),
  ].slice(0, 12);
}

async function analysisErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    const error = isObject(body.error) ? body.error : {};
    const details = isObject(error.details) ? error.details : {};
    const first = Array.isArray(details.issues)
      ? details.issues.find(isObject)
      : undefined;
    if (first && typeof first.message === "string")
      return first.message.slice(0, 160);
    if (typeof error.message === "string") return error.message.slice(0, 160);
  } catch {
    // Fall through.
  }
  return "the engine rejected this position";
}

async function apiErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (isObject(body.error) && typeof body.error.message === "string")
      return body.error.message.slice(0, 160);
  } catch {
    // Fall through to the generic message.
  }
  return fallback;
}

function App() {
  const [draftState, setDraftStateState] = useState<SessionStateDraft>(
    DEFAULT_SESSION_STATE,
  );
  const draftWriteVersionRef = useRef(0);
  const setDraftState = (
    next:
      SessionStateDraft | ((previous: SessionStateDraft) => SessionStateDraft),
  ) => {
    draftWriteVersionRef.current += 1;
    setDraftStateState(next);
  };
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
  const [scenarioTab, setScenarioTab] = useState<"scenarios" | "shares">(
    "scenarios",
  );
  const [scenarioBusy, setScenarioBusy] = useState(false);
  const [scenarioRemovalCandidate, setScenarioRemovalCandidate] =
    useState<ScenarioRecord | null>(null);
  const [scenarioRemovalBusy, setScenarioRemovalBusy] = useState(false);
  const [undoScenarioDeletion, setUndoScenarioDeletion] =
    useState<DeletedScenario | null>(null);
  const [orphanedScenarioTitle, setOrphanedScenarioTitle] = useState<
    string | null
  >(null);
  const [boardWarnings, setBoardWarnings] = useState<string[]>([]);
  const pendingOpenStatusRef = useRef<string | null>(null);
  const draftStateRef = useRef<SessionStateDraft | null>(null);
  const scenarioListRef = useRef<ScenarioRecord[]>([]);
  const [entryMode, setEntryMode] = useState<"tap" | "type">("tap");
  const [rackEditMode, setRackEditMode] = useState(false);
  const [boardDirection, setBoardDirection] = useState<
    "horizontal" | "vertical"
  >("horizontal");
  const [activeCellIndex, setActiveCellIndex] = useState(112);
  const [blankPickerIndex, setBlankPickerIndex] = useState<number | null>(null);
  const [lexiconPrompt, setLexiconPrompt] = useState<
    ((choice: LexiconId | null) => void) | null
  >(null);
  const askLexicon = () =>
    new Promise<LexiconId | null>((resolve) => {
      setLexiconPrompt(() => (choice: LexiconId | null) => {
        setLexiconPrompt(null);
        resolve(choice);
      });
    });
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
  const [shareSources, setShareSources] = useState<ShareSourceRecord[]>([]);
  const [shareSourceViews, setShareSourceViews] = useState<
    Record<string, ShareSourceView>
  >({});
  const [shareSourcesLoading, setShareSourcesLoading] = useState(false);
  const [shareSourcesRefreshing, setShareSourcesRefreshing] = useState(false);
  const [shareSourceAction, setShareSourceAction] = useState<string | null>(
    null,
  );
  const [pendingShareRevoke, setPendingShareRevoke] =
    useState<PendingShareRevoke | null>(null);

  const [shareCreationUrl, setShareCreationUrl] = useState<string | null>(null);
  const activeJobIdRef = useRef<string | null>(null);
  const analysisAbortRef = useRef<AbortController | null>(null);
  const analysisCancelledRef = useRef(false);
  const undoScenarioTimerRef = useRef<number | null>(null);
  const activeLocalIdRef = useRef<string | null>(null);
  const activeScenarioGenerationRef = useRef(0);
  const sessionIdRef = useRef<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const importGcgInputRef = useRef<HTMLInputElement>(null);

  draftStateRef.current = draftState;
  activeLocalIdRef.current = activeLocalId;
  sessionIdRef.current = sessionId;
  scenarioListRef.current = scenarioList;
  const preserveActiveDraftAsOrphan = (localId: string, title: string) => {
    if (activeLocalIdRef.current !== localId) return;
    activeLocalIdRef.current = null;
    setActiveLocalId(null);
    setOrphanedScenarioTitle(title);
    setScenarioDirty(true);
    setStatus(
      "This scenario changed or was removed elsewhere · keep a copy to save it",
    );
  };
  const adoptScenarioFromAnotherTab = (
    scenario: ScenarioRecord,
    status = "Scenario refreshed from another tab",
  ) => {
    activeScenarioGenerationRef.current = scenario.localGeneration ?? 0;
    setDraftState(draftStateFromUnknown(scenario.state));
    setSessionId(scenario.sessionId);
    setRevision(scenario.revision);
    setScenarioDirty(scenario.dirty);
    pendingOpenStatusRef.current = status;
    setSessionReady(false);
    setConnectionState("connecting");
    setSessionAttempt((attempt) => attempt + 1);
    setStatus(status);
  };
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
  const replayIndex = draftState.metadata?.replayCursor ?? null;
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
    if (selectedMoveIndex === null || !moves[selectedMoveIndex])
      return visibleCells;
    return previewCellsForMove(visibleCells, moves[selectedMoveIndex]);
  }, [moves, selectedMoveIndex, visibleCells]);
  const visibleFilledCount = Object.keys(visibleCells).length;
  const gamePlayers = useMemo(
    () =>
      replayFrames.length > 0 && draftState.metadata?.players?.length === 2
        ? [...draftState.metadata.players].sort(
            (left, right) => left.id - right.id,
          )
        : null,
    [draftState.metadata?.players, replayFrames.length],
  );
  const playerName = (abbreviation: string | null | undefined) =>
    draftState.metadata?.players
      ?.find((player) => player.abbreviation === abbreviation)
      ?.name.replace(/_/g, " ") ??
    abbreviation?.replace(/_/g, " ") ??
    "Unknown";
  const finalFrame =
    replayFrames.length > 0 ? replayFrames[replayFrames.length - 1] : null;
  // The decision (turn) about to be made at the replay cursor, if any.
  const replayDecision =
    isReplaying &&
    activeReplayIndex !== null &&
    isDecisionRecord(draftState.history[activeReplayIndex])
      ? draftState.history[activeReplayIndex]
      : null;
  const replayMover = isReplaying
    ? (replayDecision?.player ?? replayFrame?.currentPlayer ?? null)
    : (draftState.metadata?.finalPlayer ?? null);
  const gameOver =
    !isReplaying &&
    finalFrame !== null &&
    draftState.history.some((entry) => entry.kind === "end-bonus");
  const scoreboard = gamePlayers
    ? gamePlayers.map((player) => ({
        name: player.name.replace(/_/g, " "),
        abbreviation: player.abbreviation,
        score:
          (isReplaying ? replayFrame?.scores : finalFrame?.scores)?.[
            player.abbreviation
          ] ?? 0,
        active: !gameOver && player.abbreviation === replayMover,
      }))
    : null;
  const visibleScores = draftState.position.scores;
  const playedMoveIndex = useMemo(() => {
    if (!replayDecision || !replayFrame) return null;
    const index = moves.findIndex((move) =>
      candidateMatchesRecord(
        move,
        replayDecision,
        replayFrames[(activeReplayIndex ?? 0) + 1]?.board ?? replayFrame.board,
      ),
    );
    return index >= 0 ? index : null;
  }, [activeReplayIndex, moves, replayDecision, replayFrame, replayFrames]);
  const lastMoveCells = useMemo(() => {
    const frame = isReplaying ? replayFrame : finalFrame;
    return new Set(
      (frame?.placed ?? []).map((cell) => cell.row * SIZE + cell.col),
    );
  }, [finalFrame, isReplaying, replayFrame]);
  const visibleTurn = replayFrame?.turn ?? draftState.position.turn;

  useEffect(() => {
    let cancelled = false;
    const pinnedActiveId = activeLocalIdRef.current;
    setConnectionState("connecting");
    setSessionReady(false);
    setStatus(
      sessionAttempt === 0 ? "Starting session…" : "Reconnecting session…",
    );
    void (async () => {
      let scenario: ScenarioRecord | null = null;
      const share = readShareFragment();
      if (share) {
        // A share token is a bearer capability. Remove it from the address
        // bar/history before the request so failures or reloads cannot
        // accidentally redeem it again.
        window.history.replaceState(
          null,
          "",
          `${window.location.pathname}${window.location.search}`,
        );
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
          if (!(await saveScenario(scenario).catch(() => false))) {
            throw new Error("scenario_removed");
          }
          await setActiveScenario(scenario.localId).catch(() => undefined);
        } catch {
          setStatus("Share link unavailable · opening the last local scenario");
        }
      }
      if (!scenario && pinnedActiveId) {
        scenario = await getScenario(pinnedActiveId).catch(() => null);
        if (!scenario) {
          const title =
            scenarioListRef.current.find(
              (item) => item.localId === pinnedActiveId,
            )?.title ?? "Removed scenario";
          activeLocalIdRef.current = null;
          setActiveLocalId(null);
          setOrphanedScenarioTitle(title);
          setScenarioDirty(true);
          setConnectionState("offline");
          setStatus(
            "This scenario is no longer saved in this browser · save a copy to reconnect",
          );
          return;
        }
      }
      if (!scenario && !pinnedActiveId && orphanedScenarioTitle) {
        setConnectionState("offline");
        setStatus(
          "This scenario was removed from this browser · save a copy to reconnect",
        );
        return;
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
        await saveScenario(scenario).catch(() => false);
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
        await saveScenario(scenario).catch(() => false);
      }
      if (cancelled) return;

      const localState = draftStateFromUnknown(scenario.state);
      activeLocalIdRef.current = scenario.localId;
      activeScenarioGenerationRef.current = scenario.localGeneration ?? 0;
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
        if (cancelled || activeLocalIdRef.current !== scenario.localId) return;
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
          if (cancelled || activeLocalIdRef.current !== scenario.localId)
            return;
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

        if (cancelled || activeLocalIdRef.current !== scenario.localId) return;
        // Do not clobber edits the user made while the session was connecting.
        const currentDraft = draftStateRef.current ?? localState;
        const editedWhileConnecting = currentDraft !== localState;
        if (!editedWhileConnecting) setDraftState(restoredState);
        setSessionId(data.session.id);
        setRevision(nextRevision);
        setScenarioDirty(editedWhileConnecting || nextDirty);
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
        } else if (pendingOpenStatusRef.current) {
          setStatus(pendingOpenStatusRef.current);
        } else {
          setStatus(nextDirty ? "Recovered local draft" : "Session ready");
        }
        pendingOpenStatusRef.current = null;
        const updatedScenario: ScenarioRecord = {
          ...scenario,
          sessionId: data.session.id,
          state: editedWhileConnecting ? currentDraft : nextState,
          revision: nextRevision,
          dirty: editedWhileConnecting || nextDirty,
          savedAt: new Date().toISOString(),
          lastOpenedAt: new Date().toISOString(),
        };
        const saved = await saveScenario(updatedScenario, false).catch(
          () => false,
        );
        if (!saved) {
          const latest = await getScenario(scenario.localId).catch(() => null);
          if (cancelled || activeLocalIdRef.current !== scenario.localId)
            return;
          if (!latest) {
            preserveActiveDraftAsOrphan(scenario.localId, scenario.title);
            return;
          }
          if (
            (latest.localGeneration ?? 0) !==
            activeScenarioGenerationRef.current
          ) {
            if (editedWhileConnecting) {
              preserveActiveDraftAsOrphan(scenario.localId, latest.title);
            } else {
              adoptScenarioFromAnotherTab(latest);
            }
            return;
          }
          setScenarioDirty(true);
          setStatus(
            "Local draft could not be saved · export JSON before leaving",
          );
          return;
        }
        setScenarioList(await listScenarios().catch(() => [updatedScenario]));
      } catch (error) {
        if (cancelled || activeLocalIdRef.current !== scenario.localId) return;
        pendingOpenStatusRef.current = null;
        setSessionReady(false);
        setConnectionState("offline");
        const currentDraft = draftStateRef.current;
        const editedWhileConnecting =
          currentDraft !== null && currentDraft !== localState;
        if (!editedWhileConnecting) setDraftState(localState);
        setSessionId(scenario.sessionId);
        setRevision(scenario.revision);
        setScenarioDirty(editedWhileConnecting || scenario.dirty);
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

  useEffect(
    () =>
      subscribeToScenarioEvents((event) => {
        void Promise.all([listScenarios(), listShareSources()])
          .then(([scenarios, sources]) => {
            setScenarioList(scenarios);
            setShareSources(sources);
          })
          .catch(() => undefined);
        if (event.type === "sources-changed") {
          setShareSourceViews((previous) => ({
            ...previous,
            [event.sessionId]: {
              ...previous[event.sessionId],
              status: "unchecked",
            },
          }));
          return;
        }
        if (event.type !== "removed") return;
        const removedActiveId = activeLocalIdRef.current;
        if (!removedActiveId || !event.localIds.includes(removedActiveId))
          return;
        const title =
          scenarioListRef.current.find(
            (scenario) => scenario.localId === removedActiveId,
          )?.title ?? "Removed scenario";
        preserveActiveDraftAsOrphan(removedActiveId, title);
      }),
    [],
  );

  useEffect(
    () => () => {
      if (undoScenarioTimerRef.current !== null)
        window.clearTimeout(undoScenarioTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!hydrated || !activeLocalId) return;
    const scenarioId = activeLocalId;
    const draftSnapshot = draftState;
    const sessionSnapshot = sessionId;
    const revisionSnapshot = revision;
    const dirtySnapshot = scenarioDirty;
    let cancelled = false;
    void getScenario(scenarioId)
      .then(async (existing) => {
        if (
          cancelled ||
          activeLocalIdRef.current !== scenarioId ||
          sessionIdRef.current !== sessionSnapshot ||
          draftStateRef.current !== draftSnapshot
        )
          return;
        if (!existing) {
          preserveActiveDraftAsOrphan(
            scenarioId,
            scenarioListRef.current.find((item) => item.localId === scenarioId)
              ?.title ?? "Removed scenario",
          );
          return;
        }
        if (
          (existing.localGeneration ?? 0) !==
          activeScenarioGenerationRef.current
        ) {
          if (dirtySnapshot)
            preserveActiveDraftAsOrphan(scenarioId, existing.title);
          else adoptScenarioFromAnotherTab(existing);
          return;
        }
        const saved = await saveScenario(
          {
            ...existing,
            // Keep the generation observed when this scenario was activated.
            // Re-reading a newer generation here could let an old tab overwrite
            // a remove/Undo performed elsewhere.
            localGeneration: activeScenarioGenerationRef.current,
            sessionId: sessionSnapshot,
            revision: revisionSnapshot,
            state: draftSnapshot,
            dirty: dirtySnapshot,
            savedAt: new Date().toISOString(),
            lastOpenedAt: new Date().toISOString(),
          },
          false,
        );
        if (!saved) {
          const latest = await getScenario(scenarioId).catch(() => null);
          if (cancelled || activeLocalIdRef.current !== scenarioId) return;
          if (
            !latest ||
            (latest.localGeneration ?? 0) !==
              activeScenarioGenerationRef.current
          ) {
            if (dirtySnapshot)
              preserveActiveDraftAsOrphan(
                scenarioId,
                latest?.title ?? existing.title,
              );
            else if (latest) adoptScenarioFromAnotherTab(latest);
            else preserveActiveDraftAsOrphan(scenarioId, existing.title);
            return;
          }
          setScenarioDirty(true);
          setStatus(
            "Local draft could not be saved · export JSON before leaving",
          );
          return;
        }
        setScenarioList(await listScenarios().catch(() => []));
      })
      .catch(() => {
        if (!cancelled && activeLocalIdRef.current === scenarioId) {
          setScenarioDirty(true);
          setStatus(
            "Local draft could not be saved · export JSON before leaving",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeLocalId, draftState, hydrated, revision, scenarioDirty, sessionId]);

  const moveReplayCursor = (index: number | null, message?: string) => {
    if (replayFrames.length === 0 || !draftState.metadata?.players) return;
    stopAnalysisForScenarioSwitch();
    const players = draftState.metadata.players;
    setDraftState((previous) => {
      const metadata = previous.metadata ?? {};
      // Capture the editable final position the first time replay starts.
      const final: FinalPositionSnapshot =
        metadata.finalPosition ??
        (metadata.replayCursor === undefined
          ? {
              rack: previous.position.rack,
              scores: previous.position.scores,
              turn: previous.position.turn,
            }
          : {
              rack: "",
              scores: previous.position.scores,
              turn: previous.position.turn,
            });
      const last = replayFrames.length - 1;
      const bounded =
        index === null ? null : Math.max(0, Math.min(index, last));
      const position = replayPositionAt(
        replayFrames,
        previous.history,
        players,
        bounded ?? last,
        final,
      );
      const { replayCursor: _previousCursor, ...rest } = metadata;
      return {
        ...previous,
        position,
        metadata: {
          ...rest,
          finalPosition: final,
          ...(bounded === null ? {} : { replayCursor: bounded }),
        },
      };
    });
    setSelectedRackIndex(null);
    setScenarioDirty(true);
    clearAnalysisResults();
    if (message) setStatus(message);
  };

  useEffect(() => {
    if (!isReplaying) return;
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.closest(
          "input, select, textarea, [role=dialog], [role=alertdialog]",
        ) ||
          target.closest(".board"))
      )
        return;
      if (event.key === "ArrowRight") {
        event.preventDefault();
        moveReplayCursor((activeReplayIndex ?? 0) + 1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        moveReplayCursor((activeReplayIndex ?? 0) - 1);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  const startReplay = () =>
    moveReplayCursor(
      0,
      "Replay started · step through the game or analyze any turn",
    );
  const setReplayCursor = (index: number) => moveReplayCursor(index);
  const returnToFinal = () =>
    moveReplayCursor(null, "Returned to final position");

  const branchFromReplay = () => {
    if (!isReplaying || activeReplayIndex === null) return;
    const title = draftState.metadata?.title || "Imported game";
    const branched: SessionStateDraft = {
      ...draftState,
      history: [],
      metadata: {
        description: `Branched from ${title} after record ${activeReplayIndex}.`,
        lexiconHint: draftState.metadata?.lexiconHint,
        sourceUrl: draftState.metadata?.sourceUrl,
      },
    };
    pendingOpenStatusRef.current =
      "Editable copy created · the imported game is unchanged";
    void createScenario(
      "new",
      `${title.slice(0, 40)} · record ${activeReplayIndex}`,
      branched,
      { kind: "new" },
    );
  };

  const clearAnalysisResults = () => {
    setBoardWarnings([]);
    setMoves([]);
    setSelectedMoveIndex(null);
    setRetryAvailable(false);
  };

  const markPositionEdited = (
    message: string,
    update: (previous: SessionStateDraft) => SessionStateDraft,
    rackOnly = false,
  ) => {
    if (isReplaying) return;
    setDraftState((previous) => {
      const next = update(previous);
      if (
        rackOnly &&
        previous.metadata?.format === "gcg" &&
        previous.history.length > 0
      ) {
        // A rack change does not alter the recorded board history.
        const final = next.metadata?.finalPosition;
        if (final)
          next.metadata = {
            ...next.metadata,
            finalPosition: { ...final, rack: next.position.rack },
          };
      } else if (
        previous.metadata?.format === "gcg" &&
        previous.history.length > 0
      ) {
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
      true,
    );
  };

  const removeRackTile = (index: number) => {
    if (isReplaying) return;
    markPositionEdited(
      "Removed a tile from the rack",
      (previous) => ({
        ...previous,
        position: {
          ...previous.position,
          rack: [...previous.position.rack]
            .filter((_, tileIndex) => tileIndex !== index)
            .join(""),
        },
      }),
      true,
    );
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
    markPositionEdited(
      "Rack shuffled",
      (previous) => ({
        ...previous,
        position: { ...previous.position, rack: letters.join("") },
      }),
      true,
    );
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

  const persistSession = async (): Promise<SessionPersistResult | null> => {
    if (!sessionId) return null;
    const requestSessionId = sessionId;
    const requestLocalId = activeLocalIdRef.current;
    const requestRevision = revision;
    const requestState = draftState;
    const requestDraftVersion = draftWriteVersionRef.current;
    let response: Response;
    try {
      response = await fetch(apiUrl(`/api/v1/sessions/${requestSessionId}`), {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: requestRevision,
          state: requestState,
        }),
      });
    } catch (error) {
      if (
        activeLocalIdRef.current !== requestLocalId ||
        sessionIdRef.current !== requestSessionId
      )
        return null;
      throw error;
    }
    // A scenario can be switched/removed while this network request is in
    // flight. Its response belongs only to the scenario/session that issued it.
    if (
      activeLocalIdRef.current !== requestLocalId ||
      sessionIdRef.current !== requestSessionId
    )
      return null;
    if (response.status === 409) {
      setStatus("Session changed in another tab");
      return null;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as SessionResponse;
    if (
      activeLocalIdRef.current !== requestLocalId ||
      sessionIdRef.current !== requestSessionId
    )
      return null;
    const draftChangedDuringSave =
      draftWriteVersionRef.current !== requestDraftVersion;
    setRevision(data.session.revision);
    setSessionReady(true);
    setConnectionState("online");
    setScenarioDirty(draftChangedDuringSave);
    return {
      revision: data.session.revision,
      draftVersion: requestDraftVersion,
      draftChangedDuringSave,
    };
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

  const activateScenario = async (
    scenario: ScenarioRecord,
    closeScenarios = true,
    allowOrphanedDraft = false,
  ): Promise<boolean> => {
    const previousActiveId = activeLocalIdRef.current;
    if (!previousActiveId && orphanedScenarioTitle && !allowOrphanedDraft) {
      setStatus("Save a copy of the removed draft before switching scenarios");
      return false;
    }
    if (previousActiveId === scenario.localId) {
      const latest = await getScenario(previousActiveId).catch(() => null);
      if (!latest) {
        stopAnalysisForScenarioSwitch();
        const title =
          scenarioListRef.current.find(
            (item) => item.localId === previousActiveId,
          )?.title ?? scenario.title;
        preserveActiveDraftAsOrphan(previousActiveId, title);
        return false;
      }
      if ((latest.localGeneration ?? 0) > activeScenarioGenerationRef.current) {
        stopAnalysisForScenarioSwitch();
        if (scenarioDirty) {
          preserveActiveDraftAsOrphan(previousActiveId, latest.title);
          return false;
        }
        adoptScenarioFromAnotherTab(latest);
      }
      if (closeScenarios) setScenariosOpen(false);
      return true;
    }
    const outgoingDraft = draftStateRef.current ?? draftState;
    const outgoingSessionId = sessionId;
    const outgoingRevision = revision;
    const outgoingDirty = scenarioDirty;
    stopAnalysisForScenarioSwitch();
    setScenarioBusy(true);
    setSessionReady(false);
    setConnectionState("connecting");
    setStatus(`Opening ${scenario.title}…`);
    let outgoingCanRestore = false;
    let outgoingRestoreDraft = outgoingDraft;
    let outgoingRestoreSessionId = outgoingSessionId;
    let outgoingRestoreRevision = outgoingRevision;
    let outgoingRestoreDirty = outgoingDirty;
    try {
      if (previousActiveId) {
        // Detach first so queued autosaves stop starting. Advance the local
        // generation on the outgoing snapshot to fence writes already queued.
        activeLocalIdRef.current = null;
        setActiveLocalId(null);
        const previous = await getScenario(previousActiveId);
        if (!previous) {
          if (outgoingDirty) {
            setOrphanedScenarioTitle(
              scenarioListRef.current.find(
                (item) => item.localId === previousActiveId,
              )?.title ?? "Removed scenario",
            );
            setScenarioDirty(true);
            setStatus(
              "Previous scenario was removed elsewhere · save a copy before switching",
            );
            return false;
          }
        } else if (
          (previous.localGeneration ?? 0) !==
          activeScenarioGenerationRef.current
        ) {
          if (outgoingDirty) {
            setOrphanedScenarioTitle(previous.title);
            setScenarioDirty(true);
            setStatus(
              "Scenario changed in another tab · save a copy before switching",
            );
            return false;
          }
          // A clean editor yields to the newer persisted version without
          // writing this tab's older generation over another tab's changes.
          outgoingRestoreDraft = draftStateFromUnknown(previous.state);
          outgoingRestoreSessionId = previous.sessionId;
          outgoingRestoreRevision = previous.revision;
          outgoingRestoreDirty = previous.dirty;
          outgoingCanRestore = true;
        } else {
          const saved = await saveScenario(
            {
              ...previous,
              sessionId: outgoingSessionId ?? previous.sessionId,
              revision: outgoingRevision,
              state: outgoingDraft,
              dirty: outgoingDirty,
              savedAt: new Date().toISOString(),
              lastOpenedAt: new Date().toISOString(),
            },
            false,
            true,
          );
          if (!saved) {
            const latest = await getScenario(previousActiveId);
            if (outgoingDirty) {
              setOrphanedScenarioTitle(previous.title);
              setScenarioDirty(true);
              setStatus(
                "Scenario changed in another tab · save a copy before switching",
              );
              return false;
            }
            if (latest) {
              outgoingRestoreDraft = draftStateFromUnknown(latest.state);
              outgoingRestoreSessionId = latest.sessionId;
              outgoingRestoreRevision = latest.revision;
              outgoingRestoreDirty = latest.dirty;
              outgoingCanRestore = true;
            }
          } else {
            outgoingCanRestore = true;
          }
        }
      }

      const requested: ScenarioRecord = {
        ...scenario,
        lastOpenedAt: new Date().toISOString(),
        savedAt: new Date().toISOString(),
      };
      const latest = await getScenario(requested.localId);
      if (!latest && requested.sessionId !== null)
        throw new Error("scenario_removed");
      const activation = latest
        ? {
            ...latest,
            lastOpenedAt: requested.lastOpenedAt,
            savedAt: requested.savedAt,
          }
        : requested;
      if (!(await saveScenario(activation, false)))
        throw new Error("scenario_removed");
      await setActiveScenario(requested.localId);
      activeLocalIdRef.current = requested.localId;
      activeScenarioGenerationRef.current = activation.localGeneration ?? 0;
      setOrphanedScenarioTitle(null);
      setActiveLocalId(requested.localId);
      setDraftState(draftStateFromUnknown(activation.state));
      setSessionId(activation.sessionId);
      setRevision(activation.revision);
      setScenarioDirty(activation.dirty);
      setSelectedRackIndex(null);
      setSelectedPaletteTile(null);
      setSelectedMoveIndex(null);
      setBlankPickerIndex(null);
      setMoves([]);
      setRetryAvailable(false);
      if (closeScenarios) setScenariosOpen(false);
      setSessionAttempt((attempt) => attempt + 1);
      setScenarioList(await listScenarios());
      return true;
    } catch (error) {
      if (previousActiveId) {
        const previous = await getScenario(previousActiveId).catch(() => null);
        if (previous && (outgoingCanRestore || !outgoingDirty)) {
          let restoredActive = false;
          try {
            await setActiveScenario(previous.localId);
            restoredActive = true;
          } catch {
            restoredActive = false;
          }
          if (restoredActive) {
            activeLocalIdRef.current = previous.localId;
            activeScenarioGenerationRef.current = previous.localGeneration ?? 0;
            setActiveLocalId(previous.localId);
            setDraftState(
              outgoingCanRestore
                ? outgoingRestoreDraft
                : draftStateFromUnknown(previous.state),
            );
            setSessionId(
              outgoingCanRestore
                ? outgoingRestoreSessionId
                : previous.sessionId,
            );
            setRevision(
              outgoingCanRestore ? outgoingRestoreRevision : previous.revision,
            );
            setScenarioDirty(
              outgoingCanRestore ? outgoingRestoreDirty : previous.dirty,
            );
            setConnectionState("connecting");
            setSessionReady(false);
            setSessionAttempt((attempt) => attempt + 1);
          }
        } else if (outgoingDirty) {
          const title =
            scenarioListRef.current.find(
              (item) => item.localId === previousActiveId,
            )?.title ?? "Removed scenario";
          activeLocalIdRef.current = null;
          setActiveLocalId(null);
          setOrphanedScenarioTitle(title);
          setDraftState(outgoingDraft);
          setSessionId(outgoingSessionId);
          setRevision(outgoingRevision);
          setScenarioDirty(true);
        } else {
          activeLocalIdRef.current = null;
          setActiveLocalId(null);
        }
      }
      setScenarioList(await listScenarios().catch(() => []));
      setStatus(
        error instanceof Error && error.message.includes("removed")
          ? "Scenario was removed in another tab · choose another"
          : "Scenario could not be opened · retry",
      );
      return false;
    } finally {
      setScenarioBusy(false);
    }
  };

  const createScenario = async (
    kind: ScenarioKind,
    title: string,
    state: SessionStateDraft,
    source: ScenarioSource,
    keepScenarioDrawerOpen = false,
    allowOrphanedDraft = false,
  ): Promise<boolean> => {
    const timestamp = new Date().toISOString();
    return activateScenario(
      {
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
      },
      !keepScenarioDrawerOpen,
      allowOrphanedDraft,
    );
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

  const saveOrphanedScenarioCopy = () => {
    if (!orphanedScenarioTitle) return;
    void createScenario(
      "new",
      `${orphanedScenarioTitle.slice(0, 48)} · recovered copy`,
      draftState,
      { kind: "new" },
      true,
      true,
    );
  };

  const removeScenarioFromBrowser = async () => {
    const requested = scenarioRemovalCandidate;
    if (!requested) return;
    setScenarioRemovalBusy(true);
    let detachedActive = false;
    let deletion: DeletedScenario | null = null;
    try {
      const latest = await getScenario(requested.localId);
      if (!latest) {
        setScenarioList(await listScenarios().catch(() => []));
        if (activeLocalIdRef.current === requested.localId) {
          preserveActiveDraftAsOrphan(requested.localId, requested.title);
        }
        setStatus("Scenario was already removed · list refreshed");
        setScenarioRemovalCandidate(null);
        return;
      }
      const isActive = activeLocalIdRef.current === latest.localId;
      if (isActive) {
        if (
          (latest.localGeneration ?? 0) !== activeScenarioGenerationRef.current
        ) {
          setScenarioRemovalCandidate(null);
          if (scenarioDirty) {
            preserveActiveDraftAsOrphan(latest.localId, latest.title);
          } else {
            adoptScenarioFromAnotherTab(
              latest,
              "Scenario changed in another tab · refreshed; review it before removing",
            );
          }
          return;
        }
        // Stop starting autosaves for this ID before capturing its latest
        // editor state. Bumping the local generation makes already-queued
        // older writes fail their IndexedDB compare-and-save check.
        stopAnalysisForScenarioSwitch();
        activeLocalIdRef.current = null;
        setActiveLocalId(null);
        detachedActive = true;
        const saved = await saveScenario(
          {
            ...latest,
            sessionId,
            revision,
            state: draftState,
            dirty: scenarioDirty,
            savedAt: new Date().toISOString(),
            lastOpenedAt: new Date().toISOString(),
          },
          false,
          true,
        );
        if (!saved) throw new Error("scenario_removed");
        const currentList = await listScenarios();
        const fallback = currentList.find(
          (scenario) => scenario.localId !== latest.localId,
        );
        const switched = fallback
          ? await activateScenario(fallback, false)
          : await createScenario(
              "new",
              `New game · ${formatScenarioTime()}`,
              freshPositionState(randomOpeningRack()),
              { kind: "new" },
              true,
            );
        if (!switched) {
          const recovery = await getScenario(latest.localId);
          if (recovery) await activateScenario(recovery, false);
          throw new Error("fallback_unavailable");
        }
        setScenariosOpen(true);
        setScenarioTab("scenarios");
      }

      deletion = await deleteScenario(latest.localId);
      const completedDeletion = deletion;
      if (!completedDeletion) throw new Error("scenario_removed");
      setScenarioList(await listScenarios().catch(() => []));
      setScenarioRemovalCandidate(null);
      setUndoScenarioDeletion(completedDeletion);
      if (undoScenarioTimerRef.current !== null)
        window.clearTimeout(undoScenarioTimerRef.current);
      undoScenarioTimerRef.current = window.setTimeout(() => {
        setUndoScenarioDeletion((current) =>
          current?.deletionId === completedDeletion.deletionId ? null : current,
        );
        undoScenarioTimerRef.current = null;
      }, 10_000);
      setStatus(
        `Removed “${latest.title}” from this browser · share links are unchanged`,
      );
    } catch (error) {
      if (detachedActive && !deletion) {
        const recovery = await getScenario(requested.localId).catch(() => null);
        if (recovery) await activateScenario(recovery, false);
      }
      setStatus(
        error instanceof Error && error.message === "fallback_unavailable"
          ? "Could not switch scenarios · removal cancelled"
          : "Scenario could not be removed · refresh and retry",
      );
    } finally {
      setScenarioRemovalBusy(false);
    }
  };

  const undoScenarioRemoval = async () => {
    const deletion = undoScenarioDeletion;
    if (!deletion) return;
    setScenarioRemovalBusy(true);
    try {
      const restored = await restoreDeletedScenario(deletion);
      if (!restored) {
        setStatus(
          "Undo expired or scenario changed · the current scenario was not overwritten",
        );
        setUndoScenarioDeletion(null);
        return;
      }
      if (undoScenarioTimerRef.current !== null)
        window.clearTimeout(undoScenarioTimerRef.current);
      undoScenarioTimerRef.current = null;
      setUndoScenarioDeletion(null);
      setScenarioList(await listScenarios());
      setStatus(
        `Restored “${restored.title}” to this browser · it was not opened`,
      );
    } catch {
      setStatus("Scenario could not be restored · refresh and retry");
    } finally {
      setScenarioRemovalBusy(false);
    }
  };

  const loadShareSources = async () => {
    setShareSourcesLoading(true);
    try {
      const sources = await listShareSources();
      setShareSources(sources);
      setShareSourceViews((previous) =>
        Object.fromEntries(
          sources.map((source) => [
            source.sessionId,
            previous[source.sessionId] ?? {
              status: "unchecked",
              links: [],
              notices: [],
            },
          ]),
        ),
      );
    } catch {
      setStatus("Share sources unavailable · retry");
    } finally {
      setShareSourcesLoading(false);
    }
  };

  const checkShareSource = async (source: ShareSourceRecord) => {
    setShareSourceViews((previous) => ({
      ...previous,
      [source.sessionId]: {
        ...previous[source.sessionId],
        status: "checking",
        links: previous[source.sessionId]?.links ?? [],
        notices: previous[source.sessionId]?.notices ?? [],
      },
    }));
    try {
      const collection = await fetchShareCollection(source.sessionId);
      setShareSourceViews((previous) => ({
        ...previous,
        [source.sessionId]: {
          status: "ready",
          checkedAt: new Date().toISOString(),
          ...collection,
        },
      }));
    } catch (error) {
      const status =
        !navigator.onLine || error instanceof TypeError
          ? "offline"
          : "unavailable";
      setShareSourceViews((previous) => ({
        ...previous,
        [source.sessionId]: { ...previous[source.sessionId], status },
      }));
    }
  };

  const refreshAllShareSources = async (force = true) => {
    setShareSourcesRefreshing(true);
    try {
      const sources = await listShareSources();
      setShareSources(sources);
      setShareSourceViews((previous) =>
        Object.fromEntries(
          sources.map((source) => [
            source.sessionId,
            previous[source.sessionId] ?? {
              status: "unchecked",
              links: [],
              notices: [],
            },
          ]),
        ),
      );
      const sourcesToCheck = force
        ? sources
        : sources.filter((source) => {
            const view = shareSourceViews[source.sessionId];
            return (
              view?.status !== "ready" ||
              !view.checkedAt ||
              Date.now() - Date.parse(view.checkedAt) > 60_000
            );
          });
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, sourcesToCheck.length) }, async () => {
          for (;;) {
            const index = next++;
            if (index >= sourcesToCheck.length) return;
            await checkShareSource(sourcesToCheck[index]!);
          }
        }),
      );
    } finally {
      setShareSourcesRefreshing(false);
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
    if (scenariosOpen && scenarioTab === "shares")
      void refreshAllShareSources(false);
  }, [scenariosOpen, scenarioTab]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (shareCreationUrl) {
        setShareCreationUrl(null);
        return;
      }
      if (pendingShareRevoke) {
        setPendingShareRevoke(null);
        return;
      }

      if (scenarioRemovalCandidate && !scenarioRemovalBusy) {
        setScenarioRemovalCandidate(null);
        return;
      }
      if (lexiconPrompt) {
        lexiconPrompt(null);
        return;
      }
      setBlankPickerIndex(null);
      setSettingsOpen(false);
      setScenariosOpen(false);
      setAboutOpen(false);
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [
    lexiconPrompt,
    pendingShareRevoke,
    scenarioRemovalBusy,
    scenarioRemovalCandidate,
    shareCreationUrl,
  ]);

  const revokeShareLink = async (sourceSessionId: string, shareId: string) => {
    setShareSourceAction(`${sourceSessionId}:${shareId}`);
    try {
      const response = await fetch(
        apiUrl(`/api/v1/sessions/${sourceSessionId}/share/${shareId}`),
        {
          method: "DELETE",
          credentials: "include",
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const source = shareSources.find(
        (item) => item.sessionId === sourceSessionId,
      );
      if (source) await checkShareSource(source);
    } catch {
      setShareSourceViews((previous) => ({
        ...previous,
        [sourceSessionId]: {
          ...previous[sourceSessionId],
          status: "unavailable",
        },
      }));
    } finally {
      setShareSourceAction(null);
    }
  };

  const dismissShareNotice = async (
    sourceSessionId: string,
    shareId: string,
  ) => {
    setShareSourceAction(`${sourceSessionId}:${shareId}`);
    try {
      const response = await fetch(
        apiUrl(`/api/v1/sessions/${sourceSessionId}/share-notices/${shareId}`),
        {
          method: "DELETE",
          credentials: "include",
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const source = shareSources.find(
        (item) => item.sessionId === sourceSessionId,
      );
      if (source) await checkShareSource(source);
    } catch {
      setShareSourceViews((previous) => ({
        ...previous,
        [sourceSessionId]: {
          ...previous[sourceSessionId],
          status: "unavailable",
        },
      }));
    } finally {
      setShareSourceAction(null);
    }
  };

  const confirmShareRevocation = async () => {
    const pending = pendingShareRevoke;
    if (!pending) return;
    setPendingShareRevoke(null);
    await revokeShareLink(pending.sourceSessionId, pending.shareId);
  };

  const copyShareCreationUrl = async () => {
    if (!shareCreationUrl) return;
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard unavailable · select and copy the one-time URL");
      return;
    }
    try {
      await navigator.clipboard.writeText(shareCreationUrl);
      setStatus("Share link copied · keep the URL somewhere safe");
    } catch {
      setStatus("Clipboard unavailable · select and copy the one-time URL");
    }
  };

  const createShareLinkForSource = async (
    sourceSessionId: string,
    sourceTitle: string,
    sourceLocalId: string | null,
  ) => {
    const response = await fetch(
      apiUrl(`/api/v1/sessions/${sourceSessionId}/share`),
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
        sourceRevision?: unknown;
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
    ) {
      throw new Error("invalid_share_response");
    }
    const shareUrl = new URL(
      `/#/share/${data.share.sourceSessionId}/${data.share.token}`,
      window.location.origin,
    ).toString();
    // Keep the one-time URL in volatile UI state immediately. It is never
    // persisted in IndexedDB, even if a later management-list request fails.
    setShareCreationUrl(shareUrl);
    let managementHandleSaved = true;
    try {
      await rememberShareSource(
        data.share.sourceSessionId,
        sourceTitle,
        sourceLocalId,
      );
      await loadShareSources();
    } catch {
      managementHandleSaved = false;
    }
    setShareSources((previous) =>
      previous.some(
        (source) => source.sessionId === data.share!.sourceSessionId,
      )
        ? previous
        : [
            {
              sessionId: data.share!.sourceSessionId as string,
              title: sourceTitle,
              localId: sourceLocalId,
              firstSeenAt: new Date().toISOString(),
              lastSeenAt: new Date().toISOString(),
            },
            ...previous,
          ],
    );
    try {
      const collection = await fetchShareCollection(sourceSessionId);
      setShareSourceViews((previous) => ({
        ...previous,
        [sourceSessionId]: {
          status: "ready",
          checkedAt: new Date().toISOString(),
          ...collection,
        },
      }));
    } catch {
      setShareSourceViews((previous) => ({
        ...previous,
        [sourceSessionId]: { status: "unavailable", links: [], notices: [] },
      }));
    }
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareUrl);
        copied = true;
      }
    } catch {
      copied = false;
    }
    setStatus(
      managementHandleSaved
        ? copied
          ? "Share link created and copied · keep this one-time URL"
          : "Share link created · copy the one-time URL"
        : "Share link created · copy the URL now; local management data could not be saved",
    );
  };

  const shareScenario = async () => {
    if (!sessionId || !sessionReady) {
      setStatus("Session unavailable · reconnect before sharing");
      return;
    }
    const sourceSessionId = sessionId;
    const sourceLocalId = activeLocalIdRef.current;
    const sourceTitle =
      draftState.metadata?.title ??
      scenarioList.find((scenario) => scenario.localId === sourceLocalId)
        ?.title ??
      "Shared scenario";
    try {
      if (scenarioDirty) {
        const persisted = await persistSession();
        if (persisted === null) throw new Error("session_conflict");
        if (
          persisted.draftChangedDuringSave ||
          draftWriteVersionRef.current !== persisted.draftVersion
        ) {
          throw new Error("position_changed_while_saving");
        }
      }
      if (
        activeLocalIdRef.current !== sourceLocalId ||
        sessionIdRef.current !== sourceSessionId
      )
        return;
      await createShareLinkForSource(
        sourceSessionId,
        sourceTitle,
        sourceLocalId,
      );
    } catch (error) {
      if (
        activeLocalIdRef.current !== sourceLocalId ||
        sessionIdRef.current !== sourceSessionId
      )
        return;
      setStatus(
        error instanceof Error && error.message === "session_conflict"
          ? "Session changed · reconnect before sharing"
          : error instanceof Error &&
              error.message === "position_changed_while_saving"
            ? "Position changed while saving · share again"
            : "Share link unavailable · retry",
      );
    }
  };

  const createShareFromManager = async (source: ShareSourceRecord) => {
    setShareSourceAction(`${source.sessionId}:create`);
    try {
      if (source.localId !== null && source.localId === activeLocalId) {
        if (!sessionReady || sessionId !== source.sessionId)
          throw new Error("source_session_unavailable");
        if (scenarioDirty) {
          const persisted = await persistSession();
          if (persisted === null) throw new Error("session_conflict");
          if (
            persisted.draftChangedDuringSave ||
            draftWriteVersionRef.current !== persisted.draftVersion
          ) {
            throw new Error("position_changed_while_saving");
          }
        }
      } else if (source.localId) {
        const savedScenario = await getScenario(source.localId);
        if (savedScenario?.dirty) throw new Error("local_changes");
      }
      await createShareLinkForSource(
        source.sessionId,
        source.title,
        source.localId,
      );
    } catch (error) {
      if (error instanceof Error && error.message === "local_changes") {
        setStatus(
          "Open this scenario and analyze/save its local changes before sharing them",
        );
      } else if (
        error instanceof Error &&
        error.message === "session_conflict"
      ) {
        setStatus("Session changed · reconnect before sharing");
      } else if (
        error instanceof Error &&
        error.message === "position_changed_while_saving"
      ) {
        setStatus("Position changed while saving · share again");
      } else {
        setStatus(
          "Could not create a link from this source · check owner access and retry",
        );
      }
    } finally {
      setShareSourceAction(null);
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
    prevalidated?: GcgValidationResponse,
  ): Promise<boolean> => {
    try {
      const decoded = decodeGcgBytes(bytes);
      const localParsed = parseGcg(decoded.text);
      const localLexiconResolution = resolveLexiconHint(
        localParsed.lexiconHint,
      );
      if (localLexiconResolution === "unsupported")
        throw new Error("unsupported_lexicon");
      let validation = prevalidated;
      if (!validation) {
        const validationResponse = await fetch(apiUrl("/api/v1/imports/gcg"), {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: bytes,
        });
        if (validationResponse.status === 422)
          throw new GcgImportError(
            await apiErrorMessage(
              validationResponse,
              "the file is not valid GCG",
            ),
          );
        if (!validationResponse.ok)
          throw new Error("server_gcg_validation_failed");
        validation = (await validationResponse.json()) as GcgValidationResponse;
      }
      if (!isObject(validation) || !isObject(validation.document))
        throw new Error("server_gcg_validation_failed");
      const parsed = validation.document as unknown as GcgImportResult;
      // A GCG #lexicon line wins; otherwise accept the dictionary the source
      // page declared (e.g. Cross-Tables "Dictionary: NWL23").
      const lexiconInfo = (validation as GcgValidationResponse).lexicon;
      const sourceHint =
        isObject(lexiconInfo) && typeof lexiconInfo.hint === "string"
          ? lexiconInfo.hint
          : null;
      const effectiveHint = parsed.lexiconHint ?? sourceHint;
      const lexiconResolution = resolveLexiconHint(effectiveHint);
      if (lexiconResolution === "unsupported")
        throw new Error("unsupported_lexicon");
      let importedLexicon: LexiconId =
        lexiconResolution === "csw24" ? "csw24" : "nwl23";
      if (lexiconResolution === "missing") {
        const choice = await askLexicon();
        if (!choice) throw new Error("lexicon_not_confirmed");
        importedLexicon = choice;
      }
      if (parsed.finalRack.length > 7) throw new Error("rack_too_large");
      const importedAt = new Date().toISOString();
      const matchup =
        parsed.players.length === 2
          ? [...parsed.players]
              .sort((left, right) => left.id - right.id)
              .map((player) => player.name.replace(/_/g, " "))
              .join(" vs ")
          : "";
      const title =
        parsed.title.trim() ||
        matchup ||
        `Imported GCG · ${filename.slice(0, 40)}`;
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
            lexiconHint:
              effectiveHint ??
              (importedLexicon === "csw24" ? "CSW24" : "NWL23"),
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
            finalPosition: {
              rack: parsed.finalRack,
              scores: parsed.scores,
              turn: parsed.turn,
            },
          },
        },
      );
      const lexiconLabel = importedLexicon === "csw24" ? "CSW24" : "NWL2023";
      const importedMessage =
        parsed.warnings.length > 0
          ? `Imported GCG · ${lexiconLabel} · ${parsed.warnings[0]}`
          : `Imported ${parsed.history.length} records · ${lexiconLabel} · use Replay game to step through and analyze`;
      pendingOpenStatusRef.current = importedMessage;
      await createScenario("imported", title, state, {
        kind: "imported",
        format: "gcg",
        filename: filename.slice(0, 128),
        ...(sourceUrl ? { sourceUrl } : {}),
      });
      setStatus(importedMessage);
      return true;
    } catch (error) {
      if (error instanceof GcgImportError) {
        setStatus(`GCG import failed · ${error.message}`);
      } else if (error instanceof GcgParseError) {
        setStatus(`GCG import failed · ${error.message}`);
      } else if (error instanceof Error && error.message === "rack_too_large") {
        setStatus("GCG import failed · final rack has more than 7 tiles");
      } else if (
        error instanceof Error &&
        error.message === "unsupported_lexicon"
      ) {
        setStatus(
          "GCG import blocked · dictionary is not enabled (NWL2023 and CSW24 are supported)",
        );
      } else if (
        error instanceof Error &&
        error.message === "lexicon_not_confirmed"
      ) {
        setStatus("GCG import cancelled · dictionary mapping required");
      } else {
        setStatus(
          `GCG import failed · ${error instanceof TypeError ? "network unavailable" : "the file could not be validated"}`,
        );
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
    setStatus(`Fetching Cross-Tables game ${link.gameId}…`);
    try {
      const response = await fetch(apiUrl("/api/v1/imports/cross-tables"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: link.url }),
      });
      if (!response.ok) {
        setStatus(
          `Cross-Tables import failed · ${await apiErrorMessage(response, "service unavailable")} · you can download the .gcg and use Import GCG`,
        );
        return;
      }
      const result = (await response.json()) as GcgValidationResponse & {
        gcgBase64?: unknown;
      };
      if (typeof result.gcgBase64 !== "string")
        throw new Error("invalid_response");
      const binary = atob(result.gcgBase64);
      const gcgBytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1)
        gcgBytes[index] = binary.charCodeAt(index);
      const imported = await importGcgBytes(
        gcgBytes.buffer,
        `cross-tables-${link.gameId}.gcg`,
        link.url,
        result,
      );
      if (imported) setCrossTablesUrl("");
    } catch (error) {
      setStatus(
        `Cross-Tables import failed · ${error instanceof TypeError ? "network unavailable" : "unexpected response"} · you can download the .gcg and use Import GCG`,
      );
    } finally {
      setCrossTablesBusy(false);
    }
  };

  const pollDeepJob = async (
    jobId: string,
    signal: AbortSignal,
    requestSessionId: string,
    requestLocalId: string | null,
    requestDraftVersion: number,
  ): Promise<void> => {
    for (;;) {
      if (
        sessionIdRef.current !== requestSessionId ||
        activeLocalIdRef.current !== requestLocalId
      ) {
        throw new Error("scenario_switched_during_analysis");
      }
      if (draftWriteVersionRef.current !== requestDraftVersion) {
        throw new Error("position_changed_during_analysis");
      }
      const response = await fetch(
        apiUrl(`/api/v1/sessions/${requestSessionId}/analysis/jobs/${jobId}`),
        {
          credentials: "include",
          signal,
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as AnalysisJobResponse;
      if (
        sessionIdRef.current !== requestSessionId ||
        activeLocalIdRef.current !== requestLocalId
      ) {
        throw new Error("scenario_switched_during_analysis");
      }
      if (draftWriteVersionRef.current !== requestDraftVersion) {
        throw new Error("position_changed_during_analysis");
      }
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
        setBoardWarnings(warningWords(job.result?.board_warnings));
        setSelectedMoveIndex(null);
        setStatus("Deep analysis complete");
        return;
      } else if (job.status === "interrupted") {
        throw new Error("job_interrupted");
      } else if (job.status === "cancelled") {
        throw new Error("job_cancelled");
      } else {
        if (job.error?.code === "invalid_position" && job.error.message)
          throw new GcgImportError(job.error.message);
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
    const requestSessionId = sessionId;
    const requestLocalId = activeLocalIdRef.current;
    const controller = new AbortController();
    analysisAbortRef.current = controller;
    setAnalyzing(true);
    setAnalysisPhase("saving");
    setStatus("Saving position…");
    let warmingTimer: number | undefined;
    try {
      const persisted = await persistSession();
      if (persisted === null) throw new Error("session_conflict");
      if (
        persisted.draftChangedDuringSave ||
        draftWriteVersionRef.current !== persisted.draftVersion
      ) {
        throw new Error("position_changed_before_analysis");
      }
      const persistedRevision = persisted.revision;
      const requestDraftVersion = persisted.draftVersion;
      if (analysisMode === "deep") {
        setAnalysisPhase("queued");
        setStatus("Queueing deep analysis…");
        const idempotencyKey = crypto.randomUUID();
        const response = await fetch(
          apiUrl(`/api/v1/sessions/${requestSessionId}/analysis/jobs`),
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
        if (
          sessionIdRef.current !== requestSessionId ||
          activeLocalIdRef.current !== requestLocalId
        ) {
          throw new Error("scenario_switched_during_analysis");
        }
        if (draftWriteVersionRef.current !== requestDraftVersion) {
          await fetch(
            apiUrl(
              `/api/v1/sessions/${requestSessionId}/analysis/jobs/${created.job.id}`,
            ),
            {
              method: "DELETE",
              credentials: "include",
            },
          ).catch(() => undefined);
          throw new Error("position_changed_during_analysis");
        }
        await pollDeepJob(
          created.job.id,
          controller.signal,
          requestSessionId,
          requestLocalId,
          requestDraftVersion,
        );
      } else {
        setAnalysisPhase("starting");
        setStatus("Starting analysis engine…");
        warmingTimer = window.setTimeout(() => {
          setAnalysisPhase("warming");
          setStatus("Waking analysis engine…");
        }, 900);
        const response = await fetch(
          apiUrl(`/api/v1/sessions/${requestSessionId}/moves/generate`),
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
          if (response.status === 422)
            throw new GcgImportError(await analysisErrorMessage(response));
          throw new Error(`HTTP ${response.status}`);
        }
        const result = await response.json();
        if (
          sessionIdRef.current !== requestSessionId ||
          activeLocalIdRef.current !== requestLocalId
        ) {
          throw new Error("scenario_switched_during_analysis");
        }
        if (draftWriteVersionRef.current !== requestDraftVersion) {
          throw new Error("position_changed_during_analysis");
        }
        setMoves(Array.isArray(result?.moves) ? result.moves : []);
        setBoardWarnings(warningWords(result?.boardWarnings));
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
        error.message === "position_changed_before_analysis"
      ) {
        setRetryAvailable(false);
        setStatus(
          "Position changed while saving · analyze the current position",
        );
      } else if (
        error instanceof Error &&
        error.message === "position_changed_during_analysis"
      ) {
        const jobId = activeJobIdRef.current;
        if (jobId) {
          await fetch(
            apiUrl(
              `/api/v1/sessions/${requestSessionId}/analysis/jobs/${jobId}`,
            ),
            {
              method: "DELETE",
              credentials: "include",
            },
          ).catch(() => undefined);
        }
        setRetryAvailable(false);
        setStatus(
          "Position changed during analysis · stale results were discarded",
        );
      } else if (
        error instanceof Error &&
        error.message === "scenario_switched_during_analysis"
      ) {
        setRetryAvailable(false);
        setStatus("Scenario changed · stale analysis results were discarded");
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
      } else if (error instanceof GcgImportError) {
        setRetryAvailable(false);
        setStatus(`Cannot analyze · ${error.message}`);
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
    if (!LEXICON_DETAILS[lexiconId].deepAnalysis) setAnalysisMode("fast");
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
  const displayedScenarios = scenarioList.filter(
    (scenario, index) =>
      index < MAX_LOCAL_SCENARIOS ||
      scenario.dirty ||
      scenario.localId === activeLocalId,
  );
  // Keep zero-link sources visible so owners can create a replacement link
  // from the manager even after revoking the last link.
  const displayedShareSources = shareSources;

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

        {draftState.metadata?.forkedFrom && !isReplaying && (
          <p class="fork-note" role="status">
            Forked from shared scenario revision{" "}
            {draftState.metadata.forkedFrom.sourceRevision}. This session is
            independent.
          </p>
        )}

        {orphanedScenarioTitle && (
          <p class="fork-note orphaned-scenario-note" role="status">
            “{orphanedScenarioTitle}” changed or was removed in another tab.
            Your open draft is still here.
            <button
              class="text-button"
              type="button"
              onClick={saveOrphanedScenarioCopy}
            >
              Save a copy
            </button>
          </p>
        )}

        <div class="analysis-layout">
          <section class="board-column" aria-label="Position editor">
            <div class="score-row">
              {scoreboard ? (
                scoreboard.map((player) => (
                  <div
                    class={`score-card ${player.active ? "active" : ""}`}
                    key={player.abbreviation}
                  >
                    <span class="score-name">{player.name}</span>
                    <strong>{player.score}</strong>
                    <small>
                      {player.active
                        ? isReplaying
                          ? replayDecision
                            ? "to play"
                            : "on turn"
                          : "on turn"
                        : gameOver
                          ? "final"
                          : "\u00a0"}
                    </small>
                  </div>
                ))
              ) : (
                <>
                  <div class="score-card active">
                    <span>You</span>
                    <strong>{visibleScores.onTurn}</strong>
                    <small>on turn</small>
                  </div>
                  <div class="score-card">
                    <span>Opponent</span>
                    <strong>{visibleScores.opponent}</strong>
                    <small>unknown rack</small>
                  </div>
                </>
              )}
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
                        class={`board-cell ${premium} ${cell ? "occupied" : ""} ${isPreview ? "preview-tile" : ""} ${activeCellIndex === index && !isReplaying ? "active-cell" : ""} ${cell?.blank ? "blank-tile" : ""} ${!isPreview && lastMoveCells.has(index) ? "last-move" : ""}`}
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
            {replayFrames.length > 1 && (
              <section class="replay-panel" aria-label="Game replay">
                <div class="replay-heading">
                  <div>
                    <span class="eyebrow">GAME REPLAY</span>
                    <strong>
                      {isReplaying
                        ? `Record ${activeReplayIndex} of ${draftState.history.length}`
                        : gameOver
                          ? "Final position · game over"
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
                        class="secondary-button step-button"
                        type="button"
                        aria-label="First"
                        title="First record"
                        onClick={() => setReplayCursor(0)}
                        disabled={activeReplayIndex === 0}
                      >
                        ⏮
                      </button>
                      <button
                        class="secondary-button step-button"
                        type="button"
                        aria-label="Previous"
                        title="Previous record (←)"
                        onClick={() =>
                          setReplayCursor((activeReplayIndex ?? 0) - 1)
                        }
                        disabled={activeReplayIndex === 0}
                      >
                        ◀
                      </button>
                      <input
                        class="replay-slider"
                        type="range"
                        min={0}
                        max={replayFrames.length - 1}
                        value={activeReplayIndex ?? 0}
                        aria-label="Replay position"
                        onInput={(event) =>
                          setReplayCursor(Number(event.currentTarget.value))
                        }
                      />
                      <button
                        class="secondary-button step-button"
                        type="button"
                        aria-label="Next"
                        title="Next record (→)"
                        onClick={() =>
                          setReplayCursor((activeReplayIndex ?? 0) + 1)
                        }
                        disabled={activeReplayIndex === replayFrames.length - 1}
                      >
                        ▶
                      </button>
                      <button
                        class="secondary-button step-button"
                        type="button"
                        aria-label="Final record"
                        title="Final record"
                        onClick={() => setReplayCursor(replayFrames.length - 1)}
                        disabled={activeReplayIndex === replayFrames.length - 1}
                      >
                        ⏭
                      </button>
                    </div>
                    <div class="replay-event" aria-live="polite">
                      {replayFrame?.event ? (
                        <p>
                          <span class="replay-label">Last</span>
                          <strong>
                            {playerName(replayFrame.event.player)}
                          </strong>{" "}
                          {describeRecord(replayFrame.event, replayFrame.board)}
                        </p>
                      ) : (
                        <p>
                          <span class="replay-label">Start</span>Empty board ·
                          no moves yet
                        </p>
                      )}
                      {replayFrame?.event?.note && (
                        <p class="replay-note">{replayFrame.event.note}</p>
                      )}
                      {replayDecision ? (
                        <>
                          <p>
                            <span class="replay-label">To play</span>
                            <strong>
                              {playerName(replayDecision.player)}
                            </strong>{" "}
                            holds{" "}
                            <span class="replay-rack">
                              {replayDecision.rack || "?"}
                            </span>{" "}
                            · played{" "}
                            <span class="replay-played">
                              {describeRecord(
                                replayDecision,
                                replayFrames[(activeReplayIndex ?? 0) + 1]
                                  ?.board ?? null,
                              )}
                            </span>
                          </p>
                          {replayDecision.rack.length < 7 &&
                            (replayFrame?.board.length ?? 0) + 7 < 100 && (
                              <p class="replay-partial">
                                Only {replayDecision.rack.length} of this
                                player's tiles were recorded (annotators often
                                record just the tiles they know or played).
                                Analysis uses these tiles only.
                              </p>
                            )}
                        </>
                      ) : activeReplayIndex !== null &&
                        activeReplayIndex < draftState.history.length ? (
                        <p>
                          <span class="replay-label">Next</span>
                          {playerName(
                            draftState.history[activeReplayIndex]?.player,
                          )}{" "}
                          ·{" "}
                          {describeRecord(
                            draftState.history[activeReplayIndex]!,
                            replayFrames[activeReplayIndex + 1]?.board ?? null,
                          )}
                        </p>
                      ) : (
                        <p>
                          <span class="replay-label">End</span>
                          {gamePlayers
                            ? gamePlayers
                                .map(
                                  (player) =>
                                    `${player.name.replace(/_/g, " ")} ${replayFrame?.scores[player.abbreviation] ?? 0}`,
                                )
                                .join(" · ")
                            : "Final record"}
                        </p>
                      )}
                    </div>
                    <div class="replay-actions">
                      <button
                        class="text-button"
                        type="button"
                        onClick={branchFromReplay}
                      >
                        Edit a copy from here
                      </button>
                      <button
                        class="text-button"
                        type="button"
                        onClick={returnToFinal}
                      >
                        Return to final
                      </button>
                    </div>
                  </>
                )}
              </section>
            )}
            <div class="rack-panel">
              <div class="rack-heading">
                <span class="eyebrow">
                  {isReplaying
                    ? replayDecision
                      ? `${playerName(replayDecision.player).toUpperCase()}'S RACK`
                      : activeReplayIndex === replayFrames.length - 1
                        ? "FINAL RACK SNAPSHOT"
                        : "NO RACK AT THIS RECORD"
                    : scoreboard && draftState.metadata?.finalPlayer
                      ? `${playerName(draftState.metadata.finalPlayer).toUpperCase()}'S RACK`
                      : "YOUR RACK"}
                </span>
                {!isReplaying && (
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
                )}
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
              {!isReplaying && (
                <>
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
                          direction === "horizontal"
                            ? "vertical"
                            : "horizontal",
                        )
                      }
                    >
                      {boardDirection === "horizontal" ? "Across" : "Down"}
                    </button>
                  </div>
                  <div
                    class="tile-keyboard"
                    aria-label={
                      rackEditMode
                        ? "Rack tile keyboard"
                        : "Board tile keyboard"
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
                </>
              )}
              <p class="hint" aria-live="polite">
                {isReplaying
                  ? replayDecision
                    ? "History position · analyze to compare Quackle's choices with the move played."
                    : "History position · this record is not a turn decision."
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
              {!isReplaying && (
                <button
                  class="secondary-button"
                  type="button"
                  onClick={() =>
                    markPositionEdited("Board cleared", (previous) =>
                      stateForCells({}, previous),
                    )
                  }
                >
                  Clear board
                </button>
              )}
              <button
                class="primary-button"
                type="button"
                onClick={() => void analyze()}
                disabled={
                  analyzing ||
                  !sessionReady ||
                  (isReplaying && (!replayDecision || !replayDecision.rack))
                }
              >
                {isReplaying &&
                !analyzing &&
                (!replayDecision || !replayDecision.rack)
                  ? "No turn to analyze"
                  : isReplaying && !analyzing && !retryAvailable && sessionReady
                    ? "Analyze this turn"
                    : analysisLabel}
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
                  {orphanedScenarioTitle
                    ? "This open draft no longer has a saved scenario handle."
                    : "Draft stays on this device while the session reconnects."}
                </span>
                <button
                  class="text-button"
                  type="button"
                  onClick={
                    orphanedScenarioTitle
                      ? saveOrphanedScenarioCopy
                      : reconnectSession
                  }
                >
                  {orphanedScenarioTitle ? "Save a copy" : "Reconnect session"}
                </button>
              </div>
            )}
            {boardWarnings.length > 0 && (
              <p class="engine-note" role="status">
                Board contains {boardWarnings.length === 1 ? "a word" : "words"}{" "}
                not in {lexicon.displayName}: {boardWarnings.join(", ")}.
                Quackle analyzes the position anyway.
              </p>
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
                    const played = playedMoveIndex === index;
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
                        class={`move-row ${selectedMoveIndex === index ? "selected" : ""} ${played ? "played" : ""}`}
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
                          <strong>
                            {label}
                            {played && <span class="played-badge">PLAYED</span>}
                          </strong>
                          <small>
                            {move.action === "place"
                              ? move.horizontal === false
                                ? "down"
                                : "across"
                              : move.action}
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
                {replayDecision && moves.length > 0 && (
                  <p class="played-summary" role="status">
                    {playedMoveIndex === null
                      ? `Played ${describeRecord(replayDecision, replayFrames[(activeReplayIndex ?? 0) + 1]?.board ?? null)} is not among these ${moves.length} candidates.`
                      : playedMoveIndex === 0
                        ? "The move played matches Quackle's top choice."
                        : `The move played ranks #${playedMoveIndex + 1}${typeof moves[playedMoveIndex]?.equity === "number" && typeof moves[0]?.equity === "number" ? `, ${(moves[0].equity! - moves[playedMoveIndex].equity!).toFixed(1)} equity behind the top choice` : ""}.`}
                  </p>
                )}
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
                  {!lexicon.deepAnalysis
                    ? " (unavailable for this lexicon)"
                    : ""}
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
                CSW24 deep analysis uses Quackle's upstream CSW superleaves with
                its default English worths and win-probability tables.
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
            <div class="share-disclosure">
              <p>
                Links have no scheduled expiry, but per-session limits may
                remove the oldest automatically. Anyone with a link can create
                an independent fork; revoking a link does not change existing
                forks. The link is shown only once when created.
              </p>
              <button
                class="text-button"
                type="button"
                onClick={() => {
                  setSettingsOpen(false);
                  setScenariosOpen(true);
                  setScenarioTab("shares");
                }}
              >
                Manage share links
              </button>
            </div>
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
              Paste a Cross-Tables annotated-game link (annotated.php?u=…). The
              game and its declared dictionary are fetched and validated by the
              service; nothing else on the page is used.
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
                <span class="eyebrow">SCENARIOS & SHARING</span>
                <h2 id="scenarios-title">Your workspace</h2>
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
            <div
              class="scenario-tabs"
              role="tablist"
              aria-label="Workspace lists"
            >
              <button
                type="button"
                role="tab"
                aria-selected={scenarioTab === "scenarios"}
                onClick={() => setScenarioTab("scenarios")}
              >
                Scenarios
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={scenarioTab === "shares"}
                onClick={() => setScenarioTab("shares")}
              >
                Share links
              </button>
            </div>
            {orphanedScenarioTitle && (
              <p class="fork-note orphaned-scenario-note" role="status">
                “{orphanedScenarioTitle}” changed or was removed in another tab;
                this tab still has the open draft.
                <button
                  class="text-button"
                  type="button"
                  onClick={saveOrphanedScenarioCopy}
                >
                  Save a copy
                </button>
              </p>
            )}
            {scenarioTab === "scenarios" ? (
              <>
                <div class="scenario-create-actions">
                  <button
                    class="primary-button scenario-new-button"
                    type="button"
                    onClick={createNewGame}
                    disabled={scenarioBusy || scenarioRemovalBusy}
                  >
                    New game <small>random opening rack</small>
                  </button>
                  <button
                    class="secondary-button scenario-new-button"
                    type="button"
                    onClick={createBlankPosition}
                    disabled={scenarioBusy || scenarioRemovalBusy}
                  >
                    Blank position
                  </button>
                </div>
                <p class="scenario-note">
                  New game starts with an empty board and a fresh random rack,
                  like Quackle. Use Blank position to set up a historical or
                  hypothetical position manually.
                </p>
                <p class="scenario-note">
                  This browser shows the {MAX_LOCAL_SCENARIOS} most recent
                  scenarios plus any local drafts and the current one. Removing
                  a saved copy here does not revoke share links or remove
                  recipient forks.
                </p>
                {undoScenarioDeletion && (
                  <div class="scenario-undo" role="status">
                    <span>
                      Removed “{undoScenarioDeletion.scenario.title}” from this
                      browser. Shares are unchanged.
                    </span>
                    <button
                      class="text-button"
                      type="button"
                      onClick={() => void undoScenarioRemoval()}
                      disabled={scenarioRemovalBusy}
                    >
                      Undo
                    </button>
                  </div>
                )}
                <div class="scenario-list" aria-label="Recent scenarios">
                  {displayedScenarios.map((scenario) => (
                    <div
                      class={`scenario-item ${scenario.localId === activeLocalId ? "active" : ""}`}
                      key={scenario.localId}
                      data-local-scenario-id={scenario.localId}
                    >
                      <button
                        class="scenario-item-open"
                        type="button"
                        onClick={() => void activateScenario(scenario)}
                        disabled={scenarioBusy || scenarioRemovalBusy}
                        aria-current={
                          scenario.localId === activeLocalId
                            ? "true"
                            : undefined
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
                          {scenario.localId === activeLocalId
                            ? " · current"
                            : ""}
                        </span>
                      </button>
                      <button
                        class="scenario-remove-button"
                        type="button"
                        onClick={() => setScenarioRemovalCandidate(scenario)}
                        disabled={scenarioBusy || scenarioRemovalBusy}
                        aria-label={`Remove scenario ${scenario.title} from this browser`}
                        title="Remove from this browser"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  {displayedScenarios.length === 0 && (
                    <p class="scenario-empty">No saved scenarios yet.</p>
                  )}
                </div>
              </>
            ) : (
              <section class="share-manager" aria-label="Share link management">
                <p class="scenario-note">
                  Links have no scheduled expiry, but per-session quotas may
                  remove the oldest automatically. This manager stores
                  source-session handles only—not bearer URLs, share tokens, or
                  capability cookies. Each source's owner cookie renews when
                  that source is successfully checked/used and expires after 30
                  days without a request to that source; the link may still work
                  if owner access is unavailable.
                </p>
                <div class="share-links-heading">
                  <strong>Known share sources</strong>
                  <button
                    class="text-button"
                    type="button"
                    onClick={() => void refreshAllShareSources()}
                    disabled={
                      shareSources.length === 0 ||
                      shareSourcesLoading ||
                      shareSourcesRefreshing ||
                      shareSourceAction !== null
                    }
                  >
                    {shareSourcesLoading
                      ? "Loading…"
                      : shareSourcesRefreshing
                        ? "Checking…"
                        : "Refresh all"}
                  </button>
                </div>
                <div class="share-source-list">
                  {displayedShareSources.map((source) => {
                    const view = shareSourceViews[source.sessionId] ?? {
                      status: "unchecked" as const,
                      links: [],
                      notices: [],
                    };
                    const actionPending =
                      shareSourceAction?.startsWith(`${source.sessionId}:`) ??
                      false;
                    const viewLabel =
                      view.status === "unchecked"
                        ? "Not checked"
                        : view.status === "checking"
                          ? "Checking…"
                          : view.status === "ready"
                            ? `${view.links.length} active ${view.links.length === 1 ? "link" : "links"}`
                            : view.status === "offline"
                              ? "Offline · link status unknown"
                              : "Owner access unavailable · link status unknown";
                    return (
                      <article class="share-source-card" key={source.sessionId}>
                        <div class="share-source-heading">
                          <div>
                            <strong>{source.title}</strong>
                            <small>
                              {source.localId
                                ? "Saved scenario"
                                : "Source scenario removed from this browser"}{" "}
                              · {viewLabel}
                              {view.checkedAt
                                ? ` · checked ${scenarioTimeLabel(view.checkedAt)}`
                                : ""}
                            </small>
                          </div>
                          <div class="share-source-actions">
                            <button
                              class="text-button"
                              type="button"
                              onClick={() => void checkShareSource(source)}
                              disabled={
                                actionPending || view.status === "checking"
                              }
                            >
                              {view.status === "checking"
                                ? "Checking…"
                                : view.status === "ready"
                                  ? "Refresh"
                                  : "Check"}
                            </button>
                            {view.status === "ready" && (
                              <button
                                class="text-button"
                                type="button"
                                onClick={() =>
                                  void createShareFromManager(source)
                                }
                                disabled={actionPending}
                              >
                                {shareSourceAction ===
                                `${source.sessionId}:create`
                                  ? "Creating…"
                                  : view.links.length > 0
                                    ? "Create another link"
                                    : "Create link"}
                              </button>
                            )}
                          </div>
                        </div>
                        {!source.localId && view.status === "ready" && (
                          <p class="share-manager-warning">
                            Creating a link shares the source session’s last
                            saved server snapshot. It cannot recover an older
                            URL or include unsaved changes from the removed
                            local scenario.
                          </p>
                        )}
                        {(view.status === "offline" ||
                          view.status === "unavailable") && (
                          <p class="share-manager-warning">
                            The source could not be authorized. The share link
                            may still work; reconnect to verify or revoke it.
                          </p>
                        )}
                        {view.notices.map((notice) => (
                          <div
                            class="share-link-notice"
                            key={notice.shareId}
                            role="status"
                          >
                            <div>
                              <strong>Link removed automatically</strong>
                              <small>
                                Revision {notice.sourceRevision} ·{" "}
                                {notice.reason === "storage_limit"
                                  ? "storage pressure"
                                  : "active-link limit"}{" "}
                                · created {scenarioTimeLabel(notice.createdAt)}
                              </small>
                            </div>
                            <button
                              class="text-button"
                              type="button"
                              onClick={() =>
                                void dismissShareNotice(
                                  source.sessionId,
                                  notice.shareId,
                                )
                              }
                              disabled={actionPending}
                            >
                              {shareSourceAction ===
                              `${source.sessionId}:${notice.shareId}`
                                ? "Dismissing…"
                                : "Dismiss"}
                            </button>
                          </div>
                        ))}
                        {view.links.map((share) => (
                          <div class="share-link-row" key={share.shareId}>
                            <div>
                              <strong>Revision {share.sourceRevision}</strong>
                              <small>
                                No scheduled expiry · {share.useCount}{" "}
                                {share.useCount === 1 ? "fork" : "forks"} ·
                                created {scenarioTimeLabel(share.createdAt)}
                              </small>
                            </div>
                            <button
                              class="text-button destructive-text-button"
                              type="button"
                              onClick={() =>
                                setPendingShareRevoke({
                                  sourceSessionId: source.sessionId,
                                  shareId: share.shareId,
                                  title: source.title,
                                })
                              }
                              disabled={actionPending}
                            >
                              Revoke
                            </button>
                          </div>
                        ))}
                      </article>
                    );
                  })}
                  {displayedShareSources.length === 0 &&
                    !shareSourcesLoading && (
                      <p class="scenario-empty">
                        {shareSources.length > 0
                          ? "No active links in the checked sources. Create a new link from a source here or from scenario settings."
                          : "No known share sources. Create a share link from a scenario to manage it here."}
                      </p>
                    )}
                </div>
              </section>
            )}
          </section>
        </div>
      )}
      {scenarioRemovalCandidate && (
        <div
          class="drawer-backdrop choice-backdrop"
          role="presentation"
          onClick={() =>
            !scenarioRemovalBusy && setScenarioRemovalCandidate(null)
          }
        >
          <section
            class="blank-picker confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="scenario-remove-title"
            aria-describedby="scenario-remove-copy"
            onClick={(event) => event.stopPropagation()}
          >
            <div class="drawer-heading">
              <div>
                <span class="eyebrow">LOCAL SCENARIO</span>
                <h2 id="scenario-remove-title">Remove from this browser?</h2>
              </div>
              <button
                class="icon-button"
                type="button"
                onClick={() => setScenarioRemovalCandidate(null)}
                aria-label="Cancel removal"
                disabled={scenarioRemovalBusy}
              >
                ×
              </button>
            </div>
            <p id="scenario-remove-copy" class="about-lede">
              “{scenarioRemovalCandidate.title}” and its saved board/history
              will be removed from this browser.
              {scenarioRemovalCandidate.dirty
                ? " It has local changes that may not be in the server session."
                : ""}{" "}
              Share links, server-side snapshots, and existing recipient forks
              are not revoked or deleted. Manage links in the Share links tab.
            </p>
            {scenarioRemovalCandidate.localId === activeLocalId && (
              <p class="scenario-note">
                This is the current scenario. We’ll open another saved scenario,
                or start a fresh game if this is the last one.
              </p>
            )}
            <div class="action-row confirm-actions">
              <button
                class="secondary-button"
                type="button"
                onClick={() => setScenarioRemovalCandidate(null)}
                disabled={scenarioRemovalBusy}
              >
                Cancel
              </button>
              <button
                class="danger-button"
                type="button"
                onClick={() => void removeScenarioFromBrowser()}
                disabled={scenarioRemovalBusy}
              >
                {scenarioRemovalBusy ? "Removing…" : "Remove from this browser"}
              </button>
            </div>
          </section>
        </div>
      )}
      {pendingShareRevoke && (
        <div
          class="drawer-backdrop choice-backdrop"
          role="presentation"
          onClick={() => setPendingShareRevoke(null)}
        >
          <section
            class="blank-picker confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="share-revoke-title"
            aria-describedby="share-revoke-copy"
            onClick={(event) => event.stopPropagation()}
          >
            <div class="drawer-heading">
              <div>
                <span class="eyebrow">SHARE LINK</span>
                <h2 id="share-revoke-title">Revoke this link?</h2>
              </div>
              <button
                class="icon-button"
                type="button"
                onClick={() => setPendingShareRevoke(null)}
                aria-label="Cancel revocation"
              >
                ×
              </button>
            </div>
            <p id="share-revoke-copy" class="about-lede">
              Future forks from “{pendingShareRevoke.title}” will be blocked.
              Existing recipient copies stay independent. This cannot be undone;
              sharing again creates a different URL.
            </p>
            <div class="action-row confirm-actions">
              <button
                class="secondary-button"
                type="button"
                onClick={() => setPendingShareRevoke(null)}
              >
                Keep link
              </button>
              <button
                class="danger-button"
                type="button"
                onClick={() => void confirmShareRevocation()}
                disabled={shareSourceAction !== null}
              >
                Revoke link
              </button>
            </div>
          </section>
        </div>
      )}

      {shareCreationUrl && (
        <div
          class="drawer-backdrop choice-backdrop"
          role="presentation"
          onClick={() => setShareCreationUrl(null)}
        >
          <section
            class="blank-picker confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="share-created-title"
            aria-describedby="share-created-copy"
            onClick={(event) => event.stopPropagation()}
          >
            <div class="drawer-heading">
              <div>
                <span class="eyebrow">ONE-TIME LINK</span>
                <h2 id="share-created-title">Share scenario</h2>
              </div>
              <button
                class="icon-button"
                type="button"
                onClick={() => setShareCreationUrl(null)}
                aria-label="Close share link"
              >
                ×
              </button>
            </div>
            <p id="share-created-copy" class="about-lede">
              Anyone with this URL can create an independent copy. This one-time
              URL is shown only now and is not saved in this browser’s manager;
              creating another link later makes a different URL.
            </p>
            <label class="share-url-label">
              Copy and keep this link
              <input
                class="share-url-input"
                type="text"
                readonly
                value={shareCreationUrl}
                onFocus={(event) => event.currentTarget.select()}
                aria-label="One-time share URL"
              />
            </label>
            <div class="action-row confirm-actions">
              <button
                class="secondary-button"
                type="button"
                onClick={() => setShareCreationUrl(null)}
              >
                Done
              </button>
              <button
                class="primary-button"
                type="button"
                onClick={() => void copyShareCreationUrl()}
              >
                Copy link
              </button>
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
      {lexiconPrompt && (
        <div
          class="drawer-backdrop choice-backdrop"
          role="presentation"
          onClick={() => lexiconPrompt(null)}
        >
          <section
            class="blank-picker"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="lexicon-prompt-title"
            aria-describedby="lexicon-prompt-body"
            onClick={(event) => event.stopPropagation()}
          >
            <div class="drawer-heading">
              <div>
                <span class="eyebrow">GCG IMPORT</span>
                <h2 id="lexicon-prompt-title">Which dictionary?</h2>
              </div>
              <button
                class="icon-button"
                type="button"
                onClick={() => lexiconPrompt(null)}
                aria-label="Cancel import"
              >
                ×
              </button>
            </div>
            <p id="lexicon-prompt-body" class="about-lede">
              This GCG file does not name its dictionary. Choose the one the
              game was played with so words are validated correctly.
            </p>
            <div class="data-actions">
              <button
                class="primary-button"
                type="button"
                onClick={() => lexiconPrompt("nwl23")}
              >
                NWL2023
              </button>
              <button
                class="secondary-button"
                type="button"
                onClick={() => lexiconPrompt("csw24")}
              >
                CSW24
              </button>
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
