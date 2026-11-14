# Keyprint

Keyprint is a browser typing trainer that lives in one file, `index.html`, with no build step, no dependencies and no tests. It has four kinds of test. Step up (the default, where each day starts short, every perfect test adds a word and three mistakes take one away), Words, Adaptive (letters unlock one at a time as you learn them) and My text (your own pasted text, text files or PDFs). Tests can also be in Chinese, everyday words typed with a pinyin input method, with the pinyin above each character. It also has an on-screen keyboard with finger colors and hand outlines, daily goals, a Progress page of canvas charts, and an Analysis page that works out where your mistakes come from (keys, confusions, key switches, Shift, fingers, pace, place in the word) and builds a Practice these test from them. Someone new gets a four step welcome over their first test, which Settings can show again. Progress saves in the browser, or in Claude artifact storage when it runs as an artifact, and optionally to a Cloudflare Worker that the user runs.

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

In this cloud environment Chromium and Playwright are preinstalled, `require('playwright')` works, and `chromium.launch()` needs no options. A `file://` URL is fine and gets working localStorage. Google Fonts fail here with `ERR_TUNNEL_CONNECTION_FAILED`, which is expected. Listen for `pageerror`, because one syntax error anywhere stops the whole app. Top-level `const` and `let` names (`state`, `lesson`, `APP`, `Store`) can be read from `page.evaluate`. After load, keystrokes go to the hidden `#sink` input, which already has focus. Each `browser.newPage()` starts with empty storage, so it is someone new, and the welcome opens over the first test and takes every key until it closes. A script that only wants to type sets `window.keyprintNoWelcome = true` with `page.addInitScript` before `goto`, and then the welcome only opens from Settings (or `openWelcome(false)`). To test an old or odd save, seed `keyprint-state-v1` with `page.addInitScript` before `goto`. Keep test scripts and screenshots outside the repo.

To test Cloud save end to end, run the real Worker locally. Copy `save-worker.js` to a temporary `.mjs` file with the test app's origin added to `SITES`, import it in Node 22, and serve it with `http.createServer` by turning each request into a `Request` and calling `worker.fetch(request, { DATA, SAVE_KEY })`. A `Map` behind async `get`, `put`, `delete` and `list({ prefix, cursor })` (returning `{ keys: [{ name }], list_complete, cursor }`) stands in for KV. Serve `index.html` over http from that origin, not `file://`, or CORS blocks everything. Use one browser context per simulated device, and set `timezoneId` on a context to test time zone behavior. The stand-in KV is instantly consistent and has no rate limit, so wrap it when a test needs real KV behavior.

```js
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.addInitScript(() => { window.keyprintNoWelcome = true; }); // skip the welcome
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
| 1309 to 1928 | `<body>` | Top bar and tabs, `#view-practice`, `#view-progress` and `#view-analysis` (card skeletons and empty containers the script fills), `#view-settings` (full markup), `#toast`, `#chartTip`, `#zenHint`, `#announce`, the `#welcome` dialog (its steps are built by the script) |
| 1929 to 2089 | first `<script>`, not strict | `WORD_TIERS`, `COMMON_WORDS`, `BLOCKED`, `LITERARY_WORDS`, `ZH_WORDS` |
| 2105 | `/* 1. Configuration` | `APP` (tuning, storage keys, `version`) and `DEFAULTS` (settings schema) |
| 2165 | `/* 2. Keyboard data` | `LAYOUTS`, `FINGER_PATTERNS`, `CODE_ROWS`/`CODE_POS`, `SHIFTED`/`UNSHIFT`, `IS_MAC`, `KEY_NAMES`, `BOTTOM_ROW` |
| 2243 | `/* 3. Helpers` | `$`, `$$`, `clamp`, `mean`, `round`, `node(tag, cls, text)`, speed, percent and duration formatters |
| 2281 | `/* 4. State and storage` | `state`, `profile()`, `Store`, save pipeline, `Cloud`, `pushCloud`, `mergeSaves`, `hydrate` |
| 2712 | `/* 5. Text generation` | Letter `MODEL`, `adaptiveText`, `POOLS`, `wordsText`, `drillText` (Practice these), My text docs (`cleanDocument`, `splitPassages`, `addDoc`, `openDoc`, `deleteDoc`), `MARKS`, `decorate`, Chinese subsection (`ZH_LIST`, `ZH_KEYS`, `zhText`) |
| 3093 | `/* 6. Letter statistics` | `keySpeed`, `skill`, `focusKey`, `canUnlock`, `weakLetters`, `applyKeyStats`, `testDetail` |
| 3201 | `/* 7. Test engine` | `lesson`, goals and time tracking, `stepWords`, keystroke capture (`keyDetail`, `unfinished`, `joinDetail`, `noteMiss`), `newLesson`, `startLesson`, `drillLesson`, `typeChar`, `failAttempt`, `backspace`, `finishLesson` (which grows and shrinks Step up) |
| 3548 | `/* 8. Practice screen` | `el` registry for the whole app, header renderers, Goal celebration (and `noteStepDown`), Zoom, text renderer (with `updateLive` and `renderPips`), My text library and pdf.js, Welcome subsection (`isNewcomer`, `welcomeSteps`, the `art*` pictures, `openWelcome`, `onWelcomeKey`, `bindWelcome`) |
| 4699 | `/* 9. Keyboard` | `buildKeyboard`, `refreshKeyboard`, `drawHands`, `markNextKey`, cue, `celebrateUnlock` |
| 4980 | `/* 10. Progress screen` | `prog`, `TYPISTS`, `palette()`, `sizeCanvas`, eight canvases drawn by seven functions, Calendar subsection, Analysis subsection (`ANALYSIS_MIN`, `analyze`, `renderAnalysis` and one `renderAna*` per card, `drillPlan`, `startDrill`, `endDrill`, `dropDrillBack`, `renderDrillOn`) |
| 6160 | `/* 11. Settings` | `EFFECTS`, `applyTheme`, `setSetting`, `bindSettings`, `syncSettingsUI`, backup and restore, Cloud save subsection, reset |
| 6632 | `/* 12. Events` | `showView`, Input methods subsection (`imeKey`, `imeActivity`, `followInput`, `zhKey`, `zhInput`), `onKeyDown`, `onSinkInput`, `bindEvents` |
| 6824 | `/* 13. Start` | `init()`, called on the last script line. It opens the welcome for someone new after the first test is drawn |

The script does all the rendering. Keystrokes go from `onKeyDown` or `onSinkInput` into section 7, to `typeChar`, `backspace`, `restartLesson` (Esc) and `skipAhead` (Tab). Those call the painters in sections 8 and 9. Each settings control is bound by `data-setting="<key>"` through `bindSettings`. It then goes through `setSetting`, which runs the refreshers listed in `EFFECTS` and saves.

The script changes the look mostly through root attributes (`data-theme`, `data-font`, `data-zoom`) and classes, plus a few inline styles for timing and position (`--fade` on the board, `--leave` on the cheer, caret and text transforms). In the other direction, canvases and confetti read colors from CSS variables through `palette()` and `burst()`.

## State, storage and versioning

- **The `state` object.** It holds `version, settings, profiles, daily, clean, goalMetOn, cheered, docs, docId, removed, step, restoredAt, drillBack, devices, welcomed, savedAt`. `drillBack` is `"zh"` while Practice these has switched Chinese off and `""` otherwise (see Practice these in Gotchas). `welcomed` is when the welcome was closed (ms), or 0 for never. `step` is `{day, words, at}`, how long Step up's tests are on that local day and when that last changed (ms, set by `finishLesson` whenever it grows or shrinks, 0 in saves from before it was timed). `finishLesson` sets `at` to now or one past the `at` it replaces, whichever is later, so a change always beats the copy it changed even when another device's clock is ahead. `hydrate` clamps `at` to between 0 and a day past now. Don't hold it closer to now, or a fast clock's `at` is lowered here but not in that clock's own copy, which then undoes the next change made here. `mergeSaves` keeps the later day's, or on the same day the later change (see `mergeSaves`). Each `profiles[layout]` is `{unlocked, keys, history, customPos, resetAt}`, so letter stats, unlocks and history are kept per layout. `daily` and `clean` (ms per local `YYYY-MM-DD`) are shared by all layouts.
- **Saved shapes are fixed.**
  - Letter stats are `{t, n, e, m, x}`.
  - History entries are `{ts, wpm, acc, dur, words, mode, tries, nk, k, tx, mx, tm}`, with `k[ch] = [avgMs, timed, typed, missed]`. Older entries have no `k` or `nk` and must keep working. A Chinese test has `lang: "zh"` and no `nk`, `k`, `tx`, `mx` or `tm`. Entries without `lang` are English.
  - `tx`, `mx` and `tm` are every keystroke of the test, for the Analysis tab, made by `keyDetail` and `joinDetail` in `finishLesson`. `tx` is the test text. `mx` is `[[i, typed, ms], ...]`, the first wrong key at each position `i` of `tx` that went wrong, with the ms since the key before (left out when there is none, at a test's first key or right after Backspace). Wrong keys typed after it while the mistake still shows (the trail, and every blocked key with Backspace to delete) are not noted again, so `mx` lines up with `errAt`. `tm` is two base 36 digits per character of `tx` (so `tm.length === 2 * tx.length`), the time before the key that typed it right on the first try in 10 ms steps, capped at `APP.idleGap`, or `zz` when there is none (first key, after Backspace, or a missed position).
  - Attempts that end early (a failed try in One mistake restarts, Esc, Tab, a settings change) have no entry of their own. `keepPartial` holds their keys in `unfinished` (not saved, at most `APP.unfinishedChars` characters, dropped on a layout change or Reset progress), and the next finished test on the same layout puts them first in its `tx`, each part ending in a `\n` with `zz` in `tm`. Lesson text never contains `\n`, and the analysis never counts a switch across one. So `tx` can be longer than the text the entry's `wpm` and `acc` describe.
  - Only the newest `APP.detailTests` tests per layout, holding at most `APP.detailChars` characters of `tx`, keep these three fields. `trimDetail` strips the rest, and both `finishLesson` and `hydrate` run it, so merges can't grow it back. Old entries without them, or with ones that don't add up, are skipped by `detailedTests` and work everywhere else as before.
  - Docs are `{id, title, words, passages, at, added, finished}`. Doc text is never stored in the main blob, which is why My text tests keep no `tx`, `mx` or `tm` (`finishLesson` and `holdPartial` skip them). Otherwise a removed text's words would live on in the main save and in the cloud's daily copies, which are never deleted.
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
- **`hydrate` is the one gate for every load.** That covers init, cloud connect, the merge inside `pushCloud`, backup restore and daily cloud copy restore. It rebuilds state field by field and resets any setting whose `typeof` differs from DEFAULTS. It checks enums against include lists or lookup tables and clamps numbers. It caps history at `APP.historyLimit` (and its keystroke detail through `trimDetail`), `daily` and `clean` at 400 days and `removed` at 200. It clamps `welcomed` to a whole number of 0 or more, and a save with any test in any profile but no `welcomed` counts as welcomed (stamped with its `savedAt`), so saves from before the welcome need no version bump and never see it. It never updates `state.version`.
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
  - `step` takes the later day's. On the same day it takes the copy with the later `at`, so a step down holds against a copy that grew earlier (taking the larger, as it used to, would undo every step down the next time a cloud copy or another tab merged in). Since `finishLesson` always puts `at` past the step it replaces, a change made after a copy merged in beats that copy however the clocks differ. Two changes made without seeing each other are ordered by their clocks. When either copy has no `at` (0), as in a save from before it was timed, the larger `words` wins, as before.
  - `welcomed` takes the larger of the two, so closing the welcome on one device counts on every device. Backups, restores and the slim left copy carry it like any other field.
  - `keepMine` keeps the local settings, `drillBack` and `docId`.
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
  - `step` is Step up (`stepWords()` gives today's length from `stepStart` and `stepTop`, and `finishLesson` grows or shrinks it before making the next test), `stepDown` is Down after (the mistakes that take a word away), `custom` is My text, `suddenDeath` is One mistake restarts, `emulate` is Follow key positions, and `weakBoost` is Extra practice for weak letters.
  - Step up is the default mode, but the Practice page never names it (the owner asked for the label to go). `renderFocus` hides `#focus` in English Step up just as in Words, and Chinese Step up shows the same "Chinese, N words" line as Chinese Words. Only the word count under the text, the mistake dots beside it and the tags above the text ("Perfect, now 5 words" and "3 mistakes, now 4 words") show it changing. Settings keeps its button under Text to type and the Step up row with Start, Top and Down after, and the welcome explains it.
- **Stepping down.** After each finished Step up test (English or Chinese), `finishLesson` adds a word for a perfect test, up to Top, keeps the length for fewer than `stepDown` mistakes and takes one word away for `stepDown` or more, never below Start. `stepDown` 0 turns that off, and it is clamped to `APP.stepDownMax` (5), which is as many dots as fit beside a two digit word count at 375px.
  - A mistake here is a place in the text that went wrong, counted once however many wrong keys it took. That's `lesson.missed`, which `typeChar` raises in the same step as `noteMiss`, when `errAt` goes from 0 to 1, so it always equals the number of set `errAt` entries. Each of those places shows red in the text in all three Mistakes options (`.fixed` once typed right, `.bad` in Move on), as the trail before the cursor until it's fixed, or as `.cur.miss` at the cursor once Backspace has taken the trail away (`paintChar` adds it when `errAt` is set, the state is 0 and no trail shows, and `popTrail` repaints the cursor when the trail empties). A space has no letter to turn red, so a missed space at the cursor or a fixed one gets a `--miss-soft` block, and its dot shows in full with Show spaces as dots. The trail's extra wrong keys (and the blocked keys in Backspace to delete) are one place. Backspacing over a place in Move on doesn't take it back, as it still counts toward accuracy, so the dots never go down within a test. A Move on place you've backspaced over shows plain until you type it again, then red.
  - The counter is `#pips` after `#wordCount`, one `<i>` per allowed mistake that gets `.on` (filled in `--miss`) as places go wrong. `renderPips`, called from `updateLive` and `afterMerge`, builds and fills them and sets the `aria-label` and `title` ("2 of 3 mistakes"), with no visible words. It hides them unless the lesson's `mode` is `"step"` (so not in Words, Adaptive, My text or Practice these, whose mode is `"words"`), One mistake restarts is off, `stepDown` is above 0 and Start is below Top (at Top every test is the same length, as `artStep`'s `flat` also knows). At Start (`stepWords()` at or below `stepStart`) they get `.low`, which fades them, and the label adds ", already at the shortest". They have a fixed size and `flex: none`, so filling one moves nothing. The next test starts with all of them empty, since `lesson.missed` starts at 0.
  - A test that took a word away shows `noteStepDown`'s tag in the Perfect tag's place, `showFlourish(text, "down")`, grey (`.flourish.down`) with no ring, light, sound or hold. A test that reaches a goal shows the goal instead, as with a perfect test.
  - `mistakes` values `clear`, `delete` and `move` are Right key clears, Backspace to delete and Move on.
  - Speeds are always stored in wpm, and a letter's speed is `12000 / ms`. cpm is for display only (x5).
  - `language` is `"en"` or `"zh"` (the Language setting, and the EN and 中文 switch under the text), `followInput` is Follow your input method and `pinyin` is Show pinyin.

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
- **`html, body { overflow-x: clip; }` is load-bearing too.** The board's build up glow (`.board::before`, `inset: -60px -80px`) reaches past the sides of a phone's screen. Without the clip the page scrolls sideways, and mobile browsers widen the layout viewport to fit it, so fixed things like the welcome dialog center on a page wider than the screen and run off its edge. Use `clip`, not `hidden`, which would make `body` a scroll container.
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
- **`keepPartial`** must run before `lesson` is replaced. `startLesson` and `clearLesson` do this, and `L.counted` stops double counting. Text is generated before it runs, so generation sees the stats from before the partial test. It also hands the partial test's keystrokes to `unfinished`.
- **Keystroke capture.** `typeChar` works out `gap` before it touches `L.start` or `L.last`, notes a miss with `noteMiss` only when `errAt` goes from 0 to 1, and sets `L.gaps[i]` only for a first try that was right. Keep those three rules if you change how mistakes work, or the Analysis tab counts trail keys and Backspace retypes as new mistakes. None of it feeds speed, accuracy, letter stats or goals. `L.missed` goes up next to `noteMiss` and feeds Step up's step down and its dots, so the same rule keeps them from counting trail keys and retypes.
- **Stale settings refs.** A `const s = state.settings` captured before a `hydrate` goes stale.
- **`coolUntil`** is shared by `failAttempt` (whose `hold` is captured after `checkGoals`) and `playCheer` (which adds `APP.cheerHold`). `checkGoals` must stay between tests.
- **Celebrations come in three sizes, and they should stay different.**
  - A perfect test (no mistakes) gets `flourishPerfect`, a small `#flourish` tag above the text and a light along the letter row (`.sequence.shine`, ordered by each key's `--i`). It never holds keys. `perfectRun` counts perfect tests in a row and isn't saved. `checkGoals` returns the goals it celebrated, and a test that reaches a goal shows that instead.
  - The clean typing goal alone gets `flourishClean`, one line traced around the text (`.trace`, built once in the board) with the tag sitting on the line as a label. No overlay, no hold.
  - The daily typing goal, alone or with the clean one, gets `playCheer`, the slow release overlay. `renderCharge` (called from `renderGoal`) builds up to it from `APP.chargeFrom` of the goal by setting `.charging`, `--charge` and `--breath` on the Typing today goal and the board.
  - Sounds are `perfect`, `clean` and `release` in `sound()`, and play only with the Sound setting on.
  - A step down isn't a celebration. Its grey tag (see Stepping down) is news about the next test, so it gets no sound, light, ring or hold, and nothing new for it should ever be bigger than the Perfect tag.
- **Docs in progress.** `finishLesson` and `skipAhead` advance whatever `activeDoc()` is at that moment, because the lesson stores no doc id.
- **The Analysis tab.**
  - `renderAnalysis` runs `analyze` over the current layout's detailed tests only when the tab opens (`showView`) and after a merge (`afterMerge`), never per keystroke. It fills in once there are `ANALYSIS_MIN.tests` detailed tests, and each card has its own minimum in `ANALYSIS_MIN` before a key, switch or group shows. Rankings mix `ANALYSIS_MIN.prior` keys at the overall rate into each rate (`rankRates`), so a rarely typed key ranks a little lower than its raw rate and the bars aren't always in strict order.
  - Key places for reasons and switch kinds come from `keyPlace`, which uses `LAYOUTS`, the finger pattern and `ROW_START` (the key widths before each row, matching `buildKeyboard`). A new layout or finger pattern works without changes as long as those tables stay in step.
  - The cards are plain HTML. `.bars` is one grid and each `.bar-row` is `display: contents`, so the labels, bars and figures line up across rows. Bar lengths are the `--v` custom property (0 to 1).
  - Copy that restates script values. The Rushing notes ("Under half your usual gap" and so on) restate the 0.5, 0.8 and 1.25 cutoffs in `analyze`, and the slow switch cutoff is 1.15 times the usual gap in `renderAnaSlow`.
  - Below 480px wide the brand name is visually hidden so the four tabs fit. A fifth tab needs another look at that.
- **Practice these.**
  - `startDrill` builds a plan with `drillPlan` and starts it with `drillLesson(plan)`, which is `startLesson(drillText(plan), attempt, plan)`. The plan sits on `lesson.drill`, and a drill lesson's `mode` is `"words"`, so it never grows Step up, moves My text along (`skipAhead` checks `lesson.drill` too) or unlocks a letter.
  - A drill keeps going until you choose Back to your tests, and every test in it comes from the plan it started with. `finishLesson` starts the next test from the same plan, `restartLesson`, the restart effect in `setSetting` and `failAttempt` pass the plan on, so Esc and One mistake restarts stay in the drill, and Tab in `skipAhead` makes new drill text from the same plan. Pressing Practice these keys again starts a fresh drill from the analysis on screen. Anything that calls `newLesson` (a setting with the `lesson` effect, a layout change, Reset progress, a restore, a cloud merge or sign in that makes a new test) or `clearLesson` ends it. The drill isn't saved, so a reload ends it too.
  - Back to your tests is `#focusBack` on Practice (in `.focus-head`, beside the title, sized so the status row doesn't wrap at 1280px any more than Step up does) and `#anaBack` on the Analysis card, next to the `#anaDrillOn` line. Both call `endDrill`, which starts your usual test with `newLesson` and returns focus to `#sink`. `startLesson` runs `keepPartial` first, and so does `clearLesson` when your usual test is My text with nothing to type, so what you typed of the drill still counts. Both buttons scroll to the top when they come from the Analysis card.
  - Chinese. A drill's keys are English, so `startDrill` switches Chinese off and sets `state.drillBack` to `"zh"` (a fresh drill started during one keeps it). `endDrill` switches Chinese back on. `dropDrillBack` clears it whenever a usual test starts or `clearLesson` runs, so any other way out of the drill (a setting, a restore) stays in English, as before. It's saved, so a copy saved during a drill means Chinese. `hydrate` turns Chinese back on for such a copy unless a drill is still on here, in which case it keeps `drillBack` for Back. `mergeSaves` carries it with the settings (`keepMine` keeps this browser's), so a merge in the middle of a drill never switches Chinese on.
  - `renderDrillOn` shows and hides the two buttons and the on line, and moves the Practice these card above Overview while a drill is on, so a phone shows them without scrolling. The on line names the drill's keys when they differ from the card's (`anaPlan`, from the analysis on screen), since the card's keys move on as you type more tests. `startLesson`, `clearLesson`, `showView` and `renderAnaDrill` run it, so it stays in step with the drill however the drill ends, without running the analysis. `renderFocus` shows the plan's keys while a drill is on. Space or Enter on a focused `#focusBack` presses it instead of typing (`onKeyDown`).
- **The welcome.** A native `<dialog id="welcome">` opened with `showModal()`, labeled by its `<h2 id="welcomeName">` ("Welcome to Keyprint" when it opens by itself, "How Keyprint works" from Settings). Its code is the Welcome subsection at the end of section 8.
  - It opens by itself once, from `init()` right after the first test is drawn, when `isNewcomer()` holds (no test in any profile and `state.welcomed` is 0), `window.keyprintNoWelcome` isn't `true` and `Account.marker` is null. A browser that was signed out (or had its account deleted or was cleared) has been used before, and its "Signed out" toast would sit unseen under the dialog's backdrop, so it skips the welcome. The How Keyprint works row at the top of the Test group in Settings opens it again with its Show button.
  - `welcomeSteps()` builds the four steps (typing, Step up, keys and mistakes, goals and progress) each time it opens, with every number and name read from the settings then (`stepStart`, `stepTop`, `stepDown`, `mistakes`, `suddenDeath`, `dailyGoal`, `cleanGoal`, `mode`, `zoom`, `language` and `pinyin`, capitals and punctuation, Show keyboard and Finger colors) and from `coarse()`. A touch screen has no Esc or Tab, so it says to tap the text (and Leave Text only in Text only), with Esc and Tab only for an attached keyboard. Tab gives the next passage only when `passagesOn(s)`, My text in English, since a Chinese test never types My text. The capitals note is left out for My text and Chinese, which `decorate` never touches. The keyboard sentence knows that Zoom other than Normal hides the keyboard just as Show keyboard off does. The last sentence of step 4 comes from `welcomeSaves()`, which offers signing in only where `accountPlace()` exists and says `"ok"`, and a backup file otherwise. So a change to any of those features, or to the goal ring labels, the blue ring, how mistakes count, or Esc and Tab, needs the welcome's copy checked too.
  - Each step's picture is built by `artType` (a Chinese word with its pinyin in Chinese, and a tap in place of Esc and Tab on a touch screen), `artStep` (tests as bars, red where a test had mistakes. With Down after on and One mistake restarts off, the second bar carries the practice screen's dots one short of full and the bar after it is as tall, and the fifth has every dot full and the bar after it is a word shorter. Down after 1 has only the full one. With Down after 0 or One mistake restarts on it's the old picture, a red third bar with no dots and the next one as tall), `artKeys` (the layout's home row in its finger colors) and `artGoals` (real `.goal` markup filled by `fillGoal`), from existing variables only. All four steps share one grid cell (`minmax(0, 1fr)`, so a wide picture can't widen the dialog) and the ones not showing are `visibility: hidden`, so the dialog keeps the height of the longest step and Back and Next stay put. Keep the steps about the same length, or the short ones look empty. Below 360px the keys and the chart shrink to fit a 320px phone.
  - On a short screen the dialog scrolls inside, with `.welcome-foot` sticky at the bottom, and opening and every step change set its `scrollTop` to 0, so each step starts from its picture with the heading and Next in view.
  - While it's open no key reaches the test. `onKeyDown` returns first thing, `onSinkInput` empties `#sink` and returns, and the composition and `beforeinput` listeners do nothing. The dialog itself takes focus (`tabindex="-1"`), not Next, so someone who starts typing without noticing it presses nothing, spaces included. `onWelcomeKey` (a second document `keydown` listener) treats Enter on the dialog itself as Next, keeps Tab and Shift Tab going round the dialog's buttons (Tab from the dialog itself goes to Next) and pages with the Left and Right arrows. Esc is left to the dialog, which closes on its own, so it never restarts the test. Keep these guards if you add another way for keys to reach the test.
  - Closing it in any way (Esc, the close button, a click on the backdrop, Start typing on the last step) runs `onWelcomeClosed`, which sets `state.welcomed` to now and saves, then focuses `#sink` on Practice. Start typing from Settings goes to Practice first. A backdrop click comes to the dialog itself with coordinates outside its box, and only counts when the press started outside too, so a drag to select its words doesn't close it. When the automatic welcome closes before its last step, a toast says "You'll find this tour in Settings".
  - The dialog sits in the browser's top layer, above the toast and the cheer, whatever their z-index, so a toast shown while it's open goes unseen. Under reduced motion its animations are `none`, since nothing waits on their end events and their delays would still run.
- **Chinese tests.**
  - `ZH_WORDS` is one string of entries split by commas, each a word and then one toneless pinyin syllable per character, with `v` for ü. `ZH_LIST` silently drops an entry whose syllable count doesn't match its characters, so check `ZH_LIST.length` after editing the list.
  - With `language` on `"zh"`, `newLesson` makes `zhText` instead of the mode's text, as long as Step up (`stepWords()`) or Words per test (every other mode). The text has no spaces. `lesson.zh` is `{py, ends}`, the pinyin of each character (`""` for the marks ， and 。) and the index of each word's last character, which drives `wordAt` and `words`. `startLesson` takes it as a fourth argument, and `restartLesson` and the restart effect pass it on. A Chinese lesson's `mode` is `"step"` or `"words"`, so it never moves My text along or unlocks a letter.
  - Each Chinese `.c` holds a `.py` span before the character, so `paintChar` writes the character to `c.lastChild` and keeps the span. The board gets `.zh` (line height 2.4 and `calc(2.4em * 3)` instead of 1.7) and `.nopy` with Show pinyin off. `paintPinyin` fills in the pinyin as the input method takes letters, and `pinyinFit` works out how far it got and the next key for `markNextKey` (letters, then Space once a word is spelled out). `placeSink` keeps the hidden input under the next character so the input method's word list opens there.
  - Input methods. `imeKey` leaves keys to the input method (`isComposing`, `"Process"` or keyCode 229). The finished text comes through `#sink`, and `onSinkInput` doesn't read or clear the input while `composing`. `compositionend` reads it again with `setTimeout(onSinkInput, 0)`, since Chrome sends the last input event before it and Safari and Firefox after. In English on a touch screen all of this is skipped, because phone keyboards compose English words too, and English there keeps reading every letter at once.
  - `imeActivity` counts keys going into the input method toward practice time and starts the test's clock at the first one, so Chinese speed counts every character (`finishLesson` uses `text.length`, not `text.length - 1`).
  - `followInput` switches language with a toast. Chinese text arriving in an English test switches to Chinese (Japanese kana and Korean hangul don't), and two letters in a row typed into a Chinese test with no input method taking them switch to English. With Follow your input method off, a note under the keyboard (`inputNote`) says what's happening instead.
  - Chinese speeds always show in cpm (`unitLabel` and `speedValue` check `zhOn()`). `testsNow()` gives the current language's tests, and the practice figures and every Progress chart use it, so the two never mix. Progress hides its `.en-only` cards (letters and Where you stand) for Chinese. Chinese tests keep no keystroke detail, so the Analysis tab only ever covers English, and `startDrill` switches English back on (`endDrill`, or the next start if you leave during the drill, turns Chinese on again).
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
- **Copy that restates script values.** "three seconds" is `APP.idleGap` and "1 to 1,000" is `APP.maxWords`, so change copy and value together. The Language hint says Chinese speeds are in characters per minute, which is `unitLabel`. The Step up hint in Settings ("Down after is how many mistakes take one away, and 0 turns that off") and the welcome's step 2 ("One or two mistakes keep the same length, and three take a word away", from `stepDownText`) restate the rule in `finishLesson`, and `stepDownText` spells counts with `COUNT_WORDS`, which only goes up to five. The `max="5"` on `#set-step-down` is `APP.stepDownMax`, and its `min="0"` only works because `bindSettings` falls back to 1 only when a number input has no `min`. The select and slider options cover fewer values than `hydrate` accepts.
- **Reduced motion** uses `0.001ms` rather than `none`, so end events still fire.
- **`.sink`** must stay focusable (opacity 0, not display none) and keep its 16px font size, or iOS zooms on focus.
- **Z-index stack.** The welcome dialog's top layer is above everything. Then toast 30, cheer 20, chart tip 15, zen hint 5, cue 3. The board isolates its own stack (`isolation: isolate`), so its build up glow sits at -1 behind the text and `#flourish` at 1 above the traced line.

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
