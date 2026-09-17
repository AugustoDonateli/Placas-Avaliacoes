/**
 * Placas de Avaliacao — redirecionador permanente.
 *
 * ESTADO ATUAL: etapa 1 (infraestrutura). Este arquivo e um esqueleto.
 * A maquina de estados do redirecionamento entra na etapa 3, em src/redirect.ts.
 *
 * Ver README.md para o plano de etapas.
 */

export interface Env {
  DB: D1Database;
}

export default {
  async fetch(): Promise<Response> {
    return new Response("Ainda nao implementado.\n", {
      status: 503,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  },
} satisfies ExportedHandler<Env>;
