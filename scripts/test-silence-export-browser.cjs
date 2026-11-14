// Requires Playwright and an installed Edge. Optional args: input.xml output.xml
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  try {
    const page = await browser.newPage();
    await page.route('http://silence-test.local/**', route => route.fulfill({ body: '<html></html>', contentType: 'text/html' }));
    await page.goto('http://silence-test.local/');
    const source = fs.readFileSync(path.join(__dirname, '../web-ui/tools/common/edl-export.js'), 'utf8');
    await page.addScriptTag({ content: source.replace(/^export /gm, '') });
    const xml = process.argv[2] ? fs.readFileSync(process.argv[2], 'utf8') : `<?xml version="1.0"?>
<!DOCTYPE xmeml><xmeml version="4"><!-- itmatzip-fcp7 rev=2 rs=1 -->
<sequence><duration>60</duration><media><video><track><clipitem id="v1">
<name>source &amp; clip</name><duration>60</duration><start>0</start><end>60</end><in>150</in><out>210</out>
<file id="file-1"><duration>300</duration></file></clipitem></track></video>
<audio><track><clipitem id="a1"><duration>60</duration><start>0</start><end>60</end><in>150</in><out>210</out>
<file id="file-1"/></clipitem></track></audio></media></sequence></xmeml>`;
    const result = await page.evaluate(xml => {
      const parse = value => new DOMParser().parseFromString(value, 'application/xml');
      const cuts = doc => [...doc.querySelectorAll('clipitem')].map(c => ['start', 'end', 'in', 'out'].map(tag => c.querySelector(tag).textContent));
      const normalized = normalizeFcpXmlSourceDurations(xml);
      const doc = parse(normalized);
      const clips = [...doc.querySelectorAll('clipitem')];
      sessionStorage.setItem(STORAGE_FCP_XML, xml);
      return {
        normalized, before: cuts(parse(xml)), after: cuts(doc),
        valid: fcpXmlLooksValid(normalized),
        sourceDuration: Number(doc.querySelector('file duration').textContent),
        timelineDuration: Number(doc.querySelector('sequence > duration').textContent),
        videoClips: doc.querySelectorAll('video > track > clipitem').length,
        audioClips: doc.querySelectorAll('audio > track > clipitem').length,
        extentsValid: clips.every(c => Number(c.querySelector('out').textContent) <= Number(c.querySelector('duration').textContent)),
        cachedRepaired: getStoredFcpXmlFromSession() === normalized,
        idempotent: normalizeFcpXmlSourceDurations(normalized) === normalized,
        malformedUnchanged: normalizeFcpXmlSourceDurations('<xmeml><!-- itmatzip-fcp7 rev=2 -->') === '<xmeml><!-- itmatzip-fcp7 rev=2 -->',
      };
    }, xml);
    assert.deepEqual(result.after, result.before, 'All original cut coordinates must survive');
    for (const key of ['valid', 'extentsValid', 'cachedRepaired', 'idempotent', 'malformedUnchanged']) assert.equal(result[key], true, key);
    assert.equal(result.videoClips, result.audioClips);
    if (process.argv[3]) fs.writeFileSync(process.argv[3], result.normalized, 'utf8');
    delete result.normalized; delete result.before; delete result.after;
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
