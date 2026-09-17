/**
 * API administrativa das placas.
 *
 * Fica ATRAS do Cloudflare Access e da verificacao de JWT em access.ts.
 * Nenhuma rota daqui e alcancavel sem identidade valida.
 *
 * Este modulo NAO e importado por redirect.ts. A dependencia so existe no
 * sentido contrario (api.ts reusa codes.ts e urls.ts), preservando a regra de
 * que o caminho publico continua funcionando se o administrativo quebrar.
 *
 * PENSANDO NO PAINEL QUE VEM DEPOIS
 * ---------------------------------
 * O uso real e: em pe dentro de um estabelecimento, celular na mao, placa
 * fisica na outra, Wi-Fi ruim, cliente esperando. Isso guiou tres escolhas:
 *
 *   1. PATCH aceita campos parciais e faz tudo numa requisicao: estabelecimento,
 *      link e ativacao vao juntos. Uma ida a rede, nao tres.
 *   2. Toda resposta devolve a placa inteira, para a tela nao precisar de um
 *      GET de confirmacao depois do save.
 *   3. As respostas de erro trazem `message` ja em portugues e pronta para
 *      aparecer na tela, com `field` quando o erro e de um campo.
 */

import { parseCode } from './codes';
import { describeRejection, parseDestination } from './urls';

export interface ApiEnv {
  readonly DB: D1Database;
}

/** Faixas maiores que isto quase sempre sao erro de digitacao — e manter o
 *  lote abaixo do limite de variaveis do SQLite evita surpresa. */
export const MAX_BATCH_SIZE = 500;

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;

const VALID_STATUSES = ['draft', 'active', 'inactive', 'retired'] as const;
type PlateStatus = (typeof VALID_STATUSES)[number];

function isValidStatus(value: unknown): value is PlateStatus {
  return (
    typeof value === 'string' && (VALID_STATUSES as readonly string[]).includes(value)
  );
}

interface PlateRecord {
  code: string;
  destination_url: string | null;
  status: string;
  establishment: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const PLATE_COLUMNS =
  'code, destination_url, status, establishment, notes, created_at, updated_at';

// --- respostas -------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // A API administrativa nunca deve ser cacheada em lugar nenhum.
      'cache-control': 'no-store',
    },
  });
}

function fail(
  status: number,
  error: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return json({ error, message, ...extra }, status);
}

// --- leitura ---------------------------------------------------------------

async function listPlates(db: D1Database, url: URL): Promise<Response> {
  const statusFilter = url.searchParams.get('status');
  if (statusFilter !== null && !isValidStatus(statusFilter)) {
    return fail(
      400,
      'validation_error',
      `Status inválido. Use um de: ${VALID_STATUSES.join(', ')}.`,
      { field: 'status' },
    );
  }

  const rawLimit = url.searchParams.get('limit');
  let limit = DEFAULT_LIST_LIMIT;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIST_LIMIT) {
      return fail(
        400,
        'validation_error',
        `O limite deve ser um número inteiro entre 1 e ${MAX_LIST_LIMIT}.`,
        { field: 'limit' },
      );
    }
    limit = parsed;
  }

  const statement =
    statusFilter === null
      ? db
          .prepare(`SELECT ${PLATE_COLUMNS} FROM plates ORDER BY code LIMIT ?1`)
          .bind(limit)
      : db
          .prepare(
            `SELECT ${PLATE_COLUMNS} FROM plates WHERE status = ?1 ORDER BY code LIMIT ?2`,
          )
          .bind(statusFilter, limit);

  const { results } = await statement.all<PlateRecord>();
  return json({ plates: results ?? [], count: results?.length ?? 0 });
}

async function readPlate(db: D1Database, rawCode: string): Promise<Response> {
  const parsed = parseCode(rawCode);
  if (!parsed.ok) {
    return fail(404, 'not_found', 'Placa não encontrada.');
  }

  const plate = await db
    .prepare(`SELECT ${PLATE_COLUMNS} FROM plates WHERE code = ?1`)
    .bind(parsed.code)
    .first<PlateRecord>();

  if (plate === null) {
    return fail(404, 'not_found', `A placa ${parsed.code} não existe.`);
  }
  return json({ plate });
}

// --- criacao em lote -------------------------------------------------------

type RangeResult =
  | { ok: true; codes: string[] }
  | { ok: false; message: string; field?: string };

/**
 * Expande `{from:"001", to:"020"}`.
 *
 * Exige o mesmo numero de digitos nas duas pontas: `1`..`020` seria ambiguo
 * quanto ao preenchimento com zeros, e o preenchimento e o que define o
 * codigo impresso na placa. Ambiguidade aqui vira placa com o codigo errado.
 */
export function expandRange(from: string, to: string): RangeResult {
  if (!/^\d+$/.test(from) || !/^\d+$/.test(to)) {
    return {
      ok: false,
      message: 'Uma faixa só funciona com códigos numéricos. Use "codes" para códigos com letras.',
    };
  }
  if (from.length !== to.length) {
    return {
      ok: false,
      message: `"${from}" e "${to}" têm quantidades diferentes de dígitos. Use o mesmo preenchimento nas duas pontas, como 001 e 020.`,
    };
  }

  const start = Number(from);
  const end = Number(to);
  if (start > end) {
    return { ok: false, message: `A faixa começa em ${from} e termina em ${to}.` };
  }

  const size = end - start + 1;
  if (size > MAX_BATCH_SIZE) {
    return {
      ok: false,
      message: `A faixa tem ${size} placas e o máximo por vez é ${MAX_BATCH_SIZE}.`,
    };
  }

  const width = from.length;
  const codes: string[] = [];
  for (let value = start; value <= end; value += 1) {
    codes.push(String(value).padStart(width, '0'));
  }
  return { ok: true, codes };
}

interface CreateBody {
  from?: unknown;
  to?: unknown;
  codes?: unknown;
  skip_existing?: unknown;
}

async function createPlates(db: D1Database, body: CreateBody): Promise<Response> {
  let codes: string[];

  if (Array.isArray(body.codes)) {
    if (body.codes.length === 0) {
      return fail(400, 'validation_error', 'A lista "codes" está vazia.', {
        field: 'codes',
      });
    }
    if (body.codes.length > MAX_BATCH_SIZE) {
      return fail(
        400,
        'validation_error',
        `São ${body.codes.length} códigos e o máximo por vez é ${MAX_BATCH_SIZE}.`,
        { field: 'codes' },
      );
    }
    codes = body.codes.map((entry) => String(entry));
  } else if (typeof body.from === 'string' && typeof body.to === 'string') {
    const range = expandRange(body.from, body.to);
    if (!range.ok) {
      return fail(400, 'validation_error', range.message, { field: 'from' });
    }
    codes = range.codes;
  } else {
    return fail(
      400,
      'validation_error',
      'Informe uma faixa {"from":"001","to":"020"} ou uma lista {"codes":["001","002"]}.',
    );
  }

  // Todo codigo passa pela MESMA validacao do caminho publico. Um codigo que
  // a API aceitasse e o redirecionamento recusasse viraria uma placa impressa
  // que nunca funciona.
  const invalid: Array<{ code: string; reason: string }> = [];
  const normalized: string[] = [];
  for (const raw of codes) {
    const parsed = parseCode(raw);
    if (parsed.ok) {
      normalized.push(parsed.code);
    } else {
      invalid.push({ code: raw, reason: parsed.reason });
    }
  }
  if (invalid.length > 0) {
    return fail(400, 'validation_error', 'Há códigos inválidos na lista.', {
      invalid,
    });
  }

  const unique = [...new Set(normalized)];
  if (unique.length !== normalized.length) {
    return fail(400, 'validation_error', 'Há códigos repetidos na lista.');
  }

  // Descobre conflitos ANTES de escrever qualquer coisa.
  const placeholders = unique.map((_, index) => `?${index + 1}`).join(', ');
  const { results: existingRows } = await db
    .prepare(`SELECT code FROM plates WHERE code IN (${placeholders})`)
    .bind(...unique)
    .all<{ code: string }>();
  const existing = new Set((existingRows ?? []).map((row) => row.code));

  const skipExisting = body.skip_existing === true;

  if (existing.size > 0 && !skipExisting) {
    // Nada e escrito. Uma placa ja vendida nao pode ser silenciosamente
    // zerada de volta para estoque por causa de uma faixa digitada errada.
    return fail(
      409,
      'conflict',
      `${existing.size} de ${unique.length} códigos já existem. Nenhuma placa foi criada. Ajuste a faixa ou envie "skip_existing": true para criar apenas as que faltam.`,
      { conflicts: [...existing].sort(), created: [], created_count: 0 },
    );
  }

  const toCreate = unique.filter((code) => !existing.has(code));

  if (toCreate.length > 0) {
    await db.batch(
      toCreate.map((code) =>
        db.prepare("INSERT INTO plates (code, status) VALUES (?1, 'draft')").bind(code),
      ),
    );
  }

  return json(
    {
      created: toCreate,
      created_count: toCreate.length,
      skipped: [...existing].sort(),
      skipped_count: existing.size,
    },
    201,
  );
}

// --- alteracao -------------------------------------------------------------

interface PatchBody {
  code?: unknown;
  destination_url?: unknown;
  establishment?: unknown;
  status?: unknown;
  notes?: unknown;
  confirm_reactivate?: unknown;
}

async function patchPlate(
  db: D1Database,
  rawCode: string,
  body: PatchBody,
): Promise<Response> {
  const parsedCode = parseCode(rawCode);
  if (!parsedCode.ok) {
    return fail(404, 'not_found', 'Placa não encontrada.');
  }

  // O codigo esta impresso no QR e gravado na tag NFC. Alterar o code de uma
  // placa existente significaria que o objeto fisico no balcao do cliente
  // deixou de corresponder ao banco — e nao ha como consertar sem reimprimir.
  // Por isso isto e um erro explicito, e nao um campo silenciosamente ignorado.
  if (body.code !== undefined) {
    return fail(
      400,
      'immutable_field',
      'O código da placa não pode ser alterado: ele está impresso no QR e gravado na tag NFC. Para um código diferente, crie outra placa.',
      { field: 'code' },
    );
  }

  const current = await db
    .prepare(`SELECT ${PLATE_COLUMNS} FROM plates WHERE code = ?1`)
    .bind(parsedCode.code)
    .first<PlateRecord>();

  if (current === null) {
    return fail(404, 'not_found', `A placa ${parsedCode.code} não existe.`);
  }

  const updates: string[] = [];
  const values: Array<string | null> = [];

  // --- destino ---
  let nextDestination = current.destination_url;
  if (body.destination_url !== undefined) {
    if (body.destination_url === null || body.destination_url === '') {
      nextDestination = null;
      updates.push(`destination_url = ?${values.length + 1}`);
      values.push(null);
    } else if (typeof body.destination_url !== 'string') {
      return fail(400, 'validation_error', 'O link precisa ser um texto.', {
        field: 'destination_url',
      });
    } else {
      const destination = parseDestination(body.destination_url);
      if (!destination.ok) {
        return fail(400, 'validation_error', describeRejection(destination.reason), {
          field: 'destination_url',
          reason: destination.reason,
        });
      }
      // Grava a forma NORMALIZADA, nao o que foi colado.
      nextDestination = destination.url;
      updates.push(`destination_url = ?${values.length + 1}`);
      values.push(destination.url);
    }
  }

  // --- estabelecimento ---
  if (body.establishment !== undefined) {
    if (body.establishment !== null && typeof body.establishment !== 'string') {
      return fail(400, 'validation_error', 'O estabelecimento precisa ser um texto.', {
        field: 'establishment',
      });
    }
    const value =
      typeof body.establishment === 'string' ? body.establishment.trim() : null;
    updates.push(`establishment = ?${values.length + 1}`);
    values.push(value === '' ? null : value);
  }

  // --- observacoes ---
  if (body.notes !== undefined) {
    if (body.notes !== null && typeof body.notes !== 'string') {
      return fail(400, 'validation_error', 'A observação precisa ser um texto.', {
        field: 'notes',
      });
    }
    const value = typeof body.notes === 'string' ? body.notes.trim() : null;
    updates.push(`notes = ?${values.length + 1}`);
    values.push(value === '' ? null : value);
  }

  // --- status ---
  let nextStatus = current.status;
  if (body.status !== undefined) {
    if (!isValidStatus(body.status)) {
      return fail(
        400,
        'validation_error',
        `Status inválido. Use um de: ${VALID_STATUSES.join(', ')}.`,
        { field: 'status' },
      );
    }

    // Sair de `retired` exige confirmacao explicita. Uma placa aposentada
    // costuma ser uma placa fisica perdida ou descartada; reativar o codigo
    // para outro estabelecimento faria a placa perdida apontar clientes para
    // o lugar errado. Reativar por engano nao pode ser um clique so.
    if (current.status === 'retired' && body.status !== 'retired') {
      if (body.confirm_reactivate !== true) {
        return fail(
          409,
          'reactivation_requires_confirmation',
          'Esta placa está aposentada. Se a placa física ainda existir em algum lugar, reativar o código faria ela apontar para o estabelecimento errado. Envie "confirm_reactivate": true para prosseguir.',
          { field: 'status' },
        );
      }
    }

    nextStatus = body.status;
    updates.push(`status = ?${values.length + 1}`);
    values.push(body.status);
  }

  if (updates.length === 0) {
    return fail(400, 'validation_error', 'Nenhum campo para alterar foi enviado.');
  }

  // Ativar sem destino entregaria ao cliente uma placa que mostra "ainda nao
  // configurada" — o pior momento possivel para descobrir o erro e na frente
  // dele, com a placa ja paga.
  if (
    nextStatus === 'active' &&
    (nextDestination === null || nextDestination.trim() === '')
  ) {
    return fail(
      400,
      'validation_error',
      'Não dá para ativar uma placa sem link de destino. Informe o link do Google junto com a ativação.',
      { field: 'destination_url' },
    );
  }

  // `updated_at` nao aparece aqui: o trigger plates_set_updated_at cuida
  // disso no banco, entao nenhuma escrita — nem por esta API, nem manual via
  // `wrangler d1 execute` — pode esquecer de atualizar.
  await db
    .prepare(
      `UPDATE plates SET ${updates.join(', ')} WHERE code = ?${values.length + 1}`,
    )
    .bind(...values, parsedCode.code)
    .run();

  const plate = await db
    .prepare(`SELECT ${PLATE_COLUMNS} FROM plates WHERE code = ?1`)
    .bind(parsedCode.code)
    .first<PlateRecord>();

  // `destination_kind` diz se o link abre o formulario de avaliacao ou apenas
  // a ficha. O painel vai usar isso para avisar, sem bloquear.
  const kind =
    plate?.destination_url != null
      ? (() => {
          const parsed = parseDestination(plate.destination_url as string);
          return parsed.ok ? parsed.kind : null;
        })()
      : null;

  return json({ plate, destination_kind: kind });
}

// --- roteamento ------------------------------------------------------------

/**
 * `pathname` chega completo, por exemplo `/api/plates/004`.
 * A autenticacao ja aconteceu antes de chamar isto.
 */
export async function handleApi(
  request: Request,
  url: URL,
  env: ApiEnv,
): Promise<Response> {
  const segments = url.pathname.split('/').filter((part) => part !== '');
  // ['api', 'plates', ...]
  if (segments[1] !== 'plates') {
    return fail(404, 'not_found', 'Rota não encontrada.');
  }

  const code = segments[2];
  const extra = segments.length > 3;
  if (extra) {
    return fail(404, 'not_found', 'Rota não encontrada.');
  }

  if (code === undefined) {
    if (request.method === 'GET') {
      return listPlates(env.DB, url);
    }
    if (request.method === 'POST') {
      const body = await readJsonBody(request);
      if (body === null) {
        return fail(400, 'invalid_json', 'O corpo da requisição não é um JSON válido.');
      }
      return createPlates(env.DB, body as CreateBody);
    }
    return methodNotAllowed('GET, POST');
  }

  if (request.method === 'GET') {
    return readPlate(env.DB, code);
  }
  if (request.method === 'PATCH') {
    const body = await readJsonBody(request);
    if (body === null) {
      return fail(400, 'invalid_json', 'O corpo da requisição não é um JSON válido.');
    }
    return patchPlate(env.DB, code, body as PatchBody);
  }
  return methodNotAllowed('GET, PATCH');
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json();
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function methodNotAllowed(allow: string): Response {
  return new Response(
    JSON.stringify({ error: 'method_not_allowed', message: 'Método não permitido.' }),
    {
      status: 405,
      headers: {
        allow,
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    },
  );
}
