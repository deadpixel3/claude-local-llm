# Privacy

Local LLM collects nothing and sends nothing to the plugin's author or to any third party.

- **Your prompts** go only to the LLM server you choose: the Server URL in `/config`, or, when that is empty, the first server that answers on `localhost` ports 1234, 11434, 8080, 8000 or 1337. What that server does with them is up to the server you run.
- **Live stats** (model name, token counts, timings) are written to one file in the plugin's data folder on your machine, `~/.claude/plugins/data/<plugin id>/live.json`, and read back by the plugin's mod to draw the line above the prompt. They never leave your machine.
- **No credentials** are read or sent. The plugin reads no environment variables and sends no API key.
- **No analytics or telemetry** of any kind.

Uninstalling the plugin removes its data folder, unless you keep it with `--keep-data`.

Questions: open an issue at https://github.com/deadpixel3/claude-local-llm/issues.
