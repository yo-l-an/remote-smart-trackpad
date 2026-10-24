import { tick } from './haptics.js';
import { joystickSpeed } from '../logic/joystick.js';

// The PC stops a glide it has not heard about for 300 ms; renew it while it lasts.
const renewal = 100;

/**
 * A joystick on a finger (logic/joystick.js): update(offsetX, offsetY) with the finger's offset from where it touched,
 * end() when it lifts. For the pointer, glide(vx, vy, speed) hands the velocity (CSS px/ms) to the PC, which moves
 * the pointer on its own timer as for edge motion; for a scroll, step(dx, dy, speed) is called each frame with the
 * distance to send. animate(dx, dy): the phone's own feedback each frame.
 */
export function createJoystick({ glide, step, animate }) {
    let velocity = { x: 0, y: 0, speed: 0 },
        sent = null,
        renewTimer = 0,
        frame = 0,
        last = 0;
    function send() {
        sent = { ...velocity };
        glide(velocity.x, velocity.y, velocity.speed);
    }
    function frameStep(now) {
        const elapsed = Math.min(50, now - last);
        last = now;
        if (!velocity.speed) {
            frame = 0;
            return;
        }
        const dx = velocity.x * elapsed,
            dy = velocity.y * elapsed;
        animate?.(dx, dy);
        step?.(dx, dy, velocity.speed);
        frame = requestAnimationFrame(frameStep);
    }
    // stopping: the finger lifted, which ends the motion with no tick.
    function set(next, stopping = false) {
        // A tick when the finger brings the joystick back to rest (its dead zone) after moving: the motion stopped
        // while the finger still holds; moving again needs none.
        if (!next.speed && velocity.speed > 0 && !stopping) tick();
        velocity = next;
        const moving = velocity.speed > 0;
        if (glide) {
            // Sent on a real change only; the renewal timer keeps an unchanged glide alive.
            const changed =
                !sent
                || Math.abs(sent.x - velocity.x) > 0.01
                || Math.abs(sent.y - velocity.y) > 0.01
                || moving !== sent.speed > 0;
            if (changed) send();
            if (moving && !renewTimer) renewTimer = setInterval(send, renewal);
            if (!moving && renewTimer) {
                clearInterval(renewTimer);
                renewTimer = 0;
            }
        }
        if (moving && !frame) {
            last = performance.now();
            frame = requestAnimationFrame(frameStep);
        }
    }
    return {
        update(offsetX, offsetY) {
            const distance = Math.hypot(offsetX, offsetY),
                speed = joystickSpeed(distance);
            set(
                speed ?
                    { x: (offsetX / distance) * speed, y: (offsetY / distance) * speed, speed }
                :   { x: 0, y: 0, speed: 0 }
            );
        },
        end() {
            if (velocity.speed || sent?.speed) set({ x: 0, y: 0, speed: 0 }, true);
            cancelAnimationFrame(frame);
            frame = 0;
            sent = null;
        },
    };
}
