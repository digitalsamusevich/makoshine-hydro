const Database = require("better-sqlite3");

const db = new Database("bot-stats.db");

db.prepare(`
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  username TEXT,
  command TEXT,
  chat_id INTEGER,
  timestamp TEXT
)
`).run();

function logUsage(msg) {

  if (!msg || !msg.from) return;

  const command = msg.text || "unknown";

  db.prepare(`
    INSERT INTO usage
    (user_id, username, command, chat_id, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    msg.from.id,
    msg.from.username || "",
    command,
    msg.chat.id,
    new Date().toISOString()
  );

}

module.exports = { logUsage };
