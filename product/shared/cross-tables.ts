const ALLOWED_HOSTS = new Set(["cross-tables.com", "www.cross-tables.com"]);

export interface CrossTablesLink {
  url: string;
  gameId: number;
}

export class CrossTablesUrlError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CrossTablesUrlError";
  }
}

function requireAllowedHost(url: URL): void {
  if (url.protocol !== "https:")
    throw new CrossTablesUrlError(
      "https_required",
      "Cross-Tables links must use HTTPS",
    );
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase()))
    throw new CrossTablesUrlError(
      "host_not_allowed",
      "URL host is not an allowed Cross-Tables host",
    );
}

function parseGameId(value: string): number {
  if (!/^[1-9]\d{0,8}$/.test(value))
    throw new CrossTablesUrlError(
      "invalid_game_id",
      "Cross-Tables game id must be a positive numeric id",
    );
  const gameId = Number(value);
  if (!Number.isSafeInteger(gameId))
    throw new CrossTablesUrlError(
      "invalid_game_id",
      "Cross-Tables game id is outside the safe integer range",
    );
  return gameId;
}

export function parseCrossTablesUrl(input: string): CrossTablesLink {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new CrossTablesUrlError(
      "invalid_url",
      "Enter a complete Cross-Tables URL",
    );
  }
  requireAllowedHost(url);
  if (url.pathname !== "/annotated.php")
    throw new CrossTablesUrlError(
      "path_not_allowed",
      "URL must point to an annotated Cross-Tables game",
    );
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== "u")
    throw new CrossTablesUrlError(
      "query_not_allowed",
      "URL must contain only the numeric u game id",
    );
  const gameId = parseGameId(url.searchParams.get("u") ?? "");
  url.hostname = "www.cross-tables.com";
  url.hash = "";
  return { url: url.toString(), gameId };
}

export function parseCrossTablesGcgUrl(
  input: string,
  expectedGameId?: number,
): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new CrossTablesUrlError(
      "invalid_gcg_url",
      "Cross-Tables GCG link is malformed",
    );
  }
  requireAllowedHost(url);
  if (
    url.search ||
    url.hash ||
    !/^\/annotated(?:\/[A-Za-z0-9_-]+){2,}\/anno([1-9]\d{0,8})\.gcg$/i.test(
      url.pathname,
    )
  ) {
    throw new CrossTablesUrlError(
      "gcg_path_not_allowed",
      "GCG link is outside the Cross-Tables download path",
    );
  }
  const match = url.pathname.match(/\/anno([1-9]\d{0,8})\.gcg$/i);
  const gameId = parseGameId(match?.[1] ?? "");
  if (expectedGameId !== undefined && gameId !== expectedGameId) {
    throw new CrossTablesUrlError(
      "gcg_game_mismatch",
      "GCG link does not match the requested Cross-Tables game",
    );
  }
  url.hostname = "www.cross-tables.com";
  return url.toString();
}
