import { createDongleCommands } from './dongle-keys.js';

// The dongle's Bluetooth service and the characteristic that takes its commands (dongle/src/main.cpp).
const serviceUuid = '6f5c0001-2b6e-4a2c-9d3b-7a1e5c9f0d42';
const commandsUuid = '6f5c0002-2b6e-4a2c-9d3b-7a1e5c9f0d42';
// A write's room with Bluetooth's smallest packet; a command cut in two is put back together by the dongle.
const chunkSize = 20;

/** Whether this browser can reach the dongle (Chrome on Android, desktop Chrome and Edge; not iOS). */
export const bluetoothSupported = () => typeof navigator !== 'undefined' && Boolean(navigator.bluetooth);

/**
 * The phone's link to the USB dongle over Bluetooth Low Energy, for when the PC's server is out of reach (the BIOS).
 * It takes the remote's commands, as the server would (send(action, data) → Promise of the PC's answer), and writes
 * the dongle's: layout() names the keyboard layout to type with.
 *
 * changed(state, reason) on every change: 'off', 'connecting' or 'ready'; reason says why a link was lost. request() asks the user to pick the dongle (it
 * needs a tap); reconnect() reaches one this page was allowed before, without a tap, where the browser can
 * (navigator.bluetooth.getDevices): false when it cannot.
 */
export function createDongleLink({ changed, layout }) {
    const translator = createDongleCommands();
    let device = null,
        characteristic = null,
        state = 'off',
        writes = Promise.resolve();
    // Edge motion: the PC's server glides the pointer itself; here a timer sends the moves, on the same terms.
    let glide = { vx: 0, vy: 0, until: 0, carryX: 0, carryY: 0, timer: 0, last: 0 };
    const encoder = new TextEncoder();
    function set(next, reason) {
        if (state === next) return;
        state = next;
        changed(state, reason);
    }
    function lost(reason) {
        characteristic = null;
        translator.reset();
        stopGlide();
        set('off', reason);
    }
    // The browser noticed the link is gone (unless this page closed it, and so already knows).
    async function dropped() {
        if (state === 'off') return;
        lost((await explained('Lost the connection to the USB dongle')).message);
    }
    // Web Bluetooth's own errors say little ("GATT operation failed for unknown reason"): these say what happened.
    const bluetoothOff = async () => (await navigator.bluetooth.getAvailability?.().catch(() => true)) === false;
    const explained = async (lostMessage) =>
        new Error((await bluetoothOff()) ? 'Bluetooth is off on this phone' : lostMessage);
    // A write that fails means the link is gone (Bluetooth turned off, the dongle out of reach): the remote hears it
    // at once, without waiting for the browser to notice.
    function write(commands) {
        const bytes = encoder.encode(commands.map((command) => `${command}\n`).join(''));
        const target = characteristic;
        writes = writes
            .catch(() => {})
            .then(async () => {
                for (let start = 0; start < bytes.length; start += chunkSize)
                    await target.writeValueWithoutResponse(bytes.subarray(start, start + chunkSize));
            })
            .catch(async () => {
                const error = await explained('Lost the connection to the USB dongle');
                if (characteristic === target) lost(error.message);
                throw error;
            });
        return writes;
    }
    async function attach(found) {
        set('connecting');
        try {
            if (device !== found) {
                device?.removeEventListener('gattserverdisconnected', dropped);
                device = found;
                device.addEventListener('gattserverdisconnected', dropped);
            }
            const server = await device.gatt.connect();
            const service = await server.getPrimaryService(serviceUuid);
            const commands = await service.getCharacteristic(commandsUuid);
            // The first write waits for an answer: on a phone not bonded yet, it starts the pairing.
            await commands.writeValueWithResponse(encoder.encode('r\n'));
            characteristic = commands;
            translator.reset();
            set('ready');
        } catch {
            characteristic = null;
            set('off');
            throw await explained('Could not reach the USB dongle');
        }
    }
    function stopGlide() {
        clearInterval(glide.timer);
        glide = { vx: 0, vy: 0, until: 0, carryX: 0, carryY: 0, timer: 0, last: 0 };
    }
    // Velocity in pixels per millisecond, renewed every 100 ms by the phone; without news for 300 ms it stops.
    function setGlide(vx, vy) {
        Object.assign(glide, { vx, vy, until: performance.now() + 300 });
        if ((!vx && !vy) || glide.timer) return;
        glide.last = performance.now();
        glide.timer = setInterval(() => {
            const now = performance.now();
            if (now > glide.until || !characteristic) return stopGlide();
            const elapsed = Math.min(50, now - glide.last);
            glide.last = now;
            glide.carryX += glide.vx * elapsed;
            glide.carryY += glide.vy * elapsed;
            const dx = Math.round(glide.carryX),
                dy = Math.round(glide.carryY);
            glide.carryX -= dx;
            glide.carryY -= dy;
            if (dx || dy) write([`m ${dx} ${dy}`]).catch(() => {});
        }, 16);
    }
    return {
        get state() {
            return state;
        },
        async request() {
            if (await bluetoothOff()) throw new Error('Bluetooth is off on this phone');
            const found = await navigator.bluetooth.requestDevice({ filters: [{ services: [serviceUuid] }] });
            await attach(found);
        },
        async reconnect() {
            if (state !== 'off' || !navigator.bluetooth?.getDevices) return false;
            if (await bluetoothOff()) throw new Error('Bluetooth is off on this phone');
            const known = await navigator.bluetooth.getDevices();
            const found = known.find((candidate) => candidate === device) ?? known[0];
            if (!found) return false;
            await attach(found);
            return true;
        },
        disconnect() {
            stopGlide();
            if (characteristic) write(['r']).catch(() => {});
            const leaving = device;
            writes.finally(() => leaving?.gatt.disconnect());
            lost();
        },
        async send(action, data = {}) {
            if (!characteristic) throw new Error('USB dongle disconnected');
            if (action === 'glide') {
                setGlide(Number(data.vx) || 0, Number(data.vy) || 0);
                return null;
            }
            const { commands, result } = translator.translate(action, data, layout());
            if (commands.length) await write(commands);
            return result;
        },
    };
}
