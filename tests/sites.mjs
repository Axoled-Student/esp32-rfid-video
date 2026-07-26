/**
 * 測 8 張卡的網站節點
 * 用 iPad 尺寸跑，確認展示現場的實際狀況
 *
 * 跑法：node tests/sites.mjs
 * （需要先在專案根目錄開 http-server -p 8899）
 */
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:8899';
const results = [];

function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
}

const browser = await chromium.launch();

// iPad Pro 11" 橫向，展示時最可能的尺寸
const ctx = await browser.newContext({
  viewport: { width: 1194, height: 834 },
  deviceScaleFactor: 2,
  isMobile: false,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
             '(KHTML, like Gecko) Version/17.0 Safari/605.1.15',
});

const errors = [];

/* ═══════════════ 播放頁 ═══════════════ */

const page = await ctx.newPage();
page.on('console', m => {
  if (m.type() !== 'error') return;
  const t = m.text();
  // 嵌入的外部網站自己的錯誤不算我們的問題
  if (/wikipedia|framer|wikimedia|favicon|Failed to load resource/i.test(t)) return;
  errors.push('[play] ' + t);
});
page.on('pageerror', e => {
  if (/wikipedia|framer/i.test(e.message)) return;
  errors.push('[play] ' + e.message);
});

await page.goto(BASE + '/play.html', { waitUntil: 'domcontentloaded' });

await page.waitForFunction(
  () => document.querySelector('#conn')?.classList.contains('ok'),
  { timeout: 25000 }
).then(() => check('播放頁：MQTT 連上', true))
 .catch(() => check('播放頁：MQTT 連上', false, '25 秒沒連上'));

await page.locator('#unlock').click();
await page.waitForTimeout(2000);
check('播放頁：解鎖進入待機', await page.locator('#unlock').count() === 0);

/* ═══════════════ 模擬刷卡 ═══════════════ */

const sim = await ctx.newPage();
await sim.goto(BASE + '/模擬刷卡.html', { waitUntil: 'domcontentloaded' });
await sim.waitForFunction(
  () => document.querySelector('#status')?.classList.contains('ok'),
  { timeout: 25000 }
);
check('模擬刷卡：連線成功', true);

/* ═══════════════ 逐張刷卡測試 ═══════════════ */

// 讀出設定，測試才知道每張卡該是什麼
const cards = await page.evaluate(() =>
  Array.from({ length: CONFIG.COUNT }, (_, i) => cardOf(i + 1))
);

console.log('\n── 逐張刷卡 ──');

let siteOk = 0, siteFail = 0;

for (let n = 1; n <= cards.length; n++) {
  const card = cards[n - 1];

  await sim.locator('.pad button').nth(n - 1).click();

  // 等載入完成（iframe onload 後會把 loading 收起來）或跳出「開不起來」
  const state = await page.waitForFunction(() => {
    const l = document.querySelector('#loading');
    const o = document.querySelector('#oops');
    const s = document.querySelector('#site');
    const v = document.querySelector('#player');
    if (o?.classList.contains('on')) return 'blocked';
    if (l?.classList.contains('on')) return false;         // 還在載，繼續等
    if (s?.classList.contains('show')) return 'site';
    if (v?.classList.contains('on') && !v.paused) return 'video';
    return false;
  }, { timeout: 30000 }).then(h => h.jsonValue()).catch(() => 'timeout');

  const want = card.type;
  const ok = state === want;

  if (card.type === 'site') { ok ? siteOk++ : siteFail++; }

  const detail = await page.evaluate(() => {
    const s = document.querySelector('#site');
    return {
      src: s.getAttribute('src') || '',
      title: document.querySelector('#title').textContent,
      // iframe 有沒有真的撐滿畫面（iPad 適配的關鍵）
      w: s.getBoundingClientRect().width,
      h: s.getBoundingClientRect().height,
    };
  });

  check(
    `第 ${n} 張：${card.title}`,
    ok,
    state === 'blocked' ? '網站拒絕嵌入' :
    state === 'timeout' ? '逾時' :
    `${state}  ${detail.w}x${detail.h}`
  );
}

/* ═══════════════ iPad 尺寸適配 ═══════════════ */

console.log('\n── iPad 版面 ──');

const fit = await page.evaluate(() => {
  const s = document.querySelector('#site').getBoundingClientRect();
  return {
    site: { w: Math.round(s.width), h: Math.round(s.height) },
    win:  { w: window.innerWidth, h: window.innerHeight },
    scrollX: document.documentElement.scrollWidth > window.innerWidth,
    scrollY: document.documentElement.scrollHeight > window.innerHeight,
  };
});

check('橫向：網站滿版',
  fit.site.w === fit.win.w && fit.site.h === fit.win.h,
  `${fit.site.w}x${fit.site.h} / 畫面 ${fit.win.w}x${fit.win.h}`);
check('橫向：沒有多餘捲軸', !fit.scrollX && !fit.scrollY);

await page.screenshot({ path: 'tests/shot-site-landscape.png' });

// 轉直向，iPad 立起來也要好看
await page.setViewportSize({ width: 834, height: 1194 });
await page.waitForTimeout(1200);

const fitP = await page.evaluate(() => {
  const s = document.querySelector('#site').getBoundingClientRect();
  return {
    w: Math.round(s.width), h: Math.round(s.height),
    winW: window.innerWidth, winH: window.innerHeight,
    scrollX: document.documentElement.scrollWidth > window.innerWidth,
  };
});

check('直向：網站滿版',
  fitP.w === fitP.winW && fitP.h === fitP.winH,
  `${fitP.w}x${fitP.h} / 畫面 ${fitP.winW}x${fitP.winH}`);
check('直向：沒有橫向捲軸', !fitP.scrollX);

await page.screenshot({ path: 'tests/shot-site-portrait.png' });
await page.setViewportSize({ width: 1194, height: 834 });

/* ═══════════════ 連續切換 ═══════════════ */

console.log('\n── 連續刷卡 ──');

await sim.locator('.pad button').nth(4).click();     // 第 5 張（你的網站）
await page.waitForTimeout(6000);
const a = await page.evaluate(() => document.querySelector('#site').getAttribute('src'));

await sim.locator('.pad button').nth(0).click();     // 第 1 張
await page.waitForTimeout(6000);
const b = await page.evaluate(() => document.querySelector('#site').getAttribute('src'));

check('可連續切換不同網站', a !== b && !!a && !!b,
  `${a?.split('/').pop()?.slice(0, 24)} → ${b?.split('/').pop()?.slice(0, 24)}`);

// 先等它進入閒置狀態（控制項淡掉），模擬展示現場放著沒動的樣子
await page.waitForFunction(
  () => document.body.classList.contains('calm'), { timeout: 8000 }
).catch(() => {});
check('閒置後控制項自動淡出',
  await page.evaluate(() => document.body.classList.contains('calm')));

// 碰一下頂部喚醒條，控制項要回來（iframe 蓋住畫面時的唯一出路）
await page.mouse.move(600, 20);
await page.waitForTimeout(500);
check('頂部喚醒條能叫回控制項',
  await page.evaluate(() => !document.body.classList.contains('calm')));

await page.locator('#home').click();
await page.waitForTimeout(800);
const backHome = await page.evaluate(() =>
  !document.querySelector('#idle').classList.contains('hide') &&
  !document.querySelector('#site').classList.contains('on')
);
check('「回待機」鈕正常', backHome);

/* ═══════════════ 測試頁 ═══════════════ */

console.log('\n── 測試頁 ──');

const idx = await ctx.newPage();
await idx.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await idx.waitForFunction(
  () => !document.querySelector('#pill')?.textContent.includes('檢查中'),
  { timeout: 20000 }
);

const siteSlots = await idx.locator('.slot.site').count();
check('測試頁：標出網站卡', siteSlots === 8, `${siteSlots} 張`);
check('測試頁：狀態列', true, (await idx.locator('#pill').textContent()).trim() +
  ' · ' + (await idx.locator('#summaryText').innerText()).trim().slice(0, 40));

await idx.locator('#slot5').click();
await idx.waitForTimeout(5000);
const previewOk = await idx.evaluate(() =>
  document.querySelector('#site').classList.contains('on'));
check('測試頁：可預覽網站', previewOk);

await idx.screenshot({ path: 'tests/shot-index-sites.png', fullPage: true });

/* ═══════════════ 上傳頁 ═══════════════ */

const up = await ctx.newPage();
await up.goto(BASE + '/upload.html', { waitUntil: 'domcontentloaded' });
await up.waitForTimeout(2500);
const noteVisible = await up.locator('#siteNote').isVisible();
check('上傳頁：提醒有網站卡', noteVisible,
  (await up.locator('#siteNote').innerText()).slice(0, 46));

await up.screenshot({ path: 'tests/shot-upload-sites.png', fullPage: true });

/* ═══════════════ 總結 ═══════════════ */

console.log('\n' + '─'.repeat(52));
console.log(`網站卡：${siteOk} 張開得起來，${siteFail} 張開不起來`);

if (errors.length) {
  console.log('\nConsole 錯誤：');
  [...new Set(errors)].forEach(e => console.log('  ' + e));
} else {
  console.log('✓ 沒有 console 錯誤');
}

const failed = results.filter(r => !r.pass);
console.log(`\n通過 ${results.length - failed.length} / ${results.length}`);
if (failed.length) {
  console.log('未通過：');
  failed.forEach(f => console.log('  ✗ ' + f.name));
}

await browser.close();
process.exit(failed.length ? 1 : 0);
