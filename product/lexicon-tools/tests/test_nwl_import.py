"""Tests for the deterministic NWL definition importer."""

from __future__ import annotations

import pathlib
import sys
import unittest


sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / "normalize"))
import nwl_import as _nwl  # noqa: E402


class NwlImportTests(unittest.TestCase):
    def test_extracts_first_token_normalizes_newlines_and_sorts(self) -> None:
        source = b"\r\n  beta definition\r\nAA first\n\nalpha second\r"
        normalized, stats = _nwl.normalize_bytes(source)
        self.assertEqual(normalized, b"AA\nALPHA\nBETA\n")
        self.assertEqual(stats.nonempty_lines, 3)
        self.assertEqual(stats.unique_words, 3)
        self.assertEqual(stats.duplicate_tokens, 0)

    def test_deduplicates_tokens(self) -> None:
        normalized, stats = _nwl.normalize_bytes(
            b"word one\nWORD duplicate\nother word\n"
        )
        self.assertEqual(normalized, b"OTHER\nWORD\n")
        self.assertEqual(stats.unique_words, 2)
        self.assertEqual(stats.duplicate_tokens, 1)

    def test_rejects_invalid_token(self) -> None:
        with self.assertRaisesRegex(ValueError, "line 2"):
            _nwl.normalize_bytes(b"OK valid\nA too short\n")

    def test_rejects_non_ascii_token(self) -> None:
        with self.assertRaisesRegex(ValueError, "ASCII"):
            _nwl.normalize_bytes("ß word\n".encode("utf-8"))

    def test_rejects_invalid_utf8(self) -> None:
        with self.assertRaises(UnicodeDecodeError):
            _nwl.normalize_bytes(b"OK valid\n\xff\n")


if __name__ == "__main__":
    unittest.main()
