 require('dotenv').config();
const express = require('express');
const { Telegraf } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Инициализация приложения
const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);

// Базовая конфигурация
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Инициализация БД
const db = new sqlite3.Database(process.env.DB_PATH || '/data/commands.db', (err) => {
  if (err) {
    console.error('Database error:', err);
    process.exit(1);
  }
  console.log('Connected to SQLite database');
});

// Простейший маршрут для проверки
app.get('/', (req, res) => {
  res.send('Server is running');
});

// API для ESP32
app.get('/get_command', (req, res) => {
  db.get(
    `SELECT * FROM commands 
     WHERE processed = 0 
     ORDER BY created_at 
     LIMIT 1`,
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(row || { command: null });
    }
  );
});

// Запуск сервера
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  
  // Запуск бота
  bot.launch()
    .then(() => console.log('Bot started'))
    .catch(err => console.error('Bot error:', err));
});

// Обработка завершения работы
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
