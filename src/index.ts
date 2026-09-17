/**
 * Placas de Avaliacao — ponto de entrada.
 *
 * Este arquivo e deliberadamente magro: ele so decide QUAL caminho atende a
 * requisicao. Toda a logica do redirecionamento vive em redirect.ts, que nao
 * depende de nada daqui.
 *
 * ETAPAS CONCLUIDAS: 1 (infraestrutura), 2 (validacao), 3 (redirecionamento).
 * A landing em `/` e o painel em `/admin` entram depois — e, quando entrarem,
 * nao podem importar nada para dentro de redirect.ts.
 */

import { handleRedirect, type RedirectEnv } from './redirect';

export interface Env extends RedirectEnv {}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    // A landing e um modulo a parte, ainda nao construido. Ela e independente
    // do redirecionamento: se quebrar, /001 continua funcionando.
    if (pathname === '/') {
      return new Response('Placas de Avaliação\n', {
        status: 200,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        },
      });
    }

    return handleRedirect(request, pathname, env);
  },
} satisfies ExportedHandler<Env>;
