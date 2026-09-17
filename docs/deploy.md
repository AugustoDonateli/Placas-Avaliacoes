# Deploy — etapa 6

Roteiro do primeiro deploy. Cada passo tem um resultado conferível: se ele não
aparecer, pare ali em vez de seguir.

> **Pré-requisito que bloqueia tudo:** o domínio precisa estar registrado e com
> os nameservers apontando para a Cloudflare. Nada abaixo funciona sem isso, e
> **nenhuma placa deve ser impressa antes** — o domínio é o que fica gravado no
> QR e na tag NFC, para sempre.

---

## 1. Domínio na Cloudflare

1. Registre o domínio (`.com.br` no registro.br, ~R$40/ano — **pague 5 anos**).
2. Crie a conta na Cloudflare e adicione o domínio como *site*.
3. A Cloudflare mostra dois nameservers. Coloque-os no registro.br, em
   *Alterar servidores DNS*.
4. Espere a propagação (minutos a algumas horas).

**Conferível:** o domínio aparece como *Active* no painel da Cloudflare.

---

## 2. Banco de dados remoto

```bash
npx wrangler d1 create placas-avaliacoes
```

O comando imprime um `database_id`. Cole no `wrangler.toml`, substituindo o
placeholder `00000000-...`.

Aplique a migration no banco remoto:

```bash
npx wrangler d1 migrations apply placas-avaliacoes --remote
```

**Conferível:**

```bash
npx wrangler d1 execute placas-avaliacoes --remote \
  --command "SELECT count(*) FROM plates;"
```

Deve responder `0`. Se der erro de tabela inexistente, a migration não foi
aplicada.

---

## 3. Cloudflare Access

No painel: **Zero Trust → Access → Applications → Add an application →
Self-hosted**.

| Campo | Valor |
|---|---|
| Application name | `Placas — Admin` |
| Session duration | **1 mês** — você não pode ser deslogado dentro de uma loja |
| Domain | `SEUDOMINIO.com.br` |
| Path | `api` |

Adicione uma **segunda aplicação idêntica** com Path `admin`, para quando o
painel visual existir.

**Policy:** *Allow* → *Emails* → o seu e-mail.

**Identity provider:** Google (login de um toque no celular).

Ao salvar, a aplicação mostra a **Application Audience (AUD) Tag**. Copie.

**Conferível:** abrir `https://SEUDOMINIO.com.br/api/plates` numa aba anônima
mostra a tela de login da Cloudflare, não um JSON.

---

## 4. Variáveis

Descomente a seção `[vars]` do `wrangler.toml` e preencha:

```toml
[vars]
ACCESS_TEAM_DOMAIN = "suaequipe.cloudflareaccess.com"
ACCESS_AUD = "a-tag-que-voce-copiou-no-passo-3"
ADMIN_EMAILS = "seu@email.com"
WHATSAPP_NUMBER = "5519999999999"
BRAND_NAME = "Placas de Avaliação"
```

Nenhuma delas é segredo — são identificadores públicos. A segurança vem da
assinatura do JWT, não de esconder esses valores.

Descomente também a rota, trocando o domínio:

```toml
routes = [
  { pattern = "SEUDOMINIO.com.br/*", zone_name = "SEUDOMINIO.com.br" }
]
```

---

## 5. Conferência antes de publicar

```bash
npm run preflight
```

Ele reprova se: `workers_dev` não estiver `false`, as variáveis do Access
estiverem vazias, a rota ainda tiver `SEUDOMINIO`, o `database_id` for o
placeholder, ou se testes/typecheck falharem.

**Só siga com ele verde.**

---

## 6. Publicar

```bash
npm run deploy      # roda o preflight e só então publica
```

---

## 7. Conferência depois de publicar

```bash
npm run smoke SEUDOMINIO.com.br 001 placas-avaliacoes.SUACONTA.workers.dev
```

O terceiro argumento é opcional mas **vale passar uma vez**: é o que confirma
que não existe uma cópia do Worker respondendo fora do Access.

O smoke confere quatro coisas que, erradas, quebram o produto sem dar sinal:

1. o redirecionamento responde **302 e não 301**;
2. a resposta não pode ser cacheada;
3. a API exige autenticação de verdade;
4. não há porta dos fundos em `*.workers.dev`.

---

## 8. Primeiro lote de placas

Com o Access funcionando, o navegador já carrega o cookie de sessão — então o
`curl` do seu computador precisa do token. O caminho mais simples é usar o
próprio navegador, ou instalar o `cloudflared` para gerar o cabeçalho.

Pelo navegador, com a sessão do Access ativa, a criação em lote é:

```
POST https://SEUDOMINIO.com.br/api/plates
{"from":"001","to":"020"}
```

**Conferível:** `GET /api/plates` lista 20 placas em `draft`, e
`https://SEUDOMINIO.com.br/001` mostra a página "ainda não configurada".

**Esse é o momento de gerar os QR Codes** — e só então mandar imprimir.

---

## Se algo der errado

| Sintoma | Causa provável |
|---|---|
| `/001` dá 404 mesmo com a placa no banco | migration aplicada só no banco local; falta `--remote` |
| `/api` devolve JSON em aba anônima | a aplicação do Access não cobre o path `api` |
| `/api` devolve 503 logado | `ACCESS_AUD` ou `ACCESS_TEAM_DOMAIN` não chegaram ao Worker |
| `/api` devolve 401 logado | o `ACCESS_AUD` no `wrangler.toml` é de outra aplicação |
| `/api` devolve 403 logado | seu e-mail não está em `ADMIN_EMAILS` |
| Tudo funciona em `*.workers.dev` | `workers_dev` voltou a `true` — **corrija imediatamente** |

---

## O que NÃO fazer

**Nunca imprima QR antes do smoke passar.** O QR é a única parte irreversível
do sistema inteiro.

**Nunca troque `302` por `301`**, nem "só para testar". Um `301` fica cacheado
no navegador para sempre e nenhum navegador respeita invalidação — a placa que
respondeu `301` não pode mais ser reatribuída.

**Nunca ligue `workers_dev`.** É a única porta dos fundos possível nesta
arquitetura.
