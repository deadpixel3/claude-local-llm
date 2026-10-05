#!/usr/bin/env python3
"""Send a prompt to a local OpenAI-compatible LLM server and print the reply.

Works with LM Studio, Ollama, llama.cpp (llama-server), vLLM, Jan and any other
server that speaks the OpenAI chat completions API. Standard library only.

    llm.py PROMPT_FILE [--url URL] [--model ID] [--context N] [--live PATH]
           [--think | --no-think] [--max-tokens N] [--temperature T]
    llm.py --status [--url URL] [--model ID]

The reply goes to stdout. A one-line stats summary goes to stderr. With --live,
progress is written to a small JSON file while the reply streams in, which the
plugin's mod draws above the Claude Code prompt.

Empty option values count as unset. Fallbacks: LOCAL_LLM_URL, LOCAL_LLM_MODEL and
LOCAL_LLM_CONTEXT, then auto-detection. It sends the prompt only to that server.
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

KNOWN_SERVERS = [
    ("LM Studio", "http://localhost:1234/v1"),
    ("Ollama", "http://localhost:11434/v1"),
    ("llama.cpp", "http://localhost:8080/v1"),
    ("vLLM", "http://localhost:8000/v1"),
    ("Jan", "http://localhost:1337/v1"),
]
NOT_CHAT = re.compile(r"embed|rerank|whisper|tts", re.I)


def server_name(url):
    for name, known in KNOWN_SERVERS:
        if url.rstrip("/") == known:
            return name
    return re.sub(r"^https?://", "", url).split("/")[0]


def request(url, body=None, timeout=5.0):
    headers = {"Content-Type": "application/json"}
    data = json.dumps(body).encode() if body is not None else None
    return urllib.request.urlopen(urllib.request.Request(url, data, headers), timeout=timeout)


def get_json(url, timeout=2.0, body=None):
    with request(url, body, timeout) as r:
        return json.load(r)


def list_models(base):
    data = get_json(base + "/models")
    return [m["id"] for m in data.get("data", []) if isinstance(m, dict) and "id" in m]


def find_server(url):
    """Return (base_url, models). Probes the usual local ports when no URL is set."""
    candidates = [url.rstrip("/")] if url else [known for _, known in KNOWN_SERVERS]
    errors = []
    for base in candidates:
        try:
            return base, list_models(base)
        except Exception as e:
            errors.append(f"{base} ({e.__class__.__name__})")
    if url:
        raise SystemExit(f"local-llm: no server answered at {url}. Is it running, with its API server on?")
    raise SystemExit(
        "local-llm: no local LLM server found. Tried " + ", ".join(errors) + ".\n"
        "Start one (LM Studio: `lms server start`, Ollama: `ollama serve`, llama.cpp: `llama-server`), "
        "or set the server URL in /config."
    )


def pick_model(model, models):
    if model:
        return model
    chat = [m for m in models if not NOT_CHAT.search(m)]
    if not chat:
        raise SystemExit("local-llm: the server lists no chat model. Load one, or set the model in /config.")
    return chat[0]


def detect_context(base, model):
    """Best-effort loaded context size; None when the server doesn't say."""
    root = base[:-3] if base.endswith("/v1") else base
    probes = [
        # vLLM lists it with the model
        lambda: next(m.get("max_model_len") for m in get_json(f"{base}/models")["data"] if m.get("id") == model),
        # LM Studio
        lambda: get_json(f"{root}/api/v0/models/{model}").get("loaded_context_length"),
        # llama.cpp
        lambda: get_json(f"{root}/props")["default_generation_settings"]["n_ctx"],
        # Ollama: the context of the loaded model
        lambda: next(m.get("context_length") for m in get_json(f"{root}/api/ps")["models"]
                     if m.get("name") == model or m.get("model") == model),
    ]
    for probe in probes:
        try:
            value = probe()
            if isinstance(value, int) and value > 0:
                return value
        except Exception:
            pass
    return None


class Live:
    """The stats file the mod reads. Writes are atomic and throttled."""

    def __init__(self, path, info):
        self.path, self.info, self.last = path, info, 0.0
        if path:
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)

    def write(self, force=False, **fields):
        self.info.update(fields)
        now = time.time()
        if not self.path or (not force and now - self.last < 0.25):
            return
        self.last = now
        self.info["updatedAt"] = int(now * 1000)
        self.info["elapsed"] = round(now - self.info["startedAt"] / 1000, 1)
        tmp = self.path + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.info, f)
            os.replace(tmp, self.path)
        except OSError:
            pass


def stream_chat(base, body, on_delta):
    """POST a streaming chat request; retry once without optional fields a strict server rejects."""
    optional = ("reasoning_effort", "chat_template_kwargs", "think", "stream_options")
    try:
        r = request(base + "/chat/completions", body, timeout=1800)
    except urllib.error.HTTPError as e:
        if e.code != 400 or not any(k in body for k in optional):
            raise
        body = {k: v for k, v in body.items() if k not in optional}
        r = request(base + "/chat/completions", body, timeout=1800)
    usage = stats = None
    with r:
        for raw in r:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            chunk = json.loads(data)
            if chunk.get("usage"):
                usage, stats = chunk["usage"], chunk.get("stats")
            for choice in chunk.get("choices") or []:
                on_delta(choice.get("delta") or {})
    return usage or {}, stats or {}


def status(args):
    base, models = find_server(args.url)
    model = pick_model(args.model, models)
    ctx = args.context or detect_context(base, model)
    print(f"server   {server_name(base)} at {base}")
    print(f"model    {model}" + ("" if args.model else "  (first chat model the server lists)"))
    print(f"context  {ctx if ctx else 'not reported by the server'}")
    print("models   " + (", ".join(models) or "none"))


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("prompt_file", nargs="?", help="file holding the prompt, or - for stdin")
    p.add_argument("--url", default="", help="OpenAI-compatible base URL, e.g. http://localhost:1234/v1")
    p.add_argument("--model", default="", help="model id; default: the first chat model the server lists")
    p.add_argument("--context", default="", help="context size in tokens, for the %% shown; default: detect")
    p.add_argument("--live", default="", help="path of the live stats file the mod reads")
    p.add_argument("--system", default="", help="file holding a system prompt")
    p.add_argument("--max-tokens", type=int, default=0)
    p.add_argument("--temperature", type=float, default=None)
    think = p.add_mutually_exclusive_group()
    think.add_argument("--think", action="store_true", help="ask the model to reason first, where the server supports it")
    think.add_argument("--no-think", action="store_true", help="ask the model not to reason, where the server supports it")
    p.add_argument("--status", action="store_true", help="show the server, model and context, then exit")
    args = p.parse_args()

    args.url = args.url.strip() or os.environ.get("LOCAL_LLM_URL", "")
    args.model = args.model.strip() or os.environ.get("LOCAL_LLM_MODEL", "")
    context = (args.context.strip() or os.environ.get("LOCAL_LLM_CONTEXT", "")).strip()
    args.context = int(context) if context.isdigit() and int(context) > 0 else None

    if args.status:
        return status(args)
    if not args.prompt_file:
        p.error("a prompt file is required (or --status)")

    try:
        with (sys.stdin if args.prompt_file == "-" else open(args.prompt_file, encoding="utf-8")) as f:
            prompt = f.read()
        messages = [{"role": "user", "content": prompt}]
        if args.system:
            with open(args.system, encoding="utf-8") as f:
                messages.insert(0, {"role": "system", "content": f.read()})
    except OSError as e:
        raise SystemExit(f"local-llm: can't read {e.filename}: {e.strerror}")

    base, models = find_server(args.url)
    model = pick_model(args.model, models)
    ctx = args.context or detect_context(base, model)

    start = time.time()
    live = Live(args.live, {
        "state": "running", "phase": "prompt", "model": model, "server": server_name(base), "url": base,
        "startedAt": int(start * 1000), "promptTokens": max(1, round(sum(len(m["content"]) for m in messages) / 3.5)),
        "promptExact": False, "outputTokens": 0, "reasoningTokens": 0, "ctx": ctx, "tps": 0.0, "ttft": None,
        "elapsed": 0.0, "draftAccepted": None, "draftTotal": None, "error": None,
    })
    live.write(force=True)

    body = {"model": model, "messages": messages, "stream": True, "stream_options": {"include_usage": True}}
    if args.max_tokens:
        body["max_tokens"] = args.max_tokens
    if args.temperature is not None:
        body["temperature"] = args.temperature
    if args.think or args.no_think:
        body["reasoning_effort"] = "medium" if args.think else "none"
        body["chat_template_kwargs"] = {"enable_thinking": bool(args.think)}

    text = []
    state = {"first": None, "in_think": False, "chunks": 0, "thinking": 0}

    def on_delta(delta):
        reasoning = delta.get("reasoning_content") or delta.get("reasoning")
        content = delta.get("content") or ""
        if not reasoning and not content:
            return
        if state["first"] is None:
            state["first"] = time.time()
        state["chunks"] += 1
        if reasoning:
            state["thinking"] += 1
            phase = "thinking"
        else:
            text.append(content)
            # Models that inline their reasoning as <think>...</think> in the content.
            if "<think>" in content:
                state["in_think"] = True
            if state["in_think"]:
                state["thinking"] += 1
            if "</think>" in content:
                state["in_think"] = False
            phase = "thinking" if state["in_think"] else "writing"
        gen = time.time() - state["first"]
        live.write(phase=phase, outputTokens=state["chunks"], reasoningTokens=state["thinking"],
                   ttft=round(state["first"] - start, 2), tps=round(state["chunks"] / gen, 1) if gen > 0.2 else 0.0)

    try:
        usage, stats = stream_chat(base, body, on_delta)
    except Exception as e:
        reason = f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:200]}" if isinstance(e, urllib.error.HTTPError) else str(e)
        live.write(force=True, state="error", phase="error", error=reason)
        raise SystemExit(f"local-llm: the request to {base} failed ({reason}).")

    elapsed = time.time() - start
    out = usage.get("completion_tokens") or state["chunks"]
    reasoning = (usage.get("completion_tokens_details") or {}).get("reasoning_tokens") or state["thinking"]
    gen = elapsed - ((state["first"] or start) - start)
    if usage.get("prompt_tokens"):
        live.info.update(promptTokens=usage["prompt_tokens"], promptExact=True)
    live.write(force=True, state="done", phase="done", outputTokens=out, reasoningTokens=reasoning,
               tps=round(out / gen, 1) if gen > 0 else 0.0,
               draftAccepted=stats.get("accepted_draft_tokens_count"), draftTotal=stats.get("total_draft_tokens_count"))

    total = live.info["promptTokens"] + out
    share = f", {100 * total / ctx:.1f}% of {ctx} ctx" if ctx else ""
    print(f"[local-llm] {model} on {server_name(base)}: prompt {live.info['promptTokens']} + output {out} "
          f"(thinking {reasoning}) = {total} tokens{share} | {elapsed:.1f}s, ~{live.info['tps']} tok/s", file=sys.stderr)
    if args.no_think and reasoning:
        print("[local-llm] --no-think had no effect: this server or model decides thinking itself", file=sys.stderr)
    if args.think and not reasoning:
        print("[local-llm] --think had no effect: thinking is off for this model on the server", file=sys.stderr)
    print(re.sub(r"(?s)<think>.*?</think>\s*", "", "".join(text)).strip())


if __name__ == "__main__":
    main()
