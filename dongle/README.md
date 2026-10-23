# USB dongle (optional)

A [LilyGO T-Dongle-S3](https://github.com/Xinyuan-LilyGO/T-Dongle-S3) plugged into the PC. Windows sees it as a real keyboard and mouse. The remote works without it: nothing changes on the phone, and the PC uses it only where Windows rejects the remote's input:

- the secure desktop: the lock screen and UAC prompts,
- an app run as administrator in front.

There, the host sends the same moves, clicks, scrolls, keys and text to the dongle over its USB serial port, and the dongle sends them to the PC as a keyboard and a mouse. Everywhere else, input goes through Windows as before.

## Flash the firmware

1. Install [PlatformIO](https://platformio.org/install/cli), for example with `pip install platformio`, or as the PlatformIO extension of VS Code.
2. Hold the **BOOT** button while you plug the dongle in: it starts in download mode. Do this for every upload: the firmware does not restart into download mode on its own, because Windows would trigger that restart each time the server closes the port.
3. Build and upload from the project folder:

    ```bash
    pio run -d dongle -t upload
    ```

4. At the end, the upload restarts the dongle on the new firmware: the LED is blue, or green when the server runs. If the LED stays off, unplug the dongle, then plug it in again without holding BOOT.

PlatformIO cannot build from a folder whose path holds a quote or a non-ASCII character, and it keeps its tools in the Windows user folder (`C:\Users\<name>\.platformio`). If the user name holds one, set the environment variable `PLATFORMIO_CORE_DIR` to another folder, for example `C:\.platformio`. If `pio` is not found after `pip install`, use `python -m platformio` instead.

## Turn it on

The feature is off by default: without it, the server does not look for a dongle. To turn it on:

1. Copy [.env.example](.env.example) to `dongle/.env` (Git ignores it), and set `DONGLE_ENABLED=true`.
2. Restart the server (tray menu, **Restart server**, or `npm restart`). Restart the tray too, so that its menu shows the new item: run the launcher again.

The tray menu then shows **Use the USB dongle**. Clear it to stop using the dongle without unplugging it: the change applies at once, and the next servers remember it (`.data/dongle-off`).

## Use

Plug the dongle into the PC that runs the server. Within two seconds, the host finds it and its LED turns green. The console (tray menu, **Show console**) shows `USB dongle: connected on COMx`. When you unplug it, the host goes back to Windows input alone.

The host looks for the dongle among the serial ports of Espressif USB devices only, and asks each one for its name. A board of another project does not answer, and the host leaves it alone after three tries.

## Limits

- **The host must run.** The dongle does not reach the phone by itself: it does not work before a user signs in to Windows, or on a PC without the server.
- **Pointer speed**: the dongle's pointer moves are relative, so the Windows pointer speed and **Enhance pointer precision** apply to them. Elsewhere, the remote places the pointer exactly.
- **Text** goes through the PC's keyboard layout: a character that one key types (with Shift or AltGr if necessary) works. A character that needs a dead key (`ê` on AZERTY) or that no key types (an emoji) does not reach the secure desktop or an app run as administrator.
- **Paste** (multi-line text in some fields) uses the clipboard of the user's desktop, which the secure desktop does not share.

## Protocol

One text command per line on the serial port. [src/main.cpp](src/main.cpp) lists them. `Dongle` in [host/windows/native.psm1](../host/windows/native.psm1) is the host side. When the host's port closes (the server stops), the dongle lets go of every key and button.

## Hardware notes

| Part           | GPIO                              |
| -------------- | --------------------------------- |
| APA102 LED     | data 40, clock 39 (BGR)           |
| LCD backlight  | 38 (low is on)                    |
| BOOT button    | 0                                 |
| ST7735 LCD SPI | MOSI 3, SCLK 5, CS 4, DC 2, RST 1 |

The firmware keeps the screen dark. [boards/t-dongle-s3.json](boards/t-dongle-s3.json) comes from LilyGO's board file (MIT), without its USB mode flags: this firmware needs the USB-OTG (TinyUSB) mode.
