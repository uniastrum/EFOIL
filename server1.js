require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { Telegraf } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { stringify } = require('csv-stringify/sync');

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'keyboard_cat',
  resave: false,
  saveUninitialized: false
}));

const db = new sqlite3.Database(process.env.DB_PATH || './commands.db', (err) => {
  if (err) {
    console.error('Database error:', err);
    process.exit(1);
  }
  console.log('Connected to SQLite database');
  db.run("PRAGMA foreign_keys = ON;");
});

// Создание таблиц с UNIQUE ограничением для esp_number
db.run(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  telegram_id TEXT UNIQUE
)`);

db.run(`CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  esp_number TEXT UNIQUE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
)`);

db.run(`CREATE TABLE IF NOT EXISTS commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  command TEXT,
  processed INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
)`);

function isAuthenticated(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  res.redirect('/login');
}

// Маршруты
app.get('/', (req, res) => {
  res.send('Server is running');
});

app.get('/login', (req, res) => {
  res.send(`
    <form method="POST" action="/login">
      <input type="password" name="password" placeholder="Пароль администратора" required />
      <button type="submit">Войти</button>
    </form>
  `);
});

app.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    req.session.loggedIn = true;
    res.redirect('/admin');
  } else {
    res.send('Неверный пароль');
  }
});

app.get('/admin', isAuthenticated, (req, res) => {
  db.all(`SELECT users.id, users.name, users.telegram_id, GROUP_CONCAT(devices.esp_number, ', ') AS esp_list 
          FROM users LEFT JOIN devices ON users.id = devices.user_id GROUP BY users.id`, (err, rows) => {
    if (err) return res.send('Ошибка загрузки данных');
    res.render('admin', { 
      users: rows,
      error: req.query.error
    });
  });
});

app.post('/add-user', isAuthenticated, (req, res) => {
  const { name, telegram_id } = req.body;
  
  db.get("SELECT id FROM users WHERE telegram_id = ?", [telegram_id], (err, row) => {
    if (err) return res.redirect('/admin?error=Ошибка проверки пользователя');
    if (row) return res.redirect('/admin?error=Пользователь с таким Telegram ID уже существует');

    db.run("INSERT INTO users (name, telegram_id) VALUES (?, ?)", [name, telegram_id], (err) => {
      if (err) return res.redirect('/admin?error=Ошибка добавления пользователя');
      res.redirect('/admin');
    });
  });
});

app.get('/history', isAuthenticated, (req, res) => {
  const { user_id } = req.query;
  db.all("SELECT command, created_at FROM commands WHERE user_id = ? ORDER BY created_at DESC", [user_id], (err, rows) => {
    if (err) return res.send('Ошибка при получении истории');
    const history = rows.map(c => `<li>${c.created_at}: ${c.command}</li>`).join('');
    res.send(`
      <h2>Command history</h2>
      <ul>${history}</ul>
      <a href="/admin">back</a>
    `);
  });
});

app.get('/export-csv', isAuthenticated, (req, res) => {
  const { user_id } = req.query;
  db.all('SELECT command, created_at FROM commands WHERE user_id = ? ORDER BY created_at DESC', [user_id], (err, rows) => {
    if (err) return res.status(500).send('Ошибка при экспорте');
    const csv = stringify(rows, { header: true, columns: { command: 'Command', created_at: 'Created At' } });
    res.setHeader('Content-disposition', 'attachment; filename=command_history.csv');
    res.set('Content-Type', 'text/csv');
    res.send(csv);
  });
});

app.post('/edit-user', isAuthenticated, (req, res) => {
  const { user_id, new_name, new_telegram_id } = req.body;
  db.run("UPDATE users SET name = ?, telegram_id = ? WHERE id = ?", [new_name, new_telegram_id, user_id], (err) => {
    if (err) return res.send('Ошибка обновления');
    res.redirect('/admin');
  });
});

app.post('/delete-user', isAuthenticated, (req, res) => {
  const { user_id } = req.body;
  db.run("DELETE FROM users WHERE id = ?", [user_id], (err) => {
    if (err) return res.send('Ошибка удаления');
    res.redirect('/admin');
  });
});

app.post('/add-device', isAuthenticated, (req, res) => {
  const { user_id, esp_number } = req.body;
  
  db.get("SELECT user_id FROM devices WHERE esp_number = ?", [esp_number], (err, row) => {
    if (err) return res.redirect('/admin?error=Ошибка проверки устройства');
    if (row) return res.redirect('/admin?error=Устройство с таким номером уже зарегистрировано');

    db.run("INSERT INTO devices (user_id, esp_number) VALUES (?, ?)", [user_id, esp_number], (err) => {
      if (err) {
        if (err.errno === 19) {
          return res.redirect('/admin?error=Устройство с таким номером уже существует');
        }
        return res.redirect('/admin?error=Ошибка добавления устройства');
      }
      res.redirect('/admin');
    });
  });
});

app.post('/delete-device', isAuthenticated, (req, res) => {
  const { user_id, esp_number } = req.body;
  db.run("DELETE FROM devices WHERE user_id = ? AND esp_number = ?", [user_id, esp_number], (err) => {
    if (err) return res.send('Ошибка удаления устройства');
    res.redirect('/admin');
  });
});

// Telegram Bot
bot.on('text', (ctx) => {
  const fromId = ctx.message.from.id.toString();
  const text = ctx.message.text;

  db.get("SELECT id FROM users WHERE telegram_id = ?", [fromId], (err, user) => {
    if (err || !user) return ctx.reply('Вы не зарегистрированы. Обратитесь к администратору.');
    db.run("INSERT INTO commands (user_id, command) VALUES (?, ?)", [user.id, text], (err) => {
      if (err) return ctx.reply('Ошибка при добавлении команды');
      ctx.reply('Команда получена и поставлена в очередь');
    });
  });
});

// Запуск сервера
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  bot.launch().then(() => console.log('Bot started')).catch(err => console.error('Bot error:', err));
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));