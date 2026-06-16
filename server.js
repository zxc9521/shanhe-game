const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const app = express();
const PORT = 80;
const WORLD_SIZE = 300;
const SPAWN_MARGIN = 20;

app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

const db = new sqlite3.Database(path.join(__dirname, "shanhe.db"));

const tileTypes = [
  "resource",
  "resource",
  "fieldTile",
  "salt",
  "horse",
  "mine",
  "battlefield",
  "trade",
  "npc",
  "city",
  "pass"
];

const resources = ["粮草", "木材", "石料", "铁矿", "铜钱"];
const terrains = ["平原", "山地", "森林", "河流", "荒漠", "古战场"];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function sendError(res, message) {
  res.json({ ok: false, message });
}

function tileLevel(x, y) {
  const center = Math.floor(WORLD_SIZE / 2);
  const d = Math.abs(x - center) + Math.abs(y - center);
  return Math.max(1, Math.ceil(d / 25));
}

function makeTile(x, y) {
  let type = pick(tileTypes);

  if (x % 60 === 30 && y % 60 === 30) {
    type = "city";
  } else if (x % 45 === 20 && y % 45 === 20) {
    type = "pass";
  }

  const lv = tileLevel(x, y);

  return {
    id: `${x}_${y}`,
    x,
    y,
    type,
    lv,
    owner: "",
    garrisonTeam: "",
    enemy: Math.random() < 0.015 ? 1 : 0,
    res: pick(resources),
    guard: 500 + lv * 450,
    terrain: pick(terrains)
  };
}

function initWorld() {
  db.get("SELECT COUNT(*) AS count FROM world_tiles", [], (err, row) => {
    if (err) {
      console.error("检查世界地图失败", err);
      return;
    }

    if (row.count > 0) {
      console.log(`世界地图已存在：${row.count} 个地块`);
      return;
    }

    console.log(`开始生成 ${WORLD_SIZE}×${WORLD_SIZE} 世界地图，请稍等...`);

    db.serialize(() => {
      db.run("BEGIN TRANSACTION");

      const stmt = db.prepare(`
        INSERT INTO world_tiles(
          id, x, y, type, lv, owner, garrisonTeam, enemy, res, guard, terrain
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      `);

      for (let y = 0; y < WORLD_SIZE; y++) {
        for (let x = 0; x < WORLD_SIZE; x++) {
          const t = makeTile(x, y);
          stmt.run([
            t.id,
            t.x,
            t.y,
            t.type,
            t.lv,
            t.owner,
            t.garrisonTeam,
            t.enemy,
            t.res,
            t.guard,
            t.terrain
          ]);
        }
      }

      stmt.finalize();
      db.run("COMMIT");
      console.log("世界地图生成完成");
    });
  });
}

function randomSpawn() {
  const x = SPAWN_MARGIN + Math.floor(Math.random() * (WORLD_SIZE - SPAWN_MARGIN * 2));
  const y = SPAWN_MARGIN + Math.floor(Math.random() * (WORLD_SIZE - SPAWN_MARGIN * 2));
  return { x, y };
}

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      acc TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      pwd TEXT NOT NULL,
      player TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS world_tiles (
      id TEXT PRIMARY KEY,
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      type TEXT NOT NULL,
      lv INTEGER NOT NULL,
      owner TEXT NOT NULL DEFAULT '',
      garrisonTeam TEXT NOT NULL DEFAULT '',
      enemy INTEGER NOT NULL DEFAULT 0,
      res TEXT NOT NULL,
      guard INTEGER NOT NULL,
      terrain TEXT NOT NULL
    )
  `);

  initWorld();
});

app.post("/api/register", (req, res) => {
  const { acc, name, pwd, player } = req.body || {};

  if (!acc || !name || !pwd || !player) {
    return sendError(res, "注册信息不完整");
  }

  const spawn = randomSpawn();
  player.center = spawn;
  player.map = {};
  player.seen = {};
  player.worldSize = WORLD_SIZE;

  db.get("SELECT acc FROM users WHERE acc = ?", [acc], (err, row) => {
    if (err) return sendError(res, "数据库错误");
    if (row) return sendError(res, "账号已存在");

    db.run(
      "INSERT INTO users(acc, name, pwd, player, updated_at) VALUES(?,?,?,?,?)",
      [acc, name, pwd, JSON.stringify(player), Date.now()],
      err2 => {
        if (err2) return sendError(res, "注册失败");
        res.json({ ok: true, player, worldSize: WORLD_SIZE });
      }
    );
  });
});

app.post("/api/login", (req, res) => {
  const { acc, pwd } = req.body || {};

  if (!acc || !pwd) {
    return sendError(res, "账号或密码不能为空");
  }

  db.get("SELECT * FROM users WHERE acc = ?", [acc], (err, row) => {
    if (err) return sendError(res, "数据库错误");
    if (!row || row.pwd !== pwd) return sendError(res, "账号或密码错误");

    const player = JSON.parse(row.player);
    if (!player.center) player.center = randomSpawn();
    if (!player.map) player.map = {};
    player.worldSize = WORLD_SIZE;

    res.json({
      ok: true,
      name: row.name,
      player,
      worldSize: WORLD_SIZE
    });
  });
});

app.post("/api/save", (req, res) => {
  const { acc, pwd, player } = req.body || {};

  if (!acc || !pwd || !player) {
    return sendError(res, "保存信息不完整");
  }

  db.get("SELECT * FROM users WHERE acc = ?", [acc], (err, row) => {
    if (err) return sendError(res, "数据库错误");
    if (!row || row.pwd !== pwd) return sendError(res, "账号验证失败");

    player.map = {};
    player.worldSize = WORLD_SIZE;

    db.run(
      "UPDATE users SET player = ?, updated_at = ? WHERE acc = ?",
      [JSON.stringify(player), Date.now(), acc],
      err2 => {
        if (err2) return sendError(res, "保存失败");
        res.json({ ok: true });
      }
    );
  });
});

app.get("/api/world/tiles", (req, res) => {
  const cx = Number(req.query.cx);
  const cy = Number(req.query.cy);
  const radius = Math.min(10, Math.max(2, Number(req.query.radius || 2)));

  if (!Number.isInteger(cx) || !Number.isInteger(cy)) {
    return sendError(res, "坐标错误");
  }

  const minX = Math.max(0, cx - radius);
  const maxX = Math.min(WORLD_SIZE - 1, cx + radius);
  const minY = Math.max(0, cy - radius);
  const maxY = Math.min(WORLD_SIZE - 1, cy + radius);

  db.all(
    `
    SELECT * FROM world_tiles
    WHERE x BETWEEN ? AND ?
      AND y BETWEEN ? AND ?
    ORDER BY y ASC, x ASC
    `,
    [minX, maxX, minY, maxY],
    (err, rows) => {
      if (err) return sendError(res, "读取世界地图失败");

      const tiles = {};
      for (const row of rows) {
        tiles[row.id] = {
          id: row.id,
          x: row.x,
          y: row.y,
          type: row.type,
          lv: row.lv,
          owner: row.owner,
          garrisonTeam: row.garrisonTeam,
          enemy: !!row.enemy,
          res: row.res,
          guard: row.guard,
          terrain: row.terrain
        };
      }

      res.json({
        ok: true,
        worldSize: WORLD_SIZE,
        tiles
      });
    }
  );
});

app.post("/api/world/occupy", (req, res) => {
  const { acc, pwd, tileId, owner, garrisonTeam } = req.body || {};

  if (!acc || !pwd || !tileId || !owner) {
    return sendError(res, "占领信息不完整");
  }

  db.get("SELECT * FROM users WHERE acc = ?", [acc], (err, row) => {
    if (err) return sendError(res, "数据库错误");
    if (!row || row.pwd !== pwd) return sendError(res, "账号验证失败");

    db.run(
      `
      UPDATE world_tiles
      SET owner = ?, garrisonTeam = ?, enemy = 0
      WHERE id = ?
      `,
      [owner, garrisonTeam || "", tileId],
      err2 => {
        if (err2) return sendError(res, "更新地块失败");
        res.json({ ok: true });
      }
    );
  });
});

app.post("/api/world/withdraw", (req, res) => {
  const { acc, pwd, tileId } = req.body || {};

  if (!acc || !pwd || !tileId) {
    return sendError(res, "撤军信息不完整");
  }

  db.get("SELECT * FROM users WHERE acc = ?", [acc], (err, row) => {
    if (err) return sendError(res, "数据库错误");
    if (!row || row.pwd !== pwd) return sendError(res, "账号验证失败");

    db.run(
      "UPDATE world_tiles SET garrisonTeam = '' WHERE id = ?",
      [tileId],
      err2 => {
        if (err2) return sendError(res, "撤军失败");
        res.json({ ok: true });
      }
    );
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("山河余烬服务器已启动：http://0.0.0.0:80");
});