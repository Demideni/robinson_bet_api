require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const { PLATFORM_ID, API_SECRET, makeSignature } = require("./helpers/passimpay");

const app = express();
app.use(cors());
app.use(express.json());

// ===== "База данных" в памяти (для прототипа) =====
// playerId -> { balance, nickname, email }
const players = new Map();

// orderId -> { orderId, userId, paymentId, amountFiat, address, destinationTag, status }
const deposits = new Map();

// roundId -> { roundId, playerId, bet, multiplier, status }
const rounds = new Map();

// ===== Вспомогательные функции =====
function generateId(prefix = "") {
  return (
    prefix +
    Math.random().toString(36).slice(2, 10) +
    Date.now().toString(36).slice(2)
  );
}

function getOrCreatePlayer(playerIdFromClient) {
  let playerId = playerIdFromClient;

  if (playerId && players.has(playerId)) {
    return { playerId, player: players.get(playerId) };
  }

  // создаём нового игрока
  playerId = generateId("p_");
  const player = {
    balance: 100, // стартовый демо-баланс
    nickname: null,
    email: null,
  };
  players.set(playerId, player);

  return { playerId, player };
}

// Аккуратное логирование (без секретов)
function log(...args) {
  console.log("[API]", ...args);
}

// ===== 1) Сессия игрока =====
// Возвращает playerId + баланс + профиль
app.get("/api/session", (req, res) => {
  try {
    const clientPlayerId =
      req.headers["x-player-id"] ||
      req.query.playerId ||
      req.body?.playerId;

    const { playerId, player } = getOrCreatePlayer(clientPlayerId);

    return res.json({
      playerId,
      balance: player.balance,
      nickname: player.nickname || null,
      email: player.email || null,
    });
  } catch (e) {
    console.error("GET /api/session error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// ===== 2) Регистрация / обновление профиля =====
app.post("/api/profile/register", (req, res) => {
  try {
    const { playerId, nickname, email } = req.body || {};

    if (!playerId) {
      return res.status(400).json({ error: "playerId is required" });
    }

    const trimmedNickname = (nickname || "").toString().trim();
    const trimmedEmail = (email || "").toString().trim();

    if (!trimmedNickname) {
      return res.status(400).json({ error: "Введите никнейм" });
    }

    let player = players.get(playerId);
    if (!player) {
      // если по какой-то причине игрока ещё нет – создаём
      player = {
        balance: 100,
        nickname: trimmedNickname,
        email: trimmedEmail || null,
      };
      players.set(playerId, player);
    } else {
      player.nickname = trimmedNickname;
      player.email = trimmedEmail || null;
    }

    log("Profile updated:", playerId, player.nickname, player.email);

    return res.json({
      playerId,
      balance: player.balance,
      nickname: player.nickname,
      email: player.email,
    });
  } catch (e) {
    console.error("POST /api/profile/register error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// ===== 3) Депозит через PassimPay =====
// Ожидаем: { userId, amountFiat, paymentId }
app.post("/api/deposit/create", async (req, res) => {
  try {
    const { userId, amountFiat, paymentId } = req.body || {};

    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }
    const amountNum = Number(amountFiat);
    if (!amountNum || amountNum <= 0) {
      return res.status(400).json({ error: "Invalid amountFiat" });
    }
    const paymentIdNum = Number(paymentId);
    if (!paymentIdNum) {
      return res.status(400).json({ error: "Invalid paymentId" });
    }

    if (!players.has(userId)) {
      // создаём игрока, если по какой-то причине нет
      getOrCreatePlayer(userId);
    }

    const orderId = generateId("d_");

    // Тело запроса к Passimpay
    const payload = {
      platform_id: PLATFORM_ID,
      payment_id: paymentIdNum,
      // сумма в фиате, которую мы хотим получить
      amount: amountNum,
      currency: "USD", // при необходимости поменяй на свою базовую валюту
      order_id: orderId,
      is_payment_multiple: 0,
      lifetime: 3600,
      callback_url: process.env.PASSIMPAY_CALLBACK_URL || "",
    };

    const sign = makeSignature(payload, API_SECRET);
    const body = { ...payload, sign };

    log("Creating PassimPay address", { userId, amountFiat: amountNum, paymentId: paymentIdNum });

    const resp = await fetch("https://api.passimpay.io/v2/address", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await resp.json();
    log("PassimPay /v2/address response:", data);

    if (!resp.ok || data.result !== 1) {
      return res.status(400).json({ error: "PassimPay error", details: data });
    }

    const payData = data.data || {};
    const address = payData.address || payData.payin_address || null;
    const destinationTag =
      payData.destination_tag ||
      payData.memo ||
      payData.payin_extra_id ||
      null;

    deposits.set(orderId, {
      orderId,
      userId,
      paymentId: paymentIdNum,
      amountFiat: amountNum,
      address,
      destinationTag,
      status: "pending",
    });

    return res.json({
      orderId,
      address,
      destinationTag,
    });
  } catch (e) {
    console.error("POST /api/deposit/create error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// ===== 4) Webhook PassimPay для депозитов =====
// PassimPay будет вызывать этот урл при поступлении оплаты
app.post("/passimpay/webhook/deposit", (req, res) => {
  try {
    const body = req.body || {};

    // В webhooks Passimpay обычно присылает sign в теле
    const { sign, ...dataForCheck } = body;
    const expectedSign = makeSignature(dataForCheck, API_SECRET);

    if (!sign || sign !== expectedSign) {
      console.warn("Invalid PassimPay webhook signature");
      return res.status(403).send("invalid signature");
    }

    const orderId = body.order_id || body.orderId;
    const status = body.status; // см. формат Passimpay: может быть 1 / "success" и т.п.

    if (!orderId || !deposits.has(orderId)) {
      console.warn("Deposit webhook: unknown orderId:", orderId);
      return res.status(200).send("ok");
    }

    const deposit = deposits.get(orderId);

    // если уже обработали — просто подтверждаем
    if (deposit.status === "confirmed") {
      return res.status(200).send("ok");
    }

    // Проверяем успешный статус
    const successStatuses = ["success", "paid", "1", 1];
    if (!successStatuses.includes(status)) {
      console.warn("Deposit webhook: non-success status:", status);
      return res.status(200).send("ok");
    }

    // Зачисляем фиатную сумму, которую запрашивали изначально
    const player = players.get(deposit.userId);
    if (!player) {
      console.warn("Deposit webhook: player not found:", deposit.userId);
      return res.status(200).send("ok");
    }

    player.balance += deposit.amountFiat;
    deposit.status = "confirmed";

    log("Deposit confirmed:", {
      orderId,
      userId: deposit.userId,
      amountFiat: deposit.amountFiat,
      newBalance: player.balance,
    });

    return res.status(200).send("ok");
  } catch (e) {
    console.error("webhook/deposit error:", e);
    return res.status(500).send("error");
  }
});

// ===== 5) Ставки =====

// Старт раунда
// body: { playerId, bet }
app.post("/api/bet/start", (req, res) => {
  try {
    const { playerId, bet } = req.body || {};
    if (!playerId) {
      return res.status(400).json({ error: "playerId is required" });
    }
    const betNum = Number(bet);
    if (!betNum || betNum <= 0) {
      return res.status(400).json({ error: "Invalid bet" });
    }

    let player = players.get(playerId);
    if (!player) {
      // если игрок не найден, создаём нового (но это в теории странно)
      const created = getOrCreatePlayer(playerId);
      player = created.player;
    }

    if (player.balance < betNum) {
      return res.status(400).json({ error: "Недостаточно средств" });
    }

    player.balance -= betNum;

    const roundId = generateId("r_");
    const round = {
      roundId,
      playerId,
      bet: betNum,
      multiplier: 1,
      status: "active",
    };
    rounds.set(roundId, round);

    log("Round started:", { roundId, playerId, bet: betNum, balance: player.balance });

    return res.json({
      roundId,
      balance: player.balance,
    });
  } catch (e) {
    console.error("POST /api/bet/start error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// Завершение раунда
// body: { playerId, roundId, result, multiplier }
app.post("/api/bet/finish", (req, res) => {
  try {
    const { playerId, roundId, result, multiplier } = req.body || {};

    if (!playerId || !roundId) {
      return res.status(400).json({ error: "playerId and roundId are required" });
    }

    const round = rounds.get(roundId);
    if (!round) {
      return res.status(400).json({ error: "Round not found" });
    }

    if (round.playerId !== playerId) {
      return res.status(403).json({ error: "Round does not belong to player" });
    }

    if (round.status !== "active") {
      // уже завершён, просто вернём актуальный баланс
      const player = players.get(playerId);
      return res.json({
        balance: player ? player.balance : 0,
        win: 0,
      });
    }

    let player = players.get(playerId);
    if (!player) {
      // на всякий случай создадим, но баланс уже будет странным
      const created = getOrCreatePlayer(playerId);
      player = created.player;
    }

    let win = 0;
    round.status = result === "won" ? "won" : "lost";
    round.multiplier = Number(multiplier) || 1;

    if (round.status === "won") {
      const m = Math.max(1, round.multiplier);
      win = round.bet * m;
      // округление до 2 знаков
      win = Math.round(win * 100) / 100;
      player.balance += win;
    }

    log("Round finished:", {
      roundId,
      playerId,
      result: round.status,
      bet: round.bet,
      multiplier: round.multiplier,
      win,
      balance: player.balance,
    });

    return res.json({
      balance: player.balance,
      win,
    });
  } catch (e) {
    console.error("POST /api/bet/finish error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// ===== 6) Проверка живости API =====
app.get("/", (req, res) => {
  res.json({ status: "API online" });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log("Bet / payment API listening on port", PORT);
});
