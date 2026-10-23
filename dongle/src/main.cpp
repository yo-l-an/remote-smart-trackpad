/*
Remote Smart Trackpad dongle: a LilyGO T-Dongle-S3 that the PC's host drives over USB serial, and that the PC sees as a
real keyboard and mouse. The host sends it only the input Windows rejects from an app (the secure desktop: sign-in,
lock screen, UAC prompts; an app run as administrator in front): see Dongle in host/windows/native.psm1.

One command per line, numbers in decimal:
  ?               answers "remote-smart-trackpad-dongle <version>"
  m dx dy         pointer moves by dx, dy
  b buttons       mouse buttons held: 1 left, 2 right, 4 middle
  w v h           wheel turns by v (up) and h (right), in 1/120 of a notch
  k usage 0|1     keyboard key (HID usage, modifiers 0xE0 to 0xE7 included) let go or held
  t usage mods    key typed once with exactly these modifiers, the held keys put back afterwards
  c usage 0|1     consumer key (volume, media) let go or held
  r               everything let go
When the host's serial port closes (the host stopped), everything is let go.
The LED is blue while no host has the port open, green once one has.
*/
#include <Arduino.h>
#include "USB.h"
#include "USBHID.h"
#include "USBHIDConsumerControl.h"
#include "USBHIDKeyboard.h"

static const char *kIdentity = "remote-smart-trackpad-dongle 1";
static const uint8_t kLedData = 40, kLedClock = 39, kBacklight = 38;
static const uint8_t kMouseReport = 2;

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
        uint8_t report[9] = {
            buttons,
            uint8_t(dx), uint8_t(dx >> 8), uint8_t(dy), uint8_t(dy >> 8),
            uint8_t(wheel), uint8_t(wheel >> 8), uint8_t(pan), uint8_t(pan >> 8),
        };
        hid.SendReport(kMouseReport, report, sizeof(report));
    }
};

USBHIDKeyboard keyboard;
USBHIDConsumerControl consumer;
WheelMouse mouse;
// The keyboard as the host holds it: modifiers and up to six keys.
KeyReport held = {};

void sendKeys(const KeyReport &report) {
    KeyReport copy = report;
    keyboard.sendReport(&copy);
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
void releaseAll() {
    held = {};
    sendKeys(held);
    consumer.release();
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
        case '?': Serial.println(kIdentity); break;
        case 'm': if (count == 2) mouse.move(first, second); break;
        case 'b': if (count == 1) mouse.setButtons(first & 7); break;
        case 'w': if (count == 2) mouse.scroll(first, second); break;
        case 'k': if (count == 2 && first > 0 && first <= 0xE7) setKey(first, second); break;
        case 't': if (count == 2 && first > 0 && first < 0xE0) typeKey(first, second); break;
        case 'c':
            if (count == 2 && second) consumer.press(first);
            else if (count == 2) consumer.release();
            break;
        case 'r': releaseAll(); break;
    }
}

void setup() {
    // The screen stays dark: its backlight is on when this pin is low.
    pinMode(kBacklight, OUTPUT);
    digitalWrite(kBacklight, HIGH);
    pinMode(kLedData, OUTPUT);
    pinMode(kLedClock, OUTPUT);
    setLed(0, 0, 40);
    USB.productName("Remote Smart Trackpad dongle");
    USB.manufacturerName("Remote Smart Trackpad");
    keyboard.begin();
    consumer.begin();
    mouse.begin();
    // Windows drops DTR and RTS in the order of esptool's reset when the host closes the port (a server restart): the
    // dongle would restart into download mode. Uploads go through the BOOT button instead.
    Serial.enableReboot(false);
    Serial.begin(115200);
    USB.begin();
}

void loop() {
    static char line[48];
    static size_t length = 0;
    static bool hostOpen = false;
    bool open = Serial;
    if (open != hostOpen) {
        hostOpen = open;
        if (!open) releaseAll();
        setLed(0, open ? 40 : 0, open ? 0 : 40);
    }
    while (Serial.available()) {
        char character = Serial.read();
        if (character == '\n') {
            line[length] = 0;
            if (length) run(line);
            length = 0;
        } else if (character != '\r' && length < sizeof(line) - 1) {
            line[length++] = character;
        }
    }
    delay(1);
}
