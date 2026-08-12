#!/usr/bin/env node
"use strict";

const fs = require("fs");
const net = require("net");
const path = require("path");
const { BitBuffer } = require("../src/server/dist/network/protocol/bitBuffer");
const { BitReader } = require("../src/server/dist/network/protocol/bitReader");
const {
  deriveClientPasswordDigest
} = require("../src/server/dist/auth/PasswordAuth");

const host = process.env.GAME_HOST || "127.0.0.1";
const port = Number(process.env.GAME_PORT || 8080);
const credentialPath =
  process.env.TEST_ACCOUNT_FILE ||
  path.join(process.env.HOME || "/home/admin", ".config/dungeon-blitz/test-accounts.env");

function readCredentials() {
  const values = {};
  for (const line of fs.readFileSync(credentialPath, "utf8").split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0) {
      values[line.slice(0, separator)] = line.slice(separator + 1);
    }
  }
  return [
    {
      label: "A",
      email: values.TEST_A_EMAIL,
      password: values.TEST_A_PASSWORD,
      character: values.TEST_A_CHARACTER
    },
    {
      label: "B",
      email: values.TEST_B_EMAIL,
      password: values.TEST_B_PASSWORD,
      character: values.TEST_B_CHARACTER
    }
  ];
}

function frame(packetId, payload) {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(packetId, 0);
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function createConnection() {
  const socket = net.createConnection({ host, port });
  let buffer = Buffer.alloc(0);
  const packets = [];
  const waiters = [];

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const packetId = buffer.readUInt16BE(0);
      const length = buffer.readUInt16BE(2);
      if (buffer.length < 4 + length) break;
      const packet = { id: packetId, payload: Buffer.from(buffer.subarray(4, 4 + length)) };
      buffer = buffer.subarray(4 + length);
      packets.push(packet);
      for (const waiter of [...waiters]) {
        if (waiter.id === packetId) {
          clearTimeout(waiter.timer);
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(packet);
        }
      }
    }
  });

  function waitFor(packetId, timeoutMs = 10000) {
    const existing = packets.find((packet) => packet.id === packetId);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = {
        id: packetId,
        resolve,
        timer: setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error(`Timed out waiting for packet 0x${packetId.toString(16)}`));
        }, timeoutMs)
      };
      waiters.push(waiter);
    });
  }

  return {
    socket,
    packets,
    send(packetId, payload) {
      socket.write(frame(packetId, payload));
    },
    waitFor,
    ready: new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    })
  };
}

function buildVersionPacket() {
  const bb = new BitBuffer(false);
  bb.writeMethod9(100);
  return bb.toBuffer();
}

function buildLoginPacket(email, password) {
  const bb = new BitBuffer(false);
  bb.writeMethod26("");
  bb.writeMethod26("");
  bb.writeMethod26(email);
  bb.writeMethod26(deriveClientPasswordDigest(password));
  bb.writeMethod26("");
  return bb.toBuffer();
}

function buildCharacterSelectPacket(character) {
  const bb = new BitBuffer(false);
  bb.writeMethod26(character);
  return bb.toBuffer();
}

function parseEnterWorld(payload) {
  const br = new BitReader(payload);
  const token = br.readMethod4();
  br.readMethod4();
  br.readMethod13();
  const hasOldCoordinates = Boolean(br.readBit());
  if (hasOldCoordinates) {
    br.readMethod4();
    br.readMethod4();
  }
  return {
    token,
    host: br.readMethod13(),
    port: br.readMethod4(),
    levelSwf: br.readMethod13()
  };
}

function buildGameLoginPacket(world) {
  const bb = new BitBuffer(false);
  bb.writeMethod9(world.token);
  bb.writeMethod26(world.levelSwf);
  bb.writeMethod15(true);
  bb.writeMethod15(false);
  return bb.toBuffer();
}

async function enterWorld(account) {
  const login = createConnection();
  await login.ready;
  login.send(0x11, buildVersionPacket());
  await login.waitFor(0x12);
  login.send(0x14, buildLoginPacket(account.email, account.password));
  await login.waitFor(0x15);
  login.send(0x16, buildCharacterSelectPacket(account.character));
  const enterPacket = await login.waitFor(0x21);
  const world = parseEnterWorld(enterPacket.payload);

  const game = createConnection();
  await game.ready;
  game.send(0x1f, buildGameLoginPacket(world));
  await game.waitFor(0x10, 15000);

  return {
    label: account.label,
    character: account.character,
    world,
    login,
    game
  };
}

async function main() {
  const accounts = readCredentials();
  const sessions = await Promise.all(accounts.map(enterWorld));
  const sameWorld =
    sessions[0].world.host === sessions[1].world.host &&
    sessions[0].world.port === sessions[1].world.port &&
    sessions[0].world.levelSwf === sessions[1].world.levelSwf;

  console.log(JSON.stringify({
    login: true,
    concurrentAccounts: true,
    gameSessions: sessions.length,
    sameWorld,
    sessions: sessions.map(({ label, character, world, game }) => ({
      label,
      character,
      advertisedHost: world.host,
      advertisedPort: world.port,
      levelSwf: world.levelSwf,
      receivedPlayerData: game.packets.some((packet) => packet.id === 0x10)
    }))
  }, null, 2));

  await new Promise((resolve) => setTimeout(resolve, 1000));
  for (const session of sessions) {
    session.login.socket.end();
    session.game.socket.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
