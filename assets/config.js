/* ══════════════════════════════════════════════════════════
 *  全站設定 —— 要改東西，改這裡就好
 * ══════════════════════════════════════════════════════════ */

const CONFIG = {

  // ── 房間代號 ──────────────────────────────────────────
  // 這串要跟 ESP32 程式裡的 ROOM 一模一樣，兩邊才連得上。
  // 平常不用動；除非你要同時跑好幾組互不干擾的展示。
  ROOM: 'vin836-rfid-8x2f',

  // ── MQTT 中繼站 ───────────────────────────────────────
  // 免費公共伺服器，讓平板跟 ESP32 不用連同一個 Wi-Fi
  MQTT_URL: 'wss://broker.hivemq.com:8884/mqtt',

  // ── GitHub 倉庫（上傳面板用）──────────────────────────
  OWNER:  'vin836',
  REPO:   'esp32-rfid-video',
  BRANCH: 'main',

  // ── 影片數量 ──────────────────────────────────────────
  COUNT: 8,
};


/* ══════════════════════════════════════════════════════════
 *  8 張卡各自要做什麼
 *  ─────────────────────────────────────────────────────────
 *  type: 'site'  → 刷卡打開網站
 *        'video' → 刷卡播放 videos/N.mp4
 *
 *  之後拿到正式網址，把下面的 url 換掉就好，其他都不用動。
 *
 *  ⚠ 有些網站不准被嵌入（維基百科的電腦版、YouTube、Google…），
 *    畫面會一片空白。維基百科要用手機版 zh.m.wikipedia.org 才行。
 *    不確定的話，先在播放頁刷刷看，不能嵌的會跳提示。
 * ══════════════════════════════════════════════════════════ */

CONFIG.CARDS = [
  // 第 1 張
  {
    type:  'site',
    title: 'CHAPTER 01 · 布農族',
    url:   'https://zh.m.wikipedia.org/wiki/布農族',
  },
  // 第 2 張
  {
    type:  'site',
    title: 'CHAPTER 02 · 布農語',
    url:   'https://zh.m.wikipedia.org/wiki/布農語',
  },
  // 第 3 張
  {
    type:  'site',
    title: 'CHAPTER 03 · 八部合音',
    url:   'https://zh.m.wikipedia.org/wiki/八部合音',
  },
  // 第 4 張
  {
    type:  'site',
    title: 'CHAPTER 04 · 小米',
    url:   'https://zh.m.wikipedia.org/wiki/小米',
  },
  // 第 5 張 ← 這張是正式的，其他都還是佔位
  {
    type:  'site',
    title: 'CHAPTER 05 · 打耳祭',
    url:   'https://decisive-mind-768702.framer.app/demov2',
  },
  // 第 6 張
  {
    type:  'site',
    title: 'CHAPTER 06 · 射耳祭',
    url:   'https://zh.m.wikipedia.org/wiki/射耳祭',
  },
  // 第 7 張
  {
    type:  'site',
    title: 'CHAPTER 07 · 祖靈',
    url:   'https://zh.m.wikipedia.org/wiki/祖靈',
  },
  // 第 8 張
  {
    type:  'site',
    title: 'CHAPTER 08 · 玉山',
    url:   'https://zh.m.wikipedia.org/wiki/玉山',
  },
];

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
