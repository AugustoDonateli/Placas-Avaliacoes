import { describe, expect, it, vi } from 'vitest';
import {
  handleRedirect,
  resolvePlate,
  type RedirectEnv,
} from '../src/redirect';

// ---------------------------------------------------------------------------
// D1 falso. O caminho quente faz exatamente uma consulta, entao o duble
// precisa suportar apenas prepare().bind().first().
// ---------------------------------------------------------------------------

interface Row {
  destination_url: string | null;
  status: string;
}

function fakeDb(rows: Readonly<Record<string, Row>>): D1Database {
  return {
    prepare() {
      return {
        bind(code: string) {
          return {
            first: async () => rows[code] ?? null,
          };
        },
      };
    },
  } as unknown as D1Database;
}

/** Banco que explode, para o ramo db_error. */
function brokenDb(): D1Database {
  return {
    prepare() {
      return {
        bind() {
          return {
            first: async () => {
              throw new Error('D1_ERROR: connection lost');
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

const REVIEW_URL = 'https://g.page/r/CfMgH0abcDEF/review';
const PLACE_URL =
  'https://search.google.com/local/writereview?placeid=ChIJN1t_tDeuEmsRUsoyG83frY4';

const DB = fakeDb({
  '001': { destination_url: REVIEW_URL, status: 'active' },
  '002': { destination_url: null, status: 'draft' },
  '003': { destination_url: 'https://maps.app.goo.gl/AbCdEf123456', status: 'inactive' },
  '004': { destination_url: 'https://g.page/r/Antigo/review', status: 'retired' },
  '005': {
    destination_url: 'https://www.google.com/url?q=https://site-externo.example',
    status: 'active',
  },
  '006': { destination_url: PLACE_URL, status: 'active' },
  '007': { destination_url: '', status: 'active' },
  '008': { destination_url: REVIEW_URL, status: 'vendida' },
});

const ENV: RedirectEnv = { DB };

function get(path: string, method = 'GET'): Request {
  return new Request(`https://exemplo.com${path}`, { method });
}

// ---------------------------------------------------------------------------
// A maquina de estados
// ---------------------------------------------------------------------------

describe('resolvePlate — máquina de estados', () => {
  it('001 ativa com destino válido → redirect', async () => {
    const r = await resolvePlate(DB, '/001');
    expect(r.outcome).toBe('redirect');
    if (r.outcome === 'redirect') expect(r.url).toBe(REVIEW_URL);
  });

  it('002 draft → not_configured', async () => {
    expect((await resolvePlate(DB, '/002')).outcome).toBe('not_configured');
  });

  it('003 inactive → paused', async () => {
    expect((await resolvePlate(DB, '/003')).outcome).toBe('paused');
  });

  it('004 retired → retired, MESMO tendo destino gravado', async () => {
    // Prova que a ordem da máquina de estados está certa: status antes de
    // destino. Uma placa aposentada nunca redireciona.
    expect((await resolvePlate(DB, '/004')).outcome).toBe('retired');
  });

  it('005 ativa com destino fora da allowlist → misconfigured', async () => {
    const r = await resolvePlate(DB, '/005');
    expect(r.outcome).toBe('misconfigured');
    if (r.outcome === 'misconfigured') expect(r.reason).toBe('path_not_allowed');
  });

  it('999 inexistente → not_found', async () => {
    expect((await resolvePlate(DB, '/999')).outcome).toBe('not_found');
  });

  it('007 ativa com destino vazio → not_configured', async () => {
    expect((await resolvePlate(DB, '/007')).outcome).toBe('not_configured');
  });

  it('008 com status desconhecido → misconfigured, nunca redirect', async () => {
    // Se algo escreveu um status por fora do CHECK da tabela, o seguro é
    // não redirecionar.
    expect((await resolvePlate(DB, '/008')).outcome).toBe('misconfigured');
  });

  it('banco fora do ar → db_error, e não not_found', async () => {
    // A diferença importa: "não existe" e "não consegui olhar" pedem
    // respostas diferentes ao cliente.
    expect((await resolvePlate(brokenDb(), '/001')).outcome).toBe('db_error');
  });

  it('código malformado → not_found sem tocar no banco', async () => {
    let consultou = false;
    const espiao = {
      prepare() {
        consultou = true;
        return { bind: () => ({ first: async () => null }) };
      },
    } as unknown as D1Database;

    expect((await resolvePlate(espiao, '/a-b-c')).outcome).toBe('not_found');
    expect(consultou, 'não deveria consultar o D1 com código inválido').toBe(false);
  });

  it('caminho reservado → not_found sem tocar no banco', async () => {
    let consultou = false;
    const espiao = {
      prepare() {
        consultou = true;
        return { bind: () => ({ first: async () => null }) };
      },
    } as unknown as D1Database;

    expect((await resolvePlate(espiao, '/admin')).outcome).toBe('not_found');
    expect(consultou).toBe(false);
  });

  it('normaliza o caminho antes de consultar', async () => {
    for (const caminho of ['/001', '001', '/001/', '  /001/  ']) {
      const r = await resolvePlate(DB, caminho);
      expect(r.outcome, `falhou para ${JSON.stringify(caminho)}`).toBe('redirect');
    }
  });
});

// ---------------------------------------------------------------------------
// A resposta HTTP
// ---------------------------------------------------------------------------

describe('handleRedirect — redirecionamento', () => {
  it('responde 302 — NUNCA 301', async () => {
    const res = await handleRedirect(get('/001'), '/001', ENV);
    expect(res.status).toBe(302);
    expect(res.status, 'um 301 aqui inutilizaria a placa para sempre').not.toBe(301);
  });

  it('não usa nenhum outro código de redirecionamento permanente', async () => {
    const res = await handleRedirect(get('/001'), '/001', ENV);
    expect([301, 308]).not.toContain(res.status);
  });

  it('manda Location para o destino exato', async () => {
    const res = await handleRedirect(get('/001'), '/001', ENV);
    expect(res.headers.get('location')).toBe(REVIEW_URL);
  });

  it('preserva maiúsculas e minúsculas do Place ID no Location', async () => {
    const res = await handleRedirect(get('/006'), '/006', ENV);
    expect(res.headers.get('location')).toContain('ChIJN1t_tDeuEmsRUsoyG83frY4');
  });

  it('manda Cache-Control: no-store', async () => {
    const res = await handleRedirect(get('/001'), '/001', ENV);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('não manda nenhum cabeçalho que autorize cache', async () => {
    const res = await handleRedirect(get('/001'), '/001', ENV);
    expect(res.headers.get('expires')).toBeNull();
    expect(res.headers.get('etag')).toBeNull();
    expect(res.headers.get('last-modified')).toBeNull();
  });

  it('marca noindex', async () => {
    const res = await handleRedirect(get('/001'), '/001', ENV);
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
  });

  it('responde sem corpo', async () => {
    const res = await handleRedirect(get('/001'), '/001', ENV);
    expect(await res.text()).toBe('');
  });
});

describe('handleRedirect — páginas de estado', () => {
  const casos = [
    ['/002', 200, 'not_configured', 'ainda não foi vinculada'],
    ['/003', 200, 'paused', 'pausada'],
    ['/004', 200, 'retired', 'não está mais em uso'],
    ['/005', 200, 'misconfigured', 'não é válido'],
    ['/999', 404, 'not_found', 'Não localizamos'],
  ] as const;

  for (const [path, status, estado, trecho] of casos) {
    it(`${path} → ${status} / ${estado}`, async () => {
      const res = await handleRedirect(get(path), path, ENV);
      expect(res.status).toBe(status);
      expect(res.headers.get('x-plate-state')).toBe(estado);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(await res.text()).toContain(trecho);
    });
  }

  it('nenhuma página de estado redireciona', async () => {
    for (const path of ['/002', '/003', '/004', '/005', '/999']) {
      const res = await handleRedirect(get(path), path, ENV);
      expect(res.headers.get('location'), `${path} não pode ter Location`).toBeNull();
    }
  });

  it('TODA resposta leva no-store, inclusive as páginas de erro', async () => {
    for (const path of ['/001', '/002', '/003', '/004', '/005', '/999']) {
      const res = await handleRedirect(get(path), path, ENV);
      expect(res.headers.get('cache-control'), path).toBe('no-store');
    }
  });

  it('banco fora do ar → 503, não 404', async () => {
    const res = await handleRedirect(get('/001'), '/001', { DB: brokenDb() });
    expect(res.status).toBe(503);
    expect(res.headers.get('x-plate-state')).toBe('db_error');
  });

  it('mostra o código para o cliente citar no suporte', async () => {
    const res = await handleRedirect(get('/002'), '/002', ENV);
    expect(await res.text()).toContain('002');
  });

  it('não vaza o destino inválido na página', async () => {
    // A pessoa que escaneou não precisa ver a URL quebrada, e mostrá-la
    // ajudaria quem estivesse sondando o sistema.
    const res = await handleRedirect(get('/005'), '/005', ENV);
    expect(await res.text()).not.toContain('site-externo.example');
  });
});

describe('handleRedirect — CTA de WhatsApp', () => {
  it('aparece quando o número está configurado', async () => {
    const res = await handleRedirect(get('/002'), '/002', {
      DB,
      WHATSAPP_NUMBER: '5511999998888',
    });
    expect(await res.text()).toContain('https://wa.me/5511999998888');
  });

  it('não aparece quando o número não está configurado', async () => {
    const res = await handleRedirect(get('/002'), '/002', ENV);
    expect(await res.text()).not.toContain('wa.me');
  });

  it('não aparece na página de placa pausada, que não é oportunidade de venda', async () => {
    const res = await handleRedirect(get('/003'), '/003', {
      DB,
      WHATSAPP_NUMBER: '5511999998888',
    });
    expect(await res.text()).not.toContain('wa.me');
  });

  it('limpa o número, para que lixo no ambiente não vire href arbitrário', async () => {
    const res = await handleRedirect(get('/002'), '/002', {
      DB,
      WHATSAPP_NUMBER: '+55 (11) 99999-8888',
    });
    expect(await res.text()).toContain('https://wa.me/5511999998888');
  });

  it('escapa o nome da marca', async () => {
    const res = await handleRedirect(get('/002'), '/002', {
      DB,
      BRAND_NAME: '<script>alert(1)</script>',
    });
    const html = await res.text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('handleRedirect — métodos HTTP', () => {
  it('HEAD funciona igual a GET, para as prévias de link do WhatsApp', async () => {
    const res = await handleRedirect(get('/001', 'HEAD'), '/001', ENV);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(REVIEW_URL);
  });

  for (const metodo of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    it(`${metodo} → 405 com Allow`, async () => {
      const res = await handleRedirect(get('/001', metodo), '/001', ENV);
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('GET, HEAD');
    });
  }

  it('405 não consulta o banco', async () => {
    let consultou = false;
    const espiao = {
      prepare() {
        consultou = true;
        return { bind: () => ({ first: async () => null }) };
      },
    } as unknown as D1Database;

    await handleRedirect(get('/001', 'POST'), '/001', { DB: espiao });
    expect(consultou).toBe(false);
  });
});

describe('o comportamento central do produto', () => {
  it('trocar o destino no banco muda para onde a MESMA placa aponta', async () => {
    // É o produto inteiro num teste: o código nunca muda, o destino sim.
    const antes = fakeDb({
      '001': { destination_url: 'https://g.page/r/Barbearia/review', status: 'active' },
    });
    const depois = fakeDb({
      '001': { destination_url: 'https://g.page/r/Restaurante/review', status: 'active' },
    });

    const r1 = await handleRedirect(get('/001'), '/001', { DB: antes });
    const r2 = await handleRedirect(get('/001'), '/001', { DB: depois });

    expect(r1.headers.get('location')).toBe('https://g.page/r/Barbearia/review');
    expect(r2.headers.get('location')).toBe('https://g.page/r/Restaurante/review');
    expect(r1.status).toBe(302);
    expect(r2.status).toBe(302);
  });

  it('uma placa nunca redireciona para fora do Google', async () => {
    const hostis = [
      'https://site-externo.example/phishing',
      'https://www.google.com/url?q=https://site-externo.example',
      'https://google.com.site-externo.example/maps',
      'https://bit.ly/abc',
    ];

    for (const destino of hostis) {
      const db = fakeDb({ '001': { destination_url: destino, status: 'active' } });
      const res = await handleRedirect(get('/001'), '/001', { DB: db });
      expect(res.status, `${destino} não pode redirecionar`).not.toBe(302);
      expect(res.headers.get('location')).toBeNull();
    }
  });
});

describe('ruído silenciado nos logs', () => {
  it('registra placa mal configurada para o operador ver', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await resolvePlate(DB, '/005');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
