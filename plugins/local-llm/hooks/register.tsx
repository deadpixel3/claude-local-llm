import { atom, read, update } from 'claude-code'
import type { Register, Timer } from 'claude-code'

import type { LlmRun } from '../types'

const run = atom({ plugin: 'local-llm', key: 'run' } as const, null)
const frame = atom({ plugin: 'local-llm', key: 'frame' } as const, 0)
const isHidden = atom({ plugin: 'local-llm', key: 'isHidden' } as const, false)

// A Bash call of the plugin's script with a live stats file: `llm.py ... --live "<path>"`.
const LLM_CALL = /llm\.py\b/
const LIVE_PATH = /--live[ =](?:"([^"]+)"|'([^']+)'|(\S+))/
const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']
const PHASE = { prompt: 'reading prompt', thinking: 'thinking', writing: 'writing', done: 'done', error: 'failed' }
const STALE_MS = 5 * 60 * 1000
const KNOWN_SERVERS = [
  'http://localhost:1234/v1',
  'http://localhost:11434/v1',
  'http://localhost:8080/v1',
  'http://localhost:8000/v1',
  'http://localhost:1337/v1',
]

const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`)
const fmtCtx = (n: number) => (n >= 1024 ? `${Math.round(n / 1024)}K` : `${n}`)
const fmtTime = (s: number) => (s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`)

// "lmstudio-community/Qwen3-8B-GGUF" -> "Qwen3-8B", "llama3.1:latest" -> "llama3.1"
function shortModel(id: string) {
  const name = (id.split('/').pop() ?? id).replace(/[-_.]gguf$/i, '').replace(/:latest$/, '')
  return name.length > 26 ? `${name.slice(0, 25)}…` : name
}

function ctxBar(used: number, ctx: number, cells: number) {
  const filled = Math.min(cells, Math.max(used > 0 ? 1 : 0, Math.round((used / ctx) * cells)))
  return '▰'.repeat(filled) + '▱'.repeat(cells - filled)
}

export const register: Register = (on, options) => {
  const showStats = options.show_stats !== false
  let poll: Timer | null = null
  let calledAt = 0

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'local-llm',
      description: 'Show the local LLM server, its models, and the last run',
    })

    return next(e)
  })

  on('command.run', { command: 'local-llm' }, async $ => {
    const configured = typeof options.base_url === 'string' ? options.base_url.trim().replace(/\/$/, '') : ''
    const lines: string[] = []
    let found: { url: string; models: string[] } | null = null
    for (const url of configured ? [configured] : KNOWN_SERVERS) {
      try {
        const res = await $.http.fetch(`${url}/models`)
        if (res.ok) {
          const ids = (JSON.parse(res.text).data ?? []).map((m: { id: string }) => m.id)
          found = { url, models: ids }
          break
        }
      } catch {
        // not listening here
      }
    }
    if (found) {
      lines.push(`Server: ${found.url}`, `Models: ${found.models.join(', ') || 'none loaded'}`)
    } else {
      lines.push(
        configured
          ? `No server answered at ${configured}.`
          : 'No local server found on the usual ports (LM Studio 1234, Ollama 11434, llama.cpp 8080, vLLM 8000, Jan 1337).',
      )
    }
    if (typeof options.model === 'string' && options.model) {
      lines.push(`Configured model: ${options.model}`)
    }
    const last = await read($, run)
    if (last) {
      const ctx = last.ctx ? `, ${((100 * (last.promptTokens + last.outputTokens)) / last.ctx).toFixed(1)}% of ${fmtCtx(last.ctx)} context` : ''
      lines.push(
        last.state === 'error'
          ? `Last run: failed (${last.error ?? 'unknown error'})`
          : `Last run: ${last.model}, ${fmtTime(last.elapsed)}, ${last.promptTokens} in / ${last.outputTokens} out, ${Math.round(last.tps)} tok/s${ctx}`,
      )
    }

    return { text: lines.join('\n') }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const match = LLM_CALL.test(e.command) ? LIVE_PATH.exec(e.command) : null
    const path = match ? (match[1] ?? match[2] ?? match[3]) : undefined
    if (!showStats || !path) {
      return next(e)
    }

    calledAt = await $.clock.now()
    await update($, isHidden, () => false)
    poll?.cancel()

    const tick = async () => {
      const now = await $.clock.now()
      let data: LlmRun
      try {
        data = JSON.parse(await $.fs.read(path))
      } catch {
        return
      }
      // Ignore the previous run's file until this call has written its own.
      if (data.startedAt < calledAt - 5000) {
        if (now - calledAt > 30000) {
          poll?.cancel()
          poll = null
        }
        return
      }
      if (data.state === 'running') {
        data = { ...data, elapsed: (now - data.startedAt) / 1000 }
        if (now - data.startedAt > STALE_MS && data.outputTokens === 0) {
          data = { ...data, state: 'error', phase: 'error', error: 'no reply for 5 minutes' }
        }
      }
      await update($, run, () => data)
      await update($, frame, n => (n + 1) % SPINNER.length)
      if (data.state !== 'running') {
        poll?.cancel()
        poll = null
      }
    }

    poll = $.clock.every(150, () => {
      tick().catch(() => undefined)
    })

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const r = await read($, run)
    if (!showStats || e.props.hasSurvey || r === null || (await read($, isHidden))) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const wide = e.props.bodyColumns >= 100
    const isRunning = r.state === 'running'
    const used = r.promptTokens + r.outputTokens
    const draft = r.draftTotal ? Math.round((100 * (r.draftAccepted ?? 0)) / r.draftTotal) : null
    const name = shortModel(r.model)

    // Every piece sits in a fixed-width slot, so changing digits and spinner
    // glyphs never shift what follows (the desktop font is proportional).
    const head =
      r.state === 'error'
        ? { glyph: '✗', color: 'error', label: `${name} failed` }
        : isRunning
          ? { glyph: SPINNER[await read($, frame)] ?? '✻', color: 'claude', label: `${name} ${PHASE[r.phase]}…` }
          : { glyph: '✓', color: 'success', label: `${name} done` }
    const headWidth = Math.min(44, Math.max(24, name.length + 18))
    const cells =
      r.state === 'error'
        ? [{ key: 'err', width: 70, text: r.error ?? '' }]
        : [
            { key: 'time', width: 8, text: isRunning ? `${Math.floor(r.elapsed)}s` : fmtTime(r.elapsed) },
            { key: 'in', width: 9, text: `↑ ${r.promptExact ? '' : '~'}${fmtTokens(r.promptTokens)}` },
            { key: 'out', width: 9, text: `↓ ${fmtTokens(r.outputTokens)}` },
            { key: 'tps', width: 11, text: r.tps ? `${Math.round(r.tps)} tok/s` : '– tok/s' },
            ...(r.ctx
              ? [
                  {
                    key: 'ctx',
                    width: wide ? 26 : 15,
                    text: `${wide ? ctxBar(used, r.ctx, 8) + '  ' : ''}${((100 * used) / r.ctx).toFixed(1)}% of ${fmtCtx(r.ctx)}`,
                  },
                ]
              : []),
            ...(wide && r.reasoningTokens ? [{ key: 'think', width: 14, text: `${fmtTokens(r.reasoningTokens)} thinking` }] : []),
            ...(wide && draft !== null ? [{ key: 'draft', width: 11, text: `draft ${draft}%` }] : []),
          ]

    return (
      <Box flexDirection="row" width="100%">
        <Box width={2} flexShrink={0}>
          <Text color={head.color}>{head.glyph}</Text>
        </Box>
        <Box width={headWidth} flexShrink={0}>
          <Text color={isRunning ? 'claude' : undefined} bold={!isRunning} wrap="truncate">
            {head.label}
          </Text>
        </Box>
        {cells.map(cell => (
          <Box key={cell.key} width={cell.width} flexShrink={0}>
            <Text dimColor wrap="truncate">
              {cell.text}
            </Text>
          </Box>
        ))}
        <Box flexGrow={1} />
        {isRunning ? (
          wide ? (
            <Text dimColor wrap="truncate">
              {r.server}
            </Text>
          ) : null
        ) : (
          <Button key="hide" label="Hide" plain onPress={() => update($, isHidden, () => true)} />
        )}
      </Box>
    )
  })
}
