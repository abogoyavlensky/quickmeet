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
// A second camera, on the back. The headless shell has one fake camera
// (fake_device_0, 16:9), so the switch-camera button would never show.
// This adds "Back Camera" to the device list and answers any request for
// it, by deviceId 'back' or by facingMode 'environment', with a 4:3
// canvas whose settings say so; the other side tells the two apart by
// shape. Every other video request goes to the fake device with its
// facingMode dropped: the fake device refuses an exact one. `backFails`
// makes the back camera refuse to start; `backDelay` (ms) makes it slow
// to answer, either way.
export const twoCameras = ({ backFails = false, backDelay = 0 } = {}) => async context => {
  await context.addInitScript(({ backFails, backDelay }) => {
    const back = { deviceId: 'back', groupId: '', kind: 'videoinput', label: 'Back Camera' };
    back.toJSON = () => ({ ...back });
    const devices = navigator.mediaDevices;
    const realEnumerate = devices.enumerateDevices.bind(devices);
    devices.enumerateDevices = async () => [...await realEnumerate(), back];

    const backTrack = () => {
      const canvas = Object.assign(document.createElement('canvas'), { width: 640, height: 480 });
      const g = canvas.getContext('2d');
      let n = 0;
      setInterval(() => {
        g.fillStyle = `hsl(${(n++ * 7) % 360} 60% 50%)`;
        g.fillRect(0, 0, 640, 480);
      }, 66);
      const track = canvas.captureStream(15).getVideoTracks()[0];
      const settings = track.getSettings.bind(track);
      track.getSettings = () => ({ ...settings(), deviceId: 'back', facingMode: 'environment', width: 640, height: 480 });
      track.applyConstraints = async () => {};
      Object.defineProperty(track, 'label', { value: 'Back Camera' });
      return track;
    };
    // A constraint is a value, or { exact } or { ideal }.
    const valueOf = c => (c && typeof c === 'object' ? (c.exact !== undefined ? c.exact : c.ideal) : c);

    const realGet = devices.getUserMedia.bind(devices);
    devices.getUserMedia = async constraints => {
      const video = constraints && constraints.video;
      if (!video || typeof video !== 'object') return realGet(constraints);
      const wantsBack = valueOf(video.deviceId) === 'back' || valueOf(video.facingMode) === 'environment';
      if (!wantsBack) {
        const { facingMode, ...rest } = video;
        return realGet({ ...constraints, video: rest });
      }
      if (backDelay) await new Promise(r => setTimeout(r, backDelay));
      if (backFails) throw new DOMException('no such camera', 'OverconstrainedError');
      const stream = constraints.audio ? await realGet({ audio: constraints.audio }) : new MediaStream();
      stream.addTrack(backTrack());
      return stream;
    };
  }, { backFails, backDelay });
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
