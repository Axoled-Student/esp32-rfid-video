/*
 * ESP32 + RC522 刷卡播放影片
 * ══════════════════════════════════════════════════════════
 * 刷 8 張不同的卡 -> 平板網頁自動播放對應的第 1~8 部影片
 *
 * 【網路設定不用改程式】
 *   第一次開機會自己開一個 Wi-Fi 熱點，
 *   用手機連上去就會跳出設定畫面，填好按儲存就完成了。
 *   設定會記在板子裡，之後開機自動連，不用再設一次。
 *
 * 【要重新設定網路】
 *   按住板子上的 BOOT 鍵 3 秒 —— 燈快閃 = 設定已清除，
 *   板子會自己重開並再次開出熱點。
 *
 * ── 需要安裝的程式庫 ──────────────────────────────────
 *   Arduino IDE -> 工具 -> 管理程式庫，搜尋並安裝：
 *     1. "MFRC522"      by miguelbalboa
 *     2. "PubSubClient" by Nick O'Leary
 *
 * ── 接線（RC522 -> ESP32 DevKit）───────────────────────
 *   SDA(SS) -> GPIO 5
 *   SCK     -> GPIO 18
 *   MOSI    -> GPIO 23
 *   MISO    -> GPIO 19
 *   RST     -> GPIO 27
 *   3.3V    -> 3.3V    ⚠ 接 5V 會燒掉模組
 *   GND     -> GND
 *   （IRQ 腳不用接）
 * ══════════════════════════════════════════════════════════
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <PubSubClient.h>
#include <SPI.h>
#include <MFRC522.h>

// ══════════════════════════════════════════════
//  ↓↓↓ 只有這一區需要你改 ↓↓↓
// ══════════════════════════════════════════════

// 8 張卡的 UID
// 先直接燒進去，刷卡時序列埠會印出真實 UID，再回來貼上這裡
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

// ══════════════════════════════════════════════
//  ↑↑↑ 以下都不用改 ↑↑↑
// ══════════════════════════════════════════════

// ── 設定用熱點 ──────────────────────────────────
const char* AP_NAME = "刷卡機-設定";   // 手機 Wi-Fi 清單裡會看到這個
const char* AP_PASS = "12345678";      // 熱點密碼（至少 8 個字）

const unsigned long AP_TIMEOUT_MS = 10UL * 60UL * 1000UL;   // 熱點開 10 分鐘

// ── 房間代號 ────────────────────────────────────
// 要跟網頁 assets/config.js 裡的 ROOM 一模一樣。兩邊都設好了。
const char* ROOM = "vin836-rfid-8x2f";

// ── MQTT 中繼站（免費公共伺服器）─────────────────
const char* MQTT_HOST = "broker.hivemq.com";
const int   MQTT_PORT = 8883;          // 8883 = 加密連線

// ── 腳位 ────────────────────────────────────────
#define RC522_SS    5
#define RC522_RST   27
#define LED_PIN     2      // 板載藍燈
#define RESET_BTN   0      // BOOT 鍵，按住 3 秒清除網路設定

#define RESET_HOLD_MS  3000    // 要按住多久才算數
#define REPEAT_MS      1500    // 同一張卡在這段時間內重刷只算一次

// ── 全域物件 ────────────────────────────────────
MFRC522          rfid(RC522_SS, RC522_RST);
WiFiClientSecure net;
PubSubClient     mqtt(net);
WebServer        server(80);
DNSServer        dns;
Preferences      prefs;

String topic;
String bootId;
long   seq = 0;

String        lastUid  = "";
unsigned long lastTime = 0;

bool          apMode      = false;   // 現在是不是在設定模式
unsigned long apStartTime = 0;
int           wifiFailCount = 0;     // Wi-Fi 連續連不上幾次

// 先跟編譯器說有這些函式，順序才不會出問題
void startSetupMode();
void clearWifiSettings();
void checkResetButton();

// ══════════════════════════════════════════════════════════
//  燈號
// ══════════════════════════════════════════════════════════

void blink(int times, int onMs, int offMs) {
  for (int i = 0; i < times; i++) {
    digitalWrite(LED_PIN, HIGH); delay(onMs);
    digitalWrite(LED_PIN, LOW);  delay(offMs);
  }
}

// 設定模式：慢慢呼吸一樣閃，表示在等你來設定
void apHeartbeat() {
  static unsigned long last = 0;
  static bool on = false;
  if (millis() - last < (on ? 120 : 1400)) return;
  last = millis();
  on = !on;
  digitalWrite(LED_PIN, on ? HIGH : LOW);
}

// ══════════════════════════════════════════════════════════
//  設定畫面（手機連上熱點後看到的網頁）
// ══════════════════════════════════════════════════════════

const char PAGE_SETUP[] PROGMEM = R"HTML(
<!DOCTYPE html><html lang="zh-TW"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>刷卡機 · 網路設定</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0c;color:#ececf0;min-height:100vh;padding:26px 18px 40px;
     font-family:system-ui,-apple-system,"PingFang TC","Microsoft JhengHei",sans-serif;
     line-height:1.65;-webkit-text-size-adjust:100%}
.wrap{max-width:440px;margin:0 auto}
h1{font-size:1.5rem;font-weight:650;margin-bottom:4px;letter-spacing:-.02em}
.sub{color:#8b8b96;font-size:.92rem;margin-bottom:22px}
.card{background:#141418;border:1px solid #232329;border-radius:18px;
      padding:20px;margin-bottom:14px}
label{display:block;font-size:.88rem;color:#8b8b96;margin-bottom:7px}
input,select{width:100%;padding:13px 14px;font-size:1rem;font-family:inherit;
      background:#0a0a0c;border:1px solid #2a2a33;border-radius:9px;color:#ececf0;
      margin-bottom:16px;-webkit-appearance:none;appearance:none}
input:focus,select:focus{outline:none;border-color:#3b82f6}
select{background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8'><path d='M1 1l5 5 5-5' stroke='%238b8b96' stroke-width='1.6' fill='none' stroke-linecap='round'/></svg>");
       background-repeat:no-repeat;background-position:right 14px center}
button{width:100%;padding:15px;font-size:1.02rem;font-weight:650;font-family:inherit;
       background:#3b82f6;color:#fff;border:none;border-radius:9px;cursor:pointer}
button:active{background:#2563eb}
button.ghost{background:#1c1c22;border:1px solid #2a2a33;color:#ececf0;
             font-size:.92rem;padding:12px;margin-top:10px}
.row{display:flex;gap:8px;align-items:center;margin-bottom:16px}
.row select{margin-bottom:0;flex:1}
.row button{width:auto;padding:13px 16px;font-size:.88rem;background:#1c1c22;
            border:1px solid #2a2a33;color:#ececf0;white-space:nowrap}
.note{background:#141418;border:1px solid #232329;border-radius:12px;
      padding:14px 16px;font-size:.85rem;color:#8b8b96;line-height:1.8}
.note b{color:#ececf0;font-weight:600}
.warn{background:#2a2010;border-color:#6b4a10;color:#fcd34d}
.check{display:flex;align-items:center;gap:9px;margin-bottom:16px;
       font-size:.88rem;color:#8b8b96;cursor:pointer}
.check input{width:17px;height:17px;margin:0;flex:none;accent-color:#3b82f6}
#msg{display:none;padding:13px 15px;border-radius:9px;font-size:.9rem;margin-bottom:14px}
#msg.busy{display:block;background:#141418;border:1px solid #232329;color:#8b8b96}
#msg.ok{display:block;background:#0d1f16;border:1px solid #1c5c3a;color:#86efac}
#msg.bad{display:block;background:#241315;border:1px solid #7f2222;color:#fca5a5}
</style></head><body><div class="wrap">

<h1>刷卡機 · 網路設定</h1>
<p class="sub">選一個 Wi-Fi 並填密碼，設定會記在板子裡。</p>

<div id="msg"></div>

<form class="card" id="form">
  <label>Wi-Fi 名稱</label>
  <div class="row">
    <select id="ssidList"><option value="">掃描中…</option></select>
    <button type="button" id="rescan">重新掃描</button>
  </div>

  <label class="check" style="margin-top:-8px">
    <input type="checkbox" id="manual"> 找不到？我要自己輸入名稱
  </label>

  <input type="text" id="ssidManual" placeholder="Wi-Fi 名稱" style="display:none"
         autocomplete="off" autocapitalize="off" spellcheck="false">

  <label>Wi-Fi 密碼</label>
  <input type="password" id="pass" placeholder="沒有密碼就留空" autocomplete="off">

  <label class="check">
    <input type="checkbox" id="show"> 顯示密碼
  </label>

  <button type="submit" id="save">儲存並連線</button>
</form>

<div class="note warn" style="margin-bottom:12px">
  <b>注意：</b>這台板子只能連 <b>2.4GHz</b> 的 Wi-Fi，
  連不到 5GHz。如果你家路由器兩個頻段同名，可能要先分開命名。
</div>

<div class="note">
  <b>之後要重新設定？</b><br>
  按住板子上的 <b>BOOT</b> 鍵 3 秒，燈快閃就是清除完成，
  板子會自己重開並再開一次設定熱點。
</div>

</div><script>
var $=function(s){return document.querySelector(s)};

function msg(text,cls){var m=$('#msg');m.textContent=text;m.className=cls||''}

// ── 掃描附近的 Wi-Fi ──
function scan(){
  var sel=$('#ssidList');
  sel.innerHTML='<option value="">掃描中…</option>';
  fetch('/scan').then(function(r){return r.json()}).then(function(list){
    if(!list.length){sel.innerHTML='<option value="">找不到任何 Wi-Fi</option>';return}
    sel.innerHTML='<option value="">請選擇…</option>';
    list.forEach(function(w){
      var o=document.createElement('option');
      o.value=w.s;
      // 訊號強度用格數表示，比 dBm 好懂
      var bars=w.r>-55?'●●●':w.r>-70?'●●○':'●○○';
      o.textContent=w.s+'　'+bars+(w.e?' 🔒':'');
      sel.appendChild(o);
    });
  }).catch(function(){
    sel.innerHTML='<option value="">掃描失敗，請重試</option>';
  });
}
scan();
$('#rescan').onclick=scan;

// ── 手動輸入名稱 ──
$('#manual').onchange=function(){
  var on=this.checked;
  $('#ssidManual').style.display=on?'block':'none';
  $('#ssidList').parentNode.style.display=on?'none':'flex';
};

// ── 顯示密碼 ──
$('#show').onchange=function(){
  $('#pass').type=this.checked?'text':'password';
};

// ── 送出 ──
$('#form').onsubmit=function(e){
  e.preventDefault();

  var ssid=$('#manual').checked?$('#ssidManual').value.trim():$('#ssidList').value;
  if(!ssid){msg('請先選一個 Wi-Fi，或勾選自己輸入名稱','bad');return}

  $('#save').disabled=true;
  $('#save').textContent='連線中…';
  msg('正在連線，最多要 20 秒，請稍候…','busy');

  var body='ssid='+encodeURIComponent(ssid)+'&pass='+encodeURIComponent($('#pass').value);

  fetch('/save',{method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},body:body})
  .then(function(r){return r.json()})
  .then(function(d){
    if(d.ok){
      msg('連線成功！板子重開後就會開始運作，這個熱點會自動關閉。','ok');
      $('#save').textContent='設定完成';
      $('#form').style.opacity='.5';
    }else{
      msg('連不上：'+(d.why||'請確認名稱和密碼')+'（記得要 2.4GHz）','bad');
      $('#save').disabled=false;
      $('#save').textContent='儲存並連線';
    }
  })
  .catch(function(){
    // 連上之後熱點會斷，這個錯誤其實代表成功了
    msg('連線可能已成功（熱點已關閉）。請關掉這頁，看板子的燈是否穩定。','ok');
    $('#save').textContent='請確認板子狀態';
  });
};
</script></body></html>
)HTML";

// ══════════════════════════════════════════════════════════
//  設定模式的網頁路由
// ══════════════════════════════════════════════════════════

void handleRoot() {
  server.send_P(200, "text/html; charset=utf-8", PAGE_SETUP);
}

// 掃描附近的 Wi-Fi，回傳給設定畫面
void handleScan() {
  int n = WiFi.scanNetworks(false, false);

  String json = "[";
  int added = 0;

  for (int i = 0; i < n && added < 25; i++) {
    String ssid = WiFi.SSID(i);
    if (ssid.length() == 0) continue;

    // 名稱裡的特殊字元要轉義，不然 JSON 會壞掉
    String safe = "";
    for (unsigned int c = 0; c < ssid.length(); c++) {
      char ch = ssid[c];
      if (ch == '"' || ch == '\\') { safe += '\\'; safe += ch; }
      else if ((unsigned char)ch < 0x20) continue;
      else safe += ch;
    }

    if (added++) json += ",";
    json += "{\"s\":\"" + safe + "\",\"r\":" + String(WiFi.RSSI(i)) +
            ",\"e\":" + String(WiFi.encryptionType(i) == WIFI_AUTH_OPEN ? 0 : 1) + "}";
  }
  json += "]";

  WiFi.scanDelete();
  server.send(200, "application/json", json);
}

// 收到設定，當場試連一次
void handleSave() {
  String ssid = server.arg("ssid");
  String pass = server.arg("pass");

  if (ssid.length() == 0) {
    server.send(200, "application/json", "{\"ok\":false,\"why\":\"沒有填 Wi-Fi 名稱\"}");
    return;
  }

  Serial.println("收到設定，試連：" + ssid);

  // 熱點先留著，這樣手機才不會馬上斷線看不到結果
  WiFi.mode(WIFI_AP_STA);
  WiFi.begin(ssid.c_str(), pass.c_str());

  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) {
    delay(300);
    Serial.print(".");
    server.handleClient();       // 別讓網頁那邊等到逾時
  }
  Serial.println();

  if (WiFi.status() != WL_CONNECTED) {
    String why;
    switch (WiFi.status()) {
      case WL_NO_SSID_AVAIL: why = "找不到這個 Wi-Fi"; break;
      case WL_CONNECT_FAILED: why = "密碼可能不對"; break;
      default: why = "連不上"; break;
    }
    Serial.println("連線失敗：" + why);
    WiFi.disconnect();
    server.send(200, "application/json", "{\"ok\":false,\"why\":\"" + why + "\"}");
    blink(2, 400, 200);
    return;
  }

  // 成功，存起來
  prefs.begin("net", false);
  prefs.putString("ssid", ssid);
  prefs.putString("pass", pass);
  prefs.end();

  Serial.println("連線成功，IP：" + WiFi.localIP().toString());
  server.send(200, "application/json", "{\"ok\":true}");

  blink(3, 150, 120);
  delay(1200);          // 讓網頁有時間顯示成功訊息

  Serial.println("重新啟動…");
  ESP.restart();
}

// 手機連上熱點時，作業系統會去戳幾個網址確認有沒有網路。
// 這裡把全部沒對上的網址都導回設定畫面，設定頁就會自己跳出來。
void handleNotFound() {
  server.sendHeader("Location", "http://192.168.4.1/", true);
  server.send(302, "text/plain", "");
}

// ══════════════════════════════════════════════════════════
//  設定模式：開熱點等人來設定
// ══════════════════════════════════════════════════════════

void startSetupMode() {
  if (apMode) return;              // 已經在設定模式了，不要重複啟動

  // 先把正常模式的連線收乾淨，免得兩邊搶資源
  if (mqtt.connected()) mqtt.disconnect();
  WiFi.disconnect(true);
  delay(100);

  apMode = true;
  apStartTime = millis();

  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_NAME, AP_PASS);
  delay(300);

  // 攔截所有 DNS 查詢，手機一連上就會自動跳出設定畫面
  dns.start(53, "*", WiFi.softAPIP());

  server.on("/",     handleRoot);
  server.on("/scan", handleScan);
  server.on("/save", HTTP_POST, handleSave);
  server.onNotFound(handleNotFound);
  server.begin();

  Serial.println("\n╔══════════════════════════════════════╗");
  Serial.println("║        請用手機設定網路              ║");
  Serial.println("╚══════════════════════════════════════╝");
  Serial.println("");
  Serial.print  ("  1. 手機 Wi-Fi 找：  ");
  Serial.println(AP_NAME);
  Serial.print  ("  2. 密碼：            ");
  Serial.println(AP_PASS);
  Serial.println("  3. 連上後會自動跳出設定畫面");
  Serial.println("     沒跳的話，瀏覽器打 http://192.168.4.1");
  Serial.println("");
  Serial.println("  熱點會開 10 分鐘，逾時自動重開再開一次");
  Serial.println("──────────────────────────────────────\n");
}

// ══════════════════════════════════════════════════════════
//  清除網路設定
// ══════════════════════════════════════════════════════════

void clearWifiSettings() {
  Serial.println("\n清除網路設定…");

  prefs.begin("net", false);
  prefs.clear();
  prefs.end();

  // 燈快閃 8 下 = 已清除
  blink(8, 70, 70);

  Serial.println("已清除，重新啟動後會再開一次設定熱點\n");
  delay(400);
  ESP.restart();
}

// 檢查 BOOT 鍵有沒有被按住
void checkResetButton() {
  if (digitalRead(RESET_BTN) != LOW) return;      // BOOT 鍵按下去是 LOW

  unsigned long t0 = millis();
  Serial.print("偵測到按鍵，繼續按住可清除網路設定");

  while (digitalRead(RESET_BTN) == LOW) {
    delay(100);
    unsigned long held = millis() - t0;

    // 按越久閃越快，讓人知道快到了
    if (held % 200 < 100) digitalWrite(LED_PIN, HIGH);
    else                  digitalWrite(LED_PIN, LOW);

    if (held % 1000 < 100) Serial.print(".");

    if (held >= RESET_HOLD_MS) {
      Serial.println(" 確認");
      clearWifiSettings();      // 這裡面會重開機，不會回來
      return;
    }
  }

  // 放太早，取消
  digitalWrite(LED_PIN, LOW);
  Serial.println(" 取消（要按滿 3 秒）");
}

// ══════════════════════════════════════════════════════════
//  正常模式：連 Wi-Fi、連中繼站
// ══════════════════════════════════════════════════════════

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

// 用存起來的設定連 Wi-Fi。連不上回傳 false。
bool connectSavedWifi() {
  prefs.begin("net", true);
  String ssid = prefs.getString("ssid", "");
  String pass = prefs.getString("pass", "");
  prefs.end();

  if (ssid.length() == 0) {
    Serial.println("還沒設定過網路");
    return false;
  }

  Serial.print("連接 Wi-Fi：" + ssid);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);            // 關省電，反應快也不容易掉線
  WiFi.begin(ssid.c_str(), pass.c_str());

  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");

    // 連線期間也要能按 BOOT 鍵重置，
    // 不然萬一 Wi-Fi 換了密碼，會卡在這裡按不了
    checkResetButton();

    if (millis() - t0 > 25000) {
      Serial.println(" 連不上");
      return false;
    }
  }

  Serial.println(" 成功");
  Serial.println("  IP：" + WiFi.localIP().toString());
  return true;
}

void connectMQTT() {
  int tries = 0;

  while (!mqtt.connected()) {
    Serial.print("連接中繼站…");

    String id = "esp32-" + bootId;

    // 遺言：萬一板子斷線或沒電，中繼站會自動發這則，
    // 網頁就知道讀卡機掉線了，而不是傻等。
    String will = "{\"type\":\"status\",\"online\":false}";

    bool ok = mqtt.connect(
      id.c_str(),
      NULL, NULL,
      topic.c_str(), 0, true,
      will.c_str()
    );

    if (ok) {
      Serial.println(" 成功");
      String online = "{\"type\":\"status\",\"online\":true}";
      mqtt.publish(topic.c_str(), online.c_str(), true);
      return;
    }

    Serial.print(" 失敗（錯誤碼 ");
    Serial.print(mqtt.state());
    Serial.println("），5 秒後重試");

    // 等待期間也要能按鍵重置
    for (int i = 0; i < 50; i++) { checkResetButton(); delay(100); }

    if (++tries >= 10) {
      Serial.println("試太多次，重新啟動");
      ESP.restart();
    }
  }
}

void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) { wifiFailCount = 0; return; }

  Serial.println("Wi-Fi 掉線，重新連接");
  WiFi.disconnect();

  if (connectSavedWifi()) { wifiFailCount = 0; return; }

  // 連續失敗很多次，通常是 Wi-Fi 換密碼或換了台路由器。
  // 這時候一直重開也連不上，直接開設定熱點讓人重設比較實際。
  if (++wifiFailCount >= 3) {
    Serial.println("\n連續連不上 Wi-Fi，改開設定熱點讓你重新設定");
    startSetupMode();
    return;
  }

  Serial.println("重連失敗，稍後再試（第 " + String(wifiFailCount) + " 次）");
  delay(3000);
}

// ══════════════════════════════════════════════════════════
//  開機
// ══════════════════════════════════════════════════════════

void setup() {
  Serial.begin(115200);
  delay(300);

  pinMode(LED_PIN, OUTPUT);
  pinMode(RESET_BTN, INPUT_PULLUP);

  Serial.println("\n\n════════════════════════════════════════");
  Serial.println("  ESP32 刷卡播放影片");
  Serial.println("════════════════════════════════════════");

  // 開機時就按住 BOOT = 直接清除設定
  if (digitalRead(RESET_BTN) == LOW) {
    Serial.println("\n開機時偵測到按住 BOOT 鍵");
    delay(500);
    if (digitalRead(RESET_BTN) == LOW) clearWifiSettings();
  }

  // 每次開機給一個不同的識別碼。
  // 網頁靠「識別碼 + 流水號」判斷訊息新舊，
  // 沒有它的話重開機後流水號歸零，會被誤判成舊訊息而不播。
  randomSeed(esp_random());
  bootId = String((uint32_t)ESP.getEfuseMac(), HEX) + "-" +
           String(random(0x1000, 0xFFFF), HEX);

  topic = "esp32rfid/" + String(ROOM);

  // 讀卡機
  SPI.begin();
  rfid.PCD_Init();
  delay(50);

  byte ver = rfid.PCD_ReadRegister(MFRC522::VersionReg);
  if (ver == 0x00 || ver == 0xFF) {
    Serial.println("\n⚠ 找不到讀卡機");
    Serial.println("  請檢查接線，特別是 3.3V、GPIO 5、GPIO 27");
  } else {
    Serial.println("\n讀卡機就緒");
  }

  // 有存過設定就直接連，沒有就開熱點讓人來設定
  if (!connectSavedWifi()) {
    startSetupMode();
    return;                    // 設定模式的事情交給 loop() 處理
  }

  net.setInsecure();           // 不驗證憑證，省記憶體（這個用途夠安全）
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setKeepAlive(30);
  connectMQTT();

  digitalWrite(LED_PIN, LOW);

  Serial.println("\n════════════════════════════════════════");
  Serial.println("  可以開始刷卡了");
  Serial.println("");
  Serial.println("  播放頁：");
  Serial.println("  https://vin836.github.io/esp32-rfid-video/play.html");
  Serial.println("");
  Serial.println("  平板打開網址，點一下畫面就好");
  Serial.println("  不用連同一個 Wi-Fi，用行動網路也可以");
  Serial.println("");
  Serial.println("  要重設網路：按住 BOOT 鍵 3 秒");
  Serial.println("════════════════════════════════════════\n");
}

// ══════════════════════════════════════════════════════════
//  主迴圈
// ══════════════════════════════════════════════════════════

void loop() {

  // ── 設定模式 ──────────────────────────────────
  if (apMode) {
    dns.processNextRequest();
    server.handleClient();
    apHeartbeat();

    // 設定模式下也能按 BOOT 鍵，直接重開再來一次
    checkResetButton();

    // 10 分鐘沒人來設定，重開機再開一次熱點
    if (millis() - apStartTime > AP_TIMEOUT_MS) {
      Serial.println("\n10 分鐘沒人設定，重新啟動");
      ESP.restart();
    }
    return;
  }

  // ── 正常模式 ──────────────────────────────────
  checkResetButton();
  ensureWifi();

  if (!mqtt.connected()) connectMQTT();
  mqtt.loop();

  // 沒卡就直接返回
  if (!rfid.PICC_IsNewCardPresent()) return;
  if (!rfid.PICC_ReadCardSerial())   return;

  String uid = uidToString();

  // 同一張卡連續被讀到好幾次，只算第一次
  if (uid == lastUid && millis() - lastTime < REPEAT_MS) {
    rfid.PICC_HaltA();
    rfid.PCD_StopCrypto1();
    return;
  }
  lastUid  = uid;
  lastTime = millis();

  int found = 0;
  for (int i = 0; i < 8; i++) {
    if (uid == String(CARD_UID[i])) { found = i + 1; break; }
  }

  if (found > 0) {
    seq++;

    // retain = false —— 不要讓中繼站留著這則訊息。
    // 留著的話，播放頁下次一開就會自己播上一次那部。
    String msg = "{\"type\":\"play\",\"video\":" + String(found) +
                 ",\"seq\":" + String(seq) +
                 ",\"boot\":\"" + bootId + "\"}";

    if (mqtt.publish(topic.c_str(), msg.c_str(), false)) {
      Serial.println("刷卡 [" + uid + "] -> 播放第 " + String(found) + " 部");
      blink(1, 80, 0);
    } else {
      Serial.println("送出失敗，稍後會自動重連");
      blink(3, 60, 60);      // 快閃三下 = 沒送出去
    }

  } else {
    Serial.println("─────────────────────────────────────");
    Serial.println("未登記的卡，UID 是：  " + uid);
    Serial.println("請複製這串，貼到程式上方 CARD_UID 裡");
    Serial.println("─────────────────────────────────────");
  }

  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
}
