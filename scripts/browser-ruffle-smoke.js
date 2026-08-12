#!/usr/bin/env node
"use strict";

const path = require("path");
const { chromium, firefox } = require("playwright");

const siteUrl = process.env.SITE_URL || "https://dungenblitz.ecliptia.net";
const password = process.env.SITE_PASSWORD;
const browserName = process.argv[2] || "chromium";
const browserType = browserName === "firefox" ? firefox : chromium;

if (!password) {
  throw new Error("SITE_PASSWORD is required.");
}

async function main() {
  const browser = await browserType.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    colorScheme: "dark"
  });
  const page = await context.newPage();
  const consoleMessages = [];
  const pageErrors = [];
  const failedRequests = [];
  const badResponses = [];
  const webSockets = [];

  page.on("console", (message) => {
    consoleMessages.push({ type: message.type(), text: message.text() });
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    failedRequests.push({
      url: request.url(),
      error: request.failure()?.errorText || "unknown"
    });
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      badResponses.push({ status: response.status(), url: response.url() });
    }
  });
  page.on("websocket", (webSocket) => {
    webSockets.push(webSocket.url());
  });

  await page.goto(`${siteUrl}/`, { waitUntil: "domcontentloaded" });
  const usernameFields = await page.locator('input[name="username"]').count();
  const passwordFields = await page.locator('input[name="password"]').count();
  await page.screenshot({ path: `/tmp/dbr-access-${browserName}.png`, fullPage: true });

  await page.locator('input[name="password"]').fill(password);
  await Promise.all([
    page.waitForURL(`${siteUrl}/`),
    page.getByRole("button", { name: "Enter Server" }).click()
  ]);

  await page.goto(`${siteUrl}/play-test/`, { waitUntil: "domcontentloaded" });
  await page.locator("ruffle-player").waitFor({ state: "attached", timeout: 20000 });
  await page.waitForTimeout(45000);
  await page.screenshot({
    path: `/tmp/dbr-ruffle-${browserName}.png`,
    fullPage: true
  });

  const state = await page.evaluate(() => {
    const player = document.querySelector("ruffle-player");
    const status = document.getElementById("ruffle-status");
    const rect = player?.getBoundingClientRect();
    return {
      url: location.href,
      title: document.title,
      playerAttached: Boolean(player),
      playerSize: rect ? { width: Math.round(rect.width), height: Math.round(rect.height) } : null,
      statusHidden: Boolean(status?.hidden),
      bodyText: document.body.innerText.slice(0, 500)
    };
  });

  console.log(JSON.stringify({
    browser: browserName,
    access: {
      usernameFields,
      passwordFields
    },
    state,
    webSockets,
    pageErrors,
    failedRequests,
    badResponses,
    consoleMessages: consoleMessages.slice(-250),
    screenshots: {
      access: path.resolve(`/tmp/dbr-access-${browserName}.png`),
      ruffle: path.resolve(`/tmp/dbr-ruffle-${browserName}.png`)
    }
  }, null, 2));

  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
