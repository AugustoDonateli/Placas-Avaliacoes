/**
 * Validacao do destino de uma placa.
 *
 * REGRA INEGOCIAVEL
 * -----------------
 * O destino de uma placa e SEMPRE um endereco controlado pelo Google.
 * Nunca um site arbitrario, nem mesmo um encurtador de terceiros.
 *
 * Motivo: o painel define para onde `SEUDOMINIO.com/001` aponta, e esse
 * dominio esta impresso em centenas de placas fisicas espalhadas por
 * estabelecimentos. Sem restricao de destino, um painel comprometido
 * transforma o dominio em ferramenta de phishing — e dominio em blacklist
 * nao se resolve trocando de servidor: as placas morrem junto.
 *
 * A allowlist tambem trabalha todo dia, e nao so em caso de ataque: ela pega
 * link colado errado ANTES da placa ser entregue ao cliente.
 *
 * COMO ADICIONAR UM FORMATO NOVO
 * ------------------------------
 * Toda a politica esta em GOOGLE_HOST_RULES, abaixo. Adicionar um formato
 * legitimo e acrescentar uma entrada nessa lista e um caso em
 * test/urls.test.ts. Nenhuma outra parte do arquivo precisa mudar.
 *
 * Ver docs/google-review-urls.md para os formatos pesquisados e a decisao
 * por tras de cada um.
 */

/**
 * Uma URL de Maps com dados completos de lugar passa tranquilamente de 400
 * caracteres. 2048 e folgado o bastante para nao recusar link legitimo e
 * apertado o bastante para barrar payload absurdo.
 */
export const MAX_URL_LENGTH = 2048;

export interface GoogleHostRule {
  /**
   * Host exato, em minusculas, SEM o prefixo `www.` — ele e removido na
   * normalizacao, entao `google.com` cobre `www.google.com` tambem.
   */
  readonly host: string;

  /**
   * Prefixos de caminho permitidos, sem barra final. `null` libera qualquer
   * caminho.
   *
   * A comparacao respeita limite de segmento: o prefixo `/maps` aceita
   * `/maps` e `/maps/place/x`, mas NAO aceita `/mapsqualquercoisa`.
   *
   * Restringir caminho nao e preciosismo — e o que fecha o open redirect
   * que o proprio Google opera em `/url?q=`. Ver REGRA DO CAMINHO abaixo.
   */
  readonly pathPrefixes: readonly string[] | null;

  /** Por que este host e confiavel. Obrigatorio: se nao da para escrever a
   *  justificativa, o host nao entra. */
  readonly why: string;
}

/**
 * A allowlist. Primeira versao — pensada para crescer.
 */
export const GOOGLE_HOST_RULES: readonly GoogleHostRule[] = [
  {
    host: 'g.page',
    pathPrefixes: null,
    why:
      'Encurtador oficial do Perfil da Empresa no Google. Serve apenas fichas ' +
      'de estabelecimento e formularios de avaliacao; nao existe caminho de ' +
      'redirecionamento arbitrario neste host. `/r/<codigo>/review` e o link ' +
      'que o proprio Google entrega ao dono em "Pedir avaliacoes".',
  },
  {
    host: 'search.google.com',
    pathPrefixes: ['/local'],
    why:
      'Formato longo do link de avaliacao: /local/writereview?placeid=<PLACE_ID> ' +
      'abre direto o formulario, e /local/reviews lista as avaliacoes. O ' +
      'caminho e limitado a /local porque o restante do host serve outros ' +
      'produtos de busca que nao auditamos.',
  },
  {
    host: 'maps.app.goo.gl',
    pathPrefixes: null,
    why:
      'Encurtador dedicado do Google Maps — e o que o botao Compartilhar gera ' +
      'hoje. Os caminhos sao codigos opacos, entao nao ha prefixo a exigir. ' +
      'Aceito porque o host so existe para links de Maps. Risco residual ' +
      'documentado em docs/google-review-urls.md: nao da para inspecionar o ' +
      'destino final sem seguir o redirecionamento.',
  },
  {
    host: 'goo.gl',
    pathPrefixes: ['/maps'],
    why:
      'Encurtador legado. O Google encerrou o goo.gl em agosto de 2025 mas ' +
      'preservou os links gerados pelos proprios apps, e links de Maps antigos ' +
      'continuam em circulacao. O caminho e restrito a /maps justamente porque ' +
      'fora dele o goo.gl era um encurtador de proposito geral, capaz de ' +
      'apontar para qualquer site.',
  },
  {
    host: 'maps.google.com',
    pathPrefixes: ['/', '/maps'],
    why:
      'Subdominio classico do Maps. `/?cid=<CID>` e o formato por CID e ' +
      '`/maps/...` o formato completo. O caminho e restrito em vez de liberado ' +
      'para que um eventual /url servido por este host nao vire brecha.',
  },
  {
    host: 'maps.google.com.br',
    pathPrefixes: ['/', '/maps'],
    why: 'Mesma coisa que maps.google.com, no ccTLD brasileiro.',
  },
  {
    host: 'google.com',
    pathPrefixes: ['/maps', '/search'],
    why:
      'Host principal. /maps cobre os links completos de ficha. /search cobre ' +
      'o deep link de avaliacao que o Maps as vezes produz ' +
      '(/search?q=<nome>#lrd=...). O prefixo e OBRIGATORIO aqui: sem ele, ' +
      '/url?q=<qualquer site> passaria e reintroduziria o open redirect.',
  },
  {
    host: 'google.com.br',
    pathPrefixes: ['/maps', '/search'],
    why:
      'ccTLD brasileiro do host principal. Aparece o tempo todo no Brasil, ' +
      'porque o navegador do dono do estabelecimento frequentemente esta em ' +
      'google.com.br quando ele copia o link.',
  },
];

/**
 * REGRA DO CAMINHO — por que hosts confiaveis ainda precisam de prefixo
 * ---------------------------------------------------------------------
 * O Google opera um redirecionador aberto no proprio dominio:
 *
 *     https://www.google.com/url?q=https://site-malicioso.com
 *
 * Uma allowlist que confiasse apenas no host aceitaria essa URL e deixaria o
 * open redirect entrar pela porta dos fundos — exatamente aquilo que a
 * allowlist existe para impedir. Por isso `google.com` so passa em `/maps` e
 * `/search`, e `/url` fica de fora.
 */

/**
 * NAO ESTAO NA LISTA, DE PROPOSITO
 * --------------------------------
 * business.google.com — painel administrativo do dono. Exige login dele e nao
 *   abre nada para o cliente final. Se aparecer como destino, e erro de copia
 *   e queremos que a validacao pegue o erro.
 *
 * g.co — encurtador institucional do Google (g.co/kgs/... aparece em
 *   compartilhamentos do painel de conhecimento). E do Google, mas serve
 *   muitos produtos alem de fichas de empresa. Fora ate haver necessidade
 *   concreta.
 *
 * Encurtadores de terceiros (bit.ly e afins) — destino opaco e fora do
 *   controle do Google. Nunca entram.
 */

export type UrlRejectReason =
  | 'empty'
  | 'too_long'
  | 'unparseable'
  | 'not_https'
  | 'has_credentials'
  | 'non_default_port'
  | 'host_not_allowed'
  | 'path_not_allowed';

/**
 * `review_form` abre direto o formulario de escrever avaliacao.
 * `listing` abre a ficha do estabelecimento — o cliente ainda precisa achar
 * o botao de avaliar, e converte bem pior.
 *
 * Os dois sao aceitos: na pratica o dono do estabelecimento entrega um
 * `listing` na maioria das vezes, e recusar travaria a venda. A distincao
 * existe para o painel poder avisar.
 */
export type DestinationKind = 'review_form' | 'listing';

export type ParsedDestination =
  | {
      readonly ok: true;
      /** URL normalizada, pronta para gravar no banco. */
      readonly url: string;
      readonly kind: DestinationKind;
      readonly host: string;
    }
  | { readonly ok: false; readonly reason: UrlRejectReason };

/** Remove um unico `www.` do inicio. Como a comparacao seguinte e por
 *  igualdade exata, isso nao abre brecha: `www.google.com.evil.com` vira
 *  `google.com.evil.com`, que nao e igual a nenhum host da lista. */
function bareHost(hostname: string): string {
  const host = hostname.toLowerCase();
  return host.startsWith('www.') ? host.slice(4) : host;
}

function findRule(hostname: string): GoogleHostRule | undefined {
  const host = bareHost(hostname);
  return GOOGLE_HOST_RULES.find((rule) => rule.host === host);
}

/**
 * Casamento de prefixo respeitando limite de segmento, para que `/maps` nao
 * acabe autorizando `/mapsqualquercoisa`.
 *
 * A comparacao ignora maiusculas: o Google sempre gera caminhos minusculos,
 * mas um link digitado a mao com `/Maps` e legitimo e nao deve ser recusado.
 * Isso nao afrouxa nada, porque o conjunto de prefixos permitidos continua
 * o mesmo — `/URL` tambem nao esta nele.
 */
function pathAllowed(
  pathname: string,
  prefixes: readonly string[] | null,
): boolean {
  if (prefixes === null) return true;

  const path = pathname.toLowerCase();
  return prefixes.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

/** Um destino e formulario de avaliacao quando o caminho diz isso
 *  explicitamente: `/r/<codigo>/review` no g.page, `/local/writereview` no
 *  search.google.com. Qualquer outra coisa abre a ficha. */
function classify(url: URL): DestinationKind {
  const path = url.pathname.toLowerCase();
  const isReview =
    path === '/review' || path.endsWith('/review') || path.includes('writereview');
  return isReview ? 'review_form' : 'listing';
}

/**
 * Valida e normaliza um destino.
 *
 * Roda na ESCRITA, no painel, onde pode ser detalhada. O caminho de
 * redirecionamento nao chama esta funcao: la basta conferir `https://`, ja
 * que o que esta gravado no banco ja passou por aqui.
 */
export function parseDestination(raw: string): ParsedDestination {
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  if (trimmed.length > MAX_URL_LENGTH) {
    return { ok: false, reason: 'too_long' };
  }

  // Deixamos o parser da plataforma normalizar em vez de tentar limpar a
  // string a mao: ele remove tabs e quebras de linha, resolve escapes,
  // converte host unicode para punycode e rebaixa o host para minusculas.
  // Validamos o RESULTADO dessa normalizacao, que e o que o navegador do
  // cliente realmente veria — e por isso truques de ofuscacao na entrada nao
  // ajudam quem tentar burlar.
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'unparseable' };
  }

  // Cobre http:, javascript:, data:, file:, ftp: e qualquer outro esquema.
  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'not_https' };
  }

  // `https://google.com@evil.com/` tem host evil.com — o parser ja resolve
  // isso e a checagem de host pegaria. Recusamos credenciais mesmo assim:
  // uma URL dessas exibida no painel engana quem estiver conferindo.
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'has_credentials' };
  }

  // O parser zera a porta quando ela e a padrao do esquema, entao um `:443`
  // explicito passa e um `:8443` nao. O Google nao serve em porta exotica.
  if (url.port !== '') {
    return { ok: false, reason: 'non_default_port' };
  }

  const rule = findRule(url.hostname);
  if (rule === undefined) {
    return { ok: false, reason: 'host_not_allowed' };
  }

  if (!pathAllowed(url.pathname, rule.pathPrefixes)) {
    return { ok: false, reason: 'path_not_allowed' };
  }

  return {
    ok: true,
    url: url.toString(),
    kind: classify(url),
    host: url.hostname,
  };
}

/** Atalho para quando so interessa o sim/nao. */
export function isValidDestination(raw: string): boolean {
  return parseDestination(raw).ok;
}

/**
 * Texto de recusa em portugues, para o painel mostrar. Fica junto dos
 * motivos para que um motivo novo nao possa ser criado sem mensagem.
 */
export function describeRejection(reason: UrlRejectReason): string {
  switch (reason) {
    case 'empty':
      return 'Cole o link de avaliacao do Google.';
    case 'too_long':
      return 'Esse link e longo demais. Confira se colou apenas o endereco.';
    case 'unparseable':
      return 'Isso nao parece um endereco valido. Confira o que foi colado.';
    case 'not_https':
      return 'Apenas enderecos https:// sao aceitos.';
    case 'has_credentials':
      return 'Esse endereco tem usuario e senha embutidos e nao e um link legitimo do Google.';
    case 'non_default_port':
      return 'Esse endereco usa uma porta incomum e nao e um link legitimo do Google.';
    case 'host_not_allowed':
      return 'So aceitamos links do Google (Maps, Perfil da Empresa ou formulario de avaliacao).';
    case 'path_not_allowed':
      return 'Esse e um endereco do Google, mas nao aponta para um estabelecimento. Use o link de avaliacao ou a ficha no Maps.';
  }
}
