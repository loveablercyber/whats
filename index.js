require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const qrcode = require("qrcode");
const axios = require("axios");
const pino = require("pino");
const { Boom } = require("@hapi/boom");

const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  initAuthCreds,
  BufferJSON,
  proto
} = require("@whiskeysockets/baileys");

const app = express();

app.use(cors());
app.use(express.json({ limit: "20mb" }));

let sock = null;
let latestQr = null;
let connectionStatus = "starting";
let lastReadyAt = null;
let lastSessionSavedAt = null;
let isStarting = false;

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

  if (clean.length === 10 || clean.length === 11) {
    return `55${clean}`;
  }

  return clean;
}

function resolveRecipientJid(number) {
  const raw = String(number || "").trim();

  if (/@(?:s\.whatsapp\.net|lid|g\.us)$/i.test(raw)) {
    return {
      number: raw.replace(/@(?:s\.whatsapp\.net|lid|g\.us)$/i, ""),
      jid: raw
    };
  }

  const normalizedNumber = normalizeBrazilNumber(raw);

  if (!normalizedNumber) {
    return null;
  }

  return {
    number: normalizedNumber,
    jid: `${normalizedNumber}@s.whatsapp.net`
  };
}

function cleanString(value) {
  return String(value || "").trim();
}

function isPublicHttpUrl(value) {
  try {
    const url = new URL(cleanString(value));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function resolveMediaPayload(body) {
  const mediaType = cleanString(body.mediaType || body.type).toLowerCase();
  const mediaUrl = cleanString(body.mediaUrl || body.url);
  const caption = cleanString(body.caption);
  const mimetype = cleanString(body.mimetype);

  if (!["image", "video", "audio"].includes(mediaType)) {
    return {
      error: "mediaType deve ser image, video ou audio"
    };
  }

  if (!isPublicHttpUrl(mediaUrl)) {
    return {
      error: "mediaUrl deve ser uma URL publica http/https"
    };
  }

  if (mediaType === "image") {
    return {
      message: {
        image: { url: mediaUrl },
        ...(caption ? { caption } : {})
      }
    };
  }

  if (mediaType === "video") {
    return {
      message: {
        video: { url: mediaUrl },
        ...(caption ? { caption } : {})
      }
    };
  }

  return {
    message: {
      audio: { url: mediaUrl },
      mimetype: mimetype || "audio/mpeg",
      ptt: Boolean(body.ptt)
    }
  };
}

function getClientId() {
  return process.env.CLIENT_ID || "default";
}

function getAuthCollection() {
  return mongoose.connection.collection("baileys_auth");
}

async function useMongoAuthState(clientId) {
  const collection = getAuthCollection();

  const keyPrefix = `baileys:${clientId}:`;

  const writeData = async (data, id) => {
    await collection.updateOne(
      { _id: `${keyPrefix}${id}` },
      {
        $set: {
          data: JSON.stringify(data, BufferJSON.replacer),
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );
  };

  const readData = async (id) => {
    const doc = await collection.findOne({ _id: `${keyPrefix}${id}` });

    if (!doc || !doc.data) {
      return null;
    }

    return JSON.parse(doc.data, BufferJSON.reviver);
  };

  const removeData = async (id) => {
    await collection.deleteOne({ _id: `${keyPrefix}${id}` });
  };

  const creds = (await readData("creds")) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};

          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);

              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }

              data[id] = value;
            })
          );

          return data;
        },
        set: async (data) => {
          const tasks = [];

          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              const key = `${category}-${id}`;

              if (value) {
                tasks.push(writeData(value, key));
              } else {
                tasks.push(removeData(key));
              }
            }
          }

          await Promise.all(tasks);
        }
      }
    },
    saveCreds: async () => {
      await writeData(creds, "creds");
      lastSessionSavedAt = new Date().toISOString();
      console.log("Sessão Baileys salva no MongoDB");
    },
    clearAuth: async () => {
      await collection.deleteMany({
        _id: { $regex: `^${keyPrefix}` }
      });
    }
  };
}

async function startBaileys() {
  if (isStarting) {
    return;
  }

  isStarting = true;

  try {
    connectionStatus = "starting";

    const clientId = getClientId();
    const { state, saveCreds } = await useMongoAuthState(clientId);
    const { version } = await fetchLatestBaileysVersion();

    const logger = pino({
      level: process.env.LOG_LEVEL || "silent"
    });

    sock = makeWASocket({
      version,
      printQRInTerminal: false,
      logger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      browser: ["Nextia WhatsApp API", "Chrome", "1.0.0"],
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("QR Code gerado");
        latestQr = await qrcode.toDataURL(qr);
        connectionStatus = "qr";
      }

      if (connection === "open") {
        console.log("WhatsApp conectado com Baileys");
        latestQr = null;
        connectionStatus = "ready";
        lastReadyAt = new Date().toISOString();
      }

      if (connection === "close") {
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;

        console.log("Conexão fechada:", statusCode);

        if (statusCode === DisconnectReason.loggedOut) {
          connectionStatus = "logged_out";
          latestQr = null;
          console.log("Sessão deslogada. Será necessário novo QR Code.");
          return;
        }

        connectionStatus = "reconnecting";
        latestQr = null;

        setTimeout(() => {
          isStarting = false;
          startBaileys().catch((error) => {
            console.error("Erro ao reconectar:", error);
          });
        }, 5000);
      }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
      const message = messages?.[0];

      if (!message || !message.message) {
        return;
      }

      const from = message.key.remoteJid;
      const isFromMe = message.key.fromMe;

      const text =
        message.message.conversation ||
        message.message.extendedTextMessage?.text ||
        message.message.imageMessage?.caption ||
        message.message.videoMessage?.caption ||
        "";

      console.log("Mensagem recebida:", {
        from,
        isFromMe,
        text
      });

      if (!isFromMe && process.env.WEBHOOK_URL) {
        try {
          await axios.post(process.env.WEBHOOK_URL, {
            from,
            text,
            isFromMe,
            timestamp: message.messageTimestamp,
            raw: message
          });
        } catch (error) {
          console.error("Erro ao enviar webhook:", error.message);
        }
      }
    });
  } finally {
    isStarting = false;
  }
}

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "WhatsApp API Baileys online",
    status: connectionStatus
  });
});

app.get("/api/status", checkApiKey, (req, res) => {
  res.json({
    success: true,
    engine: "baileys",
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
        <head>
          <meta http-equiv="refresh" content="5">
        </head>
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
      <head>
        <meta http-equiv="refresh" content="10">
      </head>
      <body style="font-family: Arial; padding: 30px;">
        <h2>Escaneie o QR Code</h2>
        <p>Status: <strong>${connectionStatus}</strong></p>
        <img src="${latestQr}" style="width: 320px; height: 320px;" />
      </body>
    </html>
  `);
});

// Rota pública temporária para teste. Remova depois de conectar.
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
        </body>
      </html>
    `);
  }

  res.send(`
    <html>
      <head>
        <meta http-equiv="refresh" content="10">
      </head>
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

    if (!sock || connectionStatus !== "ready") {
      return res.status(503).json({
        success: false,
        error: "WhatsApp ainda não está conectado",
        status: connectionStatus
      });
    }

    const recipient = resolveRecipientJid(number);

    if (!recipient) {
      return res.status(400).json({
        success: false,
        error: "Número inválido"
      });
    }

    const result = await sock.sendMessage(recipient.jid, {
      text
    });

    res.json({
      success: true,
      number: recipient.number,
      jid: recipient.jid,
      messageId: result?.key?.id || null
    });
  } catch (error) {
    console.error("Erro ao enviar mensagem:", error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post("/api/send-media", checkApiKey, async (req, res) => {
  try {
    const { number } = req.body;

    if (!number) {
      return res.status(400).json({
        success: false,
        error: "number é obrigatório"
      });
    }

    if (!sock || connectionStatus !== "ready") {
      return res.status(503).json({
        success: false,
        error: "WhatsApp ainda não está conectado",
        status: connectionStatus
      });
    }

    const recipient = resolveRecipientJid(number);

    if (!recipient) {
      return res.status(400).json({
        success: false,
        error: "Número inválido"
      });
    }

    const media = resolveMediaPayload(req.body);

    if (media.error) {
      return res.status(400).json({
        success: false,
        error: media.error
      });
    }

    const result = await sock.sendMessage(recipient.jid, media.message);

    res.json({
      success: true,
      number: recipient.number,
      jid: recipient.jid,
      mediaType: cleanString(req.body.mediaType || req.body.type).toLowerCase(),
      messageId: result?.key?.id || null
    });
  } catch (error) {
    console.error("Erro ao enviar mídia:", error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post("/api/logout", checkApiKey, async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
    }

    const { clearAuth } = await useMongoAuthState(getClientId());
    await clearAuth();

    latestQr = null;
    connectionStatus = "logged_out";

    res.json({
      success: true,
      message: "WhatsApp desconectado e sessão removida"
    });
  } catch (error) {
    console.error("Erro ao desconectar:", error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post("/api/reset-session", checkApiKey, async (req, res) => {
  try {
    console.log("Resetando sessão Baileys...");

    latestQr = null;
    connectionStatus = "resetting";

    try {
      if (sock?.ws) {
        sock.ws.close();
      }
    } catch (error) {
      console.log("Socket já estava fechado");
    }

    sock = null;

    const { clearAuth } = await useMongoAuthState(getClientId());
    await clearAuth();

    connectionStatus = "starting";

    await startBaileys();

    res.json({
      success: true,
      message: "Sessão removida. Aguarde alguns segundos e abra o QR Code novamente."
    });
  } catch (error) {
    console.error("Erro ao resetar sessão:", error);

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

  await startBaileys();

  const port = process.env.PORT || 3000;

  app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
  });
}

bootstrap().catch((error) => {
  console.error("Erro ao iniciar aplicação:", error);
  process.exit(1);
});
