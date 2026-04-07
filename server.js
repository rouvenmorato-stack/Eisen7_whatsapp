const express = require('express');
const cors = require('cors');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const SYSTEM = fs.readFileSync('./system_prompt.txt', 'utf8');

const JSONBIN_KEY = $2a$10$Ofc1Y9zPHLtpWpIrhyVieOXaeyfhoIgeEJNxSdXWOarcsHQLUGTBO
const JSONBIN_BIN = 69d5175a36566621a889ac5c;
const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN}`;

const conversations = {};
const MAX_HISTORY = 10;
const DETAIL_KEYWORDS = ['ja', 'yes', 'mehr', 'more', 'details', 'ausführlicher', 'genauer'];

const isDetailRequest = (text) => {
  const lower = text.trim().toLowerCase();
  return DETAIL_KEYWORDS.some(kw => lower === kw || lower.startsWith(kw + ' ') || lower.endsWith(' ' + kw));
};

const ensureWhatsApp = (number) => {
  if (!number) return number;
  return number.startsWith('whatsapp:') ? number : `whatsapp:${number}`;
};

const sendMessage = async (to, from, text) => {
  const MAX_LENGTH = 1500;
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, MAX_LENGTH));
    remaining = remaining.slice(MAX_LENGTH);
  }
  for (const chunk of chunks) {
    await twilioClient.messages.create({
      from: ensureWhatsApp(from),
      to: ensureWhatsApp(to),
      body: chunk
    });
  }
};

async function readLogs() {
  try {
    const res = await axios.get(JSONBIN_URL + '/latest', {
      headers: { 'X-Master-Key': JSONBIN_KEY }
    });
    return res.data.record.logs || [];
  } catch (e) {
    console.error('JSONbin read error:', e.message);
    return [];
  }
}

async function writeLog(entry) {
  try {
    const logs = await readLogs();
    logs.push(entry);
    const trimmed = logs.slice(-500);
    await axios.put(JSONBIN_URL, { logs: trimmed }, {
      headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_KEY }
    });
    console.log('[USAGE logged]', entry.firstWords);
  } catch (e) {
    console.error('JSONbin write error:', e.message);
  }
}

app.get('/', (req, res) => res.send('E7SEN WhatsApp KI-Coach läuft!'));

app.get('/stats', async (req, res) => {
  const logs = await readLogs();
  const today = new Date().toISOString().slice(0, 10);
  const todayLogs = logs.filter(e => e.timestamp.startsWith(today));
  const uniqueUsers = new Set(logs.map(e => e.user)).size;
  const imageRequests = logs.filter(e => e.hasImage).length;
  res.json({
    total_messages: logs.length,
    today: todayLogs.length,
    unique_users: uniqueUsers,
    image_analyses: imageRequests,
    last_10: logs.slice(-10)
  });
});

app.post('/webhook', async (req, res) => {
  const from = req.body.From;
  const to = req.body.To;
  const body = req.body.Body || '';
  const numMedia = parseInt(req.body.NumMedia || '0');

  if (!conversations[from]) conversations[from] = [];

  try {
    let userContent = [];

    if (numMedia > 0) {
      for (let i = 0; i < numMedia; i++) {
        const mediaUrl = req.body[`MediaUrl${i}`];
        const mediaType = req.body[`MediaContentType${i}`];
        if (mediaType && mediaType.startsWith('image/')) {
          try {
            const response = await axios.get(mediaUrl, {
              responseType: 'arraybuffer',
              auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN }
            });
            const base64Data = Buffer.from(response.data).toString('base64');
            userContent.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } });
          } catch (imgErr) { console.error('Image error:', imgErr.message); }
        }
      }
    }

    if (body.trim()) {
      userContent.push({ type: 'text', text: body });
    } else if (userContent.length === 0) {
      userContent.push({ type: 'text', text: 'Hallo!' });
    } else if (numMedia > 0 && !body.trim()) {
      userContent.push({ type: 'text', text: 'Bitte analysiere meinen TrackMan Screenshot und erkläre alle Werte.' });
    }

    const wantsDetails = body.trim() && isDetailRequest(body.trim());

    writeLog({
      timestamp: new Date().toISOString(),
      user: from.replace('whatsapp:', '').slice(-4).padStart(8, '*'),
      firstWords: body ? body.slice(0, 80) : '[image]',
      hasImage: numMedia > 0,
      wantsDetails
    }).catch((e) => console.error('[LOG FAILED]', e.message));

    const systemPrompt = wantsDetails
      ? SYSTEM + `\n\nWICHTIG - WHATSAPP FORMAT (DETAIL-MODUS):\nGib jetzt eine tiefere Antwort (max. 8-10 Sätze).\nKeine erneute Detail-Frage.\nMax. 1400 Zeichen.`
      : SYSTEM + `\n\nWICHTIG - WHATSAPP FORMAT:\nMax. 3-4 Sätze.\nKeine Listen.\nBeende JEDE Antwort mit: "Möchtest du mehr Details? Antworte mit 'Ja' 👇"\nMax. 1400 Zeichen.`;

    conversations[from].push({
      role: 'user',
      content: userContent.length === 1 && userContent[0].type === 'text' ? userContent[0].text : userContent
    });

    if (conversations[from].length > MAX_HISTORY * 2) {
      conversations[from] = conversations[from].slice(-MAX_HISTORY * 2);
    }

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 800,
      system: systemPrompt,
      messages: conversations[from]
    });

    const reply = response.content[0].text;
    conversations[from].push({ role: 'assistant', content: reply });
    await sendMessage(from, to, reply);
    res.status(200).send('OK');

  } catch (error) {
    console.error('Error:', error.message);
    try {
      await twilioClient.messages.create({
        from: ensureWhatsApp(to),
        to: ensureWhatsApp(from),
        body: 'Entschuldigung, technischer Fehler. Bitte nochmal versuchen.'
      });
    } catch (sendErr) { console.error('Send error:', sendErr.message); }
    res.status(500).send('Error');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`E7SEN WhatsApp KI-Coach läuft auf Port ${PORT}`));
