const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ─── Health check ────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Proxy B2G Fornecedores ativo" });
});

// ─── Helpers ─────────────────────────────────────────────────────
async function fetchJSON(url) {
  const r = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "B2G-Agent/1.0" },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} em ${url}`);
  return r.json();
}

// ─── 1. PNCP — busca contratações por termo ──────────────────────
async function buscarPNCP(termo) {
  try {
    // Busca compras abertas/homologadas no PNCP por descrição
    const url = `https://pncp.gov.br/api/consulta/v1/contratacoes/publicacao?q=${encodeURIComponent(termo)}&pagina=1&tamanhoPagina=10&status=encerrado`;
    const data = await fetchJSON(url);
    const items = data?.data || data?.content || data?.items || [];
    return items.slice(0, 8).map((c) => ({
      fonte: "PNCP",
      orgao: c.orgaoEntidade?.razaoSocial || c.unidadeOrgao?.nomeUnidade || "Órgão público",
      objeto: c.objetoCompra || c.descricao || termo,
      valorEstimado: c.valorTotalEstimado || c.valorTotalHomologado || null,
      dataPublicacao: c.dataPublicacaoPncp || c.dataAberturaProposta || null,
      modalidade: c.modalidadeNome || c.modalidade || "Pregão Eletrônico",
      link: c.linkSistemaOrigem || `https://pncp.gov.br/app/editais/${c.numeroControlePNCP || ""}`,
      numeroControle: c.numeroControlePNCP || null,
    }));
  } catch (e) {
    console.error("Erro PNCP:", e.message);
    return [];
  }
}

// ─── 2. PNCP — busca atas de registro de preço ───────────────────
async function buscarAtasPNCP(termo) {
  try {
    const hoje = new Date();
    const dataInicio = new Date(hoje);
    dataInicio.setFullYear(hoje.getFullYear() - 1);
    const fmt = (d) => d.toISOString().split("T")[0];

    const url = `https://pncp.gov.br/api/consulta/v1/atas?q=${encodeURIComponent(termo)}&pagina=1&tamanhoPagina=8&dataInicial=${fmt(dataInicio)}&dataFinal=${fmt(hoje)}`;
    const data = await fetchJSON(url);
    const items = data?.data || data?.content || data?.items || [];
    return items.slice(0, 6).map((a) => ({
      fonte: "PNCP-ATA",
      fornecedor: a.fornecedorRazaoSocial || a.nomeRazaoSocial || "Fornecedor",
      cnpj: a.fornecedorCnpj || a.cnpj || null,
      objeto: a.objetoAta || a.descricaoObjeto || termo,
      valorUnitario: a.valorUnitarioEstimado || a.valorUnitario || null,
      quantidade: a.quantidade || null,
      orgao: a.orgaoEntidade?.razaoSocial || "Órgão público",
      vigencia: a.dataVigenciaFim || null,
    }));
  } catch (e) {
    console.error("Erro PNCP Atas:", e.message);
    return [];
  }
}

// ─── 3. Compras.gov.br (SIASG) — preços praticados ───────────────
async function buscarComprasGov(termo) {
  try {
    const url = `http://compras.dados.gov.br/licitacoes/v1/licitacoes?descricao=${encodeURIComponent(termo)}&_format=json&_page=0&_pageSize=8`;
    const data = await fetchJSON(url);
    const items = data?.licitacoes || data?.content || data?._embedded?.licitacoes || [];
    return items.slice(0, 6).map((l) => ({
      fonte: "Compras.gov",
      numero: l.numero_licitacao || l.id || "",
      uasg: l.uasg || "",
      objeto: l.objeto || termo,
      modalidade: l.modalidade || "Pregão",
      situacao: l.situacao || "",
      dataAbertura: l.data_abertura || null,
    }));
  } catch (e) {
    console.error("Erro Compras.gov:", e.message);
    return [];
  }
}

// ─── 4. Dados abertos — fornecedores por CNPJ/nome ───────────────
async function buscarFornecedoresGov(termo) {
  try {
    const url = `http://compras.dados.gov.br/fornecedores/v1/fornecedores?razao_social=${encodeURIComponent(termo)}&_format=json&_pageSize=6`;
    const data = await fetchJSON(url);
    const items = data?.fornecedores || data?._embedded?.fornecedores || data?.content || [];
    return items.slice(0, 6).map((f) => ({
      fonte: "SIASG-Fornecedor",
      nome: f.nome || f.razao_social || "",
      cnpj: f.cnpj || f.cpf || "",
      uf: f.uf || "",
      municipio: f.municipio || "",
      ativo: f.habilitado !== false,
    }));
  } catch (e) {
    console.error("Erro Fornecedores Gov:", e.message);
    return [];
  }
}

// ─── 5. Análise com Claude + web search ──────────────────────────
async function analisarComClaude({ produto, quantidade, orcamento, prazo, uf, specs, criterios, base, dadosGov }) {
  const resumoDados =
    dadosGov.length > 0
      ? `\n\nDADOS REAIS COLETADOS DAS FONTES GOVERNAMENTAIS:\n${JSON.stringify(dadosGov, null, 2)}`
      : "\n\n(Nenhum dado retornado das APIs governamentais — use busca na web como fallback)";

  const baseTexto =
    base?.length
      ? "\n\nFornecedores na base do usuário:\n" +
        base.map((s) => `- ${s.nome} | CNPJ: ${s.cnpj || "N/A"} | Rep: ${s.rep}/10 | Cats: ${s.cats}`).join("\n")
      : "";

  const prompt = `Você é um agente especializado em compras B2G no Brasil.

PRODUTO: ${produto}
QUANTIDADE: ${quantidade || "não informado"}
ORÇAMENTO MÁXIMO: ${orcamento ? "R$ " + parseInt(orcamento).toLocaleString("pt-BR") : "não informado"}
PRAZO: ${prazo || "não informado"}
UF: ${uf || "Nacional"}
ESPECIFICAÇÕES: ${specs || "padrão corporativo"}
CRITÉRIOS: ${(criterios || []).join(", ")}${baseTexto}${resumoDados}

Com base nos dados governamentais acima e em busca na web (Mercado Livre, sites de distribuidores), analise e ranqueie os melhores fornecedores reais para este produto no contexto de licitação pública.

Para cada fornecedor avalie: preço (unitário e total), CNPJ ativo e emissão de NF-e, reputação/histórico em licitações, prazo de entrega.

Responda SOMENTE em JSON válido, sem texto fora do JSON:
{
  "produto": "nome",
  "quantidade": ${parseInt(quantidade) || 0},
  "fontes_consultadas": ["PNCP", "Compras.gov.br", "Mercado Livre"],
  "melhor": {
    "nome": "Empresa",
    "cnpj": "XX.XXX.XXX/0001-XX",
    "preco_unit": 0,
    "preco_total": 0,
    "prazo": "X dias",
    "reputacao": 8.5,
    "score": 92,
    "site": "www.empresa.com.br",
    "justificativa": "2-3 frases com base nos dados reais encontrados",
    "pontos": ["p1","p2","p3"],
    "alertas": []
  },
  "ranking": [
    { "pos": 1, "nome": "Empresa", "cnpj": "XX.XXX.XXX/0001-XX", "preco_unit": 0, "preco_total": 0, "prazo_dias": 30, "score": 92, "da_base": false, "fonte": "PNCP" }
  ],
  "mercado": "análise em 2-3 frases baseada nos dados reais",
  "dicas": ["dica 1","dica 2","dica 3"]
}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2500,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `Erro ${response.status} na API Anthropic`);
  }

  const data = await response.json();
  const fullText = (data.content || [])
    .map((i) => (i.type === "text" ? i.text : ""))
    .filter(Boolean)
    .join("\n");

  const clean = fullText.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(clean);
  } catch {
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error("Resposta da IA fora do formato esperado.");
  }
}

// ─── Endpoint principal ──────────────────────────────────────────
app.post("/api/buscar", async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY não configurada no servidor." });
  }

  const { produto, quantidade, orcamento, prazo, uf, specs, criterios, base } = req.body;
  if (!produto) return res.status(400).json({ error: "Campo 'produto' é obrigatório." });

  try {
    // 1. Busca paralela em todas as fontes governamentais
    const [pncpCompras, pncpAtas, comprasGov, fornecedoresGov] = await Promise.allSettled([
      buscarPNCP(produto),
      buscarAtasPNCP(produto),
      buscarComprasGov(produto),
      buscarFornecedoresGov(produto),
    ]);

    const dadosGov = [
      ...(pncpCompras.status === "fulfilled" ? pncpCompras.value : []),
      ...(pncpAtas.status === "fulfilled" ? pncpAtas.value : []),
      ...(comprasGov.status === "fulfilled" ? comprasGov.value : []),
      ...(fornecedoresGov.status === "fulfilled" ? fornecedoresGov.value : []),
    ];

    // 2. Análise com Claude usando os dados coletados + web search
    const resultado = await analisarComClaude({
      produto, quantidade, orcamento, prazo, uf, specs, criterios, base, dadosGov,
    });

    resultado.dados_brutos = {
      total_registros_gov: dadosGov.length,
      fontes: {
        pncp_contratacoes: pncpCompras.status === "fulfilled" ? pncpCompras.value.length : 0,
        pncp_atas: pncpAtas.status === "fulfilled" ? pncpAtas.value.length : 0,
        compras_gov: comprasGov.status === "fulfilled" ? comprasGov.value.length : 0,
        fornecedores_gov: fornecedoresGov.status === "fulfilled" ? fornecedoresGov.value.length : 0,
      },
    };

    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.message || "Erro interno no proxy." });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy B2G rodando na porta ${PORT}`);
});
