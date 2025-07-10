process.env.NTBA_FIX_319 = "1";
require('dotenv').config();

const { Telegraf } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');

// Инициализация приложения
const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);

// Конфигурация БД
const db = new sqlite3.Database(process.env.DB_PATH || '/tmp/commands.db', (err) => {
  if (err) {
    console.error('Database connection error:', err);
    process.exit(1);
  }
  console.log('Connected to SQLite database');
});

// Мидлвари
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET');
  next();
});

// Инициализация таблицы
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS commands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      command TEXT NOT NULL,
      duration INTEGER,
      processed BOOLEAN DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// Обработчики бота
bot.use((ctx, next) => {
  const allowedChats = process.env.ALLOWED_CHAT_IDS?.split(',') || ['581227168'];
  if (ctx.message && !allowedChats.includes(String(ctx.message.chat.id))) {
    console.warn(`Unauthorized access from: ${ctx.message.chat.id}`);
    return ctx.reply('⛔ Доступ запрещен!');
  }
  return next();
});

bot.command('relay_on', async (ctx) => {
  try {
    const duration = parseInt(ctx.message.text.split(' ')[1]);
    
    // ИСПРАВЛЕННАЯ ПРОВЕРКА
    if (isNaN(duration)) {
      throw new Error('Invalid duration');
    }
    
    await new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO commands (chat_id, command, duration) VALUES (?, ?, ?)',
        [ctx.message.chat.id, 'relay_on', duration],
        function(err) {
          if (err) return reject(err);
          console.log(`Command added. ID: ${this.lastID}`);
          resolve();
        }
      );
    });
    
    await ctx.reply(`✅ Реле будет включено на ${duration} секунд`);
  } catch (err) {
    console.error('relay_on error:', err);
    await ctx.reply('❌ Используйте: /relay_on <секунды>');
  }
});

bot.command('relay_off', async (ctx) => {
  try {
    await new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO commands (chat_id, command) VALUES (?, ?)',
        [ctx.message.chat.id, 'relay_off'],
        (err) => err ? reject(err) : resolve()
      );
    });
    await ctx.reply('✅ Реле будет выключено');
  } catch (err) {
    console.error('relay_off error:', err);
    await ctx.reply('❌ Ошибка команды');
  }
});

// API для ESP32
app.get('/get_command', (req, res) => {
  console.log('Request from:', req.ip);
  
  db.get(
    `SELECT * FROM commands 
     WHERE processed = 0 
     ORDER BY created_at 
     LIMIT 1`,
    (err, row) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      
      if (row) {
        db.run('UPDATE commands SET processed = 1 WHERE id = ?', row.id);
        res.json({
          command: row.command,
          duration: row.duration || 0
        });
      } else {
        res.status(404).json({ command: null });
      }
    }
  );
});

// Health check
app.get('/health', (req, res) => {
  db.get('SELECT 1', (err) => {
    res.json({
      status: err ? 'ERROR' : 'OK',
      db: err ? 'disconnected' : 'connected',
      time: new Date().toISOString()
    });
  });
});

// Корневой маршрут
app.get('/', (req, res) => {
  res.send('Telegram Bot API is running');
});

// Обработка ошибок
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Запуск сервера
const PORT = process.env.PORT || 10000;

const start = async () => {
  try {
    await bot.launch();
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Bot @${bot.options.username} started`);
    });
  } catch (err) {
    console.error('Startup failed:', err);
    process.exit(1);
  }
};

// Graceful shutdown
process.once('SIGINT', () => {
  bot.stop('SIGINT');
  db.close();
  process.exit();
});

process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
  db.close();
  process.exit();
});

start();
