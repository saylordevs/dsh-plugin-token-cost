# Turn cost

Shows what each finished answer cost, in the DSH chat transcript.

A completed answer already reports its token usage. This plugin adds one line
under it with the money figure for that turn, for example `Cost ≈ $0.00516`.
Clicking the line expands the breakdown: input without a cache hit, cached
input, and output, each with its rate per million tokens and its amount, plus
the model and whether the peak or off-peak rate applied.

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

- **Tokens** are the provider-reported usage of that turn, taken from the same
  data the shipped token-usage row uses. Nothing is estimated, so a turn whose
  attempts reported no exact usage shows no cost line — the same rule the token
  row follows.
- **Rates** are the published DeepSeek prices per million tokens. Peak hours are
  Beijing time (UTC+8) 09:00–12:00 and 14:00–18:00 on weekdays; everything else,
  including whole weekends, is off-peak. Chinese public holidays are not
  modelled, so a weekday holiday is priced as peak.
- The rate is chosen at the moment the answer finished, so a turn that straddles
  the start or end of a peak window is priced wholly at its finishing rate. The
  amount is therefore an estimate, and the row marks it with `≈`.
- The currency is US dollars. Set `CURRENCY = 'CNY'` in `client.js` to read yuan.

## Changing prices

The rate table is at the top of `client.js`, in the installed package directory,
as `[off-peak, peak]` pairs per million tokens:

```js
const USD = {
  'deepseek-flash': { cacheRead: [0.003, 0.006], input: [0.15, 0.3], output: [0.6, 1.2] },
  'deepseek-v4-pro': { cacheRead: [0.022, 0.044], input: [0.66, 1.32], output: [1.98, 3.96] },
};
```

Edit the numbers, then reload the page. A model id without an entry is priced
like `deepseek-flash`, and the breakdown names the rates it used in that case.
Add an entry to `MODEL_ALIASES` and a rate row to price a model exactly. A cache
write is billed as ordinary prompt input.

## Notes

- The plugin sends nothing anywhere, uses no network, and adds no tool, prompt,
  message, or model-visible content.
- It reads Session data the browser already received; turning it off removes the
  row and changes no Session record.
- The row appears in every display mode, including **Performance & usage →
  Compact**, where the shipped per-turn token row is hidden.
- Costs are an estimate: prices and peak windows are configuration, not billed
  charges, and a turn served by more than one model is priced at its first
  route's rate.

## Development

`npm test` (or `node .smoke/smoke.js`) renders the row through a fake module
loader and asserts the registration, the closed and expanded markup, the
peak/off-peak amounts, the locale fallbacks, the guards, and stylesheet disposal.
No browser is needed.

## License

MIT. See [LICENSE](LICENSE).
