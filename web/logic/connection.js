const tokenKey = 'remote-smart-trackpad-token';

export function createConnection(changed) {
    let token = localStorage.getItem(tokenKey),
        socket,
        generation = 0,
        nextId = 0,
        delay = 500,
        active = false;
    const pending = new Map();
    function failPending() {
        for (const request of pending.values()) {
            clearTimeout(request.timeout);
            request.reject(new Error('PC disconnected'));
        }
        pending.clear();
    }
    async function connect() {
        const current = ++generation;
        active = false;
        socket?.close();
        failPending();
        if (!token) return changed({ state: 'pairing' });
        changed({ state: 'connecting' });
        try {
            const response = await fetch('/api/status', { headers: { Authorization: `Bearer ${token}` } });
            if (current !== generation) return;
            if (response.status === 401) {
                localStorage.removeItem(tokenKey);
                token = null;
                return connect();
            }
            socket = new WebSocket(
                `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/socket?token=${encodeURIComponent(token)}`
            );
            socket.onmessage = (event) => {
                if (current !== generation) return;
                const message = JSON.parse(event.data);
                if (message.type === 'build') return void document.dispatchEvent(new CustomEvent('dev-build'));
                if (message.type === 'status') {
                    active = message.state === 'ready';
                    if (active) delay = 500;
                    changed({ state: message.state, dongle: message.dongle, dongleConnected: message.dongleConnected });
                    // The PC restarts its Windows bridge on its own; reconnecting picks up its state if a push was missed.
                    if (message.state === 'unavailable') retry(current);
                    return;
                }
                const request = pending.get(message.id);
                if (!request) return;
                pending.delete(message.id);
                clearTimeout(request.timeout);
                if (message.ok) request.resolve(message.result);
                else request.reject(new Error(message.error || 'Command rejected'));
            };
            socket.onclose = () => {
                if (current !== generation) return;
                active = false;
                failPending();
                changed({ state: 'disconnected' });
                retry(current);
            };
        } catch {
            if (current === generation) {
                changed({ state: 'disconnected' });
                retry(current);
            }
        }
    }
    function retry(current) {
        setTimeout(() => {
            if (current === generation) connect();
        }, delay);
        delay = Math.min(delay * 1.7, 5000);
    }
    return {
        connect,
        /** Reconnects immediately, e.g. when the page becomes visible again. */
        wake() {
            if (active || !token) return;
            delay = 500;
            connect();
        },
        async pair(name, code) {
            const response = await fetch('/api/pair', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, code }),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error);
            token = result.token;
            localStorage.setItem(tokenKey, token);
            connect();
        },
        send(action, data = {}) {
            if (!active || socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('PC unavailable'));
            const id = ++nextId;
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error('PC did not confirm the command'));
                }, 35000);
                pending.set(id, { resolve, reject, timeout });
                socket.send(JSON.stringify({ id, action, data }));
            });
        },
    };
}
