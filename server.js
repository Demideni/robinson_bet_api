require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const crypto = require("crypto");

// Хелпер PassimPay (как у тебя в проекте)
const { PLATFORM_ID, API_SECRET, makeSignature } = require("./helpers/passimpay");

const app = express();
app.use(cors());
app.use(express.json());

// ===== "База данных" в памяти (для прототипа) =====
const players = new Map();   // playerId -> { balance, nickname, email }
const deposits = new Map();  // orderId  -> { orderId, userId, paymentId, amountFiat, status }
const rounds = new Map();    // roundId  -> { roundId, playerId, bet, multiplier, result }

/**
 * Утилита: примитивный ID (для раундов / депозитов)
 */
function randomId(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`;
}

/**
 * Получить / создать игрока
 */
function getOrCreatePlayer(playerId) {
  if (!playerId) {
    playerId = randomId("player");
  }
  if (!players.has(playerId)) {
    players.set(playerId, {
      balance: 100,        // стартовый демо-баланс
      nickname: null,
      email: null
    });
  }
  return { playerId, player: players.get(playerId) };
}

// ============= 1) СЕССИЯ И ПРОФИЛЬ =============

/**
 * GET /api/session
 * Возвращает playerId, баланс и профиль
 */
app.get("/api/session", (req, res) => {
  try {
    let playerId = req.headers["x-player-id"] || null;
    const { playerId: id, player } = getOrCreatePlayer(playerId);
    return res.json({
      playerId: id,
      balance: player.balance,
      nickname: player.nickname,
      email: player.email
    });
  } catch (e) {
    console.error("GET /api/session error:", e);
    return res.status(500).json({ error: "session_error" });
  }
});

/**
 * POST /api/profile/register
 * body: { playerId, nickname, email }
 */
app.post("/api/profile/register", (req, res) => {
  try {
    let { playerId, nickname, email } = req.body || {};
    const normalizedName = (nickname || "").trim();
    if (!normalizedName) {
      return res.status(400).json({ error: "Nickname is required" });
    }

    const { playerId: id, player } = getOrCreatePlayer(playerId);
    player.nickname = normalizedName;
    player.email = (email || "").trim() || null;

    players.set(id, player);

    return res.json({
      playerId: id,
      balance: player.balance,
      nickname: player.nickname,
      email: player.email
    });
  } catch (e) {
    console.error("POST /api/profile/register error:", e);
    return res.status(500).json({ error: "profile_error" });
  }
});

// ============= 2) TELEGRAM WEBAPP LOGIN =============

/**
 * POST /api/telegram/webapp/login
 * body: { tgId, username }
 * ВАЖНО: здесь упрощённая версия без проверки подписи initData.
 * Для боевого режима нужно валидировать initData, но для прототипа этого достаточно.
 */
app.post("/api/telegram/webapp/login", (req, res) => {
  try {
    const { tgId, username } = req.body || {};
    if (!tgId) {
      return res.status(400).json({ error: "No tgId" });
    }

    const playerId = String(tgId);
    if (!players.has(playerId)) {
      players.set(playerId, {
        balance: 100,
        nickname: username || "TG_Player",
        email: null
      });
    }

    const player = players.get(playerId);
    return res.json({
      playerId,
      balance: player.balance,
      nickname: player.nickname,
      email: player.email
    });
  } catch (e) {
    console.error("POST /api/telegram/webapp/login error:", e);
    return res.status(500).json({ error: "telegram_login_error" });
  }
});

// ============= 3) СТАВКИ (BET START / FINISH) =============

/**
 * POST /api/bet/start
 * body: { playerId, bet }
 * Списывает ставку, создаёт раунд
 */
app.post("/api/bet/start", (req, res) => {
  try {
    let { playerId, bet } = req.body || {};
    bet = Number(bet);

    if (!bet || bet <= 0) {
      return res.status(400).json({ error: "Invalid bet" });
    }

    const result = getOrCreatePlayer(playerId);
    playerId = result.playerId;
    const player = result.player;

    if (player.balance < bet) {
      return res.status(400).json({ error: "Недостаточно средств" });
    }

    player.balance -= bet;

    const roundId = randomId("round");
    rounds.set(roundId, {
      roundId,
      playerId,
      bet,
      multiplier: 1,
      result: null
    });

    return res.json({
      roundId,
      balance: player.balance
    });
  } catch (e) {
    console.error("POST /api/bet/start error:", e);
    return res.status(500).json({ error: "bet_start_error" });
  }
});

/**
 * POST /api/bet/finish
 * body: { playerId, roundId, result, multiplier }
 * result: "won" | "lost"
 * multiplier: число
 */
app.post("/api/bet/finish", (req, res) => {
  try {
    let { playerId, roundId, result, multiplier } = req.body || {};
    multiplier = Number(multiplier) || 1;

    if (!roundId) {
      return res.status(400).json({ error: "roundId required" });
    }
    if (!["won", "lost"].includes(result)) {
      return res.status(400).json({ error: "Invalid result" });
    }

    const round = rounds.get(roundId);
    if (!round) {
      return res.status(400).json({ error: "Round not found" });
    }

    const { playerId: storedId, player } = getOrCreatePlayer(playerId || round.playerId);

    // Если уже завершён — просто возвращаем баланс
    if (round.result) {
      return res.json({
        balance: player.balance,
        win: 0
      });
    }

    round.result = result;
    round.multiplier = multiplier;

    let win = 0;
    if (result === "won") {
      win = round.bet * multiplier;
      player.balance += win;
    }

    rounds.set(roundId, round);
    players.set(storedId, player);

    return res.json({
      balance: player.balance,
      win
    });
  } catch (e) {
    console.error("POST /api/bet/finish error:", e);
    return res.status(500).json({ error: "bet_finish_error" });
  }
});

// ============= 4) ДЕПОЗИТ ЧЕРЕЗ PASSIMPAY =============

/**
 * POST /api/deposit/create
 * body: { userId, amountFiat, paymentId }
 * amountFiat — сумма в фиатных единицах (например, условные рубли / доллары),
 * paymentId  — ID монеты в PassimPay:
 *   10  - BTC
 *   20  - ETH (ERC20)
 *   71  - USDT (TRC20)
 *   70  - USDT (ERC20)
 */
app.post("/api/deposit/create", async (req, res) => {
  try {
    const { userId, amountFiat, paymentId } = req.body || {};

    if (!userId) {
      return res.status(400).json({ error: "userId required" });
    }
    const amountNum = Number(amountFiat);
    if (!amountNum || amountNum <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }
    if (!paymentId) {
      return res.status(400).json({ error: "paymentId required" });
    }

    // Создаём / гарантируем игрока
    const { playerId, player } = getOrCreatePlayer(userId);

    // Генерируем orderId для PassimPay
    const orderId = randomId("dep");

    // Тело запроса к PassimPay /v2/address (как мы настраивали ранее)
    const body = {
      platform_id: PLATFORM_ID,
      amount: amountNum,
      payment_id: paymentId,
      order_id: orderId,
      // Можно добавить meta / userId для удобства
      meta: {
        userId: playerId
      }
    };

    const sign = makeSignature(body, API_SECRET);

    const resp = await fetch("https://api.passimpay.io/v2/address", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-PLATFORM-ID": PLATFORM_ID,
        "X-SIGN": sign
      },
      body: JSON.stringify(body)
    });

    const data = await resp.json();
    console.log("PassimPay /v2/address response:", data);

    if (!resp.ok || data.result !== 1) {
      return res.status(400).json({ error: "PassimPay error", details: data });
    }

    // Сохраняем депозит в памяти
    deposits.set(orderId, {
      orderId,
      userId: playerId,
      paymentId,
      amountFiat: amountNum,
      status: "pending"
    });

    // В data.data.* у PassimPay обычно есть address / destination_tag и пр.
    const address = data?.data?.address || "";
    const destinationTag = data?.data?.destination_tag || null;

    return res.json({
      orderId,
      address,
      destinationTag
    });
  } catch (e) {
    console.error("POST /api/deposit/create error:", e);
    return res.status(500).json({ error: "deposit_create_error" });
  }
});

// ============= 5) WEBHOOK ОТ PASSIMPAY =============

/**
 * POST /api/passimpay/webhook
 * Точка входа для уведомлений PassimPay.
 * Здесь нужно:
 *  - проверить подпись
 *  - найти депозит по order_id
 *  - при успешном статусе зачислить на баланс игрока amount
 *
 * ВНИМАНИЕ: структура body зависит от PassimPay.
 * Ниже — базовая схема (которую мы настраивали ранее).
 */
app.post("/api/passimpay/webhook", (req, res) => {
  try {
    const body = req.body || {};

    // Проверка подписи (пример)
    const receivedSign = req.headers["x-sign"] || req.headers["x-signature"];
    const calcSign = makeSignature(body, API_SECRET);

    if (!receivedSign || receivedSign.toLowerCase() !== calcSign.toLowerCase()) {
      console.warn("webhook: invalid signature");
      return res.status(403).send("invalid signature");
    }

    const orderId = body.order_id || body.orderId;
    const status = body.status || body.payment_status; // зависит от реального формата
    const amountCrypto = Number(body.amount || 0);

    if (!orderId || !deposits.has(orderId)) {
      console.warn("webhook: unknown orderId", orderId);
      return res.status(200).send("ok");
    }

    const dep = deposits.get(orderId);
    if (dep.status === "done") {
      // уже обработан
      return res.status(200).send("ok");
    }

    // Простейшая логика: при "success" считаем, что депозит выполнен.
    // В PassimPay статусы могут быть другими (проверь в своём аккаунте).
    const successStatuses = ["success", "paid", "finished", 2];
    const isSuccess = successStatuses.includes(status) || successStatuses.includes(Number(status));

    if (!isSuccess) {
      console.log("webhook: not success status", status);
      dep.status = String(status);
      deposits.set(orderId, dep);
      return res.status(200).send("ok");
    }

    dep.status = "done";
    deposits.set(orderId, dep);

    // Зачисляем на баланс
    const { playerId, player } = getOrCreatePlayer(dep.userId);
    let creditAmount = dep.amountFiat;

    // Здесь можно делать конвертацию крипто->фиат по курсу,
    // но в прототипе считаем amountFiat уже нужной величиной.
    player.balance += creditAmount;
    players.set(playerId, player);

    console.log(`Deposit done for player ${playerId}: +${creditAmount}`);
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

// ============= 7) ЗАПУСК СЕРВЕРА =============
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log("Bet / payment API listening on port", PORT);
});
