/**
 * Money view of DeepSeek usage for the DeepSeek Harness Web client.
 *
 * Two surfaces, one exact source:
 * - the completed-answer row in the Chat flow (the shipped Turn tail), and
 * - the balance panel at the sidebar foot: the account wallet plus the open
 *   Session's spend.
 *
 * Both price the attempts of the Host projection `turnTokenCost` (see
 * index.js): provider-reported token buckets, the exact provider/model route,
 * and the event time of every billed request. Each attempt is priced at the
 * published rate of its own model and of its own instant, so neither surface
 * has to guess a model from what happens to be on screen.
 *
 * The money currency follows the signed-in account wallet (CNY or USD); the
 * published rate table of that currency is applied. Without a wallet the panel
 * shows the Session figure in USD.
 *
 * Costs are estimates: prices and peak windows are configuration, not billed
 * charges. Nothing here sends data anywhere or adds model-visible content.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-token-cost',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'token-cost';
    /** Host projection key owned by index.js. */
    const PROJECTION_KEY = 'turnTokenCost';
    /** Billed token buckets, in display order. */
    const BUCKET_KEYS = ['input', 'cacheRead', 'cacheWrite', 'output'];

    // Rates per 1,000,000 tokens as [off-peak, peak]. DeepSeek peak hours are
    // Beijing time (UTC+8) 09:00-12:00 and 14:00-18:00 on weekdays; every other
    // hour, and whole weekends, are off-peak. Chinese public holidays are not
    // modelled, so a holiday weekday is priced as peak.
    // Source: https://api-docs.deepseek.com/quick_start/pricing
    const USD = {
      'deepseek-flash': { cacheRead: [0.003, 0.006], input: [0.15, 0.3], output: [0.6, 1.2] },
      'deepseek-v4-pro': { cacheRead: [0.022, 0.044], input: [0.66, 1.32], output: [1.98, 3.96] },
    };
    const CNY = {
      'deepseek-flash': { cacheRead: [0.02, 0.04], input: [1, 2], output: [4, 8] },
      'deepseek-v4-pro': { cacheRead: [0.15, 0.3], input: [4.5, 9], output: [13.5, 27] },
    };
    const TABLES = { USD: USD, CNY: CNY };
    const SYMBOLS = { USD: '$', CNY: '\u00a5' };
    /**
     * Money is always shown in this currency: the published rates, the Session
     * figure, and the wallet total. A wallet the account keeps in another
     * currency is converted, because a top-up currency must not make the
     * balance unreadable.
     */
    const DISPLAY_CURRENCY = 'USD';
    /**
     * Units of each currency per 1 USD, used only to show one figure in the
     * display currency. Edit when the rate moves; USD is by definition 1.
     * The yuan figure is the mid-market rate on 2026-11-22.
     */
    const RATES_TO_USD = { USD: 1, CNY: 6.7 };
    const DEFAULT_MODEL = 'deepseek-flash';
    // A retired or aliased model id bills at the price of the model that serves it.
    const MODEL_ALIASES = {
      'deepseek-flash': 'deepseek-flash',
      'deepseek-v4-flash': 'deepseek-flash',
      'deepseek-v4-flash-vision-exp': 'deepseek-flash',
      'deepseek-chat': 'deepseek-flash',
      'deepseek-v4-pro': 'deepseek-v4-pro',
      'deepseek-v4': 'deepseek-v4-pro',
      'deepseek-reasoner': 'deepseek-v4-pro',
    };

    /** Every rule below wears this package's prefix. */
    const CSS = [
      '.dsh-token-cost-row{display:flex;flex-direction:column;align-items:flex-start;gap:6px;min-width:0}',
      '.dsh-token-cost-trigger{display:inline-flex;align-items:center;gap:4px;min-width:0;'
        + 'height:calc(28px + var(--dsh-content-font-delta,0px));padding:6px 8px;border:none;'
        + 'border-radius:var(--dsw-radius-sm,8px);background:transparent;'
        + 'color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));'
        + 'font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);'
        + 'font-variant-numeric:tabular-nums;'
        + 'line-height:calc(24px + var(--dsh-content-font-delta,0px));white-space:nowrap;cursor:pointer}',
      '.dsh-token-cost-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,140,180,.12));'
        + 'color:var(--dsw-alias-label-secondary)}',
      '.dsh-token-cost-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dsh-token-cost-trigger[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,140,180,.12));'
        + 'color:var(--dsw-alias-label-secondary)}',
      '.dsh-token-cost-trigger svg{width:calc(15px + var(--dsh-content-font-delta,0px));'
        + 'height:calc(15px + var(--dsh-content-font-delta,0px));flex:none}',
      '.dsh-token-cost-label,.dsh-token-cost-amount{min-width:0;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-token-cost-amount{color:var(--dsw-alias-label-primary);font-weight:500}',
      '.dsh-token-cost-trigger:hover .dsh-token-cost-amount,'
        + '.dsh-token-cost-trigger[aria-expanded="true"] .dsh-token-cost-amount{color:var(--dsw-alias-label-primary)}',
      '.dsh-token-cost-breakdown{display:flex;flex-direction:column;gap:4px;padding:2px 8px 4px}',
      '.dsh-token-cost-details{display:grid;grid-template-columns:auto auto;column-gap:12px;row-gap:3px;'
        + 'margin:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);'
        + 'line-height:1.45;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}',
      '.dsh-token-cost-details dt{margin:0}',
      '.dsh-token-cost-details dd{margin:0;font-variant-numeric:tabular-nums;'
        + 'color:var(--dsw-alias-label-secondary);text-align:right}',
      '.dsh-token-cost-note{margin:0;max-width:44ch;'
        + 'font-size:calc(var(--dsh-content-font-size-secondary,13px) - 2px);line-height:1.45;'
        + 'color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}',
      '.dsh-token-cost-foot{display:flex;align-items:center;gap:6px;flex:1 1 auto;min-width:0;'
        + 'padding:6px 12px 8px;box-sizing:border-box;'
        + 'font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:1.5}',
      '.dsh-token-cost-foot svg{width:15px;height:15px;flex:none;'
        + 'color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}',
      '.dsh-token-cost-foot-balance{color:var(--dsw-alias-label-primary);'
        + 'font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.dsh-token-cost-foot-session{display:flex;align-items:center;gap:4px;min-width:0;margin-left:auto;'
        + 'color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}',
      '.dsh-token-cost-foot-session-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-token-cost-foot-session-value{color:var(--dsw-alias-label-secondary);'
        + 'font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.dsh-token-cost-foot-rail{display:flex;align-items:center;justify-content:center;width:36px;height:36px;'
        + 'color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}',
      '.dsh-token-cost-foot-rail svg{width:15px;height:15px;flex:none}',
      '@media (max-width:480px){.dsh-token-cost-label{display:none}}',
    ].join('');

    /**
     * Currency with a published rate table.
     * @param {unknown} code - candidate currency code.
     * @returns the code, or the display currency.
     */
    function currencyOr(code) {
      return typeof code === 'string' && TABLES[code] !== undefined ? code : DISPLAY_CURRENCY;
    }

    /**
     * @param {string} currency - currency code.
     * @returns its display symbol.
     */
    function symbolFor(currency) {
      return SYMBOLS[currency] === undefined ? SYMBOLS[DISPLAY_CURRENCY] : SYMBOLS[currency];
    }

    /**
     * Rate key for one reported model id.
     * @param {unknown} model - provider model id, possibly absent.
     * @returns the mapped model key, or the default model.
     */
    function rateKeyFor(model) {
      const key = MODEL_ALIASES[String(model === undefined || model === null ? '' : model).toLowerCase()];
      return key !== undefined ? key : DEFAULT_MODEL;
    }

    /**
     * Whether one instant falls into DeepSeek peak hours.
     * @param {number} time - epoch milliseconds.
     * @returns true for a weekday 09:00-12:00 or 14:00-18:00 in Beijing time.
     */
    function isPeak(time) {
      const shifted = new Date(Number(time) + 8 * 60 * 60 * 1000);
      const day = shifted.getUTCDay();
      if (!(day >= 1 && day <= 5)) return false;
      const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
      return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60);
    }

    /**
     * @param {unknown} tokens - billed token count.
     * @param {number} rate - currency units per 1,000,000 tokens.
     * @returns the money cost of those tokens.
     */
    function costOf(tokens, rate) {
      const count = Number(tokens);
      return Number.isFinite(count) && count > 0 ? (count * rate) / 1e6 : 0;
    }

    /**
     * Price a list of billed attempts.
     * @param {readonly any[] | undefined} attempts - projection attempts.
     * @param {string} currency - currency code for the rate table.
     * @returns money totals, per-bucket aggregates with effective rates, and
     * the peak mix of the attempts.
     */
    function priceAttempts(attempts, currency) {
      const code = currencyOr(currency);
      const table = TABLES[code];
      const buckets = {};
      for (const key of BUCKET_KEYS) buckets[key] = { tokens: 0, cost: 0 };
      let cost = 0;
      let tokens = 0;
      let peakCount = 0;
      let offPeakCount = 0;
      const models = new Set();
      const unmapped = new Set();
      for (const attempt of attempts || []) {
        if (attempt === null || attempt === undefined) continue;
        const reported = typeof attempt.model === 'string' ? attempt.model : '';
        const key = rateKeyFor(reported);
        const rate = table[key];
        if (reported !== '' && MODEL_ALIASES[reported.toLowerCase()] === undefined) unmapped.add(reported);
        models.add(reported === '' ? key : reported);
        const peak = isPeak(attempt.time);
        if (peak) peakCount += 1;
        else offPeakCount += 1;
        const index = peak ? 1 : 0;
        const parts = [
          ['input', attempt.input, rate.input[index]],
          ['cacheRead', attempt.cacheRead, rate.cacheRead[index]],
          // DeepSeek bills a cache write as ordinary prompt input.
          ['cacheWrite', attempt.cacheWrite, rate.input[index]],
          ['output', attempt.output, rate.output[index]],
        ];
        for (const [bucket, count, unit] of parts) {
          const money = costOf(count, unit);
          buckets[bucket].tokens += Number(count) || 0;
          buckets[bucket].cost += money;
          cost += money;
          tokens += Number(count) || 0;
        }
      }
      return {
        currency: code,
        cost: cost,
        tokens: tokens,
        count: peakCount + offPeakCount,
        models: [...models],
        unmapped: [...unmapped],
        peak: peakCount > 0 && offPeakCount > 0 ? 'mixed' : peakCount > 0 ? 'peak' : 'offPeak',
        buckets: BUCKET_KEYS.map(key => ({
          key: key,
          tokens: buckets[key].tokens,
          cost: buckets[key].cost,
          // Weighted effective rate: the money is exact even when one bucket
          // spans several attempts at different rates.
          rate: buckets[key].tokens > 0 ? (buckets[key].cost / buckets[key].tokens) * 1e6 : 0,
        })),
      };
    }

    /**
     * Drop trailing zero decimals so `12.30` reads `12.3` and `12.00` reads `12`.
     * @param {string} text - decimal text produced by toFixed.
     * @returns text without trailing zero decimals.
     */
    function trimZeros(text) {
      return text.indexOf('.') < 0 ? text : text.replace(/\.?0+$/, '');
    }

    /**
     * Localized unit suffix, falling back when the locale seat is absent.
     * @param {Function} t - translate function.
     * @param {string} key - dictionary key.
     * @param {string} fallback - suffix used when the dictionary has no entry.
     * @returns the suffix.
     */
    function unit(t, key, fallback) {
      const text = t(key);
      return text === key ? fallback : text;
    }

    /**
     * @param {unknown} value - token count.
     * @param {Function} t - translate function, for the locale's unit suffixes.
     * @returns compact text such as `940`, `12.3k`, or `1.05M`.
     */
    function formatTokens(value, t) {
      const count = Number(value);
      if (!Number.isFinite(count) || count <= 0) return '0';
      if (count < 1000) return String(count);
      if (count < 1e6) {
        return trimZeros((count / 1000).toFixed(count < 1e4 ? 2 : 1)) + unit(t, 'unitThousand', 'k');
      }
      return trimZeros((count / 1e6).toFixed(2)) + unit(t, 'unitMillion', 'M');
    }

    /**
     * @param {unknown} value - amount in some currency.
     * @param {string} currency - currency code.
     * @returns money text with the currency symbol.
     */
    function formatMoney(value, currency) {
      const symbol = symbolFor(currency);
      const amount = Number(value);
      if (!Number.isFinite(amount) || amount <= 0) return symbol + '0.00';
      if (amount < 0.00001) return '<' + symbol + '0.00001';
      const digits = amount >= 1 ? 2 : amount >= 0.1 ? 3 : amount >= 0.01 ? 4 : 5;
      return symbol + amount.toFixed(digits);
    }

    /**
     * @param {unknown} value - currency units per 1,000,000 tokens.
     * @param {string} currency - currency code.
     * @returns rate text with at least two decimals.
     */
    function formatRate(value, currency) {
      const symbol = symbolFor(currency);
      const rate = Number(value);
      if (!Number.isFinite(rate) || rate <= 0) return symbol + '0.00';
      const text = trimZeros(rate.toFixed(4));
      return symbol + (text.indexOf('.') < 0 ? text + '.00' : text.length - text.indexOf('.') < 3 ? text + '0' : text);
    }

    /**
     * One amount expressed in the display currency.
     * @param {unknown} amount - amount in its own currency.
     * @param {unknown} currency - that currency's code.
     * @returns the amount in the display currency, or undefined for a currency
     * this build has no rate for.
     */
    function amountInDisplay(amount, currency) {
      const code = String(currency === undefined || currency === null ? '' : currency).toUpperCase();
      const rate = RATES_TO_USD[code];
      const units = Number(amount);
      if (!Number.isFinite(units) || rate === undefined || !(rate > 0)) return undefined;
      return units / rate;
    }

    /**
     * Sum wallets into one display-currency figure.
     * @param {readonly any[] | undefined} wallets - account wallets.
     * @returns the total, whether any wallet needed conversion, and the
     * currencies this build cannot convert; undefined when nothing is known.
     */
    function walletTotal(wallets) {
      let total = 0;
      let converted = false;
      let known = false;
      const unknown = new Set();
      for (const wallet of wallets || []) {
        if (wallet === null || wallet === undefined) continue;
        const code = String(wallet.currency === undefined || wallet.currency === null ? '' : wallet.currency).toUpperCase();
        const value = amountInDisplay(wallet.balance, code);
        if (value === undefined) {
          unknown.add(code === '' ? '?' : code);
          continue;
        }
        known = true;
        total += value;
        if (code !== DISPLAY_CURRENCY) converted = true;
      }
      return known ? { total: total, converted: converted, unknown: [...unknown] } : undefined;
    }

    /**
     * @param {unknown} amount - amount in the display currency.
     * @returns money text with two decimals, or `<0.01` below one cent.
     */
    function formatDisplay(amount) {
      const symbol = symbolFor(DISPLAY_CURRENCY);
      const value = Number(amount);
      if (!Number.isFinite(value)) return symbol + '0.00';
      if (value < 0) return '-' + symbol + walletDigits(Math.abs(value));
      if (value > 0 && value < 0.01) return '<' + symbol + '0.01';
      return symbol + walletDigits(value);
    }

    /**
     * The exchange rates this build applies, in one readable clause.
     * @returns text such as `1 USD = 6.7 CNY`.
     */
    function fxPairs() {
      return Object.keys(RATES_TO_USD)
        .filter(code => code !== DISPLAY_CURRENCY)
        .map(code => '1 ' + DISPLAY_CURRENCY + ' = ' + String(RATES_TO_USD[code]) + ' ' + code)
        .join(', ');
    }

    /**
     * Two decimals, truncated rather than rounded up, with grouped digits.
     * @param {number} value - positive amount.
     * @returns money digits with a '.' decimal point.
     */
    function walletDigits(value) {
      const text = (Math.floor(value * 100 + 1e-9) / 100).toFixed(2);
      const parts = text.split('.');
      return Number(parts[0]).toLocaleString() + '.' + parts[1];
    }

    /**
     * Format one wallet's amount the way the account surfaces do: grouped
     * digits, a '.' decimal point, and `<0.01` below one cent.
     * @param {unknown} wallet - one account wallet.
     * @returns the wallet amount as money text.
     */
    function formatWallet(wallet) {
      const symbol = symbolFor(currencyOr(wallet && wallet.currency));
      const raw = String(wallet === null || wallet === undefined ? '' : wallet.balance);
      const value = Number(raw);
      if (!Number.isFinite(value)) return symbol + raw;
      if (value === 0) return symbol + '0.00';
      if (value < 0) return '-' + symbol + (Math.abs(value) < 0.01 ? '0.01' : walletDigits(Math.abs(value)));
      if (value < 0.01) return '<' + symbol + '0.01';
      return symbol + walletDigits(value);
    }

    /**
     * One tiny observable store shared by both surfaces.
     * @param {any} initial - initial value.
     * @returns the store.
     */
    function createStore(initial) {
      let value = initial;
      const listeners = new Set();
      return {
        getSnapshot: () => value,
        subscribe(listener) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        set(next) {
          if (Object.is(next, value)) return;
          value = next;
          for (const listener of [...listeners]) listener();
        },
      };
    }

    /**
     * Subscribe a component to one store.
     * @param {{ getSnapshot: () => any, subscribe: (listener: () => void) => () => void }} store - store.
     * @returns the current value.
     */
    function useStore(store) {
      const [value, setValue] = React.useState(store.getSnapshot);
      React.useEffect(() => {
        setValue(store.getSnapshot());
        return store.subscribe(() => { setValue(store.getSnapshot()); });
      }, [store]);
      return value;
    }

    /** Coin stack glyph; inherits the current text color. */
    function CoinGlyph() {
      return h(
        'svg',
        {
          viewBox: '0 0 36 36',
          'aria-hidden': true,
          focusable: false,
          style: { display: 'block' },
        },
        h('ellipse', {
          cx: 18, cy: 11.5, rx: 8.5, ry: 3.5,
          fill: 'none', stroke: 'currentColor', strokeWidth: 2.6,
        }),
        h('path', {
          d: 'M9.5 11.5v5.6a8.5 3.5 0 0 0 17 0v-5.6',
          fill: 'none', stroke: 'currentColor', strokeWidth: 2.6,
        }),
        h('path', {
          d: 'M9.5 17.1v5.6a8.5 3.5 0 0 0 17 0v-5.6',
          fill: 'none', stroke: 'currentColor', strokeWidth: 2.6,
        }),
      );
    }

    /**
     * Attempts of one Turn, from the projection with the shipped footer as a fallback.
     * @param {readonly any[] | undefined} projected - whole-Session attempts.
     * @param {any} turn - Turn tail owner currency.
     * @returns the Turn's attempts, or an empty list.
     */
    function collectTurnAttempts(projected, turn) {
      const number = turn.turn;
      if (Array.isArray(projected)) {
        const rows = projected.filter(attempt => attempt !== null && attempt !== undefined && attempt.turn === number);
        if (rows.length > 0) return rows;
      }
      const store = turn.data;
      if (store === null || store === undefined || typeof store.get !== 'function') return [];
      const tail = store.get('turn-tail');
      const usage = tail === null || tail === undefined ? undefined : tail.tokenUsage;
      if (usage === null || usage === undefined) return [];
      const routes = Array.isArray(usage.routes) ? usage.routes : [];
      return [{
        turn: number,
        time: turn.end !== null && turn.end !== undefined && typeof turn.end.time === 'number' ? turn.end.time : Date.now(),
        model: routes.length > 0 && routes[0] !== undefined ? routes[0].model : undefined,
        input: usage.uncachedInputTokens || 0,
        cacheRead: usage.cacheReadTokens || 0,
        cacheWrite: usage.cacheWriteTokens || 0,
        output: usage.outputTokens || 0,
      }];
    }

    /**
     * The Session the main view shows.
     * @param {{ ids?: readonly string[], byId?: Record<string, any> } | undefined} state - Session list state.
     * @returns that Session id, when one is retained by the main view.
     */
    function mainSessionId(state) {
      if (state === null || state === undefined) return undefined;
      const ids = Array.isArray(state.ids) ? state.ids : [];
      for (const id of ids) {
        const row = state.byId === undefined ? undefined : state.byId[id];
        const retained = row === null || row === undefined ? undefined : row.retainedBy;
        if (retained !== null && retained !== undefined && (retained.mainView || 0) > 0) return id;
      }
      return undefined;
    }

    /**
     * Money cost of one completed Turn, rendered in the shipped Turn tail.
     * @param {any} props - Turn-tail owner currency, the projection seat, and
     * the locale seat; other shipped properties are unused here.
     * @returns the cost trigger with its expandable breakdown, or null when the
     * Turn reports no billed tokens.
     */
    function TurnCost(props) {
      // One hook, before every early return: a Turn that loses its usage must not
      // change the hook order of an already-mounted row.
      const [open, setOpen] = React.useState(false);
      const projected = typeof props.useProjection === 'function' ? props.useProjection(PROJECTION_KEY) : undefined;
      const turn = props.turn;
      if (turn === null || turn === undefined) return null;
      const attempts = collectTurnAttempts(projected, turn);
      if (attempts.length === 0) return null;
      // One money currency everywhere: the display currency, not the wallet's.
      const priced = priceAttempts(attempts, DISPLAY_CURRENCY);
      if (!(priced.cost > 0)) return null;
      const t = typeof props.t === 'function' ? props.t : function fallback(key) { return key; };
      const amount = formatMoney(priced.cost, priced.currency);
      const period = priced.peak === 'mixed' ? t('mixedPeriod') : priced.peak === 'peak' ? t('peak') : t('offPeak');
      const rows = [];
      rows.push(h('dt', { key: 'model' }, t('model')));
      rows.push(h('dd', { key: 'modelValue' }, priced.models.length === 0 ? t('unknown') : priced.models.join(', ')));
      rows.push(h('dt', { key: 'period' }, t('period')));
      rows.push(h('dd', { key: 'periodValue' }, period));
      for (const bucket of priced.buckets) {
        if (bucket.tokens <= 0) continue;
        rows.push(h('dt', { key: bucket.key }, t('bucket.' + bucket.key)));
        rows.push(h('dd', { key: bucket.key + 'Value' }, t('line', {
          tokens: formatTokens(bucket.tokens, t),
          rate: formatRate(bucket.rate, priced.currency),
          amount: formatMoney(bucket.cost, priced.currency),
        })));
      }
      const notes = [];
      if (priced.unmapped.length > 0) {
        notes.push(t('unmapped', { models: priced.unmapped.join(', '), pricedAs: DEFAULT_MODEL }));
      }
      notes.push(t('note'));
      return h(
        'div',
        { className: 'dsh-token-cost-row' },
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-token-cost-trigger',
            'aria-expanded': open,
            onClick: function toggle() { setOpen(!open); },
          },
          h(CoinGlyph, null),
          h('span', { className: 'dsh-token-cost-label' }, t('label')),
          h('span', { className: 'dsh-token-cost-amount' }, t('approx', { cost: amount })),
        ),
        open
          ? h('div', {
            className: 'dsh-token-cost-breakdown',
            role: 'group',
            'aria-label': t('title'),
          },
          h('dl', { className: 'dsh-token-cost-details' }, rows),
          h('p', { className: 'dsh-token-cost-note' }, notes.join(' ')))
          : null,
      );
    }

    /**
     * The balance panel at the sidebar foot: account wallet and the open
     * Session's spend.
     * @param {any} props - `wide`, the Session-list hook, the plugin context, and
     * the locale seat.
     * @returns the panel, its rail glyph, or null when nothing is known yet.
     */
    function BalancePanel(props) {
      const t = typeof props.t === 'function' ? props.t : function fallback(key) { return key; };
      const balance = useStore(props.stores.balance);
      const wallets = balance !== null && balance !== undefined && Array.isArray(balance.wallets) ? balance.wallets : [];
      const bonuses = balance !== null && balance !== undefined && Array.isArray(balance.bonusWallets)
        ? balance.bonusWallets.filter(candidate => Number(candidate && candidate.balance) > 0)
        : [];
      // One figure in the display currency, whichever currency holds the credit.
      const total = walletTotal(wallets);
      const sessionId = typeof props.useSessions === 'function' ? props.useSessions(mainSessionId) : undefined;
      const attempts = useSessionAttempts(props.ctx, sessionId);
      const session = attempts === undefined ? null : priceAttempts(attempts, DISPLAY_CURRENCY);
      const hasSession = session !== null && session.cost > 0;
      // Every newly priced attempt means the Session just spent money: re-read
      // the wallet it spent from. The key rounds the reading so a re-render
      // with the same figure issues no request.
      const spentKey = hasSession ? Math.round(session.cost * 1e8) : -1;
      React.useEffect(() => {
        if (spentKey <= 0) return;
        if (typeof props.refreshBalance === 'function') props.refreshBalance();
      }, [spentKey, props.refreshBalance]);
      if (total === undefined && !hasSession) return null;
      const totalText = total === undefined ? null : formatDisplay(total.total);
      // A lower-bound reading is already approximate; only mark a real conversion.
      const balanceText = totalText === null
        ? null
        : total.converted && totalText.charAt(0) !== '<'
          ? t('approx', { cost: totalText })
          : totalText;
      const summary = [];
      if (balanceText !== null) summary.push(t('balanceLine', { amount: balanceText }));
      // The row has room for one figure; the original wallets, the rate applied,
      // and every bonus stay in the tooltip.
      const showsDetail = wallets.length > 1 || (total !== undefined && total.converted);
      if (showsDetail) {
        for (const candidate of wallets) {
          summary.push(t('walletLine', { amount: formatWallet(candidate) }));
        }
        if (total !== undefined && total.converted) summary.push(t('fxLine', { pairs: fxPairs() }));
      }
      if (total !== undefined && total.unknown.length > 0) {
        summary.push(t('unknownCurrency', { currencies: total.unknown.join(', ') }));
      }
      for (const candidate of bonuses) {
        summary.push(t('bonusLine', { amount: formatWallet(candidate) }));
      }
      if (hasSession) {
        summary.push(t('sessionLine', {
          cost: formatMoney(session.cost, session.currency),
          tokens: formatTokens(session.tokens, t),
        }));
        summary.push(t('subagentNote'));
      }
      summary.push(t('note'));
      // One native tooltip line: browsers do not all preserve line breaks.
      const label = summary.join(' \u00b7 ');
      if (props.wide === false) {
        return h(
          'div',
          { className: 'dsh-token-cost-foot-rail', title: label, 'aria-label': label },
          h(CoinGlyph, null),
        );
      }
      const parts = [h(CoinGlyph, { key: 'coin' })];
      if (balanceText !== null) {
        parts.push(h('span', { key: 'balance', className: 'dsh-token-cost-foot-balance' }, balanceText));
      }
      if (hasSession) {
        parts.push(h('span', { key: 'session', className: 'dsh-token-cost-foot-session' },
          h('span', { className: 'dsh-token-cost-foot-session-label' }, t('session')),
          h('span', { className: 'dsh-token-cost-foot-session-value' },
            t('approx', { cost: formatMoney(session.cost, session.currency) }))));
      }
      return h('div', { className: 'dsh-token-cost-foot', title: label }, ...parts);
    }

    /**
     * Attempts of one Session, read from its projection face.
     * @param {any} ctx - client plugin context.
     * @param {string | undefined} sessionId - Session the main view shows.
     * @returns the attempts, or undefined while no Session or projection is available.
     */
    function useSessionAttempts(ctx, sessionId) {
      const [attempts, setAttempts] = React.useState(undefined);
      React.useEffect(() => {
        setAttempts(undefined);
        if (sessionId === undefined) return undefined;
        const sessions = ctx.get('sessions');
        const binding = sessions !== undefined && typeof sessions.binding === 'function' ? sessions.binding(sessionId) : undefined;
        const session = binding === null || binding === undefined ? undefined : binding.session;
        const projections = session === null || session === undefined ? undefined : session.projections;
        const face = projections === null || projections === undefined ? undefined : projections.faceOf(PROJECTION_KEY);
        if (face === null || face === undefined) return undefined;
        const read = () => { setAttempts(face.getSnapshot()); };
        read();
        return face.subscribe(read);
      }, [ctx, sessionId]);
      return attempts;
    }

    /**
     * Publish one balance detail to the store.
     * @param {any} store - balance store.
     * @param {any} detail - `{ status, value, bonusWallets }`, or null.
     * @returns whether the detail carried wallets.
     */
    function publishBalance(store, detail) {
      if (detail === null || detail === undefined || detail.status !== 'ready') return false;
      store.set({
        status: 'ready',
        wallets: Array.isArray(detail.value) ? detail.value : [],
        bonusWallets: Array.isArray(detail.bonusWallets) ? detail.bonusWallets : [],
      });
      return true;
    }

    /**
     * The balance detail the account UI already reads for its own surfaces.
     * @param {any} ctx - client plugin context.
     * @returns the cached detail, or undefined.
     */
    function cachedBalance(ctx) {
      const accountUi = ctx.get('accountUi');
      if (accountUi === undefined || accountUi === null || typeof accountUi.getSnapshot !== 'function') return undefined;
      const snapshot = accountUi.getSnapshot();
      const details = snapshot === null || snapshot === undefined ? undefined : snapshot.details;
      return details === null || details === undefined ? undefined : details.balance;
    }

    /**
     * Read the account wallet, then publish it to the shared store. A fresh Host
     * read wins; the account UI's already-read detail is the fallback, so the
     * panel still shows a wallet when this plugin cannot reach the account
     * namespace itself.
     * @param {any} ctx - client plugin context.
     * @param {any} store - balance store.
     * @param {any} account - the `remote.account` namespace, when available.
     * @returns completion of the read.
     */
    async function readBalance(ctx, store, account) {
      if (account !== undefined && account !== null && typeof account.getBalance === 'function') {
        const locale = ctx.get('locale');
        const language = locale !== undefined && typeof locale.getSnapshot === 'function'
          ? locale.getSnapshot().active
          : 'en';
        const accountUi = ctx.get('accountUi');
        const metadata = accountUi !== undefined && typeof accountUi.clientMetadata === 'function'
          ? accountUi.clientMetadata(language)
          : {
            version: (typeof process !== 'undefined' && process.env ? process.env.DSH_CLIENT_VERSION : undefined) ?? '0.0.0',
            locale: language,
            timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
          };
        try {
          const result = await account.getBalance(metadata);
          const detail = result !== null && result !== undefined && result.ok === true ? result.value : undefined;
          if (publishBalance(store, detail)) return;
        } catch (_error) {
          // A failed read falls through to the detail the account UI holds.
        }
      }
      if (publishBalance(store, cachedBalance(ctx))) return;
      if (store.getSnapshot().status !== 'ready') {
        store.set({ status: account === undefined ? 'unavailable' : 'failed', wallets: [], bonusWallets: [] });
      }
    }

    const dictionaries = {
      en: {
        label: 'Cost',
        approx: '\u2248 {cost}',
        title: 'Turn cost',
        model: 'Model',
        period: 'Rate',
        peak: 'peak (per request)',
        offPeak: 'off-peak (per request)',
        mixedPeriod: 'peak and off-peak (per request)',
        unknown: 'not reported',
        'bucket.input': 'Input, no cache hit',
        'bucket.cacheRead': 'Input, cache hit',
        'bucket.cacheWrite': 'Input, cache write',
        'bucket.output': 'Output',
        line: '{tokens} \u00d7 {rate} per 1M = {amount}',
        unmapped: 'No published rate for {models}; priced as {pricedAs}.',
        note: 'Estimate from provider-reported usage and published DeepSeek prices.',
        balance: 'Balance',
        session: 'Session spend',
        balanceLine: 'Balance: {amount}',
        walletLine: 'Wallet: {amount}',
        bonusLine: 'Bonus: {amount}',
        fxLine: 'Converted: {pairs}',
        unknownCurrency: 'Not converted: {currencies}',
        sessionLine: 'Session spend: {cost} for {tokens} tokens',
        subagentNote: 'Subagent sessions are counted separately.',
        unitThousand: 'k',
        unitMillion: 'M',
      },
      ru: {
        label: 'Стоимость',
        approx: '\u2248 {cost}',
        title: 'Стоимость ответа',
        model: 'Модель',
        period: 'Тариф',
        peak: 'пиковый (по каждому запросу)',
        offPeak: 'непиковый (по каждому запросу)',
        mixedPeriod: 'пиковый и непиковый (по каждому запросу)',
        unknown: 'не указана',
        'bucket.input': 'Ввод без кэша',
        'bucket.cacheRead': 'Ввод из кэша',
        'bucket.cacheWrite': 'Ввод, запись в кэш',
        'bucket.output': 'Вывод',
        line: '{tokens} \u00d7 {rate} за 1 млн = {amount}',
        unmapped: 'Для {models} нет опубликованного тарифа, взят тариф {pricedAs}.',
        note: 'Оценка по данным провайдера и опубликованным тарифам DeepSeek.',
        balance: 'Баланс',
        session: 'Расход сессии',
        balanceLine: 'Баланс: {amount}',
        walletLine: 'Кошелёк: {amount}',
        bonusLine: 'Бонусы: {amount}',
        fxLine: 'Пересчёт по курсу {pairs}',
        unknownCurrency: 'Без пересчёта: {currencies}',
        sessionLine: 'Расход сессии: {cost} за {tokens} токенов',
        subagentNote: 'Сессии субагентов считаются отдельно.',
        unitThousand: ' тыс.',
        unitMillion: ' млн',
      },
      zh: {
        label: '费用',
        approx: '\u2248 {cost}',
        title: '本轮费用',
        model: '模型',
        period: '费率',
        peak: '高峰时段（按每次请求）',
        offPeak: '空闲时段（按每次请求）',
        mixedPeriod: '高峰与空闲时段（按每次请求）',
        unknown: '未提供',
        'bucket.input': '输入，缓存未命中',
        'bucket.cacheRead': '输入，缓存命中',
        'bucket.cacheWrite': '输入，缓存写入',
        'bucket.output': '输出',
        line: '{tokens} \u00d7 {rate} / 百万 = {amount}',
        unmapped: '{models} 没有公开价格，按 {pricedAs} 计价。',
        note: '按供应商返回的用量与 DeepSeek 公开价格估算。',
        balance: '余额',
        session: '本次消费',
        balanceLine: '余额：{amount}',
        walletLine: '钱包：{amount}',
        bonusLine: '赠送：{amount}',
        fxLine: '换算：{pairs}',
        unknownCurrency: '未换算：{currencies}',
        sessionLine: '本次消费：{cost}，共 {tokens} 个 token',
        subagentNote: '子代理会话单独计算。',
        unitThousand: 'k',
        unitMillion: 'M',
      },
    };

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const stores = { balance: createStore({ status: 'idle', wallets: [], bonusWallets: [] }) };
        // The account namespace is a separate injectable service; a plugin that
        // merely reads ctx.remote.account does not necessarily reach it.
        let account;
        // One wallet read at a time: a refresh requested while a read is in
        // flight is served by that read, which is at least as fresh.
        let reading = false;
        const refreshBalance = () => {
          if (reading) return;
          reading = true;
          void Promise.resolve(readBalance(ctx, stores.balance, account))
            .catch(() => {})
            .finally(() => { reading = false; });
        };
        ctx.effect(() => ctx.locale.register(NS, dictionaries), 'token-cost: dictionaries');
        // One page-level stylesheet for every surface, removed with this Client run.
        ctx.effect(() => {
          const element = document.createElement('style');
          element.textContent = CSS;
          document.head.appendChild(element);
          return () => { element.remove(); };
        }, 'token-cost: stylesheet');
        // Waiting for the namespace keeps the plugin active without an account,
        // and picks the namespace up if the account plugin mounts later.
        ctx.inject(['remote', 'remote.account'], (scope) => {
          account = scope.remote.account;
          if (stores.balance.getSnapshot().status !== 'ready') refreshBalance();
          return () => { account = undefined; };
        });
        ctx.effect(() => {
          // The first read, every account change and reconnect, and every return
          // to the page (a top-up happens in the platform page, which keeps this
          // window). A Session's own billing refresh comes from the panel.
          refreshBalance();
          const offAccount = ctx.on('account-ui/change', refreshBalance);
          const offReset = ctx.on('connection/reset', refreshBalance);
          const listenersAvailable = typeof window !== 'undefined' && typeof window.addEventListener === 'function'
            && typeof document !== 'undefined' && typeof document.addEventListener === 'function';
          if (!listenersAvailable) {
            return () => { offAccount(); offReset(); };
          }
          const visible = () => { if (document.visibilityState === 'visible') refreshBalance(); };
          window.addEventListener('focus', refreshBalance);
          document.addEventListener('visibilitychange', visible);
          return () => {
            offAccount();
            offReset();
            window.removeEventListener('focus', refreshBalance);
            document.removeEventListener('visibilitychange', visible);
          };
        }, 'token-cost: account wallet');
        ctx.effect(() => {
          // The account plugin reads its own details asynchronously, so the very
          // first wallet read can land before them. Two bounded retries close
          // that gap without polling: once the store is ready they do nothing.
          if (typeof setTimeout !== 'function') return undefined;
          const timers = [1500, 6000].map(delay => setTimeout(() => {
            if (stores.balance.getSnapshot().status !== 'ready') refreshBalance();
          }, delay));
          return () => { for (const timer of timers) clearTimeout(timer); };
        }, 'token-cost: wallet bootstrap retries');
        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: 'turn-cost',
          order: 10,
          locale: NS,
          inject: () => ({ stores }),
        }, TurnCost));
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'token-cost',
          order: 40,
          locale: NS,
          inject: () => ({ ctx, stores, refreshBalance }),
        }, BalancePanel));
      },
    };
  },
});
