# Formatos de link do Google aceitos como destino

Documento de referência para a validação de `destination_url`.
A implementação da allowlist é a **etapa 2**; este documento é a decisão que
ela vai seguir.

> **Status de verificação.** Os formatos do Grupo 1 foram confirmados em
> pesquisa (setembro/2026). Os demais vêm de uso corrente e conhecimento
> prévio — `support.google.com` está bloqueado pelo proxy de rede deste
> ambiente, então **não** foi possível conferir a documentação oficial do
> Google. Antes de fechar a etapa 2, vale colar um link real de cada formato
> e confirmar que abre onde deve.

---

## Por que uma allowlist, e não "qualquer https"

O painel aceita uma URL e o servidor passa a redirecionar para ela. Sem
restrição de host, `SEUDOMINIO.com/001` vira um **open redirect**: se o painel
for comprometido, o seu domínio — que está impresso em centenas de placas
físicas — pode ser apontado para phishing. Domínio em blacklist é problema
que não se resolve trocando de servidor; as placas morrem junto.

A allowlist também tem um benefício diário e nada teórico: **pega link colado
errado antes de você entregar a placa ao cliente.**

---

## Grupo 1 — Links de avaliação de verdade ✅

São os que o Google entrega ao dono do estabelecimento quando ele pede
"link para avaliações". Abrem **direto no formulário de escrever avaliação**.
É o que você quer em toda placa.

| Formato | Exemplo |
|---|---|
| Link curto do Perfil da Empresa | `https://g.page/r/<código>/review` |
| Formato longo com Place ID | `https://search.google.com/local/writereview?placeid=<PLACE_ID>` |

**Como o dono consegue:** Perfil da Empresa → *Avaliações* → *Pedir avaliações*
/ *Get more reviews* → **Copiar link**.

---

## Grupo 2 — Links do Maps ⚠️

São links do Maps, não de avaliação. Abrem a **ficha do estabelecimento**, e o
cliente ainda precisa achar o botão "Escrever avaliação". Convertem bem pior.

São aceitos porque **é o que o dono vai te dar na prática** — a maioria não
sabe onde fica o link de avaliação e manda o botão "Compartilhar" do Maps.
Melhor aceitar e a placa funcionar do que recusar e travar a venda.

| Formato | Exemplo | Observação |
|---|---|---|
| Encurtador do Maps | `https://maps.app.goo.gl/XXXXXXXX` | atual, é o que o botão Compartilhar gera |
| Encurtador legado | `https://goo.gl/maps/XXXXXXXX` | ver aviso abaixo |
| Maps completo | `https://www.google.com/maps/place/...` | |
| Maps por CID | `https://www.google.com/maps?cid=<CID>` | |
| Maps ccTLD | `https://www.google.com.br/maps/place/...` | **muito comum no Brasil** |
| Subdomínio Maps | `https://maps.google.com/...` · `https://maps.google.com.br/...` | |

> ### ⚠️ Sobre `goo.gl/maps`
> O Google encerrou o encurtador `goo.gl` em **25 de agosto de 2025**.
> Links gerados pelos próprios apps do Google (Maps incluído) foram
> preservados, mas o formato está oficialmente morto e novos não são criados.
> **Aceitar, mas preferir converter:** se o cliente te der um `goo.gl/maps`,
> vale abrir, chegar na ficha e pegar um link do Grupo 1.

**Recomendação de produto:** aceite o Grupo 2 para não travar a venda, mas o
painel deve **avisar** — *"esse link abre a ficha, não o formulário de
avaliação. Quer ajuda para pegar o link direto?"* — sem bloquear.

---

## Grupo 3 — Rejeitados ❌

| Formato | Por que rejeitar |
|---|---|
| `https://business.google.com/...` | Painel administrativo do dono. Exige login dele; para o cliente final não abre nada. Se aparecer, é erro de cópia. |
| `https://www.google.com/url?q=...` | **Open redirect operado pelo próprio Google.** Ver abaixo — é o furo mais importante deste documento. |
| Qualquer host fora da lista | Inclusive encurtadores de terceiros (bit.ly etc.): destino opaco, impossível de validar. |
| `http://` | Sem exceção. Já barrado pelo `CHECK` da tabela. |

---

## 🔴 A armadilha: `google.com/url?q=`

O Google opera um redirecionador aberto no próprio domínio:

```
https://www.google.com/url?q=https://site-malicioso.com
```

Uma allowlist que aceite o host `google.com` **com qualquer caminho** deixa o
open redirect entrar pela porta dos fundos — exatamente aquilo que a allowlist
existe para impedir.

**Por isso a validação é por host _e_ por prefixo de caminho**, não só por host.

---

## A regra, como será implementada

Aceitar se, e somente se, todas as condições valerem:

1. O esquema é `https:`
2. O host (em minúsculas) está na tabela abaixo
3. O caminho começa com um dos prefixos exigidos para aquele host

| Host | Prefixo de caminho exigido |
|---|---|
| `g.page` | qualquer |
| `maps.app.goo.gl` | qualquer |
| `maps.google.com` · `maps.google.com.br` | qualquer |
| `goo.gl` | `/maps/` |
| `search.google.com` | `/local/` |
| `google.com` · `www.google.com` | `/maps` ou `/search` |
| `google.com.br` · `www.google.com.br` | `/maps` ou `/search` |

Nenhuma outra validação de formato. **Não** vamos conferir o formato do Place
ID, o comprimento do código do `g.page` nem a estrutura da query string —
é aí que validação esperta quebra link legítimo, que foi exatamente o que
você pediu para evitar.

---

## Regras de normalização

Aplicadas antes da validação, na escrita:

- **Remover espaços** nas pontas (colar do WhatsApp traz espaço e quebra de linha)
- **Host em minúsculas** — `WWW.Google.COM` é o mesmo host
- **Rejeitar o que `new URL()` não conseguir parsear**

### ⚠️ Nunca aplicar `toLowerCase()` na URL inteira

Place IDs e códigos do `g.page` são **sensíveis a maiúsculas e minúsculas**:

```
ChIJN1t_tDeuEmsRUsoyG83frY4      ← Place ID válido
chijn1t_tdeuemsrusoyg83fry4      ← quebrado, não existe
```

Minúsculas **só no host**. O caminho e a query ficam intocados.

---

## Adicionar um host novo

Um formato legítimo recusado vira venda travada dentro da loja. Quando
aparecer:

1. Conferir que o link realmente abre o estabelecimento certo
2. Adicionar host e prefixo de caminho à tabela acima **e** ao código
3. Adicionar um caso de teste com esse link
4. Fazer deploy

Se algum dia for urgente resolver na hora, dentro do estabelecimento, o
caminho é `wrangler d1 execute` alterando a linha à mão — o `CHECK` da tabela
ainda garante `https://`. É uma saída de emergência, não a rotina.
