"""Deterministic importer for definition-style NWL word lists.

The development NWL2023 source is one playable word followed by definition
text per non-empty line.  This module deliberately keeps the normalization
small and explicit so its output can be reproduced without a third-party
parser.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path

_WORD = re.compile(r"^[A-Z]{2,15}$")


@dataclass(frozen=True)
class NormalizationStats:
    source_bytes: int
    source_lines: int
    nonempty_lines: int
    unique_words: int
    duplicate_tokens: int
    normalized_sha256: str


def normalize_bytes(source: bytes) -> tuple[bytes, NormalizationStats]:
    """Normalize a UTF-8 definitions file into sorted unique words.

    Newlines are canonicalized to LF.  Every non-empty line contributes its
    first whitespace-delimited token, uppercased using ASCII semantics.  Any
    token outside the classic English 2--15 letter range is rejected instead
    of being silently dropped.
    """

    text = source.decode("utf-8", errors="strict")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = text.split("\n")
    tokens: list[str] = []
    nonempty_lines = 0

    for line_number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        nonempty_lines += 1
        raw_token = line.split()[0]
        try:
            token = raw_token.encode("ascii").decode("ascii").upper()
        except UnicodeEncodeError as exc:
            raise ValueError(
                f"line {line_number}: invalid first token {raw_token!r}; "
                "expected ASCII A-Z, length 2-15"
            ) from exc
        if _WORD.fullmatch(token) is None:
            raise ValueError(
                f"line {line_number}: invalid first token {token!r}; "
                "expected ASCII A-Z, length 2-15"
            )
        tokens.append(token)

    words = sorted(set(tokens))
    normalized = ("\n".join(words) + "\n").encode("ascii") if words else b""
    stats = NormalizationStats(
        source_bytes=len(source),
        source_lines=len(lines) - (1 if text.endswith("\n") else 0),
        nonempty_lines=nonempty_lines,
        unique_words=len(words),
        duplicate_tokens=len(tokens) - len(words),
        normalized_sha256=hashlib.sha256(normalized).hexdigest(),
    )
    return normalized, stats


def normalize_file(source_path: Path, output_path: Path) -> NormalizationStats:
    normalized, stats = normalize_bytes(source_path.read_bytes())
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(normalized)
    return stats


def _main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--stats-json", type=Path)
    args = parser.parse_args()

    stats = normalize_file(args.source, args.output)
    payload = {
        "source": str(args.source),
        "output": str(args.output),
        **stats.__dict__,
    }
    if args.stats_json:
        args.stats_json.parent.mkdir(parents=True, exist_ok=True)
        args.stats_json.write_text(json.dumps(payload, indent=2) + "\n")
    else:
        print(json.dumps(payload, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
