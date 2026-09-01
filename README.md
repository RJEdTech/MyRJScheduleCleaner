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

**The one exception — days the teacher is off get *blocked*, not freed.** An all-day
marker for a day the school is closed is the one all-day event you *want* to block, so
central staff who still work that day don't book a meeting on it. Those are detected by
`isClosedDay(summary)`:

- summary contains **`SCHOOL CLOSED`** (Labor Day, Thanksgiving, MLK, Presidents' Day,
  Good Friday, Easter Monday, St. John Francis Regis Day, Christmas/Summer Break, etc.), or
- summary contains **`NO CLASSES`** *and* the word **`Break`** (Spring / Thanksgiving /
  Fall / Christmas Break — the multi-day breaks a teacher is off for).

Deliberately **not** matched: `In-Service Day - NO CLASSES` and retreat/testing "NO
CLASSES" days — the teacher is on campus working those, like all faculty, so they stay
free. For a closed day the tool strips any existing free/busy props and forces:

```
TRANSP:OPAQUE
X-MICROSOFT-CDO-BUSYSTATUS:OOF
X-MICROSOFT-CDO-INTENDEDSTATUS:OOF
```

so the whole day reads **Out of Office**. Closed days are kept and blocked in **both**
modes (they are the point). Idempotent: a re-run strips and rewrites the same three lines.
`buildCleaned` returns `closedBlocked` alongside `changed`.

**B — Remove them entirely.** Drop all-day `VEVENT`s, for people who already subscribe
to the Red Day / White Day calendars separately. (Closed days are still kept and blocked.)

**Part-time option (`teachDays`).** A fifth argument to `buildCleaned` — `"both"`
(default, full-time), `"white"`, or `"red"`. For a part-timer who is only at RJ on the
days they teach, the *other* rotation's day markers block as Out of Office (same OOF
props as a closed day). `"white"` blocks every `Red Day`; `"red"` blocks every
`White Day`; detected via `dayLabel(summary)`. School-closed/break days block regardless,
In-Service / retreat / testing / IMPACT days are unaffected (not a Red/White rotation
day), and `"both"` changes nothing — so the default is a no-op for everyone full-time.
`buildCleaned` returns `offBlocked` alongside `closedBlocked`. In the page it's the
"Are you here every day, or only when you teach?" question — which sits in Step 3 in the
open, not behind the options toggle, because it is the one question on the page with no
safe default.

**Rebuilding the days the feed never sent (`rotationPlan`).** Re-flagging is not enough on
its own, and this is the failure that matters. **MyRJ emits a day-type marker only on days
you have something scheduled**, so a teacher who is here only on her teaching rotation
receives almost none of the *other* colour's days — precisely the days she needs blocked.
Measured on a real part-time export: **82 Red days in the year, 27 of them present in her
file.** The other 55 were invisible, and a `teachDays` run alone produced a file that looked
finished while two-thirds of her year still read as free.

`rotationPlan(doc, teachDays)` reconstructs them from the file itself. It leans on one fact:
she teaches *every* day of her colour, so every day of her colour is in the file.

1. `dayLabel` matches `Red Day` / `White Day` **anywhere in the title**, not just as a
   prefix. This is what catches `2RW Semester Exam & Red Day Review Classes` — a real Red
   day wearing an exam title, and the difference between 78/82 and 82/82.
2. An unmarked school weekday whose immediately-preceding **or** following weekday carries a
   marker of the teaching colour is an off day → rebuild it.
3. A day that already carries any marker is never touched. Every holiday and break in the
   feed carries one, so the rebuild cannot land on one; those block via `isClosedDay`
   instead, for their own reason.

Rule 2 beats a run-length heuristic ("two or more blank weekdays is a break"): winter break
is excluded because its neighbours are exam days and blanks, while a Red day at the *tail*
of that break is recovered because the next school day is a marked White day. The scan
starts a week early, which reaches back **exactly one weekday** before the first day the
feed knows about — the first day of school precedes a part-timer's first class. That
boundary day is the one place the tool blocks a day it cannot prove is a school day;
deliberate, because the alternative is leaving the first day of the year showing her free.

Rebuilt days are appended before `END:VCALENDAR` as all-day `VEVENT`s titled
`Not teaching - Red Day`, carrying the same OOF trio as a closed day, the normal import
labels for deletion, and a deterministic `UID` (`myrj-off-<YYYYMMDD>@rjedtech.local`) plus
the feed's own `DTSTAMP` — so running the tool on its own output is byte-for-byte a no-op.
`buildCleaned` returns `offAdded`.

**Two guardrails, because a rebuild is a guess when the pattern isn't clean.** The rebuilt
sequence must strictly alternate across every unbroken run of rotation days (a closed day,
an exam day or a break legitimately interrupts it and resets the check), and no single-day
hole may survive the rebuild inside the range the feed covers — one that does means a day of
*her* colour is missing too, so she isn't in for all of them. Either failure and
`rotationPlan` returns nothing at all rather than inventing days; `buildCleaned` reports
`rotBroken` and the page says so in plain English instead of shipping a file built on a
guess. A full-timer (`"both"`) rebuilds nothing, so the default remains a no-op.

## Implementation notes

**Conservative surgery, never a rewrite.** The file is tokenised into an ordered list of
raw passthrough lines and complete `VEVENT` blocks, then reassembled in the same order.
`VTIMEZONE`, `PRODID` and every unknown property survive byte-for-byte, and nothing is
ever moved.

- Strips a UTF-8 BOM if present.
- Splits on `\r\n | \n | \r`; always writes back `\r\n`.
- Detects all-day via `DTSTART` parameters matching `VALUE=DATE` (not `DATE-TIME`),
  falling back to "no `T######` in the value."
- Honours RFC 5545 line folding when *reading* property values, and re-folds correctly when
  rewriting `CATEGORIES` — on character boundaries, continuations prefixed with one space,
  every line inside 75 octets.
- Skips insertion if the property is already present — **idempotent**, so running the
  tool on its own output is byte-for-byte a no-op.
- Preserves `UID`s untouched.
- Labels every event it writes by **prepending** to the existing `CATEGORIES` value — never as a
  second `CATEGORIES` property, because Outlook reads the first occurrence and silently discards
  the rest. `SUMMARY` — the event title — is never touched.
  - `MyRJ Import` — stable, never changes. Category *names* travel in an `.ics`; category
    *colours* live only in the reader's mailbox, so an imported category arrives colourless and
    Outlook draws the event grey. A label that survives every semester means that colour is
    assigned once rather than every August and January.
  - `MyRJ Import <YYYY-MM>` — the batch handle, for deleting one semester's import and not another.
  - Optionally a per-class label first (`Theology 3`, `White Day`, …), which is what Outlook
    colours the event from. Sections of the same course share one label; the division suffix
    (`(BD)` / `(GD)`) is added only when the same course appears in both.
  - Re-running replaces the dated label and never stacks duplicates of the others.
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

## The page itself

The instructions are not incidental to this tool; for most teachers they *are* the tool. Written
for a reader who has been burned by technology before, will not troubleshoot, and stops at the
first screen that doesn't match the page:

- **Four steps, not three.** Subscribing to the live feed is Step 5 in its own right, not a
  footnote after the import. The README has always called it mandatory; the page now agrees.
- **Both download routes are described.** *Open in a new tab* and *Copy link* behave differently
  and the copy used to describe only the second. The output filename is editable before download,
  so the browser's silent naming stops mattering.
- **Drawn, never captured** — inline SVG with live text, nothing to 404, crisp at any zoom,
  renders offline. Now six figures: the MyRJ toolbar, the feed dialog, the right-click menu, a
  finished download, Outlook's Add calendar pane, and Outlook's category colour picker.
- **The main-calendar trade is stated.** Importing into a calendar of its own is trivial to
  delete later but doesn't make you look busy, which is the point of importing. The page says so
  once and the removal section no longer contradicts it.
- **Print stylesheet.** The job spans two applications, so the steps have to survive being
  printed: collapsed explainers open, interactive panels drop out, figures stay.

## Constraints

Single `index.html`. Inline CSS and JS. No build step, no framework, no external
requests, no webfonts, no analytics, no data collection. Vanilla ES5-compatible JS —
school machines, mixed browser versions.

Design system matches Raider Quiz Builder: Raider Red `#C11430` on neutral greys,
3px radii, IBM Plex Mono for numerals and labels (with a local fallback stack — no
webfont is loaded), `[data-theme="dark"]` toggle with `localStorage` persistence.

## Verified in Outlook

The manual check is done, on a real mailbox: the cleaned file imports, the all-day Red/White
markers land in the all-day band **without blocking the day**, and timed class blocks still read
busy. Both Outlooks were checked — see the colour finding below for the one way they differ.

## Known limits

- **Snapshot, not sync — and the failure mode is worse than staleness.** Redo each
  semester and delete the previous import first; Outlook does not reliably deduplicate.
  More importantly, late-breaking schedule changes (special schedules, weather delays)
  never reach an imported calendar, so on those days it actively misinforms. Every user
  must also hold a live subscription to the same feed, with the subscription as the
  tie-breaker.
- **The Schedule feed only emits a day-type marker on days you have something
  scheduled.** A teacher with a free Tuesday gets no Red/White marker for it. Surfaced on the
  page under "Things that look wrong but aren't," because it reads as a failed import.
- **Windows / desktop Outlook assumed.** Mac and mobile paths are untested. The page says so
  out loud now, in Step 1, along with the Ctrl-click / two-finger-click gesture — a teacher on a
  Mac previously hit a dead end at "right-click" with no way forward.
- **Blackbaud could change the feed format** without notice. The `VALUE=DATE`
  discriminator is stable iCalendar; the `(RJHS)` suffixes and title patterns are not —
  no logic is built on titles.
- **Feed window is past 2 months + next 12 months.** Changes take up to an hour to reach
  the feed; Outlook refreshes subscriptions every 3–4 hours. Both are now stated on the page:
  the window explains "only about a year of schedule," and the refresh lag qualifies the
  otherwise-absolute advice to trust the subscription — on the morning of a weather delay it may
  still be catching up, so MyRJ itself is the only live copy.

## Which feed to use

MyRJ's feed dialog has two sections. **Use one from `My Calendars`:**

| Feed | Who it's for |
|---|---|
| **Schedule** | Your teaching blocks. The one nearly everyone wants. |
| **Games/Practices** | Coaches |
| **Group Events** | Group moderators |
| **Class Events** | Assignment due dates — a poor fit for blocking time, and empty for most people |
| **My Calendars** (Entire Calendar) | All of the above at once |

**Not `School Calendars`.** That's the separate school-wide section: ~1,735 events, nearly all
of them other people's games, practices and meetings. The tool warns if it's handed a file with
more than 600 events.

## Tests

Four harnesses, all exercising the **shipped** `index.html` — the suites extract and evaluate
the actual `<script>` block rather than a reimplementation.

```bash
node test/rotation.js                                                         # self-contained
node test/verify.js "School Calendars.ics" Schedule.ics "Class Events.ics"   # any export
node test/acceptance.js Schedule.ics                                          # spec + design system
npm install playwright && node test/e2e.js Schedule.ics                       # real browser
```

- **`rotation.js`** — 22 checks, no input file needed. Builds a synthetic school year with a
  one-day holiday, a multi-day break and an exam week, hands the tool only the slice MyRJ
  would really send a White-day teacher, and asserts the rebuild recovers every Red day and
  invents none: no White day blocked, no break day invented, exam days untouched, the
  boundary day bounded to one, idempotent, and an irregular part-timer detected and
  declined. Synthetic on purpose — the bug was found on a real teacher's export, and a real
  export does not belong in a public repo.

- **`verify.js`** — derives every expectation from an independent scan of whatever file it's
  given, so it works on any feed. 53 checks per file: transform correctness in both modes,
  byte-for-byte preservation of timed events and folded lines, `LOCATION`/`DESCRIPTION`/`SUMMARY`
  counts, UID order, CRLF, 75-octet conformance, idempotency across three runs, and BOM/LF inputs.
- **`acceptance.js`** — 137 checks: every row of the spec's acceptance table, truncated-file and
  ordering edge cases, `webcal://` → `https://` conversion, plus assertions that the design system
  matches Raider Quiz Builder token-for-token and that the page requests nothing external.
- **`e2e.js`** — 40 checks in real Chromium: pastes a real feed link, verifies the live conversion
  and clipboard, uploads the export, captures the actual download, and asserts that **zero external
  requests** are attempted (they're blocked and recorded, not merely observed).

Verified against four real exports — `Schedule` (288 events), `My Calendars` (288),
`Class Events` (0), and `School Calendars` (1,735 events with 40 folded lines,
`LOCATION` on 1,302 and `DESCRIPTION` on 61) — plus synthetic empty and single-event feeds.
`verify.js` additionally checks the part-time path on any export: rebuilt days are all-day,
Out of Office, on weekdays, never colliding with a day already in the file, and a second run
rebuilds nothing new.

**Current state, and it is not all green.** `rotation.js` passes 22/22 and `verify.js` passes
140/142 on `Schedule-test.ics` + a real part-time export. The two `verify` failures are
pre-existing fixture gaps in `Schedule-test.ics` (two events carry no `CATEGORIES`), not
regressions. **`acceptance.js` and `e2e.js` have been failing since the v2.0 wizard shipped** —
they assert against the old `sec1`–`sec5` markup, the workflow strip and both download routes,
all of which the wizard replaced. They need rewriting to the `step1`–`step6` IDs before either
is worth trusting.

### Deleting a previous import

Because UIDs are regenerated (below), re-importing without deleting the old set guarantees
duplicates — and Outlook has no "undo this import" command. The stamp exists to make deletion a
single selection:

1. Calendar → **View** → **Change View** → **List** — turns the calendar into a sortable table
2. Find the batch three ways: search `category:"MyRJ Import"`, sort the **Categories** column, or
   add the **Created** column via Field Chooser — a single import shares one timestamp to the
   minute, so the batch is contiguous and the timestamp recovers the forgotten import date
3. Select the block, **Delete**, then switch back to **Calendar** view

Step 2 is the part nobody knows about, and it's what makes this tractable. These steps live in a
standalone always-visible `#remove` section, linked from the top of the page — not inside a
workflow step that is hidden until you have run the tool, which is where they were through v1.2
and where nobody returning a semester later could find them.

### Finding: the two Outlooks colour an import differently

Confirmed on a real mailbox, same cleaned file, same account, side by side:

- **Classic Outlook** draws every imported event in the **calendar's own colour**, exactly like
  everything else in that calendar. The categories are present and still do their job for
  finding and deleting; they simply don't affect how anything looks.
- **New Outlook and the web** draw an event in the colour of its **first category**. A category
  the mailbox has never seen arrives with no colour, so the import renders **grey** next to the
  user's own colour-coded events.

Category *names* travel inside an `.ics`; category *colours* live only in the reader's mailbox,
which is why nothing the tool writes can fix this at the file level. What the tool can do is
guarantee a **stable** first category to colour — hence `MyRJ Import` never changing, and the
per-class labels being written first when that mode is chosen.

Practical consequence, and it belongs in the user-facing copy rather than only here: a teacher in
classic Outlook needs to do nothing, and a teacher in new Outlook has a one-time
**Settings → Accounts → Categories → edit → pick a colour** to do. Reported from the field as
"it imports but doesn't take the calendar colour," which sounds like a broken import and isn't
one.

### Finding: Blackbaud regenerates UIDs on every export

Downloading the same feed twice produces **zero shared UIDs** — same 288 events, same summaries,
288 completely different `UID` values and a new `DTSTAMP`. This settles a question the build spec
left contradictory: a re-import can never be matched to a previous import, because there is
nothing stable to match on. **Deleting the previous imported set before re-importing is mandatory,
not advisory.** The tool still preserves UIDs exactly as found — it just doesn't pretend they mean
anything across downloads.

## Reuse

This generalises past MyRJ. Any Blackbaud onCampus school hits the identical bug, and
the same pattern applies to any `.ics` feed that omits `TRANSP` on all-day events.

---

Regis Jesuit High School · Educational Technology
