import { createHash } from 'node:crypto';

const allowedActions = new Set([
    'move',
    'click',
    'button',
    'scroll',
    'key',
    'shortcut',
    'release',
    'text',
    'media-state',
    'glide',
    'mirror-read',
    'mirror-edit',
    'mirror-close',
]);

// dongle(): whether the optional USB dongle is turned on in dongle/.env; each status tells the phones, which offer it
// as a fallback when the PC is unreachable. dongleConnected(): whether the PC uses one right now.
export function createTransport({
    authorized,
    hasAccess,
    command,
    available,
    dongle = () => false,
    dongleConnected = () => false,
}) {
    const status = (state) => ({ type: 'status', state, dongle: dongle(), dongleConnected: dongleConnected() });
    const clients = new Set();
    // Several devices may control the PC at once; each releases only the keys and buttons it pressed.
    async function releaseHeld(client) {
        for (const entry of client.held) {
            const [kind, name] = entry.split(':');
            await command(kind, { [kind]: name, down: false }).catch(() => {});
        }
        client.held.clear();
    }
    function trackHeld(client, action, data) {
        if ((action !== 'key' && action !== 'button') || typeof data.down !== 'boolean') return;
        const entry = `${action}:${data[action]}`;
        if (data.down) client.held.add(entry);
        else client.held.delete(entry);
    }
    function handleUpgrade(request, socket) {
        let pathname;
        let sameOrigin = false;
        try {
            pathname = new URL(request.url, 'http://localhost').pathname;
            const origin = new URL(request.headers.origin);
            sameOrigin =
                origin.host === request.headers.host
                && origin.protocol === (request.socket.encrypted ? 'https:' : 'http:');
        } catch {
            return socket.destroy();
        }
        if (
            pathname !== '/socket'
            || !sameOrigin
            || !authorized(request)
            || request.headers.upgrade?.toLowerCase() !== 'websocket'
        )
            return socket.destroy();
        const key = request.headers['sec-websocket-key'];
        if (!key) return socket.destroy();
        const accept = createHash('sha1')
            .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
            .digest('base64');
        socket.write(
            'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '
                + accept
                + '\r\n\r\n'
        );
        const client = {
            accessId: authorized(request).id,
            socket,
            buffer: Buffer.alloc(0),
            chain: Promise.resolve(),
            lastId: 0,
            queued: 0,
            held: new Set(),
            lastPong: Date.now(),
            send(value) {
                if (socket.destroyed) return;
                const payload = Buffer.from(JSON.stringify(value));
                if (socket.writableLength > 2_000_000) return socket.destroy();
                let header;
                if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
                else if (payload.length <= 65_535)
                    header = Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
                else {
                    header = Buffer.alloc(10);
                    header[0] = 0x81;
                    header[1] = 127;
                    header.writeBigUInt64BE(BigInt(payload.length), 2);
                }
                socket.write(Buffer.concat([header, payload]));
            },
        };
        clients.add(client);
        client.send(status(available() ? 'ready' : 'unavailable'));
        const heartbeat = setInterval(() => {
            if (socket.destroyed) return;
            if (Date.now() - client.lastPong > 15_000) return socket.destroy();
            socket.write(Buffer.from([0x89, 0x00]));
        }, 5_000);
        socket.on('data', (data) => {
            client.buffer = Buffer.concat([client.buffer, data]);
            if (client.buffer.length > 2_000_000) return socket.destroy();
            while (client.buffer.length >= 2) {
                const opcode = client.buffer[0] & 15;
                const final = Boolean(client.buffer[0] & 128);
                const second = client.buffer[1];
                const lengthCode = second & 127;
                if (!(second & 128) || !final) return socket.destroy();
                const headerLength =
                    lengthCode === 127 ? 10
                    : lengthCode === 126 ? 4
                    : 2;
                if (client.buffer.length < headerLength + 4) break;
                const length =
                    lengthCode === 127 ? Number(client.buffer.readBigUInt64BE(2))
                    : lengthCode === 126 ? client.buffer.readUInt16BE(2)
                    : lengthCode;
                if (!Number.isSafeInteger(length) || length > 1_100_000) return socket.destroy();
                if (client.buffer.length < headerLength + 4 + length) break;
                const mask = client.buffer.subarray(headerLength, headerLength + 4);
                const payload = Buffer.from(client.buffer.subarray(headerLength + 4, headerLength + 4 + length));
                for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
                client.buffer = client.buffer.subarray(headerLength + 4 + length);
                if (opcode >= 8 && length > 125) return socket.destroy();
                if (opcode === 8) return socket.end(Buffer.from([0x88, 0x00]));
                if (opcode === 9) {
                    socket.write(Buffer.from([0x8a, payload.length, ...payload]));
                    continue;
                }
                if (opcode === 10) {
                    client.lastPong = Date.now();
                    continue;
                }
                if (opcode !== 1) return socket.destroy();
                let message;
                try {
                    message = JSON.parse(payload.toString('utf8'));
                } catch {
                    continue;
                }
                if (++client.queued > 64) return socket.destroy();
                client.chain = client.chain
                    .then(async () => {
                        if (!hasAccess(client.accessId)) return socket.destroy();
                        if (!Number.isSafeInteger(message.id) || message.id <= client.lastId) return;
                        client.lastId = message.id;
                        if (!allowedActions.has(message.action))
                            return client.send({ type: 'ack', id: message.id, ok: false, error: 'Unknown command' });
                        const data = message.data || {};
                        if (message.action === 'release' && clients.size > 1) {
                            await releaseHeld(client);
                            return client.send({ type: 'ack', id: message.id, ok: true });
                        }
                        try {
                            const result = await command(message.action, data);
                            if (result.ok) trackHeld(client, message.action, data);
                            client.send({
                                type: 'ack',
                                id: message.id,
                                ok: result.ok,
                                result: result.result,
                                error: result.error,
                            });
                        } catch (error) {
                            client.send({ type: 'ack', id: message.id, ok: false, error: error.message });
                        }
                    })
                    .catch((error) => console.error(error))
                    .finally(() => {
                        client.queued--;
                    });
            }
        });
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            clearInterval(heartbeat);
            clients.delete(client);
            client.chain = client.chain.then(async () => {
                if (clients.size) return releaseHeld(client);
                await command('release').catch(() => {});
                await command('mirror-close').catch(() => {});
            });
        };
        socket.on('close', release);
        socket.on('error', release);
    }
    return {
        handleUpgrade,
        broadcast(message) {
            for (const client of clients) client.send(message);
        },
        notify(state) {
            for (const client of clients) client.send(status(state));
        },
        revoke(id) {
            for (const client of clients) if (client.accessId === id) client.socket.destroy();
        },
        close() {
            for (const client of clients) client.socket.destroy();
        },
    };
}
