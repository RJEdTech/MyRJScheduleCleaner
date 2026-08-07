/* End-to-end: drive the real page in Chromium with the real export.
   node test/e2e.js <Schedule.ics>                                       */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ICS = process.argv[2];
const OUT = path.join(__dirname, '..', 'shots');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 1000 }, acceptDownloads: true });
  const page = await ctx.newPage();

  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

  // Fail loudly if the page tries to reach the network for anything.
  const netRequests = [];
  await page.route('**/*', route => {
    const u = route.request().url();
    if (!u.startsWith('file://') && !u.startsWith('data:')) netRequests.push(u);
    route.continue();
  });

  await page.goto('file://' + path.join(__dirname, '..', 'index.html'));
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, '01-dark-initial.png'), fullPage: true });

  await page.click('#theme');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, '02-light-initial.png'), fullPage: true });
  await page.click('#theme');
  await page.waitForTimeout(300);

  // Bad URL → error state
  await page.fill('#url', 'https://example.com/nope.ics');
  await page.click('#btnFetch');
  await page.waitForSelector('#urlMsg .validation.error');
  const errText = await page.textContent('#urlMsg');

  // Escape hatch → drop zone → real file
  await page.click('#btnSkip');
  await page.setInputFiles('#file', ICS);
  await page.waitForSelector('#s3:not(.hidden)');
  await page.waitForTimeout(500);

  const stats = await page.$$eval('.stat', els =>
    els.map(e => [e.querySelector('.v').textContent, e.querySelector('.l').textContent.trim()]));
  await page.screenshot({ path: path.join(OUT, '03-dark-loaded.png'), fullPage: true });

  await page.click('details >> nth=0');
  await page.waitForTimeout(200);
  const firstRows = await page.$$eval('#adTable tr', rs =>
    rs.slice(1, 4).map(r => r.textContent.trim().replace(/\s+/g, ' ')));

  // Mode A
  await page.click('#btnRun');
  await page.waitForSelector('#s4:not(.hidden)');
  await page.waitForTimeout(400);
  const resultText = (await page.textContent('#result')).replace(/\s+/g, ' ').trim();
  await page.screenshot({ path: path.join(OUT, '04-dark-result.png'), fullPage: true });

  const dl = await Promise.all([page.waitForEvent('download'), page.click('#btnDl')]);
  const saved = path.join(OUT, 'downloaded.ics');
  await dl[0].saveAs(saved);
  const got = fs.readFileSync(saved, 'utf8');

  // Light-mode result shot
  await page.click('#theme');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, '05-light-result.png'), fullPage: true });

  await browser.close();

  // ---- assertions on what the browser actually produced ----
  const src = fs.readFileSync(ICS, 'utf8');
  const nEv = (got.match(/^BEGIN:VEVENT/gm) || []).length;
  const nTr = (got.match(/^TRANSP:TRANSPARENT$/gm) || []).length;
  const nCd = (got.match(/^X-MICROSOFT-CDO-BUSYSTATUS:FREE$/gm) || []).length;
  const suggestedName = dl[0].suggestedFilename();

  const R = [];
  const t = (n, e, a) => R.push([String(e) === String(a) ? 'ok' : 'XX', n, e, a]);
  t('no network requests attempted', 0, netRequests.length);
  t('no console errors', 0, consoleErrors.length);
  t('bad-URL error shown', true, /doesn't look like a MyRJ feed link/.test(errText));
  t('stat: total events', '288', stats[0][0]);
  t('stat: timed', '144', stats[1][0]);
  t('stat: all-day', '144', stats[2][0]);
  t('all-day table top row', 'White Day (RJHS)59', firstRows[0]);
  t('result names 144 changed', true, /144 all-day events/.test(resultText));
  t('result names 144 timed untouched', true, /144 timed events/.test(resultText));
  t('downloaded filename', 'Schedule-clean.ics', suggestedName);
  t('downloaded: VEVENT count', 288, nEv);
  t('downloaded: TRANSP:TRANSPARENT', 144, nTr);
  t('downloaded: CDO BUSYSTATUS:FREE', 144, nCd);
  t('downloaded: CRLF throughout', true, got.split('\r\n').join('').indexOf('\n') === -1);
  t('downloaded: VTIMEZONE intact', 1, (got.match(/^BEGIN:VTIMEZONE/gm) || []).length);
  t('downloaded: all 288 UIDs preserved', true,
    (src.match(/^UID:.*$/gm) || []).join('|') === (got.match(/^UID:.*$/gm) || []).join('|'));
  t('downloaded: ends with END:VCALENDAR', true, /END:VCALENDAR\r\n$/.test(got));

  const w = Math.max(...R.map(r => r[1].length));
  console.log('');
  for (const [s, n, e, a] of R)
    console.log(`   ${s === 'ok' ? ' ok ' : ' XX '} ${n.padEnd(w)}  ${e}${s === 'ok' ? '' : '   ->  GOT ' + a}`);
  const fails = R.filter(r => r[0] === 'XX').length;
  console.log(`\n   ${R.length - fails} passed, ${fails} failed\n`);
  if (netRequests.length) console.log('   network attempts:', netRequests);
  if (consoleErrors.length) console.log('   console:', consoleErrors);
  process.exit(fails ? 1 : 0);
})();
