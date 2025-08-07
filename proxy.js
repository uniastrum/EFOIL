const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
const PORT = 80; // обычный HTTP

// Прокси GET /get_command?esp=2
app.get('/get_command', async (req, res) => {
  const esp = req.query.esp;
  if (!esp) return res.status(400).send('esp query param missing');

  try {
    const result = await axios.get(`https://efoil.fly.dev/get_command`, {
      params: { esp },
    });
    res.send(result.data);
  } catch (error) {
    console.error('Proxy error:', error.message);
    res.status(500).send('Proxy request failed');
  }
});

// Прокси POST /submit_command
app.use(express.json());
app.post('/submit_command', async (req, res) => {
  try {
    const result = await axios.post(`https://efoil.fly.dev/submit_command`, req.body);
    res.send(result.data);
  } catch (error) {
    console.error('Proxy POST error:', error.message);
    res.status(500).send('Proxy POST failed');
  }
});

app.listen(PORT, () => {
  console.log(`ESP proxy server running on http://0.0.0.0:${PORT}`);
});
