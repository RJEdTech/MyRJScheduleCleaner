/* Generic verifier — runs the SHIPPED transform against any MyRJ export and
   derives every expectation from an independent scan of that file, so it
   works on a 288-event Schedule feed or a 1,700-event School Calendars feed.

   node test/verify.js "<file.ics>" ["<another.ics>" ...]                    */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = path.join(__dirname, '..', 'index.html');
const files = process.argv.slice(2);
if (!files.length) { console.error('usage: node test/verify.js <file.ics> [...]'); process.exit(2); }

/* ---- load the real shipped code ---- */
const html = fs.readFileSync(HTML, 'utf8');
const sandbox = { module: { exports: {} }, console };
sandbox.global = sandbox;
vm.createContext(sandbox);
vm.runInContext(/<script>([\s\S]*?)<\/script>/.exec(html)[1], sandbox, { filename: 'index.html' });
const app = sandbox.module.exports;

/* Fixed stamp so runs are reproducible (the page uses the current month). */
const STAMP = 'MyRJ Import 2026-08';
/* Labels are PREPENDED to CATEGORIES (the first one drives the colour in
   Outlook), so stripping them removes a leading run, not a trailing one. */
const destamp = t => t.replace(
  /^CATEGORIES:(?:(?!MyRJ Import)[^,\r\n]+,)*?(?:MyRJ Import,)?(?:MyRJ Import \d{4}-\d{2},)?/gm,
  'CATEGORIES:');

/* ---- independent scan (does not use the tool's own parser) ---- */
function scan(text) {
  const lines = text.replace(/^﻿/, '').split(/\r\n|\n|\r/);
  const blocks = []; let cur = null;
  for (const ln of lines) {
    if (/^BEGIN:VEVENT\s*$/i.test(ln)) { cur = [ln]; continue; }
    if (cur) { cur.push(ln); if (/^END:VEVENT\s*$/i.test(ln)) { blocks.push(cur); cur = null; } }
  }
  return blocks;
}
const isAllDay = b => b.some(l => /^DTSTART[^:]*;VALUE=DATE(?!-TIME)/i.test(l) ||
                                  /^DTSTART[^:]*VALUE=DATE(?!-TIME)/i.test(l));
const uids = t => (t.match(/^UID:.*$/gm) || []);
const octets = t => Math.max(...t.split('\r\n').map(l => Buffer.byteLength(l, 'utf8')));
const crlfOnly = t => { const s = t.split('\r\n').join(''); return !s.includes('\n') && !s.includes('\r'); };
const foldedCount = t => t.split('\r\n').filter(l => /^[ \t]/.test(l)).length;
const propCount = (t, p) => (t.match(new RegExp('^' + p + '[;:]', 'gmi')) || []).length;
/* Re-folding a long CATEGORIES line legitimately adds continuation lines, so
   the "folding preserved" check has to discount the ones the tool wrote. */
const extraFolds = t => t.split('\r\n').filter((l, i, a) =>
  /^[ \t]/.test(l) && /^CATEGORIES[;:]/i.test((a.slice(0, i).reverse().find(x => !/^[ \t]/.test(x)) || ''))).length;

let totalPass = 0, totalFail = 0;

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const rows = [];
  const t = (n, e, a) => { const ok = String(e) === String(a); ok ? totalPass++ : totalFail++;
                           rows.push([ok, n, String(e), String(a)]); };

  const srcBlocks = scan(src);
  const srcAll = srcBlocks.filter(isAllDay);
  const srcTim = srcBlocks.filter(b => !isAllDay(b));
  const nAll = srcAll.length, nTim = srcTim.length;
  const summOf = b => { const l = b.find(x => /^SUMMARY[;:]/i.test(x)); return l ? l.slice(l.indexOf(':') + 1) : ''; };
  const isClosed = b => app.isClosedDay(summOf(b));
  const srcClosed = srcAll.filter(isClosed), srcOpen = srcAll.filter(b => !isClosed(b));
  const nClosed = srcClosed.length, nOpen = srcOpen.length;

  const doc = app.parseIcs(src);
  const A = app.buildCleaned(doc, 'free', STAMP);
  const B = app.buildCleaned(doc, 'strip', STAMP);
  const aBlocks = scan(A.text);
  const aAll = aBlocks.filter(isAllDay), aTim = aBlocks.filter(b => !isAllDay(b));

  /* parse fidelity */
  t('events parsed matches independent scan', srcBlocks.length, doc.events.length);
  t('all-day / timed split matches independent scan',
    nAll + '/' + nTim, doc.events.filter(e => e.allDay).length + '/' + doc.events.filter(e => !e.allDay).length);
  t('file not misdetected as truncated', false, doc.truncated);

  /* mode A — open day markers go free/transparent; School Closed / break days
     go Out of Office (OPAQUE) so the whole day blocks. */
  const aOpen = aAll.filter(b => !isClosed(b)), aClosed = aAll.filter(isClosed);
  t('A: TRANSP:TRANSPARENT on every OPEN all-day event', nOpen, aOpen.filter(b => b.includes('TRANSP:TRANSPARENT')).length);
  t('A: CDO FREE on every OPEN all-day event', nOpen, aOpen.filter(b => b.includes('X-MICROSOFT-CDO-BUSYSTATUS:FREE')).length);
  t('A: TRANSP:OPAQUE on every CLOSED (school-closed/break) day', nClosed, aClosed.filter(b => b.includes('TRANSP:OPAQUE')).length);
  t('A: CDO OOF on every CLOSED day', nClosed, aClosed.filter(b => b.includes('X-MICROSOFT-CDO-BUSYSTATUS:OOF')).length);
  t('A: no closed day left transparent/free', 0,
    aClosed.filter(b => b.includes('TRANSP:TRANSPARENT') || b.includes('X-MICROSOFT-CDO-BUSYSTATUS:FREE')).length);
  t('A: no TRANSP leaked onto a timed event', 0, aTim.filter(b => b.some(l => /^TRANSP:/i.test(l))).length);
  t('A: timed events unchanged apart from the stamp', 0,
    srcTim.filter((b, i) => b.join('\n') !== destamp((aTim[i] || []).join('\n'))).length);
  t('A: all-day events changed ONLY by the busy/free lines + stamp', 0,
    srcAll.filter((b, i) => b.join('\n') !== destamp(
      (aAll[i] || []).filter(l => !/^(TRANSP:(TRANSPARENT|OPAQUE)|X-MICROSOFT-CDO-(BUSYSTATUS|INTENDEDSTATUS):(FREE|OOF))$/.test(l)).join('\n'))).length);
  t('A: reported free/changed count = open all-day', nOpen, A.changed);
  t('A: reported closedBlocked count = closed all-day', nClosed, A.closedBlocked);
  t('A: reported timedKept count', nTim, A.timedKept);

  /* structural integrity */
  t('A: BEGIN:VEVENT == END:VEVENT', (A.text.match(/^BEGIN:VEVENT/gm) || []).length,
    (A.text.match(/^END:VEVENT/gm) || []).length);
  t('A: VTIMEZONE count preserved', (src.match(/^BEGIN:VTIMEZONE/gm) || []).length,
    (A.text.match(/^BEGIN:VTIMEZONE/gm) || []).length);
  t('A: header before first VEVENT byte-identical', true,
    src.split('BEGIN:VEVENT')[0].replace(/\r\n|\n|\r/g, '\n') ===
    A.text.split('BEGIN:VEVENT')[0].replace(/\r\n|\n|\r/g, '\n'));
  t('A: UIDs preserved exactly and in order', true, uids(src).join('|') === uids(A.text).join('|'));
  t('A: UIDs unique', uids(A.text).length, new Set(uids(A.text)).size);
  t('A: CRLF throughout', true, crlfOnly(A.text));
  t('A: ends with END:VCALENDAR + one CRLF', true, /END:VCALENDAR\r\n$/.test(A.text));

  /* folding — the reason a big feed is a real test */
  t('A: folded continuation lines preserved', foldedCount(src.replace(/\r\n|\n|\r/g, '\r\n')), foldedCount(A.text));
  t('A: no inserted line lands on a fold boundary', 0,
    A.text.split('\r\n').filter((l, i, a) =>
      /^(TRANSP:(TRANSPARENT|OPAQUE)|X-MICROSOFT-CDO-(BUSYSTATUS|INTENDEDSTATUS):(FREE|OOF))$/.test(l) && /^[ \t]/.test(a[i + 1] || '')).length);
  t('A: LOCATION count preserved', propCount(src, 'LOCATION'), propCount(A.text, 'LOCATION'));
  t('A: DESCRIPTION count preserved', propCount(src, 'DESCRIPTION'), propCount(A.text, 'DESCRIPTION'));
  t('A: SUMMARY count preserved', propCount(src, 'SUMMARY'), propCount(A.text, 'SUMMARY'));
  t('A: longest line <= 75 octets', true, octets(A.text) <= 75);

  /* idempotency */
  const A2 = app.buildCleaned(app.parseIcs(A.text), 'free', STAMP);
  const A3 = app.buildCleaned(app.parseIcs(A2.text), 'free', STAMP);
  t('A: second run byte-identical', true, A2.text === A.text);
  t('A: third run byte-identical', true, A3.text === A.text);
  t('A: no duplicated TRANSP after re-run', 0,
    scan(A2.text).filter(b => b.filter(l => /^TRANSP:/i.test(l)).length > 1).length);

  /* mode B — strip the ordinary day markers, but KEEP the school-closed/break
     days (blocked as OOF): blocking your day off is their whole purpose. */
  const bBlocks = scan(B.text);
  const bAll = bBlocks.filter(isAllDay);
  t('B: remaining event count (timed + closed days kept)', nTim + nClosed, bBlocks.length);
  t('B: only closed days remain among all-day', nClosed, bAll.length);
  t('B: every remaining all-day event is a closed day', nClosed, bAll.filter(isClosed).length);
  t('B: remaining closed days are OOF/OPAQUE', nClosed,
    bAll.filter(b => b.includes('TRANSP:OPAQUE') && b.includes('X-MICROSOFT-CDO-BUSYSTATUS:OOF')).length);
  t('B: timed survivors unchanged apart from the stamp', true,
    destamp(bBlocks.filter(b => !isAllDay(b)).map(b => b.join('\n')).join('|')) === srcTim.map(b => b.join('\n')).join('|'));
  t('B: reported removed count = open all-day', nOpen, B.removed);
  t('B: reported closedBlocked count', nClosed, B.closedBlocked);
  t('B: CRLF throughout', true, crlfOnly(B.text));
  t('B: idempotent', true, app.buildCleaned(app.parseIcs(B.text), 'strip', STAMP).text === B.text);

  /* ---- part-time: "only here on the days I teach" ---- */
  const isRed   = b => app.dayLabel(summOf(b)) === 'Red Day';
  const isWhite = b => app.dayLabel(summOf(b)) === 'White Day';
  const srcRed   = srcAll.filter(b => !isClosed(b) && isRed(b)).length;
  const srcWhite = srcAll.filter(b => !isClosed(b) && isWhite(b)).length;
  const PW = app.buildCleaned(doc, 'free', STAMP, 'one', 'white');   // teaches White => block Red
  const pwAll = scan(PW.text).filter(isAllDay);
  t('PT(white): offBlocked == source Red days', srcRed, PW.offBlocked);
  t('PT(white): every Red day is Out of Office', srcRed,
    pwAll.filter(b => isRed(b) && b.includes('X-MICROSOFT-CDO-BUSYSTATUS:OOF')).length);
  t('PT(white): White days stay free', srcWhite,
    pwAll.filter(b => isWhite(b) && b.includes('X-MICROSOFT-CDO-BUSYSTATUS:FREE')).length);
  t('PT(white): school-closed days still blocked', nClosed,
    pwAll.filter(isClosed).filter(b => b.includes('X-MICROSOFT-CDO-BUSYSTATUS:OOF')).length);
  t('PT(white): timed events unchanged apart from the stamp', 0,
    srcTim.filter((b,i) => b.join('\n') !== destamp((scan(PW.text).filter(x=>!isAllDay(x))[i]||[]).join('\n'))).length);
  t('PT(white): idempotent', true,
    app.buildCleaned(app.parseIcs(PW.text),'free',STAMP,'one','white').text === PW.text);
  const PR = app.buildCleaned(doc, 'free', STAMP, 'one', 'red');     // teaches Red => block White
  t('PT(red): offBlocked == source White days', srcWhite, PR.offBlocked);
  t('PT(both/default): no off-days blocked', 0, app.buildCleaned(doc,'free',STAMP,'one','both').offBlocked);

  /* ---- import stamp ---- */
  const stamped = (A.text.match(new RegExp('^CATEGORIES:MyRJ Import,' + STAMP + '(,|$)', 'gm')) || []).length;
  t('stamp: dated label on every event exactly once', srcBlocks.length, stamped);
  t('stamp: stable label first on every event', srcBlocks.length,
    (A.text.match(/^CATEGORIES:MyRJ Import,/gm) || []).length);
  t('stamp: exactly one CATEGORIES property per event', 0,
    scan(A.text).filter(b => b.filter(l => /^CATEGORIES[;:]/i.test(l)).length !== 1).length);
  t('stamp: no event carries it twice', 0,
    scan(A.text).filter(b => b.filter(l => l.indexOf(STAMP) !== -1).length > 1).length);
  t('stamp: SUMMARY (event title) untouched', true,
    (src.match(/^SUMMARY:.*$/gm) || []).join('|') === (A.text.match(/^SUMMARY:.*$/gm) || []).join('|'));
  t('stamp: original categories preserved alongside', srcBlocks.length,
    (A.text.match(/,podium,events$/gm) || []).length);
  t('stamp: stamped lines still <= 75 octets', true, octets(A.text) <= 75);
  const NEXT = app.buildCleaned(app.parseIcs(A.text), 'free', 'MyRJ Import 2027-01').text;
  t('stamp: re-running next semester replaces, never accumulates', srcBlocks.length,
    (NEXT.match(/^CATEGORIES:MyRJ Import,MyRJ Import 2027-01,/gm) || []).length);
  t('stamp: the stable label is never duplicated by a re-run', 0,
    (NEXT.match(/MyRJ Import,MyRJ Import,/gm) || []).length);

  /* ---- per-class labels ---- */
  const C = app.buildCleaned(doc, 'free', STAMP, 'class');
  t('class: every event carries a leading class/day label', srcBlocks.length,
    (C.text.match(/^CATEGORIES:(?!MyRJ Import)[^,\r\n]+,MyRJ Import,MyRJ Import \d{4}-\d{2}/gm) || []).length);
  t('class: import labels survive alongside the class label', srcBlocks.length,
    (C.text.match(/,MyRJ Import,MyRJ Import \d{4}-\d{2}/gm) || []).length);
  t('class: exactly one CATEGORIES property per event', 0,
    scan(C.text).filter(b => b.filter(l => /^CATEGORIES[;:]/i.test(l)).length !== 1).length);
  t('class: still within 75 octets', true, octets(C.text) <= 75);
  t('class: label counts sum to the event total', srcBlocks.length,
    (C.labels || []).reduce((n, l) => n + l.count, 0));
  t('class: idempotent', true,
    app.buildCleaned(app.parseIcs(C.text), 'free', STAMP, 'class').text === C.text);
  t('class: SUMMARY untouched', true,
    (src.match(/^SUMMARY:.*$/gm) || []).join('|') === (C.text.match(/^SUMMARY:.*$/gm) || []).join('|'));
  t('class: UIDs preserved exactly', true, uids(src).join('|') === uids(C.text).join('|'));
  t('class: folded continuation lines preserved',
    foldedCount(src.replace(/\r\n|\n|\r/g, '\r\n')) , foldedCount(C.text) - extraFolds(C.text));
  t('stamp: opting out leaves categories exactly as found', 0,
    (app.buildCleaned(doc, 'free', null).text.match(/MyRJ Import/g) || []).length);

  /* line-ending robustness */
  t('LF-only input yields identical output', true,
    app.buildCleaned(app.parseIcs(src.replace(/\r\n/g, '\n')), 'free', STAMP).text === A.text);
  t('BOM-prefixed input yields identical output', true,
    app.buildCleaned(app.parseIcs('﻿' + src), 'free', STAMP).text === A.text);

  const w = Math.max(...rows.map(r => r[1].length));
  const f = rows.filter(r => !r[0]).length;
  console.log(`\n  ${path.basename(file)}  —  ${(fs.statSync(file).size / 1024).toFixed(0)}KB, ` +
              `${srcBlocks.length} events (${nAll} all-day / ${nTim} timed), ` +
              `${foldedCount(src)} folded lines`);
  for (const [ok, n, e, a] of rows)
    console.log(`   ${ok ? ' ok ' : ' XX '} ${n.padEnd(w)}  ${e}${ok ? '' : '   ->  GOT ' + a}`);
  console.log(`   ${rows.length - f} passed, ${f} failed`);
}

console.log(`\n  TOTAL: ${totalPass} passed, ${totalFail} failed\n`);
process.exit(totalFail ? 1 : 0);
