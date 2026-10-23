# USB dongle (optional)

A [LilyGO T-Dongle-S3](https://github.com/Xinyuan-LilyGO/T-Dongle-S3) plugged into the PC. Windows, and the BIOS, see it as a real keyboard and mouse. The remote works without it. It takes input from two sources:

- **The PC's server, over USB**, only where Windows rejects the remote's input: the secure desktop (the lock screen, UAC prompts) and an app run as administrator in front. There, the server sends the same moves, clicks, scrolls, keys and text to the dongle, which sends them to the PC. Everywhere else, input goes through Windows as before. Nothing changes on the phone.
- **The phone, over Bluetooth**, while the PC's server is out of reach: the BIOS, a PC that starts, a PC without the server. The phone drives the dongle itself (see [Bluetooth fallback](#bluetooth-fallback)). Once the PC is back, the phone goes back to it.

## Flash the firmware

1. Install [PlatformIO](https://platformio.org/install/cli), for example with `pip install platformio`, or as the PlatformIO extension of VS Code.
2. Hold the **BOOT** button while you plug the dongle in: it starts in download mode. Do this for every upload: the firmware does not restart into download mode on its own, because Windows would trigger that restart each time the server closes the port.
3. Build and upload from the project folder:

    ```bash
    pio run -d dongle -t upload
    ```

4. At the end, the upload restarts the dongle on the new firmware: the LED is blue, or green when the server or a phone is connected. If the LED stays off, unplug the dongle, then plug it in again without holding BOOT.

PlatformIO cannot build from a folder whose path holds a quote or a non-ASCII character, and it keeps its tools in the Windows user folder (`C:\Users\<name>\.platformio`). If the user name holds one, set the environment variable `PLATFORMIO_CORE_DIR` to another folder, for example `C:\.platformio`. If `pio` is not found after `pip install`, use `python -m platformio` instead.

## Turn it on

The feature is off by default: without it, the server does not look for a dongle. To turn it on:

1. Copy [.env.example](.env.example) to `dongle/.env` (Git ignores it), and set `DONGLE_ENABLED=true`.
2. Restart the server (tray menu, **Restart server**, or `npm restart`). Restart the tray too, so that its menu shows the new item: run the launcher again.

The tray menu then shows **Use the USB dongle**. Clear it to stop using the dongle without unplugging it: the change applies at once, and the next servers remember it (`.data/dongle-off`).

The server also tells the phones that the dongle is turned on: their options menu then shows a **USB dongle** group. A phone remembers it, so the group stays while the PC is out of reach; it goes away only when a server says the dongle is off.

## Use

Plug the dongle into the PC that runs the server. Within two seconds, the host finds it and its LED turns green. The console (tray menu, **Show console**) shows `USB dongle: connected on COMx`, and a tap on the phone's status dot shows **Connected with PC server and USB dongle**. This use of the dongle does not depend on the phone's options: the server's `dongle/.env` and the tray menu control it. When you unplug it, the host goes back to Windows input alone.

The host looks for the dongle among the serial ports of Espressif USB devices only, and asks each one for its name. A board of another project does not answer, and the host leaves it alone after three tries.

## Bluetooth fallback

When the phone cannot reach the PC's server (the BIOS, Windows still starting, a PC without the server), it can drive the dongle itself over Bluetooth. Once the PC is back, the phone goes back to it on its own.

### Before you need it

Do these steps once, while the PC and its server run:

1. Turn the feature on in `dongle/.env` (see [Turn it on](#turn-it-on)), and plug the dongle into the PC.
2. Open the remote on the phone, connected to the PC. The options menu now shows a **USB dongle** group at the bottom: the phone knows about the dongle.
3. Install the remote as an app (options menu, **Install as app**), or at least keep it open once over HTTPS. Without the PC, the phone opens the remote from its own copy: a phone that never opened it cannot load it.
4. Use Chrome or Edge, on Android or a computer. Safari on iPhone has no Web Bluetooth.

### Pair the phone (the first time)

1. Plug the dongle into the PC (powered on), and turn Bluetooth on on the phone.
2. Make the phone lose the PC: stop the server (tray menu, **Stop server**), or restart the PC into its BIOS. The status shows **Disconnected** (then **Connecting…** between two tries), and a **Connect USB dongle** button takes the place of back and forward, left of the options button.
3. Press the dongle's **BOOT** button once. For 60 seconds its LED is purple: the dongle accepts a new phone.
4. Within those 60 seconds, tap **Connect USB dongle**. If the browser asks for access to nearby devices, allow it. Pick **Trackpad dongle** in the list.
5. Accept the pairing request of the phone.

The status shows **Connected with USB dongle** for a few seconds, and its dot turns hollow (a ring): commands go through the dongle. The dongle's LED is green.

### Use it in the BIOS

1. Restart the PC and enter its BIOS with the PC's own keyboard (often Del, F2 or F10 during start-up): the dongle may lose its power while the PC restarts, and the phone its link to it.
2. Open the remote on the phone. It tries the PC, then shows **Disconnected** and the button.
3. Tap **Connect USB dongle**, and pick **Trackpad dongle**. A paired phone needs no BOOT press.
4. In the options menu, set **Dongle keyboard layout** to **QWERTY (US, BIOS)**: a BIOS reads every keyboard as US.
5. Use the keys, the key rows and the text field. A BIOS reads the dongle's keyboard only: the trackpad and the media keys do nothing there.

When Windows has started and the server answers again, the phone leaves the dongle and goes back to the PC. Set the layout back to **AZERTY** before you use the dongle in Windows (the lock screen of a PC without the server, for example).

### What changes through the dongle

- The phone types blind: nobody reads the PC's fields, so the text field shows only what you typed.
- Characters go through **Dongle keyboard layout**. On AZERTY, accents typed with a dead key work (`ê` is `^` then `e`). A character that no key types (an emoji) is left out, and the status says so.
- The media keys show no state (play or pause, mute).
- Windows' pointer speed applies to the pointer's moves.

### Reconnecting

Each time the phone loses the PC, tap **Connect USB dongle** and pick **Trackpad dongle** again: Web Bluetooth lets no page connect without a tap (Chrome on Android cannot reconnect on its own). A paired phone needs no BOOT press.

### Troubleshooting

| What you see                                       | What to do                                                                                                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No **USB dongle** group in the options, no button  | The phone has not seen the PC with the feature on: connect it to the PC once (see [Before you need it](#before-you-need-it)). A server that says the feature is off hides the group. |
| The remote does not open without the PC            | Open it once while the PC runs, or install it as an app.                                                                                                                             |
| **Trackpad dongle** is not in the list             | Check that the dongle is plugged in and its LED is on, that Bluetooth is on, and that the phone is near the PC.                                                                      |
| The pairing fails, or the connection drops at once | The 60-second window was closed: press BOOT, then tap the button again.                                                                                                              |
| The text comes out wrong (`qzerty`)                | Change **Dongle keyboard layout**: QWERTY in a BIOS, AZERTY in a French Windows.                                                                                                     |
| The pointer does not move in the BIOS              | Expected: a BIOS reads the dongle's keyboard only.                                                                                                                                   |

Only a paired phone may send to the dongle: it accepts a new pairing only while the BOOT button's window is open.

## Limits

- **USB**: the server must run. Before Windows starts, or on a PC without the server, use the [Bluetooth fallback](#bluetooth-fallback).
- **Pointer speed**: the dongle's pointer moves are relative, so the Windows pointer speed and **Enhance pointer precision** apply to them. Elsewhere, the remote places the pointer exactly.
- **Text** goes through the PC's keyboard layout: a character that one key types (with Shift or AltGr if necessary) works. A character that needs a dead key (`ê` on AZERTY) or that no key types (an emoji) does not reach the secure desktop or an app run as administrator.
- **Paste** (multi-line text in some fields) uses the clipboard of the user's desktop, which the secure desktop does not share.

## Protocol

One text command per line, the same on the serial port and on the Bluetooth characteristic. [src/main.cpp](src/main.cpp) lists them. `Dongle` in [host/windows/native.psm1](../host/windows/native.psm1) is the server side, [web/logic/dongle-link.js](../web/logic/dongle-link.js) and [dongle-keys.js](../web/logic/dongle-keys.js) the phone side. When a source goes away (the server stops, the phone disconnects), the dongle lets go of every key and button.

The BIOS asks for the boot protocol: the dongle's keyboard then sends plain boot reports. Its mouse and media keys stay silent there.

## Hardware notes

| Part           | GPIO                              |
| -------------- | --------------------------------- |
| APA102 LED     | data 40, clock 39 (BGR)           |
| LCD backlight  | 38 (low is on)                    |
| BOOT button    | 0                                 |
| ST7735 LCD SPI | MOSI 3, SCLK 5, CS 4, DC 2, RST 1 |

The firmware keeps the screen dark. [boards/t-dongle-s3.json](boards/t-dongle-s3.json) comes from LilyGO's board file (MIT), without its USB mode flags: this firmware needs the USB-OTG (TinyUSB) mode.
