// 1. Configuração Firebase
const firebaseConfig = {
    apiKey: "AIzaSyCfV8VpqfqAVNLCmLf6_I2rOc0frg5q-Y4",
    authDomain: "painel-solar-bauru.firebaseapp.com",
    projectId: "painel-solar-bauru",
    storageBucket: "painel-solar-bauru.firebasestorage.app",
    messagingSenderId: "261230188902",
    appId: "painel-solar-bauru-web"
};

if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}
const db = firebase.firestore();

// 2. Configurações Solax & Bauru
const SOLAX_TOKEN = '202605120608478230237210';
const DEVICES = [
    { sn: 'C02711021F3193', name: 'Micro Inv. 1 (Micro-4in1)' },
    { sn: 'C02711021F312R', name: 'Micro Inv. 2 (Micro-4in1)' }
];
// Tarifa CPFL Paulista Residencial (B1) - sem API publica, atualizar apos reajuste anual de abril.
const TARIFF_DEFAULT = 0.95;  // R$ 0,95/kWh vigente desde Abr/2026 (proximo reajuste: Abr/2027)
const TARIFF_VALID_FROM = 'Abr/2026'; const TARIFF_VALID_UNTIL = 'Abr/2027';
let TARIFF = parseFloat(localStorage.getItem('tariff')) || TARIFF_DEFAULT;
const CIP = 9.07;
const MIN_KWH = 50;          // Consumo mínimo faturável pela CPFL (50 kWh/mês)
// Capacidade instalada: 8 paineis x 620W = 4.960W de pico
let MAX_POWER_W = parseInt(localStorage.getItem('maxPower')) || 4960;


let state = {
    productionToday: 0,
    wattsNow: 0,
    history: [],
    groupedHistory: {},
    invDetails: DEVICES.map(d => ({ ...d, watts: 0, yield: 0, lifetimeKwh: 0, temp: '--', status: 'Conectando...', dcPower: [] })),
    lifetimeKwh: 0   // soma do yieldtotal dos dois inversores (fonte: Solax API)
};
let energyChart = null;
let energyChartLine = null;
let _cpflInitialized = false;

// ==========================================
// TEMA (MODO ESCURO / CLARO)
// ==========================================
function toggleTheme() {
    const isDark = document.body.classList.toggle('dark-mode');
    const icon = document.getElementById('theme-icon');
    if (isDark) {
        icon.className = 'fas fa-sun';
        localStorage.setItem('theme', 'dark');
    } else {
        icon.className = 'fas fa-moon';
        localStorage.setItem('theme', 'light');
    }
}

document.addEventListener("DOMContentLoaded", () => {
    if (localStorage.getItem('theme') === 'dark') {
        document.body.classList.add('dark-mode');
        const icon = document.getElementById('theme-icon');
        if (icon) icon.className = 'fas fa-sun';
    }
});


function switchChartTab(tab) {
    document.getElementById('tab-bar-btn').classList.remove('active');
    document.getElementById('tab-line-btn').classList.remove('active');
    document.getElementById('chart-bar-container').style.display = 'none';
    document.getElementById('chart-line-container').style.display = 'none';

    if (tab === 'bar') {
        document.getElementById('tab-bar-btn').classList.add('active');
        document.getElementById('chart-bar-container').style.display = 'block';
    } else {
        document.getElementById('tab-line-btn').classList.add('active');
        document.getElementById('chart-line-container').style.display = 'block';
    }
}
let historyChart = null;

// 3. Inicialização
window.onload = () => {
    renderInverters(state.invDetails);

    document.getElementById('import').value = localStorage.getItem('lastImport') || '';
    document.getElementById('export').value = localStorage.getItem('lastExport') || '';

    // Popula campos de configurações com valores salvos
    const cfgTariff = document.getElementById('cfg-tariff');
    const cfgMax = document.getElementById('cfg-maxpower');
    if (cfgTariff) cfgTariff.value = TARIFF;
    if (cfgMax) cfgMax.value = MAX_POWER_W;

    // Atualiza dashboard ao digitar (sem salvar) para ver impacto no gráfico
    document.getElementById('import').addEventListener('input', updateDashboardUI);
    document.getElementById('export').addEventListener('input', updateDashboardUI);

    // Pré-popula data do ciclo de faturamento (salvo ou padrão 12/05/2026)
    const billDateEl = document.getElementById('cfg-bill-date');
    if (billDateEl) billDateEl.value = localStorage.getItem('billCycleDate') || '2026-05-12';

    // Sistema instalado 11/05/2026 (pós-jan/2023) → Fio B aplica → pré-marcar checkbox
    const fiobCheck = document.getElementById('cfg-fiob-enabled');
    if (fiobCheck) { fiobCheck.checked = true; toggleFioBInput(); }

    listenToCloudData();
    syncSolaxOnly();

    // Tenta renderizar os gráficos após um tempo para garantir carregamento dos canvas
    setTimeout(() => {
        renderChart();
    }, 1500);

    setInterval(syncSolaxOnly, 120000);
};

// Navegação entre Abas
function showTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));

    const target = document.getElementById(tabId);
    if (target) target.classList.add('active');

    const btnId = 'btn-' + tabId.replace('tab-', '');
    const btn = document.getElementById(btnId);
    if(btn) btn.classList.add('active');

    if(tabId === 'tab-dash') {
        setTimeout(() => {
            if(energyChart) { energyChart.resize(); energyChart.update(); }
            else { renderChart(); }
        }, 200);
    }
}

// 4. API Solax
async function syncSolaxOnly() {
    const statusBadge = document.getElementById('status-badge');
    statusBadge.innerText = "Sincronizando...";

    // Lista expandida de proxies para maior chance de sucesso
    const proxies = [
        'https://api.allorigins.win/get?url=',
        'https://corsproxy.io/?',
        'https://thingproxy.freeboard.io/fetch/',
        'https://api.codetabs.com/v1/proxy?quest='
    ];

    // Função que tenta conectar a UM inversor percorrendo os proxies
    async function fetchInverter(i) {
        const dev = DEVICES[i];
        const apiUrl = `https://www.solaxcloud.com/proxyApp/proxy/api/getRealtimeInfo.do?tokenId=${SOLAX_TOKEN}&sn=${dev.sn}&t=${Date.now()}`;

        for (const proxy of proxies) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 6000);
                const response = await fetch(`${proxy}${encodeURIComponent(apiUrl)}`, { signal: controller.signal });
                clearTimeout(timeoutId);

                if (!response.ok) continue;
                const data = await response.json();
                const res = data.contents ? JSON.parse(data.contents) : data;

                if (res && res.success) {
                    const r = res.result;
                    const watts       = Number(r.acpower      || r.acPower      || 0);
                    const yDay        = Number(r.yieldtoday   || r.yieldToday   || 0);
                    const yLifetime   = Number(r.yieldtotal   || r.yieldTotal   || 0);

                    state.invDetails[i].watts       = watts;
                    state.invDetails[i].yield       = yDay;
                    state.invDetails[i].lifetimeKwh = yLifetime;
                    state.invDetails[i].temp        = r.inverterTemp || '--';
                    state.invDetails[i].status      = getStatusText(r.inverterStatus, watts);
                    state.invDetails[i].dcPower     = [r.powerdc1, r.powerdc2, r.powerdc3, r.powerdc4]
                        .filter(v => v !== null && v !== undefined);
                    console.log(`[Solax] Inv ${i+1} OK via ${proxy} — ${watts}W / hoje:${yDay}kWh / total:${yLifetime}kWh`);
                    return { watts, yDay, yLifetime };
                }
            } catch (e) {
                console.warn(`[Solax] Inv ${i+1} falhou no proxy ${proxy}:`, e.message);
            }
        }
        // Todos os proxies falharam
        state.invDetails[i].status = 'Erro Sinc.';
        console.warn(`[Solax] Inv ${i+1} — todos os proxies falharam.`);
        return null;
    }

    // Dispara os dois inversores em PARALELO
    const results = await Promise.allSettled(DEVICES.map((_, i) => fetchInverter(i)));

    let totalYield    = 0;
    let totalWatts    = 0;
    let totalLifetime = 0;
    let successCount  = 0;

    results.forEach(r => {
        if (r.status === 'fulfilled' && r.value) {
            totalYield    += r.value.yDay;
            totalWatts    += r.value.watts;
            totalLifetime += r.value.yLifetime || 0;
            successCount++;
        }
    });

    state.productionToday = totalYield;
    state.wattsNow        = totalWatts;
    
    // Só sobrescreve se AMBOS os inversores responderam com sucesso para evitar soma parcial
    if (successCount === DEVICES.length && totalLifetime > 0) {
        // Compensação de 2.20 kWh (energia gerada na fábrica/testes que não consta no portal SolaxCloud)
        const offset = 2.20;
        state.lifetimeKwh = Math.max(0, totalLifetime - offset);
        console.log(`[Solax] Total acumulado API (Completo com Offset): ${state.lifetimeKwh} kWh`);
    } else {
        console.warn(`[Solax] Apenas ${successCount} de ${DEVICES.length} inversores responderam. Mantendo valor anterior para evitar dados parciais.`);
    }
    
    updateDashboardUI();
    renderInverters(state.invDetails);

    if (totalWatts > 0 || totalYield > 0) {
        statusBadge.innerText = totalWatts > 0 ? 'Gerando Agora' : 'Conectado';
        statusBadge.className = 'badge online';
    } else {
        statusBadge.innerText = 'Sem Dados SolaX';
        statusBadge.className = 'badge offline';
    }
}

// 5. Gravação
async function syncData() {
    const impValue = parseFloat(document.getElementById('import').value) || 0;
    const expValue = parseFloat(document.getElementById('export').value) || 0;
    const btn = document.getElementById('btn-sync');

    if (impValue === 0) { alert("Preencha a Tela 03!"); return; }

    if (state.history.length > 0) {
        const last = state.history[0];
        if (impValue < last.import || expValue < last.export) {
            alert("Erro: Leitura menor que a anterior!");
            return;
        }
        if (impValue === last.import && expValue === last.export && state.productionToday === last.production) {
            alert("Nada mudou desde a última sincronização.");
            return;
        }
    }

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Gravando...';

    // Proteção contra Lag Solax: Se a geração de hoje é IGUAL à de ontem e não há sol agora, salva como 0
    let prodToSave = state.productionToday;
    if (state.history.length > 0) {
        const last = state.history[0];
        if (prodToSave === last.production && state.wattsNow === 0 && last.date !== new Date().toLocaleDateString('pt-BR')) {
            prodToSave = 0;
        }
    }

    const reading = {
        date: new Date().toLocaleDateString('pt-BR'),
        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
        import: impValue,
        export: expValue,
        production: prodToSave,
        watts: state.wattsNow || 0
    };

    try {
        await db.collection("leituras").add(reading);
        localStorage.setItem('lastImport', impValue);
        localStorage.setItem('lastExport', expValue);
        document.getElementById('status-badge').innerText = "Gravado!";
    } catch (e) {
        alert("Erro ao salvar.");
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-cloud-upload-alt"></i> Sincronizar Agora';
    }
}

// 6. Dados e UI
function listenToCloudData() {
    db.collection("leituras").orderBy("timestamp", "desc").limit(300).onSnapshot((snapshot) => {
        let daySummaries = {};
        let grouped = {};

        snapshot.forEach(doc => {
            const item = doc.data();
            const date = item.date;

            if (!grouped[date]) grouped[date] = [];
            grouped[date].push(item);

            if (!daySummaries[date]) {
                daySummaries[date] = { ...item };
            } else {
                // Para o gráfico e histórico diário, queremos o MÁXIMO do dia
                // (Já que geração, import e export são cumulativos no dia)
                daySummaries[date].production = Math.max(daySummaries[date].production || 0, item.production || 0);
                daySummaries[date].import = Math.max(daySummaries[date].import || 0, item.import || 0);
                daySummaries[date].export = Math.max(daySummaries[date].export || 0, item.export || 0);
                // Mantemos o timestamp mais recente para ordenação
                if (item.timestamp && (!daySummaries[date].timestamp || item.timestamp.seconds > daySummaries[date].timestamp.seconds)) {
                    daySummaries[date].timestamp = item.timestamp;
                }
            }
        });
        
        // Converte o objeto de resumos em array ordenado por data (timestamp)
        state.history = Object.values(daySummaries).sort((a, b) => {
            const tA = a.timestamp ? a.timestamp.seconds : 0;
            const tB = b.timestamp ? b.timestamp.seconds : 0;
            return tB - tA;
        });

        state.groupedHistory = grouped;
        renderHistory();

        // Auto-popula campos de import/export se estiverem vazios ou na carga inicial com a última leitura do banco
        if (state.history.length > 0) {
            const latest = state.history[0];
            const impInput = document.getElementById('import');
            const expInput = document.getElementById('export');
            
            // Forçamos a carga inicial com o último valor gravado no banco
            if (!_cpflInitialized) {
                _cpflInitialized = true;
                if (impInput) impInput.value = latest.import;
                if (expInput) expInput.value = latest.export;
            } else {
                // Caso o usuário limpe ou zere o campo manualmente
                if (impInput && (!impInput.value || parseFloat(impInput.value) === 0)) {
                    impInput.value = latest.import;
                }
                if (expInput && (!expInput.value || parseFloat(expInput.value) === 0)) {
                    expInput.value = latest.export;
                }
            }
        }

        updateDashboardUI();
        calcBillEstimate(); // Atualiza previsão da fatura automaticamente
    });
}

function updateDashboardUI() {
    // Remove as animações de carregamento (skeletons)
    document.querySelectorAll('.skeleton').forEach(el => el.classList.remove('skeleton'));
    const prod = Number(state.productionToday || 0);
    document.getElementById('val-production').innerHTML = `${prod.toFixed(2)} <small>kWh</small>`;
    document.getElementById('val-watts').innerHTML = `${state.wattsNow || 0} <small>W</small>`;

    const liveImp = parseFloat(document.getElementById('import').value) || 0;
    const liveExp = parseFloat(document.getElementById('export').value) || 0;
    let consumption = 0;
    let balance = liveExp - liveImp;

    if (state.history.length > 0) {
        const latest = state.history[0];
        const todayStr = new Date().toLocaleDateString('pt-BR');
        // Popula os deltas do card CPFL com os últimos valores gravados
        onCpflInput('import');
        onCpflInput('export');

        let realProdToday = prod;
        if (latest.date !== todayStr && prod === latest.production && state.wattsNow === 0) realProdToday = 0;

        if (latest.date === todayStr && state.history.length >= 2) {
            const prev = state.history[1];
            consumption = realProdToday + (latest.import - prev.import) - (latest.export - prev.export);
        } else {
            const dImp = Math.max(0, liveImp - latest.import);
            const dExp = Math.max(0, liveExp - latest.export);
            consumption = realProdToday + dImp - dExp;
        }
    }

    document.getElementById('val-consumption').innerHTML = `${Math.max(consumption, 0).toFixed(2)} <small>kWh</small>`;
    const gridEl = document.getElementById('val-grid');
    gridEl.innerHTML = `${balance >= 0 ? '+' : ''}${balance.toFixed(1)} <small>kWh</small>`;
    gridEl.className = `value ${balance >= 0 ? 'pos' : 'neg'}`;

    const savings = prod * TARIFF;
    const savingsEl = document.getElementById('val-savings');
    if(savingsEl) savingsEl.textContent = `R$ ${savings.toFixed(2).replace('.', ',')}`;

    // Item 5: Economia acumulada do mês corrente + média diária
    const now = new Date();
    const todayStr2 = now.toLocaleDateString('pt-BR');
    const monthKey = `/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
    const monthName = now.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' });
    let monthlySavings = 0;
    let monthlyProduction = 0;
    let daysWithData = 0;
    let todayInHistory = false;

    state.history.forEach(h => {
        if (!h.date || !h.date.endsWith(monthKey)) return;
        if (h.date === '10/05/2026') return; // Ignora o dia 10/05 (dia anterior à entrada oficial em operação em 11/05)
        
        let dayProd = Number(h.production) || 0;
        if (h.date === todayStr2) {
            todayInHistory = true;
            dayProd = Math.max(dayProd, prod);
        }
        monthlyProduction += dayProd;
        monthlySavings += dayProd * TARIFF;
        daysWithData++;
    });
    if (!todayInHistory) {
        monthlyProduction += prod;
        monthlySavings += prod * TARIFF;
        daysWithData++;
    }

    const savingsMonthEl = document.getElementById('val-savings-month');
    if (savingsMonthEl) savingsMonthEl.textContent = `R$ ${monthlySavings.toFixed(2).replace('.', ',')}`;

    // Média diária de geração do mês
    const avgDay = daysWithData > 0 ? monthlyProduction / daysWithData : 0;
    const avgDayEl  = document.getElementById('val-avg-day');
    const avgDaysEl = document.getElementById('val-avg-days');
    const avgLabelEl = document.getElementById('val-avg-month-label');
    if (avgDayEl)   avgDayEl.innerHTML = `${avgDay.toFixed(2)} <small>kWh/dia</small>`;
    if (avgDaysEl)  avgDaysEl.textContent = `baseado em ${daysWithData} dia${daysWithData !== 1 ? 's' : ''}`;
    if (avgLabelEl) avgLabelEl.textContent = monthName;

    // Item 10: Atualiza o gauge de potência
    updatePowerGauge();

    document.getElementById('update-time').innerText = "Atualizado: " + new Date().toLocaleTimeString();
    renderChart();
}

// ─── Smart CPFL Card — validação e delta em tempo real ───────────────────────
let _cpflUpdating = false; // guard para evitar recursão com updateDashboardUI
function onCpflInput(field) {
    if (_cpflUpdating) return;
    
    const inputEl  = document.getElementById(field === 'import' ? 'import' : 'export');
    const blockEl  = document.getElementById(`cpfl-block-${field === 'import' ? 'import' : 'export'}`);
    const deltaEl  = document.getElementById(`cpfl-delta-${field === 'import' ? 'import' : 'export'}`);
    const msgEl    = document.getElementById('cpfl-validation-msg');
    const dotEl    = document.getElementById('cpfl-status-dot');
    if (!inputEl || !blockEl || !deltaEl) return;

    try {
        _cpflUpdating = true;
        const val  = parseFloat(inputEl.value);
        const last = state.history.length > 0 ? state.history[0] : null;
        const lastVal = last ? Number(last[field === 'import' ? 'import' : 'export']) : null;

        // ── Atualiza o indicador estático do último valor gravado ───────────────
        const lastEl = document.getElementById(`cpfl-last-${field === 'import' ? 'import' : 'export'}`);
        if (lastEl && lastVal !== null) {
            lastEl.textContent = `Último: ${lastVal}`;
        }

        // ── Delta ────────────────────────────────────────────────────────────────
        if (!isNaN(val) && lastVal !== null) {
            const diff = val - lastVal;
            const absDiff = Math.abs(diff).toFixed(2);
            if (diff > 0) {
                deltaEl.textContent = `▲ +${absDiff} kWh desde ${last.date}`;
                deltaEl.className = 'cpfl-delta up';
                deltaEl.style.display = 'block';
            } else if (diff < 0) {
                deltaEl.textContent = `▼ ${diff.toFixed(2)} kWh ⚠ menor que anterior`;
                deltaEl.className = 'cpfl-delta down';
                deltaEl.style.display = 'block';
            } else {
                deltaEl.style.display = 'none'; // Esconde completamente se for igual
            }
        } else {
            deltaEl.style.display = 'none'; // Esconde completamente se vazio
        }

        // ── Validação do bloco ────────────────────────────────────────────────────
        const impVal = parseFloat(document.getElementById('import').value);
        const expVal = parseFloat(document.getElementById('export').value);
        const lastImp = last ? Number(last.import) : null;
        const lastExp = last ? Number(last.export) : null;

        let hasError = false, errorMsg = '';

        if (!isNaN(impVal) && lastImp !== null && impVal < lastImp) {
            hasError = true;
            errorMsg = `⚠ Import (${impVal}) menor que o último registro (${lastImp})`;
        }
        if (!isNaN(expVal) && lastExp !== null && expVal < lastExp) {
            hasError = true;
            errorMsg = errorMsg || `⚠ Export (${expVal}) menor que o último registro (${lastExp})`;
        }

        // Aplica estado visual ao bloco atual
        if (isNaN(val) || val === 0) {
            blockEl.className = 'cpfl-meter-block';
        } else if ((field === 'import' && !isNaN(impVal) && lastImp !== null && impVal < lastImp) ||
                   (field === 'export' && !isNaN(expVal) && lastExp !== null && expVal < lastExp)) {
            blockEl.className = 'cpfl-meter-block invalid';
        } else {
            blockEl.className = 'cpfl-meter-block ready';
        }

        // Mensagem global e controle do botão de sincronização
        const syncBtn = document.getElementById('btn-sync');
        if (hasError) {
            msgEl.className = 'cpfl-validation-msg error';
            msgEl.innerHTML = `<i class="fas fa-exclamation-circle"></i> ${errorMsg}`;
            msgEl.style.display = 'flex';
            if (dotEl) { dotEl.className = 'cpfl-status-dot invalid'; }
            if (syncBtn) {
                syncBtn.disabled = true;
                syncBtn.style.opacity = '0.5';
                syncBtn.style.pointerEvents = 'none';
            }
        } else if (!isNaN(impVal) && !isNaN(expVal) && impVal === lastImp && expVal === lastExp) {
            // Se os valores forem perfeitamente idênticos aos anteriores, ocultamos qualquer mensagem de erro/aviso
            // mas mantemos o botão Sincronizar desativado por segurança
            msgEl.style.display = 'none';
            if (dotEl) { dotEl.className = 'cpfl-status-dot'; }
            if (syncBtn) {
                syncBtn.disabled = true;
                syncBtn.style.opacity = '0.5';
                syncBtn.style.pointerEvents = 'none';
            }
        } else if (!isNaN(impVal) && !isNaN(expVal) && (impVal > lastImp || expVal > lastExp)) {
            msgEl.className = 'cpfl-validation-msg ok';
            msgEl.innerHTML = `<i class="fas fa-check-circle"></i> Leitura válida — pronto para sincronizar`;
            msgEl.style.display = 'flex';
            if (dotEl) { dotEl.className = 'cpfl-status-dot valid'; }
            if (syncBtn) {
                syncBtn.disabled = false;
                syncBtn.style.opacity = '1';
                syncBtn.style.pointerEvents = 'auto';
            }
        } else {
            msgEl.style.display = 'none';
            if (dotEl) { dotEl.className = 'cpfl-status-dot'; }
            if (syncBtn) {
                syncBtn.disabled = true;
                syncBtn.style.opacity = '0.5';
                syncBtn.style.pointerEvents = 'none';
            }
        }

        // Atualiza UI principal com os valores atuais dos campos
        updateDashboardUI();
    } finally {
        _cpflUpdating = false;
    }
}

function adjustCpflValue(field, increment) {
    const inputEl = document.getElementById(field);
    if (!inputEl) return;
    
    let currentVal = parseFloat(inputEl.value);
    if (isNaN(currentVal) || currentVal === 0) {
        const last = state.history.length > 0 ? state.history[0] : null;
        currentVal = last ? Number(last[field]) : 0;
    }
    
    inputEl.value = (currentVal + increment).toFixed(2);
    onCpflInput(field);
}

function resetCpflValue(field) {
    const inputEl = document.getElementById(field);
    if (!inputEl) return;
    
    const last = state.history.length > 0 ? state.history[0] : null;
    if (last) {
        inputEl.value = last[field];
        onCpflInput(field);
    }
}


function renderChart() {
    const canvas = document.getElementById('energyChart');
    if (!canvas) return;

    let labels = [];
    let autoValues = [];     
    let exportValues = [];   
    let compraValues = [];
    let geracaoTotalValues = [];
    let consumoTotalValues = [];
    const todayStr = new Date().toLocaleDateString('pt-BR');

    if (state.history.length > 0) {
        // Item 6: Removido filtro hardcoded do dia 10 que afetava todo mês
        let last7 = [...state.history].slice(0, 7).reverse();
        
        const lastRecord = state.history[0];
        labels = last7.map(h => h.date.split('/')[0]);
        
        last7.forEach(h => {
            const idx = state.history.findIndex(item => item.date === h.date);
            const prev = state.history[idx + 1];
            let dI = 0, dE = 0;
            if (prev) {
                dI = Math.max(0, Number(h.import) - Number(prev.import));
                dE = Math.max(0, Number(h.export) - Number(prev.export));
            }
            let prod = Number(h.production || 0);
            
            if (h.date === todayStr) {
                prod = Math.max(prod, state.productionToday);
            }
            
            const auto = Math.max(0, prod - dE);
            autoValues.push(auto);
            exportValues.push(dE);
            compraValues.push(dI);
            geracaoTotalValues.push(prod);
            consumoTotalValues.push(auto + dI);
        });

        if (lastRecord.date !== todayStr) {
            labels.push('Hoje');
            const liveImp = parseFloat(document.getElementById('import').value) || lastRecord.import;
            const liveExp = parseFloat(document.getElementById('export').value) || lastRecord.export;
            const dI = Math.max(0, liveImp - lastRecord.import);
            const dE = Math.max(0, liveExp - lastRecord.export);
            let realProd = state.productionToday;
            if (realProd === lastRecord.production && state.wattsNow === 0) realProd = 0;
            const auto = Math.max(0, realProd - dE);
            autoValues.push(auto);
            exportValues.push(dE);
            compraValues.push(dI);
            geracaoTotalValues.push(realProd);
            consumoTotalValues.push(auto + dI);
        }
    }

    // ── Totais dos últimos 7 dias (gráfico) ─────────────────────────────────
    const sumArr = arr => arr.reduce((a, b) => a + b, 0);

    // ── Totais desde a instalação (histórico completo) ───────────────────────
    // A geração acumulada é a soma do campo `production` de cada dia no histórico.
    // Importação/exportação vitalícia = diferença entre primeiro e último registro.
    let lifetimeGer = 0;
    let lifetimeUso = 0;
    let lifetimeExp = 0;
    let lifetimeImp = 0;

    if (state.history.length > 0) {
        // Ordena histórico do mais antigo para o mais recente
        const sortedAll = [...state.history].sort((a, b) => {
            const tA = a.timestamp ? a.timestamp.seconds : 0;
            const tB = b.timestamp ? b.timestamp.seconds : 0;
            return tA - tB;
        });

        const oldest = sortedAll[0];
        const newest = sortedAll[sortedAll.length - 1];

        // Geração acumulada = soma da produção de cada dia (campo salvo no Firestore)
        state.history.forEach(h => {
            lifetimeGer += Number(h.production || 0);
        });
        // Inclui produção de hoje se ainda não foi gravada
        const todayStr = new Date().toLocaleDateString('pt-BR');
        const todayInHist = state.history.some(h => h.date === todayStr);
        if (!todayInHist && state.productionToday > 0) lifetimeGer += state.productionToday;

        // Exportação e importação vitalícias = delta entre primeiro e último registro acumulado
        lifetimeExp = Math.max(0, Number(newest.export)  - Number(oldest.export));
        lifetimeImp = Math.max(0, Number(newest.import)  - Number(oldest.import));
        lifetimeUso = Math.max(0, lifetimeGer - lifetimeExp);
    }

    // ── FONTE PRIMÁRIA: yieldtotal diretamente da API Solax ─────────────────
    // state.lifetimeKwh é a soma de yieldtotal dos dois inversores — mesmo valor
    // exibido no SolaxCloud. Usa o fallback de soma diária apenas se a API ainda
    // não retornou dados (ex: antes da primeira sincronização).
    if (state.lifetimeKwh > 0) {
        lifetimeGer = state.lifetimeKwh;
        lifetimeUso = Math.max(0, lifetimeGer - lifetimeExp);
    }

    const formatTotal = (v) => v >= 1000 ? (v/1000).toFixed(2) + ' <small>MWh</small>' : v.toFixed(1) + ' <small>kWh</small>';

    const gerEl = document.getElementById('val-total-ger');
    const usoEl = document.getElementById('val-total-uso');
    const expEl = document.getElementById('val-total-exp');
    const impEl = document.getElementById('val-total-imp');

    if (gerEl) gerEl.innerHTML = formatTotal(lifetimeGer);
    if (usoEl) usoEl.innerHTML = formatTotal(lifetimeUso);
    if (expEl) expEl.innerHTML = formatTotal(lifetimeExp);
    if (impEl) impEl.innerHTML = formatTotal(lifetimeImp);

    if (energyChart) energyChart.destroy();
    if (energyChartLine) energyChartLine.destroy();
    
    const ctx = canvas.getContext('2d');
    const canvasLine = document.getElementById('energyChartLine');
    const ctxLine = canvasLine ? canvasLine.getContext('2d') : null;
    
    const chartDataLabels = {
        id: 'chartDataLabels',
        afterDatasetsDraw(chart) {
            const { ctx } = chart;
            chart.data.labels.forEach((label, index) => {
                const auto = autoValues[index] || 0;
                const dE = exportValues[index] || 0;
                const dI = compraValues[index] || 0;
                const prod = auto + dE;
                
                const metaGen = chart.getDatasetMeta(1).data[index];
                const metaCompra = chart.getDatasetMeta(2).data[index];

                if (prod > 0 && metaGen) {
                    ctx.fillStyle = '#d35400';
                    ctx.font = 'bold 9px Arial';
                    ctx.textAlign = 'center';
                    ctx.fillText(prod.toFixed(1), metaGen.x, metaGen.y - 5);
                }
                if (dI > 0 && metaCompra) {
                    ctx.fillStyle = '#1a5276';
                    ctx.font = 'bold 10px Arial';
                    ctx.textAlign = 'center';
                    ctx.fillText(dI.toFixed(1), metaCompra.x, metaCompra.y - 5);
                }
            });
        }
    };

    energyChart = new Chart(ctx, {
        type: 'bar',
        data: { 
            labels: labels, 
            datasets: [
                { label: 'Uso do Sol', data: autoValues, backgroundColor: '#27ae60', stack: 'Geração' },
                { label: 'Exportado', data: exportValues, backgroundColor: '#f1c40f', stack: 'Geração', borderRadius: { topLeft: 4, topRight: 4 } },
                { label: 'Compra CPFL', data: compraValues, backgroundColor: '#3498db', stack: 'Compra', borderRadius: { topLeft: 4, topRight: 4 } }
            ] 
        },
        plugins: [chartDataLabels],
        options: { 
            responsive: true, maintainAspectRatio: false, animation: false,
            plugins: { legend: { display: true, position: 'top', labels: { boxWidth: 10, font: { size: 10 } } } }, 
            scales: { y: { stacked: true, beginAtZero: true }, x: { stacked: true, ticks: { font: { size: 9 } } } } 
        }
    });

    if (ctxLine) {
        energyChartLine = new Chart(ctxLine, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Geração Total',
                        data: geracaoTotalValues,
                        borderColor: '#e67e22',
                        backgroundColor: 'rgba(230, 126, 34, 0.1)',
                        borderWidth: 2,
                        tension: 0.4,
                        fill: true,
                        pointRadius: 4,
                        pointBackgroundColor: '#fff'
                    },
                    {
                        label: 'Uso do Sol',
                        data: autoValues,
                        borderColor: '#27ae60',
                        backgroundColor: 'rgba(39, 174, 96, 0.1)',
                        borderWidth: 2,
                        tension: 0.4,
                        fill: true,
                        pointRadius: 4,
                        pointBackgroundColor: '#fff'
                    },
                    {
                        label: 'Exportado',
                        data: exportValues,
                        borderColor: '#f1c40f',
                        backgroundColor: 'rgba(241, 196, 15, 0.1)',
                        borderWidth: 2,
                        tension: 0.4,
                        fill: true,
                        pointRadius: 4,
                        pointBackgroundColor: '#fff'
                    },
                    {
                        label: 'Consumo Total',
                        data: consumoTotalValues,
                        borderColor: '#2980b9',
                        backgroundColor: 'rgba(41, 128, 185, 0.1)',
                        borderWidth: 2,
                        tension: 0.4,
                        fill: true,
                        pointRadius: 4,
                        pointBackgroundColor: '#fff'
                    }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false, animation: false,
                plugins: { legend: { display: true, position: 'top', labels: { boxWidth: 10, font: { size: 10 } } } },
                scales: { y: { beginAtZero: true }, x: { ticks: { font: { size: 9 } } } }
            }
        });
    }
}

function renderHistory() {
    const tbody = document.getElementById('history-body');
    if (!tbody) return;
    
    let html = '';
    state.history.forEach((h, index) => {
        const saldo = h.export - h.import;
        const time = h.timestamp ? h.timestamp.toDate().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '--:--';
        const dayReadings = state.groupedHistory[h.date] || [];

        html += `
            <tr onclick="toggleDayDetails('${h.date}')" style="cursor: pointer; font-weight: bold">
                <td>${h.date} <i class="fas fa-chevron-down" style="font-size: 0.6rem"></i></td>
                <td>${time}</td>
                <td>${h.import}</td>
                <td>${h.export}</td>
                <td class="${saldo >= 0 ? 'pos' : 'neg'}">${saldo >= 0 ? '+' : ''}${saldo.toFixed(1)}</td>
            </tr>
            <tr id="details-${h.date.replace(/\//g, '-')}" class="hidden-row">
                <td colspan="5" style="padding: 0">
                    <div class="details-container">
                        <table class="inner-table">
                            <thead>
                                <tr><th>Hora</th><th>Imp</th><th>Exp</th><th>Saldo</th></tr>
                            </thead>
                            <tbody>
                                ${dayReadings.map(r => {
                                    const s = r.export - r.import;
                                    const t = r.timestamp ? r.timestamp.toDate().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '--:--';
                                    return `<tr><td>${t}</td><td>${r.import}</td><td>${r.export}</td><td class="${s >= 0 ? 'pos' : 'neg'}">${s >= 0 ? '+' : ''}${s.toFixed(1)}</td></tr>`;
                                }).join('')}
                            </tbody>
                        </table>
                    </div>
                </td>
            </tr>
        `;
    });
    tbody.innerHTML = html;
}

function toggleDayDetails(date) {
    const id = `details-${date.replace(/\//g, '-')}`;
    const el = document.getElementById(id);
    if (el) {
        el.classList.toggle('visible-row');
    }
}



function getStatusText(code, watts = 0) {
    const statusMap = {
        100: "Aguardando",
        101: "Autoteste",
        102: "Normal",
        103: "Falha Recup.",
        104: "Falha Perm.",
        105: "Atualizando",
        106: "Detecção EPS",
        107: "Off-grid",
        108: "Autoteste (IT)",
        109: "Modo Sleep",
        110: "Standby",
        111: "PV Wake-up",
        112: "Detecção Gerador",
        113: "Modo Gerador",
        114: "Shutdown Rápido",
        130: "Modo VPP",
        131: "TOU-Self Use",
        132: "TOU-Carga",
        "100": "Aguardando", "101": "Auto Teste", "102": "Normal",
        "103": "Falha Recup.", "104": "Falha Perm.", "105": "Atualizando",
        "106": "EPS Detect", "107": "Off-grid", "108": "Self-Test",
        "109": "Dormindo", "110": "Standby", "111": "Wake-up", "112": "Gen Detect",
        "113": "Modo Gerador", "114": "Shutdown Rápido", "130": "Modo VPP",
        "131": "TOU-Self Use", "132": "TOU-Carga", "133": "TOU-Descarga",
        "141": "Normal (R-1)", "150": "Self Use", "151": "Force Time Use",
        "152": "Back Up", "153": "Feedin Priority", "160": "OpenAdr"
    };
    
    if (statusMap[code]) return statusMap[code];
    
    const numCode = Number(code);
    
    // Se está gerando energia, independentemente do código, está operando
    if (watts > 0) return "Gerando";
    
    const smallMap = { 0: "Aguardando", 1: "Normal", 2: "Falha", 3: "Verificando" };
    if (smallMap[numCode]) return smallMap[numCode];
    
    return "Aguardando"; // Em vez de assumir offline, assumimos aguardando se watts == 0
}

function renderInverters(list) {
    const container = document.getElementById('inverter-details');
    if (!container) return;
    container.innerHTML = list.map(inv => {
        const dcStrings = inv.dcPower && inv.dcPower.length > 0 
            ? `<br><small>Strings: ${inv.dcPower.map(p => p + 'W').join(' | ')}</small>`
            : '';
        return `
            <div class="inverter-item">
                <div>
                    <span class="inv-name">${inv.name}</span><br>
                    <small>${inv.status}</small>
                    ${dcStrings}
                </div>
                <div class="inv-stats">
                    ${inv.watts}W <br>
                    <small>${inv.yield.toFixed(2)} kWh</small>
                </div>
            </div>`;
    }).join('');
}

// Item 10: Gauge visual de potência instantânea
function updatePowerGauge() {
    const watts = state.wattsNow || 0;
    const pct = Math.min(100, Math.round((watts / MAX_POWER_W) * 100));

    const fill = document.getElementById('gauge-fill');
    const pctEl = document.getElementById('gauge-percent');
    const maxEl = document.getElementById('gauge-max');
    const footerLeft = document.querySelector('.power-gauge-footer span:first-child');

    if (fill) {
        fill.style.width = pct + '%';
        if (pct >= 70)      fill.style.background = 'linear-gradient(90deg, #27ae60, #2ecc71)';
        else if (pct >= 40) fill.style.background = 'linear-gradient(90deg, #f39c12, #f1c40f)';
        else if (pct > 0)   fill.style.background = 'linear-gradient(90deg, #e67e22, #e74c3c)';
        else                fill.style.background = '#ccc';
    }
    if (pctEl) pctEl.textContent = pct + '%';
    if (maxEl) maxEl.textContent = `${MAX_POWER_W.toLocaleString('pt-BR')} W máx.`;
    if (footerLeft) footerLeft.textContent = `${watts.toLocaleString('pt-BR')} W`;
}

// Item 4: Painel de configurações colapsável
function toggleSettings() {
    const body = document.getElementById('settings-body');
    const icon = document.getElementById('settings-icon');
    if (body) body.classList.toggle('open');
    if (icon) {
        icon.className = body && body.classList.contains('open')
            ? 'fas fa-chevron-up'
            : 'fas fa-chevron-down';
    }
}

// Item 4: Salvar tarifa e potência máxima
function saveSettings() {
    const tariffVal = parseFloat(document.getElementById('cfg-tariff').value);
    const maxPowerVal = parseInt(document.getElementById('cfg-maxpower').value);

    if (tariffVal && tariffVal > 0) {
        TARIFF = tariffVal;
        localStorage.setItem('tariff', tariffVal);
    }
    if (maxPowerVal && maxPowerVal > 0) {
        MAX_POWER_W = maxPowerVal;
        localStorage.setItem('maxPower', maxPowerVal);
    }

    toggleSettings();
    updateDashboardUI();

    const badge = document.getElementById('status-badge');
    if (badge) { badge.innerText = 'Configurações salvas!'; badge.className = 'badge online'; }
    setTimeout(() => { if (badge) badge.className = 'badge'; }, 2500);
}

// ==========================================
// PREVISÃO DA FATURA CPFL — automático
// Sistema instalado 11/05/2026 → Fio B 60% aplicável (Regra de Transição 2026)
// ==========================================
const BILL_CYCLE_START = '2026-05-12';
const FIOB_RATE = 0.102; // 60% do Fio B da CPFL Paulista (Fio B integral ~ R$ 0,17/kWh)

function toggleBillDetails() {
    const details  = document.getElementById('bill-details');
    const chevron  = document.getElementById('bill-chevron');
    if (!details) return;
    const isOpen = details.style.maxHeight !== '0px' && details.style.maxHeight !== '';
    details.style.maxHeight = isOpen ? '0px' : '800px';
    if (chevron) chevron.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(180deg)';
}


function calcBillEstimate() {
    if (!state.history || state.history.length === 0) {
        console.log('[Fatura] Histórico vazio, aguardando dados...');
        return;
    }

    // Converte qualquer formato de data para ms para comparação
    const dateToMs = d => {
        if (!d) return 0;
        // Suporta dd/mm/yyyy e yyyy-mm-dd
        if (d.includes('/')) {
            const [dd, mm, yy] = d.split('/');
            return new Date(`${yy}-${mm}-${dd}T00:00:00`).getTime();
        }
        return new Date(d + 'T00:00:00').getTime();
    };

    const cycleStart    = new Date(BILL_CYCLE_START + 'T00:00:00');
    const cycleStartMs  = cycleStart.getTime();
    const cycleEnd      = new Date(cycleStart); cycleEnd.setDate(cycleEnd.getDate() + 30);
    const today         = new Date();
    const daysElapsed   = Math.max(1, Math.round((today - cycleStart) / 86400000));
    const daysTotal     = 30;

    console.log('[Fatura] Histórico disponível:', state.history.length, 'registros');
    console.log('[Fatura] Datas:', state.history.map(h => h.date).join(', '));
    console.log('[Fatura] Ciclo início:', BILL_CYCLE_START, '| Dias decorridos:', daysElapsed);

    // Ordena do mais antigo ao mais recente
    const sorted = [...state.history].sort((a, b) => dateToMs(a.date) - dateToMs(b.date));

    // Registro do início do ciclo: o mais próximo antes ou igual à data de leitura
    const startRecord = sorted.reduce((best, h) => {
        const ms = dateToMs(h.date);
        if (ms <= cycleStartMs) {
            if (!best || ms > dateToMs(best.date)) return h;
        }
        return best;
    }, null);

    // Registro mais recente = último da lista ordenada
    const latestRecord = sorted[sorted.length - 1];

    console.log('[Fatura] Registro início:', startRecord ? `${startRecord.date} Imp=${startRecord.import} Exp=${startRecord.export}` : 'NÃO ENCONTRADO');
    console.log('[Fatura] Registro recente:', latestRecord ? `${latestRecord.date} Imp=${latestRecord.import} Exp=${latestRecord.export}` : 'NÃO ENCONTRADO');

    if (!startRecord || !latestRecord || startRecord.date === latestRecord.date) {
        console.log('[Fatura] Dados insuficientes para calcular.');
        return;
    }

    // Deltas de import/export (valores acumulados — subtrai leitura inicial da atual)
    const dImp    = Math.max(0, Number(latestRecord.import)  - Number(startRecord.import));
    const dExp    = Math.max(0, Number(latestRecord.export)  - Number(startRecord.export));
    const netReal = Math.max(0, dImp - dExp);

    console.log('[Fatura] Δ Import:', dImp, '| Δ Export:', dExp, '| Líquido:', netReal);

    // Projeção para 30 dias (média diária × 30)
    const impProj = (dImp    / daysElapsed) * daysTotal;
    const netProj = (netReal / daysElapsed) * daysTotal;

    // COMPOSIÇÃO DA FATURA
    const billableKwh = Math.max(netProj, MIN_KWH); // mínimo 50 kWh
    const energyCost  = billableKwh * TARIFF;
    const fiobCost    = impProj * FIOB_RATE;         // Fio B sobre total importado
    const totalBill   = energyCost + fiobCost + CIP;

    const fmt     = n => n.toFixed(2).replace('.', ',');
    const fmtDate = d => d.toLocaleDateString('pt-BR');

    // Cabeçalho
    const monthLabel = cycleStart.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    const mEl = document.getElementById('bill-month-label');
    const pEl = document.getElementById('bill-period-label');
    if (mEl) mEl.textContent = monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1);
    if (pEl) pEl.textContent = `${fmtDate(cycleStart)} → ${fmtDate(cycleEnd)} · ${daysElapsed}/${daysTotal} dias decorridos`;

    // Total em destaque
    const totalEl = document.getElementById('bill-total');
    if (totalEl) { totalEl.textContent = `R$ ${fmt(totalBill)}`; totalEl.classList.remove('skeleton'); }

    // CÁLCULO DA ESTIMATIVA SEM SOLAR (quanto gastaria se não tivesse energia solar)
    let cycleProd = 0;
    sorted.forEach(h => {
        const ms = dateToMs(h.date);
        if (ms > cycleStartMs && ms <= dateToMs(latestRecord.date)) {
            if (h.date === '10/05/2026') return; // ignora baseline
            cycleProd += Number(h.production) || 0;
        }
    });
    // Se o último registro não for hoje, soma também o hoje em tempo real (state.productionToday)
    const todayStr3 = new Date().toLocaleDateString('pt-BR');
    if (latestRecord.date !== todayStr3) {
        cycleProd += Number(state.productionToday || 0);
    }

    const consCycleNoSolar = Math.max(0, cycleProd - dExp) + dImp;
    const consProjNoSolar  = (consCycleNoSolar / daysElapsed) * daysTotal;
    const billProjNoSolar  = Math.max(consProjNoSolar, MIN_KWH) * TARIFF + CIP;

    const noSolarEl = document.getElementById('val-nosolar-month');
    if (noSolarEl) {
        noSolarEl.textContent = `R$ ${fmt(billProjNoSolar)}`;
        noSolarEl.classList.remove('skeleton');
    }

    // Composição linha a linha
    const lineEl = document.getElementById('bill-line-items');
    if (lineEl) {
        let html = `
        <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px dashed var(--bg);">
            <span>⚡ Energia (${fmt(billableKwh)} kWh × R$${fmt(TARIFF)})</span>
            <span style="font-weight:bold;">R$ ${fmt(energyCost)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px dashed var(--bg);">
            <span>🔌 Fio B (${fmt(impProj)} kWh imp. × R$${fmt(FIOB_RATE)})</span>
            <span style="font-weight:bold;color:#9b59b6;">R$ ${fmt(fiobCost)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;padding:6px 0;margin-bottom:4px;">
            <span>💡 CIP (Iluminação Pública)</span>
            <span style="font-weight:bold;">R$ ${fmt(CIP)}</span>
        </div>`;
        if (netProj < MIN_KWH) {
            html += `<div style="color:#e67e22;font-size:0.68rem;padding:4px 0;"><i class="fas fa-info-circle"></i> Mínimo de ${MIN_KWH} kWh aplicado — consumo líquido projetado abaixo do mínimo tarifário.</div>`;
        }
        lineEl.innerHTML = html;
    }

    const bdEl = document.getElementById('bill-breakdown');
    if (bdEl) bdEl.innerHTML = `<i class="fas fa-plug" style="color:#9b59b6;"></i> Fio B incluído · Lei 14.300/2022 · 60% em 2026 · sistema pós-jan/2023`;

    // Detalhes
    const elImp  = document.getElementById('bill-import-delta');
    const elExp  = document.getElementById('bill-export-delta');
    const elNet  = document.getElementById('bill-net-real');
    const elProj = document.getElementById('bill-net-proj');
    if (elImp)  elImp.textContent  = `${dImp.toFixed(1)} kWh`;
    if (elExp)  elExp.textContent  = `${dExp.toFixed(1)} kWh`;
    if (elNet)  elNet.textContent  = `${netReal.toFixed(1)} kWh`;
    if (elProj) elProj.textContent = `${netProj.toFixed(1)} kWh`;

    console.log('[Fatura] Total estimado: R$', fmt(totalBill));
}

async function fetchWeather() {
    try {
        const res = await fetch('https://api.open-meteo.com/v1/forecast?latitude=-22.3145&longitude=-49.0605&daily=weathercode,temperature_2m_max,temperature_2m_min&timezone=America%2FSao_Paulo');
        const data = await res.json();
        
        const weatherCodes = {
            0: { icon: "fa-sun", color: "#f1c40f" },
            1: { icon: "fa-sun", color: "#f1c40f" },
            2: { icon: "fa-cloud-sun", color: "#95a5a6" },
            3: { icon: "fa-cloud", color: "#7f8c8d" },
            45: { icon: "fa-smog", color: "#95a5a6" },
            48: { icon: "fa-smog", color: "#95a5a6" },
            51: { icon: "fa-cloud-rain", color: "#3498db" },
            53: { icon: "fa-cloud-rain", color: "#3498db" },
            55: { icon: "fa-cloud-rain", color: "#3498db" },
            61: { icon: "fa-cloud-showers-heavy", color: "#2980b9" },
            63: { icon: "fa-cloud-showers-heavy", color: "#2980b9" },
            65: { icon: "fa-cloud-showers-heavy", color: "#2980b9" },
            71: { icon: "fa-snowflake", color: "#ecf0f1" },
            80: { icon: "fa-cloud-showers-heavy", color: "#2980b9" },
            81: { icon: "fa-cloud-showers-heavy", color: "#2980b9" },
            82: { icon: "fa-cloud-showers-heavy", color: "#2980b9" },
            95: { icon: "fa-bolt", color: "#e74c3c" },
            96: { icon: "fa-bolt", color: "#e74c3c" },
            99: { icon: "fa-bolt", color: "#e74c3c" }
        };

        const container = document.getElementById('weather-forecast');
        if (!container) return;
        
        let html = '';
        for(let i=0; i<5; i++) {
            const dateStr = data.daily.time[i];
            const dateObj = new Date(dateStr + "T00:00:00");
            const dayName = dateObj.toLocaleDateString('pt-BR', { weekday: 'short' });
            const maxT = Math.round(data.daily.temperature_2m_max[i]);
            const minT = Math.round(data.daily.temperature_2m_min[i]);
            const code = data.daily.weathercode[i];
            const weather = weatherCodes[code] || { icon: "fa-cloud", color: "#95a5a6" };
            
            html += `
                <div style="flex: 1; min-width: 45px; text-align: center; background: var(--bg); padding: 5px 0; border-radius: 6px; line-height: 1.1;">
                    <div style="font-size: 0.6rem; font-weight: bold; text-transform: uppercase;">${dayName}</div>
                    <i class="fas ${weather.icon}" style="font-size: 1.1rem; color: ${weather.color}; margin: 2px 0;"></i>
                    <div style="font-size: 0.7rem; font-weight: bold;">${maxT}°</div>
                    <div style="font-size: 0.55rem; color: var(--text-light);">${minT}°</div>
                </div>
            `;
        }
        container.innerHTML = html;
        container.style.display = 'flex';
    } catch(e) {
        console.warn("Erro ao buscar previsao do tempo:", e);
    }
}
setTimeout(fetchWeather, 500);

// Item 7: Registro do Service Worker (ativação da PWA offline)
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(reg => console.log('[SW] Registrado com sucesso:', reg.scope))
            .catch(err => console.error('[SW] Erro ao registrar:', err));
    });
}
