# MyRJ Schedule Cleaner

A single-page browser tool that fixes MyRJ calendar exports so teachers can merge their
teaching schedule into their real Outlook calendar **without being marked busy from
midnight to midnight on every school day**.

**Live:** https://rjedtech.github.io/MyRJScheduleCleaner/

Part of the RJ Ed Tech family — [Raider Randomizer](https://rjedtech.github.io/Raider-Randomizer/) ·
[Raider Timer](https://rjedtech.github.io/Raider-Timer/) ·
[Raider Pod Generator](https://rjedtech.github.io/Raider-Pods/) ·
[Raider Quiz Builder](https://rjedtech.github.io/Raider-Quiz-Builder/)

---

## The bug

MyRJ (Blackbaud onCampus) publishes calendar feeds as iCalendar. Teachers who want
colleagues to stop booking meetings over their teaching blocks have to **import** the
feed rather than subscribe to it — only an import blocks time in Scheduling Assistant
and reaches the Outlook mobile app.

But importing the Schedule feed marks the teacher busy all day, every school day.

**Root cause:** the feed contains all-day events (`White Day (RJHS)`,
`Red Day - One-Hour Late Start (RJHS)`, `Thanksgiving Holiday - SCHOOL CLOSED (RJHS)`)
and emits **no `TRANSP` property on any event in the file**. RFC 5545 says absent
`TRANSP` means `OPAQUE` — busy. Outlook obeys.

Blackbaud isn't marking these busy. It never says anything, and the default is the
worst answer. This is a one-line omission, so the fix is to add the missing property,
not to delete the events.

## What it does

Two modes. **Mark free is the default.**

**A — Keep them, but stop them blocking my time.** For every all-day `VEVENT`, insert
before `END:VEVENT`:

```
TRANSP:TRANSPARENT
X-MICROSOFT-CDO-BUSYSTATUS:FREE
```

Both, deliberately: `TRANSP` is the standard property, `X-MICROSOFT-CDO-BUSYSTATUS` is
what Outlook actually reads in practice. Timed events are **not touched** — they have
no `TRANSP` either, and default-opaque is exactly right for a class block.

**B — Remove them entirely.** Drop all-day `VEVENT`s, for people who already subscribe
to the Red Day / White Day calendars separately.

## Implementation notes

**Conservative surgery, never a rewrite.** The file is tokenised into an ordered list of
raw passthrough lines and complete `VEVENT` blocks, then reassembled in the same order.
`VTIMEZONE`, `PRODID` and every unknown property survive byte-for-byte, and nothing is
ever moved.

- Strips a UTF-8 BOM if present.
- Splits on `\r\n | \n | \r`; always writes back `\r\n`.
- Detects all-day via `DTSTART` parameters matching `VALUE=DATE` (not `DATE-TIME`),
  falling back to "no `T######` in the value."
- Honours RFC 5545 line folding when *reading* property values. Never re-folds on write.
- Skips insertion if the property is already present — **idempotent**, so running the
  tool on its own output is byte-for-byte a no-op.
- Preserves `UID`s untouched.
- A truncated file (unterminated `VEVENT`) is detected, passed through untouched, and
  flagged to the user — rather than having a property injected at the wrong offset.

### No CORS proxy — on purpose

A static GitHub Pages site cannot `fetch()` the MyRJ feed; Blackbaud doesn't send
`Access-Control-Allow-Origin`.

**A CORS proxy is deliberately rejected.** The feed URL is an unauthenticated bearer
token granting full read access to that person's schedule. Routing a hundred staff
members' schedule tokens through a third-party relay is not an acceptable trade for
saving one click.

The tool attempts a direct `fetch` (so it just works if Blackbaud ever adds CORS
headers), and on the expected failure renders a plain `<a download>` link — anchor
downloads are not subject to CORS — then reveals a drop zone. Everything from there is
local.

**The whole file is processed in the browser. Nothing is uploaded, stored, or
transmitted.** The page makes zero external requests and works with the network
unplugged.

## Constraints

Single `index.html`. Inline CSS and JS. No build step, no framework, no external
requests, no webfonts, no analytics, no data collection. Vanilla ES5-compatible JS —
school machines, mixed browser versions.

Design system matches Raider Quiz Builder: Raider Red `#C11430` on neutral greys,
3px radii, IBM Plex Mono for numerals and labels (with a local fallback stack — no
webfont is loaded), `[data-theme="dark"]` toggle with `localStorage` persistence.

## Known limits

- **Snapshot, not sync — and the failure mode is worse than staleness.** Redo each
  semester and delete the previous import first; Outlook does not reliably deduplicate.
  More importantly, late-breaking schedule changes (special schedules, weather delays)
  never reach an imported calendar, so on those days it actively misinforms. Every user
  must also hold a live subscription to the same feed, with the subscription as the
  tie-breaker.
- **The Schedule feed only emits a day-type marker on days you have something
  scheduled.** A teacher with a free Tuesday gets no Red/White marker for it.
- **Windows / desktop Outlook assumed.** Mac and mobile paths are untested.
- **Blackbaud could change the feed format** without notice. The `VALUE=DATE`
  discriminator is stable iCalendar; the `(RJHS)` suffixes and title patterns are not —
  no logic is built on titles.
- **Feed window is past 2 months + next 12 months.** Changes take up to an hour to reach
  the feed; Outlook refreshes subscriptions every 3–4 hours.

## Tests

Both harnesses run against a real 288-event faculty export and exercise the **shipped**
`index.html` — the acceptance suite extracts and evaluates the actual `<script>` block
rather than a reimplementation.

```bash
node test/acceptance.js path/to/Schedule.ics   # 77 checks, no dependencies
npm install playwright
node test/e2e.js path/to/Schedule.ics          # 17 checks, real Chromium + real download
```

`acceptance.js` covers the transform (both modes), byte-for-byte preservation,
idempotency across three runs, CRLF and line-length conformance, BOM / LF / CR inputs,
truncated files, ordering, URL normalisation, and the design-system and
no-external-request guarantees. `e2e.js` drives the page in a browser, asserts that
**zero network requests** are attempted, and validates the file the browser actually
downloads.

## Reuse

This generalises past MyRJ. Any Blackbaud onCampus school hits the identical bug, and
the same pattern applies to any `.ics` feed that omits `TRANSP` on all-day events.

---

Regis Jesuit High School · Educational Technology
