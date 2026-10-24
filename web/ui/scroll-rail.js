import { tick } from './haptics.js';
import { createJoystick } from './joystick.js';

export class ScrollRail extends HTMLElement {
    #sliding = true;
    /** A double tap (no drag) on either half of the rail scrolls one step that way (scroll-step event). */
    tapStep = false;
    #viewport = null;
    get sliding() {
        return this.#sliding;
    }
    /**
     * True scrolls natively, with the browser's fling after the finger lifts. False follows the finger directly,
     * like the trackpad without sliding: no native scrolling, so no momentum the browser could keep running.
     */
    set sliding(value) {
        this.#sliding = value;
        this.#touch();
    }
    #joystick = false;
    /**
     * Joystick mode (see joystick.js): the finger's distance from where it touched the rail sets the scroll's speed,
     * as long as it rests there. The rail follows it directly then, as without sliding.
     */
    set joystick(value) {
        if (!value) this.stick?.end();
        this.#joystick = value;
        this.#touch();
    }
    #touch() {
        if (this.#viewport) this.#viewport.style.touchAction = this.#sliding && !this.#joystick ? '' : 'none';
    }
    connectedCallback() {
        if (this.firstChild) return;
        const horizontal = this.getAttribute('axis') === 'x';
        this.innerHTML = '<div class="rail-viewport" tabindex="0"><div class="rail-content"></div></div>';
        const viewport = (this.#viewport = this.firstElementChild);
        this.#touch();
        viewport.setAttribute('aria-label', horizontal ? 'Horizontal scroll' : 'Vertical scroll');
        const property = horizontal ? 'scrollLeft' : 'scrollTop';
        // The rest position is the middle of the scroll range, which follows the interface scale (rem-sized content).
        const center = () => {
            const size =
                horizontal ?
                    viewport.scrollWidth - viewport.clientWidth
                :   viewport.scrollHeight - viewport.clientHeight;
            return Math.max(0, Math.round(size / 2));
        };
        let previous = 0,
            resetting = false,
            flinging = false,
            idle,
            drag = null;
        // speed: smoothed scroll velocity in CSS px/ms, like the trackpad's finger speed, for scroll acceleration.
        let speed = 0,
            lastEmit = 0;
        // Scroll haptics: a very light tick each time a tick mark reaches the middle of the rail. At rest (center) a
        // mark sits there, so marks pass it at every whole period from the center; recentering jumps by whole periods
        // and re-bases the count instead of ticking. Capped so fast scrolling never turns into a buzz: at most one
        // tick per tickGap ms, and none at all above tickMaxSpeed.
        const tickGap = 20,
            tickMaxSpeed = 20; // CSS px/ms
        const mark = () => Math.floor((viewport[property] - center()) / ticks().period);
        let lastMark = null,
            lastTick = 0;
        const feel = () => {
            const current = mark(),
                now = performance.now();
            if (lastMark !== null && current !== lastMark && speed <= tickMaxSpeed && now - lastTick > tickGap) {
                lastTick = now;
                // Once this scroll event is done: a vibration the phone is slow to start must not hold the scroll.
                setTimeout(() => tick('scroll'));
            }
            lastMark = current;
        };
        const emit = (delta) => {
            const now = performance.now(),
                elapsed = now - lastEmit;
            const blend = elapsed > 100 ? 1 : 0.5;
            speed = speed * (1 - blend) + (Math.abs(delta) / Math.max(1, elapsed)) * blend;
            lastEmit = now;
            // The scroll goes first, the haptic tick after it.
            this.dispatchEvent(
                new CustomEvent('motion', {
                    bubbles: true,
                    detail: { action: 'scroll', dx: horizontal ? delta : 0, dy: horizontal ? 0 : delta, speed },
                })
            );
            feel();
        };
        // Ticks repeat every 1.875rem with the tick itself at 1.8125–1.875rem (see .rail-content in style.css).
        const ticks = () => {
            const unit = parseFloat(getComputedStyle(document.documentElement).fontSize);
            return { period: 1.875 * unit, tick: 1.84375 * unit };
        };
        const content = viewport.firstElementChild;
        // At rest (scrolled to `center`) a tick sits in the middle of the rail, whatever its size. offset: where the
        // ticks start in the content.
        let offset = 0;
        const align = () => {
            const { period, tick } = ticks();
            const size = horizontal ? viewport.clientWidth : viewport.clientHeight;
            // Whole pixels: a 1px tick on a half pixel blurs away.
            offset = Math.round((((center() + size / 2 - tick) % period) + period) % period);
            content.style.backgroundPosition = horizontal ? `${offset}px 0` : `0 ${offset}px`;
        };
        /** Where the ticks stand from the rail's start edge (top or left), within one period. */
        const phase = () => {
            const { period } = ticks();
            return (((offset - viewport[property]) % period) + period) % period;
        };
        const recenter = () => {
            // Jump back by whole tick periods only, so the visible ticks do not shift when the rail recenters.
            const { period } = ticks();
            resetting = true;
            viewport[property] = center() + ((((previous - center()) % period) + period) % period);
            previous = viewport[property];
            lastMark = mark();
            requestAnimationFrame(() => {
                resetting = false;
            });
        };
        /**
         * Shows one step (a double tap's scroll): the ticks glide by one period, by code with `previous` in step so
         * no scroll is sent for it. direction: 1 as if the rail were scrolled down/right, -1 up/left.
         */
        this.nudge = (direction) => {
            const from = viewport[property],
                distance = direction * ticks().period,
                started = performance.now();
            const frame = (now) => {
                const progress = Math.min(1, (now - started) / 180);
                viewport[property] = from + distance * (1 - (1 - progress) ** 3);
                previous = viewport[property];
                lastMark = mark();
                if (progress < 1) requestAnimationFrame(frame);
                else recenterLater();
            };
            requestAnimationFrame(frame);
        };
        const recenterLater = () => {
            clearTimeout(idle);
            // Recenter only after native momentum stops; moving during a fling cancels it on iOS.
            idle = setTimeout(() => {
                if (Math.abs(previous - center()) > 16384) recenter();
            }, 250);
        };
        // Exactly to the rest position: the first layout puts a tick in the middle.
        let placed = false;
        const reset = () => {
            previous = center();
            recenter();
            placed = true;
        };
        requestAnimationFrame(reset);
        /** Back near the middle of the scroll range with the ticks `standing` from the rail's start edge. */
        const keep = (standing) => {
            const { period } = ticks();
            previous = center() + ((((offset - standing - center()) % period) + period) % period);
            recenter();
        };
        // A resize (the editor opening, the keyboard, the interface scale) happens at rest: the ticks stay where they
        // are from the rail's middle instead of jumping back to the rest position. A layout transition resizes it at
        // every frame: `held` keeps the exact place from the middle while nothing scrolls, so the whole pixels each
        // frame rounds to do not add up.
        let held = null;
        this.observer = new ResizeObserver(() => {
            const size = horizontal ? viewport.clientWidth : viewport.clientHeight;
            const fromMiddle =
                held?.at === viewport[property] ? held.fromMiddle
                : placed && held ? phase() - held.size / 2
                : null;
            align();
            if (!viewport.clientWidth || !viewport.clientHeight || drag) return (held = null);
            if (fromMiddle === null) reset();
            else keep(fromMiddle + size / 2);
            held = { size, at: viewport[property], fromMiddle: fromMiddle ?? phase() - size / 2 };
        });
        this.observer.observe(viewport);

        // Moved by code with `previous` in step, so the scroll listener does not emit it a second time.
        const scrollBy = (delta) => {
            viewport[property] += delta;
            previous = viewport[property];
            emit(delta);
            recenterLater();
        };
        // Joystick mode: one axis, the offset as a drag would scroll it.
        const stick = (this.stick = createJoystick({ step: (delta) => scrollBy(delta) }));
        // Direct mode (sliding off, or joystick): the finger's movement is the scroll, and lifting it ends everything
        // at once.
        viewport.addEventListener('pointerdown', (event) => {
            if ((this.#sliding && !this.#joystick) || event.pointerType === 'mouse' || drag) return;
            const position = horizontal ? event.clientX : event.clientY;
            drag = { id: event.pointerId, position, start: position };
            viewport.setPointerCapture(event.pointerId);
        });
        viewport.addEventListener('pointermove', (event) => {
            if (event.pointerId !== drag?.id) return;
            const position = horizontal ? event.clientX : event.clientY;
            if (this.#joystick) return stick.update(drag.start - position, 0);
            const delta = drag.position - position;
            drag.position = position;
            if (delta) scrollBy(delta);
        });
        const endDrag = (event) => {
            if (event.pointerId !== drag?.id) return;
            drag = null;
            stick.end();
            this.dispatchEvent(new CustomEvent('motion-release', { bubbles: true, detail: { action: 'scroll' } }));
        };
        viewport.addEventListener('pointerup', endDrag);
        viewport.addEventListener('pointercancel', endDrag);
        viewport.addEventListener('lostpointercapture', endDrag);

        // Double tap to scroll once: two short touches that do not move, close together on the rail's first or second
        // half, ask for one step up/left or down/right (a single touch never scrolls: resting a finger on the rail is
        // harmless). A drag never counts: the browser cancels the pointer once it scrolls.
        const doubleTapWindow = 350,
            doubleTapDistance = 32;
        let tap = null,
            firstTap = null;
        viewport.addEventListener('pointerdown', (event) => {
            tap =
                this.tapStep && event.isPrimary ?
                    { id: event.pointerId, x: event.clientX, y: event.clientY, at: performance.now() }
                :   null;
        });
        viewport.addEventListener('pointercancel', () => (tap = null));
        viewport.addEventListener('pointerup', (event) => {
            if (event.pointerId !== tap?.id) return;
            const { x, y, at } = tap;
            tap = null;
            const now = performance.now();
            if (Math.hypot(event.clientX - x, event.clientY - y) > 6 || now - at > 300) return (firstTap = null);
            const box = viewport.getBoundingClientRect();
            const step =
                (
                    horizontal ? event.clientX > box.left + box.width / 2 : event.clientY > box.top + box.height / 2
                ) ?
                    1
                :   -1;
            const second =
                firstTap
                && now - firstTap.at < doubleTapWindow
                && firstTap.step === step
                && Math.hypot(x - firstTap.x, y - firstTap.y) < doubleTapDistance;
            firstTap = second ? null : { x, y, at: now, step };
            if (!second) return;
            tick('scroll');
            this.dispatchEvent(
                new CustomEvent('scroll-step', {
                    bubbles: true,
                    detail: horizontal ? { dx: step, dy: 0 } : { dx: 0, dy: step },
                })
            );
        });

        // Native mode (sliding on, mouse wheel, keyboard): scroll events carry the movement, fling included.
        // Touch feedback: the ticks brighten while a finger is on the rail (touch events last through native
        // panning, unlike the pointer, which the browser cancels once it scrolls).
        // A glide (the fling after the finger lifts) ends with one last tick, like a wheel settling; a drag released
        // without momentum has no glide, so no tick.
        let glided = 0;
        // A finger landing on the rail's very edge gets the touch events (the ticks brighten) but no native scroll:
        // the browser's own scroll area is a pixel smaller (rounding, the fade mask). When the finger has moved along
        // the rail without a scroll starting, the rail follows it by hand until it lifts.
        const byHand = 10;
        let finger = null;
        const along = (touch) => (horizontal ? touch.clientX : touch.clientY);
        viewport.addEventListener(
            'touchstart',
            (event) => {
                flinging = false;
                glided = 0;
                this.classList.add('is-touched');
                finger = this.#sliding ? { start: along(event.touches[0]), last: null, native: false } : null;
            },
            { passive: true }
        );
        viewport.addEventListener(
            'touchmove',
            (event) => {
                if (!finger || finger.native) return;
                // While the browser scrolls, its touch moves can no longer be cancelled: then it is scrolling itself.
                if (!event.cancelable && finger.last === null) return void (finger.native = true);
                const position = along(event.touches[0]);
                if (finger.last === null && Math.abs(position - finger.start) < byHand) return;
                // Moved by code: the scroll listener emits it like a native scroll.
                viewport[property] += (finger.last ?? finger.start) - position;
                finger.last = position;
            },
            { passive: true }
        );
        const untouch = () => this.classList.remove('is-touched');
        viewport.addEventListener(
            'touchend',
            (event) => {
                // No fling after a scroll by hand.
                flinging = finger?.last === null || finger?.native === true;
                finger = null;
                if (!event.touches.length) untouch();
            },
            { passive: true }
        );
        viewport.addEventListener('touchcancel', untouch, { passive: true });
        viewport.addEventListener('wheel', () => (flinging = false), { passive: true });
        viewport.addEventListener(
            'scroll',
            () => {
                // The browser scrolls this touch itself: no scrolling by hand.
                if (finger && finger.last === null) finger.native = true;
                const position = viewport[property],
                    delta = position - previous;
                previous = position;
                if (delta && !resetting && (this.#sliding || !flinging)) emit(delta);
                if (flinging && this.#sliding && !resetting) glided += Math.abs(delta);
                recenterLater();
            },
            { passive: true }
        );
        viewport.addEventListener('scrollend', () => {
            if (glided > 8) tick('scroll');
            glided = 0;
            flinging = false;
            if (Math.abs(previous - center()) > 16384) recenter();
        });
    }
    disconnectedCallback() {
        this.observer?.disconnect();
    }
}
customElements.define('scroll-rail', ScrollRail);
