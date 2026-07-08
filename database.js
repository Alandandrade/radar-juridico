const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const fs = require('fs');

async function inicializarBanco() {
    const db = await open({ filename: './banco.sqlite', driver: sqlite3.Database });

    await db.exec(`CREATE TABLE IF NOT EXISTS usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario TEXT UNIQUE, senha TEXT)`);
    await db.exec(`ALTER TABLE usuarios ADD COLUMN nivel_acesso TEXT DEFAULT 'usuario'`).catch(() => {});
    await db.exec(`ALTER TABLE usuarios ADD COLUMN tipo_conta TEXT DEFAULT 'demo'`).catch(() => {});
    await db.exec(`ALTER TABLE usuarios ADD COLUMN limite_processos INTEGER DEFAULT 5`).catch(() => {});
    await db.exec(`ALTER TABLE usuarios ADD COLUMN mensalidade_em_dia INTEGER DEFAULT 1`).catch(() => {});
    await db.exec(`ALTER TABLE usuarios ADD COLUMN data_cadastro TEXT`).catch(() => {});

    await db.exec(`CREATE TABLE IF NOT EXISTS processos (id INTEGER PRIMARY KEY, usuario TEXT, nome TEXT, telefone TEXT, url TEXT, numero TEXT, classeAcao TEXT, dataUltimaMovimentacao TEXT, descricaoMovimentacao TEXT, ultimaVarredura TEXT, atualizou INTEGER, tarefaData TEXT, tarefaTexto TEXT, tarefaAlerta TEXT)`);
    
    await db.exec(`CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario TEXT, acao TEXT, detalhes TEXT, data_hora TEXT)`);

    // 🚀 NOVA TABELA: Configurações Globais do Sistema
    await db.exec(`
        CREATE TABLE IF NOT EXISTS configuracoes (
            id INTEGER PRIMARY KEY,
            manutencao INTEGER DEFAULT 0,
            aviso_geral TEXT DEFAULT '',
            hora_1 TEXT DEFAULT '06:00',
            hora_2 TEXT DEFAULT '14:00',
            hora_3 TEXT DEFAULT '20:00'
        )
    `);

    // Injeta a configuração padrão se não existir
    const configExist = await db.get("SELECT id FROM configuracoes");
    if (!configExist) await db.run("INSERT INTO configuracoes (id) VALUES (1)");

    const adminExist = await db.get("SELECT id FROM usuarios WHERE nivel_acesso = 'admin'");
    if (!adminExist) {
        const hoje = new Date().toLocaleDateString('pt-BR');
        await db.run(`INSERT INTO usuarios (usuario, senha, nivel_acesso, tipo_conta, limite_processos, mensalidade_em_dia, data_cadastro) VALUES ('admin', 'coquinho2024', 'admin', 'pro', 9999, 1, ?)`, [hoje]);
    }

    if (fs.existsSync('usuarios.json')) {
        try {
            const usuariosAntigos = JSON.parse(fs.readFileSync('usuarios.json', 'utf8'));
            const hoje = new Date().toLocaleDateString('pt-BR');
            for (let u of usuariosAntigos) await db.run('INSERT OR IGNORE INTO usuarios (usuario, senha, nivel_acesso, tipo_conta, limite_processos, mensalidade_em_dia, data_cadastro) VALUES (?, ?, "usuario", "demo", 5, 1, ?)', [u.usuario, u.senha, hoje]);
        } catch(e){}
    }
    return db;
}
module.exports = inicializarBanco;