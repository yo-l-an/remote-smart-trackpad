import test from 'node:test';
import assert from 'node:assert/strict';
import { joystickDeadZone, joystickSpeed } from '../../web/logic/joystick.js';

test('joystick speed: still within a tap, steady at first, then faster the farther the finger goes', () => {
    assert.equal(joystickSpeed(0), 0);
    assert.equal(joystickSpeed(joystickDeadZone), 0);
    // Past the dead zone it starts from 0, so the pointer never jumps.
    assert.ok(joystickSpeed(joystickDeadZone + 1) < 0.01);
    const speeds = [20, 40, 80, 160].map((reach) => joystickSpeed(joystickDeadZone + reach));
    for (let index = 1; index < speeds.length; index++) assert.ok(speeds[index] > speeds[index - 1]);
    // The speed grows faster than the distance: twice as far is more than twice as fast.
    assert.ok(joystickSpeed(joystickDeadZone + 160) > 2 * joystickSpeed(joystickDeadZone + 80));
    // A cap keeps a finger at the edge of the screen usable.
    assert.equal(joystickSpeed(5000), 3);
});
