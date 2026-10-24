import './scroll-rail.js';
import { icon } from './icons.js';
import { createEdgeMotion } from './edge-motion.js';
import { createJoystick } from './joystick.js';
import { blockMenu, tick } from './haptics.js';

class PointerPad extends HTMLElement {
    holding = false;
    slidingEnabled = false;
    #edgeMotion = false;
    /** Keep moving the pointer while a dragging finger rests near a screen edge (see edge-motion.js). */
    set edgeMotion(value) {
        this.#edgeMotion = value;
        if (!value) this.edges?.end();
    }
    #joystickMouse = false;
    #joystickScroll = false;
    /**
     * Joystick mode (see joystick.js), for the pointer (mouse) and for free scroll (scroll): the finger's distance from
     * where it touched sets the speed, as long as it rests there.
     */
    set joystick({ mouse, scroll }) {
        if (mouse !== this.#joystickMouse || scroll !== this.#joystickScroll) this.cancelGesture?.();
        this.#joystickMouse = mouse;
        this.#joystickScroll = scroll;
    }
    slideFrame = 0;
    set sliding(value) {
        if (this.slidingEnabled && !value) this.stopSliding();
        this.slidingEnabled = value;
    }
    #scrollSliding = true;
    set scrollSliding(value) {
        this.#scrollSliding = value;
        for (const rail of this.querySelectorAll('scroll-rail')) rail.sliding = value;
    }
    #freeScroll = false;
    get freeScroll() {
        return this.#freeScroll;
    }
    /**
     * Free scroll: the trackpad scrolls the PC instead of moving its pointer, the content following the finger like
     * on the rails (with the scroll options: speed, acceleration, inversion, sliding). Taps still click.
     */
    set freeScroll(value) {
        if (this.#freeScroll === value) return;
        this.cancelGesture?.();
        this.#freeScroll = value;
        this.querySelector('.trackpad')?.setAttribute('aria-label', value ? 'Scroll PC' : 'Move PC pointer');
    }
    /** Which rails scroll one step on a double tap: { x, y }. */
    set tapScroll({ x, y }) {
        for (const rail of this.querySelectorAll('scroll-rail'))
            rail.tapStep = rail.getAttribute('axis') === 'x' ? x : y;
    }
    stopSliding() {
        cancelAnimationFrame(this.slideFrame);
        this.slideFrame = 0;
        this.dispatchEvent(new CustomEvent('motion-stop', { bubbles: true }));
    }
    disconnectedCallback() {
        this.cancelGesture();
    }
    connectedCallback() {
        if (this.firstChild) return;
        this.innerHTML = `<div class="mouse"><div class="trackpad" role="application" aria-label="Move PC pointer"><div class="dots"></div></div><button class="mouse-left" aria-label="Left click" data-button="left"></button><button class="mouse-middle" aria-label="Middle click" data-button="middle"><span class="middle-dot"></span></button><button class="mouse-right" aria-label="Right click" data-button="right"></button></div><scroll-rail axis="y"></scroll-rail><scroll-rail axis="x"></scroll-rail><button class="mouse-mode" aria-label="Modes" aria-haspopup="true" aria-expanded="false" aria-controls="mode-menu"><span class="mode-box"><span class="mode-text">MODE</span><span class="mode-icon" data-mode="hold"></span><span class="mode-icon" data-mode="scroll"></span><span class="mode-icon" data-mode="joystick"></span><span class="mode-count"></span><span class="mode-badge"></span></span></button>`;
        const pad = this.querySelector('.trackpad');
        // Gestures: one finger moves, a tap clicks (two quick taps double-click), and tap-then-touch-and-move drags
        // with the left button held until the finger lifts. A single tap's click waits one double-tap window so a
        // drag never starts with an extra click (which would open a file or maximize a window).
        const tapSlop = 10,
            tapDuration = 400,
            doubleTapWindow = 250,
            doubleTapDistance = 48;
        let pointer = null,
            x = 0,
            y = 0,
            startX = 0,
            startY = 0,
            startTime = 0,
            patternX = 0,
            patternY = 0,
            velocityX = 0,
            velocityY = 0,
            lastMove = 0,
            moved = false,
            pendingTap = null,
            secondTouch = false,
            dragging = false,
            buffered = [];
        const command = (detail) => this.dispatchEvent(new CustomEvent('command', { bubbles: true, detail }));
        const click = () => command({ action: 'click', data: { button: 'left' } });
        // speed is the smoothed finger velocity in CSS px/ms, used for pointer acceleration.
        const shiftPattern = (dx, dy) => {
            const unit = parseFloat(getComputedStyle(document.documentElement).fontSize);
            patternX = (patternX + dx) % (1.5 * unit);
            patternY = (patternY + dy) % (1.5 * unit);
            this.querySelector('.dots').style.backgroundPosition =
                `calc(50% + ${patternX / unit}rem) calc(50% + ${patternY / unit}rem)`;
        };
        // The pattern is anchored at the pad's center: a resize (the editor opening, the keyboard) keeps the dots
        // where they stand from it.
        const move = (dx, dy, speed) => {
            shiftPattern(dx, dy);
            const detail =
                this.#freeScroll ? { action: 'scroll', dx: -dx, dy: -dy, speed } : { action: 'move', dx, dy, speed };
            this.dispatchEvent(new CustomEvent('motion', { bubbles: true, detail }));
        };
        const edges = (this.edges = createEdgeMotion({
            glide: (vx, vy, speed) =>
                this.dispatchEvent(new CustomEvent('edge-glide', { bubbles: true, detail: { vx, vy, speed } })),
            animate: shiftPattern,
        }));
        const dragAt = (event) => this.#edgeMotion && !this.#freeScroll && edges.update(event.clientX, event.clientY);
        // Joystick mode: the pointer glides on the PC as with edge motion; a scroll is sent each frame.
        const pointerStick = createJoystick({
                glide: (vx, vy, speed) =>
                    this.dispatchEvent(new CustomEvent('edge-glide', { bubbles: true, detail: { vx, vy, speed } })),
                animate: shiftPattern,
            }),
            scrollStick = createJoystick({ step: (dx, dy, speed) => move(dx, dy, speed) });
        const stick = () =>
            this.#freeScroll ? this.#joystickScroll && scrollStick : this.#joystickMouse && pointerStick;
        const flushTap = () => {
            if (!pendingTap) return;
            clearTimeout(pendingTap.timer);
            pendingTap = null;
            click();
        };
        const setDragging = (value) => {
            if (dragging === value) return;
            dragging = value;
            pad.classList.toggle('is-dragging', value);
            command({ action: 'button', data: { button: 'left', down: value } });
            if (value) tick();
        };
        this.cancelGesture = () => {
            this.stopSliding();
            edges.end();
            pointerStick.end();
            scrollStick.end();
            this.releaseButtons?.();
            flushTap();
            setDragging(false);
            secondTouch = false;
            buffered = [];
            if (pointer !== null && pad.hasPointerCapture(pointer)) pad.releasePointerCapture(pointer);
            pointer = null;
        };
        const glide = () => {
            let previous = performance.now();
            const step = (now) => {
                const elapsed = now - previous;
                previous = now;
                if (elapsed > 100 || Math.hypot(velocityX, velocityY) < 0.01) {
                    this.slideFrame = 0;
                    return;
                }
                const decay = Math.exp(-elapsed / 240);
                move(velocityX * 240 * (1 - decay), velocityY * 240 * (1 - decay), Math.hypot(velocityX, velocityY));
                velocityX *= decay;
                velocityY *= decay;
                this.slideFrame = requestAnimationFrame(step);
            };
            this.slideFrame = requestAnimationFrame(step);
        };
        pad.addEventListener('pointerdown', (event) => {
            if (pointer !== null) return;
            pointer = event.pointerId;
            x = startX = event.clientX;
            y = startY = event.clientY;
            startTime = lastMove = performance.now();
            moved = false;
            velocityX = velocityY = 0;
            buffered = [];
            // A touch right after a tap, near it, may become a double click or a drag; decide on move or lift.
            if (pendingTap && Math.hypot(x - pendingTap.x, y - pendingTap.y) < doubleTapDistance) {
                clearTimeout(pendingTap.timer);
                pendingTap = null;
                secondTouch = true;
            } else flushTap();
            pad.setPointerCapture(pointer);
        });
        pad.addEventListener('pointermove', (event) => {
            if (event.pointerId !== pointer) return;
            const dx = event.clientX - x,
                dy = event.clientY - y;
            x = event.clientX;
            y = event.clientY;
            moved ||= Math.hypot(x - startX, y - startY) > tapSlop;
            const now = performance.now();
            const elapsed = Math.max(1, now - lastMove);
            const blend = elapsed > 100 ? 1 : 0.5;
            velocityX = velocityX * (1 - blend) + (dx / elapsed) * blend;
            velocityY = velocityY * (1 - blend) + (dy / elapsed) * blend;
            lastMove = now;
            const speed = Math.hypot(velocityX, velocityY);
            const joystick = stick();
            if (joystick) {
                // Tap then touch: a drag holds the left button while the joystick moves (free scroll: a click, then
                // the scroll), as without the joystick.
                if (secondTouch && !dragging) {
                    if (!moved) return;
                    if (this.#freeScroll) {
                        secondTouch = false;
                        click();
                    } else setDragging(true);
                    buffered = [];
                }
                if (moved) joystick.update(x - startX, y - startY);
                return;
            }
            if (secondTouch && !dragging) {
                // Hold the first pixels back so the button goes down where the second touch landed.
                buffered.push([dx, dy, speed]);
                if (!moved) return;
                // Scrolling drags nothing: the first tap was a click, this touch scrolls.
                if (this.#freeScroll) {
                    secondTouch = false;
                    click();
                    for (const delta of buffered.splice(0)) move(...delta);
                    return;
                }
                setDragging(true);
                for (const delta of buffered.splice(0)) move(...delta);
                dragAt(event);
                return;
            }
            move(dx, dy, speed);
            dragAt(event);
        });
        pad.addEventListener('pointerup', (event) => {
            if (event.pointerId !== pointer) return;
            pointer = null;
            edges.end();
            const joystick = stick();
            pointerStick.end();
            scrollStick.end();
            const tap = !moved && performance.now() - startTime < tapDuration;
            if (dragging) setDragging(false);
            else if (secondTouch) {
                if (tap) {
                    click();
                    click();
                } else {
                    // A second touch held without moving: still the first tap's click.
                    click();
                    for (const delta of buffered) move(...delta);
                }
            } else if (tap) {
                const timer = setTimeout(() => {
                    pendingTap = null;
                    click();
                }, doubleTapWindow);
                pendingTap = { x: startX, y: startY, timer };
            } else if (
                !joystick
                && (this.#freeScroll ? this.#scrollSliding : this.slidingEnabled)
                && performance.now() - lastMove < 100
                && !this.querySelector('.is-held')
            )
                glide();
            secondTouch = false;
            buffered = [];
        });
        pad.addEventListener('pointercancel', this.cancelGesture);
        pad.addEventListener('lostpointercapture', () => {
            if (pointer !== null) this.cancelGesture();
        });
        // The corner's MODE button opens the modes menu (remote.js); its badge shows a mode is on.
        const mode = this.querySelector('.mouse-mode');
        mode.querySelector('.mode-badge').append(icon('check'));
        mode.querySelector('[data-mode=hold]').append(icon('hold'));
        mode.querySelector('[data-mode=scroll]').append(icon('free-scroll'));
        mode.querySelector('[data-mode=joystick]').append(icon('joystick'));
        mode.addEventListener('pointerdown', (event) => event.preventDefault());
        // Hold mode: a tap presses a mouse button and keeps it down until the next tap on it (one finger at a time).
        const latched = new Set();
        const setLatched = (button, down) => {
            if (down) latched.add(button);
            else latched.delete(button);
            button.classList.toggle('is-latched', down);
            command({ action: 'button', data: { button: button.dataset.button, down } });
        };
        this.releaseButtons = () => {
            for (const button of [...latched]) setLatched(button, false);
        };
        /** Turns hold mode on or off (the modes menu, Escape); `holding-change` tells who shows it. */
        this.setHolding = (value) => {
            if (!value) this.releaseButtons();
            if (this.holding === value) return;
            this.holding = value;
            this.dispatchEvent(new CustomEvent('holding-change', { bubbles: true, detail: { holding: value } }));
        };
        this.querySelectorAll('[data-button]').forEach((button) => {
            // held: the finger holds the button down (outside hold mode). last: the finger is down and followed, in
            // both modes, so a press can drag the pointer (in hold mode the button then stays latched after lifting).
            let held = false,
                last = null;
            button.addEventListener('pointerdown', (event) => {
                event.preventDefault();
                if (last) return;
                tick();
                button.setPointerCapture(event.pointerId);
                last = { x: event.clientX, y: event.clientY, time: performance.now() };
                if (this.holding) return setLatched(button, !latched.has(button));
                held = true;
                button.classList.add('is-held');
                command({ action: 'button', data: { button: button.dataset.button, down: true } });
            });
            const release = () => {
                edges.end();
                last = null;
                if (held) {
                    held = false;
                    button.classList.remove('is-held');
                    command({ action: 'button', data: { button: button.dataset.button, down: false } });
                }
            };
            // Dragging from a held button moves the pointer too: click-and-drag with one finger (left: select or move,
            // right: context gestures, middle: panning or autoscroll).
            button.addEventListener('pointermove', (event) => {
                if (!last) return;
                const dx = event.clientX - last.x,
                    dy = event.clientY - last.y,
                    now = performance.now();
                if (!dx && !dy) return;
                move(dx, dy, Math.hypot(dx, dy) / Math.max(1, now - last.time));
                last = { x: event.clientX, y: event.clientY, time: now };
                dragAt(event);
            });
            button.addEventListener('pointerup', release);
            button.addEventListener('pointercancel', release);
            button.addEventListener('lostpointercapture', release);
            button.addEventListener('click', (event) => {
                // Keyboard activation has no pointer: click, or toggle in hold mode.
                if (event.detail !== 0) return;
                if (this.holding) setLatched(button, !latched.has(button));
                else command({ action: 'click', data: { button: button.dataset.button } });
            });
        });
        blockMenu(this);
    }
}
customElements.define('pointer-pad', PointerPad);
