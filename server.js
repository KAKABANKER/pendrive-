const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const pool = new Pool({
    connectionString: 'postgresql://nuitbanker_db_user:Gbnwn5eEqlrKkx4xjduxGis0DchI1aXy@dpg-d8h40ccvikkc73erecng-a.oregon-postgres.render.com/nuitbanker_db',
    ssl: { rejectUnauthorized: false },
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000
});

// Configuração Plumify
const PLUMIFY_PRODUCT_HASH = 'lxpykbkgfl';
const PLUMIFY_API_TOKEN = '1Vp6bm2wSoil2giHCGRjsZ9IGVbiHve4u8xbyUoRWpdvHUWYOj6wZ9yd0xVq';

async function initDatabase() {
    const client = await pool.connect();
    try {
        await client.query(`CREATE TABLE IF NOT EXISTS payments (
            id SERIAL PRIMARY KEY, 
            transaction_id VARCHAR(100) UNIQUE, 
            cpf VARCHAR(14), 
            telefone VARCHAR(20),
            valor DECIMAL(10,2), 
            status VARCHAR(20) DEFAULT 'pending', 
            tipo_pagamento VARCHAR(20) DEFAULT 'PIX',
            data_solicitacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            data_pagamento TIMESTAMP
        )`);
        console.log('✅ Banco de dados inicializado');
    } catch (err) {
        console.error('❌ Erro ao inicializar banco:', err);
    } finally { 
        client.release(); 
    }
}
initDatabase();

// ============ ROTAS PIX ============

// Salvar pagamento
app.post('/api/save-payment', async (req, res) => {
    const { transaction_id, cpf, valor, telefone } = req.body;
    try { 
        await pool.query('INSERT INTO payments (transaction_id, cpf, valor, status, telefone) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (transaction_id) DO NOTHING', [transaction_id, cpf, valor, 'pending', telefone]); 
        res.json({ success: true }); 
    } catch { 
        res.json({ success: false }); 
    }
});

// Verificar status do pagamento
app.get('/api/check-payment/:transaction_id', async (req, res) => {
    const { transaction_id } = req.params;
    try { 
        const result = await pool.query('SELECT status FROM payments WHERE transaction_id = $1', [transaction_id]); 
        if (result.rows.length > 0) res.json({ status: result.rows[0].status }); 
        else res.json({ status: 'not_found' }); 
    } catch { 
        res.status(500).json({ error: 'Erro ao verificar pagamento' }); 
    }
});

// Criar pagamento PIX via Plumify
app.post('/api/create-payment', async (req, res) => {
    const { amount, customer_name, customer_email, customer_cpf, customer_phone } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Valor invalido' });
    
    const amountCents = Math.round(parseFloat(amount) * 100);
    const payload = { 
        amount: amountCents, 
        offer_hash: PLUMIFY_PRODUCT_HASH, 
        payment_method: 'pix', 
        customer: { 
            name: customer_name || 'Pendrive Store', 
            email: customer_email || 'contato@pendrivestore.com', 
            phone_number: customer_phone || '61981168652', 
            document: customer_cpf || '00000000000', 
            street_name: 'Rua Exemplo', 
            number: '123', 
            neighborhood: 'Centro', 
            city: 'Brasilia', 
            state: 'DF', 
            zip_code: '70000000' 
        }, 
        cart: [{ 
            product_hash: PLUMIFY_PRODUCT_HASH, 
            title: 'Pendrive - Playlist Personalizada', 
            price: amountCents, 
            quantity: 1, 
            operation_type: 1, 
            tangible: false 
        }], 
        expire_in_days: 3, 
        transaction_origin: 'api', 
        postback_url: `${process.env.BASE_URL || 'https://reidacacambinha.onrender.com'}/api/webhook/pagamento` 
    };
    
    try {
        const response = await fetch(`https://api.Plumify.com.br/api/public/v1/transactions?api_token=${PLUMIFY_API_TOKEN}`, { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify(payload) 
        });
        const data = await response.json();
        if (data.pix && data.pix.pix_qr_code) {
            await pool.query('INSERT INTO payments (transaction_id, cpf, valor, status, telefone) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (transaction_id) DO NOTHING', [data.hash, customer_cpf, amount, 'pending', customer_phone]).catch(e => console.log(e));
            res.json({ 
                success: true, 
                payment: { 
                    pix_code: data.pix.pix_qr_code, 
                    pix_qrcode: data.pix.pix_qr_code, 
                    expires_at: data.expires_at, 
                    id: data.hash, 
                    status: data.payment_status 
                } 
            });
        } else { 
            res.json({ success: false, error: data.message || 'Erro ao gerar PIX' }); 
        }
    } catch (error) { 
        console.error('Erro ao gerar pagamento:', error);
        res.status(500).json({ error: 'Erro ao gerar pagamento' }); 
    }
});

// Webhook para confirmar pagamento
app.post('/api/webhook/pagamento', async (req, res) => {
    const { hash, status } = req.body;
    if (status === 'paid') { 
        try { 
            await pool.query('UPDATE payments SET status = $1, data_pagamento = NOW() WHERE transaction_id = $2', ['paid', hash]); 
            console.log(`✅ Pagamento confirmado: ${hash}`);
        } catch(e) {
            console.error('Erro ao atualizar pagamento:', e);
        } 
    }
    res.json({ received: true });
});

// ============ ROTAS DE PÁGINAS ============
app.get('/', (req, res) => { 
    res.sendFile(path.join(__dirname, 'public', 'index.html')); 
});
app.get('/checkout', (req, res) => { 
    res.sendFile(path.join(__dirname, 'public', 'checkout.html')); 
});

// Fallback
app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) {
        return res.status(404).json({ error: 'API endpoint not found' });
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Servidor rodando na porta ${PORT}`);
    console.log(`🌐 Site: https://reidacacambinha.onrender.com`);
});