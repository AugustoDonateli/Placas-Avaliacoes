import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index';
import { __clearJwksCache } from '../src/access';
import { expandRange, MAX_BATCH_SIZE } from '../src/api';
import {
  AUD,
  TEAM_DOMAIN,
  createSigner,
  stubJwks,
  validPayload,
  type Signer,
} from './helpers/jwt';
import { createTestDb, type TestDb } from './helpers/d1';

const realFetch = globalThis.fetch;

let db: TestDb;
let signer: Signer;
let token: string;
let env: Env;

beforeEach(async () => {
  db = createTestDb();
  signer = await createSigner();
  stubJwks(signer);
  __clearJwksCache();
  token = await signer.sign(validPayload());
  env = { DB: db.d1, ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: AUD };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  db.close();
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/** Requisição autenticada. */
async function call(
  method: string,
  path: string,
  body?: unknown,
  overrides: Partial<Env> = {},
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: {
      'Cf-Access-Jwt-Assertion': token,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  return worker.fetch(new Request(`https://exemplo.com${path}`, init), {
    ...env,
    ...overrides,
  });
}

/** Requisição pública, sem token. */
async function open(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  return worker.fetch(new Request(`https://exemplo.com${path}`, init), env);
}

async function body<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

// ===========================================================================
// SEGURANÇA
// ===========================================================================

describe('a API está fechada sem autenticação', () => {
  const rotas: Array<[string, string, unknown]> = [
    ['GET', '/api/plates', undefined],
    ['GET', '/api/plates/001', undefined],
    ['POST', '/api/plates', { from: '001', to: '005' }],
    ['PATCH', '/api/plates/001', { establishment: 'Invasor' }],
  ];

  for (const [method, path, payload] of rotas) {
    it(`${method} ${path} sem token → 401`, async () => {
      const response = await open(method, path, payload);
      expect(response.status).toBe(401);
    });
  }

  it('nenhuma escrita acontece sem token', async () => {
    await open('POST', '/api/plates', { from: '001', to: '005' });
    expect(db.query('SELECT * FROM plates')).toHaveLength(0);
  });

  it('token inválido → 401', async () => {
    const response = await worker.fetch(
      new Request('https://exemplo.com/api/plates', {
        headers: { 'Cf-Access-Jwt-Assertion': 'token.falso.aqui' },
      }),
      env,
    );
    expect(response.status).toBe(401);
  });

  it('token de outra aplicação do Access → 401', async () => {
    const outro = await signer.sign(validPayload({ aud: ['outra-aplicacao'] }));
    const response = await worker.fetch(
      new Request('https://exemplo.com/api/plates', {
        headers: { 'Cf-Access-Jwt-Assertion': outro },
      }),
      env,
    );
    expect(response.status).toBe(401);
  });

  it('e-mail fora da lista → 403', async () => {
    const response = await call('GET', '/api/plates', undefined, {
      ADMIN_EMAILS: 'outra.pessoa@exemplo.com',
    });
    expect(response.status).toBe(403);
  });

  it('SEM configuração de Access a API recusa tudo — não abre', async () => {
    const response = await worker.fetch(
      new Request('https://exemplo.com/api/plates'),
      { DB: db.d1 },
    );
    expect(response.status).toBe(503);
  });

  it('o redirecionamento público continua funcionando sem token', async () => {
    db.exec(
      "INSERT INTO plates (code, destination_url, status) VALUES ('001', 'https://g.page/r/ABC/review', 'active')",
    );
    const response = await open('GET', '/001');
    expect(response.status).toBe(302);
  });

  it('a resposta de recusa não vaza detalhe interno', async () => {
    const payload = await body(await open('GET', '/api/plates'));
    expect(JSON.stringify(payload)).not.toContain('cloudflareaccess');
    expect(JSON.stringify(payload)).not.toContain(AUD);
  });
});

describe('usuário autorizado', () => {
  it('passa', async () => {
    const response = await call('GET', '/api/plates');
    expect(response.status).toBe(200);
  });

  it('respostas da API nunca são cacheáveis', async () => {
    const response = await call('GET', '/api/plates');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

// ===========================================================================
// CRIAÇÃO
// ===========================================================================

describe('POST /api/plates — criação em lote', () => {
  it('cria a faixa 001–020', async () => {
    const response = await call('POST', '/api/plates', { from: '001', to: '020' });
    expect(response.status).toBe(201);

    const payload = await body<{ created: string[]; created_count: number }>(response);
    expect(payload.created_count).toBe(20);
    expect(payload.created[0]).toBe('001');
    expect(payload.created[19]).toBe('020');
    expect(db.query('SELECT * FROM plates')).toHaveLength(20);
  });

  it('as placas nascem em estoque, sem destino', async () => {
    await call('POST', '/api/plates', { from: '001', to: '003' });
    const rows = db.query<{ status: string; destination_url: string | null }>(
      'SELECT status, destination_url FROM plates',
    );
    for (const row of rows) {
      expect(row.status).toBe('draft');
      expect(row.destination_url).toBeNull();
    }
  });

  it('preserva o preenchimento com zeros', async () => {
    await call('POST', '/api/plates', { from: '008', to: '012' });
    const codes = db
      .query<{ code: string }>('SELECT code FROM plates ORDER BY code')
      .map((row) => row.code);
    expect(codes).toEqual(['008', '009', '010', '011', '012']);
  });

  it('aceita lista explícita, para quando o formato do código mudar', async () => {
    const response = await call('POST', '/api/plates', { codes: ['a7k2', '9xmq'] });
    expect(response.status).toBe(201);
    expect(db.query('SELECT * FROM plates')).toHaveLength(2);
  });
});

describe('POST /api/plates — conflito', () => {
  beforeEach(async () => {
    await call('POST', '/api/plates', { from: '001', to: '005' });
  });

  it('faixa sobreposta → 409 e NADA é criado', async () => {
    const response = await call('POST', '/api/plates', { from: '003', to: '010' });
    expect(response.status).toBe(409);

    const payload = await body<{ conflicts: string[]; created: string[] }>(response);
    expect(payload.conflicts).toEqual(['003', '004', '005']);
    expect(payload.created).toEqual([]);

    // O ponto central: a faixa inteira foi recusada, então 006–010 NÃO foram
    // criadas. Um lote parcial silencioso é o que queremos evitar.
    expect(db.query('SELECT * FROM plates')).toHaveLength(5);
  });

  it('uma placa já vendida nunca é sobrescrita', async () => {
    await call('PATCH', '/api/plates/003', {
      establishment: 'Barbearia do João',
      destination_url: 'https://g.page/r/ABC/review',
      status: 'active',
    });

    await call('POST', '/api/plates', { from: '001', to: '010' });

    const [placa] = db.query<{ status: string; establishment: string }>(
      "SELECT status, establishment FROM plates WHERE code = '003'",
    );
    expect(placa?.status).toBe('active');
    expect(placa?.establishment).toBe('Barbearia do João');
  });

  it('com skip_existing cria apenas as que faltam', async () => {
    const response = await call('POST', '/api/plates', {
      from: '003',
      to: '008',
      skip_existing: true,
    });
    expect(response.status).toBe(201);

    const payload = await body<{ created: string[]; skipped: string[] }>(response);
    expect(payload.created).toEqual(['006', '007', '008']);
    expect(payload.skipped).toEqual(['003', '004', '005']);
    expect(db.query('SELECT * FROM plates')).toHaveLength(8);
  });
});

describe('POST /api/plates — entradas inválidas', () => {
  const casos: Array<[unknown, string]> = [
    [{ from: '020', to: '001' }, 'faixa invertida'],
    [{ from: '1', to: '020' }, 'preenchimento de zeros diferente'],
    [{ from: 'abc', to: 'xyz' }, 'faixa não numérica'],
    [{ from: '001' }, 'sem o "to"'],
    [{}, 'corpo vazio'],
    [{ codes: [] }, 'lista vazia'],
    [{ codes: ['ADMIN'] }, 'código reservado'],
    [{ codes: ['a-b'] }, 'código com caractere inválido'],
    [{ codes: ['001', '001'] }, 'código repetido na lista'],
  ];

  for (const [payload, porque] of casos) {
    it(`recusa ${porque}`, async () => {
      const response = await call('POST', '/api/plates', payload);
      expect(response.status).toBe(400);
      expect(db.query('SELECT * FROM plates')).toHaveLength(0);
    });
  }

  it(`recusa faixa acima de ${MAX_BATCH_SIZE}`, async () => {
    const response = await call('POST', '/api/plates', { from: '00001', to: '99999' });
    expect(response.status).toBe(400);
    expect(db.query('SELECT * FROM plates')).toHaveLength(0);
  });

  it('recusa JSON malformado', async () => {
    const response = await worker.fetch(
      new Request('https://exemplo.com/api/plates', {
        method: 'POST',
        headers: {
          'Cf-Access-Jwt-Assertion': token,
          'content-type': 'application/json',
        },
        body: '{isso nao e json',
      }),
      env,
    );
    expect(response.status).toBe(400);
  });
});

describe('expandRange', () => {
  it('expande preservando largura', () => {
    const result = expandRange('008', '011');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.codes).toEqual(['008', '009', '010', '011']);
  });

  it('aceita faixa de um item só', () => {
    const result = expandRange('027', '027');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.codes).toEqual(['027']);
  });
});

// ===========================================================================
// LEITURA
// ===========================================================================

describe('GET /api/plates', () => {
  beforeEach(async () => {
    await call('POST', '/api/plates', { from: '001', to: '006' });
    await call('PATCH', '/api/plates/002', {
      destination_url: 'https://g.page/r/ABC/review',
      status: 'active',
    });
  });

  it('lista todas', async () => {
    const payload = await body<{ count: number }>(await call('GET', '/api/plates'));
    expect(payload.count).toBe(6);
  });

  it('filtra por status — é como você acha a próxima placa livre', async () => {
    const payload = await body<{ plates: Array<{ code: string }> }>(
      await call('GET', '/api/plates?status=draft'),
    );
    expect(payload.plates).toHaveLength(5);
    expect(payload.plates.map((p) => p.code)).not.toContain('002');
  });

  it('respeita o limite', async () => {
    const payload = await body<{ count: number }>(
      await call('GET', '/api/plates?limit=2'),
    );
    expect(payload.count).toBe(2);
  });

  it('recusa status e limite inválidos', async () => {
    expect((await call('GET', '/api/plates?status=vendida')).status).toBe(400);
    expect((await call('GET', '/api/plates?limit=0')).status).toBe(400);
    expect((await call('GET', '/api/plates?limit=abc')).status).toBe(400);
  });
});

describe('GET /api/plates/:code', () => {
  beforeEach(async () => {
    await call('POST', '/api/plates', { from: '001', to: '005' });
  });

  it('devolve a placa', async () => {
    const payload = await body<{ plate: { code: string; status: string } }>(
      await call('GET', '/api/plates/004'),
    );
    expect(payload.plate.code).toBe('004');
    expect(payload.plate.status).toBe('draft');
  });

  it('placa inexistente → 404', async () => {
    expect((await call('GET', '/api/plates/999')).status).toBe(404);
  });

  it('código malformado → 404', async () => {
    expect((await call('GET', '/api/plates/a-b-c')).status).toBe(404);
  });
});

// ===========================================================================
// ALTERAÇÃO
// ===========================================================================

describe('PATCH /api/plates/:code', () => {
  beforeEach(async () => {
    await call('POST', '/api/plates', { from: '001', to: '030' });
  });

  it('configura e ativa numa requisição só — o fluxo da venda', async () => {
    const response = await call('PATCH', '/api/plates/027', {
      establishment: 'Barbearia do João',
      destination_url: 'https://g.page/r/CfMgH0abcDEF/review',
      status: 'active',
    });
    expect(response.status).toBe(200);

    const payload = await body<{
      plate: { establishment: string; status: string; destination_url: string };
      destination_kind: string;
    }>(response);
    expect(payload.plate.establishment).toBe('Barbearia do João');
    expect(payload.plate.status).toBe('active');
    expect(payload.destination_kind).toBe('review_form');
  });

  it('avisa quando o link abre a ficha em vez do formulário', async () => {
    const payload = await body<{ destination_kind: string }>(
      await call('PATCH', '/api/plates/027', {
        destination_url: 'https://maps.app.goo.gl/AbCdEf123456',
        status: 'active',
      }),
    );
    expect(payload.destination_kind).toBe('listing');
  });

  it('aceita alteração parcial', async () => {
    await call('PATCH', '/api/plates/027', { establishment: 'Só o nome' });
    const [row] = db.query<{ establishment: string; status: string }>(
      "SELECT establishment, status FROM plates WHERE code = '027'",
    );
    expect(row?.establishment).toBe('Só o nome');
    expect(row?.status).toBe('draft');
  });

  it('grava o destino NORMALIZADO, não o que foi colado', async () => {
    await call('PATCH', '/api/plates/027', {
      destination_url: '  https://WWW.Google.COM:443/maps/place/X  ',
      status: 'active',
    });
    const [row] = db.query<{ destination_url: string }>(
      "SELECT destination_url FROM plates WHERE code = '027'",
    );
    expect(row?.destination_url).toBe('https://www.google.com/maps/place/X');
  });

  it('placa inexistente → 404', async () => {
    expect((await call('PATCH', '/api/plates/999', { notes: 'x' })).status).toBe(404);
  });

  it('corpo sem nenhum campo → 400', async () => {
    expect((await call('PATCH', '/api/plates/027', {})).status).toBe(400);
  });
});

describe('PATCH — o código é imutável', () => {
  beforeEach(async () => {
    await call('POST', '/api/plates', { from: '001', to: '005' });
  });

  it('tentar alterar o code → 400 explícito, não é ignorado em silêncio', async () => {
    const response = await call('PATCH', '/api/plates/003', { code: '009' });
    expect(response.status).toBe(400);

    const payload = await body<{ error: string; field: string }>(response);
    expect(payload.error).toBe('immutable_field');
    expect(payload.field).toBe('code');
  });

  it('o code não muda nem quando vem junto de campos válidos', async () => {
    await call('PATCH', '/api/plates/003', {
      code: '009',
      establishment: 'Tentativa',
    });

    expect(db.query("SELECT * FROM plates WHERE code = '003'")).toHaveLength(1);
    expect(db.query("SELECT * FROM plates WHERE code = '009'")).toHaveLength(0);
    // A requisição inteira é recusada: nada é aplicado pela metade.
    const [row] = db.query<{ establishment: string | null }>(
      "SELECT establishment FROM plates WHERE code = '003'",
    );
    expect(row?.establishment).toBeNull();
  });
});

describe('PATCH — validação do destino', () => {
  beforeEach(async () => {
    await call('POST', '/api/plates', { from: '001', to: '005' });
  });

  const invalidos: Array<[string, string]> = [
    ['https://www.google.com/url?q=https://site-externo.example', 'open redirect do Google'],
    ['https://site-externo.example/qualquer', 'host de fora'],
    ['javascript:alert(1)', 'esquema javascript'],
    ['http://g.page/r/ABC/review', 'sem TLS'],
    ['https://bit.ly/abc', 'encurtador de terceiro'],
    ['isso não é uma url', 'texto solto'],
  ];

  for (const [url, porque] of invalidos) {
    it(`recusa ${porque}`, async () => {
      const response = await call('PATCH', '/api/plates/003', { destination_url: url });
      expect(response.status).toBe(400);

      const payload = await body<{ field: string; message: string }>(response);
      expect(payload.field).toBe('destination_url');
      expect(payload.message.length).toBeGreaterThan(10);

      const [row] = db.query<{ destination_url: string | null }>(
        "SELECT destination_url FROM plates WHERE code = '003'",
      );
      expect(row?.destination_url).toBeNull();
    });
  }

  it('recusa status inválido', async () => {
    const response = await call('PATCH', '/api/plates/003', { status: 'vendida' });
    expect(response.status).toBe(400);
  });

  it('não deixa ativar placa sem destino', async () => {
    // Senão você entrega ao cliente uma placa que mostra "ainda não
    // configurada" — e descobre na frente dele, com a placa já paga.
    const response = await call('PATCH', '/api/plates/003', { status: 'active' });
    expect(response.status).toBe(400);

    const payload = await body<{ field: string }>(response);
    expect(payload.field).toBe('destination_url');
  });

  it('deixa ativar quando o destino vem na mesma requisição', async () => {
    const response = await call('PATCH', '/api/plates/003', {
      destination_url: 'https://g.page/r/ABC/review',
      status: 'active',
    });
    expect(response.status).toBe(200);
  });

  it('não deixa limpar o destino de uma placa ativa', async () => {
    await call('PATCH', '/api/plates/003', {
      destination_url: 'https://g.page/r/ABC/review',
      status: 'active',
    });
    const response = await call('PATCH', '/api/plates/003', { destination_url: null });
    expect(response.status).toBe(400);
  });
});

describe('PATCH — reativar placa aposentada exige confirmação', () => {
  beforeEach(async () => {
    await call('POST', '/api/plates', { from: '001', to: '005' });
    await call('PATCH', '/api/plates/003', { status: 'retired' });
  });

  it('sem confirmação → 409', async () => {
    const response = await call('PATCH', '/api/plates/003', {
      destination_url: 'https://g.page/r/Novo/review',
      status: 'active',
    });
    expect(response.status).toBe(409);

    const [row] = db.query<{ status: string }>(
      "SELECT status FROM plates WHERE code = '003'",
    );
    expect(row?.status).toBe('retired');
  });

  it('com confirm_reactivate → permitido', async () => {
    const response = await call('PATCH', '/api/plates/003', {
      destination_url: 'https://g.page/r/Novo/review',
      status: 'active',
      confirm_reactivate: true,
    });
    expect(response.status).toBe(200);
  });
});

describe('updated_at', () => {
  it('é atualizado automaticamente pelo trigger do banco', async () => {
    await call('POST', '/api/plates', { from: '001', to: '003' });

    // Envelhece a linha para que a diferença apareça, já que o timestamp tem
    // resolução de segundos.
    db.exec(
      "UPDATE plates SET created_at = '2020-01-01 00:00:00', updated_at = '2020-01-01 00:00:00' WHERE code = '002'",
    );

    await call('PATCH', '/api/plates/002', { establishment: 'Barbearia' });

    const [row] = db.query<{ created_at: string; updated_at: string }>(
      "SELECT created_at, updated_at FROM plates WHERE code = '002'",
    );
    expect(row?.updated_at).not.toBe('2020-01-01 00:00:00');
    expect(row?.created_at).toBe('2020-01-01 00:00:00');
  });
});

// ===========================================================================
// O FLUXO COMPLETO
// ===========================================================================

describe('o roteiro da venda, de ponta a ponta', () => {
  it('criar 001–020 → consultar 004 → configurar → redirecionar → desativar', async () => {
    // 1. Criar o estoque
    expect((await call('POST', '/api/plates', { from: '001', to: '020' })).status).toBe(
      201,
    );

    // 2. Consultar a 004: está livre
    const antes = await body<{ plate: { status: string; destination_url: null } }>(
      await call('GET', '/api/plates/004'),
    );
    expect(antes.plate.status).toBe('draft');
    expect(antes.plate.destination_url).toBeNull();

    // 2b. Antes de configurar, /004 não redireciona
    const naoConfigurada = await open('GET', '/004');
    expect(naoConfigurada.status).toBe(200);
    expect(naoConfigurada.headers.get('x-plate-state')).toBe('not_configured');

    // 3. Configurar, como no balcão do estabelecimento
    expect(
      (
        await call('PATCH', '/api/plates/004', {
          establishment: 'Barbearia do João',
          destination_url: 'https://g.page/r/CfMgH0abcDEF/review',
          status: 'active',
        })
      ).status,
    ).toBe(200);

    // 4. Consultar de novo
    const depois = await body<{ plate: { status: string; establishment: string } }>(
      await call('GET', '/api/plates/004'),
    );
    expect(depois.plate.status).toBe('active');
    expect(depois.plate.establishment).toBe('Barbearia do João');

    // 5. /004 redireciona IMEDIATAMENTE — sem deploy, sem QR novo
    const ativa = await open('GET', '/004');
    expect(ativa.status).toBe(302);
    expect(ativa.headers.get('location')).toBe('https://g.page/r/CfMgH0abcDEF/review');
    expect(ativa.headers.get('cache-control')).toBe('no-store');

    // 6. Desativar
    expect((await call('PATCH', '/api/plates/004', { status: 'inactive' })).status).toBe(
      200,
    );

    // 7. /004 para de redirecionar, também na hora
    const pausada = await open('GET', '/004');
    expect(pausada.status).toBe(200);
    expect(pausada.headers.get('location')).toBeNull();
    expect(pausada.headers.get('x-plate-state')).toBe('paused');
  });

  it('trocar o estabelecimento muda o destino sem tocar no código', async () => {
    await call('POST', '/api/plates', { from: '001', to: '005' });

    await call('PATCH', '/api/plates/001', {
      establishment: 'Barbearia do João',
      destination_url: 'https://g.page/r/Barbearia/review',
      status: 'active',
    });
    const primeiro = await open('GET', '/001');
    expect(primeiro.headers.get('location')).toBe('https://g.page/r/Barbearia/review');

    await call('PATCH', '/api/plates/001', {
      establishment: 'Restaurante do João',
      destination_url: 'https://g.page/r/Restaurante/review',
    });
    const segundo = await open('GET', '/001');
    expect(segundo.headers.get('location')).toBe('https://g.page/r/Restaurante/review');

    // O código impresso no QR e gravado no NFC não mudou.
    expect(db.query("SELECT * FROM plates WHERE code = '001'")).toHaveLength(1);
  });
});

describe('roteamento', () => {
  it('métodos não suportados → 405', async () => {
    expect((await call('DELETE', '/api/plates/001')).status).toBe(405);
    expect((await call('PUT', '/api/plates')).status).toBe(405);
  });

  it('rota desconhecida sob /api → 404, nunca cai no redirecionamento', async () => {
    const response = await call('GET', '/api/outra-coisa');
    expect(response.status).toBe(404);
    expect(response.headers.get('x-plate-state')).toBeNull();
  });

  it('caminho fundo demais → 404', async () => {
    expect((await call('GET', '/api/plates/001/extra')).status).toBe(404);
  });

  it('/api nunca é tratado como código de placa', async () => {
    db.exec("INSERT INTO plates (code, status) VALUES ('api', 'draft')");
    const response = await open('GET', '/api');
    expect(response.status).toBe(401);
    expect(response.headers.get('x-plate-state')).toBeNull();
  });
});
