const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });

const money = (value) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
const hex = (bytes) => [...new Uint8Array(bytes)].map((x) => x.toString(16).padStart(2, "0")).join("");
const digest = async (value) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
const randomToken = (bytes = 32) => {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return [...value].map((x) => x.toString(16).padStart(2, "0")).join("");
};
const safeEqual = (left, right) => {
  const a = new TextEncoder().encode(String(left));
  const b = new TextEncoder().encode(String(right));
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] || 0) ^ (b[i] || 0);
  return diff === 0;
};
const readJson = async (request) => {
  const raw = await request.text();
  if (raw.length > 24_000) throw new Error("Corpo muito grande");
  return JSON.parse(raw || "{}");
};
const cookie = (request, key) => request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${key}=`))?.slice(key.length + 1);
const baseUrl = (env, request) => (env.PUBLIC_BASE_URL || new URL(request.url).origin).replace(/\/$/, "");
const mpServerConfigured = (env) => Boolean(env.MERCADOPAGO_ACCESS_TOKEN && env.PUBLIC_BASE_URL?.startsWith("https://") && (env.MERCADOPAGO_TEST_MODE === "true" || env.MERCADOPAGO_WEBHOOK_SECRET));
const checkoutConfigured = (env) => Boolean(mpServerConfigured(env) && env.MERCADOPAGO_PUBLIC_KEY);
const paymentMode = (env) => !checkoutConfigured(env) ? "unavailable" : env.MERCADOPAGO_TEST_MODE === "true" ? "test" : "live";

async function expireHolds(db, now) {
  await db.batch([
    db.prepare("UPDATE raffle_numbers SET status='available', order_id=NULL WHERE status='reserved' AND order_id IN (SELECT id FROM raffle_orders WHERE status='pending' AND expires_at<=?)").bind(now),
    db.prepare("UPDATE raffle_orders SET status='expired' WHERE status='pending' AND expires_at<=?").bind(now),
    db.prepare("DELETE FROM admin_sessions WHERE expires_at<=?").bind(now),
    db.prepare("DELETE FROM receipt_requests WHERE requested_at<?").bind(now - 15 * 60_000),
  ]);
}

async function getOrder(db, id) {
  const row = await db.prepare("SELECT * FROM raffle_orders WHERE id=?").bind(id).first();
  return row ? { ...row, numbers: JSON.parse(row.numbers_json) } : null;
}
const publicReceiptLink = (env, request, id) => `${baseUrl(env, request)}/comprovante?pedido=${encodeURIComponent(id)}`;

async function verifySignature(secret, signature, requestId, dataId) {
  if (!secret || !signature || !requestId || !dataId) return false;
  const values = Object.fromEntries(signature.split(",").map((part) => part.trim().split("=", 2)));
  if (!values.ts || !values.v1) return false;
  const manifest = `id:${String(dataId).toLowerCase()};request-id:${requestId};ts:${values.ts};`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return safeEqual(hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(manifest))), values.v1.toLowerCase());
}

async function mpPayment(env, id) {
  const response = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${env.MERCADOPAGO_ACCESS_TOKEN}` } });
  if (!response.ok) throw new Error("Falha ao consultar pagamento");
  return response.json();
}

const paymentSummary = (payment, order) => {
  const pix = payment.point_of_interaction?.transaction_data;
  return {
    paymentId: String(payment.id || ""),
    status: String(payment.status || "pending"),
    statusDetail: String(payment.status_detail || ""),
    expiresAt: order.expires_at,
    threeDsInfo: payment.three_ds_info
      ? {
          externalResourceURL: payment.three_ds_info.external_resource_url || "",
          creq: payment.three_ds_info.creq || "",
        }
      : null,
    pix: pix
      ? {
          qrCode: pix.qr_code || "",
          qrCodeBase64: pix.qr_code_base64 || "",
        }
      : null,
  };
};

async function createMercadoPagoPayment(env, request, order, formData, idempotencyKey) {
  const method = String(formData?.payment_method_id || "").trim();
  const token = String(formData?.token || "").trim();
  const installments = Number(formData?.installments || 1);
  const issuer = formData?.issuer_id == null ? null : Number(formData.issuer_id);
  const identification = formData?.payer?.identification || {};
  const identificationType = String(identification.type || "").trim();
  const identificationNumber = String(identification.number || "").replace(/\D/g, "");
  if (!/^[a-z0-9_-]{2,40}$/i.test(method)) throw new Error("Meio de pagamento inválido");
  if (!identificationType || !identificationNumber) throw new Error("Documento do pagador não informado");
  if (method !== "pix" && (!token || !Number.isInteger(installments) || installments < 1 || installments > 24)) {
    throw new Error("Dados do cartão incompletos");
  }

  let expiresAt = order.expires_at;
  if (method === "pix") {
    expiresAt = Date.now() + 30 * 60_000;
    await env.DB.prepare("UPDATE raffle_orders SET expires_at=? WHERE id=? AND status='pending'").bind(expiresAt, order.id).run();
    order.expires_at = expiresAt;
  }

  const parts = order.name.trim().split(/\s+/);
  const digits = order.phone.replace(/\D/g, "");
  const payer = {
    email: order.email,
    first_name: parts[0],
    last_name: parts.slice(1).join(" ") || undefined,
    identification: { type: identificationType, number: identificationNumber },
    ...(digits.length >= 10 ? { phone: { area_code: digits.slice(0, 2), number: digits.slice(2) } } : {}),
  };
  const payload = {
    transaction_amount: Number(order.amount),
    description: `Rifa beneficente · Igreja Ministério Catalunha · ${order.numbers.length} número(s)`,
    payment_method_id: method,
    external_reference: order.id,
    payer,
    ...(method === "pix" ? { date_of_expiration: new Date(expiresAt).toISOString() } : { token, installments }),
    ...(Number.isFinite(issuer) && issuer > 0 ? { issuer_id: issuer } : {}),
    ...(env.MERCADOPAGO_WEBHOOK_SECRET ? { notification_url: `${baseUrl(env, request)}/api/webhooks/mercadopago` } : {}),
  };
  const response = await fetch("https://api.mercadopago.com/v1/payments", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.MERCADOPAGO_ACCESS_TOKEN}`,
      "content-type": "application/json",
      "x-idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(payload),
  });
  const payment = await response.json();
  if (!response.ok || !payment.id) {
    console.error("Mercado Pago payment error", response.status, payment?.error || payment?.message || "unknown");
    throw new Error("Mercado Pago não criou o pagamento");
  }
  if (payment.status !== "rejected") {
    await env.DB.prepare("UPDATE raffle_orders SET payment_id=?, expires_at=? WHERE id=? AND status='pending'").bind(String(payment.id), expiresAt, order.id).run();
  }
  return payment;
}

async function settle(db, order, payment, salesClosed) {
  if (!order || payment.status !== "approved") return;
  if (order.status !== "pending") {
    if (order.status !== "paid") await db.prepare("UPDATE raffle_orders SET status='late_payment_review' WHERE id=?").bind(order.id).run();
    return;
  }
  const approvedAt = Date.parse(payment.date_approved || payment.date_created || "");
  if (payment.external_reference !== order.id || payment.currency_id !== "BRL" || Math.round(Number(payment.transaction_amount) * 100) !== Math.round(order.amount * 100)) {
    await db.prepare("UPDATE raffle_orders SET status='payment_review' WHERE id=? AND status='pending'").bind(order.id).run(); return;
  }
  if (!Number.isFinite(approvedAt) || approvedAt > order.expires_at || salesClosed) {
    await db.prepare("UPDATE raffle_orders SET status='late_payment_review' WHERE id=? AND status='pending'").bind(order.id).run(); return;
  }
  const owned = await db.prepare("SELECT COUNT(*) AS count FROM raffle_numbers WHERE order_id=? AND status='reserved'").bind(order.id).first();
  if (owned.count !== order.numbers.length) {
    await db.prepare("UPDATE raffle_orders SET status='payment_review' WHERE id=? AND status='pending'").bind(order.id).run(); return;
  }
  await db.batch([
    db.prepare("UPDATE raffle_numbers SET status='sold' WHERE order_id=? AND status='reserved'").bind(order.id),
    db.prepare("UPDATE raffle_orders SET status='paid', paid_at=?, payment_id=? WHERE id=? AND status='pending'").bind(approvedAt, String(payment.id || ""), order.id),
  ]);
}

async function sendReceiptEmail(env, request, order) {
  if (!env.RESEND_API_KEY || !env.RECEIPT_EMAIL_FROM || order.receipt_email_sent_at) return;
  const nums = order.numbers.map((n) => String(n).padStart(3, "0")).join(", ");
  const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ from: env.RECEIPT_EMAIL_FROM, to: [order.email], subject: "Comprovante da rifa beneficente · Igreja Ministério Catalunha", html: `<p>Olá, ${escape(order.name)}. Seu pagamento foi confirmado.</p><p><b>Números:</b> ${nums}<br><b>Total:</b> ${money(order.amount)}</p><p><a href="${publicReceiptLink(env, request, order.id)}">Abrir comprovante seguro</a></p>` }) });
  if (response.ok) await env.DB.prepare("UPDATE raffle_orders SET receipt_email_sent_at=? WHERE id=?").bind(Date.now(), order.id).run();
}

async function adminOk(request, env) {
  const token = cookie(request, "rifa_admin");
  if (!token) return false;
  return Boolean(await env.DB.prepare("SELECT token_hash FROM admin_sessions WHERE token_hash=? AND expires_at>?").bind(await digest(token), Date.now()).first());
}

async function api(request, env) {
  if (!env.DB) return json({ error: "Banco D1 não configurado." }, 503);
  const url = new URL(request.url);
  const now = Date.now();
  await expireHolds(env.DB, now);
  const settings = () => env.DB.prepare("SELECT * FROM raffle_settings WHERE id=1").first();

  if (request.method === "GET" && url.pathname === "/api/payment-config") {
    if (!checkoutConfigured(env)) return json({ error: "Pagamento seguro ainda não configurado." }, 503);
    return json({ publicKey: env.MERCADOPAGO_PUBLIC_KEY, testMode: env.MERCADOPAGO_TEST_MODE === "true" });
  }

  if (request.method === "GET" && url.pathname === "/api/state") {
    const [rows, cfg] = await Promise.all([env.DB.prepare("SELECT number,status FROM raffle_numbers ORDER BY number").all(), settings()]);
    const numbers = rows.results;
    const sold = numbers.filter((n) => n.status === "sold").length;
    const reserved = numbers.filter((n) => n.status === "reserved").length;
    return json({ numbers, price: 20, total: 200, sold, reserved, available: 200 - sold - reserved, paymentMode: paymentMode(env), salesOpen: !cfg.sales_closed, drawResult: cfg.draw_result ? JSON.parse(cfg.draw_result) : null });
  }

  if (request.method === "POST" && url.pathname === "/api/hold") {
    if (!checkoutConfigured(env)) return json({ error: "O pagamento ainda está sendo configurado. Tente novamente mais tarde." }, 503);
    const cfg = await settings();
    if (cfg.sales_closed) return json({ error: "As vendas foram encerradas para a realização do sorteio." }, 409);
    const { numbers, name, email, phone } = await readJson(request);
    if (!Array.isArray(numbers) || !numbers.length || numbers.length > 20 || !name?.trim() || !/^\S+@\S+\.\S+$/.test(email || "") || !phone?.trim()) return json({ error: "Confira seus dados e selecione de 1 a 20 números." }, 400);
    const unique = [...new Set(numbers.map(Number))];
    if (unique.length !== numbers.length || unique.some((n) => !Number.isInteger(n) || n < 1 || n > 200)) return json({ error: "Selecione números válidos e sem repetição." }, 400);
    const id = randomToken(16);
    const expiresAt = now + 30 * 60_000;
    const order = { id, name: name.trim(), email: email.trim(), phone: phone.trim(), numbers: unique, amount: unique.length * 20, status: "pending", created_at: now, expires_at: expiresAt };
    await env.DB.prepare("INSERT INTO raffle_orders(id,name,email,phone,numbers_json,amount,status,test_payment,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(id, order.name, order.email, order.phone, JSON.stringify(unique), order.amount, "pending", paymentMode(env) === "test" ? 1 : 0, now, expiresAt).run();
    await env.DB.prepare(`UPDATE raffle_numbers SET status='reserved',order_id=? WHERE number IN (${unique.map(() => "?").join(",")}) AND status='available'`).bind(id, ...unique).run();
    const held = await env.DB.prepare("SELECT COUNT(*) AS count FROM raffle_numbers WHERE order_id=? AND status='reserved'").bind(id).first();
    if (held.count !== unique.length) {
      await env.DB.batch([env.DB.prepare("UPDATE raffle_numbers SET status='available',order_id=NULL WHERE order_id=?").bind(id), env.DB.prepare("DELETE FROM raffle_orders WHERE id=?").bind(id)]);
      return json({ error: "Um ou mais números não estão mais disponíveis. Atualize a seleção." }, 409);
    }
    return json({ id, expiresAt, amount: order.amount, numbers: unique, paymentMode: "mercadopago" }, 201);
  }

  if (request.method === "POST" && url.pathname === "/api/payments") {
    if (!checkoutConfigured(env)) return json({ error: "Pagamento seguro ainda não configurado." }, 503);
    const { orderId, formData, idempotencyKey } = await readJson(request);
    if (!/^[a-f0-9]{32}$/i.test(orderId || "") || !/^[0-9a-f-]{16,64}$/i.test(idempotencyKey || "")) {
      return json({ error: "Solicitação de pagamento inválida." }, 400);
    }
    let order = await getOrder(env.DB, orderId);
    if (!order) return json({ error: "Pedido não encontrado." }, 404);
    if (order.status !== "pending" || order.expires_at <= now) return json({ error: "A reserva expirou. Escolha os números novamente." }, 410);
    const cfg = await settings();
    if (cfg.sales_closed) return json({ error: "As vendas foram encerradas para a realização do sorteio." }, 409);
    const owned = await env.DB.prepare("SELECT COUNT(*) AS count FROM raffle_numbers WHERE order_id=? AND status='reserved'").bind(order.id).first();
    if (owned.count !== order.numbers.length) return json({ error: "A reserva não está mais disponível." }, 409);

    if (/^\d{1,30}$/.test(order.payment_id || "")) {
      try {
        const existing = await mpPayment(env, order.payment_id);
        if (["approved", "pending", "in_process", "authorized"].includes(existing.status)) {
          await settle(env.DB, order, existing, cfg.sales_closed);
          order = await getOrder(env.DB, order.id);
          return json(paymentSummary(existing, order), 200);
        }
      } catch {}
    }

    try {
      const payment = await createMercadoPagoPayment(env, request, order, formData, idempotencyKey);
      await settle(env.DB, order, payment, cfg.sales_closed);
      order = await getOrder(env.DB, order.id);
      if (order?.status === "paid") await sendReceiptEmail(env, request, order).catch(() => {});
      return json(paymentSummary(payment, order || { ...order, expires_at: order?.expires_at || now + 30 * 60_000 }), 201);
    } catch (error) {
      console.error("Payment creation failed", error?.message || error);
      return json({ error: "Não foi possível processar o pagamento. Confira os dados e tente novamente." }, 502);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/demo/confirm") {
    return json({ error: "Confirmações simuladas estão desativadas neste site." }, 403);
    const { id } = await readJson(request); const order = await getOrder(env.DB, id);
    if (!order || order.status !== "pending" || order.expires_at <= now) return json({ error: "A reserva expirou. Escolha os números novamente." }, 410);
    await env.DB.batch([env.DB.prepare("UPDATE raffle_numbers SET status='sold' WHERE order_id=? AND status='reserved'").bind(id), env.DB.prepare("UPDATE raffle_orders SET status='paid_demo',paid_at=? WHERE id=?").bind(now, id)]);
    return json({ ok: true, receiptUrl: publicReceiptLink(env, request, id) });
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/order-status/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/order-status/".length)); let order = await getOrder(env.DB, id);
    if (!order) return json({ error: "Pedido não encontrado." }, 404);
    const requestedPaymentId = url.searchParams.get("payment_id");
    const paymentId = /^\d{1,30}$/.test(requestedPaymentId || "") ? requestedPaymentId : order.payment_id;
    if (mpServerConfigured(env) && order.status === "pending" && /^\d{1,30}$/.test(paymentId || "")) {
      try { const payment = await mpPayment(env, paymentId); if (payment.external_reference === id) { const cfg = await settings(); await settle(env.DB, order, payment, cfg.sales_closed); order = await getOrder(env.DB, id); if (order?.status === "paid") await sendReceiptEmail(env, request, order); } } catch {}
    }
    return json({ status: order.status, expiresAt: order.expires_at, paymentId: order.payment_id || null });
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/receipt/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/receipt/".length));
    if (!/^[a-f0-9]{32}$/i.test(id)) return json({ error: "Comprovante não encontrado." }, 404);
    const order = await getOrder(env.DB, id);
    if (!order || !["paid", "paid_demo"].includes(order.status)) return json({ error: "Comprovante não encontrado." }, 404);
    return json({ name: order.name, email: order.email.replace(/(^.).*(@.*$)/, "$1•••$2"), numbers: order.numbers, amount: order.amount, paidAt: order.paid_at || order.created_at, demo: order.status === "paid_demo", receiptUrl: publicReceiptLink(env, request, id) });
  }

  if (request.method === "POST" && url.pathname === "/api/receipt-link") {
    const { email } = await readJson(request);
    if (!/^\S+@\S+\.\S+$/.test(email || "")) return json({ error: "Informe um e-mail válido." }, 400);
    const normalized = email.trim().toLowerCase(); const ipHash = await digest(request.headers.get("cf-connecting-ip") || "unknown"); const key = `${ipHash}:${normalized}`;
    const recent = await env.DB.prepare("SELECT COUNT(*) AS count FROM receipt_requests WHERE request_key=? AND requested_at>?").bind(key, now - 15 * 60_000).first();
    if (recent.count >= 3) return json({ error: "Aguarde alguns minutos antes de pedir outro link." }, 429);
    await env.DB.prepare("INSERT INTO receipt_requests(request_key,requested_at) VALUES(?,?)").bind(key, now).run();
    const emailConfigured = Boolean(env.RESEND_API_KEY && env.RECEIPT_EMAIL_FROM);
    if (emailConfigured) {
      const rows = await env.DB.prepare("SELECT * FROM raffle_orders WHERE lower(email)=? AND status IN ('paid','paid_demo')").bind(normalized).all();
      for (const row of rows.results) await sendReceiptEmail(env, request, { ...row, numbers: JSON.parse(row.numbers_json) }).catch(() => {});
    }
    return json({ ok: true, emailConfigured, message: "Se houver compras confirmadas com esse e-mail, enviaremos um link seguro para consulta." });
  }

  if (request.method === "POST" && url.pathname === "/api/webhooks/mercadopago") {
    if (!mpServerConfigured(env) || !env.MERCADOPAGO_WEBHOOK_SECRET) return json({ error: "Webhooks do Mercado Pago não configurados." }, 503);
    const body = await readJson(request); const dataId = url.searchParams.get("data.id") || body.data?.id;
    if (!await verifySignature(env.MERCADOPAGO_WEBHOOK_SECRET, request.headers.get("x-signature"), request.headers.get("x-request-id"), String(dataId || ""))) return json({ error: "Assinatura inválida." }, 401);
    if (body.type !== "payment" || !dataId) return json({ ok: true });
    const payment = await mpPayment(env, dataId); const order = await getOrder(env.DB, payment.external_reference);
    if (order) { const cfg = await settings(); await settle(env.DB, order, payment, cfg.sales_closed); const updated = await getOrder(env.DB, order.id); if (updated?.status === "paid") await sendReceiptEmail(env, request, updated).catch(() => {}); }
    return json({ ok: true });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/login") {
    const { password } = await readJson(request); const addressHash = await digest(request.headers.get("cf-connecting-ip") || "unknown");
    const attempt = await env.DB.prepare("SELECT * FROM login_attempts WHERE address_hash=?").bind(addressHash).first();
    if (attempt?.blocked_until > now) return json({ error: "Muitas tentativas. Aguarde 15 minutos e tente novamente." }, 429, { "retry-after": String(Math.ceil((attempt.blocked_until - now) / 1000)) });
    if (!env.ADMIN_PASSWORD || !safeEqual(password || "", env.ADMIN_PASSWORD)) {
      const count = (attempt?.count || 0) + 1; await env.DB.prepare("INSERT INTO login_attempts(address_hash,count,blocked_until,updated_at) VALUES(?,?,?,?) ON CONFLICT(address_hash) DO UPDATE SET count=excluded.count,blocked_until=excluded.blocked_until,updated_at=excluded.updated_at").bind(addressHash, count, count >= 5 ? now + 15 * 60_000 : 0, now).run();
      return json({ error: "Senha incorreta." }, 401);
    }
    const token = randomToken(); await env.DB.prepare("DELETE FROM login_attempts WHERE address_hash=?").bind(addressHash).run(); await env.DB.prepare("INSERT INTO admin_sessions(token_hash,expires_at) VALUES(?,?)").bind(await digest(token), now + 8 * 60 * 60_000).run();
    return json({ ok: true }, 200, { "set-cookie": `rifa_admin=${token}; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=28800` });
  }
  if (request.method === "POST" && url.pathname === "/api/admin/logout") {
    const token = cookie(request, "rifa_admin"); if (token) await env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash=?").bind(await digest(token)).run();
    return json({ ok: true }, 200, { "set-cookie": "rifa_admin=; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=0" });
  }
  if (url.pathname.startsWith("/api/admin/") && !await adminOk(request, env)) return json({ error: "Acesso restrito." }, 401);

  if (request.method === "POST" && url.pathname === "/api/admin/sales") {
    const { closed } = await readJson(request); if (typeof closed !== "boolean") return json({ error: "Informe se as vendas serão encerradas." }, 400);
    const cfg = await settings(); if (cfg.draw_result && !closed) return json({ error: "As vendas não podem ser reabertas depois do sorteio." }, 409);
    if (closed) await env.DB.batch([env.DB.prepare("UPDATE raffle_numbers SET status='available',order_id=NULL WHERE status='reserved'").bind(), env.DB.prepare("UPDATE raffle_orders SET status='expired' WHERE status='pending'").bind()]);
    await env.DB.prepare("UPDATE raffle_settings SET sales_closed=? WHERE id=1").bind(closed ? 1 : 0).run(); return json({ ok: true, salesClosed: closed });
  }
  if (request.method === "POST" && url.pathname === "/api/admin/draw") {
    const cfg = await settings(); if (!cfg.sales_closed) return json({ error: "Encerre as vendas antes de iniciar o sorteio." }, 409); if (cfg.draw_result) return json({ error: "O sorteio desta rifa já foi realizado." }, 409);
    const rows = await env.DB.prepare("SELECT number FROM raffle_numbers WHERE status='sold'").all(); const pool = rows.results.map((row) => row.number);
    if (pool.length < 3) return json({ error: "São necessários ao menos três números pagos para sortear os prêmios." }, 409);
    for (let i = pool.length - 1; i > 0; i--) { const bytes = new Uint32Array(1); crypto.getRandomValues(bytes); const j = bytes[0] % (i + 1); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    const drawResult = { drawnAt: now, winners: pool.slice(0, 3).map((number, i) => ({ place: i + 1, number })) };
    await env.DB.prepare("UPDATE raffle_settings SET draw_result=? WHERE id=1 AND draw_result IS NULL AND sales_closed=1").bind(JSON.stringify(drawResult)).run(); return json({ drawResult });
  }
  if (request.method === "GET" && url.pathname === "/api/admin/overview") {
    const [cfg, counts, orders] = await Promise.all([settings(), env.DB.prepare("SELECT status,COUNT(*) AS count FROM raffle_numbers GROUP BY status").all(), env.DB.prepare("SELECT id,name,email,phone,numbers_json,amount,status,expires_at FROM raffle_orders ORDER BY created_at DESC LIMIT 40").all()]);
    const count = Object.fromEntries(counts.results.map((row) => [row.status, row.count])); const paid = await env.DB.prepare("SELECT COUNT(*) AS count FROM raffle_orders WHERE status IN ('paid','paid_demo')").first(); const pending = await env.DB.prepare("SELECT COUNT(*) AS count FROM raffle_orders WHERE status='pending' AND expires_at>?").bind(now).first();
    return json({ total: 200, sold: count.sold || 0, reserved: count.reserved || 0, available: count.available || 0, gross: (count.sold || 0) * 20, paymentMode: checkoutConfigured(env) ? "mercadopago" : "unavailable", testMode: env.MERCADOPAGO_TEST_MODE === "true", emailConfigured: Boolean(env.RESEND_API_KEY && env.RECEIPT_EMAIL_FROM), paidNumberCount: count.sold || 0, salesClosed: Boolean(cfg.sales_closed), drawResult: cfg.draw_result ? JSON.parse(cfg.draw_result) : null, orders: orders.results.map((o) => ({ id: o.id.slice(0, 8), name: o.name, email: o.email, phone: o.phone, numbers: JSON.parse(o.numbers_json), amount: o.amount, status: o.status, expiresAt: o.expires_at })), paidCount: paid.count, pendingCount: pending.count });
  }
  return json({ error: "Rota da API não encontrada." }, 404);
}

export async function onRequest(context) {
  try { return await api(context.request, context.env); }
  catch { return json({ error: "Não foi possível concluir a solicitação. Tente novamente." }, 500); }
}
