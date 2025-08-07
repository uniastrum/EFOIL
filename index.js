process.env.NTBA_FIX_319 = "1";
require('dotenv').config();

const { Telegraf } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
const db = new sqlite3.Database('commands.db');

// Проверка подключения к БД
db.on('error', (err) => {
  console.error('Database error:', err);
});

// Создание таблицы
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS commands (
      id INTEGER PRIMARY KEY,
      chat_id INTEGER,
      command TEXT,
      duration INTEGER NULL,
      processed BOOLEAN DEFAULT 0
    )
  `, (err) => {
    if (err) {
      console.error('Table creation error:', err);
    } else {
      console.log('Table "commands" ready');
    }
  });
});

// Мидлварь для проверки доступа
bot.use((ctx, next) => {
  const ALLOWED_CHAT_IDS = ["581227168"];
  
  if (ctx.message && !ALLOWED_CHAT_IDS.includes(String(ctx.message.chat.id))) {
    return ctx.reply("⛔ Доступ запрещен!");
  }
  return next();
});

// Обработчики команд
bot.command('relay_on', async (ctx) => {
  try {
    const duration = parseInt(ctx.message.text.split(' ')[1]);
    
    if (isNaN(duration)) {
      return ctx.reply('Используйте: /relay_on <секунды>');
    }

    await new Promise((resolve, reject) => {
      db.run(
        "INSERT INTO commands (chat_id, command, duration) VALUES (?, ?, ?)",
        [ctx.message.chat.id, "relay_on", duration],
        (err) => err ? reject(err) : resolve()
      );
    });
    
    await ctx.reply(`✅ Реле будет включено на ${duration} секунд.`);
  } catch (err) {
    console.error('Error in relay_on:', err);
    await ctx.reply('❌ Ошибка обработки команды');
  }
});

bot.command('relay_off', async (ctx) => {
  try {
    await new Promise((resolve, reject) => {
      db.run(
        "INSERT INTO commands (chat_id, command) VALUES (?, ?)",
        [ctx.message.chat.id, "relay_off"],
        (err) => err ? reject(err) : resolve()
      );
    });
    
    await ctx.reply("✅ Реле будет выключено.");
  } catch (err) {
    console.error('Error in relay_off:', err);
    await ctx.reply('❌ Ошибка обработки команды');
  }
});

// API для ESP32
app.get('/get_command', (req, res) => {
  db.get("SELECT * FROM commands WHERE processed = 0 LIMIT 1", (err, row) => {
    if (err) {
      console.error('DB select error:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    
    if (row) {
      res.json({ 
        command: row.command,
        duration: row.duration || 0
      });
      db.run("UPDATE commands SET processed = 1 WHERE id = ?", row.id);
    } else {
      res.json({ command: null });
    }
  });
});

// Обработка ошибок бота
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  return ctx.reply('❌ Произошла ошибка');
});

// Запуск
const PORT = process.env.PORT || 3000;

const startServer = async () => {
  try {
    // Удаляем вебхук, если он был
    await bot.telegram.deleteWebhook();
    console.log('Webhook deleted');
    
    // Запускаем сервер
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      
      // Запускаем бота
      bot.launch()
        .then(() => console.log('Bot started successfully'))
        .catch(err => console.error('Bot launch error:', err));
    });
  } catch (err) {
    console.error('Startup error:', err);
    process.exit(1);
  }
};

startServer();

// Graceful shutdown
process.once('SIGINT', () => {
  bot.stop('SIGINT');
  process.exit();
});

process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
  process.exit();
});