import { strict as assert } from 'assert';
import * as http from 'http';
import * as argon2 from 'argon2';
import express from 'express';
import { registerWebAccessGate } from '../integrations/WebAccessGate';

async function listen(server: http.Server): Promise<number> {
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return address.port;
}

async function main(): Promise<void> {
    const previousHash = process.env.SITE_PASSWORD_HASH;
    const previousSecret = process.env.WEB_ACCESS_SESSION_SECRET;
    process.env.SITE_PASSWORD_HASH = await argon2.hash('test-gate-password', { type: argon2.argon2id });
    process.env.WEB_ACCESS_SESSION_SECRET = 'test-session-secret-that-is-long-enough';

    const app = express();
    app.use(express.urlencoded({ extended: false }));
    registerWebAccessGate(app);
    app.get('/protected', (_req, res) => res.send('protected-ok'));
    const server = http.createServer(app);

    try {
        const port = await listen(server);
        const baseUrl = `http://127.0.0.1:${port}`;

        const redirect = await fetch(`${baseUrl}/protected`, { redirect: 'manual' });
        assert.equal(redirect.status, 302);
        assert.match(redirect.headers.get('location') ?? '', /^\/access\?next=/);

        const page = await fetch(`${baseUrl}/access`);
        const html = await page.text();
        assert.equal(page.status, 200);
        assert.match(html, /name="password"/);
        assert.doesNotMatch(html, /name="username"/);
        assert.doesNotMatch(html, /test-gate-password/);
        assert.match(html, /action="\/site-login"/);

        const wrong = await fetch(`${baseUrl}/site-login`, {
            method: 'POST',
            redirect: 'manual',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ password: 'wrong', next: '/protected' })
        });
        assert.equal(wrong.status, 401);

        const correct = await fetch(`${baseUrl}/site-login`, {
            method: 'POST',
            redirect: 'manual',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ password: 'test-gate-password', next: '/protected' })
        });
        assert.equal(correct.status, 303);
        assert.equal(correct.headers.get('location'), '/protected');
        const cookie = correct.headers.get('set-cookie') ?? '';
        assert.match(cookie, /dbr_access=/);
        assert.match(cookie, /HttpOnly/i);
        assert.match(cookie, /Secure/i);
        assert.match(cookie, /SameSite=Lax/i);

        const authorized = await fetch(`${baseUrl}/protected`, {
            headers: { Cookie: cookie.split(';', 1)[0] }
        });
        assert.equal(authorized.status, 200);
        assert.equal(await authorized.text(), 'protected-ok');

        console.log('web_access_gate_regression: ok');
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
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
