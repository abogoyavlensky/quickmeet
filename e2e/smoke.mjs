// A two-browser call against a running quickmeet, held for a while, with
// every change of state printed. It is the check after an install and the
// tool that measures what a deploy or restart does to a live call.
//
//   QM_URL       the instance, e.g. https://meet.example.com (required)
//   QM_EMAIL     the account that hosts the call (required)
//   QM_PASSWORD  its password (required; never printed)
//   QM_SIGNUP=1  sign the account up instead of signing in (a local instance)
//   QM_SECS      how long to watch the call, default 20
//
// Run with `lgx smoke`. Exit 0 when both people are still in the call at the
// end with media flowing both ways, 1 otherwise. The room it makes is
// deleted at the end, pass or fail.
import { chromium } from '@playwright/test';

const BASE = (process.env.QM_URL || '').replace(/\/+$/, '');
const { QM_EMAIL: EMAIL, QM_PASSWORD: PASSWORD } = process.env;
const SIGNUP = process.env.QM_SIGNUP === '1';
const SECS = Number(process.env.QM_SECS || 20);

if (!BASE || !EMAIL || !PASSWORD) {
  console.error('smoke: QM_URL, QM_EMAIL and QM_PASSWORD are required');
  process.exit(2);
}
// The verdict needs the last 4 samples, one a second.
if (!(SECS >= 5)) {
  console.error('smoke: QM_SECS must be a number, at least 5');
  process.exit(2);
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A page call that gives up after `ms`: a stuck stats call or a blackholed
// server must not stall the run past QM_SECS.
const within = (ms, promise) => Promise.race([
  promise,
  sleep(ms).then(() => { throw new Error(`no answer within ${ms} ms`); }),
]);

// The same synthetic camera and microphone as the browser suite.
const browser = await chromium.launch({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
         '--autoplay-policy=no-user-gesture-required'],
});

async function person(name) {
  const context = await browser.newContext();
  await context.grantPermissions(['camera', 'microphone'], { origin: BASE });
  const page = await context.newPage();
  page.on('pageerror', e => log(`[${name}] pageerror: ${e.message}`));
  return page;
}

// Join from the lobby. The staging box drops some new TCP connections, and a
// dropped signalling connection fails the join, so try a few times.
// A join still in progress keeps the button disabled, so each attempt waits
// for it to be clickable again, and a join that lands late counts.
async function join(page, name) {
  if (name) await page.fill('#identity', name);
  for (let attempt = 1; ; attempt++) {
    try {
      if (await page.evaluate(() => window.call.joined === true)) return;
      await page.click('#join', { timeout: 30_000 });
      await page.waitForFunction(() => window.call.joined === true, null, { timeout: 20_000 });
      return;
    } catch (e) {
      const error = await page.locator('#error').textContent().catch(() => '');
      log(`[${name || 'host'}] join attempt ${attempt} failed: ${error || e.message.split('\n')[0]}`);
      if (attempt >= 4) throw e;
    }
  }
}

// What one page shows: joined, who is on the other side, the banner and the
// notice, and the inbound media counters.
const stateOf = page => within(5_000, page.evaluate(async () => {
  const s = await window.call.stats().catch(() => null);
  return {
    joined: window.call.joined,
    remote: window.call.remote,
    status: document.getElementById('status').textContent,
    notice: document.getElementById('notice').textContent,
    frames: s?.video?.framesDecoded ?? null,
    packets: s?.audio?.packetsReceived ?? null,
  };
})).catch(e => ({ error: e.message.split('\n')[0] }));

const httpStatus = () => fetch(BASE + '/', { signal: AbortSignal.timeout(900) })
  .then(r => r.status).catch(() => 'down');

let host;
let roomId;
let ok = false;
try {
  host = await person('host');
  if (SIGNUP) {
    await host.goto(BASE + '/signup');
  } else {
    await host.goto(BASE + '/signin');
  }
  await host.fill('#email', EMAIL);
  await host.fill('#password', PASSWORD);
  await host.click('#submit');
  await host.waitForURL(BASE + '/', { timeout: 15_000 }).catch(async e => {
    const error = await host.locator('#error').textContent().catch(() => '');
    throw new Error(error ? `could not ${SIGNUP ? 'sign up' : 'sign in'}: ${error}` : e.message);
  });
  log(SIGNUP ? 'signed up' : 'signed in');

  // Remember the room as soon as it exists, so a failure after this still
  // deletes it.
  const created = host.waitForResponse(r => r.url().endsWith('/api/rooms') && r.request().method() === 'POST');
  await host.getByRole('button', { name: 'New call' }).click();
  roomId = (await (await created).json().catch(() => ({}))).id;
  await host.waitForURL(/\/room\/[0-9a-f]{12}$/);
  await host.waitForLoadState();
  const roomUrl = host.url();
  roomId = roomUrl.split('/').pop();
  log('room', roomUrl);

  await join(host, null);
  const guest = await person('guest');
  await guest.goto(roomUrl);
  await join(guest, 'smoke-guest');
  log('both joined');

  // Once a second: print a line only when something other than the
  // counters changed; track the longest stretch without media moving.
  const history = [];
  let last = null;
  let stalledSince = null;
  let longestStall = 0;
  let flowing = false;
  const started = Date.now();
  while (Date.now() - started < SECS * 1000) {
    const sample = { http: await httpStatus(), host: await stateOf(host), guest: await stateOf(guest) };
    history.push(sample);
    const shape = JSON.stringify({
      http: sample.http,
      host: { ...sample.host, frames: undefined, packets: undefined },
      guest: { ...sample.guest, frames: undefined, packets: undefined },
    });
    if (shape !== last) { log(shape); last = shape; }

    const prev = history[history.length - 2];
    const advanced = (a, b) => a != null && b != null && a > b;
    const moving = prev && ['host', 'guest'].every(p =>
      advanced(sample[p].frames, prev[p].frames) && advanced(sample[p].packets, prev[p].packets));
    // Stalls count from the first time media is seen moving; the seconds
    // before the first frames are the join, not an outage.
    if (moving) flowing = true;
    if (flowing && prev && !moving) {
      // From the last sample that still showed progress.
      stalledSince ??= Date.now() - 1000;
    } else if (stalledSince) {
      longestStall = Math.max(longestStall, Date.now() - stalledSince);
      log(`media moving again after ${((Date.now() - stalledSince) / 1000).toFixed(1)} s`);
      stalledSince = null;
    }
    await sleep(1000);
  }
  if (stalledSince) longestStall = Math.max(longestStall, Date.now() - stalledSince);

  // Both still in, and media advanced both ways over the last 3 samples.
  const tail = history.slice(-4);
  ok = tail.length === 4 && ['host', 'guest'].every(p =>
    tail[3][p].joined === true &&
    tail.every(s => s[p].frames != null && s[p].packets != null) &&
    tail.every((s, i) => i === 0 || (s[p].frames > tail[i - 1][p].frames &&
                                     s[p].packets > tail[i - 1][p].packets)));
  log(`longest stretch without media: ${(longestStall / 1000).toFixed(1)} s`);
} catch (e) {
  log('smoke failed:', e.message.split('\n')[0]);
} finally {
  if (host && roomId) {
    const status = await within(15_000, host.evaluate(
      id => fetch('/api/rooms/' + id, { method: 'DELETE', signal: AbortSignal.timeout(10_000) }).then(r => r.status),
      roomId)).catch(e => e.message.split('\n')[0]);
    log(status === 200 ? `deleted room ${roomId}` : `could not delete room ${roomId}: ${status}`);
  }
  await browser.close();
}
log(ok ? 'PASS: both in the call, media flowing both ways' : 'FAIL');
process.exit(ok ? 0 : 1);
