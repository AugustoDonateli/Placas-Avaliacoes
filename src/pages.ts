/**
 * Paginas de estado do redirecionador.
 *
 * Sao o que uma pessoa ve quando escaneou um QR e a placa NAO vai redirecionar.
 * Ou seja: sao a superficie de falha do produto, na mao de um cliente do seu
 * cliente, dentro do estabelecimento. Precisam parecer profissionais.
 *
 * Sem framework, sem dependencia, sem requisicao externa: tudo inline, para
 * que a pagina abra instantaneamente mesmo no 3G ruim de um subsolo — e para
 * que este modulo nao arraste nada para o caminho quente.
 */

/** Configuracao opcional vinda do ambiente. Toda ausente = pagina sem CTA. */
export interface BrandConfig {
  /** Numero no formato internacional sem simbolos, ex: 5511999999999 */
  readonly whatsapp?: string | undefined;
  readonly brandName?: string | undefined;
}

export type PageState =
  | 'not_found'
  | 'not_configured'
  | 'paused'
  | 'retired'
  | 'misconfigured'
  | 'db_error';

interface PageCopy {
  readonly title: string;
  readonly heading: string;
  readonly body: string;
  /** Mostra o convite comercial. So faz sentido onde a pessoa pode virar lead. */
  readonly offer: boolean;
  /** Mostra o codigo da placa, para o cliente citar no suporte. */
  readonly showCode: boolean;
}

const COPY: Record<PageState, PageCopy> = {
  not_found: {
    title: 'Código não encontrado',
    heading: 'Código não encontrado',
    body: 'Não localizamos nenhuma plaquinha com esse código. Confira se o endereço foi digitado corretamente.',
    offer: true,
    showCode: true,
  },
  not_configured: {
    title: 'Plaquinha ainda não configurada',
    heading: 'Ainda não configurada',
    body: 'Esta plaquinha existe, mas ainda não foi vinculada a um estabelecimento.',
    offer: true,
    showCode: true,
  },
  paused: {
    title: 'Temporariamente indisponível',
    heading: 'Temporariamente indisponível',
    body: 'Esta plaquinha está pausada no momento. Tente novamente mais tarde.',
    offer: false,
    showCode: true,
  },
  retired: {
    title: 'Plaquinha desativada',
    heading: 'Plaquinha desativada',
    body: 'Esta plaquinha não está mais em uso.',
    offer: true,
    showCode: true,
  },
  misconfigured: {
    title: 'Erro de configuração',
    heading: 'Erro de configuração',
    body: 'O endereço cadastrado para esta plaquinha não é válido. Se você é o responsável pelo estabelecimento, entre em contato para corrigirmos.',
    offer: false,
    showCode: true,
  },
  db_error: {
    title: 'Indisponível no momento',
    heading: 'Indisponível no momento',
    body: 'Não conseguimos carregar esta plaquinha agora. Tente de novo em alguns instantes.',
    offer: false,
    showCode: false,
  },
};

/** Escapa para interpolacao segura em HTML. O codigo ja vem validado como
 *  [a-z0-9], mas os valores de ambiente nao — e um dia alguem cola um `&`
 *  no nome da marca. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Mantem apenas digitos: um numero de WhatsApp malformado no ambiente nao
 *  pode virar atributo href arbitrario. */
function sanitizePhone(value: string): string {
  return value.replace(/\D/g, '');
}

export function renderPage(
  state: PageState,
  code: string | null,
  brand: BrandConfig = {},
): string {
  const copy = COPY[state];
  const brandName = brand.brandName ? escapeHtml(brand.brandName) : null;
  const phone = brand.whatsapp ? sanitizePhone(brand.whatsapp) : '';

  const codeBlock =
    copy.showCode && code
      ? `<p class="code">código <strong>${escapeHtml(code)}</strong></p>`
      : '';

  const offerBlock =
    copy.offer && phone
      ? `<div class="offer">
      <p>Quer uma dessas no seu estabelecimento?</p>
      <a class="btn" href="https://wa.me/${phone}">Falar no WhatsApp</a>
    </div>`
      : '';

  const footer = brandName ? `<footer>${brandName}</footer>` : '';

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(copy.title)}</title>
<style>
  :root {
    --bg: #f6f7f8;
    --card: #ffffff;
    --ink: #17191c;
    --muted: #6b7280;
    --line: #e4e7eb;
    --accent: #1f6f4f;
    --accent-ink: #ffffff;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #121416;
      --card: #1b1e21;
      --ink: #e8eaec;
      --muted: #9aa2ab;
      --line: #2a2f34;
      --accent: #4fb489;
      --accent-ink: #0e1512;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px 20px;
    background: var(--bg);
    color: var(--ink);
    font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main {
    width: 100%;
    max-width: 420px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 32px 26px;
    text-align: center;
  }
  h1 { margin: 0 0 12px; font-size: 22px; line-height: 1.25; }
  p { margin: 0 0 14px; color: var(--muted); }
  .code {
    margin: 18px 0 0;
    font-size: 13px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    color: var(--muted);
  }
  .code strong { color: var(--ink); }
  .offer {
    margin-top: 26px;
    padding-top: 22px;
    border-top: 1px solid var(--line);
  }
  .offer p { margin-bottom: 14px; color: var(--ink); font-weight: 500; }
  .btn {
    display: inline-block;
    padding: 12px 22px;
    border-radius: 9px;
    background: var(--accent);
    color: var(--accent-ink);
    font-weight: 600;
    text-decoration: none;
  }
  footer {
    margin-top: 24px;
    font-size: 12px;
    letter-spacing: .06em;
    text-transform: uppercase;
    color: var(--muted);
  }
</style>
</head>
<body>
  <main>
    <h1>${escapeHtml(copy.heading)}</h1>
    <p>${escapeHtml(copy.body)}</p>
    ${codeBlock}
    ${offerBlock}
    ${footer}
  </main>
</body>
</html>
`;
}
