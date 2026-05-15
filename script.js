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



let state = {
    productionToday: 0,
    wattsNow: 0,
    history: [],
    groupedHistory: {},
    invDetails: DEVICES.map(d => ({ ...d, watts: 0, yield: 0, temp: '--', status: 'Conectando...', dcPower: [] }))
};
let energyChart = null;
let energyChartLine = null;

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

    // Atualiza dashboard ao digitar (sem salvar) para ver impacto no gráfico
    document.getElementById('import').addEventListener('input', updateDashboardUI);
    document.getElementById('export').addEventListener('input', updateDashboardUI);

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
    let totalYield = 0;
    let totalWatts = 0;
    const statusBadge = document.getElementById('status-badge');
    
    // Lista expandida de proxies para maior chance de sucesso
    const proxies = [
        'https://api.allorigins.win/get?url=',
        'https://corsproxy.io/?',
        'https://thingproxy.freeboard.io/fetch/',
        'https://api.codetabs.com/v1/proxy?quest='
    ];

    statusBadge.innerText = "Sincronizando...";

    for (let i = 0; i < DEVICES.length; i++) {
        const dev = DEVICES[i];
        const apiUrl = `https://www.solaxcloud.com/proxyApp/proxy/api/getRealtimeInfo.do?tokenId=${SOLAX_TOKEN}&sn=${dev.sn}&t=${Date.now()}`;

        let success = false;
        for (const proxy of proxies) {
            try {
                // Timeout curto de 5 segundos para cada tentativa de proxy
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 5000);

                const response = await fetch(`${proxy}${encodeURIComponent(apiUrl)}`, { signal: controller.signal });
                clearTimeout(timeoutId);

                if (!response.ok) continue;
                const data = await response.json();
                let res = data.contents ? JSON.parse(data.contents) : data;

                if (res && res.success) {
                    const r = res.result;
                    const watts = Number(r.acpower || r.acPower || 0);
                    const yDay = Number(r.yieldtoday || r.yieldToday || 0);

                    state.invDetails[i].watts = watts;
                    state.invDetails[i].yield = yDay;
                    state.invDetails[i].temp = r.inverterTemp || '--';
                    state.invDetails[i].status = getStatusText(r.inverterStatus, watts);
                    state.invDetails[i].dcPower = [r.powerdc1, r.powerdc2, r.powerdc3, r.powerdc4].filter(v => v !== null && v !== undefined);

                    totalYield += yDay;
                    totalWatts += watts;
                    success = true;
                    break;
                }
            } catch (e) {
                console.warn(`Falha no proxy ${proxy}:`, e.message);
            }
        }
        if (!success) state.invDetails[i].status = "Erro Sinc.";
    }

    state.productionToday = totalYield;
    state.wattsNow = totalWatts;
    updateDashboardUI();
    renderInverters(state.invDetails);
    
    if (totalWatts > 0 || totalYield > 0) {
        statusBadge.innerText = totalWatts > 0 ? "Gerando Agora" : "Conectado";
        statusBadge.className = "badge online";
    } else {
        statusBadge.innerText = "Sem Dados SolaX";
        statusBadge.className = "badge offline";
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
        updateDashboardUI();
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
        let last7 = [...state.history].slice(0, 7).reverse();
        
        // Remove explicitamente o dia 10 do gráfico conforme solicitado
        last7 = last7.filter(h => !h.date.startsWith('10/'));
        
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

    // Calcula Totais aproveitando exatamente os dados que vão para o gráfico (Geração vs Consumo)
    const sumArr = arr => arr.reduce((a, b) => a + b, 0);
    const sumUso = sumArr(autoValues);
    const sumExp = sumArr(exportValues);
    const sumImp = sumArr(compraValues);
    
    const formatTotal = (v) => v > 1000 ? (v/1000).toFixed(2) + ' <small>MWh</small>' : v.toFixed(0) + ' <small>kWh</small>';
    
    const usoEl = document.getElementById('val-total-uso');
    const expEl = document.getElementById('val-total-exp');
    const impEl = document.getElementById('val-total-imp');
    
    if (usoEl) usoEl.innerHTML = formatTotal(sumUso);
    if (expEl) expEl.innerHTML = formatTotal(sumExp);
    if (impEl) impEl.innerHTML = formatTotal(sumImp);

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
