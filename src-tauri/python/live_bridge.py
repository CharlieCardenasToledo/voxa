"""Live transcription bridge for Voxa.

Speaks a tiny newline-delimited JSON protocol on stdin/stdout so the Rust
side (src-tauri/src/live.rs) doesn't need its own Gemini Live WebSocket
client. One process = one Live session; Voxa's Rust retry loop spawns a
fresh process per (re)connect attempt.

Why this exists instead of a raw Rust WebSocket client: connecting with
Rust's tungstenite (rustls) reproducibly hung waiting for `setupComplete`
even though the exact same request over Python's `google-genai` SDK (and
the raw `websockets` library) succeeded in well under a second. Rather
than keep chasing a TLS/framing difference with no way to packet-capture
in this environment, we use the SDK Google actually maintains for this.

stdin (one JSON object per line):
  {"api_key": "...", "model": "gemini-3.5-transcribe-live", "vocabulary": [...]}   (first line)
  {"audio": "<base64 pcm16 mono 16kHz>"}
  {"end": true}

stdout (one JSON object per line):
  {"status": "connected"}
  {"transcript": "...", "interim": true|false}
  {"error": "..."}
"""

import asyncio
import base64
import json
import queue
import sys
import threading

from google import genai
from google.genai import errors


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def read_init() -> dict:
    line = sys.stdin.readline()
    if not line:
        raise SystemExit(0)
    return json.loads(line)


def put_latest(
    audio_q: "queue.Queue[tuple[str, bytes | None]]",
    item: tuple[str, bytes | None],
) -> None:
    """Keep realtime audio bounded, preferring the newest audio under pressure."""
    try:
        audio_q.put_nowait(item)
        return
    except queue.Full:
        pass
    try:
        audio_q.get_nowait()
    except queue.Empty:
        pass
    try:
        audio_q.put_nowait(item)
    except queue.Full:
        # The sender raced us and filled the slot again. Dropping one 100 ms
        # packet is safer than blocking stdin forever and growing Rust memory.
        pass


def start_stdin_reader(audio_q: "queue.Queue[tuple[str, bytes | None]]") -> None:
    def run() -> None:
        for raw_line in sys.stdin:
            line = raw_line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "audio" in msg:
                put_latest(audio_q, ("audio", base64.b64decode(msg["audio"])))
            elif msg.get("end"):
                put_latest(audio_q, ("end", None))
                # This marks an utterance boundary, not the end of the Live
                # session. Keep reading so later questions are transcribed.
        # stdin closed (parent stopped us): treat like an end signal.
        put_latest(audio_q, ("end", None))

    threading.Thread(target=run, daemon=True).start()


async def receive_forever(session) -> None:
    """Re-enter the SDK's per-turn iterator for the life of the connection."""
    while True:
        async for response in session.receive():
            usage = getattr(response, "usage_metadata", None)
            if usage is not None:
                emit({
                    "usage": {
                        "input_tokens": getattr(usage, "prompt_token_count", 0) or 0,
                        "output_tokens": getattr(usage, "response_token_count", 0) or 0,
                        "total_tokens": getattr(usage, "total_token_count", 0) or 0,
                    }
                })
            content = getattr(response, "server_content", None)
            if content is None:
                continue
            final = getattr(content, "input_transcription", None)
            if final and final.text:
                emit({"transcript": final.text, "interim": False})
                continue
            interim = getattr(content, "interim_input_transcription", None)
            if interim and interim.text:
                emit({"transcript": interim.text, "interim": True})
        await asyncio.sleep(0)


async def run_session(init: dict, audio_q: "queue.Queue[tuple[str, bytes | None]]") -> None:
    client = genai.Client(api_key=init["api_key"])
    model = init.get("model", "gemini-3.5-transcribe-live")
    config = {
        "response_modalities": ["TEXT"],
        "input_audio_transcription": {
            "language_codes": [],
            "mode": "SMART",
            "custom_vocabulary": init.get("vocabulary", []),
        },
    }

    async with client.aio.live.connect(model=f"models/{model}", config=config) as session:
        emit({"status": "connected"})

        async def sender() -> None:
            while True:
                try:
                    kind, data = await asyncio.to_thread(audio_q.get, True, 0.5)
                except queue.Empty:
                    continue
                if kind == "audio":
                    await session.send_realtime_input(
                        audio={"data": data, "mime_type": "audio/pcm;rate=16000"}
                    )
                elif kind == "end":
                    await session.send_realtime_input(audio_stream_end=True)

        sender_task = asyncio.create_task(sender())
        receiver_task = asyncio.create_task(receive_forever(session))
        try:
            done, _ = await asyncio.wait(
                {sender_task, receiver_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in done:
                error = task.exception()
                if error is not None:
                    raise error
            raise RuntimeError("Gemini Live stream ended unexpectedly")
        finally:
            sender_task.cancel()
            receiver_task.cancel()
            await asyncio.gather(sender_task, receiver_task, return_exceptions=True)


def main() -> None:
    init = read_init()
    # Ten seconds at Voxa's 100 ms chunk size. This is enough to absorb short
    # network stalls while putting a hard ceiling on memory and stale latency.
    audio_q: "queue.Queue[tuple[str, bytes | None]]" = queue.Queue(maxsize=100)
    start_stdin_reader(audio_q)
    try:
        asyncio.run(run_session(init, audio_q))
    except errors.APIError as exc:
        emit({"error": str(exc)})
        sys.exit(1)
    except Exception as exc:  # noqa: BLE001 - surface any failure to Rust
        emit({"error": str(exc)})
        sys.exit(1)


if __name__ == "__main__":
    main()
