# Turn cost

Shows what DeepSeek usage costs, in two places:

- **In the Chat flow**, under every finished answer: a line such as
  `Cost ≈ $0.00516`. Click it to expand the per-bucket breakdown — input
  without a cache hit, cached input, cache write, output, each with its
  effective rate and amount — plus the model and whether the peak or off-peak
  rate applied.
- **At the sidebar foot**, above Settings: the account wallet and the spend of
  the open session, on one row of that footer. Collapsed, it becomes a coin
  glyph whose tooltip carries both readings. The tooltip also names every
  original wallet and bonus, states the exchange rate applied, and says that
  subagent sessions are counted separately. Amounts are two-decimal and grouped;
  a sub-cent reading shows `< $0.01` instead of rounding to zero.

## Install

Requires DeepSeek Harness 0.2.2 or newer; 0.3.0 and later are not claimed yet.

Through the plugin index, in **Plugins → Discover**: choose **Add index source**
and enter

```
https://saylordevs.github.io/dsh-plugin-token-cost/index.json
```

then **Install** on the Turn cost card. The index pins an exact commit, so what
you install is what was reviewed.

From a terminal, with the `dsh` CLI:

```sh
dsh plugin --profile <profile> add github:saylordevs/dsh-plugin-token-cost
```

The bundle is plain JavaScript: there is no build step, no install script, and
nothing to allow in `allowBuilds`. Pin a commit (`...#<sha>`) if you want the
install frozen to what you reviewed.

## Where the numbers come from

The Host half registers one client-visible session projection, `turnTokenCost`,
which folds every billed model attempt of a session: the provider-reported token
buckets, the exact provider/model route, and the event time. Both surfaces price
that one list, so:

- the session figure covers the **whole session**, not only the part on screen;
- each request is priced at the published rate of **its own model** and of
  **its own instant** (a turn served partly in peak hours is not rounded to one
  rate);
- a retried attempt is counted as its own billed request, and a newer sample in
  the same Step replaces the earlier one, matching the harness's own token
  accounting.

Without that projection the answer row falls back to the shipped Turn-usage
data, so the plugin still works if the projection is unavailable.

## Currency

Money is always shown in **US dollars**, whatever currency the account holds:
the published rate table, the answer row, and both panel figures use dollars, so
a yuan top-up cannot leave the panel reading `$0.00`. A wallet in another
currency is converted and the panel marks that figure with `≈`; the tooltip names
every original wallet and states the rate applied.

```js
const DISPLAY_CURRENCY = 'USD'
const RATES_TO_USD = { USD: 1, CNY: 6.7 }
```

Edit `RATES_TO_USD` when the rate moves (units of that currency per 1 USD).
Currencies without an entry are listed as not converted instead of being
silently dropped.

The panel re-reads the wallet whenever the open session spends more, when the
account changes, on reconnect, and when the window regains focus (returning from
a top-up page). The read goes through the account namespace the account UI itself
uses; when that namespace is not mounted for this plugin it falls back to the
balance the account UI already read, and two bounded retries after start close
the gap while those details are still loading.

## Changing prices

The rate tables are at the top of `client.js`, in the installed package
directory, as `[off-peak, peak]` pairs per million tokens:

```js
const USD = {
  'deepseek-flash': { cacheRead: [0.003, 0.006], input: [0.15, 0.3], output: [0.6, 1.2] },
  'deepseek-v4-pro': { cacheRead: [0.022, 0.044], input: [0.66, 1.32], output: [1.98, 3.96] },
};
```

Peak hours are Beijing time (UTC+8) 09:00–12:00 and 14:00–18:00 on weekdays;
everything else, including whole weekends, is off-peak. Chinese public holidays
are not modelled, so a weekday holiday is priced as peak. A model id without an
entry is priced like `deepseek-flash`, and the breakdown names the rates it used
in that case; add an entry to `MODEL_ALIASES` and a rate row to price a model
exactly. A cache write is billed as ordinary prompt input.

Edit the numbers, then reload the page.

## Notes

- The plugin sends nothing anywhere and makes no network requests of its own: it
  reads Session data the browser already received plus the wallet figure the
  account plugin already fetched. It adds no tool, prompt, message, or
  model-visible content.
- Turning it off removes both surfaces and changes no Session record.
- The session figure is a session's own spend. A subagent session is a separate
  session and is counted separately, not folded into the session that started it.
- Costs are estimates: prices and peak windows are configuration, not billed
  charges. The wallet is the authoritative balance.
- The projection unit validates its own state and wire payload structurally
  instead of importing a schema library, so the bundle installs without runtime
  dependencies.

## Development

`node .smoke/smoke.js` imports the Host projection and folds representative
Session events over it (replacement, retry, unrelated events, unsafe counts,
schema rejection), then renders both surfaces through a fake module loader,
React shim, account service, and Session projection face: the answer row from
the projection and from the shipped fallback, the expanded breakdown, the
sidebar panel in wide and rail modes, a live projection update, the wallet
currency switch, and stylesheet disposal. No browser is needed.
