/**
 * 測 ESP32 設定畫面（從韌體裡抽出來的那頁 HTML）
 * 模擬手機連上熱點後看到的樣子，並假裝板子回應 /scan、/save
 */
import { chromium } from 'playwright';

// 從本地 server 載入，相對路徑 /scan、/save 才有 base URL 可以攔截
const URL = 'http://127.0.0.1:8899/tests/tmp/setup.html';
const results = [];

function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },      // iPhone 尺寸，設定通常用手機做
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});

const errors = [];
const page = await ctx.newPage();
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(e.message));

/* 假裝自己是 ESP32，回應網頁發出的請求 */
let savedBody = null;
let failFirst = true;

await page.route('**/scan', route => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify([
    { s: '家裡的WiFi',        r: -42, e: 1 },
    { s: 'TP-Link_5G',        r: -58, e: 1 },
    { s: '鄰居家 の Wi-Fi "特殊"', r: -75, e: 1 },
    { s: 'FreeWiFi',          r: -80, e: 0 },
  ]),
}));

await page.route('**/save', async route => {
  savedBody = route.request().postData();
  // 第一次故意回失敗，測錯誤訊息有沒有正確顯示
  const body = failFirst
    ? { ok: false, why: '密碼可能不對' }
    : { ok: true };
  failFirst = false;
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
});

await page.goto(URL, { waitUntil: 'domcontentloaded' });

/* ── 1. 全繁中，沒有殘留英文 ─────────────────────────── */
const bodyText = await page.locator('body').innerText();
const badWords = ['Configure', 'Config', 'Save', 'Scan', 'Password', 'Connect',
                  'Setup', 'Submit', 'Refresh', 'Manual', 'Enter'];
const found = badWords.filter(w => new RegExp('\\b' + w + '\\b').test(bodyText));
check('介面沒有英文殘留', found.length === 0, found.join(', ') || '全繁中');

/* ── 2. 掃描結果有出來 ───────────────────────────────── */
await page.waitForFunction(
  () => document.querySelector('#ssidList').options.length > 2,
  { timeout: 5000 }
);
const opts = await page.locator('#ssidList option').allTextContents();
check('掃描到 Wi-Fi 清單', opts.length === 5, `${opts.length - 1} 個`);
check('訊號強度用格數顯示', opts[1].includes('●'), opts[1].trim());
check('加密的有鎖頭、開放的沒有',
  opts[1].includes('🔒') && !opts[4].includes('🔒'));
check('名稱含引號也不會壞', opts.some(o => o.includes('特殊')));

/* ── 3. 顯示密碼 ─────────────────────────────────────── */
await page.locator('#pass').fill('mypassword');
await page.locator('#show').check();
const type1 = await page.locator('#pass').getAttribute('type');
await page.locator('#show').uncheck();
const type2 = await page.locator('#pass').getAttribute('type');
check('可切換顯示密碼', type1 === 'text' && type2 === 'password');

/* ── 4. 手動輸入名稱 ─────────────────────────────────── */
await page.locator('#manual').check();
check('勾選後出現手動輸入框', await page.locator('#ssidManual').isVisible());
await page.locator('#manual').uncheck();

/* ── 5. 沒選 Wi-Fi 就送出，要擋下來 ──────────────────── */
await page.locator('#save').click();
await page.waitForTimeout(300);
const m1 = await page.locator('#msg').textContent();
check('沒選 Wi-Fi 會擋下來', m1.includes('請先選'), m1);

await page.screenshot({ path: 'tests/shot-esp-setup.png', fullPage: true });

/* ── 6. 選好送出 → 板子回失敗 ────────────────────────── */
await page.selectOption('#ssidList', '家裡的WiFi');
await page.locator('#pass').fill('wrongpass');
await page.locator('#save').click();
await page.waitForTimeout(600);

const m2 = await page.locator('#msg').textContent();
check('連線失敗會顯示原因', m2.includes('密碼可能不對'), m2);
check('失敗後按鈕可以再按', !(await page.locator('#save').isDisabled()));
check('有提醒 2.4GHz', m2.includes('2.4GHz'));

/* ── 7. 再送一次 → 板子回成功 ────────────────────────── */
await page.locator('#save').click();
await page.waitForTimeout(600);

const m3 = await page.locator('#msg').textContent();
check('連線成功會顯示成功訊息', m3.includes('成功'), m3);

// 確認送出去的資料格式對
check('送出的資料格式正確',
  savedBody?.includes('ssid=') && savedBody?.includes('pass='),
  savedBody);

// 中文 SSID 要正確編碼，不然板子會收到亂碼
const parsed = new URLSearchParams(savedBody);
check('中文 Wi-Fi 名稱編碼正確', parsed.get('ssid') === '家裡的WiFi', parsed.get('ssid'));

await page.screenshot({ path: 'tests/shot-esp-setup-done.png', fullPage: true });

/* ── 總結 ────────────────────────────────────────────── */
console.log('\n' + '─'.repeat(50));
if (errors.length) {
  console.log('Console 錯誤：');
  errors.forEach(e => console.log('  ' + e));
} else {
  console.log('✓ 設定畫面沒有 console 錯誤');
}

const failed = results.filter(r => !r.pass);
console.log(`\n通過 ${results.length - failed.length} / ${results.length}`);

await browser.close();
process.exit(failed.length || errors.length ? 1 : 0);
