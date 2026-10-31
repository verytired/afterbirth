// Records a bundled song with the app's own VIDEO recorder (tab capture + MASTER audio), ready for YouTube.
// Chrome auto-accepts the tab capture, and renders audio to a fake sink so the run does not depend on
// the computer's sound device. Use a built app (npm run build && npx vite preview) so nothing reloads
// the page mid-take; ffmpeg (optional) remuxes for fast start.
// Usage: node scripts/record-demo.mjs [song file in public/songs] [out.mp4] [app url]
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const [song = 'devil-fish.song.json', out = 'demo.mp4', url = 'http://localhost:4173/'] = process.argv.slice(2);

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--autoplay-policy=no-user-gesture-required', '--auto-accept-this-tab-capture', '--disable-audio-output'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, acceptDownloads: true });
page.on('pageerror', e => { console.error(e); process.exit(1); });
await page.goto(url);
// LOAD the song the way a user would
await page.setInputFiles('#songfile', new URL(`../public/songs/${song}`, import.meta.url).pathname);
await page.locator('#songcap').filter({ hasText: /^loaded / }).waitFor();
await page.evaluate(() => {
  // shrink the page so the whole rack (plus the body padding) fits the 1080-line frame
  const h = document.querySelector('.rack').getBoundingClientRect().height + 24;
  document.body.style.zoom = String(Math.min(1, innerHeight / h));
});

// Song END stops playback and, 2 s later, the running VIDEO recording, which downloads
const done = page.waitForEvent('download', { timeout: 15 * 60_000 });
await page.click('#vid');
await page.locator('#vid.recording').waitFor();
await page.waitForTimeout(1000); // a still picture before the music
await page.click('#play');
const progress = setInterval(async () => console.log('bar', await page.locator('#songpos').textContent().catch(() => '?')), 15_000);
page.on('load', () => { console.error('the page reloaded mid-take'); process.exit(1); });
const dl = await done;
clearInterval(progress);
const raw = out.replace(/\.mp4$/, '') + '.raw.' + dl.suggestedFilename().split('.').pop();
await dl.saveAs(raw);
await browser.close();
try {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-c', 'copy', '-movflags', '+faststart', out]);
  console.log('wrote', out);
} catch {
  console.log('wrote', raw, '(ffmpeg not available for the fast-start remux)');
}
