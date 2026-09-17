/**
 * Emissor de JWT para os testes do Access.
 *
 * Gera um par de chaves RSA de verdade, assina tokens de verdade e serve um
 * JWKS de verdade. Os testes de seguranca so valem se o caminho feliz for
 * criptograficamente legitimo — caso contrario "recusou" nao prova nada,
 * porque tudo seria recusado.
 */

export const TEAM_DOMAIN = 'equipe-teste.cloudflareaccess.com';
export const AUD = 'aud-de-teste-0123456789abcdef';
export const KID = 'kid-de-teste';

export interface Signer {
  readonly jwks: { keys: unknown[] };
  sign(payload: Record<string, unknown>, options?: SignOptions): Promise<string>;
}

export interface SignOptions {
  /** Sobrescreve o cabecalho, para os testes de confusao de algoritmo. */
  readonly header?: Record<string, unknown>;
  /** Assina com uma chave que NAO esta no JWKS. */
  readonly wrongKey?: boolean;
}

function toBase64Url(input: Uint8Array | string): string {
  const bytes =
    typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function generateKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
}

export async function createSigner(): Promise<Signer> {
  const real = await generateKeyPair();
  const impostor = await generateKeyPair();

  const publicJwk = (await crypto.subtle.exportKey(
    'jwk',
    real.publicKey,
  )) as JsonWebKey;

  const jwks = {
    keys: [
      {
        kid: KID,
        kty: 'RSA',
        alg: 'RS256',
        use: 'sig',
        n: publicJwk.n,
        e: publicJwk.e,
      },
    ],
  };

  return {
    jwks,
    async sign(payload, options = {}) {
      const header = options.header ?? { alg: 'RS256', kid: KID, typ: 'JWT' };
      const signingKey = options.wrongKey ? impostor.privateKey : real.privateKey;

      const encodedHeader = toBase64Url(JSON.stringify(header));
      const encodedPayload = toBase64Url(JSON.stringify(payload));
      const signingInput = `${encodedHeader}.${encodedPayload}`;

      const signature = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        signingKey,
        new TextEncoder().encode(signingInput),
      );

      return `${signingInput}.${toBase64Url(new Uint8Array(signature))}`;
    },
  };
}

/** Payload de um token valido, com os campos que o Access emite. */
export function validPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    aud: [AUD],
    iss: `https://${TEAM_DOMAIN}`,
    email: 'augusto@exemplo.com',
    sub: 'sub-de-teste',
    iat: now,
    nbf: now - 10,
    exp: now + 3600,
    type: 'app',
    ...overrides,
  };
}

/** Faz o `fetch` global servir este JWKS, como o endpoint da Cloudflare. */
export function stubJwks(signer: Signer): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`) {
      return new Response(JSON.stringify(signer.jwks), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}
