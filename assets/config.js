/* ══════════════════════════════════════════════════════════
 *  全站設定 —— 要改東西，改這裡就好
 *
 *  8 張卡各自開什麼，不在這裡 —— 在 assets/cards.json，
 *  用設定面板（upload.html）改比較方便，不用碰程式碼。
 * ══════════════════════════════════════════════════════════ */

const CONFIG = {

  // ── 房間代號 ──────────────────────────────────────────
  // 這串要跟 ESP32 程式裡的 ROOM 一模一樣，兩邊才連得上。
  // 平常不用動；除非你要同時跑好幾組互不干擾的展示。
  ROOM: 'vin836-rfid-8x2f',

  // ── MQTT 中繼站 ───────────────────────────────────────
  // 免費公共伺服器，讓平板跟 ESP32 不用連同一個 Wi-Fi
  MQTT_URL: 'wss://broker.hivemq.com:8884/mqtt',

  // ── GitHub 倉庫（設定面板用）──────────────────────────
  OWNER:  'vin836',
  REPO:   'esp32-rfid-video',
  BRANCH: 'main',

  // ── 卡片數量 ──────────────────────────────────────────
  COUNT: 8,

  // 卡片設定，開頁時從 cards.json 載進來
  CARDS: [],
};

// 訂閱／發布用的頻道名稱
CONFIG.TOPIC = 'esp32rfid/' + CONFIG.ROOM;


/* ── 小工具，各頁共用 ──────────────────────────────────── */

const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

// 1 ~ COUNT 的陣列，拿來跑迴圈
const SLOTS = Array.from({ length: CONFIG.COUNT }, (_, i) => i + 1);

// 拿第 n 張卡的設定（n 從 1 開始）。沒設定的就當成影片。
function cardOf(n) {
  return CONFIG.CARDS[n - 1] || { type: 'video', title: `影片 ${n}` };
}

// 建立 MQTT 連線（各頁設定一致，避免各寫各的）
function connectMqtt(prefix) {
  return mqtt.connect(CONFIG.MQTT_URL, {
    clientId:       prefix + '-' + Math.random().toString(16).slice(2, 10),
    reconnectPeriod: 3000,
    connectTimeout:  10000,
    clean:           true,
  });
}


/* ══════════════════════════════════════════════════════════
 *  載入卡片設定
 *
 *  每一頁都要先 await loadCards() 再開始建畫面，
 *  否則會拿到空的設定。
 * ══════════════════════════════════════════════════════════ */

async function loadCards() {
  try {
    // 加時間戳記，避免瀏覽器拿到舊的快取（剛改完設定馬上要看到）
    const r = await fetch('assets/cards.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);

    const data = await r.json();
    if (Array.isArray(data.cards)) CONFIG.CARDS = data.cards;

  } catch (e) {
    // 讀不到就全部當影片處理，至少不會整頁掛掉
    console.warn('讀取 cards.json 失敗，改用預設值', e);
    CONFIG.CARDS = SLOTS.map(n => ({ type: 'video', title: `影片 ${n}` }));
  }

  return CONFIG.CARDS;
}
