// Assertions for both halves of this bundle, runnable without a browser:
//
//   node .smoke/smoke.js
//
// The Host half is imported directly and folded over representative Session
// events. The Client half is evaluated in a sandbox with a fake module loader,
// a fake React (state and effects), a fake Cordis context, and fake account and
// Session services. It exits non-zero on the first failed expectation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { turnTokenCostDefinition } from '../index.js';

// ---- Host: the attempt projection -----------------------------------------

const TIME_PEAK = Date.parse('2026-11-16T02:00:00Z'); // 10:00 Beijing, Monday
const TIME_OFF_PEAK = Date.parse('2026-11-16T11:00:00Z'); // 19:00 Beijing, Monday

const message = (turn, step, time, input, output, model = 'deepseek-flash') => ({
  type: 'assistant/message',
  time,
  data: { turn, step, message: { source: { provider: 'deepseek-account', model } }, usage: { inputTokens: input, outputTokens: output } },
});
const attempt = (turn, step, time, usage, model = 'deepseek-flash') => ({
  type: 'assistant/attempt',
  time,
  data: { turn, step, message: { source: { provider: 'deepseek-account', model } }, stream: [{ type: 'usage', usage }] },
});
const retryStarted = (turn, step) => ({ type: 'llm/retry-started', time: TIME_PEAK, data: { turn, step } });

{
  const definition = turnTokenCostDefinition;
  assert.equal(definition.key, 'turnTokenCost', 'owns a unique projection key');
  assert.equal(definition.stateVersion, 1, 'declares its state version');
  assert.equal(definition.wire.summary, false, 'stays out of Session-list summaries');
  assert.deepEqual(definition.init({}, 0), { attempts: [], last: null });

  let state = definition.init({}, 0);
  state = definition.apply(state, message(1, 1, TIME_PEAK, 100, 10));
  assert.equal(state.attempts.length, 1, 'one settlement appends one attempt');
  assert.deepEqual(state.attempts[0], {
    turn: 1, time: TIME_PEAK, model: 'deepseek-flash', input: 100, cacheRead: 0, cacheWrite: 0, output: 10,
  });

  // A newer sample in the same Step replaces the previous one.
  state = definition.apply(state, message(1, 1, TIME_PEAK, 120, 12));
  assert.equal(state.attempts.length, 1, 'a repeated Step sample replaces');
  assert.equal(state.attempts[0].input, 120);

  // A retried attempt is its own billed request.
  state = definition.apply(state, retryStarted(1, 1));
  state = definition.apply(state, message(1, 1, TIME_PEAK, 50, 5));
  assert.equal(state.attempts.length, 2, 'a retried attempt is counted separately');
  assert.equal(state.attempts[1].input, 50);

  // Unrelated events return the SAME reference.
  const unrelated = definition.apply(state, { type: 'turn/end', time: TIME_PEAK, data: { turn: 1 } });
  assert.equal(unrelated, state, 'unrelated events keep the state reference');
  const otherStepRetry = definition.apply(state, retryStarted(9, 9));
  assert.equal(otherStepRetry, state, 'a retry for another Step keeps the state reference');
  const noUsage = definition.apply(state, {
    type: 'assistant/message', time: TIME_PEAK, data: { turn: 2, step: 1, message: { source: { model: 'deepseek-flash' } } },
  });
  assert.equal(noUsage, state, 'a settlement without usage keeps the state reference');
  const invalid = definition.apply(state, {
    type: 'assistant/message', time: TIME_PEAK, data: { turn: 2, step: 1, message: { source: { model: 'x' } }, usage: { inputTokens: -1, outputTokens: 3 } },
  });
  assert.equal(invalid, state, 'unsafe counts keep the state reference');

  // A stream-reported usage settles an attempt too.
  let streamed = definition.apply(definition.init({}, 0), attempt(1, 1, TIME_OFF_PEAK, { inputTokens: 7, outputTokens: 2, cacheReadTokens: 3 }));
  assert.equal(streamed.attempts.length, 1, 'stream usage settles an attempt');
  assert.deepEqual(
    { input: streamed.attempts[0].input, cacheRead: streamed.attempts[0].cacheRead, output: streamed.attempts[0].output },
    { input: 7, cacheRead: 3, output: 2 },
  );

  // The view keeps its reference while only the replacement slot moves.
  const before = definition.wire.view(state);
  const slotOnly = definition.apply({ ...state, last: null }, message(5, 5, TIME_PEAK, 1, 1));
  assert.equal(definition.wire.view({ ...slotOnly, last: null }), slotOnly.attempts, 'the view is the attempt array');
  assert.notEqual(definition.wire.view(slotOnly), before, 'a new attempt yields a new array');

  // Schemas accept valid payloads and reject malformed ones.
  assert.equal(definition.wire.viewSchema.parse([state.attempts[0]]).length, 1);
  assert.throws(() => definition.wire.viewSchema.parse([{ turn: 1 }]), TypeError);
  assert.throws(() => definition.wire.viewSchema.parse('nope'), TypeError);
  assert.equal(definition.stateSchema.parse(state).attempts.length, 2);
  assert.throws(() => definition.stateSchema.parse({ attempts: 'no' }), TypeError);
  assert.throws(() => definition.stateSchema.parse({ attempts: [], last: { turn: -1, step: 0 } }), TypeError);

  // The Host registers the unit while the projection registry is available.
  const registrations = [];
  const disposals = [];
  const hostCtx = {
    inject(deps, callback) {
      assert.deepEqual(deps, ['sessionProjections'], 'waits for the projection registry');
      const scope = {
        sessionProjections: {
          register(unit) {
            registrations.push(unit);
            return Promise.resolve({ dispose: async () => { disposals.push(unit.key); } });
          },
        },
      };
      return callback(scope);
    },
  };
  const { apply: hostApply } = await import('../index.js');
  hostApply(hostCtx);
  await Promise.resolve();
  assert.equal(registrations.length, 1, 'registers exactly one unit');
  assert.equal(registrations[0].key, 'turnTokenCost');
}

// ---- Client: shared fake runtime ------------------------------------------

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');

let factory;
const styleElements = [];
const scheduledTimers = [];
vm.runInNewContext(source, {
  window: { __ModuleLoader__: { load: (definition) => { factory = definition.factory; } } },
  document: {
    createElement: () => ({ textContent: '', remove() { styleElements.pop(); } }),
    head: { appendChild: (element) => { styleElements.push(element); } },
  },
  // Timers are recorded, never fired: a bounded-retry assertion without delay.
  setTimeout: (callback, delay) => { scheduledTimers.push(delay); return scheduledTimers.length; },
  clearTimeout: () => {},
}, { filename: 'client.js' });
assert.equal(typeof factory, 'function', 'the bundle registers a factory');

// React shim: state persists per component across renders, effects re-run only
// when their dependencies change, and rendering repeats until a pass changes
// nothing.
let hookStates = [];
let effectStates = [];
let hookIndex = 0;
let pendingEffects = [];
let dirty = false;

const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children };
  },
  useState(initial) {
    const index = hookIndex;
    hookIndex += 1;
    if (!(index in hookStates)) hookStates[index] = typeof initial === 'function' ? initial() : initial;
    const set = (next) => {
      const value = typeof next === 'function' ? next(hookStates[index]) : next;
      if (Object.is(value, hookStates[index])) return;
      hookStates[index] = value;
      dirty = true;
    };
    return [hookStates[index], set];
  },
  useEffect(effect, deps) {
    const index = hookIndex;
    hookIndex += 1;
    pendingEffects.push({ index, effect, deps });
  },
};

/**
 * Render one component to a settled tree.
 * @param {Function} component - component to render.
 * @param {object} props - props.
 * @returns the last element produced.
 */
function render(component, props) {
  let element;
  for (let pass = 0; pass < 8; pass += 1) {
    hookIndex = 0;
    pendingEffects = [];
    dirty = false;
    element = component(props);
    for (const record of pendingEffects) {
      const previous = effectStates[record.index];
      const unchanged = record.deps !== undefined && previous !== undefined
        && record.deps.length === previous.length
        && record.deps.every((dep, index) => Object.is(dep, previous[index]));
      if (unchanged) continue;
      effectStates[record.index] = record.deps;
      record.effect();
    }
    if (!dirty) return element;
  }
  throw new Error('component did not settle');
}

/** Reset the per-component hook slots between surfaces. */
function resetHooks() {
  hookStates = [];
  effectStates = [];
}

// ---- Client: fake services ------------------------------------------------

const localeSnapshot = { active: 'ru' };
// The reported account: a zero-dollar wallet plus the yuan credit the user
// actually topped up.
const wallets = {
  current: [{ currency: 'USD', balance: '0.00' }, { currency: 'CNY', balance: '88.50' }],
  bonus: [],
};
let balanceCalls = 0;
let cachedBalance = { status: 'ready', value: [{ currency: 'USD', balance: '7.25' }], bonusWallets: [] };

const ctxServices = {
  locale: { getSnapshot: () => localeSnapshot },
  remote: {
    account: {
      async getBalance() {
        balanceCalls += 1;
        return { ok: true, value: { status: 'ready', value: wallets.current, bonusWallets: wallets.bonus } };
      },
    },
  },
  accountUi: {
    getSnapshot: () => ({ details: { balance: cachedBalance } }),
    clientMetadata: (locale) => ({ version: 'test', locale, timezoneOffsetSeconds: 0 }),
  },
  sessions: {
    binding: () => undefined,
  },
};

const registrations = {};
const disposers = [];
const accountListeners = new Set();
const injections = [];
const dictionaries = {};
const ctx = {
  get: (name) => ctxServices[name],
  on(event, listener) {
    if (event === 'account-ui/change') accountListeners.add(listener);
    return () => { accountListeners.delete(listener); };
  },
  effect(callback) {
    const dispose = callback();
    if (typeof dispose === 'function') disposers.push(dispose);
    return dispose || (() => {});
  },
  locale: {
    register(ns, dicts) {
      dictionaries.ns = ns;
      dictionaries.en = dicts.en;
      dictionaries.ru = dicts.ru;
      return () => {};
    },
  },
  slots: {
    inject(_name, callback) { return callback(); },
    register(options, component) {
      registrations[options.name] = { options, component };
      return () => {};
    },
  },
  inject(deps, callback) {
    injections.push(deps);
    return callback({ remote: ctxServices.remote });
  },
};

const plugin = factory((specifier) => {
  if (specifier === 'react') return React;
  throw new Error('unexpected require: ' + specifier);
});
plugin.apply(ctx);
assert.equal(registrations['conversation.chat.turnTail'].options.id, 'turn-cost', 'keeps the Turn tail row');
assert.equal(registrations['sidebar.footer.action'].options.id, 'token-cost', 'adds the sidebar foot panel');
assert.equal(registrations['sidebar.footer.action'].options.order, 40);
assert.deepEqual(Array.from(injections[0]), ['remote', 'remote.account'], 'waits for the account namespace');
assert.equal(balanceCalls, 1, 'reads the account wallet once on mount');
assert.equal(styleElements.length, 1, 'inserts one stylesheet for both surfaces');
assert.deepEqual(scheduledTimers, [1500, 6000], 'schedules two bounded wallet retries');

// A wallet read must reach the shared store the surfaces read.
await Promise.resolve();
await Promise.resolve();
await new Promise((resolve) => { setImmediate(resolve); });

const turnTail = registrations['conversation.chat.turnTail'].component;
const footer = registrations['sidebar.footer.action'].component;

// ---- Client: text helpers -------------------------------------------------

/** @returns every rendered text node below one element. */
function text(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return node.children.map(text).join('');
}

/** @returns elements whose className contains `name`. */
function byClass(node, name, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) byClass(child, name, out);
    return out;
  }
  if (typeof node.props.className === 'string' && node.props.className.split(' ').includes(name)) out.push(node);
  for (const child of node.children) byClass(child, name, out);
  return out;
}

const dictionariesRef = dictionaries;
const translate = (locale) => (key, params) => {
  const dict = dictionariesRef[locale] ?? dictionariesRef.en;
  let value = dict[key] === undefined ? dictionariesRef.en[key] ?? key : dict[key];
  for (const [name, replacement] of Object.entries(params ?? {})) {
    value = value.split('{' + name + '}').join(String(replacement));
  }
  return value;
};

// ---- Client: the answer row ----------------------------------------------

const attempts = [{
  turn: 1, time: TIME_PEAK, model: 'deepseek-flash', input: 12300, cacheRead: 4500, cacheWrite: 0, output: 1200,
}];

/** Props of the Turn tail row for one Turn. */
function tailProps(projected, overrides = {}) {
  return {
    turn: {
      turn: 1,
      end: { time: TIME_PEAK },
      data: { get: (key) => (key === 'turn-tail' ? {
        tokenUsage: { uncachedInputTokens: 12300, cacheReadTokens: 4500, cacheWriteTokens: 0, outputTokens: 1200, routes: [{ provider: 'deepseek-account', model: 'deepseek-flash' }] },
      } : undefined) },
    },
    useProjection: () => projected,
    stores: { balance: storeFromWallets() },
    t: translate('ru'),
    ...overrides,
  };
}

/** A writable stand-in for the plugin's shared balance store. */
function fakeStore(value) {
  let current = value;
  const listeners = new Set();
  return {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set(next) {
      if (Object.is(next, current)) return;
      current = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

/** A stand-in balance store with the value the panel would have published. */
function storeFromWallets() {
  return fakeStore({ status: 'ready', wallets: wallets.current, bonusWallets: wallets.bonus });
}

resetHooks();
{
  const closed = render(turnTail, tailProps(attempts));
  assert.equal(text(byClass(closed, 'dsh-token-cost-trigger')[0]), 'Стоимость\u2248 $0.00516',
    'the answer row is priced in the display currency, whatever the wallet holds');
  assert.ok(byClass(closed, 'dsh-token-cost-trigger')[0], 'the row is a button');
}

resetHooks();
{
  // USD table, peak Monday 10:00 Beijing: 12300*0.30 + 4500*0.006 + 1200*1.20 per 1e6.
  const closed = render(turnTail, tailProps(attempts));
  const trigger = byClass(closed, 'dsh-token-cost-trigger')[0];
  assert.equal(trigger.children[2].children[0], '\u2248 $0.00516', 'uses the display-currency rate table');
  assert.equal(trigger.props['aria-expanded'], false, 'the breakdown starts closed');
  // Open it the way a user does, then render the settled tree again.
  trigger.props.onClick();
  const open = render(turnTail, tailProps(attempts));
  assert.equal(byClass(open, 'dsh-token-cost-trigger')[0].props['aria-expanded'], true, 'a click expands it');
  const breakdown = text(byClass(open, 'dsh-token-cost-breakdown')[0]);
  for (const expected of [
    'Модель', 'deepseek-flash',
    'Тариф', 'пиковый (по каждому запросу)',
    'Ввод без кэша', '12.3 тыс. \u00d7 $0.30 за 1 млн = $0.00369',
    'Ввод из кэша', '4.5 тыс. \u00d7 $0.006 за 1 млн = $0.00003',
    'Вывод', '1.2 тыс. \u00d7 $1.20 за 1 млн = $0.00144',
    'Оценка по данным провайдера',
  ]) {
    assert.ok(breakdown.includes(expected), 'breakdown states: ' + expected);
  }
  assert.ok(!breakdown.includes('запись в кэш'), 'a zero cache-write bucket is omitted');
}

resetHooks();
{
  // No projection value: the shipped Turn footer supplies the attempt.
  const fallback = render(turnTail, tailProps(undefined));
  assert.equal(text(byClass(fallback, 'dsh-token-cost-trigger')[0]), 'Стоимость\u2248 $0.00516',
    'falls back to the shipped per-Turn usage');
}

resetHooks();
{
  // Neither source reports billing for this Turn.
  const none = {
    turn: { turn: 1, end: { time: TIME_PEAK }, data: { get: () => undefined } },
    useProjection: () => [],
    stores: { balance: storeFromWallets() },
    t: translate('ru'),
  };
  assert.equal(render(turnTail, none), null, 'a Turn with no attempts shows no row');
}

resetHooks();
{
  const noTurn = render(turnTail, tailProps(attempts, { turn: undefined }));
  assert.equal(noTurn, null, 'a row without a Turn renders nothing');
}

// ---- Client: the sidebar panel -------------------------------------------

/** Fake Session binding with one projection face. */
function bindingWith(value) {
  const value2 = { current: value };
  const listeners = new Set();
  const face = {
    getSnapshot: () => value2.current,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return {
    face,
    binding: { session: { projections: { faceOf: (key) => (key === 'turnTokenCost' ? face : undefined) } } },
    push(next) { value2.current = next; for (const listener of listeners) listener(); },
  };
}

const sessionBinding = bindingWith(attempts);
ctxServices.sessions.binding = (id) => (id === 'session-1' ? sessionBinding.binding : undefined);

// A store the panel reads: reuse the plugin's own store through the inject face
// so a wallet read the panel triggers is visible to it.
/** Props of the sidebar foot panel. */
function footProps(wide) {
  return {
    wide,
    useSessions: (selector) => selector({ ids: ['session-0', 'session-1'], byId: {
      'session-0': { retainedBy: { mainView: 0 } },
      'session-1': { retainedBy: { mainView: 1 } },
    } }),
    ctx,
    stores: sharedStores,
    refreshBalance: () => { refreshRequests += 1; },
    t: translate('ru'),
  };
}
let refreshRequests = 0;

// Capture the plugin's own store by reading the value the panel publishes: the
// inject face is produced by the plugin, so reach it through a registration.
const injected = registrations['sidebar.footer.action'];
const footInject = () => injected.options.inject();
const sharedStores = footInject().stores;

resetHooks();
let foot;
{
  foot = render(footer, footProps(true));
  const body = text(foot);
  // 88.50 CNY / 6.7 = 13.2089 USD, truncated to the account's two decimals.
  assert.match(body, /≈ \$13\.20/, 'converts the yuan wallet into the display currency');
  assert.match(body, /Расход сессии/, 'labels the second figure as a spend, not a name');
  assert.match(body, /\$0\.00516/, 'shows the Session spend in the display currency');
  assert.equal(foot.props.className, 'dsh-token-cost-foot', 'the wide panel is one footer row');
  assert.equal(foot.children.length, 3, 'row: glyph, balance, session spend');
  assert.match(foot.props.title, /^Баланс: ≈ \$13\.20/, 'the tooltip leads with the converted balance');
  assert.ok(foot.props.title.includes('Кошелёк: $0.00'), 'the tooltip names the dollar wallet');
  assert.ok(foot.props.title.includes('Кошелёк: ¥88.50'), 'the tooltip names the yuan wallet');
  assert.ok(foot.props.title.includes('Пересчёт по курсу 1 USD = 6.7 CNY'), 'the tooltip states the rate applied');
  assert.ok(foot.props.title.includes('Расход сессии: $0.00516 за 18 тыс. токенов'), 'the tooltip repeats the spend');
  assert.ok(foot.props.title.includes('Сессии субагентов считаются отдельно.'), 'the tooltip explains the scope');
  assert.ok(foot.props.title.includes(' · '), 'the tooltip stays on one line');
}

resetHooks();
{
  const rail = render(footer, footProps(false));
  assert.equal(rail.props.className, 'dsh-token-cost-foot-rail', 'the rail keeps a glyph only');
  assert.match(rail.props.title, /≈ \$13\.20/, 'the rail tooltip carries both figures');
  assert.equal(rail.children.length, 1, 'the rail renders the glyph alone');
}

resetHooks();
{
  const anonymous = render(footer, { ...footProps(true), useSessions: () => undefined });
  assert.match(text(anonymous), /≈ \$13\.20/, 'a Session-less panel still shows the balance');
  assert.doesNotMatch(text(anonymous), /Расход сессии/, 'a Session-less panel omits the Session figure');
}

resetHooks();
{
  // Bonuses stay out of the row but not out of the tooltip.
  wallets.bonus = [{ currency: 'CNY', balance: '5.00' }];
  const withBonus = render(footer, { ...footProps(true), stores: { balance: storeFromWallets() } });
  assert.ok(withBonus.props.title.includes('Бонусы: ¥5.00'), 'a bonus wallet is named in the tooltip');
  assert.doesNotMatch(text(withBonus), /13\.95/, 'the row keeps one amount');
  wallets.bonus = [];
}

resetHooks();
{
  // An all-dollar account needs no conversion mark and no per-wallet detail.
  wallets.current = [{ currency: 'USD', balance: '12.00' }];
  const dollars = render(footer, { ...footProps(true), stores: { balance: storeFromWallets() } });
  assert.match(text(dollars), /\$12\.00/, 'an all-dollar wallet reads plainly');
  assert.equal(dollars.children[1].children[0], '$12.00', 'no conversion mark without conversion');
  assert.doesNotMatch(dollars.props.title, /Пересчёт/, 'no rate line without conversion');
  wallets.current = [{ currency: 'USD', balance: '0.00' }, { currency: 'CNY', balance: '88.50' }];
}

resetHooks();
{
  // A sub-cent balance stays readable after conversion.
  const tiny = fakeStore({ status: 'ready', wallets: [{ currency: 'CNY', balance: '0.004' }], bonusWallets: [] });
  const panel = render(footer, { ...footProps(true), stores: { balance: tiny }, useSessions: () => undefined });
  assert.match(text(panel), /<\$0\.01/, 'a sub-cent balance is not rounded to zero');
}

resetHooks();
{
  // No wallet and no Session: nothing to say.
  const emptyStores = { balance: { getSnapshot: () => ({ status: 'failed', wallets: [] }), subscribe: () => () => {} } };
  const empty = render(footer, { ...footProps(true), stores: emptyStores, useSessions: () => undefined });
  assert.equal(empty, null, 'an unknown account with no Session renders nothing');
}

resetHooks();
{
  // A projection update must reach the panel through its subscription.
  const live = bindingWith(attempts);
  ctxServices.sessions.binding = (id) => (id === 'session-1' ? live.binding : undefined);
  const store = storeFromWallets();
  const first = render(footer, { ...footProps(true), stores: { balance: store } });
  assert.match(text(first), /\$0\.00516/, 'the panel starts at the loaded attempts');
  live.push([...attempts, {
    turn: 2, time: TIME_OFF_PEAK, model: 'deepseek-flash', input: 1000, cacheRead: 0, cacheWrite: 0, output: 100,
  }]);
  // Off-peak: 1000*0.15 + 100*0.60 per 1e6 = 0.00021, added to the peak attempt.
  const second = render(footer, { ...footProps(true), stores: { balance: store } });
  assert.match(text(second), /\$0\.00537/, 'a new attempt updates the session figure');
  assert.ok(refreshRequests >= 1, 'a rising session figure re-reads the wallet');
  ctxServices.sessions.binding = (id) => (id === 'session-1' ? sessionBinding.binding : undefined);
}

// ---- Client: a yuan-only account -----------------------------------------

resetHooks();
{
  wallets.current = [{ currency: 'CNY', balance: '67.00' }];
  const yuanStore = storeFromWallets();
  const footYuan = render(footer, { ...footProps(true), stores: { balance: yuanStore } });
  assert.match(text(footYuan), /≈ \$10\.00/, 'a yuan-only account still reads in dollars');
  assert.match(text(footYuan), /\$0\.00516/, 'the Session figure stays in the display currency');
  assert.ok(footYuan.props.title.includes('Пересчёт по курсу 1 USD = 6.7 CNY'), 'the applied rate is stated');
  wallets.current = [{ currency: 'USD', balance: '0.00' }, { currency: 'CNY', balance: '88.50' }];
}

// ---- Client: wallet source fallback --------------------------------------

{
  // The Host read is refused: the account UI's already-read balance is used.
  ctxServices.remote.account.getBalance = async () => ({ ok: false, error: { code: 'remote-access/denied' } });
  cachedBalance = { status: 'ready', value: [{ currency: 'USD', balance: '7.25' }], bonusWallets: [] };
  const face = registrations['sidebar.footer.action'].options.inject();
  face.refreshBalance();
  await new Promise((resolve) => { setImmediate(resolve); });
  const snapshot = face.stores.balance.getSnapshot();
  assert.equal(snapshot.status, 'ready', 'a refused read still yields a wallet');
  assert.equal(snapshot.wallets[0].balance, '7.25', 'the cached account balance is published');
  resetHooks();
  const fallbackPanel = render(footer, { ...footProps(true), stores: face.stores });
  assert.match(text(fallbackPanel), /\$7\.25/, 'the panel shows the cached balance');
}

// ---- Client: disposal -----------------------------------------------------

for (const dispose of disposers) dispose();
assert.equal(styleElements.length, 0, 'unloading removes the stylesheet');

console.log('ok — host fold, answer row, sidebar panel, and currency rule checked');
