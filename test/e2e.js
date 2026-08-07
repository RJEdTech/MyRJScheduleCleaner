/* End-to-end: drive the real page in Chromium with a real export.
   node test/e2e.js <Schedule.ics>                                       */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ICS = process.argv[2];
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
  await page.screenshot({ path: path.join(OUT, '01-light-initial.png'), fullPage: true });

  await page.click('#theme-toggle');
  await page.waitForTimeout(400);
  const toggledTheme = await page.getAttribute('html', 'data-theme');
  await page.screenshot({ path: path.join(OUT, '02-dark-initial.png'), fullPage: true });
  await page.click('#theme-toggle');
  await page.waitForTimeout(300);

  // --- bad link -> error state ---
  await page.fill('#url', 'https://example.com/nope.ics');
  await page.click('#btnFetch');
  await page.waitForSelector('#urlMsg .validation.error');
  const errText = await page.textContent('#urlMsg');

  // --- real webcal link -> live conversion ---
  await page.fill('#url', WEBCAL);            // fires `input`, converting live
  await page.waitForSelector('#converted:not(.hidden)');
  const shownUrl = (await page.textContent('#httpsUrl')).trim();
  const openHref = await page.getAttribute('#btnOpen', 'href');
  await page.screenshot({ path: path.join(OUT, '03-light-converted.png'), fullPage: true });

  // --- copy to clipboard ---
  await page.click('#btnCopy');
  await page.waitForTimeout(250);
  const fbVisible = await page.$eval('#copyFb', e => e.classList.contains('show'));
  let clip = '';
  try { clip = await page.evaluate(() => navigator.clipboard.readText()); } catch (e) { clip = '(unavailable)'; }

  // --- load the real file ---
  await page.setInputFiles('#file', ICS);
  await page.waitForSelector('#sec3:not(.is-hidden)');
  await page.waitForTimeout(500);

  const stats = await page.$$eval('.stat-card', els =>
    els.map(e => [e.querySelector('.s-value').textContent, e.querySelector('.s-label').textContent.trim()]));
  const doneBadges = await page.$$eval('.section.done .step-num', els => els.map(e => e.textContent.trim()));
  await page.screenshot({ path: path.join(OUT, '04-light-loaded.png'), fullPage: true });

  await page.click('.peek >> nth=0');
  await page.waitForTimeout(200);
  const firstRow = (await page.textContent('#adTable tr:nth-child(2)')).trim().replace(/\s+/g, ' ');

  // --- run (mode A) ---
  await page.click('#btnRun');
  await page.waitForSelector('#sec4:not(.is-hidden)');
  await page.waitForTimeout(400);
  const resultText = (await page.textContent('#result')).replace(/\s+/g, ' ').trim();
  await page.screenshot({ path: path.join(OUT, '05-light-result.png'), fullPage: true });

  const dl = await Promise.all([page.waitForEvent('download'), page.click('#btnDl')]);
  const saved = path.join(OUT, 'downloaded.ics');
  await dl[0].saveAs(saved);
  const got = fs.readFileSync(saved, 'utf8');

  await page.click('#theme-toggle');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, '06-dark-result.png'), fullPage: true });

  await browser.close();

  // ---- assertions ----
  const src = fs.readFileSync(ICS, 'utf8');
  // Expectations derived from the source file, so this runs on any export.
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
  t('no external requests attempted', 0, netRequests.length);
  t('no console errors', 0, consoleErrors.length);
  t('defaults to light theme', 'light', defaultTheme);
  t('theme toggle switches to dark', 'dark', toggledTheme);
  t('bad link shows error', true, /doesn't look like a MyRJ feed link/.test(errText));
  t('webcal converted to https on paste', HTTPSU, shownUrl);
  t('open-in-new-tab href is the https link', HTTPSU, openHref);
  t('copy feedback shown', true, fbVisible);
  t('clipboard holds the https link', HTTPSU, clip);
  t('stat: total events', String(srcBlocks.length), stats[0][0]);
  t('stat: timed', String(expTim), stats[1][0]);
  t('stat: all-day', String(expAll), stats[2][0]);
  t('steps 1 and 2 marked done', '✓,✓', doneBadges.join(','));
  t('all-day table has rows', true, /\S/.test(firstRow));
  t('result names the all-day count', true, resultText.includes(expAll + ' all-day events'));
  t('result names the timed count', true, resultText.includes(expTim + ' timed events'));
  t('download named after the source file', base + '-clean.ics', dl[0].suggestedFilename());
  t('downloaded: VEVENT count', srcBlocks.length, nEv);
  t('downloaded: TRANSP:TRANSPARENT', expAll, nTr);
  t('downloaded: CDO BUSYSTATUS:FREE', expAll, nCd);
  t('downloaded: CRLF throughout', true, got.split('\r\n').join('').indexOf('\n') === -1);
  t('downloaded: VTIMEZONE intact', expTz, (got.match(/^BEGIN:VTIMEZONE/gm) || []).length);
  t('downloaded: folded lines preserved', (src.match(/^[ \t]/gm) || []).length,
    (got.match(/^[ \t]/gm) || []).length);
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
