require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const crypto = require("crypto");

const { PLATFORM_ID, API_SECRET, makeSignature } = require("./helpers/passimpay");

const app = express();
app.use(cors());
app.use(express.json());

// ===== "База данных" в памяти (для прототипа) =====
const players = new Map();
const deposits = new Map();
const rounds = new Map(); // раунды ставок

function getOrCreatePlayer(playerId) {
  if (!players.has(playerId)) {
    players.set(playerId, {
      id: playerId,
      balance: 100.0, // стартовый демо-баланс
    });
  }
  return players.get(playerId);
}

// ============= 1) СЕССИЯ ИГРОКА =============
app.get("/api/session", (req, res) => {
  const playerId = "demo-player-1"; // потом заменим на реальную авторизацию
  const player = getOrCreatePlayer(playerId);

  res.json({
    playerId: player.id,
    balance: player.balance,
  });
});

// ============= 2) СТАВКА: СТАРТ РАУНДА =============
app.post("/api/bet/start", (req, res) => {
  try {
    const { playerId, bet } = req.body;

    if (!playerId || !bet || bet <= 0) {
      return res.status(400).json({ error: "Invalid bet" });
    }

    const player = getOrCreatePlayer(playerId);

    if (player.balance < bet) {
      return res.status(400).json({ error: "Not enough balance" });
    }

    // списываем ставку
    player.balance -= bet;

    const roundId = "round_" + crypto.randomBytes(8).toString("hex");
    rounds.set(roundId, {
      id: roundId,
      playerId,
      bet,
      status: "in_progress",
      multiplier: 1,
    });

    res.json({
      roundId,
      balance: player.balance,
    });
  } catch (e) {
    console.error("bet/start error:", e);
    res.status(500).json({ error: "Internal error" });
  }
});

// ============= 3) СТАВКА: ЗАВЕРШЕНИЕ РАУНДА =============
app.post("/api/bet/finish", (req, res) => {
  try {
    const { playerId, roundId, result, multiplier } = req.body;

    if (!playerId || !roundId || !result) {
      return res.status(400).json({ error: "Invalid finish payload" });
    }

    const round = rounds.get(roundId);
    if (!round || round.playerId !== playerId) {
      return res.status(400).json({ error: "Round not found" });
    }

    if (round.status !== "in_progress") {
      return res.status(400).json({ error: "Round already finished" });
    }

    const player = getOrCreatePlayer(playerId);

    let winAmount = 0;
    if (result === "win") {
      const m = Number(multiplier) || 1;
      winAmount = round.bet * m;
      player.balance += winAmount;
      round.multiplier = m;
      round.status = "win";
    } else {
      round.status = "lose";
    }

    res.json({
      balance: player.balance,
      win: winAmount,
      result: round.status,
    });
  } catch (e) {
    console.error("bet/finish error:", e);
    res.status(500).json({ error: "Internal error" });
  }
});

// ============= 4) СОЗДАНИЕ ДЕПОЗИТА (АДРЕС ОПЛАТЫ) =============
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
    console.error("deposit/create error:", e);
    res.status(500).json({ error: "Internal error" });
  }
});

// ============= 5) WEBHOOK ДЕПОЗИТА ОТ PASSIMPAY =============
app.post("/passimpay/webhook/deposit", (req, res) => {
  try {
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
    // временно: 1 к 1 к нашим монетам
    player.balance += Number(amountReceive || 0);

    console.log(`Deposit success: user=${dep.userId}, +${amountReceive}`);
    return res.status(200).send("ok");
  } catch (e) {
    console.error("webhook/deposit error:", e);
    return res.status(500).send("error");
  }
});

// ============= 6) ПРОСТОЙ РУТ ДЛЯ ПРОВЕРКИ =============
app.get("/", (req, res) => {
  res.json({ status: "API online" });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log("Bet / payment API listening on port", PORT);
});
