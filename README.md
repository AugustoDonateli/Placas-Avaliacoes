# Placas de Avaliação

Redirecionador permanente para placas físicas com QR Code e NFC.

Cada placa carrega um código impresso uma única vez. O QR e a tag NFC apontam
para a **mesma URL**, no domínio próprio:

```
SEUDOMINIO.com/001
```

O sistema consulta o código e redireciona para o destino configurado no
momento. Trocar o estabelecimento de uma placa é alterar uma linha no banco —
**o QR físico nunca é reimpresso.** Essa é a característica central do produto.

---

## Requisito que guia o projeto

> Uma pessoa compra uma placa presencialmente e eu preciso conseguir
> configurá-la pelo celular em **menos de 1 minuto**.

Toda decisão de arquitetura do painel se subordina a isso.

---

## Stack

| | |
|---|---|
| Runtime | Cloudflare Workers |
| Banco | Cloudflare D1 (SQLite) |
| Autenticação do painel | Cloudflare Access |
| Custo de operação | R$ 0 (fora o domínio) |

O caminho de redirecionamento é deliberadamente sem framework: uma URL,
uma query, uma resposta 302. Ele não importa nada do código administrativo —
**se o painel quebrar, as placas continuam funcionando.**

---

## Etapas

| | Etapa | Status |
|---|---|---|
| 1 | Infraestrutura: projeto, schema, D1 local | ✅ concluída |
| 2 | `codes.ts` e `urls.ts` — normalização e allowlist | ✅ concluída |
| 3 | `redirect.ts` e `pages.ts` — o caminho público | ✅ concluída |
| 4 | Testes da máquina de estados | ✅ concluída |
| 5 | `access.ts` e `api.ts` — leitura e escrita protegidas | ✅ concluída |
| 6 | Deploy, domínio e Cloudflare Access | pendente |
| — | Painel e landing page | fora de escopo por enquanto |

As etapas 1 a 5 rodam **inteiramente local**. O domínio só é necessário na 6.

---

## Rodando localmente

Não é preciso ter conta na Cloudflare nem domínio registrado.

```bash
npm install
npm run db:migrate     # cria a tabela no D1 local
npm run db:seed        # dados de exemplo (opcional)
npm run dev            # sobe o Worker em localhost:8787
```

O banco local fica em `.wrangler/state/v3/d1` — é um arquivo SQLite comum,
ignorado pelo git.

### Comandos úteis

```bash
npm test               # roda a suite (265 testes)
npm run test:watch     # roda em modo watch
npm run db:list        # lista todas as placas
npm run db:reset       # apaga o banco local e recria do zero
npm run typecheck      # confere os tipos

# Qualquer SQL:
npx wrangler d1 execute placas-avaliacoes --local --command "SELECT * FROM plates;"
```

### Roteiro de teste manual

Com `npm run db:seed` aplicado e `npm run dev` rodando:

| Endereço | Placa | Esperado |
|---|---|---|
| `/001` | ativa | **302** + `Location` para o Google |
| `/002` | em estoque | 200 · "ainda não configurada" |
| `/003` | pausada | 200 · "temporariamente indisponível" |
| `/004` | aposentada | 200 · "plaquinha desativada" |
| `/005` | destino inválido | 200 · "erro de configuração" |
| `/006` | ativa, Place ID | **302**, com o Place ID intacto |
| `/999` | não existe | **404** · "código não encontrado" |

Para ver os cabeçalhos, que é onde estão as garantias:

```bash
curl -i http://localhost:8787/001
```

Confira que a resposta é `302` (nunca `301`) e traz `Cache-Control: no-store`.
As páginas de estado trazem `x-plate-state`, para você filtrar nos logs.

**A demonstração que vale a pena fazer** — trocar o cliente de uma placa sem
tocar no QR:

```bash
npx wrangler d1 execute placas-avaliacoes --local --command \
  "UPDATE plates SET destination_url='https://g.page/r/Restaurante/review' WHERE code='001';"

curl -i http://localhost:8787/001     # mesmo endereço, destino novo
```

### Variáveis de ambiente

| | |
|---|---|
| `ACCESS_TEAM_DOMAIN` | `suaequipe.cloudflareaccess.com` |
| `ACCESS_AUD` | a tag *Application Audience* da aplicação no Access |
| `ADMIN_EMAILS` | opcional: lista separada por vírgula. Camada extra sobre a política do Access. |
| `WHATSAPP_NUMBER` | número internacional só com dígitos. Liga o botão de contato nas páginas de estado. |
| `BRAND_NAME` | assinatura no rodapé das páginas. |

**Sem `ACCESS_TEAM_DOMAIN` e `ACCESS_AUD`, a API recusa tudo com 503.** Ela
nunca abre sozinha por falta de configuração — o dia do erro de configuração é
exatamente o dia em que a proteção precisa funcionar.

Para desenvolver local, copie `.dev.vars.example` para `.dev.vars`. O
`wrangler deploy` nunca envia esse arquivo, e o atalho que ele liga é ignorado
sempre que o Access está configurado.

---

## A API administrativa

Toda rota abaixo fica atrás do Cloudflare Access **e** da verificação de JWT
dentro do Worker.

| | |
|---|---|
| `GET /api/plates` | lista. Aceita `?status=` e `?limit=` |
| `GET /api/plates/:code` | uma placa |
| `POST /api/plates` | cria em lote: `{"from":"001","to":"020"}` ou `{"codes":[…]}` |
| `PATCH /api/plates/:code` | altera destino, estabelecimento, status e observações |

Criar uma faixa que encosta em placas existentes devolve **409 com a lista de
conflitos e não cria nada**. Envie `"skip_existing": true` para criar apenas as
que faltam.

`PATCH` recusa `code` no corpo com 400: o código está impresso no QR e gravado
na tag NFC. Também recusa ativar uma placa sem destino, e exige
`"confirm_reactivate": true` para tirar uma placa de `retired`.

### Testando a API localmente

```bash
cp .dev.vars.example .dev.vars
npm run db:reset
npm run dev
```

```bash
API=http://localhost:8787/api/plates

curl -X POST $API -H 'content-type: application/json' -d '{"from":"001","to":"020"}'
curl $API/004
curl -X PATCH $API/004 -H 'content-type: application/json' -d '{
  "establishment": "Barbearia do João",
  "destination_url": "https://g.page/r/CfMgH0abcDEF/review",
  "status": "active"
}'
curl -i http://localhost:8787/004     # já redireciona
```

Para testes de ponta a ponta com script, use `npm run dev:e2e` e
`npm run dev:stop`: matar o processo do wrangler **não** derruba o `workerd`
filho, que continua segurando a porta e servindo código antigo — e um teste
que fala com esse órfão devolve resultado falso com cara de verdadeiro.

---

## Modelo de dados

Uma tabela: `plates`. Ver `migrations/0001_create_plates.sql`.

| coluna | observação |
|---|---|
| `code` | o que está impresso no QR. Único, minúsculo, **imutável** |
| `destination_url` | destino atual. `NULL` enquanto em estoque |
| `status` | `draft` · `active` · `inactive` · `retired` |
| `establishment` | texto livre — ainda não existe tabela de clientes |

O banco não confia na aplicação: `CHECK` garante código minúsculo, destino
`https://` e status dentro do enum, mesmo em inserções feitas à mão via
`wrangler d1 execute` — que é como esta fase opera.

### Os quatro status

| status | `/001` responde |
|---|---|
| `draft` | página "ainda não configurada" |
| `active` | **302** para o destino |
| `inactive` | página "temporariamente indisponível" |
| `retired` | página "placa desativada" |

**Um código `retired` nunca volta a ser usado.** Se um estabelecimento fecha e
a placa física ainda existe no mundo, reciclar aquele código faria a placa
perdida apontar para o cliente errado.

---

## Regras que não se negociam

**Sempre `302`, nunca `301`.** Um `301` fica cacheado no navegador para sempre
e nenhum navegador respeita invalidação. Uma placa que respondeu `301` não pode
mais ser reatribuída — destruindo exatamente o que o sistema existe para
garantir. Toda resposta de redirecionamento leva `Cache-Control: no-store`.

**Sem cache do par código → destino.** Cache aqui produz o pior bug possível:
você troca o destino no painel, testa na frente do cliente, e ainda cai no
lugar antigo.

**`workers_dev = false`.** Com essa rota ativa, o Worker também responderia em
`*.workers.dev`, endereço que **não passa pelo Cloudflare Access** — uma porta
dos fundos direto na API que altera o destino das placas dos clientes.

**Allowlist de destinos.** Só hosts do Google, validados por host **e** por
prefixo de caminho. Ver [`docs/google-review-urls.md`](docs/google-review-urls.md) —
inclusive a armadilha do `google.com/url?q=`, que é um open redirect operado
pelo próprio Google.

---

## Deploy (etapa 6, ainda não executada)

```bash
npx wrangler d1 create placas-avaliacoes     # copiar o database_id para wrangler.toml
npx wrangler d1 migrations apply placas-avaliacoes --remote
npx wrangler deploy
```

Depois, no painel da Cloudflare: apontar a rota do domínio e criar a aplicação
do Access cobrindo `/admin*` e `/api*`, liberando apenas o seu e-mail.
