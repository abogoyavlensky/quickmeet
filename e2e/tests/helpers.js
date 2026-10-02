// Shared steps for the browser specs. Each test creates its own room and its
// own participants, so tests do not depend on each other and retries or
// --repeat-each stay valid.
import { expect } from '@playwright/test';

// Sign a fresh account up in this page's context (the cookie lives there),
// landing on the home page signed in. Returns the address. Only the person
// who starts a meeting signs up; guests never do.
export async function signUp(page, name = 'host') {
  const email = `${name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  await page.goto('/signup');
  await page.fill('#email', email);
  await page.fill('#password', 'correct horse');
  await page.click('#submit');
  await expect(page).toHaveURL(/\/$/);
  return email;
}

// Sign up, click "New call", return the room URL.
export async function newRoom(page) {
  await signUp(page);
  await page.getByRole('button', { name: 'New call' }).click();
  await expect(page).toHaveURL(/\/room\/[0-9a-f]{12}$/);
  // The URL changes when the navigation commits; the room page's elements
  // exist only once it has loaded.
  await page.waitForLoadState();
  return page.url();
}

// A person at the room page, in the lobby, not joined: its own browser
// context (own origin state, permissions and fake devices). Page errors and
// console errors are echoed into the test output. `contextOptions` go to
// browser.newContext: test.use() configures only the fixture page, not the
// contexts a helper creates, so a phone-sized participant passes its
// viewport here.
// `init`, if given, is not a Playwright option: it is awaited with the new
// context before the page opens (for example `tallCamera`).
export async function openLobby(browser, contexts, roomUrl, name, { init, ...contextOptions } = {}) {
  const context = await browser.newContext(contextOptions);
  contexts.push(context);
  await context.grantPermissions(['camera', 'microphone']);
  if (init) await init(context);
  const page = await context.newPage();
  page.on('pageerror', e => console.log(`[${name}] pageerror: ${e.message}`));
  // A guest's /api/me answers 401 by design; the browser logs that as a
  // resource error, so it is the one message not worth echoing.
  page.on('console', m => {
    if (m.type() === 'error' && !/status of 401/.test(m.text())) console.log(`[${name}] console.error: ${m.text()}`);
  });
  await page.goto(roomUrl);
  await page.fill('#identity', name);
  return { context, page };
}

// A camera or a screen of a given shape: a canvas of the size asked for,
// repainted on a timer (a canvas that is never repainted sends no frames).
// For the camera, the video track getUserMedia returns is replaced (the
// fake device arrives as 16:9); for the screen, getDisplayMedia returns the
// canvas alone, with no picker. The page under test is unchanged: the
// client gets the stream the normal way.
const canvasMedia = (api, width, height) => async context => {
  await context.addInitScript(({ api, width, height }) => {
    const canvasTrack = () => {
      const canvas = Object.assign(document.createElement('canvas'), { width, height });
      const g = canvas.getContext('2d');
      let n = 0;
      setInterval(() => {
        g.fillStyle = `hsl(${(n++ * 7) % 360} 60% 50%)`;
        g.fillRect(0, 0, width, height);
      }, 66);
      return canvas.captureStream(15).getVideoTracks()[0];
    };
    const devices = navigator.mediaDevices;
    if (api === 'display') {
      devices.getDisplayMedia = async () => new MediaStream([canvasTrack()]);
      return;
    }
    const real = devices.getUserMedia.bind(devices);
    devices.getUserMedia = async constraints => {
      const stream = await real(constraints);
      if (!constraints || !constraints.video) return stream;
      for (const t of stream.getVideoTracks()) { stream.removeTrack(t); t.stop(); }
      stream.addTrack(canvasTrack());
      return stream;
    };
  }, { api, width, height });
};
// Held upright, and a webcam's 4:3.
export const tallCamera = canvasMedia('user', 360, 640);
export const webcam = canvasMedia('user', 640, 480);
// A screen to share. Its shape tells it apart from the 16:9 fake camera.
export const canvasScreen = (width, height) => canvasMedia('display', width, height);
// The picker closed without choosing: what the browser answers then.
export const noScreen = async context => {
  await context.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = async () => { throw new DOMException('denied', 'NotAllowedError'); };
  });
};

// A participant joined to the room under `name`.
export async function joinAs(browser, contexts, roomUrl, name, contextOptions = {}) {
  const person = await openLobby(browser, contexts, roomUrl, name, contextOptions);
  await person.page.click('#join');
  await person.page.waitForFunction(() => window.call.joined === true, null, { timeout: 15_000 });
  return person;
}

export const remoteOf = page => page.evaluate(() => window.call.remote);
export const statsOf = page => page.evaluate(() => window.call.stats());

// Bounding-box checks shared by the layout specs.
export const box = async locator => {
  const b = await locator.boundingBox();
  expect(b, `${locator} has a box`).not.toBeNull();
  return b;
};
export const inside = (b, w, h) => b.x >= 0 && b.y >= 0 && b.x + b.width <= w + 0.5 && b.y + b.height <= h + 0.5;
export const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
