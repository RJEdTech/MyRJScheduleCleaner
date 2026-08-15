/* End-to-end: drive the real page in Chromium with a real export.
   Rebuilt for the v2 one-step-at-a-time wizard.
   node test/e2e.js <Schedule.ics>                                       */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ICS = process.argv[2];
if (!ICS) { console.error('usage: node test/e2e.js <Schedule.ics>'); process.exit(2); }
const OUT = path.join(__dirname, '..', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const WEBCAL = 'webcal://regisjesuit.myschoolapp.com/podium/feed/iCal.aspx?z=hAPqq9%2bUmSIBFLntz9DCZogNFvpV3o7t%2bl4JOj%2bR6BGhW6uYIKofGACavITHDB4sOsZKbPnZ8gNwSOZgt8g4nw%3d%3d';
const HTTPSU = WEBCAL.replace(/^webcal/, 'https');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1180, height: 1000 },
    acceptDownloads: true,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await ctx.newPage();

  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

  // Anything that isn't file:// or data:// is an external request the tool promised not to make.
  const netRequests = [];
  await page.route('**/*', route => {
    const u = route.request().url();
    if (u.startsWith('file://') || u.startsWith('data:')) return route.continue();
    netRequests.push(u);          // promised never to happen — block it and record it
    route.abort();
  });

  await page.goto('file://' + path.join(__dirname, '..', 'index.html'));
  await page.waitForTimeout(400);
  const defaultTheme = await page.getAttribute('html', 'data-theme');

  // Only Step 1 should be open at the start; later steps are collapsed/locked.
  const bodyDisplay = n => page.$eval('#step' + n + ' .wstep-body', e => getComputedStyle(e).display);
  const step1Open = await bodyDisplay(1);
  const step2Closed = await bodyDisplay(2);
  await page.screenshot({ path: path.join(OUT, '01-light-initial.png'), fullPage: true });

  await page.click('#theme-toggle');
  await page.waitForTimeout(400);
  const toggledTheme = await page.getAttribute('html', 'data-theme');
  await page.screenshot({ path: path.join(OUT, '02-dark-initial.png'), fullPage: true });
  await page.click('#theme-toggle');
  await page.waitForTimeout(300);

  // --- bad link -> error state (conversion is live; Enter validates) ---
  await page.fill('#url', 'https://example.com/nope.ics');
  await page.press('#url', 'Enter');
  await page.waitForSelector('#urlMsg .validation.error');
  const errText = await page.textContent('#urlMsg');

  // --- real webcal link -> live conversion, single download button ---
  await page.fill('#url', WEBCAL);            // fires `input`, converting live
  await page.waitForSelector('#converted:not(.hidden)');
  const shownUrl = (await page.textContent('#httpsUrl')).trim();
  const downloadHref = await page.getAttribute('#btnDownload', 'href');
  await page.screenshot({ path: path.join(OUT, '03-light-converted.png'), fullPage: true });

  // --- manual fallback: open the by-hand details and copy to clipboard ---
  await page.click('#step1 .explainer summary:has-text("by hand")');
  await page.waitForTimeout(150);
  await page.click('#btnCopy');
  await page.waitForTimeout(250);
  const fbVisible = await page.$eval('#copyFb', e => e.classList.contains('show'));
  let clip = '';
  try { clip = await page.evaluate(() => navigator.clipboard.readText()); } catch (e) { clip = '(unavailable)'; }

  // --- load the real file (advances to Step 3) ---
  await page.setInputFiles('#file', ICS);
  await page.waitForSelector('#step3.is-active');
  await page.waitForTimeout(400);

  const stats = await page.$$eval('.stat-card', els =>
    els.map(e => [e.querySelector('.s-value').textContent, e.querySelector('.s-label').textContent.trim()]));
  const doneBadges = await page.$$eval('.wstep.is-done .wstep-num', els => els.map(e => e.textContent.trim()));
  await page.screenshot({ path: path.join(OUT, '04-light-loaded.png'), fullPage: true });

  await page.click('#step3 .peek >> nth=0');
  await page.waitForTimeout(200);
  const firstRow = (await page.textContent('#adTable tr:nth-child(2)')).trim().replace(/\s+/g, ' ');

  // --- run (one-label mode) ---
  await page.click('#btnRun');
  await page.waitForSelector('#step4.is-active');
  await page.waitForTimeout(400);
  const resultText = (await page.textContent('#result')).replace(/\s+/g, ' ').trim();
  const step4Help  = (await page.textContent('#step4')).replace(/\s+/g, ' ').trim();
  // The gray-events colour fix is now its own step (Step 5); removal is a
  // separate always-visible reference section.
  const step5Help  = (await page.textContent('#step5')).replace(/\s+/g, ' ').trim();
  const deleteHelp = (await page.textContent('#remove')).replace(/\s+/g, ' ').trim();
  const removeVisible = await page.$eval('#remove', e => e.offsetHeight > 0);
  const removeLinked  = await page.$eval('main', e => !!e.querySelector('a[href="#remove"]'));
  const oneLabels = await page.$$eval('.label-list li', els => els.map(e => e.textContent.trim()));
  await page.screenshot({ path: path.join(OUT, '05-light-result.png'), fullPage: true });

  const dl = await Promise.all([page.waitForEvent('download'), page.click('#btnDl')]);
  const saved = path.join(OUT, 'downloaded.ics');
  await dl[0].saveAs(saved);
  const got = fs.readFileSync(saved, 'utf8');

  /* --- run again in per-class mode: reopen Step 3, open options, switch --- */
  await page.click('#head3');
  await page.waitForSelector('#step3.is-active');
  await page.click('#step3 .explainer summary:has-text("Change the options")');
  await page.waitForTimeout(150);
  await page.click('#labelClass');
  await page.click('#btnRun');
  await page.waitForTimeout(400);
  const classLabels = await page.$$eval('.label-list li', els => els.map(e => e.textContent.trim()));
  const modeStillFree = await page.$eval('#modeFree', e => e.classList.contains('is-selected'));
  await page.screenshot({ path: path.join(OUT, '07-light-per-class.png'), fullPage: true });
  const dl2 = await Promise.all([page.waitForEvent('download'), page.click('#btnDl')]);
  const savedClass = path.join(OUT, 'downloaded-per-class.ics');
  await dl2[0].saveAs(savedClass);
  const gotClass = fs.readFileSync(savedClass, 'utf8');

  await page.click('#theme-toggle');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, '06-dark-result.png'), fullPage: true });

  // --- reopening a finished step collapses the current one ---
  await page.click('#head1');
  await page.waitForTimeout(200);
  const reopen1 = await bodyDisplay(1);
  const collapsed4 = await bodyDisplay(4);

  await browser.close();

  // ---- assertions ----
  const src = fs.readFileSync(ICS, 'utf8');
  const srcBlocks = (() => { const o = []; let c = null;
    for (const ln of src.split(/\r\n|\n|\r/)) {
      if (/^BEGIN:VEVENT\s*$/.test(ln)) { c = [ln]; continue; }
      if (c) { c.push(ln); if (/^END:VEVENT\s*$/.test(ln)) { o.push(c); c = null; } } }
    return o; })();
  const isAD = b => b.some(l => /^DTSTART[^:]*VALUE=DATE(?!-TIME)/i.test(l));
  const expAll = srcBlocks.filter(isAD).length;
  const expTim = srcBlocks.length - expAll;
  const expTz  = (src.match(/^BEGIN:VTIMEZONE/gm) || []).length;
  const nEv = (got.match(/^BEGIN:VEVENT/gm) || []).length;
  const nTr = (got.match(/^TRANSP:TRANSPARENT$/gm) || []).length;
  const nCd = (got.match(/^X-MICROSOFT-CDO-BUSYSTATUS:FREE$/gm) || []).length;
  const base = path.basename(ICS).replace(/\.ics$/i, '');

  const R = [];
  const t = (n, e, a) => R.push([String(e) === String(a) ? 'ok' : 'XX', n, e, a]);

  // structure / wizard behaviour
  t('no external requests attempted', 0, netRequests.length);
  t('no console errors', 0, consoleErrors.length);
  t('defaults to light theme', 'light', defaultTheme);
  t('theme toggle switches to dark', 'dark', toggledTheme);
  t('only step 1 is open at the start', 'block/none', step1Open + '/' + step2Closed);
  t('steps 1 and 2 marked done after loading', '✓,✓', doneBadges.join(','));
  t('loading advances to step 3', true, true); // implied by waitForSelector('#step3.is-active')
  t('cleaning advances to step 4', true, true); // implied by waitForSelector('#step4.is-active')
  t('reopening step 1 collapses the current step', 'block/none', reopen1 + '/' + collapsed4);

  // link handling
  t('bad link shows error', true, /doesn't look like a MyRJ feed link/.test(errText));
  t('webcal converted to https on paste', HTTPSU, shownUrl);
  t('single download button points at the https link', HTTPSU, downloadHref);
  t('copy feedback shown', true, fbVisible);
  t('clipboard holds the https link', HTTPSU, clip);

  // analysis + result
  t('stat: total events', String(srcBlocks.length), stats[0][0]);
  t('stat: timed', String(expTim), stats[1][0]);
  t('stat: all-day', String(expAll), stats[2][0]);
  t('all-day table has rows', true, /\S/.test(firstRow));
  t('result names the all-day count', true, resultText.includes(expAll + ' all-day events'));
  t('result names the timed count', true, resultText.includes(expTim + ' timed events'));
  t('step 4 shows the dated label after cleaning', true, /MyRJ Import \d{4}-\d{2}/.test(step4Help));
  t('step 5 explains the grey-events colour fix', true, /pick a colou?r/i.test(step5Help));
  t('removal section visible without extra steps', true, removeVisible);
  t('removal section shows the List-view delete steps', true,
    /Change View/.test(deleteHelp) && /List/.test(deleteHelp));
  t('removal section linked from the page', true, removeLinked);
  t('one-label mode lists the single label to colour', true,
    oneLabels.length === 1 && /MyRJ Import/.test(oneLabels[0]));
  t('per-class mode lists more labels than one-label mode', true, classLabels.length > 1);
  t('per-class labels include a day label', true,
    classLabels.some(x => /(White|Red) Day|School Calendar/.test(x)));
  t('switching label mode does not clear the all-day choice', true, modeStillFree);

  // downloaded file correctness (engine)
  t('download named after the source file', base + '-clean.ics', dl[0].suggestedFilename());
  t('downloaded: VEVENT count', srcBlocks.length, nEv);
  t('downloaded: TRANSP:TRANSPARENT', expAll, nTr);
  t('downloaded: CDO BUSYSTATUS:FREE', expAll, nCd);
  t('downloaded: CRLF throughout', true, got.split('\r\n').join('').indexOf('\n') === -1);
  t('downloaded: VTIMEZONE intact', expTz, (got.match(/^BEGIN:VTIMEZONE/gm) || []).length);
  t('downloaded: folded lines preserved', (src.match(/^[ \t]/gm) || []).length,
    (got.match(/^[ \t]/gm) || []).length);
  const stampRe = /^CATEGORIES:MyRJ Import,MyRJ Import \d{4}-\d{2}(,|$)/gm;
  t('downloaded: import labels on every event', srcBlocks.length, (got.match(stampRe) || []).length);
  t('downloaded: exactly one CATEGORIES per event', srcBlocks.length,
    (got.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [])
      .filter(b => (b.match(/^CATEGORIES[;:]/gm) || []).length === 1).length);
  t('downloaded: no line over 75 octets', 0,
    got.split('\r\n').filter(l => Buffer.byteLength(l, 'utf8') > 75).length);
  t('downloaded: event titles untouched', true,
    (src.match(/^SUMMARY:.*$/gm) || []).join('|') === (got.match(/^SUMMARY:.*$/gm) || []).join('|'));
  t('per-class download puts the class label first', true,
    /^CATEGORIES:(?!MyRJ Import)[^,\r\n]+,MyRJ Import,MyRJ Import \d{4}-\d{2}/m.test(gotClass));
  t('per-class download keeps the deletion labels', srcBlocks.length,
    (gotClass.match(/,MyRJ Import,MyRJ Import \d{4}-\d{2}/gm) || []).length);
  t('per-class download: exactly one CATEGORIES per event', srcBlocks.length,
    (gotClass.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [])
      .filter(b => (b.match(/^CATEGORIES[;:]/gm) || []).length === 1).length);
  t('downloaded: all UIDs preserved', true,
    (src.match(/^UID:.*$/gm) || []).join('|') === (got.match(/^UID:.*$/gm) || []).join('|'));
  t('downloaded: ends with END:VCALENDAR', true, /END:VCALENDAR\r\n$/.test(got));

  const w = Math.max(...R.map(r => r[1].length));
  console.log('\n  Source: ' + path.basename(ICS) + '\n');
  for (const [s, n, e, a] of R)
    console.log(`   ${s === 'ok' ? ' ok ' : ' XX '} ${n.padEnd(w)}  ${e}${s === 'ok' ? '' : '   ->  GOT ' + a}`);
  const fails = R.filter(r => r[0] === 'XX').length;
  console.log(`\n   ${R.length - fails} passed, ${fails} failed\n`);
  if (netRequests.length) console.log('   external attempts:', netRequests);
  if (consoleErrors.length) console.log('   console:', consoleErrors);
  process.exit(fails ? 1 : 0);
})();
