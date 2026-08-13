import './helpers/disable_production_mongo';
import { strict as assert } from 'assert';
import * as path from 'path';
import { Entity, EntityState, EntityTeam } from '../core/Entity';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { EntityHandler } from '../handlers/EntityHandler';

const LEVEL = 'NewbieRoad';

function createSpawnedPlayer(token: number, name: string): any {
    const client: any = {
        token,
        userId: token,
        clientEntID: token + 100,
        playerSpawned: true,
        currentLevel: LEVEL,
        levelInstanceId: '',
        currentRoomId: 0,
        character: {
            name,
            level: 1,
            class: 'warrior',
            MasterClass: 0,
            CurrentLevel: { name: LEVEL, x: 100, y: 100 }
        },
        knownEntityIds: new Set<number>(),
        entities: new Map(),
        sentPackets: [] as Array<{ id: number }>,
        send(id: number) { this.sentPackets.push({ id }); },
        sendBitBuffer(id: number) { this.sentPackets.push({ id }); }
    };

    const playerEntity: any = {
        ...Entity.fromCharacter(client.clientEntID, client.character, {
            x: 100,
            y: 100,
            team: EntityTeam.PLAYER,
            entState: EntityState.ACTIVE,
            roomId: 0
        }),
        ownerToken: token,
        isPlayer: true,
        hp: 100,
        maxHp: 100
    };

    client.entities.set(client.clientEntID, playerEntity);

    GlobalState.sessionsByToken.set(token, client);
    GlobalState.refreshSessionIndexes(client);
    return client;
}

function joinRoom(joiner: any): void {
    (EntityHandler as any).sendExistingPlayersToJoiner(joiner);
    (EntityHandler as any).broadcastPlayerSpawn(joiner, joiner.entities.get(joiner.clientEntID));
}

// The bug this regression guards against: a joiner's own entity snapshot isn't always
// materialized in `client.entities` on the exact tick the join broadcast fires (real
// production has async work -- character reload, guild refresh, etc. -- between the two).
// The old code called buildPlayerSnapshot() once and silently gave up if it returned null,
// which meant nobody already in the room ever found out the joiner existed. This must now
// retry until the snapshot exists (or a bounded attempt cap is hit) instead of dropping it.
async function testDeferredSnapshotIsNotSilentlyDropped(): Promise<void> {
    const a = createSpawnedPlayer(90003, 'AlreadyThere2');
    const b = createSpawnedPlayer(90004, 'LateJoiner');

    // buildPlayerSnapshot() only returns null when clientEntID isn't assigned yet (or
    // character/currentLevel are missing) -- simulate that exact narrow timing gap: the
    // join broadcast fires before clientEntID is set, then it becomes valid a moment later.
    const bEntity = b.entities.get(b.clientEntID);
    const realClientEntID = b.clientEntID;
    b.clientEntID = 0;
    setTimeout(() => {
        b.clientEntID = realClientEntID;
    }, 50);

    (EntityHandler as any).sendExistingPlayersToJoiner(b);
    (EntityHandler as any).broadcastPlayerSpawn(b, bEntity);

    assert.equal(a.sentPackets.length, 0, 'must not have anything to send yet -- the snapshot was missing');

    await new Promise((resolve) => setTimeout(resolve, 500));

    assert.equal(a.sentPackets.length > 0, true, 'the retry must eventually deliver the join broadcast');
    console.log('testDeferredSnapshotIsNotSilentlyDropped: ok, attempts before delivery took <500ms');
}

async function main(): Promise<void> {
    const dataDir = path.resolve(__dirname, '../data');
    LevelConfig.load(dataDir);
    GameData.load(dataDir);

    const levelEntities = new Map(GlobalState.levelEntities);
    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    try {
        // A is already in the room and spawned; B joins next -- mirror what
        // handleEntityFullUpdate does right after client.playerSpawned flips true for a
        // fresh self-spawn packet: sendExistingPlayersToJoiner(joiner) then
        // broadcastPlayerSpawn(joiner, props).
        const a = createSpawnedPlayer(90001, 'AlreadyThere');
        const b = createSpawnedPlayer(90002, 'Joiner');

        joinRoom(b);

        console.log('B received packets (should see A):', b.sentPackets.length);
        console.log('A received packets (should see B):', a.sentPackets.length);

        assert.equal(b.sentPackets.length > 0, true, 'joiner must receive the existing player');
        assert.equal(a.sentPackets.length > 0, true, 'existing player must receive the joiner');

        await testDeferredSnapshotIsNotSilentlyDropped();

        console.log('player_visibility_regression: ok');
    } finally {
        GlobalState.levelEntities.clear();
        for (const [key, value] of levelEntities) GlobalState.levelEntities.set(key, value);
        GlobalState.sessionsByToken.clear();
        for (const [key, value] of sessionsByToken) GlobalState.sessionsByToken.set(key, value);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
