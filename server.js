require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const crypto = require("crypto");

const { PLATFORM_ID, API_SECRET, makeSignature } = require("./helpers/passimpay");

const app = express();
app.use(cors());
app.use(express.json());

// ВРЕМЕННО: храним игроков и депозиты в памяти
const players = new Map();
const deposits = new Map();

function getOrCreatePlayer(playerId) {
  if (!players.has(playerId)) {
    players.set(playerId, {
      id: playerId,
      balance: 100.0, // демо-баланс
    });
  }
  return players.get(playerId);
}

// ---------- 1) Сессия игрока ----------
app.get("/api/session", (req, res) => {
  const playerId = "demo-player-1"; // потом заменим на реальный ID
  const player = getOrCreatePlayer(playerId);

  res.json({
    playerId: player.id,
    balance: player.balance,
  });
});

// ---------- 2) Создать депозит (получить адрес) ----------
app.post("/api/deposit/create", async (req, res) => {
  try {
    const userId = req.body.userId || "demo-player-1";
    const paymentId = Number(req.body.paymentId || 10); // ID монеты в PassimPay
    const amountFiat = Number(req.body.amountFiat || 50);

    const orderId = `dep_${userId}_${Date.now()}`;

    const body = {
      platformId: PLATFORM_ID,
      paymentId,
      orderId,
    };

    const signature = makeSignature(body);

    const resp = await fetch("https://api.passimpay.io/v2/address", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-signature": signature,
      },
      body: JSON.stringify(body),
    });

    const data = await resp.json();
    console.log("PassimPay /v2/address response:", data);

    if (!resp.ok || data.result !== 1) {
      return res.status(400).json({ error: "PassimPay error", details: data });
    }

    deposits.set(orderId, {
      orderId,
      userId,
      paymentId,
      amountFiat,
      status: "pending",
    });

    res.json({
      orderId,
      address: data.address,
      destinationTag: data.destinationTag || null,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Internal error" });
  }
});

// ---------- 3) Webhook по депозиту ----------
app.post("/passimpay/webhook/deposit", (req, res) => {
  const body = req.body;
  const receivedSignature = req.headers["x-signature"];

  const serializedBody = JSON.stringify(body);
  const signatureContract = `${PLATFORM_ID};${serializedBody};${API_SECRET}`;
  const expectedSignature = crypto
    .createHmac("sha256", API_SECRET)
    .update(signatureContract)
    .digest("hex");

  if (!receivedSignature || receivedSignature !== expectedSignature) {
    console.warn("Invalid PassimPay signature");
    return res.status(400).send("Invalid signature");
  }

  const { type, orderId, amountReceive } = body;

  if (type !== "deposit") {
    return res.status(200).send("ignored");
  }

  const dep = deposits.get(orderId);
  if (!dep) {
    console.warn("Deposit not found for orderId", orderId);
    return res.status(200).send("ok");
  }

  if (dep.status === "success") {
    return res.status(200).send("ok");
  }

  dep.status = "success";
  dep.amountCrypto = amountReceive;

  const player = getOrCreatePlayer(dep.userId);
  // пока просто начисляем amountReceive как монеты 1:1
  player.balance += Number(amountReceive || 0);

  console.log(`Deposit success: user=${dep.userId}, +${amountReceive}`);
  return res.status(200).send("ok");
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log("Bet / payment API listening on port", PORT);
});

