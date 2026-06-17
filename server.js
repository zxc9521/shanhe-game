const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const app = express();

const PORT = 80;
const WORLD_SIZE = 30;
const SPAWN_MARGIN = 3;
const CHAT_COOLDOWN_MS = 3000;
const BLACK_MARKET_UPDATE_MS = 60 * 60 * 1000;
const BLACK_MARKET_LIMIT = 0.12;
const BLACK_MARKET_CACHE_MS = 30 * 1000;
let blackMarketCache = null;
let blackMarketCacheAt = 0;

const BLACK_MARKET_ASSETS = [
  { id: "qin_heavy", name: "大秦重工", base: 1000 },
  { id: "donghai_salt", name: "东海制盐", base: 850 },
  { id: "xuanjing_mine", name: "玄晶矿业", base: 1200 },
  { id: "silk_road", name: "西域商路", base: 950 },
  { id: "tianji_workshop", name: "天机工坊", base: 1500 }
];

const GM_KEY = process.env.GM_KEY || "shanhe-gm-123456";

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

function sendOk(res, data = {}) {
  res.json({ ok: true, ...data });
}

function requireGm(req, res, next) {
  const key = req.headers["x-gm-key"] || req.query.gmKey || "";
  if (key !== GM_KEY) {
    return res.status(403).json({ ok: false, message: "GM 密钥错误" });
  }
  next();
}

function parsePlayer(row) {
  try {
    return JSON.parse(row.player || "{}");
  } catch (e) {
    return {};
  }
}

function savePlayer(acc, player, callback) {
  db.run(
    "UPDATE users SET player = ?, updated_at = ? WHERE acc = ?",
    [JSON.stringify(player), Date.now(), acc],
    callback
  );
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

        if (row.count === WORLD_SIZE * WORLD_SIZE) {
      console.log(`世界地图已存在：${row.count} 个地块`);
      return;
    }

    if (row.count > 0 && row.count !== WORLD_SIZE * WORLD_SIZE) {
      console.log(`检测到旧地图尺寸，正在重建为 ${WORLD_SIZE}×${WORLD_SIZE} 世界地图...`);
      db.run("DELETE FROM world_tiles");
    }

    console.log(`开始生成 ${WORLD_SIZE}×${WORLD_SIZE} 世界地图，请稍等...`);

    db.serialize(() => {
      db.run("BEGIN TRANSACTION");

      const stmt = db.prepare(`
        INSERT INTO world_tiles(
          id, x, y, type, lv, owner, owner_acc, garrisonTeam, enemy, res, guard, terrain
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
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
            "",
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

function verifyUser(acc, pwd, callback) {
  if (!acc || !pwd) {
    callback(null, null, "账号或密码不能为空");
    return;
  }

  db.get("SELECT * FROM users WHERE acc = ?", [acc], (err, row) => {
    if (err) {
      callback(err, null, "数据库错误");
      return;
    }

    if (!row || row.pwd !== pwd) {
      callback(null, null, "账号验证失败");
      return;
    }

    db.get("SELECT * FROM user_flags WHERE acc = ?", [acc], (flagErr, flag) => {
      if (flagErr) {
        callback(flagErr, null, "读取账号状态失败");
        return;
      }

      const player = parsePlayer(row);

      callback(null, {
        ...row,
        player,
        banned: !!(flag && flag.banned),
muted: !!(flag && flag.muted),
ban_reason: flag ? flag.ban_reason || "" : "",
mute_reason: flag ? flag.mute_reason || "" : ""
      }, "");
    });
  });
}

function cleanChatText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function formatChatMessage(row) {
  return {
    id: row.id,
    channel: row.channel,
    fromAcc: row.from_acc,
    fromName: row.from_name,
    toAcc: row.to_acc,
    toName: row.to_name,
    alliance: row.alliance,
    text: row.text,
    createdAt: row.created_at
  };
}

function normalizeReward(reward) {
  const safe = {};

  if (reward && typeof reward === "object") {
    if (reward.res && typeof reward.res === "object") safe.res = reward.res;
    if (reward.bag && typeof reward.bag === "object") safe.bag = reward.bag;
    if (reward.frags && typeof reward.frags === "object") safe.frags = reward.frags;
  }

  return safe;
}

function blackMarketRandomMove() {
  return Number(((Math.random() * 2 - 1) * BLACK_MARKET_LIMIT).toFixed(4));
}

function blackMarketClampPrice(price) {
  return Math.max(100, Math.floor(price));
}

function blackMarketHistoryPush(history, price, time) {
  const list = Array.isArray(history) ? history : [];
  list.push({ price, time });
  return list.slice(-48);
}

function runBlackMarketOps(ops, callback) {
  if (!ops.length) return callback();

  let index = 0;

  function next() {
    if (index >= ops.length) return callback();

    const op = ops[index++];
    db.run(op.sql, op.params, err => {
      if (err) return callback(err);
      next();
    });
  }

  next();
}

function formatBlackMarketRow(row) {
  let history = [];

  try {
    history = JSON.parse(row.history || "[]");
  } catch (e) {
    history = [];
  }

  return {
    id: row.id,
    name: row.name,
    price: row.price,
    lastUpdate: row.last_update,
    nextMove: row.next_move,
    history
  };
}

function buildBlackMarketNews(assets) {
  const news = [];

  for (const asset of assets) {
    const move = Number(asset.nextMove || 0);
    const abs = Math.abs(move * 100).toFixed(1);

    if (move > 0.06) {
      news.push({
        assetId: asset.id,
        title: `${asset.name} 获神秘买盘关注`,
        text: `黑市传闻，有几路资金正在暗中扫货，${asset.name} 的下一轮波动可能偏强，市场情绪明显升温。`,
        mood: "利好",
        percent: abs
      });
    } else if (move > 0.015) {
      news.push({
        assetId: asset.id,
        title: `${asset.name} 交易热度上升`,
        text: `${asset.name} 最近成交活跃，部分黑市商队认为短期还有上行动能，但分歧仍在。`,
        mood: "偏强",
        percent: abs
      });
    } else if (move < -0.06) {
      news.push({
        assetId: asset.id,
        title: `${asset.name} 出现撤资传闻`,
        text: `有黑衣掮客称，${asset.name} 背后资金正在松动，下一轮可能承压，谨慎者已经开始离场。`,
        mood: "利空",
        percent: abs
      });
    } else if (move < -0.015) {
      news.push({
        assetId: asset.id,
        title: `${asset.name} 短期情绪转弱`,
        text: `${asset.name} 的黑市盘口略显疲态，部分买家开始观望，价格可能出现小幅回落。`,
        mood: "偏弱",
        percent: abs
      });
    } else {
      news.push({
        assetId: asset.id,
        title: `${asset.name} 暂无明显风向`,
        text: `${asset.name} 当前多空分歧不大，黑市屏幕上的波动暂时平稳，仍需等待下一轮信号。`,
        mood: "观望",
        percent: abs
      });
    }
  }

  return news.slice(0, 8);
}
function loadBlackMarketRows(callback) {
  db.all("SELECT * FROM black_market ORDER BY id ASC", [], (err, rows) => {
    if (err) return callback(err);

    const order = new Map(BLACK_MARKET_ASSETS.map((x, i) => [x.id, i]));
    rows.sort((a, b) => (order.get(a.id) || 0) - (order.get(b.id) || 0));

    callback(null, rows.map(formatBlackMarketRow));
  });
}

function ensureBlackMarket(callback) {
  db.all("SELECT * FROM black_market", [], (err, rows) => {
    if (err) return callback(err);

    const nowTime = Date.now();
    const rowMap = {};
    const ops = [];

    for (const row of rows) {
      rowMap[row.id] = row;
    }

    for (const asset of BLACK_MARKET_ASSETS) {
      if (!rowMap[asset.id]) {
        const nextMove = blackMarketRandomMove();
        const history = blackMarketHistoryPush([], asset.base, nowTime);

        ops.push({
          sql: `
            INSERT INTO black_market(id, name, price, last_update, next_move, history)
            VALUES(?,?,?,?,?,?)
          `,
          params: [asset.id, asset.name, asset.base, nowTime, nextMove, JSON.stringify(history)]
        });
      }
    }

    for (const row of rows) {
      let price = row.price;
      let lastUpdate = row.last_update;
      let nextMove = row.next_move;
      let history = [];

      try {
        history = JSON.parse(row.history || "[]");
      } catch (e) {
        history = [];
      }

      let changed = false;

      while (nowTime - lastUpdate >= BLACK_MARKET_UPDATE_MS) {
        price = blackMarketClampPrice(price * (1 + nextMove));
        lastUpdate += BLACK_MARKET_UPDATE_MS;
        history = blackMarketHistoryPush(history, price, lastUpdate);
        nextMove = blackMarketRandomMove();
        changed = true;
      }

      if (changed) {
        ops.push({
          sql: `
            UPDATE black_market
            SET price = ?, last_update = ?, next_move = ?, history = ?
            WHERE id = ?
          `,
          params: [price, lastUpdate, nextMove, JSON.stringify(history), row.id]
        });
      }
    }

    runBlackMarketOps(ops, err2 => {
      if (err2) return callback(err2);
      loadBlackMarketRows(callback);
    });
  });
}
function clearBlackMarketCache() {
  blackMarketCache = null;
  blackMarketCacheAt = 0;
}

function getBlackMarketCached(callback) {
  const current = Date.now();

  if (blackMarketCache && current - blackMarketCacheAt < BLACK_MARKET_CACHE_MS) {
    return callback(null, blackMarketCache);
  }

  ensureBlackMarket((err, assets) => {
    if (err) return callback(err);

    blackMarketCache = assets;
    blackMarketCacheAt = Date.now();

    callback(null, assets);
  });
}
function addMailToPlayer(player, title, content, reward) {
  if (!player.mails) player.mails = [];

  player.mails.unshift({
    id: "gm_mail_" + Date.now() + "_" + Math.random(),
    title: String(title || "GM 邮件").slice(0, 40),
    content: String(content || "请领取附件。").slice(0, 300),
    reward: normalizeReward(reward),
    claimed: false,
    time: new Date().toLocaleString()
  });

  player.mails = player.mails.slice(0, 200);
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
      owner_acc TEXT NOT NULL DEFAULT '',
      garrisonTeam TEXT NOT NULL DEFAULT '',
      enemy INTEGER NOT NULL DEFAULT 0,
      res TEXT NOT NULL,
      guard INTEGER NOT NULL,
      terrain TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      from_acc TEXT NOT NULL,
      from_name TEXT NOT NULL,
      to_acc TEXT NOT NULL DEFAULT '',
      to_name TEXT NOT NULL DEFAULT '',
      alliance TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS chat_rate (
      acc TEXT PRIMARY KEY,
      last_sent INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_flags (
      acc TEXT PRIMARY KEY,
      banned INTEGER NOT NULL DEFAULT 0,
      muted INTEGER NOT NULL DEFAULT 0,
      ban_reason TEXT NOT NULL DEFAULT '',
      mute_reason TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS black_market (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price INTEGER NOT NULL,
      last_update INTEGER NOT NULL,
      next_move REAL NOT NULL,
      history TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    )
  `);

  db.all("PRAGMA table_info(world_tiles)", [], (err, columns) => {
    if (err) return;
    const hasOwnerAcc = columns.some(c => c.name === "owner_acc");
    if (!hasOwnerAcc) {
      db.run("ALTER TABLE world_tiles ADD COLUMN owner_acc TEXT NOT NULL DEFAULT ''");
    }
  });
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
        sendOk(res, { player, worldSize: WORLD_SIZE });
      }
    );
  });
});

app.post("/api/login", (req, res) => {
  const { acc, pwd } = req.body || {};

  if (!acc || !pwd) {
    return sendError(res, "账号或密码不能为空");
  }

  verifyUser(acc, pwd, (err, user, message) => {
    if (err) return sendError(res, "数据库错误");
    if (!user) return sendError(res, message);
    if (user.banned) return sendError(res, "账号已被封禁：" + (user.ban_reason || "无原因"));

    const player = user.player;
    if (!player.center) player.center = randomSpawn();
if (player.center.x < 2 || player.center.y < 2 || player.center.x > WORLD_SIZE - 3 || player.center.y > WORLD_SIZE - 3) {
  player.center = randomSpawn();
}
if (!player.map) player.map = {};
player.map = {};
player.worldSize = WORLD_SIZE;

    sendOk(res, {
      name: user.name,
      player,
      worldSize: WORLD_SIZE,
      muted: user.muted,
      muteReason: user.mute_reason
    });
  });
});

app.post("/api/save", (req, res) => {
  const { acc, pwd, player } = req.body || {};

  if (!acc || !pwd || !player) {
    return sendError(res, "保存信息不完整");
  }

  verifyUser(acc, pwd, (err, user, message) => {
    if (err) return sendError(res, "数据库错误");
    if (!user) return sendError(res, message);
    if (user.banned) return sendError(res, "账号已被封禁");

    player.map = {};
    player.worldSize = WORLD_SIZE;

    savePlayer(acc, player, err2 => {
      if (err2) return sendError(res, "保存失败");
      sendOk(res);
    });
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

      const ownerAccs = [...new Set(rows.map(r => r.owner_acc).filter(Boolean))];

const sendTiles = ownerMap => {
  const tiles = {};

  for (const row of rows) {
    const ownerInfo = ownerMap[row.owner_acc] || null;

    tiles[row.id] = {
      id: row.id,
      x: row.x,
      y: row.y,
      type: row.type,
      lv: row.lv,
      owner: row.owner,
      ownerAcc: row.owner_acc,
      ownerAvatar: ownerInfo ? ownerInfo.avatar : null,
      garrisonTeam: row.garrisonTeam,
      enemy: !!row.enemy,
      res: row.res,
      guard: row.guard,
      terrain: row.terrain
    };
  }

  sendOk(res, {
    worldSize: WORLD_SIZE,
    tiles
  });
};

if (!ownerAccs.length) {
  sendTiles({});
  return;
}

db.all(
  `SELECT acc, player FROM users WHERE acc IN (${ownerAccs.map(() => "?").join(",")})`,
  ownerAccs,
  (userErr, users) => {
    if (userErr) return sendError(res, "读取占领者头像失败");

    const ownerMap = {};

    for (const userRow of users) {
      let player = {};
      try {
        player = JSON.parse(userRow.player || "{}");
      } catch (e) {
        player = {};
      }

      ownerMap[userRow.acc] = {
        avatar: player.avatar || { type: "system", value: "avatar_general_male.png" }
      };
    }

    sendTiles(ownerMap);
  }
);
    }
  );
});

function returnDefeatedGarrison(ownerAcc, teamId, callback) {
  if (!ownerAcc || !teamId) return callback();

  db.get("SELECT * FROM users WHERE acc = ?", [ownerAcc], (err, row) => {
    if (err) return callback(err);
    if (!row) return callback();

    const player = parsePlayer(row);

    if (!player.teams) player.teams = [];

    const team = player.teams.find(t => t.id === teamId);

    if (team) {
      team.status = "空闲";
      team.tile = "";
    }

    savePlayer(ownerAcc, player, callback);
  });
}
app.post("/api/world/occupy", (req, res) => {
  const { acc, pwd, tileId, garrisonTeam } = req.body || {};

  if (!acc || !pwd || !tileId) {
  return sendError(res, "占领信息不完整");
}

  verifyUser(acc, pwd, (err, user, message) => {
    if (err) return sendError(res, "数据库错误");
    if (!user) return sendError(res, message);
    if (user.banned) return sendError(res, "账号已被封禁");

    db.get("SELECT * FROM world_tiles WHERE id = ?", [tileId], (tileErr, oldTile) => {
      if (tileErr) return sendError(res, "读取旧地块失败");
      if (!oldTile) return sendError(res, "地块不存在");

      const oldOwnerAcc = oldTile.owner_acc || "";
      const oldGarrisonTeam = oldTile.garrisonTeam || "";

      const updateTile = () => {
        db.run(
          `
          UPDATE world_tiles
          SET owner = ?, owner_acc = ?, garrisonTeam = ?, enemy = 0
          WHERE id = ?
          `,
          [user.name, acc, garrisonTeam || "", tileId],
          err2 => {
            if (err2) return sendError(res, "更新地块失败");
            sendOk(res);
          }
        );
      };

      if (oldOwnerAcc && oldOwnerAcc !== acc && oldGarrisonTeam) {
        returnDefeatedGarrison(oldOwnerAcc, oldGarrisonTeam, returnErr => {
          if (returnErr) return sendError(res, "返还被击败驻守队伍失败");
          updateTile();
        });
      } else {
        updateTile();
      }
    });
  });
});

app.post("/api/world/withdraw", (req, res) => {
  const { acc, pwd, tileId } = req.body || {};

  if (!acc || !pwd || !tileId) {
    return sendError(res, "撤军信息不完整");
  }

  verifyUser(acc, pwd, (err, user, message) => {
    if (err) return sendError(res, "数据库错误");
    if (!user) return sendError(res, message);
    if (user.banned) return sendError(res, "账号已被封禁");

    db.run(
  "UPDATE world_tiles SET garrisonTeam = '' WHERE id = ? AND owner_acc = ?",
  [tileId, acc],
  err2 => {
    if (err2) return sendError(res, "撤军失败");
    sendOk(res);
  }
);
  });
});

app.post("/api/chat/send", (req, res) => {
  const { acc, pwd, channel, toAcc, text } = req.body || {};
  const finalText = cleanChatText(text);

  if (!["world", "alliance", "private"].includes(channel)) {
    return sendError(res, "聊天频道错误");
  }

  if (!finalText) {
    return sendError(res, "不能发送空消息");
  }

  verifyUser(acc, pwd, (err, user, message) => {
    if (err) return sendError(res, "数据库错误");
    if (!user) return sendError(res, message);
    if (user.banned) return sendError(res, "账号已被封禁");
    if (user.muted) return sendError(res, "账号已被禁言：" + (user.mute_reason || "无原因"));

    const current = Date.now();

    db.get("SELECT last_sent FROM chat_rate WHERE acc = ?", [acc], (rateErr, rateRow) => {
      if (rateErr) return sendError(res, "检查发言频率失败");

      if (rateRow && current - rateRow.last_sent < CHAT_COOLDOWN_MS) {
        const wait = Math.ceil((CHAT_COOLDOWN_MS - (current - rateRow.last_sent)) / 1000);
        return sendError(res, `发言太快，请 ${wait} 秒后再试`);
      }

      const sendMessage = target => {
        const alliance = channel === "alliance" ? String(user.player.alliance || "") : "";

        if (channel === "alliance" && !alliance) {
          return sendError(res, "你还没有加入同盟");
        }

        db.run(
          `
          INSERT INTO chat_messages(
            channel, from_acc, from_name, to_acc, to_name, alliance, text, created_at
          ) VALUES(?,?,?,?,?,?,?,?)
          `,
          [
            channel,
            acc,
            user.name,
            target ? target.acc : "",
            target ? target.name : "",
            alliance,
            finalText,
            current
          ],
          function (insertErr) {
            if (insertErr) return sendError(res, "发送失败");

            db.run(
              `
              INSERT INTO chat_rate(acc, last_sent)
              VALUES(?, ?)
              ON CONFLICT(acc) DO UPDATE SET last_sent = excluded.last_sent
              `,
              [acc, current],
              rateSaveErr => {
                if (rateSaveErr) return sendError(res, "更新发言频率失败");

                sendOk(res, {
                  message: {
                    id: this.lastID,
                    channel,
                    fromAcc: acc,
                    fromName: user.name,
                    toAcc: target ? target.acc : "",
                    toName: target ? target.name : "",
                    alliance,
                    text: finalText,
                    createdAt: current
                  }
                });
              }
            );
          }
        );
      };

      if (channel === "private") {
        if (!toAcc) return sendError(res, "请输入私聊对象账号");

        db.get("SELECT acc, name FROM users WHERE acc = ?", [toAcc], (targetErr, target) => {
          if (targetErr) return sendError(res, "查找私聊对象失败");
          if (!target) return sendError(res, "私聊对象不存在");
          sendMessage(target);
        });
      } else {
        sendMessage(null);
      }
    });
  });
});

app.get("/api/chat/list", (req, res) => {
  const acc = String(req.query.acc || "");
  const pwd = String(req.query.pwd || "");
  const channel = String(req.query.channel || "world");
  const afterId = Math.max(0, Number(req.query.afterId || 0));

  if (!["world", "alliance", "private"].includes(channel)) {
    return sendError(res, "聊天频道错误");
  }

  verifyUser(acc, pwd, (err, user, message) => {
    if (err) return sendError(res, "数据库错误");
    if (!user) return sendError(res, message);
    if (user.banned) return sendError(res, "账号已被封禁");

    if (channel === "world") {
      db.all(
        `
        SELECT * FROM chat_messages
        WHERE channel = 'world'
          AND id > ?
        ORDER BY id ASC
        LIMIT 80
        `,
        [afterId],
        (listErr, rows) => {
          if (listErr) return sendError(res, "读取聊天失败");
          sendOk(res, { messages: rows.map(formatChatMessage) });
        }
      );
      return;
    }

    if (channel === "alliance") {
      const alliance = String(user.player.alliance || "");

      if (!alliance) {
        return sendOk(res, { messages: [] });
      }

      db.all(
        `
        SELECT * FROM chat_messages
        WHERE channel = 'alliance'
          AND alliance = ?
          AND id > ?
        ORDER BY id ASC
        LIMIT 80
        `,
        [alliance, afterId],
        (listErr, rows) => {
          if (listErr) return sendError(res, "读取同盟聊天失败");
          sendOk(res, { messages: rows.map(formatChatMessage) });
        }
      );
      return;
    }

    db.all(
      `
      SELECT * FROM chat_messages
      WHERE channel = 'private'
        AND id > ?
        AND (from_acc = ? OR to_acc = ?)
      ORDER BY id ASC
      LIMIT 80
      `,
      [afterId, acc, acc],
      (listErr, rows) => {
        if (listErr) return sendError(res, "读取私聊失败");
        sendOk(res, { messages: rows.map(formatChatMessage) });
      }
    );
  });
});

app.post("/api/broadcast", (req, res) => {
  const { acc, pwd, text } = req.body || {};
  const finalText = String(text || "").trim().slice(0, 160);

  if (!finalText) return sendError(res, "广播内容不能为空");

  verifyUser(acc, pwd, (err, user, message) => {
    if (err) return sendError(res, "数据库错误");
    if (!user) return sendError(res, message);
    if (user.banned) return sendError(res, "账号已被封禁");

    db.run(
      "INSERT INTO announcements(text, active, created_at) VALUES(?, 1, ?)",
      [finalText, Date.now()],
      insertErr => {
        if (insertErr) return sendError(res, "发送广播失败");
        sendOk(res);
      }
    );
  });
});
app.get("/api/black-market/state", (req, res) => {
  const acc = String(req.query.acc || "");
  const pwd = String(req.query.pwd || "");

  verifyUser(acc, pwd, (err, user, message) => {
    if (err) return sendError(res, "数据库错误");
    if (!user) return sendError(res, message);
    if (user.banned) return sendError(res, "账号已被封禁");

    getBlackMarketCached((marketErr, assets) => {
      if (marketErr) return sendError(res, "读取黑市失败");

      const player = user.player;
      if (!player.res) player.res = {};
      if (player.res.元宝 == null) player.res.元宝 = 0;
      if (!player.blackMarket) player.blackMarket = { holdings: {}, avgCost: {}, trades: [] };
      if (!player.blackMarket.holdings) player.blackMarket.holdings = {};
      if (!player.blackMarket.avgCost) player.blackMarket.avgCost = {};
      if (!player.blackMarket.trades) player.blackMarket.trades = [];

      savePlayer(acc, player, saveErr => {
        if (saveErr) return sendError(res, "保存黑市数据失败");

        sendOk(res, {
          assets,
          holdings: player.blackMarket.holdings,
          avgCost: player.blackMarket.avgCost,
          trades: player.blackMarket.trades.slice(-30).reverse(),
          news: buildBlackMarketNews(assets),
          yuanbao: player.res.元宝 || 0,
          boundGold: player.res.绑定元宝 || 0,
          nextUpdateIn: Math.max(
            0,
            BLACK_MARKET_UPDATE_MS - (Date.now() - Math.max(...assets.map(a => a.lastUpdate)))
          )
        });
      });
    });
  });
});

app.post("/api/black-market/trade", (req, res) => {
  const { acc, pwd, assetId, action } = req.body || {};
  const amount = Math.max(1, Math.floor(Number(req.body?.amount || 0)));

  if (!assetId || !["buy", "sell"].includes(action) || !amount) {
    return sendError(res, "交易参数错误");
  }

  verifyUser(acc, pwd, (err, user, message) => {
    if (err) return sendError(res, "数据库错误");
    if (!user) return sendError(res, message);
    if (user.banned) return sendError(res, "账号已被封禁");

    getBlackMarketCached((marketErr, assets) => {
      if (marketErr) return sendError(res, "读取黑市失败");

      const asset = assets.find(x => x.id === assetId);
      if (!asset) return sendError(res, "产业不存在");

      const player = user.player;
      if (!player.res) player.res = {};
      if (player.res.元宝 == null) player.res.元宝 = 0;
      if (!player.blackMarket) player.blackMarket = { holdings: {}, avgCost: {}, trades: [] };
      if (!player.blackMarket.holdings) player.blackMarket.holdings = {};
      if (!player.blackMarket.avgCost) player.blackMarket.avgCost = {};
      if (!player.blackMarket.trades) player.blackMarket.trades = [];

      const cost = asset.price * amount;
      const oldQty = player.blackMarket.holdings[assetId] || 0;
      const oldAvg = player.blackMarket.avgCost[assetId] || asset.price;

      if (action === "buy") {
        if ((player.res.绑定元宝 || 0) < cost) {
          return sendError(res, "绑定元宝不足");
        }

        const newQty = oldQty + amount;
        const newAvg = Math.floor((oldQty * oldAvg + cost) / newQty);

        player.res.绑定元宝 -= cost;
        player.blackMarket.holdings[assetId] = newQty;
        player.blackMarket.avgCost[assetId] = newAvg;
      }

      if (action === "sell") {
        if (oldQty < amount) {
          return sendError(res, "持有数量不足");
        }

        const newQty = oldQty - amount;

        player.blackMarket.holdings[assetId] = newQty;
        player.res.元宝 = (player.res.元宝 || 0) + cost;

        if (newQty <= 0) {
          delete player.blackMarket.holdings[assetId];
          delete player.blackMarket.avgCost[assetId];
        }
      }

      player.blackMarket.trades.push({
        id: "trade_" + Date.now() + "_" + Math.random(),
        assetId,
        assetName: asset.name,
        action,
        amount,
        price: asset.price,
        total: cost,
        time: Date.now()
      });

      player.blackMarket.trades = player.blackMarket.trades.slice(-80);

      savePlayer(acc, player, saveErr => {
        if (saveErr) return sendError(res, "保存交易失败");

        clearBlackMarketCache();

        sendOk(res, {
          asset,
          holdings: player.blackMarket.holdings,
          avgCost: player.blackMarket.avgCost,
          trades: player.blackMarket.trades.slice(-30).reverse(),
          res: player.res
        });
      });
    });
  });
});
app.post("/api/black-market/insider", (req, res) => {
  const { acc, pwd, assetId } = req.body || {};

  if (!assetId) return sendError(res, "请选择产业");

  verifyUser(acc, pwd, (err, user, message) => {
    if (err) return sendError(res, "数据库错误");
    if (!user) return sendError(res, message);
    if (user.banned) return sendError(res, "账号已被封禁");

    getBlackMarketCached((marketErr, assets) => {
      if (marketErr) return sendError(res, "读取黑市失败");

      const asset = assets.find(x => x.id === assetId);
      if (!asset) return sendError(res, "产业不存在");

      const player = user.player;
      if (!player.res) player.res = {};
      if (player.res.元宝 == null) player.res.元宝 = 0;

      if ((player.res.元宝 || 0) < 300) {
        return sendError(res, "元宝不足，需要300元宝");
      }

      player.res.元宝 -= 300;

      const truth = Math.random() < 0.7;
      const realUp = asset.nextMove >= 0;
      const reportUp = truth ? realUp : !realUp;
      const percent = Math.abs(asset.nextMove * 100).toFixed(1);

      const text = reportUp
        ? `黑衣人低声说：我听见风声，${asset.name} 下一轮可能走强，波动约 ${percent}% 左右。${truth ? "这消息听起来很真。" : "但他说话时眼神飘了一下。"}`
        : `黑衣人压低帽檐：有人在撤，${asset.name} 下一轮可能走弱，波动约 ${percent}% 左右。${truth ? "这消息听起来很真。" : "但他说话时眼神飘了一下。"}`;

      savePlayer(acc, player, saveErr => {
        if (saveErr) return sendError(res, "保存内幕消息失败");

        sendOk(res, {
          text,
          truth,
          yuanbao: player.res.元宝
        });
      });
    });
  });
});
app.get("/api/announcement/current", (req, res) => {
  db.get(
    `
    SELECT * FROM announcements
    WHERE active = 1
    ORDER BY id DESC
    LIMIT 1
    `,
    [],
    (err, row) => {
      if (err) return sendError(res, "读取公告失败");
      sendOk(res, {
        announcement: row
          ? {
              id: row.id,
              text: row.text,
              createdAt: row.created_at
            }
          : null
      });
    }
  );
});

app.get("/api/gm/players", requireGm, (req, res) => {
  db.all(
    `
    SELECT u.acc, u.name, u.updated_at,
           f.banned, f.muted, f.ban_reason, f.mute_reason
    FROM users u
    LEFT JOIN user_flags f ON f.acc = u.acc
    ORDER BY u.updated_at DESC
    LIMIT 200
    `,
    [],
    (err, rows) => {
      if (err) return sendError(res, "读取玩家列表失败");
      sendOk(res, { players: rows });
    }
  );
});

app.get("/api/gm/player/:acc", requireGm, (req, res) => {
  const acc = req.params.acc;

  db.get(
    `
    SELECT u.*, f.banned, f.muted, f.ban_reason, f.mute_reason
    FROM users u
    LEFT JOIN user_flags f ON f.acc = u.acc
    WHERE u.acc = ?
    `,
    [acc],
    (err, row) => {
      if (err) return sendError(res, "读取玩家失败");
      if (!row) return sendError(res, "玩家不存在");

      const player = parsePlayer(row);

      sendOk(res, {
        player: {
          acc: row.acc,
          name: row.name,
          updatedAt: row.updated_at,
          banned: !!row.banned,
          muted: !!row.muted,
          banReason: row.ban_reason || "",
          muteReason: row.mute_reason || "",
          alliance: player.alliance || "",
          res: player.res || {},
          bag: player.bag || {},
          mails: player.mails || []
        }
      });
    }
  );
});

app.post("/api/gm/mail", requireGm, (req, res) => {
  const { acc, title, content, reward } = req.body || {};

  if (!acc) return sendError(res, "请输入玩家账号");
  if (!title) return sendError(res, "请输入邮件标题");

  db.get("SELECT * FROM users WHERE acc = ?", [acc], (err, row) => {
    if (err) return sendError(res, "数据库错误");
    if (!row) return sendError(res, "玩家不存在");

    const player = parsePlayer(row);

    addMailToPlayer(
      player,
      title,
      content || "GM 发放奖励，请领取附件。",
      reward || {}
    );

    savePlayer(acc, player, err2 => {
      if (err2) return sendError(res, "发送邮件失败");
      sendOk(res);
    });
  });
});

app.post("/api/gm/ban", requireGm, (req, res) => {
  const { acc, banned, reason } = req.body || {};

  if (!acc) return sendError(res, "请输入玩家账号");

  db.get("SELECT acc FROM users WHERE acc = ?", [acc], (err, row) => {
    if (err) return sendError(res, "数据库错误");
    if (!row) return sendError(res, "玩家不存在");

    db.run(
      `
      INSERT INTO user_flags(acc, banned, muted, ban_reason, mute_reason, updated_at)
      VALUES(?, ?, 0, ?, '', ?)
      ON CONFLICT(acc) DO UPDATE SET
        banned = excluded.banned,
        ban_reason = excluded.ban_reason,
        updated_at = excluded.updated_at
      `,
      [acc, banned ? 1 : 0, String(reason || ""), Date.now()],
      err2 => {
        if (err2) return sendError(res, "操作失败");
        sendOk(res);
      }
    );
  });
});

app.post("/api/gm/mute", requireGm, (req, res) => {
  const { acc, muted, reason } = req.body || {};

  if (!acc) return sendError(res, "请输入玩家账号");

  db.get("SELECT acc FROM users WHERE acc = ?", [acc], (err, row) => {
    if (err) return sendError(res, "数据库错误");
    if (!row) return sendError(res, "玩家不存在");

    db.run(
      `
      INSERT INTO user_flags(acc, banned, muted, ban_reason, mute_reason, updated_at)
      VALUES(?, 0, ?, '', ?, ?)
      ON CONFLICT(acc) DO UPDATE SET
        muted = excluded.muted,
        mute_reason = excluded.mute_reason,
        updated_at = excluded.updated_at
      `,
      [acc, muted ? 1 : 0, String(reason || ""), Date.now()],
      err2 => {
        if (err2) return sendError(res, "操作失败");
        sendOk(res);
      }
    );
  });
});

app.post("/api/gm/announcement", requireGm, (req, res) => {
  const text = String((req.body && req.body.text) || "").trim().slice(0, 160);

  if (!text) return sendError(res, "公告内容不能为空");

  db.serialize(() => {
    db.run("UPDATE announcements SET active = 0 WHERE active = 1");
    db.run(
      "INSERT INTO announcements(text, active, created_at) VALUES(?, 1, ?)",
      [text, Date.now()],
      err => {
        if (err) return sendError(res, "发布公告失败");
        sendOk(res);
      }
    );
  });
});

app.post("/api/gm/announcement/clear", requireGm, (req, res) => {
  db.run("UPDATE announcements SET active = 0 WHERE active = 1", [], err => {
    if (err) return sendError(res, "清除公告失败");
    sendOk(res);
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("山河余烬服务器已启动：http://0.0.0.0:80");
  console.log("GM 后台地址：http://服务器IP/gm.html");
  console.log("默认 GM 密钥：" + GM_KEY);
});