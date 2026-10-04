const money = (value) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(
    value,
  );
const selected = new Set();
let raffle = null;
let activeFilter = "all";
let holdTimer = null;
let paymentPollTimer = null;
let toastTimer = null;
let mercadoPago = null;
let bricksBuilder = null;
let paymentBrickController = null;
let statusScreenBrickController = null;
let paymentConfig = null;
const grid = document.querySelector("#number-grid");
const toast = document.querySelector("#toast");
const dialog = document.querySelector("#checkout-dialog");
const checkoutContent = document.querySelector("#checkout-content");

function notify(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2600);
}

async function loadState() {
  const response = await fetch("/api/state", { cache: "no-store" });
  raffle = await response.json();
  const previewNotice = document.querySelector("#preview-notice");
  previewNotice.hidden = raffle.paymentMode === "live";
  previewNotice.textContent =
    raffle.paymentMode === "test"
      ? "MODO DE TESTE: o checkout seguro do Mercado Pago está incorporado a este site e nenhum pagamento real será feito."
      : raffle.paymentMode === "unavailable"
        ? "PAGAMENTOS EM CONFIGURAÇÃO: as reservas e compras serão liberadas quando a credencial pública do checkout estiver ativa."
        : "PAGAMENTO SEGURO: Pix e cartão são processados pelo Mercado Pago sem sair deste site.";
  document.querySelector("#sales-closed-notice").hidden = raffle.salesOpen;
  for (const item of raffle.numbers)
    if (item.status !== "available" || !raffle.salesOpen)
      selected.delete(item.number);
  renderDrawResult();
  render();
}

function render() {
  if (!raffle) return;
  document.querySelector("#chosen-count").textContent =
    raffle.sold + raffle.reserved;
  document.querySelector("#hero-sold").textContent = raffle.sold;
  document.querySelector("#available-count").textContent = raffle.available;
  document.querySelector("#count-all").textContent = raffle.total;
  document.querySelector("#count-available").textContent = raffle.available;
  document.querySelector("#count-selected").textContent = selected.size;
  document.querySelector("#progress-fill").style.width =
    `${Math.round(((raffle.sold + raffle.reserved) / raffle.total) * 100)}%`;
  document.querySelector("#selection-total").textContent = money(
    selected.size * raffle.price,
  );
  const continueButton = document.querySelector("#continue-button");
  continueButton.disabled = selected.size === 0 || !raffle.salesOpen || raffle.paymentMode === "unavailable";
  continueButton.innerHTML = selected.size
    ? `Continuar com ${selected.size} ${selected.size === 1 ? "número" : "números"} <span>→</span>`
    : raffle.paymentMode === "unavailable"
      ? "Pagamentos em configuração"
    : !raffle.salesOpen
      ? "Vendas encerradas"
    : "Escolher meus números <span>→</span>";
  const list = document.querySelector("#selected-list");
  list.replaceChildren();
  if (!selected.size) {
    const empty = document.createElement("p");
    empty.className = "empty-selection";
    empty.innerHTML = "Toque nos números para<br />adicionar à sua seleção.";
    list.append(empty);
  } else {
    [...selected]
      .sort((a, b) => a - b)
      .forEach((number) => {
        const pill = document.createElement("span");
        pill.className = "selected-pill";
        pill.textContent = String(number).padStart(3, "0");
        list.append(pill);
      });
  }
  const query = document.querySelector("#search-number").value.trim();
  const shown = raffle.numbers.filter((item) => {
    const fitsFilter =
      activeFilter === "all" ||
      (activeFilter === "available" && item.status === "available") ||
      (activeFilter === "selected" && selected.has(item.number));
    const fitsSearch =
      !query || String(item.number).includes(query.replace(/\D/g, ""));
    return fitsFilter && fitsSearch;
  });
  grid.replaceChildren();
  grid.dataset.salesClosed = String(!raffle.salesOpen);
  shown.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `number-tile ${item.status}${selected.has(item.number) ? " selected" : ""}`;
    button.textContent = String(item.number).padStart(3, "0");
    button.disabled = item.status !== "available" || !raffle.salesOpen || raffle.paymentMode === "unavailable";
    button.setAttribute("aria-pressed", selected.has(item.number));
    button.setAttribute(
      "aria-label",
      `Número ${item.number}, ${!raffle.salesOpen ? "vendas encerradas" : selected.has(item.number) ? "selecionado" : item.status === "available" ? "disponível" : item.status === "sold" ? "vendido" : "reservado"}`,
    );
    button.addEventListener("click", () => {
      if (selected.has(item.number)) selected.delete(item.number);
      else if (selected.size >= 20)
        notify("Você pode escolher até 20 números por pedido.");
      else selected.add(item.number);
      render();
    });
    grid.append(button);
  });
}

function renderDrawResult() {
  const section = document.querySelector("#draw-results");
  const result = raffle?.drawResult;
  section.hidden = !result;
  if (!result) return;
  const labels = ["1º prêmio · Luva Pista F900", "2º prêmio · Pix R$ 300", "3º prêmio · Pix R$ 100"];
  document.querySelector("#raffle-winners").innerHTML = result.winners
    .map((winner, index) => `<article class="raffle-winner"><small>${labels[winner.place - 1] || labels[index]}</small><b>Nº ${String(winner.number).padStart(3, "0")}</b></article>`)
    .join("");
  document.querySelector("#draw-date").textContent = `Sorteio realizado em ${new Intl.DateTimeFormat("pt-BR", { dateStyle: "long", timeStyle: "short" }).format(new Date(result.drawnAt))}.`;
}

document.querySelectorAll(".filter").forEach((button) =>
  button.addEventListener("click", () => {
    document
      .querySelectorAll(".filter")
      .forEach((filter) => filter.classList.remove("active"));
    button.classList.add("active");
    activeFilter = button.dataset.filter;
    render();
  }),
);
document.querySelector("#search-number").addEventListener("input", render);
document
  .querySelector("#receipt-lookup-form")
  .addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button");
    const message = document.querySelector("#receipt-lookup-message");
    button.disabled = true;
    message.textContent = "";
    try {
      const response = await fetch("/api/receipt-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: new FormData(form).get("email") }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Tente novamente em alguns minutos.");
      message.textContent = data.emailConfigured
        ? data.message
        : "O envio de e-mail ainda não está configurado nesta prévia. Após a simulação, salve o link privado exibido no comprovante.";
    } catch (error) {
      message.textContent = error.message || "Não foi possível solicitar o link agora.";
    } finally {
      button.disabled = false;
    }
  });
document
  .querySelector("#continue-button")
  .addEventListener("click", showCheckoutForm);

const selectionCard = document.querySelector(".selection-card");
const numberSection = document.querySelector("#numeros");
if ("IntersectionObserver" in window) {
  const selectionObserver = new IntersectionObserver(
    ([entry]) =>
      selectionCard.classList.toggle("is-visible", entry.isIntersecting),
    { threshold: 0 },
  );
  selectionObserver.observe(numberSection);
} else {
  selectionCard.classList.add("is-visible");
}

async function getPaymentConfig() {
  if (paymentConfig) return paymentConfig;
  const response = await fetch("/api/payment-config", { cache: "no-store" });
  const data = await response.json();
  if (!response.ok || !data.publicKey)
    throw new Error(data.error || "Pagamento seguro ainda não configurado.");
  paymentConfig = data;
  return data;
}

async function unmountPaymentBricks() {
  const controllers = [paymentBrickController, statusScreenBrickController];
  paymentBrickController = null;
  statusScreenBrickController = null;
  for (const controller of controllers) {
    if (!controller?.unmount) continue;
    try {
      await controller.unmount();
    } catch {}
  }
}

function stopPaymentTimers() {
  if (holdTimer) clearInterval(holdTimer);
  if (paymentPollTimer) clearInterval(paymentPollTimer);
  holdTimer = null;
  paymentPollTimer = null;
}

function startHoldCountdown(hold) {
  if (holdTimer) clearInterval(holdTimer);
  const update = () => {
    const countdown = document.querySelector("#hold-countdown");
    if (!countdown) return;
    const seconds = Math.max(0, Math.ceil((hold.expiresAt - Date.now()) / 1000));
    countdown.textContent = seconds
      ? `◷ Reserva expira em ${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
      : "A reserva expirou. Escolha os números novamente.";
    if (!seconds) {
      clearInterval(holdTimer);
      holdTimer = null;
      if (paymentPollTimer) clearInterval(paymentPollTimer);
      paymentPollTimer = null;
      loadState().catch(() => {});
    }
  };
  update();
  holdTimer = setInterval(update, 1000);
}

function newPaymentAttemptId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    const next = char === "x" ? value : (value & 0x3) | 0x8;
    return next.toString(16);
  });
}

async function ensureMercadoPago() {
  const config = await getPaymentConfig();
  if (!window.MercadoPago)
    throw new Error("Não foi possível carregar o checkout seguro do Mercado Pago.");
  if (!mercadoPago) {
    mercadoPago = new window.MercadoPago(config.publicKey, { locale: "pt-BR" });
    bricksBuilder = mercadoPago.bricks();
  }
  return config;
}

function showCheckoutForm() {
  if (!raffle?.salesOpen) return notify("As vendas da rifa foram encerradas.");
  if (raffle.paymentMode === "unavailable")
    return notify("O pagamento seguro ainda está sendo configurado.");
  const checkoutNote =
    raffle.paymentMode === "test"
      ? "Ambiente de teste: o checkout será exibido aqui mesmo e nenhum pagamento real será feito."
      : "Pix e cartão serão processados com segurança pelo Mercado Pago sem redirecionar você para outro site.";
  checkoutContent.innerHTML = `<div class="eyebrow">RIFA BENEFICENTE · IGREJA MINISTÉRIO CATALUNHA</div><h2>Dados da participação.</h2><p>Preencha seus dados para reservar os números por 30 minutos e pagar aqui mesmo.</p><form class="checkout-form" id="participant-form"><label>Nome completo<input name="name" autocomplete="name" required minlength="3" placeholder="Como você se chama?" /></label><label>E-mail<input name="email" type="email" autocomplete="email" required placeholder="voce@email.com" /></label><label>Telefone / WhatsApp<input name="phone" type="tel" autocomplete="tel" required placeholder="(00) 00000-0000" /></label><label>Forma de pagamento</label><div class="method-row"><button type="button" class="method-choice active" data-method="pix">◈ &nbsp; Pix</button><button type="button" class="method-choice" data-method="card">▣ &nbsp; Cartão</button></div><p class="checkout-error" id="checkout-error"></p><button class="button button-lime" type="submit">Continuar · ${money(selected.size * raffle.price)} <span>→</span></button></form><p class="demo-banner">${checkoutNote}</p>`;
  let method = "pix";
  checkoutContent.querySelectorAll(".method-choice").forEach((button) =>
    button.addEventListener("click", () => {
      method = button.dataset.method;
      checkoutContent
        .querySelectorAll(".method-choice")
        .forEach((choice) => choice.classList.toggle("active", choice === button));
    }),
  );
  checkoutContent
    .querySelector("#participant-form")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const numbers = [...selected];
      const error = checkoutContent.querySelector("#checkout-error");
      const submit = event.currentTarget.querySelector('[type="submit"]');
      submit.disabled = true;
      error.textContent = "";
      try {
        await ensureMercadoPago();
        const response = await fetch("/api/hold", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            numbers,
            name: form.get("name"),
            email: form.get("email"),
            phone: form.get("phone"),
          }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        selected.clear();
        data.payerEmail = String(form.get("email") || "");
        data.method = method;
        await loadState();
        await showEmbeddedPayment(data);
      } catch (err) {
        error.textContent = err.message || "Não foi possível reservar os números.";
        submit.disabled = false;
      }
    });
  dialog.showModal();
}

async function showEmbeddedPayment(hold) {
  await ensureMercadoPago();
  await unmountPaymentBricks();
  stopPaymentTimers();
  const numberList = hold.numbers
    .map((number) => String(number).padStart(3, "0"))
    .join(", ");
  checkoutContent.innerHTML = `<div class="eyebrow">${hold.method === "pix" ? "PAGAMENTO VIA PIX" : "PAGAMENTO COM CARTÃO"}</div><h2>Finalize sua participação.</h2><p>Números ${numberList} · total de <b>${money(hold.amount)}</b></p><p class="checkout-secure-note">Pagamento processado com segurança pelo Mercado Pago dentro desta página.</p><div class="payment-brick-shell"><div id="paymentBrick_container"></div></div><p class="checkout-error" id="payment-error" role="alert"></p><p id="hold-countdown" class="hold-note"></p>`;
  startHoldCountdown(hold);
  const methods =
    hold.method === "pix"
      ? { bankTransfer: "all" }
      : { creditCard: "all", debitCard: "all", prepaidCard: "all" };
  const settings = {
    initialization: {
      amount: Number(hold.amount),
      payer: { email: hold.payerEmail },
    },
    customization: {
      paymentMethods: methods,
      visual: { style: { theme: "default" } },
    },
    callbacks: {
      onReady: () => {},
      onSubmit: ({ formData }) =>
        new Promise(async (resolve, reject) => {
          const error = document.querySelector("#payment-error");
          if (error) error.textContent = "";
          try {
            const response = await fetch("/api/payments", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                orderId: hold.id,
                formData,
                idempotencyKey: newPaymentAttemptId(),
              }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || "Não foi possível processar o pagamento.");
            if (data.expiresAt) hold.expiresAt = data.expiresAt;
            resolve();
            setTimeout(async () => {
              try {
                if (data.status === "approved") {
                  const confirmed = await syncOrderPayment(hold.id, data.paymentId);
                  if (confirmed) return;
                }
                await showPaymentStatus(hold, data);
              } catch (transitionError) {
                console.error("Payment result transition", transitionError);
                notify("O pagamento foi enviado, mas não foi possível atualizar a tela. A confirmação continuará sendo verificada.");
              }
            }, 0);
          } catch (err) {
            if (error) error.textContent = err.message || "Não foi possível processar o pagamento.";
            reject(err);
          }
        }),
      onError: (error) => {
        console.error("Mercado Pago Brick", error);
        const target = document.querySelector("#payment-error");
        if (target) target.textContent = "O checkout seguro encontrou um erro. Confira os dados e tente novamente.";
      },
    },
  };
  try {
    paymentBrickController = await bricksBuilder.create(
      "payment",
      "paymentBrick_container",
      settings,
    );
  } catch (error) {
    console.error("Payment Brick render", error);
    const target = document.querySelector("#payment-error");
    if (target) target.textContent = "Não foi possível carregar o checkout seguro. Atualize a página e tente novamente.";
  }
}

async function syncOrderPayment(orderId, paymentId) {
  const query = paymentId ? `?payment_id=${encodeURIComponent(paymentId)}` : "";
  const response = await fetch(`/api/order-status/${encodeURIComponent(orderId)}${query}`, {
    cache: "no-store",
  });
  if (!response.ok) return false;
  const data = await response.json();
  if (data.status === "paid") {
    const receiptResponse = await fetch(`/api/receipt/${encodeURIComponent(orderId)}`, {
      cache: "no-store",
    });
    if (receiptResponse.ok) {
      showReceipt(await receiptResponse.json());
      await loadState();
      return true;
    }
    notify("Pagamento confirmado! Seus números estão garantidos.");
    return true;
  }
  if (["payment_review", "late_payment_review"].includes(data.status)) {
    notify("O pagamento foi recebido e o pedido entrou em revisão.");
    return false;
  }
  return false;
}

function renderPixFallback(container, pix) {
  if (!pix?.qrCodeBase64 && !pix?.qrCode) return false;
  container.innerHTML = `<div class="pix-fallback"><h3>Pague com Pix</h3>${pix.qrCodeBase64 ? `<img class="pix-qr" src="data:image/png;base64,${escapeHTML(pix.qrCodeBase64)}" alt="QR Code Pix" />` : ""}<p>Escaneie o QR Code no aplicativo do seu banco ou use o código Pix abaixo.</p>${pix.qrCode ? `<textarea class="pix-copy-code" readonly>${escapeHTML(pix.qrCode)}</textarea><button type="button" class="button button-lime" id="copy-pix-code">Copiar código Pix</button>` : ""}</div>`;
  document.querySelector("#copy-pix-code")?.addEventListener("click", async (event) => {
    try {
      await navigator.clipboard.writeText(pix.qrCode);
      event.currentTarget.textContent = "Código Pix copiado";
    } catch {
      notify("Não foi possível copiar automaticamente. Selecione o código Pix manualmente.");
    }
  });
  return true;
}

async function showPaymentStatus(hold, payment) {
  await unmountPaymentBricks();
  stopPaymentTimers();
  const numberList = hold.numbers
    .map((number) => String(number).padStart(3, "0"))
    .join(", ");
  checkoutContent.innerHTML = `<div class="eyebrow">STATUS DO PAGAMENTO</div><h2>${payment.status === "rejected" ? "Pagamento não aprovado." : payment.status === "approved" ? "Pagamento recebido." : "Conclua seu pagamento."}</h2><p>Números ${numberList} · total de <b>${money(hold.amount)}</b></p><div class="payment-brick-shell"><div id="statusScreenBrick_container"></div></div><p class="checkout-error" id="status-error" role="alert"></p><div id="status-actions"></div><p id="hold-countdown" class="hold-note"></p>`;
  startHoldCountdown(hold);
  const statusTarget = document.querySelector("#statusScreenBrick_container");
  const settings = {
    initialization: {
      paymentId: String(payment.paymentId),
      ...(payment.threeDsInfo?.externalResourceURL && payment.threeDsInfo?.creq
        ? {
            additionalInfo: {
              externalResourceURL: payment.threeDsInfo.externalResourceURL,
              creq: payment.threeDsInfo.creq,
            },
          }
        : {}),
    },
    callbacks: {
      onReady: () => {},
      onError: (error) => {
        console.error("Status Screen Brick", error);
        if (!renderPixFallback(statusTarget, payment.pix)) {
          const target = document.querySelector("#status-error");
          if (target) target.textContent = "Não foi possível carregar os detalhes do pagamento. A confirmação continuará sendo verificada.";
        }
      },
    },
  };
  try {
    statusScreenBrickController = await bricksBuilder.create(
      "statusScreen",
      "statusScreenBrick_container",
      settings,
    );
  } catch (error) {
    console.error("Status Screen render", error);
    if (!renderPixFallback(statusTarget, payment.pix)) {
      const target = document.querySelector("#status-error");
      if (target) target.textContent = "Não foi possível carregar os detalhes do pagamento. A confirmação continuará sendo verificada.";
    }
  }
  if (payment.status === "rejected") {
    document.querySelector("#status-actions").innerHTML =
      '<button type="button" class="button button-lime" id="retry-payment">Tentar outro pagamento <span>→</span></button>';
    document.querySelector("#retry-payment").addEventListener("click", () =>
      showEmbeddedPayment(hold).catch((error) => notify(error.message)),
    );
  } else {
    startPaymentPolling(hold, payment.paymentId);
  }
}

function startPaymentPolling(hold, paymentId) {
  if (paymentPollTimer) clearInterval(paymentPollTimer);
  let busy = false;
  const poll = async () => {
    if (busy || !dialog.open) return;
    busy = true;
    try {
      const done = await syncOrderPayment(hold.id, paymentId);
      if (done && paymentPollTimer) {
        clearInterval(paymentPollTimer);
        paymentPollTimer = null;
      }
    } finally {
      busy = false;
    }
  };
  paymentPollTimer = setInterval(poll, 2500);
  setTimeout(poll, 700);
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
  );
}

function showReceipt(receipt) {
  stopPaymentTimers();
  unmountPaymentBricks().catch(() => {});
  const numberList = receipt.numbers
    .map((number) => String(number).padStart(3, "0"))
    .join(", ");
  const receiptUrl = receipt.receiptUrl || location.href;
  checkoutContent.innerHTML = `<div class="success-mark">✓</div><div class="eyebrow">${receipt.demo ? "COMPROVANTE DE TESTE" : "PAGAMENTO CONFIRMADO"}</div><h2>Participação confirmada.</h2><p><b>${escapeHTML(receipt.name)}</b> · ${escapeHTML(receipt.email)}</p><div class="receipt-details"><span>Seus números</span><b>${numberList}</b><span>Total pago</span><b>${money(receipt.amount)}</b><span>Confirmação</span><b>${new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(receipt.paidAt))}</b></div>${receipt.demo ? '<p class="demo-banner">Este comprovante veio de uma simulação local. Nenhum pagamento real foi realizado.</p>' : ""}<a class="button button-lime receipt-open" href="${escapeHTML(receiptUrl)}" target="_blank" rel="noreferrer">Abrir link privado do comprovante <span>↗</span></a><div class="receipt-share"><button class="button button-share" id="share-raffle" type="button">Compartilhar a rifa <span>↗</span></button><button class="button button-quiet" id="copy-raffle-link" type="button">Copiar link da rifa</button><p id="share-feedback" role="status" aria-live="polite"></p></div><button class="button button-quiet" id="finish-receipt">Fechar</button>`;
  document
    .querySelector("#finish-receipt")
    .addEventListener("click", () => dialog.close());
  const shareMessage =
    "Participe da rifa beneficente da Igreja Evangelística Ministério Catalunha e ajude na compra da bateria da igreja.";
  const raffleUrl = `${location.origin}/`;
  const shareFeedback = document.querySelector("#share-feedback");
  document.querySelector("#share-raffle").addEventListener("click", async () => {
    try {
      if (navigator.share)
        await navigator.share({
          title: "Rifa beneficente · Igreja Ministério Catalunha",
          text: shareMessage,
          url: raffleUrl,
        });
      else {
        await navigator.clipboard.writeText(raffleUrl);
        shareFeedback.textContent = "Link da rifa copiado.";
      }
    } catch (error) {
      if (error.name !== "AbortError")
        shareFeedback.textContent = "Não foi possível compartilhar. Tente copiar o link.";
    }
  });
  document.querySelector("#copy-raffle-link").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(raffleUrl);
      shareFeedback.textContent = "Link da rifa copiado.";
    } catch {
      shareFeedback.textContent = "Não foi possível copiar o link neste navegador.";
    }
  });
  if (!dialog.open) dialog.showModal();
}

document.querySelector("#checkout-dialog").addEventListener("close", () => {
  stopPaymentTimers();
  unmountPaymentBricks().catch(() => {});
});
document.querySelector(".menu-button").addEventListener("click", () => {
  const button = document.querySelector(".menu-button");
  const existing = document.querySelector(".mobile-menu");
  if (existing) {
    existing.remove();
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-label", "Abrir menu");
    return;
  }
  const menu = document.createElement("nav");
  menu.className = "mobile-menu";
  menu.id = "mobile-menu";
  menu.innerHTML =
    '<a href="#premios">Prêmios</a><a href="#numeros">Escolher números</a><a href="#como-funciona">Como funciona</a><a href="#consulta">Consultar compra</a>';
  document.querySelector(".topbar").after(menu);
  button.setAttribute("aria-expanded", "true");
  button.setAttribute("aria-label", "Fechar menu");
  menu.querySelectorAll("a").forEach((link) =>
    link.addEventListener("click", () => {
      menu.remove();
      button.setAttribute("aria-expanded", "false");
      button.setAttribute("aria-label", "Abrir menu");
    }),
  );
});

loadState()
  .then(async () => {
    await syncReceiptLink();
    await syncPaymentReturn();
  })
  .catch(() =>
    notify("Não foi possível carregar os números. Atualize a página."),
  );
setInterval(() => {
  if (!dialog.open) loadState();
}, 15000);

async function syncPaymentReturn() {
  const params = new URLSearchParams(location.search);
  if (params.get("payment") !== "return") return;
  const orderId = params.get("order_id");
  const paymentId = params.get("payment_id") || params.get("collection_id");
  history.replaceState({}, "", "/");
  if (!/^[a-f0-9]{32}$/i.test(orderId || ""))
    return notify(
      "Retornamos do Mercado Pago. Consulte seus números em instantes.",
    );
  let status = "pending";
  for (let attempt = 0; attempt < 15; attempt++) {
    const paymentQuery = /^\d{1,30}$/.test(paymentId || "")
      ? `?payment_id=${encodeURIComponent(paymentId)}`
      : "";
    const response = await fetch(`/api/order-status/${orderId}${paymentQuery}`, {
      cache: "no-store",
    });
    if (!response.ok) break;
    const data = await response.json();
    status = data.status;
    if (!["pending"].includes(status)) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (status === "paid") {
    const receipt = await fetch(`/api/receipt/${orderId}`, { cache: "no-store" });
    if (receipt.ok) showReceipt(await receipt.json());
    else notify("Pagamento confirmado! Seus números estão garantidos.");
  }
  else if (status === "late_payment_review" || status === "payment_review")
    notify(
      "Recebemos uma atualização de pagamento e vamos revisar seu pedido.",
    );
  else
    notify(
      "Pagamento ainda em análise. Os números ficam reservados por até 30 minutos.",
    );
}

async function syncReceiptLink() {
  const params = new URLSearchParams(location.search);
  const id = params.get("pedido");
  if (!id) return;
  history.replaceState({}, "", "/");
  if (!/^[a-f0-9]{32}$/i.test(id))
    return notify("O link do comprovante não é válido.");
  const response = await fetch(`/api/receipt/${id}`, { cache: "no-store" });
  if (!response.ok)
    return notify("Comprovante ainda indisponível. Confira o pagamento e tente novamente.");
  showReceipt(await response.json());
}
