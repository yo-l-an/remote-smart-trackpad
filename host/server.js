import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { randomInt, timingSafeEqual } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync, watch } from 'node:fs';
import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { discoveryHost, startDiscovery } from './discovery.js';
import { openAccessStore } from './access.js';
import { startBridge } from './bridge.js';
import { createTransport } from './transport.js';
import { openCertificates } from './certificates.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.REMOTE_SMART_TRACKPAD_PORT || 8765);
if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('REMOTE_SMART_TRACKPAD_PORT must be a valid TCP port');
const dataDirectory = process.env.REMOTE_SMART_TRACKPAD_DATA_DIRECTORY || path.join(root, '.data');
await mkdir(dataDirectory, { recursive: true });
// The private network always uses HTTPS (the PWA needs a secure context); loopback setup stays on HTTP.
const tls = await openCertificates(dataDirectory);
await tls.ensure([...privateAddresses(), discoveryHost]);
const privateProtocol = 'https';
const tokenFile = path.join(dataDirectory, 'tokens.json');
const access = await openAccessStore(tokenFile);
let pairingCode = String(randomInt(100000, 1000000));
let pairingExpires = Date.now() + 10 * 60_000;
function refreshPairingCode() {
    pairingCode = String(randomInt(100000, 1000000));
    pairingExpires = Date.now() + 10 * 60_000;
    console.log(`Pairing code: ${pairingCode} (10 minutes)`);
}
const pairingAttempts = new Map();
let stopping = false;
// The optional USB dongle (dongle/README.md): offered when dongle/.env sets DONGLE_ENABLED=true, then used unless the
// tray menu turned it off (it writes dongleOffFile and tells this server on stdin). Without it, no search runs.
const dongleOffFile = path.join(dataDirectory, 'dongle-off');
const dongleOffered = /^\s*DONGLE_ENABLED\s*=\s*true\s*$/im.test(
    await readFile(path.join(root, 'dongle', '.env'), 'utf8').catch(() => '')
);
let dongleOn = dongleOffered && !existsSync(dongleOffFile),
    dongleConnected = false;
// Tells the bridge whether to use the dongle; the phones hear when one is plugged in or out. While the dongle is
// offered, this runs every 2 s.
async function applyDongle() {
    if (!dongleOffered) return;
    const answer = await command('dongle', { enabled: dongleOn }).catch((error) => console.error(error.message));
    const connected = answer?.ok === true && answer.result?.connected === true;
    if (connected === dongleConnected) return;
    dongleConnected = connected;
    transport.notify(bridge.available ? 'ready' : 'unavailable');
}
let bridge,
    bridgeStarted = 0,
    bridgeDelay = 1000;
// A crashed Windows bridge is restarted with backoff; phones see "unavailable" until it is back.
function launchBridge() {
    bridgeStarted = Date.now();
    bridge = startBridge(path.join(root, 'host', 'windows', 'windows-bridge.ps1'), (error) => {
        console.error(error.message);
        transport.notify('unavailable');
        if (stopping) return;
        if (Date.now() - bridgeStarted > 30_000) bridgeDelay = 1000;
        setTimeout(() => {
            if (stopping) return;
            launchBridge();
            applyDongle();
            transport.notify('ready');
        }, bridgeDelay);
        bridgeDelay = Math.min(bridgeDelay * 2, 30_000);
    });
}
launchBridge();
// Always the current bridge: a crashed one is replaced (launchBridge).
const command = (action, data) => bridge.command(action, data);

function authorized(request) {
    const token =
        request.headers.authorization?.replace(/^Bearer /, '')
        || new URL(request.url, 'http://localhost').searchParams.get('token');
    return access.find(token);
}
async function readBody(request) {
    request.setEncoding('utf8');
    let body = '';
    for await (const chunk of request) {
        body += chunk;
        if (body.length > 65_536) throw new Error('Request too large');
    }
    return JSON.parse(body || '{}');
}
function json(response, code, value) {
    response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value));
}
const staticFiles = new Map([
    ['/', ['pages/remote/index.html', 'text/html']],
    ['/app.js', ['dist/remote.js', 'text/javascript']],
    ['/style.css', ['dist/remote.css', 'text/css']],
    ['/manifest.webmanifest', ['pwa/manifest.webmanifest', 'application/manifest+json']],
    ['/sw.js', ['pwa/sw.js', 'text/javascript']],
    ['/trust', ['pages/trust/index.html', 'text/html']],
    ['/trust.css', ['pages/trust/trust.css', 'text/css']],
    ['/tokens.css', ['styles/tokens.css', 'text/css']],
    ['/trust.js', ['pages/trust/trust.js', 'text/javascript']],
    ['/setup', ['pages/setup/index.html', 'text/html']],
    ['/icon-192.png', ['assets/icons/icon-192.png', 'image/png']],
    ['/icon-512.png', ['assets/icons/icon-512.png', 'image/png']],
    ['/setup.js', ['pages/setup/setup.js', 'text/javascript']],
    ['/setup.css', ['pages/setup/setup.css', 'text/css']],
    ['/vendor/qrcode.min.js', ['assets/vendor/qrcode.min.js', 'text/javascript']],
]);

// The PC itself: loopback, or one of its own addresses (opening https://<its LAN IP>/setup on the PC arrives from
// that IP). Other devices cannot originate TCP from the PC's addresses, so phones stay out of setup.
const isThisPc = (request) => {
    const address = (request.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (address === '127.0.0.1' || address === '::1') return true;
    return Object.values(networkInterfaces()).some((entries) => entries?.some((entry) => entry.address === address));
};
const listeningAddresses = new Set();
const discoveryStops = new Map();
const discoveryReady = new Set();
const discoveryRetryAt = new Map();
function privateAddresses() {
    const addresses = [];
    for (const entries of Object.values(networkInterfaces()))
        for (const address of entries || []) {
            const value = address.address;
            if (
                address.family === 'IPv4'
                && (/^10\./.test(value) || /^192\.168\./.test(value) || /^172\.(1[6-9]|2\d|3[01])\./.test(value))
            )
                addresses.push(value);
        }
    return [...new Set(addresses)];
}
function privateUrls() {
    return [...listeningAddresses]
        .filter((address) => address !== '127.0.0.1')
        .map((address) => privateProtocol + '://' + address + ':' + port + '/');
}

// The trust page is the one plain-HTTP page on the private network: it hands out the local CA certificate.
function trustUrls() {
    if (!tls.managed) return [];
    const hosts = [...(discoveryReady.size ? [discoveryHost] : []), ...listeningAddresses].filter(
        (address) => address !== '127.0.0.1'
    );
    return hosts.map((host) => 'http://' + host + ':' + port + '/trust');
}

function discoveryUrl() {
    return discoveryReady.size ? privateProtocol + '://' + discoveryHost + ':' + port + '/' : null;
}

const server = http.createServer(async (request, response) => {
    try {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        if (request.method === 'GET' && pathname === '/dev-build.json') {
            const revision = await readFile(path.join(root, 'web', 'dist', 'dev-build.json'), 'utf8').catch((error) => {
                if (error.code === 'ENOENT') return '{"revision":null}';
                throw error;
            });
            return json(response, 200, JSON.parse(revision));
        }
        if (
            pathname === '/setup'
            || pathname === '/setup.js'
            || pathname === '/setup.css'
            || pathname === '/vendor/qrcode.min.js'
            || pathname.startsWith('/api/setup')
        ) {
            if (!isThisPc(request)) return json(response, 403, { error: 'Setup is available on the PC only' });
        }
        if (pathname === '/api/setup/tokens') {
            if (request.method === 'GET') return json(response, 200, access.list());
            if (request.method !== 'DELETE' || request.headers['x-trackpad-local'] !== '1' || request.headers.origin)
                return json(response, 403, { error: 'Use the local token manager' });
            const { id } = await readBody(request);
            await access.remove(id);
            transport.revoke(id);
            return json(response, 200, access.list());
        }
        if (request.method === 'GET' && pathname === '/api/setup') {
            return json(response, 200, {
                app: 'remote-smart-trackpad',
                urls: privateUrls(),
                discoveryUrl: discoveryUrl(),
                trustUrls: trustUrls(),
                pairingCode: Date.now() < pairingExpires ? pairingCode : null,
                pairingExpires,
            });
        }
        if (request.method === 'POST' && pathname === '/api/setup/refresh') {
            refreshPairingCode();
            return json(response, 200, { pairingCode, pairingExpires });
        }
        if (request.method === 'POST' && pathname === '/api/pair') {
            const address = request.socket.remoteAddress || 'unknown';
            const attempts = pairingAttempts.get(address) || { count: 0, until: Date.now() + 60_000 };
            if (Date.now() > attempts.until) {
                attempts.count = 0;
                attempts.until = Date.now() + 60_000;
            }
            if (++attempts.count > 8)
                return json(response, 429, { error: 'Too many attempts. Try again in one minute.' });
            pairingAttempts.set(address, attempts);
            const { code, name } = await readBody(request);
            if (
                Date.now() > pairingExpires
                || !/^[0-9]{6}$/.test(String(code))
                || !timingSafeEqual(Buffer.from(String(code)), Buffer.from(pairingCode))
            )
                return json(response, 403, { error: 'Pairing code expired or incorrect' });
            const token = await access.add(name);
            refreshPairingCode();
            pairingAttempts.delete(address);
            return json(response, 200, { token });
        }
        if (pathname === '/api/status')
            return json(
                response,
                authorized(request) ? 200 : 401,
                authorized(request) ?
                    { state: bridge.available ? 'ready' : 'unavailable', dongle: dongleOffered }
                :   { error: 'Pairing required' }
            );
        if (request.method === 'GET' && pathname === '/remote-smart-trackpad-ca.crt') {
            if (!tls.managed) return json(response, 404, { error: 'This PC uses its own certificate' });
            response.writeHead(200, {
                'Content-Type': 'application/x-x509-ca-cert',
                'Content-Disposition': 'attachment; filename="remote-smart-trackpad-ca.crt"',
                'Cache-Control': 'no-store',
            });
            return response.end(tls.ca);
        }
        if (request.method === 'GET' && /^\/assets\/[a-zA-Z0-9_.-]+\.woff2?$/.test(pathname)) {
            const file = await readFile(path.join(root, 'web', 'dist', pathname));
            response.writeHead(200, {
                'Content-Type': pathname.endsWith('.woff2') ? 'font/woff2' : 'font/woff',
                'Cache-Control': 'public, max-age=86400',
            });
            return response.end(file);
        }
        if (request.method === 'GET' && staticFiles.has(pathname)) {
            const [name, contentType] = staticFiles.get(pathname);
            const file = await readFile(path.join(root, 'web', name));
            response.writeHead(200, {
                'Content-Type': contentType.startsWith('image/') ? contentType : contentType + '; charset=utf-8',
                'Cache-Control': 'no-cache',
                'X-Content-Type-Options': 'nosniff',
                'Content-Security-Policy':
                    "default-src 'self'; connect-src 'self' ws: wss:; style-src 'self'; script-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
            });
            return response.end(file);
        }
        json(response, 404, { error: 'Not found' });
    } catch (error) {
        json(response, 400, { error: error.message });
    }
});

const transport = createTransport({
    authorized,
    hasAccess: (id) => access.list().some((record) => record.id === id),
    command,
    available: () => bridge.available,
    dongle: () => dongleOffered,
    dongleConnected: () => dongleConnected,
});
server.on('upgrade', transport.handleUpgrade);
applyDongle();
const dongleTimer = dongleOffered ? setInterval(applyDongle, 2000) : null;

const listeners = new Map();
function stopDiscovery(address) {
    discoveryReady.delete(address);
    const stop = discoveryStops.get(address);
    discoveryStops.delete(address);
    stop?.();
}
function ensureDiscovery(address) {
    if (address === '127.0.0.1' || discoveryStops.has(address) || Date.now() < (discoveryRetryAt.get(address) || 0))
        return;
    try {
        const stop = startDiscovery(
            address,
            port,
            privateProtocol,
            () => {
                if (listeningAddresses.has(address) && discoveryStops.has(address)) {
                    discoveryReady.add(address);
                    console.log('mDNS: ' + discoveryUrl());
                }
            },
            (error) => {
                console.warn('mDNS unavailable on ' + address + ': ' + error.message);
                discoveryRetryAt.set(address, Date.now() + 60_000);
                stopDiscovery(address);
            }
        );
        discoveryStops.set(address, stop);
    } catch (error) {
        console.warn('mDNS unavailable on ' + address + ': ' + error.message);
        discoveryRetryAt.set(address, Date.now() + 60_000);
    }
}
const handleRequest = server.listeners('request')[0],
    handleUpgrade = server.listeners('upgrade')[0];
const secureServer = https.createServer({ cert: tls.cert, key: tls.key }, handleRequest);
secureServer.on('upgrade', handleUpgrade);
const plainServer = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (
        ['/trust', '/trust.css', '/tokens.css', '/trust.js', '/remote-smart-trackpad-ca.crt', '/icon-192.png'].includes(
            url.pathname
        )
    )
        return handleRequest(request, response);
    response.writeHead(308, { Location: 'https://' + (request.headers.host || '') + request.url });
    response.end();
});
// One port serves both: a TLS handshake starts with byte 0x16, anything else is plain HTTP.
function acceptConnection(socket) {
    socket.setTimeout(10_000, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.once('data', (chunk) => {
        socket.pause();
        socket.setTimeout(0);
        socket.unshift(chunk);
        (chunk[0] === 0x16 ? secureServer : plainServer).emit('connection', socket);
        process.nextTick(() => socket.resume());
    });
}
let certificateUpdate = Promise.resolve();
function updateCertificate(addresses) {
    certificateUpdate = certificateUpdate
        .then(() => tls.ensure([...addresses, discoveryHost]))
        .then((changed) => {
            if (!changed) return;
            secureServer.setSecureContext({ cert: tls.cert, key: tls.key });
            console.log('HTTPS certificate updated for ' + addresses.join(', '));
        })
        .catch((error) => console.error(`Could not update the HTTPS certificate: ${error.message}`));
}
function startListener(address) {
    if (listeners.has(address)) return;
    const listener = address === '127.0.0.1' ? server : net.createServer(acceptConnection);
    listeners.set(address, listener);
    listener.listen(port, address, () => {
        listeningAddresses.add(address);
        ensureDiscovery(address);
        console.log(
            'Open ' + (address === '127.0.0.1' ? 'http' : privateProtocol) + '://' + address + ':' + port + '/'
        );
        if (address === '127.0.0.1' && process.env.REMOTE_SMART_TRACKPAD_OPEN_SETUP === '1') {
            const browser = spawn(
                'powershell.exe',
                ['-NoProfile', '-Command', `Start-Process 'http://127.0.0.1:${port}/setup'`],
                { stdio: 'ignore', windowsHide: true }
            );
            browser.on('error', (error) => console.error(`Could not open setup page: ${error.message}`));
        }
    });
    listener.on('error', (error) => {
        listeners.delete(address);
        listeningAddresses.delete(address);
        stopDiscovery(address);
        console.error(`Cannot listen on ${address}:${port}: ${error.message}`);
        if (address === '127.0.0.1') {
            bridge.stop();
            process.exit(1);
        }
    });
}
function syncListeners() {
    const addresses = privateAddresses();
    const desired = new Set(['127.0.0.1', ...addresses]);
    updateCertificate(addresses);
    for (const address of desired) startListener(address);
    for (const address of listeningAddresses) ensureDiscovery(address);
    for (const [address, listener] of listeners)
        if (!desired.has(address)) {
            listeningAddresses.delete(address);
            listeners.delete(address);
            stopDiscovery(address);
            listener.close();
        }
}
// `npm run watch` rewrites dev-build.json after each build; tell connected phones so they reload right away.
let buildWatcher = null;
try {
    buildWatcher = watch(path.join(root, 'web', 'dist'), (event, name) => {
        if (name === 'dev-build.json') transport.broadcast({ type: 'build' });
    });
    buildWatcher.on('error', () => buildWatcher.close());
} catch {}
syncListeners();
const listenerTimer = setInterval(syncListeners, 10_000);
console.log(`Pairing code: ${pairingCode} (10 minutes)`);
async function shutdown() {
    if (stopping) return;
    stopping = true;
    clearInterval(listenerTimer);
    clearInterval(dongleTimer);
    buildWatcher?.close();
    transport.close();
    for (const stop of discoveryStops.values()) stop();
    for (const listener of listeners.values()) listener.close();
    await command('release').catch(() => {});
    await command('mirror-close').catch(() => {});
    bridge.stop();
    process.exit(0);
}
createInterface({ input: process.stdin }).on('line', (line) => {
    if (line === 'shutdown') shutdown();
    if (line === 'dongle on' || line === 'dongle off') {
        dongleOn = line === 'dongle on';
        applyDongle();
    }
});
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
