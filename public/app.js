const money = (value) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(
    value,
  );
const selected = new Set();
let raffle = null;
let activeFilter = "all";
let holdTimer = null;
let toastTimer = null;
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
      ? "MODO DE TESTE: use somente uma conta compradora de teste do Mercado Pago. Nenhum pagamento real será feito."
      : raffle.paymentMode === "unavailable"
        ? "PAGAMENTOS EM CONFIGURAÇÃO: as reservas e compras serão liberadas quando o pagamento seguro estiver ativo."
        : "PRÉVIA: use dados fictícios. Pagamentos e confirmações são simulações, sem cobrança real.";
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

function showCheckoutForm() {
  if (!raffle?.salesOpen) return notify("As vendas da rifa foram encerradas.");
  const checkoutNote =
    raffle.paymentMode === "test"
      ? "Ambiente de teste do Mercado Pago: ao continuar, entre com uma conta compradora de teste. Sua conta pessoal não funciona no sandbox."
      : raffle.paymentMode === "live"
        ? "Após reservar os números, você seguirá ao checkout seguro do Mercado Pago para pagar via Pix ou cartão."
        : "Prévia local: nenhum pagamento será cobrado. Pix e cartão reais estarão disponíveis após configurar o Mercado Pago.";
  checkoutContent.innerHTML = `<div class="eyebrow">RIFA BENEFICENTE · IGREJA MINISTÉRIO CATALUNHA</div><h2>Dados da participação.</h2><p>Preencha seus dados para reservar os números por até 30 minutos e seguir para o pagamento.</p><form class="checkout-form" id="participant-form"><label>Nome completo<input name="name" autocomplete="name" required minlength="3" placeholder="Como você se chama?" /></label><label>E-mail<input name="email" type="email" autocomplete="email" required placeholder="voce@email.com" /></label><label>Telefone / WhatsApp<input name="phone" type="tel" autocomplete="tel" required placeholder="(00) 00000-0000" /></label><label>Forma de pagamento</label><div class="method-row"><button type="button" class="method-choice active" data-method="pix">◈ &nbsp; Pix</button><button type="button" class="method-choice" data-method="card">▣ &nbsp; Cartão</button></div><p class="checkout-error" id="checkout-error"></p><button class="button button-lime" type="submit">Continuar · ${money(selected.size * raffle.price)} <span>→</span></button></form><p class="demo-banner">${checkoutNote}</p>`;
  let method = "pix";
  checkoutContent.querySelectorAll(".method-choice").forEach((button) =>
    button.addEventListener("click", () => {
      method = button.dataset.method;
      checkoutContent
        .querySelectorAll(".method-choice")
        .forEach((choice) =>
          choice.classList.toggle("active", choice === button),
        );
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
      try {
        const response = await fetch("/api/hold", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            numbers,
            name: form.get("name"),
            email: form.get("email"),
            phone: form.get("phone"),
            method,
          }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        selected.clear();
        if (data.checkoutUrl) {
          window.location.assign(data.checkoutUrl);
          return;
        }
        showPayment(data, method);
        await loadState();
      } catch (err) {
        error.textContent =
          err.message || "Não foi possível reservar os números.";
        submit.disabled = false;
      }
    });
  dialog.showModal();
}

function showPayment(hold, method) {
  const numberList = hold.numbers
    .map((number) => String(number).padStart(3, "0"))
    .join(", ");
  if (holdTimer) clearInterval(holdTimer);
  checkoutContent.innerHTML = `<div class="eyebrow">${method === "pix" ? "PAGAMENTO VIA PIX" : "PAGAMENTO COM CARTÃO"}</div><h2>${method === "pix" ? "Sua reserva está feita." : "Reserva criada."}</h2><p>Números ${numberList} · total de <b>${money(hold.amount)}</b></p><div class="pix-demo"><p>${method === "pix" ? "O QR Code válido será apresentado pelo Mercado Pago quando as credenciais de teste estiverem configuradas." : "O checkout seguro com cartão será aberto pelo Mercado Pago quando as credenciais de teste estiverem configuradas."}</p></div><p class="demo-banner">Prévia local: não houve cobrança. Para conferir o comprovante, use o botão abaixo para simular uma confirmação de teste. Se não pagar, a reserva expira em 30 minutos.</p><p id="hold-countdown" class="hold-note">◷ Reserva expira em 30:00</p><button class="button button-lime" id="confirm-demo">Simular pagamento de teste <span>→</span></button>`;
  const countdown = document.querySelector("#hold-countdown");
  holdTimer = setInterval(() => {
    const seconds = Math.max(
      0,
      Math.ceil((hold.expiresAt - Date.now()) / 1000),
    );
    countdown.textContent = seconds
      ? `◷ Reserva expira em ${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
      : "A reserva expirou. Escolha os números novamente.";
    if (!seconds) {
      clearInterval(holdTimer);
      document.querySelector("#confirm-demo").disabled = true;
      loadState();
    }
  }, 1000);
  document
    .querySelector("#confirm-demo")
    .addEventListener("click", async (event) => {
      event.currentTarget.disabled = true;
      const response = await fetch("/api/demo/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: hold.id }),
      });
      const data = await response.json();
      if (!response.ok) {
        notify(data.error);
        dialog.close();
        await loadState();
        return;
      }
      clearInterval(holdTimer);
      const receiptResponse = await fetch(`/api/receipt/${hold.id}`, {
        cache: "no-store",
      });
      if (!receiptResponse.ok) {
        notify("Compra confirmada no modo de teste, mas não foi possível abrir o comprovante.");
        dialog.close();
      } else showReceipt(await receiptResponse.json());
      await loadState();
    });
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
  );
}

function showReceipt(receipt) {
  clearInterval(holdTimer);
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
  if (holdTimer) clearInterval(holdTimer);
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
