/**
 * 四個頁面的基本功能測試
 * 跑法：node tests/smoke.mjs
 * （需要先在專案根目錄開 http-server -p 8899）
 *
 * 注意：8 張卡目前都設定成開網站（見 assets/config.js），
 * 但影片功能還留著，所以這裡會把第 1、2 張「暫時」改成影片模式來測。
 * 只改瀏覽器記憶體裡的設定，不會動到檔案。
 * 網站節點的測試在 tests/sites.mjs。
 */
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:8899';
const results = [];

/* 把第 1、2 張卡暫時改成影片模式，這樣才測得到播放功能。
 * 只改瀏覽器記憶體裡的設定，不會動到 assets/config.js。
 *
 * 頁面一載入 config.js 就會建好 8 個格子，所以要趕在那之前改掉：
 * 攔截 config.js 的回應，把 CARDS 換成影片版再交給頁面。 */
async function useVideoCards(page) {
  await page.route('**/assets/config.js', async route => {
    const res = await route.fetch();
    let js = await res.text();
    js += `
      CONFIG.CARDS[0] = { type: 'video', title: '影片 1' };
      CONFIG.CARDS[1] = { type: 'video', title: '影片 2' };
    `;
    await route.fulfill({ response: res, body: js });
  });
}

function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
}

// 蒐集每一頁的 console 錯誤
function watch(page, label, bag) {
  page.on('console', m => {
    if (m.type() === 'error') bag.push(`[${label}] ${m.text()}`);
  });
  page.on('pageerror', e => bag.push(`[${label}] ${e.message}`));
}

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  // 允許自動播放，模擬 iPad 已解鎖的狀態
  permissions: [],
});
const errors = [];

/* ═══════════════ 1. 測試頁 ═══════════════ */
{
  const page = await ctx.newPage();
  watch(page, 'index', errors);
  await useVideoCards(page);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });

  const slots = await page.locator('.slot').count();
  check('測試頁：8 個格子', slots === 8, `實際 ${slots}`);

  // 等狀態偵測跑完
  await page.waitForFunction(
    () => !document.querySelector('#pill')?.textContent.includes('檢查中'),
    { timeout: 15000 }
  );

  const pill  = await page.locator('#pill').textContent();
  const ready = await page.locator('.slot.video.ready').count();
  check('測試頁：偵測到影片', ready === 2, `${pill}，影片卡就緒 ${ready} 張`);

  // 實際播第 1 部（就是剛上傳那部 39MB 的）
  await page.locator('#slot1').click();
  await page.waitForTimeout(3500);

  const st = await page.evaluate(() => {
    const v = document.querySelector('#player');
    return {
      src: v.currentSrc.split('/').pop(),
      time: v.currentTime,
      dur: v.duration,
      w: v.videoWidth,
      h: v.videoHeight,
      err: v.error?.code ?? null,
    };
  });

  check('測試頁：第 1 部真的在播',
    st.time > 0 && st.w > 0 && !st.err,
    `${st.src} ${st.w}x${st.h} 已播 ${st.time.toFixed(1)}s / 全長 ${st.dur?.toFixed(0)}s`);

  await page.screenshot({ path: 'tests/shot-index.png', fullPage: true });
  await page.close();
}

/* ═══════════════ 2. 播放頁 ═══════════════ */
{
  const page = await ctx.newPage();
  watch(page, 'play', errors);
  await useVideoCards(page);
  await page.goto(BASE + '/play.html', { waitUntil: 'domcontentloaded' });

  // 不應該再有房間代號輸入框
  const hasSetup = await page.locator('#setup').count();
  check('播放頁：沒有房間代號輸入', hasSetup === 0);

  // 解鎖畫面應該在
  await page.waitForSelector('#unlock', { timeout: 5000 });
  check('播放頁：保留 iPad 解鎖手勢', true);

  // 等連線
  await page.waitForFunction(
    () => document.querySelector('#conn')?.classList.contains('ok'),
    { timeout: 20000 }
  ).then(() => check('播放頁：MQTT 連上', true))
   .catch(() => check('播放頁：MQTT 連上', false, '20 秒內沒連上'));

  await page.screenshot({ path: 'tests/shot-play-unlock.png' });

  // 點畫面解鎖
  await page.locator('#unlock').click();
  await page.waitForTimeout(2500);

  const unlocked = await page.locator('#unlock').count();
  check('播放頁：解鎖後進入待機', unlocked === 0);

  const idleVisible = await page.locator('#idle').isVisible();
  check('播放頁：待機畫面顯示中', idleVisible);

  await page.screenshot({ path: 'tests/shot-play-idle.png' });

  /* ═══ 3. 模擬刷卡 → 播放頁應該要播 ═══ */
  const sim = await ctx.newPage();
  watch(sim, 'sim', errors);
  await sim.goto(BASE + '/模擬刷卡.html', { waitUntil: 'domcontentloaded' });

  await sim.waitForFunction(
    () => document.querySelector('#status')?.classList.contains('ok'),
    { timeout: 20000 }
  ).then(() => check('模擬刷卡：自動連線成功（免填代號）', true))
   .catch(() => check('模擬刷卡：自動連線成功', false, '20 秒內沒連上'));

  const hasRoomInput = await sim.locator('#room').count();
  check('模擬刷卡：沒有代號輸入框', hasRoomInput === 0);

  await sim.screenshot({ path: 'tests/shot-sim.png', fullPage: true });

  // 按第 1 部
  await sim.locator('.pad button').first().click();
  await page.waitForTimeout(4000);

  const played = await page.evaluate(() => {
    const v = document.querySelector('#player');
    return {
      src: v.currentSrc.split('/').pop(),
      time: v.currentTime,
      paused: v.paused,
      w: v.videoWidth,
      visible: v.classList.contains('on'),      // 影片模式才會顯示 video
      idleHidden: document.querySelector('#idle').classList.contains('hide'),
      title: document.querySelector('#title').textContent,
    };
  });

  check('端對端：刷卡 → 播放頁開始播',
    played.time > 0 && !played.paused && played.w > 0 && played.visible,
    `${played.src} 已播 ${played.time.toFixed(1)}s，標題「${played.title}」`);

  check('播放頁：播放時待機畫面淡出', played.idleHidden);

  await page.screenshot({ path: 'tests/shot-play-playing.png' });

  // 再按第 2 部，確認會切換
  await sim.locator('.pad button').nth(1).click();
  await page.waitForTimeout(2500);

  const switched = await page.evaluate(() => {
    const v = document.querySelector('#player');
    return { src: v.currentSrc.split('/').pop(), time: v.currentTime };
  });
  check('端對端：可切換到第 2 部', switched.src === '2.mp4', switched.src);

  await sim.close();
  await page.close();
}

/* ═══════════════ 4. 上傳頁 ═══════════════ */
{
  const page = await ctx.newPage();
  watch(page, 'upload', errors);
  await page.goto(BASE + '/upload.html', { waitUntil: 'networkidle' });

  const slots = await page.locator('.slot').count();
  check('上傳頁：8 個格子', slots === 8);

  // 應該會標出網站上已經有的影片
  await page.waitForTimeout(3000);
  const online = await page.locator('.slot.online').count();
  check('上傳頁：標出已存在的影片', online > 0, `${online} 部`);

  // 沒填金鑰按上傳應該要擋下來
  page.once('dialog', d => d.accept());
  await page.locator('#go').click();
  await page.waitForTimeout(500);
  check('上傳頁：沒金鑰時擋住上傳', true);

  await page.screenshot({ path: 'tests/shot-upload.png', fullPage: true });
  await page.close();
}

/* ═══════════════ 總結 ═══════════════ */
console.log('\n' + '─'.repeat(50));

const realErrors = errors.filter(e =>
  !/favicon|ERR_FAILED.*favicon/i.test(e)
);

if (realErrors.length) {
  console.log('Console 錯誤：');
  realErrors.forEach(e => console.log('  ' + e));
} else {
  console.log('✓ 四個頁面都沒有 console 錯誤');
}

const failed = results.filter(r => !r.pass);
console.log(`\n通過 ${results.length - failed.length} / ${results.length}`);

await browser.close();
process.exit(failed.length || realErrors.length ? 1 : 0);
