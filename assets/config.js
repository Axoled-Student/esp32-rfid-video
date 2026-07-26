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

  // ── 影片標題 ──────────────────────────────────────────
  // 播放時會浮在畫面下方，順序對應第 1 ~ 8 部。想改成作品名就改這裡。
  TITLES: [
    '影片 1', '影片 2', '影片 3', '影片 4',
    '影片 5', '影片 6', '影片 7', '影片 8',
  ],
};

// 訂閱／發布用的頻道名稱
CONFIG.TOPIC = 'esp32rfid/' + CONFIG.ROOM;

/* ── 小工具，各頁共用 ──────────────────────────────────── */

const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

// 1 ~ COUNT 的陣列，拿來跑迴圈
const SLOTS = Array.from({ length: CONFIG.COUNT }, (_, i) => i + 1);

// 建立 MQTT 連線（各頁設定一致，避免各寫各的）
function connectMqtt(prefix) {
  return mqtt.connect(CONFIG.MQTT_URL, {
    clientId:       prefix + '-' + Math.random().toString(16).slice(2, 10),
    reconnectPeriod: 3000,
    connectTimeout:  10000,
    clean:           true,
  });
}
