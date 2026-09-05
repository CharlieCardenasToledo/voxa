import asyncio
import queue
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import live_bridge


class FakeMultiTurnSession:
    def __init__(self) -> None:
        self.calls = 0

    async def receive(self):
        self.calls += 1
        if self.calls > 2:
            raise RuntimeError("connection closed")
        content = SimpleNamespace(
            input_transcription=SimpleNamespace(text=f"question {self.calls}"),
            interim_input_transcription=None,
        )
        yield SimpleNamespace(usage_metadata=None, server_content=content)


class LiveBridgeTests(unittest.IsolatedAsyncioTestCase):
    def test_audio_queue_is_bounded_and_keeps_latest(self) -> None:
        audio_q = queue.Queue(maxsize=2)
        live_bridge.put_latest(audio_q, ("audio", b"one"))
        live_bridge.put_latest(audio_q, ("audio", b"two"))
        live_bridge.put_latest(audio_q, ("audio", b"three"))
        self.assertEqual(audio_q.qsize(), 2)
        self.assertEqual(audio_q.get_nowait()[1], b"two")
        self.assertEqual(audio_q.get_nowait()[1], b"three")

    async def test_receiver_reenters_sdk_iterator_after_each_turn(self) -> None:
        events = []
        session = FakeMultiTurnSession()
        with patch.object(live_bridge, "emit", events.append):
            with self.assertRaisesRegex(RuntimeError, "connection closed"):
                await asyncio.wait_for(live_bridge.receive_forever(session), timeout=1)
        self.assertEqual(
            [event["transcript"] for event in events],
            ["question 1", "question 2"],
        )


if __name__ == "__main__":
    unittest.main()
