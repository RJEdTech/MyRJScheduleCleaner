/* Rotation reconstruction — the part-time case.

   MyRJ emits a day-type marker only on days you have something scheduled,
   so a part-timer's export is missing most of the rotation she does NOT
   teach: exactly the days she needs blocked. This suite builds a synthetic
   school year, hands the tool only the slice MyRJ would actually send, and
   asserts the tool rebuilds the rest to the day.

   Synthetic on purpose — the bug was found on a real teacher's export, and
   a real export doesn't belong in a public repo.

   node test/rotation.js                                                  */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const sandbox = { module: { exports: {} }, console };
sandbox.global = sandbox;
vm.createContext(sandbox);
vm.runInContext(/<script>([\s\S]*?)<\/script>/.exec(html)[1], sandbox, { filename: 'index.html' });
const app = sandbox.module.exports;

const STAMP = 'MyRJ Import 2026-09';
let pass = 0, fail = 0;
const rows = [];
const t = (n, e, a) => { const ok = String(e) === String(a); ok ? pass++ : fail++; rows.push([ok, n, e, a]); };

/* ---------- a synthetic school year ---------------------------------
   Weekdays alternate White/Red. Three interruptions, each of a kind the
   real calendar contains and each a different problem for the rebuild:
     - a one-day holiday      (marked, must not be rebuilt)
     - a multi-day break      (unmarked entirely — the winter-break shape)
     - an exam week           (marked, breaks the alternation legitimately)
   -------------------------------------------------------------------- */
const DAY = 86400000;
const ymd = ms => { const d = new Date(ms), m = d.getUTCMonth() + 1, x = d.getUTCDate();
  return '' + d.getUTCFullYear() + (m < 10 ? '0' : '') + m + (x < 10 ? '0' : '') + x; };

const HOLIDAY  = new Set(['20260907']);                                    // marked, single day
const EXAMS    = new Set(['20261215', '20261216', '20261217', '20261218']); // marked, non-rotation
const BREAK    = new Set();                                                 // unmarked, invisible
for (let d = Date.UTC(2026, 11, 21); d <= Date.UTC(2027, 0, 4); d += DAY) BREAK.add(ymd(d));

const year = [];   // every weekday, with the colour it really is
let colour = 'White Day';
for (let ms = Date.UTC(2026, 7, 19); ms <= Date.UTC(2027, 4, 28); ms += DAY) {
  const dow = new Date(ms).getUTCDay();
  if (dow === 0 || dow === 6) continue;
  const k = ymd(ms);
  if (HOLIDAY.has(k)) { year.push({ k, type: 'holiday' }); continue; }
  if (EXAMS.has(k))   { year.push({ k, type: 'exam'    }); continue; }
  if (BREAK.has(k))   { year.push({ k, type: 'break'   }); continue; }
  year.push({ k, type: 'rotation', colour });
  colour = colour === 'White Day' ? 'Red Day' : 'White Day';
}

const allRed   = year.filter(d => d.type === 'rotation' && d.colour === 'Red Day').map(d => d.k);
const allWhite = year.filter(d => d.type === 'rotation' && d.colour === 'White Day').map(d => d.k);

/* What MyRJ actually sends a White-day teacher: every White day (she
   teaches them all), the marked non-rotation days, and only those Red days
   that carry something else — an IMPACT day, a late start, a grading-period
   marker. Here, every fifth one. */
const sentRed = allRed.filter((_, i) => i % 5 === 0);

const ev = (k, summary, timed) => {
  const next = ymd(Date.UTC(+k.slice(0,4), +k.slice(4,6) - 1, +k.slice(6,8)) + DAY);
  return timed
    ? ['BEGIN:VEVENT', 'UID:t-' + k, 'DTSTAMP:20260901T000000Z',
       'DTSTART;TZID=America/Denver:' + k + 'T083000',
       'DTEND;TZID=America/Denver:' + k + 'T095000',
       'SUMMARY:' + summary, 'CATEGORIES:podium,events', 'END:VEVENT'].join('\r\n')
    : ['BEGIN:VEVENT', 'UID:a-' + k, 'DTSTAMP:20260901T000000Z',
       'DTSTART;VALUE=DATE:' + k, 'DTEND;VALUE=DATE:' + next,
       'SUMMARY:' + summary, 'CATEGORIES:podium,events', 'END:VEVENT'].join('\r\n');
};

const parts = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN'];
for (const d of year) {
  if (d.type === 'holiday') { parts.push(ev(d.k, 'Labor Day - SCHOOL CLOSED (RJHS)')); continue; }
  if (d.type === 'exam')    { parts.push(ev(d.k, '1W & 3W Semester Exams (RJHS)'));    continue; }
  if (d.type === 'break')   continue;                       // MyRJ sends nothing at all
  if (d.colour === 'White Day') {
    parts.push(ev(d.k, 'White Day (RJHS)'));
    parts.push(ev(d.k, 'Honors Spanish 3-GD - 1 (1W-3W)', true));
  } else if (sentRed.indexOf(d.k) !== -1) {
    parts.push(ev(d.k, 'Red Day - IMPACT Day (RJHS)'));
  }
}
parts.push('END:VCALENDAR');
const SRC = parts.join('\r\n') + '\r\n';

/* ==================================================================== */
const doc = app.parseIcs(SRC);
const PW  = app.buildCleaned(doc, 'free', STAMP, 'one', 'white');

const scan = text => {
  const out = []; let cur = null;
  for (const ln of text.split('\r\n')) {
    if (/^BEGIN:VEVENT$/.test(ln)) { cur = [ln]; continue; }
    if (cur) { cur.push(ln); if (/^END:VEVENT$/.test(ln)) { out.push(cur); cur = null; } }
  }
  return out;
};
const dateOf = b => (/DTSTART;VALUE=DATE:(\d{8})/.exec(b.join('\n')) || [])[1];
const blocked = new Set(scan(PW.text)
  .filter(b => b.includes('X-MICROSOFT-CDO-BUSYSTATUS:OOF') && dateOf(b))
  .map(dateOf));

console.log(`\n  synthetic year: ${allWhite.length} White, ${allRed.length} Red ` +
            `(${sentRed.length} of them in the feed), ${BREAK.size} break days, ` +
            `${EXAMS.size} exam days, ${HOLIDAY.size} holiday\n`);

t('every Red day in the year ends up blocked', allRed.length,
  allRed.filter(k => blocked.has(k)).length);
t('no White day is ever blocked', 0, allWhite.filter(k => blocked.has(k)).length);
t('no break day is invented', 0, [...BREAK].filter(k => blocked.has(k)).length);
t('exam days are left alone', 0, [...EXAMS].filter(k => blocked.has(k)).length);
t('the marked holiday blocks (closed-day rule, not the rebuild)', 1,
  [...HOLIDAY].filter(k => blocked.has(k)).length);
/* +1: the rebuild reaches exactly one weekday back before the first day the
   feed knows about, because a part-timer's file starts on her first class and
   the first day of school can precede it. That boundary day is the one place
   the tool blocks a day it cannot prove is a school day — deliberate, since
   the alternative is leaving the first day of the year showing her free. */
t('rebuilt count == Red days omitted, plus the boundary day',
  allRed.length - sentRed.length + 1, PW.offAdded);
t('the rebuild reaches back exactly one weekday, never more', 1,
  [...blocked].filter(k => k < allWhite[0]).length);
t('the file reports no rotation irregularity', 0, PW.rotBroken);
t('rebuilt events are all-day', 0,
  scan(PW.text).filter(b => b.some(l => /^UID:myrj-off-/.test(l)))
               .filter(b => !/DTSTART;VALUE=DATE:/.test(b.join('\n'))).length);
t('rebuilt events carry the import labels for deletion', PW.offAdded,
  scan(PW.text).filter(b => b.some(l => /^UID:myrj-off-/.test(l)))
               .filter(b => b.some(l => l.indexOf(STAMP) !== -1)).length);
t('running it again rebuilds nothing new', 0,
  app.buildCleaned(app.parseIcs(PW.text), 'free', STAMP, 'one', 'white').offAdded);
t('running it again is byte-identical', true,
  app.buildCleaned(app.parseIcs(PW.text), 'free', STAMP, 'one', 'white').text === PW.text);
t('CRLF throughout', true, PW.text.split('\r\n').join('').indexOf('\n') === -1);
t('no line over 75 octets', 0,
  PW.text.split('\r\n').filter(l => Buffer.byteLength(l, 'utf8') > 75).length);
t('BEGIN:VEVENT == END:VEVENT', (PW.text.match(/^BEGIN:VEVENT/gm) || []).length,
  (PW.text.match(/^END:VEVENT/gm) || []).length);
t('ends with END:VCALENDAR', true, /END:VCALENDAR\r\n$/.test(PW.text));
t('a full-timer gets nothing rebuilt', 0,
  app.buildCleaned(doc, 'free', STAMP, 'one', 'both').offAdded);
t('strip mode still rebuilds the blocked days', PW.offAdded,
  app.buildCleaned(doc, 'strip', STAMP, 'one', 'white').offAdded);

/* The colour hidden mid-title — the difference between 78/82 and 82/82 on
   the real export. */
t('a rotation day named mid-title is recognised', 'Red Day',
  app.dayLabel('2RW Semester Exam & Red Day Review Classes (RJHS)'));
t('a plain exam day is still not a rotation day', 'School Calendar',
  app.dayLabel('3R & 4R Semester Exams (RJHS)'));

/* An irregular part-timer — two White days a week, not all of them. The
   rebuild must decline rather than invent days. */
const irregular = ['BEGIN:VCALENDAR', 'VERSION:2.0'];
let flip = 0;
for (const d of year) {
  if (d.type !== 'rotation') continue;
  if (d.colour === 'Red Day') continue;                 // MyRJ sends her no Red days
  if (flip++ % 3 === 0) continue;                       // and she skips one White in three
  irregular.push(ev(d.k, 'White Day (RJHS)'));
}
irregular.push('END:VCALENDAR');
const IRR = app.buildCleaned(app.parseIcs(irregular.join('\r\n') + '\r\n'), 'free', STAMP, 'one', 'white');
t('an irregular pattern is detected', true, IRR.rotBroken > 0);
t('an irregular pattern rebuilds nothing', 0, IRR.offAdded);

const w = Math.max(...rows.map(r => r[1].length));
for (const [ok, n, e, a] of rows)
  console.log(`   ${ok ? ' ok ' : ' XX '} ${n.padEnd(w)}  ${e}${ok ? '' : '   ->  GOT ' + a}`);
console.log(`\n   ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
