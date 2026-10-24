/**
 * Joystick mode (the Mode menu): the finger's distance from where it touched sets a speed, which lasts while the finger
 * rests, in the direction it points, as a joystick does. A short distance moves slowly and steadily for precision; the
 * speed then grows faster the farther the finger goes. CSS px from the touch → CSS px/ms, the unit of the trackpad's
 * finger speed (mouse speed and acceleration then apply as to a drag).
 */
// As far as a tap may wander (pointer-pad.js): the joystick starts where a tap ends.
export const joystickDeadZone = 10;
const steady = 0.004,
    growth = 0.00004,
    fastest = 3;
export function joystickSpeed(distance) {
    const reach = Math.max(0, distance - joystickDeadZone);
    return Math.min(fastest, steady * reach + growth * reach * reach);
}
