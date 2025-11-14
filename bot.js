// ========================================
// BOT TELEGRAM - ArbiSportsAI
// Deploy: Railway ou Render
// ========================================

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const cron = require('node-cron');

// CONFIGURAÇÕES
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const DEEPBET_TOKEN = process.env.DEEPBET_TOKEN || 'hsM1YbS6d9Q2nKp7WvT3uGfX4cZ0rLmNa8qD5oVyJxR1bUeCjP2tHkFsLw9aQx7';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

console.log('🤖 ArbiSportsAI Bot iniciando...');

// ========================================
// UTILITÁRIOS
// ========================================

function formatDate(dateString) {
  const date = new Date(dateString);
  return date.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function getSportIcon(sportName) {
  const icons = {
    football: '⚽',
    basketball: '🏀',
    tennis: '🎾',
    volleyball: '🏐',
    hockey: '🏒',
    baseball: '⚾',
    americanfootball: '🏈',
    handball: '🤾',
    tabletennis: '🏓'
  };
  return icons[sportName.toLowerCase().replace(/\s/g, '')] || '🏆';
}

// ========================================
// SINCRONIZAÇÃO COM API DEEPBET
// ========================================

async function syncDeepBetData() {
  console.log('🔄 Iniciando sincronização...');
  const startTime = Date.now();

  try {
    const response = await axios.get('https://data.deepbet.pro/api/surebets/pre/list', {
      headers: { 'Authorization': `Bearer ${DEEPBET_TOKEN}` },
      timeout: 30000
    });

    const surebets = response.data;
    console.log(`📊 Recebidas ${surebets.length} surebets da API`);

    const currentIds = new Set();
    let newCount = 0;

    for (const sb of surebets) {
      currentIds.add(sb.id);

      // Verificar se já existe
      const { data: existing } = await supabase
        .from('surebets')
        .select('id')
        .eq('id', sb.id)
        .single();

      const surebetData = {
        id: sb.id,
        provider: sb.provider,
        sport_name: sb.sport?.name || 'Unknown',
        event_name: sb.event_name,
        event_date: sb.event_date,
        league: sb.league,
        profit_percent: parseFloat(sb.profit),
        
        bookmaker1_name: sb.bookmaker1?.name,
        outcome1: sb.outcome1,
        odd1: parseFloat(sb.odd1),
        event_link1: sb.event_link1,
        event_link_final1: sb.event_link_final1 || null,
        
        bookmaker2_name: sb.bookmaker2?.name,
        outcome2: sb.outcome2,
        odd2: parseFloat(sb.odd2),
        event_link2: sb.event_link2,
        event_link_final2: sb.event_link_final2 || null,
        
        raw_data: sb,
        is_active: true,
        last_seen_at: new Date().toISOString()
      };

      if (existing) {
        // Atualizar existente
        await supabase
          .from('surebets')
          .update(surebetData)
          .eq('id', sb.id);
      } else {
        // Inserir nova
        await supabase
          .from('surebets')
          .insert(surebetData);
        
        newCount++;
        // Enviar notificações para nova surebet
        await sendNotificationsForSurebet(sb.id);
      }
    }

    // Desativar surebets que não vieram na resposta
    const { data: activeSurebets } = await supabase
      .from('surebets')
      .select('id')
      .eq('is_active', true);

    for (const sb of activeSurebets || []) {
      if (!currentIds.has(sb.id)) {
        await supabase
          .from('surebets')
          .update({ 
            is_active: false, 
            disappeared_at: new Date().toISOString() 
          })
          .eq('id', sb.id);
      }
    }

    const duration = Date.now() - startTime;
    
    // Registrar log
    await supabase.from('sync_logs').insert({
      sync_type: 'surebets',
      success: true,
      items_count: surebets.length,
      duration_ms: duration
    });

    console.log(`✅ Sincronização completa em ${duration}ms`);
    console.log(`   - Total: ${surebets.length} surebets`);
    console.log(`   - Novas: ${newCount} surebets`);

  } catch (error) {
    console.error('❌ Erro na sincronização:', error.message);
    
    await supabase.from('sync_logs').insert({
      sync_type: 'surebets',
      success: false,
      items_count: 0,
      error_message: error.message
    });
  }
}

// ========================================
// SISTEMA DE NOTIFICAÇÕES
// ========================================

async function sendNotificationsForSurebet(surebetId) {
  try {
    // Buscar surebet
    const { data: surebet } = await supabase
      .from('surebets')
      .select('*')
      .eq('id', surebetId)
      .single();

    if (!surebet) return;

    // Buscar usuários ativos
    const { data: users } = await supabase
      .from('users')
      .select('id, telegram_id, plan, user_filters(*)')
      .eq('is_active', true);

    console.log(`📤 Enviando notificações para ${users?.length || 0} usuários...`);

    for (const user of users || []) {
      try {
        // Verificar se já enviou
        const { data: alreadySent } = await supabase
          .from('sent_notifications')
          .select('id')
          .eq('user_id', user.id)
          .eq('surebet_id', surebetId)
          .single();

        if (alreadySent) continue;

        // Verificar filtros
        const filters = user.user_filters?.[0];
        if (!filters || !filters.notifications_enabled) continue;
        if (!matchesFilters(surebet, filters)) continue;

        // Verificar limite do plano
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        const { count } = await supabase
          .from('sent_notifications')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .gte('sent_at', todayStart.toISOString());

        const limits = { free: 10, basic: 100, premium: 999999 };
        if (count >= limits[user.plan]) continue;

        // Enviar mensagem
        await sendSurebetMessage(user.telegram_id, surebet);

        // Registrar envio
        await supabase.from('sent_notifications').insert({
          user_id: user.id,
          surebet_id: surebetId
        });

        console.log(`✅ Enviado para usuário ${user.telegram_id}`);

      } catch (error) {
        console.error(`❌ Erro ao enviar para usuário ${user.id}:`, error.message);
      }

      // Delay para evitar rate limit do Telegram
      await new Promise(resolve => setTimeout(resolve, 100));
    }

  } catch (error) {
    console.error('❌ Erro ao enviar notificações:', error.message);
  }
}

function matchesFilters(surebet, filters) {
  // Lucro
  if (surebet.profit_percent < filters.min_profit_percent) return false;
  if (filters.max_profit_percent && surebet.profit_percent > filters.max_profit_percent) return false;

  // Esportes
  if (filters.sports && filters.sports.length > 0) {
    if (!filters.sports.includes(surebet.sport_name.toLowerCase())) return false;
  }

  // Casas de apostas
  if (filters.bookmakers && filters.bookmakers.length > 0) {
    const hasBookmaker = filters.bookmakers.some(bm => 
      surebet.bookmaker1_name?.toLowerCase().includes(bm.toLowerCase()) ||
      surebet.bookmaker2_name?.toLowerCase().includes(bm.toLowerCase())
    );
    if (!hasBookmaker) return false;
  }

  // Provider
  if (filters.providers && filters.providers.length > 0) {
    if (!filters.providers.includes(surebet.provider)) return false;
  }

  return true;
}

async function sendSurebetMessage(telegramId, surebet) {
  const icon = getSportIcon(surebet.sport_name);
  const link1 = surebet.event_link_final1 || surebet.event_link1;
  const link2 = surebet.event_link_final2 || surebet.event_link2;

  const message = `🤖 <b>ArbiSportsAI - SureBet DETECTADA⚡</b>

📈 <b>ARBITRAGEM com ${surebet.profit_percent.toFixed(1)}% de Lucro</b>

${icon} <b>${surebet.sport_name}${surebet.league ? ' | ' + surebet.league : ''}</b>
🤼 <b>${surebet.event_name}</b>
⏰ ${formatDate(surebet.event_date)}

🏠 <b>${surebet.bookmaker1_name}</b>
🟢 Odd: <b>${surebet.odd1}</b>
🎯 ${surebet.outcome1}
🔗 <a href="${link1}">LINK DA CASA</a>

🏠 <b>${surebet.bookmaker2_name}</b>
🟢 Odd: <b>${surebet.odd2}</b>
🎯 ${surebet.outcome2}
🔗 <a href="${link2}">LINK DA CASA</a>

💡 Use /calcular para ver quanto apostar!`;

  await bot.sendMessage(telegramId, message, {
    parse_mode: 'HTML',
    disable_web_page_preview: true
  });
}

// ========================================
// COMANDOS DO BOT
// ========================================

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  // Registrar ou atualizar usuário
  const { data: existing } = await supabase
    .from('users')
    .select('id')
    .eq('telegram_id', userId)
    .single();

  if (!existing) {
    const { data: newUser } = await supabase
      .from('users')
      .insert({
        telegram_id: userId,
        username: msg.from.username,
        first_name: msg.from.first_name,
        plan: 'free'
      })
      .select()
      .single();

    // Criar filtros padrão
    await supabase.from('user_filters').insert({
      user_id: newUser.id,
      min_profit_percent: 2.0,
      notifications_enabled: true
    });
  }

  const welcomeMessage = `🤖 <b>Bem-vindo ao ArbiSportsAI!</b>

Seu assistente inteligente para arbitragem esportiva 🚀

⚡ <b>Comandos:</b>
/surebets - Ver surebets ativas
/calcular - Calculadora de arbitragem
/meusdados - Ver suas configurações
/ajuda - Tutorial completo

🎯 Você receberá alertas automáticos quando novas oportunidades surgirem!`;

  await bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'HTML' });
});

bot.onText(/\/surebets/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const { data: user } = await supabase
    .from('users')
    .select('id, plan, user_filters(*)')
    .eq('telegram_id', userId)
    .single();

  if (!user) {
    return bot.sendMessage(chatId, 'Use /start primeiro!');
  }

  const filters = user.user_filters?.[0];
  
  let query = supabase
    .from('surebets')
    .select('*')
    .eq('is_active', true)
    .order('profit_percent', { ascending: false });

  if (filters?.min_profit_percent) {
    query = query.gte('profit_percent', filters.min_profit_percent);
  }

  const limits = { free: 5, basic: 20, premium: 50 };
  query = query.limit(limits[user.plan]);

  const { data: surebets } = await query;

  if (!surebets || surebets.length === 0) {
    return bot.sendMessage(chatId, '😔 Nenhuma surebet ativa no momento. Volte em breve!');
  }

  await bot.sendMessage(chatId, `📊 <b>Encontrei ${surebets.length} surebets!</b>\n\nEnviando...`, {
    parse_mode: 'HTML'
  });

  for (const [index, surebet] of surebets.entries()) {
    await sendSurebetMessage(chatId, surebet);
    
    if (index < surebets.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
});

bot.onText(/\/calcular/, async (msg) => {
  const chatId = msg.chat.id;
  
  const message = `🔢 <b>Calculadora de Arbitragem</b>

Envie no formato:
<code>valor odd1 odd2</code>

<b>Exemplo:</b>
<code>100 1.85 2.15</code>

Onde:
- 100 = valor total a investir (R$)
- 1.85 = primeira odd
- 2.15 = segunda odd`;

  await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
});

bot.on('message', async (msg) => {
  const match = msg.text?.match(/^(\d+\.?\d*)\s+(\d+\.?\d*)\s+(\d+\.?\d*)$/);
  if (!match) return;

  const [_, total, odd1, odd2] = match.map(Number);
  
  const stake1 = total / (1 + (odd1 / odd2));
  const stake2 = total - stake1;
  const profit = (stake1 * odd1) - total;
  const profitPercent = (profit / total) * 100;

  const message = `💰 <b>Resultado da Calculadora</b>

📊 Total: R$ ${total.toFixed(2)}

🎯 <b>Aposta 1</b> (odd ${odd1}): R$ ${stake1.toFixed(2)}
💵 Retorno: R$ ${(stake1 * odd1).toFixed(2)}

🎯 <b>Aposta 2</b> (odd ${odd2}): R$ ${stake2.toFixed(2)}
💵 Retorno: R$ ${(stake2 * odd2).toFixed(2)}

✅ <b>Lucro Garantido:</b> R$ ${profit.toFixed(2)} (${profitPercent.toFixed(2)}%)`;

  await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
});

bot.onText(/\/ajuda/, async (msg) => {
  const message = `📚 <b>Tutorial de Arbitragem</b>

<b>O que é Arbitragem Esportiva?</b>
Apostar nos dois resultados possíveis em casas diferentes, garantindo lucro independente do resultado.

<b>Como funciona?</b>
1. Você recebe um alerta de surebet
2. Aposta o valor calculado na Casa 1
3. Aposta o valor calculado na Casa 2
4. Lucro garantido! 💰

<b>Exemplo:</b>
Jogo: Time A vs Time B
Casa 1: Time A vence (odd 1.85)
Casa 2: Time B vence (odd 2.15)
Lucro: 4.5%

Com R$ 100:
- Aposte R$ 53.66 no Time A
- Aposte R$ 46.34 no Time B
- Lucro garantido: R$ 4.50

<b>Dicas:</b>
✅ Cadastre-se nas casas indicadas
✅ Tenha saldo nas duas casas
✅ Aposte rápido (odds mudam)
✅ Use nossa calculadora

Dúvidas? Fale com suporte: /suporte`;

  await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
});

// ========================================
// AGENDAMENTO
// ========================================

// Sincronizar a cada 2 minutos
cron.schedule('*/2 * * * *', () => {
  console.log('⏰ Executando sincronização agendada...');
  syncDeepBetData();
});

// ========================================
// INICIALIZAÇÃO
// ========================================

(async () => {
  try {
    console.log('🔄 Sincronização inicial...');
    await syncDeepBetData();
    console.log('✅ Bot pronto e operacional!');
    console.log('📱 Aguardando mensagens...');
  } catch (error) {
    console.error('❌ Erro na inicialização:', error);
  }
})();

// Tratamento de erros
bot.on('polling_error', (error) => {
  console.error('❌ Erro de polling:', error.message);
});

process.on('unhandledRejection', (error) => {
  console.error('❌ Erro não tratado:', error);
});
```

---

## 2️⃣ Estrutura completa do repositório:

Seu repositório GitHub deve ter **3 arquivos**:
```
arbisportsai-bot/
├── package.json
├── bot.js
└── .gitignore