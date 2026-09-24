#!/usr/bin/env python3
"""Build a manifest and matching GADDAG for a pinned Quackle lexicon."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
WORD_PREFIX = "wordDump: "


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run(argv: list[str], *, cwd: Path, capture: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(argv, cwd=cwd, check=True, text=True, capture_output=capture)


def git(root: Path, *argv: str) -> str:
    return run(["git", "-C", str(root), *argv], cwd=ROOT, capture=True).stdout.strip()


def load_entry(quackle_root: Path, lexicon_id: str) -> tuple[dict, dict]:
    pin = json.loads((ROOT / "references/upstream-pin.json").read_text())
    catalog = json.loads((ROOT / "references/upstream-lexica.json").read_text())
    if git(quackle_root, "rev-parse", "HEAD") != pin["commit"]:
        raise SystemExit("Quackle checkout commit does not match references/upstream-pin.json")
    if git(quackle_root, "rev-parse", "HEAD^{tree}") != pin["tree"]:
        raise SystemExit("Quackle checkout tree does not match references/upstream-lexica.json")
    entries = {entry["id"]: entry for entry in catalog["lexica"]}
    try:
        entry = entries[lexicon_id]
    except KeyError as error:
        raise SystemExit(f"lexicon is not in the pinned catalog: {lexicon_id}") from error
    return pin, entry


def make_workspace(quackle_root: Path) -> tuple[Path, Path]:
    workspace = Path(tempfile.mkdtemp(prefix="quackle-upstream-"))
    (workspace / "run").mkdir()
    (workspace / "data").symlink_to(quackle_root / "data", target_is_directory=True)
    return workspace, workspace / "run"


def extract_words(test_binary: Path, run_dir: Path, lexicon_id: str) -> bytes:
    result = run(
        [
            str(test_binary),
            "--mode=worddump",
            f"--lexicon={lexicon_id}",
            "--alphabet=english",
        ],
        cwd=run_dir,
        capture=True,
    )
    words = [
        line[len(WORD_PREFIX) :]
        for line in result.stdout.splitlines()
        if line.startswith(WORD_PREFIX)
    ]
    if not words or any(not re.fullmatch(r"[A-Z]{2,15}", word) for word in words):
        raise SystemExit(f"word dump for {lexicon_id} was empty or malformed")
    return ("\n".join(words) + "\n").encode("ascii")


def generate_gaddag(
    makegaddag: Path, run_dir: Path, words: bytes, lexicon_id: str
) -> Path:
    words_path = run_dir.parent / f"{lexicon_id}.words"
    words_path.write_bytes(words)
    output = run_dir.parent / f"{lexicon_id}.gaddag"
    run(
        [
            str(makegaddag),
            "-f",
            str(words_path),
            "-o",
            str(output),
            "--alphabet=english",
        ],
        cwd=run_dir,
    )
    if not output.is_file() or output.stat().st_size == 0:
        raise SystemExit("makegaddag did not produce a non-empty artifact")
    return output


def smoke_test(test_binary: Path, run_dir: Path, gaddag: Path, lexicon_id: str) -> None:
    injected = run_dir / "lexica"
    injected.mkdir()
    shutil.copy2(gaddag, injected / f"{lexicon_id}.gaddag")
    result = run(
        [
            str(test_binary),
            "--mode=anagram",
            f"--lexicon={lexicon_id}",
            "--alphabet=english",
            "--letters=RETINAS",
            "--seed=1",
        ],
        cwd=run_dir,
        capture=True,
    )
    combined = result.stdout + result.stderr
    if "couldn't open gaddag" in combined.lower() or "RETINAS" not in combined:
        raise SystemExit(f"{lexicon_id} GADDAG smoke test failed")


def build(args: argparse.Namespace) -> dict:
    quackle_root = args.quackle_root.resolve()
    test_binary = args.test_binary.resolve()
    makegaddag = args.makegaddag.resolve()
    pin, entry = load_entry(quackle_root, args.lexicon_id)
    dawg = quackle_root / entry["file"]
    if not dawg.is_file():
        raise SystemExit(f"missing upstream DAWG: {dawg}")
    if sha256(dawg) != entry["sha256"] or dawg.stat().st_size != entry["size"]:
        raise SystemExit(f"{args.lexicon_id} DAWG checksum or size mismatch")
    tree_entry = git(quackle_root, "ls-tree", pin["commit"], entry["file"])
    if entry["git_blob_sha1"] not in tree_entry.split():
        raise SystemExit(f"{args.lexicon_id} DAWG Git blob mismatch: {tree_entry}")

    workspace, run_dir = make_workspace(quackle_root)
    try:
        words = extract_words(test_binary, run_dir, args.lexicon_id)
        gaddag = generate_gaddag(makegaddag, run_dir, words, args.lexicon_id)
        smoke_test(test_binary, run_dir, gaddag, args.lexicon_id)

        output = args.output.resolve()
        output.mkdir(parents=True, exist_ok=True)
        dawg_output = output / f"{args.lexicon_id}.dawg"
        gaddag_output = output / f"{args.lexicon_id}.gaddag"
        shutil.copy2(dawg, dawg_output)
        shutil.copy2(gaddag, gaddag_output)
        manifest = {
            "schema": 1,
            "id": args.lexicon_id,
            "display_name": entry["display_name"],
            "alphabet": entry["alphabet_id"],
            "board_id": "classic15",
            "word_count": len(words.splitlines()),
            "min_length": 2,
            "max_length": 15,
            "normalized_sha256": hashlib.sha256(words).hexdigest(),
            "quackle_hash": entry["quackle_hash"],
            "dawg_sha256": sha256(dawg_output),
            "gaddag_sha256": sha256(gaddag_output),
            "compiler": {
                "quackle_commit": pin["commit"],
                "makegaddag_sha256": sha256(makegaddag),
            },
            "source": {
                "kind": "quackle_shipped_artifact",
                "quackle_repository": pin["repository"],
                "quackle_tree": pin["tree"],
                "quackle_dawg_git_blob_sha1": entry["git_blob_sha1"],
                "quackle_dawg_path": entry["file"],
                "quackle_dawg_sha256": entry["sha256"],
                "raw_retained": False,
                "copyright_notice": entry["copyright"]["notice"],
            },
            "strategy_compatibility": "csw24-static",
            "analysis_capability": "static_only",
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
    parser.add_argument("--lexicon-id", required=True)
    parser.add_argument("--test-binary", type=Path, required=True)
    parser.add_argument("--makegaddag", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--created-at", default="2026-09-23T00:00:00Z")
    parser.add_argument("--keep-workspace", action="store_true")
    args = parser.parse_args()
    print(json.dumps(build(args), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
