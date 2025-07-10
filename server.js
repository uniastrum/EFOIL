process.env.NTBA_FIX_319 = "1";
require('dotenv').config();

const { Telegraf } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();

// Исправленный путь к БД с учетом временной файловой системы Render
const db = new sqlite3.Database(process.env.DB_PATH || '/tmp/commands.db');

// Улучшенная обработка ошибок БД
db.on('error', (err) => {
  console.error('Database error:', err);
  // Можно добавить автоматическое восстановление
});

// Создание таблицы с улучшенной структурой
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
  `, (err) => {
    if (err) {
      console.error('Table creation error:', err);
      process.exit(1); // Выход при критической ошибке БД
    } else {
      console.log('Table "commands" ready');
    }
  });
});

// Улучшенная проверка доступа
bot.use((ctx, next) => {
  const ALLOWED_CHAT_IDS = process.env.ALLOWED_CHAT_IDS 
    ? process.env.ALLOWED_CHAT_IDS.split(',') 
    : ["581227168"];
  
  if (ctx.message && !ALLOWED_CHAT_IDS.includes(String(ctx.message.chat.id))) {
    console.warn(`Unauthorized access attempt from chat ID: ${ctx.message.chat.id}`);
    return ctx.reply("⛔ Доступ запрещен!");
  }
  return next();
});

// Улучшенный обработчик команд
bot.command('relay_on', async (ctx) => {
  try {
    const duration = parseInt(ctx.message.text.split(' ')[1]);
    
    if (isNaN(duration) || duration <= 0) {
      return ctx.reply('Используйте: /relay_on <секунды> (число больше 0)');
    }

    await new Promise((resolve, reject) => {
      db.run(
        "INSERT INTO commands (chat_id, command, duration) VALUES (?, ?, ?)",
        [ctx.message.chat.id, "relay_on", duration],
        function(err) {
          if (err) return reject(err);
          console.log(`Command recorded with ID: ${this.lastID}`);
          resolve();
        }
      );
    });
    
    await ctx.reply(`✅ Реле будет включено на ${duration} секунд.`);
  } catch (err) {
    console.error('Error in relay_on:', err);
    await ctx.reply('❌ Ошибка обработки команды');
  }
});

// Аналогичные улучшения для relay_off...

// API для ESP32 с улучшенной обработкой ошибок
app.get('/get_command', (req, res) => {
  db.get(
    "SELECT * FROM commands WHERE processed = 0 ORDER BY created_at LIMIT 1",
    (err, row) => {
      if (err) {
        console.error('DB select error:', err);
        return res.status(500).json({ 
          error: 'Database error',
          details: err.message 
        });
      }
      
      if (row) {
        console.log(`Sending command: ${row.command}`);
        res.json({ 
          command: row.command,
          duration: row.duration || 0,
          id: row.id
        });
        db.run("UPDATE commands SET processed = 1 WHERE id = ?", row.id);
      } else {
        res.status(404).json({ command: null });
      }
    }
  );
});

// Health check endpoint
app.get('/health', (req, res) => {
  db.get("SELECT 1", (err) => {
    if (err) {
      res.status(500).json({ 
        status: 'ERROR',
        db: 'disconnected'
      });
    } else {
      res.json({ 
        status: 'OK',
        db: 'connected',
        version: process.env.npm_package_version
      });
    }
  });
});

// Обработка ошибок Express
app.use((err, req, res, next) => {
  console.error('Express error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Запуск сервера с правильным портом для Render
const PORT = process.env.PORT || 10000; // Render использует порт 10000

const startServer = async () => {
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    console.log('Webhook deleted');
    
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on port ${PORT}`);
      
      bot.launch()
        .then(() => {
          console.log('Bot started successfully');
          console.log('Health check at:', `http://localhost:${PORT}/health`);
        })
        .catch(err => {
          console.error('Bot launch error:', err);
          process.exit(1);
        });
    });
  } catch (err) {
    console.error('Startup error:', err);
    process.exit(1);
  }
};

// Graceful shutdown
['SIGINT', 'SIGTERM'].forEach(signal => {
  process.once(signal, () => {
    console.log(`Received ${signal}, shutting down...`);
    bot.stop(signal);
    db.close();
    process.exit();
  });
});

startServer();
