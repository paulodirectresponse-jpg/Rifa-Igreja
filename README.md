# Rifa beneficente · Igreja Evangelística Ministério Catalunha

Site responsivo para arrecadar recursos para a compra da bateria da igreja. São 250 números a R$ 20 cada e três prêmios: luva profissional Pista F900 tamanho 10, Pix de R$ 300 e Pix de R$ 200.

## Desenvolvimento local

Requer Node.js 20 ou superior. Copie `.env.example` para `.env`, defina `ADMIN_PASSWORD` e execute:

```bash
npm run dev
```

Abra `http://localhost:4173`. O servidor local usa o mesmo checkout incorporado da produção quando as credenciais do Mercado Pago estão configuradas. Sem as credenciais completas, novas reservas ficam bloqueadas para evitar pedidos sem possibilidade de pagamento.

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
2. No console SQL do banco, execute `migrations/0001_initial.sql` uma vez e depois `migrations/0002_expand_raffle_to_250.sql` para expandir a rifa a 250 números.
3. No projeto Pages, abra **Settings → Functions → D1 database bindings** e adicione o binding `DB`, apontando para esse banco.
4. Faça um novo deploy para ativar o binding na versão publicada.

Não importe `data/raffle.json`: o estado local pode conter dados de teste. A migração inicia uma rifa limpa.

### Variáveis e secrets

Configure para o ambiente **Production** em **Settings → Variables and Secrets**:

| Nome | Tipo | Valor |
| --- | --- | --- |
| `ADMIN_PASSWORD` | Secret | Senha forte escolhida para o painel |
| `MERCADOPAGO_ACCESS_TOKEN` | Secret | Access Token de produção do Mercado Pago |
| `MERCADOPAGO_PUBLIC_KEY` | Variable | Public Key de produção da mesma aplicação do Mercado Pago |
| `MERCADOPAGO_WEBHOOK_SECRET` | Secret | Segredo de assinatura do webhook do Mercado Pago |
| `PUBLIC_BASE_URL` | Variable | URL HTTPS estável do projeto, por exemplo `https://rifa-igreja.pages.dev` |
| `MERCADOPAGO_TEST_MODE` | Variable | `false` para produção |

O webhook enviado ao Mercado Pago é `https://rifa-igreja.pages.dev/api/webhooks/mercadopago`, usando a URL real do projeto. A Public Key é usada pelo MercadoPago.js no navegador para renderizar Checkout Bricks. Ela é pública por definição; o Access Token e o segredo do webhook continuam exclusivamente no servidor.

Após salvar os valores, faça um novo deploy. Enquanto Access Token, Public Key, URL HTTPS e configuração do modo de pagamento não estiverem válidos, a API não reserva números. Em produção, o webhook continua sendo a fonte de verdade da confirmação.

Para enviar comprovantes pelo Gmail, habilite a Gmail API em um projeto Google Cloud, crie um cliente OAuth, autorize a conta remetente com o escopo `https://www.googleapis.com/auth/gmail.send` e obtenha um refresh token para acesso offline. No Cloudflare Production, adicione `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` e `GMAIL_REFRESH_TOKEN` como Secrets, e `RECEIPT_EMAIL_FROM` como o endereço Gmail autorizado. Nunca coloque esses valores no repositório. Um consentimento OAuth em modo de teste expira após sete dias; para uso contínuo, configure o app OAuth em produção e conclua a verificação exigida pelo Google para o escopo de envio.

Como alternativa, configure `RESEND_API_KEY` e `RECEIPT_EMAIL_FROM` para usar Resend. Esses provedores são opcionais para o envio de confirmação; a consulta pelo site usa o código privado mostrado no comprovante e o telefone informado na compra.

## Funcionalidades

- Reserva de 1 a 20 números por até 30 minutos, com liberação automática quando expira.
- Checkout Bricks do Mercado Pago incorporado ao próprio site para Pix ou cartão, sem redirecionamento para o app/site do Mercado Pago; os números só ficam vendidos após confirmação validada.
- Comprovante privado, compartilhamento da rifa e consulta no site por código privado e telefone.
- Painel administrativo com visão das vendas, controle de abertura/encerramento e sorteio manual dos três números pagos.
- Banco D1 para pedidos, sessões administrativas, reservas, vendas e resultado do sorteio.

## Segurança

Nunca envie tokens ou senhas ao GitHub ou ao chat. `.env` e `data/` são ignorados pelo Git. Configure credenciais somente nos Secrets do ambiente Cloudflare correspondente. Use credenciais de teste em um projeto/ambiente de preview e credenciais de produção somente no ambiente Production.
