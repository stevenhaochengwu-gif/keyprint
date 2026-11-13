# Keyprint

Keyprint is a browser typing trainer that lives in one file, `index.html`, with no build step, no dependencies and no tests. It has four kinds of test. Step up (the default, where each day starts short and every perfect test adds a word), Words, Adaptive (letters unlock one at a time as you learn them) and My text (your own pasted text, text files or PDFs). It also has an on-screen keyboard with finger colors and hand outlines, daily goals, a Progress page of canvas charts, and an Analysis page that works out where your mistakes come from (keys, confusions, key switches, Shift, fingers, pace, place in the word) and builds a Practice these test from them. Progress saves in the browser, or in Claude artifact storage when it runs as an artifact, and optionally to a Cloudflare Worker that the user runs.

## Files

- `index.html` is the entire app, about 8,500 lines of HTML, CSS and JS. Keep it one self-contained file. The owner also runs it as an artifact in the Claude chat app (that is where `window.storage` comes from), so don't split it into modules or add local files, packages or a build step.
- `README.md` is a one-line stub.
- `wrangler.jsonc` and `.assetsignore` deploy the site to Cloudflare (see Deploying).
- `save-worker.js` is the Cloudflare Worker behind Cloud save (an ES module, `export default { fetch }`). It stores everything in a Workers KV namespace bound as `DATA` and only answers requests with `Authorization: Bearer <SAVE_KEY>`. The owner deploys it by hand in the Cloudflare dashboard, so editing this file changes nothing live. Say so whenever a change needs a redeploy, and keep the app working with the Worker that is already deployed.

## Deploying

The site is a Cloudflare Worker that serves `index.html` as a static asset. `wrangler.jsonc` names that Worker (`typing`, which must match the dashboard exactly), keeps its workers.dev address and declares the `type.stevenwu.org` custom domain. Once the owner connects the Worker to this repo under Settings, Build, every push to the production branch (`main`) runs `npx wrangler deploy`, and other branches can get preview versions.

The assets directory is the repo root, so `.assetsignore` must keep everything except `index.html` off the site, above all `.git`, which can hold a GitHub token on the build machine. When you add a file to the repo, check whether it would be published (`git -c core.excludesFile=.assetsignore check-ignore --no-index -v <path>` shows the matching rule) and extend `.assetsignore` if it shouldn't be. `save-worker.js` is deployed separately by hand and isn't part of this.

## Running and checking changes

Open `index.html` in a browser, or serve the folder with `python3 -m http.server 8000` and visit http://localhost:8000/. The only network requests are Google Fonts, pdf.js 3.11.174 from cdnjs (loaded only when a PDF is added) and the user's Cloud save address.

In this cloud environment Chromium and Playwright are preinstalled, `require('playwright')` works, and `chromium.launch()` needs no options. A `file://` URL is fine and gets working localStorage. Google Fonts fail here with `ERR_TUNNEL_CONNECTION_FAILED`, which is expected. Listen for `pageerror`, because one syntax error anywhere stops the whole app. Top-level `const` and `let` names (`state`, `lesson`, `APP`, `Store`) can be read from `page.evaluate`. After load, keystrokes go to the hidden `#sink` input, which already has focus. Each `browser.newPage()` starts with empty storage. To test an old or odd save, seed `keyprint-state-v1` with `page.addInitScript` before `goto`. Keep test scripts and screenshots outside the repo.

To test Cloud save end to end, run the real Worker locally. Copy `save-worker.js` to a temporary `.mjs` file with the test app's origin added to `SITES`, import it in Node 22, and serve it with `http.createServer` by turning each request into a `Request` and calling `worker.fetch(request, { DATA, SAVE_KEY })`. A `Map` behind async `get`, `put`, `delete` and `list({ prefix, cursor })` (returning `{ keys: [{ name }], list_complete, cursor }`) stands in for KV. Serve `index.html` over http from that origin, not `file://`, or CORS blocks everything. Use one browser context per simulated device, and set `timezoneId` on a context to test time zone behavior. The stand-in KV is instantly consistent and has no rate limit, so wrap it when a test needs real KV behavior.

```js
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto('file:///home/user/keyprint/index.html');
  await page.waitForFunction(() => document.querySelector('#text .c'));
  const text = await page.evaluate(() => lesson.text);
  await page.keyboard.type(text.slice(0, 10));
  console.log(await page.evaluate(() => lesson.pos)); // 10
  await page.screenshot({ path: '/tmp/keyprint.png' });
  await browser.close();
})();
```

## Architecture of index.html

The line numbers below are approximate and drift with every edit, so find sections by their markers instead. `grep -n '^/\* ' index.html` lists the CSS headers (`/* Top bar ----- */`) and every script section and subsection, along with some ordinary comments. HTML views start at `<!-- Practice ====`, `<!-- Progress, with the calendar on top ====`, `<!-- Analysis, every mistake and where it comes from ====` and `<!-- Settings ====`.

| Approx lines | Marker | What lives there |
|---|---|---|
| 1 to 14 | `<head>` | Meta tags, three logo icon data URIs (lines 7 to 9), Google Fonts |
| 15 to 1307 | `<style>` | Light `:root`, dark palette twice, components, Analysis bars and tiles, `data-zoom` modes, cheer, small screens, reduced motion |
| 1309 to 1928 | `<body>` | Top bar and tabs, `#view-practice`, `#view-progress` and `#view-analysis` (card skeletons and empty containers the script fills), `#view-settings` (full markup), `#toast`, `#chartTip`, `#zenHint`, `#announce` |
| 1929 to 2089 | first `<script>`, not strict | `WORD_TIERS`, `COMMON_WORDS`, `BLOCKED`, `LITERARY_WORDS` |
| 2105 | `/* 1. Configuration` | `APP` (tuning, storage keys, `version`) and `DEFAULTS` (settings schema) |
| 2165 | `/* 2. Keyboard data` | `LAYOUTS`, `FINGER_PATTERNS`, `CODE_ROWS`/`CODE_POS`, `SHIFTED`/`UNSHIFT`, `IS_MAC`, `KEY_NAMES`, `BOTTOM_ROW` |
| 2243 | `/* 3. Helpers` | `$`, `$$`, `clamp`, `mean`, `round`, `node(tag, cls, text)`, speed, percent and duration formatters |
| 2281 | `/* 4. State and storage` | `state`, `profile()`, `Store`, save pipeline, `Cloud`, `pushCloud`, `mergeSaves`, `hydrate` |
| 2712 | `/* 5. Text generation` | Letter `MODEL`, `adaptiveText`, `POOLS`, `wordsText`, `drillText` (Practice these), My text docs (`cleanDocument`, `splitPassages`, `addDoc`, `openDoc`, `deleteDoc`), `MARKS`, `decorate` |
| 3093 | `/* 6. Letter statistics` | `keySpeed`, `skill`, `focusKey`, `canUnlock`, `weakLetters`, `applyKeyStats`, `testDetail` |
| 3201 | `/* 7. Test engine` | `lesson`, goals and time tracking, keystroke capture (`keyDetail`, `unfinished`, `joinDetail`, `noteMiss`), `newLesson`, `startLesson`, `typeChar`, `failAttempt`, `backspace`, `finishLesson` |
| 3548 | `/* 8. Practice screen` | `el` registry for the whole app, header renderers, Goal celebration, Zoom, text renderer, My text library and pdf.js |
| 4699 | `/* 9. Keyboard` | `buildKeyboard`, `refreshKeyboard`, `drawHands`, `markNextKey`, cue, `celebrateUnlock` |
| 4980 | `/* 10. Progress screen` | `prog`, `TYPISTS`, `palette()`, `sizeCanvas`, eight canvases drawn by seven functions, Calendar subsection, Analysis subsection (`ANALYSIS_MIN`, `analyze`, `renderAnalysis` and one `renderAna*` per card, `drillPlan`, `startDrill`) |
| 6160 | `/* 11. Settings` | `EFFECTS`, `applyTheme`, `setSetting`, `bindSettings`, `syncSettingsUI`, backup and restore, Cloud save subsection, reset |
| 6632 | `/* 12. Events` | `showView`, `onKeyDown`, `onSinkInput`, `bindEvents` |
| 6824 | `/* 13. Start` | `init()`, called on the last script line |

The script does all the rendering. Keystrokes go from `onKeyDown` or `onSinkInput` into section 7, to `typeChar`, `backspace`, `restartLesson` (Esc) and `skipAhead` (Tab). Those call the painters in sections 8 and 9. Each settings control is bound by `data-setting="<key>"` through `bindSettings`. It then goes through `setSetting`, which runs the refreshers listed in `EFFECTS` and saves.

The script changes the look mostly through root attributes (`data-theme`, `data-font`, `data-zoom`) and classes, plus a few inline styles for timing and position (`--fade` on the board, `--leave` on the cheer, caret and text transforms). In the other direction, canvases and confetti read colors from CSS variables through `palette()` and `burst()`.

## State, storage and versioning

- **The `state` object.** It holds `version, settings, profiles, daily, clean, goalMetOn, cheered, docs, docId, removed, step, restoredAt, devices, savedAt`. `step` is `{day, words}`, how far Step up has grown on that local day, and `mergeSaves` keeps the larger on the same day or the later day's. Each `profiles[layout]` is `{unlocked, keys, history, customPos, resetAt}`, so letter stats, unlocks and history are kept per layout. `daily` and `clean` (ms per local `YYYY-MM-DD`) are shared by all layouts.
- **Saved shapes are fixed.**
  - Letter stats are `{t, n, e, m, x}`.
  - History entries are `{ts, wpm, acc, dur, words, mode, tries, nk, k, tx, mx, tm}`, with `k[ch] = [avgMs, timed, typed, missed]`. Older entries have no `k` or `nk` and must keep working.
  - `tx`, `mx` and `tm` are every keystroke of the test, for the Analysis tab, made by `keyDetail` and `joinDetail` in `finishLesson`. `tx` is the test text. `mx` is `[[i, typed, ms], ...]`, the first wrong key at each position `i` of `tx` that went wrong, with the ms since the key before (left out when there is none, at a test's first key or right after Backspace). Wrong keys typed after it while the mistake still shows (the trail, and every blocked key with Backspace to delete) are not noted again, so `mx` lines up with `errAt`. `tm` is two base 36 digits per character of `tx` (so `tm.length === 2 * tx.length`), the time before the key that typed it right on the first try in 10 ms steps, capped at `APP.idleGap`, or `zz` when there is none (first key, after Backspace, or a missed position).
  - Attempts that end early (a failed try in One mistake restarts, Esc, Tab, a settings change) have no entry of their own. `keepPartial` holds their keys in `unfinished` (not saved, at most `APP.unfinishedChars` characters, dropped on a layout change or Reset progress), and the next finished test on the same layout puts them first in its `tx`, each part ending in a `\n` with `zz` in `tm`. Lesson text never contains `\n`, and the analysis never counts a switch across one. So `tx` can be longer than the text the entry's `wpm` and `acc` describe.
  - Only the newest `APP.detailTests` tests per layout, holding at most `APP.detailChars` characters of `tx`, keep these three fields. `trimDetail` strips the rest, and both `finishLesson` and `hydrate` run it, so merges can't grow it back. Old entries without them, or with ones that don't add up, are skipped by `detailedTests` and work everywhere else as before.
  - Docs are `{id, title, words, passages, at, added, finished}`. Doc text is never stored in the main blob.
- **`Store`.** It uses Claude's `window.storage` if present, then localStorage, then nothing. It writes three kinds of key (plus a `keyprint-probe` it sets and removes to test localStorage).
  - `keyprint-state-v1`, the whole state.
  - `keyprint-doc:<id>`, one per text.
  - `keyprint-cloud`, the Worker address and key, plus this browser's `device` id (8 to 24 lowercase letters and digits).

  Never rename these keys, or every existing save is orphaned.
- **Saving.**
  - `scheduleSave` debounces (400 ms by default, 500 from `setSetting`), then calls `saveLocal`.
  - `saveLocal` stamps `savedAt`, writes, marks the cloud copy dirty and calls `scheduleCloud`, which pushes at most every 20 s.
  - `flushSaves` runs on `pagehide` and when the page is hidden. It saves locally, then `sendLeaving` sends a slim copy with `keepalive` to this browser's own slot, `keyprint-pending-<device>`, once per batch of changes. The copy carries `leftAt` (this browser's clock) and only this browser's own `left` mark, since its other marks may cover copies whose tests it isn't carrying. The copy holds only tests since this browser's last cloud save (at most `APP.pendingTests` per layout) and the last 3 days of totals, since merging only ever adds. Only the newest of those tests keep `tx`, `mx` and `tm`, up to `APP.leftDetail` characters of them, and the rest reach the cloud with the next regular save. It never writes the main cloud copy, because a hidden page may never run again (phones often stop one right away) and a closing page can't wait to read first.
  - `pushCloud` runs one `sendCloud` at a time and queues at most one more for everyone who asks meanwhile. Keep it that way, or two saves read the same copy and both write it.
  - `sendCloud` first waits until 1.1 s after its last successful PUT (timed with `performance.now()`, as KV takes one write a second per name). Then `readCloud` reads the main copy and the slot of every browser listed in `state.devices` and in the main copy, `foldLeft` merges each slot whose `leftAt` is newer than that browser's `left` mark and raises the mark, and the main copy is written. Slots are never deleted. The marks make sure each left copy is merged once. It gives up quietly if Cloud save was disconnected or changed mid-save. Never write the main copy without that read and merge, or a stale tab replaces newer progress from another device.
  - Every `Cloud.call` except a keepalive one gives up if no answer starts within `APP.cloudTimeout` plus 1 s per 10,000 characters uploaded. Once the answer starts, the body can take as long as it needs. This keeps one stuck request from holding up the queue without cutting off big uploads on slow links.
  - `state.devices` is `[{id, seen, left}]`, unioned by `mergeDevices` (max of each) and capped by `hydrate` at `APP.cloudDevices`, most recently seen first. Every save marks this browser as seen. Other browsers only read slots of listed browsers, so `init` saves right away when the cloud copy doesn't list this browser yet.
  - Tabs of one browser share its slot, so each tab folds in the other tabs' local saves through the `storage` event. Keep that listener, or a stale tab's local save or left copy drops another tab's tests.
  - Known limit. KV's delay between locations can drop a browser from the main copy's list (last write wins), and then its newest left copy waits until that browser opens again.
  - `ready` stays false until `init` has hydrated, so nothing can write DEFAULTS over a real save. Keep it that way.
- **`hydrate` is the one gate for every load.** That covers init, cloud connect, the merge inside `pushCloud`, backup restore and daily cloud copy restore. It rebuilds state field by field and resets any setting whose `typeof` differs from DEFAULTS. It checks enums against include lists or lookup tables and clamps numbers. It caps history at `APP.historyLimit` (and its keystroke detail through `trimDetail`), `daily` and `clean` at 400 days and `removed` at 200. It never updates `state.version`.
- **Migrations.** To change the schema, bump `APP.version` (currently 8) and add an `if (from < N)` block in `hydrate`. Version 8 moves saves that were on Words to Step up.
  - `from` is `Number(saved.version) || 1`. An object without `version` therefore runs every migration and has its unit, capitals, punctuation, word pool, theme and finger colors forced.
  - Always pass `hydrate` a parsed or `snapshot()` copy that still has `version`. Never pass live state, because `hydrate` clears each state field before reading the same field from its argument, which would wipe profiles, daily, clean and docs. It also keeps the argument's `keys` objects by reference (`cleanKeys` mutates and returns them).
- **New top-level fields.** A new state field goes in the initial `state` and in `hydrate`. If you miss `hydrate`, the saved value is silently dropped on every reload. `mergeSaves` starts from a copy of the newer save, so it only needs code if both copies' values should be combined.
- **Cloud save** (`Cloud`, `pushCloud`, the Cloud save subsection).
  - It sends bearer-key fetches to the user's Worker. Object names are the state and doc Store keys URL-encoded, plus one `keyprint-pending-<device>` slot per browser (`APP.cloudPending` is the prefix), `backups` and `backup-YYYY-MM-DD`. `keyprint-cloud` never leaves the browser.
  - Status 401 becomes `key`, 500 becomes `setup` and any other failure `reach`. A GET that returns 404 is null.
- **The Worker side** (`save-worker.js`).
  - `SITES` lists the only origins allowed by CORS (`https://type.stevenwu.org` and the `typing.stevenhaochengwu.workers.dev` address). From any other origin, including a Claude artifact, a `file://` page or localhost, the browser blocks every response and the app reports `reach`.
  - Routes are `OPTIONS` (no key needed), `GET backups` (the daily copy days, newest first), then GET, PUT and DELETE on a name matching `/^[A-Za-z0-9._:-]{1,120}$/`. Doc names decode to `keyprint-doc:<id>`, which fits.
  - A PUT of `keyprint-state-v1` also writes `backup-<day>` if that day has no copy yet. The day is the UTC date, so outside UTC the "day" starts at a local time other than midnight (evening in the US). Daily copies are never deleted.
  - DELETE refuses the main state and daily copies (403). Bodies over 20,000,000 characters get 413. Missing `DATA` or `SAVE_KEY` gives 500, which the app shows as the setup message.
  - Workers KV is eventually consistent. A write can take 60 seconds or more to show up at other Cloudflare locations, same-key writes are limited to one per second (faster ones throw a 429 inside `put`), and the last write wins. Two devices are not guaranteed to see each other's latest save, which is why `mergeSaves` exists and why it must never drop data from either side.
  - A save merges the main copy only if its `savedAt` is newer than `Cloud.seen`. `init` merges the main copy and the left copies at start.
  - `keepalive` only applies to bodies under 60,000 characters, which is why the left copy is slim. Merging only ever adds tests, so leaving older ones out of it loses nothing.
- **`mergeSaves`.**
  - History is unioned by `ts|wpm`, keeping only entries at or after the later `resetAt`. When both copies have a test, the one with `tx` wins, so a slim left copy never strips a test's keystrokes.
  - When both copies share a `resetAt`, each letter keeps the copy with the larger `n`, and `unlocked` takes the max. Otherwise the copy with the later reset wins both.
  - `daily` and `clean` take the max per day, not the sum.
  - `keepMine` keeps the local settings and `docId`.
  - A restore (backup file or daily copy) goes through `restoreFrom(copy)`. It merges the copy into what's here, with the copy's settings and open text taking over, and stamps `state.restoredAt` (and `savedAt`) with now. When two copies have different `restoredAt`, `mergeSaves` first runs `undoResets` on the copy restored less recently, which makes its resets from before the newer restore stop counting. Nothing else is trimmed, so a restore only ever brings things back. That's how it undoes a Reset progress another browser had already synced, without wiping a browser that connects later or work done after the restore. `restoredAt` is capped at a few minutes past now, in case a clock runs fast.
- **Backups** are `{app: "keyprint", version, savedAt, state, texts}`. Restore keeps the texts already here, adds the backup's, and drops a backup text whose words are missing from `texts`. A removed text stays removed, since `removed` is unioned everywhere.
- **Docs.** Doc ids must match `/^[a-z0-9]{4,40}$/`, or `hydrate` silently drops the document. Changing `APP.mergeWords`, `splitWords` or `pieceWords` moves saved `doc.at` positions onto different passages.

## Conventions

- **Code.**
  - Two-space indent, double quotes, semicolons, trailing commas in multi-line literals, `const` and `let`, template literals and arrow callbacks.
  - Use function declarations for real logic and one-line arrow consts for tiny helpers.
  - Names are UPPER_SNAKE for tables, PascalCase for singletons (`Store`, `Cloud`) and camelCase otherwise.
  - Short local names are normal, such as `s` for settings, `p` profile, `L` lesson, `k` letter stats, `ch` char and `P` palette.
- **DOM.**
  - Build elements with `node(tag, cls, text)` and `replaceChildren`, and hide them with the `hidden` property.
  - Show state through classList toggles that CSS reads.
  - Delegate clicks with `closest("button[data-...]")` and go through `el` for element refs.
  - To restart an animation, remove the class, run `void el.offsetWidth`, then add the class back.
  - Destructive buttons take two clicks, with a changed label and a 4000 ms disarm. Reset progress and Restore this copy add an `armed` class, and a text's Remove button sets `data-armed`.
- **CSS.**
  - Colors come from custom properties (the red to green skill ramp in computed `hsl()` is the exception), and themes only redefine variables. Short rules go on one line.
  - Numbers use `tabular-nums`. Figures put `<dt>` before `<dd>` and flip them with `column-reverse`.
  - Classes are short and hyphenated, and state classes are single words. Ids are camelCase, apart from `view-*`, settings inputs `set-*` (except `sdSettings`) and readouts `out-<settingKey>`.
  - Every `<button>` has `type="button"`.
- **Comments.**
  - Write plain full sentences ending in periods, often in the second person, explaining intent above the code. Trailing inline comments are short lowercase fragments.
  - Empty `catch` blocks say why they are empty.
  - Section headers are `/* N. Name ---- */`, padded with dashes to about column 80, and subsections have no number.
  - In APP comments the unit comes first (`// ms between saves`).
- **UI copy.**
  - Use sentence case, second person, short and friendly wording. Contractions are welcome.
  - Full sentences end with a period. Button labels, button states and short toasts don't ("Start over", "Backup downloaded").
  - Feature names are capitalized like proper nouns ("My text", "One mistake restarts", "Text only").
  - Numbers go through `toLocaleString("en-US")` ("1,000"). Negatives use the Unicode minus, gains get an explicit +, and speed units come from `unitLabel()`.
  - Join a label and its value with a comma ("Speed now, 80% of target").
- **Punctuation.** No colons, no double dashes and no em or en dashes in UI copy or comments. The only runs of dashes are the section header rules. Use periods, commas or parentheses instead. The owner dislikes colons and double dashes in prose generally, so follow the same rule in docs and commit messages.
- **Internal ids differ from UI names.**
  - `step` is Step up (`stepWords()` gives today's length from `stepStart` and `stepTop`, and `finishLesson` grows it before making the next test), `custom` is My text, `suddenDeath` is One mistake restarts, `emulate` is Follow key positions, and `weakBoost` is Extra practice for weak letters.
  - `mistakes` values `clear`, `delete` and `move` are Right key clears, Backspace to delete and Move on.
  - Speeds are always stored in wpm, and a letter's speed is `12000 / ms`. cpm is for display only (x5).

## Gotchas and invariants

- **Adding a setting** takes four things.
  - A DEFAULTS entry of the right JS type, because controls are cast by `typeof DEFAULTS[key]`.
  - For enums, a check in `hydrate`'s include lists or lookup tables.
  - Markup with `data-setting`. Seg buttons also need a `data-value` exactly equal to `String(value)`.
  - An `EFFECTS` entry, or changing the setting only saves it. The order of the effect checks in `setSetting` matters.
- **Adding a word pool** needs a `POOLS` entry and an `<option>` in `#set-pool`.
- **Adding a punctuation mark or symbol** needs a `MARKS` entry (ids are single characters, and `group: "symbols"` puts it under Symbols in Settings) and handling in `decorate`. Keep `decorate`'s step order, which is apostrophes, then pairs, then symbol joins, stand-in tokens and prefixes, then wraps, then end marks, with capitals last. Numbers use the id `1`. All of them only apply while the Punctuation and symbols switch is on.
- **Word tiers.** `POOLS` slices `COMMON_WORDS` at 200 and 500, so the `WORD_TIERS` sizes (100, 100, 300, 500) and their order matter. A duplicated word shifts every later boundary. Keep the word list `<script>` before the main one.
- **Load order.**
  - Many functions use names that are declared later, such as `el`, `view`, `ZOOMS`, `POOLS`, `MARK_IDS` and `shiftX`. This only works because they first run inside `init()`, so don't add top-level calls into code that touches later names. Put new startup work in `init()`.
  - Syntax a browser can't parse stops the whole app, not just one feature. `splitPassages` and `titleFrom` already use regex lookbehind, and the code avoids `?.` and `??`.
- **The `el` registry** looks up most ids once, at load, for all sections. A renamed id becomes null and crashes somewhere else later. `#focusCap` must keep its inner span.
- **`[hidden] { display: none !important; }` is load-bearing.** Many elements set their own display and are hidden only through `hidden`.
- **Themes.**
  - The dark palette is written twice (the `prefers-color-scheme` block and `:root[data-theme="dark"]`), and the two must stay identical. New variables also go in the light `:root`.
  - The System theme means there is no `data-theme` attribute.
  - The `<html data-theme="dark" data-font="ubuntu">` defaults must match DEFAULTS.
- **Zoom.** Any `data-zoom` value hides the keyboard deck, so Normal must remove the attribute.
  - `applyZoom` sets it only on the Practice view.
  - `setSetting` sets `zoomBack` before calling it.
  - In Text only, Esc leaves. On touch screens (`pointer: coarse`) the `#zenHint` button stays at the top as the way out, since there is no Esc. Elsewhere it is a fading hint that never takes clicks or focus (`tabindex="-1"`, `pointer-events: none`).
  - Entering Text only scrolls the cursor (or the Three lines window) into view, before the zoom animation starts, because the animation's scaling throws off measurements.
- **Text rendering.**
  - `charEls[i]` must line up with `lesson.text`. The caret and the trail span are not in it.
  - `paintChar` overwrites each char's whole className from `lesson.states` (0 waiting, 1 right, 2 right after a mistake, 3 wrong). Any new char class must be added inside `paintChar`.
  - The line-height 1.7 and `calc(1.7em * 3)` height drive `measureLines`. `.w` must stay inline-block with `white-space: pre`, and `.c` inline-block.
- **Layout reads return 0 while a view is hidden.** New layout-dependent code must rerun wherever `measureLines`, `drawHands`, `markNextKey` and `moveCaret` already do, which is showView, applyZoom, resize, `fonts.ready` and the lines and hands effects.
- **Keyboard geometry.**
  - Every row is 15 units (`--U` is `100cqw / 15`), and `BOTTOM_ROW` adds up to 15 on both Mac and PC.
  - `LAYOUTS` rows have 13, 13, 11 and 10 keys, and `FINGER_PATTERNS` and `CODE_ROWS` must match.
  - Fingers 0 to 3 are the left hand, 4 to 7 the right hand and 8 the thumbs.
  - `drawHands` uses fixed SVG ids, so only one hands SVG can exist.
- **`keepPartial`** must run before `lesson` is replaced. `startLesson` does this, and `L.counted` stops double counting. Text is generated before it runs, so generation sees the stats from before the partial test. It also hands the partial test's keystrokes to `unfinished`.
- **Keystroke capture.** `typeChar` works out `gap` before it touches `L.start` or `L.last`, notes a miss with `noteMiss` only when `errAt` goes from 0 to 1, and sets `L.gaps[i]` only for a first try that was right. Keep those three rules if you change how mistakes work, or the Analysis tab counts trail keys and Backspace retypes as new mistakes. None of it feeds speed, accuracy, letter stats or goals.
- **Stale settings refs.** A `const s = state.settings` captured before a `hydrate` goes stale.
- **`coolUntil`** is shared by `failAttempt` (whose `hold` is captured after `checkGoals`) and `playCheer` (which adds `APP.cheerHold`). `checkGoals` must stay between tests.
- **Celebrations come in three sizes, and they should stay different.**
  - A perfect test (no mistakes) gets `flourishPerfect`, a small `#flourish` tag above the text and a light along the letter row (`.sequence.shine`, ordered by each key's `--i`). It never holds keys. `perfectRun` counts perfect tests in a row and isn't saved. `checkGoals` returns the goals it celebrated, and a test that reaches a goal shows that instead.
  - The clean typing goal alone gets `flourishClean`, one line traced around the text (`.trace`, built once in the board) with the tag sitting on the line as a label. No overlay, no hold.
  - The daily typing goal, alone or with the clean one, gets `playCheer`, the slow release overlay. `renderCharge` (called from `renderGoal`) builds up to it from `APP.chargeFrom` of the goal by setting `.charging`, `--charge` and `--breath` on the Typing today goal and the board.
  - Sounds are `perfect`, `clean` and `release` in `sound()`, and play only with the Sound setting on.
- **Docs in progress.** `finishLesson` and `skipAhead` advance whatever `activeDoc()` is at that moment, because the lesson stores no doc id.
- **The Analysis tab.**
  - `renderAnalysis` runs `analyze` over the current layout's detailed tests only when the tab opens (`showView`) and after a merge (`afterMerge`), never per keystroke. It fills in once there are `ANALYSIS_MIN.tests` detailed tests, and each card has its own minimum in `ANALYSIS_MIN` before a key, switch or group shows. Rankings mix `ANALYSIS_MIN.prior` keys at the overall rate into each rate (`rankRates`), so a rarely typed key ranks a little lower than its raw rate and the bars aren't always in strict order.
  - Key places for reasons and switch kinds come from `keyPlace`, which uses `LAYOUTS`, the finger pattern and `ROW_START` (the key widths before each row, matching `buildKeyboard`). A new layout or finger pattern works without changes as long as those tables stay in step.
  - The cards are plain HTML. `.bars` is one grid and each `.bar-row` is `display: contents`, so the labels, bars and figures line up across rows. Bar lengths are the `--v` custom property (0 to 1).
  - Copy that restates script values. The Rushing notes ("Under half your usual gap" and so on) restate the 0.5, 0.8 and 1.25 cutoffs in `analyze`, and the slow switch cutoff is 1.15 times the usual gap in `renderAnaSlow`.
  - Below 480px wide the brand name is visually hidden so the four tabs fit. A fifth tab needs another look at that.
- **Practice these.** `startDrill` builds a plan with `drillPlan`, then calls `startLesson(text, 1, plan)`. The plan sits on `lesson.drill`, and a drill lesson's `mode` is `"words"`, so it never moves My text along (`skipAhead` checks `lesson.drill` too) or unlocks a letter. `restartLesson`, the restart effect in `setSetting` and `failAttempt` pass the plan on, so Esc and One mistake restarts stay in the drill. `renderFocus` shows the plan's keys while a drill is on, and the next test after it is a normal one.
- **Logo and rings.**
  - The cheer overlay clones `.brand .logo`. Its CSS expects four rings followed by the SVG, and four paths, with `pathLength="100"` on the three ridges and the fourth as the core line.
  - A logo change also means updating the three icon copies in `<head>`.
  - `RING` is `2*PI*15.5`, which must match the `r="15.5"` goal circles.
- **Charts.**
  - Each canvas's drawing size comes from its CSS height. Hidden canvases draw nothing.
  - `speedChart`, `overview` and `keyChart` share `LESSON_PAD`. They need equal widths and no border or padding.
  - `prog.geo` entries exist only after a draw, and `testDays` is rebuilt only in `renderProgress`.
  - `SMOOTH.length - 1` must equal the `max` of both `[data-smooth]` ranges.
  - Renaming a chart CSS variable silently turns that chart `#888`.
- **Copy that restates script values.** "three seconds" is `APP.idleGap` and "1 to 1,000" is `APP.maxWords`, so change copy and value together. The select and slider options cover fewer values than `hydrate` accepts.
- **Reduced motion** uses `0.001ms` rather than `none`, so end events still fire.
- **`.sink`** must stay focusable (opacity 0, not display none) and keep its 16px font size, or iOS zooms on focus.
- **Z-index stack.** Toast 30, cheer 20, chart tip 15, zen hint 5, cue 3. The board isolates its own stack (`isolation: isolate`), so its build up glow sits at -1 behind the text and `#flourish` at 1 above the traced line.

## Leftovers (safe to remove, easy to mistake for live code)

- CSS from an old Progress page, namely `.summary`, `.panel*`, `#chart`, `.chart-wrap`, `.tip`, `.keys-head`, `.key-list` and `.krow` through `.kerr`. Also `@keyframes blink`.
- Unused script hooks.
  - `shake()` is never called.
  - `.board.typing` has no CSS.
  - `.notch` is always hidden.
  - The `[data-toggle]` and TEXTAREA branches in `bindSettings` have no matching markup.
  - `customPos` is saved and copied by `hydrate` but never used.
- Stale comments.
  - "Both lists live in words.js". There is no such file, and the lists are inline.
  - The letter model comment says it uses only common words, but it uses both lists.
  - `defaultKey`'s comment says slowest letter, but it ranks by `skill()`.
