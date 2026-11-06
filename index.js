import express from 'express';
import makeWASocket, { useMultiFileAuthState, Browsers, delay, DisconnectReason, fetchLatestWaWebVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yts from 'yt-search';
import { createRequire } from 'module';
import multer from 'multer';

const require = createRequire(import.meta.url);
const ytdl = require('@distube/ytdl-core');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: 'temp_uploads/' });
if (!fs.existsSync('temp_uploads')) fs.mkdirSync('temp_uploads');

let sock = null;
let isConnected = false;
let pairingCode = null;
let isDownloading = false;
let blastInterval = null;
let logs = [];
let clients = [];

process.on('uncaughtException', (err) => console.log('⚠️ Uncaught Exception:', err.message));
process.on('unhandledRejection', (err) => console.log('⚠️ Unhandled Rejection:', err.message));

function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    logs.push({ time, msg });
    if (logs.length > 50) logs.shift();
    clients.forEach(c => c.res.write(`data: ${JSON.stringify({ time, msg })}\n\n`));
    console.log(`[${time}] ${msg}`);
}

app.get('/api/logs', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const clientId = Date.now();
    clients.push({ id: clientId, res });
    req.on('close', () => clients = clients.filter(c => c.id !== clientId));
});

app.get('/api/status', (req, res) => {
    res.json({ connected: isConnected, pairingCode });
});

app.post('/api/upload-msg', upload.single('msgFile'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Koi file upload nahi hui" });
    try {
        fs.renameSync(req.file.path, 'messages.txt');
        const content = fs.readFileSync('messages.txt', 'utf-8');
        const lines = content.split('\n').filter(l => l.trim() !== '').length;
        addLog(`📁 Naya messages.txt upload hua (${lines} lines)`);
        res.json({ ok: true, count: lines });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/pair', async (req, res) => {
    const { phone } = req.body;
    if (isConnected) return res.json({ ok: true, msg: "Already connected" });
    if (!phone) return res.status(400).json({ error: "Number required" });
    
    try {
        if (sock) { try { sock.end(undefined); } catch(e) {} }
        
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_krix');
        let version = [2, 3000, 1017531287];
        try { const vData = await fetchLatestWaWebVersion(); version = vData.version; } catch(e) {}

        sock = makeWASocket({
            version,
            auth: state,
            browser: Browsers.ubuntu('Chrome'),
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 30000
        });

        sock.ev.on('creds.update', saveCreds);
        
        sock.ev.on('connection.update', async (update) => {
            const { connection, qr, lastDisconnect } = update;
            
            if (qr && !sock.authState.creds.registered) {
                await delay(2000);
                try {
                    const code = await sock.requestPairingCode(phone.replace(/[^0-9]/g, ''));
                    pairingCode = code.match(/.{1,4}/g).join('-');
                    addLog(`🔑 Code Generated: ${pairingCode}`);
                } catch (err) {
                    addLog(`❌ Pairing Error: ${err.message}`);
                }
            }
            if (connection === 'open') {
                isConnected = true;
                pairingCode = null;
                addLog("✅ WHATSAPP CONNECTED!");
                setupMessageListener();
            }
            if (connection === 'close') {
                isConnected = false;
                const code = lastDisconnect?.error?.output?.statusCode;
                addLog(`❌ Connection Closed. Code: ${code}`);
                if (code === DisconnectReason.loggedOut) {
                    addLog("⚠️ Logged out. Please pair again.");
                } else {
                    addLog("🔄 Reconnecting...");
                }
            }
        });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 🔥 Helper for Music (Sends Pic + Title + Artist + Audio)
async function downloadAndSendSong(jid, query, fromWeb = false) {
    if (isDownloading) {
        if (fromWeb) throw new Error("Already downloading a song");
        return;
    }
    isDownloading = true;
    
    try {
        const search = await yts(query);
        const video = search.videos[0];
        if (!video) throw new Error("Song not found");
        
        addLog(`🔍 Downloading: ${video.title}`);
        await sock.sendMessage(jid, { text: `🔍 *Searching:* ${query}...` });
        
        // 🔥 Yahan Title, Artist, Duration aur Photo jayega
        await sock.sendMessage(jid, { 
            image: { url: video.thumbnail },
            caption: `🎵 *Title:* ${video.title}\n👤 *Artist:* ${video.author.name}\n⏱️ *Duration:* ${video.timestamp}\n\n⏳ _Sending Audio..._`
        });

        const stream = ytdl(video.url, { filter: 'audioonly', quality: 'highestaudio' });
        const chunks = [];
        for await (const chunk of stream) { chunks.push(chunk); }
        const buffer = Buffer.concat(chunks);
        
        await sock.sendMessage(jid, { 
            audio: buffer, 
            mimetype: 'audio/mp4', 
            fileName: `${video.title}.mp3` 
        });
        addLog(`✅ Song Sent: ${video.title}`);
    } catch (err) {
        addLog(`❌ Music Error: ${err.message}`);
        if (fromWeb) throw err;
        else await sock.sendMessage(jid, { text: `❌ Song download fail hua: ${err.message}` });
    } finally {
        isDownloading = false;
    }
}

app.post('/api/play', async (req, res) => {
    if (!isConnected) return res.status(400).json({ error: "WhatsApp not connected" });
    const { target, query } = req.body;
    if (!target || !query) return res.status(400).json({ error: "Target and query required" });
    
    let jid = target.includes('@') ? target : `${target}@s.whatsapp.net`;
    res.json({ ok: true });
    
    try {
        await downloadAndSendSong(jid, query, true);
    } catch (err) {}
});

app.post('/api/blast', (req, res) => {
    if (!isConnected) return res.status(400).json({ error: "Not connected" });
    if (blastInterval) return res.status(400).json({ error: "Blast already running" });
    
    const { target, delaySec } = req.body;
    let jid = target.includes('@') ? target : `${target}@s.whatsapp.net`;
    const delay = parseInt(delaySec) || 20;
    
    if (!fs.existsSync('messages.txt')) return res.status(400).json({ error: "messages.txt missing" });
    
    let messages = fs.readFileSync('messages.txt', 'utf-8').split('\n').map(m => m.trim()).filter(m => m);
    if (messages.length === 0) return res.status(400).json({ error: "messages.txt is empty" });
    
    let index = 0;
    addLog(`🚀 BLAST STARTED! (${messages.length} messages)`);
    res.json({ ok: true });
    
    blastInterval = setInterval(async () => {
        if (!isConnected) return;
        if (index >= messages.length) index = 0;
        try {
            await sock.sendMessage(jid, { text: messages[index] });
            addLog(`[Blast] Sent: ${messages[index].substring(0, 15)}...`);
            index++;
        } catch (e) {}
    }, delay * 1000);
});

app.post('/api/stop', (req, res) => {
    if (blastInterval) {
        clearInterval(blastInterval);
        blastInterval = null;
        addLog("🛑 BLAST STOPPED");
        return res.json({ ok: true });
    }
    res.json({ ok: false });
});

function setupMessageListener() {
    if (!sock) return;
    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg || !msg.message || msg.key.fromMe) return;
            const sender = msg.key.remoteJid;
            if (!sender || sender === 'status@broadcast') return;

            const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || "").trim();
            const lowerText = text.toLowerCase();
            if (!text) return;

            // 🔥 WhatsApp !play command
            if (lowerText.startsWith("!play ")) {
                const query = text.slice(6).trim();
                if (!query) return sock.sendMessage(sender, { text: "❌ Gaane ka naam toh likho!" });
                await downloadAndSendSong(sender, query, false);
                return;
            }

            if (lowerText === "!roll") return await sock.sendMessage(sender, { text: `🎲 Dice: *${Math.floor(Math.random() * 6) + 1}*` });
            if (lowerText === "!coin") return await sock.sendMessage(sender, { text: `🎯 Coin: *${Math.random() > 0.5 ? "Heads" : "Tails"}*` });
            
            if (lowerText.includes("krix") || lowerText.includes("bot")) {
                await sock.sendMessage(sender, { text: "Haan bhai, bolo kya karna hai? 😎" }, { quoted: msg });
            }
        } catch (e) {}
    });
}

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🔥 WEB SERVER RUNNING ON PORT ${PORT}`);
});
