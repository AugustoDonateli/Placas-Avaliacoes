/**
 * O caminho quente: GET /<code> -> 302 para o Google.
 *
 * INDEPENDENCIA
 * -------------
 * Este modulo importa apenas codes.ts, urls.ts e pages.ts — tres modulos de
 * funcoes puras, sem rede e sem estado. Nenhum framework, nenhum roteador,
 * nenhuma biblioteca de autenticacao, nada do painel.
 *
 * Isso e proposital: se o painel quebrar, as placas continuam funcionando.
 *
 * REGRAS INEGOCIAVEIS
 * -------------------
 * 1. SEMPRE 302, NUNCA 301.
 *    Um 301 fica cacheado no navegador para sempre e nenhum navegador
 *    respeita invalidacao. Uma placa que respondeu 301 nao pode mais ser
 *    reatribuida — destruindo exatamente aquilo que o sistema existe para
 *    garantir. Ha teste travando isso.
 *
 * 2. NENHUM CACHE.
 *    Toda resposta leva Cache-Control: no-store. Cache aqui produz o pior bug
 *    possivel: voce troca o destino no painel, testa na frente do cliente, e
 *    ainda cai no lugar antigo.
 */

import { parseCode } from './codes';
import { renderPage, type BrandConfig, type PageState } from './pages';
import { parseDestination, type UrlRejectReason } from './urls';

export interface RedirectEnv {
  readonly DB: D1Database;
  readonly WHATSAPP_NUMBER?: string | undefined;
  readonly BRAND_NAME?: string | undefined;
}

/** A linha que o caminho quente le. Apenas duas colunas: qualquer coluna a
 *  mais e trabalho que o banco faz a toa em cada escaneamento. */
interface PlateRow {
  readonly destination_url: string | null;
  readonly status: string;
}

export type Resolution =
  | { readonly outcome: 'redirect'; readonly url: string }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'not_configured' }
  | { readonly outcome: 'paused' }
  | { readonly outcome: 'retired' }
  | { readonly outcome: 'misconfigured'; readonly reason: UrlRejectReason }
  | { readonly outcome: 'db_error' };

const LOOKUP_SQL =
  'SELECT destination_url, status FROM plates WHERE code = ?1 LIMIT 1';

/**
 * A maquina de estados, separada do HTTP para poder ser testada como dado.
 *
 * `rawCode` e o segmento cru do caminho; a normalizacao acontece aqui dentro.
 */
export async function resolvePlate(
  db: D1Database,
  rawCode: string,
): Promise<Resolution> {
  const parsed = parseCode(rawCode);

  // Codigo malformado ou reservado nunca chega ao banco: economiza uma query
  // e impede que lixo no caminho vire carga no D1.
  if (!parsed.ok) {
    return { outcome: 'not_found' };
  }

  let row: PlateRow | null;
  try {
    row = await db
      .prepare(LOOKUP_SQL)
      .bind(parsed.code)
      .first<PlateRow>();
  } catch (error) {
    // O banco caiu. Nao e culpa da placa e nao e 404: a resposta precisa
    // dizer "tente de novo", nao "nao existe".
    console.error(`[db_error] falha ao consultar a placa ${parsed.code}:`, error);
    return { outcome: 'db_error' };
  }

  if (row === null) {
    return { outcome: 'not_found' };
  }

  // A ordem importa. `retired` primeiro porque uma placa aposentada pode ter
  // destino ainda gravado, e ela nunca deve redirecionar.
  switch (row.status) {
    case 'retired':
      return { outcome: 'retired' };
    case 'inactive':
      return { outcome: 'paused' };
    case 'draft':
      return { outcome: 'not_configured' };
    case 'active':
      break;
    default:
      // Status desconhecido: o CHECK da tabela nao deveria permitir. Se
      // chegou aqui, algo escreveu por fora — nao redirecione.
      console.error(
        `[misconfigured] placa ${parsed.code} com status inesperado: ${row.status}`,
      );
      return { outcome: 'misconfigured', reason: 'host_not_allowed' };
  }

  if (row.destination_url === null || row.destination_url.trim() === '') {
    return { outcome: 'not_configured' };
  }

  // A allowlist e reaplicada na LEITURA, e nao apenas na escrita.
  //
  // Custa um `new URL()` e uma busca em lista de oito itens — nada perto dos
  // milissegundos da consulta ao D1 que acabou de acontecer. Em troca, cobre
  // os casos em que a validacao de escrita nao esteve no caminho: linha
  // inserida a mao via `wrangler d1 execute` (que e como esta fase opera),
  // linha gravada antes de a allowlist existir, ou linha alterada por fora.
  //
  // Contrapartida assumida: apertar a allowlist no futuro pode fazer uma
  // placa em campo parar de redirecionar e passar a mostrar erro. Preferimos
  // isso a manter uma placa apontando para um destino que ja decidimos nao
  // permitir — a pagina de erro avisa que ha problema, o redirecionamento
  // errado nao avisa ninguem.
  const destination = parseDestination(row.destination_url);
  if (!destination.ok) {
    console.error(
      `[misconfigured] placa ${parsed.code} com destino invalido (${destination.reason}): ${row.destination_url}`,
    );
    return { outcome: 'misconfigured', reason: destination.reason };
  }

  return { outcome: 'redirect', url: destination.url };
}

/** Estado da maquina -> pagina e status HTTP.
 *
 *  Um codigo que nao existe e 404. Os demais estados descrevem uma placa que
 *  EXISTE mas nao vai redirecionar agora, entao a pagina e a resposta correta
 *  para aquele recurso: 200. O banco fora do ar e 503, que e transitorio. */
const PAGE_STATUS: Record<PageState, number> = {
  not_found: 404,
  not_configured: 200,
  paused: 200,
  retired: 200,
  misconfigured: 200,
  db_error: 503,
};

function brandFrom(env: RedirectEnv): BrandConfig {
  return { whatsapp: env.WHATSAPP_NUMBER, brandName: env.BRAND_NAME };
}

function pageResponse(
  state: PageState,
  code: string | null,
  env: RedirectEnv,
): Response {
  return new Response(renderPage(state, code, brandFrom(env)), {
    status: PAGE_STATUS[state],
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
      // Facilita filtrar o estado nos logs da Cloudflare sem adivinhar pelo
      // corpo da resposta.
      'x-plate-state': state,
    },
  });
}

/**
 * Handler HTTP do caminho publico.
 *
 * `pathname` chega cru (com as barras); parseCode normaliza.
 */
export async function handleRedirect(
  request: Request,
  pathname: string,
  env: RedirectEnv,
): Promise<Response> {
  // Bots de previa de link (WhatsApp, Telegram) usam GET e HEAD. O runtime
  // remove o corpo do HEAD sozinho, entao o mesmo caminho serve os dois.
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Método não permitido.\n', {
      status: 405,
      headers: {
        allow: 'GET, HEAD',
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  }

  const rawCode = pathname;
  const parsed = parseCode(rawCode);
  const code = parsed.ok ? parsed.code : null;

  const resolution = await resolvePlate(env.DB, rawCode);

  if (resolution.outcome === 'redirect') {
    return new Response(null, {
      // 302, nunca 301. Ver o cabecalho deste arquivo.
      status: 302,
      headers: {
        location: resolution.url,
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex',
      },
    });
  }

  return pageResponse(resolution.outcome, code, env);
}
