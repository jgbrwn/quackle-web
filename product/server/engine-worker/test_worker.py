#!/usr/bin/env python3
"""Black-box protocol tests for the native NDJSON worker.

Set QUACKLE_ENGINE_WORKER, QUACKLE_DATA_DIR, and QUACKLE_GADDAG before running.
The test intentionally runs the real child process rather than mocking Quackle.
"""

from __future__ import annotations

import json
import os
import subprocess
import unittest
from pathlib import Path


WORKER = os.environ.get("QUACKLE_ENGINE_WORKER")
DATA_DIR = os.environ.get("QUACKLE_DATA_DIR")
DAWG = os.environ.get("QUACKLE_DAWG")
GADDAG = os.environ.get("QUACKLE_GADDAG")
LEXICON_ID = os.environ.get("QUACKLE_LEXICON_ID", "nwl23")
WORKER_KIND = os.environ.get("QUACKLE_WORKER_KIND", "fast")
GOLDEN = Path(__file__).with_name("testdata") / "opening-golden.json"


class NativeWorkerProtocolTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        dawg_path = DAWG or (str(Path(DATA_DIR) / "lexica" / f"{LEXICON_ID}.dawg") if DATA_DIR else None)
        missing = [
            name
            for name, value in {
                "QUACKLE_ENGINE_WORKER": WORKER,
                "QUACKLE_DATA_DIR": DATA_DIR,
                "QUACKLE_DAWG": dawg_path,
                "QUACKLE_GADDAG": GADDAG,
            }.items()
            if not value
        ]
        if missing:
            raise unittest.SkipTest("missing native worker environment: " + ", ".join(missing))
        for path in (WORKER, DATA_DIR, dawg_path, GADDAG):
            assert path is not None
            if not Path(path).exists():
                raise unittest.SkipTest(f"native worker path does not exist: {path}")

        cls.process = subprocess.Popen(
            [WORKER, "--data-dir", DATA_DIR, "--lexicon-id", LEXICON_ID, "--dawg", dawg_path, "--gaddag", GADDAG, "--worker-kind", WORKER_KIND],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        cls.ready = cls.read_event()
        cls.addClassCleanup(cls.stop_process)

    @classmethod
    def stop_process(cls) -> None:
        process = getattr(cls, "process", None)
        if process is None:
            return
        if process.stdin:
            process.stdin.close()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2)

    @classmethod
    def read_event(cls) -> dict:
        assert cls.process.stdout is not None
        line = cls.process.stdout.readline()
        if not line:
            stderr = cls.process.stderr.read() if cls.process.stderr else ""
            raise AssertionError(f"worker exited before event: {stderr}")
        return json.loads(line)

    @classmethod
    def request(cls, request: dict) -> list[dict]:
        assert cls.process.stdin is not None
        cls.process.stdin.write(json.dumps(request) + "\n")
        cls.process.stdin.flush()
        events = []
        while True:
            event = cls.read_event()
            events.append(event)
            if event["event"] in {"result", "error", "cancelled"}:
                return events

    @staticmethod
    def opening_position() -> dict:
        return {
            "version": 1,
            "lexicon_id": LEXICON_ID,
            "board": {"id": "classic15", "cells": []},
            "rack": "ADEIRST",
            "players": {
                "on_turn": {"score": 0},
                "opponent": {"score": 0, "rack": None},
            },
            "turn": {"number": 0, "scoreless_turns": 0},
            "unseen": {"mode": "derive"},
        }

    def test_ready_identity(self) -> None:
        self.assertEqual(self.ready["event"], "ready")
        payload = self.ready["payload"]
        self.assertEqual(payload["protocol_version"], 1)
        self.assertEqual(payload["board_id"], "classic15")
        self.assertEqual(payload["lexicon"]["id"], LEXICON_ID)
        self.assertEqual(payload["lexicon"]["hash"], "7f0e9ef8fde8d6ef986acb7de33b1c98" if LEXICON_ID == "csw24" else "155a50a1a6508393601760e6971987ed")
        self.assertIn("generate_moves", payload["operations"])
        if WORKER_KIND == "deep" and LEXICON_ID == "nwl23":
            self.assertIn("analyze", payload["operations"])
        else:
            self.assertNotIn("analyze", payload["operations"])

    def test_validate_position_and_deterministic_generation(self) -> None:
        position = self.opening_position()
        validate_request = {
            "protocol": 1,
            "id": "validate-1",
            "op": "validate_position",
            "deadline_ms": 5000,
            "seed": 123456789,
            "payload": {"position": position},
        }
        validate_events = self.request(validate_request)
        self.assertEqual(validate_events[-1]["event"], "result")
        self.assertTrue(validate_events[-1]["payload"]["data"]["valid"])

        generate_request = {
            "protocol": 1,
            "id": "generate-1",
            "op": "generate_moves",
            "deadline_ms": 10000,
            "seed": 123456789,
            "payload": {
                "position": position,
                "options": {"limit": 5, "include_exchanges": True},
            },
        }
        first = self.request(generate_request)[-1]["payload"]["data"]
        second_request = dict(generate_request, id="generate-2")
        second = self.request(second_request)[-1]["payload"]["data"]
        self.assertEqual(first, second)
        self.assertEqual(first["count"], 5)
        if LEXICON_ID == "nwl23":
            golden = json.loads(GOLDEN.read_text())
            self.assertEqual(golden["seed"], generate_request["seed"])
            self.assertEqual(golden["limit"], generate_request["payload"]["options"]["limit"])
            for actual, expected in zip(first["moves"], golden["moves"]):
                for field in (
                    "action",
                    "position",
                    "row",
                    "col",
                    "horizontal",
                    "tiles",
                    "used_tiles",
                    "word",
                    "score",
                    "is_bingo",
                ):
                    self.assertEqual(actual[field], expected[field], field)
                self.assertAlmostEqual(actual["equity"], expected["equity"], places=5)
        else:
            self.assertEqual(first["moves"][0]["word"], "DISRATE")
            self.assertIn("STAIRED", [move["word"] for move in first["moves"]])

    def test_lexicon_specific_board_word_validation(self) -> None:
        position = self.opening_position()
        position["board"] = {
            "id": "classic15",
            "cells": [
                {"row": 7, "col": 7, "letter": "C"},
                {"row": 7, "col": 8, "letter": "H"},
            ],
        }
        request = {
            "protocol": 1,
            "id": "validate-lexicon-word",
            "op": "validate_position",
            "deadline_ms": 5000,
            "seed": 1,
            "payload": {"position": position},
        }
        data = self.request(request)[-1]["payload"]["data"]
        self.assertEqual(data["valid"], LEXICON_ID == "csw24")
        if LEXICON_ID == "nwl23":
            self.assertIn("unacceptable_word", [item["code"] for item in data["issues"]])


    @unittest.skipUnless(WORKER_KIND == "deep" and LEXICON_ID == "nwl23", "analyze requires a deep NWL23 worker")
    def test_analyze_is_terminal_and_seed_reproducible(self) -> None:
        request = {
            "protocol": 1,
            "id": "analyze-1",
            "op": "analyze",
            "deadline_ms": 60000,
            "seed": 123456789,
            "payload": {
                "position": self.opening_position(),
                "options": {"limit": 3},
            },
        }
        first_events = self.request(request)
        self.assertEqual(first_events[0]["event"], "started")
        self.assertEqual(first_events[-1]["event"], "result")
        self.assertTrue(any(event["event"] == "progress" for event in first_events[1:-1]))
        first = first_events[-1]["payload"]["data"]
        self.assertEqual(first["count"], len(first["moves"]))
        self.assertEqual(first["strategy"], "twenty_second_championship")
        self.assertTrue(first["moves"])
        self.assertEqual([move["rank"] for move in first["moves"]], list(range(1, first["count"] + 1)))
        self.assertIn("win", first["moves"][0])

        second_request = dict(request, id="analyze-2")
        second = self.request(second_request)[-1]["payload"]["data"]
        self.assertEqual(first, second)

        position = self.opening_position()
        position["board"] = {
            "id": "classic15",
            "cells": [
                {"row": 7, "col": 7, "letter": "Z"},
                {"row": 7, "col": 8, "letter": "Z"},
            ],
        }
        request = {
            "protocol": 1,
            "id": "validate-invalid",
            "op": "validate_position",
            "deadline_ms": 5000,
            "seed": 1,
            "payload": {"position": position},
        }
        event = self.request(request)[-1]
        self.assertEqual(event["event"], "result")
        data = event["payload"]["data"]
        self.assertFalse(data["valid"])
        self.assertIn("unacceptable_word", [item["code"] for item in data["issues"]])

    def test_cancel_does_not_require_compute_fields(self) -> None:
        request = {
            "protocol": 1,
            "id": "cancel-1",
            "op": "cancel",
            "payload": {"target_id": "job-1"},
        }
        event = self.request(request)[-1]
        self.assertEqual(event["event"], "cancelled")
        self.assertEqual(event["payload"]["target_id"], "job-1")


if __name__ == "__main__":
    unittest.main()
