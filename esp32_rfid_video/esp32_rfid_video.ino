/*
 * ESP32 + RC522 刷卡播放影片
 * ----------------------------------------------------
 * 刷 8 张不同的卡 -> 网页自动播放对应的第 1~8 部影片
 *
 * 需要先在 Arduino IDE 安装库：
 *   工具 -> 管理库 -> 搜 "MFRC522" -> 装 miguelbalboa 那个
 *
 * 接线（RC522 -> ESP32 DevKit）：
 *   SDA(SS) -> GPIO 5
 *   SCK     -> GPIO 18
 *   MOSI    -> GPIO 23
 *   MISO    -> GPIO 19
 *   RST     -> GPIO 27
 *   3.3V    -> 3.3V   << 注意！接 5V 会烧掉模块
 *   GND     -> GND
 *   （IRQ 脚不用接）
 */

#include <WiFi.h>
#include <WebServer.h>
#include <SPI.h>
#include <MFRC522.h>

// ══════════════════════════════════════════════
//  ↓↓↓ 只有这一区需要你改 ↓↓↓
// ══════════════════════════════════════════════

// 1) 你家的 Wi-Fi（ESP32 只支持 2.4G，别填 5G 那个）
const char* WIFI_SSID = "你的WiFi名称";
const char* WIFI_PASS = "你的WiFi密码";

// 2) 影片网址前缀 —— 已经帮你填好了，不用改
const char* VIDEO_BASE = "https://vin836.github.io/esp32-rfid-video/videos/";

// 3) 8 张卡的 UID —— 先随便填，第一次刷卡时串口会告诉你真实 UID，再回来贴上
const char* CARD_UID[8] = {
  "00 00 00 00",   // -> 第 1 部
  "11 11 11 11",   // -> 第 2 部
  "22 22 22 22",   // -> 第 3 部
  "33 33 33 33",   // -> 第 4 部
  "44 44 44 44",   // -> 第 5 部
  "55 55 55 55",   // -> 第 6 部
  "66 66 66 66",   // -> 第 7 部
  "77 77 77 77",   // -> 第 8 部
};

// 4) 影片标题（会显示在网页上，可随意改）
const char* VIDEO_NAME[8] = {
  "影片一", "影片二", "影片三", "影片四",
  "影片五", "影片六", "影片七", "影片八",
};

// ══════════════════════════════════════════════
//  ↑↑↑ 以下不用改 ↑↑↑
// ══════════════════════════════════════════════

#define RC522_SS   5
#define RC522_RST  27
#define LED_PIN    2      // 板载蓝灯，刷卡成功闪一下

MFRC522 rfid(RC522_SS, RC522_RST);
WebServer server(80);

int  currentVideo = 0;    // 0 = 还没刷卡
long seq          = 0;    // 每刷一次卡 +1，让网页知道"这是新的一次"

// ---------- 把卡片 UID 转成 "AA BB CC DD" 这种字符串 ----------
String uidToString() {
  String s = "";
  for (byte i = 0; i < rfid.uid.size; i++) {
    if (rfid.uid.uidByte[i] < 0x10) s += "0";
    s += String(rfid.uid.uidByte[i], HEX);
    if (i < rfid.uid.size - 1) s += " ";
  }
  s.toUpperCase();
  return s;
}

// ---------- 网页内容（存在 ESP32 里，浏览器打开就看到）----------
const char PAGE_HTML[] PROGMEM = R"HTML(
<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>刷卡播放</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    background:#0d0d0f; color:#eee; height:100vh;
    font-family:system-ui,"Microsoft JhengHei",sans-serif;
    display:flex; align-items:center; justify-content:center;
  }
  video { width:100%; height:100%; object-fit:contain; background:#000; }

  /* 还没刷卡时显示的等待画面 */
  #idle {
    position:fixed; inset:0; display:flex; flex-direction:column;
    align-items:center; justify-content:center; gap:20px;
    background:#0d0d0f; z-index:10; text-align:center; padding:20px;
  }
  #idle h1 { font-size:2rem; font-weight:600; }
  #idle p  { color:#888; font-size:1rem; }
  .dot {
    width:14px; height:14px; border-radius:50%; background:#4ade80;
    animation:blink 1.4s infinite;
  }
  @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.2} }

  /* 浏览器规定：用户没点过页面就不准自动播放，所以先盖一层 */
  #unlock {
    position:fixed; inset:0; z-index:99; background:#111;
    display:flex; flex-direction:column; align-items:center;
    justify-content:center; gap:16px; cursor:pointer;
  }
  #unlock h2 { font-size:1.6rem; }
  #unlock span { color:#888; }

  #title {
    position:fixed; left:0; right:0; bottom:0; z-index:5;
    padding:14px 20px; font-size:1.1rem;
    background:linear-gradient(transparent,rgba(0,0,0,.8));
    opacity:0; transition:opacity .4s;
  }
  #title.show { opacity:1; }
</style>
</head>
<body>

<div id="unlock">
  <h2>点一下画面开始</h2>
  <span>（浏览器规定要先互动才能自动播放）</span>
</div>

<div id="idle">
  <div class="dot"></div>
  <h1>请刷卡</h1>
  <p>感应后自动播放对应影片</p>
</div>

<video id="player" playsinline></video>
<div id="title"></div>

<script>
const player = document.getElementById('player');
const idle   = document.getElementById('idle');
const unlock = document.getElementById('unlock');
const title  = document.getElementById('title');

let lastSeq = -1;
let ready   = false;

// 用户点一下，解锁自动播放权限
unlock.addEventListener('click', () => {
  unlock.style.display = 'none';
  ready = true;
});

// 影片播完 -> 回到等待画面
player.addEventListener('ended', () => {
  idle.style.display = 'flex';
  title.classList.remove('show');
});

// 每 400 毫秒问一次 ESP32："刷卡了没？"
async function poll() {
  try {
    const r = await fetch('/status', { cache: 'no-store' });
    const d = await r.json();

    // seq 变了 = 有新的刷卡动作
    if (d.seq !== lastSeq && d.video > 0) {
      lastSeq = d.seq;
      if (ready) playVideo(d.url, d.name);
    }
  } catch (e) {
    // ESP32 断线就安静重试，不弹错误
  }
}

function playVideo(url, name) {
  idle.style.display = 'none';
  title.textContent = name;
  title.classList.add('show');
  player.src = url;
  player.play().catch(() => {});
  setTimeout(() => title.classList.remove('show'), 3000);
}

setInterval(poll, 400);
</script>
</body>
</html>
)HTML";

// ---------- 网页路由 ----------
void handleRoot() {
  server.send_P(200, "text/html; charset=utf-8", PAGE_HTML);
}

// 网页每 0.4 秒会来问一次这里
void handleStatus() {
  String json = "{";
  json += "\"seq\":"   + String(seq) + ",";
  json += "\"video\":" + String(currentVideo) + ",";
  if (currentVideo > 0) {
    json += "\"name\":\"" + String(VIDEO_NAME[currentVideo - 1]) + "\",";
    json += "\"url\":\""  + String(VIDEO_BASE) + String(currentVideo) + ".mp4\"";
  } else {
    json += "\"name\":\"\",\"url\":\"\"";
  }
  json += "}";
  server.send(200, "application/json", json);
}

// ---------- 开机初始化 ----------
void setup() {
  Serial.begin(115200);
  delay(300);
  pinMode(LED_PIN, OUTPUT);

  // 启动 RFID 读卡器
  SPI.begin();
  rfid.PCD_Init();
  Serial.println("\n读卡器就绪");

  // 连 Wi-Fi
  Serial.print("连接 Wi-Fi");
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }

  Serial.println("\n\n========================================");
  Serial.print("  网页地址：http://");
  Serial.println(WiFi.localIP());
  Serial.println("  用手机或电脑浏览器打开上面这行");
  Serial.println("========================================\n");

  server.on("/",       handleRoot);
  server.on("/status", handleStatus);
  server.begin();
}

// ---------- 主循环 ----------
void loop() {
  server.handleClient();

  // 没卡就直接返回，不卡住网页
  if (!rfid.PICC_IsNewCardPresent()) return;
  if (!rfid.PICC_ReadCardSerial())   return;

  String uid = uidToString();

  // 在 8 张卡里找
  int found = 0;
  for (int i = 0; i < 8; i++) {
    if (uid == String(CARD_UID[i])) { found = i + 1; break; }
  }

  if (found > 0) {
    currentVideo = found;
    seq++;
    Serial.println("刷卡 [" + uid + "] -> 播放第 " + String(found) + " 部");
    digitalWrite(LED_PIN, HIGH); delay(100); digitalWrite(LED_PIN, LOW);
  } else {
    // 陌生卡：把 UID 印出来，方便你复制到上面的 CARD_UID
    Serial.println("---------------------------------------");
    Serial.println("未登记的卡，UID 是：  " + uid);
    Serial.println("请复制这串，贴到程序上方 CARD_UID 里");
    Serial.println("---------------------------------------");
  }

  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
  delay(600);   // 防止一次刷卡被读成好几次
}
