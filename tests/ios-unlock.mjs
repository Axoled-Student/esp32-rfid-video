/**
 * 驗證「點一下解鎖」在 iPad Safari 上到底有沒有效
 *
 * ── 為什麼要自己模擬 ──────────────────────────────────
 * 桌面瀏覽器（含 Playwright 的 WebKit）預設都允許自動播放，
 * 直接測會全部通過，看不出真實 iOS 的問題。
 * 所以這裡攔截 video.play()，自己照 iOS 的規則判斷：
 *
 *   1. 靜音播放 → 一律允許（iOS 本來就不擋靜音）
 *   2. 有聲播放 → 必須「曾經在使用者手勢的同步執行期間，
 *                 對同一個 <video> 成功呼叫過不靜音的 play()」
 *   3. 手勢的授權效力只在該事件的同步期間；
 *      一旦 await / setTimeout 就過期了
 *   4. load() 會把已取得的授權清掉
 *
 * 這幾條就是 iOS 實際的行為，也是最容易踩雷的地方。
 *
 * 跑法：node tests/ios-unlock.mjs
 * （需要先在專案根目錄開 http-server -p 8899）
 */
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:8899';
const results = [];

function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? '\n     ' + detail : ''}`);
}

/* ── 注入 iOS 的播放規則 ─────────────────────────────── */

const IOS_RULES = `
(() => {
  const proto = HTMLMediaElement.prototype;
  const realPlay = proto.play;

  // 這個元素拿到有聲播放許可了沒
  const blessed = new WeakSet();

  // 現在是不是在「使用者手勢的同步執行期間」
  let inGesture = false;

  // 手勢期間 = 整個事件派發過程（捕獲 → 目標 → 冒泡）。
  // 用捕獲階段開啟，冒泡到 window 之後才關閉，
  // 這樣頁面上任何一層的監聽器都還在手勢期間內
  // —— 跟真實瀏覽器一致。
  ['click', 'touchend', 'pointerup', 'keydown'].forEach(ev => {
    window.addEventListener(ev, () => { inGesture = true; }, true);   // 捕獲，最先
    window.addEventListener(ev, () => {
      // 冒泡到最外層才結束；再用 setTimeout 確保同一輪的同步碼都跑完
      setTimeout(() => { inGesture = false; }, 0);
    }, false);
  });

  window.__ios = {
    blessed: el => blessed.has(el),
    denials: [],
  };

  proto.play = function () {
    // 靜音播放：iOS 一律允許，但也不會換到任何許可
    if (this.muted || this.volume === 0) {
      return realPlay.call(this);
    }

    // 有聲播放：要嘛在手勢期間，要嘛之前已經拿過許可
    if (inGesture) {
      blessed.add(this);          // 手勢中成功播出聲音 → 從此獲得許可
      return realPlay.call(this);
    }

    if (blessed.has(this)) {
      return realPlay.call(this);
    }

    window.__ios.denials.push(new Error().stack?.split('\\n')[2]?.trim() || '?');
    const err = new DOMException(
      "play() failed because the user didn't interact with the document first.",
      'NotAllowedError'
    );
    return Promise.reject(err);
  };

  // load() 會重置元素，許可也跟著沒了
  const realLoad = proto.load;
  proto.load = function () {
    blessed.delete(this);
    return realLoad.call(this);
  };
})();
`;

const browser = await chromium.launch();

async function newIosPage(videoCards = [1]) {
  const ctx = await browser.newContext({
    viewport: { width: 1194, height: 834 },
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
               '(KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  });

  // 規則要在頁面任何腳本之前就裝好
  await ctx.addInitScript(IOS_RULES);

  const page = await ctx.newPage();

  // 把指定的卡改成影片模式，才測得到播放
  await page.route('**/assets/cards.json*', async route => {
    const res = await route.fetch();
    const d = JSON.parse(await res.text());
    videoCards.forEach(n => { d.cards[n - 1] = { type: 'video', title: '影片 ' + n }; });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(d) });
  });

  return { ctx, page };
}

console.log('模擬 iPad Safari 的自動播放限制\n');

/* ══════════════════════════════════════════════════
 *  0. 先確認模擬本身是對的
 * ══════════════════════════════════════════════════ */

{
  const { ctx, page } = await newIosPage();
  await page.goto(BASE + '/play.html', { waitUntil: 'domcontentloaded' });

  const r = await page.evaluate(async () => {
    const mk = muted => {
      const v = document.createElement('video');
      v.src = 'videos/1.mp4'; v.muted = muted;
      document.body.appendChild(v);
      return v;
    };
    const test = async v => {
      try { await v.play(); return 'ALLOWED'; } catch (e) { return 'BLOCKED'; }
    };
    return { loud: await test(mk(false)), quiet: await test(mk(true)) };
  });

  check('模擬正確：無手勢＋有聲 → 擋住', r.loud === 'BLOCKED', r.loud);
  check('模擬正確：無手勢＋靜音 → 允許', r.quiet === 'ALLOWED', r.quiet);

  // 關鍵：模擬必須抓得出「await 之後才 play」這個典型錯誤，
  // 否則測試會變成橡皮圖章，什麼都測不出來
  const strict = await page.evaluate(() => new Promise(resolve => {
    const v = document.createElement('video');
    v.src = 'videos/2.mp4';
    document.body.appendChild(v);

    const btn = document.createElement('button');
    document.body.appendChild(btn);

    btn.addEventListener('click', async () => {
      await new Promise(r => setTimeout(r, 30));    // 手勢在這裡就過期了
      try { await v.play(); resolve('ALLOWED'); }
      catch { resolve('BLOCKED'); }
    });
    btn.click();
  }));

  check('模擬正確：手勢後 await 再 play → 擋住（不然測不出真問題）',
    strict === 'BLOCKED', strict);

  // 也要確認「舊版那種靜音解鎖」抓得出來
  const oldWay = await page.evaluate(() => new Promise(resolve => {
    const v = document.createElement('video');
    v.src = 'videos/2.mp4';
    document.body.appendChild(v);

    const btn = document.createElement('button');
    document.body.appendChild(btn);

    btn.addEventListener('click', async () => {
      v.muted = true;
      try { await v.play(); v.pause(); } catch {}
      v.muted = false;
      // 之後不用手勢，想播有聲的
      setTimeout(async () => {
        try { await v.play(); resolve('ALLOWED'); }
        catch { resolve('BLOCKED'); }
      }, 100);
    });
    btn.click();
  }));

  check('模擬正確：靜音解鎖換不到有聲許可 → 擋住',
    oldWay === 'BLOCKED', oldWay);

  await ctx.close();
}

/* ══════════════════════════════════════════════════
 *  1. 真正的問題：解鎖後刷卡，影片有沒有聲音？
 * ══════════════════════════════════════════════════ */

console.log('\n── 目前的解鎖流程 ──');

{
  const { ctx, page } = await newIosPage();
  await page.goto(BASE + '/play.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#unlock', { timeout: 10000 });

  // 像使用者一樣真的用手指點
  await page.locator('#unlock').tap();
  await page.waitForTimeout(2000);

  const blessed = await page.evaluate(() =>
    window.__ios.blessed(document.querySelector('#player')));

  check('解鎖真的換到「有聲播放」許可', blessed,
    blessed ? '播放器已獲得授權'
            : '播放器沒拿到授權 —— 刷卡時影片會播不出來或沒聲音');

  // 模擬 ESP32 送訊息過來（完全沒有使用者手勢）
  const played = await page.evaluate(async () => {
    open(1);
    await new Promise(r => setTimeout(r, 3000));
    const v = document.querySelector('#player');
    return {
      paused: v.paused, time: v.currentTime, muted: v.muted,
      idleBack: !document.querySelector('#idle').classList.contains('hide'),
      msg: document.querySelector('#idleMsg')?.textContent,
      denials: window.__ios.denials.length,
    };
  });

  const ok = !played.paused && played.time > 0 && !played.muted;
  check('刷卡後影片有播、而且有聲音', ok,
    `播放中=${!played.paused}  已播=${played.time.toFixed(1)}s  靜音=${played.muted}` +
    (played.idleBack ? `\n     → 退回待機了，畫面顯示：「${played.msg}」` : '') +
    (played.denials ? `\n     → 被 iOS 擋下 ${played.denials} 次` : ''));

  await page.screenshot({ path: 'tests/shot-ios-result.png' });
  await ctx.close();
}

/* ══════════════════════════════════════════════════
 *  2. 換第二部影片時，許可還在嗎？
 *     （播放頁換片會設 src + load()）
 * ══════════════════════════════════════════════════ */

console.log('\n── 連續刷兩張影片卡 ──');

{
  const { ctx, page } = await newIosPage([1, 2]);
  await page.goto(BASE + '/play.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#unlock', { timeout: 10000 });
  await page.locator('#unlock').tap();
  await page.waitForTimeout(1500);

  const r = await page.evaluate(async () => {
    open(1);
    await new Promise(r => setTimeout(r, 2500));
    const first = document.querySelector('#player').currentTime;

    open(2);                       // 換片，內部會 load()
    await new Promise(r => setTimeout(r, 2500));
    const v = document.querySelector('#player');

    return {
      first,
      second: v.currentTime,
      src: v.getAttribute('src'),
      paused: v.paused,
      muted: v.muted,
    };
  });

  check('第 1 部播得動', r.first > 0, `已播 ${r.first.toFixed(1)}s`);
  check('換到第 2 部還是播得動（許可沒掉）',
    r.second > 0 && !r.paused,
    `${r.src}  已播 ${r.second.toFixed(1)}s  靜音=${r.muted}`);

  await ctx.close();
}

/* ══════════════════════════════════════════════════ */

console.log('\n' + '─'.repeat(58));
const failed = results.filter(r => !r.pass);
console.log(`通過 ${results.length - failed.length} / ${results.length}`);
if (failed.length) {
  console.log('\n未通過：');
  failed.forEach(f => console.log('  ✗ ' + f.name));
}

await browser.close();
process.exit(failed.length ? 1 : 0);
