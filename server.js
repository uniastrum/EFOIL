require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const { stringify } = require('csv-stringify/sync');

const app = express();

const bot = new Telegraf(process.env.BOT_TOKEN);
app.use(bot.webhookCallback('/secret'));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 20,
  idleTimeoutMillis: 30000
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'keyboard_cat',
  resave: false,
  saveUninitialized: false,
  cookie: {
	secure: false,
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

const userState = {};

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

    console.log('Database tables initialized');
  } catch (err) {
    console.error('Database initialization error:', err);
    process.exit(1);
  }
}

initializeDatabase();

function isAuthenticated(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  res.redirect('/login');
}

app.get('/', (req, res) => {
  res.send('Server is running');
});

app.get('/login', (req, res) => {
  res.send(`
    <form method="POST" action="/login">
      <input type="password" name="password" placeholder="Admin password" required />
      <button type="submit">Login</button>
    </form>
  `);
});

app.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    req.session.loggedIn = true;
    res.redirect('/admin');
  } else {
    res.send('Wrong password');
  }
});

app.get('/admin', isAuthenticated, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT users.id, users.username AS name, users.telegram_id, 
       STRING_AGG(devices.esp_number, ', ') AS esp_list 
FROM users 
LEFT JOIN devices ON users.id = devices.user_id 
GROUP BY users.id, users.username
    `);

    res.render('admin', {
      users: rows,
      error: req.query.error
    });
  } catch (err) {
    console.error('Admin error:', err);
    res.send('Load data error');
  }
});

app.post('/add-user', isAuthenticated, async (req, res) => {
  const { username, telegram_id } = req.body;

  try {
    const userCheck = await pool.query(
      'SELECT id FROM users WHERE telegram_id = $1',
      [telegram_id]
    );

    if (userCheck.rows.length > 0) {
      return res.redirect('/admin?error=This Telegram ID already exist');
    }

    await pool.query(
      'INSERT INTO users (username, telegram_id) VALUES ($1, $2)',
      [username, telegram_id]
    );

    res.redirect('/admin');
  } catch (err) {
    console.error('Add user error:', err);
    res.redirect('/admin?error=Error adding user');
  }
});

app.get('/history', isAuthenticated, async (req, res) => {
  const { user_id, error, success } = req.query;

  try {
    const { rows } = await pool.query(
      `SELECT command, created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Bangkok' AS created_at
       FROM commands
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [user_id]
    );

    const history = rows.map(row => {
      const formattedDate = new Date(row.created_at).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
      return `<li>${formattedDate}: ${row.command}</li>`;
    }).join('');

    let message = '';
    if (error) message = `<div style="color: red; margin-bottom: 15px;">${error}</div>`;
    if (success) message = `<div style="color: green; margin-bottom: 15px;">${success}</div>`;

    res.send(`
      <h2>История команд</h2>
      ${message}
      
      <form method="GET" action="/history-stats" style="margin: 20px 0; padding: 15px; border: 1px solid #ddd; border-radius: 5px;">
        <h3>Анализ по датам</h3>
        <input type="hidden" name="user_id" value="${user_id}">
        <label>С: <input type="date" name="start_date" required></label>
        <label>По: <input type="date" name="end_date" required></label>
        <button type="submit" style="padding: 5px 10px; background: #4CAF50; color: white; border: none; border-radius: 3px;">
          Анализировать
        </button>
      </form>

      <ul>${history}</ul>
      
      <form method="POST" action="/clear-history" style="margin-top: 20px;">
        <input type="hidden" name="user_id" value="${user_id}">
        <button type="submit" style="background-color: #ff4d4d; color: white; padding: 10px 15px; border: none; border-radius: 5px; cursor: pointer;">
          Очистить историю
        </button>
      </form>
      <a href="/admin" style="display: inline-block; margin-top: 20px;">← Назад в админку</a>
    `);
  } catch (err) {
    console.error('History error:', err);
    res.send('Ошибка загрузки истории');
  }
});


app.post('/add-device', isAuthenticated, async (req, res) => {
  const { user_id, esp_number } = req.body;

  try {
    const deviceCheck = await pool.query(
      'SELECT user_id FROM devices WHERE esp_number = $1',
      [esp_number]
    );

    if (deviceCheck.rows.length > 0) {
      return res.redirect('/admin?error=Boat already registered');
    }

    await pool.query(
      'INSERT INTO devices (user_id, esp_number) VALUES ($1, $2)',
      [user_id, esp_number]
    );

    res.redirect('/admin');
  } catch (err) {
    console.error('Add device error:', err);
    res.redirect('/admin?error=Error registering boat');
  }
});

app.post('/clear-history', isAuthenticated, async (req, res) => {
  const { user_id } = req.body;

  try {
    await pool.query(
      'DELETE FROM commands WHERE user_id = $1',
      [user_id]
    );
    
    res.redirect(`/history?user_id=${user_id}&success=History cleared successfully`);
  } catch (err) {
    console.error('Clear history error:', err);
    res.redirect(`/history?user_id=${user_id}&error=Error clearing history`);
  }
});

app.post('/delete-user', isAuthenticated, async (req, res) => {
  const { user_id } = req.body;

  try {
    await pool.query('DELETE FROM users WHERE id = $1', [user_id]);
    res.redirect('/admin');
  } catch (err) {
    console.error('Delete user error:', err);
    res.send('Error deleting user');
  }
});

app.get('/export-csv', isAuthenticated, async (req, res) => {
  const { user_id } = req.query;

  try {
    const { rows } = await pool.query(
      'SELECT command, created_at FROM commands WHERE user_id = $1 ORDER BY created_at DESC',
      [user_id]
    );

    const csv = stringify(rows, {
      header: true,
      columns: { command: 'Command', created_at: 'Created At' }
    });

    res.setHeader('Content-disposition', 'attachment; filename=command_history.csv');
    res.set('Content-Type', 'text/csv');
    res.send(csv);
  } catch (err) {
    console.error('Export CSV error:', err);
    res.status(500).send('Export error');
  }
});

app.get('/history-stats', isAuthenticated, async (req, res) => {
  const { user_id, start_date, end_date } = req.query;

  try {
    // Получаем историю команд за выбранный период
    const { rows } = await pool.query(
      `SELECT command, created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Bangkok' AS created_at
       FROM commands
       WHERE user_id = $1 
       AND created_at >= $2::timestamp 
       AND created_at <= $3::timestamp + interval '1 day'
       ORDER BY created_at DESC`,
      [user_id, start_date, end_date]
    );

    // Анализ статистики
    let totalTime = 0;
    let count30min = 0;
    let count60min = 0;
    let countOff = 0;

    rows.forEach(row => {
      if (row.command.includes('/30')) {
        totalTime += 30;
        count30min++;
      } else if (row.command.includes('/60')) {
        totalTime += 60;
        count60min++;
      } else if (row.command.includes('/off')) {
        countOff++;
      }
    });

    // Сколько раз по 30 минут в сумме
    const total30minIntervals = Math.round(totalTime / 30);

    // Формируем HTML с результатами
    const statsHTML = `
      <h3>Статистика за период: ${start_date} — ${end_date}</h3>
      <ul>
        <li>Включений на 30 мин: <strong>${count30min}</strong></li>
        <li>Включений на 60 мин: <strong>${count60min}</strong></li>
        <li>Выключений: <strong>${countOff}</strong></li>
        <li>Общее время работы: <strong>${totalTime} мин</strong></li>
        <li>Эквивалентно <strong>${total30minIntervals} × 30 мин</strong></li>
      </ul>
      <a href="/history?user_id=${user_id}" style="display: inline-block; margin-top: 20px;">← Назад к истории</a>
    `;

    res.send(statsHTML);
  } catch (err) {
    console.error('History stats error:', err);
    res.send('Ошибка при анализе статистики');
  }
});

app.post('/delete-device', isAuthenticated, async (req, res) => {
  const { user_id, esp_number } = req.body;

  try {
    await pool.query(
      'DELETE FROM devices WHERE user_id = $1 AND esp_number = $2',
      [user_id, esp_number]
    );
    res.redirect('/admin');
  } catch (err) {
    console.error('Delete device error:', err);
    res.send('Error deleting boat');
  }
});

const PORT = process.env.PORT || 8080;
app.listen(8080, '0.0.0.0', () => {
  console.log('Server running on port 8080');
});

process.once('SIGINT', async () => {
  await bot.stop('SIGINT');
  await pool.end();
  process.exit(0);
});

process.once('SIGTERM', async () => {
  await bot.stop('SIGTERM');
  await pool.end();
  process.exit(0);
});

// Telegram bot handlers
bot.start(async (ctx) => {
  await handleStart(ctx);
});

bot.on('message', async (ctx) => {
  await handleStart(ctx);
});

async function handleStart(ctx) {
  const telegramId = String(ctx.from.id);

  try {
    const userResult = await pool.query(
      'SELECT id, username FROM users WHERE telegram_id = $1',
      [telegramId]
    );

    if (userResult.rows.length === 0) {
      return ctx.reply('You are not rigistred. No money - no honney!');
    }

    const userId = userResult.rows[0].id;

    const deviceResult = await pool.query(
      'SELECT esp_number FROM devices WHERE user_id = $1',
      [userId]
    );

    if (deviceResult.rows.length === 0) {
      return ctx.reply('You are no have rigistred boats');
    }

    const deviceButtons = deviceResult.rows.map((row) => [
      Markup.button.callback(`Boat ${row.esp_number}`, `select_device:${row.esp_number}`)
    ]);

    ctx.reply('Choose boat:', Markup.inlineKeyboard(deviceButtons));
  } catch (err) {
    console.error('Telegram message error:', err);
    ctx.reply('Error.');
  }
}

bot.action(/select_device:(.+)/, async (ctx) => {
  const espNumber = ctx.match[1];
  const telegramId = String(ctx.from.id);

  userState[telegramId] = { espNumber };

  await ctx.answerCbQuery();
  ctx.reply(`Boat control ${espNumber}`, Markup.inlineKeyboard([
    [
      Markup.button.callback('30 min', 'send_command:/30'),
      Markup.button.callback('60 min', 'send_command:/60')
    ],
    [Markup.button.callback('Turn off', 'send_command:/off')]
  ]));
});

bot.action(/send_command:(.+)/, async (ctx) => {
  const command = ctx.match[1];
  const telegramId = String(ctx.from.id);

  const state = userState[telegramId];
  if (!state || !state.espNumber) {
    return ctx.reply('Choose boat at first.');
  }

  try {
    const userResult = await pool.query(
      'SELECT id FROM users WHERE telegram_id = $1',
      [telegramId]
    );

    if (userResult.rows.length === 0) {
      return ctx.reply('You are not registred.');
    }

    const userId = userResult.rows[0].id;
    const fullCommand = `${state.espNumber}${command}`;

    await pool.query(
  'INSERT INTO commands (user_id, command, processed, esp_number) VALUES ($1, $2, 0, $3)',
  [userId, fullCommand, state.espNumber]
);


    ctx.reply(`Command ${fullCommand} sended.`);
  } catch (err) {
    console.error('Send command error:', err);
    ctx.reply('Send command error.');
  }
});

app.get('/get_command', async (req, res) => {
  const { esp } = req.query;

  if (!esp) {
    return res.status(400).send('Missing esp parameter');
  }

  try {
    const deviceResult = await pool.query(
      'SELECT user_id FROM devices WHERE esp_number = $1',
      [esp]
    );

    if (deviceResult.rows.length === 0) {
      return res.status(404).send('Unknown ESP number');
    }

    const userId = deviceResult.rows[0].user_id;

    const commandResult = await pool.query(
  `SELECT id, command FROM commands 
   WHERE user_id = $1 AND processed = 0 AND esp_number = $2 
   ORDER BY created_at ASC LIMIT 1`,
  [userId, esp]
);


    if (commandResult.rows.length === 0) {
      return res.send('NO_COMMAND');
    }

    const { id, command } = commandResult.rows[0];

    // Обновим статус processed = 1
    await pool.query(
      'UPDATE commands SET processed = 1 WHERE id = $1',
      [id]
    );

    res.send(command);
  } catch (err) {
    console.error('Error in /get_command:', err);
    res.status(500).send('Server error');
  }
});
