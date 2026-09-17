/**
 * Verificacao do JWT do Cloudflare Access, dentro do Worker.
 *
 * POR QUE ISTO EXISTE
 * -------------------
 * O Cloudflare Access ja barra quem nao e voce, na borda, antes da requisicao
 * chegar aqui. Esta verificacao e a SEGUNDA camada, e existe porque a primeira
 * depende inteiramente de configuracao externa:
 *
 *   - `workers_dev = true` reativado sem querer publica o Worker em
 *     *.workers.dev, endereco que NAO passa pelo Access;
 *   - uma politica do Access editada com o caminho errado deixa /api aberto;
 *   - uma rota nova adicionada fora da aplicacao do Access fica sem cobertura.
 *
 * Em qualquer um desses casos, a configuracao externa falha em silencio e sem
 * aviso. Com a verificacao aqui, a requisicao ainda morre: sem um JWT valido,
 * assinado pelo seu time e emitido para esta aplicacao, a API nao responde.
 *
 * FALHA FECHADA
 * -------------
 * Sem configuracao de Access, a API NAO abre — ela recusa tudo. Uma API de
 * escrita que abre sozinha quando mal configurada e como nao ter protecao
 * nenhuma, porque o dia do erro de configuracao e exatamente o dia em que a
 * protecao precisa funcionar.
 *
 * O unico caminho alternativo e o de desenvolvimento local, descrito em
 * DEV_INSECURE_API mais abaixo — que por construcao nao alcanca producao.
 */

export interface AccessConfig {
  /** Ex: `suaequipe.cloudflareaccess.com` */
  readonly teamDomain?: string | undefined;
  /** A tag "Application Audience (AUD)" da aplicacao no Access. */
  readonly aud?: string | undefined;
  /** Lista de e-mails separados por virgula. Opcional: o Access ja restringe
   *  quem recebe token. Quando presente, e mais uma tranca. */
  readonly adminEmails?: string | undefined;
  /**
   * SOMENTE DESENVOLVIMENTO LOCAL.
   *
   * Coloque `DEV_INSECURE_API = "true"` em `.dev.vars` — arquivo que esta no
   * .gitignore e que o `wrangler deploy` NUNCA envia. E essa propriedade do
   * Wrangler, e nao a nossa disciplina, que impede o atalho de chegar em
   * producao.
   *
   * Alem disso, o atalho so vale quando o Access NAO esta configurado: se
   * `aud` existir, esta bandeira e ignorada. Entao um deploy de producao, que
   * tem Access configurado, nao pode ser rebaixado por uma variavel solta.
   */
  readonly devInsecure?: string | undefined;
}

export type AccessIdentity = {
  readonly email: string;
  readonly sub: string;
  /** true quando a requisicao passou pelo atalho local, nunca em producao. */
  readonly dev: boolean;
};

export type AccessResult =
  | { readonly ok: true; readonly identity: AccessIdentity }
  | {
      readonly ok: false;
      readonly status: 401 | 403 | 503;
      readonly reason: string;
    };

/** Tolerancia de relogio entre o emissor e a borda. */
const CLOCK_SKEW_SECONDS = 60;

/** So RS256. O algoritmo e FIXO no codigo e nunca lido do token — aceitar o
 *  que o cabecalho pede e a raiz da familia de ataques de confusao de
 *  algoritmo, incluindo `alg: none` e HS256 assinado com a chave publica. */
const ALGORITHM = 'RS256';

interface Jwk {
  readonly kid: string;
  readonly kty: string;
  readonly n: string;
  readonly e: string;
}

interface JwtHeader {
  readonly alg?: unknown;
  readonly kid?: unknown;
}

interface JwtPayload {
  readonly aud?: unknown;
  readonly iss?: unknown;
  readonly email?: unknown;
  readonly sub?: unknown;
  readonly exp?: unknown;
  readonly nbf?: unknown;
}

// --- cache do JWKS ---------------------------------------------------------
// Buscar as chaves a cada requisicao acrescentaria uma ida a rede no caminho
// administrativo. O isolate do Worker vive entre requisicoes, entao um cache
// de modulo resolve.

const JWKS_TTL_MS = 60 * 60 * 1000;
let jwksCache: { url: string; keys: Jwk[]; fetchedAt: number } | null = null;

/** Somente para os testes: zera o cache entre casos. */
export function __clearJwksCache(): void {
  jwksCache = null;
}

async function loadJwks(teamDomain: string): Promise<Jwk[] | null> {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;

  if (
    jwksCache !== null &&
    jwksCache.url === url &&
    Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS
  ) {
    return jwksCache.keys;
  }

  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`[access] JWKS respondeu ${response.status}`);
      return null;
    }
    const body = (await response.json()) as { keys?: Jwk[] };
    if (!Array.isArray(body.keys) || body.keys.length === 0) {
      console.error('[access] JWKS sem chaves');
      return null;
    }
    jwksCache = { url, keys: body.keys, fetchedAt: Date.now() };
    return body.keys;
  } catch (error) {
    console.error('[access] falha ao buscar o JWKS:', error);
    return null;
  }
}

// --- utilidades ------------------------------------------------------------

function base64UrlToBytes(value: string): Uint8Array | null {
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const padding = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4));
    const binary = atob(base64 + padding);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

function decodeJsonSegment<T>(segment: string): T | null {
  const bytes = base64UrlToBytes(segment);
  if (bytes === null) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

/** O Access entrega o token no cabecalho; o cookie e o caminho do navegador. */
export function extractToken(request: Request): string | null {
  const header = request.headers.get('Cf-Access-Jwt-Assertion');
  if (header !== null && header.trim() !== '') return header.trim();

  const cookie = request.headers.get('Cookie');
  if (cookie === null) return null;
  const match = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
  return match?.[1] ?? null;
}

function emailAllowed(email: string, adminEmails: string | undefined): boolean {
  if (adminEmails === undefined || adminEmails.trim() === '') return true;
  const allowed = adminEmails
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '');
  return allowed.includes(email.toLowerCase());
}

// --- verificacao -----------------------------------------------------------

async function verifySignature(
  jwk: Jwk,
  signedPart: string,
  signature: Uint8Array,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: ALGORITHM, ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      signature as unknown as BufferSource,
      new TextEncoder().encode(signedPart) as unknown as BufferSource,
    );
  } catch (error) {
    console.error('[access] falha ao verificar a assinatura:', error);
    return false;
  }
}

/**
 * Valida um token do Access. Devolve a identidade ou o motivo da recusa.
 */
export async function verifyAccessJwt(
  token: string,
  config: AccessConfig,
): Promise<AccessResult> {
  const teamDomain = config.teamDomain;
  const aud = config.aud;
  if (teamDomain === undefined || aud === undefined) {
    return { ok: false, status: 503, reason: 'access_nao_configurado' };
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return { ok: false, status: 401, reason: 'token_malformado' };
  }
  const [headerSegment, payloadSegment, signatureSegment] = parts as [
    string,
    string,
    string,
  ];

  const header = decodeJsonSegment<JwtHeader>(headerSegment);
  if (header === null) {
    return { ok: false, status: 401, reason: 'cabecalho_ilegivel' };
  }

  // Recusa explicita antes de qualquer outra coisa: `none`, HS256 e afins
  // nunca chegam perto da verificacao.
  if (header.alg !== ALGORITHM) {
    return { ok: false, status: 401, reason: 'algoritmo_nao_suportado' };
  }
  if (typeof header.kid !== 'string' || header.kid === '') {
    return { ok: false, status: 401, reason: 'kid_ausente' };
  }

  const payload = decodeJsonSegment<JwtPayload>(payloadSegment);
  if (payload === null) {
    return { ok: false, status: 401, reason: 'payload_ilegivel' };
  }

  const keys = await loadJwks(teamDomain);
  if (keys === null) {
    return { ok: false, status: 503, reason: 'jwks_indisponivel' };
  }

  const jwk = keys.find((candidate) => candidate.kid === header.kid);
  if (jwk === undefined) {
    return { ok: false, status: 401, reason: 'kid_desconhecido' };
  }

  const signature = base64UrlToBytes(signatureSegment);
  if (signature === null) {
    return { ok: false, status: 401, reason: 'assinatura_ilegivel' };
  }

  const valid = await verifySignature(
    jwk,
    `${headerSegment}.${payloadSegment}`,
    signature,
  );
  if (!valid) {
    return { ok: false, status: 401, reason: 'assinatura_invalida' };
  }

  // A assinatura confere. So agora as afirmacoes do token valem alguma coisa.

  const now = Math.floor(Date.now() / 1000);

  if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_SECONDS < now) {
    return { ok: false, status: 401, reason: 'token_expirado' };
  }
  if (typeof payload.nbf === 'number' && payload.nbf - CLOCK_SKEW_SECONDS > now) {
    return { ok: false, status: 401, reason: 'token_ainda_nao_valido' };
  }

  // `iss` impede que um token de outro time da Cloudflare sirva aqui.
  if (payload.iss !== `https://${teamDomain}`) {
    return { ok: false, status: 401, reason: 'emissor_invalido' };
  }

  // `aud` impede que um token emitido para OUTRA aplicacao do seu proprio
  // time sirva para esta. No Access o campo e um array.
  const audiences = Array.isArray(payload.aud)
    ? payload.aud
    : typeof payload.aud === 'string'
      ? [payload.aud]
      : [];
  if (!audiences.includes(aud)) {
    return { ok: false, status: 401, reason: 'audiencia_invalida' };
  }

  const email = typeof payload.email === 'string' ? payload.email : '';
  if (email === '') {
    return { ok: false, status: 401, reason: 'email_ausente' };
  }
  if (!emailAllowed(email, config.adminEmails)) {
    return { ok: false, status: 403, reason: 'email_nao_autorizado' };
  }

  return {
    ok: true,
    identity: {
      email,
      sub: typeof payload.sub === 'string' ? payload.sub : '',
      dev: false,
    },
  };
}

/**
 * Porta de entrada das rotas administrativas.
 *
 * Ordem deliberada: Access configurado vence sempre. O atalho de
 * desenvolvimento so e considerado quando NAO ha Access — de modo que um
 * ambiente de producao, que tem Access, nao possa ser rebaixado por uma
 * variavel perdida.
 */
export async function requireAccess(
  request: Request,
  config: AccessConfig,
): Promise<AccessResult> {
  const configured =
    config.teamDomain !== undefined &&
    config.teamDomain !== '' &&
    config.aud !== undefined &&
    config.aud !== '';

  if (!configured) {
    if (config.devInsecure === 'true') {
      console.warn(
        '[access] ATALHO DE DESENVOLVIMENTO ATIVO — a API esta SEM autenticacao. ' +
          'Isto so deve acontecer em `wrangler dev`, via .dev.vars.',
      );
      return {
        ok: true,
        identity: { email: 'dev@local', sub: 'dev', dev: true },
      };
    }
    // Falha fechada. Nao ha caminho em que a ausencia de configuracao libere
    // a API.
    console.error(
      '[access] ACCESS_TEAM_DOMAIN / ACCESS_AUD ausentes: recusando a requisicao.',
    );
    return { ok: false, status: 503, reason: 'access_nao_configurado' };
  }

  const token = extractToken(request);
  if (token === null) {
    return { ok: false, status: 401, reason: 'token_ausente' };
  }

  return verifyAccessJwt(token, config);
}
