// helpers/passimpay.js
const crypto = require("crypto");

const PLATFORM_ID = Number(process.env.PASSIMPAY_PLATFORM_ID);
const API_SECRET = process.env.PASSIMPAY_API_KEY;

/**
 * Формирует подпись для запросов в PassimPay
 */
function makeSignature(body) {
  const serializedBody = JSON.stringify(body).replace(/\//g, "\\/");
  const signatureContract = `${PLATFORM_ID};${serializedBody};${API_SECRET}`;

  return crypto
    .createHmac("sha256", API_SECRET)
    .update(signatureContract)
    .digest("hex");
}

module.exports = {
  PLATFORM_ID,
  API_SECRET,
  makeSignature,
};

