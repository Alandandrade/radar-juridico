const express = require('express');
const { chromium } = require('playwright');
const cron = require('node-cron');
const jwt = require('jsonwebtoken');
const inicializarBanco = require('./database');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const CHAVE_SECRETA = 'radar_juridico_secreto_123';
let db; 
let varreduraEmAndamento = false;
let progressoAtual = 0;
let progressoTotal = 0;

// Variáveis Globais de PCP e Configuração
let cronsAtivos = [];
let globalConfig = { manutencao: 0, aviso_geral: '' };

// 🚀 FUNÇÃO: Recalcular horários do robô dinamicamente
async function carregarConfiguracoes() {
    const config = await db.get('SELECT * FROM configuracoes WHERE id = 1');
    if (config) {
        globalConfig.manutencao = config.manutencao;
        globalConfig.aviso_geral = config.aviso_geral;
        
        // Cancela os agendamentos antigos
        cronsAtivos.forEach(c => c.stop());
        cronsAtivos = [];

        // Cria os novos agendamentos baseados no banco de dados
        [config.hora_1, config.hora_2, config.hora_3].forEach(hora => {
            if (hora && hora.includes(':')) {
                const [h, m] = hora.split(':');
                cronsAtivos.push(cron.schedule(`${m} ${h} * * 1-5`, () => checarProcessos(), { timezone: "America/Sao_Paulo" }));
            }
        });
        console.log(`[PCP] Horários do robô atualizados: ${config.hora_1}, ${config.hora_2}, ${config.hora_3}`);
    }
}

async function registrarLog(usuario, acao, detalhes) {
    const dataHora = new Date().toLocaleString('pt-BR');
    await db.run(`INSERT INTO logs (usuario, acao, detalhes, data_hora) VALUES (?, ?, ?, ?)`, [usuario, acao, detalhes, dataHora]);
}

async function rasparDadosTribunal(pagina, url) {
    const resposta = await pagina.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (resposta && resposta.status() >= 500) throw new Error("TRIBUNAL_FORA_AR");
    if (resposta && resposta.status() === 403) throw new Error("IP_BLOQUEADO");

    const xpathTabela = '//*[@id="tabelaUltimasMovimentacoes"] | //*[@id="tabelaTodasMovimentacoes"] | //*[@id="divInfraAreaProcesso"]';
    const estaNoAr = await pagina.waitForSelector(`xpath=${xpathTabela}`, { timeout: 15000 }).catch(() => null);
    if (!estaNoAr) throw new Error("ESTRUTURA_PAGINA_ALTERADA");

    const numeroTexto = await pagina.locator('xpath=//*[@id="numeroProcesso"] | //*[@id="txtNumProcesso"]').first().innerText().catch(() => 'Não identificado');
    const classeTexto = await pagina.locator('xpath=//*[@id="classeProcesso"] | //*[@id="txtClasse"]').first().innerText().catch(() => 'Não identificada');
    const dataTexto = await pagina.locator('xpath=//*[@id="tabelaUltimasMovimentacoes"]/tr[1]/td[1] | //*[@id="divInfraAreaProcesso"]/table/tbody/tr[2]/td[2]').first().innerText();
    const descricaoTexto = await pagina.locator('xpath=//*[@id="tabelaUltimasMovimentacoes"]/tr[1]/td[3] | (//*[@id="divInfraAreaProcesso"]/table/tbody/tr[2]/td[2])/following-sibling::td[1]').first().innerText();
    
    return { numero: numeroTexto.trim(), classe: classeTexto.trim(), data: dataTexto.trim(), descricao: descricaoTexto.trim() };
}

async function checarProcessos(usuarioSessao = null, processoId = null) {
    if (varreduraEmAndamento) return;
    varreduraEmAndamento = true;
    let processosAlvo;
    if (processoId) processosAlvo = await db.all('SELECT * FROM processos WHERE id = ?', [processoId]);
    else if (usuarioSessao) processosAlvo = await db.all('SELECT * FROM processos WHERE usuario = ?', [usuarioSessao]);
    else processosAlvo = await db.all(`SELECT processos.* FROM processos JOIN usuarios ON processos.usuario = usuarios.usuario WHERE usuarios.mensalidade_em_dia = 1`);
    
    progressoTotal = processosAlvo.length;
    progressoAtual = 0;
    if (progressoTotal === 0) { varreduraEmAndamento = false; return; }
    
    let navegador;
    try {
        navegador = await chromium.launch({ headless: true }); 
        const pagina = await navegador.newPage();
        await pagina.route('**/*', (route) => {
            if (['image', 'font', 'media', 'stylesheet'].includes(route.request().resourceType())) route.abort();
            else route.continue();
        });

        for (let processo of processosAlvo) {
            progressoAtual++;
            try {
                const resultado = await rasparDadosTribunal(pagina, processo.url);
                if (resultado) {
                    const agora = new Date().toLocaleString('pt-BR');
                    if (resultado.numero && resultado.numero !== 'Não identificado') await db.run('UPDATE processos SET numero = ? WHERE id = ?', [resultado.numero, processo.id]);
                    if (resultado.classe && resultado.classe !== 'Não identificada') await db.run('UPDATE processos SET classeAcao = ? WHERE id = ?', [resultado.classe, processo.id]);
                    if (processo.dataUltimaMovimentacao !== resultado.data) {
                        await db.run(`UPDATE processos SET dataUltimaMovimentacao = ?, descricaoMovimentacao = ?, atualizou = 1, ultimaVarredura = ? WHERE id = ?`, [resultado.data, resultado.descricao, agora, processo.id]);
                    } else { await db.run(`UPDATE processos SET ultimaVarredura = ? WHERE id = ?`, [agora, processo.id]); }
                }
            } catch (erro) {
                let msg = "❌ Falha de conexão com o Tribunal"; 
                if (erro.message === "TRIBUNAL_FORA_AR") msg = "⚠️ Servidor do Tribunal fora do ar";
                else if (erro.message === "IP_BLOQUEADO") msg = "🚫 Acesso bloqueado pelo Tribunal";
                else if (erro.message === "ESTRUTURA_PAGINA_ALTERADA") msg = "⚠️ Instabilidade no site (Página com erro)";
                await db.run(`UPDATE processos SET descricaoMovimentacao = ? WHERE id = ?`, [msg, processo.id]);
            }
            await pagina.waitForTimeout(Math.floor(Math.random() * (5000 - 2000 + 1) + 2000)); 
        }
    } catch (e) {} finally { if (navegador) await navegador.close(); varreduraEmAndamento = false; }
}

// 🚀 MIDDLEWARE DE SEGURANÇA E MANUTENÇÃO
function checarToken(req, res, next) {
    const token = req.headers['authorization'];
    if (!token) return res.status(403).json({ success: false, message: 'Acesso negado.' });
    jwt.verify(token.split(' ')[1], CHAVE_SECRETA, (err, decodificado) => {
        if (err) return res.status(401).json({ success: false, message: 'Sessão expirada.' });
        
        // Bloqueia clientes se estiver em manutenção programada
        if (globalConfig.manutencao === 1 && decodificado.nivel_acesso !== 'admin') {
            return res.status(503).json({ success: false, message: '🛠️ Sistema em manutenção programada. Voltamos em breve.' });
        }
        
        req.usuarioSessao = decodificado.usuario; 
        next();
    });
}

async function checarAdmin(req, res, next) {
    const token = req.headers['authorization'];
    if (!token) return res.status(403).json({ success: false });
    jwt.verify(token.split(' ')[1], CHAVE_SECRETA, async (err, decodificado) => {
        if (err || decodificado.nivel_acesso !== 'admin') return res.status(403).json({ success: false });
        req.usuarioSessao = decodificado.usuario; next();
    });
}

// ROTAS PÚBLICAS
app.post('/api/login', async (req, res) => {
    const { usuario, senha } = req.body;
    const user = await db.get('SELECT * FROM usuarios WHERE usuario = ? AND senha = ?', [usuario, senha]);
    if (user) {
        if (globalConfig.manutencao === 1 && user.nivel_acesso !== 'admin') {
            return res.status(503).json({ success: false, message: '🛠️ O sistema está em manutenção neste momento. Tente novamente mais tarde.' });
        }
        if (user.nivel_acesso !== 'admin') registrarLog(usuario, "LOGIN", "Acessou o sistema");
        // O token agora carrega o nível de acesso para verificação rápida
        const token = jwt.sign({ usuario: user.usuario, nivel_acesso: user.nivel_acesso }, CHAVE_SECRETA, { expiresIn: '24h' });
        res.json({ success: true, token, usuario: user.usuario, nivel_acesso: user.nivel_acesso, mensalidade: user.mensalidade_em_dia });
    } else { res.status(401).json({ success: false, message: "Usuário ou senha incorretos" }); }
});

app.get('/api/config/public', (req, res) => { res.json({ aviso_geral: globalConfig.aviso_geral }); });

// ROTAS DO CLIENTE
app.get('/api/processos', checarToken, async (req, res) => {
    const dadosUser = await db.get('SELECT mensalidade_em_dia FROM usuarios WHERE usuario = ?', [req.usuarioSessao]);
    if (dadosUser && dadosUser.mensalidade_em_dia === 0) return res.status(402).json({ success: false, message: "Bloqueio financeiro." });
    const processosDoUsuario = await db.all('SELECT * FROM processos WHERE usuario = ?', [req.usuarioSessao]);
    res.json(processosDoUsuario.map(p => {
        if(p.tarefaData || p.tarefaTexto) p.tarefa = { data: p.tarefaData, texto: p.tarefaTexto, alerta: p.tarefaAlerta };
        else p.tarefa = null;
        p.atualizou = p.atualizou === 1; return p;
    }));
});

// 🚀 NOVA ROTA: Exportar Relatório (Excel/CSV)
app.get('/api/processos/exportar', checarToken, async (req, res) => {
    const processos = await db.all('SELECT * FROM processos WHERE usuario = ?', [req.usuarioSessao]);
    let csv = 'Cliente;Classe da Acao;Numero do Processo;Ultima Movimentacao;Descricao do Tribunal\n';
    processos.forEach(p => {
        // Remove quebras de linha para não quebrar a planilha do cliente
        const desc = (p.descricaoMovimentacao || '').replace(/(\r\n|\n|\r)/gm, " "); 
        csv += `"${p.nome}";"${p.classeAcao}";"${p.numero}";"${p.dataUltimaMovimentacao}";"${desc}"\n`;
    });
    registrarLog(req.usuarioSessao, "EXPORTAR_RELATORIO", `Gerou relatório de processos em planilha.`);
    res.header('Content-Type', 'text/csv; charset=utf-8');
    res.attachment('Relatorio_Processos.csv');
    // Adiciona o BOM do UTF-8 para o Excel Brasileiro abrir com os acentos certos
    res.send('\uFEFF' + csv); 
});

app.post('/api/processos', checarToken, async (req, res) => {
    const { nome, url, telefone } = req.body;
    const usuario = req.usuarioSessao;
    if (!nome || !url) return res.status(400).json({ success: false });

    const userMeta = await db.get('SELECT limite_processos, mensalidade_em_dia FROM usuarios WHERE usuario = ?', [usuario]);
    if (userMeta.mensalidade_em_dia === 0) return res.status(403).json({ success: false, message: "Bloqueio financeiro." });
    const totalAtual = await db.get('SELECT COUNT(*) as count FROM processos WHERE usuario = ?', [usuario]);
    if (totalAtual.count >= userMeta.limite_processos) return res.status(403).json({ success: false, message: "Limite do plano atingido." });
    const existente = await db.get('SELECT id FROM processos WHERE url = ? AND usuario = ?', [url, usuario]);
    if (existente) return res.status(409).json({ success: false, message: "Já monitora este processo." });

    const id = Date.now();
    await db.run(`INSERT INTO processos (id, usuario, nome, telefone, url, numero, classeAcao, dataUltimaMovimentacao, descricaoMovimentacao, ultimaVarredura, atualizou) VALUES (?, ?, ?, ?, ?, 'Aguardando...', 'Aguardando...', '-', 'Aguardando robô.', '-', 0)`, [id, usuario, nome, telefone, url]);
    
    registrarLog(usuario, "CRIAR_PROCESSO", `Cadastrou o processo: ${nome}`);
    res.status(201).json({ success: true });
    setTimeout(() => { checarProcessos(null, id); }, 1000);
});

app.put('/api/processos/:id', checarToken, async (req, res) => {
    const result = await db.run('UPDATE processos SET nome = ?, telefone = ?, url = ? WHERE id = ? AND usuario = ?', [req.body.nome, req.body.telefone, req.body.url, req.params.id, req.usuarioSessao]);
    if (result.changes > 0) { registrarLog(req.usuarioSessao, "EDITAR_PROCESSO", `Editou processo de: ${req.body.nome}`); res.json({ success: true }); } 
    else res.status(404).json({ success: false });
});

app.delete('/api/processos/:id', checarToken, async (req, res) => {
    const p = await db.get('SELECT nome FROM processos WHERE id = ?', [req.params.id]);
    await db.run('DELETE FROM processos WHERE id = ? AND usuario = ?', [req.params.id, req.usuarioSessao]);
    if (p) registrarLog(req.usuarioSessao, "EXCLUIR_PROCESSO", `Removeu processo de: ${p.nome}`);
    res.json({ success: true });
});

app.post('/api/varredura', checarToken, (req, res) => { registrarLog(req.usuarioSessao, "VARREDURA_MANUAL", `Disparou o robô manualmente`); checarProcessos(req.usuarioSessao); res.json({ success: true }); });
app.get('/api/status', checarToken, (req, res) => res.json({ varreduraEmAndamento, progressoAtual, progressoTotal }));
app.post('/api/processos/:id/visto', checarToken, async (req, res) => { await db.run('UPDATE processos SET atualizou = 0 WHERE id = ? AND usuario = ?', [req.params.id, req.usuarioSessao]); res.json({ success: true }); });
app.post('/api/processos/:id/tarefa', checarToken, async (req, res) => {
    const t = req.body.tarefa;
    if (t) { await db.run('UPDATE processos SET tarefaData = ?, tarefaTexto = ?, tarefaAlerta = ? WHERE id = ? AND usuario = ?', [t.data, t.texto, t.alerta, req.params.id, req.usuarioSessao]); registrarLog(req.usuarioSessao, "CRIAR_TAREFA", `Agendou prazo: ${t.texto}`); } 
    else { await db.run('UPDATE processos SET tarefaData = NULL, tarefaTexto = NULL, tarefaAlerta = NULL WHERE id = ? AND usuario = ?', [req.params.id, req.usuarioSessao]); }
    res.json({ success: true });
});

// ROTAS EXCLUSIVAS DO ADMINISTRADOR 
app.get('/api/admin/dashboard', checarAdmin, async (req, res) => {
    try {
        const ativos = await db.get(`SELECT COUNT(*) as count FROM usuarios WHERE nivel_acesso = 'usuario' AND mensalidade_em_dia = 1`);
        const inativos = await db.get(`SELECT COUNT(*) as count FROM usuarios WHERE nivel_acesso = 'usuario' AND mensalidade_em_dia = 0`);
        const totalProcessos = await db.get(`SELECT COUNT(*) as count FROM processos`);
        const erros = await db.get(`SELECT COUNT(*) as count FROM processos WHERE descricaoMovimentacao LIKE '%❌%' OR descricaoMovimentacao LIKE '%⚠️%' OR descricaoMovimentacao LIKE '%🚫%'`);
        let taxaSucesso = 100; if (totalProcessos.count > 0) taxaSucesso = (((totalProcessos.count - erros.count) / totalProcessos.count) * 100).toFixed(1);
        res.json({ totalUsuarios: ativos.count + inativos.count, usuariosAtivos: ativos.count, usuariosInativos: inativos.count, totalProcessos: totalProcessos.count, erros: erros.count, taxaSucesso: taxaSucesso });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.get('/api/admin/usuarios', checarAdmin, async (req, res) => { res.json(await db.all(`SELECT usuarios.id, usuarios.usuario, usuarios.tipo_conta, usuarios.limite_processos, usuarios.mensalidade_em_dia, usuarios.data_cadastro, COUNT(processos.id) as total_processos FROM usuarios LEFT JOIN processos ON usuarios.usuario = processos.usuario WHERE usuarios.nivel_acesso != 'admin' GROUP BY usuarios.id`)); });
app.post('/api/admin/usuarios', checarAdmin, async (req, res) => {
    try { await db.run(`INSERT INTO usuarios (usuario, senha, nivel_acesso, tipo_conta, limite_processos, mensalidade_em_dia, data_cadastro) VALUES (?, ?, 'usuario', ?, ?, 1, ?)`, [req.body.usuario, req.body.senha, req.body.tipo_conta, req.body.limite_processos, new Date().toLocaleDateString('pt-BR')]); res.json({ success: true }); } 
    catch(err) { res.status(400).json({ success: false, message: "Usuário já existe" }); }
});
app.put('/api/admin/usuarios/:id', checarAdmin, async (req, res) => { await db.run(`UPDATE usuarios SET tipo_conta = ?, limite_processos = ?, mensalidade_em_dia = ? WHERE id = ?`, [req.body.tipo_conta, req.body.limite_processos, req.body.mensalidade_em_dia, req.params.id]); res.json({ success: true }); });
app.delete('/api/admin/usuarios/:id', checarAdmin, async (req, res) => {
    const user = await db.get('SELECT usuario FROM usuarios WHERE id = ?', [req.params.id]);
    if (user) { await db.run('DELETE FROM processos WHERE usuario = ?', [user.usuario]); await db.run('DELETE FROM logs WHERE usuario = ?', [user.usuario]); await db.run('DELETE FROM usuarios WHERE id = ?', [req.params.id]); res.json({ success: true }); } 
    else res.status(404).json({ success: false });
});
app.post('/api/admin/impersonate', checarAdmin, async (req, res) => {
    const user = await db.get('SELECT * FROM usuarios WHERE usuario = ?', [req.body.usuarioAlvo]);
    if (!user) return res.status(404).json({ success: false });
    res.json({ success: true, token: jwt.sign({ usuario: user.usuario, nivel_acesso: 'usuario' }, CHAVE_SECRETA, { expiresIn: '1h' }), usuario: user.usuario });
});
app.get('/api/admin/logs/:usuario', checarAdmin, async (req, res) => { res.json(await db.all('SELECT * FROM logs WHERE usuario = ? ORDER BY id DESC LIMIT 50', [req.params.usuario])); });

// 🚀 ROTAS DE CONFIGURAÇÃO GLOBAL (Admin)
app.get('/api/admin/config', checarAdmin, async (req, res) => { res.json(await db.get('SELECT * FROM configuracoes WHERE id = 1')); });
app.put('/api/admin/config', checarAdmin, async (req, res) => {
    const { manutencao, aviso_geral, hora_1, hora_2, hora_3 } = req.body;
    await db.run(`UPDATE configuracoes SET manutencao = ?, aviso_geral = ?, hora_1 = ?, hora_2 = ?, hora_3 = ? WHERE id = 1`, [manutencao, aviso_geral, hora_1, hora_2, hora_3]);
    await carregarConfiguracoes(); // Atualiza a memória e recarrega os crons na hora!
    res.json({ success: true });
});

// Inicialização Central
inicializarBanco().then(async database => { 
    db = database; 
    await carregarConfiguracoes(); // Liga os robôs baseados no banco
    app.listen(3000, () => console.log('✅ Servidor Seguro (SQLite + JWT) rodando na porta 3000')); 
});