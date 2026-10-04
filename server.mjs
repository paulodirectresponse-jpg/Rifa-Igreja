import { createServer } from "node:http";
import {
  createReadStream,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, sep } from "node:path";
import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./public/", import.meta.url));
try {
  const envText = await readFile(
    fileURLToPath(new URL("./.env", import.meta.url)),
    "utf8",
  );
  for (const line of envText.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !(match[1] in process.env))
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
} catch {}
const port = Number(process.env.PORT || 4173);
const adminPassword = process.env.ADMIN_PASSWORD?.trim();
if (!adminPassword)
  throw new Error("Defina ADMIN_PASSWORD no .env antes de iniciar o servidor.");
const mpToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
const mpPublicKey = process.env.MERCADOPAGO_PUBLIC_KEY?.trim();
const mpWebhookSecret = process.env.MERCADOPAGO_WEBHOOK_SECRET;
const mpTestMode = process.env.MERCADOPAGO_TEST_MODE === "true";
const publicBaseUrl = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
const resendApiKey = process.env.RESEND_API_KEY;
const receiptEmailFrom = process.env.RECEIPT_EMAIL_FROM;
const mpServerConfigured = !!(
  mpToken &&
  publicBaseUrl?.startsWith("https://") &&
  (mpTestMode || mpWebhookSecret)
);
const checkoutConfigured = !!(mpServerConfigured && mpPublicKey);
const configuredPaymentMode = !checkoutConfigured
  ? "unavailable"
  : mpTestMode
    ? "test"
    : "live";
const emailConfigured = !!(
  resendApiKey &&
  receiptEmailFrom &&
  publicBaseUrl?.startsWith("https://")
);
const sessions = new Map();
const loginAttempts = new Map();
const holds = new Map();
const orders = [];
const sold = new Set();
const reserved = new Set();
const receiptRequests = new Map();
const dataPath = process.env.RAFFLE_DATA_DIR
  ? join(process.env.RAFFLE_DATA_DIR, "raffle.json")
  : fileURLToPath(new URL("./data/raffle.json", import.meta.url));
let liveInitialized = false;
let firstLiveInitialization = false;
let salesClosed = false;
let drawResult = null;

function saveState() {
  mkdirSync(dirname(dataPath), { recursive: true });
  const tempPath = `${dataPath}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(
    tempPath,
    JSON.stringify(
      { version: 1, liveInitialized, paymentMode: configuredPaymentMode, salesClosed, drawResult, sold: [...sold], orders },
      null,
      2,
    ),
    { encoding: "utf8", mode: 0o600 },
  );
  renameSync(tempPath, dataPath);
}

let storedState = null;
try {
  storedState = JSON.parse(readFileSync(dataPath, "utf8"));
  if (
    storedState.version !== 1 ||
    !Array.isArray(storedState.sold) ||
    !Array.isArray(storedState.orders)
  )
    throw new Error("Arquivo local da rifa inválido.");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (storedState) {
  liveInitialized = storedState.liveInitialized === true;
  salesClosed = storedState.salesClosed === true;
  drawResult = storedState.drawResult || null;
  if (mpServerConfigured && !liveInitialized) {
    liveInitialized = true;
    firstLiveInitialization = true;
  } else if (
    mpServerConfigured &&
    storedState.paymentMode === "test" &&
    configuredPaymentMode === "live"
  ) {
    liveInitialized = true;
    firstLiveInitialization = true;
  } else {
    if (
      mpServerConfigured &&
      configuredPaymentMode === "test" &&
      storedState.paymentMode === "live"
    )
      throw new Error(
        "A rifa já está em produção. Não é seguro voltar o ambiente para credenciais de teste.",
      );
    if (liveInitialized && !mpServerConfigured) {
      throw new Error(
        "Esta rifa já foi preparada para pagamentos reais. Restaure as configurações privadas do Mercado Pago no .env.",
      );
    }
    for (const number of storedState.sold)
      if (Number.isInteger(number) && number >= 1 && number <= 200)
        sold.add(number);
    orders.push(...storedState.orders);
    for (const order of orders) {
      if (order.status !== "pending") continue;
      if (
        order.expiresAt <= Date.now() ||
        order.numbers.some((number) => sold.has(number) || reserved.has(number))
      ) {
        order.status = "expired";
        continue;
      }
      holds.set(order.id, order);
      for (const number of order.numbers) reserved.add(number);
    }
  }
} else if (mpServerConfigured) {
  liveInitialized = true;
  firstLiveInitialization = true;
}
if (firstLiveInitialization) {
  salesClosed = false;
  drawResult = null;
}
saveState();

const json = (res, code, data, headers = {}) => {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(data));
};
const cookieValue = (req, name) =>
  (req.headers.cookie || "")
    .split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith(`${name}=`))
    ?.slice(name.length + 1);
function expireHolds() {
  const now = Date.now();
  let changed = false;
  for (const [id, hold] of holds)
    if (hold.expiresAt <= now) {
      for (const n of hold.numbers) reserved.delete(n);
      hold.status = "expired";
      holds.delete(id);
      changed = true;
    }
  for (const [token, expires] of sessions)
    if (expires <= now) sessions.delete(token);
  if (changed) saveState();
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (part) => {
      raw += part;
      if (raw.length > 24_000) reject(new Error("Corpo muito grande"));
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        reject(new Error("JSON inválido"));
      }
    });
    req.on("error", reject);
  });
}
function verifyMpSignature(signature, requestId, dataId) {
  if (!mpWebhookSecret || !signature || !requestId || !dataId) return false;
  const values = Object.fromEntries(
    signature.split(",").map((part) => part.trim().split("=", 2)),
  );
  if (!values.ts || !values.v1) return false;
  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${values.ts};`;
  const expected = createHmac("sha256", mpWebhookSecret)
    .update(manifest)
    .digest();
  let received;
  try {
    received = Buffer.from(values.v1, "hex");
  } catch {
    return false;
  }
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}
async function getMercadoPagoPayment(paymentId) {
  const response = await fetch(
    `https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`,
    { headers: { Authorization: `Bearer ${mpToken}` } },
  );
  if (!response.ok)
    throw new Error(`Mercado Pago respondeu ${response.status}`);
  return response.json();
}
function paymentSummary(payment, order) {
  const pix = payment.point_of_interaction?.transaction_data;
  return {
    paymentId: String(payment.id || ""),
    status: String(payment.status || "pending"),
    statusDetail: String(payment.status_detail || ""),
    expiresAt: order.expiresAt,
    threeDsInfo: payment.three_ds_info
      ? {
          externalResourceURL: payment.three_ds_info.external_resource_url || "",
          creq: payment.three_ds_info.creq || "",
        }
      : null,
    pix: pix
      ? { qrCode: pix.qr_code || "", qrCodeBase64: pix.qr_code_base64 || "" }
      : null,
  };
}

async function createMercadoPagoPayment(order, formData, idempotencyKey) {
  const method = String(formData?.payment_method_id || "").trim();
  const token = String(formData?.token || "").trim();
  const installments = Number(formData?.installments || 1);
  const issuer = formData?.issuer_id == null ? null : Number(formData.issuer_id);
  const identification = formData?.payer?.identification || {};
  const identificationType = String(identification.type || "").trim();
  const identificationNumber = String(identification.number || "").replace(/\D/g, "");
  if (!/^[a-z0-9_-]{2,40}$/i.test(method)) throw new Error("Meio de pagamento inválido");
  if (!identificationType || !identificationNumber) throw new Error("Documento do pagador não informado");
  if (method !== "pix" && (!token || !Number.isInteger(installments) || installments < 1 || installments > 24))
    throw new Error("Dados do cartão incompletos");

  if (method === "pix") order.expiresAt = Date.now() + 30 * 60 * 1000;
  const fullName = order.name.trim().split(/\s+/);
  const digits = order.phone.replace(/\D/g, "");
  const payer = {
    email: order.email,
    first_name: fullName[0],
    last_name: fullName.slice(1).join(" ") || undefined,
    identification: { type: identificationType, number: identificationNumber },
    ...(digits.length >= 10 ? { phone: { area_code: digits.slice(0, 2), number: digits.slice(2) } } : {}),
  };
  const payload = {
    transaction_amount: Number(order.amount),
    description: `Rifa beneficente · Igreja Ministério Catalunha · ${order.numbers.length} número(s)`,
    payment_method_id: method,
    external_reference: order.id,
    payer,
    ...(method === "pix"
      ? { date_of_expiration: new Date(order.expiresAt).toISOString() }
      : { token, installments }),
    ...(Number.isFinite(issuer) && issuer > 0 ? { issuer_id: issuer } : {}),
    ...(mpWebhookSecret ? { notification_url: `${publicBaseUrl}/api/webhooks/mercadopago` } : {}),
  };
  const response = await fetch("https://api.mercadopago.com/v1/payments", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${mpToken}`,
      "Content-Type": "application/json",
      "X-Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(payload),
  });
  const payment = await response.json();
  if (!response.ok || !payment.id)
    throw new Error(payment.message || `Mercado Pago respondeu ${response.status}`);
  if (payment.status !== "rejected") order.paymentId = String(payment.id);
  saveState();
  return payment;
}

function settleApprovedPayment(order, payment) {
  if (payment.status !== "approved") return;
  if (order.status !== "pending") {
    if (order.status !== "paid") order.status = "late_payment_review";
    return;
  }
  if (
    payment.external_reference !== order.id ||
    payment.currency_id !== "BRL" ||
    Math.round(Number(payment.transaction_amount) * 100) !==
      Math.round(order.amount * 100)
  ) {
    order.status = "payment_review";
    return;
  }
  const approvedAt = Date.parse(
    payment.date_approved || payment.date_created || "",
  );
  if (!Number.isFinite(approvedAt) || approvedAt > order.expiresAt) {
    order.status = "late_payment_review";
    return;
  }
  if (salesClosed) {
    order.status = "late_payment_review";
    return;
  }
  if (order.status === "paid") return;
  const conflict = order.numbers.some(
    (n) => sold.has(n) || (reserved.has(n) && !holds.has(order.id)),
  );
  if (conflict) {
    order.status = "payment_review";
    return;
  }
  for (const n of order.numbers) {
    reserved.delete(n);
    sold.add(n);
  }
  order.status = "paid";
  order.paidAt = approvedAt;
  order.paymentId = String(payment.id || "");
  holds.delete(order.id);
  saveState();
}
const escapeHTML = (value) =>
  String(value).replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
  );
const receiptLink = (orderId) => {
  const base = publicBaseUrl || `http://localhost:${port}`;
  return `${base}/comprovante?pedido=${encodeURIComponent(orderId)}`;
};
async function sendReceiptEmail(order) {
  if (!emailConfigured || order.receiptEmailSentAt) return false;
  const link = receiptLink(order.id);
  const numbers = order.numbers
    .map((number) => String(number).padStart(3, "0"))
    .join(", ");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: receiptEmailFrom,
      to: [order.email],
      subject: "Comprovante da rifa beneficente · Igreja Ministério Catalunha",
      html: `<div style="font-family:Arial,sans-serif;color:#17243a;max-width:560px;margin:auto"><h1>Pagamento confirmado</h1><p>Olá, ${escapeHTML(order.name)}. Sua participação na rifa beneficente da Igreja Evangelística Ministério Catalunha foi confirmada.</p><p><strong>Números:</strong> ${numbers}<br><strong>Total:</strong> ${money(order.amount)}</p><p><a href="${link}" style="display:inline-block;background:#315fbd;color:#fff;padding:14px 20px;border-radius:8px;text-decoration:none">Abrir comprovante seguro</a></p><p>Guarde este e-mail para consultar seus números quando precisar.</p></div>`,
    }),
  });
  if (!response.ok) return false;
  order.receiptEmailSentAt = Date.now();
  saveState();
  return true;
}
function money(value) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(value);
}
const isAdmin = (req) => {
  expireHolds();
  const token = cookieValue(req, "rifa_admin");
  return token && sessions.has(token) && sessions.get(token) > Date.now();
};
const html = (res, name) => {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  createReadStream(join(root, name)).pipe(res);
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  expireHolds();
  try {
    if (req.method === "GET" && url.pathname === "/healthz")
      return json(res, 200, { ok: true });
    if (req.method === "GET" && url.pathname === "/api/payment-config") {
      if (!checkoutConfigured)
        return json(res, 503, { error: "Pagamento seguro ainda não configurado." });
      return json(res, 200, { publicKey: mpPublicKey, testMode: mpTestMode });
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      const numbers = Array.from({ length: 200 }, (_, i) => ({
        number: i + 1,
        status: sold.has(i + 1)
          ? "sold"
          : reserved.has(i + 1)
            ? "reserved"
            : "available",
      }));
      return json(res, 200, {
        numbers,
        price: 20,
        total: 200,
        sold: sold.size,
        reserved: reserved.size,
        available: 200 - sold.size - reserved.size,
        paymentMode: checkoutConfigured ? configuredPaymentMode : "unavailable",
        salesOpen: !salesClosed,
        drawResult,
      });
    }
    if (req.method === "POST" && url.pathname === "/api/hold") {
      if (!checkoutConfigured)
        return json(res, 503, { error: "O pagamento ainda está sendo configurado. Tente novamente mais tarde." });
      if (salesClosed)
        return json(res, 409, {
          error: "As vendas foram encerradas para a realização do sorteio.",
        });
      const { numbers, name, email, phone } = await readBody(req);
      if (
        !Array.isArray(numbers) ||
        !numbers.length ||
        numbers.length > 20 ||
        !name?.trim() ||
        !/^\S+@\S+\.\S+$/.test(email || "") ||
        !phone?.trim()
      )
        return json(res, 400, {
          error: "Confira seus dados e selecione de 1 a 20 números.",
        });
      const unique = [...new Set(numbers.map(Number))];
      if (
        unique.length !== numbers.length ||
        unique.some(
          (n) =>
            !Number.isInteger(n) ||
            n < 1 ||
            n > 200 ||
            sold.has(n) ||
            reserved.has(n),
        )
      )
        return json(res, 409, {
          error:
            "Um ou mais números não estão mais disponíveis. Atualize a seleção.",
        });
      const id = randomBytes(16).toString("hex");
      const hold = {
        id,
        numbers: unique,
        name: name.trim(),
        email: email.trim(),
        phone: phone.trim(),
        testPayment: checkoutConfigured && mpTestMode,
        createdAt: Date.now(),
        expiresAt: Date.now() + 30 * 60 * 1000,
        status: "pending",
        amount: unique.length * 20,
      };
      for (const n of unique) reserved.add(n);
      holds.set(id, hold);
      orders.unshift(hold);
      saveState();
      return json(res, 201, {
        id,
        expiresAt: hold.expiresAt,
        amount: hold.amount,
        numbers: hold.numbers,
        paymentMode: "mercadopago",
      });
    }
    if (req.method === "POST" && url.pathname === "/api/payments") {
      if (!checkoutConfigured)
        return json(res, 503, { error: "Pagamento seguro ainda não configurado." });
      const { orderId, formData, idempotencyKey } = await readBody(req);
      if (!/^[a-f0-9]{32}$/i.test(orderId || "") || !/^[0-9a-f-]{16,64}$/i.test(idempotencyKey || ""))
        return json(res, 400, { error: "Solicitação de pagamento inválida." });
      const order = orders.find((item) => item.id === orderId);
      if (!order)
        return json(res, 404, { error: "Pedido não encontrado." });
      if (order.status !== "pending" || order.expiresAt <= Date.now())
        return json(res, 410, { error: "A reserva expirou. Escolha os números novamente." });
      if (salesClosed)
        return json(res, 409, { error: "As vendas foram encerradas para a realização do sorteio." });
      if (order.numbers.some((n) => !reserved.has(n)))
        return json(res, 409, { error: "A reserva não está mais disponível." });

      if (/^\d{1,30}$/.test(order.paymentId || "")) {
        try {
          const existing = await getMercadoPagoPayment(order.paymentId);
          if (["approved", "pending", "in_process", "authorized"].includes(existing.status)) {
            settleApprovedPayment(order, existing);
            return json(res, 200, paymentSummary(existing, order));
          }
        } catch {}
      }

      try {
        const payment = await createMercadoPagoPayment(order, formData, idempotencyKey);
        settleApprovedPayment(order, payment);
        if (order.status === "paid") {
          try { await sendReceiptEmail(order); } catch {}
        }
        return json(res, 201, paymentSummary(payment, order));
      } catch (error) {
        console.error("Payment creation failed", error?.message || error);
        return json(res, 502, { error: "Não foi possível processar o pagamento. Confira os dados e tente novamente." });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/demo/confirm") {
      if (mpServerConfigured)
        return json(res, 403, {
          error: "Confirmações simuladas estão desativadas.",
        });
      const { id } = await readBody(req);
      const hold = holds.get(id);
      if (!hold || hold.expiresAt <= Date.now())
        return json(res, 410, {
          error: "A reserva expirou. Escolha os números novamente.",
        });
      for (const n of hold.numbers) {
        reserved.delete(n);
        sold.add(n);
      }
      hold.status = "paid_demo";
      hold.paidAt = Date.now();
      holds.delete(id);
      saveState();
      return json(res, 200, { ok: true, receiptUrl: receiptLink(hold.id) });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/order-status/")) {
      const id = decodeURIComponent(
        url.pathname.slice("/api/order-status/".length),
      );
      const order = orders.find((item) => item.id === id);
      if (!order) return json(res, 404, { error: "Pedido não encontrado." });
      const requestedPaymentId = url.searchParams.get("payment_id");
      const paymentId = /^\d{1,30}$/.test(requestedPaymentId || "")
        ? requestedPaymentId
        : order.paymentId;
      if (
        mpServerConfigured &&
        order.status === "pending" &&
        /^\d{1,30}$/.test(paymentId || "")
      ) {
        try {
          const payment = await getMercadoPagoPayment(paymentId);
          if (payment.external_reference === order.id) {
            settleApprovedPayment(order, payment);
            saveState();
            if (order.status === "paid") {
              try {
                await sendReceiptEmail(order);
              } catch {}
            }
          }
        } catch {}
      }
      return json(res, 200, {
        status: order.status,
        expiresAt: order.expiresAt,
        paymentId: order.paymentId || null,
      });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/receipt/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/receipt/".length));
      if (!/^[a-f0-9]{32}$/i.test(id))
        return json(res, 404, { error: "Comprovante não encontrado." });
      const order = orders.find((item) => item.id === id);
      if (!order || !["paid", "paid_demo"].includes(order.status))
        return json(res, 404, { error: "Comprovante não encontrado." });
      return json(res, 200, {
        name: order.name,
        email: String(order.email || "").replace(/(^.).*(@.*$)/, "$1•••$2"),
        numbers: order.numbers,
        amount: order.amount,
        paidAt: order.paidAt || order.createdAt || order.expiresAt - 30 * 60 * 1000,
        demo: order.status === "paid_demo",
        receiptUrl: receiptLink(order.id),
      });
    }
    if (req.method === "POST" && url.pathname === "/api/receipt-link") {
      const { email } = await readBody(req);
      if (!/^\S+@\S+\.\S+$/.test(email || ""))
        return json(res, 400, { error: "Informe um e-mail válido." });
      const address = req.socket.remoteAddress || "unknown";
      const normalizedEmail = email.trim().toLowerCase();
      const now = Date.now();
      const key = `${address}:${normalizedEmail}`;
      const recent = (receiptRequests.get(key) || []).filter(
        (time) => now - time < 15 * 60 * 1000,
      );
      if (recent.length >= 3)
        return json(res, 429, {
          error: "Aguarde alguns minutos antes de pedir outro link.",
        });
      recent.push(now);
      receiptRequests.set(key, recent);
      if (emailConfigured) {
        const matches = orders.filter(
          (order) =>
            order.email.toLowerCase() === normalizedEmail &&
            ["paid", "paid_demo"].includes(order.status),
        );
        for (const order of matches) {
          order.receiptEmailSentAt = null;
          try {
            await sendReceiptEmail(order);
          } catch {}
        }
      }
      return json(res, 200, {
        ok: true,
        emailConfigured,
        message:
          "Se houver compras confirmadas com esse e-mail, enviaremos um link seguro para consulta.",
      });
    }
    if (req.method === "POST" && url.pathname === "/api/webhooks/mercadopago") {
      if (!mpServerConfigured || !mpWebhookSecret)
        return json(res, 503, {
          error: "Webhooks do Mercado Pago não configurados.",
        });
      const body = await readBody(req);
      const dataId = url.searchParams.get("data.id") || body.data?.id;
      const requestId = req.headers["x-request-id"];
      if (
        !verifyMpSignature(
          req.headers["x-signature"],
          requestId,
          String(dataId || ""),
        )
      )
        return json(res, 401, { error: "Assinatura inválida." });
      if (body.type !== "payment" || !dataId)
        return json(res, 200, { ok: true });
      const payment = await getMercadoPagoPayment(dataId);
      const order = orders.find(
        (item) => item.id === payment.external_reference,
      );
      if (order) {
        settleApprovedPayment(order, payment);
        saveState();
        if (order.status === "paid") {
          try {
            await sendReceiptEmail(order);
          } catch {}
        }
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/login") {
      const { password } = await readBody(req);
      const address = req.socket.remoteAddress || "unknown";
      const attempt = loginAttempts.get(address);
      if (attempt?.blockedUntil > Date.now())
        return json(
          res,
          429,
          { error: "Muitas tentativas. Aguarde 15 minutos e tente novamente." },
          {
            "Retry-After": String(
              Math.ceil((attempt.blockedUntil - Date.now()) / 1000),
            ),
          },
        );
      const a = Buffer.from(String(password || ""));
      const b = Buffer.from(adminPassword);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        const count = (attempt?.count || 0) + 1;
        loginAttempts.set(address, {
          count,
          blockedUntil: count >= 5 ? Date.now() + 15 * 60 * 1000 : 0,
        });
        return json(res, 401, { error: "Senha incorreta." });
      }
      loginAttempts.delete(address);
      const token = randomBytes(32).toString("base64url");
      sessions.set(token, Date.now() + 8 * 60 * 60 * 1000);
      const secure = publicBaseUrl?.startsWith("https://") ? "; Secure" : "";
      return json(
        res,
        200,
        { ok: true },
        {
          "Set-Cookie": `rifa_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure}`,
        },
      );
    }
    if (req.method === "POST" && url.pathname === "/api/admin/logout") {
      const token = cookieValue(req, "rifa_admin");
      if (token) sessions.delete(token);
      return json(
        res,
        200,
        { ok: true },
        {
          "Set-Cookie":
            "rifa_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        },
      );
    }
    if (req.method === "POST" && url.pathname === "/api/admin/sales") {
      if (!isAdmin(req)) return json(res, 401, { error: "Acesso restrito." });
      const { closed } = await readBody(req);
      if (typeof closed !== "boolean")
        return json(res, 400, { error: "Informe se as vendas serão encerradas." });
      if (drawResult && !closed)
        return json(res, 409, {
          error: "As vendas não podem ser reabertas depois do sorteio.",
        });
      salesClosed = closed;
      if (closed) {
        for (const [id, hold] of holds) {
          for (const number of hold.numbers) reserved.delete(number);
          hold.status = "expired";
          holds.delete(id);
        }
        for (const order of orders)
          if (order.status === "pending") order.status = "expired";
      }
      saveState();
      return json(res, 200, { ok: true, salesClosed });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/draw") {
      if (!isAdmin(req)) return json(res, 401, { error: "Acesso restrito." });
      if (!salesClosed)
        return json(res, 409, {
          error: "Encerre as vendas antes de iniciar o sorteio.",
        });
      if (drawResult)
        return json(res, 409, { error: "O sorteio desta rifa já foi realizado." });
      const pool = [
        ...new Set(
          orders
            .filter((order) => ["paid", "paid_demo"].includes(order.status))
            .flatMap((order) => order.numbers),
        ),
      ];
      if (pool.length < 3)
        return json(res, 409, {
          error: "São necessários ao menos três números pagos para sortear os prêmios.",
        });
      for (let i = pool.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      drawResult = {
        drawnAt: Date.now(),
        winners: pool.slice(0, 3).map((number, index) => ({
          place: index + 1,
          number,
        })),
      };
      saveState();
      return json(res, 200, { drawResult });
    }
    if (req.method === "GET" && url.pathname === "/api/admin/overview") {
      if (!isAdmin(req)) return json(res, 401, { error: "Acesso restrito." });
      const paidOrders = orders.filter(
        (o) => o.status === "paid_demo" || o.status === "paid",
      );
      const pendingOrders = orders.filter(
        (o) => o.status === "pending" && o.expiresAt > Date.now(),
      );
      return json(res, 200, {
        total: 200,
        sold: sold.size,
        reserved: reserved.size,
        available: 200 - sold.size - reserved.size,
        gross: sold.size * 20,
        paymentMode: mpConfigured ? "mercadopago" : "demo",
        testMode: mpTestMode,
        emailConfigured,
        paidNumberCount: new Set(
          paidOrders.flatMap((order) => order.numbers),
        ).size,
        salesClosed,
        drawResult,
        orders: [...orders]
          .slice(0, 40)
          .map(
            ({
              id,
              name,
              email,
              phone,
              numbers,
              amount,
              status,
              expiresAt,
            }) => ({
              id: id.slice(0, 8),
              name,
              email,
              phone,
              numbers,
              amount,
              status,
              expiresAt,
            }),
          ),
        paidCount: paidOrders.length,
        pendingCount: pendingOrders.length,
      });
    }
    if (req.method === "GET" && url.pathname === "/admin")
      return html(res, "admin.html");
    if (
      req.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/comprovante")
    )
      return html(res, "index.html");
    if (
      req.method === "GET" &&
      ["/styles.css", "/app.js", "/admin.js"].includes(url.pathname)
    ) {
      const file = join(root, url.pathname.slice(1));
      const mime = url.pathname.endsWith(".css")
        ? "text/css; charset=utf-8"
        : "text/javascript; charset=utf-8";
      await stat(file);
      res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-cache" });
      return createReadStream(file).pipe(res);
    }
    if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
      const file = normalize(
        join(root, ...decodeURIComponent(url.pathname).slice(1).split("/")),
      );
      if (!file.startsWith(`${normalize(join(root, "assets"))}${sep}`))
        return json(res, 404, { error: "Não encontrado." });
      const mime =
        {
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".svg": "image/svg+xml",
          ".webp": "image/webp",
        }[extname(file)] || "application/octet-stream";
      await stat(file);
      res.writeHead(200, {
        "Content-Type": mime,
        "Cache-Control": "public, max-age=86400",
      });
      return createReadStream(file).pipe(res);
    }
    return json(res, 404, { error: "Não encontrado." });
  } catch (error) {
    return json(res, 500, { error: "Não foi possível concluir esta ação." });
  }
});

server.listen(port, process.env.HOST || "127.0.0.1", () => {
  console.log(`Rifa beneficente da Igreja Ministério Catalunha em http://localhost:${port}`);
  console.log(`Painel administrativo: http://localhost:${port}/admin`);
  console.log("Senha administrativa configurada; valor omitido do log.");
  console.log(
    mpConfigured
      ? "Checkout do Mercado Pago habilitado."
      : "Checkout em modo demonstração; configure credenciais do Mercado Pago e uma URL HTTPS pública para pagamentos de teste.",
  );
  if (firstLiveInitialization)
    console.log(
      configuredPaymentMode === "test"
        ? "Ambiente de teste preparado: pedidos antigos foram removidos para testar sem misturar a prévia anterior."
        : "Ambiente de produção preparado: pedidos de teste e demonstração foram removidos; todos os números começam disponíveis.",
    );
});
