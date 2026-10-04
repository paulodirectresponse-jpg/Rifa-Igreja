# Rifa beneficente · Igreja Evangelística Ministério Catalunha

Site responsivo para arrecadar recursos para a compra da bateria da igreja. São 200 números a R$ 20 cada e três prêmios: luva profissional Pista F900 tamanho 10, Pix de R$ 300 e Pix de R$ 100.

## Desenvolvimento local

Requer Node.js 20 ou superior. Copie `.env.example` para `.env`, defina `ADMIN_PASSWORD` e execute:

```bash
npm run dev
```

Abra `http://localhost:4173`. O servidor local pode simular pagamentos para demonstração. Esse fluxo de simulação existe somente no servidor local; na implantação Cloudflare, compras ficam bloqueadas até a integração real estar configurada.

## Cloudflare Pages

O projeto usa Pages Functions para a API e D1 para persistência. Conecte o repositório GitHub pelo fluxo **Continue to Pages**. Configure:

- Framework preset: `None`
- Build command: vazio
- Build output directory: `public`
- Production branch: `main`
- Root directory: raiz do repositório

O primeiro commit na `main` cria o deploy inicial; commits posteriores nessa branch publicam automaticamente. `/admin` é encaminhado para o painel e `/comprovante` para a página do comprovante.

### Banco D1

1. Crie um banco D1 chamado `rifa-igreja`.
2. No console SQL do banco, execute o conteúdo de `migrations/0001_initial.sql` uma vez. Isso cria o estado inicial com os 200 números disponíveis.
3. No projeto Pages, abra **Settings → Functions → D1 database bindings** e adicione o binding `DB`, apontando para esse banco.
4. Faça um novo deploy para ativar o binding na versão publicada.

Não importe `data/raffle.json`: o estado local pode conter dados de teste. A migração inicia uma rifa limpa.

### Variáveis e secrets

Configure para o ambiente **Production** em **Settings → Variables and Secrets**:

| Nome | Tipo | Valor |
| --- | --- | --- |
| `ADMIN_PASSWORD` | Secret | Senha forte escolhida para o painel |
| `MERCADOPAGO_ACCESS_TOKEN` | Secret | Access Token de produção do Mercado Pago |
| `MERCADOPAGO_WEBHOOK_SECRET` | Secret | Segredo de assinatura do webhook do Mercado Pago |
| `PUBLIC_BASE_URL` | Variable | URL HTTPS estável do projeto, por exemplo `https://rifa-igreja.pages.dev` |
| `MERCADOPAGO_TEST_MODE` | Variable | `false` para produção |

O webhook enviado ao Mercado Pago é `https://rifa-igreja.pages.dev/api/webhooks/mercadopago`, usando a URL real do projeto. A Public Key não é necessária para este checkout server-side.

Após salvar os valores, faça um novo deploy. Enquanto token, URL HTTPS e configuração do modo de pagamento não estiverem válidos, a API não reserva números nem aceita confirmação simulada.

Opcionalmente, configure `RESEND_API_KEY` e `RECEIPT_EMAIL_FROM` para envio de links de comprovante por e-mail.

## Funcionalidades

- Reserva de 1 a 20 números por até 30 minutos, com liberação automática quando expira.
- Checkout Pro do Mercado Pago para Pix ou cartão; os números só ficam vendidos após confirmação validada.
- Comprovante privado, compartilhamento da rifa e consulta de compra por e-mail.
- Painel administrativo com visão das vendas, controle de abertura/encerramento e sorteio manual dos três números pagos.
- Banco D1 para pedidos, sessões administrativas, reservas, vendas e resultado do sorteio.

## Segurança

Nunca envie tokens ou senhas ao GitHub ou ao chat. `.env` e `data/` são ignorados pelo Git. Configure credenciais somente nos Secrets do ambiente Cloudflare correspondente. Use credenciais de teste em um projeto/ambiente de preview e credenciais de produção somente no ambiente Production.
