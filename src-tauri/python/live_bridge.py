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
                audio_q.put(("audio", base64.b64decode(msg["audio"])))
            elif msg.get("end"):
                audio_q.put(("end", None))
                # This marks an utterance boundary, not the end of the Live
                # session. Keep reading so later questions are transcribed.
        # stdin closed (parent stopped us): treat like an end signal.
        audio_q.put(("end", None))

    threading.Thread(target=run, daemon=True).start()


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
        try:
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
        finally:
            sender_task.cancel()


def main() -> None:
    init = read_init()
    audio_q: "queue.Queue[tuple[str, bytes | None]]" = queue.Queue()
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
