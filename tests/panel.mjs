/**
 * 測卡片設定台（upload.html）
 * 假裝自己是 GitHub API，驗證存檔流程真的送出正確的內容。
 *
 * 跑法：node tests/panel.mjs
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
const ctx = await browser.newContext({ viewport: { width: 1100, height: 950 } });

const errors = [];
const page = await ctx.newPage();
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(e.message));

/* ── 假裝自己是 GitHub ────────────────────────────────── */

const sent = { blobs: [], tree: null, commit: null, ref: null };

await page.route('https://api.github.com/**', async route => {
  const url = route.request().url();
  const method = route.request().method();
  const body = route.request().postData();

  const json = (obj, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });

  // 驗金鑰
  if (url.endsWith(`/repos/vin836/esp32-rfid-video`)) {
    return json({ permissions: { push: true } });
  }
  if (url.includes('/contents/raw')) return json([]);
  if (url.includes('/git/blobs')) {
    sent.blobs.push(JSON.parse(body));
    return json({ sha: 'blob' + sent.blobs.length });
  }
  if (url.includes('/git/ref/heads/')) return json({ object: { sha: 'base1' } });
  if (url.match(/\/git\/commits\/base1$/)) return json({ tree: { sha: 'tree0' } });
  if (url.includes('/git/trees')) {
    sent.tree = JSON.parse(body);
    return json({ sha: 'tree1' });
  }
  if (url.includes('/git/commits') && method === 'POST') {
    sent.commit = JSON.parse(body);
    return json({ sha: 'commit1' });
  }
  if (url.includes('/git/refs/heads/') && method === 'PATCH') {
    sent.ref = JSON.parse(body);
    return json({ ok: true });
  }
  if (url.includes('/actions/runs')) {
    return json({ workflow_runs: [{ status: 'completed', conclusion: 'success' }] });
  }
  return json({});
});

await page.goto(BASE + '/upload.html', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.cardrow', { timeout: 10000 });

/* ── 基本結構 ─────────────────────────────────────────── */

const rows = await page.locator('.cardrow').count();
check('8 張卡都列出來', rows === 8, `${rows} 列`);

const siteRows = await page.locator('.cardrow.site').count();
check('讀到目前的設定（8 張網站）', siteRows === 8, `${siteRows} 張網站`);

const t5 = await page.locator('#t5').inputValue();
const u5 = await page.locator('#u5').inputValue();
check('第 5 張是布農族網站',
  t5.includes('打耳祭') && u5.includes('framer.app'), `${t5} → ${u5.slice(0, 42)}`);

await page.screenshot({ path: 'tests/shot-panel.png', fullPage: true });

/* ── 修改網址 ─────────────────────────────────────────── */

await page.locator('#u1').fill('https://example.com/chapter-01');
await page.locator('#t1').fill('CHAPTER 01 · 新標題');
await page.waitForTimeout(400);

check('改過的那列會標記', await page.locator('#row1').getAttribute('class').then(c => c.includes('edited')));
check('狀態列顯示改了幾張',
  (await page.locator('#chipSum').textContent()).includes('1 張已修改'),
  (await page.locator('#chipSum').textContent()).trim());

/* ── 網址檢查 ─────────────────────────────────────────── */

await page.locator('#u2').fill('這不是網址');
await page.waitForTimeout(400);
check('填錯網址會標紅',
  await page.locator('#u2').getAttribute('class').then(c => c.includes('bad')));

await page.locator('#u2').fill('https://zh.wikipedia.org/wiki/測試');
await page.waitForTimeout(400);
const warn = await page.locator('#note2').innerText();
check('維基電腦版會提醒改手機版', warn.includes('zh.m.wikipedia.org'), warn.slice(0, 44));

await page.locator('#u2').fill('https://zh.m.wikipedia.org/wiki/布農語');
await page.waitForTimeout(400);
check('改成手機版後提醒消失',
  !(await page.locator('#note2').getAttribute('class')).includes('on'));

/* ── 切換成影片模式 ───────────────────────────────────── */

await page.locator('#row3 .mode-video').click();
await page.waitForTimeout(400);

check('可切換成影片模式',
  (await page.locator('#row3').getAttribute('class')).includes('video'));
check('影片模式顯示選檔案框', await page.locator('#f3').count() === 1);

// 切回網站，網址不該不見
await page.locator('#row3 .mode-site').click();
await page.waitForTimeout(400);
const u3 = await page.locator('#u3').inputValue();
check('切回網站時網址還在', u3.includes('八部合音') || u3.includes('wikipedia'), u3.slice(0, 40));

// 再切成影片，等下要測上傳
await page.locator('#row3 .mode-video').click();
await page.waitForTimeout(300);

/* ── 拖非影片檔要擋 ───────────────────────────────────── */

const alerts = [];
page.on('dialog', async d => { alerts.push(d.message()); await d.accept(); });

await page.evaluate(() => {
  const dt = new DataTransfer();
  dt.items.add(new File(['<html>x</html>'], 'page.html', { type: 'text/html' }));
  document.querySelector('#row3').dispatchEvent(
    new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
});
await page.waitForTimeout(500);
check('拖網頁檔進來會被擋', alerts.some(a => a.includes('不是影片檔')));

/* ── 拖影片檔要收下 ───────────────────────────────────── */

alerts.length = 0;
await page.evaluate(() => {
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array(300000)], 'story3.mp4', { type: 'video/mp4' }));
  document.querySelector('#row3').dispatchEvent(
    new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
});
await page.waitForTimeout(600);
check('拖影片進來會收下',
  alerts.length === 0 && (await page.locator('#f3').getAttribute('class')).includes('has'),
  (await page.locator('#f3').innerText()).slice(0, 34));

/* ── 儲存 ─────────────────────────────────────────────── */

await page.locator('#token').fill('ghp_faketoken_for_test');
await page.locator('#go').click();

await page.waitForFunction(
  () => document.querySelector('#log')?.innerText.includes('儲存完成'),
  { timeout: 30000 }
).then(() => check('儲存流程跑完', true))
 .catch(async () => check('儲存流程跑完', false,
   (await page.locator('#log').innerText()).split('\n').slice(-2).join(' ')));

/* ── 驗證送出去的內容 ─────────────────────────────────── */

console.log('\n── 送給 GitHub 的內容 ──');

const paths = (sent.tree?.tree || []).map(t => t.path);
check('有寫 cards.json', paths.includes('assets/cards.json'), paths.join(', '));
check('有傳影片', paths.some(p => p.startsWith('raw/3.')), paths.join(', '));
check('只送一次 commit', sent.commit !== null && sent.ref?.sha === 'commit1');

// 把 cards.json 的內容解回來檢查
const cfgBlob = sent.blobs.find(b => {
  try { return JSON.parse(atobNode(b.content)).cards; } catch { return false; }
});

function atobNode(b64) {
  return Buffer.from(b64, 'base64').toString('utf8');
}

if (cfgBlob) {
  const saved = JSON.parse(atobNode(cfgBlob.content));
  check('存的是 8 張卡', saved.cards?.length === 8, `${saved.cards?.length} 張`);
  check('第 1 張網址存對了',
    saved.cards[0].url === 'https://example.com/chapter-01', saved.cards[0].url);
  check('第 1 張標題存對了',
    saved.cards[0].title === 'CHAPTER 01 · 新標題', saved.cards[0].title);
  check('第 3 張已改成影片模式',
    saved.cards[2].type === 'video', saved.cards[2].type);
  check('中文沒有變成亂碼',
    saved.cards[4].title.includes('打耳祭'), saved.cards[4].title);
} else {
  check('cards.json 內容正確', false, '找不到設定的 blob');
}

/* ── 存完之後標記要歸零 ───────────────────────────────── */

await page.waitForTimeout(600);
check('存完後「已修改」標記清除',
  (await page.locator('#chipSum').textContent()).includes('尚未修改'),
  (await page.locator('#chipSum').textContent()).trim());

await page.screenshot({ path: 'tests/shot-panel-saved.png', fullPage: true });

/* ── 總結 ─────────────────────────────────────────────── */

console.log('\n' + '─'.repeat(52));
const realErrors = errors.filter(e => !/favicon/i.test(e));
if (realErrors.length) {
  console.log('Console 錯誤：');
  [...new Set(realErrors)].forEach(e => console.log('  ' + e));
} else {
  console.log('✓ 沒有 console 錯誤');
}

const failed = results.filter(r => !r.pass);
console.log(`\n通過 ${results.length - failed.length} / ${results.length}`);
if (failed.length) failed.forEach(f => console.log('  ✗ ' + f.name));

await browser.close();
process.exit(failed.length || realErrors.length ? 1 : 0);
