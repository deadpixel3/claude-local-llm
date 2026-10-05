---
name: delegate
description: Delegate routine coding work (boilerplate, tests for existing code, docstrings, simple single-file functions, format conversions) to the user's local LLM to save Claude usage. Use when the user says "use local", "use the local model", "use local llm", or names their local model (qwen, llama, gemma, mistral, deepseek, ...), or for clearly routine generation tasks.
---

# Delegating to the local model

The user runs a local model behind an OpenAI-compatible server (LM Studio, Ollama, llama.cpp, vLLM, Jan or similar). It cannot read files, use tools or remember earlier calls: it sees only the prompt you send. A live stats line above the prompt shows the user its progress while it works.

## Run it

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/llm.py" PROMPT_FILE --url "${user_config.base_url}" --model "${user_config.model}" --context "${user_config.context_length}" --live "${CLAUDE_PLUGIN_DATA}/live.json"
```

- Keep `--live` exactly as written: it feeds the stats line.
- The reply prints to stdout and a `[local-llm]` stats line to stderr (model, tokens, % of context, time, speed). Mention the stats to the user in one line.
- Before the first delegation in a session, or after a connection error, check the setup with the same command but `--status` in place of `PROMPT_FILE`. It names the server, model and context size.
- If `python3` is not found (common on Windows), use `python` or `py -3`.
- Optional: `--system FILE`, `--max-tokens N`, `--temperature T`. `--think` / `--no-think` ask for or against reasoning, but many servers decide that in the model's own settings; the script warns when the request had no effect.

## When to delegate

- Good for the local model: boilerplate, tests for existing functions, docstrings and comments, one function with a clear spec, format conversions, renaming and tidying within one file.
- Keep for yourself: planning, architecture, multi-file changes, hard bugs, security, auth, payments, and anything that needs context from many files.
- Local models make confident mistakes. If it fails the same task twice, do it yourself.

## How

1. Write a self-contained prompt to a temp file: the task, every piece of code it needs pasted in full (imports and signatures included), exact requirements, and end with "Output only the code in one fenced block."
2. Run the command above. Keep the prompt well under the context size `--status` reports.
3. Review the output critically: missing imports, invented APIs, unhandled cases. Fix small issues yourself, or re-prompt once with the specific problem.
4. Apply the code with your own edit tools, then run the tests.
5. Tell the user briefly which parts the local model wrote and what you fixed.

## If it can't connect

The script names what it tried. The server must be running with its API on: LM Studio `lms server start`, Ollama `ollama serve`, llama.cpp `llama-server -m MODEL`. A model on another machine (such as through LM Studio's LM Link) must be online. The URL and model can be set in `/config` under Local LLM.
