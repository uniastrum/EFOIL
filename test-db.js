// test-db.js
require('dotenv').config();

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
    ssl: false  // отключаем SSL

});

async function testConnection() {
  try {
    const res = await pool.query('SELECT NOW()');
    console.log('✅ Подключение успешно:', res.rows[0]);
  } catch (err) {
    console.error('❌ Ошибка подключения:', err.message);
  } finally {
    await pool.end();
  }
}

testConnection();
