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
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  initAuthCreds,
  BufferJSON,
  proto,
  Browsers
} = require("baileys");

const app = express();

app.use(cors());
app.use(express.json({ limit: "20mb" }));

let sock = null;
let latestQr = null;
let connectionStatus = "starting";
let lastReadyAt = null;
let lastSessionSavedAt = null;
let isStarting = false;
let lastQrGeneratedAt = null;
let lastPairingCode = null;
let lastPairingRequestedAt = null;
let lastDisconnectReason = null;
let lastDisconnectAt = null;
let reconnectTimer = null;
let connectedJid = null;
let connectedNumber = null;
let connectedName = null;
let activeWaVersion = null;
let waVersionIsLatest = null;
const baileysPairingFix = "PR2559@834dc742";
const pairingRateLimitCooldownMs = Math.max(
  60_000,
  Number(process.env.PAIRING_RATE_LIMIT_COOLDOWN_MS || 30 * 60 * 1000)
);
const pairingMinIntervalMs = Math.max(
  30_000,
  Number(process.env.PAIRING_MIN_INTERVAL_MS || 60_000)
);
let pairingBlockedUntil = null;
let lastPairingError = null;
let lastPairingErrorAt = null;

function pairingRetryAfterSeconds() {
  if (!pairingBlockedUntil) return 0;
  return Math.max(0, Math.ceil((Date.parse(pairingBlockedUntil) - Date.now()) / 1000));
}

function pairingRateLimitPayload(retryAfterSeconds = pairingRetryAfterSeconds()) {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return {
    success: false,
    code: "PAIRING_RATE_LIMITED",
    error: `O WhatsApp bloqueou temporariamente novas tentativas. Aguarde ${minutes} minuto(s) antes de gerar outro código.`,
    retryAfterSeconds,
    retryAt: pairingBlockedUntil,
    status: connectionStatus
  };
}

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

const DEFAULT_PWA_WEBHOOK_URL =
  "https://carolmobile.vercel.app/api/webhooks/baileys/carolsol";

let lastIncomingMessageAt = null;
let lastIncomingFrom = null;
let lastIncomingFromMe = null;
let lastIncomingHasText = null;
let lastWebhookAttemptAt = null;
let lastWebhookTarget = null;
let lastWebhookStatus = null;
let lastWebhookError = null;
let lastUpsertCount = 0;
let lastUpsertType = null;
let recentWebhookEvents = [];

function safeWebhookTarget(value) {
  try {
    const url = new URL(cleanString(value));
    return {
      host: url.hostname,
      path: url.pathname,
    };
  } catch {
    return null;
  }
}

function pushWebhookEvent(event) {
  recentWebhookEvents = [
    {
      at: new Date().toISOString(),
      ...event
    },
    ...recentWebhookEvents
  ].slice(0, 10);
}

function messageContent(message) {
  if (!message) return {};
  if (message.ephemeralMessage?.message) return messageContent(message.ephemeralMessage.message);
  if (message.viewOnceMessage?.message) return messageContent(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2?.message) return messageContent(message.viewOnceMessageV2.message);
  if (message.documentWithCaptionMessage?.message) return messageContent(message.documentWithCaptionMessage.message);
  return message;
}

function extractMessageText(message) {
  const content = messageContent(message);
  return cleanString(
    content.conversation ||
      content.extendedTextMessage?.text ||
      content.imageMessage?.caption ||
      content.videoMessage?.caption ||
      content.documentMessage?.caption ||
      content.buttonsResponseMessage?.selectedDisplayText ||
      content.listResponseMessage?.title ||
      content.templateButtonReplyMessage?.selectedDisplayText ||
      content.interactiveResponseMessage?.body?.text ||
      ""
  );
}

function jidPhoneCandidate(...values) {
  for (const value of values) {
    const jid = cleanString(value);
    if (!jid || jid.endsWith("@g.us") || jid === "status@broadcast") continue;
    const number = jid.replace(/@(?:s\.whatsapp\.net|c\.us|broadcast)$/i, "").replace(/\D/g, "");
    if (/^55\d{10,11}$/.test(number)) return number;
  }
  return "";
}

function jidToNumber(value) {
  const jid = cleanString(value);
  const number = jid.replace(/@.*/, "").replace(/:.*/, "").replace(/\D/g, "");
  return /^55\d{10,11}$/.test(number) ? number : null;
}

function chatTypeFromJid(value) {
  const jid = cleanString(value);
  if (jid.endsWith("@g.us")) return "group";
  if (jid === "status@broadcast") return "status";
  if (jid.endsWith("@s.whatsapp.net") || jid.endsWith("@c.us")) return "private";
  if (jid.endsWith("@lid")) return "private_lid";
  return jid ? "unknown" : "empty";
}

function isSelfWebhookUrl(url) {
  const renderHost = cleanString(process.env.RENDER_EXTERNAL_HOSTNAME).toLowerCase();
  const hostname = url.hostname.toLowerCase();
  return (
    hostname === "whatsapp-api-tyd0.onrender.com" ||
    (renderHost && hostname === renderHost)
  );
}

function isLegacyWebhookUrl(url) {
  return url.hostname.toLowerCase() === "carolsol.vercel.app";
}

function publicHttpUrl(value) {
  try {
    const url = new URL(cleanString(value));
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

function resolveWebhookUrl() {
  const configured = cleanString(process.env.WEBHOOK_URL);
  const fallback =
    cleanString(process.env.PWA_WEBHOOK_URL) ||
    DEFAULT_PWA_WEBHOOK_URL;

  if (!configured) {
    return fallback;
  }

  const url = publicHttpUrl(configured);
  if (!url) {
    console.warn("WEBHOOK_URL inválida; usando webhook do PWA.");
    return fallback;
  }

  if (isSelfWebhookUrl(url)) {
    console.warn("WEBHOOK_URL aponta para a própria API Render; usando webhook do PWA.");
    return fallback;
  }

  if (isLegacyWebhookUrl(url)) {
    console.warn("WEBHOOK_URL aponta para domínio antigo do PWA; usando carolmobile.vercel.app.");
    return fallback;
  }

  return configured;
}

function webhookDiagnostics() {
  const resolved = resolveWebhookUrl();
  const configured = cleanString(process.env.WEBHOOK_URL);
  return {
    configured: Boolean(configured),
    usingFallback: resolved !== configured,
    target: safeWebhookTarget(resolved),
    lastIncomingMessageAt,
    lastIncomingFrom,
    lastIncomingFromMe,
    lastIncomingHasText,
    lastWebhookAttemptAt,
    lastWebhookTarget: safeWebhookTarget(lastWebhookTarget),
    lastWebhookStatus,
    lastWebhookError,
    lastUpsertCount,
    lastUpsertType,
    recentEvents: recentWebhookEvents.map((event) => ({
      ...event,
      from: event.from ? safeJid(event.from) : null
    }))
  };
}

function safeJid(value) {
  const text = cleanString(value);
  return text.replace(/\d(?=\d{4})/g, "•");
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

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function closeSocket() {
  try {
    if (sock?.ws) {
      sock.ws.close();
    }
  } catch (error) {
    console.log("Socket já estava fechado");
  }
  sock = null;
}

function scheduleReconnect(delayMs = 5000) {
  clearReconnectTimer();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startBaileys({ force: true }).catch((error) => {
      console.error("Erro ao reconectar:", error);
    });
  }, delayMs);
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

async function startBaileys({ force = false } = {}) {
  if (isStarting) {
    return;
  }

  if (sock && !force && connectionStatus !== "logged_out") {
    return;
  }

  isStarting = true;
  clearReconnectTimer();

  try {
    connectionStatus = "starting";
    lastPairingCode = null;
    lastPairingRequestedAt = null;

    const clientId = getClientId();
    const { state, saveCreds } = await useMongoAuthState(clientId);
    const { version, isLatest } = await fetchLatestWaWebVersion();
    activeWaVersion = Array.isArray(version) ? version.join(".") : String(version || "");
    waVersionIsLatest = Boolean(isLatest);
    console.log("Versão atual do WhatsApp Web:", activeWaVersion, { isLatest: waVersionIsLatest });

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
      browser: Browsers.ubuntu("Chrome"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("QR Code gerado");
        connectedJid = null;
        connectedNumber = null;
        connectedName = null;
        latestQr = await qrcode.toDataURL(qr);
        lastQrGeneratedAt = new Date().toISOString();
        lastPairingCode = null;
        lastPairingRequestedAt = null;
        connectionStatus = "qr";
      }

      if (connection === "open") {
        console.log("WhatsApp conectado com Baileys");
        latestQr = null;
        lastQrGeneratedAt = null;
        lastPairingCode = null;
        lastPairingRequestedAt = null;
        lastDisconnectReason = null;
        lastDisconnectAt = null;
        connectionStatus = "ready";
        lastReadyAt = new Date().toISOString();
        connectedJid = sock.user?.id || null;
        connectedNumber = jidToNumber(connectedJid);
        connectedName = sock.user?.name || sock.user?.verifiedName || null;
        pairingBlockedUntil = null;
        lastPairingError = null;
        lastPairingErrorAt = null;
      }

      if (connection === "close") {
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        lastDisconnectReason = statusCode || "unknown";
        lastDisconnectAt = new Date().toISOString();

        console.log("Conexão fechada:", statusCode);

        if (statusCode === DisconnectReason.loggedOut) {
          connectionStatus = "logged_out";
          latestQr = null;
          lastQrGeneratedAt = null;
          lastPairingCode = null;
          lastPairingRequestedAt = null;
          sock = null;
          connectedJid = null;
          connectedNumber = null;
          connectedName = null;
          console.log("Sessão deslogada. Será necessário novo QR Code.");
          return;
        }

        connectionStatus = "reconnecting";
        latestQr = null;
        sock = null;

        scheduleReconnect(statusCode === DisconnectReason.restartRequired ? 500 : 5000);
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      const batch = Array.isArray(messages) ? messages : [];
      lastUpsertCount = batch.length;
      lastUpsertType = type || null;

      for (const message of batch) {
        if (!message || !message.message) {
          continue;
        }

        const from = message.key.remoteJid;
        const isFromMe = Boolean(message.key.fromMe);
        const participant = message.key.participant || null;
        const text = extractMessageText(message.message);
        const phone = jidPhoneCandidate(from, participant);
        const chatType = chatTypeFromJid(from);

        lastIncomingMessageAt = new Date().toISOString();
        lastIncomingFrom = from;
        lastIncomingFromMe = isFromMe;
        lastIncomingHasText = Boolean(text);

        console.log("Mensagem recebida:", {
          from,
          participant,
          isFromMe,
          chatType,
          hasText: Boolean(text),
          text
        });

        const webhookUrl = resolveWebhookUrl();

        if (isFromMe || !webhookUrl) {
          pushWebhookEvent({
            from,
            participant,
            phone,
            chatType,
            type,
            isFromMe,
            hasText: Boolean(text),
            skipped: isFromMe ? "from_me" : "missing_webhook"
          });
          continue;
        }

        lastWebhookAttemptAt = new Date().toISOString();
        lastWebhookTarget = webhookUrl;
        lastWebhookStatus = "pending";
        lastWebhookError = null;
        try {
          const response = await axios.post(webhookUrl, {
            from,
            remoteJid: from,
            participant,
            phone,
            chatType,
            type,
            text,
            isFromMe,
            messageId: message.key.id || null,
            pushName: message.pushName || null,
            timestamp: message.messageTimestamp,
            raw: message
          });
          lastWebhookStatus = response.status;
          pushWebhookEvent({
            from,
            participant,
            phone,
            chatType,
            type,
            isFromMe,
            hasText: Boolean(text),
            status: response.status
          });
        } catch (error) {
          lastWebhookStatus = error.response?.status || "error";
          lastWebhookError = error.message;
          pushWebhookEvent({
            from,
            participant,
            phone,
            chatType,
            type,
            isFromMe,
            hasText: Boolean(text),
            status: lastWebhookStatus,
            error: error.message
          });
          console.error("Erro ao enviar webhook:", error.message);
        }
      }
    });
  } catch (error) {
    connectionStatus = "error";
    lastDisconnectReason = error.message;
    lastDisconnectAt = new Date().toISOString();
    throw error;
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
    phone_number: connectedNumber,
    number: connectedNumber,
    account_name: connectedName,
    connectedJid,
    activeWaVersion,
    waVersionIsLatest,
    baileysPairingFix,
    pairingBlockedUntil,
    pairingRetryAfterSeconds: pairingRetryAfterSeconds(),
    lastPairingError,
    lastPairingErrorAt,
    lastReadyAt,
    lastSessionSavedAt,
    lastQrGeneratedAt,
    lastPairingRequestedAt,
    lastDisconnectReason,
    lastDisconnectAt,
    hasQr: Boolean(latestQr),
    webhook: webhookDiagnostics()
  });
});

app.get("/api/qr", checkApiKey, (req, res) => {
  res.json({
    success: true,
    status: connectionStatus,
    qr: latestQr
  });
});

app.post("/api/pairing-code", checkApiKey, async (req, res) => {
  try {
    const activeRetryAfter = pairingRetryAfterSeconds();
    if (activeRetryAfter > 0) {
      res.set("Retry-After", String(activeRetryAfter));
      return res.status(429).json(pairingRateLimitPayload(activeRetryAfter));
    }

    if (lastPairingRequestedAt) {
      const elapsed = Date.now() - Date.parse(lastPairingRequestedAt);
      if (elapsed >= 0 && elapsed < pairingMinIntervalMs) {
        const retryAfter = Math.ceil((pairingMinIntervalMs - elapsed) / 1000);
        res.set("Retry-After", String(retryAfter));
        return res.status(429).json({
          success: false,
          code: "PAIRING_REQUEST_TOO_SOON",
          error: `Já existe um código recente. Aguarde ${retryAfter} segundo(s) antes de solicitar outro.`,
          retryAfterSeconds: retryAfter,
          status: connectionStatus
        });
      }
    }

    const number = normalizeBrazilNumber(req.body?.number);

    if (!/^55\d{10,11}$/.test(number || "")) {
      return res.status(400).json({
        success: false,
        error: "Informe o telefone com 55, DDD e número."
      });
    }

    if (connectionStatus === "ready") {
      return res.status(409).json({
        success: false,
        error: "WhatsApp já está conectado",
        status: connectionStatus
      });
    }

    if (!sock || ["logged_out", "error"].includes(connectionStatus)) {
      await startBaileys({ force: true });
    }

    if (!sock?.requestPairingCode) {
      return res.status(503).json({
        success: false,
        error: "Esta versão do Baileys não suporta código de pareamento",
        status: connectionStatus
      });
    }

    const code = await sock.requestPairingCode(number);
    lastPairingCode = code;
    lastPairingRequestedAt = new Date().toISOString();
    lastPairingError = null;
    lastPairingErrorAt = null;
    connectionStatus = "pairing_code";

    res.json({
      success: true,
      status: connectionStatus,
      number,
      pairingCode: code,
      requestedAt: lastPairingRequestedAt
    });
  } catch (error) {
    console.error("Erro ao gerar código de pareamento:", error);

    const statusCode =
      error?.output?.statusCode ||
      error?.data?.statusCode ||
      new Boom(error)?.output?.statusCode;
    const errorMessage = String(error?.message || error || "");
    const rateLimited = statusCode === 429 || /rate[-_ ]?overlimit|too many|429/i.test(errorMessage);

    lastPairingError = rateLimited ? "rate-overlimit" : errorMessage;
    lastPairingErrorAt = new Date().toISOString();

    if (rateLimited) {
      pairingBlockedUntil = new Date(Date.now() + pairingRateLimitCooldownMs).toISOString();
      const retryAfter = pairingRetryAfterSeconds();
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json(pairingRateLimitPayload(retryAfter));
    }

    res.status(500).json({
      success: false,
      error: error.message,
      status: connectionStatus
    });
  }
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
    clearReconnectTimer();

    if (sock) {
      await sock.logout();
    }

    const { clearAuth } = await useMongoAuthState(getClientId());
    await clearAuth();

    latestQr = null;
    lastQrGeneratedAt = null;
    lastPairingCode = null;
    lastPairingRequestedAt = null;
    lastDisconnectReason = null;
    lastDisconnectAt = null;
    sock = null;
    connectedJid = null;
    connectedNumber = null;
    connectedName = null;
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

    clearReconnectTimer();
    latestQr = null;
    lastQrGeneratedAt = null;
    lastPairingCode = null;
    lastPairingRequestedAt = null;
    lastDisconnectReason = null;
    lastDisconnectAt = null;
    connectionStatus = "resetting";

    try {
      closeSocket();
    } catch (error) {
      console.log("Socket já estava fechado");
    }

    sock = null;
    connectedJid = null;
    connectedNumber = null;
    connectedName = null;

    const { clearAuth } = await useMongoAuthState(getClientId());
    await clearAuth();

    connectionStatus = "starting";

    await startBaileys({ force: true });

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
