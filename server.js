const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// Simple HTTP server to serve the game
const server = http.createServer((req, res) => {
    const urlPath = req.url.split('?')[0];
    let filePath = '.' + urlPath;
    if (filePath === './') filePath = './index.html';

    const extname = path.extname(filePath);
    const contentType = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.ico': 'image/x-icon',
        '.svg': 'image/svg+xml',
        '.json': 'application/json',
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.ogg': 'audio/ogg',
    }[extname] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
});

const wss = new WebSocket.Server({ server });

// ========== GAME CONFIG ==========
const CONFIG = {
    WAVE_DURATION: 10000,
    ZOMBIE_BASE_COUNT: 5,
    ZOMBIE_SPEED_BASE: 1.3,
    BOSS_HEALTH_MULTIPLIER: 15,
    PLAYER_SPEED: 4.8,
    BULLET_SPEED: 11,
    FIRE_RATE: 70,
    QNA_MULTIPLIER: 2,
    MAX_PARTICLES: 150,
    MAX_DAMAGE_NUMBERS: 30,
    MAX_BULLETS: 50,
    DAMAGE_COOLDOWN: 500,
    SPAWN_MARGIN: 150,
    QNA_ANNOUNCE_DURATION: 3000,
};

// ========== GAME STATE ==========
let gameState = {
    running: false,
    players: {},
    zombies: [],
    bullets: [],
    particles: [],
    damageNumbers: [],
    wave: 1,
    isBossWave: false,
    isQNAWave: false,
    waveStartTime: 0,
    waveType: 'Normal',
    gameOver: false,
    playerCount: 0,
    waveDuration: CONFIG.WAVE_DURATION,
};

let canvasWidth = 3000;
let canvasHeight = 2000;
let lastTimestamp = Date.now();
let waveTimer = null;
let gameLoopInterval = null;
let zombieSpawned = false;
let joinedPlayers = {};

// ========== PLAYER CLASS ==========
function createPlayer(id, username) {
    return {
        id,
        username: username || id.substring(0, 6),
        x: canvasWidth / 2 + (Math.random() - 0.5) * 400,
        y: canvasHeight / 2 + (Math.random() - 0.5) * 400,
        radius: 22,
        angle: 0,
        health: 100,
        maxHealth: 100,
        score: 0,
        kills: 0,
        connected: true,
        lastFireTime: 0,
        lastDamageTime: 0,
        alive: true,
    };
}

// ========== HELPERS ==========
function getSpawnPos(margin) {
    const minDist = 100;
    let x, y, attempts = 0;
    do {
        const side = Math.floor(Math.random() * 4);
        switch (side) {
            case 0: x = -margin; y = Math.random() * canvasHeight; break;
            case 1: x = canvasWidth + margin; y = Math.random() * canvasHeight; break;
            case 2: x = Math.random() * canvasWidth; y = -margin; break;
            default: x = Math.random() * canvasWidth; y = canvasHeight + margin;
        }
        attempts++;
    } while (attempts < 20);
    return { x, y };
}

function spawnZombies() {
    let count = CONFIG.ZOMBIE_BASE_COUNT * gameState.wave;
    if (gameState.isQNAWave) count *= CONFIG.QNA_MULTIPLIER;
    count = Math.min(Math.floor(count), 35);
    if (gameState.isBossWave) {
        spawnBoss();
        const n = gameState.isQNAWave ? count : Math.max(2, Math.floor(count / 3));
        for (let i = 0; i < n; i++) spawnSingleZombie(false);
    } else {
        for (let i = 0; i < count; i++) spawnSingleZombie(false);
    }
    zombieSpawned = true;
}

function spawnBoss() {
    const pos = getSpawnPos(60);
    gameState.zombies.push({
        x: pos.x, y: pos.y, radius: 52,
        speed: CONFIG.ZOMBIE_SPEED_BASE * 0.58,
        health: gameState.wave * CONFIG.BOSS_HEALTH_MULTIPLIER,
        maxHealth: gameState.wave * CONFIG.BOSS_HEALTH_MULTIPLIER,
        isBoss: true, damage: 22, animOffset: 0, hitFlash: 0, lastHitTime: 0,
    });
}

function spawnSingleZombie(isBoss) {
    const pos = getSpawnPos(isBoss ? 60 : 40);
    const speedMult = 1 + (gameState.wave * 0.07);
    const baseSpeed = isBoss ? CONFIG.ZOMBIE_SPEED_BASE * 0.55 : CONFIG.ZOMBIE_SPEED_BASE;
    gameState.zombies.push({
        x: pos.x, y: pos.y,
        radius: isBoss ? 52 : 26,
        speed: baseSpeed * speedMult * (0.85 + Math.random() * 0.3),
        health: isBoss ? gameState.wave * CONFIG.BOSS_HEALTH_MULTIPLIER : 2 + Math.floor(gameState.wave / 3),
        maxHealth: isBoss ? gameState.wave * CONFIG.BOSS_HEALTH_MULTIPLIER : 2 + Math.floor(gameState.wave / 3),
        isBoss: isBoss,
        damage: isBoss ? 22 : 8,
        animOffset: Math.random() * Math.PI * 2,
        hitFlash: 0,
        lastHitTime: 0,
    });
}

function addParticle(x, y, vx, vy, color, size, decay) {
    if (gameState.particles.length >= CONFIG.MAX_PARTICLES) gameState.particles.shift();
    gameState.particles.push({ x, y, vx, vy, life: 1, decay, size, color });
}

function createExplosion(x, y, color, count) {
    for (let i = 0; i < Math.min(count, 20); i++) {
        const a = (Math.PI * 2 / count) * i + Math.random() * 0.5;
        const s = 2 + Math.random() * 5;
        addParticle(x, y, Math.cos(a) * s, Math.sin(a) * s, color, 4 + Math.random() * 7, 0.02 + Math.random() * 0.03);
    }
}

function addDamageNumber(x, y, value, isCrit) {
    if (gameState.damageNumbers.length >= CONFIG.MAX_DAMAGE_NUMBERS) gameState.damageNumbers.shift();
    gameState.damageNumbers.push({ x, y, value, life: 1, vy: -2.5, isCrit });
}

// ========== GAME LOGIC ==========
function updateGame() {
    if (!gameState.running || gameState.gameOver) return;

    const now = Date.now();
    const dt = Math.min(now - lastTimestamp, 50);
    lastTimestamp = now;

    // Update zombies
    for (const z of gameState.zombies) {
        // Find nearest alive player
        let nearest = null;
        let minDist = Infinity;
        for (const pid in gameState.players) {
            const p = gameState.players[pid];
            if (!p.alive) continue;
            const dx = p.x - z.x;
            const dy = p.y - z.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < minDist) {
                minDist = dist;
                nearest = p;
            }
        }
        if (nearest) {
            const dx = nearest.x - z.x;
            const dy = nearest.y - z.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > 1) {
                z.x += (dx / dist) * z.speed;
                z.y += (dy / dist) * z.speed;
            }
        }
        if (z.hitFlash > 0) {
            z.hitFlash -= dt * 0.005;
            if (z.hitFlash < 0) z.hitFlash = 0;
        }

        // Damage players
        for (const pid in gameState.players) {
            const p = gameState.players[pid];
            if (!p.alive) continue;
            const dx = p.x - z.x;
            const dy = p.y - z.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < z.radius + p.radius - 5 && dist > 0) {
                if (now - p.lastDamageTime > CONFIG.DAMAGE_COOLDOWN) {
                    p.health -= z.damage;
                    p.lastDamageTime = now;
                    z.lastHitTime = now;
                    const pushAngle = Math.atan2(dy, dx);
                    p.x -= Math.cos(pushAngle) * 15;
                    p.y -= Math.sin(pushAngle) * 15;
                    p.x = Math.max(p.radius, Math.min(canvasWidth - p.radius, p.x));
                    p.y = Math.max(p.radius, Math.min(canvasHeight - p.radius, p.y));
                    addParticle(p.x, p.y, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, '#e63946', 6, 0.08);
                    if (p.health <= 0) {
                        p.alive = false;
                        p.health = 0;
                    }
                }
            }
        }
    }

    // Update bullets
    for (let i = gameState.bullets.length - 1; i >= 0; i--) {
        const b = gameState.bullets[i];
        b.x += b.vx;
        b.y += b.vy;
        if (b.x < -30 || b.x > canvasWidth + 30 || b.y < -30 || b.y > canvasHeight + 30) {
            gameState.bullets.splice(i, 1);
            continue;
        }
        for (let j = gameState.zombies.length - 1; j >= 0; j--) {
            const z = gameState.zombies[j];
            const dx = b.x - z.x;
            const dy = b.y - z.y;
            if (dx * dx + dy * dy < (b.radius + z.radius) ** 2) {
                z.health -= b.damage;
                z.hitFlash = 1;
                gameState.bullets.splice(i, 1);
                createExplosion(b.x, b.y, '#ffcc00', 4);
                if (z.health <= 0) {
                    const pts = z.isBoss ? 500 : 100;
                    if (b.playerId && gameState.players[b.playerId]) {
                        gameState.players[b.playerId].score += pts;
                        gameState.players[b.playerId].kills++;
                    }
                    createExplosion(z.x, z.y, z.isBoss ? '#ff6b35' : '#e63946', z.isBoss ? 22 : 10);
                    addDamageNumber(z.x, z.y - z.radius - 10, pts, z.isBoss);
                    gameState.zombies.splice(j, 1);
                } else {
                    addDamageNumber(z.x, z.y - z.radius - 5, b.damage, false);
                }
                break;
            }
        }
    }

    // Update particles
    for (let i = gameState.particles.length - 1; i >= 0; i--) {
        const p = gameState.particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.vx *= 0.94;
        p.vy *= 0.94;
        p.life -= p.decay;
        if (p.life <= 0) gameState.particles.splice(i, 1);
    }

    // Update damage numbers
    for (let i = gameState.damageNumbers.length - 1; i >= 0; i--) {
        const d = gameState.damageNumbers[i];
        d.y += d.vy;
        d.life -= 0.025;
        if (d.life <= 0) gameState.damageNumbers.splice(i, 1);
    }

    // Check wave completion
    const elapsed = now - gameState.waveStartTime;
    if (elapsed >= CONFIG.WAVE_DURATION || gameState.zombies.length === 0) {
        nextWave();
    }

    // Check if all players are dead
    let aliveCount = 0;
    for (const pid in gameState.players) {
        if (gameState.players[pid].alive) aliveCount++;
    }
    if (aliveCount === 0 && Object.keys(gameState.players).length > 0) {
        gameState.gameOver = true;
        gameState.running = false;
        if (waveTimer) { clearTimeout(waveTimer); waveTimer = null; }
        broadcastState();
    }
}

function nextWave() {
    gameState.wave++;
    gameState.isBossWave = gameState.wave % 3 === 0;
    gameState.isQNAWave = gameState.wave % 5 === 0;
    gameState.waveStartTime = Date.now();
    zombieSpawned = false;

    if (gameState.isQNAWave) {
        gameState.waveType = 'QNA SESSION!';
    } else if (gameState.isBossWave) {
        gameState.waveType = 'BOSS WAVE!';
    } else {
        gameState.waveType = 'Normal';
    }

    // Heal alive players
    for (const pid in gameState.players) {
        const p = gameState.players[pid];
        if (p.alive) {
            p.health = Math.min(p.maxHealth, p.health + 15);
        }
    }

    spawnZombies();
    broadcastState();
}

function broadcastState() {
    const state = {
        type: 'state',
        players: gameState.players,
        zombies: gameState.zombies,
        bullets: gameState.bullets,
        particles: gameState.particles,
        damageNumbers: gameState.damageNumbers,
        wave: gameState.wave,
        isBossWave: gameState.isBossWave,
        isQNAWave: gameState.isQNAWave,
        waveType: gameState.waveType,
        waveStartTime: gameState.waveStartTime,
        waveDuration: CONFIG.WAVE_DURATION,
        gameOver: gameState.gameOver,
        playerCount: Object.keys(gameState.players).filter(id => gameState.players[id].connected).length,
        canvasWidth,
        canvasHeight,
        worldWidth: canvasWidth,
        worldHeight: canvasHeight,
        running: gameState.running,
    };

    const data = JSON.stringify(state);
    for (const ws of wss.clients) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(data);
        }
    }
}

function startGameLoop() {
    if (gameLoopInterval) return;
    gameState.running = true;
    gameState.gameOver = false;
    gameState.wave = 1;
    gameState.isBossWave = false;
    gameState.isQNAWave = false;
    gameState.waveStartTime = Date.now();
    gameState.waveType = 'Normal';
    gameState.zombies = [];
    gameState.bullets = [];
    gameState.particles = [];
    gameState.damageNumbers = [];
    zombieSpawned = false;
    // Reset all players for fresh game
    for (const pid in gameState.players) {
        const p = gameState.players[pid];
        p.health = p.maxHealth || 100;
        p.alive = true;
        p.score = 0;
        p.kills = 0;
        p.x = canvasWidth / 2 + (Math.random() - 0.5) * 200;
        p.y = canvasHeight / 2 + (Math.random() - 0.5) * 200;
        p.lastDamageTime = 0;
    }
    lastTimestamp = Date.now();

    spawnZombies();

    gameLoopInterval = setInterval(() => {
        updateGame();
        broadcastState();
    }, 1000 / 60);

    // Broadcast extra QNA announcement
    if (gameState.isQNAWave) {
        setTimeout(() => {
            broadcastQNAAnnouncement();
        }, 500);
    }
}

function broadcastQNAAnnouncement() {
    for (const ws of wss.clients) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'qna' }));
        }
    }
}

function stopGameLoop() {
    if (gameLoopInterval) {
        clearInterval(gameLoopInterval);
        gameLoopInterval = null;
    }
    gameState.running = false;
}

// ========== WEBSOCKET HANDLING ==========
wss.on('connection', (ws) => {
    console.log('New connection');
    let playerId = null;
    let hasJoinedGame = false;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            switch (data.type) {
                case 'join': {
                    const username = data.username || 'Player';
                    // Check if this ws already has a player
                    let existingPid = null;
                    for (const pid in joinedPlayers) {
                        if (joinedPlayers[pid].ws === ws) {
                            existingPid = pid;
                            break;
                        }
                    }
                    if (existingPid) {
                        // Update existing player
                        playerId = existingPid;
                        const p = gameState.players[playerId];
                        if (p) {
                            p.username = username;
                            p.connected = true;
                            p.alive = true;
                            p.health = p.maxHealth || 100;
                        }
                        ws.send(JSON.stringify({
                            type: 'init',
                            playerId: playerId,
                            canvasWidth,
                            canvasHeight,
                        }));
                        broadcastState();
                        break;
                    }

                    playerId = 'player_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);

                    // Create player
                    const player = createPlayer(playerId, username);
                    gameState.players[playerId] = player;
                    joinedPlayers[playerId] = { ws, playerId, username };
                    hasJoinedGame = true;

                    // Send init message
                    ws.send(JSON.stringify({
                        type: 'init',
                        playerId: playerId,
                        canvasWidth,
                        canvasHeight,
                        worldWidth: canvasWidth,
                        worldHeight: canvasHeight,
                    }));

                    // Start or restart game
                    if (gameState.gameOver || !gameState.running) {
                        if (gameState.gameOver) stopGameLoop();
                        startGameLoop();
                    }

                    broadcastState();
                    console.log(`Player ${username} joined (${Object.keys(gameState.players).length} players)`);
                    break;
                }

                case 'input': {
                    if (!playerId || !gameState.players[playerId]) return;
                    const p = gameState.players[playerId];
                    if (!p.alive) return;

                    // Movement
                    let mx = data.mx || 0;
                    let my = data.my || 0;
                    p.x += mx * CONFIG.PLAYER_SPEED;
                    p.y += my * CONFIG.PLAYER_SPEED;
                    p.x = Math.max(p.radius, Math.min(canvasWidth - p.radius, p.x));
                    p.y = Math.max(p.radius, Math.min(canvasHeight - p.radius, p.y));

                    // Aim
                    if (data.mouseX !== undefined && data.mouseY !== undefined) {
                        p.angle = Math.atan2(data.mouseY - p.y, data.mouseX - p.x);
                    }

                    // Shooting
                    if (data.shooting) {
                        const now = Date.now();
                        if (now - p.lastFireTime >= CONFIG.FIRE_RATE && gameState.bullets.length < CONFIG.MAX_BULLETS) {
                            p.lastFireTime = now;
                            gameState.bullets.push({
                                x: p.x + Math.cos(p.angle) * 28,
                                y: p.y + Math.sin(p.angle) * 28,
                                vx: Math.cos(p.angle) * CONFIG.BULLET_SPEED,
                                vy: Math.sin(p.angle) * CONFIG.BULLET_SPEED,
                                radius: 5,
                                damage: 1,
                                playerId: playerId,
                            });
                        }
                    }
                    break;
                }

                case 'spectate': {
                    // Just send them the game state
                    ws.send(JSON.stringify({
                        type: 'init',
                        playerId: 'spectator_' + Date.now(),
                        canvasWidth,
                        canvasHeight,
                    }));
                    broadcastState();
                    break;
                }

                case 'leave': {
                    if (playerId && gameState.players[playerId]) {
                        delete gameState.players[playerId];
                        delete joinedPlayers[playerId];
                        broadcastState();
                        console.log(`Player ${playerId} left`);
                    }
                    break;
                }
            }
        } catch (e) {
            console.error('Error processing message:', e);
        }
    });

    ws.on('close', () => {
        console.log('Connection closed');
        if (playerId && gameState.players[playerId]) {
            gameState.players[playerId].connected = false;
            gameState.players[playerId].alive = false;
            // Remove after delay
            setTimeout(() => {
                if (gameState.players[playerId] && !gameState.players[playerId].connected) {
                    delete gameState.players[playerId];
                    delete joinedPlayers[playerId];
                    broadcastState();
                    // Stop game if no players
                    if (Object.keys(gameState.players).length === 0) {
                        stopGameLoop();
                    }
                }
            }, 5000);
            broadcastState();
        }
    });

    // Send current state immediately
    broadcastState();
});

// ========== CLEANUP ==========
setInterval(() => {
    // Clean up disconnected players after 30s
    const now = Date.now();
    for (const pid in gameState.players) {
        if (!gameState.players[pid].connected) {
            delete gameState.players[pid];
            delete joinedPlayers[pid];
        }
    }
}, 30000);

server.listen(PORT, () => {
    console.log(`Chandan Game V2 server running on http://0.0.0.0:${PORT}`);
    console.log(`WebSocket available at ws://0.0.0.0:${PORT}`);
});
