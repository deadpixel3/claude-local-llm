# Local LLM for Claude Code

Let Claude hand routine coding work to a model running on your own hardware, and watch it work.

Claude stays in charge: it plans, writes a self-contained prompt, sends it to your local model, reviews what comes back, fixes it, and runs the tests. Boilerplate, tests, docstrings and simple functions cost you local GPU time instead of Claude usage.

While the local model works, a live line sits above the prompt, drawn like Claude Code's own:

```
✻ Qwen3-8B writing…        7s      ↑ ~1.7k  ↓ 412    60 tok/s   ▰▱▱▱▱▱▱▱  2.8% of 64K               LM Studio
```

and when it finishes:

```
✓ Qwen3-8B done            13.5s   ↑ 1.7k   ↓ 814    66 tok/s   ▰▱▱▱▱▱▱▱  2.3% of 64K  draft 87%         Hide
```

Elapsed time, prompt and output tokens, generation speed, how full the model's context is, thinking tokens when the model reasons, and speculative-decoding acceptance when the server reports it.

## Works with

Any server that speaks the OpenAI chat completions API. These are found automatically on their usual ports:

| Server | Default URL | Context size shown |
| --- | --- | --- |
| [LM Studio](https://lmstudio.ai) (including models on another machine through LM Link) | `http://localhost:1234/v1` | yes |
| [Ollama](https://ollama.com) | `http://localhost:11434/v1` | yes, while the model is loaded |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) `llama-server` | `http://localhost:8080/v1` | yes |
| [vLLM](https://github.com/vllm-project/vllm) | `http://localhost:8000/v1` | yes |
| [Jan](https://jan.ai) | `http://localhost:1337/v1` | set it in `/config` |

Anything else (a server on another machine, LocalAI, a proxy) works by setting its URL.

## Install

Requirements: Claude Code v2.1.287 or later (the live line is a mod), Python 3 on your `PATH`, and a local server with a model loaded.

In Claude Code:

```
/plugin marketplace add deadpixel3/claude-local-llm
/plugin install local-llm@claude-local-llm
```

Or from your shell:

```bash
claude plugin marketplace add deadpixel3/claude-local-llm
claude plugin install local-llm@claude-local-llm
```

Then run `/reload-plugins` in an open session, or start a new one.

## Use it

Ask in plain words:

> use the local model to write tests for `parse_duration`

> use local llm: add docstrings to every function in utils.py

Claude also reaches for it by itself for clearly routine generation. Run `/local-llm` to see your settings and the last run's numbers, or ask Claude to check the local model, which runs the script's `--status`: the server it found, the model and the context size.

What Claude keeps for itself: planning, architecture, changes across many files, hard bugs, and anything touching security, auth or payments. Local models make confident mistakes, so Claude reviews and tests everything they write, and takes over a task the model fails twice.

## Settings

All optional. Change them in `/config` under **Local LLM**:

| Setting | Default | What it does |
| --- | --- | --- |
| Server URL | empty: auto-detect | OpenAI-compatible base URL, such as `http://192.168.1.20:1234/v1` |
| Model | empty: first chat model listed | The model id as your server lists it |
| Context length | `0`: ask the server | Tokens of context the model is loaded with, for the % shown |
| Live stats above the prompt | on | Turn the live line off |

The plugin sends no API key and reads no environment variables: it is made for servers on your own machine or network, which run without a key.

### Thinking models

Reasoning models (Qwen 3, DeepSeek R1, gpt-oss and others) think before they answer. That gives better code on logic-heavy tasks and costs a lot of time: in testing, the same task took 3 minutes with thinking and 19 seconds without. For routine work, turn thinking off in your server's settings for that model. Many servers, LM Studio among them, only honor that setting, not a per-request one. The live line shows thinking tokens, so you can see which mode you are in.

## How it works

```
claude-local-llm/                  the marketplace
└── plugins/local-llm/             the plugin
    ├── skills/delegate/SKILL.md   tells Claude when and how to delegate
    ├── scripts/llm.py             streams the request, writes live stats
    └── hooks/register.tsx         the mod: the live line and /local-llm
```

1. The skill has Claude write a prompt file and run `scripts/llm.py` with your settings and a `--live` file in the plugin's data folder.
2. `llm.py` finds the server, streams the reply, and rewrites the live file a few times a second: phase, tokens, speed, context.
3. The mod notices the Bash call, takes the `--live` path from it, reads that file a few times a second until the run ends, and draws the line. Each value has a fixed-width slot, so the line holds still while numbers change.

`llm.py` is standard-library Python and runs on its own:

```bash
python3 plugins/local-llm/scripts/llm.py --status
python3 plugins/local-llm/scripts/llm.py prompt.txt --model llama3.1 --live /tmp/live.json
```

## What the plugin can access

A mod runs inside Claude Code with your permissions, so here is everything this one does. `claude plugin validate ./plugins/local-llm` lists the same hooks and calls.

**The mod** (`hooks/register.tsx`) makes no network requests, runs no commands, tools or models, and reads no credentials. It hooks four events:

| Event | What it does |
| --- | --- |
| `session.start` | Registers the `/local-llm` command. |
| `command.run` for `/local-llm` | Replies with your Local LLM settings and the last run's numbers, from the mod's own state. |
| `tool.call` for Bash | Looks at the command text of each Bash call Claude makes. Only for a call of this plugin's `llm.py` with `--live PATH` does it act: it reads that one file a few times a second until the run finishes. It never blocks, changes, delays or answers a tool call: every call, this plugin's included, goes on exactly as Claude made it. |
| `ui.render` for the line above the prompt | Draws the live line from that file's numbers. |

Its calls: `$.fs.read` (the `--live` file only), `$.clock` (the read timer), `$.command.register`, `$.state` (the numbers it draws) and `$.ui.resolve` (drawing).

**The script** (`scripts/llm.py`), which Claude runs through Bash like any command, so it goes through your normal permission prompts: it sends the prompt Claude wrote to one server, the URL you set or the first that answers on `localhost` ports 1234, 11434, 8080, 8000 and 1337, and writes the live stats file in the plugin's data folder. It contacts no other host, and sends no key or other credential.

## Troubleshooting

- **"no local LLM server found"**: start the server's API (LM Studio: `lms server start`; Ollama: `ollama serve`; llama.cpp: `llama-server -m model.gguf`), or set the Server URL.
- **`python3` not found** (Windows): Claude retries with `python` or `py -3`. Installing Python from python.org with "Add to PATH" fixes it for good.
- **No live line**: check that the mod loaded (run `/plugin`; it lists active mods) and that "Live stats above the prompt" is on. The line appears in the terminal and the Desktop app's Code tab, not in the VS Code chat panel.
- **The % is missing**: your server doesn't report its context size. Set Context length.

## Development

```bash
claude plugin validate ./plugins/local-llm
cd plugins/local-llm && claude plugin test .
claude --plugin-dir ./plugins/local-llm
```

## License

MIT
