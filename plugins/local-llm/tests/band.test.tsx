import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const
const SURFACES = ['terminal', 'desktop'] as const
const LIVE = '/home/me/.claude/plugins/data/local-llm/live.json'
const CALL = `python3 "/plugins/local-llm/scripts/llm.py" /tmp/p.txt --url "" --model "" --context "0" --live "${LIVE}"`

const base = {
  model: 'lmstudio-community/Qwen3-8B-GGUF', server: 'LM Studio', url: 'http://localhost:1234/v1',
  promptTokens: 186, promptExact: false, reasoningTokens: 0, ctx: 65536 as number | null, ttft: 0.5,
  error: null, draftAccepted: null as number | null, draftTotal: null as number | null,
}

test('the band follows a run live, then shows its totals', async ($, on) => {
  const clock = mock.clock(on)
  let file: Record<string, unknown> = {}
  const reads: string[] = []
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('fs.read', ($, e) => {
    reads.push(e.path)
    return { value: JSON.stringify(file) }
  })
  on('tool.call', () => ({ result: { text: 'ok' } }))

  file = { ...base, state: 'running', phase: 'writing', startedAt: clock.now(), outputTokens: 412, tps: 60.3, elapsed: 7 }
  await $.tool.call({ tool: 'Bash', command: CALL })
  await clock.advance(5000)
  expect(reads[0]).toBe(LIVE)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'local-llm', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /^Qwen3-8B writing…$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^↓ 412$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^LM Studio$/ })).toBeDefined()
    await ui.unmount()
  }

  file = { ...file, state: 'done', phase: 'done', promptExact: true, outputTokens: 965, tps: 61.2, elapsed: 16.2, draftAccepted: 674, draftTotal: 870 }
  await clock.advance(300)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'local-llm', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /^Qwen3-8B done$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^16\.2s$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1\.8% of 64K/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^draft 77%$/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'local-llm', surface: 'terminal', ...BAND })
  await ui.press({ key: 'hide' })
  expect(await ui.find({ type: 'Text', text: /Qwen3-8B/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined()
})

test('a server that reports no context size still gets a band, without the context cell', async ($, on) => {
  const clock = mock.clock(on)
  const file = { ...base, model: 'llama3.1:latest', server: 'Ollama', ctx: null, state: 'done', phase: 'done', startedAt: clock.now(), outputTokens: 50, tps: 30, elapsed: 2 }
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: 'engine' }))
  on('fs.read', () => ({ value: JSON.stringify(file) }))
  on('tool.call', () => ({ result: { text: 'ok' } }))
  await $.tool.call({ tool: 'Bash', command: CALL })
  await clock.advance(300)

  const ui = await $.ui.mount({ plugin: 'local-llm', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: /^llama3\.1 done$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /% of/ })).toBeUndefined()
})

test('other Bash calls and calls without --live are left alone', async ($, on) => {
  const clock = mock.clock(on)
  const reads: string[] = []
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: 'engine' }))
  on('fs.read', ($, e) => {
    reads.push(e.path)
    return { value: '{}' }
  })
  on('tool.call', () => ({ result: { text: 'ok' } }))
  await $.tool.call({ tool: 'Bash', command: 'ls -la' })
  await $.tool.call({ tool: 'Bash', command: 'python3 llm.py --status' })
  await clock.advance(1000)
  expect(reads.length).toBe(0)

  const ui = await $.ui.mount({ plugin: 'local-llm', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined()
})

test('/local-llm reports the server it finds and its models', async ($, on) => {
  on('http.fetch', ($, e) =>
    e.url === 'http://localhost:11434/v1/models'
      ? { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ data: [{ id: 'llama3.1:latest' }] }) } }
      : { value: { status: 0, ok: false, headers: {}, text: '' } },
  )
  const answer = await $.command.run({ command: 'local-llm', args: '' })
  expect(answer.text).toContain('Server: http://localhost:11434/v1')
  expect(answer.text).toContain('llama3.1:latest')
})
