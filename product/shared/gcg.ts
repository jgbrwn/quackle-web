export const MAX_GCG_BYTES = 256 * 1024;
export const MAX_GCG_LINES = 4096;
export const MAX_GCG_LINE_BYTES = 4096;
export const MAX_GCG_RECORDS = 512;
export const MAX_GCG_PLAYERS = 4;
export const MAX_GCG_METADATA_BYTES = 4096;

export type GcgDirection = "horizontal" | "vertical";
export type GcgScoreStatus = "match" | "mismatch" | "missing";

export interface GcgPlayer {
  id: number;
  abbreviation: string;
  name: string;
}

export interface GcgCell {
  row: number;
  col: number;
  letter: string;
  blank: boolean;
}

export type GcgHistoryEntry =
  | {
      kind: "place";
      player: string;
      rack: string;
      row: number;
      col: number;
      direction: GcgDirection;
      tiles: string;
      score?: number;
      total?: number;
      computedScore?: number;
      scoreStatus?: GcgScoreStatus;
      scoreDelta?: number;
      note?: string;
      annotations?: string[];
      challenged?: boolean;
    }
  | {
      kind: "pass";
      player: string;
      rack: string;
      score?: number;
      total?: number;
      note?: string;
      annotations?: string[];
    }
  | {
      kind: "exchange";
      player: string;
      rack: string;
      tiles?: string;
      blindCount?: number;
      score?: number;
      total?: number;
      note?: string;
      annotations?: string[];
    }
  | {
      kind: "challenge";
      player: string;
      rack: string;
      challengeKind: "phony" | "adjustment";
      adjustment?: number;
      score?: number;
      total?: number;
      note?: string;
      annotations?: string[];
    }
  | {
      kind: "time";
      player: string;
      rack: string;
      score?: number;
      total?: number;
      note?: string;
      annotations?: string[];
    }
  | {
      kind: "end-bonus";
      player: string;
      rack: string;
      unusedTiles: string;
      score?: number;
      total?: number;
      note?: string;
      annotations?: string[];
    };

export interface GcgPragma {
  key: string;
  value: string;
}

export interface GcgImportResult {
  title: string;
  description: string;
  players: GcgPlayer[];
  pragmas: GcgPragma[];
  notes: string[];
  lexiconHint: string | null;
  encoding: string;
  history: GcgHistoryEntry[];
  board: GcgCell[];
  playerRacks: Record<string, string>;
  finalRack: string;
  finalPlayer: string | null;
  scores: { onTurn: number; opponent: number };
  computedScores: Record<string, number>;
  turn: { number: number; scorelessTurns: number };
  warnings: string[];
}

export interface GcgReplayFrame {
  historyIndex: number;
  board: GcgCell[];
  scores: Record<string, number>;
  currentPlayer: string | null;
  turn: { number: number; scorelessTurns: number };
  event: GcgHistoryEntry | null;
}

export interface GcgExportInput {
  players?: GcgPlayer[];
  title?: string;
  description?: string;
  lexiconHint?: string;
  history: GcgHistoryEntry[];
  finalRack?: string;
  finalPlayer?: string;
  board?: GcgCell[];
}

export interface GcgExportResult {
  text: string;
  warnings: string[];
}

export class GcgParseError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GcgParseError";
  }
}

function isAsciiControl(value: string): boolean {
  const code = value.charCodeAt(0);
  return code < 0x20 && code !== 0x09;
}

function metadataSize(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedText(value: string, label: string): string {
  if (metadataSize(value) > MAX_GCG_METADATA_BYTES) {
    throw new GcgParseError(
      "metadata_too_large",
      `${label} exceeds the GCG metadata limit`,
    );
  }
  return value;
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function parseSignedInteger(value: string, label: string): number {
  if (!/^[+-]?\d+$/.test(value)) {
    throw new GcgParseError(
      "invalid_number",
      `${label} must be a signed integer`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new GcgParseError(
      "invalid_number",
      `${label} is outside the safe integer range`,
    );
  }
  return parsed;
}

function parseUnsignedInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw new GcgParseError(
      "invalid_number",
      `${label} must be an unsigned integer`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new GcgParseError(
      "invalid_number",
      `${label} is outside the safe integer range`,
    );
  }
  return parsed;
}

function validateRack(value: string, label: string): string {
  if (!/^[A-Z?]{0,15}$/.test(value)) {
    throw new GcgParseError(
      "invalid_rack",
      `${label} contains unsupported tile characters`,
    );
  }
  return value;
}

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
};

const CLASSIC_LETTER_MULTIPLIERS: readonly number[][] = [
  [1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1],
  [1, 1, 1, 1, 1, 3, 1, 1, 1, 3, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 2, 1, 2, 1, 1, 1, 1, 1, 1],
  [2, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 2],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 3, 1, 1, 1, 3, 1, 1, 1, 3, 1, 1, 1, 3, 1],
  [1, 1, 2, 1, 1, 1, 2, 1, 2, 1, 1, 1, 2, 1, 1],
  [1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1],
  [1, 1, 2, 1, 1, 1, 2, 1, 2, 1, 1, 1, 2, 1, 1],
  [1, 3, 1, 1, 1, 3, 1, 1, 1, 3, 1, 1, 1, 3, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [2, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 2],
  [1, 1, 1, 1, 1, 1, 2, 1, 2, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 3, 1, 1, 1, 3, 1, 1, 1, 1, 1],
  [1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1],
];

const CLASSIC_WORD_MULTIPLIERS: readonly number[][] = [
  [3, 1, 1, 1, 1, 1, 1, 3, 1, 1, 1, 1, 1, 1, 3],
  [1, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1],
  [1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1],
  [1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1],
  [1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [3, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 3],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1],
  [1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1],
  [1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1],
  [1, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1],
  [3, 1, 1, 1, 1, 1, 1, 3, 1, 1, 1, 1, 1, 1, 3],
];

export function classicPremiumAt(
  row: number,
  col: number,
):
  | "center"
  | "triple-word"
  | "double-word"
  | "triple-letter"
  | "double-letter"
  | "" {
  if (row < 0 || row >= 15 || col < 0 || col >= 15) return "";
  if (row === 7 && col === 7) return "center";
  const wordMultiplier = CLASSIC_WORD_MULTIPLIERS[row][col];
  if (wordMultiplier === 3) return "triple-word";
  if (wordMultiplier === 2) return "double-word";
  const letterMultiplier = CLASSIC_LETTER_MULTIPLIERS[row][col];
  if (letterMultiplier === 3) return "triple-letter";
  if (letterMultiplier === 2) return "double-letter";
  return "";
}

function collectWord(
  board: Map<string, GcgCell>,
  row: number,
  col: number,
  rowStep: number,
  colStep: number,
): GcgCell[] {
  let startRow = row;
  let startCol = col;
  while (board.has(boardIndex(startRow - rowStep, startCol - colStep))) {
    startRow -= rowStep;
    startCol -= colStep;
  }
  const cells: GcgCell[] = [];
  while (true) {
    const cell = board.get(boardIndex(startRow, startCol));
    if (!cell) break;
    cells.push(cell);
    startRow += rowStep;
    startCol += colStep;
  }
  return cells;
}

function tileValue(cell: GcgCell): number {
  return cell.blank ? 0 : (TILE_VALUES[cell.letter] ?? 0);
}

function scoreWord(cells: GcgCell[], newCells: Map<string, GcgCell>): number {
  let sum = 0;
  let wordMultiplier = 1;
  for (const cell of cells) {
    const isNew = newCells.has(boardIndex(cell.row, cell.col));
    if (isNew) {
      sum += tileValue(cell) * CLASSIC_LETTER_MULTIPLIERS[cell.row][cell.col];
      wordMultiplier *= CLASSIC_WORD_MULTIPLIERS[cell.row][cell.col];
    } else {
      sum += tileValue(cell);
    }
  }
  return sum * wordMultiplier;
}

function scorePlacement(
  board: Map<string, GcgCell>,
  newCells: Map<string, GcgCell>,
  row: number,
  col: number,
  direction: GcgDirection,
): number {
  const rowStep = direction === "vertical" ? 1 : 0;
  const colStep = direction === "horizontal" ? 1 : 0;
  const mainWord = collectWord(board, row, col, rowStep, colStep);
  let score = mainWord.length > 1 ? scoreWord(mainWord, newCells) : 0;
  const crossRowStep = direction === "vertical" ? 0 : 1;
  const crossColStep = direction === "horizontal" ? 0 : 1;
  for (const cell of newCells.values()) {
    const crossWord = collectWord(
      board,
      cell.row,
      cell.col,
      crossRowStep,
      crossColStep,
    );
    if (crossWord.length > 1) score += scoreWord(crossWord, newCells);
  }
  if (newCells.size === 7) score += 50;
  return score;
}

function parsePosition(value: string): {
  row: number;
  col: number;
  direction: GcgDirection;
} {
  const across = value.match(/^(1[0-5]|[1-9])([A-Oa-o])$/);
  if (across) {
    return {
      row: Number(across[1]) - 1,
      col: across[2].toUpperCase().charCodeAt(0) - 65,
      direction: "horizontal",
    };
  }
  const down = value.match(/^([A-Oa-o])(1[0-5]|[1-9])$/);
  if (down) {
    return {
      row: Number(down[2]) - 1,
      col: down[1].toUpperCase().charCodeAt(0) - 65,
      direction: "vertical",
    };
  }
  throw new GcgParseError("invalid_position", `invalid GCG position ${value}`);
}

function parsePrettyTiles(value: string): string {
  if (value.length < 1 || value.length > 15 || !/^[A-Za-z.]+$/.test(value)) {
    throw new GcgParseError(
      "invalid_tiles",
      "placement tiles must contain letters and play-through dots",
    );
  }
  return value;
}

function playerFor(
  players: Map<string, GcgPlayer>,
  abbreviation: string,
): GcgPlayer {
  const player = players.get(abbreviation);
  if (!player)
    throw new GcgParseError(
      "unknown_player",
      `move references unknown player ${abbreviation}`,
    );
  return player;
}

function scorePair(
  tokens: string[],
  start: number,
): { score?: number; total?: number; annotations?: string[] } {
  if (tokens.length <= start) return {};
  const score = parseSignedInteger(tokens[start], "move score");
  const total =
    tokens.length > start + 1
      ? parseSignedInteger(tokens[start + 1], "move total")
      : undefined;
  const annotations = tokens.slice(start + 2);
  if (
    annotations.length > 32 ||
    metadataSize(annotations.join(" ")) > MAX_GCG_METADATA_BYTES
  ) {
    throw new GcgParseError(
      "annotations_too_large",
      "move annotations exceed the GCG metadata limit",
    );
  }
  return { score, total, ...(annotations.length > 0 ? { annotations } : {}) };
}

function boardIndex(row: number, col: number): string {
  return `${row}:${col}`;
}

function replayPlace(
  board: Map<string, GcgCell>,
  row: number,
  col: number,
  direction: GcgDirection,
  tiles: string,
  warnings: string[],
): { placedOffsets: number[]; computedScore: number } {
  let placed = 0;
  const placedOffsets: number[] = [];
  const newCells = new Map<string, GcgCell>();
  let touchesExisting = false;
  const wasEmpty = board.size === 0;
  for (let index = 0; index < tiles.length; index += 1) {
    const currentRow = row + (direction === "vertical" ? index : 0);
    const currentCol = col + (direction === "horizontal" ? index : 0);
    if (
      currentRow < 0 ||
      currentRow >= 15 ||
      currentCol < 0 ||
      currentCol >= 15
    ) {
      throw new GcgParseError(
        "off_board",
        "placement extends beyond the classic 15×15 board",
      );
    }
    const token = tiles[index];
    const existing = board.get(boardIndex(currentRow, currentCol));
    if (token === ".") {
      if (!existing)
        throw new GcgParseError(
          "invalid_play_through",
          "play-through dot has no existing board tile",
        );
      touchesExisting = true;
      continue;
    }
    if (existing) {
      if (existing.letter !== token.toUpperCase()) {
        throw new GcgParseError(
          "occupied_square",
          "placement conflicts with an existing board tile",
        );
      }
      touchesExisting = true;
      continue;
    }
    const cell = {
      row: currentRow,
      col: currentCol,
      letter: token.toUpperCase(),
      blank: token !== token.toUpperCase(),
    };
    board.set(boardIndex(currentRow, currentCol), cell);
    newCells.set(boardIndex(currentRow, currentCol), cell);
    placed += 1;
    placedOffsets.push(index);
    for (const [neighborRow, neighborCol] of [
      [currentRow - 1, currentCol],
      [currentRow + 1, currentCol],
      [currentRow, currentCol - 1],
      [currentRow, currentCol + 1],
    ]) {
      if (board.has(boardIndex(neighborRow, neighborCol)))
        touchesExisting = true;
    }
  }
  if (placed === 0)
    throw new GcgParseError(
      "empty_placement",
      "placement must add at least one tile",
    );
  if (wasEmpty && !board.has(boardIndex(7, 7))) {
    warnings.push("opening placement does not cover the center square");
  } else if (!wasEmpty && !touchesExisting) {
    warnings.push("placement is disconnected from the existing board");
  }
  return {
    placedOffsets,
    computedScore: scorePlacement(board, newCells, row, col, direction),
  };
}

function undoPlace(
  board: Map<string, GcgCell>,
  entry: Extract<GcgHistoryEntry, { kind: "place" }>,
  offsets: number[],
): void {
  for (const index of offsets) {
    const row = entry.row + (entry.direction === "vertical" ? index : 0);
    const col = entry.col + (entry.direction === "horizontal" ? index : 0);
    board.delete(boardIndex(row, col));
  }
}
function advancePlayer(
  players: GcgPlayer[],
  current: string | null,
): string | null {
  if (players.length === 0) return null;
  if (!current) return players[0].abbreviation;
  const index = players.findIndex((player) => player.abbreviation === current);
  return (
    players[(index + 1 + players.length) % players.length]?.abbreviation ??
    players[0].abbreviation
  );
}

interface ReplayState {
  finalPlayer: string | null;
  lastPlacedOffsets: number[];
  lastPlacement: {
    historyIndex: number;
    player: string;
    computedScore: number;
  } | null;
  computedScores: Map<string, number>;
}

function checkDeclaredTotal(
  entry: GcgHistoryEntry,
  computedScores: Map<string, number>,
  warnings: string[],
): void {
  if (entry.total === undefined) return;
  const computed = computedScores.get(entry.player) ?? 0;
  if (entry.total !== computed) {
    warnings.push(
      `score total mismatch for ${entry.player}: recorded ${entry.total}, computed ${computed}`,
    );
  }
}

function applyScore(
  entry: GcgHistoryEntry,
  delta: number,
  state: ReplayState,
  warnings: string[],
): void {
  state.computedScores.set(
    entry.player,
    (state.computedScores.get(entry.player) ?? 0) + delta,
  );
  checkDeclaredTotal(entry, state.computedScores, warnings);
}

function annotatePlacementScore(
  entry: Extract<GcgHistoryEntry, { kind: "place" }>,
  computedScore: number,
  warnings: string[],
): void {
  entry.computedScore = computedScore;
  if (entry.score === undefined) {
    entry.scoreStatus = "missing";
    return;
  }
  entry.scoreDelta = entry.score - computedScore;
  entry.scoreStatus = entry.scoreDelta === 0 ? "match" : "mismatch";
  if (entry.scoreDelta !== 0) {
    warnings.push(
      `score mismatch for ${entry.player}: recorded ${entry.score}, computed ${computedScore}`,
    );
  }
}

function parsePragma(
  line: string,
  players: Map<string, GcgPlayer>,
  pragmas: GcgPragma[],
  notes: string[],
  playerRacks: Record<string, string>,
  state: {
    title: string;
    description: string;
    lexiconHint: string | null;
    encoding: string;
    finalRack: string;
  },
  history: GcgHistoryEntry[],
): void {
  const match = line.match(/^#([^\s]+)(?:\s+(.*))?$/);
  if (!match)
    throw new GcgParseError("invalid_pragma", "pragma must contain a key");
  const key = match[1];
  const value = boundedText(match[2] ?? "", `#${key}`);
  pragmas.push({ key, value });
  const playerMatch = key.match(/^player(\d+)$/i);
  if (playerMatch) {
    const id = parseUnsignedInteger(playerMatch[1], "player id");
    if (id < 1 || id > MAX_GCG_PLAYERS)
      throw new GcgParseError(
        "invalid_player",
        "player id is outside the supported range",
      );
    const parts = value.split(/\s+/);
    if (parts.length < 2 || !/^[^\s:]{1,64}$/.test(parts[0])) {
      throw new GcgParseError(
        "invalid_player",
        `#${key} requires an abbreviation and name`,
      );
    }
    const abbreviation = parts.shift()!;
    const name = boundedText(parts.join(" "), "player name");
    if (
      players.has(abbreviation) ||
      [...players.values()].some((player) => player.id === id)
    ) {
      throw new GcgParseError(
        "duplicate_player",
        `duplicate player ${abbreviation}`,
      );
    }
    players.set(abbreviation, { id, abbreviation, name });
    return;
  }
  if (key.toLowerCase() === "title") {
    state.title = value;
  } else if (key.toLowerCase() === "description") {
    state.description = value;
  } else if (
    key.toLowerCase() === "lexicon" ||
    key.toLowerCase() === "dictionary" ||
    key.toLowerCase() === "lexicon-hash"
  ) {
    state.lexiconHint = value || null;
  } else if (key.toLowerCase() === "character-encoding") {
    state.encoding = value || state.encoding;
  } else if (key.toLowerCase() === "note") {
    notes.push(value);
    const last = history[history.length - 1];
    if (last) last.note = value;
  } else if (key.match(/^rack\d+$/i)) {
    const id = key.slice(4);
    const player = [...players.values()].find(
      (candidate) => String(candidate.id) === id,
    );
    if (!player)
      throw new GcgParseError(
        "unknown_player",
        `rack pragma references unknown player ${id}`,
      );
    playerRacks[player.abbreviation] = validateRack(value, `#${key}`);
  } else if (key.toLowerCase() === "incomplete") {
    state.finalRack = validateRack(value, "#incomplete");
  }
}

function parseMoveLine(
  line: string,
  players: Map<string, GcgPlayer>,
  history: GcgHistoryEntry[],
  board: Map<string, GcgCell>,
  warnings: string[],
  state: ReplayState,
): void {
  const orderedPlayers = [...players.values()].sort(
    (left, right) => left.id - right.id,
  );
  const match = line.match(/^>\s*([^:]{1,64}):\s*(.*)$/);
  if (!match)
    throw new GcgParseError(
      "invalid_move",
      "move line must contain a player abbreviation and colon",
    );
  const player = match[1].trim();
  playerFor(players, player);
  const tokens = match[2].trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0)
    throw new GcgParseError("invalid_move", "move line is empty");
  const first = tokens.shift()!;
  if (first === "(T)" || first === "(time)") {
    const score = tokens.shift();
    if (!score)
      throw new GcgParseError("invalid_time", "time record is missing a score");
    const parsed = scorePair([score, ...tokens], 0);
    const entry: GcgHistoryEntry = {
      kind: "time",
      player,
      rack: "",
      ...parsed,
    };
    history.push(entry);
    applyScore(entry, entry.score ?? 0, state, warnings);
    state.lastPlacedOffsets = [];
    state.lastPlacement = null;
    return;
  }
  if (first.startsWith("(") && first.endsWith(")")) {
    const score = tokens.shift();
    if (!score)
      throw new GcgParseError(
        "invalid_end_bonus",
        "end bonus is missing a score",
      );
    const parsed = scorePair([score, ...tokens], 0);
    const entry: GcgHistoryEntry = {
      kind: "end-bonus",
      player,
      rack: "",
      unusedTiles: validateRack(first.slice(1, -1), "unused tiles"),
      ...parsed,
    };
    history.push(entry);
    applyScore(entry, entry.score ?? 0, state, warnings);
    state.lastPlacedOffsets = [];
    state.lastPlacement = null;
    return;
  }
  const rack = validateRack(first, "move rack");
  if (tokens.length === 0)
    throw new GcgParseError("invalid_move", "move is missing an action");
  const action = tokens.shift()!;
  if (
    action.startsWith("(") &&
    action.endsWith(")") &&
    action !== "(time)" &&
    action !== "(T)" &&
    action !== "(challenge)"
  ) {
    const parsed = scorePair(tokens, 0);
    const entry: GcgHistoryEntry = {
      kind: "end-bonus",
      player,
      rack,
      unusedTiles: validateRack(action.slice(1, -1), "unused tiles"),
      ...parsed,
    };
    history.push(entry);
    applyScore(entry, entry.score ?? 0, state, warnings);
    state.lastPlacedOffsets = [];
    state.lastPlacement = null;
    return;
  }
  if (action === "--") {
    const parsed = scorePair(tokens, 0);
    const entry: GcgHistoryEntry = {
      kind: "challenge",
      player,
      rack,
      challengeKind: "phony",
      ...parsed,
    };
    history.push(entry);
    const previous = state.lastPlacement
      ? history[state.lastPlacement.historyIndex]
      : undefined;
    if (
      previous?.kind === "place" &&
      state.lastPlacement &&
      state.lastPlacement.historyIndex === history.length - 2
    ) {
      previous.challenged = true;
      undoPlace(board, previous, state.lastPlacedOffsets);
      state.computedScores.set(
        previous.player,
        (state.computedScores.get(previous.player) ?? 0) -
          state.lastPlacement.computedScore,
      );
      checkDeclaredTotal(entry, state.computedScores, warnings);
    } else {
      warnings.push("phony challenge does not follow a placement");
      checkDeclaredTotal(entry, state.computedScores, warnings);
    }
    state.lastPlacedOffsets = [];
    state.lastPlacement = null;
    return;
  }
  if (action === "(time)" || action === "(T)") {
    const parsed = scorePair(tokens, 0);
    const entry: GcgHistoryEntry = { kind: "time", player, rack, ...parsed };
    history.push(entry);
    applyScore(entry, entry.score ?? 0, state, warnings);
    state.lastPlacedOffsets = [];
    state.lastPlacement = null;
    return;
  }
  if (action === "(challenge)") {
    const adjustmentToken = tokens.shift();
    if (!adjustmentToken)
      throw new GcgParseError(
        "invalid_challenge",
        "challenge adjustment is missing",
      );
    const adjustment = parseSignedInteger(
      adjustmentToken,
      "challenge adjustment",
    );
    const totalToken = tokens.shift();
    if (!totalToken || tokens.length > 0)
      throw new GcgParseError(
        "invalid_challenge",
        "challenge adjustment has an invalid total",
      );
    const total = parseSignedInteger(totalToken, "challenge total");
    const entry: GcgHistoryEntry = {
      kind: "challenge",
      player,
      rack,
      challengeKind: "adjustment",
      adjustment,
      total,
    };
    history.push(entry);
    applyScore(entry, adjustment, state, warnings);
    state.lastPlacedOffsets = [];
    state.lastPlacement = null;
    return;
  }
  if (action === "-" || action === "-0") {
    const parsed = scorePair(tokens, 0);
    const entry: GcgHistoryEntry = { kind: "pass", player, rack, ...parsed };
    history.push(entry);
    applyScore(entry, 0, state, warnings);
    state.finalPlayer = advancePlayer(orderedPlayers, player);
    state.lastPlacedOffsets = [];
    state.lastPlacement = null;
    return;
  }
  if (action.startsWith("-")) {
    const exchanged = action.slice(1);
    const blindCount = /^\d+$/.test(exchanged) ? Number(exchanged) : undefined;
    if (blindCount !== undefined && (blindCount < 1 || blindCount > 7)) {
      throw new GcgParseError(
        "invalid_exchange",
        "blind exchange count must be between 1 and 7",
      );
    }
    if (blindCount === undefined && !/^[A-Z?]{1,7}$/.test(exchanged)) {
      throw new GcgParseError("invalid_exchange", "exchange tiles are invalid");
    }
    const parsed = scorePair(tokens, 0);
    const entry: GcgHistoryEntry = {
      kind: "exchange",
      player,
      rack,
      ...(blindCount === undefined ? { tiles: exchanged } : { blindCount }),
      ...parsed,
    };
    history.push(entry);
    applyScore(entry, 0, state, warnings);
    state.finalPlayer = advancePlayer(orderedPlayers, player);
    state.lastPlacedOffsets = [];
    state.lastPlacement = null;
    return;
  }
  const position = parsePosition(action);
  const tilesToken = tokens.shift();
  if (!tilesToken)
    throw new GcgParseError("invalid_placement", "placement is missing tiles");
  const tiles = parsePrettyTiles(tilesToken);
  const parsed = scorePair(tokens, 0);
  const replay = replayPlace(
    board,
    position.row,
    position.col,
    position.direction,
    tiles,
    warnings,
  );
  const entry: Extract<GcgHistoryEntry, { kind: "place" }> = {
    kind: "place",
    player,
    rack,
    ...position,
    tiles,
    ...parsed,
  };
  annotatePlacementScore(entry, replay.computedScore, warnings);
  history.push(entry);
  applyScore(entry, replay.computedScore, state, warnings);
  state.lastPlacedOffsets = replay.placedOffsets;
  state.lastPlacement = {
    historyIndex: history.length - 1,
    player,
    computedScore: replay.computedScore,
  };
  state.finalPlayer = advancePlayer(orderedPlayers, player);
}

export function parseGcg(text: string): GcgImportResult {
  if (metadataSize(text) > MAX_GCG_BYTES)
    throw new GcgParseError(
      "file_too_large",
      "GCG input exceeds the 256 KiB limit",
    );
  if (text.includes("\0"))
    throw new GcgParseError(
      "invalid_text",
      "GCG input contains a NUL character",
    );
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines.length > MAX_GCG_LINES)
    throw new GcgParseError(
      "too_many_lines",
      "GCG input contains too many lines",
    );
  const players = new Map<string, GcgPlayer>();
  const pragmas: GcgPragma[] = [];
  const notes: string[] = [];
  const history: GcgHistoryEntry[] = [];
  const board = new Map<string, GcgCell>();
  const playerRacks: Record<string, string> = {};
  const warnings: string[] = [];
  const state = {
    title: "",
    description: "",
    lexiconHint: null as string | null,
    encoding: "UTF-8",
    finalRack: "",
  };
  const moveState: ReplayState = {
    finalPlayer: null,
    lastPlacedOffsets: [],
    lastPlacement: null,
    computedScores: new Map(),
  };

  for (const [lineIndex, rawLine] of lines.entries()) {
    if (metadataSize(rawLine) > MAX_GCG_LINE_BYTES)
      throw new GcgParseError(
        "line_too_large",
        `GCG line ${lineIndex + 1} is too long`,
      );
    if ([...rawLine].some(isAsciiControl))
      throw new GcgParseError(
        "invalid_text",
        `GCG line ${lineIndex + 1} contains a control character`,
      );
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      parsePragma(line, players, pragmas, notes, playerRacks, state, history);
    } else if (line.startsWith(">")) {
      if (history.length >= MAX_GCG_RECORDS)
        throw new GcgParseError(
          "too_many_records",
          "GCG input contains too many records",
        );
      parseMoveLine(line, players, history, board, warnings, moveState);
    } else {
      throw new GcgParseError(
        "invalid_line",
        `GCG line ${lineIndex + 1} must be a pragma or move`,
      );
    }
  }
  if (players.size === 0 && history.length > 0)
    throw new GcgParseError(
      "missing_players",
      "GCG moves require player declarations",
    );
  if (players.size > MAX_GCG_PLAYERS)
    throw new GcgParseError(
      "too_many_players",
      "GCG input contains too many players",
    );

  const orderedPlayers = [...players.values()].sort(
    (left, right) => left.id - right.id,
  );
  const finalPlayer = moveState.finalPlayer;
  const currentRack =
    state.finalRack || (finalPlayer ? (playerRacks[finalPlayer] ?? "") : "");
  const totals = moveState.computedScores;
  const currentScore = finalPlayer
    ? (totals.get(finalPlayer) ?? 0)
    : (totals.get(orderedPlayers[0]?.abbreviation ?? "") ?? 0);
  const opponent = orderedPlayers.find(
    (player) => player.abbreviation !== finalPlayer,
  );
  const opponentScore = opponent ? (totals.get(opponent.abbreviation) ?? 0) : 0;
  const placeCount = history.filter((entry) => entry.kind === "place").length;
  let scorelessTurns = 0;
  for (const entry of [...history].reverse()) {
    if (entry.kind === "pass" || entry.kind === "exchange") scorelessTurns += 1;
    else if (entry.kind === "place") break;
  }
  scorelessTurns = Math.min(6, scorelessTurns);
  if (history.length === 0 && board.size === 0)
    warnings.push("GCG contains no moves or board tiles");
  return {
    title: state.title,
    description: state.description,
    players: orderedPlayers,
    pragmas,
    notes,
    lexiconHint: state.lexiconHint,
    encoding: state.encoding,
    history,
    board: [...board.values()].sort(
      (left, right) => left.row - right.row || left.col - right.col,
    ),
    playerRacks,
    finalRack: currentRack,
    finalPlayer,
    scores: { onTurn: currentScore, opponent: opponentScore },
    computedScores: Object.fromEntries(
      orderedPlayers.map((player) => [
        player.abbreviation,
        totals.get(player.abbreviation) ?? 0,
      ]),
    ),
    turn: { number: placeCount + 1, scorelessTurns },
    warnings,
  };
}

export function replayGcgHistory(
  players: GcgPlayer[],
  history: GcgHistoryEntry[],
): GcgReplayFrame[] {
  const orderedPlayers = [...players].sort((left, right) => left.id - right.id);
  const board = new Map<string, GcgCell>();
  const scores = new Map(
    orderedPlayers.map((player) => [player.abbreviation, 0]),
  );
  const frames: GcgReplayFrame[] = [];
  let currentPlayer: string | null = orderedPlayers[0]?.abbreviation ?? null;
  let placeCount = 0;
  let scorelessTurns = 0;
  let lastPlacement: {
    historyIndex: number;
    entry: Extract<GcgHistoryEntry, { kind: "place" }>;
    offsets: number[];
    computedScore: number;
  } | null = null;

  const snapshot = (
    historyIndex: number,
    event: GcgHistoryEntry | null,
  ): GcgReplayFrame => ({
    historyIndex,
    board: [...board.values()].sort(
      (left, right) => left.row - right.row || left.col - right.col,
    ),
    scores: Object.fromEntries(
      orderedPlayers.map((player) => [
        player.abbreviation,
        scores.get(player.abbreviation) ?? 0,
      ]),
    ),
    currentPlayer,
    turn: {
      number: placeCount + 1,
      scorelessTurns: Math.min(6, scorelessTurns),
    },
    event,
  });

  frames.push(snapshot(0, null));
  for (const [historyIndex, entry] of history.entries()) {
    if (entry.kind === "place") {
      const replay = replayPlace(
        board,
        entry.row,
        entry.col,
        entry.direction,
        entry.tiles,
        [],
      );
      scores.set(
        entry.player,
        (scores.get(entry.player) ?? 0) + replay.computedScore,
      );
      placeCount += 1;
      scorelessTurns = 0;
      currentPlayer = advancePlayer(orderedPlayers, entry.player);
      lastPlacement = {
        historyIndex,
        entry,
        offsets: replay.placedOffsets,
        computedScore: replay.computedScore,
      };
    } else if (entry.kind === "pass" || entry.kind === "exchange") {
      currentPlayer = advancePlayer(orderedPlayers, entry.player);
      scorelessTurns += 1;
      lastPlacement = null;
    } else if (entry.kind === "challenge" && entry.challengeKind === "phony") {
      if (lastPlacement && lastPlacement.historyIndex === historyIndex - 1) {
        undoPlace(board, lastPlacement.entry, lastPlacement.offsets);
        scores.set(
          lastPlacement.entry.player,
          (scores.get(lastPlacement.entry.player) ?? 0) -
            lastPlacement.computedScore,
        );
      }
      lastPlacement = null;
    } else if (
      entry.kind === "challenge" &&
      entry.challengeKind === "adjustment"
    ) {
      scores.set(
        entry.player,
        (scores.get(entry.player) ?? 0) + (entry.adjustment ?? 0),
      );
      lastPlacement = null;
    } else if (entry.kind === "time" || entry.kind === "end-bonus") {
      scores.set(
        entry.player,
        (scores.get(entry.player) ?? 0) + (entry.score ?? 0),
      );
      lastPlacement = null;
    }
    frames.push(snapshot(historyIndex + 1, entry));
  }
  return frames;
}

export function decodeGcgBytes(bytes: ArrayBuffer): {
  text: string;
  encoding: string;
} {
  if (bytes.byteLength > MAX_GCG_BYTES)
    throw new GcgParseError(
      "file_too_large",
      "GCG input exceeds the 256 KiB limit",
    );
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      encoding: "UTF-8",
    };
  } catch {
    try {
      return {
        text: new TextDecoder("windows-1252", { fatal: false }).decode(bytes),
        encoding: "windows-1252",
      };
    } catch {
      throw new GcgParseError(
        "invalid_encoding",
        "GCG input is not valid UTF-8 or Windows-1252 text",
      );
    }
  }
}

function signed(value: number | undefined): string {
  if (value === undefined) return "";
  return `${value >= 0 ? "+" : ""}${value}`;
}

function moveText(entry: {
  score?: number;
  total?: number;
  annotations?: string[];
}): string {
  const score = entry.score === undefined ? "" : signed(entry.score);
  const total = entry.total === undefined ? "" : String(entry.total);
  return [score, total, ...(entry.annotations ?? [])].filter(Boolean).join(" ");
}

function formatPosition(
  entry: Extract<GcgHistoryEntry, { kind: "place" }>,
): string {
  const row = String(entry.row + 1);
  const col = String.fromCharCode(65 + entry.col);
  return entry.direction === "horizontal" ? `${row}${col}` : `${col}${row}`;
}

function playerMap(players: GcgPlayer[]): Map<string, GcgPlayer> {
  return new Map(players.map((player) => [player.abbreviation, player]));
}

function exportEntry(
  entry: GcgHistoryEntry,
  players: Map<string, GcgPlayer>,
  warnings: string[],
  nextEntry?: GcgHistoryEntry,
): string[] {
  if (!players.has(entry.player))
    warnings.push(`history references undeclared player ${entry.player}`);
  if (entry.kind === "place") {
    const line =
      `>${entry.player}: ${entry.rack} ${formatPosition(entry)} ${entry.tiles} ${moveText(entry)}`.trimEnd();
    const lines = [line];
    if (
      entry.challenged &&
      !(nextEntry?.kind === "challenge" && nextEntry.challengeKind === "phony")
    ) {
      lines.push(
        `>${entry.player}: ${entry.rack} -- ${moveText({ score: entry.score === undefined ? undefined : -entry.score, total: entry.total })}`.trimEnd(),
      );
    }
    if (entry.note) lines.push(`#note ${entry.note}`);
    return lines;
  }
  if (entry.kind === "pass") {
    const lines = [
      `>${entry.player}: ${entry.rack} - ${moveText(entry)}`.trimEnd(),
    ];
    if (entry.note) lines.push(`#note ${entry.note}`);
    return lines;
  }
  if (entry.kind === "exchange") {
    const action =
      entry.blindCount !== undefined
        ? `-${entry.blindCount}`
        : `-${entry.tiles ?? ""}`;
    const lines = [
      `>${entry.player}: ${entry.rack} ${action} ${moveText(entry)}`.trimEnd(),
    ];
    if (entry.note) lines.push(`#note ${entry.note}`);
    return lines;
  }
  if (entry.kind === "challenge") {
    if (entry.challengeKind === "phony") {
      const lines = [
        `>${entry.player}: ${entry.rack} -- ${moveText(entry)}`.trimEnd(),
      ];
      if (entry.note) lines.push(`#note ${entry.note}`);
      return lines;
    }
    const adjustment = signed(entry.adjustment ?? 0);
    const lines = [
      `>${entry.player}: ${entry.rack} (challenge) ${adjustment} ${moveText(entry)}`.trimEnd(),
    ];
    if (entry.note) lines.push(`#note ${entry.note}`);
    return lines;
  }
  if (entry.kind === "time") {
    const lines = [
      `>${entry.player}: ${entry.rack} (time) ${moveText(entry)}`.trimEnd(),
    ];
    if (entry.note) lines.push(`#note ${entry.note}`);
    return lines;
  }
  const lines = [
    `>${entry.player}: (${entry.unusedTiles}) ${moveText(entry)}`.trimEnd(),
  ];
  if (entry.note) lines.push(`#note ${entry.note}`);
  return lines;
}

export function exportGcg(input: GcgExportInput): GcgExportResult {
  const players = [
    ...(input.players ?? [
      { id: 1, abbreviation: "P1", name: "Player 1" },
      { id: 2, abbreviation: "P2", name: "Player 2" },
    ]),
  ].sort((left, right) => left.id - right.id);
  const map = playerMap(players);
  const warnings: string[] = [];
  const lines = ["#character-encoding UTF-8"];
  for (const player of players)
    lines.push(`#player${player.id} ${player.abbreviation} ${player.name}`);
  if (input.lexiconHint) lines.push(`#lexicon ${input.lexiconHint}`);
  if (input.title) lines.push(`#title ${normalizeWhitespace(input.title)}`);
  if (input.description)
    lines.push(`#description ${normalizeWhitespace(input.description)}`);
  for (let index = 0; index < input.history.length; index += 1) {
    lines.push(
      ...exportEntry(
        input.history[index],
        map,
        warnings,
        input.history[index + 1],
      ),
    );
  }
  if (input.finalRack && input.finalPlayer) {
    const player = map.get(input.finalPlayer);
    if (player) lines.push(`#rack${player.id} ${input.finalRack}`);
    else
      warnings.push(
        `final rack references undeclared player ${input.finalPlayer}`,
      );
  }
  if (
    (input.board?.length ?? 0) > 0 &&
    !input.history.some((entry) => entry.kind === "place")
  ) {
    warnings.push(
      "GCG cannot represent a board snapshot without move history; use Quackle Web JSON for a lossless export",
    );
  }
  if (warnings.length > 0)
    warnings.unshift("export is compatible but may be lossy");
  return { text: `${lines.join("\n")}\n`, warnings };
}

export type SupportedLexiconId = "nwl23" | "csw24";
export type LexiconResolution = SupportedLexiconId | "missing" | "unsupported";

export function resolveLexiconHint(hint: string | null): LexiconResolution {
  if (!hint || !hint.trim()) return "missing";
  const normalized = hint
    .trim()
    .toUpperCase()
    .replace(/[\s_-]+/g, "");
  if (normalized === "NWL23" || normalized === "NWL2023") return "nwl23";
  if (normalized === "CSW24" || normalized === "CSW2024") return "csw24";
  return "unsupported";
}

export function resolveNwl23Hint(
  hint: string | null,
): "exact" | "missing" | "unsupported" {
  const resolution = resolveLexiconHint(hint);
  if (resolution === "nwl23") return "exact";
  if (resolution === "missing") return "missing";
  return "unsupported";
}
