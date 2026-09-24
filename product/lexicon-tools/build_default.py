#!/usr/bin/env python3
"""Build and verify the pinned development NWL2023 artifact bundle.

The script intentionally keeps the raw definitions source and generated
binaries outside Git. It proves that the pinned third-party source reproduces
Quackle's shipped nwl23.dawg, generates the matching GADDAG, optionally loads
both artifacts through the pinned Quackle test harness, and writes a manifest.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
NORMALIZE_DIR = Path(__file__).resolve().parent / "normalize"
sys.path.insert(0, str(NORMALIZE_DIR))
from nwl_import import normalize_bytes  # noqa: E402


DEFAULT_LEXICON_PATH = Path("data/lexica/nwl23.dawg")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run(argv: list[str], *, cwd: Path, capture: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv,
        cwd=cwd,
        check=True,
        text=True,
        capture_output=capture,
    )


def git(root: Path, *argv: str) -> str:
    return run(["git", "-C", str(root), *argv], cwd=ROOT, capture=True).stdout.strip()


def verify_pins(quackle_root: Path, source: Path) -> tuple[dict, dict, str, Path]:
    upstream_pin = json.loads((ROOT / "references/upstream-pin.json").read_text())
    source_pin = json.loads((ROOT / "references/word-source-pin.json").read_text())

    commit = upstream_pin["commit"]
    actual_commit = git(quackle_root, "rev-parse", "HEAD")
    if actual_commit != commit:
        raise SystemExit(f"Quackle checkout is {actual_commit}, expected {commit}")

    lexicon = quackle_root / DEFAULT_LEXICON_PATH
    expected = upstream_pin["data_lexica"]["nwl23.dawg"]
    actual_sha = sha256(lexicon)
    if actual_sha != expected["sha256"]:
        raise SystemExit(f"nwl23.dawg SHA-256 mismatch: {actual_sha} != {expected['sha256']}")
    if lexicon.stat().st_size != expected["size"]:
        raise SystemExit("nwl23.dawg size mismatch")

    tree_entry = git(quackle_root, "ls-tree", commit, str(DEFAULT_LEXICON_PATH))
    fields = tree_entry.split()
    if len(fields) < 3 or fields[2] != expected["git_blob_sha1"]:
        raise SystemExit(f"nwl23.dawg Git blob mismatch: {tree_entry}")

    downloaded_sha = sha256(source)
    if downloaded_sha != source_pin["download_sha256"]:
        raise SystemExit(
            f"NWL source SHA-256 mismatch: {downloaded_sha} != {source_pin['download_sha256']}"
        )

    return upstream_pin, source_pin, actual_commit, lexicon


def make_workspace(quackle_root: Path, normalized: bytes) -> tuple[Path, Path]:
    workspace = Path(tempfile.mkdtemp(prefix="quackle-default-"))
    (workspace / "run").mkdir()
    (workspace / "data").symlink_to(quackle_root / "data", target_is_directory=True)
    run_dir = workspace / "run"
    (run_dir / "dawginput.raw").write_bytes(normalized)
    (run_dir / "smaller.raw").write_bytes(normalized)
    (run_dir / "gaddaginput.raw").write_bytes(normalized)
    (run_dir / "playabilities.raw").write_bytes(b"")
    return workspace, run_dir


def smoke_test(
    test_binary: Path,
    run_dir: Path,
    generated_gaddag: Path,
    expected_word_count: int,
) -> None:
    # First load the DAWG directly and enumerate its canonical word set.
    dawg_result = run(
        [
            str(test_binary),
            "--mode=worddump",
            "--lexicon=nwl23",
            "--alphabet=english",
        ],
        cwd=run_dir,
        capture=True,
    )
    words = [
        line.removeprefix("wordDump: ")
        for line in dawg_result.stdout.splitlines()
        if line.startswith("wordDump: ")
    ]
    if len(words) != expected_word_count:
        raise SystemExit(
            f"DAWG smoke-load count mismatch: {len(words)} != {expected_word_count}"
        )
    if "AA" not in words or "ZZZZZZ" in words:
        raise SystemExit("DAWG smoke-load sentinel check failed")

    # Then inject the generated GADDAG and exercise generation. A GADDAG dump
    # contains its internal rotated paths, not one line per source word.
    lexica = run_dir / "lexica"
    lexica.mkdir()
    shutil.copy2(generated_gaddag, lexica / "nwl23.gaddag")
    gaddag_result = run(
        [
            str(test_binary),
            "--mode=anagram",
            "--lexicon=nwl23",
            "--alphabet=english",
            "--letters=ADEIRST",
            "--seed=1",
        ],
        cwd=run_dir,
        capture=True,
    )
    combined = gaddag_result.stdout + gaddag_result.stderr
    if "couldn't open gaddag" in combined:
        raise SystemExit("GADDAG smoke-load failed")
    if "DISRATE" not in gaddag_result.stdout or "ZZZZZZ" in gaddag_result.stdout:
        raise SystemExit("GADDAG smoke-load sentinel check failed")


def build(args: argparse.Namespace) -> dict:
    quackle_root = args.quackle_root.resolve()
    source = args.source.resolve()
    upstream_pin, source_pin, commit, upstream_dawg = verify_pins(quackle_root, source)
    normalized, stats = normalize_bytes(source.read_bytes())

    if stats.normalized_sha256 != source_pin["normalized_sha256"]:
        raise SystemExit("normalized source SHA-256 does not match the pin")
    if stats.unique_words != source_pin["word_count"]:
        raise SystemExit("normalized source word count does not match the pin")
    if stats.nonempty_lines != source_pin["nonempty_line_count"]:
        raise SystemExit("normalized source line count does not match the pin")

    workspace, run_dir = make_workspace(quackle_root, normalized)
    try:
        run([str(args.makeminidawg), "--alphabet=english"], cwd=run_dir)
        generated_dawg = run_dir / "output.dawg"
        if sha256(generated_dawg) != upstream_pin["data_lexica"]["nwl23.dawg"]["sha256"]:
            raise SystemExit("generated DAWG is not byte-identical to shipped nwl23.dawg")

        run(
            [
                str(args.makegaddag),
                "--alphabet=english",
                "--input=gaddaginput.raw",
                "--output=output.gaddag",
            ],
            cwd=run_dir,
        )
        generated_gaddag = run_dir / "output.gaddag"

        if args.test_binary:
            smoke_test(args.test_binary.resolve(), run_dir, generated_gaddag, stats.unique_words)

        output = args.output.resolve()
        output.mkdir(parents=True, exist_ok=True)
        dawg_output = output / "nwl23.dawg"
        gaddag_output = output / "nwl23.gaddag"
        shutil.copy2(upstream_dawg, dawg_output)
        shutil.copy2(generated_gaddag, gaddag_output)

        manifest = {
            "schema": 1,
            "id": "nwl23",
            "display_name": "NWL2023",
            "alphabet": "english",
            "board_id": "classic15",
            "word_count": stats.unique_words,
            "min_length": 2,
            "max_length": 15,
            "normalized_sha256": stats.normalized_sha256,
            "dawg_sha256": sha256(dawg_output),
            "gaddag_sha256": sha256(gaddag_output),
            "compiler": {
                "quackle_commit": commit,
                "makeminidawg_sha256": sha256(args.makeminidawg.resolve()),
                "makegaddag_sha256": sha256(args.makegaddag.resolve()),
            },
            "source": {
                "kind": "quackle_shipped_artifact_verified_against_pinned_source",
                "quackle_repository": upstream_pin["repository"],
                "quackle_tree": upstream_pin["tree"],
                "quackle_dawg_git_blob_sha1": upstream_pin["data_lexica"]["nwl23.dawg"]["git_blob_sha1"],
                "definition_repository": source_pin["repository"],
                "definition_commit": source_pin["pinned_commit"],
                "definition_path": source_pin["path"],
                "definition_git_blob_sha1": source_pin["git_blob_sha1"],
                "definition_download_sha256": source_pin["download_sha256"],
                "raw_retained": False,
                "copyright_notice": "NASPA Word List, 2023 Edition (NWL23), © 2023 North American Word Game Players Association. All rights reserved.",
            },
            "strategy_compatibility": "nwl23",
            "created_at": args.created_at,
        }
        (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        return manifest
    finally:
        if not args.keep_workspace:
            shutil.rmtree(workspace, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--quackle-root", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--makeminidawg", type=Path, required=True)
    parser.add_argument("--makegaddag", type=Path, required=True)
    parser.add_argument("--test-binary", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--created-at", default="2026-09-22T00:00:00Z")
    parser.add_argument("--keep-workspace", action="store_true")
    args = parser.parse_args()
    manifest = build(args)
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
