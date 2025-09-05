// server.js
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const { stringify } = require('csv-stringify/sync');

const app = express();

// ---------- Telegram Bot ----------
if (!process.env.BOT_TOKEN) {
  console.error('BOT_TOKEN is not set');
  process.exit(1);
}
const bot = new Telegraf(process.env.BOT_TOKEN);

// Вариант 1: webhook через Express (Render/другие PaaS)
app.use(bot.webhookCallback('/secret'));

// Вариант 2: long polling, если BASE_URL нет
async function ensureBotTransport() {
  if (process.env.BASE_URL) {
    const url = `${process.env.BASE_URL.replace(/\/+$/,'')}/secret`;
    await bot.telegram.setWebhook(url);
    console.log('Telegram webhook set to:', url);
  } else {
    await bot.telegram.deleteWebhook();
    await bot.launch();
    console.log('Telegram long polling started');
  }
}

// ---------- БД ----------
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

// ---------- Express ----------
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

if (!process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET is not set');
  process.exit(1);
}
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// ---------- Инициализация схемы ----------
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT,
        telegram_id TEXT UNIQUE
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS devices (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        esp_number TEXT UNIQUE
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS commands (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        command TEXT,
        processed INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Колонки, которых могло не быть
    await pool.query(`ALTER TABLE commands ADD COLUMN IF NOT EXISTS esp_number TEXT`);
    await pool.query(`ALTER TABLE commands ADD COLUMN IF NOT EXISTS processed_at TIMESTAMP`);

    console.log('Database tables initialized');
  } catch (err) {
    console.error('Database initialization error:', err);
    process.exit(1);
  }
}

// ---------- Утилиты ----------
function isAuthenticated(req, res, next) {
  if (req.session.loggedIn) return next();
  return res.redirect('/login');
}
function tzBangkok(dt) {
  // Красиво отображаем дату в Asia/Bangkok
  try {
    return new Date(dt).toLocaleString('ru-RU', { timeZone: 'Asia/Bangkok' });
  } catch {
    return new Date(dt).toISOString().replace('T',' ').replace('Z','');
  }
}

// ---------- Маршруты ----------
app.get('/', (req, res) => {
  res.send('OK');
});

app.get('/login', (req, res) => {
  res.send(`
    <form method="POST" action="/login" style="max-width:340px;margin:2rem auto;font-family:sans-serif">
      <h3>Admin Login</h3>
      <input type="password" name="password" placeholder="Admin password" required style="width:100%;padding:.5rem;margin:.25rem 0"/>
      <button type="submit" style="padding:.5rem 1rem">Login</button>
    </form>
  `);
});

app.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    req.session.loggedIn = true;
    return res.redirect('/admin');
  }
  res.send('Wrong password');
});

app.get('/admin', isAuthenticated, async (req, res) => {
  try {
    const users = await pool.query(`
      SELECT u.id, u.name, u.telegram_id, COALESCE(string_agg(d.esp_number, ', '), '') AS esp_list
      FROM users u
      LEFT JOIN devices d ON u.id = d.user_id
      GROUP BY u.id
      ORDER BY u.id
    `);

    const devices = await pool.query(`
      SELECT d.id, d.esp_number, u.name AS user_name, u.id as user_id
      FROM devices d
      JOIN users u ON u.id = d.user_id
      ORDER BY d.id
    `);

    const usersOptions = (await pool.query(`SELECT id, name FROM users ORDER BY id`)).rows
      .map(u => `<option value="${u.id}">${u.id}. ${u.name || '(no name)'}</option>`).join('');

    res.send(`
<!doctype html>
<html><head><meta charset="utf-8"><title>Admin</title></head>
<body style="font-family:sans-serif;max-width:900px;margin:24px auto">
  <h2>Users</h2>
  <table border="1" cellpadding="6" cellspacing="0">
    <tr><th>ID</th><th>Name</th><th>Telegram</th><th>ESP</th><th>Actions</th></tr>
    ${users.rows.map(r => `
      <tr>
        <td>${r.id}</td>
        <td>${r.name || ''}</td>
        <td>${r.telegram_id || ''}</td>
        <td>${r.esp_list || ''}</td>
        <td>
          <form method="GET" action="/history" style="display:inline">
            <input type="hidden" name="user_id" value="${r.id}"/>
            <button>History</button>
          </form>
          <form method="POST" action="/delete-user" style="display:inline" onsubmit="return confirm('Delete user?')">
            <input type="hidden" name="user_id" value="${r.id}"/>
            <button>Delete</button>
          </form>
        </td>
      </tr>`).join('')}
  </table>

  <h3>Add user</h3>
  <form method="POST" action="/add-user">
    <input name="name" placeholder="Name" required/>
    <input name="telegram_id" placeholder="Telegram ID (numeric)" required/>
    <button>Add</button>
  </form>

  <h2>Devices</h2>
  <table border="1" cellpadding="6" cellspacing="0">
    <tr><th>ID</th><th>ESP</th><th>User</th><th>Actions</th></tr>
    ${devices.rows.map(r => `
      <tr>
        <td>${r.id}</td>
        <td>${r.esp_number}</td>
        <td>${r.user_name || ''}</td>
        <td>
          <form method="POST" action="/delete-device" style="display:inline" onsubmit="return confirm('Delete device?')">
            <input type="hidden" name="device_id" value="${r.id}"/>
            <button>Delete</button>
          </form>
        </td>
      </tr>`).join('')}
  </table>

  <h3>Add device</h3>
  <form method="POST" action="/add-device">
    <select name="user_id" required>${usersOptions}</select>
    <input name="esp_number" placeholder="ESP number, e.g. 1" required/>
    <button>Add</button>
  </form>

</body></html>`);
  } catch (err) {
    console.error('Admin page error:', err);
    res.status(500).send('Admin error');
  }
});

app.post('/add-user', isAuthenticated, async (req, res) => {
  const { name, telegram_id } = req.body;
  try {
    const dupl = await pool.query('SELECT id FROM users WHERE telegram_id = $1', [telegram_id]);
    if (dupl.rows.length) return res.send('This Telegram ID already exists');
    await pool.query('INSERT INTO users(name, telegram_id) VALUES($1,$2)', [name, String(telegram_id)]);
    res.redirect('/admin');
  } catch (e) {
    console.error('Add user error:', e);
    res.status(500).send('Add user error');
  }
});

app.post('/delete-user', isAuthenticated, async (req, res) => {
  const { user_id } = req.body;
  try {
    await pool.query('DELETE FROM users WHERE id = $1', [user_id]);
    res.redirect('/admin');
  } catch (e) {
    console.error('Delete user error:', e);
    res.status(500).send('Delete user error');
  }
});

app.post('/add-device', isAuthenticated, async (req, res) => {
  const { user_id, esp_number } = req.body;
  try {
    await pool.query('INSERT INTO devices(user_id, esp_number) VALUES($1,$2)', [user_id, String(esp_number)]);
    res.redirect('/admin');
  } catch (e) {
    console.error('Add device error:', e);
    res.status(500).send('Add device error');
  }
});

app.post('/delete-device', isAuthenticated, async (req, res) => {
  const { device_id } = req.body;
  try {
    await pool.query('DELETE FROM devices WHERE id = $1', [device_id]);
    res.redirect('/admin');
  } catch (e) {
    console.error('Delete device error:', e);
    res.status(500).send('Delete device error');
  }
});

app.get('/history', isAuthenticated, async (req, res) => {
  const { user_id } = req.query;
  try {
    const { rows } = await pool.query(`
      SELECT command, esp_number, processed, created_at, processed_at
      FROM commands
      WHERE user_id = $1
      ORDER BY created_at DESC
    `, [user_id]);

    const list = rows.map(r => {
      const created = tzBangkok(r.created_at);
      const status = r.processed
        ? `<span style="color:green">✔ выполнена ${r.processed_at ? tzBangkok(r.processed_at) : ''}</span>`
        : `<span style="color:#e69500">⏳ ожидает</span>`;
      const espInfo = r.esp_number ? ` <small>(ESP ${r.esp_number})</small>` : '';
      return `<li>${created}: ${r.command}${espInfo} — ${status}</li>`;
    }).join('');

    res.send(`
<!doctype html><html><head><meta charset="utf-8"><title>History</title></head>
<body style="font-family:sans-serif;max-width:900px;margin:24px auto">
  <h2>History (user ${user_id})</h2>
  <p>
    <a href="/export-csv?user_id=${user_id}">Export CSV</a> |
    <form method="POST" action="/clear-history" style="display:inline" onsubmit="return confirm('Clear?')">
      <input type="hidden" name="user_id" value="${user_id}"/>
      <button>Clear history</button>
    </form>
  </p>
  <ol>${list}</ol>
  <p><a href="/admin">← back</a></p>
</body></html>`);
  } catch (e) {
    console.error('History error:', e);
    res.status(500).send('History error');
  }
});

app.post('/clear-history', isAuthenticated, async (req, res) => {
  const { user_id } = req.body;
  try {
    await pool.query('DELETE FROM commands WHERE user_id = $1', [user_id]);
    res.redirect(`/history?user_id=${user_id}`);
  } catch (e) {
    console.error('Clear history error:', e);
    res.status(500).send('Clear error');
  }
});

app.get('/export-csv', isAuthenticated, async (req, res) => {
  const { user_id } = req.query;
  try {
    const { rows } = await pool.query(`
      SELECT command, esp_number, processed,
             to_char(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Bangkok','YYYY-MM-DD HH24:MI:SS') AS created_at,
             to_char(processed_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Bangkok','YYYY-MM-DD HH24:MI:SS') AS processed_at
      FROM commands
      WHERE user_id = $1
      ORDER BY created_at DESC
    `, [user_id]);

    const csv = stringify(rows, { header: true });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="history_user_${user_id}.csv"`);
    res.send(csv);
  } catch (e) {
    console.error('Export CSV error:', e);
    res.status(500).send('Export error');
  }
});

// ---------- Отдача команды ESP ----------
app.get('/get_command', async (req, res) => {
  const { esp } = req.query;
  if (!esp) return res.status(400).send('Missing esp parameter');

  try {
    //Находим владельца устройства по esp_number
    const deviceResult = await pool.query(
      'SELECT user_id FROM devices WHERE esp_number = $1',
      [String(esp)]
    );
    if (deviceResult.rows.length === 0) return res.status(404).send('Unknown ESP number');

    const userId = deviceResult.rows[0].user_id;

    // Берём самую раннюю НЕобработанную команду для этого юзера/ESP
    const commandResult = await pool.query(
      `SELECT id, command FROM commands
       WHERE user_id = $1 AND processed = 0 AND (esp_number = $2 OR esp_number IS NULL OR esp_number = '')
       ORDER BY created_at ASC
       LIMIT 1`,
      [userId, String(esp)]
    );

    if (commandResult.rows.length === 0) {
      return res.send('NO_COMMAND');
    }

    const { id, command } = commandResult.rows[0];

    // Ставим processed=1 и время
    await pool.query(
      'UPDATE commands SET processed = 1, processed_at = CURRENT_TIMESTAMP WHERE id = $1',
      [id]
    );

    // Шлём уведомление в Telegram владельцу
    try {
      const userRow = await pool.query(
        'SELECT u.telegram_id FROM users u WHERE u.id = $1',
        [userId]
      );
      const tg = userRow.rows[0]?.telegram_id;
      if (tg) {
        await bot.telegram.sendMessage(
          String(tg),
          `✅ Команда для ESP ${esp} принята устройством: ${command}`
        );
      }
    } catch (tgErr) {
      console.error('Telegram notify error:', tgErr);
    }

    return res.send(command);
  } catch (err) {
    console.error('Error in /get_command:', err);
    res.status(500).send('Server error');
  }
});

// ---------- Telegram: обработка входа ----------
bot.start(async (ctx) => {
  await handleMessage(ctx);
});

bot.on('message', async (ctx) => {
  await handleMessage(ctx);
});

// Простой обработчик: принимаем сообщения вида "1/30", "1/60", "1/off"
async function handleMessage(ctx) {
  const telegramId = String(ctx.from.id);
  const text = (ctx.message?.text || '').trim();

  // Находим/проверяем пользователя
  const userResult = await pool.query('SELECT id, name FROM users WHERE telegram_id = $1', [telegramId]);
  if (userResult.rows.length === 0) {
    return ctx.reply('Вы не зарегистрированы.');
  }
  const userId = userResult.rows[0].id;

  // Пытаемся распарсить команду
  const m = text.match(/^(\d+)\s*\/\s*(off|\d+)$/i);
  if (!m) {
    return ctx.reply('Пришлите команду в формате: 1/30, 1/60 или 1/off');
  }
  const espNumber = m[1];
  const right = m[2].toLowerCase();
  const norm = `${espNumber}/${right}`;

  // Сохраняем
  await pool.query(
    'INSERT INTO commands(user_id, command, processed, esp_number) VALUES($1,$2,0,$3)',
    [userId, norm, espNumber]
  );

  return ctx.reply(`Команда добавлена: ${norm}`);
}

// ---------- Старт ----------
async function main() {
  await initializeDatabase();
  await ensureBotTransport();

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log('HTTP server on', PORT));
}
main().catch(err => {
  console.error('Fatal start error:', err);
  process.exit(1);
});

// Корректное завершение
process.once('SIGINT', async () => {
  try { await bot.stop('SIGINT'); } catch {}
  try { await pool.end(); } catch {}
  process.exit(0);
});
process.once('SIGTERM', async () => {
  try { await bot.stop('SIGTERM'); } catch {}
  try { await pool.end(); } catch {}
  process.exit(0);
});
