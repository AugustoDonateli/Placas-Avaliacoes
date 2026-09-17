import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __clearJwksCache,
  extractToken,
  requireAccess,
  verifyAccessJwt,
  type AccessConfig,
} from '../src/access';
import {
  AUD,
  KID,
  TEAM_DOMAIN,
  createSigner,
  stubJwks,
  validPayload,
  type Signer,
} from './helpers/jwt';

let signer: Signer;
const realFetch = globalThis.fetch;

const CONFIG: AccessConfig = { teamDomain: TEAM_DOMAIN, aud: AUD };

beforeEach(async () => {
  signer = await createSigner();
  stubJwks(signer);
  __clearJwksCache();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function withToken(token: string): Request {
  return new Request('https://exemplo.com/api/plates', {
    headers: { 'Cf-Access-Jwt-Assertion': token },
  });
}

describe('caminho feliz', () => {
  it('aceita um token válido e devolve a identidade', async () => {
    const token = await signer.sign(validPayload());
    const result = await verifyAccessJwt(token, CONFIG);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.email).toBe('augusto@exemplo.com');
      expect(result.identity.dev).toBe(false);
    }
  });

  it('aceita o token vindo pelo cookie CF_Authorization', async () => {
    const token = await signer.sign(validPayload());
    const request = new Request('https://exemplo.com/api/plates', {
      headers: { Cookie: `outro=1; CF_Authorization=${token}; mais=2` },
    });
    expect(extractToken(request)).toBe(token);
    expect((await requireAccess(request, CONFIG)).ok).toBe(true);
  });
});

describe('assinatura', () => {
  it('recusa token assinado por outra chave', async () => {
    const token = await signer.sign(validPayload(), { wrongKey: true });
    const result = await verifyAccessJwt(token, CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.reason).toBe('assinatura_invalida');
    }
  });

  it('recusa payload adulterado depois da assinatura', async () => {
    const token = await signer.sign(validPayload());
    const [header, , signature] = token.split('.') as [string, string, string];

    const adulterado = btoa(JSON.stringify(validPayload({ email: 'invasor@exemplo.com' })))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const result = await verifyAccessJwt(
      `${header}.${adulterado}.${signature}`,
      CONFIG,
    );
    expect(result.ok).toBe(false);
  });

  it('recusa kid desconhecido', async () => {
    const token = await signer.sign(validPayload(), {
      header: { alg: 'RS256', kid: 'kid-que-nao-existe' },
    });
    const result = await verifyAccessJwt(token, CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('kid_desconhecido');
  });

  it('recusa token sem kid', async () => {
    const token = await signer.sign(validPayload(), { header: { alg: 'RS256' } });
    const result = await verifyAccessJwt(token, CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('kid_ausente');
  });
});

describe('confusão de algoritmo', () => {
  it('recusa alg: none', async () => {
    const header = btoa(JSON.stringify({ alg: 'none', kid: KID }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const payload = btoa(JSON.stringify(validPayload()))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const result = await verifyAccessJwt(`${header}.${payload}.`, CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('algoritmo_nao_suportado');
  });

  it('recusa HS256, mesmo com kid conhecido', async () => {
    // O ataque clássico: assinar HS256 usando a chave pública RSA como
    // segredo. Só passa se o verificador escolher o algoritmo pelo que o
    // token pede — e o nosso não escolhe, ele é fixo.
    const token = await signer.sign(validPayload(), {
      header: { alg: 'HS256', kid: KID },
    });
    const result = await verifyAccessJwt(token, CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('algoritmo_nao_suportado');
  });

  it('recusa RS512 e outros parentes', async () => {
    for (const alg of ['RS384', 'RS512', 'ES256', 'PS256']) {
      const token = await signer.sign(validPayload(), { header: { alg, kid: KID } });
      const result = await verifyAccessJwt(token, CONFIG);
      expect(result.ok, alg).toBe(false);
    }
  });
});

describe('afirmações do token', () => {
  it('recusa token expirado', async () => {
    const agora = Math.floor(Date.now() / 1000);
    const token = await signer.sign(validPayload({ exp: agora - 3600 }));
    const result = await verifyAccessJwt(token, CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('token_expirado');
  });

  it('recusa token sem exp', async () => {
    const payload = validPayload();
    delete payload.exp;
    const result = await verifyAccessJwt(await signer.sign(payload), CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('token_expirado');
  });

  it('recusa token ainda não válido', async () => {
    const agora = Math.floor(Date.now() / 1000);
    const token = await signer.sign(validPayload({ nbf: agora + 3600 }));
    const result = await verifyAccessJwt(token, CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('token_ainda_nao_valido');
  });

  it('recusa emissor de outro time', async () => {
    const token = await signer.sign(
      validPayload({ iss: 'https://outroteam.cloudflareaccess.com' }),
    );
    const result = await verifyAccessJwt(token, CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('emissor_invalido');
  });

  it('recusa token emitido para OUTRA aplicação do mesmo time', async () => {
    // Este é o motivo de conferir `aud`: um token legítimo, assinado pelo seu
    // próprio time, emitido para outra aplicação do Access — não pode servir
    // como credencial aqui.
    const token = await signer.sign(validPayload({ aud: ['outra-aplicacao'] }));
    const result = await verifyAccessJwt(token, CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('audiencia_invalida');
  });

  it('recusa aud vazio', async () => {
    const result = await verifyAccessJwt(await signer.sign(validPayload({ aud: [] })), CONFIG);
    expect(result.ok).toBe(false);
  });

  it('recusa token sem e-mail', async () => {
    const payload = validPayload();
    delete payload.email;
    const result = await verifyAccessJwt(await signer.sign(payload), CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('email_ausente');
  });
});

describe('lista de e-mails autorizados', () => {
  const comLista: AccessConfig = {
    ...CONFIG,
    adminEmails: 'augusto@exemplo.com, outro@exemplo.com',
  };

  it('aceita e-mail da lista', async () => {
    const result = await verifyAccessJwt(await signer.sign(validPayload()), comLista);
    expect(result.ok).toBe(true);
  });

  it('aceita ignorando maiúsculas', async () => {
    const token = await signer.sign(validPayload({ email: 'Augusto@Exemplo.COM' }));
    expect((await verifyAccessJwt(token, comLista)).ok).toBe(true);
  });

  it('recusa com 403 quem não está na lista, mesmo com token válido', async () => {
    const token = await signer.sign(validPayload({ email: 'estranho@exemplo.com' }));
    const result = await verifyAccessJwt(token, comLista);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.reason).toBe('email_nao_autorizado');
    }
  });

  it('sem lista configurada, qualquer token válido passa', async () => {
    const token = await signer.sign(validPayload({ email: 'qualquer@exemplo.com' }));
    expect((await verifyAccessJwt(token, CONFIG)).ok).toBe(true);
  });
});

describe('tokens malformados', () => {
  const lixo = [
    '',
    'nao-e-um-jwt',
    'a.b',
    'a.b.c.d',
    'a.b.c',
    '....',
    'Bearer algo',
  ];

  for (const token of lixo) {
    it(`recusa ${JSON.stringify(token)}`, async () => {
      expect((await verifyAccessJwt(token, CONFIG)).ok).toBe(false);
    });
  }
});

describe('requireAccess — falha fechada', () => {
  it('SEM configuração e SEM atalho de dev → 503, nunca liberado', async () => {
    const result = await requireAccess(withToken('qualquer'), {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(503);
  });

  it('com configuração pela metade → 503', async () => {
    for (const parcial of [{ teamDomain: TEAM_DOMAIN }, { aud: AUD }]) {
      const result = await requireAccess(withToken('qualquer'), parcial);
      expect(result.ok, JSON.stringify(parcial)).toBe(false);
    }
  });

  it('sem token → 401', async () => {
    const request = new Request('https://exemplo.com/api/plates');
    const result = await requireAccess(request, CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it('JWKS fora do ar → 503, e não liberado', async () => {
    globalThis.fetch = (async () => new Response('erro', { status: 500 })) as typeof fetch;
    __clearJwksCache();
    const token = await signer.sign(validPayload());
    const result = await verifyAccessJwt(token, CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(503);
  });
});

describe('atalho de desenvolvimento', () => {
  it('libera SOMENTE quando o Access não está configurado', async () => {
    const result = await requireAccess(
      new Request('https://exemplo.com/api/plates'),
      { devInsecure: 'true' },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.identity.dev).toBe(true);
  });

  it('é IGNORADO quando o Access está configurado', async () => {
    // A propriedade que protege produção: um deploy com Access configurado
    // não pode ser rebaixado por uma variável perdida.
    const result = await requireAccess(new Request('https://exemplo.com/api/plates'), {
      ...CONFIG,
      devInsecure: 'true',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it('não é ligado por valores parecidos com verdadeiro', async () => {
    for (const valor of ['1', 'yes', 'sim', 'TRUE', 'True', '']) {
      const result = await requireAccess(new Request('https://exemplo.com/api/plates'), {
        devInsecure: valor,
      });
      expect(result.ok, `"${valor}" não deveria ligar o atalho`).toBe(false);
    }
  });

  it('avisa em voz alta quando está ativo', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await requireAccess(new Request('https://exemplo.com/api/plates'), {
      devInsecure: 'true',
    });
    expect(spy).toHaveBeenCalled();
  });
});
