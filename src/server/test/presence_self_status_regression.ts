import './helpers/disable_production_mongo';
import { strict as assert } from 'assert';
import { StaticServer } from '../core/StaticServer';

async function waitForListening(staticServer: StaticServer): Promise<number> {
    const httpServer = (staticServer as any).server;
    assert.ok(httpServer, 'static server should expose an http server after start');
    if (httpServer.listening) {
        const address = httpServer.address();
        assert.equal(typeof address, 'object', 'test server should listen on an address object');
        return Number(address.port);
    }

    return await new Promise<number>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.once('listening', () => {
            const address = httpServer.address();
            assert.equal(typeof address, 'object', 'test server should listen on an address object');
            resolve(Number(address.port));
        });
    });
}

async function main(): Promise<void> {
    const staticServer = new StaticServer(0);
    staticServer.start();

    try {
        const port = await waitForListening(staticServer);
        const baseUrl = `http://127.0.0.1:${port}`;

        // With no active world sessions (the common case: no one is playing, or a browser is
        // still on the login/character-select screen), this must not read as a failed request --
        // it used to 404, which spammed devtools every 4s from the optional Discord presence
        // poll even when nobody has the local bridge running at all.
        const response = await fetch(`${baseUrl}/api/presence/self`);
        assert.equal(response.status, 200, 'no active session should not surface as an HTTP error');
        const payload = await response.json();
        assert.equal(payload.reason, 'no-sessions', 'a fresh server has no sessions to report');
        assert.equal(payload.session, null, 'no active session should mean no snapshot');

        console.log('presence_self_status_regression: ok');
    } finally {
        await staticServer.stop();
    }
}

void main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
