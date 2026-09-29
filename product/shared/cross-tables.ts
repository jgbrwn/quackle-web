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

function requireAllowedHost(url: URL, original: string): void {
  if (url.protocol !== "https:")
    throw new CrossTablesUrlError(
      "https_required",
      "Cross-Tables links must use HTTPS",
    );
  // The URL parser can normalize backslashes and erase an empty `@` userinfo
  // delimiter, so inspect the raw authority as well as parsed credentials.
  const normalizedOriginal = original
    .replace(/[\t\n\r]/g, "")
    .replaceAll("\\", "/");
  const authority =
    normalizedOriginal.match(/^[a-z][a-z0-9+.-]*:\/{0,}([^/?#]*)/i)?.[1] ?? "";
  if (url.username !== "" || url.password !== "" || authority.includes("@")) {
    throw new CrossTablesUrlError(
      "credentials_not_allowed",
      "Cross-Tables links must not contain URL credentials",
    );
  }
  if (url.port !== "") {
    throw new CrossTablesUrlError(
      "port_not_allowed",
      "Cross-Tables links must use the default HTTPS port",
    );
  }
  if (authority.includes("%")) {
    throw new CrossTablesUrlError(
      "host_not_allowed",
      "URL host is not an allowed Cross-Tables host",
    );
  }
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
  const original = input.trim();
  let url: URL;
  try {
    url = new URL(original);
  } catch {
    throw new CrossTablesUrlError(
      "invalid_url",
      "Enter a complete Cross-Tables URL",
    );
  }
  requireAllowedHost(url, original);
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
  return {
    url: `https://www.cross-tables.com/annotated.php?u=${gameId}`,
    gameId,
  };
}

export function parseCrossTablesGcgUrl(
  input: string,
  expectedGameId?: number,
): string {
  const original = input.trim();
  let url: URL;
  try {
    url = new URL(original);
  } catch {
    throw new CrossTablesUrlError(
      "invalid_gcg_url",
      "Cross-Tables GCG link is malformed",
    );
  }
  requireAllowedHost(url, original);
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
  return `https://www.cross-tables.com${url.pathname}`;
}

function resolveCrossTablesPageHref(href: string, baseUrl: string): string {
  const trimmed = href.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  // Keep network-path authorities raw until the GCG URL validator checks them.
  if (/^[\\/]{2}/.test(trimmed))
    return `https:${trimmed.replaceAll("\\", "/")}`;
  return new URL(trimmed, baseUrl).toString();
}

export interface CrossTablesPageInfo {
  gcgUrl: string;
  dictionary: string | null;
}

/** Derived download path Cross-Tables uses for self-annotated games. */
export function derivedCrossTablesGcgUrl(gameId: number): string {
  return parseCrossTablesGcgUrl(
    `https://www.cross-tables.com/annotated/selfgcg/${Math.floor(gameId / 100)}/anno${gameId}.gcg`,
    gameId,
  );
}

/**
 * Extract the GCG download link and declared dictionary from an annotated
 * game page. The HTML is treated as untrusted text: only allowlisted GCG paths
 * for the requested game id are accepted, and the dictionary is a short token.
 */
export function parseCrossTablesPage(
  html: string,
  link: CrossTablesLink,
): CrossTablesPageInfo {
  let gcgUrl: string | null = null;
  for (const match of html.matchAll(
    /href\s*=\s*(['"])([^'"<>]{1,300}?\.gcg)\1/gi,
  )) {
    try {
      gcgUrl = parseCrossTablesGcgUrl(
        resolveCrossTablesPageHref(match[2]!, link.url),
        link.gameId,
      );
      break;
    } catch {
      // Ignore links outside the allowlisted download path.
    }
  }
  const dictionary =
    html
      .match(/Dictionary:\s*<b>\s*([A-Za-z0-9_-]{2,16})\s*<\/b>/i)?.[1]
      ?.toUpperCase() ?? null;
  return {
    gcgUrl: gcgUrl ?? derivedCrossTablesGcgUrl(link.gameId),
    dictionary,
  };
}
