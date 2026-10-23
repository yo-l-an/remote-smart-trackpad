import './remote.css';
import '../../ui/pointer-pad.js';
import { rowDefaults } from '../../ui/key-rows.js';
import '../../ui/text-editor.js';
import { addIcons } from '../../ui/icons.js';
import { attachHaptics, setHaptics, tick } from '../../ui/haptics.js';
import { createConnection } from '../../logic/connection.js';
import { bluetoothSupported, createDongleLink } from '../../logic/dongle-link.js';
import { createOptions } from '../../logic/options.js';
import { bindOptionsMenu, readSchema } from '../../ui/options-menu.js';
import { createTypingSession } from '../../logic/typing-session.js';
import { createMotion, pointerGain } from '../../logic/motion.js';
import { followPanel, morphPanel } from '../../ui/morph-panel.js';
import { fadeOverflow } from '../../ui/overflow-fade.js';

const $ = (selector) => document.querySelector(selector);
const storageKey = 'remote-smart-trackpad-layout';
addIcons(document);
attachHaptics(document);
// Function keys are re-rendered when their count changes; their new buttons get haptics too.
document.addEventListener('keys-rendered', (event) => attachHaptics(event.target));
const app = $('.app'),
    dock = $('.input-dock'),
    pad = $('pointer-pad'),
    rows = $('key-rows'),
    editor = $('text-editor'),
    menu = $('#options'),
    backdrop = $('#options-dismiss'),
    toggle = $('#options-toggle'),
    modeMenu = $('#mode-menu'),
    modeDismiss = $('#mode-dismiss'),
    modeButton = $('pointer-pad .mouse-mode'),
    holdClicks = $('#hold-clicks');
// Back and forward, in the top bar: the history shortcuts (Alt+Left, Alt+Right) of browsers, Explorer and most
// apps. Not the mouse's side buttons, which some apps take for something else (Zen browser switches spaces).
const navButtons = [...document.querySelectorAll('.topbar [data-nav]')];
for (const button of navButtons)
    button.addEventListener('click', () =>
        button.dispatchEvent(
            new CustomEvent('command', {
                bubbles: true,
                detail: {
                    action: 'shortcut',
                    data: { key: button.dataset.nav === 'back' ? 'Left' : 'Right', modifiers: ['Alt'] },
                },
            })
        )
    );
// Back and forward give their place to Connect USB dongle while it shows.
function showNavButtons() {
    for (const button of navButtons) button.hidden = option.navButtons === false || !$('#dongle-connect').hidden;
}
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const rem = (pixels) => `${pixels / parseFloat(getComputedStyle(document.documentElement).fontSize)}rem`;

// The options (CONTEXT.md): defaults from the menus' markup (the options menu, and the modes menu's options),
// remembered on this phone.
const options = createOptions(
    { ...readSchema(menu, rowDefaults), ...readSchema(modeMenu, {}) },
    {
        load: () => JSON.parse(localStorage.getItem(storageKey) || 'null') ?? undefined,
        save: (values) => localStorage.setItem(storageKey, JSON.stringify(values)),
        clear: () => localStorage.removeItem(storageKey),
    }
);
// The current values, read where they apply.
const option = options.values;

const labels = {
    pairing: 'Pair this device',
    connecting: 'Connecting…',
    disconnected: 'Disconnected',
    unavailable: 'PC unavailable · reconnecting…',
    ready: 'Connected with PC server',
    readyWithDongle: 'Connected with PC server and USB dongle',
    dongle: 'Connected with USB dongle',
};
// connectionState: the PC's connection. route: where commands go, 'pc', 'dongle' (the USB dongle over Bluetooth,
// while the PC is out of reach) or null.
let connectionState = 'connecting',
    route = null,
    connected = false,
    // The typing session's latest view (logic/typing-session.js).
    typing = { open: false },
    notice = '',
    // How the notice shows: warning (orange), danger (red, a permission Windows refused) or info (the dot as it is).
    noticeLevel = 'warning',
    noticeTimer;
function refreshStatus() {
    let message = labels[route ? 'ready' : connectionState],
        state = route ? 'ready' : connectionState;
    if (state === 'ready') {
        state = 'warning';
        if (notice) {
            message = notice;
            state = noticeLevel;
        } else if (typing.open && typing.error) message = typing.error;
        else if (typing.open && !typing.reading && !typing.readable)
            message = typing.reason || 'No text field · typing to PC';
        else state = 'ready';
    }
    if (!route && dongleError) message += ` · ${dongleError}`;
    $('#dongle-connect').hidden = !offerDongle();
    showNavButtons();
    $('#connection').dataset.state = state;
    // The dot is hollow while commands go through the USB dongle, full through the PC's server.
    $('#connection').dataset.route = route ?? '';
    $('#connection').title = message;
    $('#connection').setAttribute('aria-label', message);
    $('#connection-label').textContent = state === 'ready' ? '' : message;
}
// A tap on a quiet status (connected, nothing to say) tells for a moment what the remote is connected with.
$('#connection').addEventListener('click', () => {
    if (!route || $('#connection-label').textContent) return;
    const label =
        route === 'dongle' ? 'dongle'
        : pcDongle ? 'readyWithDongle'
        : 'ready';
    showNotice(labels[label], 3000, 'info');
});
/**
 * Shows a command error for a few seconds, then returns to the connection state. Not while disconnected: the
 * connection state says it already (a command sent as the phone wakes up fails before the connection is back).
 */
function showNotice(message, duration = 4000, level = 'warning') {
    if (!connected) return;
    notice = message;
    noticeLevel = level;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
        notice = '';
        refreshStatus();
    }, duration);
    refreshStatus();
}

// Layout: `editing` is the requested state (the PC text mirror is open); `shownEditing` is what the layout currently
// displays. Editing is compact (smaller gaps and keys) since the phone keyboard takes half the screen; every enabled
// key row stays. It lasts while the text field keeps the focus: see "Editing follows the text field's focus" below.
let editing = false,
    shownEditing = false,
    switching = false,
    morphs = 0;
const applyHaptics = () =>
    setHaptics({ button: option.buttonHaptics !== false, scroll: option.scrollHaptics !== false });
function applyLayout() {
    pad.sliding = option.mouseSliding === true;
    pad.edgeMotion = option.edgeMotion === true;
    pad.scrollSliding = option.scrollSliding !== false;
    pad.freeScroll = option.freeScroll === true;
    showModes();
    pad.tapScroll = { x: option.doubleTapScrollX === true, y: option.doubleTapScrollY === true };
    showNavButtons();
    applyHaptics();
    app.classList.toggle('editing', shownEditing);
    $('#editor-open').hidden = shownEditing;
    editor.hidden = !shownEditing;
    rows.configure(option);
}
/** Freezes the app and dock at their current size so the layout can change underneath. */
function pinGeometry() {
    morphs++;
    const start = { top: app.offsetTop, height: app.offsetHeight, dock: dock.offsetHeight };
    for (const animation of [...app.getAnimations(), ...dock.getAnimations()]) animation.cancel();
    app.style.top = rem(start.top);
    app.style.height = rem(start.height);
    dock.style.height = rem(start.dock);
    dock.classList.add('is-morphing');
    return start;
}
/**
 * Measures the layout as it will be once the CSS transitions that just started (key heights, paddings, rows: see
 * the sizes registered in style.css) have run: they jump to their end for the measure, then resume where they were.
 */
function settledSize(measure) {
    const running = document.getAnimations().filter((animation) => animation instanceof CSSTransition);
    const times = running.map((transition) => transition.currentTime);
    for (const transition of running) transition.currentTime = transition.effect.getComputedTiming().endTime;
    const size = measure();
    running.forEach((transition, index) => (transition.currentTime = times[index]));
    return size;
}
/** The layout's pace, --layout-transition in tokens.css: the morph and the sizes inside it move together. */
function layoutTiming() {
    const [duration, ...easing] = getComputedStyle(document.documentElement)
        .getPropertyValue('--layout-transition')
        .trim()
        .split(/\s+/);
    return {
        duration: parseFloat(duration) * (duration.endsWith('ms') ? 1 : 1000),
        easing: easing.join(' ') || 'ease',
    };
}
/** Animates the real layout from the pinned geometry to its new natural size; the trackpad follows as flex space. */
function morphFrom(start) {
    const token = morphs;
    app.style.top = app.style.height = dock.style.height = '';
    const end = settledSize(() => ({ top: app.offsetTop, height: app.offsetHeight, dock: dock.offsetHeight }));
    const timing = layoutTiming();
    const animations = [];
    if (start.top !== end.top || start.height !== end.height)
        animations.push(
            app.animate(
                [
                    { top: rem(start.top), height: rem(start.height) },
                    { top: rem(end.top), height: rem(end.height) },
                ],
                timing
            )
        );
    if (start.dock && end.dock && start.dock !== end.dock)
        animations.push(dock.animate([{ height: rem(start.dock) }, { height: rem(end.dock) }], timing));
    Promise.all(animations.map((animation) => animation.finished.catch(() => {}))).then(() => {
        if (token === morphs) dock.classList.remove('is-morphing');
    });
}
/** Runs a layout change and fades in the controls it reveals. */
function reveal(change) {
    const targets = [$('#editor-open'), editor, ...rows.rowElements];
    const wasHidden = targets.map((element) => element.hidden);
    change();
    if (reducedMotion()) return;
    targets.forEach((element, index) => {
        if (wasHidden[index] && !element.hidden)
            element.animate([{ opacity: 0 }, { opacity: 1 }], {
                duration: 220,
                delay: 60,
                easing: 'ease-out',
                fill: 'backwards',
            });
    });
}
/**
 * Switches the layout to the requested editing state, morphing from the current geometry. Opening moves at once: the
 * keyboard then shrinks the viewport, and resizeViewport morphs on from wherever this morph is.
 */
function switchEditing() {
    switching = true;
    const opening = editing,
        start = !reducedMotion() && pinGeometry();
    if (!opening) editor.blur();
    shownEditing = opening;
    reveal(applyLayout);
    // Still inside the tap that opened it, which the phone needs to show its keyboard.
    if (opening) editor.focus();
    if (start) morphFrom(start);
    switching = false;
    layout();
}
function layout({ animate = false } = {}) {
    if (switching) return;
    if (shownEditing !== editing) return void switchEditing();
    if (!animate || reducedMotion()) return applyLayout();
    const start = pinGeometry();
    reveal(applyLayout);
    morphFrom(start);
}

// Polling runs only while it can show something: a connected, visible page with the editor open or media keys shown.
// The mirror is read every 200 ms while something happens (typing, keys, clicks, a change on the PC) and slows down
// to once a second after a few quiet seconds, since the phone may stay awake on the remote for hours; any activity
// brings it straight back to full speed.
let mirrorTimer = 0,
    mirrorPolling = false,
    mirrorActiveAt = 0,
    movedAt = -Infinity,
    mediaTimer = 0;
function mirrorDelay() {
    const quiet = performance.now() - mirrorActiveAt;
    return (
        quiet < 3000 ? 200
        : quiet < 10_000 ? 500
        : 1000
    );
}
function pollMirrorLater(delay = mirrorDelay()) {
    clearTimeout(mirrorTimer);
    mirrorTimer = setTimeout(async () => {
        // Not while the pointer or a scroll moves: moving changes no text, and the PC answers commands in order, so a
        // read of a busy app would hold the motion up behind it.
        if (performance.now() - movedAt > 300) await session.poll();
        if (mirrorPolling) pollMirrorLater();
    }, delay);
}
function mirrorActivity() {
    const wasQuiet = mirrorDelay() > 200;
    mirrorActiveAt = performance.now();
    if (mirrorPolling && wasQuiet) pollMirrorLater(200);
}
for (const type of ['command', 'text-edit', 'text-caret', 'text-key', 'text-composition'])
    document.addEventListener(type, mirrorActivity, { capture: true });
function schedulePolling() {
    const active = connected && !document.hidden;
    const wantMirror = active && typing.open;
    if (wantMirror && !mirrorPolling) {
        mirrorPolling = true;
        mirrorActivity();
        pollMirrorLater(200);
    }
    if (!wantMirror && mirrorPolling) {
        mirrorPolling = false;
        clearTimeout(mirrorTimer);
    }
    const wantMedia = active && option.media && !typing.open;
    if (wantMedia && !mediaTimer) mediaTimer = setInterval(refreshMedia, 5000);
    if (!wantMedia && mediaTimer) {
        clearInterval(mediaTimer);
        mediaTimer = 0;
    }
}
async function refreshMedia() {
    if (!connected || !option.media) return;
    try {
        rows.media(await send('media-state'));
    } catch {}
}

/** Routes commands to the PC when it is connected, else to the USB dongle when it is, and updates the interface. */
function applyConnection() {
    const next =
        connectionState === 'ready' ? 'pc'
        : dongleLink.state === 'ready' ? 'dongle'
        : null;
    const pairing = connectionState === 'pairing';
    $('#pairing').hidden = !pairing;
    $('#controls').hidden = pairing;
    // A lost connection keeps the interface as it is (editing, the menu, modifiers shown held): only gestures in
    // progress end. The PC let go of every key meanwhile; the held modifiers are pressed again once back. Switching
    // between the PC and the dongle is both: what one held, the other never had.
    if (route && next !== route) {
        route = null;
        connected = false;
        pad.cancelGesture();
        session.disconnected();
        motion.reset();
    }
    if (next && next !== route) {
        route = next;
        connected = true;
        // An error from before the connection came back no longer applies.
        notice = '';
        dongleError = '';
        clearTimeout(noticeTimer);
        rows.restore();
        session.connected();
        refreshMedia();
        if (route === 'dongle') showNotice(labels.dongle, 4000, 'info');
        // A build may have landed while disconnected (the server restarts with the watcher's changes).
        if (__DEV_RELOAD__ && route === 'pc') document.dispatchEvent(new CustomEvent('dev-build'));
    }
    refreshStatus();
    schedulePolling();
}

/*
The USB dongle over Bluetooth (dongle/README.md), a fallback while the PC is out of reach (the BIOS): the phone drives
the dongle itself, typing blind through the layout chosen in the options. The PC tells whether its dongle is turned on
(dongle/.env); the phone remembers it, so the fallback still shows when the PC is gone, and forgets it only when the
PC says it is off. While the PC is out of reach and the phone is not on the dongle, Connect USB dongle shows in the top
bar: Web Bluetooth needs a tap to connect (Chrome on Android lets no page reconnect on its own). Once the PC is back,
commands go to it again.
*/
const dongleOfferedKey = 'remote-smart-trackpad-dongle-offered';
let dongleOffered = false,
    // The PC was lost (not just reconnecting between two retries).
    pcLost = false,
    // The PC's server uses a plugged-in dongle for the input Windows rejects (lock screen, UAC, admin apps).
    pcDongle = false,
    dongleError = '';
try {
    dongleOffered = localStorage.getItem(dongleOfferedKey) === 'true';
} catch {}
const dongleLink = createDongleLink({
    layout: () => option.dongleLayout,
    changed(state, reason) {
        // A dongle lost while the PC still is: the status says why.
        if (state === 'off' && route === 'dongle' && reason) dongleError = reason;
        applyConnection();
    },
});
function showDongleOptions() {
    $('#dongle-options').hidden = !dongleOffered;
}
function setDongleOffered(offered) {
    if (offered === dongleOffered) return;
    dongleOffered = offered;
    try {
        localStorage.setItem(dongleOfferedKey, String(offered));
    } catch {}
    if (!offered && dongleLink.state !== 'off') dongleLink.disconnect();
    showDongleOptions();
}
const offerDongle = () => dongleOffered && bluetoothSupported() && pcLost && dongleLink.state === 'off';
$('#dongle-connect').addEventListener('click', async () => {
    dongleError = '';
    try {
        await dongleLink.request();
    } catch (error) {
        // Closing the browser's device chooser is no error.
        if (error.name !== 'NotFoundError') dongleError = error.message;
    }
    refreshStatus();
});

const connection = createConnection(({ state, dongle, dongleConnected }) => {
    connectionState = state;
    pcDongle = state === 'ready' && dongleConnected === true;
    // Only a PC that says so turns the dongle off: an older server says nothing.
    if (typeof dongle === 'boolean') setDongleOffered(dongle);
    if (state === 'ready') {
        pcLost = false;
        dongleError = '';
        if (dongleLink.state !== 'off') dongleLink.disconnect();
    } else if (state === 'disconnected' || state === 'unavailable') pcLost = true;
    applyConnection();
});
// A command can come back with a notice: something the PC did on its own to carry it out (it moved the focus off an
// app run as administrator). Shown briefly: the next move would hide why the pointer jumped.
const send = (action, data) =>
    (route === 'dongle' ? dongleLink.send(action, data) : connection.send(action, data)).then((result) => {
        if (result?.notice) showNotice(result.notice, 2000, result.level);
        return result;
    });
const motion = createMotion(send, showNotice);
const session = createTypingSession({
    send,
    show(view) {
        typing = view;
        // Called when the PC's text, caret or field changed: keep reading closely while it does.
        mirrorActivity();
        editing = view.open;
        layout();
        editor.render(view);
        refreshStatus();
        schedulePolling();
    },
    modifiers: () => [...rows.held],
    notice: (error) => showNotice(error.message),
});
editor.heldModifiers = () => [...rows.held];
// The Keyboard options: capitals at the start of sentences, and a keyboard following the PC's field.
function applyKeyboard() {
    editor.keyboardOptions = {
        capitalize: option.autoCapitalize !== false,
        matchField: option.fieldKeyboard !== false,
    };
    editor.render(editor.view);
}
applyKeyboard();

// No zoom, whatever the browser allows (Firefox's "zoom on all websites" ignores user-scalable=no): the remote
// never uses two-finger gestures, so a second finger never reaches the browser's pinch handling.
// For 4 s after loading, zoom stays allowed so a page stuck zoomed can be pinched back out. Then a strict viewport
// (scale fixed at 1) is applied, which also makes the browser zoom back out natively; a later zoom is reset the same way.
const viewportMeta = $('meta[name="viewport"]');
const viewportBase = 'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content';
const viewportLocked = `${viewportBase}, minimum-scale=1, maximum-scale=1, user-scalable=no`;
let zoomGrace = true;
viewportMeta.content = viewportBase;
document.documentElement.classList.add('zoom-grace');
function resetZoom() {
    // Rewriting the tag with a different value, then the strict one, makes browsers re-apply it and clamp the scale.
    viewportMeta.content = `${viewportBase}, maximum-scale=1.01`;
    requestAnimationFrame(() => (viewportMeta.content = viewportLocked));
}
setTimeout(() => {
    zoomGrace = false;
    document.documentElement.classList.remove('zoom-grace');
    resetZoom();
}, 4000);
window.visualViewport?.addEventListener('resize', () => {
    if (!zoomGrace && Math.abs(visualViewport.scale - 1) > 0.01) resetZoom();
});
document.addEventListener(
    'touchmove',
    (event) => {
        if (!zoomGrace && event.touches.length > 1) event.preventDefault();
    },
    { passive: false }
);
for (const type of ['gesturestart', 'gesturechange'])
    document.addEventListener(type, (event) => zoomGrace || event.preventDefault());
document.addEventListener('motion-stop', () => motion.reset());
document.addEventListener('motion-release', (event) => motion.clear(event.detail.action));
document.addEventListener('pointerdown', () => pad.stopSliding(), { capture: true });
// Press feedback for everything tappable: buttons, option rows and segments (labels), links, disclosures. The
// pressed class is reliable on touch (:active can stick or never show) and held for a short beat, so quick taps still
// visibly press. A slider's own label only names it, so it has no press state.
// Button haptics: every button and link ticks when it acts. Those listed tick on their own terms (keys and mouse
// buttons on touch down, the stepper only when the value changes, the options toggle only when it opens), and the
// backdrop stays silent, like dismissing a native sheet.
const ticksItself =
    '.key-row button, .mouse-left, .mouse-right, .mouse-middle, .mouse-mode, .stepper button, #options-toggle, #options-dismiss, #mode-dismiss';
document.addEventListener('click', (event) => {
    const target = event.target.closest?.('button, a[href], summary');
    if (target && !target.matches(ticksItself)) tick();
});
// Inside something that scrolls (the options menu), a touch may be the start of a scroll: like native lists, the
// press state waits a beat and is dropped if the finger moves or the browser takes over to scroll.
const pressable = 'button, label:not(.speed-setting label), a[href], summary';
const pressDelay = 100,
    pressSlop = 8;
const pressed = new Map();
const inScroller = (element) => {
    for (let node = element.parentElement; node; node = node.parentElement) {
        const { overflowX, overflowY } = getComputedStyle(node);
        if (/auto|scroll/.test(overflowY) && node.scrollHeight > node.clientHeight) return true;
        if (/auto|scroll/.test(overflowX) && node.scrollWidth > node.clientWidth) return true;
    }
    return false;
};
const showPress = (entry) => {
    if (entry.shown) return;
    entry.shown = true;
    entry.at = performance.now();
    entry.element.classList.add('is-pressed');
};
document.addEventListener(
    'pointerdown',
    (event) => {
        const element = event.target.closest?.(pressable);
        if (!element || element.disabled) return;
        const entry = { element, x: event.clientX, y: event.clientY, shown: false };
        pressed.set(event.pointerId, entry);
        if (event.pointerType !== 'mouse' && inScroller(element))
            entry.timer = setTimeout(() => showPress(entry), pressDelay);
        else showPress(entry);
    },
    { capture: true }
);
document.addEventListener(
    'pointermove',
    (event) => {
        const entry = pressed.get(event.pointerId);
        if (!entry || entry.shown) return;
        if (Math.hypot(event.clientX - entry.x, event.clientY - entry.y) < pressSlop) return;
        clearTimeout(entry.timer);
        pressed.delete(event.pointerId);
    },
    { capture: true, passive: true }
);
const unpress = (event) => {
    const entry = pressed.get(event.pointerId);
    if (!entry) return;
    pressed.delete(event.pointerId);
    clearTimeout(entry.timer);
    // A quick tap lifts before the delay: it still presses. A scroll (pointercancel) never does.
    if (event.type === 'pointerup') showPress(entry);
    if (!entry.shown) return;
    setTimeout(() => entry.element.classList.remove('is-pressed'), Math.max(0, 90 - (performance.now() - entry.at)));
    // A tapped control gives focus back once its click ran, so it never lingers looking active.
    if (event.pointerType !== 'mouse')
        setTimeout(() => entry.element.contains(document.activeElement) && document.activeElement.blur());
};
// Input modality for CSS: focus rings only after keyboard use (see :root[data-modality] in style.css).
document.addEventListener(
    'pointerdown',
    (event) => (document.documentElement.dataset.modality = event.pointerType === 'mouse' ? 'mouse' : 'touch'),
    { capture: true }
);
document.addEventListener('keydown', () => (document.documentElement.dataset.modality = 'keyboard'), {
    capture: true,
});
document.addEventListener('pointerup', unpress, { capture: true });
document.addEventListener('pointercancel', unpress, { capture: true });

const mediaKeys = new Set(['PlayPause', 'VolumeMute']);
document.addEventListener('command', async (event) => {
    const { action, data } = event.detail;
    try {
        await send(action, data);
        if (!rows.sticky && (action === 'click' || (action === 'button' && !data.down))) rows.reset();
        // Playback state changes asynchronously in the media app; confirm the optimistic toggle shortly after.
        if (action === 'shortcut' && mediaKeys.has(data.key)) setTimeout(refreshMedia, 400);
        // A key the PC took, or a click, can move its caret away from what was typed blind.
        if (action === 'shortcut') session.pressed(data.key);
        else if (action === 'click' || (action === 'button' && !data.down)) session.clicked();
        else session.poll();
    } catch (error) {
        showNotice(error.message);
    }
});
document.addEventListener('motion', (event) => {
    movedAt = performance.now();
    const { action, dx, dy, speed = 0 } = event.detail;
    const mouse = action === 'move';
    const gain =
        mouse ?
            option.mouseSpeed * pointerGain(speed, option.mouseAcceleration)
        :   option.scrollSpeed * pointerGain(speed, option.scrollAcceleration);
    const signX = option[mouse ? 'invertMouseX' : 'invertScrollX'] ? -1 : 1;
    const signY = option[mouse ? 'invertMouseY' : 'invertScrollY'] ? -1 : 1;
    motion.add(action, dx * gain * signX, dy * gain * signY);
});
// A tap on a rail scrolls one wheel notch (120) that way, like a scroll bar's arrow: down/right below/right of its
// middle, whatever the scroll inversion (which follows a finger's drag).
document.addEventListener('scroll-step', (event) => {
    const { dx, dy } = event.detail;
    // The rail moves as a drag giving this scroll would have moved it (scrolling follows the inversion option).
    const inverted = option[dx ? 'invertScrollX' : 'invertScrollY'] ? -1 : 1;
    event.target.closest('scroll-rail')?.nudge((dx || dy) * inverted);
    send('scroll', { dx: dx * 120, dy: dy * 120 }).catch((error) => showNotice(error.message));
});
// Edge motion sends a velocity; the PC glides the pointer smoothly with the same speed, acceleration and inversion.
document.addEventListener('edge-glide', (event) => {
    const { vx, vy, speed } = event.detail;
    const gain = option.mouseSpeed * pointerGain(speed, option.mouseAcceleration);
    send('glide', {
        vx: vx * gain * (option.invertMouseX ? -1 : 1),
        vy: vy * gain * (option.invertMouseY ? -1 : 1),
    }).catch(() => {});
});
// The phone's text field reports to the typing session.
document.addEventListener('text-edit', (event) =>
    session.edit(event.detail.text, event.detail.start, event.detail.end)
);
document.addEventListener('text-caret', (event) => session.caret(event.detail.position, event.detail.selected));
document.addEventListener('text-composition', (event) => {
    const { composing, text, start, end } = event.detail;
    if (composing) session.compositionStart();
    else session.compositionEnd(text, start, end);
});
document.addEventListener('text-key', (event) => {
    session.key(event.detail.key);
    if (!rows.sticky) rows.reset();
});
// Editing follows the text field's focus. The text button opens it; it ends when a tap lands on the background
// (nothing there to act on), when the options menu opens (it covers the controls, the field included) or when the
// phone keyboard closes (its own close button, the back gesture). Every control keeps the focus in the field
// meanwhile, so the keyboard stays up and the layout never jumps: pointerdown is cancelled on them, which stops the
// browser from moving the focus.
const actionable =
    'button, a[href], label, input, select, summary, dialog, .options, pointer-pad, .key-rows, text-editor, #connection';
let backgroundTap = false;
function openEditor() {
    // A background tap from before editing opened says nothing about this one.
    backgroundTap = false;
    session.open();
    editor.focus();
}
function closeEditor() {
    if (!typing.open) return;
    editor.blur();
    session.close();
    rows.reset();
}
document.addEventListener(
    'pointerdown',
    (event) => {
        if (!typing.open) return;
        backgroundTap = !event.target.closest?.(actionable);
        if (!backgroundTap && !editor.contains(event.target)) event.preventDefault();
    },
    { capture: true }
);
editor.addEventListener('focusout', () =>
    setTimeout(() => {
        if (!typing.open || editor.contains(document.activeElement)) return;
        if (backgroundTap) return closeEditor();
        // Anything else that took the focus hands it back (not another app: the page itself lost the focus).
        if (document.hasFocus()) editor.focus();
    })
);
// The phone keyboard is up while the visual viewport is notably shorter than the screen (a quarter of it: browser
// bars take less, a keyboard much more). Desktop browsers never see it, so only the background closes editing there.
// True when it just went down while editing (its own close button, the back gesture), wherever the focus went.
let keyboardSeen = false;
function keyboardClosed() {
    const visible = window.visualViewport;
    if (!typing.open || !visible) return (keyboardSeen = false);
    const portrait = screen.orientation?.type.startsWith('portrait') ?? innerHeight > innerWidth;
    const screenHeight = portrait ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
    const keyboardUp = (screenHeight - visible.height * visible.scale) / screenHeight > 0.25;
    if (keyboardUp) keyboardSeen = true;
    return !keyboardUp && keyboardSeen;
}
$('#editor-open').addEventListener('click', openEditor);
$('#pair-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('#pair-error').textContent = '';
    try {
        await connection.pair($('#pair-name').value, $('#pair-code').value);
    } catch (error) {
        $('#pair-error').textContent = error.message;
    }
});

let backdropAnimation = null;
function setMenu(open) {
    if (open) {
        setModeMenu(false);
        pad.cancelGesture();
        // The menu makes the field inert, which takes the keyboard away: editing ends with it.
        closeEditor();
    }
    const shade = backdrop.hidden ? 0 : getComputedStyle(backdrop).opacity;
    backdropAnimation?.cancel();
    if (!open && menu.contains(document.activeElement)) toggle.focus({ preventScroll: true });
    toggle.setAttribute('aria-expanded', String(open));
    $('#controls').inert = open;
    $('#pairing').inert = open;
    menu.inert = !open;
    if (open) {
        menu.hidden = false;
        placeOptionsMenu();
    }
    // The menu morphs out of the options button (its round fill) and back into it.
    morphPanel(menu, toggle.querySelector('.fill') ?? toggle, open, { reduced: reducedMotion() });
    if (open) backdrop.hidden = false;
    if (reducedMotion()) return void (backdrop.hidden = !open);
    backdropAnimation = backdrop.animate([{ opacity: shade }, { opacity: open ? 1 : 0 }], {
        duration: open ? 200 : 150,
        easing: 'ease-out',
    });
    backdropAnimation.onfinish = () => {
        backdrop.hidden = !open;
    };
}
toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    // Opening ticks, closing stays silent.
    if (open) tick();
    setMenu(open);
});
backdrop.addEventListener('click', () => setMenu(false));
document.addEventListener('keydown', (event) => {
    // Escape inside the reset confirmation only closes the dialog.
    // Escape is the way out, e.g. when the remote is opened on the PC it controls: release every press at once
    // (held and latched mouse buttons, hold mode, modifiers, drag, glide) here and on the PC.
    if (event.key === 'Escape') {
        pad.setHolding(false);
        release();
    }
    if (event.key === 'Escape' && !$('#reset-confirm').open && toggle.getAttribute('aria-expanded') === 'true')
        setMenu(false);
    if (event.key === 'Escape') setModeMenu(false);
});

// The modes menu, from the MODE button in the pointer pad's corner: hold clicks, free scroll and sliding. Anchored
// on the button's bottom-right corner, it morphs out of the button's box (see morph-panel.js). A tap anywhere else
// closes it without acting.
const modeOpen = () => modeButton.getAttribute('aria-expanded') === 'true';
/**
 * Above the MODE button's tap area, 4px into its top (not on its box, which changes size with the modes), so the
 * button stays in sight; its right edge on the button's, but no closer to the screen's edge than the options menu
 * (the button's cell reaches the edge).
 */
function placeModeMenu() {
    const area = modeMenu.offsetParent.getBoundingClientRect(),
        cell = modeButton.getBoundingClientRect(),
        unit = parseFloat(getComputedStyle(document.documentElement).fontSize),
        edge = parseFloat(getComputedStyle(menu).right) / unit;
    // Left-handed, the button is in the bottom-left corner: the menu grows up and to the right from it.
    const left = option.hand === 'left';
    modeMenu.style.left = left ? `${Math.max((cell.left - area.left) / unit, edge)}rem` : '';
    modeMenu.style.right = left ? 'auto' : `${Math.max((area.right - cell.right) / unit, edge)}rem`;
    modeMenu.style.bottom = `${(area.bottom - cell.top - 4) / unit}rem`;
}
/** 2px under the options button's round fill, whatever the top bar's height (a long status grows it). */
function placeOptionsMenu() {
    const area = menu.offsetParent.getBoundingClientRect(),
        fill = (toggle.querySelector('.fill') ?? toggle).getBoundingClientRect(),
        unit = parseFloat(getComputedStyle(document.documentElement).fontSize);
    menu.style.setProperty('--options-top', `${(fill.bottom + 2 - area.top) / unit}rem`);
}
function setModeMenu(open, { fromKeyboard = false } = {}) {
    if (open === modeOpen()) return;
    if (open) {
        pad.cancelGesture();
        modeMenu.hidden = false;
        placeModeMenu();
    }
    if (!open && modeMenu.contains(document.activeElement)) modeButton.focus({ preventScroll: true });
    modeButton.setAttribute('aria-expanded', String(open));
    modeDismiss.hidden = !open;
    // From the keyboard, the focus moves into the menu; not while editing, where the text field keeps it.
    if (open && fromKeyboard && !typing.open) modeMenu.querySelector('input').focus({ preventScroll: true });
    morphPanel(modeMenu, modeButton.querySelector('.mode-box'), open, { reduced: reducedMotion() });
}
/**
 * The hold box and the MODE button follow the modes that are on: none shows MODE, quietly; one shows its icon (hold
 * clicks, free scroll); several show how many. The check badge marks any.
 */
let modeShown,
    modeAnimations = [];
function showModes() {
    holdClicks.checked = pad.holding;
    const active = [pad.holding && 'hold', option.freeScroll === true && 'scroll'].filter(Boolean);
    const shown = active.length > 1 ? 'several' : (active[0] ?? '');
    const box = modeButton.querySelector('.mode-box'),
        // Where the box is now, mid-animation included; then the running animations go, so the size measured next is
        // the new content's own (a toggle repeated quickly would otherwise measure the old animation's frame).
        from = box.getBoundingClientRect();
    if (shown !== modeShown) {
        for (const animation of modeAnimations) animation.cancel();
        modeAnimations = [];
    }
    if (shown) modeButton.dataset.active = shown;
    else delete modeButton.dataset.active;
    modeButton.querySelector('.mode-count').textContent = active.length > 1 ? String(active.length) : '';
    // A new content (MODE, an icon, a count): the box resizes to it and the content fades in. Not on the first show.
    if (modeShown !== undefined && shown !== modeShown && !reducedMotion() && from.width) {
        const to = box.getBoundingClientRect();
        const resize = box.animate(
            [
                { width: `${from.width}px`, height: `${from.height}px` },
                { width: `${to.width}px`, height: `${to.height}px` },
            ],
            { duration: 220, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
        );
        const content = [...box.children].find(
            (child) => !child.classList.contains('mode-badge') && getComputedStyle(child).display !== 'none'
        );
        const fade = content?.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: 160,
            delay: 60,
            easing: 'ease-out',
            fill: 'backwards',
        });
        modeAnimations = [resize, fade].filter(Boolean);
    }
    modeShown = shown;
    const names = { hold: 'Hold clicks', scroll: 'Free scroll' };
    modeButton.setAttribute(
        'aria-label',
        active.length ? `Modes: ${active.map((mode) => names[mode]).join(', ')}` : 'Modes'
    );
}
modeButton.addEventListener('click', (event) => {
    const open = !modeOpen();
    // Opening ticks, closing stays silent (as the options toggle).
    if (open) tick();
    setModeMenu(open, { fromKeyboard: event.detail === 0 });
});
modeDismiss.addEventListener('click', () => setModeMenu(false));
holdClicks.addEventListener('change', () => {
    pad.setHolding(holdClicks.checked);
    tick();
});
pad.addEventListener('holding-change', showModes);
// While editing, a tap on a row toggles its box without the label taking the focus from the text field.
modeMenu.addEventListener(
    'click',
    (event) => {
        if (!typing.open) return;
        const control = event.target.closest('label')?.control;
        if (!control || control === event.target) return;
        event.preventDefault();
        control.click();
    },
    { capture: true }
);

// Color scheme: Auto follows the device; Dark and Light force it (tokens.css reads data-theme).
const themeColor = $('meta[name="theme-color"]');
function applyTheme() {
    if (option.colorScheme === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = option.colorScheme;
    themeColor.content = getComputedStyle(document.body).backgroundColor;
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
// The hand holding the phone: the vertical rail and the MODE button go on its side. An open modes menu stays where
// it opened (placeModeMenu places it on the next opening).
let handAnimations = [];
function applyHand({ animate = false } = {}) {
    if (pad.dataset.hand === option.hand) return;
    for (const animation of handAnimations) animation.finish();
    handAnimations = [];
    const sliding = [pad.querySelector('.mouse'), pad.querySelector('scroll-rail[axis=x]')],
        arriving = [pad.querySelector('scroll-rail[axis=y]'), modeButton];
    const before = sliding.map((part) => part.getBoundingClientRect().left);
    // The pad's side padding swaps at once: its transition (for editing) would move the trackpad on its own.
    pad.style.transition = 'none';
    pad.dataset.hand = option.hand;
    const after = sliding.map((part) => part.getBoundingClientRect().left);
    pad.style.transition = '';
    if (!animate || reducedMotion()) return;
    // The trackpad and the horizontal rail slide over from where they stood; the vertical rail and the MODE button
    // come in from the screen's edge on their new side once the way is clear.
    const easing = 'cubic-bezier(0.2, 0, 0, 1)',
        edge = option.hand === 'left' ? -1 : 1;
    handAnimations = [
        ...sliding.map((part, index) =>
            part.animate([{ transform: `translateX(${before[index] - after[index]}px)` }, { transform: 'none' }], {
                duration: 320,
                easing,
            })
        ),
        ...arriving.map((part) =>
            part.animate(
                [
                    { opacity: 0, transform: `translateX(${edge * 0.75}rem)` },
                    { opacity: 1, transform: 'none' },
                ],
                { duration: 260, delay: 120, easing, fill: 'backwards' }
            )
        ),
    ];
    // Moving over, the parts reach past the pad (a rail coming in from beyond the screen's edge): clipped meanwhile,
    // they never make the page wider or taller.
    const switching = handAnimations;
    pad.classList.add('is-switching-hand');
    Promise.allSettled(switching.map((animation) => animation.finished)).then(() => {
        if (handAnimations === switching) pad.classList.remove('is-switching-hand');
    });
}
// The interface's base size: "1×" on the scale stepper is this much larger than the browser's default text size
// (1: the same).
const scaleBase = 1;
function applyScale() {
    document.documentElement.style.fontSize = `${option.uiScale * scaleBase * 100}%`;
    viewport();
}
bindOptionsMenu(menu, options);
bindOptionsMenu(modeMenu, options);
// Each part of the app follows the options it reads.
const layoutOptions = new Set([
    ...Object.keys(rowDefaults),
    'sticky',
    'functionKeys',
    'mouseSliding',
    'edgeMotion',
    'scrollSliding',
    'freeScroll',
    'doubleTapScrollX',
    'doubleTapScrollY',
    'navButtons',
]);
options.onChange((names) => {
    if (names.some((name) => name.endsWith('Haptics'))) applyHaptics();
    if (names.includes('colorScheme')) applyTheme();
    if (names.includes('uiScale')) applyScale();
    if (names.includes('autoCapitalize') || names.includes('fieldKeyboard')) applyKeyboard();
    if (names.includes('hand')) applyHand({ animate: true });
    if (names.some((name) => layoutOptions.has(name))) {
        rows.reset({ force: true });
        layout({ animate: true });
    }
    if (names.includes('media')) {
        schedulePolling();
        refreshMedia();
    }
});
showDongleOptions();
// Reset confirmation: fades and scales in; Cancel, Reset and Escape play the reverse before the dialog really closes.
const confirmDialog = $('#reset-confirm');
let closingDialog = false;
function animateDialog(opening) {
    if (reducedMotion()) return Promise.resolve();
    const panel = [
        { opacity: 0, transform: 'scale(0.96)' },
        { opacity: 1, transform: 'scale(1)' },
    ];
    const shade = [{ opacity: 0 }, { opacity: 1 }];
    const timing = {
        duration: opening ? 180 : 120,
        easing: opening ? 'cubic-bezier(0.2, 0, 0, 1)' : 'ease-in',
        fill: 'forwards',
    };
    const animation = confirmDialog.animate(opening ? panel : panel.reverse(), timing);
    try {
        confirmDialog.animate(opening ? shade : shade.reverse(), { ...timing, pseudoElement: '::backdrop' });
    } catch {}
    return animation.finished.catch(() => {});
}
async function closeDialog(value) {
    if (closingDialog || !confirmDialog.open) return;
    closingDialog = true;
    await animateDialog(false);
    confirmDialog.close(value);
    for (const animation of confirmDialog.getAnimations({ subtree: true })) animation.cancel();
    closingDialog = false;
}
confirmDialog.querySelector('form').addEventListener('submit', (event) => {
    event.preventDefault();
    closeDialog(event.submitter?.value ?? 'cancel');
});
confirmDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeDialog('cancel');
});
// Browsers only let `cancel` be vetoed after a user gesture; stopping Escape itself keeps the exit animation.
document.addEventListener(
    'keydown',
    (event) => {
        if (event.key !== 'Escape' || !confirmDialog.open) return;
        event.preventDefault();
        closeDialog('cancel');
    },
    { capture: true }
);
$('#options-reload').addEventListener('click', () => location.reload());
$('#options-reset').addEventListener('click', () => {
    // Escape leaves returnValue untouched, so clear the previous answer first.
    confirmDialog.returnValue = '';
    confirmDialog.showModal();
    animateDialog(true);
});
$('#reset-confirm').addEventListener('close', () => {
    if ($('#reset-confirm').returnValue !== 'reset') return;
    options.reset();
    // The modes too: free scroll and sliding are options; hold clicks is the pad's own state.
    pad.setHolding(false);
});
let shownHeight = 0;
function viewport() {
    const visible = window.visualViewport;
    const unit = parseFloat(getComputedStyle(document.documentElement).fontSize);
    shownHeight = visible?.height ?? innerHeight;
    document.documentElement.style.setProperty('--viewport-height', `${shownHeight / unit}rem`);
    document.documentElement.style.setProperty('--viewport-top', `${(visible?.offsetTop ?? 0) / unit}rem`);
}
// A new visible size (the phone keyboard coming up or going down) would snap the app to it. The current geometry is
// frozen first (mid-morph if one runs), then morphs to the new one; when the keyboard closed, the editor closes in the
// same move, its own morph starting from that frozen geometry. A pinch zoom just follows.
function resizeViewport() {
    const visible = window.visualViewport;
    const closed = keyboardClosed();
    const resized = Math.abs((visible?.height ?? innerHeight) - shownHeight) > 1;
    // The layout moves (the keyboard, a rotation): the modes menu would no longer sit on its button.
    if (resized) setModeMenu(false);
    const start = resized && !switching && !reducedMotion() && (visible?.scale ?? 1) === 1 ? pinGeometry() : null;
    viewport();
    const token = morphs;
    if (closed) closeEditor();
    if (start && morphs === token) morphFrom(start);
}
// The options menu opens under the top bar, which grows with a long status message.
new ResizeObserver(([entry]) => {
    const unit = parseFloat(getComputedStyle(document.documentElement).fontSize);
    document.documentElement.style.setProperty('--topbar-height', `${entry.target.offsetHeight / unit}rem`);
    // The open options menu stays under its button (the interface scale moves it): its container follows.
    if (toggle.getAttribute('aria-expanded') === 'true') {
        placeOptionsMenu();
        followPanel(menu);
    }
}).observe($('.topbar'));
// The options menu's edges fade where it scrolls on.
fadeOverflow(menu);
window.visualViewport?.addEventListener('resize', resizeViewport);
window.visualViewport?.addEventListener('scroll', viewport);
window.addEventListener('resize', resizeViewport);
const release = () => {
    pad.cancelGesture();
    motion.reset();
    rows.reset({ force: true });
    send('release').catch(() => {});
};
window.addEventListener('blur', release);
window.addEventListener('pagehide', release);
document.addEventListener('visibilitychange', () => {
    if (document.hidden) release();
    else if (connectionState === 'disconnected' || connectionState === 'unavailable') connection.wake();
    else {
        session.poll();
        refreshMedia();
    }
    schedulePolling();
});
// Installing as an app needs a service worker, which needs HTTPS this phone trusts (the PC's /trust page explains).
let installPrompt = null;
function offerTrust() {
    if (['localhost', '127.0.0.1'].includes(location.hostname)) return;
    $('#trust-pc').href = `http://${location.host}/trust`;
    $('#trust-pc').hidden = false;
}
addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    $('#install-app').hidden = false;
});
addEventListener('appinstalled', () => {
    installPrompt = null;
    $('#install-app').hidden = true;
});
$('#install-app').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => {});
    installPrompt = null;
    $('#install-app').hidden = true;
});
const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
if ('serviceWorker' in navigator && isSecureContext)
    navigator.serviceWorker
        .register('/sw.js')
        .then(() => {
            // Firefox never fires beforeinstallprompt; on Android it installs from its own menu instead.
            if (!installed && /Firefox/.test(navigator.userAgent) && /Android/.test(navigator.userAgent))
                $('#install-hint').hidden = false;
        })
        .catch(offerTrust);
else if (!installed) offerTrust();
// Development builds (npm run watch) reload when the bundle changed. Background pages freeze their timers, so the
// check also runs on every wake-up and when the server announces a build over the live connection.
if (__DEV_RELOAD__) {
    let revision;
    const checkBuild = async () => {
        try {
            const response = await fetch('/dev-build.json', { cache: 'no-store' });
            const next = (await response.json()).revision;
            if (revision && next && next !== revision) location.reload();
            revision ??= next;
        } catch {}
    };
    checkBuild();
    // The server announces builds over the connection; polling only covers a missed announcement.
    setInterval(checkBuild, 30_000);
    document.addEventListener('visibilitychange', () => document.hidden || checkBuild());
    for (const type of ['focus', 'pageshow', 'online']) addEventListener(type, checkBuild);
    document.addEventListener('dev-build', checkBuild);
}
applyScale();
applyTheme();
applyHand();
layout();
connection.connect();
