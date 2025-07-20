require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { Telegraf, Markup } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { stringify } = require('csv-stringify/sync');
const userState = {};

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
  const { user_id, error, success } = req.query;
  db.all("SELECT command, created_at FROM commands WHERE user_id = ? ORDER BY created_at DESC", [user_id], (err, rows) => {
    if (err) return res.send('Ошибка при получении истории');
    
    const history = rows.map(c => `<li>${c.created_at}: ${c.command}</li>`).join('');
    
    let message = '';
    if (error) {
      message = `<div style="color: red; margin-bottom: 15px;">${error}</div>`;
    } else if (success) {
      message = `<div style="color: green; margin-bottom: 15px;">${success}</div>`;
    }

    res.send(`
      <h2>История команд</h2>
      ${message}
      <ul>${history}</ul>
      <form method="POST" action="/clear-history" style="margin-top: 20px;">
        <input type="hidden" name="user_id" value="${user_id}">
        <button type="submit" style="background-color: #ff4d4d; color: white; padding: 10px 15px; border: none; border-radius: 5px; cursor: pointer;">
          Очистить историю
        </button>
      </form>
      <a href="/admin" style="display: inline-block; margin-top: 20px;">Назад</a>
    `);
  });
});

app.post('/clear-history', isAuthenticated, (req, res) => {
  const { user_id } = req.body;
  db.run("DELETE FROM commands WHERE user_id = ?", [user_id], function(err) {
    if (err) {
      console.error('Ошибка при очистке истории:', err);
      return res.redirect(`/history?user_id=${user_id}&error=Ошибка при очистке истории`);
    }
    
    console.log(`История очищена для пользователя ID: ${user_id}, удалено ${this.changes} записей`);
    res.redirect(`/history?user_id=${user_id}&success=История успешно очищена`);
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

// Функция для отображения списка лодок пользователя
function showBoatSelection(ctx, userId, fromId) {
  db.all("SELECT esp_number FROM devices WHERE user_id = ?", [userId], (err, devices) => {
    if (err || !devices.length) {
      return ctx.reply('У вас нет зарегистрированных лодок. Обратитесь к администратору.');
    }
    
    // Создаем кнопки для выбора лодки
    const buttons = devices.map(device => 
      Markup.button.callback(`Лодка ${device.esp_number}`, `select_boat_${device.esp_number}`)
    );
    
    ctx.reply('Выберите лодку:', Markup.inlineKeyboard(buttons, { columns: 3 }));
  });
}

// Telegram Bot с inline-кнопками
bot.command('start', (ctx) => {
  const fromId = ctx.message.from.id.toString();
  
  db.get("SELECT id FROM users WHERE telegram_id = ?", [fromId], (err, user) => {
    if (err || !user) {
      return ctx.reply('Вы не зарегистрированы. Обратитесь к администратору.');
    }
    
    // Используем функцию для показа лодок
    showBoatSelection(ctx, user.id, fromId);
  });
});

// Обработка выбора лодки
bot.action(/select_boat_(\d+)/, (ctx) => {
  const fromId = ctx.from.id.toString();
  const espNumber = ctx.match[1];
  
  db.get("SELECT id FROM users WHERE telegram_id = ?", [fromId], (err, user) => {
    if (err || !user) return ctx.answerCbQuery('Ошибка: пользователь не найден');
    
    // Проверяем, что лодка принадлежит пользователю
    db.get("SELECT * FROM devices WHERE user_id = ? AND esp_number = ?", [user.id, espNumber], (err, device) => {
      if (err || !device) return ctx.answerCbQuery('Ошибка: лодка не найдена');
      
      userState[fromId] = { stage: 'awaiting_command', esp: espNumber };
      
      // Кнопки для выбора команды (3 в одну линию)
      ctx.editMessageText(
        `Лодка ${espNumber}: выберите действие`,
        Markup.inlineKeyboard([
          Markup.button.callback('30 мин', `command_30_${espNumber}`),
          Markup.button.callback('60 мин', `command_60_${espNumber}`),
          Markup.button.callback('Выключить', `command_off_${espNumber}`)
        ], { columns: 3 })
      );
    });
  });
});

// Обработка выбора команды
bot.action(/command_(30|60|off)_(\d+)/, (ctx) => {
  const fromId = ctx.from.id.toString();
  const command = ctx.match[1];
  const espNumber = ctx.match[2];
  
  db.get("SELECT id FROM users WHERE telegram_id = ?", [fromId], (err, user) => {
    if (err || !user) return ctx.answerCbQuery('Ошибка: пользователь не найден');
    
    const userId = user.id;
    const finalCommand = `ESP${espNumber}: ${command}`;
    
    db.run("INSERT INTO commands (user_id, command) VALUES (?, ?)", [userId, finalCommand], (err) => {
      if (err) return ctx.answerCbQuery('Ошибка при сохранении команды');
      
      userState[fromId] = null; // сброс состояния
      ctx.editMessageText(`✅ Команда "${finalCommand}" принята`);
    });
  });
});

// Текстовая команда /boatX с показом кнопок
bot.on('text', (ctx) => {
  const fromId = ctx.message.from.id.toString();
  const text = ctx.message.text.trim().toLowerCase();

  db.get("SELECT id FROM users WHERE telegram_id = ?", [fromId], (err, user) => {
    if (err || !user) {
      return ctx.reply('Вы не зарегистрированы. Обратитесь к администратору.');
    }

    const userId = user.id;

    const boatMatch = text.match(/^\/?boat(\d{1,3})$/);
    if (boatMatch) {
      const espNumber = boatMatch[1];

      db.get("SELECT * FROM devices WHERE user_id = ? AND esp_number = ?", [userId, espNumber], (err, device) => {
        if (err || !device) {
          return ctx.reply('Неправильный номер лодки');
        }

        // Показываем кнопки команд вместо текста
        ctx.reply(
          `Лодка ${espNumber}: выберите действие`,
          Markup.inlineKeyboard([
            Markup.button.callback('30 мин', `command_30_${espNumber}`),
            Markup.button.callback('60 мин', `command_60_${espNumber}`),
            Markup.button.callback('Выключить', `command_off_${espNumber}`)
          ], { columns: 3 })
        );
      });

    } else if (userState[fromId] && userState[fromId].stage === 'awaiting_command') {
      const command = text;

      if (!['30', '60', 'off'].includes(command)) {
        return ctx.reply('Неверная команда. Используйте 30, 60 или off');
      }

      const espNumber = userState[fromId].esp;
      const finalCommand = `ESP${espNumber}: ${command}`;

      db.run("INSERT INTO commands (user_id, command) VALUES (?, ?)", [userId, finalCommand], (err) => {
        if (err) {
          return ctx.reply('Ошибка при сохранении команды');
        }

        userState[fromId] = null;
        return ctx.reply('Команда принята');
      });

    } else {
      // Для любой нераспознанной команды показываем список лодок
      showBoatSelection(ctx, userId, fromId);
    }
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