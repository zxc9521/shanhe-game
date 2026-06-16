const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const app = express();
const PORT = 80;

app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

const db = new sqlite3.Database(path.join(__dirname, "shanhe.db"));

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
});

function sendError(res, message) {
  res.json({ ok: false, message });
}

app.post("/api/register", (req, res) => {
  const { acc, name, pwd, player } = req.body || {};
  if (!acc || !name || !pwd || !player) return sendError(res, "注册信息不完整");

  db.get("SELECT acc FROM users WHERE acc = ?", [acc], (err, row) => {
    if (err) return sendError(res, "数据库错误");
    if (row) return sendError(res, "账号已存在");

    db.run(
      "INSERT INTO users(acc, name, pwd, player, updated_at) VALUES(?,?,?,?,?)",
      [acc, name, pwd, JSON.stringify(player), Date.now()],
      err2 => {
        if (err2) return sendError(res, "注册失败");
        res.json({ ok: true, player });
      }
    );
  });
});

app.post("/api/login", (req, res) => {
  const { acc, pwd } = req.body || {};
  if (!acc || !pwd) return sendError(res, "账号或密码不能为空");

  db.get("SELECT * FROM users WHERE acc = ?", [acc], (err, row) => {
    if (err) return sendError(res, "数据库错误");
    if (!row || row.pwd !== pwd) return sendError(res, "账号或密码错误");

    res.json({
      ok: true,
      name: row.name,
      player: JSON.parse(row.player)
    });
  });
});

app.post("/api/save", (req, res) => {
  const { acc, pwd, player } = req.body || {};
  if (!acc || !pwd || !player) return sendError(res, "保存信息不完整");

  db.get("SELECT * FROM users WHERE acc = ?", [acc], (err, row) => {
    if (err) return sendError(res, "数据库错误");
    if (!row || row.pwd !== pwd) return sendError(res, "账号验证失败");

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

app.listen(PORT, "0.0.0.0", () => {
  console.log("山河余烬服务器已启动：http://0.0.0.0:80");
});