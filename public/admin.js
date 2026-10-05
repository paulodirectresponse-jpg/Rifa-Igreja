const root = document.querySelector("#admin-root");
const loginForm = document.querySelector("#admin-login-form");
const errorBox = document.querySelector("#login-error");
let refreshTimer = null;
const money = (value) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(
    value,
  );
const date = (value) =>
  new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = loginForm.querySelector("button");
  button.disabled = true;
  errorBox.textContent = "";
  try {
    const response = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        password: new FormData(loginForm).get("password"),
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    await renderDashboard();
  } catch (error) {
    errorBox.textContent = error.message || "Não foi possível entrar.";
  } finally {
    button.disabled = false;
  }
});

async function renderDashboard() {
  const response = await fetch("/api/admin/overview", { cache: "no-store" });
  if (response.status === 401) {
    if (document.querySelector(".admin-shell")) location.reload();
    return;
  }
  if (!response.ok) throw new Error("Não foi possível carregar o painel.");
  const data = await response.json();
  const percentage = Math.round((data.sold / data.total) * 100);
  const paymentLabel =
    data.paymentMode === "mercadopago"
      ? data.testMode
        ? "Mercado Pago · teste"
        : "Mercado Pago · produção"
      : "Demonstração local";
  const orders = data.orders.length
    ? data.orders
        .map(
          (order) =>
            `<tr><td><strong>${escapeHTML(order.name)}</strong><small>${escapeHTML(order.email)}<br>${escapeHTML(order.phone)}</small></td><td>${order.numbers.map((n) => String(n).padStart(3, "0")).join(", ")}</td><td>${money(order.amount)}</td><td><span class="status-tag ${order.status}">${statusLabel(order.status)}</span></td><td>${order.status === "pending" ? date(order.expiresAt) : "—"}</td></tr>`,
        )
        .join("")
    : '<tr><td colspan="5" class="empty-orders">Ainda não há pedidos nesta rifa.</td></tr>';
  const drawCards = data.drawResult
    ? data.drawResult.winners
        .map(
          (winner) =>
            `<article class="draw-winner-card"><small>${["1º prêmio · Luva Pista F900 tamanho 10", "2º prêmio · Pix de R$ 300", "3º prêmio · Pix de R$ 200"][winner.place - 1]}</small><b>Nº ${String(winner.number).padStart(3, "0")}</b></article>`,
        )
        .join("")
    : "";

  root.innerHTML = `<section class="admin-shell"><header class="admin-header"><a class="brand church-brand" href="/"><img class="church-wordmark" src="/assets/catalunha-logo-wordmark.png" alt="Igreja Evangelística Ministério Catalunha" /></a><div class="admin-header-right"><a class="admin-public-link" href="/">Ver página pública ↗</a><button class="admin-logout" id="admin-logout">Sair</button></div></header><section class="admin-title"><div class="eyebrow">CENTRAL DA ARRECADAÇÃO</div><h1>Painel da rifa</h1><p>Visão geral das vendas, dos participantes e do sorteio da bateria da igreja.</p></section><section class="admin-statusbar"><div><span class="status-indicator ${data.salesClosed ? "closed" : "open"}"></span><strong>${data.salesClosed ? "Vendas encerradas" : "Vendas abertas"}</strong><small>${data.salesClosed ? "Novas reservas estão bloqueadas" : "Recebendo participações"}</small></div><div><span class="admin-pill">${paymentLabel}</span><small>${data.emailConfigured ? "Comprovantes por e-mail ativos" : "E-mail de comprovante não configurado"}</small></div></section><section class="admin-metrics"><article class="metric-card primary"><span>Arrecadação confirmada</span><b>${money(data.gross)}</b><small>${data.paymentMode === "demo" ? "Inclui apenas confirmações simuladas" : "Valores de números pagos"}</small></article><article class="metric-card"><span>Números pagos</span><b>${data.sold}</b><small>${percentage}% dos ${data.total} números</small></article><article class="metric-card"><span>Disponíveis</span><b>${data.available}</b><small>de ${data.total} números totais</small></article><article class="metric-card"><span>Reservados</span><b>${data.reserved}</b><small>${data.pendingCount} pedido(s) aguardando pagamento</small></article></section><section class="admin-progress"><div><strong>Progresso da rifa</strong><span>${data.sold} de ${data.total} vendidos</span></div><div class="admin-progress-track"><i style="width:${percentage}%"></i></div></section><section class="admin-control-grid"><article class="admin-control-card"><div class="eyebrow">CONTROLE DE VENDAS</div><h2>${data.salesClosed ? "Etapa de venda encerrada" : "Quando estiver pronta, encerre as vendas"}</h2><p>${data.salesClosed ? "As reservas pendentes foram liberadas. Já é possível sortear entre os números pagos." : "O sorteio só poderá ser feito depois de encerrar as vendas. Reservas pendentes serão liberadas ao encerrar."}</p><button class="button ${data.salesClosed ? "button-quiet" : "button-lime"}" id="sales-toggle" ${data.drawResult ? "disabled" : ""}>${data.salesClosed ? "Reabrir vendas" : "Encerrar vendas"}</button></article><article class="admin-control-card draw-control"><div class="eyebrow">SORTEIO MANUAL</div><h2>${data.drawResult ? "Sorteio concluído" : "Sortear os três prêmios"}</h2><p>${data.drawResult ? `Resultado registrado em ${date(data.drawResult.drawnAt)}.` : `Sorteio uniforme entre ${data.paidNumberCount} números pagos, sem repetir número vencedor.`}</p><button class="button button-lime" id="draw-now" ${!data.salesClosed || data.drawResult || data.paidNumberCount < 3 ? "disabled" : ""}>${data.drawResult ? "Resultado registrado" : "Realizar sorteio"} <span>→</span></button></article></section>${data.drawResult ? `<section class="admin-draw-result"><div><div class="eyebrow">RESULTADO REGISTRADO</div><h2>Números sorteados</h2><p>${date(data.drawResult.drawnAt)}</p></div><div class="draw-winners">${drawCards}</div></section>` : ""}<section class="admin-table-wrap"><div class="admin-table-title"><div><div class="eyebrow">ACOMPANHAMENTO</div><h2>Pedidos recentes</h2></div><span>${data.orders.length} registro(s)</span></div><div class="admin-table-scroll"><table><thead><tr><th>Participante</th><th>Números</th><th>Valor</th><th>Status</th><th>Reserva até</th></tr></thead><tbody>${orders}</tbody></table></div></section><section class="admin-readiness"><div class="eyebrow">CONFIGURAÇÃO</div><h2>Conexões da rifa</h2><div><span class="readiness-dot ${data.paymentMode === "mercadopago" ? "ready" : "pending"}"></span><strong>Mercado Pago</strong><small>${paymentLabel}</small></div><div><span class="readiness-dot ${data.emailConfigured ? "ready" : "pending"}"></span><strong>Comprovantes por e-mail</strong><small>${data.emailConfigured ? "Ativo" : "Opcional; consulta por código e telefone funciona no site"}</small></div></section><p class="admin-note">A página pública não dá acesso a este painel. Guarde a senha administrativa e as credenciais privadas no arquivo local .env.</p></section>`;

  document.querySelector("#admin-logout").addEventListener("click", async () => {
    if (refreshTimer) clearInterval(refreshTimer);
    await fetch("/api/admin/logout", { method: "POST" });
    location.reload();
  });
  document.querySelector("#sales-toggle").addEventListener("click", async (event) => {
    const closed = !data.salesClosed;
    const confirmMessage = closed
      ? "Encerrar as vendas agora? Reservas pendentes serão liberadas e não será possível receber novas compras."
      : "Reabrir as vendas? O resultado do sorteio ainda não foi registrado.";
    if (!window.confirm(confirmMessage)) return;
    event.currentTarget.disabled = true;
    await adminAction("/api/admin/sales", { closed });
  });
  document.querySelector("#draw-now").addEventListener("click", async (event) => {
    if (!window.confirm("Realizar o sorteio agora? Serão escolhidos três números pagos, sem repetição. O resultado ficará registrado e não poderá ser sorteado novamente.")) return;
    event.currentTarget.disabled = true;
    await adminAction("/api/admin/draw", {});
  });
  if (!refreshTimer)
    refreshTimer = setInterval(() => {
      if (document.querySelector(".admin-shell"))
        renderDashboard().catch(() => {});
    }, 15000);
}

async function adminAction(url, body) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Não foi possível concluir a ação.");
    await renderDashboard();
  } catch (error) {
    window.alert(error.message || "Não foi possível concluir a ação.");
    await renderDashboard();
  }
}

function statusLabel(status) {
  return ({
    pending: "Aguardando pagamento",
    expired: "Reserva expirada",
    paid: "Pago",
    paid_demo: "Pago · simulação",
    late_payment_review: "Pagamento tardio · revisar",
    payment_review: "Revisar pagamento",
    checkout_error: "Checkout indisponível",
  })[status] || "Em análise";
}

function escapeHTML(value) {
  return String(value).replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ],
  );
}

renderDashboard().catch(() => {
  if (errorBox) errorBox.textContent = "Não foi possível verificar sua sessão.";
});
