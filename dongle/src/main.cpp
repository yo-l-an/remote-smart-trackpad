/*
Remote Smart Trackpad dongle: a LilyGO T-Dongle-S3 that the PC sees as a real keyboard and mouse. Two sources drive it:
- the PC's host, over USB serial, with only the input Windows rejects from an app (the secure desktop: lock screen,
  UAC prompts; an app run as administrator in front): see Dongle in host/windows/native.psm1;
- the phone, over Bluetooth Low Energy, when it cannot reach the PC's server (the BIOS, a PC without the server):
  see web/logic/dongle-link.js. Only a phone bonded to the dongle may send: a new phone bonds while the pairing window
  is open, for 60 s after a press on the BOOT button.

One command per line, numbers in decimal, the same from both sources:
  ?               answers "remote-smart-trackpad-dongle <version>" (USB serial only)
  m dx dy         pointer moves by dx, dy
  b buttons       mouse buttons held: 1 left, 2 right, 4 middle
  w v h           wheel turns by v (up) and h (right), in 1/120 of a notch
  k usage 0|1     keyboard key (HID usage, modifiers 0xE0 to 0xE7 included) let go or held
  t usage mods    key typed once with exactly these modifiers, the held keys put back afterwards
  c usage 0|1     consumer key (volume, media) let go or held
  r               everything let go
When a source goes away (the host closes its port, the phone disconnects), everything is let go.

In the BIOS, the PC asks for the boot protocol: the keyboard then sends plain 8-byte reports, and the mouse and media
keys stay silent (a BIOS reads none of them).

The LED: blue while no source is connected, green once one is, purple while the pairing window is open.
*/
#include <Arduino.h>
#include "USB.h"
#include "USBHID.h"
#include "USBHIDConsumerControl.h"
#include "USBHIDKeyboard.h"
#include "esp32-hal-tinyusb.h"
#include <BLEDevice.h>
#include <BLESecurity.h>
#include <BLEServer.h>
#include "freertos/stream_buffer.h"

static const char *kIdentity = "remote-smart-trackpad-dongle 2";
static const uint8_t kLedData = 40, kLedClock = 39, kBacklight = 38, kBootButton = 0;
static const uint8_t kMouseReport = 2;
static const char *kServiceUuid = "6f5c0001-2b6e-4a2c-9d3b-7a1e5c9f0d42";
static const char *kCommandsUuid = "6f5c0002-2b6e-4a2c-9d3b-7a1e5c9f0d42";
static const uint32_t kPairingWindow = 60000;

/*
A mouse with a high-resolution wheel: once Windows sets its resolution multipliers (a feature report), a wheel unit is
1/120 of a notch, the unit of the host's scroll. Until then whole notches go out, the remainder carried over.
*/
static const uint8_t kMouseDescriptor[] = {
    0x05, 0x01, 0x09, 0x02, 0xA1, 0x01, 0x85, kMouseReport,  // Generic desktop, mouse, application collection
    0x09, 0x01, 0xA1, 0x00,                                  // Pointer, physical collection
    0x05, 0x09, 0x19, 0x01, 0x29, 0x05, 0x15, 0x00, 0x25, 0x01, 0x95, 0x05, 0x75, 0x01, 0x81, 0x02,  // 5 buttons
    0x95, 0x01, 0x75, 0x03, 0x81, 0x03,                                                              // padding
    0x05, 0x01, 0x09, 0x30, 0x09, 0x31, 0x16, 0x01, 0x80, 0x26, 0xFF, 0x7F, 0x75, 0x10, 0x95, 0x02, 0x81, 0x06,  // X, Y
    0xA1, 0x02,                                                                          // Logical collection: wheel
    0x09, 0x48, 0x15, 0x00, 0x25, 0x01, 0x35, 0x01, 0x45, 0x78, 0x75, 0x02, 0x95, 0x01, 0xB1, 0x02,  // multiplier 1-120
    0x35, 0x00, 0x45, 0x00, 0x75, 0x06, 0xB1, 0x03,                                                  // padding
    0x09, 0x38, 0x16, 0x01, 0x80, 0x26, 0xFF, 0x7F, 0x75, 0x10, 0x95, 0x01, 0x81, 0x06,              // wheel
    0xC0,
    0xA1, 0x02,                                                                          // Logical collection: pan
    0x09, 0x48, 0x15, 0x00, 0x25, 0x01, 0x35, 0x01, 0x45, 0x78, 0x75, 0x02, 0x95, 0x01, 0xB1, 0x02,
    0x35, 0x00, 0x45, 0x00, 0x75, 0x06, 0xB1, 0x03,
    0x05, 0x0C, 0x0A, 0x38, 0x02, 0x16, 0x01, 0x80, 0x26, 0xFF, 0x7F, 0x75, 0x10, 0x95, 0x01, 0x81, 0x06,  // AC Pan
    0xC0,
    0xC0, 0xC0,
};

/*
True while the PC reads the keyboard in boot protocol (a BIOS). Only a PC that asks for it (SET_PROTOCOL) gets it:
TinyUSB starts a boot interface in boot protocol, and Windows never asks for the report protocol, so going by TinyUSB
left Windows without a mouse. Each new connection starts again in report protocol.
*/
static volatile bool bootMode = false;
static bool bootProtocol() { return bootMode; }
static void onProtocol(void *, esp_event_base_t, int32_t, void *data) {
    bootMode = static_cast<arduino_usb_hid_event_data_t *>(data)->set_protocol.protocol == HID_PROTOCOL_BOOT;
}
static void onConnection(void *, esp_event_base_t, int32_t, void *) { bootMode = false; }

class WheelMouse : public USBHIDDevice {
  public:
    WheelMouse() {
        static bool added = false;
        if (!added) added = USBHID::addDevice(this, sizeof(kMouseDescriptor));
    }
    void begin() { hid.begin(); }
    uint16_t _onGetDescriptor(uint8_t *buffer) override {
        memcpy(buffer, kMouseDescriptor, sizeof(kMouseDescriptor));
        return sizeof(kMouseDescriptor);
    }
    uint16_t _onGetFeature(uint8_t reportId, uint8_t *buffer, uint16_t length) override {
        if (reportId != kMouseReport || length < 2) return 0;
        buffer[0] = fineWheel;
        buffer[1] = finePan;
        return 2;
    }
    void _onSetFeature(uint8_t reportId, const uint8_t *buffer, uint16_t length) override {
        if (reportId != kMouseReport) return;
        // Some stacks keep the report ID in front of the data.
        if (length == 3 && buffer[0] == kMouseReport) buffer++, length--;
        if (length < 2) return;
        fineWheel = buffer[0] & 3;
        finePan = buffer[1] & 3;
    }
    void setButtons(uint8_t held) {
        buttons = held;
        send(0, 0, 0, 0);
    }
    void move(int32_t dx, int32_t dy) {
        while (dx || dy) {
            int16_t stepX = constrain(dx, -32767, 32767), stepY = constrain(dy, -32767, 32767);
            send(stepX, stepY, 0, 0);
            dx -= stepX;
            dy -= stepY;
        }
    }
    void scroll(int32_t vertical, int32_t horizontal) {
        int32_t wheel = units(vertical, fineWheel, wheelCarry), pan = units(horizontal, finePan, panCarry);
        if (wheel || pan) send(0, 0, constrain(wheel, -32767, 32767), constrain(pan, -32767, 32767));
    }

  private:
    USBHID hid;
    uint8_t buttons = 0, fineWheel = 0, finePan = 0;
    int32_t wheelCarry = 0, panCarry = 0;
    static int32_t units(int32_t amount, bool fine, int32_t &carry) {
        if (fine) return amount;
        carry += amount;
        int32_t notches = carry / 120;
        carry -= notches * 120;
        return notches;
    }
    void send(int16_t dx, int16_t dy, int16_t wheel, int16_t pan) {
        if (bootProtocol()) return;
        uint8_t report[9] = {
            buttons,
            uint8_t(dx), uint8_t(dx >> 8), uint8_t(dy), uint8_t(dy >> 8),
            uint8_t(wheel), uint8_t(wheel >> 8), uint8_t(pan), uint8_t(pan >> 8),
        };
        hid.SendReport(kMouseReport, report, sizeof(report));
    }
};

/*
The HID interface, claimed before the USB library's devices claim it (this file's objects are built in order): the
library declares it with no boot protocol, which a BIOS ignores. This one is a boot keyboard, whose report descriptor
(every device's, with their report IDs) Windows reads as before.
*/
extern "C" uint16_t loadBootKeyboardInterface(uint8_t *destination, uint8_t *interface);
static const bool interfaceClaimed =
    tinyusb_enable_interface(USB_INTERFACE_HID, TUD_HID_INOUT_DESC_LEN, loadBootKeyboardInterface) == ESP_OK;
USBHIDKeyboard keyboard;
USBHIDConsumerControl consumer;
WheelMouse mouse;
extern "C" uint16_t loadBootKeyboardInterface(uint8_t *destination, uint8_t *interface) {
    static uint8_t scratch[512];
    uint16_t reportLength = keyboard._onGetDescriptor(scratch) + consumer._onGetDescriptor(scratch) +
                            mouse._onGetDescriptor(scratch);
    uint8_t name = tinyusb_add_string_descriptor("Remote Smart Trackpad dongle");
    uint8_t in = tinyusb_get_free_in_endpoint(), out = tinyusb_get_free_out_endpoint();
    if (!in || !out) return 0;
    uint8_t descriptor[TUD_HID_INOUT_DESC_LEN] = {
        TUD_HID_INOUT_DESCRIPTOR(*interface, name, HID_ITF_PROTOCOL_KEYBOARD, reportLength, out, uint8_t(0x80 | in), 64, 1),
    };
    *interface += 1;
    memcpy(destination, descriptor, sizeof(descriptor));
    return sizeof(descriptor);
}

// The keyboard as the sources hold it: modifiers and up to six keys.
KeyReport held = {};

void sendKeys(const KeyReport &report) {
    KeyReport copy = report;
    if (!bootProtocol()) return keyboard.sendReport(&copy);
    for (int wait = 0; wait < 50 && !tud_hid_ready(); wait++) delay(1);
    tud_hid_report(0, &copy, sizeof(copy));
}
void setKey(uint8_t usage, bool down) {
    if (usage >= 0xE0 && usage <= 0xE7) {
        uint8_t bit = 1 << (usage - 0xE0);
        held.modifiers = down ? held.modifiers | bit : held.modifiers & ~bit;
        return sendKeys(held);
    }
    int free = -1;
    for (int slot = 0; slot < 6; slot++) {
        if (held.keys[slot] == usage) {
            if (down) return;
            held.keys[slot] = 0;
            return sendKeys(held);
        }
        if (!held.keys[slot] && free < 0) free = slot;
    }
    if (!down || free < 0) return;
    held.keys[free] = usage;
    sendKeys(held);
}
void typeKey(uint8_t usage, uint8_t modifiers) {
    KeyReport press = {};
    press.modifiers = modifiers;
    // The modifiers alone first: some apps read them before the key.
    sendKeys(press);
    press.keys[0] = usage;
    sendKeys(press);
    press.keys[0] = 0;
    sendKeys(press);
    sendKeys(held);
}
void setConsumer(uint16_t usage, bool down) {
    if (bootProtocol()) return;
    if (down) consumer.press(usage);
    else consumer.release();
}
void releaseAll() {
    held = {};
    sendKeys(held);
    setConsumer(0, false);
    mouse.setButtons(0);
}

void setLed(uint8_t red, uint8_t green, uint8_t blue) {
    // APA102: a start frame, one LED frame (brightness, then blue, green, red), an end frame.
    const uint8_t frame[] = {0, 0, 0, 0, 0xE0 | 2, blue, green, red, 0xFF, 0xFF, 0xFF, 0xFF};
    for (uint8_t byte : frame) shiftOut(kLedData, kLedClock, MSBFIRST, byte);
}

void run(const char *line) {
    long first = 0, second = 0;
    int count = sscanf(line + 1, "%ld %ld", &first, &second);
    switch (line[0]) {
        case 'm': if (count == 2) mouse.move(first, second); break;
        case 'b': if (count == 1) mouse.setButtons(first & 7); break;
        case 'w': if (count == 2) mouse.scroll(first, second); break;
        case 'k': if (count == 2 && first > 0 && first <= 0xE7) setKey(first, second); break;
        case 't': if (count == 2 && first > 0 && first < 0xE0) typeKey(first, second); break;
        case 'c': if (count == 2) setConsumer(first, second); break;
        case 'r': releaseAll(); break;
    }
}
// Commands arrive as bytes; each source keeps its own unfinished line.
struct LineReader {
    char line[48];
    size_t length = 0;
    // Returns true when a whole line is ready in `line`.
    bool add(char character) {
        if (character == '\n') {
            line[length] = 0;
            bool whole = length > 0;
            length = 0;
            return whole;
        }
        if (character != '\r' && length < sizeof(line) - 1) line[length++] = character;
        return false;
    }
};

/*
Bluetooth: the phone writes commands to one characteristic, which only an encrypted (bonded) link may write. Commands
go through a stream buffer to the loop, which runs them with the USB serial's: HID reports never come from two tasks.
*/
StreamBufferHandle_t phoneCommands;
BLEServer *bluetooth;
volatile bool phoneConnected = false, phoneLeft = false;
volatile uint32_t pairingUntil = 0;
// The number of bonded phones when the current one connected: one more after its pairing is a new bond.
volatile int bondsAtConnect = 0;
uint16_t phoneConnection = 0;

bool pairingOpen() { return pairingUntil && int32_t(pairingUntil - millis()) > 0; }

class PhoneConnection : public BLEServerCallbacks {
    void onConnect(BLEServer *server, esp_ble_gatts_cb_param_t *parameters) override {
        phoneConnection = parameters->connect.conn_id;
        bondsAtConnect = esp_ble_get_bond_device_num();
        phoneConnected = true;
        // A short connection interval (7.5 to 15 ms): the pointer follows the finger.
        server->updateConnParams(parameters->connect.remote_bda, 6, 12, 0, 400);
    }
    void onDisconnect(BLEServer *server) override {
        phoneConnected = false;
        phoneLeft = true;
        BLEDevice::startAdvertising();
    }
};
class PhoneCommands : public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic *characteristic) override {
        std::string value = characteristic->getValue();
        xStreamBufferSend(phoneCommands, value.data(), value.size(), 0);
    }
};
class PhoneSecurity : public BLESecurityCallbacks {
    uint32_t onPassKeyRequest() override { return 0; }
    void onPassKeyNotify(uint32_t passKey) override {}
    bool onConfirmPIN(uint32_t passKey) override { return pairingOpen(); }
    bool onSecurityRequest() override { return true; }
    void onAuthenticationComplete(esp_ble_auth_cmpl_t result) override {
        if (!result.success || pairingOpen() || esp_ble_get_bond_device_num() <= bondsAtConnect) return;
        // A new phone bonded outside the pairing window: forget it and let it go.
        esp_ble_remove_bond_device(result.bd_addr);
        bluetooth->disconnect(phoneConnection);
    }
};

void startBluetooth() {
    phoneCommands = xStreamBufferCreate(2048, 1);
    BLEDevice::init("Trackpad dongle");
    // +15 dBm, up from the default +9, for a phone a room or two away. The S3 steps by 3 dB: +18 with a 3 dBi external
    // antenna would pass the European 20 dBm limit.
    BLEDevice::setPower(ESP_PWR_LVL_P15, ESP_BLE_PWR_TYPE_DEFAULT);
    BLEDevice::setPower(ESP_PWR_LVL_P15, ESP_BLE_PWR_TYPE_ADV);
    BLEDevice::setPower(ESP_PWR_LVL_P15, ESP_BLE_PWR_TYPE_SCAN);
    BLEDevice::setSecurityCallbacks(new PhoneSecurity());
    BLESecurity *security = new BLESecurity();
    security->setAuthenticationMode(ESP_LE_AUTH_REQ_SC_BOND);
    security->setCapability(ESP_IO_CAP_NONE);
    security->setInitEncryptionKey(ESP_BLE_ENC_KEY_MASK | ESP_BLE_ID_KEY_MASK);
    security->setRespEncryptionKey(ESP_BLE_ENC_KEY_MASK | ESP_BLE_ID_KEY_MASK);
    bluetooth = BLEDevice::createServer();
    bluetooth->setCallbacks(new PhoneConnection());
    BLEService *service = bluetooth->createService(kServiceUuid);
    BLECharacteristic *commands = service->createCharacteristic(
        kCommandsUuid, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
    commands->setAccessPermissions(ESP_GATT_PERM_WRITE_ENCRYPTED);
    commands->setCallbacks(new PhoneCommands());
    service->start();
    BLEAdvertising *advertising = BLEDevice::getAdvertising();
    advertising->addServiceUUID(kServiceUuid);
    advertising->setScanResponse(true);
    BLEDevice::startAdvertising();
}

void setup() {
    // The screen stays dark: its backlight is on when this pin is low.
    pinMode(kBacklight, OUTPUT);
    digitalWrite(kBacklight, HIGH);
    pinMode(kLedData, OUTPUT);
    pinMode(kLedClock, OUTPUT);
    pinMode(kBootButton, INPUT_PULLUP);
    setLed(0, 0, 40);
    USB.productName("Remote Smart Trackpad dongle");
    USB.manufacturerName("Remote Smart Trackpad");
    USB.onEvent(ARDUINO_USB_STARTED_EVENT, onConnection);
    USBHID().onEvent(ARDUINO_USB_HID_SET_PROTOCOL_EVENT, onProtocol);
    keyboard.begin();
    consumer.begin();
    mouse.begin();
    // Windows drops DTR and RTS in the order of esptool's reset when the host closes the port (a server restart): the
    // dongle would restart into download mode. Uploads go through the BOOT button instead.
    Serial.enableReboot(false);
    Serial.begin(115200);
    USB.begin();
    startBluetooth();
}

void loop() {
    static LineReader host, phone;
    static bool hostOpen = false;
    static int lastLed = -1;
    bool open = Serial;
    if (open != hostOpen) {
        hostOpen = open;
        if (!open) releaseAll();
    }
    if (phoneLeft) {
        phoneLeft = false;
        releaseAll();
    }
    // BOOT pressed: the pairing window opens for a new phone.
    if (digitalRead(kBootButton) == LOW) pairingUntil = (millis() + kPairingWindow) | 1;
    if (pairingUntil && !pairingOpen()) pairingUntil = 0;
    int led = pairingOpen() ? 2 : (hostOpen || phoneConnected) ? 1 : 0;
    if (led != lastLed) {
        lastLed = led;
        if (led == 2) setLed(30, 0, 40);
        else setLed(0, led ? 40 : 0, led ? 0 : 40);
    }
    while (Serial.available()) {
        if (!host.add(Serial.read())) continue;
        if (host.line[0] == '?') Serial.println(kIdentity);
        else run(host.line);
    }
    char received[64];
    size_t count;
    while ((count = xStreamBufferReceive(phoneCommands, received, sizeof(received), 0)) > 0)
        for (size_t index = 0; index < count; index++)
            if (phone.add(received[index])) run(phone.line);
    delay(1);
}
