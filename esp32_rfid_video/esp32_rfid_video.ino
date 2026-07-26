/*
 * ESP32 + RC522 刷卡播放影片（MQTT 版）
 * ----------------------------------------------------
 * 刷 8 張不同的卡 -> 網頁自動播放對應的第 1~8 部影片
 *
 * 用 MQTT 當中繼，所以手機跟 ESP32 不用連同一個 Wi-Fi。
 *
 * 需要先在 Arduino IDE 安裝兩個程式庫：
 *   工具 -> 管理程式庫 -> 搜這兩個裝起來
 *     1. "MFRC522"  by miguelbalboa
 *     2. "PubSubClient"  by Nick O'Leary
 *
 * 接線（RC522 -> ESP32 DevKit）：
 *   SDA(SS) -> GPIO 5
 *   SCK     -> GPIO 18
 *   MOSI    -> GPIO 23
 *   MISO    -> GPIO 19
 *   RST     -> GPIO 27
 *   3.3V    -> 3.3V   << 注意！接 5V 會燒掉模組
 *   GND     -> GND
 *   （IRQ 腳不用接）
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <SPI.h>
#include <MFRC522.h>

// ══════════════════════════════════════════════
//  ↓↓↓ 只有這一區需要你改 ↓↓↓
// ══════════════════════════════════════════════

// 1) 你家的 Wi-Fi（ESP32 只支援 2.4G，別填 5G 那個）
const char* WIFI_SSID = "你的WiFi名稱";
const char* WIFI_PASS = "你的WiFi密碼";

// 2) 房間代號 —— 隨便取，但要跟網頁上填的一模一樣
//    建議加些亂數字，別人猜不到才不會亂入
const char* ROOM = "vin836-rfid-8x2f";

// 3) 8 張卡的 UID —— 先隨便填，第一次刷卡時序列埠會告訴你真實 UID，再回來貼上
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
//  ↑↑↑ 以下不用改 ↑↑↑
// ══════════════════════════════════════════════

// 免費公共 MQTT 中繼站
const char* MQTT_HOST = "broker.hivemq.com";
const int   MQTT_PORT = 8883;          // 8883 = 加密連線

#define RC522_SS   5
#define RC522_RST  27
#define LED_PIN    2      // 板載藍燈，刷卡成功閃一下

MFRC522 rfid(RC522_SS, RC522_RST);
WiFiClientSecure net;
PubSubClient mqtt(net);

String topic;             // 訊息發到哪個頻道
long   seq = 0;           // 每刷一次卡 +1

// ---------- 把卡片 UID 轉成 "AA BB CC DD" 這種字串 ----------
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

// ---------- 連上 MQTT 中繼站 ----------
void connectMQTT() {
  while (!mqtt.connected()) {
    Serial.print("連接中繼站...");

    // 每台裝置要有不同的名字，用晶片編號組一個
    String id = "esp32-" + String((uint32_t)ESP.getEfuseMac(), HEX);

    if (mqtt.connect(id.c_str())) {
      Serial.println(" 成功");

      // 上線通知，網頁會顯示「讀卡機已連線」
      String online = "{\"type\":\"online\"}";
      mqtt.publish(topic.c_str(), online.c_str(), true);
    } else {
      Serial.print(" 失敗，5 秒後重試（錯誤碼 ");
      Serial.print(mqtt.state());
      Serial.println("）");
      delay(5000);
    }
  }
}

// ---------- 開機初始化 ----------
void setup() {
  Serial.begin(115200);
  delay(300);
  pinMode(LED_PIN, OUTPUT);

  topic = "esp32rfid/" + String(ROOM);

  // 啟動讀卡機
  SPI.begin();
  rfid.PCD_Init();
  Serial.println("\n讀卡機就緒");

  // 連 Wi-Fi
  Serial.print("連接 Wi-Fi");
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }
  Serial.println(" 成功");

  // 不驗證憑證，省記憶體（這個用途夠安全）
  net.setInsecure();
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  connectMQTT();

  Serial.println("\n========================================");
  Serial.println("  網頁：https://vin836.github.io/esp32-rfid-video/");
  Serial.print  ("  房間代號：");
  Serial.println(ROOM);
  Serial.println("");
  Serial.println("  手機不用連同一個 Wi-Fi，用 4G 也可以");
  Serial.println("========================================\n");
}

// ---------- 主迴圈 ----------
void loop() {
  if (!mqtt.connected()) connectMQTT();
  mqtt.loop();

  // 沒卡就直接返回
  if (!rfid.PICC_IsNewCardPresent()) return;
  if (!rfid.PICC_ReadCardSerial())   return;

  String uid = uidToString();

  // 在 8 張卡裡找
  int found = 0;
  for (int i = 0; i < 8; i++) {
    if (uid == String(CARD_UID[i])) { found = i + 1; break; }
  }

  if (found > 0) {
    seq++;

    // 發訊息出去，網頁那邊會收到
    String msg = "{\"type\":\"play\",\"video\":" + String(found) +
                 ",\"seq\":" + String(seq) + "}";
    mqtt.publish(topic.c_str(), msg.c_str(), true);

    Serial.println("刷卡 [" + uid + "] -> 播放第 " + String(found) + " 部");
    digitalWrite(LED_PIN, HIGH); delay(100); digitalWrite(LED_PIN, LOW);

  } else {
    // 陌生卡：把 UID 印出來，方便你複製
    Serial.println("---------------------------------------");
    Serial.println("未登記的卡，UID 是：  " + uid);
    Serial.println("請複製這串，貼到程式上方 CARD_UID 裡");
    Serial.println("---------------------------------------");
  }

  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
  delay(600);   // 防止一次刷卡被讀成好幾次
}
