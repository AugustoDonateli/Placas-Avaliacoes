/**
 * Placas de Avaliacao — ponto de entrada.
 *
 * Este arquivo e deliberadamente magro: ele so decide QUAL caminho atende a
 * requisicao. A logica do redirecionamento vive em redirect.ts, que nao
 * importa nada daqui nem de api.ts.
 *
 * ORDEM DAS ROTAS — importa por seguranca
 * ---------------------------------------
 * `/api/*` e resolvido ANTES de qualquer tentativa de interpretar o caminho
 * como codigo de placa, e nunca cai no redirecionamento. E uma requisicao
 * administrativa so passa depois de requireAccess aprovar.
 *
 * ETAPAS CONCLUIDAS: 1, 2, 3 e 5.
 * A landing em `/` e o painel visual em `/admin` entram depois — e, quando
 * entrarem, nao podem importar nada para dentro de redirect.ts.
 */

import { requireAccess, type AccessConfig } from './access';
import { handleApi, type ApiEnv } from './api';
import { handleRedirect, type RedirectEnv } from './redirect';

export interface Env extends RedirectEnv, ApiEnv {
  readonly ACCESS_TEAM_DOMAIN?: string | undefined;
  readonly ACCESS_AUD?: string | undefined;
  readonly ADMIN_EMAILS?: string | undefined;
  /** Somente `.dev.vars`; ver access.ts. */
  readonly DEV_INSECURE_API?: string | undefined;
}

function accessConfig(env: Env): AccessConfig {
  return {
    teamDomain: env.ACCESS_TEAM_DOMAIN,
    aud: env.ACCESS_AUD,
    adminEmails: env.ADMIN_EMAILS,
    devInsecure: env.DEV_INSECURE_API,
  };
}

function denied(status: number, reason: string): Response {
  const message =
    status === 503
      ? 'A área administrativa não está configurada.'
      : status === 403
        ? 'Esta conta não tem permissão.'
        : 'Autenticação obrigatória.';

  return new Response(JSON.stringify({ error: 'unauthorized', message, reason }), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // --- administrativo: autenticacao primeiro, sempre ---
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      const access = await requireAccess(request, accessConfig(env));
      if (!access.ok) {
        return denied(access.status, access.reason);
      }
      return handleApi(request, url, env);
    }

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
