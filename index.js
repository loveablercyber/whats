require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const qrcode = require("qrcode");
const axios = require("axios");

const { Client, RemoteAuth } = require("whatsapp-web.js");
const { MongoStore } = require("wwebjs-mongo");

const app = express();

app.use(cors());
app.use(express.json({ limit: "20mb" }));

let client = null;
let latestQr = null;
let connectionStatus = "starting";
let lastReadyAt = null;
let lastSessionSavedAt = null;

app.get("/qr-public-test", (req, res) => {
  if (!latestQr) {
    return res.send(`
      <html>
        <head>
          <meta http-equiv="refresh" content="5">
        </head>
        <body style="font-family: Arial; padding: 30px;">
          <h2>QR Code indisponível</h2>
          <p>Status atual: <strong>${connectionStatus}</strong></p>
          <p>A página atualiza sozinha a cada 5 segundos.</p>
        </body>
      </html>
    `);
  }

  res.send(`
    <html>
      <head>
        <meta http-equiv="refresh" content="15">
      </head>
      <body style="font-family: Arial; padding: 30px;">
        <h2>Escaneie o QR Code</h2>
        <p>Status: <strong>${connectionStatus}</strong></p>
        <img src="${latestQr}" style="width: 320px; height: 320px;" />
        <p>Se não conectar, aguarde atualizar ou pressione F5.</p>
      </body>
    </html>
  `);
});










function checkApiKey(req, res, next) {
  const apiKey = req.headers["x-api-key"];

  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({
      success: false,
      error: "API key inválida"
    });
  }

  next();
}

function normalizeBrazilNumber(number) {
  const clean = String(number || "").replace(/\D/g, "");

  if (!clean) {
    return null;
  }

  // Se vier sem DDI, adiciona Brasil 55
  if (clean.length === 10 || clean.length === 11) {
    return `55${clean}`;
  }

  return clean;
}

async function startWhatsApp() {
  const store = new MongoStore({ mongoose });

  client = new Client({
    authStrategy: new RemoteAuth({
  store,
  clientId: process.env.CLIENT_ID || "default",
  dataPath: "./",
  backupSyncIntervalMs: 300000,
  rmMaxRetries: 5
}),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-extensions"
      ]
    }
  });

  client.on("qr", async (qr) => {
    console.log("QR Code gerado");
    latestQr = await qrcode.toDataURL(qr);
    connectionStatus = "qr";
  });

  client.on("authenticated", () => {
    console.log("WhatsApp autenticado");
    connectionStatus = "authenticated";
  });

  client.on("remote_session_saved", () => {
    console.log("Sessão remota salva no MongoDB");
    lastSessionSavedAt = new Date().toISOString();
  });

  client.on("ready", () => {
    console.log("WhatsApp pronto");
    latestQr = null;
    connectionStatus = "ready";
    lastReadyAt = new Date().toISOString();
  });

  client.on("disconnected", (reason) => {
    console.log("WhatsApp desconectado:", reason);
    connectionStatus = "disconnected";
  });

  client.on("auth_failure", (message) => {
    console.error("Falha de autenticação:", message);
    connectionStatus = "auth_failure";
  });

  client.on("message", async (message) => {
    console.log("Mensagem recebida:", {
      from: message.from,
      body: message.body,
      type: message.type
    });

    if (process.env.WEBHOOK_URL) {
      try {
        await axios.post(process.env.WEBHOOK_URL, {
          from: message.from,
          body: message.body,
          type: message.type,
          timestamp: message.timestamp,
          hasMedia: message.hasMedia
        });
      } catch (error) {
        console.error("Erro ao enviar webhook:", error.message);
      }
    }
  });

  await client.initialize();
}

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "WhatsApp API online",
    status: connectionStatus
  });
});

app.get("/api/status", checkApiKey, (req, res) => {
  res.json({
    success: true,
    status: connectionStatus,
    lastReadyAt,
    lastSessionSavedAt,
    hasQr: Boolean(latestQr)
  });
});

app.get("/api/qr", checkApiKey, (req, res) => {
  res.json({
    success: true,
    status: connectionStatus,
    qr: latestQr
  });
});

app.get("/api/qr-view", checkApiKey, (req, res) => {
  if (!latestQr) {
    return res.send(`
      <html>
        <body style="font-family: Arial; padding: 30px;">
          <h2>QR Code indisponível</h2>
          <p>Status atual: <strong>${connectionStatus}</strong></p>
          <p>Se o status estiver "ready", o WhatsApp já está conectado.</p>
        </body>
      </html>
    `);
  }

  res.send(`
    <html>
      <body style="font-family: Arial; padding: 30px;">
        <h2>Escaneie o QR Code</h2>
        <p>Status: <strong>${connectionStatus}</strong></p>
        <img src="${latestQr}" style="width: 320px; height: 320px;" />
      </body>
    </html>
  `);
});

app.post("/api/send-text", checkApiKey, async (req, res) => {
  try {
    const { number, text } = req.body;

    if (!number || !text) {
      return res.status(400).json({
        success: false,
        error: "number e text são obrigatórios"
      });
    }

    if (!client || connectionStatus !== "ready") {
      return res.status(503).json({
        success: false,
        error: "WhatsApp ainda não está conectado",
        status: connectionStatus
      });
    }

    const normalizedNumber = normalizeBrazilNumber(number);

    if (!normalizedNumber) {
      return res.status(400).json({
        success: false,
        error: "Número inválido"
      });
    }

    const chatId = `${normalizedNumber}@c.us`;

    const result = await client.sendMessage(chatId, text);

    res.json({
      success: true,
      number: normalizedNumber,
      messageId: result.id?._serialized || null
    });
  } catch (error) {
    console.error("Erro ao enviar mensagem:", error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post("/api/logout", checkApiKey, async (req, res) => {
  try {
    if (!client) {
      return res.status(400).json({
        success: false,
        error: "Cliente WhatsApp não inicializado"
      });
    }

    await client.logout();

    latestQr = null;
    connectionStatus = "logged_out";

    res.json({
      success: true,
      message: "WhatsApp desconectado"
    });
  } catch (error) {
    console.error("Erro ao desconectar:", error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

async function bootstrap() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI não configurado");
  }

  if (!process.env.API_KEY) {
    throw new Error("API_KEY não configurada");
  }

  await mongoose.connect(process.env.MONGODB_URI);

  console.log("MongoDB conectado");

  await startWhatsApp();

  const port = process.env.PORT || 3000;

  app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
  });
}

bootstrap().catch((error) => {
  console.error("Erro ao iniciar aplicação:", error);
  process.exit(1);
});