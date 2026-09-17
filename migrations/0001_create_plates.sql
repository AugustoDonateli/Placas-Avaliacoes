-- =============================================================================
-- 0001 — Tabela de placas
-- =============================================================================
-- Uma linha por placa fisica. O `code` e o que esta impresso no QR e gravado
-- na tag NFC, e por isso e IMUTAVEL: uma vez que a placa sai da bancada,
-- aquele codigo pertence aquela placa para sempre.
--
-- Trocar o cliente de uma placa significa alterar `destination_url` e
-- `establishment` desta linha. O `code` nunca muda.
-- =============================================================================

CREATE TABLE plates (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,

  -- O codigo publico: o que aparece em SEUDOMINIO.com/<code>.
  -- Sempre minusculo (garantido pelo CHECK abaixo) para que /A7K2 digitado
  -- a mao funcione igual a /a7k2 depois que a aplicacao normalizar a entrada.
  code            TEXT    NOT NULL UNIQUE
                    CHECK (length(code) BETWEEN 1 AND 12)
                    CHECK (code = lower(code)),

  -- Destino do redirecionamento. NULL enquanto a placa esta em estoque.
  -- O CHECK garante https:// mesmo em insercoes feitas a mao via
  -- `wrangler d1 execute`, que e como esta fase vai operar.
  -- A validacao completa (allowlist de hosts do Google) roda na aplicacao,
  -- na escrita — ver docs/google-review-urls.md.
  destination_url TEXT
                    CHECK (destination_url IS NULL
                           OR destination_url LIKE 'https://%'),

  --   draft     placa existe, nunca foi configurada (em estoque)
  --   active    vendida e configurada — redireciona
  --   inactive  configurada, mas pausada temporariamente
  --   retired   aposentada de vez; o codigo NUNCA volta a ser usado
  status          TEXT    NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'active', 'inactive', 'retired')),

  -- Nome do estabelecimento, como texto livre. Nesta fase nao existe tabela
  -- de clientes; quando existir, isto vira uma foreign key.
  establishment   TEXT,

  notes           TEXT,

  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Nao ha CREATE INDEX para `code`: a restricao UNIQUE ja cria o indice que a
-- busca do redirecionamento usa. Um indice extra seria duplicado.

-- Mantem `updated_at` honesto sem depender da aplicacao lembrar de setar.
-- Triggers do SQLite nao sao recursivos por padrao, entao o UPDATE interno
-- nao dispara o trigger de novo.
CREATE TRIGGER plates_set_updated_at
AFTER UPDATE ON plates
FOR EACH ROW
BEGIN
  UPDATE plates SET updated_at = datetime('now') WHERE id = OLD.id;
END;
