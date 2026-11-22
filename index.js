/**
 * Host half of the token-cost bundle.
 *
 * Registers one client-visible Session projection that folds every billed model
 * attempt of a Session: the provider-reported token buckets, the exact
 * provider/model route, and the event time. The browser prices those attempts
 * with the published rates, so both the per-answer row and the sidebar balance
 * panel read ONE exact, whole-log source instead of guessing a model or a
 * moment from whatever happens to be on screen.
 *
 * The unit is data only. Prices stay out of the fold: a projection is cached
 * and replayed, so configured rates must not enter its state.
 *
 * Attempt lifecycle follows `@deepseek-ai/dsh-token-meter`'s usage fold: the
 * newest sample of one Step replaces the previous sample of that same Step,
 * while `llm/retry-started` closes the replacement slot so the retried attempt
 * is counted as its own billed request.
 */

/** Projection key read by the Client half. */
const KEY = 'turnTokenCost'

/** Invalidation version: bump when the fold or the state fields change. */
const STATE_VERSION = 1

/**
 * @param {unknown} value - candidate count.
 * @returns whether it is a safe non-negative integer.
 */
function isCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Last provider usage chunk embedded in one durable assistant stream.
 * @param {unknown} stream - compact durable stream chunks.
 * @returns the reported usage, when the stream carries one.
 */
function streamUsage(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const chunk = stream[index]
    if (chunk !== null && typeof chunk === 'object' && chunk.type === 'usage'
      && chunk.usage !== null && typeof chunk.usage === 'object') {
      return chunk.usage
    }
  }
  return undefined
}

/**
 * The usage one durable assistant settlement reports for its attempt.
 * @param {{ type: string, data: any }} event - committed Session event.
 * @returns the reported usage, when the event settles an attempt with one.
 */
function usageOf(event) {
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  if (event.type === 'assistant/message' && event.data.usage !== undefined) return event.data.usage
  return streamUsage(event.data.stream)
}

/**
 * Provider/model route of one settling event.
 * @param {{ type: string, data: any }} event - committed Session event.
 * @returns the route model id, when the event names one.
 */
function modelOf(event) {
  const source = event.data.message?.source
  if (source !== undefined && source !== null && typeof source.model === 'string' && source.model !== '') {
    return source.model
  }
  return undefined
}

/** Empty fold state: plain JSON, checkpointable. */
function init() {
  return { attempts: [], last: null }
}

/**
 * Fold one committed Session event into the attempt list.
 * @param {{ attempts: any[], last: { turn: number, step: number } | null }} state - current state.
 * @param {{ type: string, time: number, data: any }} event - committed Session event.
 * @returns the same state for unrelated events, otherwise the next state.
 */
function fold(state, event) {
  if (event.type === 'llm/retry-started') {
    const { turn, step } = event.data
    return state.last !== null && state.last.turn === turn && state.last.step === step
      ? { ...state, last: null }
      : state
  }
  const usage = usageOf(event)
  if (usage === undefined) return state
  const input = usage.inputTokens
  const output = usage.outputTokens
  if (!isCount(input) || !isCount(output)) return state
  const cacheRead = usage.cacheReadTokens
  const cacheWrite = usage.cacheWriteTokens
  if (cacheRead !== undefined && !isCount(cacheRead)) return state
  if (cacheWrite !== undefined && !isCount(cacheWrite)) return state
  const { turn, step } = event.data
  const attempt = {
    turn,
    time: event.time,
    model: modelOf(event),
    input,
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
    output,
  }
  const replacing = state.last !== null && state.last.turn === turn && state.last.step === step
  const attempts = replacing
    ? [...state.attempts.slice(0, -1), attempt]
    : [...state.attempts, attempt]
  return { attempts, last: { turn, step } }
}

/**
 * Client view: the billed attempts in log order.
 * @param {{ attempts: readonly object[] }} state - current state.
 * @returns the attempts array, whose reference is stable while only `last` moves.
 */
function view(state) {
  return state.attempts
}

/** Structural validator for one attempt; persisted state is replayed through it. */
const attemptCheck = {
  /**
   * @param {unknown} value - candidate attempt.
   * @returns the attempt.
   */
  parse(value) {
    const attempt = /** @type {any} */ (value)
    if (attempt === null || typeof attempt !== 'object'
      || !isCount(attempt.turn) || typeof attempt.time !== 'number' || !Number.isFinite(attempt.time)
      || (attempt.model !== null && typeof attempt.model !== 'string')
      || !isCount(attempt.input) || !isCount(attempt.cacheRead) || !isCount(attempt.cacheWrite)
      || !isCount(attempt.output)) {
      throw new TypeError('turnTokenCost: malformed attempt')
    }
    return attempt
  },
}

/** Validator for the persisted fold state; a bad checkpoint must not seed a fold. */
const stateCheck = {
  /**
   * @param {unknown} value - candidate state.
   * @returns the state.
   */
  parse(value) {
    const state = /** @type {any} */ (value)
    if (state === null || typeof state !== 'object' || !Array.isArray(state.attempts)) {
      throw new TypeError('turnTokenCost: malformed state')
    }
    for (const attempt of state.attempts) attemptCheck.parse(attempt)
    const last = state.last
    if (last !== null && (typeof last !== 'object' || !isCount(last.turn) || !isCount(last.step))) {
      throw new TypeError('turnTokenCost: malformed replacement slot')
    }
    return state
  },
}

/** Validator for the wire payload: one array of attempts. */
const viewCheck = {
  /**
   * @param {unknown} value - candidate client view.
   * @returns the view.
   */
  parse(value) {
    if (!Array.isArray(value)) throw new TypeError('turnTokenCost: view must be an array')
    for (const attempt of value) attemptCheck.parse(attempt)
    return value
  },
}

/** The projection unit: billed attempts, kept out of Session-list summaries. */
export const turnTokenCostDefinition = {
  key: KEY,
  stateVersion: STATE_VERSION,
  stateSchema: stateCheck,
  init,
  apply: fold,
  wire: { viewSchema: viewCheck, view, summary: false },
}

/**
 * Register the projection while the projection registry is available.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 */
export function apply(ctx) {
  ctx.inject(['sessionProjections'], (scope) => {
    let disposed = false
    // The registration is a thenable; observe it so a rejected key conflict is
    // reported here instead of surfacing as an unhandled rejection.
    Promise.resolve(scope.sessionProjections.register(turnTokenCostDefinition)).then(
      (handle) => { if (disposed) void handle.dispose() },
      (error) => { console.error('[token-cost] projection registration failed:', error) },
    )
    return () => { disposed = true }
  })
}
