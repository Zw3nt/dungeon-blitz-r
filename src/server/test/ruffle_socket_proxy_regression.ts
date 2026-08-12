import { strict as assert } from 'assert';
import * as http from 'http';
import * as net from 'net';
import * as argon2 from 'argon2';
import express from 'express';
import WebSocket from 'ws';
import { registerWebAccessGate } from '../integrations/WebAccessGate';
import { RuffleSocketProxy } from '../network/RuffleSocketProxy';

async function listenHttp(server: http.Server): Promise<number> {
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return address.port;
}

async function listenTcp(server: net.Server): Promise<number> {
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return address.port;
}

async function getFreePort(): Promise<number> {
    const server = net.createServer();
    const port = await listenTcp(server);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
}

async function waitForWebSocket(url: string, cookie: string): Promise<WebSocket> {
    return await new Promise<WebSocket>((resolve, reject) => {
        const webSocket = new WebSocket(url, { headers: { Cookie: cookie } });
        webSocket.once('open', () => resolve(webSocket));
        webSocket.once('error', reject);
    });
}

async function main(): Promise<void> {
    const previousHash = process.env.SITE_PASSWORD_HASH;
    const previousSecret = process.env.WEB_ACCESS_SESSION_SECRET;
    process.env.SITE_PASSWORD_HASH = await argon2.hash('bridge-password', { type: argon2.argon2id });
    process.env.WEB_ACCESS_SESSION_SECRET = 'bridge-session-secret-that-is-long-enough';

    const tcpServer = net.createServer((socket) => socket.pipe(socket));
    const targetPort = await listenTcp(tcpServer);

    const accessApp = express();
    accessApp.use(express.urlencoded({ extended: false }));
    registerWebAccessGate(accessApp);
    const accessServer = http.createServer(accessApp);
    const accessPort = await listenHttp(accessServer);

    const proxyPort = await getFreePort();
    const proxy = new RuffleSocketProxy(proxyPort, '127.0.0.1', targetPort, '127.0.0.1');
    proxy.start();

    try {
        const login = await fetch(`http://127.0.0.1:${accessPort}/site-login`, {
            method: 'POST',
            redirect: 'manual',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ password: 'bridge-password', next: '/' })
        });
        const cookie = (login.headers.get('set-cookie') ?? '').split(';', 1)[0];
        assert.match(cookie, /^dbr_access=/);

        await assert.rejects(
            waitForWebSocket(`ws://127.0.0.1:${proxyPort}/game-socket`, ''),
            /401|Unexpected server response/
        );

        const webSocket = await waitForWebSocket(
            `ws://127.0.0.1:${proxyPort}/game-socket`,
            cookie
        );
        const payload = Buffer.from([0x00, 0x01, 0x02, 0x7f, 0x80, 0xfe, 0xff]);
        const echoed = await new Promise<Buffer>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Timed out waiting for bridged bytes.')), 3000);
            webSocket.once('message', (data) => {
                clearTimeout(timer);
                resolve(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
            });
            webSocket.send(payload);
        });
        assert.deepEqual(echoed, payload);
        webSocket.close();

        console.log('ruffle_socket_proxy_regression: ok');
    } finally {
        await proxy.stop();
        await new Promise<void>((resolve) => accessServer.close(() => resolve()));
        await new Promise<void>((resolve) => tcpServer.close(() => resolve()));
        if (previousHash === undefined) delete process.env.SITE_PASSWORD_HASH;
        else process.env.SITE_PASSWORD_HASH = previousHash;
        if (previousSecret === undefined) delete process.env.WEB_ACCESS_SESSION_SECRET;
        else process.env.WEB_ACCESS_SESSION_SECRET = previousSecret;
    }
}

void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
