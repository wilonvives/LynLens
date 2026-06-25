# Lynscripe faster-whisper alignment helper.
#
# We use faster-whisper ONLY for word-level timestamps — Lynscripe already has
# the correct text (from Gemini + the user's edits) and char-aligns it to these
# timings. So ASR text quality only needs to be good enough for anchors; a
# smaller GPU model is faster and plenty precise here.
#
# Prints a single JSON line to stdout: {"language": "...", "words": [{"w","start","end"}, ...]}
# Logs go to stderr. Tries CUDA (float16) first, falls back to CPU (int8).
import os
import sys
import json
import argparse

# Embedded Python on Windows defaults stdout/stderr to cp1252, which can't encode
# CJK — force UTF-8 before we write any transcript text.
os.environ["PYTHONUTF8"] = "1"
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:
        pass


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--audio", required=True)
    ap.add_argument("--language", default="auto")
    ap.add_argument("--cuda-dll", default="")
    args = ap.parse_args()

    os.environ["PYTHONUTF8"] = "1"
    if sys.platform == "win32" and args.cuda_dll and os.path.exists(args.cuda_dll):
        try:
            os.add_dll_directory(args.cuda_dll)
        except Exception:
            os.environ["PATH"] = args.cuda_dll + ";" + os.environ.get("PATH", "")

    from faster_whisper import WhisperModel

    lang = None if args.language in ("auto", "") else args.language

    model = None
    last_err = None
    for device, compute in (("cuda", "float16"), ("cpu", "int8")):
        try:
            model = WhisperModel(args.model_dir, device=device, compute_type=compute)
            sys.stderr.write(f"[fw] loaded on {device}/{compute}\n")
            break
        except Exception as e:  # noqa: BLE001
            last_err = e
            model = None
    if model is None:
        sys.stderr.write(f"[fw] model load failed: {last_err}\n")
        sys.stderr.flush()
        os._exit(2)

    segments, info = model.transcribe(
        args.audio, language=lang, word_timestamps=True, vad_filter=False
    )

    # Emit per-SEGMENT (sentence-ish) with its words. The TS side flattens to
    # words for Lynscripe alignment, or builds a segmented Transcript for 粗剪.
    segs_out = []
    for seg in segments:
        ws = []
        if getattr(seg, "words", None):
            for w in seg.words:
                if w.start is None or w.end is None:
                    continue
                ws.append({"w": w.word, "start": float(w.start), "end": float(w.end)})
        segs_out.append(
            {"start": float(seg.start), "end": float(seg.end), "text": seg.text, "words": ws}
        )

    payload = json.dumps({"language": info.language, "segments": segs_out}, ensure_ascii=False)
    # Write bytes directly so it never depends on the console codepage.
    sys.stdout.buffer.write(payload.encode("utf-8"))
    sys.stdout.buffer.flush()
    # Hard-exit before interpreter shutdown: CUDA/ctranslate2 context teardown
    # can crash with a non-zero code AFTER our output is already written, which
    # would make the caller wrongly treat a successful run as a failure.
    os._exit(0)


if __name__ == "__main__":
    main()
