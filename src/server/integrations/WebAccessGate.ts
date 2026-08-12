import * as crypto from 'crypto';
import * as argon2 from 'argon2';
import type { Application, Request, Response } from 'express';

const COOKIE_NAME = 'dbr_access';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

type AttemptState = {
    count: number;
    resetAt: number;
};

const attempts = new Map<string, AttemptState>();

function readConfig(): { enabled: boolean; passwordHash: string; secret: string } {
    const passwordHash = String(process.env.SITE_PASSWORD_HASH ?? '');
    const secret = String(process.env.WEB_ACCESS_SESSION_SECRET ?? '');
    return {
        enabled: Boolean(passwordHash && secret),
        passwordHash,
        secret
    };
}

function safeEqual(left: string, right: string): boolean {
    const leftDigest = crypto.createHash('sha256').update(left).digest();
    const rightDigest = crypto.createHash('sha256').update(right).digest();
    return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function signExpiry(expiry: number, secret: string): string {
    return crypto
        .createHmac('sha256', secret)
        .update(`v1.${expiry}`)
        .digest('base64url');
}

function createSessionToken(secret: string): string {
    const expiry = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
    return `${expiry}.${signExpiry(expiry, secret)}`;
}

function parseCookies(cookieHeader: string | undefined): Map<string, string> {
    const cookies = new Map<string, string>();
    for (const entry of String(cookieHeader ?? '').split(';')) {
        const separator = entry.indexOf('=');
        if (separator <= 0) {
            continue;
        }
        const key = entry.slice(0, separator).trim();
        const value = entry.slice(separator + 1).trim();
        if (key) {
            cookies.set(key, value);
        }
    }
    return cookies;
}

export function isWebAccessAuthorized(cookieHeader: string | undefined): boolean {
    const config = readConfig();
    if (!config.enabled) {
        return true;
    }

    const token = parseCookies(cookieHeader).get(COOKIE_NAME) ?? '';
    const separator = token.indexOf('.');
    if (separator <= 0) {
        return false;
    }

    const expiryRaw = token.slice(0, separator);
    const signature = token.slice(separator + 1);
    const expiry = Number.parseInt(expiryRaw, 10);
    if (!Number.isSafeInteger(expiry) || expiry <= Math.floor(Date.now() / 1000)) {
        return false;
    }

    return safeEqual(signature, signExpiry(expiry, config.secret));
}

function resolveNext(raw: unknown): string {
    const candidate = String(raw ?? '').trim();
    if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.startsWith('/access')) {
        return '/';
    }
    return candidate;
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function renderAccessPage(next: string, errorMessage: string = ''): string {
    const safeNext = escapeHtml(next);
    const error = errorMessage
        ? `<p class="error" id="access-error" role="alert">${escapeHtml(errorMessage)}</p>`
        : '<p class="error" id="access-error" aria-live="polite"></p>';

    return `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Dungeon Blitz — Özel Sunucu</title>
  <style>
    :root {
      --bg: #111319;
      --surface: #1b1f28;
      --surface-raised: #222733;
      --text: #f5f2e9;
      --muted: #aaa89f;
      --border: #373c47;
      --accent: #d7ad58;
      --accent-hover: #e5bf70;
      --danger: #ff9c91;
      --ring: #f4cf83;
      --radius: 10px;
    }

    * { box-sizing: border-box; }

    html, body {
      min-height: 100%;
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    body {
      min-height: 100dvh;
      display: grid;
      place-items: center;
      padding: 24px;
    }

    main {
      width: min(100%, 400px);
      padding: 28px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: 0 18px 48px rgba(0, 0, 0, .28);
    }

    .eyebrow {
      margin: 0 0 12px;
      color: var(--accent);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: .14em;
      text-transform: uppercase;
    }

    h1 {
      margin: 0;
      font-family: Georgia, "Times New Roman", serif;
      font-size: clamp(32px, 9vw, 46px);
      line-height: 1;
      letter-spacing: -.025em;
    }

    .intro {
      margin: 16px 0 28px;
      color: var(--muted);
      font-size: 16px;
      line-height: 1.6;
    }

    form {
      display: grid;
      gap: 12px;
    }

    label {
      font-size: 14px;
      font-weight: 650;
    }

    .password-row {
      position: relative;
    }

    input {
      width: 100%;
      min-height: 48px;
      padding: 0 74px 0 14px;
      border: 1px solid var(--border);
      border-radius: 8px;
      outline: none;
      background: var(--surface-raised);
      color: var(--text);
      font: inherit;
    }

    input:focus-visible {
      border-color: var(--ring);
      box-shadow: 0 0 0 3px rgba(244, 207, 131, .2);
    }

    .toggle {
      position: absolute;
      top: 4px;
      right: 4px;
      min-height: 40px;
      padding: 0 10px;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: var(--muted);
      font: inherit;
      font-size: 13px;
      cursor: pointer;
    }

    .toggle:hover { color: var(--text); }
    .toggle:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }

    .submit {
      min-height: 48px;
      margin-top: 4px;
      border: 0;
      border-radius: 8px;
      background: var(--accent);
      color: #211a0d;
      font: inherit;
      font-weight: 750;
      cursor: pointer;
      transition: background-color 160ms ease, transform 160ms ease;
    }

    .submit:hover { background: var(--accent-hover); }
    .submit:active { transform: translateY(1px); }
    .submit:focus-visible { outline: 3px solid var(--ring); outline-offset: 3px; }
    .submit:disabled { cursor: wait; opacity: .65; }

    .error {
      min-height: 20px;
      margin: 0;
      color: var(--danger);
      font-size: 14px;
      line-height: 1.4;
    }

    .privacy {
      margin: 14px 2px 0;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.5;
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; }
    }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">Private Server</p>
    <h1>DUNGEON BLITZ</h1>
    <p class="intro">Enter the server password to continue.</p>
    <form method="post" action="/site-login" id="access-form">
      <input type="hidden" name="next" value="${safeNext}">
      <label for="password">Server password</label>
      <div class="password-row">
        <input id="password" name="password" type="password" placeholder="Server password" autocomplete="current-password" required autofocus>
        <button class="toggle" type="button" aria-controls="password" aria-pressed="false">Show</button>
      </div>
      ${error}
      <button class="submit" type="submit">Enter Server</button>
    </form>
    <p class="privacy">No username required. Authentication is handled by the server.</p>
  </main>
  <script>
    const input = document.getElementById("password");
    const toggle = document.querySelector(".toggle");
    const form = document.getElementById("access-form");
    toggle.addEventListener("click", () => {
      const visible = input.type === "text";
      input.type = visible ? "password" : "text";
      toggle.textContent = visible ? "Show" : "Hide";
      toggle.setAttribute("aria-pressed", String(!visible));
      input.focus();
    });
    form.addEventListener("submit", () => {
      const button = form.querySelector(".submit");
      button.disabled = true;
      button.textContent = "Checking…";
    });
  </script>
</body>
</html>`;
}

function rateLimitKey(req: Request): string {
    return String(req.socket.remoteAddress ?? 'unknown');
}

function consumeAttempt(req: Request): boolean {
    const now = Date.now();
    const key = rateLimitKey(req);
    const current = attempts.get(key);
    if (!current || current.resetAt <= now) {
        attempts.set(key, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
        return true;
    }

    if (current.count >= MAX_ATTEMPTS) {
        return false;
    }

    current.count += 1;
    attempts.set(key, current);
    return true;
}

export function registerWebAccessGate(app: Application): void {
    const config = readConfig();
    if (!config.enabled) {
        console.warn('[WebAccess] Password gate disabled; SITE_PASSWORD_HASH or WEB_ACCESS_SESSION_SECRET is missing.');
        return;
    }

    app.get('/access', (req, res) => {
        if (isWebAccessAuthorized(req.headers.cookie)) {
            res.redirect(resolveNext(req.query.next));
            return;
        }
        res.setHeader('Cache-Control', 'no-store');
        res.type('text/html').send(renderAccessPage(resolveNext(req.query.next)));
    });

    app.post('/site-login', async (req, res) => {
        const next = resolveNext(req.body?.next);
        res.setHeader('Cache-Control', 'no-store');

        if (!consumeAttempt(req)) {
            res.status(429).type('text/html').send(
                renderAccessPage(next, 'Çok fazla deneme yapıldı. Birkaç dakika sonra tekrar dene.')
            );
            return;
        }

        const password = typeof req.body?.password === 'string' ? req.body.password : '';
        const passwordMatches = password.length > 0 && await argon2
            .verify(config.passwordHash, password)
            .catch(() => false);
        if (!passwordMatches) {
            res.status(401).type('text/html').send(renderAccessPage(next, 'Şifre doğru değil. Tekrar dene.'));
            return;
        }

        attempts.delete(rateLimitKey(req));
        res.setHeader(
            'Set-Cookie',
            `${COOKIE_NAME}=${createSessionToken(config.secret)}; Max-Age=${SESSION_TTL_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`
        );
        res.redirect(303, next);
    });

    app.use((req: Request, res: Response, next) => {
        if (req.path === '/healthz' || isWebAccessAuthorized(req.headers.cookie)) {
            next();
            return;
        }

        if (req.method === 'GET' || req.method === 'HEAD') {
            const target = encodeURIComponent(resolveNext(req.originalUrl));
            res.redirect(302, `/access?next=${target}`);
            return;
        }

        res.status(401).json({ error: 'Password required.' });
    });
}
