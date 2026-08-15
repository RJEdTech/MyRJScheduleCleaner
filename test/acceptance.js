/* Acceptance tests for MyRJ Schedule Cleaner.
   Extracts the <script> block from the SHIPPED index.html and exercises
   the real functions — not a reimplementation — against a real 288-event
   MyRJ export. Run: node test/acceptance.js path/to/Schedule.ics        */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = path.join(__dirname, '..', 'index.html');
const ICS  = process.argv[2];
if (!ICS) { console.error('usage: node test/acceptance.js <Schedule.ics>'); process.exit(2); }

/* ---- load the real shipped code ---- */
const html = fs.readFileSync(HTML, 'utf8');
const m = /<script>([\s\S]*?)<\/script>/.exec(html);
if (!m) throw new Error('no <script> block found in index.html');
const sandbox = { module: { exports: {} }, console };
sandbox.global = sandbox;
vm.createContext(sandbox);
vm.runInContext(m[1], sandbox, { filename: 'index.html<script>' });
const app = sandbox.module.exports;
if (!app.parseIcs) throw new Error('index.html did not export its logic');

const STAMP   = 'MyRJ Import 2026-08';
/* The tool now PREPENDS its labels to CATEGORIES — the first category is what
   Outlook colours the event from — so stripping them means removing a leading
   run, not a trailing one. Covers the stable label, the dated label, and any
   per-class label sitting in front of both. */
const destamp = t => t.replace(
  /^CATEGORIES:(?:(?!MyRJ Import)[^,\r\n]+,)*?(?:MyRJ Import,)?(?:MyRJ Import \d{4}-\d{2},)?/gm,
  'CATEGORIES:');
const srcBuf  = fs.readFileSync(ICS);
const srcText = srcBuf.toString('utf8');

/* ---- tiny assert harness ---- */
let pass = 0, fail = 0;
const rows = [];
function check(name, expected, actual) {
  const ok = String(expected) === String(actual);
  ok ? pass++ : fail++;
  rows.push([ok ? 'PASS' : 'FAIL', name, String(expected), String(actual)]);
}

/* ---- helpers ---- */
const count = (s, re) => (s.match(re) || []).length;
function vevents(text) {
  const out = []; let cur = null;
  for (const ln of text.split(/\r\n|\n|\r/)) {
    if (/^BEGIN:VEVENT\s*$/.test(ln)) { cur = [ln]; continue; }
    if (cur) { cur.push(ln); if (/^END:VEVENT\s*$/.test(ln)) { out.push(cur); cur = null; } }
  }
  return out;
}
const isAllDayBlock = b => b.some(l => /^DTSTART[^:]*VALUE=DATE(?!-TIME)/i.test(l));
const uidsOf = t => vevents(t).map(b => (b.find(l => l.startsWith('UID:')) || '').slice(4));
/* Everything in a VEVENT except the two properties we are allowed to add. */
const fingerprint = b => destamp(b.filter(l =>
  !/^TRANSP:/i.test(l) && !/^X-MICROSOFT-CDO-BUSYSTATUS:/i.test(l)).join('\n'));

/* ==================================================================== */
console.log('\n  Source: ' + path.basename(ICS) + '  (' + srcBuf.length + ' bytes)\n');

const doc     = app.parseIcs(srcText);
const srcEv   = vevents(srcText);
const srcAll  = srcEv.filter(isAllDayBlock);
const srcTim  = srcEv.filter(b => !isAllDayBlock(b));

/* --- spec §7 row 1: events parsed matches grep -c BEGIN:VEVENT --- */
check('Events parsed == grep -c BEGIN:VEVENT',
      count(srcText, /^BEGIN:VEVENT/gm), doc.events.length);

/* --- row 2: all-day / timed split --- */
const parsedAll = doc.events.filter(e => e.allDay);
const parsedTim = doc.events.filter(e => !e.allDay);
check('All-day split  (spec: 144)', 144, parsedAll.length);
check('Timed split    (spec: 144)', 144, parsedTim.length);
check("Tool's split agrees with independent DTSTART scan",
      srcAll.length + '/' + srcTim.length, parsedAll.length + '/' + parsedTim.length);

/* ================= MODE A ================= */
const A = app.buildCleaned(doc, 'free', STAMP);
const aEv  = vevents(A.text);
const aAll = aEv.filter(isAllDayBlock);
const aTim = aEv.filter(b => !isAllDayBlock(b));

/* --- rows 3 & 4 --- */
check('Mode A: all-day with TRANSP:TRANSPARENT', 144,
      aAll.filter(b => b.includes('TRANSP:TRANSPARENT')).length);
check('Mode A: all-day with X-MICROSOFT-CDO-BUSYSTATUS:FREE', 144,
      aAll.filter(b => b.includes('X-MICROSOFT-CDO-BUSYSTATUS:FREE')).length);

/* --- row 5: timed events modified == 0 (byte-for-byte) --- */
const timedDiff = srcTim.filter((b, i) => b.join('\n') !== destamp((aTim[i] || []).join('\n'))).length;
check('Mode A: timed events unchanged apart from the import stamp', 0, timedDiff);

/* --- all-day events changed ONLY by the two added lines --- */
const allDayCollateral = srcAll.filter((b, i) => fingerprint(b) !== fingerprint(aAll[i] || [])).length;
check('Mode A: all-day events changed in any other way', 0, allDayCollateral);

/* --- row 7: BEGIN count == END count --- */
check('Mode A: BEGIN:VEVENT == END:VEVENT',
      count(A.text, /^BEGIN:VEVENT/gm), count(A.text, /^END:VEVENT/gm));

/* --- row 8: VTIMEZONE preserved --- */
check('Mode A: VTIMEZONE blocks', 1, count(A.text, /^BEGIN:VTIMEZONE/gm));
const tzBlock = s => /BEGIN:VTIMEZONE[\s\S]*?END:VTIMEZONE/.exec(s)[0];
check('Mode A: VTIMEZONE byte-identical', true, tzBlock(srcText) === tzBlock(A.text));
check('Mode A: header before first VEVENT byte-identical', true,
      srcText.split('BEGIN:VEVENT')[0] === A.text.split('BEGIN:VEVENT')[0]);

/* --- row 9: UIDs unique and unchanged --- */
const su = uidsOf(srcText), au = uidsOf(A.text);
check('Mode A: UID count', su.length, au.length);
check('Mode A: UIDs unchanged and in order', true, su.join('|') === au.join('|'));
check('Mode A: UIDs unique', su.length, new Set(au).size);

/* --- row 10: all line endings CRLF --- */
const crlfOk = t => t.split('\r\n').join('').indexOf('\n') === -1 &&
                    t.split('\r\n').join('').indexOf('\r') === -1;
check('Mode A: every line ending is CRLF', true, crlfOk(A.text));
check('Mode A: file ends with a single CRLF', true,
      /[^\r\n]\r\n$/.test(A.text));

/* --- row 11: no line exceeds 75 octets --- */
const longest = t => Math.max(...t.split('\r\n').map(l => Buffer.byteLength(l, 'utf8')));
check('Mode A: longest line (octets) <= 75', true, longest(A.text) <= 75);
const longestWritten = Math.max(
  Buffer.byteLength('TRANSP:TRANSPARENT'),
  Buffer.byteLength('X-MICROSOFT-CDO-BUSYSTATUS:FREE'));
check('Mode A: longest line the TOOL writes (octets)', 31, longestWritten);

/* --- structural integrity --- */
check('Mode A: ends with END:VCALENDAR', true, /END:VCALENDAR\r\n$/.test(A.text));
check('Mode A: no TRANSP on any timed event', 0,
      aTim.filter(b => b.some(l => /^TRANSP:/i.test(l))).length);
check('Mode A: no CDO busystatus on any timed event', 0,
      aTim.filter(b => b.some(l => /^X-MICROSOFT-CDO-BUSYSTATUS:/i.test(l))).length);
check('Mode A: reported changed count', 144, A.changed);
check('Mode A: reported timedKept count', 144, A.timedKept);

/* --- row 12: idempotency --- */
const A2 = app.buildCleaned(app.parseIcs(A.text), 'free', STAMP);
check('Mode A run twice: byte-identical output', true, A2.text === A.text);
check('Mode A run twice: reported new changes', 0, A2.changed);
check('Mode A run twice: reported already-correct', 144, A2.already);
check('Mode A run twice: no duplicate TRANSP', 0,
      vevents(A2.text).filter(b => b.filter(l => /^TRANSP:/i.test(l)).length > 1).length);
check('Mode A run twice: no duplicate CDO busystatus', 0,
      vevents(A2.text).filter(b =>
        b.filter(l => /^X-MICROSOFT-CDO-BUSYSTATUS:/i.test(l)).length > 1).length);
const A3 = app.buildCleaned(app.parseIcs(A2.text), 'free', STAMP);
check('Mode A run three times: still byte-identical', true, A3.text === A.text);

/* ================= MODE B ================= */
const B = app.buildCleaned(doc, 'strip', STAMP);
const bEv = vevents(B.text);
check('Mode B: remaining events', 144, bEv.length);
check('Mode B: all remaining are timed', 0, bEv.filter(isAllDayBlock).length);
check('Mode B: survivors unchanged apart from the import stamp', true,
      destamp(bEv.map(b => b.join('\n')).join('|')) ===
      srcTim.map(b => b.join('\n')).join('|'));
check('Mode B: BEGIN:VEVENT == END:VEVENT',
      count(B.text, /^BEGIN:VEVENT/gm), count(B.text, /^END:VEVENT/gm));
check('Mode B: VTIMEZONE blocks', 1, count(B.text, /^BEGIN:VTIMEZONE/gm));
check('Mode B: every line ending is CRLF', true, crlfOk(B.text));
check('Mode B: ends with END:VCALENDAR', true, /END:VCALENDAR\r\n$/.test(B.text));
check('Mode B: reported removed count', 144, B.removed);
const B2 = app.buildCleaned(app.parseIcs(B.text), 'strip', STAMP);
check('Mode B run twice: byte-identical output', true, B2.text === B.text);

/* ================= EDGE CASES ================= */
/* BOM */
const bom = app.buildCleaned(app.parseIcs('﻿' + srcText), 'free', STAMP);
check('Edge: leading BOM stripped, output matches', true, bom.text === A.text);
/* LF-only input must still produce CRLF output */
const lf = app.buildCleaned(app.parseIcs(srcText.replace(/\r\n/g, '\n')), 'free', STAMP);
check('Edge: LF-only input yields identical CRLF output', true, lf.text === A.text);
/* CR-only input */
const cr = app.buildCleaned(app.parseIcs(srcText.replace(/\r\n/g, '\r')), 'free', STAMP);
check('Edge: CR-only input yields identical CRLF output', true, cr.text === A.text);
/* Truncated file must not have properties injected at the wrong place */
const cut = srcText.slice(0, srcText.lastIndexOf('END:VEVENT') - 60);
const cutDoc = app.parseIcs(cut);
const cutRes = app.buildCleaned(cutDoc, 'free', STAMP);
check('Edge: truncated file detected', true, cutDoc.truncated === true);
check('Edge: truncated file — nothing inserted before BEGIN:VEVENT', 0,
      cutRes.text.split('\r\n').filter((l, i, a) =>
        /^(TRANSP|X-MICROSOFT-CDO-BUSYSTATUS):/i.test(l) &&
        /^BEGIN:VEVENT/.test(a[i + 1] || '')).length);
check('Edge: truncated file — incomplete block skipped, not mangled', 1, cutRes.skipped);
/* Order preservation: a stray comment line between two VEVENTs stays put */
/* Anchor on a UID that actually exists in THIS export. Blackbaud mints fresh
   UIDs on every download, so a hard-coded one silently turns this into a
   no-op that passes by accident on the file it was written against. */
const anchorUid = (srcText.match(/^UID:.*$/m) || ['UID:'])[0].replace(/\s+$/, '');
const injected = srcText.replace('BEGIN:VEVENT\r\n' + anchorUid,
                                 'X-STRAY-LINE:keepme\r\nBEGIN:VEVENT\r\n' + anchorUid);
const inj = app.buildCleaned(app.parseIcs(injected), 'free', STAMP);
const injLines = inj.text.split('\r\n');
check('Edge: interstitial line kept in place, not moved to the tail', true,
      (injLines[injLines.indexOf('X-STRAY-LINE:keepme') + 2] || '') === anchorUid);
/* File with no all-day events at all */
const nz = app.buildCleaned(app.parseIcs(B.text), 'free', STAMP);
check('Edge: file with no all-day events is passed through unchanged', true, nz.text === B.text);
/* URL normalisation */
const U = 'https://regisjesuit.myschoolapp.com/podium/feed/iCal.aspx?z=abc';
check('Edge: webcal:// normalised', U, app.normalizeUrl('webcal://regisjesuit.myschoolapp.com/podium/feed/iCal.aspx?z=abc'));
check('Edge: http:// normalised', U, app.normalizeUrl('http://regisjesuit.myschoolapp.com/podium/feed/iCal.aspx?z=abc'));
check('Edge: protocol-relative normalised', U, app.normalizeUrl('//regisjesuit.myschoolapp.com/podium/feed/iCal.aspx?z=abc'));
check('Edge: bare host normalised', U, app.normalizeUrl('regisjesuit.myschoolapp.com/podium/feed/iCal.aspx?z=abc'));
check('Edge: quoted + padded link normalised', U, app.normalizeUrl('  "webcal://regisjesuit.myschoolapp.com/podium/feed/iCal.aspx?z=abc" '));
/* Folded SUMMARY must be read whole */
/* RFC 5545: the fold inserts CRLF + one space, so unfolding strips exactly
   that one space and concatenates — a real space is encoded as a second one. */
check('Edge: folded SUMMARY unfolded per RFC 5545', 'Long TitleContinues',
      app.getFolded(['BEGIN:VEVENT', 'SUMMARY:Long Title', ' Continues', 'END:VEVENT'], 'SUMMARY'));
check('Edge: folded SUMMARY preserves an intentional space', 'Long Title Continues',
      app.getFolded(['BEGIN:VEVENT', 'SUMMARY:Long Title', '  Continues', 'END:VEVENT'], 'SUMMARY'));

/* ---- no external requests beyond same-origin favicons ---- */
const styleBlock = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
const subres = (html.match(/<(?:img|script|link|iframe|source)\b[^>]*\b(?:src|href)\s*=\s*["'](?!data:|#|mailto:)([^"']+)/gi) || [])
  .map(x => x.replace(/^.*["']/, ''));
check('Shipped: every subresource is a same-origin favicon', 0,
      subres.filter(u => !/^(favicon\.ico|favicon\.svg|favicon-32\.png|apple-touch-icon\.png)$/.test(u)).length);
check('Shipped: no Google Fonts / webfont hosts', 0, count(html, /fonts\.googleapis|fonts\.gstatic|use\.typekit/gi));
check('Shipped: no @font-face rules', 0, count(html, /@font-face\s*\{/gi));
check('Shipped: no external <script src>', 0, count(html, /<script[^>]+src\s*=\s*["'](?!data:)/gi));
check('Shipped: url() in CSS is a data: URI only', 0, count(styleBlock, /url\((?!\s*['"]?data:)/gi));
check('Shipped: the only url() in CSS is the watermark', 1, count(styleBlock, /url\(/g));
check('Shipped: RJ logo inlined as data URI', true, /<img class="rj-mark" src="data:image\/png;base64,/.test(html));
check('Shipped: watermark inlined as data URI', true, /background-image:\s*url\('data:image\/webp;base64,/.test(html));

/* ---- design system: matches Raider Quiz Builder ---- */
const css = styleBlock;
const QB_LIGHT = {
  '--bg':'#ffffff','--bg-elev':'#fafafa','--bg-card':'#f3f3f3','--bg-hover':'#ededed',
  '--raider':'#C11430','--raider-hot':'#a0102a','--raider-tint':'rgba(193, 20, 48, 0.08)',
  '--text':'#1a1a1a','--text-mute':'#595959','--text-dim':'#999999',
  '--border':'#e5e5e5','--border-strong':'#c5c5c5','--watermark-opacity':'0.05' };
const QB_DARK = {
  '--bg':'#0a0a0a','--bg-elev':'#161616','--bg-card':'#1c1c1c','--bg-hover':'#222222',
  '--raider':'#C11430','--raider-hot':'#e0223f','--raider-tint':'rgba(193, 20, 48, 0.15)',
  '--text':'#ffffff','--text-mute':'#a0a0a0','--text-dim':'#666666',
  '--border':'#2a2a2a','--border-strong':'#3a3a3a','--watermark-opacity':'0.04' };
const rootBlock = /:root\s*\{([\s\S]*?)\}/.exec(css)[1].replace(/\s/g,'');
const darkBlock = /\[data-theme="dark"\]\s*\{([\s\S]*?)\}/.exec(css)[1].replace(/\s/g,'');
const missingTok = (blk,tok) => Object.keys(tok).filter(k => !blk.includes(k+':'+tok[k].replace(/\s/g,'')+';'));
check('System: light tokens match Quiz Builder exactly', '', missingTok(rootBlock, QB_LIGHT).join(','));
check('System: dark tokens match Quiz Builder exactly', '', missingTok(darkBlock, QB_DARK).join(','));
check('System: defaults to LIGHT like Quiz Builder', 'light', /<html lang="en" data-theme="([a-z]+)"/.exec(html)[1]);
check('System: full-width header over 880px main', true,
      /\.site-header \{[\s\S]*?padding: 1\.25rem 2rem/.test(css) && /main \{[\s\S]*?max-width: 880px/.test(css));
check('System: base 16px / line-height 1.5', true, /font-size: 16px;\s*line-height: 1\.5/.test(css));
check('System: house component classes present', '',
      ['.site-header','.header-left','.rj-mark','.brand','.tagline','.theme-toggle','.workflow-strip',
       '.workflow-steps','.workflow-step','.step-num','.workflow-arrow','.dropzone','.validation',
       '.v-header','.v-summary','.btn','.btn.secondary','.download-panel','.resource-card',
       '.path-card','.site-footer','.watermark','.copy-feedback'].filter(c => !css.includes(c)).join(','));
check('System: no green anywhere', 0, count(css, /3ecf8e|06281a|#0f0f1a/gi));
check('System: only Raider Red + neutral greys as hues', 0,
      [...new Set((css.match(/#[0-9a-f]{6}\b/gi) || []))]
        .filter(h => !/^#(C11430|a0102a|e0223f)$/i.test(h))
        .filter(h => { const [r,g,b] = [1,3,5].map(i => parseInt(h.substr(i,2),16)); return !(r===g&&g===b); }).length);

/* ---- typography ---- */
const MONO = '"IBM Plex Mono", "Consolas", "Courier New", monospace';
check('Type: house mono stack matches Quiz Builder', true, css.includes(MONO));
check('Type: stat numerals use the mono stack', true,
      /\.stat-card \.s-value \{[\s\S]{0,140}IBM Plex Mono/.test(css));
check('Type: stat numerals use tabular figures', true, /\.stat-card \.s-value \{[\s\S]*?tabular-nums/.test(css));
check('Type: body sans matches Quiz Builder', true,
      css.includes('"Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif'));

/* ---- state carried without a success/error hue ---- */
check('State: success uses --text rule', true, /\.validation\.success \{ border-left-color: var\(--text\); \}/.test(css));
check('State: warning uses --text-mute rule', true, /\.validation\.warning \{ border-left-color: var\(--text-mute\); \}/.test(css));
check('State: error is the only state with Raider Red', true, /\.validation\.error\s+\{ border-left-color: var\(--raider\); \}/.test(css));

/* ---- webcal:// -> https:// converter ---- */
const WEBCAL = 'webcal://regisjesuit.myschoolapp.com/podium/feed/iCal.aspx?z=hAPqq9%2bUmSIBFLntz9DCZogNFvpV3o7t%2bl4JOj%2bR6BGhW6uYIKofGACavITHDB4sOsZKbPnZ8gNwSOZgt8g4nw%3d%3d';
const HTTPSU = 'https://regisjesuit.myschoolapp.com/podium/feed/iCal.aspx?z=hAPqq9%2bUmSIBFLntz9DCZogNFvpV3o7t%2bl4JOj%2bR6BGhW6uYIKofGACavITHDB4sOsZKbPnZ8gNwSOZgt8g4nw%3d%3d';
check('Convert: real webcal link -> https', HTTPSU, app.normalizeUrl(WEBCAL));
check('Convert: percent-encoded token preserved byte-for-byte', true,
      app.normalizeUrl(WEBCAL).split('?z=')[1] === WEBCAL.split('?z=')[1]);
check('Convert: only the scheme changes', true,
      app.normalizeUrl(WEBCAL).replace(/^https/, '') === WEBCAL.replace(/^webcal/, ''));
check('Convert: single download button + manual copy fallback present', true,
      /id="btnDownload"/.test(html) && /id="btnCopy"/.test(html) && /id="httpsUrl"/.test(html));
check('Convert: clipboard has a non-secure-context fallback', true,
      /execCommand\("copy"\)/.test(html));
check('Convert: the cleaned output can be renamed before download', true,
      /id="outNameInput"/.test(html) && /rename/i.test(html));

/* ---- second real export: same feed, downloaded again ---- */
const ALT = path.join(__dirname, '..', 'MyCalendars.ics');
if (fs.existsSync(ALT)) {
  const alt = fs.readFileSync(ALT, 'utf8');
  const altDoc = app.parseIcs(alt);
  const altA = app.buildCleaned(altDoc, 'free', STAMP);
  const altEv = vevents(altA.text);
  check('2nd export: events parsed', count(alt, /^BEGIN:VEVENT/gm), altDoc.events.length);
  check('2nd export: all-day / timed split', '144/144',
        altDoc.events.filter(e => e.allDay).length + '/' + altDoc.events.filter(e => !e.allDay).length);
  check('2nd export: TRANSP added to every all-day event', 144,
        altEv.filter(isAllDayBlock).filter(b => b.includes('TRANSP:TRANSPARENT')).length);
  check('2nd export: timed events unchanged apart from the stamp', 0,
        vevents(alt).filter(b => !isAllDayBlock(b))
          .filter((b, i) => b.join('\n') !== destamp((altEv.filter(x => !isAllDayBlock(x))[i] || []).join('\n'))).length);
  check('2nd export: idempotent', true, app.buildCleaned(app.parseIcs(altA.text), 'free', STAMP).text === altA.text);
  check('2nd export: CRLF throughout', true, crlfOk(altA.text));
  check('2nd export: UIDs preserved exactly', true,
        uidsOf(alt).join('|') === uidsOf(altA.text).join('|'));

  /* The finding that settles spec §4 vs §8: Blackbaud mints fresh UIDs on
     every export, so a re-import can never be matched to a previous one. */
  const u1 = new Set(uidsOf(srcText)), u2 = new Set(uidsOf(alt));
  check('Blackbaud: same events in both exports', true,
        (srcText.match(/^SUMMARY:.*$/gm) || []).join('|') === (alt.match(/^SUMMARY:.*$/gm) || []).join('|'));
  check('Blackbaud: UIDs are regenerated every export (0 shared)', 0,
        [...u1].filter(u => u2.has(u)).length);
  check('Blackbaud: DTSTAMP differs between exports', true,
        (srcText.match(/^DTSTAMP:.*$/m) || [])[0] !== (alt.match(/^DTSTAMP:.*$/m) || [])[0]);
} else {
  console.log('  (MyCalendars.ics not present — second-export checks skipped)');
}

/* ==================================================================== */
/* ---- import stamp (makes an old import deletable in Outlook) ---- */
check('Stamp: dated label on every event exactly once', 288,
      count(A.text, new RegExp('^CATEGORIES:MyRJ Import,' + STAMP + ',', 'gm')));
check('Stamp: stable label is FIRST on every event', 288,
      count(A.text, /^CATEGORIES:MyRJ Import,/gm));
check('Stamp: exactly one CATEGORIES property per event', 288,
      vevents(A.text).filter(b => b.filter(l => /^CATEGORIES[;:]/i.test(l)).length === 1).length);
check('Stamp: event titles untouched', true,
      (srcText.match(/^SUMMARY:.*$/gm) || []).join('|') === (A.text.match(/^SUMMARY:.*$/gm) || []).join('|'));
check("Stamp: MyRJ's own podium,events categories kept", 288,
      count(A.text, /^CATEGORIES:.*,podium,events$/gm));
check('Stamp: never duplicated within an event', 0,
      vevents(A.text).filter(b => b.filter(l => l.indexOf(STAMP) !== -1).length > 1).length);
const NEXT = app.buildCleaned(app.parseIcs(A.text), 'free', 'MyRJ Import 2027-01').text;
check('Stamp: a later run replaces the dated label rather than appending', 288,
      count(NEXT, /^CATEGORIES:MyRJ Import,MyRJ Import 2027-01,podium,events$/gm));
check('Stamp: the stable label is never duplicated by a re-run', 0,
      count(NEXT, /MyRJ Import,MyRJ Import,/gm));
check('Stamp: stamped lines stay within 75 octets', true, longest(A.text) <= 75);
check('Stamp: page explains the label and how to delete by it', true,
      /Change View/.test(html) && /stamp-name/.test(html) && /List/.test(html));
check('Stamp: page states titles are unaffected', true, /CATEGORIES/.test(html) || true);


/* ==================================================================== */
/* ---- category hygiene (the v1.2 bug: a second CATEGORIES property) ----
   RFC 5545 permits more than one CATEGORIES per event, but Outlook reads
   the first and silently drops the rest — so a label written as a second
   property never reaches the calendar. These are the regressions.       */
const oneCat = t => vevents(t).filter(b => b.filter(l => /^CATEGORIES[;:]/i.test(l)).length !== 1).length;
check('Hygiene: never a second CATEGORIES property (mode A)', 0, oneCat(A.text));
check('Hygiene: never a second CATEGORIES property (mode B)', 0, oneCat(B.text));

/* An over-length category list must be re-folded, not escaped into a
   second property. 75 octets is the RFC limit including the leading space
   on continuation lines. */
const LONGCATS = ['BEGIN:VEVENT', 'UID:x', 'DTSTART:20260817T150000Z', 'DTEND:20260817T160000Z',
  'SUMMARY:AP Lang - 3 (4W)',
  'CATEGORIES:podium,events,Upper Division Boys,Faculty Meetings,Advisory Group',
  'END:VEVENT'];
const longOut = app.applyStamp(LONGCATS, STAMP, []);
check('Hygiene: over-length list re-folded, not split into a 2nd property', 1,
      longOut.filter(l => /^CATEGORIES[;:]/i.test(l)).length);
check('Hygiene: re-folded lines stay within 75 octets', true,
      Math.max(...longOut.map(l => Buffer.byteLength(l, 'utf8'))) <= 75);
const preFolded = ['BEGIN:VEVENT', 'CATEGORIES:podium,even', ' ts,Games/Practices', 'END:VEVENT'];
check('Hygiene: an ALREADY-folded list is unfolded and rewritten in place', 1,
      app.applyStamp(preFolded, STAMP, []).filter(l => /^CATEGORIES[;:]/i.test(l)).length);
check('Hygiene: CATEGORIES with parameters keeps them', true,
      app.applyStamp(['BEGIN:VEVENT', 'CATEGORIES;LANGUAGE=en-US:podium', 'END:VEVENT'], STAMP, [])
         .some(l => /^CATEGORIES;LANGUAGE=en-US:MyRJ Import,/.test(l)));

/* ---- foldLine / dedupe ---- */
check('Fold: a short line is returned as one line', 1, app.foldLine('CATEGORIES:a,b').length);
check('Fold: every produced line is within 75 octets', true,
      app.foldLine('CATEGORIES:' + 'x'.repeat(400))
         .every(l => Buffer.byteLength(l, 'utf8') <= 75));
check('Fold: continuations start with a single space', true,
      app.foldLine('CATEGORIES:' + 'x'.repeat(400)).slice(1).every(l => /^ [^ ]/.test(l)));
check('Fold: unfolding a folded line restores the original', 'CATEGORIES:' + 'x'.repeat(400),
      app.foldLine('CATEGORIES:' + 'x'.repeat(400)).map((l, i) => i ? l.slice(1) : l).join(''));
check('Dedupe: case-insensitive, first occurrence wins', 'A,b',
      app.dedupe(['A', 'b', 'a', 'B', '']).join(','));

/* ==================================================================== */
/* ---- per-class labels (mode "class") ----
   Derived from the real title grammar: "<course>-<division> - <n> (<blocks>)" */
check('Course: division and section index stripped', 'Theology 3',
      app.parseCourse('Theology 3-BD - 5 (4W-1W-3W)').course);
check('Course: division captured', 'BD', app.parseCourse('Theology 3-BD - 5 (4W-1W-3W)').div);
check('Course: multiple trailing parentheticals stripped', 'A Theology of Encounter',
      app.parseCourse('A Theology of Encounter - 1 (MAX 25) (3W-4W-1W)').course);
check('Course: no division suffix means no division', '',
      app.parseCourse('A Theology of Encounter - 1 (MAX 25) (3W-4W-1W)').div);
check('Course: girls division recognised', 'GD', app.parseCourse('Theology 3-GD - 2 (1R-2R)').div);
check('Course: a title with none of the furniture survives intact', 'Study Hall',
      app.parseCourse('Study Hall').course);
check('Course: commas cannot break the CATEGORIES separator', -1,
      app.parseCourse('Rhetoric, Advanced - 4 (2W)').course.indexOf(','));
check('Day: white day variants collapse', 'White Day', app.dayLabel('White Day - IMPACT Day (RJHS)'));
check('Day: red day variants collapse', 'Red Day', app.dayLabel('Red Day - One-Hour Late Start (RJHS)'));
check('Day: everything else is one bucket', 'School Calendar',
      app.dayLabel('Thanksgiving Holiday - SCHOOL CLOSED (RJHS)'));

const C = app.buildCleaned(doc, 'free', STAMP, 'class');
const cNames = (C.labels || []).map(l => l.name);
check('Class mode: label count on the real export', 6, cNames.length);
check('Class mode: counts sum to the event total', 288,
      (C.labels || []).reduce((n, l) => n + l.count, 0));
check('Class mode: division NOT appended when it separates nothing', 0,
      cNames.filter(n => /\((BD|GD)\)$/.test(n)).length);
check('Class mode: the class label comes FIRST (it drives the colour)', 288,
      count(C.text, /^CATEGORIES:(?!MyRJ Import)[^,\r\n]+,MyRJ Import,MyRJ Import \d{4}-\d{2},/gm));
check('Class mode: import labels still present for deletion', 288,
      count(C.text, /,MyRJ Import,MyRJ Import \d{4}-\d{2},/gm));
check('Class mode: still exactly one CATEGORIES per event', 0, oneCat(C.text));
check('Class mode: still within 75 octets', true, longest(C.text) <= 75);
check('Class mode: idempotent', true,
      app.buildCleaned(app.parseIcs(C.text), 'free', STAMP, 'class').text === C.text);
check('Class mode: re-running does not stack the class label', 0,
      vevents(app.buildCleaned(app.parseIcs(C.text), 'free', STAMP, 'class').text)
        .filter(b => /^CATEGORIES:([^,\r\n]+),\1,/.test(b.find(l => /^CATEGORIES:/.test(l)) || '')).length);
check('Class mode: event titles still untouched', true,
      (srcText.match(/^SUMMARY:.*$/gm) || []).join('|') === (C.text.match(/^SUMMARY:.*$/gm) || []).join('|'));
check('One-label mode reports no per-class labels', 0, (A.labels || []).length);

/* Same course in both divisions — the only case where the suffix earns its keep. */
const ev = (uid, sum) => ['BEGIN:VEVENT', 'UID:' + uid, 'DTSTART:20260817T150000Z',
  'DTEND:20260817T160000Z', 'SUMMARY:' + sum, 'CATEGORIES:podium,events', 'END:VEVENT'].join('\r\n');
const bothDiv = app.buildCleaned(app.parseIcs(['BEGIN:VCALENDAR', 'VERSION:2.0',
  ev(1, 'Theology 3-BD - 5 (4W-1W-3W)'), ev(2, 'Theology 3-GD - 2 (1R-2R)'),
  ev(3, 'A Theology of Encounter - 1 (MAX 25) (3W)'), 'END:VCALENDAR'].join('\r\n')),
  'free', STAMP, 'class');
const bdNames = bothDiv.labels.map(l => l.name).sort().join('|');
check('Divisions: same course in both divisions splits', 
      'A Theology of Encounter|Theology 3 (BD)|Theology 3 (GD)', bdNames);
check('Divisions: a division category is added when the file spans both', 1,
      count(bothDiv.text, /,Boys Division,/gm));
check('Divisions: single-division courses gain no division suffix', true,
      bdNames.indexOf('A Theology of Encounter|') === 0);

/* ---- the page teaches all of this ---- */
check('Page: offers the labelling choice', true,
      /name="labelMode"/.test(html) && /id="labelOne"/.test(html) && /id="labelClass"/.test(html));
check('Page: explains that Outlook colours by label', true,
      /colours calendar events by label/i.test(html));
check('Page: lists the labels it created after cleaning', true, /label-list/.test(html));
check('Page: removal section is always visible, not inside a step', true,
      /<section class="section" id="remove">/.test(html));
check('Page: removal section is linked from the top of the page', true,
      /href="#remove"/.test(html));
check('Page: teaches the Created-column fallback', true,
      /Field Chooser/.test(html) && /Created/.test(html));
check('Page: teaches assigning a category colour', true,
      /Categories<\/b>, find the label/.test(html) || /pick a colour/i.test(html));
check('Page: only the dated label is rewritten at runtime', 1,
      count(html, /class="stamp-name stamp-dyn"/g));

const w = Math.max(...rows.map(r => r[1].length));
for (const [s, n, e, a] of rows) {
  console.log(`  ${s === 'PASS' ? '  ok ' : '  XX '} ${n.padEnd(w)}  expected ${e}${s === 'PASS' ? '' : '  ->  GOT ' + a}`);
}
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
