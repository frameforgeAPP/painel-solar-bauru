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
const TARIFF = 0.90;
const CIP = 9.07;
const MIN_KWH = 50;

// Dados Históricos Pré-Solar (Versão para copiar)
const PRE_SOLAR_DATA = [
    { mes: 'Mai/25', consumo: 452, custo: 406.80 },
    { mes: 'Jun/25', consumo: 399, custo: 359.10 },
    { mes: 'Jul/25', consumo: 338, custo: 304.20 },
    { mes: 'Ago/25', consumo: 291, custo: 261.90 },
    { mes: 'Set/25', consumo: 362, custo: 325.80 },
    { mes: 'Out/25', consumo: 500, custo: 450.00 },
    { mes: 'Nov/25', consumo: 431, custo: 387.90 },
    { mes: 'Dez/25', consumo: 604, custo: 543.60 },
    { mes: 'Jan/26', consumo: 714, custo: 642.60 },
    { mes: 'Fev/26', consumo: 591, custo: 531.90 },
    { mes: 'Mar/26', consumo: 690, custo: 621.00 },
    { mes: 'Abr/26', consumo: 596, custo: 536.40 }
];

let state = {
    productionToday: 0,
    wattsNow: 0,
    history: [],
    invDetails: DEVICES.map(d => ({ ...d, watts: 0, yield: 0, temp: '--', status: 'Conectando...' }))
};
let energyChart = null;
let historyChart = null;

// 3. Inicialização
window.onload = () => {
    renderInverters(state.invDetails);
    renderPreSolar();

    document.getElementById('import').value = localStorage.getItem('lastImport') || '';
    document.getElementById('export').value = localStorage.getItem('lastExport') || '';

    // Atualiza dashboard ao digitar (sem salvar) para ver impacto no gráfico
    document.getElementById('import').addEventListener('input', updateDashboardUI);
    document.getElementById('export').addEventListener('input', updateDashboardUI);

    listenToCloudData();
    syncSolaxOnly();

    // Tenta renderizar os gráficos após um tempo para garantir carregamento dos canvas
    setTimeout(() => {
        renderChart();
        renderPreSolar();
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
    if(tabId === 'tab-history') {
        setTimeout(() => {
            if(historyChart) { historyChart.resize(); historyChart.update(); }
            else { renderPreSolar(); }
        }, 200);
    }
}

// 4. API Solax
async function syncSolaxOnly() {
    let totalYield = 0;
    let totalWatts = 0;
    const statusBadge = document.getElementById('status-badge');
    const proxies = ['https://api.allorigins.win/get?url=', 'https://api.codetabs.com/v1/proxy?quest=', 'https://corsproxy.io/?'];

    statusBadge.innerText = "Sincronizando...";

    for (let i = 0; i < DEVICES.length; i++) {
        const dev = DEVICES[i];
        const apiUrl = `https://www.solaxcloud.com/proxyApp/proxy/api/getRealtimeInfo.do?tokenId=${SOLAX_TOKEN}&sn=${dev.sn}&t=${Date.now()}`;

        let success = false;
        for (const proxy of proxies) {
            try {
                const response = await fetch(`${proxy}${encodeURIComponent(apiUrl)}`);
                if (!response.ok) continue;
                const data = await response.json();
                let res = data.contents ? JSON.parse(data.contents) : data;

                if (res && res.success) {
                    const r = res.result;
                    const watts = Number(r.acpower || r.acPower || r.power || 0);
                    const yDay = Number(r.yieldtoday || r.yieldToday || 0);

                    state.invDetails[i].watts = watts;
                    state.invDetails[i].yield = yDay;
                    state.invDetails[i].temp = r.inverterTemp || '--';
                    state.invDetails[i].status = getStatusText(r.inverterStatus);

                    totalYield += yDay;
                    totalWatts += watts;
                    success = true;
                    break;
                }
            } catch (e) {}
        }
        if (!success) state.invDetails[i].status = "Offline";
    }

    state.productionToday = totalYield;
    state.wattsNow = totalWatts;
    updateDashboardUI();
    renderInverters(state.invDetails);
    statusBadge.innerText = totalWatts > 0 ? "Gerando Agora" : "Conectado";
    statusBadge.className = "badge online";
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
    db.collection("leituras").orderBy("timestamp", "desc").limit(50).onSnapshot((snapshot) => {
        let rawData = [];
        snapshot.forEach(doc => rawData.push(doc.data()));
        let filtered = [];
        let seenDates = new Set();
        rawData.forEach((item) => {
            if (!seenDates.has(item.date)) {
                filtered.push(item);
                seenDates.add(item.date);
            }
        });
        state.history = filtered;
        renderHistory();
        updateDashboardUI();
        calculateForecast();
    });
}

function updateDashboardUI() {
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
        document.getElementById('hint-import').innerText = `Último: ${latest.import}`;
        document.getElementById('hint-export').innerText = `Último: ${latest.export}`;

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
    if(savingsEl) savingsEl.innerText = `Economia Hoje: R$ ${savings.toFixed(2).replace('.', ',')}`;

    document.getElementById('update-time').innerText = "Atualizado: " + new Date().toLocaleTimeString();
    renderChart();
}

function calculateForecast() {
    const mNetEl = document.getElementById('month-net');
    if (state.history.length < 2) return;
    const now = new Date();
    const currentMonth = state.history.filter(h => h.timestamp && h.timestamp.toDate().getMonth() === now.getMonth());
    if (currentMonth.length < 2) return;

    const latest = currentMonth[0];
    const first = currentMonth[currentMonth.length - 1];
    const net = (latest.import - first.import) - (latest.export - first.export);

    document.getElementById('month-import').innerText = (latest.import - first.import).toFixed(1);
    document.getElementById('month-export').innerText = (latest.export - first.export).toFixed(1);
    mNetEl.innerText = `${net.toFixed(1)} kWh`;
    mNetEl.className = net <= 0 ? 'bold pos' : 'bold neg';

    const day = now.getDate();
    const totalDays = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const projected = (net / day) * totalDays;
    const bill = (Math.max(projected, MIN_KWH) * TARIFF) + CIP;
    document.getElementById('month-bill').innerText = `R$ ${bill.toFixed(2).replace('.', ',')}`;
}

function renderChart() {
    const canvas = document.getElementById('energyChart');
    if (!canvas) return;

    let labels = [];
    let prodValues = [];
    let consValues = [];
    const todayStr = new Date().toLocaleDateString('pt-BR');

    if (state.history.length > 0) {
        const last7 = [...state.history].slice(0, 7).reverse();
        const lastRecord = state.history[0];

        labels = last7.map(h => h.date.split('/')[0]);
        prodValues = last7.map(h => Number(h.production || 0));
        consValues = last7.map(h => {
            const idx = state.history.findIndex(item => item.date === h.date);
            const prev = state.history[idx + 1];
            if (!prev) return 0;
            const dI = Number(h.import) - Number(prev.import);
            const dE = Number(h.export) - Number(prev.export);
            return Math.max(0, Number(h.production || 0) + dI - dE);
        });

        if (lastRecord.date !== todayStr) {
            const liveImp = parseFloat(document.getElementById('import').value) || lastRecord.import;
            const liveExp = parseFloat(document.getElementById('export').value) || lastRecord.export;
            const dI = Math.max(0, liveImp - lastRecord.import);
            const dE = Math.max(0, liveExp - lastRecord.export);

            let realProd = state.productionToday;
            if (realProd === lastRecord.production && state.wattsNow === 0) realProd = 0;

            if (realProd > 0.01 || dI > 0 || dE > 0) {
                labels.push('Hoje');
                prodValues.push(realProd);
                consValues.push(Math.max(0, realProd + dI - dE));
            }
        }
    }

    if (energyChart) energyChart.destroy();
    const ctx = canvas.getContext('2d');
    energyChart = new Chart(ctx, {
        type: 'bar',
        data: { labels: labels, datasets: [{ label: 'Geração', data: prodValues, backgroundColor: '#f1c40f', borderRadius: 4 }, { label: 'Consumo', data: consValues, backgroundColor: '#3498db', borderRadius: 4 }] },
        options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: true, position: 'top', labels: { boxWidth: 10, font: { size: 10 } } } }, scales: { y: { beginAtZero: true }, x: { ticks: { font: { size: 9 } } } } }
    });
}

function renderHistory() {
    const tbody = document.getElementById('history-body');
    if (!tbody) return;
    tbody.innerHTML = state.history.map(h => {
        const saldo = h.export - h.import;
        return `<tr><td>${h.date}</td><td>${h.import}</td><td>${h.export}</td><td class="${saldo >= 0 ? 'pos' : 'neg'}">${saldo >= 0 ? '+' : ''}${saldo.toFixed(1)}</td></tr>`;
    }).join('');
}

function renderPreSolar() {
    const tbody = document.getElementById('history-invoices-body');
    if (!tbody) return;
    tbody.innerHTML = PRE_SOLAR_DATA.map(d => `<tr><td colspan="4" style="text-align: left; padding: 10px 15px; font-family: monospace; font-weight: bold; border-bottom: 1px solid #eee; background: #fff; font-size: 0.9rem; white-space: pre;">${d.mes} - ${d.consumo} kWh - R$ ${d.custo.toFixed(2).replace('.',',')}</td></tr>`).join('');

    const canvas = document.getElementById('historyInvoicesChart');
    if (!canvas) return;
    if (historyChart) historyChart.destroy();
    historyChart = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: { labels: PRE_SOLAR_DATA.map(d => d.mes), datasets: [{ label: 'Consumo (kWh)', data: PRE_SOLAR_DATA.map(d => d.consumo), borderColor: '#e74c3c', fill: true, backgroundColor: 'rgba(231, 76, 60, 0.1)', tension: 0.3 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: true, position: 'top' } } }
    });
}

function renderInverters(list) {
    const container = document.getElementById('inverter-details');
    if (!container) return;
    container.innerHTML = list.map(inv => `<div class="inverter-item"><div><span class="inv-name">${inv.name}</span><br><small>${inv.status} | ${inv.temp}°C</small></div><div class="inv-stats">${inv.watts}W <br><small>${inv.yield.toFixed(2)} kWh</small></div></div>`).join('');
}

function getStatusText(code) {
    return { 0: "Offline", 1: "Normal", 2: "Falha", 3: "Verificando" }[code] || "Offline";
}
